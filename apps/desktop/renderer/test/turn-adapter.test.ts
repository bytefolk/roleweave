import { describe, expect, it } from "vitest";
import type { TurnHistory } from "@roleweave/shared";
import { adaptTurnHistory } from "../src/turns/adapter";

describe("turn-record.v1 renderer adapter", () => {
  it("maps server-owned history explicitly without inventing recall or evidence", () => {
    const history: TurnHistory = {
      schemaVersion: "turn-history.v1",
      conversationId: "conversation-1",
      positionId: "repo-owner",
      turns: [{
        schemaVersion: "turn-record.v1",
        conversationId: "conversation-1",
        turnId: "turn-1",
        positionId: "repo-owner",
        engine: "qoder",
        status: "completed",
        input: "检查发布门禁",
        envelopeDigest: "sha256:abc",
        createdAt: "2026-08-24T04:00:00.000Z",
        updatedAt: "2026-08-24T04:01:00.000Z",
        events: [],
        output: { result: "pass" },
      }],
    };

    expect(adaptTurnHistory(history, "代码库负责人")).toEqual([{
      id: "turn-1",
      positionId: "repo-owner",
      positionName: "代码库负责人",
      engine: "qoder",
      input: "检查发布门禁",
      status: "completed",
      createdAt: "2026-08-24T04:00:00.000Z",
      completedAt: "2026-08-24T04:01:00.000Z",
      output: "{\n  \"result\": \"pass\"\n}",
      envelopeDigest: "sha256:abc",
      progress: [
        { kind: "received", at: "2026-08-24T04:00:00.000Z" },
        { kind: "completed", at: "2026-08-24T04:01:00.000Z" },
      ],
    }]);
  });

  it("projects a safe execution progress trail without exposing raw engine internals", () => {
    const history: TurnHistory = {
      schemaVersion: "turn-history.v1",
      conversationId: "conversation-1",
      positionId: "repo-owner",
      turns: [{
        schemaVersion: "turn-record.v1",
        conversationId: "conversation-1",
        turnId: "turn-2",
        positionId: "repo-owner",
        engine: "qoder",
        status: "completed",
        input: "检查发布门禁",
        envelopeDigest: "sha256:def",
        createdAt: "2026-08-24T04:00:00.000Z",
        updatedAt: "2026-08-24T04:01:00.000Z",
        events: [
          { type: "run.started", runId: "run-2", timestamp: "2026-08-24T04:00:00.000Z" },
          { type: "model.delta", runId: "run-2", timestamp: "2026-08-24T04:00:10.000Z", text: "内部文本不作为 UI 思考链" },
          { type: "usage", runId: "run-2", timestamp: "2026-08-24T04:00:30.000Z", totalTokens: 1280 },
          { type: "run.completed", runId: "run-2", timestamp: "2026-08-24T04:01:00.000Z", output: "最终结论", terminalReason: "goal_met" },
        ],
        output: "最终结论",
      }],
    };

    const [adapted] = adaptTurnHistory(history, "代码库负责人");
    expect(adapted?.progress).toEqual([
      { kind: "received", at: "2026-08-24T04:00:00.000Z" },
      { kind: "working", at: "2026-08-24T04:00:10.000Z" },
      { kind: "completed", at: "2026-08-24T04:01:00.000Z" },
    ]);
    expect(adapted?.totalTokens).toBe(1280);
    expect(adapted?.progress?.some((step) => "text" in step)).toBe(false);
  });

  it("builds a Qoder-style trail: narration between tool activities becomes bounded thought items", () => {
    const history: TurnHistory = {
      schemaVersion: "turn-history.v1",
      conversationId: "conversation-1",
      positionId: "repo-owner",
      turns: [{
        schemaVersion: "turn-record.v1",
        conversationId: "conversation-1",
        turnId: "turn-3",
        positionId: "repo-owner",
        engine: "qoder",
        status: "completed",
        input: "核对群成员",
        envelopeDigest: "sha256:trace",
        createdAt: "2026-08-24T04:00:00.000Z",
        updatedAt: "2026-08-24T04:01:00.000Z",
        events: [
          { type: "run.started", runId: "run-3", timestamp: "2026-08-24T04:00:00.000Z" },
          { type: "model.delta", runId: "run-3", timestamp: "2026-08-24T04:00:01.000Z", text: "先读这份表，" },
          { type: "model.delta", runId: "run-3", timestamp: "2026-08-24T04:00:02.000Z", text: "然后查群和人。" },
          { type: "trace.activity", runId: "run-3", timestamp: "2026-08-24T04:00:03.000Z", activityId: "tool-1", kind: "tool", status: "running", title: "Terminal", detail: "dws aitable field list" },
          { type: "trace.activity", runId: "run-3", timestamp: "2026-08-24T04:00:04.000Z", activityId: "tool-1", kind: "tool", status: "completed", title: "Terminal", detail: "dws aitable field list" },
          { type: "model.delta", runId: "run-3", timestamp: "2026-08-24T04:00:05.000Z", text: "最终答复文本" },
          { type: "run.completed", runId: "run-3", timestamp: "2026-08-24T04:01:00.000Z", output: "最终答复文本", terminalReason: "goal_met" },
        ],
        output: "最终答复文本",
      }],
    };

    const [adapted] = adaptTurnHistory(history, "代码库负责人");
    expect(adapted?.trace).toEqual([
      { activityId: "thought-1", kind: "thought", status: "completed", text: "先读这份表，然后查群和人。" },
      { activityId: "tool-1", kind: "tool", status: "completed", title: "Terminal", detail: "dws aitable field list", at: "2026-08-24T04:00:04.000Z" },
    ]);
  });

  it("keeps a running turn's open narration as a live thinking item instead of dropping it", () => {
    const history: TurnHistory = {
      schemaVersion: "turn-history.v1",
      conversationId: "conversation-1",
      positionId: "repo-owner",
      turns: [{
        schemaVersion: "turn-record.v1",
        conversationId: "conversation-1",
        turnId: "turn-4",
        positionId: "repo-owner",
        engine: "qoder",
        status: "running",
        input: "核对群成员",
        envelopeDigest: "sha256:live",
        createdAt: "2026-08-24T04:00:00.000Z",
        updatedAt: "2026-08-24T04:00:30.000Z",
        events: [
          { type: "run.started", runId: "run-4", timestamp: "2026-08-24T04:00:00.000Z" },
          { type: "trace.activity", runId: "run-4", timestamp: "2026-08-24T04:00:05.000Z", activityId: "tool-1", kind: "tool", status: "completed", title: "Read", detail: "roster.csv" },
          { type: "model.delta", runId: "run-4", timestamp: "2026-08-24T04:00:06.000Z", text: "Now query all records" },
        ],
      }],
    };

    const [adapted] = adaptTurnHistory(history, "代码库负责人");
    expect(adapted?.trace).toEqual([
      { activityId: "tool-1", kind: "tool", status: "completed", title: "Read", detail: "roster.csv", at: "2026-08-24T04:00:05.000Z" },
      { activityId: "thought-1", kind: "thought", status: "running", text: "Now query all records" },
    ]);
  });
});
