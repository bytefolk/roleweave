import { useState } from "react";
import { useT } from "@roleweave/ui";
import type { RelayHandoffSnapshot } from "@roleweave/shared";

export function RelayHandoffDetails({ snapshot, positionName }: {
  snapshot: RelayHandoffSnapshot;
  positionName: (id: string) => string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const p = snapshot.payload;
  return <details className="owb-relay-handoff" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("grp.handoffTitle")} · {t("grp.handoffStep", { number: p.step.number, total: p.step.total })} · {positionName(p.step.positionId)}</summary>
    {open ? <div className="owb-relay-handoff__body">
      <p className="owb-muted">{t("grp.handoffSnapshot")} <time dateTime={p.generatedAt}>{new Date(p.generatedAt).toLocaleString()}</time></p>
      <dl>
        <dt>{t("grp.handoffTask")}</dt><dd>{p.taskExcerpt}</dd>
        <dt>{t("grp.handoffInstruction")}</dt><dd>{p.instruction ?? t("grp.handoffUnspecified")}</dd>
        <dt>{t("grp.handoffNext")}</dt><dd>{p.step.nextPositionId ? positionName(p.step.nextPositionId) : t("grp.handoffLast")}</dd>
      </dl>
      <p>{t("grp.handoffCompletedNotice")}</p>
      {p.taskExcerptTruncated ? <p>{t("grp.handoffTaskTrimmed")}</p> : null}
      {p.redacted ? <p>{t("grp.handoffRedacted")}</p> : null}
      {p.omittedSourceCount > 0 ? <p>{t("grp.handoffOmitted", { count: p.omittedSourceCount })}</p> : null}
      {p.sources.length === 0 ? <p className="owb-muted">{t("grp.handoffFirst")}</p> : p.sources.map(source => <section key={source.turnId}>
        <strong>{positionName(source.positionId)}</strong>
        <p className="owb-muted">{t("grp.handoffSource")} <code>{source.turnId}</code> · <time dateTime={source.sourceUpdatedAt}>{new Date(source.sourceUpdatedAt).toLocaleString()}</time></p>
        <pre>{source.outputExcerpt || t("grp.handoffEmpty")}</pre>
        {source.truncated ? <p>{t("grp.handoffSourceTrimmed")}</p> : null}
      </section>)}
    </div> : null}
  </details>;
}
