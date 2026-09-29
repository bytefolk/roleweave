import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PositionCardData } from "@roleweave/ui";
import { MemoryModule } from "../src/memory/MemoryModule";
import type { DocsFileResponse } from "@roleweave/shared";
import type { OwbBridge } from "../src/owb";
import { pickSelectOption } from "./select-helper";

const position: PositionCardData = {
  id: "community-operator",
  name: "社区运营",
  description: "整理社区反馈，维护贡献者文档。",
  reportTo: "repo-owner",
  mode: "read_only",
  contextScope: "position",
  contextSources: [
    {
      id: "workspace-position-docs",
      kind: "workspace_docs",
      name: "岗位知识库",
      locator: "positions/community-operator/SKILL.md + knowledge/**",
      binding: "bound",
      state: "ready",
      readOnly: true,
      itemCount: 2,
    },
    {
      id: "mem-drive",
      kind: "mem_drive",
      name: "统一网盘",
      locator: "mem://workspace",
      binding: "available",
      state: "not_configured",
      readOnly: true,
    },
    {
      id: "context-provider",
      kind: "context_provider",
      name: "岗位运行上下文",
      locator: "context://position/community-operator",
      binding: "bound",
      state: "ready",
      readOnly: true,
      itemCount: 1,
    },
  ],
  permissions: { toolAllow: ["Read"], toolDeny: [] },
  budget: { perTask: { tokens: 20_000 }, perDay: { tokens: 200_000 } },
  metadata: {},
};

function installBridge() {
  const bridge = {
    position: vi.fn().mockResolvedValue({ status: 200, body: { position } }),
    positionDocs: vi.fn().mockResolvedValue({
      status: 200,
      body: {
        schemaVersion: "docs-file-list.v1",
        positionId: "community-operator",
        files: [{ path: "SKILL.md", kind: "file", size: 32, modifiedAt: "2026-08-27T00:00:00.000Z" }],
      },
    }),
    positionDocFile: vi.fn().mockResolvedValue({ status: 200, body: null as DocsFileResponse | null }),
    drive: {
      list: vi.fn().mockResolvedValue({
        status: 200,
        body: {
          schemaVersion: "drive-object-list.v1",
          mocked: false,
          objects: [{
            id: "mem-001",
            name: "社区周报.md",
            size: 120,
            mime: "text/markdown",
            createdAt: "2026-08-30T09:14:22.000Z",
            summary: "社区反馈摘要。",
          }],
        },
      }),
      detail: vi.fn().mockResolvedValue({ status: 404, body: null }),
    },
  };
  window.owb = bridge as unknown as OwbBridge;
  return bridge;
}

