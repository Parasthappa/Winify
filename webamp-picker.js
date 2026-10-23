/* The playlist picker: switch Spotify playlists from inside Winify.
 *
 * Opened by L (as in classic Winamp), Eject (main window and the playlist
 * window's mini transport), right-click > Play > File..., and LIST OPTS >
 * load list. Lists Liked Songs and every playlist in your library; picking
 * one plays it on Winify from track 1, and the playlist window follows on
 * its own.
 *
 * It is drawn with the active skin's own playlist-window bitmaps and colours
 * (its frame, text colours and the marquee font), so it matches whatever
 * skin is loaded rather than looking like a modern popup.
 *
 * Spotify can only list all of a user's playlists, 50 at a time (followed
 * ones included), so the list is read sparingly: it is remembered between
 * launches and shown at once; with nothing remembered, the first 50 come
 * straight away and the rest one page every couple of seconds (sooner while
 * filtering or scrolling near the end). A remembered list older than a few
 * hours is refreshed the same way in the background, and REFRESH in the
 * bottom bar does it now (its first page at once, so a new playlist shows up
 * straight away).
 */

import { placeDialog, makeDraggable, attachTooltips, hideTooltip } from './webamp-dialog.js';

const PAGE = 50;                    // the /me/playlists maximum
const PAGE_GAP_MS = 2000;           // background pace: one page every 2 s
const STALE_MS = 3 * 60 * 60 * 1000;   // refresh a remembered list after this
const STORE_KEY = 'winify.picker.v1';
const ROW = 13;                     // Webamp's playlist row height
const VISIBLE_ROWS = 16;
const WIDTH = 325;                  // the playlist window plus two segments
const HEIGHT = 20 + 13 + VISIBLE_ROWS * ROW + 14;
// Only playlists Spotify will list in full: ones you own, plus collaborative
// ones you contribute to. Spotify (February 2026) returns no tracks for
// anyone else's playlist, so those would only ever show Up Next.
const INCLUDE_COLLABORATIVE = true;
const UNTITLED = 'Untitled playlist';  // Spotify allows a playlist with no name

let ctx = null;                     // { webamp, api, say, log, warn, deviceId, refreshSoon, now }
// The list as last read: { meId, at, liked, entries: [{ name, uri, count }],
// total, nextOffset, complete }. Remembered between launches.
let lib = null;
let loading = null;                 // the read in progress: { gen, wake }
let loadGen = 0;
let el = null;                      // the open picker, or null
let rows = [];                      // all entries
let shown = [];                     // entries matching the filter
let selected = 0;
let scroll = 0;

// ---- Data ----------------------------------------------------------------------

function remember() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(lib)); } catch (e) { /* storage unavailable */ }
}

function recall() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch (e) { return null; }
}

// Liked Songs, then your playlists (and collaborative ones you are in).
function listFrom(l) {
  if (!l) return [];
  return [{ name: 'Liked Songs', uri: 'spotify:user:' + l.meId + ':collection', count: l.liked }].concat(l.entries);
}

function entryOf(p, meId) {
  if (!p) return null;
  const mine = p.owner && p.owner.id === meId;
  if (!mine && !(INCLUDE_COLLABORATIVE && p.collaborative)) return null;
  // February 2026: the track count moved from `tracks` to `items`.
  const count = p.items && typeof p.items.total === 'number' ? p.items.total : null;
  return { name: (p.name || '').trim() || UNTITLED, uri: p.uri, count };
}

// While a refresh is under way: what it has read so far, then whatever the
// old list has that it has not reached yet (so nothing vanishes meanwhile).
function merged(fresh, old) {
  const seen = new Set(fresh.map((e) => e.uri));
  return fresh.concat((old || []).filter((e) => !seen.has(e.uri)));
}

// Hurry a background read along (filtering, or scrolling near the end).
function hurry() {
  if (loading && loading.wake) loading.wake();
}

