/* Webamp <-> Spotify.
 *
 * Makes Webamp's controls drive the in-app Winify device, and makes Webamp's
 * display follow real Spotify state, including changes made elsewhere.
 *
 * Commands go through window.WinifyPlayer's existing functions wherever one
 * exists. Shuffle, repeat and "resume or start something" have no
 * WinifyPlayer function, so those call the Web API directly here.
 *
 * Webamp only routes some controls through its media class, so three hooks
 * are used, each for what it can actually see:
 *
 *   SpotifyMedia (__customMediaClass)  play, pause, stop, seek, volume
 *   middleware (__customMiddlewares)   shuffle, repeat; and discards
 *                                      Webamp's own playlist stepping
 *   click listener                     next / previous, which reach Webamp's
 *                                      store only as "move to playlist
 *                                      position N", indistinguishable by then
 *
 * Webamp's title, total time and seek bar read from its playlist's current
 * track, and Play on an empty playlist opens a file picker. What the playlist
 * holds, and which entry is current, is webamp-playlist.js's job.
 *
 * __customMediaClass and __customMiddlewares are underscore-prefixed private
 * options. The Webamp version is pinned in package.json, and attach() checks
 * that Webamp actually used them rather than failing silently.
 */

import * as playlist from './webamp-playlist.js';
import * as picker from './webamp-picker.js';
import * as search from './webamp-search.js';
import * as lyrics from './webamp-lyrics.js';
import { analyserHandle } from './webamp-vis.js';

const API = 'https://api.spotify.com/v1';
const SDK_POLL_MS = 1000;           // local SDK state, no network
const API_POLL_MS = 3000;           // Web API, the only view of other devices
const TICK_MS = 250;                // time display
const HOLD_MS = 1500;               // ignore polled values after a local change
const VOLUME_THROTTLE_MS = 100;

const log = (...args) => console.log('[winify/controls]', ...args);
const warn = (...args) => console.warn('[winify/controls]', ...args);

let webamp = null;
let media = null;                   // the SpotifyMedia Webamp constructed
let attached = false;
let applyingRemote = false;         // dispatching Spotify's state into Webamp
let timers = [];

// What Spotify is doing, as last observed.
const now = {
  where: 'none',                    // 'winify' | 'elsewhere' | 'none'
  deviceName: null,
  trackUri: null,
  linkedFromUri: null,              // the listed track, when Spotify relinked it
  contextUri: null,                 // playlist / album / ... being played
  title: null,
  artist: null,
  album: null,
  durationMs: 0,
  positionMs: 0,
  sampledAt: 0,                     // performance.now() when positionMs was read
  paused: true,
  shuffle: false,
  repeat: 'off',                    // 'off' | 'context' | 'track'
  volume: null,                     // 0-100, Winify's device only
};
let stoppedByUser = false;          // Stop pauses Spotify but should look stopped

// Webamp's "clear the list" (REM > all, LIST OPTS > new list, and loading
// dropped files) sends STOP before emptying the playlist. The list mirrors
// Spotify and is never cleared, so that STOP must not pause Spotify either.
// Set by those triggers, it covers only the STOP dispatched in the same turn.
let stopIgnored = false;
export function ignoreStopFromListClear() {
  stopIgnored = true;
  setTimeout(() => { stopIgnored = false; }, 0);
}
const heldUntil = {};               // field -> time before which polls are ignored

const hold = (field) => { heldUntil[field] = performance.now() + HOLD_MS; };
const isHeld = (field) => (heldUntil[field] || 0) > performance.now();

function positionMs() {
  if (now.paused) return now.positionMs;
  const p = now.positionMs + (performance.now() - now.sampledAt);
  return now.durationMs ? Math.min(p, now.durationMs) : p;
}

function winifyDeviceId() {
  return window.WinifyPlayer && window.WinifyPlayer.getDeviceId();
}

// ---- Web API --------------------------------------------------------------

// Spotify rate-limits by endpoint: 429 "Too many requests", with Retry-After
// in seconds (it can be hours). Until then, requests to that endpoint fail at
// once instead of adding to the count; `note` says when to try again.
const blockedUntil = {};              // '/me/player', '/playlists/...' -> ms
const limitKey = (path) => path.split('?')[0].split('/').slice(0, 3).join('/');

