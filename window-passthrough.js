/* Click-through for Winify's see-through window.
 *
 * The window covers the screen's usable area but draws only the chassis, the
 * Webamp windows and Winify's own windows. While the pointer is over one of
 * those (or a menu of theirs), the window takes clicks; anywhere else they
 * pass through to whatever is behind. The main process does the switching
 * (setIgnoreMouseEvents, with mouse moves still forwarded here so this can
 * tell when the pointer comes back).
 *
 * "Over one of those" is simply: the browser finds an element under the
 * pointer. The full-window layers (body, Webamp's layer) take no pointer
 * events, so over an empty part there is none. While a button is held (a
 * drag that strays off a window) clicks stay with Winify until it is let go.
 */
(function () {
  'use strict';
  var IPC = window.spotify;
  if (!IPC || !IPC.setPassThrough) return;

  var passing = null;          // what the main process was last told
  var buttons = 0;             // mouse buttons held
  var last = null;             // last pointer position

  function overSomething(x, y) {
    var el = document.elementFromPoint(x, y);
    return !!el && el !== document.body && el !== document.documentElement;
  }

  function decide() {
    var pass = buttons === 0 && (!last || !overSomething(last.x, last.y));
    // In full screen (Milkdrop) the whole window is the picture.
    if (document.fullscreenElement) pass = false;
    if (pass === passing) return;
    passing = pass;
    IPC.setPassThrough(pass);
  }

  document.addEventListener('mousemove', function (e) {
    last = { x: e.clientX, y: e.clientY };
    buttons = e.buttons;
    decide();
  }, true);
  document.addEventListener('mousedown', function (e) { buttons = e.buttons || 1; last = { x: e.clientX, y: e.clientY }; decide(); }, true);
  document.addEventListener('mouseup', function (e) { buttons = e.buttons; last = { x: e.clientX, y: e.clientY }; decide(); }, true);
  // The pointer left the window (over the menu bar or the Dock).
  document.addEventListener('mouseleave', function () { buttons = 0; last = null; decide(); });
  // Windows opening, closing or moving under a still pointer.
  var pending = false;
  new MutationObserver(function () {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; decide(); });
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  document.addEventListener('fullscreenchange', decide);

  window.WinifyPassThrough = {
    state: function () { return { passing: passing, buttons: buttons, last: last }; },
    overSomething: overSomething,
  };
})();
