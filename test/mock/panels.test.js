const { app } = require('electron'); const h = require('../lib/harness'); const fs = require('fs'), path = require('path');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 240000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); return ok; };
  const until = async (expr, ms = 5000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await js(expr).catch(() => null); if (v) return v; await h.wait(100); } return v; };
  const SEL = { picker: '.winify-picker', search: '.winify-search', lyrics: '.winify-lyrics', milkdrop: '.gen-window' };
  const R = (sel) => js(`(() => { const e = document.querySelector('#webamp ' + ${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; })()`);
  const P = async () => { const o = {}; for (const id of Object.keys(SEL)) o[id] = await R(SEL[id]); return o; };
  const isOpen = { picker: 'WinifyPicker.isOpen()', search: 'WinifySearch.isOpen()', lyrics: 'WinifyLyrics.isOpen()', milkdrop: 'WinifyMilkdrop.isOpen()' };
  const open = async (id) => {
    if (id === 'picker') await js('WinifyPicker.open()');
    if (id === 'search') await js('WinifySearch.open()');
    if (id === 'lyrics') await js('WinifyLyrics.open()');
    if (id === 'milkdrop' && !(await js('WinifyMilkdrop.isOpen()'))) await js('WinifyMilkdrop.toggle()');
    await until(isOpen[id], 5000); await h.wait(400);
  };
  const close = async (id) => {
    if (id === 'picker') await js('WinifyPicker.close()');
    if (id === 'search') await js('WinifySearch.close()');
    if (id === 'lyrics') await js('WinifyLyrics.close()');
    if (id === 'milkdrop' && (await js('WinifyMilkdrop.isOpen()'))) await js('WinifyMilkdrop.toggle()');
    await h.wait(400);
  };
  const closeAll = async () => { for (const id of Object.keys(SEL)) await close(id); };
  const key = async (k, mods) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods || [] }); if (k.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: k }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods || [] }); await h.wait(250); };
  const drag = async (x, y, dx, dy) => { win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await h.wait(60);
    for (let i = 1; i <= 10; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: x + Math.round(dx * i / 10), y: y + Math.round(dy * i / 10), modifiers: ['leftButtonDown'] }); await h.wait(30); }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: x + dx, y: y + dy, button: 'left', clickCount: 1 }); await h.wait(400); };
  const W = () => js('innerWidth'); const H = () => js('innerHeight');
  const touching = (a, b) => a.r === b.x && a.y === b.y;
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))'); await h.wait(1500);
  const main = await R('#main-window'); const pl = await R('#playlist-window');
  const colRight = Math.max(main.r, pl.r); const HEIGHT = main.h + 261;
  console.log('   column', JSON.stringify({ main, pl }), 'window', await W(), 'x', await H());

  console.log('1. One order: picker, search, lyrics, Milkdrop');
  for (const id of ['picker', 'search', 'lyrics', 'milkdrop']) await open(id);
  let p = await P();
  check('all four open at once', !!(p.picker && p.search && p.lyrics && p.milkdrop), JSON.stringify(p));
  check('all the column\'s height (main + playlist default: ' + HEIGHT + ')', ['picker', 'search', 'lyrics', 'milkdrop'].every((id) => p[id].h === HEIGHT), JSON.stringify(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v && v.h]))));
  check('the first right of the column, tops aligned', p.picker.x === colRight && p.picker.y === main.y, JSON.stringify(p.picker));
  check('the next touching it', touching(p.picker, p.search), JSON.stringify([p.picker, p.search]));
  check('one that would run off the right edge starts a second row under the playlist, left-aligned with it', p.lyrics.x === pl.x && p.lyrics.y === pl.b && p.search.r + 300 > (await W()), JSON.stringify({ lyrics: p.lyrics, pl }));
  check('...and the stack goes on to the right of it', touching(p.lyrics, p.milkdrop), JSON.stringify([p.lyrics, p.milkdrop]));
  fs.writeFileSync(path.join(__dirname, '..', '.output', 'panels-stack.png'), (await win.webContents.capturePage()).toPNG());

  console.log('2. Closing a middle one fills the gap');
  await close('search');
  p = await P();
  check('lyrics slides up into the first row, touching the picker', touching(p.picker, p.lyrics), JSON.stringify([p.picker, p.lyrics]));
  check('...Milkdrop after it, in the second row while the first has no room for it', p.lyrics.r + 400 > (await W()) ? (p.milkdrop.x === pl.x && p.milkdrop.y === pl.b) : touching(p.lyrics, p.milkdrop), JSON.stringify(p.milkdrop));
  await closeAll();

  console.log('3. Another order: Milkdrop, lyrics, search, picker');
  for (const id of ['milkdrop', 'lyrics', 'search', 'picker']) await open(id);
  p = await P();
  check('stacked in the order opened', p.milkdrop.x === colRight && touching(p.milkdrop, p.lyrics) && p.search.x === pl.x && p.search.y === pl.b && touching(p.search, p.picker), JSON.stringify(p));
  await closeAll();

  console.log('4. A short screen: the second row is shortened to fit');
  const size = win.getContentSize();
  win.setContentSize(size[0], 600); await h.wait(800);
  for (const id of ['picker', 'search', 'lyrics', 'milkdrop']) await open(id);
  p = await P(); const h2 = await H();
  check('second-row panels end at the bottom (to the step), not past it', p.lyrics.b <= h2 && p.lyrics.h > h2 - pl.b - 29 && (p.lyrics.h - 116) % 29 === 0 && p.milkdrop.b <= h2 && p.milkdrop.h >= 116, JSON.stringify({ lyrics: p.lyrics, milkdrop: p.milkdrop, h: h2 }));
  check('...Milkdrop in Webamp\'s 29 px steps', (p.milkdrop.h - 116) % 29 === 0, JSON.stringify(p.milkdrop));
  await closeAll();
  win.setContentSize(size[0], size[1]); await h.wait(800);

  console.log('5. No panel closes another');
  await h.click(win, js, '#webamp #eject'); await until(isOpen.picker); await h.wait(300);
  await h.click(win, js, '#webamp #button-v'); await until(isOpen.milkdrop); await h.wait(500);
  check('Milkdrop (V) opened: the picker stays open', (await js(isOpen.picker)) && (await js(isOpen.milkdrop)));
  await h.click(win, js, '#webamp #button-i'); await until(isOpen.lyrics); await h.wait(300);
  await h.click(win, js, '#title-bar', 0.3, 0.5); await key('J'); await until(isOpen.search); await h.wait(300);
  check('lyrics (I) and Jump to track (J) too: all four open', (await js(isOpen.picker)) && (await js(isOpen.milkdrop)) && (await js(isOpen.lyrics)) && (await js(isOpen.search)));
  const pk = await R(SEL.picker);
  await h.click(win, js, '#webamp #main-window', 0.9, 0.05);
  check('a click on another window or an empty part closes nothing', (await js(isOpen.picker)) && (await js(isOpen.search)) && (await js(isOpen.lyrics)) && (await js(isOpen.milkdrop)));

  console.log('6. Escape closes only the focused panel');
  await h.click(win, js, '#webamp .winify-lyrics .wl-body'); await key('Escape');
  check('lyrics focused: Escape closes lyrics only', !(await js(isOpen.lyrics)) && (await js(isOpen.picker)) && (await js(isOpen.search)) && (await js(isOpen.milkdrop)));
  await h.click(win, js, '#webamp .winify-picker .wp-filter'); await key('Escape');
  check('picker focused: Escape closes the picker only', !(await js(isOpen.picker)) && (await js(isOpen.search)) && (await js(isOpen.milkdrop)));
  await h.click(win, js, '#webamp .gen-window', 0.5, 0.03); await key('Escape');
  check('Milkdrop focused: Escape closes Milkdrop only', !(await js(isOpen.milkdrop)) && (await js(isOpen.search)));
  await h.click(win, js, '#webamp #main-window', 0.9, 0.05); await key('Escape');
  check('nothing focused (the main window clicked): Escape closes nothing', await js(isOpen.search));
  await closeAll();

  console.log('7. Placed by hand: remembered, out of the stack');
  await open('search'); await open('lyrics');
  let s0 = await R(SEL.search);
  const top = await R('.winify-search .ws-top');
  await drag(top.x + 60, top.y + 8, 40, 300);
  const grip = await R('.winify-search .winify-grip');
  await drag(grip.x + 10, grip.y + 7, -100, -60);
  const placedRect = await R(SEL.search);
  // In Winamp's steps: -100 px wide is 4 steps of 25; -60 px high rounds to 2 steps of 29.
  check('dragged and resized (resize grip, Winamp-style corner), in Winamp\'s 25 x 29 px steps', placedRect.x === s0.x + 40 && placedRect.y === s0.y + 300 && placedRect.w === s0.w - 100 && placedRect.h === s0.h - 58, JSON.stringify([s0, placedRect]));
  p = await P();
  check('it leaves the stack: lyrics slides into its place', p.lyrics.x === colRight && p.lyrics.y === main.y, JSON.stringify(p.lyrics));
  const minSize = await js(`(() => { const e = document.querySelector('#webamp .winify-search'); return [e.offsetWidth, e.offsetHeight]; })()`);
  await close('search'); await open('search');
  check('closed and reopened: the same spot and size', JSON.stringify(await R(SEL.search)) === JSON.stringify(placedRect), JSON.stringify(await R(SEL.search)));
  const g2 = await R('.winify-search .winify-grip'); await drag(g2.x + 10, g2.y + 7, -800, -800);
  const tiny = await R(SEL.search);
  check('a sensible minimum size (275 x 116)', tiny.w === 275 && tiny.h === 116, JSON.stringify(tiny));
  await drag((await R('.winify-search .winify-grip')).x + 10, (await R('.winify-search .winify-grip')).y + 7, placedRect.w - 275, placedRect.h - 116);
  const listH = await js(`document.querySelector('#webamp .winify-search .ws-list').clientHeight`);
  check('the list fills whatever height it has (title 20, query line 13 and the 38 px bottom bar aside)', listH === placedRect.h - 71, listH + ' px of list in ' + placedRect.h + ' px');
  const bar = await R('.winify-search .ws-bottom .playlist-bottom'); const box2 = await R(SEL.search);
  check('the bottom bar ends at the panel\'s edge (drawn inside it)', bar.b === box2.b, JSON.stringify({ bar, box2 }));
  await open('picker');
  p = await P();
  check('a panel opened later stacks as if the placed one were not there', touching(p.lyrics, p.picker), JSON.stringify([p.lyrics, p.picker]));

  console.log('8. Relaunch');
  const before = await P(); const st0 = await js('WinifyPanels.state()');
  await js('location.reload()'); await h.wait(500);
  while (!(await js('window.mounted === true').catch(() => false))) await h.wait(100);
  await until(`WinifySearch.isOpen() && WinifyLyrics.isOpen() && WinifyPicker.isOpen()`, 8000); await h.wait(800);
  const after = await P(); const st1 = await js('WinifyPanels.state()');
  check('the panels that were open come back, in their order', JSON.stringify(st1.open) === JSON.stringify(st0.open) && !after.milkdrop, JSON.stringify([st0.open, st1.open]));
  check('...the placed one where it was, the stacked ones stacked as before', JSON.stringify(after.search) === JSON.stringify(before.search) && JSON.stringify(after.lyrics) === JSON.stringify(before.lyrics) && JSON.stringify(after.picker) === JSON.stringify(before.picker), JSON.stringify({ before, after }));

  console.log('9. Reset window layout');
  await js('WinifyWebamp.resetLayout()'); await h.wait(1200);
  p = await P(); const st2 = await js('WinifyPanels.state()');
  check('placements forgotten', Object.keys(st2.placed).length === 0, JSON.stringify(st2));
  // Open order: lyrics, search (reopened after its placement), picker.
  check('open panels restacked neatly, in their order, all the column\'s height', JSON.stringify(st2.open) === '["lyrics","search","picker"]' && p.lyrics.x === colRight && p.lyrics.y === main.y && touching(p.lyrics, p.search) && p.search.h === HEIGHT &&
    (p.search.r + 325 > (await W()) ? (p.picker.x === pl.x && p.picker.y === pl.b) : touching(p.search, p.picker)), JSON.stringify(p));
  check('...still open', (await js(isOpen.picker)) && (await js(isOpen.search)) && (await js(isOpen.lyrics)));

  console.log('9b. Steps, clipping, snapping, and Webamp\'s own re-arranging');
  await open('search');
  const sg = await R('.winify-search .winify-grip'); const sb = await R(SEL.search);
  await drag(sg.x + 10, sg.y + 7, 37, 41);   // not a whole step either way
  const st3 = await R(SEL.search);
  check('a resize lands on whole steps (25 px wide, 29 px high)', (st3.w - 275) % 25 === 0 && (st3.h - 116) % 29 === 0 && st3.w === sb.w + 25 && st3.h === sb.h + 29, JSON.stringify([sb, st3]));
  const sg2 = await R('.winify-search .winify-grip'); await drag(sg2.x + 10, sg2.y + 7, -900, -900);
  const small = await R(SEL.search); const sbar = await R('.winify-search .ws-bottom .playlist-bottom'); const grip3 = await R('.winify-search .winify-grip');
  check('down to 275 x 116: the bottom bar is clipped, never wider than the panel; the grip stays in the corner', small.w === 275 && small.h === 116 && sbar.r <= small.r && grip3.r === small.r && grip3.b === small.b, JSON.stringify({ small, sbar, grip3 }));
  const plw = await R('#playlist-window'); const stop = await R('.winify-search .ws-top');
  await drag(stop.x + 60, stop.y + 8, plw.x - small.x + 8, plw.b - small.y + 6);   // 8 px right, 6 px below the playlist's bottom-left corner
  const snapped = await R(SEL.search);
  check('dropped near the playlist window: snapped to it, left edges aligned, edge to edge', snapped.x === plw.x && snapped.y === plw.b, JSON.stringify({ snapped, playlist: plw }));
  await close('search');
  await js(`(() => { const s = JSON.parse(localStorage.getItem('winify.panels.v1')); s.placed.search = { x: ${plw.x - 9}, y: ${plw.b + 10}, w: 358, h: 303 }; localStorage.setItem('winify.panels.v1', JSON.stringify(s)); })()`);
  await js('location.reload()'); await h.wait(500);
  while (!(await js('window.mounted === true').catch(() => false))) await h.wait(100);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))'); await h.wait(1500);
  if (!(await js(isOpen.search))) await open('search');
  const reopened = await R(SEL.search);
  check('a spot remembered from before (unstepped, 10 px off the playlist) reopens snapped to it, on the steps', reopened.x === plw.x && reopened.y === plw.b && (reopened.w - 275) % 25 === 0 && (reopened.h - 116) % 29 === 0, JSON.stringify({ reopened, playlist: plw }));
  await close('search');
  const keep = await js(`(() => { const g = WinifyWebamp.getInstance().store.getState().windows.genWindows; return JSON.stringify({ main: g.main.position, playlist: [g.playlist.position, g.playlist.size] }); })()`);
  const full = win.getContentSize();
  win.setContentSize(500, 300); await h.wait(900);
  win.setContentSize(full[0], full[1]); await h.wait(900);
  const kept = await js(`(() => { const g = WinifyWebamp.getInstance().store.getState().windows.genWindows; return JSON.stringify({ main: g.main.position, playlist: [g.playlist.position, g.playlist.size] }); })()`);
  const pl2 = await R('#playlist-window'); const mn2 = await R('#main-window');
  check('the window shrinks so the windows no longer fit: the playlist keeps its height, under the main window (Webamp\'s reset undone)', JSON.parse(kept).playlist[1].join() === '0,5' && pl2.x === mn2.x && pl2.y === mn2.b, JSON.stringify({ keep: JSON.parse(keep), kept: JSON.parse(kept) }));
  await js('WinifyPanels.reset()'); await open('search'); await h.wait(300);   // back in the stack for the next part

  console.log('10. Dragging the main window carries every panel snapped to it');
  await open('milkdrop');
  const a0 = await P(); const pl0 = await R('#playlist-window'); const m0 = await R('#main-window'); const tb = await R('#title-bar');
  await drag(tb.x + 60, tb.y + 7, 40, 5);
  const a1 = await P(); const pl1 = await R('#playlist-window'); const m1 = await R('#main-window');
  const dx = m1.x - m0.x, dy = m1.y - m0.y;   // as far as it went (Webamp snaps it to edges)
  const moved = (id) => a1[id].x - a0[id].x === dx && a1[id].y - a0[id].y === dy;
  check('the main window moved, the playlist with it (Webamp)', dx !== 0 && pl1.x - pl0.x === dx && pl1.y - pl0.y === dy, JSON.stringify({ dx, dy, m1, pl1 }));
  check('every panel joined to it moved as much: lyrics and Jump to track beside it, the picker and Milkdrop under the playlist', ['lyrics', 'search', 'picker', 'milkdrop'].every(moved),
    JSON.stringify(Object.fromEntries(Object.keys(SEL).map((id) => [id, [a1[id].x - a0[id].x, a1[id].y - a0[id].y]]))));
  check('...still in the stack (they moved with their column)', JSON.stringify((await js('WinifyPanels.state()')).placed) === '{}');
  const sTop = await R('.winify-search .ws-top');
  await drag(sTop.x + 60, sTop.y + 8, -40, 330);   // away from the group: placed by hand
  const away = await R(SEL.search); const b0 = await P(); const n0 = await R('#main-window'); const tb2 = await R('#title-bar');
  await drag(tb2.x + 60, tb2.y + 7, -40, -5);
  const b1 = await P(); const n1 = await R('#main-window'); const ex = n1.x - n0.x, ey = n1.y - n0.y;
  check('a panel not snapped to the group stays where it is', JSON.stringify(b1.search) === JSON.stringify(away), JSON.stringify([away, b1.search]));
  check('...the snapped ones moved back with the main window', ex !== 0 && ['lyrics', 'picker', 'milkdrop'].every((id) => b1[id].x - b0[id].x === ex && b1[id].y - b0[id].y === ey), JSON.stringify({ ex, ey, b0, b1 }));
  await closeAll();

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
