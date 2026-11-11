// TestFlight: internal groups get every build and must never be assigned one;
// external groups must be assigned AND submitted for beta review.

import test from 'node:test';
import assert from 'node:assert/strict';

import { run, whatsNew } from '../src/testflight-distribute.js';
import { ascEnv, fakeFetch, lines } from './fake.js';

/** @param {{ state?: string }} [o] */
function asc({ state = 'VALID' } = {}) {
  return fakeFetch([
    ['GET', /^\/v1\/apps\?filter\[bundleId\]=com\.example\.app/, () => ({ data: [{ id: 'app1', attributes: { name: 'Example' } }] })],
    ['GET', /^\/v1\/builds\?filter\[app\]=app1&filter\[version\]=42/, () => ({ data: [{ id: 'b42', attributes: { processingState: state } }] })],
    [
      'GET',
      /^\/v1\/apps\/app1\/betaGroups/,
      () => ({ data: [{ id: 'gi', attributes: { name: 'Team', isInternalGroup: true } }, { id: 'ge', attributes: { name: 'Public', isInternalGroup: false } }] }),
    ],
    ['GET', /^\/v1\/builds\/b42\/betaBuildLocalizations/, () => ({ data: [] })],
    ['POST', /^\/v1\/betaBuildLocalizations$/, () => ({ data: { id: 'l1' } })],
    ['POST', /^\/v1\/betaGroups\/ge\/relationships\/builds$/, () => null],
    ['POST', /^\/v1\/betaAppReviewSubmissions$/, () => ({ data: { id: 's1' } })],
  ]);
}

test('what testers read loses emoji, and an internal build keeps only the subject line', () => {
  assert.equal(whatsNew('Fix sign-in 🤖\n\nlong PR body', 'internal'), 'Fix sign-in');
  assert.equal(whatsNew('Fix sign-in\nsecond line', 'external'), 'Fix sign-in\nsecond line');
  assert.equal(whatsNew('👍🏽 ok', 'internal'), 'ok');
});

test('an internal audience is never assigned the build', async () => {
  const { fetchImpl, calls } = asc();
  const r = await run(await ascEnv({ BUNDLE_ID: 'com.example.app', BUILD_NUMBER: '42', WHATS_NEW: 'Subject\nbody' }), { fetchImpl, log() {} });
  assert.deepEqual(r, { distributed: true, group: 'Team' });
  assert.equal(calls.some((c) => /relationships\/builds/.test(c.path)), false, 'the 422 "Cannot add internal group to a build" call was made');
  const loc = calls.find((c) => c.path === '/v1/betaBuildLocalizations');
  assert.equal(loc?.body.data.attributes.whatsNew, 'Subject');
});

test('an external audience is assigned and submitted for beta review', async () => {
  const { fetchImpl, calls } = asc();
  await run(await ascEnv({ BUNDLE_ID: 'com.example.app', BUILD_NUMBER: '42', AUDIENCE: 'external' }), { fetchImpl, log() {} });
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/v1/betaGroups/ge/relationships/builds'));
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/v1/betaAppReviewSubmissions'));
});

test('a group named but missing is a loud error that lists what exists', async () => {
  const { fetchImpl } = asc();
  await assert.rejects(
    run(await ascEnv({ BUNDLE_ID: 'com.example.app', BUILD_NUMBER: '42', INTERNAL_BETA_GROUP_NAME: 'Nope' }), { fetchImpl, log() {} }),
    /no internal group named "Nope" — have: Team/,
  );
});

test('a build still processing at the deadline is a warning, not a failure', async () => {
  const { fetchImpl } = asc({ state: 'PROCESSING' });
  const { out, log } = lines();
  const r = await run(await ascEnv({ BUNDLE_ID: 'com.example.app', BUILD_NUMBER: '42', POLL_TIMEOUT_MS: '0' }), { fetchImpl, log, sleep: async () => {} });
  assert.deepEqual(r, { distributed: false });
  assert.match(out.join('\n'), /::warning::Build 42 uploaded but was still PROCESSING/);
});

test('a build Apple marked INVALID fails the job', async () => {
  const { fetchImpl } = asc({ state: 'INVALID' });
  await assert.rejects(run(await ascEnv({ BUNDLE_ID: 'com.example.app', BUILD_NUMBER: '42' }), { fetchImpl, log() {} }), /build 42 is INVALID/);
});
