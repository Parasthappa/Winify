/* My playlists: a local index of every song in the playlists you own and in
 * Liked Songs, for Jump to track's "My playlists" mode (webamp-search.js):
 * title, artist, album, duration, and each playlist and position it is in.
 * Kept on this Mac, never sent anywhere: by the main process, in a folder
 * both copies (npm start and Winify.app) share, so it is built once.
 *
 * Indexed as you go: a playlist (or Liked Songs) the playlist window reads
 * in full, when you open or play it, goes into the index from what it read,
 * at no extra request (noteList).
 *
 * Nothing is read by itself. "Build full index" (the menu bar, or Jump to
 * track's "Searching 23 of 97 playlists" line) reads the rest: one request at
 * a time, at most one every 3 s, as background work for the request governor
 * (spotify-governor.js: only what playback and what you do leave, so it
 * spreads over hours and sessions), waiting out Spotify's Retry-After on a
 * 429, until it is done or paused (remembered across launches until then).
 * Only one copy builds at a time. Progress is saved after every page.
 *
 * Which playlists there are comes from the playlist picker's saved list (its
 * snapshot_id says whether a playlist changed; Liked Songs' size and newest
 * addition stand in for one); it is read again only when the picker does
 * (when the list is three days old, or REFRESH). A changed playlist is
 * indexed again when it is opened, or by "Build full index".
 *
 * Searching never sends a request.
 */

import * as picker from './webamp-picker.js';

const DB_NAME = 'winify-index';
const STORE = 'lists';
const PAGE = 50;                     // the Web API maximum for both endpoints
const GAP_MS = 3000;                 // at most one request every 3 s
const RETRY_MS = 60 * 1000;          // after a network error
const MAX_RESULTS = 300;
// Set by the smoke test and the mock pages: no index requests.
const PAUSED_KEY = 'winify.index.paused';

let ctx = null;                      // { api, log, warn }
let gen = 0;                         // a newer start (or reset) stops an older run
let meId = null;
let lists = new Map();               // playlist URI -> its saved record
let wanted = [];                     // what the picker's list says to index: [{ uri, name, snapshot }]
let pending = [];                    // URIs still to read, in order
let round = { done: 0, total: 0 };   // this round's progress, for the note
let holding = false;                 // waiting out a rate limit or an outage: not reading
let waking = null;                   // ends the wait between requests early (a new plan)
let runningGen = 0;                  // the start whose reading loop is running
let requests = 0;                    // sent since Winify started, for the log
let gapMs = GAP_MS;                  // tests run faster
let table = null;                    // the search table, built from `lists` when needed
const listeners = new Set();

// ---- Storage ----------------------------------------------------------------------

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'uri' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

// In Winify the index is kept by the main process, in a folder both copies
// share (window.spotify.index), so it is built once for both. Without it (the
// test pages), this page's own IndexedDB, as before.
const shared = () => (window.spotify && window.spotify.index) || null;
const localAll = () => tx('readonly', (s) => s.getAll()).then((r) => r || []);
const save = (rec) => (shared() ? shared().put(rec) : tx('readwrite', (s) => s.put(rec)))
  .catch((err) => ctx && ctx.warn('index: could not save -', err && err.message));
const drop = (uri) => (shared() ? shared().remove(uri) : tx('readwrite', (s) => s.delete(uri))).catch(() => {});

// Everything saved. An index this copy built on its own before is moved
// into the shared one rather than built again: every playlist the shared
// one lacks, or has unfinished where this copy's is finished (whichever copy
// opens first, nothing either built is lost).
async function loadAll() {
  if (!shared()) return localAll();
  const recs = await shared().load();
  const old = await localAll().catch(() => []);
  const have = new Map(recs.map((r) => [r.uri, r]));
  let moved = 0;
  for (const r of old) {
    const s = have.get(r.uri);
    if (s && (s.complete || !r.complete)) continue;
    await shared().put(r);
    have.set(r.uri, r);
    moved++;
  }
  if (moved) ctx.log('index: moved', moved, 'playlists from this copy\'s own index into the shared one');
  return [...have.values()];
}

