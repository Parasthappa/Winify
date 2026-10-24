/* Lyrics: the full lyrics of the current track, in a Winamp-styled window.
 *
 * Opened and closed by the I button on the main window's clutter bar, the
 * playlist window's MISC button (relabelled LYRIC in the default skin; see
 * "The LYRIC button" below), and Option+3 (classic Winamp's Alt+3, file
 * info). It stays open while the player is used,
 * follows every track change (whatever started it), and is reopened at launch
 * if it was left open. It is one of the side panels: where it opens, its
 * size and what is remembered are the panel manager's (webamp-panels.js);
 * dragging and resizing are the shared custom-window behaviour
 * (webamp-dialog.js).
 *
 * Spotify's API has no lyrics; they come from LRCLIB (lrclib.net): /api/get
 * with the track's name, first artist, album and duration, and only if that
 * finds nothing, /api/search, taking the closest match. The requests are made
 * by the main process (window.spotify.lrclib), which sets the User-Agent
 * LRCLIB asks for. Plain lyrics are shown; synced (LRC) lyrics are kept with
 * them for later. Results are cached per track for the session.
 */

import { makeDraggable, makeResizable, GRIP_CSS } from './webamp-dialog.js';
import * as panels from './webamp-panels.js';

const TITLE = 'Lyrics';
const CREDIT = 'Lyrics from LRCLIB';
const WIDTH = 325;                  // as the picker's: a tidier stack
const WATCH_MS = 500;               // how often the current track is checked
const DURATION_SLACK_S = 4;         // a search match this close is the same recording
const BUSY_RETRY_MS = 2000;

let ctx = null;                     // { webamp, api, now }
let el = null;
let opening = false;
let watchTimer = null;
let shownUri;                       // the track the window shows (undefined = nothing yet)
let lookupSeq = 0;
const lyricsCache = new Map();      // track URI -> { state, plain, synced, source }
const detailsCache = new Map();     // track URI -> { name, artist, album, durationS }

// Main mirrors these to the terminal, where lyrics problems are diagnosed.
const log = (...args) => console.log('[winify/lyrics]', ...args);
const warn = (...args) => console.warn('[winify/lyrics]', ...args);

// ---- Finding the lyrics -----------------------------------------------------------

const idOf = (uri) => uri.split(':').pop();

// Name, first artist, album and exact duration: from Spotify, falling back to
// what the player reports.
async function trackDetails(uri) {
  if (detailsCache.has(uri)) return detailsCache.get(uri);
  const n = ctx.now;
  let d = { name: n.title, artist: (n.artist || '').split(', ')[0], album: n.album, durationS: Math.round((n.durationMs || 0) / 1000) };
  try {
    const t = await ctx.api('GET', '/tracks/' + idOf(uri) + '?market=from_token');
    d = { name: t.name, artist: t.artists && t.artists[0] ? t.artists[0].name : d.artist,
      album: t.album ? t.album.name : d.album, durationS: Math.round(t.duration_ms / 1000) };
  } catch (err) {
    warn('track details from Spotify failed, using the player\'s -', err.message);
  }
  detailsCache.set(uri, d);
  return d;
}

// "Song - 2011 Remaster", "Song (feat. X)", "Song (Live)": LRCLIB lists the song.
const cleanName = (s) => s.replace(/\s+-\s+.*$/, '').replace(/\s*[([].*?[)\]]/g, '').trim();
const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// An LRCLIB record as what the window shows.
function fromRecord(r, source) {
  if (r.instrumental) return { state: 'instrumental', source };
  const synced = r.syncedLyrics || null;
  let plain = r.plainLyrics || null;
  if (!plain && synced) plain = synced.replace(/^\[[^\]]*\]\s?/gm, '');
  return plain ? { state: 'found', plain, synced, source } : null;
}

