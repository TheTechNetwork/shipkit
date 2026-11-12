// What a real `expo prebuild` (with pods installed) made of the plugin's iOS
// contract, read with plutil rather than the plugin's own pbxproj library:
// with CI's variables set, the app target's Release is manual-signed with the
// literal profile and team, Debug only references the variable, and nothing
// else (the project level, the Pods project) gains a profile or a team.
//
//   node expo-ios-project.mjs <ios dir>   with SHIPKIT_IOS_PROFILE_APP, SHIPKIT_TEAM_ID, SHIPKIT_BUILD_NUMBER set

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ios = process.argv[2];
const { SHIPKIT_IOS_PROFILE_APP: profile, SHIPKIT_TEAM_ID: team, SHIPKIT_BUILD_NUMBER: build } = process.env;
if (!ios || !profile || !team || !build) throw new Error('usage: SHIPKIT_IOS_PROFILE_APP=… SHIPKIT_TEAM_ID=… SHIPKIT_BUILD_NUMBER=… node expo-ios-project.mjs <ios dir>');

/** @param {string} pbxproj */
function load(pbxproj) {
  const { objects, rootObject } = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', pbxproj], { encoding: 'utf8' }));
  /** @param {string} listId @returns {Record<string, Record<string, string>>} */
  const configs = (listId) =>
    Object.fromEntries(objects[listId].buildConfigurations.map((/** @type {string} */ id) => [objects[id].name, objects[id].buildSettings]));
  const targets = objects[rootObject].targets.map((/** @type {string} */ id) => objects[id]);
  return { project: configs(objects[rootObject].buildConfigurationList), targets, configs };
}

const failures = [];
/** @param {boolean} ok @param {string} what */
const expect = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const appProject = readdirSync(ios).find((f) => f.endsWith('.xcodeproj'));
if (!appProject) throw new Error(`no .xcodeproj in ${ios}`);
const app = load(join(ios, appProject, 'project.pbxproj'));
const appTargets = app.targets.filter((t) => t.productType === 'com.apple.product-type.application');
expect(appTargets.length === 1, `one application target in ${appProject}`);
const { Debug: debug, Release: release } = app.configs(appTargets[0].buildConfigurationList);
expect(release.PROVISIONING_PROFILE_SPECIFIER === profile, `Release profile is "${profile}" (got ${release.PROVISIONING_PROFILE_SPECIFIER})`);
expect(release.CODE_SIGN_STYLE === 'Manual', `Release is manually signed (got ${release.CODE_SIGN_STYLE})`);
expect(release.DEVELOPMENT_TEAM === team, `Release team is ${team} (got ${release.DEVELOPMENT_TEAM})`);
expect(release.CURRENT_PROJECT_VERSION === build, `Release build number is ${build} (got ${release.CURRENT_PROJECT_VERSION})`);
expect(debug.PROVISIONING_PROFILE_SPECIFIER === '$(SHIPKIT_IOS_PROFILE_APP)', `Debug only references $(SHIPKIT_IOS_PROFILE_APP) (got ${debug.PROVISIONING_PROFILE_SPECIFIER})`);
expect(debug.CODE_SIGN_STYLE !== 'Manual', 'Debug keeps its signing style');

/** @param {string} where @param {Record<string, string>} settings */
const untouched = (where, settings) =>
  expect(
    !('PROVISIONING_PROFILE_SPECIFIER' in settings) && settings.DEVELOPMENT_TEAM !== team && settings.CODE_SIGN_STYLE !== 'Manual',
    `${where} has no profile, team or manual signing`,
  );
for (const [name, settings] of Object.entries(app.project)) untouched(`${appProject} project-level ${name}`, settings);

const pods = load(join(ios, 'Pods', 'Pods.xcodeproj', 'project.pbxproj'));
expect(pods.targets.length > 0, `the Pods project has targets (${pods.targets.length})`);
for (const [name, settings] of Object.entries(pods.project)) untouched(`Pods project-level ${name}`, settings);
let podConfigs = 0;
for (const target of pods.targets) {
  for (const [name, settings] of Object.entries(pods.configs(target.buildConfigurationList))) {
    podConfigs++;
    if ('PROVISIONING_PROFILE_SPECIFIER' in settings || settings.DEVELOPMENT_TEAM === team || settings.CODE_SIGN_STYLE === 'Manual') {
      expect(false, `Pods target ${target.name} ${name} has no profile, team or manual signing`);
    }
  }
}
expect(podConfigs > 0, `all ${podConfigs} Pods target configurations have no profile, team or manual signing`);

if (failures.length) {
  console.error(`::error::${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
