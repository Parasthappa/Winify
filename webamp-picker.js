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
 *
 * Several playlists can be chosen at once: Cmd-click adds or removes one,
 * Shift-click chooses a range (all drawn highlighted). Enter or a double-click
 * then asks how many songs from each (10, 20 or 50) and whether to shuffle
 * them together, and plays a mix of them (webamp-mix.js, makeFrom).
 */

import { makeDraggable, makeResizable, attachTooltips, hideTooltip } from './webamp-dialog.js';
import { makeFrame, FRAME_CSS } from './webamp-frame.js';
import * as panels from './webamp-panels.js';
import * as mixes from './webamp-mix.js';
import { showMenu } from './webamp-search.js';
import * as index from './webamp-library-index.js';

const PAGE = 50;                    // the /me/playlists maximum
const PAGE_GAP_MS = 2000;           // background pace: one page every 2 s
const STALE_MS = 3 * 60 * 60 * 1000;   // refresh a remembered list after this
const STORE_KEY = 'winify.picker.v1';
const ROW = 13;                     // Webamp's playlist row height
const WIDTH = 325;                  // the playlist window plus two segments
// As many rows as its height holds (it is resizable).
const visibleRows = () => {
  const list = el && el.querySelector('.wp-list');
  return Math.max(1, Math.floor(((list && list.clientHeight) || 16 * ROW) / ROW));
};
// Only playlists Spotify will list in full: ones you own, plus collaborative
// ones you contribute to. Spotify (February 2026) returns no tracks for
// anyone else's playlist, so those would only ever show Up Next.
const INCLUDE_COLLABORATIVE = true;
const UNTITLED = 'Untitled playlist';  // Spotify allows a playlist with no name

let ctx = null;                     // { webamp, api, say, log, warn, deviceId, refreshSoon, now }
// The list as last read: { meId, at, liked, likedNewest, entries: [{ name,
// uri, count, mine, snapshot }], total, nextOffset, complete }. Remembered
// between launches.
let lib = null;
let loading = null;                 // the read in progress: { gen, wake }
let loadGen = 0;
let el = null;                      // the open picker, or null
let rows = [];                      // all entries
let shown = [];                     // entries matching the filter
let selected = 0;
let scroll = 0;
const picked = new Set();           // uris of the playlists chosen together (two or more)
let anchor = 0;                     // where a Shift-click range starts
let collapseTimer = null;

// ---- Data ----------------------------------------------------------------------

function remember() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(lib)); } catch (e) { /* storage unavailable */ }
}

function recall() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch (e) { return null; }
}

// Your Winify mixes (newest first, under their own label), then Liked
// Songs and your playlists (and collaborative ones you are in).
function listFrom(l) {
  const saved = mixes.saved().map((m) => ({ name: m.name, uri: mixes.uriOf(m), count: m.tracks.length, mixId: m.id }));
  const top = saved.length ? [{ label: true, name: 'Winify mixes', uri: 'winify:label:mixes' }].concat(saved,
    [{ label: true, name: 'Your Spotify playlists', uri: 'winify:label:spotify' }]) : [];
  if (!l) return top;
  return top.concat([{ name: 'Liked Songs', uri: 'spotify:user:' + l.meId + ':collection', count: l.liked,
    snapshot: l.liked + '|' + (l.likedNewest || '') }], l.entries);
}

// The rows matching a filter; a section label stays when anything under it does.
function filtered(q) {
  if (!q) return rows.slice();
  const out = [];
  let label = null;
  for (const r of rows) {
    if (r.label) { label = r; continue; }
    if (!r.name.toLowerCase().includes(q)) continue;
    if (label) { out.push(label); label = null; }
    out.push(r);
  }
  return out;
}

