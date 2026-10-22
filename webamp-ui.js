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

let webamp = null;
let mounted = false;

// Classic skins are small bitmaps designed for 1998 screens. On a Retina
// display the 1x windows are tiny, so double size is the sensible default.
// Webamp already renders skin sprites with image-rendering: pixelated, so
// doubling stays blocky rather than going soft.
const DOUBLE_SIZE_BY_DEFAULT = true;

const OPTIONS = {
  // No tracks: the playlist holds one stand-in entry that mirrors Spotify,
  // added by webamp-spotify.js. Real playlist contents are a later stage.
  initialTracks: [],
  availableSkins: [],
  // Private Webamp options; the version is pinned in package.json because
  // of them, and attach() verifies they took effect.
  __customMediaClass: SpotifyMedia,
  __customMiddlewares: [middleware],
  handleTrackDropEvent,
  // LIST OPTS > load list opens the playlist picker; returning null leaves
  // Webamp's playlist alone (the picker plays the choice itself).
  handleLoadListEvent: () => { openPicker(); return null; },
  handleAddUrlEvent: inert.handleAddUrlEvent,
  handleSaveListEvent: inert.handleSaveListEvent,
  // Webamp's own double-size path: it resizes the windows and then re-lays
  // out the stack so they still dock edge to edge.
  enableDoubleSizeMode: DOUBLE_SIZE_BY_DEFAULT,
};

// The playlist window's default height: 4 extra 29px segments, about 12
// rows, instead of Webamp's 4. Also exactly the main window's doubled height.
const DEFAULT_PLAYLIST_SIZE = [0, 4];

// Window positions, shade, the playlist size and double size are remembered across
// launches, as classic Winamp did. Per-machine convenience only, so the
// browser's own storage is enough; losing it just means the default layout.
const LAYOUT_KEY = 'winify.layout.v1';
const LAYOUT_WINDOWS = ['main', 'equalizer', 'playlist'];
const SAVE_DELAY_MS = 400;

function log(...args) {
  console.log('[winify/webamp]', ...args);
}

