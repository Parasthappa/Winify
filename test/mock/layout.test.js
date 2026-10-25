// The main window's controls per platform: on Mac no balance or EQ, the volume slider taking their room.
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 180000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); return ok; };
  const R = (sel) => js(`(() => { const e = document.querySelector('#webamp ' + ${JSON.stringify(sel)}); if (!e || getComputedStyle(e).display === 'none') return null; const m = document.querySelector('#webamp #main-window').getBoundingClientRect(); const b = e.getBoundingClientRect();
    return { x: Math.round(b.left - m.left), y: Math.round(b.top - m.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right - m.left) }; })()`);
  const store = (expr) => js(`(() => { const s = WinifyWebamp.getInstance().store.getState(); return ${expr}; })()`);
  const until = async (expr, ms = 4000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await js(expr).catch(() => null); if (v) return v; await h.wait(100); } return v; };
  const key = async (k, mods) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods || [] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods || [] }); await h.wait(300); };
  // The slider as drawn: the colour at a point of its bar (main-window pixels).
  const pixel = async (x, y) => { const m = await js(`(() => { const b = document.querySelector('#webamp #main-window').getBoundingClientRect(); return { x: b.left, y: b.top }; })()`);
    const img = await win.webContents.capturePage({ x: Math.round(m.x + x), y: Math.round(m.y + y), width: 1, height: 1 }); const b = img.toBitmap(); return [b[2], b[1], b[0]]; };
  const pressAt = async (x) => { const v = await R('#volume'); const m = await js(`(() => { const b = document.querySelector('#webamp #main-window').getBoundingClientRect(); return { x: b.left, y: b.top }; })()`);
    const X = Math.round(m.x + x), Y = Math.round(m.y + v.y + 6);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: X, y: Y }); win.webContents.sendInputEvent({ type: 'mouseDown', x: X, y: Y, button: 'left', clickCount: 1 }); await h.wait(60);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: X, y: Y, button: 'left', clickCount: 1 }); await h.wait(300); return store('s.media.volume'); };
  const setVol = async (v) => { await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'SET_VOLUME', volume: ${v} })`); await h.wait(300); };
  const mainMenu = async () => {
    const b = await js(`(() => { const e = document.querySelector('#webamp #main-window').getBoundingClientRect(); return { x: Math.round(e.left + 100), y: Math.round(e.top + 40) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: b.x, y: b.y, button: 'right', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'right', clickCount: 1 }); await h.wait(400);
    const items = await js(`[...document.querySelectorAll('#webamp-context-menu li')].filter((l) => l.firstChild && l.firstChild.nodeType === 3 && getComputedStyle(l).display !== 'none').map((l) => l.firstChild.textContent.trim())`);
    await key('Escape'); await h.click(win, js, '#main-window', 0.5, 0.97); await h.wait(200);
    return items; };
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))'); await h.wait(1200);
  await until(`WinifyControlsLayout.state().built`);

  console.log('1. Mac: no balance, no EQ button; the volume slider up to PL');
  const st = await js('WinifyControlsLayout.state()');
  const vol = await R('#volume'), pl = await R('#playlist-button');
  check('the Mac layout is used here', st.platform === 'mac' && JSON.stringify(st.hidden) === '["balance","equalizer"]', JSON.stringify(st));
  check('balance slider and EQ button hidden', !(await R('#balance')) && !(await R('#equalizer-button')));
  check('volume slider from x 107 to 2 px before PL (133 px), its input 3 px shorter as Webamp has it', vol.x === 107 && vol.r === pl.x - 2 && vol.w === 133 && (await R('#volume input')).w === 130, JSON.stringify({ vol, pl }));
  check('PL button where it was', pl.x === 242, JSON.stringify(pl));
  const under = await js(`[150, 200, 220, 236].map((x) => { const m = document.querySelector('#webamp #main-window').getBoundingClientRect(); const e = document.elementFromPoint(m.left + x, m.top + 63); return !!(e && e.closest('#volume')); })`);
  check('the pointer finds the slider all along it, also where the EQ button was', under.every(Boolean), JSON.stringify(under));
  const plUnder = await js(`(() => { const b = document.querySelector('#webamp #playlist-button').getBoundingClientRect(); const e = document.elementFromPoint(b.left + 10, b.top + 6); return !!(e && e.closest('#playlist-button')); })()`);
  check('...and PL is still a button', plUnder);

  console.log('2. The handle covers the whole length');
  // (Webamp's input is 3 px shorter than the slider: it ends at x 237.)
  const lo = await pressAt(108), hi = await pressAt(236), mid = await pressAt(107 + 65);
  check('pressing at its left end: volume near 0; at its right end (where EQ was): near 100; in the middle: about half',
    lo <= 5 && hi >= 95 && mid >= 40 && mid <= 60, JSON.stringify({ lo, hi, mid }));

  console.log('3. The skin\'s art, widened, not stretched; the colour still follows the volume');
  // Points clear of the handle at both volumes: x 112 (the skin's left third), x 232 (where EQ was).
  await setVol(90); const hiLeft = await pixel(112, 63), hiFar = await pixel(232, 63);
  await setVol(10); const loLeft = await pixel(112, 63), loFar = await pixel(232, 63);
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 3);
  check('at 90%: the far end (x 232, where EQ was) is the same colour as the near end', same(hiLeft, hiFar), JSON.stringify({ hiLeft, hiFar }));
  check('at 10%: the same again, in the low-volume colour', same(loLeft, loFar) && !same(loLeft, hiLeft), JSON.stringify({ loLeft, loFar, hiLeft }));
  await setVol(70);

  console.log('4. The main menu');
  const items = await mainMenu();
  check('main menu: no Equalizer (Main Window, Playlist Editor and Milkdrop stay)', !items.includes('Equalizer') && items.includes('Playlist Editor'), JSON.stringify(items));

  console.log('5. Another skin: its own volume art, widened the same way');
  // A volume image with a different colour in every column (and a darker backdrop at its top-left): the
  // widened slider must show its left third, then its middle third repeated, then its right third.
  await js(`(() => { const c = document.createElement('canvas'); c.width = 68; c.height = 420; const g = c.getContext('2d');
    for (let f = 0; f < 28; f++) for (let x = 0; x < 68; x++) { g.fillStyle = x === 0 ? 'rgb(5,5,5)' : 'rgb(' + (x * 3) + ',' + (f * 9) + ',200)'; g.fillRect(x, f * 15, 1, 15); }
    const st = WinifyWebamp.getInstance().store; const d = st.getState().display;
    st.dispatch({ type: 'SET_SKIN_DATA', data: { skinImages: Object.assign({}, d.skinImages, { MAIN_VOLUME_BACKGROUND: c.toDataURL('image/png') }),
      skinColors: d.skinColors, skinPlaylistStyle: d.skinPlaylistStyle, skinCursors: d.skinCursors || {}, skinRegion: d.skinRegion || {}, skinGenLetterWidths: d.skinGenLetterWidths, skinGenExColors: d.skinGenExColors } }); })()`);
  await h.wait(300); await until(`WinifyControlsLayout.state().built`);
  const cols = await js(`(async () => { const url = getComputedStyle(document.querySelector('#webamp #volume')).backgroundImage.slice(5, -2); const img = new Image(); img.src = url; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data; const at = (x, y) => [d[(y * img.width + x) * 4], d[(y * img.width + x) * 4 + 1], d[(y * img.width + x) * 4 + 2]];
    return { w: img.width, h: img.height, row: Array.from({ length: img.width }, (_, x) => at(x, 15 * 20 + 5)[0]) }; })()`);
  // Thirds of 68: columns 0-21, 22-45 (24 wide, repeated), 46-67 (at x 111-132).
  const expected = Array.from({ length: 133 }, (_, x) => x === 0 ? null : x < 22 ? x * 3 : x >= 133 - 22 ? (x - (133 - 68)) * 3 : (22 + (x - 22) % 24) * 3);
  const wrong = cols.row.map((v, x) => (expected[x] == null || v === expected[x] ? null : x)).filter((x) => x != null);
  check('133 x 420: columns 1-21 as the skin\'s, then its columns 22-45 repeated, then its last 22 (crisp: no blended values)', cols.w === 133 && cols.h === 420 && wrong.length === 0, JSON.stringify({ w: cols.w, wrong: wrong.slice(0, 10), row: cols.row.slice(0, 30) }));

  console.log('6. The Windows layout (1.1): balance and EQ back, the volume slider as Webamp has it');
  await js(`WinifyControlsLayout.use('windows')`); await h.wait(500);
  const wv = await R('#volume'), wb = await R('#balance'), we = await R('#equalizer-button');
  check('balance and EQ button shown; volume 68 px, ending 2 px before the balance slider', !!wb && !!we && wv.w === 68 && wv.r === wb.x - 2, JSON.stringify({ wv, wb, we }));
  const witems = await mainMenu();
  check('main menu: Equalizer back', witems.includes('Equalizer'), JSON.stringify(witems));
  await js(`WinifyControlsLayout.use('mac')`); await h.wait(300); await until(`WinifyControlsLayout.state().built`);
  check('back to Mac: hidden again, the volume slider long again', !(await R('#balance')) && (await R('#volume')).w === 133);

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
