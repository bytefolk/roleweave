import type { FormEvent, ReactNode } from "react";
import { Button as AntButton, Input } from "antd";
import { ArrowUp, Square } from "lucide-react";
import { useConversationCopy } from "../locales/conversation";
import { useT } from "@roleweave/ui";
import { DiagnosticNotice, type AvailabilityCheck } from "../DiagnosticNotice";

function insertNewline(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null,
  onChange: (value: string) => void,
) {
  const start = selectionStart ?? value.length;
  const end = selectionEnd ?? start;
  onChange(`${value.slice(0, start)}\n${value.slice(end)}`);
  requestAnimationFrame(() => {
    const input = document.getElementById("owb-turn-input") as HTMLTextAreaElement | null;
    input?.setSelectionRange(start + 1, start + 1);
  });
}

export interface TurnComposerProps {
  options?: ReactNode;
  draftDisabled?: boolean;
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
  draftDisabled,
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
  const copy = useConversationCopy();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!running && !disabledReason && value.trim()) void onSend();
  };

  return (
    <form className="owb-turn-composer" onSubmit={submit}>
      <label className="owb-sr-only" htmlFor="owb-turn-input">{t("turn.compose")}</label>
      <div className="owb-turn-composer__surface">
        <Input.TextArea
          id="owb-turn-input"
          value={value}
          autoSize={{ minRows: 3, maxRows: 8 }}
          placeholder={placeholder}
          disabled={draftDisabled ?? (disabledReason !== null && !running)}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends. Ctrl/Command+Enter (and Shift+Enter for familiar
            // chat muscle memory) keeps multiline input. During Chinese
            // IME composition Enter only commits the selected candidate.
            const native = event.nativeEvent as KeyboardEvent;
            if (native.isComposing || native.keyCode === 229) return;
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              insertNewline(value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd, onChange);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              if (!running && !disabledReason && value.trim()) void onSend();
            }
          }}
        />
        {running ? (
          <AntButton
            danger
            disabled={cancelling || !canCancel}
            aria-label={t("turn.interrupt")}
            title={cancelling ? t("turn.interrupting") : t("turn.interruptTitle")}
            loading={cancelling}
            icon={<Square aria-hidden="true" size={15} />}
            onClick={() => void onCancel()}
          />
        ) : (
          <AntButton
            type="primary"
            htmlType="submit"
            disabled={disabledReason !== null || value.trim().length === 0}
            aria-label={t("turn.send")}
            title={disabledSummary ?? disabledReason ?? (value.trim() ? t("turn.send") : copy.emptySend)}
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
