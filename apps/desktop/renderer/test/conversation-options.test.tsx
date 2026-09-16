import { createEvent, fireEvent, render, screen } from "@testing-library/react";
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
  expect(change).toHaveBeenCalledWith("performance");
  expect(screen.getByText("用量待回报")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "上下文详情" }));
  expect(await screen.findByText(/最多 12 轮、64 KB/)).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "携带会话历史" })).toBeDisabled();
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
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "员工模型" }));
  expect(await screen.findByText(/配置映射: team\/claude-custom/)).toBeInTheDocument();
  expect(screen.getByText(/团队网关/)).toBeInTheDocument();
  expect(screen.queryByText("经济型 · 适合问答、整理和简单修改")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "模型连接详情" }));
  expect(await screen.findByText("gateway.example.test")).toBeInTheDocument();
  expect(screen.getByText("网关 / 自定义服务")).toBeInTheDocument();
  expect(screen.getAllByText("供应商计费").length).toBeGreaterThan(0);
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
