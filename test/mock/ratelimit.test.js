// Spotify 429 (rate limit) on the player endpoints: Winify backs off and says so plainly.
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 120000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); };
  const calls = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))'));
  const marquee = () => js('WinifyWebamp.getInstance().store.getState().userInput.userMessage');
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))'); await h.wait(2500);

  console.log('1. A long rate limit (19798 s, as on the real account)');
  await js('mock.limitPlayer = { until: Date.now() + 19798e3, retryAfter: 19798 }'); await calls();
  await h.click(win, js, '#webamp #eject'); await h.wait(600);
  await js(`(() => { const r = document.querySelectorAll('.winify-picker .wp-row')[1]; r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`); await h.wait(800);
  const msg = await marquee();
  check('picker: "Spotify rate limit - try again in 5 h 30 min", not "Could not play that playlist"', msg === 'Spotify rate limit - try again in 5 h 30 min', msg);
  let cs = await calls();
  const firstHits = cs.filter((c) => c[0] === 'net:player').length;
  await h.wait(10000);
  cs = await calls();
  check('for the next 10 s: no requests reach the blocked player endpoints (polling held back)', cs.filter((c) => c[0] === 'net:player').length === 0, JSON.stringify(cs.filter((c) => c[0] === 'net:player')).slice(0, 200) + ' (before: ' + firstHits + ')');
  await h.click(win, js, '#webamp #eject'); await h.wait(800);
  cs = await calls();
  check('the picker still lists your playlists (from its cache, no new request)', (await js('WinifyPicker.state().rows')) > 10, JSON.stringify((await js('WinifyPicker.state()'))));
  await js('WinifyPicker.close()');

  console.log('2. A short one: held back while it lasts, then Winify carries on');
  await js('mock.limitPlayer = null'); await js('location.reload()'); await h.wait(500);
  while (!(await js('window.mounted === true').catch(() => false))) await h.wait(100);
  await js('(mock.active = "phone", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))'); await h.wait(2500);
  await js('mock.limitPlayer = { until: Date.now() + 4000, retryAfter: 4 }'); await calls();
  await js('WinifyControls.refresh()'); await h.wait(300);
  let hits = (await calls()).filter((c) => c[0] === 'net:player').length;
  check('the first request meets the 429', hits === 1, hits);
  await js('WinifyControls.refresh()'); await js('WinifyControls.refresh()'); await h.wait(300);
  hits = (await calls()).filter((c) => c[0] === 'net:player').length;
  check('...while it lasts, further reads stay home', hits === 0, hits);
  await h.wait(4500); await js('WinifyControls.refresh()'); await h.wait(500);
  hits = (await calls()).filter((c) => c[0] === 'net:player').length;
  check('after Retry-After (4 s), requests go out again', hits === 1, hits);
  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
