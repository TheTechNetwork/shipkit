// App Store Connect API: an ES256 token and a fetch that reads Apple's errors.

import { signJwtES256 } from '@thetechnetwork/worker-push/jwt';

export const ASC = 'https://api.appstoreconnect.apple.com';

/**
 * @typedef {(path: string, init?: RequestInit) => Promise<any>} Api
 * @typedef {{ api: Api, all: (path: string) => Promise<{ data: any[], included: any[] }> }} AscClient
 */

/**
 * @param {{ keyId: string, issuerId: string, privateKey: string, fetchImpl?: typeof fetch, now?: () => number }} o
 * @returns {AscClient}
 */
export function ascClient({ keyId, issuerId, privateKey, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  /** @type {{ token: string, made: number } | null} */
  let cached = null;

  async function token() {
    // Apple refuses exp more than 20 minutes out; reuse for 10 so a long run never sends a stale one.
    if (cached && now() - cached.made < 10 * 60_000) return cached.token;
    const iat = Math.floor(now() / 1000);
    cached = { token: await signJwtES256({ iss: issuerId, iat, exp: iat + 20 * 60, aud: 'appstoreconnect-v1' }, privateKey, keyId), made: now() };
    return cached.token;
  }

  /** @type {Api} */
  async function api(path, init = {}) {
    const url = path.startsWith('https://') ? path : `${ASC}${path}`;
    const res = await fetchImpl(url, {
      ...init,
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', ...(init.headers || {}) },
    });
    if (res.status === 204) return null;
    const body = await res.text();
    if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status}\n  ${appleErrors(body)}`);
    return body ? JSON.parse(body) : null;
  }

  /** Every page, with `included` kept. @param {string} path */
  async function all(path) {
    /** @type {any[]} */
    const data = [];
    /** @type {any[]} */
    const included = [];
    /** @type {string|null} */
    let next = path;
    while (next) {
      const page = await api(next);
      data.push(...(page?.data ?? []));
      included.push(...(page?.included ?? []));
      next = page?.links?.next ?? null;
    }
    return { data, included };
  }

  return { api, all };
}

/**
 * Apple's refusal, readable. The associated errors (under meta, keyed by
 * resource) are the actual reason; the top line only says to look at them.
 *
 * @param {string} body
 */
export function appleErrors(body) {
  try {
    const parsed = JSON.parse(body);
    const lines = (parsed.errors || []).map((/** @type {any} */ e) => {
      const assoc = Object.values(e.meta?.associatedErrors || {})
        .flat()
        .map((/** @type {any} */ a) => `- ${a.title}: ${a.detail}`);
      return [`${e.title}: ${e.detail}`, ...assoc].join('\n  ');
    });
    if (lines.length) return lines.join('\n  ');
  } catch {}
  return body.slice(0, 400);
}

/**
 * Apple's reason on one line: api() puts the request first and Apple's words after.
 *
 * @param {unknown} e
 */
export function reason(e) {
  const lines = String(e instanceof Error ? e.message : e)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines.length > 1 ? lines.slice(1).join('; ') : lines[0]) || 'no reason given';
}

/** The credentials every App Store Connect command needs. @param {Record<string, string|undefined>} env */
export function ascFromEnv(env, fetchImpl = globalThis.fetch) {
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 } = requireEnv(env, ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8']);
  return ascClient({ keyId: ASC_KEY_ID, issuerId: ASC_ISSUER_ID, privateKey: ASC_KEY_P8, fetchImpl });
}

/**
 * @template {string} K
 * @param {Record<string, string|undefined>} env @param {K[]} names
 * @returns {Record<K, string>}
 */
export function requireEnv(env, names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`missing required setting: ${missing.join(', ')}`);
  return /** @type {any} */ (Object.fromEntries(names.map((n) => [n, env[n]])));
}

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
