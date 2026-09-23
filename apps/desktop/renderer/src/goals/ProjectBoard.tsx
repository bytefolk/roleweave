import { useEffect, useRef, useState } from "react";
import { Button, Drawer, Input } from "antd";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Play,
  Plus,
  Search,
  UserRound,
} from "lucide-react";
import { useOwbLocale, useT } from "@roleweave/ui";
import type { GoalDetail, GoalWorkItem } from "@roleweave/shared/goals";
import type { TurnEngine } from "@roleweave/shared";
import { useEngineLabel } from "../turns/engine-select";
import "./project-board.css";

export interface ProjectBoardProps {
  detail: GoalDetail;
  positionNames: Record<string, string>;
  positionEngines?: Record<string, TurnEngine>;
  onRefresh: () => void | Promise<void>;
}

const STATUSES = ["todo", "in_progress", "blocked", "review", "done"] as const;
const PRIORITIES = ["low", "normal", "high"] as const;
const DAY = 86_400_000;
const WINDOW_DAYS = 28;
const MAX_ITEMS = 64;
type TaskExecution = NonNullable<GoalDetail["taskExecutions"]>[string];
type Editor = { item: GoalWorkItem; isNew: boolean; version: string };

function localToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function dayNumber(value: string) {
  return Date.parse(`${value}T00:00:00Z`) / DAY;
}
function dateValue(day: number) {
  return new Date(day * DAY).toISOString().slice(0, 10);
}
function weekStart(value: string) {
  const day = dayNumber(value);
  return day - ((new Date(day * DAY).getUTCDay() + 6) % 7);
}
function validDate(value?: string) {
  return (
    !value ||
    (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(dayNumber(value)) &&
      dateValue(dayNumber(value)) === value)
  );
}
function own<T>(
  record: Record<string, T> | undefined,
  key: string,
): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}
function responseError(body: unknown, fallback: string) {
  return body &&
    typeof body === "object" &&
    "message" in body &&
    typeof body.message === "string"
    ? body.message
    : fallback;
}

