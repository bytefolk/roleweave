/**
 * #519 first-run gate: `splash → (session ? workspace : login)`.
 *
 * Why the gate sits **above** `<App />` (wrapping the renderer entry in
 * main.tsx) instead of inside App: `<App />` is the workspace shell, and
 * `App.test.tsx` renders it directly in 30+ cases that assert the workspace is
 * immediately usable. Putting the login flow inside App would force those cases
 * to sign in first — a real behaviour change traded for a test adaptation. Above
 * App, "App = workspace shell" keeps its meaning, the first-run flow is a state
 * machine in front of it, and both stay independently testable.
 *
 * The state machine is an **exported pure reducer** (`reduceOnboarding`); the
 * component only translates timers and adapter results into events. The routing
 * rules (a saved session skips login, an expired one does not, a successful
 * sign-in reaches the workspace, nothing lands mid-transition) are the substance
 * of this change, and a reducer proves them far more reliably than inferring
 * them through fake timers and DOM assertions.
 *
 * Motion budget: splash 900ms + transition 400ms (login) / 300ms (workspace) —
 * a cold launch reaches the login card in ≈1.3s and a warm launch reaches the
 * workspace in ≈1.2s, both inside the acceptance criteria.
 * `prefers-reduced-motion` substitutes 240 + 220 / 180ms of pure fades.
 */
import { useCallback, useEffect, useMemo, useReducer, useState, type CSSProperties, type ReactNode } from "react";
import { OwbI18nProvider, useT } from "@roleweave/ui";
import { WindowControls } from "../WindowControls";
import { seedLocale } from "../locale-mode";
import { LoginScreen, type LoginMode } from "./LoginScreen";
import { SplashScreen } from "./SplashScreen";
import {
  resolveDefaultAuthAdapter,
  type OnboardingAuthAdapter,
  type OnboardingAuthFailure,
  type OnboardingCredentials,
  type SessionRestore,
} from "./auth-adapter";

export type OnboardingRoute = "login" | "workspace";

export interface OnboardingMachineState {
  /** Which layer is on screen. */
  stage: "splash" | "transition" | "login" | "workspace";
  /** Where the transition is heading; null while the session is unknown. */
  pending: OnboardingRoute | null;
  /** Session verdict; null means "not read yet". */
  restore: SessionRestore | null;
  /** Whether the splash's minimum duration has elapsed. */
  splashElapsed: boolean;
}

export type OnboardingEvent =
  | { type: "session"; restore: SessionRestore }
  | { type: "splashElapsed" }
  | { type: "transitionElapsed" }
  | { type: "authenticated"; session: Extract<SessionRestore, { state: "authenticated" }>["session"] };

export function initialOnboardingState(): OnboardingMachineState {
  return { stage: "splash", pending: null, restore: null, splashElapsed: false };
}

function routeFor(restore: SessionRestore): OnboardingRoute {
  return restore.state === "authenticated" ? "workspace" : "login";
}

/** Normalisation applied after every event: once the splash's minimum duration
 * has elapsed *and* the destination is known, the transition must start. It is
 * a separate function so the two conditions converge to the same state in
 * either arrival order — the session resolving first or the timer firing first
 * must not change the result. */
function settle(state: OnboardingMachineState): OnboardingMachineState {
  if (state.stage === "splash" && state.splashElapsed && state.pending !== null) {
    return { ...state, stage: "transition" };
  }
  return state;
}

export function reduceOnboarding(
  state: OnboardingMachineState,
  event: OnboardingEvent,
): OnboardingMachineState {
  switch (event.type) {
    case "session":
      return settle({ ...state, restore: event.restore, pending: routeFor(event.restore) });
    case "splashElapsed":
      return settle({ ...state, splashElapsed: true });
    case "transitionElapsed":
      return state.stage === "transition" && state.pending !== null
        ? { ...state, stage: state.pending }
        : state;
    case "authenticated":
      // Sign-in/sign-up succeeded: run one transition before landing on the
      // workspace rather than cutting to it.
      return {
        ...state,
        restore: { state: "authenticated", session: event.session },
        pending: "workspace",
        stage: "transition",
      };
    default:
      return state;
  }
}

export interface OnboardingTimings {
  splashMs: number;
  loginTransitionMs: number;
  workspaceTransitionMs: number;
}

export const DEFAULT_ONBOARDING_TIMINGS: OnboardingTimings = {
  splashMs: 900,
  loginTransitionMs: 400,
  workspaceTransitionMs: 300,
};

/** Acceptance criterion: under reduced motion the splash is ≤500ms and only
 * opacity fades remain. */
export const REDUCED_MOTION_ONBOARDING_TIMINGS: OnboardingTimings = {
  splashMs: 240,
  loginTransitionMs: 220,
  workspaceTransitionMs: 180,
};

