import { describe, expect, it } from "vitest";
import type { SpaceDocCriterion } from "@roleweave/shared";
import {
  buildAcceptanceRecord,
  buildVerdicts,
  canAccept,
  canReject,
  untickedCriteria,
  type GateDraft,
} from "../src/space/acceptance-gate-model.js";

const criteria: SpaceDocCriterion[] = [
  { criteriaIndex: 0, text: "差异可归因", done: false, marker: " " },
  { criteriaIndex: 1, text: "口径已评审", done: false, marker: " " },
  { criteriaIndex: 2, text: "回滚有演练", done: false, marker: " " },
];

const draft: GateDraft = {
  spaceId: "space-billing",
  positionId: "analyst",
  decidedBy: "operator",
};

const fixedNow = () => new Date("2026-10-01T12:00:00.000Z");

describe("gate readiness", () => {
  it("blocks accept until every criterion is ticked", () => {
    expect(canAccept(criteria, {})).toBe(false);
    expect(canAccept(criteria, { 0: true, 1: true })).toBe(false);
    expect(canAccept(criteria, { 0: true, 1: true, 2: true })).toBe(true);
  });

  it("never accepts an empty criteria list", () => {
    expect(canAccept([], {})).toBe(false);
  });

  it("lists exactly the unticked indices", () => {
    expect(untickedCriteria(criteria, { 1: true })).toEqual([0, 2]);
    expect(untickedCriteria(criteria, { 0: true, 1: true, 2: true })).toEqual([]);
  });

  it("requires a non-blank reason to reject", () => {
    expect(canReject("")).toBe(false);
    expect(canReject("   ")).toBe(false);
    expect(canReject("no evidence")).toBe(true);
  });
});

describe("verdict construction", () => {
  it("emits one verdict per criterion, in order", () => {
    const verdicts = buildVerdicts(criteria, { 0: true, 2: true });
    expect(verdicts).toEqual([
      { criteriaIndex: 0, passed: true },
      { criteriaIndex: 1, passed: false },
      { criteriaIndex: 2, passed: true },
    ]);
  });

  it("attaches evidence only when a path is non-blank", () => {
    const verdicts = buildVerdicts(criteria, { 0: true }, { 0: "产出/a.md", 1: "   " });
    expect(verdicts[0].evidencePath).toBe("产出/a.md");
    expect(verdicts[1].evidencePath).toBeUndefined();
  });
});

describe("record construction", () => {
  it("builds an accepted record that satisfies acceptance.v1", () => {
    const record = buildAcceptanceRecord(
      draft,
      criteria,
      { 0: true, 1: true, 2: true },
      "accepted",
      "",
      {},
      fixedNow,
    );
    expect(record.schemaVersion).toBe("acceptance.v1");
    expect(record.decision).toBe("accepted");
    expect(record.verdicts).toHaveLength(3);
    expect(record.verdicts.every((verdict) => verdict.passed)).toBe(true);
    expect(record.note).toBeUndefined();
    expect(record.decidedAt).toBe("2026-10-01T12:00:00.000Z");
  });

  it("refuses to build an accepted record with a gap", () => {
    expect(() =>
      buildAcceptanceRecord(draft, criteria, { 0: true }, "accepted", "", {}, fixedNow),
    ).toThrow(/unticked/);
  });

  it("refuses to build a rejected record with no reason", () => {
    expect(() =>
      buildAcceptanceRecord(draft, criteria, {}, "rejected", "  ", {}, fixedNow),
    ).toThrow(/note/);
  });

  it("keeps the rejection reason, trimmed", () => {
    const record = buildAcceptanceRecord(draft, criteria, {}, "rejected", "  needs evidence  ", {}, fixedNow);
    expect(record.decision).toBe("rejected");
    expect(record.note).toBe("needs evidence");
  });

  it("carries turn and artifact provenance when provided", () => {
    const record = buildAcceptanceRecord(
      { ...draft, turnId: "turn-9", artifactPath: "目标.md" },
      criteria,
      { 0: true, 1: true, 2: true },
      "accepted",
      "",
      {},
      fixedNow,
    );
    expect(record.source.turnId).toBe("turn-9");
    expect(record.source.artifactPath).toBe("目标.md");
  });
});
