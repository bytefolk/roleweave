#!/usr/bin/env node
/**
 * qoder-engine: implements the pinned digital-employee CLI surface
 * (`--version`, `hire validate <file> --json`, `org apply <ws> --json`,
 * `turn run <ws> --position <id> --stdin`)
 * on top of the qoder CLI, so org-workbench is directly runnable with Qoder as
 * the agent host. Contract mirroring: engine.v1 / workspace-org semantics are
 * frozen elsewhere; this adapter only translates, never invents.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { resolveQoderExecutable } from "../src/qoder-binary.js";
import { resolveClaudeExecutable } from "../src/claude-binary.js";

const VERSION = "0.2.0";
const POSITION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const QODER_PERMISSION_MODES = new Set([
  "default",
  "accept_edits",
  "bypass_permissions",
  "dont_ask",
  "auto",
]);
const QODER_CHILD_ENV_KEYS = [
  "PATH",
  // Non-credential Windows process-startup keys: PATHEXT/ComSpec let cmd.exe
  // interpret .cmd launcher scripts, and SystemRoot/WINDIR are required for
  // child process creation. They mirror runtimeExecutableEnvironment.
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

function qoderChildEnvironment(source) {
  const environment = {};
  for (const key of QODER_CHILD_ENV_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}

const CLAUDE_CODE_CHILD_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

const CLAUDE_LOCAL_CHILD_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "DIGITAL_EMPLOYEE_CLAUDE_COMMAND",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

function claudeChildEnvironment(source, engineModel) {
  const keys = engineModel === "claude-local" ? CLAUDE_LOCAL_CHILD_ENV_KEYS : CLAUDE_CODE_CHILD_ENV_KEYS;
  const environment = {};
  for (const key of keys) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}

const CLAUDE_VERSION_MIN = [2, 1, 214];
const CLAUDE_VERSION_MAX = [2, 2, 0];

function parseClaudeVersion(announced) {
  if (typeof announced !== "string") return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(announced);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (parts.some((p) => !Number.isSafeInteger(p) || p < 0)) return null;
  return parts;
}

function isClaudeVersionSupported(parts) {
  for (let i = 0; i < 3; i++) {
    if (parts[i] < CLAUDE_VERSION_MIN[i]) return false;
    if (parts[i] > CLAUDE_VERSION_MIN[i]) break;
  }
  for (let i = 0; i < 3; i++) {
    if (parts[i] > CLAUDE_VERSION_MAX[i]) return false;
    if (parts[i] < CLAUDE_VERSION_MAX[i]) break;
  }
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== CLAUDE_VERSION_MAX[i]) return true;
  }
  return false;
}

/*
 * The Windows CMD escaping below is adapted from cross-spawn 7.0.6
 * (MIT; Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>):
 * https://github.com/moxystudio/node-cross-spawn
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions: the
 * above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED
 * "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
 * PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * qoder-engine is a standalone packaged entrypoint, so the escaping stays
 * local instead of adding a third-party runtime dependency just for .cmd/.bat
 * launchers.
 */
const WINDOWS_CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;
const WINDOWS_CMD_SHIM_PATTERN = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

function escapeWindowsCommand(value) {
  return String(value).replace(WINDOWS_CMD_META_CHARS, "^$1");
}

function escapeWindowsArgument(value, doubleEscapeMetaChars = false) {
  let argument = String(value);
  argument = argument.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  argument = argument.replace(/(?=(\\+?)?)\1$/g, "$1$1");
  argument = `"${argument}"`;
  argument = argument.replace(WINDOWS_CMD_META_CHARS, "^$1");
  if (doubleEscapeMetaChars) argument = argument.replace(WINDOWS_CMD_META_CHARS, "^$1");
  return argument;
}

/**
 * Build a child_process.spawn spec without passing raw user input to Node's
 * shell option. Windows batch launchers still require cmd.exe, so the entire
 * command line is escaped and handed to cmd.exe as one verbatim /c argument.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} [platform]
 * @returns {{ command: string, args: string[], options: Record<string, unknown> }}
 */
