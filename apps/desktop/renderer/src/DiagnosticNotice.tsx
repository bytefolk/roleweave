import { useRef, useState } from "react";
import { Button } from "antd";
import { useT } from "@roleweave/ui";
import "./diagnostic-notice.css";

export interface AvailabilityCheck {
  onRecheck: () => Promise<void>;
  checking: boolean;
  failed: boolean;
}

/** A repair action the notice can offer instead of only describing the block
 *  (e.g. one-click Qoder login). The caller owns the async work. */
export interface NoticeAction {
  label: string;
  busy?: boolean;
  onClick: () => void | Promise<void>;
}

interface DiagnosticNoticeProps {
  message: string;
  diagnostic?: string;
  diagnosticKey?: string;
  className?: string;
  availabilityCheck?: AvailabilityCheck;
  /** Primary repair action rendered ahead of the recheck button. */
  primaryAction?: NoticeAction;
  /** Optional secondary link-style action (e.g. open the printed login URL). */
  linkAction?: NoticeAction;
  /** Outcome of the last primary action attempt; rendered as live feedback. */
  primaryFeedback?: string | null;
}

/** Raw diagnostics leave the component only through an explicit copy action. */
export function DiagnosticNotice(props: DiagnosticNoticeProps) {
  return <StatusNotice key={`${props.diagnosticKey ?? ""}:${props.diagnostic ?? ""}`} {...props} />;
}

function StatusNotice({ message, diagnostic, className = "", availabilityCheck, primaryAction, linkAction, primaryFeedback }: DiagnosticNoticeProps) {
  const t = useT();
  const [copyResult, setCopyResult] = useState<"copied" | "copyFailed" | null>(null);
  const copying = useRef(false);
  const copy = async () => {
    if (!diagnostic || copying.current) return;
    copying.current = true;
    setCopyResult(null);
    try {
      await navigator.clipboard.writeText(diagnostic);
      setCopyResult("copied");
    } catch {
      setCopyResult("copyFailed");
    } finally { copying.current = false; }
  };
  return <div className={`owb-diagnostic-notice ${className}`}>
    <p role="status">{message}</p>
    {primaryAction || linkAction || availabilityCheck || diagnostic ? <div className="owb-diagnostic-notice__actions">
      {primaryAction ? <Button size="small" type="primary" htmlType="button"
        loading={primaryAction.busy === true} disabled={primaryAction.busy === true}
        onClick={() => void primaryAction.onClick()}>
        {primaryAction.label}
      </Button> : null}
      {linkAction ? <Button size="small" type="text" htmlType="button"
        onClick={() => void linkAction.onClick()}>
        {linkAction.label}
      </Button> : null}
      {availabilityCheck ? <Button size="small" htmlType="button"
        loading={availabilityCheck.checking} disabled={availabilityCheck.checking}
        aria-label={t(availabilityCheck.checking ? "misc.checkingAvailability" : "misc.recheckAvailability")}
        onClick={() => void availabilityCheck.onRecheck()}>
        {t(availabilityCheck.checking ? "misc.checkingAvailability" : "misc.recheckAvailability")}
      </Button> : null}
      {diagnostic ? <Button size="small" type="text" htmlType="button" onClick={() => void copy()}>{t("misc.copyDiagnostic")}</Button> : null}
    </div> : null}
    {primaryFeedback ? <span className="owb-diagnostic-notice__feedback" role="status">{primaryFeedback}</span> : null}
    {availabilityCheck?.failed ? <span className="owb-diagnostic-notice__feedback" role="status">{t("misc.availabilityCheckFailed")}</span> : null}
    {copyResult ? <span className="owb-diagnostic-notice__feedback" role="status">{t(`misc.${copyResult}`)}</span> : null}
  </div>;
}
