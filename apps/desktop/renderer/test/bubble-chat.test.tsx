import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GroupsPanel } from "../src/groups/GroupsPanel";
import { TurnThread } from "../src/turns";
import type { OwbBridge } from "../src/owb";
import type { GroupConversation, TurnRecord as ApiTurnRecord } from "@org-workbench/shared";
import type { TurnEngineAvailability, TurnRecord } from "../src/turns/types";

/** Turn rendering structure.
 *
 * #73 Control Plane v2 replaced the position panel's #61 bubble layout with
 * the evidence timeline (state dot + `.owb-tc` console card): head carries
 * position + engine + terminal state, the dispatched task and the engine
 * output both stay visible, evidence chips keep the audit red line, and the
 * approval card is embedded in the same card. The group-chat timeline still
 * renders #61 bubbles, so those assertions are unchanged.
 * Contract layer untouched in both cases. */

function turn(overrides: Partial<TurnRecord>): TurnRecord {
  return {
    id: "turn-1",
    positionId: "release-engineer",
    positionName: "发布负责人",
    engine: "qoder",
    input: "检查发布门禁",
    status: "completed",
    createdAt: "2026-08-26T04:00:00.000Z",
    output: "门禁已检查。",
    ...overrides,
  };
}

describe("TurnThread evidence timeline (#73)", () => {
  it("renders one timeline card per turn carrying position, engine, the dispatched task and the output", () => {
    const { container } = render(<TurnThread turns={[turn({})]} />);
    const item = container.querySelector(".owb-turn");
    const card = item?.querySelector(".owb-tc");
    expect(item).not.toBeNull();
    expect(card).not.toBeNull();
    // 端点身份：岗位名 + 引擎标签在卡头
    expect(card?.querySelector(".owb-tc-head__who")?.textContent).toBe("发布负责人");
    expect(card?.querySelector(".owb-tc-head")?.textContent).toContain("Qoder");
    // 下达任务与引擎输出都必须可见（不因换布局而丢掉任一侧）。
    // #248 R2 ④: 下达任务在操作员气泡（右），输出在岗位气泡（左）。
    expect(item?.querySelector(".owb-bubble--operator")?.textContent).toContain("检查发布门禁");
    expect(card?.querySelector(".owb-tc__out")?.textContent).toContain("门禁已检查。");
    // 状态行给出可信终态词，settled 回合不再显示 running
    const statusline = card?.querySelector(".owb-turn__statusline");
    expect(statusline?.textContent).toContain("可信终态");
  });

  it("marks running and indeterminate turns with distinct timeline states", () => {
    const { container: running } = render(
      <TurnThread turns={[turn({ id: "run-1", status: "running", output: undefined })]} />,
    );
    expect(running.querySelector(".owb-turn")?.className).toContain("is-running");
    expect(running.querySelector(".owb-tc")?.className).toContain("is-running");

    const { container: unsure } = render(
      <TurnThread turns={[turn({ id: "ind-1", status: "indeterminate", output: undefined })]} />,
    );
    expect(unsure.querySelector(".owb-turn")?.className).toContain("is-indeterminate");
    // 诚实性：不确定终态不得被升级成成功词
    const statusline = unsure.querySelector(".owb-turn__statusline");
    expect(statusline?.textContent).toContain("不确定");
    expect(statusline?.textContent).not.toContain("可信终态");
  });

  it("shows the typing indicator while the employee turn is running", () => {
    render(<TurnThread turns={[turn({ id: "run-1", status: "running", output: undefined })]} />);
    const typing = screen.getByRole("status");
    expect(typing.className).toContain("owb-bubble__typing");
    expect(typing.textContent).toContain("正在等待岗位完成本回合");
  });

  it("keeps evidence auditable: digest chips shortened by default, expanding reveals full mono values", () => {
    const { container } = render(
      <TurnThread turns={[turn({ id: "ev-1", envelopeDigest: "sha256:envelope-full-value", evidenceDigest: "sha256:evidence-full-value" })]} />,
    );
    const toggle = container.querySelector(".owb-ev--button") as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    // 折叠态：短摘要展示，全值仍可经 title 取到（证据不丢——审计红线）
    expect(toggle?.getAttribute("title")).toBe("sha256:envelope-full-value");
    fireEvent.click(toggle as HTMLButtonElement);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    const chips = Array.from(container.querySelectorAll(".owb-ev kbd")).map((kbd) => kbd.textContent);
    expect(chips).toContain("sha256:envelope-full-value");
    expect(chips).toContain("sha256:evidence-full-value");
    // turn id 始终作为独立印章 chip 存在
    expect(container.querySelector('.owb-ev[title="ev-1"]')).not.toBeNull();
  });

  it("embeds the approval card inside the timeline console card", () => {
    render(
      <TurnThread
        turns={[
          turn({
            id: "appr-1",
            status: "failed",
            output: undefined,
            error: "engine.approval_required: awaiting operator verdict",
            approvalRequest: { approvalId: "appr-9", kind: "exec", description: "rm -rf dist" },
          }),
        ]}
        onVerdict={() => {}}
      />,
    );
    const card = screen.getByRole("group", { name: "审批请求" });
    expect(card.closest(".owb-tc")).not.toBeNull();
    expect(screen.getByRole("button", { name: "批准并继续" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeInTheDocument();
  });
});

describe("group chat bubbles with member identity (#61)", () => {
  const group: GroupConversation = {
    schemaVersion: "conversation-group.v1",
    conversationRef: "11111111-2222-4333-8444-555555555555",
    sessionId: "99999999-8888-4777-8666-555555555555",
    members: ["repo-owner", "release-engineer"],
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };

  it("renders member bubbles carrying avatar + @name identity and right-aligned operator bubbles", async () => {
    const memberTurn: ApiTurnRecord = {
      schemaVersion: "turn-record.v1",
      conversationId: "conv-1",
      turnId: "turn-g1",
      positionId: "release-engineer",
      engine: "qoder",
      status: "completed",
      input: "发布检查",
      envelopeDigest: "sha256:0",
      createdAt: "2026-08-26T04:10:00.000Z",
      updatedAt: "2026-08-26T04:11:00.000Z",
      events: [],
      output: "发布已检查。",
    };
    const bridge = {
      groups: vi.fn().mockResolvedValue({
        status: 200,
        body: { schemaVersion: "conversation-group-list.v1", groups: [group] },
      }),
      groupTimeline: vi.fn().mockResolvedValue({
        status: 200,
        body: {
          schemaVersion: "group-timeline.v1",
          conversationRef: group.conversationRef,
          items: [
            {
              kind: "user",
              schemaVersion: "group-message.v1",
              messageId: "m1",
              conversationRef: group.conversationRef,
              input: "各位同步进度",
              mentions: ["release-engineer"],
              createdAt: "2026-08-26T04:09:00.000Z",
            },
            { kind: "member", turn: memberTurn },
          ],
        },
      }),
      onEvent: vi.fn().mockReturnValue(() => {}),
    };
    window.owb = bridge as unknown as OwbBridge;

    const availability: TurnEngineAvailability = { configured: true, ready: true };
    const { container } = render(
      <GroupsPanel
        workspaceOpen
        positions={[
          { id: "repo-owner", name: "Repo Owner" },
          { id: "release-engineer", name: "Release Engineer" },
        ]}
        positionNames={{ "repo-owner": "Repo Owner", "release-engineer": "Release Engineer" }}
        positionColors={{ "release-engineer": "#5e6ad2" }}
        engine="qoder"
        engineAvailability={{
          qoder: availability,
          "claude-code": availability,
          "claude-local": availability,
          codex: availability,
          "codex-local": availability,
        }}
        liveRuns={{}}
        onSelectEngine={() => {}}
        onSpawnRuns={() => {}}
        onReconcileTimeline={() => {}}
        draftSeed={null}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(".owb-bubble-row--employee .owb-bubble__avatar")).not.toBeNull();
    });
    const memberRow = container.querySelector(".owb-bubble-row--employee");
    expect(memberRow?.querySelector(".owb-bubble__avatar")).toHaveStyle({ background: "#5e6ad2" });
    expect(memberRow?.querySelector(".owb-bubble__name")?.textContent).toBe("@Release Engineer");
    expect(memberRow?.textContent).toContain("发布已检查。");
    const operatorRow = container.querySelector(".owb-bubble-row--operator .owb-bubble--operator");
    expect(operatorRow?.textContent).toContain("各位同步进度");
    // operator avatar + per-member route note (explicit routing, never broadcast)
    expect(container.querySelector(".owb-bubble__avatar--operator")).not.toBeNull();
    expect(container.textContent).toContain("逐成员 spawn 1 回合（显式路由，不广播）");
  });
});
