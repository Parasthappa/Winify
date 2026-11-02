// Real Winify app (main.js, preload, page, CSP, audio capture, GPU), isolated profile, Spotify faked locally
// ("Blinding Lights" playing on another device). Milkdrop under the real page's security policy, and what it
// costs in CPU/GPU: closed, open, and with Winify minimized.
require('../lib/no-network');
const { app, BrowserWindow, session, net, protocol } = require('electron'); const fs = require('fs'), path = require('path');
const profile = path.join(__dirname, '..', '.profiles', 'app-milkdrop-app'); fs.rmSync(profile, { recursive: true, force: true }); fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
process.env.SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || 'test-client-id';
const SCOPES = 'user-read-private user-read-email streaming user-read-playback-state user-read-currently-playing user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read';
fs.writeFileSync(path.join(profile, 'tokens.json'), JSON.stringify({ accessToken: 'fake', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600e3, scope: SCOPES }));
const BL = { uri: 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b', id: '0VjIjW4GlUZAMYd2vXMi3b', name: 'Blinding Lights', type: 'track', duration_ms: 200040,
  artists: [{ name: 'The Weeknd', uri: 'spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ' }], album: { name: 'After Hours', uri: 'spotify:album:4yP0hdKOZPNshxUOjY0cZj', images: [] }, is_playable: true };
