/* The Winamp face.
 *
 * Renders Webamp's classic interface inside Winify. Its controls drive the
 * Winify Spotify device and its display follows Spotify's state; all of that
 * lives in webamp-spotify.js. No visualizer data yet.
 *
 * Still to come:
 *
 *   - Webamp's built-in visualizer will later be driven from
 *     WinifyAudio.subscribe(), because Webamp cannot read Spotify's
 *     DRM-protected audio itself.
 *   - Butterchurn attaches separately via the analyser's AudioContext.
 */
import Webamp from './node_modules/webamp/built/webamp.bundle.min.mjs';
import { SpotifyMedia, middleware, handleTrackDropEvent, attach, detach } from './webamp-spotify.js';
import { open as openPicker } from './webamp-picker.js';
import * as inert from './webamp-inert.js';
import * as vis from './webamp-vis.js';
import * as skin from './webamp-skin.js';
import * as milkdrop from './webamp-milkdrop.js';
import * as panels from './webamp-panels.js';
import * as frame from './webamp-frame.js';
import * as ontop from './webamp-ontop.js';

let webamp = null;
let mounted = false;

// Everything starts at 1x, so the main window and the playlist share one
// scale and one width. Webamp cannot double the playlist (it stays 1x when
// the rest doubles), so a doubled default left the two mismatched. Double
// size is one click away on the D button, sprites stay blocky when doubled
// (Webamp renders them with image-rendering: pixelated), and the choice is
// remembered with the rest of the layout.
const DOUBLE_SIZE_BY_DEFAULT = false;

const OPTIONS = {
  // No tracks: the playlist holds one stand-in entry that mirrors Spotify,
  // added by webamp-spotify.js. Real playlist contents are a later stage.
  initialTracks: [],
  availableSkins: [],
  // Private Webamp options; the version is pinned in package.json because
  // of them, and attach() verifies they took effect.
  __customMediaClass: SpotifyMedia,
  __customMiddlewares: [middleware, milkdrop.middleware, (store) => (next) => (action) => layoutGuard(store, next, action)],
  // Webamp's Milkdrop window, drawn by Butterchurn (webamp-milkdrop.js).
  __butterchurnOptions: milkdrop.butterchurnOptions,
  handleTrackDropEvent,
  // Its windows (#webamp, on <body>) under the chassis, which is drawn above
  // them (index.html); its menus are lifted above the chassis there too.
  zIndex: 1,
  // Webamp's "load list" opens the playlist picker (its LIST OPTS button is
  // VIZ in Winify, webamp-milkdrop.js, so this is not normally reached); null leaves
  // Webamp's playlist alone (the picker plays the choice itself).
  handleLoadListEvent: () => { openPicker(); return null; },
  handleAddUrlEvent: inert.handleAddUrlEvent,
  handleSaveListEvent: inert.handleSaveListEvent,
  // Webamp's own double-size path: it resizes the windows and then re-lays
  // out the stack so they still dock edge to edge.
  enableDoubleSizeMode: DOUBLE_SIZE_BY_DEFAULT,
};

// The playlist's default size, in Webamp's 25x29 px resize segments: no extra
// width keeps it 275px, the 1x main window's width; 5 tall gives 15 rows.
// Scaling the playlist to 2x with CSS was tried: its corner-resize grip then
// moved at twice the pointer's speed, so it stays at Webamp's own 1x.
const DEFAULT_PLAYLIST_SIZE = [0, 5];

// Window positions, shade, the playlist size and double size are remembered across
// launches, as classic Winamp did. Per-machine convenience only, so the
// browser's own storage is enough; losing it just means the default layout.
// v2: layouts saved by earlier builds were recorded while windows could be
// laid out in a hidden, 0x0 container, which pushed them to the top-left.
// Those cannot be trusted, so they are dropped rather than restored.
const LAYOUT_KEY = 'winify.layout.v2';
const STALE_LAYOUT_KEYS = ['winify.layout.v1'];
const LAYOUT_WINDOWS = ['main', 'equalizer', 'playlist', 'milkdrop'];
// Milkdrop is Webamp's only generic window, which has no id of its own.
const WINDOW_SELECTORS = { main: '#main-window', equalizer: '#equalizer-window', playlist: '#playlist-window', milkdrop: '.gen-window:not(.winify-frame)' };
const SAVE_DELAY_MS = 400;

