/**
 * Per-position Agent binding stored alongside the employee package.
 *
 * The sidecar is deliberately not an employee.json asset: an execution
 * transport is Workbench-local state and must not alter the upstream package
 * digest. Keeping it in the package directory means normal org moves and
 * deletes carry it with the employee automatically.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  AGENT_BINDING_RELATIVE_PATH,
  AGENT_BINDING_SCHEMA_VERSION,
  OrgApiError,
  errorCodes,
  isPositionAgentBinding,
} from "@roleweave/shared";
import type { PositionAgentBinding, TurnEngine } from "@roleweave/shared";
import type { OpenWorkspace } from "./workspace-state.js";
import { POSITIONS_DIR } from "./workspace-state.js";
import { resolvePositionPackageDir } from "./context-sources.js";
import type { TurnStore } from "./turns/store.js";
import { atomicWriteJson, compareCodeUnitOrdinal, compareRfc3339Instants, nodeAtomicTurnWriteOperations } from "./turns/store.js";
import type { SessionStore } from "./sessions/store.js";
import { decodeStableUtf8, readStableBoundedFile, StableReadError } from "./stable-read.js";

const MAX_AGENT_BINDING_BYTES = 1024;
const BINDING_DIR = ".workbench";

/** Local in-process serialization protects a legacy position from receiving
 * two different first-use engines in concurrently accepted requests. */
const bindingLocks = new Map<string, Promise<void>>();

interface BindingPaths {
  positionsRoot: string;
  positionDir: string;
  bindingDir: string;
  file: string;
}

function bindingError(message: string, cause?: unknown): OrgApiError {
  return new OrgApiError(
    errorCodes.turn_storage_failed,
    500,
    message,
    false,
    cause === undefined ? undefined : { cause },
  );
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function resolvePaths(workspace: OpenWorkspace, positionId: string): BindingPaths {
  const role = workspace.organization.roles.find((candidate) => candidate.id === positionId);
  if (role === undefined) {
    throw new OrgApiError(errorCodes.position_missing, 404, `position not found: ${positionId}`);
  }
  const positionsRoot = path.resolve(workspace.dir, POSITIONS_DIR);
  const positionDir = path.resolve(resolvePositionPackageDir(workspace.dir, role));
  const relative = path.relative(positionsRoot, positionDir);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw bindingError("position Agent binding path escapes the workspace positions directory");
  }
  const bindingDir = path.resolve(positionDir, BINDING_DIR);
  const file = path.resolve(positionDir, ...AGENT_BINDING_RELATIVE_PATH.split("/"));
  if (path.dirname(bindingDir) !== positionDir || path.dirname(file) !== bindingDir) {
    throw bindingError("position Agent binding path is invalid");
  }
  return { positionsRoot, positionDir, bindingDir, file };
}

async function assertRealDirectory(dir: string, missingMessage: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(dir);
  } catch (error) {
    if (isNotFound(error)) throw bindingError(missingMessage);
    throw bindingError("position Agent binding directory is unreadable", error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw bindingError("position Agent binding path must be a real directory");
  }
}

/** Verify every directory segment between the workspace positions root and a
 * package. Checking only the leaf lets an intermediate symlink redirect the
 * binding sidecar outside the workspace. */
async function assertRealDirectoryChain(root: string, target: string, missingMessage: string): Promise<void> {
  await assertRealDirectory(root, missingMessage);
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw bindingError("position Agent binding path escapes the workspace positions directory");
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    await assertRealDirectory(current, missingMessage);
  }
}

async function readBindingAt(paths: BindingPaths): Promise<PositionAgentBinding | null> {
  await assertRealDirectoryChain(paths.positionsRoot, paths.positionDir, "position package directory is missing for Agent binding");
  let directory;
  try {
    directory = await fs.lstat(paths.bindingDir);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw bindingError("position Agent binding directory is unreadable", error);
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw bindingError("position Agent binding directory must be a real directory");
  }
  let contents: Buffer;
  try {
    contents = (await readStableBoundedFile(paths.file, MAX_AGENT_BINDING_BYTES)).buffer;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof StableReadError) {
      throw bindingError("position Agent binding file must be a stable bounded regular file", error);
    }
    throw bindingError("position Agent binding file is unreadable", error);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decodeStableUtf8(contents)) as unknown;
  } catch (error) {
    throw bindingError("position Agent binding file is not valid JSON", error);
  }
  if (!isPositionAgentBinding(raw)) {
    throw bindingError("position Agent binding file has an invalid schema");
  }
  return raw;
}

async function ensureBindingDirectory(paths: BindingPaths): Promise<void> {
  await assertRealDirectoryChain(paths.positionsRoot, paths.positionDir, "position package directory is missing for Agent binding");
  try {
    await fs.mkdir(paths.bindingDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw bindingError("position Agent binding directory could not be created", error);
    }
  }
  await assertRealDirectory(paths.bindingDir, "position Agent binding directory is missing");
}

