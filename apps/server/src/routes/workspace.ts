import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  WORKSPACE_MANIFEST_SCHEMA_VERSION,
  WORKSPACE_ORG_SCHEMA_VERSION,
  OrgApiError,
  errorCodes,
  isPositionId,
} from "@roleweave/shared";
import type {
  OrganizationFile,
  OrgRole,
  PositionBudget,
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceInfoResponse,
  WorkspaceManifest,
  WorkspaceOpenRequest,
} from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import { buildPositionSkeletonFiles, writeSkeletonFiles } from "../org/apply.js";

const MAX_PROJECT_ID_LENGTH = 48;
const MAX_BUSINESS_BYTES = 128;
const MAX_DESCRIPTION_CHARACTERS = 1_024;
const PROJECT_OWNER_BUDGET: PositionBudget = {
  perTask: { tokens: 40_000 },
  perDay: { tokens: 400_000 },
};

function invalid(message: string): OrgApiError {
  return new OrgApiError(errorCodes.workspace_invalid, 400, message);
}

function assertWorkspaceCreateRequest(raw: unknown): WorkspaceCreateRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalid("workspace create request must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  const known = new Set(["parentPath", "projectId", "business", "description"]);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) throw invalid(`unknown field: ${key}`);
  }
  if (typeof body.parentPath !== "string" || !path.isAbsolute(body.parentPath) || body.parentPath.trim().length === 0) {
    throw invalid("parentPath must be an absolute directory path");
  }
  if (
    !isPositionId(body.projectId) ||
    String(body.projectId).length > MAX_PROJECT_ID_LENGTH
  ) {
    throw invalid(`projectId must be a path-safe id no larger than ${MAX_PROJECT_ID_LENGTH} characters`);
  }
  if (
    typeof body.business !== "string" ||
    body.business.trim().length === 0 ||
    Buffer.byteLength(body.business.trim(), "utf8") > MAX_BUSINESS_BYTES
  ) {
    throw invalid("business must be a non-empty name no larger than 128 bytes");
  }
  if (
    typeof body.description !== "string" ||
    body.description.trim().length > MAX_DESCRIPTION_CHARACTERS
  ) {
    throw invalid(`description must be at most ${MAX_DESCRIPTION_CHARACTERS} characters`);
  }
  return {
    parentPath: body.parentPath.trim(),
    projectId: body.projectId,
    business: body.business.trim(),
    description: body.description.trim(),
  };
}

