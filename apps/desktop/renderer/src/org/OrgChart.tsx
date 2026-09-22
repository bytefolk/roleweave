/**
 * P0 组织图可视化（体验追赶项）：把 org-tree.v1 应用态汇报树渲染成自上而下的
 * 节点图。纯展示组件——数据全部经 props 注入，不触 IPC；布局为纯 CSS flex +
 * 伪元素连接线（经典族谱树走线），不引图形库。
 *
 * 数据面口径：org-tree.v1 冻结面只携带 id / reportTo / budget / children
 * （shared org-tree.ts 注释：display names live in workspace-org.v1 roles and
 * are served via /positions/:id — the client never invents semantics）。组织图
 * 只负责表达层级与选择；预算、权限和运行模式统一在下方岗位档案展示，避免
 * 在同一页面重复堆信息。缺条目时回退岗位 id，绝不编造语义。
 */
import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Empty, Skeleton } from "antd";
import { FileText, Network, ZoomIn, ZoomOut } from "lucide-react";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  DocsFileEntry,
  OrgTreeNodeV1,
  OrgTreeSnapshot,
} from "@roleweave/shared";
import { useT } from "@roleweave/ui";
import { PositionAvatar } from "../PositionAvatar";

/* jsdom / 无 rAF 环境退化为同步执行，缩放锚点补偿依旧可测。 */
const scheduleFrame = (fn: () => void): void => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
  else fn();
};

export interface OrgChartView {
  x: number;
  y: number;
  scale: number;
}

/** Center a measured chart anchor without moving the default tree off its top edge. */
export function centerOrgChartView(
  viewport: { width: number; height: number },
  anchor: { x: number; y: number },
  view: OrgChartView,
  centerY = false,
): OrgChartView {
  return {
    ...view,
    x: viewport.width / 2 - anchor.x * view.scale,
    y: centerY ? Math.max(8, viewport.height / 2 - anchor.y * view.scale) : view.y,
  };
}

/** Fit the complete chart into the canvas while preserving a small visual inset. */
export function fitOrgChartView(
  viewport: { width: number; height: number },
  contentWidth: number,
  view: OrgChartView,
  contentHeight = 0,
): OrgChartView {
  const availableWidth = Math.max(1, viewport.width - 28);
  const availableHeight = Math.max(1, viewport.height - 16);
  const widthScale = availableWidth / Math.max(1, contentWidth);
  const heightScale = contentHeight > 0 ? availableHeight / contentHeight : 1;
  const scale = Math.max(0.5, Math.min(1, widthScale, heightScale));
  return {
    ...view,
    scale,
    x: (viewport.width - contentWidth * scale) / 2,
  };
}

export interface OrgChartProps {
  collapsible?: boolean;
  /** 应用态快照；null 或空树 → 空态。 */
  snapshot: OrgTreeSnapshot | null;
  /** 加载态：骨架屏（treeLoading 同源）。 */
  loading?: boolean;
  /** 角色名（展示名）按岗位 id；缺省回退 id。 */
  displayNames?: Record<string, string>;
  /** 头像底色按岗位 id（metadata.color），与侧栏树/群聊同色。 */
  avatarColors?: Record<string, string>;
  avatarUrls?: Record<string, string>;
  /** Position-scoped resources turn the hierarchy into a navigable knowledge graph. */
  resources?: Record<string, DocsFileEntry[]>;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  className?: string;
}

export type KnowledgeNodeKind = "agent" | "document";
export type KnowledgeEdgeKind = "reports" | "owns";
export interface KnowledgeGraphNode { id: string; kind: KnowledgeNodeKind; agentId: string; label: string; path?: string }
export interface KnowledgeGraphEdge { id: string; source: string; target: string; kind: KnowledgeEdgeKind }

