/* The side panels follow the loaded skin.
 *
 * Colours and font: every panel reads panelStyle(), the skin's playlist colours
 * (pledit.txt) with a contrast check, and the skin's font with a sans-serif
 * fallback. Text the skin's colours cannot make readable is black or white, so
 * the panels keep the skin's background; one of them always reads.
 *
 * Frames: a skin with generic-window artwork (GEN.BMP) needs nothing here:
 * Webamp's own stylesheet draws Milkdrop and the panels from it. Without it,
 * Webamp falls back to the default skin's frame, so one is built from the
 * skin's playlist window (PLEDIT.BMP), with titles in its lettering (TEXT.BMP).
 * A skin with neither keeps the default frame, which is what its playlist
 * window has too.
 *
 * Lettering: the panels' hint bars and dialog buttons use the skin's TEXT.BMP
 * glyphs, redrawn in its playlist colours. TEXT.BMP's own colours and solid
 * background belong to the main window and can be unreadable on a panel. Where
 * letters cannot be told from the background, the default skin's letters are used.
 */

const log = (...args) => console.log('[winify/skin]', ...args);

// ---- Colours ----------------------------------------------------------------

const MIN_CONTRAST = 4.5;     // WCAG AA for small text; panel text is 9-10 px
const MIN_TITLE_CONTRAST = 3;
const MIN_SELECTION_CONTRAST = 1.3;
const BLACK = '#000000', WHITE = '#FFFFFF';   // on any colour, one of these reaches 4.5:1
const DEFAULT_COLORS = { normal: '#00FF00', current: '#FFFFFF', normalbg: '#000000', selectedbg: '#0000C6' };

// [r, g, b] of any CSS colour, or null.
function rgb(color) {
  const g = document.createElement('canvas').getContext('2d');
  g.fillStyle = '#010203';
  g.fillStyle = color;
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(g.fillStyle);
  return hex ? [1, 2, 3].map((i) => parseInt(hex[i], 16)) : null;
}

