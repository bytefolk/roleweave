/**
 * POST /hire — the only employee-creation channel (#33, consuming
 * digital-employee #194/#198 hire-request.v1alpha1 at b3d54bf).
 *
 * Chain: strict request-shape gate → deterministic skeleton bytes →
 * packageRef.digest BEFORE staging → hire-request.v1alpha1 envelope sealed
 * with a canonical digest → `hire validate` (static, fail-closed upstream) →
 * stage skeleton → `org apply` engine adjudication (same seam as move/delete)
 * → reload + layout append + org.updated. Every gate fails closed; a failed
 * engine adjudication rolls the staged directory back, so no half-hired
 * position survives. The former change-manifest `add` bypass is gone.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HIRE_REQUEST_SCHEMA_VERSION,
  OrgApiError,
  errorCodes,
  hireMcpCatalog,
  hireSkillCatalog,
  isPositionId,
} from "@roleweave/shared";
import type {
  HireFailure,
  HireMcpGrant,
  HireMemorySource,
  HirePermissions,
  HireRequestEnvelope,
  HireSkillGrant,
  HireSuccess,
  PositionBudget,
} from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import { computeEnvelopeDigest } from "../turns/envelope.js";
import {
  POSITIONS_DIR,
  assertDestinationAvailable,
  buildPositionSkeletonFiles,
  scanProposalTree,
  withOrgMutationLock,
  writeSkeletonFiles,
} from "../org/apply.js";
import { parentKey } from "../org/layout.js";

const MAX_NAME_BYTES = 128;
/**
 * The binding upstream constraint on a description is the SKILL.md frontmatter
 * check in digital-employee (`validateSkillFrontmatter`, apps/cli/employee-package.ts):
 * 1024 UTF-16 code units on the parsed value. It is stricter than
 * employee.json's own 2000-character bound, and it counts characters where
 * this gate previously counted UTF-8 bytes — so a 1025-2048 character ASCII
 * description used to pass here and fail late at `org apply` with an opaque
 * `employee_skill_description_required` (#92, same defect class as #86).
 *
 * Measured against the trimmed value, because that is what reaches the
 * frontmatter (`assertHireRequest` trims before the skeleton builder runs).
 */
const MAX_DESCRIPTION_CHARACTERS = 1_024;
/** Upstream MAX_BUDGET_CAP (packages/engine/src/budget.ts), mirrored. */
const MAX_BUDGET_CAP = 1_000_000_000;
/** Upstream packageRef.version pattern (configs/hire-request.schema.json). */
const PACKAGE_VERSION = "v1alpha1";
const PERMISSION_ACTIONS = new Set(["read", "create", "update", "delete", "execute"]);
const PERMISSION_SCOPES = new Set(["position", "workspace", "project"]);
const MEMORY_KINDS = new Set(["position_docs", "workspace_docs", "mem_drive", "runtime_context"]);
const SKILL_DEFINITIONS = new Map<string, (typeof hireSkillCatalog)[number]>(hireSkillCatalog.map((skill) => [skill.id, skill]));
const MCP_DEFINITIONS = new Map<string, (typeof hireMcpCatalog)[number]>(hireMcpCatalog.map((server) => [server.id, server]));

function invalid(message: string): OrgApiError {
  return new OrgApiError(errorCodes.hire_request_invalid, 400, message);
}

function boundedNonEmptyString(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= limit
  );
}

/** Character-bounded variant for fields whose upstream limit counts code units. */
function boundedNonEmptyCharacters(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= limit
  );
}

function positiveBoundedInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_BUDGET_CAP;
}

function assertBudgetScope(scope: unknown, label: string): Record<string, number> {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    throw invalid(`budget.${label} must be an object`);
  }
  const record = scope as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "tokens" && key !== "iterations") {
      throw invalid(`budget.${label}.${key} is not part of the frozen budgetScope vocabulary`);
    }
  }
  // REQ-006 parity: a token cap on both cycles is the submission floor.
  if (!positiveBoundedInteger(record.tokens)) {
    throw invalid(`budget.${label}.tokens must be a positive integer no larger than ${MAX_BUDGET_CAP}`);
  }
  if (record.iterations !== undefined && !positiveBoundedInteger(record.iterations)) {
    throw invalid(`budget.${label}.iterations must be a positive integer no larger than ${MAX_BUDGET_CAP}`);
  }
  const result: Record<string, number> = { tokens: record.tokens };
  if (record.iterations !== undefined) result.iterations = record.iterations;
  return result;
}

interface ValidatedHireRequest {
  positionId: string;
  name: string;
  description: string;
  reportTo: string | null;
  mode: "read_only" | "approval_required";
  budget: PositionBudget;
  permissions: HirePermissions;
  prompt: string;
  memorySources: HireMemorySource[];
  deadline?: string;
}

