const { app } = require('electron'); const h = require('../lib/harness'); const fs = require('fs'), path = require('path');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 240000);
h.open().then(async ({ win, js }) => {
  const check = (label, ok, detail) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + String(detail).slice(0, 280) : '')); };
  const take = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))'));
  const c = (sel, fx, fy, b) => h.click(win, js, sel, fx, fy, b);
  const P = () => js('WinifyPicker.state()');
  const key = async (k) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); await h.wait(80); };
  const type = async (text) => { for (const ch of text) { win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); await h.wait(30); } await h.wait(150); };
  const ctx = () => js('WinifyControls.state().contextUri');
  const plays = (cs) => cs.filter((x) => x[0] === 'api:play').map((x) => JSON.parse(x[2]));
  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))'); await h.wait(2500);

  console.log('1. Eject opens the picker with every playlist');
  await take(); await c('#eject'); await h.wait(1500);
  let p = await P(); let cs = await take();
  const pages = cs.filter((x) => x[0] === 'api:myPlaylists');
  check('Eject (main window) opens it', p.open, JSON.stringify(p));
  // 137 playlists: 46 followed from someone else, 5 of which are collaborative.
  check('all 3 pages read; only yours + collaborative listed: 96 + Liked Songs', p.rows === 97 && pages.length === 3 && pages.every((x) => x[2] === '50'), JSON.stringify([p.rows, pages.map((x) => x[1])]));
  const names = await js(`(async () => { const all = []; const list = document.querySelector('.winify-picker .wp-list');
    for (let i = 0; i < 40; i++) { all.push(...[...list.querySelectorAll('.wp-row')].map(r => r.textContent)); list.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true })); }
    return [...new Set(all)]; })()`);
  check('Liked Songs pinned first, then your playlists with counts', names[0] === '1. Liked Songs1234' && names[1] === '2. Mix 010' && names[2] === '3. Mix 212', JSON.stringify(names.slice(0, 3)));
  // Followed, not collaborative: i % 3 === 1 and i % 10 !== 0. Rows read "N. <name><count>", count = 10 + i.
  const followed = Array.from({ length: 137 }, (_, i) => i).filter((i) => i % 3 === 1 && i % 10 !== 0);
  const leaked = followed.filter((i) => names.some((n) => n.replace(/^\d+\. /, '') === 'Mix ' + i + (10 + i)));
  check('all ' + followed.length + ' followed playlists excluded', leaked.length === 0 && names.length >= 97, JSON.stringify({ leaked, seen: names.length }));
  check('collaborative one you contribute to included (Mix 10, owned by someone else)', names.some((n) => /^\d+\. Mix 1020$/.test(n)), JSON.stringify(names.filter((n) => / Mix 10/.test(n))));
  check('no dimmed rows', !(await js(`!!document.querySelector('.winify-picker .wp-partial')`)));
  check('unnamed playlist shown as "Untitled playlist"', names.some((n) => /^\d+\. Untitled playlist15$/.test(n)), JSON.stringify(names.filter((n) => /Untitled|^\d+\. 15$/.test(n))));
  await js(`(() => { const list = document.querySelector('.winify-picker .wp-list'); for (let i = 0; i < 10; i++) list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true })); })()`);
  const counter = () => js(`(() => { try { return [...document.querySelectorAll('.winify-picker .wp-bottom .character')].map(c => String.fromCharCode(Number((c.className.match(/character-([0-9]+)/) || [0, 63])[1]))).join(''); } catch (e) { return 'ERR ' + e.message; } })()`);
  check('bottom count reflects the filtered list: 97/97', (await counter()) === '97/97', await counter());
  const skin = await js(`(() => { const g = (s) => getComputedStyle(document.querySelector('.winify-picker ' + s)).backgroundImage.slice(0, 20); return [g('.playlist-top-left'), g('.playlist-middle-left'), g('.playlist-bottom'), g('.character')]; })()`);
  check('drawn with the skin\'s own bitmaps (frame + marquee font)', skin.every((x) => /url/.test(x)), JSON.stringify(skin));
  const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(__dirname, '..', '.output', 'picker.png'), img.toPNG());

  console.log('2. Filter + keyboard');
  await type('road'); p = await P();
  check('typing "road" filters to 2', p.shown === 2, JSON.stringify(p));
  check('bottom count follows the filter box: 2/97', (await counter()) === '2/97', await counter());
  await key('Down'); await take(); await key('Return'); await h.wait(900); cs = await take(); p = await P();
  let pl = plays(cs);
  check('Down + Enter plays the 2nd match from track 1, on Winify, and closes', !p.open && pl.length === 1 && pl[0].context_uri === 'spotify:playlist:pl77' && pl[0].offset.position === 0 && cs.find((x) => x[0] === 'api:play')[1] === 'winify-dev', JSON.stringify(cs));
  const t0 = Date.now(); let pls; do { pls = await js('WinifyPlaylist.state()'); await h.wait(150); } while ((pls.listContext !== 'spotify:playlist:pl77' || pls.count !== 31) && Date.now() - t0 < 6000);
  check('playlist window loads it, track 1 highlighted', pls.listContext === 'spotify:playlist:pl77' && pls.count === 31 && pls.currentIndex === 1 && /PLAYLIST|Playlist pl77/.test(pls.header), JSON.stringify(pls));

  console.log('3. Escape and click-away change nothing');
  const before = await ctx(); await take();
  // Stock Webamp: the first click on an unfocused window only brings it forward.
  await c('#playlist-window', 0.5, 0.03); await h.wait(200);
  await c('.playlist-eject-button'); await h.wait(800); p = await P();
  check('playlist window Eject opens it too', p.open);
  await key('Escape'); await h.wait(200); p = await P(); cs = await take();
  check('Escape closes, no change', !p.open && !plays(cs).length && (await ctx()) === before, JSON.stringify(cs.map((x) => x[0])));
  await c('#playlist-list-menu'); await h.wait(200); await c('#playlist-list-menu .load-list'); await h.wait(800); p = await P();
  check('LIST OPTS > load list opens it (no alert)', p.open && !(await js('loud.some(l => l[0] === "alert")')), JSON.stringify(await js('loud')));
  // Click a playback control that lies outside the picker (the backdrop covers it).
  const target = await js(`(() => { const pk = document.querySelector('.winify-picker').getBoundingClientRect();
    for (const sel of ['#play', '#next', '#previous', '.playlist-play-button', '#position']) { const b = document.querySelector(sel).getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2;
      if (x < pk.left || x > pk.right || y < pk.top || y > pk.bottom) return sel; } return null; })()`);
  if (!target) throw new Error('every playback control is under the picker');
  await c(target, 0.5, 0.5); await h.wait(500); p = await P(); cs = await take();
  check('clicking away closes it; the click does not reach the control underneath (' + target + ')', !p.open && !cs.some((x) => /^(play|api:play|transferPlayback)$/.test(x[0])) && (await ctx()) === before, JSON.stringify(cs.map((x) => x[0])));
  await c('#title-bar', 0.3, 0.5); await h.wait(200);
  await c('#title-bar', 0.3, 0.5, 'right'); await h.wait(300);
  const hover = await js(`(() => { const parent = [...document.querySelectorAll('#webamp-context-menu li.parent')].find(p => [...p.querySelectorAll(':scope > ul > li')].some(l => l.firstChild && l.firstChild.textContent === 'File...')); const b = parent.getBoundingClientRect(); return { x: Math.round(b.left + 20), y: Math.round(b.top + b.height / 2) }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: hover.x, y: hover.y }); await h.wait(400);
  await js(`[...document.querySelectorAll('#webamp-context-menu li')].find(l => l.firstChild && l.firstChild.nodeType === 3 && l.firstChild.textContent === 'File...').setAttribute('data-t', 'file')`);
  await c('#webamp-context-menu li[data-t="file"]'); await h.wait(800); p = await P();
  check('right-click Play > File... opens it', p.open);

  console.log('4. Mouse picking and Liked Songs');
  await type('liked'); await take();
  const row = await js(`(() => { const r = document.querySelectorAll('.winify-picker .wp-row')[0].getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + 6) }; })()`);
  for (const clickCount of [1, 2]) { win.webContents.sendInputEvent({ type: 'mouseDown', x: row.x, y: row.y, button: 'left', clickCount }); win.webContents.sendInputEvent({ type: 'mouseUp', x: row.x, y: row.y, button: 'left', clickCount }); await h.wait(40); }
  await h.wait(900); cs = await take(); pl = plays(cs); p = await P();
  check('double-click Liked Songs plays the collection from track 1', !p.open && pl.length === 1 && pl[0].context_uri === 'spotify:user:user1:collection' && pl[0].offset.position === 0, JSON.stringify(pl));
  await c('#eject'); await h.wait(800);
  const r2 = await js(`(() => { const r = document.querySelectorAll('.winify-picker .wp-row')[4].getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + 6) }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: r2.x, y: r2.y, button: 'left', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', x: r2.x, y: r2.y, button: 'left', clickCount: 1 }); await h.wait(200);
  p = await P(); cs = await take();
  check('single click only selects', p.open && p.selected === 4 && !plays(cs).length, JSON.stringify(p));
  await js('WinifyPicker.close()');

  console.log('5. L opens it, like classic Winamp\'s load');
  // Real key presses (keyDown + char), so an L typed into a box reaches the key handlers too.
  const typeKeys = async (t) => { for (const ch of t) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch }); win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch }); await h.wait(40); } };
  await c('#title-bar', 0.3, 0.5); await h.wait(200); await take();
  await key('L'); await h.wait(600);
  p = await P();
  check('L opens the playlist picker', p.open && p.rows === 97, JSON.stringify(p));
  await typeKeys('roll'); await h.wait(200);
  check('typing L into its filter does not reopen or close it', (await P()).open && (await js(`document.querySelector('.winify-picker input').value`)) === 'roll', await js(`document.querySelector('.winify-picker input').value`));
  await key('Escape'); await h.wait(300);
  check('Escape closes it', !(await P()).open);
  await c('#title-bar', 0.3, 0.5); await h.wait(200);
  await key('J'); await h.wait(500);
  await typeKeys('LL'); await h.wait(300);
  check('L typed in Jump to track stays in its search box, picker stays closed', !(await P()).open && (await js(`document.querySelector('.winify-search .ws-query').value`)) === 'LL', await js(`document.querySelector('.winify-search .ws-query').value`));
  await key('Escape'); await h.wait(200);
  await c('#playlist-window', 0.5, 0.02); await h.wait(200);
  await key('L'); await h.wait(600);
  check('L works with the playlist window focused too', (await P()).open);
  await key('Escape'); await h.wait(200);

  const loud = JSON.parse(await js('JSON.stringify(loud)')); const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no alerts, downloads, file prompts or new windows', loud.length === 0, JSON.stringify(loud));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
