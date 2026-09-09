import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import type { EngineEvent, TurnRecord, TurnRunDriver, TurnRunRequest, TurnRunResult } from "@roleweave/shared";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

for (const outcome of ["indeterminate", "cancel", "throw"] as const) {
  test(`driver ${outcome} closes delayed deltas before the next task starts`, async (t) => {
    let oldRequest: TurnRunRequest | undefined;
    let announceFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { announceFirst = resolve; });
    let announceSecond!: () => void;
    const secondStarted = new Promise<void>((resolve) => { announceSecond = resolve; });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let calls = 0;
    const driver: TurnRunDriver = {
      async turnRun(request): Promise<TurnRunResult> {
        calls += 1;
        const timestamp = new Date().toISOString();
        const started: EngineEvent = { type: "run.started", runId: "same-engine-run", timestamp };
        if (calls === 1) {
          oldRequest = request;
          request.onEvent?.(started);
          const delta: EngineEvent = { type: "model.delta", runId: started.runId, timestamp, text: "OLD BUFFERED TEXT" };
          request.onEvent?.(delta);
          announceFirst();
          if (outcome === "throw") throw new Error("synthetic driver exception");
          if (outcome === "cancel") return new Promise((resolve) => {
            request.setAbort?.(() => resolve({ status: "indeterminate", events: [started, delta], diagnostic: "", code: "turn_cancelled" }));
          });
          return { status: "indeterminate", events: [started, delta], diagnostic: "", code: "turn_process_exit" };
        }
        announceSecond();
        await secondGate;
        const terminal: EngineEvent = { type: "run.completed", runId: started.runId, timestamp, output: "New result", terminalReason: "goal_met" };
        request.onEvent?.(started);
        request.onEvent?.(terminal);
        return { status: "trusted", events: [started, terminal], diagnostic: "" };
      },
    };
    const server = await startTestServer(undefined, driver);
    const workspace = await copyExampleWorkspace();
    let second: Promise<unknown> | undefined;
    t.after(async () => { releaseSecond(); await second; await server.close(); await fs.rm(workspace, { recursive: true, force: true }); });
    assert.equal((await api(server.baseUrl, "/workspace/open", { method: "POST", token: server.token, body: { path: workspace } })).status, 200);
    const first = api(server.baseUrl, "/turns", { method: "POST", token: server.token, body: { positionId: "repo-owner", input: "Old task", engine: "qoder" } });
    await firstStarted;
    if (outcome === "cancel") {
      const cancelled = await api(server.baseUrl, "/turns/cancel", { method: "POST", token: server.token, body: { positionId: "repo-owner", workspacePath: workspace, turnId: oldRequest!.envelope.turnId } });
      assert.equal(cancelled.status, 200);
    }
    const oldResult = await first;
    assert.equal(oldResult.status, 200);
    assert.equal((oldResult.body as TurnRecord).status, "indeterminate");
    const settledSeq = server.ctx.bus.currentSeq;
    second = api(server.baseUrl, "/turns", { method: "POST", token: server.token, body: { positionId: "repo-owner", input: "New task", engine: "qoder" } });
    await secondStarted;
    // A faulty adapter can deliver callbacks even after its promise settles.
    oldRequest!.onEvent?.({ type: "model.delta", runId: "same-engine-run", timestamp: new Date().toISOString(), text: "LATE OLD CALLBACK" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const late = server.ctx.bus.since(settledSeq).filter((event) => (event.payload as { turnId?: string }).turnId === oldRequest!.envelope.turnId);
    assert.deepEqual(late, [], "no old-task timer or callback may publish after ownership is released");
    releaseSecond();
    assert.equal((await second as { status: number }).status, 200);
  });
}
