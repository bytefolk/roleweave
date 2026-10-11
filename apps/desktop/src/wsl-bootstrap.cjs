// Linux-side supervisor. Configuration arrives once over stdin, which stays
// open as a lease owned by the Windows shell. No credentials enter argv/files.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { REQUEST_PREFIX, RESPONSE_PREFIX, MAX_FRAME_BYTES, validId, createPrivateBridge } = require("./workbuddy-bridge.cjs");

const MAX_CONFIG_BYTES = 128 * 1024;
const BRIDGED_ENV_KEYS = Object.freeze([
  "ORG_WORKBENCH_SERVER_PORT", "ORG_WORKBENCH_BOOT_TOKEN",
  "ORG_WORKBENCH_BUDGET_POOL_TOKENS", "ORG_WORKBENCH_DOC_URL",
  "ORG_WORKBENCH_DOC_TOKEN", "ORG_WORKBENCH_DOC_MOCK", "ORG_WORKBENCH_DOC_WEB_URL",
  "ORG_WORKBENCH_MEM_URL", "ORG_WORKBENCH_MEM_TOKEN", "ORG_WORKBENCH_MEM_WEB_URL",
  "ORG_WORKBENCH_MEM_WORKSPACE_ID", "MEM_URL", "MEM_TOKEN", "MEM_WORKSPACE",
  "ORG_WORKBENCH_QODER_PERMISSION_MODE", "QODER_PERSONAL_ACCESS_TOKEN",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
  "GEMINI_API_KEY", "GEMINI_MODEL", "GOOGLE_GEMINI_BASE_URL",
  "ROLEWEAVE_WORKBUDDY_BRIDGE_ENABLED",
  "ROLEWEAVE_LAYA_ENABLED", "ROLEWEAVE_LAYA_URL", "ROLEWEAVE_LAYA_MODEL", "ROLEWEAVE_LAYA_TIMEOUT_MS",
]);

function parseConfiguration(raw) {
  if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) throw new Error("WSL launch configuration is too large");
  const value = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "engineCommand,environment,serverEntry,version" || value.version !== 1 ||
      typeof value.serverEntry !== "string" || !path.posix.isAbsolute(value.serverEntry) || /[\x00-\x1f]/.test(value.serverEntry) ||
      (value.engineCommand !== null && (typeof value.engineCommand !== "string" || !value.engineCommand.trim() || /[\x00-\x1f]/.test(value.engineCommand))) ||
      value.environment === null || typeof value.environment !== "object" || Array.isArray(value.environment)) {
    throw new Error("WSL launch configuration is invalid");
  }
  for (const [key, entry] of Object.entries(value.environment)) {
    if (!BRIDGED_ENV_KEYS.includes(key) || typeof entry !== "string" || entry.includes("\0")) {
      throw new Error("WSL launch environment is invalid");
    }
  }
  return value;
}

