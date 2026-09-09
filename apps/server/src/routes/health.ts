import { spawnSync } from "node:child_process";
import type { ServerResponse } from "node:http";
import type { HealthResponse } from "@org-workbench/shared";
import type { ControlPlaneContext } from "../context.js";
import { probeEngine } from "../engine/probe.js";
import { runtimeExecutableEnvironment } from "../engine/process-environment.js";
import { sendJson } from "../http.js";
import { resolveClaudeExecutable } from "../claude-binary.js";
import { resolveCodexExecutable } from "../codex-binary.js";
import { resolveQoderExecutable } from "../qoder-binary.js";

/** Mirrors digital-employee's claude-local model port (#184): >= 2.1.214, < 2.2.0. */
const CLAUDE_VERSION_MIN = [2, 1, 214] as const;
const CLAUDE_VERSION_MAX = [2, 2, 0] as const;
const QODER_VERSION_MAJOR = 1;
const QODER_VERSION_MINOR = 1;

export interface ClaudeLocalBinaryState {
  installed: boolean;
  version: string | null;
  supported: boolean;
}

export interface CodexBinaryState {
  installed: boolean;
  version: string | null;
}

export type QoderLocalProbeFailure = "unavailable" | "timed_out" | "unsupported_version";

export interface QoderLocalBinaryState {
  installed: boolean;
  version: string | null;
  supported: boolean;
  failure?: QoderLocalProbeFailure;
}

export interface HostHealthInput {
  engineAvailable: boolean;
  engineVersion?: string;
  env: NodeJS.ProcessEnv;
  qoderLocal?: QoderLocalBinaryState;
  claudeLocal?: ClaudeLocalBinaryState;
  codex?: CodexBinaryState;
}

function compareParts(parts: readonly [number, number, number], bound: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (parts[index]! < bound[index]!) return -1;
    if (parts[index]! > bound[index]!) return 1;
  }
  return 0;
}

export function supportedClaudeVersion(announced: string | null): boolean {
  if (announced === null) return false;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(announced);
  if (!match) return false;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return false;
  return compareParts(parts, CLAUDE_VERSION_MIN) >= 0 && compareParts(parts, CLAUDE_VERSION_MAX) < 0;
}

/** The bundled adapter was qualified against the Qoder CLI 1.1.x family. */
export function supportedQoderVersion(announced: string | null): boolean {
  if (announced === null) return false;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(announced);
  if (!match) return false;
  return Number(match[1]) === QODER_VERSION_MAJOR && Number(match[2]) === QODER_VERSION_MINOR;
}

/**
 * Bounded, local-only preflight for the Qoder CLI used by qoder-engine.
 *
 * This deliberately runs only `--version`. It does not inspect Qoder account
 * state, read a credential store, or claim that remote model entitlement is
 * valid; a real turn remains the only such evidence.
 */
export function probeQoderLocalBinary(
  env: NodeJS.ProcessEnv,
  timeoutMs = 3000,
  platform: NodeJS.Platform = process.platform,
): QoderLocalBinaryState {
  const command = resolveQoderExecutable(env, platform);
  if (command === null) {
    return { installed: false, version: null, supported: false, failure: "unavailable" };
  }
  let probe: ReturnType<typeof spawnSync>;
  // Node refuses to exec Windows .bat/.cmd launcher scripts without a shell
  // (CVE-2024-27980 hardening). Route exactly those resolved targets through
  // cmd.exe; every other target keeps the shell-free probe.
  const needsWindowsShell = platform === "win32" && /\.(bat|cmd)$/i.test(command);
  try {
    probe = spawnSync(command, ["--version"], {
      encoding: "utf8",
      // The version probe is a true Qoder descendant. It needs only process
      // startup paths/locales, never Electron mode, boot state, provider
      // credentials, internal markers or arbitrary server environment.
      env: runtimeExecutableEnvironment(env),
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      // SIGTERM is catchable and makes spawnSync wait past its timeout. The
      // local-only version probe must have a hard process-lifetime bound.
      killSignal: "SIGKILL",
      shell: needsWindowsShell,
      windowsHide: true,
    });
  } catch {
    return { installed: false, version: null, supported: false, failure: "unavailable" };
  }
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    return { installed: true, version: null, supported: false, failure: "timed_out" };
  }
  if (probe.error !== undefined || probe.status !== 0) {
    return { installed: false, version: null, supported: false, failure: "unavailable" };
  }
  const announced = typeof probe.stdout === "string" && probe.stdout.trim().length > 0
    ? probe.stdout
    : typeof probe.stderr === "string"
      ? probe.stderr
      : "";
  const match = /(\d+\.\d+\.\d+)/.exec(announced);
  const version = match ? match[1]! : null;
  const supported = supportedQoderVersion(version);
  return supported
    ? { installed: true, version, supported: true }
    : { installed: true, version, supported: false, failure: "unsupported_version" };
}

