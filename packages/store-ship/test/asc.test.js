// The App Store Connect API token, against Apple's documented shape
// ("Generating Tokens for API Requests"): every store-ship command is a 401
// without it, and nothing else in these tests reads what the fake is sent.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ascClient } from '../src/asc.js';
import { ascEnv } from './fake.js';

test('the API token is what Apple documents: ES256 with kid, aud appstoreconnect-v1, expiring within 20 minutes', async () => {
  const env = await ascEnv();
  const now = 1_700_000_000_000;
  /** @type {string[]} */
  const auth = [];
  const fetchImpl = /** @type {typeof fetch} */ (async (_url, init) => {
    auth.push(/** @type {any} */ (init?.headers).authorization);
    return new Response('{"data":[]}', { status: 200 });
  });
  const { api } = ascClient({ keyId: env.ASC_KEY_ID, issuerId: env.ASC_ISSUER_ID, privateKey: env.ASC_KEY_P8, fetchImpl, now: () => now });
  await api('/v1/apps');
  const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(auth[0]);
  assert.ok(m, `not a bearer JWT: ${auth[0]}`);
  const [, h, c] = m;
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
  const claim = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claim.iss, 'issuer-uuid');
  assert.equal(claim.aud, 'appstoreconnect-v1');
  assert.equal(claim.iat, now / 1000);
  assert.ok(claim.exp > claim.iat && claim.exp - claim.iat <= 20 * 60, `exp is ${claim.exp - claim.iat}s after iat; Apple refuses more than 1200`);
});
