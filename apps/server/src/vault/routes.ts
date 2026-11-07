import type { IncomingMessage, ServerResponse } from "node:http";
import { OrgApiError, errorCodes, routes } from "@roleweave/shared";
import type { VaultCreateRequest, VaultWriteRequest, VaultRenameRequest, VaultMigrateRequest, VaultPathRequest } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { sendJson } from "../http.js";
import { listVaultNotes, readVaultNote, createVaultNote, writeVaultNote, renameVaultNote, archiveVaultNote, deleteVaultNote, migrateLegacyVaultNote, vaultBindings, bindVaultNotes, vaultSource, resolveVaultNote, readVaultImage, readVaultHistory } from "./store.js";
import { readVaultUsage } from "./receipts.js";

function invalid(): never { throw new OrgApiError(errorCodes.vault_request_invalid, 400, "Invalid vault request"); }
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(raw, key)) || Object.keys(raw).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return raw;
}
function text(value: unknown): string { if (typeof value !== "string") invalid(); return value; }
function booleanQuery(value: string | null): boolean | undefined { if (value === null) return undefined; if (value === "true" || value === "1") return true; if (value === "false" || value === "0") return false; return invalid(); }
const paths = new Set<string>([routes.vaultList, routes.vaultRead, routes.vaultCreate, routes.vaultWrite, routes.vaultRename, routes.vaultArchive, routes.vaultRestore, routes.vaultDelete, routes.vaultMigrate, routes.vaultBindings, routes.vaultSource, routes.vaultResolve, routes.vaultImage, routes.vaultHistory, routes.vaultUsed]);
async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += bytes.length; if (length > 8 * 1024 * 1024) invalid(); chunks.push(bytes); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T; } catch { return invalid(); }
}

/** Called after the control plane's existing boot bearer guard. */
export async function handleVault(ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!paths.has(url.pathname)) return false;
  const workspace = ctx.workspace.requireOpen(); const method = req.method ?? "GET"; const positionId = url.searchParams.get("positionId") ?? undefined;
  res.setHeader("Cache-Control", "no-store");
  if (url.pathname === routes.vaultList && method === "GET") {
    sendJson(res, 200, await listVaultNotes(workspace, { ...(positionId ? { positionId } : {}), q: url.searchParams.get("q") ?? "", archived: booleanQuery(url.searchParams.get("archived")), includeLegacy: booleanQuery(url.searchParams.get("includeLegacy")) })); return true;
  }
  if (url.pathname === routes.vaultRead && method === "GET") { sendJson(res, 200, await readVaultNote(workspace, url.searchParams.get("noteId") ?? "")); return true; }
  if (url.pathname === routes.vaultHistory && method === "GET") { sendJson(res, 200, await readVaultHistory(workspace, url.searchParams.get("noteId") ?? "")); return true; }
  if (url.pathname === routes.vaultUsed && method === "GET") { sendJson(res, 200, await readVaultUsage(workspace, positionId ?? "", url.searchParams.get("turnId") ?? "")); return true; }
  if (url.pathname === routes.vaultSource && method === "GET") { sendJson(res, 200, await vaultSource(workspace, positionId)); return true; }
  if (url.pathname === routes.vaultBindings && method === "GET") { sendJson(res, 200, await vaultBindings(workspace, positionId)); return true; }
  if (url.pathname === routes.vaultImage && method === "GET") { sendJson(res, 200, await readVaultImage(workspace, url.searchParams.get("path") ?? "", url.searchParams.get("notePath") ?? undefined)); return true; }
  if (url.pathname === routes.vaultCreate && method === "POST") {
    const raw = object(await readJsonBody<unknown>(req), ["path", "content"], ["positionIds", "source"]);
    sendJson(res, 201, await createVaultNote(workspace, raw as unknown as VaultCreateRequest)); return true;
  }
  if (url.pathname === routes.vaultWrite && method === "PUT") {
    const raw = object(await readJsonBody<unknown>(req), ["noteId", "content", "expectedVersion"]);
    sendJson(res, 200, await writeVaultNote(workspace, raw as unknown as VaultWriteRequest)); return true;
  }
  if (url.pathname === routes.vaultRename && method === "POST") {
    const raw = object(await readJsonBody<unknown>(req), ["noteId", "path"], ["expectedVersion"]);
    sendJson(res, 200, await renameVaultNote(workspace, raw as unknown as VaultRenameRequest)); return true;
  }
  if ([routes.vaultArchive, routes.vaultRestore, routes.vaultDelete].includes(url.pathname as typeof routes.vaultArchive) && (method === "POST" || url.pathname === routes.vaultDelete && method === "DELETE")) {
    const raw = object(await readJsonBody<unknown>(req), ["noteId"], ["expectedVersion"]) as unknown as VaultPathRequest;
    const result = url.pathname === routes.vaultDelete ? await deleteVaultNote(workspace, raw) : await archiveVaultNote(workspace, raw, url.pathname === routes.vaultRestore);
    sendJson(res, 200, result); return true;
  }
  if (url.pathname === routes.vaultMigrate && method === "POST") {
    const raw = object(await readJsonBody<unknown>(req), ["noteId", "path", "expectedVersion"]);
    sendJson(res, 200, await migrateLegacyVaultNote(workspace, raw as unknown as VaultMigrateRequest)); return true;
  }
  if (url.pathname === routes.vaultBindings && method === "PUT") {
    const raw = object(await readJsonBody<unknown>(req), ["positionId", "noteIds"]);
    sendJson(res, 200, await bindVaultNotes(workspace, text(raw.positionId), raw.noteIds as string[])); return true;
  }
  if (url.pathname === routes.vaultResolve && method === "POST") {
    const raw = object(await readJsonBody<unknown>(req), ["uri"]); sendJson(res, 200, await resolveVaultNote(workspace, text(raw.uri))); return true;
  }
  throw new OrgApiError(errorCodes.method_not_allowed, 405, "Method not allowed");
}
