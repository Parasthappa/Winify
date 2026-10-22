/* Webamp's playlist window, filled from the current Spotify context.
 *
 * What is listed depends on what Spotify will let a development-mode app
 * read (Web API changes of February 2026):
 *
 *   album                          every track, in order
 *   playlist you own/collaborate   every track, in order (other playlists
 *                                  return 403 - contents are owner-only now)
 *   Liked Songs                    every track, newest first, as Spotify
 *                                  plays them
 *   anything else                  now playing + Spotify's Up Next queue
 *     (followed or Spotify-made playlists, artist, radio, a single track)
 *
 * The list is swapped in only when completely loaded, so it never shows half
 * a playlist; until then the single stand-in entry shows the current track.
 * Webamp's title, total time and seek bar read from whichever entry is
 * current, so there is always exactly one current entry.
 *
 * Owned by webamp-spotify.js, which calls init(), sync() on every state poll,
 * and playEntry() when a row is double-clicked.
 */

const PAGE = 50;                    // the Web API maximum for both endpoints
const PARALLEL_PAGES = 4;
const QUEUE_REFRESH_MS = 600;
const ID_BASE = 1000000;            // clear of Webamp's own ids, which count from 0
const STANDIN_ID = 424242;
const STANDIN_URL = 'winify:spotify';
const IDLE_NAME = 'Winify - press Play to resume Spotify';

let ctx = null;                     // { webamp, dispatch, api, now, say, log, warn, refreshSoon, deviceId }
let mode = 'standin';               // 'standin' | 'list' | 'queue'
let entries = [];                   // [{ id, uri, linkedUri, name, durationMs, position, playable }]
let listContext = null;             // context URI the list belongs to
let listName = null;
let currentIndex = -1;
let standInRow = false;             // stand-in shown above a list it is missing from
let seenContext;                    // undefined = never synced
let seenTrack;
let seenWhere;
let loadGen = 0;
let retriedMissing = null;          // context|track already reloaded for once
let nextId = ID_BASE;
let queueTimer = null;
let doubleClickPending = false;

// ---- Webamp writes -----------------------------------------------------------

function addRow(id, url, name, durationMs, atIndex) {
  ctx.dispatch({
    type: 'ADD_TRACK_FROM_URL',
    id,
    url,
    defaultName: name,
    duration: durationMs ? durationMs / 1000 : null,
    atIndex,
  });
}

function makeCurrent(id) {
  // BUFFER_TRACK makes an entry current without starting anything; the media
  // class ignores the load request that comes with it.
  ctx.dispatch({ type: 'BUFFER_TRACK', id });
}

function writeStandIn() {
  const n = ctx.now;
  ctx.dispatch({ type: 'SET_MEDIA_TAGS', id: STANDIN_ID, title: n.title, artist: n.artist, album: n.album });
  ctx.dispatch({ type: 'SET_MEDIA_DURATION', id: STANDIN_ID, duration: n.durationMs ? n.durationMs / 1000 : null });
}

export function showStandIn() {
  ctx.dispatch({ type: 'REMOVE_ALL_TRACKS' });
  addRow(STANDIN_ID, STANDIN_URL, IDLE_NAME, 0, 0);
  writeStandIn();
  makeCurrent(STANDIN_ID);
  mode = 'standin';
  entries = [];
  listContext = null;
  currentIndex = -1;
  standInRow = false;
}

function installList(list, newMode, contextUri, name) {
  ctx.dispatch({ type: 'REMOVE_ALL_TRACKS' });
  entries = list.map((t, i) => Object.assign({ id: nextId++, position: i }, t));
  entries.forEach((e, i) => addRow(e.id, e.uri || 'winify:unavailable', e.name, e.durationMs, i));
  mode = newMode;
  listContext = contextUri;
  listName = name;
  currentIndex = -1;
  standInRow = false;
  ctx.dispatch({ type: 'SET_PLAYLIST_SCROLL_POSITION', position: 0 });
  highlight(true);
}