export function createQoderSpawnSpec(command, args, env, platform = process.platform) {
  const needsWindowsShell = platform === "win32" && /\.(bat|cmd)$/i.test(command);
  if (!needsWindowsShell) {
    return { command, args, options: { env, shell: false } };
  }

  const commandText = escapeWindowsCommand(command);
  const doubleEscapeMetaChars = WINDOWS_CMD_SHIM_PATTERN.test(command);
  const shellCommand = [commandText, ...args.map((arg) => escapeWindowsArgument(arg, doubleEscapeMetaChars))].join(" ");
  return {
    command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    options: {
      env,
      shell: false,
      windowsVerbatimArguments: true,
    },
  };
}
const HIRE_REQUEST_SCHEMA_VERSION = "hire-request.v1alpha1";
const HIRE_REQUEST_MAX_BYTES = 256 * 1024;
const HIRE_ID_MAX_LENGTH = 256;
const HIRE_DIGEST_MIN_LENGTH = 16;
const HIRE_BUDGET_MAX = 1_000_000_000;
const HIRE_PACKAGE_VERSION_PATTERN = /^v1alpha1(\.[0-9]+)?$/;
const HIRE_REQUEST_FIELDS = [
  "schemaVersion",
  "workspaceRef",
  "packageRef",
  "targetParentId",
  "budget",
  "requestedBy",
  "deadline",
  "envelopeDigest",
];
const HIRE_PACKAGE_FIELDS = ["name", "version", "digest"];
const HIRE_BUDGET_FIELDS = ["perTask", "perDay"];
const HIRE_BUDGET_SCOPE_FIELDS = ["tokens", "iterations"];
const HIRE_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/*
 * Static mirror of digital-employee #194/#198 (b3d54bf). The adapter is a
 * standalone packaged entrypoint, so importing an unbuilt workspace package
 * would make the desktop contract depend on source layout. #113 adds only the
 * frozen static validation surface; it does not turn validation into a
 * provider call or replace the later org apply gate. In that pinned contract,
 * envelopeDigest is an opaque sealed-turn reference with minLength 16.
 */

function sha256(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

class HireValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "HireValidationError";
  }
}

function hireError(code, message) {
  return new HireValidationError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertKnownFields(value, allowed, objectPath) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const field = objectPath ? `${objectPath}.${key}` : key;
      throw hireError(`hire_request_unknown_field:${field}`, `unknown field: ${field}`);
    }
  }
}

function assertHireId(value, field) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > HIRE_ID_MAX_LENGTH) {
    throw hireError(`hire_request_invalid_field:${field}`, `${field} must be a non-empty bounded string`);
  }
  return value;
}

function assertHireDigest(value, field) {
  if (typeof value !== "string" || value.length < HIRE_DIGEST_MIN_LENGTH) {
    throw hireError(`hire_request_invalid_field:${field}`, `${field} must be a bounded digest string`);
  }
  return value;
}

function validateHireBudgetScope(value, field) {
  if (!isPlainObject(value)) {
    throw hireError(`hire_request_invalid_field:${field}`, `${field} must be an object`);
  }
  assertKnownFields(value, HIRE_BUDGET_SCOPE_FIELDS, field);
  const scope = {};
  let present = 0;
  for (const key of HIRE_BUDGET_SCOPE_FIELDS) {
    const entry = value[key];
    if (entry === undefined) continue;
    if (!Number.isInteger(entry) || entry < 1 || entry > HIRE_BUDGET_MAX) {
      throw hireError(
        `hire_request_invalid_field:${field}.${key}`,
        `${field}.${key} must be an integer between 1 and ${HIRE_BUDGET_MAX}`,
      );
    }
    scope[key] = entry;
    present += 1;
  }
  if (present === 0) {
    throw hireError(`hire_request_invalid_field:${field}`, `${field} must declare tokens or iterations`);
  }
  return scope;
}

