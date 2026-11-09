/** Deterministic overlay processing receipts (#468). Local workspace only. */

export const overlayReceiptKinds = [
  "viewed",
  "suggestion_applied",
  "action_succeeded",
  "action_failed",
  "owner_resolved",
] as const;

export type OverlayReceiptKind = (typeof overlayReceiptKinds)[number];

export interface OverlayReceipt {
  kind: OverlayReceiptKind;
  at: string;
  itemId: string;
  actionId?: string;
}

export interface OverlayItemReceipts {
  itemId: string;
  receipts: OverlayReceipt[];
}

export function emptyOverlayReceipts(itemId: string): OverlayItemReceipts {
  return { itemId, receipts: [] };
}

function outcomeOf(item: OverlayItemReceipts, actionId: string): OverlayReceiptKind | undefined {
  const related = item.receipts.filter((receipt) => receipt.actionId === actionId);
  for (let index = related.length - 1; index >= 0; index -= 1) {
    const relatedReceipt = related[index];
    if (!relatedReceipt) continue;
    const kind = relatedReceipt.kind;
    if (kind === "action_succeeded" || kind === "action_failed") return kind;
  }
  return undefined;
}

export function trackedActionIds(item: OverlayItemReceipts): string[] {
  const ids: string[] = [];
  for (const receipt of item.receipts) {
    if (receipt.actionId && !ids.includes(receipt.actionId)) ids.push(receipt.actionId);
  }
  return ids;
}

/** Split view: each action keeps its latest success/failure independently. */
export function splitActionOutcomes(
  item: OverlayItemReceipts,
): { actionId: string; outcome: OverlayReceiptKind | undefined }[] {
  return trackedActionIds(item).map((actionId) => ({
    actionId,
    outcome: outcomeOf(item, actionId),
  }));
}

export function hasMixedActionOutcomes(item: OverlayItemReceipts): boolean {
  const outcomes = splitActionOutcomes(item)
    .map((entry) => entry.outcome)
    .filter((kind): kind is OverlayReceiptKind => kind === "action_succeeded" || kind === "action_failed");
  return outcomes.includes("action_succeeded") && outcomes.includes("action_failed");
}

/** Existing success events can resolve the whole item only when nothing failed. */
export function hasUnanimousSuccess(item: OverlayItemReceipts): boolean {
  const outcomes = splitActionOutcomes(item);
  if (outcomes.length === 0) return item.receipts.some((receipt) => receipt.kind === "action_succeeded");
  return (
    outcomes.every((entry) => entry.outcome === "action_succeeded") &&
    outcomes.some((entry) => entry.outcome === "action_succeeded")
  );
}

export function isOverlayResolved(item: OverlayItemReceipts): boolean {
  if (item.receipts.some((receipt) => receipt.kind === "owner_resolved")) return true;
  if (hasMixedActionOutcomes(item)) return false;
  return hasUnanimousSuccess(item);
}

/**
 * Record a receipt. Button clicks must use suggestion_applied — that kind
 * never marks the item resolved. Mixed outcomes do not auto-resolve; an
 * explicit owner_resolved receipt still may.
 */
export function recordOverlayReceipt(
  item: OverlayItemReceipts,
  receipt: OverlayReceipt,
): OverlayItemReceipts {
  if (receipt.itemId !== item.itemId) return item;
  return {
    itemId: item.itemId,
    receipts: [...item.receipts, receipt],
  };
}

export function outcomeFromEvidenceStatus(
  status: "running" | "completed" | "failed" | "indeterminate",
): boolean | undefined {
  if (status === "completed") return true;
  if (status === "failed" || status === "indeterminate") return false;
  return undefined;
}

export function clickDoesNotResolve(
  item: OverlayItemReceipts,
  at: string,
  actionId: string,
): OverlayItemReceipts {
  return recordOverlayReceipt(item, {
    kind: "suggestion_applied",
    at,
    itemId: item.itemId,
    actionId,
  });
}
