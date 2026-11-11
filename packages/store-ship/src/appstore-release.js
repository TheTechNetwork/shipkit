// Create the App Store version for an uploaded build, attach it, write the
// listing, and submit it for App Review.
//
// Submission is the delivery; approval is Apple's, so nothing here waits for
// review. Every step tolerates already-done, so a re-run picks up where one stopped.

import { readFileSync } from 'node:fs';
import { ascFromEnv, reason, requireEnv, sleep as realSleep } from './asc.js';
import { storeListing } from './store-listing.js';
import { uploadScreenshots } from './appstore-screenshots.js';
import { waitForBuild } from './testflight-distribute.js';

export const HELP = `appstore-release: create the App Store version, attach the build, write the listing, submit for review.

  ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8   App Store Connect API key (raw .p8 PEM)    required
  BUNDLE_ID, BUILD_NUMBER    the app and the uploaded build                            required
  WHATS_NEW                  public release notes (refused on an app's first version)  optional
  STORE_LISTING              Markdown listing document (see README)                    optional
  SCREENSHOTS_DIR            one subdirectory per display type                        optional
  SCREENSHOTS_FORCE          true to replace screenshots already there
  ASC_REVIEW_FIRST_NAME, ASC_REVIEW_LAST_NAME, ASC_REVIEW_PHONE, ASC_REVIEW_EMAIL   App Review contact, all or none
  REVIEW_NOTES / REVIEW_NOTES_FILE   notes for App Review                             optional
  REVIEW_DEMO_ACCOUNT_REQUIRED       true | false                                     optional
  LOCALE                     default en-US
  POLL_TIMEOUT_MS            how long to wait for processing                         default 45 min`;

/**
 * The states a version can still be edited and submitted in: preparation, and
 * what a rejection leaves behind.
 */
export const EDITABLE = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']);

/** Already public: the version string is spent. */
const ON_THE_STORE = new Set(['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION', 'REPLACED_WITH_NEW_VERSION']);

const CHECKLIST = 'If this names missing metadata, finish the listing in App Store Connect — see the once-ever checklist in the shipkit README.';

/** @param {any} v */
const stateOf = (v) => v?.attributes?.appVersionState || v?.attributes?.appStoreState;

/**
 * What is missing from the listing, said BEFORE anything is written: Apple's
 * own refusal arrives at the very end, one attribute at a time. Read-only, and
 * a better message rather than a new gate, so it never throws.
 *
 * @param {import('./asc.js').Api} api @param {string} appId @param {string} versionString @param {(l: string) => void} log
 * @returns {Promise<string[]>}
 */
