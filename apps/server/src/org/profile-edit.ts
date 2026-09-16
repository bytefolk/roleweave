/**
 * In-place employee profile update.
 *
 * `POST /hire` is the only creation channel, and until now nothing governed the
 * record afterwards. An operator who bound the wrong Skills — or typo'd the
 * display name — had no supported way back. This module applies a narrow,
 * atomic patch to an existing position package and leaves everything else
 * byte-identical, so an edit never destroys operator-authored content
 * (the SKILL.md prompt, `knowledge/**`, `context/**`).
 *
 * Two stores carry an employee's identity, and BOTH must move together:
 *
 *   1. the package — `.workbench/identity.v1.json` holds the display name,
 *      `permissions.json` + `skills.json` + `mcp.json` hold the grants, and
 *      `employee.json` mirrors them into `policy` (mode, filesystem, mcpTools);
 *   2. `organization.v1alpha1.json` — the workspace's init *declaration*.
 *
 * (2) is easy to miss and would make this feature a silent no-op on imported
 * workspaces. The bundled engine resolves a position as
 * `declaredRole?.name ?? identity.name ?? ...` (apps/server/bin/qoder-engine.mjs
 * `orgApply`), so for any position the declaration lists, the declaration wins
 * over the package. A workspace created by RoleWeave declares only its owner,
 * which is why hired employees are package-authoritative; the `oss-maintainer`
 * example declares all four. An edit that only rewrote the package would appear
 * to work on a fresh project and do nothing on an imported one. When the
 * position IS declared, this module updates exactly the three fields the edit
 * owns — `name`, `mode`, `toolAllow` — and nothing else.
 *
 * The patch deliberately cannot change the position id (it is a path AND the
 * foreign key for turns, sessions and groups, so renaming is a migration, not
 * an edit), the reporting line, or the budget: those already have governed
 * channels whose invariants this surface must not route around.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { OrgApiError, errorCodes } from "@roleweave/shared";
import type {
  HirePermissions,
  OrgRole,
  OrganizationFile,
  PositionProfilePatch,
} from "@roleweave/shared";
import type { OpenWorkspace } from "../workspace-state.js";
import { ORGANIZATION_FILE } from "../workspace-state.js";
import { resolvePositionPackageDir } from "../context-sources.js";
import { derivePermissionArtifacts, permissionsFromPackage } from "./permission-artifacts.js";
import { validatePermissions } from "./permissions.js";

/** Same bound `POST /hire` applies to a display name (UTF-8 bytes). */
const MAX_NAME_BYTES = 128;
const IDENTITY_RELATIVE_PATH = [".workbench", "identity.v1.json"] as const;
const IDENTITY_SCHEMA_VERSION = "workbench-position-identity.v1";
/** Package assets replaced wholesale on a permission change. */
const PERMISSION_ASSETS = ["permissions.json", "skills.json", "mcp.json"] as const;
const DEFAULT_TOOLS = ["Read", "Grep", "Glob"];

function invalid(message: string): OrgApiError {
  return new OrgApiError(errorCodes.position_profile_invalid, 400, message);
}

function profileStorageError(message: string, cause?: unknown): OrgApiError {
  return new OrgApiError(
    errorCodes.turn_storage_failed,
    500,
    message,
    false,
    cause === undefined ? undefined : { cause },
  );
}

/** Strict shape gate. An empty or unknown-keyed patch is a client bug, not a no-op. */
export function assertProfilePatch(raw: unknown): PositionProfilePatch {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalid("profile update must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  const known = new Set(["name", "mode", "permissions"]);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) throw invalid(`unknown field: ${key}`);
  }
  if (Object.keys(body).length === 0) {
    throw invalid("profile update must change at least one of name, mode, permissions");
  }
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      throw invalid("name must be a non-empty string");
    }
    if (Buffer.byteLength(body.name.trim(), "utf8") > MAX_NAME_BYTES) {
      throw invalid(`name must be no larger than ${MAX_NAME_BYTES} bytes`);
    }
  }
  if (body.mode !== undefined && body.mode !== "read_only" && body.mode !== "approval_required") {
    throw invalid("mode must be read_only or approval_required");
  }
  const patch: PositionProfilePatch = {};
  if (body.name !== undefined) patch.name = (body.name as string).trim();
  if (body.mode !== undefined) patch.mode = body.mode as PositionProfilePatch["mode"];
  if (body.permissions !== undefined) patch.permissions = validatePermissions(body.permissions, invalid);
  return patch;
}

