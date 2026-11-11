# @thetechnetwork/store-ship

App Store Connect and Google Play release commands, as a CLI and as functions.
Zero dependencies; Node 20+.

```sh
npx -y https://github.com/TheTechNetwork/shipkit/releases/download/v0.1.0/thetechnetwork-store-ship-0.1.0.tgz --help
```

```
store-ship testflight-distribute | appstore-release | appstore-screenshots | play-release
           recreate-ios-profile | ensure-ios-extension-profile | store-listing
```

Every setting is an environment variable, or a flag (`--bundle-id x` is
`BUNDLE_ID=x`); `store-ship <command> --help` lists them. Nothing here ever
creates a signing certificate. See the
[shipkit README](../../README.md#thetechnetworkstore-ship).
