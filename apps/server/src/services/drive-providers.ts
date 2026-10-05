import { execFile, type ExecFileException } from "node:child_process";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import type { DriveObject, DriveProviderKind, DriveProviderState, DriveProviderStatus } from "@roleweave/shared";
import { DRIVE_PROVIDER_SCHEMA_VERSION, parseDriveProviderKind } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { requestService, resolveServiceConnection } from "./connections.js";
import { normalizeMemFile } from "./mem-contract.js";

/**
 * Drive provider seam (drive-provider.v1).
 *
 * The drive routes normalize every upstream's records into the frozen
 * `drive-object.v1` shape exactly once, so the renderer never depends on
 * provider field naming. Two providers ship today:
 *
 * - `mem`   — the historical bytefolk/mem HTTP proxy, behavior unchanged.
 * - `bdpan` — Baidu NetDisk through the user-installed third-party `bdpan`
 *   CLI. The CLI is probed, never bundled; credentials stay inside bdpan's
 *   own config; every failure maps to an explicit state or stable error code
 *   (never an empty list, never reflected stderr).
 *
 * Provider selection: `ORG_WORKBENCH_DRIVE_PROVIDER` (`mem` default). The
 * settings UI plumbs the same value later; no renderer change is needed
 * because `drive-object.v1` is untouched.
 */

const BDPAN_LIST_TIMEOUT_MS = 12_000;
const BDPAN_PROBE_TIMEOUT_MS = 5_000;
const BDPAN_MAX_OUTPUT_BYTES = 1024 * 1024;
const BDPAN_MAX_RESULTS = 200;
const BDPAN_SEARCH_PAGE_SIZE = 50;

export interface DriveProvider {
  readonly kind: DriveProviderKind;
  list(query: string): Promise<DriveObject[]>;
  detail(id: string): Promise<DriveObject>;
  probe(): Promise<DriveProviderStatus>;
}

export function resolveDriveProvider(ctx: ControlPlaneContext): DriveProvider {
  const kind = parseDriveProviderKind(process.env.ORG_WORKBENCH_DRIVE_PROVIDER);
  if (kind === null) {
    throw new OrgApiError(
      errorCodes.drive_provider_invalid,
      400,
      "ORG_WORKBENCH_DRIVE_PROVIDER must be one of: mem, bdpan",
    );
  }
  return kind === "bdpan" ? new BdpanDriveProvider() : new MemDriveProvider(ctx);
}

/* ------------------------------------------------------------------ */
/* mem provider — migrated verbatim from the previous drive proxy.     */
/* ------------------------------------------------------------------ */

export class MemDriveProvider implements DriveProvider {
  readonly kind = "mem" as const;

  constructor(private readonly ctx: ControlPlaneContext) {}

  async list(query: string): Promise<DriveObject[]> {
    const raw = await this.fetchMem("/v1/files?limit=200&page=1");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalidMemResponse();
    const files = (raw as Record<string, unknown>).files;
    if (files !== null && !Array.isArray(files)) throw invalidMemResponse();
    // Go's nil []File serializes as null for an empty mem workspace.
    const list = files === null ? [] : (files as unknown[]);
    if (list.length > 200) throw invalidMemResponse();
    return list
      .map(requireMemFile)
      .filter((entry) => query === "" || matches(entry, query));
  }

  async detail(id: string): Promise<DriveObject> {
    const object = requireMemFile(await this.fetchMem(`/v1/files/${encodeURIComponent(id)}`));
    if (object.id !== id) throw invalidMemResponse();
    return object;
  }

  async probe(): Promise<DriveProviderStatus> {
    const connection = resolveServiceConnection(this.ctx, "mem");
    return providerStatus("mem", connection === null ? "not_connected" : "ready");
  }

  private async fetchMem(pathname: string): Promise<unknown> {
    const connection = resolveServiceConnection(this.ctx, "mem");
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
      throw new OrgApiError(errorCodes.drive_upstream_unavailable, 502, "mem upstream unavailable");
    }
  }
}

function invalidMemResponse(): OrgApiError {
  return new OrgApiError(errorCodes.drive_upstream_failed, 502, "mem returned an invalid file response");
}

function requireMemFile(raw: unknown): DriveObject {
  const file = normalizeMemFile(raw);
  if (file === null) throw invalidMemResponse();
  return file;
}

function matches(object: DriveObject, needle: string): boolean {
  const hay = `${object.name} ${object.summary ?? ""}`.toLowerCase();
  return hay.includes(needle.toLowerCase());
}

/* ------------------------------------------------------------------ */
/* bdpan provider — third-party CLI adapter, fail closed.              */
/* ------------------------------------------------------------------ */

