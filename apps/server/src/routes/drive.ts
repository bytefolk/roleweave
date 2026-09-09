import type { ServerResponse } from "node:http";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import type {
  DriveObject,
  DriveObjectDetailResponse,
  DriveObjectListResponse,
} from "@roleweave/shared";
import { sendJson } from "../http.js";

/**
 * Drive plane proxy (MVP) — forwards `list`/`detail` reads to the bytefolk/mem
 * `memd` HTTP API. The workbench deliberately fails closed when mem is not
 * configured; it must never present local fixtures as if they were shared
 * memory. Uploads are handled by the desktop shell today (main process
 * pickers) and are stubbed at this seam — see /drive/upload below.
 *
 * The workbench never re-implements the memory plane. The upstream response
 * shape is normalized once here (mem's `/v1/files` file record → the frozen
 * `drive-object.v1`) so the renderer never depends on mem field naming.
 */

interface MemFileRecord {
  id?: unknown;
  name?: unknown;
  path?: unknown;
  size?: unknown;
  mime?: unknown;
  mime_type?: unknown;
  created_at?: unknown;
  summary?: unknown;
  caption?: unknown;
}

function coerceString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function coerceNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeMemFile(raw: MemFileRecord): DriveObject | null {
  const id = coerceString(raw.id);
  if (id === "") return null;
  const name = coerceString(raw.name, coerceString(raw.path, id));
  const size = coerceNumber(raw.size, 0);
  const mime = coerceString(raw.mime, coerceString(raw.mime_type, "application/octet-stream"));
  const createdAt = coerceString(raw.created_at, new Date(0).toISOString());
  const summary = coerceString(raw.summary, coerceString(raw.caption, ""));
  return {
    id,
    name,
    size,
    mime,
    createdAt,
    ...(summary !== "" ? { summary } : {}),
  };
}

function memUrlFromEnv(): string | null {
  const raw = process.env.MEM_URL ?? process.env.ORG_WORKBENCH_MEM_URL ?? "";
  if (raw.trim() === "") return null;
  return raw.replace(/\/$/, "");
}

function memToken(): string | null {
  const raw = process.env.MEM_TOKEN ?? process.env.ORG_WORKBENCH_MEM_TOKEN ?? "";
  return raw.trim() === "" ? null : raw;
}

async function fetchMem(pathname: string): Promise<{ ok: true; body: unknown } | OrgApiError> {
  const base = memUrlFromEnv();
  if (base === null) {
    return new OrgApiError(
      errorCodes.drive_not_configured,
      503,
      "mem is not configured; set MEM_URL or ORG_WORKBENCH_MEM_URL",
    );
  }
  const url = `${base}${pathname}`;
  const token = memToken();
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      return new OrgApiError(
        errorCodes.drive_upstream_failed,
        response.status,
        `mem upstream failed: ${response.status}`,
      );
    }
    const body = (await response.json()) as unknown;
    return { ok: true, body };
  } catch (err) {
    return new OrgApiError(
      errorCodes.drive_upstream_unavailable,
      502,
      `mem upstream unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function matches(object: DriveObject, needle: string): boolean {
  const hay = `${object.name} ${object.summary ?? ""}`.toLowerCase();
  return hay.includes(needle.toLowerCase());
}

/** GET /drive/list?q=<search>: mem `/v1/files` with bounded client-side filtering. */
export async function handleDriveList(res: ServerResponse, url: URL): Promise<void> {
  const q = url.searchParams.get("q") ?? "";
  if (q.length > 256) {
    throw new OrgApiError(errorCodes.drive_request_invalid, 400, "q parameter exceeds 256 chars");
  }
  const result = await fetchMem("/v1/files?limit=200&page=1");
  if (result instanceof OrgApiError) throw result;
  const raw = result.body as { files?: unknown; items?: unknown };
  const list = Array.isArray(raw.files)
    ? (raw.files as MemFileRecord[])
    : Array.isArray(raw.items)
      ? (raw.items as MemFileRecord[])
      : [];
  const objects = list
    .map((entry) => normalizeMemFile(entry))
    .filter((entry): entry is DriveObject => entry !== null)
    .filter((entry) => q === "" || matches(entry, q));
  const body: DriveObjectListResponse = {
    schemaVersion: "drive-object-list.v1",
    objects,
    mocked: false,
  };
  sendJson(res, 200, body);
}

/** GET /drive/detail?id=<memFileId>. */
export async function handleDriveDetail(res: ServerResponse, url: URL): Promise<void> {
  const id = url.searchParams.get("id") ?? "";
  if (id === "" || id.length > 128) {
    throw new OrgApiError(errorCodes.drive_request_invalid, 400, "id parameter is required");
  }
  const result = await fetchMem(`/v1/files/${encodeURIComponent(id)}`);
  if (result instanceof OrgApiError) throw result;
  const object = normalizeMemFile(result.body as MemFileRecord);
  if (object === null) {
    throw new OrgApiError(errorCodes.asset_not_found, 404, `drive object not found: ${id}`);
  }
  const body: DriveObjectDetailResponse = {
    schemaVersion: "drive-object.v1",
    object,
    mocked: false,
  };
  sendJson(res, 200, body);
}

/** POST /drive/upload: stubbed until the mem multipart contract is pinned. */
export async function handleDriveUpload(res: ServerResponse): Promise<void> {
  // TODO(mem-upload): forward multipart PUT to `/v1/files` once the mem
  // upload path lands with a stable content-type. The renderer already goes
  // through a whitelisted IPC seam so wiring is additive.
  sendJson(res, 202, {
    stub: true,
    message:
      "drive upload seam is stubbed; renderer IPC is wired but multipart PUT to /v1/files is pending contract sign-off",
  });
}
