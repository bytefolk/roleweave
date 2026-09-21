import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Alert, Badge, Button as AntButton, ConfigProvider, message } from "antd";
import { DiagnosticNotice } from "./DiagnosticNotice";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import { localizePositionCard, OwbI18nProvider, useT, type OwbLocale } from "@roleweave/ui";
import {
  AppShell,
  DSProvider,
  ModuleRail,
  Sidebar,
  Skeleton,
  Topbar,
} from "@fullstack-ai-infra/ui";
import { OrgTree, PositionCard } from "@roleweave/ui";
import type { OrgDropPosition, PositionCardData } from "@roleweave/ui";
import type {
  ChangeManifest,
  EmployeeModelConfig,
  GroupTimeline,
  HealthResponse,
  OrgBackupEntry,
  OrgBackupsResponse,
  OrgTreeNodeV1,
  OrgTreeSnapshot,
  PositionProfilePatch,
  PositionProfileResult,
  QoderLoginResponse,
  ReportsResponse,
  TurnHistory,
  WorkbenchSession,
  WorkbenchSessionList,
  WorkspaceCreateResponse,
  WorkspaceInfoResponse,
} from "@roleweave/shared";
import { Brain, ChartColumn, ChevronsRight, ClipboardCheck, Flag, FolderOpen, Network, PencilLine, Plus, Settings, Undo2, UsersRound } from "lucide-react";
import { useThemeMode, useThemeProfile } from "./theme-toggle";
import { useTheme, ThemeProvider } from "./theme-context";
import { themeToAntdSeed } from "./theme-resolution";
import { DEFAULT_PRESET_ID } from "./theme-presets";
import { PrefsMenu } from "./prefs-menu";
import { persistLocale, seedLocale } from "./locale-mode";
import {
  EMPTY_TURN_STREAM,
  TurnPanel,
  adaptTurnHistory,
  adaptTurnRecord,
  applyTurnEvent,
  beginGroupRun,
  beginPendingTurn,
  defaultAgentHost,
  TURN_ENGINES,
  reconcileGroupTimeline,
  resolveAgentEngine,
  resetStreamSeq,
  settlePendingTurn,
  useEngineLabel,
} from "./turns";
import { EngineIcon } from "./turns/engine-icon";
import type {
  CreateTurnRequest,
  PositionMentionOption,
  TurnEngine,
  TurnRecord,
  TurnStreamEnvelope,
  TurnStreamState,
} from "./turns";
import { BackupTray, DismissPositionDialog } from "./org/OrgControls";
import { EditEmployeeDrawer } from "./org/EditEmployeeDrawer";
import { HireDrawer } from "./org/HireDrawer";
import { OrgChart } from "./org/OrgChart";
import { EmployeeSettings, ProjectSettings, TreeRowMenu, type TreeAction } from "./org/TreeManagement";
import { useConfigurationBootstrap, useSendShortcut, useWorkspaceFocus, requestSettingsLeave, persistApplicationPreference, preferenceError } from "./configuration-preferences";
import { createConversationMemory } from "./turns/conversation-memory";
import { useConversationCopy } from "./locales/conversation";
import { OrgWorkspaceSplit } from "./org/OrgWorkspaceSplit";
import { createOrgRefreshCoordinator, onlyMovesAndReorders } from "./org/refresh-coordinator";
import { GroupsPanel } from "./groups/GroupsPanel";
import { MemoryModule, type MemorySource } from "./memory/MemoryModule";
import { ReportsCenter } from "./reports/ReportsCenter";
import { ApprovalQueue, type ApprovalQueueItem } from "./approvals";
import { useApprovals } from "./approvals/useApprovals";
import { decodeEscapedUnicode } from "./display-text";
import { SettingsModule } from "./settings/SettingsModule";
import { GoalsModule } from "./goals/GoalsModule";
import { ProjectSwitcher } from "./project/ProjectSwitcher";
import { ProjectWorkspaceDialog } from "./project/ProjectWorkspaceDialog";
import { assignDefaultAvatars, avatarSrcFor, readAvatarPreferences, type AvatarValue } from "./PositionAvatar";

interface PositionCardState {
  loading: boolean;
  data: PositionCardData | null;
  notFound: boolean;
}
/**
 * D1 renderer: AppShell four-zone layout (spec §1) — ModuleRail (org active,
 * memory module), Topbar (workspace location + engine status), Sidebar
 * (--ui-sidebar-wide 288px, OrgTree), main (PositionCard).
 * Data flows exclusively through the whitelisted preload bridge + SSE
 * (org.updated drives refresh; the UI never polls).
 */
export function App() {
  // The theme provider lives here, not in main.tsx, for the same reason the antd
  // ConfigProvider does: `App.test.tsx` renders `<App />` on its own in 30+ cases,
  // so the harness and production have to run the identical configuration.
  // Wrapping in main.tsx instead left every direct render throwing
  // "useTheme must be used within a ThemeProvider".
  return (
    <ThemeProvider>
      <AppRoot />
    </ThemeProvider>
  );
}

/** #146 i18n 根：locale 状态住在 Provider 之上；恰好两个 locale，
 * 持久化，默认 zh-CN。antd 的 ConfigProvider locale 同步切换。 */
