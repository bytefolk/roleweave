import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { TurnAttachment } from "@roleweave/shared";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import { assertSessionId } from "../sessions/store.js";

const MAX_META_BYTES = 64 * 1024;

export function attachmentDir(workspace: string, sessionId: string): string {
  return path.join(
    workspace,
    ".digital-employee",
    "workbench",
    "sessions",
    assertSessionId(sessionId),
    "attachments",
  );
}

export function attachmentFilePath(workspace: string, sessionId: string, attachmentId: string): string {
  return path.join(attachmentDir(workspace, sessionId), attachmentId, "file");
}

function attachmentMetaPath(workspace: string, sessionId: string, attachmentId: string): string {
  return path.join(attachmentDir(workspace, sessionId), attachmentId, "meta.json");
}

async function ensureAttachmentDir(workspace: string, sessionId: string, attachmentId: string): Promise<string> {
  const dir = path.join(attachmentDir(workspace, sessionId), attachmentId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  return dir;
}

export async function saveAttachment(
  workspace: string,
  sessionId: string,
  meta: TurnAttachment,
  data: Buffer,
): Promise<TurnAttachment> {
  const dir = await ensureAttachmentDir(workspace, sessionId, meta.id);
  const filePath = path.join(dir, "file");
  const metaPath = path.join(dir, "meta.json");

  const tmpFile = path.join(dir, `.file.${crypto.randomUUID()}.tmp`);
  const tmpMeta = path.join(dir, `.meta.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmpFile, data, { mode: 0o600 });
    await fs.writeFile(tmpMeta, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
    await fs.rename(tmpFile, filePath);
    await fs.rename(tmpMeta, metaPath);
    await fs.chmod(filePath, 0o600);
    await fs.chmod(metaPath, 0o600);
  } catch (error) {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
    await fs.rm(tmpMeta, { force: true }).catch(() => {});
    throw error;
  }
  return meta;
}

export async function readAttachmentMeta(
  workspace: string,
  sessionId: string,
  attachmentId: string,
): Promise<TurnAttachment> {
  const metaPath = attachmentMetaPath(workspace, sessionId, attachmentId);
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_META_BYTES) {
      throw new OrgApiError(errorCodes.attachment_missing, 400, "attachment metadata is too large");
    }
    return JSON.parse(raw) as TurnAttachment;
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OrgApiError(errorCodes.attachment_missing, 400, "attachment not found");
    }
    throw new OrgApiError(errorCodes.attachment_missing, 400, "attachment metadata is unreadable");
  }
}

export async function readAttachmentMetas(
  workspace: string,
  sessionId: string,
  attachmentIds: string[],
): Promise<TurnAttachment[]> {
  const metas: TurnAttachment[] = [];
  for (const id of attachmentIds) {
    metas.push(await readAttachmentMeta(workspace, sessionId, id));
  }
  return metas;
}

export async function cleanupSessionAttachments(workspace: string, sessionId: string): Promise<void> {
  const dir = attachmentDir(workspace, sessionId);
  await fs.rm(dir, { recursive: true, force: true });
}
