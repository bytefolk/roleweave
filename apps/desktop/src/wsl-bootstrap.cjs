// Linux-side supervisor. Configuration arrives once over stdin, which stays
// open as a lease owned by the Windows shell. No credentials enter argv/files.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const workbuddyChannel = require("./workbuddy-bridge.cjs");
const officeChannel = require("./qwen-office-bridge.cjs");
const { MAX_FRAME_BYTES, validId } = workbuddyChannel;
const CHANNELS = [
  { name: "workbuddy", errorPrefix: "workbuddy", environmentPrefix: "ROLEWEAVE_WORKBUDDY", ...workbuddyChannel },
  { name: "qwen-office", errorPrefix: "qwen_office", environmentPrefix: "ROLEWEAVE_QWEN_OFFICE", ...officeChannel },
];

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
  "ROLEWEAVE_QWEN_OFFICE_BRIDGE_ENABLED",
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
  delete environment.ROLEWEAVE_QWEN_OFFICE_BRIDGE;
  delete environment.ROLEWEAVE_QWEN_OFFICE_BRIDGE_TOKEN;
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
  const bridges = new Map();
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
    for (const bridge of bridges.values()) bridge.close();
    for (const pending of pendingBridgeCalls.values()) pending.reject(Object.assign(new Error("Local client bridge stopped"), { code: `${pending.channel.errorPrefix}.bridge_closed` }));
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
      if (configured && Buffer.byteLength(buffer) > MAX_FRAME_BYTES) fail("Local client bridge response is too large.");
      return;
    }
    if (configured) {
      if (!bridges.size) { fail("Unexpected data after WSL launch configuration."); return; }
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          if (Buffer.byteLength(line) + 1 > MAX_FRAME_BYTES) throw Error();
          const channel = CHANNELS.find((entry) => bridges.has(entry.name) && line.startsWith(entry.RESPONSE_PREFIX));
          if (!channel) throw Error();
          const value = JSON.parse(line.slice(channel.RESPONSE_PREFIX.length));
          const expectedKeys = value.event !== undefined ? "event,id" : value.error === undefined ? "id,result" : "error,id";
          if (!validId(value?.id) || Object.keys(value).sort().join(",") !== expectedKeys ||
              (value.error !== undefined && (typeof value.error !== "string" || !new RegExp(`^${channel.errorPrefix}\\.[a-z_]{1,64}$`).test(value.error)))) throw Error();
          const key = `${channel.name}:${value.id}`;
          const pending = pendingBridgeCalls.get(key);
          if (!pending) continue; // A cancelled request may already be in flight.
          if (value.event !== undefined) {
            if (channel.name !== "qwen-office" || !value.event || Object.keys(value.event).join(",") !== "status" ||
                !["running", "waiting_for_input"].includes(value.event.status)) throw Error();
            pending.onProgress?.(value.event);
            continue;
          }
          pendingBridgeCalls.delete(key);
          pending.detach();
          if (value.error !== undefined) pending.reject(Object.assign(new Error("Local client request failed"), { code: value.error }));
          else pending.resolve(value.result);
        } catch { fail("Local client bridge response is invalid."); return; }
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) fail("Local client bridge response is too large.");
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
        for (const channel of CHANNELS) {
          const bridge = bridges.get(channel.name);
          if (bridge) {
            environment[`${channel.environmentPrefix}_BRIDGE`] = bridge.endpoint;
            environment[`${channel.environmentPrefix}_BRIDGE_TOKEN`] = bridge.token;
          }
        }
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
      for (const channel of CHANNELS) {
        if (config.environment[`${channel.environmentPrefix}_BRIDGE_ENABLED`] !== "1" || config.engineCommand !== null) continue;
        const bridge = channel.createPrivateBridge((request, signal, onProgress) => new Promise((resolve, reject) => {
          const key = `${channel.name}:${request.id}`;
          const cancel = () => {
            if (!pendingBridgeCalls.delete(key)) return;
            process.stdout.write(`${channel.REQUEST_PREFIX}${JSON.stringify({ id: request.id, cancel: true })}\n`);
            reject(Object.assign(new Error("Local client request cancelled"), { code: `${channel.errorPrefix}.cancelled` }));
          };
          pendingBridgeCalls.set(key, { resolve, reject, onProgress, channel, detach: () => signal.removeEventListener("abort", cancel) });
          if (signal.aborted) { cancel(); return; }
          signal.addEventListener("abort", cancel, { once: true });
          process.stdout.write(`${channel.REQUEST_PREFIX}${JSON.stringify(request)}\n`);
        }));
        bridges.set(channel.name, bridge);
      }
      if (bridges.size) Promise.all([...bridges.values()].map((bridge) => bridge.ready)).then(launch, () => fail("Local client bridge could not start."));
      else launch();
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
