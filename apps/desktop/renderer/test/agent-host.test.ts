import { expect, it } from "vitest";
import { agentHostForEngine, defaultAgentHost, resolveAgentEngine } from "../src/turns/agent-host";
import type { TurnEngine, TurnEngineAvailability } from "../src/turns/types";

function availability(): Record<TurnEngine, TurnEngineAvailability> {
  return {
    qoder: { configured: false, ready: false },
    "claude-code": { configured: true, ready: true },
    "claude-local": { configured: true, ready: false },
    codex: { configured: false, ready: false },
    "codex-local": { configured: false, ready: false },
    workbuddy: { configured: false, ready: false },
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

it("chooses WorkBuddy as the default when it is the only ready host", () => {
  const engines = availability();
  for (const state of Object.values(engines)) state.ready = false;
  engines.workbuddy = { configured: true, ready: true };
  expect(defaultAgentHost(engines)).toBe("workbuddy");
  expect(resolveAgentEngine("workbuddy", engines)).toBe("workbuddy");
  expect(agentHostForEngine("workbuddy")).toBe("workbuddy");
});
