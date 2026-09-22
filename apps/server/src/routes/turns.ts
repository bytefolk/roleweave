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
import type { RunningTurnReservation } from "../turns/running.js";
import { readJsonBody, sendJson } from "../http.js";
import { createTurnEnvelope } from "../turns/envelope.js";
import { DeltaForwarder } from "../turns/delta-forwarder.js";
import { assertPositionId, compareRfc3339Instants, compareCodeUnitOrdinal } from "../turns/store.js";
import { compactThreadContextHistory, materializeThreadContext, type SupplementalContext, type ThreadContextSource } from "../turns/thread-context.js";
import { readPositionAgentBinding, resolvePositionAgentEngine } from "../agent-binding.js";
import { employeeModelConfig } from "../model-selection.js";
import { readAttachmentMetas, attachmentFilePath } from "../attachments/store.js";
import { assertAttachmentBatch, assertAttachmentId } from "../attachments/validate.js";
import type { TurnAttachment } from "@roleweave/shared";
import { ATTACHMENT_MAX_COUNT } from "@roleweave/shared";

const MAX_INPUT_BYTES = 256 * 1024;

/**
 * Engine-visible attachment context (Decision A2). P0 lists file paths only —
 * PDF text extraction is out of scope until pdfjs-dist is a declared, packaged
 * runtime dependency. The assembled string must fit the 256 KiB input budget
 * so thread history is not squeezed to zero.
 */
export function buildAttachmentContext(
  attachments: TurnAttachment[],
  workspace: string,
  sessionId: string,
  userInput: string,
): string {
  const lines: string[] = ["[Attached files]"];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]!;
    const filePath = attachmentFilePath(workspace, sessionId, att.id);
    lines.push(`- File ${i + 1}: ${att.fileName} (${att.mimeType}, path: ${filePath})`);
  }
  lines.push("", "[User message]", userInput);
  const assembled = lines.join("\n");
  if (Buffer.byteLength(assembled, "utf8") > MAX_INPUT_BYTES) {
    throw new OrgApiError(
      errorCodes.turn_request_invalid,
      400,
      "attachment context exceeds 256 KiB input budget",
    );
  }
  return assembled;
}

export interface TurnPostBody {
  /** Session retry association; never accepted by the bare or group routes. */
  retryOf?: string;
  positionId: string;
  input: string;
  engine: TurnEngine;
  /** Operator verdict for a resume turn (#193); optional, additive. */
  pendingApproval?: TurnPendingApproval;
  /** Internal-only atomic recovery input assembled by ApprovalService. */
  pendingApprovals?: TurnPendingApproval[];
  /** Additive #52: set only by the group spawn path, never by a route body. */
  groupRef?: string;
  /** Additive #222: optional goal binding. */
  goalId?: string;
  branchId?: string;
  /** Additive #306: optional attachment ids to include in this turn. */
  attachmentIds?: string[];
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
  throw new OrgApiError(errorCodes.approval_endpoint_required, 409, "Use the approval decision endpoint so source, expiry and duplicate decisions are checked");
}

