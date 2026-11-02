// The side panels follow the skin: frames from the playlist window's artwork when a skin has no
// GEN.BMP, readable colours, never a serif font, and a repaint when the skin changes with them open.
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 120000);
h.open().then(async ({ js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); };
  await h.wait(1500);
  await js('WinifyPicker.open()'); await js('WinifySearch.open()'); await js('WinifyLyrics.open()'); await h.wait(1200);
  // A skin with playlist artwork, no GEN.BMP, and colours and a font chosen to fail.
  const load = (style, gen) => js(`(() => {
    const art = (w, h, c) => { const k = document.createElement('canvas'); k.width = w; k.height = h; const g = k.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, w, h); return k.toDataURL(); };
    const d = WinifyWebamp.getInstance().store.getState().display;
    const images = {};
    for (const [n, w, ht] of [['TOP_TILE', 25, 20], ['TOP_LEFT_CORNER', 25, 20], ['TOP_RIGHT_CORNER', 25, 20], ['TOP_TILE_SELECTED', 25, 20], ['TOP_LEFT_SELECTED', 25, 20], ['TOP_RIGHT_CORNER_SELECTED', 25, 20], ['LEFT_TILE', 12, 29], ['RIGHT_TILE', 20, 29], ['BOTTOM_TILE', 25, 38], ['BOTTOM_LEFT_CORNER', 125, 38], ['BOTTOM_RIGHT_CORNER', 150, 38]]) images['PLAYLIST_' + n] = art(w, ht, '#336699');
    images.CHARACTER_32 = art(5, 6, '#000000'); images.CHARACTER_97 = art(5, 6, '#ffffff');
    if (${gen}) images.GEN_TOP_LEFT = art(25, 20, '#993333');
    WinifyWebamp.getInstance().store.dispatch({ type: 'SET_SKIN_DATA', data: { skinImages: images, skinColors: d.skinColors, skinCursors: d.skinCursors, skinPlaylistStyle: ${JSON.stringify(style)}, skinRegion: d.skinRegion, skinGenLetterWidths: d.skinGenLetterWidths, skinGenExColors: d.skinGenExColors } });
  })()`);
  const css = () => js(`document.getElementById('winify-skin-panels').textContent`);

  console.log('1. No GEN.BMP: frames from the playlist artwork');
  await load({ normal: '#336699', current: '#336699', normalbg: '#336699', selectedbg: '#ffff00', font: 'No Such Font At All' }, false); await h.wait(600);
  check('the frame comes from the playlist window', (await js('WinifySkin.state().frame')) === 'pledit');
  const rules = await css();
  check('frame pieces and the title lettering are drawn', /\.gen-top-left \{ background-image/.test(rules) && /\.gen-bottom-right \{ background-image/.test(rules) && /\.gen-text-a \{ background-image/.test(rules));

  console.log('2. Readable colours, no serif');
  const seen = await js(`(() => { const read = (s) => { const e = document.querySelector(s); const c = getComputedStyle(e); return { color: c.color, bg: c.backgroundColor, font: c.fontFamily }; };
    return { lyrics: read('.winify-lyrics .wl-body'), filter: read('.winify-picker .wp-filter'), query: read('.winify-search .ws-query') }; })()`);
  for (const [name, s] of Object.entries(seen)) {
    const ratio = await js(`WinifySkin.contrast(${JSON.stringify(s.color)}, ${JSON.stringify(s.bg)})`);
    check(name + ': followed the skin at once, readable on its background', s.bg === 'rgb(51, 102, 153)' && ratio >= 3.5, JSON.stringify(s) + ' ' + ratio.toFixed(1));
    check(name + ': a font that is not installed falls back to sans-serif', /sans-serif$/.test(s.font) && !/\bserif\b/.test(s.font.replace('sans-serif', '')), s.font);
  }
  const row = await js(`(() => { const st = WinifySkin.state().style; return WinifySkin.contrast(st.onSelected, st.selectedbg); })()`);
  check('selected rows are readable too', row >= 3.5, row);
  const lettering = await css();
  check('hint-bar lettering is redrawn in the panel colours, with a selected version for buttons', /\.winify-frame \.character-97 \{ background-image/.test(lettering) && /aria-pressed="true"\] \.character-97/.test(lettering));

  console.log('3. A skin with GEN.BMP is left to Webamp');
  await load({ normal: '#ffffff', current: '#ffff00', normalbg: '#000000', selectedbg: '#0000c6', font: 'Arial' }, true); await h.wait(600);
  check('no frame is built', (await js('WinifySkin.state().frame')) === 'gen' && !/\.gen-top-left \{/.test(await css()));
  check('its colours are kept as they are, being readable', JSON.stringify(await js(`(() => { const s = WinifySkin.state().style; return [s.normal, s.current]; })()`)) === JSON.stringify(['#ffffff', '#ffff00']));

  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
