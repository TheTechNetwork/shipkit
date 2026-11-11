// Put an uploaded build in front of TestFlight testers.
//
// An upload is not a delivery: the build processes for minutes to half an
// hour, then sits until something gives it to a group. This waits for it,
// writes "What to Test", and for external testers assigns and submits it.

import { ascFromEnv, requireEnv, sleep as realSleep } from './asc.js';

export const HELP = `testflight-distribute: hand a processed build to a TestFlight group.

  ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8   App Store Connect API key (raw .p8 PEM)  required
  BUNDLE_ID                  the app's bundle id                                  required
  BUILD_NUMBER               CFBundleVersion of the uploaded build                required
  AUDIENCE                   internal | external                                  default internal
  INTERNAL_BETA_GROUP_NAME / EXTERNAL_BETA_GROUP_NAME   which group             default the first
  WHATS_NEW                  "What to Test" (internal keeps the first line)       optional
  LOCALE                     default en-US
  POLL_TIMEOUT_MS            how long to wait for processing                      default 45 min`;

/**
 * What testers read, in the characters App Store Connect accepts: Apple
 * rejects emoji in whatsNew outright. Internal builds keep only the subject line.
 *
 * @param {string} raw @param {string} audience
 */
export function whatsNew(raw, audience = 'internal') {
  const text = audience === 'internal' ? raw.split('\n')[0] : raw;
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}️‍]/gu, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * The build, once App Store Connect says it is VALID. A build still
 * processing at the deadline is a warning, not a failure: the upload worked.
 *
 * @param {import('./asc.js').Api} api @param {string} appId @param {string} buildNumber
 * @param {{ timeoutMs: number, sleep: (ms: number) => Promise<unknown>, log: (l: string) => void, include?: string }} o
 * @returns {Promise<{ build: any, included: any[] } | null>}
 */
export async function waitForBuild(api, appId, buildNumber, { timeoutMs, sleep, log, include }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // "version" in this API is the build number, not the marketing version.
    const found = await api(`/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}${include ? `&include=${include}` : ''}&limit=1`);
    const build = found.data[0];
    const state = build?.attributes?.processingState;
    if (state === 'VALID') return { build, included: found.included || [] };
    if (state === 'FAILED' || state === 'INVALID') throw new Error(`build ${buildNumber} is ${state}`);
    if (Date.now() > deadline) {
      log(
        `::warning::Build ${buildNumber} uploaded but was still ${state || 'not visible'} after ${Math.round(timeoutMs / 60_000)} minutes. ` +
          'Processing has no deadline (the first build of a new app is slowest); re-run this job once it shows up.',
      );
      return null;
    }
    log(build ? `build ${buildNumber} is ${state}, waiting…` : `build ${buildNumber} not visible yet, waiting…`);
    await sleep(30_000);
  }
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {{ fetchImpl?: typeof fetch, log?: (line: string) => void, sleep?: (ms: number) => Promise<unknown> }} [deps]
 */
export async function run(env, { fetchImpl = globalThis.fetch, log = console.log, sleep = realSleep } = {}) {
  const { BUNDLE_ID, BUILD_NUMBER } = requireEnv(env, ['BUNDLE_ID', 'BUILD_NUMBER']);
  const { api } = ascFromEnv(env, fetchImpl);
  const audience = (env.AUDIENCE || 'internal').toLowerCase();
  if (audience !== 'internal' && audience !== 'external') throw new Error(`AUDIENCE must be internal or external, got ${JSON.stringify(audience)}`);
  const isInternal = audience === 'internal';
  const groupName = (isInternal ? env.INTERNAL_BETA_GROUP_NAME : env.EXTERNAL_BETA_GROUP_NAME) || '';
  const notes = whatsNew(env.WHATS_NEW || '', audience);
  const locale = env.LOCALE || 'en-US';

  const app = (await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=1`)).data[0];
  if (!app) throw new Error(`no app record for ${BUNDLE_ID} — create it in App Store Connect first`);
  log(`app ${app.attributes.name} (${app.id})`);

  const waited = await waitForBuild(api, app.id, BUILD_NUMBER, { timeoutMs: Number(env.POLL_TIMEOUT_MS || 45 * 60_000), sleep, log });
  if (!waited) return { distributed: false };
  const { build } = waited;
  log(`build ${BUILD_NUMBER} is VALID (${build.id})`);

  // Filtered here: filter[isInternalGroup] is a 400 on this relationship endpoint.
  const groups = await api(`/v1/apps/${app.id}/betaGroups?limit=200`);
  const candidates = groups.data.filter((/** @type {any} */ g) => Boolean(g.attributes?.isInternalGroup) === isInternal);
  if (!candidates.length) {
    const other = groups.data.map((/** @type {any} */ g) => g.attributes?.name).filter(Boolean);
    throw new Error(
      `no ${audience} beta group — create one in TestFlight → ${isInternal ? 'Internal' : 'External'} Testing` +
        (other.length ? `\n  groups this app does have: ${other.join(', ')}` : '\n  this app has no beta groups at all'),
    );
  }
  const group = groupName ? candidates.find((/** @type {any} */ g) => g.attributes.name === groupName) : candidates[0];
  if (!group) {
    throw new Error(`no ${audience} group named ${JSON.stringify(groupName)} — have: ${candidates.map((/** @type {any} */ g) => g.attributes.name).join(', ')}`);
  }

  if (notes) {
    const existing = await api(`/v1/builds/${build.id}/betaBuildLocalizations?limit=200`);
    const loc = existing.data.find((/** @type {any} */ l) => l.attributes.locale === locale);
    const attributes = { whatsNew: notes.slice(0, 4000) };
    if (loc) {
      await api(`/v1/betaBuildLocalizations/${loc.id}`, { method: 'PATCH', body: JSON.stringify({ data: { type: 'betaBuildLocalizations', id: loc.id, attributes } }) });
    } else {
      await api('/v1/betaBuildLocalizations', {
        method: 'POST',
        body: JSON.stringify({
          data: { type: 'betaBuildLocalizations', attributes: { ...attributes, locale }, relationships: { build: { data: { type: 'builds', id: build.id } } } },
        }),
      });
    }
    log(`what to test: ${notes.split('\n')[0].slice(0, 72)}`);
  }

  // AN INTERNAL GROUP IS NOT ASSIGNED A BUILD: it gets every one, and asking is
  // a 422 "Cannot add internal group to a build". So internal returns here.
  if (isInternal) {
    log(`build ${BUILD_NUMBER} is available to "${group.attributes.name}" — internal groups receive every build automatically`);
    return { distributed: true, group: group.attributes.name };
  }

  await api(`/v1/betaGroups/${group.id}/relationships/builds`, { method: 'POST', body: JSON.stringify({ data: [{ type: 'builds', id: build.id }] }) });
  log(`build ${BUILD_NUMBER} → "${group.attributes.name}"`);
  // External testers are the public, so Apple reviews first; already-submitted is not a failure.
  try {
    await api('/v1/betaAppReviewSubmissions', {
      method: 'POST',
      body: JSON.stringify({ data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: build.id } } } } }),
    });
    log(`build ${BUILD_NUMBER} submitted for beta app review`);
  } catch (e) {
    if (!/already|409/i.test(String(/** @type {Error} */ (e).message))) throw e;
    log(`beta app review not resubmitted: ${String(/** @type {Error} */ (e).message).split('\n')[0]}`);
  }
  return { distributed: true, group: group.attributes.name };
}
