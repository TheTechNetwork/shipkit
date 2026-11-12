#!/usr/bin/env bash
# What android-release.yml built, checked from outside it: the APK carries the
# versionCode the workflow promised Gradle (ANDROID_VERSION_CODE), and the APK
# and the bundle are signed with the keystore handed in as secrets, not the
# debug key and not left unsigned.
#
#   android-build.sh <artifacts dir> <expected versionCode> <expected cert SHA-256, hex>
set -euo pipefail
dir=$1 want_code=$2 want_sha=$(tr -d ':' <<<"$3" | tr '[:upper:]' '[:lower:]')

tools=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)
mapfile -t apks < <(find "$dir" -name '*.apk')
mapfile -t aabs < <(find "$dir" -name '*.aab')
[ ${#apks[@]} -eq 1 ] || { echo "::error::expected one APK, found ${#apks[@]}: ${apks[*]}"; exit 1; }
[ ${#aabs[@]} -eq 1 ] || { echo "::error::expected one bundle, found ${#aabs[@]}: ${aabs[*]}"; exit 1; }
apk=${apks[0]} aab=${aabs[0]}

code=$("$tools/aapt2" dump badging "$apk" | sed -nE "s/.*versionCode='([0-9]+)'.*/\1/p" | head -1)
echo "$apk: versionCode $code"
[ "$code" = "$want_code" ] || { echo "::error::versionCode is '$code', not $want_code: ANDROID_VERSION_CODE did not reach the build"; exit 1; }

if ! certs=$("$tools/apksigner" verify --print-certs "$apk"); then
  echo "::error::$apk does not verify: it is unsigned or badly signed"; exit 1
fi
echo "$certs"
# "Signer #1 certificate …" or, with only one scheme, "V2 Signer: certificate …".
got=$(sed -nE 's/^(Signer #1|V[0-9]+ Signer:) certificate SHA-256 digest: ([0-9a-f]+)$/\2/p' <<<"$certs" | head -1)
[ "$got" = "$want_sha" ] || { echo "::error::$apk is signed by $got, not the keystore given (${want_sha})"; exit 1; }

# The bundle is what Play receives; jar signing, so keytool reads it.
printed=$(keytool -printcert -jarfile "$aab")
got=$(sed -nE 's/^[[:space:]]*SHA256: ([0-9A-F:]+)$/\1/p' <<<"$printed" | head -1 | tr -d ':' | tr '[:upper:]' '[:lower:]')
echo "$aab: signed by ${got:-nothing}"
[ "$got" = "$want_sha" ] || { echo "::error::$aab is not signed by the keystore given"; echo "$printed"; exit 1; }
echo "ok: versionCode $code, APK and bundle signed by $want_sha"
