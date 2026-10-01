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
import "./roleweave-theme.css";
import "./roleweave-components.css";
import "./roleweave-conversation.css";
import "./roleweave-data.css";
import "./workspace-polish.css";
import "./memory/memory-workspace.css";
import "./control-legibility.css";
import "./onboarding/onboarding.css";
import { App } from "./App";
import { initThemeMode } from "./theme-mode";
import { OnboardingGate } from "./onboarding/OnboardingGate";

export const PACKAGED_SMOKE_QUERY_KEY = "orgWorkbenchPackagedSmoke";
const PACKAGED_SMOKE_NONCE = /^[a-f0-9]{64}$/;
/** #519: the #127 full-app layout harness is declared by main as a query
 * parameter so the renderer can skip the first-run gate for it. Keep in sync
 * with LAYOUT_SMOKE_QUERY_KEY in apps/desktop/src/packaged-smoke.cjs —
 * `apps/desktop/test/onboarding-motion.test.cjs` fails if the two drift. */
export const LAYOUT_SMOKE_QUERY_KEY = "orgWorkbenchLayoutSmoke";

type RendererLocation = Pick<Location, "protocol" | "search">;

export function isPackagedSmokeEntry(location: RendererLocation): boolean {
  if (location.protocol !== "file:") return false;
  const query = new URLSearchParams(location.search);
  const keys = [...query.keys()];
  return keys.length === 1 &&
    keys[0] === PACKAGED_SMOKE_QUERY_KEY &&
    PACKAGED_SMOKE_NONCE.test(query.get(PACKAGED_SMOKE_QUERY_KEY) ?? "");
}

/** The layout harness renders the real app, and a fresh CI install has no saved
 * session — without this the gate would sit on the login card and the columns
 * being measured would never mount. */
export function isLayoutSmokeEntry(location: RendererLocation): boolean {
  if (location.protocol !== "file:") return false;
  const query = new URLSearchParams(location.search);
  const keys = [...query.keys()];
  return keys.length === 1 &&
    keys[0] === LAYOUT_SMOKE_QUERY_KEY &&
    query.get(LAYOUT_SMOKE_QUERY_KEY) === "1";
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

/**
 * What actually gets mounted: the entry, wrapped in the #519 first-run gate.
 *
 * The gate sits **above** `<App />` on purpose — see OnboardingGate's header.
 * `<App />` stays the workspace shell, so `App.test.tsx`'s 30+ direct renders
 * keep meaning what they meant.
 *
 * The packaged smoke entry is deliberately exempt: it is a static marker the
 * external staging harness scores, it must call no bridge method, and a timed
 * splash in front of it would turn that harness into a timing test. The layout
 * harness is exempt for a different reason — it measures the real workspace, so
 * it has to reach it without a session on a fresh CI machine.
 */
export function rendererRootElement(
  location: RendererLocation,
  AppComponent: React.ComponentType = App,
): React.ReactElement {
  const entry = rendererEntryElement(location, AppComponent);
  if (isPackagedSmokeEntry(location) || isLayoutSmokeEntry(location)) return entry;
  return <OnboardingGate>{entry}</OnboardingGate>;
}

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
  rendererRootElement(window.location),
);
