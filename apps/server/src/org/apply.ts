import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CHANGE_MANIFEST_SCHEMA_VERSION,
  OrgApiError,
  errorCodes,
  hireMcpCatalog,
  hireSkillCatalog,
  isPositionId,
} from "@roleweave/shared";
import type {
  ChangeManifest,
  DeletePositionChange,
  MovePositionChange,
  OrgApplyFailure,
  OrgApplyResult,
  OrgApplySuccess,
  OrgChange,
  OrgLayoutFile,
  OrgRole,
  PositionBudget,
  HireMemorySource,
  HirePermissions,
  ReorderPositionsChange,
} from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { parentKey } from "./layout.js";
import {
  clearUndoEntry,
  readUndoEntry,
  writeUndoEntryAtomic,
} from "./undo.js";
import type { OrgUndoEntry } from "./undo.js";

export const RUNTIME_DIR = ".digital-employee";
export const POSITIONS_DIR = "positions";
export const MAX_POSITION_DEPTH = 8;

export const stagingConflictCodes = {
  positionExists: "org_apply_position_exists",
  positionMissing: "org_apply_position_missing",
  cycle: "org_apply_cycle",
  ownerDelete: "org_apply_owner_delete",
  maxDepth: "org_apply_max_depth",
  destinationExists: "org_apply_destination_exists",
  reorderSetMismatch: "org_reorder_set_mismatch",
} as const;

interface ApplyOutcome {
  status: number;
  body: OrgApplyResult;
}

export interface ProposalPosition {
  id: string;
  directory: string;
  reportTo: string | null;
  depth: number;
}

/**
 * POST /org/apply orchestrator for the directory-driven engine contract.
 *
 * The client first validates the complete manifest against an in-memory view,
 * then materializes the proposal directly in positions/. The engine is the
 * sole organization validator and owns every applied-state write. A rejected
 * apply intentionally leaves the proposal tree available for correction.
 */
const mutationTails = new Map<string, Promise<void>>();

export async function withOrgMutationLock<T>(workspaceDir: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(workspaceDir);
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  const chained = previous.then(() => tail);
  mutationTails.set(key, chained);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (mutationTails.get(key) === chained) mutationTails.delete(key);
  }
}

export async function applyChangeManifest(
  ctx: ControlPlaneContext,
  rawBody: unknown,
): Promise<ApplyOutcome> {
  const ws = ctx.workspace.requireOpen();
  return withOrgMutationLock(ws.dir, () => applyChangeManifestUnlocked(ctx, rawBody));
}

async function applyChangeManifestUnlocked(
  ctx: ControlPlaneContext,
  rawBody: unknown,
): Promise<ApplyOutcome> {
  const ws = ctx.workspace.requireOpen();
  const manifest = validateManifest(rawBody);
  const structural = manifest.changes.filter(
    (change): change is MovePositionChange | DeletePositionChange =>
      change.op !== "reorder",
  );
  const reorders = manifest.changes.filter(
    (change): change is ReorderPositionsChange => change.op === "reorder",
  );
  const previousLayout = ctx.workspace.getLayout();
  const previousParents = new Map(
    ws.organization.roles.map((role): [string, string | null] => [role.id, role.reportTo]),
  );
  const proposal = await scanProposalTree(ws.dir);
  validateProposalChanges(proposal, manifest, ws.organization.owner);

  if (structural.length === 0) {
    const order = applyReordersToLayout(ctx.workspace.getLayout(), reorders);
    await ctx.workspace.setLayoutOrder(order);
    await saveUndoEntry(ws.dir, { inverseMoves: [], previousLayout });
    const version = ctx.workspace.touch();
    ctx.bus.publish("org.updated", {
      workspace: ws.dir,
      version,
      changes: reorders.map((change) => ({ op: change.op, id: change.parentId ?? "_root" })),
    });
    const body: OrgApplySuccess = {
      status: "applied",
      version: version!,
      changesApplied: manifest.changes.length,
    };
    return { status: 200, body };
  }

  await materializeProposal(ws.dir, manifest);

  const engineResult = await ctx.driver.apply(ws.dir);
  if (engineResult.status === "engine_unavailable") {
    return failure(errorCodes.engine_unavailable, engineResult.message, true, 503);
  }
  if (engineResult.status === "engine_capability_missing") {
    return failure(errorCodes.engine_capability_missing, engineResult.message, false, 503);
  }
  if (engineResult.status === "failed") {
    return failure(engineResult.code, engineResult.message, engineResult.retryable, 422);
  }

  const version = await ctx.workspace.reloadAppliedOrganization();
  if (reorders.length > 0) {
    const order = applyReordersToLayout(ctx.workspace.getLayout(), reorders);
    await ctx.workspace.setLayoutOrder(order);
  }
  const hasDelete = structural.some((change) => change.op === "delete");
  if (hasDelete) {
    await clearUndoEntry(ws.dir);
  } else {
    const inverseMoves = structural.map((change) => ({
      op: "move" as const,
      id: (change as MovePositionChange).id,
      reportTo: previousParents.get((change as MovePositionChange).id) ?? null,
    }));
    await saveUndoEntry(ws.dir, { inverseMoves, previousLayout });
  }
  ctx.bus.publish("org.updated", {
    workspace: ws.dir,
    version,
    changes:
      engineResult.result?.changes ?? manifest.changes.map(changeDigest),
  });
  const body: OrgApplySuccess = {
    status: "applied",
    version,
    changesApplied: manifest.changes.length,
  };
  return { status: 200, body };
}