function AppRoot() {
  const [locale, setLocale] = useState<OwbLocale>(() => seedLocale());
  useConfigurationBootstrap(setLocale);
  const changeLocale = useCallback((next: OwbLocale) => {
    if (window.owb?.configuration) {
      void persistApplicationPreference({ appearance: { locale: next } }).catch(preferenceError);
      return;
    }
    setLocale(next);
    persistLocale(next);
  }, []);
  return (
    <OwbI18nProvider locale={locale}>
      <AppInner locale={locale} onChangeLocale={changeLocale} />
    </OwbI18nProvider>
  );
}
function AppInner({
  locale,
  onChangeLocale,
}: {
  locale: OwbLocale;
  onChangeLocale: (next: OwbLocale) => void;
}) {
  const themeContext = useTheme();
  const [activeModule, setActiveModuleRaw] = useState<
    "org" | "groups" | "reports" | "approvals" | "docs" | "goals" | "settings"
  >("org");
  const setActiveModule = useCallback((next: typeof activeModule) => {
    if (next === "settings") setActiveModuleRaw(next);
    else requestSettingsLeave(() => setActiveModuleRaw(next));
  }, []);
  /** 2026-09-17 设计评审：导轨默认收拢只出图标（hover 浮名字），展开后
   * icon+名字；展开/收拢手柄骑在导轨与侧栏边界上。手柄默认离底部 72px，
   * 可拖拽上下调整，位置写 localStorage，下次启动照旧。 */
  const [railExpanded, setRailExpanded] = useState<boolean>(() => seedRailExpanded());
  const [railChipBottom, setRailChipBottom] = useState<number>(() => seedRailChipBottom());
  const railChipBottomRef = useRef(railChipBottom);
  railChipBottomRef.current = railChipBottom;
  const railChipDrag = useRef<RailChipDrag | null>(null);
  const railChipMoved = useRef(false);
  const [railChipDragging, setRailChipDragging] = useState(false);

  const toggleRailExpanded = useCallback(() => {
    setRailExpanded((current) => {
      const next = !current;
      persistRailExpanded(next);
      return next;
    });
  }, []);

  const updateRailChipBottom = useCallback((next: number) => {
    railChipBottomRef.current = next;
    setRailChipBottom(next);
  }, []);

  const railChipBounds = useCallback((target: HTMLElement): RailChipBounds => {
    const rail = target.closest<HTMLElement>(".ui-module-rail");
    const railHeight = rail?.getBoundingClientRect().height || window.innerHeight || 720;
    return {
      min: RAIL_CHIP_MIN_BOTTOM,
      max: Math.max(RAIL_CHIP_MIN_BOTTOM, railHeight - RAIL_CHIP_EDGE_GUTTER - RAIL_CHIP_SIZE),
    };
  }, []);

  const onRailChipPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button > 0) return;
    const bounds = railChipBounds(event.currentTarget);
    const startBottom = clampRailChipBottom(railChipBottomRef.current, bounds);
    railChipDrag.current = { pointerId: event.pointerId, startY: event.clientY, startBottom, bounds };
    railChipMoved.current = false;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // jsdom and older WebViews may not implement pointer capture.
    }
  }, [railChipBounds]);

  const onRailChipPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = railChipDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const currentY = Number.isFinite(event.clientY) ? event.clientY : drag.startY;
    const delta = drag.startY - currentY;
    if (Math.abs(delta) > RAIL_CHIP_DRAG_THRESHOLD) {
      railChipMoved.current = true;
      setRailChipDragging(true);
      event.preventDefault();
    }
    updateRailChipBottom(clampRailChipBottom(drag.startBottom + delta, drag.bounds));
  }, [updateRailChipBottom]);

  const onRailChipPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = railChipDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    persistRailChipBottom(railChipBottomRef.current);
    railChipDrag.current = null;
    setRailChipDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // jsdom and older WebViews may not implement pointer capture.
    }
  }, []);

  const onRailChipPointerCancel = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = railChipDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    railChipDrag.current = null;
    railChipMoved.current = false;
    setRailChipDragging(false);
  }, []);

  const onRailChipKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!(event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End")) return;
    event.preventDefault();
    const bounds = railChipBounds(event.currentTarget);
    const next = event.key === "Home"
      ? bounds.max
      : event.key === "End"
        ? bounds.min
        : railChipBottomRef.current + (event.key === "ArrowUp" ? RAIL_CHIP_KEYBOARD_STEP : -RAIL_CHIP_KEYBOARD_STEP);
    const clamped = clampRailChipBottom(next, bounds);
    updateRailChipBottom(clamped);
    persistRailChipBottom(clamped);
  }, [railChipBounds, updateRailChipBottom]);

  const onRailChipClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (railChipMoved.current) {
      event.preventDefault();
      railChipMoved.current = false;
      return;
    }
    toggleRailExpanded();
  }, [toggleRailExpanded]);

  /** ⌘B / Ctrl+B 直接切导轨宽窄；输入框里不抢键。 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "b") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      toggleRailExpanded();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleRailExpanded]);
  const [memorySource, setMemorySource] = useState<MemorySource>("docs");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const healthReadVersion = useRef(0);
  const refreshReadVersion = useRef(0);
  const positionReadVersion = useRef(0);
  const availabilityOperation = useRef<symbol | null>(null);
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const [availabilityCheckFailed, setAvailabilityCheckFailed] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfoResponse | null>(null);
  const approvalState = useApprovals(workspaceInfo?.open ? workspaceInfo.path : undefined);
  const [orgOverview, setOrgOverview] = useState(false);
  const [conversationFocused, setConversationFocused] = useWorkspaceFocus(workspaceInfo?.path ?? "");
  const sendShortcut = useSendShortcut();
  const conversationMemory = useRef(createConversationMemory());
  const workbenchButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setOrgOverview(false), [activeModule, workspaceInfo?.path, workspaceInfo?.open]);
  const [snapshot, setSnapshot] = useState<OrgTreeSnapshot | null>(null);
  const [managementTarget, setManagementTarget] = useState<string | null | undefined>(undefined);
  const [treeLoading, setTreeLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [card, setCard] = useState<PositionCardState>({
    loading: false,
    data: null,
    notFound: false,
  });
  const [positionNames, setPositionNames] = useState<Record<string, string>>({});
  const positionNamesRef = useRef<Record<string, string>>({});
  const [positionColors, setPositionColors] = useState<Record<string, string>>({});
  /** Avatar is a presentation preference scoped to this local project. It
   * never mutates the employee package or its upstream digest. */
  const [positionAvatars, setPositionAvatars] = useState<Record<string, AvatarValue>>({});
  const workspaceAvatars = useRef(new Map<string, Record<string, AvatarValue>>());
  /** Concrete runtime picked once when an employee is hired. The server owns
   * enforcement; this local projection lets the renderer show accurate
   * readiness and seed a legacy employee's first durable binding. */
  const [positionEngines, setPositionEngines] = useState<Record<string, TurnEngine>>({});
  const positionEnginesRef = useRef<Record<string, TurnEngine>>({});
  positionEnginesRef.current = positionEngines;
  const positionBindingWrites = useRef<Record<string, number>>({});
  const defaultTurnEngineRef = useRef<TurnEngine>("qoder");
  const [lockedAgentPositions, setLockedAgentPositions] = useState<Record<string, boolean>>({});
  const [positionModels, setPositionModels] = useState<Record<string, EmployeeModelConfig>>({});
  const [modelStates, setModelStates] = useState<Record<string, { loading?: boolean; error?: string; notice?: string }>>({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [modelSavingIds, setModelSavingIds] = useState<Record<string, boolean>>({});
  const modelSaveOperations = useRef(new Set<string>());
  const [engineSavingId, setEngineSavingId] = useState<string | null>(null);
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [turnStream, setTurnStream] = useState<TurnStreamState>(EMPTY_TURN_STREAM);
  const [busyPositions, setBusyPositions] = useState<Record<string, boolean>>({});
  // Keep execution ownership across navigation: the service does not stop a
  // task when the operator opens another workspace.
  const workspaceStreams = useRef(new Map<string, TurnStreamState>());
  const workspaceBusy = useRef(new Map<string, Record<string, boolean>>());
  const workspaceCancelling = useRef(new Map<string, Record<string, boolean>>());
  const cancelOperations = useRef(new Map<string, symbol>());
  const inFlightPositions = useRef(new Set<string>());
  const [cancellingPositions, setCancellingPositions] = useState<Record<string, boolean>>({});
  const turnBusy = selectedId !== null && busyPositions[selectedId] === true;
  const turnCancelling = selectedId !== null && cancellingPositions[selectedId] === true;
  const selectedSessions = useRef<Record<string, string>>({});
  const selectionVersion = useRef(0);
  const historyRequest = useRef(0);
  const sessionOperations = useRef(new Map<string, symbol>());
  const workspacePathRef = useRef(workspaceInfo?.path);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<WorkbenchSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const selectedSessionIdRef = useRef<string | null>(null);
  const [sessionBusyPositions, setSessionBusyPositions] = useState<Record<string, boolean>>({});
  const sessionBusy = selectedId !== null && sessionBusyPositions[selectedId] === true;
  const [sseState, setSseState] = useState<"connecting" | "connected">("connecting");
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [backups, setBackups] = useState<OrgBackupEntry[]>([]);
  const [backupsStatus, setBackupsStatus] = useState<"loading" | "ready" | "error">("loading");
  // Identity changes on every workspace transition, including A → B → A.
  const backupWorkspace = useRef<{ path: string | null }>({ path: null });
  const backupRead = useRef(0);
  const [reports, setReports] = useState<ReportsResponse | null>(null);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [reportsFocusTurnId, setReportsFocusTurnId] = useState<string | null>(null);
  useEffect(() => setReportsFocusTurnId(null), [workspaceInfo?.open, workspaceInfo?.path]);
  const [orgBusy, setOrgBusy] = useState(false);
  const [orgFeedback, setOrgFeedback] = useState<{ tone: "info" | "warn"; text: string } | null>(null);
  const [orgRefreshes] = useState(createOrgRefreshCoordinator);
  const approvalItems = useMemo<ApprovalQueueItem[]>(() => approvalState.items.map(a => ({
    approvalId: a.id, positionId: a.source.positionId, positionName: positionNames[a.source.positionId],
    category: a.action.kind, description: a.action.description, target: a.action.target,
    requestedAt: a.requestedAt, expiresAt: a.expiresAt,
    decision: a.status === "granted" ? { kind: "granted", scope: a.decision?.scope ?? "once", decidedAt: a.decision?.decidedAt, decidedBy: a.decision?.decidedBy, reason: a.decision?.reason } : a.status === "denied" ? { kind: "denied", reason: a.decision?.reason, decidedAt: a.decision?.decidedAt, decidedBy: a.decision?.decidedBy } : { kind: a.status },
    scopeAllowed: a.context?.scope.allowed ?? ["once"],
    batchMaxItems: a.batch?.maxItems,
    canDecide: a.canDecide, busy: approvalState.busy.has(a.id), error: approvalState.errors[a.id],
    unavailableReason: a.unavailableReason, executionPhase: a.execution.phase,
    requestReason: a.requestReason, context: a.context, policyProgress: a.progress, source: a.source, executionTurnId: a.execution.turnId, executionErrorCode: a.execution.errorCode,
  })), [approvalState.items, approvalState.busy, approvalState.errors, positionNames]);
  const decidedApprovals = useMemo(() => new Set(approvalState.items.filter(a =>
    a.status !== "pending" && a.source.positionId === selectedId && a.source.conversationId === selectedSessionId
  ).map(a => a.source.turnId)), [approvalState.items, selectedId, selectedSessionId]);
  /** Tree-node "+" hire entry (#32 AC-004): undefined = closed, otherwise the preset reportTo. */
  const [treeHireParent, setTreeHireParent] = useState<string | null | undefined>(undefined);
  /** Employee-record editor (#292): opened from the position card header or
   * from a tree row's own menu (right-click / ellipsis). Bound to the target
   * record id rather than the conversation selection, so editing one employee
   * from the tree never hijacks — or depend on — the open conversation. */
  const [editTargetId, setEditTargetId] = useState<string | undefined>(undefined);
  const [editPosition, setEditPosition] = useState<PositionCardData | null>(null);
  // The editor is bound to one record: switching project must not leave a form
  // open over another workspace's employee.
  useEffect(() => { setEditTargetId(undefined); setEditPosition(null); }, [workspaceInfo?.path]);
  const [projectHubOpen, setProjectHubOpen] = useState(false);
  const [workspaceOpening, setWorkspaceOpening] = useState(false);
  const [workspaceOpenError, setWorkspaceOpenError] = useState<string | null>(null);
  const [workspaceOpenCandidatePath, setWorkspaceOpenCandidatePath] = useState<string | null>(null);
  useEffect(() => {
    if (projectHubOpen) setWorkspaceOpenError(null);
  }, [projectHubOpen]);
  /** Org-tree group entry (#53): prefilled draft members handed to the
   * GroupsPanel create panel; nonce re-fires repeated entries. */
  const groupWorkspaceScope = useMemo(() => Symbol("group-workspace"), [workspaceInfo?.path, workspaceInfo?.open]);
  const latestGroupWorkspaceScope = useRef(groupWorkspaceScope);
  latestGroupWorkspaceScope.current = groupWorkspaceScope;
  const [groupDraftSeed, setGroupDraftSeed] = useState<{ members: string[]; nonce: number; scope: symbol } | null>(null);
  /** 亮/暗跟随 <html data-theme>，antd cssinjs 与 --ui-* skin 同步切换。 */
  const themeMode = useThemeMode();
  const themeProfile = useThemeProfile();
  /** #146：界面文案唯一入口；数据层文案不经过这里。 */
  const t = useT();
  const conversationCopy = useConversationCopy();

  // Read the target record when the editor opens, so a tree entry edits exactly
  // the row it was invoked on — not whichever employee happens to be selected.
  useEffect(() => {
    if (editTargetId === undefined) {
      setEditPosition(null);
      return;
    }
    let alive = true;
    setEditPosition(null);
    void window.owb.position(editTargetId).then((res) => {
      if (!alive) return;
      const body = res.body as { position?: PositionCardData; code?: string };
      if (res.status !== 200 || !body.position) {
        setEditTargetId(undefined);
        setOrgFeedback({ tone: "warn", text: t("org.stalePosition") });
        return;
      }
      setEditPosition(normalizePositionForDisplay(body.position, locale));
    }).catch(() => {
      if (alive) setEditTargetId(undefined);
    });
    return () => { alive = false; };
  }, [editTargetId, locale, t]);

  const updateWorkspaceStream = useCallback((path: string, update: (state: TurnStreamState) => TurnStreamState) => {
    const next = update(workspaceStreams.current.get(path) ?? EMPTY_TURN_STREAM);
    workspaceStreams.current.set(path, next);
    if (workspacePathRef.current === path) setTurnStream(next);
  }, []);

  const updateWorkspaceBusy = useCallback((path: string, positionId: string, busy: boolean) => {
    const next = { ...workspaceBusy.current.get(path), [positionId]: busy };
    workspaceBusy.current.set(path, next);
    if (workspacePathRef.current === path) setBusyPositions(next);
  }, []);

  const updateWorkspaceCancelling = useCallback((path: string, positionId: string, cancelling: boolean) => {
    const next = { ...workspaceCancelling.current.get(path), [positionId]: cancelling };
    workspaceCancelling.current.set(path, next);
    if (workspacePathRef.current === path) setCancellingPositions(next);
  }, []);

  useEffect(() => {
    if (workspacePathRef.current === workspaceInfo?.path) return;
    workspacePathRef.current = workspaceInfo?.path;
    setManagementTarget(undefined);
    setPositionModels({});
    selectionVersion.current += 1;
    historyRequest.current += 1;
    setModelStates({});
    setHistoryLoading(false);
    sessionOperations.current.clear();
    setBusyPositions(workspaceBusy.current.get(workspaceInfo?.path ?? "") ?? {});
    setCancellingPositions(workspaceCancelling.current.get(workspaceInfo?.path ?? "") ?? {});
    setSessionBusyPositions({});
    setTurnStream(workspaceStreams.current.get(workspaceInfo?.path ?? "") ?? EMPTY_TURN_STREAM);
    setTurns([]);
    setSessions([]);
    selectedSessionIdRef.current = null;
    setSelectedSessionId(null);
  }, [workspaceInfo?.path]);

  useEffect(() => {
    const path = workspaceInfo?.open ? workspaceInfo.path : null;
    if (!path) { setPositionAvatars({}); return; }
    const avatars = workspaceAvatars.current.get(path) ?? readAvatarPreferences(window.localStorage, path);
    workspaceAvatars.current.set(path, avatars);
    setPositionAvatars(avatars);
  }, [workspaceInfo?.open, workspaceInfo?.path]);

  const setPositionAvatar = useCallback((positionId: string, value: string) => {
    setPositionAvatars((current) => {
      const next = { ...current, [positionId]: value };
      const path = workspacePathRef.current;
      if (path) {
        workspaceAvatars.current.set(path, next);
        try { window.localStorage.setItem(`roleweave:position-avatars:${path}`, JSON.stringify(next)); } catch { /* keep an in-memory choice when storage is unavailable */ }
      }
      return next;
    });
  }, []);

  const avatarUrls = useMemo(() => Object.fromEntries(Object.keys(positionNames).map((id) => [id, avatarSrcFor(id, positionAvatars[id])])), [positionAvatars, positionNames]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  // 这些横幅存的是点击时已解析好的文案；切换语言后旧文案会残留成另一种
  // 语言（中文界面里挂着英文 “No org adjustment to undo”）。语言一变就清掉。
  useEffect(() => {
    setOrgFeedback(null);
    setReportsError(null);
    setTurnError(null);
  }, [locale]);

  const loadBackups = useCallback(async (scope = backupWorkspace.current) => {
    if (!scope.path || scope !== backupWorkspace.current) return;
    const read = ++backupRead.current;
    const isCurrent = () => scope === backupWorkspace.current && read === backupRead.current;
    setBackupsStatus("loading");
    try {
      const response = await window.owb.orgBackups();
      if (!isCurrent()) return;
      const body = response.body as OrgBackupsResponse | null;
      if (response.status !== 200 || !Array.isArray(body?.backups)) {
        setBackupsStatus("error");
        return;
      }
      setBackups(body.backups);
      setBackupsStatus("ready");
    } catch {
      if (isCurrent()) setBackupsStatus("error");
    }
  }, []);

  const loadReports = useCallback(async () => {
    setReportsLoading(true);
    try {
      const response = await window.owb.reports();
      if (response.status !== 200) {
        setReports(null);
        setReportsError(apiErrorMessage(response.body, t("rep.readFail")));
        return;
      }
      setReports(response.body as ReportsResponse);
      setReportsError(null);
    } catch {
      setReports(null);
      setReportsError(t("rep.readFailOffline"));
    } finally {
      setReportsLoading(false);
    }
  }, [t]);

  const refresh = useCallback(async (reusePositionMetadata = false) => {
    const refreshRead = ++refreshReadVersion.current;
    const isCurrentRefresh = () => refreshRead === refreshReadVersion.current;
    const healthRead = ++healthReadVersion.current;
    try {
    const statusRes = await window.owb.status();
    if (!isCurrentRefresh()) return;
    if (healthRead === healthReadVersion.current) setHealth(statusRes.health ?? null);
    if (!statusRes.running) {
      setStartupError(t("misc.serviceFailed"));
      return;
    }
    // Publish only the latest summary: a delayed workspace read must not
    // reset the recovery scope after a newer workspace has already opened.
    const workspaceRead = window.owb.workspace();
    // Structural refreshes still start both reads together. Settle a rejected
    // tree immediately, even if a stale workspace makes us discard it later.
    const pendingTree = reusePositionMetadata
      ? window.owb.orgTree().then((response) => ({ response }), (error: unknown) => ({ error }))
      : undefined;
    const workspaceRes = await workspaceRead;
    if (!isCurrentRefresh()) return;
    if (workspaceRes.status !== 200) throw new Error("Workspace unavailable");
    setStartupError(null);
    const ws = workspaceRes.body as WorkspaceInfoResponse | null;
    const backupPath = ws?.open === true ? ws.path ?? null : null;
    if (backupWorkspace.current.path !== backupPath) {
      backupWorkspace.current = { path: backupPath };
      backupRead.current += 1;
      setBackups([]);
      setBackupsStatus("loading");
      positionBindingWrites.current = {};
      setPositionEngines({});
      setLockedAgentPositions({});
    }
    const backupScope = backupWorkspace.current;
    setWorkspaceInfo(ws);
    if (ws?.open === true) {
      // Recovery is independent of the organization tree; a failed tree read
      // must not leave this footer waiting for a request that never started.
      const backupLoad = loadBackups(backupScope);
      const treeResult = pendingTree ? await pendingTree : { response: await window.owb.orgTree() };
      if (!isCurrentRefresh()) return;
      if ("error" in treeResult) throw treeResult.error;
      const treeRes = treeResult.response;
      if (treeRes.status === 200) {
        const nextSnapshot = treeRes.body as OrgTreeSnapshot;
        setSnapshot(nextSnapshot);
        const positionIds = flattenPositionIds(nextSnapshot.tree);
        setSelectedId((current) => current && positionIds.includes(current) ? current : null);
        // Moves/reorders keep the sidebar's names, avatars and engines. Other
        // mutations (especially deletion/hire) still reconcile all metadata.
        if (!reusePositionMetadata) {
          const bindingWritesAtRead = { ...positionBindingWrites.current };
          const cardEntries = await Promise.all(positionIds.map(async (id): Promise<[string, { name: string; color?: string; agentEngine?: TurnEngine }]> => {
            const response = await window.owb.position(id);
            const body = response.body as { position?: PositionCardData; agentEngine?: unknown };
            const position = response.status === 200 && body.position
              ? normalizePositionForDisplay(body.position, locale)
              : undefined;
            const color = position?.metadata?.color;
            const agentEngine = isTurnEngine(body.agentEngine) ? body.agentEngine : undefined;
            return [id, {
              name: position?.name ?? t("org.unknownPosition"),
              ...(typeof color === "string" && color.length > 0 ? { color } : {}),
              ...(agentEngine === undefined ? {} : { agentEngine }),
              // The org chart only needs a human name and optional color. Mode,
              // budget and permissions belong to the selected position record.
            }];
          }));
          if (!isCurrentRefresh()) return;
          const names = Object.fromEntries(cardEntries.map(([id, entry]) => [id, entry.name]));
          positionNamesRef.current = names;
          setPositionNames(names);
          const avatars = assignDefaultAvatars(positionIds, ws.path ? {
            ...readAvatarPreferences(window.localStorage, ws.path),
            ...workspaceAvatars.current.get(ws.path),
          } : {});
          if (ws.path) workspaceAvatars.current.set(ws.path, avatars);
          try { if (ws.path) window.localStorage.setItem(`roleweave:position-avatars:${ws.path}`, JSON.stringify(avatars)); } catch { /* assignments remain available for this session */ }
          setPositionAvatars(avatars);
          setPositionColors(Object.fromEntries(cardEntries.filter(([, entry]) => "color" in entry).map(([id, entry]) => [id, (entry as { color: string }).color])));
          const engines = cardEntries.reduce<Record<string, TurnEngine>>((next, [id, entry]) => {
            if (entry.agentEngine !== undefined) next[id] = entry.agentEngine;
            return next;
          }, {});
          setPositionEngines((current) => {
            // A first model save or turn can bind an employee while these
            // cards are in flight. Keep that newer confirmation per employee;
            // later refreshes can still reconcile current server metadata.
            for (const id of positionIds) {
              if (positionBindingWrites.current[id] === bindingWritesAtRead[id]) continue;
              if (current[id] !== undefined) engines[id] = current[id];
              else delete engines[id];
            }
            return engines;
          });
        }
        await Promise.all([backupLoad, loadReports()]);
      } else {
        setSnapshot(null);
        positionNamesRef.current = {};
        setPositionNames({});
        setPositionColors({});
        setPositionEngines({});
        setLockedAgentPositions({});
        await backupLoad;
      }
    } else {
      setSnapshot(null);
      positionNamesRef.current = {};
      setPositionNames({});
      setPositionColors({});
      setPositionEngines({});
      setLockedAgentPositions({});
      setSelectedId(null);
      setCard({ loading: false, data: null, notFound: false });
      setTurns([]);
      setTurnStream(EMPTY_TURN_STREAM);
      setSessions([]);
      setSelectedSessionId(null);
      selectedSessionIdRef.current = null;
      setTurnError(null);
      setBackups([]);
      setReports(null);
      setReportsError(null);
    }
    } catch {
      if (isCurrentRefresh()) setStartupError(t("misc.serviceFailed"));
    } finally {
      if (isCurrentRefresh()) setTreeLoading(false);
    }
  }, [loadBackups, loadReports, locale, t]);

  const refreshOrg = useCallback((workspace: unknown, version: unknown, changes: unknown) =>
    orgRefreshes.run(workspace, version, () => refresh(onlyMovesAndReorders(changes))), [orgRefreshes, refresh]);

  useEffect(() => { orgRefreshes.clear(); }, [orgRefreshes, workspaceInfo?.path]);

  const loadPosition = useCallback(async (id: string, requestedEngine?: TurnEngine) => {
    const version = selectionVersion.current;
    const read = ++positionReadVersion.current;
    setCard((prev) => ({ loading: true, data: prev.data, notFound: false }));
    setModelStates(current => ({ ...current, [id]: { loading: true } }));
    try {
    const engine = requestedEngine ?? positionEnginesRef.current[id] ?? defaultTurnEngineRef.current;
    const res = await window.owb.position(id, engine);
    if (version !== selectionVersion.current || selectedIdRef.current !== id) return;
    const body = res.body as { position?: PositionCardData; code?: string; agentEngine?: unknown; agentLocked?: unknown; modelConfig?: EmployeeModelConfig };
    const currentAvailability = read === positionReadVersion.current;
    if (currentAvailability) {
      setModelStates(current => ({ ...current, [id]: res.status === 200 ? {} : { error: conversationCopy.modelFailed } }));
      setPositionModels(current => {
        const next = { ...current };
        if (res.status === 200 && body.modelConfig) next[id] = body.modelConfig; else delete next[id];
        return next;
      });
    }
    if (res.status === 404 || body?.code === "position_missing") {
      setCard({ loading: false, data: null, notFound: true });
      if (currentAvailability) setPositionEngines((current) => {
        const { [id]: _removed, ...rest } = current;
        return rest;
      });
      return;
    }
    if (currentAvailability && isTurnEngine(body.agentEngine)) {
      const agentEngine = body.agentEngine;
      setPositionEngines((current) => current[id] === agentEngine ? current : { ...current, [id]: agentEngine });
    }
    if (currentAvailability) setLockedAgentPositions((current) => current[id] === (body.agentLocked === true) ? current : { ...current, [id]: body.agentLocked === true });
    setCard({
      loading: false,
      data: body?.position ? normalizePositionForDisplay(body.position, locale) : null,
      notFound: false,
    });
    } catch {
      if (version !== selectionVersion.current || selectedIdRef.current !== id || read !== positionReadVersion.current) return;
      setCard({ loading: false, data: null, notFound: false });
      setModelStates(current => ({ ...current, [id]: { error: conversationCopy.modelFailed } }));
    }
  }, [locale, conversationCopy]);

  // A status check only refreshes availability. Never reload the workspace,
  // organization, sessions or drafts. Both reads commit as one scoped result.
  useEffect(() => {
    availabilityOperation.current = null;
    setCheckingAvailability(false);
    setAvailabilityCheckFailed(false);
    return () => {
      availabilityOperation.current = null;
      healthReadVersion.current += 1;
      positionReadVersion.current += 1;
    };
  }, [groupWorkspaceScope, selectedId]);

  const recheckAvailability = useCallback(async () => {
    if (availabilityOperation.current) return;
    const operation = Symbol();
    availabilityOperation.current = operation;
    const scope = latestGroupWorkspaceScope.current;
    const version = selectionVersion.current;
    const id = selectedIdRef.current;
    const healthRead = ++healthReadVersion.current;
    const positionRead = ++positionReadVersion.current;
    const isCurrent = () => availabilityOperation.current === operation
      && latestGroupWorkspaceScope.current === scope && selectionVersion.current === version
      && selectedIdRef.current === id;
    const isCurrentRead = () => isCurrent() && healthRead === healthReadVersion.current && positionRead === positionReadVersion.current;
    setCheckingAvailability(true);
    setAvailabilityCheckFailed(false);
    try {
      const [status, positionResponse] = await Promise.all([
        window.owb.status(),
        id ? window.owb.position(id, positionEnginesRef.current[id] ?? defaultTurnEngineRef.current) : undefined,
      ]);
      if (!isCurrentRead()) return;
      if (!status.running || status.health?.status !== "ok" || (id && positionResponse?.status !== 200)) throw new Error("Availability check failed");
      const body = positionResponse?.body as { modelConfig?: EmployeeModelConfig; agentEngine?: unknown } | undefined;
      if (id && body) {
        setModelStates(current => ({ ...current, [id]: {} }));
        setPositionModels(current => {
          const next = { ...current };
          // A successful legacy response without config invalidates its old cache.
          if (body.modelConfig) next[id] = body.modelConfig; else delete next[id];
          return next;
        });
        if (isTurnEngine(body.agentEngine)) {
          const engine = body.agentEngine;
          setPositionEngines(current => ({ ...current, [id]: engine }));
        }
      }
      setHealth(status.health);
    } catch {
      if (isCurrentRead()) setAvailabilityCheckFailed(true);
    } finally {
      if (availabilityOperation.current === operation) {
        availabilityOperation.current = null;
        setCheckingAvailability(false);
      }
    }
  }, []);

  const availabilityCheck = { onRecheck: recheckAvailability, checking: checkingAvailability, failed: availabilityCheckFailed };

  /** One-click Qoder login: the control plane owns the `qodercli login` child;
   * the shell only starts it and observes its state. While the login runs,
   * health is polled so the composer unblocks the moment the credential lands —
   * no manual "run qodercli login then refresh" repair loop for the operator. */
  const [qoderLogin, setQoderLogin] = useState<{ phase: "idle" | "starting" | "running"; feedback: string | null; loginUrl: string | null }>({ phase: "idle", feedback: null, loginUrl: null });
  const startQoderLogin = useCallback(async () => {
    setQoderLogin((current) => ({ ...current, phase: "starting", feedback: null }));
    try {
      const response = await window.owb.qoderLogin.start();
      const body = response.status === 200 ? response.body as QoderLoginResponse : undefined;
      if (!body) throw new Error();
      if (body.failure) {
        setQoderLogin({ phase: "idle", feedback: t("misc.qoderLoginUnavailable"), loginUrl: null });
        return;
      }
      setQoderLogin({ phase: "running", feedback: t("misc.qoderLoginRunning"), loginUrl: body.loginUrl ?? null });
    } catch {
      setQoderLogin({ phase: "idle", feedback: t("misc.qoderLoginUnavailable"), loginUrl: null });
    }
  }, [t]);

  useEffect(() => {
    if (qoderLogin.phase !== "running") return;
    let alive = true;
    const timer = setInterval(() => {
      void (async () => {
        const [loginRes, statusRes] = await Promise.all([window.owb.qoderLogin.status(), window.owb.status()]);
        if (!alive) return;
        if (statusRes.health) setHealth(statusRes.health);
        if (statusRes.health?.hosts?.qoder?.ready === true) {
          setQoderLogin({ phase: "idle", feedback: t("misc.qoderLoginSuccess"), loginUrl: null });
          return;
        }
        const login = loginRes.status === 200 ? loginRes.body as QoderLoginResponse : undefined;
        if (!login || login.running) {
          if (login?.loginUrl) {
            setQoderLogin((current) => (current.loginUrl === login.loginUrl ? current : { ...current, loginUrl: login.loginUrl ?? null }));
          }
          return;
        }
        // The child exited: read health once more because the credential write
        // can land a beat before the process exit is observed.
        const finalStatus = await window.owb.status();
        if (!alive) return;
        if (finalStatus.health) setHealth(finalStatus.health);
        setQoderLogin({
          phase: "idle",
          feedback: finalStatus.health?.hosts?.qoder?.ready === true ? t("misc.qoderLoginSuccess") : t("misc.qoderLoginFailed"),
          loginUrl: null,
        });
      })();
    }, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [qoderLogin.phase, t]);

  const loadTurnHistory = useCallback(async (id: string, sessionId = selectedSessionIdRef.current) => {
    if (selectedIdRef.current !== id || selectedSessionIdRef.current !== sessionId) return false;
    const requestVersion = ++historyRequest.current;
    setHistoryLoading(true);
    if (sessionId === null) {
      setHistoryLoading(false);
      return true;
    }
    try {
      const res = await window.owb.sessionTurnHistory(sessionId);
      if (requestVersion !== historyRequest.current || selectedIdRef.current !== id || selectedSessionIdRef.current !== sessionId) return false;
      if (res.status !== 200) {
        setTurnError(apiErrorMessage(res.body, t("turn.historyFail")));
        return false;
      }
      const history = res.body as TurnHistory;
      setTurns(adaptTurnHistory(history, positionNamesRef.current[id] ?? t("org.unknownPosition"), t("turn.unrenderableOutput")));
      setTurnError(null);
      return true;
    } catch {
      if (requestVersion === historyRequest.current && selectedIdRef.current === id && selectedSessionIdRef.current === sessionId) {
        setTurnError(t("turn.historyFailOffline"));
      }
      return false;
    } finally {
      if (requestVersion === historyRequest.current) setHistoryLoading(false);
    }
  }, [t]);

  const loadSessions = useCallback(async (id: string, preferredSessionId?: string | null, fallbackToActive = true) => {
    const version = selectionVersion.current;
    try {
      const res = await window.owb.sessions(id);
      if (version !== selectionVersion.current || selectedIdRef.current !== id) return false;
      if (res.status !== 200) {
        setSessions([]);
        setSelectedSessionId(null);
        selectedSessionIdRef.current = null;
        setTurns([]);
        setHistoryLoading(false);
        setTurnError(apiErrorMessage(res.body, t("turn.sessionsFail")));
        return false;
      }
      const list = res.body as WorkbenchSessionList;
      setSessions(list.sessions);
      const current = preferredSessionId !== undefined
        ? preferredSessionId
        : (selectedSessionIdRef.current ?? selectedSessions.current[JSON.stringify([workspacePathRef.current, id])]);
      const matched = current && list.sessions.some((session) => session.sessionId === current);
      const next = matched ? current : (fallbackToActive ? list.activeSessionId : null);
      selectedSessionIdRef.current = next;
      if (next) selectedSessions.current[JSON.stringify([workspacePathRef.current, id])] = next;
      else {
        // Stale-while-revalidate ends once this employee is known to have no
        // session; otherwise A's thread stays on B's panel (#413 review).
        setTurns([]);
        setHistoryLoading(false);
      }
      setSelectedSessionId(next);
      if (preferredSessionId && !matched && !fallbackToActive) {
        setTurnError(t("apr.sourceUnavailable"));
      } else {
        setTurnError(null);
      }
      return true;
    } catch {
      if (version === selectionVersion.current && selectedIdRef.current === id) {
        setTurns([]);
        setHistoryLoading(false);
        setTurnError(t("turn.sessionsFailOffline"));
      }
      return false;
    }
  }, [t]);

  /** #248 R2 ② 点人即聊：挂载该岗位的 active 会话，没有就自动创建，输入立即可用。
   * This is intentionally the single session-loading path for every position
   * selector. Keeping it in the selection effect avoids a race between the
   * org tree and the explicit @ selector. */
  const ensureActiveSession = useCallback(async (positionId: string) => {
    const version = selectionVersion.current;
    const operation = Symbol();
    sessionOperations.current.set(positionId, operation);
    setSessionBusyPositions((current) => ({ ...current, [positionId]: true }));
    setTurnError(null);
    try {
      const ok = await loadSessions(positionId);
      if (ok && selectedSessionIdRef.current === null) {
        const res = await window.owb.createSession({ positionId });
        if (selectionVersion.current !== version || selectedIdRef.current !== positionId) return;
        if (res.status === 201) {
          const session = res.body as WorkbenchSession;
          selectedSessions.current[JSON.stringify([workspacePathRef.current, positionId])] = session.sessionId;
          selectedSessionIdRef.current = session.sessionId;
          setSelectedSessionId(session.sessionId);
          await loadSessions(positionId);
        }
      }
    } catch {
      // Keep the direct conversation honest and disabled. Clicking the same
      // employee in the tree retries this automatic attachment; there is no
      // separate session-configuration surface to maintain.
    } finally {
      if (sessionOperations.current.get(positionId) === operation) setSessionBusyPositions((current) => ({ ...current, [positionId]: false }));
    }
  }, [loadSessions]);

  useEffect(() => {
    if (workspaceInfo?.open !== true || selectedId === null) {
      setCard({ loading: false, data: null, notFound: false });
      setTurns([]);
      setSessions([]);
      setSelectedSessionId(null);
      selectedSessionIdRef.current = null;
      setTurnError(null);
      return;
    }
    setTurnError(null);
    void loadPosition(selectedId);
    void ensureActiveSession(selectedId);
  }, [ensureActiveSession, loadPosition, selectedId, workspaceInfo?.open, workspaceInfo?.path]);

  useEffect(() => {
    if (workspaceInfo?.open === true && selectedId !== null) void loadTurnHistory(selectedId);
  }, [loadTurnHistory, selectedId, selectedSessionId, workspaceInfo?.open]);

  useEffect(() => {
    void refresh();
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const offEvent = window.owb.onEvent((event) => {
      const envelope = event as { type?: string; payload?: { workspacePath?: unknown } };
      if ((envelope.type === "approvals.changed" || ["turn.completed", "turn.failed", "turn.indeterminate"].includes(envelope.type ?? "")) &&
          (typeof envelope.payload?.workspacePath !== "string" || envelope.payload.workspacePath === workspacePathRef.current)) {
        void approvalState.refresh();
      }
      if (envelope?.type === "org.updated") {
        const payload = (event as { payload?: { workspace?: unknown; version?: unknown; changes?: unknown } }).payload;
        void refreshOrg(payload?.workspace, payload?.version, payload?.changes);
        return;
      }
      if (typeof envelope?.type === "string" && envelope.type.startsWith("turn.")) {
        const payload = (event as { payload?: { workspacePath?: unknown } }).payload;
        // Legacy unscoped events are safe only while a single owner is known.
        // The current server always attributes events to the original owner.
        const owner = typeof payload?.workspacePath === "string" ? payload.workspacePath :
          workspaceStreams.current.size <= 1 ? workspacePathRef.current : undefined;
        if (owner !== undefined) updateWorkspaceStream(owner, (current) => applyTurnEvent(current, envelope as TurnStreamEnvelope));
      }
      if (["turn.completed", "turn.failed", "turn.indeterminate"].includes(envelope?.type ?? "")) {
        void loadReports();
        const id = selectedIdRef.current;
        if (id !== null) {
          if (refreshTimer !== null) clearTimeout(refreshTimer);
          // Terminal SSE is emitted immediately before the server-owned record
          // is finalized. A short coalescing delay makes SSE a refresh hint;
          // the blocking POST readback below remains the source of truth.
          refreshTimer = setTimeout(() => void loadTurnHistory(id), 100);
        }
      }
    });
    const applySseStatus = (state: "connecting" | "connected") => {
      setSseState(state);
      // A reconnect restarts the server-side seq space; drop the replay guard
      // so new events are not suppressed by a stale high-water mark.
      if (state === "connecting") {
        orgRefreshes.clear();
        for (const path of workspaceStreams.current.keys()) updateWorkspaceStream(path, resetStreamSeq);
      } else void approvalState.refresh();
    };
    const offSse = window.owb.onSseStatus(applySseStatus);
    void window.owb.sseStatus().then(applySseStatus).catch(() => setStartupError(t("misc.serviceFailed")));
    const offFallback = window.owb.onFallbackNotice((failedPath) => {
      setFallbackNotice(failedPath);
    });
    return () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      offEvent();
      offSse();
      offFallback();
    };
  }, [approvalState.refresh, loadReports, loadTurnHistory, orgRefreshes, refresh, refreshOrg, updateWorkspaceStream]);

  const selectPosition = useCallback((id: string) => {
    if (selectedIdRef.current === id) return;
    selectionVersion.current += 1;
    historyRequest.current += 1;
    setSessionBusyPositions((current) => ({ ...current, [id]: true }));
    selectedIdRef.current = id;
    selectedSessionIdRef.current = null;
    setSelectedSessionId(null);
    setSessions([]);
    setSelectedId(id);
  }, []);

  /** #248 R2 ②：组织树点某人 = 直接打开与他的对话（一键）。 */
  const openConversation = useCallback((positionId: string) => {
    setOrgOverview(false);
    if (selectedIdRef.current === positionId) {
      void ensureActiveSession(positionId);
      return;
    }
    selectPosition(positionId);
  }, [ensureActiveSession, selectPosition]);

  const createTurn = useCallback(async (request: CreateTurnRequest) => {
    const sessionId = selectedSessionIdRef.current;
    if (sessionId === null) {
      setTurnError(t("turn.needSession"));
      return false;
    }
    const workspacePath = workspacePathRef.current;
    if (workspacePath === undefined) return false;
    const requestKey = JSON.stringify([workspacePath, request.positionId]);
    if (selectedIdRef.current !== request.positionId || inFlightPositions.current.has(requestKey)) return false;
    inFlightPositions.current.add(requestKey);
    updateWorkspaceBusy(workspacePath, request.positionId, true);
    const isSelected = () => workspacePathRef.current === workspacePath && selectedIdRef.current === request.positionId && selectedSessionIdRef.current === sessionId;
    setTurnError(null);
    updateWorkspaceStream(workspacePath, (current) =>
      beginPendingTurn(current, {
        positionId: request.positionId,
        sessionId,
        engine: request.engine,
        input: request.input,
      }),
    );
    try {
      const res = await window.owb.createSessionTurn({
        sessionId,
        engine: request.engine,
        input: request.input,
        ...(request.retryOf ? { retryOf: request.retryOf } : {}),
        ...(request.pendingApproval !== undefined
          ? { pendingApproval: request.pendingApproval }
          : {}),
        ...(request.attachmentIds !== undefined ? { attachmentIds: request.attachmentIds } : {}),
      });
      if (res.status !== 200) {
        const message = apiErrorMessage(res.body, t("turn.createFail"));
        if (isSelected()) setTurnError(message);
        updateWorkspaceStream(workspacePath, (current) => settlePendingTurn(current, { positionId: request.positionId, sessionId, runId: null }));
        return false;
      }
      const body = res.body as { engine?: unknown; runId?: unknown; turnId?: unknown };
      if (workspacePathRef.current === workspacePath && isTurnEngine(body.engine)) {
        const resolvedEngine = body.engine;
        positionBindingWrites.current[request.positionId] = (positionBindingWrites.current[request.positionId] ?? 0) + 1;
        setPositionEngines((current) => current[request.positionId] === resolvedEngine
          ? current
          : { ...current, [request.positionId]: resolvedEngine });
      }
      if (workspacePathRef.current === workspacePath) {
        setLockedAgentPositions((current) => current[request.positionId] === true ? current : { ...current, [request.positionId]: true });
      }
      if (isSelected()) {
        historyRequest.current += 1;
        const returned = adaptTurnRecord(
          res.body,
          positionNamesRef.current[request.positionId] ?? t("org.unknownPosition"),
          t("turn.unrenderableOutput"),
        );
        setTurns((current) => replaceTurn(current, returned));
      }
      updateWorkspaceStream(workspacePath, (current) =>
        settlePendingTurn(current, {
          runId: typeof body.runId === "string" ? body.runId : null,
          ...(typeof body.turnId === "string" ? { turnId: body.turnId } : {}),
          positionId: request.positionId,
          sessionId,
        }),
      );
      if (isSelected()) await loadTurnHistory(request.positionId, sessionId);
      // First use may have migrated a legacy employee's Agent binding.
      // Refresh its model catalog without turning a successful send into an error.
      if (isSelected()) void loadPosition(request.positionId).catch(() => {});
      return true;
    } catch {
      updateWorkspaceStream(workspacePath, (current) => settlePendingTurn(current, { positionId: request.positionId, sessionId, runId: null }));
      if (isSelected()) setTurnError(t("turn.createFailOffline"));
      return false;
    } finally {
      inFlightPositions.current.delete(requestKey);
      updateWorkspaceBusy(workspacePath, request.positionId, false);
    }
  }, [loadPosition, loadTurnHistory, t, updateWorkspaceBusy, updateWorkspaceStream]);

  const setSessionContext = useCallback(async (sessionId: string, enabled: boolean) => {
    const positionId = selectedIdRef.current;
    if (positionId === null) return;
    const version = selectionVersion.current;
    const operation = Symbol();
    sessionOperations.current.set(positionId, operation);
    setSessionBusyPositions((current) => ({ ...current, [positionId]: true }));
    try {
      const res = await window.owb.sessionSetContext({ sessionId, enabled });
      if (version !== selectionVersion.current || selectedSessionIdRef.current !== sessionId) return;
      if (res.status !== 200) { setTurnError(apiErrorMessage(res.body, t("turn.contextUpdateFail"))); return; }
      setSessions((current) => current.map((session) => session.sessionId === sessionId ? res.body as WorkbenchSession : session));
      setTurnError(null);
    } catch {
      if (version === selectionVersion.current) setTurnError(t("turn.contextUpdateFail"));
    } finally {
      if (sessionOperations.current.get(positionId) === operation) setSessionBusyPositions((current) => ({ ...current, [positionId]: false }));
    }
  }, [t]);

  /** #305 Restart the conversation: rotate the attached active session into
   * history and attach its successor. The old thread stays readable in the
   * session-history popover; a failure keeps the current session selected. */
  const rotateActiveSession = useCallback(async (sessionId: string) => {
    const positionId = selectedIdRef.current;
    if (positionId === null) return;
    const version = selectionVersion.current;
    const operation = Symbol();
    sessionOperations.current.set(positionId, operation);
    setSessionBusyPositions((current) => ({ ...current, [positionId]: true }));
    try {
      const res = await window.owb.rotateSession(sessionId);
      if (version !== selectionVersion.current || selectedIdRef.current !== positionId) return;
      if (res.status !== 200 && res.status !== 201) { setTurnError(apiErrorMessage(res.body, t("turn.rotateFail"))); return; }
      const session = res.body as WorkbenchSession;
      selectedSessions.current[JSON.stringify([workspacePathRef.current, positionId])] = session.sessionId;
      selectedSessionIdRef.current = session.sessionId;
      setSelectedSessionId(session.sessionId);
      await loadSessions(positionId);
      setTurnError(null);
    } catch {
      if (version === selectionVersion.current && selectedIdRef.current === positionId) setTurnError(t("turn.rotateFailOffline"));
    } finally {
      if (sessionOperations.current.get(positionId) === operation) setSessionBusyPositions((current) => ({ ...current, [positionId]: false }));
    }
  }, [loadSessions, t]);

  const changeEmployeeModel = useCallback(async (model: string) => {
    const id = selectedIdRef.current;
    const workspace = workspacePathRef.current;
    const scope = latestGroupWorkspaceScope.current;
    if (!id || !window.owb.setPositionModel) return;
    const operationKey = JSON.stringify([workspace, id]);
    if (modelSaveOperations.current.has(operationKey)) return;
    modelSaveOperations.current.add(operationKey);
    positionReadVersion.current += 1;
    setModelSavingIds(current => ({ ...current, [operationKey]: true }));
    setModelStates(current => ({ ...current, [id]: {} }));
    const engine = positionEnginesRef.current[id] ?? defaultTurnEngineRef.current;
    try {
      const response = await window.owb.setPositionModel({
        positionId: id,
        model,
        engine,
      });
      if (workspacePathRef.current !== workspace || latestGroupWorkspaceScope.current !== scope) return;
      if (response.status !== 200) { setModelStates(current => ({ ...current, [id]: { error: t("model.saveFailed") } })); return; }
      positionBindingWrites.current[id] = (positionBindingWrites.current[id] ?? 0) + 1;
      setPositionEngines((current) => ({ ...current, [id]: engine }));
      setLockedAgentPositions((current) => ({ ...current, [id]: true }));
      setPositionModels((current) => ({ ...current, [id]: response.body }));
      setModelStates(current => ({ ...current, [id]: { notice: conversationCopy.modelSaved } }));
      setTurnError(null);
    } catch {
      if (workspacePathRef.current === workspace && latestGroupWorkspaceScope.current === scope) setModelStates(current => ({ ...current, [id]: { error: t("model.saveFailed") } }));
    } finally {
      // A check started during this save may have read the previous model.
      if (workspacePathRef.current === workspace && latestGroupWorkspaceScope.current === scope && selectedIdRef.current === id) positionReadVersion.current += 1;
      modelSaveOperations.current.delete(operationKey);
      setModelSavingIds(current => ({ ...current, [operationKey]: false }));
    }
  }, [conversationCopy, t]);

  const changeEmployeeAgentEngine = useCallback(async (engine: TurnEngine) => {
    const id = selectedIdRef.current;
    const workspace = workspacePathRef.current;
    const scope = latestGroupWorkspaceScope.current;
    if (!id || !window.owb.setPositionAgentEngine || engineSavingId !== null) return;
    positionReadVersion.current += 1;
    setEngineSavingId(id);
    try {
      const response = await window.owb.setPositionAgentEngine({ positionId: id, engine });
      if (workspacePathRef.current !== workspace || latestGroupWorkspaceScope.current !== scope) return;
      if (response.status !== 200) { setTurnError(apiErrorMessage(response.body, t("turn.createFail"))); return; }
      positionBindingWrites.current[id] = (positionBindingWrites.current[id] ?? 0) + 1;
      setPositionEngines((current) => ({ ...current, [id]: response.body.agentEngine }));
      setLockedAgentPositions((current) => ({ ...current, [id]: true }));
      setPositionModels((current) => ({ ...current, [id]: response.body.modelConfig }));
      setTurnError(null);
    } catch {
      if (workspacePathRef.current === workspace && latestGroupWorkspaceScope.current === scope) setTurnError(t("turn.createFailOffline"));
    } finally {
      if (workspacePathRef.current === workspace && latestGroupWorkspaceScope.current === scope && selectedIdRef.current === id) positionReadVersion.current += 1;
      setEngineSavingId(null);
    }
  }, [engineSavingId, t]);

  /** Group spawn (#52): the 202 spawn list carries pre-assigned turnIds; seed
   * one live buffer per mentioned member so SSE deltas aggregate per member. */
  const spawnGroupRuns = useCallback(
    (
      groupRef: string,
      messageId: string,
      spawns: Array<{ turnId: string; positionId: string; engine?: TurnEngine }>,
      input: string,
      engine: TurnEngine,
    ) => {
      if (latestGroupWorkspaceScope.current !== groupWorkspaceScope) return;
      const path = workspacePathRef.current;
      if (path === undefined) return;
      updateWorkspaceStream(path, (current) => latestGroupWorkspaceScope.current !== groupWorkspaceScope ? current :
        spawns.reduce(
          (state, spawn) =>
            beginGroupRun(state, {
              groupRef,
              messageId,
              turnId: spawn.turnId,
              positionId: spawn.positionId,
              engine: spawn.engine ?? engine,
              input,
            }),
          current,
        ),
      );
    },
    [groupWorkspaceScope, updateWorkspaceStream],
  );

  const reconcileGroup = useCallback((timeline: GroupTimeline) => {
    if (latestGroupWorkspaceScope.current !== groupWorkspaceScope) return;
    const path = workspacePathRef.current;
    if (path !== undefined) updateWorkspaceStream(path, (current) => latestGroupWorkspaceScope.current === groupWorkspaceScope ? reconcileGroupTimeline(current, timeline) : current);
  }, [groupWorkspaceScope, updateWorkspaceStream]);

  /** Operator cancel (issue #25 Slice A): the control plane settles the turn
   * as indeterminate/turn_cancelled; the in-flight POST readback and the
   * history reload remain the only authorities for the final record. */
  const cancelTurn = useCallback(async (positionId: string) => {
    const workspacePath = workspacePathRef.current;
    if (workspacePath === undefined) return;
    const stream = workspaceStreams.current.get(workspacePath);
    const pending = stream?.pending[positionId];
    const running = Object.values(stream?.runs ?? {}).find((run) => run.positionId === positionId && run.sessionId === selectedSessionIdRef.current && run.groupRef === undefined);
    const turnId = pending?.turnId ?? running?.turnId;
    const key = JSON.stringify([workspacePath, positionId]);
    const operation = Symbol();
    cancelOperations.current.set(key, operation);
    updateWorkspaceCancelling(workspacePath, positionId, true);
    const isSelected = () => workspacePathRef.current === workspacePath && selectedIdRef.current === positionId;
    setTurnError(null);
    try {
      const res = await window.owb.cancelTurn({ positionId, workspacePath, ...(turnId ? { turnId } : {}) });
      if (res.status !== 200 && isSelected()) setTurnError(apiErrorMessage(res.body, t("turn.cancelRejected")));
      return res.status === 200;
    } catch {
      if (isSelected()) setTurnError(t("turn.cancelFailOffline"));
      return false;
    } finally {
      if (cancelOperations.current.get(key) === operation) {
        cancelOperations.current.delete(key);
        updateWorkspaceCancelling(workspacePath, positionId, false);
      }
    }
  }, [t, updateWorkspaceCancelling]);

  /** Both approval entry points use the same durable server-owned decision. */
  const verdictTurn = useCallback(
    async (turn: TurnRecord, decision: "granted" | "denied", reason?: string, scope: "once" | "run" = "once") => {
      const approval = approvalState.items.find(a => a.source.turnId === turn.id && a.source.positionId === turn.positionId && a.approvalId === turn.approvalRequest?.approvalId);
      if (approval) await approvalState.decide(approval.id, decision, reason, scope);
    },
    [approvalState.items, approvalState.decide],
  );

  const openApprovalSource = useCallback((item: ApprovalQueueItem) => {
    const source = item.source;
    if (!source || source.kind !== "session") return;
    const workspacePath = workspacePathRef.current;
    if (!workspacePath) return;
    const key = JSON.stringify([workspacePath, source.positionId]);
    setOrgOverview(false);
    selectionVersion.current += 1;
    historyRequest.current += 1;
    selectedIdRef.current = source.positionId;
    selectedSessionIdRef.current = source.conversationId;
    selectedSessions.current[key] = source.conversationId;
    setSelectedId(source.positionId);
    setSelectedSessionId(source.conversationId);
    setSessions([]);
    setTurns([]);
    setActiveModule("org");
    void loadSessions(source.positionId, source.conversationId, false);
  }, [loadSessions, setActiveModule]);

  const openApprovalEvidence = useCallback((item: ApprovalQueueItem) => {
    setReportsFocusTurnId(item.executionTurnId ?? item.source?.turnId ?? null);
    setActiveModule("reports");
    void loadReports();
  }, [loadReports, setActiveModule]);

  const openWorkspace = useCallback(async () => {
    if (workspaceOpening) return;
    setWorkspaceOpening(true);
    setWorkspaceOpenError(null);
    setWorkspaceOpenCandidatePath(null);
    try {
      const response = await window.owb.openWorkspace();
      if ("canceled" in response && response.canceled === true) {
        setProjectHubOpen(false);
        setWorkspaceOpenCandidatePath(null);
        // A native picker cancel does not change the workspace, but keeping
        // the existing refresh preserves the same read-after-picker contract
        // used by workspace switches and catches an external change made
        // while the picker was open.
        await refresh();
        return;
      }
      if (response.status !== 200) {
        setWorkspaceOpenError(apiErrorMessage(response.body, t("project.openFailed")));
        setWorkspaceOpenCandidatePath(typeof response.workspacePath === "string" ? response.workspacePath : null);
        return;
      }
      const opened = response.body as WorkspaceInfoResponse | null;
      if (opened?.open === true) setWorkspaceInfo(opened);
      setWorkspaceOpenCandidatePath(null);
      setTreeLoading(true);
      await refresh();
      setProjectHubOpen(false);
      setActiveModule("org");
      setOrgFeedback({
        tone: "info",
        text: t("project.opened", { name: opened?.business ?? opened?.path ?? t("project.localOnly") }),
      });
    } catch {
      setWorkspaceOpenError(t("project.openOffline"));
    } finally {
      setWorkspaceOpening(false);
    }
  }, [refresh, setActiveModule, t, workspaceOpening]);

  const onProjectCreated = useCallback(async (created: WorkspaceCreateResponse) => {
    setActiveModule("org");
    await refresh();
    // A new project starts with the platform-owned root owner selected, so
    // the next click on “创建员工” already has a concrete parent.
    if (created.owner) {
      selectedIdRef.current = created.owner;
      setSelectedId(created.owner);
    }
    setOrgFeedback({ tone: "info", text: t("project.created", { name: created.business ?? "" }) });
  }, [refresh, t]);

  const applyOrg = useCallback(async (manifest: ChangeManifest, successMessage: string) => {
    const workspace = workspacePathRef.current;
    setOrgBusy(true);
    setOrgFeedback(null);
    try {
      const response = await window.owb.orgApply(manifest);
      if (response.status !== 200) {
        setOrgFeedback({ tone: "warn", text: apiErrorMessage(response.body, t("org.applyRejected")) });
        return false;
      }
      setOrgFeedback({ tone: "info", text: successMessage });
      await refreshOrg(workspace, (response.body as { version?: unknown }).version, manifest.changes);
      return true;
    } catch {
      setOrgFeedback({ tone: "warn", text: t("org.applyUncertain") });
      return false;
    } finally {
      setOrgBusy(false);
    }
  }, [refreshOrg, t]);

  const movePosition = useCallback(async (id: string, reportTo: string | null) => {
    if (!snapshot) return false;
    if (id === snapshot.owner) {
      setOrgFeedback({ tone: "warn", text: t("org.ownerImmovable") });
      return false;
    }
    const source = findNodeById(snapshot.tree, id);
    if (!source) {
      setOrgFeedback({ tone: "warn", text: t("org.stalePosition") });
      return false;
    }
    if (source.reportTo === reportTo) {
      setOrgFeedback({ tone: "info", text: t("org.noMoveChange") });
      return false;
    }
    if (reportTo === id || (reportTo !== null && containsNode(source, reportTo))) {
      setOrgFeedback({ tone: "warn", text: t("org.cycleDenied") });
      return false;
    }
    return applyOrg(
      { schemaVersion: "change-manifest.v1", changes: [{ op: "move", id, reportTo }] },
      t("org.movedTo", {
        name: positionNames[id] ?? t("org.unknownPosition"),
        target: reportTo ? positionNames[reportTo] ?? t("org.unknownPosition") : t("org.enterpriseRoot"),
      }),
    );
  }, [applyOrg, positionNames, snapshot, t]);

  /** #33: hire is the only creation channel; success linkage = refresh + select the new node. */
  const hiredPosition = useCallback(async (positionId: string, name: string, avatar?: string) => {
    if (avatar !== undefined) setPositionAvatar(positionId, avatar);
    setOrgFeedback({ tone: "info", text: t("org.hired", { name }) });
    await refresh();
    selectPosition(positionId);
  }, [refresh, selectPosition, setPositionAvatar, t]);

  const dismissPosition = useCallback(async (id: string) =>
    applyOrg({ schemaVersion: "change-manifest.v1", changes: [{ op: "delete", id }] }, t("org.dismissed")), [applyOrg, t]);

  /**
   * #292: save an edited employee record.
   *
   * A rename is an org-model change, not just a card change — the engine
   * rebuilds `.digital-employee/org.json` from the edited package and the tree
   * labels follow it. So this refreshes the org the same way a hire does, then
   * re-reads the card; reloading only the card would leave the tree showing the
   * old name until the next unrelated refresh.
   */
  const saveEmployeeProfile = useCallback(async (patch: PositionProfilePatch, targetId?: string) => {
    const id = targetId ?? selectedIdRef.current;
    const workspace = workspacePathRef.current;
    if (!id || !window.owb.updatePositionProfile) return { ok: false as const, code: "control_plane_unreachable" };
    try {
      const response = await window.owb.updatePositionProfile({ positionId: id, ...patch });
      // Discard an answer that belonged to a previous workspace selection.
      if (workspacePathRef.current !== workspace) return { ok: false as const, code: "control_plane_unreachable" };
      const body = response.body as PositionProfileResult & { code?: string };
      if (response.status !== 200 || body.status !== "updated") {
        return { ok: false as const, code: typeof body.code === "string" ? body.code : "internal" };
      }
      setOrgFeedback({ tone: "info", text: t("org.profileUpdated", { name: body.name }) });
      await refresh();
      // loadPosition aborts (and blanks the card) for a non-selected id, so only
      // the selected record's card is re-read; the tree labels follow refresh().
      if (selectedIdRef.current === id) await loadPosition(id);
      return { ok: true as const, name: body.name };
    } catch {
      return { ok: false as const, code: "control_plane_unreachable" };
    }
  }, [loadPosition, refresh, t]);

  /** Same-level insertion from an insertion-line drop or ⌘↑/⌘↓ (#32): the
   * reorder op carries the final sibling order; a cross-parent insertion is
   * submitted atomically as move + reorder in one manifest. */
  const reorderPosition = useCallback(async (drop: OrgDropPosition) => {
    if (!snapshot) return false;
    const source = findNodeById(snapshot.tree, drop.id);
    if (!source) {
      setOrgFeedback({ tone: "warn", text: t("org.stalePosition") });
      return false;
    }
    if (source.reportTo === drop.parentId) {
      const current = source.reportTo === null
        ? snapshot.tree.map((node) => node.id)
        : findNodeById(snapshot.tree, source.reportTo)?.children.map((node) => node.id) ?? [];
      if (current.join("\u0000") === drop.order.join("\u0000")) {
        setOrgFeedback({ tone: "info", text: t("org.noOrderChange") });
        return false;
      }
      return applyOrg(
        { schemaVersion: "change-manifest.v1", changes: [{ op: "reorder", parentId: drop.parentId, order: drop.order }] },
        t("org.reordered", { name: positionNames[drop.id] ?? t("org.unknownPosition") }),
      );
    }
    return applyOrg(
      {
        schemaVersion: "change-manifest.v1",
        changes: [
          { op: "move", id: drop.id, reportTo: drop.parentId },
          { op: "reorder", parentId: drop.parentId, order: drop.order },
        ],
      },
      t("org.movedTo", {
        name: positionNames[drop.id] ?? t("org.unknownPosition"),
        target: drop.parentId ? positionNames[drop.parentId] ?? t("org.unknownPosition") : t("org.enterpriseRoot"),
      }),
    );
  }, [applyOrg, positionNames, snapshot, t]);

  /** Single-step undo of the last drag adjustment (#32 AC-005). Structural
   * add/delete restores stay with BackupTray; 404 means nothing is undoable. */
  const undoLastAdjustment = useCallback(async () => {
    setOrgBusy(true);
    setOrgFeedback(null);
    try {
      const response = await window.owb.orgUndo();
      if (response.status === 404) {
        setOrgFeedback({ tone: "info", text: t("org.nothingToUndo") });
        return false;
      }
      if (response.status !== 200) {
        setOrgFeedback({ tone: "warn", text: apiErrorMessage(response.body, t("org.undoRejected")) });
        return false;
      }
      setOrgFeedback({ tone: "info", text: t("org.undone") });
      await refresh();
      return true;
    } catch {
      setOrgFeedback({ tone: "warn", text: t("org.undoUncertain") });
      return false;
    } finally {
      setOrgBusy(false);
    }
  }, [refresh, t]);

  const restorePosition = useCallback(async (backupId: string) => {
    setOrgBusy(true);
    setOrgFeedback(null);
    try {
      const response = await window.owb.orgRestore(backupId);
      if (response.status !== 200) {
        setOrgFeedback({ tone: "warn", text: apiErrorMessage(response.body, t("org.restoreRejected")) });
        return false;
      }
      const body = response.body as { restored: boolean };
      setOrgFeedback({ tone: "info", text: body.restored ? t("org.restored") : t("org.alreadyRestored") });
      await refresh();
      return true;
    } catch {
      setOrgFeedback({ tone: "warn", text: t("org.restoreUncertain") });
      return false;
    } finally {
      setOrgBusy(false);
    }
  }, [refresh, t]);

  const engineOk = health?.engine?.available === true;
  /** The frozen org-tree.v1 carries ids/budgets only; display names and modes
   * arrive via the selected position card (/positions/:id). */
  const selectedPosition = card.data;
  const positions = useMemo<PositionMentionOption[]>(() => {
    if (!snapshot) return [];
    return flattenPositionIds(snapshot.tree).map((id) => ({ id, name: positionNames[id] ?? t("org.unknownPosition") }));
  }, [positionNames, snapshot, t]);
  const hireConversationHostId = treeHireParent ?? snapshot?.owner ?? positions[0]?.id ?? null;
  const hireBudgetAllocatedTokens = useMemo(
    () => reports?.budgets.reduce((total, budget) => total + (budget.declared.perDay.tokens ?? 0), 0) ?? 0,
    [reports],
  );
  const selectedNode = selectedId && snapshot ? findNodeById(snapshot.tree, selectedId) : null;
  /** Position ids with a turn in flight — drives the tree/card status lights
   * (#73 signature move ②). Observed from the SSE run stream only; a position
   * with no live run is never shown as running. */
  const runningPositionIds = useMemo(() => {
    const ids = new Set(Object.keys(busyPositions).filter((id) => busyPositions[id]));
    for (const run of Object.values(turnStream.runs)) {
      if (run.positionId) ids.add(run.positionId);
    }
    return ids;
  }, [busyPositions, turnStream.runs]);

  const engineAvailability = useMemo(() => ({
    qoder: {
      configured: health?.hosts?.qoder.configured === true,
      ready: health?.hosts?.qoder.ready === true,
      reason: health?.hosts?.qoder.nextStep ?? t("misc.qoderHostUnknown"),
      modelPinnable: health?.hosts?.qoder.modelPinnable,
      model: health?.hosts?.qoder.model,
      connection: health?.hosts?.qoder.connection,
      loginRequired: health?.hosts?.qoder.loginRequired === true,
    },
    "claude-code": {
      configured: health?.hosts?.["claude-code"].configured === true,
      ready: health?.hosts?.["claude-code"].ready === true,
      reason: health?.hosts?.["claude-code"].nextStep ?? t("misc.claudeHostUnknown"),
      modelPinnable: health?.hosts?.["claude-code"].modelPinnable,
      model: health?.hosts?.["claude-code"].model,
      connection: health?.hosts?.["claude-code"].connection,
    },
    "claude-local": {
      configured: health?.hosts?.["claude-local"]?.configured === true,
      ready: health?.hosts?.["claude-local"]?.ready === true,
      // The local executable is an implementation detail of Claude Code,
      // not a second user-facing Agent or authentication mode.
      reason: health?.hosts?.["claude-local"]?.nextStep ?? t("misc.claudeHostUnknown"),
      modelPinnable: health?.hosts?.["claude-local"]?.modelPinnable,
      model: health?.hosts?.["claude-local"]?.model,
      connection: health?.hosts?.["claude-local"]?.connection,
    },
    codex: {
      configured: health?.hosts?.codex?.configured === true,
      ready: health?.hosts?.codex?.ready === true,
      reason: health?.hosts?.codex?.nextStep ?? t("misc.codexHostUnknown"),
      modelPinnable: health?.hosts?.codex?.modelPinnable,
      model: health?.hosts?.codex?.model,
    },
    "codex-local": {
      configured: health?.hosts?.["codex-local"]?.configured === true,
      ready: health?.hosts?.["codex-local"]?.ready === true,
      // Keep the same product-level language as the hosted runtime.
      reason: health?.hosts?.["codex-local"]?.nextStep ?? t("misc.codexHostUnknown"),
      modelPinnable: health?.hosts?.["codex-local"]?.modelPinnable,
      model: health?.hosts?.["codex-local"]?.model,
    },
    workbuddy: {
      configured: health?.hosts?.workbuddy?.configured === true,
      ready: health?.hosts?.workbuddy?.ready === true,
      reason: health?.hosts?.workbuddy?.nextStep ?? t("misc.workbuddyHostUnknown"),
      modelPinnable: health?.hosts?.workbuddy?.modelPinnable,
      model: health?.hosts?.workbuddy?.model,
    },
    gemini: {
      configured: health?.hosts?.gemini?.configured === true,
      ready: health?.hosts?.gemini?.ready === true,
      reason: health?.hosts?.gemini?.nextStep ?? t("misc.geminiHostUnknown"),
      modelPinnable: health?.hosts?.gemini?.modelPinnable,
      model: health?.hosts?.gemini?.model,
    },
  }), [health, t]);

  /** Login repair surface for the composer notice: offered only while the
   * bundled Qoder Host says the missing login is its sole blocker. */
  const qoderLoginSurface = health?.hosts?.qoder.loginRequired === true && health?.hosts?.qoder.ready !== true
    ? {
      action: {
        label: qoderLogin.phase === "running" ? t("misc.qoderLoginRunning") : t("misc.qoderLogin"),
        busy: qoderLogin.phase !== "idle",
        onClick: () => void startQoderLogin(),
      },
      feedback: qoderLogin.feedback,
      ...(qoderLogin.loginUrl !== null
        ? {
          link: {
            label: t("misc.qoderLoginOpenBrowser"),
            onClick: () => { void window.owb.openExternalUrl?.(qoderLogin.loginUrl as string); },
          },
        }
        : {}),
    }
    : undefined;

  /** A visible conversation has exactly one employee-selected runtime. For
   * legacy employees this supplies the first request used by the server to
   * create their one-time binding. */
  const defaultTurnEngine = resolveAgentEngine(defaultAgentHost(engineAvailability), engineAvailability);
  defaultTurnEngineRef.current = defaultTurnEngine;
  const engineForPosition = useCallback(
    (positionId: string): TurnEngine => positionEngines[positionId] ?? defaultTurnEngine,
    [defaultTurnEngine, positionEngines],
  );
  const engineLabel = useEngineLabel();

  const displayTurns = useMemo(() => {
    const historyRunIds = new Set(turns.flatMap((turn) => (turn.runId ? [turn.runId] : [])));
    const live: TurnRecord[] = selectedId === null
      ? []
      : Object.entries(turnStream.runs)
          .filter(([runId, run]) => run.groupRef === undefined && run.positionId === selectedId && run.sessionId === selectedSessionId && !historyRunIds.has(run.engineRunId ?? runId))
          .map(([runId, run]) => ({
            id: `live-${runId}`,
            provisional: true,
            positionId: run.positionId,
            positionName: positionNames[run.positionId] ?? t("org.unknownPosition"),
            engine: run.engine,
            input: run.input,
            status: "running" as const,
            createdAt: run.startedAt,
            ...(run.text !== "" ? { output: run.text } : {}),
            ...(run.totalTokens !== null ? { totalTokens: run.totalTokens } : {}),
          }));
    const pending = selectedId === null ? undefined : turnStream.pending[selectedId];
    if (pending?.sessionId === selectedSessionId && live.length === 0 &&
        (pending.runId === null || !historyRunIds.has(pending.runId))) {
      live.push({ id: `pending-${pending.sessionId}`, provisional: true, positionId: pending.positionId,
        positionName: positionNames[pending.positionId] ?? t("org.unknownPosition"), engine: pending.engine,
        input: pending.input, status: "running", createdAt: pending.startedAt });
    }
    return [...turns, ...live].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(turn => {
      if (!turn.approvalRequest) return turn;
      const a = approvalState.items.find(a => a.source.turnId === turn.id && a.source.positionId === turn.positionId && a.approvalId === turn.approvalRequest?.approvalId);
      return { ...turn, approvalControl: { disabled: !a?.canDecide || approvalState.busy.has(a.id),
        status: a?.status, phase: a?.execution.phase, error: a ? approvalState.errors[a.id] : approvalState.error,
        unavailableReason: a?.unavailableReason } };
    });
  }, [positionNames, selectedId, selectedSessionId, t, turnStream.pending, turnStream.runs, turns, approvalState.items, approvalState.busy, approvalState.errors, approvalState.error]);

  // The shared provider derives both AntD and custom-component values from the
  // selected profile. <html data-ui-theme> is seeded before React renders.
  const treeAction = (id: string | null, action: TreeAction) => {
    if (action === "edit") { if (id) setEditTargetId(id); return; }
    if (action === "settings") { setManagementTarget(id); return; }
    if (action === "switch") { setProjectHubOpen(true); return; }
    if (action === "hire") { setTreeHireParent(id ?? snapshot?.owner ?? null); return; }
    if (action === "group") { setGroupDraftSeed({ members: id ? [id] : [], nonce: Date.now(), scope: groupWorkspaceScope }); setActiveModule("groups"); return; }
    if (id) openConversation(id);
    if (action === "memory") { setMemorySource(id ? "docs" : "shared"); setActiveModule("docs"); }
    else setActiveModule("org");
  };
  const managedNode = typeof managementTarget === "string" && snapshot ? findNodeById(snapshot.tree, managementTarget) : null;

  // ADR-0002 / #246: Ant Design consumes the same semantic skin as the custom
  // layout, including the user's own colours. The two providers are not rivals:
  // `DSProvider` owns `mode` (and therefore the algorithm) plus the selected
  // design-system profile, and this nested `ConfigProvider` layers the resolved
  // palette on top as token overrides — exactly the nesting main already uses for
  // the "mint" profile below, just driven by a full token set instead of one key.
  // Keeping `algorithm` out of this layer leaves a single owner for light/dark.
  // Same activation rule as the CSS side in theme-context: the palette only
  // layers over AntD once the user departs from the shipped defaults, so an
  // untouched install keeps the profile-derived seed values it had before this
  // PR and keeps the `mint` colourPrimary override meaningful.
  const paletteActive = themeContext.custom !== null || themeContext.presetId !== DEFAULT_PRESET_ID;
  const antdToken = useMemo(() => ({
    ...(paletteActive ? themeToAntdSeed(themeContext.effective, themeContext.mode) : {}),
    fontSize: 13,
    borderRadius: 8,
    motionDurationFast: "0.12s",
    motionDurationMid: "0.16s",
    motionDurationSlow: "0.24s",
    motionEaseInOut: "cubic-bezier(0.22, 0.61, 0.36, 1)",
    motionEaseOut: "cubic-bezier(0.22, 0.61, 0.36, 1)",
    controlHeight: 32,
    controlHeightSM: 26,
    controlHeightLG: 36,
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
    // #285 expanded the mint palette to hover / active / disabled keys. Keep the
    // whole set here so the unification survives the palette layer: it only
    // displaces these values once the user actually departs from the defaults.
    ...(paletteActive ? {} : themeProfile === "mint" ? {
      colorPrimary: themeMode === "dark" ? "#64bca2" : "#287b64",
      colorPrimaryHover: themeMode === "dark" ? "#78c9b0" : "#236d58",
      colorPrimaryActive: themeMode === "dark" ? "#64bca2" : "#236d58",
      colorTextLightSolid: themeMode === "dark" ? "#14151b" : "#ffffff",
      colorTextDisabled: themeMode === "dark" ? "#90a098" : "#5e6b65",
    } : {}),
  }), [themeContext.effective, themeContext.mode, themeContext.custom, themeContext.presetId, paletteActive, themeMode, themeProfile]);

  return (
    <DSProvider mode={themeMode} profile={themeProfile}>
    <ConfigProvider locale={locale === "en" ? enUS : zhCN} button={{ autoInsertSpace: false }} modal={{ centered: true }}
      theme={{ token: antdToken }}>
    <div className={`owb-app${railExpanded ? " is-rail-expanded" : ""}${activeModule === "org" && conversationFocused && !orgOverview ? " is-conversation-focused" : ""}`}>
      {typeof managementTarget === "string" && managedNode ? <EmployeeSettings key={`${workspaceInfo?.path}:${managementTarget}`} id={managementTarget} positions={positions}
        targets={positions.filter((p) => p.id !== managedNode.id && !containsNode(managedNode, p.id))} isOwner={managementTarget === snapshot?.owner} descendantCount={countDescendants(managedNode)}
        avatar={positionAvatars[managementTarget]}
        busy={orgBusy || runningPositionIds.has(managementTarget)} onClose={() => setManagementTarget(undefined)} onMove={movePosition} onDismiss={dismissPosition}
        onMemory={() => { treeAction(managementTarget, "memory"); setManagementTarget(undefined); }}
        onSaved={() => { if (selectedIdRef.current === managementTarget) void loadPosition(managementTarget); }} onAvatarChange={(value) => setPositionAvatar(managementTarget, value)} /> : null}
      {managementTarget === null && workspaceInfo?.open ? <ProjectSettings workspace={workspaceInfo} onClose={() => setManagementTarget(undefined)}
        onMemory={() => { treeAction(null, "memory"); setManagementTarget(undefined); }} onCollaborate={() => { treeAction(null, "group"); setManagementTarget(undefined); }}
        onSwitch={() => { setManagementTarget(undefined); setProjectHubOpen(true); }} /> : null}
      {/* 自定义 40px 标题栏（设计稿 .wintitle）：品牌标 + 窗口点 + 引擎/工作区
          状态 chip。状态灯诚实映射 /health，不假装在线。 */}
      <header
        className="owb-wintitle"
        onDoubleClick={() => void window.owb.windowToggleMaximize?.()}
      >
        {/* #248 小 UI 单①：左上只保留三个窗口控制钮，删品牌标；头像将来放右上，现在不加。 */}
        <WindowControls />
        <span className="owb-wintitle__name">RoleWeave</span>
        <span className="owb-wintitle__spacer" />
        <PrefsMenu
          locale={locale}
          onChangeLocale={onChangeLocale}
          mode={themeMode}
          profile={themeProfile}
        />
      </header>

    {/* 壳层尺寸（导轨 54 / 侧栏 300 / topbar 48）定在 app.css 的
        `.owb-app .ui-app-shell` 里，不走内联 style——内联优先级最高，会把
        窗口缩放的 @media 断点全部盖掉。 */}
    <AppShell
      moduleRail={
        <ModuleRail
          label={t("misc.modules")}
          items={[
            { id: "org", label: t("rail.org"), icon: <Network aria-hidden="true" size={16} />, active: activeModule === "org", onSelect: () => setActiveModule("org") },
            { id: "groups", label: t("rail.groups"), icon: <UsersRound aria-hidden="true" size={16} />, active: activeModule === "groups", onSelect: () => setActiveModule("groups") },
            // 2026-09-17 设计评审排序：审批是待办（带角标、卡着员工干活），
            // 排在只读的上报中心前面；记忆/目标/设置按频率沉底。
            {
              id: "approvals",
              label: t("rail.approvals"),
              icon: (
                <Badge
                  count={approvalItems.filter((a) => a.decision.kind === "pending").length}
                  size="small"
                  showZero={false}
                  offset={[6, -2]}
                  color="var(--ui-primary)"
                >
                  <ClipboardCheck aria-hidden="true" size={16} />
                </Badge>
              ),
              active: activeModule === "approvals",
              onSelect: () => { setActiveModule("approvals"); void approvalState.refresh(); },
            },
            { id: "reports", label: t("rail.reports"), icon: <ChartColumn aria-hidden="true" size={16} />, active: activeModule === "reports", onSelect: () => { setReportsFocusTurnId(null); setActiveModule("reports"); void loadReports(); } },
            // mem and position documents are two sources in one employee-memory
            // surface. Keep one entry here so the user does not have to choose
            // between two implementation-owned data planes.
            { id: "docs", label: t("rail.memory"), icon: <Brain aria-hidden="true" size={16} />, active: activeModule === "docs", onSelect: () => { setMemorySource("docs"); setActiveModule("docs"); } },
            // #134: the update pane needs room for a version, live progress and
            // a changelog link, so it is a module rather than a third row in
            // the prefs drawer (#174), which stays two quick toggles.
            { id: "goals", label: t("rail.goals"), icon: <Flag aria-hidden="true" size={16} />, active: activeModule === "goals", onSelect: () => setActiveModule("goals") },
            { id: "settings", label: t("rail.settings"), icon: <Settings aria-hidden="true" size={16} />, active: activeModule === "settings", onSelect: () => setActiveModule("settings") },
          ]}
          footer={
            /* 导轨宽窄开关：Pro Layout 式圆形浮 chip，骑在导轨与侧栏的缝上、
               贴在导轨底部（左下角位置）；箭头 glyph 随状态旋转 180°。
               ⌘B 同效。 */
            <button
              type="button"
              className={`owb-rail-chip${railChipDragging ? " is-dragging" : ""}`}
              aria-label={railExpanded ? t("rail.collapse") : t("rail.expand")}
              title={`${railExpanded ? t("rail.collapse") : t("rail.expand")} · ${t("rail.reposition")}`}
              aria-expanded={railExpanded}
              aria-keyshortcuts="ArrowUp ArrowDown Home End"
              data-rail-chip-bottom={railChipBottom}
              style={{ "--owb-rail-chip-bottom": `${railChipBottom}px` } as CSSProperties}
              onClick={onRailChipClick}
              onKeyDown={onRailChipKeyDown}
              onPointerDown={onRailChipPointerDown}
              onPointerMove={onRailChipPointerMove}
              onPointerUp={onRailChipPointerUp}
              onPointerCancel={onRailChipPointerCancel}
            >
              <ChevronsRight
                aria-hidden="true"
                size={12}
                className={railExpanded ? "owb-rail-chip__glyph is-flipped" : "owb-rail-chip__glyph"}
              />
            </button>
          }
        />
      }
      sidebar={
        <Sidebar
          label={t("tree.dir")}
          header={
            <>
              <TreeRowMenu id={null} name={workspaceInfo?.business ?? ""} busy={orgBusy} onAction={treeAction}>
              <div className="owb-project-switcher-row">
              <ProjectSwitcher
                workspace={workspaceInfo}
                disabled={orgBusy}
                dialogOpen={projectHubOpen}
                onOpen={() => setProjectHubOpen(true)}
              />
              <TreeRowMenu id={null} name={workspaceInfo?.business ?? ""} busy={orgBusy} onAction={treeAction} />
              </div>
              </TreeRowMenu>
              <div className="owb-side-head">
                <div className="owb-side-head__copy">
                  <strong className="owb-side-head__title">{t("tree.dir")}</strong>
                </div>
                {workspaceInfo?.open === true ? (
                  <div className="owb-side-head__actions">
                    <AntButton
                      size="small"
                      className="owb-side-head__undo"
                      disabled={orgBusy}
                      icon={<Undo2 aria-hidden="true" size={12} />}
                      onClick={() => void undoLastAdjustment()}
                      title={t("tree.undoTitle")}
                    >
                      {t("tree.undo")}
                    </AntButton>
                    {/* ＋ 走装饰性图标而不是文案前缀，可及名保持「创建员工」。 */}
                    <AntButton size="small" type="primary" disabled={orgBusy} icon={<Plus aria-hidden="true" size={12} />} onClick={() => setTreeHireParent(selectedId ?? snapshot?.owner ?? null)}>{t("tree.create")}</AntButton>
                  </div>
                ) : null}
              </div>
            </>
          }
          footer={
            workspaceInfo?.open === true && (backupsStatus !== "ready" || backups.length > 0)
              ? <BackupTray key={workspaceInfo.path} backups={backups} status={backupsStatus} busy={orgBusy} positionNames={positionNames} onRestore={restorePosition} onRetry={() => void loadBackups()} />
              : null
          }
        >
          {workspaceInfo?.open === true ? (
            treeLoading ? (
              <TreeSkeleton />
            ) : snapshot ? (
              <div
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
                    event.preventDefault();
                    void undoLastAdjustment();
                  }
                }}
              >
                <OrgTree
                  decorateRow={(id, row) => <TreeRowMenu id={id} name={positionNames[id] ?? id} busy={orgBusy} onAction={treeAction}>{row}</TreeRowMenu>}
                  rowActions={(id) => <TreeRowMenu id={id} name={positionNames[id] ?? id} busy={orgBusy} onAction={treeAction} />}
                  rowMetadata={(id) => {
                    const bound = positionEngines[id] !== undefined;
                    const engine = engineForPosition(id);
                    const label = engineLabel(engine);
                    const description = t(bound ? "tree.agentIdentity" : "tree.agentDefaultDescription", { name: label });
                    return <span className="ui-org-tree__metadata-content" title={description} aria-label={description}>
                      <EngineIcon engine={engine} />
                      <span className="ui-org-tree__metadata-label">{label}{bound ? null : ` · ${t("tree.agentDefault")}`}</span>
                    </span>;
                  }}
                  snapshot={snapshot}
                  versionStamp={snapshot.updatedAt}
                  displayNames={positionNames}
                  avatarColors={positionColors}
                  avatarUrls={avatarUrls}
                  runningIds={runningPositionIds}
                  selectedId={selectedId}
                  onSelect={openConversation}
                  onMove={(id, reportTo) => void movePosition(id, reportTo)}
                  onDropPosition={(drop) => void reorderPosition(drop)}
                  onHireEntry={(parent) => setTreeHireParent(parent)}
                  onGroupEntry={(positionId) => {
                    setGroupDraftSeed({ members: [positionId], nonce: Date.now(), scope: groupWorkspaceScope });
                    setActiveModule("groups");
                  }}
                  moveDisabled={orgBusy}
                />
              </div>
            ) : (
              <p className="owb-muted">{t("tree.unavailable")}</p>
            )
          ) : (
            <p className="owb-muted">{t("tree.notOpened")}</p>
          )}
          {workspaceInfo?.open === true ? (
            <HireDrawer
              workspacePath={workspaceInfo.path}
              open={treeHireParent !== undefined}
              positions={positions}
              presetReportTo={treeHireParent ?? null}
              engine={hireConversationHostId === null ? defaultTurnEngine : engineForPosition(hireConversationHostId)}
              conversationEngine={hireConversationHostId === null ? defaultTurnEngine : engineForPosition(hireConversationHostId)}
              engineAvailability={engineAvailability}
              conversationHostId={hireConversationHostId}
              conversationHostName={hireConversationHostId ? positionNames[hireConversationHostId] : undefined}
              budgetPoolTokens={workspaceInfo.budgetPoolTokens}
              budgetAllocatedTokens={hireBudgetAllocatedTokens}
              onClose={() => setTreeHireParent(undefined)}
              onHired={(positionId, name, avatar) => void hiredPosition(positionId, name, avatar)}
            />
          ) : null}
          {workspaceInfo?.open === true ? (
            <EditEmployeeDrawer
              open={editTargetId !== undefined && editPosition !== null}
              position={editPosition}
              busy={orgBusy}
              onClose={() => setEditTargetId(undefined)}
              onSave={(patch) => saveEmployeeProfile(patch, editTargetId)}
            />
          ) : null}
          <ProjectWorkspaceDialog
            open={projectHubOpen}
            workspace={workspaceInfo}
            positionCount={snapshot?.positionCount ?? null}
            engineAvailability={engineAvailability}
            disabled={orgBusy}
            opening={workspaceOpening}
            openError={workspaceOpenError}
            initializePath={workspaceOpenCandidatePath}
            onClose={() => {
              setProjectHubOpen(false);
              setWorkspaceOpenCandidatePath(null);
            }}
            onOpenWorkspace={() => void openWorkspace()}
            onCreated={(created) => void onProjectCreated(created)}
          />
        </Sidebar>
      }
      topbar={
        <Topbar
          breadcrumbs={<Breadcrumbs workspace={workspaceInfo} />}
          actions={
            <div className="owb-topbar-actions">
              {/* 只保留用户需要知道的引擎可用状态；传输层状态不在顶栏重复展示。
                  诚实映射 /health.engine.available。 */}
              <span className="owb-src" role="status">
                <span
                  className={engineOk ? "owb-led" : "owb-led owb-led--off"}
                  aria-hidden="true"
                />
                <span className="owb-src__text">{startupError ? t("misc.serviceOffline") : health === null ? t("misc.serviceStarting") : engineOk ? t("misc.engineAvailable") : t("misc.engineOffline")}</span>
              </span>
            </div>
          }
        />
      }
    >
      <div className="owb-main">
        {startupError ? (
          <Alert type="error" showIcon role="alert" title={startupError}
            action={<AntButton size="small" onClick={() => void refresh()}>{t("misc.retryConnection")}</AntButton>} />
        ) : null}
        {sseState === "connecting" && health !== null && workspaceInfo?.open === true && !startupError ? (
          <Alert type="info" showIcon role="status" title={t("misc.sseReconnecting")} />
        ) : null}
        {health && !engineOk ? (
          <Alert type="warning" showIcon title={<DiagnosticNotice message={t("misc.engineUnavailable")}
            diagnostic={health.engine?.nextStep} availabilityCheck={availabilityCheck} />} />
        ) : null}
        {turnError ? (
          <Alert type="warning" showIcon role="alert" title={turnError} />
        ) : null}
        {orgFeedback ? (
          <Alert type={orgFeedback.tone === "warn" ? "warning" : "info"} showIcon role={orgFeedback.tone === "warn" ? "alert" : "status"} title={orgFeedback.text} />
        ) : null}
        {reportsError ? <Alert type="warning" showIcon role="alert" title={reportsError} /> : null}
        {fallbackNotice ? (
          <Alert
            type="warning"
            showIcon
            role="alert"
            closable
            onClose={() => setFallbackNotice(null)}
            title={t("misc.lastWorkspaceFallback", { path: fallbackNotice })}
          />
        ) : null}
        {activeModule === "reports" ? (
          <ReportsCenter
            key={workspaceInfo?.path}
            onRefresh={() => void loadReports()}
            reports={reports}
            loading={reportsLoading}
            positionNames={positionNames}
            positionColors={positionColors}
            focusTurnId={reportsFocusTurnId ?? undefined}
          />
        ) : activeModule === "approvals" ? (
          <ApprovalQueue
            items={approvalItems}
            dataState={approvalState.ready ? "ready" : "not-connected"}
            loading={approvalState.loading && !approvalState.ready}
            errorMessage={approvalState.error}
            onNavigateToOrg={() => setActiveModule("org")}
            onApprove={(id, reason, scope) => { void approvalState.decide(id, "granted", reason, scope); }}
            onDeny={(id, reason) => { void approvalState.decide(id, "denied", reason); }}
            onApproveBatch={(ids) => { void approvalState.decideBatch(ids); }}
            onOpenSource={openApprovalSource}
            onOpenEvidence={openApprovalEvidence}
          />
        ) : activeModule === "groups" ? (
          <GroupsPanel
            availabilityCheck={availabilityCheck}
            key={`${workspaceInfo?.open}:${workspaceInfo?.path}`}
            workspaceOpen={workspaceInfo?.open === true}
            positions={positions}
            positionNames={positionNames}
            positionColors={positionColors}
            avatarUrls={avatarUrls}
            draftSeed={groupDraftSeed?.scope === groupWorkspaceScope ? groupDraftSeed : null}
            engine={defaultTurnEngine}
            engineAvailability={engineAvailability}
            engineForPosition={engineForPosition}
            liveRuns={turnStream.runs}
            onSpawnRuns={spawnGroupRuns}
            onReconcileTimeline={reconcileGroup}
          />
        ) : activeModule === "goals" ? (
          <GoalsModule workspaceOpen={workspaceInfo?.open === true} workspaceKey={workspaceInfo?.path} />
        ) : activeModule === "settings" ? (
          <SettingsModule />
        ) : activeModule === "docs" ? (
          <MemoryModule
            key={workspaceInfo?.path}
            onCollaborate={() => setActiveModule("groups")}
            onContinue={(id, sessionId) => { selectPosition(id); selectedSessions.current[JSON.stringify([workspacePathRef.current, id])] = sessionId; setActiveModule("org"); }}
            workspaceOpen={workspaceInfo?.open === true}
            positions={positions}
            selectedPositionId={selectedId}
            position={card.data}
            initialSource={memorySource}
          />
        ) : workspaceInfo?.open !== true ? (
          <section className="owb-workspace-welcome">
            <div className="owb-workspace-welcome__icon"><FolderOpen size={28} aria-hidden="true" /></div>
            <h1>{t("project.welcomeTitle")}</h1>
            <p>{t("project.welcomeDescription")}</p>
            <AntButton type="primary" size="large" icon={<Plus size={16} aria-hidden="true" />}
              disabled={startupError !== null || health === null} onClick={() => setProjectHubOpen(true)}>{t("project.welcomeAction")}</AntButton>
          </section>
        ) : <>
          <nav className="owb-org-views" aria-label={t("tree.views")}>
            <AntButton ref={workbenchButtonRef} size="small" type={orgOverview ? "default" : "primary"}
              aria-pressed={!orgOverview} onClick={() => setOrgOverview(false)}>{t("tree.workbench")}</AntButton>
            <AntButton size="small" type={orgOverview ? "primary" : "default"} icon={<Network size={14} aria-hidden="true" />}
              aria-pressed={orgOverview} onClick={() => setOrgOverview(true)}>{t("tree.overview")}</AntButton>
          </nav>
          {orgOverview ? <OrgChart
            className="owb-org-chart--overview"
            collapsible={false}
            snapshot={snapshot}
            loading={treeLoading}
            displayNames={positionNames}
            avatarColors={positionColors}
            avatarUrls={avatarUrls}
            selectedId={selectedId}
            onSelect={(id) => { openConversation(id); workbenchButtonRef.current?.focus(); }}
          /> : null}
          <OrgWorkspaceSplit
          hidden={orgOverview}
          focused={conversationFocused}
          ariaLabel={t("tree.splitPane")}
          resetTitle={t("tree.splitPaneReset")}
          valueText={(value) => t("tree.splitPaneValue", { value })}
          left={
            <div className="owb-org-module__left">
              <div className="owb-position-column">
                <PositionCard
                  position={card.data}
                  loading={card.loading}
                  notFound={card.notFound}
                  running={selectedId !== null && runningPositionIds.has(selectedId)}
                  onRefresh={() => void refresh()}
                  onContextSourceSelect={(source) => {
                    setMemorySource(source.kind === "mem_drive" ? "drive" : "docs");
                    setActiveModule("docs");
                  }}
                  actions={selectedPosition && selectedId ? (
                    <>
                      {/* Editing the record is available on every position, the
                          company owner included: the owner is an employee with
                          a package, and its reporting line cannot move anyway.
                          These go straight into the card header's action
                          cluster — #137 deleted the `.owb-position-actions`
                          wrapper and pinned that with a test, because the
                          header cluster already lays its children out. */}
                      <button
                        type="button"
                        className="owb-edit"
                        onClick={() => setEditTargetId(selectedId)}
                        disabled={orgBusy}
                        title={t("profile.editTitle")}
                      >
                        <PencilLine aria-hidden="true" size={13} />
                        {t("profile.edit")}
                      </button>
                      {selectedId !== snapshot?.owner ? (
                        <DismissPositionDialog positionName={selectedPosition.name} descendantCount={selectedNode ? countDescendants(selectedNode) : 0} busy={orgBusy} onDismiss={() => dismissPosition(selectedId)} />
                      ) : null}
                    </>
                  ) : undefined}
                />
              </div>
            </div>
          }
          right={<TurnPanel
            availabilityCheck={availabilityCheck}
            qoderLogin={qoderLoginSurface}
            key={workspaceInfo?.path}
            workspaceKey={workspaceInfo?.path}
            memory={conversationMemory.current}
            focused={conversationFocused}
            onToggleFocus={() => setConversationFocused(!conversationFocused)}
            sendShortcut={sendShortcut}
            onSelectSession={(sessionId) => {
              if (!selectedId || selectedSessionId === sessionId || !sessions.some(session => session.sessionId === sessionId)) return;
              historyRequest.current += 1;
              setTurns([]); setHistoryLoading(true);
              selectedSessions.current[JSON.stringify([workspacePathRef.current, selectedId])] = sessionId;
              selectedSessionIdRef.current = sessionId; setSelectedSessionId(sessionId);
            }}
            historyLoading={historyLoading}
            modelLoading={selectedId ? modelStates[selectedId]?.loading : false}
            modelError={selectedId ? modelStates[selectedId]?.error : undefined}
            modelNotice={selectedId ? modelStates[selectedId]?.notice : undefined}
            onReloadModel={() => { if (selectedId) void loadPosition(selectedId); }}
            active={!orgOverview}
            avatarUrls={avatarUrls}
            workspaceOpen={workspaceInfo?.open === true}
            modelConfig={selectedId ? positionModels[selectedId] : undefined}
            modelSaving={(modelSavingIds[JSON.stringify([workspaceInfo?.path, selectedId])] === true) || (engineSavingId !== null && engineSavingId === selectedId)}
            onSelectModel={changeEmployeeModel}
            onSelectEngine={changeEmployeeAgentEngine}
            onSetSessionContext={setSessionContext}
            onRotateSession={rotateActiveSession}
            positions={positions}
            selectedPositionId={selectedId}
            engine={selectedId === null ? defaultTurnEngine : engineForPosition(selectedId)}
            engineLocked={selectedId !== null && lockedAgentPositions[selectedId] === true}
            engineAvailability={engineAvailability}
            turns={displayTurns}
            busy={turnBusy}
            employeeBusy={selectedId !== null && runningPositionIds.has(selectedId)}
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            sessionBusy={sessionBusy}
            onCreateTurn={createTurn}
            onCancelTurn={cancelTurn}
            onVerdictTurn={verdictTurn}
            decidedApprovalIds={decidedApprovals}
            cancelling={turnCancelling}
          />}
        /></>}
      </div>
    </AppShell>
    </div>
    </ConfigProvider>
    </DSProvider>
  );
}

