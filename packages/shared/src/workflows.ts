/**
 * Workflow / task handoff contracts (v1alpha1).
 *
 * This is a shared, pure contract slice. It describes reusable work methods,
 * one execution of a method, and the bounded package needed to continue that
 * execution elsewhere. It does not persist state, execute an Agent, or expose
 * an HTTP surface.
 *
 * The validators are deliberately strict and fail closed: object keys are
 * allowlisted, enums are closed, references are unique, and text is bounded.
 */

import type { HireMemorySource, HirePermissions } from "./hire.js";
import { hireMcpCatalog, hireSkillCatalog, type HireMcpGrant, type HireSkillGrant } from "./capabilities.js";
import type { BudgetScope, PositionBudget } from "./org-tree.js";

export const WORKFLOW_TEMPLATE_SCHEMA_VERSION = "workflow-template.v1alpha1" as const;
export const WORKFLOW_TASK_SCHEMA_VERSION = "workflow-task.v1alpha1" as const;
export const HANDOFF_PACKAGE_SCHEMA_VERSION = "handoff-package.v1alpha1" as const;

/** Maximum UTF-16 code units for user-authored contract text. */
export const WORKFLOW_MAX_TEXT_LENGTH = 4_096;
export const WORKFLOW_MAX_SHORT_TEXT_LENGTH = 256;
export const WORKFLOW_MAX_LIST_ITEMS = 64;

export const workflowTargetKinds = ["position", "workspace", "project"] as const;
export type WorkflowTargetKind = (typeof workflowTargetKinds)[number];

export const workflowPortTypes = ["text", "number", "boolean", "object", "artifact"] as const;
export type WorkflowPortType = (typeof workflowPortTypes)[number];

export const workflowArtifactKinds = ["document", "file", "conversation", "report", "data", "code"] as const;
export type WorkflowArtifactKind = (typeof workflowArtifactKinds)[number];

export const workflowTaskStatuses = [
  "queued",
  "running",
  "waiting_approval",
  "blocked",
  "completed",
  "failed",
  "indeterminate",
  "cancelled",
] as const;
export type WorkflowTaskStatus = (typeof workflowTaskStatuses)[number];

export interface WorkflowTarget {
  kind: WorkflowTargetKind;
  id: string;
  objective: string;
}

export interface WorkflowPort {
  name: string;
  description: string;
  type: WorkflowPortType;
  required: boolean;
  multiple?: boolean;
}

/** A stable reference to a result that can be opened or verified later. */
export interface ArtifactRef {
  kind: WorkflowArtifactKind;
  id: string;
  title: string;
  /** User-safe URI or workspace-relative locator; never an absolute secret path. */
  locator: string;
  /** Content/version digest, retained for provenance and stale-result checks. */
  digest: string;
}

export type WorkflowPermissions = Omit<HirePermissions, "skills" | "mcpServers">;

export interface WorkflowCapabilityDefaults {
  skills: NonNullable<HirePermissions["skills"]>;
  mcpServers: NonNullable<HirePermissions["mcpServers"]>;
}

export interface WorkflowDefaults {
  agentId: string;
  /** Existing platform grants are references; binding them does not grant resources. */
  capabilities: WorkflowCapabilityDefaults;
  memorySources: HireMemorySource[];
  /** Resource actions are deliberately separate from capability binding. */
  permissions: WorkflowPermissions;
  budget: PositionBudget;
}

export interface WorkflowTemplate {
  schemaVersion: typeof WORKFLOW_TEMPLATE_SCHEMA_VERSION;
  templateId: string;
  name: string;
  version: string;
  description: string;
  target: WorkflowTarget;
  inputs: WorkflowPort[];
  outputs: WorkflowPort[];
  defaults: WorkflowDefaults;
}

export interface WorkflowTask {
  schemaVersion: typeof WORKFLOW_TASK_SCHEMA_VERSION;
  taskId: string;
  templateId: string;
  templateVersion: string;
  agentId: string;
  workspaceId: string;
  positionId: string;
  status: WorkflowTaskStatus;
  input: string;
  inputArtifacts: ArtifactRef[];
  output?: string;
  outputArtifacts: ArtifactRef[];
  createdAt: string;
  updatedAt: string;
}

