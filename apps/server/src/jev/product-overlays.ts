/** Product overlays for #461–#469. Advisory only. No turn bodies. No auto-execute. */

export type Abstain = { status: "abstain"; reason: string };
export type Suggestion<T> = { status: "suggest"; value: T; notAdopted?: boolean };

const FORBIDDEN_TURN_BODY_KEYS = ["input", "output", "description", "target", "content", "body"] as const;

export function assertNoTurnBodies(payload: Record<string, unknown>): void {
  const extra = Object.keys(payload).filter((key) => (FORBIDDEN_TURN_BODY_KEYS as readonly string[]).includes(key));
  if (extra.length > 0) throw new Error(`forbidden overlay keys: ${extra.join(",")}`);
}

/** Apply only pre-fills an unsent control. User still clicks existing Send. */
export function applySendGateSuggestion(): { postsTurn: false; envelopeChanged: false; unsentControl: "approval_required" } {
  return { postsTurn: false, envelopeChanged: false, unsentControl: "approval_required" };
}

export function sendTimeHumanGate(input: {
  taskSummary?: string | null;
  mode: "read_only" | "approval_required";
}): Abstain | Suggestion<"keep" | "suggest_approval_required"> {
  if (!input.taskSummary?.trim()) return { status: "abstain", reason: "missing_task_intent" };
  if (input.mode === "read_only") return { status: "suggest", value: "suggest_approval_required" };
  return { status: "suggest", value: "keep" };
}

export function budgetRemainingAdvice(input: {
  remainingPerTask: number | null;
  remainingPerDay: number | null;
  hirePerTask: number;
  hirePerDay: number;
}): Abstain | Suggestion<"shrink" | "switch_employee" | "still_send"> {
  if (input.remainingPerTask == null || input.remainingPerDay == null) {
    return { status: "abstain", reason: "unknown_remaining" };
  }
  if (input.remainingPerTask > input.hirePerTask || input.remainingPerDay > input.hirePerDay) {
    throw new Error("overlay cannot raise hire caps");
  }
  if (input.remainingPerTask <= 0) return { status: "suggest", value: "switch_employee" };
  if (input.remainingPerTask < input.hirePerTask * 0.1) return { status: "suggest", value: "shrink" };
  return { status: "suggest", value: "still_send" };
}

export type RunningFact = { positionId: string; status: string; errorCode?: string };

export function overlayCannotCancelRunning(): false {
  return false;
}

export function inFlightDuplicateAdvice(input: {
  running: RunningFact[];
  taskSummary?: string | null;
}): { facts: RunningFact[]; advice: Abstain | Suggestion<"join_existing" | "send_anyway">; canCancel: false } {
  return {
    facts: input.running,
    advice: input.taskSummary?.trim()
      ? { status: "suggest", value: input.running.length > 0 ? "join_existing" : "send_anyway" }
      : { status: "abstain", reason: "missing_task_intent" },
    canCancel: false,
  };
}

export function dismissHandoffAdvice(input: {
  candidates: { id: string; name: string; mode: string }[];
  runningCount: number;
  pendingApprovalCount: number;
  boundGoalCount: number;
}): {
  facts: { runningCount: number; pendingApprovalCount: number; boundGoalCount: number };
  advice: Abstain | Suggestion<string>;
  canSkipConfirm: false;
} {
  const advice: Abstain | Suggestion<string> = input.candidates[0]
    ? { status: "suggest", value: input.candidates[0].id }
    : { status: "abstain", reason: "no_candidates" };
  return {
    facts: {
      runningCount: input.runningCount,
      pendingApprovalCount: input.pendingApprovalCount,
      boundGoalCount: input.boundGoalCount,
    },
    advice,
    canSkipConfirm: false,
  };
}

export function readyHostAdvice(input: { selectedReady: boolean; readyPositionIds: string[] }): Abstain | Suggestion<string> {
  if (input.selectedReady) return { status: "abstain", reason: "selected_ready" };
  if (input.readyPositionIds.length <= 1) return { status: "abstain", reason: "zero_or_one_ready_no_jev" };
  return { status: "suggest", value: input.readyPositionIds[0]! };
}

