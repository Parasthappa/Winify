const { app } = require('electron'); const h = require('../lib/harness');
let fails = 0;
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 240000);
h.open().then(async ({ win, js }) => {
  const S = () => js(`(() => { const s = WinifyWebamp.getInstance().store.getState(); const t = s.tracks[s.playlist.currentTrack] || {};
    return { status: s.media.status, shuffle: s.media.shuffle, repeat: s.media.repeat, volume: s.media.volume, balance: s.media.balance,
      name: t.artist && t.title ? t.artist + ' - ' + t.title : t.defaultName, duration: t.duration, elapsed: Math.round(s.media.timeElapsed),
      order: s.playlist.trackOrder.join(','), bands: Object.values(s.equalizer.sliders).join(','), msg: s.userInput.userMessage }; })()`);
  const calls = () => js('JSON.stringify(calls)');
  const take = async () => { const c = await js('JSON.stringify(calls.splice(0))'); return JSON.parse(c).filter((x) => x[0] !== 'api:queue'); };
  const m = (code) => js('(' + code + ')');
  const check = (label, ok, detail) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + label + (detail ? '   ' + detail : '')); };
  const has = (cs, name) => cs.some((c) => c[0] === name);
  const c = (sel, fx, fy, b) => h.click(win, js, sel, fx, fy, b);
  await h.wait(1500);


  const layout = () => js(`(() => { const r = (s) => document.querySelector(s).getBoundingClientRect();
    const ws = ['#main-window', '#equalizer-window', '#playlist-window'].filter((sel) => document.querySelector(sel)).map(r);
    const overlap = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const b = r('#play'); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return { doubled: WinifyWebamp.isDoubled(), overlaps: ws.some((a, i) => ws.some((b, j) => j > i && overlap(a, b))), playHit: hit && hit.id, mainH: Math.round(ws[0].height) }; })()`);
  console.log('0. Layout'); let L = await layout();
  check('startup: 1x, no window overlaps, Play is clickable', !L.doubled && !L.overlaps && L.playHit === 'play', JSON.stringify(L));
  await js('WinifyWebamp.toggleDoubleSize()'); await h.wait(300); L = await layout();
  check('menu toggle -> 2x, no overlaps', L.doubled && !L.overlaps && L.playHit === 'play', JSON.stringify(L));
  await js('WinifyWebamp.toggleDoubleSize()'); await h.wait(300); L = await layout();
  check('menu toggle -> 1x again, no overlaps', !L.doubled && !L.overlaps && L.playHit === 'play', JSON.stringify(L));

  console.log('A. idle'); let s = await S();
  check('idle shows stopped + stand-in name', s.status === 'STOPPED' && /press Play/.test(s.name), JSON.stringify(s));

  console.log('B. Play on empty player, session resumable'); await take();
  await c('#play'); await h.wait(2500); let cs = await take(); s = await S();
  check('transferPlayback(winify-dev, true)', cs.some((x) => x[0] === 'transferPlayback' && x[1] === 'winify-dev' && x[2] === true), JSON.stringify(cs));
  check('no Liked Songs fallback needed', !has(cs, 'api:play'));
  check('display: PLAYING, title, total time', s.status === 'PLAYING' && s.name === 'Artist 1 - Song 1' && s.duration === 200, JSON.stringify(s));

  console.log('C. Pause / Play'); await c('#pause'); await h.wait(300); cs = await take(); s = await S();
  check('Pause -> WinifyPlayer.pause, shows PAUSED', has(cs, 'pause') && s.status === 'PAUSED', JSON.stringify([cs, s.status]));
  await h.wait(3500); s = await S(); check('still PAUSED after polls', s.status === 'PAUSED', s.status);
  await c('#play'); await h.wait(300); cs = await take(); s = await S();
  check('Play -> WinifyPlayer.play (resume, no transfer)', has(cs, 'play') && !has(cs, 'transferPlayback') && s.status === 'PLAYING', JSON.stringify([cs, s.status]));

  console.log('D. Stop'); await c('#stop'); await h.wait(300); cs = await take(); s = await S();
  check('Stop -> WinifyPlayer.pause, shows STOPPED', has(cs, 'pause') && s.status === 'STOPPED', JSON.stringify([cs, s.status]));
  await h.wait(3500); s = await S(); check('still STOPPED after polls (not PAUSED)', s.status === 'STOPPED', s.status);
  await c('#play'); await h.wait(500); cs = await take(); s = await S();
  check('Play after Stop resumes', has(cs, 'play') && s.status === 'PLAYING', JSON.stringify([cs, s.status]));

  console.log('E. Next / Previous'); await c('#next'); await h.wait(1500); cs = await take(); s = await S();
  check('main Next -> nextTrack, title follows', cs.filter((x) => x[0] === 'nextTrack').length === 1 && s.name === 'Artist 2 - Song 2', JSON.stringify([cs, s.name]));
  check('Webamp did not stop or empty the playlist', s.status === 'PLAYING' && s.order.length > 0 && s.name === 'Artist 2 - Song 2', JSON.stringify(s));
  await c('#previous'); await h.wait(1500); cs = await take(); s = await S();
  check('main Previous -> previousTrack', cs.filter((x) => x[0] === 'previousTrack').length === 1 && s.name === 'Artist 1 - Song 1', JSON.stringify([cs, s.name]));
  // Webamp: the first click on an unfocused window only focuses it (stock behaviour), so focus it first.
  await c('#playlist-window', 0.5, 0.05); await h.wait(200);
  await c('.playlist-next-button'); await h.wait(1500); cs = await take(); s = await S();
  check('playlist-window Next -> nextTrack', has(cs, 'nextTrack') && s.name === 'Artist 2 - Song 2', JSON.stringify([cs, s.name]));
  await c('.playlist-previous-button'); await h.wait(1500); cs = await take();
  check('playlist-window Previous -> previousTrack', has(cs, 'previousTrack'), JSON.stringify(cs));
  // Right-click menu: open it with a real right-click, then click its "Next" entry.
  await c('#title-bar', 0.3, 0.5, 'right'); await h.wait(300);
  // Hover the submenu parent that holds "Next", as a user would, then click "Next".
  const hover = await js(`(() => { const parent = [...document.querySelectorAll('#webamp-context-menu li.parent')].find(p => [...p.querySelectorAll(':scope > ul > li')].some(l => l.firstChild && l.firstChild.textContent === 'Next'));
    if (!parent) return null; const b = parent.getBoundingClientRect(); return { x: Math.round(b.left + 20), y: Math.round(b.top + b.height / 2) }; })()`);
  if (!hover) check('right-click Playback submenu found', false);
  else {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: hover.x, y: hover.y }); await h.wait(400);
    await js(`[...document.querySelectorAll('#webamp-context-menu li')].find(l => l.firstChild && l.firstChild.textContent === 'Next').setAttribute('data-t', 'next')`);
    const vis = await js(`(() => { const b = document.querySelector('#webamp-context-menu li[data-t="next"]').getBoundingClientRect(); return b.width > 0 && b.height > 0; })()`);
    check('Playback submenu opens on hover', vis);
    await c('#webamp-context-menu li[data-t="next"]'); await h.wait(1200); cs = await take();
    check('right-click Playback > Next -> nextTrack', has(cs, 'nextTrack'), JSON.stringify(cs));
  }

  console.log('F. Seek'); await take(); await c('#position', 0.5, 0.5); await h.wait(500); cs = await take(); s = await S();
  const sk = cs.find((x) => x[0] === 'seek');
  check('seek bar mid -> seek ~100s', sk && Math.abs(sk[1] - 100000) < 15000, JSON.stringify(cs));
  check('elapsed follows seek', Math.abs(s.elapsed - 100) < 16, 'elapsed=' + s.elapsed);
  await h.wait(2500); s = await S(); check('seek bar did not snap back', s.elapsed >= 100 && s.elapsed < 120, 'elapsed=' + s.elapsed);

  console.log('G. Volume'); await c('#volume input', 0.25, 0.5); await h.wait(400); cs = await take(); s = await S();
  const vol = cs.filter((x) => x[0] === 'setVolume').pop();
  check('volume slider -> setVolume(store volume / 100)', vol && Math.abs(vol[1] * 100 - s.volume) < 1, JSON.stringify([cs, s.volume]));
  await h.wait(3500); const s2 = await S(); check('volume held after poll', s2.volume === s.volume, s.volume + ' -> ' + s2.volume);

  console.log('H. Shuffle / Repeat'); await c('#shuffle'); await h.wait(500); cs = await take(); s = await S();
  check('Shuffle -> PUT shuffle=true on winify-dev, lit', cs.some((x) => x[0] === 'api:shuffle' && x[1] === 'true' && x[2] === 'winify-dev') && s.shuffle, JSON.stringify([cs, s.shuffle]));
  await c('#shuffle'); await h.wait(500); cs = await take(); s = await S();
  check('Shuffle again -> false, unlit', cs.some((x) => x[0] === 'api:shuffle' && x[1] === 'false') && !s.shuffle, JSON.stringify(cs));
  await c('#repeat'); await h.wait(500); cs = await take(); s = await S();
  check('Repeat -> PUT repeat=context, lit', cs.some((x) => x[0] === 'api:repeat' && x[1] === 'context') && s.repeat, JSON.stringify(cs));
  await c('#repeat'); await h.wait(500); cs = await take(); s = await S();
  check('Repeat again -> off, unlit', cs.some((x) => x[0] === 'api:repeat' && x[1] === 'off') && !s.repeat, JSON.stringify(cs));
  await m('mock.failShuffle = true'); await c('#shuffle'); await h.wait(800); s = await S();
  check('Shuffle rejected by Spotify -> reverts to unlit', !s.shuffle, String(s.shuffle)); await m('mock.failShuffle = false'); await take();

  console.log('I. Changes made elsewhere while Winify plays'); await h.wait(1600);
  await m('mock.setPaused(true)'); await h.wait(1600); s = await S(); check('paused from phone -> PAUSED', s.status === 'PAUSED', s.status);
  await m('mock.setPaused(false)'); await h.wait(1600); s = await S(); check('resumed from phone -> PLAYING', s.status === 'PLAYING', s.status);
  await m('(mock.track = 7, mock.position = 0, mock.at = Date.now())'); await h.wait(1600); s = await S(); check('skipped from phone -> title follows', s.name === 'Artist 7 - Song 7', s.name);
  await m('(mock.position = 150000, mock.at = Date.now())'); await h.wait(1600); s = await S(); check('seeked from phone -> time follows', Math.abs(s.elapsed - 151) < 4, 'elapsed=' + s.elapsed);
  await m('(mock.shuffle = true, mock.repeat = "track")'); await h.wait(1600); s = await S(); check('shuffle on + repeat track from app -> both lit', s.shuffle && s.repeat, JSON.stringify(s));
  await m('mock.volume = 30'); await h.wait(3600); s = await S(); check('volume changed from app -> slider 30', s.volume === 30, String(s.volume));
  await c('#repeat'); await h.wait(500); cs = await take(); check('repeat lit from "track" mode -> click turns off', cs.some((x) => x[0] === 'api:repeat' && x[1] === 'off'), JSON.stringify(cs));
  await m('(mock.shuffle = false, mock.repeat = "off")');

  console.log('J. Playback moved to another device'); await m('(mock.active = "phone", mock.track = 9, mock.setPaused(false))');
  await h.wait(4000); s = await S(); check('display mirrors phone: Song 9 PLAYING', s.name === 'Artist 9 - Song 9' && s.status === 'PLAYING', JSON.stringify(s));
  await take(); await c('#pause'); await h.wait(300); await c('#next'); await h.wait(300); cs = await take();
  check('Pause/Next do not touch the phone or Winify', !has(cs, 'pause') && !has(cs, 'nextTrack'), JSON.stringify(cs));
  await h.wait(1000); s = await S(); check('display restored to PLAYING after refused Pause', s.status === 'PLAYING', s.status);
  await c('#play'); await h.wait(2500); cs = await take(); s = await S();
  check('Play brings it to Winify (transfer)', has(cs, 'transferPlayback') && s.status === 'PLAYING', JSON.stringify(cs));

  console.log('K. Play with nothing to resume -> Liked Songs'); await m('(mock.active = "none", mock.resumable = false)'); await h.wait(4500);
  s = await S(); check('no session -> STOPPED, idle name', s.status === 'STOPPED' && /press Play/.test(s.name), JSON.stringify(s)); await take();
  await c('#play'); await h.wait(6000); cs = await take(); s = await S();
  const lp = cs.find((x) => x[0] === 'api:play');
  check('transfer tried first, then PUT play collection on winify-dev', has(cs, 'transferPlayback') && lp && lp[1] === 'winify-dev' && /spotify:user:user1:collection/.test(lp[2]), JSON.stringify(cs));
  check('Liked Songs playing', s.status === 'PLAYING' && s.name === 'Artist 4000 - Song 4000', JSON.stringify(s));
  await m('(mock.active = "none", mock.libraryForbidden = true)'); await h.wait(4500); await take();
  await c('#play'); await h.wait(6000); s = await S();
  check('Liked Songs refused -> stopped cleanly, no exception', s.status === 'STOPPED', JSON.stringify(s));
  await m('(mock.libraryForbidden = false, mock.resumable = true)');

  console.log('L. Inert controls'); await js(`(() => { const st = WinifyWebamp.getInstance().store; if (!st.getState().windows.genWindows.equalizer.open) st.dispatch({ type: 'TOGGLE_WINDOW', windowId: 'equalizer' }); })()`); await h.wait(400); const before = await S(); await take();
  await c('#balance', 0.95, 0.5); await h.wait(300); s = await S(); check('Balance: stays centred', s.balance === 0 && before.balance === 0, String(s.balance));
  await c('#band-60', 0.5, 0.1); await c('#preamp', 0.5, 0.9); await h.wait(300); s = await S(); check('EQ + preamp sliders: unchanged', s.bands === before.bands, before.bands + ' -> ' + s.bands);
  await js('window.__fileInputs = 0; const rc = HTMLInputElement.prototype.click; document.addEventListener("change", () => {}, true);');
  await c('#eject'); await h.wait(600);
  const opened = await js('WinifyPicker.isOpen()'); await js('WinifyPicker.close()');
  s = await S(); cs = await take();
  check('Eject: opens the playlist picker; no playback calls, playlist unchanged', opened && !cs.some((x) => /^(play|pause|nextTrack|previousTrack|seek|setVolume|transferPlayback|api:play)$/.test(x[0])) && s.order === before.order, JSON.stringify(cs.map((x) => x[0])));

  const errs = JSON.parse(await js('JSON.stringify(errors)'));
  check('no page errors or exceptions in the whole run', errs.length === 0, JSON.stringify(errs));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.message); app.exit(3); });
