import { ATTACHMENT_MAX_PDF_PAGES } from "@roleweave/shared";
import type { AttachmentTextLayer, AttachmentTextPage } from "@roleweave/shared";

export const ATTACHMENT_MAX_PDF_TEXT_BYTES = 512 * 1024;
export const ATTACHMENT_MAX_PDF_PAGE_TEXT_BYTES = 32 * 1024;
export const ATTACHMENT_PDF_PARSE_TIMEOUT_MS = 8_000;

interface PdfjsDoc {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: Array<{ str: string }> }> }>;
}
interface PdfjsLib {
  getDocument(params: { data: Uint8Array; useSystemFonts?: boolean }): { promise: Promise<PdfjsDoc> };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("pdf parse timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Best-effort PDF text extraction. Failure or budget overrun returns undefined
 * so callers must not treat untrusted text as a successful extract.
 */
export async function extractPdfText(buffer: Buffer): Promise<AttachmentTextLayer | undefined> {
  try {
    const pdfjsLib = await (Function('return import("pdfjs-dist/legacy/build/pdf.js")')() as Promise<PdfjsLib>);
    const data = new Uint8Array(buffer);
    const doc = await withTimeout(
      pdfjsLib.getDocument({ data, useSystemFonts: true }).promise,
      ATTACHMENT_PDF_PARSE_TIMEOUT_MS,
    );
    const pageCount = Math.min(doc.numPages, ATTACHMENT_MAX_PDF_PAGES);
    const pages: AttachmentTextPage[] = [];
    let totalBytes = 0;
    for (let i = 1; i <= pageCount; i++) {
      const page = await withTimeout(doc.getPage(i), ATTACHMENT_PDF_PARSE_TIMEOUT_MS);
      const content = await withTimeout(page.getTextContent(), ATTACHMENT_PDF_PARSE_TIMEOUT_MS);
      let text = content.items.map((item) => item.str).join(" ");
      const pageBytes = Buffer.byteLength(text, "utf8");
      if (pageBytes > ATTACHMENT_MAX_PDF_PAGE_TEXT_BYTES) {
        text = Buffer.from(text, "utf8").subarray(0, ATTACHMENT_MAX_PDF_PAGE_TEXT_BYTES).toString("utf8");
      }
      totalBytes += Buffer.byteLength(text, "utf8");
      if (totalBytes > ATTACHMENT_MAX_PDF_TEXT_BYTES) {
        return undefined;
      }
      pages.push({ pageNumber: i, text });
    }
    return { schemaVersion: "attachment-text.v1", pages };
  } catch {
    return undefined;
  }
}
