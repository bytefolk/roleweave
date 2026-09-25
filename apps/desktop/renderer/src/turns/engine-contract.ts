import type { TurnEngine } from "./types";

/** Renderer-only host contract. Keep this module free of imports from the
 * shared package so reducers and controls remain safe to bundle for browsers. */
const ENGINE_LABEL: Record<TurnEngine, string> = {
  qoder: "Qoder",
  "claude-code": "Claude Code",
  "claude-local": "Claude Code",
  codex: "Codex",
  "codex-local": "Codex",
  workbuddy: "WorkBuddy",
  gemini: "Gemini",
  "openai-compatible": "OpenAI Compatible",
};

export const TURN_ENGINES = Object.freeze(
  Object.keys(ENGINE_LABEL) as TurnEngine[],
);

const TURN_ENGINE_SET = new Set<string>(TURN_ENGINES);

export function isTurnEngine(value: unknown): value is TurnEngine {
  return typeof value === "string" && TURN_ENGINE_SET.has(value);
}

export function engineLabel(engine: TurnEngine): string {
  return ENGINE_LABEL[engine];
}
