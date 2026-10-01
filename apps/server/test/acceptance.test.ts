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
    verdicts: [{ criteriaIndex: 0, passed: false }],
    decision: "accepted",
  });
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.equal(rejected.code, "acceptance_incomplete_verdicts");

  const accepted = validateAcceptanceCreateRequest({
    spaceId: "space-billing",
    source: { positionId: "analyst" },
    verdicts: [{ criteriaIndex: 0, passed: true }],
    decision: "accepted",
  });
  assert.equal(accepted.ok, true);
});