// The search result for this track: same song and artist, nearest duration,
// one with lyrics (or marked instrumental) preferred.
function bestMatch(results, d) {
  const name = norm(cleanName(d.name));
  const artist = norm(d.artist);
  const usable = results.filter((r) => (r.plainLyrics || r.syncedLyrics || r.instrumental) &&
    norm(cleanName(r.trackName || '')) === name && norm(r.artistName).includes(artist));
  const off = (r) => (r.duration ? Math.abs(r.duration - d.durationS) : DURATION_SLACK_S + 1);
  usable.sort((a, b) => off(a) - off(b));
  return usable[0] || null;
}

// Anything but an answer (LRCLIB busy, 5xx) is an error: shown, not cached.
function answered(res, allowNotFound) {
  if (res.status === 200 || (allowNotFound && res.status === 404)) return res;
  const err = new Error('LRCLIB answered ' + res.status);
  err.busy = res.status === 429 || res.status === 503;
  throw err;
}

// LRCLIB is sometimes briefly busy (503): one quiet retry before giving up.
async function lrclib(path, params) {
  const res = await window.spotify.lrclib(path, params);
  if (res.status !== 429 && res.status !== 503) return res;
  await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
  return window.spotify.lrclib(path, params);
}

async function lookUp(d) {
  log('looking up', JSON.stringify(d));
  const got = answered(await lrclib('/api/get', {
    track_name: d.name, artist_name: d.artist, album_name: d.album, duration: d.durationS,
  }), true);
  const exact = got.status === 200 && got.body && fromRecord(got.body, 'get');
  log('/api/get ->', got.status, exact ? exact.state : 'nothing usable');
  if (exact) return exact;
  const found = answered(await lrclib('/api/search', { track_name: cleanName(d.name), artist_name: d.artist }));
  const match = Array.isArray(found.body) ? bestMatch(found.body, d) : null;
  log('/api/search ->', found.status, (Array.isArray(found.body) ? found.body.length : 0) + ' results,', match ? 'matched #' + match.id : 'no match');
  return (match && fromRecord(match, 'search')) || { state: 'none' };
}

// ---- The window -----------------------------------------------------------------------

function skinStyle() {
  const s = ctx.webamp.store.getState().display.skinPlaylistStyle || {};
  return {
    normal: s.normal || '#00FF00',
    current: s.current || '#FFFFFF',
    normalbg: s.normalbg || '#000000',
    font: s.font || 'Arial',
  };
}

// Text in the skin's marquee font. Webamp keys its glyphs by lowercase code.
function skinText(text) {
  const span = document.createElement('span');
  span.className = 'wl-chars';
  for (const ch of text.toLowerCase()) {
    const c = document.createElement('span');
    c.className = 'character character-' + ch.charCodeAt(0);
    span.appendChild(c);
  }
  return span;
}

