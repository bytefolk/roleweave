import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OwbI18nProvider } from "@roleweave/ui";
import type { DocPlaneDetailResponse, DocPlaneListResponse } from "@roleweave/shared";
import {
  DocPlanePanel,
  type DocPlaneDetailLoadResult,
  type DocPlaneListLoadResult,
} from "../src/docs/DocPlanePanel";

/**
 * #35 R2 MVP: DocPlanePanel is the renderer face of the shell-owned
 * bytefolk/doc proxy. The tests below drive its loader seams directly so
 * the whitelisted preload bridge doesn't have to be booted — the same
 * shape is used in production via DocsModule's docPlaneList/docPlaneDetail
 * callbacks.
 */

const LIST_RESPONSE: DocPlaneListResponse = {
  schemaVersion: "doc-plane-list.v1alpha1",
  source: "mock",
  entries: [
    {
      id: "doc-1",
      title: "Runbook",
      icon: "📘",
      updatedAt: "2026-08-27T00:00:00.000Z",
      starred: true,
    },
    {
      id: "doc-2",
      title: "Onboarding",
      icon: null,
      updatedAt: "2026-08-26T09:15:00.000Z",
      starred: false,
    },
  ],
};

const DETAIL_RESPONSE: DocPlaneDetailResponse = {
  schemaVersion: "doc-plane-detail.v1alpha1",
  source: "mock",
  id: "doc-1",
  title: "Runbook",
  icon: "📘",
  updatedAt: "2026-08-27T00:00:00.000Z",
  content: "# Runbook\n\nFirst response steps.",
};

function okList(): DocPlaneListLoadResult {
  return { kind: "ok", response: LIST_RESPONSE };
}

function okDetail(): DocPlaneDetailLoadResult {
  return { kind: "ok", response: DETAIL_RESPONSE };
}

