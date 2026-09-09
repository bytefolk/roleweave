import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PositionCardData } from "@roleweave/ui";
import { MemoryModule } from "../src/memory/MemoryModule";
import type { OwbBridge } from "../src/owb";

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
    positionDocFile: vi.fn().mockResolvedValue({ status: 200, body: null }),
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

    expect(screen.getByRole("heading", { name: "员工记忆" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开 岗位文档 记忆来源" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "打开 岗位文档 记忆来源" })).toHaveTextContent("2");
    expect(screen.queryByText("岗位运行上下文")).not.toBeInTheDocument();
    expect(screen.queryByText("context://position/community-operator")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开 统一网盘 记忆来源" }));
    expect(await screen.findByText("社区周报.md")).toBeInTheDocument();
    await waitFor(() => expect(bridge.drive.list).toHaveBeenCalledWith(""));
  });
});
