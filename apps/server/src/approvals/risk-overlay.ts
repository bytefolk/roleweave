import type { ApprovalRequestedEvent, ApprovalRiskLevel } from "@roleweave/shared";

/** Deterministic rule — same mapping as capabilityContext. Overlay must never
 * replace this for Tag color or policy. */
export function ruleRiskFromKind(kind: ApprovalRequestedEvent["action"]["kind"]): ApprovalRiskLevel {
  return kind === "tool" ? "medium" : "high";
}

export function presentApprovalRisk(rule: ApprovalRiskLevel, overlay?: ApprovalRiskLevel) {
  return {
    display: rule,
    overlay,
    notAdopted: overlay !== undefined && overlay !== rule,
  };
}

/** Kind-only payload. Description, target, and turn bodies are forbidden. */
export function assertKindOnlyAdvicePayload(payload: Record<string, unknown>): void {
  const extra = Object.keys(payload).filter((key) => key !== "kind");
  if (extra.length > 0) {
    throw new Error(`jev approval-risk payload has forbidden keys: ${extra.sort().join(",")}`);
  }
  if (payload.kind !== "exec" && payload.kind !== "write" && payload.kind !== "network" && payload.kind !== "tool") {
    throw new Error("jev approval-risk payload kind is invalid");
  }
}

export function mapAdviceChoiceToRisk(choice: string): ApprovalRiskLevel | null {
  if (choice === "medium" || choice === "high") return choice;
  return null;
}
