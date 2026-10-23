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
 * under an "AUTOPLAY · FROM SPOTIFY" label row, and refreshed on every track
 * change. Like any list that is Spotify's own queue, it is read-only: a drag
 * shows a not-allowed cursor, REM and Delete say so in the title. The
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
 * A full list played on Winify is Winify's own running order (see "Winify's
 * own running order" below): rows can be dragged into a new order, skipped
 * or restored (REM, Delete; Cmd+Z undoes), and tracks queued play next.
 * Shuffle shuffles that order, visibly, instead of Spotify's.
 *
 * Every list starts with a header row naming its source ("— ALBUM · name —",
 * a playlist's name, "— LIKED SONGS —", "— ARTIST · name —", "— AUTOPLAY ·
 * FROM SPOTIFY —", "— UP NEXT —"). It is a label, not a track: unnumbered
 * (the first track is 1), never matched, played, dragged, skipped or queued;
 * double-clicking it plays the list from its first track. A pinned copy of it
 * stays at the top of the list while it scrolls (see "The header").
 *
 * The list is swapped in only when completely loaded, so it never shows half
 * a playlist; until then the single stand-in entry shows the current track.
 * Webamp's title, total time and seek bar read from whichever entry is
 * current, so there is always exactly one current entry.
 *
 * Owned by webamp-spotify.js, which calls init(), sync() on every state poll,
 * playEntry() when a row is double-clicked, and hands over Next/Previous,
 * Shuffle, row drags and removals, and tracks added to Spotify's queue.
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
// Queue the order's next track this long before the end. Measured on a real
// account: 30 s ahead, the switch is as quick as Spotify's own (~0.4 s);
// 10 s ahead it took about a second longer (not preloaded in time).
const QUEUE_LEAD_MS = 30000;
const RESTART_MS = 3000;            // Previous further in than this restarts the track
const SHUFFLE_TAKEOVER_MS = 4000;   // after turning Spotify's shuffle off, ignore stale reports
const AUTOPLAY_LABEL = 'AUTOPLAY \u00b7 FROM SPOTIFY';
const DRAG_THRESHOLD_PX = 4;

let ctx = null;                     // { webamp, dispatch, api, now, say, log, warn, refreshSoon, deviceId }
let mode = 'standin';               // 'standin' | 'list' | 'queue' | 'single'
let entries = [];                   // [{ id, uri, linkedUri, name, durationMs, position, playable, skipped, inserted }]
let listContext = null;             // context URI the list belongs to
let listName = null;
let currentIndex = -1;
let autoplay = false;               // the source ran out and Spotify's Autoplay took over
let cameFromList = false;           // the previous source was a full list
let singleTrackUri = null;          // a single track Winify started on its own (no album)
let plan = null;                    // Play track, then Autoplay: { uri, albumUri, albumTracks, shown, line, ... }
let contextList = null;             // the last full list loaded: { uri, list, name }
const artistNames = {};             // artist URI -> name, for the header
const contextNames = {};            // playlist URI -> name, also for ones whose items cannot be read
let seenContext;                    // undefined = never synced
let seenTrack;
let seenWhere;
let loadGen = 0;
let retriedMissing = null;          // context|track already reloaded for once
let nextId = ID_BASE;
let queueTimer = null;
let doubleClickPending = false;
// The running order (see below).
let shuffleOn = false;              // Winify's shuffle; Spotify's is kept off meanwhile
let origOrder = [];                 // the source's own order, for shuffle off
let pending = [];                   // uris waiting in Spotify's queue, as far as Winify knows
const ownQueueing = [];             // uris Winify is adding to Spotify's queue itself
let preparedFor = null;             // the entry whose end has been prepared
let expectId = null;                // the entry Winify just started
let ending = false;                 // the order ran out; Autoplay is being started
let orderTimer = null;
let skipUndo = [];                  // skips and restores ({ entries, skip }), for Cmd+Z
let shuffleTakenAt = 0;
let skipStyle = null;               // <style> dimming the skipped rows on screen
let headerEl = null;                // the pinned header, over the list's top row
let numberObserver = null;          // renumbers rows as Webamp redraws them
let observedTitles = null;
let noDragStyle = null;
let unsubscribe = null;
let paintFrame = 0;

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

// The header for a list: { prefix, name }, shown as "— prefix name —".
function headerFor(newMode, contextUri, name, label) {
  if (label) return label.prefix != null ? label : { prefix: '', name: label };
  const k = kind(contextUri);
  if (k === 'album') return { prefix: 'ALBUM \u00b7 ', name: name || '' };
  if (k === 'collection') return { prefix: '', name: 'LIKED SONGS' };
  if (k === 'playlist' && (name || contextNames[contextUri])) return { prefix: '', name: name || contextNames[contextUri] };
  return { prefix: '', name: 'UP NEXT' };
}

// The first row: the header (a label, not a track). `label` is a queue view's
// header from queueLabel (Autoplay, an artist), else it follows the source.
function installList(list, newMode, contextUri, name, label) {
  ctx.dispatch({ type: 'REMOVE_ALL_TRACKS' });
  const h = headerFor(newMode, contextUri, name, label);
  const header = { uri: null, name: '\u2014 ' + h.prefix + h.name + ' \u2014', headerPrefix: h.prefix, headerName: h.name,
    durationMs: 0, playable: false, isLabel: true, isHeader: true };
  entries = [header].concat(list).map((t, i) => Object.assign({ id: nextId++, position: i - 1 }, t));
  entries.forEach((e, i) => addRow(e.id, e.uri || 'winify:unavailable', e.name, e.durationMs, i));
  mode = newMode;
  listContext = contextUri;
  listName = name;
  currentIndex = -1;
  ctx.dispatch({ type: 'SET_PLAYLIST_SCROLL_POSITION', position: 0 });
  if (newMode === 'list') startOrder();
  highlight(true);
  if (newMode === 'list' && shuffleOn && currentIndex >= 0) applyShuffle();
  if (newMode === 'queue' && shuffleOn && h.name !== AUTOPLAY_LABEL && ctx.now.where === 'winify') handShuffleBack();
  paintSkips();
}

// Keep the current row on screen, but only when the track changes, so it
// never fights someone scrolling the list.
function scrollTo(index) {
  const state = ctx.webamp.store.getState();
  const visible = visibleCapacity(state);
  const overflow = state.playlist.trackOrder.length - visible;
  if (overflow <= 0 || visible === 0) return;
  const offset = Math.round((state.display.playlistScrollPosition / 100) * overflow);
  // The top slot is the (pinned) header's, so a row there is covered.
  const top = hasHeader() ? offset + 1 : offset;
  if (index >= top && index < offset + visible) return;
  const target = Math.max(0, Math.min(overflow, index - Math.floor(visible / 3)));
  ctx.dispatch({ type: 'SET_PLAYLIST_SCROLL_POSITION', position: (target / overflow) * 100 });
}

// How many rows the playlist window shows (Webamp's own formula), whether or
// not it has redrawn yet: a list just installed is counted before it is drawn.
function visibleCapacity(state) {
  const pl = state.windows && state.windows.genWindows && state.windows.genWindows.playlist;
  if (!pl || !pl.size) return document.querySelectorAll('#webamp .playlist-track-titles .track-cell').length;
  return Math.floor((58 + 29 * pl.size[1]) / 13);
}

// ---- Matching the playing track to a row --------------------------------------

function matches(e) {
  const n = ctx.now;
  return !!n.trackUri && (e.uri === n.trackUri || e.linkedUri === n.trackUri ||
    (!!n.linkedFromUri && e.uri === n.linkedFromUri));
}

function highlight(trackChanged) {
  if (mode === 'standin') { writeStandIn(); return; }
  if (trackChanged && mode === 'list' && currentIndex >= 0 && ordering() && followOrder()) return;

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
  if (wasMode === 'list' && !ending && retriedMissing !== key) {
    retriedMissing = key;
    ctx.log('playing track is not in the loaded list - reloading', listName || context);
    load(n.contextUri);
  } else if (wasMode === 'list') {
    autoplay = true;
    ending = false;
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
  if (meta && meta.name) contextNames[uri] = meta.name;
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
  if (autoplay) return AUTOPLAY_LABEL;
  if (k === 'none') {
    if (singleTrackUri && n.trackUri === singleTrackUri) return null;   // the track itself
    return singleTrackUri || cameFromList ? AUTOPLAY_LABEL : null;
  }
  if (k === 'artist') {
    if (!(contextUri in artistNames)) {
      try { artistNames[contextUri] = (await ctx.api('GET', '/artists/' + idOf(contextUri))).name; } catch (e) { artistNames[contextUri] = null; }
    }
    return artistNames[contextUri] ? { prefix: 'ARTIST \u00b7 ', name: artistNames[contextUri] } : 'ARTIST';
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
function takeOverNext() {
  if (!ctx || !plan || !plan.shown) return false;
  if (plan.jumping) return true;                       // already on its way
  if (!isPlanTrack(ctx.now)) return false;
  endAlbum('Next');
  return true;
}

// ---- Winify's own running order ---------------------------------------------
//
// For a full list (album, your playlist, Liked Songs) playing on Winify, the
// rows are Winify's running order rather than a mirror of Spotify's. Spotify
// cannot remove or reorder its queue, so the order is played one track ahead:
// QUEUE_LEAD_MS before a track ends, the order's next track is added to
// Spotify's queue and Spotify moves on to it by itself, as smoothly as it
// plays its own queue. Only that one track is ever added ahead. If the order
// changes after that, the added track still plays, and the order makes room
// for it: it moves up to be the current row. A track chosen on another
// device carries the order on from its row; one that is not in the list at
// all (queued elsewhere) joins it after the current row.
// When the order runs out (repeat off), the source is ended the way Play
// track does it, and Spotify's Autoplay carries on.

const ordering = () => !!ctx && mode === 'list' && ctx.now.where === 'winify' && listContext === ctx.now.contextUri;
const playable = (e) => !!e && !e.isLabel && e.playable && !e.skipped && !!e.uri;

function nextIndex(from) {
  for (let j = from + 1; j < entries.length; j++) if (playable(entries[j])) return j;
  if (ctx.now.repeat === 'context') {
    for (let j = 0; j <= from && j < entries.length; j++) if (playable(entries[j])) return j;
  }
  return -1;
}

function prevIndex(from) {
  for (let j = from - 1; j >= 0; j--) if (playable(entries[j])) return j;
  return -1;
}

// A new list: a new order.
function startOrder() {
  origOrder = entries.slice();
  preparedFor = null;
  expectId = null;
  ending = false;
  skipUndo = [];
  clearTimeout(orderTimer);
}

// Rows in a new order, the same entries; `cur` stays current.
function setOrder(list, cur) {
  entries = list;
  ctx.dispatch({ type: 'SET_TRACK_ORDER', trackOrder: entries.map((e) => e.id) });
  currentIndex = entries.indexOf(cur);
  paintSkips();
}

// A track started while the order runs. True when it has been placed.
function followOrder() {
  const n = ctx.now;
  if (ending) return false;
  const fromQueue = pending.findIndex((u) => u === n.trackUri || u === n.linkedFromUri);
  // Spotify plays its queue first, so anything listed before this one was
  // played or dropped; and if this one was not queued at all, nothing was
  // (unless Winify itself just started a track, which keeps the queue).
  if (fromQueue >= 0) pending.splice(0, fromQueue + 1);
  else if (expectId == null) pending = [];
  const cur = entries[currentIndex];
  let idx = -1;
  if (expectId != null) {
    const k = entries.findIndex((e) => e.id === expectId);
    if (k >= 0 && matches(entries[k])) idx = k;
  }
  expectId = null;
  if (idx < 0) {
    const k = nextIndex(currentIndex);
    if (k >= 0 && matches(entries[k])) idx = k;
  }
  if (idx < 0 && matches(cur)) idx = currentIndex;
  if (idx < 0) {
    const hits = [];
    entries.forEach((e, i) => { if (!e.isLabel && matches(e)) hits.push(i); });
    if (hits.length && fromQueue >= 0) {
      // Queued before the order changed, so not what the order has next; but
      // it is what plays: it moves up to play now, and the order carries on.
      const e = entries[hits.find((i) => i > currentIndex) ?? hits[0]];
      const list = entries.filter((x) => x !== e);
      list.splice(list.indexOf(cur) + 1, 0, e);
      setOrder(list, cur);
      idx = entries.indexOf(e);
      ctx.log('play order: Spotify played', e.name, 'from its queue, out of turn - moved up to play now');
    } else if (hits.length) {
      // Chosen elsewhere (another device): the order carries on from there.
      idx = hits.find((i) => i > currentIndex) ?? hits[0];
    } else if (nextIndex(currentIndex) < 0) {
      return false;                                      // the order had run out
    } else {
      // Queued on another device: it joins the order here.
      const e = { id: nextId++, uri: n.trackUri, linkedUri: n.linkedFromUri,
        name: (n.artist ? n.artist + ' - ' : '') + n.title, durationMs: n.durationMs,
        position: null, playable: true, inserted: true };
      addRow(e.id, e.uri, e.name, e.durationMs, currentIndex + 1);
      entries.splice(currentIndex + 1, 0, e);
      idx = currentIndex + 1;
    }
  }
  preparedFor = null;
  currentIndex = idx;
  makeCurrent(entries[idx].id);
  scrollTo(idx);
  paintSkips();
  return true;
}

// Called on every poll: arrange what happens when this track ends.
function scheduleOrder() {
  clearTimeout(orderTimer);
  const n = ctx.now;
  if (!ordering() || currentIndex < 0 || n.paused || ending || !n.durationMs || n.repeat === 'track') return;
  const cur = entries[currentIndex];
  if (!matches(cur)) return;
  const left = n.durationMs - ctx.positionMs();
  if (nextIndex(currentIndex) >= 0) {
    if (preparedFor !== cur.id) orderTimer = setTimeout(prepareNext, Math.max(0, left - QUEUE_LEAD_MS));
  } else if (n.repeat === 'off' && !pending.length) {
    orderTimer = setTimeout(() => endOrder('the order is ending'), Math.max(0, left - END_LEAD_MS));
  }
}

async function queueUri(uri) {
  ownQueueing.push(uri);
  pending.push(uri);
  try {
    await ctx.api('POST', '/me/player/queue?uri=' + encodeURIComponent(uri) +
      '&device_id=' + encodeURIComponent(ctx.deviceId()));
  } catch (err) {
    const o = ownQueueing.indexOf(uri);
    if (o >= 0) ownQueueing.splice(o, 1);
    const p = pending.lastIndexOf(uri);
    if (p >= 0) pending.splice(p, 1);
    throw err;
  }
}

// Shortly before the end: the order's next track goes into Spotify's queue.
async function prepareNext() {
  if (!ordering() || currentIndex < 0) return;
  const cur = entries[currentIndex];
  const k = nextIndex(currentIndex);
  if (preparedFor === cur.id || !matches(cur) || k < 0) return;
  preparedFor = cur.id;
  if (pending.length) return;                          // tracks you queued play first
  const e = entries[k];
  try {
    await queueUri(e.uri);
    ctx.log('play order: next up', e.name);
  } catch (err) {
    if (preparedFor === cur.id) preparedFor = null;
    ctx.warn('play order: could not queue the next track -', err.message);
  }
}

// The order has run out: play the source's last moment so it runs out too,
// and Spotify's Autoplay follows (as Play track does).
async function endOrder(why) {
  if (ending || !ordering()) return;
  const cur = entries[currentIndex];
  const last = entries.reduce((a, e) => (e.position != null && !e.isLabel && (!a || e.position > a.position) ? e : a), null);
  if (!last) return;
  if (last === cur && why !== 'Next') return;          // it ends by itself
  ending = true;
  clearTimeout(orderTimer);
  try {
    if (ctx.now.repeat !== 'off') {
      await ctx.api('PUT', '/me/player/repeat?state=off&device_id=' + encodeURIComponent(ctx.deviceId()));
    }
    if (last === cur) {
      await window.WinifyPlayer.seek(Math.max(0, ctx.now.durationMs - ALBUM_TAIL_MS));
    } else {
      await ctx.api('PUT', '/me/player/play?device_id=' + encodeURIComponent(ctx.deviceId()), {
        context_uri: listContext, offset: { position: last.position },
        position_ms: Math.max(0, last.durationMs - ALBUM_TAIL_MS),
      });
    }
    ctx.log('play order:', why, '- ending', listName || 'the source', 'so Spotify\'s Autoplay follows');
  } catch (err) {
    ending = false;
    ctx.warn('play order: could not move on to Autoplay -', err.message);
    ctx.say('Could not start Autoplay');
  }
  ctx.refreshSoon();
}

// Start an entry of the order now (Next, Previous, double-click).
async function startEntry(k) {
  const e = entries[k];
  expectId = e.id;
  preparedFor = null;
  clearTimeout(orderTimer);
  if (e.position != null) {
    await ctx.api('PUT', '/me/player/play?device_id=' + encodeURIComponent(ctx.deviceId()),
      { context_uri: listContext, offset: { position: e.position } });
  } else {
    // Not part of the source (a queued track): through the queue.
    await queueUri(e.uri);
    await window.WinifyPlayer.nextTrack();
  }
}

// Next/Previous while an order runs (or a Play track). True when handled.
export function takeOverSkip(direction) {
  if (direction === 1 && takeOverNext()) return true;
  if (!ordering() || currentIndex < 0) return false;
  const run = (p, what) => p.then(ctx.refreshSoon).catch((err) => {
    ctx.warn('play order:', what, 'failed -', err.message);
    ctx.say('Could not skip');
  });
  if (direction === 1) {
    if (pending.length) {
      // Already in Spotify's queue: Spotify's own skip reaches it.
      run(window.WinifyPlayer.nextTrack(), 'Next');
      return true;
    }
    const k = nextIndex(currentIndex);
    if (k < 0) endOrder('Next');
    else run(startEntry(k), 'Next');
    return true;
  }
  const k = prevIndex(currentIndex);
  if (ctx.positionMs() > RESTART_MS || k < 0) run(window.WinifyPlayer.seek(0), 'Previous');
  else run(startEntry(k), 'Previous');
  return true;
}

// Something was added to Spotify's queue (search, or a row's right-click):
// it plays next, so it goes in right after the current track, after any
// others queued before it.
export async function noteQueued(uri) {
  const own = ownQueueing.indexOf(uri);
  if (own >= 0) { ownQueueing.splice(own, 1); return; }
  if (!ctx || mode !== 'list' || currentIndex < 0) return;
  pending.push(uri);
  const known = entries.find((e) => e.uri === uri && !e.isLabel);
  let name = known && known.name;
  let durationMs = known && known.durationMs;
  if (!known) {
    try {
      const t = await ctx.api('GET', '/tracks/' + idOf(uri) + '?market=from_token');
      ({ name, durationMs } = row(t));
    } catch (e) { name = uri; durationMs = 0; }
    if (mode !== 'list' || currentIndex < 0) return;
  }
  let at = currentIndex + 1;
  while (entries[at] && entries[at].inserted) at++;
  const e = { id: nextId++, uri, name, durationMs, position: null, playable: true, inserted: true };
  addRow(e.id, uri, name, durationMs, at);
  entries.splice(at, 0, e);
  paintSkips();
  ctx.log('play order: queued', name, '- plays after the current track');
}

// ---- Editing the order ------------------------------------------------------------

export const canEdit = () => !!ctx && mode === 'list';

// Rows can be dragged in an order, but never the header.
export function canDrag() {
  if (!canEdit()) return false;
  const header = entries[0] && entries[0].isHeader ? entries[0].id : null;
  return !ctx.webamp.store.getState().playlist.selectedTracks.includes(header);
}

// Rows were dragged (Webamp has already moved them): the order follows. A
// track dragged above the header puts the header back on top.
export function reordered() {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const cur = entries[currentIndex];
  let list = ctx.webamp.store.getState().playlist.trackOrder.map((id) => byId.get(id)).filter(Boolean);
  if (list.length !== entries.length) return;
  const header = list.find((e) => e.isHeader);
  if (header && list[0] !== header) {
    list = [header].concat(list.filter((e) => e !== header));
    ctx.dispatch({ type: 'SET_TRACK_ORDER', trackOrder: list.map((e) => e.id) });
  }
  entries = list;
  currentIndex = entries.indexOf(cur);
  paintSkips();
}

// Skip (skip = true) or restore entries; recorded for Cmd+Z.
function setSkipped(list, skip) {
  const changed = list.filter((e) => e && !e.isLabel && !!e.skipped !== skip);
  if (!changed.length) return;
  changed.forEach((e) => { e.skipped = skip; });
  skipUndo.push({ entries: changed, skip });
  paintSkips();
  const verb = skip ? 'Skipping' : 'Not skipping';
  ctx.say(changed.length === 1 ? verb + ': ' + changed[0].name : verb + ' ' + changed.length + ' tracks');
  ctx.log('play order:', verb.toLowerCase(), changed.map((e) => e.name).join(', '));
  scheduleOrder();
}

// REM, Delete: a toggle. Skipped tracks stay listed. If every selected
// track is skipped already, they are restored; otherwise the rest are skipped.
export function skipIds(ids) {
  const set = new Set(ids.map(Number));
  const chosen = entries.filter((e) => set.has(e.id) && !e.isLabel);
  if (!chosen.length) return;
  setSkipped(chosen, !chosen.every((e) => e.skipped));
}

// Cmd+Z: undo the last skip or restore.
function undoSkip() {
  const last = skipUndo.pop();
  if (!last) { ctx.say('Nothing to undo'); return; }
  last.entries.forEach((e) => { e.skipped = !last.skip; });
  paintSkips();
  const verb = last.skip ? 'Not skipping' : 'Skipping';
  ctx.say(last.entries.length === 1 ? verb + ': ' + last.entries[0].name : verb + ' ' + last.entries.length + ' tracks');
  scheduleOrder();
}

function onKeyDown(e) {
  if (!ctx || e.altKey || e.ctrlKey) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
  const state = ctx.webamp.store.getState();
  if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey) {
    if (state.windows.focused !== 'playlist' || !state.playlist.selectedTracks.length) return;
    e.preventDefault();
    if (mode === 'list') skipIds(state.playlist.selectedTracks);
    else readOnlyNote();
  } else if (mode === 'list' && (e.key === 'z' || e.key === 'Z') && e.metaKey && !e.shiftKey) {
    e.preventDefault();
    undoSkip();
  }
}

// REM skips (or restores) the selected rows at once, like Delete, in place
// of Webamp's REM SEL / CROP / REM ALL menu.
function onRemClick(e) {
  if (!ctx || !(e.target instanceof Element) || !e.target.closest('#webamp #playlist-remove-menu')) return;
  e.preventDefault();
  e.stopPropagation();
  if (mode !== 'list') { readOnlyNote(); return; }
  const selected = ctx.webamp.store.getState().playlist.selectedTracks;
  if (!selected.length) { ctx.say('Select tracks to skip'); return; }
  skipIds(selected);
}

// Lists that are Spotify's own (Autoplay, Up Next) cannot be edited; say so.
function readOnlyNote() {
  const isAutoplay = entries[0] && entries[0].isLabel && entries[0].name.includes(AUTOPLAY_LABEL);
  ctx.say(isAutoplay ? 'Autoplay is from Spotify - read only' : 'Up Next is from Spotify - read only');
}

// ...and a drag there shows a not-allowed cursor rather than doing nothing.
let dragFrom = null;
function onPointerDown(e) {
  dragFrom = ctx && mode !== 'list' && e.button === 0 && e.target instanceof Element &&
    e.target.closest('#webamp .track-cell') ? e.clientY : null;
}
function onPointerMove(e) {
  if (dragFrom == null || !(e.buttons & 1)) return;
  if (Math.abs(e.clientY - dragFrom) >= DRAG_THRESHOLD_PX) document.documentElement.classList.add('winify-no-drag');
}
function onPointerUp() {
  dragFrom = null;
  document.documentElement.classList.remove('winify-no-drag');
}

// Webamp draws only the visible rows; the first one shown is this row of the
// list (Webamp's own offset arithmetic).
function visibleOffset(cells) {
  const state = ctx.webamp.store.getState();
  const overflow = Math.max(0, state.playlist.trackOrder.length - cells.length);
  return Math.round((state.display.playlistScrollPosition / 100) * overflow);
}

// Skipped rows are dimmed and struck through, rewritten for whatever is on
// screen after each redraw; the pinned header is kept in place.
function paintSkips() {
  if (paintFrame) return;
  paintFrame = requestAnimationFrame(() => {
    paintFrame = 0;
    if (!skipStyle) return;
    watchNumbers();
    drawHeader();
    const rules = [];
    if (mode === 'list') {
      const cells = document.querySelectorAll('#webamp .playlist-track-titles .track-cell');
      const first = visibleOffset(cells);
      for (let i = 0; i < cells.length; i++) {
        if (entries[first + i] && entries[first + i].skipped) {
          rules.push(`#webamp .playlist-track-titles .track-cell:nth-child(${i + 1})`,
            `#webamp .playlist-track-durations .track-cell:nth-child(${i + 1})`);
        }
      }
    }
    const css = rules.length ? rules.join(',\n') + ' { opacity: 0.45; text-decoration: line-through; }' : '';
    if (skipStyle.textContent !== css) skipStyle.textContent = css;
  });
}

// ---- The header ---------------------------------------------------------------------
// Webamp numbers every row; with a header first, the header gets no number and
// the tracks count from 1 under it. Webamp writes each row's number as its own
// text node ("12", ". ", title), so only those are rewritten, as soon as Webamp
// redraws them (a MutationObserver runs before the screen is painted).

const hasHeader = () => !!entries[0] && !!entries[0].isHeader;

function renumber() {
  if (!ctx || !hasHeader()) return;
  const cells = document.querySelectorAll('#webamp .playlist-track-titles .track-cell');
  const offset = visibleOffset(cells);
  const width = String(Math.max(1, entries.length - 1)).length;
  cells.forEach((cell, i) => {
    const nodes = cell.firstElementChild ? cell.firstElementChild.childNodes : [];
    if (nodes.length < 3 || nodes[0].nodeType !== Node.TEXT_NODE || nodes[1].nodeType !== Node.TEXT_NODE) return;
    const index = offset + i;
    const number = index === 0 ? '' : String(index).padStart(width, '\u00a0');
    const dot = index === 0 ? '' : '. ';
    if (nodes[0].nodeValue !== number) nodes[0].nodeValue = number;
    if (nodes[1].nodeValue !== dot) nodes[1].nodeValue = dot;
  });
}

function watchNumbers() {
  const titles = document.querySelector('#webamp .playlist-track-titles');
  if (titles === observedTitles) { renumber(); return; }
  if (numberObserver) numberObserver.disconnect();
  observedTitles = titles;
  if (!titles) return;
  numberObserver = numberObserver || new MutationObserver(renumber);
  numberObserver.observe(titles, { subtree: true, childList: true, characterData: true });
  renumber();
}

// The pinned header: drawn over the list's top row, where the header row
// itself sits at the top of the list. Scrolled, the tracks pass under it.
// Long names end in "…", with the full name as a tooltip.
function drawHeader() {
  const tracks = document.querySelector('#webamp .playlist-tracks');
  if (!hasHeader() || !tracks) {
    if (headerEl) { headerEl.remove(); headerEl = null; }
    return;
  }
  if (!headerEl || headerEl.parentElement !== tracks) {
    if (headerEl) headerEl.remove();
    headerEl = document.createElement('div');
    headerEl.className = 'winify-list-header';
    headerEl.innerHTML = '<span class="wh-lead"></span><span class="wh-name"></span><span class="wh-tail"> \u2014</span>';
    headerEl.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); playFromTop(); });
    for (const type of ['mousedown', 'click', 'contextmenu']) {
      headerEl.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); });
    }
    tracks.appendChild(headerEl);
  }
  const h = entries[0];
  const st = ctx.webamp.store.getState().display.skinPlaylistStyle || {};
  const cell = document.querySelector('#webamp .playlist-track-titles .track-cell');
  const cs = cell ? getComputedStyle(cell) : null;
  Object.assign(headerEl.style, {
    color: st.normal || '#00FF00', background: st.normalbg || '#000000',
    fontFamily: cs ? cs.fontFamily : (st.font || 'Arial'), fontSize: cs ? cs.fontSize : '9px',
  });
  const lead = '\u2014 ' + h.headerPrefix;
  if (headerEl.firstChild.textContent !== lead) headerEl.firstChild.textContent = lead;
  if (headerEl.children[1].textContent !== h.headerName) headerEl.children[1].textContent = h.headerName;
  const full = h.headerPrefix + h.headerName;
  if (headerEl.title !== full) headerEl.title = full;
}

