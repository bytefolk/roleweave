import { useEffect, useRef, useState } from "react";
import { Button, Popover, Tag, Tooltip } from "antd";
import { CircleDollarSign } from "lucide-react";
import type {
  BudgetRemainingAdviceChoice,
  BudgetRemainingAdviceResponse,
  ExperimentsResponse,
} from "@roleweave/shared";
import { budgetRemainingAdviceChoices } from "@roleweave/shared/experiments";
import { useExperimentCopy } from "../locales/experiments";
import { useConversationCopy } from "../locales/conversation";
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
  const copy = useConversationCopy();
  const requestVersion = useRef(0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BudgetRemainingAdviceResponse | null>(null);
  const [selected, setSelected] = useState<BudgetRemainingAdviceChoice | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    requestVersion.current += 1;
    setLoading(false);
    setResult(null);
    setSelected(null);
    setFailed(false);
    setOpen(false);
  }, [experiment.workspacePath, experiment.workspaceSession, experiment.revision, positionId]);

  const check = async () => {
    const bridge = window.owb?.budgetRemainingAdvice;
    if (loading) return;
    if (!bridge) { setFailed(true); return; }
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

  const content = <section className="owb-budget-advice" role="region" aria-label={c("budgetTitle")} aria-busy={loading} tabIndex={-1} ref={panelRef}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); triggerRef.current?.focus(); } }}>
    <div className="owb-budget-advice__facts">
      {result ? <>
        <div className="owb-budget-advice__quota">
        <span>{c("budgetTaskRemaining")}：{result.fact.remainingPerTask === null ? c("budgetUnknown") : `${result.fact.remainingPerTask} tokens`}</span>
        <span>{c("budgetDayRemaining")}：{result.fact.remainingPerDay === null ? c("budgetUnknown") : `${result.fact.remainingPerDay} tokens`}</span>
        </div>
        {result.status === "abstained" && result.reason === "unknown_remaining"
          ? <span role="status">{c("budgetUnknownAbstain")}</span>
          : null}
        {suggestion ? <div className="owb-budget-advice__suggestion">
        <span>{c("budgetSuggestion")}：{choiceLabel(suggestion)}</span>
        {notAdopted ? <Tag>{c("budgetNotAdopted")}</Tag> : null}
        {suggestion && selected === suggestion
          ? <span>{c("budgetSelected")}：{choiceLabel(selected)}</span>
          : null}
        </div> : null}
      </> : <span>{c("budgetIntro")}</span>}
      {loading ? <span role="status">{copy.budgetChecking}</span> : null}
      {failed ? <span role="status">{c("budgetFailed")}</span> : null}
    </div>
    <div className="owb-budget-advice__actions">
      {suggestion && notAdopted
        ? <Button size="small" onClick={() => setSelected(suggestion)}>{c("budgetApply")}</Button>
        : null}
    </div>
  </section>;
  return <Tooltip title={c("budgetCheck")} trigger={["hover", "focus"]} open={open ? false : undefined}>
    <span className="owb-turn-composer__action-trigger">
    <Popover classNames={{ root: "owb-conversation-popover owb-budget-advice-popover" }}
    trigger="click" placement="topRight" arrow={false} title={c("budgetTitle")} content={content}
    afterOpenChange={shown => { if (shown && open) queueMicrotask(() => panelRef.current?.focus()); }}
    open={open} onOpenChange={next => { setOpen(next); if (next) void check(); }}>
      <Button ref={triggerRef} className="owb-budget-advice__trigger" type="text" size="small" loading={loading}
        aria-label={c("budgetCheck")} aria-expanded={open}
        icon={<CircleDollarSign size={15} aria-hidden="true" />} />
    </Popover>
    </span>
  </Tooltip>;
}
