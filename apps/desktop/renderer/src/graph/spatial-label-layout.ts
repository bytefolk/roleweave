export interface ScreenLabelCandidate {
  id: string;
  /** Projected CSS-pixel anchor, not world coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
  /** The selected label may occupy the least obstructed slot if space runs out. */
  required?: boolean;
}

export interface ScreenRectangle { left: number; top: number; right: number; bottom: number }
export interface ScreenLabelPlacement extends ScreenRectangle { offsetX: number; offsetY: number }

/** DOM label hover retains its last layout tier instead of moving under the cursor. */
export function spatialLabelPriority(input: { selected: boolean; meshHovered: boolean; focused: boolean; neighbor: boolean; primary: boolean; labelHoverPriority?: number }) {
  return input.selected ? 1000 : input.labelHoverPriority ?? (input.meshHovered ? 900 : input.focused ? 850 : input.neighbor ? 700 : input.primary ? 400 : 0);
}

export function validSpatialFocus(candidates: readonly (string | undefined)[], nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>): string | undefined {
  return candidates.find((id): id is string => id !== undefined && (nodeIds.has(id) || edgeIds.has(id)));
}

export function isSpatialLabelClick(detail: number, start: { x: number; y: number } | null, end: { x: number; y: number }) {
  return detail === 0 || start === null || Math.hypot(end.x - start.x, end.y - start.y) <= 4;
}

function overlap(a: ScreenRectangle, b: ScreenRectangle, gap: number) {
  return a.left < b.right + gap && a.right + gap > b.left && a.top < b.bottom + gap && a.bottom + gap > b.top;
}
function overlapArea(a: ScreenRectangle, b: ScreenRectangle) {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

/** Deterministic, bounded label decluttering. Omitted labels remain real graph
 * objects; this helper never changes their identities, positions or edges. */
export function layoutScreenLabels(
  candidates: readonly ScreenLabelCandidate[],
  viewport: { width: number; height: number; padding?: number },
  reserved: readonly ScreenRectangle[] = [],
): Map<string, ScreenLabelPlacement> {
  const placed = new Map<string, ScreenLabelPlacement>();
  const padding = viewport.padding ?? 8;
  const availableWidth = viewport.width - 2 * padding;
  const availableHeight = viewport.height - 2 * padding;
  if (!Number.isFinite(availableWidth) || !Number.isFinite(availableHeight) || availableWidth <= 0 || availableHeight <= 0) return placed;
  const ordered = candidates.filter((label) => label.priority > 0 && [label.x, label.y, label.width, label.height, label.priority].every(Number.isFinite) && label.width > 0 && label.height > 0)
    .slice().sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const gap = 6;
  for (const label of ordered) {
    if (placed.has(label.id)) continue;
    const width = Math.min(label.width, availableWidth);
    const height = Math.min(label.height, availableHeight);
    const dy = height + gap;
    const dx = width + gap;
    const slots = [[0, 0], [0, -dy], [0, dy], [-dx, 0], [dx, 0], [0, -2 * dy], [0, 2 * dy], [-dx, -dy], [dx, -dy], [-dx, dy], [dx, dy]];
    const rectangles = slots.map(([x, y]) => {
      const left = Math.max(padding, Math.min(viewport.width - padding - width, label.x + x! - width / 2));
      const top = Math.max(padding, Math.min(viewport.height - padding - height, label.y + y! - height / 2));
      return { left, top, right: left + width, bottom: top + height, offsetX: left + width / 2 - label.x, offsetY: top + height / 2 - label.y };
    });
    const obstacles = [...reserved, ...placed.values()];
    let choice = rectangles.find((rect) => obstacles.every((obstacle) => !overlap(rect, obstacle, gap)));
    if (!choice && label.required) {
      choice = rectangles.map((rect, index) => ({ rect, index, covered: obstacles.reduce((area, obstacle) => area + overlapArea(rect, obstacle), 0) }))
        .sort((a, b) => a.covered - b.covered || a.index - b.index)[0]?.rect;
    }
    if (choice) placed.set(label.id, choice);
  }
  return placed;
}
