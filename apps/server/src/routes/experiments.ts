import type { IncomingMessage, ServerResponse } from "node:http";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import { experiments, parseExperimentsRequest } from "../experiments/service.js";
import { resolveReadyHostChoice, sanitizeReadyHostFacts } from "../org/ready-host-overlay.js";

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

export async function handleReadyHostChoice(ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const body = await readJsonBody<unknown>(req);
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new OrgApiError(errorCodes.experiments_request_invalid, 400, "invalid ready-host request");
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["workspacePath", "workspaceSession", "revision", "candidates"].includes(key))) {
    throw new OrgApiError(errorCodes.experiments_request_invalid, 400, "invalid ready-host request");
  }
  const scope = parseExperimentsRequest(
    { workspacePath: record.workspacePath, workspaceSession: record.workspaceSession, revision: record.revision },
    false,
  );
  if (scope.workspacePath !== workspace.dir) throw new OrgApiError(errorCodes.experiments_conflict, 409, "workspace changed; reload experimental settings");
  const candidates = sanitizeReadyHostFacts(record.candidates);
  if (!Array.isArray(record.candidates) || candidates.length !== record.candidates.length) {
    throw new OrgApiError(errorCodes.experiments_request_invalid, 400, "invalid ready-host facts");
  }
  const snapshot = await experiments(ctx).get(workspace);
  if (
    snapshot.workspacePath !== scope.workspacePath ||
    snapshot.workspaceSession !== scope.workspaceSession ||
    snapshot.revision !== scope.revision
  ) {
    throw new OrgApiError(errorCodes.experiments_conflict, 409, "workspace or experimental settings changed; reload before trying again");
  }
  if (!snapshot.enabled || snapshot.availability !== "ready") {
    sendJson(res, 200, { ...scope, status: "disabled" as const, positionId: null });
    return;
  }
  const positionId = await resolveReadyHostChoice(candidates);
  sendJson(res, 200, { ...scope, status: "ready" as const, positionId });
}
