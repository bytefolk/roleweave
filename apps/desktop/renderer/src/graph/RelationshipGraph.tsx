import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Empty, Input, Spin, Tag } from "antd";
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, ChevronRight, FileSearch, Info, Network, RefreshCw, Search, X } from "lucide-react";
import { relationshipNodeKinds, type RelationshipEdge, type RelationshipGraphResponse, type RelationshipKind, type RelationshipNode, type RelationshipNodeKind } from "@roleweave/shared/relationship-graph";
import { useT, type OwbT } from "@roleweave/ui";
import { RelationshipSpatialScene, type RelationshipSpatialLayout, type RelationshipSpatialTheme } from "./RelationshipSpatialScene";
import { RelationshipContextExplorer } from "./RelationshipContextExplorer";
import { useRelationshipContextCopy } from "../locales/relationship-context";
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
type RendererMode = "context" | "minimal" | "galaxy";
interface RememberedView {
  query: string;
  kinds: RelationshipNodeKind[];
  relations: RelationshipKind[];
  selection: Selection;
  neighborhood: Neighborhood;
  renderer: RendererMode;
  spatialLayout: RelationshipSpatialLayout;
  spatialTheme: RelationshipSpatialTheme;
  showKnowledgeRelationships: boolean;
  focusId?: string;
  trail: string[];
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
  if (!data) return { nodes: [] as RelationshipNode[], edges: [] as RelationshipEdge[], total: 0, bounded: false, limited: false, matched: 0 };
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
  return { nodes: visible, edges: edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)), total: candidates.length, bounded: visible.length < candidates.length, limited: visible.length < nodes.length, matched: nodes.length };
}

