import type { IncomingMessage, ServerResponse } from "node:http";
import {
  API_VERSION,
  API_VERSION_HEADER,
  OrgApiError,
  errorCodes,
} from "@roleweave/shared";

const MAX_BODY_BYTES = 1024 * 1024;
const DRAIN_BYTE_CAP = 10 * 1024 * 1024;
const DRAIN_TIMEOUT_MS = 2000;

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
  const clHeader = req.headers?.["content-length"];
  if (clHeader !== undefined) {
    const cl = Number(clHeader);
    if (Number.isSafeInteger(cl) && cl > MAX_BODY_BYTES) {
      await drainRequest(req);
      throw new OrgApiError(errorCodes.body_invalid, 400, "request body exceeds 1 MiB limit");
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(), DRAIN_TIMEOUT_MS);
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size <= MAX_BODY_BYTES) chunks.push(buf);
    }
  } finally {
    clearTimeout(timer);
  }

  if (size > MAX_BODY_BYTES) {
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
  return new Promise<void>((resolve) => {
    let drained = 0;
    const timer = setTimeout(() => {
      req.destroy();
      resolve();
    }, DRAIN_TIMEOUT_MS);
    req.on("data", (chunk: Buffer) => {
      drained += chunk.length;
      if (drained > DRAIN_BYTE_CAP) {
        clearTimeout(timer);
        req.destroy();
        resolve();
      }
    });
    req.on("end", () => {
      clearTimeout(timer);
      resolve();
    });
    req.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    req.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
    req.resume();
  });
}
