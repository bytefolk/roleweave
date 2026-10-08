import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { errorCodes, OrgApiError, validateGoalTaskAcceptanceCreateRequest } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";

export async function handleGoalCreate(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const body = await readJsonBody<unknown>(req);
  const goal = await ctx.goalStore.create(workspace.dir, body as Record<string, unknown>);
  ctx.bus.publish("goal.created", { goalId: goal.goalId, workspacePath: workspace.dir });
  sendJson(res, 201, { goalId: goal.goalId });
}

export async function handleGoalList(
  ctx: ControlPlaneContext,
  res: ServerResponse,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const goals = await ctx.goalStore.list(workspace.dir);
  sendJson(res, 200, { goals });
}

export async function handleGoalGet(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  goalId: string,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  let turns;
  try {
    turns = await ctx.turnStore.reportRecords(workspace.dir);
  } catch {
    turns = undefined;
  }
  const detail = await ctx.goalStore.getDetail(workspace.dir, goalId, turns,
    (turn) => ctx.runningTurns.isRunning(workspace.dir, turn.positionId, turn.turnId));
  sendJson(res, 200, detail);
}

export async function handleGoalUpdate(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
  goalId: string,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const body = await readJsonBody<unknown>(req);
  const goal = await ctx.goalStore.update(workspace.dir, goalId, body as Record<string, unknown>);
  ctx.bus.publish("goal.updated", { goalId: goal.goalId, workspacePath: workspace.dir });
  sendJson(res, 200, { goalId: goal.goalId });
}

export async function handleGoalDelete(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  goalId: string,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  await ctx.goalStore.delete(workspace.dir, goalId);
  ctx.bus.publish("goal.updated", { goalId, workspacePath: workspace.dir, deleted: true });
  sendJson(res, 200, { goalId, deleted: true });
}

/** The actor is derived from the authenticated local operator credential, never JSON. */
export async function handleGoalTaskAcceptance(
  ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse,
  goalId: string, taskId: string, actor: string,
): Promise<void> {
  const body = await readJsonBody<unknown>(req);
  const parsed = validateGoalTaskAcceptanceCreateRequest(body);
  if (!parsed.ok) throw new OrgApiError(errorCodes.goal_request_invalid, 400, parsed.message);
  // Re-read after the await: a queued request must not mutate a newly opened workspace.
  const workspace = ctx.workspace.requireOpen();
  if (path.resolve(parsed.value.expectedWorkspacePath) !== path.resolve(workspace.dir)) {
    throw new OrgApiError(errorCodes.goal_conflict, 409, "workspace changed; reload before accepting a delivery");
  }
  if (!workspace.organization.roles.some(role => role.id === parsed.value.source.positionId)) {
    throw new OrgApiError(errorCodes.unauthorized, 403, "acceptance source is not an employee in this workspace");
  }
  const release = ctx.runningTurns.reserveMutation(workspace.dir, parsed.value.source.positionId);
  try {
    const record = await ctx.goalStore.acceptTask(workspace.dir, goalId, taskId, parsed.value, actor);
    ctx.bus.publish("goal.updated", { goalId, workspacePath: workspace.dir, taskId, acceptanceId: record.acceptanceId });
    sendJson(res, 200, { record });
  } finally { release(); }
}