async function readTextIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw profileStorageError(`position asset is unreadable: ${path.basename(file)}`, error);
  }
}

async function readJsonIfPresent<T>(file: string): Promise<T | null> {
  const text = await readTextIfPresent(file);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw profileStorageError(`position asset is not valid JSON: ${path.basename(file)}`, error);
  }
}

interface PendingWrite {
  file: string;
  next: string;
  /** Explicit mode for files whose original is 0600 (`.workbench/**`). */
  mode?: number;
  previous: string | null;
  previousMode: number | null;
}

/**
 * Collect every write, then commit them together, keeping each file's exact
 * previous bytes so an engine rejection can be undone.
 *
 * The rollback is not optional politeness. `org apply` is the only validator of
 * the applied model, so a package that keeps the edited bytes while the applied
 * `.digital-employee/org.json` still holds the old ones disagrees with itself:
 * the UI would keep showing the old name, and the first later, unrelated org
 * mutation would silently publish the rejected values. Failing closed means the
 * package goes back too.
 */
class StagedWrites {
  private readonly pending: PendingWrite[] = [];

  stage(file: string, next: string, mode?: number): void {
    // Guard the exact defect this file was written to avoid: two halves of a
    // patch deriving the same asset from different starting bytes, so whichever
    // commits last silently wins.
    if (this.pending.some((write) => write.file === file)) {
      throw new Error(`profile edit staged the same asset twice: ${path.basename(file)}`);
    }
    this.pending.push({
      file,
      next,
      ...(mode === undefined ? {} : { mode }),
      previous: null,
      previousMode: null,
    });
  }

  async commit(): Promise<void> {
    for (const write of this.pending) {
      write.previous = await readTextIfPresent(write.file);
      if (write.previous !== null) {
        try {
          write.previousMode = (await fs.lstat(write.file)).mode;
        } catch {
          write.previousMode = null;
        }
      }
      await this.write(write.file, write.next, write.mode);
    }
  }

  async rollback(): Promise<void> {
    for (const write of [...this.pending].reverse()) {
      if (write.previous === null) {
        await fs.rm(write.file, { force: true });
        continue;
      }
      const mode = write.previousMode === null ? write.mode : write.previousMode & 0o777;
      await this.write(write.file, write.previous, mode === 0 ? undefined : mode);
    }
  }

  /** Write through a temp sibling so a crash can never leave a half-written
   * employee.json, which would break the engine's whole-directory scan rather
   * than just this position. */
  private async write(file: string, contents: string, mode?: number): Promise<void> {
    const temporary = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      // An imported package may not have `.workbench/` yet; the generated
      // skeleton creates it, a portable one never did.
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, contents, mode === undefined ? undefined : { mode });
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw profileStorageError(`position asset could not be persisted: ${path.basename(file)}`, error);
    }
  }
}

function readPolicyTools(employee: Record<string, unknown> | null): string[] {
  const policy = employee?.policy;
  if (typeof policy !== "object" || policy === null) return [...DEFAULT_TOOLS];
  const tools = (policy as { tools?: unknown }).tools;
  return Array.isArray(tools) && tools.every((tool) => typeof tool === "string")
    ? (tools as string[])
    : [...DEFAULT_TOOLS];
}

