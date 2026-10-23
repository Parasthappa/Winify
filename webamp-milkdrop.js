/* Milkdrop: Webamp's own Milkdrop window, drawn by Butterchurn from Winify's
 * shared system-audio capture. It sends nothing over the network: Butterchurn
 * and its presets load from node_modules, the first time the window opens.
 *
 * Webamp builds one Butterchurn visualizer when the window renders, on the
 * AudioContext of the node its media class hands over. Winify's capture makes
 * a new AudioContext per capture session, so Webamp gets a stand-in (Stage)
 * with the same methods; each capture session builds a real visualizer behind
 * it, with its own connection from the shared source node:
 *
 *   shared source node --> WinifyAudio's analyser   (other consumers)
 *                      |-> Webamp's own analyser    (webamp-vis.js)
 *                      \-> Butterchurn's own nodes  (this module)
 *
 * Nothing here is connected to the audio output. Drawing stops when the window
 * is closed (Webamp unmounts it), when the music is paused (Webamp's loop
 * waits), and while Winify is hidden or minimized: Webamp's frame loop has no
 * pause of its own, so the window is then taken down ("suspended") and put
 * back when Winify is shown. It still counts as open for the saved layout,
 * Winify's window size and the menu-bar checkmark.
 *
 * Presets: a random one to start, a new random one every 30 s of showing with
 * a 5.7 s blend; Space = next, R = random, Backspace = previous (Webamp's),
 * H = next without blending (Webamp's). The name shows briefly on each change.
 */

const log = (...args) => console.log('[winify/milkdrop]', ...args);

const BUTTERCHURN = './node_modules/butterchurn/dist/butterchurn.js';
const PRESET_PACKS = [   // UMD bundles: each sets a global of its name
  { name: 'base', src: './node_modules/butterchurn-presets/dist/base.min.js' },
  { name: 'extra', src: './node_modules/butterchurn-presets/dist/extra.min.js' },
];
const config = {
  cycleMs: 30000,        // showing time between automatic changes
  nameMs: 3000,          // how long a new preset's name stays up
};
// Webamp's transition types (blend 0 s, 2.7 s, 5.7 s).
const IMMEDIATE = 0;
const DEFAULT = 1;
const USER_PRESET = 2;
// The window's size when first opened, in Webamp's 25x29 px resize segments:
// 400x290 px.
export const DEFAULT_SIZE = [5, 6];

let webamp = null;
let unsubscribeStore = null;
let unsubscribeAudio = null;
let cycleTimer = null;
let shownFor = 0;              // ms shown since the last preset change
let lastIndex = null;
let nameTimer = null;
let renders = 0;               // frames drawn, for tests
const stages = new Set();

// ---- Loading on first open -------------------------------------------------
// Webamp asks for Butterchurn and the presets as soon as it starts. They are
// over 2 MB, so the answers wait until the window first opens.

let firstOpened = null;
const opened = new Promise((resolve) => { firstOpened = resolve; });

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => { s.remove(); resolve(); };
    s.onerror = () => { s.remove(); reject(new Error('could not load ' + src)); };
    document.head.appendChild(s);
  });
}

async function getPresets() {
  await opened;
  const presets = [];
  for (const pack of PRESET_PACKS) {
    await loadScript(pack.src);
    const exported = window[pack.name];
    delete window[pack.name];
    const all = (exported && exported.default) || exported || {};
    for (const [name, preset] of Object.entries(all)) presets.push({ name, butterchurnPresetObject: preset });
  }
  log(presets.length, 'presets loaded');
  return presets;
}

async function importButterchurn() {
  await opened;
  const butterchurn = (await import(BUTTERCHURN)).default;
  return { createVisualizer: (_context, canvas, opts) => new Stage(butterchurn, canvas, opts) };
}

export const butterchurnOptions = { importButterchurn, getPresets, butterchurnOpen: false };

// ---- The stand-in Webamp draws through -------------------------------------

const audio = () => window.WinifyAudio;
const visible = () => !audio() || !audio().isVisible || audio().isVisible();

