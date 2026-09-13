import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { pickSelectOption } from "./select-helper";
import { ProjectWorkspaceDialog } from "../src/project/ProjectWorkspaceDialog";
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
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
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
    fireEvent.change(screen.getByRole("textbox", { name: "项目名称*" }), {
      target: { value: "内容运营" },
    });

    expect(screen.queryByRole("textbox", { name: /项目 ID/ })).not.toBeInTheDocument();
    expect(screen.getByText("项目标识由平台根据名称自动生成，无需手动填写。")).toBeInTheDocument();
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
    fireEvent.change(screen.getByRole("textbox", { name: "项目名称*" }), { target: { value: "内容运营" } });
    fireEvent.click(screen.getByRole("button", { name: "选择位置并创建" }));
    await waitFor(() => expect(createWorkspace).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "返回" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /取\s*消/ })).toBeDisabled();
    await act(async () => resolveCreate({ status: 201, body: { open: true, created: true, next: "create_employee", path: "/tmp/content-ops", business: "内容运营", owner: "project-owner", agentEngine: "codex-local" } }));
  });
});