async function readPackage(packageDir: string): Promise<{ employee: Record<string, unknown> | null; permissions: HirePermissions }> {
  const employee = await readJsonIfPresent<Record<string, unknown>>(path.join(packageDir, "employee.json"));
  const permissionsFile = await readJsonIfPresent<unknown>(path.join(packageDir, "permissions.json"));
  // `permissions.json` is the operator-facing grant list, but `employee.json` is
  // what the upstream package contract calls policy. A legacy or imported
  // package may carry only the latter, so fall back to its tool list rather than
  // silently reporting the position as having no tools at all.
  return { employee, permissions: permissionsFromPackage(permissionsFile, readPolicyTools(employee)) };
}

/** The end-of-line convention already in the file, so a patch never mixes
 * endings into a source-controlled package. A Windows checkout of an imported
 * workspace has CRLF SKILL.md; a freshly generated one is LF. */
function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Replace the level-1 title of a generated SKILL.md, leaving the operator's
 * prompt and knowledge sections untouched. A hand-written SKILL.md without the
 * generated title keeps its own copy rather than being rewritten. */
export function replaceSkillTitle(skill: string, name: string): string {
  const lines = skill.split("\n");
  let frontmatterDelimiters = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const carriageReturn = line.endsWith("\r");
    const bare = carriageReturn ? line.slice(0, -1) : line;
    if (bare === "---") {
      frontmatterDelimiters += 1;
      continue;
    }
    if (frontmatterDelimiters < 2) continue;
    if (bare.startsWith("# ")) {
      lines[index] = `# ${name}${carriageReturn ? "\r" : ""}`;
      return lines.join("\n");
    }
  }
  return skill;
}

/** Swap one generated `## <heading>` section body. Returns the input unchanged
 * when the heading is absent, so a hand-edited SKILL.md is never mangled. */