function injectStyles() {
  if (document.getElementById('winify-lyrics-style')) return;
  const style = document.createElement('style');
  style.id = 'winify-lyrics-style';
  style.textContent = `
    #webamp .winify-lyrics { position: fixed; z-index: 99990; width: ${WIDTH}px; display: flex; flex-direction: column; image-rendering: pixelated; }
    #webamp .winify-lyrics .wl-top { display: flex; height: 20px; }
    #webamp .winify-lyrics .wl-top .playlist-top-left { width: 25px; height: 20px; flex: none; }
    #webamp .winify-lyrics .wl-top .playlist-top-left-fill { flex: 1; height: 20px; }
    #webamp .winify-lyrics .wl-top .playlist-top-right { width: 25px; height: 20px; flex: none; position: relative; }
    #webamp .winify-lyrics .wl-title { flex: none; height: 20px; display: flex; align-items: center; padding: 0 4px; }
    #webamp .winify-lyrics .wl-title .wl-chars { padding: 2px 3px; }
    #webamp .winify-lyrics .wl-close { position: absolute; right: 3px; top: 3px; width: 9px; height: 9px; cursor: pointer; }
    #webamp .winify-lyrics .wl-chars { display: inline-flex; line-height: 0; }
    #webamp .winify-lyrics .character { display: inline-block; width: 5px; height: 6px; }
    #webamp .winify-lyrics .wl-middle { display: flex; flex: 1; min-height: 0; }
    #webamp .winify-lyrics .wl-top, #webamp .winify-lyrics .wl-bottom { flex: none; }
    ${GRIP_CSS}
    #webamp .winify-lyrics .wl-middle .playlist-middle-left { width: 12px; flex: none; background-repeat: repeat-y; }
    #webamp .winify-lyrics .wl-middle .playlist-middle-right { width: 20px; flex: none; background-repeat: repeat-y; position: relative; }
    #webamp .winify-lyrics .wl-body { flex: 1; overflow-y: scroll; scrollbar-width: none; padding: 3px 4px 8px; font-size: 10px; line-height: 13px; cursor: default; user-select: text; }
    #webamp .winify-lyrics .wl-body::-webkit-scrollbar { display: none; }
    #webamp .winify-lyrics .wl-head { margin-bottom: 8px; }
    #webamp .winify-lyrics .wl-track { font-weight: bold; }
    #webamp .winify-lyrics .wl-text { white-space: pre-wrap; overflow-wrap: anywhere; }
    #webamp .winify-lyrics .wl-note { opacity: .75; white-space: pre-wrap; }
    #webamp .winify-lyrics .wl-retry { cursor: pointer; text-decoration: underline; }
    #webamp .winify-lyrics .wl-handle { position: absolute; left: 5px; width: 8px; height: 18px; }
    #webamp .winify-lyrics .wl-bottom { display: flex; height: 38px; } /* the skin's playlist bottom is 38 px (Webamp fixes it): inside the box, so the drawn edge is the box's */
    #webamp .winify-lyrics .wl-bottom .playlist-bottom { flex: 1; background-position: left bottom; display: flex; align-items: center; padding: 0 24px 0 8px; }   /* clear of the grip */
  `;
  document.head.appendChild(style);
}

function build(spot) {
  injectStyles();
  const st = skinStyle();
  const d = document.createElement('div');
  d.className = 'winify-lyrics';
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-label', TITLE);
  d.innerHTML = `
    <div class="wl-top selected">
      <div class="playlist-top-left"></div>
      <div class="playlist-top-left-fill"></div>
      <div class="wl-title"></div>
      <div class="playlist-top-left-fill"></div>
      <div class="playlist-top-right"><div class="wl-close" role="button" aria-label="Close"></div></div>
    </div>
    <div class="wl-middle">
      <div class="playlist-middle-left"></div>
      <div class="wl-body" tabindex="-1"></div>
      <div class="playlist-middle-right"><div class="wl-handle playlist-scrollbar-handle"></div></div>
    </div>
    <div class="wl-bottom"><div class="playlist-bottom"></div></div>`;
  const plate = skinText(TITLE);
  plate.style.background = st.normalbg;
  d.querySelector('.wl-title').appendChild(plate);
  d.querySelector('.wl-bottom .playlist-bottom').appendChild(skinText(CREDIT));
  const body = d.querySelector('.wl-body');
  Object.assign(body.style, { background: st.normalbg, color: st.normal, fontFamily: st.font });
  place(d, spot);
  makeDraggable(d, d.querySelector('.wl-top'), { ignore: '.wl-close', onMoved: (rect) => panels.placed('lyrics', rect) });
  makeResizable(d, { minWidth: panels.MIN_SIZE.w, minHeight: panels.MIN_SIZE.h, onResize: placeHandle,
    onResized: (rect) => panels.placed('lyrics', rect) });
  d.querySelector('.wl-close').addEventListener('click', () => close(true));
  body.addEventListener('scroll', placeHandle, { passive: true });
  dragHandle(d.querySelector('.wl-handle'), body);
  // Clicks here are the window's own; Webamp's windows underneath keep theirs.
  d.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.querySelector('#webamp').appendChild(d);
  return d;
}

function place(d, r) {
  d.style.left = r.x + 'px';
  d.style.top = r.y + 'px';
  d.style.width = r.w + 'px';
  d.style.height = r.h + 'px';
}

