import type { IncomingMessage, ServerResponse } from "node:http";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import { experiments, parseExperimentsRequest } from "../experiments/service.js";

export async function handleExperimentsGet(ctx: ControlPlaneContext, res: ServerResponse, url: URL): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  if (url.searchParams.get("workspacePath") !== workspace.dir || [...url.searchParams.keys()].some(key => key !== "workspacePath")) {
    throw new OrgApiError(errorCodes.experiments_conflict, 409, "workspace changed; reload experimental settings");
  }
  sendJson(res, 200, await experiments(ctx).get(workspace));
}

export async function handleExperimentsUpdate(ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const request = parseExperimentsRequest(await readJsonBody<unknown>(req), true);
  sendJson(res, 200, await experiments(ctx).update(workspace, request));
}

export async function handleReportsAdvice(ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const request = parseExperimentsRequest(await readJsonBody<unknown>(req), false);
  sendJson(res, 200, await experiments(ctx).advise(workspace, request));
}