// Double-click on the header: the list from its first track.
async function playFromTop() {
  if (!ctx) return;
  try {
    if (mode === 'list') {
      const k = nextIndex(0);
      if (k < 0) return;
      await startEntry(k);
      ctx.log('header: playing', listName || listContext, 'from', entries[k].name);
    } else if (mode === 'queue' && kind(listContext) === 'artist') {
      // An artist plays as Spotify chooses; starting it again is "from the top".
      await ctx.api('PUT', '/me/player/play?device_id=' + encodeURIComponent(ctx.deviceId()), { context_uri: listContext });
      ctx.log('header: playing', entries[0].headerName, 'again');
    } else if (mode === 'queue') {
      // Up Next and Autoplay start with the playing track.
      await window.WinifyPlayer.seek(0);
    }
  } catch (err) {
    ctx.warn('header: could not play the list -', err.message);
    ctx.say('Could not play that');
  }
  ctx.refreshSoon();
}

// ---- Shuffle ------------------------------------------------------------------------

export const ownsShuffle = () => !!ctx && mode === 'list';
export const shuffled = () => shuffleOn;

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// Shuffle on: the current track, then the rest of the source in random order.
// Off: the source's own order, carrying on from the current track's place in
// it. Skips are kept either way.
function applyShuffle() {
  // The playing track, even if this poll has not placed it yet.
  const cur = matches(entries[currentIndex]) ? entries[currentIndex] : entries.find((e) => !e.isLabel && matches(e)) || entries[currentIndex];
  if (!cur) return;
  currentIndex = entries.indexOf(cur);
  // Queued tracks are not part of the source and are never shuffled: those
  // already played stay before the current track, the rest come right after.
  const extra = entries.filter((e) => !origOrder.includes(e) && e !== cur);
  const played = extra.filter((e) => entries.indexOf(e) < currentIndex);
  const toCome = extra.filter((e) => entries.indexOf(e) > currentIndex);
  let list;
  const header = origOrder.filter((e) => e.isHeader);
  if (shuffleOn) {
    list = header.concat(played, [cur], toCome, shuffle(origOrder.filter((e) => e !== cur && !e.isLabel)));
  } else {
    list = origOrder.slice();
    if (!list.includes(cur)) list.splice(header.length, 0, cur);         // a queued track: under the header
    list.splice(list.indexOf(cur), 0, ...played);
    list.splice(list.indexOf(cur) + 1, 0, ...toCome);
  }
  preparedFor = null;
  setOrder(list, cur);
  makeCurrent(cur.id);
  ctx.dispatch({ type: 'SET_PLAYLIST_SCROLL_POSITION', position: 0 });
  scrollTo(currentIndex);
  scheduleOrder();
}

