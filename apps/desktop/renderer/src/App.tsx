import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button as AntButton, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import { OwbI18nProvider, useT, type OwbLocale } from "@org-workbench/ui";
import {
  AppShell,
  ModuleRail,
  Sidebar,
  Skeleton,
  Topbar,
} from "@fullstack-ai-infra/ui";
import { OrgTree, PositionCard } from "@org-workbench/ui";
import type { OrgDropPosition, PositionCardData } from "@org-workbench/ui";
import type {
  ChangeManifest,
  GroupTimeline,
  HealthResponse,
  OrgBackupEntry,
  OrgBackupsResponse,
  OrgTreeNodeV1,
  OrgTreeSnapshot,
  PositionMode,
  ReportsResponse,
  TurnHistory,
  WorkbenchSession,
  WorkbenchSessionList,
  WorkspaceInfoResponse,
} from "@org-workbench/shared";
import { Cog, FileChartColumn, FolderTree, HardDrive, Network, Plus, ShieldAlert, UsersRound } from "lucide-react";
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
  cancelPendingTurn,
  clearPersonalTurnState,
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
import { DocsModule } from "./docs/DocsModule";
import { ReportsCenter } from "./reports/ReportsCenter";
import { ApprovalQueue, type ApprovalQueueItem } from "./approvals";
import { decodeEscapedUnicode } from "./display-text";
import { DriveModule } from "./drive/DriveModule";
import { SettingsModule } from "./settings/SettingsModule";

interface PositionCardState {
  loading: boolean;
  data: PositionCardData | null;
  notFound: boolean;
}

