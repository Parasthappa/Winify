// Real Winify app (main.js, preload, page), isolated profile, a remembered sign-in, Spotify faked locally:
// Winify's one see-through window - its bounds, the chassis staying, click-through, minimize/close/restore,
// Disconnect, layouts as screen positions, Milkdrop full screen.
const { app, BrowserWindow, session, net, protocol } = require('electron'); const fs = require('fs'), path = require('path');
const profile = path.join(__dirname, '..', '.profiles', 'app-window-app'); fs.rmSync(profile, { recursive: true, force: true }); fs.mkdirSync(profile, { recursive: true });
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
const realFetch = global.fetch;
global.fetch = async (u, o = {}) => {
  const url = String(u);
  if (/^https:\/\/(api|accounts)\.spotify\.com\//.test(url)) { const r = spotify(o.method || 'GET', url); return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } }); }
  return realFetch(u, o);
};
// What the window is told about click-through.
const { BrowserWindow: BW } = require('electron');
const ignoreCalls = [];
const realIgnore = BW.prototype.setIgnoreMouseEvents;
BW.prototype.setIgnoreMouseEvents = function (ignore, opts) { ignoreCalls.push({ ignore, forward: !!(opts && opts.forward) }); return realIgnore.call(this, ignore, opts); };
require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 170000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); return ok; };
app.whenReady().then(async () => {
  const { screen } = require('electron');
  session.defaultSession.protocol.handle('https', async (req) => {
    if (new URL(req.url).host === 'api.spotify.com') { const r = spotify(req.method, req.url); return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }); }
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(100);
  const errors = []; win.webContents.on('console-message', (e) => { if (/rror/.test(e.message || '')) console.log('   page: ' + (e.message || '').slice(0, 300)); if (/Uncaught|TypeError|ReferenceError|SyntaxError/.test(e.message || '')) errors.push((e.message || '').slice(0, 200)); });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const R = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; })()`);
  const mounted = async () => { for (let i = 0; i < 150 && !(await js('!!(window.WinifyWebamp && WinifyWebamp.isMounted())').catch(() => false)); i++) await wait(100); return js('WinifyWebamp.isMounted()'); };
  const move = async (x, y, buttons) => { win.webContents.sendInputEvent({ type: 'mouseMove', x, y, modifiers: buttons ? ['leftButtonDown'] : [] }); await wait(120); };
  const passing = () => ignoreCalls.length ? ignoreCalls[ignoreCalls.length - 1].ignore : null;
  const visible = () => js('WinifyAudio.isVisible()');
  const click = async (sel, fx = 0.5, fy = 0.5) => { const r = await R(sel); if (!r) return false; const x = Math.round(r.x + r.w * fx), y = Math.round(r.y + r.h * fy);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await wait(40); win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await wait(150); return true; };
  const drag = async (x, y, dx, dy) => { win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await wait(60);
    for (let i = 1; i <= 10; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: x + Math.round(dx * i / 10), y: y + Math.round(dy * i / 10), modifiers: ['leftButtonDown'] }); await wait(30); }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: x + dx, y: y + dy, button: 'left', clickCount: 1 }); await wait(300); };

  console.log('1. One see-through window over the screen\'s usable area');
  const area = screen.getPrimaryDisplay().workArea;
  check('frameless, see-through, no shadow, fixed size, exactly the main display\'s usable area (not over the menu bar or Dock)',
    JSON.stringify(win.getBounds()) === JSON.stringify(area) && !win.isResizable() && !win.isFullScreenable() && win.getBackgroundColor().toLowerCase().startsWith('#000000') && (await js('getComputedStyle(document.body).backgroundColor')) === 'rgba(0, 0, 0, 0)',
    JSON.stringify({ bounds: win.getBounds(), area, bg: win.getBackgroundColor() }));
  check('clicks pass through until the page says otherwise (mouse moves still forwarded)', ignoreCalls.length > 0 && ignoreCalls[0].ignore === true && ignoreCalls[0].forward === true, JSON.stringify(ignoreCalls.slice(0, 2)));
  check('player shown after the remembered sign-in', await mounted());
  await wait(1500);

  console.log('2. The chassis stays, connected, bottom-right');
  const st = () => js(`(() => { const q = (s) => document.querySelector(s); const s = q('#login-screen [role=status]'); const c = q('#login-screen .sa-cta'); return { status: s && s.textContent.trim(), cta: c && c.textContent.trim(), signedOutState: q('#login-screen').classList.contains('is-active'), player: q('#app-screen').classList.contains('is-active'), shown: getComputedStyle(q('#login-screen')).display !== 'none' }; })()`);
  let c = await st(); let box = await R('#login-screen');
  check('chassis shown with CONNECTED and Disconnect, beside the player', c.shown && /CONNECTED/.test(c.status || '') && c.cta === 'Disconnect' && c.player && !c.signedOutState, JSON.stringify(c));
  check('...at the bottom-right of the screen, at its current size (446 x 350)', box.w === 446 && box.h === 350 && box.r === area.width - 16 && box.b === area.height - 16, JSON.stringify(box));
  const main0 = await R('#webamp #main-window');
  check('Webamp\'s windows are on screen too, not under the chassis', !!main0 && (main0.r <= box.x || main0.b <= box.y), JSON.stringify(main0));

  console.log('3. Click-through');
  await move(5, Math.round(area.height / 2));
  check('pointer over an empty part: clicks pass through', passing() === true);
  await move(main0.x + 100, main0.y + 50);
  check('over a Webamp window: Winify takes the clicks', passing() === false);
  await move(5, 5);
  check('empty again: through', passing() === true);
  await move(box.x + box.w / 2, box.y + box.h / 2);
  check('over the chassis: Winify', passing() === false);
  const play = await R('#webamp #play');   // a button: holding it moves nothing
  win.webContents.sendInputEvent({ type: 'mouseMove', x: play.x + 5, y: play.y + 5 }); await wait(100);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: play.x + 5, y: play.y + 5, button: 'left', clickCount: 1 }); await wait(100);
  await move(5, Math.round(area.height / 2), true);
  check('a drag that strays over an empty part keeps the clicks until let go', passing() === false);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: 5, y: Math.round(area.height / 2), button: 'left', clickCount: 1 }); await wait(200);
  await move(6, Math.round(area.height / 2));
  check('...then through again', passing() === true);
  await js('WinifySearch.open()'); await wait(500);
  await move(5, 5);
  check('search open: the empty parts still pass clicks through (no backdrop; panels stay open)', passing() === true && (await js('WinifySearch.isOpen()')));
  await js('WinifySearch.close()'); await wait(300); await move(6, 6);

  console.log('3b. Click-through without forwarded mouse moves (another app active, after a restore)');
  // The main process reads the pointer itself; here that reading is set by the test, and no mouse
  // event reaches the page - as when Finder or the desktop has the clicks.
  const realCursor = screen.getCursorScreenPoint.bind(screen);
  let fake = null;
  screen.getCursorScreenPoint = () => fake || realCursor();
  const at = async (x, y) => { fake = { x: area.x + Math.round(x), y: area.y + Math.round(y) }; await wait(250); };
  await js('WinifyPassThrough.ignoreRealMouse(true)');   // a real mouse moving during the run must not count
  win.blur(); await wait(300);
  check('Winify not focused', !win.isFocused() && !(await js('document.hasFocus()')));
  await at(5, area.height / 2);
  check('pointer over an empty part: through', passing() === true);
  await at(main0.x + 100, main0.y + 50);
  check('over a Webamp window: Winify takes the click, though it is not the active app (no mouse events needed)', passing() === false);
  await at(box.x + box.w / 2, box.y + box.h / 2);
  check('over the chassis: Winify', passing() === false);
  fake = { x: area.x + area.width + 50, y: area.y + 10 }; await wait(250);
  check('pointer off the window (another display, the menu bar): through', passing() === true);
  await at(main0.x + 100, main0.y + 50);
  check('back over a window: Winify again', passing() === false);
  win.minimize(); await wait(1000); await at(5, 5); await at(main0.x + 100, main0.y + 50);
  const callsWhileMin = ignoreCalls.length;
  app.emit('activate'); await wait(600);
  check('restored with the pointer already over a window: clickable straight away', !win.isMinimized() && passing() === false, JSON.stringify(ignoreCalls.slice(callsWhileMin)));
  await at(5, 5);
  check('...and the empty parts pass through again', passing() === true);
  // The chassis: only its own shape (design px, scaled 0.356 from its box corner at design 14,27).
  const dp = (x, y) => ({ x: box.x + Math.round((x - 14) * 0.356), y: box.y + Math.round((y - 27) * 0.356) });
  const hitAt = async (q) => js(`(() => { const e = document.elementFromPoint(${q.x}, ${q.y}); return e && e !== document.body && e !== document.documentElement; })()`);
  const outside = [[70, 64], [1214, 64], [30, 380], [50, 200], [200, 965], [1100, 965], [1232, 260]];
  const inside = [[640, 500], [640, 960], [50, 380], [150, 120], [1200, 800]];
  const outHits = []; for (const [x, y] of outside) if (await hitAt(dp(x, y))) outHits.push([x, y]);
  const inMiss = []; for (const [x, y] of inside) if (!(await hitAt(dp(x, y)))) inMiss.push([x, y]);
  fs.writeFileSync(path.join(__dirname, '..', '.output', 'window-chassis.png'), (await win.webContents.capturePage({ x: box.x - 20, y: box.y - 20, width: box.w + 40, height: box.h + 40 })).toPNG());
  check('chassis: no dark rectangle behind it', (await js(`getComputedStyle(document.querySelector('#sa-stage > div')).backgroundImage`)) === 'none');
  check('...clicks around its angled edges pass through; on its shape they are caught', !outHits.length && !inMiss.length, JSON.stringify({ outHits, inMiss }));
  await at(dp(70, 64).x, dp(70, 64).y);
  check('...the window passes them through there', passing() === true);
  fake = null;
  await js('WinifyPassThrough.ignoreRealMouse(false)');
  win.focus(); await wait(300);

  console.log('4. Windows anywhere on screen; layouts as screen positions');
  await drag(main0.x + 40, main0.y + 6, area.width - 275 - main0.x, 0);
  const main1 = await R('#webamp #main-window');
  check('the main window drags right across the screen (its own edge snapping)', main1.r >= area.width - 20 && main1.y === main0.y, JSON.stringify({ main0, main1 }));
  await wait(800);
  const saved = await js(`JSON.parse(localStorage.getItem('winify.layout.v2'))`);
  check('saved as screen positions', saved && saved.screen === true && saved.positions.main.x === main1.x, JSON.stringify(saved && { screen: saved.screen, main: saved.positions.main }));

  console.log('5. Moving the chassis');
  await drag(box.x + 60, box.y + 14, -300, -200);
  const box2 = await R('#login-screen');
  check('dragged by its body', box2.x === box.x - 300 && box2.y === box.y - 200, JSON.stringify({ box, box2 }));
  check('...and remembered', JSON.stringify(await js(`JSON.parse(localStorage.getItem('winify.chassis.v1'))`)) === JSON.stringify({ x: box2.x, y: box2.y }));

  console.log('6. Yellow light, red light, the Dock, the menu bar');
  const before = { main: await R('#webamp #main-window'), chassis: await R('#login-screen'), playlist: await R('#webamp #playlist-window') };
  await click('#login-screen button[aria-label="Minimize Winify"]'); await wait(1200);
  check('yellow light: everything minimizes to the Dock together; visualizers pause', win.isMinimized() && (await visible()) === false);
  app.emit('activate'); await wait(1500);
  const after = { main: await R('#webamp #main-window'), chassis: await R('#login-screen'), playlist: await R('#webamp #playlist-window') };
  check('Dock icon: everything back exactly as it was', !win.isMinimized() && win.isVisible() && (await visible()) === true && JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }));
  await click('#login-screen button[aria-label="Close Winify"]'); await wait(800);
  check('red light: everything closes together, Winify keeps running; visualizers pause', !win.isVisible() && (await visible()) === false && (await js('WinifyWebamp.isMounted()')));
  app.emit('activate'); await wait(1200);
  check('...and comes back (menu-bar Show / Dock icon)', win.isVisible() && (await visible()) === true && JSON.stringify(await R('#webamp #main-window')) === JSON.stringify(before.main));
  // The main window's title bar has no buttons: only the lights minimize and close.
  await click('#webamp #main-window #title-bar', 249 / 275, 0.5); await wait(1200);
  check('where the main window\'s minimize button was: nothing happens', !win.isMinimized() && win.isVisible() && (await visible()) === true);
  await click('#webamp #main-window #title-bar', 269 / 275, 0.5); await wait(800);
  check('where its close button was: nothing happens', win.isVisible() && (await visible()) === true && !!(await R('#webamp #main-window')));
  await click('#webamp #playlist-window #playlist-close-button'); await wait(500);
  check('the playlist window closes on its own; everything else stays', !(await R('#webamp #playlist-window')) && win.isVisible() && !!(await R('#webamp #main-window')));
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'TOGGLE_WINDOW', windowId: 'playlist' })`); await wait(400);

  console.log('7. Keys still reach the right window');
  win.focus(); await click('#webamp #main-window', 0.3, 0.05);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'J' }); win.webContents.sendInputEvent({ type: 'char', keyCode: 'j' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'J' }); await wait(500);
  check('J opens Jump to track', await js('WinifySearch.isOpen()'));
  await js('WinifySearch.close()');

  console.log('8. Milkdrop full screen');
  await js('WinifyMilkdrop.toggle()'); for (let i = 0; i < 60 && (await js('WinifyMilkdrop.state().index')) == null; i++) await wait(150);
  const md = await R('#webamp .gen-window:not(.winify-frame)'); const pm = await R('#webamp #main-window'); const pp = await R('#webamp #playlist-window');
  check('the player is at the right edge: Milkdrop goes to the second row, under the playlist, on screen; the player does not move',
    md && md.y === pp.b && md.r <= area.width && md.b <= area.height && pm.x === area.width - 275, JSON.stringify({ md, pm, pp }));
  win.show(); win.moveTop(); win.focus(); await wait(300);   // in front, whatever else is in use on the Mac
  await js('WinifyWebamp.getInstance().store.dispatch({ type: "SET_MILKDROP_FULLSCREEN", enabled: true })');
  for (let i = 0; i < 40 && !win.isSimpleFullScreen(); i++) await wait(100);
  await wait(800);
  const disp = screen.getPrimaryDisplay().bounds;
  check('full screen covers the whole display (menu bar and Dock included)', win.isSimpleFullScreen() && JSON.stringify(win.getBounds()) === JSON.stringify(disp), JSON.stringify(win.getBounds()));
  await js('document.exitFullscreen()'); for (let i = 0; i < 40 && win.isSimpleFullScreen(); i++) await wait(100); await wait(800);
  check('...and back to the usable area after', !win.isSimpleFullScreen() && JSON.stringify(win.getBounds()) === JSON.stringify(area), JSON.stringify(win.getBounds()));
  await js('WinifyMilkdrop.toggle()');

  console.log('9. A layout saved by the old fitted window');
  await js(`localStorage.setItem('winify.layout.v2', JSON.stringify({ doubled: false, positions: { main: { x: 0, y: 0 }, playlist: { x: 0, y: 116 }, equalizer: { x: 0, y: 261 } }, playlistSize: [0, 5], shade: { main: false, equalizer: false, playlist: false }, open: { main: true, equalizer: false, playlist: true } }))`);
  win.webContents.reload(); await wait(1000);
  check('player back after a reload', await mounted()); await wait(1500);
  const conv = await R('#webamp #main-window');
  check('opened where the old window used to: centred on the screen', Math.abs((conv.x + 137) - area.width / 2) <= 2 && Math.abs((conv.y + 377 / 2) - area.height / 2) <= 2, JSON.stringify(conv));
  await wait(800);
  check('...then saved as screen positions', (await js(`JSON.parse(localStorage.getItem('winify.layout.v2')).screen`)) === true);
  check('the chassis kept its spot through the reload', JSON.stringify(await R('#login-screen')) === JSON.stringify(box2));

  console.log('10. Disconnect');
  const spot = await R('#login-screen');
  await click('#login-screen .sa-cta'); await wait(1500);
  c = await st();
  check('Disconnect: the Webamp windows go; the chassis switches to sign-in, in place', !(await js('WinifyWebamp.isMounted()')) && !(await R('#webamp #main-window')) && c.signedOutState && !c.player && c.cta !== 'Disconnect' && JSON.stringify(await R('#login-screen')) === JSON.stringify(spot), JSON.stringify(c));
  await move(5, 5);
  check('...the empty screen around it lets clicks through', passing() === true);

  check('no page errors', errors.length === 0, JSON.stringify(errors));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
