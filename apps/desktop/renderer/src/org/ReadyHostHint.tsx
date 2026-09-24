import { useT } from "@roleweave/ui";
import type { ReadyHostOverlayPresentation } from "./ready-host-overlay";

export function ReadyHostHint({
  overlay,
  names,
  onSelectPosition,
}: {
  overlay: ReadyHostOverlayPresentation;
  names: Record<string, string>;
  onSelectPosition?: (positionId: string) => void;
}) {
  const t = useT();
  if (!overlay.visible || overlay.candidates.length === 0) return null;
  return (
    <aside className="owb-ready-host-overlay" role="status" aria-label={t("org.readyHostTitle")}>
      <p>{t("org.readyHostBody")}</p>
      <div className="owb-ready-host-overlay-actions">
        {overlay.candidates.map((candidate) => (
          <button
            type="button"
            key={candidate.positionId}
            onClick={() => onSelectPosition?.(candidate.positionId)}
          >
            {t("org.readyHostPick", { name: names[candidate.positionId] ?? candidate.positionId })}
          </button>
        ))}
      </div>
    </aside>
  );
}
