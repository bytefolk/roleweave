import { describe, expect, it } from "vitest";
import {
  clickDoesNotResolve,
  emptyOverlayReceipts,
  hasMixedActionOutcomes,
  isOverlayResolved,
  outcomeFromEvidenceStatus,
  recordOverlayReceipt,
  splitActionOutcomes,
} from "../src/overlays/overlay-receipts";
import { syncEvidenceActionOutcome } from "../src/overlays/OverlayReceiptPanel";

const at = "2026-09-24T17:00:00.000Z";

describe("overlay processing receipts (#468)", () => {
  it("does not treat a button click as resolved", () => {
    const started = emptyOverlayReceipts("goal-one");
    const viewed = recordOverlayReceipt(started, {
      kind: "viewed",
      at,
      itemId: "goal-one",
    });
    const clicked = clickDoesNotResolve(viewed, at, "open-turn");
    expect(clicked.receipts.map((receipt) => receipt.kind)).toEqual([
      "viewed",
      "suggestion_applied",
    ]);
    expect(isOverlayResolved(clicked)).toBe(false);
  });

  it("splits mixed success and failure instead of resolving the item", () => {
    let item = emptyOverlayReceipts("esc-one");
    item = recordOverlayReceipt(item, {
      kind: "suggestion_applied",
      at,
      itemId: "esc-one",
      actionId: "trace-a",
    });
    item = recordOverlayReceipt(item, {
      kind: "action_succeeded",
      at,
      itemId: "esc-one",
      actionId: "trace-a",
    });
    item = recordOverlayReceipt(item, {
      kind: "suggestion_applied",
      at,
      itemId: "esc-one",
      actionId: "trace-b",
    });
    item = recordOverlayReceipt(item, {
      kind: "action_failed",
      at,
      itemId: "esc-one",
      actionId: "trace-b",
    });
    expect(hasMixedActionOutcomes(item)).toBe(true);
    expect(isOverlayResolved(item)).toBe(false);
    expect(splitActionOutcomes(item)).toEqual([
      { actionId: "trace-a", outcome: "action_succeeded" },
      { actionId: "trace-b", outcome: "action_failed" },
    ]);
    const confirmed = recordOverlayReceipt(item, {
      kind: "owner_resolved",
      at,
      itemId: "esc-one",
    });
    expect(confirmed.receipts.some((receipt) => receipt.kind === "action_failed")).toBe(true);
    expect(confirmed.receipts.some((receipt) => receipt.kind === "owner_resolved")).toBe(true);
    expect(hasMixedActionOutcomes(confirmed)).toBe(true);
    expect(isOverlayResolved(confirmed)).toBe(true);
  });

  it("can resolve from existing success events or an explicit owner confirm", () => {
    let item = emptyOverlayReceipts("goal-two");
    item = recordOverlayReceipt(item, {
      kind: "action_succeeded",
      at,
      itemId: "goal-two",
      actionId: "open-approvals",
    });
    expect(isOverlayResolved(item)).toBe(true);

    let pending = emptyOverlayReceipts("goal-three");
    pending = recordOverlayReceipt(pending, {
      kind: "viewed",
      at,
      itemId: "goal-three",
    });
    expect(isOverlayResolved(pending)).toBe(false);
    pending = recordOverlayReceipt(pending, {
      kind: "owner_resolved",
      at,
      itemId: "goal-three",
    });
    expect(isOverlayResolved(pending)).toBe(true);
  });

  it("maps persisted evidence status to action outcomes without treating a click as success", () => {
    expect(outcomeFromEvidenceStatus("running")).toBeUndefined();
    expect(outcomeFromEvidenceStatus("completed")).toBe(true);
    expect(outcomeFromEvidenceStatus("failed")).toBe(false);
    const clicked = clickDoesNotResolve(emptyOverlayReceipts("esc-two"), at, "trace-run");
    expect(isOverlayResolved(clicked)).toBe(false);
    const fromEvidence = recordOverlayReceipt(clicked, {
      kind: "action_failed",
      at,
      itemId: "esc-two",
      actionId: "trace-run",
    });
    expect(fromEvidence.receipts.map((receipt) => receipt.kind)).toEqual([
      "suggestion_applied",
      "action_failed",
    ]);
    expect(isOverlayResolved(fromEvidence)).toBe(false);
  });

  it("maps original-turn evidence separately from later processing actions", () => {
    const failed = syncEvidenceActionOutcome("ws-one", "esc-ev", "source-execution", "failed");
    expect(failed.receipts.map((receipt) => receipt.kind)).toEqual(["action_failed"]);
    expect(failed.receipts[0]?.actionId).toBe("source-execution");
    expect(isOverlayResolved(failed)).toBe(false);
    const running = syncEvidenceActionOutcome("ws-one", "esc-ev", "source-execution", "running");
    expect(running.receipts.map((receipt) => receipt.kind)).toEqual(["action_failed"]);
    const clicked = clickDoesNotResolve(failed, at, "trace-run");
    expect(clicked.receipts.map((receipt) => receipt.actionId)).toEqual([
      "source-execution",
      "trace-run",
    ]);
    expect(isOverlayResolved(clicked)).toBe(false);
  });
});
