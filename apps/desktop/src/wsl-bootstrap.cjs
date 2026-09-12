// Linux-side supervisor. Configuration arrives once over stdin, which stays
// open as a lease owned by the Windows shell. No credentials enter argv/files.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_CONFIG_BYTES = 128 * 1024;
const BRIDGED_ENV_KEYS = Object.freeze([
  "ORG_WORKBENCH_SERVER_PORT", "ORG_WORKBENCH_BOOT_TOKEN",
  "ORG_WORKBENCH_BUDGET_POOL_TOKENS", "ORG_WORKBENCH_DOC_URL",
  "ORG_WORKBENCH_DOC_TOKEN", "ORG_WORKBENCH_DOC_MOCK",
  "ORG_WORKBENCH_QODER_PERMISSION_MODE", "QODER_PERSONAL_ACCESS_TOKEN",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
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
  const environment = { ...source, ...config.environment };
  for (const key of Object.keys(environment)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("ORG_WORKBENCH_PACKAGED_SMOKE_") || upper.startsWith("ORG_WORKBENCH_PACKAGED_BEHAVIOR_SMOKE_")) delete environment[key];
  }
  delete environment.ELECTRON_RUN_AS_NODE;
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
    if (configured) { fail("Unexpected data after WSL launch configuration."); return; }
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_CONFIG_BYTES) { fail("WSL launch configuration is too large."); return; }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    clearTimeout(startupTimer);
    try {
      if (buffer.slice(newline + 1).length !== 0) throw new Error("WSL launch configuration contains trailing data");
      const config = parseConfiguration(buffer.slice(0, newline));
      configured = true;
      buffer = "";
      child = spawn(process.execPath, [config.serverEntry], {
        env: serverEnvironment(config),
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
