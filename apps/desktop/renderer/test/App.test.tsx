import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { pickSelectOption, visibleSelectOptions } from "./select-helper";
import { App } from "../src/App";
import type { OwbBridge } from "../src/owb";
import type { ReportsResponse, TurnHistory, TurnRecord, WorkbenchSession } from "@roleweave/shared";

const activeSession: WorkbenchSession = {
  schemaVersion: "workbench-session.v1",
  sessionId: "11111111-1111-4111-8111-111111111111",
  workspaceInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  positionId: "repo-owner",
  principal: "position.repo-owner",
  status: "active",
  rotatedFrom: null,
  rotatedTo: null,
  createdAt: "2026-08-24T03:00:00.000Z",
  rotatedAt: null,
};

function installBridge(overrides: Partial<OwbBridge> = {}): OwbBridge {
  const bridge: OwbBridge = {
    status: vi.fn().mockResolvedValue({
      running: true,
      port: 43123,
      health: {
        status: "ok",
        api: "v0",
        server: { version: "0.0.0", pid: 123 },
        engine: { command: "digital-employee", available: true, version: "main" },
        hosts: {
          qoder: { configured: false, ready: false, nextStep: "设置 QODER_PERSONAL_ACCESS_TOKEN 后重启工作台" },
          "claude-code": { configured: false, ready: false, nextStep: "设置 ANTHROPIC_API_KEY 后重启工作台" },
          "claude-local": {
            configured: false,
            ready: false,
            nextStep: "安装 Claude Code 并确保 claude 在 PATH 上（或用 DIGITAL_EMPLOYEE_CLAUDE_COMMAND 指定二进制路径）",
          },
        },
        workspace: { open: false },
      },
    }),
    openWorkspace: vi.fn().mockResolvedValue({ canceled: true }),
    createWorkspace: vi.fn().mockResolvedValue({ canceled: true }),
    workspace: vi.fn().mockResolvedValue({ status: 200, body: { open: false } }),
    orgTree: vi.fn().mockResolvedValue({ status: 200, body: null }),
    orgApply: vi.fn().mockResolvedValue({ status: 500, body: { code: "internal" } }),
    hire: vi.fn().mockResolvedValue({
      status: 500,
      body: { status: "failed", code: "internal", message: "unexpected", retryable: false },
    }),
    orgBackups: vi.fn().mockResolvedValue({ status: 200, body: { schemaVersion: "org-backups.v1", backups: [] } }),
    orgRestore: vi.fn().mockResolvedValue({ status: 404, body: { code: "restore_invalid" } }),
    orgUndo: vi.fn().mockResolvedValue({ status: 404, body: { code: "not_found", message: "nothing undoable" } }),
    reports: vi.fn().mockResolvedValue({ status: 200, body: emptyReports() }),
    position: vi.fn().mockResolvedValue({ status: 404, body: { code: "position_missing" } }),
    drive: {
      list: vi.fn().mockResolvedValue({
        status: 200,
        body: { schemaVersion: "drive-object-list.v1", objects: [], mocked: true },
      }),
      detail: vi.fn().mockResolvedValue({ status: 404, body: { code: "asset_not_found" } }),
      upload: vi.fn().mockResolvedValue({ status: 202, body: { stub: true, filePath: "", message: "stub" } }),
      pickAndUpload: vi.fn().mockResolvedValue({ canceled: true }),
    },
    createTurn: vi.fn().mockResolvedValue({ status: 500, body: { code: "internal", message: "unexpected" } }),
    turnHistory: vi.fn().mockResolvedValue({
      status: 200,
      body: { schemaVersion: "turn-history.v1", conversationId: "empty", positionId: "repo-owner", turns: [] },
    }),
    createSession: vi.fn().mockResolvedValue({ status: 201, body: activeSession }),
    sessions: vi.fn().mockResolvedValue({
      status: 200,
      body: { schemaVersion: "workbench-session-list.v1", positionId: "repo-owner", activeSessionId: activeSession.sessionId, sessions: [activeSession] },
    }),
    session: vi.fn().mockResolvedValue({ status: 200, body: activeSession }),
    rotateSession: vi.fn().mockResolvedValue({ status: 500, body: { code: "internal" } }),
    createSessionTurn: vi.fn().mockResolvedValue({ status: 500, body: { code: "internal", message: "unexpected" } }),
    sessionTurnHistory: vi.fn().mockResolvedValue({
      status: 200,
      body: { schemaVersion: "turn-history.v1", conversationId: activeSession.sessionId, positionId: "repo-owner", turns: [] },
    }),
    sseStatus: vi.fn().mockResolvedValue("connected"),
    // #134: the settings module only touches these once its rail entry is
    // selected, so the default is the honest one for a source-tree run — no
    // packaged build, therefore no publisher identity and no channel.
    update: {
      status: vi.fn().mockResolvedValue({
        version: "0.1.0",
        state: "unavailable",
        available: false,
        requiresConfirmation: false,
        signed: false,
        updateVerified: false,
        reason: "no packaged resources path; this is a source-tree run",
        platform: "linux",
      }),
      check: vi.fn().mockResolvedValue(null),
      download: vi.fn().mockResolvedValue(null),
      install: vi.fn().mockResolvedValue(null),
      openReleaseNotes: vi.fn().mockResolvedValue({ ok: true }),
    },
    onUpdateState: vi.fn().mockReturnValue(() => undefined),
    onEvent: vi.fn().mockReturnValue(() => undefined),
    onSseStatus: vi.fn().mockReturnValue(() => undefined),
    onFallbackNotice: vi.fn().mockReturnValue(() => undefined),
    ...overrides,
  };
  Object.defineProperty(window, "owb", { configurable: true, value: bridge });
  return bridge;
}

