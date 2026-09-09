import fs from "node:fs/promises";
import path from "node:path";
import {
  OrgApiError,
  errorCodes,
  isPositionId,
} from "@roleweave/shared";
import type {
  AuditEntry,
  OrgBackupEntry,
  OrgBackupsResponse,
  OrgRestoreResult,
  OrgRole,
} from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { POSITIONS_DIR, RUNTIME_DIR, scanProposalTree, withOrgMutationLock } from "./apply.js";

const BACKUP_NAME = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(\d{13})-([a-f0-9]{6})$/;
const MAX_AUDIT_BYTES = 16 * 1024 * 1024;

interface BackupProvenance {
  role: OrgRole;
  dismissedAt: string;
}

export async function listOrgBackups(ctx: ControlPlaneContext): Promise<OrgBackupsResponse> {
  const ws = ctx.workspace.requireOpen();
  const root = path.join(ws.dir, RUNTIME_DIR, "backup");
  let entries;
  try {
    await assertSafeDirectory(path.join(ws.dir, RUNTIME_DIR), "organization runtime directory is unsafe");
    await assertSafeDirectory(root, "organization backup directory is unsafe");
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: "org-backups.v1", backups: [] };
    }
    throw restoreError(500, "organization backup directory is unreadable");
  }
  const provenance = await readDismissalProvenance(ws.dir);
  const backups: OrgBackupEntry[] = [];
  for (const entry of entries) {
    const parsed = parseBackupId(entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || parsed === null) {
      throw restoreError(500, "organization backup directory contains an unsafe entry");
    }
    const employee = await fs.lstat(path.join(root, entry.name, "employee.json")).catch(() => null);
    if (!employee?.isFile() || employee.isSymbolicLink()) {
      throw restoreError(500, "organization backup is missing a regular employee package");
    }
    const source = provenance.get(parsed.positionId);
    if (!source) throw restoreError(500, "organization backup has no dismissal provenance");
    backups.push({
      backupId: entry.name,
      positionId: parsed.positionId,
      dismissedAt: source.dismissedAt,
      reportTo: source.role.reportTo,
      name: source.role.name,
    });
  }
  backups.sort((left, right) => right.backupId.localeCompare(left.backupId, "en"));
  return { schemaVersion: "org-backups.v1", backups };
}

export async function restoreOrgBackup(
  ctx: ControlPlaneContext,
  rawBody: unknown,
): Promise<{ status: number; body: OrgRestoreResult }> {
  const ws = ctx.workspace.requireOpen();
  const backupId = parseRestoreBody(rawBody);
  return withOrgMutationLock(ws.dir, () => restoreUnlocked(ctx, backupId));
}

