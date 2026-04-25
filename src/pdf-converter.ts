import puppeteer, { Browser } from 'puppeteer';
import type { EmailMessage, EmailAttachment } from './types.js';
import type { OAuth2Client } from 'google-auth-library';
import { fetchAttachment } from './gmail.js';

type AuthClient = OAuth2Client;

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.connected) {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    browserInstance = await puppeteer.launch({
      headless: true,
      executablePath: executablePath || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--font-render-hinting=none',
      ],
    });
  }
  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

// Build cid→base64DataURI map from attachments
async function buildCidMap(
  auth: AuthClient,
  messageId: string,
  attachments: EmailAttachment[]
): Promise<Map<string, string>> {
  const cidMap = new Map<string, string>();

  for (const att of attachments) {
    if (!att.contentId) continue;
    try {
      const data = await fetchAttachment(auth, messageId, att.attachmentId);
      const b64 = data.toString('base64');
      const dataUri = `data:${att.mimeType};base64,${b64}`;
      // Register by contentId (with and without angle brackets)
      cidMap.set(att.contentId, dataUri);
      cidMap.set(`cid:${att.contentId}`, dataUri);
    } catch (err) {
      console.error(`Failed to fetch inline image ${att.filename}:`, err);
    }
  }

  return cidMap;
}

// Replace cid: references in HTML with data URIs
function replaceCidReferences(html: string, cidMap: Map<string, string>): string {
  let result = html;

  // Match src="cid:..." and src='cid:...'
  result = result.replace(/src=["']cid:([^"']+)["']/gi, (match, cid) => {
    const uri = cidMap.get(cid) ?? cidMap.get(`cid:${cid}`);
    return uri ? `src="${uri}"` : match;
  });

  return result;
}

function wrapHtml(bodyContent: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    body { font-family: "Noto Sans CJK TC", Arial, sans-serif; font-size: 12px; margin: 0; padding: 16px; }
    img { max-width: 100%; height: auto; }
    table { page-break-inside: avoid; border-collapse: collapse; }
    a { color: inherit; }
    pre, code { white-space: pre-wrap; word-break: break-all; }
  </style>
</head>
<body>${bodyContent}</body>
</html>`;
}

export async function convertHtmlToPdfBuffer(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setContent(html, { waitUntil: 'networkidle2', timeout: 30_000 });
    const pdfUint8 = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' },
    });
    return Buffer.from(pdfUint8);
  } finally {
    await page.close();
  }
}

export async function convertEmailToPdfBuffer(
  auth: AuthClient,
  message: EmailMessage
): Promise<Buffer> {
  // Build cid map for inline images
  const cidMap = await buildCidMap(auth, message.messageId, message.attachments);

  // Use HTML body if available, otherwise convert plain text to basic HTML
  let body = message.htmlBody;
  if (!body) {
    const escaped = message.plainBody
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    body = `<pre style="white-space:pre-wrap">${escaped}</pre>`;
  }

  // Replace cid: references
  const processedHtml = replaceCidReferences(body, cidMap);

  // Add email header info at the top
  const dateStr = message.date.toLocaleString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const header = `
    <div style="border-bottom:2px solid #333;padding-bottom:8px;margin-bottom:16px;font-size:13px;">
      <div><strong>主旨：</strong>${escapeHtml(message.subject)}</div>
      <div><strong>寄件人：</strong>${escapeHtml(message.senderName)} &lt;${escapeHtml(message.senderEmail)}&gt;</div>
      <div><strong>日期：</strong>${dateStr}</div>
    </div>
  `;

  const fullHtml = wrapHtml(header + processedHtml);
  return convertHtmlToPdfBuffer(fullHtml);
}

export async function convertImageToPdfBuffer(
  imageData: Buffer,
  mimeType: string
): Promise<Buffer> {
  const b64 = imageData.toString('base64');
  const html = wrapHtml(
    `<img src="data:${mimeType};base64,${b64}" style="max-width:100%;max-height:297mm;display:block;margin:0 auto;" />`
  );
  return convertHtmlToPdfBuffer(html);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
