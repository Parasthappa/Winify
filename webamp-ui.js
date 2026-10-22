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

// Window positions, the playlist size and double size are remembered across
// launches, as classic Winamp did. Per-machine convenience only, so the
// browser's own storage is enough; losing it just means the default layout.
const LAYOUT_KEY = 'winify.layout.v1';
const LAYOUT_WINDOWS = ['main', 'equalizer', 'playlist'];
const SAVE_DELAY_MS = 400;

function log(...args) {
  console.log('[winify/webamp]', ...args);
}

function readLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY));
    return saved && saved.positions ? saved : null;
  } catch (e) {
    return null;
  }
}

function currentLayout() {
  const state = webamp.store.getState();
  const positions = {};
  for (const id of LAYOUT_WINDOWS) {
    const w = state.windows.genWindows[id];
    if (w) positions[id] = { x: w.position.x, y: w.position.y };
  }
  return {
    doubled: state.display.doubled,
    positions,
    playlistSize: state.windows.genWindows.playlist.size,
  };
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

// Saved positions are absolute. If Winify's window is now smaller than when
// they were saved, slide the whole group back on screen, keeping it docked.
async function keepOnScreen(container) {
  await nextFrame();
  const box = container.getBoundingClientRect();
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
  if (!saved) return;
  if (typeof saved.doubled === 'boolean') setDoubleSize(saved.doubled);
  if (Array.isArray(saved.playlistSize)) {
    webamp.store.dispatch({ type: 'WINDOW_SIZE_CHANGED', windowId: 'playlist', size: saved.playlistSize });
  }
  // Absolute, like Winamp: otherwise Webamp re-centres the group.
  webamp.store.dispatch({ type: 'UPDATE_WINDOW_POSITIONS', positions: saved.positions, absolute: true });
  await keepOnScreen(container);
  log('layout restored');
}

let unsubscribeLayout = null;
function watchLayout() {
  let last = JSON.stringify(currentLayout());
  let timer = null;
  unsubscribeLayout = webamp.store.subscribe(() => {
    if (!webamp) return;
    const now = JSON.stringify(currentLayout());
    if (now === last) return;
    last = now;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { localStorage.setItem(LAYOUT_KEY, now); } catch (e) { /* storage unavailable */ }
    }, SAVE_DELAY_MS);
  });
}

async function mount(containerId) {
  if (mounted) { log('already mounted'); return true; }
  const container = document.getElementById(containerId);
  if (!container) { log('*** container not found:', containerId); return false; }

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
  await restoreLayout(container);
  watchLayout();
  attach(webamp);
  inert.attach(webamp);
  log('rendered into #' + containerId, 'doubled =', isDoubled());
  return true;
}

function unmount() {
  if (!webamp) return;
  if (unsubscribeLayout) { unsubscribeLayout(); unsubscribeLayout = null; }
  inert.detach();
  detach();
  try { webamp.dispose(); } catch (e) { /* already gone */ }
  webamp = null;
  mounted = false;
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
  loadSkinFile,
  isMounted: () => mounted,
  getInstance: () => webamp,
};
