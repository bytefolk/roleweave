import { useLayoutEffect, useRef, type ChangeEvent, type ClipboardEvent, type FormEvent, type ReactNode } from "react";
import { Button as AntButton, Input, Tooltip } from "antd";
import { ArrowUp, Paperclip, Square } from "lucide-react";
import { useConversationCopy } from "../locales/conversation";
import { useT } from "@roleweave/ui";
import { DiagnosticNotice, type AvailabilityCheck, type NoticeAction } from "../DiagnosticNotice";
import type { PendingAttachment } from "./types";
import { PendingAttachmentCard } from "./AttachmentCard";
import "./composer-toolbar.css";

export interface TurnComposerProps {
  advisory?: ReactNode;
  options?: ReactNode;
  sendShortcut?: "enter" | "mod-enter";
  draftDisabled?: boolean;
  value: string;
  placeholder: string;
  disabledReason: string | null;
  disabledSummary?: string;
  disabledDiagnostic?: string;
  diagnosticKey?: string;
  availabilityCheck?: AvailabilityCheck;
  /** Repair action for the current block (e.g. one-click Qoder login). */
  primaryAction?: NoticeAction;
  linkAction?: NoticeAction;
  primaryFeedback?: string | null;
  running: boolean;
  cancelling?: boolean;
  canCancel: boolean;
  onChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  attachments?: PendingAttachment[];
  onAddAttachments?: (files: FileList) => void;
  onRemoveAttachment?: (id: string) => void;
}

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];

function isAcceptedFile(file: File): boolean {
  return ACCEPTED_TYPES.includes(file.type);
}

export function TurnComposer({
  advisory,
  options,
  sendShortcut = "enter",
  draftDisabled,
  value,
  placeholder,
  disabledReason,
  disabledSummary,
  disabledDiagnostic,
  diagnosticKey,
  availabilityCheck,
  primaryAction,
  linkAction,
  primaryFeedback,
  running,
  cancelling = false,
  canCancel,
  onChange,
  onSend,
  onCancel,
  attachments = [],
  onAddAttachments,
  onRemoveAttachment,
}: TurnComposerProps) {
  const t = useT();
  const copy = useConversationCopy();
  const composing = useRef(false);
  const pendingCaret = useRef<{ input: HTMLTextAreaElement; value: string; offset: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasContent = value.trim().length > 0 || attachments.some((a) => a.status === "ready");
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    pendingCaret.current = null;
    if (pending && pending.input.isConnected && pending.input.value === pending.value) {
      pending.input.setSelectionRange(pending.offset, pending.offset);
    }
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!running && !disabledReason && hasContent) void onSend();
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onAddAttachments) return;
    const files = event.clipboardData.files;
    if (files.length === 0) return;
    const accepted = Array.from(files).filter(isAcceptedFile);
    if (accepted.length === 0) return;
    event.preventDefault();
    const dt = new DataTransfer();
    for (const file of accepted) dt.items.add(file);
    onAddAttachments(dt.files);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0 && onAddAttachments) {
      onAddAttachments(event.target.files);
      event.target.value = "";
    }
  };

  return (
    <form className="owb-turn-composer owb-turn-composer--compact" onSubmit={submit}>
      <label className="owb-sr-only" htmlFor="owb-turn-input">{t("turn.compose")}</label>
      <div className="owb-turn-composer__surface">
        {attachments.length > 0 ? (
          <div className="owb-attachment-strip">
            {attachments.map((att) => (
              <PendingAttachmentCard key={att.id} attachment={att} onRemove={(id) => onRemoveAttachment?.(id)} />
            ))}
          </div>
        ) : null}
        <Input.TextArea
          id="owb-turn-input"
          value={value}
          autoSize={{ minRows: 2, maxRows: 8 }}
          placeholder={placeholder}
          disabled={draftDisabled ?? (disabledReason !== null && !running)}
          onChange={(event) => onChange(event.target.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            // Preserve the configured send shortcut and native Shift+Enter.
            // IME confirmation must neither send nor insert an extra newline.
            const native = event.nativeEvent as KeyboardEvent;
            if (composing.current || native.isComposing || native.keyCode === 229) return;
            if (event.key === "Enter" && sendShortcut === "enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              const input = event.currentTarget;
              const start = input.selectionStart;
              const nextValue = `${value.slice(0, start)}\n${value.slice(input.selectionEnd)}`;
              // Restore the caret after the controlled value commits, on this
              // textarea only; switching conversations must not move another caret.
              if (nextValue === value) input.setSelectionRange(start + 1, start + 1);
              else pendingCaret.current = { input, value: nextValue, offset: start + 1 };
              onChange(nextValue);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && (sendShortcut === "enter" ? !event.metaKey && !event.ctrlKey : event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (!running && !disabledReason && hasContent) void onSend();
            }
          }}
        />
        <div className="owb-turn-composer__toolbar">
          {options ? <div className="owb-turn-composer__options">{options}</div> : null}
          <div className="owb-turn-composer__actions">
            {advisory}
            {onAddAttachments ? <Tooltip title={t("turn.addAttachment")} trigger={["hover", "focus"]}>
              <AntButton type="text" aria-label={t("turn.addAttachment")}
                icon={<Paperclip aria-hidden="true" size={16} />} onClick={() => fileInputRef.current?.click()} />
            </Tooltip> : null}
            <input ref={fileInputRef} type="file" accept={ACCEPTED_TYPES.join(",")} multiple style={{ display: "none" }} onChange={handleFileChange} />
            {running ? <Tooltip title={cancelling ? t("turn.interrupting") : canCancel ? copy.interruptHint : copy.interruptUnavailable} trigger={["hover", "focus"]}>
              <span className="owb-turn-composer__action-trigger" tabIndex={cancelling || !canCancel ? 0 : undefined}>
                <AntButton danger disabled={cancelling || !canCancel} aria-label={t("turn.interrupt")}
                  aria-keyshortcuts="Meta+. Control+." loading={cancelling}
                  icon={<Square aria-hidden="true" size={15} />} onClick={() => void onCancel()} />
              </span>
            </Tooltip> : <Tooltip title={disabledSummary ?? disabledReason ?? (hasContent ? sendShortcut === "mod-enter" ? copy.modEnterHint : t("turn.keyboardHint") : copy.emptySend)} trigger={["hover", "focus"]}>
              <span className="owb-turn-composer__action-trigger" tabIndex={disabledReason !== null || !hasContent ? 0 : undefined}>
                <AntButton type="primary" htmlType="submit" disabled={disabledReason !== null || !hasContent}
                  aria-label={t("turn.send")} aria-keyshortcuts={sendShortcut === "mod-enter" ? "Meta+Enter Control+Enter" : "Enter"}
                  icon={<ArrowUp aria-hidden="true" size={17} />} />
              </span>
            </Tooltip>}
          </div>
        </div>
      </div>
      {!running && disabledReason ? (
        <DiagnosticNotice className="owb-turn-composer__hint"
          message={disabledSummary ?? disabledReason}
          diagnostic={disabledDiagnostic}
          availabilityCheck={availabilityCheck}
          primaryAction={primaryAction}
          linkAction={linkAction}
          primaryFeedback={primaryFeedback}
          diagnosticKey={diagnosticKey} />
      ) : null}
    </form>
  );
}
