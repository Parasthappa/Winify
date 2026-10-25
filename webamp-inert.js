/* Webamp controls with no Spotify meaning, made quiet.
 *
 * Several of Webamp's own controls do something loud when there is nothing
 * for them to do here: native alert() dialogs, file downloads, a native file
 * picker. Each is neutralised narrowly, only for the control that triggers
 * it, so Webamp's useful dialogs (a skin that fails to load, say) still show.
 *
 * Menu items with no Spotify meaning at all are hidden rather than left doing
 * nothing (see DEAD_MENU_ITEMS).
 *
 * The main window's title bar has no buttons: minimize and close are the
 * Winify panel's yellow and red lights, and windowshade is a double-click on
 * the title bar (as in classic Winamp). See TITLE_BAR_CSS.
 *
 * The main menu's Exit hides the Winify window, as the red light does:
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

// Hidden, not removed: the menus are Webamp's (React's) to rebuild.
//   Playback > 10 tracks back / fwd   Webamp stepping its own list (Spotify
//                                     plays the order; Next/Previous remain)
//   LIST OPTS > new list, save list   nothing to clear or save (load list
//                                     opens the playlist picker)
//   EQ > Presets                      Spotify has no EQ: presets only moved
//                                     the sliders; Save and From Eqf... are
//                                     file dialogs. The button opens nothing.
const DEAD_MENU_ITEMS = new Set(['10 tracks back', '10 tracks fwd']);
const DEAD_MENU_CSS = `
  #webamp #playlist-list-menu li:has(.new-list),
  #webamp #playlist-list-menu li:has(.save-list) { display: none; }
  /* The main menu's first item, "Webamp...", links to webamp.org: Webamp's
     own about page, not Winify's. It goes, with the line under it. */
  #webamp-context-menu li:has(> a[href*="webamp.org"]),
  #webamp-context-menu li:has(> a[href*="webamp.org"]) + li.hr { display: none; }`;

// The main window's title bar without its minimize, windowshade and close
// buttons. The skin paints them into the title bar image itself (their own
// elements draw only the pressed look), so they are covered with the title
// bar's own image: Webamp's three button elements, unclickable now, become
// three layers of it (background-image: inherit, so it follows the skin and
// the focused / unfocused image). The layout is Winamp's title bar template,
// the same in every skin: buttons at x 244-271, rows 3-11, the right-hand
// band ending at x 242.
//   #minimize  the column between the windowshade and close buttons (x 263,
//              plain title bar) stretched over all three: the buttons gone.
//   #shade     a stretch of the right-hand band's middle (x 205-232), on to
//              x 268: the band carries on where the buttons were.
//   #close     the band's end (x 241-243), moved to x 269-271.
// In windowshade mode the bar has no band: only the first layer.
// Clicks pass through all three to the title bar, so it drags across its
// whole width and a double-click still toggles windowshade.
const TITLE_BAR_CSS = `
  #webamp #main-window #title-bar #minimize,
  #webamp #main-window #title-bar #shade,
  #webamp #main-window #title-bar #close {
    pointer-events: none !important; background-image: inherit !important;
    background-repeat: no-repeat !important; image-rendering: pixelated; }
  #webamp #main-window #title-bar #minimize {
    position: absolute !important; left: 243px !important; top: 0 !important; width: 29px !important; height: 14px !important;
    background-size: 7975px 14px !important; background-position: -7627px 0 !important; }
  #webamp #main-window #title-bar #shade {
    position: absolute !important; left: 241px !important; top: 3px !important; width: 28px !important; height: 9px !important;
    background-size: auto !important; background-position: -205px -3px !important; }
  #webamp #main-window #title-bar #close {
    position: absolute !important; left: 269px !important; top: 3px !important; width: 3px !important; height: 9px !important;
    background-size: auto !important; background-position: -241px -3px !important; }
  #webamp #main-window.shade #title-bar #shade,
  #webamp #main-window.shade #title-bar #close { display: none !important; }`;
let deadMenuStyle = null;

function hideDeadItems() {
  for (const li of document.querySelectorAll('#webamp-context-menu li')) {
    const label = li.firstChild && li.firstChild.nodeType === Node.TEXT_NODE ? li.firstChild.textContent.trim() : '';
    if (DEAD_MENU_ITEMS.has(label) && li.style.display !== 'none') li.style.display = 'none';
  }
}

// Webamp attaches its menus straight to <body>; watching only <body>'s own
// children keeps this off Webamp's constant redraws.
const menuObserver = new MutationObserver(() => {
  hideDeadItems();
  // A menu's items can land a frame after the menu itself.
  if (document.getElementById('webamp-context-menu')) requestAnimationFrame(hideDeadItems);
});

function onClickCapture(e) {
  if (!attached || !(e.target instanceof Element)) return;
  if (e.target.closest('#webamp #presets-context')) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
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
  deadMenuStyle = document.createElement('style');
  deadMenuStyle.id = 'winify-dead-menu-items';
  deadMenuStyle.textContent = DEAD_MENU_CSS + TITLE_BAR_CSS;
  document.head.appendChild(deadMenuStyle);
  menuObserver.observe(document.body, { childList: true });
  unsubscribers = [
    // The main menu's Exit (the title bar's close button is gone).
    webamp.onWillClose((cancel) => {
      cancel();
      window.spotify.windowCommand('hide');
    }),
  ];
}

export function detach() {
  attached = false;
  document.removeEventListener('click', onClickCapture, true);
  menuObserver.disconnect();
  if (deadMenuStyle) deadMenuStyle.remove();
  deadMenuStyle = null;
  unsubscribers.forEach((off) => { try { off(); } catch (e) { /* gone */ } });
  unsubscribers = [];
}