export async function listingGaps(api, appId, versionString, log) {
  /** @type {string[]} */
  const gaps = [];
  try {
    // WITH include, or relationships come back as links and every check reads "missing".
    const infos = await api(`/v1/apps/${appId}/appInfos?include=primaryCategory,ageRatingDeclaration&limit=2`);
    if (infos.data?.length) {
      if (!infos.data.some((/** @type {any} */ i) => i.relationships?.primaryCategory?.data)) gaps.push('no primary category');
      const answered = (infos.included || [])
        .filter((/** @type {any} */ i) => i.type === 'ageRatingDeclarations')
        .some((/** @type {any} */ d) => Object.values(d.attributes || {}).some((v) => v !== null && v !== undefined));
      if (!answered) gaps.push('the age rating questionnaire has not been answered');
    }
    const v = (await api(`/v1/apps/${appId}/appStoreVersions?filter[versionString]=${encodeURIComponent(versionString)}&filter[platform]=IOS&limit=1`)).data?.[0];
    if (v) {
      const primary = (await api(`/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations?limit=50`)).data?.[0];
      if (!primary) {
        gaps.push('no localisation on this version — description and keywords are unset');
      } else {
        const a = primary.attributes || {};
        if (!a.description) gaps.push(`no description for ${a.locale || 'the primary locale'}`);
        if (!a.keywords) gaps.push(`no keywords for ${a.locale || 'the primary locale'}`);
        if (!a.supportUrl) gaps.push('no support URL');
        const sets = await api(`/v1/appStoreVersionLocalizations/${primary.id}/appScreenshotSets?limit=10`);
        if (!(sets.data || []).length) gaps.push('no screenshots on this version');
      }
    }
  } catch (e) {
    log(`::debug::could not pre-check the listing (${reason(e)})`);
    return [];
  }
  return gaps;
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {{ fetchImpl?: typeof fetch, log?: (line: string) => void, error?: (line: string) => void, sleep?: (ms: number) => Promise<unknown> }} [deps]
 */
export async function run(env, { fetchImpl = globalThis.fetch, log = console.log, error = console.error, sleep = realSleep } = {}) {
  const { BUNDLE_ID, BUILD_NUMBER } = requireEnv(env, ['BUNDLE_ID', 'BUILD_NUMBER']);
  const { api } = ascFromEnv(env, fetchImpl);
  const locale = env.LOCALE || 'en-US';
  // Unlike TestFlight's beta notes, the App Store field accepts emoji: sent as written.
  const whatsNew = (env.WHATS_NEW || '').trim().slice(0, 4000);
  /** @type {ReturnType<typeof storeListing> | null} */
  let listing = null;
  if (env.STORE_LISTING) {
    try {
      listing = storeListing(env.STORE_LISTING);
    } catch (e) {
      // A listing that cannot be read is not a reason to drop a release; the store keeps its copy.
      log(`::warning::store listing not applied: ${reason(e)}`);
    }
  }

  const app = (await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=1`)).data[0];
  if (!app) throw new Error(`no app record for ${BUNDLE_ID} — create it in App Store Connect first`);
  log(`app ${app.attributes.name} (${app.id})`);

  // The version string comes from the build's own version train, so the two cannot drift.
  const waited = await waitForBuild(api, app.id, BUILD_NUMBER, {
    timeoutMs: Number(env.POLL_TIMEOUT_MS || 45 * 60_000),
    sleep,
    log,
    include: 'preReleaseVersion',
  });
  if (!waited) return { submitted: false };
  const { build, included } = waited;
  const versionString = included.find((/** @type {any} */ i) => i.type === 'preReleaseVersions')?.attributes?.version || '';
  if (!versionString) throw new Error(`build ${BUILD_NUMBER} has no version train — cannot name an App Store version`);
  log(`build ${BUILD_NUMBER} is VALID (${build.id}), version ${versionString}`);

  const gaps = await listingGaps(api, app.id, versionString, log);
  if (gaps.length) {
    log('::warning::this listing is not finished, and App Review will refuse it:');
    for (const g of gaps) log(`::warning::  - ${g}`);
  }

  let version = (await api(`/v1/apps/${app.id}/appStoreVersions?filter[versionString]=${encodeURIComponent(versionString)}&filter[platform]=IOS&limit=1`)).data[0];
  const vstate = stateOf(version);
  if (version && !EDITABLE.has(vstate)) {
    if (ON_THE_STORE.has(vstate)) {
      throw new Error(`version ${versionString} is already on the App Store (${vstate}) — bump the app's marketing version and release again`);
    }
    // Already in the pipeline: the work this run would do is done.
    log(`version ${versionString} is ${vstate} — already submitted, nothing to do`);
    return { submitted: true, versionString };
  }
  if (!version) {
    // Apple allows one version in preparation per platform, and makes a "1.0"
    // with the app record. An editable version under any name is this one, renamed.
    const other = ((await api(`/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=20`)).data || []).find((/** @type {any} */ v) => EDITABLE.has(stateOf(v)));
    if (other) {
      const renamed = await api(`/v1/appStoreVersions/${other.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ data: { type: 'appStoreVersions', id: other.id, attributes: { versionString } } }),
      });
      version = renamed?.data || { ...other, attributes: { ...other.attributes, versionString } };
      log(`renamed App Store version ${other.attributes?.versionString} (${stateOf(other)}) to ${versionString}: one version in preparation per platform`);
    }
  }
  if (!version) {
    // AFTER_APPROVAL, never MANUAL: no third state where the pipeline is green and the app unshipped.
    version = (
      await api('/v1/appStoreVersions', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'appStoreVersions',
            attributes: { platform: 'IOS', versionString, releaseType: 'AFTER_APPROVAL' },
            relationships: { app: { data: { type: 'apps', id: app.id } } },
          },
        }),
      })
    ).data;
    log(`created App Store version ${versionString} (${version.id})`);
  } else {
    log(`using App Store version ${versionString} (${version.id})`);
  }

  // On a reused version this replaces the build: the newest release run owns it.
  await api(`/v1/appStoreVersions/${version.id}/relationships/build`, { method: 'PATCH', body: JSON.stringify({ data: { type: 'builds', id: build.id } }) });
  log(`build ${BUILD_NUMBER} attached to ${versionString}`);

  await writeVersionFacts(api, app.id, version.id, listing, env, log);

  // Notes and listing in ONE PATCH, since they are one object.
  /** @type {Record<string, string>} */
  const attributes = {};
  if (whatsNew) attributes.whatsNew = whatsNew;
  if (listing) {
    attributes.description = listing.appStore;
    // Play's short description is the App Store's promotional text.
    attributes.promotionalText = listing.short;
    attributes.keywords = listing.keywords;
    attributes.supportUrl = listing.supportUrl;
  }
  const localization = async () =>
    ((await api(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`)).data || []).find((/** @type {any} */ l) => l.attributes.locale === locale);
  if (Object.keys(attributes).length) {
    try {
      const loc = await localization();
      if (loc) {
        const patch = (/** @type {Record<string, string>} */ attrs) =>
          api(`/v1/appStoreVersionLocalizations/${loc.id}`, { method: 'PATCH', body: JSON.stringify({ data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: attrs } }) });
        // A first version refuses whatsNew, and that must not take the description down with it.
        const refused = await patch(attributes).then(() => null, (/** @type {Error} */ e) => e);
        if (refused && attributes.whatsNew) {
          const { whatsNew: _dropped, ...rest } = attributes;
          log(`::warning::release notes refused (${reason(refused)}) — writing the listing without them`);
          if (Object.keys(rest).length) await patch(rest);
        } else if (refused) {
          log(`::warning::listing not set: ${reason(refused)}`);
        } else {
          log(`listing: ${Object.keys(attributes).join(', ')}`);
        }
      } else {
        log(`no ${locale} localization on the version — finish the listing in App Store Connect`);
      }
    } catch (e) {
      log(`::warning::listing not set: ${reason(e)}`);
    }
  }

  // Screenshots BEFORE the submission: a version missing a required size is refused at submit.
  if (env.SCREENSHOTS_DIR) {
    try {
      const loc = await localization();
      if (loc) {
        const n = await uploadScreenshots({ api, localizationId: loc.id, dir: env.SCREENSHOTS_DIR, force: env.SCREENSHOTS_FORCE === 'true', fetchImpl, log });
        if (n) log(`${n} screenshot(s) uploaded`);
      }
    } catch (e) {
      log(`::warning::screenshots not uploaded: ${reason(e)}`);
    }
  }

  // reviewSubmissions, not the deprecated appStoreVersionSubmissions: submission, item, submit.
  const open = await api(
    `/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=1`,
  );
  let submission = open.data[0];
  if (submission && submission.attributes.state !== 'READY_FOR_REVIEW') {
    log(`a review submission is already ${submission.attributes.state} — not submitting again`);
    return { submitted: true, versionString };
  }
  if (!submission) {
    submission = (
      await api('/v1/reviewSubmissions', {
        method: 'POST',
        body: JSON.stringify({ data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: app.id } } } } }),
      })
    ).data;
  }
  try {
    await api('/v1/reviewSubmissionItems', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'reviewSubmissionItems',
          relationships: {
            reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
            appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
          },
        },
      }),
    });
  } catch (e) {
    // ONLY "already in" is done: Apple answers an incomplete version with a 409 too.
    if (!/already (?:exists|in|added|part of)|duplicate/i.test(String(/** @type {Error} */ (e).message))) {
      error(CHECKLIST);
      throw e;
    }
    log(`version already in the submission: ${reason(e)}`);
  }
  try {
    await api(`/v1/reviewSubmissions/${submission.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } } }),
    });
    log(`version ${versionString} (build ${BUILD_NUMBER}) submitted for App Review`);
  } catch (e) {
    if (!/already (?:been )?submitted|already in review/i.test(String(/** @type {Error} */ (e).message))) {
      error(CHECKLIST);
      throw e;
    }
    log(`not resubmitted: ${reason(e)}`);
  }
  return { submitted: true, versionString };
}

/**
 * Copyright, the privacy policy URL and the App Review contact: what a first
 * submission is refused for besides the description. Each warns and goes on.
 *
 * @param {import('./asc.js').Api} api @param {string} appId @param {string} versionId
 * @param {ReturnType<typeof storeListing> | null} listing @param {Record<string, string|undefined>} env @param {(l: string) => void} log
 */
async function writeVersionFacts(api, appId, versionId, listing, env, log) {
  if (listing) {
    try {
      await api(`/v1/appStoreVersions/${versionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ data: { type: 'appStoreVersions', id: versionId, attributes: { copyright: listing.copyright } } }),
      });
      log(`copyright: ${listing.copyright}`);
    } catch (e) {
      log(`::warning::copyright not set: ${reason(e)}`);
    }
    try {
      // The privacy URL lives on the app INFO; the one already on the store is read-only.
      let written = 0;
      for (const info of (await api(`/v1/apps/${appId}/appInfos?limit=2`)).data || []) {
        const loc = ((await api(`/v1/appInfos/${info.id}/appInfoLocalizations?limit=50`)).data || []).find((/** @type {any} */ l) => l.attributes?.locale === (env.LOCALE || 'en-US'));
        if (!loc || loc.attributes?.privacyPolicyUrl === listing.privacyPolicyUrl) continue;
        try {
          await api(`/v1/appInfoLocalizations/${loc.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ data: { type: 'appInfoLocalizations', id: loc.id, attributes: { privacyPolicyUrl: listing.privacyPolicyUrl } } }),
          });
          written++;
        } catch (e) {
          log(`::debug::privacy policy URL not written on app info ${info.id}: ${reason(e)}`);
        }
      }
      if (written) log(`privacy policy URL: ${listing.privacyPolicyUrl}`);
    } catch (e) {
      log(`::warning::privacy policy URL not set: ${reason(e)}`);
    }
  }

  // WHO APP REVIEW MAY CALL: all four or none, and never invented.
  const contact = {
    contactFirstName: env.ASC_REVIEW_FIRST_NAME || '',
    contactLastName: env.ASC_REVIEW_LAST_NAME || '',
    contactPhone: env.ASC_REVIEW_PHONE || '',
    contactEmail: env.ASC_REVIEW_EMAIL || '',
  };
  if (Object.values(contact).some((v) => !v)) {
    log('::warning::no App Review contact — set ASC_REVIEW_FIRST_NAME, ASC_REVIEW_LAST_NAME, ASC_REVIEW_PHONE and ASC_REVIEW_EMAIL, or type it once in App Store Connect');
    return;
  }
  const notes = env.REVIEW_NOTES || (env.REVIEW_NOTES_FILE ? readFileSync(env.REVIEW_NOTES_FILE, 'utf8').trim() : '');
  const demo = env.REVIEW_DEMO_ACCOUNT_REQUIRED;
  // Written on the PATCH as well as the POST, so a box ticked once in the web UI does not stay ticked.
  const attributes = {
    ...contact,
    ...(notes ? { notes: notes.slice(0, 4000) } : {}),
    ...(demo === 'true' || demo === 'false' ? { demoAccountRequired: demo === 'true' } : {}),
  };
  try {
    const current = (await api(`/v1/appStoreVersions/${versionId}/appStoreReviewDetail`).catch(() => null))?.data;
    if (current) {
      await api(`/v1/appStoreReviewDetails/${current.id}`, { method: 'PATCH', body: JSON.stringify({ data: { type: 'appStoreReviewDetails', id: current.id, attributes } }) });
    } else {
      await api('/v1/appStoreReviewDetails', {
        method: 'POST',
        body: JSON.stringify({ data: { type: 'appStoreReviewDetails', attributes, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } } } }),
      });
    }
    log(`review contact: ${contact.contactFirstName} ${contact.contactLastName}${notes ? ', with notes' : ''}`);
  } catch (e) {
    log(`::warning::review contact not set: ${reason(e)}`);
  }
}
