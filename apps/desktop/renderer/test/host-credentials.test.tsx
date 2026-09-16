import { createRequire } from "node:module";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwbI18nProvider } from "@roleweave/ui";
import { HostCredentials } from "../src/settings/HostCredentials";
import { CREDENTIAL_FIELDS, credentialViews, validCredential, type CredentialKey, type SettingsSnapshot } from "../src/settings/credential-settings";

const SECRET = "test-secret-for-ui-only-220-abcd";
const require = createRequire(import.meta.url);
const mainValidation = require("../../src/credential-settings.cjs");
const snapshot = (): SettingsSnapshot => ({ ok: true, storageAvailable: true,
  credentials: CREDENTIAL_FIELDS.map(({ key }) => ({ key, configured: false, last4: null })) });

function bridge(initial: SettingsSnapshot = snapshot()) {
  let current = initial;
  const settings = {
    get: vi.fn(async () => current),
    set: vi.fn(async (key: CredentialKey, value: string) => {
      if (current.ok) current = { ...current, credentials: current.credentials.map((entry) => entry.key === key ? { key, configured: true, last4: value.slice(-4) } : entry) };
      return { ok: true };
    }),
    clear: vi.fn(async (key: CredentialKey) => {
      if (current.ok) current = { ...current, credentials: current.credentials.map((entry) => entry.key === key ? { key, configured: false, last4: null } : entry) };
      return { ok: true };
    }),
  };
  Object.defineProperty(window, "owb", { configurable: true, value: { settings } });
  return settings;
}
function show() { return render(<OwbI18nProvider locale="en"><HostCredentials /></OwbI18nProvider>); }
function form(name = "Qoder Personal access token") { return screen.getByRole("form", { name }); }
function input(target: HTMLElement) { return target.querySelector("input")!; }
afterEach(() => vi.restoreAllMocks());

it("renders a loading state, then all unconfigured fields and exact env-variable guides", async () => {
  const api = bridge();
  let resolve!: (value: SettingsSnapshot) => void;
  api.get.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  show();
  expect(screen.getByText("Loading credential settings…")).toBeInTheDocument();
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  await act(async () => resolve(snapshot()));
  expect(screen.getAllByText("Not configured")).toHaveLength(6);
  for (const { key } of CREDENTIAL_FIELDS) expect(screen.getByText(key)).toBeInTheDocument();
  for (const button of screen.getAllByRole("button", { name: "Clear" })) expect(button).toBeDisabled();
  expect(screen.getByText(/Launch-environment settings take precedence/)).toBeInTheDocument();
  expect(screen.getByText(/control plane next starts/)).toBeInTheDocument();
});

it("shows only configured status and suffix, never pre-fills stored credentials", async () => {
  const state = snapshot();
  if (!state.ok) throw new Error();
  state.credentials[0] = { key: "QODER_PERSONAL_ACCESS_TOKEN", configured: true, last4: "abcd" };
  bridge(state);
  const view = show();
  expect(await screen.findByText("Configured · ••••abcd")).toBeInTheDocument();
  expect(input(form())).toHaveValue("");
  expect(input(form())).toHaveAttribute("type", "password");
  expect(view.container.innerHTML).not.toContain(SECRET);
  expect(within(form()).getByRole("button", { name: "Clear" })).toBeEnabled();
});

it("saves through the bridge once, clears typed DOM values before awaiting, and can clear a saved key", async () => {
  const api = bridge();
  const view = show();
  await screen.findAllByText("Not configured");
  const field = input(form());
  fireEvent.change(field, { target: { value: SECRET } });
  // The value is a DOM property, never a React value prop/HTML attribute.
  expect(field.value).toBe(SECRET);
  expect(field.getAttribute("value")).toBeNull();
  expect(view.container.innerHTML).not.toContain(SECRET);
  fireEvent.submit(form());
  expect(field.value).toBe("");
  expect(api.set).toHaveBeenCalledExactlyOnceWith("QODER_PERSONAL_ACCESS_TOKEN", SECRET);
  expect(await screen.findByText("Configured · ••••abcd")).toBeInTheDocument();
  expect(screen.getByText("Saved securely. Applies on the next control-plane start.")).toBeInTheDocument();
  fireEvent.click(within(form()).getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(screen.getAllByText("Not configured")).toHaveLength(6));
  expect(api.clear).toHaveBeenCalledExactlyOnceWith("QODER_PERSONAL_ACCESS_TOKEN");
  expect(view.container.innerHTML).not.toContain(SECRET);
});