function applyReordersToLayout(
  layout: OrgLayoutFile,
  reorders: ReorderPositionsChange[],
): Record<string, string[]> {
  const order: Record<string, string[]> = { ...layout.order };
  for (const reorder of reorders) {
    order[parentKey(reorder.parentId)] = [...reorder.order];
  }
  return order;
}

async function saveUndoEntry(
  workspaceDir: string,
  entry: { inverseMoves: MovePositionChange[]; previousLayout: OrgLayoutFile },
): Promise<void> {
  const undoEntry: OrgUndoEntry = {
    schemaVersion: "org-undo.v1",
    savedAt: new Date().toISOString(),
    inverseMoves: entry.inverseMoves,
    previousLayout: entry.previousLayout,
  };
  await writeUndoEntryAtomic(workspaceDir, undoEntry);
}

/**
 * Single-step undo (#32 AC-005): replays the inverse moves of the last drag
 * adjustment through the engine path, then restores the previous layout
 * overlay. Structural add/delete restores stay with BackupTray.
 */
export async function undoLastOrgAdjustment(
  ctx: ControlPlaneContext,
): Promise<ApplyOutcome | { status: number; body: import("@roleweave/shared").OrgUndoSuccess }> {
  const ws = ctx.workspace.requireOpen();
  return withOrgMutationLock(ws.dir, async () => {
    const entry = await readUndoEntry(ws.dir);
    if (!entry) {
      throw new OrgApiError(errorCodes.not_found, 404, "no org adjustment to undo");
    }
    if (entry.inverseMoves.length > 0) {
      const outcome = await applyChangeManifestUnlocked(ctx, {
        schemaVersion: CHANGE_MANIFEST_SCHEMA_VERSION,
        changes: entry.inverseMoves,
      });
      if (outcome.status !== 200) return outcome;
    }
    await ctx.workspace.setLayoutOrder(entry.previousLayout.order);
    await clearUndoEntry(ws.dir);
    const version = ctx.workspace.touch();
    ctx.bus.publish("org.updated", {
      workspace: ws.dir,
      version,
      changes: [{ op: "undo" }],
    });
    return { status: 200, body: { status: "undone", version: version! } };
  });
}

function failure(
  code: string,
  message: string,
  retryable: boolean,
  status: number,
): ApplyOutcome {
  const body: OrgApplyFailure = { status: "failed", code, message, retryable };
  return { status, body };
}