// Keep the current row on screen, but only when the track changes, so it
// never fights someone scrolling the list.
function scrollTo(index) {
  const state = ctx.webamp.store.getState();
  const visible = document.querySelectorAll('#webamp .playlist-track-titles .track-cell').length;
  const overflow = state.playlist.trackOrder.length - visible;
  if (overflow <= 0 || visible === 0) return;
  const offset = Math.round((state.display.playlistScrollPosition / 100) * overflow);
  if (index >= offset && index < offset + visible) return;
  const target = Math.max(0, Math.min(overflow, index - Math.floor(visible / 3)));
  ctx.dispatch({ type: 'SET_PLAYLIST_SCROLL_POSITION', position: (target / overflow) * 100 });
}

// ---- Matching the playing track to a row --------------------------------------

function matches(e) {
  const n = ctx.now;
  return !!n.trackUri && (e.uri === n.trackUri || e.linkedUri === n.trackUri ||
    (!!n.linkedFromUri && e.uri === n.linkedFromUri));
}

function highlight(trackChanged) {
  if (mode === 'standin') { writeStandIn(); return; }

  const hits = [];
  entries.forEach((e, i) => { if (matches(e)) hits.push(i); });
  if (!hits.length) {
    showMissing();
    return;
  }
  if (standInRow) {
    ctx.dispatch({ type: 'REMOVE_TRACKS', ids: [STANDIN_ID] });
    standInRow = false;
  }
  // A playlist can hold the same track twice: prefer the copy at or after
  // the previous position, which is what playing on from there reaches.
  const index = hits.find((i) => i >= currentIndex) ?? hits[0];
  if (index !== currentIndex || ctx.webamp.store.getState().playlist.currentTrack !== entries[index].id) {
    currentIndex = index;
    makeCurrent(entries[index].id);
    if (trackChanged) scrollTo(index);
  }
}

// The playing track is not in the list: perhaps it was just added, so reload
// once. Meanwhile, and if it is still missing, show it in a row of its own at
// the top so the title, time and seek bar keep working.
function showMissing() {
  const n = ctx.now;
  if (!standInRow) {
    addRow(STANDIN_ID, STANDIN_URL, IDLE_NAME, 0, 0);
    standInRow = true;
  }
  writeStandIn();
  makeCurrent(STANDIN_ID);
  currentIndex = -1;
  const key = listContext + '|' + n.trackUri;
  if (mode === 'list' && n.trackUri && retriedMissing !== key) {
    retriedMissing = key;
    ctx.log('playing track is not in the loaded list - reloading', listName || listContext);
    load(n.contextUri);
  }
}

// ---- Reading Spotify ----------------------------------------------------------

function kind(uri) {
  if (!uri) return 'none';
  if (/^spotify:album:/.test(uri)) return 'album';
  if (/^spotify:playlist:/.test(uri)) return 'playlist';
  if (/:collection/.test(uri)) return 'collection';
  return uri.split(':')[1] || 'other';
}

const idOf = (uri) => uri.split(':').pop();
const artistsOf = (t) => (t.artists || (t.show ? [t.show] : [])).map((a) => a.name).join(', ');

function row(t) {
  if (!t) return { uri: null, name: '(unavailable)', durationMs: 0, playable: false };
  return {
    uri: t.uri,
    linkedUri: t.linked_from && t.linked_from.uri,
    name: (artistsOf(t) ? artistsOf(t) + ' - ' : '') + t.name,
    durationMs: t.duration_ms || 0,
    playable: t.is_playable !== false && !t.is_local,
  };
}

// Every page of a paged endpoint, in order: the first page says how many
// there are, the rest are fetched a few at a time.
async function allPages(path, gen) {
  const sep = path.includes('?') ? '&' : '?';
  const first = await ctx.api('GET', path + sep + 'limit=' + PAGE + '&offset=0');
  const items = first.items.slice();
  const offsets = [];
  for (let o = PAGE; o < first.total; o += PAGE) offsets.push(o);
  const pages = new Array(offsets.length);
  for (let i = 0; i < offsets.length; i += PARALLEL_PAGES) {
    if (gen !== loadGen) throw new Error('superseded');
    const batch = offsets.slice(i, i + PARALLEL_PAGES);
    const got = await Promise.all(batch.map((o) =>
      ctx.api('GET', path + sep + 'limit=' + PAGE + '&offset=' + o)));
    got.forEach((p, j) => { pages[i + j] = p.items; });
  }
  pages.forEach((p) => items.push(...p));
  if (items.length !== first.total) {
    ctx.warn('expected', first.total, 'items but received', items.length);
  }
  return items;
}

