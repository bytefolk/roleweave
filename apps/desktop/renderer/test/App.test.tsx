import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { message } from "antd";
import { pickSelectOption, visibleSelectOptions } from "./select-helper";
import { App } from "../src/App";
import { HireDrawer } from "../src/org/HireDrawer";
import type { OwbBridge } from "../src/owb";
import type { ApprovalView, GoalDetail, ReportsResponse, TurnHistory, TurnRecord, WorkbenchSession, WorkspaceInfoResponse } from "@roleweave/shared";

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
    relationshipGraph: vi.fn().mockResolvedValue({ status: 200, body: {
      schemaVersion: "relationship-graph.v1", workspaceId: "example", revision: "1", generatedAt: "2026-09-22T00:00:00Z",
      nodes: [{ id: "agent:repo-owner", kind: "agent", label: "Repo Owner", state: "ready", positionId: "repo-owner", evidence: { source: "org", locator: "repo-owner", basis: "observed", observedAt: "2026-09-22T00:00:00Z" } }],
      edges: [], coverage: [], truncated: false, limits: { nodes: 400, edges: 800 },
    } }),
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
    sessionSetContext: vi.fn().mockResolvedValue({ status: 200, body: activeSession }),
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
          codex: { configured: true, ready: true },
          "codex-local": { configured: true, ready: true },
          workbuddy: { configured: true, ready: true, modelPinnable: true, model: "fixture-model" },
        },
        workspace: { open: true, path: "/fixture/workspace" },
      },
    }),
    workspace: vi.fn().mockResolvedValue({
      status: 200,
      body: { open: true, path: "/fixture/workspace", business: "开源业务" },
    }),
    orgTree: vi.fn().mockResolvedValue({ status: 200, body: snapshot }),
    // A persisted employee has one concrete bound runtime.  The renderer
    // consumes this top-level field rather than asking the operator to pick a
    // host again in every conversation.
    position: vi.fn().mockResolvedValue({ status: 200, body: { position, agentEngine: "qoder" } }),
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
  expect(await screen.findByRole("region", { name: "岗位对话" })).toBeInTheDocument();
}

async function chooseExistingWorkspace(): Promise<void> {
  const trigger = screen.getByRole("button", { name: "项目入口" });
  expect(trigger).toBeEnabled();
  await act(async () => {
    fireEvent.click(trigger);
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "项目入口" })).toHaveAttribute("aria-expanded", "true"));
  await waitFor(() => expect(document.querySelector(".owb-project-dialog")).not.toBeNull());
  const dialog = document.querySelector<HTMLElement>(".owb-project-dialog");
  expect(dialog).not.toBeNull();
  const openButton = Array.from(dialog!.querySelectorAll("button"))
    .find((button) => button.textContent?.includes("打开项目"));
  expect(openButton).toBeDefined();
  await act(async () => {
    fireEvent.click(openButton!);
  });
}

async function openOrganizationStructure(): Promise<HTMLElement> {
  fireEvent.click(within(screen.getByRole("navigation", { name: "模块" })).getByRole("button", { name: "组织" }));
  fireEvent.click(within(screen.getByRole("navigation", { name: "组织视图" })).getByRole("button", { name: "组织架构" }));
  const structure = await screen.findByRole("region", { name: "组织架构" });
  expect(structure.closest(".owb-main")).not.toBeNull();
  expect(structure.closest(".ui-app-shell__sidebar")).toBeNull();
  return structure;
}

async function openInbox(view: "审批" | "上报" = "审批"): Promise<void> {
  await act(async () => {
    fireEvent.click(within(screen.getByRole("navigation", { name: "模块" })).getByRole("button", { name: "收件箱" }));
  });
  const views = within(screen.getByRole("navigation", { name: "收件箱视图" }));
  expect(views.getByRole("button", { name: "审批" })).toHaveAttribute("aria-pressed", "true");
  if (view === "上报") {
    await act(async () => { fireEvent.click(views.getByRole("button", { name: "上报" })); });
  }
}

function selectEmployeeView(name: "对话" | "记忆" | "档案"): void {
  fireEvent.click(within(screen.getByRole("navigation", { name: "员工视图" })).getByRole("button", { name }));
}

function contactAction(name: "创建员工" | "撤销"): void {
  fireEvent.click(screen.getByRole("button", { name: "通讯录操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

describe("App context navigation", () => {
  // Renders the full App and walks every module tab, so on slower runners it
  // sits above the 5s default and fails fresh runs of main (#529). 15s
  // matches the other full-App tests in this file.
  it("consolidates the collaboration toolbar and places employee actions beside the tabs", async () => {
    const bridge = openedBridge();
    render(<App />);
    await screen.findByRole("tree");
    const sidebar = within(document.querySelector<HTMLElement>(".ui-sidebar")!);
    expect(document.querySelector(".owb-context-header__name")).toHaveTextContent("选择员工");
    expect(sidebar.queryByRole("button", { name: "创建员工" })).toBeNull();
    expect(sidebar.queryByRole("button", { name: "撤销" })).toBeNull();
    fireEvent.click(sidebar.getByRole("button", { name: "通讯录操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "撤销" }));
    await waitFor(() => expect(bridge.orgUndo).toHaveBeenCalledTimes(1));
    await selectRepoOwner();
    const header = document.querySelector<HTMLElement>(".owb-context-header--employee")!;
    expect(header).not.toBeNull();
    expect(within(header).getByRole("button", { name: "会话历史" })).toBeVisible();
    expect(within(header).getByRole("button", { name: "专注对话" })).toBeVisible();
    const conversation = screen.getByRole("region", { name: "岗位对话" });
    expect(conversation.querySelector(".owb-turn-panel__header")).toBeNull();
    expect(conversation).toHaveClass("owb-turn-panel--embedded");
    const input = screen.getByRole("textbox", { name: "下达任务" });
    fireEvent.change(input, { target: { value: "精简布局仍保留草稿" } });
    selectEmployeeView("记忆");
    expect(screen.queryByRole("button", { name: "会话历史" })).toBeNull();
    selectEmployeeView("对话");
    expect(screen.getByRole("textbox", { name: "下达任务" })).toBe(input);
    expect(input).toHaveValue("精简布局仍保留草稿");
    expect(within(header).getByRole("button", { name: "会话历史" })).toBeVisible();
    for (const name of ["组织", "项目", "收件箱", "设置"]) {
      fireEvent.click(within(screen.getByRole("navigation", { name: "模块" })).getByRole("button", { name }));
      expect(screen.queryByRole("button", { name: "会话历史" })).toBeNull();
      fireEvent.click(within(screen.getByRole("navigation", { name: "模块" })).getByRole("button", { name: "协作" }));
      const restored = document.querySelector<HTMLElement>(".owb-context-header--employee")!;
      expect(within(restored).getByRole("button", { name: "会话历史" })).toBeVisible();
      expect(screen.getAllByRole("button", { name: "会话历史" })).toHaveLength(1);
      expect(screen.getByRole("textbox", { name: "下达任务" })).toBe(input);
      expect(input).toHaveValue("精简布局仍保留草稿");
    }
  }, 15_000);

  it("opens employee creation from the compact contacts menu without submitting it", async () => {
    const bridge = openedBridge();
    render(<App />);
    await screen.findByRole("tree");
    fireEvent.click(screen.getByRole("button", { name: "通讯录操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "创建员工" }));
    expect(await screen.findByRole("button", { name: "开始创建" })).toBeDisabled();
    expect(bridge.hire).not.toHaveBeenCalled();
  });

  it("groups primary navigation by working context instead of individual features", async () => {
    openedBridge();
    render(<App />);
    await screen.findByRole("tree");
    const rail = within(screen.getByRole("navigation", { name: "模块" }));
    expect(rail.getAllByRole("button").filter(button => !button.hasAttribute("aria-expanded")).map(button => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["协作", "组织", "项目", "收件箱", "设置"]);
    expect(rail.getByRole("button", { name: "协作" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps Agent selection and the conversation draft across memory and profile", async () => {
    openedBridge();
    render(<App />);
    await selectRepoOwner();
    const composer = screen.getByRole("textbox", { name: "下达任务" });
    fireEvent.change(composer, { target: { value: "保留这段协作草稿" } });
    const views = within(screen.getByRole("navigation", { name: "员工视图" }));
    const tree = screen.getByRole("tree");
    fireEvent.click(views.getByRole("button", { name: "记忆" }));
    expect(await screen.findByRole("region", { name: "员工记忆" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "选择员工查看记忆" })).not.toBeInTheDocument();
    expect(screen.getByRole("tree")).toBe(tree);
    fireEvent.click(views.getByRole("button", { name: "档案" }));
    expect(await screen.findByRole("region", { name: "岗位档案" })).toHaveTextContent("代码库负责人");
    fireEvent.click(views.getByRole("button", { name: "对话" }));
    expect(screen.getByRole("textbox", { name: "下达任务" })).toBe(composer);
    expect(composer).toHaveValue("保留这段协作草稿");
  });

  it.each(["记忆", "档案"] as const)("keeps the %s subview and correct identity when switching between two contacts", async subview => {
    const employees = [position, { ...position, id: "docs-writer", name: "文档负责人", description: "负责文档维护", reportTo: "repo-owner" }];
    const sessions = employees.map((employee, index) => ({
      ...activeSession, positionId: employee.id, principal: `position.${employee.id}`,
      sessionId: `${index + 1}1111111-1111-4111-8111-111111111111`,
    }));
    const positionDocs = vi.fn(async (id: string) => ({ status: 200, body: {
      schemaVersion: "docs-file-list.v1", positionId: id,
      files: [{ path: `${id}.md`, kind: "file", size: 32, modifiedAt: "2026-08-27T00:00:00.000Z" }],
    } }));
    const bridge = openedBridge({
      orgTree: vi.fn().mockResolvedValue({ status: 200, body: { ...snapshot, positionCount: 2, depth: 2,
        tree: [{ ...snapshot.tree[0]!, children: [{ ...snapshot.tree[0]!, id: "docs-writer", reportTo: "repo-owner" }] }],
      } }),
      position: vi.fn(async id => ({ status: 200, body: { position: employees.find(employee => employee.id === id)!, agentEngine: "qoder" } })),
      sessions: vi.fn(async id => ({ status: 200, body: { schemaVersion: "workbench-session-list.v1", positionId: id,
        activeSessionId: sessions.find(session => session.positionId === id)!.sessionId,
        sessions: sessions.filter(session => session.positionId === id),
      } })),
      sessionTurnHistory: vi.fn(async sessionId => ({ status: 200, body: {
        ...history([apiTurn({ conversationId: sessionId, positionId: sessions.find(session => session.sessionId === sessionId)!.positionId,
          output: `${sessions.find(session => session.sessionId === sessionId)!.positionId} 的结果` })]),
        conversationId: sessionId, positionId: sessions.find(session => session.sessionId === sessionId)!.positionId,
      } })),
      positionDocs,
    });
    render(<App />);
    await selectRepoOwner();
    expect(await screen.findByText("repo-owner 的结果")).toBeVisible();
    selectEmployeeView(subview);
    const views = within(screen.getByRole("navigation", { name: "员工视图" }));
    for (const employee of [employees[0]!, employees[1]!, employees[0]!]) {
      await act(async () => {
        fireEvent.click(screen.getByRole("tree").querySelector(`[data-org-node-id="${employee.id}"]`)!);
      });
      expect(views.getByRole("button", { name: subview })).toHaveAttribute("aria-pressed", "true");
      expect(views.getByRole("button", { name: "对话" })).toHaveAttribute("aria-pressed", "false");
      expect(screen.queryByRole("region", { name: "岗位对话" })).not.toBeInTheDocument();
      expect(document.querySelector(".owb-context-header__name")).toHaveTextContent(employee.name);
      const other = employees.find(candidate => candidate.id !== employee.id)!;
      if (subview === "记忆") {
        const memory = within(screen.getByRole("region", { name: "员工记忆" }));
        expect(await memory.findByRole("button", { name: `${employee.id}.md` })).toBeVisible();
        expect(memory.queryByRole("button", { name: `${other.id}.md` })).not.toBeInTheDocument();
        expect(positionDocs).toHaveBeenLastCalledWith(employee.id);
        expect(memory.queryByRole("combobox", { name: "选择员工查看记忆" })).not.toBeInTheDocument();
      } else {
        const profile = within(screen.getByRole("region", { name: "岗位档案" }));
        expect(await profile.findByRole("heading", { name: employee.name })).toBeVisible();
        expect(profile.getByText(employee.description)).toBeVisible();
        expect(profile.queryByRole("heading", { name: other.name })).not.toBeInTheDocument();
      }
      selectEmployeeView("对话");
      const conversation = within(await screen.findByRole("region", { name: "岗位对话" }));
      expect(await conversation.findByText(`${employee.id} 的结果`)).toBeVisible();
      expect(conversation.queryByText(`${other.id} 的结果`)).not.toBeInTheDocument();
      expect(bridge.sessionTurnHistory).toHaveBeenLastCalledWith(sessions.find(session => session.positionId === employee.id)!.sessionId);
      selectEmployeeView(subview);
    }
  }, 10_000);

  it("removes the contact sidebar on every global context while retaining the workspace switcher", async () => {
    openedBridge();
    render(<App />);
    await screen.findByRole("tree");
    for (const name of ["组织", "项目", "收件箱", "设置"]) {
      fireEvent.click(within(screen.getByRole("navigation", { name: "模块" })).getByRole("button", { name }));
      expect(document.querySelector(".ui-app-shell__sidebar .ui-sidebar")).toBeNull();
      const switcher = screen.getByRole("button", { name: "项目入口" });
      expect(switcher.closest(".ui-app-shell__sidebar")).toBeNull();
      expect(switcher).toBeEnabled();
    }
    fireEvent.click(within(screen.getByRole("navigation", { name: "模块" })).getByRole("button", { name: "协作" }));
    expect(await screen.findByRole("tree")).toBeInTheDocument();
  });

  it("keeps project children global and opens approvals and reports inside the inbox", async () => {
    openedBridge();
    render(<App />);
    await screen.findByRole("tree");
    const rail = within(screen.getByRole("navigation", { name: "模块" }));
    fireEvent.click(rail.getByRole("button", { name: "项目" }));
    const projectViews = within(screen.getByRole("navigation", { name: "项目视图" }));
    for (const name of ["目标", "进度", "项目管理"]) {
      fireEvent.click(projectViews.getByRole("button", { name }));
      expect(rail.getByRole("button", { name: "项目" })).toHaveAttribute("aria-current", "page");
      expect(document.querySelector(".ui-app-shell__sidebar .ui-sidebar")).toBeNull();
    }
    fireEvent.click(rail.getByRole("button", { name: "收件箱" }));
    const inboxViews = within(screen.getByRole("navigation", { name: "收件箱视图" }));
    fireEvent.click(inboxViews.getByRole("button", { name: "上报" }));
    expect(await screen.findByRole("region", { name: "上报中心" })).toBeInTheDocument();
    fireEvent.click(inboxViews.getByRole("button", { name: "审批" }));
    expect(rail.getByRole("button", { name: "收件箱" })).toHaveAttribute("aria-current", "page");
  });
});

describe("App organization feedback", () => {
  function installOpenableBridge(overrides: Partial<OwbBridge> = {}) {
    return openedBridge({
      openWorkspace: vi.fn().mockResolvedValue({
        status: 200,
        body: { open: true, path: "/fixture/workspace", business: "开源业务" },
      }),
      ...overrides,
    });
  }

  // Avoid waitFor's real-timer microtask drain while the notification clock is fake.
  async function openWorkspace() {
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "项目入口" })); });
    const dialog = screen.getByRole("dialog", { name: "选择工作区" });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: /打开项目/ })); });
  }

  it("shows explicit open feedback outside the main content and dismisses it after three seconds", async () => {
    installOpenableBridge();
    const view = render(<App />);
    await screen.findByRole("tree");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      await openWorkspace();
      const feedback = screen.getByText("项目「开源业务」已打开");
      expect.soft(feedback.closest(".owb-main")).toBeNull();
      expect.soft(feedback.closest(".ant-message")).not.toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
      expect(screen.getByText("项目「开源业务」已打开")).toBeInTheDocument();
      // Ant Design checks elapsed time on animation frames; include the next paint.
      await act(async () => { await vi.advanceTimersByTimeAsync(17); });
      expect(screen.queryByText("项目「开源业务」已打开")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /\/fixture\/workspace$/ })).toBeInTheDocument();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("does not announce a workspace automatically restored at startup", async () => {
    openedBridge();
    const view = render(<App />);
    await screen.findByRole("tree");
    expect(screen.getByRole("button", { name: /\/fixture\/workspace$/ })).toBeInTheDocument();
    expect(screen.queryByText("项目「开源业务」已打开")).not.toBeInTheDocument();
    expect(document.querySelector(".ant-message-notice")).toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(screen.queryByText("项目「开源业务」已打开")).not.toBeInTheDocument();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("keeps a replacement warning inline beyond the previous notification timeout", async () => {
    installOpenableBridge({
      orgUndo: vi.fn().mockResolvedValue({ status: 409, body: { message: "组织已变更，请重试" } }),
    });
    const view = render(<App />);
    await screen.findByRole("tree");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      await openWorkspace();
      expect(screen.getByText("项目「开源业务」已打开")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      await act(async () => { contactAction("撤销"); });
      const main = document.querySelector<HTMLElement>(".owb-main")!;
      expect(within(main).getByRole("alert")).toHaveTextContent("组织已变更，请重试");
      expect(screen.queryByText("项目「开源业务」已打开")).not.toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(within(main).getByRole("alert")).toHaveTextContent("组织已变更，请重试");
      expect(document.querySelector(".ant-message-notice")).toBeNull();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("replaces info without stacking and gives the new notification its own timeout", async () => {
    installOpenableBridge();
    const view = render(<App />);
    await screen.findByRole("tree");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      await openWorkspace();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      await act(async () => { contactAction("撤销"); });
      expect(screen.queryByText("项目「开源业务」已打开")).not.toBeInTheDocument();
      expect.soft(document.querySelectorAll(".ant-message-notice")).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1016); });
      expect(screen.getByText("没有可撤销的组织调整")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(screen.queryByText("没有可撤销的组织调整")).not.toBeInTheDocument();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("does not let a late info onClose erase a newer warning", async () => {
    // Keep real Ant Design rendering; capture only the callback to replay a delayed close.
    const useMessage = vi.spyOn(message, "useMessage");
    installOpenableBridge({
      orgUndo: vi.fn().mockResolvedValue({ status: 409, body: { message: "组织已变更，请重试" } }),
    });
    const view = render(<App />);
    let restoreOpen: (() => void) | undefined;
    try {
      await screen.findByRole("tree");
      const result = useMessage.mock.results.find((entry) => entry.type === "return")?.value;
      expect(result).toBeDefined();
      const open = vi.spyOn(result![0], "open");
      restoreOpen = () => open.mockRestore();
      await openWorkspace();
      const onClose = open.mock.calls[0]?.[0].onClose;
      expect(onClose).toBeTypeOf("function");
      await act(async () => { contactAction("撤销"); });
      expect(screen.getByRole("alert")).toHaveTextContent("组织已变更，请重试");
      act(() => onClose!());
      expect(screen.getByRole("alert")).toHaveTextContent("组织已变更，请重试");
    } finally {
      view.unmount();
      restoreOpen?.();
      useMessage.mockRestore();
    }
  });

  it("removes an active notification when the app unmounts", async () => {
    installOpenableBridge();
    const view = render(<App />);
    await screen.findByRole("tree");
    await openWorkspace();
    expect(screen.getByText("项目「开源业务」已打开")).toBeInTheDocument();
    view.unmount();
    expect(screen.queryByText("项目「开源业务」已打开")).not.toBeInTheDocument();
  });

  it("clears the previous locale's notification when the language changes", async () => {
    const previousLocale = window.localStorage.getItem("owb-locale");
    installOpenableBridge();
    const view = render(<App />);
    await screen.findByRole("tree");
    try {
      await openWorkspace();
      expect(screen.getByText("项目「开源业务」已打开")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "偏好设置" }));
      await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /语言/ })); });
      expect(screen.queryByText("项目「开源业务」已打开")).not.toBeInTheDocument();
      expect(document.querySelector(".ant-message-notice")).toBeNull();
    } finally {
      view.unmount();
      if (previousLocale === null) window.localStorage.removeItem("owb-locale");
      else window.localStorage.setItem("owb-locale", previousLocale);
    }
  });
});

describe("rail collapse control", () => {
  it("starts above the bottom edge and supports vertical drag without toggling", async () => {
    window.localStorage.removeItem("owb.railExpanded");
    window.localStorage.removeItem("owb.railChipBottom");
    openedBridge();
    render(<App />);

    const toggle = await screen.findByRole("button", { name: "展开导航" });
    expect(toggle).toHaveAttribute("data-rail-chip-bottom", "72");
    fireEvent(toggle, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 500 }));
    expect(toggle).not.toHaveClass("is-dragging");
    fireEvent(toggle, new MouseEvent("pointermove", { bubbles: true, clientY: 497 }));
    expect(toggle).not.toHaveClass("is-dragging");
    fireEvent(toggle, new MouseEvent("pointermove", { bubbles: true, clientY: 420 }));
    expect(toggle).toHaveClass("is-dragging");
    fireEvent(toggle, new MouseEvent("pointerup", { bubbles: true, clientY: 420 }));
    expect(toggle).not.toHaveClass("is-dragging");
    expect(toggle).toHaveAttribute("data-rail-chip-bottom", "152");
    expect(window.localStorage.getItem("owb.railChipBottom")).toBe("152");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(toggle, { key: "ArrowDown" });
    expect(toggle).toHaveAttribute("data-rail-chip-bottom", "136");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    window.localStorage.removeItem("owb.railExpanded");
    window.localStorage.removeItem("owb.railChipBottom");
  });
});

