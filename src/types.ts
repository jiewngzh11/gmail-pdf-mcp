export interface EmailAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId?: string; // cid: reference in HTML
}

export interface AttachmentData {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface EmailMessage {
  messageId: string;
  threadId: string;
  subject: string;
  senderName: string;
  senderEmail: string;
  date: Date;
  snippet: string;
  htmlBody: string;
  plainBody: string;
  hasAttachments: boolean;
  attachments: EmailAttachment[];
}

export interface EmailSummary {
  messageId: string;
  threadId: string;
  subject: string;
  senderName: string;
  senderEmail: string;
  date: string;
  snippet: string;
  hasAttachments: boolean;
}

export interface ConversionResult {
  success: boolean;
  messageId: string;
  subject: string;
  senderName: string;
  filename: string;
  pdfUrl?: string;       // Azure Blob SAS URL
  blobName?: string;     // Azure Blob path
  localPath?: string;    // Local file path (local mode)
  driveUrl?: string;     // Google Drive share link
  driveFileId?: string;  // Google Drive file ID
  pages: number;
  attachmentsMerged: number;
  errors: string[];
}

export interface BatchConversionResult {
  processed: number;
  failed: number;
  results: ConversionResult[];
}

export interface StorageConfig {
  accountName: string;
  containerName: string;
}
