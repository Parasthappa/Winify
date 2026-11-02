// The default skin's title bars and logos, as Winify: WINIFY, WINIFY PLAYLIST and WINIFY EQUALIZER in the skin's own
// pixel letters (F is its E without the bottom bar; Y comes from PLAYLIST), and the Wi mark in place of the Winamp marks.
// Writes assets/brand/*.png, which webamp-brand.js swaps in when the bundle is served. Run again only if the art changes:
//
//   electron packaging/brand-art.js
const { app, BrowserWindow } = require('electron'); const fs = require('fs'), path = require('path');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'assets', 'brand');
const bundle = fs.readFileSync(path.join(ROOT, 'node_modules/webamp/built/webamp.bundle.min.mjs'), 'utf8');
const art = (sel) => { const at = bundle.indexOf('\\n#webamp ' + sel + ' {background-image: url(data:image/png;base64,'); if (at < 0) throw new Error('no art for ' + sel);
  const from = bundle.indexOf('data:image', at); return bundle.slice(from, bundle.indexOf(')', from)); };
const { ART } = require(path.join(ROOT, 'webamp-brand.js'));

// The Wi mark (assets/icon.png), drawn by hand for these sizes.
const MARK_SMALL = ['#..#..#.#', '#..#..#..', '#.#.#.#.#', '#.#.#.#.#', '.#...#..#'];   // at 9 px, a plain W and i
const MARK_BIG = ['..#....##..###.##.', '.##..#####.###.##.', '.##.######.###.#..', '.####..#######.#..', '###....######.##..', '.......######.##..', '.......######.###.', '.......#####.####.', '........####..###.'];

// Where things are in Webamp's art, in pixels. All titles have the same letters, on rows 5 to 10.
const ROWS = [5, 10];
const WORD = { W: [0, 7], I: [9, 10], N: [12, 17] };   // within WINAMP, 39 wide
const TITLES = [
  { on: '.selected #title-bar', off: '#title-bar', at: 118, icon: true },
  { on: '.shade.selected #title-bar', off: '.shade #title-bar', at: 20, icon: true },
  { on: '.selected .equalizer-top', off: '.equalizer-top', at: 95, rest: [138, 188] },
  { on: '.selected .playlist-top-title', off: '.playlist-top-title', at: 7, rest: [50, 94], bevel: true },
];
const F_FROM = { on: '.selected .equalizer-top', off: '.equalizer-top', x: [138, 142] };   // its E
const Y_FROM = { on: '.selected .playlist-top-title', off: '.playlist-top-title', x: [67, 72] };

