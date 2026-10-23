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
 * When an album or playlist runs out and Spotify's Autoplay carries on, the
 * playing track is no longer in the list (Spotify may still report the old
 * album as the source). The list is then replaced by now playing + the queue,
 * under an "Autoplay" label row, and refreshed on every track change. The
 * same happens after a single track started from Jump to track ends. A queue
 * started from an artist is labelled with the artist's name.
 *
 * Play track (Jump to track) means "this track, then Autoplay". Spotify only
 * autoplays when an album or playlist runs out, never after a track played on
 * its own, so the track is played within its album and, just before it ends
 * (or on Next), Winify jumps to the album's last moment: the album runs out
 * and Spotify's Autoplay, seeded from it, carries on. Meanwhile the window
 * shows only that track and a line saying what comes after it. With repeat
 * on, the track repeats instead; Next still moves on to Autoplay.
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
const END_LEAD_MS = 1200;           // end the album this long before the track ends
const ALBUM_TAIL_MS = 300;          // ...by playing this much of its last track
const PLAN_WAIT_MS = 10000;         // how long a Play track may take to start

let ctx = null;                     // { webamp, dispatch, api, now, say, log, warn, refreshSoon, deviceId }
let mode = 'standin';               // 'standin' | 'list' | 'queue'
let entries = [];                   // [{ id, uri, linkedUri, name, durationMs, position, playable }]
let listContext = null;             // context URI the list belongs to
let listName = null;
let currentIndex = -1;
let autoplay = false;               // the source ran out and Spotify's Autoplay took over
let cameFromList = false;           // the previous source was a full list
let singleTrackUri = null;          // a single track Winify started on its own (no album)
let plan = null;                    // Play track, then Autoplay: { uri, albumUri, albumTracks, shown, line, ... }
let contextList = null;             // the last full list loaded: { uri, list, name }
const artistNames = {};             // artist URI -> name, for the label row
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
}

// `label`, for a queue view, is a first row naming the source ("Autoplay",
// "Artist: ..."). It is not a track: nothing plays it and nothing matches it.
function installList(list, newMode, contextUri, name, label) {
  ctx.dispatch({ type: 'REMOVE_ALL_TRACKS' });
  const rows = label ? [{ uri: null, name: '\u2014 ' + label + ' \u2014', durationMs: 0, playable: false, isLabel: true }].concat(list) : list;
  entries = rows.map((t, i) => Object.assign({ id: nextId++, position: label ? i - 1 : i }, t));
  entries.forEach((e, i) => addRow(e.id, e.uri || 'winify:unavailable', e.name, e.durationMs, i));
  mode = newMode;
  listContext = contextUri;
  listName = name;
  currentIndex = -1;
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
  // A playlist can hold the same track twice: prefer the copy at or after
  // the previous position, which is what playing on from there reaches.
  const index = hits.find((i) => i >= currentIndex) ?? hits[0];
  if (index !== currentIndex || ctx.webamp.store.getState().playlist.currentTrack !== entries[index].id) {
    currentIndex = index;
    makeCurrent(entries[index].id);
    if (trackChanged) scrollTo(index);
  }
}

