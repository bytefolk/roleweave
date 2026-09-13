import { hueForId } from "@roleweave/ui";
import communityOperator from "./assets/avatars/community-operator-v2.png";
import researcher from "./assets/avatars/researcher-v2.png";
import releaseEngineer from "./assets/avatars/release-engineer-v2.png";
import operationsLead from "./assets/avatars/operations-lead-v2.png";

export const AVATAR_PRESETS = [
  { id: "community-operator", labelKey: "avatar.presetCommunity", src: communityOperator },
  { id: "researcher", labelKey: "avatar.presetResearcher", src: researcher },
  { id: "release-engineer", labelKey: "avatar.presetReleaseEngineer", src: releaseEngineer },
  { id: "operations-lead", labelKey: "avatar.presetOperationsLead", src: operationsLead },
] as const;

export type AvatarValue = string | undefined;

/** A stable default gives every new employee a transparent portrait before
 * any manual choice. The explicit selection remains a local preference. */
export function avatarSrcFor(id: string, value?: AvatarValue): string {
  if (value?.startsWith("data:image/")) return value;
  const selected = AVATAR_PRESETS.find((preset) => preset.id === value);
  if (selected) return selected.src;
  return AVATAR_PRESETS[hueForId(id) % AVATAR_PRESETS.length]!.src;
}

/** Shared position avatar (#53 DS-34-001 §1.3, extracted for #61 bubble
 * chat): declared metadata.color wins, then the org tree's deterministic hue
 * — the roster, org tree and chat bubbles stay in sync. */
export function PositionAvatar({
  colors,
  avatars,
  sources,
  id,
  name,
  className,
}: {
  colors?: Record<string, string>;
  avatars?: Record<string, AvatarValue>;
  sources?: Record<string, string>;
  id: string;
  name: string;
  className?: string;
}) {
  return (
    <span
      className={className ?? "owb-avatar"}
      title={name}
      aria-hidden="true"
    >
      <img src={sources?.[id] ?? avatarSrcFor(id, avatars?.[id])} alt="" />
    </span>
  );
}