function luminance([r, g, b]) {
  const part = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * part(r) + 0.7152 * part(g) + 0.0722 * part(b);
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// WCAG contrast of two CSS colours (1 to 21).
export function contrast(a, b) {
  const [x, y] = [rgb(a), rgb(b)];
  return x && y ? ratio(x, y) : 1;
}

// The first colour readable on `bg`, or null.
function firstReadable(bg, ...colors) {
  for (const c of colors) if (c && contrast(c, bg) >= MIN_CONTRAST) return c;
  return null;
}

// Never the browser's default serif when the skin's font is not installed.
export function fontStack(font) {
  const name = String(font || '').replace(/["';{}]/g, '').trim();
  return (name ? '"' + name + '", ' : '') + 'Helvetica, Arial, sans-serif';
}

let lastSource;
let lastStyle = null;

export function panelStyle(webamp) {
  const s = webamp.store.getState().display.skinPlaylistStyle || {};
  if (s === lastSource && lastStyle) return lastStyle;
  const c = { normal: s.normal || DEFAULT_COLORS.normal, current: s.current || DEFAULT_COLORS.current,
    normalbg: s.normalbg || DEFAULT_COLORS.normalbg, selectedbg: s.selectedbg || DEFAULT_COLORS.selectedbg };
  const fallbacks = [];
  // The skin's colours where they read, else black or white.
  let normal = firstReadable(c.normalbg, c.normal, c.current);
  if (!normal) { normal = firstReadable(c.normalbg, BLACK, WHITE); fallbacks.push('black or white text'); }
  // A selection that hardly differs from the list cannot be seen: the list's
  // text and background swapped, which reads as well as the list does.
  if (contrast(c.selectedbg, c.normalbg) < MIN_SELECTION_CONTRAST) { c.selectedbg = normal; fallbacks.push('selection swapped'); }
  let onSelected = firstReadable(c.selectedbg, normal, c.current, c.normalbg);
  if (!onSelected) { onSelected = firstReadable(c.selectedbg, BLACK, WHITE); fallbacks.push('black or white on the selection'); }
  lastSource = s;
  lastStyle = {
    normal,
    current: firstReadable(c.normalbg, c.current) || normal,
    normalbg: c.normalbg,
    selectedbg: c.selectedbg,
    onSelected,
    currentOnSelected: firstReadable(c.selectedbg, c.current) || onSelected,
    font: fontStack(s.font),
    fallbacks,
  };
  return lastStyle;
}

// Panels repaint through these when the skin changes.
const listeners = new Set();
export function onPanelStyle(listener) { listeners.add(listener); }

// A list row's colours: readable as selected, current or plain.
export function paintRow(row, st, selected, current) {
  row.style.background = selected ? st.selectedbg : '';
  row.style.color = selected ? (current ? st.currentOnSelected : st.onSelected) : (current ? st.current : st.normal);
}

// ---- Bitmaps ----------------------------------------------------------------

const loadImage = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = url;
});

const blank = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

// ---- Frames from the playlist window's artwork --------------------------------

const FRAME_SPRITES = [
  'PLAYLIST_TOP_TILE', 'PLAYLIST_TOP_LEFT_CORNER', 'PLAYLIST_TOP_RIGHT_CORNER',
  'PLAYLIST_TOP_TILE_SELECTED', 'PLAYLIST_TOP_LEFT_SELECTED', 'PLAYLIST_TOP_RIGHT_CORNER_SELECTED',
  'PLAYLIST_LEFT_TILE', 'PLAYLIST_RIGHT_TILE', 'PLAYLIST_BOTTOM_TILE',
  'PLAYLIST_BOTTOM_LEFT_CORNER', 'PLAYLIST_BOTTOM_RIGHT_CORNER',
];
const LEFT = 11, RIGHT = 8, BOTTOM = 14, GRIP = 20, BOTTOM_PIECE = 125;     // the generic window's sizes
const ROOT = '#webamp .gen-window.gen-window';                              // outranks Webamp's own rules

// The playlist's bottom edge is 38 px tall and holds its buttons; the panels'
// is 14 px. So its bottom rows are used: the tile, the left corner's outer
// edge (clear of ADD), and the right corner's outer edge (the resize grip).
function bottomPiece(tile, corner, side) {
  const c = blank(BOTTOM_PIECE, BOTTOM);
  const g = c.getContext('2d');
  for (let x = 0; x < BOTTOM_PIECE; x += tile.width) g.drawImage(tile, x, BOTTOM - tile.height);
  if (side === 'left') g.drawImage(corner, 0, corner.height - BOTTOM, LEFT, BOTTOM, 0, 0, LEFT, BOTTOM);
  else g.drawImage(corner, corner.width - GRIP, corner.height - BOTTOM, GRIP, BOTTOM, BOTTOM_PIECE - GRIP, 0, GRIP, BOTTOM);
  return c.toDataURL('image/png');
}

function crop(img, x, y, w, h) {
  const c = blank(w, h);
  c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
  return c.toDataURL('image/png');
}

async function frameCss(images) {
  const [tile, topLeft, topRight, tileOn, topLeftOn, topRightOn, left, right, bottom, cornerLeft, cornerRight] =
    await Promise.all(FRAME_SPRITES.map((name) => loadImage(images[name])));
  const url = (u) => 'url("' + u + '")';
  const fill = ['.gen-top', '.gen-top-left-fill', '.gen-top-right-fill', '.gen-top-left-end', '.gen-top-right-end'];
  const rules = [];
  const rule = (selectors, body) => rules.push(selectors.map((s) => ROOT + ' ' + s).join(', ') + ' { ' + body + ' }');
  const ruleOn = (selectors, body) => rules.push(selectors.map((s) => ROOT + '.selected ' + s).join(', ') + ' { ' + body + ' }');
  rule(fill, `background-image: ${url(tile.src)};`);
  ruleOn(fill, `background-image: ${url(tileOn.src)};`);
  rule(['.gen-top-left'], `background-image: ${url(topLeft.src)};`);
  ruleOn(['.gen-top-left'], `background-image: ${url(topLeftOn.src)};`);
  rule(['.gen-top-right'], `background-image: ${url(topRight.src)};`);
  ruleOn(['.gen-top-right'], `background-image: ${url(topRightOn.src)};`);
  // The close box is part of that corner's artwork.
  rule(['.gen-close', '.gen-close.winamp-active'], 'background-image: none !important;');
  const leftEdge = url(crop(left, 0, 0, LEFT, left.height));
  const rightEdge = url(crop(right, right.width - RIGHT, 0, RIGHT, right.height));
  rule(['.gen-middle-left', '.gen-middle-left-bottom'], `background-image: ${leftEdge};`);
  rule(['.gen-middle-right', '.gen-middle-right-bottom'], `background-image: ${rightEdge};`);
  rule(['.gen-bottom'], `background-image: ${url(crop(bottom, 0, bottom.height - BOTTOM, bottom.width, BOTTOM))};`);
  rule(['.gen-bottom-left'], `background-image: ${url(bottomPiece(bottom, cornerLeft, 'left'))};`);
  rule(['.gen-bottom-right'], `background-image: ${url(bottomPiece(bottom, cornerRight, 'right'))};`);
  return rules;
}

// Where a title bar's letters sit: the colour that reads on most of those
// pixels and on how many, and how much of them is one colour. Letters are lost
// on busy artwork even where each pixel contrasts.
function bestOn(img, colors) {
  const g = blank(img.width, img.height).getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, TITLE_ROWS.top, img.width, TITLE_ROWS.bottom - TITLE_ROWS.top).data;
  const counts = new Map();
  for (let i = 0; i < d.length; i += 4) { const k = (d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4); counts.set(k, (counts.get(k) || 0) + 1); }
  const flat = Math.max(...counts.values()) / (d.length / 4);
  let best = { color: colors[0], share: -1, flat };
  for (const color of colors) {
    const c = rgb(color);
    let good = 0;
    for (let i = 0; i < d.length; i += 4) if (ratio(c, [d[i], d[i + 1], d[i + 2]]) >= MIN_TITLE_CONTRAST) good++;
    const share = good / (d.length / 4);
    if (share > best.share) best = { color, share, flat };
  }
  return best;
}