// Spotify's shuffle, set from Winify where Winify keeps no order: remembered,
// so the next order starts the same way.
export function noteSpotifyShuffle(on) { shuffleOn = !!on; }

export function setShuffle(on) {
  shuffleOn = !!on;
  if (mode === 'list') applyShuffle();
  ctx.log('play order: shuffle', shuffleOn ? 'on (Winify\'s)' : 'off - back to the original order');
  turnSpotifyShuffleOff();
  showShuffle();
}

// The Shuffle button shows Winify's shuffle straight away (a click flips
// what it shows, so it must never lag behind).
function showShuffle() {
  if (ctx.webamp.store.getState().media.shuffle !== shuffleOn) ctx.dispatch({ type: 'TOGGLE_SHUFFLE' });
}

function turnSpotifyShuffleOff() {
  if (!ctx.now.shuffle || ctx.now.where !== 'winify') return;
  ctx.now.shuffle = false;
  shuffleTakenAt = performance.now();
  ctx.api('PUT', '/me/player/shuffle?state=false&device_id=' + encodeURIComponent(ctx.deviceId()))
    .catch((err) => ctx.warn('could not turn Spotify\'s shuffle off -', err.message));
}

// Spotify's shuffle turned on (elsewhere) while an order runs: Winify takes it.
function takeOverShuffle() {
  if (!ordering() || !ctx.now.shuffle || performance.now() - shuffleTakenAt < SHUFFLE_TAKEOVER_MS) return;
  ctx.log('play order: Spotify\'s shuffle is on - Winify shuffles its own order instead');
  if (!shuffleOn) { shuffleOn = true; applyShuffle(); }
  turnSpotifyShuffleOff();
  showShuffle();
}

