import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OrgApiError, errorCodes, routes } from "@roleweave/shared";
import type { TurnAttachment } from "@roleweave/shared";
import { ATTACHMENT_MAX_SINGLE_BYTES } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { sendJson } from "../http.js";
import { assertSessionId } from "../sessions/store.js";
import { saveAttachment, readAttachmentMeta } from "./store.js";
import {
  assertAttachmentBatch,
  assertAttachmentFileName,
  assertAttachmentId,
  assertAttachmentMimeType,
  assertAttachmentSize,
} from "./validate.js";
import { extractPdfText } from "./extract-pdf.js";

const MAX_UPLOAD_BODY_BYTES = Math.ceil(ATTACHMENT_MAX_SINGLE_BYTES * 1.34) + 4096;
const READ_SAFETY_CAP = MAX_UPLOAD_BODY_BYTES + 64 * 1024;

interface UploadBody {
  sessionId: string;
  fileName: string;
  mimeType: string;
  dataBase64: string;
}

async function readUploadBody(req: IncomingMessage): Promise<UploadBody> {
  const contentLength = req.headers?.["content-length"];
  if (contentLength && Number(contentLength) > MAX_UPLOAD_BODY_BYTES) {
    throw new OrgApiError(errorCodes.attachment_too_large, 400, "upload body exceeds limit");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    chunks.push(buf);
    if (size > READ_SAFETY_CAP) break;
  }
  if (size > MAX_UPLOAD_BODY_BYTES) {
    throw new OrgApiError(errorCodes.attachment_too_large, 400, "upload body exceeds limit");
  }
  if (chunks.length === 0) {
    throw new OrgApiError(errorCodes.attachment_request_invalid, 400, "empty upload body");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as UploadBody;
  } catch {
    throw new OrgApiError(errorCodes.attachment_request_invalid, 400, "upload body is not valid JSON");
  }
}

export async function handleAttachmentUpload(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const body = await readUploadBody(req);

  if (typeof body !== "object" || body === null) {
    throw new OrgApiError(errorCodes.attachment_request_invalid, 400, "upload body must be a JSON object");
  }
  const sessionId = assertSessionId(body.sessionId);
  const fileName = assertAttachmentFileName(body.fileName);
  const mimeType = assertAttachmentMimeType(body.mimeType);
  if (typeof body.dataBase64 !== "string" || body.dataBase64.length === 0) {
    throw new OrgApiError(errorCodes.attachment_request_invalid, 400, "dataBase64 is required");
  }

  let data: Buffer;
  try {
    data = Buffer.from(body.dataBase64, "base64");
  } catch {
    throw new OrgApiError(errorCodes.attachment_request_invalid, 400, "dataBase64 is not valid base64");
  }
  assertAttachmentSize(data.length);
  assertAttachmentBatch([{ sizeBytes: data.length }]);

  const id = crypto.randomUUID();
  let meta: TurnAttachment = {
    id,
    fileName,
    mimeType,
    sizeBytes: data.length,
  };

  if (mimeType === "application/pdf") {
    const extractedText = await extractPdfText(data);
    if (extractedText !== undefined) {
      meta = { ...meta, extractedText };
    }
  }

  await saveAttachment(workspace.dir, sessionId, meta, data);
  sendJson(res, 200, { attachment: meta });
}

export async function handleAttachmentRead(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const sessionId = url.searchParams.get("sessionId");
  const attachmentId = url.searchParams.get("attachmentId");
  if (!sessionId || !attachmentId) {
    throw new OrgApiError(errorCodes.attachment_request_invalid, 400, "sessionId and attachmentId are required");
  }
  assertSessionId(sessionId);
  assertAttachmentId(attachmentId);
  const meta = await readAttachmentMeta(workspace.dir, sessionId, attachmentId);
  sendJson(res, 200, { attachment: meta });
}
