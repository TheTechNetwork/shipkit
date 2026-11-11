// App Store provisioning profiles over the App Store Connect API.
//
// NEITHER COMMAND EVER MINTS A CERTIFICATE. Distribution certificates are
// capped per team, and CI runners minting one per run is how a team fills the
// cap. Profiles are cheap: they are bound to every valid distribution
// certificate, so revoking one leaves the others covering it.

import { writeFileSync } from 'node:fs';
import { ascFromEnv, requireEnv } from './asc.js';

/** Apple Distribution and the legacy iOS-only kind; either signs an App Store build. */
const DISTRIBUTION_CERT_TYPES = new Set(['DISTRIBUTION', 'IOS_DISTRIBUTION']);
/** A profile expiring within the month is replaced now rather than on the day it fails. */
const RENEW_WITHIN_MS = 30 * 24 * 60 * 60_000;

export const RECREATE_HELP = `recreate-ios-profile: delete and recreate an App Store profile, bound to every valid distribution certificate.

  ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8   App Store Connect API key (Admin, or App Manager with profile access)
  BUNDLE_ID                  registered bundle id                    required
  PROFILE_NAME               the profile's name                      required
  PROFILE_TYPE               default IOS_APP_STORE
  OUT                        also write the .mobileprovision here     optional`;

export const ENSURE_HELP = `ensure-ios-extension-profile: make sure a bundle id has a usable App Store profile, and write it.

  ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8   App Store Connect API key (Admin, or App Manager with profile access)
  BUNDLE_ID                  the extension's bundle id (registered if missing)   required
  BUNDLE_NAME                portal display name if registering (no dots)        default from BUNDLE_ID
  PROFILE_NAME               the profile's name                                  required
  OUT                        where to write the .mobileprovision                 required
  CERT_SERIAL                serial of the certificate CI signs with             optional
  PROFILE_TYPE               default IOS_APP_STORE`;

/** Serials as Apple and OpenSSL each write them: upper hex, no leading zeros. @param {string} s */
export const serial = (s) => String(s || '').replace(/^serial=/i, '').replace(/[^0-9a-fA-F]/g, '').replace(/^0+/, '').toUpperCase();

/** @param {import('./asc.js').AscClient} asc @param {number} now */
export async function distributionCerts(asc, now) {
  const certs = (await asc.all('/v1/certificates?limit=200')).data.filter((c) => {
    if (!DISTRIBUTION_CERT_TYPES.has(c.attributes?.certificateType)) return false;
    const exp = Date.parse(c.attributes?.expirationDate ?? '');
    return !Number.isFinite(exp) || exp > now;
  });
  if (!certs.length) {
    throw new Error('no valid distribution certificate on the team, so there is nothing to bind a profile to. Import the shared one; do NOT let CI mint another.');
  }
  return certs;
}

/** @param {import('./asc.js').AscClient} asc @param {string} identifier */
export async function findBundle(asc, identifier) {
  // The filter is a search, not an exact match.
  return (await asc.all(`/v1/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=200`)).data.find((b) => b.attributes?.identifier === identifier);
}

/**
 * @param {import('./asc.js').AscClient} asc
 * @param {{ name: string, type: string, bundleId: string, certs: any[] }} o
 */
async function createProfile(asc, { name, type, bundleId, certs }) {
  const created = await asc.api('/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'profiles',
        attributes: { name, profileType: type },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: bundleId } },
          certificates: { data: certs.map((c) => ({ type: 'certificates', id: c.id })) },
        },
      },
    }),
  });
  if (!created?.data?.id) throw new Error('App Store Connect returned no profile');
  return created.data;
}

/**
 * Read a profile back and insist it is ACTIVE: the state is the proof, not the 201.
 *
 * @param {import('./asc.js').AscClient} asc @param {string} id @param {string|undefined} out @param {(l: string) => void} log
 */
async function verifyAndWrite(asc, id, out, log) {
  const check = (await asc.api(`/v1/profiles/${id}`)).data;
  const state = check?.attributes?.profileState;
  if (state !== 'ACTIVE') throw new Error(`profile '${check?.attributes?.name}' is ${state}, expected ACTIVE`);
  if (out) {
    const content = check.attributes.profileContent;
    if (!content) throw new Error(`profile '${check.attributes.name}' came back without its content`);
    writeFileSync(out, Buffer.from(content, 'base64'));
    log(`wrote ${out}`);
  }
  log(`profile: ${check.attributes.name} (${check.attributes.uuid ?? id}), expires ${check.attributes.expirationDate ?? '?'}`);
  return check;
}

/**
 * Delete and recreate. Profiles are immutable: when a certificate they name is
 * revoked they turn INVALID, and the only repair is a new one.
 *
 * @param {Record<string, string|undefined>} env
 * @param {{ fetchImpl?: typeof fetch, log?: (line: string) => void }} [deps]
 */
