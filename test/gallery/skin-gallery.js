// Skin gallery: every skin in test/skins/ (.wsz, kept out of git) loaded into Winify's player
// against the fake Spotify (no Spotify requests), with the side panels open (Lyrics, Jump to track,
// Playlists, Milkdrop, the Play Together box), photographed and put on one contact sheet with each
// skin's name and where its panel frames come from.
//
//   npm run gallery            -> test/.output/skin-gallery/contact-sheet.png (+ one PNG per skin)
const { app } = require('electron'); const h = require('../lib/harness');
const fs = require('fs'), path = require('path');
const SKINS = path.join(__dirname, '..', 'skins');
const OUT = path.join(__dirname, '..', '.output', 'skin-gallery');
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 600000);

h.open().then(async ({ win, js }) => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const files = fs.existsSync(SKINS) ? fs.readdirSync(SKINS).filter((f) => /\.(wsz|zip)$/i.test(f)).sort() : [];
  if (!files.length) { console.log('No skins in test/skins/'); app.exit(1); return; }
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 3), mock.setPaused(false))'); await h.wait(1500);
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'SET_VOLUME', volume: 70 })`);
  // Every window on screen.
  const area = () => js(`(() => { const rs = [...document.querySelectorAll('#webamp #main-window, #webamp #playlist-window, #webamp .gen-window')].map((e) => e.getBoundingClientRect());
    const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top)); return { x: Math.round(x), y: Math.round(y), width: Math.round(Math.max(...rs.map((r) => r.right)) - x), height: Math.round(Math.max(...rs.map((r) => r.bottom)) - y) }; })()`);
  // The panels, and the Play Together box asked for from two chosen playlists.
  await js('WinifyPicker.open()'); await js('WinifySearch.open()'); await js('WinifyLyrics.open()'); await js('WinifyMilkdrop.toggle()');
  await h.wait(2500);
  const rowAt = (i) => js(`(() => { const b = document.querySelectorAll('.winify-picker .wp-row[data-index]')[${i}].getBoundingClientRect(); return { x: Math.round(b.left + 20), y: Math.round(b.top + b.height / 2) }; })()`);
  for (const [i, modifiers] of [[0, []], [1, ['meta']]]) {
    const p = await rowAt(i);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers });
    await h.wait(300);
  }
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); win.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  await h.wait(500);
  console.log('Play Together box open: ' + (await js('WinifyPicker.state().prompt')));
  const shots = [];
  for (const f of ['(default skin)'].concat(files)) {
    let note = '';
    if (f !== '(default skin)') {
      await js(`window.__skinError = null; window.__skinBefore = WinifyWebamp.getInstance().store.getState().display.skinImages;
        window.addEventListener('error', (e) => { window.__skinError = String(e.message); }, { once: true });
        WinifyWebamp.getInstance().setSkinFromUrl(location.origin + ${JSON.stringify('/test/skins/' + encodeURIComponent(f))})`);   // a full address: the test page's fetch needs one
      // Loaded when the skin's own images have replaced the previous ones (and Webamp is done loading).
      let loaded = false;
      for (let i = 0; i < 150 && !loaded; i++) {
        await h.wait(100);
        loaded = await js(`(() => { const d = WinifyWebamp.getInstance().store.getState().display; return d.skinImages !== window.__skinBefore && !d.loading && !!d.skinImages.MAIN_WINDOW_BACKGROUND; })()`);
      }
      if (!loaded) note = 'did not load';
      await h.wait(400);
      const err = await js('window.__skinError');
      if (err) note = (note ? note + '; ' : '') + 'error: ' + err;
    }
    await h.wait(800);   // the panel frames are drawn from the skin's images
    const look = await js(`(() => { const s = WinifySkin.state(); const misc = !!document.querySelector('#winify-lyric-button').textContent; const viz = !!(document.getElementById('winify-viz-button') || {}).textContent; return { frame: s.frame, lyric: misc, viz, font: s.style.font }; })()`);
    const r = await area();
    const img = await win.webContents.capturePage(r);
    const name = f.replace(/\.(wsz|zip)$/i, '');
    const file = path.join(OUT, String(shots.length).padStart(2, '0') + '-' + name.replace(/[^\w.-]+/g, '_') + '.png');
    fs.writeFileSync(file, img.toPNG());
    shots.push({ name: name + '  [frame: ' + look.frame + ', LYRIC: ' + (look.lyric ? 'drawn' : 'own') + ', VIZ: ' + (look.viz ? 'drawn' : 'own') + ']', file, note });
    console.log((note ? 'PROBLEM ' : 'ok   ') + name + '  frame: ' + look.frame + '  LYRIC: ' + (look.lyric ? 'drawn' : 'own') + '  VIZ: ' + (look.viz ? 'drawn' : 'own') + (note ? '  (' + note + ')' : ''));
  }
  // The contact sheet: 3 across, each photo at 2x with its name above it.
  const sheet = await js(`(async () => {
    const shots = ${JSON.stringify(shots.map((s) => ({ name: s.name, url: 'data:image/png;base64,' + fs.readFileSync(s.file).toString('base64') })))};
    const imgs = await Promise.all(shots.map(async (s) => { const i = new Image(); i.src = s.url; await i.decode(); return i; }));
    const w = Math.max(...imgs.map((i) => i.width)), hgt = Math.max(...imgs.map((i) => i.height));
    const scale = 2 * ${'window.devicePixelRatio'} / ${'window.devicePixelRatio'};
    const cols = 3, pad = 24, label = 40, cw = w + pad * 2, ch = hgt + label + pad;
    const c = document.createElement('canvas'); c.width = cols * cw; c.height = Math.ceil(imgs.length / cols) * ch + pad;
    const g = c.getContext('2d'); g.fillStyle = '#e8e8ec'; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingEnabled = false;
    imgs.forEach((img, k) => { const x = (k % cols) * cw + pad, y = Math.floor(k / cols) * ch + pad;
      g.fillStyle = '#111'; g.font = 'bold 22px -apple-system, Helvetica, Arial'; g.fillText((k + 1) + '. ' + shots[k].name, x, y + 24);
      g.drawImage(img, x, y + label - 6); });
    // A close-up sheet: each main window (the top 116 of its 275 px width) at 4x, 2 across.
    const k = imgs[0].width / 275, mw = imgs[0].width, mh = Math.round(116 * k), z = 2;
    const c2 = document.createElement('canvas'); const cw2 = mw * z + pad * 2, ch2 = mh * z + label + pad;
    c2.width = 2 * cw2; c2.height = Math.ceil(imgs.length / 2) * ch2 + pad;
    const g2 = c2.getContext('2d'); g2.fillStyle = '#e8e8ec'; g2.fillRect(0, 0, c2.width, c2.height); g2.imageSmoothingEnabled = false;
    imgs.forEach((img, i) => { const x = (i % 2) * cw2 + pad, y = Math.floor(i / 2) * ch2 + pad;
      g2.fillStyle = '#111'; g2.font = 'bold 26px -apple-system, Helvetica, Arial'; g2.fillText((i + 1) + '. ' + shots[i].name, x, y + 28);
      g2.drawImage(img, 0, 0, mw, mh, x, y + label - 6, mw * z, mh * z); });
    return [c.toDataURL('image/png'), c2.toDataURL('image/png')]; })()`);
  fs.writeFileSync(path.join(OUT, 'contact-sheet.png'), Buffer.from(sheet[0].split(',')[1], 'base64'));
  fs.writeFileSync(path.join(OUT, 'main-windows.png'), Buffer.from(sheet[1].split(',')[1], 'base64'));
  console.log('\n' + shots.length + ' photos; contact sheet: ' + path.join(OUT, 'contact-sheet.png'));
  app.exit(0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
