/** Theme mode write path (#94).
 *
 * `antd-skin.css` already ships a complete dark `--ui-*` palette and
 * `useThemeMode()` in App.tsx already mirrors `<html data-theme>` into antd's
 * cssinjs algorithm. What was missing is this module: nothing in the repo ever
 * wrote that attribute, so the dark half of the design system was unreachable.
 *
 * Persistence is `localStorage`, deliberately not IPC. The preload bridge
 * (`owb.d.ts`) is a whitelisted control-plane/window surface; a per-user
 * display preference does not justify widening it.
 */

export type ThemeMode = "light" | "dark";
export type ThemeProfile = "default" | "mint";

/** Key for an *explicit* user choice. Absent means "follow the OS". */
export const THEME_STORAGE_KEY = "owb.theme-mode";
/** Palette is independent from light/dark mode. `mint` is RoleWeave's default;
 * `default` retains the shared Ant Design profile for users who prefer it. */
export const THEME_PROFILE_STORAGE_KEY = "owb.theme-profile";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark";
}

function isThemeProfile(value: unknown): value is ThemeProfile {
  return value === "default" || value === "mint";
}

/** The pinned choice, or null when the user has never picked one. Storage can
 * throw outright (site data disabled, hardened profiles), so a failure degrades
 * to "not pinned" rather than breaking boot. */
export function readStoredMode(): ThemeMode | null {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function readStoredProfile(): ThemeProfile | null {
  try {
    const raw = window.localStorage.getItem(THEME_PROFILE_STORAGE_KEY);
    return isThemeProfile(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function resolveThemeProfile(): ThemeProfile {
  return readStoredProfile() ?? "mint";
}

function darkQuery(): MediaQueryList | null {
  try {
    const query = window.matchMedia?.(DARK_QUERY);
    // Some environments (jsdom among them) expose matchMedia without the
    // EventTarget half; that means "cannot follow the OS", not "throw at boot".
    if (query === undefined || typeof query.addEventListener !== "function") return null;
    return query;
  } catch {
    return null;
  }
}

/** OS preference. Anything we cannot read counts as "no dark preference", which
 * keeps today's behaviour (light) for every environment that does not opt in. */
export function osThemeMode(): ThemeMode {
  try {
    return window.matchMedia?.(DARK_QUERY).matches === true ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Pinned choice first, OS preference second. */
export function resolveThemeMode(): ThemeMode {
  return readStoredMode() ?? osThemeMode();
}

/** Stamps `<html data-theme>` without persisting. `useThemeMode()`'s
 * MutationObserver picks this up and swaps antd's algorithm in the same tick,
 * so the shell and the antd controls never disagree (spec §5 双主题验收). */
export function applyThemeMode(mode: ThemeMode): void {
  document.documentElement.setAttribute("data-theme", mode);
}

export function applyThemeProfile(profile: ThemeProfile): void {
  document.documentElement.setAttribute("data-ui-theme", profile);
}

/** Pins an explicit choice: apply it and remember it across restarts. */
export function setThemeMode(mode: ThemeMode): void {
  applyThemeMode(mode);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Read-only storage still leaves this session switched; losing the
    // preference on restart beats failing the click.
  }
}

export function setThemeProfile(profile: ThemeProfile): void {
  applyThemeProfile(profile);
  try {
    window.localStorage.setItem(THEME_PROFILE_STORAGE_KEY, profile);
  } catch {
    // The session still switches when persistence is unavailable.
  }
}

/** Boot seed, called before `createRoot()`.
 *
 * `index.html` hard-codes `data-theme="light"` because its CSP is
 * `script-src 'self'` — the usual pre-paint inline `<script>` that stamps the
 * attribute in `<head>` is unavailable. Running here is still pre-paint for the
 * React tree, so there is no flash of the wrong theme.
 *
 * Returns a teardown for the OS follow, which only applies while no explicit
 * choice is pinned — the first toggle click ends the follow for good.
 */
export function initThemeMode(): () => void {
  applyThemeProfile(resolveThemeProfile());
  applyThemeMode(resolveThemeMode());

  const query = darkQuery();
  if (query === null) return () => {};

  const onOsChange = (event: MediaQueryListEvent): void => {
    if (readStoredMode() !== null) return;
    applyThemeMode(event.matches ? "dark" : "light");
  };
  query.addEventListener("change", onOsChange);
  return () => query.removeEventListener("change", onOsChange);
}
