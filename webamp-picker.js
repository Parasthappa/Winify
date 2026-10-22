/* The playlist picker: switch Spotify playlists from inside Winify.
 *
 * Opened by Eject (main window and the playlist window's mini transport),
 * right-click > Play > File..., and LIST OPTS > load list. Lists Liked Songs
 * and every playlist in your library; picking one plays it on Winify from
 * track 1, and the playlist window follows on its own.
 *
 * It is drawn with the active skin's own playlist-window bitmaps and colours
 * (its frame, text colours and the marquee font), so it matches whatever
 * skin is loaded rather than looking like a modern popup.
 */

const PAGE = 50;                    // the /me/playlists maximum
const PARALLEL_PAGES = 4;
const ROW = 13;                     // Webamp's playlist row height
const VISIBLE_ROWS = 16;
const WIDTH = 325;                  // the playlist window plus two segments
const CACHE_MS = 60000;

let ctx = null;                     // { webamp, api, say, log, warn, deviceId, refreshSoon, now }
let me = null;                      // /me, for owner checks and Liked Songs' URI
let cache = null;                   // { at, list }
let el = null;                      // the open picker, or null
let rows = [];                      // all entries
let shown = [];                     // entries matching the filter
let selected = 0;
let scroll = 0;

// ---- Data ----------------------------------------------------------------------

async function allPlaylists() {
  const first = await ctx.api('GET', '/me/playlists?limit=' + PAGE + '&offset=0');
  const items = first.items.slice();
  const offsets = [];
  for (let o = PAGE; o < first.total; o += PAGE) offsets.push(o);
  for (let i = 0; i < offsets.length; i += PARALLEL_PAGES) {
    const got = await Promise.all(offsets.slice(i, i + PARALLEL_PAGES).map((o) =>
      ctx.api('GET', '/me/playlists?limit=' + PAGE + '&offset=' + o)));
    got.forEach((p) => items.push(...p.items));
  }
  return items.filter(Boolean);
}

async function load() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.list;
  if (!me) me = await ctx.api('GET', '/me');
  const [playlists, liked] = await Promise.all([
    allPlaylists(),
    ctx.api('GET', '/me/tracks?limit=1').catch(() => null),
  ]);
  const list = [{
    name: 'Liked Songs',
    uri: 'spotify:user:' + me.id + ':collection',
    count: liked ? liked.total : null,
    full: true,
  }];
  for (const p of playlists) {
    // February 2026: the track count moved from `tracks` to `items`.
    const count = p.items && typeof p.items.total === 'number' ? p.items.total : null;
    const mine = p.owner && p.owner.id === me.id;
    list.push({ name: p.name, uri: p.uri, count, full: mine || !!p.collaborative,
      owner: p.owner && p.owner.display_name });
  }
  cache = { at: Date.now(), list };
  ctx.log('picker:', playlists.length, 'playlists + Liked Songs');
  return list;
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
    #webamp .winify-picker .wp-row.wp-partial { opacity: .55; }
    #webamp .winify-picker .wp-handle { position: absolute; left: 5px; width: 8px; height: 18px; }
    #webamp .winify-picker .wp-bottom { display: flex; height: 14px; }
    #webamp .winify-picker .wp-bottom .playlist-bottom { flex: 1; background-position: left bottom; display: flex; align-items: center; justify-content: flex-end; padding-right: 8px; }
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
    row.className = 'wp-row' + (r.full ? '' : ' wp-partial');
    row.dataset.index = String(index);
    const isCurrent = !!currentUri && (r.uri === currentUri ||
      (/:collection/.test(r.uri) && /:collection/.test(currentUri)));
    row.style.color = isCurrent ? st.current : st.normal;
    if (index === selected) row.style.background = st.selectedbg;
    if (!r.full) row.title = (r.owner ? 'By ' + r.owner + ' - ' : '') + 'the playlist window will show Up Next';
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
  const counter = el.querySelector('.wp-bottom .playlist-bottom');
  counter.textContent = '';
  if (rows.length) counter.appendChild(skinText(shown.length + '/' + rows.length));
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
  shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows.slice();
  selected = 0;
  scroll = 0;
  renderList();
}

function build() {
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
      <div class="playlist-top-right"><div class="wp-close" title="Close"></div></div>
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

  // Centre over the Winify window.
  p.style.left = Math.max(0, Math.round((window.innerWidth - WIDTH) / 2)) + 'px';
  p.style.top = Math.max(0, Math.round((window.innerHeight - (34 + 13 + VISIBLE_ROWS * ROW + 20)) / 2)) + 'px';

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

export async function open() {
  if (!ctx) return;
  if (el) { el.querySelector('.wp-filter').focus(); return; }
  el = build();
  rows = [];
  shown = [];
  selected = 0;
  scroll = 0;
  renderList();
  el.querySelector('.wp-filter').focus();
  const mine = el;
  try {
    const list = await load();
    if (el !== mine) return;              // closed while loading
    rows = list;
    applyFilter();
    // Start on whatever is playing, if it is in the list.
    const at = shown.findIndex((r) => r.uri === ctx.now.contextUri);
    if (at >= 0) select(at);
  } catch (err) {
    ctx.warn('picker: could not list playlists -', err.message);
    if (el === mine) {
      close();
      ctx.say(/scope/i.test(err.message) ? 'Sign in again for playlists' : 'Could not list playlists');
    }
  }
}

export function close() {
  if (!el) return;
  el.backdrop.remove();
  el.remove();
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
    ctx.say('Could not play that playlist');
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

export function init(c) {
  ctx = c;
  document.addEventListener('click', onClickCapture, true);
}

export function reset() {
  close();
  document.removeEventListener('click', onClickCapture, true);
  ctx = null;
  cache = null;
  me = null;
}

// For inspection from DevTools and tests.
window.WinifyPicker = { open, close, isOpen, state: () => ({ open: !!el, rows: rows.length, shown: shown.length, selected, scroll }) };
