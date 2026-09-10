/**
 * S2 group-chat routes (#52, DS-34-001 rev-1 §1.2). Additive v0 surface:
 * a group binds one #14 session plus a member roster (local conversationRef
 * transition mapping), and @mention explicit routing spawns one
 * turn-envelope.v1 per mentioned member — never a broadcast.
 */
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  GROUP_TIMELINE_SCHEMA_VERSION,
  OrgApiError,
  errorCodes,
  turnEngines,
} from "@roleweave/shared";
import type {
  GroupExecutionMode,
  GroupMessage,
  GroupTimeline,
  GroupTimelineItem,
  TurnEngine,
  TurnRecord,
} from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import { MAX_GROUP_MEMBERS, MAX_GROUP_INPUT_BYTES, assertConversationRef } from "../groups/store.js";
import { assertPositionExists, assertTurnWorkspace, executeTurn, type GroupEventAttribution } from "./turns.js";
import { createTurnEnvelope } from "../turns/envelope.js";
import { compactThreadContextHandoff, type SupplementalContext } from "../turns/thread-context.js";
import { compareRfc3339Instants, compareCodeUnitOrdinal } from "../turns/store.js";

const MAX_INPUT_BYTES = MAX_GROUP_INPUT_BYTES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function parseCreate(raw: unknown): string[] {
  if (
    !isRecord(raw) ||
    !exactKeys(raw, ["memberPositionIds"]) ||
    !Array.isArray(raw.memberPositionIds)
  ) {
    throw new OrgApiError(
      errorCodes.group_request_invalid,
      400,
      "group create accepts exactly memberPositionIds",
    );
  }
  const members = raw.memberPositionIds;
  if (
    members.length < 2 || members.length > MAX_GROUP_MEMBERS ||
    members.some((member) => typeof member !== "string") ||
    new Set(members).size !== members.length
  ) {
    throw new OrgApiError(
      errorCodes.group_request_invalid,
      400,
      `memberPositionIds must be 2-${MAX_GROUP_MEMBERS} unique positionIds`,
    );
  }
  return members as string[];
}

function parseAddMember(raw: unknown): string {
  if (!isRecord(raw) || !exactKeys(raw, ["positionId"]) || typeof raw.positionId !== "string") {
    throw new OrgApiError(
      errorCodes.group_request_invalid,
      400,
      "group member add accepts exactly positionId",
    );
  }
  return raw.positionId;
}