// The skin's scrollbar handle follows the text, and can be dragged.
function placeHandle() {
  if (!el) return;
  const body = el.querySelector('.wl-body');
  const handle = el.querySelector('.wl-handle');
  const track = el.querySelector('.wl-middle .playlist-middle-right');
  const overflow = body.scrollHeight - body.clientHeight;
  handle.style.display = overflow > 0 ? '' : 'none';
  handle.style.top = (overflow > 0 ? Math.round((body.scrollTop / overflow) * (track.clientHeight - 18)) : 0) + 'px';
}

function dragHandle(handle, body) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const track = handle.parentElement.clientHeight - 18;
    const startY = e.clientY;
    const startTop = handle.offsetTop;
    const move = (ev) => {
      const top = Math.max(0, Math.min(track, startTop + ev.clientY - startY));
      body.scrollTop = (top / track) * (body.scrollHeight - body.clientHeight);
    };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

// The body: title and artist, then the lyrics or a quiet note.
function draw(head, text, note, retry) {
  if (!el) return;
  const st = skinStyle();
  const body = el.querySelector('.wl-body');
  body.textContent = '';
  if (head) {
    const h = document.createElement('div');
    h.className = 'wl-head';
    const title = document.createElement('div');
    title.className = 'wl-track';
    title.style.color = st.current;
    title.textContent = head.title || '';
    const artist = document.createElement('div');
    artist.textContent = head.artist || '';
    h.append(title, artist);
    body.appendChild(h);
  }
  if (text) {
    const t = document.createElement('div');
    t.className = 'wl-text';
    t.textContent = text;
    body.appendChild(t);
  }
  if (note) {
    const n = document.createElement('div');
    n.className = 'wl-note';
    n.textContent = note;
    if (retry) {
      n.classList.add('wl-retry');
      n.addEventListener('click', retry);
    }
    body.appendChild(n);
  }
  body.scrollTop = 0;
  placeHandle();
}

// ---- Following the current track ------------------------------------------------------

async function show(uri) {
  shownUri = uri;
  const seq = ++lookupSeq;
  const n = ctx.now;
  const head = { title: n.title, artist: n.artist };
  if (!uri) { draw(null, null, 'Nothing playing'); return; }
  if (!/^spotify:track:/.test(uri)) { draw(head, null, 'No lyrics for podcast episodes'); return; }
  const cached = lyricsCache.get(uri);
  if (cached) { render(head, cached); return; }
  draw(head, null, 'Looking up lyrics…');
  let result;
  try {
    const d = await trackDetails(uri);
    if (seq !== lookupSeq) return;
    result = await lookUp(d);
  } catch (err) {
    if (seq !== lookupSeq) return;
    warn('lookup failed -', err.message);
    draw(head, null, (err.busy ? 'LRCLIB is busy.' : 'Couldn’t reach LRCLIB.') + ' Click to try again.',
      () => { if (shownUri === uri) show(uri); });
    return;
  }
  lyricsCache.set(uri, result);
  log(head.title, '-', result.state + (result.source ? ' (' + result.source + ')' : ''),
    result.synced ? '- synced lyrics kept' : '');
  if (seq === lookupSeq) render(head, result);
}

function render(head, r) {
  if (r.state === 'found') draw(head, r.plain);
  else if (r.state === 'instrumental') draw(head, null, 'Instrumental — no lyrics');
  else draw(head, null, 'No lyrics found for this track');
}

function watch() {
  if (!ctx || !el) return;
  const uri = ctx.now.where === 'none' ? null : ctx.now.trackUri || null;
  if (uri !== shownUri) show(uri);
}

// ---- Open / close -------------------------------------------------------------------

export async function open() {
  if (!ctx || opening) return;
  if (el) { panels.focus('lyrics'); return; }
  opening = true;
  const spot = panels.opening('lyrics');
  opening = false;
  el = build(spot);
  panels.opened('lyrics');
  log('window opened at', spot.x + ',' + spot.y, 'in a', window.innerWidth + 'x' + window.innerHeight, 'window');
  shownUri = undefined;
  watch();
  watchTimer = setInterval(watch, WATCH_MS);
}

