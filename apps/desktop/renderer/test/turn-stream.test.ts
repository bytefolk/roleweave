import { describe, expect, it } from "vitest";
import {
  EMPTY_TURN_STREAM,
  applyTurnEvent,
  beginGroupRun,
  beginPendingTurn,
  cancelPendingTurn,
  clearPersonalTurnState,
  reconcileGroupTimeline,
  settlePendingTurn,
} from "../src/turns/turnStream";
import type { GroupTimeline, TurnRecord } from "@roleweave/shared";

const pending = { positionId: "repo-owner", engine: "qoder" as const, input: "检查发布" };

function started(seq: number, runId: string) {
  return { seq, type: "turn.started", payload: { runId, timestamp: "2026-08-24T05:00:00.000Z", type: "run.started" } };
}

function delta(seq: number, runId: string, text: string) {
  return { seq, type: "turn.model.delta", payload: { runId, timestamp: "2026-08-24T05:00:01.000Z", type: "model.delta", text } };
}

describe("turn stream reducer", () => {
  it("binds the first observed runId to the pending POST and appends deltas", () => {
    let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    state = applyTurnEvent(state, started(1, "run-1"));
    state = applyTurnEvent(state, delta(2, "run-1", "正在分析"));
    state = applyTurnEvent(state, delta(3, "run-1", "…已核对"));

    expect(state.pending?.runId).toBe("run-1");
    expect(state.runs["run-1"]?.text).toBe("正在分析…已核对");
    expect(state.runs["run-1"]?.positionId).toBe("repo-owner");
    expect(state.runs["run-1"]?.input).toBe("检查发布");
  });

  it("buffers a delta that arrives before turn.started", () => {
    let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    state = applyTurnEvent(state, delta(1, "run-1", "早到文本"));
    state = applyTurnEvent(state, started(2, "run-1"));

    expect(state.runs["run-1"]?.text).toBe("早到文本");
    expect(state.pending?.runId).toBe("run-1");
  });

  it("never attributes a run when no POST is pending", () => {
    const state = applyTurnEvent(EMPTY_TURN_STREAM, delta(1, "run-9", "无主增量"));
    expect(state.runs).toEqual({});
    expect(state.seq).toBe(1);
  });

  it("does not steal a runId once pending is bound to another run", () => {
    let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    state = applyTurnEvent(state, started(1, "run-1"));
    state = applyTurnEvent(state, delta(2, "run-2", "别人的增量"));
    expect(Object.keys(state.runs)).toEqual(["run-1"]);
  });

  it("treats replayed envelopes at or below the processed seq as no-ops", () => {
    let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    state = applyTurnEvent(state, started(1, "run-1"));
    state = applyTurnEvent(state, delta(2, "run-1", "唯一一次"));
    const replayed = applyTurnEvent(state, delta(2, "run-1", "唯一一次"));
    const stale = applyTurnEvent(state, delta(1, "run-1", "更早的重放"));

    expect(replayed.runs["run-1"]?.text).toBe("唯一一次");
    expect(stale.runs["run-1"]?.text).toBe("唯一一次");
    expect(replayed).toBe(state);
  });

  it("drops the live buffer on the matching terminal event", () => {
    let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    state = applyTurnEvent(state, started(1, "run-1"));
    state = applyTurnEvent(state, delta(2, "run-1", "过程文本"));
    state = applyTurnEvent(state, {
      seq: 3,
      type: "turn.completed",
      payload: { runId: "run-1", timestamp: "2026-08-24T05:00:02.000Z", type: "run.completed", output: "结果", terminalReason: "goal_met" },
    });
    expect(state.runs).toEqual({});
  });

  it("scopes turn.indeterminate cleanup to the reported position", () => {
    let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    state = applyTurnEvent(state, started(1, "run-1"));
    state = {
      ...state,
      runs: {
        ...state.runs,
        "run-2": { positionId: "docs-writer", engine: "qoder", input: "其他岗位", text: "别处", startedAt: "2026-08-24T05:00:00.000Z", totalTokens: null },
      },
    };
    state = applyTurnEvent(state, {
      seq: 2,
      type: "turn.indeterminate",
      payload: { turnId: "turn-1", positionId: "repo-owner", code: "turn_driver_failure", envelopeDigest: "sha256:x" },
    });
    expect(Object.keys(state.runs)).toEqual(["run-2"]);
  });

  it("settle clears pending and the superseded run once the POST returns", () => {
    let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    state = applyTurnEvent(state, started(1, "run-1"));
    const byRunId = settlePendingTurn(state, { runId: "run-1", positionId: "repo-owner" });
    expect(byRunId.pending).toBeNull();
    expect(byRunId.runs).toEqual({});

    const missed = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    const settled = applyTurnEvent(missed, started(1, "run-1"));
    const byPosition = settlePendingTurn(settled, { runId: null, positionId: "repo-owner" });
    expect(byPosition.runs).toEqual({});
  });

  it("personal settle/reset preserve same-position group runs and settled tombstones", () => {
    let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    state = applyTurnEvent(state, started(1, "run-personal"));
    state = beginGroupRun(state, groupSpawn("repo-owner", "turn-owner"));
    state = applyTurnEvent(
      state,
      groupTerminal(2, "run-settled", "turn-settled", "release-engineer"),
    );

    const settled = settlePendingTurn(state, { runId: null, positionId: "repo-owner" });
    expect(settled.runs["run-personal"]).toBeUndefined();
    expect(settled.runs["turn-owner"]?.turnId).toBe("turn-owner");
    expect(settled.settledGroupRuns["turn-settled"]?.turnId).toBe("turn-settled");

    const reset = clearPersonalTurnState(state);
    expect(reset.pending).toBeNull();
    expect(reset.runs["run-personal"]).toBeUndefined();
    expect(reset.runs["turn-owner"]?.turnId).toBe("turn-owner");
    expect(reset.settledGroupRuns["turn-settled"]?.turnId).toBe("turn-settled");
  });

  it("cancel clears only the pending marker", () => {
    const state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    expect(cancelPendingTurn(state).pending).toBeNull();
  });

  it("records turn.usage totals on the attributed live run", () => {
    let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    state = applyTurnEvent(state, started(1, "run-1"));
    expect(state.runs["run-1"]?.totalTokens).toBeNull();
    state = applyTurnEvent(state, {
      seq: 2,
      type: "turn.usage",
      payload: { runId: "run-1", timestamp: "2026-08-24T05:00:01.500Z", type: "usage", inputTokens: 120, outputTokens: 80, totalTokens: 200 },
    });
    expect(state.runs["run-1"]?.totalTokens).toBe(200);
    state = applyTurnEvent(state, {
      seq: 3,
      type: "turn.usage",
      payload: { runId: "run-1", timestamp: "2026-08-24T05:00:02.500Z", type: "usage", totalTokens: 480 },
    });
    expect(state.runs["run-1"]?.totalTokens).toBe(480);
  });

  it("ignores turn.usage for unattributed runs and non-numeric totals", () => {
    let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    state = applyTurnEvent(state, started(1, "run-1"));
    const unknownRun = applyTurnEvent(state, {
      seq: 2,
      type: "turn.usage",
      payload: { runId: "run-9", timestamp: "2026-08-24T05:00:01.500Z", type: "usage", totalTokens: 999 },
    });
    expect(unknownRun.runs).toEqual(state.runs);
    const invalid = applyTurnEvent(state, {
      seq: 3,
      type: "turn.usage",
      payload: { runId: "run-1", timestamp: "2026-08-24T05:00:01.500Z", type: "usage", totalTokens: "many" },
    });
    expect(invalid.runs["run-1"]?.totalTokens).toBeNull();
  });
});

