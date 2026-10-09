import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RelationshipGraphResponse, RelationshipNode } from "@roleweave/shared";
import { projectRelationships, RelationshipGraph } from "../src/graph/RelationshipGraph";
import { RelationshipSpatialScene } from "../src/graph/RelationshipSpatialScene";

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
function mount(overrides: Partial<React.ComponentProps<typeof RelationshipGraph>> = {}, renderer: "minimal" | "context" = "minimal") {
  const props = { data, loading: false, onReload: vi.fn(), onOpenAgent: vi.fn(), onOpenResource: vi.fn(), workspaceKey: `graph-test-${++uniqueScope}`, ...overrides };
  const result = render(<RelationshipGraph {...props} />);
  if (renderer === "minimal") fireEvent.click(screen.getByRole("button", { name: "极简关系图" }));
  return { ...result, props };
}
function objectList() { return screen.getByRole("list", { name: "对象" }); }

describe("RelationshipGraph", () => {
  it("opens the drive source for discovered external files without treating them as role document paths", () => {
    const external: RelationshipNode = { ...resource, id: "resource:drive-file", label: "report.md", positionId: undefined, resourcePath: undefined,
      facts: [{ key: "kind", value: "drive_file" }, { key: "provider", value: "mem" }] };
    const onOpenDrive = vi.fn();
    const { props } = mount({ data: { ...data, nodes: [external], edges: [] }, onOpenDrive });
    fireEvent.click(within(objectList()).getByRole("button", { name: /report.md/ }));
    expect(onOpenDrive).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("complementary", { name: "关系详情" })).getByRole("button", { name: "在网盘中查看" }));
    expect(onOpenDrive).toHaveBeenCalledExactlyOnceWith();
    expect(props.onOpenResource).not.toHaveBeenCalled();
  });
  it("starts with context exploration and teaches objects, relationships, and evidence before spatial browsing", () => {
    mount({}, "context");

    expect(screen.getByRole("button", { name: "上下文探索" })).toHaveAttribute("aria-pressed", "true");
    const context = screen.getByRole("region", { name: "关联上下文" });
    expect(within(context).getByRole("heading", { name: "把上下文读成一条关系链" })).toBeVisible();
    expect(within(context).getByText("结构示例 · 不代表当前工作区数据")).toBeVisible();
    const workflow = screen.getByRole("list", { name: "这张图怎么用" });
    expect(workflow).toHaveTextContent("找一个对象");
    expect(workflow).toHaveTextContent("沿关系探索");
    expect(workflow).toHaveTextContent("查依据，打开原文");
    expect(within(context).getByRole("button", { name: /这个员工声明了哪些数据源？/ })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "极简关系空间" })).not.toBeInTheDocument();
    expect(screen.queryByText(/当前环境不支持 WebGL/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "这张图怎么用" }));
    const guide = screen.getByRole("region", { name: "这张图怎么用" });
    expect(within(guide).getByText("对象")).toBeVisible();
    expect(within(guide).getByText("关系")).toBeVisible();
    expect(within(guide).getByText("证据")).toBeVisible();
    expect(within(guide).getByText("这里展示对象、配置关系和来源记录。本次任务实际使用了哪些上下文，请到员工工作台核对。")).toBeVisible();
  });

  it("follows an employee to its source and resource, checks relationship evidence, and opens only on request", () => {
    const { props } = mount({}, "context");
    const context = screen.getByRole("region", { name: "关联上下文" });
    fireEvent.click(within(context).getByRole("button", { name: /这个员工声明了哪些数据源？/ }));
    expect(screen.getByRole("heading", { name: "Alice" })).toBeVisible();

    fireEvent.click(within(context).getByRole("button", { name: "探索对象: Project docs" }));
    expect(screen.getByRole("heading", { name: "Project docs" })).toBeVisible();
    expect(within(context).getByText("谁关联到它 · 1")).toBeVisible();
    expect(within(context).getByText("它关联到谁 · 1")).toBeVisible();
    fireEvent.click(within(context).getByRole("button", { name: /查看依据: Alice → 声明来源 → Project docs/ }));
    const inspector = screen.getByRole("complementary", { name: "关系详情" });
    expect(within(inspector).getByText("配置声明，不代表运行时授权")).toBeVisible();
    expect(within(inspector).getByText("workspace-org.v1")).toBeVisible();
    expect(props.onOpenAgent).not.toHaveBeenCalled();
    expect(props.onOpenResource).not.toHaveBeenCalled();

    fireEvent.click(within(context).getByRole("button", { name: "探索对象: brief.md" }));
    expect(within(inspector).getByRole("heading", { name: "brief.md" })).toBeVisible();
    expect(within(inspector).getByText("knowledge/brief.md")).toBeVisible();
    expect(props.onOpenResource).not.toHaveBeenCalled();
    fireEvent.click(within(inspector).getByRole("button", { name: "打开文档" }));
    expect(props.onOpenResource).toHaveBeenCalledExactlyOnceWith("alice", "knowledge/brief.md");
  });

  it("returns through the exploration trail and can restart at the guide", () => {
    mount({}, "context");
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    const context = screen.getByRole("region", { name: "关联上下文" });
    fireEvent.click(within(context).getByRole("button", { name: "探索对象: Project docs" }));
    fireEvent.click(within(context).getByRole("button", { name: "探索对象: brief.md" }));
    const trail = screen.getByRole("navigation", { name: "探索路径" });
    expect(within(trail).getByRole("button", { name: "brief.md" })).toHaveAttribute("aria-current", "location");

    fireEvent.click(within(trail).getByRole("button", { name: "回到上一步" }));
    expect(screen.getByRole("heading", { name: "Project docs" })).toBeVisible();
    expect(within(trail).queryByRole("button", { name: "brief.md" })).not.toBeInTheDocument();
    fireEvent.click(within(trail).getByRole("button", { name: "Alice" }));
    expect(screen.getByRole("heading", { name: "Alice" })).toBeVisible();
    expect(within(trail).getByRole("button", { name: "回到上一步" })).toBeDisabled();
    fireEvent.click(within(trail).getByRole("button", { name: "重新开始" }));
    expect(screen.queryByRole("navigation", { name: "探索路径" })).not.toBeInTheDocument();
    expect(within(context).getByRole("heading", { name: "把上下文读成一条关系链" })).toBeVisible();
  });

  it("uses a search to find the starting object without hiding differently named neighbors", () => {
    mount({}, "context");
    const search = screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" });
    fireEvent.change(search, { target: { value: "Alice" } });
    expect(within(objectList()).queryByRole("button", { name: /Project docs/ })).not.toBeInTheDocument();
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    const context = screen.getByRole("region", { name: "关联上下文" });
    fireEvent.click(within(context).getByRole("button", { name: "探索对象: Project docs" }));
    expect(within(context).getByRole("button", { name: "探索对象: brief.md" })).toBeVisible();
    expect(search).toHaveValue("Alice");
    expect(within(objectList()).queryByRole("button", { name: /Project docs/ })).not.toBeInTheDocument();
  });

  it("explains selectors as scope rules and never opens one as a discovered file", () => {
    const selector: RelationshipNode = { ...resource, id: "resource:selector", label: "knowledge/*.md", resourcePath: "knowledge/*.md", evidence, facts: [{ key: "kind", value: "selector" }] };
    const { props } = mount({ data: { ...data, nodes: [agent, source, selector], edges: [data.edges[0]!, { ...data.edges[1]!, target: selector.id }] } }, "context");
    const selectorButton = within(objectList()).getByRole("button", { name: /knowledge\/\*\.md/ });
    fireEvent.click(selectorButton);
    const context = screen.getByRole("region", { name: "关联上下文" });
    expect(within(context).getByText("这是资源范围选择器，例如路径匹配规则。它描述选取范围，不是已发现的文件。")).toBeVisible();
    const inspector = screen.getByRole("complementary", { name: "关系详情" });
    expect(within(inspector).queryByRole("button", { name: "打开文档" })).not.toBeInTheDocument();
    fireEvent.doubleClick(selectorButton);
    expect(props.onOpenResource).not.toHaveBeenCalled();
  });

  it("isolates the context focus and exploration trail by workspace and restores them on return", () => {
    const { rerender, props } = mount({}, "context");
    const search = screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" });
    fireEvent.change(search, { target: { value: "Alice" } });
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    fireEvent.click(within(screen.getByRole("region", { name: "关联上下文" })).getByRole("button", { name: "探索对象: Project docs" }));

    rerender(<RelationshipGraph {...props} workspaceKey={`context-other-${++uniqueScope}`} data={{ ...data, workspaceId: "other", nodes: [agent], edges: [] }} />);
    expect(screen.getByRole("button", { name: "上下文探索" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" })).toHaveValue("");
    expect(screen.queryByRole("navigation", { name: "探索路径" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "把上下文读成一条关系链" })).toBeVisible();

    rerender(<RelationshipGraph {...props} />);
    expect(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" })).toHaveValue("Alice");
    expect(screen.getByRole("heading", { name: "Project docs" })).toBeVisible();
    const trail = screen.getByRole("navigation", { name: "探索路径" });
    expect(within(trail).getByRole("button", { name: "Alice" })).toBeVisible();
    expect(within(trail).getByRole("button", { name: "Project docs" })).toHaveAttribute("aria-current", "location");
  });

  it("discloses the context cap independently of search and can explore a neighbor beyond that cap", () => {
    const sources = Array.from({ length: 130 }, (_, index) => ({ ...source, id: `source:${index}`, label: `Source ${index}` }));
    const large = { ...data, nodes: [agent, ...sources], edges: sources.map(node => ({ ...data.edges[0]!, id: `binding:${node.id}`, target: node.id })) };
    mount({ data: large }, "context");
    const search = screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" });
    fireEvent.change(search, { target: { value: "agent:alice" } });
    expect(within(objectList()).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    const context = screen.getByRole("region", { name: "关联上下文" });
    expect(screen.getByText("显示 120 / 131 个对象。搜索或聚焦邻域可继续探索。")).toBeVisible();
    expect(within(context).getAllByRole("button", { name: /^探索对象:/ })).toHaveLength(119);
    expect(within(context).queryByRole("button", { name: "探索对象: Source 129" })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "Source 129" } });
    fireEvent.click(within(objectList()).getByRole("button", { name: /Source 129/ }));
    expect(screen.getByRole("heading", { name: "Source 129" })).toBeVisible();
    expect(within(context).getByRole("button", { name: "探索对象: Alice" })).toBeVisible();
    expect(screen.queryByText("显示 120 / 131 个对象。搜索或聚焦邻域可继续探索。")).not.toBeInTheDocument();
  });

  it("distinguishes a filtered focus from a deleted object even when the updated graph is empty", () => {
    const { rerender, props } = mount({}, "context");
    fireEvent.click(within(objectList()).getByRole("button", { name: /brief.md/ }));
    fireEvent.click(screen.getByText("类型与关系筛选"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^资源/ }));
    const context = screen.getByRole("region", { name: "关联上下文" });
    expect(within(context).getByText("当前选择不在筛选结果中")).toBeVisible();
    expect(within(context).queryByText("该对象或关系已不在当前数据中")).not.toBeInTheDocument();

    rerender(<RelationshipGraph {...props} data={{ ...data, revision: "deleted", nodes: [], edges: [] }} />);
    expect(within(context).getByText("该对象或关系已不在当前数据中")).toBeVisible();
    expect(within(context).queryByText("当前选择不在筛选结果中")).not.toBeInTheDocument();
    expect(within(context).queryByRole("heading", { name: "把上下文读成一条关系链" })).not.toBeInTheDocument();
  });

  it("identifies same-named resources by their owning employee and opens the chosen owner", () => {
    const bob: RelationshipNode = { ...agent, id: "agent:bob", label: "Bob", positionId: "bob" };
    const bobResource: RelationshipNode = { ...resource, id: "resource:bob-brief", positionId: "bob" };
    const { props } = mount({ data: { ...data, nodes: [agent, bob, resource, bobResource], edges: [] } }, "context");
    const aliceButton = within(objectList()).getByRole("button", { name: /brief.md Alice · knowledge\/brief.md/ });
    const bobButton = within(objectList()).getByRole("button", { name: /brief.md Bob · knowledge\/brief.md/ });
    expect(aliceButton).toBeVisible();
    expect(bobButton).toBeVisible();
    fireEvent.click(bobButton);
    fireEvent.click(within(screen.getByRole("complementary", { name: "关系详情" })).getByRole("button", { name: "打开文档" }));
    expect(props.onOpenResource).toHaveBeenCalledExactlyOnceWith("bob", "knowledge/brief.md");
  });

  it("moves keyboard focus to the inspector when relationship or object evidence is requested", () => {
    const { props } = mount({}, "context");
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    const context = screen.getByRole("region", { name: "关联上下文" });
    const evidenceButton = within(context).getByRole("button", { name: /查看依据: Alice → 声明来源 → Project docs/ });
    evidenceButton.focus();
    fireEvent.click(evidenceButton);
    const inspector = screen.getByRole("complementary", { name: "关系详情" });
    expect(inspector).toHaveFocus();
    expect(within(inspector).getByRole("heading", { name: "这条关系的依据" })).toBeVisible();

    const objectEvidence = screen.getByRole("button", { name: "对象依据" });
    objectEvidence.focus();
    fireEvent.click(objectEvidence);
    expect(inspector).toHaveFocus();
    expect(within(inspector).getByRole("heading", { name: "Alice" })).toBeVisible();
    expect(props.onOpenAgent).not.toHaveBeenCalled();
    expect(props.onOpenResource).not.toHaveBeenCalled();
  });

  it("preserves the explicitly selected renderer and shared graph and spatial state per workspace", () => {
    const { rerender, props } = mount({ workspaceKey: "renderer-memory" });

    let renderer = screen.getByRole("group", { name: "渲染模式" });
    expect(within(renderer).getByRole("button", { name: "极简关系图" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "轨道" }));
    fireEvent.click(screen.getByRole("button", { name: "纸张浅色" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "brief" } });
    fireEvent.click(within(objectList()).getByRole("button", { name: /brief.md/ }));
    fireEvent.click(within(renderer).getByRole("button", { name: "空间关系图" }));

    expect(screen.getByRole("region", { name: "空间关系画布" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "brief.md" })).toBeVisible();
    rerender(<RelationshipGraph {...props} workspaceKey="renderer-memory-other" />);
    expect(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "上下文探索" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "极简关系图" }));
    expect(screen.getByRole("button", { name: "拓扑" })).toHaveAttribute("aria-pressed", "true");

    rerender(<RelationshipGraph {...props} workspaceKey="renderer-memory" />);
    renderer = screen.getByRole("group", { name: "渲染模式" });
    expect(within(renderer).getByRole("button", { name: "空间关系图" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" })).toHaveValue("brief");
    expect(screen.getByRole("heading", { name: "brief.md" })).toBeVisible();
    fireEvent.click(within(renderer).getByRole("button", { name: "极简关系图" }));
    expect(screen.getByRole("button", { name: "轨道" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "纸张浅色" })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders the explicitly selected minimal view as a Bindy spatial scene with controls and visible semantic objects", () => {
    mount();

    const scene = screen.getByRole("region", { name: "极简关系空间" });
    expect(scene).toHaveAttribute("data-visual-style", "bindy-spatial");
    const layouts = within(scene).getByRole("group", { name: "空间布局" });
    expect(within(layouts).getByRole("button", { name: "拓扑" })).toHaveAttribute("aria-pressed", "true");
    expect(within(layouts).getByRole("button", { name: "轨道" })).toHaveAttribute("aria-pressed", "false");
    expect(within(scene).getByRole("button", { name: "知识关系" })).toHaveAttribute("aria-pressed", "true");

    const objects = objectList();
    expect(objects).toBeVisible();
    expect(within(objects).getByRole("button", { name: /^Alice / })).toBeVisible();
    expect(within(objects).getByRole("button", { name: /brief.md Alice · knowledge\/brief.md/ })).toBeVisible();
    expect(within(objects).getAllByRole("button")).toHaveLength(data.nodes.length);
    expect(scene).toHaveAttribute("data-navigation", "hidden");
    expect(within(scene).queryByRole("list")).not.toBeInTheDocument();
  });

  it("uses the exact same filtered projection and selection in the galaxy renderer", () => {
    mount();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "brief" } });
    fireEvent.click(screen.getByRole("button", { name: "空间关系图" }));

    const scene = screen.getByRole("region", { name: "空间关系画布" });
    expect(scene).toHaveAttribute("data-visual-style", "yuanyang-galaxy");
    const objects = objectList();
    expect(within(objects).getAllByRole("button")).toHaveLength(1);
    expect(within(objects).queryByRole("button", { name: /^Alice\s/ })).not.toBeInTheDocument();
    expect(within(scene).queryByRole("list")).not.toBeInTheDocument();
    fireEvent.click(within(objects).getByRole("button", { name: /brief.md/ }));
    expect(screen.getByRole("heading", { name: "brief.md" })).toBeVisible();
  });

  it("switches visual modes through one shared spatial scene contract", () => {
    mount();
    const minimal = screen.getByRole("region", { name: "极简关系空间" });
    const objects = objectList();
    expect(objects).toHaveTextContent("Alice");
    fireEvent.click(screen.getByRole("button", { name: "空间关系图" }));
    const galaxy = screen.getByRole("region", { name: "空间关系画布" });

    expect(galaxy).toBe(minimal);
    expect(objectList()).toBe(objects);
    expect(objects).toHaveTextContent("Alice");
    expect(within(galaxy).queryByRole("list")).not.toBeInTheDocument();
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
    const { props } = mount();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "brief" } });

    expect(within(objectList()).getAllByRole("button")).toHaveLength(1);
    expect(within(objectList()).queryByRole("button", { name: /Alice.*员工/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "极简关系空间" })).queryByRole("list")).not.toBeInTheDocument();
    const button = within(objectList()).getByRole("button", { name: /brief.md/ });
    expect(button.tagName).toBe("BUTTON");
    expect(button.tabIndex).toBe(0);
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(screen.getByRole("heading", { name: "brief.md" })).toBeVisible();
    expect(props.onOpenResource).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("complementary", { name: "关系详情" })).getByRole("button", { name: "打开文档" }));
    expect(props.onOpenResource).toHaveBeenCalledExactlyOnceWith("alice", "knowledge/brief.md");
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
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    fireEvent.click(screen.getByRole("button", { name: "轨道" }));
    fireEvent.click(screen.getByRole("button", { name: "纸张浅色" }));
    rerender(<RelationshipGraph {...props} data={{ ...data, revision: "two", nodes: [...data.nodes, { ...agent, id: "agent:bob", positionId: "bob", label: "Bob" }] }} />);

    expect(within(objectList()).getByRole("button", { name: /^Alice / })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "轨道" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "纸张浅色" })).toHaveAttribute("aria-pressed", "true");
    expect(within(objectList()).getByRole("button", { name: /^Bob / })).toBeVisible();
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
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    expect(within(objectList()).getAllByRole("button")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "一跳邻域" }));
    expect(within(objectList()).getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "两跳邻域" }));
    expect(within(objectList()).getAllByRole("button")).toHaveLength(3);
  });

  it("expands neighbors with other names after searching for the starting employee", () => {
    mount();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "Alice" } });
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    fireEvent.click(screen.getByRole("button", { name: "一跳邻域" }));
    expect(within(objectList()).getByRole("button", { name: /^Project docs / })).toBeVisible();
  });

  it("separates partial failure and filtered-empty from an empty workspace", () => {
    const { props } = mount({ error: "Upstream offline", data: { ...data, coverage: [{ source: "mem", state: "error" }] } });
    expect(screen.getByText("关系暂时读取失败，请重试。")).toBeVisible();
    expect(screen.queryByText("Upstream offline")).not.toBeInTheDocument();
    const notice = screen.getByText("部分来源需要处理").closest('[role="status"]') as HTMLElement;
    expect(notice).toBeVisible();
    expect(within(notice).getByText("网盘文件：无法读取此来源，可刷新重试。")).toBeVisible();
    fireEvent.click(within(notice).getByRole("button", { name: "刷新关系" }));
    expect(props.onReload).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "no-match" } });
    expect(screen.getAllByText("没有符合筛选的对象").length).toBeGreaterThan(0);
    expect(screen.queryByText("当前工作区还没有关系对象")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("complementary", { name: "图谱筛选" })).getByRole("button", { name: "清除筛选" }));
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
    expect(await screen.findByText("当前环境不支持 WebGL，可在对象列表中用键盘浏览同一组关系对象。")).toBeVisible();
    const objects = objectList();
    expect(objects).toBeVisible();
    expect(within(objects).getAllByRole("button")).toHaveLength(data.nodes.length);
    expect(screen.queryByRole("list", { name: "极简空间对象" })).not.toBeInTheDocument();
    const resourceButton = within(objects).getByRole("button", { name: /brief.md Alice · knowledge\/brief.md/ });
    expect(resourceButton.tabIndex).toBe(0);
    resourceButton.focus();
    expect(resourceButton).toHaveFocus();
    fireEvent.click(resourceButton);
    expect(screen.getByRole("heading", { name: "brief.md" })).toBeVisible();
  });

  it("keeps default standalone scene navigation usable without a surrounding Sidebar", async () => {
    const onSelect = vi.fn();
    render(<RelationshipSpatialScene nodes={data.nodes} edges={data.edges} mode="minimal" layout="topology" theme="light"
      showKnowledgeRelationships onLayoutChange={vi.fn()} onThemeChange={vi.fn()} onShowKnowledgeRelationshipsChange={vi.fn()} onSelect={onSelect} />);
    expect(await screen.findByText(/当前环境不支持 WebGL/)).toBeVisible();
    const scene = screen.getByRole("region", { name: "极简关系空间" });
    expect(scene).toHaveAttribute("data-navigation", "visible");
    const objects = within(scene).getByRole("list", { name: "极简空间对象" });
    expect(within(objects).getAllByRole("button")).toHaveLength(data.nodes.length);
    const resourceButton = within(objects).getByRole("button", { name: "资源 · brief.md" });
    resourceButton.focus();
    expect(resourceButton).toHaveFocus();
    fireEvent.click(resourceButton);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(resource.id);
  });
});
