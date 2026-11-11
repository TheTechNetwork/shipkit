// Notification content that APNs, FCM and any relay cannot read.
//
//   ECDH P-256  →  HKDF-SHA256  →  AES-256-GCM
//   envelope = version(1) ‖ salt(16) ‖ ephemeral public key(65) ‖ ciphertext+tag
//
// Every piece is in WebCrypto, CryptoKit and the Android Keystore, so the phone
// half needs no library. The KDF follows RFC 8291's shape (both public keys
// bound into `info`) but drops its aes128gcm framing: one small record only.
// It hides CONTENT, not that a notification was sent, when, or to whom.

import { fromBase64, b64url as toBase64Url } from './jwt.js';

export { fromBase64, toBase64Url };

/** Checked on open, so a future scheme is a different first byte. */
const VERSION = 1;
/** Uncompressed X9.62: 0x04 ‖ X ‖ Y, the one encoding every platform agrees on. */
const PUBLIC_KEY_BYTES = 65;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

/**
 * The domain-separation string, required. Two peers with different `info`
 * fail with a bare "decryption failed", so there is no default to drift from.
 *
 * @param {string|undefined} info
 */
function infoBytes(info) {
  if (typeof info !== 'string' || !info) {
    throw new TypeError('sealing needs an `info` string shared with the app, e.g. "myapp-push-v1"');
  }
  return new TextEncoder().encode(info);
}

/** @param {Uint8Array} raw */
function importPublicKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

/**
 * Validate a device's public key when it registers, not when a send fails.
 *
 * @param {unknown} value base64 (either alphabet) of an uncompressed P-256 point
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function checkPublicKey(value) {
  if (typeof value !== 'string' || !value) return { ok: false, error: 'a push key must be a base64 string' };
  let bytes;
  try {
    bytes = fromBase64(value);
  } catch {
    return { ok: false, error: 'a push key must be base64' };
  }
  if (bytes.length !== PUBLIC_KEY_BYTES || bytes[0] !== 0x04) {
    return { ok: false, error: `a push key must be a ${PUBLIC_KEY_BYTES}-byte uncompressed P-256 point` };
  }
  try {
    // WebCrypto rejects off-curve points on import: the invalid-curve attack stops here.
    await importPublicKey(bytes);
  } catch {
    return { ok: false, error: 'that push key is not a point on P-256' };
  }
  return { ok: true };
}

/**
 * Encrypt one payload to one device. A fresh ephemeral key per message, so two
 * notifications to one phone share no bytes.
 *
 * @param {string} recipientKey base64 of the device's public key
 * @param {unknown} payload anything JSON-serialisable
 * @param {{ info: string }} opts
 * @returns {Promise<string>} base64url envelope
 */
export async function sealTo(recipientKey, payload, { info } = /** @type {any} */ ({})) {
  const prefix = infoBytes(info);
  const recipientRaw = fromBase64(String(recipientKey));
  const recipient = await importPublicKey(recipientRaw);

  const ephemeral = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const ephemeralRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: recipient }, ephemeral.privateKey, 256));

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const { key, nonce } = await derive(prefix, shared, salt, recipientRaw, ephemeralRaw);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, plaintext));

  const out = new Uint8Array(1 + SALT_BYTES + PUBLIC_KEY_BYTES + sealed.length);
  out[0] = VERSION;
  out.set(salt, 1);
  out.set(ephemeralRaw, 1 + SALT_BYTES);
  out.set(sealed, 1 + SALT_BYTES + PUBLIC_KEY_BYTES);
  return toBase64Url(out);
}

/**
 * The other half, for tests and Node consumers. Apps implement it natively so
 * the private key never leaves the secure element.
 *
 * @param {CryptoKey} privateKey ECDH P-256 private key
 * @param {string} recipientKey base64 of the matching public key
 * @param {string} envelope as produced by sealTo
 * @param {{ info: string }} opts
 */
export async function openWith(privateKey, recipientKey, envelope, { info } = /** @type {any} */ ({})) {
  const prefix = infoBytes(info);
  const bytes = fromBase64(envelope);
  if (bytes.length < 1 + SALT_BYTES + PUBLIC_KEY_BYTES + 16) throw new Error('envelope is too short');
  if (bytes[0] !== VERSION) throw new Error(`unsupported push envelope version ${bytes[0]}`);

  const salt = bytes.slice(1, 1 + SALT_BYTES);
  const ephemeralRaw = bytes.slice(1 + SALT_BYTES, 1 + SALT_BYTES + PUBLIC_KEY_BYTES);
  const sealed = bytes.slice(1 + SALT_BYTES + PUBLIC_KEY_BYTES);

  const ephemeral = await importPublicKey(ephemeralRaw);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeral }, privateKey, 256));
  const { key, nonce } = await derive(prefix, shared, salt, fromBase64(String(recipientKey)), ephemeralRaw);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, sealed));
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * Key and nonce from the shared secret. Both public keys go into `info`, so a
 * ciphertext is bound to the pair it was made for (as in RFC 8291).
 *
 * @param {Uint8Array} prefix @param {Uint8Array} shared @param {Uint8Array} salt
 * @param {Uint8Array} recipientRaw @param {Uint8Array} ephemeralRaw
 */
async function derive(prefix, shared, salt, recipientRaw, ephemeralRaw) {
  const info = new Uint8Array(prefix.length + recipientRaw.length + ephemeralRaw.length);
  info.set(prefix, 0);
  info.set(recipientRaw, prefix.length);
  info.set(ephemeralRaw, prefix.length + recipientRaw.length);

  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const okm = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, ikm, (KEY_BYTES + NONCE_BYTES) * 8));
  const key = await crypto.subtle.importKey('raw', okm.slice(0, KEY_BYTES), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, nonce: okm.slice(KEY_BYTES, KEY_BYTES + NONCE_BYTES) };
}
