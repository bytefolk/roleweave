import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isPositionId } from "@roleweave/shared";
import type { TurnRecord, WorkbenchSession } from "@roleweave/shared";
import { isTurnRecord } from "../turns/store.js";

const EXPORT_SCHEMA_VERSION = "context-export-state.v1" as const;
const OCCURRENCE_SCHEMA_VERSION = "context-occurrence.v1" as const;
const EXPORT_ROOT = [".digital-employee", "workbench", "context-exports"] as const;
const MAX_OCCURRENCE_BYTES = 64 * 1024;
const MAX_EXPORT_STATE_BYTES = 64 * 1024;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ContextOccurrence {
  schemaVersion: typeof OCCURRENCE_SCHEMA_VERSION;
  occurrenceId: string;
  scope: {
    workspaceId: string;
    positionId: string;
    principal: string;
  };
  source: {
    kind: "workbench-turn";
    conversationId: string;
    turnId: string;
    role: "user" | "assistant";
    eventAt: string;
    contentSha256: string;
  };
  content: string;
}

export interface ContextAdapterClient {
  ingest(occurrence: ContextOccurrence): Promise<{
    inserted: boolean;
    occurrenceId: string;
    status: "pending" | "done" | "failed";
  }>;
  distill(occurrenceId: string): Promise<{
    occurrenceId: string;
    status: "done";
    artifacts: number;
  }>;
}

export interface ContextExportOccurrenceEvidence {
  role: "user" | "assistant";
  occurrenceId: string;
  contentSha256: string;
  sourceDigest: string;
  /** Source audit reference only; Context `read` requires an item-unique artifact locator. */
  sourceLocator: string;
  truncated: boolean;
}

export interface ContextExportState {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  workspaceInstanceId: string;
  sessionId: string;
  turnId: string;
  positionId: string;
  principal: string;
  status: "pending" | "done" | "failed";
  attempts: number;
  exportDigest: string;
  occurrences: ContextExportOccurrenceEvidence[];
  updatedAt: string;
  errorCode?: "context_adapter_failed";
}

class ContextExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextExportError";
  }
}

interface PreparedExport {
  state: ContextExportState;
  occurrences: ContextOccurrence[];
}

export class ContextExportService {
  private readonly jobs = new Map<string, Promise<void>>();

  constructor(private readonly adapter: ContextAdapterClient) {}

  /**
   * Persist a retryable export intent after the trusted terminal turn itself
   * has already been durably committed. Adapter work runs out-of-band; a
   * failure cannot mutate the turn or invoke the Host again.
   */
  async enqueueCompletedTurn(
    workspace: string,
    session: WorkbenchSession,
    turn: TurnRecord,
  ): Promise<void> {
    const prepared = prepareExport(session, turn);
    const key = exportKey(workspace, session.sessionId, turn.turnId);
    const existing = await readContextExportStateIfPresent(workspace, session.sessionId, turn.turnId);
    if (existing !== null) {
      if (existing.exportDigest !== prepared.state.exportDigest) {
        throw new ContextExportError("context export identity mismatch");
      }
      if (existing.status === "done") return;
      prepared.state.attempts = existing.attempts;
    }
    if (this.jobs.has(key)) return;
    await writeContextExportState(workspace, prepared.state);
    const job = this.run(workspace, prepared)
      .catch(() => {
        // A transient filesystem failure is retried on the next workspace-open.
        // A persistent one (e.g. Windows EPERM before the platform-gated fix)
        // would recur; writeContextExportState now swallows EPERM on win32 so
        // the common Windows case no longer reaches this catch. Never allow a
        // background exporter rejection to terminate the server.
      })
      .finally(() => {
        this.jobs.delete(key);
      });
    this.jobs.set(key, job);
  }

  async waitForIdle(): Promise<void> {
    while (this.jobs.size > 0) {
      await Promise.all([...this.jobs.values()]);
    }
  }

