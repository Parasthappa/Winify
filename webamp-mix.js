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
 * Songs come from the local playlist index (webamp-library-index.js) when
 * the playlist is in it: then the picks are random across the whole playlist,
 * with no request. A playlist not indexed yet is read as above.
 *
 * Playlists chosen together in the picker (makeFrom) are mixed the same way:
 * N random songs from each (all of a short one), no duplicates, shuffled
 * together or playlist after playlist; from the index, or else one page at
 * a random offset, so a mix starts at once rather than after reading whole
 * playlists.
 *
 * Saved on this Mac only (localStorage), never on Spotify: the 20 newest
 * (the oldest dropped first), listed in the playlist picker under "Winify
 * mixes", where one can be played again exactly, renamed, deleted or
 * remixed. Each remembers its playlists (`sources`), how many songs from each
 * (`perList`) and whether they were shuffled together (`together`): hovering
 * one names its playlists, and Remix makes a fresh mix of the same playlists,
 * the same number from each, the same way (no request for what is indexed).
 */

import * as picker from './webamp-picker.js';
import * as playlist from './webamp-playlist.js';
import * as index from './webamp-library-index.js';

const STORE_KEY = 'winify.mixes.v1';
const KEEP = 20;                     // saved mixes (random and chosen together)
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

// Several at once (chosen together in the picker).
export function removeMany(ids) {
  keep(saved().filter((m) => !ids.includes(m.id)));
}

// One name for all of them: "Name", "Name (2)", "Name (3)", in the order given.
export function renameMany(ids, name) {
  const all = saved();
  ids.forEach((id, k) => {
    const m = all.find((x) => x.id === id);
    if (!m) return;
    m.name = k ? name + ' (' + (k + 1) + ')' : name;
    playlist.renamedMix(uriOf(m), m.name);
  });
  keep(all);
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

// Up to `n` random songs from a playlist's indexed songs, not already in the
// mix (`seen`): playable Spotify songs only.
function pick(songs, n, seen, from) {
  const take = [];
  for (const t of shuffled(songs.filter((x) => x.playable))) {
    if (take.length >= n) break;
    if (seen.has(t.uri)) continue;
    seen.add(t.uri);
    take.push({ uri: t.uri, name: t.name, durationMs: t.durationMs, from });
  }
  return take;
}

// Up to PER_PLAYLIST songs from one playlist, from a page at a random offset
// (and once more at another, if it came up short). Counts its requests.
async function fromPlaylist(p, seen, count, perList = PER_PLAYLIST) {
  const indexed = index.songsOf(p.uri);
  if (indexed) return pick(indexed, perList, seen, p.name);
  const take = [];
  // Liked Songs has its own endpoint.
  const path = /:collection$/.test(p.uri) ? '/me/tracks?market=from_token' : '/playlists/' + p.uri.split(':').pop() + '/items?market=from_token';
  let total = p.count || 0;                            // as the picker last saw it
  const tried = new Set();
  for (let attempt = 0; attempt < 2 && take.length < perList; attempt++) {
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
      page = await ctx.api('GET', path + '&limit=' + PAGE + '&offset=' + offset);
    } catch (err) {
      ctx.warn('mix: could not read', '"' + p.name + '" -', err.message);
      break;
    }
    // February 2026: each entry's track is under `item`.
    const songs = ((page && page.items) || [])
      .map((entry) => entry && (entry.item || (typeof entry.track === 'object' ? entry.track : null)))
      .filter((t) => t && t.uri && t.type !== 'episode' && !t.is_local && !/^spotify:local:/.test(t.uri) && t.is_playable !== false && !seen.has(t.uri));
    for (const t of shuffled(songs)) {
      if (take.length >= perList) break;
      seen.add(t.uri);
      take.push({ uri: t.uri, name: (artistsOf(t) ? artistsOf(t) + ' - ' : '') + t.name, durationMs: t.duration_ms || 0, from: p.name });
    }
    if (page && typeof page.total === 'number') total = page.total;   // it may have changed since
    if (total <= PAGE && offset === 0) break;          // that was all of it
  }
  return take;
}

// A random mix: "31 Oct, 14:05". Playlists chosen together: "4 PLAYLISTS ·
// 20 each · 31 Oct". A second one with the same name gets " (2)".
function nameFor(date, chosen) {
  const day = date.getDate() + ' ' + MONTHS[date.getMonth()];
  const name = chosen ? chosen.playlists + ' PLAYLISTS \u00b7 ' + chosen.perList + ' each \u00b7 ' + day
    : day + ', ' + date.getHours() + ':' + String(date.getMinutes()).padStart(2, '0');
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
    const mix = { id: String(date.getTime()), name: nameFor(date), at: date.getTime(), tracks: shuffled(tracks), playlists: chosen.length,
      kind: 'random', sources: chosen.map((p) => ({ uri: p.uri, name: p.name })), perList: PER_PLAYLIST, together: true };
    keep([mix].concat(saved()));
    const played = await play(mix);
    last = { id: mix.id, playlists: chosen.length, songs: tracks.length, requests: count.requests + (played ? 1 : 0) };
    ctx.log('mix:', '"' + mix.name + '" -', tracks.length, 'songs from', chosen.length, 'playlists,', last.requests, 'requests');
    return mix;
  } finally {
    busy = false;
  }
}

