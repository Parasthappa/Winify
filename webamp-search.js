/* Jump to track: search your own playlists or all of Spotify, and play or
 * queue a track, styled like classic Winamp's "Jump to file".
 *
 * Two modes, switched with Tab and shown in the bottom bar. My playlists
 * (the default) searches the local index of your playlists and Liked Songs
 * (webamp-library-index.js) as you type, with no requests: each song lists
 * every playlist it is in (Left/Right picks which, shown in brackets), Enter
 * plays it within that playlist (so the playlist carries on after it),
 * Shift+Enter queues it, and right-click also offers the playlist from the
 * top. All of Spotify searches Spotify, as below.
 *
 * Opened by J, the main window's Play > Jump to track..., the menu bar, and
 * the playlist window's ADD button, all alike: Enter or double-click plays
 * just that track, then Spotify's Autoplay (see webamp-playlist.js: Play
 * track); Shift+Enter adds it to Spotify's queue without interrupting what
 * is playing, and the window stays open for more. Right-click offers both,
 * plus Play album (from that track) and Play artist. Playlist window rows
 * get a Play / Add to queue menu.
 *
 * Read-only towards your library: nothing is added to any playlist.
 * Drawn with the active skin's own playlist bitmaps, like the playlist picker.
 */

import { makeDraggable, makeResizable, attachTooltips, hideTooltip } from './webamp-dialog.js';
import { makeFrame, FRAME_CSS } from './webamp-frame.js';
import * as panels from './webamp-panels.js';
import * as index from './webamp-library-index.js';

const RESULTS_PER_REQUEST = 10;     // Spotify's search maximum since February 2026
const PAGES = 3;                    // about 30 results
const DEBOUNCE_MS = 300;
const ROW = 13;                     // Webamp's playlist row height
const WIDTH = 475;                  // the playlist window plus eight segments
// As many rows as its height holds (it is resizable).
const visibleRows = () => {
  const list = el && el.querySelector('.ws-list');
  return Math.max(1, Math.floor(((list && list.clientHeight) || 16 * ROW) / ROW));
};
const FLASH_MS = 2500;

let ctx = null;                     // { webamp, api, say, log, warn, deviceId, refreshSoon, now }
let playlist = null;                // the playlist module, for row lookups
let el = null;
let opening = false;
let results = [];
let selected = 0;
let scroll = 0;
let status = null;
let mode = 'mine';                  // 'mine' (My playlists) | 'spotify' (All of Spotify)
let chosenSeq = 0;                  // Left/Right changed a row's playlist: redraw
let stopIndexNote = null;
let searchSeq = 0;
let debounceTimer = null;
let flashTimer = null;
let drawnKey = null;

// ---- Spotify ------------------------------------------------------------------

function trackRow(t) {
  return {
    uri: t.uri,
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album ? t.album.name : '',
    albumUri: t.album ? t.album.uri : null,
    albumTracks: t.album && t.album.total_tracks ? t.album.total_tracks : null,
    artistUri: t.artists && t.artists[0] ? t.artists[0].uri : null,
    artistName: t.artists && t.artists[0] ? t.artists[0].name : '',
    durationMs: t.duration_ms || 0,
    playable: t.is_playable !== false,
  };
}

function describe(err) {
  if (!err || err.status == null) return "Couldn't reach Spotify - check your connection";
  if (err.status === 429) return 'Spotify asked to slow down - try again in a moment';
  if (err.status === 401 || err.status === 403) return 'Spotify refused the search';
  return 'Search failed (' + err.status + ')';
}

const MODES = { mine: 'my playlists', spotify: 'all of spotify' };

// What the list says with nothing typed.
function prompt() {
  if (mode === 'spotify') return 'Type to search Spotify';
  const st = index.status();
  if (st.building) return index.progressNote() + (st.songs ? ' - type to search what is in' : '');
  return st.songs ? 'Type to search your playlists' : 'Your playlists are not indexed yet';
}

