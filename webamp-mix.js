/* Random mix: the Winamp logo (bottom-right of the main window) makes a
 * temporary shuffled mix from your own playlists, and plays it.
 *
 * Making one: up to 10 random playlists you own (from the playlist picker's
 * saved list; never Liked Songs). From each, one page of 50 at a random
 * offset (its track count is known), and up to 10 random songs from that
 * page: local files, unavailable songs, episodes and songs already in the
 * mix are passed over; a playlist that comes up short is read once more at
 * another offset. About one request per playlist, plus one to play.
 * The songs are shuffled and played on Winify as a list of their own
 * (webamp-playlist.js treats it as a source, so its play order, skipping,
 * reordering, queue and shuffle work as usual).
 *
 * Saved on this Mac only (localStorage), never on Spotify: the 10 newest,
 * listed in the playlist picker under "Winify mixes", where one can be
 * played again exactly, renamed or deleted.
 */

import * as picker from './webamp-picker.js';
import * as playlist from './webamp-playlist.js';

const STORE_KEY = 'winify.mixes.v1';
const KEEP = 10;                     // saved mixes
const PLAYLISTS = 10;                // per mix
const PER_PLAYLIST = 10;             // songs from each
const PAGE = 50;                     // the /playlists/{id}/items maximum
const LOGO_TITLE = 'Make a random mix';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let ctx = null;                      // { webamp, now, api, say, log, warn, refreshSoon, deviceId }
let busy = false;
let last = null;                     // the last mix made: { id, playlists, songs, requests }

// ---- Saved mixes -----------------------------------------------------------------

export function saved() {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY));
    return Array.isArray(all) ? all : [];
  } catch (e) { return []; }
}

function keep(all) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(all.slice(0, KEEP))); } catch (e) { /* storage unavailable */ }
  picker.mixesChanged();
}

export const uriOf = (mix) => 'winify:mix:' + mix.id;

export function rename(id, name) {
  const all = saved();
  const m = all.find((x) => x.id === id);
  if (!m) return;
  m.name = name;
  keep(all);
  playlist.renamedMix(uriOf(m), name);
}

export function remove(id) {
  keep(saved().filter((m) => m.id !== id));
}

// The mix playing now (its uri), if any.
export const currentUri = () => playlist.activeMixUri();

// ---- Making one ------------------------------------------------------------------