function containsNode(node: OrgTreeNodeV1, id: string): boolean {
  return node.children.some((child) => child.id === id || containsNode(child, id));
}

function countDescendants(node: OrgTreeNodeV1): number {
  return node.children.reduce((count, child) => count + 1 + countDescendants(child), 0);
}

function flattenPositionIds(nodes: OrgTreeNodeV1[]): string[] {
  const ids: string[] = [];
  const visit = (node: OrgTreeNodeV1): void => {
    ids.push(node.id);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return ids;
}

function replaceTurn(turns: TurnRecord[], next: TurnRecord): TurnRecord[] {
  const index = turns.findIndex((turn) => turn.id === next.id);
  if (index < 0) return [...turns, next];
  return turns.map((turn, current) => current === index ? next : turn);
}

function isTurnEngine(value: unknown): value is TurnEngine {
  return typeof value === "string" && (TURN_ENGINES as readonly string[]).includes(value);
}

/** 导轨展开态持久化：写不了（隐私窗口/被禁）就只保留本次启动的内存选择。 */
const RAIL_EXPANDED_STORAGE_KEY = "owb.railExpanded";
const RAIL_CHIP_BOTTOM_STORAGE_KEY = "owb.railChipBottom";
const RAIL_CHIP_DEFAULT_BOTTOM = 72;
const RAIL_CHIP_MIN_BOTTOM = 12;
const RAIL_CHIP_EDGE_GUTTER = 12;
const RAIL_CHIP_SIZE = 24;
const RAIL_CHIP_DRAG_THRESHOLD = 4;
const RAIL_CHIP_KEYBOARD_STEP = 16;

interface RailChipBounds {
  min: number;
  max: number;
}

interface RailChipDrag {
  pointerId: number;
  startY: number;
  startBottom: number;
  bounds: RailChipBounds;
}

function clampRailChipBottom(value: number, bounds: RailChipBounds): number {
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)));
}

