/**
 * Hire channel contract (#33, consuming digital-employee #194/#198).
 *
 * Creating an employee flows exclusively through the hire-request.v1alpha1
 * thin reference envelope validated by `digital-employee hire validate`
 * (static, fail-closed). The change-manifest `add` op was removed in the
 * same revision: POST /org/apply no longer accepts employee creation, so no
 * direct-write bypass of the hire governance gate exists (AC-001).
 *
 * Field-level alignment with configs/hire-request.schema.json at b3d54bf:
 * the control plane owns targetParentId resolution against the org tree and
 * identity display fields; the envelope vocabulary itself is never extended.
 */

import type { PositionBudget, PositionMode } from "./org-tree.js";
import type { HireMcpGrant, HireSkillGrant } from "./capabilities.js";

export const HIRE_REQUEST_SCHEMA_VERSION = "hire-request.v1alpha1" as const;

/** Workbench-side permission projection. The package contract still receives
 * the normal employee policy; this additive declaration keeps the richer
 * chmod-inspired resource rules available to the Workbench and to generated
 * packages without pretending that a Unix mode is enough for workspace paths. */
export const hirePermissionActions = ["read", "create", "update", "delete", "execute"] as const;
export type HirePermissionAction = (typeof hirePermissionActions)[number];
export const hirePermissionScopes = ["position", "workspace", "project"] as const;
export type HirePermissionScope = (typeof hirePermissionScopes)[number];

export interface HirePermissionRule {
  scope: HirePermissionScope;
  resource: string;
  actions: HirePermissionAction[];
  effect?: "allow" | "deny";
  approval?: boolean;
}

export interface HirePermissions {
  /** Agent/tool capabilities shown in the position card (Read/Grep/Glob...). */
  tools: string[];
  /** Explicit resource rules. Default policy is deny; rules are additive. */
  rules: HirePermissionRule[];
  /** Additional, platform-registered Skill packages. Binding is not access. */
  skills?: HireSkillGrant[];
  /** Platform-registered MCP servers with an explicit tool-level allowlist. */
  mcpServers?: HireMcpGrant[];
}

export interface HireMemorySource {
  kind: "position_docs" | "workspace_docs" | "mem_drive" | "runtime_context";
  locator: string;
}

/** Shape POST /hire accepts from the renderer. The upstream envelope remains
 * frozen; Workbench metadata is additive and is consumed while building the
 * employee package. */
export interface HirePositionRequest {
  positionId: string;
  name: string;
  description: string;
  /** Parent position id; null hires directly under the company root. */
  reportTo: string | null;
  mode: PositionMode;
  /** REQ-006 parity: a hire without budget is rejected at every gate. */
  budget: PositionBudget;
  /** Optional Workbench policy extension; the frozen hire envelope remains unchanged. */
  permissions?: HirePermissions;
  /** User-editable semantic role prompt, written into the generated SKILL.md. */
  prompt?: string;
  /** Memory bindings are separate from operation permissions. */
  memorySources?: HireMemorySource[];
  /** Optional ISO 8601 passthrough onto the envelope deadline (upstream-optional). */
  deadline?: string;
}

export interface HirePackageReference {
  name: string;
  /** Package format selector; matches upstream `^v1alpha1(\.[0-9]+)?$`. */
  version: string;
  /** Sealed reference digest (upstream minLength 16). */
  digest: string;
}

/** Exact mirror of hire-request.v1alpha1 (configs/hire-request.schema.json). */
export interface HireRequestEnvelope {
  schemaVersion: typeof HIRE_REQUEST_SCHEMA_VERSION;
  workspaceRef: string;
  packageRef: HirePackageReference;
  targetParentId: string;
  budget: PositionBudget;
  requestedBy: string;
  /** Upstream-optional; when present must parse as an ISO 8601 timestamp. */
  deadline?: string;
  envelopeDigest: string;
}

export interface HireSuccess {
  status: "hired";
  positionId: string;
  version: { seq: number; updatedAt: string };
}

export interface HireFailure {
  status: "failed";
  code: string;
  message: string;
  retryable: boolean;
}

export type HireResult = HireSuccess | HireFailure;

/**
 * Driver seam for `digital-employee hire validate <file> --json` (#198).
 * Upstream is static and fail-closed: exit 0 with {status:"valid"}, or
 * exit 1 with {status:"failed", code:"hire_request_*"} before any effect.
 */
export interface HireValidateDriver {
  hireValidate(
    file: string,
  ): Promise<
    | { status: "valid" }
    | { status: "failed"; code: string; message: string }
    | { status: "engine_unavailable"; message: string }
    | { status: "engine_capability_missing"; message: string }
  >;
}
