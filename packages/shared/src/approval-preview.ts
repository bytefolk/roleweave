/**
 * Additive engine.v1 preview payload for a write-like approval. The digest is
 * over the approval id, action fields, and this payload excluding digest; the
 * control plane verifies that binding before it accepts an engine event.
 */
export const APPROVAL_CHANGE_PREVIEW_VERSION = "approval-change-preview.v1" as const;
export const MAX_APPROVAL_PREVIEW_FILES = 16;
export const MAX_APPROVAL_PREVIEW_PATH_BYTES = 512;
export const MAX_APPROVAL_PREVIEW_TEXT_BYTES = 16 * 1024;
export const MAX_APPROVAL_PREVIEW_BYTES = 64 * 1024;

export type ApprovalChangeKind = "create" | "modify" | "delete";

export interface ApprovalChangePreviewFile {
  path: string;
  change: ApprovalChangeKind;
  before?: string;
  after?: string;
}

export interface ApprovalChangePreview {
  version: typeof APPROVAL_CHANGE_PREVIEW_VERSION;
  previewId: string;
  /** `sha256:` of `approvalPreviewDigestInput(...)`; never a digest supplied
   * for a different action or preview. */
  actionDigest: string;
  files: ApprovalChangePreviewFile[];
}

export interface ApprovalPreviewAction {
  kind: string;
  description: string;
  target?: string;
}

/** Stable JSON input shared with engines implementing this additive contract. */
export function approvalPreviewDigestInput(
  approvalId: string,
  action: ApprovalPreviewAction,
  preview: Omit<ApprovalChangePreview, "actionDigest">,
): string {
  return JSON.stringify({
    approvalId,
    action: {
      kind: action.kind,
      description: action.description,
      ...(action.target === undefined ? {} : { target: action.target }),
    },
    preview,
  });
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= maximum;
}

/** Structural guard used at both the engine ingress and durable-store seams. */
export function isApprovalChangePreview(value: unknown): value is ApprovalChangePreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preview = value as Record<string, unknown>;
  if (
    Object.keys(preview).some(key => !["version", "previewId", "actionDigest", "files"].includes(key)) ||
    preview.version !== APPROVAL_CHANGE_PREVIEW_VERSION ||
    !boundedText(preview.previewId, 128) ||
    typeof preview.actionDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(preview.actionDigest) ||
    !Array.isArray(preview.files) || preview.files.length === 0 || preview.files.length > MAX_APPROVAL_PREVIEW_FILES
  ) return false;
  for (const file of preview.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) return false;
    const entry = file as Record<string, unknown>;
    if (Object.keys(entry).some(key => !["path", "change", "before", "after"].includes(key)) ||
        !boundedText(entry.path, MAX_APPROVAL_PREVIEW_PATH_BYTES) ||
        !["create", "modify", "delete"].includes(entry.change as string) ||
        (entry.before !== undefined && !boundedText(entry.before, MAX_APPROVAL_PREVIEW_TEXT_BYTES)) ||
        (entry.after !== undefined && !boundedText(entry.after, MAX_APPROVAL_PREVIEW_TEXT_BYTES)) ||
        (entry.change === "create" && (entry.before !== undefined || entry.after === undefined)) ||
        (entry.change === "delete" && (entry.before === undefined || entry.after !== undefined)) ||
        (entry.change === "modify" && (entry.before === undefined || entry.after === undefined))) return false;
  }
  try { return new TextEncoder().encode(JSON.stringify(preview)).length <= MAX_APPROVAL_PREVIEW_BYTES; } catch { return false; }
}