export async function recreate(env, { fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const { BUNDLE_ID, PROFILE_NAME } = requireEnv(env, ['BUNDLE_ID', 'PROFILE_NAME']);
  const type = env.PROFILE_TYPE || 'IOS_APP_STORE';
  const asc = ascFromEnv(env, fetchImpl);

  const bundle = await findBundle(asc, BUNDLE_ID);
  if (!bundle) throw new Error(`no registered bundle id '${BUNDLE_ID}'. Register the App ID first.`);
  log(`bundle id: ${BUNDLE_ID} (${bundle.id})`);

  const certs = await distributionCerts(asc, Date.now());
  for (const c of certs) log(`  cert ${c.id} ${c.attributes?.certificateType} expires ${c.attributes?.expirationDate ?? '?'}`);

  for (const p of (await asc.all('/v1/profiles?limit=200')).data.filter((p) => p.attributes?.name === PROFILE_NAME)) {
    log(`deleting existing profile '${PROFILE_NAME}' (${p.id}, was ${p.attributes?.profileState})`);
    await asc.api(`/v1/profiles/${p.id}`, { method: 'DELETE' });
  }
  const created = await createProfile(asc, { name: PROFILE_NAME, type, bundleId: bundle.id, certs });
  log(`created profile '${PROFILE_NAME}' (${created.id})`);
  const check = await verifyAndWrite(asc, created.id, env.OUT, log);
  log(`::notice::'${PROFILE_NAME}' is ACTIVE, bound to ${certs.length} distribution cert(s).`);
  return check;
}

/**
 * Reuse a good profile or make one, then write it. Registers the bundle id if
 * the team has never seen it. Never deletes a profile under another name.
 *
 * @param {Record<string, string|undefined>} env
 * @param {{ fetchImpl?: typeof fetch, log?: (line: string) => void, now?: number }} [deps]
 */
export async function ensure(env, { fetchImpl = globalThis.fetch, log = console.log, now = Date.now() } = {}) {
  const { BUNDLE_ID, PROFILE_NAME, OUT } = requireEnv(env, ['BUNDLE_ID', 'PROFILE_NAME', 'OUT']);
  const type = env.PROFILE_TYPE || 'IOS_APP_STORE';
  // Apple refuses a dot in the display name.
  const bundleName = env.BUNDLE_NAME || BUNDLE_ID.replace(/[^A-Za-z0-9 ]+/g, ' ').trim();
  const asc = ascFromEnv(env, fetchImpl);

  let bundle = await findBundle(asc, BUNDLE_ID);
  if (!bundle) {
    bundle = (
      await asc.api('/v1/bundleIds', {
        method: 'POST',
        body: JSON.stringify({ data: { type: 'bundleIds', attributes: { identifier: BUNDLE_ID, name: bundleName, platform: 'IOS' } } }),
      })
    )?.data;
    if (!bundle?.id) throw new Error(`App Store Connect returned no bundle id for ${BUNDLE_ID}`);
    log(`registered bundle id ${BUNDLE_ID} (${bundle.id})`);
  } else {
    log(`bundle id: ${BUNDLE_ID} (${bundle.id})`);
  }

  const certs = await distributionCerts(asc, now);
  // The certificate CI imported, by serial: a profile must name the identity that will actually sign.
  const wanted = serial(env.CERT_SERIAL || '');
  const signer = wanted ? certs.find((c) => serial(c.attributes?.serialNumber) === wanted) : null;
  if (wanted && !signer) {
    throw new Error(`the certificate CI imported (serial ${wanted}) is not a valid distribution certificate on this team any more: it was revoked or has expired.`);
  }

  const listing = await asc.all(`/v1/profiles?filter[profileType]=${type}&include=bundleId,certificates&limit=200`);
  const usable = listing.data.find((p) => {
    if (p.relationships?.bundleId?.data?.id !== bundle.id || p.attributes?.profileState !== 'ACTIVE') return false;
    const exp = Date.parse(p.attributes?.expirationDate ?? '');
    if (Number.isFinite(exp) && exp - now < RENEW_WITHIN_MS) return false;
    const bound = new Set((p.relationships?.certificates?.data ?? []).map((/** @type {any} */ c) => c.id));
    return signer ? bound.has(signer.id) : certs.some((c) => bound.has(c.id));
  });

  let id = usable?.id;
  if (id) {
    log(`reusing profile '${usable.attributes?.name}' (${id}), expires ${usable.attributes?.expirationDate}`);
  } else {
    // Names are unique per team, so only a profile of OUR name is removed first.
    for (const p of listing.data.filter((p) => p.attributes?.name === PROFILE_NAME)) {
      log(`deleting profile '${PROFILE_NAME}' (${p.id}, was ${p.attributes?.profileState})`);
      await asc.api(`/v1/profiles/${p.id}`, { method: 'DELETE' });
    }
    id = (await createProfile(asc, { name: PROFILE_NAME, type, bundleId: bundle.id, certs })).id;
    log(`created profile '${PROFILE_NAME}' (${id}) bound to ${certs.length} distribution cert(s)`);
  }
  const check = await verifyAndWrite(asc, /** @type {string} */ (id), OUT, log);
  log(`::notice::'${check.attributes.name}' is ACTIVE for ${BUNDLE_ID}.`);
  return check;
}
