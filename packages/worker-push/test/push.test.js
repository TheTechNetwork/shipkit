// APNs, FCM and routing. Ported from Fleetwright's test/push.test.js, minus
// the coordinator: these are the sender-level tests.

import test from 'node:test';
import assert from 'node:assert/strict';

import { apnsPusher, fcmPusher, logPusher, routingPusher, signJwtES256, signJwtRS256, pemToBytes, parseServiceAccount, toBase64Url } from '../src/index.js';
import { apnsKey, serviceAccount, fcmFetch, quiet, recorder } from './helpers.js';

test('the APNs JWT is ES256, carries the key id, and verifies', async () => {
  const { pair, pem } = await apnsKey();
  const jwt = await signJwtES256({ iss: 'TEAMID1234', iat: 1_700_000_000 }, pem, 'KEYID5678');
  const [h, c, sig] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, 'KEYID5678', 'the key id lives in the header, not the claim');
  assert.equal(JSON.parse(Buffer.from(c, 'base64url').toString()).iss, 'TEAMID1234');
  const signature = Buffer.from(sig, 'base64url');
  assert.equal(signature.length, 64, 'raw r||s, not DER');
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, signature, new TextEncoder().encode(`${h}.${c}`)), true);
});

test('the FCM JWT is RS256 and verifies', async () => {
  const { pair, account } = await serviceAccount();
  const jwt = await signJwtRS256({ iss: account.client_email, exp: 1, iat: 0 }, account.private_key);
  const [header, claim, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'RS256');
  assert.equal(JSON.parse(Buffer.from(claim, 'base64url').toString()).iss, account.client_email);
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey, Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${claim}`)), true);
});

test('a PEM whose newlines survived an env var as backslash-n still parses', () => {
  const real = '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBg\n-----END PRIVATE KEY-----';
  assert.deepEqual(pemToBytes(real.replace(/\n/g, '\\n')), pemToBytes(real));
});

test('a service account is read as raw JSON or as base64, and mangled JSON is refused', () => {
  const account = { project_id: 'p', client_email: 'e@x', private_key: '-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----\n' };
  const json = JSON.stringify(account);
  const b64 = Buffer.from(json).toString('base64');
  assert.deepEqual(parseServiceAccount(json), account);
  assert.deepEqual(parseServiceAccount(b64), account);
  assert.deepEqual(parseServiceAccount(b64.replace(/(.{40})/g, '$1\n')), account);
  // What systemd does to a raw-JSON value: real newlines inside a JSON string.
  assert.equal(parseServiceAccount('{"project_id":"p","private_key":"-----BEGIN-----\n-----END-----"}'), null);
});

test('an APNs token rejected by FCM is kept, not silently unregistered', async () => {
  const { lines, logger } = recorder();
  const pusher = fcmPusher((await serviceAccount()).account, {
    logger,
    fetchImpl: fcmFetch(() => new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }), { status: 400 })),
  });
  const r = await pusher.send([{ token: 'a1b2c3d4e5f6', platform: 'ios' }], { title: 't', body: 'b' });
  assert.deepEqual(r, { sent: 0, dead: [] });
  assert.match(lines.join('\n'), /INVALID_ARGUMENT/);
});

test('an unregistered FCM token is reported dead, to the caller and to onDead', async () => {
  /** @type {string[]} */
  const told = [];
  const pusher = fcmPusher((await serviceAccount()).account, {
    logger: quiet,
    onDead: (token, platform) => {
      told.push(`${platform}:${token}`);
    },
    fetchImpl: fcmFetch(() => new Response(JSON.stringify({ error: { status: 'UNREGISTERED' } }), { status: 404 })),
  });
  const r = await pusher.send([{ token: 'gone-forever', platform: 'android' }], { title: 't', body: 'b' });
  assert.deepEqual(r.dead, ['gone-forever']);
  assert.deepEqual(told, ['android:gone-forever']);
});

test('an onDead that throws is logged and does not stop the send', async () => {
  const { lines, logger } = recorder();
  let calls = 0;
  const pusher = fcmPusher((await serviceAccount()).account, {
    logger,
    onDead: () => {
      throw new Error('database down');
    },
    fetchImpl: fcmFetch(() => {
      calls++;
      return new Response('UNREGISTERED', { status: 404 });
    }),
  });
  const r = await pusher.send([{ token: 'a', platform: 'android' }, { token: 'b', platform: 'android' }], { title: 't', body: 'b' });
  assert.equal(calls, 2);
  assert.deepEqual(r.dead, ['a', 'b']);
  assert.match(lines.join('\n'), /onDead failed/);
});

test('a device whose envelope cannot be sealed does not stop the others being sent', async () => {
  /** @type {string[]} */
  const delivered = [];
  const pusher = fcmPusher((await serviceAccount()).account, {
    logger: quiet,
    seal: { info: 'x-push-v1' },
    fetchImpl: fcmFetch((m) => {
      delivered.push(m.token);
      return new Response('{}', { status: 200 });
    }),
  });
  const r = await pusher.send(
    [
      { platform: 'android', token: 'first' },
      { platform: 'android', token: 'bad-key', pushKey: 'not-a-public-key' },
      { platform: 'android', token: 'third' },
    ],
    { title: 't', body: 'x' },
  );
  assert.deepEqual(delivered, ['first', 'third']);
  assert.equal(r.sent, 2);
});

test('an FCM push carries a ttl, a collapse key when asked, and when it was sent', async () => {
  /** @type {any[]} */
  const bodies = [];
  const pusher = fcmPusher((await serviceAccount()).account, {
    logger: quiet,
    now: () => 1_700_000_000_000,
    fetchImpl: fcmFetch((m) => {
      bodies.push(m);
      return new Response('{}', { status: 200 });
    }),
  });
  await pusher.send([{ platform: 'android', token: 'a' }], { title: 't', body: 'b', collapseKey: 'cc-brave-otter' });
  assert.equal(bodies[0].android.ttl, '3600s');
  assert.equal(bodies[0].android.priority, 'HIGH');
  assert.equal(bodies[0].android.collapse_key, 'cc-brave-otter');
  assert.equal(bodies[0].data.sentAt, '1700000000000');
  await pusher.send([{ platform: 'android', token: 'a' }], { title: 't', body: 'b' });
  assert.equal(bodies[1].android.collapse_key, undefined);
});

test('the collapse key can be derived from the wire, as Fleetwright does from data.name', async () => {
  /** @type {any[]} */
  const bodies = [];
  const pusher = fcmPusher((await serviceAccount()).account, {
    logger: quiet,
    collapseKey: (wire) => wire.data.name,
    fetchImpl: fcmFetch((m) => {
      bodies.push(m);
      return new Response('{}', { status: 200 });
    }),
  });
  await pusher.send([{ platform: 'android', token: 'a' }], { title: 't', body: 'b', data: { name: 'cc-brave-otter' } });
  assert.equal(bodies[0].android.collapse_key, 'cc-brave-otter');
});

test('a notification the app draws reaches Android data-only, with its words in data', async () => {
  /** @type {any[]} */
  const bodies = [];
  const pusher = fcmPusher((await serviceAccount()).account, {
    logger: quiet,
    fetchImpl: fcmFetch((m) => {
      bodies.push(m);
      return new Response('{}', { status: 200 });
    }),
  });
  const device = [{ token: 'android-1', platform: 'android' }];
  await pusher.send(device, { title: 'Adding a hypervisor', body: 'Step 2 of 8', drawnByApp: true, data: { kind: 'xosetup' } });
  await pusher.send(device, { title: 'Session waiting', body: 'is waiting for you' });
  const [progress, ordinary] = bodies;
  assert.equal('notification' in progress, false);
  assert.equal(progress.data.title, 'Adding a hypervisor');
  assert.ok(ordinary.notification);
});

test('a sealed FCM push is data-only, and keeps an alert for the APNs bridge', async () => {
  /** @type {any[]} */
  const bodies = [];
  const pusher = fcmPusher((await serviceAccount()).account, {
    logger: quiet,
    seal: { info: 'x-push-v1', title: 'App', body: 'Something needs you.' },
    fetchImpl: fcmFetch((m) => {
      bodies.push(m);
      return new Response('{}', { status: 200 });
    }),
  });
  const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const pushKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  await pusher.send([{ token: 'a', platform: 'android', pushKey }], { title: 'secret title', body: 'secret body' });
  const m = bodies[0];
  assert.equal('notification' in m, false);
  assert.deepEqual(Object.keys(m.data), ['e']);
  assert.equal(m.apns.payload.aps['mutable-content'], 1);
  assert.equal(m.apns.payload.aps.alert.title, 'App');
  assert.doesNotMatch(JSON.stringify(m), /secret/);
});

test('an APNs push sends what Apple expects and drops a token Apple has buried', async () => {
  const { pem } = await apnsKey();
  /** @type {any[]} */
  const calls = [];
  /** @type {string[]} */
  const told = [];
  const pusher = apnsPusher(
    { keyId: 'K', teamId: 'T', bundleId: 'network.thetech.fleetwright', privateKey: pem },
    {
      logger: quiet,
      onDead: (token) => {
        told.push(token);
      },
      deliver: async (token, payload, headers) => {
        calls.push({ token, payload: JSON.parse(payload), headers });
        return token === 'gone' ? { status: 410, body: '{"reason":"Unregistered"}' } : { status: 200, body: '' };
      },
    },
  );
  const r = await pusher.send(
    [{ token: 'alive', platform: 'ios' }, { token: 'gone', platform: 'ios' }],
    { title: 'cc-brave-otter', body: 'is waiting for you', data: { name: 'cc-brave-otter' } },
  );
  assert.equal(r.sent, 1);
  assert.deepEqual(r.dead, ['gone']);
  assert.deepEqual(told, ['gone']);
  const first = calls[0];
  assert.equal(first.headers['apns-topic'], 'network.thetech.fleetwright');
  assert.equal(first.headers['apns-push-type'], 'alert');
  assert.equal(first.headers['apns-priority'], '10');
  assert.match(first.headers.authorization, /^bearer eyJ/);
  assert.equal(first.payload.aps.alert.title, 'cc-brave-otter');
  assert.equal(first.payload.name, 'cc-brave-otter', 'data rides alongside aps');
});

test('the APNs bearer token is reused rather than minted per notification', async () => {
  const { pem } = await apnsKey();
  const seen = new Set();
  const pusher = apnsPusher(
    { keyId: 'K', teamId: 'T', bundleId: 'b', privateKey: pem },
    {
      logger: quiet,
      deliver: async (_t, _p, headers) => {
        seen.add(headers.authorization);
        return { status: 200, body: '' };
      },
    },
  );
  await pusher.send([{ token: 'a', platform: 'ios' }, { token: 'b', platform: 'ios' }], { title: 't', body: 'b' });
  await pusher.send([{ token: 'c', platform: 'ios' }], { title: 't', body: 'b' });
  assert.equal(seen.size, 1);
});

test('an APNs push expires, collapses when asked, and says when it was sent', async () => {
  const { pem } = await apnsKey();
  /** @type {any[]} */
  const calls = [];
  const pusher = apnsPusher(
    { keyId: 'K', teamId: 'T', bundleId: 'b', privateKey: pem },
    {
      logger: quiet,
      now: () => 1_700_000_000_000,
      deliver: async (token, payload, headers) => {
        calls.push({ token, payload: JSON.parse(payload), headers });
        return { status: 200, body: '' };
      },
    },
  );
  await pusher.send([{ token: 'alive', platform: 'ios' }], { title: 't', body: 'b', collapseKey: 'cc-brave-otter' });
  assert.equal(calls[0].headers['apns-expiration'], String(1_700_000_000 + 3600));
  assert.equal(calls[0].headers['apns-collapse-id'], 'cc-brave-otter');
  assert.equal(calls[0].payload.sentAt, '1700000000000');
});

test('a notification with work behind it wakes the app on iOS, alongside the alert', async () => {
  const { pem } = await apnsKey();
  /** @type {any[]} */
  const calls = [];
  const pusher = apnsPusher(
    { keyId: 'K', teamId: 'T', bundleId: 'b', privateKey: pem },
    { logger: quiet, deliver: async (_t, payload) => (calls.push(JSON.parse(payload)), { status: 200, body: '' }) },
  );
  await pusher.send([{ token: 'i', platform: 'ios' }], { title: 'join?', body: 'b', category: 'app.join', wake: true });
  assert.equal(calls[0].aps['content-available'], 1);
  assert.equal(calls[0].aps.category, 'app.join');
  assert.ok(calls[0].aps.alert);
});

test('an APNs token goes in the URL as one path segment', async () => {
  const { pem } = await apnsKey();
  const victim = '9b1f3c7e5a2d4806'.repeat(4);
  const real = globalThis.fetch;
  /** @type {string[]} */
  const urls = [];
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url) => {
    urls.push(String(url));
    return new Response('{"reason":"BadDeviceToken"}', { status: 400 });
  });
  try {
    const pusher = apnsPusher({ keyId: 'K', teamId: 'T', bundleId: 'b', privateKey: pem }, { logger: quiet });
    await pusher.send([{ token: `zz/../${victim}`, platform: 'ios' }, { token: `${victim}#zz`, platform: 'ios' }], { title: 't', body: 'b' });
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(urls.length, 2);
  for (const url of urls) assert.notEqual(new URL(url).pathname, `/3/device/${victim}`, url);
});