describe("App removed-employee recovery", () => {
  const oldEmployee = {
    backupId: "old-writer-1756000000000-abcdef",
    positionId: "old-writer",
    dismissedAt: "2026-08-24T06:00:00Z",
    reportTo: "repo-owner",
    name: "旧文档负责人",
  };
  const backupResponse = (backups = [oldEmployee]) => ({
    status: 200,
    body: { schemaVersion: "org-backups.v1", backups },
  });
  type BackupResponse = Awaited<ReturnType<OwbBridge["orgBackups"]>>;

  it("removes the recovery region from organization structure only after confirming the list is empty", async () => {
    let finish!: (value: BackupResponse) => void;
    const orgBackups = vi.fn(() => new Promise<BackupResponse>(resolve => { finish = resolve; }));
    openedBridge({ orgBackups });
    await act(async () => { render(<App />); });
    const structure = await openOrganizationStructure();
    expect(orgBackups).toHaveBeenCalledOnce();
    expect(within(structure).getByText("正在加载已移除员工…")).toBeVisible();

    await act(async () => finish(backupResponse([])));
    expect(within(structure).queryByRole("region", { name: "已移除员工" })).not.toBeInTheDocument();
    expect(within(structure).queryByText("暂无可恢复岗位")).not.toBeInTheDocument();
    expect(structure).toBeVisible();
    expect(document.querySelector(".ui-sidebar__footer")).toBeNull();
  });

  it("starts collapsed, restores the exact backup once while busy, then hides the last recovered entry", async () => {
    let finishRestore!: (value: Awaited<ReturnType<OwbBridge["orgRestore"]>>) => void;
    const orgRestore = vi.fn(() => new Promise<Awaited<ReturnType<OwbBridge["orgRestore"]>>>(resolve => { finishRestore = resolve; }));
    const orgBackups = vi.fn().mockResolvedValueOnce(backupResponse()).mockResolvedValue(backupResponse([]));
    openedBridge({ orgBackups, orgRestore });
    await act(async () => { render(<App />); });
    expect(screen.queryByRole("region", { name: "已移除员工" })).not.toBeInTheDocument();
    const structure = await openOrganizationStructure();
    const toggle = within(structure).getByRole("button", { name: "已移除员工 · 1" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(structure).queryByRole("button", { name: "恢复" })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const tray = within(structure).getByRole("region", { name: "已移除员工" });
    expect(within(tray).getByText("旧文档负责人")).toBeVisible();
    expect(within(tray).getByText("原汇报 代码库负责人")).toBeVisible();
    const restore = within(tray).getByRole("button", { name: "恢复" });
    await act(async () => { fireEvent.click(restore); });
    expect(restore).toBeDisabled();
    fireEvent.click(restore);
    expect(orgRestore).toHaveBeenCalledExactlyOnceWith(oldEmployee.backupId);

    await act(async () => finishRestore({ status: 200, body: { status: "applied", positionId: oldEmployee.positionId, restored: true } }));
    expect(orgBackups).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("region", { name: "已移除员工" })).not.toBeInTheDocument();
    expect(document.querySelector(".ui-sidebar__footer")).toBeNull();
  });

  it.each(["http", "offline"])("keeps a %s read failure visible until Retry succeeds", async failure => {
    let finishRetry!: (value: BackupResponse) => void;
    const orgBackups = vi.fn();
    if (failure === "http") orgBackups.mockResolvedValueOnce({ status: 503, body: { code: "unavailable" } });
    else orgBackups.mockRejectedValueOnce(new Error("unavailable"));
    orgBackups.mockImplementationOnce(() => new Promise<BackupResponse>(resolve => { finishRetry = resolve; }));
    openedBridge({ orgBackups });
    await act(async () => { render(<App />); });
    const structure = await openOrganizationStructure();
    const tray = within(structure).getByRole("region", { name: "已移除员工" });
    expect(within(tray).getByRole("alert")).toHaveTextContent("无法加载已移除员工");
    expect(within(structure).queryByText("暂无可恢复岗位")).not.toBeInTheDocument();
    expect(tray).toBeVisible();
    expect(document.querySelector(".ui-sidebar__footer")).toBeNull();

    await act(async () => { fireEvent.click(within(tray).getByRole("button", { name: "重试" })); });
    expect(orgBackups).toHaveBeenCalledTimes(2);
    expect(within(structure).getByText("正在加载已移除员工…")).toBeVisible();
    await act(async () => finishRetry(backupResponse()));
    expect(within(structure).queryByText("无法加载已移除员工")).not.toBeInTheDocument();
    expect(within(structure).getByRole("button", { name: "已移除员工 · 1" })).toHaveAttribute("aria-expanded", "false");
  });

  it.each([
    ["B", "success"], ["B", "failure"], ["A", "success"], ["A", "failure"],
  ])("ignores old A recovery %s/%s after workspace navigation", async (destination, outcome) => {
    let workspace = "A";
    let finishOld!: (value: BackupResponse) => void;
    let rejectOld!: (reason: Error) => void;
    const orgBackups = vi.fn()
      .mockImplementationOnce(() => new Promise<BackupResponse>((resolve, reject) => { finishOld = resolve; rejectOld = reject; }))
      .mockImplementation(async () => backupResponse([{ ...oldEmployee, backupId: `current-${workspace}`, name: `Current ${workspace}` }]));
    openedBridge({
      orgBackups,
      workspace: vi.fn(async () => ({ status: 200, body: { open: true, path: `/workspace/${workspace}`, business: `Workspace ${workspace}` } })),
    });
    await act(async () => { render(<App />); });
    expect(orgBackups).toHaveBeenCalledOnce();
    workspace = "B";
    await chooseExistingWorkspace();
    if (destination === "A") {
      workspace = "A";
      await chooseExistingWorkspace();
    }
    expect(screen.getByRole("button", { name: "项目入口" })).toHaveTextContent(`Workspace ${destination}`);
    const structure = await openOrganizationStructure();
    fireEvent.click(within(structure).getByRole("button", { name: "已移除员工 · 1" }));
    expect(within(structure).getByText(`Current ${destination}`)).toBeVisible();

    await act(async () => {
      if (outcome === "success") finishOld(backupResponse());
      else rejectOld(new Error("stale workspace failure"));
    });
    expect(within(structure).getByText(`Current ${destination}`)).toBeVisible();
    expect(within(structure).queryByText(oldEmployee.name)).not.toBeInTheDocument();
    expect(within(structure).queryByText("无法加载已移除员工")).not.toBeInTheDocument();
  });

  it("keeps the latest same-workspace recovery read when an older read finishes last", async () => {
    let finishOld!: (value: BackupResponse) => void;
    const orgBackups = vi.fn()
      .mockImplementationOnce(() => new Promise<BackupResponse>(resolve => { finishOld = resolve; }))
      .mockResolvedValue(backupResponse([]));
    openedBridge({ orgBackups });
    await act(async () => { render(<App />); });
    const structure = await openOrganizationStructure();
    expect(within(structure).getByText("正在加载已移除员工…")).toBeVisible();
    await chooseExistingWorkspace();
    expect(orgBackups).toHaveBeenCalledTimes(2);
    expect(within(structure).queryByRole("region", { name: "已移除员工" })).not.toBeInTheDocument();
    expect(document.querySelector(".ui-sidebar__footer")).toBeNull();

    await act(async () => finishOld(backupResponse()));
    expect(structure).toBeVisible();
    expect(within(structure).queryByRole("region", { name: "已移除员工" })).not.toBeInTheDocument();
    expect(document.querySelector(".ui-sidebar__footer")).toBeNull();
  });

  it.each(["http", "offline"])("loads removed employees even when the organization tree fails: %s", async failure => {
    const orgTree = failure === "http"
      ? vi.fn().mockResolvedValue({ status: 503, body: { code: "unavailable" } })
      : vi.fn().mockRejectedValue(new Error("unavailable"));
    const bridge = openedBridge({
      orgTree,
      orgBackups: vi.fn().mockResolvedValue(backupResponse()),
    });
    await act(async () => { render(<App />); });
    const structure = await openOrganizationStructure();
    expect(bridge.orgTree).toHaveBeenCalledOnce();
    expect(bridge.orgBackups).toHaveBeenCalledOnce();
    expect(within(structure).queryByText("正在加载已移除员工…")).not.toBeInTheDocument();
    fireEvent.click(within(structure).getByRole("button", { name: "已移除员工 · 1" }));
    const tray = within(structure).getByRole("region", { name: "已移除员工" });
    expect(within(tray).getByText(oldEmployee.name)).toBeVisible();
    expect(within(tray).getByRole("button", { name: "恢复" })).toBeEnabled();
  });

  it.each([["B", "success"], ["B", "offline"], ["A", "success"]])("ignores an old workspace summary after switching to %s when the old read ends with %s", async (destination, outcome) => {
    let currentWorkspace = "A";
    let listener!: (event: unknown) => void;
    let finishOld!: (value: Awaited<ReturnType<OwbBridge["workspace"]>>) => void;
    let rejectOld!: (reason: Error) => void;
    const workspaceResponse = (name: string) => ({
      status: 200,
      body: { open: true, path: `/workspace/${name}`, business: `Workspace ${name}` },
    });
    const workspace = vi.fn()
      .mockResolvedValueOnce(workspaceResponse("A"))
      .mockImplementationOnce(() => new Promise<Awaited<ReturnType<OwbBridge["workspace"]>>>((resolve, reject) => { finishOld = resolve; rejectOld = reject; }))
      .mockImplementation(async () => workspaceResponse(currentWorkspace));
    const orgBackups = vi.fn()
      .mockResolvedValueOnce(backupResponse([]))
      .mockImplementation(async () => backupResponse([{ ...oldEmployee, backupId: `current-${currentWorkspace}`, name: `Current ${currentWorkspace}` }]));
    openedBridge({
      workspace,
      orgBackups,
      onEvent: vi.fn(callback => { listener = callback; return () => undefined; }),
    });
    await act(async () => { render(<App />); });
    await act(async () => listener({ type: "org.updated", payload: {
      workspace: "/workspace/A", version: { seq: 2, updatedAt: snapshot.updatedAt }, changes: [],
    } }));
    expect(workspace).toHaveBeenCalledTimes(2);
    currentWorkspace = "B";
    await chooseExistingWorkspace();
    if (destination === "A") {
      currentWorkspace = "A";
      await chooseExistingWorkspace();
    }
    const expectedReads = destination === "A" ? 3 : 2;
    expect(screen.getByRole("button", { name: "项目入口" })).toHaveTextContent(`Workspace ${destination}`);
    expect(orgBackups).toHaveBeenCalledTimes(expectedReads);
    const structure = await openOrganizationStructure();
    fireEvent.click(within(structure).getByRole("button", { name: "已移除员工 · 1" }));
    expect(within(structure).getByText(`Current ${destination}`)).toBeVisible();
    orgBackups.mockResolvedValue({ status: 503, body: { code: "unavailable" } });

    await act(async () => {
      if (outcome === "success") finishOld(workspaceResponse("A"));
      else rejectOld(new Error("stale workspace summary unavailable"));
    });
    expect(screen.getByRole("button", { name: "项目入口" })).toHaveTextContent(`Workspace ${destination}`);
    expect(orgBackups).toHaveBeenCalledTimes(expectedReads);
    expect(within(structure).getByText(`Current ${destination}`)).toBeVisible();
    expect(within(structure).queryByText("无法加载已移除员工")).not.toBeInTheDocument();
    expect(screen.queryByText(/本地服务未能连接/)).not.toBeInTheDocument();
  });
});

describe("App runtime bridge", () => {
  it("shows immediate truthful startup stages until service and workspace are ready", async () => {
    let finish!: (value: unknown) => void;
    const status = vi.fn(() => new Promise<any>((resolve) => { finish = resolve; }));
    installBridge({ status });
    render(<App />);
    const loading = screen.getByRole("status", { name: "RoleWeave 正在启动" });
    expect(loading).toHaveTextContent("正在启动本地服务");
    expect(document.querySelector(".owb-app")).toHaveAttribute("aria-busy", "true");
    finish({ running: false, state: "failed" });
    expect(await screen.findByRole("alert")).toHaveTextContent("本地服务未能连接");
    expect(screen.queryByRole("status", { name: "RoleWeave 正在启动" })).not.toBeInTheDocument();
  });

  it("finishes startup with a recoverable error when the local service cannot start", async () => {
    const bridge = installBridge({ status: vi.fn().mockResolvedValue({ running: false, state: "failed" }) });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("本地服务未能连接");
    expect(screen.queryByText("事件流重连中...")).not.toBeInTheDocument();
    expect(document.querySelector(".owb-org-module")).toBeNull();
    expect(bridge.workspace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重试连接" }));
    await waitFor(() => expect(bridge.status).toHaveBeenCalledTimes(2));
  });

  it("shows a single project welcome state when no workspace is open", async () => {
    installBridge();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "开始项目协作" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "打开或新建项目" })).toBeEnabled());
    expect(document.querySelector(".owb-org-module")).toBeNull();
  });
  it("renders the real engine health shape and reads the current SSE status", async () => {
    installBridge();

    render(<App />);

    expect(await screen.findByText("引擎可用")).toBeInTheDocument();
    expect(await screen.findByText("尚未打开工作区")).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(screen.queryByText("事件流重连中…")).not.toBeInTheDocument();
    });
  });

  it("reveals the local workspace path in the file manager from the topbar context", async () => {
    const revealWorkspace = vi.fn().mockResolvedValue({ opened: true, path: "/fixture/workspace" });
    openedBridge({ revealWorkspace });

    render(<App />);

    const chip = await screen.findByRole("button", { name: /\/fixture\/workspace$/ });
    expect(chip.getAttribute("title")).toContain("/fixture/workspace");
    fireEvent.click(chip);
    await waitFor(() => expect(revealWorkspace).toHaveBeenCalledTimes(1));
  });

  it("opens a centered workspace chooser from the global topbar", async () => {
    const openWorkspace = vi.fn().mockResolvedValue({ canceled: true });
    openedBridge({ openWorkspace });

    render(<App />);

    const projectEntry = await screen.findByRole("button", { name: "项目入口" });
    expect(projectEntry).toHaveTextContent("开源业务");
    expect(projectEntry).not.toHaveTextContent("/fixture/workspace");
    fireEvent.click(projectEntry);

    const dialog = screen.getByRole("dialog", { name: "选择工作区" });
    expect(within(dialog).getByText("/fixture/workspace")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /打开项目/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /新建项目/ })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /打开项目/ }));
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "选择工作区" })).not.toBeInTheDocument());
  });

  it("keeps the chooser visible while an existing workspace is opening and refreshes it after success", async () => {
    let resolveOpen!: (value: unknown) => void;
    const openWorkspace = vi.fn(() => new Promise((resolve) => { resolveOpen = resolve; }));
    let workspace: WorkspaceInfoResponse = { open: false };
    openedBridge({
      openWorkspace,
      workspace: vi.fn().mockImplementation(async () => ({ status: 200, body: workspace })),
      orgTree: vi.fn().mockResolvedValue({ status: 200, body: snapshot }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "项目入口" }));
    const dialog = screen.getByRole("dialog", { name: "选择工作区" });
    fireEvent.click(within(dialog).getByRole("button", { name: /打开项目/ }));
    expect(screen.getByRole("dialog", { name: "选择工作区" })).toBeInTheDocument();
    expect(within(dialog).getByRole("status")).toHaveTextContent("正在打开项目");
    expect(within(dialog).getByRole("button", { name: /打开项目/ })).toBeDisabled();

    workspace = { open: true, path: "/fixture/next", business: "新项目" };
    await act(async () => resolveOpen({ status: 200, body: workspace }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "选择工作区" })).not.toBeInTheDocument());
    expect(await screen.findByText("项目「新项目」已打开")).toBeInTheDocument();
  });

  it("keeps the chooser open and explains why an existing workspace was rejected", async () => {
    const openWorkspace = vi.fn().mockResolvedValue({ status: 422, body: { message: "workspace.json 缺失" } });
    openedBridge({ openWorkspace });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "项目入口" }));
    const dialog = screen.getByRole("dialog", { name: "选择工作区" });
    fireEvent.click(within(dialog).getByRole("button", { name: /打开项目/ }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("workspace.json 缺失");
    expect(screen.getByRole("dialog", { name: "选择工作区" })).toBeInTheDocument();
  });

  it("offers to initialize the selected directory when opening finds no workspace markers", async () => {
    const openWorkspace = vi.fn().mockResolvedValue({
      status: 422,
      body: { message: "workspace.json 缺失" },
      workspacePath: "/tmp/source-tree",
    });
    openedBridge({ openWorkspace });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "项目入口" }));
    const dialog = screen.getByRole("dialog", { name: "选择工作区" });
    fireEvent.click(within(dialog).getByRole("button", { name: /打开项目/ }));
    expect(await within(dialog).findByRole("button", { name: /在此目录初始化项目/ })).toBeInTheDocument();
  });

  it("opens the selected employee's direct conversation with a fixed Agent identity and no duplicate session controls", async () => {
    // The organization tree is the only recipient selector.  A click opens
    // that employee's durable conversation; the conversation header carries
    // the fixed Agent identity, and runtime/session plumbing must not
    // reappear as a second choice in the right pane.
    openedBridge({
      position: vi.fn().mockResolvedValue({ status: 200, body: { position, agentEngine: "qoder", agentLocked: true } }),
    });

    render(<App />);
    await selectRepoOwner();

    expect(screen.getByLabelText("下达任务")).toHaveAttribute("placeholder", "向 @代码库负责人 下达任务…");
    expect(screen.queryByRole("combobox", { name: "选择对话岗位" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "选择本地会话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "选择 Agent Host" })).not.toBeInTheDocument();
    expect(document.querySelector(".owb-conversation-header-host .owb-engine-badge")).toHaveTextContent("Qoder");
    expect(screen.queryByRole("button", { name: "轮换当前会话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "启用会话上下文" })).not.toBeInTheDocument();
  });

  it("#322 opens an unlocked employee direct conversation with an interactive Agent Host selector", async () => {
    openedBridge({
      position: vi.fn().mockResolvedValue({ status: 200, body: { position, agentEngine: "qoder", agentLocked: false } }),
    });

    render(<App />);
    await selectRepoOwner();

    expect(screen.getByRole("combobox", { name: "选择 Agent Host" })).toBeInTheDocument();
  });

  it("shows each employee's Agent before selection and marks an unbound employee's current default", async () => {
    const children = ["writer", "imported"].map(id => ({ id, reportTo: "repo-owner", budget: snapshot.tree[0]!.budget, children: [] }));
    const engines: Record<string, string> = { "repo-owner": "qoder", writer: "codex-local" };
    openedBridge({
      orgTree: vi.fn().mockResolvedValue({ status: 200, body: { ...snapshot, positionCount: 3, depth: 2, tree: [{ ...snapshot.tree[0]!, children }] } }),
      position: vi.fn(async id => ({ status: 200, body: {
        position: { ...position, id, name: id }, ...(engines[id] ? { agentEngine: engines[id] } : {}),
      } })),
    });
    await act(async () => { render(<App />); });
    const tree = screen.getByRole("tree");
    const owner = tree.querySelector('[data-org-node-id="repo-owner"]') as HTMLElement;
    const writer = tree.querySelector('[data-org-node-id="writer"]') as HTMLElement;
    const imported = tree.querySelector('[data-org-node-id="imported"]') as HTMLElement;
    expect(within(owner).getByTitle("Agent：Qoder")).toHaveTextContent("Qoder");
    expect(within(writer).getByTitle("Agent：Codex")).toHaveTextContent("Codex");
    expect(within(imported).getByTitle("当前默认 Agent：Qoder，首次运行后固定")).toHaveTextContent("Qoder · 默认");
    expect(tree.querySelector('[aria-selected="true"]')).toBeNull();
    expect(within(writer).queryByText("codex-local")).not.toBeInTheDocument();
  });

  it("clears the previous workspace's Agent label while the new employee metadata is pending", async () => {
    let workspace = "A";
    let finishMetadata!: (value: Awaited<ReturnType<OwbBridge["position"]>>) => void;
    const positionRead = vi.fn(() => workspace === "A"
      ? Promise.resolve({ status: 200, body: { position, agentEngine: "workbuddy" } })
      : new Promise<Awaited<ReturnType<OwbBridge["position"]>>>(resolve => { finishMetadata = resolve; }));
    openedBridge({
      position: positionRead,
      workspace: vi.fn(async () => ({ status: 200, body: { open: true, path: `/workspace/${workspace}`, business: `Workspace ${workspace}` } })),
    });
    await act(async () => { render(<App />); });
    expect(screen.getByTitle("Agent：WorkBuddy")).toBeInTheDocument();
    workspace = "B";
    await chooseExistingWorkspace();
    expect(screen.getByRole("button", { name: "项目入口" })).toHaveTextContent("Workspace B");
    expect(screen.queryByTitle("Agent：WorkBuddy")).not.toBeInTheDocument();
    expect(screen.getByTitle("当前默认 Agent：Qoder，首次运行后固定")).toBeInTheDocument();
    await act(async () => finishMetadata({ status: 200, body: { position, agentEngine: "codex-local" } }));
    expect(screen.getByTitle("Agent：Codex")).toBeInTheDocument();
    expect(screen.queryByTitle("当前默认 Agent：Qoder，首次运行后固定")).not.toBeInTheDocument();
  });

  it("shows the model picker for an unbound employee and saves the choice with its effective Agent", async () => {
    const modelConfig = {
      selected: "provider-default",
      recommended: "provider-default",
      editable: true,
      source: "default" as const,
      options: [
        { id: "provider-default", name: "Agent default", tier: "default" as const },
        { id: "performance", name: "Performance", tier: "balanced" as const },
      ],
    };
    const positionRead = vi.fn().mockResolvedValue({ status: 200, body: { position, modelConfig } });
    const setPositionModel = vi.fn().mockResolvedValue({ status: 200, body: { ...modelConfig, selected: "performance" } });
    openedBridge({ position: positionRead, setPositionModel });

    render(<App />);
    await selectRepoOwner();
    const row = screen.getByRole("tree").querySelector('[data-org-node-id="repo-owner"]') as HTMLElement;
    expect(within(row).getByTitle("当前默认 Agent：Qoder，首次运行后固定")).toHaveTextContent("Qoder · 默认");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "员工模型" })).toBeEnabled());
    pickSelectOption("员工模型", "Performance");

    await waitFor(() => expect(setPositionModel).toHaveBeenCalledWith({
      positionId: "repo-owner",
      model: "performance",
      engine: "qoder",
    }));
    expect(positionRead.mock.calls.some(([id, engine]) => id === "repo-owner" && engine === "qoder")).toBe(true);
    expect(within(row).getByTitle("Agent：Qoder")).toHaveTextContent("Qoder");
    expect(within(row).queryByText(/默认/)).not.toBeInTheDocument();
  });

  it("preserves a confirmed model binding against older metadata but accepts a later refresh", async () => {
    let listener: (event: unknown) => void = () => {};
    let finishMetadata!: (value: Awaited<ReturnType<OwbBridge["position"]>>) => void;
    const modelConfig = { selected: "provider-default", recommended: "provider-default", editable: true, source: "default", options: [
      { id: "provider-default", name: "Agent default", tier: "default" }, { id: "performance", name: "Performance", tier: "balanced" },
    ] };
    const bridge = openedBridge({
      position: vi.fn().mockResolvedValue({ status: 200, body: { position, modelConfig } }),
      onEvent: vi.fn(callback => { listener = callback; return () => {}; }),
      setPositionModel: vi.fn().mockResolvedValue({ status: 200, body: { ...modelConfig, selected: "performance" } }),
    });
    await act(async () => { render(<App />); });
    await selectRepoOwner();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "员工模型" })).toBeEnabled());
    vi.mocked(bridge.position).mockImplementationOnce(() => new Promise(resolve => { finishMetadata = resolve; }));
    await act(async () => listener({ type: "org.updated", payload: { workspace: "/fixture/workspace", version: { seq: 8 }, changes: [] } }));
    expect(finishMetadata).toBeTypeOf("function");
    pickSelectOption("员工模型", "Performance");
    await waitFor(() => expect(screen.getByTitle("Agent：Qoder")).toBeInTheDocument());
    expect(bridge.setPositionModel).toHaveBeenCalledExactlyOnceWith({ positionId: "repo-owner", model: "performance", engine: "qoder" });
    await act(async () => finishMetadata({ status: 200, body: { position, modelConfig } }));
    expect(screen.getByTitle("Agent：Qoder")).toBeInTheDocument();
    expect(screen.queryByTitle("当前默认 Agent：Qoder，首次运行后固定")).not.toBeInTheDocument();

    // A refresh begun after the save must still accept current server data,
    // for example when an employee was replaced by an organization update.
    vi.mocked(bridge.position).mockResolvedValue({ status: 200, body: { position, agentEngine: "codex-local" } });
    await act(async () => listener({ type: "org.updated", payload: { workspace: "/fixture/workspace", version: { seq: 9 }, changes: [] } }));
    expect(screen.getByTitle("Agent：Codex")).toBeInTheDocument();
    expect(screen.queryByTitle("Agent：Qoder")).not.toBeInTheDocument();
  });

  it.each(["B", "A"])("does not apply an old model save's Agent label after workspace navigation ends in %s", async destination => {
    let workspace = "A";
    let navigated = false;
    let finishSave!: (value: unknown) => void;
    const modelConfig = { selected: "provider-default", recommended: "provider-default", editable: true, source: "default", options: [
      { id: "provider-default", name: "Agent default", tier: "default" }, { id: "performance", name: "Performance", tier: "balanced" },
    ] };
    const setPositionModel = vi.fn(() => new Promise(resolve => { finishSave = resolve; }));
    openedBridge({
      setPositionModel,
      workspace: vi.fn(async () => ({ status: 200, body: { open: true, path: `/workspace/${workspace}`, business: `Workspace ${workspace}` } })),
      position: vi.fn(async () => ({ status: 200, body: { position, modelConfig, ...(navigated ? { agentEngine: "codex-local", agentLocked: true } : {}) } })),
    });
    await act(async () => { render(<App />); });
    await selectRepoOwner();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "员工模型" })).toBeEnabled());
    pickSelectOption("员工模型", "Performance");
    expect(setPositionModel).toHaveBeenCalledExactlyOnceWith({ positionId: "repo-owner", model: "performance", engine: "qoder" });
    navigated = true;
    workspace = "B";
    await chooseExistingWorkspace();
    if (destination === "A") { workspace = "A"; await chooseExistingWorkspace(); }
    expect(screen.getByTitle("Agent：Codex")).toBeInTheDocument();
    await act(async () => finishSave({ status: 200, body: { ...modelConfig, selected: "performance" } }));
    expect(screen.getByRole("button", { name: "项目入口" })).toHaveTextContent(`Workspace ${destination}`);
    expect(screen.getByTitle("Agent：Codex")).toBeInTheDocument();
    expect(screen.queryByTitle("Agent：Qoder")).not.toBeInTheDocument();
  });

  it.each(["qoder", "claude-code", "codex-local", "workbuddy"] as const)("uses the persisted %s binding across remounts instead of a stale global preference", async (agentEngine) => {
    window.localStorage.setItem("owb-turn-engine", "codex-local");
    try {
      for (let mount = 0; mount < 2; mount += 1) {
        const bridge = openedBridge({
          position: vi.fn().mockResolvedValue({ status: 200, body: { position, agentEngine, agentLocked: true } }),
          createSessionTurn: vi.fn().mockResolvedValue({ status: 200, body: apiTurn({ engine: agentEngine, input: "使用员工绑定" }) }),
        });
        const view = render(<App />);
        try {
          await selectRepoOwner();
          await waitFor(() => expect(bridge.sessionTurnHistory).toHaveBeenCalled());
          expect(screen.queryByRole("combobox", { name: "选择 Agent Host" })).not.toBeInTheDocument();
          if (agentEngine !== "claude-code") {
            await waitFor(() => expect(screen.getByLabelText("下达任务")).toBeEnabled());
            fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "使用员工绑定" } });
            fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
            await waitFor(() => expect(bridge.createSessionTurn).toHaveBeenCalledWith({
              sessionId: activeSession.sessionId, engine: agentEngine, input: "使用员工绑定",
            }));
            await waitFor(() => expect(screen.getByLabelText("下达任务")).toBeEnabled());
          } else {
            // Other hosts are ready, but this employee must not silently migrate.
            expect(await screen.findByText("Claude Code 暂时无法使用。")).toBeVisible();
            expect(screen.queryByText("设置 ANTHROPIC_API_KEY 后重启工作台")).not.toBeInTheDocument();
            expect(screen.getByLabelText("下达任务")).toBeDisabled();
            expect(bridge.createSessionTurn).not.toHaveBeenCalled();
          }
          expect(window.localStorage.getItem("owb-turn-engine")).toBe("codex-local");
        } finally {
          view.unmount();
        }
      }
    } finally {
      window.localStorage.removeItem("owb-turn-engine");
    }
  });

  it("opens a workspace, selects an employee in the tree, loads local history, sends, and reads persisted history back", async () => {
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

  it("edits the right-clicked employee's record from the tree menu without moving the selection", async () => {
    const docsPosition = { ...position, id: "docs-writer", name: "文档工程师", description: "维护文档", reportTo: "repo-owner" };
    const twoNodeSnapshot = {
      ...snapshot,
      positionCount: 2,
      depth: 2,
      tree: [{ ...snapshot.tree[0], children: [{ id: "docs-writer", reportTo: "repo-owner", budget: { perTask: { tokens: 500 }, perDay: { tokens: 2000 } }, children: [] }] }],
    };
    const updatePositionProfile = vi.fn().mockResolvedValue({ status: 200, body: { status: "updated", name: "文档维护者" } });
    openedBridge({
      orgTree: vi.fn().mockResolvedValue({ status: 200, body: twoNodeSnapshot }),
      position: vi.fn().mockImplementation((id: string) => Promise.resolve({
        status: 200,
        body: { position: id === "docs-writer" ? docsPosition : position, agentEngine: "qoder" },
      })),
      updatePositionProfile,
    });
    render(<App />);
    await selectRepoOwner();
    const tree = await screen.findByRole("tree");
    const docsRow = tree.querySelector('[data-org-node-id="docs-writer"]');
    expect(docsRow).not.toBeNull();
    fireEvent.contextMenu(docsRow!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑" }));
    // The drawer seeds from the right-clicked record, not the selected one.
    const nameInput = await screen.findByDisplayValue("文档工程师");
    expect(screen.getByText("编辑员工")).toBeInTheDocument();
    fireEvent.change(nameInput, { target: { value: "文档维护者" } });
    fireEvent.click(screen.getByRole("button", { name: "保存改动" }));
    await waitFor(() => expect(updatePositionProfile).toHaveBeenCalledWith({ positionId: "docs-writer", name: "文档维护者" }));
    await waitFor(() => expect(screen.queryByText("编辑员工")).toBeNull());
    // The conversation selection stayed on the owner throughout the edit.
    expect(screen.getByRole("region", { name: "岗位对话" })).toBeInTheDocument();
  });

  it("keeps an employee whose bound Agent is unavailable honestly disabled", async () => {
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
            codex: { configured: false, ready: false },
            "codex-local": { configured: false, ready: false },
          },
          workspace: { open: true, path: "/fixture/workspace" },
        },
      }),
      turnHistory: vi.fn().mockResolvedValue({ status: 200, body: history([]) }),
    });

    render(<App />);
    await selectRepoOwner();
    expect(await screen.findByText("Qoder 暂时无法使用。")).toBeVisible();
    expect(screen.queryByText("Qoder 凭据未配置")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled();
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
    const input = screen.getByLabelText("下达任务");
    fireEvent.change(input, { target: { value: "不要丢失这条任务" } });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Qoder Host 暂不可用");
    expect(input).toHaveValue("不要丢失这条任务");
    expect(createSessionTurn).toHaveBeenCalledTimes(1);
  });

  it("automatically attaches an active session after a tree selection without exposing session settings", async () => {
    const sessions = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { schemaVersion: "workbench-session-list.v1", positionId: "repo-owner", activeSessionId: null, sessions: [] } })
      .mockResolvedValue({ status: 200, body: { schemaVersion: "workbench-session-list.v1", positionId: "repo-owner", activeSessionId: activeSession.sessionId, sessions: [activeSession] } });
    const createSession = vi.fn().mockResolvedValue({ status: 201, body: activeSession });
    const sessionTurnHistory = vi.fn().mockResolvedValue({ status: 200, body: history([apiTurn()]) });
    openedBridge({ sessions, createSession, sessionTurnHistory });

    render(<App />);
    await selectRepoOwner();
    await waitFor(() => expect(createSession).toHaveBeenCalledWith({ positionId: "repo-owner" }));
    expect(await screen.findByText("历史结果")).toBeInTheDocument();
    expect(screen.getByLabelText("下达任务")).toBeEnabled();
    expect(screen.queryByRole("combobox", { name: "选择本地会话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "轮换当前会话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "启用会话上下文" })).not.toBeInTheDocument();
  });

  it("keeps a live group turn across direct employee selection without surfacing session controls (#114)", async () => {
    const group = {
      schemaVersion: "conversation-group.v1" as const,
      conversationRef: "33333333-3333-4333-8333-333333333333",
      sessionId: "44444444-4444-4444-8444-444444444444",
      members: ["repo-owner"],
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const createGroupTurn = vi.fn().mockResolvedValue({
      status: 202,
      body: {
        conversationRef: group.conversationRef,
        messageId: "message-1",
        spawns: [{ turnId: "group-turn-1", positionId: "repo-owner" }],
      },
    });
    const listeners = new Set<(value: unknown) => void>();
    openedBridge({
      onEvent: vi.fn((callback) => { listeners.add(callback); return () => { listeners.delete(callback); }; }),
      groups: vi.fn().mockResolvedValue({
        status: 200,
        body: { schemaVersion: "conversation-group-list.v1", groups: [group] },
      }),
      groupTimeline: vi.fn().mockResolvedValue({
        status: 200,
        body: { schemaVersion: "group-timeline.v1", conversationRef: group.conversationRef, items: [] },
      }),
      createGroupTurn,
    });

    const { container } = render(<App />);
    fireEvent.click(within(await screen.findByRole("navigation", { name: "协作方式" })).getByRole("button", { name: "群聊" }));
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
    expect(screen.queryByRole("combobox", { name: "选择本地会话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "轮换当前会话" })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("navigation", { name: "协作方式" })).getByRole("button", { name: "群聊" }));
    await waitFor(() => expect(container.querySelectorAll(".owb-bubble-row--employee")).toHaveLength(1));

    act(() => listeners.forEach((listener) => listener({ seq: 1, type: "turn.completed", payload: { workspacePath: "/fixture/workspace", groupRef: group.conversationRef, messageId: "message-1", turnId: "group-turn-1", positionId: "repo-owner", engine: "qoder", runId: "group-run-1" } })));
    fireEvent.click(screen.getByRole("button", { name: "组织" }));
    await waitFor(() => expect(screen.getByLabelText("下达任务")).toBeEnabled());
    expect(screen.queryByRole("button", { name: "轮换当前会话" })).not.toBeInTheDocument();
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
      position: vi.fn().mockImplementation(async (id: string) => ({ status: 200, body: { position: { ...position, id, name: id, reportTo: id === "repo-owner" ? null : "repo-owner" }, agentEngine: "qoder" } })),
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

  it.each([
    [3, "before-response"], [30, "before-response"],
    [3, "after-refresh"], [30, "after-refresh"],
    [3, "missing"], [30, "missing"],
  ] as const)("refreshes once per drop with %i positions and %s SSE", async (size, timing) => {
    const children = ["docs-writer", "release-engineer", ...Array.from({ length: size - 3 }, (_, i) => `extra-${i}`)]
      .map((id) => ({ id, reportTo: "repo-owner", budget: snapshot.tree[0]!.budget, children: [] }));
    const tree = { ...snapshot, positionCount: size, depth: 2, tree: [{ ...snapshot.tree[0]!, children }] };
    const moved = {
      ...tree, depth: 3, tree: [{ ...tree.tree[0]!, children: [
        { ...children[1]!, children: [{ ...children[0]!, reportTo: "release-engineer" }] }, ...children.slice(2),
      ] }],
    };
    const version = { seq: 2, updatedAt: snapshot.updatedAt };
    const changes = [{ op: "move", id: "docs-writer", reportTo: "release-engineer" }];
    const listeners = new Set<(event: unknown) => void>();
    const emit = (seq: number, ops: unknown = changes) => listeners.forEach((listener) => listener({
      type: "org.updated", payload: { workspace: "/fixture/workspace", version: { ...version, seq }, changes: ops },
    }));
    let resolveApply!: (response: { status: number; body: unknown }) => void;
    let resolveTree!: (response: { status: number; body: unknown }) => void;
    let resolveWorkspace!: (response: { status: number; body: unknown }) => void;
    const bridge = openedBridge({
      onEvent: vi.fn((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
      orgApply: vi.fn(() => new Promise((resolve) => { resolveApply = resolve; })),
      orgTree: vi.fn().mockResolvedValue({ status: 200, body: tree }),
      position: vi.fn(async (id: string) => ({ status: 200, body: { position: { ...position, id, name: id } } })),
    });
    render(<App />);
    const source = await screen.findByText("docs-writer", { selector: ".ui-org-tree__name" });
    const target = screen.getByText("release-engineer", { selector: ".ui-org-tree__name" });
    await waitFor(() => expect(bridge.reports).toHaveBeenCalledTimes(1));
    const positionReads = vi.mocked(bridge.position).mock.calls.length;
    for (const read of [bridge.status, bridge.workspace, bridge.orgTree, bridge.orgBackups, bridge.reports]) vi.mocked(read).mockClear();
    vi.mocked(bridge.orgTree).mockImplementationOnce(() => new Promise((resolve) => { resolveTree = resolve; }));
    vi.mocked(bridge.workspace).mockImplementationOnce(() => new Promise((resolve) => { resolveWorkspace = resolve; }));
    const data = new Map<string, string>();
    const dataTransfer = { effectAllowed: "move", dropEffect: "move", setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? "" };
    fireEvent.dragStart(source.closest('[role="treeitem"]')!, { dataTransfer });
    fireEvent.drop(target.closest('[role="treeitem"]')!, { dataTransfer });
    expect(bridge.orgApply).toHaveBeenCalledWith({ schemaVersion: "change-manifest.v1", changes });
    if (timing === "before-response") {
      act(() => emit(2));
      await waitFor(() => expect(bridge.orgTree).toHaveBeenCalledTimes(1));
    }
    await act(async () => resolveApply({ status: 200, body: { status: "applied", version, changesApplied: 1 } }));
    await waitFor(() => expect(bridge.orgTree).toHaveBeenCalledTimes(1));
    expect(source.closest('[role="treeitem"]')).toHaveAttribute("draggable", "false");
    // orgTree has started even though the workspace read is still pending.
    await act(async () => resolveWorkspace({ status: 200, body: { open: true, path: "/fixture/workspace", business: "开源业务" } }));
    await act(async () => resolveTree({ status: 200, body: moved }));
    const movedRow = () => screen.getByText("docs-writer", { selector: ".ui-org-tree__name" }).closest('[role="treeitem"]');
    await waitFor(() => expect(movedRow()).toHaveAttribute("draggable", "true"));
    // owner(1) → release-engineer(2) → docs-writer(3): the directory leads
    // with people, no project pseudo-row above the owner.
    expect(movedRow()).toHaveAttribute("aria-level", "3");
    if (timing === "after-refresh") await act(async () => emit(2));
    for (const read of [bridge.status, bridge.workspace, bridge.orgTree, bridge.orgBackups, bridge.reports]) expect(read).toHaveBeenCalledTimes(1);
    expect(bridge.position).toHaveBeenCalledTimes(positionReads);

    // A later independent mutation must never be swallowed, even if this
    // drop's SSE event was missing. Reorders can share updatedAt, so seq is
    // part of the key. Unknown/delete changes take the full metadata path.
    await act(async () => emit(3, [{ op: "delete", id: "extra" }]));
    await waitFor(() => expect(bridge.orgTree).toHaveBeenCalledTimes(2));
    expect(vi.mocked(bridge.position).mock.calls.length).toBeGreaterThan(positionReads);
  });

  it.each(["rejected", "offline"])("preserves %s apply feedback and accepts the next SSE update", async (outcome) => {
    const tree = { ...snapshot, positionCount: 2, tree: [{ ...snapshot.tree[0]!, children: [
      { id: "docs-writer", reportTo: "repo-owner", budget: snapshot.tree[0]!.budget, children: [] },
    ] }] };
    const listeners = new Set<(event: unknown) => void>();
    const bridge = openedBridge({
      onEvent: vi.fn((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
      orgApply: outcome === "offline"
        ? vi.fn().mockRejectedValue(new Error("offline"))
        : vi.fn().mockResolvedValue({ status: 422, body: { message: "engine rejected proposal", retryable: false } }),
      orgTree: vi.fn().mockResolvedValue({ status: 200, body: tree }),
      position: vi.fn(async (id: string) => ({ status: 200, body: { position: { ...position, id, name: id } } })),
    });
    render(<App />);
    const row = (await screen.findByText("docs-writer", { selector: ".ui-org-tree__name" })).closest('[role="treeitem"]')!;
    await waitFor(() => expect(bridge.reports).toHaveBeenCalledTimes(1));
    vi.mocked(bridge.orgTree).mockClear();
    fireEvent.focus(row);
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowLeft", metaKey: true });
    expect(await screen.findByText(outcome === "offline"
      ? "组织变更状态不确定：本地服务不可用；不会自动重试"
      : "engine rejected proposal")).toBeInTheDocument();
    expect(bridge.orgApply).toHaveBeenCalledTimes(1);
    expect(bridge.orgTree).not.toHaveBeenCalled();
    expect(row).toHaveAttribute("draggable", "true");
    await act(async () => listeners.forEach((listener) => listener({ type: "org.updated", payload: {
      workspace: "/fixture/workspace", version: { seq: 3, updatedAt: snapshot.updatedAt }, changes: [{ op: "move", id: "docs-writer" }],
    } })));
    expect(bridge.orgTree).toHaveBeenCalledTimes(1);
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
      position: vi.fn().mockImplementation(async (id: string) => ({ status: 200, body: { position: { ...position, id, name: id, reportTo: id === "repo-owner" ? null : "repo-owner" }, agentEngine: "qoder" } })),
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

    contactAction("撤销");
    await waitFor(() => expect(orgUndo).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("已撤销最近一次组织调整")).toBeInTheDocument();
  });

  it("surfaces a friendly note when there is nothing to undo", async () => {
    openedBridge({ turnHistory: vi.fn().mockResolvedValue({ status: 200, body: history([]) }) });
    render(<App />);
    await screen.findByRole("button", { name: "通讯录操作" });
    contactAction("撤销");
    expect(await screen.findByText("没有可撤销的组织调整")).toBeInTheDocument();
  });

  // Full-App render with the hire drawer round-trip; a macOS runner timeout
  // was observed at the 5s default (#529). 15s matches the other full-App
  // tests in this file.
  it.each(["codex", "codex-local"] as const)("binds the ready %s runtime in HireDrawer and sends it through POST /hire", async (agentEngine) => {
    const hire = vi.fn().mockResolvedValue({
      status: 200,
      body: { status: "hired", positionId: "docs-writer", agentEngine, version: { seq: 6, updatedAt: "2026-08-26T00:00:00.000Z" } },
    });
    const orgApply = vi.fn().mockResolvedValue({ status: 200, body: { status: "applied" } });
    const bridge = openedBridge({ hire, orgApply, turnHistory: vi.fn().mockResolvedValue({ status: 200, body: history([]) }) });
    const status = await bridge.status();
    if (!status.health) throw new Error("fixture must expose engine health");
    vi.mocked(bridge.status).mockResolvedValue({
      ...status,
      health: {
        ...status.health,
        hosts: {
          ...status.health.hosts,
          codex: { configured: true, ready: agentEngine === "codex" },
          "codex-local": { configured: true, ready: agentEngine === "codex-local" },
        },
      },
    });
    render(<App />);
    await screen.findByRole("button", { name: "通讯录操作" });
    contactAction("创建员工");
    expect(await screen.findByRole("button", { name: "开始创建" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /员工 Agent/ }));
    fireEvent.click(screen.getByRole("option", { name: "Codex" }));
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
      agentEngine,
    }));
    expect(orgApply).not.toHaveBeenCalled();
    expect(await screen.findByText("文档负责人 已加入团队")).toBeInTheDocument();
  }, 15_000);

  it("requires dismissal confirmation and invokes one-click restore through typed IPC", async () => {
    const childSnapshot = { ...snapshot, positionCount: 2, depth: 2, tree: [{ ...snapshot.tree[0]!, children: [{ id: "docs-writer", reportTo: "repo-owner", budget: snapshot.tree[0]!.budget, children: [] }] }] };
    const orgApply = vi.fn().mockResolvedValue({ status: 200, body: { status: "applied" } });
    const orgRestore = vi.fn().mockResolvedValue({ status: 200, body: { status: "applied", positionId: "old-writer", restored: true } });
    openedBridge({
      orgTree: vi.fn().mockResolvedValue({ status: 200, body: childSnapshot }),
      position: vi.fn().mockImplementation(async (id: string) => ({ status: 200, body: { position: { ...position, id, name: id, reportTo: id === "repo-owner" ? null : "repo-owner" }, agentEngine: "qoder" } })),
      orgApply,
      orgBackups: vi.fn().mockResolvedValue({ status: 200, body: { schemaVersion: "org-backups.v1", backups: [{ backupId: "old-writer-1756000000000-abcdef", positionId: "old-writer", dismissedAt: "2026-08-24T06:00:00Z", reportTo: "repo-owner", name: "旧文档负责人" }] } }),
      orgRestore,
      turnHistory: vi.fn().mockResolvedValue({ status: 200, body: history([]) }),
    });
    render(<App />);
    fireEvent.click(await screen.findByText("docs-writer", { selector: ".ui-org-tree__name, .ui-org-tree__id" }));
    selectEmployeeView("档案");
    // #137 review：裁撤动作住在岗位档案卡头部，而不是悬浮在卡片外面。
    const cardRegion = screen.getByRole("region", { name: "岗位档案" });
    fireEvent.click(await within(cardRegion).findByRole("button", { name: "裁撤" }));
    fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
    expect(orgApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "裁撤" }));
    fireEvent.click(screen.getByRole("button", { name: "确认裁撤并留痕" }));
    await waitFor(() => expect(orgApply).toHaveBeenCalledWith({ schemaVersion: "change-manifest.v1", changes: [{ op: "delete", id: "docs-writer" }] }));

    const structure = await openOrganizationStructure();
    fireEvent.click(within(structure).getByRole("button", { name: "已移除员工 · 1" }));
    fireEvent.click(within(structure).getByRole("button", { name: "恢复" }));
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
    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "检查下一版发布" } });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
    await waitFor(() => expect(createSessionTurn).toHaveBeenCalled());
    expect(listener).not.toBeNull();

    act(() => {
      listener!({ seq: 1, type: "turn.started", payload: { positionId: "repo-owner", sessionId: activeSession.sessionId, engine: "qoder", runId: "run-stream", timestamp: "2026-08-24T05:00:00.000Z", type: "run.started" } });
      listener!({ seq: 2, type: "turn.model.delta", payload: { positionId: "repo-owner", sessionId: activeSession.sessionId, engine: "qoder", runId: "run-stream", timestamp: "2026-08-24T05:00:00.500Z", type: "model.delta", text: "正在分析" } });
      listener!({ seq: 3, type: "turn.model.delta", payload: { positionId: "repo-owner", sessionId: activeSession.sessionId, engine: "qoder", runId: "run-stream", timestamp: "2026-08-24T05:00:01.000Z", type: "model.delta", text: "…核对完成" } });
    });
    expect(await screen.findByText("正在分析…核对完成")).toBeInTheDocument();
    expect(screen.getByText("正在执行中")).toBeInTheDocument();

    act(() => {
      listener!({ seq: 3, type: "turn.model.delta", payload: { positionId: "repo-owner", sessionId: activeSession.sessionId, engine: "qoder", runId: "run-stream", timestamp: "2026-08-24T05:00:01.000Z", type: "model.delta", text: "…核对完成" } });
    });
    expect(screen.getAllByText("正在分析…核对完成")).toHaveLength(1);

    act(() => {
      listener!({ seq: 4, type: "turn.completed", payload: { positionId: "repo-owner", sessionId: activeSession.sessionId, engine: "qoder", runId: "run-stream", timestamp: "2026-08-24T05:01:00.000Z", type: "run.completed", output: "发布门禁通过", terminalReason: "goal_met" } });
    });
    await act(async () => {
      resolveTurn({ status: 200, body: completed });
    });
    expect(await screen.findByText("发布门禁通过")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("正在分析…核对完成")).not.toBeInTheDocument());
    expect(screen.getByText("已处理")).toBeInTheDocument();
  });

  it.each(["success", "rejection"])("keeps workspace report facts in B when A's delayed request finishes with %s", async outcome => {
    let workspace = "A";
    let finishOld!: (value: Awaited<ReturnType<OwbBridge["reports"]>>) => void;
    let rejectOld!: (reason: Error) => void;
    const reportWithTotal = (total: number): ReportsResponse => ({
      ...emptyReports(),
      budgets: [{ positionId: "repo-owner", declared: position.budget, recorded: { inputTokens: total, outputTokens: 0, totalTokens: total }, latestTurn: { inputTokens: total, outputTokens: 0, totalTokens: total }, state: "within" }],
    });
    const reports = vi.fn<OwbBridge["reports"]>().mockResolvedValue({ status: 200, body: reportWithTotal(22) });
    reports.mockImplementationOnce(() => new Promise((resolve, reject) => { finishOld = resolve; rejectOld = reject; }));
    openedBridge({ reports, workspace: vi.fn(async () => ({ status: 200, body: { open: true, path: `/workspace/${workspace}`, business: `Workspace ${workspace}` } })) });
    await act(async () => { render(<App />); });
    expect(reports).toHaveBeenCalledTimes(1);
    workspace = "B";
    await chooseExistingWorkspace();
    expect(screen.getByRole("button", { name: "项目入口" })).toHaveTextContent("Workspace B");
    await openInbox("上报");
    expect(screen.getByRole("button", { name: "已记录 Token" })).toHaveTextContent("22");
    await act(async () => {
      if (outcome === "success") finishOld({ status: 200, body: reportWithTotal(11) });
      else rejectOld(Error("old workspace offline"));
    });
    expect(screen.getByRole("button", { name: "已记录 Token" })).toHaveTextContent("22");
    expect(screen.queryByText("old workspace offline")).not.toBeInTheDocument();
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
    await openInbox("上报");
    expect(await screen.findByRole("heading", { name: "上报中心" })).toBeInTheDocument();
    expect(screen.queryByText("position_budget_exceeded")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /用量与预算/ }));
    expect(screen.getByRole("meter", { name: "单任务消耗" })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.queryByRole("meter", { name: "单日用量不可用" })).not.toBeInTheDocument();
    expect(screen.getByText(/未记录 · 上限 1,000/)).toBeInTheDocument();
    expect(screen.getAllByText("50%")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /执行记录/ }));
    expect(screen.queryByText("sha256:evidence")).not.toBeInTheDocument();
    expect(screen.queryByText("sensitive raw input")).not.toBeInTheDocument();
    expect(screen.queryByText("sensitive raw output")).not.toBeInTheDocument();
    // #112: a durable session record is opaque to the renderer; once the
    // sanitized evidence reaches reports.v1 it must also populate the derived timeline.
    // #394: the stream switcher is flat now, so anchor the nav tab label to
    // avoid matching the evidence table's per-row "查看时间线" link button.
    fireEvent.click(screen.getByRole("button", { name: /^时间线/ }));
    expect(screen.getByLabelText("执行时间线")).toBeInTheDocument();
    expect(screen.getByText("共 3 条")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-budget-tag-turn-1")).toBeInTheDocument();
    expect(screen.queryByText("turn-1")).not.toBeInTheDocument();
  });

  it("opens the exact employee session and focuses the turn from a report row", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const reports: ReportsResponse = {
      schemaVersion: "reports.v1",
      streams: {
        escalations: [{ schemaVersion: "turn-escalation.v1", positionId: "repo-owner", turnId: "turn-1", at: "2026-08-24T06:00:00Z", status: "failed", code: "turn_failed", reportingChain: ["repo-owner"], budgetRelated: false }],
        audits: [],
        evidence: [{ schemaVersion: "turn-evidence.v1", positionId: "repo-owner", turnId: "turn-1", conversationId: "conversation-1", engine: "qoder", status: "failed", createdAt: "2026-08-24T05:59:00Z", updatedAt: "2026-08-24T06:00:00Z", envelopeDigest: "sha256:evidence", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, errorCode: "turn_failed" }],
      },
      budgets: [],
      page: { cursor: null, hasMore: false },
    };
    const reportSession: WorkbenchSession = { ...activeSession, sessionId: "conversation-1", status: "rotated", rotatedTo: activeSession.sessionId };
    const sessionTurnHistory = vi.fn().mockResolvedValue({
      status: 200,
      body: history([apiTurn({ turnId: "turn-1", status: "failed", output: undefined })]),
    });
    const bridge = openedBridge({
      reports: vi.fn().mockResolvedValue({ status: 200, body: reports }),
      sessions: vi.fn().mockResolvedValue({
        status: 200,
        body: { schemaVersion: "workbench-session-list.v1", positionId: "repo-owner", activeSessionId: activeSession.sessionId, sessions: [activeSession, reportSession] },
      }),
      sessionTurnHistory,
    });

    render(<App />);
    for (let visit = 1; visit <= 2; visit += 1) {
      await openInbox("上报");
      fireEvent.click(
        await screen.findByRole("button", { name: "打开回合对话：turn-1" }),
      );

      const conversation = await screen.findByRole("region", { name: "岗位对话" });
      expect(conversation).toBeVisible();
      expect(within(screen.getByRole("navigation", { name: "模块" })).getByRole("button", { name: "协作" })).toHaveAttribute("aria-current", "page");
      expect(within(screen.getByRole("navigation", { name: "员工视图" })).getByRole("button", { name: "对话" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("region", { name: "上报中心" })).not.toBeInTheDocument();
      expect(bridge.sessions).toHaveBeenCalledWith("repo-owner");
      await waitFor(() =>
        expect(conversation.querySelector('[data-turn-id="turn-1"]')).toBeInTheDocument(),
      );
      expect(sessionTurnHistory).toHaveBeenCalledWith("conversation-1");
      expect(sessionTurnHistory).not.toHaveBeenCalledWith(activeSession.sessionId);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(visit));
      expect(scrollIntoView.mock.instances[visit - 1]).toBe(conversation.querySelector('[data-turn-id="turn-1"]'));
    }
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
    expect(await screen.findByRole("region", { name: "员工记忆" })).toBeInTheDocument();
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
  it("activates employee memory and browses that position's documents end-to-end", async () => {
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

    // Ant Design replaces the button when its variant changes from text to primary.
    const docsEntry = () => within(screen.getByRole("navigation", { name: "员工视图" })).getByRole("button", { name: "记忆" });
    expect(docsEntry()).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(docsEntry());
    expect(docsEntry()).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("navigation", { name: "模块" })).getByRole("button", { name: "协作" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("region", { name: "员工记忆" })).toBeInTheDocument();
    await waitFor(() => expect(positionDocs).toHaveBeenCalledWith("repo-owner"));

    fireEvent.click(await screen.findByRole("button", { name: "handbook.md" }));
    expect(await screen.findByRole("heading", { name: "Handbook" })).toBeInTheDocument();
    expect(screen.getByText("正文内容")).toBeInTheDocument();
    expect(within(screen.getByRole("toolbar", { name: "文档工具栏" })).getByRole("status")).toHaveTextContent("绑定期间只读");
    expect(positionDocFile).toHaveBeenCalledWith("repo-owner", "handbook.md");
  });
});

