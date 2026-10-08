import { act, fireEvent, render as renderComponent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { ConfigProvider } from "antd";
import { describe, expect, it, vi } from "vitest";
import { OwbI18nProvider } from "@roleweave/ui";
import { DriveModule } from "../src/drive/DriveModule";

function render(element: ReactNode) {
  return renderComponent(element, { wrapper: ({ children }) => <ConfigProvider button={{ autoInsertSpace: false }}>{children}</ConfigProvider> });
}

const objects = [
  { id: "mem-001", name: "会议纪要-Q3.md", size: 4821, mime: "text/markdown", createdAt: "2026-08-30T09:14:22.000Z", summary: "Q3 规划复盘与关键风险。" },
  { id: "mem-002", name: "客户访谈.m4a", size: 2_318_411, mime: "audio/mp4", createdAt: "2026-08-27T15:02:08.000Z" },
];
const imageObjects = [
  { ...objects[0], id: "image-a", name: "示意图.png", mime: "image/png", summary: "用于方案评审。" },
  { ...objects[0], id: "image-b", name: "现场照片.jpg", mime: "image/jpeg", summary: "现场拍摄。" },
];
const pixelBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
function listResponse(files = objects) { return { status: 200, body: { schemaVersion: "drive-object-list.v1", objects: files, mocked: false } }; }
function detailResponse(object = objects[0]) { return { status: 200, body: { schemaVersion: "drive-object.v1", object, mocked: false } }; }
function previewResponse(object = imageObjects[0]) {
  return { status: 200, body: { schemaVersion: "drive-object-preview.v1", preview: { objectId: object.id, mime: object.mime, dataUrl: `data:${object.mime};base64,${pixelBase64}` } } };
}
function providerResponse(kind = "mem", state = "ready") {
  return { status: 200, body: { schemaVersion: "drive-provider.v1", status: { schemaVersion: "drive-provider.v1", kind, state } } };
}
function installBridge(files = objects) {
  const list = vi.fn().mockResolvedValue(listResponse(files));
  const detail = vi.fn().mockImplementation(async (id: string) => detailResponse(files.find((object) => object.id === id)!));
  const preview = vi.fn().mockImplementation(async (id: string) => previewResponse(files.find((object) => object.id === id)!));
  const bridge = { list, detail, preview };
  Object.defineProperty(window, "owb", { configurable: true, value: { drive: bridge } });
  return bridge;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function openImage(name = "示意图.png") {
  const button = await screen.findByRole("button", { name: `选择 ${name}` });
  fireEvent.doubleClick(button);
  await waitFor(() => expect(screen.getByRole("dialog", { name: `预览：${name}` })).toBeVisible());
  return button;
}

describe("drive file browser", () => {
  it("recognizes real upstream directory entries in both views and uses only listed metadata for their details", async () => {
    const directory = { id: "bdpan-directory", name: "项目资料", size: 8192, mime: "inode/directory", createdAt: "2026-10-07T08:00:00.000Z" };
    const bridge = installBridge([...objects, directory]);
    render(<DriveModule workspaceOpen />);
    const folder = await screen.findByRole("button", { name: "选择 项目资料" });
    const row = within(folder.closest("tr")!);
    expect(row.getByText("文件夹")).toBeVisible();
    expect(row.getByText("—")).toBeVisible();
    expect(folder.querySelector('[data-kind="folder"] .lucide-folder')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "文件夹", exact: true }));
    expect(screen.queryByRole("button", { name: "选择 会议纪要-Q3.md" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "网格" }));
    expect(screen.getByRole("list", { name: "网盘文件列表" })).toHaveTextContent("文件夹 · —");
    fireEvent.click(screen.getByRole("button", { name: "选择 项目资料" }));
    fireEvent.click(screen.getByRole("button", { name: "文件详情" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("当前存储来源尚不支持进入文件夹。")).toBeInTheDocument();
    expect(within(dialog).getByText("—")).toBeInTheDocument();
    expect(bridge.detail).not.toHaveBeenCalled();
    expect(bridge.preview).not.toHaveBeenCalled();
    expect(bridge.list).toHaveBeenCalledOnce();
  });

  it.each(["double-click", "Enter"])("explains unsupported folder browsing on %s without issuing a content request or changing location", async (action) => {
    const directory = { id: "bdpan-directory", name: "项目资料", size: 0, mime: " INODE/DIRECTORY; charset=binary ", createdAt: "2026-10-07T08:00:00.000Z" };
    const bridge = installBridge([directory]);
    render(<DriveModule workspaceOpen />);
    const folder = await screen.findByRole("button", { name: "选择 项目资料" });
    if (action === "Enter") fireEvent.keyDown(folder, { key: "Enter" }); else fireEvent.doubleClick(folder);
    const dialog = await screen.findByRole("dialog", { name: "预览：项目资料" });
    await waitFor(() => expect(within(dialog).getByText("当前存储来源尚不支持进入文件夹。")).toBeVisible());
    expect(within(dialog).getByText("文件夹")).toBeVisible();
    expect(within(dialog).getByText("—")).toBeVisible();
    expect(bridge.detail).not.toHaveBeenCalled();
    expect(bridge.preview).not.toHaveBeenCalled();
    expect(bridge.list).toHaveBeenCalledExactlyOnceWith("");
    expect(screen.getByText("全部文件")).toBeInTheDocument();
  });

  it("uses the whole file area and only opens metadata on demand", async () => {
    const bridge = installBridge();
    render(<DriveModule workspaceOpen />);
    const table = await screen.findByRole("table", { name: "网盘文件列表" });
    expect(within(table).getByRole("columnheader", { name: "文件名" })).toBeVisible();
    expect(within(table).getByRole("columnheader", { name: "创建时间" })).toBeVisible();
    expect(within(table).getByText("会议纪要-Q3.md")).toBeVisible();
    expect(screen.queryByText("text/markdown")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /上传|新建文件夹|移动|删除/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择 会议纪要-Q3.md" }));
    expect(screen.getByRole("status")).toHaveTextContent("已选 1 项");
    expect(bridge.detail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "文件详情" }));
    expect(await within(screen.getByRole("dialog")).findByText("Q3 规划复盘与关键风险。")).toBeVisible();
    expect(bridge.detail).toHaveBeenCalledWith("mem-001");
    expect(bridge.preview).not.toHaveBeenCalled();
  });

  it("filters and sorts the loaded files, switches to grid and keeps selection count honest", async () => {
    installBridge([...objects, imageObjects[0]]);
    render(<DriveModule workspaceOpen />);
    await screen.findByRole("table");
    fireEvent.change(screen.getByRole("combobox", { name: "文件排序" }), { target: { value: "sizeDesc" } });
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("客户访谈.m4a");
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 会议纪要-Q3.md" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 客户访谈.m4a" }));
    expect(screen.getByRole("status")).toHaveTextContent("已选 2 项");
    expect(screen.getByRole("button", { name: "预览" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "图片", exact: true }));
    expect(screen.queryByRole("button", { name: "选择 会议纪要-Q3.md" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已选 0 项");
    fireEvent.click(screen.getByRole("button", { name: "网格" }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "网盘文件列表" })).toHaveTextContent("示意图.png");
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 示意图.png" }));
    expect(screen.getByRole("button", { name: "预览" })).toBeEnabled();
  });

  it("sorts by the actual creation timestamp and name", async () => {
    installBridge([{ ...objects[0], name: "B.md" }, { ...objects[1], name: "A.m4a" }]);
    render(<DriveModule workspaceOpen />);
    await screen.findByRole("table");
    const firstName = () => within(screen.getByRole("table")).getAllByRole("row")[1]?.textContent;
    expect(firstName()).toContain("B.md");
    fireEvent.change(screen.getByRole("combobox", { name: "文件排序" }), { target: { value: "oldest" } });
    expect(firstName()).toContain("A.m4a");
    fireEvent.change(screen.getByRole("combobox", { name: "文件排序" }), { target: { value: "nameDesc" } });
    expect(firstName()).toContain("B.md");
  });

  it("supports selecting all current results and clearing the selection", async () => {
    installBridge(); render(<DriveModule workspaceOpen />); await screen.findByRole("table");
    fireEvent.click(screen.getByRole("checkbox", { name: "选择当前显示的全部文件" }));
    expect(screen.getByRole("status")).toHaveTextContent("已选 2 项");
    fireEvent.click(screen.getByRole("button", { name: "清除选择" }));
    expect(screen.getByRole("status")).toHaveTextContent("已选 0 项");
    expect(screen.getByRole("checkbox", { name: "选择当前显示的全部文件" })).not.toBeChecked();
  });

  it("selects and previews through the full row, including metadata cells", async () => {
    const bridge = installBridge(); render(<DriveModule workspaceOpen />);
    const table = await screen.findByRole("table"); const row = within(table).getAllByRole("row")[1]!;
    fireEvent.click(within(row).getByText("4.7 KB"));
    expect(screen.getByRole("status")).toHaveTextContent("已选 1 项"); expect(bridge.detail).not.toHaveBeenCalled();
    fireEvent.doubleClick(within(row).getByText("文档"));
    expect(await screen.findByRole("dialog", { name: "预览：会议纪要-Q3.md" })).toBeInTheDocument();
    expect(bridge.detail).toHaveBeenCalledWith("mem-001");
  });

  it("retries a failed detail read without substituting another object's metadata", async () => {
    const bridge = installBridge();
    bridge.detail.mockResolvedValueOnce(detailResponse(objects[1])).mockResolvedValueOnce(detailResponse(objects[0]));
    render(<DriveModule workspaceOpen />);
    fireEvent.click(await screen.findByRole("button", { name: "选择 会议纪要-Q3.md" }));
    fireEvent.click(screen.getByRole("button", { name: "文件详情" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("网盘对象读取失败");
    expect(within(dialog).queryByText("客户访谈.m4a")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument());
    expect(bridge.detail).toHaveBeenCalledTimes(2);
  });

  it("keeps unconfigured and failed reads distinct from a genuinely empty file list and supports retry", async () => {
    const bridge = installBridge();
    bridge.list.mockResolvedValueOnce({ status: 503, body: { code: "drive_not_configured", message: "not configured" } }).mockResolvedValueOnce({ status: 503, body: { code: "drive_upstream_failed", message: "Provider offline" } }).mockResolvedValue(listResponse([]));
    render(<DriveModule workspaceOpen />);
    expect((await screen.findAllByText(/尚未连接/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新网盘" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider offline");
    expect(screen.queryByText("暂无资料")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("暂无资料")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("bounds server searches, shows the applied query, and ignores an old search response", async () => {
    const bridge = installBridge(); render(<DriveModule workspaceOpen />); await screen.findByRole("table");
    const old = deferred<ReturnType<typeof listResponse>>();
    bridge.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce(listResponse([objects[1]]));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索网盘" }), { target: { value: "a".repeat(400) } });
    fireEvent.click(screen.getByRole("button", { name: "搜索", exact: true }));
    expect(bridge.list).toHaveBeenLastCalledWith("a".repeat(256));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索网盘" }), { target: { value: "客户" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索", exact: true }));
    expect(await screen.findByRole("heading", { name: "搜索结果：客户" })).toBeVisible();
    await screen.findByRole("button", { name: "选择 客户访谈.m4a" });
    await act(async () => { old.resolve(listResponse()); });
    expect(screen.queryByRole("button", { name: "选择 会议纪要-Q3.md" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    await waitFor(() => expect(bridge.list).toHaveBeenLastCalledWith(""));
    expect(screen.getByRole("heading", { name: "全部文件" })).toBeVisible();
  });

  it("provides arrow-key navigation and Enter preview without pretending that a summary is the full document", async () => {
    const bridge = installBridge(); render(<DriveModule workspaceOpen />); await screen.findByRole("table");
    const first = screen.getByRole("button", { name: "选择 会议纪要-Q3.md" });
    const second = screen.getByRole("button", { name: "选择 客户访谈.m4a" });
    act(() => first.focus()); fireEvent.keyDown(first, { key: "ArrowDown" }); expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "ArrowUp" }); expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Enter" });
    const dialog = await screen.findByRole("dialog", { name: "预览：会议纪要-Q3.md" });
    await waitFor(() => expect(within(dialog).getByText("当前来源仅提供文件摘要，暂无全文预览。")).toBeVisible());
    expect(await within(dialog).findByText("Q3 规划复盘与关键风险。")).toBeVisible();
    expect(bridge.preview).not.toHaveBeenCalled();
  });

  it("shows the actual provider and does not probe it again for search, sorting, view, filter or locale changes", async () => {
    const bridge = installBridge(); const provider = vi.fn().mockResolvedValue(providerResponse("bdpan", "auth_expired"));
    Object.defineProperty(window, "owb", { configurable: true, value: { drive: { ...bridge, provider } } });
    const context = render(<OwbI18nProvider locale="zh-CN"><DriveModule workspaceOpen serviceAction={<button>Mem external service</button>} /></OwbI18nProvider>);
    expect((await screen.findAllByText("登录已过期")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Mem external service" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "文件排序" }), { target: { value: "nameAsc" } });
    fireEvent.click(screen.getByRole("button", { name: "网格" }));
    fireEvent.click(screen.getByRole("button", { name: "文档", exact: true }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索网盘" }), { target: { value: "Q3" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索", exact: true }));
    context.rerender(<OwbI18nProvider locale="en"><DriveModule workspaceOpen serviceAction={<button>Mem external service</button>} /></OwbI18nProvider>);
    expect(provider).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Refresh the drive" }));
    await waitFor(() => expect(provider).toHaveBeenCalledTimes(2));
  });

  it("keeps a provider probe error visible while retaining readable files", async () => {
    const bridge = installBridge();
    Object.defineProperty(window, "owb", { configurable: true, value: { drive: { ...bridge, provider: vi.fn().mockRejectedValue(new Error("offline")) } } });
    render(<DriveModule workspaceOpen />);
    expect(await screen.findByText("来源状态暂无法读取")).toBeVisible();
    expect(await screen.findByRole("table")).toHaveTextContent("会议纪要-Q3.md");
  });

  it("does not read data without a workspace or apply a late list/provider reply to a new workspace", async () => {
    const bridge = installBridge(); const old = deferred<ReturnType<typeof listResponse>>(); const oldProvider = deferred<ReturnType<typeof providerResponse>>();
    bridge.list.mockReturnValueOnce(old.promise).mockResolvedValue(listResponse([objects[1]]));
    const provider = vi.fn().mockReturnValueOnce(oldProvider.promise).mockResolvedValue(providerResponse("bdpan"));
    Object.defineProperty(window, "owb", { configurable: true, value: { drive: { ...bridge, provider } } });
    const context = render(<DriveModule workspaceOpen={false} workspaceKey="A" />);
    expect(bridge.list).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
    context.rerender(<DriveModule workspaceOpen workspaceKey="A" />);
    context.rerender(<DriveModule workspaceOpen workspaceKey="B" />);
    await screen.findByRole("button", { name: "选择 客户访谈.m4a" });
    await act(async () => { old.resolve(listResponse()); oldProvider.resolve(providerResponse("mem")); });
    expect(screen.queryByRole("button", { name: "选择 会议纪要-Q3.md" })).not.toBeInTheDocument();
    expect(screen.getByText(/百度网盘/)).toBeVisible();
  });
});

describe("actual drive image previews", () => {
  it("loads only on explicit preview, preserves metadata and opens the loaded image at full size", async () => {
    const bridge = installBridge(imageObjects); const pending = deferred<ReturnType<typeof previewResponse>>(); bridge.preview.mockReturnValue(pending.promise);
    render(<DriveModule workspaceOpen />);
    const file = await screen.findByRole("button", { name: "选择 示意图.png" });
    fireEvent.click(file); expect(bridge.preview).not.toHaveBeenCalled(); fireEvent.doubleClick(file);
    await waitFor(() => expect(screen.getByRole("status", { name: "图片加载中…" })).toBeVisible());
    const dialog = screen.getByRole("dialog", { name: "预览：示意图.png" });
    expect(within(dialog).getByText("用于方案评审。")).toBeVisible(); expect(within(dialog).getByText("4.7 KB")).toBeVisible();
    await act(async () => { pending.resolve(previewResponse()); });
    const image = await screen.findByRole("img", { name: "示意图.png" });
    expect(image).toHaveAttribute("src", previewResponse().body.preview.dataUrl); fireEvent.load(image); fireEvent.click(image);
    await waitFor(() => expect(screen.getAllByRole("img", { name: "示意图.png" })).toHaveLength(2));
  });

  it.each([
    ["drive_preview_unsupported", "暂不支持此图片格式预览；支持 PNG、JPEG、WebP 和 GIF。"],
    ["drive_preview_too_large", "图片过大，暂无法预览。"],
    ["drive_preview_invalid", "图片内容损坏或格式不正确。"],
    ["drive_action_unsupported", "此存储来源暂不提供图片预览。"],
  ])("explains %s and retries the current file without losing its metadata", async (code, message) => {
    const bridge = installBridge(imageObjects); bridge.preview.mockResolvedValueOnce({ status: 422, body: { code, message: "upstream failure" } });
    render(<DriveModule workspaceOpen />); await openImage();
    expect(await screen.findByText(message)).toBeVisible(); expect(screen.getByText("图片预览失败")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("img", { name: "示意图.png" })).toBeVisible(); expect(bridge.preview).toHaveBeenCalledTimes(2);
  });

  it("reports a browser decode failure instead of leaving a broken image", async () => {
    installBridge(imageObjects); render(<DriveModule workspaceOpen />); await openImage();
    fireEvent.error(await screen.findByRole("img", { name: "示意图.png" }));
    expect(await screen.findByText("图片内容损坏或格式不正确。")).toBeVisible(); expect(screen.queryByRole("img", { name: "示意图.png" })).not.toBeInTheDocument();
  });

  it("does not replace a new selection with late preview or detail replies", async () => {
    const bridge = installBridge(imageObjects); const oldPreview = deferred<ReturnType<typeof previewResponse>>(); const oldDetail = deferred<ReturnType<typeof detailResponse>>();
    bridge.preview.mockImplementation((id: string) => id === "image-a" ? oldPreview.promise : Promise.resolve(previewResponse(imageObjects[1])));
    bridge.detail.mockImplementation((id: string) => id === "image-a" ? oldDetail.promise : Promise.resolve(detailResponse(imageObjects[1])));
    render(<DriveModule workspaceOpen />); const second = await screen.findByRole("button", { name: "选择 现场照片.jpg" }); await openImage(); fireEvent.doubleClick(second);
    expect(await screen.findByRole("img", { name: "现场照片.jpg" })).toHaveAttribute("src", previewResponse(imageObjects[1]).body.preview.dataUrl);
    await act(async () => { oldPreview.resolve(previewResponse()); oldDetail.resolve(detailResponse(imageObjects[0])); });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "预览：现场照片.jpg" })).toBeVisible()); expect(screen.queryByRole("img", { name: "示意图.png" })).not.toBeInTheDocument();
  });

  it("ignores preview replies after closing, starting a new query or unmounting", async () => {
    const bridge = installBridge(imageObjects); const first = deferred<ReturnType<typeof previewResponse>>(), second = deferred<ReturnType<typeof previewResponse>>(), third = deferred<ReturnType<typeof previewResponse>>();
    bridge.preview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    const context = render(<DriveModule workspaceOpen />); const file = await openImage();
    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    await act(async () => { first.resolve(previewResponse()); }); expect(screen.queryByRole("img", { name: "示意图.png" })).not.toBeInTheDocument();
    fireEvent.doubleClick(file); const search = screen.getByRole("textbox", { name: "搜索网盘", hidden: true });
    fireEvent.change(search, { target: { value: "other" } }); fireEvent.submit(search.closest("form")!);
    await act(async () => { second.resolve(previewResponse()); }); expect(screen.queryByRole("img", { name: "示意图.png" })).not.toBeInTheDocument();
    await openImage(); context.unmount(); await act(async () => { third.resolve(previewResponse()); }); expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("retains the current image when the same file is opened again", async () => {
    const bridge = installBridge(imageObjects); render(<DriveModule workspaceOpen />); const file = await openImage();
    const image = await screen.findByRole("img", { name: "示意图.png" }); fireEvent.doubleClick(file);
    expect(screen.getByRole("img", { name: "示意图.png" })).toBe(image); expect(bridge.preview).toHaveBeenCalledOnce();
  });

  it("ignores the old workspace's bytes even when the new workspace uses the same object id", async () => {
    const bridge = installBridge(imageObjects); const old = deferred<ReturnType<typeof previewResponse>>();
    const fresh = previewResponse(); fresh.body.preview.dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    bridge.preview.mockReturnValueOnce(old.promise).mockResolvedValue(fresh);
    const context = render(<DriveModule workspaceOpen workspaceKey="A" />); await openImage();
    context.rerender(<DriveModule workspaceOpen workspaceKey="B" />); await openImage();
    expect(await screen.findByRole("img", { name: "示意图.png" })).toHaveAttribute("src", fresh.body.preview.dataUrl);
    await act(async () => { old.resolve(previewResponse()); });
    expect(screen.getByRole("img", { name: "示意图.png" })).toHaveAttribute("src", fresh.body.preview.dataUrl);
  });

  it("accepts a supported MIME with case and content-type parameters", async () => {
    const bridge = installBridge([{ ...imageObjects[0], mime: " IMAGE/PNG; charset=binary " }]); bridge.preview.mockResolvedValue(previewResponse());
    render(<DriveModule workspaceOpen />); await openImage(); expect(await screen.findByRole("img", { name: "示意图.png" })).toBeVisible();
  });

  it.each([{ objectId: "different-file" }, { dataUrl: "https://untrusted.example/preview.png" }])("rejects a mismatched or remote preview payload: %j", async (invalid) => {
    const bridge = installBridge(imageObjects); const response = previewResponse(); bridge.preview.mockResolvedValue({ ...response, body: { ...response.body, preview: { ...response.body.preview, ...invalid } } });
    render(<DriveModule workspaceOpen />); await openImage(); expect(await screen.findByText("图片预览失败")).toBeVisible(); expect(screen.queryByRole("img", { name: "示意图.png" })).not.toBeInTheDocument();
  });

  it("explains an unsupported vector format without requesting its bytes", async () => {
    const bridge = installBridge([{ ...imageObjects[0], mime: "image/svg+xml" }]); render(<DriveModule workspaceOpen />); await openImage();
    expect(screen.getByText("暂不支持此图片格式预览；支持 PNG、JPEG、WebP 和 GIF。")).toBeVisible(); expect(bridge.preview).not.toHaveBeenCalled();
  });
});
