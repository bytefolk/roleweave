/**
 * Minimal workspace-local asset record persistence (#35 S4, DS-35-001 rev-1 §6;
 * read/list surface consumed by #36 S1, DS-36-001 rev-1 §5).
 *
 * Strictly additive and deliberately small: document creation registers
 * `asset-record.v1` records with `kind: "doc"`; #36 consumes the exactKeys
 * contract unchanged and adds the non-document kinds through its own create
 * route. This module writes `record.json` per asset, maintains a bounded,
 * atomically rewritten `asset-index.json` ledger, and offers a deterministic
 * listing that rebuilds the ledger from the landed records (same input, same
 * output — AC-001 rebuild determinism). Discipline is isomorphic to the #52
 * groups store (real-directory chain guard, 0600/0700 modes, bounded counts
 * and sizes).
 *
 * Layout (workspace-local, never a wire contract):
 *   .digital-employee/workbench/drive/assets/<assetId>/record.json
 *   .digital-employee/workbench/drive/assets/asset-index.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ASSET_RECORD_SCHEMA_VERSION, OrgApiError, errorCodes, parseAssetRecord } from "@roleweave/shared";
import type { AssetRecord } from "@roleweave/shared";
import { atomicWriteJson, nodeAtomicTurnWriteOperations } from "../turns/store.js";

const ASSETS_ROOT = path.join(".digital-employee", "workbench", "drive", "assets");
const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ASSET_RECORD_BYTES = 16 * 1024;
const MAX_ASSET_INDEX_BYTES = 512 * 1024;
const MAX_ASSETS = 1024;

export const ASSET_INDEX_SCHEMA_VERSION = "asset-index.v1alpha1" as const;

export interface AssetIndexEntry {
  assetId: string;
  kind: AssetRecord["kind"];
  title: string;
  createdAt: string;
  docRef?: AssetRecord["docRef"];
}

export interface AssetIndex {
  schemaVersion: typeof ASSET_INDEX_SCHEMA_VERSION;
  assets: AssetIndexEntry[];
}

function storageError(message: string): OrgApiError {
  return new OrgApiError(errorCodes.docs_storage_failed, 500, message);
}

function assetsRoot(workspace: string): string {
  return path.join(workspace, ASSETS_ROOT);
}

function assertAssetId(assetId: string): string {
  if (!ASSET_ID_PATTERN.test(assetId)) {
    throw storageError("asset id must be a lowercase uuid");
  }
  return assetId;
}

async function prepareAssetDirectories(workspace: string, assetId: string): Promise<void> {
  assertAssetId(assetId);
  const rootStat = await fs.lstat(workspace);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw storageError("workspace must be a real directory for asset state");
  }
  const segments = [".digital-employee", "workbench", "drive", "assets", assetId];
  let current = workspace;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw storageError("asset state path must not contain symbolic links");
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
        throw storageError("asset state directory creation raced with an unsafe path");
      }
    }
    if (index >= 1) await fs.chmod(current, 0o700);
  }
}

async function readIndex(workspace: string): Promise<AssetIndex> {
  const file = path.join(assetsRoot(workspace), "asset-index.json");
  let raw: unknown;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ASSET_INDEX_BYTES) {
      throw storageError("asset index is not a bounded regular file");
    }
    raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: ASSET_INDEX_SCHEMA_VERSION, assets: [] };
    }
    throw storageError("asset index is unreadable");
  }
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    (raw as AssetIndex).schemaVersion !== ASSET_INDEX_SCHEMA_VERSION ||
    !Array.isArray((raw as AssetIndex).assets)
  ) {
    throw storageError("asset index is invalid");
  }
  return raw as AssetIndex;
}

/** Persist one asset record under its own directory (0600, symlink-guarded). */
export async function writeAssetRecord(workspace: string, record: AssetRecord): Promise<void> {
  if (record.schemaVersion !== ASSET_RECORD_SCHEMA_VERSION) {
    throw storageError("asset record must carry asset-record.v1");
  }
  const assetId = assertAssetId(record.assetId);
  await assertAssetCapacity(workspace);
  await prepareAssetDirectories(workspace, assetId);
  try {
    await atomicWriteJson(
      path.join(assetsRoot(workspace), assetId, "record.json"),
      record,
      MAX_ASSET_RECORD_BYTES,
      nodeAtomicTurnWriteOperations,
      storageError,
    );
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    throw storageError("asset record could not be persisted atomically");
  }
}