const shuffled = (list) => {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const artistsOf = (t) => (t.artists || []).map((a) => a.name).join(', ');

// Up to PER_PLAYLIST songs from one playlist, from a page at a random offset
// (and once more at another, if it came up short). Counts its requests.
async function fromPlaylist(p, seen, count) {
  const take = [];
  const id = p.uri.split(':').pop();
  let total = p.count || 0;                            // as the picker last saw it
  const tried = new Set();
  for (let attempt = 0; attempt < 2 && take.length < PER_PLAYLIST; attempt++) {
    const maxOffset = Math.max(0, total - PAGE);
    let offset = Math.floor(Math.random() * (maxOffset + 1));
    if (tried.has(offset)) {
      if (maxOffset === 0) break;                     // one page is all there is
      offset = (offset + PAGE) % (maxOffset + 1);
    }
    tried.add(offset);
    count.requests++;
    let page;
    try {
      page = await ctx.api('GET', '/playlists/' + id + '/items?market=from_token&limit=' + PAGE + '&offset=' + offset);
    } catch (err) {
      ctx.warn('mix: could not read', '"' + p.name + '" -', err.message);
      break;
    }
    // February 2026: each entry's track is under `item`.
    const songs = ((page && page.items) || [])
      .map((entry) => entry && (entry.item || (typeof entry.track === 'object' ? entry.track : null)))
      .filter((t) => t && t.uri && t.type !== 'episode' && !t.is_local && !/^spotify:local:/.test(t.uri) && t.is_playable !== false && !seen.has(t.uri));
    for (const t of shuffled(songs)) {
      if (take.length >= PER_PLAYLIST) break;
      seen.add(t.uri);
      take.push({ uri: t.uri, name: (artistsOf(t) ? artistsOf(t) + ' - ' : '') + t.name, durationMs: t.duration_ms || 0, from: p.name });
    }
    if (page && typeof page.total === 'number') total = page.total;   // it may have changed since
    if (total <= PAGE && offset === 0) break;          // that was all of it
  }
  return take;
}

function nameFor(date) {
  const name = date.getDate() + ' ' + MONTHS[date.getMonth()] + ', ' + date.getHours() + ':' + String(date.getMinutes()).padStart(2, '0');
  const taken = new Set(saved().map((m) => m.name));
  let unique = name;
  for (let n = 2; taken.has(unique); n++) unique = name + ' (' + n + ')';
  return unique;
}

// Make a mix and play it. `playlists`: how many to mix (tests, the smoke run).
export async function make({ playlists = PLAYLISTS } = {}) {
  if (!ctx || busy) return null;
  busy = true;
  try {
    const own = await picker.ownPlaylists();
    if (!own.length) { ctx.say('No playlists of your own to mix'); return null; }
    const chosen = shuffled(own).slice(0, playlists);
    ctx.say('Mixing ' + chosen.length + ' playlists...');
    const count = { requests: 0 };
    const seen = new Set();
    let tracks = [];
    for (const p of chosen) tracks = tracks.concat(await fromPlaylist(p, seen, count));
    if (!tracks.length) { ctx.say('No songs found for a mix'); return null; }
    const date = new Date();
    const mix = { id: String(date.getTime()), name: nameFor(date), at: date.getTime(), tracks: shuffled(tracks), playlists: chosen.length };
    keep([mix].concat(saved()));
    const played = await play(mix);
    last = { id: mix.id, playlists: chosen.length, songs: tracks.length, requests: count.requests + (played ? 1 : 0) };
    ctx.log('mix:', '"' + mix.name + '" -', tracks.length, 'songs from', chosen.length, 'playlists,', last.requests, 'requests');
    return mix;
  } finally {
    busy = false;
  }
}

// Play a mix from its first song, as Winify's own list.
async function play(mix) {
  const deviceId = ctx.deviceId();
  if (!deviceId) { ctx.say('Winify device not ready'); return false; }
  playlist.expectMix(mix);
  try {
    await ctx.api('PUT', '/me/player/play?device_id=' + encodeURIComponent(deviceId),
      { uris: mix.tracks.map((t) => t.uri), offset: { position: 0 } });
  } catch (err) {
    ctx.warn('mix: could not play -', err.message);
    ctx.say(err.note || 'Could not play the mix');
    return false;
  }
  ctx.refreshSoon();
  return true;
}

export async function playSaved(id) {
  const mix = saved().find((m) => m.id === id);
  if (mix && ctx) await play(mix);
}

// ---- The Winamp logo -------------------------------------------------------------

function onClickCapture(e) {
  if (!ctx || !(e.target instanceof Element) || !e.target.closest('#webamp #about')) return;
  // In place of Webamp's link to webamp.org.
  e.preventDefault();
  e.stopPropagation();
  make();
}

let unsubscribe = null;
function labelLogo() {
  const logo = document.querySelector('#webamp #about');
  if (logo && logo.title !== LOGO_TITLE) {
    logo.title = LOGO_TITLE;
    logo.setAttribute('aria-label', LOGO_TITLE);
    logo.removeAttribute('href');                     // not a link any more
  }
}

export function init(c) {
  ctx = c;
  document.addEventListener('click', onClickCapture, true);
  unsubscribe = ctx.webamp.store.subscribe(labelLogo);
  labelLogo();
}

export function reset() {
  document.removeEventListener('click', onClickCapture, true);
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  ctx = null;
  busy = false;
}

window.WinifyMix = { make, saved, playSaved, rename, remove, state: () => ({ busy, last, current: currentUri() }) };
