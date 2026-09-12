import { DEFAULT_THEME, type ThemeConfig } from "./theme-config";

export interface PresetDefinition {
  id: string;
  name: string;
  description: string;
  theme: ThemeConfig;
}

const ONE_DARK_THEME: ThemeConfig = {
  light: { ...DEFAULT_THEME.light, canvas: "#fafafa", "canvas-subtle": "#f5f5f5", surface: "#ffffff", primary: "#528bff", "primary-hover": "#4078f2", "primary-foreground": "#ffffff", "primary-soft": "#e8f0ff" },
  dark: {
    canvas: "#282c34", "canvas-subtle": "#21252b", navigation: "#21252b", "navigation-hover": "#2c313a",
    surface: "#282c34", "surface-raised": "#2c313a", "surface-inset": "#21252b",
    foreground: "#abb2bf", "foreground-muted": "#7f848e", "foreground-subtle": "#5c6370",
    border: "#3e4451", "border-strong": "#545862",
    primary: "#528bff", "primary-hover": "#4078f2", "primary-foreground": "#ffffff", "primary-soft": "#2c313a",
    brand: "#c678dd", "brand-soft": "#3e2c4a", "brand-blue": "#61afef",
    ai: "#c678dd", "ai-strong": "#d199e6", "ai-hover": "#d199e6", "ai-foreground": "#282c34", "ai-soft": "#3e2c4a",
    info: "#61afef", "info-soft": "#2c3a4a",
    success: "#98c379", "success-strong": "#a8d389", "success-soft": "#2c3a2c", "success-foreground": "#282c34",
    warning: "#e5c07b", "warning-strong": "#f0d08b", "warning-soft": "#3a342c", "warning-foreground": "#282c34",
    danger: "#e06c75", "danger-strong": "#f07c85", "danger-soft": "#3a2c2e", "danger-foreground": "#282c34",
    overlay: "rgba(0, 0, 0, 0.6)", focus: "#528bff", selection: "#3e4451",
  },
};

export const BUILT_IN_PRESETS: readonly PresetDefinition[] = [
  { id: "roleweave-default", name: "RoleWeave 默认", description: "RoleWeave 品牌标准配色，紫色主色调", theme: DEFAULT_THEME },
  { id: "one-dark", name: "One Dark", description: "Atom One Dark 风格，深灰背景 + 蓝色操作按钮", theme: ONE_DARK_THEME },
];

export const DEFAULT_PRESET_ID = "roleweave-default";

export function getPresetById(id: string): PresetDefinition | undefined {
  return BUILT_IN_PRESETS.find((p) => p.id === id);
}

export function getDefaultPreset(): PresetDefinition {
  return getPresetById(DEFAULT_PRESET_ID) ?? BUILT_IN_PRESETS[0];
}