/** Atomically append one entry to the asset index ledger (temp + rename). */
export async function appendAssetIndex(workspace: string, entry: AssetIndexEntry): Promise<void> {
  assertAssetId(entry.assetId);
  const index = await readIndex(workspace);
  if (index.assets.some((existing) => existing.assetId === entry.assetId)) {
    throw storageError("asset index already contains the asset id");
  }
  const updated: AssetIndex = {
    schemaVersion: ASSET_INDEX_SCHEMA_VERSION,
    assets: [...index.assets, entry],
  };
  try {
    await atomicWriteJson(
      path.join(assetsRoot(workspace), "asset-index.json"),
      updated,
      MAX_ASSET_INDEX_BYTES,
      nodeAtomicTurnWriteOperations,
      storageError,
    );
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    throw storageError("asset index could not be persisted atomically");
  }
}

async function assertAssetCapacity(workspace: string): Promise<void> {
  const root = assetsRoot(workspace);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw storageError("asset root is unreadable");
  }
  if (entries.filter((entry) => entry.isDirectory()).length >= MAX_ASSETS) {
    throw storageError("asset count reached the bounded limit");
  }
}

/** Pure shape check so routes can answer 400 without touching storage. */
export function isAssetIdShape(assetId: unknown): assetId is string {
  return typeof assetId === "string" && ASSET_ID_PATTERN.test(assetId);
}

/** Read one landed record; absent assets are 404, corruption fails closed. */
export async function readAssetRecord(workspace: string, assetId: string): Promise<AssetRecord> {
  assertAssetId(assetId);
  const file = path.join(assetsRoot(workspace), assetId, "record.json");
  let rawText: string;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ASSET_RECORD_BYTES) {
      throw storageError("asset record is not a bounded regular file");
    }
    rawText = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OrgApiError(errorCodes.asset_not_found, 404, `asset not found: ${assetId}`);
    }
    throw storageError("asset record is unreadable");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText) as unknown;
  } catch {
    throw storageError("asset record is not valid JSON");
  }
  const parsed = parseAssetRecord(raw);
  if (!parsed.ok || !parsed.record) {
    throw storageError(`asset record failed asset-record.v1 validation: ${parsed.message ?? "unknown"}`);
  }
  if (parsed.record.assetId !== assetId) {
    throw storageError("asset record id does not match its directory");
  }
  return parsed.record;
}

/**
 * Deterministic listing: scans the landed record directories, validates every
 * record against asset-record.v1, sorts by createdAt then assetId, and
 * rebuilds the index ledger from the same records (same input, same output).
 */
export async function listAssetRecords(workspace: string): Promise<AssetRecord[]> {
  const root = assetsRoot(workspace);
  let dirents;
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw storageError("asset root is unreadable");
  }
  const ids = dirents
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && ASSET_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const records: AssetRecord[] = [];
  for (const id of ids) {
    records.push(await readAssetRecord(workspace, id));
  }
  records.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
    return left.assetId.localeCompare(right.assetId);
  });
  await rebuildAssetIndex(workspace, records);
  return records;
}

async function rebuildAssetIndex(workspace: string, records: AssetRecord[]): Promise<void> {
  const rebuilt: AssetIndex = {
    schemaVersion: ASSET_INDEX_SCHEMA_VERSION,
    assets: records.map((record) => {
      const entry: AssetIndexEntry = {
        assetId: record.assetId,
        kind: record.kind,
        title: record.title,
        createdAt: record.createdAt,
      };
      if (record.docRef) entry.docRef = record.docRef;
      return entry;
    }),
  };
  let existing: AssetIndex | null;
  try {
    existing = await readIndex(workspace);
  } catch (error) {
    if (error instanceof OrgApiError) existing = null;
    else throw error;
  }
  if (existing !== null && JSON.stringify(existing) === JSON.stringify(rebuilt)) return;
  try {
    await atomicWriteJson(
      path.join(assetsRoot(workspace), "asset-index.json"),
      rebuilt,
      MAX_ASSET_INDEX_BYTES,
      nodeAtomicTurnWriteOperations,
      storageError,
    );
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    throw storageError("asset index could not be rebuilt atomically");
  }
}
