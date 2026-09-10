import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button as AntButton, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import { OwbI18nProvider, useT, type OwbLocale } from "@roleweave/ui";
import {
  AppShell,
  ModuleRail,
  Sidebar,
  Skeleton,
  Topbar,
} from "@fullstack-ai-infra/ui";
import { OrgTree, PositionCard } from "@roleweave/ui";
import type { OrgDropPosition, PositionCardData } from "@roleweave/ui";
import type {
  ChangeManifest,
  GroupTimeline,
  HealthResponse,
  OrgBackupEntry,
  OrgBackupsResponse,
  OrgTreeNodeV1,
  OrgTreeSnapshot,
  ReportsResponse,
  TurnHistory,
  WorkbenchSession,
  WorkbenchSessionList,
  WorkspaceCreateResponse,
  WorkspaceInfoResponse,
} from "@roleweave/shared";
import { BrainCircuit, Check, ChevronDown, Cog, FileChartColumn, FolderOpen, FolderPlus, Network, Plus, ShieldAlert, Undo2, UsersRound } from "lucide-react";
import { useThemeMode } from "./theme-toggle";
import { PrefsMenu } from "./prefs-menu";
import { persistLocale, seedLocale } from "./locale-mode";
import {
  EMPTY_TURN_STREAM,
  TurnPanel,
  adaptTurnHistory,
  adaptTurnRecord,
  applyTurnEvent,
  approvalResumeInput,
  beginGroupRun,
  beginPendingTurn,
  reconcileGroupTimeline,
  resetStreamSeq,
  settlePendingTurn,
} from "./turns";
import type {
  CreateTurnRequest,
  PositionMentionOption,
  TurnEngine,
  TurnRecord,
  TurnStreamEnvelope,
  TurnStreamState,
} from "./turns";
import { BackupTray, DismissPositionDialog } from "./org/OrgControls";
import { HireDrawer } from "./org/HireDrawer";
import { OrgChart } from "./org/OrgChart";
import { GroupsPanel } from "./groups/GroupsPanel";
import { MemoryModule, type MemorySource } from "./memory/MemoryModule";
import { ReportsCenter } from "./reports/ReportsCenter";
import { ApprovalQueue, type ApprovalQueueItem } from "./approvals";
import { decodeEscapedUnicode } from "./display-text";
import { SettingsModule } from "./settings/SettingsModule";
import { ProjectCreateDrawer } from "./project/ProjectCreateDrawer";

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
  return <AppRoot />;
}

/** #146 i18n 根：locale 状态住在 Provider 之上；恰好两个 locale，
 * 持久化，默认 zh-CN。antd 的 ConfigProvider locale 同步切换。 */
