import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { URL } from 'url';
import { OAuth2Client, Credentials } from 'google-auth-library';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

const isAzure = process.env.AZURE_DEPLOYMENT === 'true';

// --- Azure Key Vault helpers ---

function getKeyVaultClient(): SecretClient {
  const kvUrl = process.env.AZURE_KEY_VAULT_URL;
  if (!kvUrl) throw new Error('AZURE_KEY_VAULT_URL is not set');
  return new SecretClient(kvUrl, new DefaultAzureCredential());
}

async function getRefreshTokenFromKeyVault(): Promise<string> {
  const client = getKeyVaultClient();
  const secret = await client.getSecret('gmail-refresh-token');
  if (!secret.value) throw new Error('Secret "gmail-refresh-token" is empty in Key Vault');
  return secret.value;
}

export async function saveRefreshTokenToKeyVault(refreshToken: string): Promise<void> {
  const client = getKeyVaultClient();
  await client.setSecret('gmail-refresh-token', refreshToken);
  console.error('refresh_token saved to Key Vault.');
}

function loadCredentials(): { clientId: string; clientSecret: string; redirectUri: string } {
  // Prefer individual env vars (useful in Azure where we don't mount credentials.json)
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3000/oauth2callback',
    };
  }
  throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars not set');
}

// --- Azure mode: refresh_token from Key Vault ---

async function getAzureOAuth2Client(): Promise<OAuth2Client> {
  const { clientId, clientSecret, redirectUri } = loadCredentials();
  const client = new OAuth2Client(clientId, clientSecret, redirectUri);

  const refreshToken = await getRefreshTokenFromKeyVault();
  client.setCredentials({ refresh_token: refreshToken });

  // If Google ever rotates the refresh_token, persist the new one
  client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      saveRefreshTokenToKeyVault(tokens.refresh_token).catch(() => {});
    }
  });

  return client;
}

// --- Local mode: interactive OAuth2 flow + token.json ---

async function loadLocalToken(): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(TOKEN_PATH, 'utf-8');
    return JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
}

async function saveLocalToken(credentials: Credentials): Promise<void> {
  await fs.writeFile(TOKEN_PATH, JSON.stringify(credentials, null, 2), 'utf-8');
}

async function buildLocalClient(): Promise<OAuth2Client> {
  // Try env vars first; fall back to credentials.json (Desktop app format)
  try {
    const { clientId, clientSecret } = loadCredentials();
    const port = parseInt(process.env.OAUTH_PORT ?? '3000', 10);
    return new OAuth2Client(clientId, clientSecret, `http://localhost:${port}/oauth2callback`);
  } catch {
    const credRaw = await fs.readFile(CREDENTIALS_PATH, 'utf-8');
    const { installed } = JSON.parse(credRaw);
    const port = parseInt(process.env.OAUTH_PORT ?? '3000', 10);
    return new OAuth2Client(
      installed.client_id,
      installed.client_secret,
      `http://localhost:${port}/oauth2callback`
    );
  }
}

async function runInteractiveOAuth(client: OAuth2Client): Promise<Credentials> {
  const port = parseInt(process.env.OAUTH_PORT ?? '3000', 10);

  const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });

  const { default: open } = await import('open');
  console.error('Opening browser for Gmail OAuth2 authorization...');
  await open(authUrl);
  console.error(`If browser did not open, visit:\n${authUrl}`);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/oauth2callback')) return;
      const url = new URL(req.url, `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>授權完成，可以關閉此分頁。</h1>');
      server.close();

      if (error || !code) {
        reject(new Error(`OAuth error: ${error ?? 'no code returned'}`));
        return;
      }
      try {
        const { tokens } = await client.getToken(code);
        resolve(tokens);
      } catch (err) {
        reject(err);
      }
    });

    server.listen(port, () => {
      console.error(`Waiting for OAuth2 callback on port ${port}...`);
    });
    server.on('error', reject);
  });
}

async function getLocalOAuth2Client(): Promise<OAuth2Client> {
  const client = await buildLocalClient();

  const saved = await loadLocalToken();
  if (saved) {
    client.setCredentials(saved);
    client.on('tokens', (tokens) => {
      saveLocalToken({ ...saved, ...tokens }).catch(() => {});
    });
    return client;
  }

  const tokens = await runInteractiveOAuth(client);
  await saveLocalToken(tokens);
  client.setCredentials(tokens);
  client.on('tokens', (newTokens) => {
    saveLocalToken({ ...tokens, ...newTokens }).catch(() => {});
  });
  return client;
}

// --- Public API ---

export async function getAuthClient(): Promise<OAuth2Client> {
  return isAzure ? getAzureOAuth2Client() : getLocalOAuth2Client();
}

// Quick standalone test
if (require.main === module) {
  (async () => {
    console.error('Testing auth...');
    const client = await getAuthClient();
    const gmail = (await import('googleapis')).google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    console.error('Authenticated as:', profile.data.emailAddress);
  })().catch(console.error);
}
