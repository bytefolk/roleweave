import { useT } from "@roleweave/ui";

export interface InFlightFact {
  positionId: string;
  status: "running";
  goalId?: string;
  errorCode?: string;
}

export type InFlightMatching = "abstain" | "join_existing" | "send_anyway";

export interface InFlightDuplicateHintProps {
  visible: boolean;
  facts: InFlightFact[];
  matching: InFlightMatching;
  names?: Record<string, string>;
  onJoinExisting?: (positionId: string) => void;
}

/** Overlay-only. Click never cancels a turn or POSTs one. */
export function InFlightDuplicateHint({
  visible,
  facts,
  matching,
  names = {},
  onJoinExisting,
}: InFlightDuplicateHintProps) {
  const t = useT();
  if (!visible || facts.length === 0) return null;
  return (
    <div className="owb-inflight-hint" role="status" data-testid="inflight-duplicate-hint">
      <p>{t("turn.inFlightHeading")}</p>
      <ul>
        {facts.map((fact) => (
          <li key={fact.positionId}>
            {names[fact.positionId] ?? fact.positionId}
            {fact.goalId ? ` · ${fact.goalId}` : ""}
            {fact.errorCode ? ` · ${fact.errorCode}` : ""}
            {matching === "join_existing" && onJoinExisting ? (
              <button type="button" data-testid="inflight-join" onClick={() => onJoinExisting(fact.positionId)}>
                {t("turn.inFlightJoin")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {matching === "abstain" ? <p>{t("turn.inFlightAbstain")}</p> : null}
      {matching === "send_anyway" ? <p>{t("turn.inFlightSendAnyway")}</p> : null}
    </div>
  );
}
