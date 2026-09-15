import { COLOR_TOKEN_KEYS, isThemeConfig, type ThemeConfig } from "./theme-config";
import { isValidColorValue } from "./theme-validation";
import { DEFAULT_PRESET_ID } from "./theme-presets";

const THEME_CONFIG_KEY = "owb.theme-config";
const PRESET_ID_KEY = "owb.theme-preset-id";

export function readStoredTheme(): ThemeConfig | null {
  try {
    const raw = window.localStorage.getItem(THEME_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isThemeConfig(parsed)) return null;
    // `isThemeConfig` only proves the shape. Anything that survives a hand-edited
    // localStorage entry would otherwise be injected straight into a <style> tag
    // and into AntD's token layer.
    const config = parsed as ThemeConfig;
    for (const mode of ["light", "dark"] as const) {
      for (const key of COLOR_TOKEN_KEYS) {
        if (!isValidColorValue(config[mode][key])) return null;
      }
    }
    return config;
  } catch { return null; }
}

export function writeStoredTheme(config: ThemeConfig): void {
  try { window.localStorage.setItem(THEME_CONFIG_KEY, JSON.stringify(config)); } catch {}
}

export function clearStoredTheme(): void {
  try { window.localStorage.removeItem(THEME_CONFIG_KEY); } catch {}
}

export function readStoredPresetId(): string {
  try { return window.localStorage.getItem(PRESET_ID_KEY) || DEFAULT_PRESET_ID; } catch { return DEFAULT_PRESET_ID; }
}

export function writeStoredPresetId(presetId: string): void {
  try { window.localStorage.setItem(PRESET_ID_KEY, presetId); } catch {}
}

export function clearAllThemeStorage(): void {
  clearStoredTheme();
  try { window.localStorage.removeItem(PRESET_ID_KEY); } catch {}
}