// Winify's window wraps the player: its size follows the layout, edge to
// edge. Positions are therefore relative to the layout (its top-left window
// sits at the window's corner) rather than to a fixed window. No margin:
// Webamp snaps a dragged window to the container's edges within 15px, so a
// margin would not survive the first drag.
const PLAYER_MARGIN = 0;
// In the app, Winify is one see-through window over the screen (preload.js):
// window positions are screen positions, and the window never resizes.
const SCREEN_WINDOW = !!(window.spotify && window.spotify.screenWindow);
const REFIT_DELAY_MS = 150;

function log(...args) {
  console.log('[winify/webamp]', ...args);
}

function readLayout() {
  for (const key of STALE_LAYOUT_KEYS) {
    try { localStorage.removeItem(key); } catch (e) { /* storage unavailable */ }
  }
  let raw = null;
  try { raw = localStorage.getItem(LAYOUT_KEY); } catch (e) { return null; }
  if (raw == null) return null;
  try {
    // Anything unreadable comes back as {} and is rejected by layoutProblem.
    return JSON.parse(raw) || {};
  } catch (e) {
    return {};
  }
}

function currentLayout() {
  const state = webamp.store.getState();
  const positions = {};
  for (const id of LAYOUT_WINDOWS) {
    const w = state.windows.genWindows[id];
    if (w) positions[id] = { x: w.position.x, y: w.position.y };
  }
  const shade = {};
  const open = {};
  for (const id of LAYOUT_WINDOWS) {
    shade[id] = !!state.windows.genWindows[id].shade;
    open[id] = !!state.windows.genWindows[id].open;
  }
  // Taken down while Winify is out of sight, Milkdrop is still open.
  if (milkdrop.isSuspended()) open.milkdrop = true;
  return {
    // Screen positions (Winify's one see-through window), not positions
    // within a window fitted around the player.
    screen: SCREEN_WINDOW,
    doubled: state.display.doubled,
    positions,
    playlistSize: state.windows.genWindows.playlist.size,
    milkdropSize: state.windows.genWindows.milkdrop.size,
    // Shaded windows are 14px tall, so positions only make sense with these.
    shade,
    // Which windows are showing; the equalizer is closed until you open it.
    open,
  };
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

// The app screen is display:none until sign-in completes, and sign-in is
// reported before it is shown. Laying windows out in a 0x0 container put the
// whole stack at the top-left corner, and that broken layout was then saved.
// So nothing is laid out until the container has a real size.
async function waitForSize(container, timeoutMs = 10000) {
  const until = performance.now() + timeoutMs;
  while (!(container.clientWidth > 0 && container.clientHeight > 0)) {
    if (performance.now() > until) { log('*** container still has no size; laying out anyway'); return; }
    await nextFrame();
  }
}

// Pixel sizes of the windows for a layout, as Webamp draws them. Main and
// equalizer double; the playlist and Milkdrop grow by 25x29 px segments
// instead.
function windowSizes(layout) {
  const k = layout.doubled ? 2 : 1;
  const shade = layout.shade || {};
  const [pw, ph] = layout.playlistSize || [0, 0];
  const [mw, mh] = layout.milkdropSize || milkdrop.DEFAULT_SIZE;
  return {
    main: { w: 275 * k, h: (shade.main ? 14 : 116) * k },
    equalizer: { w: 275 * k, h: (shade.equalizer ? 14 : 116) * k },
    playlist: { w: 275 + 25 * pw, h: shade.playlist ? 14 : 116 + 29 * ph },
    milkdrop: { w: 275 + 25 * mw, h: 116 + 29 * mh },
  };
}

// The windows that are showing. Layouts saved before open/closed was
// recorded had every window open; the main window always opens; Milkdrop
// only when it was left open.
function shownWindows(layout) {
  return LAYOUT_WINDOWS.filter((id) => id === 'main' ||
    (id === 'milkdrop' ? !!(layout.open && layout.open.milkdrop) : !layout.open || layout.open[id] !== false));
}

// Layouts saved before Milkdrop existed: it is closed, parked to the right of
// the main window, at its default size.
function withMilkdrop(layout) {
  if (!layout || !layout.positions || !layout.positions.main) return layout;
  if (!layout.positions.milkdrop) {
    const k = layout.doubled ? 2 : 1;
    layout.positions.milkdrop = { x: layout.positions.main.x + 275 * k, y: layout.positions.main.y };
    layout.open = Object.assign({}, layout.open, { milkdrop: false });
  }
  if (!Array.isArray(layout.milkdropSize)) layout.milkdropSize = milkdrop.DEFAULT_SIZE;
  return layout;
}

// The bounding box of the showing windows.
function layoutBox(layout) {
  const sizes = windowSizes(layout);
  const ids = shownWindows(layout);
  const p = layout.positions;
  return {
    l: Math.min(...ids.map((id) => p[id].x)),
    t: Math.min(...ids.map((id) => p[id].y)),
    r: Math.max(...ids.map((id) => p[id].x + sizes[id].w)),
    b: Math.max(...ids.map((id) => p[id].y + sizes[id].h)),
  };
}

// Why a layout cannot be used, or null if it can. Invalid means a window is
// missing, wholly off the display, or mostly covering another one.
function layoutProblem(layout) {
  const pos = layout && layout.positions;
  if (!pos) return 'no positions';
  for (const id of LAYOUT_WINDOWS) {
    if (!pos[id] || !Number.isFinite(pos[id].x) || !Number.isFinite(pos[id].y)) return id + ' window missing';
  }
  const sizes = windowSizes(layout);
  const rect = (id) => ({ l: pos[id].x, t: pos[id].y, r: pos[id].x + sizes[id].w, b: pos[id].y + sizes[id].h });
  const W = window.screen.availWidth;
  const H = window.screen.availHeight;
  const shown = shownWindows(layout);
  for (const id of shown) {
    const r = rect(id);
    if (r.r <= 0 || r.b <= 0 || r.l >= W || r.t >= H) return id + ' window is off screen';
  }
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      const a = rect(shown[i]);
      const b = rect(shown[j]);
      const overlap = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) *
        Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
      const smaller = Math.min((a.r - a.l) * (a.b - a.t), (b.r - b.l) * (b.b - b.t));
      if (overlap > smaller * 0.5) return shown[i] + ' and ' + shown[j] + ' windows overlap';
    }
  }
  return null;
}

