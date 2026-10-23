// How often Winify asks Spotify for playback state (GET /me/player), per situation.
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 420000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d != null ? '   ' + String(d).slice(0, 300) : '')); };
  const calls = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))'));
  const polls = (cs) => cs.filter((c) => c[0] === 'net:player' && c[1] === 'GET' && c[2] === '/me/player').length;
  const all = (cs) => cs.filter((c) => c[0] === 'net:player' || /^api:/.test(c[0])).length;
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))'); await h.wait(4000);

  console.log('1. Winify playing');
  await calls(); await h.wait(90000);
  let cs = await calls();
  check('90 s: no state requests at all (was 30 at every 3 s)', polls(cs) === 0, polls(cs));
  check('...and nothing else either while one track plays', all(cs) === 0, JSON.stringify(cs.filter((c) => c[0] === 'net:player' || /^api:/.test(c[0]))));

  console.log('2. Another device takes over');
  await js('mock.active = "phone"'); await h.wait(2500);
  cs = await calls();
  check('noticed at once: Winify\'s own player went quiet, one read finds where playback went', polls(cs) === 1 && (await js('WinifyControls.state().where')) === 'elsewhere', polls(cs) + ' ' + (await js('WinifyControls.state().where')));
  await h.wait(62000);
  cs = await calls();
  check('62 s with the phone playing: 2 state requests (every 30 s; was 21)', polls(cs) === 2, polls(cs));

  console.log('3. Window hidden');
  await js('spotify.setVisibleForTest(false)'); await h.wait(31000); await calls();
  await h.wait(65000);
  cs = await calls();
  check('65 s hidden: no state requests', polls(cs) === 0, polls(cs));
  await js('spotify.setVisibleForTest(true)'); await h.wait(1200);
  cs = await calls();
  check('shown again: one read at once', polls(cs) === 1, polls(cs));

  console.log('4. Nothing playing anywhere');
  await js('mock.active = "none"'); await js('WinifyControls.refresh()'); await h.wait(1500); await calls();
  await h.wait(61500);
  cs = await calls();
  check('61 s with nothing playing: 1 state request (every 60 s)', polls(cs) === 1, polls(cs));

  console.log('5. Back on Winify');
  await js('(mock.active = "winify", mock.setPaused(false))'); await js('WinifyControls.refresh()'); await h.wait(2000); await calls();
  await h.wait(40000);
  cs = await calls();
  check('playing on Winify again: polling stops', polls(cs) === 0, polls(cs));
  await js('mock.setContext("spotify:album:a1", 2)'); await h.wait(1600);
  cs = await calls();
  check('menu-bar status told of a track change without asking Spotify', cs.some((c) => c[0] === 'nowPlaying' && /Song 2002/.test(c[1])) && polls(cs) === 0, JSON.stringify(cs.filter((c) => c[0] === 'nowPlaying')));
  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
