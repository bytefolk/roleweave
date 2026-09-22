import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExperimentsResponse, ReportsAdviceResponse, ReportsResponse } from "@roleweave/shared";
import { ReportsCenter } from "../src/reports/ReportsCenter";
import { EXPERIMENTS_CHANGED } from "../src/experiments/useWorkspaceExperiments";

const experiment = (enabled = true): ExperimentsResponse => ({ schemaVersion: "experiments.v1", workspacePath: "/projects/a", workspaceSession: "session-a", revision: 1, enabled, availability: enabled ? "ready" : "disabled", provider: { name: "Jev / TypeSafe", endpointHost: "api.typesafe.ai", configured: true }, sending: ["status", "errorCode", "budgetRelated"] });
const entry = { schemaVersion: "turn-escalation.v1" as const, positionId: "alice", turnId: "failed-1", status: "failed" as const, at: "2026-09-22T00:00:00Z", code: "engine.failed", reportingChain: ["alice"], budgetRelated: false };
const report: ReportsResponse = { schemaVersion: "reports.v1", budgets: [], streams: { escalations: [entry], audits: [], evidence: [] }, page: { cursor: null, hasMore: false } };
const advice = (): ReportsAdviceResponse => ({ workspacePath: "/projects/a", workspaceSession: "session-a", revision: 1, status: "ready", items: [{ turnId: entry.turnId, positionId: entry.positionId, at: entry.at, suggestion: "inspect_run", source: "jev" }], cached: false, considered: 1, total: 1, generatedAt: entry.at });
function install(settings = experiment()) {
  const get = vi.fn(async () => ({ status: 200, body: settings }));
  const reportAdvice = vi.fn(async () => ({ status: 200, body: advice() }));
  Object.defineProperty(window, "owb", { configurable: true, value: { experiments: { get }, reportAdvice } });
  return { get, reportAdvice };
}
function show() { return render(<ReportsCenter reports={report} loading={false} workspacePath="/projects/a" positionNames={{ alice: "Alice" }} />); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe("explicit report advice", () => {
  it("does not call the provider on read, refresh or when disabled", async () => {
    const api = install(experiment(false)); const open = vi.fn();
    const { rerender } = render(<ReportsCenter reports={report} loading={false} workspacePath="/projects/a" onOpenExperiments={open} />);
    await screen.findByText("此预览功能默认关闭，可在当前项目的实验功能中开启。");
    fireEvent.click(screen.getByRole("button", { name: "打开实验功能" })); expect(open).toHaveBeenCalledOnce();
    rerender(<ReportsCenter reports={{ ...report }} loading={false} workspacePath="/projects/a" />);
    expect(screen.queryByRole("button", { name: "生成建议" })).toBeNull(); expect(api.reportAdvice).not.toHaveBeenCalled();
  });
  it("generates only after a click, adds suggestions, and preserves the factual trace action", async () => {
    const api = install(); show(); const button = await screen.findByRole("button", { name: "生成建议" });
    expect(api.reportAdvice).not.toHaveBeenCalled(); fireEvent.click(button);
    await screen.findByText("参考建议 · 查看执行记录，确认失败原因");
    expect(api.reportAdvice).toHaveBeenCalledWith({ workspacePath: "/projects/a", workspaceSession: "session-a", revision: 1 });
    expect(screen.getByText("已检查 1 / 1 条记录 · 1 条建议")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "追溯这次执行" })); expect(screen.getByLabelText("执行时间线")).toBeInTheDocument();
  });
  it("retains original records when the provider times out and permits retry", async () => {
    const api = install(); api.reportAdvice.mockResolvedValueOnce({ status: 200, body: { ...advice(), status: "unavailable", reason: "timeout", items: [] } });
    show(); fireEvent.click(await screen.findByRole("button", { name: "生成建议" }));
    await screen.findByText("建议暂不可用。原始记录仍可查看；你可以稍后重试。");
    expect(screen.getByRole("button", { name: "追溯这次执行" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" })); await screen.findByText("参考建议 · 查看执行记录，确认失败原因");
  });
  it("refreshes an expired revision and uses the new revision on the next explicit request", async () => {
    const api = install(); api.reportAdvice.mockResolvedValueOnce({ status: 409, body: advice() });
    show(); await screen.findByRole("button", { name: "生成建议" });
    api.get.mockResolvedValueOnce({ status: 200, body: { ...experiment(), revision: 2 } });
    fireEvent.click(screen.getByRole("button", { name: "生成建议" }));
    await screen.findByText("项目设置已更新。请确认当前状态后重新生成建议。");
    await waitFor(() => expect(screen.getByRole("button", { name: "生成建议" })).toBeEnabled());
    expect(api.reportAdvice).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "生成建议" }));
    await waitFor(() => expect(api.reportAdvice).toHaveBeenLastCalledWith({ workspacePath: "/projects/a", workspaceSession: "session-a", revision: 2 }));
  });
  it("discards an in-flight result immediately when consent is revoked", async () => {
    const api = install(); const pending = deferred<{ status: number; body: ReportsAdviceResponse }>(); api.reportAdvice.mockReturnValueOnce(pending.promise);
    show(); fireEvent.click(await screen.findByRole("button", { name: "生成建议" }));
    api.get.mockResolvedValue({ status: 200, body: { ...experiment(false), revision: 2 } });
    act(() => window.dispatchEvent(new CustomEvent(EXPERIMENTS_CHANGED, { detail: { workspacePath: "/projects/a" } })));
    await act(async () => pending.resolve({ status: 200, body: advice() }));
    await screen.findByText("此预览功能默认关闭，可在当前项目的实验功能中开启。");
    expect(screen.queryByText("参考建议 · 查看执行记录，确认失败原因")).toBeNull();
  });
  it("never reuses a prior workspace result after A → B → A", async () => {
    const api = install(); const pending = deferred<{ status: number; body: ReportsAdviceResponse }>(); api.reportAdvice.mockReturnValueOnce(pending.promise);
    const { rerender } = render(<ReportsCenter reports={report} loading={false} workspacePath="/projects/a" workspaceScope={Symbol("a1")} />);
    fireEvent.click(await screen.findByRole("button", { name: "生成建议" }));
    api.get.mockResolvedValueOnce({ status: 200, body: { ...experiment(), workspacePath: "/projects/b", workspaceSession: "session-b" } });
    rerender(<ReportsCenter reports={report} loading={false} workspacePath="/projects/b" workspaceScope={Symbol("b")} />);
    await screen.findByRole("button", { name: "生成建议" });
    api.get.mockResolvedValueOnce({ status: 200, body: { ...experiment(), workspaceSession: "session-a2" } });
    rerender(<ReportsCenter reports={report} loading={false} workspacePath="/projects/a" workspaceScope={Symbol("a2")} />);
    await screen.findByRole("button", { name: "生成建议" });
    await act(async () => pending.resolve({ status: 200, body: advice() }));
    expect(screen.queryByText("参考建议 · 查看执行记录，确认失败原因")).toBeNull();
  });
  it("does not attach a suggestion to another failure snapshot", async () => {
    const api = install(); api.reportAdvice.mockResolvedValueOnce({ status: 200, body: { ...advice(), items: [{ ...advice().items[0]!, at: "2026-09-21T00:00:00Z" }] } });
    show(); fireEvent.click(await screen.findByRole("button", { name: "生成建议" }));
    await screen.findByRole("button", { name: "重新生成" }); expect(screen.queryByText("参考建议 · 查看执行记录，确认失败原因")).toBeNull();
  });
});
