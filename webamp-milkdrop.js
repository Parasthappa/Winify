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
 * Presets: a random one to start, then (auto-cycle, on unless turned off) a
 * new random one every 30 s of showing, with a 5.7 s blend. With the window
 * focused: Space = next, Backspace = previous (back through those shown),
 * R = random, C = auto-cycle, F = full screen (Escape leaves), O = load
 * presets; H = next without blending and L = the preset list are Webamp's.
 * The same, with the keys shown, are on the window's right-click menu. The
 * name shows briefly on each change (and they are in Webamp's preset list,
 * L). Presets you add are in
 * webamp-milkdrop-presets.js.
 *
 * The playlist window's LIST OPTS button is VIZ here: it opens and closes
 * this window, like the V button.
 */

import * as yours from './webamp-milkdrop-presets.js';
import * as panels from './webamp-panels.js';

const log = (...args) => console.log('[winify/milkdrop]', ...args);

const BUTTERCHURN = './node_modules/butterchurn/dist/butterchurn.js';
const PRESET_PACKS = [   // UMD bundles: each sets a global of its name
  { name: 'base', src: './node_modules/butterchurn-presets/dist/base.min.js' },
  { name: 'extra', src: './node_modules/butterchurn-presets/dist/extra.min.js' },
];
const SETTINGS_KEY = 'winify.milkdrop.v1';
const config = {
  autoCycle: true,       // remembered; the menu's Auto-cycle
  cycleMs: 30000,        // showing time between automatic changes
  nameMs: 3000,          // how long a new preset's name stays up
  noteMs: 6000,          // how long a note about loaded presets stays up
};
try { const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)); if (saved && typeof saved.autoCycle === 'boolean') config.autoCycle = saved.autoCycle; } catch (e) { /* none */ }
// Webamp's transition types (blend 0 s, 2.7 s, 5.7 s).
const IMMEDIATE = 0;
const DEFAULT = 1;
const USER_PRESET = 2;
// The window's size when first opened, in Webamp's 25x29 px resize segments:
// 400x377 px, the side panels' height (webamp-panels.js).
export const DEFAULT_SIZE = [5, 9];
const DEFAULT_WIDTH = 275 + 25 * DEFAULT_SIZE[0];

let webamp = null;
let unsubscribeStore = null;
let unsubscribeAudio = null;
let cycleTimer = null;
let shownFor = 0;              // ms shown since the last preset change
let lastIndex = null;
let nameTimer = null;
let renders = 0;               // frames drawn, for tests
let noteTimer = null;
let builtInNames = [];
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
  builtInNames = presets.map((p) => p.name);
  const mine = await yours.saved();
  for (const { name, preset } of mine) presets.push({ name, butterchurnPresetObject: preset });
  log(presets.length, 'presets loaded (' + mine.length + ' of them yours)');
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

// A short note about presets just loaded, top of the window: not a pop-up.
function showNote(text) {
  const el = overlay('winify-md-note');
  if (!el) return;
  el.textContent = text;
  el.classList.add('shown');
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => el.classList.remove('shown'), config.noteMs);
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
  #webamp .winify-md-note {
    position: absolute; left: 0; right: 0; top: 4px; padding: 0 8px; pointer-events: none;
    font: 10px/1.35 Arial, Helvetica, sans-serif; color: #d6e3ef; text-shadow: 0 0 3px #000, 0 0 2px #000;
    max-height: 5.4em; overflow: hidden; opacity: 0; transition: opacity 0.6s;
  }
  #webamp .winify-md-note.shown { opacity: 1; }
  #webamp #playlist-list-menu ul, #webamp #playlist-list-menu .bar { display: none; }
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

// Back through the presets actually shown (Webamp's history of them).
function previous(transitionType = DEFAULT) {
  const history = md().presetHistory;
  if (history.length < 2) return;
  const i = history[history.length - 2];
  webamp.store.dispatch({ type: 'PRESET_REQUESTED', index: i, addToHistory: false });
  webamp.store.dispatch({ type: 'SELECT_PRESET_AT_INDEX', index: i, transitionType });
}

function setAutoCycle(on) {
  config.autoCycle = !!on;
  shownFor = 0;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ autoCycle: config.autoCycle })); } catch (e) { /* storage unavailable */ }
  showNote('Auto-cycle ' + (config.autoCycle ? 'on' : 'off'));
}

const isFullscreen = () => md().display === 'FULLSCREEN';

