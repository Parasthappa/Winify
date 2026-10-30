const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 240000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 240) : '')); };
  const R = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; })()`);
  const key = async (k, mods) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods || [] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods || [] }); await h.wait(80); };
  const type = async (t) => { for (const ch of t) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch }); win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch }); await h.wait(40); } };
  // Drag from a point by (dx, dy) with real mouse events. A busy page can lag
  // behind its input, so wait until it has handled the release (and every
  // move before it) rather than for a fixed time.
  const drag = async (x, y, dx, dy) => {
    const ups = await js('window.__ups === undefined ? (window.__ups = 0, window.addEventListener("pointerup", () => { window.__ups++; }, true), 0) : window.__ups');
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await h.wait(80);
    for (let i = 1; i <= 12; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: x + Math.round(dx * i / 12), y: y + Math.round(dy * i / 12), modifiers: ['leftButtonDown'] }); await h.wait(25); }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
    for (const end = Date.now() + 5000; Date.now() < end && (await js('window.__ups')) <= ups;) await h.wait(50);
    await h.wait(100);
  };
  const closed = async (sel) => { for (const end = Date.now() + 5000; Date.now() < end && (await R(sel)) && (await js(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display`)) !== 'none';) await h.wait(50); };
  const grab = async (sel) => { const t = await R(sel); return { x: t.x + 40, y: t.y + 8 }; };   // the title bar's left fill
  const inside = (d) => d.x >= 0 && d.y >= 0 && d.r <= 1200 && d.b <= 762;
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:playlist:big", 0), mock.setPaused(false))'); await h.wait(2500);
  if (!process.env.KEEP_PROFILE) {
    console.log('1. Jump to track opens beside the player');
    await h.click(win, js, '#title-bar', 0.3, 0.5); await h.wait(150); await key('J'); await h.wait(500);
    const m = await R('#main-window'); let d = await R('.winify-search');
    check('docked to the right of the player, top-aligned with the main window, not over it', d.x === m.r && d.y === m.y, JSON.stringify({ m, d }));

    console.log('2. Dragging by the title bar');
    let g = await grab('.winify-search .ws-top');
    await drag(g.x, g.y, 120, 90); let d2 = await R('.winify-search');
    check('moves with the pointer', d2.x === d.x + 120 && d2.y === d.y + 90, JSON.stringify({ d, d2 }));
    const pl = await R('#playlist-window');
    g = await grab('.winify-search .ws-top'); await drag(g.x, g.y, (pl.r + 9) - d2.x, (pl.y + 6) - d2.y);
    d = await R('.winify-search');
    check('dropped 9px from the playlist window\'s right edge: snaps flush, top aligned', d.x === pl.r && d.y === pl.y, JSON.stringify({ pl, d }));
    g = await grab('.winify-search .ws-top'); await drag(g.x, g.y, 2000, 2000); d = await R('.winify-search');
    check('dragged far past the bottom-right: stops at the window edge, fully visible', inside(d) && d.r === 1200 && d.b === 762, JSON.stringify(d));
    g = await grab('.winify-search .ws-top'); await drag(g.x, g.y, -3000, -3000); d = await R('.winify-search');
    check('dragged far past the top-left: stops at the edge', d.x === 0 && d.y === 0, JSON.stringify(d));
    g = await grab('.winify-search .ws-top'); await drag(g.x, g.y, 600, 300); const placed = await R('.winify-search');
    await h.click(win, js, '.winify-search .ws-close'); await h.wait(300);
    check('the close button still closes (it does not start a drag)', !(await js('WinifySearch.isOpen()')));
    await key('J'); await h.wait(500); d = await R('.winify-search');
    check('reopens where it was left', d.x === placed.x && d.y === placed.y, JSON.stringify({ placed, d }));

    console.log('3. Tooltips keep clear of the title bar');
    await key('Tab'); await type('road');
    // Wait for the results, then for the tooltip (its own delay is 0.5 s); fixed
    // waits were too short when suites run side by side.
    for (let i = 0; i < 40 && !(await js(`!!document.querySelector('.winify-search .ws-row:nth-child(4) .ws-album-col')`)); i++) await h.wait(100);
    const cell = await R('.winify-search .ws-row:nth-child(4) .ws-album-col');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: cell.x + 20, y: cell.y + 5 });
    let tip = null;
    for (let i = 0; i < 30 && !tip; i++) { await h.wait(100); tip = await R('.winify-tooltip'); }
    const top = await R('.winify-search .ws-top');
    check('long album name: full text in a tooltip below its row', !!tip && tip.y >= cell.b && (await js(`document.querySelector('.winify-tooltip').textContent`)) === 'Insomniac (Deluxe Edition) - 25th Anniversary Remaster', JSON.stringify({ cell, tip }));
    // 16 rows high again (it is resizable), then to the bottom: no room below its last row.
    const sz = await R('.winify-search'); const grip = await R('.winify-search .winify-grip');
    await drag(grip.x + 10, grip.y + 7, 0, 290 - sz.h);   // 6 steps: room for 17 rows
    g = await grab('.winify-search .ws-top'); await drag(g.x, g.y, 0, 2000);
    const last = await R('.winify-search .ws-row:nth-child(16) .ws-album-col');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: last.x + 20, y: last.y + 5 });
    tip = null; for (let i = 0; i < 30 && !tip; i++) { await h.wait(100); tip = await R('.winify-tooltip'); }   // its 0.5 s delay, under load
    const top2 = await R('.winify-search .ws-top');
    // The panel's own 38 px bottom bar leaves room under its last row: the tooltip goes there, on screen.
    check('at the bottom of the screen: the tooltip stays on screen, clear of the title bar', !!tip && tip.b <= (await js('innerHeight')) && tip.y >= top2.b && (tip.y >= last.b || tip.b <= last.y), JSON.stringify({ last, tip, title: top2 }));
    check('no browser tooltips (title attributes) in the window', (await js(`document.querySelectorAll('.winify-search [title]').length`)) === 0);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 700 }); await h.wait(200);
    check('tooltip goes away when the pointer leaves', !(await R('.winify-tooltip')));
    const finalSearch = await R('.winify-search');
    await key('Escape');

    console.log('4. The playlist picker: same behaviour, its own remembered spot');
    await h.click(win, js, '#eject'); await h.wait(1200);
    let p = await R('.winify-picker'); const m2 = await R('#main-window');
    check('opens beside the player, not over it', p.x === m2.r && p.y === m2.y, JSON.stringify({ m2, p }));
    g = await grab('.winify-picker .wp-top'); await drag(g.x, g.y, 300, 150); const pp = await R('.winify-picker');
    check('drags', pp.x === p.x + 300 && pp.y === p.y + 150, JSON.stringify({ p, pp }));
    await key('Escape'); await closed('.winify-picker'); await h.click(win, js, '#eject'); await h.wait(1000); p = await R('.winify-picker');
    check('reopens where it was left, separately from the search window', p.x === pp.x && p.y === pp.y, JSON.stringify({ pp, p }));
    await key('Escape');
    require('fs').writeFileSync(require('path').join(__dirname, '..', '.output', 'dialog-expected.json'), JSON.stringify({ search: finalSearch, picker: pp }));
  } else {
    console.log('5. After a relaunch');
    const e = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '.output', 'dialog-expected.json'), 'utf8'));
    await h.click(win, js, '#title-bar', 0.3, 0.5); await h.wait(150); await key('J'); await h.wait(600);
    let d = await R('.winify-search'); check('Jump to track reopens where it was left', d.x === e.search.x && d.y === e.search.y, JSON.stringify({ e: e.search, d }));
    await key('Escape'); await h.click(win, js, '#eject'); await h.wait(1000);
    const p = await R('.winify-picker'); check('the picker too', p.x === e.picker.x && p.y === e.picker.y, JSON.stringify({ e: e.picker, p }));
    await key('Escape');
    // A remembered spot that would now cover the main window is not used.
    await js(`localStorage.setItem('winify.dialogs.v1', JSON.stringify({ search: { x: 10, y: 10 } }))`);
    await key('J'); await h.wait(600); d = await R('.winify-search'); const m = await R('#main-window');
    check('a remembered spot over the main window is ignored: opens beside the player', d.x === m.r && d.y === m.y, JSON.stringify({ d, m }));
    await key('Escape');
  }
  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
