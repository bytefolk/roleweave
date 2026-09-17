import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ConversationOptions } from "../src/turns/ConversationOptions";
import { adaptTurnRecord } from "../src/turns/adapter";
import type { EmployeeModelConfig, TurnRecord as ApiTurnRecord, WorkbenchSession } from "@roleweave/shared";
import { pickSelectOption } from "./select-helper";

it("sums separately reported input/output usage and does not turn missing usage into zero", () => {
  const record = { turnId: "t", positionId: "p", engine: "codex-local", input: "question", status: "completed", createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:01Z", model: "account-model", events: [{ type: "usage", inputTokens: 120, outputTokens: 30 }] } as ApiTurnRecord;
  expect(adaptTurnRecord(record, "Employee")).toMatchObject({ totalTokens: 150, model: "account-model" });
  expect(adaptTurnRecord({ ...record, events: [] }, "Employee").totalTokens).toBeUndefined();
});

it("switches the employee model from the composer and exposes context and honest usage details", async () => {
  const change = vi.fn();
  render(<ConversationOptions saving={false} disabled={false} session={null} turns={[]} onModel={change}
    config={{ selected: "efficient", recommended: "efficient", editable: true, source: "provider-tiers", options: [
      { id: "efficient", name: "Efficient", tier: "economy" }, { id: "performance", name: "Performance", tier: "balanced" },
    ] }} />);
  pickSelectOption("员工模型", "Performance");
  expect(change).toHaveBeenCalledExactlyOnceWith("performance");
  expect(screen.getByText("用量待回报")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "上下文详情" }));
  expect(await screen.findByText(/最多 12 轮、64 KB/)).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "携带会话历史" })).toBeDisabled();
});

it("keeps the current model selected when opening and dismissing the menu, then selects with the keyboard", async () => {
  const change = vi.fn();
  render(<ConversationOptions saving={false} disabled={false} session={null} turns={[]} onModel={change}
    config={{ selected: "efficient", recommended: "performance", editable: true, source: "provider-tiers", options: [
      { id: "efficient", name: "Efficient", tier: "economy" }, { id: "performance", name: "Performance", tier: "balanced" },
    ] }} />);
  const select = screen.getByRole("combobox", { name: "员工模型" });
  fireEvent.mouseDown(select);
  expect(select).toHaveAttribute("aria-expanded", "true");
  expect(await screen.findByRole("option", { name: "Efficient", selected: true })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Performance", selected: false })).toBeInTheDocument();
  expect(change).not.toHaveBeenCalled();

  fireEvent.keyDown(select, { key: "Escape", code: "Escape", keyCode: 27 });
  await waitFor(() => expect(select).toHaveAttribute("aria-expanded", "false"));
  expect(change).not.toHaveBeenCalled();

  fireEvent.mouseDown(select);
  fireEvent.keyDown(select, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
  expect(change).not.toHaveBeenCalled();
  fireEvent.keyDown(select, { key: "Enter", code: "Enter", keyCode: 13 });
  expect(change).toHaveBeenCalledExactlyOnceWith("performance");
  await waitFor(() => expect(select).toHaveAttribute("aria-expanded", "false"));
});

it("does not reuse an older context receipt when the newest turn has none", async () => {
  const receipt = {
    schemaVersion: "thread-context.v1" as const,
    enabled: true,
    sourceTurnCount: 1,
    omittedTurnCount: 0,
    contextBytes: 128,
    contextDigest: "sha256:old",
    summary: "older context",
    redacted: false,
    truncated: false,
  };
  const turn = (id: string, createdAt: string, threadContext?: typeof receipt) => ({
    id,
    positionId: "repo-owner",
    positionName: "Owner",
    engine: "qoder" as const,
    input: id,
    status: "completed" as const,
    createdAt,
    threadContext,
  });
  render(<ConversationOptions saving={false} disabled={false} session={null} turns={[
    turn("older", "2026-09-13T00:00:00.000Z", receipt),
    turn("newest", "2026-09-13T00:01:00.000Z"),
  ]} />);
  fireEvent.click(screen.getByRole("button", { name: "上下文详情" }));
  expect(await screen.findByText("尚无上下文注入记录。")).toBeInTheDocument();
  expect(screen.queryByText(/128 字节/)).not.toBeInTheDocument();
});

it("shows the inherited connection, billing, and concrete model without assigning a gateway a price tier", async () => {
  const config: EmployeeModelConfig = {
    selected: "provider-default",
    recommended: "custom-claude",
    editable: true,
    source: "local-config",
    connection: {
      source: "local-config",
      kind: "gateway",
      endpointHost: "gateway.example.test",
      billing: "provider",
      status: "configured",
    },
    options: [
      { id: "provider-default", name: "Agent default", tier: "default" },
      { id: "custom-claude", name: "Claude", tier: "economy", resolvedModel: "team/claude-custom", billing: "provider", connectionLabel: "团队网关" },
    ],
  };
  render(<ConversationOptions config={config} saving={false} disabled={false} session={null} turns={[]} onModel={vi.fn()} />);

  expect(screen.getByText("跟随本地配置")).toBeInTheDocument();
  // Connection and billing are readable on demand without filling the footer.
  const details = screen.getByRole("button", { name: "模型连接详情" });
  expect(details.textContent).toBe("");
  expect(screen.queryByText("供应商计费")).not.toBeInTheDocument();
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "员工模型" }));
  expect(await screen.findByText(/配置映射: team\/claude-custom/)).toBeInTheDocument();
  expect(screen.getByText(/团队网关/)).toBeInTheDocument();
  expect(screen.queryByText("经济型 · 适合问答、整理和简单修改")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "模型连接详情" }));
  expect(await screen.findByText("gateway.example.test")).toBeInTheDocument();
  expect(screen.getByText("网关 / 自定义服务")).toBeInTheDocument();
  expect(screen.getAllByText("供应商计费").length).toBeGreaterThan(0);
});

