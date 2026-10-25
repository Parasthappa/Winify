// The side panels keep clear of the chassis (the Winify panel with what's playing), at several screen sizes, and
// the chassis is drawn above every window. A stand-in chassis here, sized and placed as the real one (446 x 350,
// bottom-right, 16 px in), layered as index.html layers it.
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 300000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); return ok; };
  const SEL = { picker: '.winify-picker', search: '.winify-search', lyrics: '.winify-lyrics', milkdrop: '.gen-window:not(.winify-frame)' };
  const R = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; })()`);
  const overlap = (a, c) => !!a && !!c && a.x < c.r && a.r > c.x && a.y < c.b && a.b > c.y;
  const openAll = async () => {
    await js(`WinifyPicker.open()`); await h.wait(300); await js(`WinifySearch.open()`); await h.wait(300);
    await js(`WinifyLyrics.open()`); await h.wait(300); if (!(await js('WinifyMilkdrop.isOpen()'))) await js('WinifyMilkdrop.toggle()'); await h.wait(900); };
  const closeAll = async () => { await js(`WinifyPicker.close(); WinifySearch.close(); WinifyLyrics.close(); if (WinifyMilkdrop.isOpen()) WinifyMilkdrop.toggle()`); await h.wait(400); };
  const rects = async () => { const o = {}; for (const id of Object.keys(SEL)) o[id] = await R('#webamp ' + SEL[id]); return o; };
  // Whether a spot right of / under the column could hold a panel clear of the chassis is the stack's business;
  // here: none of the four panels may cover the chassis when the screen has room for them elsewhere.
  const placeChassis = (x, y) => js(`(() => { let c = document.getElementById('login-screen');
    if (!c) { c = document.createElement('section'); c.id = 'login-screen'; c.style.cssText = 'position:fixed; z-index:2; width:446px; height:350px; background:#c9cfd4; border-radius:20px;'; document.body.appendChild(c); }
    c.style.left = ${x} + 'px'; c.style.top = ${y} + 'px'; return true; })()`);
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))'); await h.wait(1000);

  console.log('1. The default stack, at four screen sizes');
  for (const [W0, H0, roomy] of [[1440, 900, true], [1200, 1000, true], [1024, 768, false], [900, 640, false]]) {
    // The window as large as asked, or as the display allows: the sizes used are the real ones.
    win.setContentSize(W0, H0); await h.wait(700);
    const W = await js('innerWidth'), H = await js('innerHeight');
    await closeAll(); await js('WinifyPanels.reset()'); await js(`WinifyWebamp.resetLayout()`); await h.wait(800);
    await placeChassis(W - 446 - 16, H - 350 - 16);
    await openAll();
    const c = await R('#login-screen'), p = await rects();
    const covering = Object.keys(p).filter((id) => overlap(p[id], c));
    const onScreen = Object.values(p).every((r) => r && r.x >= 0 && r.y >= 0 && r.r <= W + 1 && r.b <= H + 1);
    if (roomy) check(W + 'x' + H + ': all four panels open, on screen, none over the chassis', covering.length === 0 && onScreen, JSON.stringify({ covering, p, c }));
    else check(W + 'x' + H + ' (small): all four on screen; any panel left over the chassis only where nothing else was free', onScreen, JSON.stringify({ covering, p, c }));
    // Whatever overlaps, the chassis is on top: its middle and corners are the chassis's own.
    const top = await js(`(() => { const c = document.getElementById('login-screen').getBoundingClientRect(); const pts = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]];
      return pts.every(([fx, fy]) => { const e = document.elementFromPoint(c.left + c.width * fx, c.top + c.height * fy); return e && e.closest('#login-screen'); }); })()`);
    check(W + 'x' + H + ': the chassis is drawn above the windows', top);
    if (!roomy) console.log('       (' + (covering.length ? covering.join(', ') + ' partly under the chassis: no free spot left' : 'none under the chassis') + ')');
  }

  console.log('2. Panels dragged onto it stay under it');
  win.setContentSize(1440, 900); await h.wait(700);
  const W2 = await js('innerWidth'), H2 = await js('innerHeight');
  await closeAll(); await js('WinifyPanels.reset()'); await js(`WinifyWebamp.resetLayout()`); await h.wait(800);
  await placeChassis(W2 - 446 - 16, H2 - 350 - 16); await openAll();
  const c = await R('#login-screen');
  await js(`(() => { const el = document.querySelector('#webamp .winify-lyrics'); const r = el.getBoundingClientRect(); return true; })()`);
  // Drag the lyrics panel by its title bar onto the chassis's middle.
  const ly = await R('#webamp .winify-lyrics .gen-top');
  const x0 = ly.x + 60, y0 = ly.y + 8, x1 = Math.round((c.x + c.r) / 2), y1 = Math.round((c.y + c.b) / 2);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: x0, y: y0 }); win.webContents.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 }); await h.wait(60);
  for (let i = 1; i <= 12; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x0 + (x1 - x0) * i / 12), y: Math.round(y0 + (y1 - y0) * i / 12), modifiers: ['leftButtonDown'] }); await h.wait(30); }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1 }); await h.wait(500);
  const dragged = await R('#webamp .winify-lyrics');
  const middle = await js(`(() => { const c = document.getElementById('login-screen').getBoundingClientRect(); const e = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2); return e && e.closest('#login-screen') ? 'chassis' : (e && e.className); })()`);
  check('lyrics dragged onto the chassis: it is there, under the chassis (the chassis drawn above)', overlap(dragged, c) && middle === 'chassis', JSON.stringify({ dragged, c, middle }));
  await js(`WinifyLyrics.focus && WinifyLyrics.focus()`);
  check('...even after clicking it to the front of the other panels', (await js(`(() => { const c = document.getElementById('login-screen').getBoundingClientRect(); const e = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2); return !!(e && e.closest('#login-screen')); })()`)));

  console.log('3. Reset window layout keeps clear of it too');
  await js(`WinifyWebamp.resetLayout()`); await h.wait(1200);
  let p = await rects();
  check('after Reset: the dragged panel is back in the stack, and none is over the chassis', Object.keys(p).filter((id) => overlap(p[id], c)).length === 0 && !(await js('WinifyPanels.state().placed.lyrics')), JSON.stringify({ p, c }));

  console.log('4. Moving the chassis restacks');
  await placeChassis(W2 - 446 - 16, 16);
  await js(`window.dispatchEvent(new CustomEvent('winify:chassis-moved'))`); await h.wait(800);
  const c2 = await R('#login-screen'); p = await rects();
  check('chassis moved to the top-right: the stack moves out of its way', Object.keys(p).filter((id) => overlap(p[id], c2)).length === 0, JSON.stringify({ p, c2 }));

  console.log('5. Menus still open above it');
  const b = await R('#webamp #main-window');
  // Webamp's main menu, from the title bar's left-hand icon: Webamp draws it outside #webamp-root, at its zIndex + 1.
  await h.click(win, js, '#webamp #main-window #title-bar #option'); await h.wait(400);
  const menuZ = await js(`(() => { const m = document.querySelector('#webamp-context-menu, .context-menu'); if (!m) return null; let e = m; while (e && e !== document.body && getComputedStyle(e).zIndex === 'auto') e = e.parentElement; return e && getComputedStyle(e).zIndex; })()`);
  check('Webamp\'s menus are layered above the chassis (z-index above 2)', Number(menuZ) > 2, String(menuZ));
  await h.click(win, js, '#webamp #main-window', 0.5, 0.97); await h.wait(200);

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
