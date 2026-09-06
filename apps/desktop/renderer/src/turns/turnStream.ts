import type { GroupTimeline, TurnRecord } from "@roleweave/shared";
import type { TurnEngine } from "./types";

/**
 * Renderer-local projection of the frozen turn.* SSE vocabulary
 * (docs/api-contract-v0.md §2.10). The renderer never reconstructs
 * turn-record.v1: streaming text is a provisional overlay, and every
 * terminal event hands authority back to the persisted history reload.
 */

export interface PendingTurnRequestState {
  positionId: string;
  engine: TurnEngine;
  input: string;
  /** Bound on the first engine event observed for the in-flight POST. */
  runId: string | null;
}

export interface LiveRunState {
  /** Stable group dispatch identity. The map key may be re-keyed to runId. */
  turnId?: string;
  messageId?: string;
  /** Engine runId, null until the first attributed engine event. */
  engineRunId?: string | null;
  positionId: string;
  engine: TurnEngine;
  input: string;
  text: string;
  startedAt: string;
  /** Latest engine-reported usage; feeds the compact status line only. */
  totalTokens: number | null;
  /** Group conversation this run belongs to (#52); absent for 1:1 turns. */
  groupRef?: string;
}

export interface TurnStreamState {
  /** Last processed envelope seq; replays at or below it are idempotent no-ops. */
  seq: number;
  pending: PendingTurnRequestState | null;
  runs: Record<string, LiveRunState>;
  /** Bounded exact terminal facts observed before a 202 spawn can be seeded. */
  settledGroupRuns: Record<string, SettledGroupRunState>;
}

interface GroupRunIdentity {
  groupRef: string;
  messageId: string;
  turnId: string;
  positionId: string;
  engine: TurnEngine;
}

interface SettledGroupRunState extends GroupRunIdentity {
  seq: number;
}

export const EMPTY_TURN_STREAM: TurnStreamState = {
  seq: 0,
  pending: null,
  runs: {},
  settledGroupRuns: {},
};

export interface TurnStreamEnvelope {
  seq?: unknown;
  type?: unknown;
  at?: unknown;
  payload?: unknown;
}

const LIVE_RUNS_CAP = 32;
const SETTLED_GROUP_RUNS_CAP = 64;
const GROUP_ENGINES = new Set<TurnEngine>(["qoder", "claude-code", "claude-local"]);

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function evictIfOverCap(runs: Record<string, LiveRunState>): Record<string, LiveRunState> {
  const entries = Object.entries(runs);
  if (entries.length <= LIVE_RUNS_CAP) return runs;
  entries.sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt));
  return Object.fromEntries(entries.slice(entries.length - LIVE_RUNS_CAP));
}

function groupIdentity(payload: Record<string, unknown> | null): GroupRunIdentity | null {
  const groupRef = stringField(payload, "groupRef") ?? stringField(payload, "conversationRef");
  const messageId = stringField(payload, "messageId");
  const turnId = stringField(payload, "turnId");
  const positionId = stringField(payload, "positionId");
  const engine = stringField(payload, "engine");
  if (
    groupRef === null || messageId === null || turnId === null || positionId === null ||
    engine === null || !GROUP_ENGINES.has(engine as TurnEngine)
  ) return null;
  return { groupRef, messageId, turnId, positionId, engine: engine as TurnEngine };
}

function hasGroupAttribution(payload: Record<string, unknown> | null): boolean {
  return stringField(payload, "groupRef") !== null ||
    stringField(payload, "messageId") !== null;
}

function sameGroupRun(left: GroupRunIdentity, right: GroupRunIdentity): boolean {
  return left.groupRef === right.groupRef &&
    left.messageId === right.messageId &&
    left.turnId === right.turnId &&
    left.positionId === right.positionId &&
    left.engine === right.engine;
}

function liveIdentity(run: LiveRunState): GroupRunIdentity | null {
  return run.groupRef !== undefined && run.messageId !== undefined && run.turnId !== undefined
    ? {
        groupRef: run.groupRef,
        messageId: run.messageId,
        turnId: run.turnId,
        positionId: run.positionId,
        engine: run.engine,
      }
    : null;
}

