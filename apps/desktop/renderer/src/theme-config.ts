/**
 * 语义颜色 token 类型定义和默认主题。
 * 所有 --ui-* 颜色键的白名单，确保 Agent 输出和用户自定义都在安全边界内。
 */

export type ThemeMode = "light" | "dark";

export const COLOR_TOKEN_KEYS = [
  "canvas", "canvas-subtle", "navigation", "navigation-hover",
  "surface", "surface-raised", "surface-inset",
  "foreground", "foreground-muted", "foreground-subtle",
  "border", "border-strong",
  "primary", "primary-hover", "primary-foreground", "primary-soft",
  "brand", "brand-soft", "brand-blue",
  "ai", "ai-strong", "ai-hover", "ai-foreground", "ai-soft",
  "info", "info-soft",
  "success", "success-strong", "success-soft", "success-foreground",
  "warning", "warning-strong", "warning-soft", "warning-foreground",
  "danger", "danger-strong", "danger-soft", "danger-foreground",
  "overlay", "focus", "selection",
] as const;

export type ColorTokenKey = (typeof COLOR_TOKEN_KEYS)[number];
export type ColorTokenValues = Record<ColorTokenKey, string>;

export interface ThemeConfig {
  light: ColorTokenValues;
  dark: ColorTokenValues;
}

export const DEFAULT_THEME: ThemeConfig = {
  light: {
    canvas: "#f7f8fb", "canvas-subtle": "#f1f3f7", navigation: "#f1f3f7", "navigation-hover": "#e8ebf2",
    surface: "#ffffff", "surface-raised": "#ffffff", "surface-inset": "#f4f5f8",
    foreground: "#242630", "foreground-muted": "#596172", "foreground-subtle": "#606a7b",
    border: "#e2e5ed", "border-strong": "#c7cedb",
    primary: "#3e63dd", "primary-hover": "#3153c4", "primary-foreground": "#ffffff", "primary-soft": "#edf1ff",
    brand: "#732fd1", "brand-soft": "#f3edfc", "brand-blue": "#5179ff",
    ai: "#732fd1", "ai-strong": "#6124b8", "ai-hover": "#6124b8", "ai-foreground": "#ffffff", "ai-soft": "#f3edfc",
    info: "#3e63dd", "info-soft": "#edf1ff",
    success: "#2e7052", "success-strong": "#24573f", "success-soft": "#edf7f1", "success-foreground": "#ffffff",
    warning: "#8a5a12", "warning-strong": "#75480b", "warning-soft": "#fff5e4", "warning-foreground": "#ffffff",
    danger: "#b83d3d", "danger-strong": "#a22f36", "danger-soft": "#fff0f0", "danger-foreground": "#ffffff",
    overlay: "rgba(20, 21, 27, 0.35)", focus: "#732fd1", selection: "#f3edfc",
  },
  dark: {
    canvas: "#14151b", "canvas-subtle": "#181a20", navigation: "#181a20", "navigation-hover": "#252831",
    surface: "#1c1e25", "surface-raised": "#252831", "surface-inset": "#171920",
    foreground: "#e5e7ed", "foreground-muted": "#b1b7c5", "foreground-subtle": "#969eaf",
    border: "#343844", "border-strong": "#4b5262",
    primary: "#86a0ff", "primary-hover": "#a0b4ff", "primary-foreground": "#14151b", "primary-soft": "#252e49",
    brand: "#bb93f6", "brand-soft": "#30233f", "brand-blue": "#86a0ff",
    ai: "#bb93f6", "ai-strong": "#cdaeff", "ai-hover": "#cdaeff", "ai-foreground": "#1b1526", "ai-soft": "#30233f",
    info: "#86a0ff", "info-soft": "#252e49",
    success: "#84c7a3", "success-strong": "#a2dabb", "success-soft": "#20372c", "success-foreground": "#14151b",
    warning: "#ddb35d", "warning-strong": "#efcc86", "warning-soft": "#352e20", "warning-foreground": "#14151b",
    danger: "#ef9699", "danger-strong": "#ffb1b4", "danger-soft": "#3a242b", "danger-foreground": "#14151b",
    overlay: "rgba(0, 0, 0, 0.65)", focus: "#bb93f6", selection: "#30233f",
  },
};

export function isColorTokenKey(value: unknown): value is ColorTokenKey {
  return typeof value === "string" && COLOR_TOKEN_KEYS.includes(value as ColorTokenKey);
}

export function isThemeConfig(value: unknown): value is ThemeConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Record<string, unknown>;
  if (typeof config.light !== "object" || config.light === null) return false;
  if (typeof config.dark !== "object" || config.dark === null) return false;
  const light = config.light as Record<string, unknown>;
  const dark = config.dark as Record<string, unknown>;
  for (const key of COLOR_TOKEN_KEYS) {
    if (typeof light[key] !== "string" || typeof dark[key] !== "string") return false;
  }
  return true;
}

export function cloneThemeConfig(config: ThemeConfig): ThemeConfig {
  return { light: { ...config.light }, dark: { ...config.dark } };
}
