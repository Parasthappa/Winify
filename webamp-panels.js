/* The side panels: the playlist picker, Jump to track, lyrics and Milkdrop.
 *
 * Any number can be open; each stays open until closed with its own close
 * button or Escape (Escape closes only the focused one: the panel last
 * clicked or typed in).
 *
 * Default stack: panels the user has not placed themselves stack to the
 * right of the main + playlist column, in the order they were opened, tops
 * aligned and edges touching. One that would run off the right edge starts
 * a second row under the playlist window, left-aligned with it; a row that
 * would run off the bottom is shortened to fit. All open at the same height,
 * the main window's plus the playlist window's default height, so they line
 * up with that column. Closing one slides the later ones over (and up).
 *
 * Placed: a panel dragged (or snapped) or resized by the user leaves the
 * stack; its spot and size are remembered and it opens there again. Reset
 * window layout forgets those and restacks what is open. Which panels were
 * open is remembered too, and they come back at launch. All are screen
 * positions (Winify's one see-through window).
 *
 * Each panel registers how to open, close, read and set its rectangle; the
 * picker, search and lyrics are Winify's own DOM windows, Milkdrop is
 * Webamp's (sized in its 25x29 px steps, see webamp-milkdrop.js).
 */

const log = (...args) => console.log('[winify/panels]', ...args);

const STORE_KEY = 'winify.panels.v1';
export const PLAYLIST_DEFAULT_HEIGHT = 116 + 29 * 5;   // webamp-ui.js DEFAULT_PLAYLIST_SIZE
export const MIN_SIZE = { w: 275, h: 116 };            // Winamp's playlist window minimum

const panels = new Map();      // id -> { defaultWidth, fit(rect), open(), close(), isOpen(), getRect(), setRect(rect) }
let webamp = null;
let focused = null;            // id of the panel last clicked or typed in
let zTop = 100001;             // Winify's own windows' stacking order

function readStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.open) && s.placed && typeof s.placed === 'object') return s;
  } catch (e) { /* none */ }
  // Before panels were managed together, lyrics remembered being open itself.
  let lyrics = false;
  try { lyrics = localStorage.getItem('winify.lyrics.open') === '1'; } catch (e) { /* none */ }
  return { open: lyrics ? ['lyrics'] : [], placed: {} };
}
let store = readStore();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* storage unavailable */ }
}

export function register(id, panel) {
  panels.set(id, panel);
}

// ---- Geometry ------------------------------------------------------------------

function rectOf(sel) {
  const el = document.querySelector('#webamp ' + sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) } : null;
}

// The left-hand column: the main window, and the playlist (and equalizer)
// windows under it.
function column() {
  const main = rectOf('#main-window') || { x: 0, y: 0, r: 275, b: 116 };
  const parts = [main];
  const playlist = rectOf('#playlist-window');
  if (playlist) parts.push(playlist);
  const eq = rectOf('#equalizer-window');
  if (eq && eq.x < main.r && eq.r > main.x) parts.push(eq);
  return {
    left: playlist ? playlist.x : main.x,
    right: Math.max(...parts.map((p) => p.r)),
    top: main.y,
    bottom: Math.max(...parts.map((p) => p.b)),
    height: (main.b - main.y) + PLAYLIST_DEFAULT_HEIGHT,
  };
}

const area = () => ({ w: window.innerWidth, h: window.innerHeight });

// Where the stacked panels go, in order: { id: { x, y, w, h } }.
function stack(ids) {
  const col = column();
  const { w: W, h: H } = area();
  const out = {};
  let x = col.right;
  let y = col.top;
  let rowStart = col.right;
  let rowH = 0;
  let row = 0;
  for (const id of ids) {
    const p = panels.get(id);
    if (!p) continue;
    const w = p.defaultWidth;
    // No room left in this row (the first row too, even for its first panel:
    // the column may be at the right edge); a fresh lower row is used as is.
    if (x + w > W && !(row > 0 && x === rowStart)) {
      // A new row: the first one under the column, later ones under that.
      y = row === 0 ? col.bottom : y + rowH;
      x = rowStart = col.left;
      rowH = 0;
      row++;
    }
    const h = Math.max(MIN_SIZE.h, Math.min(col.height, H - y));
    if (y + h > H) y = Math.max(0, H - h);
    // Never off the screen: a stacked panel must not push the player (Webamp
    // pulls a window that is off screen back, with its snapped group).
    const px = Math.max(0, Math.min(x, W - w));
    const fitted = p.fit ? p.fit({ x: px, y, w, h }) : { x: px, y, w, h };
    out[id] = fitted;
    x = px + fitted.w;
    rowH = Math.max(rowH, fitted.h);
  }
  return out;
}

