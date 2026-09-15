import { useEffect, useState } from "react";
import type { ThemeMode, ThemeProfile } from "./theme-mode";

export type { ThemeMode, ThemeProfile };

/** Live `data-theme` on <html> (main.tsx seeds it, see initThemeMode). antd's
 * cssinjs algorithm has to follow the same switch as the --ui-* skin, otherwise
 * the shell goes dark while every antd control stays light (spec §5 双主题验收). */
export function useThemeMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>(() =>
    document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light",
  );
  useEffect(() => {
    const target = document.documentElement;
    const sync = (): void =>
      setMode(target.getAttribute("data-theme") === "dark" ? "dark" : "light");
    const observer = new MutationObserver(sync);
    observer.observe(target, { attributes: true, attributeFilter: ["data-theme"] });
    sync();
    return () => observer.disconnect();
  }, []);
  return mode;
}

/** The color profile is persisted independently from light/dark mode. It is
 * stamped on <html> by theme-mode.ts before React renders, so portaled AntD
 * surfaces and custom CSS always resolve the same profile. */
export function useThemeProfile(): ThemeProfile {
  const [profile, setProfile] = useState<ThemeProfile>(() =>
    document.documentElement.getAttribute("data-ui-theme") === "default" ? "default" : "mint",
  );
  useEffect(() => {
    const target = document.documentElement;
    const sync = (): void => {
      if (target.getAttribute("data-ui-theme") === null) {
        target.setAttribute("data-ui-theme", "mint");
        return;
      }
      setProfile(target.getAttribute("data-ui-theme") === "default" ? "default" : "mint");
    };
    const observer = new MutationObserver(sync);
    observer.observe(target, { attributes: true, attributeFilter: ["data-ui-theme"] });
    sync();
    return () => observer.disconnect();
  }, []);
  return profile;
}
