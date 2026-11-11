// Provisioning profiles: bound to every valid distribution certificate, never
// a certificate minted, and a good profile reused rather than churned.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { recreate, ensure, serial } from '../src/profiles.js';
import { ascEnv, fakeFetch } from './fake.js';

const NOW = Date.parse('2026-11-11T00:00:00Z');
const FUTURE = '2027-11-01T00:00:00.000+0000';
const CERTS = [
  { id: 'c1', attributes: { certificateType: 'DISTRIBUTION', serialNumber: '0A1B2C', expirationDate: FUTURE } },
  { id: 'c2', attributes: { certificateType: 'IOS_DISTRIBUTION', serialNumber: '7F', expirationDate: FUTURE } },
  { id: 'c3', attributes: { certificateType: 'DISTRIBUTION', serialNumber: '99', expirationDate: '2020-01-01T00:00:00.000+0000' } },
  { id: 'c4', attributes: { certificateType: 'DEVELOPMENT', serialNumber: '55', expirationDate: FUTURE } },
];

/** @param {{ profiles?: any[], bundles?: any[] }} [o] */
function asc({ profiles = [], bundles = [{ id: 'B1', attributes: { identifier: 'com.example.app.Push' } }] } = {}) {
  return fakeFetch([
    // A search, not an exact match: a longer identifier comes back too.
    ['GET', /^\/v1\/bundleIds\?/, () => ({ data: [{ id: 'B0', attributes: { identifier: 'com.example.app.Push.More' } }, ...bundles] })],
    ['POST', /^\/v1\/bundleIds$/, (_m, body) => ({ data: { id: 'Bnew', attributes: body.data.attributes } })],
    ['GET', /^\/v1\/certificates\?/, () => ({ data: CERTS, links: {} })],
    ['GET', /^\/v1\/profiles\?/, () => ({ data: profiles })],
    ['DELETE', /^\/v1\/profiles\/\w+$/, () => null],
    ['POST', /^\/v1\/profiles$/, () => ({ data: { id: 'Pnew' } })],
    [
      'GET',
      /^\/v1\/profiles\/(\w+)$/,
      (m) => ({ data: { id: m[1], attributes: { name: 'Push Profile', uuid: 'u-1', profileState: 'ACTIVE', expirationDate: FUTURE, profileContent: Buffer.from('profile-bytes').toString('base64') } } }),
    ],
  ]);
}

test('serials compare the way Apple and OpenSSL each print them', () => {
  assert.equal(serial('serial=000A1B2C'), serial('a1b2c'));
});

test('recreate deletes the profile of that name and binds the new one to every valid distribution cert', async () => {
  const { fetchImpl, calls } = asc({
    bundles: [{ id: 'B1', attributes: { identifier: 'com.example.app' } }],
    profiles: [{ id: 'Pold', attributes: { name: 'App Profile', profileState: 'INVALID' } }, { id: 'Pother', attributes: { name: 'Someone else' } }],
  });
  await recreate(await ascEnv({ BUNDLE_ID: 'com.example.app', PROFILE_NAME: 'App Profile' }), { fetchImpl, log() {} });
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.path), ['/v1/profiles/Pold']);
  const created = calls.find((c) => c.method === 'POST' && c.path === '/v1/profiles');
  assert.deepEqual(created?.body.data.relationships.certificates.data.map((/** @type {any} */ c) => c.id), ['c1', 'c2'], 'expired and development certs are not bound');
  assert.equal(calls.some((c) => c.method === 'POST' && /certificates/.test(c.path)), false, 'a certificate was minted');
});

test('recreate refuses a bundle id the team has not registered', async () => {
  const { fetchImpl } = asc({ bundles: [] });
  await assert.rejects(recreate(await ascEnv({ BUNDLE_ID: 'com.example.app', PROFILE_NAME: 'x' }), { fetchImpl, log() {} }), /no registered bundle id/);
});

test('ensure reuses an ACTIVE profile that names the signing cert, and writes it', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'prof-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'push.mobileprovision');
  const good = {
    id: 'Pgood',
    attributes: { name: 'Hand made', profileState: 'ACTIVE', expirationDate: FUTURE },
    relationships: { bundleId: { data: { id: 'B1' } }, certificates: { data: [{ id: 'c1' }] } },
  };
  const { fetchImpl, calls } = asc({ profiles: [good] });
  await ensure(await ascEnv({ BUNDLE_ID: 'com.example.app.Push', PROFILE_NAME: 'Push Profile', OUT: out, CERT_SERIAL: 'serial=0A1B2C' }), { fetchImpl, log() {}, now: NOW });
  assert.equal(calls.some((c) => c.method !== 'GET'), false, 'a good profile was churned');
  assert.equal(readFileSync(out, 'utf8'), 'profile-bytes');
});

test('ensure replaces a profile that does not name the cert CI signs with, and registers a new bundle id', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'prof-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stale = {
    id: 'Pstale',
    attributes: { name: 'Push Profile', profileState: 'ACTIVE', expirationDate: FUTURE },
    relationships: { bundleId: { data: { id: 'Bnew' } }, certificates: { data: [{ id: 'c2' }] } },
  };
  const { fetchImpl, calls } = asc({ profiles: [stale], bundles: [] });
  await ensure(await ascEnv({ BUNDLE_ID: 'com.example.app.Push', PROFILE_NAME: 'Push Profile', OUT: path.join(dir, 'p'), CERT_SERIAL: '0a1b2c' }), { fetchImpl, log() {}, now: NOW });
  const registered = calls.find((c) => c.method === 'POST' && c.path === '/v1/bundleIds');
  assert.equal(registered?.body.data.attributes.name, 'com example app Push', 'Apple refuses dots in the display name');
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.path), ['/v1/profiles/Pstale']);
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/v1/profiles'));
});

test('ensure refuses when the imported cert is no longer on the team', async () => {
  const { fetchImpl } = asc();
  await assert.rejects(
    ensure(await ascEnv({ BUNDLE_ID: 'com.example.app.Push', PROFILE_NAME: 'P', OUT: '/dev/null', CERT_SERIAL: 'DEAD' }), { fetchImpl, log() {}, now: NOW }),
    /serial DEAD\) is not a valid distribution certificate/,
  );
});