// Your own playlists (not ones you only collaborate on, not Liked Songs),
// with their track counts: the random mix picks from these. The saved list
// is used; with none yet it is read first. Lists saved before ownership was
// recorded count every entry as yours.
export async function ownPlaylists() {
  if (!lib) lib = recall();
  // A read under way is finished (sooner), not started again.
  while (loading) {
    hurry();
    await new Promise((r) => setTimeout(r, 200));
  }
  // A list saved before it said which are yours is read again, once.
  if (!lib || !lib.entries.length || lib.entries.some((e) => !('mine' in e))) {
    const reading = read(true);
    hurry();
    await reading;
  }
  return lib ? lib.entries.filter((e) => e.mine !== false && e.count > 0) : [];
}

// The list for the My playlists index (webamp-library-index.js), without
// hurrying. Read again once per launch, so the index sees what changed since
// (a few requests: Liked Songs' size and newest addition, and the list in
// pages of 50 with each playlist's snapshot); also read when there is none,
// or it is from before it kept those. If that read fails, the saved list.
let checkedForIndex = false;
export async function listForIndex() {
  if (!lib) lib = recall();
  while (loading) await new Promise((r) => setTimeout(r, 500));
  const old = !lib || !lib.complete || !('likedNewest' in lib) || lib.entries.some((e) => !('snapshot' in e));
  if (old || !checkedForIndex) {
    checkedForIndex = true;
    await read(true);
  }
  return lib && lib.complete ? lib : null;
}

// Mixes changed (made, renamed, deleted): the open picker shows it.
export function mixesChanged() {
  if (!el) return;
  drawnKey = null;
  showList();
}

function entryOf(p, meId) {
  if (!p) return null;
  const mine = !!p.owner && p.owner.id === meId;
  if (!mine && !(INCLUDE_COLLABORATIVE && p.collaborative)) return null;
  // February 2026: the track count moved from `tracks` to `items`.
  const count = p.items && typeof p.items.total === 'number' ? p.items.total : null;
  return { name: (p.name || '').trim() || UNTITLED, uri: p.uri, count, mine, snapshot: p.snapshot_id || null };
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
    let likedNewest = same ? old.likedNewest : null;   // Liked Songs' newest addition, for the index
    if (startAt === 0) {
      const t = await ctx.api('GET', '/me/tracks?limit=1').catch(() => null);
      if (gen !== loadGen) return;
      if (t) { liked = t.total; likedNewest = (t.items && t.items[0] && t.items[0].added_at) || null; }
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
      lib = { meId, liked, likedNewest, entries, total: page.total, nextOffset: offset, complete,
        at: complete ? Date.now() : (same ? old.at : 0) };
      remember();
      showList();
      if (complete) break;
    }
    // A whole list read: the index re-reads whatever playlists changed.
    index.listRead(lib);
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
  shown = filtered(q);
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
    #webamp .winify-picker { z-index: 100001; }
    #webamp .winify-picker .wp-main { flex: 1; min-height: 0; display: flex; }
    #webamp .winify-picker .wp-body { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
    #webamp .winify-picker .wp-filter { height: 13px; box-sizing: border-box; border: 0; border-bottom: 1px solid; outline: none; padding: 0 2px; font-size: 9px; width: 100%; }
    #webamp .winify-picker .wp-list { flex: 1; min-height: 0; overflow: hidden; font-size: 9px; }
    #webamp .winify-picker .wp-row { height: ${ROW}px; line-height: ${ROW}px; display: flex; padding: 0 2px; white-space: nowrap; cursor: default; user-select: none; }
    #webamp .winify-picker .wp-row .wp-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
    #webamp .winify-picker .wp-row .wp-count { flex: none; padding-left: 6px; }
    #webamp .winify-picker .wp-scroll { flex: none; width: 8px; position: relative; }
    #webamp .winify-picker .wp-handle { position: absolute; left: 0; width: 8px; height: 18px; }
    #webamp .winify-picker .wp-info { flex: none; height: 13px; display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 0 3px; min-width: 0; overflow: hidden; white-space: nowrap; }
    #webamp .winify-picker .winify-picker-chars { display: inline-flex; line-height: 0; }
    #webamp .winify-picker .character { display: inline-block; width: 5px; height: 6px; }
    #webamp .winify-picker .wp-refresh { cursor: pointer; padding: 2px 3px; border: 1px solid transparent; }
    #webamp .winify-picker .wp-refresh:hover { border-color: currentColor; }
    #webamp .winify-picker .wp-refresh.wp-busy { opacity: .45; cursor: default; }
    #webamp .winify-picker .wp-row.wp-label { opacity: .6; font-size: 8px; letter-spacing: 1px; justify-content: center; }
    #webamp .winify-picker .wp-sel { margin-left: auto; }
    #webamp .winify-picker-prompt { z-index: 100002; }
    #webamp .winify-picker-prompt .wq-body { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 7px; padding: 4px 8px; font-size: 9px; }
    #webamp .winify-picker-prompt .wq-line { display: flex; align-items: center; gap: 5px; }
    #webamp .winify-picker-prompt .wq-btn { cursor: pointer; padding: 3px 5px; border: 1px solid; line-height: 0; user-select: none; }
    #webamp .winify-picker-prompt .winify-picker-chars { display: inline-flex; line-height: 0; }
    #webamp .winify-picker-prompt .character { display: inline-block; width: 5px; height: 6px; }
    #webamp .winify-picker .wp-rename { flex: 1; height: 11px; box-sizing: border-box; border: 1px solid; outline: none; padding: 0 2px; font-size: 9px; }
    ${FRAME_CSS}
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
    const i = Number(row.dataset.index);
    row.style.background = i === selected || (picked.size > 1 && shown[i] && picked.has(shown[i].uri)) ? st.selectedbg : '';
  });
  selectionNote();
}