export interface HandoffRecipient {
  agentId: string;
  workspaceId: string;
  positionId: string;
}

export interface HandoffPackage {
  schemaVersion: typeof HANDOFF_PACKAGE_SCHEMA_VERSION;
  handoffId: string;
  sourceTaskId: string;
  target: WorkflowTarget;
  recipient: HandoffRecipient;
  progress: string;
  nextSteps: string[];
  risks: string[];
  evidence: ArtifactRef[];
  artifacts: ArtifactRef[];
  createdAt: string;
}

export type WorkflowValidationCode =
  | "workflow_invalid"
  | "workflow_unknown_field"
  | "workflow_empty_string"
  | "workflow_text_too_long"
  | "workflow_invalid_enum"
  | "workflow_duplicate_reference"
  | "workflow_invalid_transition";

export type WorkflowValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: WorkflowValidationCode; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: WorkflowValidationCode, message: string): { ok: false; code: WorkflowValidationCode; message: string } {
  return { ok: false, code, message };
}

function keysMatch(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key));
}

function nonEmptyText(
  value: unknown,
  field: string,
  maxLength = WORKFLOW_MAX_TEXT_LENGTH,
): WorkflowValidationResult<string> {
  if (typeof value !== "string" || value.trim().length === 0) return fail("workflow_empty_string", `${field} must be a non-empty string`);
  if (value.length > maxLength) return fail("workflow_text_too_long", `${field} exceeds its text bound`);
  if ([...value].some((character) => character.charCodeAt(0) < 0x20 && character !== "\n" && character !== "\r" && character !== "\t")) {
    return fail("workflow_invalid", `${field} contains a control character`);
  }
  return { ok: true, value };
}

function identifier(value: unknown, field: string): WorkflowValidationResult<string> {
  const result = nonEmptyText(value, field, WORKFLOW_MAX_SHORT_TEXT_LENGTH);
  if (!result.ok) return result;
  if (/\s/.test(result.value)) return fail("workflow_invalid", `${field} must not contain whitespace`);
  return result;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): WorkflowValidationResult<T> {
  if (typeof value !== "string" || !values.includes(value as T)) return fail("workflow_invalid_enum", `${field} is outside the allowlist`);
  return { ok: true, value: value as T };
}

function booleanValue(value: unknown, field: string): WorkflowValidationResult<boolean> {
  return typeof value === "boolean" ? { ok: true, value } : fail("workflow_invalid", `${field} must be a boolean`);
}

function boundedList(value: unknown, field: string): WorkflowValidationResult<unknown[]> {
  if (!Array.isArray(value)) return fail("workflow_invalid", `${field} must be an array`);
  if (value.length > WORKFLOW_MAX_LIST_ITEMS) return fail("workflow_invalid", `${field} has too many items`);
  return { ok: true, value };
}

function uniqueStrings(values: string[], field: string): WorkflowValidationResult<string[]> {
  if (new Set(values).size !== values.length) return fail("workflow_duplicate_reference", `${field} contains duplicate values`);
  return { ok: true, value: values };
}

function validateTarget(raw: unknown, field: string): WorkflowValidationResult<WorkflowTarget> {
  if (!isRecord(raw) || !keysMatch(raw, ["kind", "id", "objective"])) return fail("workflow_unknown_field", `${field} has unexpected or missing fields`);
  const kind = enumValue(raw.kind, workflowTargetKinds, `${field}.kind`);
  if (!kind.ok) return kind;
  const id = identifier(raw.id, `${field}.id`);
  if (!id.ok) return id;
  const objective = nonEmptyText(raw.objective, `${field}.objective`);
  if (!objective.ok) return objective;
  return { ok: true, value: { kind: kind.value, id: id.value, objective: objective.value } };
}