export function buildKnowledgeGraph(snapshot: OrgTreeSnapshot, resources: Record<string, DocsFileEntry[]>): {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
} {
  const nodes: KnowledgeGraphNode[] = [];
  const edges: KnowledgeGraphEdge[] = [];
  const visit = (node: OrgTreeNodeV1): void => {
    nodes.push({ id: `agent:${node.id}`, kind: "agent", agentId: node.id, label: node.id });
    if (node.reportTo) edges.push({ id: `reports:${node.reportTo}:${node.id}`, source: `agent:${node.reportTo}`, target: `agent:${node.id}`, kind: "reports" });
    node.children.forEach(visit);
  };
  snapshot.tree.forEach(visit);
  for (const agent of nodes.filter((node) => node.kind === "agent")) {
    for (const resource of resources[agent.agentId] ?? []) {
      const id = `document:${agent.agentId}:${resource.path}`;
      nodes.push({ id, kind: "document", agentId: agent.agentId, label: resource.path.split("/").at(-1) ?? resource.path, path: resource.path });
      edges.push({ id: `owns:${agent.agentId}:${resource.path}`, source: agent.id, target: id, kind: "owns" });
    }
  }
  return { nodes, edges };
}

type KnowledgeFlowData = Record<string, unknown> & KnowledgeGraphNode & { displayName: string; selected: boolean; onSelect?: (id: string) => void };

function KnowledgeFlowNode({ data }: NodeProps<Node<KnowledgeFlowData>>) {
  const t = useT();
  return <button type="button" className={`owb-knowledge-node owb-knowledge-node--${data.kind}${data.selected ? " is-selected" : ""}`}
    data-org-chart-node={data.kind === "agent" ? data.agentId : undefined}
    aria-label={data.kind === "agent" ? t("tree.graphAgentAria", { name: data.displayName }) : t("tree.graphDocumentAria", { document: data.label, agent: data.displayName })}
    onClick={() => data.onSelect?.(data.agentId)}>
    <Handle type="target" position={Position.Top} />
    <span className="owb-knowledge-node__icon">{data.kind === "agent" ? <Network size={15} /> : <FileText size={15} />}</span>
    <span><strong>{data.kind === "agent" ? data.displayName : data.label}</strong><small>{data.kind === "agent" ? "Agent" : data.displayName}</small></span>
    <Handle type="source" position={Position.Bottom} />
  </button>;
}

const knowledgeNodeTypes = { knowledge: KnowledgeFlowNode };

