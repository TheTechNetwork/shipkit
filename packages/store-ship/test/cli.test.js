import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

import { parseFlags, COMMANDS } from '../src/cli.js';

const BIN = new URL('../bin/store-ship.mjs', import.meta.url).pathname;

test('flags are settings: --bundle-id x is BUNDLE_ID=x', () => {
  assert.deepEqual(parseFlags(['--bundle-id', 'com.x', '--audience=external', '--screenshots-force']), {
    BUNDLE_ID: 'com.x',
    AUDIENCE: 'external',
    SCREENSHOTS_FORCE: 'true',
  });
  assert.throws(() => parseFlags(['stray']), /settings are --name value/);
});

test('every command documents itself, and a missing setting is exit 1 naming it', () => {
  for (const name of Object.keys(COMMANDS)) {
    assert.match(execFileSync('node', [BIN, name, '--help'], { encoding: 'utf8' }), new RegExp(name));
  }
  const r = spawnSync('node', [BIN, 'play-release'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PLAY_PACKAGE_NAME/);
  assert.equal(spawnSync('node', [BIN, 'nope'], { encoding: 'utf8' }).status, 2);
});

test('store-listing prints the parsed document', () => {
  const out = execFileSync('node', [BIN, 'store-listing', '--store-listing', new URL('./fixtures/store-listing.md', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).name, 'Example');
});

test('the only dependency is worker-push, whose JWT signer it uses', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies), ['@thetechnetwork/worker-push']);
  assert.equal(pkg.dependencies['@thetechnetwork/worker-push'], `^${pkg.version}`);
});