it("runs A/B/C independently and keeps late responses, streams and cancellation in their own sessions", async () => {
  const ids = ["repo-owner", "docs-writer", "release-engineer"];
  const employees = Object.fromEntries(ids.map((id, index) => [id, {
    ...activeSession, positionId: id, sessionId: `${index + 1}1111111-1111-4111-8111-111111111111`,
  }]));
  const tree = { ...snapshot, positionCount: 3, tree: [{ ...snapshot.tree[0]!, children: ids.slice(1).map((id) => ({ id, reportTo: "repo-owner", budget: snapshot.tree[0]!.budget, children: [] })) }] };
  const completed = new Map<string, TurnRecord[]>();
  const finish = new Map<string, (value: unknown) => void>();
  let listener: (value: unknown) => void = () => {};
  const createSessionTurn = vi.fn(({ sessionId }: { sessionId: string }) => new Promise((resolve) => finish.set(sessionId, resolve)));
  const cancelTurn = vi.fn().mockResolvedValue({ status: 200, body: {} });
  const bridge = openedBridge({
    orgTree: vi.fn().mockResolvedValue({ status: 200, body: tree }),
    position: vi.fn(async (id: string) => ({ status: 200, body: { position: { ...position, id, name: id }, agentEngine: "qoder" } })),
    sessions: vi.fn(async (id: string) => ({ status: 200, body: { schemaVersion: "workbench-session-list.v1", positionId: id, activeSessionId: employees[id]!.sessionId, sessions: [employees[id]!] } })),
    sessionTurnHistory: vi.fn(async (sessionId: string) => ({ status: 200, body: history(completed.get(sessionId) ?? []) })),
    createSessionTurn, cancelTurn,
    onEvent: vi.fn((callback) => { listener = callback; return () => {}; }),
  });
  render(<App />);
  const choose = async (id: string) => {
    const treeElement = await screen.findByRole("tree");
    fireEvent.click(treeElement.querySelector(`[data-org-node-id="${id}"]`)!);
    await waitFor(() => expect(bridge.sessions).toHaveBeenCalledWith(id));
  };
  for (const [index, id] of ids.entries()) {
    await choose(id);
    await waitFor(() => expect(screen.getByLabelText("下达任务")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: `task-${id}` } });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
    await waitFor(() => expect(createSessionTurn).toHaveBeenCalledTimes(index + 1));
  }
  act(() => ids.forEach((id, index) => listener({ seq: index + 1, type: "turn.model.delta", payload: {
    positionId: id, sessionId: employees[id]!.sessionId, engine: "qoder", runId: `run-${id}`, text: `live-${id}`,
  } })));
  expect(await screen.findByText("live-release-engineer")).toBeInTheDocument();
  expect(screen.queryByText("live-repo-owner")).not.toBeInTheDocument();
  const resultA = apiTurn({ turnId: "A", runId: "run-repo-owner", input: "task-repo-owner", output: "A final result" });
  completed.set(employees[ids[0]!]!.sessionId, [resultA]);
  await act(async () => finish.get(employees[ids[0]!]!.sessionId)!({ status: 200, body: resultA }));
  expect(screen.queryByText("A final result")).not.toBeInTheDocument();
  expect(screen.getByText("live-release-engineer")).toBeInTheDocument();
  await choose("docs-writer");
  expect(await screen.findByText("live-docs-writer")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "中断回合" }));
  await waitFor(() => expect(cancelTurn).toHaveBeenCalledWith({ positionId: "docs-writer", workspacePath: "/fixture/workspace" }));
  await act(async () => finish.get(employees["docs-writer"]!.sessionId)!({ status: 500, body: { message: "B failed" } }));
  await choose("repo-owner");
  expect(await screen.findByText("A final result")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("下达任务")).toBeEnabled());
  await choose("release-engineer");
  expect(await screen.findByText("live-release-engineer")).toBeInTheDocument();
  expect(screen.queryByText("B failed")).not.toBeInTheDocument();
  await act(async () => finish.get(employees["release-engineer"]!.sessionId)!({ status: 500, body: { message: "C failed" } }));
  // Three simultaneous turns, six employee selections, streamed updates and
  // cancellation share one test budget. Keep each wait/assertion unchanged;
  // slower CI workers need more than the default five seconds for the full flow.
}, 10_000);

