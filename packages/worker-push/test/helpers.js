// Real keys, generated per test: the senders sign before they ever fetch.

/** A .p8 as Apple hands it over. */
export async function apnsKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return { pair, pem: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64')}\n-----END PRIVATE KEY-----\n` };
}

/** A Google service account with a real RSA key. */
export async function serviceAccount() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return {
    pair,
    account: {
      client_email: 'svc@example.iam.gserviceaccount.com',
      project_id: 'p',
      private_key: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64')}\n-----END PRIVATE KEY-----\n`,
    },
  };
}

/** A fetch that answers the OAuth exchange and hands every send to `onSend`. */
export function fcmFetch(onSend) {
  return async (/** @type {any} */ url, /** @type {any} */ init) => {
    if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    return onSend(JSON.parse(init.body).message);
  };
}

export const quiet = { info() {}, warn() {} };

/** A logger that keeps what it was told. */
export function recorder() {
  /** @type {string[]} */
  const lines = [];
  return { lines, logger: { info: (/** @type {any} */ m) => lines.push(String(m)), warn: (/** @type {any} */ m) => lines.push(String(m)) } };
}
