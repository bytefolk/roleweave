import { expect, it } from "vitest";
import { agentEnginesForHost, agentHostForEngine, defaultAgentHost, resolveAgentEngine, visibleAgentHosts } from "../src/turns/agent-host";
import type { TurnEngine, TurnEngineAvailability } from "../src/turns/types";

function availability(): Record<TurnEngine, TurnEngineAvailability> {
  return {
    qoder: { configured: false, ready: false },
    "claude-code": { configured: true, ready: true },
    "claude-local": { configured: true, ready: false },
    codex: { configured: false, ready: false },
    "codex-local": { configured: false, ready: false },
    workbuddy: { configured: false, ready: false },
    "workbuddy-local": { configured: false, ready: false },
    "qwen-office-local": { configured: true, ready: true },

    gemini: { configured: false, ready: false },
    "openai-compatible": { configured: false, ready: false },
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

it("shares the WorkBuddy brand while keeping local and API runtime identities distinct", () => {
  const engines = availability();
  engines.workbuddy = { configured: true, ready: true };
  engines["workbuddy-local"] = { configured: true, ready: true };
  expect(resolveAgentEngine("workbuddy", engines)).toBe("workbuddy-local");
  expect(agentHostForEngine("workbuddy-local")).toBe("workbuddy");
  expect(visibleAgentHosts(["workbuddy", "workbuddy-local"])).toEqual(["workbuddy"]);
  expect(agentEnginesForHost("workbuddy")).toEqual(["workbuddy-local", "workbuddy"]);
});

it("keeps an invalid WorkBuddy local identity visible instead of selecting a service credential", () => {
  const engines = availability();
  engines.workbuddy = { configured: true, ready: true };
  engines["workbuddy-local"] = {
    configured: false, ready: false,
    connection: { source: "official", kind: "official", billing: "unknown", status: "invalid" },
  };
  expect(resolveAgentEngine("workbuddy", engines)).toBe("workbuddy-local");
});

it("keeps Qwen Office on its only native runtime even when other hosts are ready", () => {
  const engines = availability();
  engines["qwen-office-local"] = { configured: false, ready: false };
  engines.codex = engines["codex-local"] = engines.workbuddy = { configured: true, ready: true };
  expect(agentHostForEngine("qwen-office-local")).toBe("qwen-office-local");
  expect(agentEnginesForHost("qwen-office-local")).toEqual(["qwen-office-local"]);
  expect(resolveAgentEngine("qwen-office-local", engines)).toBe("qwen-office-local");
  expect(visibleAgentHosts(["qwen-office-local"])).toEqual(["qwen-office-local"]);
});
