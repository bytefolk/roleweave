import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RelationshipGraphResponse, RelationshipNode } from "@roleweave/shared";
import { projectRelationships, RelationshipGraph } from "../src/graph/RelationshipGraph";

const evidence = { source: "org config", locator: "workspace-org.v1", basis: "declared" as const, observedAt: "2026-09-22T12:00:00Z" };
const agent: RelationshipNode = { id: "agent:alice", kind: "agent", label: "Alice", state: "ready", positionId: "alice", evidence };
const source: RelationshipNode = { id: "source:docs", kind: "source", label: "Project docs", state: "configured", evidence };
const resource: RelationshipNode = { id: "resource:brief", kind: "resource", label: "brief.md", state: "ready", positionId: "alice", resourcePath: "knowledge/brief.md", evidence: { ...evidence, basis: "observed", source: "file inventory" } };
const data: RelationshipGraphResponse = {
  schemaVersion: "relationship-graph.v1", workspaceId: "test-graph", revision: "one", generatedAt: evidence.observedAt,
  nodes: [agent, source, resource], edges: [
    { id: "binding", source: agent.id, target: source.id, kind: "declares_source", evidence, permission: "declaration_only" },
    { id: "contains", source: source.id, target: resource.id, kind: "contains_resource", evidence: resource.evidence, permission: "not_applicable" },
  ], coverage: [{ source: "workspace", state: "complete", count: 3 }], truncated: false, limits: { nodes: 500, edges: 1000 },
};
let uniqueScope = 0;
function mount(overrides: Partial<React.ComponentProps<typeof RelationshipGraph>> = {}) {
  const props = { data, loading: false, onReload: vi.fn(), onOpenAgent: vi.fn(), onOpenResource: vi.fn(), workspaceKey: `graph-test-${++uniqueScope}`, ...overrides };
  return { ...render(<RelationshipGraph {...props} />), props };
}
function objectList() { return screen.getByRole("list", { name: "对象" }); }
function spatialObjects(name: "极简空间对象" | "星系对象" = "极简空间对象") { return screen.getByRole("list", { name }); }

