import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Empty, Input, Spin, Tag } from "antd";
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, ChevronRight, FileSearch, Info, Network, Orbit, RefreshCw, Search, X } from "lucide-react";
import { relationshipNodeKinds, type RelationshipCoverage, type RelationshipEdge, type RelationshipGraphResponse, type RelationshipKind, type RelationshipNode, type RelationshipNodeKind } from "@roleweave/shared/relationship-graph";
import { useT, type OwbT } from "@roleweave/ui";
import { RelationshipSpatialScene, type RelationshipSpatialLayout, type RelationshipSpatialTheme } from "./RelationshipSpatialScene";
import { isRelationshipConfiguration, RelationshipContextExplorer } from "./RelationshipContextExplorer";
import { useRelationshipContextCopy } from "../locales/relationship-context";
import { graphCoverageIssues } from "./graph-coverage";
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
  onOpenDrive?: () => void;
}

const relationKinds: RelationshipKind[] = ["contains", "reports_to", "bound_to", "declares_source", "available_in", "contains_resource", "declares_allow", "declares_deny", "has_policy", "assigned_to", "requested_by", "budget_owner"];
const VISIBLE_LIMIT = 120;
type Selection = { type: "node" | "edge"; id: string } | null;
type Neighborhood = { id: string; hops: 1 | 2 } | null;
type RendererMode = "context" | "galaxy";
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
  showAllObjects: boolean;
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

function evidenceDetails(evidence: RelationshipNode["evidence"], t: OwbT, sourceLabel: string) {
  return <dl className="owb-rgraph__facts">
    <dt>{t("graph.source")}</dt><dd>{sourceLabel}</dd>
    <dt>{t("graph.locator")}</dt><dd>{evidence.locator}</dd>
    <dt>{t("graph.observedAt")}</dt><dd>{evidence.observedAt}</dd>
  </dl>;
}

export function RelationshipGraph(props: RelationshipGraphProps) {
  const scope = props.workspaceKey ?? props.data?.workspaceId ?? "";
  return <RelationshipGraphWorkspace key={scope} {...props} scope={scope} />;
}