export function approvalAgingAdvice(input: {
  createdAtMs: number;
  nowMs: number;
  decisionKind: string;
  ruleRisk: "medium" | "high";
  overlayNeedsAttention?: boolean;
}): { hidePendingHigh: false; advice: Suggestion<"nudge" | "wait" | "discuss_close"> } {
  const age = input.nowMs - input.createdAtMs;
  const advice: Suggestion<"nudge" | "wait" | "discuss_close"> =
    age > 48 * 3600_000
      ? { status: "suggest", value: "nudge" }
      : { status: "suggest", value: "wait" };
  void input.decisionKind;
  void input.ruleRisk;
  void input.overlayNeedsAttention;
  return { hidePendingHigh: false, advice };
}

export function filterPendingHighItems<T extends { decisionKind: string; ruleRisk: "medium" | "high" }>(items: T[]): T[] {
  return items;
}

export type PreflightStatus = "covered" | "needs_more" | "undetermined";

export function deliveryPreflightItem(input: {
  materialIds: string[];
  versions: Record<string, string[]>;
  danglingIds: string[];
}): { status: PreflightStatus; overallPass: false } {
  if (input.danglingIds.length > 0) return { status: "undetermined", overallPass: false };
  for (const id of input.materialIds) {
    const vers = input.versions[id] ?? [];
    if (vers.length > 1) return { status: "undetermined", overallPass: false };
  }
  if (input.materialIds.length === 0) return { status: "needs_more", overallPass: false };
  return { status: "undetermined", overallPass: false };
}

/** Unselected materials must be absent from outbound JSON. */
export function outboundPreflightJson(
  selectedIds: readonly string[],
  materials: Record<string, unknown>,
): Record<string, unknown> {
  const outbound: Record<string, unknown> = {};
  for (const id of selectedIds) {
    if (Object.prototype.hasOwnProperty.call(materials, id)) outbound[id] = materials[id];
  }
  return outbound;
}

export type ReceiptKind = "viewed" | "suggestion_applied" | "action_succeeded" | "owner_resolved";

export function applyReceiptEvent(
  current: ReceiptKind[],
  event: "overlay_click" | "open_session" | "original_action_ok" | "original_action_fail" | "owner_confirm",
): ReceiptKind[] {
  const next = new Set(current);
  if (event === "overlay_click" || event === "open_session") {
    next.add("viewed");
    if (event === "overlay_click") next.add("suggestion_applied");
    return [...next];
  }
  if (event === "original_action_ok") {
    next.add("action_succeeded");
    return [...next];
  }
  if (event === "original_action_fail") {
    next.delete("owner_resolved");
    return [...next];
  }
  if (event === "owner_confirm") next.add("owner_resolved");
  return [...next];
}

export function overlayClickResolvesItem(): false {
  return false;
}

export function relayStopAdvice(input: {
  flagOn: boolean;
  mentionOrder: string[];
  completed: { positionId: string; status: string; errorCode?: string; hasOutput: boolean };
}): { order: string[]; rewriteSpawns: false; advice: Abstain | Suggestion<"stop_remaining"> } {
  if (!input.flagOn) {
    return { order: input.mentionOrder, rewriteSpawns: false, advice: { status: "abstain", reason: "flag_off" } };
  }
  if (!input.completed.hasOutput) {
    return { order: input.mentionOrder, rewriteSpawns: false, advice: { status: "abstain", reason: "no_output_flag" } };
  }
  if (input.completed.status === "completed") {
    return { order: input.mentionOrder, rewriteSpawns: false, advice: { status: "suggest", value: "stop_remaining" } };
  }
  return { order: input.mentionOrder, rewriteSpawns: false, advice: { status: "abstain", reason: "not_complete" } };
}

export function applyRelayStopSuggestion(): { rewriteSpawns: false; autoStopRemaining: false } {
  return { rewriteSpawns: false, autoStopRemaining: false };
}
