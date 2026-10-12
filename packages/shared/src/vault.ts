/** Workspace-owned plain files; the sidecar owns identities and role references. */
export const VAULT_NOTE_SCHEMA_VERSION = "vault-note.v1" as const;
export const VAULT_LIST_SCHEMA_VERSION = "vault-list.v1" as const;
export const VAULT_MAX_NOTE_BYTES = 1024 * 1024;
export const VAULT_MAX_ACTIVE_BYTES = 16 * 1024 * 1024;
export const VAULT_MAX_NOTES = 1000;
export interface VaultSourceRef { positionId?: string; sessionId?: string; turnId?: string }
export interface VaultNoteRef { uri: string; version: string }
export interface VaultNote {
  noteId: string;
  /** Relative to notes/; legacy entries use a read-only virtual positions/ path. */
  path: string;
  title: string;
  size: number;
  version: string;
  modifiedAt: string;
  archived: boolean;
  readOnly: boolean;
  positionIds: string[];
  ref: VaultNoteRef;
  legacy?: { positionId: string; path: string };
  source?: VaultSourceRef;
}
export interface VaultListOptions { q?: string; positionId?: string; archived?: boolean; includeLegacy?: boolean }
export interface VaultListResponse { schemaVersion: typeof VAULT_LIST_SCHEMA_VERSION; notes: VaultNote[] }
export interface VaultNoteResponse { schemaVersion: typeof VAULT_NOTE_SCHEMA_VERSION; note: VaultNote; content: string }
export interface VaultCreateRequest { path: string; content: string; positionIds?: string[]; source?: VaultSourceRef }
export interface VaultWriteRequest { noteId: string; content: string; expectedVersion: string }
export interface VaultRenameRequest { noteId: string; path: string; expectedVersion?: string }
export interface VaultPathRequest { noteId: string; expectedVersion?: string }
export interface VaultMigrateRequest { noteId: string; path: string; expectedVersion: string }
export interface VaultDeleteResponse { noteId: string; deleted: true }
export interface VaultBinding { positionId: string; noteIds: string[] }
export interface VaultBindingsResponse { schemaVersion: "vault-bindings.v1"; bindings: VaultBinding[] }
export interface VaultBindRequest { positionId: string; noteIds: string[] }
export interface VaultSourceResponse {
  schemaVersion: "vault-source.v1";
  vaultId: string;
  title: string;
  root: "notes";
  noteCount: number;
  legacyCount: number;
  bindingCount: number;
}
export interface VaultResolveRequest { uri: string }
export interface VaultImageResponse { preview: { path: string; mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; dataUrl: string } }
export interface VaultHistoryVersion { version: string; path: string; createdAt: string; content: string }
export interface VaultHistoryResponse { schemaVersion: "vault-history.v1"; noteId: string; versions: VaultHistoryVersion[] }
export interface VaultUsageNote { noteId: string; path: string; ref: string; version: string; excerpt: string }
export interface VaultUsageResponse { notes: VaultUsageNote[] }
export interface VaultSnapshotEntry { noteId: string; path: string; content: string; revision: number; deleted: boolean; properties?: Record<string, unknown> }
export interface LocalVaultSnapshot {
  schemaVersion: "vault-snapshot.v1";
  vaultId: string;
  title: string;
  revision: number;
  updatedAt: string | null;
  entries: VaultSnapshotEntry[];
  /** Local CAS; never forward as a mem authorization or remote revision. */
  expectedHash: string;
}
