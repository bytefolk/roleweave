/**
 * Drive provider selection contract (drive-provider.v1).
 *
 * The drive plane proxies a bounded read/list surface to a pluggable upstream.
 * The upstream is selected per server instance and the renderer never depends
 * on provider field naming — the server normalizes every provider's records
 * into the frozen `drive-object.v1` shape exactly once (routes/drive.ts).
 *
 * Providers:
 * - `mem`   — bytefolk/mem `memd` HTTP API (`MEM_URL`, default; unchanged).
 * - `bdpan` — Baidu NetDisk through the user-installed third-party `bdpan`
 *   CLI. RoleWeave never bundles the CLI, never touches its credentials
 *   (`~/.config/bdpan`), and treats every failure as an explicit provider
 *   state instead of an empty list.
 */

export const DRIVE_PROVIDER_SCHEMA_VERSION = "drive-provider.v1" as const;

export const driveProviderKinds = ["mem", "bdpan"] as const;
export type DriveProviderKind = (typeof driveProviderKinds)[number];

/**
 * Explicit provider health. `auth_expired` maps to the `drive_auth_expired`
 * error code on proxied reads; `not_installed` means the provider binary is
 * absent on this machine (bdpan ships only for macOS/Linux/WSL).
 */
export const driveProviderStates = [
  "ready",
  "auth_expired",
  "not_installed",
  "not_connected",
  "unsupported_action",
  "error",
] as const;
export type DriveProviderState = (typeof driveProviderStates)[number];

export interface DriveProviderStatus {
  schemaVersion: typeof DRIVE_PROVIDER_SCHEMA_VERSION;
  kind: DriveProviderKind;
  state: DriveProviderState;
  /** Stable reason code for the presentation layer; never credentials or raw paths. */
  reason?: string;
}

export interface DriveProviderStatusResponse {
  schemaVersion: typeof DRIVE_PROVIDER_SCHEMA_VERSION;
  status: DriveProviderStatus;
}

/**
 * Pure parse of a provider selection value. `undefined`/empty selects the
 * historical default (`mem`); any other value must be a listed kind or the
 * caller rejects the request with `drive_provider_invalid`.
 */
export function parseDriveProviderKind(value: unknown): DriveProviderKind | null {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) return "mem";
  if (typeof value === "string" && (driveProviderKinds as readonly string[]).includes(value)) {
    return value as DriveProviderKind;
  }
  return null;
}