// Only one copy builds at a time: the one holding the shared lock (renewed
// as it reads). The other reads what it saves, and takes over when it can.
let follower = false;
let followTimer = null;
let followStamp = 0;
const FOLLOW_MS = 60 * 1000;
async function mayBuild() {
  if (!shared()) return true;
  const c = await shared().claim().catch(() => ({ builder: true }));
  if (!c.builder && !follower) ctx.log('index: the other Winify is building it - reading what it saves');
  follower = !c.builder;
  if (follower && !followTimer) followTimer = setTimeout(follow, FOLLOW_MS);
  return c.builder;
}
async function follow() {
  followTimer = null;
  if (!ctx || !shared()) return;
  const g = gen;
  const stamp = await shared().stamp().catch(() => 0);
  if (g !== gen) return;
  if (stamp !== followStamp) {
    followStamp = stamp;
    const recs = await shared().load().catch(() => null);
    if (g !== gen || !recs) return;
    lists = new Map(recs.map((r) => [r.uri, r]));
    table = null;
    changed();
  }
  // Still the other's? Then look again later; otherwise plan and build here.
  if (await mayBuild()) { if (planned) { const src = planned; planned = null; plan(src); } }
  else if (!followTimer) followTimer = setTimeout(follow, FOLLOW_MS);
}

// ---- What to index ------------------------------------------------------------------

const likedUri = (id) => 'spotify:user:' + id + ':collection';

// The picker's list as index entries: your own playlists with songs in
// them, and Liked Songs (its size and newest addition as its snapshot).
function wantedFrom(src) {
  const own = src.entries.filter((e) => e.mine !== false && e.count > 0)
    .map((e) => ({ uri: e.uri, name: e.name, snapshot: e.snapshot }));
  const liked = src.liked > 0 ? [{ uri: likedUri(src.meId), name: 'Liked Songs', snapshot: src.liked + '|' + (src.likedNewest || '') }] : [];
  return liked.concat(own);
}

// Read again what changed or is unfinished; forget what is gone. Each read
// of the list is planned once (the picker reports it, and init asks for it).
let planned = null;
function plan(src) {
  if (!src || src === planned) return;
  planned = src;
  if (meId && src.meId !== meId) forgetAll();          // another account
  meId = src.meId;
  wanted = wantedFrom(src);
  const keep = new Set(wanted.map((w) => w.uri));
  for (const uri of [...lists.keys()]) {
    if (!keep.has(uri)) { lists.delete(uri); drop(uri); table = null; }
  }
  pending = [];
  for (const w of wanted) {
    const rec = lists.get(w.uri);
    if (rec && rec.name !== w.name) { rec.name = w.name; save(rec); table = null; }
    if (!rec || rec.snapshot !== w.snapshot || !rec.complete) pending.push(w.uri);
  }
  round = { done: 0, total: pending.length };
  ctx.log('index:', wanted.length, 'playlists (Liked Songs included),', pending.length, 'not indexed or changed' +
    (buildOn() ? ' - building' : ' (indexed as you open them; "Build full index" reads the rest)'));
  changed();
  if (waking) waking();
  if (pending.length && buildOn()) run();
}

// ---- Build full index: only when asked -------------------------------------------
// Nothing is read by itself any more: playlists are indexed as you open them
// (noteList), and "Build full index" (menu bar, Jump to track) reads the rest,
// slowly, as background work for the request governor, until it is done or
// paused. Remembered across launches until then.
const BUILD_KEY = 'winify.index.build';
function buildOn() {
  try { return localStorage.getItem(BUILD_KEY) === '1'; } catch (e) { return false; }
}
function setBuild(on) {
  try { if (on) localStorage.setItem(BUILD_KEY, '1'); else localStorage.removeItem(BUILD_KEY); } catch (e) { /* storage unavailable */ }
}

export async function startBuild() {
  if (!ctx) return;
  setBuild(true);
  ctx.log('index: build full index - started');
  changed();
  const g = gen;
  // What to read comes from the playlist list (read now only if there is none
  // saved, or it is a few days old).
  const src = await picker.listForIndex();
  if (g !== gen || !src) return;
  if (src === planned) { if (pending.length) run(); else finishBuild(); } else plan(src);
  if (!pending.length) finishBuild();
}