describe("DocPlanePanel (#35 R2 external doc-plane bridge)", () => {
  it.each([
    { locale: "zh-CN" as const, tooltip: "共享文档：Engineering/Runbook" },
    { locale: "en" as const, tooltip: "Shared document: Engineering/Runbook" },
  ])("explains the full shared-document title in $locale without treating it as a file path", async ({ locale, tooltip }) => {
    const entry = { ...LIST_RESPONSE.entries[0]!, title: "Engineering/Runbook" };
    const readDoc = vi.fn().mockResolvedValue(okDetail());
    render(<OwbI18nProvider locale={locale}><DocPlanePanel listDocs={vi.fn().mockResolvedValue({ kind: "ok", response: { ...LIST_RESPONSE, entries: [entry] } })} readDoc={readDoc} /></OwbI18nProvider>);
    const document = await screen.findByRole("button", { name: entry.title });
    act(() => document.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(tooltip);
    fireEvent.click(document);
    await waitFor(() => expect(readDoc).toHaveBeenCalledWith(entry.id));
  });

  it("lists documents on mount and shows the mock-source badge", async () => {
    const listDocs = vi.fn().mockResolvedValue(okList());
    const readDoc = vi.fn().mockResolvedValue(okDetail());
    render(<DocPlanePanel listDocs={listDocs} readDoc={readDoc} />);

    await waitFor(() => expect(listDocs).toHaveBeenCalledWith(""));
    expect(await screen.findByRole("button", { name: /Runbook/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Onboarding/ })).toBeTruthy();
    expect(screen.getByText("内置样例 (mock)")).toBeTruthy();
    expect(readDoc).not.toHaveBeenCalled();
  });

  it("replaces both empty panes with a useful shared-resource connection state", async () => {
    const listDocs = vi
      .fn()
      .mockResolvedValue({ kind: "unconfigured", message: "尚未配置外部 doc 服务器" } as DocPlaneListLoadResult);
    const readDoc = vi.fn();
    render(<DocPlanePanel listDocs={listDocs} readDoc={readDoc} />);

    await waitFor(() => expect(listDocs).toHaveBeenCalled());
    expect(await screen.findByRole("heading", { name: "尚未连接共享资料" })).toBeVisible();
    expect(screen.getByText("连接团队文档服务后，可以在这里浏览共享文档并打开协作内容。")).toBeVisible();
    expect(document.querySelector(".owb-doc-plane__list-pane")).toBeNull();
    expect(document.querySelector(".owb-doc-plane__reader-pane")).toBeNull();
    expect(screen.queryByLabelText("搜索外部文档")).not.toBeInTheDocument();
    expect(screen.queryByText("选择左侧文档开始阅读。")).not.toBeInTheDocument();
    expect(readDoc).not.toHaveBeenCalled();
    expect(screen.queryByText(/ORG_WORKBENCH_DOC_URL=http:\/\/localhost:3100/)).not.toBeInTheDocument();
  });

  it("shows one injected connection action and reloads actual documents after connection", async () => {
    const connect = vi.fn();
    const listDocs = vi.fn().mockResolvedValueOnce({ kind: "unconfigured", message: "no connection" }).mockResolvedValueOnce(okList());
    const readDoc = vi.fn();
    render(<DocPlanePanel listDocs={listDocs} readDoc={readDoc}
      serviceAction={<button onClick={connect}>连接共享资料</button>} />);
    expect(await screen.findByRole("heading", { name: "尚未连接共享资料" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "连接共享资料" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "连接共享资料" }));
    expect(connect).toHaveBeenCalledOnce();
    expect(readDoc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /重\s?试/ }));
    expect(await screen.findByRole("button", { name: /Runbook/ })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "尚未连接共享资料" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "连接共享资料" })).toHaveLength(1);
    expect(listDocs).toHaveBeenLastCalledWith("");
  });

  it("localizes the complete disconnected state without exposing configured URLs or credentials", async () => {
    render(<OwbI18nProvider locale="en"><DocPlanePanel
      listDocs={vi.fn().mockResolvedValue({ kind: "unconfigured", message: "ORG_WORKBENCH_DOC_URL=https://private.example token=secret" })}
      readDoc={vi.fn()} serviceAction={<button>Connect shared resources</button>} /></OwbI18nProvider>);
    expect(await screen.findByRole("heading", { name: "Shared resources are not connected" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect shared resources" })).toBeVisible();
    expect(screen.queryByText(/private\.example|token=secret/)).not.toBeInTheDocument();
    expect(document.querySelector(".owb-doc-plane__workspace")).toBeNull();
  });

  it("opens a document detail through the injected reader", async () => {
    const listDocs = vi.fn().mockResolvedValue(okList());
    const readDoc = vi.fn().mockResolvedValue(okDetail());
    render(<DocPlanePanel listDocs={listDocs} readDoc={readDoc} />);

    await waitFor(() => expect(listDocs).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: /Runbook/ }));
    await waitFor(() => expect(readDoc).toHaveBeenCalledWith("doc-1"));

    expect(await screen.findByRole("heading", { name: "Runbook" })).toBeTruthy();
    expect(document.querySelector(".owb-doc-plane__list-pane")).toBeTruthy();
    expect(document.querySelector(".owb-doc-plane__reader-pane")).toBeTruthy();
    expect(screen.getByText("First response steps.")).toBeTruthy();
    expect(document.querySelector('time[datetime="2026-08-27T00:00:00.000Z"]')).toHaveTextContent("更新于");
  });

  it("re-lists with the user query when the search button is pressed", async () => {
    const listDocs = vi
      .fn()
      .mockResolvedValueOnce(okList())
      .mockResolvedValueOnce({
        kind: "ok",
        response: { ...LIST_RESPONSE, entries: [LIST_RESPONSE.entries[0]!] },
      } as DocPlaneListLoadResult);
    const readDoc = vi.fn().mockResolvedValue(okDetail());
    render(<DocPlanePanel listDocs={listDocs} readDoc={readDoc} />);

    await waitFor(() => expect(listDocs).toHaveBeenCalledWith(""));
    const input = screen.getByLabelText("搜索外部文档");
    fireEvent.change(input, { target: { value: "Run" } });
    fireEvent.click(screen.getByRole("button", { name: /^搜\s?索$/ }));

    await waitFor(() => expect(listDocs).toHaveBeenLastCalledWith("Run"));
    expect(await screen.findByRole("button", { name: /Runbook/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Onboarding/ })).toBeNull();
  });

  it("shows an honest empty state when the upstream list is empty", async () => {
    const listDocs = vi.fn().mockResolvedValue({
      kind: "ok",
      response: { ...LIST_RESPONSE, source: "upstream", entries: [] },
    } as DocPlaneListLoadResult);
    const readDoc = vi.fn();
    render(<DocPlanePanel listDocs={listDocs} readDoc={readDoc} />);

    await waitFor(() => expect(listDocs).toHaveBeenCalled());
    expect(await screen.findByText("真实 bytefolk/doc")).toBeTruthy();
    expect(await screen.findByText("未找到文档")).toBeTruthy();
    expect(readDoc).not.toHaveBeenCalled();
  });

  it("surfaces read errors without hiding them", async () => {
    const listDocs = vi.fn().mockResolvedValue(okList());
    const readDoc = vi
      .fn()
      .mockResolvedValue({ kind: "error", message: "upstream doc plane unreachable" } as DocPlaneDetailLoadResult);
    render(<DocPlanePanel listDocs={listDocs} readDoc={readDoc} />);

    await waitFor(() => expect(listDocs).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: /Runbook/ }));

    await waitFor(() => expect(readDoc).toHaveBeenCalled());
    expect(await screen.findByText("upstream doc plane unreachable")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Runbook" })).toBeNull();
  });
});

