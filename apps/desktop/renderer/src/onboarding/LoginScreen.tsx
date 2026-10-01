/**
 * #519 login / register card.
 *
 * Three deliberate choices:
 *   1. **No antd.** The first-run surface runs outside `<App />`, and ADR-0002's
 *      ConfigProvider / DSProvider (including `autoInsertSpace: false`) live
 *      inside App. Dragging that provider chain in front of the login page
 *      would make the signed-out state carry the whole design-token setup. This
 *      uses native form elements plus onboarding.css, which also keeps the "no
 *      new runtime dependency" criterion trivially true.
 *   2. **No focus during the transition.** The inputs do not touch focus when
 *      they mount; `focus()` runs once `settled` flips, so the keyboard cannot
 *      pop up in the middle of the animation (motion spec).
 *   3. **Local validation, inline reporting.** Error values are i18n keys, not
 *      sentences: the component holds no user-visible copy (the zh/en catalogs
 *      are the only source). Form-level failures (bad credentials, taken email,
 *      unreachable service) render as one inline notice and never as a modal.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useT, type OwbT } from "@roleweave/ui";
import {
  MIN_PASSWORD_LENGTH,
  type OnboardingAuthFailure,
  type OnboardingCredentials,
} from "./auth-adapter";

export type LoginMode = "signIn" | "signUp";

export interface LoginFieldErrors {
  /** i18n keys, not sentences. */
  email?: string;
  password?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Client-side validation (the issue requires inline errors on both forms).
 *
 * Exported as a pure function so it can be tested on its own: it is the single
 * validation rule shared by sign-in and sign-up, and hiding it inside the
 * component would leave only indirect, render-based verification.
 *
 * This is usability validation, not security validation — the real rules are
 * the server's, and they arrive with #395.
 */
export function validateCredentials(mode: LoginMode, values: { email: string; password: string }): LoginFieldErrors {
  const errors: LoginFieldErrors = {};
  const email = values.email.trim();
  if (email.length === 0) errors.email = "onboarding.login.errEmailRequired";
  else if (!EMAIL_PATTERN.test(email)) errors.email = "onboarding.login.errEmailFormat";

  if (mode === "signUp") {
    if (values.password.length === 0) errors.password = "onboarding.login.errPasswordRequired";
    else if (values.password.length < MIN_PASSWORD_LENGTH) errors.password = "onboarding.login.errPasswordShort";
  } else if (values.password.length === 0) {
    errors.password = "onboarding.login.errPasswordRequired";
  }
  return errors;
}

const FAILURE_KEYS: Record<OnboardingAuthFailure, string> = {
  invalid_credentials: "onboarding.login.errInvalidCredentials",
  email_taken: "onboarding.login.errEmailTaken",
  unreachable: "onboarding.login.errUnreachable",
};

export interface LoginScreenProps {
  /** Whether the transition has finished. #519: fields must not autofocus
   * before it does. */
  settled: boolean;
  /** Request in flight: the button goes busy and a second submit is blocked. */
  busy: boolean;
  /** Server-side failure from the previous submit (the stub can report
   * "unreachable" too). */
  failure: OnboardingAuthFailure | null;
  /** Expired session: one inline notice rather than an error dialog. */
  expiredNotice: boolean;
  onSubmit: (mode: LoginMode, credentials: OnboardingCredentials) => void;
  /** Supplied once #395 wires "forgot password"; without it the row stays
   * visible but inert. */
  onForgotPassword?: () => void;
}