export function pauseBuild() {
  setBuild(false);
  if (waking) waking();                // a wait between requests ends at once
  if (ctx) ctx.log('index: build paused -', indexedCount(), 'of', wanted.length, 'playlists indexed');
  changed();
}

function finishBuild() {
  if (!buildOn()) return;
  setBuild(false);
  if (ctx) ctx.log('index: full index built -', wanted.length, 'playlists');
  changed();
}

const indexedCount = () => wanted.filter((w) => current(w.uri)).length;

// A playlist the playlist window has just read in full (its own requests):
// into the index at no extra cost. Your own playlists and Liked Songs only
// (what My playlists searches). `songs`: as songOf makes them.
export function noteList(uri, name, snapshot, songs) {
  if (!ctx || !uri || !Array.isArray(songs)) return;
  const liked = /:collection$/.test(uri);
  const known = picker.knownPlaylists().find((e) => e.uri === uri);
  if (!liked && !(known && known.mine !== false)) return;
  // The name as the playlist list has it (as the index keeps every other).
  const w = wanted.find((x) => x.uri === uri);
  name = (w && w.name) || (known && known.name) || name;
  const rec = { uri, name, snapshot, meId: meId || (liked ? uri.split(':')[2] : null), songs, next: songs.length, complete: true, at: Date.now(), from: 'opened' };
  lists.set(uri, rec);
  table = null;
  save(rec);
  if (!wanted.some((w) => w.uri === uri)) wanted.push({ uri, name, snapshot });
  pending = pending.filter((u) => u !== uri);
  ctx.log('index: "' + name + '" indexed as you opened it -', songs.filter(Boolean).length, 'songs, no extra requests');
  changed();
}

// ---- Reading ------------------------------------------------------------------------

let lastRequestAt = 0;
let turns = Promise.resolve();       // requests take turns: the build and ensure() share the pace
const sleep = (ms) => new Promise((resolve) => { waking = resolve; setTimeout(resolve, ms); });

// One request, no sooner than gapMs after the last; a 429 waits out its
// Retry-After and asks again.
function paced(path, g, priority) {
  const mine = turns.then(() => pacedNow(path, g, priority));
  turns = mine.catch(() => {});
  return mine;
}

async function pacedNow(path, g, priority) {
  for (;;) {
    for (let wait; (wait = lastRequestAt + gapMs - Date.now()) > 0; ) {
      await sleep(wait);
      waking = null;
      if (g !== gen) return null;
    }
    if (g !== gen) return null;
    if (holding) { holding = false; changed(); }
    lastRequestAt = Date.now();
    requests++;
    try {
      return await ctx.api('GET', path, undefined, priority);
    } catch (err) {
      if (g !== gen) return null;
      if (err.status === 429) {
        ctx.warn('index: Spotify rate limit - paused for', err.retryAfter, 's');
        lastRequestAt = Date.now() + (err.retryAfter || 5) * 1000;
        holding = true;
        changed();
        continue;
      }
      throw err;
    }
  }
}

// A playlist entry, or a saved song, as a row: [uri, title, artist, album,
// durationMs, playable]. Positions count every entry, so anything that is
// not a playable Spotify song (a local file, an episode) is kept as null.
export function songOf(t, local) {
  if (!t || local || t.is_local || t.type === 'episode' || !/^spotify:track:/.test(t.uri || '')) return null;
  return [t.uri, t.name || '', (t.artists || []).map((a) => a.name).join(', '), (t.album && t.album.name) || '',
    t.duration_ms || 0, t.is_playable !== false];
}