it("#413 keeps employee A's card and thread while B's position fetch is in flight", async () => {
  const tree = {
    ...snapshot,
    positionCount: 2,
    tree: [{
      ...snapshot.tree[0]!,
      children: [{ id: "docs-writer", reportTo: "repo-owner", budget: snapshot.tree[0]!.budget, children: [] }],
    }],
  };
  const employeeB = { ...activeSession, positionId: "docs-writer", sessionId: "22222222-2222-4222-8222-222222222222" };
  let holdB = false;
  let finishB!: (value: Awaited<ReturnType<OwbBridge["position"]>>) => void;
  const positionRead = vi.fn((id: string) => {
    if (id === "docs-writer" && holdB) {
      return new Promise<Awaited<ReturnType<OwbBridge["position"]>>>((resolve) => { finishB = resolve; });
    }
    return Promise.resolve({ status: 200, body: { position: { ...position, id, name: id === "repo-owner" ? "代码库负责人" : id }, agentEngine: "qoder" } });
  });
  openedBridge({
    orgTree: vi.fn().mockResolvedValue({ status: 200, body: tree }),
    position: positionRead,
    sessions: vi.fn(async (id: string) => ({
      status: 200,
      body: {
        schemaVersion: "workbench-session-list.v1",
        positionId: id,
        activeSessionId: id === "docs-writer" ? employeeB.sessionId : activeSession.sessionId,
        sessions: id === "docs-writer" ? [employeeB] : [activeSession],
      },
    })),
    sessionTurnHistory: vi.fn(async (sessionId: string) => ({
      status: 200,
      body: history([apiTurn({
        conversationId: sessionId,
        positionId: sessionId === employeeB.sessionId ? "docs-writer" : "repo-owner",
        turnId: sessionId === employeeB.sessionId ? "turn-b" : "turn-a",
        input: sessionId === employeeB.sessionId ? "B 的任务" : "历史任务",
        output: sessionId === employeeB.sessionId ? "B 的结果" : "历史结果",
      })]),
    })),
  });
  render(<App />);
  const choose = async (id: string) => {
    fireEvent.click((await screen.findByRole("tree")).querySelector(`[data-org-node-id="${id}"]`)!);
  };
  await choose("repo-owner");
  expect(await screen.findByText("历史结果")).toBeVisible();
  selectEmployeeView("档案");
  const card = () => within(screen.getByRole("region", { name: "岗位档案" }));
  expect(await card().findByRole("heading", { name: "代码库负责人" })).toBeVisible();

  holdB = true;
  await choose("docs-writer");
  expect(card().getByRole("heading", { name: "代码库负责人" })).toBeVisible();
  expect(document.querySelector(".ui-org-position-card__skeleton-title")).toBeNull();
  expect(screen.queryByRole("region", { name: "岗位对话" })).not.toBeInTheDocument();
  selectEmployeeView("对话");
  expect(within(screen.getByRole("region", { name: "岗位对话" })).getByText("历史结果")).toBeVisible();
  expect(document.querySelector(".owb-turn-thread--loading")).toBeNull();
  selectEmployeeView("档案");

  await act(async () => finishB({
    status: 200,
    body: { position: { ...position, id: "docs-writer", name: "文档负责人" }, agentEngine: "qoder" },
  }));
  expect(await card().findByRole("heading", { name: "文档负责人" })).toBeVisible();
  selectEmployeeView("对话");
  const conversation = within(screen.getByRole("region", { name: "岗位对话" }));
  expect(await conversation.findByText("B 的结果")).toBeVisible();
  expect(conversation.queryByText("历史结果")).not.toBeInTheDocument();
});