function validateHireBudget(value) {
  if (!isPlainObject(value)) {
    throw hireError("hire_request_invalid_field:budget", "budget must be an object");
  }
  assertKnownFields(value, HIRE_BUDGET_FIELDS, "budget");
  if (value.perTask === undefined || value.perDay === undefined) {
    const missing = value.perTask === undefined ? "perTask" : "perDay";
    throw hireError(`hire_request_invalid_field:budget.${missing}`, `budget.${missing} is required`);
  }
  return {
    perTask: validateHireBudgetScope(value.perTask, "budget.perTask"),
    perDay: validateHireBudgetScope(value.perDay, "budget.perDay"),
  };
}

function validateHirePackageRef(value) {
  if (!isPlainObject(value)) {
    throw hireError("hire_request_invalid_field:packageRef", "packageRef must be an object");
  }
  assertKnownFields(value, HIRE_PACKAGE_FIELDS, "packageRef");
  const name = assertHireId(value.name, "packageRef.name");
  if (typeof value.version !== "string" || !HIRE_PACKAGE_VERSION_PATTERN.test(value.version)) {
    throw hireError("hire_request_invalid_field:packageRef.version", "packageRef.version is invalid");
  }
  return {
    name,
    version: value.version,
    digest: assertHireDigest(value.digest, "packageRef.digest"),
  };
}

function validateHireRequest(raw) {
  if (!isPlainObject(raw)) {
    throw hireError("hire_request_invalid_field:hireRequest", "hire request must be a JSON object");
  }
  assertKnownFields(raw, HIRE_REQUEST_FIELDS, "");
  if (raw.schemaVersion !== HIRE_REQUEST_SCHEMA_VERSION) {
    throw hireError("hire_request_invalid_field:schemaVersion", `schemaVersion must be ${HIRE_REQUEST_SCHEMA_VERSION}`);
  }
  const workspaceRef = assertHireId(raw.workspaceRef, "workspaceRef");
  const packageRef = validateHirePackageRef(raw.packageRef);
  const targetParentId = assertHireId(raw.targetParentId, "targetParentId");
  if (raw.budget === undefined) {
    throw hireError("hire_request_missing_budget", "budget is required");
  }
  const budget = validateHireBudget(raw.budget);
  const requestedBy = assertHireId(raw.requestedBy, "requestedBy");
  let deadline;
  if (raw.deadline !== undefined) {
    if (typeof raw.deadline !== "string" || Number.isNaN(Date.parse(raw.deadline))) {
      throw hireError("hire_request_invalid_field:deadline", "deadline must be a valid ISO 8601 timestamp");
    }
    deadline = raw.deadline;
  }
  const envelopeDigest = assertHireDigest(raw.envelopeDigest, "envelopeDigest");
  return {
    schemaVersion: HIRE_REQUEST_SCHEMA_VERSION,
    workspaceRef,
    packageRef,
    targetParentId,
    budget,
    requestedBy,
    ...(deadline !== undefined ? { deadline } : {}),
    envelopeDigest,
  };
}

function assertHirePathStats(stats) {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw hireError("hire_request_file_unreadable", "hire request must be a regular non-symlink file");
  }
}

function assertHireHandleStats(stats) {
  if (!stats.isFile()) {
    throw hireError("hire_request_file_unreadable", "hire request must be a regular file");
  }
}

function assertHireSize(stats) {
  if (stats.size > BigInt(HIRE_REQUEST_MAX_BYTES)) {
    throw hireError("hire_request_too_large", "hire request exceeds the bounded envelope size");
  }
}

