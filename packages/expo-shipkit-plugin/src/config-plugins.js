// The app's own copy first: `expo/config-plugins` is the version its prebuild
// runs, and a second copy of the mod system would register mods it never reads.
/** @type {typeof import('@expo/config-plugins')} */
let plugins;
try {
  plugins = require('expo/config-plugins');
} catch {
  plugins = require('@expo/config-plugins');
}

module.exports = plugins;
