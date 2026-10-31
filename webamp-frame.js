/* A Winamp window frame for Winify's own panels, and consistent cursors.
 *
 * Frame: Webamp's generic window (the one Milkdrop has), built from the same
 * markup: .gen-window with its .gen-top / .gen-middle / .gen-bottom pieces,
 * and the title in the skin's own pixel lettering (.gen-text-<letter>, from
 * GEN.BMP). Webamp's stylesheet draws all of it from whatever skin is
 * loaded, focused (.selected) and unfocused, so a panel built here looks
 * like Milkdrop and changes with the skin. Any panel can use it.
 *
 * Cursors: the same cursor for every title bar (Webamp's windows and the
 * panels) and the same for every resize corner. From the skin when it has
 * them (TITLEBAR, else PTBAR; PSIZE), else macOS's standard arrow and
 * diagonal resize cursor.
 */

const log = (...args) => console.log('[winify/frame]', ...args);

// Webamp's generic window: 20 px title bar, 14 px bottom edge, 11 px left
// and 8 px right borders.
export const CHROME = { top: 20, bottom: 14, left: 11, right: 8 };

const div = (cls, children = []) => {
  const d = document.createElement('div');
  d.className = cls;
  for (const c of children) d.appendChild(c);
  return d;
};

// The title in the skin's generic-window lettering (letters A-Z and space;
// anything else is left out, as Webamp does).
function lettering(title) {
  return [...title.toUpperCase()].filter((ch) => ch === ' ' || (ch >= 'A' && ch <= 'Z'))
    .map((ch) => div('draggable gen-text-letter gen-text-' + (ch === ' ' ? 'space' : ch.toLowerCase())));
}

// { root, top, close, content, grip, setFocused(on) }. `cls` names the panel
// (on the root); `prefix` names its title bar and close button
// (`${prefix}-top`, `${prefix}-close`).
export function makeFrame({ title, cls, prefix }) {
  const close = div('gen-close selected ' + prefix + '-close');
  close.setAttribute('role', 'button');
  close.setAttribute('aria-label', 'Close');
  const titleCell = div('gen-top-title draggable', lettering(title));
  const top = div('gen-top draggable ' + prefix + '-top', [
    div('gen-top-left draggable'), div('gen-top-left-fill draggable'), div('gen-top-left-end draggable'),
    titleCell,
    div('gen-top-right-end draggable'), div('gen-top-right-fill draggable'),
    div('gen-top-right draggable', [close]),
  ]);
  const content = div('gen-middle-center winify-frame-content');
  const middle = div('gen-middle', [
    div('gen-middle-left draggable', [div('gen-middle-left-bottom draggable')]),
    content,
    div('gen-middle-right draggable', [div('gen-middle-right-bottom draggable')]),
  ]);
  const grip = div('winify-grip winify-resize');
  const bottom = div('gen-bottom draggable', [
    div('gen-bottom-left draggable'),
    div('gen-bottom-right draggable', [grip]),
  ]);
  const root = div('gen-window window winify-frame ' + cls, [top, middle, bottom]);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', title);
  return {
    root, top, close, content, grip,
    setFocused: (on) => root.classList.toggle('selected', !!on),
  };
}

export const FRAME_CSS = `
  #webamp .winify-frame { position: fixed; image-rendering: pixelated; }
  /* The middle keeps to the frame's height (its content scrolls), rather than
     growing with what it holds. */
  #webamp .winify-frame .gen-middle { flex: 1 1 0; min-height: 0; overflow: hidden; }
  /* The title bar (20 px) and bottom edge (14 px) never give way to it: a
     squeezed bottom edge left its 14 px corner pieces hanging 8 px below the
     frame, past the windows beside it, with a dark notch between them. */
  #webamp .winify-frame .gen-top, #webamp .winify-frame .gen-bottom { flex-shrink: 0; }
  #webamp .winify-frame .winify-frame-content { display: flex; flex-direction: column; overflow: hidden; min-width: 0; min-height: 0; }
  #webamp .winify-frame .winify-resize { position: absolute; right: 0; bottom: 0; width: 20px; height: 20px; }
`;

// ---- Cursors ----------------------------------------------------------------------

const TITLE_BARS = [
  '#webamp #main-window #title-bar', '#webamp #main-window.shade #title-bar',
  '#webamp #playlist-window .playlist-top', '#webamp #playlist-window-shade',
  '#webamp #equalizer-window .title-bar', '#webamp #equalizer-window.shade',
  '#webamp .gen-window .gen-top',
];
const RESIZE_CORNERS = [
  '#webamp #playlist-window #playlist-resize-target', '#webamp #playlist-window-shade #playlist-resize-target',
  '#webamp .gen-window #gen-resize-target', '#webamp .gen-window .winify-resize',
];

let webamp = null;
let cursorStyle = null;
let unsubscribe = null;
let lastCursors;

// A skin cursor, if the skin has it as a plain .cur (animated ones are left
// to Webamp, which draws them itself).
const skinCursor = (cursors, ...names) => {
  for (const n of names) {
    const c = cursors && cursors[n];
    if (c && c.type === 'cur' && c.url) return c.url;
  }
  return null;
};

function paintCursors() {
  const cursors = webamp.store.getState().display.skinCursors;
  if (cursors === lastCursors) return;
  lastCursors = cursors;
  const title = skinCursor(cursors, 'TITLEBAR', 'PTBAR');
  const resize = skinCursor(cursors, 'PSIZE');
  cursorStyle.textContent = `
    ${TITLE_BARS.join(',\n    ')} { cursor: ${title ? `url(${title}), default` : 'default'} !important; }
    ${RESIZE_CORNERS.join(',\n    ')} { cursor: ${resize ? `url(${resize}), nwse-resize` : 'nwse-resize'} !important; }`;
  log('cursors:', title ? 'the skin\'s title bar' : 'standard arrow', '/', resize ? 'the skin\'s resize' : 'standard resize');
}

export function attach(instance) {
  webamp = instance;
  if (!cursorStyle) {
    cursorStyle = document.createElement('style');
    cursorStyle.id = 'winify-cursors';
    document.head.appendChild(cursorStyle);
  }
  lastCursors = undefined;
  paintCursors();
  unsubscribe = webamp.store.subscribe(paintCursors);
}

export function detach() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  webamp = null;
}
