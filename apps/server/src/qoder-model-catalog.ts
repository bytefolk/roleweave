import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isModelId, isQoderModelId, type EmployeeModelOption } from "@roleweave/shared";
import { runtimeExecutableEnvironment } from "./engine/process-environment.js";
import { resolveQoderExecutable } from "./qoder-binary.js";
import { createLauncherSpawnSpec } from "./windows-launcher.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_MODELS = 256;
const MAX_IDENTITIES = 16;
const TIER_NAMES = new Set(["auto", "ultimate", "performance", "efficient", "lite"]);

export interface QoderModelCatalogResult {
  status: "ready" | "stale" | "unavailable";
  options: EmployeeModelOption[];
}

/** Qoder CLI 1.1.53 documents names for Default/New Models and IDs for Custom.
 * Its --list-models output is a single MODEL column, even with -o json.
 * Unknown output formats fail closed instead of guessing IDs or prices. */
export function parseQoderModelCatalog(output: string): EmployeeModelOption[] | null {
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) return null;
  const lines = output.replace(/\u001b\[[0-9;]*m/g, "").trim().split(/\r?\n/).map((line) => line.trim());
  if (lines.shift() !== "MODEL" || lines.length === 0 || lines.length > MAX_MODELS) return null;
  const options: EmployeeModelOption[] = [];
  for (const line of lines) {
    // The CLI prints registered Custom selectors as "Display name (mode-ID)".
    const custom = /^(.+?) \((mode-[A-Za-z0-9-]+|custom\/[^()]+)\)$/.exec(line);
    const id = custom?.[2] ?? line;
    const name = custom?.[1] ?? line;
    if (!isQoderModelId(id) || !isQoderModelId(name) || (!custom && !isModelId(id))) return null;
    if (options.some((option) => option.id === id)) continue;
    options.push({
      id, name: name.slice(0, 100), tier: "default",
      group: custom ? "custom" : TIER_NAMES.has(id.toLowerCase()) ? "tiers" : "models",
      // A registered Custom selector does not reveal its provider or billing.
      billing: custom ? "unknown" : "qoder",
    });
  }
  return options.length ? options : null;
}

/** Windows .cmd launchers own a CLI child; terminate the tree before its
 * parent disappears. The cleanup command never inherits provider credentials. */
export function stopQoderCatalogProbe(child: ReturnType<typeof spawn>, {
  platform = process.platform, systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR ?? "C:\\Windows", spawnImpl = spawn,
}: { platform?: NodeJS.Platform; systemRoot?: string; spawnImpl?: typeof spawn } = {}): Promise<void> {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 1 || pid === process.pid) return Promise.resolve();
  const killParent = () => { try { child.kill("SIGKILL"); } catch { /* Already gone. */ } };
  if (platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); } catch { /* The process group already exited. */ }
    return Promise.resolve();
  }
  // A launcher that exits before its children releases this PID. It is no
  // longer an owned tree root and may have been reused by an unrelated process.
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  if (!/^[A-Za-z]:[\\/]/.test(systemRoot) || /[\0\r\n]/.test(systemRoot)) { killParent(); return Promise.resolve(); }
  return new Promise((resolve) => {
    let killer: ReturnType<typeof spawn>;
    try {
      killer = spawnImpl(path.win32.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
        shell: false, windowsHide: true, stdio: "ignore", env: { SystemRoot: systemRoot, WINDIR: systemRoot },
      });
    } catch { killParent(); resolve(); return; }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killParent();
      resolve();
    };
    const timer = setTimeout(() => { try { killer.kill("SIGKILL"); } catch { /* Already gone. */ } finish(); }, 1000);
    killer.once("error", finish);
    killer.once("exit", finish);
  });
}

/** Read-only account catalog. No prompt, shell, credential-store read or raw diagnostics. */
// Account catalog refresh can take several seconds even on an installed CLI.
// Only GET refreshes wait here; mutations use the cache-only path below.
export function queryQoderModelCatalog(command: string, env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const args = ["--list-models", ...(env.QODER_CONFIG_DIR ? ["--config-dir", env.QODER_CONFIG_DIR] : [])];
      const spec = createLauncherSpawnSpec(command, args, env);
      child = spawn(spec.command, spec.args, { ...spec.options, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    } catch { resolve(null); return; }
    let bytes = 0;
    const output: Buffer[] = [];
    let settled = false;
    let failed = false;
    let termination: Promise<void> | undefined;
    const stop = () => termination ??= stopQoderCatalogProbe(child);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (failed || code !== 0) { resolve(null); return; }
      try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(output))); }
      catch { resolve(null); }
    };
    const abort = () => {
      if (failed || settled) return;
      failed = true;
      void stop().finally(() => finish(null));
    };
    const timer = setTimeout(abort, timeoutMs);
    const collect = (chunk: Buffer | string, retain: boolean) => {
      if (failed || settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_OUTPUT_BYTES) { abort(); return; }
      if (retain) output.push(buffer);
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, false));
    child.once("error", () => { failed = true; finish(null); });
    child.once("exit", () => { if (process.platform !== "win32") void stop(); });
    child.once("close", (code) => { if (failed) void stop().finally(() => finish(null)); else finish(code); });
  });
}

