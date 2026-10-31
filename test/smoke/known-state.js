// Runs in Winify's page before its own scripts (a session preload, smoke test
// only): sets aside the user's window layout, window positions, lyrics
// setting, the chassis's spot and saved mixes, so every run starts from
// Winify's defaults (and a run's own mix is not left behind).
// smoke.js puts them back at the end. If a run dies half-way, the next run restores them instead of
// setting aside the defaults.
// Winify's page, on whichever port it got (8899-8903; the packaged app 8909-8913).
if (/^http:\/\/127\.0\.0\.1:\d+$/.test(location.origin)) {
  // 'winify.index.paused': the My playlists index (a build is hundreds of requests) sends none during the run.
  const KEYS = ['winify.layout.v2', 'winify.panels.v1', 'winify.lyrics.open', 'winify.chassis.v1', 'winify.mixes.v1', 'winify.index.paused'];
  const SAVED = 'winify.smoke.saved';
  try {
    if (localStorage.getItem(SAVED) == null) {
      const snap = {};
      KEYS.forEach((k) => { snap[k] = localStorage.getItem(k); });
      localStorage.setItem(SAVED, JSON.stringify(snap));
    }
    KEYS.forEach((k) => localStorage.removeItem(k));
    localStorage.setItem('winify.index.paused', '1');
  } catch (e) { /* storage unavailable */ }
}
