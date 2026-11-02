/* Webamp's built-in visualizer, fed from Winify's shared audio capture.
 *
 * Webamp's visualizer draws from whatever its media class returns from
 * getAnalyser(), asked for once when the main window renders. Spotify's audio
 * is DRM-protected, so the data comes from window.WinifyAudio's system-audio
 * capture instead.
 *
 * WinifyAudio creates a new AudioContext each time capture starts and closes
 * it on stop, and a node cannot outlive or cross contexts. So Webamp gets a
 * stable handle (analyserHandle below), and each capture session gives it a
 * fresh AnalyserNode of its own in the shared context:
 *
 *   shared source node --> WinifyAudio's analyser   (other consumers)
 *                      \-> Webamp's own analyser    (this module)
 *
 * Webamp's own node means its settings (it sets fftSize to 1024) cannot
 * change what anything else receives. Nothing here is connected to the audio
 * output, which would feed captured audio back into the loopback device.
 *
 * The handle provides what Webamp's visualizer reads (fftSize,
 * frequencyBinCount, getByteTimeDomainData) and reports silence while there
 * is no capture. It is not a real AudioNode; Webamp's Milkdrop window, which
 * would want one, gets its audio separately (webamp-milkdrop.js).
 */

const log = (...args) => console.log('[winify/vis]', ...args);

let node = null;                    // this session's AnalyserNode, or null
let fftSize = 2048;                 // Webamp sets 1024 when it renders
let smoothing = 0;                  // as Webamp's own media class: no smoothing
let unsubscribeAudio = null;

function connect() {
  const audio = window.WinifyAudio;
  const context = audio && audio.getAudioContext();
  const source = audio && audio.getSourceNode();
  if (!context || !source) return;
  node = context.createAnalyser();
  node.fftSize = fftSize;
  node.smoothingTimeConstant = smoothing;
  source.connect(node);             // input only: never to context.destination
  log('connected to the shared audio source (fftSize ' + fftSize + ')');
  lastRoute = null;
  checkOutputRoute();
}

function disconnect(reason) {
  if (!node) return;
  // The context is closed by WinifyAudio on stop; dropping the node is enough.
  node = null;
  log('audio source gone (' + reason + ') - visualizer idle');
}

// What Webamp holds on to. Reads go to this session's node, or are silent.
export const analyserHandle = {
  get fftSize() { return fftSize; },
  set fftSize(n) { fftSize = n; if (node) node.fftSize = n; },
  get frequencyBinCount() { return fftSize / 2; },
  get smoothingTimeConstant() { return smoothing; },
  set smoothingTimeConstant(v) { smoothing = v; if (node) node.smoothingTimeConstant = v; },
  getByteTimeDomainData(array) {
    if (node) node.getByteTimeDomainData(array); else array.fill(128);   // 128 = silence
  },
  getByteFrequencyData(array) {
    if (node) node.getByteFrequencyData(array); else array.fill(0);
  },
  getFloatTimeDomainData(array) {
    if (node) node.getFloatTimeDomainData(array); else array.fill(0);
  },
  getFloatFrequencyData(array) {
    if (node) node.getFloatFrequencyData(array); else array.fill(-Infinity);
  },
};

export function isLive() {
  return !!node;
}

// Capture can be running on BlackHole and still hear nothing: BlackHole only
// receives what macOS sends it, which takes the Multi-Output Device being the
// system output. That looks like a broken visualizer, so say what is wrong.
// Chromium names the current default output ("Default - <device>").
const ROUTES_TO_LOOPBACK = /multi-?output|blackhole|loopback|aggregate|soundflower/i;
let lastRoute = null;

