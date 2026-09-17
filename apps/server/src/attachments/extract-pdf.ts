import { ATTACHMENT_MAX_PDF_PAGES } from "@roleweave/shared";
import type { AttachmentTextLayer, AttachmentTextPage } from "@roleweave/shared";

// ponytail: pdfjs-dist is the first server runtime dep; dynamic import with
// inline typing keeps it optional for dev/test environments without the package.
interface PdfjsDoc {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: Array<{ str: string }> }> }>;
}
interface PdfjsLib {
  getDocument(params: { data: Uint8Array; useSystemFonts?: boolean }): { promise: Promise<PdfjsDoc> };
}

export async function extractPdfText(buffer: Buffer): Promise<AttachmentTextLayer | undefined> {
  try {
    const pdfjsLib = await (Function('return import("pdfjs-dist/legacy/build/pdf.js")')() as Promise<PdfjsLib>);
    const data = new Uint8Array(buffer);
    const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
    const pageCount = Math.min(doc.numPages, ATTACHMENT_MAX_PDF_PAGES);
    const pages: AttachmentTextPage[] = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str).join(" ");
      pages.push({ pageNumber: i, text });
    }
    return { schemaVersion: "attachment-text.v1", pages };
  } catch {
    return undefined;
  }
}
