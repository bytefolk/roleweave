import { useCallback, useEffect, useRef, useState } from "react";
import { Button as AntButton, Checkbox, Dropdown, Input, Modal, Select } from "antd";
import { ArrowLeft, MoreHorizontal, Target, AlertTriangle, BriefcaseBusiness, Plus, Search, Circle } from "lucide-react";
import { PositionAvatar } from "../PositionAvatar.js";
import { useT } from "@roleweave/ui";
import {
  canTransitionGoalStatus,
  goalStatuses,
  type GoalDetail,
  type GoalStatus,
  type GoalSummary,
} from "@roleweave/shared/goals";
import type { TurnEngine } from "@roleweave/shared";
import { isPendingTaskCollaboration, type AgentTask } from "@roleweave/shared/task-board";
import { ProjectBoard } from "./ProjectBoard.js";
import "./goals-project.css";
import "./goals-workspace.css";
import { GoalEvidence } from "./GoalEvidence.js";
import { GoalCreateDialog } from "./GoalCreateDialog.js";
import { GoalCriteriaDialog } from "./GoalCriteriaDialog.js";

interface GoalsModuleProps {
  workspaceOpen: boolean;
  presentation?: "goals" | "projects";
  workspaceKey?: string;
  positionNames?: Record<string, string>;
  positionEngines?: Record<string, TurnEngine>;
  positionAvatars?: Record<string, import("../PositionAvatar.js").AvatarValue>;
  positionAvatarSources?: Record<string, string>;
  ownerPositionId?: string;
  onOpenApprovals?: () => void;
  onOpenBoundSession?: (positionId: string, sessionId?: string, turnId?: string) => void;
}
const rememberedSelection = new Map<string, string>();
const STATUS_BADGE: Record<string, string> = {
  open: "owb-badge--info",
  in_progress: "owb-badge--warn",
  completed: "owb-badge--ok",
  cancelled: "owb-badge--muted",
};
const HEALTH_DOT: Record<string, string> = {
  on_track: "owb-health--ok",
  at_risk: "owb-health--warn",
  blocked: "owb-health--bad",
  unknown: "owb-health--unknown",
};
function errorMessage(body: unknown, fallback: string) {
  return body &&
    typeof body === "object" &&
    "message" in body &&
    typeof body.message === "string"
    ? body.message
    : fallback;
}

export function GoalsModule(props: GoalsModuleProps) {
  return (
    <GoalsWorkspace
      key={`${props.presentation ?? "goals"}:${props.workspaceOpen}:${props.workspaceKey ?? ""}`}
      {...props}
    />
  );
}

