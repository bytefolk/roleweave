import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { createPhoneLinkRelay } from "../packages/phone-link/src/index.mjs";
import {
  defaultExampleDir,
  loadWorkspaceSnapshot,
  previewOrgSnapshot,
  resolvePublicAsset,
} from "./mobile-surface.mjs";

const port = Number.parseInt(process.argv[2] ?? "", 10);
const vncPort = Number.parseInt(process.argv[3] ?? "", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535 ||
    !Number.isInteger(vncPort) || vncPort < 1 || vncPort > 65535) {
  process.stderr.write("usage: node web-server.mjs <port> <vnc-port>\n");
  process.exit(64);
}

const deployDir = path.dirname(fileURLToPath(import.meta.url));
const productDir = path.resolve(deployDir, "..");
const exampleDir = defaultExampleDir(productDir);
const noVncDir = path.join(deployDir, "node_modules", "@novnc", "novnc");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
]);

function resolvedAsset(urlPath, request) {
  const url = new URL(request.url ?? "/", "http://localhost");
  return resolvePublicAsset(urlPath, {
    deployDir,
    noVncDir,
    userAgent: request.headers["user-agent"] ?? "",
    searchParams: url.searchParams,
  });
}

const hostToken = process.env.ROLEWEAVE_PHONE_LINK_HOST_TOKEN ?? "";
const phoneLink = /^[a-f0-9]{64}$/.test(hostToken) ? createPhoneLinkRelay({ hostToken }) : null;

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 16 * 1024) throw new Error("too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseSocketJson(raw) {
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  return JSON.parse(text);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end('{"ok":true,"app":"RoleWeave"}\n');
    return;
  }
  if (url.pathname === "/phone-link/v1/protocol" && request.method === "GET") {
    json(response, 200, phoneLink ? phoneLink.protocol() : { schema: "phone-link.v1", enabled: false });
    return;
  }
  if (url.pathname === "/phone-link/v1/status" && request.method === "GET") {
    json(response, 200, phoneLink ? phoneLink.status() : { schema: "phone-link.v1", hostOnline: false, deviceCount: 0 });
    return;
  }
  if (url.pathname === "/phone-link/v1/claim" && request.method === "POST") {
    if (!phoneLink) {
      json(response, 503, { code: "unavailable", message: "phone-link host token is not configured" });
      return;
    }
    const result = phoneLink.claim();
    json(response, result.ok ? 200 : result.code === "host_offline" ? 503 : 400, result.ok
      ? { deviceId: result.deviceId, deviceToken: result.deviceToken }
      : { code: result.code, message: result.message });
    return;
  }
  if (url.pathname === "/phone-link/v1/revoke" && request.method === "POST") {
    if (!phoneLink) {
      json(response, 503, { code: "unavailable", message: "phone-link host token is not configured" });
      return;
    }
    try {
      const body = await readJson(request);
      const result = phoneLink.revokeByToken(body.deviceToken);
      json(response, result.ok ? 200 : result.code === "unauthorized" ? 401 : 400, result.ok
        ? { revoked: true, deviceId: result.deviceId }
        : { code: result.code, message: result.message });
    } catch {
      json(response, 400, { code: "bad_request", message: "revoke body must be JSON" });
    }
    return;
  }
  if (url.pathname === "/phone-link/v1/pair" && request.method === "POST") {
    if (!phoneLink) {
      json(response, 503, { code: "unavailable", message: "phone-link host token is not configured" });
      return;
    }
    try {
      const body = await readJson(request);
      const result = phoneLink.pair(body.code);
      json(response, result.ok ? 200 : 400, result.ok ? { deviceId: result.deviceId, deviceToken: result.deviceToken } : { code: result.code, message: result.message });
    } catch {
      json(response, 400, { code: "bad_request", message: "pairing body must be JSON" });
    }
    return;
  }
  if (url.pathname === "/api/mobile/workspace" && request.method === "GET") {
    const live = phoneLink?.orgSnapshot();
    if (live) {
      json(response, 200, live);
      return;
    }
    try {
      json(response, 200, previewOrgSnapshot(loadWorkspaceSnapshot(exampleDir)));
    } catch {
      json(response, 503, { code: "unavailable", message: "mobile workspace preview is not available" });
    }
    return;
  }
  const asset = resolvedAsset(url.pathname, request);
  if (asset === null) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }
  try {
    const details = await stat(asset);
    if (!details.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "content-type": contentTypes.get(path.extname(asset)) ?? "application/octet-stream",
      "content-length": details.size,
      "cache-control": url.pathname.startsWith("/novnc/") ? "public, max-age=86400" : "no-store",
      "content-security-policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    createReadStream(asset).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  }
});

const websocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const origin = request.headers.origin;
  let sameOrigin = true;
  try {
    sameOrigin = !origin || new URL(origin).host === request.headers.host;
  } catch {
    sameOrigin = false;
  }
  if (url.pathname === "/phone-link/host" || url.pathname === "/phone-link/phone") {
    if (!phoneLink || !sameOrigin) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("phone-link", websocket, url.pathname);
    });
    return;
  }
  if (url.pathname !== "/websockify" || !sameOrigin) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (websocket) => {
    websocketServer.emit("connection", websocket);
  });
});

websocketServer.on("phone-link", (websocket, pathname) => {
  if (!phoneLink) {
    websocket.close(1011, "phone-link disabled");
    return;
  }
  if (pathname === "/phone-link/host") {
    websocket.on("message", (data) => {
      try {
        phoneLink.handleHostMessage(websocket, parseSocketJson(data));
      } catch {
        websocket.send(JSON.stringify({ v: 1, type: "error", code: "bad_request", message: "invalid JSON" }));
      }
    });
    websocket.on("close", () => phoneLink.disconnectHost(websocket));
    return;
  }
  let deviceToken = null;
  websocket.on("message", (data) => {
    try {
      const message = parseSocketJson(data);
      if (message.type === "phone.hello") {
        deviceToken = typeof message.deviceToken === "string" ? message.deviceToken : "";
        phoneLink.connectPhone(websocket, deviceToken);
        return;
      }
      if (deviceToken) phoneLink.handlePhoneMessage(websocket, deviceToken, message);
    } catch {
      websocket.send(JSON.stringify({ v: 1, type: "error", code: "bad_request", message: "invalid JSON" }));
    }
  });
  websocket.on("close", () => phoneLink.disconnectPhone(websocket));
});

websocketServer.on("connection", (websocket) => {
  const upstream = net.createConnection({ host: "127.0.0.1", port: vncPort });
  upstream.on("data", (chunk) => {
    if (websocket.readyState === WebSocket.OPEN) websocket.send(chunk, { binary: true });
  });
  upstream.on("error", () => websocket.close(1011, "VNC server unavailable"));
  upstream.on("close", () => websocket.close());
  websocket.on("message", (data) => upstream.write(data));
  websocket.on("close", () => upstream.destroy());
  websocket.on("error", () => upstream.destroy());
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`RoleWeave web desktop listening on 0.0.0.0:${port}\n`);
});
