import { useMemo, useState } from "react";
import { Button as AntButton, Checkbox, Input } from "antd";
import { CheckCircle2, XCircle } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { AcceptanceDecision, SpaceDocCriterion } from "@roleweave/shared";
import {
  buildAcceptanceRecord,
  canAccept,
  canReject,
  untickedCriteria,
  type GateDraft,
  type GateEvidence,
  type GateTicks,
} from "./acceptance-gate-model.js";
import "./space-gate.css";

export interface AcceptanceGateProps {
  draft: GateDraft;
  criteria: SpaceDocCriterion[];
  /** Called with a record that has already passed the model's invariants. */
  onDecide: (decision: AcceptanceDecision, record: ReturnType<typeof buildAcceptanceRecord>) => void | Promise<void>;
  busy?: boolean;
}

/**
 * The single place the human signs off. Accept stays disabled until every
 * criterion is ticked, and reject demands a reason — the same invariants
 * `acceptance.v1` enforces, surfaced before anything is submitted.
 */
export function AcceptanceGate({ draft, criteria, onDecide, busy = false }: AcceptanceGateProps) {
  const t = useT();
  const [ticks, setTicks] = useState<GateTicks>({});
  const [evidence, setEvidence] = useState<GateEvidence>({});
  const [note, setNote] = useState("");
  const [pendingDecision, setPendingDecision] = useState<AcceptanceDecision | null>(null);

  const remaining = useMemo(() => untickedCriteria(criteria, ticks), [criteria, ticks]);
  const acceptReady = canAccept(criteria, ticks);
  const rejectReady = canReject(note);

  const submit = (decision: AcceptanceDecision) => {
    const record = buildAcceptanceRecord(draft, criteria, ticks, decision, note, evidence);
    setPendingDecision(null);
    void onDecide(decision, record);
  };

  if (criteria.length === 0) {
    return (
      <div className="owb-space-gate owb-space-gate--empty">
        <p className="owb-space-gate__empty">{t("space.gate.empty")}</p>
      </div>
    );
  }

  return (
    <div className="owb-space-gate" data-ticked={criteria.length - remaining.length} data-total={criteria.length}>
      <div className="owb-space-gate__head">
        <h3 className="owb-space-gate__title">{t("space.gate.title")}</h3>
        <span className="owb-space-gate__progress">
          {t("space.gate.progress", { done: criteria.length - remaining.length, total: criteria.length })}
        </span>
      </div>

      <ul className="owb-space-gate__list">
        {criteria.map((criterion) => (
          <li key={criterion.criteriaIndex} className="owb-space-gate__item">
            <Checkbox
              checked={ticks[criterion.criteriaIndex] === true}
              onChange={(event) =>
                setTicks((prev) => ({ ...prev, [criterion.criteriaIndex]: event.target.checked }))
              }
            >
              {criterion.text}
            </Checkbox>
            <Input
              className="owb-space-gate__evidence"
              size="small"
              value={evidence[criterion.criteriaIndex] ?? ""}
              placeholder={t("space.gate.evidencePlaceholder")}
              onChange={(event) =>
                setEvidence((prev) => ({ ...prev, [criterion.criteriaIndex]: event.target.value }))
              }
            />
          </li>
        ))}
      </ul>

      {remaining.length > 0 ? (
        <p className="owb-space-gate__hint">{t("space.gate.remaining", { count: remaining.length })}</p>
      ) : null}

      <Input.TextArea
        className="owb-space-gate__note"
        rows={2}
        value={note}
        placeholder={t("space.gate.notePlaceholder")}
        onChange={(event) => setNote(event.target.value)}
      />

      <div className="owb-space-gate__actions">
        {pendingDecision === null ? (
          <>
            <AntButton
              type="primary"
              icon={<CheckCircle2 size={14} aria-hidden="true" />}
              disabled={!acceptReady || busy}
              onClick={() => setPendingDecision("accepted")}
            >
              {t("space.gate.accept")}
            </AntButton>
            <AntButton
              danger
              icon={<XCircle size={14} aria-hidden="true" />}
              disabled={!rejectReady || busy}
              onClick={() => setPendingDecision("rejected")}
            >
              {t("space.gate.reject")}
            </AntButton>
          </>
        ) : (
          <>
            <span className="owb-space-gate__confirm">
              {pendingDecision === "accepted" ? t("space.gate.confirmAccept") : t("space.gate.confirmReject")}
            </span>
            <AntButton type="primary" loading={busy} onClick={() => submit(pendingDecision)}>
              {t("space.gate.confirm")}
            </AntButton>
            <AntButton onClick={() => setPendingDecision(null)}>{t("space.gate.cancel")}</AntButton>
          </>
        )}
      </div>
    </div>
  );
}