function sameHireSnapshot(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function assertStableHireFile(pathStats, handleStats) {
  if (!sameHireSnapshot(pathStats, handleStats)) {
    throw hireError("hire_request_file_unreadable", "hire request file snapshot changed during validation");
  }
}

/**
 * Read one bounded immutable snapshot of the requested path. `options` exists
 * only as a deterministic test seam; the CLI never accepts or populates it.
 */
export async function readBoundedHireFile(file, options = {}) {
  const fileSystem = options.fileSystem ?? fs;
  const constants = options.constants ?? fsConstants;
  const platform = options.platform ?? process.platform;
  const hooks = options.hooks ?? {};
  let initial;
  try {
    initial = await fileSystem.lstat(file, { bigint: true });
  } catch {
    throw hireError("hire_request_file_unreadable", "hire request file is unreadable");
  }
  assertHirePathStats(initial);
  assertHireSize(initial);

  let handle;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const nonBlock = platform === "win32" ? 0 : (constants.O_NONBLOCK ?? 0);
    const flags = constants.O_RDONLY | noFollow | nonBlock;
    await hooks.beforeOpen?.({ file, flags });
    handle = await fileSystem.open(file, flags);
    await hooks.afterOpen?.({ file, flags, handle });

    const opened = await handle.stat({ bigint: true });
    const pathAfterOpen = await fileSystem.lstat(file, { bigint: true });
    assertHireHandleStats(opened);
    assertHirePathStats(pathAfterOpen);
    assertHireSize(opened);
    assertHireSize(pathAfterOpen);
    assertStableHireFile(initial, opened);
    assertStableHireFile(pathAfterOpen, opened);

    const buffer = Buffer.allocUnsafe(HIRE_REQUEST_MAX_BYTES + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytes,
        buffer.length - totalBytes,
        totalBytes,
      );
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      await hooks.afterReadChunk?.({ file, bytesRead, totalBytes, handle });
    }
    if (totalBytes > HIRE_REQUEST_MAX_BYTES) {
      throw hireError("hire_request_too_large", "hire request exceeds the bounded envelope size");
    }

    const openedAfterRead = await handle.stat({ bigint: true });
    const pathAfterRead = await fileSystem.lstat(file, { bigint: true });
    assertHireHandleStats(openedAfterRead);
    assertHirePathStats(pathAfterRead);
    assertHireSize(openedAfterRead);
    assertHireSize(pathAfterRead);
    assertStableHireFile(opened, openedAfterRead);
    assertStableHireFile(pathAfterRead, openedAfterRead);
    if (openedAfterRead.size !== BigInt(totalBytes)) {
      throw hireError("hire_request_file_unreadable", "hire request file size changed during validation");
    }

    try {
      return HIRE_UTF8_DECODER.decode(buffer.subarray(0, totalBytes));
    } catch {
      throw hireError("hire_request_invalid_json", "hire request must be valid UTF-8 JSON");
    }
  } catch (error) {
    if (error instanceof HireValidationError) throw error;
    throw hireError("hire_request_file_unreadable", "hire request file is unreadable");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function emitHireFailure(code, json) {
  if (json) process.stdout.write(`${JSON.stringify({ status: "failed", code })}\n`);
  else process.stderr.write(`qoder-engine: ${code}\n`);
  process.exitCode = 1;
}

async function hireValidate(file, json) {
  let text;
  try {
    text = await readBoundedHireFile(file);
  } catch (error) {
    if (error instanceof HireValidationError) return emitHireFailure(error.code, json);
    throw error;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return emitHireFailure("hire_request_invalid_json", json);
  }
  try {
    const request = validateHireRequest(raw);
    if (json) process.stdout.write(`${JSON.stringify({ status: "valid", hire: request })}\n`);
    else process.stdout.write(`hire request valid: ${request.packageRef.name}@${request.packageRef.version}\n`);
  } catch (error) {
    if (error instanceof HireValidationError) return emitHireFailure(error.code, json);
    throw error;
  }
}

function now() {
  return new Date().toISOString();
}

async function isRegularFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function readJsonIfPresent(file) {
  try {
    return await readJson(file);
  } catch {
    return null;
  }
}

async function scanPositions(workspaceDir) {
  const root = path.join(workspaceDir, "positions");
  const positions = [];
  const scan = async (dir, id, reportTo) => {
    if (!POSITION_ID_PATTERN.test(id)) throw new Error(`invalid position id: ${id}`);
    positions.push({ id, dir, reportTo });
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.join(dir, entry.name);
      if (!(await isRegularFile(path.join(child, "employee.json")))) continue;
      await scan(child, entry.name, id);
    }
  };
  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const dir = path.join(root, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !(await isRegularFile(path.join(dir, "employee.json")))) {
      throw new Error(`invalid top-level position entry: ${entry.name}`);
    }
    await scan(dir, entry.name, null);
  }
  return positions;
}

