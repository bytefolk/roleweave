import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { OwbI18nProvider } from "@roleweave/ui";
import type { EmployeeModelConfig } from "@roleweave/shared";
import { ConversationOptions } from "../src/turns/ConversationOptions";
import { TurnThread } from "../src/turns/TurnThread";
import type { TurnRecord } from "../src/turns/types";

const config: EmployeeModelConfig = {
  selected: "gpt-6-luna", recommended: "gpt-6-luna", editable: true, source: "provider-catalog", catalogStatus: "ready",
  options: [{ id: "gpt-6-luna", name: "GPT-6-Luna", tier: "economy" }, { id: "another-model", name: "Another model", tier: "default" }],
};
function rejected(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return { id: "rejected", positionId: "lead", positionName: "Lead", engine: "codex-local", model: "gpt-6-luna",
    input: "Where is the workspace?", status: "failed", createdAt: "2026-10-19T07:08:44Z", completedAt: "2026-10-19T07:08:50Z",
    errorCode: "codex.model_access_denied", error: "Provider diagnostic placeholder", ...overrides };
}

it.each(["zh-CN", "en"] as const)("explains the requested model rejection and recovery in %s", locale => {
  const retry = vi.fn();
  render(<OwbI18nProvider locale={locale}><TurnThread turns={[rejected()]} onRetry={retry} /></OwbI18nProvider>);
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(locale === "en" ? "Model access denied" : "模型访问被拒绝");
  expect(alert).toHaveTextContent("gpt-6-luna");
  expect(alert).toHaveTextContent(locale === "en" ? "ChatGPT login" : "ChatGPT 登录");
  expect(alert).toHaveTextContent(locale === "en" ? "same Codex CLI" : "同一 Codex CLI");
  expect(alert).not.toHaveTextContent("Provider diagnostic placeholder");
  expect(alert).not.toHaveTextContent(locale === "en" ? "adjust the task" : "调整任务");
  expect(retry).not.toHaveBeenCalled();
});

it.each(["codex", "codex-local"] as const)("distinguishes discovery from access and permits an explicit model change for %s", async engine => {
  const change = vi.fn(), refresh = vi.fn();
  const { rerender } = render(<ConversationOptions config={config} engine={engine} saving={false} disabled={false} session={null}
    turns={[rejected({ engine })]} onModel={change} onReload={refresh} />);
  const select = screen.getByRole("combobox", { name: "员工模型" });
  fireEvent.mouseDown(select);
  expect(await screen.findByRole("note")).toHaveTextContent("推荐模型尚未验证");
  expect(screen.getByRole("note")).toHaveTextContent("刷新列表不会校验调用权限");
  expect(screen.getByRole("alert")).toHaveTextContent("上次调用");
  expect(screen.getByRole("option", { name: "GPT-6-Luna", selected: true })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "刷新模型列表" }));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Another model", { selector: ".owb-model-choice > span" }));
  expect(change).toHaveBeenCalledExactlyOnceWith("another-model");
  rerender(<ConversationOptions config={{ ...config, selected: "another-model" }} engine={engine} saving={false} disabled={false}
    session={null} turns={[rejected({ engine })]} onModel={change} onReload={refresh} />);
  fireEvent.mouseDown(select);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("note")).toHaveTextContent("尚未验证");
});

it("shows the access caveat in English even when discovery is unavailable", async () => {
  render(<OwbI18nProvider locale="en"><ConversationOptions config={{ ...config, catalogStatus: "unavailable" }} engine="codex-local"
    saving={false} disabled={false} session={null} turns={[]} onModel={vi.fn()} /></OwbI18nProvider>);
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "Employee model" }));
  expect(await screen.findByRole("note")).toHaveTextContent("Refreshing the list does not verify access");
  expect(screen.getByRole("status")).toHaveTextContent("Model list is unavailable");
});

it.each([
  ["subsequent success", [rejected(), rejected({ id: "success", status: "completed", errorCode: undefined, error: undefined })]],
  ["another login mode", [rejected({ engine: "codex" })]],
  ["another model", [rejected({ model: "another-model" })]],
] as const)("does not reuse a stale model rejection after %s", async (_name, turns) => {
  render(<ConversationOptions config={config} engine="codex-local" saving={false} disabled={false} session={null} turns={[...turns]} onModel={vi.fn()} />);
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "员工模型" }));
  expect(await screen.findByRole("note")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps other Agents and ordinary failures on their existing recovery path", async () => {
  render(<><ConversationOptions config={config} engine="qoder" saving={false} disabled={false} session={null} turns={[rejected()]}
    onModel={vi.fn()} /><TurnThread turns={[rejected({ errorCode: "codex.turn_failed", error: "Invalid input schema" })]} /></>);
  const alert = screen.getByRole("alert");
  expect(within(alert).getByText("Invalid input schema")).toBeInTheDocument();
  expect(alert).toHaveTextContent("调整任务");
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "员工模型" }));
  expect(await screen.findByText("Another model", { selector: ".owb-model-choice > span" })).toBeInTheDocument();
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
});
