const { app } = require('electron'); const h = require('../lib/harness'); const fs = require('fs'), path = require('path');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 240000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 240) : '')); };
  const R = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; })()`);
  const take = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))'));
  const press = (x, y, b = 'left', clickCount = 1) => { win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: b, clickCount }); win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: b, clickCount }); };
  const drag = async (x, y, dx, dy, steps = 12) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await h.wait(120);
    for (let i = 1; i <= steps; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: x + Math.round(dx * i / steps), y: y + Math.round(dy * i / steps), modifiers: ['leftButtonDown'] }); await h.wait(30); }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: x + dx, y: y + dy, button: 'left', clickCount: 1 }); await h.wait(300);
  };
  const focusPl = async () => { const t = await R('#playlist-window'); press(t.x + t.w / 2, t.y + 6); await h.wait(250); };
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:playlist:big", 0), mock.setPaused(false))'); await h.wait(3000);

  console.log('1. Size and scale');
  let m = await R('#main-window'), p = await R('#playlist-window');
  const rows = await js(`(() => { const a = document.querySelector('#webamp .playlist-tracks').getBoundingClientRect(); return [...document.querySelectorAll('#webamp .playlist-track-titles .track-cell')].filter(c => c.getBoundingClientRect().bottom <= a.bottom + 0.5).length; })()`);
  const rowH = await js(`Math.round(document.querySelector('#webamp .track-cell').getBoundingClientRect().height)`);
  check('playlist as wide as the main window, docked directly below it', p.w === m.w && p.x === m.x && p.y === m.b, JSON.stringify({ m, p }));
  check('15 rows, at the playlist\'s own 1x scale', rows === 15 && rowH === 13, JSON.stringify({ rows, rowH }));
  const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(__dirname, '..', '.output', 'scaled.png'), img.toPNG());

  console.log('2. Dragging and snapping');
  await focusPl(); p = await R('#playlist-window');
  await drag(p.x + 100, p.y + 8, 220, 60); let p2 = await R('#playlist-window');
  check('drag the playlist: it moves exactly with the pointer', Math.abs(p2.x - (p.x + 220)) <= 1 && Math.abs(p2.y - (p.y + 60)) <= 1, JSON.stringify({ from: p, to: p2 }));
  m = await R('#main-window');
  await drag(p2.x + 100, p2.y + 8, (m.x - p2.x) + 7, (m.b - p2.y) + 6); p = await R('#playlist-window');
  check('drop it 7px/6px off the main window\'s bottom-left: snaps into the dock', p.x === m.x && p.y === m.b, JSON.stringify({ m, p }));
  const t = await R('#title-bar'); press(t.x + 40, t.y + 8); await h.wait(250);
  await drag(t.x + 40, t.y + 8, -120, 30); m = await R('#main-window'); p = await R('#playlist-window');
  check('drag the main window: the docked playlist comes along', p.x === m.x && p.y === m.b, JSON.stringify({ m, p }));

  console.log('3. Corner resize');
  await focusPl(); p = await R('#playlist-window'); const g = await R('#playlist-resize-target');
  const gx = g.x + Math.round(g.w / 2), gy = g.y + Math.round(g.h / 2);
  await drag(gx, gy, 100, 116); p2 = await R('#playlist-window'); const g2 = await R('#playlist-resize-target');
  const off = { dx: (g2.x + g2.w / 2) - (gx + 100), dy: (g2.y + g2.h / 2) - (gy + 116) };
  check('the resize grip stays under the pointer (within half a 2x segment)', Math.abs(off.dx) <= 25 && Math.abs(off.dy) <= 29, JSON.stringify({ pointerMoved: [100, 116], windowGrew: [p2.w - p.w, p2.h - p.h], gripOffFromPointer: off }));

  console.log('4. Rows, scrollbar, mini transport, menus');
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'SET_PLAYLIST_SCROLL_POSITION', position: 0 })`); await h.wait(200); await take();
  const row = await R('#webamp .playlist-track-titles .track-cell:nth-child(5)');
  press(row.x + 30, row.y + row.h / 2, 'left', 1); press(row.x + 30, row.y + row.h / 2, 'left', 2); await h.wait(900);
  let cs = await take(); const pl = cs.find((c) => c[0] === 'api:play');
  // Row 4 holds a track that is also on row 8, so it is played by position.
  check('double-click row 4 plays it', pl && JSON.parse(pl[2]).offset.position === 3, pl && pl[2]);
  const hd = await R('#webamp .playlist-scrollbar-handle'); const sb = await R('#webamp .playlist-scrollbar');
  await drag(hd.x + hd.w / 2, hd.y + hd.h / 2, 0, Math.round(sb.h / 2));
  const hd2 = await R('#webamp .playlist-scrollbar-handle');
  const pos = await js(`Math.round(WinifyWebamp.getInstance().store.getState().display.playlistScrollPosition)`);
  check('scrollbar handle follows the pointer', Math.abs((hd2.y + hd2.h / 2) - (hd.y + hd.h / 2 + sb.h / 2)) <= 10, JSON.stringify({ handleMoved: (hd2.y - hd.y), pointerMoved: Math.round(sb.h / 2), scrollPos: pos }));
  // The resize above grew the playlist past the bottom of the window; put it back.
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'WINDOW_SIZE_CHANGED', windowId: 'playlist', size: [11, 5] })`); await h.wait(300);
  await focusPl(); await take(); const nb = await R('.playlist-next-button');
  const nbHit = await js(`(() => { const e = document.elementFromPoint(${nb.x + nb.w / 2}, ${nb.y + nb.h / 2}); return e && (e.id || e.className); })()`);
  press(nb.x + nb.w / 2, nb.y + nb.h / 2); await h.wait(800); cs = await take();
  check('mini transport Next works (Winify\'s order: plays the next row)', cs.some((c) => c[0] === 'nextTrack' || c[0] === 'api:play'), JSON.stringify({ calls: cs.map((c) => c[0]), button: nb, hit: nbHit }));
  // ADD opens Add to queue now; SEL still opens Webamp's own menu.
  const am = await R('#playlist-selection-menu'); press(am.x + am.w / 2, am.y + am.h / 2); await h.wait(300);
  const af = await R('#playlist-selection-menu .select-all'); const hit = af && await js(`(() => { const e = document.elementFromPoint(${af.x + af.w / 2}, ${af.y + af.h / 2}); return e && e.className; })()`);
  check('SEL menu opens and its items are where they are drawn', !!af && /select-all/.test(hit || ''), JSON.stringify({ af, hit }));

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
