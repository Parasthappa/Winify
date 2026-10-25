/* Always on top: the main window's A button (classic Winamp's "always on
 * top"). It keeps Winify above other apps' windows, or lets it go back to
 * being an ordinary window. The setting lives in the main process (remembered
 * in config.json); the button shows it, lit (the skin's own pressed look,
 * #button-a.selected) while on.
 */

const log = (...args) => console.log('[winify/window]', ...args);
const TITLE = 'Always on top';

let webamp = null;
let level = 'normal';                 // as the main process last said
let unsubscribe = null;
let listening = false;

function button() {
  return document.querySelector('#webamp #main-window #button-a');
}

// The button's look and tooltip, again after every redraw of the main window.
function paint() {
  const b = button();
  if (!b) return;
  const on = level === 'top';
  if (b.classList.contains('selected') !== on) b.classList.toggle('selected', on);
  if (b.title !== TITLE) b.title = TITLE;
  const pressed = on ? 'true' : 'false';
  if (b.getAttribute('aria-pressed') !== pressed) { b.setAttribute('role', 'button'); b.setAttribute('aria-pressed', pressed); }
}

function onClickCapture(e) {
  if (!webamp || !(e.target instanceof Element) || !e.target.closest('#webamp #main-window #button-a')) return;
  e.preventDefault();
  e.stopPropagation();
  const next = level === 'top' ? 'normal' : 'top';
  log('always on top:', next === 'top' ? 'on' : 'off');
  if (window.spotify && window.spotify.setWindowLevel) window.spotify.setWindowLevel(next);
}

export const windowLevel = () => level;

export function attach(instance) {
  webamp = instance;
  document.addEventListener('click', onClickCapture, true);
  unsubscribe = webamp.store.subscribe(paint);
  // The preload's listeners cannot be removed, so register once per page.
  if (!listening && window.spotify && window.spotify.onWindowLevel) {
    window.spotify.onWindowLevel((l) => { level = l || 'normal'; paint(); });
    listening = true;
  }
  paint();
}

export function detach() {
  document.removeEventListener('click', onClickCapture, true);
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  webamp = null;
}

window.WinifyOnTop = { state: () => ({ level }) };