function RelationshipGraphWorkspace({ data, loading, error, visible = true, onReload, onOpenAgent, onOpenResource, onOpenDrive, scope }: RelationshipGraphProps & { scope: string }) {
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
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectionRequest, setInspectionRequest] = useState(0);
  const [contextFocusRequest, setContextFocusRequest] = useState(0);
  const [spatialLayout, setSpatialLayout] = useState<RelationshipSpatialLayout>(initial.current?.spatialLayout ?? "topology");
  const [spatialTheme, setSpatialTheme] = useState<RelationshipSpatialTheme>(initial.current?.spatialTheme ?? (document.documentElement.dataset.theme === "light" ? "light" : "dark"));
  const [showKnowledgeRelationships, setShowKnowledgeRelationships] = useState(initial.current?.showKnowledgeRelationships ?? true);
  const [listMode, setListMode] = useState<"nodes" | "edges">("nodes");
  const [showAllObjects, setShowAllObjects] = useState(initial.current?.showAllObjects ?? false);
  const results = useRef<HTMLDivElement>(null);
  const scopeDetails = useRef<HTMLDetailsElement>(null);
  const moreOptions = useRef<HTMLDetailsElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const mainPane = useRef<HTMLDivElement>(null);
  const inspectionOrigin = useRef<HTMLElement | null>(null);
  const trailNavigation = useRef<HTMLElement>(null);
  const latest = useRef({ data, onOpenAgent, onOpenResource, onOpenDrive });
  latest.current = { data, onOpenAgent, onOpenResource, onOpenDrive };
  const view = useMemo(() => projectRelationships(data, { query, kinds, relations, neighborhood }), [data, query, kinds, relations, neighborhood]);
  const showEveryKind = showAllObjects || Boolean(query.trim()) || !data?.nodes.some(node => node.kind === "agent");
  const employees = useMemo(() => data?.nodes.filter(node => node.kind === "agent" && kinds.includes(node.kind)) ?? [], [data, kinds]);
  const sidebarNodes = showEveryKind ? view.nodes : employees.slice(0, VISIBLE_LIMIT);
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
  const selectedIsDrive = selectedNode?.facts?.some(fact => fact.key === "kind" && ["drive_file", "mem_drive"].includes(fact.value));
  const stateForCache = useRef<RememberedView>({ query, kinds, relations, selection, neighborhood, renderer, spatialLayout, spatialTheme, showKnowledgeRelationships, showAllObjects, focusId, trail });
  stateForCache.current = { query, kinds, relations, selection, neighborhood, renderer, spatialLayout, spatialTheme, showKnowledgeRelationships, showAllObjects, focusId, trail };

  const openNode = useCallback((id: string) => {
    const current = latest.current;
    const node = current.data?.nodes.find(item => item.id === id);
    if (node?.kind === "agent" && node.positionId) current.onOpenAgent(node.positionId);
    if (node?.facts?.some(fact => fact.key === "kind" && ["drive_file", "mem_drive"].includes(fact.value))) current.onOpenDrive?.();
    if (node?.kind === "resource" && node.positionId && node.resourcePath && !node.facts?.some(fact => fact.key === "kind" && fact.value === "selector")) current.onOpenResource(node.positionId, node.resourcePath);
  }, []);

  useEffect(() => () => remember(scope, stateForCache.current), [scope]);
  useEffect(() => {
    const followTheme = () => setSpatialTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    const observer = new MutationObserver(followTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    followTheme();
    const dismissOptions = (event: PointerEvent) => {
      if (moreOptions.current?.open && event.target instanceof Node && !moreOptions.current.contains(event.target)) moreOptions.current.open = false;
    };
    document.addEventListener("pointerdown", dismissOptions);
    return () => { observer.disconnect(); document.removeEventListener("pointerdown", dismissOptions); };
  }, []);
  useEffect(() => {
    if (!inspectionRequest) return;
    inspector.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    inspector.current?.focus({ preventScroll: true });
  }, [inspectionRequest]);
  useEffect(() => {
    if (contextFocusRequest) mainPane.current?.focus({ preventScroll: true });
  }, [contextFocusRequest]);
  useEffect(() => {
    if (renderer === "context" && focusId) trailNavigation.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [focusId, renderer]);

  const clearFilters = () => { setQuery(""); setKinds([...relationshipNodeKinds]); setRelations([...relationKinds]); setNeighborhood(null); };
  const selectNode = (id: string, continueTrail = false) => {
    const node = nodesById.get(id);
    if (renderer === "galaxy" && node && kinds.includes(node.kind) && !query.trim() && !view.nodes.some(item => item.id === id)) setNeighborhood({ id, hops: 1 });
    if (inspector.current?.contains(document.activeElement)) setContextFocusRequest(current => current + 1);
    setSelection({ type: "node", id });
    setInspectorOpen(false);
    setFocusId(id);
    setTrail(current => continueTrail ? current.at(-1) === id ? current : [...current, id].slice(-16) : [id]);
  };
  const returnTo = (index: number) => {
    const id = trail[index];
    if (!id) return;
    setFocusId(id);
    setSelection({ type: "node", id });
    setInspectorOpen(false);
    setTrail(current => current.slice(0, index + 1));
  };
  const inspectSelection = (next: NonNullable<Selection>) => {
    inspectionOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelection(next);
    setInspectorOpen(true);
    setInspectionRequest(current => current + 1);
  };
  const closeDetails = () => {
    setInspectorOpen(false);
    const origin = inspectionOrigin.current;
    let insideClosedDetails = false;
    for (let ancestor = origin?.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor instanceof HTMLDetailsElement && !ancestor.open && !ancestor.querySelector(":scope > summary")?.contains(origin)) insideClosedDetails = true;
    }
    if (origin && origin !== document.body && origin.isConnected && !origin.closest("[hidden]") && !insideClosedDetails) origin.focus({ preventScroll: true });
    else results.current?.focus({ preventScroll: true });
  };
  const changeRenderer = (next: RendererMode) => {
    if (next === "galaxy" && focusedNode && kinds.includes(focusedNode.kind) && !query.trim() && !view.nodes.some(node => node.id === focusedNode.id)) setNeighborhood({ id: focusedNode.id, hops: 1 });
    setRenderer(next);
    setInspectorOpen(false);
    if (moreOptions.current?.open) { moreOptions.current.open = false; moreOptions.current.querySelector("summary")?.focus(); }
    else if (mainPane.current?.contains(document.activeElement)) setContextFocusRequest(current => current + 1);
  };
  const restart = () => { setFocusId(undefined); setSelection(null); setInspectorOpen(false); setTrail([]); setNeighborhood(null); };
  const relationText = (edge: RelationshipEdge) => `${nodesById.get(edge.source)?.label ?? edge.source} → ${t(`graph.relation.${edge.kind}`)} → ${nodesById.get(edge.target)?.label ?? edge.target}`;
  const objectHint = (node: RelationshipNode) => {
    const selector = node.facts?.some(fact => fact.key === "kind" && fact.value === "selector");
    const kind = selector ? copy.selector : t(`graph.kind.${node.kind}`);
    const owner = node.kind !== "agent" && node.positionId ? employeesByPosition.get(node.positionId) : undefined;
    return [owner, selector ? kind : node.resourcePath ?? kind].filter(Boolean).join(" · ");
  };
  const coverageIssues = graphCoverageIssues(data);
  const disclosedCoverage = [...(data?.coverage ?? [])].sort((left, right) => Number(coverageIssues.includes(right)) - Number(coverageIssues.includes(left)));
  const coverageName = (item: RelationshipCoverage) => {
    const labels: Record<string, string> = { organization: copy.sourceOrganization, workspace_identity: copy.sourceIdentity,
      mem: copy.sourceDrive, doc: copy.sourceDoc, context: copy.sourceContext, tasks: copy.sourceTasks, goals: copy.sourceGoals,
      mcp_runtime: copy.sourceMcp, execution_lineage: copy.sourceExecution, projection: copy.sourceProjection };
    const match = /^(documents|permissions|agent_binding):([a-zA-Z0-9_-]+)$/.exec(item.source);
    if (match) {
      const category = match[1] === "documents" ? copy.sourceDocuments : match[1] === "permissions" ? copy.sourcePermissions : copy.sourceBinding;
      return [employeesByPosition.get(match[2]!), category].filter(Boolean).join(" · ");
    }
    return labels[item.source] ?? copy.sourceOther;
  };
  const coverageReason = (item: RelationshipCoverage) => {
    const reasons: Record<string, string> = {
      local_identity_fallback: copy.reasonIdentity, permission_manifest_missing: copy.reasonPermissions,
      external_inventory_not_loaded: copy.reasonInventory, recall_lineage_not_loaded: copy.reasonContext,
      service_not_configured: copy.reasonUnconfigured, agent_not_bound: copy.reasonUnbound, package_missing: copy.reasonPackage,
      invalid_or_unresolved_record: copy.reasonRecord, source_unreadable: copy.reasonUnreadable, identity_unreadable: copy.reasonUnreadable,
      graph_limit: copy.reasonLimit, document_limit: copy.reasonLimit, position_limit: copy.reasonLimit, record_limit: copy.reasonLimit,
      inventory_limit: copy.reasonLimit, inventory_timeout: copy.reasonTimeout, inventory_unavailable: copy.reasonUpstream,
      upstream_failed: copy.reasonUpstream, auth_expired: copy.reasonUpstream, provider_invalid: copy.reasonUpstream,
      employee_mcp_unsupported: copy.reasonUnsupported, task_run_link_unavailable: copy.reasonUnsupported,
    };
    return item.reason ? reasons[item.reason] ?? (item.state === "partial" ? copy.reasonIncomplete : copy.reasonUnreadable) : "";
  };
  const evidenceSourceName = (proof: RelationshipNode["evidence"]) => ({
    organization: copy.sourceOrganization, permissions: copy.sourcePermissions, agent_binding: copy.sourceBinding,
    context_configuration: copy.sourceContext, workspace_documents: copy.sourceDocuments, drive_inventory: copy.sourceDrive,
    tasks: copy.sourceTasks, goals: copy.sourceGoals,
  } as Record<string, string>)[proof.source] ?? proof.source;
  const guideSeed = sidebarNodes.find(node => node.kind === "agent") ?? view.nodes[0];
  const guideEdges = focusedNode ? contextView.edges.filter(edge => edge.source === focusedNode.id || edge.target === focusedNode.id) : [];
  const primaryGuideEdges = guideEdges.filter(edge => {
    const neighbor = nodesById.get(edge.source === focusedNode?.id ? edge.target : edge.source);
    return neighbor && !isRelationshipConfiguration(neighbor);
  });
  const guideEdge = primaryGuideEdges.find(edge => edge.source === focusedNode?.id && ["declares_source", "contains_resource"].includes(edge.kind))
    ?? primaryGuideEdges[0] ?? guideEdges[0];
  const guideStep = inspectorOpen ? 3 : focusedNode ? 2 : 1;

  const emptyResults = !data || !view.nodes.length ? <div className="owb-rgraph__canvas-message">{loading ? <Spin tip={t("graph.loading")}><div className="owb-rgraph__spinner-space" /></Spin> : <Empty description={data?.nodes.length ? t("graph.filteredEmpty") : data ? t("graph.empty") : t("graph.noData")} image={Empty.PRESENTED_IMAGE_SIMPLE}>{data?.nodes.length ? <Button onClick={clearFilters}>{t("graph.clearFilters")}</Button> : null}</Empty>}</div> : null;

  const objectResults = <div ref={results} tabIndex={-1} className="owb-rgraph__results" aria-label={t("graph.list")}>
    <div className="owb-rgraph__result-head"><strong>{listMode === "edges" ? t("graph.edges") : query.trim() ? copy.searchResults : showEveryKind ? t("graph.objects") : copy.employeeList} <span>{listMode === "nodes" ? sidebarNodes.length : view.edges.length}</span></strong>{listMode === "edges" ? <Button className="owb-rgraph__back-to-objects" type="text" size="small" onClick={() => setListMode("nodes")}>{copy.backToObjects}</Button> : null}</div>
    {(showEveryKind ? view.bounded : employees.length > VISIBLE_LIMIT) ? <p className="owb-rgraph__bounded" role="status">{t("graph.bounded", { visible: sidebarNodes.length, total: showEveryKind ? view.total : employees.length })}</p> : null}
    <ul className="owb-rgraph__list" aria-label={t(listMode === "nodes" ? "graph.objects" : "graph.edges")}>
      {listMode === "nodes" ? sidebarNodes.map(node => <li key={node.id}><button type="button" aria-label={`${node.label} ${objectHint(node)}`} aria-pressed={focusId === node.id} onClick={() => selectNode(node.id)} onDoubleClick={() => openNode(node.id)}><i className="owb-rgraph__kind-dot" style={{ background: nodeColors[node.kind] }} /><span><strong>{node.label}</strong>{showEveryKind || node.kind !== "agent" ? <small title={objectHint(node)}>{objectHint(node)}</small> : null}</span><ChevronRight size={13} aria-hidden="true" /></button></li>) : view.edges.map(edge => <li key={edge.id}><button type="button" aria-pressed={selection?.type === "edge" && selection.id === edge.id} onClick={() => inspectSelection({ type: "edge", id: edge.id })}><span><strong>{relationText(edge)}</strong><small>{evidenceSourceName(edge.evidence)}</small></span></button></li>)}
    </ul>
    {!sidebarNodes.length && data?.nodes.length ? <div className="owb-rgraph__bounded"><p>{t("graph.filteredEmpty")}</p><Button size="small" onClick={clearFilters}>{t("graph.clearFilters")}</Button></div> : null}
  </div>;

  const contextActions = focusedNode && contextView.nodes.some(node => node.id === focusedNode.id) ? <div className="owb-rgraph__context-actions"><Button size="small" type="text" icon={<FileSearch size={14} />} onClick={() => inspectSelection({ type: "node", id: focusedNode.id })}>{copy.nodeEvidenceTitle}</Button>{focusedNode.kind === "agent" && focusedNode.positionId ? <Button size="small" icon={<ArrowUpRight size={14} />} onClick={() => openNode(focusedNode.id)}>{t("graph.openAgent")}</Button> : focusedNode.facts?.some(fact => fact.key === "kind" && ["drive_file", "mem_drive"].includes(fact.value)) && onOpenDrive ? <Button size="small" icon={<ArrowUpRight size={14} />} onClick={() => openNode(focusedNode.id)}>{copy.openDrive}</Button> : focusedNode.kind === "resource" && focusedNode.positionId && focusedNode.resourcePath && !focusedNode.facts?.some(fact => fact.key === "kind" && fact.value === "selector") ? <Button size="small" icon={<ArrowUpRight size={14} />} onClick={() => openNode(focusedNode.id)}>{t("graph.openResource")}</Button> : null}</div> : null;
  const showSourceInformation = () => {
    if (moreOptions.current) moreOptions.current.open = true;
    if (scopeDetails.current) { scopeDetails.current.open = true; scopeDetails.current.querySelector("summary")?.focus(); }
  };

  return <section className="owb-rgraph" tabIndex={0} aria-label={t("graph.title")} onKeyDown={event => {
    if (event.key !== "Escape") return;
    if (moreOptions.current?.open && scopeDetails.current?.open) {
      scopeDetails.current.open = false;
      scopeDetails.current.querySelector("summary")?.focus();
      event.stopPropagation();
    } else if (moreOptions.current?.open) {
      moreOptions.current.open = false;
      moreOptions.current.querySelector("summary")?.focus();
      event.stopPropagation();
    } else if (inspectorOpen) { closeDetails(); event.stopPropagation(); }
    else if (guideOpen) { setGuideOpen(false); event.stopPropagation(); }
  }}>
    <header className="owb-rgraph__header"><div><h1><Network size={19} aria-hidden="true" />{t("graph.title")}</h1></div><div className="owb-rgraph__header-actions">{coverageIssues.length || data?.truncated ? <span role="status"><button type="button" className="owb-rgraph__source-notice" onClick={showSourceInformation}><Info size={14} aria-hidden="true" />{data?.truncated ? copy.sourceLimited : copy.sourceNotice(coverageIssues.length)}</button></span> : null}<Button type="text" icon={<BookOpen size={14} />} aria-expanded={guideOpen} onClick={() => setGuideOpen(current => !current)}>{copy.guideTitle}</Button>
      <details ref={moreOptions} className="owb-rgraph__more"><summary>{copy.moreOptions}</summary><div className="owb-rgraph__more-panel" role="region" aria-label={copy.moreOptions}>
        <strong>{copy.viewDisplay}</strong><div className="owb-rgraph__renderer" role="group" aria-label={copy.viewDisplay}><Button size="small" icon={<FileSearch size={14} aria-hidden="true" />} aria-pressed={renderer === "context"} onClick={() => changeRenderer("context")}>{copy.viewList}</Button><Button size="small" icon={<Orbit size={14} aria-hidden="true" />} aria-pressed={renderer === "galaxy"} onClick={() => changeRenderer("galaxy")}>{copy.viewDiagram}</Button></div>
        <Checkbox checked={showAllObjects} onChange={event => setShowAllObjects(event.target.checked)}>{copy.showAllObjects}</Checkbox>
        <Checkbox checked={listMode === "edges"} onChange={event => setListMode(event.target.checked ? "edges" : "nodes")}>{copy.relationshipList}</Checkbox>
        <details className="owb-rgraph__advanced"><summary>{copy.filters}</summary>
          <fieldset><legend>{t("graph.entities")}</legend><div className="owb-rgraph__filter-actions"><button onClick={() => setKinds([...relationshipNodeKinds])}>{t("graph.all")}</button><button onClick={() => setKinds([])}>{t("graph.none")}</button></div>
            {relationshipNodeKinds.map(kind => <Checkbox key={kind} checked={kinds.includes(kind)} onChange={event => setKinds(current => event.target.checked ? [...current, kind] : current.filter(value => value !== kind))}><i className="owb-rgraph__kind-dot" style={{ background: nodeColors[kind] }} />{t(`graph.kind.${kind}`)}<span className="owb-rgraph__count">{data?.nodes.filter(node => node.kind === kind).length ?? 0}</span></Checkbox>)}
          </fieldset>
          <fieldset><legend>{t("graph.relations")}</legend>{relationKinds.filter(kind => data?.edges.some(edge => edge.kind === kind)).map(kind => <Checkbox key={kind} checked={relations.includes(kind)} onChange={event => setRelations(current => event.target.checked ? [...current, kind] : current.filter(value => value !== kind))}>{t(`graph.relation.${kind}`)}</Checkbox>)}</fieldset>
          <Button size="small" block onClick={clearFilters}>{t("graph.clearFilters")}</Button>
        </details>
        {data ? <details ref={scopeDetails} className="owb-rgraph__scope"><summary><Info size={14} aria-hidden="true" /><span>{copy.sourceDetails}</span></summary><div className="owb-rgraph__scope-panel"><p>{t("graph.counts", { nodes: data.nodes.length, edges: data.edges.length })}</p><p>{copy.scopeHelp}</p><div className="owb-rgraph__scope-coverage">{disclosedCoverage.map((item, index) => <div key={`${item.source}:${index}`}><span>{coverageName(item)}</span><Tag color={coverageIssues.includes(item) ? "warning" : "default"}>{t(`graph.coverage.${item.state}`)}</Tag>{item.count !== undefined ? <small>{item.count}</small> : null}{item.reason ? <small className="owb-rgraph__coverage-reason">{coverageReason(item)}</small> : null}</div>)}</div><small>{t("graph.updated", { time: data.generatedAt })}</small></div></details> : null}
      </div></details><Button icon={<RefreshCw size={14} />} onClick={onReload} loading={loading}>{t("graph.reload")}</Button></div></header>
    {guideOpen ? <div className="owb-rgraph__guide" role="region" aria-label={copy.guideTitle}><ol className="owb-rgraph__learn-steps" aria-label={copy.guideTitle}>{[copy.guideChoose, copy.guideRead, copy.guideOpen].map((step, index) => <li key={step} className={guideStep === index + 1 ? "is-current" : ""}><span>{index + 1}</span>{step}</li>)}</ol><div className="owb-rgraph__guide-action"><p>{guideStep === 1 ? copy.objectStep : guideStep === 2 ? guideEdge ? copy.relationStep : copy.noDirectRelations : copy.evidenceStep}</p>{guideStep === 1 && guideSeed ? <Button type="primary" size="small" onClick={() => { changeRenderer("context"); selectNode(guideSeed.id); }}>{copy.guideTryEmployee}{guideSeed.label}</Button> : guideStep === 2 && guideEdge ? <Button type="primary" size="small" onClick={() => inspectSelection({ type: "edge", id: guideEdge.id })}>{copy.guideInspect}</Button> : <Button size="small" onClick={() => setGuideOpen(false)}>{copy.guideDone}</Button>}</div></div> : null}
    {error ? <Alert type="error" title={t("graph.loadFailure")} showIcon action={<Button size="small" onClick={onReload}>{t("graph.reload")}</Button>} /> : null}
    <div className={`owb-rgraph__workspace owb-rgraph__workspace--${renderer}${inspectorOpen && selection ? " has-selection" : ""}`}>
      <aside className="owb-rgraph__filters" aria-label={t("graph.filters")}>
        <Input prefix={<Search size={14} aria-hidden="true" />} aria-label={t("graph.search")} placeholder={copy.searchPlaceholder} value={query} allowClear onChange={event => { setQuery(event.target.value); setNeighborhood(null); }} />
        {objectResults}
      </aside>
      <div ref={mainPane} tabIndex={-1} className="owb-rgraph__main" aria-label={copy.contextTitle}>
        {renderer === "context" ? <>
          {trail.length > 1 ? <nav ref={trailNavigation} className="owb-rgraph__trail" aria-label={copy.trail}><button type="button" aria-label={copy.back} onClick={() => returnTo(trail.length - 2)}><ArrowLeft size={14} /></button><ol>{trail.map((id, index) => <li key={`${id}:${index}`}>{index > 0 ? <ChevronRight size={12} aria-hidden="true" /> : null}<button type="button" aria-current={index === trail.length - 1 ? "location" : undefined} onClick={() => returnTo(index)}>{nodesById.get(id)?.label ?? t("graph.deletedSelection")}</button></li>)}</ol><button type="button" onClick={restart}>{copy.resetTrail}</button></nav> : null}
          <div className="owb-rgraph__context-wrap">
            {contextView.limited ? <p className="owb-rgraph__bounded" role="status">{t("graph.bounded", { visible: contextView.nodes.length, total: contextView.matched })}</p> : null}
            {data?.nodes.length || focusId ? <RelationshipContextExplorer nodes={contextView.nodes} edges={contextView.edges} focusId={focusId} guideActive={guideOpen} actions={contextActions} focusMissing={Boolean(focusId && !nodesById.has(focusId))} onFocus={id => selectNode(id, true)} onSelectEdge={id => inspectSelection({ type: "edge", id })} /> : emptyResults}
            {loading && data ? <span className="owb-rgraph__refreshing" role="status">{t("graph.refreshing")}</span> : null}
          </div>
        </> : <>
        <div className="owb-rgraph__diagram-actions" role="toolbar" aria-label={t("graph.canvas")}><span>{copy.diagramHint}</span>{focusedNode ? <div><Button size="small" onClick={() => changeRenderer("context")}>{copy.followRelations}</Button><Button size="small" onClick={() => inspectSelection({ type: "node", id: focusedNode.id })}>{copy.nodeEvidenceTitle}</Button></div> : null}</div>
        <div className="owb-rgraph__canvas-wrap">
          <RelationshipSpatialScene
            nodes={view.nodes}
            edges={view.edges}
            mode={renderer}
            layout={spatialLayout}
            theme={spatialTheme}
            showKnowledgeRelationships={showKnowledgeRelationships}
            selectedId={selection?.id}
            visible={visible}
            showObjectNavigation={false}
            onLayoutChange={setSpatialLayout}
            onThemeChange={setSpatialTheme}
            onShowKnowledgeRelationshipsChange={setShowKnowledgeRelationships}
            onSelect={id => selectNode(id)}
          />
          {emptyResults}
          {loading && data ? <span className="owb-rgraph__refreshing" role="status">{t("graph.refreshing")}</span> : null}
        </div>
        </>}
      </div>
      <aside ref={inspector} tabIndex={-1} hidden={!inspectorOpen || !selection} className="owb-rgraph__inspector" aria-label={t("graph.inspector")}>
        <header><h2>{t("graph.inspector")}</h2>{selection ? <Button type="text" size="small" aria-label={t("graph.close")} icon={<X size={15} />} onClick={closeDetails} /> : null}</header>
        {!selection ? <div className="owb-rgraph__inspect-empty"><FileSearch size={30} aria-hidden="true" /><h3>{copy.verifyEvidence}</h3><p>{copy.evidenceStep}</p><p>{copy.scopeHelp}</p></div> : !selectedNode && !selectedEdge ? <p role="status">{t("graph.deletedSelection")}</p> : <>
          {!selectedVisible ? <p className="owb-rgraph__bounded">{t("graph.filteredSelection")}</p> : null}
          {selectedNode ? <><Tag color={nodeColors[selectedNode.kind]}>{selectedIsSelector ? copy.selector : t(`graph.kind.${selectedNode.kind}`)}</Tag><h3>{selectedNode.label}</h3><Tag>{t(`graph.state.${selectedNode.state}`)}</Tag><Tag>{t(`graph.${selectedNode.evidence.basis}`)}</Tag>{selectedNode.resourcePath && !selectedIsSelector ? <p className="owb-rgraph__resource-path">{selectedNode.resourcePath}</p> : null}
            {selectedNode.kind === "agent" && selectedNode.positionId ? <Button block icon={<ArrowUpRight size={15} />} onClick={() => openNode(selectedNode.id)}>{t("graph.openAgent")}</Button> : null}
            {selectedIsDrive && onOpenDrive ? <Button block icon={<ArrowUpRight size={15} />} onClick={() => openNode(selectedNode.id)}>{copy.openDrive}</Button> : null}
            {selectedNode.kind === "resource" && !selectedIsDrive ? selectedIsSelector ? <p className="owb-rgraph__permission">{copy.selectorHelp}</p> : selectedNode.positionId && selectedNode.resourcePath ? <Button block icon={<ArrowUpRight size={15} />} onClick={() => openNode(selectedNode.id)}>{t("graph.openResource")}</Button> : <p>{t("graph.resourceUnavailable")}</p> : null}
            {selectedNode.kind === "policy" || selectedNode.kind === "capability" ? <Alert type="info" title={t("graph.permission.declaration_only")} /> : null}
            <div className="owb-rgraph__evidence-intro"><h4>{copy.nodeEvidenceTitle}</h4><p>{selectedNode.evidence.basis === "declared" ? copy.declaredHelp : copy.observedHelp}</p></div>
            {evidenceDetails(selectedNode.evidence, t, evidenceSourceName(selectedNode.evidence))}
            {selectedNode.facts?.length ? <details className="owb-rgraph__technical"><summary>{copy.technicalDetails}</summary><dl className="owb-rgraph__facts">{selectedNode.facts.map((fact, index) => <div key={`${fact.key}:${index}`}><dt>{fact.key}</dt><dd>{fact.value}</dd></div>)}</dl></details> : null}
          </> : selectedEdge ? <><h3>{relationText(selectedEdge)}</h3><Tag>{t(`graph.${selectedEdge.evidence.basis}`)}</Tag><p className="owb-rgraph__permission">{t(`graph.permission.${selectedEdge.permission}`)}</p><div className="owb-rgraph__evidence-intro"><h4>{copy.evidenceTitle}</h4><p>{selectedEdge.evidence.basis === "declared" ? copy.declaredHelp : copy.observedHelp}</p></div>{evidenceDetails(selectedEdge.evidence, t, evidenceSourceName(selectedEdge.evidence))}<div className="owb-rgraph__edge-actions">{[selectedEdge.source, selectedEdge.target].map((id, index) => <Button key={`${id}:${index}`} block icon={<ArrowRight size={14} />} onClick={() => selectNode(id, true)}>{nodesById.get(id)?.label ?? id}</Button>)}</div></> : null}
        </>}
      </aside>
    </div>
  </section>;
}
