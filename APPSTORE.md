# Publishing Nebula Disk Organizer

Everything code-side is already in place: sandboxed renderer, App Sandbox
entitlements (`build/entitlements.mas.plist`), hardened-runtime entitlements for
the direct dmg (`build/entitlements.mac.plist`), TCC usage descriptions, app
icon (`build/icon.png`), and display name **Nebula Disk Organizer** (the bundle
keeps the short name `Nebula.app`; the store listing name is set in App Store
Connect).

## One-time setup

1. **Apple Developer Program** — enroll at developer.apple.com ($99/yr) with the
   Apple ID tied to deepak.dell@gmail.com.
2. In **Certificates, Identifiers & Profiles**:
   - Register the bundle ID `com.deepirex.nebula`.
   - Create certificates: *Apple Distribution* (for MAS) and *Developer ID
     Application* (for the notarized dmg). Download both into Keychain.
   - Create a **Mac App Store provisioning profile** for the bundle ID; save as
     `build/embedded.provisionprofile`.
3. In **App Store Connect**: create the app — name **Nebula Disk Organizer**,
   bundle ID `com.deepirex.nebula`, category Utilities, price $9.99 (or free at
   launch — can be changed anytime).

## Build & submit (Mac App Store)

```bash
npx electron-builder --mac mas --universal   # signs with Apple Distribution automatically
# upload the .pkg from dist/mas-universal/ with:
xcrun altool --upload-app -f dist/mas-universal/Nebula-*.pkg -t macos \
  --apiKey <key-id> --apiIssuer <issuer-id>   # or drag into the Transporter app
```

Then in App Store Connect: attach the build, fill screenshots (1280×800 or
2880×1800 — screenshot each view), privacy details ("Data not collected" — the
app makes zero network calls), and submit for review.

**Review notes to include**: "All file access is via the system open-folder
dialog (user-selected read-write). File deletion uses the system Trash only.
The app is fully offline."

## Notarized direct dmg (for GitHub releases)

```bash
export CSC_NAME="Developer ID Application: <your name> (<team id>)"
export APPLE_ID=deepak.dell@gmail.com APPLE_APP_SPECIFIC_PASSWORD=<app-pwd> APPLE_TEAM_ID=<team id>
npx electron-builder --mac dmg --arm64 --x64   # signs + notarizes when env vars are set
```

Add those as GitHub Actions secrets (`CSC_LINK`/`CSC_KEY_PASSWORD` for the cert,
plus the three Apple vars) and remove `CSC_IDENTITY_AUTO_DISCOVERY: false` from
`.github/workflows/build.yml` to make CI produce notarized dmgs — no more
right-click-to-open for users.

## Microsoft Store (Windows)

Package as MSIX (`"win": { "target": "appx" }` variant), reserve the name in
Partner Center ($19 one-time), upload — Microsoft signs it, which also removes
the SmartScreen warning.

## Known MAS caveats

- The sandboxed build can only scan folders the user picks (already our UX) —
  system-wide sweeps of `/` will be limited by the sandbox.
- "Resume last session" re-prompts for folder access after relaunch until
  security-scoped bookmarks are wired into the index (listed as a future task).
- Trash behavior inside the sandbox uses the user's Trash via the
  user-selected-file entitlement; test on a clean account before submitting.
