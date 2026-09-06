import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocsCreateResponse, DocsFileListResponse } from "@roleweave/shared";
import { DocsModule } from "../src/docs/DocsModule";
import type { OwbBridge } from "../src/owb";

/** #35 S4 creation face: the docs module creates empty named files and keeps
 * the frozen doc-ref copy action for internal consumers — no editor. */

const positions = [{ id: "repo-owner", name: "Repo Owner" }];

const listBody: DocsFileListResponse = {
  schemaVersion: "docs-file-list.v1",
  positionId: "repo-owner",
  files: [
    { path: "handbook.md", kind: "file", size: 128, modifiedAt: "2026-08-27T00:00:00.000Z" },
  ],
};

const createBody: DocsCreateResponse = {
  schemaVersion: "docs-create.v1",
  positionId: "repo-owner",
  path: "runbook.md",
  version: "2026-08-27T01:00:00.000Z",
  size: 10,
  assetId: "0e2f4a6b-8c0d-4e1f-9a2b-3c4d5e6f7081",
};

function installBridge(overrides: Partial<OwbBridge> = {}) {
  const bridge = {
    positionDocs: vi.fn().mockResolvedValue({ status: 200, body: listBody }),
    positionDocFile: vi.fn().mockResolvedValue({ status: 200, body: null }),
    createPositionDoc: vi.fn().mockResolvedValue({ status: 201, body: createBody }),
    ...overrides,
  };
  window.owb = bridge as unknown as OwbBridge;
  return bridge;
}

describe("DocsModule create + copy-reference face (#35 S4)", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("creates a doc via naming-only modal and re-lists the position", async () => {
    const bridge = installBridge();
    render(<DocsModule workspaceOpen positions={positions} selectedPositionId="repo-owner" />);
    await waitFor(() => expect(bridge.positionDocs).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "新建文档" }));
    const input = await screen.findByLabelText("新文档文件名");
    fireEvent.change(input, { target: { value: "runbook.md" } });
    fireEvent.click(screen.getByRole("button", { name: /^创\s?建$/ }));

    await waitFor(() =>
      expect(bridge.createPositionDoc).toHaveBeenCalledWith({
        positionId: "repo-owner",
        path: "runbook.md",
        content: "",
      }),
    );
    await waitFor(() => expect(bridge.positionDocs).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("已创建 runbook.md")).toBeTruthy();
  });

  it("surfaces the docs_exists conflict without closing the modal", async () => {
    const bridge = installBridge({
      createPositionDoc: vi.fn().mockResolvedValue({
        status: 409,
        body: { code: "docs_exists", message: "文档已存在", retryable: false },
      }) as unknown as OwbBridge["createPositionDoc"],
    });
    render(<DocsModule workspaceOpen positions={positions} selectedPositionId="repo-owner" />);
    await waitFor(() => expect(bridge.positionDocs).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "新建文档" }));
    const input = await screen.findByLabelText("新文档文件名");
    fireEvent.change(input, { target: { value: "handbook.md" } });
    fireEvent.click(screen.getByRole("button", { name: /^创\s?建$/ }));

    expect(await screen.findByText("文档已存在")).toBeTruthy();
    expect(screen.getByLabelText("新文档文件名")).toBeTruthy();
  });

  it("copies the frozen doc-ref.v1alpha1 JSON for a listed file", async () => {
    const bridge = installBridge();
    render(<DocsModule workspaceOpen positions={positions} selectedPositionId="repo-owner" />);
    await waitFor(() => expect(bridge.positionDocs).toHaveBeenCalled());

    fireEvent.click(await screen.findByLabelText("复制引用 handbook.md"));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        JSON.stringify({
          uri: "owb-doc://repo-owner/handbook.md",
          version: "2026-08-27T00:00:00.000Z",
        }),
      ),
    );
    expect(await screen.findByText("引用已复制")).toBeTruthy();
  });

});
