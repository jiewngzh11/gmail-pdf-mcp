/**
 * One-time setup script: run locally to obtain a Gmail refresh_token
 * and upload it to Azure Key Vault for use by the Azure deployment.
 *
 * Usage:
 *   npx ts-node src/setup-azure-token.ts
 *
 * Prerequisites:
 *   1. credentials.json (Desktop app OAuth2) in project root, OR
 *      GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars set
 *   2. Azure CLI logged in as jiewngzh11@gmail.com  (az login)
 *   3. AZURE_KEY_VAULT_URL set in .env.local
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { URL } from 'url';
import { OAuth2Client } from 'google-auth-library';
import { saveRefreshTokenToKeyVault } from './auth.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

async function getOAuthClient(): Promise<OAuth2Client> {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'http://localhost:3000/oauth2callback'
    );
  }
  const raw = await fs.readFile(CREDENTIALS_PATH, 'utf-8');
  const { installed } = JSON.parse(raw);
  return new OAuth2Client(
    installed.client_id,
    installed.client_secret,
    'http://localhost:3000/oauth2callback'
  );
}

async function getRefreshToken(client: OAuth2Client): Promise<string> {
  // prompt=consent forces Google to issue a new refresh_token every time
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  const { default: open } = await import('open');
  console.log('\n=== Gmail OAuth2 Setup ===');
  console.log('Opening browser for authorization...');
  await open(authUrl);
  console.log('If browser did not open, visit:\n' + authUrl);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/oauth2callback')) return;

      const url = new URL(req.url, 'http://localhost:3000');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>授權完成，可以關閉此分頁。</h1>');
      server.close();

      if (error || !code) {
        reject(new Error(`OAuth error: ${error ?? 'no code'}`));
        return;
      }

      try {
        const { tokens } = await client.getToken(code);
        if (!tokens.refresh_token) {
          reject(new Error('No refresh_token returned. Try revoking access at https://myaccount.google.com/permissions and re-running.'));
          return;
        }
        resolve(tokens.refresh_token);
      } catch (err) {
        reject(err);
      }
    });

    server.listen(3000, () => console.log('Waiting for OAuth callback on port 3000...'));
    server.on('error', reject);
  });
}

async function main() {
  const client = await getOAuthClient();
  const refreshToken = await getRefreshToken(client);

  console.log('\nOAuth2 successful!');
  console.log('Uploading refresh_token to Azure Key Vault...');

  if (!process.env.AZURE_KEY_VAULT_URL) {
    // Not uploading - just print it for manual entry
    console.log('\nAZURE_KEY_VAULT_URL not set. Your refresh_token (store this securely):');
    console.log(refreshToken);
    console.log('\nTo upload manually:');
    console.log(`  az keyvault secret set --vault-name YOUR_VAULT --name gmail-refresh-token --value "${refreshToken}"`);
    return;
  }

  await saveRefreshTokenToKeyVault(refreshToken);
  console.log('\nDone! The refresh_token is now in Key Vault as secret "gmail-refresh-token".');
  console.log('Azure Container App can now authenticate with Gmail without browser interaction.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