async function loadAlbum(uri, gen) {
  const id = idOf(uri);
  const [album, tracks] = await Promise.all([
    ctx.api('GET', '/albums/' + id + '?market=from_token'),
    allPages('/albums/' + id + '/tracks?market=from_token', gen),
  ]);
  return { name: album && album.name, list: tracks.map(row) };
}

// February 2026 names: /playlists/{id}/items, each entry's track under `item`.
async function loadPlaylist(uri, gen) {
  const id = idOf(uri);
  const meta = await ctx.api('GET', '/playlists/' + id + '?fields=name');
  const items = await allPages('/playlists/' + id + '/items?market=from_token&additional_types=track,episode', gen);
  return { name: meta && meta.name, list: items.map((entry) => row(entry && entry.item)) };
}

// Saved tracks keep the `track` field name; the February 2026 rename to
// `item` applied to playlists only.
async function loadLikedSongs(gen) {
  const items = await allPages('/me/tracks?market=from_token', gen);
  return { name: 'Liked Songs', list: items.map((entry) => row(entry && entry.track)) };
}

async function loadQueue() {
  const q = await ctx.api('GET', '/me/player/queue');
  const list = [];
  if (q && q.currently_playing) list.push(row(q.currently_playing));
  ((q && q.queue) || []).forEach((t) => list.push(row(t)));
  return list;
}

function why(err, k) {
  if (err.status === 403 && k === 'playlist') return 'not your playlist (Spotify only lists playlists you own or collaborate on)';
  if (err.status === 404 && k === 'playlist') return 'playlist not readable (private, or Spotify-made)';
  if (/scope/i.test(err.message)) return 'permission not granted - sign in again';
  return err.message;
}

function describe(k) {
  return { collection: 'Liked Songs', artist: 'artist', station: 'radio', none: 'no context' }[k] || k;
}

async function load(contextUri) {
  const gen = ++loadGen;
  const k = kind(contextUri);
  // A different context: show the current track alone until its list is in.
  if (mode !== 'standin' && listContext !== contextUri) showStandIn();

  const loaders = { album: loadAlbum, playlist: loadPlaylist, collection: (uri, g) => loadLikedSongs(g) };
  if (loaders[k]) {
    try {
      const got = await loaders[k](contextUri, gen);
      if (gen !== loadGen) return;
      installList(got.list, 'list', contextUri, got.name);
      ctx.log('playlist window:', k, '"' + got.name + '" -', got.list.length, 'tracks');
      ctx.say(got.name ? got.name + ' - ' + got.list.length + ' tracks' : got.list.length + ' tracks');
      return;
    } catch (err) {
      if (gen !== loadGen || err.message === 'superseded') return;
      ctx.log('playlist window: cannot list', k, '-', why(err, k), '- showing Up Next instead');
    }
  } else {
    ctx.log('playlist window:', describe(k), '- showing now playing + Up Next');
  }
  await refreshQueue(gen, contextUri);
}

async function refreshQueue(gen, contextUri) {
  try {
    const list = await loadQueue();
    if (gen !== loadGen) return;
    if (!list.length) { showStandIn(); return; }
    installList(list, 'queue', contextUri, null);
  } catch (err) {
    if (gen !== loadGen) return;
    ctx.warn('could not read the queue -', err.message);
    if (mode !== 'standin') showStandIn();
  }
}

// ---- Called by webamp-spotify.js ----------------------------------------------

export function init(c) {
  ctx = c;
  document.addEventListener('dblclick', onDoubleClickCapture, true);
  showStandIn();
}

export function reset() {
  loadGen++;
  clearTimeout(queueTimer);
  document.removeEventListener('dblclick', onDoubleClickCapture, true);
  ctx = null;
  mode = 'standin';
  entries = [];
  listContext = null;
  seenContext = undefined;
  seenTrack = undefined;
  seenWhere = undefined;
  retriedMissing = null;
}