// "3 chosen" in the bottom bar while several are chosen.
function selectionNote() {
  const bar = el && el.querySelector('.wp-info');
  if (!bar) return;
  const old = bar.querySelector('.wp-sel');
  if (old) old.remove();
  if (picked.size < 2) return;
  const note = skinText(picked.size + ' chosen: enter to play together');
  note.classList.add('wp-sel');
  bar.appendChild(note);
}

function renderList() {
  if (!el || renaming) return;
  const VISIBLE_ROWS = visibleRows();
  const key = scroll + '|' + VISIBLE_ROWS + '|' + shown.length + '|' + (shown[0] && shown[0].uri) + '|' + rows.length;
  if (key === drawnKey) { paintSelection(); return; }
  drawnKey = key;
  const st = skinStyle();
  const list = el.querySelector('.wp-list');
  list.textContent = '';
  const currentUri = mixes.currentUri() || ctx.now.contextUri;
  // Numbered within the list, section labels aside.
  const numbers = [];
  shown.reduce((n, r, i) => { numbers[i] = r.label ? null : n + 1; return r.label ? n : n + 1; }, 0);
  shown.slice(scroll, scroll + VISIBLE_ROWS).forEach((r, i) => {
    const index = scroll + i;
    const row = document.createElement('div');
    row.className = 'wp-row';
    row.dataset.index = String(index);
    if (r.label) {
      // A section label: not a row to choose.
      row.classList.add('wp-label');
      row.style.color = st.normal;
      row.textContent = '\u2014 ' + r.name.toUpperCase() + ' \u2014';
      list.appendChild(row);
      return;
    }
    if (r.mixId) row.dataset.mix = r.mixId;
    const isCurrent = !!currentUri && (r.uri === currentUri ||
      (/:collection/.test(r.uri) && /:collection/.test(currentUri)));
    row.style.color = isCurrent ? st.current : st.normal;
    if (index === selected || (picked.size > 1 && picked.has(r.uri))) row.style.background = st.selectedbg;
    const name = document.createElement('span');
    name.className = 'wp-name';
    name.textContent = numbers[index] + '. ' + r.name;
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
  const track = el.querySelector('.wp-scroll');
  const handle = el.querySelector('.wp-handle');
  const overflow = Math.max(0, shown.length - VISIBLE_ROWS);
  const travel = track.clientHeight - 18;
  handle.style.display = overflow ? '' : 'none';
  handle.style.top = (overflow ? Math.round((scroll / overflow) * travel) : 0) + 'px';
  const bar = el.querySelector('.wp-info');
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
  // The My playlists index, while it builds: "indexing 40/97".
  const building = index.status();
  if (building.building) bar.appendChild(skinText('indexing ' + building.done + '/' + building.total));
  // Scrolled near the end of what is in: hurry the rest.
  if (loading && scroll + VISIBLE_ROWS >= shown.length - 4) hurry();
  selectionNote();
}

function select(index, dir = Math.sign(index - selected) || 1) {
  if (!shown.length) return;
  const VISIBLE_ROWS = visibleRows();
  let i = Math.max(0, Math.min(shown.length - 1, index));
  // Section labels are passed over, in the direction of travel.
  while (shown[i] && shown[i].label) i += dir;
  if (!shown[i]) { i = Math.max(0, Math.min(shown.length - 1, index)); while (shown[i] && shown[i].label) i -= dir; }
  if (!shown[i]) return;
  selected = i;
  anchor = i;
  picked.clear();
  if (selected < scroll) scroll = selected;
  if (selected >= scroll + VISIBLE_ROWS) scroll = selected - VISIBLE_ROWS + 1;
  renderList();
}

function applyFilter() {
  const q = el.querySelector('.wp-filter').value.trim().toLowerCase();
  if (q) hurry();                     // a filter needs the whole list
  shown = filtered(q);
  selected = 0;
  scroll = 0;
  renderList();
}

function build(spot) {
  injectStyles();
  const st = skinStyle();
  const root = document.querySelector('#webamp');
  // Webamp's generic window frame, in the skin's lettering (webamp-frame.js).
  const frame = makeFrame({ title: 'Playlists', cls: 'winify-picker', prefix: 'wp' });
  const p = frame.root;
  p.setAttribute('aria-label', 'Choose a playlist');
  frame.content.innerHTML = `
    <div class="wp-main">
      <div class="wp-body">
        <input class="wp-filter" type="text" spellcheck="false" placeholder="filter" aria-label="Filter playlists">
        <div class="wp-list" role="listbox"></div>
      </div>
      <div class="wp-scroll"><div class="wp-handle playlist-scrollbar-handle"></div></div>
    </div>
    <div class="wp-info"></div>`;
  for (const part of ['.wp-body', '.wp-scroll', '.wp-info']) frame.content.querySelector(part).style.background = st.normalbg;
  const body = p.querySelector('.wp-body');
  body.style.fontFamily = st.font;
  const filter = p.querySelector('.wp-filter');
  Object.assign(filter.style, { background: st.normalbg, color: st.normal, borderColor: st.normal, fontFamily: st.font });

  place(p, spot);
  makeDraggable(p, frame.top, { ignore: '.wp-close', onMoved: (rect) => panels.placed('picker', rect) });
  makeResizable(p, { grip: frame.grip, minWidth: panels.MIN_SIZE.w, minHeight: panels.MIN_SIZE.h, onResize: () => renderList(),
    onResized: (rect) => panels.placed('picker', rect) });
  attachTooltips(p.querySelector('.wp-list'), p, frame.top, '.wp-name', skinStyle);

  p.querySelector('.wp-close').addEventListener('click', () => close());
  filter.addEventListener('input', applyFilter);
  filter.addEventListener('keydown', onKey);
  const list = p.querySelector('.wp-list');
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.wp-row');
    if (!row || !row.dataset.index || row.classList.contains('wp-label')) return;
    const i = Number(row.dataset.index);
    filter.focus();                      // so Enter and the arrows keep working after a click
    if (e.metaKey || e.ctrlKey) { toggleChosen(i); return; }
    if (e.shiftKey) { chooseRange(i); return; }
    // A click on one of several chosen: a double-click plays them together,
    // so a single click only narrows the choice if no second one follows.
    if (picked.size > 1 && picked.has(shown[i].uri)) {
      if (e.detail > 1) return;
      selected = i; anchor = i;
      clearTimeout(collapseTimer);
      collapseTimer = setTimeout(() => { if (el) select(i); }, 350);
      renderList();
      return;
    }
    select(i);
  });
  // A Winify mix: rename or delete it (on this Mac only).
  list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.wp-row[data-mix]');
    if (!row) return;
    e.preventDefault();
    select(Number(row.dataset.index));
    const id = row.dataset.mix;
    showMenu(e.clientX, e.clientY, [
      { label: 'Rename', action: () => rename(id) },
      { label: 'Delete', action: () => { mixes.remove(id); } },
    ]);
  });
  list.addEventListener('dblclick', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    clearTimeout(collapseTimer);
    const row = e.target.closest('.wp-row');
    if (picked.size > 1 && row && row.dataset.index && picked.has(shown[Number(row.dataset.index)].uri)) { playTogether(); return; }
    if (row && row.dataset.index) pick(shown[Number(row.dataset.index)]);
  });
  list.addEventListener('wheel', (e) => {
    e.preventDefault();
    const overflow = Math.max(0, shown.length - visibleRows());
    scroll = Math.max(0, Math.min(overflow, scroll + Math.sign(e.deltaY) * 3));
    renderList();
  }, { passive: false });
  dragHandle(p.querySelector('.wp-handle'), p.querySelector('.wp-scroll'));
  // Keep clicks inside from reaching Webamp's windows underneath.
  p.addEventListener('pointerdown', (e) => e.stopPropagation());

  root.append(p);
  return p;
}

