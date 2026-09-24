export const WINDOW_DAYS = 28;
const DAY = 86_400_000;

export function dayNumber(value: string): number {
  return Date.parse(`${value}T00:00:00Z`) / DAY;
}

/** Inclusive bar inside a window. Inverted dates are ordered; width is never negative. */
export function scheduleBar(
  startDate: string | undefined,
  dueDate: string | undefined,
  windowStart: number,
): { left: number; widthDays: number; inWindow: boolean } {
  const rawA = dayNumber((startDate ?? dueDate)!);
  const rawB = dayNumber((dueDate ?? startDate)!);
  const start = Math.min(rawA, rawB);
  const end = Math.max(rawA, rawB);
  const left = Math.max(0, start - windowStart);
  const right = Math.min(WINDOW_DAYS, end - windowStart + 1);
  const widthDays = Math.max(0, right - left);
  return {
    left,
    widthDays,
    inWindow: widthDays > 0 && end >= windowStart && start < windowStart + WINDOW_DAYS,
  };
}
