// #33 四态状态机（发起 → 过程态 → 审批(可选) → 终态）+ hire 契约消费映射。
// 消费修订（R3 冻结门禁项①②③，PM 台账 2026-08-26）：
// - 权威词表 = hire-request.v1alpha1（digital-employee #194/#198，merge b3d54bf）；
// - renderer 草稿携带 HirePositionRequest 及 Workbench 的岗位策略元数据；envelope 骨架字段
//   workspaceRef / packageRef{name,version,digest} / targetParentId / budget /
//   requestedBy / deadline / envelopeDigest 全部由控制面 POST /hire 组装，
//   renderer 不构造、不扩展任何 envelope 词表；
// - reportTo（草稿侧）→ targetParentId 由控制面解析（null = 企业负责人），
//   identity.reportTo 不存在于骨架（服务端硬拒面由上游 fail-closed 承担）；
// - 审批态：hire 通道上游无 approval 语义（hire-contract.md Consumer boundary），
//   approval 相位仅为四态机保留位，动作集合刻意没有 approve/deny；turn 内审批
//   走 #25 Slice B 的 approval 三事件契约，两线零混用。

import type {
  HireMcpGrant,
  HireMemorySource,
  HirePermissions,
  HirePositionRequest,
  PositionBudget,
} from "@roleweave/shared";
import { hireMcpCatalog, hireSkillCatalog } from "@roleweave/shared/capabilities";

export interface HireProposal {
  name?: string;
  description?: string;
  mode?: HireDraft["mode"];
  tools?: string[];
  memorySources?: HireMemorySource["kind"][];
  skills?: string[];
  mcpServers?: HireMcpGrant[];
}

const PROPOSAL_TOOLS = new Set(["Read", "Grep", "Glob", "Write", "Edit", "Delete", "Exec"]);
// Memory shown and configured in v1 is intentionally limited to the two
// human-manageable sources: workspace documents and the shared drive.
const PROPOSAL_MEMORY = new Set<HireMemorySource["kind"]>(["position_docs", "workspace_docs", "mem_drive"]);
const PROPOSAL_SKILLS = new Set<string>(hireSkillCatalog.map((skill) => skill.id));
const PROPOSAL_MCP = new Map<string, (typeof hireMcpCatalog)[number]>(hireMcpCatalog.map((server) => [server.id, server]));

/** Parse only the bounded, user-visible proposal object. Agent prose is kept
 * in the conversation, but it never gets treated as a create instruction. */
export function parseHireProposal(text: string): HireProposal {
  const candidate = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return {};
  let raw: unknown;
  try { raw = JSON.parse(candidate); } catch { return {}; }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const proposal: HireProposal = {};
  if (typeof value.name === "string" && value.name.trim().length > 0) proposal.name = value.name.trim();
  if (typeof value.description === "string" && value.description.trim().length > 0) proposal.description = value.description.trim();
  if (value.mode === "read_only" || value.mode === "approval_required") proposal.mode = value.mode;
  if (Array.isArray(value.tools)) {
    const tools = value.tools.filter((tool): tool is string => typeof tool === "string" && PROPOSAL_TOOLS.has(tool));
    if (tools.length > 0) proposal.tools = [...new Set(tools)];
  }
  if (Array.isArray(value.memorySources)) {
    const memorySources = value.memorySources.filter((source): source is HireMemorySource["kind"] => typeof source === "string" && PROPOSAL_MEMORY.has(source as HireMemorySource["kind"]));
    if (memorySources.length > 0) proposal.memorySources = [...new Set(memorySources)];
  }
  if (Array.isArray(value.skills)) {
    const skills = value.skills.filter((skill): skill is string => typeof skill === "string" && PROPOSAL_SKILLS.has(skill));
    if (skills.length > 0) proposal.skills = [...new Set(skills)];
  }
  if (Array.isArray(value.mcpServers)) {
    const mcpServers: HireMcpGrant[] = [];
    for (const entry of value.mcpServers) {
      const id = typeof entry === "string" ? entry : typeof entry === "object" && entry !== null && !Array.isArray(entry) && typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id : null;
      const definition = id === null ? undefined : PROPOSAL_MCP.get(id);
      if (!definition || mcpServers.some((server) => server.id === definition.id)) continue;
      const requestedTools = typeof entry === "object" && entry !== null && !Array.isArray(entry) && Array.isArray((entry as { tools?: unknown }).tools)
        ? (entry as { tools: unknown[] }).tools.filter((tool): tool is string => typeof tool === "string" && (definition.tools as readonly string[]).includes(tool))
        : [...definition.tools];
      mcpServers.push({ id: definition.id, tools: [...new Set(requestedTools)] });
    }
    if (mcpServers.length > 0) proposal.mcpServers = mcpServers;
  }
  return proposal;
}