export interface BdpanSpawnConfig {
  /** Executable path; probed, never bundled with RoleWeave. */
  command: string;
  /** Arguments inserted before the CLI verb (test seam). */
  prefixArgs?: readonly string[];
}

export function bdpanSpawnConfigFromEnv(): BdpanSpawnConfig {
  const command = process.env.ORG_WORKBENCH_BDPAN_BIN?.trim() || "bdpan";
  return { command };
}

/**
 * Testable runner seam: production spawns the real CLI, tests inject a fake
 * `bdpan` (node fixture). Resolves with bounded stdout; rejects with a
 * classified `OrgApiError` on ENOENT, non-zero exit, timeout, or oversize.
 */
export type BdpanRunner = (args: readonly string[], timeoutMs: number) => Promise<string>;

export class BdpanDriveProvider implements DriveProvider {
  readonly kind = "bdpan" as const;
  private readonly run: BdpanRunner;
  private readonly listTimeoutMs: number;
  private readonly probeTimeoutMs: number;

  constructor(
    spawn: BdpanSpawnConfig = bdpanSpawnConfigFromEnv(),
    runner: BdpanRunner | undefined = undefined,
    timeouts: { listMs?: number; probeMs?: number } = {},
  ) {
    this.listTimeoutMs = timeouts.listMs ?? BDPAN_LIST_TIMEOUT_MS;
    this.probeTimeoutMs = timeouts.probeMs ?? BDPAN_PROBE_TIMEOUT_MS;
    // Keep the trusted executable separate from request-derived arguments.
    // A runner sees CLI arguments only, never an argv array that can select a command.
    this.run = runner ?? ((args, timeoutMs) =>
      defaultBdpanRunner(spawn.command, [...(spawn.prefixArgs ?? []), ...args], timeoutMs));
  }

  async list(query: string): Promise<DriveObject[]> {
    // A leading "-" would be parsed as a CLI option; reject before spawn.
    if (query.startsWith("-")) {
      throw new OrgApiError(errorCodes.drive_request_invalid, 400, "search query cannot start with '-'");
    }
    const stdout = query === ""
      ? await this.run(["ls", "--json"], this.listTimeoutMs)
      : await this.run(["search", query, "--json", "--page-size", String(BDPAN_SEARCH_PAGE_SIZE), "--page", "1"], this.listTimeoutMs);
    const records = parseBdpanRecords(stdout);
    return records.slice(0, BDPAN_MAX_RESULTS).map(toDriveObject);
  }

  async detail(_id: string): Promise<DriveObject> {
    // The bdpan CLI has no by-id lookup; detail requires a resolved path or a
    // session index. Fail loudly instead of guessing from a name substring.
    throw new OrgApiError(
      errorCodes.drive_action_unsupported,
      501,
      "the bdpan provider cannot resolve a drive object by id",
    );
  }

  async probe(): Promise<DriveProviderStatus> {
    let stdout: string;
    try {
      stdout = await this.run(["whoami", "--json"], this.probeTimeoutMs);
    } catch (error) {
      if (error instanceof OrgApiError) {
        if (error.code === errorCodes.drive_upstream_unavailable) {
          return providerStatus("bdpan", "not_installed", "bdpan_cli_missing");
        }
        if (error.code === errorCodes.drive_auth_expired) return providerStatus("bdpan", "auth_expired");
        return providerStatus("bdpan", "error", "bdpan_probe_failed");
      }
      return providerStatus("bdpan", "error", "bdpan_probe_failed");
    }
    return providerStatus("bdpan", classifyWhoami(stdout));
  }
}