function validatePermissions(value: unknown): HirePermissions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("permissions must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.tools) || raw.tools.length > 32 || !raw.tools.every((tool) => typeof tool === "string" && tool.length > 0 && tool.length <= 64)) {
    throw invalid("permissions.tools must be a bounded string array");
  }
  if (!Array.isArray(raw.rules) || raw.rules.length > 64) throw invalid("permissions.rules must be a bounded array");
  const rules = raw.rules.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw invalid(`permissions.rules[${index}] must be an object`);
    const rule = entry as Record<string, unknown>;
    if (!PERMISSION_SCOPES.has(String(rule.scope))) throw invalid(`permissions.rules[${index}].scope is invalid`);
    if (typeof rule.resource !== "string" || rule.resource.trim().length === 0 || rule.resource.length > 512) throw invalid(`permissions.rules[${index}].resource is invalid`);
    const resource = rule.resource.trim();
    if (resource.startsWith("skill://") && !SKILL_DEFINITIONS.has(resource.slice("skill://".length))) throw invalid(`permissions.rules[${index}].resource references an unregistered Skill`);
    if (resource.startsWith("mcp://") && !MCP_DEFINITIONS.has(resource.slice("mcp://".length))) throw invalid(`permissions.rules[${index}].resource references an unregistered MCP server`);
    if (!Array.isArray(rule.actions) || rule.actions.length === 0 || rule.actions.length > 5 || !rule.actions.every((action) => typeof action === "string" && PERMISSION_ACTIONS.has(action))) throw invalid(`permissions.rules[${index}].actions are invalid`);
    if (rule.effect !== undefined && rule.effect !== "allow" && rule.effect !== "deny") throw invalid(`permissions.rules[${index}].effect is invalid`);
    if (rule.approval !== undefined && typeof rule.approval !== "boolean") throw invalid(`permissions.rules[${index}].approval is invalid`);
    return {
      scope: rule.scope as HirePermissions["rules"][number]["scope"],
      resource,
      actions: [...new Set(rule.actions as HirePermissions["rules"][number]["actions"])],
      ...(rule.effect !== undefined ? { effect: rule.effect as "allow" | "deny" } : {}),
      ...(rule.approval !== undefined ? { approval: rule.approval } : {}),
    };
  });
  const skills: HireSkillGrant[] = raw.skills === undefined ? [] : (() => {
    if (!Array.isArray(raw.skills) || raw.skills.length > 32) throw invalid("permissions.skills must be a bounded array");
    const seen = new Set<string>();
    return raw.skills.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw invalid(`permissions.skills[${index}] must be an object`);
      const item = entry as Record<string, unknown>;
      if (typeof item.id !== "string" || !SKILL_DEFINITIONS.has(item.id)) throw invalid(`permissions.skills[${index}].id is not a registered Skill`);
      if (seen.has(item.id)) throw invalid(`permissions.skills[${index}].id is duplicated`);
      seen.add(item.id);
      if (item.version !== undefined && (typeof item.version !== "string" || item.version.trim().length === 0 || item.version.length > 64)) throw invalid(`permissions.skills[${index}].version is invalid`);
      return { id: item.id as HireSkillGrant["id"], ...(item.version !== undefined ? { version: item.version.trim() } : {}) };
    });
  })();
  const mcpServers: HireMcpGrant[] = raw.mcpServers === undefined ? [] : (() => {
    if (!Array.isArray(raw.mcpServers) || raw.mcpServers.length > 16) throw invalid("permissions.mcpServers must be a bounded array");
    const seen = new Set<string>();
    return raw.mcpServers.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw invalid(`permissions.mcpServers[${index}] must be an object`);
      const item = entry as Record<string, unknown>;
      const definition = typeof item.id === "string" ? MCP_DEFINITIONS.get(item.id) : undefined;
      if (!definition) throw invalid(`permissions.mcpServers[${index}].id is not a registered MCP server`);
      if (seen.has(definition.id)) throw invalid(`permissions.mcpServers[${index}].id is duplicated`);
      seen.add(definition.id);
      if (!Array.isArray(item.tools) || item.tools.length > definition.tools.length || !item.tools.every((tool) => typeof tool === "string" && (definition.tools as readonly string[]).includes(tool))) {
        throw invalid(`permissions.mcpServers[${index}].tools must use the registered tool list`);
      }
      const tools = [...new Set(item.tools as string[])];
      if (tools.length !== item.tools.length) throw invalid(`permissions.mcpServers[${index}].tools contains duplicates`);
      return { id: definition.id as HireMcpGrant["id"], tools };
    });
  })();
  return { tools: [...(raw.tools as string[])], rules, skills, mcpServers };
}

