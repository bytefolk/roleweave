#!/usr/bin/env node
/**
 * Orca supervisor reference client (issue #637).
 *
 * Zero-dependency Node (>=22) script demonstrating how an external fleet
 * dashboard (e.g. an Orca desktop plugin) consumes the RoleWeave control
 * plane over the frozen v0 contract:
 *
 *   1. Pull /workspace + /org/tree snapshots at startup.
 *   2. Stream GET /events (SSE) with Last-Event-ID resume on reconnect.
 *   3. Print one-line metadata per turn event — NEVER task text.
 *   4. Exit cleanly on SIGINT.
 *
 * Security posture (docs/api-contract-v0.md §4):
 *   - The boot token lives in this process's memory only; it is never written
 *     to disk, logs, or the network beyond the loopback control plane.
 *   - This client is strictly read-only; it holds no write-capable surface.
 *
 * Usage:
 *   node examples/orca-supervisor-client.mjs --port <N> --token <hex>
 *   node examples/orca-supervisor-client.mjs --port <N> --token <hex> --once
 *
 *   --once  take one snapshot pass and exit (no SSE); useful for CI probes.
 */

"use strict";

const args = {};
const argv = process.argv.slice(2);
const BOOLEAN_FLAGS = new Set(["once"]);
for (let i = 0; i < argv.length; i++) {
  const key = argv[i];
  if (key === "--help" || key === "-h") {
    process.stdout.write(
      "Usage: node examples/orca-supervisor-client.mjs --port <N> --token <hex> [--once]\n",
    );
    process.exit(0);
  }
  if (key.startsWith("--")) {
    const name = key.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      args[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      process.stderr.write(`missing value for ${key}\n`);
      process.exit(2);
    }
    args[name] = value;
    i++;
  }
}

const port = Number.parseInt(args.port ?? "", 10);
const token = args.token ?? "";
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  process.stderr.write("invalid or missing --port\n");
  process.exit(2);
}
if (!/^[0-9a-f]{64}$/.test(token)) {
  process.stderr.write("invalid or missing --token (expect 64 hex chars from the ready line)\n");
  process.exit(2);
}

