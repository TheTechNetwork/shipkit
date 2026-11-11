// The mods, on the real Expo SDK 58 template files (expo-template-bare-minimum
// 58.0.33), both as pure transforms and run through Expo's own mod compiler.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const xcode = require('xcode');
const { compileModsAsync } = require('@expo/config-plugins/build/plugins/mod-compiler');
const plist = require('@expo/plist').default;

const plugin = require('../app.plugin.js');
const { applyAndroidSigning, applyIosSigning, applyInfoPlist, profileVar } = plugin;

const FIX = path.join(__dirname, 'fixtures');
const GRADLE = fs.readFileSync(path.join(FIX, 'build.gradle'), 'utf8');
const PBXPROJ = path.join(FIX, 'project.pbxproj');
const ENV_KEYS = ['SHIPKIT_TEAM_ID', 'SHIPKIT_IOS_PROFILE_APP', 'SHIPKIT_IOS_PROFILE_PUSH', 'SHIPKIT_BUILD_NUMBER', 'SHIPKIT_MARKETING_VERSION'];

/** The template project, with a notification service extension added beside the app. */
function projectWithExtension() {
  const project = xcode.project(PBXPROJ);
  project.parseSync();
  project.addTarget('NotificationService', 'app_extension', 'NotificationService', 'com.helloworld.NotificationService');
  return project;
}

/** buildSettings of every XCBuildConfiguration, by uuid, as a deep copy. @param {any} project */
function allSettings(project) {
  const section = project.pbxXCBuildConfigurationSection();
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(section)) if (!k.endsWith('_comment')) out[k] = JSON.parse(JSON.stringify(v.buildSettings));
  return out;
}

