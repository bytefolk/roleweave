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
function mount(overrides: Partial<React.ComponentProps<typeof RelationshipGraph>> = {}, renderer: "galaxy" | "context" = "context") {
  const props = { data, loading: false, onReload: vi.fn(), onOpenAgent: vi.fn(), onOpenResource: vi.fn(), workspaceKey: `graph-test-${++uniqueScope}`, ...overrides };
  const result = render(<RelationshipGraph {...props} />);
  if (renderer === "galaxy") selectView("图形总览");
  return { ...result, props };
}
function objectList() { return screen.getByRole("list", { name: "对象" }); }
function context() { return screen.getByRole("region", { name: "关联上下文" }); }
function hiddenInspector() { return screen.getByLabelText("关系详情", { selector: "aside" }); }
function openMore() {
  const summary = screen.getByText("更多选项", { selector: "summary" });
  const details = summary.closest("details")!;
  if (!details.open) fireEvent.click(summary);
  return details;
}
function selectView(name: "关联列表" | "图形总览") { fireEvent.click(within(openMore()).getByRole("button", { name })); }
function inspectObject() { fireEvent.click(screen.getByRole("button", { name: "对象依据" })); }
function showAllObjects() {
  const more = openMore();
  const checkbox = within(more).getByRole("checkbox", { name: "显示全部对象" });
  if (!(checkbox as HTMLInputElement).checked) fireEvent.click(checkbox);
  fireEvent.keyDown(more, { key: "Escape" });
}

