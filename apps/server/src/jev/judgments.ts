import { askJev, type JevAsk, type JevRequest } from "./client.js";
import { jevAutoDispatch, jevEnabled } from "./config.js";
import type { ApprovalRequestedEvent, OrgRole, TurnRecord } from "@roleweave/shared";

export type JevRiskLevel = "low" | "medium" | "high";
export type EscalationCategory = "budget" | "permission" | "engine-error" | "user-cancelled" | "benign";
export type HireMode = "read_only" | "approval_required";
export type ModelTier = "economy" | "balanced" | "powerful";

export interface JudgmentDeps {
  env?: NodeJS.Dict<string>;
  ask?: JevAsk;
  log?: (entry: Record<string, unknown>) => void;
}

const TOOL_SETS: Record<string, string[]> = {
  read: ["Read", "Grep", "Glob"],
  edit: ["Read", "Grep", "Glob", "Edit", "Write"],
  exec: ["Read", "Grep", "Glob", "Edit", "Write", "Exec"],
};

function envOf(deps: JudgmentDeps): NodeJS.Dict<string> {
  return deps.env ?? process.env;
}

function askOf(deps: JudgmentDeps): JevAsk {
  return deps.ask ?? ((request: JevRequest) => askJev(request, { env: envOf(deps) }));
}

function logOf(deps: JudgmentDeps): (entry: Record<string, unknown>) => void {
  if (!jevEnabled(envOf(deps))) return () => {};
  return deps.log ?? ((entry) => console.info("[jev]", JSON.stringify(entry)));
}

async function safeAsk(deps: JudgmentDeps, request: JevRequest): Promise<Record<string, import("./client.js").JevAnswer> | null> {
  if (!jevEnabled(envOf(deps))) return null;
  try {
    return await askOf(deps)(request);
  } catch {
    return null;
  }
}

function choice(answers: Record<string, import("./client.js").JevAnswer> | null, key: string): string | undefined {
  const answer = answers?.[key];
  return answer?.type === "choice" ? answer.selected : undefined;
}

function noul(answers: Record<string, import("./client.js").JevAnswer> | null, key: string): number | undefined {
  const answer = answers?.[key];
  return answer?.type === "noul" ? answer.probability : undefined;
}

function score(answers: Record<string, import("./client.js").JevAnswer> | null, key: string): number | undefined {
  const answer = answers?.[key];
  return answer?.type === "score" ? answer.score : undefined;
}

