/**
 * Pure state → copy mapping for the update pane (#134).
 *
 * Every function returns a catalog key plus variables, never resolved text.
 * #179 showed why: a message stored as an already-resolved string survives a
 * locale switch and leaves the previous language sitting on screen. Resolving at
 * render time means the pane follows the active locale even for a status it read
 * minutes ago.
 *
 * Keeping this separate from the component also lets the affordance rules be
 * asserted directly, rather than inferred from which buttons happen to render.
 */
import type { UpdateEvent, UpdatePlatform, UpdateState, UpdateStatus } from "@roleweave/shared";

export interface UpdateMessage {
  key: string;
  vars?: Record<string, string | number>;
}

/** The status line for one state. Version and percent are used only where the
 * service actually supplies them, so the pane never renders "version null". */
export function stateMessage(event: Pick<UpdateEvent, "state" | "version" | "percent">): UpdateMessage {
  switch (event.state) {
    case "checking":
      return { key: "settings.stateChecking" };
    case "current":
      return { key: "settings.stateCurrent" };
    case "available":
      return event.version === null
        ? { key: "settings.stateAvailableNoVersion" }
        : { key: "settings.stateAvailable", vars: { version: event.version } };
    case "downloading":
      return event.percent === null
        ? { key: "settings.stateDownloading" }
        : { key: "settings.stateDownloadingPct", vars: { percent: event.percent } };
    case "downloaded":
      return event.version === null
        ? { key: "settings.stateDownloadedNoVersion" }
        : { key: "settings.stateDownloaded", vars: { version: event.version } };
    case "error":
      return { key: "settings.stateError" };
    case "unavailable":
      return { key: "settings.stateUnavailable" };
    case "idle":
    default:
      return { key: "settings.stateIdle" };
  }
}

/**
 * Why in-app update is off on this platform. The main process also sends its own
 * sentence; this is the localized one, and the service's text is kept as
 * diagnostic detail rather than as the message a user reads first.
 */
export function unavailableMessage(platform: UpdatePlatform): UpdateMessage {
  switch (platform) {
    case "darwin":
      return { key: "settings.unavailableDarwin" };
    case "linux":
      return { key: "settings.unavailableLinux" };
    default:
      return { key: "settings.unavailableOther" };
  }
}

export interface UpdateAffordances {
  /** Checking stays open on an unsigned build: knowing a version exists is useful. */
  canCheck: boolean;
  canDownload: boolean;
  canInstall: boolean;
  /** The platform has a channel but this build has no independent update trust root. */
  showUnsignedRefusal: boolean;
  /** The platform has no channel at all. */
  showPlatformNotice: boolean;
}

/**
 * What the pane may offer, derived from the shell's status and the live state.
 *
 * The apply paths are closed twice over — here, and in the service, which
 * refuses them regardless of what a UI renders. This function exists so the
 * pane does not show a button whose only outcome is a refusal.
 */
export function updateAffordances(
  status: UpdateStatus | null,
  state: UpdateState,
): UpdateAffordances {
  if (status === null) {
    return {
      canCheck: false,
      canDownload: false,
      canInstall: false,
      showUnsignedRefusal: false,
      showPlatformNotice: false,
    };
  }
  const busy = state === "checking" || state === "downloading";
  return {
    canCheck: status.available && !busy,
    canDownload: status.available && status.updateVerified && state === "available",
    canInstall: status.available && status.updateVerified && state === "downloaded",
    showUnsignedRefusal: status.available && !status.updateVerified,
    showPlatformNotice: !status.available,
  };
}
