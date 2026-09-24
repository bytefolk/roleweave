import { Button, Drawer, Progress, Skeleton, Space, Tag } from "antd";
import { useT } from "@roleweave/ui";
import type { TaskProgressSnapshot, TurnProgressStepStatus } from "@roleweave/shared";
import { Activity, RefreshCw } from "lucide-react";
import { useTaskProgress } from "./useTaskProgress";
import { TaskProgressTimeline } from "./TaskProgressTimeline";
import "./progress.css";

const statusTone: Record<TaskProgressSnapshot["overallStatus"], string> = {
  running: "processing",
  success: "success",
  failed: "error",
  stuck: "warning",
};

function elapsed(snapshot: TaskProgressSnapshot): string {
  const end = snapshot.overallStatus === "running" || snapshot.overallStatus === "stuck" ? Date.now() : snapshot.updatedAt;
  const seconds = Math.max(0, Math.round((end - snapshot.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function stepLabel(snapshot: TaskProgressSnapshot): string {
  return snapshot.steps[snapshot.currentStep]?.name ?? "—";
}

export function ProgressBoard({ workspaceOpen, positionNames }: { workspaceOpen: boolean; positionNames?: Record<string, string> }) {
  const t = useT();
  const { snapshots, loading, selected, select } = useTaskProgress(workspaceOpen);

  if (!workspaceOpen) {
    return <section className="owb-progress" aria-label={t("progress.moduleAria")}><p className="owb-muted">{t("progress.needWorkspace")}</p></section>;
  }
  if (loading && snapshots.length === 0) {
    return <section className="owb-progress" aria-label={t("progress.moduleAria")}><Skeleton active paragraph={{ rows: 6 }} /></section>;
  }

  return (
    <section className="owb-progress" aria-label={t("progress.moduleAria")}>
      <header className="owb-progress__hero">
        <div>
          <h1>{t("progress.title")}</h1>
          <p>{t("progress.lede")}</p>
        </div>
      </header>
      {snapshots.length === 0 ? <p className="owb-muted">{t("progress.empty")}</p> : (
        <ul className="owb-progress__list">
          {snapshots.map((snapshot) => (
            <li key={snapshot.taskId}>
              <button type="button" className={`owb-progress__row is-${snapshot.overallStatus}`} onClick={() => select(snapshot.taskId)}>
                <span className={`owb-progress__dot is-${snapshot.overallStatus}`} aria-hidden="true" />
                <span className="owb-progress__who">{snapshot.employeeName ?? positionNames?.[snapshot.positionId] ?? snapshot.positionId}</span>
                <span className="owb-progress__title">{snapshot.taskTitle ?? snapshot.taskId}</span>
                <Progress
                  className={snapshot.overallStatus === "stuck" ? "owb-progress__bar is-stuck" : "owb-progress__bar"}
                  percent={snapshot.progress}
                  size="small"
                  status={snapshot.overallStatus === "failed" ? "exception" : snapshot.overallStatus === "success" ? "success" : "active"}
                />
                <span className="owb-progress__step">{stepLabel(snapshot)}</span>
                <span className="owb-progress__elapsed">{elapsed(snapshot)}</span>
                <Tag color={statusTone[snapshot.overallStatus]}>{t(`progress.status.${snapshot.overallStatus}`)}</Tag>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Drawer
        title={selected ? (selected.taskTitle ?? selected.taskId) : t("progress.detail")}
        open={selected !== null}
        onClose={() => select(null)}
        width={480}
        destroyOnClose
        footer={selected ? (
          <Space>
            <Button disabled aria-label={t("progress.abort")} title={t("progress.abortHint")}>{t("progress.abort")}</Button>
            <Button disabled aria-label={t("progress.retry")} title={t("progress.retryHint")}>{t("progress.retry")}</Button>
          </Space>
        ) : null}
      >
        {selected ? <TaskProgressTimeline snapshot={selected} /> : null}
      </Drawer>
    </section>
  );
}

export function ProgressStatusDot({ status }: { status: TurnProgressStepStatus }) {
  return <span className={`owb-progress__dot is-${status}`} />;
}

export function ProgressRefreshHint({ onRefresh }: { onRefresh?: () => void }) {
  const t = useT();
  return onRefresh ? <Button icon={<RefreshCw size={14} />} onClick={onRefresh}>{t("progress.refresh")}</Button> : null;
}

export function ProgressRailIcon() {
  return <Activity aria-hidden="true" size={16} />;
}
