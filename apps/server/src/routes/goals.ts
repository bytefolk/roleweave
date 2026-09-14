import type { IncomingMessage, ServerResponse } from "node:http";
import { errorCodes, OrgApiError } from "@roleweave/shared";
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
  const detail = await ctx.goalStore.getDetail(workspace.dir, goalId, turns);
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