const snapshot = {
  schemaVersion: "org-tree.v1" as const,
  business: "开源业务",
  owner: "repo-owner",
  updatedAt: "2026-08-24T04:00:00.000Z",
  positionCount: 1,
  depth: 1,
  tree: [{
    id: "repo-owner",
    reportTo: null,
    budget: { perTask: { tokens: 1000 }, perDay: { tokens: 5000 } },
    children: [],
  }],
};

const position = {
  id: "repo-owner",
  name: "代码库负责人",
  description: "负责开源仓库",
  reportTo: null,
  mode: "approval_required" as const,
  contextScope: "position",
  permissions: { toolAllow: [], toolDeny: [] },
  budget: { perTask: { tokens: 1000 }, perDay: { tokens: 5000 } },
  metadata: {},
};

function apiTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: "turn-record.v1",
    conversationId: "conversation-1",
    turnId: "turn-existing",
    positionId: "repo-owner",
    engine: "qoder",
    status: "completed",
    input: "历史任务",
    envelopeDigest: "sha256:existing",
    createdAt: "2026-08-24T04:00:00.000Z",
    updatedAt: "2026-08-24T04:01:00.000Z",
    events: [],
    output: "历史结果",
    ...overrides,
  };
}

function history(turns: TurnRecord[]): TurnHistory {
  return {
    schemaVersion: "turn-history.v1",
    conversationId: "conversation-1",
    positionId: "repo-owner",
    turns,
  };
}

function openedBridge(overrides: Partial<OwbBridge> = {}): OwbBridge {
  return installBridge({
    status: vi.fn().mockResolvedValue({
      running: true,
      health: {
        status: "ok",
        api: "v0",
        server: { version: "0.0.0", pid: 123 },
        engine: { command: "digital-employee", available: true, version: "main" },
        hosts: {
          qoder: { configured: true, ready: true },
          "claude-code": { configured: false, ready: false, nextStep: "设置 ANTHROPIC_API_KEY 后重启工作台" },
          "claude-local": { configured: true, ready: true },
        },
        workspace: { open: true, path: "/fixture/workspace" },
      },
    }),
    workspace: vi.fn().mockResolvedValue({
      status: 200,
      body: { open: true, path: "/fixture/workspace", business: "开源业务" },
    }),
    orgTree: vi.fn().mockResolvedValue({ status: 200, body: snapshot }),
    position: vi.fn().mockResolvedValue({ status: 200, body: { position } }),
    ...overrides,
  });
}

function emptyReports(): ReportsResponse {
  return { schemaVersion: "reports.v1", streams: { escalations: [], audits: [], evidence: [] }, budgets: [], page: { cursor: null, hasMore: false } };
}

async function selectRepoOwner(): Promise<void> {
  const tree = await screen.findByRole("tree");
  const row = tree.querySelector('[data-org-node-id="repo-owner"]');
  expect(row).not.toBeNull();
  fireEvent.click(row!);
  expect(await screen.findByRole("heading", { name: "本地对话" })).toBeInTheDocument();
}

