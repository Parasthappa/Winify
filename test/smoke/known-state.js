// Runs in Winify's page before its own scripts (a session preload, smoke test
// only): sets aside the user's window layout, window positions, lyrics
// setting and the chassis's spot so every run starts from Winify's defaults.
// smoke.js puts them back at the end. If a run dies half-way, the next run restores them instead of
// setting aside the defaults.
if (location.origin === 'http://127.0.0.1:8899') {
  const KEYS = ['winify.layout.v2', 'winify.dialogs.v1', 'winify.lyrics.open', 'winify.chassis.v1'];
  const SAVED = 'winify.smoke.saved';
  try {
    if (localStorage.getItem(SAVED) == null) {
      const snap = {};
      KEYS.forEach((k) => { snap[k] = localStorage.getItem(k); });
      localStorage.setItem(SAVED, JSON.stringify(snap));
    }
    KEYS.forEach((k) => localStorage.removeItem(k));
  } catch (e) { /* storage unavailable */ }
}
