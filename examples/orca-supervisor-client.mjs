#!/usr/bin/env node
/**
 * Orca supervisor reference client (issue #637).
 *
 * Zero-dependency Node (>=22) script demonstrating how an external fleet
 * dashboard (e.g. an Orca desktop plugin) consumes the RoleWeave control
 * plane over the frozen v0 contract — using the additive supervisor surface
 * (#635) rather than an operator boot token:
 *
 *   1. Pull the GET /supervisor/snapshot at startup (workspace + org tree +
 *      per-position state in one read-only projection).
 *   2. Stream GET /events (SSE) with Last-Event-ID resume on reconnect.
 *      The server projects this stream for supervisor credentials: payloads
 *      are metadata-only by the time they leave the control plane.
 *   3. Print one-line metadata per turn event — NEVER task text.
 *   4. Exit cleanly on SIGINT.
 *
 * Credential discipline (docs/api-contract-v0.md §4):
 *   - This client consumes a READ-ONLY supervisor pairing token, never the
 *     operator boot token. The operator (or the Electron host on their
 *     behalf) creates the pairing via POST /supervisor/pair and hands the
 *     supervisor token to this process through a trusted channel: an
 *     inherited stdin pipe or the ROLEWEAVE_SUPERVISOR_TOKEN environment
 *     variable — NEVER through argv, where any local process listing could
 *     read it.
 *   - The token lives in this process's memory only; it is never written to
 *     disk or logs. Revoking the pairing server-side closes the stream.
 *
 * Usage:
 *   # terminal 1 — pair (boot token from the ready line):
 *   curl -s -X POST -H "Authorization: Bearer $BOOT_TOKEN" \
 *        -H "content-type: application/json" \
 *        -d '{"label":"orca-supervisor"}' http://127.0.0.1:$PORT/supervisor/pair
 *
 *   # terminal 2 — run (token via stdin pipe):
 *   printf '%s' "$SUPERVISOR_TOKEN" | node examples/orca-supervisor-client.mjs --port <N>
 *   # or via environment (trusted launcher):
 *   ROLEWEAVE_SUPERVISOR_TOKEN=$SUPERVISOR_TOKEN node examples/orca-supervisor-client.mjs --port <N>
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
      "Usage: printf '%s' \"$SUPERVISOR_TOKEN\" | node examples/orca-supervisor-client.mjs --port <N> [--once]\n" +
      "       (or set ROLEWEAVE_SUPERVISOR_TOKEN; --token is deliberately not supported)\n",
    );
    process.exit(0);
  }
  if (key === "--token") {
    process.stderr.write(
      "refusing --token: supervisor credentials must never travel through argv " +
      "(any local process can read the command line). Pipe the token via stdin " +
      "or set ROLEWEAVE_SUPERVISOR_TOKEN instead.\n",
    );
    process.exit(2);
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
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  process.stderr.write("invalid or missing --port\n");
  process.exit(2);
}

const IDLE_TIMEOUT_MS = 45_000;

/** Reads the supervisor token from stdin (inherited pipe) or environment. */
async function readToken() {
  if (args.token !== undefined) {
    // Defensive: unreachable via the parser above, kept as documentation.
    process.stderr.write("refusing --token: pass the supervisor token via stdin or environment\n");
    process.exit(2);
  }
  const fromEnv = process.env.ROLEWEAVE_SUPERVISOR_TOKEN;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv.trim();
  }
  if (process.stdin.isTTY) {
    process.stderr.write(
      "no supervisor token: pipe one via stdin (printf '%s' \"$TOKEN\" | node ...) " +
      "or set ROLEWEAVE_SUPERVISOR_TOKEN. Create a pairing with POST /supervisor/pair " +
      "(boot token, operator only).\n",
    );
    process.exit(2);
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const token = Buffer.concat(chunks).toString("utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(token)) {
    process.stderr.write("stdin did not contain a valid supervisor token (expect 64 hex chars from POST /supervisor/pair)\n");
    process.exit(2);
  }
  return token;
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
async function getJson(token, path) {
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

/** Print the org tree of a supervisor snapshot as an indented roster. */
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

async function snapshotPass(token) {
  // One read-only projection replaces the operator-only /workspace + /org/tree
  // pair; a supervisor token on those endpoints answers 401 by design.
  const snapshot = await getJson(token, "/supervisor/snapshot");
  if (!snapshot.workspace?.open) {
    log(COLORS.yellow, "workspace: not open — open a workspace in RoleWeave, then restart the client.");
    return;
  }
  const seq = typeof snapshot.workspace.version === "object" ? snapshot.workspace.version?.seq : snapshot.workspace.version;
  log(COLORS.cyan, `workspace: ${snapshot.workspace.business} (owner ${snapshot.workspace.owner}, seq ${seq})`);
  if (snapshot.orgTree) {
    log(COLORS.cyan, `org tree: ${snapshot.orgTree.positionCount} position(s), depth ${snapshot.orgTree.depth}`);
    printOrgTree(snapshot.orgTree);
  }
  const busy = (snapshot.positions ?? []).filter((position) => position.runningTurn).length;
  log(COLORS.cyan, `positions: ${snapshot.positions.length} total, ${busy} running turn(s)`);
}

/**
 * Minimal SSE consumer for GET /events.
 * - Resumes with Last-Event-ID after any drop (ring-buffer replay ≥256 events).
 * - Treats 45s without bytes as a dead stream (server pings every 15s); the
 *   idle timer drives an AbortController wired into the fetch itself, so the
 *   abort actually terminates the read and triggers a reconnect.
 * - The server projects this stream for supervisor credentials (metadata-only
 *   payloads); this client additionally never prints task text.
 */
function connectEvents(token) {
  let lastSeq = null;
  let attempts = 0;

  const connect = () => {
    attempts += 1;
    // Create the controller BEFORE fetch and pass its signal in — an
    // AbortController that is not wired into the request cannot cancel
    // anything (review finding #638: the 45s idle reconnect never fired).
    const controller = new AbortController();
    let idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
    const rearmIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
    };

    const headers = { authorization: `Bearer ${token}`, accept: "text/event-stream" };
    if (lastSeq !== null) headers["last-event-id"] = String(lastSeq);

    fetch(`${baseUrl}/events`, { headers, signal: controller.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          throw new Error(`SSE ${res.status}`);
        }
        attempts = 0;
        log(COLORS.dim, "event stream connected");
        await readStream(res.body, rearmIdle);
      })
      .catch((err) => {
        if (err?.name === "AbortError") {
          log(COLORS.yellow, `event stream idle for ${IDLE_TIMEOUT_MS / 1000}s — reconnecting`);
        } else {
          log(COLORS.red, `event stream error: ${err.message}`);
        }
      })
      .finally(() => {
        clearTimeout(idleTimer);
        scheduleReconnect();
      });
  };

  const readStream = async (body, rearmIdle) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body) {
      rearmIdle();
      buffer += decoder.decode(chunk, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleFrame(frame);
      }
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
  const token = await readToken();
  try {
    await snapshotPass(token);
  } catch (err) {
    if (err.code === "unauthorized") {
      process.stderr.write("supervisor token rejected — pairings are memory-only and die with the control plane; re-pair and retry.\n");
      process.exit(1);
    }
    if (err.code !== "workspace_not_open") throw err;
    log(COLORS.yellow, "workspace not open yet — continuing to listen for events.");
  }
  if (args.once === undefined) {
    connectEvents(token);
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
