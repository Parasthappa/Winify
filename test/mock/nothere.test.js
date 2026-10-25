// Main window controls that do nothing in Winify (on a Mac: EQ, balance; anywhere: the A letter): drawn as
// the skin has them, but they don't respond, and say so on hover.
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 180000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); return ok; };
  const store = (expr) => js(`(() => { const s = WinifyWebamp.getInstance().store.getState(); return ${expr}; })()`);
  const title = (sel) => js(`(() => { const e = document.querySelector('#webamp ' + ${JSON.stringify(sel)}); return e && e.title; })()`);
  const box = (sel) => js(`(() => { const e = document.querySelector('#webamp ' + ${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  const drag = async (sel, fx0, fx1) => { const b = await box(sel); const y = Math.round(b.y + b.h / 2), x0 = Math.round(b.x + b.w * fx0), x1 = Math.round(b.x + b.w * fx1);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: x0, y }); win.webContents.sendInputEvent({ type: 'mouseDown', x: x0, y, button: 'left', clickCount: 1 }); await h.wait(60);
    for (let i = 1; i <= 8; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x0 + (x1 - x0) * i / 8), y, modifiers: ['leftButtonDown'] }); await h.wait(30); }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: x1, y, button: 'left', clickCount: 1 }); await h.wait(300); };
  const mainMenu = async () => {
    const b = await box('#main-window');
    const x = Math.round(b.x + 100), y = Math.round(b.y + 40);
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 }); await h.wait(400);
    const items = await js(`[...document.querySelectorAll('#webamp-context-menu li')].filter((l) => l.firstChild && l.firstChild.nodeType === 3 && getComputedStyle(l).display !== 'none').map((l) => l.firstChild.textContent.trim())`);
    await h.click(win, js, '#main-window', 0.5, 0.97); await h.wait(200);
    return items; };
  const calls = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))'));
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))'); await h.wait(1200);

  console.log('1. The EQ button');
  check('drawn as the skin has it, with the tooltip "Equalizer coming to Windows"', !!(await box('#equalizer-button')) && (await title('#equalizer-button')) === 'Equalizer coming to Windows');
  await h.click(win, js, '#equalizer-button');
  check('clicking it: the equalizer does not open', !(await store('s.windows.genWindows.equalizer.open')));
  check('...and it does not stay pressed', !(await js(`document.querySelector('#webamp #equalizer-button').classList.contains('winamp-active')`)));
  const items = await mainMenu();
  check('main menu: no Equalizer (Main Window, Playlist Editor, Milkdrop stay)', !items.includes('Equalizer') && items.includes('Playlist Editor') && items.includes('Main Window'), JSON.stringify(items));

  console.log('2. The balance slider');
  check('drawn as the skin has it, with the tooltip "Not available"; not reachable by Tab', !!(await box('#balance')) && (await title('#balance')) === 'Not available' && (await js(`document.querySelector('#webamp #balance').tabIndex`)) === -1);
  const thumbBefore = await js(`document.querySelector('#webamp #balance').value`);
  await drag('#balance', 0.5, 0.95);
  check('dragged right: it does not move, and the balance stays centred', (await store('s.media.balance')) === 0 && (await js(`document.querySelector('#webamp #balance').value`)) === thumbBefore, String(await store('s.media.balance')));
  await drag('#balance', 0.5, 0.05);
  check('dragged left: the same', (await store('s.media.balance')) === 0 && (await js(`document.querySelector('#webamp #balance').value`)) === thumbBefore);

  console.log('3. The clutter bar\'s A is always on top now (mock/ontop), not "Not available"');
  check('A\'s tooltip is "Always on top"', (await title('#button-a')) === 'Always on top');

  console.log('4. Mono / stereo: no clicks, so no tooltip');
  check('no tooltip on mono or stereo', !(await title('#mono')) && !(await title('#stereo')));

  console.log('5. The controls next to them still work');
  const vol0 = await store('s.media.volume');
  await drag('#volume', 0.5, 0.15);
  check('volume slider: drags', (await store('s.media.volume')) < vol0, vol0 + ' -> ' + (await store('s.media.volume')));
  const plOpen = await store('s.windows.genWindows.playlist.open');
  await h.click(win, js, '#playlist-button'); await h.wait(300);
  check('PL button: toggles the playlist', (await store('s.windows.genWindows.playlist.open')) !== plOpen);
  await h.click(win, js, '#playlist-button'); await h.wait(300);

  console.log('6. After windowshade and back, the same');
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'TOGGLE_WINDOW_SHADE_MODE', windowId: 'main' })`); await h.wait(300);
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'TOGGLE_WINDOW_SHADE_MODE', windowId: 'main' })`); await h.wait(400);
  check('tooltips back on the redrawn controls', (await title('#equalizer-button')) === 'Equalizer coming to Windows' && (await title('#balance')) === 'Not available');

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
