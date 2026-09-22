import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RelationshipGraphResponse, RelationshipNode } from "@roleweave/shared";
import { projectRelationships, RelationshipGraph } from "../src/graph/RelationshipGraph";

const canvas = { instances: [] as any[], renderGate: null as Promise<void> | null };
vi.doMock("@antv/g6", () => ({ Graph: class {
  data: any = { nodes: [], edges: [] };
  events: Record<string, (event: any) => void> = {};
  options: any;
  constructor(options: any) { this.options = options; canvas.instances.push(this); }
  setData = vi.fn((data) => { this.data = data; });
  getNodeData = vi.fn(() => this.data.nodes);
  render = vi.fn(() => canvas.renderGate ?? Promise.resolve());
  draw = vi.fn().mockResolvedValue(undefined);
  fitView = vi.fn().mockResolvedValue(undefined);
  zoomBy = vi.fn().mockResolvedValue(undefined);
  zoomTo = vi.fn().mockResolvedValue(undefined);
  translateTo = vi.fn().mockResolvedValue(undefined);
  getZoom = vi.fn(() => 1.2);
  getPosition = vi.fn(() => [10, 20]);
  // G6's configured element style overrides datum.style. Model that boundary
  // so changing data colors cannot hide a stale constructor-level override.
  getElementRenderStyle = vi.fn((id: string) => {
    const node = this.data.nodes.find((item: any) => item.id === id);
    const edge = this.data.edges.find((item: any) => item.id === id);
    return node ? { ...node.style, ...this.options.node.style } : { ...edge?.style, ...this.options.edge.style };
  });
  setElementState = vi.fn().mockResolvedValue(undefined);
  resize = vi.fn();
  destroy = vi.fn();
  on = vi.fn((name, callback) => { this.events[name] = callback; });
} }));

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
async function readyGraph() {
  await waitFor(() => expect(canvas.instances.at(-1)?.setData).toHaveBeenCalled());
  return canvas.instances.at(-1)!;
}
function objectList() { return screen.getByRole("list", { name: "对象" }); }

beforeEach(() => { canvas.instances.length = 0; canvas.renderGate = null; });

