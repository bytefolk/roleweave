import type { ServerResponse } from "node:http";
import {
  DOC_PLANE_DETAIL_SCHEMA_VERSION,
  DOC_PLANE_LIST_SCHEMA_VERSION,
  OrgApiError,
  errorCodes,
} from "@roleweave/shared";
import type {
  DocPlaneDetailResponse,
  DocPlaneListEntry,
  DocPlaneListResponse,
} from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { sendJson } from "../http.js";

/**
 * External doc-plane bridge (#35 R2 MVP).
 *
 * The desktop renderer talks to bytefolk/doc through this thin proxy so the
 * upstream Bearer PAT and any CORS restrictions stay on the shell side. The
 * proxy owns three fail-closed behaviours:
 *
 *  1. When `ORG_WORKBENCH_DOC_URL` or its Bearer PAT is unset the routes short-circuit with
 *     `doc_plane_unconfigured` (503) so the UI can surface a configuration
 *     guide instead of an opaque network error.
 *  2. When the upstream is reachable but returns a 5xx / times out, the
 *     proxy maps it to `doc_plane_unavailable` (502) — retryable=true.
 *  3. When `ORG_WORKBENCH_DOC_MOCK=1` the proxy short-circuits to a bundled
 *     fixture (source="mock" in the response body). The real adapter follows
 *     bytefolk/doc's documented `/api/v1/documents` list and detail routes;
 *     detail content is TipTap JSON and is flattened for the local viewer.
 *
 * The proxy never mutates upstream state — it only wraps `GET /api/v1/me`
 * -equivalent list + detail reads.
 */

const UPSTREAM_TIMEOUT_MS = 8_000;
const MAX_QUERY_LEN = 200;

// Mock fixture — deliberately small and deterministic; anchor for the
// vitest end-to-end test. TODO(#35 R3): drop once we hit the real upstream.
const MOCK_FIXTURE: readonly DocPlaneListEntry[] = [
  {
    id: "mock-doc-1",
    title: "Runbook (mock)",
    icon: "📘",
    updatedAt: "2026-08-27T00:00:00.000Z",
    starred: true,
  },
  {
    id: "mock-doc-2",
    title: "Onboarding guide (mock)",
    icon: null,
    updatedAt: "2026-08-26T09:15:00.000Z",
    starred: false,
  },
];

const MOCK_CONTENT: Record<string, string> = {
  "mock-doc-1":
    "# Runbook (mock)\n\nThis payload came from the bundled mock fixture — `ORG_WORKBENCH_DOC_MOCK=1` is on or `ORG_WORKBENCH_DOC_URL` is not configured.\n\n- Configure `ORG_WORKBENCH_DOC_URL=http://localhost:3100` to hit a real bytefolk/doc.\n- Configure `ORG_WORKBENCH_DOC_TOKEN=doc_pat_...` to authenticate.\n",
  "mock-doc-2":
    "# Onboarding guide (mock)\n\nSecond fixture. TODO(#35 R3): remove once upstream `/api/v1/documents/:id` is stable and we can serve real content.\n",
};

function requireConfigured(ctx: ControlPlaneContext): void {
  if (ctx.config.docPlaneMock) return;
  if (
    typeof ctx.config.docPlaneUrl !== "string" ||
    ctx.config.docPlaneUrl.length === 0 ||
    typeof ctx.config.docPlaneToken !== "string" ||
    ctx.config.docPlaneToken.length === 0
  ) {
    throw new OrgApiError(
      errorCodes.doc_plane_unconfigured,
      503,
      "doc plane is not configured (set ORG_WORKBENCH_DOC_URL and ORG_WORKBENCH_DOC_TOKEN, or ORG_WORKBENCH_DOC_MOCK=1)",
      false,
    );
  }
}

function filterMock(query: string): DocPlaneListEntry[] {
  if (query === "") return [...MOCK_FIXTURE];
  const needle = query.toLowerCase();
  return MOCK_FIXTURE.filter((entry) => entry.title.toLowerCase().includes(needle));
}