async function readList(uri, g, priority) {
  const w = wanted.find((x) => x.uri === uri);
  if (!w) return;
  const liked = /:collection$/.test(uri);
  const path = liked ? '/me/tracks?market=from_token'
    : '/playlists/' + uri.split(':').pop() + '/items?market=from_token&additional_types=track,episode';
  let rec = lists.get(uri);
  // Changed since it was read: from the start. Unfinished: where it stopped.
  if (!rec || rec.snapshot !== w.snapshot) rec = { uri, name: w.name, snapshot: w.snapshot, meId, songs: [], next: 0, complete: false };
  while (!rec.complete) {
    const page = await paced(path + '&limit=' + PAGE + '&offset=' + rec.next, g, priority);
    if (g !== gen || !page) return;
    for (const entry of page.items || []) {
      rec.songs.push(liked ? songOf(entry && entry.track) : songOf(entry && entry.item, entry && entry.is_local));
    }
    rec.next += PAGE;
    rec.complete = rec.next >= (page.total || 0) || !(page.items || []).length;
    rec.at = Date.now();
    lists.set(uri, rec);
    table = null;
    await save(rec);
  }
}

let reading = null;                  // the playlist the background build is reading now

async function run() {
  // Already running for this start: it picks up the new plan. One left over
  // from an older start is on its way out.
  if (runningGen === gen) return;
  const g = gen;
  runningGen = g;
  const started = Date.now();
  try {
    while (pending.length && g === gen) {
      if (!buildOn()) break;                          // paused
      // Only while this copy holds the build (renewed before each playlist).
      if (!(await mayBuild()) || g !== gen) break;
      const uri = pending[0];
      reading = uri;
      try {
        await readList(uri, g);
      } catch (err) {
        if (g !== gen) return;
        if (err.status == null) {                       // offline: try again later
          ctx.warn('index: could not reach Spotify - trying again in a minute');
          holding = true;
          changed();
          await sleep(RETRY_MS);
          continue;
        }
        // Deleted, or no longer readable: passed over until it changes.
        ctx.warn('index: could not read', uri, '-', err.message);
      }
      reading = null;
      if (g !== gen) return;
      if (pending[0] === uri) pending.shift();
      round.done++;
      changed();
    }
    if (g === gen && !pending.length) finishBuild();
    if (g === gen && !pending.length) ctx.log('index: up to date -', songCount(), 'songs in', lists.size, 'playlists;', requests,
      'requests since Winify started (' + Math.round((Date.now() - started) / 1000) + ' s this round)');
  } finally {
    if (runningGen === g) runningGen = 0;
    if (g === gen) changed();
  }
}

function forgetAll() {
  lists = new Map();
  table = null;
  (shared() ? shared().clear() : tx('readwrite', (s) => s.clear())).catch(() => {});
}

// ---- Searching ----------------------------------------------------------------------

// One row per song: where it is (every playlist and position), and the text
// searched, lowercased.
function buildTable() {
  const bySong = new Map();
  for (const rec of lists.values()) {
    rec.songs.forEach((s, position) => {
      if (!s) return;
      let row = bySong.get(s[0]);
      if (!row) {
        row = { uri: s[0], title: s[1], artist: s[2], album: s[3], durationMs: s[4], playable: s[5], places: [],
          text: (s[1] + ' ' + s[2] + ' ' + s[3]).toLowerCase() };
        bySong.set(s[0], row);
      }
      if (!row.places.some((p) => p.uri === rec.uri)) row.places.push({ uri: rec.uri, name: rec.name, position });
    });
  }
  return [...bySong.values()];
}

const songCount = () => (table || (table = buildTable())).length;

// Songs whose title, artist or album hold every word typed; titles that
// start with the first word come first.
// A playlist's songs as the index holds them, in playlist order, or null when
// it is not (completely) indexed: { uri, name, durationMs, playable }.
export function songsOf(uri) {
  const rec = lists.get(uri);
  if (!rec || !rec.complete || pending.includes(uri)) return null;
  return rec.songs.filter(Boolean).map((s) => ({ uri: s[0], name: (s[2] ? s[2] + ' - ' : '') + s[1], durationMs: s[4], playable: s[5] }));
}

