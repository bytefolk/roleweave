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
} from "@roleweave/shared";
import type {
  GroupConversation,
  GroupConversationList,
  GroupMessage,
} from "@roleweave/shared";
import { assertSessionId } from "../sessions/store.js";
import { atomicWriteJson, nodeAtomicTurnWriteOperations } from "../turns/store.js";

const GROUPS_ROOT = path.join(".digital-employee", "workbench", "groups");
const MAX_GROUPS = 64;
export const MAX_GROUP_MEMBERS = 32;
const MAX_GROUP_MESSAGES = 256;
const MAX_GROUP_RECORD_BYTES = 16 * 1024;
const MAX_GROUP_MESSAGE_BYTES = 260 * 1024;
const REF_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function storageError(message: string): OrgApiError {
  return new OrgApiError(errorCodes.group_storage_failed, 500, message);
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

function messageFile(workspace: string, conversationRef: string, messageId: string): string {
  assertConversationRef(conversationRef);
  if (!messageId || messageId.length > 256 || messageId.includes("/") || messageId.includes("\\") || messageId.includes("\0")) {
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
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) return false;
  if (record.members.length < 2 || record.members.length > MAX_GROUP_MEMBERS) return false;
  return record.members.every((member) => isPositionId(member));
}

function isGroupMessage(value: unknown): value is GroupMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    exactKeys(record, ["schemaVersion", "messageId", "conversationRef", "input", "mentions", "createdAt"]) &&
    record.schemaVersion === GROUP_MESSAGE_SCHEMA_VERSION &&
    typeof record.messageId === "string" &&
    typeof record.conversationRef === "string" &&
    typeof record.input === "string" &&
    Array.isArray(record.mentions) &&
    record.mentions.every((member) => isPositionId(member)) &&
    typeof record.createdAt === "string"
  );
}

export class GroupStore {
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
      throw storageError("local group record could not be persisted atomically");
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
    groups.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt, "en"));
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
      throw storageError("local group record could not be persisted atomically");
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
      throw storageError("local group message could not be persisted atomically");
    }
    return record;
  }

  async readMessages(workspace: string, conversationRef: string): Promise<GroupMessage[]> {
    assertConversationRef(conversationRef);
    const messagesDir = path.join(groupDir(workspace, conversationRef), "messages");
    let names: string[];
    try {
      names = (await fs.readdir(messagesDir)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw storageError("local group messages are unreadable");
    }
    const messages: GroupMessage[] = [];
    for (const name of names) {
      const raw = await readJson(path.join(messagesDir, name), MAX_GROUP_MESSAGE_BYTES);
      if (!isGroupMessage(raw) || raw.conversationRef !== conversationRef) {
        throw storageError("local group messages contain an invalid record");
      }
      messages.push(raw);
    }
    messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt, "en"));
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