it("#420 does not dismiss B under A's name while B's position fetch is in flight", async () => {
  const tree = {
    ...snapshot,
    positionCount: 2,
    tree: [{
      ...snapshot.tree[0]!,
      children: [{ id: "docs-writer", reportTo: "repo-owner", budget: snapshot.tree[0]!.budget, children: [] }],
    }],
  };
  const employeeB = { ...activeSession, positionId: "docs-writer", sessionId: "22222222-2222-4222-8222-222222222222" };
  let holdB = false;
  let finishB!: (value: Awaited<ReturnType<OwbBridge["position"]>>) => void;
  const orgApply = vi.fn().mockResolvedValue({ status: 200, body: { status: "applied" } });
  openedBridge({
    orgTree: vi.fn().mockResolvedValue({ status: 200, body: tree }),
    orgApply,
    position: vi.fn((id: string) => {
      if (id === "docs-writer" && holdB) {
        return new Promise<Awaited<ReturnType<OwbBridge["position"]>>>((resolve) => { finishB = resolve; });
      }
      return Promise.resolve({ status: 200, body: { position: { ...position, id, name: id === "repo-owner" ? "代码库负责人" : id }, agentEngine: "qoder" } });
    }),
    sessions: vi.fn(async (id: string) => ({
      status: 200,
      body: {
        schemaVersion: "workbench-session-list.v1",
        positionId: id,
        activeSessionId: id === "docs-writer" ? employeeB.sessionId : activeSession.sessionId,
        sessions: id === "docs-writer" ? [employeeB] : [activeSession],
      },
    })),
    sessionTurnHistory: vi.fn(async (sessionId: string) => ({
      status: 200,
      body: history([apiTurn({
        conversationId: sessionId,
        positionId: sessionId === employeeB.sessionId ? "docs-writer" : "repo-owner",
        output: sessionId === employeeB.sessionId ? "B 的结果" : "历史结果",
      })]),
    })),
  });
  render(<App />);
  const choose = async (id: string) => {
    fireEvent.click((await screen.findByRole("tree")).querySelector(`[data-org-node-id="${id}"]`)!);
  };
  const card = () => screen.getByRole("region", { name: "岗位档案" });
  await choose("repo-owner");
  expect(await screen.findByText("历史结果")).toBeVisible();
  selectEmployeeView("档案");
  expect(await within(card()).findByRole("heading", { name: "代码库负责人" })).toBeVisible();
  expect(within(card()).getByRole("button", { name: "编辑" })).toBeInTheDocument();
  expect(within(card()).queryByRole("button", { name: "裁撤" })).toBeNull();

  holdB = true;
  await choose("docs-writer");
  expect(within(card()).getByRole("heading", { name: "代码库负责人" })).toBeVisible();
  expect(within(card()).queryByRole("button", { name: "裁撤" })).toBeNull();
  expect(within(card()).queryByRole("button", { name: "编辑" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "确认裁撤 代码库负责人" })).toBeNull();

  await act(async () => finishB({
    status: 200,
    body: { position: { ...position, id: "docs-writer", name: "文档负责人" }, agentEngine: "qoder" },
  }));
  expect(await within(card()).findByRole("heading", { name: "文档负责人" })).toBeVisible();
  selectEmployeeView("对话");
  const conversation = within(screen.getByRole("region", { name: "岗位对话" }));
  expect(await conversation.findByText("B 的结果")).toBeVisible();
  expect(conversation.queryByText("历史结果")).not.toBeInTheDocument();
  selectEmployeeView("档案");
  fireEvent.click(within(card()).getByRole("button", { name: "裁撤" }));
  expect(screen.getByRole("heading", { name: "确认裁撤 文档负责人" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "确认裁撤并留痕" }));
  await waitFor(() => expect(orgApply).toHaveBeenCalledWith({
    schemaVersion: "change-manifest.v1",
    changes: [{ op: "delete", id: "docs-writer" }],
  }));
});