describe("Shared document request ordering (#294)", () => {
  it("discards late details and offers retry for rejected reads", async () => {
    let resolveOld!: (value: DocPlaneDetailLoadResult) => void;
    const readDoc = vi.fn().mockReturnValueOnce(new Promise<DocPlaneDetailLoadResult>((resolve) => { resolveOld = resolve; })).mockRejectedValueOnce(new Error("offline"));
    render(<DocPlanePanel listDocs={vi.fn().mockResolvedValue(okList())} readDoc={readDoc} />);
    fireEvent.click(await screen.findByRole("button", { name: /Runbook/ }));
    fireEvent.click(screen.getByRole("button", { name: /Onboarding/ }));
    await screen.findByText("offline");
    await act(async () => resolveOld(okDetail()));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Runbook" })).not.toBeInTheDocument());
    readDoc.mockResolvedValue({ kind: "ok", response: { ...DETAIL_RESPONSE, id: "doc-2", title: "Onboarding", content: "# Onboarding" } });
    fireEvent.click(screen.getByRole("button", { name: /重\s?试/ }));
    await screen.findByRole("heading", { name: "Onboarding" });
  });

  it("keeps the latest search results when an earlier request returns late", async () => {
    let resolveOld!: (value: DocPlaneListLoadResult) => void;
    const listDocs = vi.fn().mockReturnValueOnce(new Promise<DocPlaneListLoadResult>((resolve) => { resolveOld = resolve; })).mockResolvedValue({ kind: "ok", response: { ...LIST_RESPONSE, entries: [] } });
    render(<DocPlanePanel listDocs={listDocs} readDoc={vi.fn()} />);
    const input = screen.getByLabelText("搜索外部文档");
    fireEvent.change(input, { target: { value: "missing" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", charCode: 13 });
    await screen.findByText("未找到包含“missing”的文档");
    await act(async () => resolveOld(okList()));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Runbook/ })).not.toBeInTheDocument());
  });
});
