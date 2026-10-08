import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  OWB_LOCALES,
  OwbI18nProvider,
  enCatalog,
  isOwbLocale,
  useT,
  zhCatalog,
} from "@roleweave/ui";
import { seedLocale } from "../src/locale-mode";

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

  it("updates translated content when the locale changes", () => {
    function LanguageControl() {
      const t = useT();
      return <span>{t("prefs.language")}</span>;
    }
    const view = render(<OwbI18nProvider locale="zh-CN"><LanguageControl /></OwbI18nProvider>);
    expect(view.getByText("语言")).toBeInTheDocument();
    view.rerender(<OwbI18nProvider locale="en"><LanguageControl /></OwbI18nProvider>);
    expect(view.getByText("Language")).toBeInTheDocument();
    view.rerender(<OwbI18nProvider locale="zh-CN"><LanguageControl /></OwbI18nProvider>);
    expect(view.getByText("语言")).toBeInTheDocument();
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

  it("context rail and footer labels render from the catalog in both locales", () => {
    function RailLabels() {
      const t = useT();
      return <div>{["rail.collaboration", "rail.org", "rail.projects", "rail.inbox", "rail.settings"].map((k) => <span key={k}>{t(k)}</span>)}</div>;
    }
    const zh = render(<OwbI18nProvider locale="zh-CN"><RailLabels /></OwbI18nProvider>);
    expect(zh.container.textContent).toBe("协作组织项目收件箱设置");
    zh.unmount();
    const en = render(<OwbI18nProvider locale="en"><RailLabels /></OwbI18nProvider>);
    expect(en.container.textContent).toBe("CollaborateOrganizationProjectsInboxSettings");
    en.unmount();
  });

  it("keeps contextual navigation and feature labels translated in both locales", () => {
    const groups = [
      ["nav.collaboration", "nav.direct", "rail.groups"],
      ["nav.employee", "nav.conversation", "rail.memory", "nav.profile", "rail.docs"],
      ["nav.organization", "nav.structure", "nav.graph"],
      ["nav.projects", "project.moduleTitle", "rail.goals", "rail.progress"],
      ["nav.inbox", "rail.approvals", "rail.reports"],
    ];
    function ContextLabels() {
      const t = useT();
      return <div>{groups.map(keys => <div key={keys[0]} data-testid={keys[0]}>{keys.map(key => t(key)).join(" / ")}</div>)}</div>;
    }
    const zh = render(<OwbI18nProvider locale="zh-CN"><ContextLabels /></OwbI18nProvider>);
    expect(groups.map(keys => zh.getByTestId(keys[0]!).textContent)).toEqual([
      "协作方式 / 单聊 / 群聊", "员工视图 / 对话 / 资料与记忆 / 档案 / 文档", "组织视图 / 组织架构 / 关系图谱",
      "项目视图 / 项目管理 / 目标 / 进度", "收件箱视图 / 审批 / 上报",
    ]);
    zh.unmount();
    const en = render(<OwbI18nProvider locale="en"><ContextLabels /></OwbI18nProvider>);
    expect(groups.map(keys => en.getByTestId(keys[0]!).textContent)).toEqual([
      "Collaboration mode / Direct / Groups", "Employee views / Conversation / Resources & memory / Profile / Docs", "Organization views / Organization structure / Relationships",
      "Project views / Project management / Goals / Progress", "Inbox views / Approvals / Reports",
    ]);
    en.unmount();
  });
});
