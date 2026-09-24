import { useEffect, useRef, useState } from "react";
import { Button, Tag } from "antd";
import type {
  BudgetRemainingAdviceChoice,
  BudgetRemainingAdviceResponse,
  ExperimentsResponse,
} from "@roleweave/shared";
import { budgetRemainingAdviceChoices } from "@roleweave/shared/experiments";
import { useExperimentCopy } from "../locales/experiments";
import "./budget-remaining-overlay.css";

export interface BudgetRemainingOverlayProps {
  experiment: ExperimentsResponse;
  positionId: string;
}

function validRemaining(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function validResponse(
  value: unknown,
  experiment: ExperimentsResponse,
  positionId: string,
): value is BudgetRemainingAdviceResponse {
  const response = record(value);
  const fact = record(response?.fact);
  if (!response || !fact ||
    !exactKeys(response, ["workspacePath", "workspaceSession", "revision", "status", "reason", "fact", "suggestion"]) ||
    !exactKeys(fact, ["positionId", "remainingPerTask", "remainingPerDay"]) ||
    response.workspacePath !== experiment.workspacePath ||
    response.workspaceSession !== experiment.workspaceSession ||
    response.revision !== experiment.revision ||
    fact.positionId !== positionId ||
    !validRemaining(fact.remainingPerTask) ||
    !validRemaining(fact.remainingPerDay)) return false;

  const suggestion = response.suggestion;
  if (response.status === "ready") {
    return response.reason === undefined &&
      fact.remainingPerTask !== null && fact.remainingPerDay !== null &&
      budgetRemainingAdviceChoices.includes(suggestion as BudgetRemainingAdviceChoice);
  }
  if (suggestion !== null) return false;
  if (response.status === "disabled") return response.reason === "flag_off";
  if (response.status === "unavailable") {
    return response.reason === "not_configured" || response.reason === "settings_invalid";
  }
  if (response.status === "abstained") {
    return response.reason === "insufficient_information" ||
      (response.reason === "unknown_remaining" &&
        (fact.remainingPerTask === null || fact.remainingPerDay === null));
  }
  return false;
}

export function BudgetRemainingOverlay({ experiment, positionId }: BudgetRemainingOverlayProps) {
  const c = useExperimentCopy();
  const requestVersion = useRef(0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BudgetRemainingAdviceResponse | null>(null);
  const [selected, setSelected] = useState<BudgetRemainingAdviceChoice | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    requestVersion.current += 1;
    setLoading(false);
    setResult(null);
    setSelected(null);
    setFailed(false);
  }, [experiment.workspacePath, experiment.workspaceSession, experiment.revision, positionId]);

  const check = async () => {
    const bridge = window.owb?.budgetRemainingAdvice;
    if (!bridge || loading) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setFailed(false);
    setResult(null);
    setSelected(null);
    try {
      const response = await bridge({
        workspacePath: experiment.workspacePath,
        workspaceSession: experiment.workspaceSession,
        revision: experiment.revision,
        positionId,
      });
      if (requestVersion.current !== version) return;
      if (response.status !== 200 || !validResponse(response.body, experiment, positionId)) {
        throw new Error("stale budget advice");
      }
      setResult(response.body);
      setFailed(response.body.status === "unavailable");
    } catch {
      if (requestVersion.current === version) setFailed(true);
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  };

  const suggestion = result?.status === "ready" ? result.suggestion : null;
  const choiceLabel = (choice: BudgetRemainingAdviceChoice) => c(`budgetChoice_${choice}`);
  const notAdopted = suggestion !== null && selected !== suggestion;

  return <section className="owb-budget-advice" role="region" aria-label={c("budgetTitle")}>
    <div className="owb-budget-advice__facts">
      {result ? <>
        <span>{c("budgetTaskRemaining")}：{result.fact.remainingPerTask === null ? c("budgetUnknown") : `${result.fact.remainingPerTask} tokens`}</span>
        <span>{c("budgetDayRemaining")}：{result.fact.remainingPerDay === null ? c("budgetUnknown") : `${result.fact.remainingPerDay} tokens`}</span>
        {result.status === "abstained" && result.reason === "unknown_remaining"
          ? <span role="status">{c("budgetUnknownAbstain")}</span>
          : null}
        {suggestion ? <span>{c("budgetSuggestion")}：{choiceLabel(suggestion)}</span> : null}
        {notAdopted ? <Tag color="gold">{c("budgetNotAdopted")}</Tag> : null}
        {suggestion && selected === suggestion
          ? <span>{c("budgetSelected")}：{choiceLabel(selected)}</span>
          : null}
      </> : <span>{c("budgetIntro")}</span>}
      {failed ? <span role="status">{c("budgetFailed")}</span> : null}
    </div>
    <div className="owb-budget-advice__actions">
      {suggestion && notAdopted
        ? <Button size="small" onClick={() => setSelected(suggestion)}>{c("budgetApply")}</Button>
        : null}
      <Button size="small" type="text" loading={loading} onClick={() => void check()}>
        {c("budgetCheck")}
      </Button>
    </div>
  </section>;
}
