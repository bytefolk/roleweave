import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const DEFAULT_RATIO = 0.5;
const MIN_PANE_WIDTH = 280;
const KEYBOARD_STEP = 24;
const KEYBOARD_PAGE_STEP = 96;

interface PaneBounds {
  min: number;
  max: number;
  width: number;
}

export interface OrgWorkspaceSplitProps {
  ariaLabel: string;
  left: ReactNode;
  resetTitle: string;
  right: ReactNode;
  valueText: (value: number) => string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeBounds(host: HTMLDivElement | null): PaneBounds {
  const measured = host?.getBoundingClientRect().width ?? 0;
  const width = measured > 0 ? measured : 1000;
  const min = Math.min(MIN_PANE_WIDTH / width, 0.4);
  return { min, max: 1 - min, width };
}

/**
 * First-use organization-workspace splitter. It deliberately stays in the
 * renderer until another module needs the same interaction contract.
 *
 * The pane ratio is ephemeral UI geometry, not a workspace preference: a
 * resized window always gets a sensible balanced starting point and no
 * machine-specific width leaks into project data.
 */
export function OrgWorkspaceSplit({ ariaLabel, left, resetTitle, right, valueText }: OrgWorkspaceSplitProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(DEFAULT_RATIO);
  const [dragging, setDragging] = useState(false);
  const [paneBounds, setPaneBounds] = useState<PaneBounds>(() => computeBounds(hostRef.current));

  const setClampedRatio = useCallback((next: number) => {
    const b = computeBounds(hostRef.current);
    setRatio(clamp(next, b.min, b.max));
  }, []);

  const setFromPointer = useCallback((clientX: number) => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    setClampedRatio((clientX - rect.left) / rect.width);
  }, [setClampedRatio]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setPaneBounds(computeBounds(host)));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const reset = useCallback(() => setRatio(DEFAULT_RATIO), []);
  const { min, max } = paneBounds;
  const value = Math.round(ratio * 100);

  return (
    <div
      ref={hostRef}
      className="owb-org-module"
      data-dragging={dragging ? "true" : undefined}
      style={ratio === DEFAULT_RATIO ? undefined : ({ "--owb-org-left-width": `${ratio * 100}%` } as CSSProperties)}
    >
      <div className="owb-org-module__pane owb-org-module__pane--left">{left}</div>
      <div
        className="owb-org-module__splitter"
        role="separator"
        aria-label={ariaLabel}
        aria-orientation="vertical"
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        aria-valuenow={value}
        aria-valuetext={valueText(value)}
        aria-keyshortcuts="ArrowLeft ArrowRight Home End 0"
        tabIndex={0}
        title={resetTitle}
        onDoubleClick={reset}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDragging(true);
          setFromPointer(event.clientX);
        }}
        onPointerMove={(event) => {
          if (dragging) setFromPointer(event.clientX);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          setDragging(false);
        }}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={(event) => {
          const current = ratio;
          const { width } = paneBounds;
          const step = (event.shiftKey ? KEYBOARD_PAGE_STEP : KEYBOARD_STEP) / width;

          if (event.key === "ArrowLeft") {
            event.preventDefault();
            setClampedRatio(current - step);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            setClampedRatio(current + step);
          } else if (event.key === "Home") {
            event.preventDefault();
            setClampedRatio(min);
          } else if (event.key === "End") {
            event.preventDefault();
            setClampedRatio(max);
          } else if (event.key === "0") {
            event.preventDefault();
            reset();
          }
        }}
      />
      <div className="owb-org-module__pane owb-org-module__pane--right">{right}</div>
    </div>
  );
}
