import fs from 'fs/promises';
import path from 'path';
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

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
