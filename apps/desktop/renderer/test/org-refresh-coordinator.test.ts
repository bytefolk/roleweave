import { describe, expect, it, vi } from "vitest";
import { createOrgRefreshCoordinator } from "../src/org/refresh-coordinator";

describe("organization refresh identity", () => {
  const version = { seq: 2, updatedAt: "2026-09-16T00:00:00Z" };

  it("shares an in-flight read and a late event, but distinguishes workspaces and versions", async () => {
    const coordinator = createOrgRefreshCoordinator();
    let finish!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = coordinator.run("workspace-a", version, refresh);
    expect(coordinator.run("workspace-a", { ...version }, refresh)).toBe(first);
    await Promise.resolve();
    finish();
    await first;
    await coordinator.run("workspace-a", version, refresh);
    expect(refresh).toHaveBeenCalledTimes(1);

    const other = vi.fn(async () => {});
    await coordinator.run("workspace-b", version, other);
    await coordinator.run("workspace-a", { ...version, seq: 3 }, other);
    expect(other).toHaveBeenCalledTimes(2);
    coordinator.clear(); // new SSE connection/version epoch
    await coordinator.run("workspace-a", version, other);
    expect(other).toHaveBeenCalledTimes(3);
  });

  it("does not cache failed reads or guess the identity of unversioned events", async () => {
    const coordinator = createOrgRefreshCoordinator();
    const failure = new Error("offline");
    await expect(coordinator.run("workspace-a", version, async () => { throw failure; })).rejects.toBe(failure);
    const refresh = vi.fn(async () => {});
    await coordinator.run("workspace-a", version, refresh);
    await coordinator.run("workspace-a", undefined, refresh);
    await coordinator.run("workspace-a", undefined, refresh);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
