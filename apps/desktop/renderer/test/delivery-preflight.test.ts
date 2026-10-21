import { describe, expect, it } from "vitest";
import {
  evaluateDeliveryPreflightItem,
  type DeliveryMaterialCheck,
} from "../src/goals/delivery-preflight";

const material = (
  materialId: string,
  uri: string,
  version: string | undefined,
  modifiedAt: string | null,
): DeliveryMaterialCheck => ({
  materialId,
  ref: { uri, ...(version === undefined ? {} : { version }) },
  resolved: modifiedAt === null ? null : { modifiedAt },
});

describe("delivery preflight contract (#467)", () => {
  it("returns needs_more when the operator selected no materials", () => {
    expect(evaluateDeliveryPreflightItem({ criterionId: "criterion-1", materials: [] })).toEqual({
      criterionId: "criterion-1",
      status: "needs_more",
      reason: "no_materials",
      materialIds: [],
      overallPass: false,
    });
  });

  it("fails closed for missing versions and broken refs", () => {
    const missingVersion = evaluateDeliveryPreflightItem({
      criterionId: "criterion-1",
      materials: [material("asset-a", "owb-doc://owner/a.md", undefined, "2026-09-24T00:00:00.000Z")],
    });
    const broken = evaluateDeliveryPreflightItem({
      criterionId: "criterion-1",
      materials: [material("asset-a", "owb-doc://owner/a.md", "v1", null)],
    });

    expect(missingVersion).toMatchObject({ status: "undetermined", reason: "missing_version", overallPass: false });
    expect(broken).toMatchObject({ status: "undetermined", reason: "broken_ref", overallPass: false });
  });

  it("marks two selected versions of the same URI as undetermined", () => {
    const result = evaluateDeliveryPreflightItem({
      criterionId: "criterion-2",
      materials: [
        material("asset-v1", "owb-doc://owner/release.md", "v1", "v1"),
        material("asset-v2", "owb-doc://owner/release.md", "v2", "v2"),
      ],
    });

    expect(result).toMatchObject({
      criterionId: "criterion-2",
      status: "undetermined",
      reason: "version_conflict",
      materialIds: ["asset-v1", "asset-v2"],
      overallPass: false,
    });
  });

  it("marks a selected version that differs from the current mtime as undetermined", () => {
    const result = evaluateDeliveryPreflightItem({
      criterionId: "criterion-3",
      materials: [material("asset-a", "owb-doc://owner/a.md", "v1", "v2")],
    });

    expect(result).toMatchObject({ status: "undetermined", reason: "version_changed", overallPass: false });
  });

  it("keeps valid metadata undetermined without semantic authorization", () => {
    const result = evaluateDeliveryPreflightItem({
      criterionId: "criterion-4",
      materials: [material("asset-a", "owb-doc://owner/a.md", "v1", "v1")],
    });

    expect(result).toEqual({
      criterionId: "criterion-4",
      status: "undetermined",
      reason: "semantic_not_authorized",
      materialIds: ["asset-a"],
      overallPass: false,
    });
    expect(result.status).not.toBe("covered");
  });
});
