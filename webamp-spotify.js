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
import * as libraryIndex from './webamp-library-index.js';
import * as lyrics from './webamp-lyrics.js';
import * as mix from './webamp-mix.js';
import { analyserHandle } from './webamp-vis.js';

const SDK_POLL_MS = 1000;           // local SDK state, no network
// The Web API is the only view of other devices, and every request counts
// toward Spotify's rate limit. While Winify itself plays, the SDK reports
// everything (and its state empties when another device takes over, which
// prompts one API read), so the API is not polled at all. Otherwise it is
// polled slowly, and not at all while the window is hidden (it is read once
// when the window is shown again).
const API_POLL_ELSEWHERE_MS = 30000;   // another device playing
const API_POLL_IDLE_MS = 60000;        // nothing playing anywhere
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
  cover: null,                      // the album's (or show's) cover image URL, from Spotify's own state
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

// `by`: 'spotify' (Spotify said to wait) or 'winify' (Winify's own request
// caps, spotify-governor.js). The note says until when, as a clock time.
const clock = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
function rateLimited(method, path, retryAfterS, by = 'spotify') {
  const s = Math.max(1, Math.round(retryAfterS));
  const err = new Error(method + ' ' + path + ' -> 429: ' + (by === 'winify' ? 'held back by Winify' : 'rate limited') + ' for another ' + s + ' s');
  err.status = 429;
  err.retryAfter = s;
  err.by = by;
  const when = s >= 60 ? 'until ' + clock(Date.now() + s * 1000) : s + ' s';
  err.note = by === 'winify' ? 'Winify is pacing its Spotify requests: wait ' + when : 'Spotify asked Winify to wait ' + when;
  return err;
}

