import { useT } from "@roleweave/ui";
import "./diagnostic-notice.css";

export function DiagnosticDetails({ diagnostic, diagnosticKey = "" }: {
  diagnostic?: string;
  diagnosticKey?: string;
}) {
  const t = useT();
  if (!diagnostic) return null;
  return <details className="owb-diagnostic-details" key={`${diagnosticKey}:${diagnostic}`}>
    <summary>{t("misc.troubleshootingDetails")}</summary>
    <pre>{diagnostic}</pre>
  </details>;
}

/** Keep actionable product status separate from optional runtime diagnostics. */
export function DiagnosticNotice({ message, diagnostic, diagnosticKey, className = "" }: {
  message: string;
  diagnostic?: string;
  diagnosticKey?: string;
  className?: string;
}) {
  return <div className={`owb-diagnostic-notice ${className}`}>
    <p role="status">{message}</p>
    <DiagnosticDetails diagnostic={diagnostic} diagnosticKey={diagnosticKey} />
  </div>;
}