async function orgApply(workspaceDir) {
  const declared = await readJson(path.join(workspaceDir, "organization.v1alpha1.json"));
  const runtime = path.join(workspaceDir, ".digital-employee");
  const previousFile = path.join(runtime, "org.json");
  const bootstrapped = !(await isRegularFile(previousFile));
  const previous = bootstrapped ? null : await readJson(previousFile);
  const previousById = new Map((previous?.roles ?? []).map((role) => [role.id, role]));

  const roles = [];
  for (const position of await scanPositions(workspaceDir)) {
    const employee = await readJson(path.join(position.dir, "employee.json"));
    const employeeBytes = await fs.readFile(path.join(position.dir, "employee.json"), "utf8");
    const workbenchPermissions = await readJsonIfPresent(path.join(position.dir, "permissions.json"));
    const budget = await readJson(path.join(position.dir, "budget.json"));
    for (const scope of ["perTask", "perDay"]) {
      if (!Number.isInteger(budget?.[scope]?.tokens) || budget[scope].tokens <= 0) {
        throw new Error(`workspace_org_budget_missing: position ${position.id} budget.${scope}.tokens must be a positive integer`);
      }
    }
    const declaredRole = (declared.roles ?? []).find((role) => role.id === position.id);
    roles.push({
      id: position.id,
      name: declaredRole?.name ?? employee.name ?? position.id,
      description: declaredRole?.description ?? employee.description ?? "",
      reportTo: position.reportTo,
      package: {
        name: employee.name ?? position.id,
        version: employee.version ?? "0.1.0",
        digest: sha256(employeeBytes),
        localReference: position.dir,
      },
      mode: declaredRole?.mode ?? employee?.policy?.mode ?? "approval_required",
      memoryScope: declaredRole?.memoryScope ?? "/",
      toolAllow: declaredRole?.toolAllow ?? (Array.isArray(workbenchPermissions?.tools) ? workbenchPermissions.tools : []),
      toolDeny: declaredRole?.toolDeny ?? [],
      budget,
      metadata: declaredRole?.metadata ?? {},
    });
  }
  if (!roles.some((role) => role.id === declared.owner)) {
    throw new Error(`workspace_org_owner_missing: owner ${declared.owner} not present in positions/`);
  }

  const hired = [];
  const moved = [];
  const dismissed = [];
  const budgetUpdated = [];
  for (const role of roles) {
    const before = previousById.get(role.id);
    if (!before) hired.push(role);
    else {
      if (before.reportTo !== role.reportTo) moved.push({ id: role.id, from: before.reportTo, to: role.reportTo });
      if (JSON.stringify(before.budget) !== JSON.stringify(role.budget)) budgetUpdated.push(role.id);
    }
  }
  for (const [id, before] of previousById) {
    if (!roles.some((role) => role.id === id)) dismissed.push(before);
  }

  const model = {
    $schema: declared.$schema,
    schemaVersion: declared.schemaVersion,
    business: declared.business,
    description: declared.description,
    owner: declared.owner,
    updatedAt: now(),
    positionCount: roles.length,
    roles,
  };
  const orgText = `${JSON.stringify(model, null, 2)}\n`;
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  await fs.writeFile(previousFile, orgText, { mode: 0o600 });
  const auditLine = `${JSON.stringify({
    schemaVersion: "org-audit.v1",
    at: model.updatedAt,
    actor: "qoder-engine org apply",
    workspace: workspaceDir,
    bootstrapped,
    changes: { hired, moved, dismissed, budgetUpdated },
    positionCount: roles.length,
  })}\n`;
  await fs.appendFile(path.join(runtime, "org-audit.jsonl"), auditLine, { mode: 0o600 });
  const permissionsFile = path.join(runtime, "permissions.json");
  if (!(await isRegularFile(permissionsFile))) {
    await fs.writeFile(permissionsFile, `${JSON.stringify({ schemaVersion: "org-permissions.v1", positions: {} }, null, 2)}\n`, { mode: 0o600 });
  }

  console.log(JSON.stringify({
    status: "applied",
    business: declared.business,
    owner: declared.owner,
    bootstrapped,
    positions: roles.length,
    changes: {
      hired: hired.map((role) => role.id),
      moved,
      dismissed: dismissed.map((role) => role.id),
      budgetUpdated,
    },
    organization: sha256(orgText),
    audit: sha256(auditLine),
    permissions: sha256(await fs.readFile(permissionsFile, "utf8")),
  }));
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function turnRun(workspaceDir, positionId) {
  let stdinText = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdinText += chunk;
  });
  process.stdin.on("end", () => {
    let input = "";
    try {
      input = String(JSON.parse(stdinText || "{}")?.input ?? "");
    } catch {
      input = "";
    }
    const engineModel = process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL ?? "qoder";
    switch (engineModel) {
      case "claude-code":
      case "claude-local":
        return turnRunClaude(workspaceDir, positionId, input, engineModel);
      default:
        return turnRunQoder(workspaceDir, positionId, input);
    }
  });
}