it("disables edits during save and never stores raw bridge errors or logs secrets", async () => {
  const api = bridge();
  let reject!: (reason: Error) => void;
  api.set.mockReturnValueOnce(new Promise((_done, fail) => { reject = fail; }));
  const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
  const view = show();
  await screen.findAllByText("Not configured");
  fireEvent.change(input(form()), { target: { value: SECRET } });
  fireEvent.submit(form());
  expect(input(form())).toHaveValue("");
  expect(input(form())).toBeDisabled();
  expect(within(form()).getByRole("button", { name: "Clear" })).toBeDisabled();
  await act(async () => reject(new Error(`IPC failed with ${SECRET}`)));
  expect(screen.getByRole("alert")).toHaveTextContent("The credential change could not be saved.");
  expect(view.container.innerHTML).not.toContain(SECRET);
  expect(input(form())).toHaveValue("");
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});

it("reports unavailable secure storage and retryable read failures without raw error text", async () => {
  const api = bridge();
  api.get.mockRejectedValueOnce(new Error(SECRET));
  const view = show();
  expect(await screen.findByText(/Credential settings could not be read/)).toBeInTheDocument();
  expect(view.container.innerHTML).not.toContain(SECRET);
  const unavailable = snapshot();
  if (!unavailable.ok) throw new Error();
  unavailable.storageAvailable = false;
  api.get.mockResolvedValueOnce(unavailable);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText(/Secure storage is unavailable/)).toBeInTheDocument();
  expect(input(form())).toBeDisabled();
  expect(within(form()).getByRole("button", { name: "Save" })).toBeDisabled();
});

it("projects bridge metadata to a redacted state and rejects malformed suffixes", async () => {
  const state = snapshot();
  if (!state.ok) throw new Error();
  const untrusted = state.credentials.map((entry) => ({ ...entry, value: SECRET, request: { value: SECRET } }));
  expect(JSON.stringify(credentialViews(untrusted))).not.toContain(SECRET);
  untrusted[0] = { ...untrusted[0]!, configured: true, last4: SECRET };
  expect(credentialViews(untrusted)).toBeNull();
  bridge({ ...state, credentials: untrusted });
  const view = show();
  expect(await screen.findByText(/Credential settings could not be read/)).toBeInTheDocument();
  expect(view.container.innerHTML).not.toContain(SECRET);
});

describe("form validation", () => {
  it.each(["", "abcd", "contains whitespace", "newline\nsecret", "x".repeat(8193)])("rejects invalid key case %# without submitting or echoing it", async (value) => {
    const api = bridge();
    const view = show();
    await screen.findAllByText("Not configured");
    // Browser password controls strip newlines; test the validator directly too.
    expect(validCredential("QODER_PERSONAL_ACCESS_TOKEN", value)).toBe(false);
    if (value.includes("\n")) return;
    fireEvent.change(input(form()), { target: { value } });
    fireEvent.submit(form());
    expect(screen.getByRole("alert")).toHaveTextContent("Enter 5–8192 characters");
    expect(input(form())).toHaveValue("");
    expect(api.set).not.toHaveBeenCalled();
    if (value) expect(view.container.innerHTML).not.toContain(value);
  });

  it.each(["not-a-url", "http://provider.example", "https://user:secret@provider.example", "https://provider.example/?token=secret", "https://provider.example/#secret"])("rejects unsafe endpoint case %#", async (value) => {
    const api = bridge();
    show();
    await screen.findAllByText("Not configured");
    const target = form("Codex Base URL (optional)");
    fireEvent.change(input(target), { target: { value } });
    fireEvent.submit(target);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an HTTPS URL");
    expect(input(target)).toHaveValue("");
    expect(api.set).not.toHaveBeenCalled();
  });

  it("keeps the renderer field allowlist and validation aligned with the main process", () => {
    expect(CREDENTIAL_FIELDS.map((field) => field.key)).toEqual(mainValidation.KEYS);
    for (const { key } of CREDENTIAL_FIELDS) {
      for (const value of ["", "abcd", "abcde", SECRET, "space value", "tab\tvalue", "nul\0value", "x".repeat(8193), "https://provider.example/v1", "http://localhost:8080", "http://[::1]:8080", "http://remote.example", "https://user:secret@provider.example", "https://provider.example/?key=secret"]) {
        expect(validCredential(key, value)).toBe(mainValidation.validValue(key, value));
      }
    }
  });
});