function defaultBdpanRunner(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  if (command === undefined || command === "") {
    return Promise.reject(
      new OrgApiError(errorCodes.drive_upstream_unavailable, 502, "the bdpan CLI is not configured"),
    );
  }
  return new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: BDPAN_MAX_OUTPUT_BYTES, windowsHide: true },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error !== null) {
          reject(classifyBdpanSpawnError(error, stdout, stderr));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function classifyBdpanSpawnError(
  error: ExecFileException,
  stdout: string,
  stderr: string,
): OrgApiError {
  const combined = `${stdout}\n${stderr}`;
  // ENOENT-style: the CLI is not installed or not on PATH for this runtime.
  if (error.code === "ENOENT") {
    return new OrgApiError(errorCodes.drive_upstream_unavailable, 502, "the bdpan CLI is not installed or not on PATH");
  }
  if (error.killed || /terminated|timed out/iu.test(String(error.signal ?? ""))) {
    return new OrgApiError(errorCodes.drive_upstream_unavailable, 502, "the bdpan CLI did not answer in time", true);
  }
  if (/token\s+(has\s+)?expired|token 过期/iu.test(combined)) {
    return new OrgApiError(errorCodes.drive_auth_expired, 503, "the bdpan authorization has expired; run bdpan login again", false);
  }
  if (/errno=(?:-7|13045)/iu.test(combined)) {
    return new OrgApiError(errorCodes.drive_upstream_failed, 502, "the bdpan upstream rejected the operation");
  }
  return new OrgApiError(errorCodes.drive_upstream_failed, 502, "the bdpan CLI reported a failure", true);
}

/**
 * bdpan prints human-readable diagnostics before the JSON payload; slice to
 * the first `[` / `{` line and parse from there. Anything unparseable is an
 * upstream failure, never an empty list.
 */
function parseBdpanRecords(stdout: string): BdpanRecord[] {
  const start = stdout.search(/[[{]/u);
  if (start < 0) throw new OrgApiError(errorCodes.drive_upstream_failed, 502, "the bdpan CLI returned no parsable listing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    throw new OrgApiError(errorCodes.drive_upstream_failed, 502, "the bdpan CLI returned an invalid listing");
  }
  // The CLI can exit 0 yet report an upstream failure in its JSON envelope
  // (observed with an endpoint-level rejection: {"code":1,"error":"... errno=-7"}).
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const envelope = parsed as Record<string, unknown>;
    if (envelope.code === 1 && typeof envelope.error === "string") {
      if (/token\s+(has\s+)?expired|token 过期/iu.test(envelope.error)) {
        throw new OrgApiError(errorCodes.drive_auth_expired, 503, "the bdpan authorization has expired; run bdpan login again");
      }
      throw new OrgApiError(errorCodes.drive_upstream_failed, 502, "the bdpan CLI reported a failure");
    }
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).results)
      ? (parsed as Record<string, unknown>).results as unknown[]
      : null;
  if (entries === null) {
    throw new OrgApiError(errorCodes.drive_upstream_failed, 502, "the bdpan CLI returned an unexpected listing shape");
  }
  const records: BdpanRecord[] = [];
  for (const entry of entries) {
    const record = toBdpanRecord(entry);
    if (record !== null) records.push(record);
  }
  return records;
}

interface BdpanRecord {
  id: string;
  name: string;
  size: number;
  isDirectory: boolean;
  createdAt: string;
}

function toBdpanRecord(value: unknown): BdpanRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const fsId = raw.fs_id;
  const name = raw.server_filename;
  const size = raw.size;
  const modifiedAt = typeof raw.server_mtime === "string" ? raw.server_mtime : "";
  const createdAt = typeof raw.server_ctime === "string" && Number.isFinite(Date.parse(raw.server_ctime))
    ? raw.server_ctime
    : modifiedAt;
  if (
    typeof fsId !== "number" || !Number.isSafeInteger(fsId) || fsId < 0 ||
    typeof name !== "string" || name.length === 0 ||
    typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    return null;
  }
  return { id: String(fsId), name, size, isDirectory: raw.isdir === true, createdAt };
}

const BDPAN_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".csv": "text/csv",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeFromBdpanName(name: string, isDirectory: boolean): string {
  if (isDirectory) return "inode/directory";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "application/octet-stream";
  return BDPAN_MIME_BY_EXTENSION[name.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

function toDriveObject(record: BdpanRecord): DriveObject {
  return {
    id: record.id,
    name: record.name,
    size: record.size,
    mime: mimeFromBdpanName(record.name, record.isDirectory),
    createdAt: record.createdAt,
  };
}

function classifyWhoami(stdout: string): DriveProviderState {
  let parsed: unknown = null;
  const start = stdout.search(/[[{]/u);
  if (start >= 0) {
    try { parsed = JSON.parse(stdout.slice(start)); } catch { /* fall through to text matching */ }
  }
  const text = stdout;
  if (/token\s+(has\s+)?expired|token 过期|即将过期/iu.test(text)) return "auth_expired";
  if (typeof parsed === "object" && parsed !== null) {
    const raw = parsed as Record<string, unknown>;
    if (raw.authenticated === false || raw.loggedIn === false || raw.logged_in === false) return "not_connected";
    if (raw.authenticated === true || raw.loggedIn === true || raw.logged_in === true) return "ready";
  }
  if (/未登录|not\s+logged\s+in|未登录状态/iu.test(text)) return "not_connected";
  if (/已登录|logged\s+in|authenticated/iu.test(text)) return "ready";
  return "error";
}

function providerStatus(kind: DriveProviderKind, state: DriveProviderState, reason?: string): DriveProviderStatus {
  return { schemaVersion: DRIVE_PROVIDER_SCHEMA_VERSION, kind, state, ...(reason !== undefined ? { reason } : {}) };
}