// Read the list, page by page: the first at once, the rest at the slow pace
// unless hurried. A pass from the start (no list yet, a stale one, or
// REFRESH) builds a fresh list, showing the old one beneath it until it is
// complete; a pass that resumes an unfinished list appends to it.
async function read(fromStart) {
  if (loading && !fromStart) return;
  const gen = ++loadGen;
  loading = { gen, wake: null };
  const old = lib;
  try {
    // Who you are, for the owner check. A remembered list is always this
    // account's: signing out forgets it.
    const meId = (old && old.meId) || (await ctx.api('GET', '/me')).id;
    if (gen !== loadGen) return;
    const same = old && old.meId === meId;            // not another account
    const startAt = fromStart || !same || old.complete ? 0 : old.nextOffset;
    let liked = same ? old.liked : null;
    if (startAt === 0) {
      const t = await ctx.api('GET', '/me/tracks?limit=1').catch(() => null);
      if (gen !== loadGen) return;
      if (t) liked = t.total;
    }
    let fresh = [];
    for (let offset = startAt; ; ) {
      if (offset !== startAt) {
        await new Promise((resolve) => { loading.wake = resolve; setTimeout(resolve, PAGE_GAP_MS); });
        if (gen !== loadGen) return;
      }
      const page = await ctx.api('GET', '/me/playlists?limit=' + PAGE + '&offset=' + offset);
      if (gen !== loadGen) return;
      const got = (page.items || []).map((p) => entryOf(p, meId)).filter(Boolean);
      offset += PAGE;
      const complete = offset >= page.total;
      let entries;
      if (startAt === 0) {
        fresh = fresh.concat(got);
        entries = complete ? fresh : merged(fresh, same ? old.entries : []);
      } else {
        entries = lib.entries.concat(got);
      }
      lib = { meId, liked, entries, total: page.total, nextOffset: offset, complete,
        at: complete ? Date.now() : (same ? old.at : 0) };
      remember();
      showList();
      if (complete) break;
    }
    ctx.log('picker:', lib.entries.length, 'of', lib.total, 'playlists (yours',
      INCLUDE_COLLABORATIVE ? 'and collaborative)' : 'only)', '+ Liked Songs');
  } catch (err) {
    if (gen !== loadGen) return;
    ctx.warn('picker: could not read playlists -', err.message);
    if (el && !rows.length) {
      close();
      ctx.say(err.note || (/scope/i.test(err.message) ? 'Sign in again for playlists' : 'Could not list playlists'));
    } else if (el) {
      ctx.say(err.note || 'Could not update the playlists');
    }
  } finally {
    if (gen === loadGen) loading = null;
    if (el) renderList();
  }
}

// The open picker shows the latest list, keeping the filter, selection and
// scroll.
function showList() {
  if (!el) return;
  const keep = shown[selected] && shown[selected].uri;
  rows = listFrom(lib);
  const q = el.querySelector('.wp-filter').value.trim().toLowerCase();
  shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows.slice();
  const at = keep ? shown.findIndex((r) => r.uri === keep) : -1;
  selected = at >= 0 ? at : Math.min(selected, Math.max(0, shown.length - 1));
  drawnKey = null;
  renderList();
}

// ---- Drawing --------------------------------------------------------------------

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

// Text in the skin's marquee font (text.bmp), as Webamp draws it.
function skinText(text) {
  const span = document.createElement('span');
  span.className = 'winify-picker-chars';
  // Webamp keys its text.bmp glyphs by lowercase character code.
  for (const ch of text.toLowerCase()) {
    const c = document.createElement('span');
    c.className = 'character character-' + ch.charCodeAt(0);
    span.appendChild(c);
  }
  return span;
}