const nodeColors: Record<RelationshipNodeKind, string> = { workspace: "#64748b", host: "#73748b", agent: "#28836b", source: "#5b7fc7", resource: "#aa8348", capability: "#8a68b3", policy: "#ba6677", goal: "#498c99", task: "#718247" };

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
  const copy = useRelationshipContextCopy();
  const initial = useRef(rememberedViews.get(scope));
  const [query, setQuery] = useState(initial.current?.query ?? "");
  const [kinds, setKinds] = useState<RelationshipNodeKind[]>(initial.current?.kinds ?? [...relationshipNodeKinds]);
  const [relations, setRelations] = useState<RelationshipKind[]>(initial.current?.relations ?? [...relationKinds]);
  const [selection, setSelection] = useState<Selection>(initial.current?.selection ?? null);
  const [neighborhood, setNeighborhood] = useState<Neighborhood>(initial.current?.neighborhood ?? null);
  const [renderer, setRenderer] = useState<RendererMode>(initial.current?.renderer ?? "context");
  const [focusId, setFocusId] = useState<string | undefined>(initial.current?.focusId);
  const [trail, setTrail] = useState<string[]>(initial.current?.trail ?? []);
  const [guideOpen, setGuideOpen] = useState(false);
  const [inspectionRequest, setInspectionRequest] = useState(0);
  const [spatialLayout, setSpatialLayout] = useState<RelationshipSpatialLayout>(initial.current?.spatialLayout ?? "topology");
  const [spatialTheme, setSpatialTheme] = useState<RelationshipSpatialTheme>(initial.current?.spatialTheme ?? "dark");
  const [showKnowledgeRelationships, setShowKnowledgeRelationships] = useState(initial.current?.showKnowledgeRelationships ?? true);
  const [listMode, setListMode] = useState<"nodes" | "edges">("nodes");
  const results = useRef<HTMLDivElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const trailNavigation = useRef<HTMLElement>(null);
  const latest = useRef({ data, onOpenAgent, onOpenResource });
  latest.current = { data, onOpenAgent, onOpenResource };
  const view = useMemo(() => projectRelationships(data, { query, kinds, relations, neighborhood }), [data, query, kinds, relations, neighborhood]);
  // Search chooses an object. Its context uses all matching types/relations,
  // so searching for an employee doesn't also erase differently named sources.
  const contextView = useMemo(() => projectRelationships(data, { query: "", kinds, relations, neighborhood: focusId ? { id: focusId, hops: 1 } : null }), [data, kinds, relations, focusId]);
  const nodesById = useMemo(() => new Map(data?.nodes.map(node => [node.id, node])), [data]);
  const employeesByPosition = useMemo(() => new Map(data?.nodes.filter(node => node.kind === "agent" && node.positionId).map(node => [node.positionId, node.label])), [data]);
  const selectedNode = selection?.type === "node" ? nodesById.get(selection.id) : undefined;
  const focusedNode = focusId ? nodesById.get(focusId) : undefined;
  const selectedEdge = selection?.type === "edge" ? data?.edges.find(edge => edge.id === selection.id) : undefined;
  const selectedProjection = renderer === "context" ? contextView : view;
  const selectedVisible = !selection || (selection.type === "node" ? selectedProjection.nodes : selectedProjection.edges).some(item => item.id === selection.id);
  const selectedIsSelector = selectedNode?.facts?.some(fact => fact.key === "kind" && fact.value === "selector");
  const stateForCache = useRef<RememberedView>({ query, kinds, relations, selection, neighborhood, renderer, spatialLayout, spatialTheme, showKnowledgeRelationships, focusId, trail });
  stateForCache.current = { query, kinds, relations, selection, neighborhood, renderer, spatialLayout, spatialTheme, showKnowledgeRelationships, focusId, trail };

  const openNode = useCallback((id: string) => {
    const current = latest.current;
    const node = current.data?.nodes.find(item => item.id === id);
    if (node?.kind === "agent" && node.positionId) current.onOpenAgent(node.positionId);
    if (node?.kind === "resource" && node.positionId && node.resourcePath && !node.facts?.some(fact => fact.key === "kind" && fact.value === "selector")) current.onOpenResource(node.positionId, node.resourcePath);
  }, []);

  useEffect(() => () => remember(scope, stateForCache.current), [scope]);
  useEffect(() => {
    if (!inspectionRequest) return;
    inspector.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    inspector.current?.focus({ preventScroll: true });
  }, [inspectionRequest]);
  useEffect(() => {
    if (renderer === "context" && focusId) trailNavigation.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [focusId, renderer]);

  const clearFilters = () => { setQuery(""); setKinds([...relationshipNodeKinds]); setRelations([...relationKinds]); setNeighborhood(null); };
  const selectNode = (id: string, continueTrail = false) => {
    setSelection({ type: "node", id });
    setFocusId(id);
    setTrail(current => continueTrail ? current.at(-1) === id ? current : [...current, id].slice(-16) : [id]);
  };
  const returnTo = (index: number) => {
    const id = trail[index];
    if (!id) return;
    setFocusId(id);
    setSelection({ type: "node", id });
    setTrail(current => current.slice(0, index + 1));
  };
  const inspectSelection = (next: NonNullable<Selection>) => {
    setSelection(next);
    setInspectionRequest(current => current + 1);
  };
  const exploreNeighborhood = (hops: 1 | 2) => {
    if (!selectedNode) return;
    setQuery("");
    setNeighborhood({ id: selectedNode.id, hops });
  };
  const closeDetails = () => { setSelection(null); results.current?.focus(); };
  const relationText = (edge: RelationshipEdge) => `${nodesById.get(edge.source)?.label ?? edge.source} → ${t(`graph.relation.${edge.kind}`)} → ${nodesById.get(edge.target)?.label ?? edge.target}`;
  const objectHint = (node: RelationshipNode) => {
    const selector = node.facts?.some(fact => fact.key === "kind" && fact.value === "selector");
    const kind = selector ? copy.selector : t(`graph.kind.${node.kind}`);
    const owner = node.kind !== "agent" && node.positionId ? employeesByPosition.get(node.positionId) : undefined;
    return [owner, selector ? kind : node.resourcePath ?? kind].filter(Boolean).join(" · ");
  };
  const partial = data?.truncated || data?.coverage.some(item => item.state === "partial" || item.state === "error");

  const emptyResults = !data || !view.nodes.length ? <div className="owb-rgraph__canvas-message">{loading ? <Spin tip={t("graph.loading")}><div className="owb-rgraph__spinner-space" /></Spin> : <Empty description={data?.nodes.length ? t("graph.filteredEmpty") : data ? t("graph.empty") : t("graph.noData")} image={Empty.PRESENTED_IMAGE_SIMPLE}>{data?.nodes.length ? <Button onClick={clearFilters}>{t("graph.clearFilters")}</Button> : null}</Empty>}</div> : null;

  const objectResults = <div ref={results} tabIndex={-1} className="owb-rgraph__results" aria-label={t("graph.list")}>
    <div className="owb-rgraph__result-head"><div role="tablist" aria-label={t("graph.list")}><button type="button" role="tab" aria-selected={listMode === "nodes"} onClick={() => setListMode("nodes")}>{t("graph.objects")} <span>{view.nodes.length}</span></button><button type="button" role="tab" aria-selected={listMode === "edges"} onClick={() => setListMode("edges")}>{t("graph.edges")} <span>{view.edges.length}</span></button></div></div>
    {view.bounded ? <p className="owb-rgraph__bounded" role="status">{t("graph.bounded", { visible: view.nodes.length, total: view.total })}</p> : null}
    <ul className="owb-rgraph__list" aria-label={t(listMode === "nodes" ? "graph.objects" : "graph.edges")}>
      {listMode === "nodes" ? view.nodes.map(node => <li key={node.id}><button type="button" aria-pressed={selection?.type === "node" && selection.id === node.id} onClick={() => selectNode(node.id)} onDoubleClick={() => openNode(node.id)}><i className="owb-rgraph__kind-dot" style={{ background: nodeColors[node.kind] }} /><span><strong>{node.label}</strong><small title={objectHint(node)}>{objectHint(node)}</small></span>{renderer !== "context" ? <Tag>{t(`graph.state.${node.state}`)}</Tag> : <ChevronRight size={13} aria-hidden="true" />}</button></li>) : view.edges.map(edge => <li key={edge.id}><button type="button" aria-pressed={selection?.type === "edge" && selection.id === edge.id} onClick={() => inspectSelection({ type: "edge", id: edge.id })}><span><strong>{relationText(edge)}</strong><small>{edge.evidence.source}</small></span>{renderer !== "context" ? <Tag>{t(`graph.${edge.evidence.basis}`)}</Tag> : null}</button></li>)}
    </ul>
    {!view.nodes.length && data?.nodes.length ? <p className="owb-rgraph__bounded">{t("graph.filteredEmpty")}</p> : null}
  </div>;

  return <section className="owb-rgraph" tabIndex={0} aria-label={t("graph.title")} onKeyDown={event => { if (event.key === "Escape" && selection) closeDetails(); }}>
    <header className="owb-rgraph__header"><div><h1><Network size={19} aria-hidden="true" />{t("graph.title")}</h1><p>{copy.subtitle}</p></div><div className="owb-rgraph__header-actions"><Button type="text" icon={<BookOpen size={14} />} aria-expanded={guideOpen} onClick={() => setGuideOpen(current => !current)}>{copy.guideTitle}</Button><Button icon={<RefreshCw size={14} />} onClick={onReload} loading={loading}>{t("graph.reload")}</Button></div></header>
    {guideOpen ? <div className="owb-rgraph__guide" role="region" aria-label={copy.guideTitle}><div><strong>{copy.guideObject}</strong><p>{copy.objectStep}</p></div><div><strong>{copy.guideRelation}</strong><p>{copy.relationStep}</p></div><div><strong>{copy.guideEvidence}</strong><p>{copy.evidenceStep}</p></div><p>{copy.scopeHelp}</p></div> : null}
    {error ? <Alert type="error" title={t("graph.loadFailure")} showIcon action={<Button size="small" onClick={onReload}>{t("graph.reload")}</Button>} /> : null}
    {partial ? <Alert type="warning" title={t("graph.partial")} showIcon /> : null}
    <ol className="owb-rgraph__workflow" aria-label={copy.guideTitle}><li className={!focusId ? "is-current" : ""}><span>1</span>{copy.findObject}</li><li className={focusId && !selectedEdge ? "is-current" : ""}><span>2</span>{copy.followRelations}</li><li className={selectedEdge ? "is-current" : ""}><span>3</span>{copy.verifyEvidence}</li></ol>
    {data ? <details className="owb-rgraph__scope"><summary><Info size={14} aria-hidden="true" /><span>{copy.scopeTitle}</span><small>{t("graph.counts", { nodes: data.nodes.length, edges: data.edges.length })}</small></summary><p>{copy.scopeHelp}</p><div className="owb-rgraph__scope-coverage">{data.coverage.map((item, index) => <div key={`${item.source}:${index}`}><span>{item.source}</span><Tag color={item.state === "error" || item.state === "partial" ? "warning" : "default"}>{t(`graph.coverage.${item.state}`)}</Tag>{item.count !== undefined ? <small>{item.count}</small> : null}</div>)}</div></details> : null}
    <div className={`owb-rgraph__workspace owb-rgraph__workspace--${renderer}${selection ? " has-selection" : ""}`}>
      <aside className="owb-rgraph__filters" aria-label={t("graph.filters")}>
        <Input prefix={<Search size={14} aria-hidden="true" />} aria-label={t("graph.search")} placeholder={t("graph.search")} value={query} allowClear onChange={event => { setQuery(event.target.value); setNeighborhood(null); }} />
        {renderer === "context" ? objectResults : null}
        <details className="owb-rgraph__advanced"><summary>{copy.filters}</summary>
        <fieldset><legend>{t("graph.entities")}</legend><div className="owb-rgraph__filter-actions"><button onClick={() => setKinds([...relationshipNodeKinds])}>{t("graph.all")}</button><button onClick={() => setKinds([])}>{t("graph.none")}</button></div>
          {relationshipNodeKinds.map(kind => <Checkbox key={kind} checked={kinds.includes(kind)} onChange={event => setKinds(current => event.target.checked ? [...current, kind] : current.filter(value => value !== kind))}><i className="owb-rgraph__kind-dot" style={{ background: nodeColors[kind] }} />{t(`graph.kind.${kind}`)}<span className="owb-rgraph__count">{data?.nodes.filter(node => node.kind === kind).length ?? 0}</span></Checkbox>)}
        </fieldset>
        <fieldset><legend>{t("graph.relations")}</legend>{relationKinds.filter(kind => data?.edges.some(edge => edge.kind === kind)).map(kind => <Checkbox key={kind} checked={relations.includes(kind)} onChange={event => setRelations(current => event.target.checked ? [...current, kind] : current.filter(value => value !== kind))}>{t(`graph.relation.${kind}`)}</Checkbox>)}</fieldset>
        <Button size="small" block onClick={clearFilters}>{t("graph.clearFilters")}</Button>
        </details>
      </aside>
      <div className="owb-rgraph__main">
        <div className="owb-rgraph__toolbar" role="toolbar" aria-label={t("graph.canvas")}>
          <div className="owb-rgraph__renderer" role="group" aria-label={t("graph.renderer")}><Button size="small" aria-pressed={renderer === "context"} onClick={() => { setRenderer("context"); if (selectedNode && selectedNode.id !== focusId) selectNode(selectedNode.id); }}>{copy.contextView}</Button><Button size="small" aria-pressed={renderer === "minimal"} onClick={() => setRenderer("minimal")}>{t("graph.rendererMinimal")}</Button><Button size="small" aria-pressed={renderer === "galaxy"} onClick={() => setRenderer("galaxy")}>{t("graph.rendererGalaxy")}</Button></div>
          {renderer !== "context" ? <div><Button size="small" disabled={!selectedNode} aria-pressed={neighborhood?.hops === 1} onClick={() => exploreNeighborhood(1)}>{t("graph.oneHop")}</Button><Button size="small" disabled={!selectedNode} aria-pressed={neighborhood?.hops === 2} onClick={() => exploreNeighborhood(2)}>{t("graph.twoHop")}</Button><Button size="small" onClick={() => setNeighborhood(null)}>{t("graph.overview")}</Button></div> : null}
        </div>
        {renderer === "context" ? <>
          {trail.length ? <nav ref={trailNavigation} className="owb-rgraph__trail" aria-label={copy.trail}><button type="button" aria-label={copy.back} disabled={trail.length < 2} onClick={() => returnTo(trail.length - 2)}><ArrowLeft size={14} /></button><ol>{trail.map((id, index) => <li key={`${id}:${index}`}>{index > 0 ? <ChevronRight size={12} aria-hidden="true" /> : null}<button type="button" aria-current={index === trail.length - 1 ? "location" : undefined} onClick={() => returnTo(index)}>{nodesById.get(id)?.label ?? t("graph.deletedSelection")}</button></li>)}</ol><button type="button" onClick={() => { setFocusId(undefined); setSelection(null); setTrail([]); }}>{copy.resetTrail}</button></nav> : null}
          <div className="owb-rgraph__context-wrap">
            {contextView.limited ? <p className="owb-rgraph__bounded" role="status">{t("graph.bounded", { visible: contextView.nodes.length, total: contextView.matched })}</p> : null}
            {focusedNode && contextView.nodes.some(node => node.id === focusedNode.id) ? <div className="owb-rgraph__context-actions"><Button size="small" icon={<FileSearch size={14} />} onClick={() => inspectSelection({ type: "node", id: focusedNode.id })}>{copy.nodeEvidenceTitle}</Button>{focusedNode.kind === "agent" && focusedNode.positionId ? <Button size="small" icon={<ArrowUpRight size={14} />} onClick={() => openNode(focusedNode.id)}>{t("graph.openAgent")}</Button> : focusedNode.kind === "resource" && focusedNode.positionId && focusedNode.resourcePath && !focusedNode.facts?.some(fact => fact.key === "kind" && fact.value === "selector") ? <Button size="small" icon={<ArrowUpRight size={14} />} onClick={() => openNode(focusedNode.id)}>{t("graph.openResource")}</Button> : null}</div> : null}
            {data?.nodes.length || focusId ? <RelationshipContextExplorer nodes={contextView.nodes} edges={contextView.edges} focusId={focusId} focusMissing={Boolean(focusId && !nodesById.has(focusId))} onFocus={id => selectNode(id, true)} onSelectEdge={id => inspectSelection({ type: "edge", id })} /> : emptyResults}
            {loading && data ? <span className="owb-rgraph__refreshing" role="status">{t("graph.refreshing")}</span> : null}
          </div>
        </> : <>
        <div className="owb-rgraph__canvas-wrap">
          <RelationshipSpatialScene
            nodes={view.nodes}
            edges={view.edges}
            mode={renderer}
            layout={spatialLayout}
            theme={spatialTheme}
            showKnowledgeRelationships={showKnowledgeRelationships}
            selectedId={selection?.type === "node" ? selection.id : undefined}
            visible={visible}
            onLayoutChange={setSpatialLayout}
            onThemeChange={setSpatialTheme}
            onShowKnowledgeRelationshipsChange={setShowKnowledgeRelationships}
            onSelect={id => selectNode(id)}
          />
          {emptyResults}
          {loading && data ? <span className="owb-rgraph__refreshing" role="status">{t("graph.refreshing")}</span> : null}
        </div>
        <div className="owb-rgraph__caption"><span>{t("graph.legend")}</span><span>{t("graph.spatialGesture")}</span></div>
        {objectResults}
        </>}
        {data ? <footer className="owb-rgraph__timestamp">{t("graph.updated", { time: data.generatedAt })}</footer> : null}
      </div>
      <aside ref={inspector} tabIndex={-1} className="owb-rgraph__inspector" aria-label={t("graph.inspector")}>
        <header><h2>{t("graph.inspector")}</h2>{selection ? <Button type="text" size="small" aria-label={t("graph.close")} icon={<X size={15} />} onClick={closeDetails} /> : null}</header>
        {!selection ? <div className="owb-rgraph__inspect-empty"><FileSearch size={30} aria-hidden="true" /><h3>{copy.verifyEvidence}</h3><p>{copy.evidenceStep}</p><p>{copy.scopeHelp}</p></div> : !selectedNode && !selectedEdge ? <p role="status">{t("graph.deletedSelection")}</p> : <>
          {!selectedVisible ? <p className="owb-rgraph__bounded">{t("graph.filteredSelection")}</p> : null}
          {selectedNode ? <><Tag color={nodeColors[selectedNode.kind]}>{selectedIsSelector ? copy.selector : t(`graph.kind.${selectedNode.kind}`)}</Tag><h3>{selectedNode.label}</h3><Tag>{t(`graph.state.${selectedNode.state}`)}</Tag><Tag>{t(`graph.${selectedNode.evidence.basis}`)}</Tag>{selectedNode.resourcePath && !selectedIsSelector ? <p className="owb-rgraph__resource-path">{selectedNode.resourcePath}</p> : null}
            {selectedNode.kind === "agent" && selectedNode.positionId ? <Button block icon={<ArrowUpRight size={15} />} onClick={() => openNode(selectedNode.id)}>{t("graph.openAgent")}</Button> : null}
            {selectedNode.kind === "resource" ? selectedIsSelector ? <p className="owb-rgraph__permission">{copy.selectorHelp}</p> : selectedNode.positionId && selectedNode.resourcePath ? <Button block icon={<ArrowUpRight size={15} />} onClick={() => openNode(selectedNode.id)}>{t("graph.openResource")}</Button> : <p>{t("graph.resourceUnavailable")}</p> : null}
            {selectedNode.kind === "policy" || selectedNode.kind === "capability" ? <Alert type="info" title={t("graph.permission.declaration_only")} /> : null}
            <div className="owb-rgraph__evidence-intro"><h4>{copy.nodeEvidenceTitle}</h4><p>{selectedNode.evidence.basis === "declared" ? copy.declaredHelp : copy.observedHelp}</p></div>
            {evidenceDetails(selectedNode.evidence, t)}
            {selectedNode.facts?.length ? <dl className="owb-rgraph__facts">{selectedNode.facts.map((fact, index) => <div key={`${fact.key}:${index}`}><dt>{fact.key}</dt><dd>{fact.value}</dd></div>)}</dl> : null}
          </> : selectedEdge ? <><h3>{relationText(selectedEdge)}</h3><Tag>{t(`graph.${selectedEdge.evidence.basis}`)}</Tag><p className="owb-rgraph__permission">{t(`graph.permission.${selectedEdge.permission}`)}</p><div className="owb-rgraph__evidence-intro"><h4>{copy.evidenceTitle}</h4><p>{selectedEdge.evidence.basis === "declared" ? copy.declaredHelp : copy.observedHelp}</p></div>{evidenceDetails(selectedEdge.evidence, t)}<div className="owb-rgraph__edge-actions">{[selectedEdge.source, selectedEdge.target].map((id, index) => <Button key={`${id}:${index}`} block icon={<ArrowRight size={14} />} onClick={() => selectNode(id, true)}>{nodesById.get(id)?.label ?? id}</Button>)}</div></> : null}
        </>}
      </aside>
    </div>
  </section>;
}
