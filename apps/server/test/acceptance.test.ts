import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCEPTANCE_SCHEMA_VERSION,
  validateAcceptanceCreateRequest,
  validateAcceptanceRecord,
  type AcceptanceRecord,
} from "@roleweave/shared";

function baseRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    acceptanceId: "acc-1",
    spaceId: "space-billing",
    source: { positionId: "analyst" },
    criteriaCount: 2,
    verdicts: [
      { criteriaIndex: 0, passed: true },
      { criteriaIndex: 1, passed: true, evidencePath: "产出/增量更新.md" },
    ],
    decision: "accepted",
    decidedBy: "operator",
    decidedAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

test("accepts a well-formed accepted record", () => {
  const result = validateAcceptanceRecord(baseRecord());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const value: AcceptanceRecord = result.value;
  assert.equal(value.schemaVersion, ACCEPTANCE_SCHEMA_VERSION);
  assert.equal(value.decision, "accepted");
  assert.equal(value.verdicts.length, 2);
  assert.equal(value.verdicts[1]?.evidencePath, "产出/增量更新.md");
});

test("rejects an accepted decision when a criterion is not passed", () => {
  const result = validateAcceptanceRecord(
    baseRecord({ verdicts: [{ criteriaIndex: 0, passed: true }, { criteriaIndex: 1, passed: false }] }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "acceptance_incomplete_verdicts");
});

test("rejects an accepted decision with an empty verdict list", () => {
  const result = validateAcceptanceRecord(baseRecord({ verdicts: [] }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "acceptance_incomplete_verdicts");
});

test("rejects a rejected decision with an empty note", () => {
  const result = validateAcceptanceRecord(
    baseRecord({ decision: "rejected", note: "   ", verdicts: [{ criteriaIndex: 0, passed: false }] }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "acceptance_missing_note");
});

test("rejects a rejected decision with no note at all", () => {
  const result = validateAcceptanceRecord(
    baseRecord({ decision: "rejected", verdicts: [{ criteriaIndex: 0, passed: false }] }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "acceptance_missing_note");
});

test("keeps a rejected record that carries a reason note", () => {
  const result = validateAcceptanceRecord(
    baseRecord({ decision: "rejected", note: "criterion 1 has no reproducible evidence", verdicts: [{ criteriaIndex: 0, passed: false }] }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.decision, "rejected");
  assert.equal(result.value.note, "criterion 1 has no reproducible evidence");
});

test("rejects duplicate criteriaIndex values", () => {
  const result = validateAcceptanceRecord(
    baseRecord({ verdicts: [{ criteriaIndex: 0, passed: true }, { criteriaIndex: 0, passed: true }] }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "acceptance_duplicate_reference");
});

test("rejects a negative or non-integer criteriaIndex", () => {
  for (const criteriaIndex of [-1, 1.5]) {
    const result = validateAcceptanceRecord(
      baseRecord({ verdicts: [{ criteriaIndex, passed: true }] }),
    );
    assert.equal(result.ok, false, `criteriaIndex ${criteriaIndex} should be rejected`);
    if (result.ok) continue;
    assert.equal(result.code, "acceptance_invalid");
  }
});

test("rejects an unsupported schemaVersion", () => {
  const result = validateAcceptanceRecord(baseRecord({ schemaVersion: "acceptance.v2" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "acceptance_invalid");
});

test("rejects unknown top-level keys", () => {
  const result = validateAcceptanceRecord(baseRecord({ surprise: true }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "acceptance_unknown_field");
});

test("rejects a decision outside the allowlist", () => {
  const result = validateAcceptanceRecord(baseRecord({ decision: "maybe" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "acceptance_invalid_enum");
});

test("rejects a source with an unexpected field", () => {
  const result = validateAcceptanceRecord(
    baseRecord({ source: { positionId: "analyst", sneaky: "x" } }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "acceptance_unknown_field");
});

test("accepts a source carrying turnId and artifactPath", () => {
  const result = validateAcceptanceRecord(
    baseRecord({ source: { positionId: "analyst", turnId: "turn-9", artifactPath: "产出/增量更新.md" } }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.source.turnId, "turn-9");
  assert.equal(result.value.source.artifactPath, "产出/增量更新.md");
});

test("rejects a non-string note", () => {
  const result = validateAcceptanceRecord(
    baseRecord({
      decision: "rejected",
      note: 42,
      criteriaCount: 1,
    verdicts: [{ criteriaIndex: 0, passed: false }],
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "acceptance_invalid");
});

test("rejects a whitespace-bearing identifier", () => {
  const result = validateAcceptanceRecord(baseRecord({ spaceId: "space billing" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "acceptance_invalid");
});

test("rejects a missing required field", () => {
  const raw = baseRecord();
  delete raw.decidedBy;
  const result = validateAcceptanceRecord(raw);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "acceptance_unknown_field");
});

test("create request mirrors the same decision/verdict consistency", () => {
  const rejected = validateAcceptanceCreateRequest({
    spaceId: "space-billing",
    source: { positionId: "analyst" },
    criteriaCount: 1,
    verdicts: [{ criteriaIndex: 0, passed: false }],
    decision: "accepted",
  });
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.equal(rejected.code, "acceptance_incomplete_verdicts");

  const accepted = validateAcceptanceCreateRequest({
    spaceId: "space-billing",
    source: { positionId: "analyst" },
    criteriaCount: 1,
    verdicts: [{ criteriaIndex: 0, passed: true }],
    decision: "accepted",
  });
  assert.equal(accepted.ok, true);
});


test("accepted records cover exactly the declared criterion set", () => {
  for (const verdicts of [[{criteriaIndex: 5, passed: true}], [{criteriaIndex: 0, passed: true}], [{criteriaIndex: 0, passed: true}, {criteriaIndex: 2, passed: true}]]) {
    const result = validateAcceptanceRecord(baseRecord({verdicts}));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "acceptance_incomplete_verdicts");
  }
  assert.equal(validateAcceptanceRecord(baseRecord({verdicts: [{criteriaIndex: 1, passed: true}, {criteriaIndex: 0, passed: true}]})).ok, true);
});

test("criteria count is required and bounded, and empty plans cannot be accepted", () => {
  const raw = baseRecord(); delete raw.criteriaCount;
  assert.equal(validateAcceptanceRecord(raw).ok, false);
  for (const criteriaCount of [-1, 1.5, 65, "2", 0]) assert.equal(validateAcceptanceRecord(baseRecord({criteriaCount})).ok, false);
  const verdicts = Array.from({length: 64}, (_, criteriaIndex) => ({criteriaIndex, passed: true}));
  assert.equal(validateAcceptanceRecord(baseRecord({criteriaCount: 64, verdicts})).ok, true);
  assert.equal(validateAcceptanceRecord(baseRecord({criteriaCount: 64, verdicts: [...verdicts, {criteriaIndex: 64, passed: true}]})).ok, false);
  assert.equal(validateAcceptanceRecord(baseRecord({criteriaCount: 0, verdicts: [], decision: "rejected", note: "missing plan"})).ok, true);
});

test("all identifier fields enforce the exported 128-character bound", () => {
  for (const field of ["acceptanceId", "spaceId", "decidedBy"]) {
    assert.equal(validateAcceptanceRecord(baseRecord({[field]: "a".repeat(128)})).ok, true);
    assert.equal(validateAcceptanceRecord(baseRecord({[field]: "a".repeat(129)})).ok, false);
  }
  for (const field of ["positionId", "turnId"]) {
    assert.equal(validateAcceptanceRecord(baseRecord({source: {positionId: "p", [field]: "a".repeat(128)}})).ok, true);
    assert.equal(validateAcceptanceRecord(baseRecord({source: {positionId: "p", [field]: "a".repeat(129)}})).ok, false);
  }
});

test("decidedAt requires a real UTC instant rather than Date.parse shorthand", () => {
  for (const decidedAt of ["1", "2026", "2026-10-01", "Fri Oct 02 2026", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-01T24:00:00Z"])
    assert.equal(validateAcceptanceRecord(baseRecord({decidedAt})).ok, false, decidedAt);
  for (const decidedAt of ["2026-10-01T12:00:00Z", "2026-10-01T12:00:00.1Z", "2026-10-01T12:00:00.123Z"])
    assert.equal(validateAcceptanceRecord(baseRecord({decidedAt})).ok, true, decidedAt);
});

test("unsafe controls and bidi characters cannot enter ids, notes or paths", () => {
  for (const control of ["\u0001", "\u007f", "\u0085", "\u009f", "\u200b", "\u202e", "\u2066"]) {
    for (const override of [{spaceId: `a${control}b`}, {note: `a${control}b`}, {source: {positionId: "p", artifactPath: `a${control}b`}}])
      assert.equal(validateAcceptanceRecord(baseRecord(override)).ok, false);
  }
  assert.equal(validateAcceptanceRecord(baseRecord({note: "line one\nline two\tend"})).ok, true);
});

test("artifact pointers are relative and bounded and notes respect their limit", () => {
  for (const artifactPath of ["../secret", "/absolute", "a/../b", "C:/absolute", "a\\b", "a//b", "a".repeat(1025)])
    assert.equal(validateAcceptanceRecord(baseRecord({source: {positionId: "p", artifactPath}})).ok, false, artifactPath);
  assert.equal(validateAcceptanceRecord(baseRecord({source: {positionId: "p", artifactPath: "a".repeat(1024)}})).ok, true);
  assert.equal(validateAcceptanceRecord(baseRecord({note: "a".repeat(4096)})).ok, true);
  assert.equal(validateAcceptanceRecord(baseRecord({note: "a".repeat(4097)})).ok, false);
  assert.equal(validateAcceptanceRecord(baseRecord({note: " ".repeat(4097)})).ok, false);
});

test("create requests also refuse omitted, partial and out-of-range criterion coverage", () => {
  const {schemaVersion, acceptanceId, decidedBy, decidedAt, ...request} = baseRecord();
  assert.equal(validateAcceptanceCreateRequest(request).ok, true);
  for (const overrides of [{criteriaCount: undefined}, {verdicts: [{criteriaIndex: 0, passed: true}]}, {verdicts: [{criteriaIndex: 2, passed: true}]}])
    assert.equal(validateAcceptanceCreateRequest({...request, ...overrides}).ok, false);
});
