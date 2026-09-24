import type { ApprovalContext, ApprovalRiskLevel, ApprovalStatus } from "@roleweave/shared";
import { askLaya, type LayaAsk } from "../laya/client.js";
import { layaEnabled } from "../laya/config.js";

export type AgingChoice = "nudge" | "wait" | "discuss-close";

export interface AgingQueueRow {
  id: string;
  createdAt: string;
  now: number;
  decision: { kind: ApprovalStatus | string };
  risk: ApprovalRiskLevel;
}

export interface AgingSuggestion {
  choice: AgingChoice;
  needsAttention: boolean;
}

const AGING_CHOICES = new Set<AgingChoice>(["nudge", "wait", "discuss-close"]);

function ruleRiskLayer(risk: ApprovalRiskLevel): number {
  return risk === "high" ? 0 : 1;
}

export function agingNeedsAttention(choice: AgingChoice): boolean {
  return choice === "nudge";
}

/** Deterministic age from the injected clock. Expiry stays on existing helpers. */
export function agingAgeMs(createdAt: string, now: number): number | undefined {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created) || !Number.isFinite(now)) return undefined;
  return Math.max(0, now - created);
}

/** Overlay may reorder inside a rule-risk layer. It must not drop pending high.
 * With no overlay, the original order is preserved so flag-off lists stay byte-stable. */
export function presentAgingQueue<T extends AgingQueueRow>(
  items: readonly T[],
  overlays: Readonly<Record<string, AgingSuggestion | undefined>>,
): T[] {
  const hasOverlay = items.some((item) => overlays[item.id] !== undefined);
  if (!hasOverlay) return [...items];
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const layer = ruleRiskLayer(a.item.risk) - ruleRiskLayer(b.item.risk);
      if (layer !== 0) return layer;
      const aAttention = overlays[a.item.id]?.needsAttention === true ? 0 : 1;
      const bAttention = overlays[b.item.id]?.needsAttention === true ? 0 : 1;
      if (aAttention !== bAttention) return aAttention - bAttention;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

export function rankApprovalViews<T extends {
  id: string;
  createdAt: string;
  status: string;
  context?: { risk?: ApprovalRiskLevel; agingOverlay?: AgingChoice };
}>(views: readonly T[], now: number): T[] {
  const overlays: Record<string, AgingSuggestion | undefined> = {};
  const rows = views.map((view) => {
    const choice = view.context?.agingOverlay;
    if (choice) overlays[view.id] = { choice, needsAttention: agingNeedsAttention(choice) };
    return {
      id: view.id,
      createdAt: view.createdAt,
      now,
      decision: { kind: view.status },
      risk: (view.context?.risk === "high" ? "high" : "medium") as ApprovalRiskLevel,
      view,
    };
  });
  return presentAgingQueue(rows, overlays).map((row) => row.view);
}

/** Kind-and-clock payload. Description, target, and turn bodies are forbidden. */
export function assertAgingAdvicePayload(payload: Record<string, unknown>): void {
  const allowed = new Set(["createdAt", "now", "decision", "risk"]);
  const extra = Object.keys(payload).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new Error(`laya approval-aging payload has forbidden keys: ${extra.sort().join(",")}`);
  }
  if (typeof payload.createdAt !== "string" || !Number.isFinite(Date.parse(payload.createdAt))) {
    throw new Error("laya approval-aging payload createdAt is invalid");
  }
  if (typeof payload.now !== "number" || !Number.isFinite(payload.now)) {
    throw new Error("laya approval-aging payload now is invalid");
  }
  const decision = payload.decision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision) || Object.keys(decision as object).some((key) => key !== "kind")) {
    throw new Error("laya approval-aging payload decision is invalid");
  }
  const kind = (decision as { kind?: unknown }).kind;
  if (typeof kind !== "string" || kind.length === 0) {
    throw new Error("laya approval-aging payload decision.kind is invalid");
  }
  if (payload.risk !== "medium" && payload.risk !== "high") {
    throw new Error("laya approval-aging payload risk is invalid");
  }
}

export function mapAdviceChoiceToAging(choice: string): AgingChoice | null {
  return AGING_CHOICES.has(choice as AgingChoice) ? choice as AgingChoice : null;
}

export interface ResolveApprovalAgingOverlayDeps {
  env?: NodeJS.Dict<string>;
  ask?: LayaAsk;
  now?: number;
}

export function agingAdviceState(input: {
  createdAt: string;
  now: number;
  decisionKind: string;
  risk: ApprovalRiskLevel;
}): Record<string, unknown> {
  return {
    createdAt: input.createdAt,
    now: input.now,
    decision: { kind: input.decisionKind },
    risk: input.risk,
  };
}

/** Advisory overlay. Undefined when the flag is off, the item is not pending, or advice is invalid. */
export async function resolveApprovalAgingOverlay(
  input: { createdAt: string; decisionKind: string; risk: ApprovalRiskLevel },
  deps: ResolveApprovalAgingOverlayDeps = {},
): Promise<AgingChoice | undefined> {
  if (input.decisionKind !== "pending") return undefined;
  const env = deps.env ?? process.env;
  if (!layaEnabled(env)) return undefined;
  const now = deps.now ?? Date.now();
  const payload = agingAdviceState({ ...input, now });
  assertAgingAdvicePayload(payload);
  const ask = deps.ask ?? ((request) => askLaya(request, { env }));
  try {
    const answers = await ask({
      state: payload,
      questions: {
        aging: {
          type: "choice",
          instructions: "Suggest display copy for a pending approval's age. Advisory. Never grant or deny.",
          criteria: {
            nudge: "Still waiting and the owner should look soon",
            wait: "Stale but still a normal pending wait",
            "discuss-close": "Owner may discuss closing; copy only, never a verdict",
          },
        },
      },
    });
    const selected = answers?.aging?.type === "choice" ? answers.aging.selected : undefined;
    if (!selected) return undefined;
    return mapAdviceChoiceToAging(selected) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Projection-only: never persist the result and never post a decision. */
export async function attachApprovalAgingOverlay(
  context: ApprovalContext,
  input: { createdAt: string; decisionKind: string },
  deps: ResolveApprovalAgingOverlayDeps = {},
): Promise<ApprovalContext> {
  const { agingOverlay: _ignored, ...base } = context as ApprovalContext & { agingOverlay?: AgingChoice };
  const overlay = await resolveApprovalAgingOverlay({
    createdAt: input.createdAt,
    decisionKind: input.decisionKind,
    risk: base.risk,
  }, deps);
  if (!overlay) return base;
  return { ...base, agingOverlay: overlay } as ApprovalContext;
}