function groupSpawn(positionId: string, turnId: string) {
  return {
    groupRef: "conv-1",
    messageId: "message-1",
    turnId,
    positionId,
    engine: "qoder" as const,
    input: "@两位成员 核对状态",
  };
}

function groupTerminal(
  seq: number,
  runId: string,
  turnId: string,
  positionId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    seq,
    type: "turn.completed",
    payload: {
      runId,
      timestamp: `2026-09-01T00:00:0${seq}.000Z`,
      type: "run.completed",
      output: `${positionId}-done`,
      terminalReason: "goal_met",
      groupRef: "conv-1",
      messageId: "message-1",
      turnId,
      positionId,
      engine: "qoder",
      ...extra,
    },
  };
}

function persistedGroupTurn(turnId: string, positionId: string, output: string): TurnRecord {
  return {
    schemaVersion: "turn-record.v1",
    conversationId: positionId,
    conversationRef: "conv-1",
    groupRef: "conv-1",
    turnId,
    positionId,
    engine: "qoder",
    status: "completed",
    input: "@两位成员 核对状态",
    envelopeDigest: `sha256:${turnId}`,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:05.000Z",
    events: [],
    output,
  };
}

describe("group live-state convergence (#114)", () => {
  it("does not resurrect a spawn whose exact terminal arrived before the 202 response", () => {
    let state = applyTurnEvent(
      EMPTY_TURN_STREAM,
      groupTerminal(1, "run-owner", "turn-owner", "repo-owner"),
    );
    state = beginGroupRun(state, groupSpawn("repo-owner", "turn-owner"));

    expect(state.runs).toEqual({});
  });

  it("settles two mentioned members independently when terminals arrive out of order", () => {
    let state = beginGroupRun(EMPTY_TURN_STREAM, groupSpawn("repo-owner", "turn-owner"));
    state = beginGroupRun(state, groupSpawn("release-engineer", "turn-release"));

    state = applyTurnEvent(
      state,
      groupTerminal(1, "run-release", "turn-release", "release-engineer"),
    );
    expect(Object.values(state.runs).map((run) => run.turnId)).toEqual(["turn-owner"]);

    const wrongEngine = applyTurnEvent(
      state,
      groupTerminal(2, "run-owner", "turn-owner", "repo-owner", { engine: "claude-code" }),
    );
    expect(Object.values(wrongEngine.runs).map((run) => run.turnId)).toEqual(["turn-owner"]);

    const missingRunId = groupTerminal(3, "run-owner", "turn-owner", "repo-owner");
    delete (missingRunId.payload as Record<string, unknown>).runId;
    const malformed = applyTurnEvent(wrongEngine, missingRunId);
    expect(Object.values(malformed.runs).map((run) => run.turnId)).toEqual(["turn-owner"]);

    state = applyTurnEvent(
      malformed,
      groupTerminal(4, "run-owner", "turn-owner", "repo-owner"),
    );
    expect(state.runs).toEqual({});
  });

  it("ignores partially attributed group events instead of leaking text or settling another run", () => {
    let state = beginGroupRun(EMPTY_TURN_STREAM, groupSpawn("repo-owner", "turn-owner"));
    state = applyTurnEvent(state, {
      seq: 1,
      type: "turn.model.delta",
      payload: {
        runId: "run-owner",
        timestamp: "2026-09-01T00:00:01.000Z",
        type: "model.delta",
        text: "trusted",
        groupRef: "conv-1",
        messageId: "message-1",
        turnId: "turn-owner",
        positionId: "repo-owner",
        engine: "qoder",
      },
    });
    state = applyTurnEvent(state, {
      seq: 2,
      type: "turn.model.delta",
      payload: {
        runId: "run-owner",
        timestamp: "2026-09-01T00:00:02.000Z",
        type: "model.delta",
        text: "UNRELATED_RAW_TEXT",
        groupRef: "conv-1",
        turnId: "turn-owner",
        positionId: "repo-owner",
        engine: "qoder",
      },
    });
    expect(state.runs["run-owner"]?.text).toBe("trusted");

    const partialTerminal = groupTerminal(3, "run-owner", "turn-owner", "repo-owner");
    delete (partialTerminal.payload as Record<string, unknown>).messageId;
    state = applyTurnEvent(state, partialTerminal);
    expect(state.runs["run-owner"]?.turnId).toBe("turn-owner");

    state = applyTurnEvent(state, {
      seq: 4,
      type: "turn.completed",
      payload: {
        runId: "run-owner",
        timestamp: "2026-09-01T00:00:04.000Z",
        type: "run.completed",
        output: "UNATTRIBUTED_OUTPUT",
        terminalReason: "goal_met",
      },
    });
    expect(state.runs["run-owner"]?.turnId).toBe("turn-owner");
  });

  it("does not let a same-position personal indeterminate event settle a group run", () => {
    let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    state = applyTurnEvent(state, started(1, "run-personal"));
    state = beginGroupRun(state, groupSpawn("repo-owner", "turn-owner"));

    state = applyTurnEvent(state, {
      seq: 2,
      type: "turn.indeterminate",
      payload: {
        turnId: "turn-personal",
        positionId: "repo-owner",
        code: "turn_driver_failure",
        envelopeDigest: "sha256:x",
      },
    });

    expect(state.runs["run-personal"]).toBeUndefined();
    expect(state.runs["turn-owner"]?.turnId).toBe("turn-owner");
  });

  it("reconciles a dropped SSE stream only from the exact persisted message and terminal turns", () => {
    let state = beginGroupRun(EMPTY_TURN_STREAM, groupSpawn("repo-owner", "turn-owner"));
    state = beginGroupRun(state, groupSpawn("release-engineer", "turn-release"));
    state = applyTurnEvent(state, {
      seq: 1,
      type: "turn.model.delta",
      payload: {
        runId: "run-owner",
        timestamp: "2026-09-01T00:00:01.000Z",
        type: "model.delta",
        text: "working",
        groupRef: "conv-1",
        messageId: "message-1",
        turnId: "turn-owner",
        positionId: "repo-owner",
        engine: "qoder",
      },
    });

    const wrongMessage: GroupTimeline = {
      schemaVersion: "group-timeline.v1",
      conversationRef: "conv-1",
      items: [
        {
          kind: "user",
          schemaVersion: "group-message.v1",
          conversationRef: "conv-1",
          messageId: "message-other",
          input: "@两位成员 核对状态",
          mentions: ["repo-owner", "release-engineer"],
          createdAt: "2026-09-01T00:00:00.000Z",
        },
        { kind: "member", turn: persistedGroupTurn("turn-owner", "repo-owner", "owner-done") },
      ],
    };
    expect(reconcileGroupTimeline(state, wrongMessage).runs).toEqual(state.runs);

    const exact: GroupTimeline = {
      ...wrongMessage,
      items: [
        { ...wrongMessage.items[0]!, messageId: "message-1" },
        { kind: "member", turn: persistedGroupTurn("turn-owner", "repo-owner", "owner-done") },
        { kind: "member", turn: persistedGroupTurn("turn-release", "release-engineer", "release-done") },
      ],
    };
    state = reconcileGroupTimeline(state, exact);
    expect(state.runs).toEqual({});
  });
});

