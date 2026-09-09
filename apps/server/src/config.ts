import fs from "node:fs";
import { createBootToken } from "./auth.js";

export interface ServerConfig {
  /** Loopback only, always. The control plane never binds another interface. */
  host: "127.0.0.1";
  /** 0 = ephemeral port (shell reads the actual port from the ready line). */
  port: number;
  token: string;
  /** Pinned digital-employee CLI command consumed via spawn. */
  cliCommand: string;
  /** Desktop-owned Electron adapter boundary; never inferred from CLI text. */
  bundledElectronEngine: boolean;
  /** Spawn timeout (ms) for engine org apply / turn run. */
  engineTimeoutMs?: number;
  /** Workspace-wide daily token allocation ceiling for deterministic hiring. */
  budgetPoolTokens?: number;
  /** Pinned context provider CLI/stdio adapter command (context main >= f63f57f). */
  contextCliCommand: string;
  serverVersion: string;
  /**
   * External `bytefolk/doc` origin (#35 R2 MVP). When the URL or Bearer PAT
   * is unset, the doc-plane proxy fails closed with `doc_plane_unconfigured`.
   * Trailing slashes are stripped.
   */
  docPlaneUrl?: string;
  /** Bearer PAT for the external doc plane (bytefolk/doc `doc_pat_...`). */
  docPlaneToken?: string;
  /**
   * When truthy the proxy responds with a bundled mock fixture instead of
   * calling the upstream. Used for demos and the end-to-end vitest wiring.
   * TODO(#35 R3): remove once the upstream API surface stabilises.
   */
  docPlaneMock: boolean;
}

function normalizeUrl(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return trimmed.replace(/\/+$/u, "");
}

function truthy(raw: string | undefined): boolean {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === "1" || trimmed === "true" || trimmed === "yes" || trimmed === "on";
}

export function resolveServerConfig(
  env: NodeJS.ProcessEnv,
  argv: string[],
): ServerConfig {
  let port = 0;
  const argPortIndex = argv.indexOf("--port");
  const rawPort = argPortIndex >= 0 ? argv[argPortIndex + 1] : env.ORG_WORKBENCH_SERVER_PORT;
  if (rawPort !== undefined) {
    const parsed = Number.parseInt(String(rawPort), 10);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 65535) port = parsed;
  }
  const envToken = env.ORG_WORKBENCH_BOOT_TOKEN;
  const token =
    typeof envToken === "string" && envToken.length >= 16 ? envToken : createBootToken();
  const cliCommand = env.ORG_WORKBENCH_DIGITAL_EMPLOYEE_CLI ?? "digital-employee";
  const bundledElectronEngine =
    env.ORG_WORKBENCH_INTERNAL_BUNDLED_ELECTRON_ENGINE === "1" &&
    env.ELECTRON_RUN_AS_NODE === "1";
  const contextCliCommand = env.ORG_WORKBENCH_CONTEXT_CLI ?? "context";
  const rawBudgetPool = Number(env.ORG_WORKBENCH_BUDGET_POOL_TOKENS ?? "10000000");
  const budgetPoolTokens = Number.isSafeInteger(rawBudgetPool) && rawBudgetPool > 0
    ? Math.min(rawBudgetPool, 1_000_000_000)
    : 10_000_000;
  return {
    host: "127.0.0.1",
    port,
    token,
    cliCommand,
    bundledElectronEngine,
    contextCliCommand,
    budgetPoolTokens,
    serverVersion: readServerVersion(),
    docPlaneUrl: normalizeUrl(env.ORG_WORKBENCH_DOC_URL),
    docPlaneToken:
      typeof env.ORG_WORKBENCH_DOC_TOKEN === "string" && env.ORG_WORKBENCH_DOC_TOKEN.length > 0
        ? env.ORG_WORKBENCH_DOC_TOKEN
        : undefined,
    docPlaneMock: truthy(env.ORG_WORKBENCH_DOC_MOCK),
  };
}

function readServerVersion(): string {
  try {
    const raw = fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