function validatePort(raw: unknown, field: string): WorkflowValidationResult<WorkflowPort> {
  if (!isRecord(raw) || !keysMatch(raw, ["name", "description", "type", "required"], ["multiple"])) {
    return fail("workflow_unknown_field", `${field} has unexpected or missing fields`);
  }
  const name = identifier(raw.name, `${field}.name`);
  if (!name.ok) return name;
  const description = nonEmptyText(raw.description, `${field}.description`);
  if (!description.ok) return description;
  const type = enumValue(raw.type, workflowPortTypes, `${field}.type`);
  if (!type.ok) return type;
  const required = booleanValue(raw.required, `${field}.required`);
  if (!required.ok) return required;
  const multiple = raw.multiple === undefined ? undefined : booleanValue(raw.multiple, `${field}.multiple`);
  if (multiple !== undefined && !multiple.ok) return multiple;
  return {
    ok: true,
    value: {
      name: name.value,
      description: description.value,
      type: type.value,
      required: required.value,
      ...(multiple === undefined ? {} : { multiple: multiple.value }),
    },
  };
}

function validateArtifactList(raw: unknown, field: string): WorkflowValidationResult<ArtifactRef[]> {
  const list = boundedList(raw, field);
  if (!list.ok) return list;
  const artifacts: ArtifactRef[] = [];
  for (let index = 0; index < list.value.length; index += 1) {
    const parsed = validateArtifactRef(list.value[index]);
    if (!parsed.ok) return fail(parsed.code, `${field}[${index}]: ${parsed.message}`);
    artifacts.push(parsed.value);
  }
  const unique = uniqueArtifactRefs(artifacts, field);
  return unique.ok ? { ok: true, value: artifacts } : unique;
}

function artifactKey(ref: ArtifactRef): string {
  return `${ref.kind}:${ref.id}`;
}

function uniqueArtifactRefs(values: ArtifactRef[], field: string): WorkflowValidationResult<ArtifactRef[]> {
  if (new Set(values.map(artifactKey)).size !== values.length) return fail("workflow_duplicate_reference", `${field} contains duplicate artifacts`);
  return { ok: true, value: values };
}

function validateMemorySources(raw: unknown): WorkflowValidationResult<HireMemorySource[]> {
  const list = boundedList(raw, "defaults.memorySources");
  if (!list.ok) return list;
  const values: HireMemorySource[] = [];
  const keys = new Set<string>();
  for (let index = 0; index < list.value.length; index += 1) {
    const source = list.value[index];
    if (!isRecord(source) || !keysMatch(source, ["kind", "locator"])) return fail("workflow_unknown_field", `defaults.memorySources[${index}] has unexpected or missing fields`);
    const kind = enumValue(source.kind, ["position_docs", "workspace_docs", "mem_drive", "runtime_context"] as const, `defaults.memorySources[${index}].kind`);
    if (!kind.ok) return kind;
    const locator = nonEmptyText(source.locator, `defaults.memorySources[${index}].locator`, WORKFLOW_MAX_SHORT_TEXT_LENGTH);
    if (!locator.ok) return locator;
    const key = `${kind.value}:${locator.value}`;
    if (keys.has(key)) return fail("workflow_duplicate_reference", "defaults.memorySources contains duplicate references");
    keys.add(key);
    values.push({ kind: kind.value, locator: locator.value });
  }
  return { ok: true, value: values };
}

function validateBudgetScope(raw: unknown, field: string): WorkflowValidationResult<BudgetScope> {
  if (!isRecord(raw) || Object.keys(raw).some((key) => key !== "tokens" && key !== "iterations")) {
    return fail("workflow_unknown_field", `${field} has unexpected fields`);
  }
  const result: BudgetScope = {};
  for (const key of ["tokens", "iterations"] as const) {
    if (raw[key] === undefined) continue;
    if (!Number.isSafeInteger(raw[key]) || (raw[key] as number) <= 0 || (raw[key] as number) > 1_000_000_000) {
      return fail("workflow_invalid", `${field}.${key} must be a positive bounded integer`);
    }
    result[key] = raw[key] as number;
  }
  if (Object.keys(result).length === 0) return fail("workflow_invalid", `${field} must declare a token or iteration cap`);
  return { ok: true, value: result };
}