function invalidRequest(message: string): OrgApiError {
  return new OrgApiError(errorCodes.doc_plane_request_invalid, 400, message, false);
}

/**
 * Best-effort flatten TipTap JSON (`{"type":"doc","content":[...]}`) into a
 * markdown-ish string. Anything unrecognised falls back to an empty string
 * so the walker is fail-open in the face of unknown node kinds.
 */
export function flattenTiptap(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flattenTiptap).join("");
  if (typeof node !== "object") return "";
  const record = node as { type?: unknown; text?: unknown; content?: unknown; attrs?: unknown };
  const type = typeof record.type === "string" ? record.type : "";
  const children = Array.isArray(record.content) ? record.content.map(flattenTiptap).join("") : "";
  const text = typeof record.text === "string" ? record.text : "";
  switch (type) {
    case "text":
      return text;
    case "paragraph":
      return `${children}\n\n`;
    case "heading": {
      const attrs = record.attrs as { level?: unknown } | undefined;
      const level = typeof attrs?.level === "number" && attrs.level >= 1 && attrs.level <= 6 ? attrs.level : 1;
      return `${"#".repeat(level)} ${children}\n\n`;
    }
    case "bulletList":
    case "orderedList":
      return `${children}\n`;
    case "listItem":
      return `- ${children.replace(/\n+$/u, "")}\n`;
    case "hardBreak":
      return "\n";
    case "codeBlock":
      return `\n\`\`\`\n${children}\n\`\`\`\n\n`;
    case "doc":
      return children;
    default:
      return children;
  }
}

interface UpstreamListEntry {
  id?: unknown;
  title?: unknown;
  icon?: unknown;
  updatedAt?: unknown;
  starred?: unknown;
}

function coerceListEntry(raw: unknown): DocPlaneListEntry | null {
  if (raw === null || typeof raw !== "object") return null;
  const item = raw as UpstreamListEntry;
  if (typeof item.id !== "string" || item.id.length === 0) return null;
  if (typeof item.title !== "string") return null;
  if (typeof item.updatedAt !== "string") return null;
  return {
    id: item.id,
    title: item.title,
    icon: typeof item.icon === "string" ? item.icon : null,
    updatedAt: item.updatedAt,
    starred: item.starred === true,
  };
}

