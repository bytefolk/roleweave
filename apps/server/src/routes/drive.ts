import type { ServerResponse } from "node:http";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import type {
  DriveObject,
  DriveObjectDetailResponse,
  DriveObjectListResponse,
} from "@roleweave/shared";
import { sendJson } from "../http.js";
import type { ControlPlaneContext } from "../context.js";
import { requestService, resolveServiceConnection } from "../services/connections.js";
import { normalizeMemFile } from "../services/mem-contract.js";

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

const MEM_PAGE_SIZE = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidResponse(): OrgApiError {
  return new OrgApiError(errorCodes.drive_upstream_failed, 502, "mem returned an invalid file response");
}

function requireMemFile(raw: unknown): DriveObject {
  const file = normalizeMemFile(raw);
  if (file === null) throw invalidResponse();
  return file;
}

async function fetchMem(ctx: ControlPlaneContext, pathname: string): Promise<unknown> {
  const connection = await resolveServiceConnection(ctx, "mem");
  if (connection === null) {
    throw new OrgApiError(
      errorCodes.drive_not_configured,
      503,
      "mem is not configured; connect mem in service settings",
    );
  }
  try {
    const response = await requestService(connection, pathname);
    if (response.status < 200 || response.status >= 300) {
      throw new OrgApiError(
        errorCodes.drive_upstream_failed,
        response.status >= 400 && response.status < 500 ? response.status : 502,
        `mem upstream failed: ${response.status}`,
      );
    }
    return response.body;
  } catch (error) {
    if (error instanceof OrgApiError && error.code === errorCodes.drive_upstream_failed) throw error;
    throw new OrgApiError(
      errorCodes.drive_upstream_unavailable,
      502,
      "mem upstream unavailable",
    );
  }
}

function matches(object: DriveObject, needle: string): boolean {
  const hay = `${object.name} ${object.summary ?? ""}`.toLowerCase();
  return hay.includes(needle.toLowerCase());
}

/** GET /drive/list?q=<search>: mem `/v1/files` with bounded client-side filtering. */
export async function handleDriveList(ctx: ControlPlaneContext, res: ServerResponse, url: URL): Promise<void> {
  const q = url.searchParams.get("q") ?? "";
  if (q.length > 256) {
    throw new OrgApiError(errorCodes.drive_request_invalid, 400, "q parameter exceeds 256 chars");
  }
  // mem does not support a `q` filter on /files. Keep this text filter local
  // to the bounded page; semantic retrieval belongs to its /search API.
  const raw = await fetchMem(ctx, `/v1/files?limit=${MEM_PAGE_SIZE}&page=1`);
  if (!isRecord(raw) || (raw.files !== null && !Array.isArray(raw.files))) throw invalidResponse();
  // Go's nil []File serializes as null for an empty mem workspace.
  const list = raw.files === null ? [] : raw.files as unknown[];
  if (list.length > MEM_PAGE_SIZE) throw invalidResponse();
  const objects = list
    .map(requireMemFile)
    .filter((entry) => q === "" || matches(entry, q));
  const body: DriveObjectListResponse = {
    schemaVersion: "drive-object-list.v1",
    objects,
    mocked: false,
  };
  sendJson(res, 200, body);
}

/** GET /drive/detail?id=<memFileId>. */
export async function handleDriveDetail(ctx: ControlPlaneContext, res: ServerResponse, url: URL): Promise<void> {
  const id = url.searchParams.get("id") ?? "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
    throw new OrgApiError(errorCodes.drive_request_invalid, 400, "a valid file id is required");
  }
  const object = requireMemFile(await fetchMem(ctx, `/v1/files/${encodeURIComponent(id)}`));
  if (object.id !== id) throw invalidResponse();
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