function place(p, r) {
  p.style.left = r.x + 'px';
  p.style.top = r.y + 'px';
  p.style.width = r.w + 'px';
  p.style.height = r.h + 'px';
}

function dragHandle(handle, track) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const r = track.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientY - r.top - 9) / (r.height - 18)));
      scroll = Math.round(f * Math.max(0, shown.length - visibleRows()));
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
    PageDown: () => select(selected + visibleRows()),
    PageUp: () => select(selected - visibleRows()),
    Enter: () => (picked.size > 1 ? playTogether() : pick(shown[selected])),
    Escape: () => close(),
  };
  if (keys[e.key]) {
    e.preventDefault();
    e.stopPropagation();
    keys[e.key]();
  }
}

// ---- Several playlists at once -----------------------------------------------------

// A row that can be chosen together with others: a playlist or Liked Songs,
// not a section label or a saved mix.
const choosable = (r) => !!r && !r.label && !r.mixId;

// Cmd-click: add or remove one. The row the cursor is on joins first.
function toggleChosen(i) {
  if (!choosable(shown[i])) return;
  if (!picked.size && choosable(shown[selected])) picked.add(shown[selected].uri);
  const uri = shown[i].uri;
  if (picked.has(uri)) picked.delete(uri); else picked.add(uri);
  selected = i;
  anchor = i;
  if (picked.size === 1) {                 // one left is just a selection
    const only = shown.findIndex((r) => r.uri === [...picked][0]);
    picked.clear();
    if (only >= 0) selected = only;
  }
  renderList();
}

