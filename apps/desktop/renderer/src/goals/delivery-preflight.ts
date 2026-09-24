import { parseDocRef, type DocRef } from "@roleweave/shared/docs";

export type DeliveryPreflightStatus = "covered" | "needs_more" | "undetermined";
export type DeliveryPreflightReason =
  | "no_materials"
  | "missing_version"
  | "broken_ref"
  | "version_conflict"
  | "version_changed"
  | "semantic_not_authorized";

export interface DeliveryMaterialCheck {
  materialId: string;
  ref: DocRef;
  resolved: { modifiedAt: string } | null;
}

export interface DeliveryPreflightItem {
  criterionId: string;
  status: DeliveryPreflightStatus;
  reason: DeliveryPreflightReason;
  materialIds: string[];
  overallPass: false;
}

export function evaluateDeliveryPreflightItem(input: {
  criterionId: string;
  materials: DeliveryMaterialCheck[];
}): DeliveryPreflightItem {
  const materialIds = input.materials.map((material) => material.materialId);
  if (input.materials.length === 0) {
    return {
      criterionId: input.criterionId,
      status: "needs_more",
      reason: "no_materials",
      materialIds,
      overallPass: false,
    };
  }
  if (input.materials.some((material) => !parseDocRef(material.ref).ok)) {
    return {
      criterionId: input.criterionId,
      status: "undetermined",
      reason: "broken_ref",
      materialIds,
      overallPass: false,
    };
  }
  if (input.materials.some((material) => !material.ref.version)) {
    return {
      criterionId: input.criterionId,
      status: "undetermined",
      reason: "missing_version",
      materialIds,
      overallPass: false,
    };
  }
  const versionsByUri = new Map<string, Set<string>>();
  for (const material of input.materials) {
    const versions = versionsByUri.get(material.ref.uri) ?? new Set<string>();
    versions.add(material.ref.version!);
    versionsByUri.set(material.ref.uri, versions);
  }
  if ([...versionsByUri.values()].some((versions) => versions.size > 1)) {
    return {
      criterionId: input.criterionId,
      status: "undetermined",
      reason: "version_conflict",
      materialIds,
      overallPass: false,
    };
  }
  if (input.materials.some((material) => material.resolved === null)) {
    return {
      criterionId: input.criterionId,
      status: "undetermined",
      reason: "broken_ref",
      materialIds,
      overallPass: false,
    };
  }
  if (input.materials.some((material) => material.ref.version !== material.resolved!.modifiedAt)) {
    return {
      criterionId: input.criterionId,
      status: "undetermined",
      reason: "version_changed",
      materialIds,
      overallPass: false,
    };
  }
  return {
    criterionId: input.criterionId,
    status: "undetermined",
    reason: "semantic_not_authorized",
    materialIds,
    overallPass: false,
  };
}
