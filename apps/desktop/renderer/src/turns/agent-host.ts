import type { TurnEngine, TurnEngineAvailability } from "./types";

/**
 * The five products operators choose between. The seven `TurnEngine` values
 * remain an implementation detail because a local configuration can use an
 * official sign-in or a gateway, and the variants have different credential
 * and process-isolation requirements.
 */
export const AGENT_HOSTS = ["qoder", "claude-code", "codex", "workbuddy", "gemini"] as const;

export type AgentHost = (typeof AGENT_HOSTS)[number];

export const AGENT_HOST_LABEL: Record<AgentHost, string> = {
  qoder: "Qoder",
  "claude-code": "Claude Code",
  codex: "Codex",
  workbuddy: "WorkBuddy",
  gemini: "Gemini",
};

const RUNTIME_CANDIDATES: Record<AgentHost, readonly TurnEngine[]> = {
  qoder: ["qoder"],
  // Prefer the ready local configuration (official sign-in or gateway) while
  // the product choice remains "Claude Code".
  "claude-code": ["claude-local", "claude-code"],
  codex: ["codex-local", "codex"],
  workbuddy: ["workbuddy"],
  gemini: ["gemini"],
};

export function isAgentHost(value: unknown): value is AgentHost {
  return typeof value === "string" && (AGENT_HOSTS as readonly string[]).includes(value);
}

export function agentHostForEngine(engine: TurnEngine): AgentHost {
  if (engine === "claude-code" || engine === "claude-local") return "claude-code";
  if (engine === "codex" || engine === "codex-local") return "codex";
  if (engine === "workbuddy") return "workbuddy";
  if (engine === "gemini") return "gemini";
  return "qoder";
}

/** Resolve a product choice to the best currently usable concrete runtime. */
export function resolveAgentEngine(
  agent: AgentHost,
  availability: Record<TurnEngine, TurnEngineAvailability>,
): TurnEngine {
  // A local Claude configuration can deliberately target a gateway with a
  // different billing source. If its connection is invalid, retain that
  // concrete runtime so the caller surfaces the mismatch instead of silently
  // falling through to a separately authenticated Claude Code installation.
  if (agent === "claude-code" && availability["claude-local"].connection?.status === "invalid") {
    return "claude-local";
  }
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
