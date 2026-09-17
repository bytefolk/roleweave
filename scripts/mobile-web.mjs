import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultExampleDir,
  loadWorkspaceSnapshot,
  resolvePublicAsset,
} from "../apps/mobile-web/surface.mjs";

const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const host = process.env.PORT ? "0.0.0.0" : "127.0.0.1";
const productDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(productDir, "apps", "mobile-web");
const exampleDir = defaultExampleDir(productDir);
const types = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
]);

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    json(response, 200, { ok: true, app: "RoleWeave" });
    return;
  }
  if (url.pathname === "/api/mobile/workspace" && request.method === "GET") {
    try {
      json(response, 200, loadWorkspaceSnapshot(exampleDir));
    } catch {
      json(response, 503, { code: "unavailable", message: "mobile workspace preview is not available" });
    }
    return;
  }
  const asset = resolvePublicAsset(url.pathname, {
    webDir,
    userAgent: request.headers["user-agent"] ?? "",
    searchParams: url.searchParams,
  });
  if (!asset) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }
  try {
    const details = await stat(asset);
    if (!details.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "content-type": types.get(path.extname(asset)) ?? "application/octet-stream",
      "content-length": details.size,
      "cache-control": "no-store",
    });
    createReadStream(asset).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, host, () => {
    process.stdout.write(`RoleWeave mobile web listening on ${host}:${port}\n`);
  });
}

export { server };
