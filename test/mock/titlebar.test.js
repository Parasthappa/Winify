// The main window's title bar: no buttons, the right-hand band carried on in the skin's own art.
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 180000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); return ok; };
  const store = (expr) => js(`(() => { const s = WinifyWebamp.getInstance().store.getState(); return ${expr}; })()`);
  const R = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; })()`);
  // The title bar as drawn, one RGB value per skin pixel ([x][y], 275 x 14).
  const grab = async () => {
    const r = await R('#main-window #title-bar');
    const img = await win.webContents.capturePage({ x: r.x, y: r.y, width: r.w, height: r.h });
    const size = img.getSize(); const k = size.width / r.w; const bmp = img.toBitmap();   // BGRA
    const px = [];
    for (let x = 0; x < r.w; x++) { px.push([]); for (let y = 0; y < r.h; y++) {
      const i = (Math.floor((y + 0.5) * k) * size.width + Math.floor((x + 0.5) * k)) * 4; px[x].push([bmp[i + 2], bmp[i + 1], bmp[i]]); } }
    return px;
  };
  const near = (a, b) => Math.abs(a[0] - b[0]) <= 3 && Math.abs(a[1] - b[1]) <= 3 && Math.abs(a[2] - b[2]) <= 3;
  const colsMatch = (px, pairs, rows) => pairs.filter(([at, from]) => !rows.every((y) => near(px[at][y], from(y)))).map(([at]) => at);
  const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
  const ROWS_BAND = range(3, 12), ROWS_EDGE = [0, 1, 2, 12, 13];
  const calls = () => js('JSON.stringify(calls.splice(0))').then(JSON.parse);
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))'); await h.wait(1200);
  await h.click(win, js, '#main-window #title-bar', 0.3, 0.5); await h.wait(300);

  console.log('1. No buttons');
  const bar = await R('#main-window #title-bar');
  const under = await js(`[248, 258, 268].map((x) => { const b = document.querySelector('#main-window #title-bar').getBoundingClientRect(); const e = document.elementFromPoint(b.left + x, b.top + 7); return e && e.id; })`);
  check('where minimize, windowshade and close were, the pointer finds the title bar itself', under.every((id) => id === 'title-bar'), JSON.stringify(under));
  check('no "Minimize" / "Toggle Windowshade Mode" / "Close" tooltips there', !(await js(`[...document.querySelectorAll('#main-window #title-bar [title]')].some((e) => /Minimize|Windowshade|Close/.test(e.title) && getComputedStyle(e).pointerEvents !== 'none')`)));
  await calls();
  for (const x of [248, 258, 268]) { await h.click(win, js, '#main-window #title-bar', x / 275, 0.5); await h.wait(200); }
  const cs = (await calls()).filter((c) => c[0] === 'windowCommand');
  check('clicking where they were: no minimize, no close, no windowshade', cs.length === 0 && !(await store('s.windows.genWindows.main.shade')) && !!(await R('#main-window')), JSON.stringify(cs));
  check('the playlist window keeps its own close button', !!(await R('#playlist-window #playlist-close-button')));

  console.log('2. The default skin: the band carried on to the right edge');
  for (const state of ['focused', 'unfocused']) {
    if (state === 'unfocused') { await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'SET_FOCUSED_WINDOW', window: null })`); await h.wait(300); }
    const px = await grab();
    // The band's middle, x 205-232, carried on at x 241-268; its end (x 241-243) at x 269-271; the title bar's own edges above and below.
    const fill = colsMatch(px, range(244, 269).map((x) => [x, (y) => px[205 + x - 241][y]]), ROWS_BAND);
    const endsRound = [5, 9].every((y) => !near(px[269][y], px[230][y]));
    check(state + ': where the buttons were, the band carries on (same pixels as its middle)', fill.length === 0, 'columns differing: ' + JSON.stringify(fill));
    check(state + ': ...ending in the band\'s rounded end at x 269 (its top and bottom stripes darker there), just before the right border', endsRound,
      JSON.stringify({ end: [px[269][5], px[269][9]], mid: [px[230][5], px[230][9]] }));
  }
  await h.click(win, js, '#main-window #title-bar', 0.3, 0.5); await h.wait(300);

  console.log('3. Dragging across its whole width; windowshade by double-click');
  const before = await R('#main-window');
  const x0 = bar.x + 266, y0 = bar.y + 7;
  win.webContents.sendInputEvent({ type: 'mouseMove', x: x0, y: y0 }); win.webContents.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 }); await h.wait(60);
  for (let i = 1; i <= 10; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: x0 + 8 * i, y: y0 + 6 * i, modifiers: ['leftButtonDown'] }); await h.wait(30); }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: x0 + 80, y: y0 + 60, button: 'left', clickCount: 1 }); await h.wait(500);
  const moved = await R('#main-window');
  check('dragged from where the close button was: the window moves', moved.x === before.x + 80 && moved.y === before.y + 60, JSON.stringify({ before, moved }));
  const dbl = async (x) => { const b = await R('#main-window #title-bar'); const X = b.x + x, Y = b.y + 7;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: X, y: Y });
    for (const n of [1, 2]) { win.webContents.sendInputEvent({ type: 'mouseDown', x: X, y: Y, button: 'left', clickCount: n }); win.webContents.sendInputEvent({ type: 'mouseUp', x: X, y: Y, button: 'left', clickCount: n }); await h.wait(40); }
    await h.wait(500); };
  await dbl(260);
  check('double-click on the title bar (where the buttons were): windowshade', await store('s.windows.genWindows.main.shade'));
  const sh = await grab();
  const flat = colsMatch(sh, range(244, 272).map((x) => [x, (y) => sh[244][y]]), range(0, 14));
  check('windowshade: no buttons drawn either (plain title bar there)', flat.length === 0 && !(await js(`[...document.querySelectorAll('#main-window #title-bar #shade, #main-window #title-bar #close')].some((e) => getComputedStyle(e).display !== 'none')`)), 'columns differing: ' + JSON.stringify(flat));
  await dbl(260);
  check('double-click again: back to the full window', !(await store('s.windows.genWindows.main.shade')));

  console.log('4. Another skin: its own title bar art');
  // A title bar image with a different colour in every pixel, through Webamp's own skin loading
  // (which builds a skin's styles only with a cursor set: an empty one here).
  await js(`(() => { const make = (lit) => { const c = document.createElement('canvas'); c.width = 275; c.height = 14; const g = c.getContext('2d');
      for (let x = 0; x < 275; x++) for (let y = 0; y < 14; y++) { g.fillStyle = 'rgb(' + (x % 128 + (lit ? 128 : 0)) + ',' + Math.floor(x / 128) * 60 + ',' + y * 18 + ')'; g.fillRect(x, y, 1, 1); }
      return c.toDataURL('image/png'); };
    const st = WinifyWebamp.getInstance().store; const d = st.getState().display;
    st.dispatch({ type: 'SET_SKIN_DATA', data: { skinImages: Object.assign({}, d.skinImages, { MAIN_TITLE_BAR: make(false), MAIN_TITLE_BAR_SELECTED: make(true) }),
      skinColors: d.skinColors, skinPlaylistStyle: d.skinPlaylistStyle, skinCursors: d.skinCursors || {}, skinRegion: d.skinRegion || {}, skinGenLetterWidths: d.skinGenLetterWidths, skinGenExColors: d.skinGenExColors } }); })()`);
  await h.wait(800);
  for (const lit of [true, false]) {
    if (!lit) { await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'SET_FOCUSED_WINDOW', window: null })`); await h.wait(300); }
    else { await h.click(win, js, '#main-window #title-bar', 0.3, 0.5); await h.wait(300); }
    const px = await grab();
    const src = (x) => (y) => [x % 128 + (lit ? 128 : 0), Math.floor(x / 128) * 60, y * 18];
    const left = colsMatch(px, range(0, 241).map((x) => [x, src(x)]), range(0, 14));
    const fill = colsMatch(px, range(241, 269).map((x) => [x, src(205 + x - 241)]), ROWS_BAND);
    const end = colsMatch(px, range(269, 272).map((x) => [x, src(241 + x - 269)]), ROWS_BAND);
    const edge = colsMatch(px, range(243, 272).map((x) => [x, src(263)]), ROWS_EDGE);
    check((lit ? 'focused' : 'unfocused') + ': the skin\'s title bar as it is up to x 240, its band middle (x 205-232) at x 241-268, its band end (x 241-243) at x 269-271, its x 263 above and below',
      left.length === 0 && fill.length === 0 && end.length === 0 && edge.length === 0,
      JSON.stringify({ fill, end, edge, left: left.length, sample: [px[100][7], src(100)(7)] }));
  }

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