/**
 * Local preflight for the claude-local Host. Only checks the binary and its
 * announced version — login state is asserted by the engine at run time from
 * the announced apiKeySource, so no credential store is ever inspected.
 */
export function probeClaudeLocalBinary(
  env: NodeJS.ProcessEnv,
  timeoutMs = 3000,
  platform: NodeJS.Platform = process.platform,
): ClaudeLocalBinaryState {
  const command = resolveClaudeExecutable(env, platform);
  if (command === null) {
    return { installed: false, version: null, supported: false };
  }
  let probe: ReturnType<typeof spawnSync>;
  // Node refuses to exec Windows .bat/.cmd launcher scripts without a shell
  // (CVE-2024-27980 hardening). Route exactly those resolved targets through
  // cmd.exe; every other target keeps the shell-free probe.
  const needsWindowsShell = platform === "win32" && /\.(bat|cmd)$/i.test(command);
  try {
    probe = spawnSync(command, ["--version"], {
      encoding: "utf8",
      env: runtimeExecutableEnvironment(env),
      killSignal: "SIGKILL",
      timeout: timeoutMs,
      shell: needsWindowsShell,
      windowsHide: true,
    });
  } catch {
    return { installed: false, version: null, supported: false };
  }
  if (probe.error !== undefined || probe.status !== 0) {
    return { installed: false, version: null, supported: false };
  }
  const announced = typeof probe.stdout === "string" && probe.stdout.trim().length > 0
    ? probe.stdout
    : typeof probe.stderr === "string"
      ? probe.stderr
      : "";
  const match = /(\d+\.\d+\.\d+)/.exec(announced);
  const version = match ? match[1]! : null;
  return { installed: true, version, supported: supportedClaudeVersion(version) };
}

/**
 * Bounded, local-only preflight for the Codex CLI used by the bundled engine.
 *
 * Unlike the Claude and Qoder probes there is no supported-version window to
 * check: the Codex engine (#206) deliberately makes no tier-1 qualification
 * claim, because its model-visible tool set cannot be emptied. Pinning a range
 * here would imply a qualification that was never performed, so the probe
 * reports installation and the announced version only.
 */
export function probeCodexBinary(
  env: NodeJS.ProcessEnv,
  timeoutMs = 3000,
  platform: NodeJS.Platform = process.platform,
): CodexBinaryState {
  const command = resolveCodexExecutable(env, platform);
  if (command === null) {
    return { installed: false, version: null };
  }
  let probe: ReturnType<typeof spawnSync>;
  const needsWindowsShell = platform === "win32" && /\.(bat|cmd)$/i.test(command);
  try {
    probe = spawnSync(command, ["--version"], {
      encoding: "utf8",
      env: runtimeExecutableEnvironment(env),
      killSignal: "SIGKILL",
      timeout: timeoutMs,
      shell: needsWindowsShell,
      windowsHide: true,
    });
  } catch {
    return { installed: false, version: null };
  }
  if (probe.error !== undefined || probe.status !== 0) {
    return { installed: false, version: null };
  }
  const announced = typeof probe.stdout === "string" && probe.stdout.trim().length > 0
    ? probe.stdout
    : typeof probe.stderr === "string"
      ? probe.stderr
      : "";
  const match = /(\d+\.\d+\.\d+)/.exec(announced);
  return { installed: true, version: match ? match[1]! : null };
}

