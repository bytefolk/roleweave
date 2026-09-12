import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthResponse, TurnEngine } from "@roleweave/shared";
import { useTurnEngine } from "../src/use-turn-engine";

const STORAGE_KEY = "owb-turn-engine";

function healthWithReady(...ready: TurnEngine[]): HealthResponse {
  return {
    status: "ok",
    api: "v0",
    server: { version: "0.1.2", pid: 123 },
    engine: { command: "digital-employee", available: true },
    hosts: {
      qoder: { configured: true, ready: ready.includes("qoder") },
      "claude-code": { configured: true, ready: ready.includes("claude-code") },
      "claude-local": { configured: true, ready: ready.includes("claude-local") },
      codex: { configured: true, ready: ready.includes("codex") },
      "codex-local": { configured: true, ready: ready.includes("codex-local") },
    },
    workspace: { open: false },
  };
}

beforeEach(() => window.localStorage.removeItem(STORAGE_KEY));
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem(STORAGE_KEY);
});

describe("Agent Host selection", () => {
  it.each([
    [["qoder", "claude-local", "codex-local"], "codex-local"],
    [["qoder", "claude-local", "codex"], "claude-local"],
    [["claude-code", "codex"], "claude-code"],
    [["codex"], "codex"],
  ] as [TurnEngine[], TurnEngine][])("selects a ready default from %j", (ready, expected) => {
    const { result } = renderHook(() => useTurnEngine(healthWithReady(...ready)));
    expect(result.current[0]).toBe(expected);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("keeps the fallback while health loads and waits for a ready host", () => {
    const { result, rerender } = renderHook(({ health }) => useTurnEngine(health), {
      initialProps: { health: null as HealthResponse | null },
    });
    expect(result.current[0]).toBe("qoder");
    rerender({ health: healthWithReady() });
    expect(result.current[0]).toBe("qoder");
    rerender({ health: healthWithReady("codex-local") });
    expect(result.current[0]).toBe("codex-local");
  });

  it("does not replace an established default when later health changes", () => {
    const { result, rerender } = renderHook(({ health }) => useTurnEngine(health), {
      initialProps: { health: healthWithReady("claude-local") },
    });
    expect(result.current[0]).toBe("claude-local");
    rerender({ health: healthWithReady("codex-local") });
    expect(result.current[0]).toBe("claude-local");
  });

  it.each(["qoder", "claude-code", "claude-local", "codex", "codex-local"] as const)(
    "restores the remembered %s host even when it is not ready",
    (remembered) => {
      window.localStorage.setItem(STORAGE_KEY, remembered);
      const other = remembered === "codex-local" ? "claude-local" : "codex-local";
      const { result } = renderHook(() => useTurnEngine(healthWithReady(other)));
      expect(result.current[0]).toBe(remembered);
    },
  );

  it.each(["unknown-agent", "constructor", "__proto__", '"codex-local"'])(
    "ignores the invalid stored value %s",
    (stored) => {
      window.localStorage.setItem(STORAGE_KEY, stored);
      const { result } = renderHook(() => useTurnEngine(healthWithReady("codex-local")));
      expect(result.current[0]).toBe("codex-local");
    },
  );

  it("persists a manual choice made before health and restores it on remount", () => {
    const { result, rerender, unmount } = renderHook(({ health }) => useTurnEngine(health), {
      initialProps: { health: null as HealthResponse | null },
    });
    act(() => result.current[1]("claude-code"));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("claude-code");
    rerender({ health: healthWithReady("codex-local") });
    expect(result.current[0]).toBe("claude-code");
    unmount();
    const reopened = renderHook(() => useTurnEngine(healthWithReady("codex-local")));
    expect(reopened.result.current[0]).toBe("claude-code");
  });

  it("still switches hosts when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    const { result, rerender } = renderHook(({ health }) => useTurnEngine(health), {
      initialProps: { health: healthWithReady("codex-local") },
    });
    expect(result.current[0]).toBe("codex-local");
    act(() => result.current[1]("qoder"));
    rerender({ health: healthWithReady("codex-local") });
    expect(result.current[0]).toBe("qoder");
  });
});