function turnRunQoder(workspaceDir, positionId, input) {
  const runId = randomUUID();
  emit({ type: "run.started", runId, timestamp: now() });

    let terminalEmitted = false;
    const fail = (code, message, retryable) => {
      if (terminalEmitted) return;
      terminalEmitted = true;
      emit({
        type: "run.failed",
        runId,
        timestamp: now(),
        error: { code, message: message.slice(0, 2000), retryable, terminalReason: "engine_internal_error" },
      });
      process.exit(0);
    };
    const complete = (output, usage) => {
      if (terminalEmitted) return;
      terminalEmitted = true;
      if (usage) {
        emit({ type: "usage", runId, timestamp: now(), ...usage });
      }
      emit({ type: "run.completed", runId, timestamp: now(), output, terminalReason: "goal_met" });
      process.exit(0);
    };

    const qoderBin = resolveQoderExecutable(process.env);
    if (qoderBin === null) {
      fail("turn_engine_unavailable", "cannot resolve an executable Qoder CLI; install qoder/qodercli/qoderclicn or set ORG_WORKBENCH_QODER_BIN / DIGITAL_EMPLOYEE_QODER_COMMAND", true);
      return;
    }
    const requestedPermissionMode = process.env.ORG_WORKBENCH_QODER_PERMISSION_MODE;
    const permissionMode = requestedPermissionMode === undefined
      ? "dont_ask"
      : QODER_PERMISSION_MODES.has(requestedPermissionMode)
        ? requestedPermissionMode
        : null;
    if (permissionMode === null) {
      fail("qoder.permission_mode_invalid", "unsupported Qoder permission mode", false);
      return;
    }
    const args = [
      "-p", "-o", "stream-json", "--no-session-persistence",
      "-w", workspaceDir,
      "--agent", positionId,
      "--permission-mode", permissionMode,
      input || `Execute your position duties for this turn.`,
    ];
    let child;
    try {
      // Adapter controls, Electron runtime switches, boot authority, Context
      // tokens, and arbitrary server configuration stop here. Qoder and any
      // MCP descendants receive only their explicit runtime/credential contract.
      const qoderEnvironment = qoderChildEnvironment(process.env);
      const spawnSpec = createQoderSpawnSpec(qoderBin, args, qoderEnvironment);
      child = spawn(spawnSpec.command, spawnSpec.args, {
        ...spawnSpec.options,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      fail("turn_engine_unavailable", "cannot spawn the resolved Qoder CLI; install qoder/qodercli/qoderclicn or check ORG_WORKBENCH_QODER_BIN / DIGITAL_EMPLOYEE_QODER_COMMAND", true);
      return;
    }

    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    let stderrTail = "";
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-2000);
    });

    function handleLine(line) {
      if (terminalEmitted || line.trim().length === 0) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.type === "assistant" && Array.isArray(event?.message?.content)) {
        for (const block of event.message.content) {
          if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            emit({ type: "model.delta", runId, timestamp: now(), text: block.text });
          }
        }
      }
      if (event?.type === "result") {
        const usage = event?.usage && typeof event.usage === "object"
          ? {
              ...(Number.isInteger(event.usage.input_tokens) ? { inputTokens: event.usage.input_tokens } : {}),
              ...(Number.isInteger(event.usage.output_tokens) ? { outputTokens: event.usage.output_tokens } : {}),
            }
          : null;
        if (event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success")) {
          fail("qoder.result_error", typeof event.result === "string" ? event.result : stderrTail || "qoder reported an error result", false);
        } else {
          complete(typeof event.result === "string" ? event.result : "", usage && Object.keys(usage).length > 0 ? usage : null);
        }
      }
    }

    child.on("error", () => fail(
      "turn_engine_unavailable",
      "cannot spawn the resolved Qoder CLI; install qoder/qodercli/qoderclicn or check ORG_WORKBENCH_QODER_BIN / DIGITAL_EMPLOYEE_QODER_COMMAND",
      true,
    ));
    child.on("close", (code) => {
      if (terminalEmitted) return;
      if (code === 0) {
        complete("");
      } else {
        fail("qoder.exit_nonzero", stderrTail.trim() || `qoder exited with code ${code}`, true);
      }
    });
}