function rateLimited(method, path, retryAfterS) {
  const s = Math.max(1, Math.round(retryAfterS));
  const h = Math.floor(s / 3600);
  const m = Math.ceil((s % 3600) / 60);
  const err = new Error(method + ' ' + path + ' -> 429: rate limited for another ' + s + ' s');
  err.status = 429;
  err.retryAfter = s;
  err.note = 'Spotify rate limit - try again in ' + (h ? h + ' h ' + m + ' min' : s >= 60 ? m + ' min' : s + ' s');
  return err;
}

async function api(method, path, body) {
  const key = limitKey(path);
  if (blockedUntil[key] > Date.now()) throw rateLimited(method, path, (blockedUntil[key] - Date.now()) / 1000);
  const token = await window.spotify.getToken();
  if (!token) throw new Error('no access token');
  const res = await fetch(API + path, {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + token },
      body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 5;
    blockedUntil[key] = Date.now() + retryAfter * 1000;
    warn('Spotify rate limit on', key, '- no requests there for', retryAfter, 's');
    throw rateLimited(method, path, retryAfter);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || text || res.statusText;
    const err = new Error(method + ' ' + path + ' -> ' + res.status + ': ' + msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Every track added to Spotify's queue, from anywhere in Winify, goes into
// the running order as "plays next".
async function apiNotingQueue(method, path, body) {
  const result = await api(method, path, body);
  if (method === 'POST' && path.startsWith('/me/player/queue?')) {
    const uri = new URLSearchParams(path.split('?')[1]).get('uri');
    if (uri) playlist.noteQueued(uri);
  }
  return result;
}

const withDevice = (path) => {
  const id = winifyDeviceId();
  return path + (path.includes('?') ? '&' : '?') + 'device_id=' + encodeURIComponent(id);
};

// ---- Webamp side ----------------------------------------------------------

function dispatchRemote(action) {
  applyingRemote = true;
  try { webamp.store.dispatch(action); } finally { applyingRemote = false; }
}

function say(message) {
  // Webamp's own marquee message slot, the one it uses for "Volume: 50%".
  dispatchRemote({ type: 'SET_USER_MESSAGE', message });
  setTimeout(() => {
    if (webamp && webamp.store.getState().userInput.userMessage === message) {
      dispatchRemote({ type: 'UNSET_USER_MESSAGE' });
    }
  }, 3000);
}

// Bring Webamp's controls into line with `now`.
function render() {
  if (!webamp) return;
  const state = webamp.store.getState();

  const wantStatus = now.where === 'none' || (stoppedByUser && now.paused)
    ? 'STOPPED'
    : (now.paused ? 'PAUSED' : 'PLAYING');
  if (!isHeld('status') && state.media.status !== wantStatus) {
    if (wantStatus === 'PLAYING') dispatchRemote({ type: 'IS_PLAYING' });
    else if (wantStatus === 'PAUSED') dispatchRemote({ type: 'PAUSE' });
    else dispatchRemote({ type: 'STOP' });
  }

  const shuffleShown = playlist.ownsShuffle() ? playlist.shuffled() : now.shuffle;
  if (!isHeld('shuffle') && state.media.shuffle !== shuffleShown) {
    dispatchRemote({ type: 'TOGGLE_SHUFFLE' });
  }
  const repeatOn = now.repeat !== 'off';
  if (!isHeld('repeat') && state.media.repeat !== repeatOn) {
    dispatchRemote({ type: 'TOGGLE_REPEAT' });
  }

  // Volume is Winify's own device volume; another device's level is not ours
  // to show on Winify's slider.
  if (now.where === 'winify' && now.volume != null && !isHeld('volume') &&
      state.userInput.focus !== 'volume' && state.media.volume !== now.volume) {
    dispatchRemote({ type: 'SET_VOLUME', volume: now.volume });
  }

  playlist.sync();
}

function setTrack(uri, title, artist, album, durationMs, linkedFromUri) {
  if (uri === now.trackUri && durationMs === now.durationMs) return;
  now.trackUri = uri;
  now.linkedFromUri = linkedFromUri || null;
  now.title = title;
  now.artist = artist;
  now.album = album;
  now.durationMs = durationMs || 0;
}

function clearTrack() {
  if (now.trackUri == null && now.title == null) return;
  now.trackUri = null;
  now.linkedFromUri = null;
  now.contextUri = null;
  now.title = null;
  now.artist = null;
  now.album = null;
  now.durationMs = 0;
  now.positionMs = 0;
}

// ---- Reading Spotify ------------------------------------------------------

// From the Web Playback SDK: fast and local, but only while Winify is the
// active device.
function applySdkState(s) {
  const t = s.track_window && s.track_window.current_track;
  now.where = 'winify';
  now.deviceName = 'Winify';
  now.contextUri = (s.context && s.context.uri) || null;
  if (t) {
    setTrack(t.uri, t.name, t.artists.map((a) => a.name).join(', '),
      t.album && t.album.name, s.duration || t.duration_ms, t.linked_from && t.linked_from.uri);
  }
  if (!isHeld('position')) {
    now.positionMs = s.position;
    now.sampledAt = performance.now();
  }
  if (!isHeld('status')) now.paused = s.paused;
  if (!isHeld('shuffle')) now.shuffle = !!s.shuffle;
  if (!isHeld('repeat')) now.repeat = ['off', 'context', 'track'][s.repeat_mode] || 'off';
  render();
}

// From the Web API: slower, but sees every device, and Winify's volume.
function applyApiState(p) {
  if (!p || !p.device) {
    if (now.where !== 'winify') {
      // No session anywhere: show the "press Play" hint, not a stale title.
      now.where = 'none';
      now.paused = true;
      clearTrack();
      render();
    }
    return;
  }
  const mine = p.device.id === winifyDeviceId();
  if (mine && p.device.volume_percent != null && !isHeld('volume')) {
    now.volume = p.device.volume_percent;
  }
  if (mine) {
    // The SDK poll owns everything else for Winify; it is fresher.
    render();
    return;
  }
  now.where = 'elsewhere';
  now.deviceName = p.device.name;
  now.contextUri = (p.context && p.context.uri) || null;
  const item = p.item;
  if (item) {
    setTrack(item.uri, item.name,
      (item.artists || item.show && [item.show] || []).map((a) => a.name).join(', '),
      item.album && item.album.name, item.duration_ms);
  }
  now.positionMs = p.progress_ms || 0;
  now.sampledAt = performance.now();
  now.paused = !p.is_playing;
  now.shuffle = !!p.shuffle_state;
  now.repeat = p.repeat_state || 'off';
  render();
}

async function pollSdk() {
  if (!window.WinifyPlayer) return;
  const s = await window.WinifyPlayer.getState();
  if (s) {
    applySdkState(s);
  } else if (now.where === 'winify') {
    // Winify stopped being the active device; find out where it went.
    now.where = 'none';
    pollApi();
  }
}

let apiPollInFlight = false;
async function pollApi() {
  if (apiPollInFlight) return;
  apiPollInFlight = true;
  try {
    applyApiState(await api('GET', '/me/player'));
  } catch (err) {
    if (err.status !== 429) warn('could not read playback state:', err.message);   // a 429 is logged once, in api()
  } finally {
    apiPollInFlight = false;
  }
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { pollSdk(); pollApi(); }, 400);
}

// ---- Commands -------------------------------------------------------------

function notHere(what) {
  const where = now.where === 'elsewhere' ? ('playing on ' + now.deviceName) : 'not playing in Winify';
  log(what, 'ignored -', where + '; press Play to bring it to Winify');
  say(now.where === 'elsewhere' ? 'On ' + now.deviceName + ' - press Play' : 'Press Play first');
  refreshSoon();
}

async function waitForDevice(ms) {
  const until = performance.now() + ms;
  while (!winifyDeviceId() && performance.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return winifyDeviceId();
}

// Play with nothing playing here: bring the user's session to Winify, and if
// there is nothing to bring, start Liked Songs.
let starting = null;
function startHere() {
  if (starting) return starting;
  starting = (async () => {
    say('Connecting to Spotify...');
    if (!(await waitForDevice(15000))) {
      warn('Play: the Winify device has not registered');
      say('Winify device not ready');
      return false;
    }

    let session = null;
    try { session = await api('GET', '/me/player'); } catch (err) { warn(err.message); }
    if (session && session.item) {
      log('Play: resuming', session.item.name, 'from', session.device && session.device.name);
    } else {
      log('Play: no current session - asking Spotify to resume the last one here');
    }
    if (await window.WinifyPlayer.transferPlaybackHere(true)) {
      // Transfer can succeed with nothing to play. Give it a moment, then check.
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const s = await window.WinifyPlayer.getState();
        if (s && s.track_window && s.track_window.current_track) {
          log('Play: resumed in Winify -', s.track_window.current_track.name);
          return true;
        }
      }
    }

    log('Play: nothing to resume - starting Liked Songs');
    try {
      const me = await api('GET', '/me');
      await api('PUT', withDevice('/me/player/play'),
        { context_uri: 'spotify:user:' + me.id + ':collection' });
      log('Play: Liked Songs started in Winify');
      return true;
    } catch (err) {
      warn('Play: could not start Liked Songs -', err.message);
      say('Nothing to play');
      return false;
    }
  })().finally(() => { starting = null; refreshSoon(); });
  return starting;
}

async function commandPlay() {
  stoppedByUser = false;
  if (now.where === 'winify' && now.trackUri) {
    hold('status');
    now.paused = false;
    now.sampledAt = performance.now();
    await window.WinifyPlayer.play();
  } else {
    await startHere();
  }
  refreshSoon();
}

async function commandPause() {
  if (now.where !== 'winify') return notHere('Pause');
  hold('status');
  now.positionMs = positionMs();
  now.paused = true;
  await window.WinifyPlayer.pause();
  refreshSoon();
}

async function commandStop() {
  if (now.where !== 'winify') {
    stoppedByUser = true;
    return notHere('Stop');
  }
  stoppedByUser = true;
  await commandPause();
}

function commandSkip(direction) {
  if (now.where !== 'winify') return notHere(direction === 1 ? 'Next' : 'Previous');
  if (playlist.takeOverSkip(direction)) return;   // Winify's own order, or a Play track
  const fn = direction === 1 ? window.WinifyPlayer.nextTrack : window.WinifyPlayer.previousTrack;
  fn().then(refreshSoon);
}

function commandSeek(percent) {
  if (now.where !== 'winify' || !now.durationMs) return notHere('Seek');
  const ms = Math.round((percent / 100) * now.durationMs);
  hold('position');
  now.positionMs = ms;
  now.sampledAt = performance.now();
  window.WinifyPlayer.seek(ms).then(refreshSoon);
}

let volumeTimer = null;
let pendingVolume = null;
function commandVolume(volume) {
  hold('volume');
  now.volume = volume;
  pendingVolume = volume;
  if (volumeTimer) return;
  volumeTimer = setTimeout(() => {
    volumeTimer = null;
    // Winify's own player volume: applies whether or not it is active.
    if (winifyDeviceId()) window.WinifyPlayer.setVolume(pendingVolume / 100);
  }, VOLUME_THROTTLE_MS);
}

async function commandShuffle(on) {
  if (now.where !== 'winify') {
    dispatchRemote({ type: 'TOGGLE_SHUFFLE' });   // undo the toggle
    return notHere('Shuffle');
  }
  hold('shuffle');
  if (playlist.ownsShuffle()) {
    // Winify shuffles its own order, visibly; Spotify's shuffle stays off.
    playlist.setShuffle(on);
    return;
  }
  playlist.noteSpotifyShuffle(on);
  now.shuffle = on;
  try {
    await api('PUT', withDevice('/me/player/shuffle?state=' + on));
    log('shuffle', on ? 'on' : 'off');
  } catch (err) {
    warn('shuffle failed -', err.message);
    now.shuffle = !on;
    heldUntil.shuffle = 0;
    render();
  }
}

async function commandRepeat(on) {
  if (now.where !== 'winify') {
    dispatchRemote({ type: 'TOGGLE_REPEAT' });    // undo the toggle
    return notHere('Repeat');
  }
  // Winamp's repeat is on/off; Spotify's is off/context/track. Lighting it
  // means the whole context; unlighting turns off either kind.
  const mode = on ? 'context' : 'off';
  const previous = now.repeat;
  hold('repeat');
  now.repeat = mode;
  try {
    await api('PUT', withDevice('/me/player/repeat?state=' + mode));
    log('repeat', mode);
  } catch (err) {
    warn('repeat failed -', err.message);
    now.repeat = previous;
    heldUntil.repeat = 0;
    render();
  }
}

// ---- Hook 1: the media class -----------------------------------------------

// Webamp constructs this itself, once, through __customMediaClass.
export class SpotifyMedia {
  constructor() {
    this._listeners = {};
    media = this;
  }

  on(event, callback) {
    (this._listeners[event] = this._listeners[event] || []).push(callback);
  }

  _emit(event) {
    (this._listeners[event] || []).forEach((cb) => { try { cb(); } catch (e) { warn(e); } });
  }

  timeElapsed() { return positionMs() / 1000; }
  duration() { return now.durationMs / 1000; }

  async play() { if (!applyingRemote && attached) await commandPlay(); }
  pause() { if (!applyingRemote && attached) commandPause(); }
  stop() { if (!applyingRemote && attached && !stopIgnored) commandStop(); }
  seekToPercentComplete(percent) { if (!applyingRemote && attached) commandSeek(percent); }

  // Webamp calls this once while constructing, to push its default volume.
  // Ignored until attached, so a fresh launch does not overwrite Spotify's.
  setVolume(volume) { if (!applyingRemote && attached) commandVolume(volume); }

  // Spotify cannot do these. Inert by design; see winify README.
  setBalance() {}
  setPreamp() {}
  setEqBand() {}
  disableEq() {}
  enableEq() {}

  // Spotify supplies the audio; there is never a file to load. Webamp calls
  // this when the stand-in becomes current, and on its own playlist stepping.
  async loadFromUrl() {}

  // Webamp's visualizer reads this: a stable handle fed from the shared
  // system-audio capture (webamp-vis.js), silent while there is none.
  getAnalyser() {
    return analyserHandle;
  }

  dispose() {
    this._listeners = {};
  }
}

// ---- Hook 2: the store middleware ------------------------------------------

// Webamp's playlist logic still runs on Next/Previous/track-end and asks to
// move to another entry. Spotify decides what plays next, so those requests
// are dropped -- except a double-clicked row, which plays that track. Sorting
// and the like are dropped too; in Winify's running order (a full list),
// dragging rows reorders it and removing rows skips them.
const DISCARD = new Set([
  'PLAY_TRACK', 'BUFFER_TRACK', 'IS_STOPPED',
  'ADD_TRACK_FROM_URL', 'REMOVE_TRACKS', 'REMOVE_ALL_TRACKS',
  'DRAG_SELECTED', 'SET_TRACK_ORDER', 'REVERSE_LIST', 'RANDOMIZE_LIST',
  // Spotify has no balance or EQ. Dropping these keeps the sliders still,
  // rather than moving and doing nothing.
  'SET_BALANCE', 'SET_BAND_VALUE',
]);

export const middleware = (store) => (next) => (action) => {
  if (applyingRemote || !attached) return next(action);
  if (action.type === 'PLAY_TRACK' && playlist.takeDoubleClick()) {
    playlist.playEntry(action.id);
    return undefined;
  }
  if (action.type === 'STOP' && stopIgnored) return undefined;
  // Winify's own running order: rows can be dragged, and removing them skips them.
  if (action.type === 'DRAG_SELECTED' && playlist.canDrag()) {
    const result = next(action);
    playlist.reordered();
    return result;
  }
  if (action.type === 'REMOVE_TRACKS' && playlist.canEdit()) {
    playlist.skipIds(action.ids);
    return undefined;
  }
  if (DISCARD.has(action.type)) return undefined;

  const result = next(action);
  if (action.type === 'TOGGLE_SHUFFLE') commandShuffle(store.getState().media.shuffle);
  if (action.type === 'TOGGLE_REPEAT') commandRepeat(store.getState().media.repeat);
  return result;
};

// ---- Hook 3: next / previous clicks -----------------------------------------

const SKIP_SELECTORS = [
  ['#webamp #next, #webamp .playlist-next-button', 1],
  ['#webamp #previous, #webamp .playlist-previous-button', -1],
];

function onClickCapture(e) {
  if (!attached || !(e.target instanceof Element)) return;
  for (const [selector, direction] of SKIP_SELECTORS) {
    if (e.target.closest(selector)) { commandSkip(direction); return; }
  }
  // The right-click Playback menu: plain <li> entries labelled by text.
  const li = e.target.closest('#webamp-context-menu li');
  if (li) {
    const label = li.firstChild && li.firstChild.nodeType === Node.TEXT_NODE
      ? li.firstChild.textContent.trim() : '';
    if (label === 'Next') commandSkip(1);
    if (label === 'Previous') commandSkip(-1);
  }
}

// Eject, and every other "open/add file" entry, prompts with a detached
// <input type=file> that has no `accept` filter (skins and EQ presets set
// one, so those still work). Playlist loading is a later stage, so that
// prompt is suppressed; the click simply does nothing.
let realInputClick = null;
function guardMediaFilePrompt() {
  if (realInputClick) return;
  realInputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (attached && this.type === 'file' && !this.accept && !this.isConnected) {
      log('file prompt suppressed (Spotify has no local files to open)');
      return undefined;
    }
    return realInputClick.call(this);
  };
}

// Dropped audio files would otherwise be loaded by Webamp. Skins (.wsz/.zip)
// fall through to Webamp's normal handling.
export function handleTrackDropEvent(e) {
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (files.some((f) => /\.(wsz|zip)$/i.test(f.name))) return null;
  if (files.length) log('dropped files ignored - Spotify has no local files to play');
  // Webamp clears the list (and sends STOP) before loading what this returns.
  ignoreStopFromListClear();
  return [];
}

// ---- Lifecycle --------------------------------------------------------------

export function attach(instance) {
  webamp = instance;

  // These options are private; if a Webamp update stopped honouring them,
  // the buttons would silently do nothing. Say so loudly instead.
  if (!(webamp.media instanceof SpotifyMedia) || webamp.media !== media) {
    console.error('[winify/controls] *** Webamp did not use __customMediaClass -',
      'controls are NOT connected. Check the pinned webamp version.');
    return false;
  }

  playlist.init({
    webamp, now, api: apiNotingQueue, say, log, warn, refreshSoon, positionMs,
    dispatch: dispatchRemote,
    deviceId: winifyDeviceId,
  });
  picker.init({
    webamp, now, api: apiNotingQueue, say, log, warn, refreshSoon,
    deviceId: winifyDeviceId,
  });
  search.init({
    webamp, now, api: apiNotingQueue, say, log, warn, refreshSoon,
    deviceId: winifyDeviceId,
  }, playlist);
  lyrics.init({ webamp, now, api, log, warn });
  attached = true;
  guardMediaFilePrompt();
  document.addEventListener('click', onClickCapture, true);

  timers = [
    setInterval(pollSdk, SDK_POLL_MS),
    setInterval(pollApi, API_POLL_MS),
    setInterval(() => media && media._emit('timeupdate'), TICK_MS),
  ];
  pollSdk();
  pollApi();

  // Prove the middleware is in the chain: a remote-flagged no-op passes
  // through it, so instead check the store ignored a discarded action.
  const before = webamp.store.getState().playlist.trackOrder.length;
  webamp.store.dispatch({ type: 'REMOVE_ALL_TRACKS' });
  if (webamp.store.getState().playlist.trackOrder.length !== before) {
    console.error('[winify/controls] *** Webamp did not use __customMiddlewares -',
      'shuffle/repeat are NOT connected. Check the pinned webamp version.');
    playlist.showStandIn();
  }

  log('connected to Spotify (Winify device', winifyDeviceId() ? 'ready)' : 'not registered yet)');
  return true;
}

export function detach() {
  attached = false;
  playlist.reset();
  picker.reset();
  search.reset();
  lyrics.reset();
  timers.forEach(clearInterval);
  timers = [];
  document.removeEventListener('click', onClickCapture, true);
  webamp = null;
  media = null;
  Object.assign(now, {
    where: 'none', deviceName: null, trackUri: null, linkedFromUri: null,
    contextUri: null, title: null, artist: null,
    album: null, durationMs: 0, positionMs: 0, paused: true, volume: null,
  });
  stoppedByUser = false;
}

// For inspection from DevTools and tests.
window.WinifyControls = {
  state: () => Object.assign({}, now, { positionMs: positionMs(), stoppedByUser }),
  refresh: () => { pollSdk(); return pollApi(); },
};
