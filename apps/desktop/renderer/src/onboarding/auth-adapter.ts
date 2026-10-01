/**
 * The first-run authentication seam (#519).
 *
 * ⚠️ This is NOT an authentication implementation. The real protocol, the
 * credential storage format, and per-deployment session scoping all belong to
 * #395. This module provides exactly two things:
 *
 *   1. `OnboardingAuthAdapter` — the narrow interface the first-run flow
 *      depends on (`getSession` / `signIn` / `signUp` / `signOut`). #395 swaps
 *      the default implementation behind that same interface, so the two issues
 *      land independently.
 *   2. `createStubAuthAdapter()` — the default implementation, explicitly a
 *      stub, so the state machine, the motion, and the error branches are
 *      runnable and testable today.
 *
 * The stub's behaviour, spelled out so nobody mistakes it for a security
 * boundary:
 *   - the session is kept in localStorage under `owb.onboarding.session.v1`,
 *     stamped with a deployment id;
 *   - credentials only exist on the call stack for the duration of the call;
 *     a password is never persisted;
 *   - any syntactically plausible email with a long-enough password succeeds —
 *     nothing is verified or compared;
 *   - `signOut()` only clears the local record.
 *
 * In other words it buys usability, not safety. Until #395 lands, no deployment
 * may read "the stub let me through" as an authorization result.
 */

export interface OnboardingSession {
  schemaVersion: "onboarding-session.v1";
  /** Session subject; #395 replaces this with a real identity. */
  subject: string;
  displayName: string;
  email: string;
  /** Which deployment the session belongs to — the scoping rule itself is
   * #395's; the stub only stores and returns it. */
  deploymentId: string;
  issuedAt: number;
  /** Unix epoch ms; at or past this instant the session counts as expired
   * (acceptance criterion 3). */
  expiresAt: number;
}

/** The verdict of `getSession()`. Three states rather than `Session | null`:
 * "expired" needs a different screen from "never signed in" (a notice on the
 * login card), and collapsing them would throw that distinction away. */
export type SessionRestore =
  | { state: "authenticated"; session: OnboardingSession }
  | { state: "anonymous" }
  | { state: "expired" };

export interface OnboardingCredentials {
  email: string;
  password: string;
}

export type OnboardingAuthFailure =
  | "invalid_credentials"
  | "email_taken"
  | "unreachable";

export type OnboardingAuthResult =
  | { ok: true; session: OnboardingSession }
  | { ok: false; failure: OnboardingAuthFailure };

export interface OnboardingAuthAdapter {
  /** Anchor for per-deployment session scoping; the stub uses it to stamp the
   * local record. */
  readonly deploymentId: string;
  getSession(): Promise<SessionRestore>;
  signIn(credentials: OnboardingCredentials): Promise<OnboardingAuthResult>;
  signUp(credentials: OnboardingCredentials): Promise<OnboardingAuthResult>;
  signOut(): Promise<void>;
}

export const SESSION_STORAGE_KEY = "owb.onboarding.session.v1";
export const STUB_DEPLOYMENT_ID = "local";
/** Seven days. The stub needs something that can expire, so that the
 * expired-session branch is actually reachable and testable. */
export const STUB_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;

/** Storage surface the adapter reads. Writes are optional and separate: with a
 * read-only storage the app must still boot, not wedge. */
export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
  removeItem?(key: string): void;
}

function browserStorage(): SessionStorageLike | null {
  try {
    // Accessing localStorage throws outright when site data is disabled, so
    // its presence cannot be assumed.
    return typeof window === "undefined" ? null : (window.localStorage as SessionStorageLike);
  } catch {
    return null;
  }
}

/** A stored record is UNTRUSTED input: written by a previous run, or hand-edited
 * since. Validate field by field and treat anything malformed as "never signed
 * in" rather than letting it become a runtime crash. */
