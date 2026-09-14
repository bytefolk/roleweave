import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  THEME_PROFILE_STORAGE_KEY,
  applyThemeProfile,
  applyThemeMode,
  initThemeMode,
  osThemeMode,
  readStoredProfile,
  readStoredMode,
  resolveThemeProfile,
  resolveThemeMode,
  setThemeProfile,
  setThemeMode,
} from "../src/theme-mode";

/** #94: the dark palette shipped complete in antd-skin.css but nothing ever
 * wrote `data-theme`, so the theme was unreachable. These cover the write path:
 * boot resolution order, persistence, and the OS follow that only applies while
 * the user has not pinned a choice. */

type MediaListener = (event: MediaQueryListEvent) => void;

/** jsdom has no prefers-color-scheme, so the boot seed's media query is stubbed
 * with a controllable one. Returns an `emit` to simulate an OS theme change. */
function stubDarkQuery(matches: boolean) {
  const listeners = new Set<MediaListener>();
  const query = {
    matches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, listener: MediaListener) => void listeners.add(listener),
    removeEventListener: (_: string, listener: MediaListener) => void listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(query));
  return {
    query,
    listenerCount: () => listeners.size,
    emit: (next: boolean) => {
      query.matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.setAttribute("data-theme", "light");
  document.documentElement.setAttribute("data-ui-theme", "mint");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme mode resolution (#94)", () => {
  it("prefers a pinned choice over the OS preference", () => {
    stubDarkQuery(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    expect(readStoredMode()).toBe("dark");
    expect(osThemeMode()).toBe("light");
    expect(resolveThemeMode()).toBe("dark");
  });

  it("falls back to the OS preference when nothing is pinned", () => {
    stubDarkQuery(true);

    expect(readStoredMode()).toBeNull();
    expect(resolveThemeMode()).toBe("dark");
  });

  it("ignores a stored value that is not a theme mode", () => {
    stubDarkQuery(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "solarized");

    expect(readStoredMode()).toBeNull();
    expect(resolveThemeMode()).toBe("light");
  });

  // The seed exists because index.html can only carry a static literal: its CSP
  // is `script-src 'self'`, so the usual pre-paint inline script is unavailable.
  it("seeds <html data-theme> at boot from the resolved mode", () => {
    stubDarkQuery(true);

    const stop = initThemeMode();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-ui-theme")).toBe("mint");
    stop();
  });

  it("defaults to mint and persists a separately selectable color profile", () => {
    expect(readStoredProfile()).toBeNull();
    expect(resolveThemeProfile()).toBe("mint");

    setThemeProfile("default");

    expect(document.documentElement.getAttribute("data-ui-theme")).toBe("default");
    expect(window.localStorage.getItem(THEME_PROFILE_STORAGE_KEY)).toBe("default");
    expect(readStoredProfile()).toBe("default");
  });

  it("follows later OS changes only while no explicit choice is pinned", () => {
    const media = stubDarkQuery(false);
    const stop = initThemeMode();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    media.emit(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    // Pinning light must survive an OS flip back to dark.
    setThemeMode("light");
    media.emit(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    stop();
    expect(media.listenerCount()).toBe(0);
  });

  it("persists an explicit choice and applies it in the same call", () => {
    stubDarkQuery(false);

    setThemeMode("dark");

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  // A hardened profile can make localStorage throw outright; the click must
  // still switch the session rather than blowing up the renderer.
  it("still switches the session when storage is unavailable", () => {
    stubDarkQuery(false);
    // jsdom's localStorage is a Proxy, so the throwing stub has to land on
    // Storage.prototype rather than on the instance.
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    expect(() => setThemeMode("dark")).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(readStoredMode()).toBeNull();

    setItem.mockRestore();
    getItem.mockRestore();
  });

  it("treats a missing matchMedia as no dark preference", () => {
    vi.stubGlobal("matchMedia", undefined);

    expect(osThemeMode()).toBe("light");
    expect(resolveThemeMode()).toBe("light");
    // No media query to attach to: the teardown must still be callable.
    expect(() => initThemeMode()()).not.toThrow();
  });

  it("applies a mode without touching storage", () => {
    stubDarkQuery(false);

    applyThemeMode("dark");

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("applies a profile without touching storage", () => {
    applyThemeProfile("default");

    expect(document.documentElement.getAttribute("data-ui-theme")).toBe("default");
    expect(window.localStorage.getItem(THEME_PROFILE_STORAGE_KEY)).toBeNull();
  });
});