// Like songsOf, but reads just this playlist first if it is not indexed yet
// ({ uri, name, snapshot } from the picker's list). Null if it cannot be read.
export async function ensure(entry) {
  const have = songsOf(entry.uri);
  if (have || !ctx) return have;
  const g = gen;
  // The background build is on it already: wait for that.
  while (reading === entry.uri && g === gen) await new Promise((r) => setTimeout(r, 250));
  if (g !== gen) return null;
  if (!wanted.some((w) => w.uri === entry.uri)) wanted.push({ uri: entry.uri, name: entry.name, snapshot: entry.snapshot });
  try {
    await readList(entry.uri, g, 'user');            // someone is waiting for this one
  } catch (err) {
    ctx && ctx.warn('index: could not read', entry.uri, '-', err.message);
    return null;
  }
  pending = pending.filter((u) => u !== entry.uri);
  changed();
  return songsOf(entry.uri);
}

export function search(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  if (!table) table = buildTable();
  const hits = table.filter((r) => words.every((w) => r.text.includes(w)));
  const first = words[0];
  hits.sort((a, b) => (b.title.toLowerCase().startsWith(first) - a.title.toLowerCase().startsWith(first)) ||
    a.title.localeCompare(b.title));
  return hits.slice(0, MAX_RESULTS);
}

// Is this playlist as Spotify has it now (positions to be trusted)?
export const current = (uri) => !!(lists.get(uri) && lists.get(uri).complete && !pending.includes(uri));

// `indexed` of `playlists` (your own and Liked Songs) are in and current;
// `buildOn`: "Build full index" asked for and not finished or paused.
export function status() {
  return { songs: songCount(), lists: lists.size, indexed: indexedCount(), playlists: wanted.length, buildOn: buildOn(),
    building: reading_(), waiting: pending.length > 0 && !reading_(), done: round.done, total: round.total, requests };
}

// Reading playlists now: something to read and the reading loop on it, not
// waiting out a rate limit or an outage (nor the quick check of the list,
// which plans nothing until it is done).
const reading_ = () => pending.length > 0 && runningGen === gen && !holding;

// "Indexing playlists: 40 of 97" while it reads them, or null.
export function progressNote() {
  return reading_() ? 'Indexing playlists: ' + round.done + ' of ' + round.total : null;
}

function changed() {
  listeners.forEach((fn) => { try { fn(); } catch (e) { /* a listener's own problem */ } });
  // The menu bar's "Build full index" item shows how far it is.
  if (window.spotify && window.spotify.indexState) {
    window.spotify.indexState({ indexed: indexedCount(), playlists: wanted.length, buildOn: buildOn(), building: reading_() });
  }
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---- Lifecycle --------------------------------------------------------------------

// The picker read its whole list again: re-read whatever changed.
export function listRead(src) {
  if (ctx && !paused()) plan(src);
}

function paused() {
  try { return localStorage.getItem(PAUSED_KEY) === '1'; } catch (e) { return false; }
}

export async function init(c) {
  ctx = c;
  const g = ++gen;
  try {
    const recs = await loadAll();
    if (g !== gen) return;
    lists = new Map(recs.map((r) => [r.uri, r]));
    meId = recs.length ? recs[0].meId : null;
  } catch (err) {
    ctx.warn('index: could not open the saved index -', err && err.message);
  }
  table = null;
  if (paused()) { ctx.log('index: paused (no requests) -', songCount(), 'songs saved'); changed(); return; }
  // What there is to index: the picker's saved list, as it is (nothing read
  // at launch). A build asked for and not finished carries on.
  if (buildOn()) { startBuild(); return; }
  const src = picker.savedList();
  if (src) plan(src); else changed();
}

// Signed out: stop. The index stays; another account's sign-in replaces it.
export function reset() {
  gen++;
  if (waking) waking();
  pending = [];
  planned = null;
  holding = false;
  follower = false;
  clearTimeout(followTimer);
  followTimer = null;
  ctx = null;
}

// For DevTools and tests.
window.WinifyIndex = { status, progressNote, search, current: (uri) => current(uri), startBuild, pauseBuild,
  // Tests: start again (after un-pausing), at their own pace.
  restart: (opts = {}) => { if (!ctx) return; gapMs = opts.gapMs || GAP_MS; const c = ctx; reset(); return init(c); } };