// Shift-click: everything from where the last click was to this row.
function chooseRange(i) {
  if (!choosable(shown[i])) return;
  const [a, b] = anchor <= i ? [anchor, i] : [i, anchor];
  picked.clear();
  for (let k = a; k <= b; k++) if (choosable(shown[k])) picked.add(shown[k].uri);
  selected = i;
  if (picked.size === 1) picked.clear();
  renderList();
}

let prompt = null;                  // the "Play together" window

function closePrompt() {
  if (!prompt) return;
  document.removeEventListener('keydown', prompt.onKey, true);
  prompt.root.remove();
  prompt = null;
}

// Asks how many from each, and whether to shuffle together; plays the mix.
function playTogether() {
  // In the order they were chosen (a Set keeps it), not the list's.
  const chosen = [...picked].map((uri) => rows.find((r) => r.uri === uri)).filter(choosable);
  if (chosen.length < 2) return;
  closePrompt();
  const st = skinStyle();
  const frame = makeFrame({ title: 'Play together', cls: 'winify-picker-prompt', prefix: 'wq' });
  frame.root.querySelector('.winify-resize').style.display = 'none';
  frame.root.setAttribute('aria-label', 'Play ' + chosen.length + ' playlists together');
  let per = 20;
  let together = true;
  const body = document.createElement('div');
  body.className = 'wq-body';
  body.style.background = st.normalbg;
  body.style.color = st.normal;
  const line = () => { const d = document.createElement('div'); d.className = 'wq-line'; body.appendChild(d); return d; };
  const button = (parent, text, on) => {
    const b = document.createElement('span');
    b.className = 'wq-btn';
    b.setAttribute('role', 'button');
    b.style.borderColor = st.normal;
    b.appendChild(skinText(text));
    b.addEventListener('click', on);
    parent.appendChild(b);
    return b;
  };
  const head = line();
  head.appendChild(skinText(chosen.length + ' playlists, songs from each:'));
  const amounts = line();
  const amountBtns = [10, 20, 50].map((n) => button(amounts, String(n), () => { per = n; paint(); }));
  const shuffleLine = line();
  const shuffleBtn = button(shuffleLine, '', () => { together = !together; paint(); });
  shuffleLine.appendChild(skinText('shuffle together'));
  const actions = line();
  button(actions, 'play', () => go());
  button(actions, 'cancel', () => closePrompt());
  function paint() {
    [10, 20, 50].forEach((n, k) => {
      amountBtns[k].style.background = n === per ? st.selectedbg : '';
      amountBtns[k].style.color = n === per ? st.current : st.normal;
      amountBtns[k].setAttribute('aria-pressed', String(n === per));
    });
    shuffleBtn.textContent = '';
    shuffleBtn.appendChild(skinText(together ? 'x' : ' '));
    shuffleBtn.setAttribute('aria-checked', String(together));
  }
  function go() {
    closePrompt();
    picked.clear();
    renderList();
    mixes.makeFrom(chosen, per, together);
  }
  frame.content.appendChild(body);
  frame.close.addEventListener('click', closePrompt);
  const keys = {
    Enter: go,
    Escape: closePrompt,
    ArrowLeft: () => { per = [10, 20, 50][Math.max(0, [10, 20, 50].indexOf(per) - 1)]; paint(); },
    ArrowRight: () => { per = [10, 20, 50][Math.min(2, [10, 20, 50].indexOf(per) + 1)]; paint(); },
    ' ': () => { together = !together; paint(); },
  };
  const onKey = (e) => {
    if (!keys[e.key]) return;
    e.preventDefault();
    e.stopPropagation();
    keys[e.key]();
  };
  document.addEventListener('keydown', onKey, true);
  frame.root.addEventListener('pointerdown', (e) => e.stopPropagation());
  // Centred over the picker.
  const w = 230, h = 124;
  Object.assign(frame.root.style, { width: w + 'px', height: h + 'px',
    left: Math.max(0, el.offsetLeft + (el.offsetWidth - w) / 2) + 'px', top: Math.max(0, el.offsetTop + (el.offsetHeight - h) / 2) + 'px' });
  document.querySelector('#webamp').append(frame.root);
  prompt = { root: frame.root, onKey };
  paint();
}

