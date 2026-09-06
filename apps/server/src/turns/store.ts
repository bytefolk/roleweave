import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  OrgApiError,
  TURN_HISTORY_SCHEMA_VERSION,
  TURN_RECORD_SCHEMA_VERSION,
  errorCodes,
  isPositionId,
} from "@roleweave/shared";
import type { TurnEngine, TurnHistory, TurnRecord, WorkbenchSession } from "@roleweave/shared";
import type { EngineEvent, TurnTerminalReason } from "@roleweave/shared";
import { assertSessionId, readAuthoritativeSessionIndex } from "../sessions/store.js";
import { StableReadError, decodeStableUtf8, readStableBoundedFile } from "../stable-read.js";

const STATE_ROOT = path.join(".digital-employee", "workbench", "conversations");
const SESSION_CONVERSATIONS_ROOT = path.join(
  ".digital-employee",
  "workbench",
  "sessions",
  "conversations",
);
const MAX_TURNS_PER_POSITION = 256;
const MAX_REPORT_CONVERSATIONS = 1024;
const MAX_REPORT_RECORDS = MAX_REPORT_CONVERSATIONS * MAX_TURNS_PER_POSITION;
const MAX_TURN_TEMP_FILES = MAX_TURNS_PER_POSITION;
const MAX_TURN_DIRECTORY_ENTRIES = MAX_TURNS_PER_POSITION + MAX_TURN_TEMP_FILES;
const MAX_TURN_ID_LENGTH = 256;
// A one-megachar engine result is represented in model.delta, the terminal,
// and the record's output field. Keep that upstream boundary persistable
// while retaining a finite aggregate history bound.
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const MAX_TURN_RECORD_BYTES = 20 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_EVENTS = 4_096;
const MAX_MODEL_CHARACTERS = 1_048_576;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES = MAX_MODEL_CHARACTERS * 6 + 2;
const ENGINE_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ENVELOPE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RFC3339_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const TERMINAL_REASONS = new Set<TurnTerminalReason>([
  "goal_met",
  "invalid_output_exhausted",
  "turn_budget_exceeded",
  "position_budget_exceeded",
  "iteration_cap",
  "doom_loop",
  "deadline_exceeded",
  "cancelled",
  "engine_internal_error",
]);
// Additive #25 Slice B: the approval.* read bounds mirror driver-cli.ts
// (upstream #187 MAX_ID_LENGTH / APPROVAL_DESCRIPTION_MAX_BYTES /
// APPROVAL_TARGET_MAX_BYTES) so every event the driver accepts persists
// and reads back intact.
const APPROVAL_ID_MAX_LENGTH = 256;
const APPROVAL_ACTION_KINDS = new Set(["exec", "write", "network", "tool"]);
const APPROVAL_DESCRIPTION_MAX_BYTES = 1024;
const APPROVAL_TARGET_MAX_BYTES = 512;

interface ConversationMetadata {
  schemaVersion: "conversation.v1";
  conversationId: string;
  positionId: string;
  createdAt: string;
}

function storageError(message: string): OrgApiError {
  return new OrgApiError(errorCodes.turn_storage_failed, 500, message);
}

export function assertPositionId(value: unknown): string {
  if (!isPositionId(value)) {
    throw new OrgApiError(
      errorCodes.turn_position_invalid,
      400,
      "positionId must match [a-z0-9]+(?:-[a-z0-9]+)* and be at most 64 characters",
    );
  }
  return value;
}

function isBoundedTurnId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_TURN_ID_LENGTH
  );
}

function isAtomicTurnTemporaryName(name: string): boolean {
  if (!name.startsWith(".") || !name.endsWith(".tmp")) return false;
  const stem = name.slice(1, -4);
  if (stem.length <= 37 || stem.at(-37) !== ".") return false;
  const nonce = stem.slice(-36);
  try {
    assertSessionId(nonce);
  } catch {
    return false;
  }
  const target = stem.slice(0, -37);
  if (!target.endsWith(".json")) return false;
  const turnId = target.slice(0, -5);
  return isBoundedTurnId(turnId) && !turnId.includes("/") &&
    !turnId.includes("\\") && !turnId.includes("\0");
}

function turnRecordFile(workspace: string, positionId: string, turnId: unknown): string {
  if (
    !isBoundedTurnId(turnId) ||
    turnId.includes("/") ||
    turnId.includes("\\") ||
    turnId.includes("\0")
  ) {
    throw storageError("local turn record contains an unsafe turnId");
  }
  const turnsDir = path.resolve(conversationDir(workspace, positionId), "turns");
  const file = path.resolve(turnsDir, `${turnId}.json`);
  if (path.dirname(file) !== turnsDir) {
    throw storageError("local turn record path escapes its conversation");
  }
  return file;
}

