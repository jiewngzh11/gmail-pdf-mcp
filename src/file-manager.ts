import path from 'path';

// Characters invalid in Windows filenames and Blob path components
const INVALID_CHARS = /[\\/:*?"<>|]/g;

export function sanitizeName(name: string): string {
  return name
    .replace(INVALID_CHARS, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 50)
    || 'Unknown';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export interface OutputPaths {
  filename: string;       // e.g. "John_Doe_20260425_143022.pdf"
  localDir: string;       // e.g. "C:\output\John_Doe"
  localPath: string;      // e.g. "C:\output\John_Doe\John_Doe_20260425_143022.pdf"
  blobPath: string;       // e.g. "John_Doe/John_Doe_20260425_143022.pdf"
}

export function buildOutputPaths(
  outputBaseDir: string,
  senderName: string,
  emailDate: Date
): OutputPaths {
  const safeSender = sanitizeName(senderName);
  const timestamp = formatTimestamp(emailDate);
  const filename = `${safeSender}_${timestamp}.pdf`;
  const localDir = path.resolve(outputBaseDir, safeSender);
  const localPath = path.join(localDir, filename);
  const blobPath = `${safeSender}/${filename}`;

  return { filename, localDir, localPath, blobPath };
}

export function getDefaultOutputDir(): string {
  return process.env.OUTPUT_DIR ?? path.join(process.cwd(), 'output');
}