const stacked = () => store.open.filter((id) => !store.placed[id] && panels.get(id) && panels.get(id).isOpen());

function relayout(except) {
  const ids = stacked();
  const rects = stack(ids);
  for (const id of ids) if (id !== except) panels.get(id).setRect(rects[id]);
  return rects;
}

function clampRect(r) {
  const { w: W, h: H } = area();
  const w = Math.min(r.w, W);
  const h = Math.min(r.h, H);
  return { x: Math.max(0, Math.min(r.x, W - w)), y: Math.max(0, Math.min(r.y, H - h)), w, h };
}

// ---- What the panels tell this --------------------------------------------------

// About to open: the rectangle to open at.
export function opening(id) {
  if (!store.open.includes(id)) store.open.push(id);
  save();
  if (store.placed[id]) return clampRect(store.placed[id]);
  const ids = stacked().filter((x) => x !== id).concat(id);
  // Keep the order the panels were opened in.
  ids.sort((a, b) => store.open.indexOf(a) - store.open.indexOf(b));
  return stack(ids)[id];
}

export function opened(id) {
  if (!store.open.includes(id)) { store.open.push(id); save(); }
  focus(id);
  relayout(id);
}

export function closed(id) {
  store.open = store.open.filter((x) => x !== id);
  if (focused === id) focused = null;
  save();
  relayout();
}

// Dragged (or snapped) or resized by the user: out of the stack, remembered.
export function placed(id, rect) {
  const was = !!store.placed[id];
  store.placed[id] = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
  save();
  if (!was) { log(id, 'placed by hand - out of the stack'); relayout(id); }
}

// Reset window layout: forget the placements, restack what is open.
export function reset() {
  store.placed = {};
  save();
  relayout();
  log('panel placements forgotten - open panels restacked');
}

// The panel last clicked or typed in; also brought in front of the others.
export function focus(id) {
  focused = id;
  const p = panels.get(id);
  if (p && p.element) { const el = p.element(); if (el) el.style.zIndex = String(++zTop); }
}

// ---- Escape, focus ---------------------------------------------------------------

function onPointerDown(e) {
  if (!(e.target instanceof Element)) return;
  for (const [id, p] of panels) {
    const el = p.element && p.element();
    if (el && el.contains(e.target)) { focus(id); return; }
  }
  // Anywhere else in Winify (a Webamp window): no panel is focused.
  if (e.target.closest('#webamp, #login-screen')) focused = null;
}

function onKeyDown(e) {
  if (e.key !== 'Escape' || !focused || e.defaultPrevented) return;
  if (document.getElementById('webamp-context-menu')) return;   // the menu takes it
  if (document.fullscreenElement) return;                       // leaves full screen first
  const p = panels.get(focused);
  if (!p || !p.isOpen()) return;
  e.preventDefault();
  e.stopPropagation();
  p.close();
}

// ---- Lifecycle ---------------------------------------------------------------

// After Webamp has mounted and the layout is in place: reopen what was open,
// in the order it was opened.
export async function attach(instance) {
  webamp = instance;
  store = readStore();
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  const order = store.open.slice();
  for (const id of order) {
    const p = panels.get(id);
    if (p && !p.isOpen()) {
      try { await p.open(); } catch (err) { log('*** could not reopen', id, '-', err && err.message); }
    }
  }
  // Open but not on record (Milkdrop restored with the layout): at the end.
  for (const [id, p] of panels) if (p.isOpen() && !store.open.includes(id)) store.open.push(id);
  save();
  relayout();
}

export function detach() {
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('keydown', onKeyDown, true);
  webamp = null;
  focused = null;
}

window.WinifyPanels = {
  state: () => ({ open: store.open.slice(), placed: JSON.parse(JSON.stringify(store.placed)), focused, stacked: stacked() }),
  reset,
  relayout: () => relayout(),
};