function seedRailExpanded(): boolean {
  try {
    return window.localStorage.getItem(RAIL_EXPANDED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistRailExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(RAIL_EXPANDED_STORAGE_KEY, expanded ? "1" : "0");
  } catch {
    // 存储不可用时静默降级为会话内记忆。
  }
}

function seedRailChipBottom(): number {
  try {
    const raw = Number.parseFloat(window.localStorage.getItem(RAIL_CHIP_BOTTOM_STORAGE_KEY) ?? "");
    if (Number.isFinite(raw)) return Math.max(RAIL_CHIP_MIN_BOTTOM, Math.min(720, Math.round(raw)));
  } catch {
    // 存储不可用时静默降级为本次会话的默认位置。
  }
  return RAIL_CHIP_DEFAULT_BOTTOM;
}

function persistRailChipBottom(bottom: number): void {
  try {
    window.localStorage.setItem(RAIL_CHIP_BOTTOM_STORAGE_KEY, String(Math.round(bottom)));
  } catch {
    // 存储不可用时静默降级为会话内位置。
  }
}

function apiErrorMessage(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

function TreeSkeleton() {
  const t = useT();
  return (
    <div className="owb-tree-skeleton" aria-label={t("tree.loading")}>
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} style={{ height: 22, width: `${100 - index * 18}%` }} />
      ))}
    </div>
  );
}

