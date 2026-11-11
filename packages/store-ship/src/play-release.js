// Push a built .aab to a Play track, inside one edit.
//
// Nothing in an edit takes effect until the commit, so a run that dies halfway
// leaves the track exactly as it was: create edit, upload, assign, commit.

import { readFile, stat } from 'node:fs/promises';
import { requireEnv } from './asc.js';
import { googleAccessToken, serviceAccount } from './google.js';

export const HELP = `play-release: upload an Android App Bundle to a Google Play track.

  PLAY_SERVICE_ACCOUNT_JSON  service account JSON (or base64 of it)        required
  PLAY_PACKAGE_NAME          applicationId                                 required
  AAB_PATH                   the .aab to upload                            required
  PLAY_TRACK                 internal | alpha | beta | production | <custom>  default internal
  PLAY_ROLLOUT               fraction in (0,1] for a staged rollout        default whole track
  RELEASE_NOTES              up to 500 characters                          optional
  LOCALE                     locale of the notes                           default en-US`;

/**
 * How much of the track gets it. Empty means all of it: a staged rollout has
 * to be finished by hand, so it must never be the default.
 *
 * @param {string|undefined} raw
 * @returns {number|null} a fraction in (0,1), or null for the whole track
 */
export function rollout(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const f = Number(s);
  if (!Number.isFinite(f) || f <= 0 || f > 1) throw new Error(`PLAY_ROLLOUT must be a fraction between 0 and 1, not ${JSON.stringify(s)}`);
  return f === 1 ? null : f;
}

/**
 * The track's one release. Play rejects `userFraction` on a completed release
 * and an `inProgress` one without it, so status and fraction are one decision.
 *
 * @param {string|number} versionCode @param {number|null} fraction @param {string} notes @param {string} locale
 */
export function trackRelease(versionCode, fraction, notes, locale = 'en-US') {
  return {
    versionCodes: [String(versionCode)],
    ...(fraction ? { status: 'inProgress', userFraction: fraction } : { status: 'completed' }),
    ...(notes ? { releaseNotes: [{ language: locale, text: notes }] } : {}),
  };
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {{ fetchImpl?: typeof fetch, log?: (line: string) => void }} [deps]
 */
export async function run(env, { fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const { PLAY_PACKAGE_NAME: pkg, AAB_PATH: aab } = requireEnv(env, ['PLAY_SERVICE_ACCOUNT_JSON', 'PLAY_PACKAGE_NAME', 'AAB_PATH']);
  const track = env.PLAY_TRACK || 'internal';
  // Play refuses more than 500 characters per locale.
  const notes = (env.RELEASE_NOTES || '').trim().slice(0, 500);
  const fraction = rollout(env.PLAY_ROLLOUT);
  const account = serviceAccount(String(env.PLAY_SERVICE_ACCOUNT_JSON));

  // The account is named up front: Play's 403 never says WHICH account asked.
  log(`${aab} (${((await stat(aab)).size / 1_048_576).toFixed(1)} MB) → ${pkg} ${track}`);
  log(`as ${account.client_email}`);
  const bearer = await googleAccessToken(account, 'https://www.googleapis.com/auth/androidpublisher', fetchImpl);

  /** @param {string} path @param {RequestInit} [init] */
  async function api(path, init = {}) {
    const res = await fetchImpl(`https://androidpublisher.googleapis.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...(init.headers || {}) },
    });
    const body = await res.text();
    if (!res.ok) {
      let detail = body.slice(0, 500);
      try {
        detail = JSON.parse(body).error?.message || detail;
      } catch {}
      throw new Error(`${init.method || 'GET'} ${path} → ${res.status}\n  ${detail}`);
    }
    return body ? JSON.parse(body) : null;
  }

  const base = `/androidpublisher/v3/applications/${pkg}/edits`;
  const edit = await api(base, { method: 'POST' }).catch((e) => {
    if (!/403|permission/i.test(String(e.message))) throw e;
    throw new Error(
      `${e.message}\n\nPlay refused ${account.client_email} on ${pkg}. It says the same for all of these, so check in order:\n` +
        '  1. Play Console → Users and permissions: is that exact address listed?\n' +
        '  2. Its App permissions: the app needs "Release to testing tracks" (account-level access is not enough).\n' +
        '  3. The package must already exist in Play, from one manual upload.',
    );
  });
  log(`edit ${edit.id}`);

  const bundle = await api(`/upload${base}/${edit.id}/bundles?uploadType=media`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: await readFile(aab),
  });
  log(`uploaded versionCode ${bundle.versionCode}`);

  await api(`${base}/${edit.id}/tracks/${track}`, {
    method: 'PUT',
    body: JSON.stringify({ track, releases: [trackRelease(bundle.versionCode, fraction, notes, env.LOCALE || 'en-US')] }),
  });
  await api(`${base}/${edit.id}:commit`, { method: 'POST' });
  log(
    fraction
      ? `committed — versionCode ${bundle.versionCode} is rolling out to ${fraction * 100}% of ${track}; finish it in the console`
      : `committed — versionCode ${bundle.versionCode} is live on ${track}`,
  );
  return { versionCode: bundle.versionCode, track };
}
