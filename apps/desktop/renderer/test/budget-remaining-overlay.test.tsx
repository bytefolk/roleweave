import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BudgetRemainingAdviceResponse,
  ExperimentsResponse,
} from "@roleweave/shared";
import type { OwbBridge } from "../src/owb";
import { BudgetRemainingOverlay } from "../src/turns/BudgetRemainingOverlay";
import { TurnPanel, type CreateTurnRequest, type TurnPanelProps } from "../src/turns";

const experiment: ExperimentsResponse = {
  schemaVersion: "experiments.v1",
  workspacePath: "/workspace/a",
  workspaceSession: "00000000-0000-4000-8000-000000000001",
  revision: 2,
  enabled: true,
  availability: "ready",
  provider: {
    name: "Laya · local",
    endpointHost: "127.0.0.1",
    endpointUrl: "http://127.0.0.1:18081/v1/systemone",
    configured: true,
  },
  sending: ["status", "errorCode", "budgetRelated"],
  budgetAdviceSending: ["remainingPerTask", "remainingPerDay", "positionId"],
};

const originalOwb = window.owb;
afterEach(() => { window.owb = originalOwb; });

const availability: TurnPanelProps["engineAvailability"] = {
  qoder: { configured: true, ready: true },
  "claude-code": { configured: true, ready: true },
  "claude-local": { configured: true, ready: true },
  codex: { configured: true, ready: true },
  "codex-local": { configured: true, ready: true },
  workbuddy: { configured: true, ready: true },
};

function panel(onCreateTurn: (request: CreateTurnRequest) => void) {
  return <TurnPanel
    workspaceOpen
    workspaceKey="/workspace/a"
    positions={[{ id: "repo-owner", name: "代码库负责人" }]}
    selectedPositionId="repo-owner"
    engine="qoder"
    engineAvailability={availability}
    turns={[]}
    onCreateTurn={onCreateTurn}
  />;
}

