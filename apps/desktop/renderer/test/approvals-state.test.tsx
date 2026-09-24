import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalView } from "@roleweave/shared";
import { useApprovals } from "../src/approvals/useApprovals";

const row: ApprovalView = {
  schemaVersion: "workbench-approval.v1", id: "a".repeat(64), version: 1, approvalId: "engine-id",
  source: { kind: "session", positionId: "owner", conversationId: "session", turnId: "turn", runId: "run", engine: "qoder" },
  action: { kind: "write", description: "Write report" }, status: "pending", canDecide: true,
  execution: { phase: "not_started" }, requestedAt: "2026-09-18T00:00:00Z", createdAt: "2026-09-18T00:00:00Z", updatedAt: "2026-09-18T00:00:00Z",
};
const page = (items = [row], token = "token") => ({ status: 200, body: { items, workspaceToken: token, nextCursor: null, pendingCount: items.length, revision: "1", syncState: "ready" } });
const original = window.owb;
afterEach(() => { window.owb = original; });
function bridge(overrides: Record<string, unknown>) {
  window.owb = { onEvent: () => () => {}, onSseStatus: () => () => {}, ...overrides } as unknown as typeof window.owb;
}
describe("authoritative approval state", () => {
  it("locks duplicate clicks and shares the saved verdict without waiting for execution", async () => {
    let release!: (result: unknown) => void;
    const saved = { ...row, status: "granted" as const, canDecide: false, execution: { phase: "running" as const } };
    let snapshot = [row];
    const decideApproval = vi.fn(() => new Promise(resolve => { release = resolve; }));
    bridge({ listApprovals: vi.fn(async () => page(snapshot)), decideApproval });
    const { result } = renderHook(() => useApprovals("/a"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    let pending!: Promise<void>;
    act(() => { pending = result.current.decide(row.id, "granted"); void result.current.decide(row.id, "denied"); });
    expect(decideApproval).toHaveBeenCalledTimes(1);
    expect(result.current.busy.has(row.id)).toBe(true);
    snapshot = [saved];
    await act(async () => { release({ status: 202, body: saved }); await pending; });
    expect(result.current.items[0]!.status).toBe("granted");
    expect(result.current.items[0]!.execution.phase).toBe("running");
    expect(result.current.busy.size).toBe(0);
  });
  it("reuses the request id after an unknown network result", async () => {
    const decideApproval = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ status: 202, body: { ...row, status: "denied", canDecide: false } });
    bridge({ listApprovals: vi.fn(async () => page()), decideApproval });
    const { result } = renderHook(() => useApprovals("/a"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(() => result.current.decide(row.id, "denied", "reason"));
    expect(result.current.errors[row.id]).toBe("offline");
    await act(() => result.current.decide(row.id, "denied", "reason"));
    expect(decideApproval.mock.calls[0]![0].requestId).toBe(decideApproval.mock.calls[1]![0].requestId);
  });
  it("sends a run boundary only when the caller selected it and keeps it for retry", async () => {
    const eligible = { ...row, context: {
      risk: "high" as const, requestedCapability: "write" as const, impact: "workspace_write" as const,
      permissions: { mode: "approval_required" as const, allowedTools: [], deniedTools: [] },
      preview: { status: "unavailable" as const, reason: "engine_preview_not_supplied" as const },
      scope: { allowed: ["once", "run"] as Array<"once" | "run"> },
    } };
    const decideApproval = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ status: 202, body: { ...eligible, status: "granted", decision: { scope: "run" } } });
    bridge({ listApprovals: vi.fn(async () => page([eligible])), decideApproval });
    const { result } = renderHook(() => useApprovals("/a"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(() => result.current.decide(row.id, "granted", undefined, "run"));
    await act(() => result.current.decide(row.id, "granted", undefined, "run"));
    expect(decideApproval.mock.calls[0]![0].scope).toBe("run");
    expect(decideApproval.mock.calls[1]![0].scope).toBe("run");
    expect(decideApproval.mock.calls[0]![0].requestId).toBe(decideApproval.mock.calls[1]![0].requestId);
  });
  it("drops responses from a prior workspace generation including A → B → A", async () => {
    let release!: (value: unknown) => void;
    const listApprovals = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockImplementation(async () => page([], "new"));
    bridge({ listApprovals });
    const { result, rerender } = renderHook(({ path }) => useApprovals(path), { initialProps: { path: "/a" } });
    rerender({ path: "/b" });
    await waitFor(() => expect(result.current.ready).toBe(true));
    rerender({ path: "/a" });
    await waitFor(() => expect(listApprovals).toHaveBeenCalledTimes(3));
    await act(async () => { release(page()); });
    expect(result.current.items).toEqual([]);
  });
  it("reconnect refresh reloads persisted decisions; read failure preserves the last snapshot", async () => {
    const listApprovals = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page([{ ...row, status: "expired", canDecide: false }])).mockRejectedValueOnce(new Error("offline"));
    bridge({ listApprovals });
    const { result } = renderHook(() => useApprovals("/a"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(() => result.current.refresh());
    await waitFor(() => expect(result.current.items[0]!.status).toBe("expired"));
    await act(() => result.current.refresh());
    expect(result.current.error).toBe("offline");
    expect(result.current.items[0]!.status).toBe("expired");
  });
  it("allows retrying batch with updated reason after partial rejection", async () => {
    const row2: ApprovalView = { ...row, id: "b".repeat(64), approvalId: "engine-id-2" };
    const decideApprovalsBatch = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        body: {
          items: [
            { id: row.id, status: "rejected", message: "conflict" },
            { id: row2.id, status: "rejected", message: "conflict" },
          ],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          items: [
            { id: row.id, status: "accepted", record: { ...row, status: "granted", canDecide: false } },
            { id: row2.id, status: "accepted", record: { ...row2, status: "granted", canDecide: false } },
          ],
        },
      });
    bridge({ listApprovals: vi.fn(async () => page([row, row2])), decideApprovalsBatch });
    const { result } = renderHook(() => useApprovals("/a"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(() => result.current.decideBatch([row.id, row2.id], "first reason"));
    expect(result.current.errors[row.id]).toBe("conflict");

    // After rejection, operator changes reason to retry without getting retrySameDecision error
    await act(() => result.current.decideBatch([row.id, row2.id], "updated reason"));
    expect(decideApprovalsBatch).toHaveBeenCalledTimes(2);
    expect(decideApprovalsBatch.mock.calls[1]![0].reason).toBe("updated reason");
  });
  it("allows retrying batch with updated reason after transport failure or 5xx error", async () => {
    const row2: ApprovalView = { ...row, id: "b".repeat(64), approvalId: "engine-id-2" };
    const decideApprovalsBatch = vi.fn()
      .mockRejectedValueOnce(new Error("Network connection lost"))
      .mockResolvedValueOnce({ status: 500, body: { message: "Internal Server Error" } })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          items: [
            { id: row.id, status: "accepted", record: { ...row, status: "granted", canDecide: false } },
            { id: row2.id, status: "accepted", record: { ...row2, status: "granted", canDecide: false } },
          ],
        },
      });
    bridge({ listApprovals: vi.fn(async () => page([row, row2])), decideApprovalsBatch });
    const { result } = renderHook(() => useApprovals("/a"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    // Attempt 1: Transport / network failure
    await act(() => result.current.decideBatch([row.id, row2.id], "attempt 1"));
    expect(result.current.errors[row.id]).toBe("Network connection lost");

    // Attempt 2: Operator retries with updated reason after network failure, hits 500
    await act(() => result.current.decideBatch([row.id, row2.id], "attempt 2"));
    expect(result.current.errors[row.id]).toBe("Internal Server Error");

    // Attempt 3: Operator retries with updated reason after 500, succeeds
    await act(() => result.current.decideBatch([row.id, row2.id], "attempt 3"));
    expect(decideApprovalsBatch).toHaveBeenCalledTimes(3);
    expect(decideApprovalsBatch.mock.calls[2]![0].reason).toBe("attempt 3");
  });
  it("coalesces concurrent refresh requests and returns fresh items directly", async () => {
    let release!: (value: unknown) => void;
    const delayedPage = () => new Promise(resolve => { release = resolve; });
    const listApprovals = vi.fn()
      .mockResolvedValueOnce(page([row]))
      .mockImplementationOnce(() => delayedPage())
      .mockResolvedValue(page([{ ...row, version: 2 }]));
    bridge({ listApprovals });
    const { result } = renderHook(() => useApprovals("/a"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    let p1!: Promise<ApprovalView[]>;
    let p2!: Promise<ApprovalView[]>;
    act(() => {
      p1 = result.current.refresh();
      p2 = result.current.refresh();
    });
    let r1!: ApprovalView[], r2!: ApprovalView[];
    await act(async () => {
      release(page([{ ...row, version: 2 }]));
      [r1, r2] = await Promise.all([p1, p2]);
    });
    expect(r1[0]!.version).toBe(2);
    expect(r2[0]!.version).toBe(2);
  });
  it("fetches fresh snapshot on refresh and enables deciding newly discovered items", async () => {
    const decideApproval = vi.fn().mockResolvedValue({ status: 202, body: { ...row, status: "granted", canDecide: false } });
    const listApprovals = vi.fn()
      .mockResolvedValueOnce(page([]))
      .mockResolvedValue(page([row]));
    bridge({ listApprovals, decideApproval });
    const { result } = renderHook(() => useApprovals("/a"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.items).toEqual([]);

    let fresh!: ApprovalView[];
    await act(async () => {
      fresh = await result.current.refresh();
    });
    expect(fresh.length).toBe(1);
    expect(fresh[0]!.id).toBe(row.id);

    await act(() => result.current.decide(fresh[0]!.id, "granted"));
    expect(decideApproval).toHaveBeenCalledTimes(1);
    expect(decideApproval.mock.calls[0]![0].id).toBe(row.id);
  });
  it("handles serialized bulk deny with partial failure and subsequent retry", async () => {
    const row2: ApprovalView = { ...row, id: "b".repeat(64), approvalId: "engine-id-2", version: 1 };
    let currentStore = [row, row2];
    const listApprovals = vi.fn(async () => page(currentStore));
    const decideApproval = vi.fn()
      // First attempt: row succeeds, row2 fails with 500
      .mockImplementationOnce(async () => {
        const updated = { ...row, status: "denied" as const, canDecide: false };
        currentStore = [updated, row2];
        return { status: 200, body: updated };
      })
      .mockResolvedValueOnce({ status: 500, body: { message: "Database busy" } })
      // Retry attempt: row2 succeeds
      .mockImplementationOnce(async () => {
        const updated2 = { ...row2, status: "denied" as const, canDecide: false };
        currentStore = [currentStore[0]!, updated2];
        return { status: 200, body: updated2 };
      });

    bridge({ listApprovals, decideApproval });
    const { result } = renderHook(() => useApprovals("/a"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    let outcome1!: { succeeded: string[]; failed: string[] };
    await act(async () => {
      outcome1 = await result.current.denyBatch([row.id, row2.id], "policy violation");
    });

    expect(outcome1.succeeded).toEqual([row.id]);
    expect(outcome1.failed).toEqual([row2.id]);
    expect(result.current.errors[row2.id]).toBe("Database busy");
    expect(result.current.items.find(i => i.id === row.id)?.status).toBe("denied");

    // Operator retries the failed item
    let outcome2!: { succeeded: string[]; failed: string[] };
    await act(async () => {
      outcome2 = await result.current.denyBatch([row2.id], "updated reason");
    });

    expect(outcome2.succeeded).toEqual([row2.id]);
    expect(outcome2.failed).toEqual([]);
    expect(result.current.items.find(i => i.id === row2.id)?.status).toBe("denied");
    expect(decideApproval).toHaveBeenCalledTimes(3);
  });
});
