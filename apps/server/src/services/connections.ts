import { OrgApiError, errorCodes } from "@roleweave/shared";
import type { ExternalServiceKind, ServiceConnectionInput, ServiceConnectionView } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import type { ServerConfig } from "../config.js";

export interface ServiceConnection {
  kind: ExternalServiceKind;
  apiUrl: string;
  webUrl: string;
  token?: string;
  workspaceId?: string;
}
// Runtime overrides belong to a server instance. The desktop owns encrypted persistence.
const overrides = new WeakMap<ServerConfig, Map<ExternalServiceKind, ServiceConnection | null>>();
export const SERVICE_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function invalid(message: string): never {
  throw new OrgApiError(errorCodes.service_request_invalid, 400, message, false);
}
export function serviceKind(value: unknown): ExternalServiceKind {
  if (value !== "doc" && value !== "mem") invalid("service must be doc or mem");
  return value;
}
export function normalizeServiceUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) invalid("a service URL is required");
  let url: URL;
  try { url = new URL(value.trim()); } catch { return invalid("invalid service URL"); }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) invalid("use HTTPS for a remote service, or HTTP on loopback");
  if (url.username || url.password || url.search || url.hash) invalid("service URLs cannot contain credentials, queries or fragments");
  return url.toString().replace(/\/+$/u, "");
}
function optionalField(value: unknown, max: number): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > max || /[\x00-\x20\x7f]/u.test(value)) invalid("invalid credential or workspace value");
  return value;
}
export function hasServiceOverride(ctx: Pick<ControlPlaneContext, "config">, kind: ExternalServiceKind): boolean {
  return overrides.get(ctx.config)?.has(kind) ?? false;
}
export function resolveServiceConnection(ctx: Pick<ControlPlaneContext, "config">, kind: ExternalServiceKind): ServiceConnection | null {
  const map = overrides.get(ctx.config);
  if (map?.has(kind)) return map.get(kind) ?? null;
  const apiUrl = kind === "doc" ? ctx.config.docPlaneUrl : process.env.MEM_URL ?? process.env.ORG_WORKBENCH_MEM_URL;
  if (!apiUrl?.trim()) return null;
  const token = kind === "doc" ? ctx.config.docPlaneToken : process.env.MEM_TOKEN ?? process.env.ORG_WORKBENCH_MEM_TOKEN;
  const webUrl = kind === "doc" ? process.env.ORG_WORKBENCH_DOC_WEB_URL : process.env.ORG_WORKBENCH_MEM_WEB_URL;
  const workspaceId = kind === "mem" ? process.env.ORG_WORKBENCH_MEM_WORKSPACE_ID ?? process.env.MEM_WORKSPACE : undefined;
  try {
    return { kind, apiUrl: normalizeServiceUrl(apiUrl), webUrl: normalizeServiceUrl(webUrl || apiUrl), token, workspaceId };
  } catch {
    // A stale environment value must not prevent configuring a valid replacement.
    return null;
  }
}
export function serviceView(kind: ExternalServiceKind, connection: ServiceConnection | null): ServiceConnectionView {
  return { kind, apiUrl: connection?.apiUrl ?? null, webUrl: connection?.webUrl ?? null,
    workspaceId: connection?.workspaceId ?? null, tokenConfigured: !!connection?.token, configured: connection !== null };
}
export function configureService(ctx: Pick<ControlPlaneContext, "config">, raw: unknown): ServiceConnectionView {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid("invalid connection");
  const input = raw as ServiceConnectionInput;
  const kind = serviceKind(input.kind);
  const apiUrl = normalizeServiceUrl(input.apiUrl);
  const webUrl = normalizeServiceUrl(input.webUrl || apiUrl);
  const previous = resolveServiceConnection(ctx, kind);
  const token = input.token === undefined && previous?.apiUrl === apiUrl ? previous.token : optionalField(input.token, 8192);
  const workspaceId = kind === "mem" ? optionalField(input.workspaceId, 128) : undefined;
  if (workspaceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) invalid("mem workspace must be a UUID");
  let map = overrides.get(ctx.config);
  if (!map) { map = new Map(); overrides.set(ctx.config, map); }
  const connection = { kind, apiUrl, webUrl, token, workspaceId };
  map.set(kind, connection);
  return serviceView(kind, connection);
}
export function disconnectService(ctx: Pick<ControlPlaneContext, "config">, kind: ExternalServiceKind): ServiceConnectionView {
  let map = overrides.get(ctx.config);
  if (!map) { map = new Map(); overrides.set(ctx.config, map); }
  map.set(kind, null);
  return serviceView(kind, null);
}
/** Never follow redirects with a PAT; bound both response time and decoded JSON size. */
export async function requestService(connection: ServiceConnection, pathname: string): Promise<{status: number; body: unknown}> {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\\")) invalid("invalid service API path");
  const base = normalizeServiceUrl(connection.apiUrl);
  const target = new URL(`${base}${pathname}`);
  if (target.origin !== new URL(base).origin) invalid("invalid service API origin");
  const headers: Record<string, string> = { accept: "application/json" };
  if (connection.token) headers.authorization = `Bearer ${connection.token}`;
  if (connection.kind === "mem" && connection.workspaceId) headers["X-Workspace-ID"] = connection.workspaceId;
  try {
    const response = await fetch(target, { headers, redirect: "error", signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS) });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      return { status: response.status, body: null };
    }
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new Error(); }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    if (reader) {
      while (true) {
        const {done, value} = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
    }
    let body: unknown = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* malformed JSON fails contract checks */ }
    return { status: response.status, body };
  } catch {
    // Upstream exception messages can contain URLs or reflected credentials.
    throw new OrgApiError(errorCodes.service_upstream_failed, 502, `${connection.kind} service unavailable, timed out, or returned an unsafe response`, true);
  }
}
