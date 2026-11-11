// `store-ship <command> [--setting value ...]`. Every setting is an environment
// variable; `--bundle-id x` is BUNDLE_ID=x, and flags win over the environment.

import * as playRelease from './play-release.js';
import * as testflight from './testflight-distribute.js';
import * as appstore from './appstore-release.js';
import * as listing from './store-listing.js';
import * as profiles from './profiles.js';
import { ascFromEnv, requireEnv } from './asc.js';
import { uploadScreenshots } from './appstore-screenshots.js';

const SCREENSHOTS_HELP = `appstore-screenshots: upload screenshots to an existing App Store version.

  ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8, BUNDLE_ID, VERSION_STRING, SCREENSHOTS_DIR   required
  SCREENSHOTS_FORCE          true to replace screenshots already there
  LOCALE                     default en-US`;

/** @type {Record<string, { help: string, run: (env: Record<string, string|undefined>) => Promise<unknown> }>} */
export const COMMANDS = {
  'testflight-distribute': { help: testflight.HELP, run: (env) => testflight.run(env) },
  'appstore-release': { help: appstore.HELP, run: (env) => appstore.run(env) },
  'appstore-screenshots': { help: SCREENSHOTS_HELP, run: screenshots },
  'play-release': { help: playRelease.HELP, run: (env) => playRelease.run(env) },
  'recreate-ios-profile': { help: profiles.RECREATE_HELP, run: (env) => profiles.recreate(env) },
  'ensure-ios-extension-profile': { help: profiles.ENSURE_HELP, run: (env) => profiles.ensure(env) },
  'store-listing': { help: listing.HELP, run: (env) => listing.run(env) },
};

/** @param {Record<string, string|undefined>} env */
async function screenshots(env) {
  const { BUNDLE_ID, VERSION_STRING, SCREENSHOTS_DIR } = requireEnv(env, ['BUNDLE_ID', 'VERSION_STRING', 'SCREENSHOTS_DIR']);
  const { api } = ascFromEnv(env);
  const app = (await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=1`)).data[0];
  if (!app) throw new Error(`no app record for ${BUNDLE_ID}`);
  const version = (await api(`/v1/apps/${app.id}/appStoreVersions?filter[versionString]=${encodeURIComponent(VERSION_STRING)}&filter[platform]=IOS&limit=1`)).data[0];
  if (!version) throw new Error(`no App Store version ${VERSION_STRING} — appstore-release creates it`);
  const loc = ((await api(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`)).data || []).find(
    (/** @type {any} */ l) => l.attributes.locale === (env.LOCALE || 'en-US'),
  );
  if (!loc) throw new Error(`no ${env.LOCALE || 'en-US'} localization on version ${VERSION_STRING}`);
  return uploadScreenshots({ api, localizationId: loc.id, dir: SCREENSHOTS_DIR, force: env.SCREENSHOTS_FORCE === 'true' });
}

/**
 * `--store-listing apps/store-listing.md` → { STORE_LISTING: 'apps/store-listing.md' }.
 *
 * @param {string[]} args
 */
export function parseFlags(args) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/i.exec(args[i]);
    if (!m) throw new Error(`unexpected argument ${JSON.stringify(args[i])}; settings are --name value`);
    const key = m[1].toUpperCase().replace(/-/g, '_');
    if (m[2] !== undefined) out[key] = m[2];
    else if (i + 1 < args.length && !args[i + 1].startsWith('--')) out[key] = args[++i];
    else out[key] = 'true';
  }
  return out;
}

export function usage() {
  return `store-ship <command> [--setting value ...]\n\nCommands:\n${Object.keys(COMMANDS).map((c) => `  ${c}`).join('\n')}\n\nstore-ship <command> --help lists a command's settings. Every setting may instead be an environment variable.`;
}

/** @param {string[]} argv */
export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return 0;
  }
  const cmd = COMMANDS[command];
  if (!cmd) {
    console.error(`unknown command ${JSON.stringify(command)}\n\n${usage()}`);
    return 2;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(cmd.help);
    return 0;
  }
  try {
    await cmd.run({ ...process.env, ...parseFlags(rest) });
    return 0;
  } catch (e) {
    console.error(`${command}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