function validateBudget(raw: unknown): WorkflowValidationResult<PositionBudget> {
  if (!isRecord(raw) || !keysMatch(raw, ["perTask", "perDay"])) return fail("workflow_unknown_field", "defaults.budget has unexpected or missing fields");
  const perTask = validateBudgetScope(raw.perTask, "defaults.budget.perTask");
  if (!perTask.ok) return perTask;
  const perDay = validateBudgetScope(raw.perDay, "defaults.budget.perDay");
  if (!perDay.ok) return perDay;
  return { ok: true, value: { perTask: perTask.value, perDay: perDay.value } };
}

function validateSkillGrant(raw: unknown, field: string): WorkflowValidationResult<HireSkillGrant> {
  if (!isRecord(raw) || !keysMatch(raw, ["id"], ["version"])) return fail("workflow_unknown_field", `${field} has unexpected or missing fields`);
  if (typeof raw.id !== "string" || !hireSkillCatalog.some((skill) => skill.id === raw.id)) return fail("workflow_invalid_enum", `${field}.id is not a registered Skill`);
  const version = raw.version === undefined ? undefined : identifier(raw.version, `${field}.version`);
  if (version !== undefined && !version.ok) return version;
  return { ok: true, value: { id: raw.id as HireSkillGrant["id"], ...(version === undefined ? {} : { version: version.value }) } };
}

function validateMcpGrant(raw: unknown, field: string): WorkflowValidationResult<HireMcpGrant> {
  if (!isRecord(raw) || !keysMatch(raw, ["id", "tools"])) return fail("workflow_unknown_field", `${field} has unexpected or missing fields`);
  const definition = hireMcpCatalog.find((mcp) => mcp.id === raw.id);
  if (!definition) return fail("workflow_invalid_enum", `${field}.id is not a registered MCP server`);
  const tools = boundedList(raw.tools, `${field}.tools`);
  if (!tools.ok) return tools;
  const strings: string[] = [];
  for (let index = 0; index < tools.value.length; index += 1) {
    const tool = identifier(tools.value[index], `${field}.tools[${index}]`);
    if (!tool.ok) return tool;
    if (!(definition.tools as readonly string[]).includes(tool.value)) return fail("workflow_invalid_enum", `${field}.tools[${index}] is not registered by the MCP server`);
    strings.push(tool.value);
  }
  const unique = uniqueStrings(strings, `${field}.tools`);
  if (!unique.ok) return unique;
  return { ok: true, value: { id: definition.id, tools: strings } };
}

