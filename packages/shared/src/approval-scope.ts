export const APPROVAL_SCOPE_OFFER_VERSION = "approval-scope-offer.v1" as const;

export interface ApprovalScopeOffer {
  version: typeof APPROVAL_SCOPE_OFFER_VERSION;
  /** Always includes once; run is opt-in and must carry a binding. */
  allowed: Array<"once" | "run">;
  runBinding?: string;
}

export interface ApprovalScopeAction {
  kind: string;
  description: string;
  target?: string;
}

export function approvalRunScopeBindingInput(approvalId: string, runId: string, action: ApprovalScopeAction, expiresAt?: string): string {
  return JSON.stringify({ approvalId, runId, action: { kind: action.kind, description: action.description, ...(action.target === undefined ? {} : { target: action.target }) }, ...(expiresAt === undefined ? {} : { expiresAt }) });
}

export function isApprovalScopeOffer(value: unknown): value is ApprovalScopeOffer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const offer = value as Record<string, unknown>;
  if (Object.keys(offer).some(key => !["version", "allowed", "runBinding"].includes(key)) ||
      offer.version !== APPROVAL_SCOPE_OFFER_VERSION || !Array.isArray(offer.allowed) ||
      offer.allowed.length < 1 || offer.allowed.length > 2 || offer.allowed[0] !== "once" ||
      new Set(offer.allowed).size !== offer.allowed.length || offer.allowed.some(scope => scope !== "once" && scope !== "run")) return false;
  return offer.allowed.includes("run")
    ? typeof offer.runBinding === "string" && /^sha256:[a-f0-9]{64}$/.test(offer.runBinding)
    : offer.runBinding === undefined;
}