// My playlists: at once, from the index. `keep` holds on to the selected song
// (the index grew while results were showing).
function searchMine(query, keep) {
  searchSeq++;
  const was = keep && results[selected] && results[selected].uri;
  const chosen = keep ? new Map(results.filter((r) => r.chosen).map((r) => [r.uri, r.places[r.chosen].uri])) : new Map();
  results = query ? index.search(query).map((r) => {
    const at = r.places.findIndex((p) => p.uri === chosen.get(r.uri));
    return Object.assign({ chosen: Math.max(0, at) }, r);
  }) : [];
  status = !query ? prompt() : results.length ? null : 'No results in your playlists';
  const at = was ? results.findIndex((r) => r.uri === was) : -1;
  selected = at >= 0 ? at : 0;
  if (at < 0) scroll = 0;
  drawnKey = null;
  render();
}

function runQuery(query) {
  clearTimeout(debounceTimer);
  if (mode === 'mine') searchMine(query);
  else search(query);
}

async function search(query) {
  const seq = ++searchSeq;
  if (!query) { results = []; status = prompt(); render(); return; }
  status = 'Searching...';
  render();
  const q = encodeURIComponent(query);
  try {
    const pages = await Promise.all(Array.from({ length: PAGES }, (_, i) =>
      ctx.api('GET', '/search?type=track&market=from_token&limit=' + RESULTS_PER_REQUEST +
        '&offset=' + i * RESULTS_PER_REQUEST + '&q=' + q)));
    if (seq !== searchSeq || !el) return;                 // a newer search won
    const seen = new Set();
    results = [];
    for (const p of pages) {
      for (const t of ((p && p.tracks && p.tracks.items) || [])) {
        if (t && t.uri && !seen.has(t.uri)) { seen.add(t.uri); results.push(trackRow(t)); }
      }
    }
    status = results.length ? null : 'No results';
    selected = 0;
    scroll = 0;
  } catch (err) {
    if (seq !== searchSeq || !el) return;
    ctx.warn('search failed -', err.message);
    results = [];
    status = describe(err);
  }
  render();
}

// Start playback on Winify; the window stays open (panels close only with x
// or Escape). `what` names it for the log.
async function start(r, body, what) {
  if (!r) return;
  if (!r.playable) { flash('NOT PLAYABLE'); return; }
  const deviceId = ctx.deviceId();
  if (!deviceId) { flash('NOT READY'); ctx.say('Winify device not ready'); return; }
  try {
    await ctx.api('PUT', '/me/player/play?device_id=' + encodeURIComponent(deviceId), body);
    ctx.log('jump to track: playing', what);
  } catch (err) {
    ctx.warn('jump to track: could not play -', err.message);
    ctx.say('Could not play that');
  }
  ctx.refreshSoon();
}

// Just this track, then Spotify's Autoplay. A track played on its own stops
// at its end (Spotify autoplays only after an album or playlist ends), so it
// plays within its album, and the playlist module ends the album right after
// it. Without an album it can only be played on its own.
function play(r) {
  if (r && r.playable) playlist.expectSingleTrack({ uri: r.uri, albumUri: r.albumUri, albumTracks: r.albumTracks });
  if (!r || !r.albumUri) return start(r, { uris: [r.uri] }, r && (r.artist + ' - ' + r.title));
  return start(r, { context_uri: r.albumUri, offset: { uri: r.uri } }, r.artist + ' - ' + r.title + ' (then Autoplay)');
}

// My playlists: the song within the playlist picked for it, so that playlist
// carries on after it. By position (a song can be in a playlist twice) while
// the index has the playlist as it is; Liked Songs, or a playlist changed
// since, by the song itself.
function playInPlaylist(r, place = r && r.places[r.chosen]) {
  if (!r || !place) return;
  const byUri = /:collection$/.test(place.uri) || !index.current(place.uri);
  return start(r, { context_uri: place.uri, offset: byUri ? { uri: r.uri } : { position: place.position } },
    r.artist + ' - ' + r.title + ' in "' + place.name + '"');
}

function playPlaylistFromTop(r, place = r && r.places[r.chosen]) {
  if (!place) return;
  return start({ playable: true }, { context_uri: place.uri, offset: { position: 0 } }, '"' + place.name + '" from the top');
}

// The track's album, from this track.
function playAlbum(r) {
  if (!r || !r.albumUri) return play(r);
  return start(r, { context_uri: r.albumUri, offset: { uri: r.uri } }, 'album ' + r.album + ' from ' + r.title);
}