  private async run(workspace: string, prepared: PreparedExport): Promise<void> {
    const attempting: ContextExportState = {
      ...prepared.state,
      status: "pending",
      attempts: prepared.state.attempts + 1,
      updatedAt: new Date().toISOString(),
    };
    delete attempting.errorCode;
    try {
      await writeContextExportState(workspace, attempting);
      for (const occurrence of prepared.occurrences) {
        const ingested = await this.adapter.ingest(occurrence);
        if (
          ingested.occurrenceId !== occurrence.occurrenceId ||
          typeof ingested.inserted !== "boolean" ||
          !["pending", "done", "failed"].includes(ingested.status)
        ) {
          throw new ContextExportError("context adapter returned an invalid ingest response");
        }
        if (ingested.status === "failed") {
          throw new ContextExportError("context adapter rejected a stored occurrence");
        }
        if (ingested.status === "pending") {
          const distilled = await this.adapter.distill(occurrence.occurrenceId);
          if (
            distilled.occurrenceId !== occurrence.occurrenceId ||
            distilled.status !== "done" ||
            !Number.isSafeInteger(distilled.artifacts) ||
            distilled.artifacts < 0
          ) {
            throw new ContextExportError("context adapter returned an invalid distill response");
          }
        }
      }
      await writeContextExportState(workspace, {
        ...attempting,
        status: "done",
        updatedAt: new Date().toISOString(),
      });
    } catch {
      await writeContextExportState(workspace, {
        ...attempting,
        status: "failed",
        updatedAt: new Date().toISOString(),
        errorCode: "context_adapter_failed",
      });
    }
  }
}

function prepareExport(session: WorkbenchSession, turn: TurnRecord): PreparedExport {
  if (!isValidSession(session)) throw new ContextExportError("context export session is invalid");
  if (!isTurnRecord(turn)) throw new ContextExportError("context export turn is invalid");
  if (turn.status !== "completed") throw new ContextExportError("turn is not eligible for context export");
  if (turn.positionId !== session.positionId || turn.conversationId !== session.sessionId) {
    throw new ContextExportError("context export session and turn mismatch");
  }
  const user = boundedContent(turn.input);
  const encodedOutput = typeof turn.output === "string" ? turn.output : JSON.stringify(turn.output);
  if (encodedOutput === undefined) throw new ContextExportError("context export turn output is invalid");
  const assistant = boundedContent(encodedOutput);
  const occurrenceInputs = [
    { role: "user" as const, eventAt: turn.createdAt, ...user },
    { role: "assistant" as const, eventAt: turn.updatedAt, ...assistant },
  ];
  const occurrences = occurrenceInputs.map((input) => createOccurrence(session, turn, input));
  const evidence: ContextExportOccurrenceEvidence[] = occurrences.map((occurrence, index) => ({
    role: occurrence.source.role,
    occurrenceId: occurrence.occurrenceId,
    contentSha256: occurrence.source.contentSha256,
    sourceDigest: digest(canonicalJson({
      occurrenceId: occurrence.occurrenceId,
      scope: occurrence.scope,
      source: occurrence.source,
    })),
    sourceLocator: `context://occurrences/${occurrence.occurrenceId}@1`,
    truncated: occurrenceInputs[index]!.truncated,
  }));
  const exportDigest = computeExportDigest({
    workspaceInstanceId: session.workspaceInstanceId,
    positionId: session.positionId,
    principal: session.principal,
    sessionId: session.sessionId,
    turnId: turn.turnId,
    occurrences: evidence,
  });
  return {
    state: {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      workspaceInstanceId: session.workspaceInstanceId,
      sessionId: session.sessionId,
      turnId: turn.turnId,
      positionId: session.positionId,
      principal: session.principal,
      status: "pending",
      attempts: 0,
      exportDigest,
      occurrences: evidence,
      updatedAt: new Date().toISOString(),
    },
    occurrences,
  };
}

function createOccurrence(
  session: WorkbenchSession,
  turn: TurnRecord,
  input: { role: "user" | "assistant"; eventAt: string; content: string },
): ContextOccurrence {
  const identity = [
    session.workspaceInstanceId,
    session.positionId,
    session.principal,
    session.sessionId,
    turn.turnId,
    input.role,
  ];
  return {
    schemaVersion: OCCURRENCE_SCHEMA_VERSION,
    occurrenceId: digest(JSON.stringify(identity)),
    scope: {
      workspaceId: session.workspaceInstanceId,
      positionId: session.positionId,
      principal: session.principal,
    },
    source: {
      kind: "workbench-turn",
      conversationId: session.sessionId,
      turnId: turn.turnId,
      role: input.role,
      eventAt: new Date(input.eventAt).toISOString(),
      contentSha256: digest(input.content),
    },
    content: input.content,
  };
}

function boundedContent(content: string): { content: string; truncated: boolean } {
  if (Buffer.byteLength(content, "utf8") <= MAX_OCCURRENCE_BYTES) {
    return { content, truncated: false };
  }
  let bytes = 0;
  let bounded = "";
  for (const character of content) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > MAX_OCCURRENCE_BYTES) break;
    bounded += character;
    bytes += next;
  }
  return { content: bounded, truncated: true };
}

