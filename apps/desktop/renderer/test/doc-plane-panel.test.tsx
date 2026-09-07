import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("surfaces a compact unavailable state when the shell reports doc_plane_unconfigured", async () => {
    const listDocs = vi
      .fn()
      .mockResolvedValue({ kind: "unconfigured", message: "尚未配置外部 doc 服务器" } as DocPlaneListLoadResult);
    const readDoc = vi.fn();
    render(<DocPlanePanel listDocs={listDocs} readDoc={readDoc} />);

    await waitFor(() => expect(listDocs).toHaveBeenCalled());
    expect(await screen.findByText("尚未配置外部 doc 服务器")).toBeTruthy();
    expect(screen.queryByText(/ORG_WORKBENCH_DOC_URL=http:\/\/localhost:3100/)).not.toBeInTheDocument();
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
    expect(screen.getByText("版本 2026-08-27T00:00:00.000Z")).toBeTruthy();
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
