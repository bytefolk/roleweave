/**
 * #519 first-run gate.
 *
 * Two layers: the **pure reducer** enumerates the routing rules (the substance
 * of this change), and the **component with fake timers** proves the timeline
 * and the DOM are wired to those rules. They are separate because the reducer
 * can cover orderings while the component can only show that one ordering was
 * wired correctly.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ONBOARDING_TIMINGS,
  OnboardingGate,
  REDUCED_MOTION_ONBOARDING_TIMINGS,
  initialOnboardingState,
  readReducedMotionPreference,
  reduceOnboarding,
  resolveOnboardingTimings,
  type OnboardingEvent,
  type OnboardingMachineState,
} from "../src/onboarding/OnboardingGate";
import {
  createStubAuthAdapter,
  type OnboardingAuthAdapter,
  type OnboardingSession,
  type SessionStorageLike,
} from "../src/onboarding/auth-adapter";

const SESSION: OnboardingSession = {
  schemaVersion: "onboarding-session.v1",
  subject: "local:dev@example.com",
  displayName: "dev",
  email: "dev@example.com",
  deploymentId: "local",
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_600_000,
};

const NOW = 1_700_000_000_000;

function run(events: OnboardingEvent[]): OnboardingMachineState {
  return events.reduce<OnboardingMachineState>(reduceOnboarding, initialOnboardingState());
}

describe("#519 onboarding gate state machine", () => {
  it("starts on the splash with no route decided", () => {
    expect(initialOnboardingState()).toEqual({
      stage: "splash",
      pending: null,
      restore: null,
      splashElapsed: false,
    });
  });

  it("routes a saved session to the workspace and a fresh install to login", () => {
    const saved = run([
      { type: "session", restore: { state: "authenticated", session: SESSION } },
      { type: "splashElapsed" },
      { type: "transitionElapsed" },
    ]);
    const fresh = run([
      { type: "session", restore: { state: "anonymous" } },
      { type: "splashElapsed" },
      { type: "transitionElapsed" },
    ]);
    expect(saved.stage).toBe("workspace");
    expect(fresh.stage).toBe("login");
  });

  it("sends an expired session to login rather than to the workspace", () => {
    const final = run([
      { type: "session", restore: { state: "expired" } },
      { type: "splashElapsed" },
      { type: "transitionElapsed" },
    ]);
    expect(final.stage).toBe("login");
  });

  it("converges whether the session or the splash timer arrives first", () => {
    const sessionFirst = run([
      { type: "session", restore: { state: "anonymous" } },
      { type: "splashElapsed" },
    ]);
    const timerFirst = run([
      { type: "splashElapsed" },
      { type: "session", restore: { state: "anonymous" } },
    ]);
    expect(sessionFirst).toEqual(timerFirst);
    expect(sessionFirst.stage).toBe("transition");
  });

  it("never leaves the splash before the route is known, and never skips its minimum", () => {
    expect(run([{ type: "splashElapsed" }])).toMatchObject({ stage: "splash", pending: null });
    expect(run([{ type: "session", restore: { state: "anonymous" } }])).toMatchObject({
      stage: "splash",
      splashElapsed: false,
    });
  });

  it("moves to the workspace on a successful sign-in without a hard cut", () => {
    const atLogin = run([
      { type: "session", restore: { state: "anonymous" } },
      { type: "splashElapsed" },
      { type: "transitionElapsed" },
    ]);
    expect(atLogin.stage).toBe("login");
    const signingIn = reduceOnboarding(atLogin, { type: "authenticated", session: SESSION });
    expect(signingIn).toMatchObject({ stage: "transition", pending: "workspace" });
    expect(reduceOnboarding(signingIn, { type: "transitionElapsed" }).stage).toBe("workspace");
  });

  it("ignores a transition tick when no transition is running", () => {
    const state = initialOnboardingState();
    expect(reduceOnboarding(state, { type: "transitionElapsed" })).toBe(state);
  });
});

describe("#519 onboarding timings", () => {
  it("keeps the cold-launch path inside the 1.3s acceptance budget", () => {
    expect(DEFAULT_ONBOARDING_TIMINGS.splashMs + DEFAULT_ONBOARDING_TIMINGS.loginTransitionMs).toBeLessThanOrEqual(1300);
  });

  it("keeps the warm-launch path inside the 1.5s acceptance budget", () => {
    expect(DEFAULT_ONBOARDING_TIMINGS.splashMs + DEFAULT_ONBOARDING_TIMINGS.workspaceTransitionMs).toBeLessThanOrEqual(1500);
  });

  it("shortens the splash to 500ms or less under prefers-reduced-motion", () => {
    expect(REDUCED_MOTION_ONBOARDING_TIMINGS.splashMs).toBeLessThanOrEqual(500);
    expect(resolveOnboardingTimings(true)).toBe(REDUCED_MOTION_ONBOARDING_TIMINGS);
    expect(resolveOnboardingTimings(false)).toBe(DEFAULT_ONBOARDING_TIMINGS);
  });

  it("reads the OS preference, defaulting to 'no preference' when it is unreadable", () => {
    const original = window.matchMedia;
    const reducedMotionQuery = (query: string) => ({
      matches: query.includes("reduced-motion"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
    try {
      window.matchMedia = reducedMotionQuery as unknown as typeof window.matchMedia;
      expect(readReducedMotionPreference()).toBe(true);
      window.matchMedia = (() => { throw new Error("no matchMedia"); }) as unknown as typeof window.matchMedia;
      expect(readReducedMotionPreference()).toBe(false);
    } finally {
      window.matchMedia = original;
    }
  });
});

function memoryStorage(seed: Record<string, string> = {}): SessionStorageLike & { readonly map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function storedSession(expiresAt: number): SessionStorageLike {
  return memoryStorage({ "owb.onboarding.session.v1": JSON.stringify({ ...SESSION, expiresAt }) });
}

function adapterWith(overrides: Partial<OnboardingAuthAdapter> = {}): OnboardingAuthAdapter {
  const base = createStubAuthAdapter({ storage: memoryStorage(), now: () => NOW });
  return { ...base, ...overrides };
}

const FAST_TIMINGS = { splashMs: 900, loginTransitionMs: 400, workspaceTransitionMs: 300 };
const SPLASH_NAME = "RoleWeave 正在启动";
const TABS_NAME = "登录或创建账号";

/** Advance timers and microtasks together, so a resolved promise is never left
 * unflushed by act(). */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** "登录" names both the tab and the submit button in the card; take the button
 * inside the given container. */