function rememberSettledGroupRun(
  settled: Record<string, SettledGroupRunState>,
  identity: GroupRunIdentity,
  seq: number,
): Record<string, SettledGroupRunState> {
  const next = { ...settled, [identity.turnId]: { ...identity, seq } };
  const entries = Object.entries(next);
  if (entries.length <= SETTLED_GROUP_RUNS_CAP) return next;
  entries.sort((left, right) => left[1].seq - right[1].seq || left[0].localeCompare(right[0], "en"));
  return Object.fromEntries(entries.slice(entries.length - SETTLED_GROUP_RUNS_CAP));
}

function terminalRecord(turn: TurnRecord): boolean {
  return turn.status === "completed" || turn.status === "failed" || turn.status === "indeterminate";
}

export function beginPendingTurn(
  state: TurnStreamState,
  request: { positionId: string; engine: TurnEngine; input: string },
): TurnStreamState {
  return { ...state, pending: { ...request, runId: null } };
}

/**
 * Group spawn (#52): the 202 response pre-assigns each member's turnId, so the
 * run is adopted here — group turns bypass the single-pending attribution.
 */
export function beginGroupRun(
  state: TurnStreamState,
  spawn: {
    groupRef: string;
    messageId: string;
    turnId: string;
    positionId: string;
    engine: TurnEngine;
    input: string;
  },
): TurnStreamState {
  if (state.runs[spawn.turnId] !== undefined) return state;
  const settled = state.settledGroupRuns[spawn.turnId];
  if (settled !== undefined && sameGroupRun(settled, spawn)) return state;
  return {
    ...state,
    runs: evictIfOverCap({
      ...state.runs,
      [spawn.turnId]: {
        turnId: spawn.turnId,
        messageId: spawn.messageId,
        engineRunId: null,
        positionId: spawn.positionId,
        engine: spawn.engine,
        input: spawn.input,
        text: "",
        startedAt: new Date().toISOString(),
        totalTokens: null,
        groupRef: spawn.groupRef,
      },
    }),
  };
}

/**
 * Reconcile a dropped/late SSE channel from the bounded group timeline. A
 * live marker is removed only when both its exact user message and exact
 * terminal turn are present; unrelated group/member/engine facts cannot
 * settle it. The caller controls polling bounds.
 */
export function reconcileGroupTimeline(
  state: TurnStreamState,
  timeline: GroupTimeline,
): TurnStreamState {
  const messages = new Map(
    timeline.items
      .filter((item) => item.kind === "user")
      .map((message) => [message.messageId, message] as const),
  );
  const turns = new Map<string, TurnRecord>();
  for (const item of timeline.items) {
    if (item.kind === "member" && terminalRecord(item.turn)) {
      turns.set(item.turn.turnId, item.turn);
    }
  }
  let changed = false;
  let settledGroupRuns = state.settledGroupRuns;
  const runs: Record<string, LiveRunState> = {};
  for (const [runKey, run] of Object.entries(state.runs)) {
    const identity = liveIdentity(run);
    if (identity === null || identity.groupRef !== timeline.conversationRef) {
      runs[runKey] = run;
      continue;
    }
    const message = messages.get(identity.messageId);
    const turn = turns.get(identity.turnId);
    const exactMessage = message !== undefined &&
      message.conversationRef === identity.groupRef &&
      message.input === run.input &&
      message.mentions.includes(identity.positionId);
    const exactTurn = turn !== undefined &&
      (turn.conversationRef === identity.groupRef || turn.groupRef === identity.groupRef) &&
      turn.positionId === identity.positionId &&
      turn.engine === identity.engine &&
      turn.input === run.input;
    if (!exactMessage || !exactTurn) {
      runs[runKey] = run;
      continue;
    }
    changed = true;
    settledGroupRuns = rememberSettledGroupRun(settledGroupRuns, identity, state.seq);
  }
  return changed ? { ...state, runs, settledGroupRuns } : state;
}