function readLayout() {
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
  for (const id of LAYOUT_WINDOWS) shade[id] = !!state.windows.genWindows[id].shade;
  return {
    doubled: state.display.doubled,
    positions,
    playlistSize: state.windows.genWindows.playlist.size,
    // Shaded windows are 14px tall, so positions only make sense with these.
    shade,
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

// Pixel sizes of the three windows for a layout, as Webamp draws them.
// Main and equalizer double; the playlist grows by 25x29 px segments instead.
function windowSizes(doubled, playlistSize, shade = {}) {
  const k = doubled ? 2 : 1;
  const [pw, ph] = playlistSize || [0, 0];
  return {
    main: { w: 275 * k, h: (shade.main ? 14 : 116) * k },
    equalizer: { w: 275 * k, h: (shade.equalizer ? 14 : 116) * k },
    playlist: { w: 275 + 25 * pw, h: shade.playlist ? 14 : 116 + 29 * ph },
  };
}

// Why a layout cannot be used, or null if it can. Invalid means a window is
// missing, wholly off screen, or mostly covering another one.
function layoutProblem(layout, container) {
  const pos = layout && layout.positions;
  if (!pos) return 'no positions';
  for (const id of LAYOUT_WINDOWS) {
    if (!pos[id] || !Number.isFinite(pos[id].x) || !Number.isFinite(pos[id].y)) return id + ' window missing';
  }
  const sizes = windowSizes(layout.doubled, layout.playlistSize, layout.shade);
  const rect = (id) => ({ l: pos[id].x, t: pos[id].y, r: pos[id].x + sizes[id].w, b: pos[id].y + sizes[id].h });
  const W = container.clientWidth;
  const H = container.clientHeight;
  for (const id of LAYOUT_WINDOWS) {
    const r = rect(id);
    if (r.r <= 0 || r.b <= 0 || r.l >= W || r.t >= H) return id + ' window is off screen';
  }
  for (let i = 0; i < LAYOUT_WINDOWS.length; i++) {
    for (let j = i + 1; j < LAYOUT_WINDOWS.length; j++) {
      const a = rect(LAYOUT_WINDOWS[i]);
      const b = rect(LAYOUT_WINDOWS[j]);
      const overlap = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) *
        Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
      const smaller = Math.min((a.r - a.l) * (a.b - a.t), (b.r - b.l) * (b.b - b.t));
      if (overlap > smaller * 0.5) return LAYOUT_WINDOWS[i] + ' and ' + LAYOUT_WINDOWS[j] + ' windows overlap';
    }
  }
  return null;
}

// The default docked layout: main on top, equalizer below it, playlist below
// that, left edges aligned, the stack centred in Winify's window.
function applyDefaultLayout(container) {
  setDoubleSize(DOUBLE_SIZE_BY_DEFAULT);
  const state = webamp.store.getState();
  for (const id of LAYOUT_WINDOWS) {
    const w = state.windows.genWindows[id];
    if (!w.open) webamp.store.dispatch({ type: 'TOGGLE_WINDOW', windowId: id });
    if (w.shade) webamp.store.dispatch({ type: 'TOGGLE_WINDOW_SHADE_MODE', windowId: id });
  }
  webamp.store.dispatch({ type: 'WINDOW_SIZE_CHANGED', windowId: 'playlist', size: DEFAULT_PLAYLIST_SIZE });
  const sizes = windowSizes(isDoubled(), DEFAULT_PLAYLIST_SIZE);
  const width = Math.max(sizes.main.w, sizes.equalizer.w, sizes.playlist.w);
  const height = sizes.main.h + sizes.equalizer.h + sizes.playlist.h;
  const x = Math.max(0, Math.round((container.clientWidth - width) / 2));
  const y = Math.max(0, Math.round((container.clientHeight - height) / 2));
  webamp.store.dispatch({
    type: 'UPDATE_WINDOW_POSITIONS',
    positions: {
      main: { x, y },
      equalizer: { x, y: y + sizes.main.h },
      playlist: { x, y: y + sizes.main.h + sizes.equalizer.h },
    },
    absolute: true,
  });
}

// Saved positions are absolute. If Winify's window is now smaller than when
// they were saved, slide the whole group back on screen, keeping it docked.
async function keepOnScreen(container) {
  await nextFrame();
  const box = container.getBoundingClientRect();
  if (!(box.width > 0 && box.height > 0)) return;
  const rects = LAYOUT_WINDOWS
    .map((id) => document.querySelector('#webamp #' + (id === 'main' ? 'main-window' : id + '-window')))
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
  const saved = readLayout();
  if (!saved) { applyDefaultLayout(container); return; }
  const problem = layoutProblem(saved, container);
  if (problem) {
    log('saved layout unusable (' + problem + ') - using the default layout');
    try { localStorage.removeItem(LAYOUT_KEY); } catch (e) { /* storage unavailable */ }
    applyDefaultLayout(container);
    return;
  }
  if (typeof saved.doubled === 'boolean') setDoubleSize(saved.doubled);
  if (Array.isArray(saved.playlistSize)) {
    webamp.store.dispatch({ type: 'WINDOW_SIZE_CHANGED', windowId: 'playlist', size: saved.playlistSize });
  }
  const genWindows = webamp.store.getState().windows.genWindows;
  for (const id of LAYOUT_WINDOWS) {
    if (saved.shade && !!saved.shade[id] !== !!genWindows[id].shade) {
      webamp.store.dispatch({ type: 'TOGGLE_WINDOW_SHADE_MODE', windowId: id });
    }
  }
  // Absolute, like Winamp: otherwise Webamp re-centres the group.
  webamp.store.dispatch({ type: 'UPDATE_WINDOW_POSITIONS', positions: saved.positions, absolute: true });
  await keepOnScreen(container);
  log('layout restored');
}

// Menu bar > Reset window layout: forget the saved layout and go back to the
// default docked stack, reopening and unshading any window that needs it.
function resetLayout() {
  try { localStorage.removeItem(LAYOUT_KEY); } catch (e) { /* storage unavailable */ }
  if (!webamp || !mounted) { log('layout reset (applies at next sign-in)'); return; }
  applyDefaultLayout(document.getElementById(mountedInto));
  log('layout reset to default');
}

let unsubscribeLayout = null;
function watchLayout(container) {
  let last = JSON.stringify(currentLayout());
  let timer = null;
  unsubscribeLayout = webamp.store.subscribe(() => {
    if (!webamp) return;
    const now = JSON.stringify(currentLayout());
    if (now === last) return;
    last = now;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Never persist a layout that would itself be rejected at next launch.
      if (!(container.clientWidth > 0 && container.clientHeight > 0)) return;
      const problem = layoutProblem(JSON.parse(now), container);
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
  log('rendered into #' + containerId, 'doubled =', isDoubled());
  return true;
}

function unmount() {
  generation++;
  if (!webamp) return;
  if (unsubscribeLayout) { unsubscribeLayout(); unsubscribeLayout = null; }
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