/**
 * D1 renderer: AppShell four-zone layout (spec §1) — ModuleRail (org active,
 * drive/docs modules), Topbar (breadcrumbs + engine status + budget
 * summary), Sidebar (--ui-sidebar-wide 288px, OrgTree), main (PositionCard).
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
    "org" | "groups" | "reports" | "approvals" | "drive" | "docs" | "settings"
  >("org");
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
  /** P0 组织图：mode / title 展示面按岗位 id（来自 refresh 已在做的
   * /positions/:id 读取，与侧栏树 displayNames 同源；不新增 IPC 调用）。 */
  const [positionModes, setPositionModes] = useState<Record<string, PositionMode>>({});
  const [positionTitles, setPositionTitles] = useState<Record<string, string>>({});
  const [turnEngine, setTurnEngine] = useState<TurnEngine>("qoder");
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [turnStream, setTurnStream] = useState<TurnStreamState>(EMPTY_TURN_STREAM);
  const [turnBusy, setTurnBusy] = useState(false);
  const [turnCancelling, setTurnCancelling] = useState(false);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<WorkbenchSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const selectedSessionIdRef = useRef<string | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
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
  /** Org-tree group entry (#53): prefilled draft members handed to the
   * GroupsPanel create panel; nonce re-fires repeated entries. */
  const [groupDraftSeed, setGroupDraftSeed] = useState<{ members: string[]; nonce: number } | null>(null);
  /** 亮/暗跟随 <html data-theme>，antd cssinjs 与 --ui-* skin 同步切换。 */
  const themeMode = useThemeMode();
  /** #146：界面文案唯一入口；数据层文案不经过这里。 */
  const t = useT();

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
        const cardEntries = await Promise.all(positionIds.map(async (id): Promise<[string, { name: string; color?: string; mode?: PositionMode; title?: string }]> => {
          const response = await window.owb.position(id);
          const body = response.body as { position?: PositionCardData };
          const position = response.status === 200 && body.position
            ? normalizePositionForDisplay(body.position)
            : undefined;
          const color = position?.metadata?.color;
          const title = position?.metadata?.title;
          return [id, {
            name: position?.name ?? id,
            ...(typeof color === "string" && color.length > 0 ? { color } : {}),
            ...(position ? { mode: position.mode } : {}),
            ...(typeof title === "string" && title.length > 0 ? { title } : {}),
          }];
        }));
        const names = Object.fromEntries(cardEntries.map(([id, entry]) => [id, entry.name]));
        positionNamesRef.current = names;
        setPositionNames(names);
        setPositionColors(Object.fromEntries(cardEntries.filter(([, entry]) => "color" in entry).map(([id, entry]) => [id, (entry as { color: string }).color])));
        setPositionModes(Object.fromEntries(cardEntries.filter(([, entry]) => entry.mode !== undefined).map(([id, entry]) => [id, entry.mode as PositionMode])));
        setPositionTitles(Object.fromEntries(cardEntries.filter(([, entry]) => entry.title !== undefined).map(([id, entry]) => [id, entry.title as string])));
        await Promise.all([loadBackups(), loadReports()]);
      } else {
        setSnapshot(null);
        positionNamesRef.current = {};
        setPositionNames({});
        setPositionColors({});
        setPositionModes({});
        setPositionTitles({});
      }
    } else {
      setSnapshot(null);
      positionNamesRef.current = {};
      setPositionNames({});
      setPositionColors({});
      setPositionModes({});
      setPositionTitles({});
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
  }, [loadBackups, loadReports]);

  const loadPosition = useCallback(async (id: string) => {
    setCard({ loading: true, data: null, notFound: false });
    const res = await window.owb.position(id);
    if (selectedIdRef.current !== id) return;
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

  const loadTurnHistory = useCallback(async (id: string) => {
    const sessionId = selectedSessionIdRef.current;
    if (sessionId === null) {
      setTurns([]);
      return true;
    }
    try {
      const res = await window.owb.sessionTurnHistory(sessionId);
      if (selectedIdRef.current !== id || selectedSessionIdRef.current !== sessionId) return false;
      if (res.status !== 200) {
        setTurnError(apiErrorMessage(res.body, t("turn.historyFail")));
        return false;
      }
      const history = res.body as TurnHistory;
      setTurns(adaptTurnHistory(history, positionNamesRef.current[id] ?? id, t("turn.unrenderableOutput")));
      setTurnError(null);
      return true;
    } catch {
      if (selectedIdRef.current === id && selectedSessionIdRef.current === sessionId) {
        setTurnError(t("turn.historyFailOffline"));
      }
      return false;
    }
  }, [t]);

  const loadSessions = useCallback(async (id: string) => {
    try {
      const res = await window.owb.sessions(id);
      if (selectedIdRef.current !== id) return false;
      if (res.status !== 200) {
        setSessions([]);
        setSelectedSessionId(null);
        selectedSessionIdRef.current = null;
        setTurnError(apiErrorMessage(res.body, t("turn.sessionsFail")));
        return false;
      }
      const list = res.body as WorkbenchSessionList;
      setSessions(list.sessions);
      const current = selectedSessionIdRef.current;
      const next = current && list.sessions.some((session) => session.sessionId === current)
        ? current
        : list.activeSessionId;
      selectedSessionIdRef.current = next;
      setSelectedSessionId(next);
      setTurnError(null);
      return true;
    } catch {
      if (selectedIdRef.current === id) setTurnError(t("turn.sessionsFailOffline"));
      return false;
    }
  }, [t]);

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
    void loadSessions(selectedId);
  }, [loadPosition, loadSessions, selectedId, workspaceInfo?.open, workspaceInfo?.path]);

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
        setTurnStream((current) => applyTurnEvent(current, envelope as TurnStreamEnvelope));
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
      if (state === "connecting") setTurnStream((current) => resetStreamSeq(current));
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
  }, [loadReports, loadTurnHistory, refresh]);

  const selectPosition = useCallback((id: string) => {
    selectedIdRef.current = id;
    selectedSessionIdRef.current = null;
    setSelectedSessionId(null);
    setSessions([]);
    setTurns([]);
    setSelectedId(id);
  }, []);

  const selectSession = useCallback((sessionId: string) => {
    selectedSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
    setTurns([]);
    setTurnStream((current) => clearPersonalTurnState(current));
    setTurnError(null);
  }, []);

  const createSession = useCallback(async () => {
    const positionId = selectedIdRef.current;
    if (positionId === null) return;
    setSessionBusy(true);
    setTurnError(null);
    try {
      const res = await window.owb.createSession({ positionId });
      if (res.status !== 201) {
        setTurnError(apiErrorMessage(res.body, t("turn.createSessionFail")));
        return;
      }
      const session = res.body as WorkbenchSession;
      selectedSessionIdRef.current = session.sessionId;
      setSelectedSessionId(session.sessionId);
      await loadSessions(positionId);
    } catch {
      setTurnError(t("turn.createSessionFailOffline"));
    } finally {
      setSessionBusy(false);
    }
  }, [loadSessions, t]);

  /** #248 R2 ② 点人即聊：挂载该岗位的 active 会话，没有就自动创建，输入立即可用。 */
  const ensureActiveSession = useCallback(async (positionId: string) => {
    setSessionBusy(true);
    setTurnError(null);
    try {
      const ok = await loadSessions(positionId);
      if (ok && selectedSessionIdRef.current === null) {
        const res = await window.owb.createSession({ positionId });
        if (res.status === 201) {
          const session = res.body as WorkbenchSession;
          selectedSessionIdRef.current = session.sessionId;
          setSelectedSessionId(session.sessionId);
          await loadSessions(positionId);
        }
      }
    } catch {
      // 会话自动挂载失败不阻断：操作员仍可在「会话设置」里手动新建。
    } finally {
      setSessionBusy(false);
    }
  }, [loadSessions]);

  /** #248 R2 ②：组织树点某人 = 直接打开与他的对话（一键）。 */
  const openConversation = useCallback((positionId: string) => {
    selectPosition(positionId);
    void ensureActiveSession(positionId);
  }, [selectPosition, ensureActiveSession]);

  const rotateSession = useCallback(async (sessionId: string) => {
    const positionId = selectedIdRef.current;
    if (positionId === null) return;
    setSessionBusy(true);
    setTurnError(null);
    try {
      const res = await window.owb.rotateSession(sessionId);
      if (res.status !== 200 && res.status !== 201) {
        setTurnError(apiErrorMessage(res.body, t("turn.rotateFail")));
        return;
      }
      const session = res.body as WorkbenchSession;
      selectedSessionIdRef.current = session.sessionId;
      setSelectedSessionId(session.sessionId);
      setTurns([]);
      setTurnStream((current) => clearPersonalTurnState(current));
      await loadSessions(positionId);
    } catch {
      setTurnError(t("turn.rotateFailOffline"));
    } finally {
      setSessionBusy(false);
    }
  }, [loadSessions, t]);

  const createTurn = useCallback(async (request: CreateTurnRequest) => {
    const sessionId = selectedSessionIdRef.current;
    if (sessionId === null) {
      setTurnError(t("turn.needSession"));
      return false;
    }
    setTurnBusy(true);
    setTurnError(null);
    setTurnStream((current) =>
      beginPendingTurn(current, {
        positionId: request.positionId,
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
        setTurnError(message);
        setTurnStream((current) => cancelPendingTurn(current));
        return false;
      }
      if (selectedIdRef.current === request.positionId) {
        const returned = adaptTurnRecord(
          res.body,
          positionNamesRef.current[request.positionId] ?? request.positionId,
          t("turn.unrenderableOutput"),
        );
        setTurns((current) => replaceTurn(current, returned));
      }
      const body = res.body as { runId?: unknown };
      setTurnStream((current) =>
        settlePendingTurn(current, {
          runId: typeof body.runId === "string" ? body.runId : null,
          positionId: request.positionId,
        }),
      );
      await loadTurnHistory(request.positionId);
      return true;
    } catch {
      setTurnStream((current) => cancelPendingTurn(current));
      setTurnError(t("turn.createFailOffline"));
      return false;
    } finally {
      setTurnBusy(false);
    }
  }, [loadTurnHistory, t]);

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
      setTurnStream((current) =>
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
    [],
  );

  const reconcileGroup = useCallback((timeline: GroupTimeline) => {
    setTurnStream((current) => reconcileGroupTimeline(current, timeline));
  }, []);

  /** Operator cancel (issue #25 Slice A): the control plane settles the turn
   * as indeterminate/turn_cancelled; the in-flight POST readback and the
   * history reload remain the only authorities for the final record. */
  const cancelTurn = useCallback(async (positionId: string) => {
    setTurnCancelling(true);
    setTurnError(null);
    try {
      const res = await window.owb.cancelTurn(positionId);
      if (res.status !== 200) {
        setTurnError(apiErrorMessage(res.body, t("turn.cancelRejected")));
      }
    } catch {
      setTurnError(t("turn.cancelFailOffline"));
    } finally {
      setTurnCancelling(false);
    }
  }, [t]);

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
      setOrgFeedback({ tone: "warn", text: t("org.stalePosition", { id }) });
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
    return applyOrg({ schemaVersion: "change-manifest.v1", changes: [{ op: "move", id, reportTo }] }, t("org.movedTo", { id, target: reportTo ?? t("org.enterpriseRoot") }));
  }, [applyOrg, snapshot, t]);

  /** #33: hire is the only creation channel; success linkage = refresh + select the new node. */
  const hiredPosition = useCallback(async (positionId: string, name: string) => {
    setOrgFeedback({ tone: "info", text: t("org.hired", { name }) });
    await refresh();
    setSelectedId(positionId);
  }, [refresh, t]);

  const dismissPosition = useCallback(async (id: string) =>
    applyOrg({ schemaVersion: "change-manifest.v1", changes: [{ op: "delete", id }] }, t("org.dismissed", { id })), [applyOrg, t]);

  /** Same-level insertion from an insertion-line drop or ⌘↑/⌘↓ (#32): the
   * reorder op carries the final sibling order; a cross-parent insertion is
   * submitted atomically as move + reorder in one manifest. */
  const reorderPosition = useCallback(async (drop: OrgDropPosition) => {
    if (!snapshot) return false;
    const source = findNodeById(snapshot.tree, drop.id);
    if (!source) {
      setOrgFeedback({ tone: "warn", text: t("org.stalePosition", { id: drop.id }) });
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
        t("org.reordered", { id: drop.id }),
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
      t("org.movedTo", { id: drop.id, target: drop.parentId ?? t("org.enterpriseRoot") }),
    );
  }, [applyOrg, snapshot, t]);

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
      const body = response.body as { positionId: string; restored: boolean };
      setOrgFeedback({ tone: "info", text: body.restored ? t("org.restored", { id: body.positionId }) : t("org.alreadyRestored", { id: body.positionId }) });
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
    return flattenPositionIds(snapshot.tree).map((id) => ({ id, name: positionNames[id] ?? id }));
  }, [positionNames, snapshot]);
  const selectedNode = selectedId && snapshot ? findNodeById(snapshot.tree, selectedId) : null;
  const selectedBudgetReport = selectedId ? reports?.budgets.find((budget) => budget.positionId === selectedId) : null;
  const selectedBudgetRatio = selectedBudgetReport?.latestTurn && selectedBudgetReport.declared.perTask.tokens
    ? selectedBudgetReport.latestTurn.totalTokens / selectedBudgetReport.declared.perTask.tokens
    : null;

  /** Position ids with a turn in flight — drives the tree/card status lights
   * (#73 signature move ②). Observed from the SSE run stream only; a position
   * with no live run is never shown as running. */
  const runningPositionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of Object.values(turnStream.runs)) {
      if (run.positionId) ids.add(run.positionId);
    }
    return ids;
  }, [turnStream.runs]);

  /** Per-position per-task consumption ratios for the tree's micro budget
   * bars. Only positions with a real latest-turn fact get a ratio; the rest
   * stay in declaration phase rather than rendering a fabricated 0%. */
  const budgetRatios = useMemo(() => {
    const ratios: Record<string, number | null> = {};
    for (const budget of reports?.budgets ?? []) {
      const cap = budget.declared.perTask.tokens;
      ratios[budget.positionId] = budget.latestTurn && cap
        ? budget.latestTurn.totalTokens / cap
        : null;
    }
    return ratios;
  }, [reports]);
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
    codex: {
      configured: health?.hosts?.codex?.configured === true,
      ready: health?.hosts?.codex?.ready === true,
      reason: health?.hosts?.codex?.nextStep ?? t("misc.codexHostUnknown"),
    },
  }), [health, t]);

  const displayTurns = useMemo(() => {
    const historyRunIds = new Set(turns.flatMap((turn) => (turn.runId ? [turn.runId] : [])));
    const live: TurnRecord[] = selectedId === null
      ? []
      : Object.entries(turnStream.runs)
          .filter(([runId, run]) => run.groupRef === undefined && run.positionId === selectedId && !historyRunIds.has(runId))
          .map(([runId, run]) => ({
            id: `live-${runId}`,
            positionId: run.positionId,
            positionName: positionNames[run.positionId] ?? run.positionId,
            engine: run.engine,
            input: run.input,
            status: "running" as const,
            createdAt: run.startedAt,
            ...(run.text !== "" ? { output: run.text } : {}),
            ...(run.totalTokens !== null ? { totalTokens: run.totalTokens } : {}),
          }));
    if (live.length === 0) return turns;
    return [...turns, ...live].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [positionNames, selectedId, turnStream.runs, turns]);

  // ADR-0002: Ant Design is the shared design language; token values are antd
  // official palette values, consumed via ConfigProvider — no ad-hoc theming.
  // The provider lives here (not in main.tsx) so tests render the same config;
  // autoInsertSpace is off so two-char CJK labels keep exact accessible names.
  return (
    <ConfigProvider
      locale={locale === "en" ? enUS : zhCN}
      button={{ autoInsertSpace: false }}
      theme={{
        algorithm: themeMode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          // #73 Control Plane v2（取代 #31 冻结值）：全应用单一强调色，一次定死
          // （Linear lavender 纪律样本）；AI 紫 #722ed1 仍仅限 AI affordance，
          // 不在此列。状态色/描边改用 control-plane 设计稿的哑光调，与
          // antd-skin.css 的 --ui-* 同步（含暗色阶，见 ANTD_SEED）。
          ...ANTD_SEED[themeMode],
          // 控件尺寸对齐设计稿：.sel 高 32 / 字号 12 / 圆角 8，.btn-sm 高 26。
          // antd 默认 14px + 36px 在这套密度里明显偏大（岗位下拉尤其突兀）。
          fontSize: 12,
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
          fontFamily:
            "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
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
        <span className="owb-wintitle__name">org-workbench</span>
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
            // mem remains an upstream data plane, but its management surface
            // is rendered inside Workbench so operators do not need a second
            // client. DriveModule only consumes the bounded bridge.
            { id: "drive", label: t("rail.drive"), icon: <HardDrive aria-hidden="true" size={16} />, active: activeModule === "drive", onSelect: () => setActiveModule("drive") },
            { id: "docs", label: t("rail.docs"), icon: <FolderTree aria-hidden="true" size={16} />, active: activeModule === "docs", onSelect: () => setActiveModule("docs") },
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
              <div className="owb-side-head">
                {workspaceInfo?.open === true ? (
                  <>
                    <AntButton size="small" disabled={orgBusy} onClick={() => void undoLastAdjustment()} title={t("tree.undoTitle")}>{t("tree.undo")}</AntButton>
                    {/* ＋ 走装饰性图标而不是文案前缀，可及名保持「创建员工」。 */}
                    <AntButton size="small" type="primary" disabled={orgBusy} icon={<Plus aria-hidden="true" size={12} />} onClick={() => setTreeHireParent(selectedId ?? snapshot?.owner ?? null)}>{t("tree.create")}</AntButton>
                  </>
                ) : null}
              </div>
              {/* 工作区条（设计稿 .workspace-strip）：名称 + open 状态 + 岗位数 */}
              {workspaceInfo?.open === true ? (
                <div className="owb-workspace-strip">
                  <span className="owb-workspace-strip__name">{workspaceInfo.business ?? t("tree.workspaceFallback")}</span>
                  <span className="owb-workspace-strip__meta">
                    <span className="owb-workspace-strip__open" aria-hidden="true">●</span>
                    {t("tree.open")}
                    {snapshot ? ` · ${t("tree.positions", { count: snapshot.positionCount })}` : null}
                  </span>
                </div>
              ) : null}
            </>
          }
          footer={
            workspaceInfo?.open === true ? <BackupTray backups={backups} busy={orgBusy} onRestore={restorePosition} /> : (
              <AntButton type="primary" block onClick={() => void openWorkspace()}>
                {t("tree.openCta")}
              </AntButton>
            )
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
                  budgetRatios={budgetRatios}
                  selectedId={selectedId}
                  onSelect={selectPosition}
                  onMove={(id, reportTo) => void movePosition(id, reportTo)}
                  onDropPosition={(drop) => void reorderPosition(drop)}
                  onHireEntry={(parent) => setTreeHireParent(parent)}
                  onGroupEntry={(positionId) => {
                    setGroupDraftSeed({ members: [positionId], nonce: Date.now() });
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
              open={treeHireParent !== undefined}
              positions={positions}
              presetReportTo={treeHireParent ?? null}
              onClose={() => setTreeHireParent(undefined)}
              onHired={(positionId, name) => void hiredPosition(positionId, name)}
            />
          ) : null}
        </Sidebar>
      }
      topbar={
        <Topbar
          breadcrumbs={<Breadcrumbs workspace={workspaceInfo} selected={selectedPosition} />}
          actions={
            <div className="owb-topbar-actions">
              {/* 设计稿 .mini-budget：岗位 id · 110px 轨道 · 百分比。声明期
                  （无真实用量事实）显示「声明期」而不是伪造的 0%。 */}
              {selectedPosition?.budget && selectedId ? (
                <MiniBudget positionId={selectedId} ratio={selectedBudgetRatio} />
              ) : null}
              {/* 设计稿 .src 药丸：状态灯 + 文案，取代 DS 的 SourceStatus 外观，
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
            workspaceOpen={workspaceInfo?.open === true}
            positions={positions}
            positionNames={positionNames}
            positionColors={positionColors}
            draftSeed={groupDraftSeed}
            engine={turnEngine}
            engineAvailability={engineAvailability}
            liveRuns={turnStream.runs}
            onSelectEngine={setTurnEngine}
            onSpawnRuns={spawnGroupRuns}
            onReconcileTimeline={reconcileGroup}
          />
        ) : activeModule === "drive" ? (
          <DriveModule workspaceOpen={workspaceInfo?.open === true} />
        ) : activeModule === "settings" ? (
          <SettingsModule />
        ) : activeModule === "docs" ? (
          <DocsModule
            workspaceOpen={workspaceInfo?.open === true}
            positions={positions}
            selectedPositionId={selectedId}
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
            displayTitles={positionTitles}
            displayModes={positionModes}
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
              actions={selectedPosition && selectedId && selectedId !== snapshot?.owner ? <DismissPositionDialog positionName={selectedPosition.name} positionId={selectedId} descendantCount={selectedNode ? countDescendants(selectedNode) : 0} busy={orgBusy} onDismiss={() => dismissPosition(selectedId)} /> : undefined}
            />
          </div>
          </div>
          <TurnPanel
            workspaceOpen={workspaceInfo?.open === true}
            positions={positions}
            selectedPositionId={selectedId}
            engine={turnEngine}
            engineAvailability={engineAvailability}
            turns={displayTurns}
            busy={turnBusy}
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            sessionBusy={sessionBusy}
            onSelectPosition={selectPosition}
            onSelectEngine={setTurnEngine}
            onCreateTurn={createTurn}
            onCancelTurn={cancelTurn}
            onVerdictTurn={verdictTurn}
            decidedApprovalIds={decidedApprovals}
            sseConnected={sseState === "connected"}
            selectedMode={card.data?.mode ?? null}
            selectedBudgetLabel={perTaskBudgetLabel(card.data)}
            cancelling={turnCancelling}
            onSelectSession={selectSession}
            onCreateSession={createSession}
            onRotateSession={rotateSession}
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
    const code = (body as { code?: unknown }).code;
    if (typeof message === "string" && typeof code === "string") return `${code}: ${message}`;
    if (typeof message === "string") return message;
    if (typeof code === "string") return `${fallback}: ${code}`;
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

/** Per-task budget label for the boundary chip (设计稿 `40k/task`). Tokens
 * win over iterations because the engine bills tokens; a declaration with
 * neither cap renders — rather than a fabricated number. */
const BUDGET_COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const BUDGET_PLAIN = new Intl.NumberFormat("en-US");
function perTaskBudgetLabel(position: PositionCardData | null): string | null {
  const perTask = position?.budget?.perTask;
  if (!perTask) return null;
  if (typeof perTask.tokens === "number") {
    return `${BUDGET_COMPACT.format(perTask.tokens)}/task`;
  }
  if (typeof perTask.iterations === "number") return `${BUDGET_PLAIN.format(perTask.iterations)} iters/task`;
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
  light: {
    colorPrimary: "#5E6AD2",
    colorSuccess: "#3F7D4E",
    colorWarning: "#A86A0A",
    colorError: "#C04A3E",
    colorInfo: "#5E6AD2",
    colorLink: "#5E6AD2",
    colorBorder: "#DCD7CA",
    colorBorderSecondary: "#E5E1D6",
  },
  dark: {
    colorPrimary: "#8B93E0",
    colorSuccess: "#84B77C",
    colorWarning: "#D3A24F",
    colorError: "#D98276",
    colorInfo: "#8B93E0",
    colorLink: "#8B93E0",
    colorBorder: "#33372F",
    colorBorderSecondary: "#2C302A",
  },
} as const;

/** Topbar mini budget gauge (设计稿 .mini-budget). Declaration phase keeps
 * the track dim and labels it 声明期 — a position with no turn facts never
 * renders a fabricated percentage. */
function MiniBudget({ positionId, ratio }: { positionId: string; ratio: number | null }) {
  const t = useT();
  const declared = ratio === null;
  const pct = declared ? 100 : Math.min(Math.max(Math.round(ratio * 100), 0), 100);
  const over = !declared && ratio > 1;
  return (
    <span className="owb-mini-budget">
      <span className="owb-mini-budget__label">{positionId}</span>
      <span
        className="owb-mini-budget__track"
        role="meter"
        aria-label={declared ? t("pos.miniBudgetDeclared", { id: positionId }) : t("pos.miniBudgetConsumed", { id: positionId })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={declared ? undefined : Math.round(ratio * 100)}
      >
        <i
          style={{
            width: `${pct}%`,
            opacity: declared ? 0.32 : 1,
            ...(over ? { background: "var(--ui-danger)" } : {}),
          }}
        />
      </span>
      <span className="owb-mini-budget__label">
        {declared ? t("rep.declaredPhase") : `${Math.round(ratio * 100)}%`}
      </span>
    </span>
  );
}

function Breadcrumbs({
  workspace,
  selected,
}: {
  workspace: WorkspaceInfoResponse | null;
  selected: { id: string } | null;
}) {
  const t = useT();
  if (workspace?.open !== true) {
    return <span className="owb-breadcrumb owb-muted">{t("misc.workspaceClosedBc")}</span>;
  }
  // 设计稿：business / positions / <id>，末段是 primary 药丸。岗位 id（而不是
  // 展示名）与树标签、证据里的标识保持一致。
  const parts: string[] = [workspace.business ?? t("tree.workspaceFallback")];
  if (selected) parts.push("positions", selected.id);
  // 设计稿的面包屑用独立的 "/" 分隔元素（首段展示字体、末段 primary 药丸）。
  return (
    <span className="owb-breadcrumbs">
      {parts.map((part, index) => (
        <Fragment key={`${part}-${index}`}>
          {index > 0 ? (
            <span className="owb-breadcrumb-sep" aria-hidden="true">
              /
            </span>
          ) : null}
          <span className="owb-breadcrumb">{part}</span>
        </Fragment>
      ))}
    </span>
  );
}
