/* My playlists: a local index of every song in the playlists you own and in
 * Liked Songs, for Jump to track's "My playlists" mode (webamp-search.js):
 * title, artist, album, duration, and each playlist and position it is in.
 * Kept on this Mac (IndexedDB), never sent anywhere.
 *
 * Built slowly in the background: one request at a time, at most one every
 * 1 s, waiting out Spotify's Retry-After on a 429. Progress is saved after
 * every page, so quitting part-way loses nothing. Which playlists there are
 * comes from the playlist picker's saved list (its snapshot_id says whether
 * a playlist changed); it is checked again only when the picker reads that
 * list (when it is a few hours old, or REFRESH), and only playlists whose
 * snapshot changed are read again, in full. Liked Songs has no snapshot:
 * its size and newest addition stand in for one.
 *
 * Searching never sends a request.
 */

import * as picker from './webamp-picker.js';

const DB_NAME = 'winify-index';
const STORE = 'lists';
const PAGE = 50;                     // the Web API maximum for both endpoints
const GAP_MS = 1000;                 // at most one request every second
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

const save = (rec) => tx('readwrite', (s) => s.put(rec)).catch((err) => ctx && ctx.warn('index: could not save -', err && err.message));
const drop = (uri) => tx('readwrite', (s) => s.delete(uri)).catch(() => {});

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

// Read again what changed or is unfinished; forget what is gone.
function plan(src) {
  if (!src) return;
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
  ctx.log('index:', wanted.length, 'playlists (Liked Songs included),', pending.length, 'to read');
  changed();
  if (waking) waking();
  if (pending.length) run();
}

// ---- Reading ------------------------------------------------------------------------

let lastRequestAt = 0;
let turns = Promise.resolve();       // requests take turns: the build and ensure() share the pace
const sleep = (ms) => new Promise((resolve) => { waking = resolve; setTimeout(resolve, ms); });

// One request, no sooner than gapMs after the last; a 429 waits out its
// Retry-After and asks again.
function paced(path, g) {
  const mine = turns.then(() => pacedNow(path, g));
  turns = mine.catch(() => {});
  return mine;
}

async function pacedNow(path, g) {
  for (;;) {
    for (let wait; (wait = lastRequestAt + gapMs - Date.now()) > 0; ) {
      await sleep(wait);
      waking = null;
      if (g !== gen) return null;
    }
    if (g !== gen) return null;
    lastRequestAt = Date.now();
    requests++;
    try {
      return await ctx.api('GET', path);
    } catch (err) {
      if (g !== gen) return null;
      if (err.status === 429) {
        ctx.warn('index: Spotify rate limit - paused for', err.retryAfter, 's');
        lastRequestAt = Date.now() + (err.retryAfter || 5) * 1000;
        continue;
      }
      throw err;
    }
  }
}

// A playlist entry, or a saved song, as a row: [uri, title, artist, album,
// durationMs, playable]. Positions count every entry, so anything that is
// not a playable Spotify song (a local file, an episode) is kept as null.
function songOf(t, local) {
  if (!t || local || t.is_local || t.type === 'episode' || !/^spotify:track:/.test(t.uri || '')) return null;
  return [t.uri, t.name || '', (t.artists || []).map((a) => a.name).join(', '), (t.album && t.album.name) || '',
    t.duration_ms || 0, t.is_playable !== false];
}

async function readList(uri, g) {
  const w = wanted.find((x) => x.uri === uri);
  if (!w) return;
  const liked = /:collection$/.test(uri);
  const path = liked ? '/me/tracks?market=from_token'
    : '/playlists/' + uri.split(':').pop() + '/items?market=from_token&additional_types=track,episode';
  let rec = lists.get(uri);
  // Changed since it was read: from the start. Unfinished: where it stopped.
  if (!rec || rec.snapshot !== w.snapshot) rec = { uri, name: w.name, snapshot: w.snapshot, meId, songs: [], next: 0, complete: false };
  while (!rec.complete) {
    const page = await paced(path + '&limit=' + PAGE + '&offset=' + rec.next, g);
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
      const uri = pending[0];
      reading = uri;
      try {
        await readList(uri, g);
      } catch (err) {
        if (g !== gen) return;
        if (err.status == null) {                       // offline: try again later
          ctx.warn('index: could not reach Spotify - trying again in a minute');
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
    if (g === gen) ctx.log('index: up to date -', songCount(), 'songs in', lists.size, 'playlists;', requests,
      'requests since Winify started (' + Math.round((Date.now() - started) / 1000) + ' s this round)');
  } finally {
    if (runningGen === g) runningGen = 0;
    if (g === gen) changed();
  }
}

function forgetAll() {
  lists = new Map();
  table = null;
  tx('readwrite', (s) => s.clear()).catch(() => {});
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
    await readList(entry.uri, g);
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

export function status() {
  return { songs: songCount(), lists: lists.size, building: pending.length > 0, done: round.done, total: round.total, requests };
}

// "Indexing playlists: 40 of 97" while it builds, or null.
export function progressNote() {
  return pending.length ? 'Indexing playlists: ' + round.done + ' of ' + round.total : null;
}

function changed() {
  listeners.forEach((fn) => { try { fn(); } catch (e) { /* a listener's own problem */ } });
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
    const recs = (await tx('readonly', (s) => s.getAll())) || [];
    if (g !== gen) return;
    lists = new Map(recs.map((r) => [r.uri, r]));
    meId = recs.length ? recs[0].meId : null;
  } catch (err) {
    ctx.warn('index: could not open the saved index -', err && err.message);
  }
  table = null;
  if (paused()) { ctx.log('index: paused (no requests) -', songCount(), 'songs saved'); changed(); return; }
  // The picker's saved list; read first if there is none, or it is from
  // before it kept each playlist's snapshot.
  const src = await picker.listForIndex();
  if (g !== gen || !src) return;
  plan(src);
}

// Signed out: stop. The index stays; another account's sign-in replaces it.
export function reset() {
  gen++;
  if (waking) waking();
  pending = [];
  ctx = null;
}

// For DevTools and tests.
window.WinifyIndex = { status, progressNote, search, current: (uri) => current(uri),
  // Tests: start again (after un-pausing), at their own pace.
  restart: (opts = {}) => { if (!ctx) return; gapMs = opts.gapMs || GAP_MS; const c = ctx; reset(); return init(c); } };