function injectStyles() {
  if (document.getElementById('winify-picker-style')) return;
  const style = document.createElement('style');
  style.id = 'winify-picker-style';
  style.textContent = `
    #webamp .winify-picker-backdrop { position: fixed; inset: 0; z-index: 100000; }
    #webamp .winify-picker { position: fixed; z-index: 100001; width: ${WIDTH}px; display: flex; flex-direction: column; image-rendering: pixelated; }
    #webamp .winify-picker .wp-top { display: flex; height: 20px; }
    #webamp .winify-picker .wp-top .playlist-top-left { width: 25px; height: 20px; flex: none; }
    #webamp .winify-picker .wp-top .playlist-top-left-fill { flex: 1; height: 20px; }
    #webamp .winify-picker .wp-top .playlist-top-right { width: 25px; height: 20px; flex: none; position: relative; }
    #webamp .winify-picker .wp-title { flex: none; height: 20px; display: flex; align-items: center; padding: 0 4px; }
    #webamp .winify-picker .wp-title .winify-picker-chars { padding: 2px 3px; }
    #webamp .winify-picker .wp-close { position: absolute; right: 3px; top: 3px; width: 9px; height: 9px; cursor: pointer; }
    #webamp .winify-picker .winify-picker-chars { display: inline-flex; line-height: 0; }
    #webamp .winify-picker .character { display: inline-block; width: 5px; height: 6px; }
    #webamp .winify-picker .wp-middle { display: flex; }
    #webamp .winify-picker .wp-middle .playlist-middle-left { width: 12px; flex: none; background-repeat: repeat-y; }
    #webamp .winify-picker .wp-middle .playlist-middle-right { width: 20px; flex: none; background-repeat: repeat-y; position: relative; }
    #webamp .winify-picker .wp-body { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    #webamp .winify-picker .wp-filter { height: 13px; box-sizing: border-box; border: 0; border-bottom: 1px solid; outline: none; padding: 0 2px; font-size: 9px; width: 100%; }
    #webamp .winify-picker .wp-list { height: ${VISIBLE_ROWS * ROW}px; overflow: hidden; font-size: 9px; }
    #webamp .winify-picker .wp-row { height: ${ROW}px; line-height: ${ROW}px; display: flex; padding: 0 2px; white-space: nowrap; cursor: default; user-select: none; }
    #webamp .winify-picker .wp-row .wp-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
    #webamp .winify-picker .wp-row .wp-count { flex: none; padding-left: 6px; }
    #webamp .winify-picker .wp-handle { position: absolute; left: 5px; width: 8px; height: 18px; }
    #webamp .winify-picker .wp-bottom { display: flex; height: 14px; }
    #webamp .winify-picker .wp-bottom .playlist-bottom { flex: 1; background-position: left bottom; display: flex; align-items: center; justify-content: space-between; padding: 0 8px; }
    #webamp .winify-picker .wp-refresh { cursor: pointer; padding: 2px 3px; border: 1px solid transparent; }
    #webamp .winify-picker .wp-refresh:hover { border-color: currentColor; }
    #webamp .winify-picker .wp-refresh.wp-busy { opacity: .45; cursor: default; }
  `;
  document.head.appendChild(style);
}

// Rows are rebuilt only when the filter or scroll position changes. A
// selection change restyles them in place: rebuilding on the first click of
// a double-click would leave the second click on a new element, and the
// browser would never report the double-click.
let drawnKey = null;

function paintSelection() {
  const st = skinStyle();
  el.querySelectorAll('.wp-list .wp-row[data-index]').forEach((row) => {
    row.style.background = Number(row.dataset.index) === selected ? st.selectedbg : '';
  });
}

function renderList() {
  if (!el) return;
  const key = scroll + '|' + shown.length + '|' + (shown[0] && shown[0].uri) + '|' + rows.length;
  if (key === drawnKey) { paintSelection(); return; }
  drawnKey = key;
  const st = skinStyle();
  const list = el.querySelector('.wp-list');
  list.textContent = '';
  const currentUri = ctx.now.contextUri;
  shown.slice(scroll, scroll + VISIBLE_ROWS).forEach((r, i) => {
    const index = scroll + i;
    const row = document.createElement('div');
    row.className = 'wp-row';
    row.dataset.index = String(index);
    const isCurrent = !!currentUri && (r.uri === currentUri ||
      (/:collection/.test(r.uri) && /:collection/.test(currentUri)));
    row.style.color = isCurrent ? st.current : st.normal;
    if (index === selected) row.style.background = st.selectedbg;
    const name = document.createElement('span');
    name.className = 'wp-name';
    name.textContent = (index + 1) + '. ' + r.name;
    const count = document.createElement('span');
    count.className = 'wp-count';
    count.textContent = r.count == null ? '' : String(r.count);
    row.append(name, count);
    list.appendChild(row);
  });
  if (!shown.length) {
    const row = document.createElement('div');
    row.className = 'wp-row';
    row.style.color = st.normal;
    row.textContent = rows.length ? 'No match' : 'Loading...';
    list.appendChild(row);
  }
  // Scroll handle, in the skin's scrollbar track.
  const track = el.querySelector('.wp-middle .playlist-middle-right');
  const handle = el.querySelector('.wp-handle');
  const overflow = Math.max(0, shown.length - VISIBLE_ROWS);
  const travel = track.clientHeight - 18;
  handle.style.display = overflow ? '' : 'none';
  handle.style.top = (overflow ? Math.round((scroll / overflow) * travel) : 0) + 'px';
  const bar = el.querySelector('.wp-bottom .playlist-bottom');
  bar.textContent = '';
  const refresh = skinText('refresh');
  refresh.classList.add('wp-refresh');
  if (loading) refresh.classList.add('wp-busy');
  refresh.title = loading ? 'Updating the list...' : 'Read your playlists from Spotify again';
  refresh.setAttribute('role', 'button');
  refresh.setAttribute('aria-label', 'Refresh the playlist list');
  refresh.style.color = st.normal;
  refresh.addEventListener('click', () => { if (loading) hurry(); else read(true); });
  bar.appendChild(refresh);
  // ".." while more is on its way.
  if (rows.length) bar.appendChild(skinText(shown.length + '/' + rows.length + (loading ? '..' : '')));
  // Scrolled near the end of what is in: hurry the rest.
  if (loading && scroll + VISIBLE_ROWS >= shown.length - 4) hurry();
}

