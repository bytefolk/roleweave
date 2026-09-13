import type { TurnEngine, TurnEngineAvailability } from "./types";

/**
 * The three products operators choose between. The five `TurnEngine` values
 * remain an implementation detail because the local-login and service
 * variants have different credential and process-isolation requirements.
 */
export const AGENT_HOSTS = ["qoder", "claude-code", "codex"] as const;

export type AgentHost = (typeof AGENT_HOSTS)[number];

export const AGENT_HOST_LABEL: Record<AgentHost, string> = {
  qoder: "Qoder",
  "claude-code": "Claude Code",
  codex: "Codex",
};

const RUNTIME_CANDIDATES: Record<AgentHost, readonly TurnEngine[]> = {
  qoder: ["qoder"],
  // Prefer the locally signed-in client when it is ready. This matches the
  // desktop setup most operators use while the choice remains “Claude Code”.
  "claude-code": ["claude-local", "claude-code"],
  codex: ["codex-local", "codex"],
};

export function isAgentHost(value: unknown): value is AgentHost {
  return typeof value === "string" && (AGENT_HOSTS as readonly string[]).includes(value);
}

export function agentHostForEngine(engine: TurnEngine): AgentHost {
  if (engine === "claude-code" || engine === "claude-local") return "claude-code";
  if (engine === "codex" || engine === "codex-local") return "codex";
  return "qoder";
}

/** Resolve a product choice to the best currently usable concrete runtime. */
export function resolveAgentEngine(
  agent: AgentHost,
  availability: Record<TurnEngine, TurnEngineAvailability>,
): TurnEngine {
  const candidates = RUNTIME_CANDIDATES[agent];
  return candidates.find((candidate) => availability[candidate]?.ready)
    ?? candidates.find((candidate) => availability[candidate]?.configured)
    ?? candidates[0]!;
}

export function defaultAgentHost(
  availability: Record<TurnEngine, TurnEngineAvailability>,
): AgentHost {
  return AGENT_HOSTS.find((agent) => availability[resolveAgentEngine(agent, availability)]?.ready)
    ?? "qoder";
}

/** Collapse concrete runtime choices into the brands that appear in the UI. */
export function visibleAgentHosts(engines: readonly TurnEngine[]): AgentHost[] {
  return AGENT_HOSTS.filter((agent) => engines.some((engine) => agentHostForEngine(engine) === agent));
}
