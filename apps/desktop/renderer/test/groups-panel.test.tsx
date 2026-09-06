import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { pickSelectOption } from "./select-helper";
import { GroupsPanel } from "../src/groups/GroupsPanel";
import type { OwbBridge } from "../src/owb";
import type { GroupConversation, GroupTimeline, TurnRecord } from "@roleweave/shared";
import type { LiveRunState } from "../src/turns/turnStream";
import type { TurnEngineAvailability } from "../src/turns/types";

/** #53 S3 collaboration visuals: the avatar stack and member roster consume
 * the existing /groups* bridge surface — no new channel is introduced. */

const group: GroupConversation = {
  schemaVersion: "conversation-group.v1",
  conversationRef: "11111111-2222-4333-8444-555555555555",
  sessionId: "99999999-8888-4777-8666-555555555555",
  members: ["repo-owner", "release-engineer"],
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

const positions = [
  { id: "repo-owner", name: "Repo Owner" },
  { id: "release-engineer", name: "Release Engineer" },
  { id: "community-operator", name: "Community Operator" },
];

const positionNames = Object.fromEntries(positions.map((position) => [position.id, position.name]));

const readyAvailability: TurnEngineAvailability = { configured: true, ready: true };

function installBridge(
  options: {
    groups?: GroupConversation[];
    timeline?: ReturnType<typeof vi.fn>;
    createGroup?: () => Promise<{ status: number; body: unknown }>;
    addGroupMember?: () => Promise<{ status: number; body: unknown }>;
    createGroupTurn?: () => Promise<{ status: number; body: unknown }>;
  } = {},
): OwbBridge {
  const bridge = {
    groups: vi.fn().mockResolvedValue({
      status: 200,
      body: { schemaVersion: "conversation-group-list.v1", groups: options.groups ?? [group] },
    }),
    groupTimeline:
      options.timeline ??
      vi.fn().mockResolvedValue({
        status: 200,
        body: { schemaVersion: "group-timeline.v1", conversationRef: group.conversationRef, items: [] },
      }),
    ...(options.createGroup ? { createGroup: vi.fn(options.createGroup) } : {}),
    ...(options.addGroupMember ? { addGroupMember: vi.fn(options.addGroupMember) } : {}),
    ...(options.createGroupTurn ? { createGroupTurn: vi.fn(options.createGroupTurn) } : {}),
    onEvent: vi.fn().mockReturnValue(() => {}),
  };
  window.owb = bridge as unknown as OwbBridge;
  return window.owb;
}

function renderPanel(
  extra: {
    draftSeed?: { members: string[]; nonce: number } | null;
    groups?: GroupConversation[];
    liveRuns?: Record<string, LiveRunState>;
    timeline?: ReturnType<typeof vi.fn>;
    createGroup?: () => Promise<{ status: number; body: unknown }>;
    addGroupMember?: () => Promise<{ status: number; body: unknown }>;
    createGroupTurn?: () => Promise<{ status: number; body: unknown }>;
    onReconcileTimeline?: (timeline: GroupTimeline) => void;
  } = {},
) {
  const bridge = installBridge({
    groups: extra.groups ?? [group],
    timeline: extra.timeline,
    createGroup: extra.createGroup,
    addGroupMember: extra.addGroupMember,
    createGroupTurn: extra.createGroupTurn,
  });
  return {
    bridge,
    ...render(
    <GroupsPanel
      workspaceOpen
      positions={positions}
      positionNames={positionNames}
      positionColors={{ "repo-owner": "#5e6ad2" }}
      engine="qoder"
      engineAvailability={{
        qoder: readyAvailability,
        "claude-code": readyAvailability,
        "claude-local": readyAvailability,
      }}
      liveRuns={extra.liveRuns ?? {}}
      onSelectEngine={() => {}}
      onSpawnRuns={() => {}}
      onReconcileTimeline={extra.onReconcileTimeline ?? (() => {})}
      draftSeed={extra.draftSeed ?? null}
    />,
    ),
  };
}

function completedTurn(): TurnRecord {
  return {
    schemaVersion: "turn-record.v1",
    conversationId: "repo-owner",
    conversationRef: group.conversationRef,
    groupRef: group.conversationRef,
    turnId: "turn-owner",
    positionId: "repo-owner",
    engine: "qoder",
    status: "completed",
    input: "@Repo Owner 检查",
    envelopeDigest: "sha256:owner",
    createdAt: "2026-09-01T00:00:01.000Z",
    updatedAt: "2026-09-01T00:00:02.000Z",
    events: [],
    output: "OWNER_DONE",
  };
}

const liveOwner: LiveRunState = {
  groupRef: group.conversationRef,
  messageId: "message-1",
  turnId: "turn-owner",
  positionId: "repo-owner",
  engine: "qoder",
  input: "@Repo Owner 检查",
  text: "working",
  startedAt: "2026-09-01T00:00:01.000Z",
  totalTokens: null,
};

function completedTimeline(): GroupTimeline {
  return {
    schemaVersion: "group-timeline.v1",
    conversationRef: group.conversationRef,
    items: [
      {
        kind: "user",
        schemaVersion: "group-message.v1",
        conversationRef: group.conversationRef,
        messageId: "message-1",
        input: "@Repo Owner 检查",
        mentions: ["repo-owner"],
        createdAt: "2026-09-01T00:00:00.000Z",
      },
      { kind: "member", turn: completedTurn() },
    ],
  };
}

describe("GroupsPanel collaboration visuals (#53)", () => {
  it("renders the member avatar stack in the group header and the member roster sidebar", async () => {
    const { container } = renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("群成员 2 人")).toBeInTheDocument();
    });
    const stack = screen.getByLabelText("群成员 2 人");
    expect(stack.querySelectorAll(".owb-groups__avatar")).toHaveLength(2);
    expect(stack.querySelector('[title="Repo Owner"]')).toHaveStyle({ background: "#5e6ad2" });
    const roster = container.querySelector(".owb-groups__roster-items");
    expect(roster).toHaveTextContent("Repo Owner");
    expect(roster).toHaveTextContent("Release Engineer");
    expect(roster).not.toHaveTextContent("Community Operator");
    expect(container.querySelectorAll(".owb-groups__roster-item")).toHaveLength(2);
  });

  it("adds an available employee from the roster picker", async () => {
    const addGroupMember = vi.fn().mockResolvedValue({
      status: 200,
      body: { ...group, members: [...group.members, "community-operator"] },
    });
    const { bridge } = renderPanel({ addGroupMember });
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "添加员工" })).toBeInTheDocument();
    });

    pickSelectOption("添加员工", "Community Operator");

    await waitFor(() => {
      expect(addGroupMember).toHaveBeenCalledWith({
        conversationRef: group.conversationRef,
        positionId: "community-operator",
      });
    });
    expect(bridge.addGroupMember).toHaveBeenCalledTimes(1);
  });

  it("org-tree draftSeed prefills the create panel with the seeded member", async () => {
    const { container } = renderPanel({ draftSeed: { members: ["repo-owner"], nonce: 1 } });
    await waitFor(() => {
      const details = container.querySelector("details.owb-groups__create");
      expect(details).toHaveAttribute("open");
    });
    expect(screen.getByRole("combobox", { name: "搜索并选择群成员" })).toBeInTheDocument();
    expect(screen.getByText("已选 1 人")).toBeInTheDocument();
    // Explicit-action discipline: a single seeded member still cannot create.
    expect(screen.getByRole("button", { name: "创建群聊" })).toBeDisabled();
  });

  it("creates a group from searchable member selection", async () => {
    const created: GroupConversation = {
      ...group,
      conversationRef: "22222222-3333-4444-8555-666666666666",
      members: ["repo-owner", "community-operator"],
    };
    const createGroup = vi.fn().mockResolvedValue({ status: 201, body: created });
    const { bridge } = renderPanel({ groups: [], createGroup });

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "搜索并选择群成员" })).toBeInTheDocument();
    });
    pickSelectOption("搜索并选择群成员", "Repo Owner");
    pickSelectOption("搜索并选择群成员", "Community Operator");

    expect(screen.getByRole("button", { name: "创建群聊" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "创建群聊" }));

    await waitFor(() => {
      expect(bridge.createGroup).toHaveBeenCalledWith({
        memberPositionIds: ["repo-owner", "community-operator"],
      });
    });
  });

  it("routes a message only to recipients selected in the searchable picker", async () => {
    const createGroupTurn = vi.fn().mockResolvedValue({
      status: 202,
      body: {
        conversationRef: group.conversationRef,
        messageId: "message-2",
        spawns: [{ turnId: "turn-owner-2", positionId: "repo-owner" }],
      },
    });
    const { bridge } = renderPanel({ createGroupTurn });
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "选择要 @ 的成员" })).toBeInTheDocument();
    });

    pickSelectOption("选择要 @ 的成员", "Repo Owner");
    fireEvent.change(screen.getByRole("textbox", { name: "群聊消息" }), {
      target: { value: "请检查发布说明" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送群消息" }));

    await waitFor(() => {
      expect(bridge.createGroupTurn).toHaveBeenCalledWith({
        conversationRef: group.conversationRef,
        input: "请检查发布说明",
        engine: "qoder",
        mentions: ["repo-owner"],
      });
    });
  });

  // #94 defect 2: this panel's Agent Host column was a *fixed* 150px track, so
  // it never widened at any window size. It must render the same compact
  // trigger label as TurnPanel — i.e. go through the shared EngineSelect.
  it("renders the Agent Host trigger through the shared compact picker", async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "选择 Agent Host" })).toBeInTheDocument();
    });
    const trigger = document.querySelector(".owb-groups__panel-sub .ant-select-content");
    expect(trigger).toHaveTextContent("Qoder");
    expect(trigger).not.toHaveTextContent("Configured");
    expect(trigger?.querySelector("img.owb-engine-icon")).not.toBeNull();
  });

  it("ignores a draftSeed whose members are all unknown positions", async () => {
    const { container } = renderPanel({ draftSeed: { members: ["ghost-position"], nonce: 1 } });
    await waitFor(() => {
      expect(screen.getByLabelText("群成员 2 人")).toBeInTheDocument();
    });
    const details = container.querySelector("details.owb-groups__create");
    expect(details).not.toHaveAttribute("open");
  });

  it("reconciles persisted terminal facts after a dropped SSE stream without duplicate bubbles (#114)", async () => {
    const timeline = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        body: { schemaVersion: "group-timeline.v1", conversationRef: group.conversationRef, items: [] },
      })
      .mockResolvedValue({ status: 200, body: completedTimeline() });
    const onReconcileTimeline = vi.fn();
    const { container } = renderPanel({
      liveRuns: { "engine-run-owner": liveOwner },
      timeline,
      onReconcileTimeline,
    });

    await waitFor(() => expect(timeline.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2500 });
    await waitFor(() => expect(screen.getByText("OWNER_DONE")).toBeInTheDocument());
    expect(screen.queryByText(/已发送给/)).not.toBeInTheDocument();
    expect(document.querySelector(".owb-bubble--operator")).toHaveTextContent("@Repo Owner 检查");
    expect(onReconcileTimeline).toHaveBeenCalledWith(completedTimeline());
    expect(container.querySelectorAll(".owb-bubble-row--employee")).toHaveLength(1);
    expect(container.querySelectorAll(".is-running")).toHaveLength(0);
    expect(screen.queryByText("working")).not.toBeInTheDocument();
  });

  it("polls a persisted running turn to terminal when the listener attached after its spawn (#114)", async () => {
    const running = { ...completedTurn(), status: "running" as const, output: undefined };
    const runningTimeline: GroupTimeline = {
      ...completedTimeline(),
      items: [completedTimeline().items[0]!, { kind: "member", turn: running }],
    };
    const timeline = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: runningTimeline })
      .mockResolvedValue({ status: 200, body: completedTimeline() });
    const { container } = renderPanel({ timeline });

    await waitFor(() => expect(screen.getByText("1 运行中")).toBeInTheDocument());
    await waitFor(() => expect(timeline.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2500 });
    await waitFor(() => expect(screen.getByText("OWNER_DONE")).toBeInTheDocument());
    expect(container.querySelectorAll(".owb-bubble-row--employee")).toHaveLength(1);
    expect(container.querySelectorAll(".is-running")).toHaveLength(0);
  });

  it("cancels persisted-running reconciliation when the panel unmounts (#114)", async () => {
    const running = { ...completedTurn(), status: "running" as const, output: undefined };
    const timelineBody: GroupTimeline = {
      ...completedTimeline(),
      items: [completedTimeline().items[0]!, { kind: "member", turn: running }],
    };
    const timeline = vi.fn().mockResolvedValue({ status: 200, body: timelineBody });
    const { unmount } = renderPanel({ timeline });

    await waitFor(() => expect(screen.getByText("1 运行中")).toBeInTheDocument());
    expect(timeline).toHaveBeenCalledTimes(1);
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(timeline).toHaveBeenCalledTimes(1);
  });

  it("keeps a persisted running member busy while deduplicating its live buffer (#114)", async () => {
    const running = { ...completedTurn(), status: "running" as const, output: undefined };
    const timelineBody: GroupTimeline = {
      ...completedTimeline(),
      items: [completedTimeline().items[0]!, { kind: "member", turn: running }],
    };
    const timeline = vi.fn().mockResolvedValue({ status: 200, body: timelineBody });
    const { container } = renderPanel({
      liveRuns: { "engine-run-owner": liveOwner },
      timeline,
    });

    await waitFor(() => expect(screen.getByText("1 运行中")).toBeInTheDocument());
    expect(container.querySelectorAll(".owb-bubble-row--employee")).toHaveLength(1);
  });
});

