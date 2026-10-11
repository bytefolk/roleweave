import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { ServerResponse } from "node:http";
import type { HealthResponse } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { probeEngine } from "../engine/probe.js";
import { runtimeExecutableEnvironment } from "../engine/process-environment.js";
import { sendJson } from "../http.js";
import { resolveClaudeExecutable } from "../claude-binary.js";
import { CODEX_DISABLED_FEATURES, openAICompatibleConfiguration, resolveCodexExecutable, validatedCodexModel } from "../codex-binary.js";
import { resolveGeminiClient, validatedGeminiModel } from "../gemini-binary.js";
import { resolveWorkbuddyExecutable } from "../workbuddy-binary.js";
import { probeWorkbuddyExecutable, workbuddyConfiguration, workbuddyVersionProfile } from "../workbuddy-runtime.js";
import { probeWorkbuddyLocal } from "../workbuddy-local.js";
import { probeQwenOfficeLocal } from "../qwen-office-local.js";
import { createLauncherSpawnSpec } from "../windows-launcher.js";
import { resolveQoderExecutable } from "../qoder-binary.js";
import { LocalProviderConfigError, resolveClaudeProviderConfig, resolveQoderProviderConfig } from "../local-provider-config.js";
import { stopQoderCatalogProbe } from "../qoder-model-catalog.js";

/** Mirrors digital-employee's claude-local model port (#184): >= 2.1.214, < 2.2.0. */
const CLAUDE_VERSION_MIN = [2, 1, 214] as const;
const CLAUDE_VERSION_MAX = [2, 2, 0] as const;
const QODER_VERSION_MAJOR = 1;
const QODER_VERSION_MIN_MINOR = 1;

export interface ClaudeLocalBinaryState {
  installed: boolean;
  version: string | null;
  supported: boolean;
}

export interface CodexBinaryState {
  installed: boolean;
  version: string | null;
  supported: boolean;
  failure?: "codex.binary_unavailable" | "codex.probe_timed_out" | "codex.unsupported_cli" | "codex.probe_output_limit";
}

export interface GeminiBinaryState {
  installed: boolean;
  version: string | null;
  client?: "gemini" | "antigravity";
}

export interface WorkbuddyBinaryState {
  installed: boolean;
  version: string | null;
  supported: boolean;
  /** Stable local reason only; never retain probe stderr or executable paths. */
  failure?: string;
}

export type QoderLocalProbeFailure = "unavailable" | "timed_out" | "unsupported_version" | "not_cli" | "unsupported_cli" | "not_authenticated" | "auth_check_failed";

export interface QoderLocalBinaryState {
  installed: boolean;
  version: string | null;
  supported: boolean;
  authenticated?: boolean;
  failure?: QoderLocalProbeFailure;
}

const QODER_VERSION_PROBE_MAX_OUTPUT = 64 * 1024;

interface VersionProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
  timedOut?: boolean;
  outputLimit?: boolean;
  detachedStreams?: boolean;
}

function killVersionProbe(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  // The probe is detached so a CLI that forks a helper cannot leave the
  // helper holding the parent's stdio open. Kill the complete disposable
  // process group on POSIX; fall back to the direct child on Windows.
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the timeout and group cleanup.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have already exited.
  }
}

function boundedAppend(current: string, chunk: Buffer | string): string {
  const remaining = QODER_VERSION_PROBE_MAX_OUTPUT - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
  return current + bytes.subarray(0, remaining).toString("utf8");
}

/**
 * Run a local `--version` probe without waiting for descendant-held stdio.
 * Some Qoder launchers fork a helper before the CLI parent exits. Node's
 * `spawnSync` waits for pipe closure in that situation and reports a false
 * timeout even though the command already returned its version.
 */
