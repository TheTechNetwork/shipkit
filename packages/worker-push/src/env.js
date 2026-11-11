// Build whichever sender an environment is configured for.

import { apnsPusher, fcmPusher, logPusher, parseServiceAccount, routingPusher, truthy } from './push.js';
import { webPusher } from './webpush.js';

/** @typedef {import('./push.js').Pusher} Pusher */
/** @typedef {import('./push.js').Deliver} Deliver */

/**
 * @typedef {object} FromEnvOptions
 * @property {string} [prefix]  prepended to every variable name, e.g. "MYAPP_"
 * @property {{ info: Function, warn: Function }} [logger]
 * @property {Deliver} [apnsDeliver]  Node's fetch is not HTTP/2; inject a transport there
 * @property {string} [defaultBundleId]  used when `<prefix>APNS_BUNDLE_ID` is unset
 * @property {boolean} [requireSwitch]  default true: nothing sends unless `<prefix>PUSH` is on
 * @property {(env: Record<string, string|undefined>) => Pusher|null} [fallback]
 *   tried when no provider of our own is configured (Fleetwright's relay)
 * @property {string} [fallbackHint]  added to the "no provider" warning
 * @property {import('./push.js').SealOptions} [seal]
 * @property {import('./push.js').DeadCallback} [onDead]
 * @property {(wire: import('./push.js').Wire, message: import('./push.js').PushMessage) => string|undefined} [collapseKey]
 */

/**
 * The variables, with `prefix` (default none):
 *
 *   PUSH                     1/true/yes/on to send at all
 *   APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID   all three, or none
 *   APNS_BUNDLE_ID           the apns-topic; APNS_SANDBOX=1 for Xcode-run builds
 *   FCM_SERVICE_ACCOUNT      JSON, or base64 of it
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT   all three, or none
 *
 * @param {Record<string, string|undefined>} env
 * @param {FromEnvOptions} [opts]
 * @returns {Pusher}
 */
export function pusherFromEnv(env, opts = {}) {
  const { prefix = '', requireSwitch = true, fallback, fallbackHint } = opts;
  const logger = opts.logger || { info() {}, warn() {} };
  const name = (/** @type {string} */ n) => `${prefix}${n}`;
  const get = (/** @type {string} */ n) => env[name(n)];
  const senderOpts = { logger, seal: opts.seal, onDead: opts.onDead, collapseKey: opts.collapseKey };

  // OFF UNLESS ASKED FOR: credentials are not the switch, or a fork that copied
  // a config would notify the original app's devices. And off SAYS SO.
  if (requireSwitch && !truthy(get('PUSH'))) {
    logger.info(`push: disabled (${name('PUSH')} is not set) — notifications are logged, not sent`);
    return logPusher(logger);
  }

  const apns = apnsFromEnv();
  const fcm = fcmFromEnv();
  const web = webFromEnv();

  if (apns || fcm || web) {
    logger.info(`push: ${[apns && 'APNs for iOS', web && 'Web Push for browsers', fcm && 'FCM for the rest'].filter(Boolean).join(', ')}`);
    // Never route an iOS token to FCM: an unconfigured platform logs instead.
    return routingPusher({ ios: apns || logPusher(logger), web: web || undefined, other: fcm || logPusher(logger), logger });
  }

  const other = fallback?.(env);
  if (other) return other;

  // Switched on and unable to send: the one combination that must be loud.
  logger.warn(
    `push: ${name('PUSH')} is set but no provider is configured — notifications are logged, not sent. ` +
      `APNs needs ${name('APNS_KEY')}, _KEY_ID and _TEAM_ID; FCM needs ${name('FCM_SERVICE_ACCOUNT')}; ` +
      `Web Push needs ${name('VAPID_PUBLIC_KEY')}, _PRIVATE_KEY and _SUBJECT. ` +
      (fallbackHint ? `${fallbackHint} ` : '') +
      `Unset ${name('PUSH')} if that is deliberate.`,
  );
  return logPusher(logger);

  function apnsFromEnv() {
    const keyId = get('APNS_KEY_ID');
    const teamId = get('APNS_TEAM_ID');
    const privateKey = get('APNS_KEY');
    if (!keyId && !teamId && !privateKey) return null;
    if (!keyId || !teamId || !privateKey) {
      logger.warn(`push: APNs needs ${name('APNS_KEY_ID')}, _TEAM_ID and _KEY — all three. iOS push is off.`);
      return null;
    }
    const bundleId = get('APNS_BUNDLE_ID') || opts.defaultBundleId;
    if (!bundleId) {
      logger.warn(`push: APNs needs ${name('APNS_BUNDLE_ID')}, the app's bundle id. iOS push is off.`);
      return null;
    }
    logger.info(`push: APNs configured for ${bundleId}`);
    // Production unless told otherwise: TestFlight and App Store builds use it.
    return apnsPusher({ keyId, teamId, privateKey, bundleId, production: get('APNS_SANDBOX') !== '1' }, { ...senderOpts, deliver: opts.apnsDeliver });
  }

  function fcmFromEnv() {
    const raw = get('FCM_SERVICE_ACCOUNT');
    if (!raw) return null;
    const parsed = parseServiceAccount(raw);
    if (!parsed) {
      logger.warn(`push: ${name('FCM_SERVICE_ACCOUNT')} is neither JSON nor base64-encoded JSON — falling back to logging.\n  base64 -w0 service-account.json`);
      return null;
    }
    if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
      logger.warn('push: FCM service account is missing client_email, private_key or project_id — falling back to logging');
      return null;
    }
    logger.info(`push: FCM configured for project ${parsed.project_id}`);
    return fcmPusher(parsed, senderOpts);
  }

  function webFromEnv() {
    const publicKey = get('VAPID_PUBLIC_KEY');
    const privateKey = get('VAPID_PRIVATE_KEY');
    const subject = get('VAPID_SUBJECT');
    if (!publicKey && !privateKey && !subject) return null;
    if (!publicKey || !privateKey || !subject) {
      logger.warn(`push: Web Push needs ${name('VAPID_PUBLIC_KEY')}, _PRIVATE_KEY and _SUBJECT — all three. Browser push is off.`);
      return null;
    }
    return webPusher({ publicKey, privateKey, subject }, senderOpts);
  }
}
