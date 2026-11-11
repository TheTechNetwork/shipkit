// Push senders for APNs and FCM, portable between Node 20+ and Workers.
//
// No `node:` imports: `fetch`, `crypto.subtle` and `atob`/`btoa` only. Every
// sender has the same shape, `send(devices, message) → { sent, dead }`, so
// routing, logging and the web sender are interchangeable.

import { sealTo } from './seal.js';
import { signJwtES256, signJwtRS256 } from './jwt.js';

/**
 * @typedef {object} PushMessage
 * @property {string} title
 * @property {string} body
 * @property {Record<string, string>} [data]  FCM data values must be strings
 * @property {string} [category]  an iOS category the app registered: draws its buttons
 * @property {boolean} [drawnByApp]  FCM sends data-only, so the app draws it itself
 * @property {boolean} [wake]  iOS `content-available`, alongside the alert, never instead
 * @property {string} [collapseKey]  a newer message with the same key replaces the older.
 *   Sent in the clear, so never put a secret in it.
 */

/**
 * @typedef {object} Device
 * @property {string} token
 * @property {string} platform  'ios' goes to APNs, 'web' to Web Push, anything else to FCM
 * @property {string} [pushKey]  base64 P-256 public key: seal the content to it
 * @property {Wire} [wire]  already made (a relay forwarding someone else's envelope)
 * @property {{ endpoint: string, keys: { p256dh: string, auth: string } }} [subscription]  web only
 */

/** @typedef {{ encrypted: boolean, title: string, body: string, data: Record<string, string> }} Wire */

/**
 * @typedef {object} Pusher
 * @property {(devices: Device[], message: PushMessage) => Promise<{sent: number, dead: string[]}>} send
 * @property {(tokens: string[], update: ActivityUpdate) => Promise<{sent: number, dead: string[]}>} [activity]
 */

/**
 * A Live Activity update. Not encrypted and cannot be: the system hands
 * `content-state` straight to the widget, so put nothing sensitive in it.
 *
 * @typedef {object} ActivityUpdate
 * @property {'update'|'end'} event
 * @property {Record<string, string|number>} state
 * @property {number} [dismissAt]  ms epoch
 * @property {5|10} [priority]  10 (default) for news, 5 for progress; Apple throttles too many 10s
 */

/**
 * How sealed notifications look on the wire.
 *
 * @typedef {object} SealOptions
 * @property {string} info  domain-separation string shared with the app (Fleetwright: "fleetwright-push-v1")
 * @property {string} [title]  shown if the app cannot open the envelope
 * @property {string} [body]   ditto: a sentence, not a placeholder
 */

/** @typedef {(token: string, platform: string) => void | Promise<void>} DeadCallback */
/** @typedef {{ info: Function, warn: Function }} Logger */

/** An hour: long enough for a phone on a train, short enough not to arrive stale. */
export const PUSH_TTL_S = 3600;

const QUIET = { info() {}, warn() {} };

/**
 * What goes on the wire for one device.
 *
 * A device with a `pushKey` gets an envelope and a detail-free alert; one
 * without gets the plain words, because "no notification" is the worse trade.
 * `sentAt` is inside the envelope so a replayed one carries its own age.
 *
 * @param {{ pushKey?: string }} device
 * @param {PushMessage} message
 * @param {{ now?: () => number, seal?: SealOptions }} [opts]
 * @returns {Promise<Wire>}
 */
export async function envelopeFor(device, message, { now = () => Date.now(), seal } = {}) {
  const data = { ...(message.data || {}), sentAt: String(now()) };
  if (!device.pushKey) return { encrypted: false, title: message.title, body: message.body, data };
  if (!seal?.info) throw new TypeError('this device registered a push key, but the sender has no `seal.info` to encrypt with');
  // The category is sealed too, always (empty when none), so a clear one changed in transit can be caught.
  const sealed = await sealTo(device.pushKey, { title: message.title, body: message.body, data: { ...data, category: message.category ?? '' } }, { info: seal.info });
  return {
    encrypted: true,
    title: seal.title ?? 'New notification',
    body: seal.body ?? 'Open the app to see it.',
    // `e`, short: both services cap a payload at 4 KB.
    data: { e: sealed },
  };
}

/**
 * Report dead tokens to the caller as they are found. A callback that throws
 * is logged, never allowed to stop the send.
 *
 * @param {DeadCallback|undefined} onDead @param {Logger} log
 * @returns {(token: string, platform: string) => Promise<void>}
 */