function KnowledgeGraph({ snapshot, resources, displayNames, selectedId, onSelect }: {
  snapshot: OrgTreeSnapshot; resources: Record<string, DocsFileEntry[]>; displayNames?: Record<string, string>;
  selectedId?: string | null; onSelect?: (id: string) => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState<"all" | KnowledgeEdgeKind>("all");
  const graph = useMemo(() => buildKnowledgeGraph(snapshot, resources), [snapshot, resources]);
  const visibleEdges = graph.edges.filter((edge) => filter === "all" || edge.kind === filter);
  const visibleNodeIds = new Set(visibleEdges.flatMap((edge) => [edge.source, edge.target]));
  const depthByAgent = new Map<string, number>();
  const markDepth = (node: OrgTreeNodeV1, depth: number): void => { depthByAgent.set(node.id, depth); node.children.forEach((child) => markDepth(child, depth + 1)); };
  snapshot.tree.forEach((node) => markDepth(node, 0));
  const agents = graph.nodes.filter((node) => node.kind === "agent");
  const agentIndex = new Map(agents.map((node, index) => [node.agentId, index]));
  const resourceIndex = new Map<string, number>();
  const nodes: Node<KnowledgeFlowData>[] = graph.nodes.filter((node) => filter === "all" || visibleNodeIds.has(node.id)).map((node) => {
    const order = agentIndex.get(node.agentId) ?? 0;
    const resourceOrder = resourceIndex.get(node.agentId) ?? 0;
    if (node.kind === "document") resourceIndex.set(node.agentId, resourceOrder + 1);
    return { id: node.id, type: "knowledge", position: node.kind === "agent"
      ? { x: 90 + order * 220, y: 45 + (depthByAgent.get(node.agentId) ?? 0) * 125 }
      : { x: 100 + order * 220 + resourceOrder * 45, y: 310 + (depthByAgent.get(node.agentId) ?? 0) * 80 },
    data: { ...node, displayName: displayNames?.[node.agentId] ?? node.agentId, selected: selectedId === node.agentId, onSelect } };
  });
  const edges: Edge[] = visibleEdges.map((edge) => ({ ...edge, type: "smoothstep", animated: edge.kind === "owns", className: `owb-knowledge-edge owb-knowledge-edge--${edge.kind}` }));
  return <div className="owb-knowledge-graph">
    <div className="owb-knowledge-graph__filters" role="group" aria-label={t("tree.graphFiltersAria")}>
      {(["all", "reports", "owns"] as const).map((kind) => <button key={kind} type="button" aria-pressed={filter === kind}
        aria-label={t(kind === "owns" ? "tree.graphFilterDocumentsAria" : kind === "reports" ? "tree.graphFilterAgentsAria" : "tree.graphFilterAllAria")}
        onClick={() => setFilter(kind)}>{t(kind === "all" ? "tree.graphAll" : kind === "reports" ? "tree.graphAgents" : "tree.graphDocuments")}</button>)}
    </div>
    <div className="owb-knowledge-graph__canvas">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={knowledgeNodeTypes} fitView minZoom={0.35} maxZoom={1.8} nodesDraggable nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}>
        <Background gap={22} size={1} /><Controls showInteractive={false} />
      </ReactFlow>
      <div className="owb-knowledge-graph__edge-probes" aria-hidden="true">{visibleEdges.map((edge) => <i key={edge.id} data-graph-edge-kind={edge.kind} />)}</div>
      <div className="owb-knowledge-graph__semantic-nodes">
        {graph.nodes.filter((node) => node.kind === "document").map((node) => <button key={node.id} type="button"
          aria-label={t("tree.graphDocumentAria", { document: node.label, agent: displayNames?.[node.agentId] ?? node.agentId })}
          onClick={() => onSelect?.(node.agentId)}>{node.label}</button>)}
      </div>
    </div>
  </div>;
}

interface ChartNodeProps {
  node: OrgTreeNodeV1;
  displayNames?: Record<string, string>;
  avatarColors?: Record<string, string>;
  avatarUrls?: Record<string, string>;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}