async function assertRealDirectory(directory: string): Promise<string> {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch {
    throw new OrgApiError(errorCodes.workspace_invalid, 422, `project parent directory not found: ${directory}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new OrgApiError(errorCodes.workspace_invalid, 422, "project parent must be a real directory");
  }
  return fs.realpath(directory);
}

function projectOwnerId(projectId: string): string {
  return `${projectId}-owner`;
}

function digest(content: string): string {
  return `sha256:${crypto.createHash("sha256").update(content, "utf8").digest("hex")}`;
}

async function writeProjectSkeleton(
  target: string,
  request: WorkspaceCreateRequest,
): Promise<{ owner: string; organization: OrganizationFile }> {
  const owner = projectOwnerId(request.projectId);
  const createdAt = new Date().toISOString();
  const files = buildPositionSkeletonFiles({
    id: owner,
    name: "项目负责人",
    description: `负责「${request.business}」的整体目标、任务分配和最终确认。`,
    mode: "read_only",
    budget: PROJECT_OWNER_BUDGET,
    prompt: "作为项目负责人，先理解项目上下文，再把明确的工作拆给合适的数字员工；只读岗位资料并给出有依据的结论。",
  });
  const employee = files.get("employee.json");
  if (employee === undefined) throw new Error("project owner skeleton must contain employee.json");

  const ownerDirectory = path.join(target, "positions", owner);
  await fs.mkdir(ownerDirectory, { recursive: true, mode: 0o755 });
  await writeSkeletonFiles(ownerDirectory, files);
  await fs.mkdir(path.join(target, "context"), { recursive: true, mode: 0o755 });
  await fs.writeFile(
    path.join(target, "context", "README.md"),
    `# ${request.business}\n\n这是项目级上下文目录。将经过确认的项目资料放在这里，再按岗位权限接入。\n`,
    "utf8",
  );

  const role: OrgRole = {
    id: owner,
    name: "项目负责人",
    description: `负责「${request.business}」的整体目标、任务分配和最终确认。`,
    reportTo: null,
    package: {
      name: owner,
      version: "0.1.0",
      digest: digest(employee),
      localReference: ownerDirectory,
    },
    mode: "read_only",
    memoryScope: "/",
    toolAllow: ["Read", "Grep", "Glob"],
    toolDeny: [],
    budget: PROJECT_OWNER_BUDGET,
    metadata: { system: "true" },
  };
  const organization: OrganizationFile = {
    $schema: "https://raw.githubusercontent.com/bytefolk/digital-employee/main/configs/workspace-org.schema.json",
    schemaVersion: WORKSPACE_ORG_SCHEMA_VERSION,
    business: request.business,
    description: request.description || `由 RoleWeave 创建的「${request.business}」项目。`,
    owner,
    roles: [role],
    updatedAt: createdAt,
  };
  const manifest: WorkspaceManifest = {
    $schema: "https://raw.githubusercontent.com/bytefolk/digital-employee/main/configs/workspace.schema.json",
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    name: request.projectId,
    description: organization.description,
    template: "blank-project",
    createdAt,
    organization: "./organization.v1alpha1.json",
    positions: "./positions",
    context: "./context",
  };
  await fs.writeFile(path.join(target, "workspace.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(target, "organization.v1alpha1.json"), `${JSON.stringify(organization, null, 2)}\n`, "utf8");
  return { owner, organization };
}

export async function handleWorkspaceCreate(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const request = assertWorkspaceCreateRequest(await readJsonBody<unknown>(req));
  const parent = await assertRealDirectory(request.parentPath);
  const target = path.join(parent, request.projectId);
  try {
    await fs.lstat(target);
    throw new OrgApiError(
      errorCodes.workspace_exists,
      409,
      `project directory already exists: ${target}`,
    );
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let targetCreated = false;
  let applied = false;
  try {
    await fs.mkdir(target, { mode: 0o755 });
    targetCreated = true;
    const { owner } = await writeProjectSkeleton(target, request);
    const engineResult = await ctx.driver.apply(target);
    if (engineResult.status === "engine_unavailable") {
      throw new OrgApiError(errorCodes.engine_unavailable, 503, engineResult.message, true);
    }
    if (engineResult.status === "engine_capability_missing") {
      throw new OrgApiError(errorCodes.engine_capability_missing, 503, engineResult.message);
    }
    if (engineResult.status === "failed") {
      throw new OrgApiError(engineResult.code, 422, engineResult.message, engineResult.retryable);
    }
    applied = true;

    const ws = await ctx.workspace.openWorkspace(target);
    const version = ctx.workspace.touch();
    ctx.bus.publish("org.updated", { workspace: ws.dir, version, changes: [] });
    const body: WorkspaceCreateResponse = {
      open: true,
      created: true,
      next: "create_employee",
      path: ws.dir,
      business: ws.organization.business,
      owner,
      version: ws.version,
      budgetPoolTokens: ctx.config.budgetPoolTokens,
    };
    sendJson(res, 201, body);
  } finally {
    if (targetCreated && !applied) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
}

export async function handleWorkspaceGet(
  ctx: ControlPlaneContext,
  res: ServerResponse,
): Promise<void> {
  const ws = ctx.workspace.active;
  const body: WorkspaceInfoResponse = ws
    ? {
        open: true,
        path: ws.dir,
        business: ws.organization.business,
        owner: ws.organization.owner,
        version: ws.version,
        budgetPoolTokens: ctx.config.budgetPoolTokens,
      }
    : { open: false };
  sendJson(res, 200, body);
}

export async function handleWorkspaceOpen(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody<Partial<WorkspaceOpenRequest>>(req);
  if (typeof body.path !== "string" || body.path.length === 0) {
    throw new OrgApiError(errorCodes.body_invalid, 400, "path must be a non-empty string");
  }
  const ws = await ctx.workspace.openWorkspace(body.path);
  const version = ctx.workspace.touch();
  ctx.bus.publish("org.updated", {
    workspace: ws.dir,
    version,
    changes: [],
  });
  await resumeContextExports(ctx, ws.dir, ws.organization.roles.map((role) => role.id)).catch(() => {
    // Workspace open remains independent from Context availability. A later
    // open/restart retries export intents without invoking any Host turn.
  });
  sendJson(res, 200, {
    open: true,
    path: ws.dir,
    business: ws.organization.business,
    owner: ws.organization.owner,
    version: ws.version,
    budgetPoolTokens: ctx.config.budgetPoolTokens,
  });
}

async function resumeContextExports(
  ctx: ControlPlaneContext,
  workspace: string,
  positionIds: string[],
): Promise<void> {
  for (const positionId of positionIds) {
    const sessions = await ctx.sessionStore.list(workspace, positionId);
    for (const session of sessions.sessions) {
      const history = await ctx.turnStore.sessionHistory(
        workspace,
        session.sessionId,
        session.positionId,
        new Date().toISOString(),
      );
      for (const turn of history.turns) {
        if (turn.status === "completed") {
          await ctx.contextExporter.enqueueCompletedTurn(workspace, session, turn);
        }
      }
    }
  }
}