// Called after every state poll; cheap when nothing changed.
export function sync() {
  if (!ctx) return;
  const n = ctx.now;
  if (n.where === 'none') {
    if (seenWhere !== 'none') { loadGen++; showStandIn(); }
    seenWhere = n.where;
    seenContext = undefined;
    seenTrack = undefined;
    return;
  }
  seenWhere = n.where;

  const contextChanged = n.contextUri !== seenContext;
  const trackChanged = n.trackUri !== seenTrack;
  seenContext = n.contextUri;
  seenTrack = n.trackUri;

  if (contextChanged) {
    if (mode === 'standin') writeStandIn();
    load(n.contextUri);
    return;
  }
  if (!trackChanged) return;

  if (mode === 'queue') {
    // Up Next moves on with every track; show the new current at once if it
    // is listed, then re-read the queue.
    highlight(true);
    clearTimeout(queueTimer);
    const gen = loadGen;
    queueTimer = setTimeout(() => refreshQueue(gen, n.contextUri), QUEUE_REFRESH_MS);
  } else {
    highlight(true);
  }
}

// ---- Double-click to play ------------------------------------------------------

// Webamp turns a double-click into PLAY_TRACK, the same action its own
// playlist stepping produces on Next/Previous. This flag, set just before
// Webamp's handler runs, is what tells the two apart.
function onDoubleClickCapture(e) {
  if (e.target instanceof Element && e.target.closest('#webamp .track-cell')) {
    doubleClickPending = true;
    setTimeout(() => { doubleClickPending = false; }, 0);
  }
}

export function takeDoubleClick() {
  const pending = doubleClickPending;
  doubleClickPending = false;
  return pending;
}

const OFFSET_CONTEXTS = new Set(['album', 'playlist', 'collection']);

export async function playEntry(id) {
  if (!ctx) return;
  const index = entries.findIndex((e) => e.id === id);
  const e = entries[index];
  if (!e) return;                                    // the stand-in: nothing to choose
  if (!e.playable || !e.uri) {
    ctx.say('Cannot play that track');
    ctx.log('double-click: not playable -', e.name);
    return;
  }
  const deviceId = ctx.deviceId();
  if (!deviceId) { ctx.say('Winify device not ready'); return; }

  const contextUri = listContext;
  const k = kind(contextUri);
  try {
    if (contextUri && OFFSET_CONTEXTS.has(k)) {
      // Same context, starting at this row. Position is exact even when a
      // track appears twice; a URI is safer when the list is the queue,
      // whose order is not the context's.
      const duplicated = entries.filter((x) => x.uri === e.uri).length > 1;
      const offset = mode === 'list' && duplicated ? { position: e.position } : { uri: e.uri };
      await ctx.api('PUT', '/me/player/play?device_id=' + encodeURIComponent(deviceId),
        { context_uri: contextUri, offset });
      ctx.log('double-click: playing', e.name, 'in', listName || contextUri);
    } else if (contextUri) {
      // Artist, radio and similar contexts take no offset; skipping forward
      // through Up Next keeps the context.
      if (index === 0) {
        await window.WinifyPlayer.seek(0);
      } else {
        for (let i = 0; i < index; i++) await window.WinifyPlayer.nextTrack();
      }
      ctx.log('double-click: skipped', index, 'ahead to', e.name);
    } else {
      // No context at all: play from this row on.
      await ctx.api('PUT', '/me/player/play?device_id=' + encodeURIComponent(deviceId),
        { uris: entries.slice(index).filter((x) => x.playable).map((x) => x.uri) });
      ctx.log('double-click: playing', e.name, 'and the rest of the list');
    }
  } catch (err) {
    ctx.warn('double-click failed -', err.message);
    ctx.say('Could not play that track');
  }
  ctx.refreshSoon();
}

// For inspection from DevTools and tests.
window.WinifyPlaylist = {
  state: () => ({ mode, listContext, listName, count: entries.length, currentIndex,
    current: entries[currentIndex] && entries[currentIndex].name, standInRow }),
};