// The default layout: the main window with the playlist docked directly below
// it, left edges aligned, and Winify's window fitted around the pair. The
// equalizer starts closed (the EQ button opens it); it is parked below the
// playlist so it docks there when opened. Used at first launch, on Reset
// window layout, and when a saved layout is unusable.
async function applyDefaultLayout(container) {
  setDoubleSize(DOUBLE_SIZE_BY_DEFAULT);
  const state = webamp.store.getState();
  for (const id of LAYOUT_WINDOWS) {
    const w = state.windows.genWindows[id];
    // Milkdrop is a side panel: left open or closed (the panels restack).
    const wantOpen = id === 'milkdrop' ? w.open : id !== 'equalizer';
    if (w.open !== wantOpen) webamp.store.dispatch({ type: 'TOGGLE_WINDOW', windowId: id });
    if (w.shade) webamp.store.dispatch({ type: 'TOGGLE_WINDOW_SHADE_MODE', windowId: id });
  }
  webamp.store.dispatch({ type: 'WINDOW_SIZE_CHANGED', windowId: 'playlist', size: DEFAULT_PLAYLIST_SIZE });
  webamp.store.dispatch({ type: 'WINDOW_SIZE_CHANGED', windowId: 'milkdrop', size: milkdrop.DEFAULT_SIZE });
  const sizes = windowSizes({ doubled: isDoubled(), playlistSize: DEFAULT_PLAYLIST_SIZE });
  const x = PLAYER_MARGIN;
  const y = PLAYER_MARGIN;
  const layout = currentLayout();
  layout.positions = {
    main: { x, y },
    playlist: { x, y: y + sizes.main.h },
    equalizer: { x, y: y + sizes.main.h + sizes.playlist.h },
    milkdrop: { x: x + sizes.main.w, y },
  };
  await placeLayout(container, layout, { center: true });
}