export function deadReporter(onDead, log) {
  return async (token, platform) => {
    if (!onDead) return;
    try {
      await onDead(token, platform);
    } catch (err) {
      log.warn(`push: onDead failed for a ${platform} token — ${errorText(err)}`);
    }
  };
}

/**
 * A sender that only logs. The default when push is off, and it says what it
 * would have sent, so "never wired up" is not discovered on the day it matters.
 *
 * @param {{ info: Function }} logger
 * @returns {Pusher}
 */
export function logPusher(logger) {
  return {
    async send(devices, message) {
      logger.info(`push (not configured, would send to ${devices.length}): ${message.title} — ${message.body}`);
      return { sent: 0, dead: [] };
    },
    async activity(tokens, update) {
      logger.info(`push (not configured, would update ${tokens.length} live activit${tokens.length === 1 ? 'y' : 'ies'}): ${update.event}`);
      return { sent: 0, dead: [] };
    },
  };
}

/**
 * @typedef {object} SenderOptions
 * @property {Logger} [logger]
 * @property {() => number} [now]
 * @property {SealOptions} [seal]  needed only for devices that registered a pushKey
 * @property {DeadCallback} [onDead]  called once per dead token, as well as returned
 * @property {(wire: Wire, message: PushMessage) => string|undefined} [collapseKey]
 *   defaults to `message.collapseKey`
 */

/**
 * Firebase Cloud Messaging, HTTP v1. Needs a service account's `client_email`,
 * `private_key` and `project_id`.
 *
 * @param {{ client_email: string, private_key: string, project_id: string }} serviceAccount
 * @param {SenderOptions & { fetchImpl?: typeof fetch }} [opts]
 * @returns {Pusher}
 */
