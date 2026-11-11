// Android: release signing and version numbers from the environment, the same
// names Fleetwright's own build.gradle.kts reads (README, "Android env contract").

const { withAppBuildGradle, PluginError } = require('./config-plugins.js');

const TAG = 'shipkit-release-signing';
const BEGIN = `// @generated begin ${TAG}`;
const END = `// @generated end ${TAG}`;

// Declared only when a keystore is in the environment: a signingConfig naming a
// missing file fails configuration, and that would break every local debug build.
const SIGNING_BLOCK = [
  `        ${BEGIN} - edit through @thetechnetwork/expo-shipkit-plugin, not here`,
  "        if (System.getenv('ANDROID_KEYSTORE_FILE')) {",
  '            release {',
  "                storeFile file(System.getenv('ANDROID_KEYSTORE_FILE'))",
  "                storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')",
  "                keyAlias System.getenv('ANDROID_KEY_ALIAS')",
  "                keyPassword System.getenv('ANDROID_KEY_PASSWORD')",
  '            }',
  '        }',
  `        ${END}`,
].join('\n');

/**
 * Index of the `}` closing the block whose `{` is at `open`.
 * @param {string} src @param {number} open
 */
function closingBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * The `{ ... }` body of the first `name {` block at or after `from`.
 * @param {string} src @param {string} name @param {number} [from]
 * @returns {{ open: number, close: number } | null}
 */
function block(src, name, from = 0) {
  const re = new RegExp(`(^|\\s)${name}\\s*\\{`, 'g');
  re.lastIndex = from;
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index + m[1].length);
  const close = closingBrace(src, open);
  return close < 0 ? null : { open, close };
}

/** @param {string} src */
function withSigningConfig(src) {
  // Idempotent: a block already there is replaced, so a second prebuild is a no-op.
  const start = src.indexOf(BEGIN);
  if (start >= 0) {
    const lineStart = src.lastIndexOf('\n', start) + 1;
    const end = src.indexOf('\n', src.indexOf(END, start));
    src = src.slice(0, lineStart) + src.slice(end + 1);
  }
  const android = block(src, 'android');
  if (!android) throw new PluginError('app/build.gradle has no android { } block', 'INVALID_PLUGIN_IMPORT');
  let configs = block(src, 'signingConfigs', android.open);
  if (!configs || configs.open > android.close) {
    // No signingConfigs at all: add an empty one at the top of android { }.
    const at = android.open + 1;
    src = `${src.slice(0, at)}\n    signingConfigs {\n    }${src.slice(at)}`;
    configs = /** @type {{open:number,close:number}} */ (block(src, 'signingConfigs', android.open));
  }
  const at = src.indexOf('\n', configs.open) + 1;
  return `${src.slice(0, at)}${SIGNING_BLOCK}\n${src.slice(at)}`;
}

/** @param {string} src */
function withReleaseBuildType(src) {
  const types = block(src, 'buildTypes');
  if (!types) throw new PluginError('app/build.gradle has no buildTypes { } block', 'INVALID_PLUGIN_IMPORT');
  const release = block(src, 'release', types.open);
  if (!release || release.close > types.close) {
    throw new PluginError('app/build.gradle has no buildTypes.release { } block', 'INVALID_PLUGIN_IMPORT');
  }
  const body = src.slice(release.open + 1, release.close);
  const line = /^([ \t]*)signingConfig(?:[ \t]+|\()(.+)$/m.exec(body);
  // The fallback is whatever signed release before (the template's debug key), so a
  // build without a keystore behaves exactly as it did.
  let fallback = 'signingConfigs.debug';
  if (line) {
    const prior = /signingConfigs\.release : (.+)\)\s*$/.exec(line[2]);
    const bare = /signingConfig\(/.test(line[0]) ? line[2].trim().replace(/\)$/, '') : line[2].trim();
    fallback = prior ? prior[1].trim() : bare;
  }
  const indent = line ? line[1] : '            ';
  // Parenthesised: a ternary as a bare Groovy command argument is easy to misparse.
  const wanted = `${indent}signingConfig(System.getenv('ANDROID_KEYSTORE_FILE') ? signingConfigs.release : ${fallback})`;
  const next = line ? body.replace(line[0], wanted) : `\n${wanted}${body}`;
  return src.slice(0, release.open + 1) + next + src.slice(release.close);
}

/**
 * @param {string} src
 * @param {{ versionCode?: number|null, versionName?: string|null }} [fallbacks]
 */
function withVersions(src, fallbacks = {}) {
  // Play refuses a versionCode it has seen, so CI's run number has to reach the build.
  src = src.replace(/^([ \t]*)versionCode[ \t]+(.+)$/m, (_, indent, value) => {
    const prior = /'(\d+)'\)\.toInteger\(\)/.exec(value)?.[1] ?? /^\d+$/.exec(value.trim())?.[0] ?? '1';
    const code = fallbacks.versionCode ?? prior;
    return `${indent}versionCode ((System.getenv('ANDROID_VERSION_CODE') ?: '${code}').toInteger())`;
  });
  return src.replace(/^([ \t]*)versionName[ \t]+(.+)$/m, (_, indent, value) => {
    const prior = /"((?:[^"\\]|\\.)*)"\)?\s*$/.exec(value)?.[1] ?? '1.0';
    const name = fallbacks.versionName ?? prior;
    return `${indent}versionName (System.getenv('ANDROID_VERSION_NAME') ?: "${name.replace(/(["\\$])/g, '\\$1')}")`;
  });
}

/**
 * The whole Android transform, on the text of app/build.gradle.
 * @param {string} src
 * @param {{ versionCode?: number|null, versionName?: string|null }} [fallbacks]
 */
function applyAndroidSigning(src, fallbacks) {
  return withVersions(withReleaseBuildType(withSigningConfig(src)), fallbacks);
}

/** @param {import('@expo/config-plugins').ExportedConfig} config */
const withShipkitAndroid = (config) =>
  withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      // Expo's template is Groovy; a Kotlin DSL file needs Fleetwright's own block instead.
      throw new PluginError(
        '@thetechnetwork/expo-shipkit-plugin edits Groovy app/build.gradle only; this project uses the Kotlin DSL ' +
          '(build.gradle.kts). Read ANDROID_KEYSTORE_FILE etc. there yourself — see the shipkit README.',
        'INVALID_PLUGIN_IMPORT',
      );
    }
    config.modResults.contents = applyAndroidSigning(config.modResults.contents, {
      versionCode: config.android?.versionCode ?? null,
      versionName: config.version ?? null,
    });
    return config;
  });

module.exports = { applyAndroidSigning, withShipkitAndroid };