function turnRunClaude(workspaceDir, positionId, input, engineModel) {
  const runId = randomUUID();
  emit({ type: "run.started", runId, timestamp: now() });

  const fail = (code, message, retryable) => {
    emit({
      type: "run.failed",
      runId,
      timestamp: now(),
      error: { code, message: message.slice(0, 2000), retryable, terminalReason: "engine_internal_error" },
    });
    process.exit(0);
  };

  const claudeBin = resolveClaudeExecutable(process.env);
  if (claudeBin === null) {
    fail("claude.binary_unresolved", "cannot resolve an executable Claude Code CLI; install claude or set DIGITAL_EMPLOYEE_CLAUDE_COMMAND", false);
    return;
  }

  const versionProbe = spawnSync(claudeBin, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    killSignal: "SIGKILL",
    shell: false,
    windowsHide: true,
    env: claudeChildEnvironment(process.env, engineModel),
  });
  if (versionProbe.error !== undefined || versionProbe.status !== 0) {
    fail("claude.binary_unresolved", "Claude Code version probe failed; ensure claude is executable and in PATH", false);
    return;
  }
  const versionOutput = typeof versionProbe.stdout === "string" && versionProbe.stdout.trim().length > 0
    ? versionProbe.stdout
    : typeof versionProbe.stderr === "string"
      ? versionProbe.stderr
      : "";
  const versionParts = parseClaudeVersion(versionOutput);
  if (versionParts === null || !isClaudeVersionSupported(versionParts)) {
    const announced = versionParts === null ? "unknown" : versionParts.join(".");
    fail("claude.version_unsupported", `Claude Code version ${announced} is outside the supported window (>= 2.1.214, < 2.2.0)`, false);
    return;
  }

  const safeInput = (input || "Execute your position duties for this turn.").replace(/@/g, "\\u0040");
  const positionContext = `[Position: ${positionId}]\n[Workspace: ${workspaceDir}]\n\n`;
  const args = [
    "--bare",
    "--print",
    "--input-format", "text",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", "dontAsk",
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--max-turns", "1",
  ];

  let child;
  try {
    const childEnv = claudeChildEnvironment(process.env, engineModel);
    const spawnSpec = createQoderSpawnSpec(claudeBin, args, childEnv);
    child = spawn(spawnSpec.command, spawnSpec.args, {
      ...spawnSpec.options,
      cwd: workspaceDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    fail("claude.spawn_failed", "cannot spawn the resolved Claude Code CLI", true);
    return;
  }

  child.stdin.on("error", () => {});
  child.stdin.write(positionContext + safeInput);
  child.stdin.end();

  let buffer = "";
  let initSeen = false;
  let textSnapshot = "";

  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      handleClaudeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  let stderrTail = "";
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-2000);
  });

  function handleClaudeLine(line) {
    if (line.trim().length === 0) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event?.type === "system" && event?.subtype === "init") {
      initSeen = true;
      return;
    }

    if (event?.type === "assistant" && Array.isArray(event?.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          const delta = block.text.length > textSnapshot.length
            ? block.text.slice(textSnapshot.length)
            : block.text;
          textSnapshot = block.text;
          if (delta.length > 0) {
            emit({ type: "model.delta", runId, timestamp: now(), text: delta });
          }
        }
      }
      return;
    }

    if (event?.type === "stream_event" && event?.event?.type === "content_block_delta") {
      const delta = event.event.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        emit({ type: "model.delta", runId, timestamp: now(), text: delta.text });
      }
      return;
    }

    if (event?.type === "result") {
      const usage = event?.usage && typeof event.usage === "object"
        ? {
            ...(Number.isInteger(event.usage.input_tokens) ? { inputTokens: event.usage.input_tokens } : {}),
            ...(Number.isInteger(event.usage.output_tokens) ? { outputTokens: event.usage.output_tokens } : {}),
          }
        : null;
      if (event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success")) {
        const errorCode = event.subtype === "error_max_turns" ? "claude.max_turns_exceeded"
          : event.subtype === "error_max_budget_usd" ? "claude.budget_exceeded"
          : "claude.result_error";
        fail(errorCode, typeof event.result === "string" ? event.result : stderrTail || "Claude Code reported an error result", false);
      } else {
        const output = typeof event.result === "string" ? event.result : "";
        emit({ type: "usage", runId, timestamp: now(), ...usage });
        emit({ type: "run.completed", runId, timestamp: now(), output, terminalReason: "goal_met" });
        process.exit(0);
      }
    }
  }

  child.on("error", () => fail(
    "claude.spawn_failed",
    "cannot spawn the resolved Claude Code CLI; install claude or check DIGITAL_EMPLOYEE_CLAUDE_COMMAND",
    true,
  ));
  child.on("close", (code) => {
    if (code === 0) {
      emit({ type: "run.completed", runId, timestamp: now(), output: "", terminalReason: "goal_met" });
      process.exit(0);
    } else {
      fail("claude.exit_nonzero", stderrTail.trim() || `claude exited with code ${code}`, true);
    }
  });
}