describe("pre-send budget remaining overlay #462", () => {
  it("requests only scoped facts and exposes an unknown daily remainder honestly", async () => {
    const response: BudgetRemainingAdviceResponse = {
      workspacePath: experiment.workspacePath,
      workspaceSession: experiment.workspaceSession,
      revision: experiment.revision,
      status: "abstained",
      reason: "unknown_remaining",
      fact: { positionId: "repo-owner", remainingPerTask: 60, remainingPerDay: null },
      suggestion: null,
    };
    const budgetRemainingAdvice = vi.fn().mockResolvedValue({ status: 200, body: response });
    window.owb = { budgetRemainingAdvice } as unknown as OwbBridge;

    render(<BudgetRemainingOverlay experiment={experiment} positionId="repo-owner" />);
    fireEvent.click(screen.getByRole("button", { name: "检查预算建议" }));

    await waitFor(() => expect(budgetRemainingAdvice).toHaveBeenCalledWith({
      workspacePath: experiment.workspacePath,
      workspaceSession: experiment.workspaceSession,
      revision: experiment.revision,
      positionId: "repo-owner",
    }));
    expect(await screen.findByText("单任务剩余：60 tokens")).toBeInTheDocument();
    expect(screen.getByText("单日剩余：暂无权威数据")).toBeInTheDocument();
    expect(screen.getByText("剩余额度不完整，Laya 已弃权")).toBeInTheDocument();
  });

  it("applies a valid suggestion only to local unsent selection", async () => {
    const response: BudgetRemainingAdviceResponse = {
      workspacePath: experiment.workspacePath,
      workspaceSession: experiment.workspaceSession,
      revision: experiment.revision,
      status: "ready",
      fact: { positionId: "repo-owner", remainingPerTask: 60, remainingPerDay: 240 },
      suggestion: "shrink",
    };
    window.owb = {
      budgetRemainingAdvice: vi.fn().mockResolvedValue({ status: 200, body: response }),
    } as unknown as OwbBridge;

    render(<BudgetRemainingOverlay experiment={experiment} positionId="repo-owner" />);
    fireEvent.click(screen.getByRole("button", { name: "检查预算建议" }));
    expect(await screen.findByText("Laya 建议：缩小未发送任务")).toBeInTheDocument();
    expect(screen.getByText("建议未采纳")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "应用建议" }));
    expect(screen.queryByText("建议未采纳")).not.toBeInTheDocument();
    expect(screen.getByText("本地选择：缩小未发送任务")).toBeInTheDocument();
  });

  it("does not mark send-anyway as adopted until the user applies it", async () => {
    const response: BudgetRemainingAdviceResponse = {
      workspacePath: experiment.workspacePath,
      workspaceSession: experiment.workspaceSession,
      revision: experiment.revision,
      status: "ready",
      fact: { positionId: "repo-owner", remainingPerTask: 60, remainingPerDay: 240 },
      suggestion: "send_anyway",
    };
    window.owb = {
      budgetRemainingAdvice: vi.fn().mockResolvedValue({ status: 200, body: response }),
    } as unknown as OwbBridge;

    render(<BudgetRemainingOverlay experiment={experiment} positionId="repo-owner" />);
    fireEvent.click(screen.getByRole("button", { name: "检查预算建议" }));

    expect(await screen.findByText("建议未采纳")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "应用建议" }));
    expect(screen.getByText("本地选择：保持未发送任务")).toBeInTheDocument();
  });

  it("keeps composer DOM and direct send behavior unchanged while the flag is off", async () => {
    const disabled = { ...experiment, enabled: false, availability: "disabled" as const };
    const get = vi.fn().mockResolvedValue({ status: 200, body: disabled });
    const budgetRemainingAdvice = vi.fn();
    window.owb = { experiments: { get }, budgetRemainingAdvice } as unknown as OwbBridge;
    const createTurn = vi.fn();
    render(panel(createTurn));

    await waitFor(() => expect(get).toHaveBeenCalledWith("/workspace/a"));
    expect(screen.queryByRole("region", { name: "预算剩余建议" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "private draft" } });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
    await waitFor(() => expect(createTurn).toHaveBeenCalledWith({
      positionId: "repo-owner",
      engine: "qoder",
      input: "private draft",
    }));
    expect(budgetRemainingAdvice).not.toHaveBeenCalled();
  });

  it("applies advice in the composer without reading its draft or sending a turn", async () => {
    const get = vi.fn().mockResolvedValue({ status: 200, body: experiment });
    const response: BudgetRemainingAdviceResponse = {
      workspacePath: experiment.workspacePath,
      workspaceSession: experiment.workspaceSession,
      revision: experiment.revision,
      status: "ready",
      fact: { positionId: "repo-owner", remainingPerTask: 60, remainingPerDay: 240 },
      suggestion: "switch_employee",
    };
    const budgetRemainingAdvice = vi.fn().mockResolvedValue({ status: 200, body: response });
    window.owb = { experiments: { get }, budgetRemainingAdvice } as unknown as OwbBridge;
    const createTurn = vi.fn();
    render(panel(createTurn));

    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "private draft" } });
    fireEvent.click(await screen.findByRole("button", { name: "检查预算建议" }));
    fireEvent.click(await screen.findByRole("button", { name: "应用建议" }));

    expect(createTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(budgetRemainingAdvice.mock.calls)).not.toContain("private draft");
    expect(screen.getByText("本地选择：考虑其他员工")).toBeInTheDocument();
  });

  it("discards a late response after the workspace and employee change", async () => {
    let resolve!: (value: { status: number; body: BudgetRemainingAdviceResponse }) => void;
    const pending = new Promise<{ status: number; body: BudgetRemainingAdviceResponse }>(done => { resolve = done; });
    window.owb = {
      budgetRemainingAdvice: vi.fn().mockReturnValue(pending),
    } as unknown as OwbBridge;
    const { rerender } = render(<BudgetRemainingOverlay experiment={experiment} positionId="repo-owner" />);
    fireEvent.click(screen.getByRole("button", { name: "检查预算建议" }));

    const next = {
      ...experiment,
      workspacePath: "/workspace/b",
      workspaceSession: "00000000-0000-4000-8000-000000000002",
      revision: 0,
    };
    rerender(<BudgetRemainingOverlay experiment={next} positionId="community-operator" />);
    expect(screen.getByText("发送前可检查权威剩余额度；不会修改预算或自动发送。")).toBeInTheDocument();

    await act(async () => resolve({
      status: 200,
      body: {
        workspacePath: experiment.workspacePath,
        workspaceSession: experiment.workspaceSession,
        revision: experiment.revision,
        status: "ready",
        fact: { positionId: "repo-owner", remainingPerTask: 60, remainingPerDay: 240 },
        suggestion: "shrink",
      },
    }));

    expect(screen.queryByText("Laya 建议：缩小未发送任务")).not.toBeInTheDocument();
  });

  it("fails closed instead of displaying a semantically malformed response", async () => {
    window.owb = {
      budgetRemainingAdvice: vi.fn().mockResolvedValue({
        status: 200,
        body: {
          workspacePath: experiment.workspacePath,
          workspaceSession: experiment.workspaceSession,
          revision: experiment.revision,
          status: "ready",
          reason: "unknown_remaining",
          fact: { positionId: "repo-owner", remainingPerTask: 60, remainingPerDay: 240 },
          suggestion: "shrink",
        },
      }),
    } as unknown as OwbBridge;

    render(<BudgetRemainingOverlay experiment={experiment} positionId="repo-owner" />);
    fireEvent.click(screen.getByRole("button", { name: "检查预算建议" }));

    expect(await screen.findByText("预算建议暂不可用")).toBeInTheDocument();
    expect(screen.queryByText("Laya 建议：缩小未发送任务")).not.toBeInTheDocument();
  });
});