// The track's (first) artist as the source. Spotify takes no starting track
// for an artist, so it begins wherever Spotify chooses.
function playArtist(r) {
  if (!r || !r.artistUri) return play(r);
  return start(r, { context_uri: r.artistUri }, 'artist ' + r.artistName);
}

// Queued to the active session: Winify's if it is playing, otherwise wherever
// Spotify is playing. Queuing never interrupts.
export async function queue(uri, name) {
  if (!ctx || !uri) return false;
  const deviceId = ctx.now.where === 'winify' ? ctx.deviceId() : null;
  try {
    await ctx.api('POST', '/me/player/queue?uri=' + encodeURIComponent(uri) +
      (deviceId ? '&device_id=' + encodeURIComponent(deviceId) : ''));
    ctx.say('Queued: ' + name);
    flash('QUEUED');
    ctx.log('queued', name, deviceId ? 'on Winify' : 'on the active device');
    return true;
  } catch (err) {
    const nothing = err.status === 404;
    ctx.warn('queue failed -', err.message);
    ctx.say(nothing ? 'Nothing playing - press Play first' : 'Could not queue that track');
    flash(nothing ? 'NOTHING PLAYING' : 'QUEUE FAILED');
    return false;
  }
}

function queueRow(r) {
  if (r && r.playable) queue(r.uri, r.artist + ' - ' + r.title);
  else if (r) flash('NOT PLAYABLE');
}

// What Enter and double-click do, and what Shift+Enter does instead.
const primary = (r) => (mode === 'mine' ? playInPlaylist(r) : play(r));
const secondary = queueRow;

const TITLE = 'Jump to track';
const HINT = 'tab: mode  enter: play  shift+enter: queue  right-click: more';

// A song's playlists, the one Enter plays in bracketed (when there is a choice).
const placesText = (r) => r.places.map((p, i) => (r.places.length > 1 && i === r.chosen ? '[' + p.name + ']' : p.name)).join(', ');

// ---- Drawing ------------------------------------------------------------------

function skinStyle() {
  const s = ctx.webamp.store.getState().display.skinPlaylistStyle || {};
  return {
    normal: s.normal || '#00FF00',
    current: s.current || '#FFFFFF',
    normalbg: s.normalbg || '#000000',
    selectedbg: s.selectedbg || '#0000C6',
    font: s.font || 'Arial',
  };
}

// Text in the skin's marquee font. Webamp keys its glyphs by lowercase code.
function skinText(text) {
  const span = document.createElement('span');
  span.className = 'winify-search-chars';
  for (const ch of text.toLowerCase()) {
    const c = document.createElement('span');
    c.className = 'character character-' + ch.charCodeAt(0);
    span.appendChild(c);
  }
  return span;
}

