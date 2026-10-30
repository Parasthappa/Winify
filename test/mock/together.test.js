// Playing several playlists together: Cmd/Shift-click in the picker, the
// prompt, the mix built from the index, big selections sent in batches.
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 280000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); };
  const take = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))'));
  const key = async (k) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); await h.wait(100); };
  const until = async (expr, ms = 8000) => { const t = Date.now(); let v; while (!(v = await js(expr)) && Date.now() - t < ms) await h.wait(100); return v; };
  const press = (x, y, modifiers = [], clickCount = 1) => { win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount, modifiers }); win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount, modifiers }); };
  const rowAt = (name) => js(`(() => { const r = [...document.querySelectorAll('.winify-picker .wp-row[data-index]')].find((x) => x.textContent.includes(${JSON.stringify(name)})); if (!r) return null; const b = r.getBoundingClientRect(); return { x: Math.round(b.left + 30), y: Math.round(b.top + b.height / 2) }; })()`);
  const click = async (name, mods, count = 1) => { const p = await rowAt(name); press(p.x, p.y, mods, count); await h.wait(count > 1 ? 150 : 80); };
  const lit = () => js(`[...document.querySelectorAll('.winify-picker .wp-row[data-index]')].filter((r) => r.style.background).map((r) => r.querySelector('.wp-name').textContent.replace(/^\\d+\\. /, ''))`);
  const plays = (cs) => cs.filter((x) => x[0] === 'api:play').map((x) => JSON.parse(x[2]));
  // The index's reads (the playlist window reads "big", the one playing, on its own).
  const reads = (cs) => cs.filter((x) => (x[0] === 'api:playlistItems' && x[1] !== 'big') || (x[0] === 'api:savedTracks' && x[1] != null));
  const id = (u) => +String(u).split(':').pop();

  // Songs 8000.. (A: 30), 8100.. (B: 5), 8200.. (C: 60, its first three also in A), Liked Songs 8300.. (12).
  await js(`(() => {
    PLAYLISTS.length = 0;
    const pl = (id, name, total) => ({ id, name, uri: 'spotify:playlist:' + id, owner: { id: 'user1' }, collaborative: false, snapshot_id: id + '1', items: { total } });
    PLAYLISTS.push(pl('pa', 'Alpha', 30), pl('pb', 'Bravo', 5), pl('pc', 'Charlie', 60));
    for (let i = 0; i < 20; i++) PLAYLISTS.push(pl('x' + i, 'Extra ' + i, 80));
    const seq = (a, n) => Array.from({ length: n }, (_, i) => a + i);
    CONTEXTS['spotify:playlist:pa'] = seq(8000, 30);
    CONTEXTS['spotify:playlist:pb'] = seq(8100, 5);
    CONTEXTS['spotify:playlist:pc'] = [8000, 8001, 8002].concat(seq(8203, 57));
    for (let i = 0; i < 20; i++) CONTEXTS['spotify:playlist:x' + i] = seq(20000 + i * 100, 80);
    CONTEXTS['spotify:user:user1:collection'] = seq(8300, 12);
  })()`);
  await js(`WinifyIndex.restart({ gapMs: 30 })`);        // paused as in every suite: a playlist is read when asked for
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:playlist:big", 0), mock.setPaused(false))'); await h.wait(1500);

  console.log('1. Choosing several: Cmd-click and Shift-click');
  await js('WinifyPicker.open()'); await until('WinifyPicker.state().complete', 10000); await h.wait(300);
  await click('Bravo');
  check('a plain click chooses one: nothing else lit', JSON.stringify(await lit()) === JSON.stringify(['Bravo']) && (await js('WinifyPicker.state().chosen')) === 0, JSON.stringify(await lit()));
  await click('Alpha', ['meta']);
  check('Cmd-click adds one: Bravo and Alpha lit', JSON.stringify((await lit()).sort()) === JSON.stringify(['Alpha', 'Bravo']) && (await js('WinifyPicker.state().chosen')) === 2, JSON.stringify(await lit()));
  await click('Bravo', ['meta']);
  check('Cmd-click again removes it (one left is a plain selection)', JSON.stringify(await lit()) === JSON.stringify(['Alpha']) && (await js('WinifyPicker.state().chosen')) === 0, JSON.stringify(await lit()));
  await click('Liked Songs');
  await click('Charlie', ['shift']);
  check('Shift-click chooses the range: Liked Songs, Alpha, Bravo, Charlie', JSON.stringify((await lit()).sort()) === JSON.stringify(['Alpha', 'Bravo', 'Charlie', 'Liked Songs']), JSON.stringify(await lit()));
  check('the bottom bar says how many', await js(`!!document.querySelector('.winify-picker .wp-sel')`));

  console.log('2. Enter asks; 10 each, shuffled together; nothing indexed, so each playlist is read');
  await take(); await key('Return');
  check('the prompt opens', await js('WinifyPicker.state().prompt'), await js('document.querySelector(".winify-picker-prompt") && document.querySelector(".winify-picker-prompt").getAttribute("aria-label")'));
  check('...and no request was sent for it', reads(await take()).length === 0);
  const defaults = await js(`[...document.querySelectorAll('.winify-picker-prompt .wq-btn')].map((b) => b.getAttribute('aria-pressed') || b.getAttribute('aria-checked'))`);
  check('20 is chosen and "shuffle together" is on, by default', JSON.stringify(defaults.slice(0, 4)) === JSON.stringify(['false', 'true', 'false', 'true']), JSON.stringify(defaults));
  await key('Left');
  const ten = await js(`[...document.querySelectorAll('.winify-picker-prompt .wq-btn')].map((b) => b.getAttribute('aria-pressed')).slice(0, 3)`);
  check('Left chooses 10', JSON.stringify(ten) === JSON.stringify(['true', 'false', 'false']), JSON.stringify(ten));
  await key('Return');
  await until(`WinifyPlaylist.state().mix && WinifyPlaylist.state().mix.started`, 15000);
  let cs = await take(); let body = plays(cs)[0]; const uris = body.uris;
  const idx = await js('WinifyIndex.status()');
  check('only those four playlists were read, in full: Alpha 1 page, Bravo 1, Charlie 2, Liked Songs 1',
    JSON.stringify(reads(cs).map((c) => c[0] === 'api:savedTracks' ? 'liked' : c[1] + '@' + c[2]).sort()) === JSON.stringify(['liked', 'pa@0', 'pb@0', 'pc@0', 'pc@50']), JSON.stringify(reads(cs)));
  const gp = (u) => (id(u) >= 8300 ? 'liked' : id(u) >= 8200 || [8000, 8001, 8002].includes(id(u)) ? 'ac' : id(u) >= 8100 ? 'b' : 'a');
  check('10 from each of Alpha, Charlie and Liked Songs, all 5 of Bravo (35), no duplicates',
    uris.length === 35 && new Set(uris).size === 35 && uris.filter((u) => id(u) >= 8100 && id(u) < 8105).length === 5 && uris.filter((u) => id(u) >= 8300).length === 10, uris.length + ' ' + new Set(uris).size);
  const header = await js('WinifyPlaylist.state().header');
  check('the playlist window: "— 4 PLAYLISTS · 10 each —"', header === '— 4 PLAYLISTS · 10 each —', header);
  const tips = await js(`[...document.querySelectorAll('#webamp .playlist-track-titles .track-cell')].slice(1, 6).map((c) => c.title)`);
  const mixes = await js('WinifyMix.saved()');
  check('hovering a song shows its playlist', tips.every((t) => /^From (Alpha|Bravo|Charlie|Liked Songs)$/.test(t)) && mixes[0].tracks[0].from && tips[0] === 'From ' + mixes[0].tracks[0].from, JSON.stringify(tips));
  check('saved with the other mixes, header and all', mixes.length === 1 && mixes[0].tracks.length === 35 && mixes[0].header && mixes[0].header.name === '4 PLAYLISTS · 10 each' && mixes[0].playlists === 4, JSON.stringify(mixes[0] && mixes[0].header));
  const lbl = await js(`[...document.querySelectorAll('.winify-picker .wp-row')].slice(0, 3).map((r) => r.textContent)`);
  check('...listed under "Winify mixes" in the picker', lbl[0] === '— WINIFY MIXES —' && lbl[1].includes(mixes[0].name), JSON.stringify(lbl));
  check('the picker is unchosen again and the prompt gone', !(await js('WinifyPicker.state().prompt')) && (await js('WinifyPicker.state().chosen')) === 0);
  check('the index now holds them', idx.lists === 4, JSON.stringify(idx));

  console.log('3. Now indexed: no requests; playlist after playlist; all of a short one');
  await click('Charlie'); await click('Alpha', ['meta']);
  const mp = await js(`(() => { const r = document.querySelector('.winify-picker .wp-row[data-mix]'); const b = r.getBoundingClientRect(); return { x: Math.round(b.left + 30), y: Math.round(b.top + b.height / 2) }; })()`);
  press(mp.x, mp.y, ['meta']); await h.wait(100);
  check('a "Winify mixes" row cannot be chosen along with playlists (still 2 chosen, the mix not lit)', (await js('WinifyPicker.state().chosen')) === 2 && !(await lit()).some((n) => !/^(Charlie|Alpha)$/.test(n)), JSON.stringify(await lit()));
  await click('Bravo', ['meta']);      // chosen in this order, not the list's
  await key('Return'); await key('Right'); await key('Right'); await key('Space');       // 50 each, not shuffled together
  const off = await js(`document.querySelector('.winify-picker-prompt .wq-btn[aria-checked]').getAttribute('aria-checked')`);
  check('50 chosen and "shuffle together" off', off === 'false' && (await js(`document.querySelectorAll('.winify-picker-prompt .wq-btn[aria-pressed="true"]').length`)) === 1);
  await take(); await key('Return');
  await until(`WinifyMix.saved().length === 2`, 10000); await h.wait(300);
  cs = await take(); body = plays(cs)[0];
  check('not one request to Spotify to build it (only the play)', reads(cs).length === 0 && cs.filter((c) => /^api:/.test(c[0]) && c[0] !== 'api:play').length === 0, JSON.stringify(cs.filter((c) => /^api:/.test(c[0]))));
  const u3 = body.uris.map(id);
  const inC = (n) => n >= 8200 && n < 8260, inA = (n) => n >= 8000 && n < 8030, inB = (n) => n >= 8100 && n < 8105;
  check('50 of Charlie\'s 60, then the rest of Alpha not already in, then all 5 of Bravo: no duplicates', u3.length >= 82 && u3.length <= 85 && new Set(u3).size === u3.length && u3.slice(0, 50).every((n) => inC(n) || [8000, 8001, 8002].includes(n)), u3.length);
  check('playlist after playlist, in the order chosen (Charlie, Alpha, Bravo), not the list\'s', u3.slice(50, u3.length - 5).every(inA) && u3.slice(-5).every(inB), JSON.stringify(u3.slice(46, 56)));
  await until(`WinifyPlaylist.state().header === '\u2014 3 PLAYLISTS \u00b7 50 each \u2014'`, 6000);
  check('header says 3 playlists, 50 each', (await js('WinifyPlaylist.state().header')) === '— 3 PLAYLISTS · 50 each —', await js('WinifyPlaylist.state().header'));

  console.log('4. A mix saved from it plays again, and renaming keeps the header');
  await js('WinifyMix.rename(WinifyMix.saved()[0].id, "Mine")'); await h.wait(300);
  check('renamed in the list, header unchanged', (await js('WinifyMix.saved()[0].name')) === 'Mine' && (await js('WinifyPlaylist.state().header')) === '— 3 PLAYLISTS · 50 each —');
  await js('WinifyPicker.close()'); await h.wait(300);

  console.log('5. Large: 20 playlists x 50 songs, in batches');
  await js(`WinifyPicker.open()`); await h.wait(500);
  await take();
  const big = await js(`WinifyMix.makeFrom(PLAYLISTS.slice(3).map((p) => ({ uri: p.uri, name: p.name, snapshot: p.snapshot_id })), 50, true).then((m) => m && m.tracks.length)`);
  await until(`WinifyPlaylist.state().mix && WinifyPlaylist.state().mix.started`, 20000);
  cs = await take(); body = plays(cs)[0];
  check('1000 songs in the mix, 20 playlists read once each (2 pages)', big === 1000 && reads(cs).length === 40, big + ' songs, ' + reads(cs).length + ' reads');
  check('Spotify is given a batch (100 songs), not 1000, starting at the first', body.uris.length === 100 && body.offset.position === 0, body.uris.length);
  const first = await js('WinifyMix.saved()[0].tracks.map((t) => t.uri)');
  check('...the batch is the mix\'s first 100', JSON.stringify(body.uris) === JSON.stringify(first.slice(0, 100)));
  await take(); await h.click(win, js, '#webamp #next');
  await until(`mock.track !== ${id(first[0])}`, 6000); cs = await take(); body = plays(cs)[0];
  check('Next from song 1 asks for the window from song 2 (100 songs again)', body && body.uris.length === 100 && body.uris[0] === first[1], body && body.uris.length);
  const m = await js('WinifyMix.saved()[0]');
  check('the saved record keeps all 1000', m.tracks.length === 1000, m.tracks.length);

  console.log('6. The Winamp logo mixes from the index: no requests, random across whole playlists');
  await take();
  const made = await js(`WinifyMix.make({ playlists: 23 }).then((m) => m && m.tracks.map((t) => t.uri))`);
  cs = await take();
  check('built with no request to Spotify (only the play)', made && made.length > 100 && reads(cs).length === 0 && cs.filter((c) => /^api:(?!play)/.test(c[0])).length === 0, made && made.length + ' ' + JSON.stringify(cs.filter((c) => /^api:/.test(c[0]))));
  const deep = made.map(id).filter((n) => n >= 20000 && n % 100 >= 50).length;
  check('songs come from the whole playlist (not only its first page)', deep > 20, deep + ' of ' + made.length);

  const loud = JSON.parse(await js('JSON.stringify(loud)')); const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no alerts, downloads, file prompts or new windows', loud.length === 0, JSON.stringify(loud));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