export function parseStoredSession(raw: string | null): OnboardingSession | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== "onboarding-session.v1") return null;
  const strings = ["subject", "displayName", "email", "deploymentId"] as const;
  for (const key of strings) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) return null;
  }
  if (typeof record.issuedAt !== "number" || !Number.isFinite(record.issuedAt)) return null;
  if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return null;
  return {
    schemaVersion: "onboarding-session.v1",
    subject: record.subject as string,
    displayName: record.displayName as string,
    email: record.email as string,
    deploymentId: record.deploymentId as string,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  };
}

/** Stored record → three-state verdict. An expired record is dropped on the way
 * out; otherwise every future launch re-judges the same dead session. */
export function restoreFromStorage(
  storage: SessionStorageLike | null,
  key: string,
  now: number,
): SessionRestore {
  if (storage === null) return { state: "anonymous" };
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { state: "anonymous" };
  }
  const session = parseStoredSession(raw);
  if (session === null) return { state: "anonymous" };
  if (session.expiresAt <= now) {
    try {
      storage.removeItem?.(key);
    } catch {
      // Failing to clear it only means judging it again next launch; the route
      // for this launch is already decided.
    }
    return { state: "expired" };
  }
  return { state: "authenticated", session };
}

export interface StubAuthAdapterOptions {
  deploymentId?: string;
  storage?: SessionStorageLike | null;
  storageKey?: string;
  sessionTtlMs?: number;
  /** Injectable clock: expiry has to be testable without waiting for it. */
  now?: () => number;
  /** Injectable latency, used to render the busy state. Defaults to 0 so tests
   * never wait. */
  latencyMs?: number;
}

function displayNameFromEmail(email: string): string {
  const local = email.slice(0, email.indexOf("@"));
  return local.length > 0 ? local : email;
}

/** The default implementation — a STUB. See the file header. */
export function createStubAuthAdapter(options: StubAuthAdapterOptions = {}): OnboardingAuthAdapter {
  const deploymentId = options.deploymentId ?? STUB_DEPLOYMENT_ID;
  const storageKey = options.storageKey ?? SESSION_STORAGE_KEY;
  const ttl = options.sessionTtlMs ?? STUB_SESSION_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const latencyMs = options.latencyMs ?? 0;
  const storage = options.storage === undefined ? browserStorage() : options.storage;

  const wait = (): Promise<void> => latencyMs > 0
    ? new Promise((resolve) => setTimeout(resolve, latencyMs))
    : Promise.resolve();

  const issue = (email: string): OnboardingSession => {
    const issuedAt = now();
    return {
      schemaVersion: "onboarding-session.v1",
      subject: `${deploymentId}:${email}`,
      displayName: displayNameFromEmail(email),
      email,
      deploymentId,
      issuedAt,
      expiresAt: issuedAt + ttl,
    };
  };

  const persist = (session: OnboardingSession): void => {
    try {
      storage?.setItem?.(storageKey, JSON.stringify(session));
    } catch {
      // Failing to persist only costs the next launch its "remember me"; it must
      // not fail the sign-in the user just performed.
    }
  };

  return {
    deploymentId,
    async getSession(): Promise<SessionRestore> {
      await wait();
      return restoreFromStorage(storage, storageKey, now());
    },
    async signIn(credentials: OnboardingCredentials): Promise<OnboardingAuthResult> {
      await wait();
      // The stub compares nothing: it has no credential store to compare
      // against. See the file header for what that does and does not mean.
      const session = issue(credentials.email);
      persist(session);
      return { ok: true, session };
    },
    async signUp(credentials: OnboardingCredentials): Promise<OnboardingAuthResult> {
      await wait();
      const session = issue(credentials.email);
      persist(session);
      return { ok: true, session };
    },
    async signOut(): Promise<void> {
      try {
        storage?.removeItem?.(storageKey);
      } catch {
        // Same as above: an unclearable record is not an error.
      }
    },
  };
}

/** The one the application uses by default. #395 replaces this with the real
 * per-deployment implementation. */
export function resolveDefaultAuthAdapter(): OnboardingAuthAdapter {
  return createStubAuthAdapter();
}
