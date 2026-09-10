/** Typed shape of the whitelisted preload bridge (window.owb). */

import type {
  AssetRecord,
  AssetsCreateRequest,
  AssetsListResponse,
  DocPlaneDetailResponse,
  DocPlaneListResponse,
  DocRef,
  DocsCreateRequest,
  DocsCreateResponse,
  DocsFileListResponse,
  DocsFileResponse,
  DocsResolveResponse,
  DriveObjectDetailResponse,
  DriveObjectListResponse,
  DriveUploadResponse,
  GroupConversation,
  GroupConversationList,
  GroupTimeline,
  HealthResponse,
  ChangeManifest,
  CancelTurnRequest,
  HirePositionRequest,
  HireResult,
  OrgBackupsResponse,
  OrgRestoreResult,
  OrgUndoResult,
  ReportsResponse,
  TurnEngine,
  TurnHistory,
  TurnPendingApproval,
  TurnRecord,
  UpdateEvent,
  UpdateResult,
  UpdateStatus,
  WorkbenchSession,
  WorkbenchSessionList,
  WorkspaceCreateRequest,
} from "@roleweave/shared";

interface OwbApiResponse<T = unknown> {
  status: number;
  body: T;
}

interface OwbStatusResponse {
  running: boolean;
  state?: "starting" | "ready" | "degraded" | "stopping" | "stopped" | "failed";
  port?: number;
  health?: HealthResponse | null;
  error?: string | null;
  nextSteps?: string[];
}

export interface OwbBridge {
  status(): Promise<OwbStatusResponse>;
  stopControlPlane(): Promise<{ ok: boolean; state: "stopped"; forced: boolean; exitCode: number | null; signalCode: string | null }>;
  openWorkspace(): Promise<OwbApiResponse>;
  createWorkspace(request: Omit<WorkspaceCreateRequest, "parentPath">): Promise<OwbApiResponse | { canceled: true }>;
  workspace(): Promise<OwbApiResponse>;
  orgTree(): Promise<OwbApiResponse>;
  orgApply(manifest: ChangeManifest): Promise<OwbApiResponse>;
  orgBackups(): Promise<OwbApiResponse<OrgBackupsResponse>>;
  orgRestore(backupId: string): Promise<OwbApiResponse<OrgRestoreResult>>;
  orgUndo(): Promise<OwbApiResponse<OrgUndoResult>>;
  hire(request: HirePositionRequest): Promise<OwbApiResponse<HireResult>>;
  reports(): Promise<OwbApiResponse<ReportsResponse>>;
  position(positionId: string): Promise<OwbApiResponse>;
  positionDocs(positionId: string): Promise<OwbApiResponse<DocsFileListResponse>>;
  positionDocFile(positionId: string, filePath: string): Promise<OwbApiResponse<DocsFileResponse>>;
  createPositionDoc(request: DocsCreateRequest): Promise<OwbApiResponse<DocsCreateResponse>>;
  resolveDocRef(ref: DocRef): Promise<OwbApiResponse<DocsResolveResponse>>;
  /** #35 R2 MVP: external doc-plane list proxy (bytefolk/doc bridge). */
  docPlaneList(query?: string): Promise<OwbApiResponse<DocPlaneListResponse>>;
  /** #35 R2 MVP: external doc-plane detail proxy (flattened markdown body). */
  docPlaneDetail(id: string): Promise<OwbApiResponse<DocPlaneDetailResponse>>;
  assetsList(): Promise<OwbApiResponse<AssetsListResponse>>;
  assetsRead(assetId: string): Promise<OwbApiResponse<AssetRecord>>;
  assetsCreate(request: AssetsCreateRequest): Promise<OwbApiResponse<AssetRecord>>;
  createTurn(request: { positionId: string; input: string; engine: TurnEngine; pendingApproval?: TurnPendingApproval }): Promise<OwbApiResponse<TurnRecord>>;
  cancelTurn(request: string | CancelTurnRequest): Promise<OwbApiResponse<{ cancelled: boolean; positionId: string }>>;
  turnHistory(positionId: string): Promise<OwbApiResponse<TurnHistory>>;
  createSession(request: { positionId: string }): Promise<OwbApiResponse<WorkbenchSession>>;
  sessions(positionId: string): Promise<OwbApiResponse<WorkbenchSessionList>>;
  session(sessionId: string): Promise<OwbApiResponse<WorkbenchSession>>;
  sessionSetContext(request: { sessionId: string; enabled: boolean }): Promise<OwbApiResponse<WorkbenchSession>>;
  rotateSession(sessionId: string): Promise<OwbApiResponse<WorkbenchSession>>;
  createSessionTurn(request: { sessionId: string; input: string; engine: TurnEngine; pendingApproval?: TurnPendingApproval }): Promise<OwbApiResponse<TurnRecord>>;
  sessionTurnHistory(sessionId: string): Promise<OwbApiResponse<TurnHistory>>;
  createGroup(request: { memberPositionIds: string[] }): Promise<OwbApiResponse<GroupConversation>>;
  groups(): Promise<OwbApiResponse<GroupConversationList>>;
  group(conversationRef: string): Promise<OwbApiResponse<GroupConversation>>;
  addGroupMember(request: { conversationRef: string; positionId: string }): Promise<OwbApiResponse<GroupConversation>>;
  createGroupTurn(request: { conversationRef: string; input: string; engine: TurnEngine; mentions: string[]; mode?: "parallel" | "relay" }): Promise<OwbApiResponse<{ conversationRef: string; messageId: string; spawns: Array<{ turnId: string; positionId: string }> }>>;
  groupTimeline(conversationRef: string): Promise<OwbApiResponse<GroupTimeline>>;
  drive: {
    list(q?: string): Promise<OwbApiResponse<DriveObjectListResponse>>;
    detail(id: string): Promise<OwbApiResponse<DriveObjectDetailResponse>>;
    upload(filePath: string): Promise<OwbApiResponse<DriveUploadResponse>>;
    pickAndUpload(): Promise<OwbApiResponse<DriveUploadResponse> | { canceled: true }>;
  };
  sseStatus(): Promise<"connecting" | "connected">;
  /** #134 update surface. Null means the shell declined to answer this frame. */
  update: {
    status(): Promise<UpdateStatus | null>;
    check(): Promise<UpdateResult | null>;
    download(request: { confirmedByUser: boolean }): Promise<UpdateResult | null>;
    install(request: { confirmedByUser: boolean }): Promise<UpdateResult | null>;
    openReleaseNotes(): Promise<{ ok: boolean; url?: string }>;
  };
  /** #73 custom title bar controls (frameless window). */
  windowMinimize(): Promise<{ ok: boolean }>;
  windowToggleMaximize(): Promise<{ ok: boolean }>;
  windowClose(): Promise<{ ok: boolean }>;
  onEvent(callback: (event: unknown) => void): () => void;
  onSseStatus(callback: (state: "connecting" | "connected") => void): () => void;
  onUpdateState(callback: (state: UpdateEvent) => void): () => void;
  onFallbackNotice(callback: (failedPath: string) => void): () => void;
}

declare global {
  interface Window {
    owb: OwbBridge;
  }
}

export {};