// Runs in the page, where there is a canvas.
async function draw(sources, spec) {
  const { ROWS, WORD, TITLES, F_FROM, Y_FROM, MARK_SMALL, MARK_BIG } = spec;
  const load = async (u) => { const i = new Image(); i.src = u; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(i, 0, 0); return { c, g, w: i.width, h: i.height }; };
  const px = (a, x, y) => [...a.g.getImageData(x, y, 1, 1).data];
  const lum = (p) => (p[0] + p[1] + p[2]) / 3;
  // Copies a block of columns, on the title's rows only.
  const block = (a, from, to, w) => { const t = document.createElement('canvas'); t.width = w; t.height = a.h; t.getContext('2d').drawImage(a.c, from, 0, w, a.h, 0, 0, w, a.h); a.g.clearRect(to, ROWS[0], w, ROWS[1] - ROWS[0] + 1); a.g.drawImage(t, 0, ROWS[0], w, ROWS[1] - ROWS[0] + 1, to, ROWS[0], w, ROWS[1] - ROWS[0] + 1); };
  // The band behind the letters at a column: what is just above and below them, blended.
  const behind = (a, x, y) => { const p = px(a, x, ROWS[0] - 1), q = px(a, x, ROWS[1] + 1), v = (y - ROWS[0] + 1) / (ROWS[1] - ROWS[0] + 2); return [0, 1, 2].map((k) => p[k] + (q[k] - p[k]) * v); };
  // A letter, as how much ink each pixel has, to draw in any title's colours.
  const inkOf = (a, x0, x1) => { let top = 1; const cols = []; for (let x = x0; x <= x1; x++) { const col = []; for (let y = ROWS[0]; y <= ROWS[1]; y++) { const v = lum(px(a, x, y)) - lum(behind(a, x, y)); top = Math.max(top, v); col.push(v); } cols.push(col); } return cols.map((c) => c.map((v) => Math.max(0, v / top))); };
  const inkDraw = (a, ink, x, color) => ink.forEach((col, i) => col.forEach((v, j) => { if (v < 0.2) return; const y = ROWS[0] + j, b = px(a, x + i, y); a.g.fillStyle = `rgb(${[0, 1, 2].map((k) => Math.round(b[k] + (color[k] - b[k]) * v)).join(',')})`; a.g.fillRect(x + i, y, 1, 1); }));
  const clear = (a, x) => { for (let y = ROWS[0]; y <= ROWS[1]; y++) { const c = behind(a, x, y); a.g.fillStyle = `rgb(${c.map(Math.round).join(',')})`; a.g.fillRect(x, y, 1, 1); } };
  const brightest = (a, x0, x1) => { let best = [0, 0, 0, 0]; for (let x = x0; x <= x1; x++) for (let y = ROWS[0]; y <= ROWS[1]; y++) { const p = px(a, x, y); if (lum(p) > lum(best)) best = p; } return best; };
  const stamp = (a, x, y, rows, color) => rows.forEach((row, j) => [...row].forEach((c, i) => { if (c === '#') { a.g.fillStyle = color(j, rows.length); a.g.fillRect(x + i, y + j, 1, 1); } }));
  const putIcon = (a) => { a.g.drawImage(a.c, 16, 3, 1, 9, 6, 3, 9, 9); stamp(a, 6, 5, MARK_SMALL, () => '#e8c27a'); };

  const out = {};
  for (const state of ['on', 'off']) {
    const fSource = await load(sources[F_FROM[state]]), ySource = await load(sources[Y_FROM[state]]);
    const F = inkOf(fSource, F_FROM.x[0], F_FROM.x[1]); for (let i = 2; i < F.length; i++) for (const j of [3, 4, 5]) F[i][j] = 0;   // the E without its bottom bar
    const Y = inkOf(ySource, Y_FROM.x[0], Y_FROM.x[1]); for (const i of [0, 5]) for (const j of [3, 4, 5]) Y[i][j] = 0;              // not the A beside it
    for (const t of TITLES) {
      const a = await load(sources[t[state]]), ink = brightest(a, t.at, t.at + 38);
      const letters = { W: inkOf(a, t.at + WORD.W[0], t.at + WORD.W[1]), I: inkOf(a, t.at + WORD.I[0], t.at + WORD.I[1]), N: inkOf(a, t.at + WORD.N[0], t.at + WORD.N[1]) };
      // WINIFY is 5 narrower than WINAMP: the title stays centred. EQUALIZER moves over with it; PLAYLIST cannot, its band has bevelled ends.
      const moved = t.rest && !t.bevel ? 2 : 0, shift = t.bevel ? 5 : t.rest ? 3 : 2;
      if (moved) { block(a, t.rest[0], t.rest[0] - moved, t.rest[1] - t.rest[0] + 1); for (let x = t.rest[1] - moved + 1; x <= t.rest[1]; x++) clear(a, x); }
      for (let x = t.at; x <= (t.rest ? t.rest[0] - moved - 1 : t.at + 38); x++) clear(a, x);
      const at = t.at + shift;
      for (const [k, x] of [['W', 0], ['I', 9], ['N', 12], ['I', 19]]) inkDraw(a, letters[k], at + x, ink);
      inkDraw(a, F, at + 22, ink); inkDraw(a, Y, at + 28, ink);
      if (t.icon) putIcon(a);
      out[t[state]] = a.c.toDataURL();
    }
  }
  // The pressed menu button.
  for (const sel of ['.selected #title-bar #option.clicked', '.selected #title-bar #option:active', '.selected #title-bar #option.selected']) { const a = await load(sources[sel]);
    const light = lum(px(a, 0, 0)) > 110; a.g.drawImage(a.c, 0, 0, 1, 9, 0, 0, 9, 9); stamp(a, 0, 2, MARK_SMALL, () => (light ? '#1a1a2a' : '#e8c27a')); out[sel] = a.c.toDataURL(); }
  // The logo button: the old mark, covered by the plain background beside it, and the Wi mark.
  const m = await load(sources['#main-window']);
  for (let y = 87; y < 108; y++) { const p = px(m, 247, y), q = px(m, 269, y); for (let x = 248; x < 269; x++) { const v = (x - 247) / 22; m.g.fillStyle = `rgb(${[0, 1, 2].map((k) => Math.round(p[k] + (q[k] - p[k]) * v)).join(',')})`; m.g.fillRect(x, y, 1, 1); } }
  stamp(m, 250, 94, MARK_BIG, (j, h) => (j < h / 2 ? '#f2a51c' : '#e0701a'));
  out['#main-window'] = m.c.toDataURL();
  return out;
}
app.whenReady().then(async () => {
  const sources = {}; for (const sel of Object.keys(ART)) sources[sel] = art(sel);
  const win = new BrowserWindow({ show: false }); await win.loadURL('about:blank');
  const out = await win.webContents.executeJavaScript('(' + draw.toString() + ')(' + JSON.stringify(sources) + ',' + JSON.stringify({ ROWS, WORD, TITLES, F_FROM, Y_FROM, MARK_SMALL, MARK_BIG }) + ')', true);
  fs.mkdirSync(OUT, { recursive: true });
  for (const [sel, url] of Object.entries(out)) fs.writeFileSync(path.join(OUT, ART[sel]), Buffer.from(url.split(',')[1], 'base64'));
  console.log('written', Object.keys(out).length); app.exit(0);
}).catch((e) => { console.log('ERROR', e.stack || e); app.exit(3); });
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 30000);
