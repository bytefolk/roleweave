import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DriveModule } from "../src/drive/DriveModule";

const objects = [
  {
    id: "mem-001",
    name: "会议纪要-Q3.md",
    size: 4821,
    mime: "text/markdown",
    createdAt: "2026-08-30T09:14:22.000Z",
    summary: "Q3 规划复盘与关键风险。",
  },
  {
    id: "mem-002",
    name: "客户访谈.m4a",
    size: 2_318_411,
    mime: "audio/mp4",
    createdAt: "2026-08-27T15:02:08.000Z",
  },
];

function installBridge() {
  const list = vi.fn().mockResolvedValue({
    status: 200,
    body: { schemaVersion: "drive-object-list.v1", objects, mocked: false },
  });
  const detail = vi.fn().mockResolvedValue({
    status: 200,
    body: { schemaVersion: "drive-object.v1", object: objects[0], mocked: false },
  });
  Object.defineProperty(window, "owb", {
    configurable: true,
    value: { drive: { list, detail } },
  });
  return { list, detail };
}

describe("Workbench 统一网盘模块", () => {
  it("在当前客户端展示 mem 对象并打开详情", async () => {
    const bridge = installBridge();
    render(<DriveModule workspaceOpen />);

    expect(await screen.findByRole("heading", { name: "统一网盘" })).toBeInTheDocument();
    expect(await screen.findByText("会议纪要-Q3.md")).toBeInTheDocument();
    expect(screen.getByText("文档", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("text/markdown")).not.toBeInTheDocument();
    expect(screen.getByText("已连接")).toBeInTheDocument();
    expect(screen.queryByText("当前显示本地演示资料")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上传文件（待接入）" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开 会议纪要-Q3.md" }));
    expect(await screen.findByText("Q3 规划复盘与关键风险。")).toBeInTheDocument();
    expect(bridge.detail).toHaveBeenCalledWith("mem-001");
  });

  it("未连接 mem 时不展示本地演示资料", async () => {
    const list = vi.fn().mockResolvedValue({
      status: 503,
      body: {
        code: "drive_not_configured",
        message: "mem is not configured",
        retryable: false,
      },
    });
    const detail = vi.fn();
    Object.defineProperty(window, "owb", {
      configurable: true,
      value: { drive: { list, detail } },
    });

    render(<DriveModule workspaceOpen />);

    expect((await screen.findAllByText("尚未连接 mem")).length).toBe(2);
    expect(screen.queryByText("会议纪要-Q3.md")).not.toBeInTheDocument();
    expect(screen.queryByText("本地演示资料")).not.toBeInTheDocument();
    expect(detail).not.toHaveBeenCalled();
  });

  it("搜索仍然通过 Workbench 白名单桥接到统一网盘", async () => {
    const bridge = installBridge();
    render(<DriveModule workspaceOpen />);
    await screen.findByText("会议纪要-Q3.md");

    fireEvent.change(screen.getByRole("textbox", { name: "搜索网盘" }), { target: { value: "客户" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(bridge.list).toHaveBeenLastCalledWith("客户"));
  });

  it("工作区未打开时不读取 mem", () => {
    const bridge = installBridge();
    render(<DriveModule workspaceOpen={false} />);
    expect(screen.getByText("尚未打开工作区")).toBeInTheDocument();
    expect(bridge.list).not.toHaveBeenCalled();
  });
});