export function LoginScreen({
  settled,
  busy,
  failure,
  expiredNotice,
  onSubmit,
  onForgotPassword,
}: LoginScreenProps) {
  const t = useT();
  const [mode, setMode] = useState<LoginMode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<LoginFieldErrors>({});
  const emailRef = useRef<HTMLInputElement | null>(null);
  const fieldId = useId();

  useEffect(() => {
    if (settled) emailRef.current?.focus();
  }, [settled]);

  const switchMode = useCallback((next: LoginMode) => {
    setMode(next);
    setErrors({});
    // Switching to sign-up does not keep the password: the two forms have
    // different password rules, and carrying it over only confuses.
    setPassword("");
  }, []);

  const onTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    switchMode(mode === "signIn" ? "signUp" : "signIn");
  }, [mode, switchMode]);

  const submit = useCallback(() => {
    const values = { email: email.trim(), password };
    const found = validateCredentials(mode, values);
    setErrors(found);
    if (found.email !== undefined || found.password !== undefined) return;
    onSubmit(mode, values);
  }, [email, mode, onSubmit, password]);

  const emailId = `${fieldId}-email`;
  const passwordId = `${fieldId}-password`;
  const emailErrorId = `${emailId}-error`;
  const passwordErrorId = `${passwordId}-error`;
  const failureText = failure === null ? null : failureKeyText(t, failure);

  return (
    <main className="owb-login" data-onboarding-surface="login">
      <section className="owb-login__card" aria-labelledby={`${fieldId}-title`}>
        <h1 className="owb-login__title" id={`${fieldId}-title`}>{t("onboarding.login.title")}</h1>
        <p className="owb-login__subtitle">{t("onboarding.login.subtitle")}</p>

        <div className="owb-login__tabs" role="tablist" aria-label={t("onboarding.login.tabsAria")}>
          <button
            type="button"
            role="tab"
            id={`${fieldId}-tab-signin`}
            aria-selected={mode === "signIn"}
            aria-controls={`${fieldId}-panel`}
            className="owb-login__tab"
            onClick={() => switchMode("signIn")}
            onKeyDown={onTabKeyDown}
          >
            {t("onboarding.login.tabSignIn")}
          </button>
          <button
            type="button"
            role="tab"
            id={`${fieldId}-tab-signup`}
            aria-selected={mode === "signUp"}
            aria-controls={`${fieldId}-panel`}
            className="owb-login__tab"
            onClick={() => switchMode("signUp")}
            onKeyDown={onTabKeyDown}
          >
            {t("onboarding.login.tabSignUp")}
          </button>
        </div>

        {expiredNotice ? (
          <p className="owb-login__notice" data-variant="expired">{t("onboarding.login.expiredNotice")}</p>
        ) : null}

        {failureText !== null ? (
          <p className="owb-login__notice" data-variant="failure" role="alert">{failureText}</p>
        ) : null}

        <form
          className="owb-login__form"
          id={`${fieldId}-panel`}
          role="tabpanel"
          aria-labelledby={mode === "signIn" ? `${fieldId}-tab-signin` : `${fieldId}-tab-signup`}
          noValidate
          onSubmit={(event) => { event.preventDefault(); submit(); }}
        >
          <div className="owb-login__field">
            <label htmlFor={emailId}>{t("onboarding.login.email")}</label>
            <input
              id={emailId}
              ref={emailRef}
              type="email"
              name="email"
              autoComplete="email"
              spellCheck={false}
              placeholder={t("onboarding.login.emailPh")}
              value={email}
              aria-invalid={errors.email !== undefined}
              aria-describedby={errors.email !== undefined ? emailErrorId : undefined}
              onChange={(event) => {
                const next = event.target.value;
                setEmail(next);
                setErrors((current) => ({ ...current, email: undefined }));
              }}
            />
            {errors.email !== undefined ? (
              <p className="owb-login__field-error" id={emailErrorId}>{t(errors.email)}</p>
            ) : null}
          </div>

          <div className="owb-login__field">
            <label htmlFor={passwordId}>{t("onboarding.login.password")}</label>
            <input
              id={passwordId}
              type="password"
              name="password"
              autoComplete={mode === "signIn" ? "current-password" : "new-password"}
              placeholder={t("onboarding.login.passwordPh")}
              value={password}
              aria-invalid={errors.password !== undefined}
              aria-describedby={errors.password !== undefined ? passwordErrorId : undefined}
              onChange={(event) => {
                const next = event.target.value;
                setPassword(next);
                setErrors((current) => ({ ...current, password: undefined }));
              }}
            />
            {errors.password !== undefined ? (
              <p className="owb-login__field-error" id={passwordErrorId}>{t(errors.password)}</p>
            ) : null}
            {mode === "signUp" ? (
              <p className="owb-login__hint">{t("onboarding.login.passwordHint", { count: MIN_PASSWORD_LENGTH })}</p>
            ) : null}
          </div>

          <button type="submit" className="owb-login__submit" disabled={busy} aria-busy={busy}>
            {busy
              ? t("onboarding.login.busy")
              : mode === "signIn" ? t("onboarding.login.submitSignIn") : t("onboarding.login.submitSignUp")}
          </button>
        </form>

        <button
          type="button"
          className="owb-login__link"
          disabled={onForgotPassword === undefined}
          onClick={() => onForgotPassword?.()}
        >
          {t("onboarding.login.forgot")}
        </button>

        <p className="owb-login__legal">{t("onboarding.login.legal")}</p>
      </section>
    </main>
  );
}

function failureKeyText(t: OwbT, failure: OnboardingAuthFailure): string {
  return t(FAILURE_KEYS[failure]);
}