// #51 S1: personal dialog (1:1) must not regress after #52 group routing landed.
// The group branch in applyTurnEvent keys on a non-empty string groupRef; these
// cases pin the personal path under serialization edges and interleaved traffic.
describe("personal dialog baseline regression (#51)", () => {
  it("attributes deltas via pending when groupRef is null or empty", () => {
    for (const groupRef of [null, ""]) {
      let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
      state = applyTurnEvent(state, started(1, "run-1"));
      state = applyTurnEvent(state, {
        seq: 2,
        type: "turn.model.delta",
        payload: { runId: "run-1", timestamp: "2026-08-24T05:00:01.000Z", type: "model.delta", text: "个人增量", groupRef },
      });
      expect(state.runs["run-1"]?.text).toBe("个人增量");
      expect(state.runs["run-1"]?.groupRef).toBeUndefined();
    }
  });

  it("scopes personal turn.indeterminate to the pending-bound run when positionId is absent", () => {
    let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    state = applyTurnEvent(state, started(1, "run-1"));
    state = {
      ...state,
      runs: {
        ...state.runs,
        "run-2": { positionId: "docs-writer", engine: "qoder", input: "其他岗位", text: "别处", startedAt: "2026-08-24T05:00:00.000Z", totalTokens: null },
      },
    };
    state = applyTurnEvent(state, {
      seq: 2,
      type: "turn.indeterminate",
      payload: { turnId: "turn-1", code: "turn_driver_failure", envelopeDigest: "sha256:x" },
    });
    expect(Object.keys(state.runs)).toEqual(["run-2"]);
  });

  it("keeps personal pending attribution and text when group traffic interleaves", () => {
    let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    state = applyTurnEvent(state, started(1, "run-1"));
    state = applyTurnEvent(state, delta(2, "run-1", "个人前半"));
    state = beginGroupRun(state, {
      groupRef: "conv-1",
      messageId: "message-1",
      turnId: "g-turn-1",
      positionId: "docs-writer",
      engine: "qoder",
      input: "群聊任务",
    });
    // First group engine event re-keys the seed buffer under the engine runId.
    state = applyTurnEvent(state, {
      seq: 3,
      type: "turn.model.delta",
      payload: {
        runId: "g-run-1",
        timestamp: "2026-08-24T05:00:02.000Z",
        type: "model.delta",
        text: "群成员增量",
        groupRef: "conv-1",
        messageId: "message-1",
        turnId: "g-turn-1",
        positionId: "docs-writer",
        engine: "qoder",
      },
    });
    // Personal stream continues on the same channel afterwards.
    state = applyTurnEvent(state, delta(4, "run-1", "+个人后半"));

    expect(state.runs["run-1"]?.text).toBe("个人前半+个人后半");
    expect(state.runs["run-1"]?.positionId).toBe("repo-owner");
    expect(state.runs["run-1"]?.groupRef).toBeUndefined();
    expect(state.runs["g-run-1"]?.text).toBe("群成员增量");
    expect(state.runs["g-run-1"]?.groupRef).toBe("conv-1");
    expect(state.runs["g-turn-1"]).toBeUndefined();
    expect(state.pending?.runId).toBe("run-1");
  });

  it("removes only the group run on a group-scoped turn.indeterminate", () => {
    let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    state = applyTurnEvent(state, started(1, "run-1"));
    state = beginGroupRun(state, {
      groupRef: "conv-1",
      messageId: "message-1",
      turnId: "g-turn-1",
      positionId: "docs-writer",
      engine: "qoder",
      input: "群聊任务",
    });
    state = applyTurnEvent(state, {
      seq: 2,
      type: "turn.indeterminate",
      payload: {
        turnId: "g-turn-1",
        groupRef: "conv-1",
        messageId: "message-1",
        positionId: "docs-writer",
        engine: "qoder",
        code: "turn_driver_failure",
        envelopeDigest: "sha256:x",
      },
    });
    expect(state.runs["g-turn-1"]).toBeUndefined();
    expect(state.runs["run-1"]?.positionId).toBe("repo-owner");
    expect(state.pending?.runId).toBe("run-1");
  });
});

