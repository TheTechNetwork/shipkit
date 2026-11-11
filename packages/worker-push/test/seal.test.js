// The sealed envelope, end to end, and against Fleetwright's committed one.
// Ported from Fleetwright's test/push-encryption.test.js and push-envelope-parity.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { sealTo, openWith, checkPublicKey, toBase64Url, fromBase64, envelopeFor } from '../src/index.js';

const info = 'test-push-v1';

/** A phone: a P-256 keypair whose private half never leaves. */
async function phone() {
  const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const pushKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return { pushKey, privateKey: pair.privateKey };
}

test('a sealed notification round-trips, and only to the phone it was for', async () => {
  const alice = await phone();
  const bob = await phone();
  const payload = { title: 'cc-brave-otter', body: 'Overwrite src/index.js?', data: { name: 'cc-brave-otter' } };
  const sealed = await sealTo(alice.pushKey, payload, { info });
  assert.deepEqual(await openWith(alice.privateKey, alice.pushKey, sealed, { info }), payload);
  await assert.rejects(() => openWith(bob.privateKey, bob.pushKey, sealed, { info }));
});

test('the info string is required and must match', async () => {
  // No default: an app and a server with different strings fail with nothing that names the cause.
  const alice = await phone();
  await assert.rejects(() => sealTo(alice.pushKey, { a: 1 }, /** @type {any} */ ({})), /info/);
  const sealed = await sealTo(alice.pushKey, { a: 1 }, { info });
  await assert.rejects(() => openWith(alice.privateKey, alice.pushKey, sealed, { info: 'other-push-v1' }));
});

test('two notifications to one phone share no bytes', async () => {
  const alice = await phone();
  const one = await sealTo(alice.pushKey, { title: 'a', body: 'b' }, { info });
  const two = await sealTo(alice.pushKey, { title: 'a', body: 'b' }, { info });
  assert.notEqual(one, two);
  const ephemeralOf = (/** @type {string} */ e) => toBase64Url(fromBase64(e).slice(17, 17 + 65));
  assert.notEqual(ephemeralOf(one), ephemeralOf(two));
  assert.deepEqual(await openWith(alice.privateKey, alice.pushKey, two, { info }), { title: 'a', body: 'b' });
});

test('a tampered envelope fails closed', async () => {
  const alice = await phone();
  const bytes = fromBase64(await sealTo(alice.pushKey, { title: 'yes', body: 'no' }, { info }));
  for (const at of [0, 5, 30, bytes.length - 1]) {
    const edited = new Uint8Array(bytes);
    edited[at] ^= 0x01;
    await assert.rejects(() => openWith(alice.privateKey, alice.pushKey, toBase64Url(edited), { info }), `a flipped bit at ${at} was accepted`);
  }
});

test('the version byte is checked rather than written', async () => {
  const alice = await phone();
  const bytes = fromBase64(await sealTo(alice.pushKey, { title: 'x', body: 'y' }, { info }));
  bytes[0] = 9;
  await assert.rejects(() => openWith(alice.privateKey, alice.pushKey, toBase64Url(bytes), { info }), /unsupported push envelope version 9/);
});

test('a key that is not a point on the curve is refused', async () => {
  const offCurve = new Uint8Array(65);
  offCurve[0] = 0x04;
  offCurve.fill(0x01, 1);
  const bad = await checkPublicKey(toBase64Url(offCurve));
  assert.equal(bad.ok, false);
  assert.match(String(/** @type {any} */ (bad).error), /P-256/);
  assert.equal((await checkPublicKey('nope')).ok, false);
  assert.equal((await checkPublicKey(toBase64Url(new Uint8Array(64)))).ok, false);
  assert.equal((await checkPublicKey('')).ok, false);
  const { pushKey } = await phone();
  assert.equal((await checkPublicKey(pushKey)).ok, true);
  // Both base64 alphabets.
  assert.equal((await checkPublicKey(pushKey.replace(/-/g, '+').replace(/_/g, '/'))).ok, true);
});

test('what goes on the wire carries no detail, and still fits', async () => {
  const alice = await phone();
  const message = {
    title: 'cc-brave-otter on deb132',
    body: 'Waiting: overwrite src/index.js, or write to a copy?',
    data: { name: 'cc-brave-otter', promptId: 'p-01J8' },
  };
  const seal = { info, title: 'Fleetwright', body: 'Something needs you. Open to see.' };
  const wire = await envelopeFor({ pushKey: alice.pushKey }, message, { now: () => 1_700_000_000_000, seal });
  assert.equal(wire.encrypted, true);
  assert.equal(/cc-brave-otter|overwrite|src\/index\.js/.test(JSON.stringify(wire)), false, 'a detail leaked outside the envelope');
  assert.deepEqual(Object.keys(wire.data), ['e']);
  assert.equal(wire.title, 'Fleetwright');
  assert.ok(JSON.stringify(wire).length < 2048, `wire payload is ${JSON.stringify(wire).length} bytes`);
  // sentAt and the (empty) category are sealed with the rest.
  assert.deepEqual(await openWith(alice.privateKey, alice.pushKey, wire.data.e, { info }), {
    title: message.title,
    body: message.body,
    data: { ...message.data, sentAt: '1700000000000', category: '' },
  });
});

test('the category is sealed beside the words, and stays out of an unsealed envelope', async () => {
  const alice = await phone();
  const asking = { title: 't', body: 'b', category: 'app.prompt.permission', data: { promptId: 'p' } };
  const sealed = await envelopeFor({ pushKey: alice.pushKey }, asking, { seal: { info } });
  assert.equal((await openWith(alice.privateKey, alice.pushKey, sealed.data.e, { info })).data.category, 'app.prompt.permission');
  assert.equal('category' in (await envelopeFor({}, asking)).data, false);
});

test('a phone that predates encryption still gets its notification, and needs no seal options', async () => {
  const wire = await envelopeFor({}, { title: 'cc-quiet-heron', body: 'stopped', data: { name: 'cc-quiet-heron' } }, { now: () => 1_700_000_000_000 });
  assert.equal(wire.encrypted, false);
  assert.equal(wire.title, 'cc-quiet-heron');
  assert.deepEqual(wire.data, { name: 'cc-quiet-heron', sentAt: '1700000000000' });
});

test('a device with a key and a sender with no seal.info is refused, not sent in the clear', async () => {
  const alice = await phone();
  await assert.rejects(() => envelopeFor({ pushKey: alice.pushKey }, { title: 'secret', body: 'x' }), /seal\.info/);
});

test("Fleetwright's phones' committed envelope opens with info fleetwright-push-v1", async () => {
  // The fixture the iOS and Android apps' own tests produce (Fleetwright test/fixtures/parity/push-envelope.json).
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/fleetwright-envelope.json', import.meta.url), 'utf8'));
  const { d, x, y, pushKey } = fixture.recipient;
  const privateKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d, x, y, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  assert.deepEqual(await openWith(privateKey, pushKey, fixture.envelope, { info: 'fleetwright-push-v1' }), fixture.plaintext);
});