export interface HireDraft {
  id: string;
  name: string;
  description: string;
  reportTo: string | null;
  mode: "read_only" | "approval_required";
  budget: PositionBudget;
  permissions: HirePermissions;
  prompt: string;
  memorySources: HireMemorySource[];
}

export type HireFlowState =
  | { phase: "draft"; draft: HireDraft }
  | { phase: "submitting"; draft: HireDraft }
  | { phase: "approval"; draft: HireDraft; approvalRef: string | null }
  | { phase: "succeeded"; draft: HireDraft; positionId: string }
  | { phase: "failed"; draft: HireDraft; code: string; retryable: boolean };

export type HireFlowAction =
  | { type: "edit"; draft: HireDraft }
  | { type: "submit" }
  | { type: "approval_required"; approvalRef: string | null }
  | { type: "succeed"; positionId: string }
  | { type: "fail"; code: string; retryable: boolean }
  | { type: "retry" }
  | { type: "reset"; draft: HireDraft };

export function createHireDraft(presets?: Partial<HireDraft>): HireDraft {
  return {
    id: "",
    name: "",
    description: "",
    reportTo: null,
    mode: "approval_required",
    budget: {
      perTask: { tokens: 0 },
      perDay: { tokens: 0 },
    },
    permissions: { tools: ["Read", "Grep", "Glob"], rules: [], skills: [], mcpServers: [] },
    prompt: "",
    memorySources: [{ kind: "position_docs", locator: "./knowledge/**" }],
    ...presets,
  };
}

export function initialHireFlow(presets?: Partial<HireDraft>): HireFlowState {
  return { phase: "draft", draft: createHireDraft(presets) };
}

/** Draft → POST /hire body. The control plane still seals the upstream envelope. */
export function toHirePositionRequest(draft: HireDraft): HirePositionRequest {
  return {
    positionId: draft.id,
    name: draft.name,
    description: draft.description,
    reportTo: draft.reportTo,
    mode: draft.mode,
    budget: draft.budget,
    permissions: draft.permissions,
    prompt: draft.prompt,
    memorySources: draft.memorySources,
  };
}

export function reduceHireFlow(state: HireFlowState, action: HireFlowAction): HireFlowState {
  switch (action.type) {
    case "edit":
      return state.phase === "draft" ? { phase: "draft", draft: action.draft } : state;
    case "submit":
      return state.phase === "draft" ? { phase: "submitting", draft: state.draft } : state;
    case "approval_required":
      return state.phase === "submitting"
        ? { phase: "approval", draft: state.draft, approvalRef: action.approvalRef }
        : state;
    case "succeed":
      return state.phase === "submitting" || state.phase === "approval"
        ? { phase: "succeeded", draft: state.draft, positionId: action.positionId }
        : state;
    case "fail":
      return state.phase === "submitting" || state.phase === "approval"
        ? { phase: "failed", draft: state.draft, code: action.code, retryable: action.retryable }
        : state;
    case "retry":
      // 失败可恢复：保留表单草稿回到发起态，一键重试（AC-004 后半）。
      return state.phase === "failed" ? { phase: "draft", draft: state.draft } : state;
    case "reset":
      return { phase: "draft", draft: action.draft };
  }
}
