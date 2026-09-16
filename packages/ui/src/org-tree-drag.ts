import { useCallback, useSyncExternalStore } from "react";
import type { OrgTreeNodeV1 } from "./types";

export type DropZone = "before" | "after" | "body";
type RowState = DropZone | "denied" | undefined;
type RowId = string | null;

/** One drag session, with subscriptions scoped to individual rows. Pointer
 * samples never update OrgTree's state or walk its recursive render path. */
export function createOrgTreeDragState() {
  const listeners = new Map<RowId, Set<() => void>>();
  let invalid = new Set<string>();
  let hint: { anchorId: RowId; zone: DropZone } | undefined;
  let draggedId: string | null = null;
  const notify = (id: RowId) => listeners.get(id)?.forEach((listener) => listener());
  const setHint = (anchorId?: RowId, zone?: DropZone) => {
    if (hint?.anchorId === anchorId && hint?.zone === zone) return;
    const previous = hint?.anchorId;
    hint = anchorId !== undefined && zone ? { anchorId, zone } : undefined;
    if (previous !== undefined) notify(previous);
    if (anchorId !== undefined && anchorId !== previous) notify(anchorId);
  };
  return {
    get draggedId() { return draggedId; },
    denied: false,
    isInvalid: (id: string) => invalid.has(id),
    getRowState: (id: RowId): RowState =>
      id !== null && invalid.has(id) ? "denied" : hint?.anchorId === id ? hint.zone : undefined,
    subscribe(id: RowId, listener: () => void) {
      let rowListeners = listeners.get(id);
      if (!rowListeners) listeners.set(id, rowListeners = new Set());
      rowListeners.add(listener);
      return () => {
        rowListeners.delete(listener);
        if (rowListeners.size === 0) listeners.delete(id);
      };
    },
    setHint,
    start(node: OrgTreeNodeV1) {
      this.reset();
      draggedId = node.id;
      const collect = (entry: OrgTreeNodeV1) => {
        invalid.add(entry.id);
        entry.children.forEach(collect);
      };
      collect(node);
      invalid.forEach(notify);
    },
    reset() {
      draggedId = null;
      this.denied = false;
      const previous = invalid;
      invalid = new Set();
      setHint();
      previous.forEach(notify);
    },
  };
}

export type OrgTreeDragState = ReturnType<typeof createOrgTreeDragState>;
const noSubscription = () => () => {};

export function useOrgTreeDragState(state: OrgTreeDragState | undefined, id: RowId): RowState {
  const subscribe = useCallback((listener: () => void) => state ? state.subscribe(id, listener) : noSubscription(), [state, id]);
  const getSnapshot = useCallback(() => state?.getRowState(id), [state, id]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
