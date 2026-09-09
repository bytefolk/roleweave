// S2 group-chat IPC validators (#52, DS-34-001 rev-1 §1.2). Main-process
// fail-closed boundary mirroring the route shapes in routes/groups.ts.
const { isPositionId } = require("@roleweave/shared/position-id");

const CONVERSATION_REF = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const { TURN_ENGINE_IDS, turnEngineMessage } = require("@roleweave/shared/turn-engines");
const TURN_ENGINES = new Set(TURN_ENGINE_IDS);
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_GROUP_MEMBERS = 32;

function invalid(code, message) {
  return { status: 400, body: { code, message, retryable: false } };
}

function validateConversationRef(conversationRef) {
  return (
    typeof conversationRef === "string" &&
    conversationRef.length > 0 &&
    conversationRef.length <= 128 &&
    CONVERSATION_REF.test(conversationRef)
  );
}

function validateGroupCreateRequest(value) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "memberPositionIds" ||
    !Array.isArray(value.memberPositionIds)
  ) {
    return { ok: false, response: invalid("group_request_invalid", "group create accepts exactly memberPositionIds") };
  }
  const members = value.memberPositionIds;
  if (
    members.length < 2 || members.length > MAX_GROUP_MEMBERS ||
    members.some((member) => !isPositionId(member)) ||
    new Set(members).size !== members.length
  ) {
    return {
      ok: false,
      response: invalid("group_request_invalid", `memberPositionIds must be 2-${MAX_GROUP_MEMBERS} unique valid positionIds`),
    };
  }
  return { ok: true, request: { memberPositionIds: members } };
}

function validateGroupAddMemberRequest(value) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "conversationRef,positionId" ||
    !validateConversationRef(value.conversationRef) || !isPositionId(value.positionId)
  ) {
    return {
      ok: false,
      response: invalid("group_request_invalid", "group member add accepts exactly a valid conversationRef and positionId"),
    };
  }
  return { ok: true, conversationRef: value.conversationRef, request: { positionId: value.positionId } };
}

function validateGroupTurnRequest(value) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    !["conversationRef,engine,input,mentions", "conversationRef,engine,input,mentions,mode"].includes(Object.keys(value).sort().join(","))
  ) {
    return { ok: false, response: invalid("group_request_invalid", "group turn accepts conversationRef, input, engine, mentions and optional mode") };
  }
  if (value.mode !== undefined && value.mode !== "parallel" && value.mode !== "relay") {
    return { ok: false, response: invalid("group_request_invalid", "mode must be parallel or relay") };
  }
  if (!validateConversationRef(value.conversationRef)) {
    return { ok: false, response: invalid("group_request_invalid", "conversationRef is invalid") };
  }
  if (typeof value.input !== "string" || value.input.trim().length === 0 ||
      Buffer.byteLength(value.input, "utf8") > MAX_INPUT_BYTES) {
    return { ok: false, response: invalid("group_request_invalid", "input must be non-empty and no larger than 256 KiB") };
  }
  if (typeof value.engine !== "string" || !TURN_ENGINES.has(value.engine)) {
    return { ok: false, response: invalid("turn_engine_unsupported", `engine must be ${turnEngineMessage()}`) };
  }
  if (
    !Array.isArray(value.mentions) || value.mentions.length === 0 ||
    value.mentions.some((mention) => !isPositionId(mention)) ||
    new Set(value.mentions).size !== value.mentions.length
  ) {
    return {
      ok: false,
      response: invalid("group_request_invalid", "mentions must be a non-empty unique positionId list; broadcast is not allowed"),
    };
  }
  return {
    ok: true,
    conversationRef: value.conversationRef,
    request: { input: value.input, engine: value.engine, mentions: value.mentions, ...(value.mode !== undefined ? { mode: value.mode } : {}) },
  };
}

function groupPath(conversationRef, suffix = "") {
  return validateConversationRef(conversationRef) ? `/groups/${encodeURIComponent(conversationRef)}${suffix}` : null;
}

module.exports = {
  groupPath,
  validateConversationRef,
  validateGroupCreateRequest,
  validateGroupAddMemberRequest,
  validateGroupTurnRequest,
};
