// Jump to track (ADD, J) and the playlist picker (Eject, L) open and close, like LYRIC and VIZ.
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 240000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); return ok; };
  const R = (sel) => js(`(() => { const e = document.querySelector('#webamp ' + ${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; })()`);
  const key = async (k) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); if (k.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: k }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); await h.wait(400); };
  const away = async () => { await h.click(win, js, '#title-bar', 0.3, 0.5); await h.wait(150); };   // out of any text box
  const S = () => js('WinifySearch.isOpen()'), P = () => js('WinifyPicker.isOpen()'), L = () => js('WinifyLyrics.isOpen()');
  const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  const drag = async (sel, dx, dy) => { const r = await R(sel); const x = r.x + 60, y = r.y + 8;
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await h.wait(60);
    for (let i = 1; i <= 10; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: x + Math.round(dx * i / 10), y: y + Math.round(dy * i / 10), modifiers: ['leftButtonDown'] }); await h.wait(30); }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: x + dx, y: y + dy, button: 'left', clickCount: 1 }); await h.wait(400); };
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))'); await h.wait(1500);

  console.log('1. Jump to track: J and ADD');
  await away(); await key('J');
  check('J opens it', await S());
  await away(); await key('J');
  check('J again closes it', !(await S()));
  await h.click(win, js, '#playlist-add-menu'); await h.wait(500);
  check('ADD opens it', await S());
  await h.click(win, js, '#playlist-add-menu'); await h.wait(500);
  check('ADD again closes it', !(await S()));
  await away(); await key('J'); await key('J');
  check('J in its search box types the letter, and it stays open', (await S()) && /^j$/i.test(await js(`document.querySelector('.winify-search .ws-query').value`)),
    await js(`document.querySelector('.winify-search .ws-query') && document.querySelector('.winify-search .ws-query').value`));
  await js('WinifySearch.close()'); await h.wait(300);

  console.log('2. The playlist picker: L and Eject');
  await away(); await key('L');
  check('L opens it', await P());
  await away(); await key('L');
  check('L again closes it', !(await P()));
  await h.click(win, js, '#eject'); await h.wait(600);
  check('Eject opens it', await P());
  await h.click(win, js, '#eject'); await h.wait(500);
  check('Eject again closes it', !(await P()));
  await away(); await key('L'); await h.wait(300); await key('L');
  check('L in its filter types the letter, and it stays open', (await P()) && /^l$/i.test(await js(`document.querySelector('.winify-picker .wp-filter').value`)),
    await js(`document.querySelector('.winify-picker .wp-filter') && document.querySelector('.winify-picker .wp-filter').value`));
  await js('WinifyPicker.close()'); await h.wait(300);

  console.log('3. Renaming a mix: J and L type');
  await js(`localStorage.setItem('winify.mixes.v1', JSON.stringify([{ id: '1', name: 'Mix A', at: 1, playlists: 1, tracks: [{ uri: 'spotify:track:1', name: 'A - B', durationMs: 1000, from: 'P' }] }]))`);
  await away(); await key('L'); await h.wait(300);
  await h.click(win, js, '.winify-picker .wp-row[data-mix="1"]', 0.5, 0.5, 'right'); await h.wait(300);
  await js(`[...document.querySelectorAll('#webamp-context-menu li')].find((l) => l.textContent === 'Rename').click()`); await h.wait(200);
  await js(`(() => { const i = document.querySelector('.winify-picker .wp-rename'); i.focus(); i.value = ''; })()`);
  await key('J'); await key('L');
  const typed = await js(`document.querySelector('.winify-picker .wp-rename') && document.querySelector('.winify-picker .wp-rename').value`);
  check('J and L type into the name box; the picker stays open, Jump to track stays shut', /^jl$/i.test(typed || '') && (await P()) && !(await S()), JSON.stringify(typed));
  await key('Escape'); await js('WinifyPicker.close()'); await h.wait(300);

  console.log('4. Closing by toggling = the close button');
  const openThree = async () => { await js('WinifyPicker.open()'); await h.wait(400); await js('WinifySearch.open()'); await h.wait(400); await js('WinifyLyrics.open()'); await h.wait(600); };
  await openThree();
  const before = await R('.winify-lyrics');
  await away(); await key('J');
  const byKey = await R('.winify-lyrics');
  await js('WinifyLyrics.close(); WinifyPicker.close()'); await h.wait(400);
  await openThree();
  await h.click(win, js, '.winify-search .ws-close'); await h.wait(500);
  const byButton = await R('.winify-lyrics');
  check('J closing Jump to track: the panel after it slides over, exactly as with its x', !(await S()) && same(byKey, byButton) && !same(before, byKey), JSON.stringify({ before, byKey, byButton }));
  await js('WinifyLyrics.close(); WinifyPicker.close()'); await h.wait(400);
  await openThree();
  await away(); await key('L');
  const afterL = await R('.winify-lyrics');
  await js('WinifySearch.close(); WinifyLyrics.close()'); await h.wait(400);
  await openThree();
  await h.click(win, js, '.winify-picker .wp-close'); await h.wait(500);
  const afterX = await R('.winify-lyrics');
  check('L closing the picker: the same as its x', same(afterL, afterX), JSON.stringify({ afterL, afterX }));
  await js('WinifySearch.close(); WinifyLyrics.close(); WinifyPicker.close()'); await h.wait(400);

  console.log('5. Where you put it is kept');
  await js('WinifyPicker.open()'); await h.wait(500);
  await drag('.winify-picker', 140, 90);
  const placed = await R('.winify-picker');
  await away(); await key('L'); await h.wait(200);
  check('closed by L', !(await P()));
  await key('L'); await h.wait(400);
  check('reopened by L where it was left, at its size', same(await R('.winify-picker'), placed), JSON.stringify({ placed, now: await R('.winify-picker') }));
  await js('WinifySearch.open()'); await h.wait(500);
  await drag('.winify-search', -120, 160);
  const placedS = await R('.winify-search');
  await h.click(win, js, '#playlist-add-menu'); await h.wait(500);
  await h.click(win, js, '#playlist-add-menu'); await h.wait(600);
  check('Jump to track: closed and reopened by ADD where it was left, at its size', same(await R('.winify-search'), placedS), JSON.stringify({ placedS, now: await R('.winify-search') }));

  console.log('6. Inside Milkdrop, L is its preset list');
  // The picker open, Jump to track shut, everything lined up again (nothing over Milkdrop),
  // then Milkdrop by its V button and a click on its title bar, as the Milkdrop suite does.
  await js('WinifySearch.close(); WinifyPanels.reset()'); await h.wait(400);
  if (!(await P())) { await js('WinifyPicker.open()'); await h.wait(500); }
  if (await js('WinifyMilkdrop.isOpen()')) { await js('WinifyMilkdrop.toggle()'); await h.wait(400); }
  await h.click(win, js, '#webamp #button-v'); await h.wait(900);
  // Wait for the layout to settle: Milkdrop's title bar, uncovered.
  const clear = `(() => { const m = document.querySelector('#webamp .gen-window:not(.winify-frame)'); if (!m) return false; const b = m.getBoundingClientRect();
    const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height * 0.03); return !!(e && e.closest('.gen-window:not(.winify-frame)')); })()`;
  for (const end = Date.now() + 5000; Date.now() < end && !(await js(clear));) await h.wait(150);
  check('(Milkdrop\'s title bar is uncovered)', await js(clear));
  const active = `WinifyWebamp.getInstance().store.getState().windows.focused === 'milkdrop'`;
  for (let tries = 0; tries < 3 && !(await js(active)); tries++) {
    await h.click(win, js, '#webamp .gen-window:not(.winify-frame)', 0.5, 0.03);
    for (const end = Date.now() + 1500; Date.now() < end && !(await js(active));) await h.wait(100);
  }
  check('(Milkdrop is the active window)', await js(active), await js('WinifyWebamp.getInstance().store.getState().windows.focused'));
  await key('L');
  check('L in the Milkdrop window: its preset list; the picker stays open', (await js('WinifyWebamp.getInstance().store.getState().milkdrop.overlay')) === true && (await P()),
    JSON.stringify({ overlay: await js('WinifyWebamp.getInstance().store.getState().milkdrop.overlay'), picker: await P(), focused: await js('WinifyWebamp.getInstance().store.getState().windows.focused') }));
  await key('L');
  check('L again: the preset list closes; the picker still open', (await js('WinifyWebamp.getInstance().store.getState().milkdrop.overlay')) === false && (await P()));

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
