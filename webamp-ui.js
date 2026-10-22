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
  // Webamp's own double-size path: it resizes the windows and then re-lays
  // out the stack so they still dock edge to edge.
  enableDoubleSizeMode: DOUBLE_SIZE_BY_DEFAULT,
};

function log(...args) {
  console.log('[winify/webamp]', ...args);
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

  try {
    await webamp.renderWhenReady(container);
  } catch (err) {
    log('*** render failed:', err && err.message);
    return false;
  }

  mounted = true;
  attach(webamp);
  log('rendered into #' + containerId, 'doubled =', isDoubled());
  return true;
}

function unmount() {
  if (!webamp) return;
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
