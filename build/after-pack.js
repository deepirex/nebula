// electron-builder afterPack hook (macOS): give the app bundle a valid ad-hoc
// signature.
//
// Why: without signing, only the individual Mach-O binaries keep their linker
// signatures and the bundle has no _CodeSignature/CodeResources. Gatekeeper's
// integrity check then fails with "code has no resources but signature
// indicates they must be present", which macOS reports to the user as
// "…is damaged and can't be opened. You should move it to the Bin." — a dead
// end: the app never appears under Privacy & Security, so there is no
// "Open Anyway" button to click.
//
// An ad-hoc signature ("codesign -s -") makes the bundle internally consistent,
// so the same download is reported as an ordinary unverified/not-notarized app,
// which macOS lets the user approve in System Settings → Privacy & Security →
// "Open Anyway", or by clearing the quarantine flag.
//
// A Developer ID signature + notarization (paid Apple Developer Program) is the
// only way to remove the warning entirely; when such an identity is configured,
// electron-builder signs after this hook and the ad-hoc signature is replaced.
const { execFileSync } = require('child_process');
const path = require('path');

async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const identity = process.env.NEBULA_SIGN_IDENTITY || '-';
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', identity, appPath], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
    console.log(`[afterPack] signed ${path.basename(appPath)} with identity "${identity}"`);
  } catch (err) {
    // Never fail the build over this: an unsigned build still runs after the
    // user clears the quarantine flag.
    console.warn('[afterPack] signing failed:', err && err.message);
  }
}

module.exports = afterPack;
module.exports.default = afterPack;
