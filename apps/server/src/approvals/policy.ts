import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { OrgApiError, errorCodes, type ApprovalPolicySnapshot, type ApprovalRecord } from "@roleweave/shared";

const ACTOR = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const invalid = () => new OrgApiError(errorCodes.approval_request_invalid, 400, "Approval policy is invalid");

type Rule = {
  positionId?: string;
  actionKinds?: Array<ApprovalRecord["action"]["kind"]>;
  eligibleApprovers: string[];
  threshold: number;
  delegations?: Record<string, string[]>;
  escalation?: { afterMs: number; eligibleApprovers: string[]; threshold: number };
  /** Explicit #403 classification: only medium-risk tools may opt into a
   * homogeneous recovery batch. */
  batch?: { maxItems: number; actionKinds: Array<"tool"> };
};
type PolicyFile = { schemaVersion: "roleweave-approval-policy.v1"; version: string; default: Rule; rules?: Rule[] };

function validPeople(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 64 &&
    value.every(v => typeof v === "string" && ACTOR.test(v)) && new Set(value).size === value.length;
}
function validRule(value: unknown): value is Rule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Rule;
  return Object.keys(r).every(k => ["positionId", "actionKinds", "eligibleApprovers", "threshold", "delegations", "escalation", "batch"].includes(k)) &&
    (r.positionId === undefined || (typeof r.positionId === "string" && ACTOR.test(r.positionId))) &&
    (r.actionKinds === undefined || (Array.isArray(r.actionKinds) && r.actionKinds.length > 0 && r.actionKinds.every(k => ["write", "exec", "network", "tool"].includes(k)))) &&
    validPeople(r.eligibleApprovers) && Number.isSafeInteger(r.threshold) && r.threshold >= 1 && r.threshold <= r.eligibleApprovers.length &&
    (r.delegations === undefined || (typeof r.delegations === "object" && !Array.isArray(r.delegations) && Object.entries(r.delegations).every(([from, to]) => ACTOR.test(from) && validPeople(to)))) &&
    (r.escalation === undefined || (typeof r.escalation === "object" && Number.isSafeInteger(r.escalation.afterMs) && r.escalation.afterMs > 0 && r.escalation.afterMs <= 31_536_000_000 && validPeople(r.escalation.eligibleApprovers) && Number.isSafeInteger(r.escalation.threshold) && r.escalation.threshold >= 1 && r.escalation.threshold <= r.escalation.eligibleApprovers.length)) &&
    (r.batch === undefined || (typeof r.batch === "object" && !Array.isArray(r.batch) && Object.keys(r.batch).every(k => ["maxItems", "actionKinds"].includes(k)) && Number.isSafeInteger(r.batch.maxItems) && r.batch.maxItems >= 2 && r.batch.maxItems <= 32 && Array.isArray(r.batch.actionKinds) && r.batch.actionKinds.length === 1 && r.batch.actionKinds[0] === "tool"));
}

function defaultFile(): PolicyFile {
  return { schemaVersion: "roleweave-approval-policy.v1", version: "local-operator-v1", default: { eligibleApprovers: ["operator"], threshold: 1 } };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function approvalPolicyDigest(policy: Omit<ApprovalPolicySnapshot, "digest">): string {
  return `sha256:${crypto.createHash("sha256").update(canonical(policy)).digest("hex")}`;
}

/** Read an optional workspace-local policy.  The policy is copied into each
 * request, so edits only govern future requests and cannot rewrite history. */
export async function resolveApprovalPolicy(workspace: string, record: Pick<ApprovalRecord, "source" | "action" | "requestedAt">): Promise<ApprovalPolicySnapshot> {
  const file = path.join(workspace, ".roleweave", "approval-policy.json");
  let raw: unknown = defaultFile();
  try { raw = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw invalid(); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const policy = raw as PolicyFile;
  if (Object.keys(policy).some(k => !["schemaVersion", "version", "default", "rules"].includes(k)) ||
      policy.schemaVersion !== "roleweave-approval-policy.v1" || typeof policy.version !== "string" || !ACTOR.test(policy.version) ||
      !validRule(policy.default) || (policy.rules !== undefined && (!Array.isArray(policy.rules) || policy.rules.length > 64 || !policy.rules.every(validRule)))) throw invalid();
  const selected = policy.rules?.find(r => (r.positionId === undefined || r.positionId === record.source.positionId) &&
    (r.actionKinds === undefined || r.actionKinds.includes(record.action.kind))) ?? policy.default;
  const escalation = selected.escalation ? {
    at: new Date(Date.parse(record.requestedAt) + selected.escalation.afterMs).toISOString(),
    eligibleApprovers: selected.escalation.eligibleApprovers,
    threshold: selected.escalation.threshold,
  } : undefined;
  const snapshot = { version: policy.version, eligibleApprovers: selected.eligibleApprovers, threshold: selected.threshold,
    delegations: selected.delegations ?? {}, ...(selected.batch ? { batch: selected.batch } : {}), ...(escalation ? { escalation } : {}) };
  return { ...snapshot, digest: approvalPolicyDigest(snapshot) };
}

export function effectivePolicy(policy: ApprovalPolicySnapshot, now = Date.now()): Pick<ApprovalPolicySnapshot, "eligibleApprovers" | "threshold"> & { escalated: boolean } {
  const escalated = !!policy.escalation && now >= Date.parse(policy.escalation.at);
  return escalated ? { eligibleApprovers: policy.escalation!.eligibleApprovers, threshold: policy.escalation!.threshold, escalated } :
    { eligibleApprovers: policy.eligibleApprovers, threshold: policy.threshold, escalated };
}

export function policyProgress(policy: ApprovalPolicySnapshot, decisions: readonly { decision: string; actor: string; delegatedFrom?: string }[], now = Date.now()) {
  const current = effectivePolicy(policy, now);
  const grants = new Set(decisions.filter(d => d.decision === "granted")
    .map(d => d.delegatedFrom ?? d.actor)
    .filter(principal => current.eligibleApprovers.includes(principal)));
  return { required: current.threshold, granted: grants.size, pending: Math.max(0, current.threshold - grants.size), escalated: current.escalated };
}

export function canActForPolicy(policy: ApprovalPolicySnapshot, actor: string, delegatedFrom: string | undefined, now = Date.now()): boolean {
  const current = effectivePolicy(policy, now);
  if (!delegatedFrom) return current.eligibleApprovers.includes(actor);
  return current.eligibleApprovers.includes(delegatedFrom) && policy.delegations[delegatedFrom]?.includes(actor) === true;
}