function runCli(argv) {
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(`qoder-engine ${VERSION}`);
  } else if (argv[0] === "hire" && (argv[1] === "--help" || argv[1] === "-h")) {
    console.log("qoder-engine hire validate <file> [--json]\nstatic hire-request.v1alpha1 validation only; no Qoder or provider process is started");
  } else if (
    argv[0] === "hire" &&
    argv[1] === "validate" &&
    typeof argv[2] === "string" &&
    (argv.length === 3 || (argv.length === 4 && argv[3] === "--json"))
  ) {
    hireValidate(argv[2], argv[3] === "--json").catch(() => {
      emitHireFailure("hire_request_file_unreadable", argv[3] === "--json");
    });
  } else if (argv[0] === "org" && argv[1] === "apply" && typeof argv[2] === "string") {
    orgApply(argv[2]).catch((error) => {
      console.log(JSON.stringify({ status: "failed", code: "qoder.org_apply_failed", message: String(error?.message ?? error).slice(0, 2000) }));
      process.exit(0);
    });
  } else if (argv[0] === "turn" && argv[1] === "run" && typeof argv[2] === "string") {
    const positionIndex = argv.indexOf("--position");
    const positionId = positionIndex >= 0 ? argv[positionIndex + 1] : undefined;
    if (!positionId) {
      console.error("qoder-engine: turn run requires --position <id>");
      process.exit(1);
    }
    turnRun(argv[2], positionId);
  } else {
    console.error(`qoder-engine ${VERSION} — digital-employee CLI surface over the qoder CLI\nusage: qoder-engine [--version] | hire validate <file> --json | org apply <workspace> --json | turn run <workspace> --position <id> --stdin`);
    process.exit(argv.length === 0 || argv.includes("--help") || argv.includes("-h") ? 0 : 1);
  }
}

const invokedEntry = process.argv[1];
let invokedDirectly = false;
if (invokedEntry) {
  try {
    invokedDirectly = realpathSync(invokedEntry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    invokedDirectly = false;
  }
}
if (invokedDirectly) {
  runCli(process.argv.slice(2));
}