const mmss = (ms) => {
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

function injectStyles() {
  if (document.getElementById('winify-search-style')) return;
  const style = document.createElement('style');
  style.id = 'winify-search-style';
  style.textContent = `
    #webamp .winify-search { z-index: 100001; }
    #webamp .winify-search .ws-main { flex: 1; min-height: 0; display: flex; }
    #webamp .winify-search .ws-scroll { flex: none; width: 8px; position: relative; }
    #webamp .winify-search .ws-handle { position: absolute; left: 0; width: 8px; height: 18px; }
    #webamp .winify-search .ws-info { flex: none; height: 13px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 3px; min-width: 0; overflow: hidden; white-space: nowrap; }
    #webamp .winify-search .winify-search-chars { display: inline-flex; line-height: 0; }
    #webamp .winify-search .character { display: inline-block; width: 5px; height: 6px; }
    #webamp .winify-search .ws-body { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    #webamp .winify-search .ws-query { height: 13px; box-sizing: border-box; border: 0; border-bottom: 1px solid; outline: none; padding: 0 2px; font-size: 9px; width: 100%; }
    #webamp .winify-search .ws-list { flex: 1; min-height: 0; overflow: hidden; font-size: 9px; }
    #webamp .winify-search .ws-row { height: ${ROW}px; line-height: ${ROW}px; display: flex; gap: 6px; padding: 0 2px; white-space: nowrap; cursor: default; user-select: none; }
    #webamp .winify-search .ws-row > span { overflow: hidden; text-overflow: ellipsis; }
    #webamp .winify-search .ws-title-col { flex: 0 0 34%; }
    #webamp .winify-search .ws-artist-col { flex: 0 0 24%; }
    #webamp .winify-search .ws-album-col { flex: 1 1 0; }
    #webamp .winify-search .ws-time-col { flex: none; width: 28px; text-align: right; }
    #webamp .winify-search .ws-row.ws-unplayable { opacity: .5; }

    ${FRAME_CSS}
  `;
  document.head.appendChild(style);
}

function paintSelection() {
  const st = skinStyle();
  el.querySelectorAll('.ws-list .ws-row[data-index]').forEach((row) => {
    row.style.background = Number(row.dataset.index) === selected ? st.selectedbg : '';
  });
}

function render() {
  if (!el) return;
  // Rebuild rows only when the results or the scroll change; a selection
  // change restyles in place, or a double-click's second click would land on
  // a new element and never register.
  const VISIBLE_ROWS = visibleRows();
  const key = mode + '|' + chosenSeq + '|' + scroll + '|' + VISIBLE_ROWS + '|' + results.length + '|' + (results[0] && results[0].uri) + '|' + status;
  if (key === drawnKey) { paintSelection(); return; }
  drawnKey = key;
  const st = skinStyle();
  const list = el.querySelector('.ws-list');
  list.textContent = '';
  if (status) {
    const row = document.createElement('div');
    row.className = 'ws-row ws-status';
    row.style.color = st.normal;
    row.textContent = status;
    list.appendChild(row);
  } else {
    results.slice(scroll, scroll + VISIBLE_ROWS).forEach((r, i) => {
      const index = scroll + i;
      const row = document.createElement('div');
      row.className = 'ws-row' + (r.playable ? '' : ' ws-unplayable');
      row.dataset.index = String(index);
      row.style.color = st.normal;
      if (index === selected) row.style.background = st.selectedbg;
      const cells = [
        ['ws-title-col', (index + 1) + '. ' + r.title],
        ['ws-artist-col', r.artist],
        ['ws-album-col', mode === 'mine' ? placesText(r) : r.album],
        ['ws-time-col', mmss(r.durationMs)],
      ];
      for (const [cls, text] of cells) {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = text;
        row.appendChild(span);
      }
      list.appendChild(row);
    });
  }
  const track = el.querySelector('.ws-scroll');
  const handle = el.querySelector('.ws-handle');
  const overflow = Math.max(0, results.length - VISIBLE_ROWS);
  handle.style.display = !status && overflow ? '' : 'none';
  handle.style.top = (overflow ? Math.round((scroll / overflow) * (track.clientHeight - 18)) : 0) + 'px';
  if (!flashTimer) drawBottom();
}

function drawBottom(message) {
  const bar = el.querySelector('.ws-info');
  bar.textContent = '';
  const note = mode === 'mine' && index.status().building ? 'indexing ' + index.status().done + '/' + index.status().total
    : results.length && !status ? results.length + ' tracks' : '';
  bar.appendChild(skinText(message || (MODES[mode] + (note ? ': ' + note : ''))));
  bar.appendChild(skinText(HINT));
}

// A short confirmation in the dialog's bottom bar.
function flash(message) {
  if (!el) return;
  clearTimeout(flashTimer);
  drawBottom(message);
  flashTimer = setTimeout(() => { flashTimer = null; if (el) drawBottom(); }, FLASH_MS);
}

function select(index) {
  if (!results.length || status) return;
  selected = Math.max(0, Math.min(results.length - 1, index));
  const VISIBLE_ROWS = visibleRows();
  if (selected < scroll) scroll = selected;
  if (selected >= scroll + VISIBLE_ROWS) scroll = selected - VISIBLE_ROWS + 1;
  render();
}

function rowAt(target) {
  const row = target.closest('.ws-row');
  return row && row.dataset.index ? Number(row.dataset.index) : null;
}

function build(spot) {
  injectStyles();
  const st = skinStyle();
  const root = document.querySelector('#webamp');
  // Webamp's generic window frame, in the skin's lettering (webamp-frame.js).
  const frame = makeFrame({ title: TITLE, cls: 'winify-search', prefix: 'ws' });
  const d = frame.root;
  frame.content.innerHTML = `
    <div class="ws-main">
      <div class="ws-body">
        <input class="ws-query" type="text" spellcheck="false">
        <div class="ws-list" role="listbox"></div>
      </div>
      <div class="ws-scroll"><div class="ws-handle playlist-scrollbar-handle"></div></div>
    </div>
    <div class="ws-info"></div>`;
  for (const part of ['.ws-scroll', '.ws-info']) frame.content.querySelector(part).style.background = st.normalbg;
  const body = d.querySelector('.ws-body');
  body.style.background = st.normalbg;
  body.style.fontFamily = st.font;
  const input = d.querySelector('.ws-query');
  Object.assign(input.style, { background: st.normalbg, color: st.normal, borderColor: st.normal, fontFamily: st.font });

  place(d, spot);
  makeDraggable(d, frame.top, { ignore: '.ws-close', onMoved: (rect) => panels.placed('search', rect) });
  makeResizable(d, { grip: frame.grip, minWidth: panels.MIN_SIZE.w, minHeight: panels.MIN_SIZE.h, onResize: () => render(),
    onResized: (rect) => panels.placed('search', rect) });
  attachTooltips(d.querySelector('.ws-list'), d, frame.top, '.ws-row > span', skinStyle);

  d.querySelector('.ws-close').addEventListener('click', () => close());
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = input.value.trim();
    if (mode === 'mine') searchMine(query);
    else debounceTimer = setTimeout(() => search(query), DEBOUNCE_MS);
  });
  input.addEventListener('keydown', onKey);
  const list = d.querySelector('.ws-list');
  list.addEventListener('click', (e) => { const i = rowAt(e.target); if (i != null) select(i); });
  list.addEventListener('dblclick', (e) => { const i = rowAt(e.target); if (i != null) primary(results[i]); });
  list.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const i = rowAt(e.target);
    if (i == null) return;
    select(i);
    const r = results[i];
    if (mode === 'mine') {
      showMenu(e.clientX, e.clientY, [
        { label: 'Play track', hotkey: 'Enter', action: () => playInPlaylist(r), disabled: !r.playable },
        { label: 'Add to queue', hotkey: 'Shift+Enter', action: () => queueRow(r), disabled: !r.playable },
        { label: 'Play this playlist from the top', action: () => playPlaylistFromTop(r) },
      ].concat(r.places.length > 1 ? r.places.map((p) => ({ label: 'Play in ' + p.name, action: () => playInPlaylist(r, p), disabled: !r.playable })) : []));
      return;
    }
    showMenu(e.clientX, e.clientY, [
      { label: 'Play track', hotkey: 'Enter', action: () => play(r), disabled: !r.playable },
      { label: 'Add to queue', hotkey: 'Shift+Enter', action: () => queueRow(r), disabled: !r.playable },
      { label: 'Play album', action: () => playAlbum(r), disabled: !r.playable || !r.albumUri },
      { label: 'Play artist', action: () => playArtist(r), disabled: !r.playable || !r.artistUri },
    ]);
  });
  list.addEventListener('wheel', (e) => {
    e.preventDefault();
    scroll = Math.max(0, Math.min(Math.max(0, results.length - visibleRows()), scroll + Math.sign(e.deltaY) * 3));
    render();
  }, { passive: false });
  d.addEventListener('pointerdown', (e) => e.stopPropagation());
  root.append(d);
  return d;
}

