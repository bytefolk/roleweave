/**
 * #255 review follow-up. The review's first blocking item was that this PR
 * touched no test file, so nothing proved the renderer suite still rendered
 * `<App />` — and `<App />` reaches `useTheme()` thirteen times without any test
 * adding a provider. The second was that the panel's CSS class names, catalog
 * keys and component tree had been written independently of each other, so the
 * panel was structurally present but visually inert.
 *
 * These cover the behavioural half: provider placement, the palette gate, the
 * persist-on-save contract, the modal overlay, and the class-name / token
 * alignment that has to hold between the components and app.css.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwbI18nProvider, enCatalog } from "@roleweave/ui";
import { DEFAULT_THEME, isThemeConfig } from "../src/theme-config";
import { BUILT_IN_PRESETS, DEFAULT_PRESET_ID } from "../src/theme-presets";
import { readStoredTheme } from "../src/theme-storage";
import { ThemeProvider, useTheme } from "../src/theme-context";
import { ThemeSettings } from "../src/theme-settings";
import { ThemePicker } from "../src/theme-picker";
import { PrefsMenu } from "../src/prefs-menu";

const CSS_LAYER_ID = "roleweave-theme-overrides";

/** `import.meta.url` is not a file URL under this vitest environment, so the
 * source directory is located the same way the #146 CJK gate locates the repo
 * root: walk up from the cwd until the marker file shows up. */
function findSrcDir(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, "apps", "desktop", "renderer", "src");
    if (existsSync(join(candidate, "app.css"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`theme-panel: could not locate renderer/src from ${process.cwd()}`);
}

const srcDir = findSrcDir();

/** Drives the context from the outside and surfaces what it resolved, so the
 * assertions read as behaviour rather than as implementation. */
function Probe() {
  const { mode, presetId, custom, effective, forMode, updateCustomColor, save, reset, isDirty } = useTheme();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="preset">{presetId}</span>
      <span data-testid="custom">{String(custom !== null)}</span>
      <span data-testid="dirty">{String(isDirty)}</span>
      <span data-testid="effective-primary">{effective.primary}</span>
      <span data-testid="for-light-primary">{forMode("light").primary}</span>
      <span data-testid="for-dark-primary">{forMode("dark").primary}</span>
      <button type="button" onClick={() => updateCustomColor("dark", "primary", "#123456")}>edit-dark</button>
      <button type="button" onClick={() => updateCustomColor("light", "foreground", DEFAULT_THEME.light.canvas)}>flatten-contrast</button>
      <button type="button" onClick={() => save()}>save-theme</button>
      <button type="button" onClick={() => reset()}>reset-theme</button>
    </div>
  );
}

function renderPanel(node: ReactNode) {
  return render(<OwbI18nProvider locale="en"><ThemeProvider>{node}</ThemeProvider></OwbI18nProvider>);
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.setAttribute("data-theme", "light");
  document.documentElement.setAttribute("data-ui-theme", "mint");
});

afterEach(() => {
  document.getElementById(CSS_LAYER_ID)?.remove();
  vi.restoreAllMocks();
});

describe("provider contract", () => {
  it("refuses to resolve outside a ThemeProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/ThemeProvider/);
  });

  // The picker edits one mode while the app renders another; reading `effective`
  // there would seed the dark panel with the light palette.
  it("resolves the palette for the requested mode, not the active one", () => {
    const { getByTestId } = renderPanel(<Probe />);
    expect(getByTestId("mode").textContent).toBe("light");
    expect(getByTestId("for-light-primary").textContent).toBe(DEFAULT_THEME.light.primary);
    expect(getByTestId("for-dark-primary").textContent).toBe(DEFAULT_THEME.dark.primary);
    expect(getByTestId("effective-primary").textContent).toBe(DEFAULT_THEME.light.primary);
  });

  it("follows <html data-theme> so the panel tracks the workbench toggle", async () => {
    const { getByTestId } = renderPanel(<Probe />);
    expect(getByTestId("mode").textContent).toBe("light");
    act(() => { document.documentElement.setAttribute("data-theme", "dark"); });
    await waitFor(() => expect(getByTestId("mode").textContent).toBe("dark"));
  });
});

