// google_oauth_setup.mjs -- one-time interactive script to mint a Gmail+Calendar refresh
// token for modules/google.mjs (Module 3, phase 2). Run once with: node google_oauth_setup.mjs
//
// Prints an authorization URL -- open it, sign in with the Google account Athena should
// act as, approve -- then this catches the redirect on a local loopback port, exchanges
// the code for tokens, and prints the refresh_token to save into config/.env.
//
// Scopes requested are the ones Module 3's plan calls for: read + compose (never send)
// for Gmail, read + create/update events for Calendar.

import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, 'config', '.env');

function loadEnv(path) {
  const cfg = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    cfg[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return cfg;
}

const cfg = loadEnv(ENV_PATH);
const CLIENT_ID = cfg.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = cfg.GOOGLE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in config/.env -- add those first.');
  process.exit(1);
}

const PORT = 8642;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPES,
  access_type: 'offline',
  prompt: 'consent',
}).toString();

console.log('AUTH_URL:' + authUrl);
console.log('(waiting for the redirect on ' + REDIRECT_URI + ' ...)');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.end('Authorization failed: ' + error + '. You can close this tab.');
    console.error('AUTH_ERROR:' + error);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.end('No code received.');
    return;
  }
  res.end('Athena is authorized. You can close this tab and go back to the terminal.');

  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }).toString();

  const tokenReq = https.request({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, (tokenRes) => {
    let data = '';
    tokenRes.on('data', (c) => data += c);
    tokenRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.refresh_token) {
          console.log('RESULT_OK:' + parsed.refresh_token);
        } else {
          console.log('RESULT_NO_REFRESH_TOKEN:' + data);
        }
      } catch (e) {
        console.error('RESULT_PARSE_ERROR:' + data);
      }
      server.close();
      process.exit(0);
    });
  });
  tokenReq.on('error', (e) => { console.error('RESULT_TOKEN_EXCHANGE_FAILED:' + e.message); server.close(); process.exit(1); });
  tokenReq.write(body);
  tokenReq.end();
});

server.listen(PORT, '127.0.0.1');

setTimeout(() => {
  console.error('RESULT_TIMEOUT: no authorization within 5 minutes -- re-run to try again.');
  server.close();
  process.exit(1);
}, 5 * 60 * 1000);