function quoteCommandArgument(value) {
  // Match the server's quote-aware argv parser, not a shell grammar.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function serverEnvironment(config, source = process.env, nodePath = process.execPath) {
  const environment = { ...source };
  // A Windows connection override must never borrow a Linux endpoint or secret.
  for (const keys of [
    ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"],
    ["OPENAI_BASE_URL", "OPENAI_API_KEY"],
    ["GOOGLE_GEMINI_BASE_URL", "GEMINI_API_KEY"],
    ["ORG_WORKBENCH_DOC_URL", "ORG_WORKBENCH_DOC_TOKEN"],
    ["ORG_WORKBENCH_MEM_URL", "ORG_WORKBENCH_MEM_TOKEN", "MEM_URL", "MEM_TOKEN"],
  ]) {
    if (keys.some((key) => Object.hasOwn(config.environment, key))) {
      for (const key of keys) delete environment[key];
    }
  }
  Object.assign(environment, config.environment);
  for (const key of Object.keys(environment)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("ORG_WORKBENCH_PACKAGED_SMOKE_") || upper.startsWith("ORG_WORKBENCH_PACKAGED_BEHAVIOR_SMOKE_")) delete environment[key];
  }
  delete environment.ELECTRON_RUN_AS_NODE;
  // A bridge endpoint is allocated by this supervisor, never inherited from
  // either user's shell or sent as a Windows filesystem path into Linux.
  delete environment.ROLEWEAVE_WORKBUDDY_BRIDGE;
  delete environment.ROLEWEAVE_WORKBUDDY_BRIDGE_TOKEN;
  environment.ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE = "0";
  const bundled = config.engineCommand === null;
  environment.ORG_WORKBENCH_INTERNAL_BUNDLED_NODE_ENGINE = bundled ? "1" : "0";
  environment.ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI = bundled
    ? `${quoteCommandArgument(nodePath)} ${quoteCommandArgument(path.posix.resolve(path.posix.dirname(config.serverEntry), "../../bin/qoder-engine.mjs"))}`
    : config.engineCommand;
  // CLI shims commonly use /usr/bin/env node. Pin them to the same Linux
  // installation as the server, then include the standard per-user CLI
  // directory even when a noninteractive login shell omits it from PATH.
  const userBin = typeof source.HOME === "string" && path.posix.isAbsolute(source.HOME) && !source.HOME.startsWith("//")
    ? [path.posix.join(source.HOME, ".local", "bin")]
    : [];
  environment.PATH = [path.posix.dirname(nodePath), ...userBin, source.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":");
  // Node does not normally consult SSL_CERT_FILE. Reuse a readable CA bundle
  // that this Linux user already configured, without overriding a Node-specific
  // choice or changing any trust settings outside the child environment.
  if (source.NODE_EXTRA_CA_CERTS === undefined && typeof source.SSL_CERT_FILE === "string") {
    try {
      if (fs.statSync(source.SSL_CERT_FILE).isFile()) {
        fs.accessSync(source.SSL_CERT_FILE, fs.constants.R_OK);
        environment.NODE_EXTRA_CA_CERTS = source.SSL_CERT_FILE;
      }
    } catch { /* Missing/unreadable user CA is not a new Node configuration. */ }
  }
  return environment;
}

function processIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return null;
  }
}

function rememberDescendants(pid, known, visited = new Set()) {
  if (visited.has(pid) || visited.size >= 4096) return;
  visited.add(pid);
  let children;
  try {
    children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/);
  } catch {
    return;
  }
  for (const entry of children) {
    const childPid = Number(entry);
    if (!Number.isSafeInteger(childPid) || childPid <= 1 || childPid === process.pid) continue;
    const identity = processIdentity(childPid);
    if (identity === null) continue;
    known.set(childPid, identity);
    rememberDescendants(childPid, known, visited);
  }
}