describe("palette gate", () => {
  // An untouched install must keep rendering exactly what the design-system
  // profile produces: injecting the palette unconditionally would put a
  // (0,2,0) layer over every install and change the shipped look.
  it("leaves the CSS layer alone while the shipped defaults are in effect", () => {
    const { getByText } = renderPanel(<Probe />);
    expect(document.getElementById(CSS_LAYER_ID)).toBeNull();
    fireEvent.click(getByText("edit-dark"));
    expect(document.getElementById(CSS_LAYER_ID)).not.toBeNull();
  });

  it("drops the layer once the palette returns to the shipped defaults", () => {
    const { getByText } = renderPanel(<Probe />);
    fireEvent.click(getByText("edit-dark"));
    expect(document.getElementById(CSS_LAYER_ID)).not.toBeNull();
    fireEvent.click(getByText("reset-theme"));
    expect(document.getElementById(CSS_LAYER_ID)).toBeNull();
  });
});

describe("persistence", () => {
  it("writes nothing until save is pressed", () => {
    const { getByText, getByTestId } = renderPanel(<Probe />);
    fireEvent.click(getByText("edit-dark"));
    expect(getByTestId("dirty").textContent).toBe("true");
    expect(readStoredTheme()).toBeNull();
  });

  // `readStoredTheme` only accepts a full config, so persisting the override set
  // made the saved palette disappear on the next start with no visible error.
  it("persists a complete config that the reader accepts", () => {
    const { getByText } = renderPanel(<Probe />);
    fireEvent.click(getByText("edit-dark"));
    fireEvent.click(getByText("save-theme"));

    const stored = readStoredTheme();
    expect(stored).not.toBeNull();
    expect(isThemeConfig(stored)).toBe(true);
    expect(stored!.dark.primary).toBe("#123456");
    expect(stored!.light).toEqual(DEFAULT_THEME.light);
  });
});

describe("settings panel", () => {
  // `t()` falls back to the key itself, so a key the catalog does not have shows
  // up verbatim in the panel — which is what shipped when the components and the
  // catalogs were written independently.
  it("renders translated copy in every tab, never a raw catalog key", () => {
    const { container } = renderPanel(<ThemeSettings onClose={() => {}} />);
    expect(container.textContent).not.toContain("theme.");

    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>(".owb-theme-settings__tabs button"));
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) {
      fireEvent.click(tab);
      expect(container.textContent).not.toContain("theme.");
    }
  });

  it("asks before a preset switch throws away custom colours", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container, getByText, getByTestId } = renderPanel(
      <><Probe /><ThemeSettings onClose={() => {}} /></>,
    );
    const presets = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".owb-theme-settings__preset"));
    expect(presets()).toHaveLength(BUILT_IN_PRESETS.length);

    // Nothing to lose yet: the switch is silent.
    fireEvent.click(presets()[1]);
    expect(confirm).not.toHaveBeenCalled();
    expect(getByTestId("preset").textContent).toBe("one-dark");

    // Unsaved custom colours now exist, so the switch has to be confirmed.
    fireEvent.click(getByText("edit-dark"));
    expect(getByTestId("custom").textContent).toBe("true");
    fireEvent.click(presets()[0]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(getByTestId("preset").textContent).toBe("one-dark");

    confirm.mockReturnValue(true);
    fireEvent.click(presets()[0]);
    expect(getByTestId("preset").textContent).toBe(DEFAULT_PRESET_ID);
  });

  // AC-06 used to be reachable only through the (stubbed) agent path.
  it("gives manual editing the same contrast feedback as the agent path", () => {
    renderPanel(<><Probe /><ThemePicker /></>);
    expect(document.querySelector(".owb-theme-contrast-warnings")).toBeNull();
    fireEvent.click(screen.getByText("flatten-contrast"));
    expect(document.querySelector(".owb-theme-contrast-warnings")).not.toBeNull();
    expect(document.querySelectorAll(".owb-theme-contrast-warnings__item").length).toBeGreaterThan(0);
  });
});

