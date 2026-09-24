import { Button } from "antd";
import { useEffect, useState } from "react";
import { useT } from "@roleweave/ui";
import {
  hasMixedActionOutcomes,
  isOverlayResolved,
  splitActionOutcomes,
  type OverlayItemReceipts,
} from "./overlay-receipts.js";
import {
  OVERLAY_RECEIPTS_CHANGED,
  appendOverlayReceipt,
  readOverlayReceipts,
} from "./overlay-receipt-store.js";

export function OverlayReceiptPanel({
  workspaceKey,
  itemId,
  enabled,
}: {
  workspaceKey?: string;
  itemId: string;
  enabled: boolean;
}) {
  const t = useT();
  const [item, setItem] = useState<OverlayItemReceipts>(() =>
    readOverlayReceipts(workspaceKey, itemId),
  );
  useEffect(() => {
    setItem(readOverlayReceipts(workspaceKey, itemId));
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId?: string }>).detail;
      if (detail?.itemId === itemId) setItem(readOverlayReceipts(workspaceKey, itemId));
    };
    window.addEventListener(OVERLAY_RECEIPTS_CHANGED, onChange);
    return () => window.removeEventListener(OVERLAY_RECEIPTS_CHANGED, onChange);
  }, [workspaceKey, itemId]);
  useEffect(() => {
    if (!enabled) return;
    setItem((current) => {
      if (current.receipts.some((receipt) => receipt.kind === "viewed")) return current;
      return appendOverlayReceipt(workspaceKey, itemId, {
        kind: "viewed",
        at: new Date().toISOString(),
      });
    });
  }, [enabled, itemId, workspaceKey]);
  if (!enabled) return null;
  const mixed = hasMixedActionOutcomes(item);
  const resolved = isOverlayResolved(item);
  return (
    <section className="owb-overlay-receipts" data-testid="overlay-receipts" aria-label={t("overlay.receipts")}>
      <p data-testid="overlay-receipt-status">
        {resolved ? t("overlay.resolved") : mixed ? t("overlay.mixed") : t("overlay.open")}
      </p>
      <ol>
        {item.receipts.map((receipt, index) => (
          <li key={`${receipt.kind}-${receipt.at}-${index}`} data-kind={receipt.kind}>
            {t(`overlay.kind.${receipt.kind}`)}
            {receipt.actionId ? ` · ${receipt.actionId}` : ""}
          </li>
        ))}
      </ol>
      {splitActionOutcomes(item).length > 0 ? (
        <ul data-testid="overlay-receipt-split">
          {splitActionOutcomes(item).map((entry) => (
            <li key={entry.actionId} data-action={entry.actionId} data-outcome={entry.outcome ?? "pending"}>
              {entry.actionId}: {t(`overlay.kind.${entry.outcome ?? "suggestion_applied"}`)}
            </li>
          ))}
        </ul>
      ) : null}
      <Button
        size="small"
        data-testid="overlay-owner-resolve"
        disabled={resolved || mixed}
        onClick={() =>
          setItem(
            appendOverlayReceipt(workspaceKey, itemId, {
              kind: "owner_resolved",
              at: new Date().toISOString(),
            }),
          )
        }
      >
        {t("overlay.ownerConfirm")}
      </Button>
    </section>
  );
}

export function recordSuggestionClick(
  workspaceKey: string | undefined,
  itemId: string,
  actionId: string,
): OverlayItemReceipts {
  return appendOverlayReceipt(workspaceKey, itemId, {
    kind: "suggestion_applied",
    at: new Date().toISOString(),
    actionId,
  });
}

export function recordActionOutcome(
  workspaceKey: string | undefined,
  itemId: string,
  actionId: string,
  ok: boolean,
): OverlayItemReceipts {
  return appendOverlayReceipt(workspaceKey, itemId, {
    kind: ok ? "action_succeeded" : "action_failed",
    at: new Date().toISOString(),
    actionId,
  });
}
