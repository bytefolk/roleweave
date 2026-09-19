/** Typed shape of the whitelisted preload bridge (window.owb). */

import type {
  AssetRecord,
  AvatarGenerateRequest,
  AvatarGenerateResponse,
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
  ExternalServiceKind,
  ServiceConnectionInput,
  ServiceConnectionView,
  ServiceProbe,
  ServiceRelease,
  ServicesResponse,
  GroupConversation,
  GroupConversationList,
  GroupTimeline,
  GoalDetail,
  GoalSummary,
  GoalsCreateResponse,
  HealthResponse,
  QoderLoginResponse,
  ChangeManifest,
  CancelTurnRequest,
  HirePositionRequest,
  HireResult,
  OrgBackupsResponse,
  OrgRestoreResult,
  OrgUndoResult,
  PositionProfilePatch,
  PositionProfileResult,
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
  WorkspaceInitializeRequest,
} from "@roleweave/shared";

interface OwbApiResponse<T = unknown> {
  status: number;
  body: T;
  /** Native path selected by the picker when an open attempt fails. */
  workspacePath?: string;
}

interface OwbStatusResponse {
  running: boolean;
  runtime?: { mode: "native" | "wsl"; distro: string | null };
  state?: "starting" | "ready" | "degraded" | "stopping" | "stopped" | "failed";
  port?: number;
  health?: HealthResponse | null;
  error?: string | null;
  nextSteps?: string[];
}

