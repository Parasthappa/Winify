// REM and Delete remove tracks at once (no sub-menu), Cmd+Z puts them back; only this list changes; hover; the Autoplay list is read-only.
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
  const nums = (p) => p.rows.slice().map((r) => +(r.match(/Song (\d+)/) || [0, 0])[1]);
  const removed = (p) => (p.state.order ? p.state.order.removed : []).map((x) => +x.match(/\d+$/)[0]).sort();
  const ALBUM = [2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const type = async (t) => { for (const ch of t) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch }); win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch }); await h.wait(40); } };
  const tips = () => js(`[...document.querySelectorAll('#webamp .playlist-track-titles .track-cell')].slice(0, 3).map((c) => c.title)`);
  const select = (...idx) => js(`(() => { const st = WinifyWebamp.getInstance().store; st.dispatch({ type: 'CLICKED_TRACK', index: ${idx[0]} + __hdr() }); ${idx.slice(1).map((i) => `st.dispatch({ type: 'CTRL_CLICKED_TRACK', index: ${i} + __hdr() });`).join('')} })()`);
  const rem = async () => { await h.click(win, js, '#webamp #playlist-remove-menu'); await h.wait(250); };
  const focusPl = () => h.click(win, js, '#playlist-window', 0.5, 0.02);
  const calls = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))'));

  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))');
  await until((v) => v.state.mode === 'list' && v.cur === 0 && v.rows.length === 12);

  console.log('1. REM: removes the selection at once, no sub-menu');
  await focusPl(); await select(3); await rem();
  let p = await PL();
  check('REM takes the selected track (2003) out of the list and the order', same(nums(p), ALBUM.filter((n) => n !== 2003)) && same(removed(p), [2003]), JSON.stringify(nums(p)));
  check('...no REM SEL / CROP / REM ALL menu opens', !p.menuOpen, p.menuOpen);
  check('...title says so', /Removed: Artist 2003/.test(p.msg), p.msg);
  check('...nothing dimmed or struck through', !(await js(`!!document.getElementById('winify-skipped') || [...document.querySelectorAll('#webamp .playlist-track-titles .track-cell')].some((c) => /line-through/.test(getComputedStyle(c).textDecoration) || getComputedStyle(c).opacity !== '1')`)));
  check('...the rows renumber: 2004 is now track 4', await js(`/^ ?4\\. .*Song 2004/.test(document.querySelectorAll('#webamp .playlist-track-titles .track-cell')[4].textContent.replace(/\\u00a0/g, ' '))`));
  await key('Z', ['meta']); p = await PL();
  check('Cmd+Z puts it back where it was', same(nums(p), ALBUM) && removed(p).length === 0 && /Put back: Artist 2003/.test(p.msg), JSON.stringify([nums(p), p.msg]));
  await key('Z', ['meta']); p = await PL();
  check('Cmd+Z with nothing left to undo: a note, nothing changes', p.msg === 'Nothing to undo' && same(nums(p), ALBUM), p.msg);
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'SELECT_ZERO' })`); await h.wait(100);
  await rem(); p = await PL();
  check('REM with nothing selected: a note, nothing removed', p.msg === 'Select tracks to remove' && same(nums(p), ALBUM) && !p.menuOpen, p.msg);

  // The shut REM / MISC menus' invisible bars reach up over the list's last rows: a click there is the row's.
  for (const m of ['#playlist-remove-menu', '#playlist-misc-menu']) {
    const bar = await js(`(() => { const b = document.querySelector('#webamp ${m} .bar').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + 4) }; })()`);
    const hit = await js(`(() => { const e = document.elementFromPoint(${bar.x}, ${bar.y}); return e ? (e.closest('.track-cell') ? 'row' : e.className || e.nodeName) : null; })()`);
    const before = JSON.stringify(nums(await PL())); const lyr = await js('WinifyLyrics.isOpen()');
    await focusPl(); await select(1); await h.click(win, js, '#webamp ' + m + ' .bar', 0.5, 0.05); await h.wait(250);
    p = await PL();
    check(m.replace('#playlist-', '').replace('-menu', '').toUpperCase() + ' bar over the rows: the click reaches the list, not the button', (hit === 'row' || /playlist-track/.test(hit)) && JSON.stringify(nums(p)) === before && (await js('WinifyLyrics.isOpen()')) === lyr, JSON.stringify([hit, before, nums(p)]));
  }

  console.log('2. Several at once (Delete, Backspace), undone last first');
  await focusPl(); await select(4, 5, 6); await key('Delete'); p = await PL();
  check('Delete removes all three', same(nums(p), ALBUM.filter((n) => n < 2004 || n > 2006)), JSON.stringify(nums(p)));
  await select(1); await key('Backspace'); p = await PL();
  check('Backspace removes too', same(nums(p), ALBUM.filter((n) => n !== 2001 && (n < 2004 || n > 2006))), JSON.stringify(nums(p)));
  const left = await js(`WinifyWebamp.getInstance().store.getState().playlist.selectedTracks.length`);
  check('...nothing stays selected', left === 0, left);
  await select(3); await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'DRAG_SELECTED', offset: 2 })`); await h.wait(150); p = await PL();
  const dragged = nums(p);
  await key('Z', ['meta']); p = await PL();
  check('Cmd+Z after a drag: 2001 back after 2000, the drag kept', same(nums(p).filter((n) => n !== 2001), dragged) && nums(p)[1] === 2001, JSON.stringify(nums(p)));
  await key('Z', ['meta']); p = await PL();
  check('Cmd+Z again: the three back together, in their order', nums(p).join().includes('2004,2005,2006') && p.rows.length === 12 && removed(p).length === 0, JSON.stringify(nums(p)));

  console.log('2b. Hover: the album, in albums and playlists');
  let tip = await tips();
  check('album: the header row has none; a song shows its album', !tip[0] && tip[1] === 'Album: Album a1' && tip[2] === 'Album: Album a1', JSON.stringify(tip));

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

  tip = await tips();
  check('Autoplay: no album hover', !tip[1] && !tip[2], JSON.stringify(tip));

  console.log('4. Back in an order, dragging is normal');
  await js('mock.setContext("spotify:album:a1", 0)'); await until((v) => v.state.mode === 'list' && v.rows.length === 12 && v.cur === 0);
  const c2 = await js(`(() => { const r = document.querySelectorAll('#webamp .playlist-track-titles .track-cell')[3].getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: c2.x, y: c2.y, button: 'left', clickCount: 1 });
  for (let k = 1; k <= 5; k++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: c2.x, y: c2.y + k * 6, button: 'left', modifiers: ['leftButtonDown'] }); await h.wait(40); }
  const d2 = await js(`document.documentElement.classList.contains('winify-no-drag')`);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: c2.x, y: c2.y + 30, button: 'left', clickCount: 1 }); await h.wait(200);
  p = await PL();
  check('no not-allowed cursor; the row moved', !d2 && p.rows[3] !== N(2003), JSON.stringify(p.rows.slice(0, 6)));

  console.log('5. A playlist: only this list changes, playing it again brings every song back');
  await js(`document.querySelector('#webamp #eject').dispatchEvent(new MouseEvent('click', { bubbles: true }))`); await h.wait(700);
  const playIt = async () => { await js(`document.querySelector('.winify-picker .wp-filter').focus()`); await key('Return'); };
  await type('road'); await h.wait(200); await key('Down'); await playIt();
  p = await until((v) => v.state.listContext === 'spotify:playlist:pl77' && v.state.mode === 'list' && v.rows.length === 30 && v.cur === 0);
  check('a playlist from the picker: all 30', p.rows.length === 30, JSON.stringify(p.state.listContext));
  tip = await tips();
  check('playlist: a song shows its album', tip[1] === 'Album: Album', JSON.stringify(tip));
  await calls();
  await focusPl(); await select(2, 3); await key('Delete'); p = await PL();
  check('two removed: 28 left', p.rows.length === 28, p.rows.length);
  const cs = await calls();
  check('...and nothing sent to Spotify', !cs.some((c) => /^api:/.test(c[0]) && !/^api:(me|state|player|devices|recent)/.test(c[0]) && c[0] !== 'api:lrc'), JSON.stringify(cs.filter((c) => /^api:/.test(c[0]))));
  await playIt();
  p = await until((v) => v.rows.length === 30 && removed(v).length === 0);
  check('playing the playlist again from the picker: all 30 again', p.rows.length === 30 && removed(p).length === 0, p.rows.length);
  await js('WinifyPicker.close()'); await h.wait(200);
  await focusPl(); await key('Z', ['meta']); p = await PL();
  check('...and there is nothing left to undo', p.msg === 'Nothing to undo' && p.rows.length === 30, p.msg);

  const loud = JSON.parse(await js('JSON.stringify(loud)')); const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no alerts or prompts', loud.length === 0, JSON.stringify(loud));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