// `false`: put away without closing it on purpose (signing out), so it is
// still remembered as open.
export function close(byUser = true) {
  if (!el) return;
  clearInterval(watchTimer);
  watchTimer = null;
  lookupSeq++;
  el.remove();
  el = null;
  if (byUser !== false) panels.closed('lyrics');
  log('window closed');
}

export function toggle() {
  if (el) close(true);
  else open();
}

export const isOpen = () => !!el;

// ---- Ways in ------------------------------------------------------------------------

function onClickCapture(e) {
  if (!ctx || !(e.target instanceof Element)) return;
  if (e.target.closest('#webamp #button-i')) {
    toggle();
  } else if (e.target.closest('#webamp #playlist-misc-menu')) {
    // In place of Webamp's SORT LIST / FILE INF / MISC OPTS menu.
    e.preventDefault();
    e.stopPropagation();
    toggle();
  }
}

// Option+3 (Alt+3). Matched by key position: Option+3 types "£" or "#".
function onKeyDown(e) {
  if (!ctx || !e.altKey || e.metaKey || e.ctrlKey || e.code !== 'Digit3') return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
  e.preventDefault();
  toggle();
}

// ---- The LYRIC button -----------------------------------------------------------------
// MISC's label is part of the skin's playlist bitmap (bottom-left corner,
// 125x38). In the default skin it is redrawn as LYRIC, in the same 5 px
// lettering and the bitmap's own colours, with a pressed state. Other skins
// keep their own art. Every skin gets the "Lyrics" tooltip.

const BUTTON = { x: 101, y: 8, w: 22, h: 18 };        // MISC within that bitmap
// The default skin's MISC button, pixel for pixel (see COLORS).
const BASE_MISC = [
  '.....................#',
  '.ooooooooooooooooooo.x',
  '.o*****************.#+',
  '.o*****************.=+',
  '.o*****************.=+',
  '.o*****************.=+',
  '.o*-***-*-**--**--*.=+',
  '.o*--*--***-***-***.=+',
  '.o*-----*-**-**-***.=+',
  '.o*-*-*-*-***-*-***.=+',
  '.o*-***-*-*--***--*.=+',
  '.o*****************.=+',
  '.o*****************.=+',
  '.o*****************.=+',
  '.o*****************.=+',
  '.o..................=+',
  '..#==================+',
  '#x++++++++++++++++++++',
];
const COLORS = { '.': '#adb4c4', '#': '#8192a5', o: '#edffff', x: '#576476', '*': '#bfcdd3', '+': '#4e586e', '=': '#798296', '-': '#2f374d' };
// L Y R I C: 3+1+3+1+3+1+1+1+3 = 17 px, the button face's full width
// (columns 2-18), in the letters the other buttons use (R from REM, C and
// I from MISC, L from SEL).
const LYRIC = [
  '#...#.#.##..#..##',
  '#...#.#.#.#.#.#..',
  '#....#..##..#.#..',
  '#....#..#.#.#.#..',
  '###..#..#.#.#..##',
];
const LETTER_TOP = 6;
const LETTER_LEFT = 2;

let lyricStyle = null;
let checkedSkin = null;
let unsubscribeSkin = null;

const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

function isDefaultMisc(data) {
  for (let y = 0; y < BUTTON.h; y++) {
    for (let x = 0; x < BUTTON.w; x++) {
      const i = (y * BUTTON.w + x) * 4;
      if (hex(data[i], data[i + 1], data[i + 2]) !== COLORS[BASE_MISC[y][x]]) return false;
    }
  }
  return true;
}