export function fcmPusher(serviceAccount, { logger, fetchImpl, now = () => Date.now(), seal, onDead, collapseKey } = {}) {
  const log = logger || QUIET;
  const doFetch = fetchImpl || globalThis.fetch;
  const reportDead = deadReporter(onDead, log);
  const collapseOf = collapseKey || ((/** @type {Wire} */ _w, /** @type {PushMessage} */ m) => m.collapseKey);
  /** @type {{ token: string, expires: number }|null} */
  let cached = null;

  async function accessToken() {
    // Reused until nearly expired: an OAuth round trip per notification doubles its latency.
    if (cached && cached.expires > now() + 60_000) return cached.token;
    const iat = Math.floor(now() / 1000);
    const jwt = await signJwtRS256(
      {
        iss: serviceAccount.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat,
        exp: iat + 3600,
      },
      serviceAccount.private_key,
    );
    const res = await doFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    });
    if (!res.ok) throw new Error(`FCM token exchange failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = /** @type {any} */ (await res.json());
    cached = { token: body.access_token, expires: now() + (body.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  return {
    async send(devices, message) {
      if (!devices.length) return { sent: 0, dead: [] };
      const token = await accessToken();
      const url = `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`;
      let sent = 0;
      /** @type {string[]} */
      const dead = [];

      // One request per device (no REST multicast), and ONE DEVICE, ONE FAILURE:
      // a bad row must not stop every device after it.
      for (const device of devices) {
        try {
          const wire = device.wire ?? (await envelopeFor(device, message, { now, seal }));
          const category = message.category ? { category: message.category } : {};
          const wake = message.wake ? { 'content-available': 1 } : {};
          // No `notification` block when sealed (the tray would draw base64) or
          // when the app draws it (the tray block cannot carry actions); the
          // words then travel in `data`, except on the sealed path.
          const appDraws = Boolean(message.category || message.drawnByApp);
          const forTheApp = appDraws && !wire.encrypted ? { title: wire.title, body: wire.body } : {};
          const collapse = collapseOf(wire, message);
          const payload = {
            message: {
              token: device.token,
              ...(wire.encrypted || appDraws ? {} : { notification: { title: wire.title, body: wire.body } }),
              data: { ...wire.data, ...category, ...forTheApp },
              android: {
                // HIGH is what wakes a data-only message through Doze.
                priority: 'HIGH',
                ttl: `${PUSH_TTL_S}s`,
                ...(collapse ? { collapse_key: String(collapse) } : {}),
              },
              apns: {
                // The alert still rides on the sealed branch: iOS needs something to
                // show if the extension fails, and mutable-content is what runs it.
                payload: wire.encrypted
                  ? { aps: { alert: { title: wire.title, body: wire.body }, sound: 'default', 'mutable-content': 1, ...category, ...wake } }
                  : { aps: { sound: 'default', ...category, ...wake } },
              },
            },
          };
          const res = await doFetch(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (res.ok) {
            sent++;
            continue;
          }
          const text = (await res.text()).slice(0, 300);
          if (res.status === 404 || /UNREGISTERED/i.test(text)) {
            // Uninstalled or replaced: broken for good, so reported rather than retried.
            dead.push(device.token);
            log.warn(`push: dropping dead token (${res.status})`);
            await reportDead(device.token, device.platform);
          } else if (/INVALID_ARGUMENT/i.test(text)) {
            // NOT dead: this is what a raw APNs token looks like to FCM, and
            // deleting it would silently unregister the phone.
            log.warn(
              `push: FCM rejected the ${device.platform} token as INVALID_ARGUMENT — keeping the registration.\n` +
                '  This is what an APNs device token looks like to FCM. An iOS app has to post the token from\n' +
                '  the Firebase SDK (Messaging.messaging().token), or be routed to apnsPusher instead.',
            );
          } else {
            log.warn(`push: FCM ${res.status} ${text}`);
          }
        } catch (err) {
          log.warn(`push: a ${device.platform} device was skipped — ${errorText(err)}`);
        }
      }
      return { sent, dead };
    },
  };
}

/**
 * @typedef {(token: string, payload: string, headers: Record<string, string>)
 *   => Promise<{ status: number, body: string }>} Deliver
 */

/**
 * Apple Push Notification service, directly, with a .p8 key.
 *
 * APNs requires HTTP/2: a Worker's fetch negotiates it, Node's does not, so
 * Node callers inject `deliver` (e.g. over node:http2).
 *
 * @param {{ keyId: string, teamId: string, bundleId: string, privateKey: string, production?: boolean }} config
 * @param {SenderOptions & { deliver?: Deliver }} [opts]
 * @returns {Pusher}
 */
export function apnsPusher(config, { deliver, logger, now = () => Date.now(), seal, onDead, collapseKey } = {}) {
  const log = logger || QUIET;
  const host = config.production === false ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const send = deliver || fetchDeliver(host);
  const reportDead = deadReporter(onDead, log);
  const collapseOf = collapseKey || ((/** @type {Wire} */ _w, /** @type {PushMessage} */ m) => m.collapseKey);
  /** @type {{ token: string, made: number }|null} */
  let cached = null;

  async function bearer() {
    // Apple rejects a token older than an hour and throttles minting more often than every 20 minutes.
    if (cached && now() - cached.made < 30 * 60_000) return cached.token;
    const token = await signJwtES256({ iss: config.teamId, iat: Math.floor(now() / 1000) }, config.privateKey, config.keyId);
    cached = { token, made: now() };
    return token;
  }

  return {
    async send(devices, message) {
      if (!devices.length) return { sent: 0, dead: [] };
      const authorization = `bearer ${await bearer()}`;
      let sent = 0;
      /** @type {string[]} */
      const dead = [];
      for (const device of devices) {
        try {
          const wire = device.wire ?? (await envelopeFor(device, message, { now, seal }));
          const collapse = collapseOf(wire, message);
          const payload = JSON.stringify({
            aps: {
              alert: { title: wire.title, body: wire.body },
              sound: 'default',
              // mutable-content is what runs the extension that opens the envelope.
              ...(wire.encrypted ? { 'mutable-content': 1 } : {}),
              ...(message.category ? { category: message.category } : {}),
              ...(message.wake ? { 'content-available': 1 } : {}),
            },
            ...wire.data,
          });
          const res = await send(device.token, payload, {
            authorization,
            'apns-topic': config.bundleId,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            // Seconds since the epoch: Apple drops it rather than delivering it stale.
            'apns-expiration': String(Math.floor(now() / 1000) + PUSH_TTL_S),
            ...(collapse ? { 'apns-collapse-id': String(collapse).slice(0, 64) } : {}),
          });
          if (res.status === 200) {
            sent++;
            continue;
          }
          // 410 is the app gone; BadDeviceToken is usually a sandbox token sent to production.
          if (res.status === 410 || /BadDeviceToken|Unregistered/i.test(res.body)) {
            dead.push(device.token);
            log.warn(`push: dropping dead APNs token (${res.status} ${res.body.slice(0, 80)})`);
            await reportDead(device.token, device.platform);
          } else {
            log.warn(`push: APNs ${res.status} ${res.body.slice(0, 200)}`);
          }
        } catch (err) {
          log.warn(`push: a ${device.platform} device was skipped — ${errorText(err)}`);
        }
      }
      return { sent, dead };
    },

    // Live Activities need their own push type AND topic suffix; Apple refuses
    // the bare bundle id and never delivers an `alert` to an activity token.
    async activity(tokens, update) {
      if (!tokens.length) return { sent: 0, dead: [] };
      const authorization = `bearer ${await bearer()}`;
      const nowS = Math.floor(now() / 1000);
      const payload = JSON.stringify({
        aps: {
          timestamp: nowS,
          event: update.event,
          'content-state': update.state,
          ...(update.event === 'end' && update.dismissAt ? { 'dismissal-date': Math.floor(update.dismissAt / 1000) } : {}),
        },
      });
      let sent = 0;
      /** @type {string[]} */
      const dead = [];
      for (const token of tokens) {
        try {
          const res = await send(token, payload, {
            authorization,
            'apns-topic': `${config.bundleId}.push-type.liveactivity`,
            'apns-push-type': 'liveactivity',
            'apns-priority': update.priority === 5 ? '5' : '10',
            'apns-expiration': String(nowS + PUSH_TTL_S),
          });
          if (res.status === 200) {
            sent++;
            continue;
          }
          if (res.status === 410 || /BadDeviceToken|Unregistered|ExpiredToken/i.test(res.body)) {
            dead.push(token);
            await reportDead(token, 'ios');
          } else {
            log.warn(`push: APNs live activity ${res.status} ${res.body.slice(0, 200)}`);
          }
        } catch (err) {
          log.warn(`push: a live activity update was skipped — ${errorText(err)}`);
        }
      }
      return { sent, dead };
    },
  };
}

/**
 * The default APNs transport: fetch, which is HTTP/2 on Workers. The token is
 * one encoded path segment, so `../` or `#` in a stored row cannot address
 * another phone.
 *
 * @param {string} host
 * @returns {Deliver}
 */
function fetchDeliver(host) {
  return async (token, payload, headers) => {
    const res = await fetch(`https://${host}/3/device/${encodeURIComponent(token)}`, { method: 'POST', headers, body: payload });
    return { status: res.status, body: await res.text() };
  };
}

/**
 * Send each device to the service that can reach it: an APNs token means
 * nothing to FCM and the other way round. Web devices go to `web` when given,
 * otherwise to `other`.
 *
 * @param {{ ios?: Pusher, web?: Pusher, other?: Pusher, logger?: { warn: Function } }} senders
 * @returns {Pusher}
 */
export function routingPusher({ ios, web, other, logger }) {
  const log = logger || QUIET;
  return {
    async send(devices, message) {
      const groups = [
        { pusher: ios, devices: devices.filter((d) => d.platform === 'ios') },
        { pusher: web, devices: web ? devices.filter((d) => d.platform === 'web') : [] },
        { pusher: other, devices: devices.filter((d) => d.platform !== 'ios' && !(web && d.platform === 'web')) },
      ];
      let sent = 0;
      /** @type {string[]} */
      const dead = [];
      for (const group of groups) {
        if (!group.pusher || !group.devices.length) continue;
        // One platform's sender throwing must not stop the others.
        try {
          const r = await group.pusher.send(group.devices, message);
          sent += r.sent;
          dead.push(...r.dead);
        } catch (err) {
          log.warn(`push: the ${group.devices[0]?.platform} sender failed — ${errorText(err)}`);
        }
      }
      return { sent, dead };
    },
    async activity(tokens, update) {
      if (!ios?.activity) return { sent: 0, dead: [] };
      try {
        return await ios.activity(tokens, update);
      } catch (err) {
        log.warn(`push: the live activity sender failed — ${errorText(err)}`);
        return { sent: 0, dead: [] };
      }
    },
  };
}

/**
 * A service account from an environment variable, as raw JSON or base64 of
 * it. Base64 always survives: a systemd EnvironmentFile turns the `\n` in
 * private_key into real newlines, which breaks raw JSON.
 *
 * @param {string} raw
 * @returns {any|null}
 */
export function parseServiceAccount(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  try {
    const binary = atob(trimmed.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * `1`, `true`, `yes`, `on`; anything else, including "0" and "false", is off.
 *
 * @param {string|undefined} value
 */
export function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

/** @param {unknown} err */
export function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}
