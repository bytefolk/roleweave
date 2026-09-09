/**
 * #134 settings surface + update pane.
 *
 * AC-002: every one of the service's eight states renders distinctly, driven
 * through the bridge rather than asserted on markup.
 * AC-004: on a platform with no channel the action is disabled with a stated
 * reason, and is not merely hidden.
 * AC-007: the unsigned refusal renders. It is a download/install return value,
 * not a state, so a state-by-state pass would miss it.
 * AC-008: copy follows a locale switch, including a status read before it.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OwbI18nProvider } from "@roleweave/ui";
import type { UpdateEvent, UpdateResult, UpdateStatus } from "@roleweave/shared";
import { SettingsModule } from "../src/settings/SettingsModule";
import { stateMessage, updateAffordances } from "../src/settings/update-copy";

const windowsUnsigned: UpdateStatus = {
  version: "0.1.0",
  state: "idle",
  available: true,
  requiresConfirmation: true,
  signed: false,
  updateVerified: false,
  reason: "this build is unsigned, so a downloaded update could not be verified",
  platform: "win32",
};

const macUnavailable: UpdateStatus = {
  version: "0.1.0",
  state: "unavailable",
  available: false,
  requiresConfirmation: false,
  signed: false,
  updateVerified: false,
  reason: "In-app update needs a Developer ID signed build. Tracked in #135.",
  platform: "darwin",
};

const windowsSigned: UpdateStatus = { ...windowsUnsigned, signed: true, updateVerified: true, reason: null };

function result(overrides: Partial<UpdateResult> = {}): UpdateResult {
  return {
    state: "idle",
    reason: null,
    version: null,
    percent: null,
    unsigned: false,
    installing: false,
    ...overrides,
  };
}

/** Installs the bridge and hands back the state listener the pane registered,
 * so a test can push live events the way the main process does. */
function installBridge(status: UpdateStatus | null, results: Partial<UpdateResult>[] = []) {
  const listeners: Array<(event: UpdateEvent) => void> = [];
  const queue = [...results];
  const next = () => result(queue.shift() ?? {});
  const bridge = {
    update: {
      status: vi.fn().mockResolvedValue(status),
      check: vi.fn().mockImplementation(async () => next()),
      download: vi.fn().mockImplementation(async () => next()),
      install: vi.fn().mockImplementation(async () => next()),
      openReleaseNotes: vi.fn().mockResolvedValue({ ok: true }),
    },
    onUpdateState: vi.fn().mockImplementation((callback: (event: UpdateEvent) => void) => {
      listeners.push(callback);
      return () => undefined;
    }),
  };
  Object.defineProperty(window, "owb", { configurable: true, value: bridge });
  return {
    bridge,
    push(event: Partial<UpdateEvent> & { state: UpdateEvent["state"] }) {
      const full: UpdateEvent = { reason: null, version: null, percent: null, ...event };
      for (const listener of listeners) listener(full);
    },
  };
}

describe("#134 更新面板：八个状态", () => {
  const cases: Array<[UpdateEvent["state"], Partial<UpdateEvent>, string | RegExp]> = [
    // 省略号在目录里是转义字符，用正则避免把断言绑在标点上。
    ["checking", {}, /正在检查更新/],
    ["current", {}, "已是最新版本。"],
    ["available", { version: "0.2.0" }, "有新版本 0.2.0。"],
    ["downloading", { percent: 37 }, "正在下载 37%"],
    ["downloaded", { version: "0.2.0" }, "已下载 0.2.0，重启后安装。"],
    ["error", { reason: "getaddrinfo ENOTFOUND github.com" }, "检查更新失败。"],
    ["unavailable", {}, "此平台不提供应用内更新。"],
  ];

  for (const [state, detail, expected] of cases) {
    it(`渲染 ${state}`, async () => {
      const harness = installBridge(windowsSigned);
      render(<SettingsModule />);
      await screen.findByText("0.1.0");

      harness.push({ state, ...detail });
      expect(await screen.findByText(expected)).toBeInTheDocument();
    });
  }

  it("渲染 idle：状态是尚未检查，不是空白", async () => {
    installBridge(windowsSigned);
    render(<SettingsModule />);
    expect(await screen.findByText("尚未检查。")).toBeInTheDocument();
  });

  it("没有版本号时不渲染 null 版本", async () => {
    const harness = installBridge(windowsSigned);
    render(<SettingsModule />);
    await screen.findByText("0.1.0");

    harness.push({ state: "available" });
    expect(await screen.findByText("有可用的新版本。")).toBeInTheDocument();
    expect(screen.queryByText(/null/)).toBeNull();
  });
});