it("groups real catalog models separately from routing tiers and configured models without fabricating prices", async () => {
  const change = vi.fn();
  render(<ConversationOptions saving={false} disabled={false} session={null} turns={[]} onModel={change}
    config={{ selected: "provider-default", recommended: "auto", editable: true, source: "provider-catalog", catalogStatus: "ready",
      connection: { source: "official", kind: "unknown", billing: "unknown", status: "configured" }, options: [
      { id: "provider-default", name: "Default", tier: "default" },
      { id: "auto", name: "Auto", tier: "auto", group: "tiers" },
      { id: "Qwen Fixture", name: "Qwen Fixture", tier: "default", group: "models", billing: "unknown" },
      { id: "local-fixture", name: "Local Fixture", tier: "default", group: "custom" },
    ] }} />);
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "员工模型" }));
  expect(await screen.findByText("Qoder 档位")).toBeInTheDocument();
  expect(screen.getByText("具体模型")).toBeInTheDocument();
  expect(screen.getByText("已配置模型")).toBeInTheDocument();
  expect(screen.queryByText(/倍率|\d+(\.\d+)?\s*[×x]/)).not.toBeInTheDocument();
  expect(screen.getByText("Qwen Fixture").closest(".owb-model-choice")?.querySelector("p")).toBeNull();
  expect(screen.getByText("Auto", { selector: ".owb-model-choice > span" }).closest(".owb-model-choice")?.querySelector("p")).toBeNull();
  expect(screen.getAllByText(/计费方式未确认/)).toHaveLength(1);
  fireEvent.click(screen.getByText("Qwen Fixture"));
  expect(change).toHaveBeenCalledExactlyOnceWith("Qwen Fixture");
});

it.each(["custom", "models"] as const)("preserves unknown billing for a %s override instead of implying that Qoder pays for it", async (group) => {
  render(<ConversationOptions saving={false} disabled={false} session={null} turns={[]} onModel={vi.fn()}
    config={{ selected: "provider-default", recommended: "provider-default", editable: true, source: "provider-catalog",
      connection: { source: "official", kind: "official", billing: "qoder", status: "configured" }, options: [
        { id: "provider-default", name: "Default", tier: "default" },
        { id: "Included", name: "Included", tier: "default", group, billing: "qoder" },
        { id: "team-model", name: "Team Model", tier: "default", group, billing: "unknown" },
      ] }} />);
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "员工模型" }));
  expect((await screen.findByText("Team Model")).closest(".owb-model-choice")).toHaveTextContent("计费方式未确认");
  expect(screen.getByText("Included").closest(".owb-model-choice")).not.toHaveTextContent("计费方式未确认");
});

