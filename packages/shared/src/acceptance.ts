/**
 * Acceptance contracts (v1).
 *
 * An AcceptanceRecord is the human act of accepting a deliverable produced by
 * an agent inside a space. It is deliberately separate from an approval:
 *
 *   - approval  -> permission to act, owned by the workspace/organization,
 *                  modelled by ApprovalRecord (packages/shared/src/approvals.ts)
 *   - acceptance -> a verdict on work already done, owned by the space
 *
 * The distinction matters because an agent may only ever push work to `review`.
 * Only an acceptance decision may move it to `done`; the plan side
 * (GoalWorkItem) and the execution side (GoalTaskExecution) never overwrite
 * each other.
 *
 * Validators are fail-closed: object keys are allowlisted, enums are closed,
 * text is bounded, and the decision is cross-checked against the verdicts.
 */

export const ACCEPTANCE_SCHEMA_VERSION = "acceptance.v1" as const;

export const ACCEPTANCE_MAX_ID_LENGTH = 128;
export const ACCEPTANCE_MAX_SHORT_TEXT_LENGTH = 256;
export const ACCEPTANCE_MAX_TEXT_LENGTH = 4_096;
export const ACCEPTANCE_MAX_PATH_LENGTH = 1_024;
export const ACCEPTANCE_MAX_VERDICTS = 64;

export const acceptanceDecisions = ["accepted", "rejected"] as const;
export type AcceptanceDecision = (typeof acceptanceDecisions)[number];

/** Per-criterion verdict. An accepted record must cover every criterion. */
export interface AcceptanceVerdict {
  criteriaIndex: number;
  passed: boolean;
  /** Optional pointer to the artifact that satisfies the criterion. */
  evidencePath?: string;
}

export interface AcceptanceSource {
  positionId: string;
  turnId?: string;
  artifactPath?: string;
}

export interface AcceptanceRecord {
  schemaVersion: typeof ACCEPTANCE_SCHEMA_VERSION;
  acceptanceId: string;
  spaceId: string;
  source: AcceptanceSource;
  verdicts: AcceptanceVerdict[];
  decision: AcceptanceDecision;
  note?: string;
  decidedBy: string;
  decidedAt: string;
}

export interface AcceptanceCreateRequest {
  spaceId: string;
  source: AcceptanceSource;
  verdicts: AcceptanceVerdict[];
  decision: AcceptanceDecision;
  note?: string;
}

// ── Validators ──────────────────────────────────────────────────────────────

export type AcceptanceValidationCode =
  | "acceptance_invalid"
  | "acceptance_unknown_field"
  | "acceptance_empty_string"
  | "acceptance_text_too_long"
  | "acceptance_invalid_enum"
  | "acceptance_duplicate_reference"
  | "acceptance_incomplete_verdicts"
  | "acceptance_missing_note";

export interface AcceptanceValidationFailure {
  ok: false;
  code: AcceptanceValidationCode;
  message: string;
}

export interface AcceptanceValidationSuccess<T> {
  ok: true;
  value: T;
}

export type AcceptanceValidationResult<T> = AcceptanceValidationSuccess<T> | AcceptanceValidationFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: AcceptanceValidationCode, message: string): AcceptanceValidationFailure {
  return { ok: false, code, message };
}

