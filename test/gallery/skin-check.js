// Every skin in test/skins/ (and its museum/ and named/ folders; kept out of git) loaded with the
// side panels open against the fake Spotify (no Spotify requests), and measured on screen: does it
// load, are the panels framed, is their text readable, is no serif font used as a fallback, and are
// LYRIC and VIZ drawn or left as the skin's own.
//
//   electron test/gallery/skin-check.js        (SKIN_ONLY=name: only skins with that in their name, with a photo of each)
//     -> test/.output/skin-check/failures.png (only the skins that fail, with the reasons),
//        report.json, and the count here.
const { app } = require('electron'); const h = require('../lib/harness');
const fs = require('fs'), path = require('path');
const SKINS = path.join(__dirname, '..', 'skins');
const ONLY = process.env.SKIN_ONLY;
const OUT = path.join(__dirname, '..', '.output', ONLY ? 'skin-check-one' : 'skin-check');
const AA = 4.5;          // WCAG AA for small text; panel text is 9-10 px
const TITLE_AA = 3;      // pixel-letter titles on textured artwork
const SERIF = /times|georgia|palatino|baskerville|didot|hoefler|cambria|garamond|bodoni|serif$/i;
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 1800000);

// Runs in the page: what is really shown.
async function measure(AA, TITLE_AA) {
  const parse = (c) => { const m = String(c).match(/[\d.]+/g).map(Number); return { c: m.slice(0, 3), a: m[3] === undefined ? 1 : m[3] }; };
  const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const backOf = (e) => { for (let n = e; n && n.nodeType === 1; n = n.parentElement) { const b = parse(getComputedStyle(n).backgroundColor); if (b.a > 0.5) return b.c; } return [0, 0, 0]; };
  const opacityOf = (e) => { let o = 1; for (let n = e; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
  const out = { fails: [], low: [] };
  const fail = (kind, text) => out.fails.push({ kind, text });
  const text = (name, selector) => {
    const e = document.querySelector(selector);
    if (!e) return;
    const back = backOf(e), fg = parse(getComputedStyle(e).color).c, o = opacityOf(e);
    const shown = fg.map((v, i) => v * o + back[i] * (1 - o));
    const r = ratio(shown, back);
    if (r < AA) fail('unreadable text', name + ' ' + r.toFixed(1) + ':1 (rgb ' + fg.join(',') + ' on ' + back.join(',') + ')');
  };
  text('lyrics title', '.winify-lyrics .wl-track');
  text('lyrics text', '.winify-lyrics .wl-note');
  text('filter', '.winify-picker .wp-filter');
  text('search box', '.winify-search .ws-query');
  text('search note', '.winify-search .ws-status');
  text('list row', '.winify-picker .wp-row[data-index]:not([style*="background"]) .wp-name');
  text('selected row', '.winify-picker .wp-row[style*="background"] .wp-name');
  text('section label', '.winify-picker .wp-label');
  const st = WinifySkin.state().style;
  const hex = (c) => { const g = document.createElement('canvas').getContext('2d'); g.fillStyle = c; const v = g.fillStyle; return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)); };
  for (const [name, a, b] of [['current row', st.current, st.normalbg], ['current selected row', st.currentOnSelected, st.selectedbg], ['selected row colours', st.onSelected, st.selectedbg]]) {
    const r = ratio(hex(a), hex(b));
    if (r < AA) fail('unreadable text', name + ' ' + r.toFixed(1) + ':1 (' + a + ' on ' + b + ')');
  }
  if (ratio(hex(st.selectedbg), hex(st.normalbg)) < 1.3) fail('invisible selection', st.selectedbg + ' on ' + st.normalbg);
  // Pixels of a CSS background image.
  const pixels = async (e) => {
    const m = /url\("([^"]+)"\)/.exec(getComputedStyle(e).backgroundImage);
    if (!m) return null;
    const img = new Image(); img.src = m[1]; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    return { w: img.width, h: img.height, d: g.getImageData(0, 0, img.width, img.height).data };
  };
  const inkOf = (p) => { let ink = 0, c = null; for (let i = 0; i < p.d.length; i += 4) if (p.d[i + 3] > 128) { ink++; c = [p.d[i], p.d[i + 1], p.d[i + 2]]; } return { share: ink / (p.w * p.h), c }; };
  // Hint bars and dialog lettering: letters with ink, not blank or solid blocks, readable.
  const seen = new Set();
  let blank = 0, solid = 0, letters = 0, worst = 99;
  for (const e of document.querySelectorAll('.winify-frame .wl-info .character, .winify-frame .wp-info .character, .winify-frame .ws-info .character, .winify-frame .wq-body .character')) {
    const code = Number((/character-(\d+)/.exec(e.className) || [])[1]);
    if (code === 32 || !code) continue;
    const key = getComputedStyle(e).backgroundImage + '|' + e.parentElement.className;
    if (seen.has(key)) continue;
    seen.add(key);
    const p = await pixels(e);
    if (!p) { blank++; letters++; continue; }
    letters++;
    const ink = inkOf(p);
    if (ink.share === 0) blank++;
    else if (ink.share > 0.85) solid++;
    else worst = Math.min(worst, ratio(ink.c, backOf(e)));
  }
  if (letters && blank / letters > 0.2) fail('hint lettering', blank + ' of ' + letters + ' letters are blank');
  if (letters && solid / letters > 0.2) fail('hint lettering', solid + ' of ' + letters + ' letters are solid blocks');
  if (worst < AA && worst !== 99) fail('hint lettering', 'contrast ' + worst.toFixed(1) + ':1');
  // Frames: the artwork is really there.
  out.frame = WinifySkin.state().frame;
  // 'default': neither GEN.BMP nor PLEDIT.BMP. The default frame is then right, as the skin's playlist
  // window has it too; it still has to be there.
  for (const part of ['.gen-top-left', '.gen-middle-left', '.gen-bottom-left', '.gen-top-right', '.gen-middle-right']) {
    const p = await pixels(document.querySelector('.winify-lyrics ' + part));
    if (!p) { fail('no frame', part + ' has no artwork'); continue; }
    const cover = inkOf(p).share;
    if (cover < 0.5) fail('no frame', part + ' is ' + Math.round(cover * 100) + '% drawn');
  }
  // A built title: readable on the title bar's own pixels.
  if (out.frame === 'pledit') {
    for (const frame of [...document.querySelectorAll('.winify-frame')].slice(0, 4)) {
      const selected = frame.classList.contains('selected');
      const letter = frame.querySelector('.gen-top-title .gen-text-letter:not(.gen-text-space)');
      const tile = await pixels(frame.querySelector('.gen-top-left-fill'));
      const p = letter && await pixels(letter);
      if (!p || !tile) { fail('unreadable title', 'no title letters'); continue; }
      const ink = inkOf(p);
      if (!ink.c) { fail('unreadable title', 'blank title letters'); continue; }
      const cell = frame.querySelector('.gen-top-title');
      const plate = parse(getComputedStyle(cell).backgroundColor);
      if (plate.a > 0.5) {   // letters on a plate
        const r = ratio(ink.c, plate.c);
        if (r < TITLE_AA) fail('unreadable title', 'plate ' + r.toFixed(1) + ':1');
        continue;
      }
      // Only the rows the letters sit on.
      let good = 0, n = 0; const counts = {};
      for (let i = 2 * tile.w * 4; i < 12 * tile.w * 4; i += 4) { n++; if (ratio(ink.c, [tile.d[i], tile.d[i + 1], tile.d[i + 2]]) >= TITLE_AA) good++; const k = (tile.d[i] >> 4) + ',' + (tile.d[i + 1] >> 4) + ',' + (tile.d[i + 2] >> 4); counts[k] = (counts[k] || 0) + 1; }
      if (good / n < 0.95) fail('unreadable title', 'readable on only ' + Math.round(100 * good / n) + '% of the title bar (selected: ' + selected + ')');
      if (Math.max(...Object.values(counts)) / n < 0.85) fail('unreadable title', 'letters directly on busy artwork (selected: ' + selected + ')');
    }
  }
  // Declared fonts always end in sans-serif.
  for (const s of ['.winify-lyrics .wl-body', '.winify-picker .wp-body', '.winify-search .ws-body', '.winify-search .ws-query']) {
    const f = getComputedStyle(document.querySelector(s)).fontFamily;
    if (!/sans-serif$/.test(f)) fail('serif fallback', s + ' has no sans-serif fallback: ' + f);
  }
  // Labels: a stylesheet (drawn) or nothing (the skin's own), on the real buttons.
  const label = (id, button) => {
    const style = document.getElementById(id), b = document.querySelector(button);
    if (!style || !b) { fail('labels', button + ' missing'); return 'missing'; }
    if (!style.textContent) return 'own';
    if (!/url\("data:image\/png/.test(getComputedStyle(b).backgroundImage)) fail('labels', button + ' drawn but not shown');
    return 'drawn';
  };
  out.lyric = label('winify-lyric-button', '#playlist-misc-menu');
  out.viz = label('winify-viz-button', '#playlist-list-menu');
  out.style = st;
  out.fallbacks = [...st.fallbacks, ...WinifySkin.state().fallbacks];
  out.declaredFont = (WinifyWebamp.getInstance().store.getState().display.skinPlaylistStyle || {}).font || '';
  return out;
}

h.open().then(async ({ win, js }) => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const errors = [];
  win.webContents.on('console-message', (e) => { const m = e.message || ''; if (e.level === 'error' || e.level === 3 || /could not read the skin/.test(m)) errors.push(m.slice(0, 160)); });
  const list = (dir, prefix) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(wsz|zip)$/i.test(f)).sort().map((f) => prefix + f) : []);
  const files = [...list(SKINS, ''), ...list(path.join(SKINS, 'named'), 'named/'), ...list(path.join(SKINS, 'museum'), 'museum/')].filter((f) => !ONLY || f.toLowerCase().includes(ONLY.toLowerCase()));
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 3), mock.setPaused(false))'); await h.wait(1500);
  await js('WinifyPicker.open()'); await js('WinifySearch.open()'); await js('WinifyLyrics.open()'); await js('WinifyMilkdrop.toggle()');
  await h.wait(2500);
  const rowAt = (i) => js(`(() => { const b = document.querySelectorAll('.winify-picker .wp-row[data-index]')[${i}].getBoundingClientRect(); return { x: Math.round(b.left + 20), y: Math.round(b.top + b.height / 2) }; })()`);
  for (const [i, modifiers] of [[0, []], [1, ['meta']]]) {
    const p = await rowAt(i);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers });
    await h.wait(300);
  }
  for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
  await h.wait(500);
  console.log('Play Together box open: ' + (await js('WinifyPicker.state().prompt')));
  const cdp = win.webContents.debugger; cdp.attach('1.3');
  await cdp.sendCommand('DOM.enable'); await cdp.sendCommand('CSS.enable');
  const renderedFont = async (selector) => {
    const { root } = await cdp.sendCommand('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) return null;
    const { fonts } = await cdp.sendCommand('CSS.getPlatformFontsForNode', { nodeId });
    return fonts.map((f) => f.familyName);
  };
  const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what + ' took over ' + ms / 1000 + ' s')), ms))]);
  const area = () => js(`(() => { const rs = [...document.querySelectorAll('#webamp #main-window, #webamp #playlist-window, #webamp .gen-window')].map((e) => e.getBoundingClientRect());
    const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top)); return { x: Math.round(x), y: Math.round(y), width: Math.round(Math.max(...rs.map((r) => r.right)) - x), height: Math.round(Math.max(...rs.map((r) => r.bottom)) - y) }; })()`);
  const results = [];
  for (const f of files) {
    errors.length = 0;
    const r = { file: f, fails: [] };
    const fail = (kind, text) => r.fails.push({ kind, text });
    try {
      await js(`window.__skinError = null; window.__skinBefore = WinifyWebamp.getInstance().store.getState().display.skinImages;
        window.addEventListener('error', (e) => { window.__skinError = String(e.message); }, { once: true });
        window.addEventListener('unhandledrejection', (e) => { window.__skinError = String(e.reason); }, { once: true });
        WinifyWebamp.getInstance().setSkinFromUrl(location.origin + ${JSON.stringify('/test/skins/' + f.split('/').map(encodeURIComponent).join('/'))}); 0`);
      let loaded = false;
      for (let i = 0; i < 100 && !loaded; i++) {
        await h.wait(100);
        loaded = await js(`(() => { const d = WinifyWebamp.getInstance().store.getState().display; return d.skinImages !== window.__skinBefore && !d.loading; })()`);
      }
      if (!loaded) fail('does not load', 'not loaded in 10 s: ' + ((await js('window.__skinError')) || 'no error given'));
      let ready = false;
      for (let i = 0; i < 50 && !ready; i++) { await h.wait(100); ready = await js('WinifySkin.state().ready'); }
      if (loaded && !ready) fail('no frame', 'the panels never repainted');
      await h.wait(150);
      const err = await js('window.__skinError');
      if (err) fail('load error', err.slice(0, 120));
      for (const e of errors.slice(0, 2)) fail('load error', e);
      if (loaded) {
        const m = await within(js('(' + measure.toString() + ')(' + AA + ', ' + TITLE_AA + ')'), 15000, 'measuring');
        r.fails.push(...m.fails);
        Object.assign(r, { fallbacks: m.fallbacks, frame: m.frame, lyric: m.lyric, viz: m.viz, style: m.style, declaredFont: m.declaredFont });
        for (const s of ['.winify-lyrics .wl-note', '.winify-picker .wp-name']) {
          const fonts = await within(renderedFont(s), 5000, 'font');
          r.rendered = fonts;
          // A serif the skin itself names is its choice, not a fallback.
          const bad = (fonts || []).filter((n) => SERIF.test(n) && !m.declaredFont.toLowerCase().includes(n.toLowerCase().split(' ')[0]));
          if (bad.length) fail('serif fallback', s + ' rendered in ' + bad.join(', ') + ' (skin asks for "' + m.declaredFont + '")');
        }
      }
    } catch (e) { fail('check crashed', String(e.message).slice(0, 160)); }
    if (ONLY || r.fails.length || (r.fallbacks || []).length) {
      try { const a = await area(); r.shot = path.join(OUT, String(results.length).padStart(3, '0') + '.png'); fs.writeFileSync(r.shot, (await win.webContents.capturePage(a)).toPNG()); } catch (e) { /* the reason still counts */ }
    }
    if (r.lyric === 'drawn' || r.viz === 'drawn') {
      try {
        const b = await js(`(() => { const a = document.querySelector('#webamp #playlist-window .playlist-bottom').getBoundingClientRect(); return { x: Math.round(a.left), y: Math.round(a.top), width: Math.round(a.width), height: Math.round(a.height) }; })()`);
        r.labelShot = path.join(OUT, 'label-' + String(results.length).padStart(3, '0') + '.png');
        fs.writeFileSync(r.labelShot, (await win.webContents.capturePage(b)).toPNG());
      } catch (e) { delete r.labelShot; }
    }
    results.push(r);
    console.log((r.fails.length ? 'FAIL ' : 'ok   ') + f + '  frame:' + r.frame + ' LYRIC:' + r.lyric + ' VIZ:' + r.viz + (r.fails.length ? '  ' + r.fails.map((x) => x.kind + ': ' + x.text).join(' | ').slice(0, 260) : ''));
  }
  const failed = results.filter((r) => r.fails.length);
  const kinds = {}; for (const r of failed) for (const k of new Set(r.fails.map((x) => x.kind))) kinds[k] = (kinds[k] || 0) + 1;
  const tally = (key) => results.reduce((o, r) => { o[r[key]] = (o[r[key]] || 0) + 1; return o; }, {});
  const usedRule = {}; for (const r of results) for (const k of r.fallbacks || []) usedRule[k] = (usedRule[k] || 0) + 1;
  const summary = { checked: results.length, passed: results.length - failed.length, kinds, usedRule, frames: tally('frame'), lyric: tally('lyric'), viz: tally('viz') };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ summary, results }, null, 1));
  // The labels drawn on skins' own art, for looking at: a check cannot say they look right.
  const labels = results.filter((r) => r.labelShot && !r.file.startsWith('('));
  if (labels.length) {
    const shots = labels.map((r) => ({ name: r.file.replace(/^(museum|named)\//, ''), url: 'data:image/png;base64,' + fs.readFileSync(r.labelShot).toString('base64') }));
    const sheet = await js(`(async () => { const shots = ${JSON.stringify(shots)};
      const imgs = await Promise.all(shots.map(async (s) => { const i = new Image(); i.src = s.url; await i.decode(); return i; }));
      const W = 560, H = 96, cols = 3, c = document.createElement('canvas'); c.width = cols * (W + 16) + 16; c.height = Math.ceil(imgs.length / cols) * (H + 26) + 16;
      const g = c.getContext('2d'); g.fillStyle = '#e8e8ec'; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingEnabled = false;
      imgs.forEach((img, k) => { const x = (k % cols) * (W + 16) + 16, y = Math.floor(k / cols) * (H + 26) + 16;
        g.fillStyle = '#111'; g.font = '13px Helvetica, Arial'; g.fillText(shots[k].name.slice(0, 60), x, y + 11);
        const z = Math.min(W / img.width, H / img.height); g.drawImage(img, x, y + 16, img.width * z, img.height * z); });
      return c.toDataURL('image/png'); })()`);
    fs.writeFileSync(path.join(OUT, 'labels.png'), Buffer.from(sheet.split(',')[1], 'base64'));
  }
  // Two sheets, half size, the reasons above each: the failures, and the skins passing through a fallback rule.
  for (const [file, group, why] of [
    ['failures.png', failed, (r) => [...new Set(r.fails.map((x) => x.kind + ': ' + x.text))].slice(0, 3)],
    ['fallbacks.png', results.filter((r) => !r.fails.length && (r.fallbacks || []).length), (r) => ['rule used: ' + r.fallbacks.join(', ')]],
  ]) {
    if (!group.some((r) => r.shot)) continue;
    const shots = group.filter((r) => r.shot).map((r) => ({ name: r.file, why: why(r), url: 'data:image/png;base64,' + fs.readFileSync(r.shot).toString('base64') }));
    const sheet = await js(`(async () => { const shots = ${JSON.stringify(shots)};
      const imgs = await Promise.all(shots.map(async (s) => { const i = new Image(); i.src = s.url; await i.decode(); return i; }));
      const W = 900, H = 640, head = 96, pad = 20, cols = 3, c = document.createElement('canvas');
      c.width = cols * (W + pad) + pad; c.height = Math.ceil(imgs.length / cols) * (H + head + pad) + pad;
      const g = c.getContext('2d'); g.fillStyle = '#e8e8ec'; g.fillRect(0, 0, c.width, c.height);
      imgs.forEach((img, k) => { const x = (k % cols) * (W + pad) + pad, y = Math.floor(k / cols) * (H + head + pad) + pad;
        g.fillStyle = '#111'; g.font = 'bold 20px Helvetica, Arial'; g.fillText(shots[k].name.slice(0, 80), x, y + 20);
        g.fillStyle = '#a00'; g.font = '16px Helvetica, Arial'; shots[k].why.forEach((w, i) => g.fillText(w.slice(0, 110), x, y + 42 + i * 19));
        const z = Math.min(W / img.width, H / img.height); g.drawImage(img, x, y + head, img.width * z, img.height * z); });
      return c.toDataURL('image/png'); })()`);
    fs.writeFileSync(path.join(OUT, file), Buffer.from(sheet.split(',')[1], 'base64'));
  }
  console.log('\nRESULT ' + JSON.stringify(summary));
  app.exit(0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
