import 'dotenv/config';
import { randomUUID } from 'crypto';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getAuthClient } from './auth.js';
import type { OAuth2Client } from 'google-auth-library';
import { searchEmails, fetchEmail, fetchAllAttachmentData } from './gmail.js';
import { convertEmailToPdfBuffer, closeBrowser } from './pdf-converter.js';
import { mergeEmailWithAttachments, countPdfPages } from './pdf-merger.js';
import { savePdf, downloadFromBlob } from './storage.js';
import { buildOutputPaths, getDefaultOutputDir } from './file-manager.js';
import type { ConversionResult, BatchConversionResult } from './types.js';

// ── Tool helpers ───────────────────────────────────────────────────────────────

async function doConvertEmail(
  messageId: string,
  outputDir: string,
  includeAttachments: boolean
): Promise<ConversionResult> {
  const auth = await getAuthClient();
  const message = await fetchEmail(auth, messageId);

  const paths = buildOutputPaths(outputDir, message.senderName, message.date);

  // Convert email HTML → PDF
  const emailPdf = await convertEmailToPdfBuffer(auth, message);

  let finalPdf = emailPdf;
  let attachmentsMerged = 0;
  const errors: string[] = [];

  if (includeAttachments && message.hasAttachments) {
    const attData = await fetchAllAttachmentData(auth, message);
    const { merged, attachmentsMerged: count, errors: mergeErrors } =
      await mergeEmailWithAttachments(emailPdf, attData);
    finalPdf = merged;
    attachmentsMerged = count;
    errors.push(...mergeErrors);
  }

  const pages = await countPdfPages(finalPdf);

  const saved = await savePdf(finalPdf, paths.blobPath, paths.localDir, paths.filename);

  return {
    success: true,
    messageId,
    subject: message.subject,
    senderName: message.senderName,
    filename: paths.filename,
    pdfUrl: saved.pdfUrl,
    blobName: saved.blobName,
    localPath: saved.localPath,
    pages,
    attachmentsMerged,
    errors,
  };
}

// ── Tool definitions ───────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_emails',
    description: '搜尋 Gmail 中主旨包含指定關鍵字的郵件，回傳郵件列表',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '主旨關鍵字，例如 "發票" 或 "報價單"',
        },
        max_results: {
          type: 'number',
          description: '最多回傳幾封（預設 10，上限 50）',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_email_content',
    description: '取得單封郵件的完整 HTML 內容與附件列表',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: '郵件的 message_id（從 search_emails 取得）',
        },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'convert_email_to_pdf',
    description: '將單封郵件（含附件）轉為 PDF 並儲存',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: '郵件的 message_id',
        },
        output_dir: {
          type: 'string',
          description: '本機儲存目錄（本機模式，預設使用 OUTPUT_DIR 環境變數）',
        },
        include_attachments: {
          type: 'boolean',
          description: '是否合併附件（預設 true）',
        },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'batch_convert_emails',
    description: '搜尋主旨含關鍵字的郵件並批次轉 PDF（主要使用工具）',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '主旨關鍵字',
        },
        max_results: {
          type: 'number',
          description: '最多處理幾封（預設 5）',
        },
        output_dir: {
          type: 'string',
          description: '本機儲存目錄（本機模式）',
        },
        include_attachments: {
          type: 'boolean',
          description: '是否合併附件（預設 true）',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'download_pdf_locally',
    description: '將 Azure Blob 中的 PDF 下載到本機指定路徑（Azure 模式使用）',
    inputSchema: {
      type: 'object',
      properties: {
        blob_name: {
          type: 'string',
          description: 'Blob 路徑（從 convert_email_to_pdf 的 blob_name 取得）',
        },
        local_path: {
          type: 'string',
          description: '本機儲存完整路徑，例如 C:\\Downloads\\email.pdf',
        },
      },
      required: ['blob_name', 'local_path'],
    },
  },
];

// ── Tool handlers ──────────────────────────────────────────────────────────────

async function handleSearchEmails(args: Record<string, unknown>) {
  const query = String(args['query']);
  const maxResults = Math.min(Number(args['max_results'] ?? 10), 50);

  const auth = await getAuthClient();
  const results = await searchEmails(auth, query, maxResults);

  return {
    emails: results,
    total_found: results.length,
  };
}

