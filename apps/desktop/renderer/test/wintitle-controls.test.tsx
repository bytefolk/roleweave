import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { OwbBridge } from "../src/owb";
import { WindowTitleBar, resolveWindowChrome } from "../src/window/WindowTitleBar";

/** Minimal bridge so <App /> mounts in jsdom (mirrors App.test installBridge). */
function installBridge(): void {
  const noop = () => undefined;
  const bridge = {
    windowChrome: { platform: "darwin", nativeControls: false },
    status: vi.fn().mockResolvedValue({
      running: true,
      port: 43123,
      health: {
        status: "ok",
        api: "v0",
        server: { version: "0.0.0", pid: 123 },
        engine: { command: "digital-employee", available: true, version: "main" },
        hosts: {
          qoder: { configured: false, ready: false },
          "claude-code": { configured: false, ready: false },
          "claude-local": { configured: false, ready: false },
          codex: { configured: false, ready: false },
          "codex-local": { configured: false, ready: false },
        },
        workspace: { open: false },
      },
    }),
    openWorkspace: vi.fn().mockResolvedValue({ canceled: true }),
    workspace: vi.fn().mockResolvedValue({ status: 200, body: { open: false } }),
    orgTree: vi.fn().mockResolvedValue({ status: 200, body: null }),
    orgApply: vi.fn().mockResolvedValue({ status: 500, body: { code: "internal" } }),
    hire: vi.fn().mockResolvedValue({ status: 500, body: { code: "internal" } }),
    orgBackups: vi.fn().mockResolvedValue({ status: 200, body: { schemaVersion: "org-backups.v1", backups: [] } }),
    orgRestore: vi.fn().mockResolvedValue({ status: 404, body: { code: "restore_invalid" } }),
    orgUndo: vi.fn().mockResolvedValue({ status: 404, body: { code: "not_found" } }),
    reports: vi.fn().mockResolvedValue({ status: 200, body: { schemaVersion: "org-reports.v1", audits: [], budgets: [], escalations: [] } }),
    position: vi.fn().mockResolvedValue({ status: 404, body: { code: "position_missing" } }),
    createTurn: vi.fn().mockResolvedValue({ status: 500, body: { code: "internal" } }),
    turnHistory: vi.fn().mockResolvedValue({ status: 200, body: { schemaVersion: "turn-history.v1", conversationId: "empty", positionId: "repo-owner", turns: [] } }),
    createSession: vi.fn().mockResolvedValue({ status: 500, body: { code: "internal" } }),
    sessions: vi.fn().mockResolvedValue({ status: 200, body: { schemaVersion: "workbench-session-list.v1", positionId: "repo-owner", activeSessionId: null, sessions: [] } }),
    session: vi.fn().mockResolvedValue({ status: 404, body: { code: "not_found" } }),
    rotateSession: vi.fn().mockResolvedValue({ status: 500, body: { code: "internal" } }),
    createSessionTurn: vi.fn().mockResolvedValue({ status: 500, body: { code: "internal" } }),
    sessionTurnHistory: vi.fn().mockResolvedValue({ status: 200, body: { schemaVersion: "turn-history.v1", conversationId: "x", positionId: "repo-owner", turns: [] } }),
    sseStatus: vi.fn().mockResolvedValue("connected"),
    onEvent: vi.fn().mockReturnValue(noop),
    onSseStatus: vi.fn().mockReturnValue(noop),
    onFallbackNotice: vi.fn().mockReturnValue(noop),
  } as unknown as OwbBridge;
  Object.defineProperty(window, "owb", { configurable: true, value: bridge });
}

beforeEach(() => {
  installBridge();
  document.documentElement.setAttribute("data-theme", "light");
});

