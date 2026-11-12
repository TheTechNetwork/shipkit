#!/usr/bin/env python3
"""What ios-release.yml archived with sign: false, checked from outside it.

The app in the .xcarchive carries the build number and marketing version the
workflow was given (that is the contract an App Store upload depends on), and
nothing in it was signed.

    ios-archive.py <xcarchive dir> <app name> <bundle id> <build number> <marketing version>
"""
import glob
import os
import plistlib
import sys

archive, app, bundle_id, build, version = sys.argv[1:]
apps = glob.glob(os.path.join(archive, "Products", "Applications", "*.app"))
if [os.path.basename(a) for a in apps] != [app + ".app"]:
    sys.exit(f"expected {app}.app in the archive, found {apps}")
with open(os.path.join(apps[0], "Info.plist"), "rb") as f:
    info = plistlib.load(f)
got = {k: info.get(k) for k in ("CFBundleIdentifier", "CFBundleVersion", "CFBundleShortVersionString")}
print(got)
want = {"CFBundleIdentifier": bundle_id, "CFBundleVersion": build, "CFBundleShortVersionString": version}
if got != want:
    sys.exit(f"the archived Info.plist says {got}, not {want}")
signed = [p for p in glob.glob(os.path.join(apps[0], "**", "_CodeSignature"), recursive=True)]
if signed:
    sys.exit(f"sign: false still signed {signed}")
with open(os.path.join(archive, "Info.plist"), "rb") as f:
    props = plistlib.load(f)["ApplicationProperties"]
if props.get("CFBundleVersion") != build:
    sys.exit(f"the archive's own Info.plist says build {props.get('CFBundleVersion')}, not {build}")
print(f"ok: {app}.app {version} ({build}), unsigned")
