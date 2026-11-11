// Web Push: the RFC 8291 Appendix A example, byte for byte, and VAPID.

import test from 'node:test';
import assert from 'node:assert/strict';

import { encryptWebPush, decryptWebPush, vapidAuthorization, webPusher, fromBase64, toBase64Url } from '../src/index.js';
import { quiet } from './helpers.js';

// RFC 8291, Section 5 and Appendix A (whitespace removed).
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  // Section 5's complete message, which must equal header ‖ ciphertext.
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** A P-256 key from its raw private scalar and public point. @param {string} d @param {string} pub @param {KeyUsage[]} usages */
function ecdhJwk(d, pub, usages) {
  const p = fromBase64(pub);
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d, x: toBase64Url(p.slice(1, 33)), y: toBase64Url(p.slice(33, 65)), ext: true },
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    usages,
  );
}

test('RFC 8291 Appendix A: the example message is reproduced byte for byte', async () => {
  const asKeyPair = {
    privateKey: await ecdhJwk(RFC.asPrivate, RFC.asPublic, ['deriveBits']),
    publicKey: await crypto.subtle.importKey('raw', fromBase64(RFC.asPublic), { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  };
  const body = await encryptWebPush({ p256dh: RFC.uaPublic, auth: RFC.auth }, new TextEncoder().encode(RFC.plaintext), {
    salt: fromBase64(RFC.salt),
    asKeyPair,
  });
  assert.equal(toBase64Url(body.slice(0, 86)), RFC.header, 'the 86-octet header');
  assert.equal(toBase64Url(body.slice(86)), RFC.ciphertext, 'the ciphertext');
  assert.equal(toBase64Url(body), RFC.message, 'the whole Section 5 message');
});

test('RFC 8291 Section 5: the example message decrypts with the user agent key', async () => {
  const uaPrivate = await ecdhJwk(RFC.uaPrivate, RFC.uaPublic, ['deriveBits']);
  const plain = await decryptWebPush(uaPrivate, { p256dh: RFC.uaPublic, auth: RFC.auth }, fromBase64(RFC.message));
  assert.equal(new TextDecoder().decode(plain), RFC.plaintext);
});

test('a fresh message round-trips and never repeats its salt or key', async () => {
  const ua = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const keys = { p256dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
  const one = await encryptWebPush(keys, new TextEncoder().encode('hi'));
  const two = await encryptWebPush(keys, new TextEncoder().encode('hi'));
  assert.notEqual(toBase64Url(one.slice(0, 86)), toBase64Url(two.slice(0, 86)));
  assert.equal(new TextDecoder().decode(await decryptWebPush(ua.privateKey, keys, one)), 'hi');
});

/** A VAPID key in the raw form `web-push generate-vapid-keys` prints. */
async function vapidKeys() {
  const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return { pair, vapid: { subject: 'mailto:ops@example.com', publicKey, privateKey: String(jwk.d) } };
}

test('the VAPID header is RFC 8292: t= an ES256 JWT for the origin, k= the public key', async () => {
  const { pair, vapid } = await vapidKeys();
  const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def', vapid, { now: () => 1_700_000_000_000 });
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m[2], vapid.publicKey);
  const [h, c, s] = m[1].split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  const claim = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claim.aud, 'https://fcm.googleapis.com', 'the audience is the origin, not the endpoint');
  assert.equal(claim.sub, 'mailto:ops@example.com');
  assert.ok(claim.exp - 1_700_000_000 <= 24 * 3600, 'exp within 24 hours');
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(`${h}.${c}`)), true);
});

test('webPusher posts aes128gcm with the right headers, and drops a gone subscription', async () => {
  const { vapid } = await vapidKeys();
  const ua = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const keys = { p256dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
  /** @type {any[]} */
  const posts = [];
  /** @type {string[]} */
  const told = [];
  const pusher = webPusher(vapid, {
    logger: quiet,
    now: () => 1_700_000_000_000,
    onDead: (token) => {
      told.push(token);
    },
    fetchImpl: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
      posts.push({ url, init });
      return new Response('', { status: url.endsWith('/gone') ? 410 : 201 });
    }),
  });
  const alive = { endpoint: 'https://push.example/alive', keys };
  const r = await pusher.send(
    [
      { platform: 'web', token: 'w1', subscription: alive },
      { platform: 'web', token: JSON.stringify({ endpoint: 'https://push.example/gone', keys }) },
    ],
    { title: 'Match!', body: 'You and Sam both said yes', data: { matchId: 'm1' }, collapseKey: 'match-m1' },
  );
  assert.equal(r.sent, 1);
  assert.equal(r.dead.length, 1);
  assert.deepEqual(told, r.dead);
  const { headers, body } = posts[0].init;
  assert.equal(headers['content-encoding'], 'aes128gcm');
  assert.equal(headers.ttl, '3600');
  assert.equal(headers.urgency, 'high');
  assert.equal(headers.topic, 'match-m1');
  assert.match(headers.authorization, /^vapid t=eyJ/);
  const plain = JSON.parse(new TextDecoder().decode(await decryptWebPush(ua.privateKey, keys, body)));
  assert.deepEqual(plain, { title: 'Match!', body: 'You and Sam both said yes', data: { matchId: 'm1', sentAt: '1700000000000' } });
});

test('a subscription that is not one is skipped, and the rest still go', async () => {
  const { vapid } = await vapidKeys();
  let posted = 0;
  const pusher = webPusher(vapid, { logger: quiet, fetchImpl: /** @type {any} */ (async () => (posted++, new Response('', { status: 201 }))) });
  const ua = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const keys = { p256dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))), auth: toBase64Url(new Uint8Array(16)) };
  const r = await pusher.send([{ platform: 'web', token: 'not json' }, { platform: 'web', token: 'ok', subscription: { endpoint: 'https://p.example/x', keys } }], { title: 't', body: 'b' });
  assert.equal(r.sent, 1);
  assert.equal(posted, 1);
});
