// iOS: per-target manual signing and build numbers, from shipkit's env contract.
//
// The profile is set on the app (and named extension) targets only, never on the
// xcodebuild command line: a global PROVISIONING_PROFILE_SPECIFIER reaches every
// Pods target too, and CocoaPods targets refuse a profile.

const { withXcodeProject, withInfoPlist, IOSConfig, PluginError } = require('./config-plugins.js');

const IDENTITY = 'Apple Distribution';

/**
 * @typedef {object} Extension
 * @property {string} target  the native target name, e.g. NotificationService
 * @property {string} suffix  names its profile variable, SHIPKIT_IOS_PROFILE_<suffix>
 */

/** pbxproj values need quotes once they hold anything but plain word characters. @param {string} v */
function q(v) {
  return /^[A-Za-z0-9_./]+$/.test(v) ? v : `"${String(v).replace(/(["\\])/g, '\\$1')}"`;
}

/** @param {string} suffix */
function profileVar(suffix) {
  const s = String(suffix).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) throw new PluginError('an extension needs a suffix for its SHIPKIT_IOS_PROFILE_<suffix> variable', 'INVALID_PLUGIN_IMPORT');
  return `SHIPKIT_IOS_PROFILE_${s}`;
}

/**
 * Build configurations of one native target, as [name, buildSettings] pairs.
 * @param {any} project @param {any} target
 */
function configurationsOf(project, target) {
  return IOSConfig.XcodeUtils.getBuildConfigurationsForListId(project, target.buildConfigurationList).map(
    ([, cfg]) => /** @type {[string, Record<string, string>]} */ ([IOSConfig.XcodeUtils.unquote(cfg.name), cfg.buildSettings]),
  );
}

/**
 * Point one target at its profile variable, and bake CI's values into Release when present.
 * @param {any} project @param {any} target @param {string} variable
 * @param {Record<string, string|undefined>} env
 */
function signTarget(project, target, variable, env) {
  const profile = env[variable];
  for (const [name, settings] of configurationsOf(project, target)) {
    // Locally the variable is unset, which is an empty specifier: automatic signing as before.
    settings.PROVISIONING_PROFILE_SPECIFIER = q(`$(${variable})`);
    if (profile && name === 'Release') {
      settings.PROVISIONING_PROFILE_SPECIFIER = q(profile);
      settings.CODE_SIGN_STYLE = 'Manual';
      settings.CODE_SIGN_IDENTITY = q(IDENTITY);
      if (env.SHIPKIT_TEAM_ID) settings.DEVELOPMENT_TEAM = q(env.SHIPKIT_TEAM_ID);
    }
  }
}

/**
 * The whole iOS project transform, on a parsed `xcode` project.
 * @param {any} project
 * @param {{ extensions?: Extension[], buildNumber?: string, version?: string, env?: Record<string, string|undefined> }} [opts]
 */
function applyIosSigning(project, { extensions = [], buildNumber = '1', version = '1.0', env = process.env } = {}) {
  const apps = IOSConfig.Target.getNativeTargets(project).filter(([, t]) =>
    IOSConfig.Target.isTargetOfType(t, IOSConfig.Target.TargetType.APPLICATION),
  );
  if (!apps.length) throw new PluginError('no application target in the Xcode project', 'INVALID_PLUGIN_IMPORT');
  const [, app] = apps[0];
  signTarget(project, app, 'SHIPKIT_IOS_PROFILE_APP', env);
  for (const [, settings] of configurationsOf(project, app)) {
    // App Store Connect refuses a build number twice, so CI's has to reach CFBundleVersion.
    settings.CURRENT_PROJECT_VERSION = q(env.SHIPKIT_BUILD_NUMBER || String(buildNumber));
    settings.MARKETING_VERSION = q(env.SHIPKIT_MARKETING_VERSION || String(version));
  }
  for (const ext of extensions) {
    const found = IOSConfig.Target.getNativeTargets(project).find(
      ([, t]) => IOSConfig.XcodeUtils.unquote(t.name) === ext.target,
    );
    if (!found) throw new PluginError(`no native target named ${JSON.stringify(ext.target)} for the extension`, 'INVALID_PLUGIN_IMPORT');
    signTarget(project, found[1], profileVar(ext.suffix), env);
  }
  return project;
}

/**
 * @param {Record<string, any>} plist
 */
function applyInfoPlist(plist) {
  // Expo writes literal versions here; the build settings above are what CI overrides.
  plist.CFBundleVersion = '$(CURRENT_PROJECT_VERSION)';
  plist.CFBundleShortVersionString = '$(MARKETING_VERSION)';
  return plist;
}

/**
 * @param {import('@expo/config-plugins').ExportedConfig} config
 * @param {{ extensions?: Extension[] }} [props]
 */
const withShipkitIos = (config, props = {}) => {
  // Expo's built-in mods register after user plugins and withMod runs the last-registered
  // action first, so these run after Expo's own withVersion and win.
  config = withInfoPlist(config, (config) => {
    config.modResults = /** @type {any} */ (applyInfoPlist(config.modResults));
    return config;
  });
  return withXcodeProject(config, (config) => {
    applyIosSigning(config.modResults, {
      extensions: props.extensions ?? [],
      buildNumber: config.ios?.buildNumber ?? '1',
      version: config.version ?? '1.0',
      env: process.env,
    });
    return config;
  });
};

module.exports = { applyIosSigning, applyInfoPlist, profileVar, withShipkitIos };
