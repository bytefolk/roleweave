/**
 * The permission → package-artifact derivation, extracted from the hire
 * skeleton builder so `POST /hire` and `PATCH /positions/:id/profile` cannot
 * disagree about what a permission set means.
 *
 * One permission projection produces five observable artifacts:
 *   - `employee.json`  policy.filesystem.read / .write and policy.mcpTools
 *   - `permissions.json` the operator-facing rule set
 *   - `skills.json` / `mcp.json` the resolved capability manifests
 *   - the SKILL.md "已启用 Skill" / "已绑定 MCP" prose sections
 *
 * Before this module existed the derivation lived inline in
 * `buildPositionSkeletonFiles`, which made it reachable only from the hire
 * path. Keep it pure: no filesystem, no request state.
 */
import { hireMcpCatalog, hireSkillCatalog } from "@roleweave/shared";
import type { HirePermissions } from "@roleweave/shared";

/** package contract default when a position declares no permissions at all. */
export const DEFAULT_HIRE_PERMISSIONS: HirePermissions = { tools: ["Read", "Grep", "Glob"], rules: [] };

const WRITE_ACTIONS = ["create", "update", "delete"];

export interface CapabilityManifests {
  /** Resolved Skill definitions, in grant order. */
  skills: Array<(typeof hireSkillCatalog)[number] & { version?: string }>;
  /** Resolved MCP definitions paired with their granted tool subset. */
  servers: Array<{
    id: string;
    name: string;
    description: string;
    tools: string[];
  }>;
}

export interface PermissionDerivation {
  /**
   * Resources the package declares readable. Raw — the consumer de-duplicates
   * against its own baseline entry (`./knowledge/**`).
   */
  readableResources: string[];
  /** Resources the package declares writable. Raw; consumer de-duplicates. */
  writableResources: string[];
  /** `policy.mcpTools`: one entry per `server.tool`, all read-mode. */
  mcpTools: Array<{ name: string; requestedMode: "read" }>;
  /** `permissions.json` body (workbench-permissions.v1). */
  permissionsFile: Record<string, unknown>;
  /** `skills.json` body (workbench-skills.v1). */
  skillsFile: Record<string, unknown>;
  /** `mcp.json` body (workbench-mcp.v1). */
  mcpFile: Record<string, unknown>;
  /** SKILL.md "已启用 Skill" section body. */
  skillSection: string;
  /** SKILL.md "已绑定 MCP" section body. */
  mcpSection: string;
}

export function derivePermissionArtifacts(permissions: HirePermissions): PermissionDerivation {
  const skills = permissions.skills ?? [];
  const mcpServers = permissions.mcpServers ?? [];
  const readableResources = permissions.rules
    .filter((rule) => (rule.effect ?? "allow") === "allow" && rule.actions.includes("read"))
    .map((rule) => rule.resource)
    .filter((resource) => resource.length > 0);
  const writableResources = permissions.rules
    .filter((rule) => (rule.effect ?? "allow") === "allow" && rule.actions.some((action) => WRITE_ACTIONS.includes(action)))
    .map((rule) => rule.resource)
    .filter((resource) => resource.length > 0);
  const mcpTools = mcpServers.flatMap((server) =>
    server.tools.map((tool) => ({ name: `${server.id}.${tool}`, requestedMode: "read" as const })),
  );
  const skillDefinitions = skills
    .map((grant) => hireSkillCatalog.find((skill) => skill.id === grant.id))
    .filter((skill): skill is (typeof hireSkillCatalog)[number] => skill !== undefined);
  const mcpDefinitions = mcpServers
    .map((grant) => ({ grant, definition: hireMcpCatalog.find((server) => server.id === grant.id) }))
    .filter((item): item is { grant: (typeof mcpServers)[number]; definition: (typeof hireMcpCatalog)[number] } => item.definition !== undefined);
  const skillSection = skillDefinitions.length === 0
    ? "- 暂无附加 Skill"
    : skillDefinitions.map((skill) => `### ${skill.name}（${skill.id}）\n\n${skill.description}\n\n执行约束：${skill.instruction}`).join("\n\n");
  const mcpSection = mcpDefinitions.length === 0
    ? "- 暂无 MCP 连接器"
    : mcpDefinitions.map(({ grant, definition }) => `- ${definition.name}（${definition.id}）：${grant.tools.length > 0 ? grant.tools.join(", ") : "未开放工具"}`).join("\n");
  return {
    readableResources,
    writableResources,
    mcpTools,
    permissionsFile: {
      schemaVersion: "workbench-permissions.v1",
      model: "chmod-inspired",
      defaultEffect: "deny",
      tools: permissions.tools,
      rules: permissions.rules,
      skills,
      mcpServers,
    },
    skillsFile: {
      schemaVersion: "workbench-skills.v1",
      defaultEffect: "deny",
      skills: skillDefinitions.map((definition) => {
        const grant = skills.find((item) => item.id === definition.id)!;
        return { ...grant, name: definition.name, description: definition.description };
      }),
    },
    mcpFile: {
      schemaVersion: "workbench-mcp.v1",
      defaultEffect: "deny",
      servers: mcpDefinitions.map(({ grant, definition }) => ({ id: grant.id, name: definition.name, description: definition.description, tools: grant.tools })),
    },
    skillSection,
    mcpSection,
  };
}

/** Read back the permission projection an existing package declares.
 * A missing or malformed `permissions.json` is not an error: the package
 * simply declares nothing, which is the same default a hire would have used. */
export function permissionsFromPackage(
  permissionsFile: unknown,
  fallbackTools: string[],
): HirePermissions {
  if (typeof permissionsFile !== "object" || permissionsFile === null || Array.isArray(permissionsFile)) {
    return { ...DEFAULT_HIRE_PERMISSIONS, tools: fallbackTools };
  }
  const record = permissionsFile as Record<string, unknown>;
  if (record.schemaVersion !== "workbench-permissions.v1") {
    return { ...DEFAULT_HIRE_PERMISSIONS, tools: fallbackTools };
  }
  const tools = Array.isArray(record.tools) && record.tools.every((tool) => typeof tool === "string")
    ? (record.tools as string[])
    : fallbackTools;
  return {
    tools,
    rules: Array.isArray(record.rules) ? (record.rules as HirePermissions["rules"]) : [],
    ...(Array.isArray(record.skills) ? { skills: record.skills as HirePermissions["skills"] } : {}),
    ...(Array.isArray(record.mcpServers) ? { mcpServers: record.mcpServers as HirePermissions["mcpServers"] } : {}),
  };
}