it("states uniform catalog billing once in the group while keeping concrete model rows compact", async () => {
  render(<ConversationOptions saving={false} disabled={false} session={null} turns={[]} onModel={vi.fn()}
    config={{ selected: "provider-default", recommended: "provider-default", editable: true, source: "provider-catalog",
      connection: { source: "official", kind: "unknown", billing: "unknown", status: "configured" }, options: [
        { id: "provider-default", name: "Default", tier: "default" },
        { id: "Model A", name: "Model A", tier: "default", group: "models", billing: "qoder" },
        { id: "Model B", name: "Model B", tier: "default", group: "models", billing: "qoder" },
      ] }} />);
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "员工模型" }));
  expect(await screen.findByText("具体模型 · Qoder 额度")).toBeInTheDocument();
  expect(screen.getAllByText(/Qoder 额度/)).toHaveLength(1);
  for (const name of ["Model A", "Model B"]) expect(screen.getByText(name).closest(".owb-model-choice")?.querySelector("p")).toBeNull();
});

it.each(["stale", "unavailable"] as const)("keeps fallback model selection available with %s catalog status and offers refresh", async (catalogStatus) => {
  const reload = vi.fn();
  const config: EmployeeModelConfig = { selected: "auto", recommended: "auto", editable: true, source: "provider-tiers", catalogStatus,
    options: [{ id: "auto", name: "Auto", tier: "auto", group: "tiers" }] };
  const base = { config, saving: false, disabled: false, session: null, turns: [], onModel: vi.fn(), onReload: reload };
  const { rerender } = render(<ConversationOptions {...base} />);
  const select = screen.getByRole("combobox", { name: "员工模型" });
  expect(select).toBeEnabled();
  fireEvent.mouseDown(select);
  expect(await screen.findByRole("status")).toHaveTextContent(catalogStatus === "stale" ? "显示上次的模型列表" : "暂未取得 Qoder 模型列表");
  fireEvent.click(screen.getByRole("button", { name: "刷新模型列表" }));
  expect(reload).toHaveBeenCalledTimes(1);
  rerender(<ConversationOptions {...base} loading />);
  expect(select).toBeDisabled();
  expect(screen.getAllByText("正在加载模型…").length).toBeGreaterThan(0);
});

it("uses the Agent default outside local configuration and leaves session context alone when switching", async () => {
  const change = vi.fn();
  const setContext = vi.fn();
  const session: WorkbenchSession = {
    schemaVersion: "workbench-session.v1",
    sessionId: "11111111-1111-4111-8111-111111111111",
    workspaceInstanceId: "workspace-1",
    positionId: "repo-owner",
    principal: "position.repo-owner",
    status: "active",
    rotatedFrom: null,
    rotatedTo: null,
    createdAt: "2026-09-13T00:00:00Z",
    rotatedAt: null,
    threadContextEnabled: true,
  };
  render(<ConversationOptions saving={false} disabled={false} session={session} turns={[]} onModel={change} onContext={setContext}
    config={{ selected: "haiku", recommended: "haiku", editable: true, source: "provider-tiers", connection: {
      source: "official", kind: "official", billing: "subscription", status: "configured",
    }, options: [
      { id: "haiku", name: "Haiku", tier: "economy", resolvedModel: "claude-haiku" },
      { id: "provider-default", name: "Agent default", tier: "default" },
    ] }} />);

  pickSelectOption("员工模型", "跟随 Agent 默认");
  expect(change).toHaveBeenCalledWith("provider-default");
  expect(setContext).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "上下文详情" }));
  expect((await screen.findByRole("switch", { name: "携带会话历史" })).getAttribute("aria-checked")).toBe("true");
  expect(setContext).not.toHaveBeenCalled();
});

it("shows a localized invalid connection summary and prevents model changes", async () => {
  const change = vi.fn();
  render(<ConversationOptions saving={false} disabled={false} session={null} turns={[]} onModel={change}
    config={{ selected: "provider-default", recommended: "provider-default", editable: true, source: "local-config", connection: {
      source: "environment", kind: "gateway", billing: "provider", status: "invalid", message: "本地网关配置缺少模型地址",
    }, options: [{ id: "provider-default", name: "Agent default", tier: "default" }] }} />);

  expect(screen.getByRole("combobox", { name: "员工模型" })).toBeDisabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "模型连接详情" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("模型连接配置无效，暂时不能切换模型。");
  expect(document.body.innerHTML).not.toContain("本地网关配置缺少模型地址");
  expect(change).not.toHaveBeenCalled();
});