function runSupervisor() {
  let buffer = "";
  let child = null;
  let configured = false;
  let stopping = false;
  let exitCode = 0;
  let bridge;
  const pendingBridgeCalls = new Map();
  const descendants = new Map();
  let monitor;
  const signalTree = (signal) => {
    if (!child?.pid) return;
    rememberDescendants(child.pid, descendants);
    for (const [pid, identity] of [...descendants].reverse()) {
      if (processIdentity(pid) !== identity) continue;
      try { process.kill(pid, signal); } catch { /* exited during cleanup */ }
    }
    try { process.kill(-child.pid, signal); } catch { /* process group exited */ }
  };
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(startupTimer);
    exitCode = code;
    clearInterval(monitor);
    bridge?.close();
    for (const pending of pendingBridgeCalls.values()) pending.reject(Object.assign(new Error("WorkBuddy bridge stopped"), { code: "workbuddy.bridge_closed" }));
    pendingBridgeCalls.clear();
    if (!child) { process.exitCode = code; process.stdin.destroy(); return; }
    signalTree("SIGTERM");
    // Detached Host groups (including Codex) remain tracked by pid/start time.
    // A bounded force phase runs even if the direct server exits first.
    setTimeout(() => {
      signalTree("SIGKILL");
      setTimeout(() => process.exit(exitCode), 50);
    }, 500);
  };
  const fail = (message) => {
    process.stderr.write(`RoleWeave: ${message}\n`);
    stop(1);
  };
  const startupTimer = setTimeout(() => fail("WSL launch configuration did not arrive."), 10000);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (stopping) return;
    buffer += chunk;
    if (!configured && Buffer.byteLength(buffer) > MAX_CONFIG_BYTES) { fail("WSL launch input is too large."); return; }
    const newline = buffer.indexOf("\n");
    if (newline < 0) {
      if (configured && Buffer.byteLength(buffer) > MAX_FRAME_BYTES) fail("WorkBuddy bridge response is too large.");
      return;
    }
    if (configured) {
      if (!bridge) { fail("Unexpected data after WSL launch configuration."); return; }
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          if (Buffer.byteLength(line) + 1 > MAX_FRAME_BYTES) throw Error();
          if (!line.startsWith(RESPONSE_PREFIX)) throw Error();
          const value = JSON.parse(line.slice(RESPONSE_PREFIX.length));
          if (!validId(value?.id) || Object.keys(value).sort().join(",") !== (value.error === undefined ? "id,result" : "error,id") ||
              (value.error !== undefined && (typeof value.error !== "string" || !/^workbuddy\.[a-z_]{1,64}$/.test(value.error)))) throw Error();
          const pending = pendingBridgeCalls.get(value.id);
          if (!pending) continue; // A cancelled request may already be in flight.
          pendingBridgeCalls.delete(value.id);
          if (value.error !== undefined) pending.reject(Object.assign(new Error("WorkBuddy local request failed"), { code: value.error }));
          else pending.resolve(value.result);
        } catch { fail("WorkBuddy bridge response is invalid."); return; }
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) fail("WorkBuddy bridge response is too large.");
      return;
    }
    clearTimeout(startupTimer);
    try {
      if (buffer.slice(newline + 1).length !== 0) throw new Error("WSL launch configuration contains trailing data");
      const config = parseConfiguration(buffer.slice(0, newline));
      configured = true;
      buffer = "";
      const environment = serverEnvironment(config);
      const launch = () => {
        if (stopping) return;
        if (bridge) Object.assign(environment, { ROLEWEAVE_WORKBUDDY_BRIDGE: bridge.endpoint, ROLEWEAVE_WORKBUDDY_BRIDGE_TOKEN: bridge.token });
        child = spawn(process.execPath, [config.serverEntry], {
          env: environment,
          stdio: ["ignore", "inherit", "inherit"],
          detached: true,
        });
        child.once("error", () => fail("WSL control plane could not start."));
        child.once("exit", (code) => stop(code ?? 1));
        monitor = setInterval(() => {
          for (const [pid, identity] of descendants) {
            if (processIdentity(pid) !== identity) descendants.delete(pid);
          }
          rememberDescendants(child.pid, descendants);
        }, 100);
      };
      if (config.environment.ROLEWEAVE_WORKBUDDY_BRIDGE_ENABLED === "1" && config.engineCommand === null) {
        bridge = createPrivateBridge((request, signal) => new Promise((resolve, reject) => {
          pendingBridgeCalls.set(request.id, { resolve, reject });
          const cancel = () => {
            if (!pendingBridgeCalls.delete(request.id)) return;
            process.stdout.write(`${REQUEST_PREFIX}${JSON.stringify({ id: request.id, cancel: true })}\n`);
            reject(Object.assign(new Error("WorkBuddy request cancelled"), { code: "workbuddy.cancelled" }));
          };
          if (signal.aborted) { cancel(); return; }
          signal.addEventListener("abort", cancel, { once: true });
          process.stdout.write(`${REQUEST_PREFIX}${JSON.stringify(request)}\n`);
        }));
        bridge.ready.then(launch, () => fail("WorkBuddy bridge could not start."));
      } else launch();
    } catch {
      fail("WSL launch configuration is invalid.");
    }
  });
  process.stdin.once("end", () => { clearTimeout(startupTimer); stop(); });
  process.stdin.once("error", () => { clearTimeout(startupTimer); stop(1); });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.once(signal, () => { clearTimeout(startupTimer); stop(); });
  }
}

if (require.main === module) runSupervisor();

module.exports = { BRIDGED_ENV_KEYS, MAX_CONFIG_BYTES, parseConfiguration, serverEnvironment };
