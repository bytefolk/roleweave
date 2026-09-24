import type { IncomingMessage, ServerResponse } from "node:http";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { sendJson } from "../http.js";

export async function handleTurnProgressList(ctx: ControlPlaneContext, res: ServerResponse): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  sendJson(res, 200, { snapshots: ctx.progressTracker.listActive(workspace.dir) });
}

export async function handleTurnProgressGet(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  req: IncomingMessage,
  turnId: string,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const positionId = url.searchParams.get("positionId") ?? undefined;
  const live = ctx.progressTracker.getSnapshot(turnId);
  if (live && live.workspacePath === workspace.dir) {
    sendJson(res, 200, live);
    return;
  }
  if (positionId) {
    const persisted = await ctx.progressTracker.loadPersisted(workspace.dir, positionId, turnId);
    if (persisted) {
      sendJson(res, 200, persisted);
      return;
    }
  }
  throw new OrgApiError(errorCodes.not_found, 404, "progress snapshot is not available");
}
