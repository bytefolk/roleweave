import assert from "node:assert/strict";
import test from "node:test";
import {
  HANDOFF_PACKAGE_SCHEMA_VERSION,
  WORKFLOW_MAX_TEXT_LENGTH,
  WORKFLOW_TASK_SCHEMA_VERSION,
  WORKFLOW_TEMPLATE_SCHEMA_VERSION,
  canTransitionWorkflowTask,
  validateHandoffPackage,
  validateWorkflowTask,
  validateWorkflowTaskTransition,
  validateWorkflowTemplate,
} from "@roleweave/shared";

const artifact = {
  kind: "document",
  id: "doc-001",
  title: "调研结论",
  locator: "owb-doc://issue-researcher/knowledge/result.md",
  digest: "sha256:abc123",
} as const;

const defaults = {
  agentId: "qoder-agent",
  capabilities: {
    skills: [{ id: "issue-research" }],
    mcpServers: [{ id: "repository", tools: ["search", "read"] }],
  },
  memorySources: [{ kind: "position_docs", locator: "positions/issue-researcher/knowledge" }],
  permissions: {
    tools: ["Read", "Grep"],
    rules: [{ scope: "workspace", resource: "docs/**", actions: ["read"] }],
  },
  budget: {
    perTask: { tokens: 20_000, iterations: 8 },
    perDay: { tokens: 200_000, iterations: 64 },
  },
} as const;

const template = {
  schemaVersion: WORKFLOW_TEMPLATE_SCHEMA_VERSION,
  templateId: "issue-research",
  name: "Issue 调研",
  version: "1.0.0",
  description: "读取本地 Issue 和仓库资料，输出带证据的研究结论。",
  target: { kind: "position", id: "issue-researcher", objective: "形成可供 Repo Owner 审核的调研结论" },
  inputs: [{ name: "issue", description: "待调研的 Issue 编号或引用", type: "text", required: true }],
  outputs: [{ name: "conclusion", description: "带证据引用的调研结论", type: "artifact", required: true }],
  defaults,
} as const;

const task = {
  schemaVersion: WORKFLOW_TASK_SCHEMA_VERSION,
  taskId: "task-001",
  templateId: "issue-research",
  templateVersion: "1.0.0",
  agentId: "qoder-agent",
  workspaceId: "workspace-001",
  positionId: "issue-researcher",
  status: "completed",
  input: "调研 issue #123",
  inputArtifacts: [],
  output: "已完成调研，结论见产物。",
  outputArtifacts: [artifact],
  createdAt: "2026-09-05T10:00:00.000Z",
  updatedAt: "2026-09-05T10:01:00.000Z",
} as const;

const handoff = {
  schemaVersion: HANDOFF_PACKAGE_SCHEMA_VERSION,
  handoffId: "handoff-001",
  sourceTaskId: "task-001",
  target: { kind: "position", id: "repo-owner", objective: "审核调研结论并决定下一步处理方式" },
  recipient: { agentId: "qoder-agent", workspaceId: "workspace-001", positionId: "repo-owner" },
  progress: "已读取 Issue、CHANGELOG 和仓库相关文档，形成初步结论。",
  nextSteps: ["核对结论中的版本影响", "决定是否创建修复任务"],
  risks: ["尚未获得线上运行数据"],
  evidence: [artifact],
  artifacts: [],
  createdAt: "2026-09-05T10:02:00.000Z",
} as const;

test("workflow v1alpha1 accepts a complete template, task, and handoff sample", () => {
  assert.equal(validateWorkflowTemplate(template).ok, true);
  assert.equal(validateWorkflowTask(task).ok, true);
  assert.equal(validateHandoffPackage(handoff).ok, true);
});

test("workflow validators reject unknown fields and invalid enum values", () => {
  const unknownField = validateWorkflowTemplate({ ...template, unexpected: true });
  assert.equal(unknownField.ok, false);
  if (!unknownField.ok) assert.equal(unknownField.code, "workflow_unknown_field");

  const invalidPort = validateWorkflowTemplate({
    ...template,
    inputs: [{ ...template.inputs[0], type: "prompt" }],
  });
  assert.equal(invalidPort.ok, false);
  if (!invalidPort.ok) assert.equal(invalidPort.code, "workflow_invalid_enum");

  const invalidStatus = validateWorkflowTask({ ...task, status: "paused" });
  assert.equal(invalidStatus.ok, false);
  if (!invalidStatus.ok) assert.equal(invalidStatus.code, "workflow_invalid_enum");
});

test("workflow validators reject duplicate artifact references in task and handoff", () => {
  const duplicateTask = validateWorkflowTask({ ...task, inputArtifacts: [artifact], outputArtifacts: [artifact] });
  assert.equal(duplicateTask.ok, false);
  if (!duplicateTask.ok) assert.equal(duplicateTask.code, "workflow_duplicate_reference");

  const duplicateHandoff = validateHandoffPackage({ ...handoff, artifacts: [artifact] });
  assert.equal(duplicateHandoff.ok, false);
  if (!duplicateHandoff.ok) assert.equal(duplicateHandoff.code, "workflow_duplicate_reference");
});

test("workflow task state transitions are explicit and terminal states cannot revive", () => {
  assert.equal(canTransitionWorkflowTask("queued", "running"), true);
  assert.equal(canTransitionWorkflowTask("running", "waiting_approval"), true);
  assert.equal(canTransitionWorkflowTask("waiting_approval", "running"), true);
  assert.equal(canTransitionWorkflowTask("running", "blocked"), true);
  assert.equal(canTransitionWorkflowTask("blocked", "running"), true);
  assert.equal(canTransitionWorkflowTask("running", "completed"), true);
  assert.equal(canTransitionWorkflowTask("running", "indeterminate"), true);
  assert.equal(canTransitionWorkflowTask("waiting_approval", "completed"), false);
  assert.equal(canTransitionWorkflowTask("completed", "running"), false);
  assert.equal(canTransitionWorkflowTask("failed", "queued"), false);
  assert.equal(canTransitionWorkflowTask("indeterminate", "running"), false);
  assert.equal(canTransitionWorkflowTask("unknown", "running"), false);

  const rejected = validateWorkflowTaskTransition("completed", "running");
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, "workflow_invalid_transition");
});

test("workflow validators fail closed on empty and overlong text", () => {
  const tooLong = validateWorkflowTask({ ...task, input: "x".repeat(WORKFLOW_MAX_TEXT_LENGTH + 1) });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.code, "workflow_text_too_long");

  const emptyProgress = validateHandoffPackage({ ...handoff, progress: "   " });
  assert.equal(emptyProgress.ok, false);
  if (!emptyProgress.ok) assert.equal(emptyProgress.code, "workflow_empty_string");
});