export async function scanProposalTree(workspaceDir: string): Promise<ProposalPosition[]> {
  const root = path.join(workspaceDir, POSITIONS_DIR);
  const positions: ProposalPosition[] = [];
  const seen = new Set<string>();

  const scanPosition = async (
    directory: string,
    id: string,
    reportTo: string | null,
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_POSITION_DEPTH) {
      throw conflict(stagingConflictCodes.maxDepth, `position tree exceeds maxDepth=${MAX_POSITION_DEPTH}`);
    }
    if (!isPositionId(id)) {
      throw conflict("workspace_org_tree_invalid_position_id", `invalid position id: ${id}`);
    }
    if (seen.has(id)) {
      throw conflict("workspace_org_tree_duplicate_position", `duplicate position id: ${id}`);
    }
    seen.add(id);
    positions.push({ id, directory, reportTo, depth });

    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      if (!(await isRegularFile(path.join(child, "employee.json")))) continue;
      await scanPosition(child, entry.name, id, depth + 1);
    }
  };

  let entries;
  try {
    entries = (await fs.readdir(root, { withFileTypes: true }))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
  } catch {
    throw conflict("workspace_org_positions_missing", "positions/ directory missing");
  }
  for (const entry of entries) {
    const directory = path.join(root, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !(await isRegularFile(path.join(directory, "employee.json")))) {
      throw conflict(
        "workspace_org_tree_position_invalid",
        `invalid top-level position entry: ${entry.name} (positions/${entry.name} must be a regular directory containing employee.json; remove the stray directory or restore its employee package, then retry)`,
      );
    }
    await scanPosition(directory, entry.name, null, 1);
  }
  return positions;
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function validateProposalChanges(
  proposal: ProposalPosition[],
  manifest: ChangeManifest,
  owner: string,
): void {
  const parents = new Map(proposal.map((position) => [position.id, position.reportTo]));
  for (const change of manifest.changes) {
    if (change.op === "move") {
      if (!parents.has(change.id)) {
        throw conflict(stagingConflictCodes.positionMissing, `move: position not found: ${change.id}`);
      }
      requireParent(parents, change.reportTo, "move");
      if (change.reportTo === change.id || isDescendant(parents, change.reportTo, change.id)) {
        throw conflict(stagingConflictCodes.cycle, `move would create a reporting cycle: ${change.id}`);
      }
      parents.set(change.id, change.reportTo);
    } else if (change.op === "delete") {
      if (!parents.has(change.id)) {
        throw conflict(stagingConflictCodes.positionMissing, `delete: position not found: ${change.id}`);
      }
      if (change.id === owner) {
        throw conflict(stagingConflictCodes.ownerDelete, "delete: the owner position cannot be disbanded");
      }
      const removed = new Set([change.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [id, parent] of parents) {
          if (parent !== null && removed.has(parent) && !removed.has(id)) {
            removed.add(id);
            changed = true;
          }
        }
      }
      for (const id of removed) parents.delete(id);
    }
  }
  const reorderedParents = new Set<string | null>();
  for (const change of manifest.changes) {
    if (change.op !== "reorder") continue;
    if (reorderedParents.has(change.parentId)) {
      throw new OrgApiError(
        errorCodes.manifest_invalid,
        400,
        `reorder: duplicate parentId: ${String(change.parentId)}`,
      );
    }
    reorderedParents.add(change.parentId);
    if (change.parentId !== null && !parents.has(change.parentId)) {
      throw conflict(stagingConflictCodes.positionMissing, `reorder: parent not found: ${change.parentId}`);
    }
    const children = new Set(
      [...parents.entries()].filter(([, parent]) => parent === change.parentId).map(([id]) => id),
    );
    if (change.order.length !== children.size || change.order.some((id) => !children.has(id))) {
      throw conflict(
        stagingConflictCodes.reorderSetMismatch,
        `reorder: order must be exactly the current children of ${String(change.parentId)}`,
      );
    }
  }
  for (const id of parents.keys()) {
    if (proposalDepth(parents, id) > MAX_POSITION_DEPTH) {
      throw conflict(stagingConflictCodes.maxDepth, `position tree exceeds maxDepth=${MAX_POSITION_DEPTH}`);
    }
  }
}