const started = Date.now();
function spotify(method, url) {
  const p = new URL(url).pathname;
  const J = (status, body) => ({ status, body });
  if (p === '/api/token') return J(200, { access_token: 'fake', token_type: 'Bearer', expires_in: 3600, refresh_token: 'fake-refresh', scope: SCOPES });
  if (method === 'GET' && p === '/v1/me') return J(200, { id: 'tester', product: 'premium', country: 'GB', display_name: 'Tester' });
  if (method === 'GET' && p === '/v1/me/player') return J(200, { device: { id: 'phone1', name: 'Phone', type: 'Smartphone', is_active: true, volume_percent: 50 },
    item: BL, is_playing: true, progress_ms: 30000 + (Date.now() - started), timestamp: Date.now(), context: null, shuffle_state: false, repeat_state: 'off', currently_playing_type: 'track' });
  if (method === 'GET' && p === '/v1/me/player/queue') return J(200, { currently_playing: BL, queue: [] });
  if (method === 'GET' && p === '/v1/me/player/devices') return J(200, { devices: [{ id: 'phone1', name: 'Phone', type: 'Smartphone', is_active: true }] });
  if (method === 'GET' && p === '/v1/tracks/' + BL.id) return J(200, BL);
  if (method === 'GET') return J(404, { error: { status: 404, message: 'mock: not here' } });
  return J(204, null);
}
const spotifySeen = [];
const realFetch = global.fetch;
global.fetch = async (u, o = {}) => {
  const url = String(u);
  if (/^https:\/\/(api|accounts)\.spotify\.com\//.test(url)) { spotifySeen.push((o.method || 'GET') + ' ' + new URL(url).pathname); const r = spotify(o.method || 'GET', url); return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } }); }
  return realFetch(u, o);
};
// Milkdrop > Load presets...: the macOS dialog answers with the fixtures folder.
const { dialog } = require('electron');
const dialogCalls = [];
dialog.showOpenDialog = async (...args) => { dialogCalls.push(args[args.length - 1]); return { canceled: false, filePaths: [path.join(__dirname, '..', 'fixtures', 'milkdrop')] }; };
// The menu-bar menu, as main.js builds it.
let trayMenu = null;
const realSetMenu = require('electron').Tray.prototype.setContextMenu;
require('electron').Tray.prototype.setContextMenu = function (menu) { trayMenu = menu; return realSetMenu.call(this, menu); };
const trayItem = (label) => trayMenu && trayMenu.items.find((i) => i.label === label);
// Window levels as macOS reports them, for this app's windows (test/lib/window-layers.swift).
const layers = () => require('child_process').execFileSync('swift', [path.join(__dirname, '..', 'lib', 'window-layers.swift'), String(process.pid)], { encoding: 'utf8' })
  .trim().split('\n').map((l) => { const m = l.match(/\| layer (-?\d+) \| (\S+) (\S+) (\d+)x(\d+)$/); return m ? { layer: +m[1], x: +m[2], y: +m[3], w: +m[4], h: +m[5] } : null; }).filter(Boolean);
require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 220000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 400) : '')); };
// CPU of Winify's processes over a stretch, in % of one core (app.getAppMetrics reports since the last call).
// GPU: macOS's own utilisation reading for the whole graphics card (other apps included), sampled each second.
const gpuNow = () => { try { const m = require('child_process').execSync('ioreg -r -d 1 -w 0 -c IOAccelerator', { encoding: 'utf8' }).match(/"Device Utilization %"=(\d+)/); return m ? +m[1] : null; } catch (e) { return null; } };
async function cpu(ms) {
  app.getAppMetrics();
  const gpu = [];
  for (let t = 0; t < ms; t += 1000) { await wait(1000); if (process.platform === 'darwin') gpu.push(gpuNow()); }
  const by = {};
  for (const m of app.getAppMetrics()) by[m.type] = Math.round(((by[m.type] || 0) + m.cpu.percentCPUUsage) * 10) / 10;
  by.total = Math.round(Object.values(by).reduce((a, b) => a + b, 0) * 10) / 10;
  const g = gpu.filter((v) => v != null);
  if (g.length) by.gpuBusy = Math.round(g.reduce((a, b) => a + b, 0) / g.length) + '% (' + g.join(' ') + ')';
  return by;
}
app.whenReady().then(async () => {
  session.defaultSession.protocol.handle('https', async (req) => {
    if (new URL(req.url).host === 'api.spotify.com') { spotifySeen.push(req.method + ' ' + new URL(req.url).pathname); const r = spotify(req.method, req.url); return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }); }
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(100);
  const logs = [];
  win.webContents.on('console-message', (e) => { const m = e.message || ''; logs.push(m); if (/milkdrop|CSP|Content Security|Refused|wasm/i.test(m)) console.log('   page: ' + m.slice(0, 300)); });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  for (let i = 0; i < 150 && !(await js('!!(window.WinifyWebamp && WinifyWebamp.isMounted())').catch(() => false)); i++) await wait(100);
  check('player shown (Webamp mounted) in the real app', await js('WinifyWebamp.isMounted()'));
  for (let i = 0; i < 80 && (await js('WinifyWebamp.getInstance().store.getState().media.status').catch(() => null)) !== 'PLAYING'; i++) await wait(150);
  for (let i = 0; i < 60 && !(await js('WinifyAudio.isActive()').catch(() => false)); i++) await wait(100);
  const capturing = await js('WinifyAudio.isActive()');
  console.log('   audio capture running: ' + capturing);
  await wait(2000);
  const closed = await cpu(8000);

  console.log('1. Milkdrop opens under the real security policy');
  const apiBefore = spotifySeen.length;
  await js('WinifyMilkdrop.toggle()');
  let s = null;
  for (let i = 0; i < 100; i++) { s = await js('WinifyMilkdrop.state()'); if (s.open && s.presets && s.index != null) break; await wait(150); }
  check('opens, Butterchurn and 293 presets loaded, one chosen', s.open && s.presets === 293 && s.index != null, JSON.stringify(s));
  await wait(1500);
  const r0 = (await js('WinifyMilkdrop.state()')).renders; await wait(1000); const r1 = (await js('WinifyMilkdrop.state()')).renders;
  check('drawing frames (presets compiled to WebAssembly under the policy)', !capturing || r1 - r0 > 30, (r1 - r0) + ' frames/s' + (capturing ? '' : ' (no capture on this Mac: not drawing, by design)'));
  check('no security-policy or WebAssembly errors', !logs.some((m) => /Content Security|Refused to|CompileError|wasm-unsafe-eval|WebAssembly/i.test(m)), logs.filter((m) => /Content Security|Refused|CompileError|WebAssembly/i.test(m)).slice(0, 2).join(' | '));
  const loaded = await js('WinifyMilkdrop.choosePresets()');
  const opts = dialogCalls[0] || {};
  check('Load presets: one dialog for files, folders or both', JSON.stringify(opts.properties) === '["openFile","openDirectory","multiSelections"]', JSON.stringify(opts.properties));
  check('...a folder is searched; converted off the page under the real policy; good ones added, the rest noted',
    loaded && JSON.stringify(loaded.added) === '["butterchurn","equations-only","with-shader"]' && loaded.skipped.length === 3, JSON.stringify(loaded));
  const workerPolicy = await js(`fetch('/milkdrop-convert-worker.js').then((r) => r.headers.get('content-security-policy'))`);
  check('...the converter worker runs under its own policy: no network', /default-src 'none'/.test(workerPolicy || '') && /connect-src data:/.test(workerPolicy || ''), workerPolicy);
  check('...still no security-policy errors', !logs.some((m) => /Content Security|Refused to/i.test(m)), logs.filter((m) => /Content Security|Refused/i.test(m)).slice(0, 2).join(' | '));
  const open = await cpu(10000);
  fs.writeFileSync(path.join(__dirname, '..', '.output', 'milkdrop-app.png'), (await win.webContents.capturePage()).toPNG());

  console.log('2. Full screen');
  await js('WinifyWebamp.getInstance().store.dispatch({ type: "SET_MILKDROP_FULLSCREEN", enabled: true })');
  for (let i = 0; i < 40 && !(await js('!!document.fullscreenElement')); i++) await wait(150);
  await wait(1500);
  const fsSize = await js(`(() => { const c = document.querySelector('#webamp .gen-window:not(.winify-frame) canvas') || document.querySelector('canvas'); return [c.width, c.height, window.devicePixelRatio]; })()`);
  const f0 = (await js('WinifyMilkdrop.state()')).renders; const full = await cpu(8000); const f1 = (await js('WinifyMilkdrop.state()')).renders;
  check('full screen: still drawing', !capturing || (f1 - f0) / 8 > 30, Math.round((f1 - f0) / 8) + ' frames/s, canvas ' + fsSize.join(' x '));
  await js('document.exitFullscreen()');
  for (let i = 0; i < 40 && (await js('!!document.fullscreenElement')); i++) await wait(150);
  await wait(2000);

  console.log('3. Minimized: drawing stops');
  win.minimize(); await wait(4000);   // past the minimize animation
  const h0 = (await js('WinifyMilkdrop.state()')).renders; const hidden = await cpu(8000); const h1 = (await js('WinifyMilkdrop.state()')).renders;
  check('no frames drawn while minimized', h1 === h0, (h1 - h0) + ' frames');
  await js('WinifyMilkdrop.toggle()'); await wait(1500);
  const hiddenClosed = await cpu(8000);   // the same, with Milkdrop closed: what minimizing costs anyway
  await js('WinifyMilkdrop.toggle()'); await wait(500);
  win.restore(); await wait(1500);
  const b0 = (await js('WinifyMilkdrop.state()')).renders; await wait(1000); const b1 = (await js('WinifyMilkdrop.state()')).renders;
  check('drawing resumes when restored', !capturing || b1 - b0 > 30, (b1 - b0) + ' frames/s');
  check('Milkdrop sent nothing to Spotify', spotifySeen.slice(apiBefore).every((r) => /\/me\/player/.test(r)), spotifySeen.slice(apiBefore).filter((r) => !/\/me\/player/.test(r)).join(', ') || 'only the usual playback-state polls');

  console.log('4. Desktop mode: Milkdrop as a live wallpaper');
  // The wallpaper window (opened by the page: Electron reports no address for it, so by its title).
  const wallpaper = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w !== win && w.getTitle() === 'Milkdrop');
  // The Milkdrop window open, to use its right-click menu.
  if (!(await js('WinifyMilkdrop.state().open'))) { await js('WinifyMilkdrop.toggle()'); await wait(1200); }
  check('the right-click menu offers "Desktop mode"', await js(`(() => { const c = document.querySelector('#webamp .gen-window:not(.winify-frame) canvas'); const r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 20 })); return true; })()`) && !!(await (async () => { await wait(400); return js(`[...document.querySelectorAll('#webamp-context-menu li')].some((l) => /^Desktop mode/.test(l.textContent.trim()))`); })()));
  await js(`(() => { const li = [...document.querySelectorAll('#webamp-context-menu li')].find((l) => /^Desktop mode/.test(l.textContent.trim())); li.click(); return true; })()`);
  let d = null;
  for (let i = 0; i < 80; i++) { d = await js('WinifyMilkdrop.desktop()'); if (d.drawing) break; await wait(150); }
  const wp = wallpaper();
  const primary = require('electron').screen.getPrimaryDisplay().bounds;
  check('on: a wallpaper window over the whole main display, drawing at its size; the Milkdrop window closed', d.on && d.drawing && !!wp && JSON.stringify(wp.getBounds()) === JSON.stringify(primary) && !(await js('WinifyMilkdrop.state().open')) && d.size[0] >= primary.width,
    JSON.stringify({ d, bounds: wp && wp.getBounds(), primary }));
  // Read until macOS lists it (a busy moment can miss it).
  let own = [], wl = null;
  for (let i = 0; i < 16 && !wl; i++) { own = layers(); wl = own.find((r) => r.w === primary.width && r.h === primary.height && r.y === primary.y); if (!wl) await wait(250); }
  check('...at macOS\'s desktop level (behind the desktop icons and every window); it takes no clicks', !!wl && wl.layer < -2147483603 && wp.isFocusable() === false, JSON.stringify({ wallpaper: wl, all: own.map((r) => r.layer) }));
  const d0 = (await js('WinifyMilkdrop.desktop()')).renders; const onDesktop = await cpu(8000); const d1 = (await js('WinifyMilkdrop.desktop()')).renders;
  check('...drawing steadily', !capturing || (d1 - d0) / 8 > 30, Math.round((d1 - d0) / 8) + ' frames/s');
  check('...following the presets: Next changes it there too', await (async () => { const i0 = (await js('WinifyMilkdrop.state()')).index; await js('WinifyMilkdrop.next()'); await wait(300); return (await js('WinifyMilkdrop.state()')).index !== i0; })());
  check('menu-bar menu: "Milkdrop desktop mode" ticked', !!trayItem('Milkdrop desktop mode') && trayItem('Milkdrop desktop mode').checked);
  win.minimize(); await wait(4000);
  const m0 = (await js('WinifyMilkdrop.desktop()')).renders; await wait(2000); const m1 = (await js('WinifyMilkdrop.desktop()')).renders;
  check('Winify minimized: the wallpaper window goes and nothing is drawn', !wallpaper() && m1 === m0 && (await js('WinifyMilkdrop.desktop()')).on, JSON.stringify({ frames: m1 - m0, d: await js('WinifyMilkdrop.desktop()') }));
  win.restore(); 
  for (let i = 0; i < 60 && !(await js('WinifyMilkdrop.desktop().drawing')); i++) await wait(150);
  check('restored: back, drawing', !!wallpaper() && (await js('WinifyMilkdrop.desktop().drawing')));
  await js('WinifyMilkdrop.toggle()'); await wait(800);
  check('opening the Milkdrop window ends desktop mode (wallpaper gone, the window back)', !wallpaper() && !(await js('WinifyMilkdrop.desktop().on')) && (await js('WinifyMilkdrop.state().open')) && !trayItem('Milkdrop desktop mode').checked);
  trayItem('Milkdrop desktop mode').click();
  for (let i = 0; i < 60 && !(await js('WinifyMilkdrop.desktop().drawing')); i++) await wait(150);
  check('menu-bar item: on again', !!wallpaper() && (await js('WinifyMilkdrop.desktop().drawing')));
  trayItem('Milkdrop desktop mode').click(); await wait(800);
  const after = await js('WinifyMilkdrop.desktop()');
  check('...and off: the wallpaper window closed, its drawing and audio connection let go', !wallpaper() && !after.on && !after.open && !after.drawing, JSON.stringify(after));
  check('no page errors in desktop mode', !logs.some((m) => /Uncaught|desktop mode: frame failed/.test(m)), logs.filter((m) => /Uncaught|frame failed/.test(m)).slice(0, 2).join(' | '));

  console.log('CPU, % of one core, per process type (8-10 s each, ' + (capturing ? 'capture running' : 'no capture') + '):');
  console.log('   desktop mode:       ' + JSON.stringify(onDesktop));
  console.log('   Milkdrop closed:    ' + JSON.stringify(closed));
  console.log('   Milkdrop open:      ' + JSON.stringify(open));
  console.log('   open, full screen:  ' + JSON.stringify(full));
  console.log('   open, minimized:    ' + JSON.stringify(hidden));
  console.log('   closed, minimized:  ' + JSON.stringify(hiddenClosed));
  await js('WinifyMilkdrop.toggle()');
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