// Fit Winify's window around a layout and put the windows in it: the layout
// is moved so its top-left window sits at the margin, the window is resized
// to the layout plus the margin, and the positions are applied once the
// window has its new size. center puts it at its default spot (sign-in,
// reset); otherwise it grows or shrinks in place.
async function placeLayout(container, layout, { center = false } = {}) {
  if (!(window.spotify && window.spotify.fitWindow)) {
    let positions = layout.positions;
    // Screen window: a layout from a fitted window (or the default) opens at
    // the screen's left edge, centred top to bottom, leaving the room beside
    // it for the side panels (the chassis has the bottom-right: centred, the
    // column left no room there and panels landed under the playlist).
    if (SCREEN_WINDOW && center) {
      const box = layoutBox(layout);
      const dx = PLAYER_MARGIN - box.l;
      const dy = Math.round((container.clientHeight - (box.b - box.t)) / 2 - box.t);
      positions = {};
      for (const id of LAYOUT_WINDOWS) positions[id] = { x: layout.positions[id].x + dx, y: layout.positions[id].y + dy };
    }
    webamp.store.dispatch({ type: 'UPDATE_WINDOW_POSITIONS', positions, absolute: true });
    await keepOnScreen(container);
    return;
  }
  const box = layoutBox(layout);
  const dx = PLAYER_MARGIN - box.l;
  const dy = PLAYER_MARGIN - box.t;
  const positions = {};
  for (const id of LAYOUT_WINDOWS) {
    positions[id] = { x: layout.positions[id].x + dx, y: layout.positions[id].y + dy };
  }
  const width = box.r - box.l + 2 * PLAYER_MARGIN;
  const height = box.b - box.t + 2 * PLAYER_MARGIN;
  // Positions first, then the window size. When the browser window resizes,
  // Webamp checks the layout still fits; if not, it resets every window's
  // size and restacks them. Placed first, the layout always fits the new size.
  webamp.store.dispatch({ type: 'UPDATE_WINDOW_POSITIONS', positions, absolute: true });
  window.spotify.fitWindow({ width, height, center });
  // The display may be too small to grow that far; then keepOnScreen below
  // slides the group into whatever room there is.
  const until = performance.now() + 1500;
  while ((container.clientWidth < width - 1 || container.clientHeight < height - 1) &&
         performance.now() < until) {
    await nextFrame();
  }
  webamp.store.dispatch({ type: 'UPDATE_WINDOW_POSITIONS', positions, absolute: true });
  await keepOnScreen(container);
}

// Whether a window shares an edge with any other showing window.
function touchesAnother(layout, id) {
  const sizes = windowSizes(layout);
  const p = layout.positions;
  const a = { l: p[id].x, t: p[id].y, r: p[id].x + sizes[id].w, b: p[id].y + sizes[id].h };
  return shownWindows(layout).some((other) => {
    if (other === id) return false;
    const b = { l: p[other].x, t: p[other].y, r: p[other].x + sizes[other].w, b: p[other].y + sizes[other].h };
    const sideBySide = (Math.abs(a.r - b.l) <= 1 || Math.abs(b.r - a.l) <= 1) && a.t < b.b && b.t < a.b;
    const stacked = (Math.abs(a.b - b.t) <= 1 || Math.abs(b.b - a.t) <= 1) && a.l < b.r && b.l < a.r;
    return sideBySide || stacked;
  });
}

