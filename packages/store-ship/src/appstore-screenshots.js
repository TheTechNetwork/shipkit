// App Store screenshots, uploaded from a directory instead of a browser.
//
// One subdirectory per Apple display type (APP_IPHONE_67, APP_IPAD_PRO_3GEN_129…),
// images uploaded in name order. A type that already has acceptable screenshots
// is left alone; a set holding a size Apple would refuse is replaced whole.
//
// The upload is three steps: reserve (POST, answers with byte-range operations),
// PUT each range, then PATCH uploaded + MD5. Without the checksum the asset never
// becomes usable and the version is refused later for a screenshot that looks present.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Pixel sizes App Store Connect accepts per display type, portrait. A type not
 * listed is not checked, which is "cannot tell", not "fine".
 */
export const ACCEPTED = /** @type {Record<string, string[]>} */ ({
  APP_IPHONE_67: ['1320x2868', '1290x2796', '1260x2736', '1284x2778'],
  APP_IPHONE_61: ['1206x2622', '1179x2556', '1170x2532'],
  APP_IPAD_PRO_3GEN_129: ['2064x2752', '2048x2732'],
});

/**
 * Why an existing screenshot cannot stay, or null. Dimensions Apple has not
 * reported yet are not a reason: a picture is not thrown away on a guess.
 *
 * @param {string} type @param {any} shot an appScreenshots resource
 */
export function unacceptable(type, shot) {
  const a = shot?.attributes || {};
  if (a.assetDeliveryState?.state === 'FAILED') return 'delivery failed';
  const sizes = ACCEPTED[type];
  const w = a.imageAsset?.width;
  const h = a.imageAsset?.height;
  if (!sizes || !w || !h) return null;
  return sizes.includes(`${w}x${h}`) || sizes.includes(`${h}x${w}`) ? null : `${w}x${h} is not a size ${type} accepts`;
}

/**
 * @param {import('./asc.js').Api} api @param {string} setId @param {string} file @param {typeof fetch} fetchImpl
 */
async function upload(api, setId, file, fetchImpl) {
  const bytes = readFileSync(file);
  const name = path.basename(file);
  const created = await api('/v1/appScreenshots', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'appScreenshots',
        attributes: { fileSize: bytes.length, fileName: name },
        relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } },
      },
    }),
  });
  const id = created.data.id;
  // The ranges are Apple's: honour every operation's offset, length and headers.
  for (const op of created.data.attributes.uploadOperations || []) {
    /** @type {Record<string, string>} */
    const headers = {};
    for (const h of op.requestHeaders || []) headers[h.name] = h.value;
    const res = await fetchImpl(op.url, { method: op.method || 'PUT', headers, body: bytes.subarray(op.offset, op.offset + op.length) });
    if (!res.ok) throw new Error(`uploading ${name} → ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  }
  // MD5 is Apple's choice for checking receipt, not a security claim.
  await api(`/v1/appScreenshots/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ data: { type: 'appScreenshots', id, attributes: { uploaded: true, sourceFileChecksum: createHash('md5').update(bytes).digest('hex') } } }),
  });
  return name;
}

/**
 * Attach the screenshots in `dir` to one version localisation.
 *
 * @param {object} o
 * @param {import('./asc.js').Api} o.api
 * @param {string} o.localizationId
 * @param {string|undefined} o.dir
 * @param {boolean} [o.force]  replace what is already there
 * @param {typeof fetch} [o.fetchImpl]  for the upload PUTs, which go to Apple's storage, not the API
 * @param {(l: string) => void} [o.log]
 * @returns {Promise<number>} how many images were uploaded
 */
export async function uploadScreenshots({ api, localizationId, dir, force = false, fetchImpl = globalThis.fetch, log = console.log }) {
  if (!dir || !existsSync(dir)) {
    // Not a failure: a release does not stop for want of pictures.
    log(`no screenshots directory${dir ? ` at ${dir}` : ''} — no screenshots to upload`);
    return 0;
  }
  const types = readdirSync(dir).filter((d) => statSync(path.join(dir, d)).isDirectory());
  if (!types.length) {
    log(`no display-type directories under ${dir} — no screenshots to upload`);
    return 0;
  }

  const sets = await api(`/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?limit=50`);
  let uploaded = 0;
  for (const type of types) {
    // Sorted: the order on the store page is the order they arrive in.
    const files = readdirSync(path.join(dir, type)).filter((f) => /\.(png|jpg|jpeg)$/i.test(f)).sort();
    if (!files.length) continue;

    let set = (sets.data || []).find((/** @type {any} */ s) => s.attributes.screenshotDisplayType === type);
    if (set) {
      const existing = (await api(`/v1/appScreenshotSets/${set.id}/appScreenshots?limit=10`)).data || [];
      const wrong = existing.map((/** @type {any} */ s) => unacceptable(type, s)).filter(Boolean);
      if (existing.length && !force && !wrong.length) {
        log(`${type}: already has screenshots — left alone (SCREENSHOTS_FORCE=true to replace)`);
        continue;
      }
      if (existing.length) {
        // The whole set goes before the new ones: Apple refuses the version for any one wrong picture.
        log(wrong.length ? `${type}: replacing ${existing.length} screenshot(s) Apple would refuse — ${wrong[0]}` : `${type}: replacing ${existing.length} screenshot(s) as forced`);
        for (const s of existing) await api(`/v1/appScreenshots/${s.id}`, { method: 'DELETE' });
      }
    }
    if (!set) {
      set = (
        await api('/v1/appScreenshotSets', {
          method: 'POST',
          body: JSON.stringify({
            data: {
              type: 'appScreenshotSets',
              attributes: { screenshotDisplayType: type },
              relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } } },
            },
          }),
        })
      ).data;
    }
    for (const f of files) {
      log(`${type}: uploaded ${await upload(api, set.id, path.join(dir, type, f), fetchImpl)}`);
      uploaded++;
    }
  }
  return uploaded;
}
