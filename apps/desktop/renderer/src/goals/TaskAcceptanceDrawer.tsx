import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Drawer, Input } from "antd";
import { useOwbLocale, useT } from "@roleweave/ui";
import type {
  GoalDetail,
  GoalTaskAcceptanceRecord,
  GoalTaskDelivery,
  GoalWorkItem,
} from "@roleweave/shared/goals";
import "./task-acceptance.css";

interface TaskAcceptanceDrawerProps {
  detail: GoalDetail;
  item: GoalWorkItem;
  workspaceKey?: string;
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
}

type ReviewDraft = {
  version: string;
  criteria: string[];
  delivery?: GoalTaskDelivery;
  checked: boolean[];
  note: string;
  idempotencyKey: string;
};

function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function draftFrom(detail: GoalDetail, taskId: string): ReviewDraft {
  const delivery = own(detail.taskDeliveries, taskId);
  return {
    version: detail.goal.updatedAt,
    criteria: [...detail.goal.acceptanceCriteria],
    delivery,
    checked: detail.goal.acceptanceCriteria.map(() => false),
    note: "",
    idempotencyKey: crypto.randomUUID(),
  };
}

function sameSource(a?: GoalTaskDelivery, b?: GoalTaskDelivery) {
  return !!a && !!b &&
    a.source.turnId === b.source.turnId &&
    a.source.sessionId === b.source.sessionId &&
    a.source.positionId === b.source.positionId &&
    a.source.outputDigest === b.source.outputDigest;
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output, null, 2) ?? "";
}

