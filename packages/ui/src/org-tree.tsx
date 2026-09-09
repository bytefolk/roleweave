import { ChevronRight, Folder, FolderOpen, Plus, UsersRound } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@fullstack-ai-infra/ui";
import { useT } from "./i18n";
import { type OrgTreeNodeV1, type OrgTreeSnapshot } from "./types";

/**
 * ByteFolk “Open Herd” mark, cropped from the supplied organization logo
 * concept at organization-profile/brand/logo-concepts/bytefolk-concept-c-open-herd-mark.svg.
 * The wordmark is intentionally omitted here because this is the compact
 * organization identity slot; the full logo remains the source of truth.
 */
function BytefolkOpenHerdMark() {
  return (
    <svg
      className="ui-org-tree__brand-mark"
      data-brand="bytefolk-open-herd"
      viewBox="0 0 142 116"
      aria-hidden="true"
      focusable="false"
    >
      <path fill="#1677ff" d="M12 28a8 8 0 0 1 8-8h28v36H12V28Zm8-20h12v14H20Z" />
      <path fill="#722ed1" d="M56 20h31a9 9 0 0 1 9 9v27H56V20Zm28-12h12v18H84Z" />
      <path fill="#141414" d="M12 64h36v44H28a16 16 0 0 1-16-16V64Z" />
      <path fill="#1677ff" d="M56 64h40v10h18a14 14 0 0 1 14 14v6a14 14 0 0 1-14 14H56V64Z" />
      <rect x="70" y="75" width="10" height="10" rx="3" fill="#fff" />
      <rect x="99" y="84" width="7" height="10" rx="3" fill="#fff" />
      <rect x="114" y="84" width="7" height="10" rx="3" fill="#fff" />
      <rect x="48" y="20" width="8" height="88" fill="#fff" />
      <rect x="12" y="56" width="84" height="8" fill="#fff" />
    </svg>
  );
}

/** Same-level insertion produced by an edge drop or ⌘-arrow reorder
 * (#32 §1). `order` is the final ordered child-id list of `parentId` with
 * the dragged id already moved in — it maps 1:1 onto the additive
 * change-manifest.v1 `reorder` op; the caller owns validation/apply. */
export interface OrgDropPosition {
  id: string;
  /** Target parent id; null = enterprise top level. */
  parentId: string | null;
  order: string[];
}