function validatePermissions(raw: unknown): WorkflowValidationResult<WorkflowPermissions> {
  if (!isRecord(raw) || !keysMatch(raw, ["tools", "rules"])) return fail("workflow_unknown_field", "defaults.permissions has unexpected or missing fields");
  const tools = boundedList(raw.tools, "defaults.permissions.tools");
  if (!tools.ok) return tools;
  const toolNames: string[] = [];
  for (let index = 0; index < tools.value.length; index += 1) {
    const tool = identifier(tools.value[index], `defaults.permissions.tools[${index}]`);
    if (!tool.ok) return tool;
    toolNames.push(tool.value);
  }
  const uniqueTools = uniqueStrings(toolNames, "defaults.permissions.tools");
  if (!uniqueTools.ok) return uniqueTools;

  const rules = boundedList(raw.rules, "defaults.permissions.rules");
  if (!rules.ok) return rules;
  const permissionRules: HirePermissions["rules"] = [];
  for (let index = 0; index < rules.value.length; index += 1) {
    const rule = rules.value[index];
    if (!isRecord(rule) || !keysMatch(rule, ["scope", "resource", "actions"], ["effect", "approval"])) {
      return fail("workflow_unknown_field", `defaults.permissions.rules[${index}] has unexpected or missing fields`);
    }
    const scope = enumValue(rule.scope, ["position", "workspace", "project"] as const, `defaults.permissions.rules[${index}].scope`);
    if (!scope.ok) return scope;
    const resource = nonEmptyText(rule.resource, `defaults.permissions.rules[${index}].resource`, WORKFLOW_MAX_SHORT_TEXT_LENGTH);
    if (!resource.ok) return resource;
    const actions = boundedList(rule.actions, `defaults.permissions.rules[${index}].actions`);
    if (!actions.ok) return actions;
    const actionValues: HirePermissions["rules"][number]["actions"] = [];
    for (let actionIndex = 0; actionIndex < actions.value.length; actionIndex += 1) {
      const action = enumValue(rule.actions instanceof Array ? rule.actions[actionIndex] : undefined, ["read", "create", "update", "delete", "execute"] as const, `defaults.permissions.rules[${index}].actions[${actionIndex}]`);
      if (!action.ok) return action;
      actionValues.push(action.value);
    }
    if (actionValues.length === 0) return fail("workflow_invalid", `defaults.permissions.rules[${index}].actions must not be empty`);
    const uniqueActions = uniqueStrings(actionValues, `defaults.permissions.rules[${index}].actions`);
    if (!uniqueActions.ok) return uniqueActions;
    const effect = rule.effect === undefined ? undefined : enumValue(rule.effect, ["allow", "deny"] as const, `defaults.permissions.rules[${index}].effect`);
    if (effect !== undefined && !effect.ok) return effect;
    const approval = rule.approval === undefined ? undefined : booleanValue(rule.approval, `defaults.permissions.rules[${index}].approval`);
    if (approval !== undefined && !approval.ok) return approval;
    permissionRules.push({
      scope: scope.value,
      resource: resource.value,
      actions: actionValues,
      ...(effect === undefined ? {} : { effect: effect.value }),
      ...(approval === undefined ? {} : { approval: approval.value }),
    });
  }

  return { ok: true, value: { tools: toolNames, rules: permissionRules } };
}

function validateCapabilities(raw: unknown): WorkflowValidationResult<WorkflowCapabilityDefaults> {
  if (!isRecord(raw) || !keysMatch(raw, ["skills", "mcpServers"])) return fail("workflow_unknown_field", "defaults.capabilities has unexpected or missing fields");
  const skills = boundedList(raw.skills, "defaults.capabilities.skills");
  if (!skills.ok) return skills;
  const skillGrants: HireSkillGrant[] = [];
  for (let index = 0; index < skills.value.length; index += 1) {
    const skill = validateSkillGrant(skills.value[index], `defaults.capabilities.skills[${index}]`);
    if (!skill.ok) return skill;
    skillGrants.push(skill.value);
  }
  const mcpServers = boundedList(raw.mcpServers, "defaults.capabilities.mcpServers");
  if (!mcpServers.ok) return mcpServers;
  const mcpGrants: HireMcpGrant[] = [];
  for (let index = 0; index < mcpServers.value.length; index += 1) {
    const mcp = validateMcpGrant(mcpServers.value[index], `defaults.capabilities.mcpServers[${index}]`);
    if (!mcp.ok) return mcp;
    mcpGrants.push(mcp.value);
  }
  return { ok: true, value: { skills: skillGrants, mcpServers: mcpGrants } };
}

function validateDefaults(raw: unknown): WorkflowValidationResult<WorkflowDefaults> {
  if (!isRecord(raw) || !keysMatch(raw, ["agentId", "capabilities", "memorySources", "permissions", "budget"])) {
    return fail("workflow_unknown_field", "defaults has unexpected or missing fields");
  }
  const agentId = identifier(raw.agentId, "defaults.agentId");
  if (!agentId.ok) return agentId;
  const capabilities = validateCapabilities(raw.capabilities);
  if (!capabilities.ok) return capabilities;
  const memorySources = validateMemorySources(raw.memorySources);
  if (!memorySources.ok) return memorySources;
  const permissions = validatePermissions(raw.permissions);
  if (!permissions.ok) return permissions;
  const budget = validateBudget(raw.budget);
  if (!budget.ok) return budget;
  return { ok: true, value: { agentId: agentId.value, capabilities: capabilities.value, memorySources: memorySources.value, permissions: permissions.value, budget: budget.value } };
}

