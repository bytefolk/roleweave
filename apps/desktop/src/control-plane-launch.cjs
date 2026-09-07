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
function winToWslPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

/**
 * Decide where the control plane runs.
 * - non-win32: always native (the shell and server share the environment).
 * - win32: "wsl" only when the operator opts in via
 *   ORG_WORKBENCH_CONTROL_PLANE=wsl (the WSL-agent topology: engine + control
 *   plane live in WSL, the Windows shell connects over WSL2 localhost
 *   forwarding). Default stays native (Windows-native engine, #225).
 */
function controlPlaneMode(env) {
  if (process.platform !== "win32") return "native";
  return (env.ORG_WORKBENCH_CONTROL_PLANE ?? "").toLowerCase() === "wsl" ? "wsl" : "native";
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
    const wslEntry = winToWslPath(serverEntry);
    const child = spawn(
      "wsl.exe",
      ["-e", "bash", "-lc", `node "${wslEntry}"`],
      { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
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
    return winToWslPath(windowsPath);
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
};
