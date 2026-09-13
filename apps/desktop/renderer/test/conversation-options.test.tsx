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
