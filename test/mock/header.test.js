// The header row: one per list, naming the source; a label, not a track; pinned; tracks still count from 1.
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 300000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 320) : '')); };
  const key = async (k, mods) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods || [] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods || [] }); await h.wait(120); };
  const take = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))')).filter((c) => /^(api:play|api:addToQueue|nextTrack|seek)$/.test(c[0]));
  // What is on screen: the pinned header, and each visible row's number and title as Webamp shows them.
  const V = () => js(`(() => {
    const s = WinifyWebamp.getInstance().store.getState();
    const hd = document.querySelector('#webamp .winify-list-header');
    const name = hd && hd.querySelector('.wh-name');
    const tracks = document.querySelector('#webamp .playlist-tracks').getBoundingClientRect();
    const hb = hd && hd.getBoundingClientRect();
    return {
      header: hd ? hd.textContent : null, title: hd ? hd.title : null, truncated: name ? name.scrollWidth > name.clientWidth : null,
      pinnedTop: hb ? Math.round(hb.top - tracks.top) : null, fits: hb ? hb.right <= tracks.right + 0.5 : null,
      rows: [...document.querySelectorAll('#webamp .playlist-track-titles .track-cell')].map(c => c.textContent.replace(/\\u00a0/g, ' ')),
      cur: s.playlist.trackOrder.indexOf(s.playlist.currentTrack), order: s.playlist.trackOrder.length,
      time: document.querySelector('#webamp .playlist-running-time-display') ? document.querySelector('#webamp .playlist-running-time-display').textContent : null,
      state: WinifyPlaylist.state(), track: mock.track };
  })()`);
  const until = async (fn, ms = 9000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await V(); if (fn(v)) return v; await h.wait(150); } return v; };
  const N = (n) => 'Artist ' + n + ' - Song ' + n;
  const scroll = (pct) => js(`WinifyWebamp.getInstance().store.dispatch({ type: 'SET_PLAYLIST_SCROLL_POSITION', position: ${pct} })`);
  const hdBox = () => js(`(() => { const r = document.querySelector('#webamp .winify-list-header').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + 6) }; })()`);
  const dbl = async (x, y) => { win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 2 }); win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 2 }); await h.wait(700); };

  await h.wait(1500);
  await js('mock.active = "winify"');

  console.log('1. A playlist with a short name');
  await js('(mock.setContext("spotify:playlist:short", 0), mock.setPaused(false))');
  let v = await until((x) => x.header && /Disco/.test(x.header) && x.cur === 1);
  check('header "— Disco House//Progressive —" first', v.header === '— Disco House//Progressive —' && v.state.header === '— Disco House//Progressive —', v.header);
  check('header row unnumbered; tracks count from 1 under it', /^\s*$/.test(v.rows[0].replace(/— .* —|Disco House\/\/Progressive|—/g, '').trim()) && /^ ?1\. /.test(v.rows[1]) && /^ ?2\. /.test(v.rows[2]), JSON.stringify(v.rows.slice(0, 3)));
  check('the current track (the first one) is highlighted under the header', v.cur === 1 && v.rows[1].endsWith(N(v.track)), JSON.stringify([v.cur, v.rows[1], v.track]));
  check('header not counted in the time: 30 tracks x 3:20 = 100:00', /\/100:00/.test(v.time || ''), v.time);
  check('state: 31 rows (header + 30), 30 tracks', v.order === 31 && v.state.count === 31, JSON.stringify([v.order, v.state.count]));

  console.log('2. Pinned while scrolling');
  await scroll(50); await h.wait(300);
  v = await V();
  check('scrolled: the header stays at the top', v.pinnedTop === 0 && v.header === '— Disco House//Progressive —', JSON.stringify([v.pinnedTop, v.header]));
  const firstShown = parseInt(v.rows[0], 10);
  check('scrolled: rows keep their numbers (row under the header is n, next n+1...)', firstShown > 1 && parseInt(v.rows[1], 10) === firstShown + 1, JSON.stringify(v.rows.slice(0, 3)));
  await scroll(0); await h.wait(300);

  console.log('3. A long name');
  await js('mock.setContext("spotify:playlist:long", 0)');
  v = await until((x) => x.header && /Deep Late-Night/.test(x.header) && x.cur === 1);
  check('long name cut off with "…" inside the dashes, still fits the window', v.truncated === true && v.fits === true && /^— Deep Late-Night/.test(v.header) && / —$/.test(v.header), JSON.stringify([v.header, v.truncated, v.fits]));
  check('full name in the tooltip', v.title === 'Deep Late-Night Minimal Techno, Dub & Hypnotic Grooves For Very Long Drives Home', v.title);

  console.log('4. Album, Liked Songs, artist, Autoplay');
  await js('mock.setContext("spotify:album:a1", 0)');
  v = await until((x) => x.header && /ALBUM/.test(x.header) && x.cur === 1);
  check('album: "— ALBUM · Album a1 —"', v.header === '— ALBUM · Album a1 —', v.header);
  await js('mock.setContext("spotify:user:user1:collection", 0)');
  v = await until((x) => x.header && /LIKED/.test(x.header) && x.cur === 1, 15000);
  check('Liked Songs: "— LIKED SONGS —"', v.header === '— LIKED SONGS —', v.header);
  await js('mock.setContext("spotify:artist:ar1", 0)');
  v = await until((x) => x.header && /ARTIST/.test(x.header));
  check('artist: "— ARTIST · Artist ar1 —", the playing track numbered 1', v.header === '— ARTIST · Artist ar1 —' && v.cur === 1 && /^ ?1\. /.test(v.rows[1]), JSON.stringify([v.header, v.rows.slice(0, 2)]));
  await js('mock.setContext("spotify:playlist:notmine", 0)');
  // The list's source is set at once; the pinned header is drawn a frame later, so wait for the header itself.
  v = await until((x) => x.header && !/ARTIST/.test(x.header) && x.state.listContext === 'spotify:playlist:notmine');
  check('a playlist you only follow (Up Next): its name', v.header === '— Playlist notmine —', v.header);
  await js('mock.setContext("spotify:album:a1", 11)'); await until((x) => x.header && /ALBUM/.test(x.header) && x.cur === 12);
  await js('mock.startAutoplay(true)');
  v = await until((x) => x.header && /AUTOPLAY/.test(x.header) && x.track === 9000 && x.cur === 1);
  check('Autoplay: one header, "— AUTOPLAY · FROM SPOTIFY —", not two', v.header === '— AUTOPLAY · FROM SPOTIFY —' && !v.rows.slice(1).some((r) => /AUTOPLAY/.test(r)), JSON.stringify(v.rows.slice(0, 3)));

  console.log('5. A label, not a track');
  await js('mock.setContext("spotify:album:a1", 3)');
  v = await until((x) => x.header && /ALBUM/.test(x.header) && x.cur === 4);
  // Select the header row (Select all includes it) and try everything.
  await h.click(win, js, '#playlist-window', 0.5, 0.02);
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'CLICKED_TRACK', index: 0 })`);
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'DRAG_SELECTED', offset: 3 })`); await h.wait(200);
  v = await V();
  check('header cannot be dragged', v.header === '— ALBUM · Album a1 —' && /ALBUM/.test(v.rows[0]) && /^ ?1\. /.test(v.rows[1]), JSON.stringify(v.rows.slice(0, 3)));
  await key('Delete'); await h.click(win, js, '#webamp #playlist-remove-menu'); await h.wait(200);
  v = await V();
  check('header cannot be removed (Delete, REM)', v.state.order.removed.length === 0 && /ALBUM/.test(v.rows[0]), JSON.stringify(v.state.order.removed));
  const entry = await js(`(() => { const s = WinifyWebamp.getInstance().store.getState(); return WinifyPlaylist.state() && s.playlist.trackOrder[0]; })()`);
  check('header has no track behind it (nothing to queue)', await js(`(async () => { const m = await import('/webamp-playlist.js'); return m.entryById(${entry}) === null; })()`));
  // A track dragged above the header: the header goes back on top.
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'CLICKED_TRACK', index: 2 })`);
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'DRAG_SELECTED', offset: -2 })`); await h.wait(200);
  v = await V();
  check('a track dragged above the header lands under it instead', /ALBUM/.test(v.rows[0]) && v.rows[1].endsWith(N(2001)) && v.rows[2].endsWith(N(2000)), JSON.stringify(v.rows.slice(0, 4)));
  // The header's tooltip and double-click.
  await take();
  const hb = await hdBox(); await dbl(hb.x, hb.y);
  let cs = await take(); let pl = cs.find((c) => c[0] === 'api:play'); let body = pl && JSON.parse(pl[2]);
  check('double-click the header: plays the list from its first track (row 1 now: 2001)', body && body.context_uri === 'spotify:album:a1' && body.offset.position === 1, JSON.stringify(cs));
  v = await until((x) => x.track === 2001 && x.cur === 1);
  check('...and it is highlighted as track 1', v.cur === 1 && v.rows[1].startsWith(' 1. ') || v.rows[1].startsWith('1. '), JSON.stringify(v.rows.slice(0, 2)));

  console.log('6. Everything else still counts the first real track as 1');
  // REM on track 2 (row 2).
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'CLICKED_TRACK', index: 2 })`); await h.click(win, js, '#webamp #playlist-remove-menu'); await h.wait(200);
  v = await V();
  check('REM on track 2 removes track 2 (2000), not the header or another', JSON.stringify(v.state.order.removed) === JSON.stringify([N(2000)]) && /ALBUM/.test(v.rows[0]) && v.rows[1].endsWith(N(2001)) && v.rows[2].endsWith(N(2002)) && /^ ?2\. /.test(v.rows[2]), JSON.stringify(v.rows.slice(0, 3)));
  await key('Z', ['meta']); await h.wait(200);
  // Double-click track 4.
  const r4 = await js(`(() => { const c = document.querySelectorAll('#webamp .playlist-track-titles .track-cell')[4].getBoundingClientRect(); return { x: Math.round(c.left + 40), y: Math.round(c.top + 6) }; })()`);
  await take(); await dbl(r4.x, r4.y);
  cs = await take(); pl = cs.find((c) => c[0] === 'api:play'); body = pl && JSON.parse(pl[2]);
  v = await until((x) => x.cur === 4);
  check('double-click track 4 plays track 4 (2003)', body && body.offset.position === 3 && v.rows[4].endsWith(N(2003)) && /^ ?4\. /.test(v.rows[4]), JSON.stringify([body, v.rows[4]]));
  // Shuffle on/off keeps the header on top.
  await h.click(win, js, '#webamp #shuffle'); await h.wait(500);
  v = await V();
  check('shuffle on: header still first, current right under it as track 1', /ALBUM/.test(v.rows[0]) && v.cur === 1 && /^ ?1\. /.test(v.rows[1]) && v.rows[1].endsWith(N(2003)), JSON.stringify(v.rows.slice(0, 3)));
  await h.click(win, js, '#webamp #shuffle'); await h.wait(500);
  v = await V();
  check('shuffle off: header first, album order back, 2003 is track 4 again', /ALBUM/.test(v.rows[0]) && v.cur === 4 && v.rows[4].endsWith(N(2003)), JSON.stringify(v.rows.slice(0, 5)));

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
