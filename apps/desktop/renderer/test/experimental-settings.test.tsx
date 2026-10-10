import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExperimentsResponse, ExperimentsUpdateRequest } from "@roleweave/shared";
import { ExperimentalSettings } from "../src/settings/ExperimentalSettings";

const SUGGESTIONS = "智能协作建议";
const SHELF = "员工货架（预览）";

const response = (workspacePath = "/projects/a", enabled = false, marketplaceShelf = false): ExperimentsResponse => ({
  schemaVersion: "experiments.v1", workspacePath, workspaceSession: "session-a", revision: 0,
  enabled, marketplaceShelf, availability: enabled ? "ready" : "disabled",
  provider: { name: "Laya · local", endpointHost: "127.0.0.1", endpointUrl: "http://127.0.0.1:18081/v1/systemone", configured: true },
  sending: ["status", "errorCode", "budgetRelated"],
  budgetAdviceSending: ["remainingPerTask", "remainingPerDay", "positionId"],
});
function install(initial = response()) {
  let state = initial;
  const get = vi.fn(async () => ({ status: 200, body: state }));
  const update = vi.fn(async (input: ExperimentsUpdateRequest) => {
    state = {
      ...state, enabled: input.enabled, marketplaceShelf: input.marketplaceShelf,
      availability: input.enabled ? "ready" : "disabled", revision: state.revision + 1,
    };
    return { status: 200, body: state };
  });
  const reportAdvice = vi.fn();
  Object.defineProperty(window, "owb", { configurable: true, value: { experiments: { get, update }, reportAdvice } });
  return { get, update, reportAdvice };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const suggestionsSwitch = () => screen.getByRole("switch", { name: SUGGESTIONS });
const shelfSwitch = () => screen.getByRole("switch", { name: SHELF });

describe("workspace experimental settings", () => {
  it("requires an open project and never infers global consent", () => {
    const api = install(); render(<ExperimentalSettings />);
    expect(screen.getByText("请先打开一个项目，再设置实验功能。")).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled(); expect(api.update).not.toHaveBeenCalled();
  });
  it("defaults off, discloses provider and fields, and cancellation does not save", async () => {
    const api = install(); render(<ExperimentalSettings workspacePath="/projects/a" />);
    const toggle = await screen.findByRole("switch", { name: SUGGESTIONS });
    await waitFor(() => expect(toggle).toBeEnabled()); expect(toggle).not.toBeChecked();
    const endpoint = response().provider.endpointUrl;
    expect(screen.getByText(endpoint, { exact: true })).toBeInTheDocument();
    fireEvent.click(toggle);
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByText(endpoint, { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText(endpoint, { exact: true })).toHaveLength(2);
    expect(within(modal).getByText(/发送范围：执行状态、规范化错误码、是否与预算相关/)).toBeInTheDocument();
    expect(within(modal).getByText(/预算建议仅发送单任务剩余、单日剩余与岗位 ID/)).toBeInTheDocument();
    expect(within(modal).getByText(/不发送消息、任务或附件正文、员工姓名、项目路径/)).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole("button", { name: "取消" }));
    expect(api.update).not.toHaveBeenCalled(); expect(api.reportAdvice).not.toHaveBeenCalled();
  });
  it("persists consent only after confirmation, then disables immediately and retains records", async () => {
    const api = install(); render(<ExperimentalSettings workspacePath="/projects/a" />);
    await waitFor(() => expect(suggestionsSwitch()).toBeEnabled());
    fireEvent.click(suggestionsSwitch()); fireEvent.click(await screen.findByRole("button", { name: "同意并开启" }));
    await waitFor(() => expect(suggestionsSwitch()).toBeChecked());
    expect(api.update).toHaveBeenNthCalledWith(1, { workspacePath: "/projects/a", workspaceSession: "session-a", revision: 0, enabled: true, marketplaceShelf: false });
    fireEvent.click(suggestionsSwitch());
    await screen.findByText("已关闭，已有执行和上报记录保留。");
    await waitFor(() => expect(suggestionsSwitch()).not.toBeChecked());
    expect(api.update).toHaveBeenNthCalledWith(2, { workspacePath: "/projects/a", workspaceSession: "session-a", revision: 1, enabled: false, marketplaceShelf: false });
    expect(api.reportAdvice).not.toHaveBeenCalled();
  });
  it("shows missing credentials without requesting a renderer secret", async () => {
    install({ ...response(), provider: { ...response().provider, configured: false }, availability: "not_configured" });
    render(<ExperimentalSettings workspacePath="/projects/a" />);
    await screen.findByText(/服务不可用：本机 Laya 服务尚未运行/);
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });
  it("keeps the last saved state when a write fails and offers a state refresh", async () => {
    const api = install(response("/projects/a", true)); api.update.mockRejectedValueOnce(Error("offline"));
    render(<ExperimentalSettings workspacePath="/projects/a" />);
    await waitFor(() => expect(suggestionsSwitch()).toBeChecked()); fireEvent.click(suggestionsSwitch());
    await screen.findByText("设置未保存。请刷新状态后重试。");
    expect(suggestionsSwitch()).toBeChecked(); expect(screen.getByRole("button", { name: "刷新状态" })).toBeInTheDocument();
  });
  it("recovers invalid persisted settings only to an explicit off state", async () => {
    const api = install({ ...response(), availability: "storage_error" }); render(<ExperimentalSettings workspacePath="/projects/a" />);
    const restore = await screen.findByRole("button", { name: "恢复为关闭" });
    expect(suggestionsSwitch()).toBeDisabled(); expect(shelfSwitch()).toBeDisabled();
    fireEvent.click(restore);
    await waitFor(() => expect(suggestionsSwitch()).toBeEnabled());
    expect(suggestionsSwitch()).not.toBeChecked();
    // The repair has to clear every preview, not just the one the button names.
    expect(api.update).toHaveBeenCalledWith({ workspacePath: "/projects/a", workspaceSession: "session-a", revision: 0, enabled: false, marketplaceShelf: false });
  });
  it("rejects an old A response after A → B → A and closes an old consent dialog", async () => {
    const api = install(); const old = deferred<{ status: number; body: ExperimentsResponse }>(); api.get.mockReturnValueOnce(old.promise);
    const { rerender } = render(<ExperimentalSettings workspacePath="/projects/a" workspaceScope={Symbol("a1")} />);
    api.get.mockResolvedValueOnce({ status: 200, body: response("/projects/b") });
    rerender(<ExperimentalSettings workspacePath="/projects/b" workspaceScope={Symbol("b")} />);
    await waitFor(() => expect(suggestionsSwitch()).toBeEnabled()); fireEvent.click(suggestionsSwitch());
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    rerender(<ExperimentalSettings workspacePath="/projects/a" workspaceScope={Symbol("a2")} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => old.resolve({ status: 200, body: response("/projects/a", true) }));
    await waitFor(() => expect(suggestionsSwitch()).not.toBeChecked()); expect(api.update).not.toHaveBeenCalled();
  });

  describe("shelf preview", () => {
    it("is a separate switch that is off by default and never touches the Laya consent", async () => {
      const api = install(); render(<ExperimentalSettings workspacePath="/projects/a" />);
      await waitFor(() => expect(shelfSwitch()).toBeEnabled());
      expect(shelfSwitch()).not.toBeChecked();
      expect(screen.getByText("已关闭 · 组织上下文中不显示货架标签")).toBeInTheDocument();
      fireEvent.click(shelfSwitch());
      await screen.findByText("已为当前项目开启货架预览。当前内容为示例数据，暂不可雇用。");
      // Enabling a preview surface is not consent to send data anywhere, so it
      // saves without the provider dialog and leaves `enabled` alone.
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(api.update).toHaveBeenCalledWith({ workspacePath: "/projects/a", workspaceSession: "session-a", revision: 0, enabled: false, marketplaceShelf: true });
      expect(api.reportAdvice).not.toHaveBeenCalled();
    });
    it("survives a Laya toggle and stays independent of it", async () => {
      const api = install(response("/projects/a", false, true)); render(<ExperimentalSettings workspacePath="/projects/a" />);
      await waitFor(() => expect(suggestionsSwitch()).toBeEnabled());
      expect(shelfSwitch()).toBeChecked();
      fireEvent.click(suggestionsSwitch()); fireEvent.click(await screen.findByRole("button", { name: "同意并开启" }));
      await waitFor(() => expect(suggestionsSwitch()).toBeChecked());
      expect(api.update).toHaveBeenLastCalledWith({ workspacePath: "/projects/a", workspaceSession: "session-a", revision: 0, enabled: true, marketplaceShelf: true });
      expect(shelfSwitch()).toBeChecked();
    });
  });
});
