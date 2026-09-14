import { useEffect, useState } from "react";
import { Alert, Button, Checkbox, Input, Spin, Tag } from "antd";
import { ExternalLink, Link2, RefreshCw, Save, Unplug } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { ExternalServiceKind, ServiceConnectionView, ServiceProbe, ServiceRelease } from "@roleweave/shared";
import "./service-connections.css";

export const SERVICES_CHANGED = "owb:services-changed";
const emptyConnection = (kind: ExternalServiceKind): ServiceConnectionView => ({
  kind, apiUrl: null, webUrl: null, workspaceId: null, configured: false, tokenConfigured: false,
});

export function serviceErrorKey(body: unknown): string {
  const code = body && typeof body === "object" && "code" in body ? String(body.code) : "";
  if (code === "service_storage_unavailable") return "services.storageError";
  if (code === "service_request_invalid") return "services.invalid";
  if (code === "service_unconfigured") return "services.notConfigured";
  return "services.failed";
}

function ConnectionForm({ connection, onChange }: { connection: ServiceConnectionView; onChange: (view: ServiceConnectionView) => void }) {
  const t = useT();
  const kind = connection.kind;
  const name = kind === "doc" ? "Doc" : "Mem";
  const [apiUrl, setApiUrl] = useState(connection.apiUrl ?? "");
  const [webUrl, setWebUrl] = useState(connection.webUrl ?? "");
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(connection.workspaceId ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "error" | "success"; key: string } | null>(null);
  const [probe, setProbe] = useState<ServiceProbe | null>(null);
  const [release, setRelease] = useState<ServiceRelease | null>(null);

  useEffect(() => {
    setApiUrl(connection.apiUrl ?? "");
    setWebUrl(connection.webUrl ?? "");
    setWorkspaceId(connection.workspaceId ?? "");
    setToken(""); setClearToken(false);
  }, [connection]);

  async function run(action: string, operation: () => Promise<void>) {
    setBusy(action); setNotice(null);
    try { await operation(); }
    catch { setNotice({ type: "error", key: "services.failed" }); }
    finally { setBusy(null); }
  }
  async function save() {
    let response;
    try {
      response = await window.owb.services.configure({ kind, apiUrl: apiUrl.trim(), webUrl: webUrl.trim(),
        ...(kind === "mem" ? { workspaceId: workspaceId.trim() } : {}),
        ...(clearToken ? { token: "" } : token ? { token } : {}),
      });
    } finally {
      // Never retain a submitted PAT, including when the IPC call fails.
      setToken("");
    }
    if (response.status !== 200) { setNotice({ type: "error", key: serviceErrorKey(response.body) }); return; }
    setProbe(null); onChange(response.body);
    setNotice({ type: "success", key: "services.saved" });
    window.dispatchEvent(new Event(SERVICES_CHANGED));
  }
  async function check() {
    const response = await window.owb.services.probe(kind);
    if (response.status !== 200) { setNotice({ type: "error", key: serviceErrorKey(response.body) }); return; }
    setProbe(response.body);
  }
  async function checkRelease() {
    const response = await window.owb.services.release(kind);
    if (response.status !== 200) { setNotice({ type: "error", key: serviceErrorKey(response.body) }); return; }
    setRelease(response.body);
  }
  async function disconnect() {
    const response = await window.owb.services.disconnect(kind);
    if (response.status !== 200) { setNotice({ type: "error", key: serviceErrorKey(response.body) }); return; }
    setProbe(null); onChange(response.body);
    setNotice({ type: "success", key: "services.disconnected" });
    window.dispatchEvent(new Event(SERVICES_CHANGED));
  }
  async function open() {
    const response = await window.owb.services.open(kind);
    if (response.status !== 200) setNotice({ type: "error", key: serviceErrorKey(response.body) });
  }

  return <form className="owb-service-connection" aria-label={t("services.connectionAria", { name })}
    onSubmit={(event) => { event.preventDefault(); void run("save", save); }}>
    <header className="owb-service-connection__header">
      <h3>{name}</h3>
      <Tag>{t(connection.configured ? "services.configured" : "services.notConfigured")}</Tag>
      <Button size="small" icon={<ExternalLink size={14} aria-hidden="true" />} disabled={!connection.configured || !!busy}
        onClick={() => void run("open", open)}>{t("services.open", { name })}</Button>
    </header>
    <p className="owb-settings-module__hint">{t(`services.${kind}Description`)}</p>
    <div className="owb-service-connection__fields">
      <label htmlFor={`service-${kind}-api`}>
        <span>{t("services.apiUrl")}</span>
        <Input id={`service-${kind}-api`} value={apiUrl} required disabled={!!busy}
          placeholder={kind === "doc" ? "http://localhost:3100" : "http://localhost:8080"}
          onChange={(event) => setApiUrl(event.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <label htmlFor={`service-${kind}-web`}>
        <span>{t("services.webUrl")}</span>
        <Input id={`service-${kind}-web`} value={webUrl} disabled={!!busy} placeholder={t("services.webPlaceholder")}
          onChange={(event) => setWebUrl(event.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <label htmlFor={`service-${kind}-token`}>
        <span>{t("services.token")}</span>
        <Input.Password id={`service-${kind}-token`} value={token} disabled={!!busy || clearToken}
          placeholder={t(connection.tokenConfigured ? "services.tokenSaved" : "services.tokenPlaceholder")}
          onChange={(event) => setToken(event.target.value)} autoComplete="new-password" />
      </label>
      {kind === "mem" ? <label htmlFor="service-mem-workspace">
        <span>{t("services.workspace")}</span>
        <Input id="service-mem-workspace" value={workspaceId} disabled={!!busy} placeholder={t("services.workspacePlaceholder")}
          onChange={(event) => setWorkspaceId(event.target.value)} autoComplete="off" spellCheck={false} />
      </label> : null}
    </div>
    {connection.tokenConfigured ? <Checkbox checked={clearToken} disabled={!!busy}
      onChange={(event) => { setClearToken(event.target.checked); setToken(""); }}>{t("services.clearToken")}</Checkbox> : null}
    <p className="owb-settings-module__hint">{t("services.addressHint")}</p>
    <div className="owb-settings-module__actions">
      <Button htmlType="submit" type="primary" icon={<Save size={14} aria-hidden="true" />} loading={busy === "save"} disabled={!!busy || !apiUrl.trim()}>{t("services.save")}</Button>
      <Button icon={<Link2 size={14} aria-hidden="true" />} loading={busy === "probe"} disabled={!!busy || !connection.configured}
        onClick={() => void run("probe", check)}>{t("services.check")}</Button>
      <Button icon={<Unplug size={14} aria-hidden="true" />} disabled={!!busy || !connection.configured}
        onClick={() => void run("disconnect", disconnect)}>{t("services.disconnect")}</Button>
    </div>
    {notice ? <Alert showIcon type={notice.type} title={t(notice.key)} /> : null}
    {probe ? <Alert showIcon type={probe.state === "ready" ? "success" : "warning"}
      title={t(`services.probe.${probe.state}`)}
      description={t("services.probeDetail", { version: probe.version ?? t("services.versionUnreported"), time: new Date(probe.checkedAt).toLocaleString() })} /> : null}
    <div className="owb-service-connection__release">
      <p className="owb-settings-module__hint">{t(kind === "doc" ? "services.docUpdates" : "services.memUpdates")}</p>
      <div className="owb-settings-module__actions">
        <Button size="small" icon={<RefreshCw size={13} aria-hidden="true" />} loading={busy === "release"} disabled={!!busy}
          onClick={() => void run("release", checkRelease)}>{t("services.checkRelease")}</Button>
        <Button size="small" type="link" icon={<ExternalLink size={13} aria-hidden="true" />} disabled={!!busy}
          onClick={() => void run("release-page", async () => {
            const response = await window.owb.services.openRelease(kind);
            if (response.status !== 200) setNotice({ type: "error", key: "services.failed" });
          })}>{t("services.upstream", { name })}</Button>
      </div>
      {release ? <p role="status" className="owb-settings-module__hint">{t(`services.release.${release.state}`, { version: release.version ?? "" })}</p> : null}
    </div>
  </form>;
}

export function ServiceConnections({ kind }: { kind?: ExternalServiceKind }) {
  const t = useT();
  const [connections, setConnections] = useState<ServiceConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!window.owb.services) return;
    void window.owb.services.list().then((response) => {
      if (cancelled) return;
      if (response.status === 200) setConnections(response.body.connections);
      else setError(serviceErrorKey(response.body));
    }).catch(() => { if (!cancelled) setError("services.failed"); });
    return () => { cancelled = true; };
  }, []);
  // Older packaged shells and existing preview fixtures may lack this bridge.
  if (!window.owb.services) return null;
  return <section className="owb-settings-module__pane owb-service-connections" aria-label={t("services.title")}>
    <header className="owb-settings-module__pane-header"><h2>{t("services.title")}</h2></header>
    <p className="owb-settings-module__hint">{t("services.description")}</p>
    {error ? <Alert showIcon type="error" title={t(error)} /> : connections === null ? <Spin /> :
      (kind ? [kind] : ["doc", "mem"] as const).map((serviceKind) =>
        <ConnectionForm key={serviceKind} connection={connections.find((view) => view.kind === serviceKind) ?? emptyConnection(serviceKind)}
          onChange={(view) => setConnections((current) => [...(current ?? []).filter((entry) => entry.kind !== view.kind), view])} />)}
  </section>;
}
