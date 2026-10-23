const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 300000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 260) : '')); };
  const take = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))')).filter((c) => /^(api:play|api:addToQueue|play|pause|nextTrack)$/.test(c[0]));
  const key = async (k, mods) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods || [] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods || [] }); await h.wait(80); };
  const type = async (t) => { for (const ch of t) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch }); win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch }); await h.wait(40); } };
  const press = (x, y, button = 'left') => { win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 }); };
  const centre = (sel, i = 0) => js(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) }; })()`);
  // What the playlist window shows: its rows and which one is highlighted (current).
  const PL = () => js(`(() => { const s = WinifyWebamp.getInstance().store.getState(); const t = (id) => s.tracks[id] || {};
    const name = (id) => t(id).artist && t(id).title ? t(id).artist + ' - ' + t(id).title : t(id).defaultName;
    return { rows: s.playlist.trackOrder.slice(__hdr()).map(name), cur: s.playlist.trackOrder.indexOf(s.playlist.currentTrack) - __hdr(), state: WinifyPlaylist.state() }; })()`);
  const until = async (fn, ms = 7000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await PL(); if (fn(v)) return v; await h.wait(150); } return v; };
  const N = (n) => 'Artist ' + n + ' - Song ' + n;
  const openSearch = async (q) => { await h.click(win, js, '#title-bar', 0.3, 0.5); await h.wait(150); await key('J'); await h.wait(400); await type(q); await h.wait(900); };
  const menuPick = async (rowIndex, label) => {
    const r = await centre('.winify-search .ws-row', rowIndex); press(r.x, r.y, 'right'); await h.wait(300);
    const items = await js(`[...document.querySelectorAll('#webamp-context-menu li')].map(l => l.firstChild.textContent)`);
    const i = items.indexOf(label); const c = await centre('#webamp-context-menu li', i); press(c.x, c.y); await h.wait(900); return items;
  };
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:playlist:big", 0), mock.setPaused(false))'); await h.wait(2500);

  console.log('1. Play a single track from search -> only that track, then Autoplay');
  await openSearch('road'); await take();
  const hint = await js(`[...document.querySelectorAll('.winify-search .ws-bottom .character')].map(c => String.fromCharCode(+(c.className.match(/character-([0-9]+)/) || [0, 63])[1])).join('')`);
  check('hint bar: mode keys plus RIGHT-CLICK: MORE', /enter: play   shift\+enter: queue   right-click: more$/.test(hint), hint);
  await key('Return'); await h.wait(900);
  let cs = await take(); let play = cs.find((c) => c[0] === 'api:play'); let body = play && JSON.parse(play[2]);
  check('Enter plays that track, within its album (so Autoplay can follow)', body && JSON.stringify(body) === JSON.stringify({ context_uri: 'spotify:album:a1', offset: { uri: 'spotify:track:2000' } }), JSON.stringify(body));
  let p = await until((v) => v.rows[v.cur] === N(2000) && v.state.mode === 'single');
  check('playlist window: that track, highlighted, then the Autoplay line', p.cur === 0 && p.rows[0] === N(2000) && p.rows[1] === '— Autoplay starts after this track —' && p.rows.length === 2, JSON.stringify({ cur: p.cur, rows: p.rows.slice(0, 3), label: p.state.label }));
  await js('mock.startAutoplay(false)');   // the track ends; Spotify's Autoplay carries on
  p = await until((v) => v.state.label === '— AUTOPLAY · FROM SPOTIFY —' && v.rows[v.cur] === N(9000));
  check('it ends -> list becomes "Autoplay": label row, then the autoplay track highlighted, then its queue', p.rows[0] === '— AUTOPLAY · FROM SPOTIFY —' && p.cur === 1 && p.rows[1] === N(9000) && p.rows[2] === N(9001) && !p.rows.includes(N(2000)), JSON.stringify({ cur: p.cur, rows: p.rows.slice(0, 4) }));
  await js('WinifyPlayer.nextTrack()');
  p = await until((v) => v.rows[v.cur] === N(9001) && v.rows[2] === N(9002));
  check('next autoplay track: list refreshed, current highlighted, row 1 still the label', p.rows[0] === '— AUTOPLAY · FROM SPOTIFY —' && p.cur === 1 && p.rows[1] === N(9001) && p.rows[2] === N(9002), JSON.stringify({ cur: p.cur, rows: p.rows.slice(0, 4) }));

  console.log('2. Play album / Play artist from the right-click menu');
  await openSearch('road'); await take();
  const items = await menuPick(3, 'Play album');
  check('menu: Play track, Add to queue, Play album, Play artist', JSON.stringify(items) === JSON.stringify(['Play track', 'Add to queue', 'Play album', 'Play artist']), JSON.stringify(items));
  const keys = await js(`[...document.querySelectorAll('#webamp-context-menu .hotkey')].map(k => k.textContent)`);
  cs = await take(); play = cs.find((c) => c[0] === 'api:play'); body = play && JSON.parse(play[2]);
  check('Play album: the album from that track', body && body.context_uri === 'spotify:album:a1' && body.offset.uri === 'spotify:track:2003', JSON.stringify(body));
  p = await until((v) => v.state.listContext === 'spotify:album:a1' && v.cur === 3 && v.state.mode === 'list');
  check('...playlist window: the album, that track highlighted', p.rows.length === 12 && p.cur === 3 && p.rows[3] === N(2003), JSON.stringify({ cur: p.cur, n: p.rows.length }));
  await openSearch('road'); await take();
  await menuPick(4, 'Play artist');
  cs = await take(); play = cs.find((c) => c[0] === 'api:play'); body = play && JSON.parse(play[2]);
  check('Play artist: the artist as the source (Spotify takes no start track)', body && JSON.stringify(body) === JSON.stringify({ context_uri: 'spotify:artist:sa4' }), JSON.stringify(body));
  p = await until((v) => v.state.listContext === 'spotify:artist:sa4' && v.state.label);
  check('...playlist window: labelled with the artist, current highlighted, Spotify\'s queue for them', p.rows[0] === '— ARTIST · Artist 4 —' && p.cur === 1 && p.rows.length > 2, JSON.stringify({ cur: p.cur, rows: p.rows.slice(0, 3) }));
  await openSearch('road');
  const r0 = await centre('.winify-search .ws-row', 0); press(r0.x, r0.y, 'right'); await h.wait(300);
  const hk = await js(`[...document.querySelectorAll('#webamp-context-menu li')].map(l => l.textContent)`);
  check('shortcuts shown beside items that have one', JSON.stringify(hk) === JSON.stringify(['Play trackEnter', 'Add to queueShift+Enter', 'Play album', 'Play artist']), JSON.stringify(hk));
  await key('Escape'); await key('Escape');

  console.log('3. An album runs out into Autoplay');
  for (const keep of [true, false]) {
    await js('(mock.setContext("spotify:album:a1", 11), mock.setPaused(false))');
    p = await until((v) => v.state.listContext === 'spotify:album:a1' && v.cur === 11 && v.state.mode === 'list');
    check('album playing, last track highlighted', p.cur === 11, JSON.stringify({ cur: p.cur }));
    await js(`mock.startAutoplay(${keep})`);
    p = await until((v) => v.state.label === '— AUTOPLAY · FROM SPOTIFY —' && v.rows[v.cur] === N(9000));
    const albumLeft = p.rows.filter((r) => /Song 20\d\d/.test(r)).length;
    check(`Autoplay takes over (${keep ? 'old album still reported as the source' : 'no source reported'}): list fully replaced`, albumLeft === 0 && p.rows[0] === '— AUTOPLAY · FROM SPOTIFY —' && p.cur === 1 && p.rows[2] === N(9001), JSON.stringify({ cur: p.cur, rows: p.rows.slice(0, 4), albumLeft }));
    for (let i = 1; i <= 2; i++) {
      await js('WinifyPlayer.nextTrack()');
      p = await until((v) => v.rows[v.cur] === N(9000 + i) && v.rows[2] === N(9001 + i));
      check(`  autoplay track ${i + 1}: highlighted on row 2, never written over row 1`, p.rows[0] === '— AUTOPLAY · FROM SPOTIFY —' && p.cur === 1 && p.rows[1] === N(9000 + i), JSON.stringify({ cur: p.cur, rows: p.rows.slice(0, 3) }));
    }
  }
  await js('(mock.setContext("spotify:album:a1", 2), mock.setPaused(false))');
  p = await until((v) => v.state.mode === 'list' && v.state.listContext === 'spotify:album:a1' && v.cur === 2);
  check('playing the album again afterwards brings its list back', p.cur === 2 && p.state.label === '— ALBUM · Album a1 —' && p.rows.length === 12, JSON.stringify({ cur: p.cur, label: p.state.label }));

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
