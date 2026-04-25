import { PDFDocument } from 'pdf-lib';
import { convertImageToPdfBuffer } from './pdf-converter.js';
import type { AttachmentData } from './types.js';

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif',
  'image/webp', 'image/bmp', 'image/tiff',
]);

async function attachmentToPdfBuffer(
  att: AttachmentData
): Promise<Buffer | null> {
  if (att.mimeType === 'application/pdf') {
    return att.data;
  }

  if (IMAGE_MIME_TYPES.has(att.mimeType)) {
    return convertImageToPdfBuffer(att.data, att.mimeType);
  }

  // Skip unsupported types (e.g. zip, docx)
  return null;
}

export async function mergeEmailWithAttachments(
  emailPdfBuffer: Buffer,
  attachments: AttachmentData[]
): Promise<{ merged: Buffer; attachmentsMerged: number; errors: string[] }> {
  const merged = await PDFDocument.create();
  const errors: string[] = [];
  let attachmentsMerged = 0;

  // Copy email pages first
  const emailDoc = await PDFDocument.load(emailPdfBuffer);
  const emailPages = await merged.copyPages(emailDoc, emailDoc.getPageIndices());
  emailPages.forEach(p => merged.addPage(p));

  // Append each attachment
  for (const att of attachments) {
    try {
      const pdfBuf = await attachmentToPdfBuffer(att);
      if (!pdfBuf) continue;

      const attDoc = await PDFDocument.load(pdfBuf);
      const pages = await merged.copyPages(attDoc, attDoc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
      attachmentsMerged++;
    } catch (err) {
      const msg = `Failed to merge attachment "${att.filename}": ${(err as Error).message}`;
      console.error(msg);
      errors.push(msg);
    }
  }

  const mergedBytes = await merged.save();
  return { merged: Buffer.from(mergedBytes), attachmentsMerged, errors };
}

export async function countPdfPages(pdfBuffer: Buffer): Promise<number> {
  const doc = await PDFDocument.load(pdfBuffer);
  return doc.getPageCount();
}
