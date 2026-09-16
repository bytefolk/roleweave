/** Org-workbench UI types. Field semantics mirror digital-employee contracts
 * (org-tree.v1 frozen minimal shape; workspace-org.v1 roles via /positions/:id);
 * the client never invents semantics. */

import type { ContextSourceSummary, HirePermissions } from "@roleweave/shared";

export type { OrgRole, OrgTreeSnapshot, OrgTreeNodeV1 } from "@roleweave/shared";

export interface BudgetCaps {
  tokens?: number;
  iterations?: number;
}

/** Shape of GET /positions/:id → position-card.v1.position. */
export interface PositionCardData {
  id: string;
  name: string;
  description: string;
  reportTo: string | null;
  mode: "read_only" | "approval_required";
  contextScope: string;
  /** Additive source inventory; older callers may omit it during migration. */
  contextSources?: ContextSourceSummary[];
  permissions: { toolAllow: string[]; toolDeny: string[] };
  /** Additive (#292): the full projection PATCH /positions/:id/profile takes.
   * `permissions` above stays the compact badge summary the card renders. */
  permissionPolicy?: HirePermissions;
  capabilities?: {
    skills: Array<{ id: string; name: string }>;
    mcpServers: Array<{ id: string; name: string; tools: string[] }>;
  };
  budget: { perTask: BudgetCaps; perDay: BudgetCaps } | null;
  metadata: Record<string, string>;
}

/**
 * Presentation-only localized copy carried in workspace-org.v1 metadata.
 * Metadata is deliberately used here because it is the schema's additive
 * extension point: older digital-employee engines retain it without needing
 * to understand a new role field. The canonical name and description remain
 * the safe fallback (and the values used by the execution engine).
 */
export function localizePositionCard(
  position: PositionCardData,
  locale: "zh-CN" | "en",
): PositionCardData {
  const localized = (field: "name" | "description", fallback: string) => {
    const value = position.metadata[`roleweave.i18n.${locale}.${field}`];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
  };
  return {
    ...position,
    name: localized("name", position.name),
    description: localized("description", position.description),
  };
}

export function primaryCap(caps: BudgetCaps | null | undefined): number | null {
  if (!caps) return null;
  return caps.tokens ?? caps.iterations ?? null;
}

export function capsText(caps: BudgetCaps | null | undefined): string {
  const tokens = caps?.tokens;
  const iterations = caps?.iterations;
  if (tokens !== undefined && iterations !== undefined) return `${tokens.toLocaleString()} tokens · ${iterations} iterations`;
  if (tokens !== undefined) return `${tokens.toLocaleString()} tokens`;
  if (iterations !== undefined) return `${iterations.toLocaleString()} iterations`;
  return "—";
}
