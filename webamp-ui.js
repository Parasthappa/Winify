/* The Winamp face.
 *
 * Renders Webamp's classic interface inside Winify. Rendering only: no
 * playback, no visualizer data, nothing wired. Webamp's own buttons do
 * nothing yet by design.
 *
 * Built so the next stages drop in rather than require rework:
 *
 *   - OPTIONS below is the single Webamp constructor config. Connecting
 *     Spotify playback means adding __customMediaClass to it, which adapts
 *     window.WinifyPlayer's existing per-command functions to Webamp's IMedia
 *     interface. Nothing else needs to move.
 *   - Webamp's built-in visualizer will later be driven from
 *     WinifyAudio.subscribe(), because Webamp cannot read Spotify's
 *     DRM-protected audio itself.
 *   - Butterchurn attaches separately via the analyser's AudioContext.
 */
import Webamp from './node_modules/webamp/built/webamp.bundle.min.mjs';

let webamp = null;
let mounted = false;

// Classic skins are small bitmaps designed for 1998 screens. On a Retina
// display the 1x windows are tiny, so double size is the sensible default.
// Webamp already renders skin sprites with image-rendering: pixelated, so
// doubling stays blocky rather than going soft.
const DOUBLE_SIZE_BY_DEFAULT = true;

const OPTIONS = {
  // No tracks: this stage is about whether the face renders, not playback.
  initialTracks: [],
  // Chrome that makes no sense until playback exists stays hidden for now.
  availableSkins: [],
  // NEXT STAGE: __customMediaClass goes here, adapting WinifyPlayer.
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
  if (DOUBLE_SIZE_BY_DEFAULT) setDoubleSize(true);
  log('rendered into #' + containerId, 'doubled =', isDoubled());
  return true;
}

function unmount() {
  if (!webamp) return;
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
  try {
    webamp.store.dispatch({ type: 'TOGGLE_DOUBLESIZE_MODE' });
    return true;
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