/** The in-flight POST failed before any engine attribution; drop the pending marker only. */
export function cancelPendingTurn(state: TurnStreamState): TurnStreamState {
  return { ...state, pending: null };
}

/** Session navigation owns only the 1:1 lane; group convergence is global. */
export function clearPersonalTurnState(state: TurnStreamState): TurnStreamState {
  return {
    ...state,
    pending: null,
    runs: Object.fromEntries(
      Object.entries(state.runs).filter(([, run]) => run.groupRef !== undefined),
    ),
  };
}

/**
 * The POST returned, so the server-side record is terminal and the history
 * reload is authoritative. Drop the pending marker and any live buffer that
 * the terminal already superseded.
 */
export function settlePendingTurn(
  state: TurnStreamState,
  outcome: { runId: string | null; positionId: string },
): TurnStreamState {
  const runs: Record<string, LiveRunState> = {};
  for (const [runId, run] of Object.entries(state.runs)) {
    const superseded = run.groupRef === undefined && (outcome.runId !== null
      ? runId === outcome.runId
      : run.positionId === outcome.positionId);
    if (!superseded) runs[runId] = run;
  }
  return { ...state, pending: null, runs };
}

export function resetStreamSeq(state: TurnStreamState): TurnStreamState {
  return { ...state, seq: 0 };
}

