export interface VaultSyncEntry {
  noteId: string;
  path: string;
  content: string;
  deleted?: boolean;
  revision?: number;
  properties?: Record<string, unknown>;
}
export interface VaultRemoteSnapshot {
  schemaVersion: 'vault-snapshot.v1';
  vaultId: string;
  title?: string;
  revision: number;
  entries: VaultSyncEntry[];
}
export interface VaultSyncTarget { vaultId: string; title: string; revision: number; updatedAt: string }
export interface VaultSyncReceipt {
  status: 'synced' | 'conflict' | 'local_changed' | 'not_configured';
  vaultId: string;
  revision: number;
  pushed: number;
  pulled: number;
  conflicts: Array<{path: string; copyPath: string}>;
}