function parsePostBody(raw: unknown): TurnPostBody {
  if (!isRecord(raw)) {
    throw new OrgApiError(errorCodes.turn_request_invalid, 400, "turn request must be a JSON object");
  }
  const allowedKeys = new Set(["positionId", "input", "engine", "pendingApproval", "goalId", "branchId", "retryOf", "attachmentIds"]);
  if (Object.keys(raw).some((k) => !allowedKeys.has(k))) {
    throw new OrgApiError(
      errorCodes.turn_request_invalid,
      400,
      "turn request accepts positionId, input, engine, and optional pendingApproval, goalId, branchId, retryOf, attachmentIds",
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
  const GOAL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
  if (raw.goalId !== undefined && (typeof raw.goalId !== "string" || !GOAL_ID_PATTERN.test(raw.goalId))) {
    throw new OrgApiError(errorCodes.turn_request_invalid, 400, "goalId must be a bounded alphanumeric string");
  }
  if (raw.branchId !== undefined && (typeof raw.branchId !== "string" || !GOAL_ID_PATTERN.test(raw.branchId))) {
    throw new OrgApiError(errorCodes.turn_request_invalid, 400, "branchId must be a bounded alphanumeric string");
  }
  let attachmentIds: string[] | undefined;
  if (raw.attachmentIds !== undefined) {
    if (!Array.isArray(raw.attachmentIds) || raw.attachmentIds.length === 0 || raw.attachmentIds.length > ATTACHMENT_MAX_COUNT) {
      throw new OrgApiError(errorCodes.turn_request_invalid, 400, `attachmentIds must be 1–${ATTACHMENT_MAX_COUNT} entries`);
    }
    attachmentIds = raw.attachmentIds.map((id) => assertAttachmentId(id));
  }
  return {
    positionId,
    input: raw.input,
    engine: raw.engine as TurnEngine,
    ...(raw.pendingApproval !== undefined
      ? { pendingApproval: assertPendingApproval(raw.pendingApproval) }
      : {}),
    ...(raw.goalId !== undefined ? { goalId: raw.goalId } : {}),
    ...(raw.branchId !== undefined ? { branchId: raw.branchId } : {}),
    ...(raw.retryOf !== undefined && typeof raw.retryOf === "string" ? { retryOf: raw.retryOf } : {}),
    ...(attachmentIds !== undefined ? { attachmentIds } : {}),
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
    case "trace.activity":
      return "turn.trace.activity";
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
  res: ServerResponse | undefined,
  body: TurnPostBody,
  session?: WorkbenchSession,
  group?: GroupEventAttribution,
  supplementalContext?: readonly SupplementalContext[],
  expectedWorkspace?: OpenWorkspace,
  approvalExecution?: { turnId: string; reservation: RunningTurnReservation; beforeRun: () => Promise<void> },
): Promise<TurnRecord> {
  const workspace = expectedWorkspace ?? ctx.workspace.requireOpen();
  assertTurnWorkspace(ctx, workspace);
  const turnId = approvalExecution?.turnId ?? (group !== undefined ? group.turnId : crypto.randomUUID());
  const reservation = approvalExecution?.reservation ?? ctx.runningTurns.reserve(workspace.dir, body.positionId, turnId);
  try {
    let retryHistory: TurnRecord[] | undefined;
    if (body.retryOf !== undefined) {
      if (session === undefined || group !== undefined) {
        throw new OrgApiError(errorCodes.turn_request_invalid, 400, "retry requires a personal session");
      }
      // Read only this server-owned session. A foreign turn id is indistinguishable
      // from a missing id, and cannot cause a lookup in another employee's history.
      retryHistory = (await ctx.turnStore.sessionHistory(workspace.dir, session.sessionId, session.positionId, new Date().toISOString())).turns;
      assertTurnWorkspace(ctx, workspace);
      const original = retryHistory.find((turn) => turn.turnId === body.retryOf);
      if (!original || original.positionId !== session.positionId ||
          (original.conversationRef !== undefined && original.conversationRef !== session.sessionId)) {
        throw new OrgApiError(errorCodes.turn_request_invalid, 400, "retry source is not available in this session");
      }
      if (original.status !== "failed" && original.status !== "indeterminate") {
        throw new OrgApiError(errorCodes.session_conflict, 409, "only a failed or unknown turn can be explicitly retried");
      }
      if (original.error?.code === "engine.approval_required" || body.pendingApproval !== undefined) {
        throw new OrgApiError(errorCodes.session_conflict, 409, "use the approval action to continue a turn awaiting a verdict");
      }
      if (body.input !== original.input) {
        throw new OrgApiError(errorCodes.turn_request_invalid, 400, "edited input must be submitted as a new task without retryOf");
      }
    }
    // The renderer's engine value is only a first-use fallback for legacy
    // positions. Once a sidecar exists it is authoritative, including for
    // session and group paths which share this executor.
    const resolvedEngine = await resolvePositionAgentEngine(
      workspace,
      body.positionId,
      body.engine,
      ctx.turnStore,
      ctx.sessionStore,
    );
    if (approvalExecution && body.engine !== resolvedEngine) throw new OrgApiError(errorCodes.approval_conflict, 409, "Approval engine changed");
    if (body.engine !== resolvedEngine) body = { ...body, engine: resolvedEngine };
    const binding = await readPositionAgentBinding(workspace, body.positionId);
    const modelConfig = await employeeModelConfig(resolvedEngine, binding?.model, ctx.config.bundledElectronEngine);
    if (modelConfig.connection?.status === "invalid") {
      throw new OrgApiError(errorCodes.turn_request_invalid, 400, modelConfig.connection.message ?? "Agent connection configuration is invalid");
    }
    const model = modelConfig.editable && modelConfig.selected !== "provider-default" ? modelConfig.selected : undefined;
    if (group !== undefined && group.engine !== resolvedEngine) group = { ...group, engine: resolvedEngine };
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
      history = retryHistory ?? (await ctx.turnStore.sessionHistory(workspace.dir, session.sessionId, session.positionId, createdAt)).turns;
    } else if (group !== undefined) {
      const groupRef = group.groupRef;
      const conversation = await ctx.groupStore.get(workspace.dir, groupRef);
      // Read accepted identities from this group instead of every employee's
      // personal history. Corrupt sources are omitted individually.
      const messages = await ctx.groupStore.readContextMessages(workspace.dir, groupRef);
      const memberSources = new Map<string, ThreadContextSource[]>();
      const seen = new Set<string>();
      const belongs = (turn: TurnRecord): boolean => turn.conversationRef === groupRef ||
        (turn.conversationRef === undefined && turn.groupRef === groupRef);
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
    // Additive #306: resolve attachment manifests and build engine context.
    let resolvedAttachments: TurnAttachment[] | undefined;
    let augmentedInput = body.input;
    if (body.attachmentIds !== undefined) {
      if (session === undefined) {
        throw new OrgApiError(
          errorCodes.attachment_request_invalid,
          400,
          "attachmentIds require a personal session; bare /turns cannot carry attachments",
        );
      }
      resolvedAttachments = await readAttachmentMetas(workspace.dir, session.sessionId, body.attachmentIds);
      if (resolvedAttachments.length === 0) {
        throw new OrgApiError(errorCodes.attachment_missing, 400, "one or more attachment ids were not found in this session");
      }
      assertAttachmentBatch(resolvedAttachments);
      augmentedInput = buildAttachmentContext(resolvedAttachments, workspace.dir, session.sessionId, body.input);
    }
    const context = materializeThreadContext({
      input: augmentedInput,
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
      ...(body.pendingApprovals !== undefined
        ? { pendingApprovals: body.pendingApprovals }
        : {}),
      ...(conversationRef !== undefined ? { conversationRef } : {}),
    });
    const beginInput = {
      ...(model === undefined ? {} : { model }),
      ...(body.retryOf !== undefined ? { retryOf: body.retryOf } : {}),
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
      ...(resolvedAttachments !== undefined ? { attachments: resolvedAttachments } : {}),
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
      assertTurnWorkspace(ctx, workspace);
      await approvalExecution?.beforeRun();
      assertTurnWorkspace(ctx, workspace);
      result = await ctx.turnDriver.turnRun({
        ...(model === undefined ? {} : { model }),
        workspace: workspace.dir,
        positionId: body.positionId,
        engine: body.engine,
        envelope,
        onEvent: (event) => forwarder.handle(event),
        setAbort: (abort) => reservation.setAbort(abort),
      });
    } catch (error) {
      result = {
        status: "indeterminate" as const,
        events: [],
        diagnostic: "",
        code: approvalExecution && error instanceof OrgApiError ? error.code : "turn_driver_failure",
      };
    } finally {
      // A driver may settle without an engine terminal. Retire its timers
      // and callbacks before durable completion and reservation release.
      forwarder.close();
    }

    const updatedAt = new Date().toISOString();
    let record: TurnRecord;
    if (result.status === "indeterminate") {
      const partialOutput = extractPartialOutput(result.events);
      record = {
        ...running,
        status: "indeterminate",
        updatedAt,
        events: result.events,
        ...(result.events[0] !== undefined ? { runId: result.events[0].runId } : {}),
        ...(partialOutput !== undefined ? { output: partialOutput } : {}),
        error: {
          code: result.code,
          message: indeterminateMessage(result.code, partialOutput !== undefined),
          retryable: result.code === "turn_timeout" || result.code === "turn_cancelled",
          ...(result.diagnostic !== "" ? { diagnostic: result.diagnostic } : {}),
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
        ...(record.error?.diagnostic !== undefined ? { diagnostic: record.error.diagnostic } : {}),
        ...attribution,
        ...(group !== undefined ? { conversationRef: group.groupRef } : {}),
      });
    } else {
      const terminal = result.events[result.events.length - 1];
      if (terminal?.type === "run.completed" || terminal?.type === "run.failed") {
        ctx.bus.publish(eventType(terminal), groupTag(terminal, attribution));
      }
    }
    if (res) sendJson(res, 200, record);
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
  const sanitized = {
    ...history,
    turns: history.turns.map((turn) => {
      if (turn.error?.diagnostic === undefined) return turn;
      const { diagnostic: _diagnostic, ...errorWithoutDiagnostic } = turn.error;
      return { ...turn, error: errorWithoutDiagnostic };
    }),
  };
  sendJson(res, 200, sanitized);
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

const INDETERMINATE_MESSAGES: Record<string, string> = {
  turn_engine_unavailable: "the engine process could not be started; check that the engine CLI is installed and reachable",
  turn_protocol_invalid: "the engine output did not conform to the expected protocol; no automatic retry was attempted",
  turn_driver_failure: "the driver encountered an internal error; no automatic retry was attempted",
  turn_process_failed: "the engine process exited with a non-zero status; no automatic retry was attempted",
  turn_process_exit_1: "the engine process exited with status 1; no automatic retry was attempted",
};

function indeterminateMessage(code: string, hasPartialOutput: boolean): string {
  if (code === "turn_timeout") {
    return hasPartialOutput
      ? "the turn exceeded its time budget and was terminated; partial output was preserved"
      : "the turn exceeded its time budget and was terminated before any output was received";
  }
  if (code === "turn_cancelled") {
    return hasPartialOutput
      ? "the turn was cancelled by the operator; partial output was preserved"
      : "the turn was cancelled by the operator before any output was received";
  }
  return INDETERMINATE_MESSAGES[code] ?? `the engine process ended unexpectedly (code: ${code}); no automatic retry was attempted`;
}

function extractPartialOutput(events: EngineEvent[]): string | undefined {
  const deltas = events.filter((e) => e.type === "model.delta");
  if (deltas.length === 0) return undefined;
  return deltas.map((e) => (e as EngineEvent & { type: "model.delta" }).text).join("");
}
