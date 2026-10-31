// electron-builder's afterSign: after the ad-hoc code signature, confirm both
// signatures still hold. The build fails if either does not.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function vmpVerify(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const out = execFileSync('python3', ['-m', 'castlabs_evs.vmp', 'verify-pkg', context.appOutDir], { encoding: 'utf8' });
  process.stdout.write(out);
  if (!/Signature is valid/.test(out)) throw new Error('verify-pkg: the VMP signature is not valid');
  const appPath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log('  • code signature (ad-hoc) valid');
};