function isValidSession(session: WorkbenchSession): boolean {
  const expectedKeys = [
    "schemaVersion", "sessionId", "workspaceInstanceId", "positionId", "principal",
    "status", "rotatedFrom", "rotatedTo", "createdAt", "rotatedAt",
  ].sort();
  const baseValid = Object.keys(session).sort().join(",") === expectedKeys.join(",") &&
    session.schemaVersion === "workbench-session.v1" &&
    UUID_PATTERN.test(session.sessionId) &&
    UUID_PATTERN.test(session.workspaceInstanceId) &&
    isPositionId(session.positionId) &&
    session.principal === `position.${session.positionId}` &&
    (session.status === "active" || session.status === "rotated") &&
    Number.isFinite(Date.parse(session.createdAt)) &&
    (session.rotatedFrom === null || UUID_PATTERN.test(session.rotatedFrom)) &&
    (session.rotatedTo === null || UUID_PATTERN.test(session.rotatedTo)) &&
    (session.rotatedAt === null || Number.isFinite(Date.parse(session.rotatedAt)));
  if (!baseValid) return false;
  return session.status === "active"
    ? session.rotatedTo === null && session.rotatedAt === null
    : session.rotatedTo !== null && session.rotatedAt !== null;
}

function digest(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new ContextExportError("context export digest input is invalid");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function computeExportDigest(input: {
  workspaceInstanceId: string;
  sessionId: string;
  turnId: string;
  positionId: string;
  principal: string;
  occurrences: ContextExportOccurrenceEvidence[];
}): string {
  return digest(JSON.stringify([
    input.workspaceInstanceId,
    input.positionId,
    input.principal,
    input.sessionId,
    input.turnId,
    ...input.occurrences.flatMap((item) => [
      item.role,
      item.occurrenceId,
      item.contentSha256,
      item.sourceDigest,
      item.sourceLocator,
      item.truncated,
    ]),
  ]));
}

function exportKey(workspace: string, sessionId: string, turnId: string): string {
  return `${path.resolve(workspace)}\0${sessionId}\0${turnId}`;
}

function exportStateFile(workspace: string, sessionId: string, turnId: string): string {
  if (!UUID_PATTERN.test(sessionId) || turnId.length === 0 || turnId.length > 256 || /[\\/\0]/.test(turnId)) {
    throw new ContextExportError("context export state identity is invalid");
  }
  const root = path.resolve(workspace, ...EXPORT_ROOT, sessionId);
  const file = path.resolve(root, `${turnId}.json`);
  if (path.dirname(file) !== root) throw new ContextExportError("context export state path is invalid");
  return file;
}

async function prepareExportDirectories(workspace: string, sessionId: string): Promise<void> {
  if (!UUID_PATTERN.test(sessionId)) throw new ContextExportError("context export session is invalid");
  const root = path.resolve(workspace);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ContextExportError("context export workspace path is unsafe");
  }
  let current = root;
  for (const segment of [...EXPORT_ROOT, sessionId]) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new ContextExportError("context export state path is unsafe");
      }
    } catch (error) {
      if (error instanceof ContextExportError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ContextExportError("context export state path is unavailable");
      }
      await fs.mkdir(current, { mode: 0o700 });
      const created = await fs.lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new ContextExportError("context export state directory creation raced");
      }
    }
    if (segment === "workbench" || segment === "context-exports" || segment === sessionId) {
      await fs.chmod(current, 0o700);
    }
  }
}

async function writeContextExportState(workspace: string, state: ContextExportState): Promise<void> {
  if (!isContextExportState(state)) throw new ContextExportError("context export state is invalid");
  await prepareExportDirectories(workspace, state.sessionId);
  const file = exportStateFile(workspace, state.sessionId, state.turnId);
  const payload = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(payload, "utf8") > MAX_EXPORT_STATE_BYTES) {
    throw new ContextExportError("context export state exceeds its bound");
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
    const directory = await fs.open(path.dirname(file), "r");
    try {
      try {
        await directory.sync();
      } catch (syncError) {
        // Windows/NTFS rejects fsync on directory handles with EPERM. The
        // rename above has already committed the data atomically, so on the
        // affected platform the record is durable. On POSIX the same EPERM
        // would indicate a real failure and must propagate.
        if (process.platform !== "win32" || (syncError as NodeJS.ErrnoException).code !== "EPERM") {
          throw syncError;
        }
      }
    } finally {
      await directory.close();
    }
  } catch {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw new ContextExportError("context export state could not be persisted");
  }
}

