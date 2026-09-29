import { useEffect, useState } from "react";
import type { RelationshipSpatialTheme } from "./RelationshipSpatialScene";

/**
 * Reads the application's resolved theme straight from the document root.
 *
 * The relationship graph paints part of its stage inside WebGL, which cannot
 * inherit CSS. It needs the live light/dark mode to pick matching surface
 * tokens, but it must also render in isolation (tests, preview shells) where no
 * ThemeProvider is mounted. Reading `data-theme` directly keeps both cases
 * working and stays in sync when the user flips the theme.
 */
export function useAppTheme(): RelationshipSpatialTheme {
  const read = (): RelationshipSpatialTheme =>
    typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const [theme, setTheme] = useState<RelationshipSpatialTheme>(read);
  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