export interface AtomicTurnTemporaryHandle {
  writeFile(payload: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicTurnDirectoryHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicTurnWriteOperations {
  openTemporary(file: string): Promise<AtomicTurnTemporaryHandle>;
  rename(source: string, target: string): Promise<void>;
  chmod(file: string, mode: number): Promise<void>;
  openDirectory(directory: string): Promise<AtomicTurnDirectoryHandle>;
  removeTemporary(file: string): Promise<void>;
}

export const nodeAtomicTurnWriteOperations: AtomicTurnWriteOperations = {
  async openTemporary(file) {
    const handle = await fs.open(file, "wx", 0o600);
    return {
      writeFile: (payload) => handle.writeFile(payload, "utf8"),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  rename: (source, target) => fs.rename(source, target),
  chmod: (file, mode) => fs.chmod(file, mode),
  async openDirectory(directory) {
    const handle = await fs.open(directory, "r");
    return {
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  removeTemporary: (file) => fs.rm(file, { force: true }),
};

export async function atomicWriteJson(
  file: string,
  value: unknown,
  maxBytes: number,
  operations: AtomicTurnWriteOperations,
  makeStorageError: (message: string) => OrgApiError,
): Promise<void> {
  const dir = path.dirname(file);
  const payload = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(payload, "utf8") > maxBytes) {
    throw makeStorageError("local state record exceeds its bounded size");
  }
  const temporary = path.join(dir, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let fileHandle: AtomicTurnTemporaryHandle | undefined;
  let directoryHandle: AtomicTurnDirectoryHandle | undefined;
  try {
    fileHandle = await operations.openTemporary(temporary);
    await fileHandle.writeFile(payload);
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    await operations.rename(temporary, file);
    await operations.chmod(file, 0o600);
    directoryHandle = await operations.openDirectory(dir);
    try {
      try {
        await directoryHandle.sync();
      } catch (error) {
        // Windows/NTFS rejects fsync on directory handles with EPERM. On win32
        // the rename() above has already committed the data atomically, so the
        // record is durable and the EPERM is a false negative.
        //
        // Reduced durability guarantee (AC-004): swallowing the directory sync
        // means the rename directory entry may not survive a subsequent power
        // loss on Windows — POSIX callers lose the "renamed AND fsync-durable"
        // guarantee. On POSIX, EPERM indicates a real failure and propagates.
        if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") {
          throw error;
        }
      }
    } finally {
      await directoryHandle.close();
    }
    directoryHandle = undefined;
  } catch (error) {
    try {
      await fileHandle?.close();
    } catch {
      // Preserve the first durability failure while still attempting cleanup.
    }
    try {
      await directoryHandle?.close();
    } catch {
      // Preserve the first durability failure while still attempting cleanup.
    }
    try {
      await operations.removeTemporary(temporary);
    } catch {
      // The original write failure is authoritative and never includes payload data.
    }
    throw error;
  }
}

function conversationDir(workspace: string, positionId: string): string {
  return path.join(workspace, STATE_ROOT, positionId);
}

function sessionConversationDir(workspace: string, sessionId: string): string {
  return path.join(
    workspace,
    ".digital-employee",
    "workbench",
    "sessions",
    "conversations",
    assertSessionId(sessionId),
  );
}

function sessionTurnRecordFile(workspace: string, sessionId: string, turnId: unknown): string {
  if (
    !isBoundedTurnId(turnId) ||
    turnId.includes("/") ||
    turnId.includes("\\") ||
    turnId.includes("\0")
  ) {
    throw storageError("local session turn record contains an unsafe turnId");
  }
  const turnsDir = path.resolve(sessionConversationDir(workspace, sessionId), "turns");
  const file = path.resolve(turnsDir, `${turnId}.json`);
  if (path.dirname(file) !== turnsDir) {
    throw storageError("local session turn record path escapes its conversation");
  }
  return file;
}

interface BoundedJsonRead {
  value: unknown;
  bytes: number;
}

async function readBoundedStateFile(file: string, maxBytes: number) {
  try {
    return await readStableBoundedFile(file, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    if (error instanceof StableReadError) {
      throw storageError("local state record is not a stable bounded regular file");
    }
    throw storageError("local state record is unreadable");
  }
}

async function readJson(file: string, maxBytes: number): Promise<BoundedJsonRead> {
  const stable = await readBoundedStateFile(file, maxBytes);
  try {
    return { value: JSON.parse(decodeStableUtf8(stable.buffer)) as unknown, bytes: stable.bytes };
  } catch {
    throw storageError("local state record is not valid JSON");
  }
}

async function preparePositionDirectories(workspace: string, positionId: string): Promise<void> {
  const rootStat = await fs.lstat(workspace);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw storageError("workspace must be a real directory for local turn state");
  }
  const segments = [".digital-employee", "workbench", "conversations", positionId, "turns"];
  let current = workspace;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw storageError("local turn state path must not contain symbolic links");
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
        throw storageError("local turn state directory creation raced with an unsafe path");
      }
    }
    if (index >= 1) await fs.chmod(current, 0o700);
  }
}

async function prepareSessionDirectories(workspace: string, sessionId: string): Promise<void> {
  assertSessionId(sessionId);
  const rootStat = await fs.lstat(workspace);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw storageError("workspace must be a real directory for local session turn state");
  }
  const segments = [
    ".digital-employee",
    "workbench",
    "sessions",
    "conversations",
    sessionId,
    "turns",
  ];
  let current = workspace;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw storageError("local session turn state path must not contain symbolic links");
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
        throw storageError("local session turn directory creation raced with an unsafe path");
      }
    }
    if (index >= 1) await fs.chmod(current, 0o700);
  }
}

function isConversationMetadata(value: unknown): value is ConversationMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === "conversation.v1" &&
    typeof record.conversationId === "string" &&
    record.conversationId.length > 0 &&
    isPositionId(record.positionId) &&
    typeof record.createdAt === "string"
  );
}

