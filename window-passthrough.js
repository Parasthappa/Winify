/* Click-through for Winify's see-through window.
 *
 * The window covers the screen's usable area but draws only the chassis, the
 * Webamp windows and Winify's own windows. While the pointer is over one of
 * those (or a menu of theirs), the window takes clicks; anywhere else they
 * pass through to whatever is behind. The main process does the switching
 * (setIgnoreMouseEvents). Where the pointer is comes two ways: forwarded
 * mouse moves, which only arrive while Winify is the active app, and the
 * main process's own reading of it a few times a second (onCursor), which
 * keeps working after another app or the desktop has taken the clicks.
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
  var realMouseIgnored = false; // tests: only the main process's readings count

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
    if (realMouseIgnored) return;
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
  if (IPC.onCursor) {
    IPC.onCursor(function (p) {
      // A button held in another app is no drag of Winify's.
      if (!document.hasFocus()) buttons = 0;
      last = { x: p.x, y: p.y };
      passing = null;            // the main process may have switched by itself
      decide();
    });
  }
  window.addEventListener('blur', function () { buttons = 0; });

  window.WinifyPassThrough = {
    state: function () { return { passing: passing, buttons: buttons, last: last }; },
    overSomething: overSomething,
    // Tests: the window covers the screen, so a real mouse moved by someone
    // during a run would mix in with the positions the test sets.
    ignoreRealMouse: function (on) { realMouseIgnored = !!on; },
  };
})();