// ---- Lettering in the playlist's colours ------------------------------------

// A glyph as clear pixels and pixels of `color`: whatever differs from the
// bitmap's own background by more than that background varies is ink.
function tint(img, ground, color) {
  return tintedCanvas(img, ground, color).toDataURL('image/png');
}

function tintedCanvas(img, { background, spread }, color) {
  const c = blank(img.width, img.height);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  const d = data.data;
  const [r, gr, b] = rgb(color);
  for (let i = 0; i < d.length; i += 4) {
    const far = Math.abs(d[i] - background[0]) + Math.abs(d[i + 1] - background[1]) + Math.abs(d[i + 2] - background[2]);
    d[i] = r; d[i + 1] = gr; d[i + 2] = b; d[i + 3] = far > Math.max(48, spread * 1.5) && d[i + 3] ? 255 : 0;
  }
  g.putImageData(data, 0, 0);
  return c;
}

// The background of the skin's TEXT.BMP: how much it varies, and its colour.
function glyphGround(space) {
  const g = blank(space.width, space.height).getContext('2d');
  g.drawImage(space, 0, 0);
  const d = g.getImageData(0, 0, space.width, space.height).data;
  const background = [0, 1, 2].map((k) => { let sum = 0; for (let i = k; i < d.length; i += 4) sum += d[i]; return sum / (d.length / 4); });
  let spread = 0;   // a textured TEXT.BMP has no one background colour
  for (let i = 0; i < d.length; i += 4) spread = Math.max(spread, Math.abs(d[i] - background[0]) + Math.abs(d[i + 1] - background[1]) + Math.abs(d[i + 2] - background[2]));
  return { background, spread };
}

// Titles in the skin's TEXT.BMP letters, where it has no GEN.BMP lettering,
// clear of TEXT.BMP's background. In the colour that reads best on the title
// bar; where none reads on enough of it, on a plate in the panel's colours.
const TITLE_CANDIDATES = (st) => [st.current, st.normal, '#000000', '#ffffff'];
const TITLE_ROWS = { top: 2, bottom: 12 };
const TITLE_READS_ON = 0.95, TITLE_FLAT = 0.85;

async function titleCss(glyphs, images, st) {
  if (!glyphs) return [];
  const rules = [];
  const state = async (tileName, prefix) => {
    const best = bestOn(await loadImage(images[tileName]), TITLE_CANDIDATES(st));
    const plated = best.share < TITLE_READS_ON || best.flat < TITLE_FLAT;
    const color = plated ? st.normal : best.color;
    if (plated) {
      rules.push(`${prefix} .gen-top-title { background: ${st.normalbg}; height: 9px; align-self: flex-start; margin-top: 2px; line-height: 9px; }`);
      if (!artFallbacks.includes('title plate')) artFallbacks.push('title plate');
    }
    for (let code = 97; code <= 122; code++) {
      const glyph = glyphs.images[code];
      if (!glyph) continue;
      rules.push(`${prefix} .gen-text-${String.fromCharCode(code)} { background-image: url("${tint(glyph, glyphs.ground, color)}"); width: 5px; height: 6px; }`);
    }
  };
  await state('PLAYLIST_TOP_TILE', ROOT);
  await state('PLAYLIST_TOP_TILE_SELECTED', ROOT + '.selected');
  return rules;
}