function place(d, r) {
  d.style.left = r.x + 'px';
  d.style.top = r.y + 'px';
  d.style.width = r.w + 'px';
  d.style.height = r.h + 'px';
}

// The mode, shown in the box and the bottom bar.
function showMode() {
  const input = el.querySelector('.ws-query');
  input.placeholder = mode === 'mine' ? 'search my playlists' : 'search Spotify';
  input.setAttribute('aria-label', mode === 'mine' ? 'Search your playlists' : 'Search Spotify tracks');
}

function switchMode() {
  mode = mode === 'mine' ? 'spotify' : 'mine';
  results = [];
  showMode();
  runQuery(el.querySelector('.ws-query').value.trim());
}

// Left/Right: which of the song's playlists Enter plays it in.
function choose(r, step) {
  r.chosen = (r.chosen + step + r.places.length) % r.places.length;
  chosenSeq++;
  render();
}

function onKey(e) {
  const r = results[selected];
  const many = mode === 'mine' && !status && r && r.places && r.places.length > 1;
  const keys = {
    Tab: () => switchMode(),
    ...(many ? { ArrowRight: () => choose(r, 1), ArrowLeft: () => choose(r, -1) } : {}),
    ArrowDown: () => select(selected + 1),
    ArrowUp: () => select(selected - 1),
    PageDown: () => select(selected + visibleRows()),
    PageUp: () => select(selected - visibleRows()),
    Enter: () => {
      if (status || !r) return;
      if (e.shiftKey) secondary(r);
      else primary(r);
    },
    Escape: () => close(),
  };
  if (keys[e.key]) {
    e.preventDefault();
    e.stopPropagation();
    keys[e.key]();
  }
}

