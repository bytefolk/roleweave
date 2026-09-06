import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TurnRecord as ApiTurnRecord } from "@roleweave/shared";
import { TurnPanel, approvalResumeInput } from "../src/turns";
import type { CreateTurnRequest, TurnEngine, TurnPanelProps, TurnRecord } from "../src/turns";
import { adaptTurnRecord } from "../src/turns/adapter";

function apiRecord(overrides: Partial<ApiTurnRecord>): ApiTurnRecord {
  return {
    schemaVersion: "turn-record.v1",
    conversationId: "conversation-1",
    turnId: "turn-1",
    positionId: "repo-owner",
    engine: "qoder",
    status: "failed",
    input: "run the risky step",
    envelopeDigest: "sha256:abc",
    createdAt: "2026-08-24T04:00:00.000Z",
    updatedAt: "2026-08-24T04:01:00.000Z",
    events: [
      { type: "run.started", runId: "run-1", timestamp: "2026-08-24T04:00:00.000Z" },
      {
        type: "approval.requested",
        runId: "run-1",
        timestamp: "2026-08-24T04:00:01.000Z",
        approvalId: "appr-1",
        action: { kind: "exec", description: "rm -rf build", target: "scripts/clean.sh" },
        expiresAt: "2026-08-24T05:00:00.000Z",
      },
      {
        type: "run.failed",
        runId: "run-1",
        timestamp: "2026-08-24T04:00:02.000Z",
        error: {
          code: "engine.approval_required",
          message: "awaiting operator verdict",
          retryable: true,
          terminalReason: "engine_internal_error",
        },
      },
    ],
    error: { code: "engine.approval_required", message: "awaiting operator verdict", retryable: true },
    ...overrides,
  };
}

describe("approval card adapter projection", () => {
  it("projects the last approval.requested only for a failed engine.approval_required turn", () => {
    const projected = adaptTurnRecord(apiRecord({}), "代码库负责人");
    expect(projected.approvalRequest).toEqual({
      approvalId: "appr-1",
      kind: "exec",
      description: "rm -rf build",
      target: "scripts/clean.sh",
      expiresAt: "2026-08-24T05:00:00.000Z",
    });
  });

  it("never invents a verdict surface for other failures or non-failed records", () => {
    const otherFailure = adaptTurnRecord(
      apiRecord({ error: { code: "engine_failed", message: "boom", retryable: false } }),
      "代码库负责人",
    );
    expect(otherFailure.approvalRequest).toBeUndefined();

    const completed = adaptTurnRecord(apiRecord({ status: "completed", error: undefined }), "代码库负责人");
    expect(completed.approvalRequest).toBeUndefined();
  });
});

const positions = [{ id: "repo-owner", name: "代码库负责人" }];
const availability: TurnPanelProps["engineAvailability"] = {
  qoder: { configured: true, ready: true },
  "claude-code": { configured: true, ready: true },
  "claude-local": { configured: true, ready: true },
};

function VerdictPanel({ turns, onVerdictTurn, decidedApprovalIds }: {
  turns: TurnRecord[];
  onVerdictTurn: (turn: TurnRecord, decision: "granted" | "denied", reason?: string) => void;
  decidedApprovalIds?: ReadonlySet<string>;
}) {
  const [positionId, setPositionId] = useState<string | null>("repo-owner");
  const [engine, setEngine] = useState<TurnEngine>("qoder");
  return (
    <TurnPanel
      workspaceOpen
      positions={positions}
      selectedPositionId={positionId}
      engine={engine}
      engineAvailability={availability}
      turns={turns}
      onSelectPosition={setPositionId}
      onSelectEngine={setEngine}
      onCreateTurn={(request: CreateTurnRequest) => void request}
      onVerdictTurn={onVerdictTurn}
      decidedApprovalIds={decidedApprovalIds}
    />
  );
}

describe("approvalResumeInput wording", () => {
  it("keeps granted as a neutral continuation sentence", () => {
    expect(approvalResumeInput("granted")).toBe("[审批裁决] 请继续执行上一回合暂停的动作");
    expect(approvalResumeInput("granted", "ignored")).toBe("[审批裁决] 请继续执行上一回合暂停的动作");
  });

  it("gives denied its own wording and carries the reason when given", () => {
    expect(approvalResumeInput("denied")).toBe("[审批裁决] 已拒绝上一回合暂停的动作");
    expect(approvalResumeInput("denied", "超出岗位授权")).toBe("[审批裁决] 已拒绝：超出岗位授权");
  });
});