async function fetchUpstream(
  ctx: ControlPlaneContext,
  path: string,
): Promise<{ status: number; body: unknown }> {
  // ORG_WORKBENCH_DOC_URL is required by requireConfigured.
  const base = ctx.config.docPlaneUrl!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const headers: Record<string, string> = { accept: "application/json" };
  if (typeof ctx.config.docPlaneToken === "string" && ctx.config.docPlaneToken.length > 0) {
    headers.authorization = `Bearer ${ctx.config.docPlaneToken}`;
  }
  try {
    const response = await fetch(`${base}${path}`, { headers, signal: controller.signal });
    let body: unknown = null;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      body = await response.json().catch(() => null);
    }
    return { status: response.status, body };
  } catch (error) {
    throw new OrgApiError(
      errorCodes.doc_plane_unavailable,
      502,
      `upstream doc plane unreachable: ${(error as Error).message}`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

function upstreamFailure(operation: string, status: number): OrgApiError {
  if (status === 401 || status === 403) {
    return new OrgApiError(
      errorCodes.doc_plane_unavailable,
      502,
      `upstream doc plane authentication failed while reading ${operation} (check ORG_WORKBENCH_DOC_TOKEN and the documents:read scope)`,
      false,
    );
  }
  return new OrgApiError(
    errorCodes.doc_plane_unavailable,
    502,
    `upstream doc plane ${operation} failed with status ${status}`,
    true,
  );
}

export async function handleDocPlaneList(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  requireConfigured(ctx);
  const rawQuery = url.searchParams.get("q") ?? "";
  const query = rawQuery.slice(0, MAX_QUERY_LEN);

  if (ctx.config.docPlaneMock || ctx.config.docPlaneUrl === undefined) {
    const body: DocPlaneListResponse = {
      schemaVersion: DOC_PLANE_LIST_SCHEMA_VERSION,
      source: "mock",
      entries: filterMock(query),
    };
    sendJson(res, 200, body);
    return;
  }

  const entries: DocPlaneListEntry[] = [];
  let cursor: string | null = null;
  // The upstream API is cursor based. Keep the UI complete for normal workspaces
  // while retaining a hard bound if a remote server returns a broken cursor.
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({ limit: "100" });
    if (query.length > 0) params.set("query", query);
    if (cursor !== null) params.set("cursor", cursor);
    const upstream = await fetchUpstream(ctx, `/api/v1/documents?${params.toString()}`);
    if (upstream.status < 200 || upstream.status >= 300) {
      throw upstreamFailure("list", upstream.status);
    }
    const container = upstream.body as { data?: unknown; meta?: { nextCursor?: unknown } } | null;
    const rawEntries = Array.isArray(container?.data) ? (container!.data as unknown[]) : [];
    for (const raw of rawEntries) {
      const coerced = coerceListEntry(raw);
      if (coerced !== null && !entries.some((entry) => entry.id === coerced.id)) entries.push(coerced);
    }
    const nextCursor = container?.meta?.nextCursor;
    if (typeof nextCursor !== "string" || nextCursor.length === 0 || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  const body: DocPlaneListResponse = {
    schemaVersion: DOC_PLANE_LIST_SCHEMA_VERSION,
    source: "upstream",
    entries,
  };
  sendJson(res, 200, body);
}

export async function handleDocPlaneDetail(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  requireConfigured(ctx);
  const id = url.searchParams.get("id") ?? "";
  if (id === "" || id.length > 128) {
    throw invalidRequest("id parameter is required and must be at most 128 characters");
  }

  if (ctx.config.docPlaneMock || ctx.config.docPlaneUrl === undefined) {
    const entry = MOCK_FIXTURE.find((candidate) => candidate.id === id);
    if (entry === undefined) {
      throw new OrgApiError(errorCodes.doc_plane_unavailable, 404, `mock document not found: ${id}`, false);
    }
    const body: DocPlaneDetailResponse = {
      schemaVersion: DOC_PLANE_DETAIL_SCHEMA_VERSION,
      source: "mock",
      id: entry.id,
      title: entry.title,
      icon: entry.icon,
      updatedAt: entry.updatedAt,
      content: MOCK_CONTENT[entry.id] ?? "",
    };
    sendJson(res, 200, body);
    return;
  }

  const upstream = await fetchUpstream(ctx, `/api/v1/documents/${encodeURIComponent(id)}`);
  if (upstream.status === 404) {
    throw new OrgApiError(errorCodes.doc_plane_unavailable, 404, `document not found: ${id}`, false);
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    throw upstreamFailure("detail", upstream.status);
  }
  const container = upstream.body as { data?: unknown } | null;
  const raw = container?.data as
    | { id?: unknown; title?: unknown; icon?: unknown; updatedAt?: unknown; content?: unknown }
    | undefined;
  if (raw === undefined || typeof raw.id !== "string" || typeof raw.title !== "string" || typeof raw.updatedAt !== "string") {
    throw new OrgApiError(
      errorCodes.doc_plane_unavailable,
      502,
      "upstream doc plane detail payload is malformed",
      true,
    );
  }
  const content = flattenTiptap(raw.content).trimEnd();
  const body: DocPlaneDetailResponse = {
    schemaVersion: DOC_PLANE_DETAIL_SCHEMA_VERSION,
    source: "upstream",
    id: raw.id,
    title: raw.title,
    icon: typeof raw.icon === "string" ? raw.icon : null,
    updatedAt: raw.updatedAt,
    content: content.length > 0 ? content : "_upstream doc has no renderable content_",
  };
  sendJson(res, 200, body);
}
