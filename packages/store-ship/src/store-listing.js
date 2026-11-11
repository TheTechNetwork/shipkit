// The store listing, read from the Markdown document somebody actually wrote.
//
// Each field is the FIRST fenced block under its `## ` heading (later blocks are
// alternates). A missing heading or empty block is an error naming it: a lenient
// parser here publishes an empty description. Format: see README, "Store listing".

import { readFileSync } from 'node:fs';

/** @param {string} md @param {RegExp} heading @returns {string|null} */
function blockUnder(md, heading) {
  const lines = md.split('\n');
  const at = lines.findIndex((l) => l.startsWith('## ') && heading.test(l));
  if (at < 0) return null;
  for (let i = at + 1; i < lines.length; i++) {
    // The next heading ends the section: never fill a field from the one below.
    if (lines[i].startsWith('## ')) return null;
    if (lines[i].trimEnd() === '```') {
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trimEnd() === '```') return body.join('\n').trim() || null;
        body.push(lines[j]);
      }
      return null;
    }
  }
  return null;
}

/** @param {string} md @param {RegExp} heading @param {string} what @param {string} file */
function required(md, heading, what, file) {
  const got = blockUnder(md, heading);
  if (!got) throw new Error(`${file} has no usable "${what}" — expected a fenced block under a "## ${what}" heading.`);
  return got;
}

/**
 * What both stores need, read once and checked against their limits.
 *
 * @param {string|URL} path
 */
export function storeListing(path) {
  if (!path) throw new Error('no store listing document given (STORE_LISTING)');
  const file = String(path);
  const md = readFileSync(path, 'utf8');
  const name = required(md, /App name/i, 'App name', file);
  const short = required(md, /Short description/i, 'Short description', file);
  const full = required(md, /Full description/i, 'Full description', file);
  const appStore = required(md, /^## App Store description/i, 'App Store description', file);
  // App Review rejects another platform's words under guideline 2.3.10.
  const elsewhere = /\b(android|google play|play store|apk)\b|sign in with google/i.exec(appStore);
  if (elsewhere) throw new Error(`the App Store description mentions "${elsewhere[0]}" — App Review rejects that under guideline 2.3.10.`);
  const keywords = required(md, /^## Keywords/i, 'Keywords', file);
  const supportUrl = required(md, /^## Support URL/i, 'Support URL', file);
  const privacyPolicyUrl = required(md, /^## Privacy policy URL/i, 'Privacy policy URL', file);
  const copyright = required(md, /^## Copyright/i, 'Copyright', file);

  // Apple's and Google's limits, checked here rather than refused minutes into a release.
  const tooLong = /** @type {Array<[string, string, number]>} */ ([
    ['App name', name, 30],
    ['Short description', short, 80],
    ['Full description', full, 4000],
    ['App Store description', appStore, 4000],
    ['Keywords', keywords, 100],
  ]).filter(([, v, max]) => v.length > max);
  if (tooLong.length) throw new Error(tooLong.map(([k, v, max]) => `${k} is ${v.length} characters; the limit is ${max}`).join('\n'));
  for (const [k, v] of [['Support URL', supportUrl], ['Privacy policy URL', privacyPolicyUrl]]) {
    if (!/^https:\/\/\S+$/.test(v)) throw new Error(`${k} is not one https URL: ${JSON.stringify(v)}`);
  }
  return { name, short, full, appStore, keywords, supportUrl, privacyPolicyUrl, copyright };
}

export const HELP = `store-listing: parse and check a store listing document, and print it as JSON.

  STORE_LISTING              path to the Markdown document              required`;

/** @param {Record<string, string|undefined>} env @param {{ log?: (l: string) => void }} [deps] */
export async function run(env, { log = console.log } = {}) {
  const listing = storeListing(String(env.STORE_LISTING || ''));
  log(JSON.stringify(listing, null, 2));
  return listing;
}
