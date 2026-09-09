import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  OWB_LOCALES,
  OwbI18nProvider,
  enCatalog,
  isOwbLocale,
  useT,
  zhCatalog,
} from "@roleweave/ui";
import { PrefsMenu } from "../src/prefs-menu";
import { seedLocale } from "../src/locale-mode";
import { useState } from "react";

describe("#146 i18n gates", () => {
  it("exposes exactly two locales, in UI order, and validates strictly", () => {
    expect(OWB_LOCALES).toEqual(["zh-CN", "en"]);
    expect(isOwbLocale("zh-CN")).toBe(true);
    expect(isOwbLocale("en")).toBe(true);
    expect(isOwbLocale("fr")).toBe(false);
    expect(isOwbLocale(null)).toBe(false);
    expect(isOwbLocale("zh")).toBe(false);
  });

  it("zh and en catalogs have identical key sets (no drift either way)", () => {
    const zhKeys = Object.keys(zhCatalog).sort();
    const enKeys = Object.keys(enCatalog).sort();
    expect(enKeys).toEqual(zhKeys);
    // 空串不算翻译
    for (const key of zhKeys) {
      expect(zhCatalog[key].length, `zh ${key}`).toBeGreaterThan(0);
      expect(enCatalog[key].length, `en ${key}`).toBeGreaterThan(0);
    }
  });

  it("interpolates {vars} and falls back to zh then key without crashing", () => {
    function Probe() {
      const t = useT();
      return (
        <div>
          <span data-testid="var">{t("tree.positions", { count: 5 })}</span>
          <span data-testid="missing">{t("definitely.not.a.key")}</span>
        </div>
      );
    }
    const en = render(
      <OwbI18nProvider locale="en">
        <Probe />
      </OwbI18nProvider>,
    );
    expect(en.getByTestId("var").textContent).toContain("5");
    expect(en.getByTestId("missing").textContent).toBe("definitely.not.a.key");
    en.unmount();

    const zh = render(
      <OwbI18nProvider locale="zh-CN">
        <Probe />
      </OwbI18nProvider>,
    );
    expect(zh.getByTestId("var").textContent).toBe("5 岗位");
    zh.unmount();
  });

  it("prefs drawer language row flips exactly between the two locales", () => {
    function Harness() {
      const [locale, setLocale] = useState<"zh-CN" | "en">("zh-CN");
      return (
        <OwbI18nProvider locale={locale}>
          <PrefsMenu locale={locale} onChangeLocale={setLocale} mode="dark" />
        </OwbI18nProvider>
      );
    }
    const { container } = render(<Harness />);
    const trigger = container.querySelector("button") as HTMLButtonElement;
    expect(trigger.getAttribute("aria-label")).toBe("偏好设置");
    fireEvent.click(trigger);
    const rows = () => Array.from(container.querySelectorAll("[role=menuitem]")) as HTMLButtonElement[];
    // 中文界面：语言行显示当前值「中文」
    expect(rows()[0].textContent).toContain("语言");
    expect(rows()[0].textContent).toContain("中文");
    fireEvent.click(rows()[0]);
    // 切到英文后目录整体换面，语言行显示 English
    const after = rows();
    expect(after[0].textContent).toContain("Language");
    expect(after[0].textContent).toContain("English");
    fireEvent.click(after[0]);
    expect(rows()[0].textContent).toContain("中文");
  });

  it("seedLocale ignores untrusted stored values", () => {
    // 本 jsdom 环境只暴露 Storage 构造器、window.localStorage 为 undefined；
    // 真实 Electron renderer 有 localStorage。这里装一个内存 stub 测信任边界。
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    });
    try {
      store.set("owb-locale", "fr");
      expect(seedLocale()).toBe("zh-CN");
      store.set("owb-locale", "en");
      expect(seedLocale()).toBe("en");
      store.set("owb-locale", "zh-CN");
      expect(seedLocale()).toBe("zh-CN");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rail labels render from the catalog in both locales", () => {
    function RailLabels() {
      const t = useT();
      return <div>{["rail.org", "rail.groups", "rail.reports", "rail.approvals", "rail.docs"].map((k) => <span key={k}>{t(k)}</span>)}</div>;
    }
    const zh = render(<OwbI18nProvider locale="zh-CN"><RailLabels /></OwbI18nProvider>);
    expect(zh.container.textContent).toBe("组织群聊上报审批文档");
    zh.unmount();
    const en = render(<OwbI18nProvider locale="en"><RailLabels /></OwbI18nProvider>);
    expect(en.container.textContent).toBe("OrganizationGroupsReportsApprovalsDocs");
    en.unmount();
  });
});
