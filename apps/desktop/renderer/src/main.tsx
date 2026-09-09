import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "antd/dist/reset.css";
import "@fullstack-ai-infra/ui/styles.css";
import "@roleweave/ui/styles.css";
import "./antd-skin.css";
import "./app.css";
import { App } from "./App";
import { initThemeMode } from "./theme-mode";

export const PACKAGED_SMOKE_QUERY_KEY = "orgWorkbenchPackagedSmoke";
const PACKAGED_SMOKE_NONCE = /^[a-f0-9]{64}$/;

type RendererLocation = Pick<Location, "protocol" | "search">;

export function isPackagedSmokeEntry(location: RendererLocation): boolean {
  if (location.protocol !== "file:") return false;
  const query = new URLSearchParams(location.search);
  const keys = [...query.keys()];
  return keys.length === 1 &&
    keys[0] === PACKAGED_SMOKE_QUERY_KEY &&
    PACKAGED_SMOKE_NONCE.test(query.get(PACKAGED_SMOKE_QUERY_KEY) ?? "");
}

export function rendererEntryElement(
  location: RendererLocation,
  AppComponent: React.ComponentType = App,
): React.ReactElement {
  if (isPackagedSmokeEntry(location)) {
    // The main process independently proves control-plane readiness. This
    // static renderer marker intentionally calls no bridge method, so Lane A
    // never triggers health/Qoder/business work while scoring package layout.
    return (
      <main data-org-workbench-packaged-smoke-entry="true">
        RoleWeave clean-staging renderer
      </main>
    );
  }
  return (
    <React.StrictMode>
      <AppComponent />
    </React.StrictMode>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("renderer root element missing");

// Theme seed before the first render (#94). index.html can only ship a static
// data-theme literal — its CSP is `script-src 'self'`, so the usual pre-paint
// inline script is not an option — and this runs before createRoot(), which is
// still pre-paint for the React tree. The returned teardown detaches the
// OS-preference follow, which lives as long as the window does, so it is
// deliberately dropped here.
initThemeMode();

// The antd ConfigProvider (ADR-0002 theme tokens) lives inside <App /> so the
// test harness renders the exact same configuration as production.
createRoot(root).render(
  rendererEntryElement(window.location),
);
