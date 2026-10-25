// Random mix: the Winamp logo makes a shuffled mix of your own playlists, played through Winify's order.
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 300000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); };
  const take = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))'));
  const PL = () => js(`(() => { const s = WinifyWebamp.getInstance().store.getState(); const t = (id) => s.tracks[id] || {};
    const name = (id) => t(id).artist && t(id).title ? t(id).artist + ' - ' + t(id).title : t(id).defaultName;
    return { rows: s.playlist.trackOrder.slice(__hdr()).map(name), cur: s.playlist.trackOrder.indexOf(s.playlist.currentTrack) - __hdr(), state: WinifyPlaylist.state(), track: mock.track, paused: mock.paused }; })()`);
  const until = async (fn, ms = 8000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await PL(); if (fn(v)) return v; await h.wait(150); } return v; };
  const show = (p) => JSON.stringify({ rows: p.rows.slice(0, 3), n: p.rows.length, cur: p.cur, mode: p.state.mode, ctx: p.state.listContext, header: p.state.header, mix: p.state.mix, track: p.track, paused: p.paused });
  const plays = (cs) => cs.filter((x) => x[0] === 'api:play').map((x) => JSON.parse(x[2]));
  const messages = () => js('JSON.stringify(__said.splice(0))').then(JSON.parse);
  const nearEnd = (ms) => js(`(mock.position = ${200000 - ms}, mock.at = Date.now(), true)`);
  const id = (n) => +String(n).split(':').pop();

  // Every playlist as long as Spotify says (10 + i songs), each its own songs,
  // except song 777, which every playlist has. Some are local files, some unavailable.
  await js(`(() => {
    PLAYLISTS.forEach((p, i) => { CONTEXTS[p.uri] = Array.from({ length: p.items.total }, (_, k) => k % 6 === 3 ? 777 : 100000 + i * 1000 + k); });
    PLAYLISTS[2].items.total = 0; CONTEXTS[PLAYLISTS[2].uri] = [];
    mock.itemOf = (n) => { const t = T(n); if (n % 7 === 1) { t.uri = 'spotify:local:x:y:' + n; t.is_local = true; } if (n % 5 === 2) t.is_playable = false;
      return { added_at: null, is_local: !!t.is_local, track: true, item: t }; };
    window.__said = []; let last = null;
    WinifyWebamp.getInstance().store.subscribe(() => { const m = WinifyWebamp.getInstance().store.getState().userInput.userMessage; if (m && m !== last) __said.push(m); last = m; });
  })()`);
  const OWN = await js(`PLAYLISTS.filter((p) => p.owner.id === 'user1').map((p) => p.id)`);
  const COUNT = await js(`Object.fromEntries(PLAYLISTS.map((p) => [p.id, p.items.total]))`);
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))'); await h.wait(2500);

  console.log('1. The logo');
  const logo = await js(`(() => { const a = document.querySelector('#webamp #about'); return a && { title: a.title, href: a.getAttribute('href'), target: a.target }; })()`);
  check('tooltip "Make a random mix", no longer a link to webamp.org', logo && logo.title === 'Make a random mix' && !logo.href, JSON.stringify(logo));

  console.log('2. Clicking it makes a mix of 10 of your playlists and plays it');
  await take(); await messages();
  // The picker opened first: its list is still being read (paced) when the logo is clicked.
  await h.click(win, js, '#eject'); await h.wait(400);
  check('the picker\'s list is still coming in', (await js('WinifyPicker.state()')).loading);
  await h.click(win, js, '#webamp #about');
  let p = await until((v) => v.state.mode === 'list' && v.state.mix && v.state.mix.started && v.cur === 0, 15000);
  let cs = await take(); let said = await messages();
  const st = await js('WinifyMix.state()');
  const items = cs.filter((x) => x[0] === 'api:playlistItems');
  const lists = cs.filter((x) => x[0] === 'api:myPlaylists');
  check('the mix waits for that read (hurried) rather than starting it again: 3 pages of 137, once', lists.length === 3 && lists.map((x) => x[1]).join() === '0,50,100', JSON.stringify(lists.map((x) => x[1])));
  const mixed = [...new Set(items.map((x) => x[1]))];
  check('the scrolling title said "Mixing 10 playlists..."', said.includes('Mixing 10 playlists...'), JSON.stringify(said));
  check('no new window opened (webamp.org)', !(await js('JSON.stringify(loud)')).includes('newWindow'));
  // (Liked Songs is only ever counted, by the picker's own first read: limit 1.)
  check('10 playlists, all yours (not followed, not the collaborative one, not Liked Songs, not the empty one)',
    mixed.length === 10 && mixed.every((x) => OWN.includes(x) && x !== 'pl2' && x !== 'pl10') && cs.filter((x) => x[0] === 'api:savedTracks').length <= 1, JSON.stringify(mixed));
  check('each read as one page of 50 at an offset inside the playlist', items.every((x) => x[3] === '50' && +x[2] <= Math.max(0, COUNT[x[1]] - 50)), JSON.stringify(items.map((x) => x.slice(1))));
  check('about one request per playlist (at most 2), plus one to play: count reported', st.last && st.last.requests === items.length + 1 && items.length <= 20 && items.length >= 10, JSON.stringify(st.last));
  const body = plays(cs)[0];
  const uris = body ? body.uris : [];
  check('played as a list of songs from the first', plays(cs).length === 1 && uris.length === st.last.songs && body.offset.position === 0, JSON.stringify(body && { n: uris.length, offset: body.offset }));
  check('about 100 songs, at most 10 from each playlist', uris.length > 60 && uris.length <= 100, uris.length);
  check('no duplicates (song 777 is in every playlist: once at most)', new Set(uris).size === uris.length && uris.filter((u) => u === 'spotify:track:777').length <= 1, uris.filter((u) => u === 'spotify:track:777').length);
  check('no local files, no unavailable songs', uris.every((u) => /^spotify:track:/.test(u) && id(u) % 7 !== 1 && id(u) % 5 !== 2));
  const fromIdx = uris.filter((u) => id(u) !== 777).map((u) => Math.floor((id(u) - 100000) / 1000));
  const runs = fromIdx.filter((x, i) => i > 0 && x === fromIdx[i - 1]).length;
  check('shuffled (not playlist by playlist)', runs < fromIdx.length / 3, runs + ' of ' + fromIdx.length);
  const mixes = await js('WinifyMix.saved()');
  check('the playlist window: "— MIX · <date, time> —", the songs in order, the first playing', /^— MIX · \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d\d —$/.test(p.state.header) && p.rows.length === uris.length && p.state.listContext === 'winify:mix:' + mixes[0].id, show(p));
  check('saved: one mix, its songs as played', mixes.length === 1 && mixes[0].tracks.map((t) => t.uri).join() === uris.join(), mixes.length);

  console.log('3. Hovering a song shows its playlist');
  const tip = await js(`(() => { const c = document.querySelectorAll('#webamp .playlist-track-titles .track-cell'); return [c[0] && c[0].title, c[1] && c[1].title, c[2] && c[2].title]; })()`);
  const want = mixes[0].tracks[0].from;
  check('row 1: "From <playlist>"; the header row has none', !tip[0] && tip[1] === 'From ' + want && /^From /.test(tip[2]), JSON.stringify([tip, want]));

  console.log('4. The usual play order: Next, queue, shuffle');
  await take(); await h.click(win, js, '#webamp #next');
  p = await until((v) => v.cur === 1 && id(v.track) === id(uris[1]));
  cs = await take();
  check('Next plays song 2 of the mix (the list from there, not a context)', plays(cs).length === 1 && plays(cs)[0].uris && plays(cs)[0].offset.position === 1 && p.state.mix.started, JSON.stringify(plays(cs).map((b) => b.offset)) + show(p));
  await h.wait(1200); await take();
  await nearEnd(25000);
  await h.wait(1500); cs = await take();
  const queued = cs.filter((x) => x[0] === 'api:addToQueue');
  check('30 s before the end, the next song is queued (Winify\'s order)', queued.length === 1 && queued[0][1] === uris[2], JSON.stringify(queued));
  await h.click(win, js, '#webamp #shuffle'); await h.wait(800);
  p = await PL();
  check('shuffle is Winify\'s own (the order is reshuffled, the mix keeps playing)', p.state.order && p.state.order.shuffle && p.state.listContext === 'winify:mix:' + mixes[0].id && p.cur === 0, show(p));
  await h.click(win, js, '#webamp #shuffle'); await h.wait(800);

  await js('WinifyPicker.close()'); await h.wait(300);
  console.log('5. The logo again: a fresh mix; saved newest first');
  await take();
  await js('mock.queue.length = 0');
  await h.click(win, js, '#webamp #about');
  p = await until((v) => v.state.mix && v.state.mix.started && v.state.listContext !== 'winify:mix:' + mixes[0].id && v.cur === 0, 15000);
  const two = await js('WinifyMix.saved()');
  cs = await take();
  check('a new mix plays, with a new name', two.length === 2 && p.state.listContext === 'winify:mix:' + two[0].id && two[0].id !== mixes[0].id && two[0].name !== two[1].name, JSON.stringify(two.map((m) => m.name)) + show(p));
  check('...from a fresh pick (different songs)', two[0].tracks.map((t) => t.uri).join() !== two[1].tracks.map((t) => t.uri).join());

  console.log('6. The picker: "Winify mixes" above your playlists');
  await h.click(win, js, '#eject'); await h.wait(900);
  let rows = await js(`[...document.querySelectorAll('.winify-picker .wp-row')].slice(0, 6).map((r) => r.textContent)`);
  check('label, the two mixes newest first, then "Your Spotify playlists" and Liked Songs', rows[0] === '— WINIFY MIXES —' && rows[1].includes(two[0].name) && rows[2].includes(two[1].name) && rows[3] === '— YOUR SPOTIFY PLAYLISTS —' && /Liked Songs/.test(rows[4]), JSON.stringify(rows));
  // Right-click the older mix: Rename.
  await h.click(win, js, '.winify-picker .wp-row[data-mix="' + two[1].id + '"]', 0.5, 0.5, 'right'); await h.wait(300);
  const menu = await js(`[...document.querySelectorAll('#webamp-context-menu li')].map((l) => l.textContent)`);
  check('right-click a mix: Rename and Delete', menu.join() === 'Rename,Delete', JSON.stringify(menu));
  await js(`[...document.querySelectorAll('#webamp-context-menu li')].find((l) => l.textContent === 'Rename').click()`); await h.wait(200);
  await js(`(() => { const i = document.querySelector('.winify-picker .wp-rename'); i.value = 'Sunday'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`); await h.wait(300);
  rows = await js(`[...document.querySelectorAll('.winify-picker .wp-row')].slice(0, 3).map((r) => r.textContent)`);
  check('renamed in the list and in what is saved', rows[2].includes('Sunday') && (await js('WinifyMix.saved()'))[1].name === 'Sunday', JSON.stringify(rows));
  check('the picker is still open (Enter in the box did not close it)', await js('WinifyPicker.state().open'));
  // Pick it: exactly that mix again.
  await take();
  await h.click(win, js, '.winify-picker .wp-row[data-mix="' + two[1].id + '"]'); await h.wait(100);
  await js(`document.querySelector('.winify-picker .wp-row[data-mix="${two[1].id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  p = await until((v) => v.state.listContext === 'winify:mix:' + two[1].id && v.state.mix.started && v.cur === 0, 10000);
  cs = await take();
  check('picking a saved mix replays exactly it, from its first song, with no reading of playlists', plays(cs).length === 1 && plays(cs)[0].uris.join() === two[1].tracks.map((t) => t.uri).join() && !cs.some((x) => x[0] === 'api:playlistItems'), JSON.stringify(plays(cs).map((b) => b.uris && b.uris.length)));
  check('header carries its new name', p.state.header === '— MIX · Sunday —', show(p));
  // Delete the other one.
  if (!(await js('WinifyPicker.state().open'))) { await h.click(win, js, '#eject'); await h.wait(700); }
  await h.click(win, js, '.winify-picker .wp-row[data-mix="' + two[0].id + '"]', 0.5, 0.5, 'right'); await h.wait(300);
  await js(`[...document.querySelectorAll('#webamp-context-menu li')].find((l) => l.textContent === 'Delete').click()`); await h.wait(300);
  const left = await js('WinifyMix.saved()');
  rows = await js(`[...document.querySelectorAll('.winify-picker .wp-row')].slice(0, 3).map((r) => r.textContent)`);
  check('Delete removes it from the list and from what is saved', left.length === 1 && left[0].id === two[1].id && !rows.some((r) => r.includes(two[0].name)), JSON.stringify(rows));
  check('nothing was written to Spotify (no POST/PUT/DELETE outside the player)', !JSON.stringify(await take()).match(/api:(createPlaylist|addTracks|UNEXPECTED)/));
  await js('document.querySelector(".winify-picker .wp-close, .winify-picker .gen-close").click()'); await h.wait(300);

  console.log('7. The end of a mix: Autoplay does not follow -> stops with a note');
  const last = left[0].tracks.length - 1;
  await js(`(mock.idx = ${last}, mock.track = mock.uris[${last}], mock.position = 0, mock.at = Date.now(), true)`);
  p = await until((v) => v.cur === last, 6000);
  check('the last song is the current row', p.cur === last, show(p));
  await h.wait(1200); await messages(); await take();
  await nearEnd(2500);
  p = await until((v) => v.state.mix && v.state.mix.done, 12000);
  said = await messages(); cs = await take();
  check('it stops (paused), the mix finished', p.paused && p.state.mix.done, show(p));
  check('scrolling title: "Mix finished"', said.includes('Mix finished'), JSON.stringify(said));
  check('no jump to anything else', plays(cs).length === 0, JSON.stringify(plays(cs)));

  console.log('8. The end of a mix: if Autoplay follows, its queue is shown as after a playlist');
  await js('mock.autoplayAfterUris = true');
  await take();
  await js(`WinifyMix.playSaved(${JSON.stringify(left[0].id)})`);
  p = await until((v) => v.state.mix && v.state.mix.started && !v.state.mix.done && v.cur === 0, 10000);
  await js(`(mock.idx = ${last}, mock.track = mock.uris[${last}], mock.position = 0, mock.at = Date.now(), true)`);
  await until((v) => v.cur === last, 6000); await h.wait(1200);
  await nearEnd(2500);
  p = await until((v) => v.state.label === '— AUTOPLAY · FROM SPOTIFY —' && v.track === 9000, 12000);
  check('Autoplay carries on: labelled list, not paused', p.state.label === '— AUTOPLAY · FROM SPOTIFY —' && !p.paused && p.state.mix && p.state.mix.done, show(p));
  await h.wait(2000); p = await PL();
  check('...and stays (no reload of the mix)', p.state.label === '— AUTOPLAY · FROM SPOTIFY —', show(p));
  await js('mock.autoplayAfterUris = false');

  console.log('9. Another source ends the mix');
  await js('mock.setContext("spotify:album:a1", 0)');
  p = await until((v) => v.state.listContext === 'spotify:album:a1' && v.state.mode === 'list');
  check('an album started elsewhere: its list, no mix', p.state.listContext === 'spotify:album:a1' && !p.state.mix && (await js('WinifyMix.state().current')) == null, show(p));

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
