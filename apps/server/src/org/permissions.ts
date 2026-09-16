/**
 * The one Workbench permission validator.
 *
 * `POST /hire` and `PATCH /positions/:id/profile` accept the same
 * `HirePermissions` projection, so they must reject the same inputs with the
 * same reasons — otherwise an operator could hire an employee with a grant the
 * edit surface refuses to save, and the record would be permanently
 * un-editable. The validator is therefore extracted here and parameterized only
 * by the error code of the calling surface.
 */
import { OrgApiError } from "@roleweave/shared";
import { hireMcpCatalog, hireSkillCatalog } from "@roleweave/shared";
import type { HireMcpGrant, HirePermissions, HireSkillGrant } from "@roleweave/shared";

const PERMISSION_ACTIONS = new Set(["read", "create", "update", "delete", "execute"]);
const PERMISSION_SCOPES = new Set(["position", "workspace", "project"]);
const SKILL_DEFINITIONS = new Map<string, (typeof hireSkillCatalog)[number]>(hireSkillCatalog.map((skill) => [skill.id, skill]));
const MCP_DEFINITIONS = new Map<string, (typeof hireMcpCatalog)[number]>(hireMcpCatalog.map((server) => [server.id, server]));

/** Builds the caller's error type; the message is the only thing that varies. */
export type PermissionErrorFactory = (message: string) => OrgApiError;

export function validatePermissions(value: unknown, invalid: PermissionErrorFactory): HirePermissions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("permissions must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.tools) || raw.tools.length > 32 || !raw.tools.every((tool) => typeof tool === "string" && tool.length > 0 && tool.length <= 64)) {
    throw invalid("permissions.tools must be a bounded string array");
  }
  if (!Array.isArray(raw.rules) || raw.rules.length > 64) throw invalid("permissions.rules must be a bounded array");
  const rules = raw.rules.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw invalid(`permissions.rules[${index}] must be an object`);
    const rule = entry as Record<string, unknown>;
    if (!PERMISSION_SCOPES.has(String(rule.scope))) throw invalid(`permissions.rules[${index}].scope is invalid`);
    if (typeof rule.resource !== "string" || rule.resource.trim().length === 0 || rule.resource.length > 512) throw invalid(`permissions.rules[${index}].resource is invalid`);
    const resource = rule.resource.trim();
    if (resource.startsWith("skill://") && !SKILL_DEFINITIONS.has(resource.slice("skill://".length))) throw invalid(`permissions.rules[${index}].resource references an unregistered Skill`);
    if (resource.startsWith("mcp://") && !MCP_DEFINITIONS.has(resource.slice("mcp://".length))) throw invalid(`permissions.rules[${index}].resource references an unregistered MCP server`);
    if (!Array.isArray(rule.actions) || rule.actions.length === 0 || rule.actions.length > 5 || !rule.actions.every((action) => typeof action === "string" && PERMISSION_ACTIONS.has(action))) throw invalid(`permissions.rules[${index}].actions are invalid`);
    if (rule.effect !== undefined && rule.effect !== "allow" && rule.effect !== "deny") throw invalid(`permissions.rules[${index}].effect is invalid`);
    if (rule.approval !== undefined && typeof rule.approval !== "boolean") throw invalid(`permissions.rules[${index}].approval is invalid`);
    return {
      scope: rule.scope as HirePermissions["rules"][number]["scope"],
      resource,
      actions: [...new Set(rule.actions as HirePermissions["rules"][number]["actions"])],
      ...(rule.effect !== undefined ? { effect: rule.effect as "allow" | "deny" } : {}),
      ...(rule.approval !== undefined ? { approval: rule.approval } : {}),
    };
  });
  const skills: HireSkillGrant[] = raw.skills === undefined ? [] : (() => {
    if (!Array.isArray(raw.skills) || raw.skills.length > 32) throw invalid("permissions.skills must be a bounded array");
    const seen = new Set<string>();
    return raw.skills.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw invalid(`permissions.skills[${index}] must be an object`);
      const item = entry as Record<string, unknown>;
      if (typeof item.id !== "string" || !SKILL_DEFINITIONS.has(item.id)) throw invalid(`permissions.skills[${index}].id is not a registered Skill`);
      if (seen.has(item.id)) throw invalid(`permissions.skills[${index}].id is duplicated`);
      seen.add(item.id);
      if (item.version !== undefined && (typeof item.version !== "string" || item.version.trim().length === 0 || item.version.length > 64)) throw invalid(`permissions.skills[${index}].version is invalid`);
      return { id: item.id as HireSkillGrant["id"], ...(item.version !== undefined ? { version: item.version.trim() } : {}) };
    });
  })();
  const mcpServers: HireMcpGrant[] = raw.mcpServers === undefined ? [] : (() => {
    if (!Array.isArray(raw.mcpServers) || raw.mcpServers.length > 16) throw invalid("permissions.mcpServers must be a bounded array");
    const seen = new Set<string>();
    return raw.mcpServers.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw invalid(`permissions.mcpServers[${index}] must be an object`);
      const item = entry as Record<string, unknown>;
      const definition = typeof item.id === "string" ? MCP_DEFINITIONS.get(item.id) : undefined;
      if (!definition) throw invalid(`permissions.mcpServers[${index}].id is not a registered MCP server`);
      if (seen.has(definition.id)) throw invalid(`permissions.mcpServers[${index}].id is duplicated`);
      seen.add(definition.id);
      if (!Array.isArray(item.tools) || item.tools.length > definition.tools.length || !item.tools.every((tool) => typeof tool === "string" && (definition.tools as readonly string[]).includes(tool))) {
        throw invalid(`permissions.mcpServers[${index}].tools must use the registered tool list`);
      }
      const tools = [...new Set(item.tools as string[])];
      if (tools.length !== item.tools.length) throw invalid(`permissions.mcpServers[${index}].tools contains duplicates`);
      return { id: definition.id as HireMcpGrant["id"], tools };
    });
  })();
  return { tools: [...(raw.tools as string[])], rules, skills, mcpServers };
}
