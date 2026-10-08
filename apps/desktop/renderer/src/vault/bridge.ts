import type { VaultListOptions, VaultListResponse, VaultNoteResponse, VaultCreateRequest, VaultWriteRequest, VaultRenameRequest, VaultPathRequest, VaultMigrateRequest, VaultDeleteResponse, VaultBindingsResponse, VaultBindRequest, VaultSourceResponse, VaultResolveRequest, VaultImageResponse, VaultSyncReceipt, VaultSyncTarget } from '@roleweave/shared';
interface Response<T> { status: number; body: T }
/** A fixed notebook bridge; transport credentials remain in main/server. */
export interface VaultBridge {
  list(options?: VaultListOptions): Promise<Response<VaultListResponse>>;
  read(noteId: string): Promise<Response<VaultNoteResponse>>;
  create(request: VaultCreateRequest): Promise<Response<VaultNoteResponse>>;
  write(request: VaultWriteRequest): Promise<Response<VaultNoteResponse>>;
  rename(request: VaultRenameRequest): Promise<Response<VaultNoteResponse>>;
  archive(request: VaultPathRequest): Promise<Response<VaultNoteResponse>>;
  restore(request: VaultPathRequest): Promise<Response<VaultNoteResponse>>;
  delete(request: VaultPathRequest): Promise<Response<VaultDeleteResponse>>;
  migrate(request: VaultMigrateRequest): Promise<Response<VaultNoteResponse>>;
  bindings(positionId?: string): Promise<Response<VaultBindingsResponse>>;
  bind(request: VaultBindRequest): Promise<Response<VaultBindingsResponse>>;
  source(): Promise<Response<VaultSourceResponse>>;
  resolve(request: VaultResolveRequest): Promise<Response<VaultNoteResponse>>;
  image(request: { path: string; notePath?: string }): Promise<Response<VaultImageResponse>>;
  attach(request: { fileId: string }): Promise<Response<{ path: string; mime: string; name: string }>>;
  fromTurn(request: { positionId: string; turnId: string; path: string; content?: string }): Promise<Response<VaultNoteResponse>>;
  sync(request?: { vaultId?: string }): Promise<Response<VaultSyncReceipt>>;
  targets(): Promise<Response<{ vaults: VaultSyncTarget[] }>>;
  context(request: { positionId: string; q?: string }): Promise<Response<{ notes: Array<{ noteId: string; path: string; ref: string; version: string; excerpt: string }> }>>;
  used(request: { positionId: string; turnId: string }): Promise<Response<{ notes: Array<{ noteId: string; path: string; ref: string; version: string; excerpt: string }> }>>;
  history(noteId: string): Promise<Response<{ versions: Array<{ version: string; content: string; path: string; createdAt: string }> }>>;
}