// A source Winify cannot order (artist, followed playlist): Spotify shuffles.
function handShuffleBack() {
  if (ctx.now.shuffle) return;
  ctx.now.shuffle = true;
  ctx.api('PUT', '/me/player/shuffle?state=true&device_id=' + encodeURIComponent(ctx.deviceId()))
    .catch((err) => ctx.warn('could not turn Spotify\'s shuffle on -', err.message));
}

// ---- Called by webamp-spotify.js ----------------------------------------------

export function init(c) {
  ctx = c;
  document.addEventListener('dblclick', onDoubleClickCapture, true);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('click', onRemClick, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  skipStyle = document.createElement('style');
  skipStyle.id = 'winify-skipped';
  document.head.appendChild(skipStyle);
  noDragStyle = document.createElement('style');
  noDragStyle.textContent = '.winify-no-drag, .winify-no-drag * { cursor: not-allowed !important; }' +
    ' #webamp .playlist-tracks { position: relative; }' +
    // Each playlist menu button carries its pop-up's bar, invisible while the
    // menu is shut but reaching up over the list's last rows: a click there
    // would press REM or MISC. Let it reach the row underneath instead.
    ' #webamp .playlist-menu:not(.selected) .bar { pointer-events: none; }' +
    ' #webamp .winify-list-header { position: absolute; left: 0; right: 0; top: 0; height: 13px; line-height: 13px; display: flex; white-space: nowrap; overflow: hidden; z-index: 1; cursor: default; user-select: none; }' +
    ' #webamp .winify-list-header .wh-name { overflow: hidden; text-overflow: ellipsis; min-width: 0; }' +
    ' #webamp .winify-list-header .wh-lead, #webamp .winify-list-header .wh-tail { flex: none; white-space: pre; }';
  document.head.appendChild(noDragStyle);
  unsubscribe = ctx.webamp.store.subscribe(paintSkips);
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
  clearTimeout(orderTimer);
  document.removeEventListener('dblclick', onDoubleClickCapture, true);
  document.removeEventListener('keydown', onKeyDown);
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  if (skipStyle) skipStyle.remove();
  skipStyle = null;
  if (noDragStyle) noDragStyle.remove();
  noDragStyle = null;
  if (numberObserver) numberObserver.disconnect();
  numberObserver = null;
  observedTitles = null;
  if (headerEl) headerEl.remove();
  headerEl = null;
  document.removeEventListener('click', onRemClick, true);
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('pointermove', onPointerMove, true);
  document.removeEventListener('pointerup', onPointerUp, true);
  onPointerUp();
  pending = [];
  ownQueueing.length = 0;
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
  syncSource();
  if (!ctx) return;
  takeOverShuffle();
  scheduleOrder();
}

function syncSource() {
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
  if (e && e.isHeader) { playFromTop(); return; }
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
    if (mode === 'list') {
      // The running order carries on from this row.
      await startEntry(index);
      ctx.log('double-click: playing', e.name, 'in', listName || contextUri);
    } else if (contextUri && OFFSET_CONTEXTS.has(k)) {
      // Same context, starting at this row (the list is the queue, whose
      // order is not the context's, so by URI).
      const offset = { uri: e.uri };
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
    header: hasHeader() ? entries[0].name : null,
    line: mode === 'single' ? entries[1].name : null,
    plan: plan && { uri: plan.uri, shown: plan.shown, jumping: !!plan.jumping, last: plan.last || null },
    order: mode === 'list' ? { shuffle: shuffleOn, pending: pending.slice(), ending,
      skipped: entries.filter((e) => e.skipped).map((e) => e.name),
      names: entries.map((e) => e.name) } : null }),
};
