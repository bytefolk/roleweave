import type { IncomingMessage, ServerResponse } from "node:http";
import {
  API_VERSION,
  API_VERSION_HEADER,
  OrgApiError,
  errorCodes,
} from "@roleweave/shared";

const MAX_BODY_BYTES = 1024 * 1024;
const READ_SAFETY_CAP = 4 * 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    [API_VERSION_HEADER]: API_VERSION,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof OrgApiError) {
    sendJson(res, err.status, err.toBody());
    return;
  }
  sendJson(
    res,
    500,
    new OrgApiError(errorCodes.internal, 500, "internal control-plane error", false).toBody(),
  );
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const contentLength = req.headers?.["content-length"];
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    await drainRequest(req);
    throw new OrgApiError(errorCodes.body_invalid, 400, "request body exceeds 1 MiB limit");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    chunks.push(buf);
    if (size > READ_SAFETY_CAP) {
      break;
    }
  }

  if (size > MAX_BODY_BYTES) {
    await drainRequest(req);
    throw new OrgApiError(errorCodes.body_invalid, 400, "request body exceeds 1 MiB limit");
  }

  if (chunks.length === 0) {
    throw new OrgApiError(errorCodes.body_invalid, 400, "empty request body");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new OrgApiError(errorCodes.body_invalid, 400, "request body is not valid JSON");
  }
}

async function drainRequest(req: IncomingMessage): Promise<void> {
  try {
    for await (const _ of req) { /* consume remaining body so the client can finish uploading */ }
  } catch { /* client may have closed; nothing to do */ }
}
