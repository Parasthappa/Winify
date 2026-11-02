/* The side panels follow the loaded skin.
 *
 * Colours and font: every panel reads panelStyle(), the skin's playlist colours
 * (pledit.txt) with a contrast check, so text stays readable on any skin, and
 * the skin's font with a sans-serif fallback.
 *
 * Frames: a skin with generic-window artwork (GEN.BMP) needs nothing here:
 * Webamp's own stylesheet draws Milkdrop and the panels from it. Without it,
 * Webamp falls back to the default skin's frame, so one is built from the
 * skin's playlist window (PLEDIT.BMP), with titles in its lettering (TEXT.BMP).
 *
 * Lettering: the panels' hint bars and dialog buttons use the skin's TEXT.BMP
 * glyphs, redrawn in its playlist colours. TEXT.BMP's own colours and solid
 * background belong to the main window and can be unreadable on a panel.
 */

const log = (...args) => console.log('[winify/skin]', ...args);

// ---- Colours ----------------------------------------------------------------

const MIN_CONTRAST = 3.5;

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

// The first colour readable on `bg`, else black or white, whichever is clearer.
export function readable(bg, ...colors) {
  for (const c of colors) if (c && contrast(c, bg) >= MIN_CONTRAST) return c;
  return contrast('#000000', bg) > contrast('#ffffff', bg) ? '#000000' : '#ffffff';
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
  const normalbg = s.normalbg || '#000000';
  const selectedbg = s.selectedbg || '#0000C6';
  const normal = readable(normalbg, s.normal || '#00FF00', s.current);
  lastSource = s;
  lastStyle = {
    normal,
    current: readable(normalbg, s.current || '#FFFFFF', normal),
    normalbg,
    selectedbg,
    onSelected: readable(selectedbg, normal, s.current),
    currentOnSelected: readable(selectedbg, s.current, normal),
    font: fontStack(s.font),
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

// A bitmap's average colour, as #rrggbb.
function average(img) {
  const g = blank(img.width, img.height).getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  const part = (k) => { let sum = 0; for (let i = k; i < d.length; i += 4) sum += d[i]; return Math.round(sum / (d.length / 4)); };
  return '#' + [0, 1, 2].map((k) => part(k).toString(16).padStart(2, '0')).join('');
}

// ---- Lettering in the playlist's colours ------------------------------------

// A glyph as clear pixels and pixels of `color`: whatever differs from the
// bitmap's own background by more than that background varies is ink.
function tint(img, { background, spread }, color) {
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
  return c.toDataURL('image/png');
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
// clear of TEXT.BMP's background and readable on the title bar.
async function titleCss(images, st) {
  if (!images.CHARACTER_32) return [];
  const ground = glyphGround(await loadImage(images.CHARACTER_32));
  const [tile, tileOn] = await Promise.all([images.PLAYLIST_TOP_TILE, images.PLAYLIST_TOP_TILE_SELECTED].map(loadImage));
  const color = readable(average(tile), st.current, st.normal);
  const colorOn = readable(average(tileOn), st.current, st.normal);
  const rules = [];
  for (let code = 97; code <= 122; code++) {
    if (!images['CHARACTER_' + code]) continue;
    const glyph = await loadImage(images['CHARACTER_' + code]);
    const letter = String.fromCharCode(code);
    rules.push(`${ROOT} .gen-text-${letter} { background-image: url("${tint(glyph, ground, color)}"); width: 5px; height: 6px; }`);
    rules.push(`${ROOT}.selected .gen-text-${letter} { background-image: url("${tint(glyph, ground, colorOn)}"); width: 5px; height: 6px; }`);
  }
  return rules;
}

async function letteringCss(images, st) {
  const names = Object.keys(images).filter((n) => /^CHARACTER_\d+$/.test(n));
  const space = images.CHARACTER_32 ? await loadImage(images.CHARACTER_32) : null;
  if (!space) return [];
  const ground = glyphGround(space);
  const glyphs = await Promise.all(names.map((n) => loadImage(images[n])));
  const rules = [];
  names.forEach((n, i) => {
    const code = n.slice('CHARACTER_'.length);
    rules.push(`#webamp .winify-frame .character-${code} { background-image: url("${tint(glyphs[i], ground, st.normal)}"); }`);
    rules.push(`#webamp .winify-frame .wq-btn[aria-pressed="true"] .character-${code} { background-image: url("${tint(glyphs[i], ground, st.onSelected)}"); }`);
  });
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
  // A label running past the face would be left half cleared.
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

async function paint(images, st) {
  const mine = ++generation;
  const hasGen = !!images.GEN_TOP_LEFT;
  const canBuild = FRAME_SPRITES.every((n) => images[n]);
  const rules = [];
  try {
    if (!hasGen && canBuild) rules.push(...await frameCss(images), ...await titleCss(images, st));
    rules.push(...await letteringCss(images, st));
  } catch (e) {
    log('could not read the skin\'s artwork:', e.message);
  }
  if (mine !== generation || !style) return;
  style.textContent = rules.join('\n');
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

window.WinifySkin = { state: () => ({ frame: frameSource, style: webamp ? panelStyle(webamp) : null }), contrast };
