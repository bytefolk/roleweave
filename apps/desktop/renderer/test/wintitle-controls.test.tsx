import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { OwbBridge } from "../src/owb";

/** Minimal bridge so <App /> mounts in jsdom (mirrors App.test installBridge). */
function installBridge(): void {
  const noop = () => undefined;
  const bridge = {
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