function ChartNode({
  node,
  displayNames,
  avatarColors,
  avatarUrls,
  selectedId,
  onSelect,
}: ChartNodeProps) {
  const t = useT();
  const name = displayNames?.[node.id] ?? node.id;
  const selected = selectedId === node.id;
  return (
    <div className="owb-org-chart__branch">
      <button
        type="button"
        data-org-chart-node={node.id}
        className={`owb-org-chart__card${selected ? " is-selected" : ""}`}
        aria-pressed={selected}
        aria-label={t("tree.chartNodeAria", { name })}
        onClick={() => onSelect?.(node.id)}
      >
        <span className="owb-org-chart__card-head">
          <PositionAvatar
            colors={avatarColors}
            sources={avatarUrls}
            id={node.id}
            name={name}
            className="owb-org-chart__avatar"
          />
          <span className="owb-org-chart__card-text">
            <span className="owb-org-chart__name">{name}</span>
          </span>
        </span>
      </button>
      {node.children.length > 0 ? (
        <div className="owb-org-chart__children">
          {node.children.map((child) => (
            <ChartNode
              key={child.id}
              node={child}
              displayNames={displayNames}
              avatarColors={avatarColors}
              avatarUrls={avatarUrls}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 折叠态默认展开——收起只是把面积让给下面的对话面板，由使用者自己权衡，
 * 绝不是系统用固定高度替他做这个决定（那正是旧实现 240px 硬顶的问题）。 */
export function OrgChart({
  collapsible = true,
  snapshot,
  loading = false,
  displayNames,
  avatarColors,
  avatarUrls,
  resources,
  selectedId,
  onSelect,
  className,
}: OrgChartProps) {
  const t = useT();
  const empty = snapshot === null || snapshot.tree.length === 0;
  const [collapsed, setCollapsed] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  // #167：画布 = transform 平移+缩放。视口 overflow:hidden，零滚动条；
  // 平移纯拖拽（pointer-capture，4px 阈值保护节点点击），缩放锚定光标。
  // 布局不再随滚动条出现/消失跳动。
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const autoCenterRef = useRef(true);
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ id: number; x: number; y: number; vx: number; vy: number; active: boolean } | null>(null);

  const onPanPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    panRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, active: false };
  };

  const onPanPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current;
    if (!pan || event.pointerId !== pan.id) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (!pan.active) {
      if (Math.hypot(dx, dy) < 4) return;
      pan.active = true;
      setPanning(true);
      autoCenterRef.current = false;
      try {
        bodyRef.current?.setPointerCapture?.(event.pointerId);
      } catch {
        // jsdom / 无指针环境：capture 不可用时退化为普通 move 跟踪。
      }
    }
    event.preventDefault();
    setView((v) => ({ ...v, x: pan.vx + dx, y: pan.vy + dy }));
  };

  const onPanEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (panRef.current?.id !== event.pointerId) return;
    panRef.current = null;
    setPanning(false);
  };

  // 缩放对齐 Mac 触控板习惯：捏合（wheel+ctrlKey）以光标为锚点。
  // React 根上的 wheel 是 passive 的，preventDefault 必须走原生监听。
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 2;
  const zoom = view.scale;

  const applyZoom = (next: number, anchor?: { x: number; y: number }): void => {
    autoCenterRef.current = false;
    setView((v) => {
      const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
      if (clamped === v.scale) return v;
      const k = clamped / v.scale;
      const cx = anchor?.x ?? (bodyRef.current?.clientWidth ?? 0) / 2;
      const cy = anchor?.y ?? (bodyRef.current?.clientHeight ?? 0) / 2;
      return { scale: clamped, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  };

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      autoCenterRef.current = false;
      setView((v) => {
        const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.scale * factor));
        if (clamped === v.scale) return v;
        const k = clamped / v.scale;
        return { scale: clamped, x: anchor.x - (anchor.x - v.x) * k, y: anchor.y - (anchor.y - v.y) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /**
   * Center from actual rendered geometry instead of offsetLeft. offsetLeft is
   * relative to the immediate branch, so it drifts for deep descendants and
   * leaves a wide tree visibly off-center in the panel.
   */
  const centerOnTarget = useCallback((targetId: string | null, centerY: boolean, fitToViewport = false): void => {
    scheduleFrame(() => {
      const body = bodyRef.current;
      const stage = stageRef.current;
      if (!body || !stage || body.clientWidth <= 0 || body.clientHeight <= 0) return;
      const target = targetId
        ? stage.querySelector<HTMLElement>(`[data-org-chart-node="${CSS.escape(targetId)}"]`)
        : stage.querySelector<HTMLElement>("[data-org-chart-node]");
      if (!target) return;

      const current = viewRef.current;
      const stageRect = stage.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      if (fitToViewport) {
        const contentWidth = stage.offsetWidth || stageRect.width / current.scale;
        const contentHeight = stage.offsetHeight || stageRect.height / current.scale;
        if (contentWidth > 0) {
          setView((next) => fitOrgChartView(
            { width: body.clientWidth, height: body.clientHeight },
            contentWidth,
            next,
            contentHeight,
          ));
          return;
        }
      }
      const anchor = {
        x: (targetRect.left - stageRect.left + targetRect.width / 2) / current.scale,
        y: (targetRect.top - stageRect.top + targetRect.height / 2) / current.scale,
      };
      autoCenterRef.current = true;
      setView((next) => centerOrgChartView(
        { width: body.clientWidth, height: body.clientHeight },
        anchor,
        next,
        centerY,
      ));
    });
  }, []);

  // Fit the complete tree horizontally on every automatic layout pass. The
  // selected card still receives its visual state, but it must not drag the
  // whole organization graph sideways and clip its siblings. Manual pan and
  // zoom take ownership after the first pointer interaction.
  useLayoutEffect(() => {
    if (empty || collapsed) return;
    const hasSelection = selectedId !== null && selectedId !== undefined;
    centerOnTarget(selectedId ?? snapshot?.tree[0]?.id ?? null, hasSelection, true);
  }, [centerOnTarget, collapsed, empty, selectedId, snapshot]);

  // Keep the automatic position stable while the panel resizes. Once the user
  // pans or zooms, their explicit view owns the canvas until a new selection
  // or snapshot asks for a fresh anchor.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver !== "function") return;
    const recenter = (): void => {
      if (!autoCenterRef.current || collapsed || empty) return;
      const hasSelection = selectedId !== null && selectedId !== undefined;
      centerOnTarget(selectedId ?? snapshot?.tree[0]?.id ?? null, hasSelection, true);
    };
    const observer = new ResizeObserver(recenter);
    observer.observe(body);
    return () => observer.disconnect();
  }, [centerOnTarget, collapsed, empty, selectedId, snapshot]);

  return (
    <section
      className={`owb-panel owb-org-chart${collapsed ? " is-collapsed" : ""}${className ? ` ${className}` : ""}`}
      aria-label={t("tree.chart")}
    >
      <header className="owb-org-chart__head">
        {collapsible ? <button
          type="button"
          className="owb-org-chart__toggle"
          aria-expanded={!collapsed}
          aria-controls="owb-org-chart-body"
          aria-label={collapsed ? t("tree.chartExpand") : t("tree.chartCollapse")}
          title={collapsed ? t("tree.chartExpand") : t("tree.chartCollapse")}
          onClick={() => setCollapsed((v) => !v)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button> : null}
        <span className="owb-org-chart__head-title">{resources ? t("tree.knowledgeGraph") : t("tree.chart")}</span>
        {snapshot && !empty && !resources ? (
          <span className="owb-org-chart__zoom">
            <button
              type="button"
              className="owb-org-chart__toggle"
              aria-label={t("tree.zoomOut")}
              title={t("tree.zoomOutTitle")}
              disabled={zoom <= ZOOM_MIN}
              onClick={() => applyZoom(zoom / 1.1)}
            >
              <ZoomOut aria-hidden="true" size={13} />
            </button>
            <button
              type="button"
              className="owb-org-chart__zoom-pct"
              aria-label={t("tree.zoomReset")}
              title={t("tree.zoomTitle")}
              onClick={() => applyZoom(1)}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="owb-org-chart__toggle"
              aria-label={t("tree.zoomIn")}
              title={t("tree.zoomInTitle")}
              disabled={zoom >= ZOOM_MAX}
              onClick={() => applyZoom(zoom * 1.1)}
            >
              <ZoomIn aria-hidden="true" size={13} />
            </button>
          </span>
        ) : null}
      </header>
      <div
        className={`owb-org-chart__body${panning ? " is-panning" : ""}`}
        id="owb-org-chart-body"
        ref={bodyRef}
        onPointerDown={onPanPointerDown}
        onPointerMove={onPanPointerMove}
        onPointerUp={onPanEnd}
        onPointerCancel={onPanEnd}
      >
        {loading ? (
          <div className="owb-org-chart__loading" aria-label={t("tree.chartLoading")}>
            <Skeleton active title={false} paragraph={{ rows: 3 }} />
          </div>
        ) : empty ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("tree.chartEmpty")} />
        ) : resources && snapshot ? (
          <KnowledgeGraph snapshot={snapshot} resources={resources} displayNames={displayNames} selectedId={selectedId} onSelect={onSelect} />
        ) : (
          <div
            className="owb-org-chart__stage"
            ref={stageRef}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          >
            <div className="owb-org-chart__roots">
              {snapshot.tree.map((root) => (
                <ChartNode
                  key={root.id}
                  node={root}
                  displayNames={displayNames}
                  avatarColors={avatarColors}
                  avatarUrls={avatarUrls}
                  selectedId={selectedId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