// The playing track is not in the list. The old list is cleared at once (the
// current track alone shows meanwhile, so the title, time and seek bar keep
// working), then:
//   a full list: perhaps the track was just added, so reload it once; if it
//                is still missing, the list has run out and Spotify's
//                Autoplay is playing -> its queue, labelled "Autoplay".
//   a queue:     the queue has moved on -> re-read it.
function showMissing() {
  const n = ctx.now;
  const wasMode = mode;
  const context = listContext;
  showStandIn();
  if (!n.trackUri) return;
  const key = context + '|' + n.trackUri;
  if (wasMode === 'list' && retriedMissing !== key) {
    retriedMissing = key;
    ctx.log('playing track is not in the loaded list - reloading', listName || context);
    load(n.contextUri);
  } else if (wasMode === 'list') {
    autoplay = true;
    ctx.log('the list has run out - Spotify\'s Autoplay is playing; showing its queue');
    refreshQueue(++loadGen, n.contextUri);
  } else if (wasMode === 'queue') {
    refreshQueue(++loadGen, n.contextUri);
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
  const current = q && q.currently_playing;
  if (current) list.push(row(current));
  let queued = (q && q.queue) || [];
  // For a track played on its own Spotify reports that same track over and
  // over as "up next"; nothing is actually queued.
  if (current && queued.length && queued.every((t) => t && t.uri === current.uri)) queued = [];
  queued.forEach((t) => list.push(row(t)));
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
  // Starting the album that ran out again: it is already loaded.
  if (contextList && contextList.uri === contextUri && contextList.list.some(matches)) {
    installList(contextList.list, 'list', contextUri, contextList.name);
    return;
  }

  const loaders = { album: loadAlbum, playlist: loadPlaylist, collection: (uri, g) => loadLikedSongs(g) };
  if (loaders[k]) {
    try {
      const got = await loaders[k](contextUri, gen);
      if (gen !== loadGen) return;
      installList(got.list, 'list', contextUri, got.name);
      contextList = { uri: contextUri, list: got.list, name: got.name };
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

// The label row for a queue view, or null for none.
async function queueLabel(contextUri) {
  const k = kind(contextUri);
  const n = ctx.now;
  if (autoplay) return 'Autoplay';
  if (k === 'none') {
    if (singleTrackUri && n.trackUri === singleTrackUri) return null;   // the track itself
    return singleTrackUri || cameFromList ? 'Autoplay' : null;
  }
  if (k === 'artist') {
    if (!(contextUri in artistNames)) {
      try { artistNames[contextUri] = (await ctx.api('GET', '/artists/' + idOf(contextUri))).name; } catch (e) { artistNames[contextUri] = null; }
    }
    return 'Artist' + (artistNames[contextUri] ? ': ' + artistNames[contextUri] : '');
  }
  return null;
}

async function refreshQueue(gen, contextUri) {
  try {
    const [list, label] = await Promise.all([loadQueue(), queueLabel(contextUri)]);
    if (gen !== loadGen) return;
    if (!list.length) { showStandIn(); return; }
    installList(list, 'queue', contextUri, null, label);
  } catch (err) {
    if (gen !== loadGen) return;
    ctx.warn('could not read the queue -', err.message);
    if (mode !== 'standin') showStandIn();
  }
}

// ---- Play track, then Autoplay ---------------------------------------------------

const isPlanTrack = (n) => !!n.trackUri && (n.trackUri === plan.uri || n.linkedFromUri === plan.uri);
const lineFor = (n) => (n.repeat === 'off' ? 'Autoplay starts after this track' : 'Repeating this track');

// The album's last track: { uri, linkedUri, position, durationMs, isPlan }.
function lastTrack(p) {
  if (!p.lastPromise) {
    p.lastPromise = (async () => {
      const path = '/albums/' + idOf(p.albumUri) + '/tracks?market=from_token&limit=1';
      const total = p.albumTracks || (await ctx.api('GET', path)).total;
      const t = (await ctx.api('GET', path + '&offset=' + (total - 1))).items[0];
      const linkedUri = t.linked_from && t.linked_from.uri;
      p.last = { uri: t.uri, linkedUri, position: total - 1, durationMs: t.duration_ms,
        isPlan: total === 1 || t.uri === p.uri || linkedUri === p.uri };
      return p.last;
    })();
    p.lastPromise.catch(() => { p.lastPromise = null; });
  }
  return p.lastPromise;
}

const onLastTrack = (n) => !!plan.last && !!n.trackUri &&
  (n.trackUri === plan.last.uri || n.trackUri === plan.last.linkedUri || n.linkedFromUri === plan.last.uri);

function endPlan() {
  if (!plan) return;
  clearTimeout(plan.timer);
  plan = null;
}

// The track alone, then a line saying what follows it.
function showSingle() {
  loadGen++;
  clearTimeout(queueTimer);
  const n = ctx.now;
  plan.line = lineFor(n);
  ctx.dispatch({ type: 'REMOVE_ALL_TRACKS' });
  entries = [
    { uri: n.trackUri, linkedUri: n.linkedFromUri, name: (n.artist ? n.artist + ' - ' : '') + n.title,
      durationMs: n.durationMs, playable: true },
    { uri: null, name: '\u2014 ' + plan.line + ' \u2014', durationMs: 0, playable: false, isLabel: true },
  ].map((e, i) => Object.assign({ id: nextId++, position: i }, e));
  entries.forEach((e, i) => addRow(e.id, e.uri || 'winify:unavailable', e.name, e.durationMs, i));
  mode = 'single';
  listContext = plan.albumUri;
  listName = null;
  currentIndex = -1;
  ctx.dispatch({ type: 'SET_PLAYLIST_SCROLL_POSITION', position: 0 });
  highlight(true);
}

// Just before the track ends: with repeat off, end the album so Autoplay
// follows; with repeat-one Spotify repeats it; with repeat-all it is a list
// of one, so it starts over.
function scheduleEnd() {
  clearTimeout(plan.timer);
  const n = ctx.now;
  if (n.paused || plan.jumping || !n.durationMs || n.where !== 'winify') return;
  const left = n.durationMs - ctx.positionMs();
  plan.timer = setTimeout(atEnd, Math.max(0, left - END_LEAD_MS));
}

function atEnd() {
  if (!ctx || !plan || !isPlanTrack(ctx.now) || ctx.now.paused) return;
  const r = ctx.now.repeat;
  if (r === 'track') return;
  if (r === 'context') {
    ctx.log('play track: repeat is on - playing it again');
    window.WinifyPlayer.seek(0).then(ctx.refreshSoon);
    return;
  }
  if (plan.last && plan.last.isPlan) return;           // the album ends with it anyway
  endAlbum('the track is ending');
}

// Play the album's last moment, so it runs out and Spotify's Autoplay starts.
async function endAlbum(why) {
  const p = plan;
  if (!p || p.jumping) return;
  p.jumping = true;
  clearTimeout(p.timer);
  const deviceId = ctx.deviceId();
  try {
    const last = await lastTrack(p);
    if (plan !== p) return;
    if (ctx.now.repeat !== 'off') {
      await ctx.api('PUT', '/me/player/repeat?state=off&device_id=' + encodeURIComponent(deviceId));
      ctx.log('play track: repeat off, so Autoplay can follow');
    }
    if (last.isPlan) {
      await window.WinifyPlayer.seek(Math.max(0, ctx.now.durationMs - ALBUM_TAIL_MS));
    } else {
      await ctx.api('PUT', '/me/player/play?device_id=' + encodeURIComponent(deviceId), {
        context_uri: p.albumUri, offset: { position: last.position },
        position_ms: Math.max(0, last.durationMs - ALBUM_TAIL_MS),
      });
    }
    ctx.log('play track:', why, '- ending the album so Spotify\'s Autoplay follows');
  } catch (err) {
    if (plan === p) p.jumping = false;
    ctx.warn('play track: could not move on to Autoplay -', err.message);
    ctx.say('Could not start Autoplay');
  }
  ctx.refreshSoon();
}

// Follows the plan on each sync. True when it has dealt with this state.
function followPlan(n, trackChanged) {
  if (!plan.shown) {
    if (n.contextUri === plan.albumUri && isPlanTrack(n)) {
      plan.shown = true;
      cameFromList = false;
      autoplay = false;
      showSingle();
      scheduleEnd();
      return true;
    }
    if (performance.now() > plan.until) endPlan();     // it never started
    return false;
  }
  if (n.contextUri !== plan.albumUri) { endPlan(); return false; }   // a new source
  if (isPlanTrack(n)) {
    if (trackChanged || lineFor(n) !== plan.line) showSingle();
    scheduleEnd();
    return true;
  }
  if (plan.jumping && onLastTrack(n)) return true;      // the album's last moment
  // Anything else: Autoplay has begun (or the album carried on). The album
  // list sorts out which; a track missing from it is Autoplay straight away.
  endPlan();
  retriedMissing = n.contextUri + '|' + n.trackUri;
  showStandIn();
  load(n.contextUri);
  return true;
}

// Next during the track: on to Autoplay rather than the rest of the album.
export function takeOverNext() {
  if (!ctx || !plan || !plan.shown) return false;
  if (plan.jumping) return true;                       // already on its way
  if (!isPlanTrack(ctx.now)) return false;
  endAlbum('Next');
  return true;
}

// ---- Called by webamp-spotify.js ----------------------------------------------

export function init(c) {
  ctx = c;
  document.addEventListener('dblclick', onDoubleClickCapture, true);
  showStandIn();
}

// Jump to track is about to play one track, { uri, albumUri, albumTracks },
// to be followed by Autoplay. Without an album it plays on its own.
export function expectSingleTrack(p) {
  endPlan();
  if (!p.albumUri) { singleTrackUri = p.uri; return; }
  plan = { uri: p.uri, albumUri: p.albumUri, albumTracks: p.albumTracks || null,
    shown: false, until: performance.now() + PLAN_WAIT_MS };
  lastTrack(plan).catch(() => {});                     // ready for when it is needed
}

export function reset() {
  loadGen++;
  autoplay = false;
  cameFromList = false;
  singleTrackUri = null;
  endPlan();
  contextList = null;
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
  if (plan && n.where !== 'winify') clearTimeout(plan.timer);
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

  if (plan && followPlan(n, trackChanged)) return;

  if (contextChanged) {
    // A new source ends Autoplay, and a single track's moment.
    cameFromList = mode === 'list' || mode === 'single' || (autoplay && cameFromList);
    autoplay = false;
    if (n.contextUri) singleTrackUri = null;
    if (mode === 'standin') writeStandIn();
    load(n.contextUri);
    return;
  }
  if (!trackChanged) return;

  // Autoplay, then the album that ran out is played again: back to its list.
  if (autoplay && contextList && contextList.uri === n.contextUri && contextList.list.some(matches)) {
    autoplay = false;
    installList(contextList.list, 'list', n.contextUri, contextList.name);
    return;
  }

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

// The Spotify track behind a playlist row (for the right-click menu), or
// null for the stand-in row and anything unplayable.
export function entryById(id) {
  const e = entries.find((x) => x.id === id);
  return e && e.uri && e.playable ? { uri: e.uri, name: e.name } : null;
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
  if (!e || e.isLabel) return;                       // the stand-in or a label: nothing to choose
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
      // Positions count from the playing track (a label row comes before it).
      if (e.position === 0) {
        await window.WinifyPlayer.seek(0);
      } else {
        for (let i = 0; i < e.position; i++) await window.WinifyPlayer.nextTrack();
      }
      ctx.log('double-click: skipped', e.position, 'ahead to', e.name);
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
    current: entries[currentIndex] && entries[currentIndex].name, autoplay,
    label: entries[0] && entries[0].isLabel ? entries[0].name : null,
    line: mode === 'single' ? entries[1].name : null,
    plan: plan && { uri: plan.uri, shown: plan.shown, jumping: !!plan.jumping, last: plan.last || null } }),
};
