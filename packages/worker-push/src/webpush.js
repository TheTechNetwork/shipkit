// Web Push to browsers: RFC 8291 message encryption (aes128gcm, RFC 8188)
// with RFC 8292 VAPID authentication. WebCrypto only, like the rest.

import { b64url, fromBase64, pemToBytes } from './jwt.js';
import { PUSH_TTL_S, deadReporter, errorText } from './push.js';

/** @typedef {import('./push.js').Pusher} Pusher */
/** @typedef {import('./push.js').SenderOptions} SenderOptions */
/** @typedef {{ endpoint: string, keys: { p256dh: string, auth: string } }} Subscription */

/** One record, so the record size only has to exceed the payload. */
const RECORD_SIZE = 4096;
/** RFC 8030: push services must accept at least 4096 bytes of body. */
const MAX_BODY = 4096;

const enc = new TextEncoder();

/** @param {...Uint8Array} parts */
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** @param {Uint8Array} salt @param {Uint8Array} ikm @param {Uint8Array} info @param {number} bytes */
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/**
 * Content key and nonce, RFC 8291 §3.3–3.4. `uaPublic` and `asPublic` are the
 * 65-byte uncompressed points of the browser and of this message's ephemeral key.
 *
 * @param {Uint8Array} ecdhSecret @param {Uint8Array} authSecret @param {Uint8Array} salt
 * @param {Uint8Array} uaPublic @param {Uint8Array} asPublic
 */
async function contentKeys(ecdhSecret, authSecret, salt, uaPublic, asPublic) {
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  return { cek, nonce };
}

/**
 * Encrypt one message to one subscription.
 *
 * @param {Subscription['keys']} keys  the subscription's p256dh and auth, base64url
 * @param {Uint8Array} plaintext
 * @param {{ salt?: Uint8Array, asKeyPair?: CryptoKeyPair }} [testing]  fixed values for RFC test vectors only
 * @returns {Promise<Uint8Array>} the request body: header ‖ ciphertext
 */
export async function encryptWebPush(keys, plaintext, { salt, asKeyPair } = {}) {
  const uaPublic = fromBase64(keys.p256dh);
  const authSecret = fromBase64(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('p256dh must be a 65-byte uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes');
  const ua = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const as = asKeyPair ?? /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, as.privateKey, 256));
  const s = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const { cek, nonce } = await contentKeys(ecdh, authSecret, s, uaPublic, asPublic);

  // 0x02 marks the last (and only) record; no padding beyond it.
  const padded = concat(plaintext, new Uint8Array([2]));
  if (padded.length + 16 > RECORD_SIZE) throw new Error('web push payload is too large for one record');
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, padded));

  // Header: salt(16) ‖ record size(4, big-endian) ‖ idlen(1) ‖ keyid = as_public(65).
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE);
  return concat(s, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/**
 * Decrypt a single-record aes128gcm body, as the browser would. For tests and
 * for Node consumers checking a subscription end to end.
 *
 * @param {CryptoKey} uaPrivateKey  the browser's ECDH P-256 private key
 * @param {Subscription['keys']} keys
 * @param {Uint8Array} body
 */
export async function decryptWebPush(uaPrivateKey, keys, body) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const as = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: as }, uaPrivateKey, 256));
  const { cek, nonce } = await contentKeys(ecdh, fromBase64(keys.auth), salt, fromBase64(keys.p256dh), asPublic);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, ciphertext));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('not a final aes128gcm record');
  return padded.slice(0, end);
}

/**
 * The VAPID signing key, from the raw form web-push libraries print (base64url
 * 32-byte private scalar plus 65-byte public point) or a PKCS#8 PEM.
 *
 * @param {{ publicKey: string, privateKey: string }} vapid
 */
