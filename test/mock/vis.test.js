const { app } = require('electron'); const h = require('../lib/harness'); const fs = require('fs'), path = require('path');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 180000);
const logs = [];
h.open().then(async ({ win, js }) => {
  win.webContents.on('console-message', (e) => logs.push(e.message || ''));
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 220) : '')); };
  // Pixels on Webamp's visualizer canvas that differ from a reference frame.
  const frame = () => js(`(() => { const c = document.querySelector('#webamp #visualizer'); if (!c) return null; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] * 7 + d[i + 1] * 3 + d[i + 2]) % 1000000007; window.__last = Array.from(d); return { w: c.width, h: c.height, hash: h }; })()`);
  const litVs = (ref) => js(`(() => { const c = document.querySelector('#webamp #visualizer'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - ${'${'}ref${'}'}[i]) + Math.abs(d[i + 1] - ${'${'}ref${'}'}[i + 1]) + Math.abs(d[i + 2] - ${'${'}ref${'}'}[i + 2]) > 40) n++; return n; })()`.replace('${ref}', ref).replace('${ref}', ref).replace('${ref}', ref).replace('${ref}', ref).replace('${ref}', ref).replace('${ref}', ref));
  const style = () => js('WinifyWebamp.getInstance().store.getState().display.visualizerStyle');
  const clickVis = async () => { await h.click(win, js, '#title-bar', 0.3, 0.5); await h.wait(150); await h.click(win, js, '#webamp #visualizer'); await h.wait(500); };
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:playlist:big", 0), mock.setPaused(false))'); await h.wait(2500);

  console.log('1. Wiring');
  const w = await js(`(() => { const a = WinifyWebamp.getInstance().media.getAnalyser(); return { same: a === WinifyWebamp.getInstance().media.getAnalyser(), fft: a.fftSize, bins: a.frequencyBinCount, isNode: a instanceof AudioNode }; })()`);
  check('Webamp asks the media class for its analyser and set fftSize 1024 on it', w.same && w.fft === 1024 && w.bins === 512, JSON.stringify(w));
  const silentRef = await frame(); await js('window.__silent = window.__last');
  check('no capture yet: visualizer present and blank (silence)', !!silentRef && (await litVs('window.__silent')) === 0, JSON.stringify(silentRef));

  console.log('2. Capture starts -> spectrum bars move');
  await js('WinifyAudio.start()'); await h.wait(1500);
  const iso = await js(`({ webamp: WinifyWebamp.getInstance().media.getAnalyser().fftSize, shared: WinifyAudio.getAnalyser().fftSize })`);
  check('Webamp has its own analyser: its fftSize (1024) leaves the shared one alone (2048)', iso.webamp === 1024 && iso.shared === 2048, JSON.stringify(iso));
  check('style is bars', (await style()) === 0);
  let lit = await litVs('window.__silent'); const f1 = await frame(); await h.wait(250); const f2 = await frame();
  check('bars drawn from the captured audio', lit > 30 && f1.hash !== f2.hash, 'lit pixels: ' + lit);
  fs.writeFileSync(path.join(__dirname, '..', '.output', 'vis-bars.png'), (await win.webContents.capturePage()).toPNG());

  console.log('3. Click to switch: oscilloscope -> off -> bars');
  await clickVis(); check('click -> oscilloscope', (await style()) === 1);
  lit = await litVs('window.__silent');
  const rows = await js(`(() => { const c = document.querySelector('#webamp #visualizer'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const ys = new Set(); for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (Math.abs(d[i] - window.__silent[i]) + Math.abs(d[i+1] - window.__silent[i+1]) + Math.abs(d[i+2] - window.__silent[i+2]) > 40) ys.add(y); } return ys.size; })()`);
  check('oscilloscope trace drawn across several rows (a waveform, not a flat line)', lit > 20 && rows >= 5, JSON.stringify({ lit, rows }));
  fs.writeFileSync(path.join(__dirname, '..', '.output', 'vis-osc.png'), (await win.webContents.capturePage()).toPNG());
  await clickVis(); check('click -> off', (await style()) === 2);
  const off1 = await js(`(() => { const c = document.querySelector('#webamp #visualizer'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; return d.some(v => v !== 0); })()`);
  check('off: nothing drawn', off1 === false);
  await clickVis(); check('click -> bars again', (await style()) === 0);

  console.log('4. Hidden window pauses drawing; capture keeps running');
  await js('window.spotify.setVisibleForTest(false)'); await h.wait(300);
  const hidStyle = await style(); const h1 = await frame(); await h.wait(400); const h2 = await frame();
  const node = await js(`(() => { const a = new Uint8Array(1024); WinifyWebamp.getInstance().media.getAnalyser().getByteTimeDomainData(a); return a.some(v => v !== 128); })()`);
  check('hidden: visualizer off, canvas frozen', hidStyle === 2 && h1.hash === h2.hash, JSON.stringify({ hidStyle }));
  check('hidden: capture and Webamp\'s analyser still live', node && (await js('WinifyAudio.isActive()')));
  await js('window.spotify.setVisibleForTest(true)'); await h.wait(500);
  const s1 = await frame(); await h.wait(250); const s2 = await frame();
  check('shown: the chosen style (bars) comes back and drawing resumes', (await style()) === 0 && s1.hash !== s2.hash);
  await clickVis(); await js('window.spotify.setVisibleForTest(false)'); await h.wait(200); await js('window.spotify.setVisibleForTest(true)'); await h.wait(300);
  check('a chosen oscilloscope also survives hide/show', (await style()) === 1); await clickVis(); await clickVis();

  console.log('5. Capture stops, restarts (new AudioContext), or is unavailable');
  await js('WinifyAudio.stop()'); await h.wait(1800);
  check('capture stopped: visualizer falls quiet, nothing thrown', (await litVs('window.__silent')) === 0);
  await js('WinifyAudio.start()'); await h.wait(900);
  check('capture restarted in a fresh context: bars move again', (await litVs('window.__silent')) > 30);
  await js('WinifyAudio.stop(); audioMock.available = false; WinifyAudio.start()'); await h.wait(1800);
  check('no loopback device: visualizer empty, no dialog, no exception', (await litVs('window.__silent')) === 0 && JSON.parse(await js('JSON.stringify(loud)')).length === 0);
  check('...and the log says why', logs.some((m) => /\[winify\/vis\] no system audio to visualize \(no loopback device\)/.test(m)), logs.filter((m) => /winify\/vis/.test(m)).slice(-2).join(' | '));

  const conns = JSON.parse(await js('JSON.stringify(connections)'));
  check('nothing connected to the audio output', conns.length > 0 && !conns.some((c) => c.toDestination), JSON.stringify(conns.slice(0, 6)));
  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