function requireParent(
  parents: Map<string, string | null>,
  parent: string | null,
  operation: string,
): void {
  if (parent !== null && !parents.has(parent)) {
    throw conflict(stagingConflictCodes.positionMissing, `${operation}: reportTo target not found: ${parent}`);
  }
}

function isDescendant(
  parents: Map<string, string | null>,
  candidate: string | null,
  ancestor: string,
): boolean {
  let cursor = candidate;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === ancestor) return true;
    seen.add(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  return false;
}

function proposalDepth(parents: Map<string, string | null>, id: string): number {
  let depth = 1;
  let cursor = parents.get(id) ?? null;
  const seen = new Set([id]);
  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw conflict(stagingConflictCodes.cycle, `reporting cycle includes ${id}`);
    }
    seen.add(cursor);
    depth += 1;
    cursor = parents.get(cursor) ?? null;
  }
  return depth;
}

function conflict(code: string, message: string): OrgApiError {
  return new OrgApiError(code, 422, message);
}

async function materializeProposal(
  workspaceDir: string,
  manifest: ChangeManifest,
): Promise<void> {
  const positionsRoot = path.join(workspaceDir, POSITIONS_DIR);
  const runtimeDir = path.join(workspaceDir, RUNTIME_DIR);
  const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;

  for (const change of manifest.changes) {
    if (change.op === "reorder") continue;
    const current = new Map(
      (await scanProposalTree(workspaceDir)).map((position) => [position.id, position]),
    );
    const source = current.get(change.id);
    if (!source) throw conflict(stagingConflictCodes.positionMissing, `${change.op}: position not found: ${change.id}`);
    if (change.op === "move") {
      const parent = change.reportTo === null ? null : current.get(change.reportTo);
      const destination = path.join(parent?.directory ?? positionsRoot, change.id);
      if (source.directory === destination) continue;
      await assertDestinationAvailable(destination);
      await fs.rename(source.directory, destination);
      continue;
    }
    const backupRoot = path.join(runtimeDir, "backup");
    await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await fs.rename(source.directory, path.join(backupRoot, `${change.id}-${stamp}`));
  }
}

