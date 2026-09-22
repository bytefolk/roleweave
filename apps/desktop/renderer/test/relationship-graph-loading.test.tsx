import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RelationshipGraphResponse } from "@roleweave/shared/relationship-graph";
import type { OwbBridge } from "../src/owb";
import { useRelationshipGraph } from "../src/graph/useRelationshipGraph";

function graph(workspaceId: string): RelationshipGraphResponse {
  return { schemaVersion: "relationship-graph.v1", workspaceId, revision: "1", generatedAt: "2026-09-22T00:00:00Z", nodes: [], edges: [], coverage: [], truncated: false, limits: { nodes: 400, edges: 800 } };
}
function bridge(read: ReturnType<typeof vi.fn>) {
  let listener = (_event: unknown) => {};
  window.owb = { relationshipGraph: read, onEvent: (fn: typeof listener) => { listener = fn; return () => { listener = () => {}; }; } } as unknown as OwbBridge;
  return { emit: (event: unknown) => listener(event) };
}

describe("relationship graph reads", () => {
  it("defers graph work until visible and revalidates when reopened", async () => {
    const read = vi.fn().mockResolvedValue({ status: 200, body: graph("a") });
    bridge(read);
    const { result, rerender } = renderHook(({ visible }) => useRelationshipGraph("/a", visible), { initialProps: { visible: false } });
    expect(read).not.toHaveBeenCalled();
    rerender({ visible: true });
    await waitFor(() => expect(result.current.data?.workspaceId).toBe("a"));
    rerender({ visible: false });
    expect(result.current.data?.workspaceId).toBe("a");
    rerender({ visible: true });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("never installs a late response from another workspace", async () => {
    let resolveA!: (value: unknown) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockResolvedValue({ status: 200, body: graph("b") });
    bridge(read);
    const { result, rerender } = renderHook(({ path }) => useRelationshipGraph(path, true), { initialProps: { path: "/a" } });
    rerender({ path: "/b" });
    await waitFor(() => expect(result.current.data?.workspaceId).toBe("b"));
    await act(async () => resolveA({ status: 200, body: graph("a") }));
    expect(result.current.data?.workspaceId).toBe("b");
  });

  it("coalesces matching events and ignores other workspaces", async () => {
    const read = vi.fn().mockResolvedValue({ status: 200, body: graph("a") });
    const events = bridge(read);
    const { result } = renderHook(() => useRelationshipGraph("/a", true));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    act(() => { events.emit({ type: "org.updated", payload: { workspacePath: "/b" } }); });
    expect(read).toHaveBeenCalledTimes(1);
    act(() => {
      for (let i = 0; i < 10; i++) events.emit({ type: "goal.updated", payload: { workspacePath: "/a" } });
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("retains a prior snapshot with an explicit failure instead of making it empty", async () => {
    const read = vi.fn().mockResolvedValueOnce({ status: 200, body: graph("a") }).mockRejectedValue(new Error("offline"));
    bridge(read);
    const { result } = renderHook(() => useRelationshipGraph("/a", true));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).toBe("graph_unavailable"));
    expect(result.current.data?.workspaceId).toBe("a");
  });
});