function runQoderProbe(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  platform: NodeJS.Platform,
  options: { cwd?: string; cleanupTree?: boolean } = {},
): Promise<VersionProbeResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const spec = createLauncherSpawnSpec(command, args, env, platform);
      child = spawn(spec.command, spec.args, {
        ...spec.options,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
    } catch (error) {
      resolve({ status: null, stdout: "", stderr: "", error: error as NodeJS.ErrnoException });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let outputBytes = 0;
    let outputLimit = false;
    let cleanupPromise: Promise<void> | undefined;
    let exitedCode: number | null | undefined;
    const startedAt = performance.now();
    let timer: ReturnType<typeof setTimeout>;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): Promise<void> => {
      if (options.cleanupTree) {
        cleanupPromise ??= stopQoderCatalogProbe(child, { platform });
        return cleanupPromise;
      }
      killVersionProbe(child, "SIGKILL");
      return Promise.resolve();
    };
    const finish = (result: VersionProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reapTimer !== undefined) clearTimeout(reapTimer);
      // Do not wait for `close`: a descendant may still hold these streams.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ ...result, stdout, stderr });
    };
    timer = setTimeout(() => {
      timedOut = true;
      if (options.cleanupTree) {
        void stop().finally(() => finish({ status: null, stdout: "", stderr: "", timedOut: true }));
        return;
      }
      killVersionProbe(child, "SIGKILL");
      // Normally the exit event arrives immediately after SIGKILL. Keep a
      // short fallback so a broken platform launcher cannot extend the probe
      // indefinitely, while still giving Node time to reap the direct child.
      reapTimer = setTimeout(() => {
        finish({ status: null, stdout: "", stderr: "", timedOut: true });
      }, 100);
    }, timeoutMs);
    const collect = (chunk: Buffer | string, isStdout: boolean) => {
      if (settled || outputLimit) return;
      outputBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, "utf8");
      if (options.cleanupTree && outputBytes > QODER_VERSION_PROBE_MAX_OUTPUT) {
        outputLimit = true;
        clearTimeout(timer);
        void stop().finally(() => finish({ status: null, stdout: "", stderr: "", outputLimit: true }));
        return;
      }
      if (isStdout) stdout = boundedAppend(stdout, chunk);
      else stderr = boundedAppend(stderr, chunk);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => collect(chunk, true));
    child.stderr?.on("data", (chunk: Buffer | string) => collect(chunk, false));
    child.once("error", (error) => {
      finish({
        status: null,
        stdout: "",
        stderr: "",
        error: error as NodeJS.ErrnoException,
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
    // `exit` is intentionally the completion signal. `close` also waits for
    // every inherited stdio descriptor in the descendant tree to disappear.
    child.once("exit", (code) => {
      if (options.cleanupTree) {
        if (platform === "win32" && !timedOut && !outputLimit) {
          // An exited Windows PID is no longer an owned tree root. Require
          // closed stdio before success; a surviving helper must not look ready.
          exitedCode = code;
          clearTimeout(timer);
          reapTimer = setTimeout(() => finish({ status: null, stdout: "", stderr: "", detachedStreams: true }), Math.min(100, Math.max(1, timeoutMs - (performance.now() - startedAt))));
          return;
        }
        void stop().finally(() => finish({ status: timedOut || outputLimit ? null : code, stdout: "", stderr: "", ...(timedOut ? { timedOut: true } : {}), ...(outputLimit ? { outputLimit: true } : {}) }));
        return;
      }
      killVersionProbe(child, "SIGKILL");
      finish({ status: timedOut ? null : code, stdout: "", stderr: "", ...(timedOut ? { timedOut: true } : {}) });
    });
    child.once("close", () => {
      if (options.cleanupTree && platform === "win32" && exitedCode !== undefined && !timedOut && !outputLimit) finish({ status: exitedCode, stdout: "", stderr: "" });
    });
  });
}

export interface HostHealthInput {
  engineAvailable: boolean;
  engineVersion?: string;
  /** Desktop-owned adapter boundary; never inferred from CLI version text. */
  bundledElectronEngine?: boolean;
  env: NodeJS.ProcessEnv;
  qoderLocal?: QoderLocalBinaryState;
  claudeLocal?: ClaudeLocalBinaryState;
  codex?: CodexBinaryState;
  gemini?: GeminiBinaryState;
  workbuddy?: WorkbuddyBinaryState;
  workbuddyLocal?: { configured: boolean; code: string; version?: string };
  qwenOfficeLocal?: { configured: boolean; code: string; version?: string };
  platform?: NodeJS.Platform;
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

/** Version alone is insufficient: every candidate must also pass the CLI capability probe. */
export function supportedQoderVersion(announced: string | null): boolean {
  if (announced === null) return false;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(announced);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger)
    && parts[0] === QODER_VERSION_MAJOR && parts[1]! >= QODER_VERSION_MIN_MINOR;
}

/** Exact flags used by the adapter, advertised by the native CLI's local help. */
export function supportedQoderCapabilities(help: string): boolean {
  // 1.1.51 names --output-format but does not enumerate its values in help;
  // stream-json is verified by the turn protocol, not by optional help prose.
  return [
    "--print", "--output-format", "--cwd", "--agent", "--permission-mode", "--no-session-persistence",
    "--agents", "--tools", "--strict-mcp-config", "--mcp-config", "--setting-sources", "--settings", "--model",
  ]
    .every((flag) => new RegExp(`${flag}(?=[\\s=,\\[<]|$)`).test(help))
    && /\bdont_ask\b/.test(help);
}

/**
 * Bounded, local-only preflight for the Qoder CLI used by qoder-engine.
 *
 * The CLI owns the account check via `status -o json`; the control plane keeps
 * only its logged_in boolean and never reads a credential store. CLI login
 * does not establish remote model entitlement; a real turn is still required.
 */
export async function probeQoderLocalBinary(
  env: NodeJS.ProcessEnv,
  timeoutMs = 8000,
  platform: NodeJS.Platform = process.platform,
): Promise<QoderLocalBinaryState> {
  const command = resolveQoderExecutable(env, platform);
  if (command === null) {
    return { installed: false, version: null, supported: false, failure: "unavailable" };
  }
  const startedAt = performance.now();
  const probeEnvironment = runtimeExecutableEnvironment(env);
  const probe = await runQoderProbe(command, ["--version"], probeEnvironment, timeoutMs, platform);
  if (probe.timedOut) {
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
  // The IDE launcher is also named `qoder` and prints version/hash/architecture.
  // Do not mistake its 1.20.1 editor version for a newer headless CLI.
  if (/^[a-f0-9]{40}\r?$/im.test(announced) && /^(?:x64|arm64|ia32)\r?$/m.test(announced)) {
    return { installed: true, version, supported: false, failure: "not_cli" };
  }
  if (!supportedQoderVersion(version)) {
    return { installed: true, version, supported: false, failure: "unsupported_version" };
  }
  const remainingMs = timeoutMs - (performance.now() - startedAt);
  if (remainingMs <= 0) return { installed: true, version, supported: false, failure: "timed_out" };
  const help = await runQoderProbe(command, ["--help"], probeEnvironment, remainingMs, platform);
  if (help.timedOut) return { installed: true, version, supported: false, failure: "timed_out" };
  const helpText = `${help.stdout}\n${help.stderr}`;
  if (/--install-extension\b|--locate-shell-integration-path\b/.test(helpText)) {
    return { installed: true, version, supported: false, failure: "not_cli" };
  }
  if (help.error !== undefined || help.status !== 0 || !supportedQoderCapabilities(helpText)) {
    return { installed: true, version, supported: false, failure: "unsupported_cli" };
  }
  const statusRemainingMs = timeoutMs - (performance.now() - startedAt);
  if (statusRemainingMs <= 0) return { installed: true, version, supported: true, authenticated: false, failure: "timed_out" };
  const statusEnvironment = { ...probeEnvironment };
  if (env.QODER_CONFIG_DIR) statusEnvironment.QODER_CONFIG_DIR = env.QODER_CONFIG_DIR;
  // The status command must inspect the same explicit Qoder credential the
  // turn would receive, but no other provider or control-plane credential.
  if (env.QODER_PERSONAL_ACCESS_TOKEN) statusEnvironment.QODER_PERSONAL_ACCESS_TOKEN = env.QODER_PERSONAL_ACCESS_TOKEN;
  const status = await runQoderProbe(command, ["status", "-o", "json"], statusEnvironment, statusRemainingMs, platform);
  if (status.timedOut) return { installed: true, version, supported: true, authenticated: false, failure: "timed_out" };
  let authenticated: unknown;
  if (status.error === undefined && status.status === 0) {
    try {
      const payload: unknown = JSON.parse(status.stdout);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        authenticated = (payload as { logged_in?: unknown }).logged_in;
      }
    } catch {
      // Raw status can contain account details; never expose or log it.
    }
  }
  if (typeof authenticated !== "boolean") {
    return { installed: true, version, supported: true, authenticated: false, failure: "auth_check_failed" };
  }
  return authenticated
    ? { installed: true, version, supported: true, authenticated: true }
    : { installed: true, version, supported: true, authenticated: false, failure: "not_authenticated" };
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
 * Checks the resolved executable's actual isolation flags and complete
 * feature-disable contract, without reading login stores or sending a prompt.
 * This is CLI compatibility, not a model/account or empty-tool-table claim.
 */
export async function probeCodexBinary(
  env: NodeJS.ProcessEnv,
  timeoutMs = 3000,
  platform: NodeJS.Platform = process.platform,
): Promise<CodexBinaryState> {
  const command = resolveCodexExecutable(env, platform);
  if (command === null) {
    return { installed: false, version: null, supported: false, failure: "codex.binary_unavailable" };
  }
  let temporaryRoot: string | undefined;
  let version: string | null = null;
  const deadline = performance.now() + Math.max(timeoutMs, 1);
  const failed = (failure: NonNullable<CodexBinaryState["failure"]>): CodexBinaryState => ({ installed: true, version, supported: false, failure });
  try {
    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "roleweave-codex-probe-"));
    // macOS exposes /var through /private/var. Use the same physical root for
    // cwd and every disposable environment directory.
    temporaryRoot = realpathSync(temporaryRoot);
    chmodSync(temporaryRoot, 0o700);
    const probeEnv = runtimeExecutableEnvironment(env);
    for (const [name, keys] of [
      ["home", ["HOME", "USERPROFILE"]], ["codex", ["CODEX_HOME"]],
      ["config", ["XDG_CONFIG_HOME"]], ["cache", ["XDG_CACHE_HOME"]],
      ["data", ["XDG_DATA_HOME"]], ["state", ["XDG_STATE_HOME"]],
      ["runtime", ["XDG_RUNTIME_DIR"]], ["tmp", ["TMPDIR", "TMP", "TEMP"]],
      ["appdata", ["APPDATA"]], ["local-appdata", ["LOCALAPPDATA"]],
    ] as const) {
      const directory = path.join(temporaryRoot, name);
      mkdirSync(directory, { mode: 0o700 });
      for (const key of keys) probeEnv[key] = directory;
    }
    const probe = async (args: string[]) => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return { status: null, stdout: "", stderr: "", timedOut: true } as VersionProbeResult;
      return runQoderProbe(command, args, probeEnv, remaining, platform, { cwd: temporaryRoot, cleanupTree: true });
    };
    const check = (result: VersionProbeResult): CodexBinaryState | undefined => {
      if (result.timedOut) return failed("codex.probe_timed_out");
      if (result.outputLimit) return failed("codex.probe_output_limit");
      if (result.detachedStreams) return failed("codex.unsupported_cli");
      if (Buffer.byteLength(result.stdout, "utf8") >= QODER_VERSION_PROBE_MAX_OUTPUT || Buffer.byteLength(result.stderr, "utf8") >= QODER_VERSION_PROBE_MAX_OUTPUT) return failed("codex.probe_output_limit");
      if (result.error !== undefined || result.status !== 0) return failed("codex.unsupported_cli");
      if (/unknown (?:feature(?: flag)?|configuration (?:field|key))/i.test(`${result.stdout}\n${result.stderr}`)) return failed("codex.unsupported_cli");
      return undefined;
    };
    const announced = await probe(["--version"]);
    const versionFailure = check(announced);
    if (versionFailure) return versionFailure;
    version = /(\d+\.\d+\.\d+)/.exec(announced.stdout || announced.stderr)?.[1] ?? null;
    const featureArgs = CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]);
    const help = await probe(["exec", "--strict-config", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json", ...featureArgs, "--help"]);
    const helpFailure = check(help);
    if (helpFailure) return helpFailure;
    if (!["--strict-config", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "--json"].every((flag) => new RegExp(`(?:^|[ \\t\\r\\n,])${flag}(?=[ \\t\\r\\n,=]|$)`).test(help.stdout))) return failed("codex.unsupported_cli");
    // --help can exit before feature names are validated. Execute only the
    // local feature-list command with the same complete disable switches.
    // This checks accepted names, not an effective tool table: some CLIs
    // report derived features (such as unified_exec) as true even when their
    // tool family is disabled by shell_tool. Keep every adapter switch.
    const features = await probe([...featureArgs, "features", "list"]);
    const featureFailure = check(features);
    if (featureFailure) return featureFailure;
    const rows = features.stdout.split(/\r?\n/).map((line) => line.trim().split(/[ \t]+/));
    if (!CODEX_DISABLED_FEATURES.every((feature) => {
      const matches = rows.filter((row) => row[0] === feature);
      return matches.length === 1 && matches[0]!.length >= 3 && /^(?:true|false)$/.test(matches[0]!.at(-1)!);
    })) return failed("codex.unsupported_cli");
    return { installed: true, version, supported: true };
  } catch {
    return failed("codex.binary_unavailable");
  } finally {
    if (temporaryRoot) { try { rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); } catch { /* owned disposable probe only */ } }
  }
}

