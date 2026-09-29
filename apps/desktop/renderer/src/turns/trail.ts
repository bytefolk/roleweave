import type { TurnTraceActivity } from "./types";

/**
 * Primitives shared by the two producers of the activity trail: the live SSE
 * projection (`turnStream.ts`) and the historical adapter (`adapter.ts`). A run
 * that is watched live and the same run after a history reload must not
 * disagree about what it did, so both fold the same events through these
 * helpers rather than each keeping its own copy of the rules.
 */

/**
 * One bound for the whole trail — thought narration, tool calls and agent
 * steps alike. It matches the bound the live activity buffer already used, so
 * sharing it changes nothing for a live run. The previous thought-only cap was
 * not a bound on the trail at all: an unbounded number of tool/agent rows could
 * still be carried beside it.
 */
export const TRAIL_MAX_ITEMS = 128;

/**
 * Narration is excerpted, not reproduced. It exists as context for the
 * execution steps, never as a second copy of the reply body that already
 * renders below the trail.
 */
export const TRAIL_THOUGHT_MAX_CHARS = 200;

/**
 * Collapse to a single line and truncate. Truncation is prefix-only, so
 * re-snippetting a growing segment yields the same text as snippetting the
 * whole thing once — which is what lets the live path re-snippet on every
 * delta and still land on the historical adapter's result.
 */
export function thoughtSnippet(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length > TRAIL_THOUGHT_MAX_CHARS ? `${text.slice(0, TRAIL_THOUGHT_MAX_CHARS)}…` : text;
}

/**
 * A thought row, or null when the segment carries nothing to show. Callers
 * allocate the id, so a live segment keeps its id as it grows.
 */
export function thoughtItem(
  activityId: string,
  raw: string,
  status: TurnTraceActivity["status"],
): TurnTraceActivity | null {
  const text = thoughtSnippet(raw);
  return text === "" ? null : { activityId, kind: "thought", status, text };
}

/**
 * Insert or update a trail item. An existing id keeps its first-seen position
 * and takes the latest state — a step that finishes does not jump to the end
 * of the trail — and the head is dropped once the cap is reached.
 */
export function putTrailItem(
  trail: TurnTraceActivity[],
  item: TurnTraceActivity,
): TurnTraceActivity[] {
  const index = trail.findIndex((entry) => entry.activityId === item.activityId);
  const next = index === -1
    ? trail.concat(item)
    : trail.map((entry, at) => (at === index ? item : entry));
  return next.length > TRAIL_MAX_ITEMS ? next.slice(next.length - TRAIL_MAX_ITEMS) : next;
}

/**
 * The narration segment a run has produced since its last activity: the row
 * that reads as "thinking" while the run is still live. Only the tail can be
 * open, because an arriving activity always closes it.
 */
export function openThought(trail: TurnTraceActivity[]): TurnTraceActivity | undefined {
  const last = trail.at(-1);
  return last !== undefined && last.kind === "thought" && last.status === "running" ? last : undefined;
}

/**
 * Fold a streaming narration delta into the run's open thought row, opening a
 * new one when the previous segment was already closed by an activity.
 */
export function foldNarration(
  trail: TurnTraceActivity[],
  delta: string,
  thoughtSeq: number,
): { trail: TurnTraceActivity[]; thoughtSeq: number } {
  if (delta === "") return { trail, thoughtSeq };
  const open = openThought(trail);
  if (open !== undefined) {
    const text = thoughtSnippet(`${open.text ?? ""}${delta}`);
    if (text === "") return { trail, thoughtSeq };
    return { trail: trail.slice(0, -1).concat({ ...open, text }), thoughtSeq };
  }
  const item = thoughtItem(`thought-${thoughtSeq + 1}`, delta, "running");
  return item === null ? { trail, thoughtSeq } : { trail: putTrailItem(trail, item), thoughtSeq: thoughtSeq + 1 };
}

/**
 * Close the open narration row when a step lands: that narration finished
 * thinking before this step started, and the step belongs after it.
 */
export function closeNarration(trail: TurnTraceActivity[]): TurnTraceActivity[] {
  const open = openThought(trail);
  return open === undefined ? trail : trail.slice(0, -1).concat({ ...open, status: "completed" });
}

/**
 * A settled turn's open narration IS its answer, and the answer already
 * renders below the trail — keeping the row would print it twice. Still-running
 * turns keep it, because there "thinking" is the honest reading. The live
 * projection never needs this: a settled run's buffer is discarded and the
 * persisted record takes over.
 */
export function dropOpenNarration(trail: TurnTraceActivity[]): TurnTraceActivity[] {
  return openThought(trail) === undefined ? trail : trail.slice(0, -1);
}
