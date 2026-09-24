import { Timeline } from "antd";
import { useT } from "@roleweave/ui";
import type { TaskProgressSnapshot, TurnProgressStepView } from "@roleweave/shared";

function duration(step: TurnProgressStepView): string {
  if (step.durationMs === undefined) return "";
  if (step.durationMs < 1000) return `${step.durationMs}ms`;
  return `${(step.durationMs / 1000).toFixed(1)}s`;
}

export function TaskProgressTimeline({ snapshot }: { snapshot: TaskProgressSnapshot }) {
  const t = useT();
  return (
    <div className="owb-progress-timeline">
      <p className="owb-progress-timeline__meta">
        {t("progress.employee")}: {snapshot.employeeName ?? snapshot.positionId}
        {snapshot.retryOf ? ` · ${t("progress.retryOf")} ${snapshot.retryOf}` : ""}
      </p>
      <Timeline
        items={snapshot.steps.map((step) => ({
          color: step.status === "failed" ? "red" : step.status === "success" ? "green" : step.status === "running" ? "blue" : "gray",
          children: (
            <div>
              <strong>{step.name}</strong>
              <span className="owb-muted"> · {t(`progress.step.${step.status}`)}{duration(step) ? ` · ${duration(step)}` : ""}</span>
              {step.message ? <p className="owb-progress-timeline__message">{step.message}</p> : null}
            </div>
          ),
        }))}
      />
    </div>
  );
}
