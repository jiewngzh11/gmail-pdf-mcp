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

// Per-session authenticated clients (keyed by MCP session ID)
const sessionClients = new Map<string, OAuth2Client>();

// Device flow state: device_code → sessionId + polling timer
interface DeviceAuthState {
  sessionId: string;
  deviceCode: string;
  interval: number;
  expiresAt: number;
  timer: ReturnType<typeof setInterval> | null;
  authorized: boolean;
  error?: string;
}
const deviceAuthStates = new Map<string, DeviceAuthState>(); // sessionId → state

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

// ── Credentials loader ─────────────────────────────────────────────────────────

function loadCredentials(): { clientId: string; clientSecret: string } {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }
  throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars not set');
}

// ── Azure mode: Key Vault refresh_token (fallback / admin-set token) ───────────

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
    const raw = await fs.readFile(TOKEN_PATH, 'utf-8');
    return JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
}

async function saveLocalToken(credentials: Credentials): Promise<void> {
  await fs.writeFile(TOKEN_PATH, JSON.stringify(credentials, null, 2), 'utf-8');
}

async function buildOAuth2Client(): Promise<OAuth2Client> {
  try {
    const { clientId, clientSecret } = loadCredentials();
    return new OAuth2Client(clientId, clientSecret, 'http://localhost:3000/oauth2callback');
  } catch {
    const credRaw = await fs.readFile(CREDENTIALS_PATH, 'utf-8');
    const { installed } = JSON.parse(credRaw);
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

// ── Device Flow (multi-user self-service authorization) ────────────────────────

export interface DeviceAuthResult {
  verification_url: string;
  user_code: string;
  expires_in: number;
  interval: number;
}

export async function startDeviceAuth(sessionId: string): Promise<DeviceAuthResult> {
  const { clientId } = loadCredentials();

  // Request device + user code from Google
  const resp = await fetch('https://oauth2.googleapis.com/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      scope: SCOPES.join(' '),
    }),
  });
  if (!resp.ok) throw new Error(`Device auth request failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as {
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
  };

  const state: DeviceAuthState = {
    sessionId,
    deviceCode: data.device_code,
    interval: data.interval,
    expiresAt: Date.now() + data.expires_in * 1000,
    timer: null,
    authorized: false,
  };

  // Stop any previous pending auth for this session
  const prev = deviceAuthStates.get(sessionId);
  if (prev?.timer) clearInterval(prev.timer);

  deviceAuthStates.set(sessionId, state);
  startDevicePolling(sessionId);

  return {
    verification_url: data.verification_url,
    user_code: data.user_code,
    expires_in: data.expires_in,
    interval: data.interval,
  };
}

function startDevicePolling(sessionId: string) {
  const state = deviceAuthStates.get(sessionId);
  if (!state) return;

  const { clientId, clientSecret } = loadCredentials();

  state.timer = setInterval(async () => {
    if (Date.now() > state.expiresAt) {
      clearInterval(state.timer!);
      state.error = 'Authorization expired';
      deviceAuthStates.delete(sessionId);
      return;
    }

    try {
      const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          device_code: state.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });

      const data = await resp.json() as Record<string, string>;

      if (data['access_token']) {
        clearInterval(state.timer!);
        state.authorized = true;

        const client = new OAuth2Client(clientId, clientSecret);
        client.setCredentials({
          access_token: data['access_token'],
          refresh_token: data['refresh_token'],
          expiry_date: Date.now() + parseInt(data['expires_in'] ?? '3600') * 1000,
        });
        sessionClients.set(sessionId, client);
        deviceAuthStates.delete(sessionId);
        console.error(`[auth] Session ${sessionId.slice(0, 8)} authorized via device flow`);
      } else if (data['error'] === 'access_denied' || data['error'] === 'expired_token') {
        clearInterval(state.timer!);
        state.error = data['error'];
        deviceAuthStates.delete(sessionId);
      }
      // 'authorization_pending' or 'slow_down' → just wait
    } catch {
      // Network error — continue polling
    }
  }, (state.interval + 1) * 1000);
}

export function getDeviceAuthStatus(sessionId: string): 'authorized' | 'pending' | 'expired' | 'none' {
  if (sessionClients.has(sessionId)) return 'authorized';
  const state = deviceAuthStates.get(sessionId);
  if (!state) return 'none';
  if (state.error) return 'expired';
  return 'pending';
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Returns an OAuth2 client for the given session:
 * 1. Session-level token (from device flow) — highest priority
 * 2. Key Vault / token.json fallback
 */
export async function getAuthClientForSession(sessionId: string): Promise<OAuth2Client> {
  if (sessionClients.has(sessionId)) {
    return sessionClients.get(sessionId)!;
  }
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
