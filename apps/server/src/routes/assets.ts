import crypto from "node:crypto";
import {
  ASSET_RECORD_SCHEMA_VERSION,
  ASSETS_LIST_SCHEMA_VERSION,
  OrgApiError,
  errorCodes,
  isPositionId,
} from "@roleweave/shared";
import type { AssetRecord, AssetsCreateRequest, AssetsListResponse } from "@roleweave/shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  appendAssetIndex,
  isAssetIdShape,
  listAssetRecords,
  readAssetRecord,
  writeAssetRecord,
} from "../assets/store.js";
import type { ControlPlaneContext } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";

/**
 * Asset-layer foundation routing (#36 S1, DS-36-001 rev-1 §5).
 *
 * Pure consumption of the #35 S4 frozen pieces: records are validated by the
 * shared asset-record.v1 exactKeys parser, persistence goes through the
 * shared drive store (0600/0700, atomic writes, bounded counts), and the
 * create entrypoint only admits the non-document kinds — `doc` assets stay
 * produced exclusively by document creation so there is exactly one document
 * landing path. No index/search surface here (S2).
 */

const MAX_ASSET_TITLE_LENGTH = 256;
const MAX_SOURCE_REF_VALUE_LENGTH = 512;

function invalidRequest(message: string): OrgApiError {
  return new OrgApiError(errorCodes.asset_request_invalid, 400, message);
}

export async function handleAssetsList(ctx: ControlPlaneContext, res: ServerResponse): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const assets = await listAssetRecords(workspace.dir);
  const body: AssetsListResponse = {
    schemaVersion: ASSETS_LIST_SCHEMA_VERSION,
    assets,
  };
  sendJson(res, 200, body);
}

export async function handleAssetsRead(ctx: ControlPlaneContext, res: ServerResponse, url: URL): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const assetId = url.searchParams.get("asset") ?? "";
  if (!isAssetIdShape(assetId)) {
    throw invalidRequest("asset parameter must be a lowercase uuid");
  }
  const record = await readAssetRecord(workspace.dir, assetId);
  sendJson(res, 200, record);
}

function parseCreateRequest(raw: unknown): Required<Pick<AssetsCreateRequest, "kind" | "title">> & {
  sourceRef: AssetRecord["sourceRef"];
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidRequest("body must be an object");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "kind,sourceRef,title" && keys !== "kind,title") {
    throw invalidRequest("body must carry exactly {kind, title, sourceRef?}");
  }
  if (record.kind !== "conversation-excerpt" && record.kind !== "decision") {
    throw invalidRequest("kind outside the create allowlist (doc assets land via document creation)");
  }
  if (typeof record.title !== "string" || record.title.length === 0 || record.title.length > MAX_ASSET_TITLE_LENGTH) {
    throw invalidRequest(`title must be a non-empty string of at most ${MAX_ASSET_TITLE_LENGTH} characters`);
  }
  const sourceRef: AssetRecord["sourceRef"] = {};
  if (record.sourceRef !== undefined) {
    if (record.sourceRef === null || typeof record.sourceRef !== "object" || Array.isArray(record.sourceRef)) {
      throw invalidRequest("sourceRef must be an object");
    }
    const source = record.sourceRef as Record<string, unknown>;
    const sourceKeys = Object.keys(source);
    if (sourceKeys.length === 0) {
      throw invalidRequest("sourceRef must carry at least one provenance field or be omitted");
    }
    if (sourceKeys.some((key) => !["sessionId", "positionId", "conversationRef"].includes(key))) {
      throw invalidRequest("sourceRef has unexpected keys");
    }
    for (const key of sourceKeys) {
      const value = source[key];
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_SOURCE_REF_VALUE_LENGTH) {
        throw invalidRequest(`sourceRef.${key} must be a bounded non-empty string`);
      }
      if (key === "positionId" && !isPositionId(value)) {
        throw invalidRequest("sourceRef.positionId violates the frozen position id contract");
      }
      sourceRef[key as keyof AssetRecord["sourceRef"]] = value;
    }
  }
  return { kind: record.kind, title: record.title, sourceRef };
}

export async function handleAssetsCreate(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const workspace = ctx.workspace.requireOpen();
  const { kind, title, sourceRef } = parseCreateRequest(await readJsonBody<unknown>(req));

  const record: AssetRecord = {
    schemaVersion: ASSET_RECORD_SCHEMA_VERSION,
    assetId: crypto.randomUUID(),
    kind,
    title,
    createdAt: new Date().toISOString(),
    sourceRef,
  };
  await writeAssetRecord(workspace.dir, record);
  await appendAssetIndex(workspace.dir, {
    assetId: record.assetId,
    kind: record.kind,
    title: record.title,
    createdAt: record.createdAt,
  });
  sendJson(res, 201, record);
}
