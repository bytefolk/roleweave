import { spawn } from "node:child_process";
import type { ServerResponse } from "node:http";
import type { QoderLoginResponse } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { runtimeExecutableEnvironment } from "../engine/process-environment.js";
import { sendJson } from "../http.js";
import { resolveQoderExecutable } from "../qoder-binary.js";
import { createLauncherSpawnSpec } from "../windows-launcher.js";

/**
 * One-click Qoder CLI login owned by the control plane.
 *
 * The health probe reports `loginRequired` when the bundled Qoder Host's only
 * blocker is a missing account login; telling the operator to visit a terminal
 * and re-refresh by hand is a repair path the desktop can own instead. This
 * module spawns exactly one `qodercli login` child, tracks its lifecycle, and
 * serves its state so the renderer can show progress, offer the printed login
 * URL as an explicit fallback when the CLI cannot open a browser itself, and
 * refresh health the moment the login lands.
 *
 * Credential hygiene: the child's output is captured bounded and in memory
 * only; the single URL handed to the renderer is the operator's own login link
 * on the loopback, bearer-protected surface, and is dropped as soon as the
 * process exits. No credential store is read here, matching the probe.
 */

const LOGIN_OUTPUT_MAX = 64 * 1024;
const LOGIN_URL_RE = /https?:\/\/[^\s"'<>]+/;

interface LoginProcessState extends QoderLoginResponse {
  output: string;
}

let state: LoginProcessState = { running: false, startedAt: null, exitCode: null, output: "" };

function publicState(current: LoginProcessState): QoderLoginResponse {
  const base: QoderLoginResponse = {
    running: current.running,
    startedAt: current.startedAt,
    exitCode: current.exitCode,
    ...(current.failure ? { failure: current.failure } : {}),
  };
  // The URL is a live login link; serving it after the process ended would
  // hand out a stale (possibly single-use) authorization address.
  if (current.running) {
    const match = LOGIN_URL_RE.exec(current.output);
    if (match) return { ...base, loginUrl: match[0] };
  }
  return base;
}

export function qoderLoginState(): QoderLoginResponse {
  return publicState(state);
}

/** Test-only: forget the current child so cases start from a clean slot. */
export function resetQoderLoginState(): void {
  state = { running: false, startedAt: null, exitCode: null, output: "" };
}

export function startQoderLogin(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): QoderLoginResponse {
  if (state.running) return publicState(state);
  const command = resolveQoderExecutable(env, platform);
  if (command === null) {
    state = { running: false, startedAt: null, exitCode: null, failure: "binary_unavailable", output: "" };
    return publicState(state);
  }
  // The login must write its credential where the status probe reads it, so
  // the explicit config dir carries over; nothing else does.
  const loginEnvironment = runtimeExecutableEnvironment(env);
  if (env.QODER_CONFIG_DIR) loginEnvironment.QODER_CONFIG_DIR = env.QODER_CONFIG_DIR;
  let child: ReturnType<typeof spawn>;
  try {
    const spec = createLauncherSpawnSpec(command, ["login"], loginEnvironment, platform);
    child = spawn(spec.command, spec.args, {
      ...spec.options,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    state = { running: false, startedAt: null, exitCode: null, failure: "spawn_failed", output: "" };
    return publicState(state);
  }
  const startedAt = new Date().toISOString();
  state = { running: true, startedAt, exitCode: null, output: "" };
  const ownsSlot = (): boolean => state.running && state.startedAt === startedAt;
  const capture = (chunk: Buffer | string): void => {
    if (!ownsSlot()) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const remaining = LOGIN_OUTPUT_MAX - Buffer.byteLength(state.output, "utf8");
    if (remaining <= 0) return;
    state = { ...state, output: state.output + Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8") };
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.once("error", () => {
    if (ownsSlot()) state = { running: false, startedAt, exitCode: null, failure: "spawn_failed", output: "" };
  });
  child.once("exit", (code) => {
    if (ownsSlot()) state = { running: false, startedAt, exitCode: code, output: state.output };
  });
  return publicState(state);
}

export async function handleQoderLoginStart(_ctx: ControlPlaneContext, res: ServerResponse): Promise<void> {
  sendJson(res, 200, startQoderLogin(process.env));
}

export async function handleQoderLoginStatus(_ctx: ControlPlaneContext, res: ServerResponse): Promise<void> {
  sendJson(res, 200, qoderLoginState());
}
