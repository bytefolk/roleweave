import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ConversationOptions } from "../src/turns/ConversationOptions";
import { adaptTurnRecord } from "../src/turns/adapter";
import type { TurnRecord as ApiTurnRecord } from "@roleweave/shared";
import { pickSelectOption } from "./select-helper";

it("sums separately reported input/output usage and does not turn missing usage into zero", () => {
  const record = { turnId: "t", positionId: "p", engine: "codex-local", input: "question", status: "completed", createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:01Z", model: "account-model", events: [{ type: "usage", inputTokens: 120, outputTokens: 30 }] } as ApiTurnRecord;
  expect(adaptTurnRecord(record, "Employee")).toMatchObject({ totalTokens: 150, model: "account-model" });
  expect(adaptTurnRecord({ ...record, events: [] }, "Employee").totalTokens).toBeUndefined();
});

it("switches the employee model from the composer and exposes context and honest usage details", async () => {
  const change = vi.fn();
  render(<ConversationOptions saving={false} disabled={false} session={null} turns={[]} onModel={change}
    config={{ selected: "efficient", recommended: "efficient", editable: true, source: "provider-tiers", options: [
      { id: "efficient", name: "Efficient", tier: "economy" }, { id: "performance", name: "Performance", tier: "balanced" },
    ] }} />);
  pickSelectOption("员工模型", "Performance");
  expect(change).toHaveBeenCalledWith("performance");
  expect(screen.getByText("用量待回报")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "上下文详情" }));
  expect(await screen.findByText(/最多 12 轮、64 KB/)).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "携带会话历史" })).toBeDisabled();
});

it("does not reuse an older context receipt when the newest turn has none", async () => {
  const receipt = {
    schemaVersion: "thread-context.v1" as const,
    enabled: true,
    sourceTurnCount: 1,
    omittedTurnCount: 0,
    contextBytes: 128,
    contextDigest: "sha256:old",
    summary: "older context",
    redacted: false,
    truncated: false,
  };
  const turn = (id: string, createdAt: string, threadContext?: typeof receipt) => ({
    id,
    positionId: "repo-owner",
    positionName: "Owner",
    engine: "qoder" as const,
    input: id,
    status: "completed" as const,
    createdAt,
    threadContext,
  });
  render(<ConversationOptions saving={false} disabled={false} session={null} turns={[
    turn("older", "2026-09-13T00:00:00.000Z", receipt),
    turn("newest", "2026-09-13T00:01:00.000Z"),
  ]} />);
  fireEvent.click(screen.getByRole("button", { name: "上下文详情" }));
  expect(await screen.findByText("尚无上下文注入记录。")).toBeInTheDocument();
  expect(screen.queryByText(/128 字节/)).not.toBeInTheDocument();
});