describe("TurnPanel approval verdict card", () => {
  it("renders the mirrored request and starts a verdict via the buttons, suppressing plain retry", () => {
    const turn = adaptTurnRecord(apiRecord({}), "代码库负责人");
    const onVerdictTurn = vi.fn();
    render(<VerdictPanel turns={[turn]} onVerdictTurn={onVerdictTurn} />);

    const card = screen.getByRole("group", { name: "审批请求" });
    expect(card).toHaveTextContent("等待审批 · 命令执行");
    expect(card).toHaveTextContent("rm -rf build");
    expect(card).toHaveTextContent("scripts/clean.sh");
    expect(screen.queryByRole("button", { name: /创建新回合重试/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "批准并继续" }));
    expect(onVerdictTurn).toHaveBeenCalledTimes(1);
    expect(onVerdictTurn).toHaveBeenCalledWith(turn, "granted", undefined);

    fireEvent.change(screen.getByRole("textbox", { name: "拒绝理由（可选）" }), {
      target: { value: "超出岗位授权 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(onVerdictTurn).toHaveBeenCalledTimes(2);
    expect(onVerdictTurn).toHaveBeenLastCalledWith(turn, "denied", "超出岗位授权");
  });

  it("settles the card into a decided state once the verdict has been dispatched", () => {
    const turn = adaptTurnRecord(apiRecord({}), "代码库负责人");
    const onVerdictTurn = vi.fn();
    render(
      <VerdictPanel
        turns={[turn]}
        onVerdictTurn={onVerdictTurn}
        decidedApprovalIds={new Set(["appr-1"])}
      />,
    );

    const card = screen.getByRole("group", { name: "审批请求" });
    expect(card).toHaveTextContent("已裁决 · 命令执行");
    expect(card).toHaveTextContent("这个审批已处理，不能重复操作");
    expect(screen.queryByRole("button", { name: "批准并继续" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "拒绝理由（可选）" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /创建新回合重试/ })).not.toBeInTheDocument();
    expect(onVerdictTurn).not.toHaveBeenCalled();
  });

  it("locks the card after a successful verdict so a contradictory verdict cannot follow", () => {
    function DecidingPanel({ turns, onVerdictTurn }: {
      turns: TurnRecord[];
      onVerdictTurn: (turn: TurnRecord, decision: "granted" | "denied", reason?: string) => void;
    }) {
      // Mirrors App.tsx: once the resume turn is created, the approval id
      // joins the decided set and the card invalidates.
      const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
      return (
        <VerdictPanel
          turns={turns}
          decidedApprovalIds={decided}
          onVerdictTurn={(turn, decision, reason) => {
            onVerdictTurn(turn, decision, reason);
            const approvalId = turn.approvalRequest?.approvalId;
            if (approvalId !== undefined) setDecided((current) => new Set(current).add(approvalId));
          }}
        />
      );
    }

    const turn = adaptTurnRecord(apiRecord({}), "代码库负责人");
    const onVerdictTurn = vi.fn();
    render(<DecidingPanel turns={[turn]} onVerdictTurn={onVerdictTurn} />);

    fireEvent.click(screen.getByRole("button", { name: "批准并继续" }));
    expect(onVerdictTurn).toHaveBeenCalledTimes(1);
    expect(onVerdictTurn).toHaveBeenCalledWith(turn, "granted", undefined);

    expect(screen.queryByRole("button", { name: "批准并继续" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "审批请求" })).toHaveTextContent("已裁决 · 命令执行");
  });

  it("keeps the plain retry path for failed turns without an approval request", () => {
    const plainFailure = adaptTurnRecord(
      apiRecord({
        events: [{ type: "run.started", runId: "run-1", timestamp: "2026-08-24T04:00:00.000Z" }],
        error: { code: "engine_failed", message: "boom", retryable: true },
      }),
      "代码库负责人",
    );
    render(<VerdictPanel turns={[plainFailure]} onVerdictTurn={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "审批请求" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /创建新回合重试/ })).toBeInTheDocument();
  });
});