const sessionConflict = {
  status: 409,
  body: {
    code: "session_conflict",
    message: "position already has an active session; rotate it explicitly",
  },
};

/** #116 AC-003: a create the server refused must be readable, not a silent no-op. */
describe("GroupsPanel create failure alert (#116)", () => {
  it("shows the server error even when no group exists to select", async () => {
    const { container } = renderPanel({
      groups: [],
      draftSeed: { members: ["repo-owner", "release-engineer"], nonce: 1 },
      createGroup: async () => sessionConflict,
    });
    await waitFor(() => {
      expect(screen.getByText(/选择或新建一个群聊/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "创建群聊" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("position already has an active session; rotate it explicitly");
    // The alert belongs to the conversation region, and the empty state it was
    // previously hidden behind is still the empty state.
    expect(alert.closest(".owb-groups__panel")).not.toBeNull();
    expect(container.querySelector(".owb-groups__panel-header")).toBeNull();
  });

  it("keeps showing the error when a group is already selected", async () => {
    renderPanel({
      draftSeed: { members: ["repo-owner", "release-engineer"], nonce: 1 },
      createGroup: async () => sessionConflict,
    });
    await waitFor(() => {
      expect(screen.getByLabelText("群成员 2 人")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "创建群聊" }));

    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("position already has an active session");
  });
});