it("#413 clears employee A's thread once B is confirmed to have no session", async () => {
  const tree = {
    ...snapshot,
    positionCount: 2,
    tree: [{
      ...snapshot.tree[0]!,
      children: [{ id: "docs-writer", reportTo: "repo-owner", budget: snapshot.tree[0]!.budget, children: [] }],
    }],
  };
  openedBridge({
    orgTree: vi.fn().mockResolvedValue({ status: 200, body: tree }),
    position: vi.fn(async (id: string) => ({
      status: 200,
      body: { position: { ...position, id, name: id === "repo-owner" ? "代码库负责人" : "文档负责人" }, agentEngine: "qoder" },
    })),
    sessions: vi.fn(async (id: string) => ({
      status: 200,
      body: {
        schemaVersion: "workbench-session-list.v1",
        positionId: id,
        activeSessionId: id === "docs-writer" ? null : activeSession.sessionId,
        sessions: id === "docs-writer" ? [] : [activeSession],
      },
    })),
    createSession: vi.fn(() => new Promise(() => { /* attach stays open so a stale thread cannot hide behind create */ })),
    sessionTurnHistory: vi.fn(async (sessionId: string) => ({
      status: 200,
      body: history([apiTurn({ conversationId: sessionId, output: "历史结果" })]),
    })),
  });
  render(<App />);
  const choose = async (id: string) => {
    fireEvent.click((await screen.findByRole("tree")).querySelector(`[data-org-node-id="${id}"]`)!);
  };
  await choose("repo-owner");
  expect(await screen.findByText("历史结果")).toBeInTheDocument();
  selectEmployeeView("档案");

  await choose("docs-writer");
  expect(await within(screen.getByRole("region", { name: "岗位档案" })).findByRole("heading", { name: "文档负责人" })).toBeVisible();
  selectEmployeeView("对话");
  await waitFor(() => expect(within(screen.getByRole("region", { name: "岗位对话" })).queryByText("历史结果")).not.toBeInTheDocument());
});

it("keeps B usable during A's delayed automatic session creation, then restores A", async () => {
  const employeeB = { ...activeSession, positionId: "docs-writer", sessionId: "22222222-2222-4222-8222-222222222222" };
  const tree = { ...snapshot, positionCount: 2, tree: [{ ...snapshot.tree[0]!, children: [{ id: "docs-writer", reportTo: "repo-owner", budget: snapshot.tree[0]!.budget, children: [] }] }] };
  let created = false;
  let resolveCreate: (value: unknown) => void = () => {};
  const bridge = openedBridge({
    orgTree: vi.fn().mockResolvedValue({ status: 200, body: tree }),
    position: vi.fn(async (id: string) => ({ status: 200, body: { position: { ...position, id, name: id }, agentEngine: "qoder" } })),
    sessions: vi.fn(async (id: string) => ({ status: 200, body: { schemaVersion: "workbench-session-list.v1", positionId: id,
      activeSessionId: id === "docs-writer" ? employeeB.sessionId : created ? activeSession.sessionId : null,
      sessions: id === "docs-writer" ? [employeeB] : created ? [activeSession] : [] } })),
    createSession: vi.fn(() => new Promise((resolve) => { resolveCreate = resolve; })),
  });
  render(<App />);
  const choose = async (id: string) => {
    fireEvent.click((await screen.findByRole("tree")).querySelector(`[data-org-node-id="${id}"]`)!);
  };
  await choose("repo-owner");
  await waitFor(() => expect(bridge.createSession).toHaveBeenCalled());
  await choose("docs-writer");
  await waitFor(() => expect(screen.getByLabelText("下达任务")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "B stays intact" } });
  created = true;
  await act(async () => resolveCreate({ status: 201, body: activeSession }));
  expect(screen.getByLabelText("下达任务")).toHaveValue("B stays intact");
  expect(screen.getByLabelText("下达任务")).toBeEnabled();
  await choose("repo-owner");
  await waitFor(() => expect(screen.getByLabelText("下达任务")).toBeEnabled());
  expect(screen.queryByRole("switch", { name: "启用会话上下文" })).not.toBeInTheDocument();
  await choose("docs-writer");
  await waitFor(() => expect(screen.getByLabelText("下达任务")).toBeEnabled());
  await choose("repo-owner");
  await waitFor(() => expect(screen.getByLabelText("下达任务")).toBeEnabled());
  expect(screen.queryByRole("switch", { name: "启用会话上下文" })).not.toBeInTheDocument();
});