function findNodeById(nodes: OrgTreeNodeV1[], id: string): OrgTreeNodeV1 | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNodeById(node.children, id);
    if (found) return found;
  }
  return null;
}

/** Real window chrome for the frameless shell (设计稿 .wintitle 左上三点).
 * macOS-style traffic lights: close / minimize / maximize, each an actual
 * button with an accessible name — the previous decorative dots sat under the
 * native frame and did nothing. Guarded with `?.` so the renderer still boots
 * against an older preload bridge (tests stub a partial bridge). */
function normalizePositionForDisplay(position: PositionCardData, locale: OwbLocale): PositionCardData {
  return localizePositionCard({
    ...position,
    name: decodeEscapedUnicode(position.name),
    description: decodeEscapedUnicode(position.description),
    contextScope: decodeEscapedUnicode(position.contextScope),
    permissions: {
      toolAllow: position.permissions.toolAllow.map(decodeEscapedUnicode),
      toolDeny: position.permissions.toolDeny.map(decodeEscapedUnicode),
    },
    metadata: Object.fromEntries(
      Object.entries(position.metadata).map(([key, value]) => [key, decodeEscapedUnicode(value)]),
    ),
  }, locale);
}

function WindowControls() {
  const t = useT();
  return (
    <span className="owb-wintitle__controls">
      <button
        type="button"
        className="owb-wctl owb-wctl--close"
        aria-label={t("win.close")}
        title={t("win.closeTitle")}
        onClick={() => void window.owb.windowClose?.()}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
        </svg>
      </button>
      <button
        type="button"
        className="owb-wctl owb-wctl--min"
        aria-label={t("win.minimize")}
        title={t("win.minimizeTitle")}
        onClick={() => void window.owb.windowMinimize?.()}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.2 5h5.6" />
        </svg>
      </button>
      {/* 文案保持静态：WSLg 下 isMaximized() 不可信，不向用户谎报当前状态。 */}
      <button
        type="button"
        className="owb-wctl owb-wctl--max"
        aria-label={t("win.maximize")}
        title={t("win.maximizeTitle")}
        onClick={() => void window.owb.windowToggleMaximize?.()}
      >
        {/* #248 小 UI 单②：fullscreen 为绿底斜杠 ⃠ glyph。 */}
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.8 7.2L7.2 2.8" />
        </svg>
      </button>
    </span>
  );
}

function Breadcrumbs({
  workspace,
}: {
  workspace: WorkspaceInfoResponse | null;
}) {
  const t = useT();
  if (workspace?.open !== true || !workspace.path) return null;
  const revealInFileManager = async () => {
    if (!window.owb.revealWorkspace) return;
    const result = await window.owb.revealWorkspace();
    if (result.opened !== true) message.warning(t("misc.workspaceRevealFailed"));
  };
  return (
    <span className="owb-topbar-context">
      <button
        type="button"
        className="owb-workspace-location"
        title={`${workspace.path} · ${t("misc.workspaceRevealHint")}`}
        aria-label={`${t("misc.workspaceRevealHint")}: ${workspace.path}`}
        onClick={() => void revealInFileManager()}
      >
        <FolderOpen aria-hidden="true" size={12} />
        <span className="owb-workspace-location__path">{workspace.path}</span>
      </button>
    </span>
  );
}