// Playlists chosen together in the picker: `chosen` are its rows ({ name, uri,
// snapshot }), `perList` songs from each, `together` shuffles them all.
export async function makeFrom(chosen, perList, together) {
  if (!ctx || busy || chosen.length < 2) return null;
  busy = true;
  try {
    ctx.say('Mixing ' + chosen.length + ' playlists...');
    const count = { requests: 0 };
    const seen = new Set();
    let groups = [];
    const sources = [];
    for (const p of chosen) {
      const songs = await fromPlaylist(p, seen, count, perList);
      if (!songs.length) { ctx.warn('mix: nothing from', '"' + p.name + '"'); continue; }
      groups.push(songs);
      sources.push({ uri: p.uri, name: p.name });
    }
    const tracks = groups.flat();
    if (!tracks.length) { ctx.say('No songs found for a mix'); return null; }
    const mix = chosenMix(sources, perList, together, tracks, groups.length);
    keep([mix].concat(saved()));
    const played = await play(mix);
    const requests = count.requests + (played ? 1 : 0);
    last = { id: mix.id, playlists: groups.length, songs: tracks.length, requests };
    ctx.log('mix:', '"' + mix.name + '" -', tracks.length, 'songs from', groups.length, 'playlists (' + perList + ' each),', requests, 'requests');
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
      playlist.mixBody(mix.tracks, 0));
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

// A mix of playlists chosen together, named and headed by them.
function chosenMix(sources, perList, together, tracks, playlists) {
  const date = new Date();
  return { id: String(date.getTime()), name: nameFor(date, { playlists, perList }), at: date.getTime(), playlists,
    kind: 'chosen', sources, perList, together,
    tracks: together ? shuffled(tracks) : tracks, header: { prefix: '', name: playlists + ' PLAYLISTS \u00b7 ' + perList + ' each' } };
}

// The playlists a mix came from. Mixes saved before they were recorded:
// the playlist names on their songs, found in the picker's list.
function sourcesOf(mix) {
  if (Array.isArray(mix.sources)) return mix.sources;
  const names = [...new Set(mix.tracks.map((t) => t.from).filter(Boolean))];
  const own = picker.knownPlaylists();
  return names.map((name) => ({ name, uri: (own.find((p) => p.name === name) || {}).uri || null }));
}

// For the picker's tooltip: "From: Road Trip, Gym, ...".
export function fromNames(id) {
  const mix = saved().find((m) => m.id === id);
  return mix ? sourcesOf(mix).map((p) => p.name) : [];
}

// The same playlists, the same number from each, fresh random songs, from
// the local index only; saved as a new mix and played.
export async function remix(id) {
  const mix = saved().find((m) => m.id === id);
  if (!ctx || busy || !mix) return null;
  busy = true;
  try {
    const sources = sourcesOf(mix);
    const perList = mix.perList || (mix.header && +((mix.header.name.match(/(\d+) each/) || [])[1])) || PER_PLAYLIST;
    const together = mix.together !== false;
    const seen = new Set();
    const count = { requests: 0 };
    const used = [], missing = [];
    let groups = [];
    for (const p of sources) {
      const songs = p.uri ? await fromPlaylist(p, seen, count, perList) : [];
      if (!songs.length) { missing.push(p.name); continue; }
      groups.push(songs);
      used.push(p);
    }
    const tracks = groups.flat();
    if (missing.length) ctx.warn('mix: remix leaves out:', missing.join(', '));
    if (!tracks.length) { ctx.say('No songs found for a mix'); return null; }
    const random = (mix.kind || (mix.header ? 'chosen' : 'random')) === 'random';
    const fresh = random
      ? Object.assign({ id: String(Date.now()), name: nameFor(new Date()), at: Date.now(), tracks: shuffled(tracks), playlists: used.length,
        kind: 'random', sources: used, perList, together: true })
      : chosenMix(used, perList, together, tracks, used.length);
    keep([fresh].concat(saved()));
    const played = await play(fresh);
    last = { id: fresh.id, playlists: used.length, songs: tracks.length, requests: count.requests + (played ? 1 : 0), remixOf: mix.id, missing };
    ctx.log('mix: remix of "' + mix.name + '" -', '"' + fresh.name + '",', tracks.length, 'songs from', used.length, 'playlists (' + perList + ' each),', count.requests, 'requests to make it' +
      (missing.length ? '; left out: ' + missing.join(', ') : ''));
    if (missing.length) ctx.say('Remixed; left out: ' + missing.join(', '));
    return fresh;
  } finally {
    busy = false;
  }
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

window.WinifyMix = { make, makeFrom, remix, fromNames, saved, playSaved, rename, remove, removeMany, renameMany, state: () => ({ busy, last, current: currentUri() }) };