it("drops workspace A's late group 202 after switching to B and reloads A on return", async () => {
  let workspace = "A";
  let resolveOldDispatch: (value: unknown) => void = () => {};
  let aCompleted = false;
  const groupA = { schemaVersion: "conversation-group.v1" as const, conversationRef: "workspace-a-group", sessionId: "group-session-a", members: ["repo-owner"], createdAt: activeSession.createdAt, updatedAt: activeSession.createdAt };
  const groupB = { ...groupA, conversationRef: "workspace-b-group", sessionId: "group-session-b" };
  const bridge = openedBridge({
    workspace: vi.fn(async () => ({ status: 200, body: { open: true, path: `/workspace/${workspace}`, business: `Workspace ${workspace}` } })),
    groups: vi.fn(async () => ({ status: 200, body: { schemaVersion: "conversation-group-list.v1", groups: [workspace === "A" ? groupA : groupB] } })),
    groupTimeline: vi.fn(async (ref: string) => ({ status: 200, body: { schemaVersion: "group-timeline.v1", conversationRef: ref, items:
      ref === groupA.conversationRef && aCompleted ? [{ kind: "member", turn: apiTurn({ conversationRef: ref, groupRef: ref, output: "A restored from disk" }) }] : [] } })),
    createGroupTurn: vi.fn(() => new Promise((resolve) => { resolveOldDispatch = resolve; })),
  });
  // Navigation/read fixtures resolve immediately; flush their promise chain
  // instead of polling the full animated App DOM for each transition.
  await act(async () => { render(<App />); });
  const projectEntry = screen.getByRole("button", { name: "项目入口" });
  const groupEntry = within(screen.getByRole("navigation", { name: "协作方式" })).getByRole("button", { name: "群聊" });
  const organizationEntry = screen.getByRole("button", { name: "组织" });
  await act(async () => { fireEvent.click(groupEntry); });
  const composer = screen.getByLabelText("群聊消息");
  pickSelectOption("选择要 @ 的成员", "代码库负责人");
  fireEvent.change(composer, { target: { value: "A pending task" } });
  const sendButton = within(composer.closest("form")!).getByRole("button", { name: "发送群消息" });
  await act(async () => { fireEvent.click(sendButton); });
  expect(bridge.createGroupTurn).toHaveBeenCalledTimes(1);
  const switchWorkspace = async (next: string) => {
    const previousLoads = vi.mocked(bridge.groupTimeline).mock.calls.length;
    workspace = next;
    await chooseExistingWorkspace();
    expect(projectEntry).toHaveTextContent(`Workspace ${next}`);
    expect(vi.mocked(bridge.groupTimeline).mock.calls.slice(previousLoads)).toContainEqual([
      next === "A" ? groupA.conversationRef : groupB.conversationRef,
    ]);
  };
  await switchWorkspace("B");
  expect(bridge.groupTimeline).toHaveBeenCalledWith(groupB.conversationRef);
  expect(screen.getByLabelText("群聊消息")).toHaveValue("");
  expect(screen.getByLabelText("群聊消息")).toBeEnabled();
  expect(screen.getByRole("button", { name: "发送群消息" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("群聊消息"), { target: { value: "B clean draft" } });
  await act(async () => resolveOldDispatch({ status: 202, body: { conversationRef: groupA.conversationRef, messageId: "old-A", spawns: [{ turnId: "old-A-turn", positionId: "repo-owner" }] } }));
  expect(screen.getByLabelText("群聊消息")).toHaveValue("B clean draft");
  expect(screen.queryByText("A pending task")).not.toBeInTheDocument();
  await act(async () => { fireEvent.click(organizationEntry); });
  const row = screen.getByRole("tree").querySelector('[data-org-node-id="repo-owner"]');
  expect(row).not.toBeNull();
  await act(async () => { fireEvent.click(row!); });
  expect(screen.getByRole("region", { name: "岗位对话" })).toBeInTheDocument();
  expect(screen.getByLabelText("下达任务")).toBeEnabled();
  await act(async () => { fireEvent.click(groupEntry); });
  aCompleted = true;
  await switchWorkspace("A");
  expect(screen.getByText("A restored from disk")).toBeInTheDocument();
  expect(screen.getByLabelText("群聊消息")).toHaveValue("");
}, 15_000);

it("restores the original workspace's running task and cancels its exact owner after navigation", async () => {
  let workspace = "A";
  let listener: (value: unknown) => void = () => {};
  const finish = new Map<string, (value: unknown) => void>();
  const sessionLoads: Array<[string, string]> = [];
  const sessions = vi.fn(async (positionId: string) => {
    sessionLoads.push([workspace, positionId]);
    return { status: 200, body: { schemaVersion: "workbench-session-list.v1", positionId, activeSessionId: activeSession.sessionId, sessions: [activeSession] } };
  });
  const cancelTurn = vi.fn().mockResolvedValue({ status: 200, body: { cancelled: true, positionId: "repo-owner" } });
  openedBridge({
    workspace: vi.fn(async () => ({ status: 200, body: { open: true, path: `/workspace/${workspace}`, business: `Workspace ${workspace}` } })),
    sessions,
    createSessionTurn: vi.fn(() => new Promise((resolve) => finish.set(workspace, resolve))),
    cancelTurn,
    onEvent: vi.fn((callback) => { listener = callback; return () => {}; }),
  });
  // Every navigation/read fixture resolves immediately. Flush that microtask
  // chain explicitly instead of repeatedly polling the full animated App DOM.
  await act(async () => { render(<App />); });
  const projectEntry = screen.getByRole("button", { name: "项目入口" });
  const row = screen.getByRole("tree").querySelector('[data-org-node-id="repo-owner"]');
  expect(row).not.toBeNull();
  await act(async () => { fireEvent.click(row!); });
  expect(screen.getByRole("region", { name: "岗位对话" })).toBeInTheDocument();
  const send = async (input: string) => {
    const composer = screen.getByLabelText("下达任务");
    expect(composer).toBeEnabled();
    fireEvent.change(composer, { target: { value: input } });
    const sendButton = within(composer.closest("form")!).getByRole("button", { name: "发送任务" });
    await act(async () => { fireEvent.click(sendButton); });
    expect(finish.has(workspace)).toBe(true);
  };
  const navigate = async (next: string) => {
    const previousLoads = sessionLoads.length;
    workspace = next;
    await chooseExistingWorkspace();
    expect(projectEntry).toHaveTextContent(`Workspace ${next}`);
    expect(sessionLoads.length).toBeGreaterThan(previousLoads);
    expect(sessionLoads.at(-1)).toEqual([next, "repo-owner"]);
  };
  await send("A background task");
  const event = (seq: number, owner: string, text: string) => ({ seq, type: "turn.model.delta", payload: {
    workspacePath: `/workspace/${owner}`, positionId: "repo-owner", sessionId: activeSession.sessionId,
    engine: "qoder", runId: "same-engine-run-id", turnId: owner === "A" ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", text,
  } });
  act(() => listener(event(1, "A", "A live output")));
  expect(screen.getByText("A live output")).toBeInTheDocument();
  await navigate("B");
  await send("B independent task");
  act(() => {
    listener(event(2, "B", "B live output"));
    listener(event(3, "A", " continues"));
  });
  expect(screen.getByText("B live output")).toBeInTheDocument();
  expect(screen.queryByText(/A live output/)).not.toBeInTheDocument();
  await navigate("A");
  expect(screen.getByText("A live output continues")).toBeInTheDocument();
  const cancelButton = screen.getByRole("button", { name: "中断回合" });
  await act(async () => { fireEvent.click(cancelButton); });
  expect(cancelTurn).toHaveBeenCalledWith({ positionId: "repo-owner", workspacePath: "/workspace/A", turnId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  await act(async () => finish.get("A")!({ status: 500, body: { message: "A cancelled" } }));
  await navigate("B");
  expect(screen.getByText("B live output")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "中断回合" })).toBeEnabled();
  await act(async () => finish.get("B")!({ status: 500, body: { message: "B completed" } }));
}, 15_000);


it("keeps the hire conversation timeout attached to the workspace where it started", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const cancelTurn = vi.fn().mockResolvedValue({ status: 200, body: { cancelled: true, positionId: "repo-owner" } });
  let finish: (value: unknown) => void = () => {};
  openedBridge({ cancelTurn, createTurn: vi.fn(() => new Promise((resolve) => { finish = resolve; })) });
  const props = { open: true, positions: [{ id: "repo-owner", name: "Owner" }], presetReportTo: null,
    engine: "qoder" as const, engineAvailability: { qoder: { ready: true, configured: true }, "claude-code": { ready: false, configured: false }, "claude-local": { ready: false, configured: false }, codex: { ready: false, configured: false }, "codex-local": { ready: false, configured: false } },
    conversationHostId: "repo-owner", onClose: vi.fn(), onHired: vi.fn() };
  const view = render(<HireDrawer {...props} workspacePath="/workspace/A" />);
  try {
    fireEvent.click(screen.getByRole("button", { name: "让 Agent 生成草案" }));
    view.rerender(<HireDrawer {...props} workspacePath="/workspace/B" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(75_000); });
    expect(cancelTurn).toHaveBeenCalledExactlyOnceWith({ positionId: "repo-owner", workspacePath: "/workspace/A" });
    await act(async () => finish({ status: 500, body: {} }));
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it.each(["B", "A"])("ignores A proposal after workspace navigation ends in %s", async (destination) => {
  let finish: (value: unknown) => void = () => {};
  openedBridge({ createTurn: vi.fn(() => new Promise((resolve) => { finish = resolve; })) });
  const props = { open: true, positions: [{ id: "repo-owner", name: "Owner" }], presetReportTo: null,
    engine: "qoder" as const, engineAvailability: { qoder: { ready: true, configured: true }, "claude-code": { ready: false, configured: false }, "claude-local": { ready: false, configured: false }, codex: { ready: false, configured: false }, "codex-local": { ready: false, configured: false } },
    conversationHostId: "repo-owner", onClose: vi.fn(), onHired: vi.fn() };
  const view = render(<HireDrawer {...props} workspacePath="/workspace/A" />);
  fireEvent.click(screen.getByRole("button", { name: "让 Agent 生成草案" }));
  view.rerender(<HireDrawer {...props} workspacePath="/workspace/B" />);
  if (destination === "A") view.rerender(<HireDrawer {...props} workspacePath="/workspace/A" />);
  await act(async () => finish({ status: 200, body: { output: JSON.stringify({ name: "Workspace A Secret", description: "Proposal from the prior workspace" }) } }));
  expect(screen.queryByDisplayValue("Workspace A Secret")).not.toBeInTheDocument();
});

it.each(["history", "sessions"])("ignores A %s rejection after opening B with the same session identity", async (kind) => {
  let workspace = "A";
  let rejectA: (value: unknown) => void = () => {};
  const readMock = vi.fn(() => workspace === "A" ? new Promise((_resolve, reject) => { rejectA = reject; }) : Promise.resolve({ status: 200, body: kind === "history" ? history([]) : { schemaVersion: "workbench-session-list.v1", positionId: "repo-owner", activeSessionId: activeSession.sessionId, sessions: [activeSession] } }));
  openedBridge({ workspace: vi.fn(async () => ({ status: 200, body: { open: true, path: `/workspace/${workspace}`, business: `Workspace ${workspace}` } })), ...(kind === "history" ? { sessionTurnHistory: readMock } : { sessions: readMock }) });
  render(<App />);
  await selectRepoOwner();
  await waitFor(() => expect(readMock).toHaveBeenCalled());
  workspace = "B";
  await chooseExistingWorkspace();
  await waitFor(() => expect(screen.getByRole("button", { name: "项目入口" })).toHaveTextContent("Workspace B"));
  await waitFor(() => expect(screen.getByLabelText("下达任务")).toBeEnabled());
  await act(async () => rejectA(new Error("old A history request failure")));
  expect(screen.queryByText(kind === "history" ? "本地历史读取失败：本地服务不可用" : "会话列表读取失败：本地服务不可用")).not.toBeInTheDocument();
});

it("preserves the actual composer, draft and selected session across organization graph navigation", async () => {
  const bridge = openedBridge({ sessionTurnHistory: vi.fn().mockResolvedValue({ status: 200, body: {
    ...history([apiTurn({ conversationId: activeSession.sessionId })]), conversationId: activeSession.sessionId,
  } }) });
  const { container } = render(<App />);
  await selectRepoOwner();
  const conversation = screen.getByRole("region", { name: "岗位对话" });
  const input = within(conversation).getByRole("textbox", { name: "下达任务" });
  await waitFor(() => expect(input).toBeEnabled());
  expect(await within(conversation).findByText("历史结果")).toBeVisible();
  fireEvent.change(input, { target: { value: "draft stays with this employee" } });
  const sessionReads = vi.mocked(bridge.sessions).mock.calls.length;
  expect(container.querySelector(".owb-org-chart")).toBeNull();
  expect(screen.queryByRole("button", { name: "3D 星图", exact: true })).not.toBeInTheDocument();
  const rail = within(screen.getByRole("navigation", { name: "模块" }));
  const openGraph = () => {
    fireEvent.click(rail.getByRole("button", { name: "组织" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "组织视图" })).getByRole("button", { name: "关系图谱" }));
  };
  const expectConversation = () => {
    expect(screen.getByRole("region", { name: "岗位对话" })).toBe(conversation);
    expect(screen.getByRole("textbox", { name: "下达任务" })).toBe(input);
    expect(input).toBeVisible();
    expect(input).toHaveValue("draft stays with this employee");
    expect(within(conversation).getByText("历史结果")).toBeVisible();
    expect(rail.getByRole("button", { name: "协作" })).toHaveAttribute("aria-current", "page");
    expect(within(screen.getByRole("navigation", { name: "员工视图" })).getByRole("button", { name: "对话" })).toHaveAttribute("aria-pressed", "true");
  };

  fireEvent.click(screen.getByRole("button", { name: "上下文详情", exact: true }));
  await waitFor(() => expect(screen.getByText("携带会话历史")).toBeVisible());
  // Keyboard activation does not produce the outside mousedown that normally closes a portal.
  rail.getByRole("button", { name: "组织" }).focus();
  openGraph();
  await waitFor(() => expect(screen.queryByText("携带会话历史")).not.toBeInTheDocument());
  expect(screen.getByRole("region", { name: "关系图谱" })).toBeVisible();
  expect(input).toBeInTheDocument();
  expect(input).not.toBeVisible();
  expect(conversation.closest(".owb-module-pane")).toHaveAttribute("hidden");
  expect(screen.queryByRole("button", { name: "折叠组织图" })).not.toBeInTheDocument();
  fireEvent.click(rail.getByRole("button", { name: "协作" }));
  expectConversation();
  expect(bridge.sessions).toHaveBeenCalledTimes(sessionReads);
  expect(bridge.sessionTurnHistory).toHaveBeenLastCalledWith(activeSession.sessionId);

  openGraph();
  fireEvent.click(await within(screen.getByRole("list", { name: "对象" })).findByRole("button", { name: /Repo Owner/ }));
  expect(input).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "打开员工工作台" }));
  await waitFor(expectConversation);
  expect(bridge.createSessionTurn).not.toHaveBeenCalled();
  expect(bridge.createSession).not.toHaveBeenCalled();

  const structure = await openOrganizationStructure();
  fireEvent.click(within(structure).getByRole("tree").querySelector('[data-org-node-id="repo-owner"]')!);
  await waitFor(expectConversation);
  expect(screen.queryByRole("region", { name: "关系图谱" })).not.toBeInTheDocument();
  fireEvent.click(within(conversation).getByRole("button", { name: "发送任务" }));
  await waitFor(() => expect(bridge.createSessionTurn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    sessionId: activeSession.sessionId, input: "draft stays with this employee",
  })));
}, 15_000);

it("returns to the conversation through collaboration after leaving organization and inbox", async () => {
  openedBridge();
  const { container } = render(<App />);
  await selectRepoOwner();
  const composer = screen.getByRole("textbox", { name: "下达任务" });
  await openOrganizationStructure();
  fireEvent.click(within(screen.getByRole("navigation", { name: "组织视图" })).getByRole("button", { name: "关系图谱" }));
  await openInbox();
  fireEvent.click(within(screen.getByRole("navigation", { name: "模块" })).getByRole("button", { name: "协作" }));
  expect(container.querySelector(".owb-org-chart")).toBeNull();
  expect(within(screen.getByRole("navigation", { name: "员工视图" })).getByRole("button", { name: "对话" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("textbox", { name: "下达任务" })).toBe(composer);
  expect(composer).toBeVisible();
});

it("rechecks health without rebuilding the workspace or losing the selected conversation draft", async () => {
  const bridge = openedBridge();
  const ready = await bridge.status();
  const unavailable = { ...ready, health: { ...ready.health!, engine: { ...ready.health!.engine, available: false, nextStep: "RAW_ENGINE_PATH" } } };
  vi.mocked(bridge.status).mockReset().mockResolvedValue(unavailable);
  await act(async () => { render(<App />); });
  await selectRepoOwner();
  const input = await screen.findByLabelText("下达任务");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: "keep the actual draft" } });
  const treeReads = vi.mocked(bridge.orgTree).mock.calls.length;
  const workspaceReads = vi.mocked(bridge.workspace).mock.calls.length;
  const sessionReads = vi.mocked(bridge.sessions).mock.calls.length;
  let finish!: (value: Awaited<ReturnType<OwbBridge["status"]>>) => void;
  vi.mocked(bridge.status).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const recheck = screen.getByRole("button", { name: "重新检查" });
  fireEvent.click(recheck);
  fireEvent.click(recheck);
  expect(screen.getByRole("button", { name: "检查中…" })).toBeDisabled();
  expect(bridge.status).toHaveBeenCalledTimes(2);
  expect(document.body.innerHTML).not.toContain("RAW_ENGINE_PATH");
  await act(async () => finish(ready));
  expect(screen.queryByRole("button", { name: "重新检查" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("下达任务")).toBe(input);
  expect(input).toHaveValue("keep the actual draft");
  expect(input).toBeEnabled();
  expect(bridge.orgTree).toHaveBeenCalledTimes(treeReads);
  expect(bridge.workspace).toHaveBeenCalledTimes(workspaceReads);
  expect(bridge.sessions).toHaveBeenCalledTimes(sessionReads);
  expect(bridge.createSessionTurn).not.toHaveBeenCalled();
});

it.each(["valid", "legacy"] as const)("refreshes an invalid cached model connection after a %s position read", async mode => {
  const modelConfig = { selected: "provider-default", recommended: "provider-default", editable: true, source: "local-config", options: [],
    connection: { source: "local-config", kind: "gateway", billing: "unknown", status: "invalid", message: "RAW_CONFIG_ERROR" } };
  const bridge = openedBridge({ position: vi.fn().mockResolvedValue({ status: 200, body: { position, agentEngine: "qoder", modelConfig } }) });
  await act(async () => { render(<App />); });
  await selectRepoOwner();
  expect(await screen.findByText("模型连接需要检查。")).toBeVisible();
  expect(screen.getByLabelText("下达任务")).toBeDisabled();
  expect(document.body.innerHTML).not.toContain("RAW_CONFIG_ERROR");
  vi.mocked(bridge.position).mockResolvedValue({ status: 200, body: { position, agentEngine: "qoder", ...(mode === "valid" ? { modelConfig: { ...modelConfig, connection: { ...modelConfig.connection, status: "valid", message: undefined } } } : {}) } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "重新检查" })));
  expect(screen.getByLabelText("下达任务")).toBeEnabled();
  expect(screen.queryByText("模型连接需要检查。")).not.toBeInTheDocument();
});

it.each(["offline", "missing-health", "degraded", "position-failed"])("keeps availability guards and reports a short recheck failure for %s", async failure => {
  const bridge = openedBridge();
  const ready = await bridge.status();
  const unavailable = { ...ready, health: { ...ready.health!, hosts: { ...ready.health!.hosts!, qoder: { configured: true, ready: false, nextStep: "RAW_PATH" } } } };
  vi.mocked(bridge.status).mockReset().mockResolvedValue(unavailable);
  await act(async () => { render(<App />); });
  await selectRepoOwner();
  await screen.findByText("Qoder 暂时无法使用。");
  if (failure === "offline") vi.mocked(bridge.status).mockRejectedValueOnce(new Error("PRIVATE_PATH"));
  if (failure === "missing-health") vi.mocked(bridge.status).mockResolvedValueOnce({ running: true });
  if (failure === "degraded") vi.mocked(bridge.status).mockResolvedValueOnce({ ...ready, health: { ...ready.health!, status: "degraded" } });
  if (failure === "position-failed") {
    vi.mocked(bridge.status).mockResolvedValueOnce(ready);
    vi.mocked(bridge.position).mockResolvedValueOnce({ status: 503, body: {} });
  }
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "重新检查" })));
  expect(screen.getByText("检查失败，请重试")).toBeVisible();
  expect(screen.getByLabelText("下达任务")).toBeDisabled();
  expect(document.body.innerHTML).not.toMatch(/RAW_PATH|PRIVATE_PATH/);
  expect(bridge.createSessionTurn).not.toHaveBeenCalled();
});

it.each(["employee", "workspace"])("ignores a late availability response after changing %s", async change => {
  let workspace = "A";
  const second = { ...position, id: "writer", name: "文档员工" };
  const bridge = openedBridge({
    workspace: vi.fn(async () => ({ status: 200, body: { open: true, path: `/fixture/${workspace}`, business: workspace } })),
    orgTree: vi.fn().mockResolvedValue({ status: 200, body: { ...snapshot, tree: [...snapshot.tree, { ...snapshot.tree[0], id: "writer" }] } }),
    position: vi.fn(async id => ({ status: 200, body: { position: id === "writer" ? second : position, agentEngine: "qoder" } })),
  });
  const ready = await bridge.status();
  const unavailable = { ...ready, health: { ...ready.health!, hosts: { ...ready.health!.hosts!, qoder: { configured: true, ready: false, nextStep: "RAW_PATH" } } } };
  vi.mocked(bridge.status).mockReset().mockResolvedValue(unavailable);
  await act(async () => { render(<App />); });
  await selectRepoOwner();
  await screen.findByText("Qoder 暂时无法使用。");
  let finish!: (value: Awaited<ReturnType<OwbBridge["status"]>>) => void;
  vi.mocked(bridge.status).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
  if (change === "employee") {
    await act(async () => fireEvent.click(screen.getByRole("tree").querySelector('[data-org-node-id="writer"]')!));
  } else {
    workspace = "B";
    await chooseExistingWorkspace();
  }
  await act(async () => finish(ready));
  expect(screen.getByLabelText("下达任务")).toBeDisabled();
  expect(screen.getByText("Qoder 暂时无法使用。")).toBeVisible();
  expect(screen.queryByText("检查失败，请重试")).not.toBeInTheDocument();
  expect(bridge.createSessionTurn).not.toHaveBeenCalled();
});

