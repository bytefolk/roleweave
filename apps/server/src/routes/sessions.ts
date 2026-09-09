import type { IncomingMessage, ServerResponse } from "node:http";
import { OrgApiError, errorCodes, turnEngines } from "@roleweave/shared";
import type { TurnEngine } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import { assertSessionId } from "../sessions/store.js";
import { assertPositionExists, assertPendingApproval, assertTurnWorkspace, executeTurn } from "./turns.js";
import type { TurnPendingApproval } from "@roleweave/shared";

const MAX_INPUT_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function parseCreate(raw: unknown): string {
  if (!isRecord(raw) || !exactKeys(raw, ["positionId"]) || typeof raw.positionId !== "string") {
    throw new OrgApiError(
      errorCodes.session_request_invalid,
      400,
      "session create accepts exactly positionId",
    );
  }
  return raw.positionId;
}

function parseEmpty(raw: unknown): void {
  if (!isRecord(raw) || !exactKeys(raw, [])) {
    throw new OrgApiError(
      errorCodes.session_request_invalid,
      400,
      "session rotate accepts an empty JSON object",
    );
  }
}

function parseSessionTurn(raw: unknown): {
  input: string;
  engine: TurnEngine;
  pendingApproval?: TurnPendingApproval;
} {
  if (
    !isRecord(raw) ||
    (!exactKeys(raw, ["input", "engine"]) && !exactKeys(raw, ["input", "engine", "pendingApproval"]))
  ) {
    throw new OrgApiError(
      errorCodes.turn_request_invalid,
      400,
      "session turn accepts exactly input, engine, and optional pendingApproval",
    );
  }
  if (
    typeof raw.input !== "string" || raw.input.trim().length === 0 ||
    Buffer.byteLength(raw.input, "utf8") > MAX_INPUT_BYTES
  ) {
    throw new OrgApiError(
      errorCodes.turn_request_invalid,
      400,
      "input must be a non-empty UTF-8 string no larger than 256 KiB",
    );
  }
  if (typeof raw.engine !== "string" || !turnEngines.includes(raw.engine as TurnEngine)) {
    throw new OrgApiError(errorCodes.turn_engine_unsupported, 400, `engine must be ${turnEngines.join(" or ")}`);
  }
  return {
    input: raw.input,
    engine: raw.engine as TurnEngine,
    ...(raw.pendingApproval !== undefined
      ? { pendingApproval: assertPendingApproval(raw.pendingApproval) }
      : {}),
  };
}

export async function handleSessionCreate(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const positionId = parseCreate(await readJsonBody<unknown>(req));
  assertTurnWorkspace(ctx, workspace);
  assertPositionExists(ctx, positionId);
  const session = await ctx.sessionStore.create(workspace.dir, positionId);
  sendJson(res, 201, session);
}

export async function handleSessionList(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const positionId = url.searchParams.get("positionId");
  if (url.searchParams.size !== 1 || typeof positionId !== "string") {
    throw new OrgApiError(
      errorCodes.session_request_invalid,
      400,
      "session list requires exactly positionId",
    );
  }
  assertPositionExists(ctx, positionId);
  const workspace = ctx.workspace.requireOpen();
  sendJson(res, 200, await ctx.sessionStore.list(workspace.dir, positionId));
}

export async function handleSessionGet(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  sendJson(res, 200, await ctx.sessionStore.get(workspace.dir, assertSessionId(sessionId)));
}

export async function handleSessionRotate(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  parseEmpty(await readJsonBody<unknown>(req));
  assertTurnWorkspace(ctx, workspace);
  const source = await ctx.sessionStore.get(workspace.dir, assertSessionId(sessionId));
  const release = ctx.runningTurns.reserveMutation(workspace.dir, source.positionId);
  try {
    // Hold the employee exclusion across every asynchronous read and write.
    await ctx.turnStore.sessionHistory(workspace.dir, source.sessionId, source.positionId, new Date().toISOString());
    if (ctx.turnStore.hasActiveSessionTurns(workspace.dir, source.sessionId)) {
      throw new OrgApiError(errorCodes.session_conflict, 409, "session has a running or persistence-indeterminate turn and cannot be rotated");
    }
    const result = await ctx.sessionStore.rotate(workspace.dir, source.sessionId);
    sendJson(res, result.created ? 201 : 200, result.session);
  } finally { release(); }
}

export async function handleSessionTurnPost(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const body = parseSessionTurn(await readJsonBody<unknown>(req));
  assertTurnWorkspace(ctx, workspace);
  const session = await ctx.sessionStore.reserveTurn(workspace.dir, assertSessionId(sessionId));
  try {
    assertTurnWorkspace(ctx, workspace);
    assertPositionExists(ctx, session.positionId);
    await executeTurn(ctx, res, { ...body, positionId: session.positionId }, session, undefined, undefined, workspace);
  } finally {
    ctx.sessionStore.releaseTurn(workspace.dir, session.sessionId);
  }
}

export async function handleSessionTurnHistory(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const session = await ctx.sessionStore.get(workspace.dir, assertSessionId(sessionId));
  const history = await ctx.turnStore.sessionHistory(
    workspace.dir,
    session.sessionId,
    session.positionId,
    new Date().toISOString(),
  );
  sendJson(res, 200, history);
}

/** Change the server-owned context policy for future turns; active turns keep their snapshot. */
export async function handleSessionContextPatch(
  ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse, sessionId: string,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const body = await readJsonBody<unknown>(req);
  assertTurnWorkspace(ctx, workspace);
  if (!isRecord(body) || !exactKeys(body, ["enabled"]) || typeof body.enabled !== "boolean") {
    throw new OrgApiError(errorCodes.session_request_invalid, 400, "session context accepts exactly enabled: boolean");
  }
  const id = assertSessionId(sessionId);
  const session = await ctx.sessionStore.get(workspace.dir, id);
  const release = ctx.runningTurns.reserveMutation(workspace.dir, session.positionId);
  try {
    if (ctx.turnStore.hasActiveSessionTurns(workspace.dir, id)) {
      throw new OrgApiError(errorCodes.session_conflict, 409, "session has an unresolved turn");
    }
    sendJson(res, 200, await ctx.sessionStore.setThreadContext(workspace.dir, id, body.enabled));
  } finally { release(); }
}