describe("RelationshipGraph", () => {
  it("starts with real-object guidance and leaves advanced options and evidence closed", () => {
    mount();
    expect(within(context()).getByText("选一名员工看关联，或从资料查来源。")).toBeVisible();
    expect(within(context()).queryByRole("list", { name: "这张图怎么用" })).not.toBeInTheDocument();
    expect(within(objectList()).getAllByRole("button")).toHaveLength(1);
    expect(within(objectList()).getByRole("button", { name: /^Alice / })).toBeVisible();
    expect(within(objectList()).queryByRole("button", { name: /Project docs|brief.md/ })).not.toBeInTheDocument();
    expect(within(context()).getByRole("button", { name: /看员工关联.*Alice/ })).toBeEnabled();
    expect(within(context()).getByRole("button", { name: /找资料来源.*brief.md/ })).toBeEnabled();
    expect(screen.queryByText("结构示例 · 不代表当前工作区数据")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /关系/ })).not.toBeInTheDocument();
    const more = screen.getByText("更多选项", { selector: "summary" }).closest("details")!;
    expect(more.open).toBe(false);
    expect(within(more).getByRole("button", { name: "图形总览", hidden: true })).not.toBeVisible();
    expect(hiddenInspector()).not.toBeVisible();
    expect(screen.queryByRole("region", { name: "空间关系画布" })).not.toBeInTheDocument();
    expect(screen.queryByText(/当前环境不支持 WebGL/)).not.toBeInTheDocument();
  });

  it("teaches with real objects, explicitly requested evidence and a finish action", () => {
    const { props } = mount();
    fireEvent.click(screen.getByRole("button", { name: "这张图怎么用" }));
    const guide = screen.getByRole("region", { name: "这张图怎么用" });
    expect(screen.getAllByRole("list", { name: "这张图怎么用" })).toHaveLength(1);
    expect(within(context()).getByRole("button", { name: /看员工关联.*Alice/ })).toBeEnabled();
    fireEvent.click(within(guide).getByRole("button", { name: /^试试看[：:]\s*Alice$/ }));
    expect(within(context()).getByRole("heading", { name: "Alice" })).toBeVisible();
    expect(hiddenInspector()).not.toBeVisible();
    fireEvent.click(within(guide).getByRole("button", { name: "查看一条关联的依据" }));
    expect(screen.getByRole("complementary", { name: "关系详情" })).toHaveFocus();
    expect(screen.getByText("workspace-org.v1")).toBeVisible();
    expect(props.onOpenAgent).not.toHaveBeenCalled();
    expect(props.onOpenResource).not.toHaveBeenCalled();
    fireEvent.click(within(guide).getByRole("button", { name: "完成引导" }));
    expect(screen.queryByRole("region", { name: "这张图怎么用" })).not.toBeInTheDocument();
  });

  it("does not invent relationship evidence when the real guide object has no relationships", () => {
    const { props } = mount({ data: { ...data, nodes: [agent], edges: [] } });
    fireEvent.click(screen.getByRole("button", { name: "这张图怎么用" }));
    const guide = screen.getByRole("region", { name: "这张图怎么用" });
    fireEvent.click(within(guide).getByRole("button", { name: /^试试看[：:]\s*Alice$/ }));
    expect(within(guide).queryByRole("button", { name: "查看一条关联的依据" })).not.toBeInTheDocument();
    expect(within(guide).getByRole("button", { name: "完成引导" })).toBeEnabled();
    expect(hiddenInspector()).not.toBeVisible();
    expect(props.onOpenAgent).not.toHaveBeenCalled();
  });

  it("closes nested source information before More and closes More on outside selection", () => {
    mount();
    const more = openMore();
    const sourceSummary = within(more).getByText("来源信息").closest("summary")!;
    const sourceDetails = sourceSummary.closest("details")!;
    expect(sourceDetails.open).toBe(false);
    fireEvent.click(sourceSummary);
    expect(sourceDetails.open).toBe(true);
    fireEvent.keyDown(sourceSummary, { key: "Escape" });
    expect(sourceDetails.open).toBe(false);
    expect(more.open).toBe(true);
    expect(sourceSummary).toHaveFocus();
    fireEvent.keyDown(sourceSummary, { key: "Escape" });
    expect(more.open).toBe(false);
    expect(within(more).getByText("更多选项", { selector: "summary" })).toHaveFocus();
    openMore();
    const button = within(objectList()).getByRole("button", { name: /^Alice / });
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    expect(more.open).toBe(false);
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(hiddenInspector()).not.toBeVisible();
  });

  it("follows employees, sources and resources without automatically opening evidence or source navigation", () => {
    const { props } = mount();
    fireEvent.click(within(context()).getByRole("button", { name: /看员工关联.*Alice/ }));
    expect(within(context()).getByRole("heading", { name: "Alice" })).toBeVisible();
    expect(hiddenInspector()).not.toBeVisible();
    fireEvent.click(within(context()).getByRole("button", { name: "探索对象: Project docs" }));
    expect(within(context()).getByRole("heading", { name: "Project docs" })).toBeVisible();
    expect(within(context()).getByText("关联对象")).toBeVisible();
    expect(hiddenInspector()).not.toBeVisible();
    fireEvent.click(within(context()).getByRole("button", { name: "探索对象: brief.md" }));
    expect(within(context()).getByRole("heading", { name: "brief.md" })).toBeVisible();
    expect(hiddenInspector()).not.toBeVisible();
    expect(props.onOpenAgent).not.toHaveBeenCalled();
    expect(props.onOpenResource).not.toHaveBeenCalled();
    inspectObject();
    const inspector = screen.getByRole("complementary", { name: "关系详情" });
    expect(within(inspector).getByText("knowledge/brief.md")).toBeVisible();
    fireEvent.click(within(inspector).getByRole("button", { name: "打开文档" }));
    expect(props.onOpenResource).toHaveBeenCalledExactlyOnceWith("alice", "knowledge/brief.md");
  });

  it("describes incoming source declarations in the correct direction and keeps their exact evidence", () => {
    mount();
    fireEvent.click(within(context()).getByRole("button", { name: /看员工关联.*Alice/ }));
    fireEvent.click(within(context()).getByRole("button", { name: "探索对象: Project docs" }));
    const employeeRow = within(context()).getByRole("button", { name: "探索对象: Alice" }).closest("li")!;
    expect(within(employeeRow).getByText("声明此来源")).toBeVisible();
    expect(within(employeeRow).queryByText("声明来源")).not.toBeInTheDocument();
    fireEvent.click(within(employeeRow).getByRole("button", { name: "查看依据: Alice → 声明来源 → Project docs" }));
    const inspector = screen.getByRole("complementary", { name: "关系详情" });
    expect(within(inspector).getByRole("heading", { name: "Alice → 声明来源 → Project docs" })).toBeVisible();
    expect(within(inspector).getByText("配置声明，不代表运行时授权")).toBeVisible();
    expect(within(inspector).getByText("workspace-org.v1")).toBeVisible();
    fireEvent.click(within(inspector).getByRole("button", { name: "Project docs" }));
    expect(inspector).not.toBeVisible();
    expect(screen.getByLabelText("关联上下文", { selector: "div.owb-rgraph__main" })).toHaveFocus();
    expect(within(context()).getByRole("heading", { name: "Project docs" })).toBeVisible();
  });

  it("opens the drive source only on request without treating external files as role document paths", () => {
    const external: RelationshipNode = { ...resource, id: "resource:drive-file", label: "report.md", positionId: undefined, resourcePath: undefined,
      facts: [{ key: "kind", value: "drive_file" }, { key: "provider", value: "mem" }] };
    const onOpenDrive = vi.fn();
    const { props } = mount({ data: { ...data, nodes: [external], edges: [] }, onOpenDrive });
    fireEvent.click(within(objectList()).getByRole("button", { name: /report.md/ }));
    expect(hiddenInspector()).not.toBeVisible();
    expect(onOpenDrive).not.toHaveBeenCalled();
    inspectObject();
    fireEvent.click(within(screen.getByRole("complementary", { name: "关系详情" })).getByRole("button", { name: "在网盘中查看" }));
    expect(onOpenDrive).toHaveBeenCalledExactlyOnceWith();
    expect(props.onOpenResource).not.toHaveBeenCalled();
  });

  it("returns through the exploration trail and restarts without opening the evidence pane", () => {
    mount();
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    fireEvent.click(within(context()).getByRole("button", { name: "探索对象: Project docs" }));
    fireEvent.click(within(context()).getByRole("button", { name: "探索对象: brief.md" }));
    const trail = screen.getByRole("navigation", { name: "探索路径" });
    expect(within(trail).getByRole("button", { name: "brief.md" })).toHaveAttribute("aria-current", "location");
    fireEvent.click(within(trail).getByRole("button", { name: "回到上一步" }));
    expect(within(context()).getByRole("heading", { name: "Project docs" })).toBeVisible();
    expect(within(trail).queryByRole("button", { name: "brief.md" })).not.toBeInTheDocument();
    fireEvent.click(within(trail).getByRole("button", { name: "Alice" }));
    expect(within(context()).getByRole("heading", { name: "Alice" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "探索路径" })).not.toBeInTheDocument();
    expect(hiddenInspector()).not.toBeVisible();
    fireEvent.click(within(context()).getByRole("button", { name: "探索对象: Project docs" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "探索路径" })).getByRole("button", { name: "重新开始" }));
    expect(screen.queryByRole("navigation", { name: "探索路径" })).not.toBeInTheDocument();
    expect(within(context()).getByText("选一名员工看关联，或从资料查来源。")).toBeVisible();
  });

  it("searches for a starting object without hiding differently named neighbors", () => {
    mount();
    const search = screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" });
    fireEvent.change(search, { target: { value: "Alice" } });
    expect(within(objectList()).queryByRole("button", { name: /Project docs/ })).not.toBeInTheDocument();
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    fireEvent.click(within(context()).getByRole("button", { name: "探索对象: Project docs" }));
    expect(within(context()).getByRole("button", { name: "探索对象: brief.md" })).toBeVisible();
    expect(search).toHaveValue("Alice");
    expect(within(objectList()).queryByRole("button", { name: /Project docs/ })).not.toBeInTheDocument();
  });

  it("searches all object types while the default employee list stays short and can explicitly show all", () => {
    mount();
    const search = screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" });
    expect(within(objectList()).getAllByRole("button")).toHaveLength(1);
    fireEvent.change(search, { target: { value: "brief" } });
    expect(within(objectList()).getByRole("button", { name: /brief.md Alice · knowledge\/brief.md/ })).toBeVisible();
    expect(within(objectList()).queryByRole("button", { name: /^Alice / })).not.toBeInTheDocument();
    fireEvent.click(within(objectList()).getByRole("button", { name: /brief.md/ }));
    expect(within(context()).getByRole("heading", { name: "brief.md" })).toBeVisible();
    expect(hiddenInspector()).not.toBeVisible();
    fireEvent.change(search, { target: { value: "" } });
    expect(within(objectList()).getAllByRole("button")).toHaveLength(1);
    expect(within(context()).getByRole("heading", { name: "brief.md" })).toBeVisible();
    showAllObjects();
    expect(within(objectList()).getAllByRole("button")).toHaveLength(data.nodes.length);
    const more = openMore();
    fireEvent.click(within(more).getByRole("checkbox", { name: "显示全部对象" }));
    expect(within(objectList()).getAllByRole("button")).toHaveLength(1);
    expect(within(context()).getByRole("heading", { name: "brief.md" })).toBeVisible();
  });

  it("keeps document relationships primary and makes capability, host, workspace and scope configuration optional", () => {
    const capability: RelationshipNode = { ...source, id: "capability:read", kind: "capability", label: "Read" };
    const policy: RelationshipNode = { ...source, id: "policy:alice", kind: "policy", label: "Alice permissions" };
    const host: RelationshipNode = { ...source, id: "host:local", kind: "host", label: "Local host" };
    const workspace: RelationshipNode = { ...source, id: "workspace:local", kind: "workspace", label: "Test workspace" };
    const selector: RelationshipNode = { ...resource, id: "resource:selector", label: "knowledge/*.md", resourcePath: "knowledge/*.md", evidence, facts: [{ key: "kind", value: "selector" }] };
    const configuredContext: RelationshipNode = { ...source, id: "source:context", label: "Configured context", facts: [{ key: "kind", value: "context_provider" }] };
    const links: RelationshipGraphResponse = { ...data, nodes: [agent, source, resource, capability, policy, host, workspace, selector, configuredContext], edges: [
      ...data.edges,
      { ...data.edges[0]!, id: "allow", kind: "declares_allow", target: capability.id },
      { ...data.edges[0]!, id: "policy", kind: "has_policy", target: policy.id },
      { ...data.edges[0]!, id: "host", kind: "bound_to", target: host.id },
      { ...data.edges[0]!, id: "workspace", kind: "contains", source: workspace.id, target: agent.id },
      { ...data.edges[0]!, id: "context", target: configuredContext.id },
      { ...data.edges[1]!, id: "selector", target: selector.id },
    ] };
    const { props } = mount({ data: links });
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    expect(within(context()).getByRole("button", { name: "探索对象: Project docs" })).toBeVisible();
    const configuration = within(context()).getByText("能力与配置").closest("details")!;
    expect(configuration.open).toBe(false);
    expect(within(context()).getByRole("button", { name: "探索对象: Read", hidden: true })).not.toBeVisible();
    fireEvent.click(configuration.querySelector("summary")!);
    for (const name of ["Read", "Alice permissions", "Local host", "Test workspace", "Configured context"]) {
      expect(within(configuration).getByRole("button", { name: `探索对象: ${name}` })).toBeVisible();
    }
    fireEvent.click(within(configuration).getByRole("button", { name: "查看依据: Alice → 声明允许 → Read" }));
    expect(within(screen.getByRole("complementary", { name: "关系详情" })).getByText("配置声明，不代表运行时授权")).toBeVisible();
    fireEvent.keyDown(screen.getByRole("complementary", { name: "关系详情" }), { key: "Escape" });
    fireEvent.click(within(context()).getByRole("button", { name: "探索对象: Project docs" }));
    expect(within(context()).getByRole("button", { name: "探索对象: brief.md" })).toBeVisible();
    const scopeRules = within(context()).getByText("能力与配置").closest("details")!;
    expect(scopeRules.open).toBe(false);
    expect(within(context()).getByRole("button", { name: "探索对象: knowledge/*.md", hidden: true })).not.toBeVisible();
    fireEvent.click(scopeRules.querySelector("summary")!);
    fireEvent.click(within(scopeRules).getByRole("button", { name: "探索对象: knowledge/*.md" }));
    expect(within(context()).getByText("这是范围规则，不是实际文件。")).toBeVisible();
    expect(within(context()).queryByRole("button", { name: "打开文档" })).not.toBeInTheDocument();
    expect(props.onOpenResource).not.toHaveBeenCalled();
  });

  it("explains selectors as scope rules and never opens one as a discovered file", () => {
    const selector: RelationshipNode = { ...resource, id: "resource:selector", label: "knowledge/*.md", resourcePath: "knowledge/*.md", evidence, facts: [{ key: "kind", value: "selector" }] };
    const { props } = mount({ data: { ...data, nodes: [agent, source, selector], edges: [data.edges[0]!, { ...data.edges[1]!, target: selector.id }] } });
    showAllObjects();
    const button = within(objectList()).getByRole("button", { name: /knowledge\/\*\.md/ });
    fireEvent.click(button);
    expect(within(context()).getByText("这是范围规则，不是实际文件。")).toBeVisible();
    expect(hiddenInspector()).not.toBeVisible();
    inspectObject();
    expect(within(screen.getByRole("complementary", { name: "关系详情" })).queryByRole("button", { name: "打开文档" })).not.toBeInTheDocument();
    fireEvent.doubleClick(button);
    expect(props.onOpenResource).not.toHaveBeenCalled();
  });

  it("isolates context focus and trail by workspace and restores them without restoring an open inspector", () => {
    const { rerender, props } = mount();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "Alice" } });
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    fireEvent.click(within(context()).getByRole("button", { name: "探索对象: Project docs" }));
    inspectObject();
    expect(screen.getByRole("complementary", { name: "关系详情" })).toBeVisible();
    rerender(<RelationshipGraph {...props} workspaceKey={`context-other-${++uniqueScope}`} data={{ ...data, workspaceId: "other", nodes: [agent], edges: [] }} />);
    expect(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" })).toHaveValue("");
    expect(screen.queryByRole("navigation", { name: "探索路径" })).not.toBeInTheDocument();
    expect(within(context()).getByText("选一名员工看关联，或从资料查来源。")).toBeVisible();
    expect(hiddenInspector()).not.toBeVisible();
    rerender(<RelationshipGraph {...props} />);
    expect(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" })).toHaveValue("Alice");
    expect(within(context()).getByRole("heading", { name: "Project docs" })).toBeVisible();
    const trail = screen.getByRole("navigation", { name: "探索路径" });
    expect(within(trail).getByRole("button", { name: "Alice" })).toBeVisible();
    expect(within(trail).getByRole("button", { name: "Project docs" })).toHaveAttribute("aria-current", "location");
    expect(hiddenInspector()).not.toBeVisible();
  });

  it("remembers the explicit all-object preference per workspace without opening the advanced menu", () => {
    const { rerender, props } = mount();
    showAllObjects();
    expect(within(objectList()).getAllByRole("button")).toHaveLength(data.nodes.length);
    rerender(<RelationshipGraph {...props} workspaceKey={`all-objects-other-${++uniqueScope}`} />);
    expect(within(objectList()).getAllByRole("button")).toHaveLength(1);
    rerender(<RelationshipGraph {...props} />);
    expect(within(objectList()).getAllByRole("button")).toHaveLength(data.nodes.length);
    expect(screen.getByText("更多选项", { selector: "summary" }).closest("details")!.open).toBe(false);
    expect(hiddenInspector()).not.toBeVisible();
  });

  it("discloses the context cap independently of search and explores a neighbor beyond that cap", () => {
    const sources = Array.from({ length: 130 }, (_, index) => ({ ...source, id: `source:${index}`, label: `Source ${index}` }));
    const large = { ...data, nodes: [agent, ...sources], edges: sources.map(node => ({ ...data.edges[0]!, id: `binding:${node.id}`, target: node.id })) };
    mount({ data: large });
    const search = screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" });
    fireEvent.change(search, { target: { value: "agent:alice" } });
    expect(within(objectList()).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    expect(screen.getByText("显示 120 / 131 个对象。搜索或聚焦邻域可继续探索。")).toBeVisible();
    expect(within(context()).getAllByRole("button", { name: /^探索对象:/ })).toHaveLength(119);
    expect(within(context()).queryByRole("button", { name: "探索对象: Source 129" })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "Source 129" } });
    fireEvent.click(within(objectList()).getByRole("button", { name: /Source 129/ }));
    expect(within(context()).getByRole("heading", { name: "Source 129" })).toBeVisible();
    expect(within(context()).getByRole("button", { name: "探索对象: Alice" })).toBeVisible();
    expect(screen.queryByText("显示 120 / 131 个对象。搜索或聚焦邻域可继续探索。")).not.toBeInTheDocument();
  });

  it("keeps a large employee index reachable and discloses its cap instead of silently narrowing it to one neighbor", () => {
    const employees = Array.from({ length: 160 }, (_, index) => ({ ...agent, id: `agent:${index}`, positionId: String(index), label: `Employee ${index}` }));
    mount({ data: { ...data, nodes: employees, edges: [] } });
    expect(within(objectList()).getAllByRole("button")).toHaveLength(120);
    expect(screen.getByText("显示 120 / 160 个对象。搜索或聚焦邻域可继续探索。")).toBeVisible();
    const search = screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" });
    fireEvent.change(search, { target: { value: "Employee 159" } });
    expect(within(objectList()).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Employee 159 / }));
    expect(within(context()).getByRole("heading", { name: "Employee 159" })).toBeVisible();
    expect(hiddenInspector()).not.toBeVisible();
    fireEvent.change(search, { target: { value: "" } });
    expect(within(objectList()).getAllByRole("button")).toHaveLength(120);
    expect(within(context()).getByRole("heading", { name: "Employee 159" })).toBeVisible();
  });

  it("keeps chosen employees in a large diagram after clearing search or changing employees and preserves filters", () => {
    const employees = Array.from({ length: 160 }, (_, index) => ({ ...agent, id: `agent:${index}`, positionId: String(index), label: `Employee ${index}` }));
    const last = employees.at(-1)!;
    mount({ data: { ...data, nodes: [...employees, source, resource], edges: [{ ...data.edges[0]!, source: last.id }, data.edges[1]!] } });
    openMore();
    fireEvent.click(screen.getByText("类型与关系筛选", { selector: "summary" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^资源/ }));
    const search = screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" });
    fireEvent.change(search, { target: { value: "Employee 159" } });
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Employee 159 / }));
    fireEvent.change(search, { target: { value: "" } });
    expect(within(context()).getByRole("heading", { name: "Employee 159" })).toBeVisible();
    expect(within(objectList()).queryByRole("button", { name: /^Employee 159 / })).not.toBeInTheDocument();
    selectView("图形总览");
    expect(screen.getByRole("region", { name: "空间关系画布" })).toBeVisible();
    showAllObjects();
    expect(within(objectList()).getAllByRole("button")).toHaveLength(2);
    expect(within(objectList()).getByRole("button", { name: /^Employee 159 / })).toHaveAttribute("aria-pressed", "true");
    expect(within(objectList()).getByRole("button", { name: /Project docs/ })).toBeVisible();
    expect(within(objectList()).queryByRole("button", { name: /^Employee 0 / })).not.toBeInTheDocument();
    expect(search).toHaveValue("");
    openMore();
    expect(screen.getByRole("checkbox", { name: /^资源/ })).not.toBeChecked();
    fireEvent.keyDown(screen.getByText("更多选项", { selector: "summary" }), { key: "Escape" });
    inspectObject();
    const inspector = screen.getByRole("complementary", { name: "关系详情" });
    expect(within(inspector).getByRole("heading", { name: "Employee 159" })).toBeVisible();
    expect(within(inspector).queryByText("当前选择不在筛选结果中")).not.toBeInTheDocument();
    fireEvent.click(within(inspector).getByRole("button", { name: "关闭详情" }));
    fireEvent.click(within(openMore()).getByRole("checkbox", { name: "显示全部对象" }));
    fireEvent.keyDown(screen.getByText("更多选项", { selector: "summary" }), { key: "Escape" });
    expect(within(objectList()).getAllByRole("button")).toHaveLength(120);
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Employee 100 / }));
    showAllObjects();
    expect(within(objectList()).getAllByRole("button")).toHaveLength(1);
    expect(within(objectList()).getByRole("button", { name: /^Employee 100 / })).toHaveAttribute("aria-pressed", "true");
    expect(within(objectList()).queryByRole("button", { name: /^Employee 159 / })).not.toBeInTheDocument();
    expect(search).toHaveValue("");
    inspectObject();
    expect(within(inspector).getByRole("heading", { name: "Employee 100" })).toBeVisible();
    expect(within(inspector).queryByText("当前选择不在筛选结果中")).not.toBeInTheDocument();
  });

  it("distinguishes filtered focus from deleted objects even when an updated graph is empty", () => {
    const { rerender, props } = mount();
    showAllObjects();
    fireEvent.click(within(objectList()).getByRole("button", { name: /brief.md/ }));
    openMore();
    fireEvent.click(screen.getByText("类型与关系筛选", { selector: "summary" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^资源/ }));
    expect(within(context()).getByText("当前选择不在筛选结果中")).toBeVisible();
    expect(within(context()).queryByText("该对象或关系已不在当前数据中")).not.toBeInTheDocument();
    rerender(<RelationshipGraph {...props} data={{ ...data, revision: "deleted", nodes: [], edges: [] }} />);
    expect(within(context()).getByText("该对象或关系已不在当前数据中")).toBeVisible();
    expect(within(context()).queryByText("当前选择不在筛选结果中")).not.toBeInTheDocument();
    expect(within(context()).queryByText("选一名员工看关联，或从资料查来源。")).not.toBeInTheDocument();
  });

  it("identifies same-named resources by owner and opens only the chosen owner's exact path", () => {
    const bob: RelationshipNode = { ...agent, id: "agent:bob", label: "Bob", positionId: "bob" };
    const bobResource: RelationshipNode = { ...resource, id: "resource:bob-brief", positionId: "bob" };
    const { props } = mount({ data: { ...data, nodes: [agent, bob, resource, bobResource], edges: [] } });
    showAllObjects();
    expect(within(objectList()).getByRole("button", { name: /brief.md Alice · knowledge\/brief.md/ })).toBeVisible();
    fireEvent.click(within(objectList()).getByRole("button", { name: /brief.md Bob · knowledge\/brief.md/ }));
    expect(hiddenInspector()).not.toBeVisible();
    inspectObject();
    fireEvent.click(within(screen.getByRole("complementary", { name: "关系详情" })).getByRole("button", { name: "打开文档" }));
    expect(props.onOpenResource).toHaveBeenCalledExactlyOnceWith("bob", "knowledge/brief.md");
  });

  it("focuses explicitly requested evidence and returns focus without discarding exploration", () => {
    const { props } = mount();
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    const evidenceButton = within(context()).getByRole("button", { name: /查看依据: Alice → 声明来源 → Project docs/ });
    evidenceButton.focus();
    fireEvent.click(evidenceButton);
    const inspector = screen.getByRole("complementary", { name: "关系详情" });
    expect(inspector).toHaveFocus();
    expect(within(inspector).getByRole("heading", { name: "这条关系的依据" })).toBeVisible();
    fireEvent.keyDown(inspector, { key: "Escape" });
    expect(inspector).not.toBeVisible();
    expect(evidenceButton).toHaveFocus();
    expect(within(context()).getByRole("heading", { name: "Alice" })).toBeVisible();
    const objectEvidence = screen.getByRole("button", { name: "对象依据" });
    objectEvidence.focus();
    fireEvent.click(objectEvidence);
    expect(inspector).toHaveFocus();
    expect(within(inspector).getByRole("heading", { name: "Alice" })).toBeVisible();
    fireEvent.click(within(inspector).getByRole("button", { name: "关闭详情" }));
    expect(inspector).not.toBeVisible();
    expect(objectEvidence).toHaveFocus();
    expect(within(objectList()).getByRole("button", { name: /^Alice / })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("navigation", { name: "探索路径" })).not.toBeInTheDocument();
    expect(props.onOpenAgent).not.toHaveBeenCalled();
    expect(props.onOpenResource).not.toHaveBeenCalled();
  });

  it("returns keyboard focus to the object list if the evidence origin was folded away", () => {
    const capability: RelationshipNode = { ...source, id: "capability:read", kind: "capability", label: "Read" };
    mount({ data: { ...data, nodes: [agent, capability], edges: [{ ...data.edges[0]!, id: "allow", kind: "declares_allow", target: capability.id }] } });
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    const configuration = within(context()).getByText("能力与配置").closest("details")!;
    const summary = configuration.querySelector("summary")!;
    fireEvent.click(summary);
    const evidenceButton = within(configuration).getByRole("button", { name: "查看依据: Alice → 声明允许 → Read" });
    evidenceButton.focus();
    fireEvent.click(evidenceButton);
    const inspector = screen.getByRole("complementary", { name: "关系详情" });
    expect(inspector).toHaveFocus();
    fireEvent.click(summary);
    expect(configuration.open).toBe(false);
    fireEvent.keyDown(inspector, { key: "Escape" });
    expect(inspector).not.toBeVisible();
    expect(objectList().closest(".owb-rgraph__results")).toHaveFocus();
    expect(within(context()).getByRole("heading", { name: "Alice" })).toBeVisible();
  });

  it("offers two advanced views, collapses the chooser after switching and remembers view per workspace", () => {
    const { rerender, props } = mount({ workspaceKey: `renderer-memory-${++uniqueScope}` });
    const more = openMore();
    const renderer = within(more).getByRole("group", { name: "显示方式" });
    expect(within(renderer).getAllByRole("button")).toHaveLength(2);
    expect(within(renderer).getByRole("button", { name: "关联列表" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(renderer).getByRole("button", { name: "图形总览" }));
    expect(more.open).toBe(false);
    expect(screen.getByRole("region", { name: "空间关系画布" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "空间布局" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "空间主题" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "brief" } });
    fireEvent.click(within(objectList()).getByRole("button", { name: /brief.md/ }));
    inspectObject();
    rerender(<RelationshipGraph {...props} workspaceKey={`renderer-other-${++uniqueScope}`} />);
    expect(screen.queryByRole("region", { name: "空间关系画布" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" })).toHaveValue("");
    expect(hiddenInspector()).not.toBeVisible();
    rerender(<RelationshipGraph {...props} />);
    expect(screen.getByRole("region", { name: "空间关系画布" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" })).toHaveValue("brief");
    expect(within(objectList()).getByRole("button", { name: /brief.md/ })).toHaveAttribute("aria-pressed", "true");
    expect(hiddenInspector()).not.toBeVisible();
    selectView("关联列表");
    expect(within(context()).getByRole("heading", { name: "brief.md" })).toBeVisible();
  });

  it("uses the same filtered projection and unique accessible list for the graphical overview", () => {
    mount({}, "galaxy");
    showAllObjects();
    const scene = screen.getByRole("region", { name: "空间关系画布" });
    expect(scene).toHaveAttribute("data-visual-style", "yuanyang-galaxy");
    expect(scene).toHaveAttribute("data-navigation", "hidden");
    expect(within(scene).queryByRole("list")).not.toBeInTheDocument();
    expect(within(scene).getByRole("button", { name: "重置视图" })).toBeVisible();
    expect(within(objectList()).getAllByRole("button")).toHaveLength(data.nodes.length);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "brief" } });
    expect(within(objectList()).getAllByRole("button")).toHaveLength(1);
    expect(within(objectList()).queryByRole("button", { name: /^Alice\s/ })).not.toBeInTheDocument();
    fireEvent.click(within(objectList()).getByRole("button", { name: /brief.md/ }));
    expect(hiddenInspector()).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "沿关系探索" }));
    expect(within(context()).getByRole("heading", { name: "brief.md" })).toBeVisible();
    expect(hiddenInspector()).not.toBeVisible();
  });

  it("returns keyboard focus to related context when leaving the diagram toolbar", () => {
    mount({}, "galaxy");
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    const follow = screen.getByRole("button", { name: "沿关系探索" });
    follow.focus();
    expect(follow).toHaveFocus();
    fireEvent.click(follow);
    expect(screen.queryByRole("region", { name: "空间关系画布" })).not.toBeInTheDocument();
    expect(within(context()).getByRole("heading", { name: "Alice" })).toBeVisible();
    expect(screen.getByLabelText("关联上下文", { selector: "div.owb-rgraph__main" })).toHaveFocus();
    expect(hiddenInspector()).not.toBeVisible();
    expect(within(objectList()).getByRole("button", { name: /^Alice / })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps Sidebar buttons focusable and opens exact resources only after an explicit action", () => {
    const { props } = mount({}, "galaxy");
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "brief" } });
    const button = within(objectList()).getByRole("button", { name: /brief.md/ });
    expect(button.tagName).toBe("BUTTON");
    expect(button.tabIndex).toBe(0);
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(hiddenInspector()).not.toBeVisible();
    expect(props.onOpenResource).not.toHaveBeenCalled();
    inspectObject();
    fireEvent.click(within(screen.getByRole("complementary", { name: "关系详情" })).getByRole("button", { name: "打开文档" }));
    expect(props.onOpenResource).toHaveBeenCalledExactlyOnceWith("alice", "knowledge/brief.md");
  });

  it("reveals the optional relationship list and returns to objects without inventing authorization", () => {
    mount();
    expect(screen.queryByRole("list", { name: "关系" })).not.toBeInTheDocument();
    fireEvent.click(within(openMore()).getByRole("checkbox", { name: "关系列表" }));
    fireEvent.click(within(screen.getByRole("list", { name: "关系" })).getByRole("button", { name: /Alice → 声明来源 → Project docs/ }));
    const inspector = screen.getByRole("complementary", { name: "关系详情" });
    expect(within(inspector).getByText("配置声明，不代表运行时授权")).toBeVisible();
    expect(within(inspector).getByText("workspace-org.v1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "返回对象列表" }));
    expect(screen.queryByRole("list", { name: "关系" })).not.toBeInTheDocument();
    expect(within(objectList()).getAllByRole("button")).toHaveLength(1);
  });

  it("preserves selection on same-workspace data updates without opening an inspector", () => {
    const { rerender, props } = mount({}, "galaxy");
    fireEvent.click(within(objectList()).getByRole("button", { name: /^Alice / }));
    rerender(<RelationshipGraph {...props} data={{ ...data, revision: "two", nodes: [...data.nodes, { ...agent, id: "agent:bob", positionId: "bob", label: "Bob" }] }} />);
    expect(within(objectList()).getByRole("button", { name: /^Alice / })).toHaveAttribute("aria-pressed", "true");
    expect(within(objectList()).getByRole("button", { name: /^Bob / })).toBeVisible();
    expect(screen.getByRole("region", { name: "空间关系画布" })).toBeVisible();
    expect(hiddenInspector()).not.toBeVisible();
  });

  it("retains isolated objects and bounds large graphs while allowing search outside the initial neighborhood", () => {
    const isolated = { ...agent, id: "isolated", label: "Isolated" };
    const options = { query: "", kinds: ["agent"] as const, relations: ["reports_to"] as const, neighborhood: null };
    expect(projectRelationships({ ...data, nodes: [isolated], edges: [] }, options).nodes).toEqual([isolated]);
    const large = { ...data, nodes: Array.from({ length: 160 }, (_, index) => ({ ...agent, id: `agent:${index}`, label: `Employee ${index}` })), edges: [] };
    const first = projectRelationships(large, options);
    expect(first.bounded).toBe(true);
    expect(first.nodes.length).toBeLessThanOrEqual(120);
    expect(projectRelationships(large, { ...options, query: "Employee 159" }).nodes.map(node => node.id)).toEqual(["agent:159"]);
  });

  it("retains explicit one-hop and two-hop projection without treating an object's selection as a filter", () => {
    const options = { query: "agent:alice", kinds: ["agent", "source", "resource"] as const, relations: ["declares_source", "contains_resource"] as const, neighborhood: null };
    expect(projectRelationships(data, options).nodes.map(node => node.id)).toEqual([agent.id]);
    expect(projectRelationships(data, { ...options, neighborhood: { id: agent.id, hops: 1 } }).nodes.map(node => node.id)).toEqual([agent.id, source.id]);
    expect(projectRelationships(data, { ...options, neighborhood: { id: agent.id, hops: 2 } }).nodes.map(node => node.id)).toEqual([agent.id, source.id, resource.id]);
  });

  it("separates actionable source failures and filtered-empty from an empty workspace", () => {
    const { props } = mount({ error: "Upstream offline", data: { ...data, coverage: [{ source: "mem", state: "error", reason: "upstream_failed" }] } });
    expect(screen.getByText("关系暂时读取失败，请重试。")).toBeVisible();
    expect(screen.queryByText("Upstream offline")).not.toBeInTheDocument();
    const notice = screen.getByRole("button", { name: "1 个来源待处理" });
    expect(notice).toBeVisible();
    expect(screen.getByText("无法读取已连接服务，请检查连接后刷新。")).not.toBeVisible();
    fireEvent.click(notice);
    const more = screen.getByText("更多选项", { selector: "summary" }).closest("details")!;
    const sourceSummary = within(more).getByText("来源信息").closest("summary")!;
    expect(more.open).toBe(true);
    expect(sourceSummary.closest("details")!.open).toBe(true);
    expect(sourceSummary).toHaveFocus();
    expect(within(more).getByText("网盘文件")).toBeVisible();
    expect(within(more).getByText("无法读取已连接服务，请检查连接后刷新。")).toBeVisible();
    fireEvent.click(within(notice.closest("header")!).getByRole("button", { name: "刷新关系" }));
    expect(props.onReload).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "no-match" } });
    expect(screen.getAllByText("没有符合筛选的对象").length).toBeGreaterThan(0);
    expect(screen.queryByText("当前工作区还没有关系对象")).not.toBeInTheDocument();
    openMore();
    fireEvent.click(screen.getByText("类型与关系筛选", { selector: "summary" }));
    fireEvent.click(within(openMore()).getByRole("button", { name: "清除筛选" }));
    expect(within(objectList()).getAllByRole("button")).toHaveLength(1);
  });

  it("keeps every object keyboard-accessible when WebGL is unavailable", async () => {
    mount({}, "galaxy");
    showAllObjects();
    expect(await screen.findByText("当前环境不支持 WebGL，可在对象列表中用键盘浏览同一组关系对象。")).toBeVisible();
    const objects = objectList();
    expect(within(objects).getAllByRole("button")).toHaveLength(data.nodes.length);
    expect(screen.queryByRole("list", { name: "空间关系对象" })).not.toBeInTheDocument();
    const button = within(objects).getByRole("button", { name: /brief.md Alice · knowledge\/brief.md/ });
    expect(button.tabIndex).toBe(0);
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(hiddenInspector()).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "沿关系探索" }));
    expect(within(context()).getByRole("heading", { name: "brief.md" })).toBeVisible();
  });

  it("keeps standalone minimal scene navigation and controls compatible without a formal graph Sidebar", async () => {
    const onSelect = vi.fn(), onLayoutChange = vi.fn(), onThemeChange = vi.fn();
    render(<RelationshipSpatialScene nodes={data.nodes} edges={data.edges} mode="minimal" layout="topology" theme="light"
      showKnowledgeRelationships onLayoutChange={onLayoutChange} onThemeChange={onThemeChange} onShowKnowledgeRelationshipsChange={vi.fn()} onSelect={onSelect} />);
    expect(await screen.findByText(/当前环境不支持 WebGL/)).toBeVisible();
    const scene = screen.getByRole("region", { name: "极简关系空间" });
    expect(scene).toHaveAttribute("data-navigation", "visible");
    const objects = within(scene).getByRole("list", { name: "极简空间对象" });
    expect(within(objects).getAllByRole("button")).toHaveLength(data.nodes.length);
    const button = within(objects).getByRole("button", { name: "资源 · brief.md" });
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(resource.id);
    fireEvent.click(within(scene).getByRole("button", { name: "轨道" }));
    expect(onLayoutChange).toHaveBeenCalledExactlyOnceWith("orbit");
    fireEvent.click(within(scene).getByRole("button", { name: "黑白深色" }));
    expect(onThemeChange).toHaveBeenCalledExactlyOnceWith("dark");
  });
});