it.each(["success", "failure"])("finishes an overlapping employee card read without restoring stale availability after recheck %s", async outcome => {
  const bridge = openedBridge();
  const ready = await bridge.status();
  const unavailable = { ...ready, health: { ...ready.health!, hosts: { ...ready.health!.hosts!, qoder: { configured: true, ready: false, nextStep: "RAW_PATH" } } } };
  vi.mocked(bridge.status).mockReset().mockResolvedValue(unavailable);
  await act(async () => { render(<App />); });
  let finishPosition!: (value: Awaited<ReturnType<OwbBridge["position"]>>) => void;
  vi.mocked(bridge.position).mockImplementationOnce(() => new Promise(resolve => { finishPosition = resolve; }));
  await selectRepoOwner();
  await screen.findByText("Qoder 暂时无法使用。");
  if (outcome === "success") vi.mocked(bridge.status).mockResolvedValueOnce(ready);
  else vi.mocked(bridge.status).mockRejectedValueOnce(new Error("check failed"));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "重新检查" })));
  await act(async () => finishPosition({ status: 200, body: { position, agentEngine: "claude-code", modelConfig: {
    selected: "provider-default", recommended: "provider-default", editable: true, source: "local-config", options: [],
    connection: { source: "local-config", kind: "gateway", billing: "unknown", status: "invalid", message: "STALE_CONFIG" },
  } } }));
  selectEmployeeView("档案");
  expect(within(screen.getByRole("region", { name: "岗位档案" })).getByText("负责开源仓库")).toBeVisible();
  selectEmployeeView("对话");
  expect(screen.queryByText("模型连接需要检查。")).not.toBeInTheDocument();
  expect(screen.queryByText("Claude Code 暂时无法使用。")).not.toBeInTheDocument();
  if (outcome === "success") expect(screen.getByLabelText("下达任务")).toBeEnabled();
  else expect(screen.getByLabelText("下达任务")).toBeDisabled();
});

it("does not let an older ordinary health refresh overwrite a newer availability check", async () => {
  let eventListener: (event: unknown) => void = () => {};
  const bridge = openedBridge({ onEvent: vi.fn(listener => { eventListener = listener; return () => {}; }) });
  const ready = await bridge.status();
  const unavailable = { ...ready, health: { ...ready.health!, hosts: { ...ready.health!.hosts!, qoder: { configured: true, ready: false, nextStep: "RAW_PATH" } } } };
  vi.mocked(bridge.status).mockReset().mockResolvedValue(unavailable);
  await act(async () => { render(<App />); });
  await selectRepoOwner();
  await screen.findByText("Qoder 暂时无法使用。");
  let finishRefresh!: (value: Awaited<ReturnType<OwbBridge["status"]>>) => void;
  vi.mocked(bridge.status).mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; })).mockResolvedValueOnce(ready);
  await act(async () => eventListener({ type: "org.updated", payload: { workspace: "/fixture/workspace", version: { seq: 8 }, changes: [] } }));
  expect(bridge.status).toHaveBeenCalledTimes(2);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "重新检查" })));
  expect(screen.getByLabelText("下达任务")).toBeEnabled();
  await act(async () => finishRefresh(unavailable));
  expect(screen.getByLabelText("下达任务")).toBeEnabled();
  expect(screen.queryByText("Qoder 暂时无法使用。")).not.toBeInTheDocument();
});

it("does not restore a pre-save model when a status check finishes after saving", async () => {
  const config = { selected: "provider-default", recommended: "provider-default", editable: true, source: "host-default", options: [
    { id: "provider-default", name: "Agent default", tier: "default" }, { id: "new-model", name: "New model", tier: "default" },
  ] };
  let finishSave!: (value: unknown) => void;
  const bridge = openedBridge({
    position: vi.fn().mockResolvedValue({ status: 200, body: { position, agentEngine: "qoder", modelConfig: config } }),
    setPositionModel: vi.fn(() => new Promise(resolve => { finishSave = resolve; })),
  });
  const ready = await bridge.status();
  const engineWarning = { ...ready, health: { ...ready.health!, engine: { ...ready.health!.engine, available: false } } };
  vi.mocked(bridge.status).mockReset().mockResolvedValue(engineWarning);
  await act(async () => { render(<App />); });
  await selectRepoOwner();
  await waitFor(() => expect(screen.getByRole("combobox", { name: "员工模型" })).toBeEnabled());
  pickSelectOption("员工模型", "New model");
  expect(bridge.setPositionModel).toHaveBeenCalledTimes(1);
  let finishCheck!: (value: Awaited<ReturnType<OwbBridge["status"]>>) => void;
  vi.mocked(bridge.status).mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
  await act(async () => finishSave({ status: 200, body: { ...config, selected: "new-model" } }));
  await act(async () => finishCheck(ready));
  const picker = screen.getByRole("combobox", { name: "员工模型" }).closest('.ant-select')!;
  expect(picker).toHaveTextContent("New model");
  expect(screen.queryByText("检查失败，请重试")).not.toBeInTheDocument();
});

it("keeps a failed model selection on the old value, exposes retry, and retains the employee session", async () => {
  const config = { selected: "provider-default", recommended: "provider-default", editable: true, source: "default", options: [
    { id: "provider-default", name: "Agent default", tier: "default" }, { id: "new-model", name: "New model", tier: "default" },
  ] };
  const bridge = openedBridge({
    position: vi.fn().mockResolvedValue({ status: 200, body: { position, agentEngine: "qoder", agentLocked: true, modelConfig: config } }),
    setPositionModel: vi.fn().mockResolvedValue({ status: 500, body: { message: "PRIVATE_DIAGNOSTIC" } }),
  });
  render(<App />); await selectRepoOwner();
  await waitFor(() => expect(screen.getByRole("combobox", { name: "员工模型" })).toBeEnabled());
  const sessionReads = vi.mocked(bridge.sessions).mock.calls.length;
  fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "Keep this draft" } });
  pickSelectOption("员工模型", "New model");
  expect(await screen.findByText("模型未能保存，仍使用原来的模型，请重试。")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "员工模型" }).closest('.ant-select')).toHaveTextContent("跟随 Agent 默认");
  expect(document.body.innerHTML).not.toContain("PRIVATE_DIAGNOSTIC");
  fireEvent.click(screen.getByRole("button", { name: "重新加载模型" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "员工模型" })).toBeEnabled());
  expect(screen.getByLabelText("下达任务")).toHaveValue("Keep this draft");
  expect(bridge.sessions).toHaveBeenCalledTimes(sessionReads);
  expect(bridge.createSession).not.toHaveBeenCalled();
  expect(screen.queryByRole("combobox", { name: "选择 Agent Host" })).not.toBeInTheDocument();
});


it("opens project management independently from Goals through the module rail", async () => {
  installBridge();
  render(<App />);
  fireEvent.click(within(screen.getByRole("navigation", { name: "模块" })).getByRole("button", { name: "项目", exact: true }));
  expect(await screen.findByRole("heading", { name: "项目管理", level: 1 })).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("navigation", { name: "项目视图" })).getByRole("button", { name: "目标", exact: true }));
  expect(await screen.findByRole("heading", { name: "目标", level: 1 })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "项目管理", level: 1 })).not.toBeInTheDocument();
});

  // Full-App render with two module switches and turn-link re-anchors, so on
  // slower runners it sits above the 5s default (#529). 15s matches the
  // other full-App tests in this file.
  it("reanchors a repeated project turn link without replacing the conversation draft", async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  const detail: GoalDetail = {
    goal: {
      schemaVersion: "goal.v1", goalId: "repeat-link-project", title: "重复定位项目", description: "",
      acceptanceCriteria: [], status: "open", health: "unknown", branches: [],
      workItems: [{ taskId: "project-task", title: "已执行任务", status: "done", priority: "normal", assigneePositionId: "repo-owner" }],
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    },
    activity: [],
    taskExecutions: { "project-task": { turnId: "project-turn", positionId: "repo-owner", status: "completed" } },
  };
  const bridge = openedBridge({
    goals: vi.fn().mockResolvedValue({ status: 200, body: { goals: [{ ...detail.goal, branchCount: 0 }] } }),
    goal: vi.fn().mockResolvedValue({ status: 200, body: detail }),
    sessionTurnHistory: vi.fn().mockResolvedValue({ status: 200, body: history([apiTurn({ turnId: "project-turn", output: "项目执行结果" })]) }),
  });
  render(<App />);
  await selectRepoOwner();
  await screen.findByText("项目执行结果");
  const composer = screen.getByLabelText("下达任务");
  fireEvent.change(composer, { target: { value: "保留未发送草稿" } });
  for (let visit = 0; visit < 2; visit += 1) {
    fireEvent.click(within(screen.getByRole("navigation", { name: "模块" })).getByRole("button", { name: "项目", exact: true }));
    const link = await screen.findByRole("button", { name: "查看任务执行：已执行任务" });
    scrollIntoView.mockClear();
    fireEvent.click(link);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    const target = screen.getByRole("region", { name: "岗位对话" }).querySelector('[data-turn-id="project-turn"]');
    expect(scrollIntoView.mock.instances.at(-1)).toBe(target);
    expect(screen.getByLabelText("下达任务")).toBe(composer);
    expect(composer).toHaveValue("保留未发送草稿");
  }
  expect(bridge.createTurn).not.toHaveBeenCalled();
  expect(bridge.createSessionTurn).not.toHaveBeenCalled();
}, 15_000);

it("counts only actionable inbox items and opens an approval's exact employee session and turn", async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  const writer = { ...position, id: "docs-writer", name: "文档负责人", reportTo: "repo-owner" };
  const currentSession = { ...activeSession, positionId: writer.id, principal: `position.${writer.id}`, sessionId: "writer-current" };
  const sourceSession: WorkbenchSession = { ...currentSession, sessionId: "writer-source", status: "rotated", rotatedTo: currentSession.sessionId };
  const source = { kind: "session" as const, positionId: writer.id, conversationId: sourceSession.sessionId,
    turnId: "approval-source-turn", runId: "approval-source-run", engine: "qoder" as const };
  const pending: ApprovalView = {
    schemaVersion: "workbench-approval.v1", id: "actionable", version: 1, approvalId: "engine-actionable", source,
    action: { kind: "tool", description: "Review the source task" }, status: "pending", canDecide: true,
    execution: { phase: "not_started" }, requestedAt: "2026-09-24T00:00:00Z",
    createdAt: "2026-09-24T00:00:00Z", updatedAt: "2026-09-24T00:00:00Z",
  };
  const expired: ApprovalView = { ...pending, id: "expired", approvalId: "engine-expired", expiresAt: "2000-01-01T00:00:00Z" };
  const denied: ApprovalView = { ...pending, id: "denied", approvalId: "engine-denied", status: "denied", canDecide: false };
  const listApprovals = vi.fn().mockResolvedValue({ status: 200, body: {
    items: [pending, expired, denied], workspaceToken: "tok", nextCursor: null, pendingCount: 2, revision: "1", syncState: "ready",
  } });
  const bridge = openedBridge({
    orgTree: vi.fn().mockResolvedValue({ status: 200, body: { ...snapshot, positionCount: 2, depth: 2,
      tree: [{ ...snapshot.tree[0]!, children: [{ ...snapshot.tree[0]!, id: writer.id, reportTo: "repo-owner" }] }],
    } }),
    position: vi.fn(async id => ({ status: 200, body: { position: id === writer.id ? writer : position, agentEngine: "qoder" } })),
    sessions: vi.fn(async id => ({ status: 200, body: { schemaVersion: "workbench-session-list.v1", positionId: id,
      activeSessionId: id === writer.id ? currentSession.sessionId : activeSession.sessionId,
      sessions: id === writer.id ? [currentSession, sourceSession] : [activeSession],
    } })),
    sessionTurnHistory: vi.fn(async sessionId => ({ status: 200, body: {
      ...history([apiTurn({ conversationId: sessionId, positionId: sessionId === sourceSession.sessionId ? writer.id : position.id,
        turnId: sessionId === sourceSession.sessionId ? source.turnId : "owner-turn",
        output: sessionId === sourceSession.sessionId ? "审批来源结果" : "原员工结果" })]),
      conversationId: sessionId, positionId: sessionId === sourceSession.sessionId ? writer.id : position.id,
    } })),
    listApprovals,
  });
  render(<App />);
  await selectRepoOwner();
  expect(await screen.findByText("原员工结果")).toBeVisible();
  const rail = within(screen.getByRole("navigation", { name: "模块" }));
  const inbox = rail.getByRole("button", { name: "收件箱" });
  await waitFor(() => expect(within(inbox).getByTitle("1")).toBeVisible());
  await openInbox();
  const approvalTab = within(screen.getByRole("navigation", { name: "收件箱视图" })).getByRole("button", { name: "审批" });
  expect(within(approvalTab).getByTitle("1")).toBeVisible();
  expect(inbox).toHaveAttribute("aria-current", "page");
  fireEvent.click(await screen.findByTestId("approval-card-actionable"));
  const detail = screen.getByRole("region", { name: "审批详情" });
  fireEvent.click(detail.querySelector('[data-testid="approval-source-references"] summary')!);
  expect(within(detail).getByText(sourceSession.sessionId)).toBeVisible();
  fireEvent.click(within(detail).getByRole("button", { name: "打开原会话" }));

  const conversation = await screen.findByRole("region", { name: "岗位对话" });
  expect(await within(conversation).findByText("审批来源结果")).toBeVisible();
  expect(within(conversation).queryByText("原员工结果")).not.toBeInTheDocument();
  expect(document.querySelector(".owb-context-header__name")).toHaveTextContent(writer.name);
  expect(rail.getByRole("button", { name: "协作" })).toHaveAttribute("aria-current", "page");
  expect(within(screen.getByRole("navigation", { name: "员工视图" })).getByRole("button", { name: "对话" })).toHaveAttribute("aria-pressed", "true");
  expect(bridge.sessions).toHaveBeenLastCalledWith(writer.id);
  expect(bridge.sessionTurnHistory).toHaveBeenLastCalledWith(sourceSession.sessionId);
  expect(bridge.sessionTurnHistory).not.toHaveBeenCalledWith(currentSession.sessionId);
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
  expect(scrollIntoView.mock.instances[0]).toBe(conversation.querySelector(`[data-turn-id="${source.turnId}"]`));
  expect(bridge.createSession).not.toHaveBeenCalled();
  expect(bridge.createSessionTurn).not.toHaveBeenCalled();

  listApprovals.mockResolvedValue({ status: 200, body: {
    items: [expired, denied], workspaceToken: "tok", nextCursor: null, pendingCount: 1, revision: "2", syncState: "ready",
  } });
  await openInbox();
  await waitFor(() => expect(inbox.querySelector(".ant-badge-count")).toBeNull());
});

it("wires approval module bulk deny so failed items remain selected in the queue", async () => {
  const source = { kind: "session" as const, positionId: "repo-owner", conversationId: "session-1", turnId: "turn-1", runId: "run-1", engine: "qoder" as const };
  const item1: ApprovalView = {
    schemaVersion: "workbench-approval.v1",
    id: "appr-1",
    version: 1,
    approvalId: "eng-1",
    source,
    action: { kind: "tool", description: "Use tool A" },
    status: "pending",
    canDecide: true,
    execution: { phase: "not_started" },
    batch: { maxItems: 3 },
    requestedAt: "2026-09-24T00:00:00Z",
    createdAt: "2026-09-24T00:00:00Z",
    updatedAt: "2026-09-24T00:00:00Z",
  };
  const item2: ApprovalView = {
    ...item1,
    id: "appr-2",
    approvalId: "eng-2",
    action: { kind: "tool", description: "Use tool B" },
  };

  const listApprovals = vi.fn().mockResolvedValue({
    status: 200,
    body: { items: [item1, item2], workspaceToken: "tok", nextCursor: null, pendingCount: 2, revision: "1", syncState: "ready" },
  });
  const decideApproval = vi.fn()
    .mockResolvedValueOnce({ status: 200, body: { ...item1, status: "denied", canDecide: false } })
    .mockResolvedValueOnce({ status: 500, body: { message: "Internal server error" } });

  openedBridge({
    listApprovals,
    decideApproval,
  });

  render(<App />);

  // Inbox defaults to approvals; the rail badge belongs to the whole context.
  await openInbox();

  expect(await screen.findByRole("region", { name: "审批中心" })).toBeInTheDocument();

  // Select both items
  const card1 = await screen.findByTestId("approval-card-appr-1");
  const card2 = await screen.findByTestId("approval-card-appr-2");
  const cb1 = within(card1).getByRole("checkbox");
  const cb2 = within(card2).getByRole("checkbox");

  fireEvent.click(cb1);
  fireEvent.click(cb2);
  expect(cb1).toBeChecked();
  expect(cb2).toBeChecked();

  // Trigger Bulk Deny
  const denyBatchBtn = screen.getByTestId("approval-batch-deny-button");
  await act(async () => {
    fireEvent.click(denyBatchBtn);
  });

  await waitFor(() => {
    const freshCard1 = screen.getByTestId("approval-card-appr-1");
    expect(within(freshCard1).getByRole("checkbox")).not.toBeChecked();
    const freshCard2 = screen.getByTestId("approval-card-appr-2");
    expect(within(freshCard2).getByRole("checkbox")).toBeChecked();
  });

  // Open card-2 to inspect error Alert in drawer
  fireEvent.click(screen.getByTestId("approval-card-appr-2"));
  expect(await screen.findByText("Internal server error")).toBeInTheDocument();
});
