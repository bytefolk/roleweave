const { spawn } = require("node:child_process");
const path = require("node:path");
const { BRIDGED_ENV_KEYS, MAX_CONFIG_BYTES } = require("./wsl-bootstrap.cjs");

function engineRuntimeEnvironment(env, bundledEngineCommand) {
  const operatorEngineCommand = env.ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI;
  return {
    ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI:
      operatorEngineCommand ?? bundledEngineCommand,
    ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE:
      operatorEngineCommand === undefined ? "1" : "0",
  };
}

function wslError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function wslDistribution(env) {
  const distro = env.ROLEWEAVE_WSL_DISTRO ?? "";
  if (typeof distro !== "string" || (distro !== "" && !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(distro))) {
    throw wslError("wsl_distribution_invalid", "WSL distribution name is invalid");
  }
  return distro;
}

/** Convert drive paths and a selected distribution's WSL UNC share. */
function winToWslPath(p, distro = "") {
  if (typeof p !== "string" || p.length > 32768 || /[\x00-\x1f]/.test(p)) {
    throw wslError("wsl_path_invalid", "WSL path is invalid");
  }
  const unc = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/i.exec(p);
  if (unc) {
    if (!distro || unc[1].toLowerCase() !== distro.toLowerCase()) {
      throw wslError("wsl_distribution_mismatch", "Choose a folder in the configured WSL distribution");
    }
    const suffix = (unc[2] ?? "").replace(/\\/g, "/");
    if (suffix.split("/").includes("..")) throw wslError("wsl_path_invalid", "WSL UNC path cannot traverse its distribution root");
    return path.posix.normalize(`/${suffix}`);
  }
  if (/^[\\/]{2}/.test(p)) throw wslError("wsl_path_invalid", "Only the configured WSL share is supported in WSL mode");
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

// Values are positional arguments, never interpolated into shell source. The
// login shell owns Linux PATH/HOME/proxy/certificate settings. nvm is a local
// fallback only; this launcher never downloads or installs a runtime.
const WSL_NODE_LAUNCH_SCRIPT = `
roleweave_node_usable() {
  [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(process.platform === "linux" && Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' </dev/null >/dev/null 2>&1
}
roleweave_node="$1"
if [ -n "$roleweave_node" ]; then
  if ! roleweave_node_usable "$roleweave_node"; then
    printf '%s\\n' 'RoleWeave: configured WSL Node must be an executable Linux Node.js 22 or newer.' >&2
    exit 126
  fi
else
  roleweave_node="$(command -v node 2>/dev/null || true)"
  if ! roleweave_node_usable "$roleweave_node"; then
    roleweave_nvm="\${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    if [ -s "$roleweave_nvm" ]; then
      . "$roleweave_nvm" --no-use >/dev/null 2>&1
      nvm use --silent default >/dev/null 2>&1 || true
      roleweave_node="$(command -v node 2>/dev/null || true)"
      if ! roleweave_node_usable "$roleweave_node"; then
        nvm use --silent node >/dev/null 2>&1 || true
        roleweave_node="$(command -v node 2>/dev/null || true)"
      fi
    fi
  fi
  if ! roleweave_node_usable "$roleweave_node"; then
    printf '%s\\n' 'RoleWeave: install Linux Node.js 22 or newer in WSL, or set ROLEWEAVE_WSL_NODE to its absolute path.' >&2
    exit 127
  fi
fi
exec "$roleweave_node" "$2"
`;

// WSL's default account may use zsh. Starting bash directly would silently
// miss that account's login configuration, including its proxy CA settings.
// Resolve the account inside Linux rather than trusting Windows SHELL/HOME.
const WSL_LOGIN_SHELL_SCRIPT = `
roleweave_account="$(getent passwd "$(id -u)" 2>/dev/null || true)"
roleweave_login_shell="\${roleweave_account##*:}"
case "$roleweave_login_shell" in
  /*/bash|/*/zsh)
    if [ -x "$roleweave_login_shell" ]; then
      exec "$roleweave_login_shell" -lc "$1" roleweave-wsl "$2" "$3"
    fi
    ;;
esac
printf '%s\\n' 'RoleWeave: the WSL account login shell is unavailable or unsupported; using bash login configuration. Configure PATH, proxy and certificates there if needed.' >&2
exec /bin/bash -lc "$1" roleweave-wsl "$2" "$3"
`;

function wslLaunchSpec({ serverEntry, env, bootstrapEntry = path.join(__dirname, "wsl-bootstrap.cjs") }) {
  const distro = wslDistribution(env);
  const nodePath = env.ROLEWEAVE_WSL_NODE ?? "";
  if (typeof nodePath !== "string" || (nodePath !== "" && (!path.posix.isAbsolute(nodePath) || nodePath.startsWith("//") || /[\x00-\x1f]/.test(nodePath))) || nodePath.length > 32768) {
    throw wslError("wsl_node_invalid", "WSL Node must be an absolute Linux executable path");
  }
  const linuxEntry = winToWslPath(serverEntry, distro);
  const linuxBootstrap = winToWslPath(bootstrapEntry, distro);
  if (!path.posix.isAbsolute(linuxEntry) || !path.posix.isAbsolute(linuxBootstrap)) {
    throw wslError("wsl_path_invalid", "WSL runtime entries must be absolute paths");
  }
  const bundled = env.ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE === "1" || env.ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI === undefined;
  const environment = {};
  for (const key of BRIDGED_ENV_KEYS) {
    if (env[key] !== undefined) environment[key] = env[key];
  }
  const config = {
    version: 1,
    serverEntry: linuxEntry,
    engineCommand: bundled ? null : env.ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI,
    environment,
  };
  const input = `${JSON.stringify(config)}\n`;
  if (Buffer.byteLength(input) > MAX_CONFIG_BYTES) throw wslError("wsl_config_invalid", "WSL launch configuration is too large");
  return {
    command: "wsl.exe",
    args: [...(distro ? ["--distribution", distro] : []), "--exec", "/bin/sh", "-c", WSL_LOGIN_SHELL_SCRIPT, "roleweave-wsl-login", WSL_NODE_LAUNCH_SCRIPT, nodePath, linuxBootstrap],
    // No implicit Windows-to-Linux overrides; the bounded stdin payload below
    // is the only bridge for RoleWeave settings. In particular Windows PATH,
    // HOME, proxy URLs, certificate paths and Node loader flags stay out.
    env: { ...stripPackagedSmokeControls(env), WSLENV: "" },
    input,
  };
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
    const spec = wslLaunchSpec({ serverEntry, env: childEnv });
    const child = spawn(spec.command, spec.args, { env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
    // Keep the pipe open as the supervisor's lifetime lease. Closing the app
    // (even abnormally) yields EOF in Linux and reaps the server/Host subtree.
    child.stdin.on("error", () => {});
    child.stdin.write(spec.input);
    const killLauncher = child.kill.bind(child);
    child.kill = (signal = "SIGTERM") => {
      if (signal === "SIGTERM" && !child.stdin.destroyed) {
        child.stdin.end();
        return true;
      }
      child.stdin.destroy();
      return killLauncher(signal);
    };
    child.once("exit", () => child.stdin.destroy());
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
    return winToWslPath(windowsPath, wslDistribution(env));
  }
  return windowsPath;
}

module.exports = {
  controlPlaneMode,
  createControlPlaneChild,
  engineRuntimeEnvironment,
  serverPathForWorkspace,
  stripPackagedSmokeControls,
  winToWslPath,
  wslLaunchSpec,
};