describe("#134 AC-007 未签名拒绝", () => {
  it("未签名构建上，下载与安装从一开始就不可点，并说明原因", async () => {
    installBridge(windowsUnsigned);
    render(<SettingsModule />);

    expect(await screen.findByText("此构建未开启应用内更新")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /下载更新/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /安装并重启/ })).toBeDisabled();
    // 检查仍然开放：知道有新版本本身是有用的。
    expect(screen.getByRole("button", { name: /检查更新/ })).toBeEnabled();
  });

  it("服务返回的 unsigned 拒绝会渲染出来，而不是被吞掉", async () => {
    // 这条走的是返回值而不是状态：state 原地不动，只多了 unsigned 标记。
    const harness = installBridge(windowsSigned, [
      { state: "available", version: "0.2.0", unsigned: true, reason: "Updates are download-only once this build is signed." },
    ]);
    render(<SettingsModule />);
    await screen.findByText("0.1.0");

    fireEvent.click(screen.getByRole("button", { name: /检查更新/ }));

    await waitFor(() => {
      expect(screen.getByText("此构建未开启应用内更新")).toBeInTheDocument();
    });
    // 状态行仍然如实显示有新版本，拒绝的是应用它。
    expect(screen.getByText("有新版本 0.2.0。")).toBeInTheDocument();
    expect(harness.bridge.update.check).toHaveBeenCalledTimes(1);
  });
});

describe("#134 AC-004 平台无通道", () => {
  it("macOS 上按钮是停用而不是隐藏，并给出原因", async () => {
    installBridge(macUnavailable);
    render(<SettingsModule />);

    const check = await screen.findByRole("button", { name: /检查更新/ });
    // 关键是"停用"而不是"不存在"：藏起来等于不解释。
    expect(check).toBeInTheDocument();
    expect(check).toBeDisabled();
    // 只展示用户能读的原因，不把更新服务内部诊断文本带进界面。
    expect(screen.getByText(/Developer ID 签名构建/)).toBeInTheDocument();
    expect(screen.queryByText(/Developer ID signed build/)).not.toBeInTheDocument();
    expect(screen.queryByText(/#135/)).not.toBeInTheDocument();
  });

  it("读不到状态时说读不到，不假装是最新版", async () => {
    installBridge(null);
    render(<SettingsModule />);

    expect(await screen.findByText("无法读取更新状态。")).toBeInTheDocument();
    expect(screen.queryByText("已是最新版本。")).toBeNull();
    expect(screen.getByRole("button", { name: /检查更新/ })).toBeDisabled();
  });
});

describe("#134 AC-005 确认与边界", () => {
  it("下载与安装都显式带上用户确认", async () => {
    const harness = installBridge(windowsSigned, [
      { state: "available", version: "0.2.0" },
      { state: "downloaded", version: "0.2.0" },
    ]);
    render(<SettingsModule />);
    await screen.findByText("0.1.0");

    harness.push({ state: "available", version: "0.2.0" });
    fireEvent.click(await screen.findByRole("button", { name: /下载更新/ }));
    await waitFor(() => {
      expect(harness.bridge.update.download).toHaveBeenCalledWith({ confirmedByUser: true });
    });

    harness.push({ state: "downloaded", version: "0.2.0" });
    fireEvent.click(await screen.findByRole("button", { name: /安装并重启/ }));
    await waitFor(() => {
      expect(harness.bridge.update.install).toHaveBeenCalledWith({ confirmedByUser: true });
    });
  });

  it("更新日志入口不接受渲染层传入的地址", async () => {
    const harness = installBridge(windowsSigned);
    render(<SettingsModule />);

    fireEvent.click(await screen.findByRole("button", { name: /更新日志/ }));
    await waitFor(() => {
      expect(harness.bridge.update.openReleaseNotes).toHaveBeenCalledWith();
    });
  });
});

describe("#134 AC-008 文案跟随语言", () => {
  it("切到英文后，之前读到的状态也跟着换语言", async () => {
    const harness = installBridge(windowsUnsigned);
    const view = render(
      <OwbI18nProvider locale="zh-CN">
        <SettingsModule />
      </OwbI18nProvider>,
    );
    await screen.findByText("0.1.0");
    harness.push({ state: "available", version: "0.2.0" });
    expect(await screen.findByText("有新版本 0.2.0。")).toBeInTheDocument();

    view.rerender(
      <OwbI18nProvider locale="en">
        <SettingsModule />
      </OwbI18nProvider>,
    );

    // #179 的教训：存已解析字符串会把上一个语言留在屏幕上。
    expect(await screen.findByText("Version 0.2.0 is available.")).toBeInTheDocument();
    expect(screen.queryByText("有新版本 0.2.0。")).toBeNull();
    expect(screen.getByText("In-app update is off for this build")).toBeInTheDocument();
  });
});

describe("#134 纯映射", () => {
  it("每个状态映射到不同的文案 key", () => {
    const keys = (["idle", "unavailable", "checking", "current", "available", "downloading", "downloaded", "error"] as const)
      .map((state) => stateMessage({ state, version: "0.2.0", percent: 5 }).key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("下载与安装在未签名时关闭，检查不关闭", () => {
    const unsigned = updateAffordances(windowsUnsigned, "available");
    expect(unsigned.canCheck).toBe(true);
    expect(unsigned.canDownload).toBe(false);
    expect(unsigned.showUnsignedRefusal).toBe(true);

    const signed = updateAffordances(windowsSigned, "available");
    expect(signed.canDownload).toBe(true);
    expect(signed.showUnsignedRefusal).toBe(false);
    expect(updateAffordances(windowsSigned, "downloaded").canInstall).toBe(true);
    // 正在检查或下载时不给第二次点击的机会。
    expect(updateAffordances(windowsSigned, "checking").canCheck).toBe(false);
    expect(updateAffordances(windowsSigned, "downloading").canCheck).toBe(false);
  });
});