function validateIdentifierField(raw: Record<string, unknown>, key: string): WorkflowValidationResult<string> {
  return identifier(raw[key], key);
}

/** Pure validator for a stable artifact reference. */
export function validateArtifactRef(raw: unknown): WorkflowValidationResult<ArtifactRef> {
  if (!isRecord(raw) || !keysMatch(raw, ["kind", "id", "title", "locator", "digest"])) return fail("workflow_unknown_field", "artifact reference has unexpected or missing fields");
  const kind = enumValue(raw.kind, workflowArtifactKinds, "artifact.kind");
  if (!kind.ok) return kind;
  const id = identifier(raw.id, "artifact.id");
  if (!id.ok) return id;
  const title = nonEmptyText(raw.title, "artifact.title", WORKFLOW_MAX_SHORT_TEXT_LENGTH);
  if (!title.ok) return title;
  const locator = nonEmptyText(raw.locator, "artifact.locator", WORKFLOW_MAX_TEXT_LENGTH);
  if (!locator.ok) return locator;
  const digest = identifier(raw.digest, "artifact.digest");
  if (!digest.ok) return digest;
  return { ok: true, value: { kind: kind.value, id: id.value, title: title.value, locator: locator.value, digest: digest.value } };
}

export const parseArtifactRef = validateArtifactRef;

/** Pure validator for a reusable workflow template. */
export function validateWorkflowTemplate(raw: unknown): WorkflowValidationResult<WorkflowTemplate> {
  if (!isRecord(raw) || !keysMatch(raw, ["schemaVersion", "templateId", "name", "version", "description", "target", "inputs", "outputs", "defaults"])) {
    return fail("workflow_unknown_field", "workflow template has unexpected or missing fields");
  }
  if (raw.schemaVersion !== WORKFLOW_TEMPLATE_SCHEMA_VERSION) return fail("workflow_invalid", "workflow template schemaVersion mismatch");
  const templateId = validateIdentifierField(raw, "templateId");
  if (!templateId.ok) return templateId;
  const name = nonEmptyText(raw.name, "name", WORKFLOW_MAX_SHORT_TEXT_LENGTH);
  if (!name.ok) return name;
  const version = identifier(raw.version, "version");
  if (!version.ok) return version;
  const description = nonEmptyText(raw.description, "description");
  if (!description.ok) return description;
  const target = validateTarget(raw.target, "target");
  if (!target.ok) return target;
  const inputs = boundedList(raw.inputs, "inputs");
  if (!inputs.ok) return inputs;
  const inputPorts: WorkflowPort[] = [];
  for (let index = 0; index < inputs.value.length; index += 1) {
    const port = validatePort(inputs.value[index], `inputs[${index}]`);
    if (!port.ok) return port;
    inputPorts.push(port.value);
  }
  const inputNames = uniqueStrings(inputPorts.map((port) => port.name), "inputs");
  if (!inputNames.ok) return inputNames;
  const outputs = boundedList(raw.outputs, "outputs");
  if (!outputs.ok) return outputs;
  const outputPorts: WorkflowPort[] = [];
  for (let index = 0; index < outputs.value.length; index += 1) {
    const port = validatePort(outputs.value[index], `outputs[${index}]`);
    if (!port.ok) return port;
    outputPorts.push(port.value);
  }
  const outputNames = uniqueStrings(outputPorts.map((port) => port.name), "outputs");
  if (!outputNames.ok) return outputNames;
  const defaults = validateDefaults(raw.defaults);
  if (!defaults.ok) return defaults;
  return { ok: true, value: { schemaVersion: WORKFLOW_TEMPLATE_SCHEMA_VERSION, templateId: templateId.value, name: name.value, version: version.value, description: description.value, target: target.value, inputs: inputPorts, outputs: outputPorts, defaults: defaults.value } };
}

export const parseWorkflowTemplate = validateWorkflowTemplate;

