import { useEffect, useState } from "react";
import { Alert, Button, Modal, Tooltip } from "antd";
import { ExternalLink, Link2, Settings2 } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { ExternalServiceKind } from "@roleweave/shared";
import { ServiceConnections, SERVICES_CHANGED, serviceErrorKey } from "./ServiceConnections";

/** The native app is opened by the shell from its saved connection. This
 * component never supplies a URL or injects the integration token into it. */
export function ServiceLaunch({ kind }: { kind: ExternalServiceKind }) {
  const t = useT();
  const name = kind === "doc" ? "Doc" : "Mem";
  const [configured, setConfigured] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setConfigured(false); setEditing(false); setError(null);
    const refresh = () => {
      if (!window.owb.services) return;
      void window.owb.services.list().then((response) => {
        if (!cancelled && response.status === 200) setConfigured(response.body.connections.some((view) => view.kind === kind && view.configured));
      }).catch(() => { if (!cancelled) setConfigured(false); });
    };
    refresh(); window.addEventListener(SERVICES_CHANGED, refresh);
    return () => { cancelled = true; window.removeEventListener(SERVICES_CHANGED, refresh); };
  }, [kind]);
  if (!window.owb.services) return null;
  async function open() {
    setBusy(true); setError(null);
    try {
      const response = await window.owb.services.open(kind);
      if (response.status !== 200) { setError(serviceErrorKey(response.body)); setEditing(true); }
    } catch { setError("services.failed"); setEditing(true); }
    finally { setBusy(false); }
  }
  return <div className="owb-service-launch">
    <Button size="small" loading={busy} icon={configured ? <ExternalLink size={13} /> : <Link2 size={13} />}
      onClick={() => { if (configured) void open(); else setEditing(true); }}>{t(configured ? "services.open" : "services.connect", { name })}</Button>
    {configured ? <Tooltip title={t("services.manage")}><Button size="small" type="text" aria-label={t("services.manage")}
      icon={<Settings2 size={13} />} onClick={() => setEditing(true)} /></Tooltip> : null}
    <Modal className="owb-service-dialog" title={t("services.connectionAria", { name })} open={editing}
      onCancel={() => { setEditing(false); setError(null); }} footer={null} width={680} destroyOnHidden>
      {error ? <Alert type="error" showIcon title={t(error)} /> : null}
      <ServiceConnections kind={kind} />
    </Modal>
  </div>;
}
