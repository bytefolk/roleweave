import type { ServerResponse } from "node:http";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import type {
  DriveObjectDetailResponse,
  DriveObjectListResponse,
  DriveObjectPreviewResponse,
  DriveProviderStatusResponse,
} from "@roleweave/shared";
import {
  DRIVE_OBJECT_LIST_SCHEMA_VERSION,
  DRIVE_OBJECT_SCHEMA_VERSION,
  DRIVE_OBJECT_PREVIEW_SCHEMA_VERSION,
  DRIVE_PROVIDER_SCHEMA_VERSION,
} from "@roleweave/shared";
import { sendJson } from "../http.js";
import type { ControlPlaneContext } from "../context.js";
import { resolveDriveProvider } from "../services/drive-providers.js";

/**
 * Drive plane routes (MVP surface, pluggable upstream).
 *
 * The workbench deliberately fails closed when the selected provider is not
 * usable; it must never present local fixtures as if they were shared memory.
 * Every provider's upstream response shape is normalized exactly once (see
 * `services/drive-providers.ts`) so the renderer never depends on provider
 * field naming — the frozen `drive-object.v1` wire contract is unchanged.
 * Uploads remain handled by the desktop shell today (main process pickers)
 * and are stubbed at this seam — see /drive/upload below.
 *
 * `GET /drive/provider` reports the selected provider's health. Probing is an
 * explicit, bounded action; the drive reads themselves never spawn the CLI
 * just to decorate a response.
 */

function invalidRequest(message: string): OrgApiError {
  return new OrgApiError(errorCodes.drive_request_invalid, 400, message);
}

/** GET /drive/list?q=<search>: bounded, provider-filtered object list. */
export async function handleDriveList(ctx: ControlPlaneContext, res: ServerResponse, url: URL): Promise<void> {
  const q = url.searchParams.get("q") ?? "";
  if (q.length > 256) {
    throw invalidRequest("q parameter exceeds 256 chars");
  }
  const provider = resolveDriveProvider(ctx);
  const objects = await provider.list(q);
  const body: DriveObjectListResponse = {
    schemaVersion: DRIVE_OBJECT_LIST_SCHEMA_VERSION,
    objects,
    mocked: false,
  };
  sendJson(res, 200, body);
}

/** GET /drive/detail?id=<providerObjectId>. */
export async function handleDriveDetail(ctx: ControlPlaneContext, res: ServerResponse, url: URL): Promise<void> {
  const id = url.searchParams.get("id") ?? "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
    throw invalidRequest("a valid file id is required");
  }
  const provider = resolveDriveProvider(ctx);
  const object = await provider.detail(id);
  const body: DriveObjectDetailResponse = {
    schemaVersion: DRIVE_OBJECT_SCHEMA_VERSION,
    object,
    mocked: false,
  };
  sendJson(res, 200, body);
}

/** GET /drive/preview?id: authenticated bounded raster bytes, no upstream URL. */
export async function handleDrivePreview(ctx: ControlPlaneContext, res: ServerResponse, url: URL): Promise<void> {
  const id = url.searchParams.get("id") ?? "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw invalidRequest("a valid file id is required");
  const provider = resolveDriveProvider(ctx);
  if (!provider.preview) throw new OrgApiError(errorCodes.drive_action_unsupported, 501, "This drive provider does not support image previews");
  const body: DriveObjectPreviewResponse = { schemaVersion: DRIVE_OBJECT_PREVIEW_SCHEMA_VERSION, preview: await provider.preview(id) };
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, 200, body);
}

/** GET /drive/provider: explicit health probe of the selected provider. */
export async function handleDriveProviderStatus(ctx: ControlPlaneContext, res: ServerResponse): Promise<void> {
  const provider = resolveDriveProvider(ctx);
  const status = await provider.probe();
  const body: DriveProviderStatusResponse = {
    schemaVersion: DRIVE_PROVIDER_SCHEMA_VERSION,
    status,
  };
  sendJson(res, 200, body);
}

/** POST /drive/upload: stubbed until the provider upload contracts are pinned. */
export async function handleDriveUpload(res: ServerResponse): Promise<void> {
  // TODO(drive-upload): forward multipart PUT once the per-provider upload
  // paths land with a stable content-type. The renderer already goes through
  // a whitelisted IPC seam so wiring is additive.
  sendJson(res, 202, {
    stub: true,
    message:
      "drive upload seam is stubbed; renderer IPC is wired but per-provider multipart uploads are pending contract sign-off",
  });
}
