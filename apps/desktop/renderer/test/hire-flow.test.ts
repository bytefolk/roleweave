import { describe, expect, it } from "vitest";
import {
  createHireDraft,
  initialHireFlow,
  parseHireProposal,
  reduceHireFlow,
  type HireDraft,
  type HireFlowState,
} from "../src/org/hire-flow";

const draft = (overrides?: Partial<HireDraft>): HireDraft =>
  createHireDraft({
    id: "docs-writer",
    name: "文档负责人",
    description: "维护公开文档与发布说明",
    reportTo: "repo-owner",
    budget: {
      perTask: { tokens: 200_000 },
      perDay: { tokens: 800_000 },
    },
    ...overrides,
  });

describe("#33 hire 四态状态机（本地态骨架，不触契约）", () => {
  it("只接受 Agent 返回的有限结构化草案，不把自然语言当成创建指令", () => {
    expect(parseHireProposal("先分析一下，再给方案：没有 JSON")).toEqual({});
    expect(parseHireProposal('```json\n{"name":"文档助手","description":"维护文档","mode":"read_only","tools":["Read","Unknown"],"memorySources":["position_docs","bad"]}\n```')).toEqual({
      name: "文档助手",
      description: "维护文档",
      mode: "read_only",
      tools: ["Read"],
      memorySources: ["position_docs"],
    });
    expect(parseHireProposal('{"skills":["issue-research","unknown"],"mcpServers":[{"id":"workspace-drive","tools":["read","write"]},{"id":"repository","tools":["search"]}]}')).toEqual({
      skills: ["issue-research"],
      mcpServers: [
        { id: "workspace-drive", tools: ["read"] },
        { id: "repository", tools: ["search"] },
      ],
    });
  });

  it("draft → submitting → succeeded 直通终态", () => {
    let state: HireFlowState = initialHireFlow({ reportTo: "repo-owner" });
    state = reduceHireFlow(state, { type: "edit", draft: draft() });
    state = reduceHireFlow(state, { type: "submit" });
    expect(state.phase).toBe("submitting");
    state = reduceHireFlow(state, { type: "succeed", positionId: "docs-writer" });
    expect(state).toEqual({ phase: "succeeded", draft: draft(), positionId: "docs-writer" });
  });

  it("draft → submitting → approval → succeeded 覆盖可选审批态（只展示不回传）", () => {
    let state: HireFlowState = initialHireFlow();
    state = reduceHireFlow(state, { type: "edit", draft: draft() });
    state = reduceHireFlow(state, { type: "submit" });
    state = reduceHireFlow(state, { type: "approval_required", approvalRef: null });
    expect(state.phase).toBe("approval");
    state = reduceHireFlow(state, { type: "succeed", positionId: "docs-writer" });
    expect(state.phase).toBe("succeeded");
  });

  it("失败保留草稿，retry 一键回到发起态（AC-004 后半）", () => {
    let state: HireFlowState = initialHireFlow();
    state = reduceHireFlow(state, { type: "edit", draft: draft() });
    state = reduceHireFlow(state, { type: "submit" });
    state = reduceHireFlow(state, { type: "fail", code: "hire_surface_unavailable", retryable: true });
    expect(state).toEqual({
      phase: "failed",
      draft: draft(),
      code: "hire_surface_unavailable",
      retryable: true,
    });
    state = reduceHireFlow(state, { type: "retry" });
    expect(state).toEqual({ phase: "draft", draft: draft() });
  });

  it("审批拒绝是终态：retryable=false，重试需重新发起", () => {
    let state: HireFlowState = initialHireFlow();
    state = reduceHireFlow(state, { type: "edit", draft: draft() });
    state = reduceHireFlow(state, { type: "submit" });
    state = reduceHireFlow(state, { type: "approval_required", approvalRef: "approval-1" });
    state = reduceHireFlow(state, { type: "fail", code: "engine.approval_denied", retryable: false });
    expect(state.phase).toBe("failed");
    if (state.phase !== "failed") throw new Error("unreachable");
    expect(state.retryable).toBe(false);
  });

  it("非法转移一律忽略（fail-closed 本地态）", () => {
    const submitting: HireFlowState = { phase: "submitting", draft: draft() };
    expect(reduceHireFlow(submitting, { type: "edit", draft: draft({ name: "改" }) })).toBe(submitting);
    expect(reduceHireFlow(submitting, { type: "submit" })).toBe(submitting);
    expect(reduceHireFlow(submitting, { type: "retry" })).toBe(submitting);

    const draftState: HireFlowState = { phase: "draft", draft: draft() };
    expect(reduceHireFlow(draftState, { type: "succeed", positionId: "x" })).toBe(draftState);
    expect(reduceHireFlow(draftState, { type: "fail", code: "x", retryable: false })).toBe(draftState);
    expect(reduceHireFlow(draftState, { type: "approval_required", approvalRef: null })).toBe(draftState);

    const succeeded: HireFlowState = { phase: "succeeded", draft: draft(), positionId: "docs-writer" };
    expect(reduceHireFlow(succeeded, { type: "submit" })).toBe(succeeded);
    expect(reduceHireFlow(succeeded, { type: "retry" })).toBe(succeeded);
  });

  it("reset 从任意态回到新的 draft", () => {
    const failed: HireFlowState = { phase: "failed", draft: draft(), code: "x", retryable: false };
    const fresh = draft({ id: "community-operator" });
    expect(reduceHireFlow(failed, { type: "reset", draft: fresh })).toEqual({ phase: "draft", draft: fresh });
  });
});