function isBundledQoderEngine(version: string | undefined): boolean {
  return typeof version === "string" && /^qoder-engine\s+\d+\.\d+\.\d+$/.test(version.trim());
}

function bundledQoderNextStep(state: QoderLocalBinaryState, engineAvailable: boolean): string | undefined {
  if (!engineAvailable) return "先修复 bundled qoder-engine 的本地启动配置";
  if (state.failure === "timed_out") {
    return "Qoder CLI 版本探测超时；检查本机进程状态，或用 ORG_WORKBENCH_QODER_BIN / DIGITAL_EMPLOYEE_QODER_COMMAND 指定可执行的 qoder/qodercli（国区版：qoderclicn）";
  }
  if (!state.installed || state.failure === "unavailable") {
    return "安装 Qoder CLI 并确保 qoder 在 PATH 上，或用 ORG_WORKBENCH_QODER_BIN / DIGITAL_EMPLOYEE_QODER_COMMAND 指定 qoder/qodercli 二进制（国区版命令名：qoderclicn / qodercn）";
  }
  if (!state.supported) {
    return state.version === null
      ? "Qoder CLI 版本无法解析；bundled qoder-engine 仅支持 1.1.x"
      : `Qoder CLI 版本 ${state.version} 不在 bundled qoder-engine 的 1.1.x 支持范围内`;
  }
  return undefined;
}

