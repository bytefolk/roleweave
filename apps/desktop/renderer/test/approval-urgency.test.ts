import { describe, expect, it } from "vitest";
import { approvalExpiryState, approvalUrgency, type ApprovalQueueItem } from "../src/approvals/types";

const baseItem: ApprovalQueueItem = {
  approvalId: "test-approval",
  positionId: "test-position",
  category: "write",
  description: "Test description",
  decision: { kind: "pending" },
};

describe("approvalUrgency", () => {
  it("returns critical for expired items", () => {
    const item: ApprovalQueueItem = {
      ...baseItem,
      expiresAt: "2020-01-01T00:00:00Z",
    };
    const now = Date.parse("2026-09-20T00:00:00Z");
    expect(approvalUrgency(item, now)).toBe("critical");
    expect(approvalExpiryState(item, now)).toBe("expired");
  });

  it("returns warning for items expiring within 24 hours", () => {
    const now = Date.parse("2026-09-20T12:00:00Z");
    const item: ApprovalQueueItem = {
      ...baseItem,
      expiresAt: "2026-09-21T00:00:00Z", // 12 hours from now
    };
    expect(approvalUrgency(item, now)).toBe("warning");
    expect(approvalExpiryState(item, now)).toBe("expiring");
  });

  it("returns normal for active items", () => {
    const now = Date.parse("2026-09-20T00:00:00Z");
    const item: ApprovalQueueItem = {
      ...baseItem,
      expiresAt: "2026-09-25T00:00:00Z", // 5 days from now
    };
    expect(approvalUrgency(item, now)).toBe("normal");
    expect(approvalExpiryState(item, now)).toBe("active");
  });

  it("returns normal for items without expiry", () => {
    const item: ApprovalQueueItem = { ...baseItem };
    const now = Date.parse("2026-09-20T00:00:00Z");
    expect(approvalUrgency(item, now)).toBe("normal");
  });

  it("returns critical for items with decided=expired status", () => {
    const item: ApprovalQueueItem = {
      ...baseItem,
      decision: { kind: "expired" },
    };
    const now = Date.parse("2026-09-20T00:00:00Z");
    expect(approvalUrgency(item, now)).toBe("critical");
  });
});