describe("App runtime bridge", () => {
  it("renders the real engine health shape and reads the current SSE status", async () => {
    installBridge();

    render(<App />);

    expect(await screen.findByText("引擎可用")).toBeInTheDocument();
    expect(await screen.findByText("尚未打开工作区")).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(screen.queryByText("事件流重连中…")).not.toBeInTheDocument();
    });
  });

  it("shows the local workspace path in the topbar context", async () => {
    openedBridge();

    render(<App />);

    expect(await screen.findByLabelText("/fixture/workspace")).toBeInTheDocument();
    expect(screen.getAllByTitle("/fixture/workspace").length).toBeGreaterThan(0);
  });

  it("keeps project switching at the top of the organization sidebar", async () => {
    const openWorkspace = vi.fn().mockResolvedValue({ canceled: true });
    openedBridge({ openWorkspace });

    render(<App />);

    const projectEntry = await screen.findByRole("button", { name: "项目入口" });
    expect(projectEntry).toHaveTextContent("开源业务");
    expect(projectEntry).not.toHaveTextContent("/fixture/workspace");
    fireEvent.click(projectEntry);

    const menu = screen.getByRole("menu", { name: "项目入口" });
    expect(within(menu).getByText("当前项目")).toBeInTheDocument();
    expect(within(menu).getByText("/fixture/workspace")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /打开项目/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /新建项目/ })).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole("menuitem", { name: /打开项目/ }));
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "项目入口" })).not.toBeInTheDocument();
  });

  it("#128 AC-001: clicking a position in the org tree syncs the conversation-position combobox in the turn panel", async () => {
    // Regression lock: the wiring is OrgTree.onSelect -> openConversation ->
    // selectPosition + ensureActiveSession -> <PositionMention value={selectedPositionId}>. Pin
    // that path so a future refactor cannot silently break the sync (which
    // would restart the AC-002 empty-state contradiction and cascade into
    // MODE/BUDGET/composer/session controls all going idle).
    openedBridge();

    render(<App />);
    await selectRepoOwner();

    const combobox = screen.getByRole("combobox", { name: "选择对话岗位" });
    expect(combobox).toBeEnabled();

    // Once the tree selects a position, the human-readable subject label
    // inside the panel proves the sync without exposing the routing ID.
    const conversationRegion = screen.getByLabelText("岗位对话");
    expect(within(conversationRegion).getAllByText(/代码库负责人/).length).toBeGreaterThan(0);
  });

  it("opens a workspace, selects @岗位, loads local history, sends, and reads persisted history back", async () => {
    const existing = apiTurn();
    const created = apiTurn({
      turnId: "turn-created",
      input: "检查下一版发布",
      output: "发布门禁通过",
      createdAt: "2026-08-24T05:00:00.000Z",
      updatedAt: "2026-08-24T05:01:00.000Z",
      envelopeDigest: "sha256:created",
    });
    const sessionTurnHistory = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: history([existing]) })
      .mockResolvedValueOnce({ status: 200, body: history([existing, created]) });
    const createSessionTurn = vi.fn().mockResolvedValue({ status: 200, body: created });
    const bridge = openedBridge({ sessionTurnHistory, createSessionTurn });

    render(<App />);
    await selectRepoOwner();
    expect(await screen.findByText("历史结果")).toBeInTheDocument();

    pickSelectOption("选择 Agent Host", "Qoder");
    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "检查下一版发布" } });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));

    await waitFor(() => {
      expect(createSessionTurn).toHaveBeenCalledWith({
        sessionId: activeSession.sessionId,
        input: "检查下一版发布",
        engine: "qoder",
      });
      expect(sessionTurnHistory).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText("发布门禁通过")).toBeInTheDocument();
    expect(bridge.position).toHaveBeenCalledWith("repo-owner");
  });

  it("keeps an unconfigured Host honestly idle even when the engine CLI is reachable", async () => {
    openedBridge({
      status: vi.fn().mockResolvedValue({
        running: true,
        health: {
          status: "ok",
          api: "v0",
          server: { version: "0.0.0", pid: 123 },
          engine: { command: "digital-employee", available: true },
          hosts: {
            qoder: { configured: false, ready: false, nextStep: "Qoder 凭据未配置" },
            "claude-code": { configured: false, ready: false, nextStep: "Claude Code 凭据未配置" },
            "claude-local": { configured: false, ready: false, nextStep: "Claude Code（本地登录）未安装或版本不在支持窗口内" },
          },
          workspace: { open: true, path: "/fixture/workspace" },
        },
      }),
      turnHistory: vi.fn().mockResolvedValue({ status: 200, body: history([]) }),
    });

    render(<App />);
    await selectRepoOwner();
    pickSelectOption("选择 Agent Host", "Qoder");
    expect(screen.getAllByText("Qoder 凭据未配置").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("下达任务")).toBeDisabled();
  });

  it("surfaces create-turn API failure and preserves the unsent input", async () => {
    const createSessionTurn = vi.fn().mockResolvedValue({
      status: 503,
      body: { code: "turn_engine_unavailable", message: "Qoder Host 暂不可用", retryable: false },
    });
    openedBridge({
      turnHistory: vi.fn().mockResolvedValue({ status: 200, body: history([]) }),
      createSessionTurn,
    });

    render(<App />);
    await selectRepoOwner();
    pickSelectOption("选择 Agent Host", "Qoder");
    const input = screen.getByLabelText("下达任务");
    fireEvent.change(input, { target: { value: "不要丢失这条任务" } });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Qoder Host 暂不可用");
    expect(input).toHaveValue("不要丢失这条任务");
    expect(createSessionTurn).toHaveBeenCalledTimes(1);
  });

  it("creates, rotates, and switches explicit sessions without copying old turns", async () => {
    const successor: WorkbenchSession = {
      ...activeSession,
      sessionId: "22222222-2222-4222-8222-222222222222",
      rotatedFrom: activeSession.sessionId,
      createdAt: "2026-08-24T06:00:00.000Z",
    };
    const rotated: WorkbenchSession = {
      ...activeSession,
      status: "rotated",
      rotatedTo: successor.sessionId,
      rotatedAt: successor.createdAt,
    };
    const sessions = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { schemaVersion: "workbench-session-list.v1", positionId: "repo-owner", activeSessionId: null, sessions: [] } })
      .mockResolvedValueOnce({ status: 200, body: { schemaVersion: "workbench-session-list.v1", positionId: "repo-owner", activeSessionId: activeSession.sessionId, sessions: [activeSession] } })
      .mockResolvedValue({ status: 200, body: { schemaVersion: "workbench-session-list.v1", positionId: "repo-owner", activeSessionId: successor.sessionId, sessions: [successor, rotated] } });
    const createSession = vi.fn().mockResolvedValue({ status: 201, body: activeSession });
    const rotateSession = vi.fn().mockResolvedValue({ status: 201, body: successor });
    const sessionTurnHistory = vi.fn().mockImplementation(async (sessionId: string) => ({
      status: 200,
      body: history(sessionId === activeSession.sessionId ? [apiTurn()] : []),
    }));
    openedBridge({ sessions, createSession, rotateSession, sessionTurnHistory });

    render(<App />);
    await selectRepoOwner();
    pickSelectOption("选择 Agent Host", "Qoder");
    await waitFor(() => expect(createSession).toHaveBeenCalledWith({ positionId: "repo-owner" }));
    expect(screen.queryByText("请先新建或选择一个会话")).not.toBeInTheDocument();
    expect(await screen.findByText("历史结果")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "轮换当前会话" }));
    await waitFor(() => expect(rotateSession).toHaveBeenCalledWith(activeSession.sessionId));
    await waitFor(() => {
      expect(sessionTurnHistory).toHaveBeenCalledWith(successor.sessionId);
      expect(screen.getByText("当前还没有回合记录，输入任务即可开始")).toBeInTheDocument();
      expect(screen.queryByText("历史结果")).not.toBeInTheDocument();
    });

    pickSelectOption("选择本地会话", "只读 · 第 1 个");
    expect((await screen.findAllByText("历史会话只读；请选择当前会话")).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("下达任务")).toBeDisabled();
  });

  it("keeps a live group turn across personal session selection and rotation (#114)", async () => {
    const group = {
      schemaVersion: "conversation-group.v1" as const,
      conversationRef: "33333333-3333-4333-8333-333333333333",
      sessionId: "44444444-4444-4444-8444-444444444444",
      members: ["repo-owner"],
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const historicalSession: WorkbenchSession = {
      ...activeSession,
      sessionId: "22222222-2222-4222-8222-222222222222",
      status: "rotated",
      rotatedTo: activeSession.sessionId,
      rotatedAt: activeSession.createdAt,
    };
    const successor: WorkbenchSession = {
      ...activeSession,
      sessionId: "55555555-5555-4555-8555-555555555555",
      rotatedFrom: activeSession.sessionId,
    };
    const rotateSession = vi.fn().mockResolvedValue({ status: 201, body: successor });
    const createGroupTurn = vi.fn().mockResolvedValue({
      status: 202,
      body: {
        conversationRef: group.conversationRef,
        messageId: "message-1",
        spawns: [{ turnId: "group-turn-1", positionId: "repo-owner" }],
      },
    });
    openedBridge({
      groups: vi.fn().mockResolvedValue({
        status: 200,
        body: { schemaVersion: "conversation-group-list.v1", groups: [group] },
      }),
      groupTimeline: vi.fn().mockResolvedValue({
        status: 200,
        body: { schemaVersion: "group-timeline.v1", conversationRef: group.conversationRef, items: [] },
      }),
      createGroupTurn,
      sessions: vi.fn().mockResolvedValue({
        status: 200,
        body: {
          schemaVersion: "workbench-session-list.v1",
          positionId: "repo-owner",
          activeSessionId: activeSession.sessionId,
          sessions: [activeSession, historicalSession],
        },
      }),
      rotateSession,
    });

    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "群聊" }));
    await screen.findByLabelText("群聊消息");
    const recipientSelect = screen.getByRole("combobox", { name: "选择要 @ 的成员" });
    fireEvent.mouseDown(recipientSelect);
    await waitFor(() => {
      const options = visibleSelectOptions();
      expect(options.length).toBeGreaterThan(0);
      fireEvent.click(options[0]!);
    });
    fireEvent.change(screen.getByLabelText("群聊消息"), { target: { value: "保持群状态" } });
    fireEvent.keyDown(screen.getByLabelText("群聊消息"), { key: "Enter" });
    await waitFor(() => expect(createGroupTurn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelectorAll(".owb-bubble-row--employee")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "组织" }));
    await selectRepoOwner();
    pickSelectOption("选择本地会话", "只读 · 第 1 个");
    fireEvent.click(screen.getByRole("button", { name: "群聊" }));
    await waitFor(() => expect(container.querySelectorAll(".owb-bubble-row--employee")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "组织" }));
    fireEvent.click(await screen.findByRole("button", { name: "轮换当前会话" }));
    await waitFor(() => expect(rotateSession).toHaveBeenCalledWith(activeSession.sessionId));
    fireEvent.click(screen.getByRole("button", { name: "群聊" }));
    await waitFor(() => expect(container.querySelectorAll(".owb-bubble-row--employee")).toHaveLength(1));
  });

  it("submits a drag move proposal and rejects a self-drop before IPC", async () => {
    const tree = {
      ...snapshot,
      positionCount: 3,
      depth: 2,
      tree: [{ ...snapshot.tree[0]!, children: [
        { id: "docs-writer", reportTo: "repo-owner", budget: snapshot.tree[0]!.budget, children: [] },
        { id: "release-engineer", reportTo: "repo-owner", budget: snapshot.tree[0]!.budget, children: [] },
      ] }],
    };
    const orgApply = vi.fn().mockResolvedValue({ status: 200, body: { status: "applied" } });
    openedBridge({
      orgTree: vi.fn().mockResolvedValue({ status: 200, body: tree }),
      position: vi.fn().mockImplementation(async (id: string) => ({ status: 200, body: { position: { ...position, id, name: id, reportTo: id === "repo-owner" ? null : "repo-owner" } } })),
      orgApply,
      turnHistory: vi.fn().mockResolvedValue({ status: 200, body: history([]) }),
    });
    render(<App />);
    const source = await screen.findByText("docs-writer", { selector: ".ui-org-tree__name, .ui-org-tree__id" });
    const target = screen.getByText("release-engineer", { selector: ".ui-org-tree__name, .ui-org-tree__id" });
    const data = new Map<string, string>();
    const dataTransfer = { effectAllowed: "move", dropEffect: "move", setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? "" };
    fireEvent.dragStart(source.closest('[role="treeitem"]')!, { dataTransfer });
    fireEvent.drop(target.closest('[role="treeitem"]')!, { dataTransfer });
    await waitFor(() => expect(orgApply).toHaveBeenCalledWith({ schemaVersion: "change-manifest.v1", changes: [{ op: "move", id: "docs-writer", reportTo: "release-engineer" }] }));

    // Self-drop is refused at the component level: dropEffect=none on
    // dragOver, and the source's dragend surfaces the light toast.
    fireEvent.dragStart(source.closest('[role="treeitem"]')!, { dataTransfer });
    fireEvent.dragOver(source.closest('[role="treeitem"]')!, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("none");
    fireEvent.dragEnd(source.closest('[role="treeitem"]')!);
    expect(await screen.findByText("不能移动到自身或自己的下属")).toBeInTheDocument();
    expect(orgApply).toHaveBeenCalledTimes(1);
  });

  it("⌘↑ emits a reorder manifest and the 撤销 button replays /org/undo", async () => {
    const tree = {
      ...snapshot,
      positionCount: 3,
      depth: 2,
      tree: [{ ...snapshot.tree[0]!, children: [
        { id: "docs-writer", reportTo: "repo-owner", budget: snapshot.tree[0]!.budget, children: [] },
        { id: "release-engineer", reportTo: "repo-owner", budget: snapshot.tree[0]!.budget, children: [] },
      ] }],
    };
    const orgApply = vi.fn().mockResolvedValue({ status: 200, body: { status: "applied" } });
    const orgUndo = vi.fn().mockResolvedValue({
      status: 200,
      body: { status: "undone", version: { seq: 5, updatedAt: "2026-08-26T00:00:00.000Z" } },
    });
    openedBridge({
      orgTree: vi.fn().mockResolvedValue({ status: 200, body: tree }),
      position: vi.fn().mockImplementation(async (id: string) => ({ status: 200, body: { position: { ...position, id, name: id, reportTo: id === "repo-owner" ? null : "repo-owner" } } })),
      orgApply,
      orgUndo,
      turnHistory: vi.fn().mockResolvedValue({ status: 200, body: history([]) }),
    });
    render(<App />);
    fireEvent.click(await screen.findByText("release-engineer", { selector: ".ui-org-tree__name, .ui-org-tree__id" }));
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowUp", metaKey: true });
    await waitFor(() => expect(orgApply).toHaveBeenCalledWith({
      schemaVersion: "change-manifest.v1",
      changes: [{ op: "reorder", parentId: "repo-owner", order: ["release-engineer", "docs-writer"] }],
    }));

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(orgUndo).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("已撤销最近一次组织调整")).toBeInTheDocument();
  });

  it("surfaces a friendly note when there is nothing to undo", async () => {
    openedBridge({ turnHistory: vi.fn().mockResolvedValue({ status: 200, body: history([]) }) });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    expect(await screen.findByText("没有可撤销的组织调整")).toBeInTheDocument();
  });

  it("prefills token budgets and hires through POST /hire (hire-request.v1alpha1)", async () => {
    const hire = vi.fn().mockResolvedValue({
      status: 200,
      body: { status: "hired", positionId: "docs-writer", version: { seq: 6, updatedAt: "2026-08-26T00:00:00.000Z" } },
    });
    const orgApply = vi.fn().mockResolvedValue({ status: 200, body: { status: "applied" } });
    openedBridge({ hire, orgApply, turnHistory: vi.fn().mockResolvedValue({ status: 200, body: history([]) }) });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "创建员工" }));
    expect(await screen.findByRole("button", { name: "开始创建" })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("员工姓名（≤24 字）"), { target: { value: "文档负责人" } });
    fireEvent.change(screen.getByPlaceholderText("≤500 字"), { target: { value: "维护文档" } });
    const taskTokens = screen.getByLabelText("每任务 token 上限*");
    const dayTokens = screen.getByLabelText("每日 token 上限*");
    expect(taskTokens).toHaveValue("20000");
    expect(dayTokens).toHaveValue("200000");
    expect(screen.getByRole("button", { name: "开始创建" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "开始创建" }));
    await waitFor(() => expect(hire).toHaveBeenCalledWith({
      positionId: expect.stringMatching(/^position-[a-z0-9]+$/),
      name: "文档负责人",
      description: "维护文档",
      reportTo: "repo-owner",
      mode: "approval_required",
      budget: {
        perTask: { tokens: 20000, iterations: 8 },
        perDay: { tokens: 200000, iterations: 64 },
      },
      memorySources: [{ kind: "position_docs", locator: "./knowledge/**" }],
      permissions: {
        tools: ["Read", "Grep", "Glob"],
        rules: [{ scope: "position", resource: "./knowledge/**", actions: ["read"] }],
        skills: [],
        mcpServers: [],
      },
      prompt: expect.any(String),
    }));
    expect(orgApply).not.toHaveBeenCalled();
    expect(await screen.findByText("文档负责人 已加入团队")).toBeInTheDocument();
  });

  it("requires dismissal confirmation and invokes one-click restore through typed IPC", async () => {
    const childSnapshot = { ...snapshot, positionCount: 2, depth: 2, tree: [{ ...snapshot.tree[0]!, children: [{ id: "docs-writer", reportTo: "repo-owner", budget: snapshot.tree[0]!.budget, children: [] }] }] };
    const orgApply = vi.fn().mockResolvedValue({ status: 200, body: { status: "applied" } });
    const orgRestore = vi.fn().mockResolvedValue({ status: 200, body: { status: "applied", positionId: "old-writer", restored: true } });
    openedBridge({
      orgTree: vi.fn().mockResolvedValue({ status: 200, body: childSnapshot }),
      position: vi.fn().mockImplementation(async (id: string) => ({ status: 200, body: { position: { ...position, id, name: id, reportTo: id === "repo-owner" ? null : "repo-owner" } } })),
      orgApply,
      orgBackups: vi.fn().mockResolvedValue({ status: 200, body: { schemaVersion: "org-backups.v1", backups: [{ backupId: "old-writer-1756000000000-abcdef", positionId: "old-writer", dismissedAt: "2026-08-24T06:00:00Z", reportTo: "repo-owner", name: "旧文档负责人" }] } }),
      orgRestore,
      turnHistory: vi.fn().mockResolvedValue({ status: 200, body: history([]) }),
    });
    render(<App />);
    fireEvent.click(await screen.findByText("docs-writer", { selector: ".ui-org-tree__name, .ui-org-tree__id" }));
    // #137 review：裁撤动作住在岗位档案卡头部，而不是悬浮在卡片外面。
    const cardRegion = screen.getByRole("region", { name: "岗位档案" });
    fireEvent.click(await within(cardRegion).findByRole("button", { name: "裁撤" }));
    fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
    expect(orgApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "裁撤" }));
    fireEvent.click(screen.getByRole("button", { name: "确认裁撤并留痕" }));
    await waitFor(() => expect(orgApply).toHaveBeenCalledWith({ schemaVersion: "change-manifest.v1", changes: [{ op: "delete", id: "docs-writer" }] }));

    fireEvent.click(screen.getByRole("button", { name: "一键恢复" }));
    await waitFor(() => expect(orgRestore).toHaveBeenCalledWith("old-writer-1756000000000-abcdef"));
  });

  it("streams turn.model.delta into the running bubble, stays idempotent on replay, and settles on the authoritative record", async () => {
    let listener: ((event: unknown) => void) | null = null;
    const onEvent = vi.fn((callback: (event: unknown) => void) => {
      listener = callback;
      return () => undefined;
    });
    const completed = apiTurn({
      turnId: "turn-stream",
      runId: "run-stream",
      input: "检查下一版发布",
      output: "发布门禁通过",
      createdAt: "2026-08-24T05:00:00.000Z",
      updatedAt: "2026-08-24T05:01:00.000Z",
      envelopeDigest: "sha256:stream",
    });
    const sessionTurnHistory = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: history([]) })
      .mockResolvedValue({ status: 200, body: history([completed]) });
    let resolveTurn: (value: { status: number; body: unknown }) => void = () => undefined;
    const createSessionTurn = vi.fn().mockImplementation(
      () => new Promise((resolve) => { resolveTurn = resolve; }),
    );
    openedBridge({ onEvent, sessionTurnHistory, createSessionTurn });

    render(<App />);
    await selectRepoOwner();
    pickSelectOption("选择 Agent Host", "Qoder");
    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "检查下一版发布" } });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
    await waitFor(() => expect(createSessionTurn).toHaveBeenCalled());
    expect(listener).not.toBeNull();

    act(() => {
      listener!({ seq: 1, type: "turn.started", payload: { runId: "run-stream", timestamp: "2026-08-24T05:00:00.000Z", type: "run.started" } });
      listener!({ seq: 2, type: "turn.model.delta", payload: { runId: "run-stream", timestamp: "2026-08-24T05:00:00.500Z", type: "model.delta", text: "正在分析" } });
      listener!({ seq: 3, type: "turn.model.delta", payload: { runId: "run-stream", timestamp: "2026-08-24T05:00:01.000Z", type: "model.delta", text: "…核对完成" } });
    });
    expect(await screen.findByText("正在分析…核对完成")).toBeInTheDocument();
    expect(screen.getByText("运行中")).toBeInTheDocument();

    act(() => {
      listener!({ seq: 3, type: "turn.model.delta", payload: { runId: "run-stream", timestamp: "2026-08-24T05:00:01.000Z", type: "model.delta", text: "…核对完成" } });
    });
    expect(screen.getAllByText("正在分析…核对完成")).toHaveLength(1);

    act(() => {
      listener!({ seq: 4, type: "turn.completed", payload: { runId: "run-stream", timestamp: "2026-08-24T05:01:00.000Z", type: "run.completed", output: "发布门禁通过", terminalReason: "goal_met" } });
    });
    await act(async () => {
      resolveTurn({ status: 200, body: completed });
    });
    expect(await screen.findByText("发布门禁通过")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("正在分析…核对完成")).not.toBeInTheDocument());
    expect(screen.getByText("已完成")).toBeInTheDocument();
  });

  it("renders D4 tabs from sanitized report facts and never displays raw turn content", async () => {
    const reports: ReportsResponse = {
      schemaVersion: "reports.v1",
      streams: {
        escalations: [{ schemaVersion: "turn-escalation.v1", positionId: "repo-owner", turnId: "turn-1", at: "2026-08-24T06:00:00Z", status: "failed", code: "position_budget_exceeded", reportingChain: ["repo-owner"], budgetRelated: true }],
        audits: [],
        evidence: [{ schemaVersion: "turn-evidence.v1", positionId: "repo-owner", turnId: "turn-1", conversationId: "conversation-1", engine: "qoder", status: "failed", createdAt: "2026-08-24T05:59:00Z", updatedAt: "2026-08-24T06:00:00Z", envelopeDigest: "sha256:evidence", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, errorCode: "position_budget_exceeded" }],
      },
      budgets: [{
        positionId: "repo-owner",
        declared: { perTask: { tokens: 100 }, perDay: { tokens: 1000 } },
        recorded: { inputTokens: 20, outputTokens: 30, totalTokens: 50 },
        latestTurn: { inputTokens: 20, outputTokens: 30, totalTokens: 50 },
        state: "within",
      }],
      page: { cursor: null, hasMore: false },
    };
    openedBridge({ reports: vi.fn().mockResolvedValue({ status: 200, body: reports }), turnHistory: vi.fn().mockResolvedValue({ status: 200, body: history([]) }) });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "上报" }));
    expect(await screen.findByRole("heading", { name: "上报中心" })).toBeInTheDocument();
    expect(screen.queryByText("position_budget_exceeded")).not.toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "单任务消耗" })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByRole("meter", { name: "单日用量不可用" })).not.toHaveAttribute("aria-valuenow");
    expect(screen.getAllByText("50%")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /执行记录/ }));
    expect(screen.queryByText("sha256:evidence")).not.toBeInTheDocument();
    expect(screen.queryByText("sensitive raw input")).not.toBeInTheDocument();
    expect(screen.queryByText("sensitive raw output")).not.toBeInTheDocument();
    // #112: a durable session record is opaque to the renderer; once the
    // sanitized evidence reaches reports.v1 it must also populate the derived timeline.
    fireEvent.click(screen.getByRole("button", { name: /时间线/ }));
    expect(screen.getByLabelText("执行时间线")).toBeInTheDocument();
    expect(screen.getByText("共 3 条")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-budget-tag-turn-1")).toBeInTheDocument();
    expect(screen.queryByText("turn-1")).not.toBeInTheDocument();
  });
});

