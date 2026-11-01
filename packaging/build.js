// Winify.app and a .dmg to DM: `npm run package`.
//
// Built with electron-builder from the castLabs Electron already in
// node_modules (copied, never changed). castLabs requires the VMP signature
// before any Apple signing, so the order is: package, VMP-sign the folder
// holding Winify.app (vmp-sign.js), ad-hoc code signature, then verify-pkg
// (vmp-verify.js). Output: dist/Winify.app (in dist/mac-arm64) and
// dist/Winify-1.0.0.dmg.
//
// `npm run package -- --test <entry>` builds the same app with a test as its
// starting file instead (the smoke test runs inside Winify's own process),
// into dist/test.noindex, with no .dmg. Never for sharing. ".noindex" keeps it
// out of Spotlight, which otherwise offers it as Winify: opened that way, it
// runs the test and quits.
const { build, Platform } = require('electron-builder');

const args = process.argv.slice(2);
const testEntry = args[0] === '--test' ? args[1] : null;
if (args.length && !testEntry) {
  console.error('Usage: npm run package [-- --test <entry, e.g. test/smoke/smoke.js>]');
  process.exit(2);
}

const config = {
  appId: 'app.winify.player',
  productName: 'Winify',
  electronVersion: '44.1.0',
  electronDist: 'node_modules/electron/dist',
  npmRebuild: false,
  directories: { output: 'dist', buildResources: 'packaging' },
  // The app itself; the runtime packages are added from package.json. Not
  // .env (a Client ID), the tests, or the project's own notes.
  files: ['*.js', '*.html', 'README.md', 'assets/**', 'package.json'],
  // Licences and credits, in Winify.app/Contents/Resources.
  extraResources: [
    { from: 'LICENSE', to: 'LICENSE.winify.txt' },
    { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
    { from: 'node_modules/electron/dist/LICENSE', to: 'LICENSE.electron.txt' },
    { from: 'node_modules/electron/dist/LICENSES.chromium.html', to: 'LICENSES.chromium.html' },
  ],
  mac: {
    icon: 'assets/icon.png',
    category: 'public.app-category.music',
    target: [{ target: 'dmg', arch: ['arm64'] }],
    // Ad-hoc, by vmp-sign.js: no Apple developer membership. No hardened
    // runtime: it would refuse the Widevine module Winify downloads on first
    // launch.
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Winify listens only to BlackHole, to drive its visualizers. It never listens to your microphone.',
    },
  },
  dmg: { artifactName: '${productName}-${version}.${ext}', writeUpdateInfo: false },
  afterPack: require.resolve('./vmp-sign.js'),
  afterSign: require.resolve('./vmp-verify.js'),
};

if (testEntry) {
  config.extraMetadata = { main: testEntry };
  config.files = config.files.concat(['test/smoke/**', 'test/package/**']);
  config.directories = Object.assign({}, config.directories, { output: 'dist/test.noindex' });
  config.mac = Object.assign({}, config.mac, { target: [{ target: 'dir', arch: ['arm64'] }] });
}

build({ targets: Platform.MAC.createTarget(), config, publish: 'never' })
  .then((files) => {
    console.log('\nBuilt:' + (testEntry ? ' (test build, starting at ' + testEntry + ')' : ''));
    files.forEach((f) => console.log('  ' + f));
  })
  .catch((err) => {
    console.error('\nPackaging failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
