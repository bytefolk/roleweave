import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlPlaneContext } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";

export async function handleTaskList(ctx: ControlPlaneContext, res: ServerResponse, positionId?: string) {
  const workspace = ctx.workspace.requireOpen();
  sendJson(res, 200, { tasks: await ctx.taskBoardStore.list(workspace.dir, positionId) });
}
export async function handleTaskCreate(ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse) {
  const workspace = ctx.workspace.requireOpen();
  const task = await ctx.taskBoardStore.create(workspace.dir, workspace.organization, workspace.organization.owner, await readJsonBody(req));
  ctx.bus.publish("goal.updated", { taskId: task.taskId, workspacePath: workspace.dir });
  sendJson(res, 201, task);
}
export async function handleTaskDecision(ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse, taskId: string) {
  const workspace = ctx.workspace.requireOpen();
  const task = await ctx.taskBoardStore.decide(workspace.dir, taskId, workspace.organization, workspace.organization.owner, await readJsonBody(req));
  ctx.bus.publish("goal.updated", { taskId, workspacePath: workspace.dir });
  sendJson(res, 200, task);
}
export async function handleTaskStatus(ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse, taskId: string) {
  const workspace = ctx.workspace.requireOpen();
  const task = await ctx.taskBoardStore.transition(workspace.dir, taskId, workspace.organization, workspace.organization.owner, await readJsonBody(req));
  ctx.bus.publish("goal.updated", { taskId, workspacePath: workspace.dir });
  sendJson(res, 200, task);
}
