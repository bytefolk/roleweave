import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlPlaneContext } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import { resolveAssigneeOverlay } from "../jev/assignee.js";
import { applyChangeManifest, undoLastOrgAdjustment } from "../org/apply.js";
import { listOrgBackups, restoreOrgBackup } from "../org/restore.js";

export async function handleOrgTree(
  ctx: ControlPlaneContext,
  res: ServerResponse,
): Promise<void> {
  const snapshot = ctx.workspace.snapshot();
  const overlay = await resolveAssigneeOverlay(
    ctx.workspace.requireOpen().organization.roles.map((role) => ({
      id: role.id,
      name: role.name,
      mode: role.mode,
    })),
  );
  sendJson(res, 200, overlay ? { ...snapshot, assigneeOverlay: overlay } : snapshot);
}

export async function handleOrgBackups(
  ctx: ControlPlaneContext,
  res: ServerResponse,
): Promise<void> {
  sendJson(res, 200, await listOrgBackups(ctx));
}

export async function handleOrgRestore(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const outcome = await restoreOrgBackup(ctx, await readJsonBody<unknown>(req));
  sendJson(res, outcome.status, outcome.body);
}

export async function handleOrgApply(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rawBody = await readJsonBody<unknown>(req);
  const outcome = await applyChangeManifest(ctx, rawBody);
  sendJson(res, outcome.status, outcome.body);
}

export async function handleOrgUndo(
  ctx: ControlPlaneContext,
  res: ServerResponse,
): Promise<void> {
  const outcome = await undoLastOrgAdjustment(ctx);
  sendJson(res, outcome.status, outcome.body);
}
