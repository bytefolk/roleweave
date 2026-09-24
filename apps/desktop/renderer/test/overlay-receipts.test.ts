import { describe, expect, it } from "vitest";
import {
  clickDoesNotResolve,
  emptyOverlayReceipts,
  hasMixedActionOutcomes,
  isOverlayResolved,
  recordOverlayReceipt,
  splitActionOutcomes,
} from "../src/overlays/overlay-receipts";

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
    const denied = recordOverlayReceipt(item, {
      kind: "owner_resolved",
      at,
      itemId: "esc-one",
    });
    expect(denied.receipts.some((receipt) => receipt.kind === "owner_resolved")).toBe(false);
    expect(isOverlayResolved(denied)).toBe(false);
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
});