export function isTurnRecord(value: unknown): value is TurnRecord {
  if (!isObjectRecord(value)) return false;
  if (!hasExactKeys(
    value,
    [
      "schemaVersion", "conversationId", "turnId", "positionId", "engine", "status",
      "input", "envelopeDigest", "createdAt", "updatedAt", "events",
    ],
    ["runId", "output", "error", "groupRef", "conversationRef"],
  )) return false;
  const createdInstant = parseRfc3339Instant(value.createdAt);
  const updatedInstant = parseRfc3339Instant(value.updatedAt);
  if (
    value.schemaVersion !== TURN_RECORD_SCHEMA_VERSION ||
    !isBoundedIdentifier(value.conversationId) ||
    !isBoundedTurnId(value.turnId) ||
    value.turnId.includes("/") || value.turnId.includes("\\") || value.turnId.includes("\0") ||
    !isPositionId(value.positionId) ||
    (value.engine !== "qoder" && value.engine !== "claude-code" && value.engine !== "claude-local") ||
    !["running", "completed", "failed", "indeterminate"].includes(String(value.status)) ||
    typeof value.input !== "string" || Buffer.byteLength(value.input, "utf8") > MAX_INPUT_BYTES ||
    typeof value.envelopeDigest !== "string" ||
    !ENVELOPE_DIGEST_PATTERN.test(value.envelopeDigest) ||
    createdInstant === null || updatedInstant === null || updatedInstant < createdInstant ||
    !Array.isArray(value.events) || value.events.length > MAX_EVENTS
  ) return false;
  const events: EngineEvent[] = [];
  for (const event of value.events) {
    const validated = validateEngineEvent(event);
    if (validated === null) return false;
    events.push(validated);
  }
  if (!isValidEventSequence(events)) return false;
  const hasRunId = Object.hasOwn(value, "runId");
  const hasOutput = Object.hasOwn(value, "output");
  const hasError = Object.hasOwn(value, "error");
  if (hasRunId && !isBoundedIdentifier(value.runId)) return false;
  // Additive #52: local group conversationRef link (transition debt, 缺口①).
  if (Object.hasOwn(value, "groupRef") && !isBoundedIdentifier(value.groupRef)) return false;
  // owb#63: contract-level back-link bounds mirror upstream de#205 (1..256).
  if (
    Object.hasOwn(value, "conversationRef") &&
    (typeof value.conversationRef !== "string" ||
      value.conversationRef.length === 0 ||
      value.conversationRef.length > 256)
  ) return false;
  if (events.length > 0 && value.runId !== events[0]!.runId) return false;
  if (events.length === 0 && hasRunId) return false;
  const recordError = hasError ? validateRecordError(value.error) : null;
  if (hasError && recordError === null) return false;
  const terminal = events.at(-1);
  switch (value.status) {
    case "running":
      return events.length === 0 && !hasRunId && !hasOutput && !hasError;
    case "completed":
      return terminal?.type === "run.completed" && hasRunId && hasOutput && !hasError &&
        isBoundedJson(value.output, MAX_TERMINAL_OUTPUT_BYTES) &&
        JSON.stringify(value.output) === JSON.stringify(terminal.output);
    case "failed":
      return terminal?.type === "run.failed" && hasRunId && !hasOutput && recordError !== null &&
        recordError.code === terminal.error.code &&
        recordError.message === terminal.error.message &&
        recordError.retryable === terminal.error.retryable;
    case "indeterminate":
      return !hasOutput && recordError !== null;
    default:
      return false;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function parseRfc3339Instant(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = RFC3339_INSTANT_PATTERN.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8]!;
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (
    year < 1 || month < 1 || month > 12 || day < 1 ||
    day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59 || zone === "-00:00"
  ) return null;
  const localSeconds =
    BigInt(daysFromCivil(year, month, day)) * 86_400n +
    BigInt(hour * 3_600 + minute * 60 + second);
  const offsetDirection = match[9] === "-" ? -1n : 1n;
  const offsetSeconds = offsetDirection * BigInt(offsetHour * 3_600 + offsetMinute * 60);
  const fractionalNanoseconds = BigInt((match[7] ?? "").padEnd(9, "0") || "0");
  return (localSeconds - offsetSeconds) * 1_000_000_000n + fractionalNanoseconds;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Proleptic Gregorian civil date to days since 1970-01-01. */
function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function compareRfc3339Instants(left: string, right: string): number {
  const leftInstant = parseRfc3339Instant(left)!;
  const rightInstant = parseRfc3339Instant(right)!;
  return leftInstant < rightInstant ? -1 : leftInstant > rightInstant ? 1 : 0;
}

function compareCodeUnitOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareReportRecords(left: TurnRecord, right: TurnRecord): number {
  const updated = compareRfc3339Instants(right.updatedAt, left.updatedAt);
  if (updated !== 0) return updated;
  const turn = compareCodeUnitOrdinal(right.turnId, left.turnId);
  if (turn !== 0) return turn;
  return compareCodeUnitOrdinal(right.conversationId, left.conversationId);
}

function isBoundedCodePoints(value: string, limit: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > limit) return false;
  }
  return true;
}

function isBoundedJson(value: unknown, limit: number): boolean {
  try {
    const encoded = JSON.stringify(value);
    return encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= limit;
  } catch {
    return false;
  }
}

function isBoundedApprovalId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= APPROVAL_ID_MAX_LENGTH;
}

function isBoundedNonEmptyText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