class Stage {
  constructor(butterchurn, canvas, opts) {
    this.butterchurn = butterchurn;
    this.canvas = canvas;
    this.opts = opts;
    this.size = [opts.width, opts.height];
    this.viz = null;
    this.source = null;
    this.preset = null;
    stages.add(this);
    this.build();
  }

  // A real visualizer on this capture session's context, if there is one.
  build() {
    const a = audio();
    const context = a && a.getAudioContext();
    const source = a && a.getSourceNode();
    if (!context || !source) { showNoSound(); return; }
    this.viz = this.butterchurn.createVisualizer(context, this.canvas,
      Object.assign({}, this.opts, { width: this.size[0], height: this.size[1] }));
    this.viz.connectAudio(source);   // into Butterchurn's own nodes; never to the output
    this.source = source;
    if (this.preset) this.viz.loadPreset(this.preset, 0);
    showNoSound();
    log('drawing from the shared audio source');
  }

  drop() {
    if (!this.viz) return;
    try { this.viz.disconnectAudio(this.source); } catch (e) { /* context already closed */ }
    try { this.viz.loseGLContext(); } catch (e) { /* already lost */ }
    this.viz = null;
    this.source = null;
  }

  // Butterchurn takes its own connection to the shared source in build().
  connectAudio() {}

  render() {
    if (!this.viz || !visible()) return;
    this.viz.render();
    renders++;
  }

  setRendererSize(width, height) {
    this.size = [width, height];
    if (this.viz) this.viz.setRendererSize(width, height);
  }

  loadPreset(preset, blendTime) {
    this.preset = preset;
    if (this.viz) return this.viz.loadPreset(preset, blendTime);
    return undefined;
  }

  launchSongTitleAnim(text) {
    if (this.viz) this.viz.launchSongTitleAnim(text);
  }
}

function dropStages() {
  for (const stage of stages) stage.drop();
  stages.clear();
}

// ---- Overlays: the preset's name, and "no sound" ---------------------------

function windowEl() {
  return document.querySelector('#webamp .gen-window');
}

function overlay(cls) {
  const win = windowEl();
  const canvas = win && win.querySelector('canvas');
  const host = canvas && canvas.parentElement;
  if (!host) return null;
  let el = host.querySelector(':scope > .' + cls);
  if (!el) {
    el = document.createElement('div');
    el.className = cls;
    host.appendChild(el);
  }
  return el;
}

function showNoSound() {
  requestAnimationFrame(() => {
    const el = overlay('winify-md-nosound');
    if (!el) return;
    const capturing = !!(audio() && audio().isActive());
    el.hidden = capturing;
    if (!capturing) {
      el.textContent = 'No sound to show. Milkdrop listens to your Mac’s sound through ' +
        'BlackHole: see “Optional: the visualizer” in the README.';
    }
  });
}

function showName(name) {
  const el = overlay('winify-md-name');
  if (!el) return;
  el.textContent = name;
  el.classList.add('shown');
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => el.classList.remove('shown'), config.nameMs);
}

const STYLE = `
  #webamp .gen-window canvas { background: #000; }
  #webamp .winify-md-name, #webamp .winify-md-nosound {
    position: absolute; left: 0; right: 0; pointer-events: none;
    font: 11px/1.4 Arial, Helvetica, sans-serif; color: #d6e3ef; text-align: center;
  }
  #webamp .winify-md-name {
    bottom: 6px; padding: 0 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    text-shadow: 0 0 3px #000, 0 0 2px #000; opacity: 0; transition: opacity 0.6s;
  }
  #webamp .winify-md-name.shown { opacity: 1; }
  #webamp .winify-md-nosound {
    top: 0; bottom: 0; display: flex; align-items: center; justify-content: center;
    padding: 0 24px; background: #000; color: #8c9aa8;
  }
  #webamp .winify-md-nosound[hidden] { display: none; }
`;

// ---- Presets ---------------------------------------------------------------

function md() {
  return webamp.store.getState().milkdrop;
}

function select(index, transitionType) {
  const presets = md().presets;
  if (!presets.length) return;
  const i = ((index % presets.length) + presets.length) % presets.length;
  webamp.store.dispatch({ type: 'PRESET_REQUESTED', index: i, addToHistory: true });
  webamp.store.dispatch({ type: 'SELECT_PRESET_AT_INDEX', index: i, transitionType });
}