describe("App employee-memory module wiring", () => {
  it("uses the current Workbench mem bridge from the unified memory surface", async () => {
    const list = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        schemaVersion: "drive-object-list.v1",
        mocked: true,
        objects: [{
          id: "mem-001",
          name: "会议纪要.md",
          size: 120,
          mime: "text/markdown",
          createdAt: "2026-08-30T09:14:22.000Z",
        }],
      },
    });
    const bridge = openedBridge({
      drive: {
        list,
        detail: vi.fn(),
        upload: vi.fn(),
        pickAndUpload: vi.fn(),
      },
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "记忆" }));
    expect(await screen.findByRole("heading", { name: "员工记忆" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开 统一网盘 记忆来源" }));
    expect(await screen.findByText("会议纪要.md")).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith("");
    expect(screen.queryByText(/Obsidian/)).not.toBeInTheDocument();
    expect(bridge.position).toHaveBeenCalled();
  });
});

describe("App settings module wiring (#134)", () => {
  it("activates the settings rail entry and renders the update pane behind it", async () => {
    // AC-001: #128 removed a rail entry that had no onSelect and no branch, so
    // it did nothing when clicked. This pins that the entry actually resolves
    // to a rendered surface.
    const bridge = installBridge();

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));

    expect(await screen.findByRole("heading", { name: "设置", level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "应用更新", level: 2 })).toBeInTheDocument();
    expect(bridge.update.status).toHaveBeenCalled();
    // The prefs drawer (#174) keeps its own two toggles; the update pane did not
    // move into it and does not duplicate them here.
    expect(screen.queryByRole("button", { name: /语言/ })).toBeNull();
  });
});

