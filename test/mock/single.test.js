// Play track = that track, then Spotify's Autoplay (repeat off, repeat-one, repeat-all).
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 300000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); };
  const take = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))')).filter((c) => /^(api:play|api:repeat|play|pause|nextTrack|seek|mock:trackEnded)$/.test(c[0]));
  const key = async (k, mods) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods || [] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods || [] }); await h.wait(80); };
  const type = async (t) => { for (const ch of t) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch }); win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch }); await h.wait(40); } };
  const PL = () => js(`(() => { const s = WinifyWebamp.getInstance().store.getState(); const t = (id) => s.tracks[id] || {};
    const name = (id) => t(id).artist && t(id).title ? t(id).artist + ' - ' + t(id).title : t(id).defaultName;
    return { rows: s.playlist.trackOrder.slice(__hdr()).map(name), cur: s.playlist.trackOrder.indexOf(s.playlist.currentTrack) - __hdr(), state: WinifyPlaylist.state(), track: mock.track, paused: mock.paused, repeat: mock.repeat }; })()`);
  const until = async (fn, ms = 8000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await PL(); if (fn(v)) return v; await h.wait(150); } return v; };
  const N = (n) => 'Artist ' + n + ' - Song ' + n;
  const show = (p) => JSON.stringify({ rows: p.rows.slice(0, 4), cur: p.cur, mode: p.state.mode, track: p.track, paused: p.paused, repeat: p.repeat });
  const AFTER = '— Autoplay starts after this track —', REPEATING = '— Repeating this track —';
  // Search, move down to a row, Enter (= Play track).
  const playRow = async (i) => {
    await h.click(win, js, '#title-bar', 0.3, 0.5); await h.wait(150); await key('J'); await h.wait(400); await type('road'); await h.wait(900);
    for (let k = 0; k < i; k++) await key('Down');
    await take(); await key('Return'); await h.wait(600);
  };
  const nearEnd = (ms) => js(`(mock.position = ${200000 - ms}, mock.at = Date.now(), true)`);
  const next = () => h.click(win, js, '#webamp #next');

  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:playlist:big", 0), mock.setPaused(false))'); await h.wait(2500);

  console.log('1. Repeat off: the track plays to its end, then Autoplay');
  await playRow(3);
  let cs = await take(); let pl = cs.find((c) => c[0] === 'api:play'); let body = pl && JSON.parse(pl[2]);
  check('plays the track within its album', body && body.context_uri === 'spotify:album:a1' && body.offset.uri === 'spotify:track:2003', JSON.stringify(body));
  let p = await until((v) => v.state.mode === 'single');
  check('window: just the track (highlighted), then "Autoplay starts after this track"', p.rows.length === 2 && p.rows[0] === N(2003) && p.cur === 0 && p.rows[1] === AFTER, show(p));
  check('no copies of the track, no album list', p.rows.filter((r) => r === N(2003)).length === 1, show(p));
  await h.wait(1500);
  p = await PL(); check('still just the track a moment later', p.state.mode === 'single' && p.rows.length === 2, show(p));
  await nearEnd(4000);
  p = await until((v) => v.state.label === '— AUTOPLAY · FROM SPOTIFY —' && v.track === 9000, 12000);
  cs = await take(); pl = cs.find((c) => c[0] === 'api:play'); body = pl && JSON.parse(pl[2]);
  check('just before its end: the album\'s last moment is played (last track, 0.3 s before its end)', body && body.context_uri === 'spotify:album:a1' && body.offset.position === 11 && body.position_ms === 199700, JSON.stringify(body));
  check('the next album track never played', !cs.some((c) => c[0] === 'mock:trackEnded' && c[1] === 2003), JSON.stringify(cs));
  check('Spotify\'s Autoplay carries on: labelled list, autoplay track highlighted', p.rows[0] === '— AUTOPLAY · FROM SPOTIFY —' && p.cur === 1 && p.rows[1] === N(9000) && p.rows[2] === N(9001) && !p.rows.includes(N(2004)), show(p));
  await next();
  p = await until((v) => v.track === 9001 && v.rows[v.cur] === N(9001));
  check('Next in Autoplay moves on as usual', p.rows[0] === '— AUTOPLAY · FROM SPOTIFY —' && p.rows[p.cur] === N(9001) && !p.paused, show(p));

  console.log('2. Repeat off: Next during the track goes to Autoplay, not pause');
  await playRow(3); await until((v) => v.state.mode === 'single'); await h.wait(1200); await take();
  await next();
  p = await until((v) => v.state.label === '— AUTOPLAY · FROM SPOTIFY —' && v.track === 9000);
  cs = await take();
  check('Next: no SDK skip, the album is ended instead', !cs.some((c) => c[0] === 'nextTrack') && cs.some((c) => c[0] === 'api:play' && JSON.parse(c[2]).offset.position === 11), JSON.stringify(cs));
  check('...and Autoplay plays (not paused, not the next album track)', p.track === 9000 && !p.paused && p.rows[p.cur] === N(9000), show(p));

  console.log('3. Repeat-one: the track repeats; Next still reaches Autoplay');
  await js('mock.repeat = "track"'); await h.wait(1200);
  await playRow(3);
  p = await until((v) => v.state.mode === 'single' && v.rows[1] === REPEATING);
  check('window: the track, then "Repeating this track"', p.rows.length === 2 && p.rows[0] === N(2003) && p.cur === 0 && p.rows[1] === REPEATING, show(p));
  await h.wait(1200); await take();
  await nearEnd(2500); await h.wait(4500);
  cs = await take(); p = await PL();
  check('at its end it repeats: no jump, same track again', !cs.some((c) => c[0] === 'api:play') && cs.some((c) => c[0] === 'mock:trackEnded' && c[1] === 2003) && p.track === 2003 && !p.paused, JSON.stringify(cs) + ' ' + show(p));
  check('window unchanged while repeating', p.state.mode === 'single' && p.rows[1] === REPEATING && p.cur === 0, show(p));
  await next();
  p = await until((v) => v.state.label === '— AUTOPLAY · FROM SPOTIFY —' && v.track === 9000);
  cs = await take();
  check('Next: repeat turned off, then the album ended', cs.some((c) => c[0] === 'api:repeat' && c[1] === 'off') && cs.some((c) => c[0] === 'api:play' && JSON.parse(c[2]).offset.position === 11), JSON.stringify(cs));
  check('...Autoplay plays', p.track === 9000 && !p.paused && p.rows[p.cur] === N(9000), show(p));

  console.log('4. Repeat-all: the lone track repeats too');
  await js('mock.repeat = "context"'); await h.wait(1200);
  await playRow(3);
  p = await until((v) => v.state.mode === 'single' && v.rows[1] === REPEATING);
  check('window: "Repeating this track"', p.rows[1] === REPEATING, show(p));
  await h.wait(1200); await take();
  await nearEnd(3000); await h.wait(4000);
  cs = await take(); p = await PL();
  check('near its end it starts over (seek 0), the album does not carry on', cs.some((c) => c[0] === 'seek' && c[1] === 0) && p.track === 2003 && p.state.mode === 'single', JSON.stringify(cs) + ' ' + show(p));
  await js('mock.repeat = "off"'); await h.wait(1200);
  p = await until((v) => v.rows[1] === AFTER);
  check('repeat switched off -> the line changes to "Autoplay starts after this track"', p.rows[1] === AFTER && p.cur === 0, show(p));

  console.log('5. The album\'s last track, and a one-track album: they end by themselves');
  await playRow(11);
  p = await until((v) => v.state.mode === 'single' && v.rows[0] === N(2011));
  check('last track: single view', p.rows[1] === AFTER, show(p));
  await h.wait(1200); await take();
  await nearEnd(3000);
  p = await until((v) => v.state.label === '— AUTOPLAY · FROM SPOTIFY —' && v.track === 9000, 9000);
  cs = await take();
  check('no jump needed; it ends and Autoplay follows', !cs.some((c) => c[0] === 'api:play') && p.track === 9000 && p.rows[p.cur] === N(9000), JSON.stringify(cs) + ' ' + show(p));
  await playRow(11); await until((v) => v.state.mode === 'single' && v.rows[0] === N(2011)); await h.wait(1200); await take();
  await next();
  p = await until((v) => v.state.label === '— AUTOPLAY · FROM SPOTIFY —' && v.track === 9000, 9000);
  cs = await take();
  check('Next on the last track: seeks to its end, Autoplay follows', cs.some((c) => c[0] === 'seek' && c[1] === 199700) && !cs.some((c) => c[0] === 'nextTrack') && p.track === 9000, JSON.stringify(cs) + ' ' + show(p));
  await playRow(12);
  p = await until((v) => v.state.mode === 'single' && v.rows[0] === N(6012));
  check('one-track album: single view', p.rows[1] === AFTER, show(p));
  await h.wait(1200); await take(); await nearEnd(3000);
  p = await until((v) => v.state.label === '— AUTOPLAY · FROM SPOTIFY —' && v.track === 9000, 9000);
  cs = await take();
  check('...ends by itself into Autoplay', !cs.some((c) => c[0] === 'api:play') && p.rows[p.cur] === N(9000), JSON.stringify(cs) + ' ' + show(p));

  console.log('6. Another source cancels it; a lone track\'s queue is not 10 copies');
  await playRow(3); await until((v) => v.state.mode === 'single');
  await js('mock.setContext("spotify:album:a1", 0)'); // same album, from the start (as Play album would)
  p = await until((v) => v.state.mode === 'list' && v.cur === 0);
  check('the album played normally afterwards -> its full list', p.rows.length === 12 && p.rows[0] === N(2000), show(p));
  await playRow(3); await until((v) => v.state.mode === 'single');
  await js('mock.setContext("spotify:playlist:big", 2)');
  p = await until((v) => v.state.mode === 'list' && v.state.listContext === 'spotify:playlist:big' && v.cur === 2);
  check('a playlist started elsewhere -> its list', p.rows.length === 500 && p.rows[2] === N(1002), show(p));
  await h.wait(1500); await take(); await nearEnd(3000); await h.wait(4000);
  cs = await take(); check('...and no album jump happens for it', !cs.some((c) => c[0] === 'api:play'), JSON.stringify(cs));
  await js(`fetch('https://api.spotify.com/v1/me/player/play?device_id=winify-dev', { method: 'PUT', body: JSON.stringify({ uris: ['spotify:track:777'] }) })`);
  p = await until((v) => v.state.mode === 'queue' && v.rows[v.cur] === N(777));
  check('a track Spotify plays on its own: listed once, not with 10 copies', p.rows.filter((r) => r === N(777)).length === 1 && p.rows[p.cur] === N(777) && p.rows.length <= 2, show(p));

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
