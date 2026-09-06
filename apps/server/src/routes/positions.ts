import fs from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { buildContextSources } from "../context-sources.js";
import { sendJson } from "../http.js";

async function readCapabilitySummary(packageDir: string): Promise<{
  skills: Array<{ id: string; name: string }>;
  mcpServers: Array<{ id: string; name: string; tools: string[] }>;
}> {
  try {
    const [skills, mcpServers] = await Promise.all([
      fs.readFile(path.join(packageDir, "skills.json"), "utf8").then((value) => JSON.parse(value) as { skills?: Array<{ id?: unknown; name?: unknown }> }),
      fs.readFile(path.join(packageDir, "mcp.json"), "utf8").then((value) => JSON.parse(value) as { servers?: Array<{ id?: unknown; name?: unknown; tools?: unknown }> }),
    ]);
    return {
      skills: (skills.skills ?? []).filter((skill) => typeof skill.id === "string" && typeof skill.name === "string").map((skill) => ({ id: skill.id as string, name: skill.name as string })),
      mcpServers: (mcpServers.servers ?? []).filter((server) => typeof server.id === "string" && typeof server.name === "string" && Array.isArray(server.tools)).map((server) => ({ id: server.id as string, name: server.name as string, tools: (server.tools as unknown[]).filter((tool): tool is string => typeof tool === "string") })),
    };
  } catch {
    return { skills: [], mcpServers: [] };
  }
}

export async function handlePositionGet(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  positionId: string,
): Promise<void> {
  const ws = ctx.workspace.requireOpen();
  const role = ws.organization.roles.find((entry) => entry.id === positionId);
  if (!role) {
    throw new OrgApiError(errorCodes.position_missing, 404, `position not found: ${positionId}`);
  }
  const contextSources = await buildContextSources(ws.dir, role);
  const capabilities = await readCapabilitySummary(role.package.localReference);
  sendJson(res, 200, {
    schemaVersion: "position-card.v1",
    position: {
      id: role.id,
      name: role.name,
      description: role.description,
      reportTo: role.reportTo,
      mode: role.mode,
      /** Legacy scope field retained for wire compatibility. Sources are the
       * user-facing representation and are derived from the real planes. */
      contextScope: role.memoryScope,
      contextSources,
      permissions: { toolAllow: role.toolAllow, toolDeny: role.toolDeny },
      capabilities,
      budget: role.budget ?? null,
      metadata: role.metadata,
    },
  });
}