// How much of a glyph is ink.
function inkShare(img, ground) {
  const g = blank(img.width, img.height).getContext('2d');
  g.drawImage(tintedCanvas(img, ground, '#000000'), 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  let ink = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]) ink++;
  return ink / (img.width * img.height);
}

// The default skin's letters: in Webamp's own stylesheet, ahead of any skin's.
let defaultGlyphs = null;
function defaultGlyphUrls() {
  if (defaultGlyphs) return defaultGlyphs;
  defaultGlyphs = {};
  for (const sheet of document.styleSheets) {
    if (sheet.ownerNode && sheet.ownerNode.id === 'winify-skin-panels') continue;
    let rules = [];
    try { rules = sheet.cssRules; } catch (e) { continue; }
    for (const rule of rules) {
      const code = /\.character-(\d+)/.exec(rule.selectorText || '');
      const url = code && /url\("?([^")]+)"?\)/.exec(rule.style.backgroundImage || '');
      if (url && !defaultGlyphs[code[1]]) defaultGlyphs[code[1]] = url[1];
    }
  }
  return defaultGlyphs;
}

const glyphUrls = (images) => {
  const urls = {};
  for (const n of Object.keys(images)) { const m = /^CHARACTER_(\d+)$/.exec(n); if (m) urls[m[1]] = images[n]; }
  return urls;
};

async function loadGlyphs(urls) {
  if (!urls[32]) return null;
  const ground = glyphGround(await loadImage(urls[32]));
  const codes = Object.keys(urls);
  const loaded = await Promise.all(codes.map((code) => loadImage(urls[code])));
  const glyphs = {};
  codes.forEach((code, i) => { glyphs[code] = loaded[i]; });
  return { ground, images: glyphs };
}

// Letters that can be told from their background: most a-z have some ink and
// are not solid. A TEXT.BMP drawn as a picture fails this.
const LETTER_INK = { min: 0.08, max: 0.85 };
function usable(glyphs) {
  if (!glyphs) return false;
  let good = 0, all = 0;
  for (let code = 97; code <= 122; code++) {
    if (!glyphs.images[code]) continue;
    all++;
    const share = inkShare(glyphs.images[code], glyphs.ground);
    if (share >= LETTER_INK.min && share <= LETTER_INK.max) good++;
  }
  return all > 0 && good / all >= 0.8;
}

async function panelGlyphs(images) {
  const own = await loadGlyphs(glyphUrls(images));
  if (usable(own)) return own;
  artFallbacks.push('default letters');
  return loadGlyphs(defaultGlyphUrls());
}

function letteringCss(glyphs, st) {
  if (!glyphs) return [];
  const rules = [];
  for (const code of Object.keys(glyphs.images)) {
    const glyph = glyphs.images[code];
    rules.push(`#webamp .winify-frame .character-${code} { background-image: url("${tint(glyph, glyphs.ground, st.normal)}"); }`);
    rules.push(`#webamp .winify-frame .wq-btn[aria-pressed="true"] .character-${code} { background-image: url("${tint(glyph, glyphs.ground, st.onSelected)}"); }`);
  }
  return rules;
}

// ---- A button's label on the skin's own artwork -----------------------------

// LYRIC and VIZ on a skin's MISC and LIST OPTS: the label is cleared with the
// button's face colour and redrawn in the colour of its own lettering. Five
// TEXT.BMP letters are 25 px wide and the face 17, so the small letters are
// used for both. Only for a flat button with a clear label: on anything drawn
// more freely this would look wrong, so null keeps the skin's own label.
const FACE = { x: 2, y: 2, w: 17, h: 13 };
const FLAT_ENOUGH = 0.55;

