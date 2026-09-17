import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OrgApiError, errorCodes, isEngineModelId, turnEngines } from "@roleweave/shared";
import type { HirePermissions, PositionProfileFailure, TurnEngine } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { resolveServiceConnection } from "../services/connections.js";
import { buildContextSources } from "../context-sources.js";
import { readJsonBody, sendJson } from "../http.js";
import { readPositionAgentBinding, setPositionAgentEngine, setPositionModel } from "../agent-binding.js";
import { employeeModelConfig } from "../model-selection.js";
import { withOrgMutationLock } from "../org/apply.js";
import { permissionsFromPackage } from "../org/permission-artifacts.js";
import { applyPositionProfile, assertProfilePatch } from "../org/profile-edit.js";

function failure(code: string, message: string, retryable: boolean): PositionProfileFailure {
  return { status: "failed", code, message, retryable };
}

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

/**
 * The editable permission projection, not the `toolAllow/toolDeny` summary.
 * The profile editor must prefill every rule and grant it is about to replace;
 * a summary prefilled into a full-replacement patch would silently delete the
 * whole resource rule set on the first save.
 */
async function readPermissionPolicy(packageDir: string, fallbackTools: string[]): Promise<HirePermissions> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(packageDir, "permissions.json"), "utf8")) as unknown;
    return permissionsFromPackage(raw, fallbackTools);
  } catch {
    return permissionsFromPackage(null, fallbackTools);
  }
}

export async function handlePositionGet(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  positionId: string,
  requestedEngine?: TurnEngine,
): Promise<void> {
  const ws = ctx.workspace.requireOpen();
  const role = ws.organization.roles.find((entry) => entry.id === positionId);
  if (!role) {
    throw new OrgApiError(errorCodes.position_missing, 404, `position not found: ${positionId}`);
  }
  const contextSources = await buildContextSources(ws.dir, role, { memConfigured: resolveServiceConnection(ctx, "mem") !== null });
  const capabilities = await readCapabilitySummary(role.package.localReference);
  const permissionPolicy = await readPermissionPolicy(role.package.localReference, role.toolAllow);
  // Reading a card never migrates a legacy employee. The binding is surfaced
  // only when it already exists; first-use migration remains transactional
  // with the actual turn so merely selecting someone cannot change them.
  const agentBinding = await readPositionAgentBinding(ws, role.id);
  if (requestedEngine !== undefined && !turnEngines.includes(requestedEngine)) {
    throw new OrgApiError(errorCodes.turn_request_invalid, 400, "Unsupported Agent engine");
  }
  const modelEngine = agentBinding?.engine ?? requestedEngine;
  sendJson(res, 200, {
    schemaVersion: "position-card.v1",
    ...(modelEngine ? { modelConfig: await employeeModelConfig(modelEngine, agentBinding?.model, ctx.config.bundledElectronEngine) } : {}),
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
      /** Additive (#291): the full projection PATCH /positions/:id/profile
       * accepts, so the editor round-trips instead of reconstructing. */
      permissionPolicy,
      capabilities,
      budget: role.budget ?? null,
      metadata: role.metadata,
    },
  });
}

