# @thetechnetwork/worker-push

APNs, FCM and Web Push senders, with payloads sealed to the device. Zero
dependencies; WebCrypto and `fetch` only, so it runs unchanged in Cloudflare
Workers and Node 20+.

```sh
npm i https://github.com/TheTechNetwork/shipkit/releases/download/v0.1.0/thetechnetwork-worker-push-0.1.0.tgz
```

| Export | |
|---|---|
| `apnsPusher(config, opts)` | APNs with a `.p8` (ES256 token cached 30 min); 410 / BadDeviceToken → dead; Live Activity updates |
| `fcmPusher(serviceAccount, opts)` | FCM HTTP v1; UNREGISTERED → dead, INVALID_ARGUMENT kept (an APNs token sent to FCM) |
| `webPusher(vapid, opts)` | Web Push, RFC 8291 `aes128gcm` + RFC 8292 VAPID; 404/410 → dead |
| `routingPusher({ ios, web, other })` | each device to the service that can reach it; one failing sender never stops another |
| `pusherFromEnv(env, { prefix, ... })` | whichever of the above the environment configures, off unless `<prefix>PUSH` is on |
| `sealTo` / `openWith` / `checkPublicKey` | ECDH P-256 → HKDF-SHA256 → AES-256-GCM envelope; `info` required |
| `encryptWebPush` / `decryptWebPush` / `vapidAuthorization` | the Web Push primitives |
| `signJwtES256` / `signJwtRS256` / `pemToBytes` | the JWT signers (also at `@thetechnetwork/worker-push/jwt`) |

Every sender takes `{ logger, now, seal, onDead, collapseKey }`. `onDead(token, platform)`
is called once per dead token, and the token is also returned in `dead`.
See the [shipkit README](../../README.md#thetechnetworkworker-push) for examples.
