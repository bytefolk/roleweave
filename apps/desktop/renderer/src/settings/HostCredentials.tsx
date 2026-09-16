import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Alert, Button, Spin } from "antd";
import { useT } from "@roleweave/ui";
import { CREDENTIAL_FIELDS, credentialViews, validCredential, type CredentialKey, type CredentialView } from "./credential-settings";

export function HostCredentials() {
  const t = useT();
  const [rows, setRows] = useState<CredentialView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [storageAvailable, setStorageAvailable] = useState(false);
  const [busy, setBusy] = useState<CredentialKey | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState<{ key?: CredentialKey; message: string; error: boolean } | null>(null);

  const load = useCallback(async (active: () => boolean = () => true) => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const result = await window.owb.settings.get();
      const next = result.ok ? credentialViews(result.credentials) : null;
      if (!active()) return;
      if (!result.ok || !next) throw new Error();
      setRows(next);
      setStorageAvailable(result.storageAvailable === true);
    } catch {
      if (active()) { setRows(null); setStorageAvailable(false); setLoadFailed(true); }
    } finally {
      if (active()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void load(() => active);
    return () => { active = false; };
  }, [load]);

  async function save(event: FormEvent<HTMLFormElement>, key: CredentialKey) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("credential") as HTMLInputElement;
    // A native, uncontrolled password input deliberately bypasses React/antd
    // form state. Never put the value, a request, or a caught error in state.
    let value = input.value;
    input.value = "";
    if (busy || loading || !storageAvailable) return;
    if (!validCredential(key, value)) {
      value = "";
      setNotice({ key, message: key.endsWith("_BASE_URL") ? "credentials.invalidUrl" : "credentials.invalidKey", error: true });
      return;
    }
    setBusy(key);
    setNotice(null);
    try {
      const pending = window.owb.settings.set(key, value);
      value = "";
      const result = await pending;
      if (!result.ok) throw new Error();
      setNotice({ key, message: "credentials.saved", error: false });
      await load();
    } catch {
      setNotice({ key, message: "credentials.failed", error: true });
    } finally {
      value = "";
      setBusy(null);
    }
  }

  async function clear(key: CredentialKey) {
    if (busy || loading) return;
    setBusy(key);
    setNotice(null);
    try {
      const result = await window.owb.settings.clear(key);
      if (!result.ok) throw new Error();
      setNotice({ key, message: "credentials.cleared", error: false });
      await load();
    } catch {
      setNotice({ key, message: "credentials.failed", error: true });
    } finally { setBusy(null); }
  }

  return <section className="owb-settings-module__pane" aria-label={t("credentials.title")}>
    <header className="owb-settings-module__pane-header"><h2>{t("credentials.title")}</h2></header>
    <p className="owb-settings-module__hint">{t("credentials.guide")}</p>
    <p className="owb-settings-module__hint">{t("credentials.precedence")}</p>
    <p className="owb-settings-module__hint">{t("credentials.activation")}</p>
    {loading ? <div role="status"><Spin size="small" /> {t("credentials.loading")}</div> : null}
    {loadFailed ? <Alert type="error" showIcon title={t("credentials.loadFailed")}
      action={<Button onClick={() => void load()}>{t("credentials.retry")}</Button>} /> : null}
    {!loading && !loadFailed && !storageAvailable ? <Alert type="warning" showIcon title={t("credentials.storageUnavailable")} /> : null}
    {rows ? ["Qoder", "Claude", "Codex"].map((host) => <section key={host} className="owb-host-credentials__host" aria-label={host}>
      <h3>{host}</h3>
      {CREDENTIAL_FIELDS.filter((field) => field.host === host).map((field) => {
        const row = rows.find((entry) => entry.key === field.key)!;
        const id = `credential-${field.key}`;
        const rowNotice = notice?.key === field.key ? notice : null;
        return <form key={field.key} aria-label={`${host} ${t(field.label)}`} noValidate autoComplete="off"
          className="owb-host-credentials__field" onSubmit={(event) => void save(event, field.key)}>
          <label htmlFor={id}>{t(field.label)}</label>
          <span className="owb-settings-module__hint" role="status">
            {row.configured ? t("credentials.configured", { last4: row.last4! }) : t("credentials.notConfigured")}
          </span>
          <p id={`${id}-guide`} className="owb-settings-module__hint">{t("credentials.replaces")} <code>{field.key}</code></p>
          <div className="owb-host-credentials__controls">
            <input id={id} name="credential" type="password" className="ant-input owb-host-credentials__input"
              aria-describedby={`${id}-guide${rowNotice?.error ? ` ${id}-error` : ""}`}
              aria-invalid={rowNotice?.error === true} placeholder={t(row.configured ? "credentials.replace" : "credentials.enter")}
              maxLength={field.key.endsWith("_BASE_URL") ? 2048 : 8192} disabled={loading || !!busy || !storageAvailable}
              autoComplete="new-password" autoCapitalize="none" spellCheck={false} />
            <Button htmlType="submit" type="primary" loading={busy === field.key} disabled={loading || !!busy || !storageAvailable}>{t("credentials.save")}</Button>
            <Button disabled={loading || !!busy || !row.configured} onClick={(event) => {
              event.currentTarget.closest("form")?.reset();
              void clear(field.key);
            }}>{t("credentials.clear")}</Button>
          </div>
          {rowNotice ? <div id={`${id}-error`} role={rowNotice.error ? "alert" : "status"} className="owb-settings-module__hint">{t(rowNotice.message)}</div> : null}
        </form>;
      })}
    </section>) : null}
  </section>;
}
