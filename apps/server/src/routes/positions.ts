import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OrgApiError, errorCodes, isQoderModelId, turnEngines } from "@roleweave/shared";
import type { TurnEngine } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { resolveServiceConnection } from "../services/connections.js";
import { buildContextSources } from "../context-sources.js";
import { readJsonBody, sendJson } from "../http.js";
import { readPositionAgentBinding, setPositionAgentEngine, setPositionModel } from "../agent-binding.js";
import { employeeModelConfig } from "../model-selection.js";

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
  const contextSources = await buildContextSources(ws.dir, role, { memConfigured: resolveServiceConnection(ctx, "mem") !== null });
  const capabilities = await readCapabilitySummary(role.package.localReference);
  // Reading a card never migrates a legacy employee. The binding is surfaced
  // only when it already exists; first-use migration remains transactional
  // with the actual turn so merely selecting someone cannot change them.
  const agentBinding = await readPositionAgentBinding(ws, role.id);
  sendJson(res, 200, {
    schemaVersion: "position-card.v1",
    ...(agentBinding ? { modelConfig: await employeeModelConfig(agentBinding.engine, agentBinding.model, ctx.config.bundledElectronEngine) } : {}),
    ...(agentBinding !== null ? { agentEngine: agentBinding.engine } : {}),
    ...(agentBinding?.locked === true ? { agentLocked: true } : {}),
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

export async function handlePositionModel(ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse, positionId: string): Promise<void> {
  const body = await readJsonBody<unknown>(req);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("model" in body) || typeof body.model !== "string") {
    throw new OrgApiError(errorCodes.turn_request_invalid, 400, "Expected one model selection");
  }
  if (!ctx.config.bundledElectronEngine) throw new OrgApiError(errorCodes.turn_request_invalid, 400, "This external Agent adapter does not support model selection");
  const ws = ctx.workspace.requireOpen();
  const release = ctx.runningTurns.reserveMutation(ws.dir, positionId);
  try {
    const existing = await readPositionAgentBinding(ws, positionId);
    if (!existing) throw new OrgApiError(errorCodes.turn_request_invalid, 400, "An Agent must be bound before choosing its model");
    const config = await employeeModelConfig(existing.engine, existing.model);
    if (!config.options.some((m) => m.id === body.model) && !(config.allowCustomModel && isQoderModelId(body.model))) {
      throw new OrgApiError(errorCodes.turn_request_invalid, 400, "Model is not in this Agent's catalog");
    }
    await setPositionModel(ws, positionId, body.model);
    sendJson(res, 200, await employeeModelConfig(existing.engine, body.model));
  } finally { release(); }
}

/** An imported employee has no runtime preference in its portable package.
 * The operator gets one explicit selection; it is locked immediately so one
 * employee remains on one runtime throughout its life. */
export async function handlePositionAgentEngine(ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse, positionId: string): Promise<void> {
  const body = await readJsonBody<unknown>(req);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("engine" in body) || typeof body.engine !== "string" || !turnEngines.includes(body.engine as TurnEngine)) {
    throw new OrgApiError(errorCodes.turn_request_invalid, 400, "Expected one supported Agent engine");
  }
  const ws = ctx.workspace.requireOpen();
  const release = ctx.runningTurns.reserveMutation(ws.dir, positionId);
  try {
    const engine = body.engine as TurnEngine;
    await setPositionAgentEngine(ws, positionId, engine);
    sendJson(res, 200, {
      agentEngine: engine,
      agentLocked: true,
      modelConfig: await employeeModelConfig(engine, undefined, ctx.config.bundledElectronEngine),
    });
  } finally { release(); }
}