function validateMemorySources(value: unknown): HireMemorySource[] {
  if (!Array.isArray(value) || value.length > 8) throw invalid("memorySources must be a bounded array");
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw invalid(`memorySources[${index}] must be an object`);
    const item = entry as Record<string, unknown>;
    if (!MEMORY_KINDS.has(String(item.kind))) throw invalid(`memorySources[${index}].kind is invalid`);
    if (typeof item.locator !== "string" || item.locator.trim().length === 0 || item.locator.length > 512) throw invalid(`memorySources[${index}].locator is invalid`);
    return { kind: item.kind as HireMemorySource["kind"], locator: item.locator.trim() };
  });
}

function assertHireRequest(raw: unknown): ValidatedHireRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalid("hire request must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  const known = new Set(["positionId", "name", "description", "reportTo", "mode", "budget", "permissions", "prompt", "memorySources", "deadline"]);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) throw invalid(`unknown field: ${key}`);
  }
  if (!isPositionId(body.positionId)) throw invalid("positionId is invalid");
  if (!boundedNonEmptyString(body.name, MAX_NAME_BYTES)) throw invalid("name must be a non-empty string no larger than 128 bytes");
  if (!boundedNonEmptyCharacters(body.description, MAX_DESCRIPTION_CHARACTERS)) throw invalid(`description must be a non-empty string of at most ${MAX_DESCRIPTION_CHARACTERS} characters`);
  if (body.reportTo !== null && !isPositionId(body.reportTo)) throw invalid("reportTo must be a position id or null");
  if (body.mode !== "read_only" && body.mode !== "approval_required") throw invalid("mode must be read_only or approval_required");
  if (typeof body.budget !== "object" || body.budget === null || Array.isArray(body.budget)) {
    throw invalid("budget is required");
  }
  const budget = body.budget as Record<string, unknown>;
  for (const key of Object.keys(budget)) {
    if (key !== "perTask" && key !== "perDay") throw invalid(`budget.${key} is not part of the frozen budget vocabulary`);
  }
  const perTask = assertBudgetScope(budget.perTask, "perTask");
  const perDay = assertBudgetScope(budget.perDay, "perDay");
  if ((perTask.tokens ?? 0) > (perDay.tokens ?? 0)) throw invalid("budget.perTask.tokens cannot exceed budget.perDay.tokens");
  if (body.deadline !== undefined && (typeof body.deadline !== "string" || Number.isNaN(Date.parse(body.deadline)))) {
    throw invalid("deadline must parse as an ISO 8601 timestamp");
  }
  let prompt = "";
  if (body.prompt !== undefined) {
    if (typeof body.prompt !== "string" || body.prompt.trim().length > 4_000) {
      throw invalid("prompt must be a string of at most 4000 characters");
    }
    prompt = body.prompt.trim();
  }
  return {
    positionId: body.positionId,
    name: body.name.trim(),
    description: body.description.trim(),
    reportTo: body.reportTo,
    mode: body.mode,
    budget: { perTask, perDay } as PositionBudget,
    permissions: body.permissions === undefined ? { tools: ["Read", "Grep", "Glob"], rules: [] } : validatePermissions(body.permissions),
    prompt,
    memorySources: body.memorySources === undefined ? [{ kind: "position_docs", locator: "./knowledge/**" }] : validateMemorySources(body.memorySources),
    ...(body.deadline !== undefined ? { deadline: body.deadline } : {}),
  };
}

function buildHireEnvelope(input: {
  workspaceRef: string;
  positionId: string;
  packageDigest: string;
  targetParentId: string;
  budget: PositionBudget;
  deadline?: string;
}): HireRequestEnvelope {
  const body: Record<string, unknown> = {
    schemaVersion: HIRE_REQUEST_SCHEMA_VERSION,
    workspaceRef: input.workspaceRef,
    packageRef: {
      name: input.positionId,
      version: PACKAGE_VERSION,
      digest: input.packageDigest,
    },
    targetParentId: input.targetParentId,
    budget: input.budget,
    requestedBy: "operator",
  };
  if (input.deadline !== undefined) body.deadline = input.deadline;
  return { ...(body as Omit<HireRequestEnvelope, "envelopeDigest">), envelopeDigest: computeEnvelopeDigest(body) };
}

export async function handleHirePost(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const request = assertHireRequest(await readJsonBody<unknown>(req));
  const outcome = await withOrgMutationLock(ctx.workspace.requireOpen().dir, () => hireUnlocked(ctx, request));
  sendJson(res, outcome.status, outcome.body);
}

/**
 * S2 phase vocabulary (DS-33-001 §2): `hire.progress` marks the control-plane
 * gate boundaries only — no fabricated progress; the renderer keeps the last
 * phase copy when no event arrives.
 */
type HirePhase = "validate" | "stage" | "apply";

function emitHireProgress(ctx: ControlPlaneContext, positionId: string, phase: HirePhase): void {
  ctx.bus.publish("hire.progress", { positionId, phase });
}

