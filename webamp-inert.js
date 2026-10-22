/* Webamp controls with no Spotify meaning, made quiet.
 *
 * Several of Webamp's own controls do something loud when there is nothing
 * for them to do here: native alert() dialogs, file downloads, a native file
 * picker. Each is neutralised narrowly, only for the control that triggers
 * it, so Webamp's useful dialogs (a skin that fails to load, say) still show.
 *
 * Close and minimize act on the Winify window, as a native app's would:
 * Webamp's own close would otherwise remove the whole interface, leaving an
 * empty window until relaunch.
 */

import { ignoreStopFromListClear } from './webamp-spotify.js';

const log = (...args) => console.log('[winify/webamp]', ...args);

let attached = false;

// Hardcoded alert("Not supported in Webamp") behind two playlist menu items.
// The click marks the next alert as expected; anything else still alerts.
const QUIET_ALERT_ITEMS = '#webamp .remove-misc, #webamp .file-info';
let alertExpected = false;
let realAlert = null;

// Downloads: EQ > Presets > Save, and MISC > options > Generate HTML playlist.
let realAnchorClick = null;

// EQ > Presets > Load > From Eqf...: a file prompt filtered to .eqf. Skins
// (.wsz/.zip) still prompt normally.
let realInputClick = null;

function onClickCapture(e) {
  if (!attached || !(e.target instanceof Element)) return;
  // Clearing the list sends STOP first; it must not pause Spotify.
  if (e.target.closest('#webamp .remove-all, #webamp .new-list')) ignoreStopFromListClear();
  if (e.target.closest(QUIET_ALERT_ITEMS)) {
    alertExpected = true;
    setTimeout(() => { alertExpected = false; }, 0);
  }
}

function install() {
  if (realAlert) return;
  realAlert = window.alert;
  window.alert = function (message) {
    if (attached && alertExpected) {
      alertExpected = false;
      log('ignored (no Spotify equivalent):', message);
      return undefined;
    }
    return realAlert.call(window, message);
  };

  realAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (attached && this.hasAttribute('download')) {
      log('ignored download (no Spotify equivalent):', this.download);
      return undefined;
    }
    return realAnchorClick.call(this);
  };

  realInputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (attached && this.type === 'file' && /\.eqf/i.test(this.accept || '')) {
      log('ignored EQ preset file prompt (no Spotify equivalent)');
      return undefined;
    }
    return realInputClick.call(this);
  };
}

// No-op handlers for Webamp's optional list hooks; without them Webamp
// alert()s "Not supported in Webamp". Returning null changes nothing.
export function handleAddUrlEvent() {
  log('ignored ADD > URL (no Spotify equivalent)');
  return null;
}

export function handleSaveListEvent() {
  log('ignored LIST OPTS > save list (no Spotify equivalent)');
  return null;
}

let unsubscribers = [];

export function attach(webamp) {
  install();
  attached = true;
  document.addEventListener('click', onClickCapture, true);
  unsubscribers = [
    webamp.onWillClose((cancel) => {
      cancel();
      window.spotify.windowCommand('hide');
    }),
    webamp.onMinimize(() => window.spotify.windowCommand('minimize')),
  ];
}

export function detach() {
  attached = false;
  document.removeEventListener('click', onClickCapture, true);
  unsubscribers.forEach((off) => { try { off(); } catch (e) { /* gone */ } });
  unsubscribers = [];
}