const baseUrl = `http://127.0.0.1:${port}`;
const COLORS = process.stdout.isTTY
  ? { dim: "\x1b[2m", reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", magenta: "\x1b[35m" }
  : { dim: "", reset: "", green: "", red: "", yellow: "", cyan: "", magenta: "" };

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

function log(color, ...parts) {
  process.stdout.write(`${COLORS.dim}[${timestamp()}]${COLORS.reset} ${color}${parts.join(" ")}${COLORS.reset}\n`);
}

/** Authenticated GET against the loopback control plane. */
async function getJson(path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const version = res.headers.get("x-orgworkbench-api");
  if (version !== "v0") {
    throw new Error(`unexpected API version header: ${String(version)}`);
  }
  const body = await res.json();
  if (!res.ok) {
    // Stable error body: { code, message, retryable } (contract §1).
    const err = new Error(`${path} -> ${res.status} ${body.code}: ${body.message}`);
    err.code = body.code;
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Print the org tree as an indented roster. */
function printOrgTree(tree) {
  const walk = (nodes, depth) => {
    for (const node of nodes ?? []) {
      const budget = node.budget?.perTask?.tokens;
      log(COLORS.cyan, `${"  ".repeat(depth)}├─ ${node.id}${budget ? `  (perTask ${budget} tokens)` : ""}`);
      walk(node.children, depth + 1);
    }
  };
  walk(tree.tree, 0);
}

async function snapshotPass() {
  const workspace = await getJson("/workspace");
  if (!workspace.open) {
    log(COLORS.yellow, "workspace: not open — open a workspace in RoleWeave, then restart the client.");
    return;
  }
  log(COLORS.cyan, `workspace: ${workspace.business} (owner ${workspace.owner}, seq ${workspace.version.seq})`);
  const orgTree = await getJson("/org/tree");
  log(COLORS.cyan, `org tree: ${orgTree.positionCount} position(s), depth ${orgTree.depth}`);
  printOrgTree(orgTree);
}

/**
 * Minimal SSE consumer for GET /events.
 * - Resumes with Last-Event-ID after any drop (ring-buffer replay ≥256 events).
 * - Treats 45s without bytes as a dead stream (server pings every 15s).
 */
function connectEvents() {
  let lastSeq = null;
  let attempts = 0;

  const connect = () => {
    attempts += 1;
    const headers = { authorization: `Bearer ${token}`, accept: "text/event-stream" };
    if (lastSeq !== null) headers["last-event-id"] = String(lastSeq);

    const req = fetch(`${baseUrl}/events`, { headers })
      .then((res) => {
        if (!res.ok || !res.body) {
          throw new Error(`SSE ${res.status}`);
        }
        attempts = 0;
        log(COLORS.dim, "event stream connected");
        readStream(res.body);
      })
      .catch((err) => {
        log(COLORS.red, `event stream error: ${err.message}`);
        scheduleReconnect();
      });
    return req;
  };

  const readStream = async (body) => {
    const decoder = new TextDecoder();
    let buffer = "";
    let idleTimer = setTimeout(() => reqController.abort(), 45_000);
    const reqController = new AbortController();

    try {
      for await (const chunk of body) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => reqController.abort(), 45_000);
        buffer += decoder.decode(chunk, { stream: true });

        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          handleFrame(frame);
        }
      }
    } catch {
      // aborted or dropped — fall through to reconnect
    } finally {
      clearTimeout(idleTimer);
      scheduleReconnect();
    }
  };

  const handleFrame = (frame) => {
    let event = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) return; // heartbeat comment
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
      if (line.startsWith("id:")) lastSeq = Number.parseInt(line.slice(3).trim(), 10);
    }
    if (!data) return;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    renderEvent(event, payload);
  };

  /** One-line metadata only: seq/type/at + id/status fields. Never task text. */
  const renderEvent = (type, payload) => {
    const meta = [`seq ${payload.seq ?? "?"}`, `at ${payload.at ?? "?"}`];
    const inner = payload.payload ?? {};
    if (typeof inner.positionId === "string") meta.push(`position ${inner.positionId}`);
    if (typeof inner.status === "string") meta.push(`status ${inner.status}`);
    if (typeof inner.turnId === "string") meta.push(`turn ${inner.turnId.slice(0, 8)}`);
    if (typeof inner.phase === "string") meta.push(`phase ${inner.phase}`);
    const color =
      type === "turn.completed" ? COLORS.green
      : type === "turn.failed" || type === "turn.indeterminate" ? COLORS.red
      : type === "turn.approval.requested" || type.startsWith("escalation") ? COLORS.yellow
      : type.startsWith("group") ? COLORS.magenta
      : COLORS.dim;
    log(color, `${type}  ${COLORS.dim}(${meta.join(", ")})${COLORS.reset}`);
  };

  const scheduleReconnect = () => {
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));
    log(COLORS.dim, `reconnecting in ${delay / 1000}s${lastSeq !== null ? ` (Last-Event-ID ${lastSeq})` : ""}`);
    setTimeout(connect, delay);
  };

  connect();
}

async function main() {
  try {
    await snapshotPass();
  } catch (err) {
    if (err.code === "unauthorized") {
      process.stderr.write("token rejected — the control plane restarts regenerate the boot token; re-pair and retry.\n");
      process.exit(1);
    }
    if (err.code !== "workspace_not_open") throw err;
    log(COLORS.yellow, "workspace not open yet — continuing to listen for events.");
  }
  if (args.once === undefined) {
    connectEvents();
  }
}

let exiting = false;
process.on("SIGINT", () => {
  if (exiting) return;
  exiting = true;
  log(COLORS.dim, "shutting down; token discarded from memory.");
  process.exit(0);
});

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
