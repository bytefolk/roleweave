import { FileText, Image, LoaderCircle, X } from "lucide-react";
import type { PendingAttachment, TurnAttachment } from "./types";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/")) return <Image size={16} aria-hidden="true" />;
  return <FileText size={16} aria-hidden="true" />;
}

export function PendingAttachmentCard({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: (id: string) => void;
}) {
  return (
    <span className="owb-attachment-card">
      <FileIcon mimeType={attachment.mimeType} />
      <span className="owb-attachment-card__name" title={attachment.fileName}>{attachment.fileName}</span>
      <span className="owb-attachment-card__size">{formatSize(attachment.sizeBytes)}</span>
      {attachment.status === "uploading" ? <LoaderCircle size={14} className="owb-attachment-card__spinner" aria-hidden="true" /> : null}
      {attachment.status === "error" ? <span className="owb-attachment-card__error" title={attachment.error}>!</span> : null}
      {attachment.status !== "uploading" ? (
        <button type="button" className="owb-attachment-card__remove" onClick={() => onRemove(attachment.id)} aria-label="Remove attachment">
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

export function SavedAttachmentCard({ attachment }: { attachment: TurnAttachment }) {
  return (
    <span className="owb-attachment-card owb-attachment-card--saved">
      <FileIcon mimeType={attachment.mimeType} />
      <span className="owb-attachment-card__name" title={attachment.fileName}>{attachment.fileName}</span>
      <span className="owb-attachment-card__size">{formatSize(attachment.sizeBytes)}</span>
    </span>
  );
}
