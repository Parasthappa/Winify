const { app } = require('electron'); const h = require('../lib/harness'); const fs = require('fs'), path = require('path');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 200000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); return ok; };
  const until = async (expr, ms = 5000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await js(expr).catch(() => null); if (v) return v; await h.wait(100); } return v; };
  const shot = async (name) => fs.writeFileSync(path.join(__dirname, '..', '.output', name), (await win.webContents.capturePage()).toPNG());
  const chars = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel + ' .character')})].map((c) => String.fromCharCode(+(c.className.match(/character-([0-9]+)/) || [0, 63])[1])).join('')`);
  const shown = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && getComputedStyle(e).visibility !== 'hidden'; })()`);
  await h.wait(1500);

  console.log('1. kbps / kHz / stereo');
  await js('(mock.active = "none")'); await js('WinifyControls.refresh()'); await h.wait(1500);
  check('nothing loaded: kbps, kHz and mono/stereo hidden', !(await shown('#webamp #kbps')) && !(await shown('#webamp #khz')) && !(await shown('#webamp .mono-stereo')));
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))');
  await until(`document.documentElement.classList.contains('winify-loaded')`, 6000); await h.wait(500);
  const kbps = await chars('#webamp #kbps'); const khz = await chars('#webamp #khz');
  check('playing: 256 kbps, 44 kHz (Spotify Premium\'s stream on the web player)', kbps.trim() === '256' && khz.trim() === '44' && (await shown('#webamp #kbps')) && (await shown('#webamp #khz')), JSON.stringify([kbps, khz]));
  check('...and the stereo light on, mono off', await js(`document.querySelector('#webamp #stereo').classList.contains('selected') && !document.querySelector('#webamp #mono').classList.contains('selected') && getComputedStyle(document.querySelector('#webamp .mono-stereo')).visibility !== 'hidden'`));
  await js('mock.setContext("spotify:album:a1", 3)'); await until(`WinifyControls.state().trackUri === 'spotify:track:2003'`, 6000); await h.wait(800);
  check('the next track too', (await chars('#webamp #kbps')).trim() === '256' && (await chars('#webamp #khz')).trim() === '44');

  // All four panels and the equalizer, for the frames and cursors.
  await js('WinifyPicker.open()'); await js('WinifySearch.open()'); await js('WinifyLyrics.open()'); await js('WinifyMilkdrop.toggle()');
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'TOGGLE_WINDOW', windowId: 'equalizer' })`);
  await until(`WinifyMilkdrop.isOpen() && WinifyPicker.isOpen() && WinifySearch.isOpen() && WinifyLyrics.isOpen()`, 6000); await h.wait(800);
  const TITLES = ['#webamp #main-window #title-bar', '#webamp #playlist-window .playlist-top', '#webamp #equalizer-window .title-bar',
    '#webamp .gen-window:not(.winify-frame) .gen-top', '#webamp .winify-picker .gen-top', '#webamp .winify-search .gen-top', '#webamp .winify-lyrics .gen-top'];
  const CORNERS = ['#webamp #playlist-window #playlist-resize-target', '#webamp .gen-window:not(.winify-frame) #gen-resize-target',
    '#webamp .winify-picker .winify-resize', '#webamp .winify-search .winify-resize', '#webamp .winify-lyrics .winify-resize'];
  const cursors = (sels) => js(`${JSON.stringify(sels)}.map((s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).cursor : 'MISSING ' + s; })`);
  // The frame pieces that make a title bar and border, as drawn (background image) for one window.
  const PIECES = ['.gen-top-left', '.gen-top-left-fill', '.gen-top-right', '.gen-middle-left', '.gen-middle-right', '.gen-bottom'];
  const frameOf = (root) => js(`${JSON.stringify(PIECES)}.map((p) => getComputedStyle(document.querySelector(${JSON.stringify(root)} + ' ' + p)).backgroundImage.slice(0, 120))`);
  const sameAsMilkdrop = async () => { const md = await frameOf('#webamp .gen-window:not(.winify-frame)');
    const out = []; for (const r of ['#webamp .winify-picker', '#webamp .winify-search', '#webamp .winify-lyrics']) out.push(JSON.stringify(await frameOf(r)) === JSON.stringify(md) && md.every((x) => /^url/.test(x))); return out; };
  const letters = (root) => js(`[...document.querySelectorAll(${JSON.stringify(root + ' .gen-top .gen-text-letter')})].map((c) => (c.className.match(/gen-text-([a-z]+)$/) || [0, '?'])[1]).map((x) => x === 'space' ? ' ' : x).join('')`);

  console.log('2. Default skin: frames, focus, cursors');
  check('the panels\' title bars and borders are drawn exactly as Milkdrop\'s (the skin\'s generic window)', (await sameAsMilkdrop()).every(Boolean), JSON.stringify(await sameAsMilkdrop()));
  check('titled in the skin\'s generic lettering: PLAYLISTS, JUMP TO TRACK, LYRICS (and MILKDROP)',
    JSON.stringify([await letters('#webamp .winify-picker'), await letters('#webamp .winify-search'), await letters('#webamp .winify-lyrics'), await letters('#webamp .gen-window:not(.winify-frame)')]) === '["playlists","jump to track","lyrics","milkdrop"]');
  await h.click(win, js, '#webamp .winify-picker .gen-top', 0.15, 0.5); await h.wait(300);
  const sel = () => js(`({ picker: document.querySelector('#webamp .winify-picker').classList.contains('selected'), search: document.querySelector('#webamp .winify-search').classList.contains('selected'),
    milkdrop: document.querySelector('#webamp .gen-window:not(.winify-frame)').classList.contains('selected'), webamp: WinifyWebamp.getInstance().store.getState().windows.focused })`);
  let s = await sel();
  check('focused: the clicked panel\'s frame is lit, the others and Webamp\'s windows are not', s.picker && !s.search && !s.milkdrop && s.webamp == null, JSON.stringify(s));
  const litLetter = await js(`getComputedStyle(document.querySelector('#webamp .winify-picker .gen-text-letter')).backgroundImage.slice(0, 80)`);
  const dimLetter = await js(`getComputedStyle(document.querySelector('#webamp .winify-search .gen-text-letter')).backgroundImage.slice(0, 80)`);
  check('...lit and unlit title lettering differ (the skin\'s focused and unfocused letters)', litLetter !== dimLetter && /^url/.test(litLetter), JSON.stringify([litLetter, dimLetter]));
  await h.click(win, js, '#webamp .gen-window:not(.winify-frame) .gen-top', 0.15, 0.5); await h.wait(300);
  s = await sel();
  check('Milkdrop clicked: it is lit, the panels are not', s.milkdrop && !s.picker && !s.search, JSON.stringify(s));
  await h.click(win, js, '#webamp #main-window #title-bar', 0.3, 0.5); await h.wait(300);
  s = await sel();
  check('the main window clicked: no panel lit', !s.picker && !s.search && !s.milkdrop && s.webamp === 'main', JSON.stringify(s));
  let tc = await cursors(TITLES); let rc = await cursors(CORNERS);
  check('no skin cursors: every title bar has the standard arrow', tc.every((c) => c === 'default'), JSON.stringify(tc));
  check('...every resize corner the standard diagonal resize cursor (Milkdrop\'s included)', rc.every((c) => c === 'nwse-resize'), JSON.stringify(rc));
  await shot('look-default.png');

  console.log('3. Another skin: recoloured frame, its own cursors');
  const oldTop = await js(`getComputedStyle(document.querySelector('#webamp .winify-lyrics .gen-top-left')).backgroundImage.slice(0, 120)`);
  // A second skin, through Webamp's own skin-loading action: the default skin's bitmaps with the
  // generic frame and lettering recoloured, and title-bar and resize cursors of its own.
  await js(`(async () => {
    const st = WinifyWebamp.getInstance().store; const d = st.getState().display;
    const tint = (url) => new Promise((resolve) => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.filter = 'hue-rotate(150deg) saturate(3)'; g.drawImage(img, 0, 0); resolve(c.toDataURL('image/png')); }; img.onerror = () => resolve(url); img.src = url; });
    // The default skin is a fixed stylesheet: its generic-frame and lettering bitmaps are read from it.
    const NAMES = { GEN_TOP_LEFT: '.gen-window .gen-top-left', GEN_TOP_LEFT_SELECTED: '.gen-window.selected .gen-top-left',
      GEN_TOP_LEFT_END: '.gen-window .gen-top-left-end', GEN_TOP_LEFT_END_SELECTED: '.gen-window.selected .gen-top-left-end',
      GEN_TOP_LEFT_RIGHT_FILL: '.gen-window .gen-top-left-fill', GEN_TOP_LEFT_RIGHT_FILL_SELECTED: '.gen-window.selected .gen-top-left-fill',
      GEN_TOP_RIGHT: '.gen-window .gen-top-right', GEN_TOP_RIGHT_SELECTED: '.gen-window.selected .gen-top-right',
      GEN_TOP_RIGHT_END: '.gen-window .gen-top-right-end', GEN_TOP_RIGHT_END_SELECTED: '.gen-window.selected .gen-top-right-end',
      GEN_TOP_CENTER_FILL: '.gen-window .gen-top', GEN_TOP_CENTER_FILL_SELECTED: '.gen-window.selected .gen-top',
      GEN_MIDDLE_LEFT: '.gen-window .gen-middle-left', GEN_MIDDLE_LEFT_BOTTOM: '.gen-window .gen-middle-left-bottom',
      GEN_MIDDLE_RIGHT: '.gen-window .gen-middle-right', GEN_MIDDLE_RIGHT_BOTTOM: '.gen-window .gen-middle-right-bottom',
      GEN_BOTTOM_FILL: '.gen-window .gen-bottom', GEN_BOTTOM_LEFT: '.gen-window .gen-bottom-left', GEN_BOTTOM_RIGHT: '.gen-window .gen-bottom-right' };
    for (const L of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { NAMES['GEN_TEXT_' + L] = '.gen-text-' + L.toLowerCase(); NAMES['GEN_TEXT_SELECTED_' + L] = '.gen-window.selected .gen-text-' + L.toLowerCase(); }
    const rules = [...document.styleSheets].flatMap((ss) => { try { return [...ss.cssRules]; } catch (e) { return []; } }).filter((r) => r.style && /^url/.test(r.style.backgroundImage || ''));
    const urlOf = (sel) => { const r = rules.find((x) => x.selectorText.split(',').some((t) => t.trim() === '#webamp ' + sel)); return r ? r.style.backgroundImage.slice(5, -2) : null; };
    const images = Object.assign({}, d.skinImages);
    window.__tinted = 0;
    for (const [name, sel] of Object.entries(NAMES)) { const u = urlOf(sel) || images[name]; if (u) { images[name] = await tint(u); window.__tinted++; } }
    const cur = (color) => { const c = document.createElement('canvas'); c.width = c.height = 16; const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 8, 8); return c.toDataURL('image/png'); };
    window.__testCursors = { TITLEBAR: { type: 'cur', url: cur('#f0f') }, PSIZE: { type: 'cur', url: cur('#0ff') } };
    st.dispatch({ type: 'SET_SKIN_DATA', data: { skinImages: images, skinColors: d.skinColors, skinPlaylistStyle: d.skinPlaylistStyle,
      skinCursors: window.__testCursors, skinRegion: d.skinRegion, skinGenLetterWidths: d.skinGenLetterWidths, skinGenExColors: d.skinGenExColors } });
    return true; })()`);
  await h.wait(1200);
  check('the frames follow the skin: the panels still drawn exactly as Milkdrop\'s, with the new bitmaps', (await sameAsMilkdrop()).every(Boolean) &&
    (await js(`getComputedStyle(document.querySelector('#webamp .winify-picker .gen-top-left')).backgroundImage`)) !== null, JSON.stringify(await sameAsMilkdrop()));
  const newTop = await js(`getComputedStyle(document.querySelector('#webamp .winify-lyrics .gen-top-left')).backgroundImage.slice(0, 120)`);
  check('...recoloured (' + (await js('__tinted')) + ' frame and lettering bitmaps): the panels\' frames changed with it', (await js('__tinted')) >= 70 && newTop !== oldTop, JSON.stringify([oldTop.slice(30, 70), newTop.slice(30, 70)]));
  const titleUrl = await js('__testCursors.TITLEBAR.url.slice(0, 40)'); const sizeUrl = await js('__testCursors.PSIZE.url.slice(0, 40)');
  tc = await cursors(TITLES); rc = await cursors(CORNERS);
  check('the skin\'s cursors: its title-bar cursor on every title bar', tc.every((c) => c.includes(titleUrl)), JSON.stringify(tc.map((c) => c.slice(0, 60))));
  check('...its resize cursor on every resize corner (Milkdrop\'s included)', rc.every((c) => c.includes(sizeUrl)), JSON.stringify(rc.map((c) => c.slice(0, 60))));
  await h.click(win, js, '#webamp .winify-search .gen-top', 0.15, 0.5); await h.wait(300);
  s = await sel();
  check('focus states with this skin too', s.search && !s.picker && !s.milkdrop, JSON.stringify(s));
  await shot('look-other-skin.png');
  check('(the frame is the recoloured one)', /^url/.test(newTop), newTop.slice(0, 40));

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
