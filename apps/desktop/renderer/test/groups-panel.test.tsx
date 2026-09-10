import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
        mode: "parallel",
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

    const liveProgress = await screen.findByRole("group", { name: "执行进展" });
    const liveDisclosure = within(liveProgress).getByRole("button");
    expect(liveDisclosure).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(liveDisclosure);
    expect(liveDisclosure).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(timeline.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2500 });
    await waitFor(() => expect(screen.getByText("OWNER_DONE")).toBeInTheDocument());
    expect(screen.queryByText(/已发送给/)).not.toBeInTheDocument();
    expect(document.querySelector(".owb-bubble--operator")).toHaveTextContent("@Repo Owner 检查");
    expect(onReconcileTimeline).toHaveBeenCalledWith(completedTimeline());
    expect(container.querySelectorAll(".owb-bubble-row--employee")).toHaveLength(1);
    expect(container.querySelectorAll(".is-running")).toHaveLength(0);
    expect(screen.queryByText("working")).not.toBeInTheDocument();
    const terminalProgress = screen.getByRole("group", { name: "执行进展" });
    expect(within(terminalProgress).getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(within(terminalProgress).getByRole("button")).toHaveTextContent("已完成");
    expect(within(terminalProgress).getByRole("timer")).toHaveTextContent("1s");
    fireEvent.click(within(terminalProgress).getByRole("button"));
    expect(within(terminalProgress).getByText("回合已完成")).toBeVisible();
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

  it("preserves a member's process disclosure while new streamed output arrives", async () => {
    installBridge();
    const panel = (run: LiveRunState) => (
      <GroupsPanel workspaceOpen positions={positions} positionNames={positionNames}
        engine="qoder" engineAvailability={{ qoder: readyAvailability, "claude-code": readyAvailability, "claude-local": readyAvailability }}
        liveRuns={{ "engine-run-owner": run }} onSelectEngine={() => {}} onSpawnRuns={() => {}} onReconcileTimeline={() => {}} />
    );
    const { rerender } = render(panel(liveOwner));
    const progress = await screen.findByRole("group", { name: "执行进展" });
    fireEvent.click(within(progress).getByRole("button"));
    expect(within(progress).getByRole("button")).toHaveAttribute("aria-expanded", "false");
    await act(async () => rerender(panel({ ...liveOwner, text: "New public result" })));
    expect(within(screen.getByRole("group", { name: "执行进展" })).getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("New public result")).toBeVisible();
    expect(screen.queryByText(/执行工具/)).not.toBeInTheDocument();
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
    expect(screen.getAllByRole("group", { name: "执行进展" })).toHaveLength(1);
    expect(within(screen.getByRole("group", { name: "执行进展" })).getByRole("button")).toHaveAttribute("aria-expanded", "true");
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

it("sends explicit relay in selected order and restores mode, outputs and blocked steps from the timeline", async () => {
  const timeline: GroupTimeline = { schemaVersion: "group-timeline.v1", conversationRef: group.conversationRef, items: [
    { kind: "user", schemaVersion: "group-message.v1", conversationRef: group.conversationRef, messageId: "relay-old", input: "write and review", mode: "relay", mentions: ["release-engineer", "repo-owner"], createdAt: group.createdAt },
    { kind: "member", turn: { ...completedTurn(), output: "first step draft" } },
    { kind: "member", turn: { ...completedTurn(), turnId: "blocked", positionId: "release-engineer", status: "indeterminate", output: undefined, error: { code: "group_relay_blocked", message: "Earlier step failed", retryable: false } } },
  ] };
  const { bridge } = renderPanel({
    timeline: vi.fn().mockResolvedValue({ status: 200, body: timeline }),
    createGroupTurn: vi.fn().mockResolvedValue({ status: 202, body: { conversationRef: group.conversationRef, messageId: "relay-new", spawns: [] } }),
  });
  expect(await screen.findByText("first step draft")).toBeInTheDocument();
  expect(screen.getByText("未执行：前序步骤未成功，接力已停止。")).toBeInTheDocument();
  const blockedReply = screen.getByText("Earlier step failed").closest("article")!;
  expect(within(blockedReply).queryByRole("group", { name: "执行进展" })).not.toBeInTheDocument();
  expect(within(blockedReply).queryByRole("timer")).not.toBeInTheDocument();
  expect(screen.getByText(/依次接力 · Release Engineer → Repo Owner/)).toBeInTheDocument();
  pickSelectOption("协作方式", "依次接力");
  pickSelectOption("选择要 @ 的成员", "Release Engineer");
  pickSelectOption("选择要 @ 的成员", "Repo Owner");
  expect(screen.getByText(/按选择顺序执行：Release Engineer → Repo Owner/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "群聊消息" }), { target: { value: "next relay" } });
  fireEvent.click(screen.getByRole("button", { name: "发送群消息" }));
  await waitFor(() => expect(bridge.createGroupTurn).toHaveBeenCalledWith({ conversationRef: group.conversationRef, input: "next relay", engine: "qoder", mentions: ["release-engineer", "repo-owner"], mode: "relay" }));
});

it.each(["create", "add"] as const)("does not refresh another workspace after an abandoned %s request finishes", async (action) => {
  let finish: (value: { status: number; body: unknown }) => void = () => {};
  const request = vi.fn(() => new Promise<{ status: number; body: unknown }>((resolve) => { finish = resolve; }));
  const { unmount } = renderPanel(action === "create" ? { groups: [], createGroup: request } : { addGroupMember: request });
  if (action === "create") {
    await screen.findByRole("combobox", { name: "搜索并选择群成员" });
    pickSelectOption("搜索并选择群成员", "Repo Owner");
    pickSelectOption("搜索并选择群成员", "Community Operator");
    fireEvent.click(screen.getByRole("button", { name: "创建群聊" }));
  } else {
    await screen.findByRole("combobox", { name: "添加员工" });
    pickSelectOption("添加员工", "Community Operator");
  }
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  unmount();
  const nextWorkspace = installBridge();
  await act(async () => finish({ status: action === "create" ? 201 : 200, body: group }));
  expect(nextWorkspace.groups).not.toHaveBeenCalled();
  expect(nextWorkspace.groupTimeline).not.toHaveBeenCalled();
});

it("does not reconcile an abandoned workspace timeline into shared App state", async () => {
  let finish: (value: unknown) => void = () => {};
  const timeline = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  const onReconcileTimeline = vi.fn();
  const { unmount } = renderPanel({ timeline, onReconcileTimeline });
  await waitFor(() => expect(timeline).toHaveBeenCalledTimes(1));
  unmount();
  await act(async () => finish({ status: 200, body: { schemaVersion: "group-timeline.v1", conversationRef: group.conversationRef, items: [{ kind: "member", turn: completedTurn() }] } }));
  expect(onReconcileTimeline).not.toHaveBeenCalled();
});
