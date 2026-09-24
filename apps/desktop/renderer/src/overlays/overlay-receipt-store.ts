import {
  emptyOverlayReceipts,
  recordOverlayReceipt,
  type OverlayItemReceipts,
  type OverlayReceipt,
} from "./overlay-receipts.js";

export const OVERLAY_RECEIPTS_CHANGED = "roleweave-overlay-receipts";

const memory = new Map<string, OverlayItemReceipts>();

export function overlayReceiptStorageKey(workspaceKey: string, itemId: string): string {
  return `roleweave.overlay-receipts.v1:${workspaceKey}:${itemId}`;
}

function bucket(workspaceKey: string | undefined, itemId: string): string {
  return `${workspaceKey ?? ""}:${itemId}`;
}

export function readOverlayReceipts(
  workspaceKey: string | undefined,
  itemId: string,
): OverlayItemReceipts {
  const cached = memory.get(bucket(workspaceKey, itemId));
  if (cached) return cached;
  const empty = emptyOverlayReceipts(itemId);
  if (!workspaceKey || typeof localStorage === "undefined") return empty;
  try {
    const raw = localStorage.getItem(overlayReceiptStorageKey(workspaceKey, itemId));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as OverlayItemReceipts;
    if (parsed.itemId !== itemId || !Array.isArray(parsed.receipts)) return empty;
    memory.set(bucket(workspaceKey, itemId), parsed);
    return parsed;
  } catch {
    return empty;
  }
}

export function writeOverlayReceipts(
  workspaceKey: string | undefined,
  item: OverlayItemReceipts,
): void {
  memory.set(bucket(workspaceKey, item.itemId), item);
  if (!workspaceKey || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(overlayReceiptStorageKey(workspaceKey, item.itemId), JSON.stringify(item));
  } catch {
    /* quota / private mode: receipts stay in memory */
  }
}

export function appendOverlayReceipt(
  workspaceKey: string | undefined,
  itemId: string,
  receipt: Omit<OverlayReceipt, "itemId"> & { itemId?: string },
): OverlayItemReceipts {
  const current = readOverlayReceipts(workspaceKey, itemId);
  const next = recordOverlayReceipt(current, { ...receipt, itemId });
  writeOverlayReceipts(workspaceKey, next);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OVERLAY_RECEIPTS_CHANGED, { detail: { itemId } }));
  }
  return next;
}