it("submits only a valid Qoder custom model identifier and never asks for a key", async () => {
  const change = vi.fn();
  render(<ConversationOptions saving={false} disabled={false} session={null} turns={[]} onModel={change}
    config={{ selected: "auto", recommended: "auto", editable: true, allowCustomModel: true, source: "local-config", connection: {
      source: "official", kind: "unknown", billing: "unknown", status: "configured",
    }, options: [{ id: "auto", name: "Auto · Qoder", tier: "auto" }] }} />);

  fireEvent.mouseDown(screen.getByRole("combobox", { name: "员工模型" }));
  expect((await screen.findAllByText(/Qoder 已配置模型/)).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/计费方式未确认/).length).toBeGreaterThan(0);
  expect(screen.queryByText("官方连接")).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "使用已配置模型…" }));
  const input = await screen.findByLabelText("模型标识");
  expect(screen.getByText("填写 Qoder 中已配置的模型标识，不是 API Key。")).toBeInTheDocument();
  // The entry lives in a Select popup. Its trigger keeps that popup open, but
  // must not prevent the portal-hosted input from receiving a real pointer
  // interaction (which would otherwise make it impossible to edit).
  const pointerDown = createEvent.mouseDown(input);
  fireEvent(input, pointerDown);
  expect(pointerDown.defaultPrevented).toBe(false);
  fireEvent.click(input);
  fireEvent.change(input, { target: { value: "-not-a-model" } });
  fireEvent.click(screen.getByRole("button", { name: "使用此模型" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("请输入有效的模型标识。");
  expect(change).not.toHaveBeenCalled();

  fireEvent.change(input, { target: { value: "custom/研发 小模型 (BYOK)" } });
  fireEvent.click(screen.getByRole("button", { name: "使用此模型" }));
  expect(change).toHaveBeenCalledWith("custom/研发 小模型 (BYOK)");
});

it.each(["saving", "running", "read-only", "loading", "error"])("closes an already open custom model editor and rejects submission after %s", async state => {
  const change = vi.fn();
  const config: EmployeeModelConfig = {
    selected: "auto", recommended: "auto", editable: true, allowCustomModel: true, source: "local-config",
    options: [{ id: "auto", name: "Auto · Qoder", tier: "auto" }],
  };
  const base = { config, saving: false, disabled: false, session: null, turns: [], onModel: change };
  const { rerender } = render(<ConversationOptions {...base} />);
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "员工模型" }));
  fireEvent.click(await screen.findByRole("button", { name: "使用已配置模型…" }));
  const input = await screen.findByLabelText("模型标识");
  fireEvent.change(input, { target: { value: "custom/already-entered" } });
  const form = input.closest("form")!;
  const submit = screen.getByRole("button", { name: "使用此模型" });

  rerender(<ConversationOptions {...base} saving={state === "saving"} running={state === "running"}
    disabled={state === "running"} loading={state === "loading"} error={state === "error" ? "加载模型失败" : undefined}
    config={{ ...config, editable: state !== "read-only" }} />);
  expect(screen.getByRole("combobox", { name: "员工模型" })).toBeDisabled();
  // A portal can outlive its disabled Select during the close animation.
  // Neither its button nor an Enter/form submit may bypass that guard.
  fireEvent.click(submit);
  fireEvent.submit(form);
  expect(change).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("button", { name: "使用此模型" })).not.toBeInTheDocument());

  rerender(<ConversationOptions {...base} />);
  expect(screen.queryByRole("button", { name: "使用此模型" })).not.toBeInTheDocument();
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "员工模型" }));
  fireEvent.click(await screen.findByRole("button", { name: "使用已配置模型…" }));
  expect(await screen.findByLabelText("模型标识")).toHaveValue("custom/already-entered");
  fireEvent.click(screen.getByRole("button", { name: "使用此模型" }));
  expect(change).toHaveBeenCalledExactlyOnceWith("custom/already-entered");
});