export async function readContextExportState(
  workspace: string,
  sessionId: string,
  turnId: string,
): Promise<ContextExportState> {
  const state = await readContextExportStateIfPresent(workspace, sessionId, turnId);
  if (state === null) throw new ContextExportError("context export state is missing");
  return state;
}

async function readContextExportStateIfPresent(
  workspace: string,
  sessionId: string,
  turnId: string,
): Promise<ContextExportState | null> {
  if (!await hasSafeExistingExportDirectory(workspace, sessionId)) return null;
  const file = exportStateFile(workspace, sessionId, turnId);
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ContextExportError("context export state is unreadable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EXPORT_STATE_BYTES) {
    throw new ContextExportError("context export state is not a bounded regular file");
  }
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch {
    throw new ContextExportError("context export state is invalid");
  }
  if (!isContextExportState(value) || value.sessionId !== sessionId || value.turnId !== turnId) {
    throw new ContextExportError("context export state is invalid");
  }
  return value;
}

async function hasSafeExistingExportDirectory(
  workspace: string,
  sessionId: string,
): Promise<boolean> {
  if (!UUID_PATTERN.test(sessionId)) throw new ContextExportError("context export session is invalid");
  const root = path.resolve(workspace);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ContextExportError("context export workspace path is unsafe");
  }
  let current = root;
  for (const segment of [...EXPORT_ROOT, sessionId]) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new ContextExportError("context export state path is unavailable");
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ContextExportError("context export state path is unsafe");
    }
  }
  return true;
}

function isContextExportState(value: unknown): value is ContextExportState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const required = [
    "schemaVersion", "workspaceInstanceId", "sessionId", "turnId", "positionId", "principal",
    "status", "attempts", "exportDigest", "occurrences", "updatedAt",
  ];
  const allowed = new Set([...required, "errorCode"]);
  if (!required.every((key) => Object.hasOwn(record, key)) || Object.keys(record).some((key) => !allowed.has(key))) {
    return false;
  }
  if (
    record.schemaVersion !== EXPORT_SCHEMA_VERSION ||
    typeof record.workspaceInstanceId !== "string" || !UUID_PATTERN.test(record.workspaceInstanceId) ||
    typeof record.sessionId !== "string" || !UUID_PATTERN.test(record.sessionId) ||
    typeof record.turnId !== "string" || record.turnId.length === 0 || record.turnId.length > 256 || /[\\/\0]/.test(record.turnId) ||
    !isPositionId(record.positionId) ||
    record.principal !== `position.${record.positionId}` ||
    !["pending", "done", "failed"].includes(String(record.status)) ||
    !Number.isSafeInteger(record.attempts) || (record.attempts as number) < 0 ||
    typeof record.exportDigest !== "string" || !SHA256_PATTERN.test(record.exportDigest) ||
    typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt)) ||
    !Array.isArray(record.occurrences) || record.occurrences.length !== 2 ||
    (record.errorCode !== undefined && record.errorCode !== "context_adapter_failed") ||
    (record.status === "failed") !== (record.errorCode === "context_adapter_failed")
  ) return false;
  const roles = new Set<string>();
  for (const item of record.occurrences) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const evidence = item as Record<string, unknown>;
    if (Object.keys(evidence).sort().join(",") !== [
      "role", "occurrenceId", "contentSha256", "sourceDigest", "sourceLocator", "truncated",
    ].sort().join(",")) return false;
    if (
      (evidence.role !== "user" && evidence.role !== "assistant") ||
      typeof evidence.occurrenceId !== "string" || !SHA256_PATTERN.test(evidence.occurrenceId) ||
      typeof evidence.contentSha256 !== "string" || !SHA256_PATTERN.test(evidence.contentSha256) ||
      typeof evidence.sourceDigest !== "string" || !SHA256_PATTERN.test(evidence.sourceDigest) ||
      evidence.sourceLocator !== `context://occurrences/${evidence.occurrenceId}@1` ||
      typeof evidence.truncated !== "boolean"
    ) return false;
    roles.add(evidence.role);
  }
  if (roles.size !== 2) return false;
  return record.exportDigest === computeExportDigest({
    workspaceInstanceId: record.workspaceInstanceId,
    sessionId: record.sessionId,
    turnId: record.turnId,
    positionId: record.positionId,
    principal: record.principal as string,
    occurrences: record.occurrences as ContextExportOccurrenceEvidence[],
  });
}
