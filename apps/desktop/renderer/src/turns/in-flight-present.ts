import type { InFlightFact, InFlightMatching } from "./InFlightDuplicateHint";

export function presentInFlightOverlay(input: {
  flagOn: boolean;
  hasConfirmedTaskSummary: boolean;
  facts: InFlightFact[];
  choice?: InFlightMatching;
}): { visible: boolean; facts: InFlightFact[]; matching: InFlightMatching } {
  if (!input.flagOn) return { visible: false, facts: [], matching: "abstain" };
  const facts = input.facts.filter((fact) => fact.status === "running");
  if (!input.hasConfirmedTaskSummary) return { visible: true, facts, matching: "abstain" };
  const choice = input.choice === "join_existing" || input.choice === "send_anyway" ? input.choice : "abstain";
  return { visible: true, facts, matching: choice };
}
