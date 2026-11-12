# shipkit

Reusable iOS and Android release workflows, a store-release CLI, an Expo config
plugin and a zero-dependency push sender, extracted from
[Fleetwright](https://github.com/TheTechNetwork/Fleetwright)'s release pipeline.
Fleetwright, Forked and any other app can share them.

| Module | What it is |
|---|---|
| [`.github/workflows/ios-release.yml`](.github/workflows/ios-release.yml) | Reusable workflow: simulator tests (optional), then archive, sign manually and upload to App Store Connect. If credentials are missing it skips with a warning. |
| [`.github/workflows/android-release.yml`](.github/workflows/android-release.yml) | Reusable workflow: signed APK and AAB, optionally attached to the GitHub release and published to a Play track. If credentials are missing it skips with a warning. |
| [`actions/ios-simulator-test`](actions/ios-simulator-test/action.yml) | Composite action: picks a simulator at run time, runs `xcodebuild test`, and fails unless at least one test ran. |
| [`@thetechnetwork/worker-push`](packages/worker-push) | APNs, FCM and Web Push senders for Cloudflare Workers and Node 20+, plus sealed payloads. No dependencies. |
| [`@thetechnetwork/store-ship`](packages/store-ship) | `store-ship` CLI: TestFlight distribution, App Store submission, Play tracks and provisioning profiles. Depends only on worker-push. |
| [`@thetechnetwork/expo-shipkit-plugin`](packages/expo-shipkit-plugin) | Expo (SDK 58) config plugin that makes `expo prebuild` produce projects these workflows can sign and number. |

## Install

Each release attaches the packages as tarballs, so installing needs no registry login:

```sh
npm i https://github.com/TheTechNetwork/shipkit/releases/download/v0.1.1/thetechnetwork-worker-push-0.1.1.tgz
npm i -D https://github.com/TheTechNetwork/shipkit/releases/download/v0.1.1/thetechnetwork-store-ship-0.1.1.tgz
npm i -D https://github.com/TheTechNetwork/shipkit/releases/download/v0.1.1/thetechnetwork-expo-shipkit-plugin-0.1.1.tgz
```

Once on npm (see "Publishing" below), install by name instead: `npm i @thetechnetwork/worker-push`.
The release tarballs stay attached to every GitHub release as a no-registry fallback.

The workflows are used as `TheTechNetwork/shipkit/.github/workflows/<file>@v0.1.1`.
Each one also checks out shipkit at its `shipkit-ref` input (default `v0.1.1`) to
get its helper actions and `store-ship`. Keep that ref the same as the one in `uses:`.

## iOS: `ios-release.yml`

Fleetwright (XcodeGen, two extensions):

```yaml
jobs:
  ios:
    uses: TheTechNetwork/shipkit/.github/workflows/ios-release.yml@v0.1.1
    with:
      xcode-version: '27.2'
      brew-packages: xcodegen
      app-directory: apps/ios
      prepare-command: xcodegen generate
      working-directory: apps/ios
      project: Fleetwright.xcodeproj
      scheme: Fleetwright
      bundle-id: network.thetech.fleetwright
      team-id: ${{ vars.APPLE_TEAM_ID }}
      simulator-test: true
      simulator: '^iPhone Duo$'
      extensions: >-
        [{"bundle_id": "network.thetech.fleetwright.Activity", "suffix": "ACTIVITY",
          "profile_name": "Fleetwright Activity Profile", "bundle_name": "Fleetwright Activity"},
         {"bundle_id": "network.thetech.fleetwright.Push", "suffix": "PUSH",
          "profile_name": "Fleetwright Push Profile", "bundle_name": "Fleetwright Push",
          "keychain_group": "network.thetech.fleetwright"}]
    secrets: inherit
```

Expo with CocoaPods (Forked):

```yaml
jobs:
  ios:
    uses: TheTechNetwork/shipkit/.github/workflows/ios-release.yml@v0.1.1
    with:
      pnpm-version: '10.34.9'
      app-directory: apps/mobile
      prepare-command: pnpm install --frozen-lockfile && pnpm exec expo prebuild --platform ios --clean
      working-directory: apps/mobile/ios
      workspace: Forked.xcworkspace
      scheme: Forked
      bundle-id: com.example.forked
      team-id: ${{ vars.APPLE_TEAM_ID }}
    secrets: inherit
```

Inputs: `runner` (default `xcode-27`), `xcode-version`, `node-version` (24),
`pnpm-version`, `brew-packages`, `app-directory`, `prepare-command`,
`working-directory`, `project` **or** `workspace`, `scheme`, `configuration`
(Release), `bundle-id`, `team-id`, `extensions` (JSON, see the workflow),
`app-profile-variable`, `marketing-version`, `build-number` (default the run
number), `upload` (true; false exports an `.ipa` artifact instead),
`simulator-test`, `simulator` (name regex), `shipkit-ref`.
Outputs: `build-number`, `archive-path`, `uploaded`.

**The gate.** A cheap ubuntu job checks for `ASC_KEY_ID`, `ASC_ISSUER_ID`,
`ASC_KEY_P8`, `APPLE_DIST_P12`, `APPLE_PROVISIONING_PROFILE` and the `team-id`
input. If any of them is missing, it prints a warning that names them, never
starts a macOS runner, and sets `uploaded` to `false`. It never falls back to
automatic signing. With automatic signing, a fresh runner mints a distribution
certificate on every run until Apple's per-team cap is reached.

### iOS signing contract

Every target gets these settings on the `xcodebuild archive` command line:
`DEVELOPMENT_TEAM`, `CODE_SIGN_STYLE=Manual`, `CODE_SIGN_IDENTITY="Apple Distribution"`,
`CURRENT_PROJECT_VERSION=<build>`, and `MARKETING_VERSION` when it is set.
`-allowProvisioningUpdates` is never passed.

**`PROVISIONING_PROFILE_SPECIFIER` is never set globally.** It would reach every
Pods target, and CocoaPods targets refuse a profile. The workflow passes each
profile's *name* as a variable instead, and each target maps it to its own specifier:

| Variable | Holds | Who maps it |
|---|---|---|
| `SHIPKIT_IOS_PROFILE_APP` (or `app-profile-variable`) | the app's profile name, read out of `APPLE_PROVISIONING_PROFILE` | the app target |
| `SHIPKIT_IOS_PROFILE_<SUFFIX>` (or the extension's `variable`) | the extension profile that `store-ship ensure-ios-extension-profile` fetched or made | that extension's target |
| `SHIPKIT_TEAM_ID`, `SHIPKIT_BUILD_NUMBER`, `SHIPKIT_MARKETING_VERSION` | the inputs | the Expo plugin, at prebuild |

These names reach the project in two ways: as build settings on the xcodebuild
command line, and as environment variables before `prepare-command` runs, so
that `expo prebuild` can read them.

- **XcodeGen / plain projects:** on each target, set
  `PROVISIONING_PROFILE_SPECIFIER: $(SHIPKIT_IOS_PROFILE_APP)`, or
  `$(SHIPKIT_IOS_PROFILE_PUSH)` and so on. Locally the variable is empty, so
  automatic signing behaves as it did before. Fleetwright's targets currently
  read `$(FLEETWRIGHT_APP_PROFILE)`, `$(FLEETWRIGHT_ACTIVITY_PROFILE)` and
  `$(FLEETWRIGHT_PUSH_PROFILE)`. It can rename them, or keep them by passing
  `app-profile-variable: FLEETWRIGHT_APP_PROFILE` and a `"variable"` on each extension.
- **Expo:** add `@thetechnetwork/expo-shipkit-plugin`. It writes the
  `$(SHIPKIT_IOS_PROFILE_APP)` reference onto the app target, and onto any
  extension targets you list. When the variables are set at prebuild time, it
  also sets the literal Release values and points Info.plist's version fields at
  `$(CURRENT_PROJECT_VERSION)` / `$(MARKETING_VERSION)`.

### Simulator tests only

```yaml
- uses: TheTechNetwork/shipkit/actions/ios-simulator-test@v0.1.1
  with:
    working-directory: apps/ios
    project: Fleetwright.xcodeproj
    scheme: Fleetwright
    prefer: '^iPhone Duo$'
```

The simulator is chosen at run time: the first available one whose name matches
`prefer`, otherwise any iPhone. The test runs unsigned
(`CODE_SIGNING_ALLOWED=NO`). The action fails unless xcodebuild reports
`Executed N tests` with N > 0, because `xcodebuild test` exits 0 even when the
bundle contains no tests.

## Android: `android-release.yml`

```yaml
jobs:
  android:
    uses: TheTechNetwork/shipkit/.github/workflows/android-release.yml@v0.1.1
    permissions:
      contents: write   # only for attach-to-release
    with:
      working-directory: apps/android
      sdk-packages: 'platform-tools platforms;android-37.1 build-tools;37.0.0'
      attach-to-release: ${{ github.event_name == 'release' }}
      publish: true
      package-name: network.thetech.fleetwright
      commit-track: ${{ vars.PLAY_COMMIT_TRACK || 'beta' }}
      release-track: ${{ vars.PLAY_RELEASE_TRACK || 'production' }}
      rollout: ${{ vars.PLAY_ROLLOUT }}
    secrets: inherit
```

For Expo, use `app-directory: apps/mobile`,
`prepare-command: npm ci && npx expo prebuild --platform android --clean` and
`working-directory: apps/mobile/android`.

Inputs: `runner`, `jdk` (25), `jdk-distribution`, `sdk-packages`,
`node-version`, `pnpm-version`, `app-directory`, `prepare-command`,
`working-directory`, `module` (`app`), `gradle-tasks`
(`assembleRelease bundleRelease`), `version-code` (default the run number),
`attach-to-release`, `release-tag`, `publish`, `package-name`, `track`,
`commit-track`, `release-track`, `rollout`, `release-notes`, `artifact-prefix`,
`shipkit-ref`. Outputs: `built`, `version-code`, `published`.

The track depends on the event. A push, a dispatch or a prerelease goes to
`commit-track`; only a published, non-prerelease GitHub release goes to
`release-track`. `rollout` applies on the release track only. Leave it empty to
ship to the whole track: a staged rollout has to be finished by hand in the Play Console.

The workflow sets no `permissions` of its own, because a called workflow cannot
raise them. If you use `attach-to-release`, the calling job must grant
`contents: write`.

### Android env contract

Gradle runs with these environment variables:

| Variable | Value |
|---|---|
| `ANDROID_KEYSTORE_FILE` | `$RUNNER_TEMP/release.jks`, decoded from `ANDROID_KEYSTORE_BASE64` |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | the secrets |
| `ANDROID_VERSION_CODE` | `version-code`, default the run number (Play refuses a code it has seen) |

The Expo plugin handles Groovy `build.gradle` files. A Kotlin DSL app reads the
variables itself, as Fleetwright's `app/build.gradle.kts` already does:

```kotlin
versionCode = providers.environmentVariable("ANDROID_VERSION_CODE").orNull?.toInt() ?: 1
val keystore = providers.environmentVariable("ANDROID_KEYSTORE_FILE").orNull
if (!keystore.isNullOrBlank()) signingConfigs.create("release") {
  storeFile = file(keystore)
  storePassword = providers.environmentVariable("ANDROID_KEYSTORE_PASSWORD").orNull
  keyAlias = providers.environmentVariable("ANDROID_KEY_ALIAS").orNull
  keyPassword = providers.environmentVariable("ANDROID_KEY_PASSWORD").orNull
}
```

After the build, the workflow runs `apksigner` on each APK and fails if it was
signed with the debug key.

## Secrets

Set these on the calling repository or organisation and pass them with
`secrets: inherit` (or name them one by one). None of them is required: the
workflows skip with a warning when they are missing.

| Secret | Used by | What it is |
|---|---|---|
| `ASC_KEY_ID` | iOS, store-ship | App Store Connect API key id |
| `ASC_ISSUER_ID` | iOS, store-ship | its issuer id |
| `ASC_KEY_P8` | iOS, store-ship | the `.p8` as **raw PEM**, not base64. Extension profiles need the Admin role, or App Manager with profile access |
| `APPLE_DIST_P12` | iOS | base64 of the Apple Distribution certificate and key. Export it with `openssl pkcs12 -export -legacy …`, because macOS cannot read OpenSSL 3's defaults and reports "MAC verification failed" |
| `APPLE_DIST_P12_PASSWORD` | iOS | its password, with no trailing newline |
| `APPLE_PROVISIONING_PROFILE` | iOS | base64 of the app's App Store `.mobileprovision` |
| `ANDROID_KEYSTORE_BASE64` | Android | base64 of the upload keystore (`.jks`) |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Android | its passwords and alias |
| `PLAY_SERVICE_ACCOUNT_JSON` | Android publish | service account JSON (or base64 of it), invited in the Play Console with "Release to testing tracks" on the app |
| `NPM_TOKEN` | shipkit's own release | optional; publishes the packages to npm once the scope is claimed |

`team-id` is an input, not a secret, because a called workflow cannot read the
caller's `vars`. Pass `${{ vars.APPLE_TEAM_ID }}`.

Distribution after an upload uses `store-ship` in a job of your own, on ubuntu:

```yaml
  testflight:
    needs: ios
    if: needs.ios.outputs.uploaded == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v7.1.0
        with: { node-version: '24' }
      - run: npx -y https://github.com/TheTechNetwork/shipkit/releases/download/v0.1.1/thetechnetwork-store-ship-0.1.1.tgz testflight-distribute
        env:
          ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}
          ASC_ISSUER_ID: ${{ secrets.ASC_ISSUER_ID }}
          ASC_KEY_P8: ${{ secrets.ASC_KEY_P8 }}
          BUNDLE_ID: network.thetech.fleetwright
          BUILD_NUMBER: ${{ needs.ios.outputs.build-number }}
          AUDIENCE: internal
```

## `@thetechnetwork/worker-push`

```js
import { pusherFromEnv, webPusher } from '@thetechnetwork/worker-push';

export default {
  async fetch(req, env) {
    const push = pusherFromEnv(env, {
      seal: { info: 'forked-push-v1', title: 'Forked', body: 'You have a match. Open to see.' },
      onDead: (token) => env.DB.prepare('DELETE FROM devices WHERE token = ?').bind(token).run(),
    });
    await push.send(devices, { title: 'It’s a match', body: 'You and Sam both said yes', collapseKey: 'match-42' });
  },
};
```

- `apnsPusher`, `fcmPusher`, `webPusher` and `routingPusher` all have the shape
  `send(devices, message) → { sent, dead }`. Each device is
  `{ token, platform, pushKey?, subscription? }`. iOS devices go to APNs, `web`
  devices go to Web Push when that sender is configured, and everything else
  goes to FCM. Every token that comes back dead is also passed to `onDead`.
- **Web Push** implements RFC 8291 encryption (`aes128gcm`) and RFC 8292 VAPID.
  Its tests reproduce the RFC 8291 Appendix A example byte for byte. A web
  device's subscription is `device.subscription`, or the token parsed as JSON.
- **Sealed payloads**: when a device registers a P-256 `pushKey`, the message is
  encrypted with ECDH P-256 → HKDF-SHA256 → AES-256-GCM, and APNs and FCM carry
  only `seal.title` / `seal.body`. `seal.info` is required and must match the
  app. Fleetwright's is `fleetwright-push-v1`, and a test opens the envelope
  Fleetwright's phones commit.
- `pusherFromEnv(env, { prefix })` reads `<prefix>PUSH` (the on switch: nothing is
  sent without it), `<prefix>APNS_KEY`, `_APNS_KEY_ID`, `_APNS_TEAM_ID`,
  `_APNS_BUNDLE_ID`, `_APNS_SANDBOX`, `<prefix>FCM_SERVICE_ACCOUNT`, and
  `<prefix>VAPID_PUBLIC_KEY`, `_VAPID_PRIVATE_KEY`, `_VAPID_SUBJECT`. Fleetwright passes:

  ```js
  pusherFromEnv(env, {
    prefix: 'FLEETWRIGHT_', logger, apnsDeliver, defaultBundleId: 'network.thetech.fleetwright',
    seal: { info: 'fleetwright-push-v1', title: 'Fleetwright', body: 'Something needs you. Open to see.' },
    collapseKey: (wire) => wire.data.name,
    fallback: (env) => { const relay = relayFromEnv(env); return relay && relayPusher(relay, { logger }); },
    fallbackHint: 'The relay needs FLEETWRIGHT_RELAY_URL, _FLEET and _SECRET.',
  });
  ```
- In Node, APNs needs an HTTP/2 transport (`apnsDeliver`, e.g. over `node:http2`).
  A Worker's `fetch` already speaks HTTP/2.

## `@thetechnetwork/store-ship`

```sh
store-ship <command> [--setting value ...]   # --bundle-id x is the same as BUNDLE_ID=x
store-ship <command> --help                   # lists every setting
```

| Command | Does |
|---|---|
| `testflight-distribute` | Waits for processing, writes "What to Test", and hands the build to an internal group (no assignment needed) or an external group (assigned and submitted for beta review) |
| `appstore-release` | Finds, renames or creates the App Store version from the build's version train, attaches the build, writes the listing (`STORE_LISTING`), screenshots (`SCREENSHOTS_DIR`) and App Review details, then submits through `reviewSubmissions` |
| `appstore-screenshots` | Uploads screenshots to an existing version |
| `play-release` | Uploads an `.aab` to a Play track in one edit (`PLAY_TRACK`, `PLAY_ROLLOUT`, `RELEASE_NOTES`) |
| `recreate-ios-profile` | Deletes and recreates an App Store profile bound to every valid distribution certificate |
| `ensure-ios-extension-profile` | Registers the bundle id if needed, reuses a good profile or creates one, and writes it to `OUT` |
| `store-listing` | Parses and checks a listing document |

No command ever creates a certificate. A processing build that is still not
ready after `POLL_TIMEOUT_MS` produces a warning, not a failure.

**Store listing.** The listing is a Markdown file. Each field is the *first*
fenced block under its `## ` heading: `App name`, `Short description`,
`Full description`, `App Store description`, `Keywords`, `Support URL`,
`Privacy policy URL`, `Copyright`. A missing block is an error that names it,
and so is any field over its limit. Fleetwright's `apps/store-listing.md` has
this format.

**The once-ever checklist** covers what the API cannot decide for you. Do these
by hand in App Store Connect before the first `appstore-release`:

1. Create the app record.
2. Set its primary category.
3. Answer the age rating questionnaire and the privacy questions.
4. Have one build processed.

On Play, upload the first bundle by hand so that the package exists.

## `@thetechnetwork/expo-shipkit-plugin`

```json
{ "expo": { "plugins": [["@thetechnetwork/expo-shipkit-plugin", { "extensions": [{ "target": "NotificationService", "suffix": "PUSH" }] }]] } }
```

See [its README](packages/expo-shipkit-plugin/README.md) for exactly what it
changes. It runs after Expo's own mods, and running it twice gives the same result.

## What is and is not verified

- **Package tests run in CI on Node 20, 22 and 24:** worker-push, store-ship
  (against a fake App Store Connect and Play) and the Expo plugin, which is run
  through Expo's `compileModsAsync` on the SDK 58 template's real files. CI also
  installs the packed tarballs into an empty project and uses them.
- **The workflows** are checked by actionlint, with shellcheck on every `run:`
  script. A CI job also calls both of them with no secrets and asserts that they
  skip without failing. No real Apple or Google credentials have been through
  them: the signing, upload and Play steps follow Fleetwright's working
  pipeline, but they have not yet run from here.

## Development

```sh
npm ci && npm test        # every package, then the repository checks in test/
actionlint                # https://github.com/rhysd/actionlint
```

`packages/store-ship/src/jwt.js` is a copy of `packages/worker-push/src/jwt.js`.
The copy keeps the store-ship tarball installable on its own, and a test fails
if the two files drift apart.

## License

MIT © thetechnetwork

## Publishing

Tags `v*` run `release.yml`: test, pack, attach tarballs to the GitHub release, then `npm publish --provenance` for any package version npm doesn't have yet.

CI authenticates with npm **trusted publishing** (GitHub OIDC): only this workflow can publish, and no npm token is stored. Setup, once per package, by a maintainer logged in to npm:

```sh
for p in worker-push store-ship expo-shipkit-plugin; do
  npm trust github @thetechnetwork/$p --repo TheTechNetwork/shipkit --file release.yml --allow-publish
done
```