// Opening the equalizer puts it where it was last left, docked to the
// player. A closed window does not move with the others, so if the player
// has moved since, or the spot is off the display or on another window, it
// docks below the playlist (or the main window, if the playlist is closed).
// Winify's window then grows to take it in.
function placeOpenedEqualizer() {
  const layout = currentLayout();
  const problem = layoutProblem(layout);
  if ((problem && /equalizer/.test(problem)) || !touchesAnother(layout, 'equalizer')) {
    const sizes = windowSizes(layout);
    const under = layout.open.playlist ? 'playlist' : 'main';
    const p = layout.positions[under];
    webamp.store.dispatch({
      type: 'UPDATE_WINDOW_POSITIONS',
      positions: { equalizer: { x: p.x, y: p.y + sizes[under].h } },
      absolute: true,
    });
    log('equalizer docked below the', under, '(' + (problem || 'was not docked to the player') + ')');
  }
}

// If Winify's window could not grow to fit the layout (a small display), slide
// the whole group into the room there is, keeping it docked.
async function keepOnScreen(container) {
  await nextFrame();
  const box = container.getBoundingClientRect();
  if (!(box.width > 0 && box.height > 0)) return;
  const rects = LAYOUT_WINDOWS
    .map((id) => document.querySelector('#webamp ' + WINDOW_SELECTORS[id]))
    .filter(Boolean)
    .map((el) => el.getBoundingClientRect());
  if (!rects.length) return;
  const left = Math.min(...rects.map((r) => r.left)) - box.left;
  const top = Math.min(...rects.map((r) => r.top)) - box.top;
  const right = Math.max(...rects.map((r) => r.right)) - box.left;
  const bottom = Math.max(...rects.map((r) => r.bottom)) - box.top;
  const dx = left < 0 ? -left : Math.min(0, box.width - right);
  const dy = top < 0 ? -top : Math.min(0, box.height - bottom);
  if (!dx && !dy) return;
  const { positions } = currentLayout();
  for (const id of Object.keys(positions)) {
    positions[id] = { x: Math.max(0, positions[id].x + dx), y: Math.max(0, positions[id].y + dy) };
  }
  webamp.store.dispatch({ type: 'UPDATE_WINDOW_POSITIONS', positions, absolute: true });
  log('layout moved back on screen by', dx, dy);
}

async function restoreLayout(container) {
  const saved = withMilkdrop(readLayout());
  if (!saved) { await applyDefaultLayout(container); return; }
  const problem = layoutProblem(saved);
  if (problem) {
    log('saved layout unusable (' + problem + ') - using the default layout');
    try { localStorage.removeItem(LAYOUT_KEY); } catch (e) { /* storage unavailable */ }
    await applyDefaultLayout(container);
    return;
  }
  if (typeof saved.doubled === 'boolean') setDoubleSize(saved.doubled);
  if (Array.isArray(saved.playlistSize)) {
    webamp.store.dispatch({ type: 'WINDOW_SIZE_CHANGED', windowId: 'playlist', size: saved.playlistSize });
  }
  webamp.store.dispatch({ type: 'WINDOW_SIZE_CHANGED', windowId: 'milkdrop', size: saved.milkdropSize });
  const genWindows = webamp.store.getState().windows.genWindows;
  for (const id of LAYOUT_WINDOWS) {
    if (saved.shade && !!saved.shade[id] !== !!genWindows[id].shade) {
      webamp.store.dispatch({ type: 'TOGGLE_WINDOW_SHADE_MODE', windowId: id });
    }
  }
  for (const id of LAYOUT_WINDOWS) {
    const wantOpen = shownWindows(saved).includes(id);
    if (wantOpen !== !!webamp.store.getState().windows.genWindows[id].open) {
      webamp.store.dispatch({ type: 'TOGGLE_WINDOW', windowId: id });
    }
  }
  const layout = currentLayout();
  layout.positions = saved.positions;
  // Already screen positions: exactly where they were left.
  await placeLayout(container, layout, { center: !(SCREEN_WINDOW && saved.screen) });
  if (SCREEN_WINDOW && !saved.screen) {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(currentLayout())); } catch (e) { /* storage unavailable */ }
  }
  log('layout restored', SCREEN_WINDOW && !saved.screen ? '(from the old fitted window: at the left edge)' : '');
}