// The driver validates expiresAt with Date.parse; the store must not be
// stricter or read-after-write fails for records the driver accepted.
function isOptionalIsoTimestamp(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function validateRecordError(
  value: unknown,
): { code: string; message: string; retryable: boolean } | null {
  if (!isObjectRecord(value) || !hasExactKeys(value, ["code", "message", "retryable"])) {
    return null;
  }
  if (
    typeof value.code !== "string" || !ENGINE_CODE_PATTERN.test(value.code) ||
    typeof value.message !== "string" ||
    Buffer.byteLength(value.message, "utf8") > MAX_DIAGNOSTIC_BYTES ||
    typeof value.retryable !== "boolean"
  ) return null;
  return { code: value.code, message: value.message, retryable: value.retryable };
}

function validateEngineEvent(raw: unknown): EngineEvent | null {
  if (
    !isObjectRecord(raw) || !isBoundedIdentifier(raw.runId) ||
    parseRfc3339Instant(raw.timestamp) === null
  ) {
    return null;
  }
  // owb#63 (de#205): engine.v1 events echo the envelope conversationRef
  // verbatim. Validate it once at the gate and strip it, so the frozen
  // exactKeys branches below stay untouched; it re-attaches via base.
  let value: Record<string, unknown> = raw;
  let conversationRef: string | undefined;
  if (Object.hasOwn(raw, "conversationRef")) {
    if (
      typeof raw.conversationRef !== "string" ||
      raw.conversationRef.length === 0 ||
      raw.conversationRef.length > 256
    ) return null;
    conversationRef = raw.conversationRef;
    value = { ...raw };
    delete value.conversationRef;
  }
  const base = {
    runId: value.runId as string,
    timestamp: value.timestamp as string,
    ...(conversationRef !== undefined ? { conversationRef } : {}),
  };
  switch (value.type) {
    case "run.started":
      return hasExactKeys(value, ["type", "runId", "timestamp"])
        ? { ...base, type: "run.started" }
        : null;
    case "model.delta":
      return hasExactKeys(value, ["type", "runId", "timestamp", "text"]) &&
        typeof value.text === "string" && isBoundedCodePoints(value.text, MAX_MODEL_CHARACTERS)
        ? { ...base, type: "model.delta", text: value.text }
        : null;
    case "usage": {
      if (!hasExactKeys(
        value,
        ["type", "runId", "timestamp"],
        ["inputTokens", "outputTokens", "totalTokens"],
      )) return null;
      for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
        if (value[key] !== undefined &&
          (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) return null;
      }
      return {
        ...base,
        type: "usage",
        ...(value.inputTokens !== undefined ? { inputTokens: value.inputTokens as number } : {}),
        ...(value.outputTokens !== undefined ? { outputTokens: value.outputTokens as number } : {}),
        ...(value.totalTokens !== undefined ? { totalTokens: value.totalTokens as number } : {}),
      };
    }
    case "run.completed":
      return hasExactKeys(value, ["type", "runId", "timestamp", "output", "terminalReason"]) &&
        value.terminalReason === "goal_met" &&
        isBoundedJson(value.output, MAX_TERMINAL_OUTPUT_BYTES)
        ? { ...base, type: "run.completed", output: value.output, terminalReason: "goal_met" }
        : null;
    case "run.failed": {
      if (!hasExactKeys(value, ["type", "runId", "timestamp", "error"]) ||
        !isObjectRecord(value.error) ||
        !hasExactKeys(value.error, ["code", "message", "retryable", "terminalReason"]) ||
        typeof value.error.code !== "string" || !ENGINE_CODE_PATTERN.test(value.error.code) ||
        typeof value.error.message !== "string" ||
        Buffer.byteLength(value.error.message, "utf8") > MAX_DIAGNOSTIC_BYTES ||
        typeof value.error.retryable !== "boolean" ||
        !TERMINAL_REASONS.has(value.error.terminalReason as TurnTerminalReason)) return null;
      return {
        ...base,
        type: "run.failed",
        error: {
          code: value.error.code,
          message: value.error.message,
          retryable: value.error.retryable,
          terminalReason: value.error.terminalReason as TurnTerminalReason,
        },
      };
    }
    // Additive #25 Slice B mirror of driver-cli.ts approval.* validation;
    // the frozen five cases above are unchanged.
    case "approval.requested": {
      if (
        !hasExactKeys(
          value,
          ["type", "runId", "timestamp", "approvalId", "action"],
          ["reason", "expiresAt"],
        ) ||
        !isObjectRecord(value.action) ||
        !hasExactKeys(value.action, ["kind", "description"], ["target"]) ||
        !isBoundedApprovalId(value.approvalId) ||
        !APPROVAL_ACTION_KINDS.has(value.action.kind as string) ||
        !isBoundedNonEmptyText(value.action.description, APPROVAL_DESCRIPTION_MAX_BYTES) ||
        (value.action.target !== undefined &&
          !isBoundedNonEmptyText(value.action.target, APPROVAL_TARGET_MAX_BYTES)) ||
        (value.reason !== undefined &&
          !isBoundedNonEmptyText(value.reason, APPROVAL_DESCRIPTION_MAX_BYTES)) ||
        !isOptionalIsoTimestamp(value.expiresAt)
      ) return null;
      return {
        ...base,
        type: "approval.requested",
        approvalId: value.approvalId,
        action: {
          kind: value.action.kind as "exec" | "write" | "network" | "tool",
          description: value.action.description,
          ...(value.action.target !== undefined ? { target: value.action.target } : {}),
        },
        ...(value.reason !== undefined ? { reason: value.reason } : {}),
        ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt as string } : {}),
      };
    }
    case "approval.granted":
      return hasExactKeys(value, ["type", "runId", "timestamp", "approvalId", "grantedBy", "scope"]) &&
        isBoundedApprovalId(value.approvalId) &&
        value.grantedBy === "operator" &&
        (value.scope === "once" || value.scope === "run")
        ? {
            ...base,
            type: "approval.granted",
            approvalId: value.approvalId,
            grantedBy: "operator" as const,
            scope: value.scope,
          }
        : null;
    case "approval.denied": {
      if (
        !hasExactKeys(
          value,
          ["type", "runId", "timestamp", "approvalId", "deniedBy"],
          ["reason"],
        ) ||
        !isBoundedApprovalId(value.approvalId) ||
        value.deniedBy !== "operator" ||
        (value.reason !== undefined &&
          !isBoundedNonEmptyText(value.reason, APPROVAL_DESCRIPTION_MAX_BYTES))
      ) return null;
      return {
        ...base,
        type: "approval.denied",
        approvalId: value.approvalId,
        deniedBy: "operator" as const,
        ...(value.reason !== undefined ? { reason: value.reason } : {}),
      };
    }
    default:
      return null;
  }
}

