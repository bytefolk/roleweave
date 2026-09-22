import fs from "node:fs/promises";
import path from "node:path";
import { OrgApiError, errorCodes } from "@roleweave/shared";

/** RoleWeave-owned workspace metadata lives under one hidden root. The
 * digital-employee applied model remains engine-owned and is intentionally not
 * moved. Existing workspaces are migrated once, before any store opens. */
export const ROLEWEAVE_DIR = ".roleweave";
const LEGACY_ROOT = path.join(".digital-employee", "workbench");

async function realDirectoryOrMissing(target: string): Promise<"directory" | "missing"> {
  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new OrgApiError(errorCodes.workspace_invalid, 422, `workspace metadata path must be a real directory: ${target}`);
    }
    return "directory";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function moveTreeWithoutOverwrite(source: string, target: string): Promise<void> {
  // Validate every destination before descending: mkdir alone follows links.
  await realDirectoryOrMissing(target);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    try {
      await fs.lstat(to);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await moveTreeWithoutOverwrite(from, to);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(from, to);
  }
  const remaining = await fs.readdir(source);
  if (remaining.length === 0) await fs.rmdir(source);
}

/** Atomically adopts the legacy workbench directory when possible. When a new
 * root already contains explicit configuration, non-conflicting legacy trees
 * are moved underneath it; conflicts remain in legacy storage for recovery. */
export async function migrateRoleWeaveState(workspace: string): Promise<void> {
  const root = path.resolve(workspace);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new OrgApiError(errorCodes.workspace_invalid, 422, "workspace must be a real directory");
  }
  const current = path.join(root, ROLEWEAVE_DIR);
  const legacy = path.join(root, LEGACY_ROOT);
  await realDirectoryOrMissing(path.join(root, ".digital-employee"));
  const [currentState, legacyState] = await Promise.all([
    realDirectoryOrMissing(current),
    realDirectoryOrMissing(legacy),
  ]);
  if (legacyState === "missing") return;
  if (currentState === "missing") await fs.rename(legacy, current);
  else await moveTreeWithoutOverwrite(legacy, current);
  await fs.chmod(current, 0o700).catch(() => {});
}

export function roleWeavePath(workspace: string, ...segments: string[]): string {
  return path.join(workspace, ROLEWEAVE_DIR, ...segments);
}
