// pusherFromEnv: off unless switched on, loud when on and unable, and every
// name carries the caller's prefix. Ported from Fleetwright's push.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { pusherFromEnv } from '../src/index.js';
import { recorder, serviceAccount } from './helpers.js';

const FW = { prefix: 'FLEETWRIGHT_' };

test('with no credentials configured, push logs and says so', async () => {
  const { lines, logger } = recorder();
  const r = await pusherFromEnv({}, { logger }).send([{ token: 'a', platform: 'ios' }], { title: 'x', body: 'y' });
  assert.equal(r.sent, 0);
  assert.match(lines.join('\n'), /disabled \(PUSH is not set\)/);
});

test('push is off unless it is switched on, credentials or not', () => {
  const { lines, logger } = recorder();
  for (const value of [undefined, '0', 'false', 'no', 'off', '']) {
    lines.length = 0;
    pusherFromEnv({ FLEETWRIGHT_PUSH: value, FLEETWRIGHT_FCM_SERVICE_ACCOUNT: '{"project_id":"p"}' }, { ...FW, logger });
    assert.match(lines.join('\n'), /disabled \(FLEETWRIGHT_PUSH is not set\)/, `FLEETWRIGHT_PUSH=${JSON.stringify(value)} enabled push`);
  }
});

test('switched on with no provider is the loudest case, and names prefixed variables', () => {
  const { lines, logger } = recorder();
  pusherFromEnv({ FLEETWRIGHT_PUSH: '1' }, { ...FW, logger, fallbackHint: 'The relay needs FLEETWRIGHT_RELAY_URL.' });
  const text = lines.join('\n');
  assert.match(text, /no provider is configured/);
  assert.match(text, /FLEETWRIGHT_APNS_KEY/);
  assert.match(text, /FLEETWRIGHT_FCM_SERVICE_ACCOUNT/);
  assert.match(text, /FLEETWRIGHT_VAPID_PUBLIC_KEY/);
  assert.match(text, /FLEETWRIGHT_RELAY_URL/);
  assert.match(text, /Unset FLEETWRIGHT_PUSH if that is deliberate/);
});

test('a fallback is used only when no provider of our own is configured', () => {
  let asked = 0;
  const relay = { async send() { return { sent: 7, dead: [] }; } };
  const fallback = () => (asked++, relay);
  assert.equal(pusherFromEnv({ PUSH: '1' }, { fallback }), relay);
  pusherFromEnv({ PUSH: '1', FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'p', client_email: 'e', private_key: 'k' }) }, { fallback });
  assert.equal(asked, 1);
});

test('half a set of APNs credentials is refused rather than half-configured', () => {
  const { lines, logger } = recorder();
  pusherFromEnv({ PUSH: '1', APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T' }, { logger });
  assert.match(lines.join('\n'), /all three/);
});

test('APNs without a bundle id is refused, unless the caller supplies a default', () => {
  const env = { PUSH: '1', APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_KEY: 'pem' };
  const a = recorder();
  pusherFromEnv(env, { logger: a.logger });
  assert.match(a.lines.join('\n'), /APNS_BUNDLE_ID/);
  const b = recorder();
  pusherFromEnv(env, { logger: b.logger, defaultBundleId: 'network.thetech.fleetwright' });
  assert.match(b.lines.join('\n'), /APNs configured for network\.thetech\.fleetwright/);
});

test('a malformed service account falls back to logging rather than throwing', () => {
  const { lines, logger } = recorder();
  assert.ok(pusherFromEnv({ FLEETWRIGHT_PUSH: '1', FLEETWRIGHT_FCM_SERVICE_ACCOUNT: 'not json' }, { ...FW, logger }));
  assert.ok(pusherFromEnv({ FLEETWRIGHT_PUSH: '1', FLEETWRIGHT_FCM_SERVICE_ACCOUNT: '{"project_id":"p"}' }, { ...FW, logger }));
  // Two warnings each: what is wrong, then that there is no provider at all.
  assert.equal(lines.length, 4);
  assert.equal(lines.filter((w) => /no provider is configured/.test(w)).length, 2);
  assert.match(lines.join('\n'), /base64/);
});

test('a base64 service account configures FCM end to end', async () => {
  const { lines, logger } = recorder();
  const { account } = await serviceAccount();
  pusherFromEnv({ PUSH: '1', FCM_SERVICE_ACCOUNT: Buffer.from(JSON.stringify({ ...account, project_id: 'proj-42' })).toString('base64') }, { logger });
  assert.match(lines.join('\n'), /FCM configured for project proj-42/);
});

test('VAPID keys configure Web Push, and half of them do not', () => {
  const a = recorder();
  pusherFromEnv({ PUSH: '1', VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k', VAPID_SUBJECT: 'mailto:x@y' }, { logger: a.logger });
  assert.match(a.lines.join('\n'), /Web Push for browsers/);
  const b = recorder();
  pusherFromEnv({ PUSH: '1', VAPID_PUBLIC_KEY: 'p' }, { logger: b.logger });
  assert.match(b.lines.join('\n'), /all three/);
});

test('the switch can be waived by a caller that has its own', () => {
  const { lines, logger } = recorder();
  pusherFromEnv({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k', VAPID_SUBJECT: 'mailto:x@y' }, { logger, requireSwitch: false });
  assert.doesNotMatch(lines.join('\n'), /disabled/);
});

test('nothing here imports node: or the relay, and no FLEETWRIGHT_ name is hard-coded', () => {
  // The package has to bundle into a Worker, and be Fleetwright-neutral.
  for (const file of readdirSync(new URL('../src/', import.meta.url))) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from ['"]node:/, `${file} imports node:`);
    assert.doesNotMatch(src, /relay\/client|FLEETWRIGHT_/, `${file} is Fleetwright-specific`);
  }
});