/** Planning state is explicitly separate from the latest observed Agent turn. */
export function ProjectBoard({
  detail,
  positionNames,
  positionEngines = {},
  onRefresh,
}: ProjectBoardProps) {
  const t = useT();
  const locale = useOwbLocale();
  const engineLabel = useEngineLabel();
  const items = detail.goal.workItems ?? [];
  const [view, setView] = useState<"board" | "schedule">("board");
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState("all");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [launching, setLaunching] = useState<Record<string, boolean>>({});
  const [accepted, setAccepted] = useState<Record<string, TaskExecution>>({});
  const [windowStart, setWindowStart] = useState(() => weekStart(localToday()));
  const alive = useRef(true);
  const saving = useRef(false);
  const launchLocks = useRef(new Set<string>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    // Once the server has observed an accepted run, it owns subsequent status.
    setAccepted((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([taskId, run]) => {
          const current = own(detail.taskExecutions, taskId);
          return !current || current.turnId !== run.turnId;
        }),
      ),
    );
  }, [detail.taskExecutions]);

  const today = localToday();
  const overdue = (item: GoalWorkItem) =>
    item.status !== "done" && !!item.dueDate && item.dueDate < today;
  const done = items.filter((item) => item.status === "done").length;
  const filtered = items.filter((item) => {
    const match = `${item.title} ${item.description ?? ""}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase());
    return (
      match &&
      (owner === "all" ||
        (owner === "unassigned"
          ? !item.assigneePositionId
          : owner === `position:${item.assigneePositionId ?? ""}`))
    );
  });
  const ownerIds = Array.from(
    new Set([
      ...Object.keys(positionNames),
      ...items.flatMap((item) =>
        item.assigneePositionId ? [item.assigneePositionId] : [],
      ),
    ]),
  );
  const nameOf = (item: GoalWorkItem) =>
    item.assigneePositionId
      ? (own(positionNames, item.assigneePositionId) ?? item.assigneePositionId)
      : t("project.unassigned");
  const executionOf = (item: GoalWorkItem) => {
    const run =
      own(accepted, item.taskId) ?? own(detail.taskExecutions, item.taskId);
    return run?.positionId === item.assigneePositionId ? run : undefined;
  };
  const runLabel = (item: GoalWorkItem) => {
    const run = executionOf(item);
    if (run) return t(`project.execution.${run.status}`);
    return t(
      detail.executionUnavailable
        ? "project.execution.unavailable"
        : "project.execution.none",
    );
  };

  const refresh = async () => {
    try {
      await onRefresh();
    } catch {
      if (alive.current) setError(t("project.refreshError"));
    }
  };
  const save = async (
    next: GoalWorkItem[],
    version: string,
    closeEditor = false,
  ) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await window.owb.updateGoal({
        goalId: detail.goal.goalId,
        workItems: next,
        expectedUpdatedAt: version,
      });
      if (!alive.current) return;
      if (result.status !== 200)
        throw new Error(responseError(result.body, t("project.saveError")));
      if (closeEditor) setEditor(null);
      await refresh();
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : t("project.saveError"),
        );
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const edit = (item?: GoalWorkItem) => {
    setError(null);
    setEditor({
      item: item
        ? { ...item }
        : {
            taskId: crypto.randomUUID(),
            title: "",
            status: "todo",
            priority: "normal",
          },
      isNew: !item,
      version: detail.goal.updatedAt,
    });
  };
  const patch = (fields: Partial<GoalWorkItem>) =>
    setEditor((current) =>
      current ? { ...current, item: { ...current.item, ...fields } } : current,
    );
  const validEditor =
    !!editor?.item.title.trim() &&
    validDate(editor.item.startDate) &&
    validDate(editor.item.dueDate) &&
    !(
      editor.item.startDate &&
      editor.item.dueDate &&
      editor.item.startDate > editor.item.dueDate
    );
  const submit = () => {
    if (!editor || !validEditor) return;
    const draft = editor.item;
    const item: GoalWorkItem = {
      taskId: draft.taskId,
      title: draft.title.trim(),
      status: draft.status,
      priority: draft.priority,
      ...(draft.description?.trim()
        ? { description: draft.description.trim() }
        : {}),
      ...(draft.assigneePositionId
        ? { assigneePositionId: draft.assigneePositionId }
        : {}),
      ...(draft.startDate ? { startDate: draft.startDate } : {}),
      ...(draft.dueDate ? { dueDate: draft.dueDate } : {}),
    };
    void save(
      editor.isNew
        ? [...items, item]
        : items.map((existing) =>
            existing.taskId === item.taskId ? item : existing,
          ),
      editor.version,
      true,
    );
  };
  const launch = async (item: GoalWorkItem) => {
    const positionId = item.assigneePositionId;
    const engine = positionId ? own(positionEngines, positionId) : undefined;
    if (
      !positionId ||
      !engine ||
      launchLocks.current.has(item.taskId) ||
      executionOf(item)?.status === "running" ||
      detail.executionUnavailable
    )
      return;
    launchLocks.current.add(item.taskId);
    setLaunching((current) => ({ ...current, [item.taskId]: true }));
    setError(null);
    try {
      const result = await window.owb.createTurn({
        positionId,
        engine,
        input: [item.title, item.description].filter(Boolean).join("\n\n"),
        goalId: detail.goal.goalId,
        branchId: item.taskId,
      });
      if (!alive.current) return;
      if (
        result.status !== 200 &&
        result.status !== 201 &&
        result.status !== 202
      )
        throw new Error(responseError(result.body, t("project.runError")));
      setAccepted((current) => ({
        ...current,
        [item.taskId]: {
          turnId: result.body.turnId,
          positionId,
          status: result.body.status,
          startedAt: result.body.createdAt,
        },
      }));
      await refresh();
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : t("project.runError"),
        );
    } finally {
      launchLocks.current.delete(item.taskId);
      if (alive.current)
        setLaunching((current) => ({ ...current, [item.taskId]: false }));
    }
  };

  const execution = (item: GoalWorkItem) => {
    const run = executionOf(item);
    return (
      <span
        className="owb-project-execution"
        data-status={run?.status ?? "none"}
        title={run?.turnId}
      >
        <span aria-hidden="true" />
        {runLabel(item)}
      </span>
    );
  };
  const card = (item: GoalWorkItem) => {
    const engine = item.assigneePositionId
      ? own(positionEngines, item.assigneePositionId)
      : undefined;
    const running = executionOf(item)?.status === "running";
    return (
      <article
        className="owb-project-card"
        key={item.taskId}
        aria-label={item.title}
        data-overdue={overdue(item)}
      >
        <div className="owb-project-card__top">
          <span className="owb-project-priority" data-priority={item.priority}>
            {t(`project.priority.${item.priority}`)}
          </span>
          {overdue(item) && (
            <span className="owb-project-overdue">{t("project.overdue")}</span>
          )}
        </div>
        <button
          type="button"
          className="owb-project-card__title"
          onClick={() => edit(item)}
          disabled={busy}
        >
          {item.title}
        </button>
        {item.description && (
          <p className="owb-project-card__description">{item.description}</p>
        )}
        <div className="owb-project-card__owner">
          <UserRound size={13} aria-hidden="true" />
          <span title={nameOf(item)}>{nameOf(item)}</span>
        </div>
        <div className="owb-project-card__dates">
          <CalendarDays size={13} aria-hidden="true" />
          {item.startDate || item.dueDate ? (
            <span>
              {item.startDate ?? "…"} → {item.dueDate ?? "…"}
            </span>
          ) : (
            t("project.unscheduled")
          )}
        </div>
        <select
          aria-label={t("project.changeStatus", { title: item.title })}
          className="owb-project-select"
          value={item.status}
          disabled={busy}
          onChange={(event) =>
            void save(
              items.map((existing) =>
                existing.taskId === item.taskId
                  ? {
                      ...existing,
                      status: event.target.value as GoalWorkItem["status"],
                    }
                  : existing,
              ),
              detail.goal.updatedAt,
            )
          }
        >
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`project.status.${status}`)}
            </option>
          ))}
        </select>
        <div className="owb-project-card__execution">
          {execution(item)}
          <Button
            size="small"
            type="text"
            icon={<Play size={12} aria-hidden="true" />}
            aria-label={t("project.runNamed", { title: item.title })}
            title={
              !item.assigneePositionId
                ? t("project.assignFirst")
                : !engine
                  ? t("project.configureEngine")
                  : engineLabel(engine)
            }
            disabled={
              busy ||
              !!own(launching, item.taskId) ||
              running ||
              !engine ||
              !!detail.executionUnavailable
            }
            onClick={() => void launch(item)}
          >
            {t("project.run")}
          </Button>
        </div>
        {item.assigneePositionId && !engine && (
          <p className="owb-project-card__hint">
            {t("project.configureEngine")}
          </p>
        )}
      </article>
    );
  };
  const formattedDay = (day: number) =>
    new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(day * DAY));
  const scheduled = filtered
    .filter((item) => item.startDate || item.dueDate)
    .sort((a, b) =>
      (a.startDate ?? a.dueDate!).localeCompare(b.startDate ?? b.dueDate!),
    );
  const unscheduled = filtered.filter(
    (item) => !item.startDate && !item.dueDate,
  );

  return (
    <section className="owb-project-board" aria-label={t("project.title")}>
      <div className="owb-project-summary">
        <div className="owb-project-summary__progress">
          <strong>
            {t("project.completion", { done, total: items.length })}
          </strong>
          <progress
            aria-label={t("project.progress")}
            value={done}
            max={Math.max(items.length, 1)}
          />
          <span>{t("project.manualProgress")}</span>
        </div>
        <div className="owb-project-summary__metric">
          <strong>
            {items.filter((item) => item.status === "in_progress").length}
          </strong>
          <span>{t("project.status.in_progress")}</span>
        </div>
        <div className="owb-project-summary__metric" data-alert="blocked">
          <strong>
            {items.filter((item) => item.status === "blocked").length}
          </strong>
          <span>{t("project.status.blocked")}</span>
        </div>
        <div className="owb-project-summary__metric" data-alert="overdue">
          <strong>{items.filter(overdue).length}</strong>
          <span>{t("project.overdue")}</span>
        </div>
      </div>
      <div className="owb-project-toolbar">
        <div
          className="owb-project-view-switch"
          role="group"
          aria-label={t("project.views")}
        >
          <Button
            type={view === "board" ? "primary" : "default"}
            aria-pressed={view === "board"}
            icon={<Columns3 size={14} aria-hidden="true" />}
            onClick={() => setView("board")}
          >
            {t("project.board")}
          </Button>
          <Button
            type={view === "schedule" ? "primary" : "default"}
            aria-pressed={view === "schedule"}
            icon={<CalendarDays size={14} aria-hidden="true" />}
            onClick={() => setView("schedule")}
          >
            {t("project.schedule")}
          </Button>
        </div>
        <Input
          className="owb-project-search"
          prefix={<Search size={14} aria-hidden="true" />}
          aria-label={t("project.search")}
          placeholder={t("project.search")}
          value={query}
          allowClear
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="owb-project-select owb-project-owner-filter"
          aria-label={t("project.filterOwner")}
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
        >
          <option value="all">{t("project.allOwners")}</option>
          <option value="unassigned">{t("project.unassigned")}</option>
          {ownerIds.map((id) => (
            <option value={`position:${id}`} key={id}>
              {own(positionNames, id) ?? id}
            </option>
          ))}
        </select>
        <Button
          type="primary"
          icon={<Plus size={14} aria-hidden="true" />}
          disabled={busy || items.length >= MAX_ITEMS}
          onClick={() => edit()}
        >
          {t("project.create")}
        </Button>
      </div>
      {!editor && error && (
        <p className="owb-project-error" role="alert">
          {error}
        </p>
      )}
      {detail.executionUnavailable && (
        <p className="owb-project-notice" role="status">
          {t("project.executionUnavailable")}{" "}
          <Button size="small" onClick={() => void refresh()}>
            {t("hire.retry")}
          </Button>
        </p>
      )}
      <p className="owb-project-caption">{t("project.executionNote")}</p>
      {items.length === 0 && (
        <div className="owb-project-empty">
          <strong>{t("project.empty")}</strong>
          <p>{t("project.emptyHint")}</p>
        </div>
      )}
      {items.length > 0 && filtered.length === 0 && (
        <div className="owb-project-empty">
          <p>{t("project.noResults")}</p>
          <Button
            onClick={() => {
              setQuery("");
              setOwner("all");
            }}
          >
            {t("reading.clearFilters")}
          </Button>
        </div>
      )}
      {view === "board" ? (
        <div className="owb-project-columns">
          {STATUSES.map((status) => (
            <section
              className="owb-project-column"
              data-status={status}
              key={status}
              aria-label={t(`project.status.${status}`)}
            >
              <header>
                <span className="owb-project-column__dot" />
                <h4>{t(`project.status.${status}`)}</h4>
                <span className="owb-project-column__count">
                  {filtered.filter((item) => item.status === status).length}
                </span>
              </header>
              <div className="owb-project-column__cards">
                {filtered.filter((item) => item.status === status).map(card)}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="owb-project-schedule">
          <div className="owb-project-schedule__toolbar">
            <Button
              aria-label={t("project.previousWeeks")}
              icon={<ChevronLeft size={15} />}
              onClick={() => setWindowStart((value) => value - WINDOW_DAYS)}
            />
            <strong>
              {formattedDay(windowStart)} –{" "}
              {formattedDay(windowStart + WINDOW_DAYS - 1)}
            </strong>
            <Button
              aria-label={t("project.nextWeeks")}
              icon={<ChevronRight size={15} />}
              onClick={() => setWindowStart((value) => value + WINDOW_DAYS)}
            />
            <Button onClick={() => setWindowStart(weekStart(today))}>
              {t("project.today")}
            </Button>
          </div>
          <div className="owb-project-timeline-scroll">
            <div
              className="owb-project-timeline"
              role="table"
              aria-label={t("project.schedule")}
            >
              <div
                className="owb-project-timeline__row owb-project-timeline__header"
                role="row"
              >
                <div role="columnheader">{t("project.taskAndOwner")}</div>
                <div
                  className="owb-project-timeline__weeks"
                  role="columnheader"
                >
                  {[0, 1, 2, 3].map((week) => (
                    <span key={week}>
                      {formattedDay(windowStart + week * 7)}
                    </span>
                  ))}
                </div>
              </div>
              {scheduled.map((item) => {
                const start = dayNumber(item.startDate ?? item.dueDate!);
                const end = dayNumber(item.dueDate ?? item.startDate!);
                const left = Math.max(0, start - windowStart);
                const right = Math.min(WINDOW_DAYS, end - windowStart + 1);
                const inWindow =
                  start < windowStart + WINDOW_DAYS && end >= windowStart;
                const label =
                  item.startDate && item.dueDate
                    ? `${item.startDate} → ${item.dueDate}`
                    : item.startDate
                      ? t("project.startOnly", { date: item.startDate })
                      : t("project.dueOnly", { date: item.dueDate! });
                return (
                  <div
                    className="owb-project-timeline__row"
                    role="row"
                    key={item.taskId}
                  >
                    <div className="owb-project-timeline__task" role="cell">
                      <button
                        type="button"
                        onClick={() => edit(item)}
                        disabled={busy}
                      >
                        {item.title}
                      </button>
                      <span>
                        {nameOf(item)} · {t(`project.status.${item.status}`)}
                      </span>
                      <small>{label}</small>
                      {execution(item)}
                    </div>
                    <div
                      className="owb-project-timeline__track"
                      role="cell"
                      aria-label={label}
                    >
                      {dayNumber(today) >= windowStart &&
                        dayNumber(today) < windowStart + WINDOW_DAYS && (
                          <span
                            className="owb-project-timeline__today"
                            style={{
                              left: `${((dayNumber(today) - windowStart) / WINDOW_DAYS) * 100}%`,
                            }}
                            aria-hidden="true"
                          />
                        )}
                      {inWindow ? (
                        <button
                          type="button"
                          className="owb-project-timeline__bar"
                          data-status={item.status}
                          data-point={!item.startDate || !item.dueDate}
                          style={{
                            left: `${(left / WINDOW_DAYS) * 100}%`,
                            width: `${(Math.max(1, right - left) / WINDOW_DAYS) * 100}%`,
                          }}
                          aria-label={`${item.title}: ${label}`}
                          title={`${item.title}: ${label}`}
                          onClick={() => edit(item)}
                          disabled={busy}
                        >
                          <span>{item.title}</span>
                        </button>
                      ) : (
                        <span className="owb-project-timeline__outside">
                          {t("project.outsideWindow")}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              {scheduled.length === 0 && (
                <p className="owb-project-timeline__empty">
                  {t("project.noSchedule")}
                </p>
              )}
            </div>
          </div>
          <div className="owb-project-unscheduled">
            <h4>
              {t("project.unscheduled")} <span>{unscheduled.length}</span>
            </h4>
            <div>{unscheduled.map(card)}</div>
          </div>
        </div>
      )}
      <Drawer
        title={editor?.isNew ? t("project.create") : t("project.edit")}
        open={!!editor}
        onClose={() => {
          if (!busy) {
            setEditor(null);
            setError(null);
          }
        }}
        size="min(520px, calc(100vw - 24px))"
        destroyOnHidden
        footer={
          <div className="owb-project-form__footer">
            <Button
              disabled={busy}
              onClick={() => {
                setEditor(null);
                setError(null);
              }}
            >
              {t("dlg.cancel")}
            </Button>
            <Button
              type="primary"
              loading={busy}
              disabled={!validEditor}
              onClick={submit}
            >
              {t("project.save")}
            </Button>
          </div>
        }
      >
        {editor && (
          <>
            <fieldset className="owb-project-form" disabled={busy}>
              <label>
                <span>{t("project.taskTitle")}</span>
                <Input
                  autoFocus
                  maxLength={256}
                  value={editor.item.title}
                  onChange={(event) => patch({ title: event.target.value })}
                />
              </label>
              <label>
                <span>{t("project.taskDescription")}</span>
                <Input.TextArea
                  rows={4}
                  maxLength={4096}
                  value={editor.item.description ?? ""}
                  onChange={(event) =>
                    patch({ description: event.target.value })
                  }
                />
              </label>
              <label>
                <span>{t("project.assignee")}</span>
                <select
                  className="owb-project-select"
                  value={editor.item.assigneePositionId ?? ""}
                  onChange={(event) =>
                    patch({
                      assigneePositionId: event.target.value || undefined,
                    })
                  }
                >
                  <option value="">{t("project.unassigned")}</option>
                  {ownerIds.map((id) => (
                    <option key={id} value={id}>
                      {own(positionNames, id) ?? id}
                    </option>
                  ))}
                </select>
              </label>
              <div className="owb-project-form__row">
                <label>
                  <span>{t("project.taskStatus")}</span>
                  <select
                    className="owb-project-select"
                    value={editor.item.status}
                    onChange={(event) =>
                      patch({
                        status: event.target.value as GoalWorkItem["status"],
                      })
                    }
                  >
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {t(`project.status.${status}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t("project.priority")}</span>
                  <select
                    className="owb-project-select"
                    value={editor.item.priority}
                    onChange={(event) =>
                      patch({
                        priority: event.target
                          .value as GoalWorkItem["priority"],
                      })
                    }
                  >
                    {PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        {t(`project.priority.${priority}`)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="owb-project-form__row">
                <label>
                  <span>{t("project.startDate")}</span>
                  <input
                    type="date"
                    className="owb-project-select"
                    value={editor.item.startDate ?? ""}
                    max={editor.item.dueDate || undefined}
                    onChange={(event) =>
                      patch({ startDate: event.target.value || undefined })
                    }
                  />
                </label>
                <label>
                  <span>{t("project.dueDate")}</span>
                  <input
                    type="date"
                    className="owb-project-select"
                    value={editor.item.dueDate ?? ""}
                    min={editor.item.startDate || undefined}
                    onChange={(event) =>
                      patch({ dueDate: event.target.value || undefined })
                    }
                  />
                </label>
              </div>
              <p className="owb-project-caption">{t("project.dateHint")}</p>
            </fieldset>
            {editor.item.startDate &&
              editor.item.dueDate &&
              editor.item.startDate > editor.item.dueDate && (
                <p className="owb-project-error" role="alert">
                  {t("project.invalidDates")}
                </p>
              )}
            {error && (
              <p className="owb-project-error" role="alert">
                {error}
              </p>
            )}
            {editor.version !== detail.goal.updatedAt && (
              <p className="owb-project-notice">
                {t("project.changedWhileEditing")}
              </p>
            )}
          </>
        )}
      </Drawer>
    </section>
  );
}
