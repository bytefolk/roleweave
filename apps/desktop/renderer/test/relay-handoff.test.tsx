import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RelayHandoffSnapshot } from "@roleweave/shared";
import { MAX_RELAY_INSTRUCTION_BYTES, MAX_RELAY_INSTRUCTIONS_BYTES } from "@roleweave/shared/relay-steps";
import { RelayHandoffDetails } from "../src/groups/RelayHandoffDetails";
import { instructionBytes, selectedRelaySteps, relayStepsTooLarge, RELAY_INSTRUCTION_BYTES, RELAY_INSTRUCTIONS_BYTES } from "../src/groups/relay-instructions";

const snapshot: RelayHandoffSnapshot = {
  payload: { schemaVersion: "relay-handoff.v1", generatedAt: "2026-10-21T00:00:00.000Z", conversationRef: "group-one", messageId: "message-one", turnId: "turn-two",
    step: { positionId: "reviewer", number: 2, total: 2 }, taskExcerpt: "Write and review the report", instruction: "Verify the citations",
    sources: [{ positionId: "writer", turnId: "turn-one", sourceUpdatedAt: "2026-10-20T23:59:00.000Z", outputExcerpt: "Draft with two open questions", excerptDigest: "sha256:fixture", truncated: true, redacted: true }],
    omittedSourceCount: 0, taskExcerptTruncated: false, redacted: true }, payloadBytes: 0, payloadDigest: "sha256:fixture",
};
const positionName = (id: string) => ({ writer: "Writer", reviewer: "Reviewer" }[id] ?? id);

describe("saved relay handoff", () => {
  it("opens actual saved requirements and sources with caveats and closes again", async () => {
    render(<RelayHandoffDetails snapshot={snapshot} positionName={positionName} />);
    expect(screen.queryByText("Verify the citations")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/交接信息/));
    expect(await screen.findByText("Verify the citations")).toBeInTheDocument();
    expect(screen.getByText("Draft with two open questions")).toBeInTheDocument();
    expect(screen.getByText("turn-one")).toBeInTheDocument();
    expect(screen.getByText("以下是前序执行结果，完成状态不代表已验收。")).toBeInTheDocument();
    expect(screen.getByText("此结果摘录已截断。")).toBeInTheDocument();
    expect(screen.getByText("这是接力最后一步。")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/交接信息/));
    await waitFor(() => expect(screen.queryByText("Verify the citations")).not.toBeInTheDocument());
  });
  it("states missing requirements and no predecessor on the first step", async () => {
    const first = { ...snapshot, payload: { ...snapshot.payload, instruction: null, sources: [], redacted: false,
      step: { positionId: "writer", number: 1, total: 2, nextPositionId: "reviewer" } } };
    render(<RelayHandoffDetails snapshot={first} positionName={positionName} />);
    fireEvent.click(screen.getByText(/交接信息/));
    expect(await screen.findByText("未单独指定，按原始任务执行。")).toBeInTheDocument();
    expect(screen.getByText("这是第一步，没有前序交接结果。")).toBeInTheDocument();
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
  });
});

it("client UTF-8 limits match the shared contract and deselected members are omitted", () => {
  expect(RELAY_INSTRUCTION_BYTES).toBe(MAX_RELAY_INSTRUCTION_BYTES);
  expect(RELAY_INSTRUCTIONS_BYTES).toBe(MAX_RELAY_INSTRUCTIONS_BYTES);
  expect(instructionBytes("汉")).toBe(3);
  expect(selectedRelaySteps(["reviewer", "writer"], { outsider: "ignore", writer: "   ", reviewer: " check " }))
    .toEqual([{ positionId: "reviewer", instruction: "check" }]);
  expect(relayStepsTooLarge([{ positionId: "writer", instruction: "汉".repeat(1366) }])).toBe(true);
  expect(relayStepsTooLarge(Array.from({ length: 9 }, (_, i) => ({ positionId: `member-${i}`, instruction: "x".repeat(4096) })))).toBe(true);
});
