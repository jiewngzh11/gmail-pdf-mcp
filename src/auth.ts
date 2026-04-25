import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { URL } from 'url';
import { OAuth2Client, Credentials } from 'google-auth-library';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.file',
];
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

const isAzure = process.env.AZURE_DEPLOYMENT === 'true';

// Per-session OAuth2 clients (keyed by MCP session ID)
const sessionClients = new Map<string, OAuth2Client>();

// Pending Web OAuth states: state UUID → session ID
const pendingOAuthStates = new Map<string, string>();

// ── Azure Key Vault helpers ────────────────────────────────────────────────────

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

// ── Credential loaders ─────────────────────────────────────────────────────────

/** Desktop/installed app credentials — used for Key Vault fallback & local setup */
function loadCredentials(): { clientId: string; clientSecret: string } {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }
  throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars not set');
}

/** Web application credentials — used for per-user redirect OAuth on Azure */
function loadWebCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_WEB_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_WEB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_WEB_CLIENT_ID / GOOGLE_WEB_CLIENT_SECRET env vars not set');
  }
  return { clientId, clientSecret };
}

function getOAuthCallbackUrl(): string {
  return process.env.OAUTH_CALLBACK_URL ??
    'https://gmail-pdf-mcp.livelymoss-77bbcaee.eastasia.azurecontainerapps.io/oauth2callback';
}

// ── Azure mode: Key Vault refresh_token (admin-set fallback) ───────────────────

async function getAzureOAuth2Client(): Promise<OAuth2Client> {
  const { clientId, clientSecret } = loadCredentials();
  const client = new OAuth2Client(clientId, clientSecret);
  const refreshToken = await getRefreshTokenFromKeyVault();
  client.setCredentials({ refresh_token: refreshToken });
  client.on('tokens', (tokens) => {
    if (tokens.refresh_token) saveRefreshTokenToKeyVault(tokens.refresh_token).catch(() => {});
  });
  return client;
}

// ── Local mode: interactive OAuth2 + token.json ────────────────────────────────

async function loadLocalToken(): Promise<Credentials | null> {
  try {
    return JSON.parse(await fs.readFile(TOKEN_PATH, 'utf-8')) as Credentials;
  } catch { return null; }
}

async function saveLocalToken(credentials: Credentials): Promise<void> {
  await fs.writeFile(TOKEN_PATH, JSON.stringify(credentials, null, 2), 'utf-8');
}

async function buildOAuth2Client(): Promise<OAuth2Client> {
  try {
    const { clientId, clientSecret } = loadCredentials();
    return new OAuth2Client(clientId, clientSecret, 'http://localhost:3000/oauth2callback');
  } catch {
    const { installed } = JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf-8'));
    return new OAuth2Client(installed.client_id, installed.client_secret, 'http://localhost:3000/oauth2callback');
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
      if (error || !code) { reject(new Error(`OAuth error: ${error ?? 'no code'}`)); return; }
      try { const { tokens } = await client.getToken(code); resolve(tokens); }
      catch (err) { reject(err); }
    });
    server.listen(port, () => console.error(`Waiting for OAuth2 callback on port ${port}...`));
    server.on('error', reject);
  });
}

async function getLocalOAuth2Client(): Promise<OAuth2Client> {
  const client = await buildOAuth2Client();
  const saved = await loadLocalToken();
  if (saved) {
    client.setCredentials(saved);
    client.on('tokens', (tokens) => saveLocalToken({ ...saved, ...tokens }).catch(() => {}));
    return client;
  }
  const tokens = await runInteractiveOAuth(client);
  await saveLocalToken(tokens);
  client.setCredentials(tokens);
  client.on('tokens', (newTokens) => saveLocalToken({ ...tokens, ...newTokens }).catch(() => {}));
  return client;
}

// ── Web OAuth redirect flow (per-user, Azure mode) ─────────────────────────────

/**
 * Generate a Google OAuth URL for the session. The redirect goes back to
 * the Container App's /oauth2callback route.
 */
export function generateWebAuthUrl(sessionId: string): string {
  const { clientId, clientSecret } = loadWebCredentials();
  const callbackUrl = getOAuthCallbackUrl();
  const client = new OAuth2Client(clientId, clientSecret, callbackUrl);

  const state = randomUUID();
  pendingOAuthStates.set(state, sessionId);
  // Auto-expire state after 30 minutes
  setTimeout(() => pendingOAuthStates.delete(state), 30 * 60 * 1000);

  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  });
}

/**
 * Called by the /oauth2callback Express route to exchange the code for tokens
 * and store them for the associated session.
 */
export async function completeOAuthCallback(state: string, code: string): Promise<void> {
  const sessionId = pendingOAuthStates.get(state);
  if (!sessionId) throw new Error('Invalid or expired authorization state. Please call authorize_gmail again.');
  pendingOAuthStates.delete(state);

  const { clientId, clientSecret } = loadWebCredentials();
  const callbackUrl = getOAuthCallbackUrl();
  const client = new OAuth2Client(clientId, clientSecret, callbackUrl);

  const { tokens } = await client.getToken(code);
  if (!tokens.access_token && !tokens.refresh_token) throw new Error('No tokens returned from Google');

  client.setCredentials(tokens);
  sessionClients.set(sessionId, client);
  console.error(`[auth] Session ${sessionId.slice(0, 8)} authorized via Web OAuth`);
}

export function getSessionAuthStatus(sessionId: string): 'authorized' | 'pending' | 'none' {
  if (sessionClients.has(sessionId)) return 'authorized';
  // Check if there's a pending state for this session
  for (const sid of pendingOAuthStates.values()) {
    if (sid === sessionId) return 'pending';
  }
  return 'none';
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Returns an OAuth2 client for the session:
 * 1. Session-level token from Web OAuth (highest priority)
 * 2. Key Vault / local token.json fallback
 */
export async function getAuthClientForSession(sessionId: string): Promise<OAuth2Client> {
  if (sessionClients.has(sessionId)) return sessionClients.get(sessionId)!;
  return isAzure ? getAzureOAuth2Client() : getLocalOAuth2Client();
}

/** Backward-compatible shorthand (used by setup scripts) */
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
