import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Spin, Switch, Tag } from "antd";
import { FlaskConical, Folder, Info, Store } from "lucide-react";
import { EXPERIMENTS_CHANGED, useWorkspaceExperiments, type ExperimentScope } from "../experiments/useWorkspaceExperiments";
import { useExperimentCopy } from "../locales/experiments";
import "../experiments/experiments.css";

type Notice = "enabledNotice" | "disabledNotice" | "shelfEnabledNotice" | "shelfDisabledNotice";

export function ExperimentalSettings(scope: ExperimentScope) {
  const c = useExperimentCopy();
  const { snapshot, loading, error, refresh, current, owner } = useWorkspaceExperiments(scope);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const saveVersion = useRef(0);
  useEffect(() => { ++saveVersion.current; setConfirm(false); setSaving(false); setSaveError(false); setNotice(null); }, [owner]);
  /** Writes both preview flags every time: the record carries one revision for the
   *  whole file, so a partial write would silently drop the other preview. */
  async function update(patch: { enabled?: boolean; marketplaceShelf?: boolean }) {
    if (!snapshot || saving || !window.owb.experiments) return;
    const next = { enabled: patch.enabled ?? snapshot.enabled, marketplaceShelf: patch.marketplaceShelf ?? snapshot.marketplaceShelf };
    const id = ++saveVersion.current;
    setConfirm(false); setSaving(true); setSaveError(false); setNotice(null);
    try {
      const { workspacePath, workspaceSession, revision } = snapshot;
      const response = await window.owb.experiments.update({ workspacePath, workspaceSession, revision, ...next });
      if (!current() || saveVersion.current !== id) return;
      if (response.status !== 200 || response.body.workspacePath !== workspacePath || response.body.workspaceSession !== workspaceSession ||
        response.body.enabled !== next.enabled || response.body.marketplaceShelf !== next.marketplaceShelf) throw Error("not saved");
      setNotice(patch.enabled === undefined
        ? next.marketplaceShelf ? "shelfEnabledNotice" : "shelfDisabledNotice"
        : next.enabled ? "enabledNotice" : "disabledNotice");
      window.dispatchEvent(new CustomEvent(EXPERIMENTS_CHANGED, { detail: { workspacePath } }));
    } catch {
      if (current() && saveVersion.current === id) setSaveError(true);
    } finally {
      if (current() && saveVersion.current === id) setSaving(false);
    }
  }
  if (!scope.workspacePath) return <Alert type="info" showIcon title={c("empty")} />;
  return <section className="owb-experiment" aria-label={c("title")}>
    <p className="owb-experiment__scope"><Folder size={16} aria-hidden="true" /><span>{c("scope")}<code>{scope.workspacePath}</code></span></p>
    <div className="owb-config-card owb-experiment__card">
    <header className="owb-experiment__heading"><div><h2><FlaskConical size={16} aria-hidden="true" />{c("title")} <Tag>{c("preview")}</Tag></h2><p>{c("description")}</p></div><Switch aria-label={c("title")} checked={snapshot?.enabled ?? false} loading={saving} disabled={!snapshot || loading || saving || snapshot.availability === "storage_error"} onChange={enabled => enabled ? setConfirm(true) : void update({ enabled: false })} /></header>
    {loading ? <div role="status"><Spin size="small" /> {c("loading")}</div> : null}
    {error ? <Alert type="error" showIcon title={c("loadError")} action={<Button onClick={() => void refresh()}>{c("retry")}</Button>} /> : null}
    {saveError ? <Alert type="error" showIcon title={c("saveError")} action={<Button onClick={() => { setSaveError(false); void refresh(); }}>{c("refresh")}</Button>} /> : null}
    {notice ? <p role="status">{c(notice)}</p> : null}
    {snapshot ? <>
      <dl className="owb-experiment__facts"><div><dt>{c("provider")}</dt><dd>{snapshot.provider.name} · <code className="owb-experiment__endpoint">{snapshot.provider.endpointUrl}</code></dd></div></dl>
      <p>{c("sends")}</p><p className="owb-settings-module__hint">{c("excludes")}</p>
      {snapshot.availability === "storage_error" ? <Alert type="warning" showIcon title={c("storageError")} action={<Button loading={saving} onClick={() => void update({ enabled: false, marketplaceShelf: false })}>{c("restoreOff")}</Button>} /> : !snapshot.provider.configured ? <Alert type={snapshot.enabled ? "warning" : "info"} showIcon title={c("unavailable")} action={<Button onClick={() => void refresh()}>{c("refresh")}</Button>} /> : null}
      <p role="status" className="owb-experiment__state">{c(snapshot.enabled ? snapshot.availability === "ready" ? "ready" : "enabledUnavailable" : "off")}</p>
    </> : null}
    </div>
    <div className="owb-config-card owb-experiment__card">
      <header className="owb-experiment__heading"><div><h2><Store size={16} aria-hidden="true" />{c("shelfTitle")} <Tag>{c("preview")}</Tag></h2><p>{c("shelfDescription")}</p></div><Switch aria-label={c("shelfTitle")} checked={snapshot?.marketplaceShelf ?? false} loading={saving} disabled={!snapshot || loading || saving || snapshot.availability === "storage_error"} onChange={marketplaceShelf => void update({ marketplaceShelf })} /></header>
      <p className="owb-settings-module__hint">{c("shelfNoProvider")}</p>
      {snapshot ? <p role="status" className="owb-experiment__state">{c(snapshot.marketplaceShelf ? "shelfReady" : "shelfOff")}</p> : null}
    </div>
    <p className="owb-config-info"><Info size={16} aria-hidden="true" />{c("advisory")}</p>
    <Modal className="owb-config-modal" open={confirm && !!snapshot} title={c("confirmTitle")} okText={c("confirm")} cancelText={c("cancel")} cancelButtonProps={{ "aria-label": c("cancel") }} onCancel={() => setConfirm(false)} onOk={() => void update({ enabled: true })}>
      <p>{c("scope")}</p><p className="owb-experiment__path"><code>{scope.workspacePath}</code></p>
      <p>{c("provider")}：{snapshot?.provider.name} · <code className="owb-experiment__endpoint">{snapshot?.provider.endpointUrl}</code></p>
      <p>{c("sends")}</p><p>{c("excludes")}</p><p>{c("incomplete")}</p>
    </Modal>
  </section>;
}
