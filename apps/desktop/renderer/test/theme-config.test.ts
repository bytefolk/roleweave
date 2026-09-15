/**
 * #255 review follow-up. The reviewer could not run anything on this PR — no
 * check had ever fired and no test file was touched — so the parts of the theme
 * pipeline that are pure contract are pinned here instead: palette resolution,
 * the CSS layer the panel injects, the AntD projection, validation, the stubbed
 * agent, and persistence.
 *
 * The two regressions this file exists to prevent, both found in review:
 *  - `save()` persisted the partial override set, which `readStoredTheme`
 *    rejects, so a saved palette silently vanished on the next start;
 *  - `validateGeneratedTheme` always returned the light half, so dark-mode
 *    generation would have applied light values.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COLOR_TOKEN_KEYS,
  DEFAULT_THEME,
  cloneThemeConfig,
  isColorTokenKey,
  isThemeConfig,
  type ThemeConfig,
} from "../src/theme-config";
import { BUILT_IN_PRESETS, DEFAULT_PRESET_ID, getDefaultPreset, getPresetById } from "../src/theme-presets";
import { applyThemeToDom, clearThemeOverrides, resolveEffectiveTheme, themeToAntdSeed, themeToCssOverrides } from "../src/theme-resolution";
import { contrastRatio, getContrastWarnings, isValidColorValue, validateThemeConfig } from "../src/theme-validation";
import { validateGeneratedTheme } from "../src/theme-agent";
import { readStoredTheme, writeStoredTheme } from "../src/theme-storage";

const CSS_LAYER_ID = "roleweave-theme-overrides";

beforeEach(() => {
  window.localStorage.clear();
});

function injectedSelector(): string {
  const style = document.getElementById(CSS_LAYER_ID) as HTMLStyleElement | null;
  expect(style, "the override <style> was not injected").not.toBeNull();
  const text = style!.textContent ?? "";
  return text.slice(0, text.indexOf("{")).trim();
}

afterEach(() => {
  clearThemeOverrides();
});

describe("palette resolution", () => {
  it("uses the selected preset when there is no custom override", () => {
    expect(resolveEffectiveTheme("light", DEFAULT_PRESET_ID, null)).toEqual(DEFAULT_THEME.light);
    expect(resolveEffectiveTheme("dark", DEFAULT_PRESET_ID, null)).toEqual(DEFAULT_THEME.dark);
    expect(resolveEffectiveTheme("dark", "one-dark", null).canvas).toBe(getPresetById("one-dark")!.theme.dark.canvas);
  });

  // The agent path legitimately produces a single-mode override; the other mode
  // must keep the preset's values.
  it("applies a single-mode override without disturbing the other mode", () => {
    const light = resolveEffectiveTheme("light", DEFAULT_PRESET_ID, { dark: { primary: "#123456" } });
    const dark = resolveEffectiveTheme("dark", DEFAULT_PRESET_ID, { dark: { primary: "#123456" } });
    expect(light).toEqual(DEFAULT_THEME.light);
    expect(dark.primary).toBe("#123456");
    expect(dark.canvas).toBe(DEFAULT_THEME.dark.canvas);
  });

  it("ignores keys outside the token whitelist", () => {
    const resolved = resolveEffectiveTheme("light", DEFAULT_PRESET_ID, {
      light: { "not-a-token": "#ffffff", primary: "#000000" } as never,
    });
    expect(resolved.primary).toBe("#000000");
    expect(Object.keys(resolved)).toEqual([...COLOR_TOKEN_KEYS]);
  });

  it("falls back to the default theme for an unknown preset id", () => {
    expect(resolveEffectiveTheme("light", "no-such-preset", null)).toEqual(DEFAULT_THEME.light);
  });

  it("exposes a default preset and refuses to return undefined", () => {
    expect(getDefaultPreset().id).toBe(DEFAULT_PRESET_ID);
    expect(BUILT_IN_PRESETS.map((preset) => preset.id)).toContain(DEFAULT_PRESET_ID);
    expect(isColorTokenKey("canvas")).toBe(true);
    expect(isColorTokenKey("canvas-x")).toBe(false);
  });
});

describe("injected CSS layer", () => {
  // The design system ships its palettes as `[data-ui-theme='mint'][data-theme]`
  // (0,2,0) and `:root[data-ui-theme='mint']:not([data-theme])` (0,3,0). The
  // first cut injected `:root, [data-theme]` — specificity (0,1,0) — so under the
  // default mint profile every user colour lost the cascade and editing the panel
  // changed nothing on screen. Asserting the computed result is out of reach in
  // jsdom, so the shape that produces it is pinned instead.
  it("injects at a specificity that can beat the design-system profiles", () => {
    applyThemeToDom(DEFAULT_THEME.light);
    expect(injectedSelector()).toBe(":root[data-theme], :root:not([data-theme])");
    expect(injectedSelector()).not.toMatch(/(^|,)\s*:root\s*(,|$)/);
  });

  it("appends the layer last in <head> so an equal specificity still wins", () => {
    applyThemeToDom(DEFAULT_THEME.light);
    expect(document.head.lastElementChild).toBe(document.getElementById(CSS_LAYER_ID));
  });

  it("emits every token as a --ui- variable", () => {
    const css = themeToCssOverrides(DEFAULT_THEME.dark);
    for (const key of COLOR_TOKEN_KEYS) expect(css).toContain(`--ui-${key}:`);
  });

  it("reuses one element instead of stacking copies", () => {
    applyThemeToDom(DEFAULT_THEME.light);
    applyThemeToDom(DEFAULT_THEME.dark);
    expect(document.querySelectorAll(`#${CSS_LAYER_ID}`)).toHaveLength(1);
    expect(document.getElementById(CSS_LAYER_ID)!.textContent).toContain(DEFAULT_THEME.dark.canvas);
  });

  // Clearing has to actually remove the layer: leaving stale variables behind
  // would keep the previous palette winning over the design-system profile.
  it("drops the layer on clear, and clearing twice is safe", () => {
    applyThemeToDom(DEFAULT_THEME.light);
    clearThemeOverrides();
    expect(document.getElementById(CSS_LAYER_ID)).toBeNull();
    expect(() => clearThemeOverrides()).not.toThrow();
  });
});

describe("antd seed projection", () => {
  it("maps primary and info hover to the hover token, not the base colour", () => {
    const seed = themeToAntdSeed(DEFAULT_THEME.light, "light");
    expect(seed.colorPrimary).toBe(DEFAULT_THEME.light.primary);
    expect(seed.colorInfoHover).toBe(DEFAULT_THEME.light["primary-hover"]);
    expect(seed.colorInfo).toBe(DEFAULT_THEME.light.info);
  });

  it("does not reuse the light elevation in dark mode", () => {
    const light = themeToAntdSeed(DEFAULT_THEME.light, "light");
    const dark = themeToAntdSeed(DEFAULT_THEME.dark, "dark");
    expect(dark.boxShadow).not.toBe(light.boxShadow);
    expect(dark.boxShadowSecondary).not.toBe(light.boxShadowSecondary);
  });
});

describe("validation", () => {
  it("reports catalog keys and never prose", () => {
    const result = validateThemeConfig({ light: {}, dark: {} });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    for (const issue of result.errors) expect(issue.key).toMatch(/^theme\.validation\./);
  });

  it("rejects a non-object config outright", () => {
    expect(validateThemeConfig(null).errors[0].key).toBe("theme.validation.notObject");
    expect(validateThemeConfig("nope").valid).toBe(false);
  });

  it("names the offending token and value in vars", () => {
    const tampered = cloneThemeConfig(DEFAULT_THEME);
    tampered.light.canvas = "hsl(1, 2)";
    const issue = validateThemeConfig(tampered).errors.find((entry) => entry.vars?.key === "canvas");
    expect(issue?.key).toBe("theme.validation.invalidColor");
    expect(issue?.vars).toMatchObject({ mode: "light", value: "hsl(1, 2)" });
  });

  it("treats an unknown key as a warning, not an error", () => {
    const tampered = cloneThemeConfig(DEFAULT_THEME) as ThemeConfig & { light: Record<string, string> };
    tampered.light["not-a-token"] = "#ffffff";
    const result = validateThemeConfig(tampered);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((entry) => entry.key === "theme.validation.unknownKey")).toBe(true);
  });

  it("accepts and rejects a complete config as expected", () => {
    expect(validateThemeConfig(cloneThemeConfig(DEFAULT_THEME)).valid).toBe(true);
    expect(isThemeConfig(DEFAULT_THEME)).toBe(true);
    expect(isThemeConfig({ light: DEFAULT_THEME.light })).toBe(false);
  });
});

describe("colour parsing", () => {
  // Every form the validator accepts must also be measurable, otherwise a colour
  // that passes validation silently skips its contrast check. `#RGBA` used to be
  // accepted here and rejected by the parser, which made the check a no-op.
  const accepted = ["#abc", "#abcd", "#aabbcc", "#aabbccdd", "rgb(1, 2, 3)", "rgba(1, 2, 3, 0.5)"];

  for (const value of accepted) {
    it(`measures contrast for ${value}`, () => {
      expect(isValidColorValue(value)).toBe(true);
      expect(contrastRatio(value, "#ffffff")).not.toBeNull();
    });
  }

  it("rejects malformed values", () => {
    for (const value of ["#12", "#12345", "rgb(1, 2)", "definitely-not-a-colour", ""]) {
      expect(isValidColorValue(value), value).toBe(false);
    }
  });
});

describe("contrast warnings", () => {
  it("locates a low-contrast pair by token name", () => {
    const palette = { ...DEFAULT_THEME.light, foreground: DEFAULT_THEME.light.canvas };
    const warnings = getContrastWarnings(palette);
    expect(warnings.some((entry) => entry.foreground === "foreground" && entry.background === "canvas")).toBe(true);
    expect(warnings[0].required).toBe(4.5);
    expect(warnings[0].level).toBe("AA");
  });

  it("stays quiet for the palettes that ship", () => {
    expect(getContrastWarnings(DEFAULT_THEME.light)).toEqual([]);
    expect(getContrastWarnings(DEFAULT_THEME.dark)).toEqual([]);
  });
});

describe("agent stub", () => {
  // The contract the future integration builds on: the requested mode decides
  // which half comes back.
  it("returns the requested mode rather than always the light half", () => {
    const config = cloneThemeConfig(DEFAULT_THEME);
    expect(validateGeneratedTheme(config, "dark").theme).toEqual(DEFAULT_THEME.dark);
    expect(validateGeneratedTheme(config, "light").theme).toEqual(DEFAULT_THEME.light);
  });

  it("surfaces catalog keys when the generated theme is invalid", () => {
    const result = validateGeneratedTheme({ light: {}, dark: {} }, "dark");
    expect(result.success).toBe(false);
    expect(result.theme).toBeUndefined();
    expect((result.errors ?? []).length).toBeGreaterThan(0);
    for (const issue of result.errors ?? []) expect(issue.key).toMatch(/^theme\./);
  });
});

describe("persistence", () => {
  it("round-trips a complete config", () => {
    writeStoredTheme(DEFAULT_THEME);
    expect(readStoredTheme()).toEqual(DEFAULT_THEME);
  });

  it("returns null when nothing is stored", () => {
    expect(readStoredTheme()).toBeNull();
  });

  // `writeStoredTheme` deliberately does not validate, which is exactly how a
  // hand-edited (or older-schema) localStorage entry reaches the reader. The
  // value would otherwise be injected into a <style> tag and AntD's token layer.
  it("refuses a stored config whose colour cannot be parsed", () => {
    const tampered = cloneThemeConfig(DEFAULT_THEME);
    tampered.dark.canvas = "javascript:alert(1)";
    writeStoredTheme(tampered);
    expect(readStoredTheme()).toBeNull();
  });

  it("refuses a stored config that is missing a mode", () => {
    writeStoredTheme({ light: DEFAULT_THEME.light } as unknown as ThemeConfig);
    expect(readStoredTheme()).toBeNull();
  });
});
