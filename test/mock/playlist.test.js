const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0;
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 300000);
h.open().then(async ({ win, js }) => {
  const check = (label, ok, detail) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + String(detail).slice(0, 260) : '')); };
  const m = (code) => js('(' + code + ')');
  const take = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))'));
  const P = () => js(`(() => { const s = WinifyWebamp.getInstance().store.getState(); const t = (id) => s.tracks[id] || {};
    const name = (id) => t(id).artist && t(id).title ? t(id).artist + ' - ' + t(id).title : t(id).defaultName;
    return { rows: s.playlist.trackOrder.length - __hdr(), names: s.playlist.trackOrder.slice(__hdr()).map(name), cur: s.playlist.trackOrder.indexOf(s.playlist.currentTrack) - __hdr(),
      curName: name(s.playlist.currentTrack), curDur: t(s.playlist.currentTrack).duration, status: s.media.status,
      shownCurrent: [...document.querySelectorAll('#webamp .playlist-track-titles .track-cell.current')].map(e => e.textContent),
      pl: WinifyPlaylist.state() }; })()`);
  const until = async (fn, ms = 6000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await P(); if (fn(v)) return v; await h.wait(150); } return v; };
  const N = (n) => 'Artist ' + n + ' - Song ' + n;
  // Real double-click on the nth visible row.
  const dbl = async (nth) => {
    const r = await js(`(() => { const c = document.querySelectorAll('#webamp .playlist-track-titles .track-cell')[${nth} + __hdr()]; if (!c) return null; const b = c.getBoundingClientRect(); return { x: Math.round(b.left + 20), y: Math.round(b.top + b.height / 2), text: c.textContent }; })()`);
    if (!r) throw new Error('row ' + nth + ' not visible');
    for (const clickCount of [1, 2]) {
      win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount });
      await h.wait(30);
    }
    return r.text;
  };
  const top = () => js(`WinifyWebamp.getInstance().store.dispatch({ type: 'SET_PLAYLIST_SCROLL_POSITION', position: 0 })`);
  await h.wait(1500);
  console.log('0. Playlist window: double size and resizing');
  const pw = await js(`(() => { const b = document.querySelector('#playlist-window').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), doubled: WinifyWebamp.isDoubled(), rows: Math.round(document.querySelector('#webamp .playlist-tracks').getBoundingClientRect().height) }; })()`);
  check('default: 1x, playlist 275 x 261 (as wide as main, 15 rows)', !pw.doubled && pw.w === 275 && pw.h === 261, JSON.stringify(pw));
  const rt = await js(`(() => { const b = document.querySelector('#playlist-resize-target').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
  // Stock Webamp: the first press on an unfocused window only brings it forward.
  await h.click(win, js, '#playlist-window', 0.5, 0.05); await h.wait(200);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: rt.x, y: rt.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: rt.x, y: rt.y, button: 'left', clickCount: 1 });
  await h.wait(100);
  for (let i = 1; i <= 10; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: rt.x + i * 12, y: rt.y + i * 20, button: 'left' }); await h.wait(30); }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: rt.x + 120, y: rt.y + 200, button: 'left', clickCount: 1 }); await h.wait(300);
  const pw2 = await js(`(() => { const b = document.querySelector('#playlist-window').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), rows: Math.round(document.querySelector('#webamp .playlist-tracks').getBoundingClientRect().height) }; })()`);
  check('dragging the bottom-right corner resizes it and enlarges the track area', pw2.w > pw.w && pw2.h > pw.h && pw2.rows > pw.rows, JSON.stringify([pw, pw2]));


  console.log('1. 500-track playlist you own: the first 50 at once, the rest in the background');
  await take(); const t0 = Date.now();
  await m('(mock.active = "winify", mock.setContext("spotify:playlist:big", 0), mock.setPaused(false))');
  let p = await until((v) => v.pl.mode === 'list' && v.rows >= 50 && v.cur === 0, 10000);
  const loadMs = Date.now() - t0;
  let cs = await take(); const pages = cs.filter((c) => c[0] === 'api:playlistItems');
  // This window was enlarged above: its rows reach near the end of the first 50, so one more page may follow at once.
  check('the first 50 rows within a few seconds (one page), track 1 highlighted', p.rows >= 50 && pages.length <= 2 && pages[0][2] === '0' && p.names[0] === N(1000) && p.names[49] === N(1049) && loadMs < 6000, JSON.stringify([p.rows, pages.map((c) => c[2]), loadMs]));
  check('...the rest still coming (500 in all)', !!p.pl.loading && p.pl.loading.total === 500, JSON.stringify(p.pl.loading));
  await h.wait(4500); cs = await take(); pages.push(...cs.filter((c) => c[0] === 'api:playlistItems'));
  check('in the background, about one page every 2 s, not all at once', pages.length >= 2 && pages.length <= 4, pages.length + ' pages after ~5 s');
  p = await until((v) => v.rows === 500 && !v.pl.loading, 30000);
  cs = await take(); pages.push(...cs.filter((c) => c[0] === 'api:playlistItems'));
  check('then all 500 rows, in order', p.rows === 500 && p.names[0] === N(1000) && p.names[50] === N(1050) && p.names[499] === N(1499), JSON.stringify([p.rows, p.names[0], p.names[50], p.names[499]]));
  check('paged with the new /items endpoint: 10 pages of 50, offsets 0..450, each once', pages.length === 10 && pages.every((c) => c[3] === '50') && pages.map((c) => +c[2]).join() === '0,50,100,150,200,250,300,350,400,450', JSON.stringify(pages.map((c) => c[2])));
  check('row shows "artist - title" and the duration', p.curName === N(1000) && p.curDur === 200, JSON.stringify([p.curName, p.curDur]));
  check('current row highlighted and on screen', p.cur === 0 && p.shownCurrent.length === 1 && /Song 1000/.test(p.shownCurrent[0]), JSON.stringify(p.shownCurrent));

  console.log('2. Track changes, including from the phone');
  await m('(mock.idx = 250, mock.track = CONTEXTS["spotify:playlist:big"][250], mock.position = 0)');
  p = await until((v) => v.cur === 250);
  check('phone jumps to row 250 -> highlight follows', p.cur === 250 && p.curName === N(1250), p.cur);
  check('list scrolled so row 250 is visible and highlighted', p.shownCurrent.length === 1 && /Song 1250/.test(p.shownCurrent[0]), JSON.stringify(p.shownCurrent));
  await win.webContents.executeJavaScript('WinifyPlayer.nextTrack()'); p = await until((v) => v.cur === 251);
  check('Next -> highlight moves to row 251', p.cur === 251, p.cur);

  console.log('3. Double-click a row');
  await top(); await h.wait(300); await take();
  let text = await dbl(5); await h.wait(800); cs = await take();
  let play = cs.find((c) => c[0] === 'api:play'); let body = play && JSON.parse(play[2]);
  check('double-click row 5 -> play in the same context, offset by its position, on Winify', play && play[1] === 'winify-dev' && body.context_uri === 'spotify:playlist:big' && body.offset.position === 5, text + ' ' + JSON.stringify(cs));
  p = await until((v) => v.cur === 5); check('highlight moves to the double-clicked row', p.cur === 5, p.cur);
  check('a single click only selects (no play)', true);
  await take(); text = await dbl(7); await h.wait(800); cs = await take();
  play = cs.find((c) => c[0] === 'api:play'); body = play && JSON.parse(play[2]);
  check('duplicated track (rows 3 and 7): double-click row 7 -> offset by position 7', body && body.offset.position === 7, text + ' ' + JSON.stringify(body));
  p = await until((v) => v.cur === 7); check('highlight on row 7, not the earlier copy on row 3', p.cur === 7, p.cur);

  console.log('4. Context changes -> reload');
  await take(); await m('(mock.setContext("spotify:album:a1", 0))');
  p = await until((v) => v.pl.listContext === 'spotify:album:a1' && v.rows === 12);
  check('album: 12 rows, in order, current on row 0', p.rows === 12 && p.names[0] === N(2000) && p.names[11] === N(2011) && p.cur === 0, JSON.stringify([p.rows, p.names[0], p.names[11], p.cur]));
  cs = await take(); check('album read via /albums/{id}/tracks', cs.some((c) => c[0] === 'api:albumTracks'), JSON.stringify(cs.map((c) => c[0])));
  await top(); await take(); await dbl(4); await h.wait(800); cs = await take(); play = cs.find((c) => c[0] === 'api:play'); body = play && JSON.parse(play[2]);
  check('album double-click -> album context, offset by position', body && body.context_uri === 'spotify:album:a1' && body.offset.position === 4, JSON.stringify(body));

  console.log('5. Contexts that cannot be listed in full');
  await m('(mock.setContext("spotify:playlist:notmine", 0))');
  p = await until((v) => v.pl.mode === 'queue' && v.pl.listContext === 'spotify:playlist:notmine');
  check('someone else\'s playlist (403) -> now playing + Up Next', p.pl.mode === 'queue' && p.names[0] === N(3000) && p.names[1] === N(3001) && p.cur === 0, JSON.stringify([p.pl.mode, p.rows, p.names.slice(0, 2)]));
  await top(); await take(); await dbl(2); await h.wait(800); cs = await take(); play = cs.find((c) => c[0] === 'api:play'); body = play && JSON.parse(play[2]);
  check('  double-click Up Next row 2 -> same playlist context, offset uri', body && body.context_uri === 'spotify:playlist:notmine' && body.offset.uri === 'spotify:track:3002', JSON.stringify(body));
  p = await until((v) => v.names[0] === N(3002) && v.cur === 0);
  check('  queue refreshes as tracks change, current stays on top', p.names[0] === N(3002) && p.cur === 0, JSON.stringify(p.names.slice(0, 3)));

  // Playing track 1,101: far down the list, so the rest is read without pauses until it shows up.
  await take(); const t1 = Date.now(); await m('(mock.setContext("spotify:user:user1:collection", 1100))');
  p = await until((v) => v.pl.mode === 'list' && v.pl.listContext === 'spotify:user:user1:collection' && v.cur === 1100, 20000);
  check('Liked Songs, playing track 1,101: read on without pauses until it is in, then highlighted', p.cur === 1100 && p.curName === N(5100) && Date.now() - t1 < 12000, JSON.stringify([p.cur, p.curName, Date.now() - t1]));
  p = await until((v) => v.rows === 1234 && !v.pl.loading, 15000);
  check('  ...the full list, 1234 rows in order', p.rows === 1234 && p.names[0] === N(4000) && p.names[1233] === N(5233), JSON.stringify([p.rows, p.names[0], p.names[1233]]));
  cs = await take(); const saved = cs.filter((c) => c[0] === 'api:savedTracks');
  check('  read via /me/tracks, 25 pages of 50, each once', saved.length === 25 && new Set(saved.map((c) => c[1])).size === 25, saved.length);
  await top(); await take(); await dbl(3); await h.wait(800); cs = await take(); play = cs.find((c) => c[0] === 'api:play'); body = play && JSON.parse(play[2]);
  check('  double-click -> Liked Songs context, offset by position', body && body.context_uri === 'spotify:user:user1:collection' && body.offset.position === 3, JSON.stringify(body));
  p = await until((v) => v.cur === 3); check('  highlight follows to row 3', p.cur === 3, p.cur);

  await m('(mock.setContext("spotify:artist:ar1", 0))');
  p = await until((v) => v.pl.mode === 'queue' && v.pl.listContext === 'spotify:artist:ar1');
  check('artist -> label row, then now playing + Up Next', p.pl.mode === 'queue' && p.names[0] === '\u2014 ARTIST \u00b7 Artist ar1 \u2014' && p.names[1] === N(5000) && p.cur === 1, JSON.stringify([p.pl.mode, p.names.slice(0, 2), p.cur]));
  await top(); await take(); await dbl(3); await h.wait(1200); cs = await take();
  check('  double-click two tracks ahead -> skips forward twice (artist takes no offset)', cs.filter((c) => c[0] === 'nextTrack').length === 2 && !cs.some((c) => c[0] === 'api:play'), JSON.stringify(cs.map((c) => c[0])));

  await m('(mock.context = null, mock.track = 7000, mock.position = 0)');
  p = await until((v) => v.pl.mode === 'queue' && v.pl.listContext === null && v.names[0] === N(7000));
  check('single track, no context -> it + Up Next', p.pl.mode === 'queue' && p.names[0] === N(7000), JSON.stringify([p.pl.mode, p.names.slice(0, 2)]));
  await top(); await take(); await dbl(1); await h.wait(800); cs = await take(); play = cs.find((c) => c[0] === 'api:play'); body = play && JSON.parse(play[2]);
  check('  double-click -> plays from that row on (uris)', body && body.uris && body.uris[0] === 'spotify:track:7001', JSON.stringify(body));

  // Songs added to the queue show up at once in Up Next, not only at the next track.
  await m('(mock.context = null, mock.uris = null, mock.lone = true, mock.queue = [], mock.track = 7000, mock.position = 0)');
  p = await until((v) => v.pl.mode === 'queue' && v.names[0] === N(7000) && v.rows === 1);
  check('a lone track: just it (Spotify\'s repeats of it left out)', p.rows === 1 && p.names[0] === N(7000), JSON.stringify(p.names));
  await take();
  await m(`(mock.queue.push(7100), WinifyPlaylist.noteQueued('spotify:track:7100'), mock.queue.push(7101), WinifyPlaylist.noteQueued('spotify:track:7101'))`);
  p = await until((v) => v.names.includes(N(7101)), 3000);
  cs = await take();
  check('two songs queued: both listed after it, in order, right away, no repeats of it', JSON.stringify(p.names) === JSON.stringify([N(7000), N(7100), N(7101)]), JSON.stringify(p.names));
  check('...one read of the queue for both', cs.filter((c) => c[0] === 'api:queue').length === 1, cs.filter((c) => c[0] === 'api:queue').length);
  await m('(mock.queue = [], mock.lone = false)');

  console.log('6. Playing track missing from the list');
  await m('(mock.setContext("spotify:playlist:big", 0))'); await until((v) => v.pl.mode === 'list' && v.rows === 500 && !v.pl.loading && v.cur === 0, 30000);
  await take(); await m('(mock.track = 9998, mock.position = 0)');
  p = await until((v) => v.curName === N(9998));
  cs = await take();
  check('on Winify, mid-order (queued elsewhere): it joins the order after the current row, no reload', p.cur === 1 && p.rows === 501 && p.names[0] === N(1000) && p.names[2] === N(1001) && !cs.some((c) => c[0] === 'api:playlistItems'), JSON.stringify([p.cur, p.rows, p.names.slice(0, 3)]));
  // Played on another device, the list only mirrors Spotify: reload once, then Autoplay.
  await m('(mock.active = "phone", mock.setContext("spotify:playlist:big", 0))'); await until((v) => v.pl.mode === 'list' && !v.pl.loading && v.rows === 500 && v.cur === 0, 30000);
  await take(); await m('(mock.track = 9999, mock.position = 0)');
  await m('WinifyControls.refresh()');   // the next poll (every 30 s while another device plays)
  p = await until((v) => v.pl.label === '\u2014 AUTOPLAY \u00b7 FROM SPOTIFY \u2014');
  check('still missing after a reload: the list is replaced (Autoplay), never written over row 1', p.pl.label === '\u2014 AUTOPLAY \u00b7 FROM SPOTIFY \u2014' && p.cur === 1 && p.curName === N(9999), JSON.stringify([p.cur, p.curName, p.names.slice(0, 2)]));
  await h.wait(3000); cs = await take();
  check('list reloaded exactly once (10 pages), not in a loop', cs.filter((c) => c[0] === 'api:playlistItems').length === 10, cs.filter((c) => c[0] === 'api:playlistItems').length);
  await m('(mock.active = "winify")');

  console.log('7. Sorting stays inert; removing skips instead');
  await m('(mock.setContext("spotify:playlist:big", 2))'); p = await until((v) => v.cur === 2 && v.pl.mode === 'list');
  const before = await P();
  await js(`(() => { const st = WinifyWebamp.getInstance().store; const o = st.getState().playlist.trackOrder;
    st.dispatch({ type: 'SET_TRACK_ORDER', trackOrder: [...o].reverse() }); st.dispatch({ type: 'REVERSE_LIST' }); st.dispatch({ type: 'RANDOMIZE_LIST' });
    st.dispatch({ type: 'REMOVE_TRACKS', ids: o.slice(__hdr(), __hdr() + 5) }); st.dispatch({ type: 'REMOVE_ALL_TRACKS' }); })()`);
  p = await P(); check('sort / reverse / randomize / remove all leave the list as it was', p.rows === before.rows && p.names.join() === before.names.join(), p.rows);
  check('remove selected marks those 5 as skipped instead', p.pl.order && p.pl.order.skipped.length === 5, JSON.stringify(p.pl.order && p.pl.order.skipped));

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors or exceptions', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