describe("platform window chrome", () => {
  it("keeps a Windows shell native when its backend is WSL and the browser hint differs", () => {
    window.owb.windowChrome = { platform: "win32", nativeControls: true };
    vi.mocked(window.owb.status).mockResolvedValue({ running: true, runtime: { mode: "wsl", distro: "Ubuntu-22.04" } });
    const { container } = render(<App />);
    expect(container.querySelector('.owb-wintitle[data-window-platform="win32"]')).toHaveClass("owb-wintitle--native-windows");
    expect(container.querySelector(".owb-wintitle__controls")).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭窗口" })).not.toBeInTheDocument();
    expect(resolveWindowChrome(window.owb, "MacIntel", "Macintosh")).toEqual({ platform: "win32", nativeControls: true });
  });

  it("keeps Mac actions on the left and forwards their real window operations", () => {
    const close = vi.fn().mockResolvedValue({ ok: true });
    const minimize = vi.fn().mockResolvedValue({ ok: true });
    const maximize = vi.fn().mockResolvedValue({ ok: true });
    Object.assign(window.owb, { windowClose: close, windowMinimize: minimize, windowToggleMaximize: maximize });
    const { container } = render(<WindowTitleBar />);
    expect(container.querySelector(".owb-wintitle__content")?.firstElementChild).toHaveClass("owb-wintitle__controls--mac");
    fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "最小化窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "最大化或还原窗口" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(minimize).toHaveBeenCalledTimes(1);
    expect(maximize).toHaveBeenCalledTimes(1);
  });

  it("uses right-side caption actions for an older Windows bridge and does not double-toggle", () => {
    window.owb.windowChrome = { platform: "win32", nativeControls: false };
    const maximize = vi.fn().mockResolvedValue({ ok: true });
    window.owb.windowToggleMaximize = maximize;
    const { container } = render(<WindowTitleBar />);
    const controls = container.querySelector(".owb-wintitle__controls");
    expect(container.querySelector(".owb-wintitle__content")?.lastElementChild).toBe(controls);
    expect(controls).toHaveClass("owb-wintitle__controls--standard");
    expect([...controls!.querySelectorAll("button")].map(button => button.getAttribute("aria-label"))).toEqual([
      "最小化窗口", "最大化或还原窗口", "关闭窗口",
    ]);
    fireEvent.doubleClick(screen.getByRole("button", { name: "最大化或还原窗口" }));
    expect(maximize).not.toHaveBeenCalled();
    fireEvent.doubleClick(container.querySelector(".owb-wintitle")!);
    expect(maximize).toHaveBeenCalledTimes(1);
  });

  it("detects older browser shells without claiming native controls", () => {
    expect(resolveWindowChrome(undefined, "Win32", "Windows NT 10.0")).toEqual({ platform: "win32", nativeControls: false });
    expect(resolveWindowChrome(undefined, "MacIntel", "Macintosh")).toEqual({ platform: "darwin", nativeControls: false });
    expect(resolveWindowChrome(undefined, "Linux x86_64", "X11")).toEqual({ platform: "linux", nativeControls: false });
  });

  it("updates native Windows colors from the painted theme and stops after unmount", async () => {
    window.owb.windowChrome = { platform: "win32", nativeControls: true };
    const setColors = vi.fn().mockResolvedValue({ ok: true });
    window.owb.setWindowChromeColors = setColors;
    let background = "rgb(17, 34, 51)";
    const computed = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
      backgroundColor: background,
      color: element.classList.contains("owb-wintitle__name") ? "rgb(238, 221, 204)" : "rgb(0, 0, 0)",
    }) as CSSStyleDeclaration);
    const view = render(<WindowTitleBar />);
    expect(setColors).toHaveBeenLastCalledWith({ color: "#112233", symbolColor: "#eeddcc" });
    background = "rgb(34, 51, 68)";
    document.documentElement.setAttribute("data-theme", "dark");
    await waitFor(() => expect(setColors).toHaveBeenLastCalledWith({ color: "#223344", symbolColor: "#eeddcc" }));
    const calls = setColors.mock.calls.length;
    view.unmount();
    document.documentElement.setAttribute("data-theme", "light");
    await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
    expect(setColors).toHaveBeenCalledTimes(calls);
    computed.mockRestore();
  });

  it("preserves transparent and translucent theme colors in the native overlay", async () => {
    window.owb.windowChrome = { platform: "win32", nativeControls: true };
    const setColors = vi.fn().mockResolvedValue({ ok: true });
    window.owb.setWindowChromeColors = setColors;
    let background = "rgba(17, 34, 51, 0.5)";
    const computed = vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({
      backgroundColor: background, color: "rgba(238, 221, 204, 0.25)",
    }) as CSSStyleDeclaration);
    const view = render(<WindowTitleBar />);
    expect(setColors).toHaveBeenLastCalledWith({ color: "#11223380", symbolColor: "#eeddcc40" });
    background = "transparent";
    document.documentElement.setAttribute("data-theme", "dark");
    await waitFor(() => expect(setColors).toHaveBeenLastCalledWith({ color: "#00000000", symbolColor: "#eeddcc40" }));
    view.unmount();
    computed.mockRestore();
  });
});

/** #248 小 UI 单：左上 chrome 重做。
 * ① 品牌标 .owb-wintitle__mark 已移除，只余三个窗口控制钮；
 * ② 三钮常显彩色圆底（close/min/max 变体 class 在位），aria-label/title 接线保留。 */
describe("wintitle window controls (#248)", () => {
  it("drops the brand mark and keeps only the three window buttons", () => {
    const { container } = render(<App />);

    expect(container.querySelector(".owb-wintitle__mark")).toBeNull();

    const controls = container.querySelector(".owb-wintitle__controls");
    expect(controls).not.toBeNull();
    expect(controls?.querySelector(".owb-wctl--close")).not.toBeNull();
    expect(controls?.querySelector(".owb-wctl--min")).not.toBeNull();
    expect(controls?.querySelector(".owb-wctl--max")).not.toBeNull();
    expect(controls?.querySelectorAll("button")).toHaveLength(3);
  });

  it("keeps the accessible names and titles for close/min/fullscreen", () => {
    render(<App />);

    const close = screen.getByRole("button", { name: "关闭窗口" });
    const min = screen.getByRole("button", { name: "最小化窗口" });
    const max = screen.getByRole("button", { name: "最大化或还原窗口" });

    expect(close).toHaveAttribute("title", "关闭");
    expect(min).toHaveAttribute("title", "最小化");
    expect(max).toHaveAttribute("title", "最大化 / 还原");

    expect(close).toHaveClass("owb-wctl--close");
    expect(min).toHaveClass("owb-wctl--min");
    expect(max).toHaveClass("owb-wctl--max");
  });
});