export function resolveOnboardingTimings(reducedMotion: boolean): OnboardingTimings {
  return reducedMotion ? REDUCED_MOTION_ONBOARDING_TIMINGS : DEFAULT_ONBOARDING_TIMINGS;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** An unreadable query counts as "no reduced-motion request": playing the full
 * motion is better than pretending the user's setting was honoured. Same
 * handling as theme-mode's matchMedia probe. */
export function readReducedMotionPreference(): boolean {
  try {
    return window.matchMedia?.(REDUCED_MOTION_QUERY).matches === true;
  } catch {
    return false;
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => readReducedMotionPreference());
  useEffect(() => {
    let query: MediaQueryList | null = null;
    try {
      const candidate = window.matchMedia?.(REDUCED_MOTION_QUERY);
      // jsdom's matchMedia has no EventTarget half; reading once is enough,
      // crashing is not.
      query = candidate !== undefined && typeof candidate.addEventListener === "function" ? candidate : null;
    } catch {
      query = null;
    }
    if (query === null) return;
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query?.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export interface OnboardingGateProps {
  children: ReactNode;
  /** Defaults to `resolveDefaultAuthAdapter()` (the stub in auth-adapter.ts). */
  adapter?: OnboardingAuthAdapter;
  /** Timing override for tests and debugging; production goes through
   * resolveOnboardingTimings. */
  timings?: OnboardingTimings;
}

/** The product name is not translated; it is a constant. */
const PRODUCT_NAME = "RoleWeave";

/**
 * The i18n provider lives outside the state machine and inside the gate: the
 * splash and login copy must follow the user's persisted locale, and
 * `packages/ui`'s `useT` reads the nearest provider. Splitting into an outer
 * and an inner component rather than having the gate call `useT()` itself is
 * the point — that would read the outer default (zh-CN) and waste the seeding.
 */
export function OnboardingGate(props: OnboardingGateProps) {
  // Seeded once, before the workspace's own locale state exists: the first-run
  // copy has to follow the persisted choice on its very first paint.
  const [locale] = useState(() => seedLocale());
  return (
    <OwbI18nProvider locale={locale}>
      <OnboardingGateInner {...props} />
    </OwbI18nProvider>
  );
}

function OnboardingGateInner({ children, adapter, timings }: OnboardingGateProps) {
  const t = useT();
  const authAdapter = useMemo(() => adapter ?? resolveDefaultAuthAdapter(), [adapter]);
  const reducedMotion = useReducedMotion();
  const resolved = timings ?? resolveOnboardingTimings(reducedMotion);
  const [state, dispatch] = useReducer(reduceOnboarding, undefined, initialOnboardingState);
  const [failure, setFailure] = useState<OnboardingAuthFailure | null>(null);
  const [busy, setBusy] = useState(false);

  // Session restore and the splash timer start **in parallel**: the splash
  // should play its minimum, but never delay discovering that there is in fact
  // no session.
  useEffect(() => {
    let cancelled = false;
    const settleAnonymous = (): void => {
      if (!cancelled) dispatch({ type: "session", restore: { state: "anonymous" } });
    };
    try {
      void authAdapter.getSession().then((restore) => {
        if (!cancelled) dispatch({ type: "session", restore });
      }, settleAnonymous);
    } catch {
      // A *synchronous* throw needs an exit too: treat it as anonymous so the
      // login card still offers a way forward.
      settleAnonymous();
    }
    return () => { cancelled = true; };
  }, [authAdapter]);

  useEffect(() => {
    const id = setTimeout(() => dispatch({ type: "splashElapsed" }), resolved.splashMs);
    return () => clearTimeout(id);
  }, [resolved.splashMs]);

  const transitionMs = state.pending === "workspace" ? resolved.workspaceTransitionMs : resolved.loginTransitionMs;
  useEffect(() => {
    if (state.stage !== "transition") return;
    const id = setTimeout(() => dispatch({ type: "transitionElapsed" }), transitionMs);
    return () => clearTimeout(id);
  }, [state.stage, transitionMs]);

  const submit = useCallback((mode: LoginMode, credentials: OnboardingCredentials) => {
    setBusy(true);
    setFailure(null);
    const request = mode === "signIn"
      ? authAdapter.signIn(credentials)
      : authAdapter.signUp(credentials);
    void request.then((result) => {
      if (result.ok) dispatch({ type: "authenticated", session: result.session });
      else setFailure(result.failure);
    }).catch(() => setFailure("unreachable")).finally(() => setBusy(false));
  }, [authAdapter]);

  const restore = state.restore;
  const expiredNotice = restore !== null && restore.state === "expired";
  // Mounting the app as soon as the workspace transition begins (it paints its
  // first frame under the splash overlay) makes "entering the workspace" a
  // reveal rather than a re-layout. It also hands window control to App's own
  // 40px title bar, so the first-run chrome is never duplicated.
  const workspaceMounted = state.stage === "workspace" || (state.stage === "transition" && state.pending === "workspace");
  const showSplash = state.stage === "splash" || state.stage === "transition";
  const showLogin = state.stage === "transition" ? state.pending === "login" : state.stage === "login";
  const showSurface = !workspaceMounted || showSplash || showLogin;

  return (
    <>
      {/* The workspace route gets no wrapper element: `<App />` stays a direct
          child of #root, so App's 100%-height chain and the existing layout
          guards are untouched. The first-run layers are fixed overlays. */}
      {workspaceMounted ? children : null}
      {showSurface ? (
        <div
          className="owb-onboarding"
          data-stage={state.stage}
          data-pending={state.pending ?? "restoring"}
          data-reduced-motion={reducedMotion ? "true" : "false"}
          /* The transition duration is owned by the state machine (the two
             constants above) and only *consumed* by CSS, so "JS runs 400ms
             while CSS plays 500ms" cannot drift into existence. */
          style={{ "--owb-transition-ms": `${transitionMs}ms` } as CSSProperties}
        >
          {!workspaceMounted ? (
            <header
              className="owb-onboarding__chrome"
              onDoubleClick={() => void window.owb.windowToggleMaximize?.()}
            >
              <WindowControls />
            </header>
          ) : null}
          {showSplash ? (
            <SplashScreen
              phase={state.stage === "transition" ? "docking" : "splash"}
              label={t("onboarding.splash.aria")}
              hint={t("onboarding.splash.hint")}
              wordmark={PRODUCT_NAME}
            />
          ) : null}
          {showLogin ? (
            <LoginScreen
              settled={state.stage === "login"}
              busy={busy}
              failure={failure}
              expiredNotice={expiredNotice}
              onSubmit={submit}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}