export function applyTurnEvent(
  state: TurnStreamState,
  envelope: TurnStreamEnvelope,
): TurnStreamState {
  const seq = typeof envelope.seq === "number" && Number.isFinite(envelope.seq) ? envelope.seq : null;
  if (seq !== null && seq <= state.seq) return state;
  const nextSeq = seq ?? state.seq;
  const payload = payloadRecord(envelope.payload);
  const runId = stringField(payload, "runId");

  switch (envelope.type) {
    case "turn.started":
    case "turn.model.delta": {
      if (runId === null) return { ...state, seq: nextSeq };
      const existing = state.runs[runId];
      const delta = envelope.type === "turn.model.delta" ? (stringField(payload, "text") ?? "") : "";
      if (existing) {
        const currentIdentity = liveIdentity(existing);
        if (currentIdentity !== null) {
          const identity = groupIdentity(payload);
          if (
            identity === null || !sameGroupRun(currentIdentity, identity) ||
            (existing.engineRunId !== null && existing.engineRunId !== undefined && existing.engineRunId !== runId)
          ) return { ...state, seq: nextSeq };
        }
        return {
          ...state,
          seq: nextSeq,
          runs: { ...state.runs, [runId]: { ...existing, text: existing.text + delta } },
        };
      }
      // Group runs (#52) are seeded by beginGroupRun under the pre-assigned
      // turnId; the first engine event re-keys the buffer under the engine
      // runId so delta/usage/completed all resolve through the normal path.
      // #63: the contract-level back-link (de#205 echo) is the authoritative
      // grouping key; the local groupRef tag remains the gray fallback. A
      // back-link-only event is adopted only when its spawn seed exists, so
      // personal session turns (never seeded) stay on the pending path.
      const seedId = stringField(payload, "turnId");
      const seeded = seedId !== null ? state.runs[seedId] : undefined;
      const groupingRef =
        stringField(payload, "groupRef") ??
        (seeded !== undefined ? stringField(payload, "conversationRef") : null);
      if (groupingRef !== null) {
        const identity = groupIdentity(payload);
        const seededIdentity = seeded === undefined ? null : liveIdentity(seeded);
        if (
          seeded === undefined || runId === null || identity === null || seededIdentity === null ||
          !sameGroupRun(identity, seededIdentity)
        ) return { ...state, seq: nextSeq };
        const runs = { ...state.runs };
        if (seedId !== null && seedId !== runId) delete runs[seedId];
        return {
          ...state,
          seq: nextSeq,
          runs: evictIfOverCap({
            ...runs,
            [runId]: {
              ...seeded,
              groupRef: groupingRef,
              engineRunId: runId,
              text: seeded.text + delta,
            },
          }),
        };
      }
      const pending = state.pending;
      // A run we cannot attribute to our in-flight POST is left to the
      // authoritative history reload; the renderer never guesses a position.
      if (pending === null || (pending.runId !== null && pending.runId !== runId)) {
        return { ...state, seq: nextSeq };
      }
      const startedAt = stringField(payload, "timestamp") ?? new Date().toISOString();
      return {
        ...state,
        seq: nextSeq,
        pending: { ...pending, runId },
        runs: evictIfOverCap({
          ...state.runs,
          [runId]: {
            positionId: pending.positionId,
            engine: pending.engine,
            input: pending.input,
            text: delta,
            startedAt,
            totalTokens: null,
          },
        }),
      };
    }
    case "turn.usage": {
      if (runId === null) return { ...state, seq: nextSeq };
      const existing = state.runs[runId];
      if (existing === undefined) return { ...state, seq: nextSeq };
      const currentIdentity = liveIdentity(existing);
      if (currentIdentity !== null) {
        const identity = groupIdentity(payload);
        if (identity === null || !sameGroupRun(currentIdentity, identity)) {
          return { ...state, seq: nextSeq };
        }
      }
      const rawTotal = payload?.totalTokens;
      const totalTokens = typeof rawTotal === "number" && Number.isFinite(rawTotal) ? rawTotal : existing.totalTokens;
      return {
        ...state,
        seq: nextSeq,
        runs: { ...state.runs, [runId]: { ...existing, totalTokens } },
      };
    }
    case "turn.completed":
    case "turn.failed": {
      const identity = groupIdentity(payload);
      if (identity !== null) {
        if (runId === null) return { ...state, seq: nextSeq };
        const runs: Record<string, LiveRunState> = {};
        for (const [runKey, run] of Object.entries(state.runs)) {
          const currentIdentity = liveIdentity(run);
          const exact = currentIdentity !== null && sameGroupRun(currentIdentity, identity) &&
            (run.engineRunId === null || run.engineRunId === undefined || run.engineRunId === runId);
          if (!exact) runs[runKey] = run;
        }
        return {
          ...state,
          seq: nextSeq,
          runs,
          settledGroupRuns: rememberSettledGroupRun(state.settledGroupRuns, identity, nextSeq),
        };
      }
      if (hasGroupAttribution(payload)) return { ...state, seq: nextSeq };
      // A group buffer must never fall through to the personal runId path:
      // missing attribution is not evidence that the exact group turn ended.
      const terminalRun = runId === null ? undefined : state.runs[runId];
      if (terminalRun !== undefined && liveIdentity(terminalRun) !== null) {
        return { ...state, seq: nextSeq };
      }
      if (runId === null || state.runs[runId] === undefined) return { ...state, seq: nextSeq };
      const runs = { ...state.runs };
      delete runs[runId];
      return { ...state, seq: nextSeq, runs };
    }
    case "turn.indeterminate": {
      // No runId is carried. Exact group attribution clears only its spawn;
      // partial group metadata is ignored and left to persisted reconciliation.
      // Personal cleanup remains position-scoped.
      const positionId = stringField(payload, "positionId");
      const identity = groupIdentity(payload);
      if (identity === null && hasGroupAttribution(payload)) {
        return { ...state, seq: nextSeq };
      }
      const pendingRunId = state.pending?.runId ?? null;
      const runs: Record<string, LiveRunState> = {};
      for (const [runId, run] of Object.entries(state.runs)) {
        const currentIdentity = liveIdentity(run);
        const scoped = identity !== null
          ? currentIdentity !== null && sameGroupRun(currentIdentity, identity)
          : currentIdentity !== null
            ? false
          : positionId !== null
            ? run.positionId === positionId
            : runId === pendingRunId;
        if (!scoped) runs[runId] = run;
      }
      return {
        ...state,
        seq: nextSeq,
        runs,
        ...(identity !== null
          ? { settledGroupRuns: rememberSettledGroupRun(state.settledGroupRuns, identity, nextSeq) }
          : {}),
      };
    }
    default:
      return { ...state, seq: nextSeq };
  }
}