function toggleFullscreen() {
  if (isFullscreen() || document.fullscreenElement) {
    if (document.fullscreenElement) document.exitFullscreen();
    else webamp.store.dispatch({ type: 'SET_MILKDROP_FULLSCREEN', enabled: false });
  } else {
    webamp.store.dispatch({ type: 'SET_MILKDROP_FULLSCREEN', enabled: true });
  }
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
  if (!webamp || !config.autoCycle || !isShowing() || !md().presets.length) return;
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
  if (!isMounted() || webamp.store.getState().windows.focused !== 'milkdrop') return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === ' ') next();
  else if (k === 'Backspace') previous();
  else if (k === 'r') random();
  else if (k === 'c') setAutoCycle(!config.autoCycle);
  else if (k === 'f') toggleFullscreen();
  else if (k === 'o') choosePresets();
  else if (e.keyCode === 145 || e.keyCode === 125) { /* Webamp's own 15 s cycling: Winify cycles */ }
  else return;
  e.preventDefault();
  e.stopPropagation();
}

// ---- The right-click menu ------------------------------------------------------
// Webamp's own (Fullscreen, Desktop Mode, Quit), extended: once Webamp has put
// it up, Winify's items go in at the top, in Webamp's markup (li, span.hotkey,
// li.hr, li.checked) so its stylesheet draws them; Webamp's Fullscreen and
// Desktop Mode are hidden (Winify's full-screen item shows its keys), and its
// separator and Quit stay at the end.

let menuForMilkdrop = false;
let menuWatch = null;

function onContextMenu(e) {
  menuForMilkdrop = !!(webamp && e.target instanceof Element && e.target.closest('#webamp .gen-window'));
}

function menuItems() {
  const full = isFullscreen();
  return [
    { label: full ? 'Exit full screen' : 'Full screen', hotkey: full ? 'Esc' : 'F', action: toggleFullscreen },
    { sep: true },
    { label: 'Next preset', hotkey: 'Space', action: () => next() },
    { label: 'Previous preset', hotkey: 'Backspace', action: () => previous(), disabled: md().presetHistory.length < 2 },
    { label: 'Random preset', hotkey: 'R', action: () => random() },
    { sep: true },
    { label: 'Auto-cycle', hotkey: 'C', action: () => setAutoCycle(!config.autoCycle), checked: config.autoCycle },
    { sep: true },
    { label: 'Load presets\u2026', hotkey: 'O', action: choosePresets },
  ];
}

function extendMenu(container) {
  const ul = container.querySelector('ul.context-menu');
  if (!ul || ul.dataset.winify) return;
  ul.dataset.winify = '1';
  for (const li of ul.querySelectorAll(':scope > li')) {
    if (/^(Fullscreen|Desktop Mode)$/.test(li.textContent.trim())) li.style.display = 'none';
  }
  const first = ul.firstChild;
  for (const item of menuItems()) {
    const li = document.createElement('li');
    if (item.sep) {
      li.className = 'hr';
      li.appendChild(document.createElement('hr'));
    } else {
      li.appendChild(document.createTextNode(item.label));
      const hk = document.createElement('span');
      hk.className = 'hotkey';
      hk.textContent = item.hotkey;
      li.appendChild(hk);
      if (item.checked) li.classList.add('checked');
      if (item.disabled) li.style.opacity = '0.5';
      li.dataset.winifyItem = item.label;
      // Webamp closes the menu on the click itself. A menu item lies outside
      // the window, which takes Webamp's focus away: give it back so the keys
      // keep working.
      li.addEventListener('click', () => {
        if (item.disabled) return;
        webamp.store.dispatch({ type: 'SET_FOCUSED_WINDOW', window: 'milkdrop' });
        item.action();
      });
    }
    ul.insertBefore(li, first);
  }
  // In full screen only the full-screen element is drawn: the menu goes in
  // there while it is open (see removeChild below).
  if (document.fullscreenElement && container.parentNode !== document.fullscreenElement) {
    document.fullscreenElement.appendChild(container);
  }
}

// Webamp adds its menu's container to <body> and takes it out with
// document.body.removeChild. One moved into the full-screen element is taken
// out from there instead; everything else goes through unchanged.
function allowMovedMenu() {
  const body = document.body;
  if (body.removeChild.winify) return;
  const original = body.removeChild;
  const removeChild = function (node) {
    if (node && node.id === 'webamp-context-menu' && node.parentNode && node.parentNode !== body) {
      node.parentNode.removeChild(node);
      return node;
    }
    return original.call(this, node);
  };
  removeChild.winify = true;
  body.removeChild = removeChild;
}

