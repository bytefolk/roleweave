import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  OrgApiError,
  errorCodes,
  turnEngines,
  validatePendingApproval,
} from "@roleweave/shared";
import type {
  EngineEvent,
  SseEventType,
  TurnEngine,
  TurnPendingApproval,
  TurnRecord,
  WorkbenchSession,
} from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import { createTurnEnvelope } from "../turns/envelope.js";
import { DeltaForwarder } from "../turns/delta-forwarder.js";
import { assertPositionId } from "../turns/store.js";

const MAX_INPUT_BYTES = 256 * 1024;

export interface TurnPostBody {
  positionId: string;
  input: string;
  engine: TurnEngine;
  /** Operator verdict for a resume turn (#193); optional, additive. */
  pendingApproval?: TurnPendingApproval;
  /** Additive #52: set only by the group spawn path, never by a route body. */
  groupRef?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Fail-closed boundary validation for the #193 verdict field. The checks live
 * in @roleweave/shared/pending-approval (#45: single source shared with
 * the desktop IPC boundary); the engine remains the byte-exact backstop.
 */
export function assertPendingApproval(raw: unknown): TurnPendingApproval {
  const checked = validatePendingApproval(raw);
  if (!checked.ok) {
    throw new OrgApiError(errorCodes.turn_request_invalid, 400, checked.message);
  }
  return checked.value;
}

function parsePostBody(raw: unknown): TurnPostBody {
  if (!isRecord(raw)) {
    throw new OrgApiError(errorCodes.turn_request_invalid, 400, "turn request must be a JSON object");
  }
  const keys = Object.keys(raw).sort();
  if (keys.join(",") !== "engine,input,positionId" && keys.join(",") !== "engine,input,pendingApproval,positionId") {
    throw new OrgApiError(
      errorCodes.turn_request_invalid,
      400,
      "turn request accepts exactly positionId, input, engine, and optional pendingApproval",
    );
  }
  const positionId = assertPositionId(raw.positionId);
  if (
    typeof raw.input !== "string" ||
    raw.input.trim().length === 0 ||
    Buffer.byteLength(raw.input, "utf8") > MAX_INPUT_BYTES
  ) {
    throw new OrgApiError(
      errorCodes.turn_request_invalid,
      400,
      "input must be a non-empty UTF-8 string no larger than 256 KiB",
    );
  }
  if (typeof raw.engine !== "string" || !turnEngines.includes(raw.engine as TurnEngine)) {
    throw new OrgApiError(
      errorCodes.turn_engine_unsupported,
      400,
      `engine must be ${turnEngines.join(" or ")}`,
    );
  }
  return {
    positionId,
    input: raw.input,
    engine: raw.engine as TurnEngine,
    ...(raw.pendingApproval !== undefined
      ? { pendingApproval: assertPendingApproval(raw.pendingApproval) }
      : {}),
  };
}

export function assertPositionExists(ctx: ControlPlaneContext, positionId: string): void {
  const workspace = ctx.workspace.requireOpen();
  if (!workspace.organization.roles.some((role) => role.id === positionId)) {
    throw new OrgApiError(errorCodes.position_missing, 404, `position not found: ${positionId}`);
  }
}

/** Additive #52: attribution fields attached to group-turn SSE payloads so
 * the renderer can split one SSE channel by turn and aggregate per group. */
export interface GroupEventAttribution {
  groupRef: string;
  messageId: string;
  turnId: string;
  positionId: string;
  engine: TurnEngine;
}

function groupTag(event: EngineEvent, group?: GroupEventAttribution): EngineEvent | (EngineEvent & GroupEventAttribution) {
  return group === undefined ? event : { ...event, ...group };
}

function eventType(event: EngineEvent): SseEventType {
  switch (event.type) {
    case "run.started":
      return "turn.started";
    case "model.delta":
      return "turn.model.delta";
    case "usage":
      return "turn.usage";
    case "run.completed":
      return "turn.completed";
    case "run.failed":
      return "turn.failed";
    case "approval.requested":
      return "turn.approval.requested";
    case "approval.granted":
      return "turn.approval.granted";
    case "approval.denied":
      return "turn.approval.denied";
  }
}

export async function handleTurnPost(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = parsePostBody(await readJsonBody<unknown>(req));
  assertPositionExists(ctx, body.positionId);
  await executeTurn(ctx, res, body);
}

/** Shared execution path. `sessionId` is server-resolved by SessionStore; it
 * never comes from a renderer-supplied position/principal mapping. */
export async function executeTurn(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  body: TurnPostBody,
  session?: WorkbenchSession,
  group?: GroupEventAttribution,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  // Group spawns carry a pre-assigned turnId so the 202 spawn list and the
  // executed envelope share one identity; personal turns keep server-random.
  const turnId = group !== undefined ? group.turnId : crypto.randomUUID();
  const createdAt = new Date().toISOString();
  // owb#63 clearing (de#205): the contract-level back-link rides the v1alpha2
  // envelope — group spawns echo the group conversationRef, session turns echo
  // the sessionId, bare personal turns stay v1 byte-exact.
  const conversationRef =
    group !== undefined ? group.groupRef : session !== undefined ? session.sessionId : undefined;
  const envelope = createTurnEnvelope({
    workspaceRef: workspace.dir,
    positionId: body.positionId,
    turnId,
    message: body.input,
    ...(body.pendingApproval !== undefined
      ? { pendingApproval: body.pendingApproval }
      : {}),
    ...(conversationRef !== undefined ? { conversationRef } : {}),
  });
  const beginInput = {
    workspace: workspace.dir,
    positionId: body.positionId,
    turnId,
    engine: body.engine,
    message: body.input,
    envelopeDigest: envelope.envelopeDigest,
    now: createdAt,
    // Additive #52: group spawns persist through the position store tagged
    // with the local conversationRef (session arg stays undefined). Kept as a
    // dual-write during the #63 clearing window so rollback never loses links.
    ...(group !== undefined ? { groupRef: group.groupRef } : {}),
    ...(conversationRef !== undefined ? { conversationRef } : {}),
  };
  const running = session === undefined
    ? await ctx.turnStore.begin(beginInput)
    : await ctx.turnStore.beginSession({ ...beginInput, sessionId: session.sessionId });

  let result;
  const forwarder = new DeltaForwarder({
    onForward: (event) => {
      if (event.type !== "run.completed" && event.type !== "run.failed") {
        ctx.bus.publish(eventType(event), groupTag(event, group));
      }
    },
  });
  try {
    result = await ctx.turnDriver.turnRun({
      workspace: workspace.dir,
      positionId: body.positionId,
      engine: body.engine,
      envelope,
      onEvent: (event) => forwarder.handle(event),
      setAbort: (abort) => ctx.runningTurns.register(body.positionId, abort),
    });
  } catch {
    result = {
      status: "indeterminate" as const,
      events: [],
      diagnostic: "",
      code: "turn_driver_failure",
    };
  } finally {
    ctx.runningTurns.unregister(body.positionId);
  }

  const updatedAt = new Date().toISOString();
  let record: TurnRecord;
  if (result.status === "indeterminate") {
    record = {
      ...running,
      status: "indeterminate",
      updatedAt,
      events: result.events,
      ...(result.events[0] !== undefined ? { runId: result.events[0].runId } : {}),
      error: {
        code: result.code,
        message: "the engine process ended without a trusted terminal; no automatic retry was attempted",
        retryable: false,
      },
    };
  } else {
    const terminal = result.events[result.events.length - 1]!;
    if (terminal.type === "run.completed") {
      record = {
        ...running,
        status: "completed",
        updatedAt,
        events: result.events,
        runId: terminal.runId,
        output: terminal.output,
      };
    } else if (terminal.type === "run.failed") {
      record = {
        ...running,
        status: "failed",
        updatedAt,
        events: result.events,
        runId: terminal.runId,
        error: {
          code: terminal.error.code,
          message: terminal.error.message,
          retryable: terminal.error.retryable,
        },
      };
    } else {
      record = {
        ...running,
        status: "indeterminate",
        updatedAt,
        events: result.events,
        error: {
          code: "turn_protocol_invalid",
          message: "the validated event stream did not end in a terminal event",
          retryable: false,
        },
      };
    }
  }
  if (session === undefined) await ctx.turnStore.finish(workspace.dir, record);
  else await ctx.turnStore.finishSession(workspace.dir, session.sessionId, record);
  if (session !== undefined && record.status === "completed") {
    // The durable turn is authoritative. Export persistence/adapter failure is
    // intentionally isolated and will be retried by workspace-open recovery.
    try {
      await ctx.contextExporter.enqueueCompletedTurn(workspace.dir, session, record);
    } catch {
      // No raw adapter or turn content crosses into the HTTP response/report.
    }
  }
  if (record.status === "indeterminate") {
    ctx.bus.publish("turn.indeterminate", {
      turnId,
      positionId: body.positionId,
      code: record.error?.code ?? "turn_protocol_invalid",
      envelopeDigest: envelope.envelopeDigest,
      ...(group !== undefined ? { ...group, conversationRef: group.groupRef } : {}),
      ...(group === undefined && conversationRef !== undefined ? { conversationRef } : {}),
    });
  } else {
    const terminal = result.events[result.events.length - 1];
    if (terminal?.type === "run.completed" || terminal?.type === "run.failed") {
      ctx.bus.publish(eventType(terminal), groupTag(terminal, group));
    }
  }
  sendJson(res, 200, record);
}

export async function handleTurnHistory(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const positionId = assertPositionId(url.searchParams.get("positionId"));
  assertPositionExists(ctx, positionId);
  const history = await ctx.turnStore.history(workspace.dir, positionId, new Date().toISOString());
  sendJson(res, 200, history);
}

/** Additive v0 route (issue #25): aborts the in-flight turn for a position.
 * The driver settles the turn as indeterminate/turn_cancelled through the
 * frozen turn.indeterminate vocabulary; no new SSE event is introduced. */
export async function handleTurnCancel(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readJsonBody<unknown>(req);
  if (!isRecord(raw) || Object.keys(raw).length !== 1 || typeof raw.positionId !== "string") {
    throw new OrgApiError(
      errorCodes.turn_request_invalid,
      400,
      "cancel request accepts exactly {positionId}",
    );
  }
  const positionId = assertPositionId(raw.positionId);
  if (!ctx.runningTurns.cancel(positionId)) {
    throw new OrgApiError(errorCodes.not_found, 404, `no running turn: ${positionId}`);
  }
  sendJson(res, 200, { cancelled: true, positionId });
}