// ---- Open / close -------------------------------------------------------------

export async function open() {
  if (!ctx || opening) return;
  if (el) {
    // Already open: keep the search.
    el.querySelector('.ws-query').focus();
    panels.focus('search');
    return;
  }
  // Where it was placed by hand, or in the panels' default stack.
  opening = true;
  const spot = panels.opening('search');
  opening = false;
  el = build(spot);
  panels.opened('search');
  results = [];
  selected = 0;
  scroll = 0;
  mode = 'mine';
  status = prompt();
  drawnKey = null;
  showMode();
  render();
  el.querySelector('.ws-query').focus();
}

// keepRecord: signing out (search is still remembered as open).
export function close({ keepRecord = false } = {}) {
  if (!el) return;
  clearTimeout(debounceTimer);
  clearTimeout(flashTimer);
  flashTimer = null;
  searchSeq++;
  closeMenu();
  hideTooltip();
  el.remove();
  el = null;
  if (!keepRecord) panels.closed('search');
}

export const isOpen = () => !!el;

// ADD and J: open if closed, close if open (as its own close button does).
export function toggle() {
  if (el) close();
  else open();
}

// ---- A Winamp-style right-click menu -------------------------------------------
// Built the way Webamp builds its own (div#webamp-context-menu > ul.context-menu
// > li, with a span.hotkey), so Webamp's stylesheet draws it the same.

let menu = null;

function closeMenu() {
  if (!menu) return;
  menu.remove();
  menu = null;
  document.removeEventListener('pointerdown', onMenuOutside, true);
  document.removeEventListener('keydown', onMenuKey, true);
}

function onMenuOutside(e) {
  if (menu && !menu.contains(e.target)) closeMenu();
}

function onMenuKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); }
}

export function showMenu(x, y, items) {
  closeMenu();
  menu = document.createElement('div');
  menu.id = 'webamp-context-menu';
  Object.assign(menu.style, { position: 'absolute', top: '0', left: '0', zIndex: '100002' });
  const pos = document.createElement('div');
  pos.style.position = 'absolute';
  const ul = document.createElement('ul');
  ul.className = 'context-menu';
  for (const item of items) {
    const li = document.createElement('li');
    li.appendChild(document.createTextNode(item.label));
    if (item.hotkey) {
      const hk = document.createElement('span');
      hk.className = 'hotkey';
      hk.textContent = item.hotkey;
      li.appendChild(hk);
    }
    if (item.disabled) li.style.opacity = '0.5';
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      if (!item.disabled) item.action();
    });
    ul.appendChild(li);
  }
  pos.appendChild(ul);
  menu.appendChild(pos);
  document.body.appendChild(menu);
  // Keep it inside the window.
  const w = ul.offsetWidth;
  const h = ul.offsetHeight;
  pos.style.left = Math.max(0, Math.min(x, window.innerWidth - w - 2)) + 'px';
  pos.style.top = Math.max(0, Math.min(y, window.innerHeight - h - 2)) + 'px';
  document.addEventListener('pointerdown', onMenuOutside, true);
  document.addEventListener('keydown', onMenuKey, true);
}