async function writeBindingAt(paths: BindingPaths, binding: PositionAgentBinding): Promise<void> {
  await ensureBindingDirectory(paths);
  try {
    await atomicWriteJson(
      paths.file,
      binding,
      MAX_AGENT_BINDING_BYTES,
      nodeAtomicTurnWriteOperations,
      (message) => bindingError(message),
    );
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    throw bindingError("position Agent binding could not be persisted atomically", error);
  }
}

async function withBindingLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = bindingLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => held);
  bindingLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (bindingLocks.get(key) === tail) bindingLocks.delete(key);
  }
}

/** Pick the latest historical concrete engine across both old bare turns and
 * the session-backed turns that the desktop has normally created. */
async function legacyEngineFromHistory(
  workspace: OpenWorkspace,
  positionId: string,
  turnStore: TurnStore,
  sessionStore: SessionStore,
): Promise<TurnEngine | undefined> {
  const now = new Date().toISOString();
  const records = [...(await turnStore.history(workspace.dir, positionId, now)).turns];
  const sessions = await sessionStore.list(workspace.dir, positionId);
  for (const session of sessions.sessions) {
    const history = await turnStore.sessionHistory(workspace.dir, session.sessionId, positionId, now);
    records.push(...history.turns);
  }
  records.sort((left, right) =>
    compareRfc3339Instants(left.createdAt, right.createdAt) ||
    compareCodeUnitOrdinal(left.turnId, right.turnId),
  );
  // Failed, interrupted, or still-running records are not evidence of the
  // Agent that successfully served the employee. If no completed turn exists,
  // the caller's requested engine remains the safe first-use fallback.
  return records.filter((record) => record.status === "completed").at(-1)?.engine;
}

/** Reads an existing binding without changing a legacy employee package. */
export async function readPositionAgentBinding(
  workspace: OpenWorkspace,
  positionId: string,
): Promise<PositionAgentBinding | null> {
  return readBindingAt(resolvePaths(workspace, positionId));
}

export async function setPositionModel(workspace: OpenWorkspace, positionId: string, model: string): Promise<void> {
  const paths = resolvePaths(workspace, positionId);
  await withBindingLock(`${path.resolve(workspace.dir)}\0${positionId}`, async () => {
    const binding = await readBindingAt(paths);
    if (!binding) throw bindingError("An Agent must be bound before choosing its model");
    await writeBindingAt(paths, { ...binding, model });
  });
}

/** The one-time operator choice for an imported employee. The selection is
 * durable immediately, before a task is sent, so no employee can be bounced
 * between runtimes after an operator has made its initial choice. */
export async function setPositionAgentEngine(
  workspace: OpenWorkspace,
  positionId: string,
  engine: TurnEngine,
): Promise<void> {
  const paths = resolvePaths(workspace, positionId);
  await withBindingLock(`${path.resolve(workspace.dir)}\0${positionId}`, async () => {
    const existing = await readBindingAt(paths);
    if (existing?.locked === true) {
      throw new OrgApiError(errorCodes.session_conflict, 409, "Agent is locked after its initial selection; create a new employee to use another Agent");
    }
    await writeBindingAt(paths, {
      schemaVersion: AGENT_BINDING_SCHEMA_VERSION,
      engine,
      locked: true,
    });
  });
}

/**
 * Resolves the one engine a position may use. A pre-binding employee is
 * migrated exactly once: prefer its newest durable turn so an upgrade cannot
 * silently switch it; otherwise use the caller's currently selected concrete
 * engine. The sidecar then becomes authoritative for direct, session, and
 * group turns alike.
 */
export async function resolvePositionAgentEngine(
  workspace: OpenWorkspace,
  positionId: string,
  requestedEngine: TurnEngine,
  turnStore: TurnStore,
  sessionStore: SessionStore,
): Promise<TurnEngine> {
  const paths = resolvePaths(workspace, positionId);
  const existing = await readBindingAt(paths);
  if (existing?.locked === true) return existing.engine;

  const lockKey = `${path.resolve(workspace.dir)}\0${positionId}`;
  return withBindingLock(lockKey, async () => {
    const afterWait = await readBindingAt(paths);
    if (afterWait !== null) {
      if (afterWait.locked !== true) await writeBindingAt(paths, { ...afterWait, locked: true });
      return afterWait.engine;
    }
    const engine = await legacyEngineFromHistory(
      workspace,
      positionId,
      turnStore,
      sessionStore,
    ) ?? requestedEngine;
    await writeBindingAt(paths, {
      schemaVersion: AGENT_BINDING_SCHEMA_VERSION,
      engine,
      locked: true,
    });
    return engine;
  });
}
