// My playlists: the local index (webamp-library-index.js) and Jump to track's
// two modes, against the fake Spotify.
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 240000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 240) : '')); };
  const take = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))'));
  const S = () => js('WinifySearch.state()');
  const I = () => js('WinifyIndex.status()');
  const key = async (k, mods) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods || [] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods || [] }); await h.wait(80); };
  const type = async (text) => { for (const ch of text) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch }); win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch }); await h.wait(40); } };
  const clear = () => js(`document.querySelector('.winify-search .ws-query').select()`);
  const until = async (expr, ms) => { const t = Date.now(); let v; while (!(v = await js(expr)) && Date.now() - t < ms) await h.wait(100); return v; };
  const rowsText = () => js(`[...document.querySelectorAll('.winify-search .ws-row')].map(r => [...r.children].map(c => c.textContent).join(' | ') || r.textContent)`);
  const barText = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel + ' .character')})].map(c => String.fromCharCode(+(c.className.match(/character-([0-9]+)/) || [0, 63])[1])).join('')`);
  const press = (x, y, button = 'left') => { win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 }); };
  const centre = (sel, i = 0) => js(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) }; })()`);
  const plays = (cs) => cs.filter((c) => c[0] === 'api:play').map((c) => JSON.parse(c[2]));
  // The index's reads (the playlist window reads "big", the one playing, on its own).
  const indexReads = (cs) => cs.filter((c) => (c[0] === 'api:playlistItems' && c[1] !== 'big') || (c[0] === 'api:savedTracks' && c[1] != null));

  // A small library: two playlists of yours (song 7003 in both), one of
  // someone else's, an empty one, and Liked Songs.
  await js(`(() => {
    PLAYLISTS.length = 0;
    const pl = (id, name, owner, snap, total) => ({ id, name, uri: 'spotify:playlist:' + id, owner: { id: owner }, collaborative: false, snapshot_id: snap, items: { total } });
    PLAYLISTS.push(pl('pa', 'Road Trip', 'user1', 'a1', 3), pl('pb', 'Gym', 'user1', 'b1', 2), pl('pc', 'Theirs', 'someone', 'c1', 2), pl('pe', 'Empty', 'user1', 'e1', 0));
    CONTEXTS['spotify:playlist:pa'] = [7001, 7002, 7003];
    CONTEXTS['spotify:playlist:pb'] = [7003, 7004];
    CONTEXTS['spotify:playlist:pc'] = [7008, 7009];
    CONTEXTS['spotify:user:user1:collection'] = [7005, 7001];
  })()`);
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:playlist:big", 0), mock.setPaused(false))'); await h.wait(1500);

  console.log('1. Paused (as in every other suite): no requests');
  await take(); await h.wait(1500);
  check('no index requests while paused', indexReads(await take()).length === 0);
  check('nothing indexed yet', (await I()).lists === 0, JSON.stringify(await I()));

  console.log('2. The first build: your playlists and Liked Songs, nothing else');
  await js(`localStorage.removeItem('winify.index.paused')`); await take();
  await js('WinifyIndex.restart({ gapMs: 40 })');
  await until('!WinifyIndex.status().building && WinifyIndex.status().lists === 3', 15000);
  let cs = await take(); let reads = indexReads(cs);
  check('read: Liked Songs, Road Trip, Gym - one page each, not "Theirs" or the empty one',
    JSON.stringify(reads.map((c) => c[0] === 'api:savedTracks' ? 'liked@' + c[1] : c[1] + '@' + c[2] + '/' + c[3])) === JSON.stringify(['liked@0', 'pa@0/50', 'pb@0/50']), JSON.stringify(reads));
  check('the playlist list came from the picker\'s own read (one page)', cs.filter((c) => c[0] === 'api:myPlaylists').length === 1, JSON.stringify(cs.filter((c) => c[0] === 'api:myPlaylists')));
  let st = await I();
  check('5 songs in 3 lists, finished', st.songs === 5 && st.lists === 3 && !st.building && st.requests === 3, JSON.stringify(st));

  console.log('3. My playlists: the default, instant, no requests');
  await h.click(win, js, '#title-bar', 0.3, 0.5); await h.wait(150);
  await key('J'); await h.wait(400); await take();
  let s = await S();
  check('J opens in My playlists mode, shown in the bottom bar', s.open && s.mode === 'mine' && /^my playlists/.test(await barText('.winify-search .ws-info')), JSON.stringify(s) + ' ' + await barText('.winify-search .ws-info'));
  await type('7003'); await h.wait(150);
  s = await S(); let rows = await rowsText();
  check('results as you type: song 7003, with both its playlists, the first bracketed', s.results === 1 && /^1\. Song 7003 \| Artist 7003 \| \[Road Trip\], Gym \| 3:20$/.test(rows[0]), JSON.stringify(rows));
  check('no requests at all while searching', (await take()).filter((c) => /^api:/.test(c[0])).length === 0);
  await clear(); await type('artist 700'); await h.wait(150);
  check('several words, artist too: all five songs', (await S()).results === 5, JSON.stringify(await S()));
  await clear(); await type('zzz'); await h.wait(150);
  check('nothing found: said quietly', (await S()).status === 'No results in your playlists', JSON.stringify(await S()));

  console.log('4. Enter plays within the playlist; Left/Right picks which');
  await clear(); await type('7003'); await h.wait(150); await take();
  await key('Return'); await h.wait(500);
  check('Enter: Road Trip from song 7003 (position 2), window stays open', JSON.stringify(plays(await take())) === JSON.stringify([{ context_uri: 'spotify:playlist:pa', offset: { position: 2 } }]) && (await S()).open);
  await key('Right'); await h.wait(150);
  rows = await rowsText();
  check('Right: Gym chosen (bracketed); the search text is untouched', (await S()).chosen === 'Gym' && /Road Trip, \[Gym\]/.test(rows[0]) && (await js(`document.querySelector('.winify-search .ws-query').value`)) === '7003', JSON.stringify(rows));
  await key('Return'); await h.wait(500);
  check('Enter: Gym from song 7003 (position 0)', JSON.stringify(plays(await take())) === JSON.stringify([{ context_uri: 'spotify:playlist:pb', offset: { position: 0 } }]));
  await key('Left'); await h.wait(150);
  check('Left: back to Road Trip', (await S()).chosen === 'Road Trip');
  await clear(); await type('7005'); await h.wait(150); await take();
  await key('Right'); await h.wait(100);
  check('Right on a song in one list only: no choice to make', (await S()).chosen === 'Liked Songs');
  await key('Return'); await h.wait(500);
  check('Liked Songs: played within it, by the song', JSON.stringify(plays(await take())) === JSON.stringify([{ context_uri: 'spotify:user:user1:collection', offset: { uri: 'spotify:track:7005' } }]));
  await key('Return', ['shift']); await h.wait(500);
  cs = await take(); let q = cs.find((c) => c[0] === 'api:addToQueue');
  check('Shift+Enter queues it, nothing played', q && q[1] === 'spotify:track:7005' && !plays(cs).length, JSON.stringify(cs));

  console.log('5. Right-click');
  await clear(); await type('7003'); await h.wait(150);
  let r = await centre('.winify-search .ws-row', 0); press(r.x, r.y, 'right'); await h.wait(300);
  const items = await js(`[...document.querySelectorAll('#webamp-context-menu li')].map(l => l.textContent)`);
  check('Play track, Add to queue, Play this playlist from the top, and each playlist', JSON.stringify(items) === JSON.stringify(['Play trackEnter', 'Add to queueShift+Enter', 'Play this playlist from the top', 'Play in Road Trip', 'Play in Gym']), JSON.stringify(items));
  await take(); r = await centre('#webamp-context-menu li', 2); press(r.x, r.y); await h.wait(500);
  check('...Play this playlist from the top: Road Trip from position 0', JSON.stringify(plays(await take())) === JSON.stringify([{ context_uri: 'spotify:playlist:pa', offset: { position: 0 } }]));
  r = await centre('.winify-search .ws-row', 0); press(r.x, r.y, 'right'); await h.wait(300);
  r = await centre('#webamp-context-menu li', 4); press(r.x, r.y); await h.wait(500);
  check('...Play in Gym: song 7003 within Gym', JSON.stringify(plays(await take())) === JSON.stringify([{ context_uri: 'spotify:playlist:pb', offset: { position: 0 } }]));

  console.log('6. Tab: All of Spotify and back');
  await h.click(win, js, '.winify-search .ws-query'); await take(); await key('Tab'); await h.wait(900);
  cs = await take(); s = await S();
  check('Tab: All of Spotify, the same words searched on Spotify', s.mode === 'spotify' && cs.filter((c) => c[0] === 'api:search' && c[1] === '7003').length === 3 && /^all of spotify/.test(await barText('.winify-search .ws-info')), JSON.stringify(s));
  await key('Tab'); await h.wait(200);
  s = await S();
  check('Tab again: My playlists, instant, no requests', s.mode === 'mine' && s.results === 1 && (await take()).filter((c) => /^api:/.test(c[0])).length === 0, JSON.stringify(s));
  await key('Escape'); await h.wait(200);

  console.log('7. Kept current: the picker\'s refresh re-reads only what changed, one request every 3 s');
  await js('WinifyIndex.restart()'); await h.wait(300);          // the real pace
  await js(`(() => {
    PLAYLISTS[0].snapshot_id = 'a2'; CONTEXTS['spotify:playlist:pa'] = [7001, 7006];
    PLAYLISTS.splice(1, 1);                                        // Gym deleted
    CONTEXTS['spotify:user:user1:collection'] = [7007, 7005, 7001];  // a song liked
  })()`);
  await take(); await js('WinifyPicker.refresh()');
  const times = [];
  let note = null, searchBar = null, pickerBar = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const got = indexReads(await take());
    got.forEach((c) => times.push({ what: c[0] === 'api:savedTracks' ? 'liked' : c[1], at: Date.now() }));
    if (!note) {
      note = await js('WinifyIndex.progressNote()');
      if (note) {
        await js('WinifySearch.open()'); await js('WinifyPicker.open()'); await h.wait(200);
        searchBar = await barText('.winify-search .ws-info'); pickerBar = await barText('.winify-picker .wp-info');
        await js('WinifySearch.close(); WinifyPicker.close()');
      }
    }
    if (times.length >= 2 && !(await I()).building) break;
    await h.wait(100);
  }
  check('re-read: Liked Songs and Road Trip (changed), nothing else', JSON.stringify(times.map((t) => t.what)) === JSON.stringify(['liked', 'pa']), JSON.stringify(times));
  check('at least 3 s apart', times.length === 2 && times[1].at - times[0].at >= 2800, times.length === 2 ? (times[1].at - times[0].at) + ' ms' : '');
  check('progress note while it builds: "Indexing playlists: 0 of 2"', /^Indexing playlists: [01] of 2$/.test(note || ''), note);
  check('...in Jump to track\'s bottom bar and the picker\'s', /^my playlists: indexing [01]\/2/.test(searchBar || '') && /indexing [01]\/2/.test(pickerBar || ''), JSON.stringify([searchBar, pickerBar]));
  const found = await js(`['7006', '7004', '7007', '7003'].map((q) => WinifyIndex.search(q).map((r) => r.places.map((p) => p.name).join('+')).join(','))`);
  check('new songs found, deleted playlist gone: 7006 Road Trip, 7004 none, 7007 Liked, 7003 none', JSON.stringify(found) === JSON.stringify(['Road Trip', '', 'Liked Songs', '']), JSON.stringify(found));

  console.log('8. A rate limit: waits out Retry-After, then carries on');
  await js(`(() => {
    PLAYLISTS[0].snapshot_id = 'a3'; CONTEXTS['spotify:playlist:pa'] = [7001, 7010];
    const real = window.fetch; let once = true;
    window.fetch = async (u, o) => {
      if (once && /\\/playlists\\/pa\\/items/.test(String(u))) { once = false; rec('mock:429'); return new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }); }
      return real(u, o);
    };
  })()`);
  await js('WinifyIndex.restart({ gapMs: 40 })'); await take(); await js('WinifyPicker.refresh()');
  await until(`WinifyIndex.search('7010').length === 1`, 15000);
  cs = await take();
  const lim = cs.findIndex((c) => c[0] === 'mock:429');
  check('a 429, then the same page again, and it is read', lim >= 0 && cs.slice(lim + 1).some((c) => c[0] === 'api:playlistItems' && c[1] === 'pa'), JSON.stringify(cs.filter((c) => /429|playlistItems/.test(c[0]))));

  console.log('9. Kept on this Mac: still there after a restart, with no requests');
  await js(`localStorage.setItem('winify.index.paused', '1')`); await take();
  await js('WinifyIndex.restart()'); await h.wait(800);
  st = await I();
  check('the saved index loads (4 songs in 2 lists), nothing sent', st.songs === 4 && st.lists === 2 && indexReads(await take()).length === 0, JSON.stringify(st));

  const loud = JSON.parse(await js('JSON.stringify(loud)')); const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no alerts, downloads, file prompts or new windows', loud.length === 0, JSON.stringify(loud));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
