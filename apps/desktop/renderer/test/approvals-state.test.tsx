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
});