function watchMenus() {
  allowMovedMenu();
  menuWatch = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.id === 'webamp-context-menu' && menuForMilkdrop) { menuForMilkdrop = false; extendMenu(n); }
      }
    }
  });
  menuWatch.observe(document.body, { childList: true });
}

// ---- Loading presets ---------------------------------------------------------------

async function loadPresetFiles(files, skippedBefore = []) {
  if (!webamp) return { added: [], skipped: skippedBefore };
  const { added, skipped } = await yours.add(files, builtInNames);
  skipped.unshift(...skippedBefore);
  const m = md();
  if (m.presets.length) {
    // Already in the list (the same file loaded again): updated in place.
    const fresh = [];
    for (const a of added) {
      const at = a.replaces ? m.presets.findIndex((p) => p.name === a.name) : -1;
      if (at >= 0) webamp.store.dispatch({ type: 'RESOLVE_PRESET_AT_INDEX', index: at, json: a.preset });
      else fresh.push(a);
    }
    const first = m.presets.length;
    if (fresh.length) {
      webamp.store.dispatch({ type: 'GOT_BUTTERCHURN_PRESETS', presets: fresh.map((a) => ({ type: 'RESOLVED', name: a.name, preset: a.preset })) });
    }
    if (added.length) {
      const showFirst = fresh.length ? first : md().presets.findIndex((p) => p.name === added[0].name);
      if (showFirst >= 0) select(showFirst, DEFAULT);
    }
  }
  const parts = [];
  if (added.length) parts.push('Loaded ' + added.length + ' preset' + (added.length === 1 ? '' : 's') + '.');
  if (skipped.length) {
    const shown = skipped.slice(0, 3).map((s) => s.name + ' (' + s.error + ')').join('; ');
    parts.push('Skipped ' + skipped.length + ': ' + shown + (skipped.length > 3 ? '; and ' + (skipped.length - 3) + ' more' : '') + '.');
  }
  if (!parts.length) parts.push('No presets found.');
  showNote(parts.join(' '));
  return { added: added.map((a) => a.name), skipped };
}

async function choosePresets() {
  if (!(window.spotify && window.spotify.choosePresetFiles)) return null;
  const picked = await window.spotify.choosePresetFiles();
  return picked ? loadPresetFiles(picked.files, picked.skipped) : null;
}

// Files or folders dropped on the window go the same way (in place of
// Webamp's own drop, which takes .json without checking it).
async function readEntry(entry, depth, out) {
  if (entry.isFile) {
    if (!/\.(milk|json)$/i.test(entry.name)) return;
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ name: file.name, text: await file.text() });
  } else if (entry.isDirectory && depth < 4) {
    const reader = entry.createReader();
    for (let batch = await new Promise((r) => reader.readEntries(r)); batch.length; batch = await new Promise((r) => reader.readEntries(r))) {
      for (const e of batch) if (!e.name.startsWith('.')) await readEntry(e, depth + 1, out);
    }
  }
}

function onDragOver(e) {
  if (e.target instanceof Element && e.target.closest('#webamp .gen-window')) e.preventDefault();
}

async function onDrop(e) {
  if (!webamp || !(e.target instanceof Element) || !e.target.closest('#webamp .gen-window')) return;
  e.preventDefault();
  e.stopPropagation();
  const files = [];
  const skipped = [];
  for (const item of [...(e.dataTransfer.items || [])]) {
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (!entry) continue;
    if (entry.isFile && !/\.(milk|json)$/i.test(entry.name)) { skipped.push({ name: entry.name, error: 'not a .milk or .json file' }); continue; }
    try { await readEntry(entry, 0, files); } catch (err) { skipped.push({ name: entry.name, error: 'could not be read' }); }
  }
  await loadPresetFiles(files, skipped);
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
  else if (e.target.closest('#webamp #playlist-list-menu')) {
    // VIZ, in place of Webamp's LIST OPTS menu.
    e.preventDefault();
    e.stopPropagation();
    toggle();
  }
}

// ---- The VIZ button ----------------------------------------------------------------
// LIST OPTS's label is part of the skin's playlist bitmap (bottom-right
// corner, 150x38). In the default skin it is redrawn as VIZ, in the same 5 px
// lettering and the bitmap's own colours, with a pressed state (as LYRIC is,
// in webamp-lyrics.js). Other skins keep their own art. Every skin gets the
// "Visualizer" tooltip.