function isValidEventSequence(events: EngineEvent[]): boolean {
  if (events.length === 0) return true;
  if (events[0]!.type !== "run.started") return false;
  const runId = events[0]!.runId;
  let terminal = false;
  let previousInstant = parseRfc3339Instant(events[0]!.timestamp)!;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const instant = parseRfc3339Instant(event.timestamp)!;
    if (
      event.runId !== runId || (index > 0 && event.type === "run.started") || terminal ||
      instant < previousInstant
    ) return false;
    previousInstant = instant;
    if (event.type === "run.completed" || event.type === "run.failed") {
      terminal = true;
      if (index !== events.length - 1) return false;
    }
  }
  return true;
}

export class TurnStore {
  private metadataLocks = new Map<string, Promise<ConversationMetadata>>();
  private activeTurns = new Set<string>();

  constructor(
    private readonly options: {
      atomicWriteOperations?: AtomicTurnWriteOperations;
    } = {},
  ) {}

  async begin(input: {
    workspace: string;
    positionId: string;
    turnId: string;
    engine: TurnEngine;
    message: string;
    envelopeDigest: string;
    now: string;
    /** Additive #52: local group conversationRef for group-spawned turns. */
    groupRef?: string;
    /** owb#63: contract-level back-link carried by the v1alpha2 envelope. */
    conversationRef?: string;
  }): Promise<TurnRecord> {
    assertPositionId(input.positionId);
    turnRecordFile(input.workspace, input.positionId, input.turnId);
    await preparePositionDirectories(input.workspace, input.positionId);
    await this.assertCapacity(input.workspace, input.positionId);
    const metadata = await this.ensureConversation(input.workspace, input.positionId, input.now);
    const record: TurnRecord = {
      schemaVersion: TURN_RECORD_SCHEMA_VERSION,
      conversationId: metadata.conversationId,
      turnId: input.turnId,
      positionId: input.positionId,
      engine: input.engine,
      status: "running",
      input: input.message,
      envelopeDigest: input.envelopeDigest,
      createdAt: input.now,
      updatedAt: input.now,
      events: [],
      ...(input.groupRef !== undefined ? { groupRef: input.groupRef } : {}),
      ...(input.conversationRef !== undefined ? { conversationRef: input.conversationRef } : {}),
    };
    const activeKey = this.activeTurnKey(input.workspace, input.positionId, input.turnId);
    this.activeTurns.add(activeKey);
    try {
      await this.writeTurn(input.workspace, record);
    } catch (error) {
      this.activeTurns.delete(activeKey);
      throw error;
    }
    return record;
  }

  async finish(workspace: string, record: TurnRecord): Promise<void> {
    assertPositionId(record.positionId);
    turnRecordFile(workspace, record.positionId, record.turnId);
    await preparePositionDirectories(workspace, record.positionId);
    await this.writeTurn(workspace, record);
    this.activeTurns.delete(this.activeTurnKey(workspace, record.positionId, record.turnId));
  }

  async beginSession(input: {
    workspace: string;
    sessionId: string;
    positionId: string;
    turnId: string;
    engine: TurnEngine;
    message: string;
    envelopeDigest: string;
    now: string;
    /** owb#63: contract-level back-link (= sessionId for session turns). */
    conversationRef?: string;
  }): Promise<TurnRecord> {
    const sessionId = assertSessionId(input.sessionId);
    assertPositionId(input.positionId);
    sessionTurnRecordFile(input.workspace, sessionId, input.turnId);
    await prepareSessionDirectories(input.workspace, sessionId);
    await this.assertSessionCapacity(input.workspace, sessionId);
    const metadata = await this.ensureSessionConversation(
      input.workspace,
      sessionId,
      input.positionId,
      input.now,
    );
    const record: TurnRecord = {
      schemaVersion: TURN_RECORD_SCHEMA_VERSION,
      conversationId: metadata.conversationId,
      turnId: input.turnId,
      positionId: input.positionId,
      engine: input.engine,
      status: "running",
      input: input.message,
      envelopeDigest: input.envelopeDigest,
      createdAt: input.now,
      updatedAt: input.now,
      events: [],
      ...(input.conversationRef !== undefined ? { conversationRef: input.conversationRef } : {}),
    };
    const activeKey = this.sessionActiveTurnKey(input.workspace, sessionId, input.turnId);
    this.activeTurns.add(activeKey);
    try {
      await this.writeSessionTurn(input.workspace, sessionId, record);
    } catch (error) {
      this.activeTurns.delete(activeKey);
      throw error;
    }
    return record;
  }

  async finishSession(workspace: string, sessionId: string, record: TurnRecord): Promise<void> {
    assertPositionId(record.positionId);
    sessionTurnRecordFile(workspace, sessionId, record.turnId);
    await prepareSessionDirectories(workspace, sessionId);
    await this.writeSessionTurn(workspace, sessionId, record);
    this.activeTurns.delete(this.sessionActiveTurnKey(workspace, sessionId, record.turnId));
  }

  hasActiveSessionTurns(workspace: string, sessionId: string): boolean {
    const prefix = `${path.resolve(workspace)}\0session:${assertSessionId(sessionId)}\0`;
    return [...this.activeTurns].some((key) => key.startsWith(prefix));
  }

