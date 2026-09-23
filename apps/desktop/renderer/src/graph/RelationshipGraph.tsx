import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Empty, Input, Spin, Tag } from "antd";
import { ArrowUpRight, Focus, Network, RefreshCw, RotateCcw, Search, X, ZoomIn, ZoomOut } from "lucide-react";
import type { Graph, GraphData, Point } from "@antv/g6";
import { relationshipNodeKinds, type RelationshipEdge, type RelationshipGraphResponse, type RelationshipKind, type RelationshipNode, type RelationshipNodeKind } from "@roleweave/shared/relationship-graph";
import { useT, type OwbT } from "@roleweave/ui";
import "./RelationshipGraph.css";

export interface RelationshipGraphProps {
  data: RelationshipGraphResponse | null;
  loading: boolean;
  error?: string | null;
  workspaceKey?: string;
  visible?: boolean;
  onReload: () => void;
  onOpenAgent: (id: string) => void;
  onOpenResource: (positionId: string, path: string) => void;
}

const relationKinds: RelationshipKind[] = ["contains", "reports_to", "bound_to", "declares_source", "available_in", "contains_resource", "declares_allow", "declares_deny", "has_policy", "assigned_to", "requested_by", "budget_owner"];
const VISIBLE_LIMIT = 120;
type Selection = { type: "node" | "edge"; id: string } | null;
type Neighborhood = { id: string; hops: 1 | 2 } | null;
type Coordinates = { x: number; y: number };
interface RememberedView {
  query: string;
  kinds: RelationshipNodeKind[];
  relations: RelationshipKind[];
  selection: Selection;
  neighborhood: Neighborhood;
  positions: Map<string, Coordinates>;
  viewport?: { zoom: number; position: Point };
}
const rememberedViews = new Map<string, RememberedView>();
function remember(key: string, state: RememberedView) {
  if (!key) return;
  rememberedViews.delete(key);
  rememberedViews.set(key, state);
  while (rememberedViews.size > 5) rememberedViews.delete(rememberedViews.keys().next().value!);
}

/** The canvas and accessible list consume this exact same bounded projection. */
export function projectRelationships(data: RelationshipGraphResponse | null, options: {
  query: string; kinds: readonly RelationshipNodeKind[]; relations: readonly RelationshipKind[]; neighborhood: Neighborhood;
}) {
  if (!data) return { nodes: [] as RelationshipNode[], edges: [] as RelationshipEdge[], total: 0, bounded: false };
  // Searching finds a starting point; explicit neighborhood exploration uses
  // the whole type/relation-filtered graph, not only matching node labels.
  const query = options.neighborhood ? "" : options.query.trim().toLocaleLowerCase();
  const candidates = data.nodes.filter(node => options.kinds.includes(node.kind) && (!query || [node.label, node.positionId, node.resourcePath, node.id].some(value => value?.toLocaleLowerCase().includes(query))));
  const candidateIds = new Set(candidates.map(node => node.id));
  const edges = data.edges.filter(edge => options.relations.includes(edge.kind) && candidateIds.has(edge.source) && candidateIds.has(edge.target));
  let nodes = candidates;
  const focus = options.neighborhood ?? (!query && candidates.length > VISIBLE_LIMIT
    ? { id: candidates.find(node => node.kind === "agent")?.id ?? candidates[0]!.id, hops: 1 as const } : null);
  if (focus) {
    const ids = new Set([focus.id]);
    let frontier = new Set(ids);
    for (let hop = 0; hop < focus.hops; hop++) {
      const next = new Set<string>();
      for (const edge of edges) {
        if (frontier.has(edge.source) && !ids.has(edge.target)) next.add(edge.target);
        if (frontier.has(edge.target) && !ids.has(edge.source)) next.add(edge.source);
      }
      next.forEach(id => ids.add(id));
      frontier = next;
    }
    nodes = candidates.filter(node => ids.has(node.id));
    // Keep the focus object reachable even when its input ordering is late.
    nodes.sort((left, right) => Number(right.id === focus.id) - Number(left.id === focus.id));
  }
  const visible = nodes.slice(0, VISIBLE_LIMIT);
  const visibleIds = new Set(visible.map(node => node.id));
  return { nodes: visible, edges: edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)), total: candidates.length, bounded: visible.length < candidates.length };
}

