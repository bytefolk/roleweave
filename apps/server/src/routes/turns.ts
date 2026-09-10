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
import type { OpenWorkspace } from "../workspace-state.js";
import { readJsonBody, sendJson } from "../http.js";
import { createTurnEnvelope } from "../turns/envelope.js";
import { DeltaForwarder } from "../turns/delta-forwarder.js";
import { assertPositionId, compareRfc3339Instants, compareCodeUnitOrdinal } from "../turns/store.js";
import { compactThreadContextHistory, materializeThreadContext, type SupplementalContext, type ThreadContextSource } from "../turns/thread-context.js";

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

/** Bind an accepted request to the project selected before its first await. */
export function assertTurnWorkspace(ctx: ControlPlaneContext, expected: OpenWorkspace): void {
  if (ctx.workspace.active !== expected) {
    throw new OrgApiError(errorCodes.session_conflict, 409, "the open workspace changed before the turn started; resend the request in the intended workspace");
  }
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

interface PersonalEventAttribution { turnId: string; positionId: string; engine: TurnEngine; sessionId?: string; conversationRef?: string }

function groupTag(event: EngineEvent, group?: GroupEventAttribution | PersonalEventAttribution): EngineEvent | (EngineEvent & (GroupEventAttribution | PersonalEventAttribution)) {
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
  const workspace = ctx.workspace.requireOpen();
  const body = parsePostBody(await readJsonBody<unknown>(req));
  assertTurnWorkspace(ctx, workspace);
  assertPositionExists(ctx, body.positionId);
  await executeTurn(ctx, res, body, undefined, undefined, undefined, workspace);
}

/** Shared execution path. `sessionId` is server-resolved by SessionStore; it
 * never comes from a renderer-supplied position/principal mapping. */
export async function executeTurn(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  body: TurnPostBody,
  session?: WorkbenchSession,
  group?: GroupEventAttribution,
  supplementalContext?: readonly SupplementalContext[],
  expectedWorkspace?: OpenWorkspace,
): Promise<TurnRecord> {
  const workspace = expectedWorkspace ?? ctx.workspace.requireOpen();
  assertTurnWorkspace(ctx, workspace);
  const turnId = group !== undefined ? group.turnId : crypto.randomUUID();
  const reservation = ctx.runningTurns.reserve(workspace.dir, body.positionId, turnId);
  try {
    // Group spawns carry a pre-assigned turnId so the 202 spawn list and the
    // executed envelope share one identity; personal turns keep server-random.
    const createdAt = new Date().toISOString();
    // owb#63 clearing (de#205): the contract-level back-link rides the v1alpha2
    // envelope — group spawns echo the group conversationRef, session turns echo
    // the sessionId, bare personal turns stay v1 byte-exact.
    const conversationRef =
      group !== undefined ? group.groupRef : session !== undefined ? session.sessionId : undefined;
    const attribution = { workspacePath: workspace.dir, ...(group ?? {
      turnId, positionId: body.positionId, engine: body.engine,
      ...(session !== undefined ? { sessionId: session.sessionId, conversationRef: session.sessionId } : {}),
    }) };
    let history: ThreadContextSource[] = [];
    let omittedTurnCount = 0;
    let historyTruncated = false;
    let historyRedacted = false;
    if (session !== undefined && session.threadContextEnabled !== false) {
      history = (await ctx.turnStore.sessionHistory(workspace.dir, session.sessionId, session.positionId, createdAt)).turns;
    } else if (group !== undefined) {
      const conversation = await ctx.groupStore.get(workspace.dir, group.groupRef);
      // Read accepted identities from this group instead of every employee's
      // personal history. Corrupt sources are omitted individually.
      const messages = await ctx.groupStore.readContextMessages(workspace.dir, group.groupRef);
      const memberSources = new Map<string, ThreadContextSource[]>();
      const seen = new Set<string>();
      const belongs = (turn: TurnRecord): boolean => turn.conversationRef === group.groupRef ||
        (turn.conversationRef === undefined && turn.groupRef === group.groupRef);
      const compare = (left: ThreadContextSource, right: ThreadContextSource): number =>
        compareRfc3339Instants(left.createdAt, right.createdAt) || compareCodeUnitOrdinal(left.turnId, right.turnId);
      for (const message of messages) {
        for (const spawn of message.spawns ?? []) {
          if (!conversation.members.includes(spawn.positionId) || seen.has(spawn.turnId)) continue;
          seen.add(spawn.turnId);
          try {
            const source = await ctx.turnStore.readPositionTurn(workspace.dir, spawn.positionId, spawn.turnId, createdAt);
            if (source === null || !belongs(source) || source.status !== "completed") continue;
            const candidates = memberSources.get(spawn.positionId) ?? [];
            candidates.push(source);
            candidates.sort(compare);
            // Release large event/output payloads before reading another source.
            const compact = compactThreadContextHistory(candidates);
            memberSources.set(spawn.positionId, compact.turns);
            omittedTurnCount += compact.omittedTurnCount;
            historyTruncated ||= compact.truncated;
            historyRedacted ||= compact.redacted;
          } catch (error) {
            if (!(error instanceof OrgApiError) || error.code !== errorCodes.turn_storage_failed) throw error;
            omittedTurnCount += 1;
          }
        }
      }
      // Legacy accepted messages did not persist spawn identities. Preserve
      // their same-group history while isolating each damaged employee source.
      const legacyMembers = new Set(messages.filter((message) => message.spawns === undefined).flatMap((message) => message.mentions));
      for (const member of legacyMembers) {
        if (!conversation.members.includes(member)) continue;
        try {
          const legacy = await ctx.turnStore.history(workspace.dir, member, createdAt);
          const compact = compactThreadContextHistory(legacy.turns.filter((turn) => belongs(turn) && !seen.has(turn.turnId)));
          history.push(...compact.turns);
          omittedTurnCount += compact.omittedTurnCount;
          historyTruncated ||= compact.truncated;
          historyRedacted ||= compact.redacted;
        } catch (error) {
          if (!(error instanceof OrgApiError) || error.code !== errorCodes.turn_storage_failed) throw error;
          omittedTurnCount += 1;
        }
      }
      history.push(...[...memberSources.values()].flat());
      history.sort(compare);
    }
    const context = materializeThreadContext({
      input: body.input,
      enabled: group !== undefined || (session !== undefined && session.threadContextEnabled !== false),
      turns: history,
      omittedTurnCount,
      truncated: historyTruncated,
      redacted: historyRedacted,
      ...(supplementalContext !== undefined ? { supplementalContext } : {}),
    });
    const envelope = createTurnEnvelope({
      workspaceRef: workspace.dir,
      positionId: body.positionId,
      turnId,
      message: context.input,
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
      ...(session !== undefined || group !== undefined || supplementalContext !== undefined ? { threadContext: context.metadata } : {}),
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
          ctx.bus.publish(eventType(event), groupTag(event, attribution));
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
        setAbort: (abort) => reservation.setAbort(abort),
      });
    } catch {
      result = {
        status: "indeterminate" as const,
        events: [],
        diagnostic: "",
        code: "turn_driver_failure",
      };
    } finally {
      // A driver may settle without an engine terminal. Retire its timers
      // and callbacks before durable completion and reservation release.
      forwarder.close();
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
        code: record.error?.code ?? "turn_protocol_invalid",
        envelopeDigest: envelope.envelopeDigest,
        ...attribution,
        ...(group !== undefined ? { conversationRef: group.groupRef } : {}),
      });
    } else {
      const terminal = result.events[result.events.length - 1];
      if (terminal?.type === "run.completed" || terminal?.type === "run.failed") {
        ctx.bus.publish(eventType(terminal), groupTag(terminal, attribution));
      }
    }
    sendJson(res, 200, record);
    return record;
  } finally {
    reservation.release();
  }
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
  const workspace = ctx.workspace.active;
  const raw = await readJsonBody<unknown>(req);
  const keys = isRecord(raw) ? Object.keys(raw).sort().join(",") : "";
  if (!isRecord(raw) || !["positionId", "positionId,workspacePath", "positionId,turnId,workspacePath"].includes(keys) ||
      typeof raw.positionId !== "string" ||
      (Object.hasOwn(raw, "workspacePath") && (typeof raw.workspacePath !== "string" || raw.workspacePath.trim().length === 0 || raw.workspacePath.includes("\0") || Buffer.byteLength(raw.workspacePath) > 4096)) ||
      (Object.hasOwn(raw, "turnId") && (typeof raw.turnId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw.turnId)))) {
    throw new OrgApiError(errorCodes.turn_request_invalid, 400,
      "cancel request accepts positionId and optional workspacePath with optional turnId");
  }
  let ownerWorkspace: string;
  if (typeof raw.workspacePath === "string") {
    // This is only an existing registry key, never a path to read from disk.
    ownerWorkspace = raw.workspacePath;
  } else {
    if (workspace === null) ctx.workspace.requireOpen();
    assertTurnWorkspace(ctx, workspace!);
    ownerWorkspace = workspace!.dir;
  }
  const positionId = assertPositionId(raw.positionId);
  if (!ctx.runningTurns.cancel(ownerWorkspace, positionId, typeof raw.turnId === "string" ? raw.turnId : undefined)) {
    throw new OrgApiError(errorCodes.not_found, 404, `no running turn: ${positionId}`);
  }
  sendJson(res, 200, { cancelled: true, positionId });
}
