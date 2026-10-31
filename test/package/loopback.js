// Native system-audio capture, retested in the packaged app (DEVELOPMENT.md,
// "System audio capture"): does Electron's loopback capture deliver sound
// there, without BlackHole?
//
//   npm run package -- --test test/package/loopback.js
//   SMOKE_OUTPUT=test/.output dist/test/mac-arm64/Winify.app/Contents/MacOS/Winify
//
// Runs Winify's real main process from the packaged app with an empty settings
// folder (no Client ID, so nothing goes to Spotify), plays a few of macOS's
// own sounds, and asks for loopback capture the way Winify's main process
// grants it. macOS shows its screen-sharing picker: choose any screen. The
// first time, macOS may also ask for Screen & System Audio Recording.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFile } = require('child_process');

require(path.join(__dirname, '..', '..', 'main.js'));
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'winify-loopback-')));

const OUTPUT = process.env.SMOKE_OUTPUT || os.tmpdir();
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };
const finish = (code) => {
  try { fs.mkdirSync(OUTPUT, { recursive: true }); fs.writeFileSync(path.join(OUTPUT, 'loopback-packaged.log'), lines.join('\n') + '\n'); } catch (e) { /* console has it */ }
  app.exit(code);
};
setTimeout(() => { say('TIMED OUT (no answer from the picker in 90 s)'); finish(3); }, 90000);

// macOS's own sounds, one after another, while capturing.
function playSounds(n) {
  if (n <= 0) return;
  execFile('afplay', ['/System/Library/Sounds/Submarine.aiff'], () => playSounds(n - 1));
}

app.whenReady().then(async () => {
  say('packaged: ' + app.isPackaged + ', ' + process.execPath);
  let win = null;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0] || null; await new Promise((r) => setTimeout(r, 100)); }
  if (!win) { say('no window'); return finish(1); }
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  say('asking for loopback capture: choose a screen in macOS\'s picker');
  const result = await win.webContents.executeJavaScript(`(async () => {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const t = s.getAudioTracks()[0];
      if (!t) return { audioTrack: false };
      const first = t.readyState;
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      ctx.createMediaStreamSource(new MediaStream([t])).connect(an);
      const b = new Uint8Array(an.fftSize); let peak = 0;
      window.__winifyLoopbackReady = true;
      for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 100)); an.getByteTimeDomainData(b); peak = Math.max(peak, Math.max(...b) - Math.min(...b)); }
      const after = t.readyState;
      s.getTracks().forEach((x) => x.stop()); ctx.close();
      return { audioTrack: true, label: t.label, readyStateAtStart: first, readyStateAfter6s: after, peak };
    } catch (e) { return { error: e.name + ': ' + e.message }; }
  })()`, true).catch((e) => ({ error: String(e) }));
  say('result: ' + JSON.stringify(result));
  const works = !!(result && result.audioTrack && result.peak > 10);
  say(works ? 'NATIVE LOOPBACK WORKS in the packaged app' : 'NATIVE LOOPBACK DELIVERS NO SOUND in the packaged app');
  finish(works ? 0 : 1);
});

// The sounds start once capture is running.
const soundTimer = setInterval(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  const ready = await win.webContents.executeJavaScript('!!window.__winifyLoopbackReady').catch(() => false);
  if (ready) { clearInterval(soundTimer); playSounds(4); }
}, 200);