  async history(workspace: string, positionId: string, now: string): Promise<TurnHistory> {
    assertPositionId(positionId);
    await preparePositionDirectories(workspace, positionId);
    const metadata = await this.ensureConversation(workspace, positionId, now);
    const turnsDir = path.join(conversationDir(workspace, positionId), "turns");
    let names: string[];
    try {
      names = (await fs.readdir(turnsDir)).filter((name) => name.endsWith(".json"));
    } catch {
      throw storageError("local turn history is unreadable");
    }
    if (names.length > MAX_TURNS_PER_POSITION) {
      throw storageError("local turn history exceeds the bounded record count");
    }
    let historyBytes = 0;
    const turns: TurnRecord[] = [];
    for (const name of names) {
      let raw: unknown;
      try {
        const file = path.join(turnsDir, name);
        const read = await readJson(file, MAX_TURN_RECORD_BYTES);
        historyBytes += read.bytes;
        if (historyBytes > MAX_HISTORY_BYTES) {
          throw storageError("local turn history exceeds the bounded total size");
        }
        raw = read.value;
      } catch {
        throw storageError("local turn history contains an unreadable record");
      }
      if (
        !isTurnRecord(raw) ||
        raw.positionId !== positionId ||
        raw.conversationId !== metadata.conversationId ||
        turnRecordFile(workspace, raw.positionId, raw.turnId) !== path.resolve(turnsDir, name)
      ) {
        throw storageError("local turn history contains an invalid record");
      }
      if (
        raw.status === "running" &&
        !this.activeTurns.has(this.activeTurnKey(workspace, raw.positionId, raw.turnId))
      ) {
        const recovered: TurnRecord = {
          ...raw,
          status: "indeterminate",
          updatedAt: now,
          error: {
            code: "turn_interrupted",
            message: "the control plane stopped before the turn reached a trusted terminal",
            retryable: false,
          },
        };
        await this.writeTurn(workspace, recovered);
        turns.push(recovered);
      } else {
        turns.push(raw);
      }
    }
    turns.sort((left, right) =>
      compareRfc3339Instants(left.createdAt, right.createdAt) === 0
        ? compareCodeUnitOrdinal(left.turnId, right.turnId)
        : compareRfc3339Instants(left.createdAt, right.createdAt),
    );
    return {
      schemaVersion: TURN_HISTORY_SCHEMA_VERSION,
      conversationId: metadata.conversationId,
      positionId,
      turns,
    };
  }

  async sessionHistory(
    workspace: string,
    sessionId: string,
    positionId: string,
    now: string,
  ): Promise<TurnHistory> {
    assertSessionId(sessionId);
    assertPositionId(positionId);
    await prepareSessionDirectories(workspace, sessionId);
    const metadata = await this.ensureSessionConversation(workspace, sessionId, positionId, now);
    const turnsDir = path.join(sessionConversationDir(workspace, sessionId), "turns");
    let names: string[];
    try {
      names = (await fs.readdir(turnsDir)).filter((name) => name.endsWith(".json"));
    } catch {
      throw storageError("local session turn history is unreadable");
    }
    if (names.length > MAX_TURNS_PER_POSITION) {
      throw storageError("local session turn history exceeds the bounded record count");
    }
    let historyBytes = 0;
    const turns: TurnRecord[] = [];
    for (const name of names) {
      let raw: unknown;
      try {
        const file = path.join(turnsDir, name);
        const read = await readJson(file, MAX_TURN_RECORD_BYTES);
        historyBytes += read.bytes;
        if (historyBytes > MAX_HISTORY_BYTES) {
          throw storageError("local session turn history exceeds the bounded total size");
        }
        raw = read.value;
      } catch {
        throw storageError("local session turn history contains an unreadable record");
      }
      if (
        !isTurnRecord(raw) ||
        raw.positionId !== positionId ||
        raw.conversationId !== metadata.conversationId ||
        sessionTurnRecordFile(workspace, sessionId, raw.turnId) !== path.resolve(turnsDir, name)
      ) {
        throw storageError("local session turn history contains an invalid record");
      }
      if (
        raw.status === "running" &&
        !this.activeTurns.has(this.sessionActiveTurnKey(workspace, sessionId, raw.turnId))
      ) {
        const recovered: TurnRecord = {
          ...raw,
          status: "indeterminate",
          updatedAt: now,
          error: {
            code: "turn_interrupted",
            message: "the control plane stopped before the session turn reached a trusted terminal",
            retryable: false,
          },
        };
        await this.writeSessionTurn(workspace, sessionId, recovered);
        turns.push(recovered);
      } else {
        turns.push(raw);
      }
    }
    turns.sort((left, right) =>
      compareRfc3339Instants(left.createdAt, right.createdAt) === 0
        ? compareCodeUnitOrdinal(left.turnId, right.turnId)
        : compareRfc3339Instants(left.createdAt, right.createdAt),
    );
    return {
      schemaVersion: TURN_HISTORY_SCHEMA_VERSION,
      conversationId: metadata.conversationId,
      positionId,
      turns,
    };
  }

