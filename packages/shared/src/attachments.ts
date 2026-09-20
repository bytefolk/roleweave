export const ATTACHMENT_ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"] as const;
export type AttachmentMimeType = (typeof ATTACHMENT_ALLOWED_MIME_TYPES)[number];
export const ATTACHMENT_MAX_COUNT = 5;
export const ATTACHMENT_MAX_SINGLE_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_TOTAL_BYTES = 30 * 1024 * 1024;
export const ATTACHMENT_MAX_PDF_PAGES = 200;
export const ATTACHMENT_MAX_FILE_NAME_LENGTH = 255;

export interface AttachmentTextPage {
  pageNumber: number;
  text: string;
}

export interface AttachmentTextLayer {
  schemaVersion: "attachment-text.v1";
  pages: AttachmentTextPage[];
}

export interface TurnAttachment {
  id: string;
  fileName: string;
  mimeType: AttachmentMimeType;
  sizeBytes: number;
  extractedText?: AttachmentTextLayer;
}
