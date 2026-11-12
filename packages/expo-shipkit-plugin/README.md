# @thetechnetwork/expo-shipkit-plugin

An Expo config plugin (SDK 58) that makes `expo prebuild` produce native projects
shipkit's `ios-release.yml` and `android-release.yml` can sign and number.

```sh
npm i https://github.com/TheTechNetwork/shipkit/releases/download/v0.1.1/thetechnetwork-expo-shipkit-plugin-0.1.1.tgz
```

```json
{
  "expo": {
    "plugins": [
      ["@thetechnetwork/expo-shipkit-plugin", {
        "extensions": [{ "target": "NotificationService", "suffix": "PUSH" }]
      }]
    ]
  }
}
```

Options: `extensions` (each a native target name and the suffix of its profile
variable), `ios: false` / `android: false` to skip a platform.

## What it changes

**iOS**, on the app target and each listed extension target only — never Pods,
which refuse a provisioning profile:

- every configuration: `PROVISIONING_PROFILE_SPECIFIER = $(SHIPKIT_IOS_PROFILE_APP)`
  (or `$(SHIPKIT_IOS_PROFILE_<SUFFIX>)`). Unset locally, so automatic signing is unchanged.
- when `SHIPKIT_IOS_PROFILE_*` is set at prebuild time (CI), the Release
  configuration gets the literal profile name, `CODE_SIGN_STYLE = Manual`,
  `CODE_SIGN_IDENTITY = Apple Distribution`, and `DEVELOPMENT_TEAM = $SHIPKIT_TEAM_ID`.
- the app target's `CURRENT_PROJECT_VERSION` / `MARKETING_VERSION` come from
  `SHIPKIT_BUILD_NUMBER` / `SHIPKIT_MARKETING_VERSION`, else `ios.buildNumber` / `version`;
  Info.plist's `CFBundleVersion` / `CFBundleShortVersionString` reference them, so
  xcodebuild's `CURRENT_PROJECT_VERSION=` override reaches the binary.

**Android**, in `android/app/build.gradle` (Groovy; a Kotlin DSL file is refused):

- a `release` signing config, declared only when `ANDROID_KEYSTORE_FILE` is set,
  and `buildTypes.release` uses it then, falling back to what it used before;
- `versionCode` / `versionName` read `ANDROID_VERSION_CODE` / `ANDROID_VERSION_NAME`,
  falling back to `android.versionCode` / `version`.

The changes are idempotent: prebuilding twice gives the same files.

## Environment

| Variable | Read at | Set by |
|---|---|---|
| `SHIPKIT_TEAM_ID` | prebuild | ios-release.yml (`team-id` input) |
| `SHIPKIT_IOS_PROFILE_APP` | prebuild, and xcodebuild as a build setting | ios-release.yml (the installed profile's name) |
| `SHIPKIT_IOS_PROFILE_<SUFFIX>` | prebuild, and xcodebuild | ios-release.yml (`extensions` input) |
| `SHIPKIT_BUILD_NUMBER` | prebuild | ios-release.yml (`build-number`, default the run number) |
| `SHIPKIT_MARKETING_VERSION` | prebuild | ios-release.yml (`marketing-version`, optional) |
| `ANDROID_KEYSTORE_FILE` | Gradle | android-release.yml (decoded `ANDROID_KEYSTORE_BASE64`) |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Gradle | android-release.yml (secrets) |
| `ANDROID_VERSION_CODE` | Gradle | android-release.yml (default the run number) |
| `ANDROID_VERSION_NAME` | Gradle | optional |

Extension Info.plists are not edited; give their `CFBundleVersion` the
`$(CURRENT_PROJECT_VERSION)` reference yourself if they need to match the app.
