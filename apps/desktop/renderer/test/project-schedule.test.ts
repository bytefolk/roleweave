import { describe, expect, it } from "vitest";
import { WINDOW_DAYS, dayNumber, scheduleBar } from "../src/goals/project-schedule";

describe("scheduleBar", () => {
  const windowStart = dayNumber("2026-09-01");

  it("clamps inverted dates so width is never negative", () => {
    const bar = scheduleBar("2026-09-20", "2026-09-10", windowStart);
    expect(bar.widthDays).toBeGreaterThan(0);
    expect(bar.left + bar.widthDays).toBeLessThanOrEqual(WINDOW_DAYS);
    expect(bar.inWindow).toBe(true);
  });

  it("does not render a backward bar that starts after it ends", () => {
    const inverted = scheduleBar("2026-09-25", "2026-09-05", windowStart);
    const ordered = scheduleBar("2026-09-05", "2026-09-25", windowStart);
    expect(inverted).toEqual(ordered);
    expect(inverted.widthDays).toBeGreaterThanOrEqual(0);
  });

  it("keeps bars that only graze the window inside clamped bounds", () => {
    const bar = scheduleBar("2026-08-20", "2026-09-02", windowStart);
    expect(bar.left).toBe(0);
    expect(bar.widthDays).toBeGreaterThan(0);
    expect(bar.widthDays).toBeLessThanOrEqual(WINDOW_DAYS);
  });
});
