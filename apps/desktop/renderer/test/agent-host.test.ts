import { expect, it } from "vitest";
import { resolveAgentEngine } from "../src/turns/agent-host";
import type { TurnEngine, TurnEngineAvailability } from "../src/turns/types";

function availability(): Record<TurnEngine, TurnEngineAvailability> {
  return {
    qoder: { configured: false, ready: false },
    "claude-code": { configured: true, ready: true },
    "claude-local": { configured: true, ready: false },
    codex: { configured: false, ready: false },
    "codex-local": { configured: false, ready: false },
  };
}

it("keeps an invalid local Claude connection visible instead of changing its billing source", () => {
  const engines = availability();
  engines["claude-local"].connection = {
    source: "local-config",
    kind: "gateway",
    billing: "provider",
    status: "invalid",
  };
  engines["claude-code"].connection = {
    source: "official",
    kind: "official",
    billing: "subscription",
    status: "configured",
  };

  expect(resolveAgentEngine("claude-code", engines)).toBe("claude-local");
});