async function handleFetchEmailContent(args: Record<string, unknown>) {
  const messageId = String(args['message_id']);
  const auth = await getAuthClient();
  const message = await fetchEmail(auth, messageId);

  return {
    message_id: message.messageId,
    subject: message.subject,
    sender_name: message.senderName,
    sender_email: message.senderEmail,
    date: message.date.toISOString(),
    html_body: message.htmlBody,
    plain_body: message.plainBody,
    attachments: message.attachments.map(a => ({
      attachment_id: a.attachmentId,
      filename: a.filename,
      mime_type: a.mimeType,
      size: a.size,
    })),
  };
}

async function handleConvertEmailToPdf(args: Record<string, unknown>) {
  const messageId = String(args['message_id']);
  const outputDir = args['output_dir'] ? String(args['output_dir']) : getDefaultOutputDir();
  const includeAttachments = args['include_attachments'] !== false;

  const result = await doConvertEmail(messageId, outputDir, includeAttachments);
  return result;
}

async function handleBatchConvertEmails(args: Record<string, unknown>): Promise<BatchConversionResult> {
  const query = String(args['query']);
  const maxResults = Math.min(Number(args['max_results'] ?? 5), 20);
  const outputDir = args['output_dir'] ? String(args['output_dir']) : getDefaultOutputDir();
  const includeAttachments = args['include_attachments'] !== false;

  const auth = await getAuthClient();
  const emails = await searchEmails(auth, query, maxResults);

  let processed = 0;
  let failed = 0;
  const results: ConversionResult[] = [];

  for (const email of emails) {
    try {
      const result = await doConvertEmail(email.messageId, outputDir, includeAttachments);
      results.push(result);
      processed++;
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`Failed to convert ${email.messageId}:`, msg);
      results.push({
        success: false,
        messageId: email.messageId,
        subject: email.subject,
        senderName: email.senderName,
        filename: '',
        pages: 0,
        attachmentsMerged: 0,
        errors: [msg],
      });
      failed++;
    }
  }

  return { processed, failed, results };
}

async function handleDownloadPdfLocally(args: Record<string, unknown>) {
  const blobName = String(args['blob_name']);
  const localPath = String(args['local_path']);
  await downloadFromBlob(blobName, localPath);
  return { success: true, local_path: localPath };
}

// ── MCP Server factory ─────────────────────────────────────────────────────────

function createMcpServer(): Server {
  const server = new Server(
    { name: 'gmail-pdf-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case 'search_emails':
          result = await handleSearchEmails(args as Record<string, unknown>);
          break;
        case 'fetch_email_content':
          result = await handleFetchEmailContent(args as Record<string, unknown>);
          break;
        case 'convert_email_to_pdf':
          result = await handleConvertEmailToPdf(args as Record<string, unknown>);
          break;
        case 'batch_convert_emails':
          result = await handleBatchConvertEmails(args as Record<string, unknown>);
          break;
        case 'download_pdf_locally':
          result = await handleDownloadPdfLocally(args as Record<string, unknown>);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = (err as Error).message;
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ── Entry point ────────────────────────────────────────────────────────────────

async function main() {
  const isAzure = process.env.AZURE_DEPLOYMENT === 'true';

  if (isAzure) {
    const port = parseInt(process.env.PORT ?? '8080', 10);
    const app = express();
    app.use(express.json());

    // Per-session transport map: each client gets its own Server + Transport pair
    const transports = new Map<string, StreamableHTTPServerTransport>();

    app.all('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && transports.has(sessionId)) {
        // Existing session — forward to stored transport
        await transports.get(sessionId)!.handleRequest(req, res, req.body);
        return;
      }

      // New session — create a fresh Server + Transport pair
      const newSessionId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
      });
      transport.onclose = () => transports.delete(newSessionId);
      transports.set(newSessionId, transport);

      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    // Health check for Azure Container Apps
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));

    app.listen(port, () => {
      console.error(`Gmail PDF MCP Server listening on port ${port} (HTTP/SSE)`);
    });
  } else {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Gmail PDF MCP Server running on stdio');
  }

  // Cleanup browser on shutdown
  process.on('SIGTERM', async () => { await closeBrowser(); process.exit(0); });
  process.on('SIGINT', async () => { await closeBrowser(); process.exit(0); });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
