const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 180000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + d : '')); };
  const c = (sel, fx = 0.5, fy = 0.5) => h.click(win, js, sel, fx, fy);
  const away = async () => { win.webContents.sendInputEvent({ type: 'mouseDown', x: 5, y: 5, button: 'left', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', x: 5, y: 5, button: 'left', clickCount: 1 }); await h.wait(200); };
  const alerts = () => js('loud.filter(l => l[0] === "alert").map(l => l[1])');
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:playlist:big", 0), mock.setPaused(false))'); await h.wait(2500);
  // Positive control: an alert Winify does not expect must still reach the (recording) dialog.
  await js('loud.length = 0; window.alert("control")');
  check('detector works: an unexpected alert is recorded', JSON.stringify(await alerts()) === '["control"]');
  await js('loud.length = 0');
  const menus = {
    '#playlist-selection-menu': ['.invert-selection', '.select-zero', '.select-all'],
    '#playlist-list-menu': ['.load-list'],
  };
  for (const [menu, items] of Object.entries(menus)) {
    for (const item of items) {
      await c('#playlist-window', 0.5, 0.02); await h.wait(150);
      await c(menu); await h.wait(250);
      await js('loud.length = 0');
      await c(menu + ' ' + item); await h.wait(500);
      const a = await alerts();
      check(`${menu.replace('#playlist-', '').replace('-menu', '').toUpperCase()} > ${item.slice(1)}: no dialog`, a.length === 0, JSON.stringify(a));
      await js('WinifyPicker.close()'); await away();
    }
  }
  // REM no longer opens a sub-menu: it skips the selection at once.
  await c('#playlist-window', 0.5, 0.02); await h.wait(150); await js('loud.length = 0');
  await c('#playlist-remove-menu'); await h.wait(400);
  check('REM: no sub-menu, no dialog', !(await js(`!!document.querySelector('#playlist-remove-menu ul')`)) && (await alerts()).length === 0);
  await away();
  // ADD now opens Jump to track instead of Webamp's URL/DIR/FILE menu.
  await c('#playlist-window', 0.5, 0.02); await h.wait(150); await js('loud.length = 0');
  await c('#playlist-add-menu'); await h.wait(500);
  check('ADD: opens Jump to track, no dialog', (await js('WinifySearch.state().title')) === 'Jump to track' && (await js('WinifySearch.isOpen()')) && (await alerts()).length === 0);
  await js('WinifySearch.close()'); await away();
  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