test('a Live Activity update uses its own topic and push type, and drops ended tokens', async () => {
  const { pem } = await apnsKey();
  /** @type {any[]} */
  const calls = [];
  const pusher = apnsPusher(
    { keyId: 'K', teamId: 'T', bundleId: 'b.app', privateKey: pem },
    {
      logger: quiet,
      deliver: async (token, payload, headers) => {
        calls.push({ token, payload: JSON.parse(payload), headers });
        return token === 'ended' ? { status: 410, body: '' } : { status: 200, body: '' };
      },
    },
  );
  const r = await pusher.activity?.(['live', 'ended'], { event: 'update', state: { step: 2 }, priority: 5 });
  assert.deepEqual(r, { sent: 1, dead: ['ended'] });
  assert.equal(calls[0].headers['apns-topic'], 'b.app.push-type.liveactivity');
  assert.equal(calls[0].headers['apns-push-type'], 'liveactivity');
  assert.equal(calls[0].headers['apns-priority'], '5');
  assert.deepEqual(calls[0].payload.aps['content-state'], { step: 2 });
});

test('iOS goes to APNs and everything else goes to FCM', async () => {
  /** @type {string[]} */
  const toApns = [];
  /** @type {string[]} */
  const toFcm = [];
  const pusher = routingPusher({
    ios: { async send(devices) { toApns.push(...devices.map((d) => d.token)); return { sent: devices.length, dead: [] }; } },
    other: { async send(devices) { toFcm.push(...devices.map((d) => d.token)); return { sent: devices.length, dead: ['bad'] }; } },
  });
  const r = await pusher.send(
    [{ token: 'iphone', platform: 'ios' }, { token: 'pixel', platform: 'android' }, { token: 'browser', platform: 'web' }],
    { title: 't', body: 'b' },
  );
  assert.deepEqual(toApns, ['iphone']);
  assert.deepEqual(toFcm, ['pixel', 'browser'], 'without a web sender, web goes where it always did');
  assert.equal(r.sent, 3);
  assert.deepEqual(r.dead, ['bad']);
});

