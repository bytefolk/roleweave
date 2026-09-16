import type { FormEvent, ReactNode } from "react";
import { Button as AntButton, Input } from "antd";
import { ArrowUp, Square } from "lucide-react";
import { useT } from "@roleweave/ui";
import { DiagnosticNotice, type AvailabilityCheck } from "../DiagnosticNotice";

export interface TurnComposerProps {
  options?: ReactNode;
  value: string;
  placeholder: string;
  disabledReason: string | null;
  disabledSummary?: string;
  disabledDiagnostic?: string;
  diagnosticKey?: string;
  availabilityCheck?: AvailabilityCheck;
  running: boolean;
  cancelling?: boolean;
  canCancel: boolean;
  onChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

/** The composer deliberately owns only drafting and dispatching. Session and
 * host choices live in the scope bar above the thread, so this remains a
 * focused writing surface instead of a mixed settings form. */
export function TurnComposer({
  options,
  value,
  placeholder,
  disabledReason,
  disabledSummary,
  disabledDiagnostic,
  diagnosticKey,
  availabilityCheck,
  running,
  cancelling = false,
  canCancel,
  onChange,
  onSend,
  onCancel,
}: TurnComposerProps) {
  const t = useT();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSend();
  };

  return (
    <form className="owb-turn-composer" onSubmit={submit}>
      <label className="owb-sr-only" htmlFor="owb-turn-input">{t("turn.compose")}</label>
      <div className="owb-turn-composer__surface">
        <Input.TextArea
          id="owb-turn-input"
          value={value}
          rows={3}
          placeholder={placeholder}
          disabled={disabledReason !== null}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter keeps multiline input. During Chinese
            // IME composition Enter only commits the selected candidate.
            const native = event.nativeEvent as KeyboardEvent;
            if (native.isComposing || native.keyCode === 229) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void onSend();
            }
          }}
        />
        {running ? (
          <AntButton
            danger
            disabled={cancelling || !canCancel}
            aria-label={t("turn.interrupt")}
            title={t("turn.interruptTitle")}
            icon={<Square aria-hidden="true" size={15} />}
            onClick={() => void onCancel()}
          />
        ) : (
          <AntButton
            type="primary"
            htmlType="submit"
            disabled={disabledReason !== null || value.trim().length === 0}
            aria-label={t("turn.send")}
            icon={<ArrowUp aria-hidden="true" size={15} />}
          />
        )}
      </div>
      {options}
      {running || disabledReason ? (
        <DiagnosticNotice className="owb-turn-composer__hint"
          message={running
            ? cancelling
              ? t("turn.interrupting")
              : t("turn.running")
            : disabledSummary ?? disabledReason!}
          diagnostic={running ? undefined : disabledDiagnostic}
          availabilityCheck={running ? undefined : availabilityCheck}
          diagnosticKey={diagnosticKey} />
      ) : <p className="owb-turn-composer__shortcut">{t("turn.keyboardHint")}</p>}
    </form>
  );
}