async function hireUnlocked(
  ctx: ControlPlaneContext,
  request: ReturnType<typeof assertHireRequest>,
): Promise<{ status: number; body: HireSuccess | HireFailure }> {
  const ws = ctx.workspace.requireOpen();
  const exists = ws.organization.roles.some((role) => role.id === request.positionId);
  if (exists) {
    return {
      status: 409,
      body: { status: "failed", code: "hire_position_exists", message: `position already exists: ${request.positionId}`, retryable: false },
    };
  }
  if (request.reportTo !== null && !ws.organization.roles.some((role) => role.id === request.reportTo)) {
    throw invalid(`reportTo position not found: ${request.reportTo}`);
  }
  // Root hires report to the company owner; targetParentId is never empty upstream.
  const targetParentId = request.reportTo ?? ws.organization.owner;
  const allocatedPerDay = ws.organization.roles.reduce(
    (total, role) => total + (role.budget?.perDay.tokens ?? 0),
    0,
  );
  const remainingPool = Math.max(0, (ctx.config.budgetPoolTokens ?? 10_000_000) - allocatedPerDay);
  if ((request.budget.perDay.tokens ?? 0) > remainingPool) {
    throw invalid(`budget.perDay.tokens exceeds the remaining workspace pool (${remainingPool})`);
  }

  const files = buildPositionSkeletonFiles({
    id: request.positionId,
    name: request.name,
    description: request.description,
    mode: request.mode,
    budget: request.budget,
    permissions: request.permissions,
    prompt: request.prompt,
    memorySources: request.memorySources,
  });
  const employeeBytes = files.get("employee.json");
  if (employeeBytes === undefined) throw new Error("skeleton builder must emit employee.json");
  const packageDigest = `sha256:${crypto.createHash("sha256").update(employeeBytes, "utf8").digest("hex")}`;
  const envelope = buildHireEnvelope({
    workspaceRef: ws.dir,
    positionId: request.positionId,
    packageDigest,
    targetParentId,
    budget: request.budget,
    ...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
  });

  // Fail-closed gate one: static upstream validation before ANY filesystem effect.
  emitHireProgress(ctx, request.positionId, "validate");
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "owb-hire-"));
  const envelopeFile = path.join(staging, "hire-request.json");
  let validate;
  try {
    await fs.writeFile(envelopeFile, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    validate = await ctx.hireDriver.hireValidate(envelopeFile);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  if (validate.status === "engine_unavailable") {
    return { status: 503, body: { status: "failed", code: errorCodes.engine_unavailable, message: validate.message, retryable: true } };
  }
  if (validate.status === "engine_capability_missing") {
    return { status: 503, body: { status: "failed", code: errorCodes.engine_capability_missing, message: validate.message, retryable: false } };
  }
  if (validate.status === "failed") {
    return { status: 422, body: { status: "failed", code: validate.code, message: validate.message, retryable: false } };
  }

  // Gate two: stage the exact digested bytes, then let the engine adjudicate
  // the rebuilt tree through the same org apply seam move/delete use.
  emitHireProgress(ctx, request.positionId, "stage");
  const proposal = await scanProposalTree(ws.dir);
  const parent = proposal.find((position) => position.id === targetParentId);
  const destination = path.join(parent?.directory ?? path.join(ws.dir, POSITIONS_DIR), request.positionId);
  await assertDestinationAvailable(destination);
  await writeSkeletonFiles(destination, files);

  emitHireProgress(ctx, request.positionId, "apply");
  const engineResult = await ctx.driver.apply(ws.dir);
  if (engineResult.status !== "applied") {
    await fs.rm(destination, { recursive: true, force: true });
    if (engineResult.status === "engine_unavailable") {
      return { status: 503, body: { status: "failed", code: errorCodes.engine_unavailable, message: engineResult.message, retryable: true } };
    }
    if (engineResult.status === "engine_capability_missing") {
      return { status: 503, body: { status: "failed", code: errorCodes.engine_capability_missing, message: engineResult.message, retryable: false } };
    }
    return { status: 422, body: { status: "failed", code: engineResult.code, message: engineResult.message, retryable: engineResult.retryable } };
  }

  const version = await ctx.workspace.reloadAppliedOrganization();
  // D-32 linkage: a hired employee appends at the end of its parent's order.
  const order = { ...ctx.workspace.getLayout().order };
  const key = parentKey(request.reportTo);
  const siblings = order[key] ?? [];
  if (!siblings.includes(request.positionId)) {
    order[key] = [...siblings, request.positionId];
    await ctx.workspace.setLayoutOrder(order);
  }
  ctx.bus.publish("org.updated", {
    workspace: ws.dir,
    version,
    changes: [{ op: "hire", id: request.positionId }],
  });
  return {
    status: 200,
    body: { status: "hired", positionId: request.positionId, version },
  };
}