async function checkOutputRoute() {
  if (!node || !navigator.mediaDevices) return;
  let label = '(unknown)';
  try {
    const out = (await navigator.mediaDevices.enumerateDevices())
      .find((d) => d.kind === 'audiooutput' && d.deviceId === 'default');
    if (out && out.label) label = out.label.replace(/^Default - /, '');
  } catch (e) { /* cannot tell; say nothing */ return; }
  if (label === lastRoute) return;
  lastRoute = label;
  if (ROUTES_TO_LOOPBACK.test(label)) {
    log('system output is "' + label + '" - music reaches the loopback device');
  } else {
    log('*** system output is "' + label + '", not the Multi-Output Device: BlackHole hears ' +
      'nothing, so the visualizer stays empty. Choose the Multi-Output Device in ' +
      'System Settings > Sound > Output.');
  }
}

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => { checkOutputRoute(); });
}

// ---- Pausing the drawing while Winify is hidden -----------------------------
// Webamp's visualizer loop has no pause of its own; it stops drawing when its
// style is "off". So while hidden the style is switched to off, and the
// chosen style comes back when Winify is shown. Capture keeps running.

const VISUALIZER_STYLES = 3;        // bars, oscilloscope, off (Webamp's order)
const OFF = 2;
let webamp = null;
let styleBeforeHiding = null;
let listeningForVisibility = false;
let unsubscribeOverlay = null;

function style() {
  return webamp.store.getState().display.visualizerStyle;
}

function setStyle(target) {
  // Webamp only offers a toggle that steps through the three styles.
  let guard = VISUALIZER_STYLES;
  while (style() !== target && guard-- > 0) {
    webamp.store.dispatch({ type: 'TOGGLE_VISUALIZER_STYLE' });
  }
}

function onVisibility(visible) {
  if (!webamp) return;
  if (!visible && styleBeforeHiding === null) {
    styleBeforeHiding = style();
    setStyle(OFF);
  } else if (visible && styleBeforeHiding !== null) {
    setStyle(styleBeforeHiding);
    styleBeforeHiding = null;
  }
}

// ---- The small visualizer while Milkdrop is open ----------------------------
// Webamp reports its visualizer mode as "Milkdrop" whenever its Milkdrop window
// is open, and paints nothing on the small visualizer in that mode; its window
// only draws in that mode too, so the two cannot be separated from outside. So
// while Milkdrop is open, bars and oscilloscope are drawn here, from the same
// analyser and the skin's own colours, on a canvas laid over Webamp's. Clicks
// pass through to Webamp's canvas, so clicking still cycles the style.

const STYLE_BARS = 0, STYLE_OSCILLOSCOPE = 1;
const BARS = 19;
const BAR_FALL = 0.7, PEAK_FALL = 0.15;     // pixels per frame
let overlay = null;
let overlayLoop = null;
let bars = [];
let peaks = [];

function milkdropOpen(state) {
  const m = state.windows.genWindows.milkdrop;
  return !!(m && m.open);
}

function paintBars(g, colors, w, h) {
  const data = new Uint8Array(analyserHandle.frequencyBinCount);
  analyserHandle.getByteFrequencyData(data);
  for (let i = 0; i < BARS; i++) {
    // Evenly spaced by pitch, as a spectrum sounds, up to about 16 kHz.
    const from = Math.floor(Math.pow(data.length * 0.75, i / BARS));
    const to = Math.max(from + 1, Math.floor(Math.pow(data.length * 0.75, (i + 1) / BARS)));
    let level = 0;
    for (let k = from; k < to; k++) level = Math.max(level, data[k]);
    bars[i] = Math.max((level / 255) * h, (bars[i] || 0) - BAR_FALL);
    peaks[i] = Math.max(bars[i], (peaks[i] || 0) - PEAK_FALL);
    const x = i * 4;
    for (let y = 0; y < Math.round(bars[i]); y++) {
      // Row 0 is the bottom; the skin's colours 2-17 run from the top down.
      g.fillStyle = colors[17 - Math.floor((y / h) * 16)];
      g.fillRect(x, h - 1 - y, 3, 1);
    }
    if (peaks[i] >= 1) {
      g.fillStyle = colors[23];
      g.fillRect(x, h - 1 - Math.min(h - 1, Math.round(peaks[i])), 3, 1);
    }
  }
}