export async function handlePositionModel(ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse, positionId: string): Promise<void> {
  const body = await readJsonBody<unknown>(req);
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      (Object.keys(body).length !== 1 && Object.keys(body).length !== 2) ||
      !Object.keys(body).every((key) => key === "model" || key === "engine") ||
      !("model" in body) || typeof body.model !== "string" ||
      ("engine" in body && (typeof body.engine !== "string" || !turnEngines.includes(body.engine as TurnEngine)))) {
    throw new OrgApiError(errorCodes.turn_request_invalid, 400, "Expected one model selection");
  }
  if (!ctx.config.bundledElectronEngine) throw new OrgApiError(errorCodes.turn_request_invalid, 400, "This external Agent adapter does not support model selection");
  const ws = ctx.workspace.requireOpen();
  const release = ctx.runningTurns.reserveMutation(ws.dir, positionId);
  try {
    const existing = await readPositionAgentBinding(ws, positionId);
    const requestedEngine = "engine" in body ? body.engine as TurnEngine : undefined;
    if (existing && requestedEngine !== undefined && requestedEngine !== existing.engine) {
      throw new OrgApiError(errorCodes.turn_request_invalid, 400, "Model selection engine does not match this Agent");
    }
    const engine = existing?.engine ?? requestedEngine;
    if (!engine) throw new OrgApiError(errorCodes.turn_request_invalid, 400, "An Agent engine is required before choosing its model");
    const config = await employeeModelConfig(engine, existing?.model, true, process.env, "cached");
    if (!config.options.some((m) => m.id === body.model) && !(config.allowCustomModel && isEngineModelId(body.model, engine))) {
      throw new OrgApiError(errorCodes.turn_request_invalid, 400, "Model is not in this Agent's catalog");
    }
    await setPositionModel(ws, positionId, body.model, existing ? undefined : requestedEngine);
    sendJson(res, 200, await employeeModelConfig(engine, body.model, true, process.env, "cached"));
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
      modelConfig: await employeeModelConfig(engine, undefined, ctx.config.bundledElectronEngine, process.env, "cached"),
    });
  } finally { release(); }
}

/**
 * PATCH /positions/:id/profile — edit an existing employee's display name,
 * approval mode and permission projection.
 *
 * The record an operator can create but never correct is a trap: a mis-bound
 * Skill set used to be unfixable without deleting the position, which also
 * discards every turn, session and group reference keyed to its id. This
 * surface is deliberately narrow — position id, reporting line and budget stay
 * on their own governed channels.
 *
 * The package edit and the engine adjudication share the same seams as
 * move/delete/hire: one org mutation lock (so a concurrent apply cannot
 * interleave), one execution reservation (a permission change must never land
 * while a turn is mid-flight on the old grant), and `org apply` as the sole
 * validator of the applied model. Without the reservation an in-flight turn
 * would finish under a policy that no longer exists.
 */
export async function handlePositionProfilePatch(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
  positionId: string,
): Promise<void> {
  const patch = assertProfilePatch(await readJsonBody<unknown>(req));
  const ws = ctx.workspace.requireOpen();
  const release = ctx.runningTurns.reserveMutation(ws.dir, positionId);
  try {
    const outcome = await withOrgMutationLock(ws.dir, async () => {
      const role = ws.organization.roles.find((entry) => entry.id === positionId);
      if (!role) {
        throw new OrgApiError(errorCodes.position_missing, 404, `position not found: ${positionId}`);
      }
      const updated = await applyPositionProfile(ws, role, patch);
      const engineResult = await ctx.driver.apply(ws.dir);
      if (engineResult.status !== "applied") {
        // The engine is the only validator of the applied model. Leaving the
        // edited bytes behind would make the package disagree with
        // `.digital-employee/org.json` until the next unrelated org mutation
        // silently published the values the operator was just told were
        // rejected.
        await updated.rollback();
        if (engineResult.status === "engine_unavailable") {
          return { status: 503, body: failure(errorCodes.engine_unavailable, engineResult.message, true) };
        }
        if (engineResult.status === "engine_capability_missing") {
          return { status: 503, body: failure(errorCodes.engine_capability_missing, engineResult.message, false) };
        }
        return { status: 422, body: failure(engineResult.code, engineResult.message, engineResult.retryable) };
      }
      const version = await ctx.workspace.reloadAppliedOrganization();
      ctx.bus.publish("org.updated", {
        workspace: ws.dir,
        version,
        changes: [{ op: "update", id: positionId }],
      });
      return {
        status: 200,
        body: {
          status: "updated" as const,
          positionId,
          name: updated.name,
          mode: updated.mode,
          version,
        },
      };
    });
    sendJson(res, outcome.status, outcome.body);
  } finally { release(); }
}
