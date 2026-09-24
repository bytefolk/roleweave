import type { ApprovalContext, ApprovalRequestedEvent, ApprovalRiskLevel } from "@roleweave/shared";
import { askJev, type JevAsk } from "../jev/client.js";
import { jevEnabled } from "../jev/config.js";

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

export interface ResolveApprovalRiskOverlayDeps {
  env?: NodeJS.Dict<string>;
  ask?: JevAsk;
}

/** Advisory overlay. Undefined when the flag is off, unconfigured, or invalid. */
export async function resolveApprovalRiskOverlay(
  kind: ApprovalRequestedEvent["action"]["kind"],
  deps: ResolveApprovalRiskOverlayDeps = {},
): Promise<ApprovalRiskLevel | undefined> {
  const env = deps.env ?? process.env;
  if (!jevEnabled(env)) return undefined;
  const payload: Record<string, unknown> = { kind };
  assertKindOnlyAdvicePayload(payload);
  const ask = deps.ask ?? ((request) => askJev(request, { env }));
  try {
    const answers = await ask({
      state: payload,
      questions: {
        risk: {
          type: "choice",
          instructions: "Classify display risk from action kind only. Advisory. Never grant or deny.",
          criteria: {
            medium: "Limited blast radius such as a restricted tool",
            high: "Write, exec, or network action",
          },
        },
      },
    });
    const selected = answers?.risk?.type === "choice" ? answers.risk.selected : undefined;
    if (!selected) return undefined;
    return mapAdviceChoiceToRisk(selected) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Projection-only: never persist the result. Rule risk stays `context.risk`. */
export async function attachApprovalRiskOverlay(
  context: ApprovalContext,
  action: Pick<ApprovalRequestedEvent["action"], "kind">,
  deps: ResolveApprovalRiskOverlayDeps = {},
): Promise<ApprovalContext> {
  const { riskOverlay: _ignored, ...base } = context as ApprovalContext & { riskOverlay?: ApprovalRiskLevel };
  const overlay = await resolveApprovalRiskOverlay(action.kind, deps);
  const presented = presentApprovalRisk(base.risk, overlay);
  if (presented.notAdopted && presented.overlay) {
    return { ...base, riskOverlay: presented.overlay } as ApprovalContext;
  }
  return base;
}
