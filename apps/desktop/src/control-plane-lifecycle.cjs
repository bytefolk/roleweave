const READY_PREFIX = "org-workbench-server ready ";
const DEFAULT_READY_TIMEOUT_MS = 15000;
const DEFAULT_STOP_TIMEOUT_MS = 2000;

function lifecycleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateReadyInfo(info) {
  if (info === null || typeof info !== "object" || Array.isArray(info)) {
    throw lifecycleError("control_plane_ready_invalid", "control plane READY payload is not an object");
  }
  const keys = Object.keys(info).sort();
  if (keys.join(",") !== "api,port,token") {
    throw lifecycleError("control_plane_ready_invalid", "control plane READY payload has an unexpected shape");
  }
  if (info.api !== "v0") {
    throw lifecycleError("control_plane_ready_invalid", "control plane READY api is unsupported");
  }
  if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535) {
    throw lifecycleError("control_plane_ready_invalid", "control plane READY port is invalid");
  }
  if (typeof info.token !== "string" || !/^[a-f0-9]{64}$/.test(info.token)) {
    throw lifecycleError("control_plane_ready_invalid", "control plane READY token is invalid");
  }
  return Object.freeze({ api: info.api, port: info.port, token: info.token });
}

function parseReadyLine(line) {
  if (!String(line).startsWith(READY_PREFIX)) return null;
  const raw = String(line).slice(READY_PREFIX.length).trim();
  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    throw lifecycleError("control_plane_ready_invalid", "control plane READY payload is not valid JSON");
  }
  return validateReadyInfo(info);
}

function childHasExited(child) {
  return child?.exitCode !== null || child?.signalCode !== null;
}

function isControlPlaneAlive(child) {
  return Boolean(child && !childHasExited(child) && child.killed !== true);
}

function sendSignal(child, signal) {
  if (!child || childHasExited(child)) return false;
  const pid = Number(child.pid);
  if (process.platform !== "win32" && child.__owbProcessGroupLeader === true &&
      Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
    try {
      // The launcher may opt into a process group. Failing that, fall back to
      // ChildProcess#kill so WSL and test doubles retain their normal path.
      process.kill(-pid, signal);
      return true;
    } catch {
      // Not every child is a detached process-group leader.
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function exitSnapshot(child, forced = false) {
  return {
    state: "stopped",
    forced,
    exitCode: child?.exitCode ?? null,
    signalCode: child?.signalCode ?? null,
  };
}

function waitForExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(exitSnapshot(child));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (forced) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exitSnapshot(child, forced));
    };
    const onExit = () => finish(false);
    const timer = setTimeout(() => finish(true), timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopControlPlaneProcess(handle, { termTimeoutMs = DEFAULT_STOP_TIMEOUT_MS } = {}) {
  if (!handle || !handle.child) return { state: "stopped", forced: false, exitCode: null, signalCode: null };
  if (handle.stopPromise) return handle.stopPromise;
  handle.stopPromise = (async () => {
    if (childHasExited(handle.child)) return exitSnapshot(handle.child);
    sendSignal(handle.child, "SIGTERM");
    const graceful = await waitForExit(handle.child, termTimeoutMs);
    if (!graceful.forced || childHasExited(handle.child)) return graceful;
    sendSignal(handle.child, "SIGKILL");
    const forced = await waitForExit(handle.child, termTimeoutMs);
    if (!childHasExited(handle.child)) {
      throw lifecycleError("control_plane_stop_timeout", "control plane did not exit after SIGKILL");
    }
    return { ...forced, forced: true };
  })();
  return handle.stopPromise;
}

function startControlPlaneProcess({ createChild, readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
  if (typeof createChild !== "function") {
    return Promise.reject(lifecycleError("control_plane_start_invalid", "createChild is required"));
  }
  let child;
  try {
    child = createChild();
  } catch (error) {
    return Promise.reject(error);
  }
  if (!child?.stdout || typeof child.stdout.on !== "function") {
    sendSignal(child, "SIGKILL");
    return Promise.reject(lifecycleError("control_plane_start_invalid", "control plane stdout is unavailable"));
  }

  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (isControlPlaneAlive(child)) {
        sendSignal(child, "SIGTERM");
        setTimeout(() => sendSignal(child, "SIGKILL"), 250).unref?.();
      }
      reject(error);
    };
    const ready = (info) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ child, ...info, state: "ready" });
    };
    const onData = (chunk) => {
      buffer += String(chunk);
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith(READY_PREFIX)) continue;
        try {
          ready(parseReadyLine(line));
        } catch (error) {
          fail(error);
        }
        return;
      }
    };
    const onError = (error) => fail(error);
    const onExit = (code, signal) => {
      fail(lifecycleError(
        "control_plane_exited_early",
        `control plane exited before READY (code ${code ?? "null"}, signal ${signal ?? "null"})`,
      ));
    };
    const timer = setTimeout(() => {
      fail(lifecycleError("control_plane_ready_timeout", `control plane did not become ready within ${readyTimeoutMs}ms`));
    }, readyTimeoutMs);
    child.stdout.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

module.exports = {
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  READY_PREFIX,
  isControlPlaneAlive,
  parseReadyLine,
  startControlPlaneProcess,
  stopControlPlaneProcess,
  validateReadyInfo,
};
