// Repository invariants: versions, pins, and the paths the workflows reach for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const version = JSON.parse(read('package.json')).version;
const PACKAGES = ['worker-push', 'store-ship', 'expo-shipkit-plugin'];
const WORKFLOWS = readdirSync(new URL('../.github/workflows/', import.meta.url)).map((f) => `.github/workflows/${f}`);
const ACTIONS = readdirSync(new URL('../actions/', import.meta.url)).map((d) => `actions/${d}/action.yml`);

test('every package carries the repository version', () => {
  for (const p of PACKAGES) assert.equal(JSON.parse(read(`packages/${p}/package.json`)).version, version, p);
});

test("the reusable workflows default shipkit-ref to this release's tag", () => {
  // The tools and actions they check out must be the ones released beside them.
  for (const f of ['.github/workflows/ios-release.yml', '.github/workflows/android-release.yml']) {
    assert.match(read(f), new RegExp(`shipkit-ref:[\\s\\S]*?default: v${version.replace(/\./g, '\\.')}\\n`), f);
  }
});

test('the README install URLs name this release', () => {
  const readme = read('README.md');
  const urls = readme.match(/releases\/download\/v[\d.]+\/[\w.-]+\.tgz/g) ?? [];
  assert.ok(urls.length >= 3, 'the README lost its install URLs');
  for (const u of urls) assert.ok(u.includes(`/v${version}/`) && u.endsWith(`-${version}.tgz`), u);
  for (const p of PACKAGES) assert.ok(readme.includes(`thetechnetwork-${p}-${version}.tgz`), p);
});

test('every third-party action is pinned to a version', () => {
  for (const f of [...WORKFLOWS, ...ACTIONS]) {
    for (const [, ref] of read(f).matchAll(/^\s*(?:- )?uses:\s*([^\s#]+)/gm)) {
      if (ref.startsWith('./')) continue;
      assert.match(ref, /@v\d+\.\d+\.\d+$/, `${f}: ${ref}`);
    }
  }
});

test('every shipkit action and tool a workflow reaches for exists', () => {
  for (const f of WORKFLOWS) {
    const src = read(f);
    for (const [, dir] of src.matchAll(/uses: \.\/\.shipkit\/(actions\/[\w-]+)/g)) assert.ok(existsSync(new URL(`../${dir}/action.yml`, import.meta.url)), `${f}: ${dir}`);
    for (const [, cmd] of src.matchAll(/store-ship\.mjs ([\w-]+)/g)) assert.match(read('packages/store-ship/src/cli.js'), new RegExp(`'${cmd}':`), `${f}: ${cmd}`);
  }
});

test('no global PROVISIONING_PROFILE_SPECIFIER and no -allowProvisioningUpdates on the command line', () => {
  const ios = read('.github/workflows/ios-release.yml').replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(ios, /PROVISIONING_PROFILE_SPECIFIER=/);
  assert.doesNotMatch(ios, /-allowProvisioningUpdates/);
  assert.match(ios, /CODE_SIGN_STYLE=Manual/);
});
