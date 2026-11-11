// The listing, read from the document somebody wrote. Ported from Fleetwright.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { storeListing } from '../src/store-listing.js';

const FIXTURE = new URL('./fixtures/store-listing.md', import.meta.url);

const TAIL = [
  '## App Store description (4000 char max)', '', '```', 'the iOS copy', '```', '',
  '## Keywords (100 char max)', '', '```', 'a,b', '```', '',
  '## Support URL', '', '```', 'https://example.test/support', '```', '',
  '## Privacy policy URL', '', '```', 'https://example.test/privacy', '```', '',
  '## Copyright', '', '```', '© 2026 Example', '```', '',
].join('\n');

/** @param {string} md */
function parse(md) {
  const dir = mkdtempSync(path.join(tmpdir(), 'listing-'));
  const p = path.join(dir, 'store-listing.md');
  writeFileSync(p, md);
  try {
    return storeListing(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {Record<string, string>} o */
const head = ({ name = 'Example', short = 'short', full = 'body' } = {}) =>
  ['## App name (30 char max)', '', '```', name, '```', '', '## Short description (80 char max)', '', '```', short, '```', '', '## Full description (4000 char max)', '', '```', full, '```', ''].join('\n');

test('the example document parses', () => {
  const l = storeListing(FIXTURE);
  assert.equal(l.name, 'Example');
  assert.equal(l.short, 'Ship the thing, then tell everyone.', 'the FIRST block wins; the rest are alternates');
  assert.equal(l.keywords, 'example,demo');
});

test('a missing block is refused, not filled from the section below', () => {
  const md = ['## App name (30 char max)', '', '```', 'Example', '```', '', '## Short description (80 char max)', '', 'somebody deleted the block', '', '## Full description (4000 char max)', '', '```', 'body', '```', ''].join('\n');
  assert.throws(() => parse(md + TAIL), /Short description/);
});

test('a heading that is not there names itself', () => {
  assert.throws(() => parse('## App name (30 char max)\n\n```\nExample\n```\n'), /Short description/);
});

test('the store limits are checked here, not discovered on upload', () => {
  assert.throws(() => parse(head({ name: 'x'.repeat(31) }) + TAIL), /App name is 31 characters; the limit is 30/);
});

test('the App Store description may not name another platform (guideline 2.3.10)', () => {
  assert.throws(() => parse(head() + TAIL.replace('the iOS copy', 'Get the APK from our site')), /2\.3\.10/);
});

test('the URLs must each be one https URL', () => {
  assert.throws(() => parse(head() + TAIL.replace('https://example.test/support', 'http://example.test/support')), /Support URL is not one https URL/);
});

test('no path is an error, not a default file somewhere', () => {
  assert.throws(() => storeListing(''), /STORE_LISTING/);
});
