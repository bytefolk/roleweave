import { useCallback, useState, type FormEvent } from "react";
import { Alert, Button } from "antd";
import { Plus, Trash2 } from "lucide-react";
import { useT } from "@roleweave/ui";
import { useDeploymentAuth } from "./deployment-auth-context";
import "./deployment-login.css";

export function LoginModule() {
  const t = useT();
  const { sessions, activeUrl, loading, login, logout, setActive, clearAll } = useDeploymentAuth();
  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState("");
  const [identity, setIdentity] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || loading) return;
    setError(null);
    if (!url.trim() || !identity.trim() || !token.trim()) {
      setError("deploy.login.fieldRequired");
      return;
    }
    let normalizedUrl = url.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = `http://${normalizedUrl}`;
    try { new URL(normalizedUrl); } catch {
      setError("deploy.login.invalidUrl");
      return;
    }
    setBusy(true);
    const provider = isLocalUrl(normalizedUrl) ? "local" : "remote";
    const ok = await login(normalizedUrl, provider, identity.trim(), token.trim());
    setBusy(false);
    if (!ok) {
      setError("deploy.login.saveFailed");
      return;
    }
    setUrl("");
    setIdentity("");
    setToken("");
    setShowForm(false);
  }, [busy, loading, url, identity, token, login]);

  const handleRemove = useCallback(async (deploymentUrl: string) => {
    if (busy) return;
    setBusy(true);
    await logout(deploymentUrl);
    setBusy(false);
  }, [busy, logout]);

  const handleSelect = useCallback((deploymentUrl: string) => {
    setActive(deploymentUrl === activeUrl ? null : deploymentUrl);
  }, [activeUrl, setActive]);

  const handleClearAll = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    await clearAll();
    setBusy(false);
  }, [busy, clearAll]);

  return (
    <section className="owb-settings-module__pane" aria-label={t("deploy.title")}>
      <header className="owb-settings-module__pane-header">
        <h2>{t("deploy.title")}</h2>
      </header>
      <p className="owb-settings-module__hint">{t("deploy.description")}</p>

      {loading ? <div role="status">{t("deploy.loading")}</div> : null}

      {!loading && sessions.length > 0 ? (
        <ul className="owb-deploy-sessions" aria-label={t("deploy.savedDeployments")}>
          {sessions.map((session) => (
            <li key={session.deploymentUrl} className={`owb-deploy-session${session.deploymentUrl === activeUrl ? " is-active" : ""}`}>
              <button
                type="button"
                className="owb-deploy-session__select"
                onClick={() => handleSelect(session.deploymentUrl)}
                aria-pressed={session.deploymentUrl === activeUrl}
              >
                <span className="owb-deploy-session__url">{session.deploymentUrl}</span>
                <span className="owb-deploy-session__identity">{session.accountIdentity}</span>
                <span className="owb-deploy-session__provider">{t(session.provider === "local" ? "deploy.provider.local" : "deploy.provider.remote")}</span>
              </button>
              <button
                type="button"
                className="owb-deploy-session__remove"
                onClick={() => void handleRemove(session.deploymentUrl)}
                disabled={busy}
                aria-label={t("deploy.remove")}
                title={t("deploy.remove")}
              >
                <Trash2 aria-hidden="true" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {!loading && sessions.length > 1 ? (
        <div className="owb-settings-module__actions">
          <Button size="small" danger onClick={() => void handleClearAll()} disabled={busy}>
            {t("deploy.clearAll")}
          </Button>
        </div>
      ) : null}

      {showForm ? (
        <form className="owb-deploy-login-form" onSubmit={(e) => void handleSubmit(e)} noValidate autoComplete="off">
          <label className="owb-deploy-login-field">
            <span>{t("deploy.login.url")}</span>
            <input
              type="text"
              className="ant-input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              disabled={busy}
              autoFocus
            />
          </label>
          <label className="owb-deploy-login-field">
            <span>{t("deploy.login.identity")}</span>
            <input
              type="text"
              className="ant-input"
              value={identity}
              onChange={(e) => setIdentity(e.target.value)}
              placeholder={t("deploy.login.identityPlaceholder")}
              disabled={busy}
              autoComplete="username"
            />
          </label>
          <label className="owb-deploy-login-field">
            <span>{t("deploy.login.token")}</span>
            <input
              type="password"
              className="ant-input"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("deploy.login.tokenPlaceholder")}
              disabled={busy}
              autoComplete="new-password"
            />
          </label>
          {error ? <Alert type="error" showIcon message={t(error)} /> : null}
          <div className="owb-deploy-login-actions">
            <Button type="primary" htmlType="submit" loading={busy}>{t("deploy.login.save")}</Button>
            <Button onClick={() => { setShowForm(false); setError(null); }} disabled={busy}>{t("deploy.login.cancel")}</Button>
          </div>
        </form>
      ) : (
        <div className="owb-settings-module__actions">
          <Button type="primary" icon={<Plus aria-hidden="true" size={14} />} onClick={() => setShowForm(true)} disabled={loading || busy}>
            {t("deploy.addDeployment")}
          </Button>
        </div>
      )}
    </section>
  );
}

function isLocalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return ["localhost", "[::1]"].includes(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  } catch { return false; }
}
