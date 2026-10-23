/* Window behaviour shared by Winify's own windows (the playlist picker, Jump
 * to track, and any later ones).
 *
 * Webamp cannot host them: it renders its four built-in windows from a fixed
 * list and throws on any other. So they get the same behaviour here instead:
 *
 *   placement   Where it was last left, else docked to the right of the
 *               player, top-aligned with the main window. Never over the
 *               main window's controls. Winify's window grows to make room.
 *   dragging    By the title bar, snapping like Webamp's windows do (its
 *               15px rules, to Webamp's windows and to the window edges),
 *               and never past the edges of Winify's window.
 *   memory      The position is remembered per window, across opens and
 *               launches.
 *   tooltips    Full text of a truncated cell, shown below its row (or
 *               above), but never over the title bar, which is for dragging.
 */

import { makeRoom } from './webamp-room.js';

const STORE_KEY = 'winify.dialogs.v1';
const SNAP_DISTANCE = 15;           // Webamp's own (snapUtils.ts)
const TOOLTIP_DELAY_MS = 500;
const WEBAMP_WINDOWS = ['#main-window', '#equalizer-window', '#playlist-window'];

// ---- Remembered positions ------------------------------------------------------

function readPositions() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
}

function savePosition(id, x, y) {
  const all = readPositions();
  all[id] = { x: Math.round(x), y: Math.round(y) };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch (e) { /* storage unavailable */ }
}

// ---- Geometry -------------------------------------------------------------------

function webampBoxes() {
  return WEBAMP_WINDOWS
    .map((sel) => document.querySelector('#webamp ' + sel))
    .filter(Boolean)
    .map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
}

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// Docked to the right of the player, top-aligned with the main window.
function defaultSpot() {
  const boxes = webampBoxes();
  if (!boxes.length) return { x: 0, y: 0 };
  const main = document.querySelector('#webamp #main-window');
  const mr = main ? main.getBoundingClientRect() : null;
  return {
    x: Math.max(...boxes.map((b) => b.x + b.width)),
    y: mr ? mr.top : Math.min(...boxes.map((b) => b.y)),
  };
}

// Webamp's snap: edge to edge, or edge aligned, with any box it overlaps
// (within the snap distance) along the other axis.
function snapTo(a, b) {
  const near = (p, q) => Math.abs(p - q) < SNAP_DISTANCE;
  const overlapX = a.x <= b.x + b.width + SNAP_DISTANCE && b.x <= a.x + a.width + SNAP_DISTANCE;
  const overlapY = a.y <= b.y + b.height + SNAP_DISTANCE && b.y <= a.y + a.height + SNAP_DISTANCE;
  let x;
  let y;
  if (overlapY) {
    if (near(a.x, b.x + b.width)) x = b.x + b.width;
    else if (near(a.x + a.width, b.x)) x = b.x - a.width;
    else if (near(a.x, b.x)) x = b.x;
    else if (near(a.x + a.width, b.x + b.width)) x = b.x + b.width - a.width;
  }
  if (overlapX) {
    if (near(a.y, b.y + b.height)) y = b.y + b.height;
    else if (near(a.y + a.height, b.y)) y = b.y - a.height;
    else if (near(a.y, b.y)) y = b.y;
    else if (near(a.y + a.height, b.y + b.height)) y = b.y + b.height - a.height;
  }
  return { x, y };
}

function snapped(box) {
  let { x, y } = box;
  for (const other of webampBoxes()) {
    const s = snapTo(box, other);
    if (s.x !== undefined) x = s.x;
    if (s.y !== undefined) y = s.y;
  }
  // ...and to the edges of Winify's window.
  const W = window.innerWidth;
  const H = window.innerHeight;
  if (Math.abs(x) < SNAP_DISTANCE) x = 0;
  else if (Math.abs(W - (x + box.width)) < SNAP_DISTANCE) x = W - box.width;
  if (Math.abs(y) < SNAP_DISTANCE) y = 0;
  else if (Math.abs(H - (y + box.height)) < SNAP_DISTANCE) y = H - box.height;
  return { x, y };
}