const columns: Record<RelationshipNodeKind, number> = { workspace: 0, host: 0, agent: 1, goal: 1, task: 2, source: 2, resource: 3, capability: 3, policy: 3 };
const nodeColors: Record<RelationshipNodeKind, string> = { workspace: "#64748b", host: "#64748b", agent: "#3b82f6", source: "#0d9488", resource: "#a16207", capability: "#7c3aed", policy: "#be185d", goal: "#15803d", task: "#c2410c" };

function allocatePositions(nodes: RelationshipNode[], positions: Map<string, Coordinates>) {
  const occupied = new Set([...positions.values()].map(position => `${position.x}:${position.y}`));
  for (const node of nodes) {
    if (positions.has(node.id)) continue;
    const x = 130 + columns[node.kind] * 260;
    let y = 70;
    while (occupied.has(`${x}:${y}`)) y += 112;
    positions.set(node.id, { x, y });
    occupied.add(`${x}:${y}`);
  }
}

function evidenceDetails(evidence: RelationshipNode["evidence"], t: OwbT) {
  return <dl className="owb-rgraph__facts">
    <dt>{t("graph.source")}</dt><dd>{evidence.source}</dd>
    <dt>{t("graph.locator")}</dt><dd>{evidence.locator}</dd>
    <dt>{t("graph.observedAt")}</dt><dd>{evidence.observedAt}</dd>
  </dl>;
}

export function RelationshipGraph(props: RelationshipGraphProps) {
  const scope = props.workspaceKey ?? props.data?.workspaceId ?? "";
  return <RelationshipGraphWorkspace key={scope} {...props} scope={scope} />;
}

