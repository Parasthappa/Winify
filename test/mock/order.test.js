// Winify's own running order: transitions, reorder, skip/undo, queue, Next/Previous, shuffle, Autoplay.
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 420000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 320) : '')); };
  const take = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))')).filter((c) => /^(api:play|api:addToQueue|api:shuffle|api:repeat|nextTrack|previousTrack|seek|mock:trackEnded)$/.test(c[0]));
  const key = async (k, mods) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods || [] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods || [] }); await h.wait(100); };
  const type = async (t) => { for (const ch of t) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch }); win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch }); await h.wait(40); } };
  const PL = () => js(`(() => { const s = WinifyWebamp.getInstance().store.getState(); const t = (id) => s.tracks[id] || {};
    const name = (id) => t(id).artist && t(id).title ? t(id).artist + ' - ' + t(id).title : t(id).defaultName;
    return { rows: s.playlist.trackOrder.slice(__hdr()).map(name), cur: s.playlist.trackOrder.indexOf(s.playlist.currentTrack) - __hdr(), state: WinifyPlaylist.state(),
      track: mock.track, queue: mock.queue.slice(), shuffleBtn: s.media.shuffle, spotifyShuffle: mock.shuffle, css: document.getElementById('winify-skipped').textContent }; })()`);
  const until = async (fn, ms = 8000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await PL(); if (fn(v)) return v; await h.wait(150); } return v; };
  const N = (n) => 'Artist ' + n + ' - Song ' + n;
  const nums = (p) => p.rows.map((r) => +(r.match(/Song (\d+)/) || [0, 0])[1]);
  const show = (p) => JSON.stringify({ order: nums(p).slice(0, 13), cur: p.cur, track: p.track, queue: p.queue, mode: p.state.mode, skipped: p.state.order && p.state.order.skipped });
  const nearEnd = (ms) => js(`(mock.position = ${200000 - ms}, mock.at = Date.now(), true)`);
  const press = (x, y, button = 'left', clickCount = 1) => { win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount }); win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount }); };
  const rowAt = (i) => js(`(() => { const c = [...document.querySelectorAll('#webamp .playlist-track-titles .track-cell')].find(c => parseInt(c.textContent.replace(/\\u00a0/g,''),10) === ${i + 1}); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) }; })()`);
  const select = (i) => js(`WinifyWebamp.getInstance().store.dispatch({ type: 'CLICKED_TRACK', index: ${i} + __hdr() })`);
  // Let a transition happen: near the end, wait for Winify to queue, then the track ends.
  const transition = async (expectQueued) => {
    await take(); await nearEnd(32000); await h.wait(4500);
    const cs = await take(); const q = cs.filter((c) => c[0] === 'api:addToQueue');
    await js('mock.trackEnded()'); await h.wait(300);
    return { cs, q, p: await until((v) => v.track !== undefined && v.rows[v.cur] === N(v.track)) };
  };

  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))');
  let p = await until((v) => v.state.mode === 'list' && v.cur === 0 && v.rows.length === 12);
  check('album listed in its order, track 1 current', p.rows.length === 12 && p.cur === 0 && p.rows[0] === N(2000), show(p));

  console.log('1. Transitions: the order\'s next track is queued ~30 s before the end; Spotify moves on itself');
  let t = await transition();
  check('the next track (2001) queued once, about 30 s before the end', t.q.length === 1 && t.q[0][1] === 'spotify:track:2001', JSON.stringify(t.cs));
  check('it plays from Spotify\'s queue (no restart, no skip): row 2 current', t.p.track === 2001 && t.p.cur === 1 && !t.cs.some((c) => c[0] === 'api:play' || c[0] === 'nextTrack'), show(t.p));

  console.log('2. Drag to reorder');
  await select(5); await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'DRAG_SELECTED', offset: -3 })`); await h.wait(300);
  p = await PL();
  check('Webamp drag moves 2005 up to right after the current track', JSON.stringify(nums(p).slice(0, 6)) === JSON.stringify([2000, 2001, 2005, 2002, 2003, 2004]) && p.cur === 1, show(p));
  // ...and a real mouse drag: 2008 (row 9) up two rows.
  await h.click(win, js, '#playlist-window', 0.5, 0.02); await h.wait(150);
  const r9 = await rowAt(8);
  if (r9) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: r9.x, y: r9.y, button: 'left', clickCount: 1 });
    for (let k = 1; k <= 6; k++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: r9.x, y: r9.y - k * 5, button: 'left' }); await h.wait(40); }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: r9.x, y: r9.y - 30, button: 'left', clickCount: 1 }); await h.wait(300);
  }
  p = await PL();
  check('mouse drag: 2008 moved up three rows (30 px)', nums(p).indexOf(2008) === 5 && nums(p).indexOf(2004) === 6, show(p));
  t = await transition();
  check('the reordered next (2005) is what gets queued and plays', t.q.length === 1 && t.q[0][1] === 'spotify:track:2005' && t.p.track === 2005 && t.p.rows[t.p.cur] === N(2005), show(t.p) + JSON.stringify(t.q));

  console.log('3. Skip (Delete, REM) and undo (Cmd+Z)');
  p = await PL(); const i2002 = nums(p).indexOf(2002);
  await h.click(win, js, '#playlist-window', 0.5, 0.02); await select(i2002); await h.wait(100);
  await key('Delete'); await h.wait(300);
  p = await PL();
  check('Delete: 2002 marked skipped, still listed', p.rows.length === 12 && p.state.order.skipped.join() === N(2002), show(p));
  check('...shown dimmed and struck through', /line-through/.test(p.css) && /opacity/.test(p.css), p.css);
  await select(nums(p).indexOf(2003)); await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'REMOVE_TRACKS', ids: WinifyWebamp.getInstance().store.getState().playlist.selectedTracks.slice() })`); await h.wait(200);
  p = await PL();
  check('REM > Remove selected: 2003 skipped too, not removed', p.rows.length === 12 && p.state.order.skipped.length === 2, show(p));
  await key('Z', ['meta']); await h.wait(200);
  p = await PL();
  check('Cmd+Z: undoes the last skip (2003 back), 2002 still skipped', p.state.order.skipped.join() === N(2002), show(p));
  t = await transition();
  check('the skipped track is passed over: 2003 queued and plays', t.q.length === 1 && t.q[0][1] === 'spotify:track:2003' && t.p.track === 2003, show(t.p) + JSON.stringify(t.q));

  console.log('4. Add to queue: plays next, then the order carries on');
  p = await PL(); const i2010 = nums(p).indexOf(2010);
  await h.click(win, js, '#playlist-window', 0.5, 0.02); await select(i2010); await h.wait(100);
  const r10 = await rowAt(i2010); press(r10.x, r10.y, 'right'); await h.wait(300);
  const items = await js(`[...document.querySelectorAll('#webamp-context-menu li')].map(l => l.firstChild.textContent)`);
  const qi = items.indexOf('Add to queue');
  const qc = await js(`(() => { const r = document.querySelectorAll('#webamp-context-menu li')[${qi}].getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }; })()`);
  await take(); press(qc.x, qc.y); await h.wait(600);
  p = await PL();
  check('right-click > Add to queue: 2010 inserted right after the current track', nums(p)[p.cur + 1] === 2010 && p.rows.length === 13 && p.queue.join() === '2010', show(p));
  // ...and one from search (not on this album): Shift+Enter on result 13 (track 6013).
  await h.click(win, js, '#title-bar', 0.3, 0.5); await h.wait(150); await key('J'); await h.wait(400); await type('road'); await h.wait(900);
  for (let k = 0; k < 13; k++) await key('Down');
  await key('Return', ['shift']); await h.wait(900); await key('Escape'); await h.wait(200);
  p = await PL();
  check('search Shift+Enter: 6013 inserted after 2010 (queued in that order)', nums(p)[p.cur + 1] === 2010 && nums(p)[p.cur + 2] === 6013 && p.rows.length === 14, show(p));
  t = await transition();
  check('at the end Winify adds nothing itself (your queue plays first); 2010 plays', t.q.filter((c) => c[1] !== 'spotify:track:6013').length === 0 && t.p.track === 2010, show(t.p) + JSON.stringify(t.cs));
  t = await transition();
  check('then 6013', t.p.track === 6013 && t.q.length === 0, show(t.p));
  const resume = nums(await PL())[(await PL()).cur + 1];
  t = await transition();
  check('then the order carries on where it was (' + resume + ', dragged there earlier)', t.q.length === 1 && nums(t.p)[t.p.cur] === resume && resume === 2008, show(t.p) + JSON.stringify(t.q));

  console.log('5. Next and Previous follow the order');
  p = await PL(); let wantNext = nums(p)[p.cur + 1]; await take();
  await h.click(win, js, '#webamp #next'); 
  p = await until((v) => v.track === wantNext && v.rows[v.cur] === N(wantNext));
  let cs = await take(); let pl = cs.find((c) => c[0] === 'api:play'); let body = pl && JSON.parse(pl[2]);
  check('Next: plays the order\'s next (' + wantNext + ') within the album, by position', body && body.context_uri === 'spotify:album:a1' && body.offset.position === wantNext - 2000 && p.rows[p.cur] === N(wantNext), JSON.stringify(cs));
  const prevWanted = nums(p)[p.cur - 1];
  await h.click(win, js, '#webamp #previous');
  p = await until((v) => v.track === prevWanted && v.rows[v.cur] === N(prevWanted));
  cs = await take();
  check('Previous (start of a track): the order\'s previous (' + prevWanted + ')', p.track === prevWanted && p.rows[p.cur] === N(prevWanted), JSON.stringify(cs));
  await js('(mock.position = 60000, mock.at = Date.now())'); await h.wait(1300); await take();
  await h.click(win, js, '#webamp #previous'); await h.wait(500);
  cs = await take();
  check('Previous a minute in: restarts the track', cs.some((c) => c[0] === 'seek' && c[1] === 0) && !cs.some((c) => c[0] === 'api:play'), JSON.stringify(cs));
  await nearEnd(8000); await h.wait(2500); await take();
  p = await PL(); wantNext = nums(p)[p.cur + 1];
  await h.click(win, js, '#webamp #next');
  p = await until((v) => v.track === wantNext && v.rows[v.cur] === N(wantNext));
  cs = await take();
  check('Next once the next track is already queued: Spotify\'s own skip reaches it', cs.some((c) => c[0] === 'nextTrack') && !cs.some((c) => c[0] === 'api:play') && p.track === wantNext, JSON.stringify(cs));

  console.log('6. Shuffle: Winify\'s, visible and editable');
  const before = await PL(); const curName = before.rows[before.cur];
  await take(); await h.click(win, js, '#webamp #shuffle'); await h.wait(600);
  p = await PL();
  check('Shuffle on: current track, then the rest reordered (played queued tracks stay above it), same tracks', p.rows[p.cur] === curName && nums(p).slice(0, p.cur).every((n) => n === 6013 || n === 2010) && JSON.stringify(nums(p).slice().sort()) === JSON.stringify(nums(before).slice().sort()) && JSON.stringify(nums(p)) !== JSON.stringify(nums(before)), show(p));
  check('shuffle on: the header is still the first row', (await js('__hdr()')) === 1, show(p));
  check('...shuffle button on; Spotify\'s shuffle untouched (off)', p.shuffleBtn === true && p.spotifyShuffle === false && p.state.order.shuffle, show(p));
  check('...skips kept (2002 still skipped)', p.state.order.skipped.join() === N(2002), show(p));
  const shuffledNext = nums(p).slice(p.cur + 1).find((n) => n !== 2002);
  t = await transition();
  check('the shuffled order\'s next is queued and plays', t.q.length === 1 && t.q[0][1] === 'spotify:track:' + shuffledNext && t.p.track === shuffledNext, show(t.p) + JSON.stringify(t.q));
  // Edit while shuffled: skip the next one.
  p = await PL(); const isSkipped = (n) => p.state.order.skipped.includes(N(n));
  const skipAt = nums(p).findIndex((n, i) => i > p.cur && !isSkipped(n)); const skipMe = nums(p)[skipAt];
  const thenMe = nums(p).slice(skipAt + 1).find((n) => !isSkipped(n) && n !== skipMe);
  await h.click(win, js, '#playlist-window', 0.5, 0.02); await select(skipAt); await key('Delete'); await h.wait(200);
  t = await transition();
  check('skip while shuffled: ' + skipMe + ' passed over, ' + thenMe + ' plays', t.p.track === thenMe && t.q.length === 1 && t.q[0][1] === 'spotify:track:' + thenMe, show(t.p) + JSON.stringify(t.q));
  const playing = (await PL()).track; const rowsBeforeOff = (await PL()).rows.slice().sort();
  await take(); await h.click(win, js, '#webamp #shuffle'); await h.wait(600);
  p = await PL();
  check('Shuffle off keeps every row, queued tracks included (' + rowsBeforeOff.length + ')', JSON.stringify(p.rows.slice().sort()) === JSON.stringify(rowsBeforeOff), show(p));
  // The album's own rows, leaving out the two queued ones (6013, and the queued copy of 2010).
  const albumRows = nums(p).filter((n) => n !== 6013); if (albumRows.filter((n) => n === 2010).length === 2) albumRows.splice(albumRows.indexOf(2010), 1);
  check('Shuffle off: original album order back, current highlighted at its own place', JSON.stringify(albumRows) === JSON.stringify([2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011]) && nums(p)[p.cur] === playing, show(p));
  check('...skips kept (2002 and ' + skipMe + ')', p.state.order.skipped.length === 2 && p.state.order.skipped.includes(N(skipMe)), show(p));
  check('...shuffle button off', p.shuffleBtn === false, show(p));
  check('...the header is still the first row', (await js('__hdr()')) === 1, show(p));
  // Spotify's shuffle turned on elsewhere: Winify takes it over.
  await take(); await js('mock.shuffle = true'); 
  p = await until((v) => v.state.order && v.state.order.shuffle && v.spotifyShuffle === false && v.shuffleBtn, 6000);
  cs = await take();
  check('Spotify\'s shuffle turned on elsewhere -> Winify shuffles instead, Spotify\'s turned off', p.state.order.shuffle && p.shuffleBtn && cs.some((c) => c[0] === 'api:shuffle' && c[1] === 'false') && nums(p)[p.cur] === p.track, show(p) + JSON.stringify(cs));
  await h.click(win, js, '#webamp #shuffle'); await h.wait(600);

  console.log('7. Running out: Spotify\'s Autoplay takes over');
  // Skip everything after 2009 except nothing: play 2009 with 2010, 2011 skipped.
  p = await PL();
  await h.click(win, js, '#playlist-window', 0.5, 0.02);
  // Every row after 2009 skipped, so the order ends with it (Delete is a toggle: repeat until all are).
  for (let tries = 0; tries < 2; tries++) {
    const q = await PL(); const at = nums(q).indexOf(2009);
    const after = nums(q).map((n, i) => (i > at ? i : -1)).filter((i) => i >= 0);
    await js(`(() => { const st = WinifyWebamp.getInstance().store; st.dispatch({ type: 'CLICKED_TRACK', index: ${after[0]} + __hdr() }); ${after.slice(1).map((i) => `st.dispatch({ type: 'CTRL_CLICKED_TRACK', index: ${i} + __hdr() });`).join('')} })()`);
    await key('Delete');
    const done = await PL();
    if (nums(done).slice(at + 1).every((n) => done.state.order.skipped.includes(N(n)))) break;
  }
  p = await PL(); const i2009 = nums(p).indexOf(2009);
  // Scroll it into the middle of the list (the top slot is under the pinned header).
  await js(`(() => { const st = WinifyWebamp.getInstance().store; const s = st.getState(); const shown = document.querySelectorAll('#webamp .playlist-track-titles .track-cell').length;
    const overflow = Math.max(0, s.playlist.trackOrder.length - shown); const want = Math.max(0, Math.min(overflow, ${i2009} + __hdr() - 4));
    st.dispatch({ type: 'SET_PLAYLIST_SCROLL_POSITION', position: overflow ? (want / overflow) * 100 : 0 }); })()`); await h.wait(300);
  const r = await rowAt(i2009);
  if (r) { press(r.x, r.y, 'left', 1); await h.wait(40); press(r.x, r.y, 'left', 2); }
  p = await until((v) => v.track === 2009 && v.rows[v.cur] === N(2009));
  check('double-click 2009 plays it', p.track === 2009, show(p));
  await h.wait(1200); await take(); await nearEnd(4000);
  p = await until((v) => v.state.label === '— AUTOPLAY · FROM SPOTIFY —' && v.track === 9000, 12000);
  cs = await take(); pl = cs.find((c) => c[0] === 'api:play'); body = pl && JSON.parse(pl[2]);
  check('order ends -> the album\'s last moment is played (2011 at 199.7 s)', body && body.offset.position === 11 && body.position_ms === 199700, JSON.stringify(cs));
  check('Spotify\'s Autoplay plays; window switches to the Autoplay list', p.track === 9000 && p.rows[0] === '— AUTOPLAY · FROM SPOTIFY —' && p.rows[p.cur] === N(9000), show(p));

  console.log('8. A new source starts a fresh order');
  await js('mock.setContext("spotify:album:a1", 0)');
  p = await until((v) => v.state.mode === 'list' && v.cur === 0 && v.rows.length === 12);
  check('album again: original order, no skips', JSON.stringify(nums(p)) === JSON.stringify([2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011]) && p.state.order.skipped.length === 0, show(p));
  await js('mock.setContext("spotify:playlist:big", 0)');
  p = await until((v) => v.state.listContext === 'spotify:playlist:big' && v.cur === 0);
  check('a playlist: its own order', p.rows.length === 500, show(p));
  await js('mock.repeat = "context"'); await h.wait(1200);
  await select(499); await js(`(() => { const s = WinifyWebamp.getInstance().store; s.dispatch({ type: 'REMOVE_TRACKS', ids: s.getState().playlist.trackOrder.slice(1 + __hdr()) }); })()`); await h.wait(200);
  t = await transition();
  check('repeat-all with nothing else left: wraps to the start (track 1 again)', t.q.length === 1 && t.q[0][1] === 'spotify:track:1000', show(t.p) + JSON.stringify(t.q));
  await js('mock.repeat = "off"');

  console.log('9. Not on Winify: nothing is queued');
  await js('mock.setContext("spotify:album:a1", 0)'); await until((v) => v.state.mode === 'list' && v.rows.length === 12);
  await js('mock.active = "phone"'); await h.wait(3500); await take();
  await nearEnd(12000); await h.wait(4500);
  cs = await take();
  check('phone playing: Winify adds nothing to the queue', !cs.some((c) => c[0] === 'api:addToQueue'), JSON.stringify(cs));
  await js('mock.active = "winify"');

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