// ---- Open / close / pick ---------------------------------------------------------

let opening = false;

export async function open() {
  if (!ctx || opening) return;
  if (el) { el.querySelector('.wp-filter').focus(); panels.focus('picker'); return; }
  // Where it was placed by hand, or in the panels' default stack.
  opening = true;
  const spot = panels.opening('picker');
  opening = false;
  el = build(spot);
  panels.opened('picker');
  rows = [];
  shown = [];
  selected = 0;
  scroll = 0;
  if (!lib) lib = recall();
  showList();
  el.querySelector('.wp-filter').focus();
  // Start on whatever is playing, if it is in the list.
  const playing = mixes.currentUri() || ctx.now.contextUri;
  const at = shown.findIndex((r) => r.uri === playing);
  select(at >= 0 ? at : 0);
  // Nothing remembered, unfinished, or a few hours old: read it (in the
  // background when there is a list to show meanwhile).
  if (!lib || !lib.complete || Date.now() - lib.at > STALE_MS) read(!lib || lib.complete);
}

// keepRecord: signing out (the picker is still remembered as open).
export function close({ keepRecord = false } = {}) {
  if (!el) return;
  closePrompt();
  clearTimeout(collapseTimer);
  picked.clear();
  hideTooltip();
  el.remove();
  el = null;
  drawnKey = null;
  if (!keepRecord) panels.closed('picker');
}

