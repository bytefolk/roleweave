import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PositionCard } from "../src/position-card";
import type { PositionCardData } from "../src/types";

const POSITION: PositionCardData = {
  id: "repo-owner",
  name: "Repo Owner",
  description: "Owns the repository roadmap.",
  reportTo: null,
  mode: "read_only",
  contextScope: "/",
  contextSources: [
    {
      id: "workspace-position-docs",
      kind: "workspace_docs",
      name: "岗位知识库",
      locator: "positions/repo-owner",
      binding: "bound",
      state: "ready",
      readOnly: true,
      itemCount: 4,
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
      locator: "context://position/repo-owner",
      binding: "bound",
      state: "ready",
      readOnly: true,
      itemCount: 2,
    },
  ],
  permissions: { toolAllow: ["Read", "Grep", "Glob"], toolDeny: [] },
  budget: { perTask: { tokens: 40000, iterations: 12 }, perDay: { tokens: 400000, iterations: 96 } },
  metadata: {},
};

describe("PositionCard (D1 spec §3)", () => {
  it("shows empty guidance when no position selected", () => {
    render(<PositionCard position={null} />);
    expect(screen.getByText("从左侧选择岗位查看档案")).toBeInTheDocument();
  });

  it("renders a loading skeleton while fetching", () => {
    render(<PositionCard position={null} loading />);
    expect(document.querySelector(".ui-org-position-card__skeleton-title")).not.toBeNull();
  });

  it("renders the 404 notice after disband with a refresh action", () => {
    const onRefresh = vi.fn();
    render(<PositionCard position={null} notFound onRefresh={onRefresh} />);
    expect(screen.getByText(/岗位已不存在/)).toBeInTheDocument();
    screen.getByRole("button", { name: /刷新组织树/ }).click();
    expect(onRefresh).toHaveBeenCalled();
  });

  it("renders budget declaration, permission badges and context sources", () => {
    render(<PositionCard position={POSITION} />);
    expect(screen.getByRole("heading", { name: /预算声明/ })).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "单任务声明" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /权限摘要/ })).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /上下文来源/ })).toBeInTheDocument();
    expect(screen.getByText("岗位知识库")).toBeInTheDocument();
    expect(screen.getByText("统一网盘")).toBeInTheDocument();
    expect(screen.queryByText("mem://workspace")).not.toBeInTheDocument();
    expect(screen.getByText("岗位运行上下文")).toBeInTheDocument();
    expect(screen.queryByText("context://position/repo-owner")).not.toBeInTheDocument();
    expect(screen.getByText("未配置")).toBeInTheDocument();
  });

  it("keeps the position header focused on the name, not the reporting line", () => {
    render(<PositionCard position={{ ...POSITION, reportTo: "community-operator" }} />);

    expect(document.querySelector(".owb-panel-head__sub")).toBeNull();
    expect(screen.getByRole("heading", { name: "Repo Owner" })).toBeInTheDocument();
  });

  it("keeps rendering the legacy scope when the additive source list is absent", () => {
    render(<PositionCard position={{ ...POSITION, contextSources: undefined }} />);
    expect(screen.getByText("岗位上下文")).toBeInTheDocument();
    expect(screen.queryByText("/", { selector: "span" })).not.toBeInTheDocument();
  });

  it("opens a source in the unified employee-memory surface", () => {
    const onContextSourceSelect = vi.fn();
    render(<PositionCard position={POSITION} onContextSourceSelect={onContextSourceSelect} />);
    screen.getByRole("button", { name: "查看 岗位知识库 的员工记忆" }).click();
    expect(onContextSourceSelect).toHaveBeenCalledWith(POSITION.contextSources?.[0]);
  });
});
