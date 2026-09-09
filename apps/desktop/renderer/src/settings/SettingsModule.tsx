/**
 * Settings surface with the update pane (#134, Lane D of #110).
 *
 * The updater service already exists in the main process (#133) and reports
 * eight states plus one refusal that is not a state. This module is the surface
 * that makes them reachable without a terminal, and the only surface that does:
 * the prefs drawer (#174) stays what it is, two quick toggles for language and
 * theme, and does not grow an update section.
 *
 * Header is title-only, per the chrome discipline from #172/#173/#179.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Progress } from "antd";
import { Download, ExternalLink, RefreshCw, RotateCcw } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { UpdateEvent, UpdateStatus } from "@roleweave/shared";
import {
  stateMessage,
  unavailableMessage,
  updateAffordances,
  type UpdateMessage,
} from "./update-copy";

export function SettingsModule() {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [statusRead, setStatusRead] = useState(false);
  /** The newest live state event. Null until the service reports one, in which
   * case the opening status from the shell is what the pane shows. */
  const [live, setLive] = useState<UpdateEvent | null>(null);
  /** A refusal returned by download/install, held as a catalog key. */
  const [refusal, setRefusal] = useState<UpdateMessage | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await window.owb.update.status();
      if (cancelled) return;
      setStatus(next);
      setStatusRead(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => window.owb.onUpdateState((event) => setLive(event)), []);

  const state = live?.state ?? status?.state ?? "idle";
  const affordances = updateAffordances(status, state);

  const record = useCallback((result: Awaited<ReturnType<typeof window.owb.update.check>>) => {
    if (result === null) return;
    setLive({
      state: result.state,
      reason: result.reason,
      version: result.version,
      percent: result.percent,
    });
    // The refusal is not a state: the service leaves the state alone and says
    // it will not apply an update it cannot verify. Rendering it is the whole
    // reason this branch exists — a state-by-state pane would drop it.
    setRefusal(result.unsigned ? { key: "settings.unsignedBody" } : null);
  }, []);

  const onCheck = useCallback(async () => {
    setRefusal(null);
    record(await window.owb.update.check());
  }, [record]);

  const onDownload = useCallback(async () => {
    record(await window.owb.update.download({ confirmedByUser: true }));
  }, [record]);

  const onInstall = useCallback(async () => {
    record(await window.owb.update.install({ confirmedByUser: true }));
  }, [record]);

  const line = stateMessage({
    state,
    version: live?.version ?? null,
    percent: live?.percent ?? null,
  });

  return (
    <section className="owb-settings-module" aria-label={t("settings.moduleAria")}>
      <header className="owb-settings-module__header">
        <h1>{t("settings.title")}</h1>
      </header>

      <section className="owb-settings-module__pane" aria-label={t("settings.updateTitle")}>
        <header className="owb-settings-module__pane-header">
          <h2>{t("settings.updateTitle")}</h2>
        </header>

        <dl className="owb-settings-module__facts">
          <div className="owb-settings-module__fact">
            <dt>{t("settings.version")}</dt>
            <dd>{status?.version ?? t("settings.versionUnknown")}</dd>
          </div>
          <div className="owb-settings-module__fact">
            <dt>{t("settings.statusLabel")}</dt>
            <dd role="status">
              {statusRead && status === null ? t("settings.statusUnknown") : t(line.key, line.vars)}
            </dd>
          </div>
        </dl>

        {state === "downloading" && live?.percent !== null && live?.percent !== undefined ? (
          <Progress
            percent={live.percent}
            size="small"
            aria-label={t("settings.stateDownloading")}
          />
        ) : null}

        <div className="owb-settings-module__actions">
          <Button
            type="primary"
            icon={<RefreshCw aria-hidden="true" size={14} />}
            disabled={!affordances.canCheck}
            loading={state === "checking"}
            onClick={() => void onCheck()}
          >
            {t("settings.check")}
          </Button>
          <Button
            icon={<Download aria-hidden="true" size={14} />}
            disabled={!affordances.canDownload}
            onClick={() => void onDownload()}
          >
            {t("settings.download")}
          </Button>
          <Button
            icon={<RotateCcw aria-hidden="true" size={14} />}
            disabled={!affordances.canInstall}
            onClick={() => void onInstall()}
          >
            {t("settings.install")}
          </Button>
        </div>

        {affordances.showPlatformNotice ? (
          <Alert
            type="info"
            showIcon
            className="owb-settings-module__notice"
            message={t("settings.stateUnavailable")}
            description={t(unavailableMessage(status?.platform ?? "other").key)}
          />
        ) : null}

        {affordances.showUnsignedRefusal || refusal !== null ? (
          <Alert
            type="warning"
            showIcon
            className="owb-settings-module__notice"
            message={t("settings.unsignedTitle")}
            description={t("settings.unsignedBody")}
          />
        ) : null}

        <div className="owb-settings-module__notes">
          <Button
            type="link"
            icon={<ExternalLink aria-hidden="true" size={14} />}
            onClick={() => void window.owb.update.openReleaseNotes()}
          >
            {t("settings.releaseNotes")}
          </Button>
          <span className="owb-settings-module__hint">{t("settings.releaseNotesHint")}</span>
        </div>

      </section>
    </section>
  );
}