// `priority` 'background': work nobody is waiting for (the index, the
// picker's list read in the background), which the main process's governor
// lets use only what is left.
async function api(method, path, body, priority) {
  const key = limitKey(path);
  if (blockedUntil[key] > Date.now()) throw rateLimited(method, path, (blockedUntil[key] - Date.now()) / 1000);
  // Sent by the main process: from this page every request would first need
  // a browser preflight, doubling what counts toward Spotify's rate limit.
  const res = await window.spotify.api(method, path, body, priority);
  if (res.status === 204) return null;
  if (res.status === 429) {
    const retryAfter = res.until ? Math.max(1, (res.until - Date.now()) / 1000) : Number(res.retryAfter) || 5;
    // Spotify's wait holds for every request there; Winify's own pacing
    // only for this one (the next may fit).
    if (res.by !== 'winify') blockedUntil[key] = Date.now() + retryAfter * 1000;
    warn(res.by === 'winify' ? 'Winify held back' : 'Spotify rate limit on', key, '- for', Math.round(retryAfter), 's');
    throw rateLimited(method, path, retryAfter, res.by);
  }
  const text = res.text;
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  if (res.status < 200 || res.status > 299) {
    const msg = (json && json.error && json.error.message) || text || String(res.status);
    const err = new Error(method + ' ' + path + ' -> ' + res.status + ': ' + msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Every track added to Spotify's queue, from anywhere in Winify, goes into
// the running order as "plays next".
async function apiNotingQueue(method, path, body, priority) {
  const result = await api(method, path, body, priority);
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
  showStreamFormat();
  reportNowPlaying();
}

// kbps, kHz and the stereo light: Spotify's web player (the Web Playback SDK)
// streams Premium as 256 kbps AAC at 44.1 kHz, in stereo. Webamp reads them
// from the playing track's tags, so its track gets those; they show only
// while something is loaded (index.html: html.winify-loaded).
const STREAM = { bitrate: 256000, sampleRate: 44100, numberOfChannels: 2 };
function showStreamFormat() {
  const loaded = now.where !== 'none' && !!now.trackUri;
  document.documentElement.classList.toggle('winify-loaded', loaded);
  if (!loaded) return;
  const state = webamp.store.getState();
  const id = state.playlist.currentTrack;
  const t = id == null ? null : state.tracks[id];
  if (!t || (t.channels === STREAM.numberOfChannels && String(t.kbps).trim() === '256' && String(t.khz).trim() === '44')) return;
  // The tags action also sets these; they are passed through unchanged.
  dispatchRemote(Object.assign({ type: 'SET_MEDIA_TAGS', id, title: t.title, artist: t.artist, album: t.album, albumArtUrl: t.albumArtUrl }, STREAM));
}

// The menu-bar item shows what is playing; it is told here rather than
// asking Spotify itself.
// Main keeps a status line (it no longer asks Spotify itself); sent on change.
let reportedNowPlaying = null;
let reportedTrack;
function reportNowPlaying() {
  const text = now.where === 'none' || !now.title ? 'Nothing is playing'
    : now.title + (now.artist ? ' \u2014 ' + now.artist : '');
  if (window.spotify.nowPlaying && text !== reportedNowPlaying) {
    reportedNowPlaying = text;
    window.spotify.nowPlaying(text);
  }
  // The chassis's now-playing display (winify.js): the track as Spotify
  // describes it, or null when nothing is playing.
  const track = now.where === 'none' || !now.title ? null
    : { uri: now.linkedFromUri || now.trackUri, title: now.title, artist: now.artist, album: now.album, cover: now.cover };
  tellChassis(track);
}

function tellChassis(track) {
  const key = JSON.stringify(track);
  if (key === reportedTrack) return;
  reportedTrack = key;
  window.dispatchEvent(new CustomEvent('winify:now-playing', { detail: track }));
}

// Shown again: fresh state now rather than at the next (slow) hidden poll.
let visibilityHooked = false;
function hookVisibility() {
  if (visibilityHooked || !window.spotify.onVisibility) return;
  visibilityHooked = true;
  window.spotify.onVisibility((visible) => {
    if (!visible || !attached) return;
    pollApi();
    scheduleApiPoll();
  });
}

// The next API read, measured from the last one (whatever prompted it); none
// while Winify plays or its window is hidden.
let apiTimer = null;
let stopSdkEvents = null;
function scheduleApiPoll() {
  clearTimeout(apiTimer);
  apiTimer = null;
  if (!attached) return;
  const hidden = window.WinifyAudio && window.WinifyAudio.isVisible && !window.WinifyAudio.isVisible();
  if (hidden || now.where === 'winify') return;
  apiTimer = setTimeout(pollApi, now.where === 'elsewhere' ? API_POLL_ELSEWHERE_MS : API_POLL_IDLE_MS);
}

// The cover to show: the smallest of Spotify's sizes at least COVER_PX wide
// (the chassis shows it about 100 px wide, at up to 2x), else the largest.
const COVER_PX = 200;
function coverOf(images) {
  const list = (images || []).filter((i) => i && i.url).sort((a, b) => (a.width || 0) - (b.width || 0));
  return (list.find((i) => (i.width || 0) >= COVER_PX) || list[list.length - 1] || {}).url || null;
}

function setTrack(uri, title, artist, album, durationMs, linkedFromUri, cover) {
  now.cover = cover || (uri === now.trackUri ? now.cover : null);
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
  now.cover = null;
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
      t.album && t.album.name, s.duration || t.duration_ms, t.linked_from && t.linked_from.uri,
      coverOf(t.album && t.album.images));
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
      item.album && item.album.name, item.duration_ms, null,
      coverOf((item.album && item.album.images) || item.images || (item.show && item.show.images)));
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
    // Winify is the player now: any API read still scheduled is not needed.
    if (now.where === 'winify' && apiTimer) scheduleApiPoll();
    // Winify's volume, as set from any device, read locally rather than
    // through the (now slower) Web API poll.
    if (window.WinifyPlayer.getVolume && !isHeld('volume')) {
      const v = await window.WinifyPlayer.getVolume();
      if (v != null && !isHeld('volume')) now.volume = Math.round(v * 100);
    }
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
    scheduleApiPoll();
  }
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  // While Winify plays, the local SDK state is enough: no request.
  refreshTimer = setTimeout(async () => { await pollSdk(); if (now.where !== 'winify') pollApi(); }, 400);
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
  playlist.resumeMix();
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
// dragging rows reorders it and removing rows takes them out of it.
const DISCARD = new Set([
  'PLAY_TRACK', 'BUFFER_TRACK', 'IS_STOPPED',
  'ADD_TRACK_FROM_URL', 'REMOVE_TRACKS', 'REMOVE_ALL_TRACKS',
  'DRAG_SELECTED', 'SET_TRACK_ORDER', 'REVERSE_LIST', 'RANDOMIZE_LIST',
  // Spotify has no balance or EQ. Dropping these keeps the sliders still,
  // rather than moving and doing nothing.
  'SET_BALANCE', 'SET_BAND_VALUE',
]);

export const middleware = (store) => (next) => (action) => {
  // Webamp reads a track's tags itself, and cannot read Spotify's (protected)
  // stream: whatever it finds, the stream's figures stand.
  if (action.type === 'SET_MEDIA_TAGS') return next(Object.assign({}, action, STREAM));
  if (applyingRemote || !attached) return next(action);
  if (action.type === 'PLAY_TRACK' && playlist.takeDoubleClick()) {
    playlist.playEntry(action.id);
    return undefined;
  }
  if (action.type === 'STOP' && stopIgnored) return undefined;
  // Winify's own running order: rows can be dragged and removed.
  if (action.type === 'DRAG_SELECTED' && playlist.canDrag()) {
    const result = next(action);
    playlist.reordered();
    return result;
  }
  if (action.type === 'REMOVE_TRACKS' && playlist.canEdit()) {
    playlist.removeIds(action.ids);
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

let unsubscribeTrack = null;
export function attach(instance) {
  webamp = instance;
  // The playing entry can change on Webamp's side (the playlist window
  // rebuilding its list): its kbps / kHz / stereo then too.
  let shownTrack = null;
  unsubscribeTrack = webamp.store.subscribe(() => {
    if (!attached || applyingRemote) return;
    const id = webamp.store.getState().playlist.currentTrack;
    if (id === shownTrack) return;
    shownTrack = id;
    showStreamFormat();
  });

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
  // My playlists, for Jump to track: built and kept current in the background.
  libraryIndex.init({ api: (method, path, body) => api(method, path, body, 'background'), log, warn });
  lyrics.init({ webamp, now, api, log, warn });
  mix.init({
    webamp, now, api: apiNotingQueue, say, log, warn, refreshSoon,
    deviceId: winifyDeviceId,
  });
  attached = true;
  guardMediaFilePrompt();
  document.addEventListener('click', onClickCapture, true);

  timers = [
    setInterval(pollSdk, SDK_POLL_MS),
    setInterval(() => media && media._emit('timeupdate'), TICK_MS),
  ];
  pollSdk();
  pollApi();
  hookVisibility();
  // The SDK's own state events: changes on Winify show at once, and an empty
  // state (another device took over) prompts the one API read that finds it.
  if (window.WinifyPlayer && window.WinifyPlayer.onStateChange) {
    stopSdkEvents = window.WinifyPlayer.onStateChange(() => { if (attached) pollSdk(); });
  }

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
  tellChassis(null);
  if (unsubscribeTrack) { unsubscribeTrack(); unsubscribeTrack = null; }
  document.documentElement.classList.remove('winify-loaded');
  playlist.reset();
  picker.reset();
  search.reset();
  libraryIndex.reset();
  lyrics.reset();
  mix.reset();
  timers.forEach(clearInterval);
  timers = [];
  clearTimeout(apiTimer);
  apiTimer = null;
  if (stopSdkEvents) stopSdkEvents();
  stopSdkEvents = null;
  reportedNowPlaying = null;
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
