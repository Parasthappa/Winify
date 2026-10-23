// REM skips/restores at once (no sub-menu), Delete toggles, Cmd+Z undoes; the Autoplay list is read-only.
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 240000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); };
  const key = async (k, mods) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods || [] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods || [] }); await h.wait(120); };
  const PL = () => js(`(() => { const s = WinifyWebamp.getInstance().store.getState(); const t = (id) => s.tracks[id] || {};
    const name = (id) => t(id).artist && t(id).title ? t(id).artist + ' - ' + t(id).title : t(id).defaultName;
    return { rows: s.playlist.trackOrder.slice(__hdr()).map(name), cur: s.playlist.trackOrder.indexOf(s.playlist.currentTrack) - __hdr(), state: WinifyPlaylist.state(),
      msg: s.userInput.userMessage, menuOpen: !!document.querySelector('#playlist-remove-menu ul, #playlist-remove-menu.selected'), track: mock.track }; })()`);
  const until = async (fn, ms = 8000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await PL(); if (fn(v)) return v; await h.wait(150); } return v; };
  const N = (n) => 'Artist ' + n + ' - Song ' + n;
  const skipped = (p) => (p.state.order ? p.state.order.skipped : []).map((x) => +x.match(/\d+$/)[0]).sort();
  const select = (...idx) => js(`(() => { const st = WinifyWebamp.getInstance().store; st.dispatch({ type: 'CLICKED_TRACK', index: ${idx[0]} + __hdr() }); ${idx.slice(1).map((i) => `st.dispatch({ type: 'CTRL_CLICKED_TRACK', index: ${i} + __hdr() });`).join('')} })()`);
  const rem = async () => { await h.click(win, js, '#webamp #playlist-remove-menu'); await h.wait(250); };
  const focusPl = () => h.click(win, js, '#playlist-window', 0.5, 0.02);
  const calls = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))'));

  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))');
  await until((v) => v.state.mode === 'list' && v.cur === 0 && v.rows.length === 12);

  console.log('1. REM: skips the selection at once, no sub-menu');
  await focusPl(); await select(3); await rem();
  let p = await PL();
  check('REM skips the selected track (2003), still listed', JSON.stringify(skipped(p)) === '[2003]' && p.rows.length === 12, JSON.stringify(skipped(p)));
  check('...no REM SEL / CROP / REM ALL menu opens', !p.menuOpen, p.menuOpen);
  check('...title says so', /Skipping: Artist 2003/.test(p.msg), p.msg);
  await rem(); p = await PL();
  check('REM again on the same (skipped) track restores it', skipped(p).length === 0 && /Not skipping: Artist 2003/.test(p.msg), JSON.stringify([skipped(p), p.msg]));
  await key('Z', ['meta']); p = await PL();
  check('Cmd+Z undoes the restore (skipped again)', JSON.stringify(skipped(p)) === '[2003]', JSON.stringify(skipped(p)));
  await key('Z', ['meta']); p = await PL();
  check('Cmd+Z again undoes the skip', skipped(p).length === 0, JSON.stringify(skipped(p)));
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'SELECT_ZERO' })`); await h.wait(100);
  await rem(); p = await PL();
  check('REM with nothing selected: a note, nothing skipped', p.msg === 'Select tracks to skip' && skipped(p).length === 0 && !p.menuOpen, p.msg);

  // The shut REM / MISC menus' invisible bars reach up over the list's last rows: a click there is the row's.
  for (const m of ['#playlist-remove-menu', '#playlist-misc-menu']) {
    const bar = await js(`(() => { const b = document.querySelector('#webamp ${m} .bar').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + 4) }; })()`);
    const hit = await js(`(() => { const e = document.elementFromPoint(${bar.x}, ${bar.y}); return e ? (e.closest('.track-cell') ? 'row' : e.className || e.nodeName) : null; })()`);
    const before = JSON.stringify(skipped(await PL())); const lyr = await js('WinifyLyrics.isOpen()');
    await focusPl(); await select(1); await h.click(win, js, '#webamp ' + m + ' .bar', 0.5, 0.05); await h.wait(250);
    p = await PL();
    check(m.replace('#playlist-', '').replace('-menu', '').toUpperCase() + ' bar over the rows: the click reaches the list, not the button', (hit === 'row' || /playlist-track/.test(hit)) && JSON.stringify(skipped(p)) === before && (await js('WinifyLyrics.isOpen()')) === lyr, JSON.stringify([hit, before, skipped(p)]));
  }

  console.log('2. Toggle with mixed selections (Delete)');
  await focusPl(); await select(4); await key('Delete');
  await select(4, 5, 6); await key('Delete'); p = await PL();
  check('mixed (4 skipped, 5 and 6 not): skips the unskipped ones', JSON.stringify(skipped(p)) === '[2004,2005,2006]', JSON.stringify(skipped(p)));
  await key('Delete'); p = await PL();
  check('all selected already skipped: restores them all', skipped(p).length === 0, JSON.stringify(skipped(p)));
  await key('Z', ['meta']); p = await PL();
  check('Cmd+Z: undoes that restore (all three skipped again)', JSON.stringify(skipped(p)) === '[2004,2005,2006]', JSON.stringify(skipped(p)));
  await key('Z', ['meta']); p = await PL();
  check('Cmd+Z: undoes the mixed skip (only 2004 left)', JSON.stringify(skipped(p)) === '[2004]', JSON.stringify(skipped(p)));
  const css = await js(`document.getElementById('winify-skipped').textContent`);
  check('skipped rows still drawn dimmed / struck through', /line-through/.test(css), css);

  console.log('3. The Autoplay list is read-only, and says so');
  await js('mock.startAutoplay(false)');
  p = await until((v) => v.state.label === '— AUTOPLAY · FROM SPOTIFY —' && v.rows[v.cur] === N(9000));
  check('labelled "AUTOPLAY · FROM SPOTIFY"', p.rows[0] === '— AUTOPLAY · FROM SPOTIFY —' && p.cur === 1, JSON.stringify(p.rows.slice(0, 3)));
  const before = JSON.stringify(p.rows);
  await focusPl(); await select(3); await calls(); await rem(); p = await PL();
  check('REM: a note in the title, list unchanged, no menu', p.msg === 'Autoplay is from Spotify - read only' && JSON.stringify(p.rows) === before && !p.menuOpen, JSON.stringify([p.msg, p.menuOpen]));
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'UNSET_USER_MESSAGE' })`);
  await select(3); await key('Delete'); p = await PL();
  check('Delete: the same note, list unchanged', p.msg === 'Autoplay is from Spotify - read only' && JSON.stringify(p.rows) === before, p.msg);
  // A drag: not-allowed cursor while dragging, nothing moves.
  const c = await js(`(() => { const r = document.querySelectorAll('#webamp .playlist-track-titles .track-cell')[3].getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 });
  for (let k = 1; k <= 5; k++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y + k * 6, button: 'left', modifiers: ['leftButtonDown'] }); await h.wait(40); }
  const during = await js(`({ cls: document.documentElement.classList.contains('winify-no-drag'), cursor: getComputedStyle(document.querySelectorAll('#webamp .playlist-track-titles .track-cell')[4]).cursor })`);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y + 30, button: 'left', clickCount: 1 }); await h.wait(200);
  const after = await js(`({ cls: document.documentElement.classList.contains('winify-no-drag'), cursor: getComputedStyle(document.querySelectorAll('#webamp .playlist-track-titles .track-cell')[4]).cursor })`);
  p = await PL();
  check('dragging shows a not-allowed cursor', during.cls && during.cursor === 'not-allowed', JSON.stringify(during));
  check('...back to normal on release, nothing moved', !after.cls && after.cursor !== 'not-allowed' && JSON.stringify(p.rows) === before, JSON.stringify(after));
  check('Cmd+Z in Autoplay does nothing to the list', (await key('Z', ['meta']), JSON.stringify((await PL()).rows) === before));

  console.log('4. Back in an order, dragging is normal');
  await js('mock.setContext("spotify:album:a1", 0)'); await until((v) => v.state.mode === 'list' && v.rows.length === 12 && v.cur === 0);
  const c2 = await js(`(() => { const r = document.querySelectorAll('#webamp .playlist-track-titles .track-cell')[3].getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: c2.x, y: c2.y, button: 'left', clickCount: 1 });
  for (let k = 1; k <= 5; k++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: c2.x, y: c2.y + k * 6, button: 'left', modifiers: ['leftButtonDown'] }); await h.wait(40); }
  const d2 = await js(`document.documentElement.classList.contains('winify-no-drag')`);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: c2.x, y: c2.y + 30, button: 'left', clickCount: 1 }); await h.wait(200);
  p = await PL();
  check('no not-allowed cursor; the row moved', !d2 && p.rows[3] !== N(2003), JSON.stringify(p.rows.slice(0, 6)));

  const loud = JSON.parse(await js('JSON.stringify(loud)')); const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no alerts or prompts', loud.length === 0, JSON.stringify(loud));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