/** Pure validator for one workflow execution. */
export function validateWorkflowTask(raw: unknown): WorkflowValidationResult<WorkflowTask> {
  if (!isRecord(raw) || !keysMatch(raw, ["schemaVersion", "taskId", "templateId", "templateVersion", "agentId", "workspaceId", "positionId", "status", "input", "inputArtifacts", "outputArtifacts", "createdAt", "updatedAt"], ["output"])) {
    return fail("workflow_unknown_field", "workflow task has unexpected or missing fields");
  }
  if (raw.schemaVersion !== WORKFLOW_TASK_SCHEMA_VERSION) return fail("workflow_invalid", "workflow task schemaVersion mismatch");
  const ids: Record<string, string> = {};
  for (const key of ["taskId", "templateId", "templateVersion", "agentId", "workspaceId", "positionId"] as const) {
    const value = identifier(raw[key], key);
    if (!value.ok) return value;
    ids[key] = value.value;
  }
  const status = enumValue(raw.status, workflowTaskStatuses, "status");
  if (!status.ok) return status;
  const input = nonEmptyText(raw.input, "input");
  if (!input.ok) return input;
  const inputArtifacts = validateArtifactList(raw.inputArtifacts, "inputArtifacts");
  if (!inputArtifacts.ok) return inputArtifacts;
  const output = raw.output === undefined ? undefined : nonEmptyText(raw.output, "output");
  if (output !== undefined && !output.ok) return output;
  const outputArtifacts = validateArtifactList(raw.outputArtifacts, "outputArtifacts");
  if (!outputArtifacts.ok) return outputArtifacts;
  const createdAt = nonEmptyText(raw.createdAt, "createdAt", WORKFLOW_MAX_SHORT_TEXT_LENGTH);
  if (!createdAt.ok) return createdAt;
  const updatedAt = nonEmptyText(raw.updatedAt, "updatedAt", WORKFLOW_MAX_SHORT_TEXT_LENGTH);
  if (!updatedAt.ok) return updatedAt;
  const allArtifacts = uniqueArtifactRefs([...inputArtifacts.value, ...outputArtifacts.value], "workflow task artifact references");
  if (!allArtifacts.ok) return allArtifacts;
  return {
    ok: true,
    value: {
      schemaVersion: WORKFLOW_TASK_SCHEMA_VERSION,
      taskId: ids.taskId!,
      templateId: ids.templateId!,
      templateVersion: ids.templateVersion!,
      agentId: ids.agentId!,
      workspaceId: ids.workspaceId!,
      positionId: ids.positionId!,
      status: status.value,
      input: input.value,
      inputArtifacts: inputArtifacts.value,
      ...(output === undefined ? {} : { output: output.value }),
      outputArtifacts: outputArtifacts.value,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
    },
  };
}

export const parseWorkflowTask = validateWorkflowTask;

function validateRecipient(raw: unknown): WorkflowValidationResult<HandoffRecipient> {
  if (!isRecord(raw) || !keysMatch(raw, ["agentId", "workspaceId", "positionId"])) return fail("workflow_unknown_field", "recipient has unexpected or missing fields");
  const agentId = identifier(raw.agentId, "recipient.agentId");
  if (!agentId.ok) return agentId;
  const workspaceId = identifier(raw.workspaceId, "recipient.workspaceId");
  if (!workspaceId.ok) return workspaceId;
  const positionId = identifier(raw.positionId, "recipient.positionId");
  if (!positionId.ok) return positionId;
  return { ok: true, value: { agentId: agentId.value, workspaceId: workspaceId.value, positionId: positionId.value } };
}

function validateTextList(raw: unknown, field: string): WorkflowValidationResult<string[]> {
  const list = boundedList(raw, field);
  if (!list.ok) return list;
  const values: string[] = [];
  for (let index = 0; index < list.value.length; index += 1) {
    const value = nonEmptyText(list.value[index], `${field}[${index}]`);
    if (!value.ok) return value;
    values.push(value.value);
  }
  return uniqueStrings(values, field);
}