function GoalsWorkspace({ workspaceOpen, workspaceKey, presentation = "goals", positionNames = {}, positionEngines = {}, positionAvatars = {}, positionAvatarSources = {}, ownerPositionId, onOpenApprovals, onOpenBoundSession }: GoalsModuleProps) {
  const t = useT();
  const projectMode = presentation === "projects";
  const selectionKey = workspaceKey ? `${presentation}:${workspaceKey}` : undefined;
  const Overview = projectMode ? "details" : "div";
  const ActivitySection = projectMode ? "section" : "details";
  const [view, setView] = useState<"goals" | "board">("goals");
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [showTaskCreate, setShowTaskCreate] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskTarget, setTaskTarget] = useState("");
  const [taskUrgent, setTaskUrgent] = useState(false);
  const [taskContractor, setTaskContractor] = useState(false);
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    selectionKey ? (rememberedSelection.get(selectionKey) ?? null) : null,
  );
  const selectedRef = useRef(selectedId);
  const [detail, setDetail] = useState<GoalDetail | null>(null);
  const [loading, setLoading] = useState(workspaceOpen);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [criteriaGoalId, setCriteriaGoalId] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const mutationLock = useRef(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<GoalStatus | "all">("all");
  const [mobileDetail, setMobileDetail] = useState(false);
  const alive = useRef(true);
  const listVersion = useRef(0);
  const detailVersion = useRef(0);
  const tasksVersion = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      listVersion.current += 1;
      detailVersion.current += 1;
      tasksVersion.current += 1;
    };
  }, []);

  const selectGoal = useCallback(
    (id: string | null) => {
      if (id !== selectedRef.current) {
        detailVersion.current += 1;
        setDetail(null);
        setDetailError(null);
        setActionError(null);
        setCriteriaGoalId(null);
      }
      selectedRef.current = id;
      setSelectedId(id);
      if (selectionKey) {
        if (id) rememberedSelection.set(selectionKey, id);
        else rememberedSelection.delete(selectionKey);
        if (rememberedSelection.size > 50)
          rememberedSelection.delete(rememberedSelection.keys().next().value!);
      }
    },
    [selectionKey],
  );

  const loadGoals = useCallback(
    async (preferredId?: string) => {
      if (!workspaceOpen) return;
      const version = ++listVersion.current;
      setLoading(true);
      setError(null);
      try {
        const response = await window.owb.goals();
        if (!alive.current || version !== listVersion.current) return;
        if (response.status !== 200)
          throw new Error(errorMessage(response.body, t(projectMode ? "project.projectLoadError" : "goals.loadError")));
        const next = response.body.goals;
        setGoals(next);
        const wanted = preferredId ?? selectedRef.current;
        selectGoal(
          next.some((goal) => goal.goalId === wanted)
            ? wanted!
            : (next[0]?.goalId ?? null),
        );
      } catch (cause) {
        if (alive.current && version === listVersion.current)
          setError(
            cause instanceof Error ? cause.message : t(projectMode ? "project.projectLoadError" : "goals.loadError"),
          );
      } finally {
        if (alive.current && version === listVersion.current) setLoading(false);
      }
    },
    [workspaceOpen, selectGoal, t],
  );

  const loadDetail = useCallback(
    async (goalId: string) => {
      const version = ++detailVersion.current;
      setDetailError(null);
      try {
        const response = await window.owb.goal(goalId);
        if (
          !alive.current ||
          version !== detailVersion.current ||
          selectedRef.current !== goalId
        )
          return;
        if (response.status !== 200)
          throw new Error(errorMessage(response.body, t(projectMode ? "project.projectLoadError" : "goals.loadError")));
        setDetail(response.body);
      } catch (cause) {
        if (
          alive.current &&
          version === detailVersion.current &&
          selectedRef.current === goalId
        )
          setDetailError(
            cause instanceof Error ? cause.message : t(projectMode ? "project.projectLoadError" : "goals.loadError"),
          );
      }
    },
    [t],
  );

  useEffect(() => {
    void loadGoals();
  }, [loadGoals]);
  const reloadTasks = useCallback(async () => {
    if (!workspaceOpen || typeof window.owb.tasks !== "function") return;
    const version = ++tasksVersion.current;
    const isCurrent = () => alive.current && version === tasksVersion.current;
    setTasksLoading(true);
    setTaskError(null);
    try {
      const response = await window.owb.tasks();
      if (!isCurrent()) return;
      if (response.status !== 200) throw new Error(errorMessage(response.body, t("tasks.loadError")));
      setTasks(response.body.tasks);
    } catch (cause) {
      if (isCurrent()) setTaskError(cause instanceof Error ? cause.message : t("tasks.loadError"));
    } finally {
      if (isCurrent()) setTasksLoading(false);
    }
  }, [workspaceOpen, t]);
  useEffect(() => {
    if (view !== "board") return;
    void reloadTasks();
    const off = window.owb.onSseStatus?.((state) => {
      if (state === "connected") void reloadTasks();
    });
    return () => { tasksVersion.current += 1; off?.(); };
  }, [view, reloadTasks]);
  const createTask = useCallback(async () => {
    const owner = ownerPositionId;
    if (!owner || !taskTarget || !taskTitle.trim()) return;
    const response = await window.owb.createTask({ targetPositionId: taskTarget, title: taskTitle.trim(), urgent: taskUrgent, contractor: taskContractor });
    if (response.status === 201) {
      setShowTaskCreate(false); setTaskTitle(""); setTaskUrgent(false); setTaskContractor(false);
      await reloadTasks();
    }
  }, [ownerPositionId, reloadTasks, taskContractor, taskTarget, taskTitle, taskUrgent]);
  const decideTask = useCallback(async (task: AgentTask, decision: "accept" | "decline") => {
    const response = await window.owb.decideTask({ taskId: task.taskId, decision });
    if (response.status === 200) await reloadTasks();
  }, [reloadTasks]);
  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);
  useEffect(() => {
    if (!workspaceOpen) return;
    return window.owb.onEvent((event: unknown) => {
      const e = event as { type?: string };
      if (
        e.type === "goal.created" ||
        e.type === "goal.updated" ||
        e.type === "goal.deleted"
      ) {
        void loadGoals();
        if (selectedRef.current) void loadDetail(selectedRef.current);
        if (view === "board") void reloadTasks();
      }
    });
  }, [workspaceOpen, loadGoals, loadDetail, view, reloadTasks]);

  // Refresh execution evidence without unmounting an open task editor.
  useEffect(() => {
    if (!workspaceOpen || !projectMode) return;
    const timer = window.setInterval(() => {
      if (selectedRef.current) void loadDetail(selectedRef.current);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [workspaceOpen, projectMode, loadDetail]);

  const changeStatus = async (status: GoalStatus) => {
    const id = selectedRef.current;
    if (
      !id ||
      !detail ||
      mutationLock.current ||
      !canTransitionGoalStatus(detail.goal.status, status) ||
      status === detail.goal.status
    )
      return;
    mutationLock.current = true;
    setMutating(true);
    setActionError(null);
    try {
      const response = await window.owb.updateGoal({ goalId: id, status });
      if (!alive.current || selectedRef.current !== id) return;
      if (response.status !== 200)
        throw new Error(
          errorMessage(response.body, t(projectMode ? "project.projectStatusChangeFail" : "goals.statusChangeFail")),
        );
      await Promise.all([loadGoals(), loadDetail(id)]);
    } catch (cause) {
      if (alive.current && selectedRef.current === id)
        setActionError(
          cause instanceof Error ? cause.message : t(projectMode ? "project.projectStatusChangeFail" : "goals.statusChangeFail"),
        );
    } finally {
      mutationLock.current = false;
      if (alive.current) setMutating(false);
    }
  };

  const deleteGoal = async () => {
    const id = selectedRef.current;
    if (!id || !detail || mutationLock.current) return;
    if (
      !window.confirm(
        t(projectMode ? "project.projectDeleteNamed" : "reading.goals.deleteNamed", { title: detail.goal.title }),
      )
    )
      return;
    mutationLock.current = true;
    setMutating(true);
    setActionError(null);
    try {
      const response = await window.owb.deleteGoal(id);
      if (!alive.current) return;
      if (response.status !== 200 || !response.body.deleted)
        throw new Error(errorMessage(response.body, t(projectMode ? "project.projectDeleteFail" : "goals.deleteFail")));
      const index = goals.findIndex((goal) => goal.goalId === id);
      const remaining = goals.filter((goal) => goal.goalId !== id);
      setGoals(remaining);
      if (selectedRef.current === id)
        selectGoal(
          remaining[index]?.goalId ?? remaining[index - 1]?.goalId ?? null,
        );
      await loadGoals();
    } catch (cause) {
      if (alive.current && selectedRef.current === id)
        setActionError(
          cause instanceof Error ? cause.message : t(projectMode ? "project.projectDeleteFail" : "goals.deleteFail"),
        );
    } finally {
      mutationLock.current = false;
      if (alive.current) setMutating(false);
    }
  };

  const filtered = goals.filter(
    (goal) =>
      goal.title
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()) &&
      (statusFilter === "all" || statusFilter === goal.status),
  );
  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
  };
  const boundBranch = detail?.goal.branches.find((branch) => branch.positionId && branch.sessionId);
  const empty = !loading && !error && goals.length === 0;
  const createButton = (
    <AntButton
      type="primary"
      icon={<Plus aria-hidden="true" size={16} />}
      onClick={() => setShowCreate(true)}
    >
      {t(projectMode ? "project.createProject" : "goals.create")}
    </AntButton>
  );
  return (
    <section className={`owb-goals-module${projectMode ? " owb-goals-module--project" : " owb-goals-module--overview"}`} aria-label={t(projectMode ? "project.moduleAria" : "goals.moduleAria")}>
      <header className="owb-module-header">
        <div className="owb-goals-heading"><h1>{t(projectMode ? "project.moduleTitle" : "goals.title")}</h1>
          <p>{t(projectMode ? "project.lede" : "goals.lede")}</p>
        </div>
        {!projectMode && (
          <div className="owb-goals-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={view === "goals"} onClick={() => setView("goals")}>{t("goals.tabGoals")}</button>
            <button type="button" role="tab" aria-selected={view === "board"} onClick={() => setView("board")}>{t("goals.tabBoard")}</button>
          </div>
        )}
        {!projectMode && workspaceOpen && view === "board" ? <AntButton type="primary" onClick={() => setShowTaskCreate(true)}>{t("tasks.create")}</AntButton> : null}
        {workspaceOpen && (projectMode || view === "goals") && (
          <>
            {((!loading && !error) || goals.length > 0) && (
              <span className="owb-module-header__count">
                {t(projectMode ? "project.projectCount" : "goals.count", { count: goals.length })}
              </span>
            )}
            {!empty && createButton}
          </>
        )}
      </header>
      {!workspaceOpen ? (
        <div className="owb-goals-global-state">
          <p>{t("tree.notOpened")}</p>
        </div>
      ) : !projectMode && view === "board" ? (
        <div className="owb-task-board" aria-label={t("tasks.boardAria")}>
          {taskError && <div className="owb-goals-error" role="alert">{taskError}{" "}<AntButton onClick={() => void reloadTasks()}>{t("hire.retry")}</AntButton></div>}
          {tasksLoading && <p role="status">{t("tasks.loading")}</p>}
          {(["queued", "active", "waiting", "done"] as const).map((column) => (
            <section className="owb-task-column" key={column}>
              <header><strong>{t(`tasks.column.${column}`)}</strong><span>{tasks.filter((task) => column === "done" ? ["done", "declined", "failed"].includes(task.status) : task.status === column).length}</span></header>
              <div className="owb-task-column__cards">
                {tasks.filter((task) => column === "done" ? ["done", "declined", "failed"].includes(task.status) : task.status === column).map((task) => (
                  <article className={`owb-task-card${task.priority === "urgent" ? " is-urgent" : ""}`} key={task.taskId}>
                    <div className="owb-task-card__head">
                      <PositionAvatar id={task.assigneePositionId} name={positionNames[task.assigneePositionId] ?? task.assigneePositionId} avatars={positionAvatars} sources={positionAvatarSources} />
                      <strong>{task.title}</strong>
                      {task.priority === "urgent" ? <AlertTriangle size={14} aria-label={t("tasks.urgent")} /> : null}
                    </div>
                    <p>{positionNames[task.assigneePositionId] ?? task.assigneePositionId}</p>
                    {isPendingTaskCollaboration(task) ? <><small>{t("tasks.awaitingAcceptance")}</small><div className="owb-task-card__actions"><button onClick={() => void decideTask(task, "accept")}>{t("tasks.accept")}</button><button onClick={() => void decideTask(task, "decline")}>{t("tasks.decline")}</button></div></> : null}
                    {task.kind === "contractor" ? <small className="owb-task-card__contractor"><BriefcaseBusiness size={12} aria-hidden="true" />{t("tasks.contractorBudget", { owner: positionNames[task.budgetOwnerPositionId] ?? task.budgetOwnerPositionId })}</small> : null}
                  </article>
                ))}
              </div>
            </section>
          ))}
          <Modal title={t("tasks.create")} open={showTaskCreate} onCancel={() => setShowTaskCreate(false)} onOk={() => void createTask()} okText={t("tasks.create")} cancelText={t("dlg.cancel")}>
            <Input aria-label={t("tasks.title")} placeholder={t("tasks.title")} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} />
            <Select aria-label={t("tasks.assignee")} placeholder={t("tasks.assignee")} value={taskTarget || undefined} onChange={setTaskTarget} options={Object.entries(positionNames).map(([value, label]) => ({ value, label }))} />
            <Checkbox checked={taskUrgent} onChange={(event) => setTaskUrgent(event.target.checked)}>{t("tasks.urgent")}</Checkbox>
            <Checkbox checked={taskContractor} onChange={(event) => setTaskContractor(event.target.checked)}>{t("tasks.contractor")}</Checkbox>
          </Modal>
        </div>
      ) : (
        <>
          {error && (
            <div className="owb-goals-error" role="alert">
              {error}{" "}
              <AntButton onClick={() => void loadGoals()}>
                {t("hire.retry")}
              </AntButton>
            </div>
          )}
          {!projectMode && !loading && goals.length > 0 && (
            <div className="owb-goals-summary" aria-label={t("goals.summary")}>
              <button type="button" aria-pressed={statusFilter === "all"} onClick={() => { setStatusFilter("all"); setQuery(""); setMobileDetail(false); }}>
                <span>{t("goals.summary.total")}</span>
                <strong>{goals.length}</strong>
                <small>{t("goals.summary.totalHint")}</small>
              </button>
              <button type="button" aria-pressed={statusFilter === "in_progress"} onClick={() => { setStatusFilter("in_progress"); setQuery(""); setMobileDetail(false); }}>
                <span>{t("goals.summary.active")}</span>
                <strong>{goals.filter((goal) => goal.status === "in_progress").length}</strong>
                <small>{t("goals.summary.activeHint")}</small>
              </button>
              <button type="button" aria-pressed={statusFilter === "completed"} onClick={() => { setStatusFilter("completed"); setQuery(""); setMobileDetail(false); }}>
                <span>{t("goals.summary.completed")}</span>
                <strong>{goals.filter((goal) => goal.status === "completed").length}</strong>
                <small>{t("goals.summary.completedHint")}</small>
              </button>
            </div>
          )}
          {loading && goals.length === 0 && (
            <div className="owb-goals-global-state" role="status">
              {t("misc.loading")}
            </div>
          )}
          {empty && (
            <div className="owb-goals-global-state">
              <Target size={36} aria-hidden="true" />
              <h2>{t(projectMode ? "project.emptyTitle" : "reading.goals.emptyTitle")}</h2>
              <p>{t(projectMode ? "project.moduleEmptyHint" : "reading.goals.emptyHint")}</p>
              {createButton}
            </div>
          )}
          {goals.length > 0 && (
            <div className="owb-goals-layout" data-mobile-detail={mobileDetail}>
              <div className="owb-goals-list-pane">
                <div className="owb-goals-list-heading"><h2>{t(projectMode ? "project.listAria" : "goals.currentGoals")}</h2><span>{t(projectMode ? "project.projectCount" : "goals.count", { count: filtered.length })}</span></div>
                <div className="owb-goals-filters">
                  <Input
                    aria-label={t(projectMode ? "project.searchProjects" : "reading.goals.search")}
                    placeholder={t(projectMode ? "project.searchProjects" : "reading.goals.search")}
                    value={query}
                    prefix={<Search size={14} aria-hidden="true" />}
                    allowClear
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <Select
                    aria-label={t(projectMode ? "project.filterProjects" : "reading.goals.filter")}
                    value={statusFilter}
                    onChange={setStatusFilter}
                    options={[
                      { value: "all", label: t(projectMode ? "project.allProjects" : "reading.goals.all") },
                      ...goalStatuses.map((status) => ({
                        value: status,
                        label: t(`goals.status.${status}`),
                      })),
                    ]}
                  />
                </div>
                {filtered.length === 0 ? (
                  <div className="owb-goals-empty">
                    <p>{t(projectMode ? "project.noProjectResults" : "reading.goals.noResults")}</p>
                    <AntButton onClick={clearFilters}>
                      {t("reading.clearFilters")}
                    </AntButton>
                  </div>
                ) : (
                  <ul
                    className="owb-goals-list"
                    role="listbox"
                    aria-label={t(projectMode ? "project.listAria" : "goals.listAria")}
                  >
                    {filtered.map((goal) => (
                      <li
                        key={goal.goalId}
                        role="option"
                        aria-selected={goal.goalId === selectedId}
                        className={`owb-goals-list__item${goal.goalId === selectedId ? " owb-goals-list__item--active" : ""}`}
                        onClick={() => {
                          selectGoal(goal.goalId);
                          setMobileDetail(true);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            selectGoal(goal.goalId);
                            setMobileDetail(true);
                          }
                        }}
                        tabIndex={0}
                      >
                        <span
                          className="owb-goals-list__title"
                          title={goal.title}
                        >
                          {goal.title}
                        </span>
                        {!projectMode && <span className="owb-goals-list__subtitle">{t("goals.branchCount", { count: goal.branchCount })}<span aria-hidden="true"> · </span>{t(`goals.status.${goal.status}`)}</span>}
                        <span className="owb-goals-list__meta">
                          {projectMode && <span
                            className={`owb-badge ${STATUS_BADGE[goal.status]}`}
                          >
                            {t(`goals.status.${goal.status}`)}
                          </span>}
                          <span
                            className={`owb-health-dot ${HEALTH_DOT[goal.health]}`}
                            title={t(`goals.health.${goal.health}`)}
                            aria-label={t(`goals.health.${goal.health}`)}
                          />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <aside className="owb-goals-detail" aria-live="polite">
                <AntButton
                  className="owb-goals-back"
                  icon={<ArrowLeft size={16} />}
                  onClick={() => setMobileDetail(false)}
                >
                  {t("reading.backToList")}
                </AntButton>
                {detailError ? (
                  <div className="owb-goals-error" role="alert">
                    <p>{t(projectMode ? "project.projectLoadError" : "goals.loadError")}</p>
                    <p>
                      {detailError !== t(projectMode ? "project.projectLoadError" : "goals.loadError")
                        ? detailError
                        : null}
                    </p>
                    <AntButton
                      onClick={() => selectedId && void loadDetail(selectedId)}
                    >
                      {t("hire.retry")}
                    </AntButton>
                  </div>
                ) : selectedId && !detail ? (
                  <p className="owb-goals-loading" role="status">
                    {t("misc.loading")}
                  </p>
                ) : null}
                {detail && (
                  <div className="owb-goals-detail__content">
                    <div className="owb-goals-detail__head">
                      <h2>{detail.goal.title}</h2>
                      <Dropdown
                        trigger={["click"]}
                        menu={{
                          items: [
                            {
                              key: "delete",
                              label: t(projectMode ? "project.projectDeleteAction" : "goals.deleteAction"),
                              danger: true,
                              disabled: mutating,
                            },
                          ],
                          onClick: () => void deleteGoal(),
                        }}
                      >
                        <AntButton
                          aria-label={t("reading.more")}
                          icon={<MoreHorizontal size={16} />}
                          loading={mutating}
                        />
                      </Dropdown>
                    </div>
                    {projectMode && <p className="owb-project-description-preview">{detail.goal.description}</p>}
                    {!projectMode && <p className="owb-goals-detail__updated"><time dateTime={detail.goal.updatedAt}>{t("reading.updatedAt", { time: new Date(detail.goal.updatedAt).toLocaleString() })}</time></p>}
                    <div className="owb-goals-detail__meta">
                      <Select
                        value={detail.goal.status}
                        disabled={mutating}
                        onChange={(value) => void changeStatus(value)}
                        options={goalStatuses
                          .filter((status) =>
                            canTransitionGoalStatus(detail.goal.status, status),
                          )
                          .map((status) => ({
                            value: status,
                            label: t(`goals.status.${status}`),
                          }))}
                        aria-label={t(projectMode ? "project.projectStatusChange" : "goals.statusChange")}
                      />
                      {detail.healthOverlay &&
                      detail.healthOverlay !== detail.goal.health ? (
                        <div
                          className="owb-goals-health-split"
                          data-testid="goals-health-overlay"
                        >
                          <span
                            data-testid="goals-health-rule"
                            className={`owb-health-dot ${HEALTH_DOT[detail.goal.health]}`}
                          >
                            {t("goals.health.rule")}:{" "}
                            {t(`goals.health.${detail.goal.health}`)}
                          </span>
                          <span
                            data-testid="goals-health-laya"
                            className={`owb-health-dot ${HEALTH_DOT[detail.healthOverlay]}`}
                          >
                            {t("goals.health.layaSuggestion")}:{" "}
                            {t(`goals.health.${detail.healthOverlay}`)}
                            {detail.goal.health === "at_risk" &&
                            detail.healthOverlay === "on_track" ? (
                              <em data-testid="goals-health-not-adopted">
                                {" "}
                                {t("goals.health.suggestionNotAdopted")}
                              </em>
                            ) : null}
                          </span>
                        </div>
                      ) : (
                        <span
                          className={`owb-health-dot ${HEALTH_DOT[detail.goal.health]}`}
                        >
                          {t("reading.goals.health")}:{" "}
                          {t(`goals.health.${detail.goal.health}`)}
                        </span>
                      )}
                    </div>
                    {detail.healthOverlay === "blocked" ? (
                      <div className="owb-goals-health-actions">
                        {boundBranch && onOpenBoundSession ? (
                          <AntButton
                            data-testid="goals-health-open-turn"
                            onClick={() => {
                              onOpenBoundSession(boundBranch.positionId!, boundBranch.sessionId!);
                            }}
                          >
                            {t("goals.health.openBoundTurn")}
                          </AntButton>
                        ) : null}
                        {onOpenApprovals ? (
                          <AntButton
                            data-testid="goals-health-open-approvals"
                            onClick={() => onOpenApprovals()}
                          >
                            {t("goals.health.openApprovals")}
                          </AntButton>
                        ) : null}
                        {!(boundBranch && onOpenBoundSession) &&
                        !onOpenApprovals ? (
                          <p data-testid="goals-health-blocked-empty">
                            {t("goals.health.blockedNoTarget")}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {actionError && (
                      <p className="owb-goals-error" role="alert">
                        {actionError}
                      </p>
                    )}
                    {projectMode && <ProjectBoard
                      key={detail.goal.goalId}
                      workspaceKey={workspaceKey}
                      detail={detail}
                      positionNames={positionNames}
                      positionEngines={positionEngines}
                      onOpenBoundSession={onOpenBoundSession}
                      onRefresh={async () => {
                        const goalId = selectedRef.current;
                        await Promise.all([loadGoals(), goalId ? loadDetail(goalId) : Promise.resolve()]);
                      }}
                    />}
                    <Overview className={projectMode ? "owb-project-overview" : undefined}>
                      {projectMode && <summary>{t("project.overview")}</summary>}
                    <section>
                      <h3>{t(projectMode ? "project.form.descField" : "goals.descField")}</h3>
                      <p className="owb-goals-detail__desc">
                        {detail.goal.description}
                      </p>
                    </section>
                      <section>
                        <h3>{t(projectMode ? "project.form.criteria" : "goals.criteria")}</h3>
                        <AntButton size="small" disabled={mutating} onClick={() => setCriteriaGoalId(detail.goal.goalId)}>{t("goals.criteriaEdit")}</AntButton>
                        <ol className={!projectMode ? "owb-goals-criteria" : undefined}>
                          {detail.goal.acceptanceCriteria.map(
                            (criterion, index) => (
                              <li key={index}>{!projectMode && <Circle size={16} aria-hidden="true" />}<span>{criterion}</span></li>
                            ),
                          )}
                        </ol>
                      </section>
                    {!projectMode && <GoalEvidence branches={detail.goal.branches} positionNames={positionNames} onOpenBoundSession={onOpenBoundSession} />}
                    {projectMode && detail.goal.branches.length > 0 && (
                      <section>
                        <h3>{t("goals.branches")}</h3>
                        <ul>
                          {detail.goal.branches.map((branch) => (
                            <li key={branch.branchId}>
                              <span
                                className={`owb-badge ${STATUS_BADGE[branch.status]}`}
                              >
                                {t(`goals.status.${branch.status}`)}
                              </span>{" "}
                              {branch.title}
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                    <ActivitySection className={!projectMode ? "owb-goals-activity-section" : undefined}>
                      {!projectMode && <summary>{t("goals.activity")}<span>{detail.activity.length}</span></summary>}
                      {projectMode && <h3>{t("goals.activity")}</h3>}
                      {detail.activity.length === 0 && <p className="owb-goal-evidence__hint">{t("goals.noActivity")}</p>}
                      <ol className="owb-goals-activity">
                        {(projectMode ? detail.activity : [...detail.activity].sort((a, b) => b.createdAt.localeCompare(a.createdAt))).map((activity) => (
                          <li key={activity.activityId}>
                            <time dateTime={activity.createdAt}>
                              {new Date(activity.createdAt).toLocaleString()}
                            </time>
                            <span className="owb-goals-activity__kind">
                              {t(`goals.activityKind.${activity.kind}`)}
                            </span>
                            <span>{activity.detail}</span>
                          </li>
                        ))}
                      </ol>
                    </ActivitySection>
                    </Overview>
                  </div>
                )}
              </aside>
            </div>
          )}
          <GoalCreateDialog
            presentation={presentation}
            open={showCreate}
            onClose={() => setShowCreate(false)}
            onCreated={(id) => {
              clearFilters();
              setMobileDetail(true);
              selectGoal(id);
              void loadGoals(id);
            }}
          />
          {detail && criteriaGoalId === detail.goal.goalId && <GoalCriteriaDialog
            key={detail.goal.goalId}
            goal={detail.goal}
            onClose={() => setCriteriaGoalId(null)}
            onSaved={async () => { await Promise.all([loadGoals(), loadDetail(detail.goal.goalId)]); }}
          />}
        </>
      )}
    </section>
  );
}
