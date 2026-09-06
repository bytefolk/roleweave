/**
 * In-app update surface types (#134), shared by the preload bridge declaration
 * and the settings pane that renders them.
 *
 * These describe what `apps/desktop/src/update-ipc.cjs` projects out of the
 * updater service — a closed set of primitives. The service's own English
 * sentences arrive as `reason` and stay diagnostic: user-facing copy is
 * localized in the renderer from `state`, `signed` and `platform`, so a
 * Chinese UI never shows an untranslated paragraph as its main message.
 */

/** The eight states the updater service reports, frozen in its `UPDATE_STATES`. */
export type UpdateState =
  | "idle"
  | "unavailable"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export const UPDATE_STATES: readonly UpdateState[] = [
  "idle",
  "unavailable",
  "checking",
  "current",
  "available",
  "downloading",
  "downloaded",
  "error",
];

export function isUpdateState(value: unknown): value is UpdateState {
  return typeof value === "string" && (UPDATE_STATES as readonly string[]).includes(value);
}

/** One live state event pushed from the main process. */
export interface UpdateEvent {
  state: UpdateState;
  reason: string | null;
  version: string | null;
  percent: number | null;
}

/**
 * A `check` / `download` / `install` reply.
 *
 * `unsigned` is the one response that is not a state: the service returns the
 * current state unchanged and refuses the apply path, because an unsigned build
 * cannot verify what it would install.
 */
export interface UpdateResult extends UpdateEvent {
  unsigned: boolean;
  installing: boolean;
}

/** Platforms the renderer may distinguish when localizing an unavailability. */
export type UpdatePlatform = "win32" | "darwin" | "linux" | "other";

export interface UpdateStatus {
  /** The running app version, or null if the shell would not say. */
  version: string | null;
  state: UpdateState;
  /** Whether this platform has an update channel at all. */
  available: boolean;
  requiresConfirmation: boolean;
  /** Whether this build carries a native platform publisher identity (Apple/Authenticode). */
  signed: boolean;
  /** Whether the selected update channel has an independent trust check. */
  updateVerified: boolean;
  reason: string | null;
  platform: UpdatePlatform;
}