function RelationshipGraphWorkspace({ data, loading, error, visible = true, onReload, onOpenAgent, onOpenResource, scope }: RelationshipGraphProps & { scope: string }) {
  const t = useT();
  const initial = useRef(rememberedViews.get(scope));
  const [query, setQuery] = useState(initial.current?.query ?? "");
  const [kinds, setKinds] = useState<RelationshipNodeKind[]>(initial.current?.kinds ?? [...relationshipNodeKinds]);
  const [relations, setRelations] = useState<RelationshipKind[]>(initial.current?.relations ?? [...relationKinds]);
  const [selection, setSelection] = useState<Selection>(initial.current?.selection ?? null);
  const [neighborhood, setNeighborhood] = useState<Neighborhood>(initial.current?.neighborhood ?? null);
  const [listMode, setListMode] = useState<"nodes" | "edges">("nodes");
  const [canvasError, setCanvasError] = useState(false);
  const [ready, setReady] = useState(0);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [themeRevision, setThemeRevision] = useState(0);
  const canvas = useRef<HTMLDivElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const queue = useRef(Promise.resolve());
  const rendered = useRef(false);
  const fitted = useRef(false);
  const positions = useRef(new Map(initial.current?.positions));
  const skipPositionRead = useRef(false);
  const viewport = useRef(initial.current?.viewport);
  const latest = useRef({ data, selection, visible, onOpenAgent, onOpenResource });
  latest.current = { data, selection, visible, onOpenAgent, onOpenResource };
  const view = useMemo(() => projectRelationships(data, { query, kinds, relations, neighborhood }), [data, query, kinds, relations, neighborhood]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const nodesById = useMemo(() => new Map(data?.nodes.map(node => [node.id, node])), [data]);
  const selectedNode = selection?.type === "node" ? nodesById.get(selection.id) : undefined;
  const selectedEdge = selection?.type === "edge" ? data?.edges.find(edge => edge.id === selection.id) : undefined;
  const selectedVisible = !selection || (selection.type === "node" ? view.nodes : view.edges).some(item => item.id === selection.id);
  const stateForCache = useRef<RememberedView>({ query, kinds, relations, selection, neighborhood, positions: positions.current });
  stateForCache.current = { query, kinds, relations, selection, neighborhood, positions: positions.current, viewport: viewport.current };

  const enqueue = useCallback((operation: (graph: Graph) => Promise<unknown> | void) => {
    const graph = graphRef.current;
    if (!graph) return;
    queue.current = queue.current.then(async () => {
      if (graphRef.current === graph) await operation(graph);
    }).catch(() => { if (graphRef.current === graph) setCanvasError(true); });
  }, []);

  const rememberPositions = useCallback((graph: Graph) => {
    for (const node of graph.getNodeData()) {
      const x = node.style?.x;
      const y = node.style?.y;
      if (typeof x === "number" && typeof y === "number") positions.current.set(node.id, { x, y });
    }
  }, []);

  const openNode = useCallback((id: string) => {
    const current = latest.current;
    const node = current.data?.nodes.find(item => item.id === id);
    if (node?.kind === "agent" && node.positionId) current.onOpenAgent(node.positionId);
    if (node?.kind === "resource" && node.positionId && node.resourcePath) current.onOpenResource(node.positionId, node.resourcePath);
  }, []);

  useEffect(() => {
    let alive = true;
    let owned: Graph | null = null;
    let observer: ResizeObserver | undefined;
    void import("@antv/g6").then(({ Graph: GraphConstructor }) => {
      const host = canvas.current;
      if (!alive || !host) return;
      owned = new GraphConstructor({
        container: host, width: host.clientWidth || 680, height: host.clientHeight || 470,
        animation: false, zoomRange: [0.12, 2.5], padding: 35,
        node: { type: "rect", style: { size: [184, 58], radius: 10, labelPlacement: "center", labelFontSize: 14, labelWordWrap: true, labelMaxWidth: 164, labelMaxLines: 2, lineWidth: 1.5 }, state: { selected: { lineWidth: 3, shadowBlur: 8, shadowColor: "#3b82f666" } } },
        edge: { type: "cubic-horizontal", style: { endArrow: true, lineWidth: 1.2, stroke: "#8a94a5", labelFontSize: 10, labelBackground: true, labelPadding: [2, 4], labelAutoRotate: false }, state: { selected: { lineWidth: 3, stroke: "#3b82f6" } } },
        behaviors: ["drag-canvas", "zoom-canvas", { type: "drag-element", animation: false, dropEffect: "none", onFinish: () => { if (owned && alive) rememberPositions(owned); } }],
      });
      graphRef.current = owned;
      const eventId = (event: unknown) => {
        const target = (event as { target?: { id?: unknown } }).target;
        return typeof target?.id === "string" ? target.id : undefined;
      };
      owned.on("node:click", (event) => { const id = eventId(event); if (id && alive) setSelection({ type: "node", id }); });
      owned.on("edge:click", (event) => { const id = eventId(event); if (id && alive) setSelection({ type: "edge", id }); });
      owned.on("node:dblclick", (event) => { const id = eventId(event); if (id && alive) openNode(id); });
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => {
          const width = host.clientWidth;
          const height = host.clientHeight;
          if (alive && latest.current.visible && width > 0 && height > 0) enqueue(graph => {
            if (latest.current.visible) graph.resize(width, height);
          });
        });
        observer.observe(host);
      }
      setReady(value => value + 1);
    }).catch(() => { if (alive) setCanvasError(true); });
    return () => {
      alive = false;
      observer?.disconnect();
      if (owned && rendered.current) {
        rememberPositions(owned);
        viewport.current = { zoom: owned.getZoom(), position: owned.getPosition() };
      }
      remember(scope, { ...stateForCache.current, positions: new Map(positions.current), viewport: viewport.current });
      graphRef.current = null;
      // G6 draw/render are async. Destroy only after queued work settles.
      const retiring = owned;
      void queue.current.finally(() => retiring?.destroy());
    };
  }, [enqueue, openNode, rememberPositions, scope]);

  useEffect(() => {
    const observer = new MutationObserver(records => {
      const hasOverride = (node: globalThis.Node) => node instanceof Element && node.id === "roleweave-theme-overrides";
      if (records.some(record => record.target === document.documentElement || hasOverride(record.target) || [...record.addedNodes, ...record.removedNodes].some(hasOverride))) setThemeRevision(value => value + 1);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-ui-theme", "style"] });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  const applySelection = useCallback(async (graph: Graph) => {
    const selected = latest.current.selection;
    await graph.setElementState(Object.fromEntries([...viewRef.current.nodes, ...viewRef.current.edges].map(item => [item.id, selected?.id === item.id ? ["selected"] : []])), false);
  }, []);

  useEffect(() => {
    if (!ready) return;
    enqueue(async graph => {
      if (rendered.current && !skipPositionRead.current) rememberPositions(graph);
      skipPositionRead.current = false;
      allocatePositions(view.nodes, positions.current);
      const theme = canvas.current ? getComputedStyle(canvas.current) : null;
      const graphData: GraphData = {
        nodes: view.nodes.map(node => ({ id: node.id, data: { kind: node.kind }, style: { ...positions.current.get(node.id), fill: theme?.backgroundColor, labelFill: theme?.color, stroke: nodeColors[node.kind], labelText: `${t(`graph.kind.${node.kind}`)} · ${node.label}` } })),
        edges: view.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, style: { labelFill: theme?.color, labelBackgroundFill: theme?.backgroundColor, labelText: t(`graph.relation.${edge.kind}`), lineDash: edge.evidence.basis === "declared" ? [6, 4] : [] } })),
      };
      graph.setData(graphData);
      if (rendered.current) await graph.draw(); else { await graph.render(); rendered.current = true; }
      if (graphRef.current !== graph) return;
      await applySelection(graph);
      if (!fitted.current && view.nodes.length && latest.current.visible) {
        if (viewport.current) { await graph.zoomTo(viewport.current.zoom, false); await graph.translateTo(viewport.current.position, false); }
        else await graph.fitView({}, false);
        fitted.current = true;
      }
      setCanvasError(false);
    });
  }, [data, view, t, ready, layoutRevision, themeRevision, enqueue, rememberPositions, applySelection]);

  useEffect(() => { if (ready) enqueue(applySelection); }, [selection, ready, enqueue, applySelection]);
  useEffect(() => {
    const host = canvas.current;
    const width = host?.clientWidth ?? 0;
    const height = host?.clientHeight ?? 0;
    if (ready && visible && width > 0 && height > 0) enqueue(async graph => {
      if (!latest.current.visible) return;
      graph.resize(width, height);
      if (!fitted.current && viewRef.current.nodes.length) {
        if (viewport.current) { await graph.zoomTo(viewport.current.zoom, false); await graph.translateTo(viewport.current.position, false); }
        else await graph.fitView({}, false);
        fitted.current = true;
      }
    });
  }, [visible, ready, enqueue]);

  const clearFilters = () => { setQuery(""); setKinds([...relationshipNodeKinds]); setRelations([...relationKinds]); setNeighborhood(null); };
  const exploreNeighborhood = (hops: 1 | 2) => {
    if (!selectedNode) return;
    setQuery("");
    setNeighborhood({ id: selectedNode.id, hops });
  };
  const closeDetails = () => { setSelection(null); results.current?.focus(); };
  const relationText = (edge: RelationshipEdge) => `${nodesById.get(edge.source)?.label ?? edge.source} → ${t(`graph.relation.${edge.kind}`)} → ${nodesById.get(edge.target)?.label ?? edge.target}`;
  const partial = data?.truncated || data?.coverage.some(item => item.state !== "complete");

  return <section className="owb-rgraph" aria-label={t("graph.title")} onKeyDown={event => { if (event.key === "Escape" && selection) closeDetails(); }}>
    <header className="owb-rgraph__header"><div><h1><Network size={19} aria-hidden="true" />{t("graph.title")}</h1><p>{t("graph.subtitle")}</p></div><Button icon={<RefreshCw size={14} />} onClick={onReload} loading={loading}>{t("graph.reload")}</Button></header>
    {error ? <Alert type="error" title={t("graph.loadFailure")} showIcon action={<Button size="small" onClick={onReload}>{t("graph.reload")}</Button>} /> : null}
    {partial ? <Alert type="warning" title={t("graph.partial")} showIcon /> : null}
    <div className={`owb-rgraph__workspace${selection ? " has-selection" : ""}`}>
      <aside className="owb-rgraph__filters" aria-label={t("graph.filters")}>
        <Input prefix={<Search size={14} aria-hidden="true" />} aria-label={t("graph.search")} placeholder={t("graph.search")} value={query} allowClear onChange={event => { setQuery(event.target.value); setNeighborhood(null); }} />
        <fieldset><legend>{t("graph.entities")}</legend><div className="owb-rgraph__filter-actions"><button onClick={() => setKinds([...relationshipNodeKinds])}>{t("graph.all")}</button><button onClick={() => setKinds([])}>{t("graph.none")}</button></div>
          {relationshipNodeKinds.map(kind => <Checkbox key={kind} checked={kinds.includes(kind)} onChange={event => setKinds(current => event.target.checked ? [...current, kind] : current.filter(value => value !== kind))}><i className="owb-rgraph__kind-dot" style={{ background: nodeColors[kind] }} />{t(`graph.kind.${kind}`)}<span className="owb-rgraph__count">{data?.nodes.filter(node => node.kind === kind).length ?? 0}</span></Checkbox>)}
        </fieldset>
        <fieldset><legend>{t("graph.relations")}</legend>{relationKinds.filter(kind => data?.edges.some(edge => edge.kind === kind)).map(kind => <Checkbox key={kind} checked={relations.includes(kind)} onChange={event => setRelations(current => event.target.checked ? [...current, kind] : current.filter(value => value !== kind))}>{t(`graph.relation.${kind}`)}</Checkbox>)}</fieldset>
        {data ? <details className="owb-rgraph__coverage"><summary>{t("graph.coverage")}</summary>{data.coverage.map((item, index) => <div key={`${item.source}:${index}`}><span>{item.source}</span><Tag color={item.state === "complete" ? "default" : "warning"}>{t(`graph.coverage.${item.state}`)}</Tag>{item.count !== undefined ? <small>{item.count}</small> : null}</div>)}</details> : null}
      </aside>
      <div className="owb-rgraph__main">
        <div className="owb-rgraph__toolbar" role="toolbar" aria-label={t("graph.canvas")}>
          <div><Button title={t("graph.zoomOut")} aria-label={t("graph.zoomOut")} icon={<ZoomOut size={15} />} onClick={() => enqueue(graph => graph.zoomBy(0.8, false))} /><Button title={t("graph.zoomIn")} aria-label={t("graph.zoomIn")} icon={<ZoomIn size={15} />} onClick={() => enqueue(graph => graph.zoomBy(1.25, false))} /><Button title={t("graph.fit")} aria-label={t("graph.fit")} icon={<Focus size={15} />} onClick={() => enqueue(graph => graph.fitView({}, false))} /><Button title={t("graph.reset")} aria-label={t("graph.reset")} icon={<RotateCcw size={14} />} onClick={() => { positions.current.clear(); skipPositionRead.current = true; viewport.current = undefined; fitted.current = false; setLayoutRevision(value => value + 1); }} /></div>
          <div><Button size="small" disabled={!selectedNode} aria-pressed={neighborhood?.hops === 1} onClick={() => exploreNeighborhood(1)}>{t("graph.oneHop")}</Button><Button size="small" disabled={!selectedNode} aria-pressed={neighborhood?.hops === 2} onClick={() => exploreNeighborhood(2)}>{t("graph.twoHop")}</Button><Button size="small" onClick={() => setNeighborhood(null)}>{t("graph.overview")}</Button></div>
        </div>
        <div className="owb-rgraph__canvas-wrap">
          <div ref={canvas} className="owb-rgraph__canvas" role="img" aria-label={t("graph.canvas")} />
          {!data || !view.nodes.length ? <div className="owb-rgraph__canvas-message">{loading ? <Spin tip={t("graph.loading")}><div className="owb-rgraph__spinner-space" /></Spin> : <Empty description={data?.nodes.length ? t("graph.filteredEmpty") : data ? t("graph.empty") : t("graph.noData")} image={Empty.PRESENTED_IMAGE_SIMPLE}>{data?.nodes.length ? <Button onClick={clearFilters}>{t("graph.clearFilters")}</Button> : null}</Empty>}</div> : null}
          {loading && data ? <span className="owb-rgraph__refreshing" role="status">{t("graph.refreshing")}</span> : null}
        </div>
        <div className="owb-rgraph__caption"><span>{t("graph.legend")}</span><span>{t("graph.gesture")}</span></div>
        {canvasError ? <Alert type="warning" showIcon title={t("graph.canvasFailure")} /> : null}
        <div ref={results} tabIndex={-1} className="owb-rgraph__results" aria-label={t("graph.list")}>
          <div className="owb-rgraph__result-head"><div role="tablist" aria-label={t("graph.list")}><button type="button" role="tab" aria-selected={listMode === "nodes"} onClick={() => setListMode("nodes")}>{t("graph.objects")} <span>{view.nodes.length}</span></button><button type="button" role="tab" aria-selected={listMode === "edges"} onClick={() => setListMode("edges")}>{t("graph.edges")} <span>{view.edges.length}</span></button></div><small>{t("graph.counts", { nodes: view.nodes.length, edges: view.edges.length })}</small></div>
          {view.bounded ? <p className="owb-rgraph__bounded" role="status">{t("graph.bounded", { visible: view.nodes.length, total: view.total })}</p> : null}
          <ul className="owb-rgraph__list" aria-label={t(listMode === "nodes" ? "graph.objects" : "graph.edges")}>
            {listMode === "nodes" ? view.nodes.map(node => <li key={node.id}><button type="button" aria-pressed={selection?.id === node.id} onClick={() => setSelection({ type: "node", id: node.id })} onDoubleClick={() => openNode(node.id)}><i className="owb-rgraph__kind-dot" style={{ background: nodeColors[node.kind] }} /><span><strong>{node.label}</strong><small>{node.resourcePath ?? t(`graph.kind.${node.kind}`)}</small></span><Tag>{t(`graph.state.${node.state}`)}</Tag></button></li>) : view.edges.map(edge => <li key={edge.id}><button type="button" aria-pressed={selection?.id === edge.id} onClick={() => setSelection({ type: "edge", id: edge.id })}><span><strong>{relationText(edge)}</strong><small>{edge.evidence.source}</small></span><Tag>{t(`graph.${edge.evidence.basis}`)}</Tag></button></li>)}
          </ul>
          {!view.nodes.length && data?.nodes.length ? <p>{t("graph.filteredEmpty")}</p> : null}
        </div>
        {data ? <footer className="owb-rgraph__timestamp">{t("graph.updated", { time: data.generatedAt })}</footer> : null}
      </div>
      <aside className="owb-rgraph__inspector" aria-label={t("graph.inspector")}>
        <header><h2>{t("graph.inspector")}</h2>{selection ? <Button type="text" size="small" aria-label={t("graph.close")} icon={<X size={15} />} onClick={closeDetails} /> : null}</header>
        {!selection ? <div className="owb-rgraph__inspect-empty"><Network size={30} /><h3>{t("graph.selectHint")}</h3><p>{t("graph.selectHelp")}</p></div> : !selectedNode && !selectedEdge ? <p role="status">{t("graph.deletedSelection")}</p> : <>
          {!selectedVisible ? <p className="owb-rgraph__bounded">{t("graph.filteredSelection")}</p> : null}
          {selectedNode ? <><Tag color={nodeColors[selectedNode.kind]}>{t(`graph.kind.${selectedNode.kind}`)}</Tag><h3>{selectedNode.label}</h3><Tag>{t(`graph.state.${selectedNode.state}`)}</Tag><Tag>{t(`graph.${selectedNode.evidence.basis}`)}</Tag>{selectedNode.resourcePath ? <p className="owb-rgraph__resource-path">{selectedNode.resourcePath}</p> : null}
            {selectedNode.kind === "agent" && selectedNode.positionId ? <Button block icon={<ArrowUpRight size={15} />} onClick={() => openNode(selectedNode.id)}>{t("graph.openAgent")}</Button> : null}
            {selectedNode.kind === "resource" ? selectedNode.positionId && selectedNode.resourcePath ? <Button block icon={<ArrowUpRight size={15} />} onClick={() => openNode(selectedNode.id)}>{t("graph.openResource")}</Button> : <p>{t("graph.resourceUnavailable")}</p> : null}
            {selectedNode.kind === "policy" || selectedNode.kind === "capability" ? <Alert type="info" title={t("graph.permission.declaration_only")} /> : null}
            {evidenceDetails(selectedNode.evidence, t)}
            {selectedNode.facts?.length ? <dl className="owb-rgraph__facts">{selectedNode.facts.map((fact, index) => <div key={`${fact.key}:${index}`}><dt>{fact.key}</dt><dd>{fact.value}</dd></div>)}</dl> : null}
          </> : selectedEdge ? <><h3>{relationText(selectedEdge)}</h3><Tag>{t(`graph.${selectedEdge.evidence.basis}`)}</Tag><p className="owb-rgraph__permission">{t(`graph.permission.${selectedEdge.permission}`)}</p>{evidenceDetails(selectedEdge.evidence, t)}</> : null}
        </>}
      </aside>
    </div>
  </section>;
}
