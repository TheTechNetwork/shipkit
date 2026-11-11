// @thetechnetwork/expo-shipkit-plugin: makes an Expo prebuild sign and number its
// builds the way shipkit's ios-release.yml and android-release.yml expect.

const { createRunOncePlugin } = require('./config-plugins.js');
const { withShipkitIos, applyIosSigning, applyInfoPlist, profileVar } = require('./ios.js');
const { withShipkitAndroid, applyAndroidSigning } = require('./android.js');
const pkg = require('../package.json');

/**
 * @param {import('@expo/config-plugins').ExportedConfig} config
 * @param {{ extensions?: import('./ios.js').Extension[], ios?: boolean, android?: boolean }} [props]
 */
const withShipkit = (config, props = {}) => {
  if (props.ios !== false) config = withShipkitIos(config, props);
  if (props.android !== false) config = withShipkitAndroid(config);
  return config;
};

module.exports = createRunOncePlugin(withShipkit, pkg.name, pkg.version);
Object.assign(module.exports, {
  withShipkit,
  withShipkitIos,
  withShipkitAndroid,
  applyIosSigning,
  applyInfoPlist,
  applyAndroidSigning,
  profileVar,
});