export async function assertDestinationAvailable(destination: string): Promise<void> {
  try {
    await fs.lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw conflict(stagingConflictCodes.destinationExists, `proposal destination already exists: ${path.basename(destination)}`);
}

function changeDigest(change: OrgChange): { op: string; id: string } {
  if (change.op === "reorder") return { op: change.op, id: change.parentId ?? "_root" };
  return { op: change.op, id: change.id };
}

function validateManifest(rawBody: unknown): ChangeManifest {
  const invalid = (message: string): OrgApiError =>
    new OrgApiError(errorCodes.manifest_invalid, 400, message);
  if (typeof rawBody !== "object" || rawBody === null) throw invalid("manifest must be a JSON object");
  const body = rawBody as Record<string, unknown>;
  if (body.schemaVersion !== CHANGE_MANIFEST_SCHEMA_VERSION) {
    throw invalid(`manifest schemaVersion must be ${CHANGE_MANIFEST_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(body.changes) || body.changes.length === 0) {
    throw invalid("manifest changes must be a non-empty array");
  }
  for (const [index, rawChange] of body.changes.entries()) {
    if (typeof rawChange !== "object" || rawChange === null) throw invalid(`changes[${index}] must be an object`);
    const change = rawChange as Record<string, unknown>;
    if (change.op === "move") validateMove(index, change);
    else if (change.op === "delete") validateDelete(index, change);
    else if (change.op === "reorder") validateReorder(index, change);
    else throw invalid(`changes[${index}].op must be move | delete | reorder (hire moved to POST /hire, #33)`);
  }
  return rawBody as ChangeManifest;
}

function validateMove(index: number, change: Record<string, unknown>): void {
  if (!isPositionId(change.id)) {
    throw new OrgApiError(errorCodes.manifest_invalid, 400, `changes[${index}]: id is invalid`);
  }
  if (change.reportTo !== null && !isPositionId(change.reportTo)) {
    throw new OrgApiError(errorCodes.manifest_invalid, 400, `changes[${index}]: reportTo must be a position id | null`);
  }
}

function validateDelete(index: number, change: Record<string, unknown>): void {
  if (!isPositionId(change.id)) {
    throw new OrgApiError(errorCodes.manifest_invalid, 400, `changes[${index}]: id is invalid`);
  }
}

function validateReorder(index: number, change: Record<string, unknown>): void {
  const invalid = (message: string): OrgApiError =>
    new OrgApiError(errorCodes.manifest_invalid, 400, `changes[${index}]: ${message}`);
  if (change.parentId !== null && !isPositionId(change.parentId)) {
    throw invalid("parentId must be a position id | null");
  }
  if (!Array.isArray(change.order) || change.order.length === 0) {
    throw invalid("order must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const id of change.order) {
    if (!isPositionId(id)) throw invalid("order entries must be position ids");
    if (seen.has(id)) throw invalid(`order contains a duplicate id: ${id}`);
    seen.add(id);
  }
}

/** Position inputs the hire route accepts; the skeleton is deterministic in these. */
export interface SkeletonPosition {
  id: string;
  name: string;
  description: string;
  mode: "read_only" | "approval_required";
  budget: PositionBudget;
  permissions?: HirePermissions;
  prompt?: string;
  memorySources?: HireMemorySource[];
}

/**
 * Deterministic employee-package skeleton content (#33): the hire route
 * digests `employee.json` into hire-request.v1alpha1 `packageRef.digest`
 * BEFORE staging, then stages these exact bytes — so the sealed reference
 * always matches the on-disk package.
 */
export function buildPositionSkeletonFiles(role: SkeletonPosition): Map<string, string> {
  const permissions = role.permissions ?? { tools: ["Read", "Grep", "Glob"], rules: [] };
  const skills = permissions.skills ?? [];
  const mcpServers = permissions.mcpServers ?? [];
  const memorySources = role.memorySources ?? [{ kind: "position_docs", locator: "./knowledge/**" }];
  const readableResources = permissions.rules
    .filter((rule) => (rule.effect ?? "allow") === "allow" && rule.actions.includes("read"))
    .map((rule) => rule.resource)
    .filter((resource) => resource.length > 0);
  const writableResources = permissions.rules
    .filter((rule) => (rule.effect ?? "allow") === "allow" && rule.actions.some((action) => ["create", "update", "delete"].includes(action)))
    .map((rule) => rule.resource)
    .filter((resource) => resource.length > 0);
  const mcpTools = mcpServers.flatMap((server) => server.tools.map((tool) => ({ name: `${server.id}.${tool}`, requestedMode: "read" as const })));
  const skillDefinitions = skills.map((grant) => hireSkillCatalog.find((skill) => skill.id === grant.id)).filter((skill): skill is (typeof hireSkillCatalog)[number] => skill !== undefined);
  const mcpDefinitions = mcpServers.map((grant) => ({ grant, definition: hireMcpCatalog.find((server) => server.id === grant.id) })).filter((item): item is { grant: (typeof mcpServers)[number]; definition: (typeof hireMcpCatalog)[number] } => item.definition !== undefined);
  const employee: Record<string, unknown> = {
    $schema: "https://raw.githubusercontent.com/bytefolk/digital-employee/main/configs/employee-package.schema.json",
    schemaVersion: "employee-package.v1alpha1",
    name: role.id,
    version: "0.1.0",
    description: role.description,
    license: "Apache-2.0",
    authors: ["org-workbench"],
    host: { protocol: "agent-host.v1", requiredCapabilities: [] },
    entrypoints: {
      skill: "./SKILL.md",
      inputSchema: "./schemas/input.schema.json",
      outputSchema: "./schemas/output.schema.json",
      ...(mcpTools.length > 0 ? { mcp: "./mcp.json" } : {}),
    },
    policy: {
      mode: role.mode,
      network: "deny",
      filesystem: {
        read: ["./knowledge/**", ...readableResources].filter((resource, index, all) => all.indexOf(resource) === index),
        write: writableResources.filter((resource, index, all) => all.indexOf(resource) === index),
      },
      mcpTools,
    },
    assets: ["./knowledge/README.md", "./permissions.json", "./skills.json", "./mcp.json"],
  };
  const inputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: { message: { type: "string", minLength: 1, maxLength: 20000 }, context: { type: "object" } },
  };
  const outputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["status", "answer", "citations"],
    properties: {
      status: { enum: ["answered", "escalated"] },
      answer: { type: ["string", "null"] },
      citations: { type: "array", items: { type: "object" } },
    },
  };
  const prompt = role.prompt?.trim() || `围绕“${role.description}”完成岗位职责，先说明依据，再给出可执行结论。`;
  const skillSection = skillDefinitions.length === 0
    ? "- 暂无附加 Skill"
    : skillDefinitions.map((skill) => `### ${skill.name}（${skill.id}）\n\n${skill.description}\n\n执行约束：${skill.instruction}`).join("\\n\\n");
  const mcpSection = mcpDefinitions.length === 0
    ? "- 暂无 MCP 连接器"
    : mcpDefinitions.map(({ grant, definition }) => `- ${definition.name}（${definition.id}）：${grant.tools.length > 0 ? grant.tools.join(", ") : "未开放工具"}`).join("\\n");
  const skill = `---\nname: ${JSON.stringify(role.id)}\ndescription: ${JSON.stringify(role.description)}\n---\n\n# ${role.name}\n\n${role.description}\n\n## 工作提示词\n\n${prompt}\n\n## 已启用 Skill\n\n${skillSection}\n\n## 已绑定 MCP\n\n${mcpSection}\n\n以上能力只代表岗位包中的绑定关系；实际调用仍必须满足 permissions.json 中对应的 skill:// / mcp:// 规则。\n\n## 记忆来源\n\n${memorySources.map((source) => `- ${source.kind}: ${source.locator}`).join("\\n")}\n`;
  const permissionsFile = {
    schemaVersion: "workbench-permissions.v1",
    model: "chmod-inspired",
    defaultEffect: "deny",
    tools: permissions.tools,
    rules: permissions.rules,
    skills,
    mcpServers,
  };
  const skillsFile = {
    schemaVersion: "workbench-skills.v1",
    defaultEffect: "deny",
    skills: skillDefinitions.map((definition) => {
      const grant = skills.find((item) => item.id === definition.id)!;
      return { ...grant, name: definition.name, description: definition.description };
    }),
  };
  const mcpFile = {
    schemaVersion: "workbench-mcp.v1",
    defaultEffect: "deny",
    servers: mcpDefinitions.map(({ grant, definition }) => ({ id: grant.id, name: definition.name, description: definition.description, tools: grant.tools })),
  };
  return new Map<string, string>([
    ["employee.json", `${JSON.stringify(employee, null, 2)}\n`],
    ["SKILL.md", skill],
    ["schemas/input.schema.json", `${JSON.stringify(inputSchema, null, 2)}\n`],
    ["schemas/output.schema.json", `${JSON.stringify(outputSchema, null, 2)}\n`],
    ["knowledge/README.md", "# Approved knowledge\n\nReplace this generated placeholder with reviewed knowledge.\n"],
    ["permissions.json", `${JSON.stringify(permissionsFile, null, 2)}\n`],
    ["skills.json", `${JSON.stringify(skillsFile, null, 2)}\n`],
    ["mcp.json", `${JSON.stringify(mcpFile, null, 2)}\n`],
    ["budget.json", `${JSON.stringify(role.budget, null, 2)}\n`],
  ]);
}

export async function writeSkeletonFiles(dir: string, files: Map<string, string>): Promise<void> {
  for (const [relative, content] of files) {
    const target = path.join(dir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (relative === "budget.json") {
      await writePrivateAtomic(target, content);
    } else {
      await fs.writeFile(target, content, "utf8");
    }
  }
}

async function writePrivateAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
