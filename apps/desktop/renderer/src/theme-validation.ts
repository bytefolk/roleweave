import { COLOR_TOKEN_KEYS, type ColorTokenKey, type ColorTokenValues } from "./theme-config";

/** Validation reports catalog keys, never prose: this file lives under
 * renderer/src, which the #146 CJK gate covers, and the panel owns the locale. */
export interface ThemeValidationIssue { key: string; vars?: Record<string, string>; }
export interface ValidationResult { valid: boolean; errors: ThemeValidationIssue[]; warnings: ThemeValidationIssue[]; }
export interface ContrastWarning { foreground: ColorTokenKey; background: ColorTokenKey; ratio: number; required: number; level: "AA" | "AAA"; size: "normal" | "large"; }

export function isValidColorValue(value: string): boolean {
  const trimmed = value.trim();
  if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) return true;
  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/.test(trimmed)) return true;
  if (/^hsla?\(\s*\d+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(,\s*[\d.]+\s*)?\)$/.test(trimmed)) return true;
  return ["transparent", "currentcolor", "inherit", "initial", "unset"].includes(trimmed.toLowerCase());
}

export function validateThemeConfig(config: unknown): ValidationResult {
  const errors: ThemeValidationIssue[] = [];
  const warnings: ThemeValidationIssue[] = [];
  if (typeof config !== "object" || config === null) {
    errors.push({ key: "theme.validation.notObject" });
    return { valid: false, errors, warnings };
  }
  const obj = config as Record<string, unknown>;
  for (const mode of ["light", "dark"] as const) {
    if (typeof obj[mode] !== "object" || obj[mode] === null) {
      errors.push({ key: "theme.validation.missingMode", vars: { mode } });
      continue;
    }
    const modeConfig = obj[mode] as Record<string, unknown>;
    for (const key of COLOR_TOKEN_KEYS) {
      const value = modeConfig[key];
      if (typeof value !== "string") errors.push({ key: "theme.validation.notString", vars: { mode, key } });
      else if (!isValidColorValue(value)) errors.push({ key: "theme.validation.invalidColor", vars: { mode, key, value } });
    }
    for (const key of Object.keys(modeConfig)) {
      if (!COLOR_TOKEN_KEYS.includes(key as ColorTokenKey)) warnings.push({ key: "theme.validation.unknownKey", vars: { mode, key } });
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

/** Parses every value `isValidColorValue` accepts, so a colour that passes
 * validation cannot silently skip its contrast check. `#RGBA` used to be accepted
 * by the validator and rejected here, which made the check a no-op. */
function hexToRgb(color: string): { r: number; g: number; b: number } | null {
  const value = color.trim();
  const functional = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(value);
  if (functional) {
    const r = Number(functional[1]);
    const g = Number(functional[2]);
    const b = Number(functional[3]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
    return { r, g, b };
  }
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(value)?.[1];
  if (!hex) return null;
  const expand = (c: string) => parseInt(c + c, 16);
  if (hex.length === 3 || hex.length === 4) {
    return { r: expand(hex.charAt(0)), g: expand(hex.charAt(1)), b: expand(hex.charAt(2)) };
  }
  if (hex.length === 6 || hex.length === 8) {
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  }
  return null;
}

function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (component: number): number => {
    const s = component / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
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
