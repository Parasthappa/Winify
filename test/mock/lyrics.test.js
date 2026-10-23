// The lyrics window: ways in, placement, lookups (get / search / instrumental / none / error), cache, track changes, memory.
const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0; setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 300000);
h.open().then(async ({ win, js }) => {
  const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); };
  const L = () => js('WinifyLyrics.state()');
  const untilL = async (fn, ms = 6000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await L(); if (fn(v)) return v; await h.wait(120); } return v; };
  const lrcCalls = async () => JSON.parse(await js('JSON.stringify(calls.splice(0))')).filter((c) => c[0] === 'lrclib');
  const key = async (k, mods, code) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods || [] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods || [] }); await h.wait(150); };
  const play = (i) => js(`mock.setContext("spotify:album:a1", ${i})`);
  const box = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const overlaps = (a, b) => a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  await h.wait(1500);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))'); await h.wait(2000);
  await js('calls.length = 0');

  console.log('1. The I button opens it; a popular song (found by /api/get)');
  check('closed to start with', !(await L()).open);
  await h.click(win, js, '#webamp #button-i'); 
  let s = await untilL((v) => v.open && /Line 60 of song two thousand/.test(v.text || ''));
  check('I button opens the lyrics window', s.open);
  check('title and artist at the top, then the full lyrics', /^Song 2000\s+Artist 2000\s+Line 1 of song two thousand/.test(s.text) && /Line 60/.test(s.text), (s.text || '').slice(0, 120));
  check('found by /api/get; synced lyrics kept for later', s.entry && s.entry.source === 'get' && /\[00:01\.00\]/.test(s.entry.synced || ''), JSON.stringify(s.entry && { source: s.entry.source, synced: !!s.entry.synced }));
  let calls = await lrcCalls();
  check('one lookup only (get), no search', calls.length === 1 && calls[0][1] === '/api/get', JSON.stringify(calls));
  const credit = await js(`[...document.querySelectorAll('.winify-lyrics .wl-bottom .character')].map(c => String.fromCharCode(+(c.className.match(/character-([0-9]+)/) || [0, 63])[1])).join('')`);
  check('credit "Lyrics from LRCLIB" in the window', credit === 'lyrics from lrclib', credit);
  const title = await js(`[...document.querySelectorAll('.winify-lyrics .wl-title .character')].map(c => String.fromCharCode(+(c.className.match(/character-([0-9]+)/) || [0, 63])[1])).join('')`);
  check('Winamp-styled: skin title plate, frame and font', title === 'lyrics' && await js(`getComputedStyle(document.querySelector('.winify-lyrics .playlist-top-left')).backgroundImage.startsWith('url(')`), title);
  const lw = await box('.winify-lyrics'); const mw = await box('#webamp #main-window');
  check('opens beside the player, not over the main window', !overlaps(lw, mw), JSON.stringify([lw, mw]));
  const scroll = await js(`(() => { const b = document.querySelector('.winify-lyrics .wl-body'); b.scrollTop = 200; return { over: b.scrollHeight > b.clientHeight, top: b.scrollTop, handle: getComputedStyle(document.querySelector('.winify-lyrics .wl-handle')).display }; })()`);
  check('long lyrics scroll, with the skin\'s scrollbar handle', scroll.over && scroll.top === 200 && scroll.handle !== 'none', JSON.stringify(scroll));

  console.log('2. Track changes while open');
  await play(1);
  s = await untilL((v) => /Song 2001/.test(v.text || '') && /Instrumental/.test(v.text || ''));
  check('instrumental: a quiet note in the window', /Instrumental — no lyrics/.test(s.text), s.text);
  await play(2);
  s = await untilL((v) => /Song 2002/.test(v.text || '') && /Obscure/.test(v.text || ''));
  calls = await lrcCalls();
  check('obscure song: /api/get finds nothing, /api/search does', /Obscure lyrics, found by search/.test(s.text) && calls.some((c) => c[1] === '/api/search' && c[2] === 'Song 2002'), JSON.stringify(calls.slice(-2)));
  check('...the right match: same artist, nearest length (not the wrong artist or length)', !/WRONG/.test(s.text) && s.entry.source === 'search', s.text);
  await play(3);
  s = await untilL((v) => /Song 2003/.test(v.text || '') && /No lyrics found/.test(v.text || ''));
  check('no lyrics anywhere: a quiet note', /No lyrics found for this track/.test(s.text), s.text);
  await js('LRC.fail.add("Song 2004")'); await play(4);
  s = await untilL((v) => /Song 2004/.test(v.text || '') && /reach LRCLIB/.test(v.text || ''));
  check('network error: a quiet note, click to retry', /Couldn’t reach LRCLIB\. Click to try again\./.test(s.text), s.text);
  await js('LRC.fail.delete("Song 2004")'); await h.click(win, js, '.winify-lyrics .wl-retry');
  s = await untilL((v) => /Back after a retry/.test(v.text || ''));
  check('...retry works once LRCLIB is back', /Back after a retry/.test(s.text), s.text);
  // LRCLIB busy (503) on the search: a retryable note, and nothing cached.
  await js('LRC.busy = true'); await play(6);
  s = await untilL((v) => /Song 2006/.test(v.text || '') && /busy/.test(v.text || ''));
  check('LRCLIB busy (503): "LRCLIB is busy. Click to try again." - not "no lyrics"', /LRCLIB is busy\. Click to try again\./.test(s.text) && !/No lyrics found/.test(s.text), s.text);
  check('...and not cached as "no lyrics"', !(await L()).cached.includes('spotify:track:2006'), JSON.stringify((await L()).cached));
  await js('LRC.busy = false'); await h.click(win, js, '.winify-lyrics .wl-retry');
  s = await untilL((v) => /Song 2006/.test(v.text || '') && /No lyrics found/.test(v.text || ''));
  check('...retry once it is free: a real answer', /No lyrics found/.test(s.text), s.text);
  // A slow lookup shows that it is looking.
  await js('LRC.delay = 1500'); await play(5);
  s = await untilL((v) => /Song 2005/.test(v.text || ''));
  check('while looking: "Looking up lyrics…"', /Looking up lyrics…/.test(s.text), s.text);
  await untilL((v) => /No lyrics found/.test(v.text || '')); await js('LRC.delay = 150');
  // Track changes from other sources: Autoplay.
  await js('mock.startAutoplay(true)');
  s = await untilL((v) => /Song 9000/.test(v.text || '') && /No lyrics found/.test(v.text || ''));
  check('follows Autoplay too', /Song 9000/.test(s.text), s.text.slice(0, 40));

  console.log('3. Cache');
  await lrcCalls(); await play(0);
  s = await untilL((v) => /Line 1 of song two thousand/.test(v.text || ''));
  await h.wait(500); calls = await lrcCalls();
  check('back to an earlier song: shown from the cache, no new lookup', /Line 60/.test(s.text) && calls.length === 0, JSON.stringify(calls));

  console.log('4. Other ways in, and closing');
  await h.click(win, js, '#webamp #button-i'); await h.wait(300);
  check('I button again closes it', !(await L()).open);
  await h.click(win, js, '#title-bar', 0.3, 0.5); await h.wait(150);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '3', modifiers: ['alt'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '3', modifiers: ['alt'] }); await h.wait(500);
  check('Option+3 opens it', (await L()).open);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '3', modifiers: ['alt'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '3', modifiers: ['alt'] }); await h.wait(400);
  check('Option+3 again closes it', !(await L()).open);
  await h.click(win, js, '#playlist-window', 0.5, 0.02); await h.wait(150);
  await js('loud.length = 0');
  await h.click(win, js, '#playlist-misc-menu'); await h.wait(500);
  check('LYRIC (MISC) button opens it in one click', (await L()).open);
  check('...no SORT LIST / FILE INF / MISC OPTS sub-menu, no alert', !(await js(`!!document.querySelector('#playlist-misc-menu ul, #playlist-misc-menu .sort-list')`)) && (await js('loud.length')) === 0, JSON.stringify(await js('loud')));
  await h.click(win, js, '#playlist-misc-menu'); await h.wait(400);
  check('LYRIC again closes it', !(await L()).open);
  check('tooltip "Lyrics" on the button', (await js(`document.querySelector('#playlist-misc-menu').title`)) === 'Lyrics');
  const art = await js(`({ css: document.getElementById('winify-lyric-button').textContent, bg: getComputedStyle(document.querySelector('#webamp #playlist-misc-menu')).backgroundImage.slice(0, 30) })`);
  check('default skin: the button is redrawn as LYRIC, with a pressed state', /data:image\/png/.test(art.bg) && /:active/.test(art.css), JSON.stringify(art).slice(0, 200));
  await h.click(win, js, '#playlist-misc-menu'); await h.wait(400);
  // The player is still usable while it is open (not modal).
  await js('calls.length = 0'); await h.click(win, js, '#webamp #pause'); await h.wait(500);
  check('player controls still work with the window open', JSON.parse(await js('JSON.stringify(calls)')).some((c) => c[0] === 'pause'), JSON.stringify(await js('calls')));
  await js('mock.setPaused(false)');

  console.log('4b. Leftover Webamp menu items are gone');
  // Main window right-click > Playback.
  const mainBox = await box('#webamp #main-window');
  win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(mainBox.x + 100), y: Math.round(mainBox.y + 60), button: 'right', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(mainBox.x + 100), y: Math.round(mainBox.y + 60), button: 'right', clickCount: 1 }); await h.wait(400);
  const items = await js(`[...document.querySelectorAll('#webamp-context-menu li')].filter(l => l.firstChild && l.firstChild.nodeType === 3).map(l => [l.firstChild.textContent.trim(), getComputedStyle(l).display !== 'none'])`);
  const visible = items.filter((x) => x[1]).map((x) => x[0]);
  check('Playback: "10 tracks back" / "10 tracks fwd" hidden; Back/Fwd 5 seconds and Previous..Next kept', !visible.includes('10 tracks back') && !visible.includes('10 tracks fwd') && visible.includes('Back 5 seconds') && visible.includes('Next'), JSON.stringify(visible));
  await key('Escape'); await h.click(win, js, '#playlist-window', 0.5, 0.02); await h.wait(200);
  // LIST OPTS: only load list.
  await h.click(win, js, '#playlist-list-menu'); await h.wait(300);
  const list = await js(`[...document.querySelectorAll('#playlist-list-menu li')].map(l => [l.firstElementChild && l.firstElementChild.className, getComputedStyle(l).display !== 'none'])`);
  check('LIST OPTS: only "load list" left (new list, save list hidden)', JSON.stringify(list.filter((x) => x[1]).map((x) => x[0])) === JSON.stringify(['load-list']), JSON.stringify(list));
  await h.click(win, js, '#playlist-window', 0.5, 0.02); await h.wait(200);
  // EQ > Presets: opens nothing.
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'TOGGLE_WINDOW', windowId: 'equalizer' })`); await h.wait(400);
  const eqOpen = await js(`!!document.querySelector('#webamp #presets-context')`);
  if (eqOpen) { await h.click(win, js, '#webamp #presets-context'); await h.wait(400); }
  const presetItems = await js(`[...document.querySelectorAll('#webamp-context-menu li')].map(l => l.textContent)`);
  check('EQ > Presets opens no menu (no Load / From Eqf... / Save)', eqOpen && !presetItems.some((t) => /From Eqf|Save|Load/.test(t)), JSON.stringify([eqOpen, presetItems]));
  await js(`WinifyWebamp.getInstance().store.dispatch({ type: 'TOGGLE_WINDOW', windowId: 'equalizer' })`); await h.wait(300);
  check('no downloads or file prompts from any of it', (await js('loud.filter(l => l[0] !== "alert").length')) === 0, JSON.stringify(await js('loud')));

  console.log('5. Dragging, and memory across launches');
  const before = await box('.winify-lyrics');
  const tb = await box('.winify-lyrics .wl-top');
  const sx = Math.round(tb.x + 60), sy = Math.round(tb.y + 8);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: sx, y: sy, button: 'left', clickCount: 1 });
  for (let k = 1; k <= 6; k++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: sx + k * 5, y: sy + k * 6, button: 'left', modifiers: ['leftButtonDown'] }); await h.wait(30); }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: sx + 30, y: sy + 36, button: 'left', clickCount: 1 }); await h.wait(300);
  const moved = await box('.winify-lyrics');
  check('dragged by its title bar', Math.abs(moved.x - before.x - 30) <= 16 && Math.abs(moved.y - before.y - 36) <= 16, JSON.stringify([before, moved]));
  const saved = JSON.parse(await js(`localStorage.getItem('winify.dialogs.v1')`)).lyrics;
  check('position remembered', saved && Math.abs(saved.x - moved.x) < 1 && Math.abs(saved.y - moved.y) < 1, JSON.stringify(saved));
  await js('location.reload()'); await h.wait(500);
  while (!(await js('window.mounted === true').catch(() => false))) await h.wait(100);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))');
  s = await untilL((v) => v.open && /Line 60/.test(v.text || ''), 9000);
  const after = await box('.winify-lyrics');
  check('relaunch: reopened, because it was left open', s.open, JSON.stringify(s).slice(0, 100));
  check('...at the remembered spot', after && Math.abs(after.x - moved.x) < 1 && Math.abs(after.y - moved.y) < 1, JSON.stringify([moved, after]));
  await h.click(win, js, '.winify-lyrics .wl-close'); await h.wait(300);
  await js('location.reload()'); await h.wait(500);
  while (!(await js('window.mounted === true').catch(() => false))) await h.wait(100);
  await js('(mock.active = "winify", mock.setContext("spotify:album:a1", 0), mock.setPaused(false))'); await h.wait(3000);
  check('closed with its close button: stays closed at the next launch', !(await L()).open);

  const loud = JSON.parse(await js('JSON.stringify(loud)')); const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no alerts or prompts', loud.length === 0, JSON.stringify(loud));
  check('no page errors', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
