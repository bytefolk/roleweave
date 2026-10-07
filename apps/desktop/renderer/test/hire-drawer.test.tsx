import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HireDrawer } from "../src/org/HireDrawer";
import type { TurnEngine, TurnEngineAvailability } from "../turns/types";
import type { OwbBridge } from "../src/owb";

// #301: the create drawer's header close button looked actionable, but its
// handler was phase-gated, so in the in-flight phases it silently swallowed
// the click while the same pane showed a disabled 执行中不可取消 button. The
// control is removed outright (the issue's Option A); these tests pin the
// markup contract so a header × cannot quietly reappear on the create drawer.

const AVAILABILITY: Record<TurnEngine, TurnEngineAvailability> = {
  qoder: { configured: true, ready: true },
  "claude-code": { configured: true, ready: true },
  "claude-local": { configured: true, ready: true },
  codex: { configured: true, ready: true },
  "codex-local": { configured: true, ready: true },
  workbuddy: { configured: true, ready: true },
  gemini: { configured: false, ready: false },
  "openai-compatible": { configured: false, ready: false },
};

function renderCreateDrawer(overrides: Partial<ComponentProps<typeof HireDrawer>> = {}) {
  const onClose = vi.fn();
  const rendered = render(
    <HireDrawer
      open
      positions={[]}
      presetReportTo={null}
      engine="qoder"
      engineAvailability={AVAILABILITY}
      conversationHostId={null}
      onClose={onClose}
      onHired={vi.fn()}
      {...overrides}
    />,
  );
  return { onClose, ...rendered };
}

describe("HireDrawer header close control (#301)", () => {
  it("keeps the create form compact and visually separated from the drawer chrome", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/roleweave-components.css"), "utf8");
    expect(css).toMatch(/\.owb-hire-drawer-shell--create \.ant-drawer-header\s*\{[^}]*padding:\s*18px 24px/s);
    expect(css).toMatch(/\.owb-hire-drawer-shell--create \.owb-hire-shell__scroll\s*\{[^}]*padding:\s*20px 24px 28px/s);
    expect(css).toMatch(/\.owb-hire-drawer-shell--create \.owb-hire-drawer--conversation\s*\{[^}]*max-width:\s*680px[^}]*margin:\s*0 auto/s);
    expect(css).toMatch(/\.owb-hire-drawer-shell--create \.owb-hire-footer\s*\{[^}]*gap:\s*10px[^}]*padding:\s*14px 24px/s);
  });
  it("renders the create drawer without a header close button", () => {
    renderCreateDrawer();
    // The drawer must actually be on screen for the absence to mean anything.
    expect(screen.getByText("创建数字员工")).toBeInTheDocument();
    // Markup-level contract (issue AC-001): nothing matching the drawer-shell
    // close selector may exist. closable={false} is static, so the button is
    // absent in every phase, not just the editable pane mounted here.
    expect(document.querySelector(".owb-hire-drawer-shell .ant-drawer-close")).toBeNull();
  });

  it("the editable pane still closes through the footer 取消", () => {
    const { onClose } = renderCreateDrawer();
    // Issue AC-002: with the header × gone, the explicit footer 取消 remains
    // the pane's visible close affordance and must still reach onClose.
    // antd inserts a space between two-CJK-character button labels (取 消),
    // so the name is matched with a whitespace-tolerant regex.
    fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("allows choosing the employee Agent in the create drawer", () => {
    renderCreateDrawer();

    fireEvent.click(screen.getByRole("button", { name: /员工 Agent/ }));
    fireEvent.click(screen.getByRole("option", { name: "WorkBuddy" }));

    expect(screen.getByRole("button", { name: /员工 Agent/ })).toHaveTextContent("WorkBuddy");
  });

  it("keeps optional drafting and advanced configuration collapsed by default", () => {
    renderCreateDrawer();

    const assist = screen.getByText("让 Agent 帮我生成草案").closest("details");
    const advanced = screen.getByText("高级配置").closest("details");
    expect(assist).not.toBeNull();
    expect(advanced).not.toBeNull();
    expect(assist).not.toHaveAttribute("open");
    expect(advanced).not.toHaveAttribute("open");
  });

  it("reveals the optional drafting and advanced configuration on demand", () => {
    renderCreateDrawer();

    fireEvent.click(screen.getByText("让 Agent 帮我生成草案"));
    fireEvent.click(screen.getByText("高级配置"));

    expect(screen.getByLabelText("岗位创建对话").closest("details")).toHaveAttribute("open");
    expect(screen.getByLabelText("附加能力与授权").closest("details")).toHaveAttribute("open");
    expect(screen.getByLabelText("员工头像").closest("details")).toHaveAttribute("open");
  });
});