function next(transitionType = DEFAULT) {
  const current = md().currentPresetIndex;
  select(current == null ? 0 : current + 1, transitionType);
}

function random(transitionType = DEFAULT) {
  const n = md().presets.length;
  if (!n) return;
  const current = md().currentPresetIndex;
  let i = Math.floor(Math.random() * n);
  if (n > 1 && i === current) i = (i + 1) % n;
  select(i, transitionType);
}

// Whether Webamp shows the window, and whether it is open as far as the user
// is concerned (shown, or suspended while Winify is out of sight).
const isMounted = () => {
  const w = webamp && webamp.store.getState().windows.genWindows.milkdrop;
  return !!(w && w.open);
};
let suspended = false;
export const isSuspended = () => suspended;
const isOpen = () => isMounted() || suspended;
const isPlaying = () => webamp.store.getState().media.status === 'PLAYING';
const isShowing = () => isMounted() && isPlaying() && visible() && !!(audio() && audio().isActive());

function onVisibility(shown) {
  if (!webamp) return;
  if (!shown && isMounted()) {
    suspended = true;
    webamp.store.dispatch({ type: 'TOGGLE_WINDOW', windowId: 'milkdrop' });
    log('Winify out of sight - window suspended, nothing drawn');
  } else if (shown && suspended) {
    suspended = false;
    webamp.store.dispatch({ type: 'TOGGLE_WINDOW', windowId: 'milkdrop' });
    log('Winify shown - window back');
  }
}

function tickCycle() {
  if (!webamp || !isShowing() || !md().presets.length) return;
  shownFor += 1000;
  if (shownFor >= config.cycleMs) random(USER_PRESET);
}

// ---- Keys, while the Milkdrop window has focus -----------------------------

