// A fake App Store Connect / Google Play, as a fetch. Every call is recorded;
// routes answer by method and path, and anything unrouted is a loud 500.

/** A real P-256 key, because the client signs before it fetches. */
export async function ascEnv(extra = {}) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return {
    ASC_KEY_ID: 'KEY123',
    ASC_ISSUER_ID: 'issuer-uuid',
    ASC_KEY_P8: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64')}\n-----END PRIVATE KEY-----\n`,
    ...extra,
  };
}

/**
 * @param {Array<[string, RegExp, (m: RegExpExecArray, body: any, url: string) => any]>} routes
 *   a handler returns a JSON body (status 200), `{ status, json }`, or null for 204
 */
export function fakeFetch(routes) {
  /** @type {{ method: string, path: string, body: any, headers: any }[]} */
  const calls = [];
  const fetchImpl = /** @type {typeof fetch} */ (async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const path = decodeURIComponent(url.pathname + url.search);
    let body = init.body;
    if (typeof body === 'string' && /^[[{]/.test(body)) body = JSON.parse(body);
    calls.push({ method, path, body, headers: init.headers });
    for (const [m, re, handler] of routes) {
      const match = m === method ? re.exec(path) : null;
      if (!match) continue;
      const out = handler(match, body, String(input));
      if (out === null) return new Response(null, { status: 204 });
      if (out && typeof out === 'object' && 'status' in out && 'json' in out) {
        return new Response(JSON.stringify(out.json), { status: out.status });
      }
      return new Response(JSON.stringify(out), { status: 200 });
    }
    return new Response(JSON.stringify({ errors: [{ title: 'unrouted', detail: `${method} ${path}` }] }), { status: 500 });
  });
  return { fetchImpl, calls };
}

/** Collects log lines. */
export function lines() {
  /** @type {string[]} */
  const out = [];
  return { out, log: (/** @type {string} */ l) => void out.push(l) };
}