const VIZ_BUTTON = { x: 106, y: 8, w: 22, h: 18 };   // LIST OPTS within that bitmap
// The default skin's LIST OPTS button, pixel for pixel (see VIZ_COLORS).
const BASE_LIST = [
  '.....................#',
  '.ooooooooooooooooooo.x',
  '.o*****************.#+',
  '.o*-***---**--*---*.=+',
  '.o*-****-**-****-**.=+',
  '.o*-****-***-***-**.=+',
  '.o*-****-****-**-**.=+',
  '.o*---*---*--***-**.=+',
  '.o*****************.=+',
  '.o*---*--**---**--*.=+',
  '.o*-*-*-*-**-**-***.=+',
  '.o*-*-*--***-***-**.=+',
  '.o*-*-*-****-****-*.=+',
  '.o*---*-****-**--**.=+',
  '.o*****************.=+',
  '.o..................=+',
  '..#==================+',
  '#x++++++++++++++++++++',
];
const VIZ_COLORS = { '.': '#adb4c4', '#': '#8192a5', o: '#edffff', x: '#576476', '*': '#bfcdd3', '+': '#4e586e', '=': '#798296', '-': '#2f374d' };
// V I Z: 3+1+1+1+3 = 9 px, centred on the 17 px button face (columns 2-18).
const VIZ = [
  '#.#.#.###',
  '#.#.#...#',
  '#.#.#..#.',
  '#.#.#.#..',
  '.#..#.###',
];
const VIZ_TOP = 6;
const VIZ_LEFT = 6;

let vizStyle = null;
let checkedSkin = null;
const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

function isDefaultList(data) {
  for (let y = 0; y < VIZ_BUTTON.h; y++) {
    for (let x = 0; x < VIZ_BUTTON.w; x++) {
      const i = (y * VIZ_BUTTON.w + x) * 4;
      if (hex(data[i], data[i + 1], data[i + 2]) !== VIZ_COLORS[BASE_LIST[y][x]]) return false;
    }
  }
  return true;
}

// The button, normal or pressed (bevel inverted, lettering one pixel lower).
function drawViz(pressed) {
  const c = document.createElement('canvas');
  c.width = VIZ_BUTTON.w;
  c.height = VIZ_BUTTON.h;
  const g = c.getContext('2d');
  const put = (x, y, key) => { g.fillStyle = VIZ_COLORS[key]; g.fillRect(x, y, 1, 1); };
  for (let y = 0; y < VIZ_BUTTON.h; y++) {
    for (let x = 0; x < VIZ_BUTTON.w; x++) {
      let key = BASE_LIST[y][x];
      if (key === '-') key = '*';                                   // clear LIST OPTS
      if (pressed) {
        const topLeft = (y === 1 && x >= 1 && x <= 19) || (x === 1 && y >= 1 && y <= 15);
        const bottomRight = (y === 15 && x >= 2 && x <= 19) || (x === 19 && y >= 2 && y <= 15);
        if (topLeft) key = '.';
        else if (bottomRight) key = 'o';
      }
      put(x, y, key);
    }
  }
  const top = VIZ_TOP + (pressed ? 1 : 0);
  VIZ.forEach((row, dy) => [...row].forEach((p, dx) => { if (p === '#') put(VIZ_LEFT + dx, top + dy, '-'); }));
  return c.toDataURL('image/png');
}

// On each skin change: redraw LIST OPTS as VIZ if it is the default skin's.
function relabelViz() {
  const button = document.querySelector('#webamp #playlist-list-menu');
  if (button && button.title !== 'Visualizer') button.title = 'Visualizer';
  const corner = document.querySelector('#webamp .playlist-bottom-right');
  const url = corner && (/url\("([^"]+)"\)/.exec(getComputedStyle(corner).backgroundImage) || [])[1];
  if (!url || url === checkedSkin || !vizStyle) return;
  checkedSkin = url;
  const img = new Image();
  img.onload = () => {
    if (checkedSkin !== url || !vizStyle) return;
    const c = document.createElement('canvas');
    c.width = VIZ_BUTTON.w;
    c.height = VIZ_BUTTON.h;
    const g = c.getContext('2d');
    g.drawImage(img, VIZ_BUTTON.x, VIZ_BUTTON.y, VIZ_BUTTON.w, VIZ_BUTTON.h, 0, 0, VIZ_BUTTON.w, VIZ_BUTTON.h);
    const isDefault = img.width === 150 && isDefaultList(g.getImageData(0, 0, VIZ_BUTTON.w, VIZ_BUTTON.h).data);
    vizStyle.textContent = isDefault ? `
      #webamp #playlist-list-menu { background: url("${drawViz(false)}") no-repeat; image-rendering: pixelated; }
      #webamp #playlist-list-menu:active { background-image: url("${drawViz(true)}"); }` : '';
    log('LIST OPTS button:', isDefault ? 'default skin - relabelled VIZ' : 'skin\'s own art kept');
  };
  img.src = url;
}