function keysMatch(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function nonEmptyText(
  value: unknown,
  field: string,
  maxLength = ACCEPTANCE_MAX_TEXT_LENGTH,
): AcceptanceValidationResult<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fail("acceptance_empty_string", `${field} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    return fail("acceptance_text_too_long", `${field} exceeds its text bound`);
  }
  if ([...value].some((ch) => ch.charCodeAt(0) < 0x20 && ch !== "\n" && ch !== "\r" && ch !== "\t")) {
    return fail("acceptance_invalid", `${field} contains a control character`);
  }
  return { ok: true, value };
}

function identifier(value: unknown, field: string): AcceptanceValidationResult<string> {
  const result = nonEmptyText(value, field, ACCEPTANCE_MAX_SHORT_TEXT_LENGTH);
  if (!result.ok) return result;
  if (/\s/.test(result.value)) {
    return fail("acceptance_invalid", `${field} must not contain whitespace`);
  }
  return result;
}

function pathText(value: unknown, field: string): AcceptanceValidationResult<string> {
  return nonEmptyText(value, field, ACCEPTANCE_MAX_PATH_LENGTH);
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): AcceptanceValidationResult<T> {
  if (typeof value !== "string" || !values.includes(value as T)) {
    return fail("acceptance_invalid_enum", `${field} is outside the allowlist`);
  }
  return { ok: true, value: value as T };
}

function iso8601(value: unknown, field: string): AcceptanceValidationResult<string> {
  if (typeof value !== "string") return fail("acceptance_invalid", `${field} must be a string`);
  if (value.length > ACCEPTANCE_MAX_SHORT_TEXT_LENGTH) {
    return fail("acceptance_text_too_long", `${field} exceeds its text bound`);
  }
  if (Number.isNaN(Date.parse(value))) {
    return fail("acceptance_invalid", `${field} is not a valid ISO-8601 timestamp`);
  }
  return { ok: true, value };
}

function validateSource(raw: unknown, field: string): AcceptanceValidationResult<AcceptanceSource> {
  if (!isRecord(raw) || !keysMatch(raw, ["positionId"], ["turnId", "artifactPath"])) {
    return fail("acceptance_unknown_field", `${field} has unexpected or missing fields`);
  }
  const positionId = identifier(raw.positionId, `${field}.positionId`);
  if (positionId.ok === false) return fail(positionId.code, positionId.message);

  const source: AcceptanceSource = { positionId: positionId.value };

  if (raw.turnId !== undefined) {
    const turnId = identifier(raw.turnId, `${field}.turnId`);
    if (turnId.ok === false) return fail(turnId.code, turnId.message);
    source.turnId = turnId.value;
  }
  if (raw.artifactPath !== undefined) {
    const artifactPath = pathText(raw.artifactPath, `${field}.artifactPath`);
    if (artifactPath.ok === false) return fail(artifactPath.code, artifactPath.message);
    source.artifactPath = artifactPath.value;
  }
  return { ok: true, value: source };
}

function validateVerdicts(raw: unknown): AcceptanceValidationResult<AcceptanceVerdict[]> {
  if (!Array.isArray(raw)) return fail("acceptance_invalid", "verdicts must be an array");
  if (raw.length > ACCEPTANCE_MAX_VERDICTS) {
    return fail("acceptance_invalid", `verdicts has too many items (max ${ACCEPTANCE_MAX_VERDICTS})`);
  }
  const seen = new Set<number>();
  const verdicts: AcceptanceVerdict[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    const field = `verdicts[${index}]`;
    if (!isRecord(item) || !keysMatch(item, ["criteriaIndex", "passed"], ["evidencePath"])) {
      return fail("acceptance_unknown_field", `${field} has unexpected or missing fields`);
    }
    if (
      typeof item.criteriaIndex !== "number" ||
      !Number.isInteger(item.criteriaIndex) ||
      item.criteriaIndex < 0
    ) {
      return fail("acceptance_invalid", `${field}.criteriaIndex must be a non-negative integer`);
    }
    if (seen.has(item.criteriaIndex)) {
      return fail("acceptance_duplicate_reference", `${field}.criteriaIndex is a duplicate`);
    }
    seen.add(item.criteriaIndex);
    if (typeof item.passed !== "boolean") {
      return fail("acceptance_invalid", `${field}.passed must be a boolean`);
    }
    const verdict: AcceptanceVerdict = { criteriaIndex: item.criteriaIndex, passed: item.passed };
    if (item.evidencePath !== undefined) {
      const evidencePath = pathText(item.evidencePath, `${field}.evidencePath`);
      if (!evidencePath.ok) return evidencePath;
      verdict.evidencePath = evidencePath.value;
    }
    verdicts.push(verdict);
  }
  return { ok: true, value: verdicts };
}

/**
 * Enforce the decision/verdicts cross-checks that keep an accepted record
 * meaningful:
 *   - accepted requires a non-empty verdict list, all `passed: true`
 *   - rejected requires a non-empty reason note
 *
 * `note` is taken raw so a blank note on a rejection is reported as the
 * specific `acceptance_missing_note` rather than a generic empty string.
 */
function checkDecisionConsistency(
  decision: AcceptanceDecision,
  verdicts: AcceptanceVerdict[],
  note: string | undefined,
): { ok: true } | { ok: false; code: AcceptanceValidationCode; message: string } {
  if (decision === "accepted") {
    if (verdicts.length === 0 || verdicts.some((verdict) => !verdict.passed)) {
      return fail(
        "acceptance_incomplete_verdicts",
        "an accepted record requires every criterion to be present and passed",
      );
    }
    return { ok: true };
  }
  // rejected
  if (note === undefined || note.trim().length === 0) {
    return fail("acceptance_missing_note", "a rejected record requires a non-empty note");
  }
  return { ok: true };
}

/**
 * A rejection note is read raw so the decision/verdict consistency check owns
 * the "blank reason" verdict; a present-but-unparsable note still fails loudly.
 */
function parseNote(
  raw: unknown,
  fallbackField: string,
): AcceptanceValidationResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string") return fail("acceptance_invalid", `${fallbackField} must be a string`);
  if (raw.trim().length === 0) return { ok: true, value: raw };
  if (raw.length > ACCEPTANCE_MAX_TEXT_LENGTH) {
    return fail("acceptance_text_too_long", `${fallbackField} exceeds its text bound`);
  }
  if ([...raw].some((ch) => ch.charCodeAt(0) < 0x20 && ch !== "\n" && ch !== "\r" && ch !== "\t")) {
    return fail("acceptance_invalid", `${fallbackField} contains a control character`);
  }
  return { ok: true, value: raw };
}

export function validateAcceptanceRecord(raw: unknown): AcceptanceValidationResult<AcceptanceRecord> {
  if (
    !isRecord(raw) ||
    !keysMatch(
      raw,
      ["schemaVersion", "acceptanceId", "spaceId", "source", "verdicts", "decision", "decidedBy", "decidedAt"],
      ["note"],
    )
  ) {
    return fail("acceptance_unknown_field", "acceptance has unexpected or missing fields");
  }
  if (raw.schemaVersion !== ACCEPTANCE_SCHEMA_VERSION) {
    return fail("acceptance_invalid", "acceptance.schemaVersion is not supported");
  }
  const acceptanceId = identifier(raw.acceptanceId, "acceptance.acceptanceId");
  if (!acceptanceId.ok) return acceptanceId;
  const spaceId = identifier(raw.spaceId, "acceptance.spaceId");
  if (!spaceId.ok) return spaceId;
  const source = validateSource(raw.source, "acceptance.source");
  if (!source.ok) return source;
  const verdicts = validateVerdicts(raw.verdicts);
  if (!verdicts.ok) return verdicts;
  const decision = enumValue(raw.decision, acceptanceDecisions, "acceptance.decision");
  if (!decision.ok) return decision;
  const decidedBy = identifier(raw.decidedBy, "acceptance.decidedBy");
  if (!decidedBy.ok) return decidedBy;
  const decidedAt = iso8601(raw.decidedAt, "acceptance.decidedAt");
  if (!decidedAt.ok) return decidedAt;

  const parsedNote = parseNote(raw.note, "acceptance.note");
  if (!parsedNote.ok) return parsedNote;
  const note = parsedNote.value;

  const consistency = checkDecisionConsistency(decision.value, verdicts.value, note);
  if (!consistency.ok) return fail(consistency.code, consistency.message);

  return {
    ok: true,
    value: {
      schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
      acceptanceId: acceptanceId.value,
      spaceId: spaceId.value,
      source: source.value,
      verdicts: verdicts.value,
      decision: decision.value,
      ...(note !== undefined ? { note } : {}),
      decidedBy: decidedBy.value,
      decidedAt: decidedAt.value,
    },
  };
}

export function validateAcceptanceCreateRequest(raw: unknown): AcceptanceValidationResult<AcceptanceCreateRequest> {
  if (
    !isRecord(raw) ||
    !keysMatch(raw, ["spaceId", "source", "verdicts", "decision"], ["note"])
  ) {
    return fail("acceptance_unknown_field", "create request has unexpected or missing fields");
  }
  const spaceId = identifier(raw.spaceId, "spaceId");
  if (!spaceId.ok) return spaceId;
  const source = validateSource(raw.source, "source");
  if (!source.ok) return source;
  const verdicts = validateVerdicts(raw.verdicts);
  if (!verdicts.ok) return verdicts;
  const decision = enumValue(raw.decision, acceptanceDecisions, "decision");
  if (!decision.ok) return decision;

  const parsedNote = parseNote(raw.note, "note");
  if (!parsedNote.ok) return parsedNote;
  const note = parsedNote.value;

  const consistency = checkDecisionConsistency(decision.value, verdicts.value, note);
  if (!consistency.ok) return fail(consistency.code, consistency.message);

  return {
    ok: true,
    value: {
      spaceId: spaceId.value,
      source: source.value,
      verdicts: verdicts.value,
      decision: decision.value,
      ...(note !== undefined ? { note } : {}),
    },
  };
}
