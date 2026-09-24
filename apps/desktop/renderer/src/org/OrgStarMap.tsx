import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OrgTreeSnapshot } from "@roleweave/shared";
import { useT } from "@roleweave/ui";
import {
  findStarMapBody,
  isInvalidStarMapDrop,
  layoutStarMap,
  matchStarMapQuery,
  type StarMapBody,
  type StarMapLayout,
} from "./star-map-layout";
import "./OrgStarMap.css";

export interface OrgStarMapProps {
  snapshot: OrgTreeSnapshot | null;
  displayNames?: Record<string, string>;
  avatarUrls?: Record<string, string>;
  runningIds?: ReadonlySet<string>;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onMove?: (id: string, reportTo: string | null) => void;
  onHireEntry?: (parentId: string | null) => void;
  onDismiss?: (id: string) => void;
  onUndo?: () => void;
  moveDisabled?: boolean;
}

export function canUseStarMapWebGL(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

const DRAG_THRESHOLD = 6;

export function OrgStarMap({
  snapshot,
  displayNames,
  avatarUrls,
  runningIds,
  selectedId,
  onSelect,
  onMove,
  onHireEntry,
  onDismiss,
  onUndo,
  moveDisabled = false,
}: OrgStarMapProps) {
  const t = useT();
  const layout = useMemo(() => (snapshot ? layoutStarMap(snapshot) : { bodies: [], rings: [], starId: null as string | null }), [snapshot]);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(selectedId ?? null);
  const [webgl] = useState(canUseStarMapWebGL);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<{ flyTo(id: string): void; reset(): void; zoom(direction: 1 | -1): void; dispose(): void } | null>(null);
  const matches = useMemo(
    () => matchStarMapQuery(layout.bodies, displayNames, query),
    [layout.bodies, displayNames, query],
  );
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const selected = focusedId ?? selectedId ?? null;
  const selectedBody = selected ? findStarMapBody(layout, selected) : undefined;

  useEffect(() => {
    setFocusedId(selectedId ?? null);
  }, [selectedId]);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), 1800);
    return () => clearTimeout(timer);
  }, [notice]);

  const flyTo = useCallback((id: string) => {
    setFocusedId(id);
    onSelect?.(id);
    sceneRef.current?.flyTo(id);
  }, [onSelect]);

  const proposeMove = useCallback((sourceId: string, targetId: string) => {
    if (!snapshot || moveDisabled) return;
    if (isInvalidStarMapDrop(snapshot, sourceId, targetId)) {
      setNotice(t("tree.selfDropToast"));
      return;
    }
    onMove?.(sourceId, targetId);
  }, [moveDisabled, onMove, snapshot, t]);

  useEffect(() => {
    const host = stageRef.current;
    if (!host || !webgl) return;
    let cancelled = false;
    void import("./star-map-scene").then((mod) => {
      if (cancelled || !stageRef.current) return;
      const scene = mod.mountStarMapScene(stageRef.current, {
        layout,
        displayNames: displayNames ?? {},
        avatarUrls: avatarUrls ?? {},
        runningIds: runningIds ?? new Set(),
        selectedId: selected,
        matches: matchSet,
        queryActive: query.trim().length > 0,
        onSelect: flyTo,
        onMove: proposeMove,
      });
      sceneRef.current = scene;
    }).catch(() => {
      sceneRef.current = null;
    });
    return () => {
      cancelled = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, [avatarUrls, displayNames, flyTo, layout, matchSet, proposeMove, query, runningIds, selected, webgl]);

  const empty = !snapshot || snapshot.tree.length === 0;
  const showHits = query.trim().length > 0;

  return (
    <section className="owb-star-map" data-org-star-map aria-label={t("tree.starMapAria")}>
      <div className="owb-star-map__stage" ref={stageRef}>
        {empty ? <p className="owb-star-map__empty">{t("tree.chartEmpty")}</p> : null}
        {!empty && !webgl ? (
          <FallbackList
            bodies={layout.bodies}
            displayNames={displayNames}
            selectedId={selected}
            matchSet={matchSet}
            queryActive={showHits}
            onSelect={flyTo}
            onMove={proposeMove}
            moveDisabled={moveDisabled}
          />
        ) : null}
        {selectedBody ? (
          <aside className="owb-star-map__card" data-org-star-card>
            <p className="owb-star-map__kind">{t(`tree.starMapKind.${selectedBody.kind}`)}</p>
            <h2>{displayNames?.[selectedBody.id] ?? selectedBody.id}</h2>
            <p>{selectedBody.id}</p>
            {selectedBody.parentId ? <p>{t("tree.starMapReportsTo", { name: displayNames?.[selectedBody.parentId] ?? selectedBody.parentId })}</p> : null}
            <div className="owb-star-map__card-actions">
              <button type="button" onClick={() => onHireEntry?.(selectedBody.id)}>{t("tree.starMapHire")}</button>
              {selectedBody.id !== snapshot?.owner ? (
                <button type="button" onClick={() => onDismiss?.(selectedBody.id)}>{t("tree.starMapDismiss")}</button>
              ) : null}
            </div>
          </aside>
        ) : null}
        {notice ? <div className="owb-star-map__notice" role="status">{notice}</div> : null}
      </div>
      {showHits ? (
        <ul className="owb-star-map__search-hits" role="listbox" aria-label={t("tree.starMapSearch")}>
          {matches.map((id) => (
            <li key={id}>
              <button type="button" onClick={() => flyTo(id)}>
                {displayNames?.[id] ?? id}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="owb-star-map__dock">
        <input
          className="owb-star-map__search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("tree.starMapSearch")}
          aria-label={t("tree.starMapSearch")}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches[0]) {
              event.preventDefault();
              flyTo(matches[0]);
            }
          }}
        />
        <div className="owb-star-map__tools">
          <button type="button" onClick={() => onHireEntry?.(selected ?? null)}>{t("tree.starMapHire")}</button>
          <button type="button" disabled={!selected || selected === snapshot?.owner} onClick={() => selected && onDismiss?.(selected)}>{t("tree.starMapDismiss")}</button>
          <button type="button" onClick={() => onUndo?.()}>{t("tree.undo")}</button>
          <button type="button" onClick={() => sceneRef.current?.zoom(1)}>{t("tree.zoomIn")}</button>
          <button type="button" onClick={() => { sceneRef.current?.zoom(-1); sceneRef.current?.reset(); }}>{t("tree.starMapFlyOut")}</button>
          <button type="button" onClick={() => sceneRef.current?.reset()}>{t("tree.starMapReset")}</button>
        </div>
      </div>
    </section>
  );
}

function FallbackList({
  bodies,
  displayNames,
  selectedId,
  matchSet,
  queryActive,
  onSelect,
  onMove,
  moveDisabled,
}: {
  bodies: StarMapBody[];
  displayNames?: Record<string, string>;
  selectedId: string | null;
  matchSet: Set<string>;
  queryActive: boolean;
  onSelect: (id: string) => void;
  onMove: (sourceId: string, targetId: string) => void;
  moveDisabled: boolean;
}) {
  const t = useT();
  const drag = useRef<{ id: string; x: number; y: number } | null>(null);
  return (
    <div className="owb-star-map__fallback" data-org-star-fallback>
      {bodies.map((body) => (
        <button
          key={body.id}
          type="button"
          draggable={!moveDisabled}
          data-org-star-node={body.id}
          className={`owb-star-map__fallback-item${selectedId === body.id ? " is-selected" : ""}${queryActive && !matchSet.has(body.id) ? " is-dim" : ""}`}
          onClick={() => onSelect(body.id)}
          onDragStart={(event) => {
            drag.current = { id: body.id, x: event.clientX, y: event.clientY };
            event.dataTransfer.setData("text/plain", body.id);
          }}
          onDragOver={(event) => {
            event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const source = drag.current?.id || event.dataTransfer.getData("text/plain");
            const moved = drag.current ? Math.hypot(event.clientX - drag.current.x, event.clientY - drag.current.y) : DRAG_THRESHOLD + 1;
            drag.current = null;
            if (!source || source === body.id || moved < DRAG_THRESHOLD) return;
            onMove(source, body.id);
          }}
        >
          <span className="owb-star-map__kind">{t(`tree.starMapKind.${body.kind}`)}</span>
          <strong>{displayNames?.[body.id] ?? body.id}</strong>
          <span>{body.id}</span>
        </button>
      ))}
    </div>
  );
}

export type { StarMapLayout };
