// JWTs for Apple and Google, signed with WebCrypto only.
//
// PORTABLE ON PURPOSE: no `node:` import, so the same file runs in Node 20+ and
// in a Cloudflare Worker. store-ship carries a byte-identical copy (test-checked).

/**
 * Sign an ES256 JWT: APNs provider tokens and App Store Connect API tokens.
 *
 * WebCrypto returns raw r||s, which is what JWS wants; DER is what makes Apple
 * answer InvalidProviderToken.
 *
 * @param {Record<string, unknown>} claim
 * @param {string} pem PKCS#8, the contents of the .p8
 * @param {string} keyId
 */
export async function signJwtES256(claim, pem, keyId) {
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const encoder = new TextEncoder();
  const unsigned = `${b64url(encoder.encode(JSON.stringify(header)))}.${b64url(encoder.encode(JSON.stringify(claim)))}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToBytes(pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(signature))}`;
}

/**
 * Sign an RS256 JWT: Google service-account assertions (FCM, Play).
 *
 * @param {Record<string, unknown>} claim
 * @param {string} pem PKCS#8, as it appears in the service-account JSON
 */
export async function signJwtRS256(claim, pem) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encoder = new TextEncoder();
  const unsigned = `${b64url(encoder.encode(JSON.stringify(header)))}.${b64url(encoder.encode(JSON.stringify(claim)))}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToBytes(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(signature))}`;
}

/**
 * A PEM private key as bytes. Accepts a literal backslash-n, which is what a
 * key's newlines become after an environment variable.
 *
 * @param {string} pem
 */
export function pemToBytes(pem) {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** @param {Uint8Array} bytes */
export function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * base64 in either alphabet, padded or not.
 *
 * @param {string} value
 */
export function fromBase64(value) {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