  /** Read existing turn facts for D4 without creating conversations or
   * recovering state. Any malformed/symlinked source rejects the whole view. */
  async reportRecords(workspace: string): Promise<TurnRecord[]> {
    const records: TurnRecord[] = [];
    const recordIdentities = new Set<string>();
    let totalBytes = 0;
    const chargeStableBytes = (bytes: number): void => {
      totalBytes += bytes;
      if (totalBytes > MAX_HISTORY_BYTES) {
        throw storageError("local reports turn data exceeds its bounded total size");
      }
    };
    let conversationCount = 0;
    let recordCount = 0;
    let authoritativeSessions: ReadonlyMap<string, WorkbenchSession> | undefined;
    const sources = [
      { kind: "position" as const, root: STATE_ROOT },
      { kind: "session" as const, root: SESSION_CONVERSATIONS_ROOT },
    ];

    for (const source of sources) {
      const root = path.join(workspace, source.root);
      let conversationEntries;
      try {
        await assertRealDirectoryChain(workspace, source.root.split(path.sep));
        conversationEntries = await fs.readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw storageError("local reports turn root is unreadable");
      }
      conversationCount += conversationEntries.length;
      if (conversationCount > MAX_REPORT_CONVERSATIONS) {
        throw storageError("local reports conversation count exceeds its bound");
      }
      if (source.kind === "session" && conversationEntries.length > 0) {
        authoritativeSessions = (await readAuthoritativeSessionIndex(workspace)).sessions;
      }

      for (const entry of conversationEntries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw storageError("local reports turn root contains an unsafe conversation");
        }
        let dir: string;
        let authoritativeSession: WorkbenchSession | undefined;
        if (source.kind === "position") {
          if (!isPositionId(entry.name)) {
            throw storageError("local reports turn root contains an unsafe position");
          }
          dir = conversationDir(workspace, entry.name);
        } else {
          try {
            assertSessionId(entry.name);
          } catch {
            throw storageError("local reports turn root contains an unsafe session");
          }
          authoritativeSession = authoritativeSessions?.get(entry.name);
          if (authoritativeSession === undefined) {
            throw storageError("local reports session conversation is orphaned");
          }
          dir = sessionConversationDir(workspace, entry.name);
        }
        await assertRealDirectory(dir, "local reports conversation path is unsafe");
        const metadataRead = await readJson(path.join(dir, "conversation.json"), MAX_METADATA_BYTES);
        chargeStableBytes(metadataRead.bytes);
        const metadata = metadataRead.value;
        if (
          !isConversationMetadata(metadata) ||
          (source.kind === "position" && metadata.positionId !== entry.name) ||
          (source.kind === "session" && (
            metadata.conversationId !== entry.name ||
            metadata.positionId !== authoritativeSession?.positionId
          ))
        ) {
          throw storageError("local reports conversation metadata is invalid");
        }
        const turnsDir = path.join(dir, "turns");
        await assertRealDirectory(turnsDir, "local reports turn directory is unsafe");
        const turnEntries = await fs.readdir(turnsDir, { withFileTypes: true });
        if (turnEntries.length > MAX_TURN_DIRECTORY_ENTRIES) {
          throw storageError("local reports turn directory exceeds its entry bound");
        }
        const jsonEntries = turnEntries.filter((turnEntry) => turnEntry.name.endsWith(".json"));
        if (jsonEntries.length > MAX_TURNS_PER_POSITION) {
          throw storageError("local reports turn count exceeds its bound");
        }
        recordCount += jsonEntries.length;
        if (recordCount > MAX_REPORT_RECORDS) {
          throw storageError("local reports record count exceeds its bound");
        }
        let temporaryCount = 0;
        for (const turnEntry of turnEntries) {
          if (turnEntry.name.endsWith(".tmp")) {
            temporaryCount += 1;
            if (
              temporaryCount > MAX_TURN_TEMP_FILES ||
              !isAtomicTurnTemporaryName(turnEntry.name) ||
              !turnEntry.isFile() ||
              turnEntry.isSymbolicLink()
            ) {
              throw storageError("local reports turn directory contains an unsafe temporary");
            }
            const temporary = await readBoundedStateFile(
              path.join(turnsDir, turnEntry.name),
              MAX_TURN_RECORD_BYTES,
            );
            chargeStableBytes(temporary.bytes);
            continue;
          }
          if (!turnEntry.isFile() || turnEntry.isSymbolicLink() || !turnEntry.name.endsWith(".json")) {
            throw storageError("local reports turn directory contains an unsafe record");
          }
          const file = path.join(turnsDir, turnEntry.name);
          const recordRead = await readJson(file, MAX_TURN_RECORD_BYTES);
          chargeStableBytes(recordRead.bytes);
          const raw = recordRead.value;
          if (
            !isTurnRecord(raw) ||
            raw.positionId !== metadata.positionId ||
            raw.conversationId !== metadata.conversationId
          ) {
            throw storageError("local reports contains an invalid turn record");
          }
          const expectedFile = source.kind === "position"
            ? turnRecordFile(workspace, raw.positionId, raw.turnId)
            : sessionTurnRecordFile(workspace, entry.name, raw.turnId);
          if (expectedFile !== path.resolve(file)) {
            throw storageError("local reports contains an invalid turn record");
          }
          const recordIdentity = `${raw.conversationId}\0${raw.turnId}`;
          if (recordIdentities.has(recordIdentity)) {
            throw storageError("local reports contains a duplicate turn identity");
          }
          recordIdentities.add(recordIdentity);
          records.push(raw);
        }
      }
    }
    records.sort(compareReportRecords);
    return records;
  }

  private async ensureConversation(
    workspace: string,
    positionId: string,
    now: string,
  ): Promise<ConversationMetadata> {
    const key = `${workspace}\0${positionId}`;
    const existing = this.metadataLocks.get(key);
    if (existing) return existing;
    const pending = this.loadOrCreateConversation(workspace, positionId, now);
    this.metadataLocks.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      this.metadataLocks.delete(key);
      throw error;
    }
  }

  private activeTurnKey(workspace: string, positionId: string, turnId: string): string {
    return `${path.resolve(workspace)}\0${positionId}\0${turnId}`;
  }

  private sessionActiveTurnKey(workspace: string, sessionId: string, turnId: string): string {
    return `${path.resolve(workspace)}\0session:${sessionId}\0${turnId}`;
  }

  private async ensureSessionConversation(
    workspace: string,
    sessionId: string,
    positionId: string,
    now: string,
  ): Promise<ConversationMetadata> {
    const key = `${workspace}\0session:${sessionId}`;
    const existing = this.metadataLocks.get(key);
    if (existing) return existing;
    const pending = this.loadOrCreateSessionConversation(workspace, sessionId, positionId, now);
    this.metadataLocks.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      this.metadataLocks.delete(key);
      throw error;
    }
  }

  private async loadOrCreateSessionConversation(
    workspace: string,
    sessionId: string,
    positionId: string,
    now: string,
  ): Promise<ConversationMetadata> {
    const dir = sessionConversationDir(workspace, sessionId);
    const file = path.join(dir, "conversation.json");
    try {
      const { value: raw } = await readJson(file, MAX_METADATA_BYTES);
      if (
        !isConversationMetadata(raw) ||
        raw.positionId !== positionId ||
        raw.conversationId !== sessionId
      ) {
        throw storageError("local session conversation metadata is invalid");
      }
      await fs.chmod(file, 0o600);
      return raw;
    } catch (error) {
      if (error instanceof OrgApiError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw storageError("local session conversation metadata is unreadable");
      }
    }
    const metadata: ConversationMetadata = {
      schemaVersion: "conversation.v1",
      conversationId: sessionId,
      positionId,
      createdAt: now,
    };
    try {
      await atomicWriteJson(
        file,
        metadata,
        MAX_METADATA_BYTES,
        this.options.atomicWriteOperations ?? nodeAtomicTurnWriteOperations,
        storageError,
      );
      return metadata;
    } catch {
      throw storageError("local session conversation metadata could not be persisted");
    }
  }

  private async loadOrCreateConversation(
    workspace: string,
    positionId: string,
    now: string,
  ): Promise<ConversationMetadata> {
    const dir = conversationDir(workspace, positionId);
    const file = path.join(dir, "conversation.json");
    try {
      const { value: raw } = await readJson(file, MAX_METADATA_BYTES);
      if (!isConversationMetadata(raw) || raw.positionId !== positionId) {
        throw storageError("local conversation metadata is invalid");
      }
      await fs.chmod(file, 0o600);
      return raw;
    } catch (error) {
      if (error instanceof OrgApiError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw storageError("local conversation metadata is unreadable");
      }
    }
    const metadata: ConversationMetadata = {
      schemaVersion: "conversation.v1",
      conversationId: crypto.randomUUID(),
      positionId,
      createdAt: now,
    };
    try {
      await atomicWriteJson(
        file,
        metadata,
        MAX_METADATA_BYTES,
        this.options.atomicWriteOperations ?? nodeAtomicTurnWriteOperations,
        storageError,
      );
      return metadata;
    } catch {
      throw storageError("local conversation metadata could not be persisted");
    }
  }

  private async writeTurn(workspace: string, record: TurnRecord): Promise<void> {
    const file = turnRecordFile(workspace, record.positionId, record.turnId);
    try {
      await atomicWriteJson(
        file,
        record,
        MAX_TURN_RECORD_BYTES,
        this.options.atomicWriteOperations ?? nodeAtomicTurnWriteOperations,
        storageError,
      );
    } catch {
      throw storageError("local turn record could not be persisted atomically");
    }
  }

  private async writeSessionTurn(
    workspace: string,
    sessionId: string,
    record: TurnRecord,
  ): Promise<void> {
    const file = sessionTurnRecordFile(workspace, sessionId, record.turnId);
    try {
      await atomicWriteJson(
        file,
        record,
        MAX_TURN_RECORD_BYTES,
        this.options.atomicWriteOperations ?? nodeAtomicTurnWriteOperations,
        storageError,
      );
    } catch {
      throw storageError("local session turn record could not be persisted atomically");
    }
  }

  private async assertCapacity(workspace: string, positionId: string): Promise<void> {
    const turnsDir = path.join(conversationDir(workspace, positionId), "turns");
    let names: string[];
    try {
      names = (await fs.readdir(turnsDir)).filter((name) => name.endsWith(".json"));
    } catch {
      throw storageError("local turn history is unreadable");
    }
    if (names.length >= MAX_TURNS_PER_POSITION) {
      throw storageError("local turn history reached the bounded record count");
    }
    let bytes = 0;
    for (const name of names) {
      const stat = await fs.lstat(path.join(turnsDir, name));
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw storageError("local turn history contains a non-regular record");
      }
      bytes += stat.size;
      if (bytes >= MAX_HISTORY_BYTES) {
        throw storageError("local turn history reached the bounded total size");
      }
    }
  }

  private async assertSessionCapacity(workspace: string, sessionId: string): Promise<void> {
    const turnsDir = path.join(sessionConversationDir(workspace, sessionId), "turns");
    let names: string[];
    try {
      names = (await fs.readdir(turnsDir)).filter((name) => name.endsWith(".json"));
    } catch {
      throw storageError("local session turn history is unreadable");
    }
    if (names.length >= MAX_TURNS_PER_POSITION) {
      throw storageError("local session turn history reached the bounded record count");
    }
    let bytes = 0;
    for (const name of names) {
      const stat = await fs.lstat(path.join(turnsDir, name));
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw storageError("local session turn history contains a non-regular record");
      }
      bytes += stat.size;
      if (bytes >= MAX_HISTORY_BYTES) {
        throw storageError("local session turn history reached the bounded total size");
      }
    }
  }
}

async function assertRealDirectoryChain(workspace: string, segments: string[]): Promise<void> {
  await assertRealDirectory(workspace, "workspace path is unsafe");
  let current = workspace;
  for (const segment of segments) {
    current = path.join(current, segment);
    await assertRealDirectory(current, "local reports state path is unsafe");
  }
}

async function assertRealDirectory(directory: string, message: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw storageError(message);
}
