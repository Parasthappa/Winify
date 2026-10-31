// audio-source.js (the visualizers' capture) and macOS's microphone permission,
// with audio input faked in a page: BlackHole is an oscillator, and macOS's
// answer comes from a fake window.spotify.microphoneAccess.
const { app, BrowserWindow } = require('electron'); const fs = require('fs'), path = require('path');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 60000);
const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 220) : '')); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKES = `
  window.calls = [];
  window.access = { answer: 'granted', delay: 0 };
  window.spotify = { microphoneAccess: () => { calls.push('access?'); return new Promise((r) => setTimeout(() => { calls.push('access:' + access.answer); r(access.answer); }, access.delay)); } };
  const md = {};
  Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true });
  md.enumerateDevices = async () => [
    { kind: 'audioinput', deviceId: 'mic', label: 'MacBook Air Microphone (Built-in)' },
    { kind: 'audioinput', deviceId: 'bh', label: 'BlackHole 2ch (Virtual)' }];
  md.getUserMedia = async (c) => {
    calls.push('open:' + (c.audio.deviceId ? c.audio.deviceId.exact : 'default'));
    const ctx = new AudioContext(); const osc = ctx.createOscillator(); const out = ctx.createMediaStreamDestination(); osc.connect(out); osc.start();
    const t = out.stream.getAudioTracks()[0]; Object.defineProperty(t, 'label', { value: 'BlackHole 2ch (Virtual)' }); return out.stream; };
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } });
  const logs = []; win.webContents.on('console-message', (e) => logs.push(e.message || ''));
  await win.loadURL('data:text/html,<title>capture</title>');
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js(FAKES + ";true");
  await js(fs.readFileSync(path.join(__dirname, '..', '..', 'audio-source.js'), 'utf8'));
  const calls = () => js('calls.splice(0)');

  console.log('1. macOS has not allowed audio input');
  await js("access.answer = 'denied'");
  let r = await js('WinifyAudio.start()'); let c = await calls();
  check('denied: no capture, BlackHole never opened', r === false && !(await js('WinifyAudio.isActive()')) && !c.some((x) => x.startsWith('open:')), JSON.stringify(c));
  check('...and the log says where to turn it on', logs.some((m) => /MICROPHONE ACCESS DENIED/.test(m)) && logs.some((m) => /Privacy & Security -> Microphone/.test(m)));
  await js("access.answer = 'restricted'");
  r = await js('WinifyAudio.start()');
  check('restricted (a managed Mac): no capture either', r === false && !(await js('WinifyAudio.isActive()')));
  await calls();

  console.log('2. macOS asks first; capture waits for the answer');
  await js("access.answer = 'granted'; access.delay = 800");
  r = await js('Promise.all([WinifyAudio.start(), WinifyAudio.start()])'); c = await calls();
  check('BlackHole opened only after macOS answered', c.indexOf('access:granted') >= 0 && c.indexOf('open:bh') > c.indexOf('access:granted'), JSON.stringify(c));
  check('two starts while macOS asks: one question, one stream, both report success', r[0] === true && r[1] === true && c.filter((x) => x === 'access?').length === 1 && c.filter((x) => x.startsWith('open:')).length === 1, JSON.stringify([r, c]));
  await wait(300);
  const peak = await js('(() => { const a = WinifyAudio.getAnalyser(); const b = new Uint8Array(a.fftSize); a.getByteTimeDomainData(b); return Math.max(...b) - Math.min(...b); })()');
  check('sound reaches the analyser', peak > 10, 'peak ' + peak);
  r = await js('WinifyAudio.start()'); c = await calls();
  check('already capturing: a further start opens nothing new', r === true && !c.some((x) => x.startsWith('open:')), JSON.stringify(c));
  await js('WinifyAudio.stop()');

  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
