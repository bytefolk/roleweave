/**
 * S2 group-chat local store (#52, DS-34-001 rev-1 §1.2).
 *
 * Persistence layout (workspace-local, additive; never a wire contract):
 *   .digital-employee/workbench/groups/<conversationRef>/group.json
 *   .digital-employee/workbench/groups/<conversationRef>/messages/<messageId>.json
 *
 * Member turn records persist through the existing position conversation
 * store tagged with the additive TurnRecord.groupRef; this store owns the
 * roster, the bound session link (AC-004), and the user-message echo.
 *
 * 过渡债：conversationRef 为工作台侧本地 uuid；缺口① v1alpha2 契约级回链
 * 合入后切换并清账。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  GROUP_CONVERSATION_SCHEMA_VERSION,
  GROUP_LIST_SCHEMA_VERSION,
  GROUP_MESSAGE_SCHEMA_VERSION,
  OrgApiError,
  errorCodes,
  isPositionId,
  turnEngines,
} from "@roleweave/shared";
import type {
  GroupConversation,
  GroupConversationList,
  GroupMessage,
} from "@roleweave/shared";
import { assertSessionId } from "../sessions/store.js";
import { atomicWriteJson, nodeAtomicTurnWriteOperations, parseRfc3339Instant, compareRfc3339Instants, compareCodeUnitOrdinal } from "../turns/store.js";

const GROUPS_ROOT = path.join(".digital-employee", "workbench", "groups");
const MAX_GROUPS = 64;
export const MAX_GROUP_MEMBERS = 32;
const MAX_GROUP_MESSAGES = 256;
const MAX_GROUP_RECORD_BYTES = 16 * 1024;
export const MAX_GROUP_INPUT_BYTES = 256 * 1024;
// JSON can encode one input byte as six bytes (\u0000). The remaining
// budget covers 32 bounded member IDs, spawn IDs and acceptance metadata.
const MAX_GROUP_MESSAGE_BYTES = 6 * MAX_GROUP_INPUT_BYTES + 16 * 1024;
const REF_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type GroupContextMessage = Pick<GroupMessage, "messageId" | "mentions" | "spawns" | "createdAt">;

function storageError(message: string, cause?: unknown): OrgApiError {
  return new OrgApiError(
    errorCodes.group_storage_failed,
    500,
    message,
    false,
    cause === undefined ? undefined : { cause },
  );
}

export function assertConversationRef(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !REF_PATTERN.test(value)
  ) {
    throw new OrgApiError(
      errorCodes.group_request_invalid,
      400,
      "conversationRef must match [a-z0-9]+(?:-[a-z0-9]+)* and be at most 128 characters",
    );
  }
  return value;
}

function groupDir(workspace: string, conversationRef: string): string {
  return path.join(workspace, GROUPS_ROOT, assertConversationRef(conversationRef));
}

function groupFile(workspace: string, conversationRef: string): string {
  return path.join(groupDir(workspace, conversationRef), "group.json");
}

function isSafeMessageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}

function messageFile(workspace: string, conversationRef: string, messageId: string): string {
  assertConversationRef(conversationRef);
  if (!isSafeMessageId(messageId)) {
    throw storageError("local group message contains an unsafe messageId");
  }
  const messagesDir = path.resolve(groupDir(workspace, conversationRef), "messages");
  const file = path.resolve(messagesDir, `${messageId}.json`);
  if (path.dirname(file) !== messagesDir) {
    throw storageError("local group message path escapes its group");
  }
  return file;
}

async function readJson(file: string, maxBytes: number): Promise<unknown> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw storageError("local group state is not a bounded regular file");
  }
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}

async function prepareGroupDirectories(workspace: string, conversationRef: string): Promise<void> {
  assertConversationRef(conversationRef);
  const rootStat = await fs.lstat(workspace);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw storageError("workspace must be a real directory for local group state");
  }
  const segments = [".digital-employee", "workbench", "groups", conversationRef, "messages"];
  let current = workspace;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw storageError("local group state path must not contain symbolic links");
      }
    } catch (error) {
      if (error instanceof OrgApiError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      const created = await fs.lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw storageError("local group state directory creation raced with an unsafe path");
      }
    }
    if (index >= 1) await fs.chmod(current, 0o700);
  }
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort().join(",");
  return actual === [...keys].sort().join(",");
}

function isGroupConversation(value: unknown): value is GroupConversation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ["schemaVersion", "conversationRef", "sessionId", "members", "createdAt", "updatedAt"]) ||
    record.schemaVersion !== GROUP_CONVERSATION_SCHEMA_VERSION ||
    typeof record.conversationRef !== "string" ||
    typeof record.sessionId !== "string" ||
    !Array.isArray(record.members) ||
    parseRfc3339Instant(record.createdAt) === null ||
    parseRfc3339Instant(record.updatedAt) === null
  ) return false;
  if (record.members.length < 2 || record.members.length > MAX_GROUP_MEMBERS) return false;
  return record.members.every((member) => isPositionId(member));
}

function isGroupMessage(value: unknown): value is GroupMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const required = ["schemaVersion", "messageId", "conversationRef", "input", "mentions", "createdAt"];
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    Object.keys(record).every((key) => [...required, "mode", "spawns", "engine"].includes(key)) &&
    record.schemaVersion === GROUP_MESSAGE_SCHEMA_VERSION &&
    isSafeMessageId(record.messageId) &&
    typeof record.conversationRef === "string" &&
    typeof record.input === "string" && Buffer.byteLength(record.input, "utf8") <= MAX_GROUP_INPUT_BYTES &&
    Array.isArray(record.mentions) && record.mentions.length <= MAX_GROUP_MEMBERS &&
    new Set(record.mentions).size === record.mentions.length &&
    record.mentions.every((member) => isPositionId(member)) &&
    (record.mode === undefined || record.mode === "parallel" || record.mode === "relay") &&
    (record.engine === undefined || turnEngines.includes(record.engine as typeof turnEngines[number])) &&
    (record.spawns === undefined || (
      record.engine !== undefined &&
      Array.isArray(record.spawns) && record.spawns.length === record.mentions.length &&
      record.spawns.length <= MAX_GROUP_MEMBERS &&
      record.spawns.every((spawn, index) => spawn !== null && typeof spawn === "object" &&
        exactKeys(spawn, ["turnId", "positionId"]) &&
        typeof spawn.turnId === "string" && spawn.turnId.length <= 128 && REF_PATTERN.test(spawn.turnId) &&
        spawn.positionId === (record.mentions as string[])[index]) &&
      new Set(record.spawns.map((spawn) => spawn.turnId)).size === record.spawns.length
    )) &&
    parseRfc3339Instant(record.createdAt) !== null
  );
}

export class GroupStore {
  private readonly activeDispatches = new Set<string>();
  private readonly spawnRecoveryLocks = new Map<string, Promise<void>>();

  /** Serialize the complete check/create/finish operation across timeline
   * polls, releasing failed attempts so a later read can retry persistence. */
  async withSpawnRecovery<T>(workspace: string, positionId: string, turnId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${path.resolve(workspace)}\0${positionId}\0${turnId}`;
    const previous = this.spawnRecoveryLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => held);
    this.spawnRecoveryLocks.set(key, tail);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.spawnRecoveryLocks.get(key) === tail) this.spawnRecoveryLocks.delete(key);
    }
  }

  beginDispatch(workspace: string, conversationRef: string, messageId: string): () => void {
    const key = this.dispatchKey(workspace, conversationRef, messageId);
    this.activeDispatches.add(key);
    return () => { this.activeDispatches.delete(key); };
  }

  hasActiveDispatch(workspace: string, conversationRef: string, messageId: string): boolean {
    return this.activeDispatches.has(this.dispatchKey(workspace, conversationRef, messageId));
  }

  private dispatchKey(workspace: string, conversationRef: string, messageId: string): string {
    return `${path.resolve(workspace)}\0${conversationRef}\0${messageId}`;
  }

  async create(input: {
    workspace: string;
    sessionId: string;
    members: string[];
    now: string;
  }): Promise<GroupConversation> {
    const sessionId = assertSessionId(input.sessionId);
    for (const member of input.members) assertConversationSafeMember(member);
    const conversationRef = crypto.randomUUID();
    await this.assertGroupCapacity(input.workspace);
    await prepareGroupDirectories(input.workspace, conversationRef);
    const group: GroupConversation = {
      schemaVersion: GROUP_CONVERSATION_SCHEMA_VERSION,
      conversationRef,
      sessionId,
      members: input.members,
      createdAt: input.now,
      updatedAt: input.now,
    };
    try {
      await atomicWriteJson(
        groupFile(input.workspace, conversationRef),
        group,
        MAX_GROUP_RECORD_BYTES,
        nodeAtomicTurnWriteOperations,
        storageError,
      );
    } catch (error) {
      if (error instanceof OrgApiError) throw error;
      throw storageError("local group record could not be persisted atomically", error);
    }
    return group;
  }

  async get(workspace: string, conversationRef: string): Promise<GroupConversation> {
    const ref = assertConversationRef(conversationRef);
    const dir = groupDir(workspace, ref);
    let dirStat;
    try {
      dirStat = await fs.lstat(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new OrgApiError(errorCodes.group_missing, 404, `group not found: ${ref}`);
      }
      throw storageError("local group record is unreadable");
    }
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      throw storageError("local group state is not a real directory");
    }
    let raw: unknown;
    try {
      raw = await readJson(groupFile(workspace, ref), MAX_GROUP_RECORD_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new OrgApiError(errorCodes.group_missing, 404, `group not found: ${ref}`);
      }
      throw storageError("local group record is unreadable");
    }
    if (!isGroupConversation(raw) || raw.conversationRef !== ref) {
      throw storageError("local group record is invalid");
    }
    return raw;
  }

  async list(workspace: string): Promise<GroupConversationList> {
    const root = path.join(workspace, GROUPS_ROOT);
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: GROUP_LIST_SCHEMA_VERSION, groups: [] };
      }
      throw storageError("local group root is unreadable");
    }
    const groups: GroupConversation[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !REF_PATTERN.test(entry.name)) {
        throw storageError("local group root contains an unsafe entry");
      }
      groups.push(await this.get(workspace, entry.name));
    }
    groups.sort((left, right) => compareRfc3339Instants(right.updatedAt, left.updatedAt) ||
      compareCodeUnitOrdinal(left.conversationRef, right.conversationRef));
    return { schemaVersion: GROUP_LIST_SCHEMA_VERSION, groups };
  }

  async addMember(workspace: string, conversationRef: string, positionId: string, now: string): Promise<GroupConversation> {
    assertConversationRef(conversationRef);
    assertConversationSafeMember(positionId);
    await prepareGroupDirectories(workspace, conversationRef);
    const group = await this.get(workspace, conversationRef);
    if (group.members.includes(positionId)) {
      throw new OrgApiError(errorCodes.group_conflict, 409, `position already in group: ${positionId}`);
    }
    if (group.members.length >= MAX_GROUP_MEMBERS) {
      throw new OrgApiError(errorCodes.group_conflict, 409, "group reached the bounded member count");
    }
    const updated: GroupConversation = {
      ...group,
      members: [...group.members, positionId],
      updatedAt: now,
    };
    try {
      await atomicWriteJson(
        groupFile(workspace, conversationRef),
        updated,
        MAX_GROUP_RECORD_BYTES,
        nodeAtomicTurnWriteOperations,
        storageError,
      );
    } catch (error) {
      if (error instanceof OrgApiError) throw error;
      throw storageError("local group record could not be persisted atomically", error);
    }
    return updated;
  }

  async appendMessage(workspace: string, conversationRef: string, message: Omit<GroupMessage, "schemaVersion" | "conversationRef">): Promise<GroupMessage> {
    assertConversationRef(conversationRef);
    await prepareGroupDirectories(workspace, conversationRef);
    await this.assertMessageCapacity(workspace, conversationRef);
    const record: GroupMessage = {
      schemaVersion: GROUP_MESSAGE_SCHEMA_VERSION,
      conversationRef,
      ...message,
    };
    if (!isGroupMessage(record)) throw storageError("local group message is invalid");
    try {
      await atomicWriteJson(
        messageFile(workspace, conversationRef, record.messageId),
        record,
        MAX_GROUP_MESSAGE_BYTES,
        nodeAtomicTurnWriteOperations,
        storageError,
      );
    } catch (error) {
      if (error instanceof OrgApiError) throw error;
      throw storageError("local group message could not be persisted atomically", error);
    }
    return record;
  }

  async readMessages(workspace: string, conversationRef: string): Promise<GroupMessage[]> {
    return this.readMessageRecords(workspace, conversationRef, (message) => message);
  }

  /** Context readers need accepted identities, not a second copy of every
   * original input per parallel employee. Validate one full record, then
   * immediately retain only its lightweight references before the next read. */
  async readContextMessages(workspace: string, conversationRef: string): Promise<GroupContextMessage[]> {
    return this.readMessageRecords(workspace, conversationRef, (message) => ({
      messageId: message.messageId,
      mentions: message.mentions,
      ...(message.spawns !== undefined ? { spawns: message.spawns } : {}),
      createdAt: message.createdAt,
    }));
  }

  private async readMessageRecords<T extends Pick<GroupMessage, "messageId" | "createdAt">>(
    workspace: string,
    conversationRef: string,
    project: (message: GroupMessage) => T,
  ): Promise<T[]> {
    assertConversationRef(conversationRef);
    const messagesDir = path.join(groupDir(workspace, conversationRef), "messages");
    let names: string[];
    try {
      names = (await fs.readdir(messagesDir)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw storageError("local group messages are unreadable");
    }
    if (names.length > MAX_GROUP_MESSAGES) throw storageError("local group messages exceed the bounded record count");
    const messages: T[] = [];
    for (const name of names) {
      const raw = await readJson(path.join(messagesDir, name), MAX_GROUP_MESSAGE_BYTES);
      if (!isGroupMessage(raw) || raw.conversationRef !== conversationRef ||
          messageFile(workspace, conversationRef, raw.messageId) !== path.resolve(messagesDir, name)) {
        throw storageError("local group messages contain an invalid record");
      }
      messages.push(project(raw));
    }
    messages.sort((left, right) => compareRfc3339Instants(left.createdAt, right.createdAt) ||
      compareCodeUnitOrdinal(left.messageId, right.messageId));
    return messages;
  }

  private async assertGroupCapacity(workspace: string): Promise<void> {
    const root = path.join(workspace, GROUPS_ROOT);
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw storageError("local group root is unreadable");
    }
    if (entries.filter((entry) => entry.isDirectory()).length >= MAX_GROUPS) {
      throw storageError("local group count reached the bounded limit");
    }
  }

  private async assertMessageCapacity(workspace: string, conversationRef: string): Promise<void> {
    const messagesDir = path.join(groupDir(workspace, conversationRef), "messages");
    let names: string[];
    try {
      names = (await fs.readdir(messagesDir)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw storageError("local group messages are unreadable");
    }
    if (names.length >= MAX_GROUP_MESSAGES) {
      throw storageError("local group messages reached the bounded record count");
    }
  }
}

function assertConversationSafeMember(positionId: string): void {
  if (!isPositionId(positionId)) {
    throw new OrgApiError(
      errorCodes.group_request_invalid,
      400,
      `group member must be a valid positionId: ${positionId}`,
    );
  }
}