async function vapidKey(vapid) {
  if (/BEGIN/.test(vapid.privateKey)) {
    return crypto.subtle.importKey('pkcs8', pemToBytes(vapid.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  }
  const pub = fromBase64(vapid.publicKey);
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: vapid.privateKey.replace(/=+$/, ''), x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/**
 * The Authorization header for one push service origin, RFC 8292 §3:
 * `vapid t=<ES256 JWT with aud, exp, sub>, k=<public key>`.
 *
 * @param {string} endpoint
 * @param {{ subject: string, publicKey: string, privateKey: string }} vapid
 * @param {{ now?: () => number, ttlSeconds?: number }} [opts]
 */
export async function vapidAuthorization(endpoint, vapid, { now = () => Date.now(), ttlSeconds = 12 * 3600 } = {}) {
  // exp must be within 24 hours; the audience is the push service's origin, not the full endpoint.
  const claim = { aud: new URL(endpoint).origin, exp: Math.floor(now() / 1000) + ttlSeconds, sub: vapid.subject };
  const unsigned = `${b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))}.${b64url(enc.encode(JSON.stringify(claim)))}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidKey(vapid), enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64url(new Uint8Array(signature))}, k=${vapid.publicKey.replace(/=+$/, '')}`;
}

/**
 * The subscription a device carries: `device.subscription`, or the token
 * itself holding the PushSubscription JSON.
 *
 * @param {import('./push.js').Device} device
 * @returns {Subscription}
 */
function subscriptionOf(device) {
  const sub = device.subscription ?? JSON.parse(device.token);
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('not a PushSubscription: needs endpoint, keys.p256dh and keys.auth');
  return sub;
}

/**
 * Web Push to browsers. Each device's `token` is what is reported dead; its
 * subscription is `device.subscription` or the token parsed as JSON.
 *
 * The body is `{ title, body, data, category? }` as JSON for the service
 * worker's `push` event; it is already end-to-end encrypted, so `seal` is not used.
 *
 * @param {{ subject: string, publicKey: string, privateKey: string }} vapid
 *   subject is a `mailto:` or `https:` contact for the push service
 * @param {SenderOptions & { fetchImpl?: typeof fetch }} [opts]
 * @returns {Pusher}
 */
export function webPusher(vapid, { logger, fetchImpl, now = () => Date.now(), onDead, collapseKey } = {}) {
  const log = logger || { info() {}, warn() {} };
  const doFetch = fetchImpl || globalThis.fetch;
  const reportDead = deadReporter(onDead, log);
  /** @type {Map<string, { header: string, made: number }>} */
  const auth = new Map();

  /** @param {string} endpoint */
  async function authorization(endpoint) {
    const origin = new URL(endpoint).origin;
    const hit = auth.get(origin);
    if (hit && now() - hit.made < 60 * 60_000) return hit.header;
    const header = await vapidAuthorization(endpoint, vapid, { now });
    auth.set(origin, { header, made: now() });
    return header;
  }

  return {
    async send(devices, message) {
      let sent = 0;
      /** @type {string[]} */
      const dead = [];
      for (const device of devices) {
        try {
          const sub = subscriptionOf(device);
          const data = { ...(message.data || {}), sentAt: String(now()) };
          const json = JSON.stringify({ title: message.title, body: message.body, data, ...(message.category ? { category: message.category } : {}) });
          const body = await encryptWebPush(sub.keys, enc.encode(json));
          if (body.length > MAX_BODY) throw new Error(`payload is ${body.length} bytes; push services accept ${MAX_BODY}`);
          const collapse = collapseKey ? collapseKey({ encrypted: false, title: message.title, body: message.body, data }, message) : message.collapseKey;
          // Topic must be ≤32 URL-safe base64 characters, or the service rejects the request.
          const topic = collapse && /^[A-Za-z0-9_-]{1,32}$/.test(collapse) ? { topic: collapse } : {};
          const res = await doFetch(sub.endpoint, {
            method: 'POST',
            headers: {
              authorization: await authorization(sub.endpoint),
              'content-encoding': 'aes128gcm',
              'content-type': 'application/octet-stream',
              ttl: String(PUSH_TTL_S),
              urgency: 'high',
              ...topic,
            },
            body,
          });
          if (res.status >= 200 && res.status < 300) {
            sent++;
            continue;
          }
          const text = (await res.text().catch(() => '')).slice(0, 200);
          // 404 and 410: the subscription expired or the user revoked it.
          if (res.status === 404 || res.status === 410) {
            dead.push(device.token);
            log.warn(`push: dropping dead web subscription (${res.status})`);
            await reportDead(device.token, device.platform);
          } else {
            log.warn(`push: web push ${res.status} ${text}`);
          }
        } catch (err) {
          log.warn(`push: a ${device.platform} device was skipped — ${errorText(err)}`);
        }
      }
      return { sent, dead };
    },
  };
}
