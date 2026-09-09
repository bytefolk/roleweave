import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DocsFileListResponse, DocsFileResponse } from "@roleweave/shared";
import { DocsModule } from "../src/docs/DocsModule";
import type { OwbBridge } from "../src/owb";

/** #35 S3 ModuleRail wiring: the docs module consumes the S2 bridge surface
 * (positionDocs/positionDocFile) — no new channel is introduced. */

const positions = [
  { id: "repo-owner", name: "Repo Owner" },
  { id: "release-engineer", name: "Release Engineer" },
];

const listBody: DocsFileListResponse = {
  schemaVersion: "docs-file-list.v1",
  positionId: "repo-owner",
  files: [
    { path: "handbook.md", kind: "file", size: 128, modifiedAt: "2026-08-27T00:00:00.000Z" },
  ],
};

const readBody: DocsFileResponse = {
  schemaVersion: "docs-file.v1",
  positionId: "repo-owner",
  path: "handbook.md",
  content: "# Handbook\n\nBody copy.",
  version: "2026-08-27T00:00:00.000Z",
  size: 128,
  modifiedAt: "2026-08-27T00:00:00.000Z",
};

function installBridge(overrides: Partial<Pick<OwbBridge, "positionDocs" | "positionDocFile">> = {}) {
  const bridge = {
    positionDocs: overrides.positionDocs ?? vi.fn().mockResolvedValue({ status: 200, body: listBody }),
    positionDocFile: overrides.positionDocFile ?? vi.fn().mockResolvedValue({ status: 200, body: readBody }),
  };
  window.owb = bridge as unknown as OwbBridge;
  return bridge;
}

describe("DocsModule (#35 S3)", () => {
  it("shows a workspace-closed empty state without touching the bridge", () => {
    const bridge = installBridge();
    render(<DocsModule workspaceOpen={false} positions={positions} selectedPositionId={null} />);
    expect(screen.getByText("尚未打开工作区")).toBeTruthy();
    expect(bridge.positionDocs).not.toHaveBeenCalled();
  });

  it("lists docs for the selected position and opens a file through the S2 bridge", async () => {
    const bridge = installBridge();
    render(<DocsModule workspaceOpen positions={positions} selectedPositionId="repo-owner" />);
    await waitFor(() => expect(bridge.positionDocs).toHaveBeenCalledWith("repo-owner"));
    const file = await screen.findByRole("button", { name: "handbook.md" });
    fireEvent.click(file);
    await waitFor(() => expect(bridge.positionDocFile).toHaveBeenCalledWith("repo-owner", "handbook.md"));
    expect(await screen.findByRole("heading", { name: "Handbook" })).toBeTruthy();
    expect(screen.getByText("版本 2026-08-27T00:00:00.000Z")).toBeTruthy();
  });

  it("surfaces the server error message when the listing fails", async () => {
    installBridge({
      positionDocs: vi.fn().mockResolvedValue({
        status: 404,
        body: { code: "position_missing", message: "岗位不存在", retryable: false },
      }),
    });
    render(<DocsModule workspaceOpen positions={positions} selectedPositionId="ghost" />);
    expect(await screen.findByText("岗位不存在")).toBeTruthy();
  });

  it("re-lists when the org-tree selection changes", async () => {
    const bridge = installBridge();
    const { rerender } = render(
      <DocsModule workspaceOpen positions={positions} selectedPositionId="repo-owner" />,
    );
    await waitFor(() => expect(bridge.positionDocs).toHaveBeenCalledWith("repo-owner"));
    rerender(<DocsModule workspaceOpen positions={positions} selectedPositionId="release-engineer" />);
    await waitFor(() => expect(bridge.positionDocs).toHaveBeenCalledWith("release-engineer"));
  });
});