function fitKey(id: string): string {
  return `fit_${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function terminalReasonOf(record: Pick<TurnRecord, "status" | "error"> & { events?: TurnRecord["events"] }): string | undefined {
  if (record.events) {
    for (let index = record.events.length - 1; index >= 0; index -= 1) {
      const event = record.events[index]!;
      if (event.type === "run.failed") return event.error.terminalReason;
      if (event.type === "run.completed") return event.terminalReason;
    }
  }
  return record.error?.code;
}

export function heuristicApprovalRisk(kind: ApprovalRequestedEvent["action"]["kind"]): JevRiskLevel {
  return kind === "tool" ? "medium" : "high";
}

export async function overlayApprovalRisk(
  action: ApprovalRequestedEvent["action"],
  deps: JudgmentDeps = {},
): Promise<JevRiskLevel | null> {
  const heuristic = heuristicApprovalRisk(action.kind);
  const answers = await safeAsk(deps, {
    state: { kind: action.kind, description: action.description.slice(0, 240), target: action.target?.slice(0, 240) },
    questions: {
      risk: {
        type: "score",
        instructions: "Score operator-facing danger of this capability request. 0 is harmless inspection, 1 is destructive or exfiltrating.",
        criteria: ["harmless", "sensitive", "destructive"],
      },
    },
  });
  const value = score(answers, "risk");
  const overlay: JevRiskLevel | null =
    value === undefined ? null : value < 0.34 ? "low" : value < 0.67 ? "medium" : "high";
  logOf(deps)({ seam: "approval-risk", kind: action.kind, heuristic, overlay, fallback: overlay == null });
  return overlay;
}

export async function overlayEscalation(
  record: Pick<TurnRecord, "status" | "error"> & { events?: TurnRecord["events"] },
  deps: JudgmentDeps = {},
): Promise<{ category: EscalationCategory; needsAttention: boolean } | null> {
  const answers = await safeAsk(deps, {
    state: { status: record.status, errorCode: record.error?.code, terminalReason: terminalReasonOf(record) },
    questions: {
      category: {
        type: "choice",
        instructions: "Classify why this turn escalated.",
        criteria: {
          budget: "token or position budget exceeded",
          permission: "denied tool, mode, or approval",
          "engine-error": "engine crash or protocol failure",
          "user-cancelled": "operator cancelled",
          benign: "no human action needed",
        },
      },
      needsAttention: { type: "noul", instructions: "Does an operator need to act?" },
    },
  });
  const category = choice(answers, "category");
  const allowed: EscalationCategory[] = ["budget", "permission", "engine-error", "user-cancelled", "benign"];
  if (!category || !allowed.includes(category as EscalationCategory)) {
    logOf(deps)({ seam: "escalation", fallback: true });
    return null;
  }
  const overlay = {
    category: category as EscalationCategory,
    needsAttention: (noul(answers, "needsAttention") ?? 0.5) >= 0.5,
  };
  logOf(deps)({ seam: "escalation", ...overlay, fallback: false });
  return overlay;
}

export async function overlayHireSuggest(
  input: { description: string; prompt?: string },
  remainingPool: number,
  deps: JudgmentDeps = {},
): Promise<{ mode: HireMode; tools: string[]; perTaskTokens: number; perDayTokens: number } | null> {
  const answers = await safeAsk(deps, {
    state: { description: input.description.slice(0, 512), prompt: input.prompt?.slice(0, 512), remainingPool },
    questions: {
      tools: {
        type: "choice",
        instructions: "Smallest sufficient tool set for this role.",
        criteria: {
          read: "read-only inspection",
          edit: "needs file edits",
          exec: "needs shell execution",
        },
      },
      mode: {
        type: "choice",
        instructions: "Safest sufficient hire mode.",
        criteria: {
          read_only: "inspection only",
          approval_required: "writes or exec need a human gate",
        },
      },
      approval: { type: "noul", instructions: "Should this role require approval_required?" },
      perDay: {
        type: "score",
        instructions: "Daily token budget as a fraction of the remaining pool.",
        criteria: ["tiny", "moderate", "large"],
      },
    },
  });
  const toolKey = choice(answers, "tools");
  const tools = toolKey && TOOL_SETS[toolKey] ? TOOL_SETS[toolKey] : null;
  if (!tools) {
    logOf(deps)({ seam: "hire-suggest", fallback: true });
    return null;
  }
  const selectedMode = choice(answers, "mode");
  const mode: HireMode =
    selectedMode === "read_only" || selectedMode === "approval_required"
      ? selectedMode
      : (noul(answers, "approval") ?? 0) >= 0.5
        ? "approval_required"
        : "read_only";
  if (remainingPool < 1) {
    logOf(deps)({ seam: "hire-suggest", fallback: true });
    return null;
  }
  const fraction = Math.min(1, Math.max(0.05, score(answers, "perDay") ?? 0.2));
  const perDayTokens = Math.max(1, Math.min(remainingPool, Math.round(remainingPool * fraction) || 1));
  const perTaskTokens = Math.max(1, Math.min(perDayTokens, Math.round(perDayTokens / 4) || 1));
  const overlay = { mode, tools, perTaskTokens, perDayTokens };
  logOf(deps)({ seam: "hire-suggest", mode: overlay.mode, tools: overlay.tools, fallback: false });
  return overlay;
}

export function heuristicModelTier(slug: string): ModelTier {
  if (/luna|mini|spark/i.test(slug)) return "economy";
  if (/astra|pro|opus/i.test(slug)) return "powerful";
  return "balanced";
}

export async function overlayModelTier(
  slug: string,
  displayName: string,
  deps: JudgmentDeps = {},
): Promise<ModelTier> {
  const heuristic = heuristicModelTier(slug);
  if (heuristic !== "balanced") return heuristic;
  const answers = await safeAsk(deps, {
    state: { slug, displayName },
    questions: {
      tier: {
        type: "choice",
        instructions: "Classify this model id into a qualitative tier. Do not invent prices.",
        criteria: {
          economy: "small/fast/cheap",
          balanced: "general default",
          powerful: "large/slow/strong",
        },
      },
    },
  });
  const selected = choice(answers, "tier");
  const overlay = selected === "economy" || selected === "balanced" || selected === "powerful" ? selected : null;
  logOf(deps)({ seam: "model-tier", slug, heuristic, overlay, fallback: overlay == null });
  return overlay ?? heuristic;
}

export async function overlayTurnPolicy(
  state: {
    attachmentCount: number;
    historyCount: number;
    omittedTurnCount?: number;
    contextBytes?: number;
    mode: string;
    perTaskTokens?: number;
  },
  deps: JudgmentDeps = {},
): Promise<{ escalateApproval: boolean; needsHumanGate: boolean; perTurnTokens?: number } | null> {
  const answers = await safeAsk(deps, {
    state,
    questions: {
      escalate: { type: "noul", instructions: "Should this turn escalate to approval_required?" },
      gate: { type: "noul", instructions: "Does a human need to gate this turn?" },
      cap: {
        type: "score",
        instructions: "Fraction of the role per-task token budget this turn should use.",
        criteria: ["small", "medium", "most"],
      },
    },
  });
  if (!answers) {
    logOf(deps)({ seam: "turn-policy", fallback: true });
    return null;
  }
  const overlay = {
    escalateApproval: (noul(answers, "escalate") ?? 0) >= 0.5,
    needsHumanGate: (noul(answers, "gate") ?? 0) >= 0.5,
    perTurnTokens:
      state.perTaskTokens === undefined
        ? undefined
        : Math.max(100, Math.round(state.perTaskTokens * Math.min(1, Math.max(0.05, score(answers, "cap") ?? 0.5)))),
  };
  logOf(deps)({ seam: "turn-policy", ...overlay, fallback: false });
  return overlay;
}

export async function overlayDispatchPlan(
  members: string[],
  roles: Array<
    Pick<OrgRole, "id" | "name" | "mode"> &
      Partial<Pick<OrgRole, "description" | "toolAllow" | "toolDeny" | "memoryScope">> & {
        budget?: { perTask?: { tokens?: number } };
      }
  >,
  deps: JudgmentDeps = {},
): Promise<{ mentions: string[]; mode: "parallel" | "relay"; reviewerRelay: boolean } | null> {
  const questions: JevRequest["questions"] = {
    mode: {
      type: "choice",
      instructions: "Choose group execution mode.",
      criteria: { parallel: "independent specialists", relay: "sequential handoff" },
    },
    reviewer: { type: "noul", instructions: "Should a reviewer run last in relay?" },
  };
  for (const id of members) {
    questions[fitKey(id)] = {
      type: "score",
      instructions: "Fit of this member for the current task. 0 is prune, 1 is run first.",
      criteria: ["unfit", "supporting", "primary"],
    };
  }
  const answers = await safeAsk(deps, {
    state: {
      members,
      roles: roles.map((role) => ({
        id: role.id,
        name: role.name,
        mode: role.mode,
        description: role.description?.slice(0, 160),
        toolAllow: role.toolAllow?.slice(0, 12),
        toolDeny: role.toolDeny?.slice(0, 12),
        memoryScope: role.memoryScope,
        perTaskTokens: role.budget?.perTask?.tokens,
      })),
    },
    questions,
  });
  if (!answers) {
    logOf(deps)({ seam: "dispatch-plan", fallback: true });
    return null;
  }
  const mode = choice(answers, "mode");
  const scored = members.map((id) => ({ id, score: score(answers, fitKey(id)) }));
  const hasScores = scored.some((entry) => entry.score !== undefined);
  let mentions = hasScores
    ? [...scored].sort((left, right) => (right.score ?? 0) - (left.score ?? 0)).map((entry) => entry.id)
    : [...members];
  if (hasScores) {
    const kept = scored
      .filter((entry) => (entry.score ?? 0) >= 0.15)
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .map((entry) => entry.id);
    if (kept.length > 0) mentions = kept;
  }
  const overlay = {
    mentions,
    mode: (mode === "relay" || mode === "parallel" ? mode : "parallel") as "parallel" | "relay",
    reviewerRelay: (noul(answers, "reviewer") ?? 0) >= 0.5,
  };
  if (overlay.reviewerRelay && overlay.mode === "relay" && members.length > 0) {
    const reviewer = members[members.length - 1]!;
    if (overlay.mentions.includes(reviewer)) {
      overlay.mentions = [...overlay.mentions.filter((id) => id !== reviewer), reviewer];
    }
  }
  logOf(deps)({ seam: "dispatch-plan", ...overlay, fallback: false });
  return overlay;
}

export async function overlayRelayNext(
  remaining: string[],
  last: { status: string; errorCode?: string } | undefined,
  deps: JudgmentDeps = {},
): Promise<string | "STOP" | null> {
  if (remaining.length === 0) return null;
  const criteria: Record<string, string> = { STOP: "task is complete or remaining members add no value" };
  for (const id of remaining) criteria[id] = "run this member next";
  const answers = await safeAsk(deps, {
    state: { remaining, lastStatus: last?.status, lastErrorCode: last?.errorCode },
    questions: {
      next: { type: "choice", instructions: "Pick the next member or STOP.", criteria },
      complete: { type: "noul", instructions: "Is the group task already complete?" },
      gain: {
        type: "score",
        instructions: "Expected completeness gain versus remaining budget if another member runs.",
        criteria: ["none", "small", "worth it"],
      },
    },
  });
  const selected = choice(answers, "next");
  const complete = noul(answers, "complete") ?? 0;
  const gain = score(answers, "gain");
  if (complete >= 0.8 || selected === "STOP" || (gain !== undefined && gain < 0.15 && complete >= 0.5)) {
    logOf(deps)({ seam: "relay-next", next: "STOP", fallback: answers == null });
    return answers == null ? null : "STOP";
  }
  if (selected && remaining.includes(selected)) {
    logOf(deps)({ seam: "relay-next", next: selected, fallback: false });
    return selected;
  }
  logOf(deps)({ seam: "relay-next", fallback: true });
  return null;
}

export async function overlayNextOwner(
  candidates: string[],
  turn: { status: string; errorCode?: string; positionId?: string },
  deps: JudgmentDeps = {},
): Promise<{ positionId: string } | null> {
  if (candidates.length === 0) return null;
  const criteria: Record<string, string> = { NONE: "no follow-up owner" };
  for (const id of candidates) criteria[id] = "suggest this owner";
  const answers = await safeAsk(deps, {
    state: { status: turn.status, errorCode: turn.errorCode, positionId: turn.positionId, candidates },
    questions: {
      needed: { type: "noul", instructions: "Does this completed turn need a next owner?" },
      who: { type: "choice", instructions: "Who should own the follow-up, if anyone?", criteria },
    },
  });
  const needed = noul(answers, "needed") ?? 0;
  const who = choice(answers, "who");
  if (needed < 0.5 || !who || who === "NONE" || !candidates.includes(who)) {
    logOf(deps)({ seam: "next-owner", fallback: true });
    return null;
  }
  logOf(deps)({ seam: "next-owner", positionId: who, fallback: false });
  return { positionId: who };
}

export function shouldAutoDispatch(env: NodeJS.Dict<string> = process.env): boolean {
  return jevAutoDispatch(env);
}

/** Second pass after regex sanitize. Callers must pass already-sanitized text. */
export async function overlaySecretSecondPass(text: string, deps: JudgmentDeps = {}): Promise<boolean> {
  if (text.trim().length === 0) return false;
  const answers = await safeAsk(deps, {
    state: { length: text.length, sample: text.slice(0, 280) },
    questions: {
      secret: { type: "noul", instructions: "Does this span still contain a secret or PII after regex redaction?" },
    },
  });
  const hit = (noul(answers, "secret") ?? 0) >= 0.8;
  logOf(deps)({ seam: "redaction", hit, fallback: answers == null });
  return hit;
}
