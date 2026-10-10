import fs from "node:fs/promises";
import path from "node:path";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import { decodeStableUtf8, readStableBoundedFile } from "../stable-read.js";
import { atomicWriteJson, nodeAtomicTurnWriteOperations } from "../turns/store.js";

export const EXPERIMENTS_FILE = path.join(".roleweave", "experiments.v1.json");
const MAX_BYTES = 1_024;
/** The only keys a stored file may carry. A file with anything else is invalid. */
const SETTINGS_KEYS = ["schemaVersion", "enabled", "marketplaceShelf", "revision"];
export interface ExperimentSettings {
  schemaVersion: "experiments.v1";
  enabled: boolean;
  /** Buyer-side shelf preview; workspace-scoped and off unless explicitly opted in. */
  marketplaceShelf: boolean;
  revision: number;
}
export interface StoredExperiments { settings: ExperimentSettings; valid: boolean }
const initial = (): ExperimentSettings => ({ schemaVersion: "experiments.v1", enabled: false, marketplaceShelf: false, revision: 0 });
const storageError = () => new OrgApiError(errorCodes.experiments_storage_failed, 500, "experimental settings could not be stored safely");

/** Reads do not create files. Every existing ancestor must be a real directory. */
async function directories(workspace: string, create: boolean): Promise<boolean> {
  let current = path.resolve(workspace);
  for (const segment of ["", ".roleweave"]) {
    current = segment === "" ? current : path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw storageError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw storageError();
      if (!create) return false;
      if (segment === "") throw storageError();
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw storageError(); }
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw storageError();
    }
  }
  return true;
}

export async function readExperiments(workspace: string): Promise<StoredExperiments> {
  try {
    if (!await directories(workspace, false)) return { settings: initial(), valid: true };
    const file = await readStableBoundedFile(path.join(workspace, EXPERIMENTS_FILE), MAX_BYTES);
    const raw = JSON.parse(decodeStableUtf8(file.buffer)) as ExperimentSettings;
    if (!raw || raw.schemaVersion !== "experiments.v1" || typeof raw.enabled !== "boolean" ||
      !Number.isSafeInteger(raw.revision) || raw.revision < 0 ||
      // Files written before the shelf preview existed have no such key. Absence
      // means off, the same as any other unset preview; only a present non-boolean
      // value is treated as corruption.
      (raw.marketplaceShelf !== undefined && typeof raw.marketplaceShelf !== "boolean") ||
      Object.keys(raw).some(key => !SETTINGS_KEYS.includes(key))) throw storageError();
    return { settings: { ...raw, marketplaceShelf: raw.marketplaceShelf === true }, valid: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: initial(), valid: true };
    // Malformed, unsafe and unreadable settings never revive a persisted opt-in.
    return { settings: initial(), valid: false };
  }
}

export async function writeExperiments(workspace: string, settings: ExperimentSettings, assertCurrent: () => void): Promise<void> {
  await directories(workspace, true);
  const file = path.join(workspace, EXPERIMENTS_FILE);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw storageError();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  assertCurrent();
  await atomicWriteJson(file, settings, MAX_BYTES, {
    ...nodeAtomicTurnWriteOperations,
    async rename(source, target) {
      await directories(workspace, false);
      assertCurrent();
      await fs.rename(source, target);
    },
  }, storageError);
}