describe("RelationshipGraph", () => {
  it("inspects a resource in place and opens its exact path only through an explicit action", async () => {
    const { props } = mount();
    await readyGraph();
    fireEvent.click(within(objectList()).getByRole("button", { name: /brief.md/ }));
    const inspector = screen.getByRole("complementary", { name: "关系详情" });
    expect(within(inspector).getByText("knowledge/brief.md")).toBeVisible();
    expect(props.onOpenAgent).not.toHaveBeenCalled();
    expect(props.onOpenResource).not.toHaveBeenCalled();
    fireEvent.click(within(inspector).getByRole("button", { name: "打开文档" }));
    expect(props.onOpenResource).toHaveBeenCalledWith("alice", "knowledge/brief.md");
    expect(props.onOpenAgent).not.toHaveBeenCalled();
  });

  it("uses exactly the same visible filtered collection for canvas and real keyboard list", async () => {
    mount();
    const graph = await readyGraph();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "brief" } });
    await waitFor(() => expect(graph.data.nodes.map((node: any) => node.id)).toEqual([resource.id]));
    expect(within(objectList()).getAllByRole("button")).toHaveLength(1);
    expect(within(objectList()).queryByRole("button", { name: /Alice/ })).not.toBeInTheDocument();
    const button = within(objectList()).getByRole("button", { name: /brief.md/ });
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(screen.getByRole("heading", { name: "brief.md" })).toBeVisible();
    expect(graph.data.edges).toHaveLength(0);
  });

  it("shows directed relation evidence and never turns a declaration into an authorization", async () => {
    mount();
    const graph = await readyGraph();
    expect(graph.data.edges[0].style.lineDash).toEqual([6, 4]);
    expect(graph.data.edges[1].style.lineDash).toEqual([]);
    expect(graph.options.edge.style.endArrow).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: /关系 2/ }));
    fireEvent.click(within(screen.getByRole("list", { name: "关系" })).getByRole("button", { name: /Alice → 声明来源 → Project docs/ }));
    const inspector = screen.getByRole("complementary", { name: "关系详情" });
    expect(within(inspector).getByText("配置声明，不代表运行时授权")).toBeVisible();
    expect(within(inspector).getByText("workspace-org.v1")).toBeVisible();
  });

  it("preserves dragged positions and selection on data updates without moving the viewport", async () => {
    const { rerender, props } = mount();
    const graph = await readyGraph();
    await waitFor(() => expect(graph.fitView).toHaveBeenCalledTimes(1));
    fireEvent.click(within(objectList()).getByRole("button", { name: /Alice/ }));
    graph.data.nodes.find((node: any) => node.id === agent.id).style.x = 777;
    graph.options.behaviors[2].onFinish();
    rerender(<RelationshipGraph {...props} data={{ ...data, revision: "two", nodes: [...data.nodes, { ...agent, id: "agent:bob", positionId: "bob", label: "Bob" }] }} />);
    await waitFor(() => expect(graph.data.nodes).toHaveLength(4));
    expect(graph.data.nodes.find((node: any) => node.id === agent.id).style.x).toBe(777);
    expect(within(objectList()).getByRole("button", { name: /Alice/ })).toHaveAttribute("aria-pressed", "true");
    expect(graph.fitView).toHaveBeenCalledTimes(1);
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

  it("keeps one-hop and two-hop exploration explicit rather than changing the graph on selection", async () => {
    mount();
    const graph = await readyGraph();
    fireEvent.click(within(objectList()).getByRole("button", { name: /Alice/ }));
    expect(graph.data.nodes).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "一跳邻域" }));
    await waitFor(() => expect(graph.data.nodes.map((node: any) => node.id)).toEqual([agent.id, source.id]));
    fireEvent.click(screen.getByRole("button", { name: "两跳邻域" }));
    await waitFor(() => expect(graph.data.nodes).toHaveLength(3));
  });

  it("expands neighbors with other names after searching for the starting employee", async () => {
    mount();
    const graph = await readyGraph();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "Alice" } });
    fireEvent.click(within(objectList()).getByRole("button", { name: /Alice/ }));
    fireEvent.click(screen.getByRole("button", { name: "一跳邻域" }));
    await waitFor(() => expect(graph.data.nodes.map((node: any) => node.id)).toEqual([agent.id, source.id]));
    expect(within(objectList()).getByRole("button", { name: /Project docs/ })).toBeVisible();
  });

  it("updates canvas colors after a theme switch without recreating the graph or fitting again", async () => {
    const { container } = mount();
    const graph = await readyGraph();
    await waitFor(() => expect(graph.fitView).toHaveBeenCalledTimes(1));
    const host = container.querySelector<HTMLElement>(".owb-rgraph__canvas")!;
    host.style.backgroundColor = "rgb(16, 32, 48)";
    host.style.color = "rgb(240, 240, 240)";
    await act(async () => { document.documentElement.setAttribute("data-theme", "dark"); await Promise.resolve(); });
    await waitFor(() => expect(graph.data.nodes[0].style.fill).toBe("rgb(16, 32, 48)"));
    expect(graph.data.nodes[0].style.labelFill).toBe("rgb(240, 240, 240)");
    expect(graph.getElementRenderStyle(agent.id)).toMatchObject({ fill: "rgb(16, 32, 48)", labelFill: "rgb(240, 240, 240)" });
    expect(graph.getElementRenderStyle("binding")).toMatchObject({ labelBackgroundFill: "rgb(16, 32, 48)", labelFill: "rgb(240, 240, 240)" });
    expect(canvas.instances).toHaveLength(1);
    expect(graph.fitView).toHaveBeenCalledTimes(1);
    await act(async () => { document.documentElement.removeAttribute("data-theme"); await Promise.resolve(); });
  });

  it("separates partial failure and filtered-empty from an empty workspace", async () => {
    mount({ error: "Upstream offline", data: { ...data, coverage: [{ source: "mem", state: "error" }] } });
    await readyGraph();
    expect(screen.getByText("关系暂时读取失败，请重试。")).toBeVisible();
    expect(screen.queryByText("Upstream offline")).not.toBeInTheDocument();
    expect(screen.getByText("当前结果不完整，可用关系仍可浏览。")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "no-match" } });
    expect(screen.getAllByText("没有符合筛选的对象").length).toBeGreaterThan(0);
    expect(screen.queryByText("当前工作区还没有关系对象")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(within(objectList()).getAllByRole("button")).toHaveLength(3);
  });

  it("isolates workspaces and restores a workspace's selection and search on return", async () => {
    const { rerender, props } = mount();
    await readyGraph();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" }), { target: { value: "brief" } });
    fireEvent.click(within(objectList()).getByRole("button", { name: /brief.md/ }));
    rerender(<RelationshipGraph {...props} workspaceKey="separate-workspace" data={{ ...data, workspaceId: "other", nodes: [agent], edges: [] }} />);
    expect(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" })).toHaveValue("");
    expect(screen.queryByRole("heading", { name: "brief.md" })).not.toBeInTheDocument();
    rerender(<RelationshipGraph {...props} />);
    expect(screen.getByRole("textbox", { name: "搜索名称、路径或员工 ID" })).toHaveValue("brief");
    expect(screen.getByRole("heading", { name: "brief.md" })).toBeVisible();
  });

  it("does not resize a hidden canvas to zero when visibility changes during queued drawing", async () => {
    const { container, rerender, props } = mount();
    const graph = await readyGraph();
    await waitFor(() => expect(graph.fitView).toHaveBeenCalledTimes(1));
    let release!: () => void;
    graph.draw.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const updated = { ...data, revision: "resizing" };
    rerender(<RelationshipGraph {...props} data={updated} />);
    await waitFor(() => expect(graph.draw).toHaveBeenCalled());
    const host = container.querySelector<HTMLElement>(".owb-rgraph__canvas")!;
    let width = 700;
    Object.defineProperty(host, "clientWidth", { get: () => width });
    Object.defineProperty(host, "clientHeight", { get: () => width ? 400 : 0 });
    rerender(<RelationshipGraph {...props} data={updated} visible={false} />);
    rerender(<RelationshipGraph {...props} data={updated} visible />);
    width = 0;
    rerender(<RelationshipGraph {...props} data={updated} visible={false} />);
    await act(async () => { release(); await Promise.resolve(); });
    expect(graph.resize).not.toHaveBeenCalledWith(0, 0);
    width = 700;
    rerender(<RelationshipGraph {...props} data={updated} visible />);
    await waitFor(() => expect(graph.resize).toHaveBeenCalledWith(700, 400));
    expect(graph.fitView).toHaveBeenCalledTimes(1);
  });

  it("waits for pending render before destruction and does not update a retired graph", async () => {
    let release!: () => void;
    canvas.renderGate = new Promise<void>(resolve => { release = resolve; });
    const { unmount } = mount();
    const graph = await readyGraph();
    unmount();
    expect(graph.destroy).not.toHaveBeenCalled();
    await act(async () => { release(); await Promise.resolve(); });
    await waitFor(() => expect(graph.destroy).toHaveBeenCalledTimes(1));
    expect(graph.fitView).not.toHaveBeenCalled();
    expect(graph.setElementState).not.toHaveBeenCalled();
  });
});