function fixtureBridge(overrides: Partial<OwbBridge> = {}) {
  const hire = vi.fn().mockResolvedValue({ status: 200, body: { status: "hired" } });
  const createTurn = vi.fn().mockResolvedValue({ status: 200, body: { output: '{"name":"Agent candidate","description":"A clear proposed responsibility"}' } });
  const bridge = { hire, createTurn, cancelTurn: vi.fn().mockResolvedValue({ status: 200, body: {} }), onEvent: vi.fn().mockReturnValue(() => {}), ...overrides };
  window.owb = bridge as unknown as OwbBridge;
  return bridge;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function generationProps(): Partial<ComponentProps<typeof HireDrawer>> {
  return {
    workspacePath: "/workspace-a", positions: [{ id: "manager", name: "Manager" }], presetReportTo: "manager",
    conversationHostId: "manager", conversationHostName: "Manager", conversationEngine: "codex-local",
  };
}

async function configureReviewedCapabilities() {
  const advanced = screen.getByText("高级配置").closest("details")!;
  fireEvent.click(advanced.querySelector("summary")!);
  await waitFor(() => expect(advanced).toHaveAttribute("open"));
  fireEvent.click(screen.getByRole("button", { name: "文档审校" }));
  fireEvent.click(screen.getByRole("button", { name: /代码仓库/ }));
  fireEvent.change(screen.getByDisplayValue("skill://docs-review"), { target: { value: "skill://docs-review/approved-only" } });
  fireEvent.change(screen.getByDisplayValue("mcp://repository"), { target: { value: "mcp://repository/approved-only" } });
  fireEvent.click(advanced.querySelector("summary")!);
  await waitFor(() => expect(advanced).not.toHaveAttribute("open"));
  return advanced;
}

const reviewedSkillRule = { scope: "position", resource: "skill://docs-review/approved-only", actions: ["execute"] };
const reviewedMcpRule = { scope: "workspace", resource: "mcp://repository/approved-only", actions: ["execute"], approval: true };
const baseKnowledgeRule = { scope: "position", resource: "./knowledge/**", actions: ["read"] };
const reviewedMcpGrant = { id: "repository", tools: ["search", "read"] };

describe("selection-first employee creation", () => {
  afterEach(() => vi.useRealTimers());
  it("fills a useful template in one click and creates without manual input or broader defaults", async () => {
    const bridge = fixtureBridge();
    const onHired = vi.fn();
    renderCreateDrawer({ ...generationProps(), onHired });
    expect(screen.getByRole("button", { name: /员工 Agent/ })).toHaveTextContent("Codex");
    expect(screen.getByRole("button", { name: /上级，当前/ })).toHaveTextContent("Manager");
    fireEvent.click(screen.getByRole("button", { name: "研发工程师 · 模板" }));
    expect(screen.getByLabelText("姓名*")).toHaveValue("研发工程师");
    expect((screen.getByLabelText("职责描述*") as HTMLTextAreaElement).value).toContain("阅读代码与需求");
    expect(screen.getByText("高级配置").closest("details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "开始创建" }));
    await waitFor(() => expect(onHired).toHaveBeenCalledOnce());
    expect(bridge.hire).toHaveBeenCalledWith(expect.objectContaining({
      name: "研发工程师", reportTo: "manager", agentEngine: "codex-local", mode: "approval_required",
      budget: { perTask: { tokens: 20_000, iterations: 8 }, perDay: { tokens: 200_000, iterations: 64 } },
      permissions: { tools: ["Read", "Grep", "Glob"], rules: [{ scope: "position", resource: "./knowledge/**", actions: ["read"] }], skills: [], mcpServers: [] },
      memorySources: [{ kind: "position_docs", locator: "./knowledge/**" }],
    }));
    expect(bridge.createTurn).not.toHaveBeenCalled();
  });

  it("switches pristine templates directly but requires explicit application after user edits", () => {
    renderCreateDrawer();
    fireEvent.click(screen.getByRole("button", { name: "研发工程师 · 模板" }));
    fireEvent.click(screen.getByRole("button", { name: "产品设计师 · 模板" }));
    expect(screen.getByLabelText("姓名*")).toHaveValue("产品设计师");
    fireEvent.change(screen.getByLabelText("姓名*"), { target: { value: "My edited designer" } });
    fireEvent.change(screen.getByLabelText("职责描述*"), { target: { value: "Keep my responsibilities" } });
    fireEvent.click(screen.getByRole("button", { name: "测试工程师 · 模板" }));
    expect(screen.getByLabelText("姓名*")).toHaveValue("My edited designer");
    expect(screen.getByLabelText("职责描述*")).toHaveValue("Keep my responsibilities");
    expect(screen.getByRole("region", { name: "角色模板" })).toHaveTextContent("你已修改草稿");
    fireEvent.click(screen.getByRole("button", { name: "应用模板" }));
    expect(screen.getByLabelText("姓名*")).toHaveValue("测试工程师");
  });

  it("uses the real Agent request and presents its parsed proposal without overwriting edits made while waiting", async () => {
    const pending = deferred<{ status: number; body: { output: string } }>();
    const bridge = fixtureBridge({ createTurn: vi.fn().mockReturnValue(pending.promise) });
    renderCreateDrawer(generationProps());
    fireEvent.click(screen.getByRole("button", { name: "研发工程师 · 模板" }));
    fireEvent.click(screen.getByRole("button", { name: "描述需求" }));
    const brief = screen.getByLabelText("需要怎样的员工");
    expect((brief as HTMLTextAreaElement).value).not.toContain("JSON");
    fireEvent.change(brief, { target: { value: "Draft a release reviewer" } });
    const ask = screen.getByRole("button", { name: "让 Agent 生成草案" });
    fireEvent.click(ask);
    fireEvent.click(ask);
    expect(bridge.createTurn).toHaveBeenCalledExactlyOnceWith({ positionId: "manager", engine: "codex-local", input: expect.stringContaining("Draft a release reviewer") });
    expect(vi.mocked(bridge.createTurn).mock.calls[0]![0].input).toContain("只输出一个 JSON");
    expect(screen.getByRole("region", { name: "岗位创建对话" })).not.toHaveTextContent("只输出一个 JSON");
    fireEvent.change(screen.getByLabelText("姓名*"), { target: { value: "My name during generation" } });
    fireEvent.change(screen.getByLabelText("职责描述*"), { target: { value: "My edited responsibilities" } });
    await act(async () => { pending.resolve({ status: 200, body: { output: '{"name":"Release reviewer","description":"Review release evidence","mode":"approval_required","tools":["Read","Grep","Glob"],"skills":[],"mcpServers":[],"memorySources":["position_docs"]}' } }); });
    expect(screen.getByLabelText("姓名*")).toHaveValue("My name during generation");
    expect(screen.getByLabelText("职责描述*")).toHaveValue("My edited responsibilities");
    expect(screen.getByRole("region", { name: "Agent 生成的候选草稿" })).toHaveTextContent("Release reviewer");
    expect(bridge.hire).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "应用候选草稿" }));
    expect(screen.getByLabelText("姓名*")).toHaveValue("Release reviewer");
    expect(screen.getByLabelText("职责描述*")).toHaveValue("Review release evidence");
    expect(screen.getByText("高级配置").closest("details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "开始创建" }));
    await waitFor(() => expect(bridge.hire).toHaveBeenCalledWith(expect.objectContaining({ name: "Release reviewer", description: "Review release evidence" })));
  });

  it("reveals advanced review when an applied candidate changes the role policy", async () => {
    const bridge = fixtureBridge({ createTurn: vi.fn().mockResolvedValue({ status: 200, body: { output: '{"name":"Read-only reviewer","description":"Review approved evidence","mode":"read_only","tools":["Read"]}' } }) });
    renderCreateDrawer(generationProps());
    fireEvent.click(screen.getByRole("button", { name: "研发工程师 · 模板" }));
    fireEvent.click(screen.getByRole("button", { name: "描述需求" }));
    fireEvent.click(screen.getByRole("button", { name: "让 Agent 生成草案" }));
    fireEvent.click(await screen.findByRole("button", { name: "应用候选草稿" }));
    expect(screen.getByText("高级配置").closest("details")).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "开始创建" }));
    await waitFor(() => expect(bridge.hire).toHaveBeenCalledWith(expect.objectContaining({ mode: "read_only", permissions: expect.objectContaining({ tools: ["Read"] }) })));
  });

  it.each([
    { label: "the same skills and omitted MCP", proposal: { skills: ["docs-review"] } },
    { label: "the same MCP and omitted skills", proposal: { mcpServers: [{ id: "repository", tools: ["read", "search"] }] } },
  ])("preserves both reviewed capability groups and their custom rules for $label", async ({ proposal }) => {
    const bridge = fixtureBridge({ createTurn: vi.fn().mockResolvedValue({ status: 200, body: { output: JSON.stringify({ name: "Reviewed candidate", description: "Keep the approved capabilities", ...proposal }) } }) });
    renderCreateDrawer(generationProps());
    fireEvent.click(screen.getByRole("button", { name: "研发工程师 · 模板" }));
    const advanced = await configureReviewedCapabilities();
    fireEvent.click(screen.getByRole("button", { name: "描述需求" }));
    fireEvent.click(screen.getByRole("button", { name: "让 Agent 生成草案" }));
    fireEvent.click(await screen.findByRole("button", { name: "应用候选草稿" }));
    expect(advanced).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "开始创建" }));
    await waitFor(() => expect(bridge.hire).toHaveBeenCalledWith(expect.objectContaining({
      name: "Reviewed candidate",
      permissions: {
        tools: ["Read", "Grep", "Glob"], skills: [{ id: "docs-review" }], mcpServers: [reviewedMcpGrant],
        rules: [baseKnowledgeRule, reviewedSkillRule, reviewedMcpRule],
      },
    })));
  });

  it.each([
    { label: "skills", proposal: { skills: [] }, skills: [], mcpServers: [reviewedMcpGrant], rules: [baseKnowledgeRule, reviewedMcpRule] },
    { label: "MCP", proposal: { mcpServers: [] }, skills: [{ id: "docs-review" }], mcpServers: [], rules: [baseKnowledgeRule, reviewedSkillRule] },
  ])("clears an explicitly empty $label group while retaining the unmentioned group's custom rule", async ({ proposal, skills, mcpServers, rules }) => {
    const bridge = fixtureBridge({ createTurn: vi.fn().mockResolvedValue({ status: 200, body: { output: JSON.stringify({ name: "Scoped candidate", description: "Clear only the requested capability group", ...proposal }) } }) });
    renderCreateDrawer(generationProps());
    fireEvent.click(screen.getByRole("button", { name: "研发工程师 · 模板" }));
    const advanced = await configureReviewedCapabilities();
    fireEvent.click(screen.getByRole("button", { name: "描述需求" }));
    fireEvent.click(screen.getByRole("button", { name: "让 Agent 生成草案" }));
    fireEvent.click(await screen.findByRole("button", { name: "应用候选草稿" }));
    expect(advanced).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "开始创建" }));
    await waitFor(() => expect(bridge.hire).toHaveBeenCalledWith(expect.objectContaining({
      name: "Scoped candidate", permissions: { tools: ["Read", "Grep", "Glob"], skills, mcpServers, rules },
    })));
  });

  it("keeps real generation errors retryable without discarding the current template draft", async () => {
    const bridge = fixtureBridge({ createTurn: vi.fn().mockResolvedValueOnce({ status: 500, body: {} }).mockResolvedValue({ status: 200, body: { output: '{"name":"Retry proposal","description":"Valid retry description"}' } }) });
    renderCreateDrawer(generationProps());
    fireEvent.click(screen.getByRole("button", { name: "研究分析师 · 模板" }));
    fireEvent.click(screen.getByRole("button", { name: "描述需求" }));
    fireEvent.click(screen.getByRole("button", { name: "让 Agent 生成草案" }));
    await screen.findByText("Agent 对话未完成，请检查返回结果后重试。");
    expect(screen.getByLabelText("姓名*")).toHaveValue("研究分析师");
    fireEvent.click(screen.getByRole("button", { name: "让 Agent 生成草案" }));
    await screen.findByRole("button", { name: "应用候选草稿" });
    expect(bridge.createTurn).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("姓名*")).toHaveValue("研究分析师");
  });

  it("resets the selection and ignores an old Agent proposal when the workspace changes", async () => {
    const pending = deferred<{ status: number; body: { output: string } }>();
    fixtureBridge({ createTurn: vi.fn().mockReturnValue(pending.promise) });
    const context = renderCreateDrawer(generationProps());
    fireEvent.click(screen.getByRole("button", { name: "研发工程师 · 模板" }));
    fireEvent.click(screen.getByRole("button", { name: "描述需求" }));
    fireEvent.click(screen.getByRole("button", { name: "让 Agent 生成草案" }));
    context.rerender(<HireDrawer open {...generationProps()} workspacePath="/workspace-b" positions={[{ id: "other-manager", name: "Other manager" }]} presetReportTo="other-manager" conversationHostId="other-manager" conversationEngine="workbuddy" engine="qoder" engineAvailability={AVAILABILITY} onClose={vi.fn()} onHired={vi.fn()} />);
    expect(screen.getByLabelText("姓名*")).toHaveValue("");
    expect(screen.getByRole("button", { name: /员工 Agent/ })).toHaveTextContent("WorkBuddy");
    expect(screen.getByRole("button", { name: /上级，当前/ })).toHaveTextContent("Other manager");
    await act(async () => { pending.resolve({ status: 200, body: { output: '{"name":"Old workspace proposal","description":"Must not cross workspaces"}' } }); });
    expect(screen.queryByRole("button", { name: "应用候选草稿" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("姓名*")).toHaveValue("");
  });

  it("ignores a late hire result after switching workspaces", async () => {
    const pending = deferred<{ status: number; body: { status: string } }>();
    fixtureBridge({ hire: vi.fn().mockReturnValue(pending.promise) });
    const onHired = vi.fn();
    const context = renderCreateDrawer({ ...generationProps(), onHired });
    fireEvent.click(screen.getByRole("button", { name: "研发工程师 · 模板" }));
    fireEvent.click(screen.getByRole("button", { name: "开始创建" }));
    context.rerender(<HireDrawer open {...generationProps()} workspacePath="/workspace-b" engine="qoder" engineAvailability={AVAILABILITY} onClose={vi.fn()} onHired={onHired} />);
    await act(async () => { pending.resolve({ status: 200, body: { status: "hired" } }); });
    expect(onHired).not.toHaveBeenCalled();
    expect(screen.getByLabelText("姓名*")).toHaveValue("");
  });

  it("keeps an issued Agent turn's timeout attached to its original workspace after navigation", async () => {
    vi.useFakeTimers();
    const bridge = fixtureBridge({ createTurn: vi.fn().mockReturnValue(new Promise(() => {})) });
    const context = renderCreateDrawer(generationProps());
    fireEvent.click(screen.getByRole("button", { name: "描述需求" }));
    fireEvent.click(screen.getByRole("button", { name: "让 Agent 生成草案" }));
    context.rerender(<HireDrawer open {...generationProps()} workspacePath="/workspace-b" engine="qoder" engineAvailability={AVAILABILITY} onClose={vi.fn()} onHired={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(75_001); });
    expect(bridge.cancelTurn).toHaveBeenCalledExactlyOnceWith({ positionId: "manager", workspacePath: "/workspace-a" });
    expect(screen.queryByRole("button", { name: "应用候选草稿" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("姓名*")).toHaveValue("");
  });

  it("does not let a previous hire response clear the new workspace's in-flight timeout", async () => {
    vi.useFakeTimers();
    const first = deferred<{ status: number; body: { status: string } }>();
    const second = deferred<{ status: number; body: { status: string } }>();
    fixtureBridge({ hire: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) });
    const onHired = vi.fn();
    const context = renderCreateDrawer({ ...generationProps(), onHired });
    fireEvent.click(screen.getByRole("button", { name: "研发工程师 · 模板" }));
    fireEvent.click(screen.getByRole("button", { name: "开始创建" }));
    context.rerender(<HireDrawer open {...generationProps()} workspacePath="/workspace-b" engine="qoder" engineAvailability={AVAILABILITY} onClose={vi.fn()} onHired={onHired} />);
    fireEvent.click(screen.getByRole("button", { name: "测试工程师 · 模板" }));
    fireEvent.click(screen.getByRole("button", { name: "开始创建" }));
    await act(async () => { first.resolve({ status: 200, body: { status: "hired" } }); });
    expect(onHired).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
    expect(screen.getByRole("button", { name: /^重\s*试$/ })).toBeEnabled();
    expect(onHired).not.toHaveBeenCalled();
  });

  it("retries a stalled hire using the same draft and ignores the superseded response", async () => {
    vi.useFakeTimers();
    const first = deferred<{ status: number; body: { status: string } }>();
    const second = deferred<{ status: number; body: { status: string } }>();
    const hire = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    fixtureBridge({ hire });
    const onHired = vi.fn();
    renderCreateDrawer({ ...generationProps(), onHired });
    fireEvent.click(screen.getByRole("button", { name: "研发工程师 · 模板" }));
    fireEvent.click(screen.getByRole("button", { name: "开始创建" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
    fireEvent.click(screen.getByRole("button", { name: /^重\s*试$/ }));
    expect(hire).toHaveBeenCalledTimes(2);
    expect(hire.mock.calls[1]?.[0]).toEqual(hire.mock.calls[0]?.[0]);
    expect(screen.queryByRole("button", { name: /^重\s*试$/ })).not.toBeInTheDocument();
    await act(async () => { first.resolve({ status: 200, body: { status: "hired" } }); });
    expect(onHired).not.toHaveBeenCalled();
    await act(async () => { second.resolve({ status: 200, body: { status: "hired" } }); });
    expect(onHired).toHaveBeenCalledOnce();
  });

  it("ignores a previous workspace's avatar response when a new employee is created", async () => {
    const pending = deferred<{ status: number; body: { imageDataUrl: string } }>();
    const bridge = fixtureBridge({ generateAvatar: vi.fn().mockReturnValue(pending.promise) });
    const onHired = vi.fn();
    const context = renderCreateDrawer({ ...generationProps(), onHired });
    fireEvent.click(screen.getByRole("button", { name: "研发工程师 · 模板" }));
    fireEvent.click(screen.getByText("高级配置"));
    fireEvent.click(screen.getByRole("button", { name: "用 AI 生成透明头像" }));
    expect(bridge.generateAvatar).toHaveBeenCalledOnce();
    context.rerender(<HireDrawer open {...generationProps()} workspacePath="/workspace-b" engine="qoder" engineAvailability={AVAILABILITY} onClose={vi.fn()} onHired={onHired} />);
    await act(async () => { pending.resolve({ status: 200, body: { imageDataUrl: "data:image/png;base64,old-workspace-avatar" } }); });
    fireEvent.click(screen.getByRole("button", { name: "测试工程师 · 模板" }));
    fireEvent.click(screen.getByRole("button", { name: "开始创建" }));
    await waitFor(() => expect(onHired).toHaveBeenCalledWith(expect.any(String), "测试工程师", undefined));
  });
});
