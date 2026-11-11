// App Store release: the decisions that were argued for once, as behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { run } from '../src/appstore-release.js';
import { ascEnv, fakeFetch, lines } from './fake.js';

const LISTING = new URL('./fixtures/store-listing.md', import.meta.url).pathname;

/**
 * An app whose build 42 is VALID on version train 1.2.0.
 * @param {{ versions?: any[], itemError?: any, locPatch?: (body: any) => any }} [o]
 */
function asc({ versions = [], itemError, locPatch } = {}) {
  return fakeFetch([
    ['GET', /^\/v1\/apps\?filter\[bundleId\]/, () => ({ data: [{ id: 'app1', attributes: { name: 'Example' } }] })],
    [
      'GET',
      /^\/v1\/builds\?filter\[app\]=app1&filter\[version\]=42&include=preReleaseVersion/,
      () => ({ data: [{ id: 'b42', attributes: { processingState: 'VALID' } }], included: [{ type: 'preReleaseVersions', attributes: { version: '1.2.0' } }] }),
    ],
    ['GET', /^\/v1\/apps\/app1\/appInfos\?include=/, () => ({ data: [{ id: 'i1', relationships: { primaryCategory: { data: { id: 'c' } } } }], included: [{ type: 'ageRatingDeclarations', attributes: { violence: 'NONE' } }] })],
    ['GET', /^\/v1\/apps\/app1\/appStoreVersions\?filter\[versionString\]=1\.2\.0/, () => ({ data: versions.filter((v) => v.attributes.versionString === '1.2.0') })],
    ['GET', /^\/v1\/apps\/app1\/appStoreVersions\?filter\[platform\]=IOS&limit=20/, () => ({ data: versions })],
    ['PATCH', /^\/v1\/appStoreVersions\/(\w+)$/, (m, body) => ({ data: { id: m[1], attributes: body.data.attributes } })],
    ['POST', /^\/v1\/appStoreVersions$/, () => ({ data: { id: 'vNew', attributes: { versionString: '1.2.0' } } })],
    ['PATCH', /^\/v1\/appStoreVersions\/\w+\/relationships\/build$/, () => null],
    ['GET', /^\/v1\/appStoreVersions\/\w+\/appStoreVersionLocalizations/, () => ({ data: [{ id: 'loc1', attributes: { locale: 'en-US', description: 'd', keywords: 'k', supportUrl: 'https://x' } }] })],
    ['GET', /^\/v1\/appStoreVersionLocalizations\/loc1\/appScreenshotSets/, () => ({ data: [{ id: 's' }] })],
    ['PATCH', /^\/v1\/appStoreVersionLocalizations\/loc1$/, (_m, body) => (locPatch ? locPatch(body) : { data: {} })],
    ['GET', /^\/v1\/apps\/app1\/appInfos\?limit=2/, () => ({ data: [] })],
    ['GET', /^\/v1\/reviewSubmissions\?/, () => ({ data: [] })],
    ['POST', /^\/v1\/reviewSubmissions$/, () => ({ data: { id: 'rs1', attributes: { state: 'READY_FOR_REVIEW' } } })],
    ['POST', /^\/v1\/reviewSubmissionItems$/, () => itemError ?? { data: { id: 'it1' } }],
    ['PATCH', /^\/v1\/reviewSubmissions\/rs1$/, () => ({ data: {} })],
  ]);
}

const env = async (extra = {}) => ascEnv({ BUNDLE_ID: 'com.example.app', BUILD_NUMBER: '42', ...extra });

test('a first release creates the version AFTER_APPROVAL, attaches the build and submits it', async () => {
  const { fetchImpl, calls } = asc();
  const r = await run(await env({ STORE_LISTING: LISTING }), { fetchImpl, log() {}, error() {} });
  assert.deepEqual(r, { submitted: true, versionString: '1.2.0' });
  const created = calls.find((c) => c.method === 'POST' && c.path === '/v1/appStoreVersions');
  assert.equal(created?.body.data.attributes.releaseType, 'AFTER_APPROVAL');
  assert.ok(calls.some((c) => c.path === '/v1/appStoreVersions/vNew/relationships/build'));
  const listing = calls.find((c) => c.method === 'PATCH' && c.path === '/v1/appStoreVersionLocalizations/loc1');
  assert.equal(listing?.body.data.attributes.keywords, 'example,demo');
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.path === '/v1/reviewSubmissions/rs1' && c.body.data.attributes.submitted === true));
});