function AppRoot() {
  const [locale, setLocale] = useState<OwbLocale>(() => seedLocale());
  const changeLocale = useCallback((next: OwbLocale) => {
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
  const [activeModule, setActiveModule] = useState<
    "org" | "groups" | "reports" | "approvals" | "docs" | "settings"
  >("org");
  const [memorySource, setMemorySource] = useState<MemorySource>("docs");
  /**
   * DATA GAP (TODO, v0): v0 has no dedicated `/approvals` stream. The P0
   * queue receives an empty items array here; App will later populate this
   * from a bounded `sessionTurnHistory` scan + SSE `turn.approval.requested`
   * increments. Kept as a plain state slot so the wiring point is obvious.
   */
  const [approvalItems] = useState<ApprovalQueueItem[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfoResponse | null>(null);
  const [snapshot, setSnapshot] = useState<OrgTreeSnapshot | null>(null);
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
  const [turnEngine, setTurnEngine] = useState<TurnEngine>("qoder");
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
  const [reports, setReports] = useState<ReportsResponse | null>(null);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [orgBusy, setOrgBusy] = useState(false);
  const [orgFeedback, setOrgFeedback] = useState<{ tone: "info" | "warn"; text: string } | null>(null);
  /** Approvals whose verdict was already sealed into a resume turn. The
   * server record never persists pendingApproval, so this client-side set is
   * the only source for settling the verdict card into a terminal state. */
  const [decidedApprovals, setDecidedApprovals] = useState<ReadonlySet<string>>(new Set());
  /** Tree-node "+" hire entry (#32 AC-004): undefined = closed, otherwise the preset reportTo. */
  const [treeHireParent, setTreeHireParent] = useState<string | null | undefined>(undefined);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  /** Org-tree group entry (#53): prefilled draft members handed to the
   * GroupsPanel create panel; nonce re-fires repeated entries. */
  const groupWorkspaceScope = useMemo(() => Symbol("group-workspace"), [workspaceInfo?.path, workspaceInfo?.open]);
  const latestGroupWorkspaceScope = useRef(groupWorkspaceScope);
  latestGroupWorkspaceScope.current = groupWorkspaceScope;
  const [groupDraftSeed, setGroupDraftSeed] = useState<{ members: string[]; nonce: number; scope: symbol } | null>(null);
  /** 亮/暗跟随 <html data-theme>，antd cssinjs 与 --ui-* skin 同步切换。 */
  const themeMode = useThemeMode();
  /** #146：界面文案唯一入口；数据层文案不经过这里。 */
  const t = useT();

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
    selectionVersion.current += 1;
    historyRequest.current += 1;
    selectedSessions.current = {};
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

  const loadBackups = useCallback(async () => {
    const response = await window.owb.orgBackups();
    if (response.status === 200) setBackups((response.body as OrgBackupsResponse).backups);
    else setBackups([]);
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

  const refresh = useCallback(async () => {
    const [statusRes, workspaceRes] = await Promise.all([
      window.owb.status(),
      window.owb.workspace(),
    ]);
    setHealth(statusRes.health ?? null);
    const ws = workspaceRes.body as WorkspaceInfoResponse | null;
    setWorkspaceInfo(ws);
    if (ws?.open === true) {
      const treeRes = await window.owb.orgTree();
      if (treeRes.status === 200) {
        const nextSnapshot = treeRes.body as OrgTreeSnapshot;
        setSnapshot(nextSnapshot);
        const positionIds = flattenPositionIds(nextSnapshot.tree);
        setSelectedId((current) => current && positionIds.includes(current) ? current : null);
        const cardEntries = await Promise.all(positionIds.map(async (id): Promise<[string, { name: string; color?: string }]> => {
          const response = await window.owb.position(id);
          const body = response.body as { position?: PositionCardData };
          const position = response.status === 200 && body.position
            ? normalizePositionForDisplay(body.position)
            : undefined;
          const color = position?.metadata?.color;
          return [id, {
            name: position?.name ?? t("org.unknownPosition"),
            ...(typeof color === "string" && color.length > 0 ? { color } : {}),
            // The org chart only needs a human name and optional color. Mode,
            // budget and permissions belong to the selected position record.
          }];
        }));
        const names = Object.fromEntries(cardEntries.map(([id, entry]) => [id, entry.name]));
        positionNamesRef.current = names;
        setPositionNames(names);
        setPositionColors(Object.fromEntries(cardEntries.filter(([, entry]) => "color" in entry).map(([id, entry]) => [id, (entry as { color: string }).color])));
        await Promise.all([loadBackups(), loadReports()]);
      } else {
        setSnapshot(null);
        positionNamesRef.current = {};
        setPositionNames({});
        setPositionColors({});
      }
    } else {
      setSnapshot(null);
      positionNamesRef.current = {};
      setPositionNames({});
      setPositionColors({});
      setSelectedId(null);
      setCard({ loading: false, data: null, notFound: false });
      setTurns([]);
      setTurnStream(EMPTY_TURN_STREAM);
      setSessions([]);
      setSelectedSessionId(null);
      selectedSessionIdRef.current = null;
      setTurnError(null);
      setDecidedApprovals(new Set());
      setBackups([]);
      setReports(null);
      setReportsError(null);
    }
    setTreeLoading(false);
  }, [loadBackups, loadReports, t]);

  const loadPosition = useCallback(async (id: string) => {
    const version = selectionVersion.current;
    setCard({ loading: true, data: null, notFound: false });
    const res = await window.owb.position(id);
    if (version !== selectionVersion.current || selectedIdRef.current !== id) return;
    const body = res.body as { position?: PositionCardData; code?: string };
    if (res.status === 404 || body?.code === "position_missing") {
      setCard({ loading: false, data: null, notFound: true });
      return;
    }
    setCard({
      loading: false,
      data: body?.position ? normalizePositionForDisplay(body.position) : null,
      notFound: false,
    });
  }, []);

  const loadTurnHistory = useCallback(async (id: string, sessionId = selectedSessionIdRef.current) => {
    if (selectedIdRef.current !== id || selectedSessionIdRef.current !== sessionId) return false;
    const requestVersion = ++historyRequest.current;
    if (sessionId === null) {
      setTurns([]);
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
    }
  }, [t]);

  const loadSessions = useCallback(async (id: string) => {
    const version = selectionVersion.current;
    try {
      const res = await window.owb.sessions(id);
      if (version !== selectionVersion.current || selectedIdRef.current !== id) return false;
      if (res.status !== 200) {
        setSessions([]);
        setSelectedSessionId(null);
        selectedSessionIdRef.current = null;
        setTurnError(apiErrorMessage(res.body, t("turn.sessionsFail")));
        return false;
      }
      const list = res.body as WorkbenchSessionList;
      setSessions(list.sessions);
      const current = selectedSessionIdRef.current ?? selectedSessions.current[id];
      const next = current && list.sessions.some((session) => session.sessionId === current)
        ? current
        : list.activeSessionId;
      selectedSessionIdRef.current = next;
      if (next) selectedSessions.current[id] = next;
      setSelectedSessionId(next);
      setTurnError(null);
      return true;
    } catch {
      if (version === selectionVersion.current && selectedIdRef.current === id) setTurnError(t("turn.sessionsFailOffline"));
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
          selectedSessions.current[positionId] = session.sessionId;
          selectedSessionIdRef.current = session.sessionId;
          setSelectedSessionId(session.sessionId);
          await loadSessions(positionId);
        }
      }
    } catch {
      // 会话自动挂载失败不阻断：操作员仍可在「会话设置」里手动新建。
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
    setTurns([]);
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
      const envelope = event as { type?: string };
      if (envelope?.type === "org.updated") {
        void refresh();
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
        for (const path of workspaceStreams.current.keys()) updateWorkspaceStream(path, resetStreamSeq);
      }
    };
    const offSse = window.owb.onSseStatus(applySseStatus);
    void window.owb.sseStatus().then(applySseStatus);
    const offFallback = window.owb.onFallbackNotice((failedPath) => {
      setFallbackNotice(failedPath);
    });
    return () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      offEvent();
      offSse();
      offFallback();
    };
  }, [loadReports, loadTurnHistory, refresh, updateWorkspaceStream]);

  const selectPosition = useCallback((id: string) => {
    if (selectedIdRef.current === id) return;
    selectionVersion.current += 1;
    historyRequest.current += 1;
    setSessionBusyPositions((current) => ({ ...current, [id]: true }));
    selectedIdRef.current = id;
    selectedSessionIdRef.current = null;
    setSelectedSessionId(null);
    setSessions([]);
    setTurns([]);
    setSelectedId(id);
  }, []);

  const selectSession = useCallback((sessionId: string) => {
    historyRequest.current += 1;
    if (selectedIdRef.current) selectedSessions.current[selectedIdRef.current] = sessionId;
    selectedSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
    setTurns([]);
    setTurnError(null);
  }, []);

  const createSession = useCallback(async () => {
    const positionId = selectedIdRef.current;
    if (positionId === null) return;
    const version = selectionVersion.current;
    const operation = Symbol();
    sessionOperations.current.set(positionId, operation);
    setSessionBusyPositions((current) => ({ ...current, [positionId]: true }));
    setTurnError(null);
    try {
      const res = await window.owb.createSession({ positionId });
      if (selectionVersion.current !== version || selectedIdRef.current !== positionId) return;
      if (res.status !== 201) {
        setTurnError(apiErrorMessage(res.body, t("turn.createSessionFail")));
        return;
      }
      const session = res.body as WorkbenchSession;
      selectedSessions.current[positionId] = session.sessionId;
      selectedSessionIdRef.current = session.sessionId;
      setSelectedSessionId(session.sessionId);
      await loadSessions(positionId);
    } catch {
      if (selectionVersion.current === version) setTurnError(t("turn.createSessionFailOffline"));
    } finally {
      if (sessionOperations.current.get(positionId) === operation) setSessionBusyPositions((current) => ({ ...current, [positionId]: false }));
    }
  }, [loadSessions, t]);

  /** #248 R2 ②：组织树点某人 = 直接打开与他的对话（一键）。 */
  const openConversation = useCallback((positionId: string) => {
    selectPosition(positionId);
  }, [selectPosition]);

  const rotateSession = useCallback(async (sessionId: string) => {
    const positionId = selectedIdRef.current;
    if (positionId === null) return;
    const version = selectionVersion.current;
    const operation = Symbol();
    sessionOperations.current.set(positionId, operation);
    setSessionBusyPositions((current) => ({ ...current, [positionId]: true }));
    setTurnError(null);
    try {
      const res = await window.owb.rotateSession(sessionId);
      if (selectionVersion.current !== version || selectedIdRef.current !== positionId) return;
      if (res.status !== 200 && res.status !== 201) {
        setTurnError(apiErrorMessage(res.body, t("turn.rotateFail")));
        return;
      }
      const session = res.body as WorkbenchSession;
      selectedSessions.current[positionId] = session.sessionId;
      selectedSessionIdRef.current = session.sessionId;
      setSelectedSessionId(session.sessionId);
      setTurns([]);
      await loadSessions(positionId);
    } catch {
      if (selectionVersion.current === version) setTurnError(t("turn.rotateFailOffline"));
    } finally {
      if (sessionOperations.current.get(positionId) === operation) setSessionBusyPositions((current) => ({ ...current, [positionId]: false }));
    }
  }, [loadSessions, t]);

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
        ...(request.pendingApproval !== undefined
          ? { pendingApproval: request.pendingApproval }
          : {}),
      });
      if (res.status !== 200) {
        const message = apiErrorMessage(res.body, t("turn.createFail"));
        if (isSelected()) setTurnError(message);
        updateWorkspaceStream(workspacePath, (current) => settlePendingTurn(current, { positionId: request.positionId, sessionId, runId: null }));
        return false;
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
      const body = res.body as { runId?: unknown; turnId?: unknown };
      updateWorkspaceStream(workspacePath, (current) =>
        settlePendingTurn(current, {
          runId: typeof body.runId === "string" ? body.runId : null,
          ...(typeof body.turnId === "string" ? { turnId: body.turnId } : {}),
          positionId: request.positionId,
          sessionId,
        }),
      );
      if (isSelected()) await loadTurnHistory(request.positionId, sessionId);
      return true;
    } catch {
      updateWorkspaceStream(workspacePath, (current) => settlePendingTurn(current, { positionId: request.positionId, sessionId, runId: null }));
      if (isSelected()) setTurnError(t("turn.createFailOffline"));
      return false;
    } finally {
      inFlightPositions.current.delete(requestKey);
      updateWorkspaceBusy(workspacePath, request.positionId, false);
    }
  }, [loadTurnHistory, t, updateWorkspaceBusy, updateWorkspaceStream]);

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

  /** Group spawn (#52): the 202 spawn list carries pre-assigned turnIds; seed
   * one live buffer per mentioned member so SSE deltas aggregate per member. */
  const spawnGroupRuns = useCallback(
    (
      groupRef: string,
      messageId: string,
      spawns: Array<{ turnId: string; positionId: string }>,
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
              engine,
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
    } catch {
      if (isSelected()) setTurnError(t("turn.cancelFailOffline"));
    } finally {
      if (cancelOperations.current.get(key) === operation) {
        cancelOperations.current.delete(key);
        updateWorkspaceCancelling(workspacePath, positionId, false);
      }
    }
  }, [t, updateWorkspaceCancelling]);

  /** Operator verdict (issue #25 Slice B): the verdict is a new resume turn
   * whose sealed envelope carries pendingApproval; granted defaults scope to
   * "once" upstream, denied carries the optional reason only. A verdict is
   * only marked decided after the resume turn is created, so a failed
   * creation leaves the card actionable. */
  const verdictTurn = useCallback(
    async (turn: TurnRecord, decision: "granted" | "denied", reason?: string) => {
      const request = turn.approvalRequest;
      if (request === undefined) return;
      if (decidedApprovals.has(request.approvalId)) return;
      const created = await createTurn({
        positionId: turn.positionId,
        engine: turn.engine,
        input: approvalResumeInput(decision, reason),
        pendingApproval: {
          approvalId: request.approvalId,
          decision,
          decidedBy: "operator",
          ...(decision === "granted" ? { scope: "once" as const } : {}),
          ...(reason !== undefined ? { reason } : {}),
        },
      });
      if (created !== false) {
        setDecidedApprovals((current) => new Set(current).add(request.approvalId));
      }
    },
    [createTurn, decidedApprovals],
  );

  const openWorkspace = useCallback(async () => {
    await window.owb.openWorkspace();
    await refresh();
  }, [refresh]);

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
    setOrgBusy(true);
    setOrgFeedback(null);
    try {
      const response = await window.owb.orgApply(manifest);
      if (response.status !== 200) {
        setOrgFeedback({ tone: "warn", text: apiErrorMessage(response.body, t("org.applyRejected")) });
        return false;
      }
      setOrgFeedback({ tone: "info", text: successMessage });
      await refresh();
      return true;
    } catch {
      setOrgFeedback({ tone: "warn", text: t("org.applyUncertain") });
      return false;
    } finally {
      setOrgBusy(false);
    }
  }, [refresh, t]);

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
  const hiredPosition = useCallback(async (positionId: string, name: string) => {
    setOrgFeedback({ tone: "info", text: t("org.hired", { name }) });
    await refresh();
    setSelectedId(positionId);
  }, [refresh, t]);

  const dismissPosition = useCallback(async (id: string) =>
    applyOrg({ schemaVersion: "change-manifest.v1", changes: [{ op: "delete", id }] }, t("org.dismissed")), [applyOrg, t]);

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
  const selectedBudgetReport = selectedId ? reports?.budgets.find((budget) => budget.positionId === selectedId) : null;
  const selectedBudgetRatio = selectedBudgetReport?.latestTurn && selectedBudgetReport.declared.perTask.tokens
    ? selectedBudgetReport.latestTurn.totalTokens / selectedBudgetReport.declared.perTask.tokens
    : null;

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
    },
    "claude-code": {
      configured: health?.hosts?.["claude-code"].configured === true,
      ready: health?.hosts?.["claude-code"].ready === true,
      reason: health?.hosts?.["claude-code"].nextStep ?? t("misc.claudeHostUnknown"),
    },
    "claude-local": {
      configured: health?.hosts?.["claude-local"]?.configured === true,
      ready: health?.hosts?.["claude-local"]?.ready === true,
      reason: health?.hosts?.["claude-local"]?.nextStep ?? t("misc.claudeLocalHostUnknown"),
    },
  }), [health, t]);

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
    if (live.length === 0) return turns;
    return [...turns, ...live].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [positionNames, selectedId, selectedSessionId, t, turnStream.pending, turnStream.runs, turns]);

  // ADR-0002: Ant Design consumes the same semantic skin as the custom layout.
  // The provider lives here (not in main.tsx) so tests render the same config;
  // autoInsertSpace is off so two-char CJK labels keep exact accessible names.
  return (
    <ConfigProvider
      locale={locale === "en" ? enUS : zhCN}
      button={{ autoInsertSpace: false }}
      theme={{
        algorithm: ANTD_ALGORITHM[themeMode],
        token: {
          // RoleWeave brand tokens stay synchronized in both themes,
          // including portaled Antd menus, notifications and drawers.
          ...ANTD_SEED[themeMode],
          // Both themes use the same readable typography and control geometry.
          fontSize: 13,
          borderRadius: 8,
          // 动效三档 120/160/240ms，全 ease-out，禁 >300ms。
          motionDurationFast: "0.12s",
          motionDurationMid: "0.16s",
          motionDurationSlow: "0.24s",
          motionEaseInOut: "cubic-bezier(0.22, 0.61, 0.36, 1)",
          motionEaseOut: "cubic-bezier(0.22, 0.61, 0.36, 1)",
          controlHeight: 32,
          controlHeightSM: 26,
          controlHeightLG: 36,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
        },
      }}
    >
    <div className="owb-app">
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
        <PrefsMenu locale={locale} onChangeLocale={onChangeLocale} mode={themeMode} />
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
            { id: "reports", label: t("rail.reports"), icon: <FileChartColumn aria-hidden="true" size={16} />, active: activeModule === "reports", onSelect: () => { setActiveModule("reports"); void loadReports(); } },
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
                  <ShieldAlert aria-hidden="true" size={16} />
                </Badge>
              ),
              active: activeModule === "approvals",
              onSelect: () => setActiveModule("approvals"),
            },
            // mem and position documents are two sources in one employee-memory
            // surface. Keep one entry here so the user does not have to choose
            // between two implementation-owned data planes.
            { id: "docs", label: t("rail.memory"), icon: <BrainCircuit aria-hidden="true" size={16} />, active: activeModule === "docs", onSelect: () => { setMemorySource("docs"); setActiveModule("docs"); } },
            // #134: the update pane needs room for a version, live progress and
            // a changelog link, so it is a module rather than a third row in
            // the prefs drawer (#174), which stays two quick toggles.
            { id: "settings", label: t("rail.settings"), icon: <Cog aria-hidden="true" size={16} />, active: activeModule === "settings", onSelect: () => setActiveModule("settings") },
          ]}
        />
      }
      sidebar={
        <Sidebar
          label={t("tree.dir")}
          header={
            <>
              <ProjectSwitcher
                workspace={workspaceInfo}
                positionCount={snapshot?.positionCount ?? null}
                disabled={orgBusy}
                onOpenWorkspace={() => void openWorkspace()}
                onCreateProject={() => setProjectCreateOpen(true)}
              />
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
            workspaceInfo?.open === true ? <BackupTray backups={backups} busy={orgBusy} positionNames={positionNames} onRestore={restorePosition} /> : null
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
                  snapshot={snapshot}
                  versionStamp={snapshot.updatedAt}
                  displayNames={positionNames}
                  avatarColors={positionColors}
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
              engine={turnEngine}
              engineAvailability={engineAvailability}
              conversationHostId={hireConversationHostId}
              conversationHostName={hireConversationHostId ? positionNames[hireConversationHostId] : undefined}
              budgetPoolTokens={workspaceInfo.budgetPoolTokens}
              budgetAllocatedTokens={hireBudgetAllocatedTokens}
              onSelectEngine={setTurnEngine}
              onClose={() => setTreeHireParent(undefined)}
              onHired={(positionId, name) => void hiredPosition(positionId, name)}
            />
          ) : null}
          <ProjectCreateDrawer
            open={projectCreateOpen}
            onClose={() => setProjectCreateOpen(false)}
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
                <span className="owb-src__text">{engineOk ? t("misc.engineAvailable") : t("misc.engineOffline")}</span>
              </span>
            </div>
          }
        />
      }
    >
      <div className="owb-main">
        {sseState === "connecting" ? (
          <Alert type="info" showIcon role="status" title={t("misc.sseReconnecting")} />
        ) : null}
        {health && !engineOk ? (
          <Alert type="warning" showIcon role="status" title={health.engine?.nextStep ?? t("misc.engineUnavailable")} />
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
            reports={reports}
            loading={reportsLoading}
            positionNames={positionNames}
            positionColors={positionColors}
          />
        ) : activeModule === "approvals" ? (
          <ApprovalQueue
            items={approvalItems}
            dataState="not-connected"
            onNavigateToOrg={() => setActiveModule("org")}
            onApprove={(approvalId, reason) => {
              // TODO(v0 gap): wire into onVerdictTurn once the queue is fed
              // by the bounded-scan + SSE derivation path.
              console.info("approval.approve", { approvalId, reason });
            }}
            onDeny={(approvalId, reason) => {
              console.info("approval.deny", { approvalId, reason });
            }}
          />
        ) : activeModule === "groups" ? (
          <GroupsPanel
            key={`${workspaceInfo?.open}:${workspaceInfo?.path}`}
            workspaceOpen={workspaceInfo?.open === true}
            positions={positions}
            positionNames={positionNames}
            positionColors={positionColors}
            draftSeed={groupDraftSeed?.scope === groupWorkspaceScope ? groupDraftSeed : null}
            engine={turnEngine}
            engineAvailability={engineAvailability}
            liveRuns={turnStream.runs}
            onSelectEngine={setTurnEngine}
            onSpawnRuns={spawnGroupRuns}
            onReconcileTimeline={reconcileGroup}
          />
        ) : activeModule === "settings" ? (
          <SettingsModule />
        ) : activeModule === "docs" ? (
          <MemoryModule
            workspaceOpen={workspaceInfo?.open === true}
            positions={positions}
            selectedPositionId={selectedId}
            position={card.data}
            initialSource={memorySource}
          />
        ) : <div className="owb-org-module">
          {/* #137 two-column workspace: the left column stacks the org chart
              and the position-record card (aligned, one column); the right
              column is owned solely by the conversation panel so the turn
              stream gets the full module height. */}
          <div className="owb-org-module__left">
          {/* P0 组织图：应用态汇报树节点图（纯展示，数据与侧栏树同源）。 */}
          <OrgChart
            snapshot={snapshot}
            loading={treeLoading}
            displayNames={positionNames}
            avatarColors={positionColors}
            selectedId={selectedId}
            onSelect={openConversation}
          />
          <div className="owb-position-column">
            <PositionCard
              position={card.data}
              loading={card.loading}
              notFound={card.notFound}
              consumption={selectedBudgetRatio}
              running={selectedId !== null && runningPositionIds.has(selectedId)}
              onRefresh={() => void refresh()}
              onContextSourceSelect={(source) => {
                setMemorySource(source.kind === "mem_drive" ? "drive" : "docs");
                setActiveModule("docs");
              }}
              actions={selectedPosition && selectedId && selectedId !== snapshot?.owner ? <DismissPositionDialog positionName={selectedPosition.name} descendantCount={selectedNode ? countDescendants(selectedNode) : 0} busy={orgBusy} onDismiss={() => dismissPosition(selectedId)} /> : undefined}
            />
          </div>
          </div>
          <TurnPanel
            key={workspaceInfo?.path}
            workspaceOpen={workspaceInfo?.open === true}
            positions={positions}
            selectedPositionId={selectedId}
            engine={turnEngine}
            engineAvailability={engineAvailability}
            turns={displayTurns}
            busy={turnBusy}
            employeeBusy={selectedId !== null && runningPositionIds.has(selectedId)}
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            sessionBusy={sessionBusy}
            onSelectPosition={openConversation}
            onSelectEngine={setTurnEngine}
            onCreateTurn={createTurn}
            onCancelTurn={cancelTurn}
            onVerdictTurn={verdictTurn}
            decidedApprovalIds={decidedApprovals}
            cancelling={turnCancelling}
            onSelectSession={selectSession}
            onCreateSession={createSession}
            onRotateSession={rotateSession}
            onSetSessionContext={setSessionContext}
          />
        </div>}
      </div>
    </AppShell>
    </div>
    </ConfigProvider>
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
function normalizePositionForDisplay(position: PositionCardData): PositionCardData {
  return {
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
  };
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

/** antd seed tokens per theme — values mirror antd-skin.css exactly so the
 * cssinjs layer and the CSS custom properties never disagree. */
const ANTD_SEED = {
  "light": {
    "colorPrimary": "#3e63dd",
    "colorPrimaryHover": "#3153c4",
    "colorPrimaryActive": "#3153c4",
    "colorPrimaryBg": "#edf1ff",
    "colorPrimaryBgHover": "#edf1ff",
    "colorPrimaryBorder": "#e2e5ed",
    "colorPrimaryBorderHover": "#c7cedb",
    "colorSuccess": "#2e7052",
    "colorSuccessHover": "#24573f",
    "colorSuccessActive": "#24573f",
    "colorSuccessBg": "#edf7f1",
    "colorSuccessBgHover": "#edf7f1",
    "colorSuccessBorder": "#e2e5ed",
    "colorSuccessBorderHover": "#c7cedb",
    "colorWarning": "#8a5a12",
    "colorWarningHover": "#75480b",
    "colorWarningActive": "#75480b",
    "colorWarningBg": "#fff5e4",
    "colorWarningBgHover": "#fff5e4",
    "colorWarningBorder": "#e2e5ed",
    "colorWarningBorderHover": "#c7cedb",
    "colorError": "#b83d3d",
    "colorErrorHover": "#a22f36",
    "colorErrorActive": "#a22f36",
    "colorErrorBg": "#fff0f0",
    "colorErrorBgHover": "#fff0f0",
    "colorErrorBorder": "#e2e5ed",
    "colorErrorBorderHover": "#c7cedb",
    "colorInfo": "#3e63dd",
    "colorInfoHover": "#3153c4",
    "colorInfoActive": "#3153c4",
    "colorInfoBg": "#edf1ff",
    "colorInfoBgHover": "#edf1ff",
    "colorInfoBorder": "#e2e5ed",
    "colorInfoBorderHover": "#c7cedb",
    "colorErrorBgFilledHover": "#fff0f0",
    "colorErrorBgActive": "#fff0f0",
    "colorLink": "#3e63dd",
    "colorLinkHover": "#3153c4",
    "colorLinkActive": "#3153c4",
    "colorBorder": "#e2e5ed",
    "colorBorderSecondary": "#e2e5ed",
    "colorBgBase": "#ffffff",
    "colorBgContainer": "#ffffff",
    "colorBgElevated": "#ffffff",
    "colorBgLayout": "#f7f8fb",
    "colorFillAlter": "#f4f5f8",
    "controlItemBgHover": "#e8ebf2",
    "controlItemBgActive": "#f3edfc",
    "controlItemBgActiveHover": "#f3edfc",
    "colorText": "#242630",
    "colorTextSecondary": "#596172",
    "colorTextTertiary": "#606a7b",
    "colorTextPlaceholder": "#606a7b",
    "colorTextDisabled": "#606a7b",
    "colorBgContainerDisabled": "#f4f5f8",
    "colorTextLightSolid": "#ffffff",
    "borderRadiusSM": 6,
    "borderRadiusLG": 12,
    "borderRadiusOuter": 16,
    "boxShadow": "0 4px 16px rgba(20, 21, 27, 0.1)",
    "boxShadowSecondary": "0 16px 48px rgba(20, 21, 27, 0.14)"
  },
  "dark": {
    "colorPrimary": "#86a0ff",
    "colorPrimaryHover": "#a0b4ff",
    "colorPrimaryActive": "#a0b4ff",
    "colorPrimaryBg": "#252e49",
    "colorPrimaryBgHover": "#252e49",
    "colorPrimaryBorder": "#343844",
    "colorPrimaryBorderHover": "#4b5262",
    "colorSuccess": "#84c7a3",
    "colorSuccessHover": "#a2dabb",
    "colorSuccessActive": "#a2dabb",
    "colorSuccessBg": "#20372c",
    "colorSuccessBgHover": "#20372c",
    "colorSuccessBorder": "#343844",
    "colorSuccessBorderHover": "#4b5262",
    "colorWarning": "#ddb35d",
    "colorWarningHover": "#efcc86",
    "colorWarningActive": "#efcc86",
    "colorWarningBg": "#352e20",
    "colorWarningBgHover": "#352e20",
    "colorWarningBorder": "#343844",
    "colorWarningBorderHover": "#4b5262",
    "colorError": "#ef9699",
    "colorErrorHover": "#ffb1b4",
    "colorErrorActive": "#ffb1b4",
    "colorErrorBg": "#3a242b",
    "colorErrorBgHover": "#3a242b",
    "colorErrorBorder": "#343844",
    "colorErrorBorderHover": "#4b5262",
    "colorInfo": "#86a0ff",
    "colorInfoHover": "#a0b4ff",
    "colorInfoActive": "#a0b4ff",
    "colorInfoBg": "#252e49",
    "colorInfoBgHover": "#252e49",
    "colorInfoBorder": "#343844",
    "colorInfoBorderHover": "#4b5262",
    "colorErrorBgFilledHover": "#3a242b",
    "colorErrorBgActive": "#3a242b",
    "colorLink": "#86a0ff",
    "colorLinkHover": "#a0b4ff",
    "colorLinkActive": "#a0b4ff",
    "colorBorder": "#343844",
    "colorBorderSecondary": "#343844",
    "colorBgBase": "#1c1e25",
    "colorBgContainer": "#1c1e25",
    "colorBgElevated": "#252831",
    "colorBgLayout": "#14151b",
    "colorFillAlter": "#171920",
    "controlItemBgHover": "#252831",
    "controlItemBgActive": "#30233f",
    "controlItemBgActiveHover": "#30233f",
    "colorText": "#e5e7ed",
    "colorTextSecondary": "#b1b7c5",
    "colorTextTertiary": "#969eaf",
    "colorTextPlaceholder": "#969eaf",
    "colorTextDisabled": "#969eaf",
    "colorBgContainerDisabled": "#171920",
    "colorTextLightSolid": "#14151b",
    "borderRadiusSM": 6,
    "borderRadiusLG": 12,
    "borderRadiusOuter": 16,
    "boxShadow": "0 4px 20px rgba(0, 0, 0, 0.35)",
    "boxShadowSecondary": "0 16px 48px rgba(0, 0, 0, 0.4)"
  }
} as const;

// Antd's dark algorithm derives a new primary color from its seed. Restore our
// explicit palette after derivation so native controls and CSS share colors.
function brandAlgorithm(
  algorithm: typeof theme.defaultAlgorithm,
  palette: typeof ANTD_SEED[keyof typeof ANTD_SEED],
): typeof theme.defaultAlgorithm {
  return (seed) => ({ ...algorithm(seed), ...palette });
}

const ANTD_ALGORITHM = {
  light: brandAlgorithm(theme.defaultAlgorithm, ANTD_SEED.light),
  dark: brandAlgorithm(theme.darkAlgorithm, ANTD_SEED.dark),
};

function Breadcrumbs({
  workspace,
}: {
  workspace: WorkspaceInfoResponse | null;
}) {
  if (workspace?.open !== true || !workspace.path) return null;
  return (
    <span className="owb-topbar-context">
      <span
        className="owb-workspace-location"
        title={workspace.path}
        aria-label={workspace.path}
      >
        <FolderOpen aria-hidden="true" size={12} />
        <span className="owb-workspace-location__path">{workspace.path}</span>
      </span>
    </span>
  );
}

interface ProjectSwitcherProps {
  workspace: WorkspaceInfoResponse | null;
  positionCount: number | null;
  disabled?: boolean;
  onOpenWorkspace: () => void;
  onCreateProject: () => void;
}

/**
 * Project context belongs above the organization tree, not in a second global
 * chrome row. The trigger is intentionally compact, while its menu keeps the
 * IDE-like open/create actions together with the current workspace context.
 */
function ProjectSwitcher({
  workspace,
  positionCount,
  disabled = false,
  onOpenWorkspace,
  onCreateProject,
}: ProjectSwitcherProps) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const open = workspace?.open === true;

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  return (
    <div className="owb-project-switcher" ref={rootRef}>
      <button
        type="button"
        className="owb-project-switcher__trigger"
        aria-label={t("project.switcherAria")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={disabled}
        onClick={() => setMenuOpen((current) => !current)}
      >
        <span className="owb-project-switcher__icon" aria-hidden="true">
          <FolderOpen size={14} />
        </span>
        <span className="owb-project-switcher__copy">
          <strong>{open ? workspace?.business ?? t("tree.workspaceFallback") : t("project.launcherTitle")}</strong>
        </span>
        <ChevronDown className="owb-project-switcher__chevron" aria-hidden="true" size={15} />
      </button>

      {menuOpen ? (
        <div className="owb-project-switcher__menu" role="menu" aria-label={t("project.switcherAria")}>
          {open ? (
            <section className="owb-project-switcher__current" aria-label={t("project.current")}>
              <p className="owb-project-switcher__eyebrow">{t("project.current")}</p>
              <div className="owb-project-switcher__current-row">
                <span className="owb-project-switcher__current-mark" aria-hidden="true"><Check size={12} /></span>
                <span className="owb-project-switcher__current-copy">
                  <strong>{workspace?.business ?? t("tree.workspaceFallback")}</strong>
                  <small title={workspace?.path}>{workspace?.path ?? t("project.localOnly")}</small>
                  <span>{positionCount === null ? t("project.positionsUnknown") : t("tree.positions", { count: positionCount })}</span>
                </span>
              </div>
            </section>
          ) : (
            <p className="owb-project-switcher__empty">{t("project.noProjectOpen")}</p>
          )}
          <div className="owb-project-switcher__actions">
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => { setMenuOpen(false); onOpenWorkspace(); }}
            >
              <FolderOpen aria-hidden="true" size={14} />
              <span><strong>{t("project.openAction")}</strong><small>{t("project.openActionHint")}</small></span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => { setMenuOpen(false); onCreateProject(); }}
            >
              <FolderPlus aria-hidden="true" size={14} />
              <span><strong>{t("project.newCta")}</strong><small>{t("project.newActionHint")}</small></span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
