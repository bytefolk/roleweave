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
  GroupTimeline,
  GroupTimelineItem,
  TurnEngine,
  TurnRecord,
} from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import { MAX_GROUP_MEMBERS, assertConversationRef } from "../groups/store.js";
import { assertPositionExists, executeTurn } from "./turns.js";

const MAX_INPUT_BYTES = 256 * 1024;

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

function parseGroupTurn(raw: unknown): { input: string; engine: TurnEngine; mentions: string[] } {
  if (!isRecord(raw) || !exactKeys(raw, ["input", "engine", "mentions"])) {
    throw new OrgApiError(
      errorCodes.group_request_invalid,
      400,
      "group turn accepts exactly input, engine, mentions",
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
  return { input: raw.input, engine: raw.engine as TurnEngine, mentions: raw.mentions as string[] };
}

export async function handleGroupCreate(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const members = parseCreate(await readJsonBody<unknown>(req));
  for (const member of members) assertPositionExists(ctx, member);
  const workspace = ctx.workspace.requireOpen();
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
  const positionId = parseAddMember(await readJsonBody<unknown>(req));
  assertPositionExists(ctx, positionId);
  const workspace = ctx.workspace.requireOpen();
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
 * same conversationRef. Spawns run sequentially in the background; every
 * progress/terminal event flows over the shared SSE channel tagged with
 * groupRef/turnId/positionId for renderer split-and-aggregate.
 */
export async function handleGroupTurnPost(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
  conversationRef: string,
): Promise<void> {
  const body = parseGroupTurn(await readJsonBody<unknown>(req));
  const ref = assertConversationRef(conversationRef);
  const workspace = ctx.workspace.requireOpen();
  const group = await ctx.groupStore.get(workspace.dir, ref);
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
  const message = await ctx.groupStore.appendMessage(workspace.dir, ref, {
    messageId: crypto.randomUUID(),
    input: body.input,
    mentions: body.mentions,
    createdAt: now,
  });
  const spawns = body.mentions.map((positionId) => ({
    turnId: crypto.randomUUID(),
    positionId,
  }));
  sendJson(res, 202, {
    conversationRef: ref,
    messageId: message.messageId,
    spawns,
  });
  void (async () => {
    for (const spawn of spawns) {
      const attribution = {
        groupRef: ref,
        messageId: message.messageId,
        turnId: spawn.turnId,
        positionId: spawn.positionId,
        engine: body.engine,
      };
      ctx.bus.publish("group.turn.spawned", attribution);
      try {
        await executeTurn(ctx, detachedResponse(), { ...body, positionId: spawn.positionId }, undefined, attribution);
      } catch {
        ctx.bus.publish("turn.indeterminate", {
          turnId: spawn.turnId,
          positionId: spawn.positionId,
          messageId: message.messageId,
          engine: body.engine,
          code: "group_spawn_failed",
          envelopeDigest: "",
          groupRef: ref,
          conversationRef: ref,
        });
      }
    }
  })();
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
  for (const member of group.members) {
    const history = await ctx.turnStore.history(workspace.dir, member, now);
    for (const turn of history.turns) {
      // #63: contract-level back-link first; legacy groupRef covers
      // pre-clearing records so the timeline never regresses.
      if (turn.conversationRef === ref || turn.groupRef === ref) memberTurns.push(turn);
    }
  }
  const messages = await ctx.groupStore.readMessages(workspace.dir, ref);
  const items: GroupTimelineItem[] = [
    ...messages.map((record) => ({ kind: "user" as const, ...record })),
    ...memberTurns.map((turn) => ({ kind: "member" as const, turn })),
  ];
  items.sort((left, right) =>
    (left.kind === "user" ? left.createdAt : left.turn.createdAt).localeCompare(
      right.kind === "user" ? right.createdAt : right.turn.createdAt,
      "en",
    ),
  );
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