describe("prefs menu", () => {
  it("opens the panel as a modal overlay, not an inline dropdown row", () => {
    const { container } = renderPanel(
      <PrefsMenu locale="en" onChangeLocale={() => {}} mode="light" profile="mint" />,
    );
    fireEvent.click(container.querySelector(".owb-wintitle__theme") as HTMLButtonElement);

    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
    const themeRow = rows.find((row) => row.textContent?.includes(enCatalog["theme.title"]));
    expect(themeRow, "the theme row is missing from the prefs drawer").toBeDefined();
    fireEvent.click(themeRow!);

    const overlay = container.querySelector(".owb-theme-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.getAttribute("role")).toBe("dialog");
    expect(overlay!.getAttribute("aria-modal")).toBe("true");
    expect(overlay!.querySelector(".owb-theme-settings")).not.toBeNull();
    // It used to render inline inside the drawer, where it had no fixed
    // positioning and no stacking context above the workbench.
    expect(overlay!.closest('[role="menu"]')).toBeNull();
    expect(container.querySelector(".owb-prefs > .owb-theme-overlay")).not.toBeNull();
  });
});

describe("styles", () => {
  /** Returns the whole `<button ...>` tag starting at `start`. A tag boundary
   * cannot be found with a plain regex: `onClick={() => f()}` contains a `>` and
   * `className={`a ${b}`}` contains braces, so the scan tracks quote and brace
   * depth and only accepts a `>` at depth 0. */
  function buttonTag(source: string, start: number): string {
    let depth = 0;
    let quote: string | null = null;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (quote !== null) {
        if (ch === "\\") i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === ">" && depth === 0) return source.slice(start, i + 1);
    }
    return source.slice(start);
  }

  function buttonClasses(source: string): Set<string> {
    const found = new Set<string>();
    for (const match of source.matchAll(/<button\b/g)) {
      for (const cls of buttonTag(source, match.index).matchAll(/owb-theme[A-Za-z0-9_-]*/g)) found.add(cls[0]);
    }
    return found;
  }

  it("styles every class the panel puts on a button", () => {
    const css = readFileSync(join(srcDir, "app.css"), "utf8");
    const required = new Set<string>(["owb-theme-overlay"]);
    for (const file of ["theme-settings.tsx", "theme-picker.tsx", "theme-agent-prompt.tsx"]) {
      for (const cls of buttonClasses(readFileSync(join(srcDir, file), "utf8"))) required.add(cls);
    }
    // close / cancel / save / reset / preset + generate / apply / cancel + overlay
    expect(required.size).toBeGreaterThan(4);

    const unstyled = [...required].filter((cls) => !new RegExp(`\\.${cls}(?![\\w-])`).test(css));
    expect(unstyled, `app.css has no rule for: ${unstyled.join(", ")}`).toEqual([]);
  });

  // An unknown --ui-* name makes the whole declaration invalid at
  // computed-value time, which is how the first cut shipped a panel that was
  // present in the DOM but visually inert.
  it("references only tokens the design system declares", () => {
    const css = readFileSync(join(srcDir, "app.css"), "utf8");
    const block = css.slice(css.indexOf("/* Theme settings overlay (#246)."));
    const dsStyles = readFileSync(createRequire(join(srcDir, "app.css")).resolve("@fullstack-ai-infra/ui/styles.css"), "utf8");
    const declared = new Set([...dsStyles.matchAll(/(--ui-[a-z0-9-]+)\s*:/g)].map((match) => match[1]));

    const used = [...new Set([...block.matchAll(/var\((--ui-[a-z0-9-]+)/g)].map((match) => match[1]))];
    expect(used.length).toBeGreaterThan(0);
    const dead = used.filter((token) => !declared.has(token));
    expect(dead, `app.css reads tokens the design system never defines: ${dead.join(", ")}`).toEqual([]);
  });
});