/** Pure validator for a bounded handoff package. */
export function validateHandoffPackage(raw: unknown): WorkflowValidationResult<HandoffPackage> {
  if (!isRecord(raw) || !keysMatch(raw, ["schemaVersion", "handoffId", "sourceTaskId", "target", "recipient", "progress", "nextSteps", "risks", "evidence", "artifacts", "createdAt"])) {
    return fail("workflow_unknown_field", "handoff package has unexpected or missing fields");
  }
  if (raw.schemaVersion !== HANDOFF_PACKAGE_SCHEMA_VERSION) return fail("workflow_invalid", "handoff package schemaVersion mismatch");
  const handoffId = identifier(raw.handoffId, "handoffId");
  if (!handoffId.ok) return handoffId;
  const sourceTaskId = identifier(raw.sourceTaskId, "sourceTaskId");
  if (!sourceTaskId.ok) return sourceTaskId;
  const target = validateTarget(raw.target, "target");
  if (!target.ok) return target;
  const recipient = validateRecipient(raw.recipient);
  if (!recipient.ok) return recipient;
  const progress = nonEmptyText(raw.progress, "progress");
  if (!progress.ok) return progress;
  const nextSteps = validateTextList(raw.nextSteps, "nextSteps");
  if (!nextSteps.ok) return nextSteps;
  const risks = validateTextList(raw.risks, "risks");
  if (!risks.ok) return risks;
  const evidence = validateArtifactList(raw.evidence, "evidence");
  if (!evidence.ok) return evidence;
  const artifacts = validateArtifactList(raw.artifacts, "artifacts");
  if (!artifacts.ok) return artifacts;
  const allArtifacts = uniqueArtifactRefs([...evidence.value, ...artifacts.value], "handoff artifact references");
  if (!allArtifacts.ok) return allArtifacts;
  const createdAt = nonEmptyText(raw.createdAt, "createdAt", WORKFLOW_MAX_SHORT_TEXT_LENGTH);
  if (!createdAt.ok) return createdAt;
  return { ok: true, value: { schemaVersion: HANDOFF_PACKAGE_SCHEMA_VERSION, handoffId: handoffId.value, sourceTaskId: sourceTaskId.value, target: target.value, recipient: recipient.value, progress: progress.value, nextSteps: nextSteps.value, risks: risks.value, evidence: evidence.value, artifacts: artifacts.value, createdAt: createdAt.value } };
}

export const parseHandoffPackage = validateHandoffPackage;

const allowedTaskTransitions: Readonly<Record<WorkflowTaskStatus, readonly WorkflowTaskStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["waiting_approval", "blocked", "completed", "failed", "indeterminate", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"],
  blocked: ["running", "cancelled"],
  completed: [],
  failed: [],
  indeterminate: [],
  cancelled: [],
};

/** Pure state-machine guard; terminal states cannot be revived. */
export function canTransitionWorkflowTask(from: unknown, to: unknown): boolean {
  if (!workflowTaskStatuses.includes(from as WorkflowTaskStatus) || !workflowTaskStatuses.includes(to as WorkflowTaskStatus)) return false;
  return allowedTaskTransitions[from as WorkflowTaskStatus].includes(to as WorkflowTaskStatus);
}

export function validateWorkflowTaskTransition(from: unknown, to: unknown): WorkflowValidationResult<{ from: WorkflowTaskStatus; to: WorkflowTaskStatus }> {
  if (!workflowTaskStatuses.includes(from as WorkflowTaskStatus) || !workflowTaskStatuses.includes(to as WorkflowTaskStatus)) return fail("workflow_invalid_enum", "workflow task state is outside the allowlist");
  if (!canTransitionWorkflowTask(from, to)) return fail("workflow_invalid_transition", "workflow task state transition is not allowed");
  return { ok: true, value: { from: from as WorkflowTaskStatus, to: to as WorkflowTaskStatus } };
}

export function isWorkflowTaskStatus(value: unknown): value is WorkflowTaskStatus {
  return workflowTaskStatuses.includes(value as WorkflowTaskStatus);
}