test('with a web sender, browsers go to it and not to FCM', async () => {
  /** @type {Record<string, string[]>} */
  const seen = { ios: [], web: [], other: [] };
  /** @param {string} k */
  const into = (k) => ({ async send(/** @type {any[]} */ d) { seen[k].push(...d.map((x) => x.token)); return { sent: d.length, dead: [] }; } });
  await routingPusher({ ios: into('ios'), web: into('web'), other: into('other') }).send(
    [{ token: 'i', platform: 'ios' }, { token: 'w', platform: 'web' }, { token: 'a', platform: 'android' }],
    { title: 't', body: 'b' },
  );
  assert.deepEqual(seen, { ios: ['i'], web: ['w'], other: ['a'] });
});

test('a sender for one platform blowing up does not stop the other platform', async () => {
  /** @type {string[]} */
  const seen = [];
  const pusher = routingPusher({
    ios: { async send() { throw new Error('APNs is having a day'); } },
    other: { async send(devices) { seen.push(...devices.map((d) => d.token)); return { sent: devices.length, dead: [] }; } },
    logger: quiet,
  });
  const r = await pusher.send([{ platform: 'ios', token: 'i' }, { platform: 'android', token: 'a' }], { title: 't', body: 'b' });
  assert.deepEqual(seen, ['a']);
  assert.equal(r.sent, 1);
});

test('the log pusher is a real sender, not a stub that pretends', async () => {
  const { lines, logger } = recorder();
  const r = await logPusher(logger).send([{ token: 'x', platform: 'ios' }], { title: 'a', body: 'b' });
  assert.deepEqual(r, { sent: 0, dead: [] });
  assert.match(lines.join('\n'), /not configured, would send to 1/);
});
