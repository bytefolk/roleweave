const { spawn } = require("node:child_process");
const path = require("node:path");

function engineRuntimeEnvironment(env, bundledEngineCommand) {
  const operatorEngineCommand = env.ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI;
  return {
    ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI:
      operatorEngineCommand ?? bundledEngineCommand,
    ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE:
      operatorEngineCommand === undefined ? "1" : "0",
  };
}

/** Convert a Windows path (C:\x\y) to a WSL path (/mnt/c/x/y). */
function winToWslPath(p, configuredDistro) {
  const unc = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$/i.exec(p);
  if (unc) {
    if (configuredDistro && unc[1].toLowerCase() !== configuredDistro.toLowerCase()) {
      throw new Error(`WSL 路径属于 ${unc[1]}，当前运行环境为 ${configuredDistro}；请选择同一发行版内的路径`);
    }
    return `/${unc[2].replace(/\\/g, "/")}`;
  }
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

function quoteCommandArgument(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The bundled adapter must use the same operating system as its server. */
function bundledEngineCommand(enginePath, env, executable = process.execPath) {
  const wsl = controlPlaneMode(env) === "wsl";
  const binary = wsl ? (env.ROLEWEAVE_WSL_NODE_PATH || "node") : executable;
  return `${quoteCommandArgument(binary)} ${quoteCommandArgument(wsl ? winToWslPath(enginePath, env.ROLEWEAVE_WSL_DISTRO) : enginePath)}`;
}

function wslControlPlaneSpec(serverEntry, env) {
  const environment = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  // WSL does not inherit arbitrary Windows environment variables. Forward
  // application/provider settings by name, without putting secrets in argv.
  // HOME/PATH stay Linux-owned; the bootstrap adds only known Linux locations.
  const forwarded = Object.keys(environment).filter((key) =>
    /^(ORG_WORKBENCH_|ROLEWEAVE_|DIGITAL_EMPLOYEE_|OPENAI_|ANTHROPIC_|QODER_|CONTEXT_)/.test(key) ||
    /^(ELECTRON_RUN_AS_NODE|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(key));
  environment.WSLENV = [...new Set([
    ...(environment.WSLENV || "").split(":").filter(Boolean),
    ...forwarded,
  ])].join(":");
  const args = [];
  if (env.ROLEWEAVE_WSL_DISTRO) args.push("--distribution", env.ROLEWEAVE_WSL_DISTRO);
  args.push("--exec", "bash", "-lc", [
    'if [ -n "$3" ]; then export HOME="$3"; fi',
    'case "$1" in /*) export PATH="${1%/*}:$PATH";; esac',
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"',
    'exec "$1" "$2"',
  ].join("; "), "roleweave", env.ROLEWEAVE_WSL_NODE_PATH || "node", winToWslPath(serverEntry, env.ROLEWEAVE_WSL_DISTRO), env.ROLEWEAVE_WSL_HOME || "");
  return { command: "wsl.exe", args, env: environment };
}

/**
 * Decide where the control plane runs.
 * - non-win32: always native (the shell and server share the environment).
 * - win32: "wsl" only when the operator opts in via
 *   ROLEWEAVE_CONTROL_PLANE_MODE=wsl (or the legacy ORG_WORKBENCH_CONTROL_PLANE=wsl)
 *   — the WSL-agent topology: engine + control plane live in WSL, the Windows
 *   shell connects over WSL2 localhost forwarding. The RoleWeave name wins when
 *   both are set, mirroring workspaceOverride. Default stays native
 *   (Windows-native engine, #225).
 */
function controlPlaneMode(env) {
  if (process.platform !== "win32") return "native";
  const mode = env.ROLEWEAVE_CONTROL_PLANE_MODE ?? env.ORG_WORKBENCH_CONTROL_PLANE ?? "";
  return mode.toLowerCase() === "wsl" ? "wsl" : "native";
}

function asciiUppercase(value) {
  return String(value).replace(/[a-z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) - 32));
}

function stripPackagedSmokeControls(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      const canonicalKey = asciiUppercase(key);
      return !canonicalKey.startsWith("ORG_WORKBENCH_PACKAGED_SMOKE_") &&
        !canonicalKey.startsWith("ORG_WORKBENCH_PACKAGED_BEHAVIOR_SMOKE_");
    }),
  );
}

/**
 * Spawn the control-plane server. Returns a ChildProcess whose stdout carries
 * the "org-workbench-server ready {port,token}" line. For the WSL mode the
 * server runs inside WSL (via wsl.exe) and the returned port is reachable from
 * Windows through WSL2 localhostForwarding, so the shell still dials
 * 127.0.0.1:port and the loopback security model is unchanged.
 */
function createControlPlaneChild({ serverEntry, env }) {
  const childEnv = stripPackagedSmokeControls(env);
  const mode = controlPlaneMode(childEnv);
  if (mode === "wsl") {
    const spec = wslControlPlaneSpec(serverEntry, childEnv);
    const child = spawn(
      spec.command,
      spec.args,
      { env: spec.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    return child;
  }
  const child = spawn(process.execPath, [serverEntry], {
    env: { ...childEnv, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    // On POSIX the control plane owns a process group so stop can reap a
    // provider/driver child as well. Windows uses ChildProcess#kill below.
    detached: process.platform !== "win32",
  });
  if (process.platform !== "win32") child.__owbProcessGroupLeader = true;
  return child;
}

/**
 * Convert a workspace path to the form the control-plane server expects.
 * In WSL mode the server runs inside Linux, so Windows drive-letter paths
 * must be translated to /mnt/<drive>/... before posting. In native mode
 * (or on non-win32 hosts) the path is returned unchanged.
 */
function serverPathForWorkspace(windowsPath, env) {
  if (controlPlaneMode(env) === "wsl") {
    return winToWslPath(windowsPath, env.ROLEWEAVE_WSL_DISTRO);
  }
  return windowsPath;
}

module.exports = {
  bundledEngineCommand,
  controlPlaneMode,
  createControlPlaneChild,
  engineRuntimeEnvironment,
  serverPathForWorkspace,
  stripPackagedSmokeControls,
  winToWslPath,
  wslControlPlaneSpec,
};
