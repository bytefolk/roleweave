import { useCallback, useEffect, useState } from "react";
import type { HealthResponse } from "@roleweave/shared";
import type { TurnEngine } from "./turns/types";

const STORAGE_KEY = "owb-turn-engine";
const DEFAULT_ORDER: readonly TurnEngine[] = ["codex-local", "claude-local", "qoder", "claude-code", "codex"];

function isTurnEngine(value: unknown): value is TurnEngine {
  return typeof value === "string" && DEFAULT_ORDER.includes(value as TurnEngine);
}

function seedSelection(): { engine: TurnEngine; resolved: boolean } {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isTurnEngine(stored)) return { engine: stored, resolved: true };
  } catch {
    // Storage can be unavailable; the current session still gets a usable default.
  }
  return { engine: "qoder", resolved: false };
}

/** Remember explicit choices, including temporarily unavailable hosts. Without
 * one, choose from the first ready health response and keep that host stable. */
export function useTurnEngine(health: HealthResponse | null) {
  const [selection, setSelection] = useState(seedSelection);

  useEffect(() => {
    const ready = DEFAULT_ORDER.find((engine) => health?.hosts?.[engine]?.ready === true);
    if (!ready) return;
    setSelection((current) => current.resolved ? current : { engine: ready, resolved: true });
  }, [health]);

  const selectEngine = useCallback((engine: TurnEngine) => {
    if (!isTurnEngine(engine)) return;
    setSelection({ engine, resolved: true });
    try {
      window.localStorage.setItem(STORAGE_KEY, engine);
    } catch {
      // A storage failure must not prevent switching hosts for this session.
    }
  }, []);

  return [selection.engine, selectEngine] as const;
}