function select(index) {
  if (!shown.length) return;
  selected = Math.max(0, Math.min(shown.length - 1, index));
  if (selected < scroll) scroll = selected;
  if (selected >= scroll + VISIBLE_ROWS) scroll = selected - VISIBLE_ROWS + 1;
  renderList();
}

function applyFilter() {
  const q = el.querySelector('.wp-filter').value.trim().toLowerCase();
  if (q) hurry();                     // a filter needs the whole list
  shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows.slice();
  selected = 0;
  scroll = 0;
  renderList();
}

function build(spot) {
  injectStyles();
  const st = skinStyle();
  const root = document.querySelector('#webamp');
  const backdrop = document.createElement('div');
  backdrop.className = 'winify-picker-backdrop';
  const p = document.createElement('div');
  p.className = 'winify-picker';
  p.setAttribute('role', 'dialog');
  p.setAttribute('aria-label', 'Choose a playlist');
  // `selected` lights the skin's active title bar, as a focused window.
  p.innerHTML = `
    <div class="wp-top selected">
      <div class="playlist-top-left"></div>
      <div class="playlist-top-left-fill"></div>
      <div class="wp-title"></div>
      <div class="playlist-top-left-fill"></div>
      <div class="playlist-top-right"><div class="wp-close" role="button" aria-label="Close"></div></div>
    </div>
    <div class="wp-middle">
      <div class="playlist-middle-left"></div>
      <div class="wp-body">
        <input class="wp-filter" type="text" spellcheck="false" placeholder="filter" aria-label="Filter playlists">
        <div class="wp-list" role="listbox"></div>
      </div>
      <div class="playlist-middle-right"><div class="wp-handle playlist-scrollbar-handle"></div></div>
    </div>
    <div class="wp-bottom"><div class="playlist-bottom"></div></div>`;
  // Only the plain bottom tile: the corner bitmaps have the playlist
  // window's own buttons baked into them.
  const title = p.querySelector('.wp-title');
  const plate = skinText('Spotify playlists');
  plate.style.background = st.normalbg;
  title.appendChild(plate);
  const body = p.querySelector('.wp-body');
  body.style.background = st.normalbg;
  body.style.fontFamily = st.font;
  const filter = p.querySelector('.wp-filter');
  Object.assign(filter.style, { background: st.normalbg, color: st.normal, borderColor: st.normal, fontFamily: st.font });

  p.style.left = spot.x + 'px';
  p.style.top = spot.y + 'px';
  makeDraggable(p, p.querySelector('.wp-top'), 'picker', { ignore: '.wp-close' });
  attachTooltips(p.querySelector('.wp-list'), p, p.querySelector('.wp-top'), '.wp-name', skinStyle);

  backdrop.addEventListener('pointerdown', (e) => { e.preventDefault(); close(); });
  p.querySelector('.wp-close').addEventListener('click', close);
  filter.addEventListener('input', applyFilter);
  filter.addEventListener('keydown', onKey);
  const list = p.querySelector('.wp-list');
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.wp-row');
    if (row && row.dataset.index) select(Number(row.dataset.index));
  });
  list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.wp-row');
    if (row && row.dataset.index) pick(shown[Number(row.dataset.index)]);
  });
  list.addEventListener('wheel', (e) => {
    e.preventDefault();
    const overflow = Math.max(0, shown.length - VISIBLE_ROWS);
    scroll = Math.max(0, Math.min(overflow, scroll + Math.sign(e.deltaY) * 3));
    renderList();
  }, { passive: false });
  dragHandle(p.querySelector('.wp-handle'), p.querySelector('.wp-middle .playlist-middle-right'));
  // Keep clicks inside from reaching Webamp's windows underneath.
  p.addEventListener('pointerdown', (e) => e.stopPropagation());

  root.append(backdrop, p);
  p.backdrop = backdrop;
  return p;
}

