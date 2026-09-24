import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperimentsResponse, SendGateAdviceResponse } from "@roleweave/shared";
import type { OwbBridge } from "../src/owb";
import { TurnPanel, type CreateTurnRequest, type TurnPanelProps } from "../src/turns";

const availability: TurnPanelProps["engineAvailability"] = {
  qoder: { configured: true, ready: true },
  "claude-code": { configured: true, ready: true },
  "claude-local": { configured: true, ready: true },
  codex: { configured: true, ready: true },
  "codex-local": { configured: true, ready: true },
  workbuddy: { configured: true, ready: true },
};
const experiment = (enabled: boolean): ExperimentsResponse => ({
  schemaVersion: "experiments.v1",
  workspacePath: "/workspace/a",
  workspaceSession: "00000000-0000-4000-8000-000000000001",
  revision: 2,
  enabled,
  availability: enabled ? "ready" : "disabled",
  provider: {
    name: "Laya · local",
    endpointHost: "127.0.0.1",
    endpointUrl: "http://127.0.0.1:18081/v1/systemone",
    configured: true,
  },
  sending: ["status", "errorCode", "budgetRelated"],
  sendGateSending: ["positionId", "mode"],
  sendGateOptional: ["taskSummary"],
});

function panel(onCreateTurn: (request: CreateTurnRequest) => void, overrides: Partial<TurnPanelProps> = {}) {
  return <TurnPanel
    workspaceOpen
    workspaceKey="/workspace/a"
    workspaceScope={Symbol("workspace-a")}
    positions={[{ id: "repo-owner", name: "代码库负责人" }]}
    selectedPositionId="repo-owner"
    positionMode="read_only"
    engine="qoder"
    engineAvailability={availability}
    turns={[]}
    onCreateTurn={onCreateTurn}
    {...overrides}
  />;
}

const originalOwb = window.owb;
afterEach(() => { window.owb = originalOwb; });

describe("send-time human-gate advice overlay #461", () => {
  it("keeps the composer DOM and direct send behavior unchanged while the flag is off", async () => {
    const get = vi.fn().mockResolvedValue({ status: 200, body: experiment(false) });
    const sendGateAdvice = vi.fn();
    window.owb = { experiments: { get }, sendGateAdvice } as unknown as OwbBridge;
    const createTurn = vi.fn();
    render(panel(createTurn));

    await waitFor(() => expect(get).toHaveBeenCalledWith("/workspace/a"));
    expect(screen.queryByRole("region", { name: "发送前人审建议" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "DO NOT SEND composer draft" } });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));

    await waitFor(() => expect(createTurn).toHaveBeenCalledWith({
      positionId: "repo-owner",
      engine: "qoder",
      input: "DO NOT SEND composer draft",
    }));
    expect(sendGateAdvice).not.toHaveBeenCalled();
  });

  it("uses a separate confirmed summary and applying advice never sends a turn", async () => {
    const enabled = experiment(true);
    const get = vi.fn().mockResolvedValue({ status: 200, body: enabled });
    const response: SendGateAdviceResponse = {
      workspacePath: enabled.workspacePath,
      workspaceSession: enabled.workspaceSession,
      revision: enabled.revision,
      status: "ready",
      rule: { positionId: "repo-owner", mode: "read_only" },
      suggestion: "approval_required",
    };
    const sendGateAdvice = vi.fn().mockResolvedValue({ status: 200, body: response });
    window.owb = { experiments: { get }, sendGateAdvice } as unknown as OwbBridge;
    const createTurn = vi.fn();
    render(panel(createTurn));

    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "DO NOT SEND composer draft" } });
    fireEvent.click(await screen.findByRole("button", { name: "获取人审建议" }));
    const summary = await screen.findByLabelText("任务摘要（仅本次）");
    expect(summary).toHaveValue("");
    expect(sendGateAdvice).not.toHaveBeenCalled();

    fireEvent.change(summary, { target: { value: "Review release access" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并生成建议" }));

    await waitFor(() => expect(sendGateAdvice).toHaveBeenCalledWith({
      workspacePath: enabled.workspacePath,
      workspaceSession: enabled.workspaceSession,
      revision: enabled.revision,
      positionId: "repo-owner",
      taskSummary: { value: "Review release access", confirmed: true },
    }));
    expect(JSON.stringify(sendGateAdvice.mock.calls)).not.toContain("DO NOT SEND composer draft");
    expect(await screen.findByText("建议未采纳")).toBeInTheDocument();
    expect(screen.getByText("当前模式：只读")).toBeInTheDocument();
    expect(screen.getByText("建议：本次需要人审")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "采用建议" }));
    expect(createTurn).not.toHaveBeenCalled();
    expect(screen.queryByText("建议未采纳")).not.toBeInTheDocument();
    expect(screen.getByText("已预填：本次需要人审（不修改岗位模式）")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
    await waitFor(() => expect(createTurn).toHaveBeenCalledWith({
      positionId: "repo-owner",
      engine: "qoder",
      input: "DO NOT SEND composer draft",
    }));
  });

  it("discards a late response after the selected employee changes", async () => {
    const enabled = experiment(true);
    const get = vi.fn().mockResolvedValue({ status: 200, body: enabled });
    let resolveAdvice!: (value: { status: number; body: SendGateAdviceResponse }) => void;
    const pending = new Promise<{ status: number; body: SendGateAdviceResponse }>(resolve => {
      resolveAdvice = resolve;
    });
    const sendGateAdvice = vi.fn().mockReturnValue(pending);
    window.owb = { experiments: { get }, sendGateAdvice } as unknown as OwbBridge;
    const createTurn = vi.fn();
    const workspaceScope = Symbol("workspace-a");
    const positions = [
      { id: "repo-owner", name: "代码库负责人" },
      { id: "release-manager", name: "发布负责人" },
    ];
    const view = render(panel(createTurn, { workspaceScope, positions }));

    fireEvent.click(await screen.findByRole("button", { name: "获取人审建议" }));
    fireEvent.change(await screen.findByLabelText("任务摘要（仅本次）"), { target: { value: "Review release access" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并生成建议" }));
    await waitFor(() => expect(sendGateAdvice).toHaveBeenCalledTimes(1));

    view.rerender(panel(createTurn, {
      workspaceScope,
      positions,
      selectedPositionId: "release-manager",
      positionMode: "approval_required",
    }));
    await waitFor(() => expect(screen.getByText("当前模式：需要人审")).toBeInTheDocument());

    await act(async () => resolveAdvice({
      status: 200,
      body: {
        workspacePath: enabled.workspacePath,
        workspaceSession: enabled.workspaceSession,
        revision: enabled.revision,
        status: "ready",
        rule: { positionId: "repo-owner", mode: "read_only" },
        suggestion: "approval_required",
      },
    }));

    expect(screen.queryByText("建议：本次需要人审")).not.toBeInTheDocument();
    expect(screen.queryByText("建议未采纳")).not.toBeInTheDocument();
    expect(createTurn).not.toHaveBeenCalled();
  });
});
