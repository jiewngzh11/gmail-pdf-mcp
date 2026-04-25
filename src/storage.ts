import fs from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import type { OAuth2Client } from 'google-auth-library';

const isAzure = process.env.AZURE_DEPLOYMENT === 'true';

// Azure Blob Storage client (lazy init)
let blobServiceClient: BlobServiceClient | null = null;

function getBlobServiceClient(): BlobServiceClient {
  if (!blobServiceClient) {
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    if (!accountName) throw new Error('AZURE_STORAGE_ACCOUNT_NAME is not set');

    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
    if (accountKey) {
      // Use account key when available (fallback when RBAC isn't configured)
      const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
      blobServiceClient = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        sharedKeyCredential
      );
    } else {
      // Use Managed Identity (DefaultAzureCredential) in Container Apps
      const credential = new DefaultAzureCredential();
      blobServiceClient = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        credential
      );
    }
  }
  return blobServiceClient;
}

// Upload PDF to Azure Blob Storage and return SAS URL valid for 24 hours
export async function uploadToBlob(
  pdfBuffer: Buffer,
  blobName: string
): Promise<{ blobName: string; url: string }> {
  const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME ?? 'gmail-pdfs';
  const client = getBlobServiceClient();
  const containerClient = client.getContainerClient(containerName);

  // Create container if it doesn't exist
  await containerClient.createIfNotExists();

  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.upload(pdfBuffer, pdfBuffer.length, {
    blobHTTPHeaders: { blobContentType: 'application/pdf' },
  });

  const startsOn = new Date();
  const expiresOn = new Date(startsOn.getTime() + 24 * 60 * 60 * 1000);
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME!;
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;

  let sasToken: string;
  if (accountKey) {
    // Account key available — sign SAS directly without user delegation key
    const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
    sasToken = generateBlobSASQueryParameters(
      {
        containerName,
        blobName,
        permissions: BlobSASPermissions.parse('r'),
        startsOn,
        expiresOn,
      },
      sharedKeyCredential
    ).toString();
  } else {
    // Managed Identity — use user delegation key
    const userDelegationKey = await client.getUserDelegationKey(startsOn, expiresOn);
    sasToken = generateBlobSASQueryParameters(
      {
        containerName,
        blobName,
        permissions: BlobSASPermissions.parse('r'),
        startsOn,
        expiresOn,
      },
      userDelegationKey,
      accountName
    ).toString();
  }

  const url = `${blockBlobClient.url}?${sasToken}`;
  return { blobName, url };
}

// Save PDF to local filesystem
export async function saveToLocal(
  pdfBuffer: Buffer,
  dirPath: string,
  filename: string
): Promise<string> {
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = path.join(dirPath, filename);
  await fs.writeFile(filePath, pdfBuffer);
  return filePath;
}

// Download a blob to a local path
export async function downloadFromBlob(
  blobName: string,
  localPath: string
): Promise<void> {
  const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME ?? 'gmail-pdfs';
  const client = getBlobServiceClient();
  const containerClient = client.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  const dir = path.dirname(localPath);
  await fs.mkdir(dir, { recursive: true });
  await blockBlobClient.downloadToFile(localPath);
}

// ── Google Drive helpers ───────────────────────────────────────────────────────

async function getOrCreateDriveFolder(
  drive: any,
  name: string,
  parentId?: string
): Promise<string> {
  const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const parentQ = parentId ? `'${parentId}' in parents` : `'root' in parents`;
  const q = `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false and ${parentQ}`;

  const res = await drive.files.list({ q, fields: 'files(id)', spaces: 'drive' });
  if (res.data.files?.length > 0) return res.data.files[0].id as string;

  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id',
  });
  return folder.data.id as string;
}

/**
 * Upload a PDF to the user's Google Drive under:
 *   Gmail PDF MCP / {senderName} / {filename}
 * Returns a shareable view link (anyone with link can view).
 */
export async function saveToDrive(
  auth: OAuth2Client,
  pdfBuffer: Buffer,
  senderName: string,
  filename: string
): Promise<{ driveUrl: string; driveFileId: string }> {
  const { google } = await import('googleapis');
  const drive = google.drive({ version: 'v3', auth });

  const rootId = await getOrCreateDriveFolder(drive, 'Gmail PDF MCP');
  const senderId = await getOrCreateDriveFolder(drive, senderName, rootId);

  const file = await drive.files.create({
    requestBody: { name: filename, parents: [senderId] },
    media: { mimeType: 'application/pdf', body: Readable.from(pdfBuffer) },
    fields: 'id,webViewLink',
  });

  await drive.permissions.create({
    fileId: file.data.id!,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return { driveUrl: file.data.webViewLink!, driveFileId: file.data.id! };
}

// ── Unified save (Blob + Drive) ────────────────────────────────────────────────

// Save PDF using the appropriate backend
export async function savePdf(
  pdfBuffer: Buffer,
  blobPath: string,        // e.g. "John_Doe/John_Doe_20260425_143022.pdf"
  localDirPath: string,    // local directory path
  filename: string         // e.g. "John_Doe_20260425_143022.pdf"
): Promise<{ localPath?: string; pdfUrl?: string; blobName?: string }> {
  if (isAzure) {
    const result = await uploadToBlob(pdfBuffer, blobPath);
    return { pdfUrl: result.url, blobName: result.blobName };
  } else {
    const localPath = await saveToLocal(pdfBuffer, localDirPath, filename);
    return { localPath };
  }
}