export function replaceSection(skill: string, heading: string, body: string, stops: string[]): string {
  const start = skill.indexOf(`## ${heading}`);
  if (start < 0) return skill;
  const bodyStart = skill.indexOf("\n", start) + 1;
  if (bodyStart === 0) return skill;
  const candidates = stops
    .map((stop) => skill.indexOf(stop, bodyStart))
    .filter((index) => index >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : skill.length;
  const eol = detectEol(skill);
  return `${skill.slice(0, bodyStart)}${eol}${body}${eol}${eol}${skill.slice(end)}`;
}

export interface PositionProfileEdit {
  name: string;
  mode: OrgRole["mode"];
  /** Undo every byte this edit replaced; see {@link StagedWrites}. */
  rollback(): Promise<void>;
}

/**
 * Stage and commit the patch against one position package. The caller owns the
 * engine apply, the reload, the `org.updated` broadcast, and the rollback.
 */
export async function applyPositionProfile(
  workspace: OpenWorkspace,
  role: OrgRole,
  patch: PositionProfilePatch,
): Promise<PositionProfileEdit> {
  const packageDir = path.resolve(resolvePositionPackageDir(workspace.dir, role));
  let stat;
  try {
    stat = await fs.lstat(packageDir);
  } catch {
    throw new OrgApiError(errorCodes.position_missing, 404, `position package directory is missing: ${role.id}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new OrgApiError(errorCodes.position_missing, 404, `position package is not a real directory: ${role.id}`);
  }

  const { employee, permissions } = await readPackage(packageDir);
  const nextName = patch.name ?? role.name;
  const nextMode = patch.mode ?? role.mode;
  const nextPermissions = patch.permissions ?? permissions;
  const renames = patch.name !== undefined;
  const regrants = patch.mode !== undefined || patch.permissions !== undefined;
  const writes = new StagedWrites();

  // Name ---------------------------------------------------------------
  if (renames) {
    writes.stage(
      path.join(packageDir, ...IDENTITY_RELATIVE_PATH),
      `${JSON.stringify({ schemaVersion: IDENTITY_SCHEMA_VERSION, name: nextName }, null, 2)}\n`,
      0o600,
    );
  }

  // Mode + permissions ------------------------------------------------
  if (regrants) {
    const derived = derivePermissionArtifacts(nextPermissions);
    if (employee !== null) {
      const policy = typeof employee.policy === "object" && employee.policy !== null
        ? (employee.policy as Record<string, unknown>)
        : {};
      policy.mode = nextMode;
      policy.filesystem = {
        read: ["./knowledge/**", ...derived.readableResources].filter((resource, index, all) => all.indexOf(resource) === index),
        write: derived.writableResources.filter((resource, index, all) => all.indexOf(resource) === index),
      };
      policy.mcpTools = derived.mcpTools;
      employee.policy = policy;
      const entrypoints = typeof employee.entrypoints === "object" && employee.entrypoints !== null
        ? (employee.entrypoints as Record<string, unknown>)
        : {};
      // The MCP entrypoint is derived, not optional: a package that grants MCP
      // tools must expose `mcp.json`, and a package that dropped every grant
      // must stop advertising one.
      if (derived.mcpTools.length > 0) entrypoints.mcp = "./mcp.json";
      else delete entrypoints.mcp;
      employee.entrypoints = entrypoints;
      // A portable/imported package can predate the Workbench grant files
      // (`oss-maintainer` lists only knowledge and evals). Writing a grant the
      // package does not declare would leave the two halves of the contract
      // disagreeing, so converge on the shape the hire skeleton produces.
      const assets = Array.isArray(employee.assets)
        ? (employee.assets as unknown[]).filter((asset): asset is string => typeof asset === "string")
        : [];
      for (const asset of PERMISSION_ASSETS) {
        const reference = `./${asset}`;
        if (!assets.includes(reference)) assets.push(reference);
      }
      employee.assets = assets;
      writes.stage(path.join(packageDir, "employee.json"), `${JSON.stringify(employee, null, 2)}\n`);
    }
    for (const asset of PERMISSION_ASSETS) {
      const body = asset === "permissions.json"
        ? derived.permissionsFile
        : asset === "skills.json"
          ? derived.skillsFile
          : derived.mcpFile;
      writes.stage(path.join(packageDir, asset), `${JSON.stringify(body, null, 2)}\n`);
    }
  }

  // SKILL.md -----------------------------------------------------------
  // Both halves of the patch rewrite this one file. They must compose into a
  // single write: staging them separately would derive the second edit from a
  // pre-rename copy and silently clobber the new title.
  const skillFile = path.join(packageDir, "SKILL.md");
  const skill = await readTextIfPresent(skillFile);
  if (skill !== null && (renames || regrants)) {
    let next = skill;
    if (renames) next = replaceSkillTitle(next, nextName);
    if (regrants) {
      const derived = derivePermissionArtifacts(nextPermissions);
      next = replaceSection(
        replaceSection(next, "已启用 Skill", derived.skillSection, ["## 已绑定 MCP"]),
        "已绑定 MCP",
        derived.mcpSection,
        ["以上能力只代表", "## 记忆来源"],
      );
    }
    if (next !== skill) writes.stage(skillFile, next);
  }

  // Declaration --------------------------------------------------------
  // Only the three fields this surface owns, and only when the position is
  // actually declared; see the module header for why this cannot be skipped.
  const declaredFile = path.join(workspace.dir, ORGANIZATION_FILE);
  const declared = await readJsonIfPresent<OrganizationFile>(declaredFile);
  if (declared !== null && Array.isArray(declared.roles)) {
    const declaredRole = declared.roles.find((entry) => entry.id === role.id);
    if (declaredRole !== undefined) {
      declaredRole.name = nextName;
      declaredRole.mode = nextMode;
      if (patch.permissions !== undefined) declaredRole.toolAllow = [...nextPermissions.tools];
      declared.updatedAt = new Date().toISOString();
      writes.stage(declaredFile, `${JSON.stringify(declared, null, 2)}\n`);
    }
  }

  await writes.commit();
  return { name: nextName, mode: nextMode, rollback: () => writes.rollback() };
}
