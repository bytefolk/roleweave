import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Spin, Switch, Tag } from "antd";
import { EXPERIMENTS_CHANGED, useWorkspaceExperiments, type ExperimentScope } from "../experiments/useWorkspaceExperiments";
import { useExperimentCopy } from "../locales/experiments";
import "../experiments/experiments.css";

export function ExperimentalSettings(scope: ExperimentScope) {
  const c = useExperimentCopy();
  const { snapshot, loading, error, refresh, current, owner } = useWorkspaceExperiments(scope);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [notice, setNotice] = useState<"enabledNotice" | "disabledNotice" | null>(null);
  const saveVersion = useRef(0);
  useEffect(() => { ++saveVersion.current; setConfirm(false); setSaving(false); setSaveError(false); setNotice(null); }, [owner]);
  async function update(enabled: boolean) {
    if (!snapshot || saving || !window.owb.experiments) return;
    const id = ++saveVersion.current;
    setConfirm(false); setSaving(true); setSaveError(false); setNotice(null);
    try {
      const { workspacePath, workspaceSession, revision } = snapshot;
      const response = await window.owb.experiments.update({ workspacePath, workspaceSession, revision, enabled });
      if (!current() || saveVersion.current !== id) return;
      if (response.status !== 200 || response.body.workspacePath !== workspacePath || response.body.workspaceSession !== workspaceSession || response.body.enabled !== enabled) throw Error("not saved");
      setNotice(enabled ? "enabledNotice" : "disabledNotice");
      window.dispatchEvent(new CustomEvent(EXPERIMENTS_CHANGED, { detail: { workspacePath } }));
    } catch {
      if (current() && saveVersion.current === id) setSaveError(true);
    } finally {
      if (current() && saveVersion.current === id) setSaving(false);
    }
  }
  if (!scope.workspacePath) return <Alert type="info" showIcon title={c("empty")} />;
  return <section className="owb-experiment" aria-label={c("title")}>
    <header className="owb-experiment__heading"><div><h2>{c("title")} <Tag>{c("preview")}</Tag></h2><p>{c("description")}</p></div><Switch aria-label={c("title")} checked={snapshot?.enabled ?? false} loading={saving} disabled={!snapshot || loading || saving || snapshot.availability === "storage_error"} onChange={enabled => enabled ? setConfirm(true) : void update(false)} /></header>
    <p className="owb-experiment__scope">{c("scope")}<code>{scope.workspacePath}</code></p>
    {loading ? <div role="status"><Spin size="small" /> {c("loading")}</div> : null}
    {error ? <Alert type="error" showIcon title={c("loadError")} action={<Button onClick={() => void refresh()}>{c("retry")}</Button>} /> : null}
    {saveError ? <Alert type="error" showIcon title={c("saveError")} action={<Button onClick={() => { setSaveError(false); void refresh(); }}>{c("refresh")}</Button>} /> : null}
    {notice ? <p role="status">{c(notice)}</p> : null}
    {snapshot ? <>
      <dl className="owb-experiment__facts"><div><dt>{c("provider")}</dt><dd>{snapshot.provider.name} · <code>{snapshot.provider.endpointHost}</code></dd></div></dl>
      <p>{c("sends")}</p><p className="owb-settings-module__hint">{c("excludes")}</p>
      {snapshot.availability === "storage_error" ? <Alert type="warning" showIcon title={c("storageError")} action={<Button loading={saving} onClick={() => void update(false)}>{c("restoreOff")}</Button>} /> : !snapshot.provider.configured ? <Alert type={snapshot.enabled ? "warning" : "info"} showIcon title={c("unavailable")} action={<Button onClick={() => void refresh()}>{c("refresh")}</Button>} /> : null}
      <p role="status" className="owb-experiment__state">{c(snapshot.enabled ? snapshot.availability === "ready" ? "ready" : "enabledUnavailable" : "off")}</p>
      <p className="owb-settings-module__hint">{c("advisory")}</p>
    </> : null}
    <Modal open={confirm && !!snapshot} title={c("confirmTitle")} okText={c("confirm")} cancelText={c("cancel")} cancelButtonProps={{ "aria-label": c("cancel") }} onCancel={() => setConfirm(false)} onOk={() => void update(true)}>
      <p>{c("scope")}</p><p className="owb-experiment__path"><code>{scope.workspacePath}</code></p>
      <p>{c("provider")}：{snapshot?.provider.name} · <code>{snapshot?.provider.endpointHost}</code></p>
      <p>{c("sends")}</p><p>{c("excludes")}</p><p>{c("incomplete")}</p>
    </Modal>
  </section>;
}