export interface OrgTreeProps {
  snapshot: OrgTreeSnapshot;
  /** Applied-state stamp (updatedAt); change re-triggers the 180ms fade. */
  versionStamp?: string | null;
  /** Display names keyed by position id (served via /positions/:id; the
   * frozen org-tree.v1 node carries ids only). Falls back to the raw id. */
  displayNames?: Record<string, string>;
  /** Avatar background colors keyed by position id (e.g. metadata.color);
   * positions without one get a deterministic hue from their id. */
  avatarColors?: Record<string, string>;
  /** Position ids with a turn in flight (SSE run stream) — the row's status
   * light breathes AI purple. Observed state only, never inferred. */
  runningIds?: ReadonlySet<string>;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onExpand?: (id: string, expanded: boolean) => void;
  /** Emits a directory-tree move proposal. The caller owns validation/apply. */
  onMove?: (id: string, reportTo: string | null) => void;
  /** Emits a same-level reorder proposal (insertion-line drop / ⌘↑↓←→). */
  onDropPosition?: (drop: OrgDropPosition) => void;
  /** Hover "+" creation entry (#32 AC-004): recruit under parentId (null = enterprise root). */
  onHireEntry?: (parentId: string | null) => void;
  /** Explicit group-chat entry (#53, DS-34-001 §1.3/§7): start a group draft
   * prefilled with this row's position. An explicit action only — the caller
   * owns member confirmation; the tree never broadcasts. */
  onGroupEntry?: (positionId: string) => void;
  /** Single-step undo request (#32 AC-005), ⌘/Ctrl+Z while the tree has focus. */
  onUndo?: () => void;
  moveDisabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

export interface OrgTreeNodeProps {
  node: OrgTreeNodeV1;
  depth: number;
  selected: boolean;
  /** On the selected position's ancestor chain (#73 signature move ①): lights
   * this row's guide rail segment, recursively up to the root. */
  linked: boolean;
  /** Last sibling at this depth: the vertical trunk stops at the branch
   * midpoint instead of running through to the next row (设计稿 .is-last). */
  isLast?: boolean;
  expanded: boolean;
  hasChildren: boolean;
  tabIndex: number;
  displayName?: string;
  avatarColor?: string;
  /** Live turn in flight for this position (from the SSE run stream): the
   * status light switches to the AI-purple breathing state. Never inferred. */
  running?: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onFocus: () => void;
  draggable: boolean;
  dropActive: boolean;
  /** Invalid drop target while dragging (self/descendant): greyed, no-drop. */
  dropDenied: boolean;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  /** Hover "+" entry (#32 AC-004): recruit a subordinate of this row's position. */
  onHireEntry?: () => void;
  /** Hover group entry (#53): start a group-chat draft prefilled with this row. */
  onGroupEntry?: () => void;
}

export function OrgTreeNode({
  node,
  depth,
  selected,
  linked,
  isLast = false,
  expanded,
  hasChildren,
  tabIndex,
  displayName,
  avatarColor,
  running = false,
  onSelect,
  onToggle,
  onFocus,
  draggable,
  dropActive,
  dropDenied,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onHireEntry,
  onGroupEntry,
}: OrgTreeNodeProps) {
  const t = useT();
  return (
    <div
      role="treeitem"
      data-org-node-id={node.id}
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={hasChildren ? expanded : undefined}
      tabIndex={tabIndex}
      draggable={draggable}
      className={cn(
        "ui-org-tree__row",
        selected && "is-selected",
        linked && "is-linked",
        isLast && "is-last",
        draggable && "is-draggable",
        dropActive && "is-drop-target",
        dropDenied && "is-drop-denied",
      )}
      style={{ "--d": depth } as CSSProperties}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("[data-ui-org-toggle]")) {
          onToggle();
        } else {
          onFocus();
          onSelect();
        }
      }}
      onFocus={onFocus}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {depth > 0 ? <span className="ui-org-tree__conn" aria-hidden="true" /> : null}
      {hasChildren ? (
        <button
          type="button"
          data-ui-org-toggle
          aria-label={expanded ? t("tree.collapse") : t("tree.expand")}
          className={cn("ui-org-tree__toggle", expanded && "is-expanded")}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          <ChevronRight aria-hidden="true" size={14} />
        </button>
      ) : (
        <span className="ui-org-tree__spacer" aria-hidden="true" />
      )}
      <span
        className={cn("ui-org-tree__led", running && "is-running")}
        role="img"
        aria-label={running ? t("pos.running") : t("pos.ready")}
        title={running ? t("pos.running") : t("pos.ready")}
      />
      <span
        className="ui-org-tree__icon"
        aria-hidden="true"
        style={avatarColor ? { color: avatarColor } : undefined}
      >
        {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
      </span>
      <span className="ui-org-tree__label" title={displayName ?? node.id}>
        <span className="ui-org-tree__name">{displayName ?? node.id}</span>
      </span>
      {onGroupEntry || onHireEntry ? (
        <span className="ui-org-tree__actions">
          {onGroupEntry ? (
            <button
              type="button"
              className="ui-org-tree__group"
              aria-label={t("tree.groupWith", { name: displayName ?? node.id })}
              onClick={(event) => {
                event.stopPropagation();
                onGroupEntry();
              }}
            >
              <UsersRound aria-hidden="true" size={13} />
            </button>
          ) : null}
          {onHireEntry ? (
            <button
              type="button"
              className="ui-org-tree__add"
              aria-label={t("tree.hireUnder", { name: displayName ?? node.id })}
              onClick={(event) => {
                event.stopPropagation();
                onHireEntry();
              }}
            >
              <Plus aria-hidden="true" size={13} />
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

const ENTERPRISE_ID = "__enterprise__";

/** Stable avatar hue for positions without a declared color. Exported so
 * other surfaces (#53 group roster) keep avatar hues consistent. */
export function hueForId(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hash;
}

function findInTree(nodes: OrgTreeNodeV1[], id: string): OrgTreeNodeV1 | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findInTree(node.children, id);
    if (nested) return nested;
  }
  return null;
}

function subtreeContains(node: OrgTreeNodeV1, id: string): boolean {
  for (const child of node.children) {
    if (child.id === id || subtreeContains(child, id)) return true;
  }
  return false;
}

interface TreeLocation {
  parentId: string | null;
  /** Sibling list (including the located node) in display order. */
  siblings: OrgTreeNodeV1[];
  index: number;
}

function locateInTree(nodes: OrgTreeNodeV1[], id: string, parentId: string | null = null): TreeLocation | null {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.id === id) return { parentId, siblings: nodes, index };
    const nested = locateInTree(node.children, id, node.id);
    if (nested) return nested;
  }
  return null;
}

/** Dropping onto self or any of its own descendants would create a cycle. */
function isInvalidDropTarget(tree: OrgTreeNodeV1[], draggedId: string, targetId: string): boolean {
  if (draggedId === targetId) return true;
  const dragged = findInTree(tree, draggedId);
  return dragged !== null && subtreeContains(dragged, targetId);
}

/** Final ordered child-id list of `parentId` with `sourceId` inserted
 * before/after the anchor; mirrors the change-manifest.v1 reorder op shape. */
function buildInsertion(
  tree: OrgTreeNodeV1[],
  topLevel: OrgTreeNodeV1[],
  anchor: OrgTreeNodeV1,
  zone: "before" | "after",
  sourceId: string,
): OrgDropPosition | null {
  const siblings = anchor.reportTo === null ? topLevel : findInTree(tree, anchor.reportTo)?.children ?? [];
  const ids = siblings.map((node) => node.id).filter((id) => id !== sourceId);
  const anchorIndex = ids.indexOf(anchor.id);
  if (anchorIndex < 0) return null;
  const insertAt = zone === "before" ? anchorIndex : anchorIndex + 1;
  return {
    id: sourceId,
    parentId: anchor.reportTo,
    order: [...ids.slice(0, insertAt), sourceId, ...ids.slice(insertAt)],
  };
}

type DropZone = "before" | "after" | "body";

interface DropHint {
  /** Row the hint anchors to; null = enterprise root row. */
  anchorId: string | null;
  zone: DropZone;
}

interface FlatNode {
  id: string;
  kind: "enterprise" | "position";
  node: OrgTreeNodeV1 | null;
  name: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * OrgTree — accessible org directory tree (D1 spec §2, frozen org-tree.v1).
 *
 * Root = the enterprise (snapshot.business, Brand icon); the engine's nested
 * tree[] (reportTo-null owner as first level, children by reporting line)
 * renders beneath it. The frozen org-tree.v1 node deliberately carries only
 * routing data; display names are served via /positions/:id. Budget and mode
 * stay in the selected position record instead of repeating in every row.
 *
 * Accessibility: role=tree/treeitem, roving tabindex; ArrowUp/Down/Home/End
 * move, ArrowRight/Left expand/collapse or move to child/parent, Enter
 * toggles (ModuleRail arrow pattern). Version-stamp (updatedAt) driven
 * updates with a 180ms fade; the UI never polls.
 */
export function OrgTree({
  snapshot,
  versionStamp,
  displayNames,
  avatarColors,
  runningIds,
  selectedId,
  onSelect,
  onExpand,
  onMove,
  onDropPosition,
  onHireEntry,
  onGroupEntry,
  onUndo,
  moveDisabled = false,
  className,
  ariaLabel,
}: OrgTreeProps) {
  /** #146：默认 aria 走目录（无 Provider 时回退 zh 全量目录）。 */
  const t = useT();
  const resolvedAriaLabel = ariaLabel ?? t("tree.dir");
  const enterpriseName = snapshot.business?.trim() ?? "";
  const useEnterpriseRoot = enterpriseName.length > 0 && snapshot.tree.length > 0;
  const topLevel = snapshot.tree;

  const allParentIds = useMemo(() => {
    const ids = new Set<string>();
    if (useEnterpriseRoot && topLevel.length > 0) ids.add(ENTERPRISE_ID);
    const visit = (node: OrgTreeNodeV1): void => {
      if (node.children.length > 0) ids.add(node.id);
      for (const child of node.children) visit(child);
    };
    for (const node of topLevel) visit(node);
    return ids;
  }, [topLevel, useEnterpriseRoot]);

  /** id → parentId (null = top level), one pass over the whole tree. */
  const parentOf = useMemo(() => {
    const map = new Map<string, string | null>();
    const visit = (node: OrgTreeNodeV1, parentId: string | null): void => {
      map.set(node.id, parentId);
      for (const child of node.children) visit(child, node.id);
    };
    for (const node of topLevel) visit(node, null);
    return map;
  }, [topLevel]);

  /** Selected position's ancestor chain, inclusive (#73 signature move ①:
   * 连接线=汇报线，选中即递推点亮祖先链路). Walks parentOf up to the root,
   * then includes the enterprise pseudo-row so the top trunk lights too. */
  const linkedIds = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedId) return ids;
    let current: string | null | undefined = selectedId;
    while (current) {
      ids.add(current);
      current = parentOf.get(current) ?? null;
    }
    if (useEnterpriseRoot) ids.add(ENTERPRISE_ID);
    return ids;
  }, [selectedId, parentOf, useEnterpriseRoot]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(allParentIds));
  const [focusedId, setFocusedId] = useState<string | null>(selectedId ?? null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | undefined>(undefined);
  /** Row currently refused during dragover (self/descendant cycle). */
  const [deniedId, setDeniedId] = useState<string | null>(null);
  /** Light inline toast for refused releases; auto-hides. */
  const [toast, setToast] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const id of allParentIds) next.add(id);
      return next;
    });
  }, [allParentIds]);

  const flatNodes = useMemo<FlatNode[]>(() => {
    const result: FlatNode[] = [];
    const pushNode = (node: OrgTreeNodeV1, depth: number): void => {
      const hasChildren = node.children.length > 0;
      const isExpanded = hasChildren && expanded.has(node.id);
      result.push({ id: node.id, kind: "position", node, name: node.id, depth, hasChildren, expanded: isExpanded });
      if (isExpanded) {
        for (const child of node.children) pushNode(child, depth + 1);
      }
    };
    if (useEnterpriseRoot) {
      const hasChildren = topLevel.length > 0;
      const isExpanded = hasChildren && expanded.has(ENTERPRISE_ID);
      result.push({ id: ENTERPRISE_ID, kind: "enterprise", node: null, name: enterpriseName, depth: 0, hasChildren, expanded: isExpanded });
      if (isExpanded) {
        for (const node of topLevel) pushNode(node, 1);
      }
    } else {
      for (const node of topLevel) pushNode(node, 0);
    }
    return result;
  }, [topLevel, expanded, useEnterpriseRoot, enterpriseName]);

  const focusedIndex = flatNodes.findIndex((entry) => entry.id === focusedId);

  const focusNode = useCallback((id: string) => {
    setFocusedId(id);
    const element = containerRef.current?.querySelector(`[data-org-node-id="${id}"]`);
    if (element instanceof HTMLElement) element.focus();
  }, []);

  const moveFocus = useCallback(
    (nextIndex: number) => {
      const wrapped = (nextIndex + flatNodes.length) % flatNodes.length;
      const node = flatNodes[wrapped];
      if (node) focusNode(node.id);
    },
    [flatNodes, focusNode],
  );

  const toggleNode = useCallback(
    (id: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        const isExpanded = next.has(id);
        if (isExpanded) next.delete(id);
        else next.add(id);
        onExpand?.(id, !isExpanded);
        return next;
      });
    },
    [onExpand],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const key = event.key;
    // #32 AC-005: ⌘/Ctrl+Z requests single-step undo while the tree has
    // focus — container-level, so it fires even when no row is focused.
    if ((event.metaKey || event.ctrlKey) && (key === "z" || key === "Z")) {
      event.preventDefault();
      onUndo?.();
      return;
    }
    const current = flatNodes[focusedIndex];
    if (!current) return;
    // #32 §1: ⌘↑/⌘↓ same-level reorder, ⌘←/⌘→ level change; coexists with
    // the plain-arrow navigation below (modifier required, no conflict).
    if ((event.metaKey || event.ctrlKey) && key.startsWith("Arrow")) {
      if (current.kind !== "position" || !current.node || moveDisabled) return;
      const id = current.node.id;
      if (id === snapshot.owner) {
        event.preventDefault();
        setToast(t("tree.ownerToast"));
        return;
      }
      const location = locateInTree(snapshot.tree, id);
      if (!location) return;
      event.preventDefault();
      if (key === "ArrowUp" || key === "ArrowDown") {
        if (!onDropPosition) return;
        const targetIndex = key === "ArrowUp" ? location.index - 1 : location.index + 1;
        if (targetIndex < 0 || targetIndex >= location.siblings.length) return;
        const order = location.siblings.map((node) => node.id).filter((candidate) => candidate !== id);
        order.splice(targetIndex, 0, id);
        onDropPosition({ id, parentId: location.parentId, order });
        return;
      }
      if (key === "ArrowLeft") {
        // Outdent: report to the parent's own report line.
        if (!onMove || location.parentId === null) return;
        const parent = findInTree(snapshot.tree, location.parentId);
        if (!parent) return;
        onMove(id, parent.reportTo);
        return;
      }
      if (key === "ArrowRight") {
        // Indent: report to the previous sibling.
        if (!onMove) return;
        const previousSibling = location.siblings[location.index - 1];
        if (!previousSibling) return;
        onMove(id, previousSibling.id);
      }
      return;
    }
    if (key === "ArrowDown") {
      event.preventDefault();
      moveFocus(focusedIndex + 1);
      return;
    }
    if (key === "ArrowUp") {
      event.preventDefault();
      moveFocus(focusedIndex - 1);
      return;
    }
    if (key === "Home") {
      event.preventDefault();
      moveFocus(0);
      return;
    }
    if (key === "End") {
      event.preventDefault();
      moveFocus(flatNodes.length - 1);
      return;
    }
    if (key === "ArrowRight") {
      event.preventDefault();
      if (current.hasChildren && !current.expanded) {
        toggleNode(current.id);
      } else if (current.hasChildren) {
        if (current.kind === "enterprise") {
          moveFocus(focusedIndex + 1);
        } else {
          const childIndex = flatNodes.findIndex((entry) => entry.node?.id === current.node?.children[0]?.id);
          if (childIndex >= 0) moveFocus(childIndex);
        }
      }
      return;
    }
    if (key === "ArrowLeft") {
      event.preventDefault();
      if (current.hasChildren && current.expanded) {
        toggleNode(current.id);
      } else if (current.kind === "position" && current.node?.reportTo) {
        const parentIndex = flatNodes.findIndex((entry) => entry.id === current.node?.reportTo);
        if (parentIndex >= 0) moveFocus(parentIndex);
      }
      return;
    }
    if (key === "Enter" && current.hasChildren) {
      event.preventDefault();
      toggleNode(current.id);
    }
  };

  const [refreshed, setRefreshed] = useState(false);
  useEffect(() => {
    if (versionStamp === null || versionStamp === undefined) return;
    setRefreshed(true);
    const timer = setTimeout(() => setRefreshed(false), 180);
    return () => clearTimeout(timer);
  }, [versionStamp]);

  if (snapshot.positionCount === 0 || snapshot.tree.length === 0) {
    return (
      <div className={cn("ui-org-tree", "ui-org-tree--empty", className)}>
        <p>{t("tree.emptyHireHint")}</p>
        <button
          type="button"
          className="ui-org-tree__hire-placeholder"
          disabled={!onHireEntry}
          title={onHireEntry ? undefined : t("tree.emptyHireDisabled")}
          onClick={() => onHireEntry?.(null)}
        >
          {t("tree.emptyHireCta")}
        </button>
      </div>
    );
  }

  const resetDragState = (): void => {
    setDraggedId(null);
    setDropHint(undefined);
    setDeniedId(null);
  };

  const renderPosition = (node: OrgTreeNodeV1, depth: number, isLast: boolean): ReactNode => {
    const hasChildren = node.children.length > 0;
    const isExpanded = hasChildren && expanded.has(node.id);
    const hint = dropHint?.anchorId === node.id ? dropHint : null;
    return (
      <Fragment key={node.id}>
        {hint?.zone === "before" ? <div className="ui-org-tree__drop-line" aria-hidden="true" /> : null}
        <OrgTreeNode
          node={node}
          depth={depth}
          selected={selectedId === node.id}
          linked={linkedIds.has(node.id)}
          isLast={isLast}
          expanded={isExpanded}
          hasChildren={hasChildren}
          tabIndex={focusedId === node.id ? 0 : -1}
          displayName={displayNames?.[node.id]}
          avatarColor={avatarColors?.[node.id]}
          running={runningIds?.has(node.id) === true}
          onSelect={() => onSelect?.(node.id)}
          onToggle={() => toggleNode(node.id)}
          onFocus={() => setFocusedId(node.id)}
          draggable={!moveDisabled && node.id !== snapshot.owner}
          dropActive={hint?.zone === "body"}
          dropDenied={deniedId === node.id}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-org-workbench-position-id", node.id);
            setDraggedId(node.id);
          }}
          onDragEnd={() => {
            if (deniedId !== null) setToast(t("tree.selfDropToast"));
            resetDragState();
          }}
          onDragOver={(event) => {
            if (!draggedId || moveDisabled) return;
            if (isInvalidDropTarget(snapshot.tree, draggedId, node.id)) {
              // No preventDefault: the browser refuses the drop, and the
              // source's dragend surfaces the light toast below.
              event.dataTransfer.dropEffect = "none";
              setDeniedId(node.id);
              setDropHint(undefined);
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDeniedId(null);
            const rect = event.currentTarget.getBoundingClientRect();
            const y = event.clientY - rect.top;
            // Top/bottom quarter rows = same-level insertion, middle half =
            // reparent (body); a zero-height rect (jsdom) resolves to body.
            const zone: DropZone =
              rect.height > 0 && y < rect.height * 0.25
                ? "before"
                : rect.height > 0 && y > rect.height * 0.75
                  ? "after"
                  : "body";
            setDropHint({ anchorId: node.id, zone });
          }}
          onDrop={(event) => {
            event.preventDefault();
            const source = draggedId || event.dataTransfer.getData("application/x-org-workbench-position-id");
            const zone = hint?.zone ?? "body";
            resetDragState();
            if (!source || isInvalidDropTarget(snapshot.tree, source, node.id)) return;
            if (zone === "before" || zone === "after") {
              const drop = buildInsertion(snapshot.tree, topLevel, node, zone, source);
              if (drop) onDropPosition?.(drop);
              return;
            }
            onMove?.(source, node.id);
          }}
          onHireEntry={onHireEntry && !moveDisabled ? () => onHireEntry(node.id) : undefined}
          onGroupEntry={onGroupEntry ? () => onGroupEntry(node.id) : undefined}
        />
        {hint?.zone === "after" ? <div className="ui-org-tree__drop-line" aria-hidden="true" /> : null}
        {isExpanded && hasChildren
          ? node.children.map((child, index) =>
              renderPosition(child, depth + 1, index === node.children.length - 1),
            )
          : null}
      </Fragment>
    );
  };

  const enterpriseExpanded = expanded.has(ENTERPRISE_ID) && topLevel.length > 0;

  return (
    <div
      role="tree"
      aria-label={resolvedAriaLabel}
      tabIndex={0}
      ref={containerRef}
      className={cn("ui-org-tree", refreshed && "is-refreshed", className)}
      onKeyDown={handleKeyDown}
    >
      {useEnterpriseRoot ? (
        <Fragment>
          <div
            role="treeitem"
            data-org-node-id={ENTERPRISE_ID}
            aria-level={1}
            aria-expanded={enterpriseExpanded}
            tabIndex={focusedId === ENTERPRISE_ID ? 0 : -1}
            className={cn(
              "ui-org-tree__row",
              "ui-org-tree__row--enterprise",
              dropHint?.anchorId === null && dropHint.zone === "body" && "is-drop-target",
            )}
            style={{ "--d": 0 } as CSSProperties}
            onClick={() => {
              if (topLevel.length > 0) toggleNode(ENTERPRISE_ID);
            }}
            onFocus={() => setFocusedId(ENTERPRISE_ID)}
            onDragOver={(event) => {
              if (!draggedId || moveDisabled) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDeniedId(null);
              setDropHint({ anchorId: null, zone: "body" });
            }}
            onDragLeave={() => setDropHint(undefined)}
            onDrop={(event) => {
              event.preventDefault();
              const source = draggedId || event.dataTransfer.getData("application/x-org-workbench-position-id");
              resetDragState();
              if (source) onMove?.(source, null);
            }}
          >
            <button
              type="button"
              data-ui-org-toggle
              aria-label={enterpriseExpanded ? t("tree.collapse") : t("tree.expand")}
              className={cn("ui-org-tree__toggle", enterpriseExpanded && "is-expanded")}
              onClick={(event) => {
                event.stopPropagation();
                toggleNode(ENTERPRISE_ID);
              }}
            >
              <ChevronRight aria-hidden="true" size={14} />
            </button>
            <span
              className={cn("ui-org-tree__led", runningIds && runningIds.size > 0 && "is-running")}
              role="img"
              aria-label={runningIds && runningIds.size > 0 ? t("tree.orgRunning") : t("tree.orgReady")}
              title={runningIds && runningIds.size > 0 ? t("tree.orgRunning") : t("tree.orgReady")}
            />
            <span className="ui-org-tree__icon ui-org-tree__icon--brand" aria-hidden="true">
              <BytefolkOpenHerdMark />
            </span>
            <span className="ui-org-tree__label" title={enterpriseName}>
              <span className="ui-org-tree__name">{enterpriseName}</span>
            </span>
          </div>
          {enterpriseExpanded
            ? topLevel.map((node, index) =>
                renderPosition(node, 1, index === topLevel.length - 1),
              )
            : null}
        </Fragment>
      ) : (
        topLevel.map((node, index) => renderPosition(node, 0, index === topLevel.length - 1))
      )}
      {toast !== null ? (
        <div className="ui-org-tree__toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
