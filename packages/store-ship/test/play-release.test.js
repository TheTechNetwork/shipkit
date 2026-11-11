// Play: status and userFraction are one decision, and the edit is a transaction.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run, rollout, trackRelease } from '../src/play-release.js';
import { fakeFetch, lines } from './fake.js';

async function account() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return JSON.stringify({ client_email: 'play@x.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64')}\n-----END PRIVATE KEY-----\n` });
}

test('an unset rollout ships the whole track, and nonsense is refused', () => {
  assert.equal(rollout(''), null);
  assert.equal(rollout(undefined), null);
  assert.equal(rollout('1'), null);
  assert.equal(rollout('0.1'), 0.1);
  // "10" meaning ten percent would otherwise be sent as 1000%.
  for (const bad of ['10', '0', '-0.5', 'half']) assert.throws(() => rollout(bad), /PLAY_ROLLOUT must be a fraction/);
});

test('status and userFraction move together, never userFraction on a completed release', () => {
  assert.deepEqual(trackRelease(42, 0.2, ''), { versionCodes: ['42'], status: 'inProgress', userFraction: 0.2 });
  const whole = trackRelease(42, null, 'notes', 'en-GB');
  assert.equal(whole.status, 'completed');
  assert.equal('userFraction' in whole, false);
  assert.deepEqual(whole.releaseNotes, [{ language: 'en-GB', text: 'notes' }]);
});

test('a release is create-edit, upload, assign, commit, in that order', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aab-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const aab = path.join(dir, 'app-release.aab');
  writeFileSync(aab, 'PK fake bundle');
  const { fetchImpl, calls } = fakeFetch([
    ['POST', /oauth2\.googleapis\.com|^\/token$/, () => ({ access_token: 'g', expires_in: 3600 })],
    ['POST', /\/edits$/, () => ({ id: 'e1' })],
    ['POST', /\/upload\/.*\/edits\/e1\/bundles/, () => ({ versionCode: 77 })],
    ['PUT', /\/edits\/e1\/tracks\/beta$/, (_m, body) => body],
    ['POST', /\/edits\/e1:commit$/, () => ({})],
  ]);
  const { out, log } = lines();
  const r = await run(
    { PLAY_SERVICE_ACCOUNT_JSON: await account(), PLAY_PACKAGE_NAME: 'com.example.app', AAB_PATH: aab, PLAY_TRACK: 'beta', PLAY_ROLLOUT: '0.25', RELEASE_NOTES: 'x'.repeat(600) },
    { fetchImpl, log },
  );
  assert.deepEqual(r, { versionCode: 77, track: 'beta' });
  const order = calls.map((c) => `${c.method} ${c.path.replace(/\?.*/, '')}`);
  assert.deepEqual(order, [
    'POST /token',
    'POST /androidpublisher/v3/applications/com.example.app/edits',
    'POST /upload/androidpublisher/v3/applications/com.example.app/edits/e1/bundles',
    'PUT /androidpublisher/v3/applications/com.example.app/edits/e1/tracks/beta',
    'POST /androidpublisher/v3/applications/com.example.app/edits/e1:commit',
  ]);
  const release = calls[3].body.releases[0];
  assert.equal(release.status, 'inProgress');
  assert.equal(release.userFraction, 0.25);
  assert.equal(release.releaseNotes[0].text.length, 500, 'notes are cut to Play’s 500');
  assert.match(out.join('\n'), /as play@x\.iam\.gserviceaccount\.com/);
});

test('a 403 says which account, and the three things to check', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aab-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const aab = path.join(dir, 'a.aab');
  writeFileSync(aab, 'x');
  const { fetchImpl } = fakeFetch([
    ['POST', /^\/token$/, () => ({ access_token: 'g' })],
    ['POST', /\/edits$/, () => ({ status: 403, json: { error: { message: 'The caller does not have permission' } } })],
  ]);
  await assert.rejects(
    run({ PLAY_SERVICE_ACCOUNT_JSON: await account(), PLAY_PACKAGE_NAME: 'com.example.app', AAB_PATH: aab }, { fetchImpl, log() {} }),
    /Play refused play@x\.iam\.gserviceaccount\.com on com\.example\.app[\s\S]*Release to testing tracks/,
  );
});
