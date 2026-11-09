import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { pickSelectOption } from "./select-helper";
import { ProjectWorkspaceDialog } from "../src/project/ProjectWorkspaceDialog";
import { ProjectCreateForm } from "../src/project/ProjectCreateForm";
import type { OwbBridge } from "../src/owb";
import type { TurnEngine, TurnEngineAvailability } from "../src/turns/types";

const engineAvailability: Record<TurnEngine, TurnEngineAvailability> = {
  qoder: { configured: true, ready: true },
  "claude-code": { configured: true, ready: true },
  "claude-local": { configured: true, ready: true },
  codex: { configured: true, ready: true },
  "codex-local": { configured: true, ready: true },
};

describe("ProjectWorkspaceDialog", () => {
  const renderCreate = (bridge: Partial<OwbBridge> = {}) => {
    window.owb = bridge as OwbBridge;
    render(<ProjectWorkspaceDialog open workspace={null} positionCount={null} engineAvailability={engineAvailability} onClose={() => {}} onOpenWorkspace={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /新建项目/ }));
  };

  it("creates a selected project template without manual form entry", async () => {
    const createWorkspace = vi.fn().mockResolvedValue({ status: 201, body: { open: true, created: true, path: "/tmp/software", business: "软件项目", owner: "owner", next: "create_employee", agentEngine: "qoder" } });
    renderCreate({ createWorkspace });
    screen.getAllByRole("textbox").forEach((field) => expect(field).not.toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /软件研发/ }));
    expect(createWorkspace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "选择位置并创建" }));
    await waitFor(() => expect(createWorkspace).toHaveBeenCalledWith({ projectId: expect.stringMatching(/^project-[a-z0-9]+$/), business: "软件项目", description: "梳理需求、实现功能、完成验证并交付可用版本。", agentEngine: "qoder" }));
  });

  it("restores edits when returning to a template and preserves the selected Agent", () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: /软件研发/ }));
    fireEvent.click(screen.getByText("调整名称与设置"));
    fireEvent.change(screen.getByRole("textbox", { name: "项目名称*" }), { target: { value: "我的软件" } });
    fireEvent.change(screen.getByRole("textbox", { name: "项目说明" }), { target: { value: "已编辑的交付范围" } });
    pickSelectOption("项目负责人 Agent", "Codex");
    fireEvent.click(screen.getByRole("button", { name: /资料调研/ }));
    fireEvent.click(screen.getByRole("button", { name: /软件研发/ }));
    expect(screen.getByRole("textbox", { name: "项目名称*" })).toHaveValue("我的软件");
    expect(screen.getByRole("textbox", { name: "项目说明" })).toHaveValue("已编辑的交付范围");
    expect(screen.getByText("负责人使用 Codex")).toBeInTheDocument();
  });

  it("keeps an existing directory's name when selecting a template", async () => {
    const initializeWorkspace = vi.fn().mockResolvedValue({ status: 201, body: { open: true, created: true, path: "/tmp/source-tree", business: "source-tree", owner: "owner", next: "create_employee", agentEngine: "qoder" } });
    window.owb = { initializeWorkspace } as unknown as OwbBridge;
    render(<ProjectWorkspaceDialog open workspace={null} positionCount={null} initializePath="/tmp/source-tree" engineAvailability={engineAvailability} onClose={() => {}} onOpenWorkspace={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /在此目录初始化项目/ }));
    fireEvent.click(screen.getByRole("button", { name: /软件研发/ }));
    fireEvent.click(screen.getByRole("button", { name: "初始化项目" }));
    await waitFor(() => expect(initializeWorkspace).toHaveBeenCalledWith({ path: "/tmp/source-tree", projectId: "source-tree", business: "source-tree", description: "梳理需求、实现功能、完成验证并交付可用版本。", agentEngine: "qoder" }));
  });

  it("submits only once when the same draft is confirmed twice", async () => {
    let finish: (response: unknown) => void = () => {};
    const createWorkspace = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    renderCreate({ createWorkspace });
    const form = screen.getByRole("form", { name: "项目基本信息" });
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => finish({ status: 409, body: { message: "目录已存在" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("目录已存在");
    expect(screen.getByRole("button", { name: "选择位置并创建" })).toBeEnabled();
  });

  it("discards an old directory's response without settling the new request", async () => {
    const pending: Array<(response: unknown) => void> = [];
    const initializeWorkspace = vi.fn(() => new Promise(resolve => pending.push(resolve)));
    window.owb = { initializeWorkspace } as unknown as OwbBridge;
    const onCreated = vi.fn();
    const onBusyChange = vi.fn();
    const props = { onCreated, onBusyChange, onCancel: vi.fn(), engineAvailability };
    const view = render(<ProjectCreateForm {...props} targetPath="/tmp/A" initialBusiness="A" />);
    fireEvent.submit(screen.getByRole("form", { name: "项目基本信息" }));
    view.rerender(<ProjectCreateForm {...props} targetPath="/tmp/B" initialBusiness="B" />);
    fireEvent.submit(screen.getByRole("form", { name: "项目基本信息" }));
    await act(async () => pending[0]({ status: 201, body: { business: "A" } }));
    expect(onCreated).not.toHaveBeenCalled();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("button", { name: /取\s*消/ })).toBeDisabled();
    await act(async () => pending[1]({ status: 201, body: { business: "B" } }));
    expect(onCreated).toHaveBeenCalledExactlyOnceWith({ business: "B" });
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("offers the native existing-workspace picker before entering creation", () => {
    const onClose = vi.fn();
    const onOpenWorkspace = vi.fn();

    render(
      <ProjectWorkspaceDialog
        open
        workspace={{ open: true, path: "/tmp/content-ops", business: "内容运营" }}
        positionCount={3}
        engineAvailability={engineAvailability}
        onClose={onClose}
        onOpenWorkspace={onOpenWorkspace}
        onCreated={() => {}}
      />,
    );

    expect(screen.getByRole("dialog", { name: "选择工作区" })).toBeInTheDocument();
    expect(screen.getByText("内容运营")).toBeInTheDocument();
    expect(screen.getByText("/tmp/content-ops")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /打开项目/ }));
    expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("generates a safe project id and submits the project contract", async () => {
    const createWorkspace = vi.fn().mockResolvedValue({
      status: 201,
      body: {
        open: true,
        created: true,
        next: "create_employee",
        path: "/tmp/content-ops",
        business: "内容运营",
        owner: "project-owner",
        agentEngine: "codex-local",
      },
    });
    window.owb = { createWorkspace } as unknown as OwbBridge;
    const onCreated = vi.fn();

    render(
      <ProjectWorkspaceDialog
        open
        workspace={null}
        positionCount={null}
        engineAvailability={engineAvailability}
        onClose={() => {}}
        onOpenWorkspace={() => {}}
        onCreated={onCreated}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /新建项目/ }));
    fireEvent.click(screen.getByRole("button", { name: "自定义项目" }));
    fireEvent.change(screen.getByRole("textbox", { name: "项目名称*" }), {
      target: { value: "内容运营" },
    });

    expect(screen.queryByRole("textbox", { name: /项目 ID/ })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "项目负责人 Agent" })).toBeInTheDocument();
    pickSelectOption("项目负责人 Agent", "Codex");
    fireEvent.click(screen.getByRole("button", { name: "选择位置并创建" }));

    await waitFor(() => {
      expect(createWorkspace).toHaveBeenCalledWith({
        projectId: expect.stringMatching(/^project-[a-z0-9]+$/),
        business: "内容运营",
        description: "",
        agentEngine: "codex-local",
      });
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("keeps the workspace dialog open while creation is in flight", async () => {
    let resolveCreate: (value: unknown) => void = () => {};
    const createWorkspace = vi.fn(() => new Promise((resolve) => { resolveCreate = resolve; }));
    window.owb = { createWorkspace } as unknown as OwbBridge;

    render(
      <ProjectWorkspaceDialog
        open
        workspace={null}
        positionCount={null}
        engineAvailability={engineAvailability}
        onClose={vi.fn()}
        onOpenWorkspace={() => {}}
        onCreated={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /新建项目/ }));
    fireEvent.click(screen.getByRole("button", { name: "自定义项目" }));
    fireEvent.change(screen.getByRole("textbox", { name: "项目名称*" }), { target: { value: "内容运营" } });
    fireEvent.click(screen.getByRole("button", { name: "选择位置并创建" }));
    await waitFor(() => expect(createWorkspace).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "返回" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /取\s*消/ })).toBeDisabled();
    await act(async () => resolveCreate({ status: 201, body: { open: true, created: true, next: "create_employee", path: "/tmp/content-ops", business: "内容运营", owner: "project-owner", agentEngine: "codex-local" } }));
  });

  it("initializes the selected existing folder with a generated project owner", async () => {
    const initializeWorkspace = vi.fn().mockResolvedValue({
      status: 201,
      body: {
        open: true,
        created: true,
        next: "create_employee",
        path: "/tmp/source-tree",
        business: "源代码项目",
        owner: "source-tree-owner",
        agentEngine: "codex-local",
      },
    });
    window.owb = { initializeWorkspace } as unknown as OwbBridge;
    const onCreated = vi.fn();

    render(
      <ProjectWorkspaceDialog
        open
        workspace={null}
        positionCount={null}
        initializePath="/tmp/source-tree"
        engineAvailability={engineAvailability}
        onClose={() => {}}
        onOpenWorkspace={() => {}}
        onCreated={onCreated}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /在此目录初始化项目/ }));
    expect(screen.getByRole("dialog", { name: "初始化此目录" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("调整名称与设置"));
    expect(screen.getByRole("textbox", { name: "项目名称*" })).toHaveValue("source-tree");
    fireEvent.change(screen.getByRole("textbox", { name: "项目名称*" }), { target: { value: "源代码项目" } });
    fireEvent.click(screen.getByRole("button", { name: "初始化项目" }));

    await waitFor(() => expect(initializeWorkspace).toHaveBeenCalledWith({
      path: "/tmp/source-tree",
      projectId: expect.stringMatching(/^project-[a-z0-9]+$/),
      business: "源代码项目",
      description: "围绕共同目标分配任务、协作完成工作并确认结果。",
      agentEngine: "qoder",
    }));
    expect(onCreated).toHaveBeenCalledTimes(1);
  });
});
