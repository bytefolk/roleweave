/**
 * #519 login / register card.
 *
 * Guards three things real products drop easily:
 *   1. no autofocus until the transition is over (the keyboard must not pop up
 *      mid-animation);
 *   2. both forms report errors inline **and** invalid input sends no request;
 *   3. every user-visible string comes from the zh/en catalogs (the English
 *      localization is actually rendered here, not just assumed).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OwbI18nProvider } from "@roleweave/ui";
import { LoginScreen, validateCredentials } from "../src/onboarding/LoginScreen";
import { MIN_PASSWORD_LENGTH } from "../src/onboarding/auth-adapter";

function renderCard(overrides: Partial<Parameters<typeof LoginScreen>[0]> = {}) {
  const props = {
    settled: true,
    busy: false,
    failure: null,
    expiredNotice: false,
    onSubmit: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<LoginScreen {...props} />) };
}

const panel = () => screen.getByRole("tabpanel");
const submit = () => Array.from(panel().querySelectorAll("button")).find((b) => b.type === "submit") as HTMLButtonElement;
const tab = (name: string) => screen.getByRole("tab", { name });
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("#519 credential validation", () => {
  it("requires a syntactically plausible email", () => {
    expect(validateCredentials("signIn", { email: "", password: "whatever" }).email).toBe("onboarding.login.errEmailRequired");
    expect(validateCredentials("signIn", { email: "   ", password: "whatever" }).email).toBe("onboarding.login.errEmailRequired");
    expect(validateCredentials("signIn", { email: "dev@example", password: "whatever" }).email).toBe("onboarding.login.errEmailFormat");
    expect(validateCredentials("signIn", { email: "dev@example.com", password: "whatever" }).email).toBeUndefined();
  });

  it("only enforces the length floor on the sign-up password", () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(validateCredentials("signUp", { email: "dev@example.com", password: short }).password).toBe("onboarding.login.errPasswordShort");
    expect(validateCredentials("signUp", { email: "dev@example.com", password: "a".repeat(MIN_PASSWORD_LENGTH) }).password).toBeUndefined();
    // Sign-in only requires "not empty": password policy belongs to the server,
    // and the client must not reject an existing account on its behalf.
    expect(validateCredentials("signIn", { email: "dev@example.com", password: short }).password).toBeUndefined();
    expect(validateCredentials("signIn", { email: "dev@example.com", password: "" }).password).toBe("onboarding.login.errPasswordRequired");
  });
});

describe("#519 login card", () => {
  it("holds focus back until the transition has finished", () => {
    const { rerender } = render(
      <LoginScreen settled={false} busy={false} failure={null} expiredNotice={false} onSubmit={vi.fn()} />,
    );
    expect(document.activeElement).not.toBe(screen.getByLabelText("邮箱"));

    rerender(<LoginScreen settled busy={false} failure={null} expiredNotice={false} onSubmit={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByLabelText("邮箱"));
  });

  it("reports empty and malformed input inline and sends nothing", () => {
    const { props } = renderCard();
    fireEvent.click(submit());
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("请输入邮箱。")).toBeInTheDocument();
    expect(screen.getByText("请输入密码。")).toBeInTheDocument();

    fill("邮箱", "not-an-email");
    fireEvent.click(submit());
    expect(screen.getByText("邮箱格式不正确。")).toBeInTheDocument();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("clears a field's error as soon as the user edits it again", () => {
    renderCard();
    fireEvent.click(submit());
    expect(screen.getByText("请输入邮箱。")).toBeInTheDocument();
    fill("邮箱", "dev@example.com");
    expect(screen.queryByText("请输入邮箱。")).toBeNull();
  });

  it("reaches sign-in and sign-up from the one card, and keeps the password out of the switch", () => {
    const { props } = renderCard();
    fill("邮箱", "dev@example.com");
    fill("密码", "correct-horse");
    fireEvent.click(tab("创建账号"));
    expect(tab("创建账号")).toHaveAttribute("aria-selected", "true");
    expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("");
    expect(screen.getByText(`至少 ${MIN_PASSWORD_LENGTH} 位字符。`)).toBeInTheDocument();

    fill("密码", "a".repeat(MIN_PASSWORD_LENGTH));
    fireEvent.click(submit());
    expect(props.onSubmit).toHaveBeenCalledWith("signUp", { email: "dev@example.com", password: "a".repeat(MIN_PASSWORD_LENGTH) });
  });

  it("switches tabs from the keyboard", () => {
    renderCard();
    fireEvent.keyDown(tab("登录"), { key: "ArrowRight" });
    expect(tab("创建账号")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tab("创建账号"), { key: "ArrowLeft" });
    expect(tab("登录")).toHaveAttribute("aria-selected", "true");
  });

  it("shows the expired-session notice without blocking the card", () => {
    renderCard({ expiredNotice: true });
    expect(screen.getByText("上一次的登录已过期，请重新登录。")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(submit()).toBeEnabled();
  });

  it("maps every adapter failure to an inline alert and stays on the card", () => {
    const cases = [
      ["invalid_credentials", "邮箱或密码不正确。"],
      ["email_taken", "该邮箱已注册，请直接登录。"],
      ["unreachable", "无法连接认证服务，请稍后重试。"],
    ] as const;
    for (const [failure, copy] of cases) {
      const view = renderCard({ failure });
      expect(screen.getByRole("alert")).toHaveTextContent(copy);
      expect(screen.queryByRole("dialog")).toBeNull();
      view.unmount();
    }
  });

  it("disables the submit button while a request is in flight", () => {
    renderCard({ busy: true });
    expect(submit()).toBeDisabled();
    expect(submit()).toHaveAttribute("aria-busy", "true");
  });

  it("keeps the forgot-password row inert until #395 wires a handler", () => {
    const first = renderCard();
    expect(screen.getByRole("button", { name: "忘记密码？" })).toBeDisabled();
    first.unmount();

    const onForgotPassword = vi.fn();
    renderCard({ onForgotPassword });
    const link = screen.getByRole("button", { name: "忘记密码？" });
    expect(link).toBeEnabled();
    fireEvent.click(link);
    expect(onForgotPassword).toHaveBeenCalledTimes(1);
  });

  it("renders the English catalog for the same card", () => {
    render(
      <OwbI18nProvider locale="en">
        <LoginScreen settled busy={false} failure={null} expiredNotice onSubmit={vi.fn()} />
      </OwbI18nProvider>,
    );
    expect(screen.getByRole("tab", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Create account" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByText("Your previous session expired. Sign in again.")).toBeInTheDocument();
  });
});

/* The submit button lives inside the tabpanel; locate it by type=submit so it
   cannot collide with the tab of the same name. */
describe("#519 login card submit", () => {
  it("submits the sign-in form once when Enter is pressed in a field", async () => {
    const onSubmit = vi.fn();
    renderCard({ onSubmit });
    fill("邮箱", "dev@example.com");
    fill("密码", "correct-horse");
    await act(async () => {
      fireEvent.submit(panel() as HTMLFormElement);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