/** Gemini uses the same bounded, no-shell local version preflight as Codex. */
export function probeGeminiBinary(
  env: NodeJS.ProcessEnv,
  timeoutMs = 3000,
  platform: NodeJS.Platform = process.platform,
): GeminiBinaryState {
  const resolved = resolveGeminiClient(env, platform);
  if (resolved === null) return { installed: false, version: null };
  let probe: ReturnType<typeof spawnSync>;
  const spec = createLauncherSpawnSpec(resolved.command, ["--version"], runtimeExecutableEnvironment(env), platform);
  try {
    probe = spawnSync(spec.command, spec.args, {
      ...spec.options, encoding: "utf8", killSignal: "SIGKILL", timeout: timeoutMs, windowsHide: true,
    });
  } catch {
    return { installed: false, version: null };
  }
  if (probe.error !== undefined || probe.status !== 0) return { installed: false, version: null };
  const announced = typeof probe.stdout === "string" && probe.stdout.trim()
    ? probe.stdout
    : typeof probe.stderr === "string" ? probe.stderr : "";
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(announced);
  return { installed: true, version: match ? match[1]! : null, client: resolved.client };
}

/** Exported for the #221 review B4 regression only. */
export const __codexVersionProbeSpec = (
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { command: string; args: string[]; options: Record<string, unknown> } =>
  createLauncherSpawnSpec(command, ["--version"], env, platform);

/** Version and isolation policy are shared with the actual WorkBuddy launcher. */
export function probeWorkbuddyBinary(
  env: NodeJS.ProcessEnv,
  timeoutMs = 3000,
  platform: NodeJS.Platform = process.platform,
): WorkbuddyBinaryState {
  const command = resolveWorkbuddyExecutable(env, platform);
  if (command === null) {
    return { installed: false, version: null, supported: false, failure: "workbuddy.binary_unavailable" };
  }
  const probe = probeWorkbuddyExecutable(command, env, { timeoutMs, platform });
  return {
    installed: true,
    version: probe.version ?? null,
    supported: probe.ready,
    ...(!probe.ready ? { failure: probe.code } : {}),
  };
}

function workbuddyConfigurationNextStep(code: string): string {
  if (code.includes("api_key") || code.includes("credential")) return "设置有效的 CODEBUDDY_API_KEY 服务凭据后重启工作台；个人 WorkBuddy 登录状态不会被复用";
  if (code.includes("model")) return "设置有效的 CODEBUDDY_MODEL 后重启工作台；模型标识须以字母或数字开头，仅含字母、数字及 . _ : / -，长度不超过 256";
  if (code.includes("base_url")) return "更正 CODEBUDDY_BASE_URL：使用 HTTPS，或本机回环 HTTP；地址不得包含用户名、密码、查询或片段";
  if (code.includes("internet_environment")) return "将 CODEBUDDY_INTERNET_ENVIRONMENT 设为 external、internal、ioa、selfhosted 或 cloudhosted 后重启工作台";
  return "检查 WorkBuddy 的 CODEBUDDY_API_KEY、CODEBUDDY_MODEL 与服务端点配置后重启工作台";
}

function isBundledQoderEngine(version: string | undefined): boolean {
  return typeof version === "string" && /^qoder-engine\s+\d+\.\d+\.\d+$/.test(version.trim());
}

function bundledQoderNextStep(state: QoderLocalBinaryState, engineAvailable: boolean): string | undefined {
  if (!engineAvailable) return "先修复 bundled qoder-engine 的本地启动配置";
  if (state.failure === "timed_out") {
    return "Qoder CLI 本地检查超时；检查本机进程状态，或用 ORG_WORKBENCH_QODER_BIN / DIGITAL_EMPLOYEE_QODER_COMMAND 指定可执行的 qoder/qodercli（国区版：qoderclicn）";
  }
  if (state.failure === "not_cli") {
    return "检测到 Qoder 编辑器启动命令；请安装 Qoder CLI，并将 ORG_WORKBENCH_QODER_BIN 指向 qodercli（国区版：qoderclicn）";
  }
  if (state.failure === "unsupported_cli") {
    return "当前 Qoder CLI 缺少员工对话所需的命令参数；请更新 Qoder CLI 后重试";
  }
  if (state.failure === "auth_check_failed") {
    return "无法确认 Qoder CLI 登录状态；请运行 qodercli status 检查后重试";
  }
  if (!state.installed || state.failure === "unavailable") {
    return "安装 Qoder CLI 并确保 qoder/qodercli/qoderclicn 在 PATH 上，或用 ORG_WORKBENCH_QODER_BIN / DIGITAL_EMPLOYEE_QODER_COMMAND 指定可执行文件";
  }
  if (!state.supported) {
    return state.version === null
      ? "Qoder CLI 版本无法解析；请安装 Qoder CLI 1.1.0 或更新的 1.x 版本"
      : `Qoder CLI 版本 ${state.version} 不受支持；请安装 Qoder CLI 1.1.0 或更新的 1.x 版本`;
  }
  if (state.authenticated !== true) return "Qoder CLI 尚未登录；点击对话输入框的「一键登录」完成浏览器授权，或手动运行 qodercli login";
  return undefined;
}

export function hostHealth({
  engineAvailable,
  engineVersion,
  bundledElectronEngine = false,
  env,
  qoderLocal = { installed: false, version: null, supported: false, failure: "unavailable" },
  claudeLocal = { installed: false, version: null, supported: false },
  codex = { installed: false, version: null, supported: false },
  gemini = { installed: false, version: null },
  workbuddy = { installed: false, version: null, supported: false },
  workbuddyLocal = { configured: false, code: "workbuddy.client_unavailable" },
  qwenOfficeLocal = { configured: false, code: "qwen_office.client_unavailable" },
  platform = process.platform,
}: HostHealthInput): HealthResponse["hosts"] {
  const bundledQoder = isBundledQoderEngine(engineVersion);
  const qoderServiceTokenConfigured = typeof env.QODER_PERSONAL_ACCESS_TOKEN === "string" && env.QODER_PERSONAL_ACCESS_TOKEN.length > 0;
  const qoderConfigured = bundledQoder ? qoderLocal.supported && qoderLocal.authenticated === true : qoderServiceTokenConfigured;
  const qoderNextStep = bundledQoderNextStep(qoderLocal, engineAvailable);
  const claudeConfigured = Boolean(env.ANTHROPIC_API_KEY?.trim() || (bundledElectronEngine && env.ANTHROPIC_AUTH_TOKEN?.trim()));
  const claudeLocalConfigured = claudeLocal.installed && claudeLocal.supported;
  const openaiConfigured = Boolean(env.OPENAI_API_KEY?.trim()) && Boolean(env.OPENAI_BASE_URL?.trim());
  // Both Codex Hosts require the desktop-owned bundled adapter: the external
  // digital-employee CLI only probes Codex and has no executable model port.
  // Neither Codex Host has a supported-version window to gate on. The two
  // differ only in how the provider is reached: `codex` requires an explicit
  // service credential, while `codex-local` runs on the operator's own Codex
  // login and must never be gated on — or handed — a credential, exactly as
  // claude-local is not gated on ANTHROPIC_API_KEY. Login state itself is
  // asserted by the engine at run time; no credential store is inspected here.
  const codexProviderConfigured = typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0;
  // Both Codex Hosts spawn with --ignore-user-config, so the operator's
  // config.toml model is not read and OPENAI_MODEL is the only pin the control
  // plane has. Unset is a legitimate state, not a misconfiguration: Codex then
  // chooses for itself and reports the choice nowhere the control plane can
  // read, so no model is claimed rather than one being inferred.
  //
  // #238 review: this shares the engine's validator rather than mirroring it.
  // A preflight stricter than the enforcement point would call a working
  // OPENAI_MODEL illegal, and no suite on either side could see the drift.
  const codexModel = validatedCodexModel(env.OPENAI_MODEL);
  const codexModelUsable = codexModel !== null;
  // #238 review: `modelPinnable` is a property of the Host, not of readiness,
  // so it is stated even when the binary or credential is missing. It is what
  // lets a client render the model row only where a knob exists, instead of
  // carrying its own list of which engines have one.
  const codexModelHealth = {
    modelPinnable: true,
    ...(typeof codexModel === "string" ? { model: codexModel } : {}),
  };
  const codexModelNextStep = "OPENAI_MODEL 不是合法的模型标识（首字符为字母或数字，其余限 A-Z a-z 0-9 . _ : / -，长度 ≤ 256）；请更正或清空后重启工作台";
  const codexConfigured = codex.installed && codex.supported && codexProviderConfigured && codexModelUsable;
  const codexLocalConfigured = codex.installed && codex.supported && codexModelUsable;
  const codexCliNextStep = codex.failure === "codex.probe_timed_out"
    ? "Codex CLI 本地能力检查超时，请检查安装后重新刷新。"
    : "当前 Codex CLI 不支持 RoleWeave 需要的功能开关，请升级 CLI 或通过 DIGITAL_EMPLOYEE_CODEX_COMMAND 明确指定兼容安装。";
  const geminiModel = validatedGeminiModel(env.GEMINI_MODEL);
  const geminiModelUsable = geminiModel !== null;
  // Both supported Google clients can reuse a cached local account in
  // headless mode. As with codex-local and claude-local, health checks only
  // local prerequisites; the first real turn remains the authentication and
  // entitlement proof. GEMINI_API_KEY is an optional alternate connection.
  const geminiConfigured = gemini.installed && geminiModelUsable;
  const claudeCodeConfigured = bundledQoder
    ? (claudeLocal.installed && claudeLocal.supported && claudeConfigured)
    : claudeConfigured;
  return {
    qoder: {
      configured: qoderConfigured,
      ready: engineAvailable && qoderConfigured,
      // The one-click login flow can only help when the binary itself is fine
      // and the sole blocker is the missing account login; every other failure
      // keeps pointing at its own repair path.
      ...(bundledQoder && qoderLocal.supported && qoderLocal.authenticated === false && qoderLocal.failure === "not_authenticated"
        ? { loginRequired: true }
        : {}),
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
                ? { nextStep: "设置 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN；已有本地配置可使用 Claude Code 本地连接" }
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
      ready: bundledElectronEngine && engineAvailable && codexConfigured,
      ...codexModelHealth,
      ...(!bundledElectronEngine
        ? { nextStep: "Codex 仅支持 RoleWeave 内置 bundled qoder-engine；当前外部引擎无法执行 Codex 回合" }
        : !codex.installed
          ? { nextStep: "安装 Codex CLI 并确保 codex 在 PATH 上（或用 DIGITAL_EMPLOYEE_CODEX_COMMAND 指定二进制路径）" }
          : !codex.supported
            ? { nextStep: codexCliNextStep }
          : !codexProviderConfigured
            ? { nextStep: "设置 OPENAI_API_KEY（如需自建或中转端点，另设 OPENAI_BASE_URL）后重启工作台；若要用 Codex 订阅登录，请改选 Codex（本地登录）" }
            : !codexModelUsable
              ? { nextStep: codexModelNextStep }
              : !engineAvailable
                ? { nextStep: "先修复 bundled qoder-engine 的本地启动配置" }
                : {}),
    },
    "codex-local": {
      configured: codexLocalConfigured,
      ready: bundledElectronEngine && engineAvailable && codexLocalConfigured,
      ...codexModelHealth,
      ...(!bundledElectronEngine
        ? { nextStep: "Codex 仅支持 RoleWeave 内置 bundled qoder-engine；当前外部引擎无法执行 Codex 回合" }
        : !codex.installed
          ? { nextStep: "安装 Codex CLI 并确保 codex 在 PATH 上（或用 DIGITAL_EMPLOYEE_CODEX_COMMAND 指定二进制路径）" }
          : !codex.supported
            ? { nextStep: codexCliNextStep }
          : !codexModelUsable
            ? { nextStep: codexModelNextStep }
            : !engineAvailable
              ? { nextStep: "先修复 bundled qoder-engine 的本地启动配置" }
              : {}),
    },
    "workbuddy-local": {
      configured: workbuddyLocal.configured,
      ready: bundledElectronEngine && engineAvailable && workbuddyLocal.configured,
      modelPinnable: false,
      localProbe: { installed: workbuddyLocal.configured, supported: workbuddyLocal.configured, version: workbuddyLocal.version ?? null, ...(!workbuddyLocal.configured ? { failure: workbuddyLocal.code } : {}) },
      connection: { source: "official", kind: "official", billing: "unknown", status: workbuddyLocal.configured ? "configured" : "invalid" },
      ...(!bundledElectronEngine || !engineAvailable
        ? { nextStep: "WorkBuddy 本地登录需要 RoleWeave 内置引擎，请恢复内置引擎后重试。" }
        : !workbuddyLocal.configured ? { nextStep: "打开 WorkBuddy 客户端并完成登录，再刷新连接。" } : {}),
    },
    "qwen-office-local": {
      configured: qwenOfficeLocal.configured,
      ready: bundledElectronEngine && engineAvailable && qwenOfficeLocal.configured,
      modelPinnable: false,
      localProbe: { installed: qwenOfficeLocal.configured, supported: qwenOfficeLocal.configured, version: qwenOfficeLocal.version ?? null,
        ...(!qwenOfficeLocal.configured ? { failure: qwenOfficeLocal.code } : {}) },
      connection: { source: "official", kind: "official", billing: "unknown", status: qwenOfficeLocal.configured ? "configured" : "invalid" },
      ...(!bundledElectronEngine || !engineAvailable
        ? { nextStep: "千问办公需要 RoleWeave 内置引擎，请恢复内置引擎后重试。" }
        : !qwenOfficeLocal.configured ? { nextStep: "打开并登录千问办公，启用客户端本地控制接口后刷新。工具和审批由千问办公管理。" } : {}),
    },
    workbuddy: (() => {
      // Health describes local configuration, not authentication, model quota,
      // or a completed turn. Per-turn model overrides are not server defaults.
      const configuration = workbuddyConfiguration({ ...env, ROLEWEAVE_TURN_MODEL: undefined });
      const profile = workbuddyVersionProfile(workbuddy.version ?? "");
      const configured = workbuddy.installed && workbuddy.supported && profile !== null && configuration.ready;
      let nextStep: string | undefined;
      if (!bundledElectronEngine || !engineAvailable) {
        nextStep = "WorkBuddy 需要 RoleWeave 内置 bundled qoder-engine；请恢复内置引擎或修复其本地启动配置";
      } else if (platform === "win32" || workbuddy.failure?.includes("platform_not_verified")) {
        nextStep = "WorkBuddy Windows 进程树清理尚未完成验证，当前禁止派活；请使用受支持的 macOS/Linux CLI，等待 Windows 验证完成后更新 RoleWeave";
      } else if (!workbuddy.installed) {
        nextStep = "安装 WorkBuddy / CodeBuddy Code CLI，或将 DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND 指向桌面安装目录中 app.asar.unpacked/cli/bin/codebuddy；然后重启工作台";
      } else if (!workbuddy.supported || profile === null) {
        nextStep = workbuddy.failure?.includes("timed_out")
          ? "WorkBuddy CLI 本地版本探测超时；检查本机进程，或用 DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND 指定可执行 CLI 后重启"
          : "安装已审计的 CodeBuddy Code CLI 2.106.4 或 2.137.1；用 DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND 指定该 CLI 后重启工作台";
      } else if (!configuration.ready) {
        nextStep = workbuddyConfigurationNextStep(configuration.code);
      }
      return {
        configured,
        ready: configured && nextStep === undefined,
        modelPinnable: true,
        ...(configuration.ready && configuration.model ? { model: configuration.model } : {}),
        ...(nextStep ? { nextStep } : {}),
      };
    })(),
    gemini: {
      configured: geminiConfigured,
      ready: bundledElectronEngine && engineAvailable && geminiConfigured,
      modelPinnable: true,
      ...(typeof geminiModel === "string" ? { model: geminiModel } : {}),
      localProbe: { installed: gemini.installed, supported: gemini.installed, version: gemini.version },
      ...(!bundledElectronEngine
        ? { nextStep: "Gemini 仅支持 RoleWeave 内置 bundled qoder-engine；当前外部引擎无法执行 Gemini 回合" }
        : !gemini.installed
          ? { nextStep: "安装 Gemini CLI（gemini）或 Antigravity CLI（agy）并确保它在 PATH 上；也可用 DIGITAL_EMPLOYEE_GEMINI_COMMAND 指定兼容客户端" }
          : !geminiModelUsable
              ? { nextStep: "GEMINI_MODEL 不是合法的模型标识（首字符为字母或数字，其余限 A-Z a-z 0-9 . _ : / -，长度 ≤ 256）；请更正或清空后重启工作台" }
              : !engineAvailable
                ? { nextStep: "先修复 bundled qoder-engine 的本地启动配置" }
                : {}),
    },
    "openai-compatible": (() => {
      // A user-supplied OpenAI-compatible gateway needs no local CLI login:
      // the engine forwards OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
      // directly. The external digital-employee CLI has no equivalent port,
      // so a provider trio alone must never make that path look runnable.
      const configuration = openAICompatibleConfiguration(env);
      const configured = configuration.ready;
      let nextStep: string | undefined;
      if (!configuration.ready) {
        if (configuration.code === "openai.api_key_missing") {
          nextStep = "设置 OPENAI_API_KEY 后重启工作台";
        } else if (configuration.code === "openai.base_url_missing") {
          nextStep = "设置 OPENAI_BASE_URL 指向 OpenAI 兼容端点后重启工作台";
        } else if (configuration.code === "openai.model_missing") {
          nextStep = "设置 OPENAI_MODEL 为端点提供的模型标识后重启工作台";
        } else {
          nextStep = "更正 OpenAI Compatible 配置：密钥、HTTPS（或回环 HTTP）端点和模型标识必须完整且合法";
        }
      } else if (!bundledElectronEngine) {
        nextStep = "OpenAI Compatible 仅支持 RoleWeave 内置 bundled qoder-engine；当前外部引擎无法执行该回合";
      } else if (!engineAvailable) {
        nextStep = "先修复 bundled qoder-engine 的本地启动配置";
      }
      return {
        configured,
        ready: bundledElectronEngine && engineAvailable && configured,
        modelPinnable: true,
        ...(configuration.ready && configuration.model ? { model: configuration.model } : {}),
        ...(nextStep ? { nextStep } : {}),
      };
    })(),
  };
}

/** Only selected provider/model metadata may cross the HTTP boundary. */
export function applyLocalProviderHealth(hosts: HealthResponse["hosts"], env: NodeJS.ProcessEnv): HealthResponse["hosts"] {
  const result = { ...hosts };
  for (const engine of ["claude-local", "claude-code", "qoder"] as const) {
    try {
      const provider = engine === "qoder"
        ? resolveQoderProviderConfig(env)
        : resolveClaudeProviderConfig(env, { local: engine === "claude-local" });
      result[engine] = { ...hosts[engine], connection: provider.connection, modelPinnable: true,
        ...(provider.selectedDefault ? { model: provider.selectedDefault } : {}) };
    } catch (error) {
      if (!(error instanceof LocalProviderConfigError)) throw error;
      result[engine] = { ...hosts[engine], ready: false, nextStep: error.message,
        connection: { source: "local-config", kind: "gateway", billing: "unknown", status: "invalid", message: error.message } };
    }
  }
  return result;
}

export async function handleHealth(ctx: ControlPlaneContext, res: ServerResponse): Promise<void> {
  const probe = await probeEngine(ctx.config.cliCommand, 5000, {
    bundledElectronEngine: ctx.config.bundledElectronEngine,
  });
  const claudeLocal = probeClaudeLocalBinary(process.env);
  const codex = await probeCodexBinary(process.env);
  const gemini = probeGeminiBinary(process.env);
  const workbuddy = probeWorkbuddyBinary(process.env);
  const workbuddyLocal = ctx.config.bundledElectronEngine ? await probeWorkbuddyLocal(process.env) : undefined;
  const qwenOfficeLocal = ctx.config.bundledElectronEngine ? await probeQwenOfficeLocal(process.env) : undefined;
  const qoderLocal = isBundledQoderEngine(probe.version)
    ? await probeQoderLocalBinary(process.env)
    : undefined;
  const ws = ctx.workspace.active;
  const hosts = hostHealth({
    engineAvailable: probe.available,
    bundledElectronEngine: ctx.config.bundledElectronEngine,
    ...(probe.version !== undefined ? { engineVersion: probe.version } : {}),
    env: process.env,
    ...(qoderLocal !== undefined ? { qoderLocal } : {}),
    claudeLocal,
    codex,
    gemini,
    workbuddy,
    ...(workbuddyLocal ? { workbuddyLocal } : {}),
    ...(qwenOfficeLocal ? { qwenOfficeLocal } : {}),
  });
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
    hosts: ctx.config.bundledElectronEngine ? applyLocalProviderHealth(hosts, process.env) : hosts,
    workspace: ws ? { open: true, path: ws.dir } : { open: false },
  };
  sendJson(res, 200, body);
}