export function hostHealth({
  engineAvailable,
  engineVersion,
  env,
  qoderLocal = { installed: false, version: null, supported: false, failure: "unavailable" },
  claudeLocal = { installed: false, version: null, supported: false },
  codex = { installed: false, version: null },
}: HostHealthInput): HealthResponse["hosts"] {
  const bundledQoder = isBundledQoderEngine(engineVersion);
  const qoderServiceTokenConfigured = typeof env.QODER_PERSONAL_ACCESS_TOKEN === "string" && env.QODER_PERSONAL_ACCESS_TOKEN.length > 0;
  const qoderConfigured = bundledQoder ? qoderLocal.supported : qoderServiceTokenConfigured;
  const qoderNextStep = bundledQoderNextStep(qoderLocal, engineAvailable);
  const claudeConfigured = typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0;
  const claudeLocalConfigured = claudeLocal.installed && claudeLocal.supported;
  // Neither Codex Host has a supported-version window to gate on. The two
  // differ only in how the provider is reached: `codex` requires an explicit
  // service credential, while `codex-local` runs on the operator's own Codex
  // login and must never be gated on — or handed — a credential, exactly as
  // claude-local is not gated on ANTHROPIC_API_KEY. Login state itself is
  // asserted by the engine at run time; no credential store is inspected here.
  const codexProviderConfigured = typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0;
  const codexConfigured = codex.installed && codexProviderConfigured;
  const codexLocalConfigured = codex.installed;
  const claudeCodeConfigured = bundledQoder
    ? (claudeLocal.installed && claudeLocal.supported && claudeConfigured)
    : claudeConfigured;
  return {
    qoder: {
      configured: qoderConfigured,
      ready: engineAvailable && qoderConfigured,
      ...(bundledQoder
        ? (qoderNextStep !== undefined ? { nextStep: qoderNextStep } : {})
        : !qoderConfigured
          ? { nextStep: "设置 QODER_PERSONAL_ACCESS_TOKEN 后重启工作台" }
        : !engineAvailable
          ? { nextStep: "先安装或配置支持 turn run 的 digital-employee CLI" }
          : {}),
    },
    "claude-code": {
      configured: claudeCodeConfigured,
      ready: engineAvailable && claudeCodeConfigured,
      ...(bundledQoder
        ? (!claudeLocal.installed
            ? { nextStep: "安装 Claude Code 并确保 claude 在 PATH 上（或用 DIGITAL_EMPLOYEE_CLAUDE_COMMAND 指定二进制路径）" }
            : !claudeLocal.supported
              ? {
                  nextStep: claudeLocal.version === null
                    ? "Claude Code 版本无法解析；支持窗口为 >= 2.1.214 且 < 2.2.0"
                    : `Claude Code 版本 ${claudeLocal.version} 不在支持窗口（>= 2.1.214 且 < 2.2.0）内，请升级或降级`,
                }
              : !claudeConfigured
                ? { nextStep: "设置 ANTHROPIC_API_KEY 后重启工作台" }
                : !engineAvailable
                  ? { nextStep: "先修复 bundled qoder-engine 的本地启动配置" }
                  : {})
        : !claudeConfigured
          ? { nextStep: "设置 ANTHROPIC_API_KEY 后重启工作台" }
          : !engineAvailable
            ? { nextStep: "先安装或配置支持 turn run 的 digital-employee CLI" }
            : {}),
    },
    "claude-local": {
      configured: claudeLocalConfigured,
      ready: engineAvailable && claudeLocalConfigured,
      ...(!claudeLocal.installed
        ? { nextStep: "安装 Claude Code 并确保 claude 在 PATH 上（或用 DIGITAL_EMPLOYEE_CLAUDE_COMMAND 指定二进制路径）" }
        : !claudeLocal.supported
          ? {
              nextStep: claudeLocal.version === null
                ? "Claude Code 版本无法解析；支持窗口为 >= 2.1.214 且 < 2.2.0"
                : `Claude Code 版本 ${claudeLocal.version} 不在支持窗口（>= 2.1.214 且 < 2.2.0）内，请升级或降级`,
            }
          : !engineAvailable
            ? { nextStep: "先安装或配置支持 turn run 的 digital-employee CLI" }
            : {}),
    },
    codex: {
      configured: codexConfigured,
      ready: engineAvailable && codexConfigured,
      ...(!codex.installed
        ? { nextStep: "安装 Codex CLI 并确保 codex 在 PATH 上（或用 DIGITAL_EMPLOYEE_CODEX_COMMAND 指定二进制路径）" }
        : !codexProviderConfigured
          ? { nextStep: "设置 OPENAI_API_KEY（如需自建或中转端点，另设 OPENAI_BASE_URL）后重启工作台；若要用 Codex 订阅登录，请改选 Codex（本地登录）" }
          : !engineAvailable
            ? { nextStep: "先修复 bundled qoder-engine 的本地启动配置" }
            : {}),
    },
    "codex-local": {
      configured: codexLocalConfigured,
      ready: engineAvailable && codexLocalConfigured,
      ...(!codex.installed
        ? { nextStep: "安装 Codex CLI 并确保 codex 在 PATH 上（或用 DIGITAL_EMPLOYEE_CODEX_COMMAND 指定二进制路径）" }
        : !engineAvailable
          ? { nextStep: "先修复 bundled qoder-engine 的本地启动配置" }
          : {}),
    },
  };
}

export async function handleHealth(ctx: ControlPlaneContext, res: ServerResponse): Promise<void> {
  const probe = await probeEngine(ctx.config.cliCommand, 5000, {
    bundledElectronEngine: ctx.config.bundledElectronEngine,
  });
  const claudeLocal = probeClaudeLocalBinary(process.env);
  const codex = probeCodexBinary(process.env);
  const qoderLocal = isBundledQoderEngine(probe.version)
    ? probeQoderLocalBinary(process.env)
    : undefined;
  const ws = ctx.workspace.active;
  const body: HealthResponse = {
    status: "ok",
    api: "v0",
    server: { version: ctx.config.serverVersion, pid: process.pid },
    engine: {
      command: ctx.config.cliCommand,
      available: probe.available,
      version: probe.version,
      nextStep: probe.nextStep,
    },
    hosts: hostHealth({
      engineAvailable: probe.available,
      ...(probe.version !== undefined ? { engineVersion: probe.version } : {}),
      env: process.env,
      ...(qoderLocal !== undefined ? { qoderLocal } : {}),
      claudeLocal,
      codex,
    }),
    workspace: ws ? { open: true, path: ws.dir } : { open: false },
  };
  sendJson(res, 200, body);
}