// #63: contract-level back-link (de#205 echo) grouping — authoritative when
// present on a seeded spawn; legacy groupRef stays the gray fallback; events
// without a seed (personal session turns) never get adopted by it.
describe("conversationRef back-link grouping (#63)", () => {
  function backlinkDelta(seq: number, runId: string, text: string, extra: Record<string, string>) {
    return {
      seq,
      type: "turn.model.delta",
      payload: { runId, timestamp: "2026-08-26T05:00:01.000Z", type: "model.delta", text, ...extra },
    };
  }

  it("groups a seeded spawn via conversationRef alone and tags the run", () => {
    let state = beginGroupRun(EMPTY_TURN_STREAM, {
      groupRef: "conv-1",
      messageId: "message-1",
      turnId: "g-turn-1",
      positionId: "docs-writer",
      engine: "qoder",
      input: "群聊任务",
    });
    state = applyTurnEvent(
      state,
      backlinkDelta(1, "g-run-1", "群成员增量", {
        conversationRef: "conv-1",
        messageId: "message-1",
        turnId: "g-turn-1",
        positionId: "docs-writer",
        engine: "qoder",
      }),
    );
    expect(state.runs["g-run-1"]?.text).toBe("群成员增量");
    expect(state.runs["g-run-1"]?.groupRef).toBe("conv-1");
    expect(state.runs["g-turn-1"]).toBeUndefined();
  });

  it("keeps the legacy groupRef tag authoritative when both refs ride the event", () => {
    let state = beginGroupRun(EMPTY_TURN_STREAM, {
      groupRef: "conv-1",
      messageId: "message-1",
      turnId: "g-turn-1",
      positionId: "docs-writer",
      engine: "qoder",
      input: "群聊任务",
    });
    state = applyTurnEvent(
      state,
      backlinkDelta(1, "g-run-1", "增量", {
        conversationRef: "conv-1",
        groupRef: "conv-1",
        messageId: "message-1",
        turnId: "g-turn-1",
        positionId: "docs-writer",
        engine: "qoder",
      }),
    );
    expect(state.runs["g-run-1"]?.groupRef).toBe("conv-1");
  });

  it("does not adopt a back-link event with no spawn seed (personal session path)", () => {
    let state = beginPendingTurn(EMPTY_TURN_STREAM, pending);
    state = applyTurnEvent(state, started(1, "run-1"));
    state = applyTurnEvent(
      state,
      backlinkDelta(2, "run-1", "会话增量", { conversationRef: "session-1", turnId: "g-turn-9" }),
    );
    expect(state.runs["run-1"]?.text).toBe("会话增量");
    expect(state.runs["run-1"]?.groupRef).toBeUndefined();
    expect(state.pending?.runId).toBe("run-1");
  });
});
