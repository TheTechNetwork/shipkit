// Google's JWT-bearer flow, shared by Play here and FCM in worker-push.

import { signJwtRS256 } from './jwt.js';

/**
 * A service account as raw JSON or base64 of it.
 *
 * @param {string} raw
 * @returns {{ client_email: string, private_key: string, project_id?: string }}
 */
export function serviceAccount(raw) {
  const trimmed = String(raw || '').trim();
  const text = trimmed.startsWith('{') ? trimmed : new TextDecoder().decode(Uint8Array.from(atob(trimmed.replace(/\s+/g, '')), (c) => c.charCodeAt(0)));
  const parsed = JSON.parse(text);
  if (!parsed.client_email || !parsed.private_key) throw new Error('service account is missing client_email or private_key');
  return parsed;
}

/**
 * @param {{ client_email: string, private_key: string }} account
 * @param {string} scope
 * @param {typeof fetch} [fetchImpl]
 */
export async function googleAccessToken(account, scope, fetchImpl = globalThis.fetch) {
  const iat = Math.floor(Date.now() / 1000);
  const jwt = await signJwtRS256({ iss: account.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }, account.private_key);
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return /** @type {string} */ ((/** @type {any} */ (await res.json())).access_token);
}