/** {Debug, Release} buildSettings of the named target. @param {any} project @param {string} name */
function targetSettings(project, name) {
  const targets = project.pbxNativeTargetSection();
  const target = Object.values(targets).find((t) => typeof t === 'object' && String(t.name).replace(/"/g, '') === name);
  const list = project.pbxXCConfigurationList()[target.buildConfigurationList];
  /** @type {Record<string, any>} */
  const out = {};
  for (const { value } of list.buildConfigurations) {
    const cfg = project.pbxXCBuildConfigurationSection()[value];
    out[String(cfg.name).replace(/"/g, '')] = cfg.buildSettings;
  }
  return out;
}

/** The uuids of the named target's configurations. @param {any} project @param {string} name */
function targetConfigIds(project, name) {
  const targets = project.pbxNativeTargetSection();
  const target = Object.values(targets).find((t) => typeof t === 'object' && String(t.name).replace(/"/g, '') === name);
  return project.pbxXCConfigurationList()[target.buildConfigurationList].buildConfigurations.map((/** @type {any} */ c) => c.value);
}

/** @param {Record<string, string>} env @param {() => Promise<void>|void} fn */
async function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// --- Android ---------------------------------------------------------------

test('android: release signing is declared only when a keystore is in the environment', () => {
  const out = applyAndroidSigning(GRADLE);
  assert.match(out, /if \(System\.getenv\('ANDROID_KEYSTORE_FILE'\)\) \{\n\s+release \{/);
  assert.match(out, /storeFile file\(System\.getenv\('ANDROID_KEYSTORE_FILE'\)\)/);
  assert.match(out, /storePassword System\.getenv\('ANDROID_KEYSTORE_PASSWORD'\)/);
  assert.match(out, /keyAlias System\.getenv\('ANDROID_KEY_ALIAS'\)/);
  assert.match(out, /keyPassword System\.getenv\('ANDROID_KEY_PASSWORD'\)/);
  // The debug config the template ships is still there for local builds.
  assert.match(out, /debug \{\n\s+storeFile file\('debug\.keystore'\)/);
});

test('android: buildTypes.release uses the keystore when set and the old config otherwise', () => {
  const out = applyAndroidSigning(GRADLE);
  const release = out.slice(out.indexOf('buildTypes {'));
  assert.match(release, /release \{[\s\S]*?signingConfig\(System\.getenv\('ANDROID_KEYSTORE_FILE'\) \? signingConfigs\.release : signingConfigs\.debug\)/);
  // The debug build type is untouched.
  assert.match(release, /debug \{\n\s+signingConfig signingConfigs\.debug\n/);
  assert.equal(out.match(/signingConfigs\.release/g)?.length, 1);
});

test('android: versionCode and versionName read the environment, falling back to the config', () => {
  const out = applyAndroidSigning(GRADLE);
  assert.match(out, /versionCode \(\(System\.getenv\('ANDROID_VERSION_CODE'\) \?: '1'\)\.toInteger\(\)\)/);
  assert.match(out, /versionName \(System\.getenv\('ANDROID_VERSION_NAME'\) \?: "1\.0"\)/);
  const withConfig = applyAndroidSigning(GRADLE, { versionCode: 7, versionName: '2.3.4' });
  assert.match(withConfig, /\?: '7'\)\.toInteger\(\)/);
  assert.match(withConfig, /\?: "2\.3\.4"\)/);
});

test('android: applying twice is the same as applying once', () => {
  const once = applyAndroidSigning(GRADLE, { versionCode: 3, versionName: '1.2' });
  assert.equal(applyAndroidSigning(once, { versionCode: 3, versionName: '1.2' }), once);
  assert.equal(once.match(/@generated begin shipkit-release-signing/g)?.length, 1);
});

test('android: a file without signingConfigs gets one rather than failing', () => {
  const bare = 'android {\n    defaultConfig {\n        versionCode 5\n        versionName "1"\n    }\n    buildTypes {\n        release {\n        }\n    }\n}\n';
  const out = applyAndroidSigning(bare);
  assert.match(out, /signingConfigs \{\n\s+\/\/ @generated begin/);
  assert.match(out, /release \{\n\s+signingConfig\(System\.getenv\('ANDROID_KEYSTORE_FILE'\) \? signingConfigs\.release : signingConfigs\.debug\)/);
  assert.match(out, /\?: '5'\)/);
});

// --- iOS -------------------------------------------------------------------

test('ios: without CI env the app target only gains a variable reference', () => {
  const project = projectWithExtension();
  applyIosSigning(project, { env: {}, buildNumber: '3', version: '1.4' });
  const app = targetSettings(project, 'HelloWorld');
  for (const name of ['Debug', 'Release']) {
    assert.equal(app[name].PROVISIONING_PROFILE_SPECIFIER, '"$(SHIPKIT_IOS_PROFILE_APP)"');
    assert.equal(app[name].CODE_SIGN_STYLE, undefined);
    assert.equal(app[name].DEVELOPMENT_TEAM, undefined);
    assert.equal(app[name].CURRENT_PROJECT_VERSION, '3');
    assert.equal(app[name].MARKETING_VERSION, '1.4');
  }
});

test('ios: CI env bakes manual signing into Release only', () => {
  const project = projectWithExtension();
  applyIosSigning(project, {
    env: { SHIPKIT_IOS_PROFILE_APP: 'Hello Profile', SHIPKIT_TEAM_ID: 'ABCDE12345', SHIPKIT_BUILD_NUMBER: '88', SHIPKIT_MARKETING_VERSION: '2.0.1' },
  });
  const { Debug, Release } = targetSettings(project, 'HelloWorld');
  assert.equal(Release.PROVISIONING_PROFILE_SPECIFIER, '"Hello Profile"');
  assert.equal(Release.CODE_SIGN_STYLE, 'Manual');
  assert.equal(Release.CODE_SIGN_IDENTITY, '"Apple Distribution"');
  assert.equal(Release.DEVELOPMENT_TEAM, 'ABCDE12345');
  assert.equal(Debug.PROVISIONING_PROFILE_SPECIFIER, '"$(SHIPKIT_IOS_PROFILE_APP)"');
  assert.equal(Debug.CODE_SIGN_STYLE, undefined);
  assert.equal(Release.CURRENT_PROJECT_VERSION, '88');
  assert.equal(Release.MARKETING_VERSION, '2.0.1');
});

test('ios: only the app and named extension targets change, never project-level or other targets', () => {
  const project = projectWithExtension();
  const before = allSettings(project);
  applyIosSigning(project, {
    env: { SHIPKIT_IOS_PROFILE_APP: 'App P', SHIPKIT_IOS_PROFILE_PUSH: 'Push P', SHIPKIT_TEAM_ID: 'T' },
    extensions: [{ target: 'NotificationService', suffix: 'push' }],
  });
  const after = allSettings(project);
  const allowed = new Set([...targetConfigIds(project, 'HelloWorld'), ...targetConfigIds(project, 'NotificationService')]);
  const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  assert.ok(changed.length >= 4);
  for (const k of changed) assert.ok(allowed.has(k), `configuration ${k} is not the app's or the extension's`);
  const ext = targetSettings(project, 'NotificationService');
  assert.equal(ext.Release.PROVISIONING_PROFILE_SPECIFIER, '"Push P"');
  assert.equal(ext.Debug.PROVISIONING_PROFILE_SPECIFIER, '"$(SHIPKIT_IOS_PROFILE_PUSH)"');
  // The extension's version numbers are its own business; only the app's are set.
  assert.equal(ext.Release.CURRENT_PROJECT_VERSION, undefined);
});

test('ios: an extension left out of the options is left alone', () => {
  const project = projectWithExtension();
  const before = targetSettings(project, 'NotificationService');
  const snapshot = JSON.stringify(before);
  applyIosSigning(project, { env: { SHIPKIT_IOS_PROFILE_APP: 'App P' } });
  assert.equal(JSON.stringify(targetSettings(project, 'NotificationService')), snapshot);
});

test('ios: a missing extension target is an error that names it', () => {
  const project = projectWithExtension();
  assert.throws(() => applyIosSigning(project, { env: {}, extensions: [{ target: 'Nope', suffix: 'X' }] }), /"Nope"/);
});

test('ios: applying twice is the same as applying once', () => {
  const project = projectWithExtension();
  const opts = { env: { SHIPKIT_IOS_PROFILE_APP: 'A', SHIPKIT_TEAM_ID: 'T' }, extensions: [{ target: 'NotificationService', suffix: 'PUSH' }] };
  applyIosSigning(project, opts);
  const once = project.writeSync();
  applyIosSigning(project, opts);
  assert.equal(project.writeSync(), once);
});

test('ios: suffixes become SHIPKIT_IOS_PROFILE_<SUFFIX> variable names', () => {
  assert.equal(profileVar('push'), 'SHIPKIT_IOS_PROFILE_PUSH');
  assert.equal(profileVar('live-activity'), 'SHIPKIT_IOS_PROFILE_LIVE_ACTIVITY');
  assert.throws(() => profileVar('--'), /suffix/);
});

test('ios: Info.plist versions follow the build settings', () => {
  const info = plist.parse(fs.readFileSync(path.join(FIX, 'Info.plist'), 'utf8'));
  assert.equal(info.CFBundleVersion, '1');
  applyInfoPlist(info);
  assert.equal(info.CFBundleVersion, '$(CURRENT_PROJECT_VERSION)');
  assert.equal(info.CFBundleShortVersionString, '$(MARKETING_VERSION)');
});

// --- Through Expo's mod compiler ---------------------------------------------

/** A temp project holding the template's native files. */
function tempProject({ kotlin = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipkit-plugin-'));
  fs.mkdirSync(path.join(root, 'android/app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'android/app', kotlin ? 'build.gradle.kts' : 'build.gradle'), GRADLE);
  fs.mkdirSync(path.join(root, 'ios/HelloWorld.xcodeproj'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ios/HelloWorld.xcodeproj/project.pbxproj'), projectWithExtension().writeSync());
  fs.mkdirSync(path.join(root, 'ios/HelloWorld'), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'Info.plist'), path.join(root, 'ios/HelloWorld/Info.plist'));
  return root;
}

/** @param {string} root @param {any} props @param {string[]} platforms */
async function prebuild(root, props, platforms = ['ios', 'android']) {
  /** @type {any} */
  let config = { name: 'HelloWorld', slug: 'helloworld', version: '3.1.0', ios: { buildNumber: '12' }, android: { versionCode: 12 } };
  config = plugin(config, props);
  await compileModsAsync(config, { projectRoot: root, platforms, assertMissingModProviders: false });
}

test('expo mods: a local prebuild writes variable references and env-driven gradle', async () => {
  await withEnv({}, async () => {
    const root = tempProject();
    await prebuild(root, { extensions: [{ target: 'NotificationService', suffix: 'PUSH' }] });
    const gradle = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');
    assert.match(gradle, /\?: '12'\)\.toInteger\(\)/);
    assert.match(gradle, /\?: "3\.1\.0"\)/);
    assert.match(gradle, /signingConfigs\.release : signingConfigs\.debug/);
    const project = xcode.project(path.join(root, 'ios/HelloWorld.xcodeproj/project.pbxproj'));
    project.parseSync();
    const app = targetSettings(project, 'HelloWorld');
    assert.equal(app.Release.PROVISIONING_PROFILE_SPECIFIER, '"$(SHIPKIT_IOS_PROFILE_APP)"');
    assert.equal(app.Release.CODE_SIGN_STYLE, undefined);
    assert.equal(String(app.Release.CURRENT_PROJECT_VERSION), '12');
    assert.equal(app.Release.MARKETING_VERSION, '3.1.0');
    assert.equal(targetSettings(project, 'NotificationService').Release.PROVISIONING_PROFILE_SPECIFIER, '"$(SHIPKIT_IOS_PROFILE_PUSH)"');
    const info = plist.parse(fs.readFileSync(path.join(root, 'ios/HelloWorld/Info.plist'), 'utf8'));
    assert.equal(info.CFBundleVersion, '$(CURRENT_PROJECT_VERSION)');
    assert.equal(info.CFBundleShortVersionString, '$(MARKETING_VERSION)');
  });
});

test('expo mods: a CI prebuild bakes the profiles, team and build number', async () => {
  await withEnv(
    { SHIPKIT_IOS_PROFILE_APP: 'Hello App Store', SHIPKIT_IOS_PROFILE_PUSH: 'Hello Push', SHIPKIT_TEAM_ID: 'ABCDE12345', SHIPKIT_BUILD_NUMBER: '204' },
    async () => {
      const root = tempProject();
      await prebuild(root, { extensions: [{ target: 'NotificationService', suffix: 'PUSH' }] }, ['ios']);
      const project = xcode.project(path.join(root, 'ios/HelloWorld.xcodeproj/project.pbxproj'));
      project.parseSync();
      const app = targetSettings(project, 'HelloWorld');
      assert.equal(app.Release.PROVISIONING_PROFILE_SPECIFIER, '"Hello App Store"');
      assert.equal(app.Release.CODE_SIGN_STYLE, 'Manual');
      assert.equal(app.Release.DEVELOPMENT_TEAM, 'ABCDE12345');
      assert.equal(String(app.Release.CURRENT_PROJECT_VERSION), '204');
      assert.equal(app.Debug.CODE_SIGN_STYLE, undefined);
      const ext = targetSettings(project, 'NotificationService');
      assert.equal(ext.Release.PROVISIONING_PROFILE_SPECIFIER, '"Hello Push"');
      assert.equal(ext.Release.DEVELOPMENT_TEAM, 'ABCDE12345');
    },
  );
});

test('expo mods: a second prebuild over the first changes nothing', async () => {
  await withEnv({ SHIPKIT_IOS_PROFILE_APP: 'P', SHIPKIT_TEAM_ID: 'T' }, async () => {
    const root = tempProject();
    await prebuild(root, {});
    const gradle = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');
    const pbx = fs.readFileSync(path.join(root, 'ios/HelloWorld.xcodeproj/project.pbxproj'), 'utf8');
    await prebuild(root, {});
    assert.equal(fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8'), gradle);
    assert.equal(fs.readFileSync(path.join(root, 'ios/HelloWorld.xcodeproj/project.pbxproj'), 'utf8'), pbx);
  });
});

test('expo mods: a Kotlin DSL build file is refused with a reason', async () => {
  const root = tempProject({ kotlin: true });
  await assert.rejects(prebuild(root, {}, ['android']), /Kotlin DSL/);
});

test('expo mods: a platform can be switched off', async () => {
  const root = tempProject();
  await prebuild(root, { android: false }, ['android']);
  assert.equal(fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8'), GRADLE);
});
