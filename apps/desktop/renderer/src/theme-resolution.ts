import { type ColorTokenKey, type ColorTokenValues, type ThemeMode, cloneThemeConfig, DEFAULT_THEME } from "./theme-config";
import { getPresetById } from "./theme-presets";

export type CustomThemeOverrides = { light?: Partial<ColorTokenValues>; dark?: Partial<ColorTokenValues>; };

export function resolveEffectiveTheme(mode: ThemeMode, presetId: string, custom: CustomThemeOverrides | null): ColorTokenValues {
  const preset = getPresetById(presetId);
  const base = preset?.theme ?? DEFAULT_THEME;
  const result = cloneThemeConfig(base);
  if (custom) {
    if (custom.light) for (const [key, value] of Object.entries(custom.light)) if (value !== undefined && isColorTokenKey(key)) result.light[key] = value;
    if (custom.dark) for (const [key, value] of Object.entries(custom.dark)) if (value !== undefined && isColorTokenKey(key)) result.dark[key] = value;
  }
  return result[mode];
}

function isColorTokenKey(key: string): key is ColorTokenKey { return key in DEFAULT_THEME.light; }

export function themeToCssOverrides(theme: ColorTokenValues): string {
  return Object.entries(theme).map(([key, value]) => `  --ui-${key}: ${value};`).join("\n");
}

export function themeToAntdSeed(theme: ColorTokenValues, mode: ThemeMode): Record<string, string | number> {
  return {
    colorPrimary: theme.primary, colorPrimaryHover: theme["primary-hover"], colorPrimaryActive: theme["primary-hover"],
    colorPrimaryBg: theme["primary-soft"], colorPrimaryBgHover: theme["primary-soft"],
    colorPrimaryBorder: theme.border, colorPrimaryBorderHover: theme["border-strong"],
    colorSuccess: theme.success, colorSuccessHover: theme["success-strong"], colorSuccessActive: theme["success-strong"],
    colorSuccessBg: theme["success-soft"], colorSuccessBgHover: theme["success-soft"],
    colorSuccessBorder: theme.border, colorSuccessBorderHover: theme["border-strong"],
    colorWarning: theme.warning, colorWarningHover: theme["warning-strong"], colorWarningActive: theme["warning-strong"],
    colorWarningBg: theme["warning-soft"], colorWarningBgHover: theme["warning-soft"],
    colorWarningBorder: theme.border, colorWarningBorderHover: theme["border-strong"],
    colorError: theme.danger, colorErrorHover: theme["danger-strong"], colorErrorActive: theme["danger-strong"],
    colorErrorBg: theme["danger-soft"], colorErrorBgHover: theme["danger-soft"],
    colorErrorBorder: theme.border, colorErrorBorderHover: theme["border-strong"],
    colorErrorBgFilledHover: theme["danger-soft"], colorErrorBgActive: theme["danger-soft"],
    colorInfo: theme.info, colorInfoHover: theme["primary-hover"], colorInfoActive: theme["primary-hover"],
    colorInfoBg: theme["info-soft"], colorInfoBgHover: theme["info-soft"],
    colorInfoBorder: theme.border, colorInfoBorderHover: theme["border-strong"],
    colorLink: theme.primary, colorLinkHover: theme["primary-hover"], colorLinkActive: theme["primary-hover"],
    colorBorder: theme.border, colorBorderSecondary: theme.border,
    colorBgBase: theme.surface, colorBgContainer: theme.surface, colorBgElevated: theme["surface-raised"],
    colorBgLayout: theme.canvas, colorFillAlter: theme["surface-inset"],
    controlItemBgHover: theme["navigation-hover"], controlItemBgActive: theme.selection, controlItemBgActiveHover: theme.selection,
    colorText: theme.foreground, colorTextSecondary: theme["foreground-muted"], colorTextTertiary: theme["foreground-subtle"],
    colorTextPlaceholder: theme["foreground-subtle"], colorTextDisabled: theme["foreground-subtle"],
    colorBgContainerDisabled: theme["surface-inset"], colorTextLightSolid: theme["primary-foreground"],
    borderRadiusSM: 6, borderRadiusLG: 12, borderRadiusOuter: 16,
    // Elevation is not mode-neutral: reusing the light shadow pair in dark mode
    // flattened every popover and drawer into the background.
    boxShadow: mode === "dark" ? "0 6px 20px rgba(0, 0, 0, 0.45)" : "0 4px 16px rgba(20, 21, 27, 0.1)",
    boxShadowSecondary: mode === "dark" ? "0 20px 56px rgba(0, 0, 0, 0.55)" : "0 16px 48px rgba(20, 21, 27, 0.14)",
  };
}

/** Writes the resolved palette into a single `<style>` element.
 *
 * The selector is not incidental. The design system ships its palettes as
 * `[data-ui-theme='mint'][data-theme='light']` and
 * `:root[data-ui-theme='mint']:not([data-theme])` — specificity (0,2,0) and
 * (0,3,0). A plain `:root, [data-theme]` injection is only (0,1,0), so with the
 * default `mint` profile selected the user's colours lost the cascade and editing
 * the panel changed nothing. Matching the ordinary (0,2,0) shape and relying on
 * this element being appended last in `<head>` is what makes the palette win.
 *
 * The caller only calls this while a custom palette is actually in use, so an
 * untouched install keeps rendering exactly what #248 shipped. */
export function applyThemeToDom(theme: ColorTokenValues): void {
  const styleId = "roleweave-theme-overrides";
  let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!styleEl) { styleEl = document.createElement("style"); styleEl.id = styleId; document.head.appendChild(styleEl); }
  styleEl.textContent = `:root[data-theme], :root:not([data-theme]) {\n${themeToCssOverrides(theme)}\n}`;
}

/** Drops the runtime palette, returning the design-system profile to sole
 * ownership of the semantic colours. */
export function clearThemeOverrides(): void {
  document.getElementById("roleweave-theme-overrides")?.remove();
}