export interface OwbBridge {
  configuration?: import("./configuration-types").ConfigurationBridge;
  openExternalUrl?(url: string): Promise<{ ok: boolean }>;
  /** Credential reads contain only status and a four-character suffix. */
  settings: {
    get(): Promise<import("./settings/credential-settings").SettingsSnapshot>;
    set(key: import("./settings/credential-settings").CredentialKey, value: string): Promise<import("./settings/credential-settings").SettingsResult>;
    clear(key: import("./settings/credential-settings").CredentialKey): Promise<import("./settings/credential-settings").SettingsResult>;
  };
  setPositionModel?(request: { positionId: string; model: string; engine?: TurnEngine }): Promise<OwbApiResponse<import("@roleweave/shared").EmployeeModelConfig>>;
  setPositionAgentEngine?(request: { positionId: string; engine: TurnEngine }): Promise<OwbApiResponse<{ agentEngine: TurnEngine; agentLocked: true; modelConfig: import("@roleweave/shared").EmployeeModelConfig }>>;
  updatePositionProfile?(request: PositionProfilePatch & { positionId: string }): Promise<OwbApiResponse<PositionProfileResult>>;
  status(): Promise<OwbStatusResponse>;
  /** One-click Qoder CLI login owned by the control plane. */
  qoderLogin: {
    start(): Promise<OwbApiResponse<QoderLoginResponse>>;
    status(): Promise<OwbApiResponse<QoderLoginResponse>>;
  };
  stopControlPlane(): Promise<{ ok: boolean; state: "stopped"; forced: boolean; exitCode: number | null; signalCode: string | null }>;
  openWorkspace(): Promise<OwbApiResponse>;
  createWorkspace(request: Omit<WorkspaceCreateRequest, "parentPath">): Promise<OwbApiResponse | { canceled: true }>;
  initializeWorkspace?(request: WorkspaceInitializeRequest): Promise<OwbApiResponse>;
  workspace(): Promise<OwbApiResponse>;
  /** Reveal the open workspace in the OS file manager. Takes no argument: the main process re-reads the open workspace itself. */
  revealWorkspace?(): Promise<{ opened: boolean; path?: string; reason?: string }>;
  orgTree(): Promise<OwbApiResponse>;
  orgApply(manifest: ChangeManifest): Promise<OwbApiResponse>;
  orgBackups(): Promise<OwbApiResponse<OrgBackupsResponse>>;
  orgRestore(backupId: string): Promise<OwbApiResponse<OrgRestoreResult>>;
  orgUndo(): Promise<OwbApiResponse<OrgUndoResult>>;
  hire(request: HirePositionRequest): Promise<OwbApiResponse<HireResult>>;
  generateAvatar(request: AvatarGenerateRequest): Promise<OwbApiResponse<AvatarGenerateResponse>>;
  reports(): Promise<OwbApiResponse<ReportsResponse>>;
  listApprovals(request: { workspacePath: string; cursor?: string }): Promise<OwbApiResponse<import("@roleweave/shared").ApprovalList>>;
  decideApproval(request: import("@roleweave/shared").ApprovalDecisionRequest & { id: string; workspaceToken: string }): Promise<OwbApiResponse<import("@roleweave/shared").ApprovalView>>;
  position(positionId: string, engine?: TurnEngine): Promise<OwbApiResponse>;
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
  createSessionTurn(request: { sessionId: string; input: string; engine: TurnEngine; pendingApproval?: TurnPendingApproval; retryOf?: string }): Promise<OwbApiResponse<TurnRecord>>;
  sessionTurnHistory(sessionId: string): Promise<OwbApiResponse<TurnHistory>>;
  createGroup(request: { memberPositionIds: string[] }): Promise<OwbApiResponse<GroupConversation>>;
  groups(): Promise<OwbApiResponse<GroupConversationList>>;
  group(conversationRef: string): Promise<OwbApiResponse<GroupConversation>>;
  dismissGroup(conversationRef: string): Promise<OwbApiResponse<{ conversationRef: string; dismissed: true }>>;
  addGroupMember(request: { conversationRef: string; positionId: string }): Promise<OwbApiResponse<GroupConversation>>;
  createGroupTurn(request: {
    conversationRef: string;
    input: string;
    /** Backward-compatible scalar for older control planes. */
    engine: TurnEngine;
    /** Agent binding for each mentioned employee. */
    engines?: Record<string, TurnEngine>;
    mentions: string[];
    mode?: "parallel" | "relay";
  }): Promise<OwbApiResponse<{
    conversationRef: string;
    messageId: string;
    spawns: Array<{ turnId: string; positionId: string; engine?: TurnEngine }>;
  }>>;
  groupTimeline(conversationRef: string): Promise<OwbApiResponse<GroupTimeline>>;
  createGoal(request: { title: string; description: string; acceptanceCriteria?: string[] }): Promise<OwbApiResponse<GoalsCreateResponse>>;
  goals(): Promise<OwbApiResponse<{ goals: GoalSummary[] }>>;
  goal(goalId: string): Promise<OwbApiResponse<GoalDetail>>;
  updateGoal(request: { goalId: string; title?: string; description?: string; acceptanceCriteria?: string[]; status?: string; health?: string }): Promise<OwbApiResponse<{ goalId: string }>>;
  deleteGoal(goalId: string): Promise<OwbApiResponse<{ goalId: string; deleted: boolean }>>;
  drive: {
    list(q?: string): Promise<OwbApiResponse<DriveObjectListResponse>>;
    detail(id: string): Promise<OwbApiResponse<DriveObjectDetailResponse>>;
    upload(filePath: string): Promise<OwbApiResponse<DriveUploadResponse>>;
    pickAndUpload(): Promise<OwbApiResponse<DriveUploadResponse> | { canceled: true }>;
  };
  sseStatus(): Promise<"connecting" | "connected">;
  services: {
    list(): Promise<OwbApiResponse<ServicesResponse>>;
    configure(request: ServiceConnectionInput): Promise<OwbApiResponse<ServiceConnectionView>>;
    disconnect(kind: ExternalServiceKind): Promise<OwbApiResponse<ServiceConnectionView>>;
    probe(kind: ExternalServiceKind): Promise<OwbApiResponse<ServiceProbe>>;
    release(kind: ExternalServiceKind): Promise<OwbApiResponse<ServiceRelease>>;
    open(kind: ExternalServiceKind): Promise<OwbApiResponse<{ opened: boolean }>>;
    openRelease(kind: ExternalServiceKind): Promise<OwbApiResponse<{ opened: boolean }>>;
  };
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
