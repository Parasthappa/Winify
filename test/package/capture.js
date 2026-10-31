// The visualizer's audio capture in the packaged app: macOS's microphone
// permission for Winify, which input opens, and whether sound arrives.
//
//   npm run package -- --test test/package/capture.js
//   SMOKE_OUTPUT=test/.output dist/test/mac-arm64/Winify.app/Contents/MacOS/Winify
//
// Runs Winify's real main process from the packaged app with an empty settings
// folder (no Client ID, so nothing goes to Spotify), starts Winify's own
// capture (audio-source.js), plays a few of macOS's own sounds through the
// sound output (the Multi-Output Device, so BlackHole hears them) and reads
// the level.
const { app, BrowserWindow, systemPreferences } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFile } = require('child_process');

require(path.join(__dirname, '..', '..', 'main.js'));
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'winify-capture-')));

const OUTPUT = process.env.SMOKE_OUTPUT || os.tmpdir();
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };
const finish = (code) => {
  try { fs.mkdirSync(OUTPUT, { recursive: true }); fs.writeFileSync(path.join(OUTPUT, 'capture-packaged.log'), lines.join('\n') + '\n'); } catch (e) { /* console has it */ }
  app.exit(code);
};
setTimeout(() => { say('TIMED OUT (90 s)'); finish(3); }, 90000);

function playSounds(n) {
  if (n <= 0) return;
  execFile('afplay', ['/System/Library/Sounds/Submarine.aiff'], () => playSounds(n - 1));
}

app.whenReady().then(async () => {
  say('packaged: ' + app.isPackaged + ', ' + process.execPath);
  say('microphone permission at start: ' + systemPreferences.getMediaAccessStatus('microphone'));
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0] || null; await new Promise((r) => setTimeout(r, 100)); }
  if (!win) { say('no window'); return finish(1); }
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  win.webContents.on('console-message', (e) => { if ((e.message || '').startsWith('[winify/audio]') && !/ level /.test(e.message)) say('  ' + e.message); });
  const started = await win.webContents.executeJavaScript('WinifyAudio.start()', true).catch((e) => 'error: ' + e);
  say('capture started: ' + started);
  say('microphone permission after: ' + systemPreferences.getMediaAccessStatus('microphone'));
  if (started !== true) return finish(1);
  playSounds(4);
  const peak = await win.webContents.executeJavaScript(`(async () => { const a = WinifyAudio.getAnalyser(); const b = new Uint8Array(a.fftSize); let p = 0;
    for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 100)); a.getByteTimeDomainData(b); p = Math.max(p, Math.max(...b) - Math.min(...b)); } return p; })()`, true);
  say('peak while macOS sounds play: ' + peak);
  say(peak > 10 ? 'CAPTURE HEARS THE SOUND OUTPUT' : 'CAPTURE HEARS SILENCE');
  finish(peak > 10 ? 0 : 1);
});
