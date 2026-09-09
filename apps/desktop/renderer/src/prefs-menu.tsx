/** 右上角偏好抽屉：语言 / 主题两个入口收进一个浮层面板（参考钉钉偏好
 * 菜单形态）。账号、组织等条目等登录体系落地后再加，现在不摆空入口。
 * 触发钮复用 .owb-wintitle__theme 皮肤（含 -webkit-app-region: no-drag）。 */
import { useEffect, useRef, useState } from "react";
import { Languages, Palette, Settings2 } from "lucide-react";
import { useT, type OwbLocale } from "@roleweave/ui";
import { setThemeMode, type ThemeMode } from "./theme-mode";

export function PrefsMenu({
  locale,
  onChangeLocale,
  mode,
}: {
  locale: OwbLocale;
  onChangeLocale: (next: OwbLocale) => void;
  mode: ThemeMode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="owb-prefs" ref={rootRef}>
      <button
        type="button"
        className="owb-wintitle__theme"
        aria-label={t("prefs.trigger")}
        title={t("prefs.trigger")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Settings2 aria-hidden="true" size={14} strokeWidth={1.8} />
      </button>
      {open ? (
        <div className="owb-prefs__panel" role="menu" aria-label={t("prefs.trigger")}>
          <button
            type="button"
            role="menuitem"
            className="owb-prefs__item"
            onClick={() => onChangeLocale(locale === "zh-CN" ? "en" : "zh-CN")}
          >
            <Languages aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>{t("prefs.language")}</span>
            <span className="owb-prefs__value">
              {locale === "zh-CN" ? t("prefs.langZh") : t("prefs.langEn")}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="owb-prefs__item"
            aria-pressed={mode === "dark"}
            onClick={() => setThemeMode(mode === "dark" ? "light" : "dark")}
          >
            <Palette aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>{t("prefs.theme")}</span>
            <span className="owb-prefs__value">
              {mode === "dark" ? t("prefs.themeDark") : t("prefs.themeLight")}
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