describe("RelationshipGraph", () => {
  it("defaults to the minimalist renderer and preserves shared graph and spatial state per workspace", () => {
    const { rerender, props } = mount({ workspaceKey: "renderer-memory" });

    let renderer = screen.getByRole("group", { name: "渲染模式" });
    expect(within(renderer).getByRole("button", { name: "极简关系图" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "轨道" }));
    fireEvent.click(screen.getByRole("button", { name: "纸张浅色" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "brief" } });
    fireEvent.click(within(objectList()).getByRole("button", { name: /brief.md/ }));
    fireEvent.click(within(renderer).getByRole("button", { name: "星系关系图" }));

    expect(screen.getByRole("region", { name: "星系关系画布" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "brief.md" })).toBeVisible();
    rerender(<RelationshipGraph {...props} workspaceKey="renderer-memory-other" />);
    expect(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "拓扑" })).toHaveAttribute("aria-pressed", "true");

    rerender(<RelationshipGraph {...props} workspaceKey="renderer-memory" />);
    renderer = screen.getByRole("group", { name: "渲染模式" });
    expect(within(renderer).getByRole("button", { name: "星系关系图" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" })).toHaveValue("brief");
    expect(screen.getByRole("heading", { name: "brief.md" })).toBeVisible();
    fireEvent.click(within(renderer).getByRole("button", { name: "极简关系图" }));
    expect(screen.getByRole("button", { name: "轨道" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "纸张浅色" })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders the default as a genuine Bindy spatial scene with controls and visible semantic objects", () => {
    mount();

    const scene = screen.getByRole("region", { name: "极简关系空间" });
    expect(scene).toHaveAttribute("data-visual-style", "bindy-spatial");
    const layouts = within(scene).getByRole("group", { name: "空间布局" });
    expect(within(layouts).getByRole("button", { name: "拓扑" })).toHaveAttribute("aria-pressed", "true");
    expect(within(layouts).getByRole("button", { name: "轨道" })).toHaveAttribute("aria-pressed", "false");
    expect(within(scene).getByRole("button", { name: "知识关系" })).toHaveAttribute("aria-pressed", "true");

    const objects = within(scene).getByRole("list", { name: "极简空间对象" });
    expect(objects).toBeVisible();
    expect(within(objects).getByRole("button", { name: "员工 · Alice" })).toBeVisible();
    expect(within(objects).getByRole("button", { name: "资源 · brief.md" })).toBeVisible();
    expect(within(objects).queryByRole("button", { name: "员工 · brief.md" })).not.toBeInTheDocument();
  });

  it("uses the exact same filtered projection and selection in the galaxy renderer", () => {
    mount();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "brief" } });
    fireEvent.click(screen.getByRole("button", { name: "星系关系图" }));

    const scene = screen.getByRole("region", { name: "星系关系画布" });
    expect(scene).toHaveAttribute("data-visual-style", "yuanyang-galaxy");
    const objects = within(scene).getByRole("list", { name: "星系对象" });
    expect(within(objects).getAllByRole("button")).toHaveLength(1);
    expect(within(objects).queryByRole("button", { name: /Alice/ })).not.toBeInTheDocument();
    fireEvent.click(within(objects).getByRole("button", { name: "资源 · brief.md" }));
    expect(screen.getByRole("heading", { name: "brief.md" })).toBeVisible();
  });

  it("switches visual modes through one shared spatial scene contract", () => {
    mount();
    const minimal = screen.getByRole("region", { name: "极简关系空间" });
    expect(spatialObjects()).toHaveTextContent("Alice");
    fireEvent.click(screen.getByRole("button", { name: "星系关系图" }));
    const galaxy = screen.getByRole("region", { name: "星系关系画布" });

    expect(galaxy).toBe(minimal);
    expect(spatialObjects("星系对象")).toHaveTextContent("Alice");
    expect(screen.queryByRole("region", { name: "极简关系空间" })).not.toBeInTheDocument();
  });

  it("inspects a resource in place and opens its exact path only through an explicit action", () => {
    const { props } = mount();
    fireEvent.click(within(objectList()).getByRole("button", { name: /brief.md/ }));
    const inspector = screen.getByRole("complementary", { name: "关系详情" });
    expect(within(inspector).getByText("knowledge/brief.md")).toBeVisible();
    expect(props.onOpenAgent).not.toHaveBeenCalled();
    expect(props.onOpenResource).not.toHaveBeenCalled();
    fireEvent.click(within(inspector).getByRole("button", { name: "打开文档" }));
    expect(props.onOpenResource).toHaveBeenCalledWith("alice", "knowledge/brief.md");
  });

  it("uses exactly the same visible filtered collection for the scene and keyboard list", () => {
    mount();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "brief" } });

    expect(within(spatialObjects()).getAllByRole("button")).toHaveLength(1);
    expect(within(objectList()).getAllByRole("button")).toHaveLength(1);
    expect(within(spatialObjects()).queryByRole("button", { name: /Alice/ })).not.toBeInTheDocument();
    const button = within(spatialObjects()).getByRole("button", { name: "资源 · brief.md" });
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(screen.getByRole("heading", { name: "brief.md" })).toBeVisible();
  });

  it("shows directed relation evidence and never turns a declaration into an authorization", () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: /关系 2/ }));
    fireEvent.click(within(screen.getByRole("list", { name: "关系" })).getByRole("button", { name: /Alice → 声明来源 → Project docs/ }));
    const inspector = screen.getByRole("complementary", { name: "关系详情" });
    expect(within(inspector).getByText("配置声明，不代表运行时授权")).toBeVisible();
    expect(within(inspector).getByText("workspace-org.v1")).toBeVisible();
    expect(screen.getByText(/虚线：配置声明/)).toBeVisible();
  });

  it("preserves selection and spatial controls on data updates", () => {
    const { rerender, props } = mount();
    fireEvent.click(within(objectList()).getByRole("button", { name: /Alice/ }));
    fireEvent.click(screen.getByRole("button", { name: "轨道" }));
    fireEvent.click(screen.getByRole("button", { name: "纸张浅色" }));
    rerender(<RelationshipGraph {...props} data={{ ...data, revision: "two", nodes: [...data.nodes, { ...agent, id: "agent:bob", positionId: "bob", label: "Bob" }] }} />);

    expect(within(objectList()).getByRole("button", { name: /Alice/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "轨道" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "纸张浅色" })).toHaveAttribute("aria-pressed", "true");
    expect(within(spatialObjects()).getByRole("button", { name: "员工 · Bob" })).toBeVisible();
  });

  it("retains isolated objects and bounds a large graph while allowing search outside the initial neighborhood", () => {
    const isolated = { ...agent, id: "isolated", label: "Isolated" };
    const options = { query: "", kinds: ["agent"] as const, relations: ["reports_to"] as const, neighborhood: null };
    expect(projectRelationships({ ...data, nodes: [isolated], edges: [] }, options).nodes).toEqual([isolated]);
    const large = { ...data, nodes: Array.from({ length: 160 }, (_, index) => ({ ...agent, id: `agent:${index}`, label: `Employee ${index}` })), edges: [] };
    const first = projectRelationships(large, options);
    expect(first.bounded).toBe(true);
    expect(first.nodes.length).toBeLessThanOrEqual(120);
    expect(projectRelationships(large, { ...options, query: "Employee 159" }).nodes.map(node => node.id)).toEqual(["agent:159"]);
  });

  it("keeps one-hop and two-hop exploration explicit rather than changing the graph on selection", () => {
    mount();
    fireEvent.click(within(objectList()).getByRole("button", { name: /Alice/ }));
    expect(within(spatialObjects()).getAllByRole("button")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "一跳邻域" }));
    expect(within(spatialObjects()).getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "两跳邻域" }));
    expect(within(spatialObjects()).getAllByRole("button")).toHaveLength(3);
  });

  it("expands neighbors with other names after searching for the starting employee", () => {
    mount();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "Alice" } });
    fireEvent.click(within(objectList()).getByRole("button", { name: /Alice/ }));
    fireEvent.click(screen.getByRole("button", { name: "一跳邻域" }));
    expect(within(spatialObjects()).getByRole("button", { name: "数据源 · Project docs" })).toBeVisible();
  });

  it("separates partial failure and filtered-empty from an empty workspace", () => {
    mount({ error: "Upstream offline", data: { ...data, coverage: [{ source: "mem", state: "error" }] } });
    expect(screen.getByText("关系暂时读取失败，请重试。")).toBeVisible();
    expect(screen.queryByText("Upstream offline")).not.toBeInTheDocument();
    expect(screen.getByText("当前结果不完整，可用关系仍可浏览。")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "no-match" } });
    expect(screen.getAllByText("没有符合筛选的对象").length).toBeGreaterThan(0);
    expect(screen.queryByText("当前工作区还没有关系对象")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(within(objectList()).getAllByRole("button")).toHaveLength(3);
  });

  it("isolates workspaces and restores a workspace's selection and search on return", () => {
    const { rerender, props } = mount();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "brief" } });
    fireEvent.click(within(objectList()).getByRole("button", { name: /brief.md/ }));
    rerender(<RelationshipGraph {...props} workspaceKey="separate-workspace" data={{ ...data, workspaceId: "other", nodes: [agent], edges: [] }} />);
    expect(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" })).toHaveValue("");
    expect(screen.queryByRole("heading", { name: "brief.md" })).not.toBeInTheDocument();
    rerender(<RelationshipGraph {...props} />);
    expect(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" })).toHaveValue("brief");
    expect(screen.getByRole("heading", { name: "brief.md" })).toBeVisible();
  });

  it("keeps every object visibly keyboard-accessible when WebGL is unavailable", async () => {
    mount();
    expect(await screen.findByText("当前环境不支持 WebGL，仍可在下方用键盘浏览同一组关系对象。")).toBeVisible();
    const objects = spatialObjects();
    expect(objects).toBeVisible();
    const resourceButton = within(objects).getByRole("button", { name: "资源 · brief.md" });
    resourceButton.focus();
    expect(resourceButton).toHaveFocus();
    fireEvent.click(resourceButton);
    expect(screen.getByRole("heading", { name: "brief.md" })).toBeVisible();
  });
});
