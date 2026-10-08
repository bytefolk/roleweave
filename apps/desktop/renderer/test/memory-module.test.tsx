import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryModule } from "../src/memory/MemoryModule";
vi.mock("../src/memory/VaultModule", () => ({ VaultModule: () => <div>统一工作区笔记</div> }));
vi.mock("../src/drive/DriveModule", () => ({ DriveModule: () => <div>网盘资源</div> }));
vi.mock("../src/settings/ServiceLaunch", () => ({ ServiceLaunch: () => <button>连接网盘</button> }));
describe("统一笔记入口", () => {
  it.each(["notes", "docs", "shared", "sessions"] as const)("maps legacy %s to the same vault", (initialSource) => {
    render(<MemoryModule workspaceOpen positions={[]} selectedPositionId={null} initialSource={initialSource} />);
    expect(screen.getByText("统一工作区笔记")).toBeVisible();
    expect(within(screen.getByRole("navigation", { name: "笔记库导航" })).getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByText("共享知识")).not.toBeInTheDocument();
    expect(screen.queryByText("会话记忆")).not.toBeInTheDocument();
  });
  it("opens drive resources and keeps reading focus specific to notes", () => {
    render(<MemoryModule workspaceOpen positions={[]} selectedPositionId={null} />);
    fireEvent.click(screen.getByRole("button", { name: "专注阅读" }));
    expect(screen.getByRole("region", { name: "笔记库" })).toHaveAttribute("data-reading-focus", "true");
    fireEvent.click(screen.getByRole("button", { name: "网盘" }));
    expect(screen.getByText("网盘资源")).toBeVisible();
    expect(screen.queryByRole("button", { name: "退出专注阅读" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "笔记库" })).toHaveAttribute("data-reading-focus", "false");
  });
  it("waits for a workspace before opening a library", () => {
    render(<MemoryModule workspaceOpen={false} positions={[]} selectedPositionId={null} />);
    expect(screen.getByText("尚未打开工作区")).toBeVisible();
    expect(screen.queryByText("统一工作区笔记")).not.toBeInTheDocument();
  });
});
