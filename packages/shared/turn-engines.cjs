// Single source of truth for the selectable turn engine ids.
//
// Four boundaries consume this module: the desktop IPC validators (CommonJS
// directly), the control-plane HTTP routes, the renderer (both via
// src/turns.ts) and turn-record persistence (apps/server/src/turns/store.ts).
// Before #206 the IPC layer carried its own hardcoded copy, so adding an
// engine to the contract left every IPC request for it rejected as
// turn_engine_unsupported before it could reach a route. Persistence was
// missed in that same pass and stayed hardcoded until #239, where the cost was
// worse than a rejection: a turn ran, was written, and was then unreadable,
// taking its conversation's history and /reports down permanently.
//
// The compile-time TurnEngine union still lives in src/turns.ts — TypeScript
// cannot derive a literal union from a runtime require — so a new engine is
// added in both places, and turn-engines.test.cjs asserts every id here is
// accepted by all three IPC validators.
const TURN_ENGINE_IDS = ["qoder", "claude-code", "claude-local", "codex", "codex-local"];

/** "a, b, or c" — the shape the IPC rejection messages have always used. */
function turnEngineMessage(ids = TURN_ENGINE_IDS) {
  if (ids.length <= 2) return ids.join(" or ");
  return `${ids.slice(0, -1).join(", ")}, or ${ids[ids.length - 1]}`;
}

module.exports = {
  TURN_ENGINE_IDS,
  turnEngineMessage,
};
