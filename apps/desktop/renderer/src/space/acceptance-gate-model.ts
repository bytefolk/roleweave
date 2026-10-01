// Value import via the subpath; see SpaceModule for why the barrel is avoided.
import { ACCEPTANCE_SCHEMA_VERSION } from "@roleweave/shared/acceptance";
import type {
  AcceptanceDecision,
  AcceptanceRecord,
  AcceptanceVerdict,
  SpaceDocCriterion,
} from "@roleweave/shared";

/**
 * Build the acceptance payload for a space gate.
 *
 * The gate is the one place where the UI must not be able to produce an
 * invalid record: an `accepted` decision is only legal when every criterion
 * is ticked. Rather than let the component decide that, it funnels through
 * here so the rule is testable on its own.
 */
export interface GateDraft {
  spaceId: string;
  positionId: string;
  turnId?: string;
  artifactPath?: string;
  decidedBy: string;
}

export interface GateTicks {
  /** criteriaIndex → ticked. Absent means unticked. */
  [criteriaIndex: number]: boolean;
}

export interface GateEvidence {
  /** criteriaIndex → artifact path shown as evidence. */
  [criteriaIndex: number]: string | undefined;
}

export function untickedCriteria(criteria: SpaceDocCriterion[], ticks: GateTicks): number[] {
  return criteria.filter((criterion) => ticks[criterion.criteriaIndex] !== true).map((criterion) => criterion.criteriaIndex);
}

/** The accept button is enabled only when this is true. */
export function canAccept(criteria: SpaceDocCriterion[], ticks: GateTicks): boolean {
  return criteria.length > 0 && untickedCriteria(criteria, ticks).length === 0;
}

/** A rejection is only meaningful with a reason; the field is not optional here. */
export function canReject(note: string): boolean {
  return note.trim().length > 0;
}

export function buildVerdicts(criteria: SpaceDocCriterion[], ticks: GateTicks, evidence: GateEvidence = {}): AcceptanceVerdict[] {
  return criteria.map((criterion) => {
    const verdict: AcceptanceVerdict = {
      criteriaIndex: criterion.criteriaIndex,
      passed: ticks[criterion.criteriaIndex] === true,
    };
    const path = evidence[criterion.criteriaIndex];
    if (path !== undefined && path.trim().length > 0) verdict.evidencePath = path;
    return verdict;
  });
}

export function buildAcceptanceRecord(
  draft: GateDraft,
  criteria: SpaceDocCriterion[],
  ticks: GateTicks,
  decision: AcceptanceDecision,
  note: string,
  evidence: GateEvidence = {},
  now: () => Date = () => new Date(),
): AcceptanceRecord {
  if (decision === "accepted" && !canAccept(criteria, ticks)) {
    throw new Error("cannot accept while criteria remain unticked");
  }
  if (decision === "rejected" && !canReject(note)) {
    throw new Error("cannot reject without a note");
  }

  const record: AcceptanceRecord = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    acceptanceId: `${draft.spaceId}:${now().toISOString()}`,
    spaceId: draft.spaceId,
    source: { positionId: draft.positionId },
    verdicts: buildVerdicts(criteria, ticks, evidence),
    decision,
    decidedBy: draft.decidedBy,
    decidedAt: now().toISOString(),
  };
  if (draft.turnId !== undefined) record.source.turnId = draft.turnId;
  if (draft.artifactPath !== undefined) record.source.artifactPath = draft.artifactPath;
  if (decision === "rejected") record.note = note.trim();

  return record;
}