// ---- Ways in --------------------------------------------------------------------

// J, as in classic Winamp, unless typing somewhere: opens or closes it.
function onKeyDown(e) {
  if (!ctx || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key !== 'j' && e.key !== 'J') return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
  e.preventDefault();
  toggle();
}

// The playlist window's ADD button opens (or closes) it too, in place of Webamp's
// URL / DIR / FILE menu (all inert: Spotify has no local files to add).
function onClickCapture(e) {
  if (!ctx || !(e.target instanceof Element) || !e.target.closest('#webamp #playlist-add-menu')) return;
  e.preventDefault();
  e.stopPropagation();
  toggle();
}

// Right-click a playlist window row: Play / Add to queue. A right-button
// press selects the row first (Webamp's own handler), so the row is the
// selected one.
function onContextMenu(e) {
  if (!ctx || !(e.target instanceof Element) || !e.target.closest('#webamp .track-cell')) return;
  // Webamp's own right-click menu would open too: this one replaces it here.
  e.preventDefault();
  e.stopPropagation();
  const id = ctx.webamp.store.getState().playlist.selectedTracks[0];
  const entry = id != null ? playlist.entryById(id) : null;
  showMenu(e.clientX, e.clientY, [
    { label: 'Play', action: () => playlist.playEntry(id), disabled: !entry },
    { label: 'Add to queue', action: () => queue(entry.uri, entry.name), disabled: !entry },
  ]);
}

// Webamp 2.3.1 has no "Jump to file" entry, so one is added to its right-click
// menu, under Play next to "File...", where classic Winamp keeps it. Webamp
// rebuilds the menu each time it opens, so the entry is added each time.
function addJumpEntry(retry) {
  if (!ctx) return;
  const fileItem = [...document.querySelectorAll('#webamp-context-menu li')].find((li) =>
    li.firstChild && li.firstChild.nodeType === Node.TEXT_NODE && li.firstChild.textContent.trim() === 'File...');
  if (!fileItem) {
    // The menu's contents may land a frame after the menu itself.
    if (retry && document.getElementById('webamp-context-menu')) requestAnimationFrame(() => addJumpEntry(false));
    return;
  }
  if (fileItem.parentNode.querySelector('.winify-jump')) return;
  const li = document.createElement('li');
  li.className = 'winify-jump';
  li.appendChild(document.createTextNode('Jump to track...'));
  const hk = document.createElement('span');
  hk.className = 'hotkey';
  hk.textContent = 'J';
  li.appendChild(hk);
  li.addEventListener('click', () => { setTimeout(open, 0); });
  fileItem.after(li);
}

// Webamp attaches its menu straight to <body>; watching only <body>'s own
// children keeps this off Webamp's constant redraws.
const menuObserver = new MutationObserver(() => addJumpEntry(true));

// ---- Lifecycle --------------------------------------------------------------------

export function init(c, playlistModule) {
  ctx = c;
  playlist = playlistModule;
  panels.register('search', {
    defaultWidth: WIDTH,
    open, close: () => close(), isOpen,
    element: () => el,
    getRect: () => (el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null),
    setRect: (rect) => { if (el) { place(el, rect); drawnKey = null; render(); } },
  });
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('contextmenu', onContextMenu, true);
  menuObserver.observe(document.body, { childList: true });
  // The index grew or finished: My playlists shows it (keeping the selection).
  stopIndexNote = index.onChange(() => {
    if (!el || mode !== 'mine') return;
    searchMine(el.querySelector('.ws-query').value.trim(), true);
  });
}

export function reset() {
  close({ keepRecord: true });
  closeMenu();
  if (stopIndexNote) stopIndexNote();
  stopIndexNote = null;
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('click', onClickCapture, true);
  document.removeEventListener('contextmenu', onContextMenu, true);
  menuObserver.disconnect();
  ctx = null;
}

// For the menu bar, DevTools and tests.
window.WinifySearch = { open, close, toggle, isOpen,
  state: () => ({ open: !!el, title: TITLE, mode, results: results.length, selected, status,
    chosen: results[selected] && results[selected].places ? results[selected].places[results[selected].chosen].name : null }) };
