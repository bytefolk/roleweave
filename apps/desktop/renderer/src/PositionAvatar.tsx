import { hueForId } from "@roleweave/ui";

/** Shared position avatar (#53 DS-34-001 §1.3, extracted for #61 bubble
 * chat): declared metadata.color wins, then the org tree's deterministic hue
 * — the roster, org tree and chat bubbles stay in sync. */
export function PositionAvatar({
  colors,
  id,
  name,
  className,
}: {
  colors?: Record<string, string>;
  id: string;
  name: string;
  className?: string;
}) {
  return (
    <span
      className={className ?? "owb-avatar"}
      title={name}
      aria-hidden="true"
      style={{ background: colors?.[id] ?? `hsl(${hueForId(id)}, 65%, 42%)` }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