function fingerprint(file: string, directory = false): string {
  try {
    const stat = statSync(file);
    // CLI log/cache writes may change directory timestamps on every read.
    return (directory ? [stat.dev, stat.ino] : [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]).join(":");
  } catch { return "missing"; }
}

function catalogScope(env: NodeJS.ProcessEnv): { key: string; command: string; environment: NodeJS.ProcessEnv } | null {
  const command = resolveQoderExecutable(env);
  if (!command) return null;
  const environment = runtimeExecutableEnvironment(env);
  for (const key of ["USERPROFILE", "QODER_PERSONAL_ACCESS_TOKEN"] as const) {
    if (env[key] !== undefined) environment[key] = env[key];
  }
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const configDir = path.resolve(env.QODER_CONFIG_DIR || path.join(home, ".qoder"));
  if (env.QODER_CONFIG_DIR) environment.QODER_CONFIG_DIR = configDir;
  // These are metadata fingerprints only. In particular, no encrypted account
  // cache or credentials are inspected. Token material stays inside this hash.
  const key = createHash("sha256").update(JSON.stringify([
    command, fingerprint(command), environment, configDir,
    fingerprint(configDir, true), fingerprint(path.join(configDir, "settings.json")),
  ])).digest("hex");
  return { key, command, environment };
}

type CatalogEntry = { result: QoderModelCatalogResult; expiresAt: number; successfulAt?: number };

export class QoderModelCatalog {
  private readonly cache = new Map<string, CatalogEntry>();
  private readonly pending = new Map<string, Promise<QoderModelCatalogResult>>();
  constructor(private readonly settings: {
    now?: () => number;
    query?: typeof queryQoderModelCatalog;
    ttlMs?: number;
    retryMs?: number;
    staleMs?: number;
  } = {}) {}

  async read(env: NodeJS.ProcessEnv, mode: "refresh" | "cached" = "refresh"): Promise<QoderModelCatalogResult> {
    const scope = catalogScope(env);
    if (!scope) return { status: "unavailable", options: [] };
    const now = this.settings.now ?? Date.now;
    const cached = this.cache.get(scope.key);
    const timestamp = now();
    const staleUntil = (cached?.successfulAt ?? -Infinity) + (this.settings.staleMs ?? 300_000);
    if (cached && cached.expiresAt > timestamp) return structuredClone(cached.result);
    // Mutation handlers never start or await a provider process while holding
    // an employee execution reservation. A subsequent card GET can refresh it.
    if (mode === "cached") return cached && staleUntil > timestamp
      ? { status: "stale", options: structuredClone(cached.result.options) }
      : { status: "unavailable", options: [] };
    const pending = this.pending.get(scope.key);
    if (pending) return structuredClone(await pending);
    if (this.pending.size >= MAX_IDENTITIES) return { status: "unavailable", options: [] };
    const query = this.settings.query ?? queryQoderModelCatalog;
    const work = (async () => {
      let models: EmployeeModelOption[] | null = null;
      try {
        const output = await query(scope.command, scope.environment);
        if (output !== null) models = parseQoderModelCatalog(output);
      } catch { /* Catalog failure must preserve the existing model fallback. */ }
      const timestamp = now();
      const canUseStale = cached?.successfulAt !== undefined && timestamp < staleUntil;
      const result: QoderModelCatalogResult = models ? { status: "ready", options: models }
        : canUseStale ? { status: "stale", options: cached.result.options }
          : { status: "unavailable", options: [] };
      this.cache.delete(scope.key);
      const expiresAt = timestamp + (models ? this.settings.ttlMs ?? 30_000 : this.settings.retryMs ?? 5000);
      this.cache.set(scope.key, { result, expiresAt: result.status === "stale" ? Math.min(expiresAt, staleUntil) : expiresAt, successfulAt: models ? timestamp : cached?.successfulAt });
      while (this.cache.size > MAX_IDENTITIES) this.cache.delete(this.cache.keys().next().value!);
      return result;
    })();
    this.pending.set(scope.key, work);
    try { return structuredClone(await work); }
    finally { if (this.pending.get(scope.key) === work) this.pending.delete(scope.key); }
  }
}

export const qoderModelCatalog = new QoderModelCatalog();
