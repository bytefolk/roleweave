import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isModelId, type EmployeeModelOption } from "@roleweave/shared";
import { resolveCodexExecutable } from "./codex-binary.js";
import { runtimeExecutableEnvironment } from "./engine/process-environment.js";
import { stopQoderCatalogProbe as stopCatalogProbe } from "./qoder-model-catalog.js";
import { createLauncherSpawnSpec } from "./windows-launcher.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_MODELS = 256;
const MAX_IDENTITIES = 16;

export interface CodexModelCatalogResult {
  status: "ready" | "stale" | "unavailable";
  options: EmployeeModelOption[];
  recommended?: string;
}

export function codexModelTier(id: string): EmployeeModelOption["tier"] {
  return /luna|mini|spark/i.test(id) ? "economy" : /astra|pro|opus/i.test(id) ? "powerful" : "balanced";
}

/** Only initializes the protocol and lists models. Never starts a thread or turn. */
export function queryCodexModelCatalog(command: string, env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<Omit<CodexModelCatalogResult, "status"> | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const spec = createLauncherSpawnSpec(command, ["app-server", "--listen", "stdio://", "-c", "analytics.enabled=false"], env);
      child = spawn(spec.command, spec.args, { ...spec.options, cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    } catch { resolve(null); return; }
    let settled = false;
    let bytes = 0;
    let buffer = "";
    let requestId = 1;
    let pages = 0;
    let recommended: string | undefined;
    const cursors = new Set<string>();
    const options: EmployeeModelOption[] = [];
    const finish = (result: Omit<CodexModelCatalogResult, "status"> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void stopCatalogProbe(child).finally(() => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve(result);
      });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (message: object) => child.stdin?.write(JSON.stringify(message) + "\n");
    const list = (cursor?: string) => {
      requestId++;
      send({ id: requestId, method: "model/list", params: { limit: 64, includeHidden: false, ...(cursor ? { cursor } : {}) } });
    };
    child.stdin?.on("error", () => finish(null));
    child.once("error", () => finish(null));
    child.once("close", () => finish(null));
    child.stderr?.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_OUTPUT_BYTES) finish(null); });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) { finish(null); return; }
      buffer += chunk;
      let newline: number;
      while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (!message || typeof message !== "object") { finish(null); return; }
          if (message.id !== requestId) continue; // Notifications are not responses.
          if (message.error || !message.result) { finish(null); return; }
          if (requestId === 1) {
            send({ method: "initialized" });
            list();
            continue;
          }
          const { data, nextCursor } = message.result;
          if (!Array.isArray(data) || data.length > MAX_MODELS || ++pages > 16) { finish(null); return; }
          for (const model of data) {
            if (!model || typeof model !== "object") { finish(null); return; }
            if (model.hidden === true) continue;
            // `model` is the inference selector; `id` can be a catalog row ID.
            const id = model.model ?? model.id;
            if (!isModelId(id)) { finish(null); return; }
            if (options.some((option) => option.id === id)) continue;
            options.push({ id, name: typeof model.displayName === "string" ? model.displayName.slice(0, 100) : id, tier: codexModelTier(id) });
            if (model.isDefault === true) recommended ??= id;
            if (options.length > MAX_MODELS) { finish(null); return; }
          }
          if (nextCursor == null) { finish({ options, ...(recommended ? { recommended } : {}) }); return; }
          if (typeof nextCursor !== "string" || !nextCursor || nextCursor.length > 4096 || cursors.has(nextCursor)) { finish(null); return; }
          cursors.add(nextCursor);
          list(nextCursor);
        } catch { finish(null); return; }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "roleweave", title: "RoleWeave", version: "0.5.0" } } });
  });
}

function fingerprint(file: string): string {
  try { const stat = statSync(file); return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"); }
  catch { return "missing"; }
}

type CatalogEntry = { result: CodexModelCatalogResult; expiresAt: number; successfulAt?: number };

export class CodexModelCatalog {
  private readonly cache = new Map<string, CatalogEntry>();
  private readonly pending = new Map<string, Promise<CodexModelCatalogResult>>();
  constructor(private readonly settings: { query?: typeof queryCodexModelCatalog; now?: () => number; ttlMs?: number; retryMs?: number; staleMs?: number } = {}) {}

  async read(env: NodeJS.ProcessEnv, mode: "refresh" | "cached" = "refresh", engine: "codex" | "codex-local" = "codex-local"): Promise<CodexModelCatalogResult> {
    const unavailable: CodexModelCatalogResult = { status: "unavailable", options: [] };
    const command = resolveCodexExecutable(env);
    if (!command) return unavailable;
    const environment = runtimeExecutableEnvironment(env);
    for (const key of ["CODEX_HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
      if (env[key] !== undefined) environment[key] = env[key];
    }
    if (engine === "codex") {
      for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL"]) if (env[key] !== undefined) environment[key] = env[key];
    }
    const home = path.resolve(env.CODEX_HOME ?? path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".codex"));
    // Metadata only: account changes and CLI upgrades invalidate the short cache.
    const key = createHash("sha256").update(JSON.stringify([command, fingerprint(command), environment, home, fingerprint(path.join(home, "auth.json")), fingerprint(path.join(home, "config.toml"))])).digest("hex");
    const now = this.settings.now ?? Date.now;
    const cached = this.cache.get(key);
    const timestamp = now();
    const staleUntil = (cached?.successfulAt ?? -Infinity) + (this.settings.staleMs ?? 300_000);
    if (cached && cached.expiresAt > timestamp) return structuredClone(cached.result);
    // Model saves must not start or await a subprocess under the mutation lock.
    if (mode === "cached") return cached && timestamp < staleUntil
      ? { ...structuredClone(cached.result), status: "stale" } : unavailable;
    const pending = this.pending.get(key);
    if (pending) return structuredClone(await pending);
    if (this.pending.size >= MAX_IDENTITIES) return unavailable;
    const work = (async (): Promise<CodexModelCatalogResult> => {
      let models: Awaited<ReturnType<typeof queryCodexModelCatalog>> = null;
      try { models = await (this.settings.query ?? queryCodexModelCatalog)(command, environment); } catch { /* Fall back without exposing CLI diagnostics. */ }
      const timestamp = now();
      const result: CodexModelCatalogResult = models ? { status: "ready", ...models }
        : cached?.successfulAt !== undefined && timestamp < staleUntil ? { ...cached.result, status: "stale" } : unavailable;
      this.cache.delete(key);
      const expiresAt = timestamp + (models ? this.settings.ttlMs ?? 30_000 : this.settings.retryMs ?? 5000);
      this.cache.set(key, { result, expiresAt: result.status === "stale" ? Math.min(expiresAt, staleUntil) : expiresAt, successfulAt: models ? timestamp : cached?.successfulAt });
      while (this.cache.size > MAX_IDENTITIES) this.cache.delete(this.cache.keys().next().value!);
      return result;
    })();
    this.pending.set(key, work);
    try { return structuredClone(await work); }
    finally { if (this.pending.get(key) === work) this.pending.delete(key); }
  }
}

export const codexModelCatalog = new CodexModelCatalog();