async function restoreUnlocked(
  ctx: ControlPlaneContext,
  backupId: string,
): Promise<{ status: number; body: OrgRestoreResult }> {
  const ws = ctx.workspace.requireOpen();
  const parsed = parseBackupId(backupId);
  if (!parsed) throw restoreError(400, "backupId is invalid");
  const provenance = (await readDismissalProvenance(ws.dir)).get(parsed.positionId);
  if (!provenance) throw restoreError(422, "backup has no dismissal provenance");
  const source = path.join(ws.dir, RUNTIME_DIR, "backup", backupId);
  await assertSafeDirectory(path.join(ws.dir, RUNTIME_DIR), "organization runtime directory is unsafe");
  await assertSafeDirectory(path.join(ws.dir, RUNTIME_DIR, "backup"), "organization backup directory is unsafe");
  const proposal = await scanProposalTree(ws.dir);
  const proposed = proposal.find((position) => position.id === parsed.positionId);
  const applied = ws.organization.roles.find((role) => role.id === parsed.positionId);
  const sourceStat = await fs.lstat(source).catch(() => null);

  if (sourceStat === null && applied) {
    return {
      status: 200,
      body: {
        status: "applied",
        backupId,
        positionId: parsed.positionId,
        restored: false,
        version: ws.version,
      },
    };
  }
  if (sourceStat !== null && (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())) {
    throw restoreError(422, "backup source is not a safe directory");
  }
  if (sourceStat !== null && (applied || proposed)) {
    throw new OrgApiError(errorCodes.restore_conflict, 409, "restore target already exists");
  }
  if (sourceStat === null && !proposed) {
    throw new OrgApiError(errorCodes.restore_invalid, 404, "backup no longer exists");
  }

  if (sourceStat !== null) {
    const parent = provenance.role.reportTo === null
      ? null
      : proposal.find((position) => position.id === provenance.role.reportTo);
    if (provenance.role.reportTo !== null && !parent) {
      throw new OrgApiError(errorCodes.restore_conflict, 409, "restore parent no longer exists");
    }
    const destination = path.join(parent?.directory ?? path.join(ws.dir, POSITIONS_DIR), parsed.positionId);
    const destinationStat = await fs.lstat(destination).catch(() => null);
    if (destinationStat !== null) {
      throw new OrgApiError(errorCodes.restore_conflict, 409, "restore target already exists");
    }
    await fs.rename(source, destination);
  }

  const engineResult = await ctx.driver.apply(ws.dir);
  if (engineResult.status === "engine_unavailable") {
    return failed(errorCodes.engine_unavailable, engineResult.message, true, 503);
  }
  if (engineResult.status === "engine_capability_missing") {
    return failed(errorCodes.engine_capability_missing, engineResult.message, false, 503);
  }
  if (engineResult.status === "failed") {
    return failed(engineResult.code, engineResult.message, engineResult.retryable, 422);
  }
  const version = await ctx.workspace.reloadAppliedOrganization();
  ctx.bus.publish("org.updated", {
    workspace: ws.dir,
    version,
    changes: engineResult.result?.changes ?? [{ op: "restore", id: parsed.positionId }],
  });
  return {
    status: 200,
    body: {
      status: "applied",
      backupId,
      positionId: parsed.positionId,
      restored: true,
      version,
    },
  };
}

function failed(code: string, message: string, retryable: boolean, status: number) {
  return { status, body: { status: "failed" as const, code, message, retryable } };
}

function parseRestoreBody(rawBody: unknown): string {
  if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw restoreError(400, "restore request must be a JSON object");
  }
  const record = rawBody as Record<string, unknown>;
  if (Object.keys(record).join(",") !== "backupId" || typeof record.backupId !== "string") {
    throw restoreError(400, "restore request accepts exactly backupId");
  }
  return record.backupId;
}

function parseBackupId(backupId: string): { positionId: string } | null {
  const match = BACKUP_NAME.exec(backupId);
  if (!match || !isPositionId(match[1])) return null;
  return { positionId: match[1] };
}

async function readDismissalProvenance(workspaceDir: string): Promise<Map<string, BackupProvenance>> {
  await assertSafeDirectory(path.join(workspaceDir, RUNTIME_DIR), "organization runtime directory is unsafe");
  const file = path.join(workspaceDir, RUNTIME_DIR, "org-audit.jsonl");
  let text: string;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_AUDIT_BYTES) {
      throw restoreError(500, "organization audit is not a bounded regular file");
    }
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    throw restoreError(500, "organization audit is unavailable");
  }
  const result = new Map<string, BackupProvenance>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Partial<AuditEntry>;
    try {
      entry = JSON.parse(line) as Partial<AuditEntry>;
    } catch {
      throw restoreError(500, "organization audit is invalid");
    }
    if (entry.schemaVersion !== "org-audit.v1" || typeof entry.at !== "string" || !Array.isArray(entry.changes?.dismissed)) {
      throw restoreError(500, "organization audit is invalid");
    }
    for (const role of entry.changes.dismissed) {
      if (!isPositionId(role.id) || typeof role.name !== "string") {
        throw restoreError(500, "organization dismissal provenance is invalid");
      }
      result.set(role.id, { role, dismissedAt: entry.at });
    }
  }
  return result;
}

async function assertSafeDirectory(directory: string, message: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw restoreError(500, message);
}

function restoreError(status: number, message: string): OrgApiError {
  return new OrgApiError(errorCodes.restore_invalid, status, message);
}
