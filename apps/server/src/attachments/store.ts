import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { TurnAttachment } from "@roleweave/shared";
import { ATTACHMENT_MAX_SINGLE_BYTES } from "@roleweave/shared";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import { assertSessionId } from "../sessions/store.js";
import { StableReadError, decodeStableUtf8, readStableBoundedFile } from "../stable-read.js";

export const MAX_META_BYTES = 64 * 1024;

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

async function assertNotSymlink(target: string): Promise<void> {
  let st;
  try {
    st = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (st.isSymbolicLink()) {
    throw new OrgApiError(errorCodes.attachment_request_invalid, 400, "attachment path must not be a symlink");
  }
}

async function ensureAttachmentDir(workspace: string, sessionId: string, attachmentId: string): Promise<string> {
  const root = attachmentDir(workspace, sessionId);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await assertNotSymlink(root);
  const dir = path.join(root, attachmentId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await assertNotSymlink(dir);
  await fs.chmod(dir, 0o700);
  return dir;
}

export async function saveAttachment(
  workspace: string,
  sessionId: string,
  meta: TurnAttachment,
  data: Buffer,
): Promise<TurnAttachment> {
  if (meta.sizeBytes !== data.length) {
    throw new OrgApiError(errorCodes.attachment_request_invalid, 400, "attachment size does not match payload");
  }
  const encoded = `${JSON.stringify(meta)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_META_BYTES) {
    throw new OrgApiError(errorCodes.attachment_too_large, 400, "attachment metadata is too large");
  }
  const dir = await ensureAttachmentDir(workspace, sessionId, meta.id);
  const filePath = path.join(dir, "file");
  const metaPath = path.join(dir, "meta.json");
  await assertNotSymlink(filePath);
  await assertNotSymlink(metaPath);

  const tmpFile = path.join(dir, `.file.${crypto.randomUUID()}.tmp`);
  const tmpMeta = path.join(dir, `.meta.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmpFile, data, { mode: 0o600, flag: "wx" });
    await fs.writeFile(tmpMeta, encoded, { mode: 0o600, flag: "wx" });
    await assertNotSymlink(tmpFile);
    await assertNotSymlink(tmpMeta);
    await fs.rename(tmpFile, filePath);
    await fs.rename(tmpMeta, metaPath);
    await assertNotSymlink(filePath);
    await assertNotSymlink(metaPath);
    await fs.chmod(filePath, 0o600);
    await fs.chmod(metaPath, 0o600);
  } catch (error) {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
    await fs.rm(tmpMeta, { force: true }).catch(() => {});
    throw error;
  }
  return meta;
}

function missingAttachment(error: unknown): never {
  if (error instanceof OrgApiError) throw error;
  if (error instanceof StableReadError || (error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new OrgApiError(errorCodes.attachment_missing, 400, "attachment not found");
  }
  throw new OrgApiError(errorCodes.attachment_missing, 400, "attachment metadata is unreadable");
}

export async function readAttachmentMeta(
  workspace: string,
  sessionId: string,
  attachmentId: string,
): Promise<TurnAttachment> {
  const dir = path.join(attachmentDir(workspace, sessionId), attachmentId);
  await assertNotSymlink(dir);
  const metaPath = attachmentMetaPath(workspace, sessionId, attachmentId);
  const filePath = attachmentFilePath(workspace, sessionId, attachmentId);
  await assertNotSymlink(metaPath);
  await assertNotSymlink(filePath);
  let raw: string;
  try {
    const metaRead = await readStableBoundedFile(metaPath, MAX_META_BYTES);
    raw = decodeStableUtf8(metaRead.buffer);
  } catch (error) {
    missingAttachment(error);
  }
  let meta: TurnAttachment;
  try {
    meta = JSON.parse(raw) as TurnAttachment;
  } catch {
    throw new OrgApiError(errorCodes.attachment_missing, 400, "attachment metadata is unreadable");
  }
  if (meta.id !== attachmentId) {
    throw new OrgApiError(errorCodes.attachment_missing, 400, "attachment metadata does not match id");
  }
  let fileRead;
  try {
    fileRead = await readStableBoundedFile(filePath, ATTACHMENT_MAX_SINGLE_BYTES);
  } catch (error) {
    missingAttachment(error);
  }
  if (fileRead.bytes !== meta.sizeBytes) {
    throw new OrgApiError(errorCodes.attachment_missing, 400, "attachment file size does not match metadata");
  }
  return meta;
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