function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === name);
  if (!match) throw new Error(`no button named ${name} in the container`);
  return match;
}

async function submitCard(email: string, password: string): Promise<void> {
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: password } });
  await act(async () => {
    fireEvent.click(buttonNamed(screen.getByRole("tabpanel"), "登录"));
  });
}

describe("#519 onboarding gate wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("plays the splash first and reveals the login card only after the whole sequence", async () => {
    render(
      <OnboardingGate adapter={adapterWith()} timings={FAST_TIMINGS}>
        <div>workspace body</div>
      </OnboardingGate>,
    );
    await advance(0);
    expect(screen.getByRole("status", { name: SPLASH_NAME })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    // The workspace must not mount early on the cold-launch path, or the
    // signed-out state would expose the internal UI.
    expect(screen.queryByText("workspace body")).toBeNull();

    await advance(FAST_TIMINGS.splashMs - 1);
    expect(screen.queryByRole("tablist")).toBeNull();

    await advance(1);
    // Mid-transition: the mark is still there (docking) and the card has
    // already faded in.
    expect(screen.getByRole("status", { name: SPLASH_NAME })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: TABS_NAME })).toBeInTheDocument();

    await advance(FAST_TIMINGS.loginTransitionMs);
    expect(screen.queryByRole("status", { name: SPLASH_NAME })).toBeNull();
    expect(screen.getByRole("tablist", { name: TABS_NAME })).toBeInTheDocument();
    expect(screen.queryByText("workspace body")).toBeNull();
  });

  it("plays the splash briefly and goes straight to the workspace when a session is saved", async () => {
    const adapter = createStubAuthAdapter({ storage: storedSession(NOW + 600_000), now: () => NOW });
    render(
      <OnboardingGate adapter={adapter} timings={FAST_TIMINGS}>
        <div>workspace body</div>
      </OnboardingGate>,
    );
    await advance(0);
    expect(screen.getByRole("status", { name: SPLASH_NAME })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();

    await advance(FAST_TIMINGS.splashMs);
    // The transition mounts the workspace (it paints its first frame under the
    // overlay); the login card never appears on this path.
    expect(screen.getByText("workspace body")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();

    await advance(FAST_TIMINGS.workspaceTransitionMs);
    expect(screen.queryByRole("status", { name: SPLASH_NAME })).toBeNull();
    expect(screen.getByText("workspace body")).toBeInTheDocument();
  });

  it("lands an expired session on the login card with an inline notice, never a modal", async () => {
    const storage = storedSession(NOW - 1_000);
    const adapter = createStubAuthAdapter({ storage, now: () => NOW });
    render(
      <OnboardingGate adapter={adapter} timings={FAST_TIMINGS}>
        <div>workspace body</div>
      </OnboardingGate>,
    );
    await advance(FAST_TIMINGS.splashMs + FAST_TIMINGS.loginTransitionMs);
    expect(screen.getByText("上一次的登录已过期，请重新登录。")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The expired record is dropped on the spot instead of being re-judged on
    // every future launch.
    expect(storage.map.has("owb.onboarding.session.v1")).toBe(false);
  });

  it("finishes a reduced-motion launch inside the shortened splash budget", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("reduced-motion"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      render(
        <OnboardingGate adapter={adapterWith()}>
          <div>workspace body</div>
        </OnboardingGate>,
      );
      await advance(0);
      expect(screen.getByRole("status", { name: SPLASH_NAME })).toBeInTheDocument();
      // Under the default timings the gate would still be on the splash here;
      // reduced motion has to have decided the route already.
      await advance(REDUCED_MOTION_ONBOARDING_TIMINGS.splashMs);
      await advance(REDUCED_MOTION_ONBOARDING_TIMINGS.loginTransitionMs);
      expect(screen.getByRole("tablist", { name: TABS_NAME })).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });

  it("enters the workspace after a successful sign-in", async () => {
    const signIn = vi.fn().mockResolvedValue({ ok: true, session: SESSION });
    render(
      <OnboardingGate adapter={adapterWith({ signIn })} timings={FAST_TIMINGS}>
        <div>workspace body</div>
      </OnboardingGate>,
    );
    await advance(FAST_TIMINGS.splashMs + FAST_TIMINGS.loginTransitionMs);
    await submitCard("dev@example.com", "correct-horse");
    expect(signIn).toHaveBeenCalledWith({ email: "dev@example.com", password: "correct-horse" });
    await advance(0);
    expect(screen.getByText("workspace body")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("falls back to the login card when the adapter cannot answer at all", async () => {
    render(
      <OnboardingGate adapter={adapterWith({ getSession: vi.fn().mockRejectedValue(new Error("bridge down")) })} timings={FAST_TIMINGS}>
        <div>workspace body</div>
      </OnboardingGate>,
    );
    await advance(FAST_TIMINGS.splashMs + FAST_TIMINGS.loginTransitionMs);
    expect(screen.getByRole("tablist", { name: TABS_NAME })).toBeInTheDocument();
    expect(screen.queryByText("workspace body")).toBeNull();
  });

  it("reports a rejected sign-in inline without leaving the card", async () => {
    const signIn = vi.fn().mockResolvedValue({ ok: false, failure: "invalid_credentials" });
    render(
      <OnboardingGate adapter={adapterWith({ signIn })} timings={FAST_TIMINGS}>
        <div>workspace body</div>
      </OnboardingGate>,
    );
    await advance(FAST_TIMINGS.splashMs + FAST_TIMINGS.loginTransitionMs);
    await submitCard("dev@example.com", "nope-nope");
    await advance(0);
    expect(screen.getByRole("alert")).toHaveTextContent("邮箱或密码不正确。");
    expect(screen.getByRole("tablist", { name: TABS_NAME })).toBeInTheDocument();
    expect(screen.queryByText("workspace body")).toBeNull();
  });
});

describe("#519 onboarding gate under the default (unmocked) clock", () => {
  it("does not mount the workspace during the splash of a cold launch", async () => {
    // Real timers on purpose: this proves "the first frame of a cold launch is
    // not the workspace" without depending on a fake clock.
    render(
      <OnboardingGate adapter={adapterWith()} timings={{ splashMs: 30_000, loginTransitionMs: 10, workspaceTransitionMs: 10 }}>
        <div>workspace body</div>
      </OnboardingGate>,
    );
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText("workspace body")).toBeNull();
    expect(screen.getByRole("status", { name: SPLASH_NAME })).toBeInTheDocument();
  });
});
