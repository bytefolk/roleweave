import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import { approvals, parseBatchDecision, parseDecision } from "../approvals/service.js";

export async function handleApprovals(ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse, url: URL, actor?: string): Promise<boolean> {
  if (url.pathname === "/approvals/batch/decision") {
    if (req.method !== "POST") throw new OrgApiError(errorCodes.method_not_allowed, 405, "Unsupported approval operation");
    const body = await readJsonBody<Record<string, unknown>>(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new OrgApiError(errorCodes.approval_request_invalid, 400, "Invalid batch decision");
    const { workspaceToken, ...decision } = body;
    if (!actor) throw new OrgApiError(errorCodes.unauthorized, 401, "An authenticated approval actor is required");
    const result = await approvals(ctx).decideBatch(ctx.workspace.requireOpen(), workspaceToken, parseBatchDecision(decision), actor);
    sendJson(res, result.status, result.response);
    return true;
  }
  const match = url.pathname.match(/^\/approvals(?:\/([a-f0-9]{64})(?:\/(decision|audit))?)?$/);
  if (!match) return false;
  const ws = ctx.workspace.requireOpen();
  const service = approvals(ctx);
  if (req.method === "POST" && match[1] && match[2] === "decision") {
    const body = await readJsonBody<Record<string, unknown>>(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new OrgApiError(errorCodes.approval_request_invalid, 400, "Invalid decision");
    const { workspaceToken, ...decision } = body;
    if (!actor) throw new OrgApiError(errorCodes.unauthorized, 401, "An authenticated approval actor is required");
    const result = await service.decide(ws, workspaceToken, match[1], parseDecision(decision), actor);
    sendJson(res, result.status, result.record);
    return true;
  }
  if (req.method === "GET" && match[1] && match[2] === "audit") {
    sendJson(res, 200, { approvalId: match[1], events: await service.audit(ws, match[1]) });
    return true;
  }
  if (req.method !== "GET" || match[2]) throw new OrgApiError(errorCodes.method_not_allowed, 405, "Unsupported approval operation");
  if ([...url.searchParams.keys()].some(k => !["workspacePath", "status", "limit", "cursor"].includes(k)) ||
      (url.searchParams.has("workspacePath") && url.searchParams.get("workspacePath") !== ws.dir)) throw new OrgApiError(errorCodes.approval_conflict, 409, "Workspace changed or query is invalid");
  const items = await service.list(ws);
  if (match[1]) {
    const item = items.find(a => a.id === match[1]);
    if (!item) throw new OrgApiError(errorCodes.approval_missing, 404, "Approval not found");
    sendJson(res, 200, item); return true;
  }
  const status = url.searchParams.get("status") ?? "all";
  const limit = Number(url.searchParams.get("limit") ?? 50);
  if (!["all", "pending", "decided"].includes(status) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new OrgApiError(errorCodes.approval_request_invalid, 400, "Invalid approval filter or page size");
  const filtered = items.filter(a => status === "all" || (status === "pending" ? a.status === "pending" : a.status !== "pending"));
  const revision = crypto.createHash("sha256").update(JSON.stringify(items.map(a => [a.id, a.version, a.canDecide]))).digest("hex");
  const cursor = url.searchParams.get("cursor");
  let offset = 0;
  if (cursor) {
    const [version, rawOffset] = cursor.split(":");
    offset = Number(rawOffset);
    if (version !== revision || !Number.isSafeInteger(offset) || offset < 0) throw new OrgApiError(errorCodes.approval_snapshot_changed, 409, "Approval snapshot changed; restart pagination");
  }
  sendJson(res, 200, { items: filtered.slice(offset, offset + limit), nextCursor: offset + limit < filtered.length ? `${revision}:${offset + limit}` : null,
    pendingCount: items.filter(a => a.status === "pending").length, revision, syncState: "ready", workspaceToken: service.token(ws) });
  return true;
}