function paintOscilloscope(g, colors, w, h) {
  const data = new Uint8Array(fftSize);
  analyserHandle.getByteTimeDomainData(data);
  const row = (i) => Math.max(0, Math.min(h - 1, Math.floor((data[i * 7] / 256) * h)));
  let last = row(0);
  for (let x = 0; x < Math.min(w, 75); x++) {
    const y = row(x);
    const top = Math.min(y, last), height = Math.abs(y - last) + 1;
    // Brightest in the middle (the skin's colours 18-22).
    g.fillStyle = colors[18 + Math.min(4, Math.floor(Math.abs(y - h / 2) / (h / 10)))];
    g.fillRect(x, top, 1, height);
    last = y;
  }
}

function removeOverlay() {
  if (overlayLoop !== null) cancelAnimationFrame(overlayLoop);
  overlayLoop = null;
  if (overlay) overlay.remove();
  overlay = null;
  bars = [];
  peaks = [];
}

function drawOverlay() {
  overlayLoop = null;
  if (!webamp) return;
  const state = webamp.store.getState();
  const under = document.querySelector('#webamp #visualizer');
  if (!under || !milkdropOpen(state)) { removeOverlay(); return; }
  if (!overlay || overlay.parentElement !== under.parentElement) {
    if (overlay) overlay.remove();
    overlay = document.createElement('canvas');
    overlay.id = 'winify-small-vis';
    overlay.style.cssText = 'position: absolute; pointer-events: none; image-rendering: pixelated;';
    under.parentElement.appendChild(overlay);
  }
  if (overlay.width !== under.width || overlay.height !== under.height) { overlay.width = under.width; overlay.height = under.height; }
  overlay.style.left = under.offsetLeft + 'px';
  overlay.style.top = under.offsetTop + 'px';
  overlay.style.width = under.style.width;
  overlay.style.height = under.style.height;
  // Paused holds the last picture, as Webamp's own drawing does.
  if (state.media.status === 'PLAYING') {
    const g = overlay.getContext('2d');
    g.clearRect(0, 0, overlay.width, overlay.height);
    if (style() === STYLE_BARS) paintBars(g, state.display.skinColors, overlay.width, overlay.height);
    else if (style() === STYLE_OSCILLOSCOPE) paintOscilloscope(g, state.display.skinColors, overlay.width, overlay.height);
  }
  overlayLoop = requestAnimationFrame(drawOverlay);
}

function watchOverlay() {
  if (webamp && overlayLoop === null && milkdropOpen(webamp.store.getState()) && document.querySelector('#webamp #visualizer')) {
    overlayLoop = requestAnimationFrame(drawOverlay);
  }
}

// ---- Lifecycle --------------------------------------------------------------

export function attach(instance) {
  webamp = instance;
  unsubscribeOverlay = webamp.store.subscribe(watchOverlay);
  watchOverlay();
  const audio = window.WinifyAudio;
  if (audio) {
    if (audio.isActive()) connect();
    unsubscribeAudio = audio.onEvent((event, detail) => {
      if (event === 'started') connect();
      else if (event === 'stopped' || event === 'ended') disconnect(event);
      else if (event === 'error') {
        disconnect('error');
        log('no system audio to visualize (' + ((detail && detail.message) || 'capture failed') +
          ') - the visualizer stays empty; playback is unaffected');
      }
    });
  }
  // The preload's listeners cannot be removed, so register once per page;
  // onVisibility ignores events while nothing is attached.
  if (!listeningForVisibility && window.spotify && window.spotify.onVisibility) {
    window.spotify.onVisibility(onVisibility);
    listeningForVisibility = true;
  }
  // The window may already be hidden (a remembered sign-in with it tucked away).
  if (audio && audio.isVisible && !audio.isVisible()) onVisibility(false);
}

export function detach() {
  if (unsubscribeAudio) { unsubscribeAudio(); unsubscribeAudio = null; }
  if (unsubscribeOverlay) { unsubscribeOverlay(); unsubscribeOverlay = null; }
  removeOverlay();
  node = null;
  webamp = null;
  styleBeforeHiding = null;
}