describe("App docs module wiring (#35 S3)", () => {
  it("activates the docs rail entry and browses a position's documents end-to-end", async () => {
    const positionDocs = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        schemaVersion: "docs-file-list.v1",
        positionId: "repo-owner",
        files: [{ path: "handbook.md", kind: "file", size: 32, modifiedAt: "2026-08-27T00:00:00.000Z" }],
      },
    });
    const positionDocFile = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        schemaVersion: "docs-file.v1",
        positionId: "repo-owner",
        path: "handbook.md",
        content: "# Handbook\n\n正文内容",
        version: "2026-08-27T00:00:00.000Z",
        size: 32,
        modifiedAt: "2026-08-27T00:00:00.000Z",
      },
    });
    openedBridge({ positionDocs, positionDocFile } as Partial<OwbBridge>);

    render(<App />);
    await selectRepoOwner();

    const docsEntry = screen.getByRole("button", { name: "记忆" });
    expect(docsEntry).not.toHaveAttribute("aria-current");
    fireEvent.click(docsEntry);
    expect(docsEntry).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("region", { name: "员工记忆" })).toBeInTheDocument();
    await waitFor(() => expect(positionDocs).toHaveBeenCalledWith("repo-owner"));

    fireEvent.click(await screen.findByRole("button", { name: "handbook.md" }));
    expect(await screen.findByRole("heading", { name: "Handbook" })).toBeInTheDocument();
    expect(screen.getByText("正文内容")).toBeInTheDocument();
    expect(screen.getByText("版本 2026-08-27T00:00:00.000Z")).toBeInTheDocument();
    expect(positionDocFile).toHaveBeenCalledWith("repo-owner", "handbook.md");
  });
});
