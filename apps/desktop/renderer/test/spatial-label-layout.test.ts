import { describe, expect, it } from "vitest";
import { isSpatialLabelClick, layoutScreenLabels, spatialLabelPriority, validSpatialFocus, type ScreenLabelCandidate, type ScreenRectangle } from "../src/graph/spatial-label-layout";

function candidate(id: string, overrides: Partial<ScreenLabelCandidate> = {}): ScreenLabelCandidate {
  return { id, x: 240, y: 160, width: 110, height: 24, priority: 100, ...overrides };
}
function overlaps(a: ScreenRectangle, b: ScreenRectangle) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

describe("projected spatial label layout", () => {
  it("preserves the selected label and places collocated neighbors without overlap", () => {
    const result = layoutScreenLabels([candidate("neighbor"), candidate("selected", { priority: 1000, required: true })], { width: 480, height: 320 });
    expect(result.get("selected")).toEqual({ left: 185, top: 148, right: 295, bottom: 172, offsetX: 0, offsetY: 0 });
    expect(result.has("neighbor")).toBe(true);
    expect(overlaps(result.get("selected")!, result.get("neighbor")!)).toBe(false);
  });

  it("uses the same placements after input order changes, without mutating candidates", () => {
    const labels = [candidate("b"), candidate("a"), candidate("c", { x: 260 })];
    const before = structuredClone(labels);
    const first = layoutScreenLabels(labels, { width: 480, height: 320 });
    const second = layoutScreenLabels([...labels].reverse(), { width: 480, height: 320 });
    expect([...second]).toEqual([...first]);
    expect(labels).toEqual(before);
  });

  it("declutters 47 collocated labels within a narrow viewport instead of stacking them", () => {
    const labels = Array.from({ length: 47 }, (_, index) => candidate(`node-${String(index).padStart(2, "0")}`, { x: 150, y: 110, priority: 100 - index }));
    const result = layoutScreenLabels(labels, { width: 300, height: 220 });
    expect(result.size).toBeGreaterThan(0);
    expect(result.size).toBeLessThan(labels.length);
    const rectangles = [...result.values()];
    for (let index = 0; index < rectangles.length; index += 1) {
      const rect = rectangles[index]!;
      expect(rect.left).toBeGreaterThanOrEqual(8);
      expect(rect.top).toBeGreaterThanOrEqual(8);
      expect(rect.right).toBeLessThanOrEqual(292);
      expect(rect.bottom).toBeLessThanOrEqual(212);
      for (const other of rectangles.slice(index + 1)) expect(overlaps(rect, other)).toBe(false);
    }
  });

  it("avoids controls and bottom navigation reserved rectangles", () => {
    const reserved = [{ left: 0, top: 0, right: 480, bottom: 65 }, { left: 0, top: 260, right: 480, bottom: 320 }];
    const result = layoutScreenLabels([candidate("top", { y: 35 }), candidate("bottom", { y: 288 })], { width: 480, height: 320 }, reserved);
    expect(result.size).toBe(2);
    for (const rect of result.values()) for (const obstacle of reserved) expect(overlaps(rect, obstacle)).toBe(false);
  });

  it("keeps a selected label bounded even if the viewport has no free slot", () => {
    const result = layoutScreenLabels([candidate("selected", { x: 0, y: 0, width: 300, priority: 1000, required: true })], { width: 100, height: 50 }, [{ left: 0, top: 0, right: 100, bottom: 50 }]);
    const rect = result.get("selected")!;
    expect(rect).toBeDefined();
    expect(rect.left).toBe(8);
    expect(rect.right).toBe(92);
    expect(rect.top).toBeGreaterThanOrEqual(8);
    expect(rect.bottom).toBeLessThanOrEqual(42);
  });

  it("ignores invalid projections and zero-priority labels and handles an empty viewport", () => {
    const labels = [candidate("off", { priority: 0 }), candidate("invalid", { x: NaN }), candidate("zero", { width: 0 })];
    expect(layoutScreenLabels(labels, { width: 480, height: 320 }).size).toBe(0);
    expect(layoutScreenLabels([candidate("node")], { width: 0, height: 0 }).size).toBe(0);
  });

  it("keeps a collision-offset label in place when the pointer enters the label itself", () => {
    const flags = { selected: false, meshHovered: false, focused: false, neighbor: false, primary: true };
    const before = layoutScreenLabels([candidate("a", { priority: 400 }), candidate("b", { priority: 400 })], { width: 480, height: 320 });
    const labelHover = spatialLabelPriority({ ...flags, labelHoverPriority: 400 });
    const after = layoutScreenLabels([candidate("a", { priority: 400 }), candidate("b", { priority: labelHover })], { width: 480, height: 320 });
    expect(before.get("b")?.offsetY).not.toBe(0);
    expect(after.get("b")).toEqual(before.get("b"));
    expect(after.get("a")).toEqual(before.get("a"));
  });

  it("retains the mesh-hover tier on canvas-to-label transfer while leaving selected labels first", () => {
    const flags = { selected: false, meshHovered: true, focused: false, neighbor: false, primary: false };
    const meshPriority = spatialLabelPriority(flags);
    expect(spatialLabelPriority({ ...flags, meshHovered: false, labelHoverPriority: meshPriority })).toBe(900);
    expect(spatialLabelPriority({ ...flags, selected: true, labelHoverPriority: 900 })).toBe(1000);
    expect(spatialLabelPriority({ ...flags, meshHovered: false })).toBe(0);
  });

  it("never dims the graph for a focus that has been filtered out", () => {
    const nodes = new Set(["current-node"]), edges = new Set(["current-edge"]);
    expect(validSpatialFocus(["removed-node", "removed-hover", "removed-footer"], nodes, edges)).toBeUndefined();
    expect(validSpatialFocus(["removed-node", "current-node"], nodes, edges)).toBe("current-node");
    expect(validSpatialFocus(["current-edge", "current-node"], nodes, edges)).toBe("current-edge");
  });

  it("rejects dragged label clicks while preserving keyboard activation", () => {
    expect(isSpatialLabelClick(1, { x: 10, y: 10 }, { x: 14, y: 10 })).toBe(true);
    expect(isSpatialLabelClick(1, { x: 10, y: 10 }, { x: 15, y: 10 })).toBe(false);
    expect(isSpatialLabelClick(0, { x: 10, y: 10 }, { x: 80, y: 70 })).toBe(true);
  });
});
