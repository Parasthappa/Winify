// The Spotify request governor (spotify-governor.js), with a 1 s "minute" and
// a 5 s "hour", in a scratch folder standing in for the shared one. Nothing
// is sent anywhere: it only decides when requests may go.
const { app } = require('electron'); const fs = require('fs'), os = require('os'), path = require('path');
const { create, CAPS } = require(path.join(__dirname, '..', '..', 'spotify-governor.js'));
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 60000);
const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const caps = { hard: { minute: 6, hour: 12 }, user: { minute: 5, hour: 10 }, background: { minute: 3, hour: 6 } };
const windows = { minute: 1000, hour: 5000 };
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'winify-governor-'));

app.whenReady().then(async () => {
  console.log('1. The caps chosen');
  check('everything 30/min, 300/h; things you do 24/min, 240/h; background 10/min, 150/h',
    JSON.stringify(CAPS) === JSON.stringify({ hard: { minute: 30, hour: 300 }, user: { minute: 24, hour: 240 }, background: { minute: 10, hour: 150 } }), JSON.stringify(CAPS));

  console.log('2. Background work only uses what is left; playback first in line');
  let dir = fresh();
  let g = create({ dir, copy: 'dev', caps, windows });
  const got = [];
  for (let i = 0; i < 5; i++) g.admit('/playlists/p' + i + '/items', 'background').then((r) => got.push(['bg', r.ok, Date.now()]));
  await wait(100);
  check('5 background requests at once: 3 go now (its cap per "minute"), 2 wait', got.length === 3, JSON.stringify(got.map((x) => x[0])));
  const t0 = Date.now();
  const play = await g.admit('/me/player/play', undefined);
  check('a playback request meanwhile: let through at once, ahead of the waiting background ones', play.ok && Date.now() - t0 < 100 && got.length === 3, (Date.now() - t0) + ' ms');
  await wait(1300);
  check('...the waiting ones go once the "minute" has room', got.length === 5, got.length);

  console.log('3. Things you do: never left waiting long; refused with "until when" instead');
  dir = fresh();
  g = create({ dir, copy: 'dev', caps, windows: { minute: 1000, hour: 60000 }, userWaitMax: 500 });
  for (let i = 0; i < 10; i++) await g.admit('/me/player', undefined).then(() => wait(120));   // 10 in the "hour": the user cap
  const r = await g.admit('/search?q=x', undefined);
  check('over its hourly cap: refused at once, by Winify, saying until when', !r.ok && r.reason === 'winify' && r.until > Date.now() + 30000, JSON.stringify(r));
  const p2 = await g.admit('/me/player/next', undefined);
  check('...while playback still goes (up to the hard cap)', p2.ok);

  console.log('4. Both copies count together');
  dir = fresh();
  // Background: 3 per "hour" (3 s) between them.
  const shared = { hard: caps.hard, user: caps.user, background: { minute: 3, hour: 3 } };
  const w4 = { minute: 1000, hour: 3000 };
  const dev = create({ dir, copy: 'dev', caps: shared, windows: w4 });
  for (let i = 0; i < 3; i++) await dev.admit('/playlists/a/items', 'background');
  await wait(1200);                                     // written to the shared folder
  const packaged = create({ dir, copy: 'packaged', caps: shared, windows: w4 });
  const st = packaged.state();
  let bgGone = false;
  packaged.admit('/playlists/b/items', 'background').then(() => { bgGone = true; });
  await wait(300);
  check('the packaged app counts the development copy\'s 3 requests, so its own background one waits (the shared cap is used up)', st.hour === 3 && !bgGone, JSON.stringify(st));
  await wait(2200);
  check('...and goes once the shared "hour" has room', bgGone);

  console.log('4b. A queued background request someone now waits for moves up');
  dir = fresh();
  g = create({ dir, copy: 'dev', caps, windows: { minute: 3000, hour: 60000 } });
  for (let i = 0; i < 3; i++) await g.admit('/playlists/x/items', 'background');   // the background "minute" used up
  let listed = false;
  g.admit('/me/playlists?limit=50&offset=0', 'background').then(() => { listed = true; });
  await wait(150);
  const waitingBefore = !listed;
  g.promote(['/me/playlists']);
  await wait(150);
  check('the picker\'s list read waits as background; promoted, it goes at once (there is room for things you do)', waitingBefore && listed);

  console.log('5. Spotify said to wait: both copies, also after a restart');
  dir = fresh();
  const a = create({ dir, copy: 'dev', caps, windows });
  a.blocked('/me/playlists?limit=50&offset=0', 40966);
  const b = create({ dir, copy: 'packaged', caps, windows });
  const rb = await b.admit('/me/playlists?limit=50&offset=50', 'background');
  check('the other copy is not let through to that endpoint, and is told until when (about 11 h 23 min)', !rb.ok && rb.reason === 'spotify' && Math.abs(rb.until - Date.now() - 40966e3) < 5000, JSON.stringify(rb));
  const again = create({ dir, copy: 'dev', caps, windows });
  check('...a restarted copy too', !(await again.admit('/me/playlists', undefined)).ok);
  check('...other endpoints are not held back', (await again.admit('/me/player', undefined)).ok);

  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
});
