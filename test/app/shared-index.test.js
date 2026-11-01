// The My playlists index shared by both copies (main.js keeps it in the shared
// folder; webamp-library-index.js), and its build lock: the real app, Spotify
// faked in the main process, Spotify's player script blocked.
const { app, BrowserWindow, Menu, session } = require('electron'); const fs = require('fs'), path = require('path');
const profile = path.join(__dirname, '..', '.profiles', 'app-shared-index'); fs.rmSync(profile, { recursive: true, force: true }); fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
const SHARED = process.env.WINIFY_SHARED_DIR;
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
const SCOPES = 'user-read-private user-read-email streaming user-read-playback-state user-read-currently-playing user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read';
fs.writeFileSync(path.join(profile, 'tokens.json'), JSON.stringify({ accessToken: 'fake', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600e3, scope: SCOPES }));
const PLAYLISTS = [0, 1].map((i) => ({ id: 'p' + i, name: 'Shared ' + i, uri: 'spotify:playlist:p' + i, owner: { id: 'tester' }, collaborative: false, snapshot_id: 's' + i, items: { total: 3 } }));
const sent = [];
const J = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const song = (n) => ({ uri: 'spotify:track:' + n, name: 'Song ' + n, type: 'track', duration_ms: 1000, is_playable: true, artists: [{ name: 'A' }], album: { name: 'B' } });
global.fetch = async (u, o = {}) => {
  const url = new URL(String(u)); const p = url.pathname;
  if (url.host === 'accounts.spotify.com') return J(200, { access_token: 'fake', token_type: 'Bearer', expires_in: 3600, refresh_token: 'fake-refresh', scope: SCOPES });
  if (url.host !== 'api.spotify.com') throw new Error('no network in this test');
  sent.push(p + url.search);
  if (p === '/v1/me') return J(200, { id: 'tester', product: 'premium' });
  if (p === '/v1/me/tracks') return J(200, { total: 2, items: [{ added_at: '2026-10-31T00:00:00Z', track: song(900) }, { added_at: '2026-10-30T00:00:00Z', track: song(901) }] });
  if (p === '/v1/me/playlists') return J(200, { total: 2, items: PLAYLISTS, next: null });
  const m = p.match(/^\/v1\/playlists\/p(\d)\/items$/);
  if (m) return J(200, { total: 3, items: [0, 1, 2].map((k) => ({ is_local: false, item: song(100 * (+m[1] + 1) + k) })) });
  if (p.startsWith('/v1/me/player')) return J(204, null);
  return J(404, { error: { status: 404, message: 'not in this test' } });
};
// The menu-bar menu, as last built.
let trayMenu = [];
const realBuild = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = (template) => { if (template.some((i) => /^(Quit Winify)$/.test(i.label || ''))) trayMenu = template; return realBuild(template); };
require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 240000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); };
const indexFiles = () => { try { return fs.readdirSync(path.join(SHARED, 'index')).filter((f) => f.endsWith('.json')).map(decodeURIComponent).sort(); } catch (e) { return []; } };
const lockFile = path.join(SHARED, 'index.lock');

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*.spotify.com/*', 'wss://*.spotify.com/*', 'https://*.scdn.co/*'] }, (d, cb) => cb({ cancel: true }));
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(100);
  const logs = []; win.webContents.on('console-message', (e) => logs.push(e.message || ''));
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const until = async (expr, ms) => { const t = Date.now(); let v; while (!(v = await js(expr).catch(() => false)) && Date.now() - t < ms) await wait(200); return v; };
  await until('!!(window.WinifyWebamp && WinifyWebamp.isMounted())', 20000);
  await js('WinifyIndex.restart({ gapMs: 100 })'); await js('WinifyIndex.startBuild()');

  console.log('1. Built into the shared folder');
  await until('WinifyIndex.status().lists === 3 && !WinifyIndex.status().building', 30000);
  check('Liked Songs and both playlists, one file each, in the shared folder', JSON.stringify(indexFiles()) === JSON.stringify(['spotify:playlist:p0.json', 'spotify:playlist:p1.json', 'spotify:user:tester:collection.json']), JSON.stringify(indexFiles()));
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  check('this copy held the build lock', lock.pid === process.pid && lock.copy === 'dev', JSON.stringify(lock));
  check('songs searchable from it', (await js(`WinifyIndex.search('Song 101').length`)) === 1);

  console.log('2. Another copy building: this one reads nothing from Spotify, only what it saves');
  await js(`window.spotify.index.clear()`);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, copy: 'packaged', at: Date.now() }));   // a live process, not this one
  sent.length = 0;
  await js('WinifyIndex.restart({ gapMs: 100 })'); await js('WinifyIndex.startBuild()'); await wait(3000);
  check('no playlist read sent while the other copy holds the build', !sent.some((s) => /\/playlists\/p\d\/items|\/me\/tracks\?.*offset/.test(s)), JSON.stringify(sent));
  check('...and it says so', logs.some((m) => /the other Winify is building it/.test(m)), logs.filter((m) => /index/.test(m)).slice(-3).join(' | '));
  check('...nothing shown as "Indexing" here', !(await js('WinifyIndex.status().building')));

  console.log('3. A lock left by a copy that quit: taken over');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, copy: 'packaged', at: Date.now() }));
  await js('WinifyIndex.restart({ gapMs: 100 })'); await js('WinifyIndex.startBuild()');
  await until('WinifyIndex.status().lists === 3 && !WinifyIndex.status().building', 30000);
  check('built here again, all 3', indexFiles().length === 3 && JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid === process.pid, JSON.stringify(indexFiles()));

  console.log('4. An index this copy built on its own before: moved into the shared one, not built again');
  await js(`window.spotify.index.clear()`);
  await js(`new Promise((res) => { const q = indexedDB.open('winify-index', 1); q.onupgradeneeded = () => q.result.createObjectStore('lists', { keyPath: 'uri' });
    q.onsuccess = () => { const t = q.result.transaction('lists', 'readwrite'); const s = t.objectStore('lists');
      for (const r of [{ uri: 'spotify:playlist:p0', name: 'Shared 0', snapshot: 's0', meId: 'tester', songs: [['spotify:track:100', 'Song 100', 'A', 'B', 1000, true]], next: 50, complete: true },
        { uri: 'spotify:playlist:p1', name: 'Shared 1', snapshot: 's1', meId: 'tester', songs: [['spotify:track:200', 'Song 200', 'A', 'B', 1000, true]], next: 50, complete: true },
        { uri: 'spotify:user:tester:collection', name: 'Liked Songs', snapshot: '2|2026-10-31T00:00:00Z', meId: 'tester', songs: [['spotify:track:900', 'Song 900', 'A', 'B', 1000, true]], next: 50, complete: true }]) s.put(r);
      t.oncomplete = () => { q.result.close(); res(); }; }; })`);
  sent.length = 0;
  await js('WinifyIndex.restart({ gapMs: 100 })'); await wait(3000);
  check('all 3 moved into the shared folder', indexFiles().length === 3, JSON.stringify(indexFiles()));
  check('...and not read from Spotify again (unchanged)', !sent.some((s) => /\/playlists\/p\d\/items|\/me\/tracks\?.*offset/.test(s)), JSON.stringify(sent));
  check('...its songs searchable', (await js(`WinifyIndex.search('Song 200').length`)) === 1);

  console.log('4b. The shared one already has some (the other copy opened first): the rest is still moved in');
  await js(`window.spotify.index.clear()`);
  await js(`window.spotify.index.put({ uri: 'spotify:playlist:p0', name: 'Shared 0', snapshot: 's0', meId: 'tester', songs: [], next: 0, complete: false })`);
  sent.length = 0;
  await js('WinifyIndex.restart({ gapMs: 100 })'); await wait(3000);
  const p0 = JSON.parse(fs.readFileSync(path.join(SHARED, 'index', encodeURIComponent('spotify:playlist:p0') + '.json'), 'utf8'));
  check('all 3 there, the unfinished one replaced by this copy\'s finished one, nothing read from Spotify', indexFiles().length === 3 && p0.complete && !sent.some((s) => /\/playlists\/p\d\/items|\/me\/tracks\?.*offset/.test(s)), JSON.stringify({ files: indexFiles(), p0: p0.complete, sent }));

  console.log('5. The picker: opening it again never restarts a read under way');
  await js(`localStorage.removeItem('winify.picker.v1')`); await js('WinifyWebamp.unmount()'); await wait(300);
  fs.writeFileSync(path.join(profile, 'tokens.json'), JSON.stringify({ accessToken: 'fake', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600e3, scope: SCOPES }));
  await js('location.reload()'); await until('!!(window.WinifyWebamp && WinifyWebamp.isMounted())', 20000);
  sent.length = 0;
  for (let i = 0; i < 4; i++) { await js('WinifyPicker.open()'); await wait(40); await js('WinifyPicker.close()'); await wait(40); }
  await js('WinifyPicker.open()'); await until('WinifyPicker.state().complete', 10000);
  const firstPages = sent.filter((s) => /^\/v1\/me\/playlists\?limit=50&offset=0$/.test(s)).length;
  check('opened and closed 5 times while it reads: the first page asked for once', firstPages === 1, JSON.stringify(sent) + ' ' + JSON.stringify(await js('WinifyPicker.state()')) + ' ' + logs.filter((m) => /picker|index|governor|rate|could not/i.test(m)).slice(-4).join(' | '));
  await js('WinifyPicker.close()');

  console.log('6. The menu-bar menu: the request counter, and Build full index');
  await js(`new Promise((res) => { const q = indexedDB.open('winify-index', 1); q.onsuccess = () => { const t = q.result.transaction('lists', 'readwrite'); t.objectStore('lists').clear(); t.oncomplete = () => { q.result.close(); res(); }; }; })`);
  await js('window.spotify.index.clear()');
  sent.length = 0;
  await js('WinifyIndex.restart({ gapMs: 100 })'); await wait(1000);
  const item = (re) => trayMenu.find((i) => re.test(i.label || ''));
  const counter = item(/^Spotify requests:/);
  check('the counter: "Spotify requests: N in the last hour, M today", counting what was sent', !!counter && /^Spotify requests: [1-9]\d* in the last hour, [1-9]\d* today$/.test(counter.label) && counter.enabled === false, counter && counter.label);
  const build = item(/^Build full index/);
  check('"Build full index (0 of 3)", and nothing read until it is chosen', !!build && build.label === 'Build full index (0 of 3)' && !sent.some((x) => /\/playlists\/p\d\/items/.test(x)), (build && build.label) + ' ' + JSON.stringify(sent));
  build.click();
  let paused = null;
  for (let i = 0; i < 40 && !(paused = item(/^Pause building the index/)); i++) await wait(50);
  check('choosing it starts the build; the item becomes "Pause building the index"', !!paused, trayMenu.map((i) => i.label).filter(Boolean).join(' | '));
  if (paused) paused.click();
  await until('!WinifyIndex.status().buildOn', 3000);
  check('...choosing that pauses it', !(await js('WinifyIndex.status().buildOn')) && !!item(/^Build full index/), JSON.stringify(await js('WinifyIndex.status()')));
  await js('WinifyIndex.startBuild()');
  // Up to a minute: the sections above used this minute's background allowance (the governor at work).
  await until('WinifyIndex.status().indexed === 3 && !WinifyIndex.status().buildOn', 90000); await wait(300);
  check('finished: "Index complete (3 of 3)"', !!item(/^Index complete \(3 of 3\)$/), (trayMenu.find((i) => /ndex/.test(i.label || '')) || {}).label + ' ' + JSON.stringify(await js('WinifyIndex.status()')) + ' ' + logs.filter((m) => /index/i.test(m)).slice(-4).join(' | '));

  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
});