// Never past the edges of Winify's window.
function clamped(x, y, width, height) {
  return {
    x: Math.max(0, Math.min(x, window.innerWidth - width)),
    y: Math.max(0, Math.min(y, window.innerHeight - height)),
  };
}

// ---- Placement ---------------------------------------------------------------------

// Where a window opens, with Winify's window grown to fit it there. Resolves
// to { x, y, release }; release() gives the room back when it closes.
export async function placeDialog(id, width, height) {
  let spot = readPositions()[id];
  const mainEl = document.querySelector('#webamp #main-window');
  const r = mainEl && mainEl.getBoundingClientRect();
  const main = r && { x: r.left, y: r.top, width: r.width, height: r.height };
  // A remembered spot is used unless it would cover the main window (the
  // player may have grown under it since, say by doubling).
  if (!spot || (main && overlaps({ x: spot.x, y: spot.y, width, height }, main))) {
    spot = defaultSpot();
  }
  const release = await makeRoom(spot.x + width, spot.y + height);
  const at = clamped(spot.x, spot.y, width, height);   // the display may be too small
  return { x: at.x, y: at.y, release };
}

// ---- Dragging ------------------------------------------------------------------------

// Drag `el` by `handle`; controls inside the handle (the close button) still
// click. The final position is remembered under `id`.
export function makeDraggable(el, handle, id, { ignore = '' } = {}) {
  handle.style.cursor = 'default';
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (ignore && e.target.closest(ignore))) return;
    e.preventDefault();
    hideTooltip();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const from = { x: el.offsetLeft, y: el.offsetTop };
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const move = (ev) => {
      const box = { x: from.x + ev.clientX - startX, y: from.y + ev.clientY - startY, width, height };
      const s = snapped(box);
      const c = clamped(s.x, s.y, width, height);
      el.style.left = c.x + 'px';
      el.style.top = c.y + 'px';
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      savePosition(id, el.offsetLeft, el.offsetTop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

// ---- Tooltips ------------------------------------------------------------------------
// The browser's own tooltips appear wherever the system puts them, which can
// be over the title bar. These sit next to the row instead, and only for
// text that is cut off.

let tip = null;
let tipTimer = null;

export function hideTooltip() {
  clearTimeout(tipTimer);
  tipTimer = null;
  if (tip) { tip.remove(); tip = null; }
}

function showTooltip(cell, dialog, titleBar, style) {
  hideTooltip();
  tip = document.createElement('div');
  tip.className = 'winify-tooltip';
  tip.textContent = cell.textContent;
  Object.assign(tip.style, {
    position: 'fixed', zIndex: '100003', pointerEvents: 'none', whiteSpace: 'nowrap',
    font: '9px ' + style.font, padding: '1px 3px', background: style.normalbg,
    color: style.normal, border: '1px solid ' + style.normal,
  });
  document.body.appendChild(tip);
  const row = cell.getBoundingClientRect();
  const floor = titleBar.getBoundingClientRect().bottom;   // never above this
  const h = tip.offsetHeight;
  let top = row.bottom + 2;
  if (top + h > window.innerHeight) top = row.top - h - 2;
  top = Math.max(floor + 1, top);
  const left = Math.max(0, Math.min(row.left, window.innerWidth - tip.offsetWidth - 2));
  tip.style.top = top + 'px';
  tip.style.left = left + 'px';
}

// Tooltips for cut-off text in `list` (cells matching `cells`), kept clear of
// the dialog's title bar. `style` gives the skin's playlist colours and font.
export function attachTooltips(list, dialog, titleBar, cells, style) {
  list.addEventListener('pointerover', (e) => {
    const cell = e.target.closest(cells);
    if (!cell || cell.scrollWidth <= cell.clientWidth) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTooltip(cell, dialog, titleBar, style()), TOOLTIP_DELAY_MS);
  });
  for (const ev of ['pointerout', 'pointerdown', 'wheel', 'keydown']) {
    (ev === 'keydown' ? dialog : list).addEventListener(ev, hideTooltip, { passive: true });
  }
}