function dragHandle(handle, track) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const r = track.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientY - r.top - 9) / (r.height - 18)));
      scroll = Math.round(f * Math.max(0, shown.length - VISIBLE_ROWS));
      renderList();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

function onKey(e) {
  const keys = {
    ArrowDown: () => select(selected + 1),
    ArrowUp: () => select(selected - 1),
    PageDown: () => select(selected + VISIBLE_ROWS),
    PageUp: () => select(selected - VISIBLE_ROWS),
    Enter: () => pick(shown[selected]),
    Escape: () => close(),
  };
  if (keys[e.key]) {
    e.preventDefault();
    e.stopPropagation();
    keys[e.key]();
  }
}

// ---- Open / close / pick ---------------------------------------------------------

let opening = false;

export async function open() {
  if (!ctx || opening) return;
  if (el) { el.querySelector('.wp-filter').focus(); return; }
  // Where it was left, or beside the player; Winify's window grows to fit.
  opening = true;
  const spot = await placeDialog('picker', WIDTH, HEIGHT);
  opening = false;
  el = build(spot);
  el.releaseRoom = spot.release;
  rows = [];
  shown = [];
  selected = 0;
  scroll = 0;
  if (!lib) lib = recall();
  showList();
  el.querySelector('.wp-filter').focus();
  // Start on whatever is playing, if it is in the list.
  const at = shown.findIndex((r) => r.uri === ctx.now.contextUri);
  if (at >= 0) select(at);
  // Nothing remembered, unfinished, or a few hours old: read it (in the
  // background when there is a list to show meanwhile).
  if (!lib || !lib.complete || Date.now() - lib.at > STALE_MS) read(!lib || lib.complete);
}

export function close() {
  if (!el) return;
  hideTooltip();
  el.backdrop.remove();
  el.remove();
  el.releaseRoom();
  el = null;
  drawnKey = null;
}

export const isOpen = () => !!el;

async function pick(entry) {
  if (!entry) return;
  close();
  const deviceId = ctx.deviceId();
  if (!deviceId) { ctx.say('Winify device not ready'); return; }
  try {
    await ctx.api('PUT', '/me/player/play?device_id=' + encodeURIComponent(deviceId),
      { context_uri: entry.uri, offset: { position: 0 } });
    ctx.log('picker: playing', '"' + entry.name + '"', 'from track 1');
    ctx.say(entry.name);
  } catch (err) {
    ctx.warn('picker: could not play', entry.name, '-', err.message);
    ctx.say(err.note || 'Could not play that playlist');
  }
  ctx.refreshSoon();
}

// Eject in both windows, and right-click > Play > File..., mean "open" in
// Winamp; here that is choosing a playlist. Webamp's own file prompt still
// runs afterwards and is suppressed by the media-file guard.
function onClickCapture(e) {
  if (!ctx || !(e.target instanceof Element)) return;
  if (e.target.closest('#webamp #eject, #webamp .playlist-eject-button')) { open(); return; }
  const li = e.target.closest('#webamp-context-menu li');
  if (li && li.firstChild && li.firstChild.nodeType === Node.TEXT_NODE &&
      li.firstChild.textContent.trim() === 'File...') {
    open();
  }
}

// L, as classic Winamp's "load", unless typing somewhere. Webamp's own L
// file prompt is suppressed by the media-file guard.
function onKeyDown(e) {
  if (!ctx || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key !== 'l' && e.key !== 'L') return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
  e.preventDefault();
  open();
}

export function init(c) {
  ctx = c;
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('keydown', onKeyDown);
}

export function reset() {
  close();
  document.removeEventListener('click', onClickCapture, true);
  document.removeEventListener('keydown', onKeyDown);
  ctx = null;
  // Signed out: the next sign-in may be another account.
  loadGen++;
  loading = null;
  lib = null;
  try { localStorage.removeItem(STORE_KEY); } catch (e) { /* storage unavailable */ }
}

// For inspection from DevTools and tests.
window.WinifyPicker = { open, close, isOpen, refresh: () => read(true),
  state: () => ({ open: !!el, rows: rows.length, shown: shown.length, selected, scroll, loading: !!loading,
    complete: !!(lib && lib.complete), at: lib ? lib.at : null }) };