function paintButton() {
  const button = document.querySelector('#webamp #button-v');
  if (!button) return;
  button.classList.toggle('selected', isOpen());
  if (!button.title) button.title = 'Milkdrop visualizer';
}

// ---- As one of the side panels (webamp-panels.js) -----------------------------
// Webamp sizes its windows in 25x29 px steps from 275x116, so a panel
// rectangle is fitted to those (never taller than asked).

const toSize = (w, h) => [Math.max(0, Math.round((w - 275) / 25)), Math.max(0, Math.floor((h - 116) / 29))];
const fromSize = ([sw, sh]) => ({ w: 275 + 25 * sw, h: 116 + 29 * sh });

function rect() {
  const g = webamp.store.getState().windows.genWindows.milkdrop;
  return Object.assign({ x: g.position.x, y: g.position.y }, fromSize(g.size || DEFAULT_SIZE));
}

function setRect(r) {
  if (!webamp) return;
  webamp.store.dispatch({ type: 'WINDOW_SIZE_CHANGED', windowId: 'milkdrop', size: toSize(r.w, r.h) });
  webamp.store.dispatch({ type: 'UPDATE_WINDOW_POSITIONS', positions: { milkdrop: { x: r.x, y: r.y } }, absolute: true });
}

const asPanel = {
  defaultWidth: DEFAULT_WIDTH,
  fit: (r) => Object.assign({ x: r.x, y: r.y }, fromSize(toSize(r.w, r.h))),
  open: () => { if (!isOpen()) toggle(); },
  close: () => { if (isOpen()) toggle(); },
  isOpen: () => isOpen(),
  element: () => windowEl(),
  setRect,
};

// A drag or resize that starts on the window itself places it by hand
// (Webamp also moves it along with the main window it is docked to; that
// does not count).
let gesture = null;
function onPanelPointerDown(e) {
  if (!webamp || !(e.target instanceof Element) || !e.target.closest('#webamp .gen-window')) return;
  if (!e.target.closest('#gen-resize-target, .gen-top, .draggable')) return;
  gesture = rect();
}
function onPanelPointerUp() {
  if (!gesture) return;
  const from = gesture;
  gesture = null;
  requestAnimationFrame(() => {
    if (!webamp || !isMounted()) return;
    const now = rect();
    if (now.x !== from.x || now.y !== from.y || now.w !== from.w || now.h !== from.h) panels.placed('milkdrop', now);
  });
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
    vizStyle = document.createElement('style');
    document.head.appendChild(vizStyle);
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
      // Where the panels put it: its own spot if placed by hand, else the stack.
      if (open) { setRect(panels.opening('milkdrop')); panels.opened('milkdrop'); } else panels.closed('milkdrop');
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
    relabelViz();
  });
  paintButton();
  relabelViz();
  panels.register('milkdrop', asPanel);
  document.addEventListener('pointerdown', onPanelPointerDown, true);
  document.addEventListener('pointerup', onPanelPointerUp, true);
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
  watchMenus();
  document.addEventListener('dragover', onDragOver, true);
  document.addEventListener('drop', onDrop, true);
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
  if (menuWatch) { menuWatch.disconnect(); menuWatch = null; }
  document.removeEventListener('dragover', onDragOver, true);
  document.removeEventListener('pointerdown', onPanelPointerDown, true);
  document.removeEventListener('pointerup', onPanelPointerUp, true);
  document.removeEventListener('drop', onDrop, true);
  checkedSkin = null;
  dropStages();
  webamp = null;
  lastIndex = null;
  suspended = false;
}

window.WinifyMilkdrop = {
  toggle,
  isOpen,
  next: () => next(),
  previous: () => previous(),
  random: () => random(),
  setAutoCycle,
  loadPresetFiles,
  choosePresets,
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
      autoCycle: config.autoCycle,
      history: m ? m.presetHistory.slice() : [],
      display: m ? m.display : null,
    };
  },
};
