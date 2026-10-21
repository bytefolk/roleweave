import type { OwbT } from "@roleweave/ui";
import type { PendingAttachment } from "./types";

export const MAX_TURN_INPUT_BYTES = 256 * 1024;

export function inputFeedback(input: string, attachments: readonly PendingAttachment[] = []): string | null {
  if (attachments.some(a => a.status === "error")) return "turn.attachmentUploadFailed";
  if (attachments.some(a => a.status !== "ready" || !a.serverId)) return "turn.attachmentsUploading";
  if (!input.trim()) return attachments.length ? "turn.attachmentInstructionsRequired" : "turn.inputRequired";
  if (new TextEncoder().encode(input.trim()).byteLength > MAX_TURN_INPUT_BYTES) return "turn.inputTooLarge";
  return null;
}

export function turnRequestError(body: unknown, input: string, hasAttachments: boolean, t: OwbT, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const { code, message } = body as { code?: unknown; message?: unknown };
  if (code === "turn_input_empty") return t(hasAttachments ? "turn.attachmentInstructionsRequired" : "turn.inputRequired");
  if (code === "turn_input_too_large") return t("turn.inputTooLarge");
  if (code === "attachment_images_unsupported") return t("turn.attachmentImagesUnsupported");
  if (code === "turn_request_invalid" && message === "attachment context exceeds 256 KiB input budget") return t("turn.inputContextTooLarge");
  // Older desktop/control-plane builds combined two different failures.
  if (code === "turn_request_invalid" && typeof message === "string" && /^input must be (?:a non-empty UTF-8 string|non-empty and) no larger than 256 KiB$/.test(message)) {
    if (!input.trim()) return t(hasAttachments ? "turn.attachmentInstructionsRequired" : "turn.inputRequired");
    if (new TextEncoder().encode(input).byteLength > MAX_TURN_INPUT_BYTES) return t("turn.inputTooLarge");
    return fallback;
  }
  return typeof message === "string" ? message : fallback;
}