test('an editable version under another name is renamed, never duplicated', async () => {
  // Apple allows one version in preparation per platform and makes a "1.0" with the app record.
  const { fetchImpl, calls } = asc({ versions: [{ id: 'v10', attributes: { versionString: '1.0', appVersionState: 'PREPARE_FOR_SUBMISSION' } }] });
  await run(await env(), { fetchImpl, log() {}, error() {} });
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.path === '/v1/appStoreVersions/v10' && c.body.data.attributes.versionString === '1.2.0'));
  assert.equal(calls.some((c) => c.method === 'POST' && c.path === '/v1/appStoreVersions'), false);
});

test('a version already on the store refuses by naming the fix', async () => {
  const { fetchImpl } = asc({ versions: [{ id: 'v12', attributes: { versionString: '1.2.0', appVersionState: 'READY_FOR_SALE' } }] });
  await assert.rejects(run(await env(), { fetchImpl, log() {}, error() {} }), /already on the App Store .* bump the app's marketing version/);
});

test('a version already in review is done, green, without writing anything', async () => {
  const { fetchImpl, calls } = asc({ versions: [{ id: 'v12', attributes: { versionString: '1.2.0', appVersionState: 'WAITING_FOR_REVIEW' } }] });
  const { out, log } = lines();
  await run(await env(), { fetchImpl, log, error() {} });
  assert.match(out.join('\n'), /already submitted, nothing to do/);
  assert.equal(calls.some((c) => c.method !== 'GET'), false);
});

test('refused release notes do not take the description with them', async () => {
  const { fetchImpl, calls } = asc({
    locPatch: (body) => ('whatsNew' in body.data.attributes ? { status: 409, json: { errors: [{ title: 'whatsNew', detail: 'cannot be edited' }] } } : { data: {} }),
  });
  const { out, log } = lines();
  await run(await env({ STORE_LISTING: LISTING, WHATS_NEW: 'New things' }), { fetchImpl, log, error() {} });
  const patches = calls.filter((c) => c.method === 'PATCH' && c.path === '/v1/appStoreVersionLocalizations/loc1');
  assert.equal(patches.length, 2);
  assert.equal('whatsNew' in patches[1].body.data.attributes, false);
  assert.ok(patches[1].body.data.attributes.description);
  assert.match(out.join('\n'), /release notes refused \(whatsNew: cannot be edited\)/);
});

test('an incomplete version is a red job with Apple’s associated errors, not "already in"', async () => {
  const itemError = {
    status: 409,
    json: { errors: [{ title: 'is not in valid state', detail: 'This resource cannot be reviewed', meta: { associatedErrors: { '/v1/x': [{ title: 'screenshots', detail: 'missing 6.7"' }] } } }] },
  };
  const { fetchImpl, calls } = asc({ itemError });
  /** @type {string[]} */
  const errors = [];
  await assert.rejects(run(await env(), { fetchImpl, log() {}, error: (l) => void errors.push(l) }), /- screenshots: missing 6\.7"/);
  assert.equal(calls.some((c) => c.path === '/v1/reviewSubmissions/rs1'), false, 'it submitted anyway');
  assert.match(errors.join('\n'), /finish the listing in App Store Connect/);
});

test('the listing pre-check runs before the first write, and only warns', async () => {
  const { fetchImpl, calls } = asc();
  await run(await env(), { fetchImpl, log() {}, error() {} });
  const check = calls.findIndex((c) => c.path.startsWith('/v1/apps/app1/appInfos?include=primaryCategory,ageRatingDeclaration'));
  const firstWrite = calls.findIndex((c) => c.method !== 'GET');
  assert.ok(check >= 0 && check < firstWrite);
});

test('the review contact is all four or none, and never invented', async () => {
  const { fetchImpl, calls } = asc();
  const { out, log } = lines();
  await run(await env({ ASC_REVIEW_FIRST_NAME: 'Ada' }), { fetchImpl, log, error() {} });
  assert.match(out.join('\n'), /::warning::no App Review contact/);
  assert.equal(calls.some((c) => /appStoreReviewDetails/.test(c.path) && c.method !== 'GET'), false);
});

test('submission uses reviewSubmissions; the deprecated endpoint and MANUAL release never appear', () => {
  const src = readFileSync(new URL('../src/appstore-release.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\/v1\/appStoreVersionSubmissions/);
  assert.doesNotMatch(src, /'MANUAL'/);
});