describe("员工记忆模块", () => {
  it.each([true, false])("omits duplicate heading and collaboration action with showEmployeePicker=%s", async (showEmployeePicker) => {
    const bridge = installBridge();
    const { container } = render(<MemoryModule workspaceOpen
      positions={[{ id: position.id, name: position.name }]} selectedPositionId={position.id}
      position={position} showEmployeePicker={showEmployeePicker} />);
    await waitFor(() => expect(bridge.positionDocs).toHaveBeenCalledWith(position.id));

    expect.soft(screen.queryByRole("heading", { name: "记忆与协作" })).not.toBeInTheDocument();
    expect.soft(screen.queryByRole("button", { name: "进入协作" })).not.toBeInTheDocument();
    const header = container.querySelector(".owb-memory-module__header");
    if (showEmployeePicker) {
      expect(header).toBeInTheDocument();
      expect(within(header as HTMLElement).getByRole("combobox", { name: "选择员工查看记忆" })).toBeVisible();
      expect.soft(within(header as HTMLElement).queryByRole("button", { name: "专注阅读" })).not.toBeInTheDocument();
    } else {
      expect.soft(header).not.toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "选择员工查看记忆" })).not.toBeInTheDocument();
    }
  });

  it.each([undefined, true, false])("follows outer employee changes with showEmployeePicker=%s", async (showEmployeePicker) => {
    const bridge = installBridge();
    const employees = [
      { id: position.id, name: position.name },
      { id: "repo-owner", name: "Repo Owner" },
    ];
    const documents: Record<string, string> = {
      "community-operator": "# Community handbook\nCommunity responsibilities.",
      "repo-owner": "# Owner handbook\nOwner responsibilities.",
    };
    bridge.positionDocs.mockImplementation(async (positionId: string) => ({ status: 200, body: {
      schemaVersion: "docs-file-list.v1", positionId,
      files: [{ path: "SKILL.md", kind: "file", size: 64, modifiedAt: "2026-08-27T00:00:00.000Z" }],
    } }));
    bridge.positionDocFile.mockImplementation(async (positionId: string, path: string) => (
      documents[positionId] === undefined ? { status: 404, body: null } : { status: 200, body: {
        schemaVersion: "docs-file.v1", positionId, path, version: "v1", content: documents[positionId],
      } }
    ));
    const memory = (selectedPositionId: string | null) => (
      <MemoryModule workspaceOpen positions={employees} selectedPositionId={selectedPositionId}
        position={position} showEmployeePicker={showEmployeePicker} />
    );
    const { rerender } = render(memory(position.id));
    expect(await screen.findByRole("heading", { name: "Community handbook" })).toBeVisible();
    if (showEmployeePicker === false) {
      expect(screen.queryByRole("combobox", { name: "选择员工查看记忆" })).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole("combobox", { name: "选择员工查看记忆" })).toBeVisible();
    }
    expect(screen.queryByRole("combobox", { name: "选择岗位查看文档" })).not.toBeInTheDocument();

    rerender(memory("repo-owner"));
    expect(await screen.findByRole("heading", { name: "Owner handbook" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Community handbook" })).not.toBeInTheDocument();
    expect(bridge.positionDocFile).toHaveBeenLastCalledWith("repo-owner", "SKILL.md");
    if (showEmployeePicker === false) {
      expect(screen.queryByRole("combobox", { name: "选择员工查看记忆" })).not.toBeInTheDocument();
    } else {
      pickSelectOption("选择员工查看记忆", position.name);
      expect(await screen.findByRole("heading", { name: "Community handbook" })).toBeVisible();
      const picker = screen.getByRole("combobox", { name: "选择员工查看记忆" });
      act(() => picker.focus());
      expect(picker).toHaveFocus();
      fireEvent.keyDown(picker, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
      expect(picker).toHaveAttribute("aria-expanded", "true");
      fireEvent.keyDown(picker, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
      fireEvent.keyDown(picker, { key: "Enter", code: "Enter", keyCode: 13 });
      expect(await screen.findByRole("heading", { name: "Owner handbook" })).toBeVisible();
      expect(bridge.positionDocFile).toHaveBeenLastCalledWith("repo-owner", "SKILL.md");
    }
    expect(screen.queryByRole("combobox", { name: "选择岗位查看文档" })).not.toBeInTheDocument();

    rerender(memory(null));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Owner handbook" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Community handbook" })).not.toBeInTheDocument();
    });
  });

  it("把岗位文档和统一网盘放在同一个员工入口", async () => {
    const bridge = installBridge();
    render(
      <MemoryModule
        workspaceOpen
        positions={[{ id: position.id, name: position.name }]}
        selectedPositionId={position.id}
        position={position}
      />,
    );

    expect(screen.getByRole("button", { name: "打开 岗位文档 记忆来源" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "打开 岗位文档 记忆来源" })).not.toHaveTextContent("2");
    expect(screen.queryByText("岗位运行上下文")).not.toBeInTheDocument();
    expect(screen.queryByText("context://position/community-operator")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开 统一网盘 记忆来源" }));
    expect(await screen.findByText("社区周报.md")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开 统一网盘 记忆来源" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "专注阅读" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "退出专注阅读" })).not.toBeInTheDocument();
    await waitFor(() => expect(bridge.drive.list).toHaveBeenCalledWith(""));
  });

  it.each([true, false])("keeps reading focus in the source tabs without reloading documents (showEmployeePicker=%s)", async (showEmployeePicker) => {
    const bridge = installBridge();
    bridge.positionDocFile.mockResolvedValue({ status: 200, body: {
      schemaVersion: "docs-file.v1", positionId: position.id, path: "SKILL.md", version: "v1", content: "# 岗位职责\n保持当前文档。",
    } });
    const { container } = render(<MemoryModule workspaceOpen positions={[{ id: position.id, name: position.name }]}
      selectedPositionId={position.id} position={position} showEmployeePicker={showEmployeePicker} />);
    const reader = await screen.findByRole("heading", { name: "岗位职责" });
    const module = screen.getByRole("region", { name: "员工记忆" });
    const tabs = container.querySelector(".owb-memory-tabs")!;
    expect(within(tabs as HTMLElement).getByText("已绑定")).toBeVisible();
    expect(within(module).getByRole("status", { name: "绑定期间只读" })).toBeVisible();
    expect(within(tabs as HTMLElement).getByRole("button", { name: "查看来源说明" })).toBeEnabled();
    const focus = within(tabs as HTMLElement).getByRole("button", { name: "专注阅读" });
    expect(focus).toHaveAttribute("aria-pressed", "false");
    expect(focus.tagName).toBe("BUTTON");
    expect(focus.tabIndex).toBe(0);
    expect(module).toHaveAttribute("data-reading-focus", "false");
    expect(module).not.toHaveAttribute("data-sources-collapsed");

    act(() => focus.focus());
    expect(focus).toHaveFocus();
    fireEvent.click(focus);
    const exitFocus = within(tabs as HTMLElement).getByRole("button", { name: "退出专注阅读" });
    expect(exitFocus).toBe(focus);
    expect(exitFocus).toHaveFocus();
    expect(exitFocus).toHaveAttribute("aria-pressed", "true");
    expect(module).toHaveAttribute("data-reading-focus", "true");
    fireEvent.click(exitFocus);
    expect(focus).toHaveAttribute("aria-label", "专注阅读");
    expect(focus).toHaveAttribute("aria-pressed", "false");
    expect(module).toHaveAttribute("data-reading-focus", "false");
    expect(screen.getByRole("heading", { name: "岗位职责" })).toBe(reader);
    expect(bridge.positionDocFile).toHaveBeenCalledTimes(1);
    expect(bridge.positionDocs).toHaveBeenCalledTimes(1);
  });

  it("keeps shared-document focus document-only and continues the selected employee session", async () => {
    installBridge();
    window.owb.docPlaneList = vi.fn().mockResolvedValue({ status: 503, body: { code: "doc_plane_unconfigured" } });
    window.owb.sessions = vi.fn().mockResolvedValue({ status: 200, body: {
      activeSessionId: "session-a", sessions: [{
        schemaVersion: "workbench-session.v1", sessionId: "session-a", workspaceInstanceId: "workspace-1",
        positionId: position.id, principal: `position.${position.id}`, status: "active", threadContextEnabled: true,
        rotatedFrom: null, rotatedTo: null, createdAt: "2026-09-12T00:00:00Z", rotatedAt: null,
      }],
    } });
    window.owb.sessionTurnHistory = vi.fn().mockResolvedValue({ status: 200, body: { turns: [] } });
    const onContinue = vi.fn();
    const memory = (initialSource: "shared" | "sessions") => (
      <MemoryModule workspaceOpen positions={[{ id: position.id, name: position.name }]}
        selectedPositionId={position.id} position={position} showEmployeePicker={false}
        initialSource={initialSource} onContinue={onContinue} />
    );
    const { container, rerender } = render(memory("shared"));
    const module = screen.getByRole("region", { name: "员工记忆" });
    const tabs = container.querySelector(".owb-memory-tabs")!;
    fireEvent.click(within(tabs as HTMLElement).getByRole("button", { name: "专注阅读" }));
    expect(module).toHaveAttribute("data-reading-focus", "true");

    rerender(memory("sessions"));
    expect(module).toHaveAttribute("data-reading-focus", "false");
    expect(screen.queryByRole("button", { name: "专注阅读" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "退出专注阅读" })).not.toBeInTheDocument();
    const continueSession = screen.getByRole("button", { name: "继续对话" });
    await waitFor(() => expect(continueSession).toBeEnabled());
    fireEvent.click(continueSession);
    expect(onContinue).toHaveBeenCalledExactlyOnceWith(position.id, "session-a");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "打开 共享知识 记忆来源" }));
    });
    expect(module).toHaveAttribute("data-reading-focus", "true");
    fireEvent.click(screen.getByRole("button", { name: "退出专注阅读" }));
    expect(module).toHaveAttribute("data-reading-focus", "false");
  });
});