// The button, normal or pressed (bevel inverted, lettering one pixel lower).
function drawLyric(pressed) {
  const c = document.createElement('canvas');
  c.width = BUTTON.w;
  c.height = BUTTON.h;
  const g = c.getContext('2d');
  const put = (x, y, key) => { g.fillStyle = COLORS[key]; g.fillRect(x, y, 1, 1); };
  for (let y = 0; y < BUTTON.h; y++) {
    for (let x = 0; x < BUTTON.w; x++) {
      let key = BASE_MISC[y][x];
      if (key === '-') key = '*';                                   // clear MISC
      if (pressed) {
        const topLeft = (y === 1 && x >= 1 && x <= 19) || (x === 1 && y >= 1 && y <= 15);
        const bottomRight = (y === 15 && x >= 2 && x <= 19) || (x === 19 && y >= 2 && y <= 15);
        if (topLeft) key = '.';
        else if (bottomRight) key = 'o';
      }
      put(x, y, key);
    }
  }
  const top = LETTER_TOP + (pressed ? 1 : 0);
  LYRIC.forEach((row, dy) => [...row].forEach((p, dx) => { if (p === '#') put(LETTER_LEFT + dx, top + dy, '-'); }));
  return c.toDataURL('image/png');
}

// On each skin change: redraw MISC as LYRIC if it is the default skin's.
function relabel() {
  if (!ctx) return;
  const misc = document.querySelector('#webamp #playlist-misc-menu');
  if (misc && misc.title !== 'Lyrics') misc.title = 'Lyrics';
  const corner = document.querySelector('#webamp .playlist-bottom-left');
  const url = corner && (/url\("([^"]+)"\)/.exec(getComputedStyle(corner).backgroundImage) || [])[1];
  if (!url || url === checkedSkin) return;
  checkedSkin = url;
  const img = new Image();
  img.onload = () => {
    if (checkedSkin !== url || !lyricStyle) return;
    const c = document.createElement('canvas');
    c.width = BUTTON.w;
    c.height = BUTTON.h;
    const g = c.getContext('2d');
    g.drawImage(img, BUTTON.x, BUTTON.y, BUTTON.w, BUTTON.h, 0, 0, BUTTON.w, BUTTON.h);
    const isDefault = img.width === 125 && isDefaultMisc(g.getImageData(0, 0, BUTTON.w, BUTTON.h).data);
    lyricStyle.textContent = isDefault ? `
      #webamp #playlist-misc-menu { background: url("${drawLyric(false)}") no-repeat; image-rendering: pixelated; }
      #webamp #playlist-misc-menu:active { background-image: url("${drawLyric(true)}"); }` : '';
    log('MISC button:', isDefault ? 'default skin - relabelled LYRIC' : 'skin\'s own art kept');
  };
  img.src = url;
}

// ---- Lifecycle ----------------------------------------------------------------------

export function init(c) {
  ctx = c;
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('keydown', onKeyDown);
  lyricStyle = document.createElement('style');
  lyricStyle.id = 'winify-lyric-button';
  document.head.appendChild(lyricStyle);
  checkedSkin = null;
  unsubscribeSkin = ctx.webamp.store.subscribe(relabel);
  relabel();
  // Reopened at launch, with the other panels, by the panel manager.
  panels.register('lyrics', {
    defaultWidth: WIDTH,
    open, close: () => close(true), isOpen,
    element: () => el,
    getRect: () => (el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null),
    setRect: (rect) => { if (el) { place(el, rect); placeHandle(); } },
  });
}

export function reset() {
  close(false);
  document.removeEventListener('click', onClickCapture, true);
  document.removeEventListener('keydown', onKeyDown);
  if (unsubscribeSkin) unsubscribeSkin();
  unsubscribeSkin = null;
  if (lyricStyle) lyricStyle.remove();
  lyricStyle = null;
  ctx = null;
  lyricsCache.clear();
  detailsCache.clear();
  shownUri = undefined;
}

// For inspection from DevTools and tests.
window.WinifyLyrics = {
  open, close, toggle, isOpen,
  find: (details) => lookUp(details),
  state: () => ({ open: !!el, shownUri, cached: [...lyricsCache.keys()],
    entry: shownUri ? lyricsCache.get(shownUri) || null : null,
    text: el ? el.querySelector('.wl-body').innerText : null }),
};
