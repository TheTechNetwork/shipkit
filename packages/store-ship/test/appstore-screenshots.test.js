// Screenshots: left alone if present and acceptable, replaced whole if Apple
// would refuse them, and uploaded as reserve → ranges → checksum. Ported from Fleetwright.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { uploadScreenshots, unacceptable } from '../src/appstore-screenshots.js';

/** @param {Record<string, Record<string, string>>} types */
function shots(types) {
  const dir = mkdtempSync(path.join(tmpdir(), 'shots-'));
  for (const [type, files] of Object.entries(types)) {
    mkdirSync(path.join(dir, type), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, type, name), body);
  }
  return dir;
}

/** @param {{ existing?: Record<string, any> }} [o] */
function fakeApi({ existing = {} } = {}) {
  /** @type {any[]} */
  const calls = [];
  /** @type {any[]} */
  const puts = [];
  const fetchImpl = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    puts.push({ url, method: init?.method, body: init?.body });
    return new Response('', { status: 200 });
  });
  /** @type {import('../src/asc.js').Api} */
  const api = async (p, init = {}) => {
    calls.push({ p, method: init.method || 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
    if (p.includes('/appScreenshotSets?')) return { data: Object.keys(existing).map((t, i) => ({ id: `set-${i}`, attributes: { screenshotDisplayType: t } })) };
    const m = /\/appScreenshotSets\/set-(\d+)\/appScreenshots\?/.exec(p);
    if (m) {
      const have = existing[Object.keys(existing)[Number(m[1])]];
      return { data: Array.isArray(have) ? have : have ? [{ id: 'already' }] : [] };
    }
    if (p === '/v1/appScreenshotSets') return { data: { id: 'set-new' } };
    if (p === '/v1/appScreenshots') {
      return {
        data: {
          id: 'shot-1',
          attributes: {
            uploadOperations: [
              { url: 'https://upload.example/part1', method: 'PUT', offset: 0, length: 3, requestHeaders: [{ name: 'x', value: 'y' }] },
              { url: 'https://upload.example/part2', method: 'PUT', offset: 3, length: 2, requestHeaders: [] },
            ],
          },
        },
      };
    }
    return { data: null };
  };
  return { api, calls, puts, fetchImpl };
}

const quiet = () => {};

test('a display type that already has screenshots is left alone, unless forced', async (t) => {
  const dir = shots({ APP_IPHONE_67: { 'phone-01.png': 'abcde' } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = fakeApi({ existing: { APP_IPHONE_67: true } });
  assert.equal(await uploadScreenshots({ api: a.api, fetchImpl: a.fetchImpl, localizationId: 'loc', dir, log: quiet }), 0);
  const b = fakeApi({ existing: { APP_IPHONE_67: true } });
  assert.equal(await uploadScreenshots({ api: b.api, fetchImpl: b.fetchImpl, localizationId: 'loc', dir, force: true, log: quiet }), 1);
});

test('a set Apple would refuse is deleted whole, before the new ones arrive', async (t) => {
  const dir = shots({ APP_IPHONE_67: { 'phone-01.png': 'abcde' } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { api, calls, fetchImpl } = fakeApi({
    existing: {
      APP_IPHONE_67: [
        { id: 'old-1', attributes: { imageAsset: { width: 1242, height: 2688 }, assetDeliveryState: { state: 'COMPLETE' } } },
        { id: 'old-2', attributes: { imageAsset: { width: 1290, height: 2796 }, assetDeliveryState: { state: 'COMPLETE' } } },
      ],
    },
  });
  assert.equal(await uploadScreenshots({ api, fetchImpl, localizationId: 'loc', dir, log: quiet }), 1);
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.p), ['/v1/appScreenshots/old-1', '/v1/appScreenshots/old-2']);
  assert.ok(calls.findIndex((c) => c.method === 'DELETE') < calls.findIndex((c) => c.p === '/v1/appScreenshots' && c.method === 'POST'));
});

test('a size Apple has not reported yet is cannot-tell, not wrong', () => {
  assert.equal(unacceptable('APP_IPHONE_61', { attributes: { imageAsset: null } }), null);
  assert.match(String(unacceptable('APP_IPHONE_61', { attributes: { assetDeliveryState: { state: 'FAILED' } } })), /delivery failed/);
});

test('the upload is reserve, send Apple’s ranges, then commit with an MD5', async (t) => {
  const dir = shots({ APP_IPHONE_67: { 'phone-01.png': 'abcde' } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { api, calls, puts, fetchImpl } = fakeApi();
  assert.equal(await uploadScreenshots({ api, fetchImpl, localizationId: 'loc', dir, log: quiet }), 1);
  const reserve = calls.find((c) => c.p === '/v1/appScreenshots' && c.method === 'POST');
  assert.equal(reserve.body.data.attributes.fileSize, 5);
  assert.deepEqual(puts.map((p) => Buffer.from(p.body).toString()), ['abc', 'de']);
  const commit = calls.find((c) => c.p === '/v1/appScreenshots/shot-1' && c.method === 'PATCH');
  assert.equal(commit.body.data.attributes.sourceFileChecksum, createHash('md5').update('abcde').digest('hex'));
});

test('files go up in name order, images only, and no directory is not a failure', async (t) => {
  const dir = shots({ APP_IPHONE_67: { 'phone-03.png': 'c', 'phone-01.png': 'a', 'phone-02.png': 'b', 'README.md': 'why' } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { api, calls, fetchImpl } = fakeApi();
  await uploadScreenshots({ api, fetchImpl, localizationId: 'loc', dir, log: quiet });
  const names = calls.filter((c) => c.p === '/v1/appScreenshots' && c.method === 'POST').map((c) => c.body.data.attributes.fileName);
  assert.deepEqual(names, ['phone-01.png', 'phone-02.png', 'phone-03.png']);
  const none = fakeApi();
  assert.equal(await uploadScreenshots({ api: none.api, localizationId: 'loc', dir: '/nope/not/here', log: quiet }), 0);
  assert.equal(none.calls.length, 0);
});
