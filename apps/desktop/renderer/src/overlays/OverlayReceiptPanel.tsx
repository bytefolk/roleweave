import { Button } from "antd";
import { useEffect, useState } from "react";
import { useT } from "@roleweave/ui";
import {
  hasMixedActionOutcomes,
  isOverlayResolved,
  outcomeFromEvidenceStatus,
  splitActionOutcomes,
  type OverlayItemReceipts,
} from "./overlay-receipts.js";
import {
  OVERLAY_ACTION_OUTCOME,
  OVERLAY_RECEIPTS_CHANGED,
  appendOverlayReceipt,
  latestActionOutcome,
  readOverlayReceipts,
  type OverlayActionOutcomeDetail,
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
    const onOutcome = (event: Event) => {
      const detail = (event as CustomEvent<OverlayActionOutcomeDetail>).detail;
      if (detail?.itemId !== itemId || !detail.actionId || typeof detail.ok !== "boolean") return;
      recordActionOutcome(workspaceKey, itemId, detail.actionId, detail.ok);
    };
    window.addEventListener(OVERLAY_RECEIPTS_CHANGED, onChange);
    window.addEventListener(OVERLAY_ACTION_OUTCOME, onOutcome);
    return () => {
      window.removeEventListener(OVERLAY_RECEIPTS_CHANGED, onChange);
      window.removeEventListener(OVERLAY_ACTION_OUTCOME, onOutcome);
    };
  }, [workspaceKey, itemId]);
  useEffect(() => {
    if (!enabled) return;
    const current = readOverlayReceipts(workspaceKey, itemId);
    if (current.receipts.some((receipt) => receipt.kind === "viewed")) {
      setItem(current);
      return;
    }
    setItem(
      appendOverlayReceipt(workspaceKey, itemId, {
        kind: "viewed",
        at: new Date().toISOString(),
      }),
    );
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
        disabled={resolved}
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
  const current = readOverlayReceipts(workspaceKey, itemId);
  const expected = ok ? "action_succeeded" : "action_failed";
  if (latestActionOutcome(current, actionId) === expected) return current;
  return appendOverlayReceipt(workspaceKey, itemId, {
    kind: expected,
    at: new Date().toISOString(),
    actionId,
  });
}

export function syncEvidenceActionOutcome(
  workspaceKey: string | undefined,
  itemId: string,
  actionId: string,
  status: "running" | "completed" | "failed" | "indeterminate",
): OverlayItemReceipts {
  const ok = outcomeFromEvidenceStatus(status);
  if (ok === undefined) return readOverlayReceipts(workspaceKey, itemId);
  return recordActionOutcome(workspaceKey, itemId, actionId, ok);
}