function onKeyDown(e) {
  if (!webamp || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
  if (e.key === 'Escape' && document.fullscreenElement) {
    document.exitFullscreen();
    return;
  }
  if (!isOpen() || webamp.store.getState().windows.focused !== 'milkdrop') return;
  if (e.key === ' ') next();
  else if (e.key === 'r' || e.key === 'R') random();
  else if (e.keyCode === 145 || e.keyCode === 125) { /* Webamp's own 15 s cycling: Winify cycles */ }
  else return;
  e.preventDefault();
  e.stopPropagation();
}

// Webamp's right-click menu offers Desktop Mode, which would draw behind
// Winify's small window; it is hidden (and the action ignored below).
function onContextMenu(e) {
  if (!(e.target instanceof Element) || !e.target.closest('#webamp .gen-window')) return;
  requestAnimationFrame(() => {
    for (const li of document.querySelectorAll('#webamp .context-menu li')) {
      if (/^Desktop Mode/.test(li.textContent.trim())) li.style.display = 'none';
    }
  });
}

// ---- Webamp middleware -------------------------------------------------------
// Winify's choices stand: no desktop mode, its own random-every-30-s cycling
// (Webamp's is every 15 s), presets in list order for Space.

export const middleware = (store) => (nextMw) => (action) => {
  if (action.type === 'SET_MILKDROP_DESKTOP' && action.enabled) return undefined;
  if ((action.type === 'TOGGLE_PRESET_CYCLING' || action.type === 'TOGGLE_RANDOMIZE_PRESETS') && !action.winify) return undefined;
  const result = nextMw(action);
  if (action.type === 'GOT_BUTTERCHURN_PRESETS') {
    // Webamp has picked a random first preset; from here on Winify decides.
    const m = store.getState().milkdrop;
    if (m.randomize) nextMw({ type: 'TOGGLE_RANDOMIZE_PRESETS', winify: true });
    if (m.cycling) nextMw({ type: 'TOGGLE_PRESET_CYCLING', winify: true });
  }
  return result;
};

// ---- The V button and the menu-bar item --------------------------------------

// While Winify is out of sight, opening only marks it open (it appears when
// Winify is shown) and closing a suspended window just forgets it. Webamp's
// store hears of either through an action of Winify's own, which its
// reducers ignore, so the layout is saved and the menu updated.
export function toggle() {
  if (!webamp) return false;
  if (suspended || (!isMounted() && !visible())) {
    suspended = !suspended;
    webamp.store.dispatch({ type: 'WINIFY_MILKDROP_SUSPENDED', suspended });
  } else {
    webamp.store.dispatch({ type: 'TOGGLE_WINDOW', windowId: 'milkdrop' });
  }
  return isOpen();
}

function onClickCapture(e) {
  if (!webamp || !(e.target instanceof Element)) return;
  if (e.target.closest('#webamp #button-v')) toggle();
}

function paintButton() {
  const button = document.querySelector('#webamp #button-v');
  if (!button) return;
  button.classList.toggle('selected', isOpen());
  if (!button.title) button.title = 'Milkdrop visualizer';
}

// ---- Lifecycle ---------------------------------------------------------------

let styleEl = null;
let listeningForVisibility = false;

export function attach(instance) {
  webamp = instance;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.textContent = STYLE;
    document.head.appendChild(styleEl);
  }
  let wasOpen = isOpen();
  let wasMounted = isMounted();
  if (wasOpen) firstOpened();
  unsubscribeStore = webamp.store.subscribe(() => {
    if (!webamp) return;
    const mounted = isMounted();
    if (mounted !== wasMounted) {
      wasMounted = mounted;
      if (mounted) showNoSound(); else dropStages();
    }
    const open = isOpen();
    if (open !== wasOpen) {
      wasOpen = open;
      if (open) firstOpened();
      log(open ? 'window opened' : 'window closed - drawing stopped');
      if (window.spotify && window.spotify.milkdropStateChanged) window.spotify.milkdropStateChanged(open);
    }
    const index = md().currentPresetIndex;
    if (index !== lastIndex) {
      lastIndex = index;
      shownFor = 0;
      const preset = index == null ? null : md().presets[index];
      if (preset && mounted) showName(preset.name);
    }
    paintButton();
  });
  paintButton();
  const a = audio();
  if (a) {
    unsubscribeAudio = a.onEvent((event) => {
      if (event === 'started') { for (const s of stages) { s.drop(); s.build(); } }
      else if (event === 'stopped' || event === 'ended' || event === 'error') {
        for (const s of stages) s.drop();
        showNoSound();
      }
    });
  }
  // The preload's listeners cannot be removed, so register once per page.
  if (!listeningForVisibility && window.spotify && window.spotify.onVisibility) {
    window.spotify.onVisibility(onVisibility);
    listeningForVisibility = true;
  }
  if (audio() && audio().isVisible && !audio().isVisible()) onVisibility(false);
  cycleTimer = setInterval(tickCycle, 1000);
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('contextmenu', onContextMenu, true);
  if (window.spotify && window.spotify.milkdropStateChanged) window.spotify.milkdropStateChanged(isOpen());
}

export function detach() {
  if (unsubscribeStore) { unsubscribeStore(); unsubscribeStore = null; }
  if (unsubscribeAudio) { unsubscribeAudio(); unsubscribeAudio = null; }
  clearInterval(cycleTimer);
  clearTimeout(nameTimer);
  document.removeEventListener('click', onClickCapture, true);
  document.removeEventListener('keydown', onKeyDown, true);
  document.removeEventListener('contextmenu', onContextMenu, true);
  dropStages();
  webamp = null;
  lastIndex = null;
  suspended = false;
}

window.WinifyMilkdrop = {
  toggle,
  isOpen,
  next: () => next(),
  random: () => random(),
  config,
  state: () => {
    const m = webamp ? md() : null;
    return {
      open: isOpen(),
      loaded: !!(m && m.butterchurn),
      presets: m ? m.presets.length : 0,
      index: m ? m.currentPresetIndex : null,
      name: m && m.currentPresetIndex != null && m.presets[m.currentPresetIndex] ? m.presets[m.currentPresetIndex].name : null,
      stages: stages.size,
      drawing: [...stages].some((s) => !!s.viz),
      renders,
      shownFor,
      randomize: m ? m.randomize : null,
      cycling: m ? m.cycling : null,
    };
  },
};
