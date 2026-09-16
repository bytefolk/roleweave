/**
 * Employee profile update contract (`PATCH /positions/:id/profile`).
 *
 * Hiring is the only *creation* channel (#33). Nothing governed the record
 * afterwards: once `POST /hire` had staged a package, an operator who had
 * bound the wrong Skill set — or typo'd the display name — had no supported
 * way back. The only workarounds were deleting and re-hiring (which loses the
 * position id and every turn record keyed to it) or editing files on disk
 * behind the control plane's back (which leaves `.digital-employee/org.json`
 * stale until some unrelated mutation happens to re-apply).
 *
 * This surface is deliberately narrow. It edits the *record*, not the shape of
 * the organization: position id, reporting line and budget are untouched. The
 * id is a path and a foreign key for turns, sessions and groups, so renaming it
 * is a migration, not an edit. Reporting line and budget already have governed
 * channels (`POST /org/apply` move, `budget.json` allocation) whose invariants
 * this endpoint must not bypass.
 *
 * The permission vocabulary is the same `HirePermissions` projection `POST
 * /hire` accepts — one validator, one set of catalogs, so the two surfaces can
 * never drift apart.
 */
import type { HirePermissions } from "./hire.js";
import type { PositionMode } from "./org-tree.js";

/** Additive profile-update surface; the frozen v0 routes are untouched. */
export interface PositionProfilePatch {
  /** Employee display name (Workbench metadata, never the package id). */
  name?: string;
  /** `read_only` keeps the employee from acting; `approval_required` gates it. */
  mode?: PositionMode;
  /** Full replacement of the permission projection, not a merge. */
  permissions?: HirePermissions;
}

export interface PositionProfileSuccess {
  status: "updated";
  positionId: string;
  name: string;
  mode: PositionMode;
  version: { seq: number; updatedAt: string };
}

export interface PositionProfileFailure {
  status: "failed";
  code: string;
  message: string;
  retryable: boolean;
}

export type PositionProfileResult = PositionProfileSuccess | PositionProfileFailure;
