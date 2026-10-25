// The main window's A button: always on top (main.js keeps and applies it; here, the page's side).
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 120000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); return ok; };
  const A = () => js(`(() => { const b = document.querySelector('#webamp #main-window #button-a'); return b && { title: b.title, on: b.classList.contains('selected'), pressed: b.getAttribute('aria-pressed') }; })()`);
  const sent = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))')).filter((c) => c[0] === 'setWindowLevel').map((c) => c[1]);
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))'); await h.wait(800);
  // As main.js does once the page is there: the remembered level (here: normal).
  await js(`(mock.levelListeners || []).forEach((fn) => fn('normal'))`); await h.wait(200);

  console.log('1. The A button');
  let a = await A();
  check('tooltip "Always on top"; not lit while off', a.title === 'Always on top' && !a.on && a.pressed === 'false', JSON.stringify(a));
  await sent();
  await h.click(win, js, '#button-a'); await h.wait(300);
  a = await A();
  check('click: asks main for "top", and lights up (the skin\'s pressed look)', JSON.stringify(await sent()) === '["top"]' && a.on && a.pressed === 'true', JSON.stringify(a));
  await h.click(win, js, '#button-a'); await h.wait(300);
  a = await A();
  check('click again: "normal", not lit', JSON.stringify(await sent()) === '["normal"]' && !a.on, JSON.stringify(a));

  console.log('2. As main says');
  await js(`(mock.levelListeners || []).forEach((fn) => fn('top'))`); await h.wait(200);
  check('main says "top" (remembered from last time): lit', (await A()).on);
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'TOGGLE_WINDOW_SHADE_MODE', windowId: 'main' })`); await h.wait(300);
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'TOGGLE_WINDOW_SHADE_MODE', windowId: 'main' })`); await h.wait(400);
  a = await A();
  check('after windowshade and back (Webamp redraws it): still lit, same tooltip', a.on && a.title === 'Always on top', JSON.stringify(a));
  await js(`(mock.levelListeners || []).forEach((fn) => fn('normal'))`); await h.wait(200);
  check('main says "normal": not lit', !(await A()).on);

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