function parseGroupTurn(raw: unknown): { input: string; engine: TurnEngine; mentions: string[]; mode: GroupExecutionMode } {
  if (!isRecord(raw) || (!exactKeys(raw, ["input", "engine", "mentions"]) && !exactKeys(raw, ["input", "engine", "mentions", "mode"]))) {
    throw new OrgApiError(
      errorCodes.group_request_invalid,
      400,
      "group turn accepts input, engine, mentions, and optional mode",
    );
  }
  if (
    typeof raw.input !== "string" || raw.input.trim().length === 0 ||
    Buffer.byteLength(raw.input, "utf8") > MAX_INPUT_BYTES
  ) {
    throw new OrgApiError(
      errorCodes.group_request_invalid,
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
  if (
    !Array.isArray(raw.mentions) || raw.mentions.length === 0 ||
    raw.mentions.some((mention) => typeof mention !== "string") ||
    new Set(raw.mentions).size !== raw.mentions.length
  ) {
    throw new OrgApiError(
      errorCodes.group_request_invalid,
      400,
      "mentions must be a non-empty unique positionId list; broadcast is not allowed",
    );
  }
  if (raw.mode !== undefined && raw.mode !== "parallel" && raw.mode !== "relay") {
    throw new OrgApiError(errorCodes.group_request_invalid, 400, "mode must be parallel or relay");
  }
  return { input: raw.input, engine: raw.engine as TurnEngine, mentions: raw.mentions as string[], mode: raw.mode ?? "parallel" };
}

export async function handleGroupCreate(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const members = parseCreate(await readJsonBody<unknown>(req));
  assertTurnWorkspace(ctx, workspace);
  for (const member of members) assertPositionExists(ctx, member);
  const now = new Date().toISOString();
  // AC-004 dual-form recall: a group conversation is a real #14 session,
  // anchored on the first member's position lifecycle. #116: when that member
  // already has an active session — the common case after a personal turn —
  // the group adopts it instead of failing with 409 session_conflict.
  const session = await ctx.sessionStore.reuseOrCreateActive(workspace.dir, members[0]!);
  const group = await ctx.groupStore.create({
    workspace: workspace.dir,
    sessionId: session.sessionId,
    members,
    now,
  });
  sendJson(res, 201, group);
}

export async function handleGroupList(
  ctx: ControlPlaneContext,
  res: ServerResponse,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  sendJson(res, 200, await ctx.groupStore.list(workspace.dir));
}

export async function handleGroupGet(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  conversationRef: string,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  sendJson(res, 200, await ctx.groupStore.get(workspace.dir, assertConversationRef(conversationRef)));
}

export async function handleGroupAddMember(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
  conversationRef: string,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const positionId = parseAddMember(await readJsonBody<unknown>(req));
  assertTurnWorkspace(ctx, workspace);
  assertPositionExists(ctx, positionId);
  const updated = await ctx.groupStore.addMember(
    workspace.dir,
    assertConversationRef(conversationRef),
    positionId,
    new Date().toISOString(),
  );
  sendJson(res, 200, updated);
}

/**
 * @mention explicit routing: persist the user message, answer 202 with the
 * spawn list, then spawn one turn-envelope.v1 per mentioned member under the
 * same conversationRef. Parallel is the default; relay follows mention order
 * and passes only completed predecessor results to the next employee. Every
 * progress/terminal event flows over the shared SSE channel tagged with
 * groupRef/turnId/positionId for renderer split-and-aggregate.
 */
export async function handleGroupTurnPost(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
  conversationRef: string,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const body = parseGroupTurn(await readJsonBody<unknown>(req));
  assertTurnWorkspace(ctx, workspace);
  const ref = assertConversationRef(conversationRef);
  const group = await ctx.groupStore.get(workspace.dir, ref);
  assertTurnWorkspace(ctx, workspace);
  for (const mention of body.mentions) {
    if (!group.members.includes(mention)) {
      throw new OrgApiError(
        errorCodes.group_request_invalid,
        400,
        `mention is not a group member: ${mention}`,
      );
    }
    assertPositionExists(ctx, mention);
  }
  const now = new Date().toISOString();
  const spawns = body.mentions.map((positionId) => ({
    turnId: crypto.randomUUID(),
    positionId,
  }));
  const messageId = crypto.randomUUID();
  // Claim recovery ownership before the acceptance file can become visible.
  // Atomic rename precedes fsync/close and promise completion.
  const releaseDispatch = ctx.groupStore.beginDispatch(workspace.dir, ref, messageId);
  let message: GroupMessage;
  try {
    message = await ctx.groupStore.appendMessage(workspace.dir, ref, {
      messageId,
      input: body.input,
      mentions: body.mentions,
      mode: body.mode,
      spawns,
      engine: body.engine,
      createdAt: now,
    });
    sendJson(res, 202, { conversationRef: ref, messageId, spawns, mode: body.mode });
  } catch (error) {
    releaseDispatch();
    throw error;
  }
  void (async () => {
    const handoffs: SupplementalContext[] = [];
    const run = async (spawn: typeof spawns[number]): Promise<TurnRecord | null> => {
      const attribution = {
        groupRef: ref,
        messageId: message.messageId,
        turnId: spawn.turnId,
        positionId: spawn.positionId,
        engine: body.engine,
      };
      ctx.bus.publish("group.turn.spawned", { ...attribution, workspacePath: workspace.dir });
      try {
        // A relay may outlive workspace navigation. Never dispatch a delayed
        // step into whichever project happens to be open later.
        if (ctx.workspace.active !== workspace) {
          return await persistUnexecutedTurn(ctx, workspace.dir, body.input, attribution, "group_workspace_changed", message.createdAt);
        }
        return await executeTurn(ctx, detachedResponse(), { ...body, positionId: spawn.positionId }, undefined, attribution, handoffs, workspace);
      } catch (error) {
        return await persistUnexecutedTurn(ctx, workspace.dir, body.input, attribution,
          error instanceof OrgApiError && error.code === errorCodes.session_conflict ? "group_employee_busy" : "group_spawn_failed", message.createdAt);
      }
    };
    if (body.mode === "parallel") {
      // Every promise starts before we await any terminal result. One failed
      // employee must not prevent an independent employee from starting.
      await Promise.allSettled(spawns.map(run));
      return;
    }
    let blocked = false;
    for (const spawn of spawns) {
      if (blocked) {
        await persistUnexecutedTurn(ctx, workspace.dir, body.input, {
          groupRef: ref, messageId: message.messageId, turnId: spawn.turnId,
          positionId: spawn.positionId, engine: body.engine,
        }, "group_relay_blocked", message.createdAt);
        continue;
      }
      const record = await run(spawn);
      if (record?.status !== "completed") blocked = true;
      else handoffs.push(compactThreadContextHandoff({ label: `Completed relay step: ${spawn.positionId}`, input: body.input, output: record.output }));
    }
  })().catch(async () => {
    // Contain unexpected orchestration errors after accepted tasks settle.
    // Existing terminal records remain authoritative; no engine is replayed.
    for (const spawn of spawns) {
      await persistUnexecutedTurn(ctx, workspace.dir, body.input, {
        groupRef: ref, messageId: message.messageId, ...spawn, engine: body.engine,
      }, "group_spawn_failed", message.createdAt);
    }
  }).finally(releaseDispatch);
}

/** No engine events are invented for steps that never ran. Persist the exact
 * spawn as indeterminate so the timeline converges even when SSE is missed. */
async function persistUnexecutedTurn(
  ctx: ControlPlaneContext,
  workspace: string,
  input: string,
  attribution: GroupEventAttribution,
  code: "group_relay_blocked" | "group_spawn_failed" | "group_workspace_changed" | "group_employee_busy" | "group_dispatch_interrupted",
  createdAt: string,
): Promise<TurnRecord | null> {
  return ctx.groupStore.withSpawnRecovery(workspace, attribution.positionId, attribution.turnId, async () => {
    let record: TurnRecord | null = null;
    try {
      const now = new Date().toISOString();
      const existing = await ctx.turnStore.readPositionTurn(workspace, attribution.positionId, attribution.turnId, now, { recoverInterrupted: false });
      if (existing !== null && existing.status !== "running") return existing;
      const envelope = createTurnEnvelope({
        workspaceRef: workspace, positionId: attribution.positionId, turnId: attribution.turnId,
        message: input, conversationRef: attribution.groupRef,
      });
      const running = existing ?? await ctx.turnStore.begin({
        workspace, positionId: attribution.positionId, turnId: attribution.turnId,
        engine: attribution.engine, message: input, envelopeDigest: envelope.envelopeDigest,
        now: createdAt, groupRef: attribution.groupRef, conversationRef: attribution.groupRef,
      });
      record = {
        ...running, status: "indeterminate",
        updatedAt: compareRfc3339Instants(now, running.updatedAt) < 0 ? running.updatedAt : now,
        error: {
          code, retryable: false,
          message: code === "group_relay_blocked"
            ? "This step did not run because an earlier relay step did not complete successfully."
            : code === "group_workspace_changed"
              ? "This step did not run because the open workspace changed."
              : code === "group_employee_busy"
                ? "This step did not run because this employee already has a turn in progress."
                : code === "group_dispatch_interrupted"
                  ? "This accepted group step did not start before the control plane stopped; no automatic retry was attempted."
                  : "This group step could not start or its terminal result could not be persisted; no automatic retry was attempted.",
        },
      };
      await ctx.turnStore.finish(workspace, record);
    } catch {
      // A storage failure cannot be made durable; preserve a scoped live error
      // without pretending an engine ran or a terminal record was saved.
      record = null;
    }
    ctx.bus.publish("turn.indeterminate", {
      ...attribution, workspacePath: workspace, conversationRef: attribution.groupRef,
      code, envelopeDigest: record?.envelopeDigest ?? "",
    });
    return record;
  });
}

export async function handleGroupTimeline(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  conversationRef: string,
): Promise<void> {
  const ref = assertConversationRef(conversationRef);
  const workspace = ctx.workspace.requireOpen();
  const group = await ctx.groupStore.get(workspace.dir, ref);
  const now = new Date().toISOString();
  const memberTurns: TurnRecord[] = [];
  const messages = await ctx.groupStore.readMessages(workspace.dir, ref);
  const persistedTurnIds = new Set<string>();
  const unreadableTurnIds = new Set<string>();
  const belongs = (turn: TurnRecord): boolean => turn.conversationRef === ref ||
    (turn.conversationRef === undefined && turn.groupRef === ref);
  const appendTurn = (turn: TurnRecord): void => {
    if (belongs(turn) && !persistedTurnIds.has(turn.turnId)) {
      memberTurns.push(turn);
      persistedTurnIds.add(turn.turnId);
    }
  };
  for (const message of messages) {
    for (const spawn of message.spawns ?? []) {
      if (!group.members.includes(spawn.positionId) || persistedTurnIds.has(spawn.turnId) || unreadableTurnIds.has(spawn.turnId)) continue;
      try {
        const turn = await ctx.turnStore.readPositionTurn(workspace.dir, spawn.positionId, spawn.turnId, now);
        if (turn !== null) appendTurn(turn);
      } catch (error) {
        if (!(error instanceof OrgApiError) || error.code !== errorCodes.turn_storage_failed) throw error;
        // Keep the corrupt file untouched and show healthy accepted steps.
        // Its absence is never represented as a successful terminal.
        unreadableTurnIds.add(spawn.turnId);
      }
    }
  }
  // Some pre-clearing groupRef records predate durable message echoes as
  // well as spawn identities. Discover those records per member, while a
  // damaged legacy source cannot hide already-read healthy indexed turns.
  for (const member of group.members) {
    try {
      const history = await ctx.turnStore.history(workspace.dir, member, now);
      for (const turn of history.turns) {
        if (turn.conversationRef === undefined && turn.groupRef === ref) appendTurn(turn);
      }
    } catch (error) {
      if (!(error instanceof OrgApiError) || error.code !== errorCodes.turn_storage_failed) throw error;
    }
  }
  for (const message of messages) {
    if (ctx.groupStore.hasActiveDispatch(workspace.dir, ref, message.messageId)) continue;
    for (const spawn of message.spawns ?? []) {
      if (persistedTurnIds.has(spawn.turnId) || unreadableTurnIds.has(spawn.turnId)) continue;
      // No in-process dispatch owns this durable acceptance: the previous
      // control plane stopped before it could start this step. Never replay.
      const interrupted = await persistUnexecutedTurn(ctx, workspace.dir, message.input, {
        ...spawn, groupRef: ref, messageId: message.messageId,
        engine: message.engine ?? "qoder",
      }, "group_dispatch_interrupted", message.createdAt);
      if (interrupted !== null) appendTurn(interrupted);
    }
  }
  const items: GroupTimelineItem[] = [
    ...messages.map((record) => ({ kind: "user" as const, ...record })),
    ...memberTurns.map((turn) => ({ kind: "member" as const, turn })),
  ];
  items.sort((left, right) => {
    const time = compareRfc3339Instants(left.kind === "user" ? left.createdAt : left.turn.createdAt,
      right.kind === "user" ? right.createdAt : right.turn.createdAt);
    if (time !== 0) return time;
    // Acceptance precedes its recovered member steps at the same instant.
    if (left.kind !== right.kind) return left.kind === "user" ? -1 : 1;
    return compareCodeUnitOrdinal(left.kind === "user" ? left.messageId : left.turn.turnId,
      right.kind === "user" ? right.messageId : right.turn.turnId);
  });
  const timeline: GroupTimeline = {
    schemaVersion: GROUP_TIMELINE_SCHEMA_VERSION,
    conversationRef: ref,
    items,
  };
  sendJson(res, 200, timeline);
}

/** A response sink for background spawns: the 202 already answered the
 * caller; the settled turn record rides the SSE channel + timeline. */
function detachedResponse(): ServerResponse {
  const sink = {
    statusCode: 200,
    headersSent: false,
    setHeader() {},
    writeHead() { return sink; },
    write() { return true; },
    end() { return sink; },
    on() { return sink; },
    once() { return sink; },
    removeListener() { return sink; },
  };
  return sink as unknown as ServerResponse;
}