export const isOpen = () => !!el;

// Eject and L: open if closed, close if open (as its own close button does).
export function toggle() {
  if (el) close();
  else open();
}

// Renaming a mix in its row: Enter keeps the name, Escape leaves it as it was.
let renaming = null;
function rename(id) {
  const row = el && el.querySelector('.wp-row[data-mix="' + id + '"]');
  const mix = mixes.saved().find((m) => m.id === id);
  if (!row || !mix) return;
  const st = skinStyle();
  const input = document.createElement('input');
  input.className = 'wp-rename';
  input.value = mix.name;
  input.dataset.ownEscape = '1';      // Escape is this field's, not the panel's
  Object.assign(input.style, { background: st.normalbg, color: st.current, borderColor: st.normal, fontFamily: st.font });
  row.querySelector('.wp-name').replaceWith(input);
  renaming = id;
  input.focus();
  input.select();
  const done = (keep) => {
    if (renaming !== id) return;
    renaming = null;
    if (keep && input.value.trim()) mixes.rename(id, input.value.trim());
    drawnKey = null;
    showList();
    if (el) el.querySelector('.wp-filter').focus();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    if (e.key === 'Escape') { e.preventDefault(); done(false); }
  });
  input.addEventListener('blur', () => done(true));
}

// Plays it; the picker stays open (panels close only with x or Escape).
async function pick(entry) {
  if (!entry || entry.label) return;
  if (entry.mixId) { mixes.playSaved(entry.mixId); return; }
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
  if (e.target.closest('#webamp #eject, #webamp .playlist-eject-button')) { toggle(); return; }
  const li = e.target.closest('#webamp-context-menu li');
  if (li && li.firstChild && li.firstChild.nodeType === Node.TEXT_NODE &&
      li.firstChild.textContent.trim() === 'File...') {
    open();
  }
}

// L, as classic Winamp's "load", unless typing somewhere: opens or closes the
// picker. Webamp's own L file prompt is suppressed by the media-file guard.
function onKeyDown(e) {
  if (!ctx || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key !== 'l' && e.key !== 'L') return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
  e.preventDefault();
  toggle();
}

let stopIndexNote = null;

export function init(c) {
  ctx = c;
  stopIndexNote = index.onChange(() => { if (el) renderList(); });
  panels.register('picker', {
    defaultWidth: WIDTH,
    open, close: () => close(), isOpen,
    element: () => el,
    getRect: () => (el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null),
    setRect: (rect) => { if (el) { place(el, rect); renderList(); } },
  });
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('keydown', onKeyDown);
}

export function reset() {
  close({ keepRecord: true });
  if (stopIndexNote) stopIndexNote();
  stopIndexNote = null;
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
window.WinifyPicker = { open, close, toggle, isOpen, refresh: () => read(true),
  state: () => ({ open: !!el, rows: rows.length, shown: shown.length, selected, scroll, loading: !!loading,
    chosen: picked.size, prompt: !!prompt,
    complete: !!(lib && lib.complete), at: lib ? lib.at : null }) };