// Menu bar > Reset window layout: forget the saved layout and go back to the
// default: main and playlist, unshaded, with the equalizer closed.
async function resetLayout() {
  try { localStorage.removeItem(LAYOUT_KEY); } catch (e) { /* storage unavailable */ }
  if (!webamp || !mounted) { panels.reset(); log('layout reset (applies at next sign-in)'); return; }
  await applyDefaultLayout(document.getElementById(mountedInto));
  panels.reset();
  log('layout reset to default');
}

// Webamp, when its container changes size and its windows no longer fit,
// shrinks every window to its smallest (the playlist to 116 px) and lines
// them up side by side. Winify keeps its windows on screen itself
// (keepOnScreen), so that is undone: the sizes are kept, and the positions
// from just before are put back and slid on screen.
function layoutGuard(store, next, action) {
  if (!action || action.type !== 'RESET_WINDOW_SIZES') return next(action);
  if (!webamp || !mounted) return next(action);
  const before = currentLayout();
  log('Webamp tried to re-arrange the windows (its container changed size) - kept as they were');
  setTimeout(() => {
    if (!webamp || !mounted) return;
    const container = document.getElementById(mountedInto);
    const box = layoutBox(before);
    const W = container.clientWidth;
    const H = container.clientHeight;
    if (box.r - box.l <= W && box.b - box.t <= H) {
      webamp.store.dispatch({ type: 'UPDATE_WINDOW_POSITIONS', positions: before.positions, absolute: true });
      keepOnScreen(container);
      return;
    }
    // Too big for the space for now: moved as one, top-left on screen, so it
    // is all there again when the space is back.
    const dx = box.l < 0 ? -box.l : Math.min(0, Math.max(-box.l, W - box.r));
    const dy = box.t < 0 ? -box.t : Math.min(0, Math.max(-box.t, H - box.b));
    const positions = {};
    for (const id of Object.keys(before.positions)) positions[id] = { x: before.positions[id].x + dx, y: before.positions[id].y + dy };
    webamp.store.dispatch({ type: 'UPDATE_WINDOW_POSITIONS', positions, absolute: true });
  }, 0);
  return undefined;
}

let unsubscribeLayout = null;
// The layout's shape: what changes the size Winify's window should be.
// Moving a window does not; opening, closing, shading, resizing or doubling
// one does.
function layoutShape() {
  const { doubled, open, shade, playlistSize, milkdropSize } = currentLayout();
  return JSON.stringify({ doubled, open, shade, playlistSize, milkdropSize });
}

// A pointer button is down: something is being dragged or resized. Refitting
// the window then would move things under the pointer, so it waits.
let pointerDown = false;
const onPointerDown = () => { pointerDown = true; };
const onPointerUp = () => { pointerDown = false; };

function watchLayout(container) {
  let last = JSON.stringify(currentLayout());
  let timer = null;
  let refitTimer = null;
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerUp, true);
  const refit = () => {
    if (!webamp) return;
    if (pointerDown) { refitTimer = setTimeout(refit, REFIT_DELAY_MS); return; }
    placeLayout(container, currentLayout());
  };
  let shape = layoutShape();
  let eqOpen = currentLayout().open.equalizer;
  unsubscribeLayout = webamp.store.subscribe(() => {
    if (!webamp) return;
    // Noted before placing: placing dispatches, which comes back here.
    const isOpen = !!webamp.store.getState().windows.genWindows.equalizer.open;
    const eqOpened = isOpen && !eqOpen;
    eqOpen = isOpen;
    if (eqOpened) placeOpenedEqualizer();

    const nowShape = layoutShape();
    if (nowShape !== shape) {
      shape = nowShape;
      clearTimeout(refitTimer);
      refitTimer = setTimeout(refit, REFIT_DELAY_MS);
    }
    const now = JSON.stringify(currentLayout());
    if (now === last) return;
    last = now;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Never persist a layout that would itself be rejected at next launch.
      if (!(container.clientWidth > 0 && container.clientHeight > 0)) return;
      const problem = layoutProblem(JSON.parse(now));
      if (problem) { log('not saving layout (' + problem + ')'); return; }
      try { localStorage.setItem(LAYOUT_KEY, now); } catch (e) { /* storage unavailable */ }
    }, SAVE_DELAY_MS);
  });
}

