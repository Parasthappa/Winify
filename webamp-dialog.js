/* Window behaviour shared by Winify's own windows (the playlist picker, Jump
 * to track, lyrics).
 *
 * Webamp cannot host them: it renders its four built-in windows from a fixed
 * list and throws on any other. So they get the same behaviour here instead:
 *
 *   dragging    By the title bar, snapping like Webamp's windows do (its
 *               15px rules, to Webamp's windows, the other panels and the
 *               window edges), and never past the edges of Winify's window.
 *   resizing    By a grip in the bottom-right corner, like the playlist
 *               window's, in its steps (25 x 29 px from 275 x 116), so
 *               edges line up with Webamp's windows; within the snap
 *               distance of another window's edge, it snaps to that edge.
 *   tooltips    Full text of a truncated cell, shown below its row (or
 *               above), but never over the title bar, which is for dragging.
 *
 * Where they open, and what is remembered, is the panel manager's
 * (webamp-panels.js): a finished drag or resize is reported to it.
 */

const SNAP_DISTANCE = 15;           // Webamp's own (snapUtils.ts)
const TOOLTIP_DELAY_MS = 500;
const WEBAMP_WINDOWS = ['#main-window', '#equalizer-window', '#playlist-window', '.gen-window:not(.winify-frame)',
  '.winify-picker', '.winify-search', '.winify-lyrics'];

// ---- Geometry -------------------------------------------------------------------

function webampBoxes(except) {
  return WEBAMP_WINDOWS
    .map((sel) => document.querySelector('#webamp ' + sel))
    .filter((el) => el && el !== except)
    .map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
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

function snapped(box, except) {
  let { x, y } = box;
  for (const other of webampBoxes(except)) {
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

// ---- Dragging ------------------------------------------------------------------------

// Where a rectangle dropped at { x, y, w, h } snaps to (Webamp's rules, the
// other windows and the window edges).
export function snapRect(r, except) {
  const s = snapped({ x: r.x, y: r.y, width: r.w, height: r.h }, except);
  return { x: s.x, y: s.y, w: r.w, h: r.h };
}

const rectOf = (el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });

// Drag `el` by `handle`; controls inside the handle (the close button) still
// click. onMoved(rect) once a drag has actually moved it.
export function makeDraggable(el, handle, { ignore = '', onMoved } = {}) {
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
      if (ev.buttons === 0) { up(); return; }   // let go where the release was not seen
      const box = { x: from.x + ev.clientX - startX, y: from.y + ev.clientY - startY, width, height };
      const s = snapped(box, el);
      const c = clamped(s.x, s.y, width, height);
      el.style.left = c.x + 'px';
      el.style.top = c.y + 'px';
    };
    let done = false;
    const up = () => {
      if (done) return;
      done = true;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.removeEventListener('lostpointercapture', up);
      if ((el.offsetLeft !== from.x || el.offsetTop !== from.y) && onMoved) onMoved(rectOf(el));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    handle.addEventListener('lostpointercapture', up);
  });
}

// ---- Resizing ----------------------------------------------------------------------

// Winamp's resize steps (Webamp's playlist and Milkdrop windows): 275 x 116
// plus whole 25 x 29 px segments.
export const STEP = { w: 25, h: 29, baseW: 275, baseH: 116 };
export const stepped = (w, h, round = Math.round) => ({
  w: STEP.baseW + Math.max(0, round((w - STEP.baseW) / STEP.w)) * STEP.w,
  h: STEP.baseH + Math.max(0, round((h - STEP.baseH) / STEP.h)) * STEP.h,
});

// While resizing: the right and bottom edges snap to another window's edges
// (touching or aligned, with a window level with it on the other axis) and to
// the edges of Winify's window, within Webamp's snap distance, as moving does.
// A snap wins over the steps, which cannot reach every neighbour's edge.
function snappedSize(x, y, w, h, except) {
  const near = (p, q) => Math.abs(p - q) < SNAP_DISTANCE;
  let bestW = null;
  let bestH = null;
  const closer = (best, edge, target) => (best === null || Math.abs(target - edge) < Math.abs(best - edge) ? target : best);
  const boxes = webampBoxes(except).concat([{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }]);
  for (const b of boxes) {
    const levelY = y < b.y + b.height + SNAP_DISTANCE && b.y < y + h + SNAP_DISTANCE;
    const levelX = x < b.x + b.width + SNAP_DISTANCE && b.x < x + w + SNAP_DISTANCE;
    if (levelY) for (const edge of [b.x, b.x + b.width]) if (edge > x && near(x + w, edge)) bestW = closer(bestW, x + w, edge);
    if (levelX) for (const edge of [b.y, b.y + b.height]) if (edge > y && near(y + h, edge)) bestH = closer(bestH, y + h, edge);
  }
  return { w: bestW === null ? w : Math.round(bestW - x), h: bestH === null ? h : Math.round(bestH - y) };
}

// Resizing `el` by `grip` (its frame's bottom-right corner, webamp-frame.js),
// in Winamp's steps, snapping to other windows' edges when close.
// onResize() while it moves, onResized(rect) when let go.
export function makeResizable(el, { grip, minWidth, minHeight, onResize, onResized }) {
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    hideTooltip();
    grip.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    const from = rectOf(el);
    const move = (ev) => {
      if (ev.buttons === 0) { up(); return; }   // let go where the release was not seen
      const want = { w: from.w + ev.clientX - sx, h: from.h + ev.clientY - sy };
      const snap = snappedSize(from.x, from.y, want.w, want.h, el);
      const raw = stepped(want.w, want.h);
      const fit = { w: window.innerWidth - from.x, h: window.innerHeight - from.y };   // never past the edges
      const w = Math.max(minWidth, Math.min(snap.w !== want.w ? snap.w : raw.w, fit.w));
      const h = Math.max(minHeight, Math.min(snap.h !== want.h ? snap.h : raw.h, fit.h));
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      if (onResize) onResize();
    };
    let done = false;
    const up = () => {
      if (done) return;
      done = true;
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      grip.removeEventListener('lostpointercapture', up);
      const now = rectOf(el);
      if ((now.w !== from.w || now.h !== from.h) && onResized) onResized(now);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
    grip.addEventListener('lostpointercapture', up);
  });
  return grip;
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