/** A draft is local; every displayed verdict comes from a persisted server record. */
export function TaskAcceptanceDrawer({
  detail,
  item,
  workspaceKey,
  onClose,
  onRefresh,
}: TaskAcceptanceDrawerProps) {
  const t = useT();
  const locale = useOwbLocale();
  const [draft, setDraft] = useState(() => draftFrom(detail, item.taskId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reloaded, setReloaded] = useState(false);
  const [saved, setSaved] = useState<GoalTaskAcceptanceRecord | null>(null);
  const request = useRef(0);
  const locked = useRef(false);
  const attempt = useRef<{ draftKey: string; decision: string; requestKey: string }>();
  const scope = `${workspaceKey ?? ""}\u0000${detail.goal.goalId}\u0000${item.taskId}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => () => {
    request.current += 1;
  }, []);

  const currentDelivery = own(detail.taskDeliveries, item.taskId);
  const taskExists = !!detail.goal.workItems?.some((task) => task.taskId === item.taskId);
  const stale = conflict || draft.version !== detail.goal.updatedAt ||
    !taskExists ||
    JSON.stringify(draft.criteria) !== JSON.stringify(detail.goal.acceptanceCriteria) ||
    (!!draft.delivery !== !!currentDelivery) ||
    (!!draft.delivery && !sameSource(draft.delivery, currentDelivery));
  const records = (detail.goal.taskAcceptances ?? []).filter((record) => record.taskId === item.taskId);
  const history = saved && !records.some((record) => record.acceptanceId === saved.acceptanceId)
    ? [...records, saved]
    : records;
  const reviewable = !!draft.delivery && draft.criteria.length > 0;
  const allChecked = reviewable && draft.checked.every(Boolean);
  const bridgeAvailable = typeof window.owb.createGoalTaskAcceptance === "function" && !!workspaceKey;
  const unavailable = own(detail.taskDeliveryUnavailable, item.taskId);
  const unavailableKey = detail.executionUnavailable ? "project.executionUnavailable" : unavailable === "session_required"
    ? "project.acceptance.sessionRequired"
    : unavailable === "output_missing"
      ? "project.acceptance.outputMissing"
      : "project.acceptance.executionIncomplete";

  const dateLabel = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, {
      dateStyle: "medium", timeStyle: "short",
    }).format(date);
  };
  const patchDraft = (fields: Partial<ReviewDraft>) => {
    // Once a user edits a failed request, it is a new idempotent operation.
    setDraft((previous) => ({ ...previous, ...fields, idempotencyKey: crypto.randomUUID() }));
    setSaved(null);
  };
  const decide = async (decision: "accepted" | "rejected") => {
    if (locked.current || stale || !bridgeAvailable || !draft.delivery ||
      (decision === "accepted" ? !allChecked : !draft.note.trim())) return;
    const thisRequest = ++request.current;
    const thisScope = scope;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const previousAttempt = attempt.current;
      const requestKey = previousAttempt?.draftKey === draft.idempotencyKey && previousAttempt.decision === decision
        ? previousAttempt.requestKey : crypto.randomUUID();
      attempt.current = { draftKey: draft.idempotencyKey, decision, requestKey };
      const createAcceptance = window.owb.createGoalTaskAcceptance;
      if (!createAcceptance || !workspaceKey) throw new Error(t("project.acceptance.unavailable"));
      const result = await createAcceptance({
        goalId: detail.goal.goalId,
        taskId: item.taskId,
        expectedWorkspacePath: workspaceKey,
        expectedUpdatedAt: draft.version,
        idempotencyKey: requestKey,
        source: draft.delivery.source,
        decision,
        verdicts: draft.criteria.map((_, criteriaIndex) => ({
          criteriaIndex, passed: draft.checked[criteriaIndex] ?? false,
        })),
        ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
      });
      if (thisRequest !== request.current || thisScope !== currentScope.current) return;
      if (result.status !== 200 && result.status !== 201) {
        if (result.status === 409) setConflict(true);
        throw new Error(t(result.status === 409 ? "project.acceptance.conflict" : "project.acceptance.saveError"));
      }
      if (!result.body?.record) throw new Error(t("project.acceptance.saveError"));
      setSaved(result.body.record);
      try {
        await onRefresh();
      } catch {
        if (thisRequest === request.current && thisScope === currentScope.current) {
          setError(t("project.acceptance.refreshError"));
        }
      }
    } catch (cause) {
      if (thisRequest === request.current && thisScope === currentScope.current) {
        setError(cause instanceof Error ? cause.message : t("project.acceptance.saveError"));
      }
    } finally {
      if (thisRequest === request.current && thisScope === currentScope.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  };
  const reload = async () => {
    if (locked.current) return;
    const thisRequest = ++request.current;
    const thisScope = scope;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await window.owb.goal(detail.goal.goalId);
      if (thisRequest !== request.current || thisScope !== currentScope.current) return;
      if (result.status !== 200 || !result.body?.goal) throw new Error(t("project.acceptance.reloadError"));
      const latest = result.body;
      const latestTask = latest.goal.workItems?.find((task) => task.taskId === item.taskId);
      if (!latestTask) throw new Error(t("project.acceptance.taskRemoved"));
      const next = draftFrom(latest, item.taskId);
      setDraft((previous) => ({
        ...next,
        note: previous.note,
        checked: sameSource(previous.delivery, next.delivery)
          ? next.criteria.map((criterion, index) => previous.criteria[index] === criterion && !!previous.checked[index])
          : next.checked,
      }));
      setConflict(false);
      setSaved(null);
      setReloaded(true);
      await onRefresh();
    } catch (cause) {
      if (thisRequest === request.current && thisScope === currentScope.current) {
        setError(cause instanceof Error ? cause.message : t("project.acceptance.reloadError"));
      }
    } finally {
      if (thisRequest === request.current && thisScope === currentScope.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <Drawer
      title={t("project.acceptance.title", { title: item.title })}
      open
      size="min(640px, calc(100vw - 24px))"
      onClose={() => { if (!busy) onClose(); }}
      maskClosable={!busy}
      closable={!busy}
      footer={
        <div className="owb-task-acceptance__footer">
          <Button disabled={busy} onClick={onClose}>{t("dlg.close")}</Button>
          {!saved && <>
            <Button danger disabled={busy || stale || !bridgeAvailable || !draft.delivery || !draft.note.trim()} onClick={() => void decide("rejected")}>
              {t("project.acceptance.reject")}
            </Button>
            <Button type="primary" disabled={busy || stale || !bridgeAvailable || !allChecked} loading={busy} onClick={() => void decide("accepted")}>
              {t("project.acceptance.accept")}
            </Button>
          </>}
        </div>
      }
    >
      <div className="owb-task-acceptance">
        <p className="owb-task-acceptance__intro">{t("project.acceptance.explanation")}</p>
        {!bridgeAvailable && <p role="status" className="owb-project-notice">{t("project.acceptance.unavailable")}</p>}
        {saved && <p role="status" className="owb-task-acceptance__success">{t(`project.acceptance.saved.${saved.decision}`)}</p>}
        {error && <p role="alert" className="owb-project-error">{error}</p>}
        {!saved && stale && <div className="owb-task-acceptance__conflict" role="status">
          <p>{t(taskExists ? "project.acceptance.conflict" : "project.acceptance.taskRemoved")}</p>
          <Button disabled={busy} onClick={() => void reload()}>{t("project.acceptance.reload")}</Button>
        </div>}
        {!saved && reloaded && <p role="status" className="owb-project-notice">{t("project.acceptance.reloaded")}</p>}
        {draft.delivery ? <section className="owb-task-acceptance__delivery">
          <h4>{t("project.acceptance.delivery")}</h4>
          <dl>
            <dt>{t("project.acceptance.completedAt")}</dt><dd>{dateLabel(draft.delivery.completedAt)}</dd>
            <dt>{t("project.acceptance.session")}</dt><dd>{draft.delivery.source.sessionId}</dd>
            <dt>{t("project.acceptance.turn")}</dt><dd>{draft.delivery.source.turnId}</dd>
          </dl>
          <pre aria-label={t("project.acceptance.output")}>{outputText(draft.delivery.output)}</pre>
        </section> : <p role="status" className="owb-project-notice">{t(unavailableKey)}</p>}
        {!saved && draft.delivery && <fieldset disabled={busy || stale} className="owb-task-acceptance__criteria">
          <legend>{t("project.acceptance.criteria")}</legend>
          {draft.criteria.length === 0 ? <p role="status">{t("project.acceptance.noCriteria")}</p> : draft.criteria.map((criterion, index) => (
            <Checkbox key={index} checked={!!draft.checked[index]} onChange={(event) => {
              const checked = [...draft.checked];
              checked[index] = event.target.checked;
              patchDraft({ checked });
            }}>{criterion}</Checkbox>
          ))}
          <label className="owb-task-acceptance__note">
            <span>{t("project.acceptance.note")}</span>
            <Input.TextArea rows={3} maxLength={4096} value={draft.note} onChange={(event) => patchDraft({ note: event.target.value })} />
          </label>
          <p>{t("project.acceptance.noteHint")}</p>
        </fieldset>}
        <section className="owb-task-acceptance__history" aria-label={t("project.acceptance.history")}>
          <h4>{t("project.acceptance.history")}</h4>
          {history.length === 0 ? <p>{t("project.acceptance.noHistory")}</p> : [...history].reverse().map((record) => (
            <article key={record.acceptanceId} data-decision={record.decision}>
              <header><strong>{t(`project.acceptance.decision.${record.decision}`)}</strong><time dateTime={record.decidedAt}>{dateLabel(record.decidedAt)}</time></header>
              <p className="owb-task-acceptance__actor">{t("project.acceptance.decidedBy", { actor: record.decidedBy })}</p>
              <p className="owb-task-acceptance__source">{t("project.acceptance.sourceTurn", { turnId: record.source.turnId })}</p>
              <ul>{record.criteriaSnapshot.map((criterion, index) => {
                const passed = record.verdicts.some((verdict) => verdict.criteriaIndex === index && verdict.passed);
                return <li key={index} data-passed={passed}>
                  <span aria-label={t(passed ? "project.acceptance.passed" : "project.acceptance.notPassed")}>{passed ? "✓" : "○"}</span>{criterion}
                </li>;
              })}</ul>
              {record.note && <p className="owb-task-acceptance__history-note">{record.note}</p>}
            </article>
          ))}
        </section>
      </div>
    </Drawer>
  );
}
