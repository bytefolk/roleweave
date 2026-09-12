import { COLOR_TOKEN_KEYS, type ColorTokenKey, type ColorTokenValues } from "./theme-config";

export interface ValidationResult { valid: boolean; errors: string[]; warnings: string[]; }
export interface ContrastWarning { foreground: ColorTokenKey; background: ColorTokenKey; ratio: number; required: number; level: "AA" | "AAA"; size: "normal" | "large"; }

export function isValidColorValue(value: string): boolean {
  const trimmed = value.trim();
  if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) return true;
  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/.test(trimmed)) return true;
  if (/^hsla?\(\s*\d+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(,\s*[\d.]+\s*)?\)$/.test(trimmed)) return true;
  return ["transparent", "currentcolor", "inherit", "initial", "unset"].includes(trimmed.toLowerCase());
}

export function validateThemeConfig(config: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof config !== "object" || config === null) { errors.push("主题配置必须是对象"); return { valid: false, errors, warnings }; }
  const obj = config as Record<string, unknown>;
  for (const mode of ["light", "dark"] as const) {
    if (typeof obj[mode] !== "object" || obj[mode] === null) { errors.push(`缺少 ${mode} 模式配置`); continue; }
    const modeConfig = obj[mode] as Record<string, unknown>;
    for (const key of COLOR_TOKEN_KEYS) {
      const value = modeConfig[key];
      if (typeof value !== "string") errors.push(`${mode}.${key} 必须是字符串`);
      else if (!isValidColorValue(value)) errors.push(`${mode}.${key} 不是有效的颜色值: ${value}`);
    }
    for (const key of Object.keys(modeConfig)) {
      if (!COLOR_TOKEN_KEYS.includes(key as ColorTokenKey)) warnings.push(`${mode}.${key} 是未知键，将被忽略`);
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const trimmed = hex.replace("#", "");
  let r: number, g: number, b: number;
  if (trimmed.length === 3) { r = parseInt(trimmed[0] + trimmed[0], 16); g = parseInt(trimmed[1] + trimmed[1], 16); b = parseInt(trimmed[2] + trimmed[2], 16); }
  else if (trimmed.length === 6 || trimmed.length === 8) { r = parseInt(trimmed.slice(0, 2), 16); g = parseInt(trimmed.slice(2, 4), 16); b = parseInt(trimmed.slice(4, 6), 16); }
  else return null;
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return { r, g, b };
}

function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

export function contrastRatio(color1: string, color2: string): number | null {
  const rgb1 = hexToRgb(color1); const rgb2 = hexToRgb(color2);
  if (!rgb1 || !rgb2) return null;
  const l1 = relativeLuminance(rgb1.r, rgb1.g, rgb1.b); const l2 = relativeLuminance(rgb2.r, rgb2.g, rgb2.b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function getContrastWarnings(theme: ColorTokenValues): ContrastWarning[] {
  const warnings: ContrastWarning[] = [];
  const checks: Array<{ fg: ColorTokenKey; bg: ColorTokenKey; size: "normal" | "large" }> = [
    { fg: "foreground", bg: "canvas", size: "normal" }, { fg: "foreground", bg: "surface", size: "normal" },
    { fg: "foreground-muted", bg: "canvas", size: "normal" }, { fg: "foreground-muted", bg: "surface", size: "normal" },
    { fg: "primary-foreground", bg: "primary", size: "normal" }, { fg: "success-foreground", bg: "success", size: "normal" },
    { fg: "warning-foreground", bg: "warning", size: "normal" }, { fg: "danger-foreground", bg: "danger", size: "normal" },
  ];
  for (const check of checks) {
    const ratio = contrastRatio(theme[check.fg], theme[check.bg]);
    if (ratio === null) continue;
    const required = check.size === "normal" ? 4.5 : 3;
    if (ratio < required) warnings.push({ foreground: check.fg, background: check.bg, ratio: Math.round(ratio * 100) / 100, required, level: "AA", size: check.size });
  }
  return warnings;
}