let mountedInto = null;
let mounting = null;
let generation = 0;

function mount(containerId) {
  if (mounted) { log('already mounted'); return Promise.resolve(true); }
  // Sign-in can be reported twice (connected, then restored); mount once.
  if (!mounting) mounting = doMount(containerId).finally(() => { mounting = null; });
  return mounting;
}

async function doMount(containerId) {
  const container = document.getElementById(containerId);
  if (!container) { log('*** container not found:', containerId); return false; }
  const gen = generation;
  await waitForSize(container);
  if (gen !== generation) return false;              // signed out while waiting

  try {
    webamp = new Webamp(OPTIONS);
  } catch (err) {
    log('*** could not construct Webamp:', err && err.message);
    return false;
  }

  // Before rendering, so Webamp centres the stack at its final height.
  webamp.store.dispatch({ type: 'WINDOW_SIZE_CHANGED', windowId: 'playlist', size: DEFAULT_PLAYLIST_SIZE });

  try {
    await webamp.renderWhenReady(container);
  } catch (err) {
    log('*** render failed:', err && err.message);
    return false;
  }

  mounted = true;
  mountedInto = containerId;
  await restoreLayout(container);
  watchLayout(container);
  attach(webamp);
  inert.attach(webamp);
  vis.attach(webamp);
  milkdrop.attach(webamp);
  frame.attach(webamp);
  skin.attach(webamp);
  ontop.attach(webamp);
  await panels.attach(webamp);
  log('rendered into #' + containerId, 'doubled =', isDoubled());
  return true;
}

function unmount() {
  generation++;
  if (!webamp) return;
  if (unsubscribeLayout) { unsubscribeLayout(); unsubscribeLayout = null; }
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('pointerup', onPointerUp, true);
  panels.detach();
  ontop.detach();
  frame.detach();
  milkdrop.detach();
  vis.detach();
  skin.detach();
  inert.detach();
  detach();
  try { webamp.dispose(); } catch (e) { /* already gone */ }
  webamp = null;
  mounted = false;
  mountedInto = null;
  log('disposed');
}

// Webamp accepts a .wsz by drag-and-drop natively; this is the same thing
// via a file picker, for testing without dragging.
async function loadSkinFile(file) {
  if (!webamp) { log('not mounted'); return false; }
  const url = URL.createObjectURL(file);
  try {
    await webamp.setSkinFromUrl(url);
    log('skin loaded:', file.name);
    return true;
  } catch (err) {
    log('*** skin load failed:', err && err.message);
    return false;
  } finally {
    // Revoke late: Webamp reads the blob asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

// Webamp's own double-size mode, the same thing as the classic Options >
// Double Size. Scaling with a CSS transform instead would desynchronise the
// WindowManager's drag coordinates from the pointer.
function isDoubled() {
  if (!webamp) return false;
  try { return !!webamp.store.getState().display.doubled; } catch (e) { return false; }
}

function setDoubleSize(on) {
  if (!webamp) return false;
  if (isDoubled() === !!on) return true;
  // The bare TOGGLE_DOUBLESIZE_MODE action resizes the windows but skips the
  // re-layout, leaving the EQ window over the main window's transport
  // buttons. Webamp only exposes the full toggle through its "D" button, so
  // press that.
  const button = document.querySelector('#webamp #button-d');
  if (!button) { log('*** double-size button not found'); return false; }
  try {
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    return isDoubled() === !!on;
  } catch (err) {
    log('*** could not toggle double size:', err && err.message);
    return false;
  }
}

function toggleDoubleSize() {
  const next = !isDoubled();
  setDoubleSize(next);
  log('double size', next ? 'on' : 'off');
  return isDoubled();
}

window.WinifyWebamp = {
  mount,
  unmount,
  isDoubled,
  setDoubleSize,
  toggleDoubleSize,
  resetLayout,
  loadSkinFile,
  isMounted: () => mounted,
  getInstance: () => webamp,
};