export function labelOnArt(g, w, h, letters, left, top) {
  const data = g.getImageData(0, 0, w, h);
  const d = data.data;
  const counts = new Map();
  for (let y = FACE.y; y < FACE.y + FACE.h; y++) {
    for (let x = FACE.x; x < FACE.x + FACE.w; x++) {
      const i = (y * w + x) * 4;
      const key = d[i] + ',' + d[i + 1] + ',' + d[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const face = sorted[0][0].split(',').map(Number);
  const close = (key) => key.split(',').map(Number).every((v, i) => Math.abs(v - face[i]) <= 10);
  const covered = sorted.filter(([key]) => close(key)).reduce((n, [, count]) => n + count, 0);
  if (covered / (FACE.w * FACE.h) < FLAT_ENOUGH) return null;
  // Lettering running out of the sides of the face would be left half cleared:
  // beside a clean face, each column is one colour from top to bottom.
  for (const x of [0, 1, FACE.x + FACE.w, FACE.x + FACE.w + 1, FACE.x + FACE.w + 2]) {
    for (let y = FACE.y + 1; y < FACE.y + FACE.h; y++) {
      const i = (y * w + x) * 4, j = ((FACE.y) * w + x) * 4;
      if (Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]) > 30) return null;
    }
  }
  // Nor running out of the bottom.
  for (let x = FACE.x; x < FACE.x + FACE.w; x++) {
    const i = ((FACE.y + FACE.h) * w + x) * 4, j = ((FACE.y + FACE.h) * w + FACE.x + 1) * 4;
    if (Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]) > 30) return null;
  }
  let ink = null, best = 3;
  for (const [key] of sorted) {
    const c = key.split(',').map(Number);
    const r = ratio(c, face);
    if (r >= best) { best = r; ink = c; }
  }
  if (!ink) return null;
  const draw = (shift) => {
    const c = blank(w, h);
    const out = c.getContext('2d');
    out.putImageData(data, 0, 0);
    out.fillStyle = `rgb(${face.join(',')})`;
    out.fillRect(FACE.x, FACE.y, FACE.w, FACE.h);
    out.fillStyle = `rgb(${ink.join(',')})`;
    letters.forEach((row, dy) => [...row].forEach((p, dx) => { if (p === '#') out.fillRect(left + dx, top + shift + dy, 1, 1); }));
    return c.toDataURL('image/png');
  };
  return { normal: draw(0), pressed: draw(1) };
}

// ---- Keeping up with the skin -----------------------------------------------

let webamp = null;
let unsubscribe = null;
let style = null;
let paintedImages;
let paintedStyle;
let generation = 0;

// Which frame the loaded skin gets, for the tests and the gallery.
let frameSource = 'gen';
let ready = null;       // the images last painted from
let artFallbacks = [];  // the fallback rules this skin's artwork needed

async function paint(images, st) {
  const mine = ++generation;
  artFallbacks = [];
  const hasGen = !!images.GEN_TOP_LEFT;
  const canBuild = FRAME_SPRITES.every((n) => images[n]);
  const rules = [];
  try {
    const glyphs = await panelGlyphs(images);
    if (!hasGen && canBuild) rules.push(...await frameCss(images), ...await titleCss(glyphs, images, st));
    rules.push(...letteringCss(glyphs, st));
  } catch (e) {
    log('could not read the skin\'s artwork:', e.message);
  }
  if (mine !== generation || !style) return;
  style.textContent = rules.join('\n');
  ready = images;
  frameSource = hasGen ? 'gen' : canBuild ? 'pledit' : 'default';
  log('panel frames from', frameSource);
}

function check() {
  const display = webamp.store.getState().display;
  if (display.loading || !display.skinImages) return;
  if (display.skinImages === paintedImages && display.skinPlaylistStyle === paintedStyle) return;
  paintedImages = display.skinImages;
  paintedStyle = display.skinPlaylistStyle;
  paint(paintedImages, panelStyle(webamp));
  for (const listener of listeners) listener();
}

export function attach(instance) {
  webamp = instance;
  if (!style) {
    style = document.createElement('style');
    style.id = 'winify-skin-panels';
    document.head.appendChild(style);
  }
  paintedImages = undefined;
  check();
  unsubscribe = webamp.store.subscribe(check);
}

export function detach() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  webamp = null;
  generation++;
}

window.WinifySkin = { state: () => ({ frame: frameSource, style: webamp ? panelStyle(webamp) : null, ready: !!webamp && ready === webamp.store.getState().display.skinImages, fallbacks: artFallbacks.slice() }), contrast };
