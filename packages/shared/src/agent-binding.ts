/**
 * Durable, per-position Agent selection.
 *
 * A binding intentionally lives beside an employee package rather than in
 * employee.json: it is Workbench runtime state, not an upstream package
 * asset. That keeps the upstream package digest and capability declaration
 * independent from the local execution transport chosen for the employee.
 */
import { turnEngines } from "./turns.js";
import type { TurnEngine } from "./turns.js";
import { isEngineModelId } from "./model-selection.js";

export const AGENT_BINDING_SCHEMA_VERSION = "roleweave-agent-binding.v1" as const;
export const AGENT_BINDING_RELATIVE_PATH = ".workbench/agent-binding.v1.json" as const;
export const DEFAULT_AGENT_ENGINE: TurnEngine = "qoder";

export interface PositionAgentBinding {
  schemaVersion: typeof AGENT_BINDING_SCHEMA_VERSION;
  /** Concrete runtime id. UI may group these into a friendlier Agent brand. */
  engine: TurnEngine;
  /** Set when the first task is accepted. A position then keeps one runtime
   * so its subsequent conversation and audit trail stay reproducible. */
  locked?: true;
  model?: string;
}

/** Strict, small shape gate for the local sidecar. */
export function isPositionAgentBinding(value: unknown): value is PositionAgentBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => ["schemaVersion", "engine", "locked", "model"].includes(key)) &&
    (record.locked === undefined || record.locked === true) &&
    (record.model === undefined || isEngineModelId(record.model, record.engine)) &&
    Object.hasOwn(record, "schemaVersion") &&
    Object.hasOwn(record, "engine") &&
    record.schemaVersion === AGENT_BINDING_SCHEMA_VERSION &&
    typeof record.engine === "string" &&
    turnEngines.includes(record.engine as TurnEngine)
  );
}
