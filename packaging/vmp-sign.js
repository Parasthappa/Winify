// electron-builder's afterPack: castLabs' VMP signature, then the ad-hoc Apple
// code signature (castLabs requires VMP before any Apple signing on macOS).
// sign-pkg is given the folder holding Winify.app, and always signs afresh
// (it would otherwise keep the copied development Electron's signature).
// Needs castlabs-evs and a signed-in EVS account (README, step 3).
//
// electron-builder does not do ad-hoc signing itself (its identity "-" is
// looked for in the keychain and skipped), so codesign is run here.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function vmpSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  console.log('  • VMP-signing ' + context.appOutDir);
  execFileSync('python3', ['-m', 'castlabs_evs.vmp', 'sign-pkg', '--force', '--name-hint', 'Winify', context.appOutDir], { stdio: 'inherit' });
  console.log('  • ad-hoc code signature ' + appPath);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
