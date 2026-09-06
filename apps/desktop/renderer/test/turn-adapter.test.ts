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
});
