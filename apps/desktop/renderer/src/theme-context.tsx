import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { type ColorTokenValues, type ThemeConfig, type ThemeMode, cloneThemeConfig, DEFAULT_THEME } from "./theme-config";
import { DEFAULT_PRESET_ID, getPresetById } from "./theme-presets";
import { readStoredPresetId, readStoredTheme, writeStoredPresetId, writeStoredTheme, clearAllThemeStorage } from "./theme-storage";
import { resolveEffectiveTheme, applyThemeToDom, clearThemeOverrides, type CustomThemeOverrides } from "./theme-resolution";

interface ThemeContextValue {
  mode: ThemeMode; presetId: string; custom: CustomThemeOverrides | null; effective: ColorTokenValues;
  /** Resolved palette for an arbitrary mode. `effective` only covers the *active*
   * mode, so editing the dark palette while the app is in light would otherwise
   * display light values as the starting point. */
  forMode: (mode: ThemeMode) => ColorTokenValues;
  setPreset: (presetId: string) => void; setCustom: (custom: CustomThemeOverrides | null) => void;
  updateCustomColor: (mode: ThemeMode, key: string, value: string) => void;
  reset: () => void; save: () => void; isDirty: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
  const [presetId, setPresetId] = useState(() => readStoredPresetId());
  const [savedCustom, setSavedCustom] = useState<CustomThemeOverrides | null>(() => readStoredTheme());
  const [pendingCustom, setPendingCustom] = useState<CustomThemeOverrides | null>(null);
  const custom = pendingCustom ?? savedCustom;
  const isDirty = pendingCustom !== null;

  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === "data-theme") {
          const attr = document.documentElement.getAttribute("data-theme");
          setMode(attr === "dark" ? "dark" : "light");
        }
      }
    });
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);

  const effective = useMemo(() => resolveEffectiveTheme(mode, presetId, custom), [mode, presetId, custom]);
  const forMode = useCallback((target: ThemeMode) => resolveEffectiveTheme(target, presetId, custom), [presetId, custom]);

  // The palette is only injected once the user actually departs from the shipped
  // defaults. While `custom` is empty and the default preset is selected, the
  // design-system profile keeps sole ownership of the semantic colours, so an
  // untouched install renders exactly what it rendered before this PR.
  const paletteActive = custom !== null || presetId !== DEFAULT_PRESET_ID;

  useEffect(() => {
    if (paletteActive) applyThemeToDom(effective);
    else clearThemeOverrides();
  }, [effective, paletteActive]);

  const setPreset = useCallback((newPresetId: string) => {
    if (!getPresetById(newPresetId)) return;
    setPresetId(newPresetId); writeStoredPresetId(newPresetId);
    setSavedCustom(null); setPendingCustom(null);
  }, []);

  const setCustom = useCallback((newCustom: CustomThemeOverrides | null) => { setPendingCustom(newCustom); }, []);

  const updateCustomColor = useCallback((colorMode: ThemeMode, key: string, value: string) => {
    setPendingCustom((prev) => {
      const next = prev ? cloneThemeConfig({ light: { ...DEFAULT_THEME.light, ...prev.light }, dark: { ...DEFAULT_THEME.dark, ...prev.dark } }) : cloneThemeConfig(getPresetById(presetId)?.theme ?? DEFAULT_THEME);
      if (colorMode === "light") next.light[key as keyof typeof next.light] = value;
      else next.dark[key as keyof typeof next.dark] = value;
      return { light: next.light, dark: next.dark };
    });
  }, [presetId]);

  const reset = useCallback(() => {
    setPendingCustom(null); setSavedCustom(null); clearAllThemeStorage(); setPresetId(DEFAULT_PRESET_ID);
  }, []);

  const save = useCallback(() => {
    if (pendingCustom) {
      // Persist a *complete* config, never the override set. `CustomThemeOverrides`
      // legitimately covers a single mode (the Agent path only fills the mode it
      // generated), while `readStoredTheme` rejects anything that is not a full
      // ThemeConfig — so saving the overrides verbatim dropped the theme again on
      // the next start with no visible error.
      const complete: ThemeConfig = {
        light: resolveEffectiveTheme("light", presetId, pendingCustom),
        dark: resolveEffectiveTheme("dark", presetId, pendingCustom),
      };
      writeStoredTheme(complete);
      setSavedCustom(complete);
    }
    setPendingCustom(null);
  }, [pendingCustom, presetId]);

  const value = useMemo<ThemeContextValue>(() => ({
    mode, presetId, custom, effective, forMode, setPreset, setCustom, updateCustomColor, reset, save, isDirty,
  }), [mode, presetId, custom, effective, forMode, setPreset, setCustom, updateCustomColor, reset, save, isDirty]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
