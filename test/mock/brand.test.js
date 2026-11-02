// Winify's name everywhere you can see one: Webamp's text and default-skin art as served (webamp-brand.js), Winify's own
// strings, the README outside its credits and disclaimer. Other skins keep their own art.
const { app } = require('electron'); const h = require('../lib/harness');
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { brand, ART, TEXT } = require(path.join(ROOT, 'webamp-brand.js'));
let fails = 0; const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 320) : '')); };
setTimeout(() => { console.log('WATCHDOG'); app.exit(2); }, 120000);
const NAME = /winamp|webamp|nullsoft/i;
h.open().then(async ({ win, js }) => {
  console.log('1. The bundle as served');
  const original = fs.readFileSync(path.join(ROOT, 'node_modules/webamp/built/webamp.bundle.min.mjs'), 'utf8');
  const { bundle, missing } = brand(original);
  check('every text and picture was found in this Webamp', missing.length === 0, missing.join(' | '));
  check('the hidden slogan title is just the plain title', ART['.llama #title-bar'] === ART['#title-bar'] && ART['.llama.selected #title-bar'] === ART['.selected #title-bar']);
  check('every picture exists', Object.values(ART).every((f) => fs.existsSync(path.join(ROOT, 'assets/brand', f))));
  const left = [...new Set(bundle.match(/["'`>][^"'`<>\n]{0,70}(Winamp|Webamp|WINAMP|Nullsoft)[^"'`<>\n]{0,50}["'`<]/g) || [])]
    .filter((t) => !/Winamp EQ library file v1\.1|_WINAMP"|WINAMP_|Cannot render a Webamp instance twice|window\.Webamp=/.test(t));
  check('no text left with the old names (the EQ file format\'s header and developer-only names stay)', left.length === 0, left.join(' | '));
  for (const [, to] of TEXT) check('has ' + to, bundle.includes(to));

  console.log('2. On screen, default skin');
  await h.wait(800);
  const image = (sel) => js(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).backgroundImage.slice(0, 200)`);
  const b64 = (f) => fs.readFileSync(path.join(ROOT, 'assets/brand', f)).toString('base64').slice(0, 120);
  const titleOn = await image('#webamp #title-bar');
  check('main title bar is WINIFY', titleOn.includes(b64('title-on.png')) || titleOn.includes(b64('title-off.png')));
  check('main window has the Wi mark', (await image('#webamp #main-window')).includes(b64('main.png')));
  check('playlist title is WINIFY PLAYLIST, active and inactive', ['.selected .playlist-top-title', '.playlist-top-title', '.selected .equalizer-top', '.equalizer-top'].every((sel) => bundle.includes(sel + ' {background-image: url(data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'assets/brand', ART[sel])).toString('base64'))));
  const visible = () => js(`(() => { const out = []; for (const root of [document.querySelector('#webamp'), document.querySelector('#webamp-context-menu')]) { if (!root) continue;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); while (w.nextNode()) if (/\\S/.test(w.currentNode.nodeValue)) out.push(w.currentNode.nodeValue.trim());
    for (const e of root.querySelectorAll('[title],[alt],[aria-label],[placeholder]')) for (const a of ['title', 'alt', 'aria-label', 'placeholder']) if (e.getAttribute(a)) out.push(e.getAttribute(a)); } return out; })()`);
  let seen = await visible();
  check('no old name on screen', !seen.some((t) => NAME.test(t)), seen.filter((t) => NAME.test(t)).join(' | '));
  check('the menu button says Winify Menu', seen.includes('Winify Menu'));
  await h.click(win, js, '#webamp #title-bar #option'); await h.wait(300);
  seen = await visible();
  check('main menu open: Winify..., no old name', seen.includes('Winify...') && !seen.some((t) => NAME.test(t)), seen.filter((t) => NAME.test(t) || t === 'Winify...').join(' | '));
  await js(`document.body.click()`); await h.wait(100);
  check('the logo is still there to click', await js(`!!document.querySelector('#webamp #about')`));

  console.log('3. Another skin keeps its art');
  const skin = fs.readdirSync(path.join(ROOT, 'test/skins')).find((f) => /SoundLair|Purple_Glow|Blue_Jeans/.test(f));
  if (skin) {
    await js(`WinifyWebamp.getInstance().setSkinFromUrl(location.origin + '/test/skins/' + ${JSON.stringify(encodeURIComponent(skin))}); 0`);
    let changed = false; for (let i = 0; i < 60 && !changed; i++) { await h.wait(100); const now = await image('#webamp #title-bar'); changed = !now.includes(b64('title-on.png')) && !now.includes(b64('title-off.png')); }
    check('its own title bar, not ours', changed);
  } else console.log('  (no skin file here: skipped)');

  console.log('4. Winify\'s own strings');
  const sources = fs.readdirSync(ROOT).filter((f) => /\.(js|html)$/.test(f) && f !== 'webamp-brand.js' && f !== 'credits.js');
  const found = [];
  for (const f of sources) fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' ')).split('\n').forEach((line, i) => {
    if (/^\s*\/\//.test(line) || /console\.|\blog\(/.test(line)) return;   // logs are for developers
    for (const m of line.matchAll(/(['"`])((?:(?!\1).)*)\1/g)) if (/\b(Winamp|Webamp|WINAMP)\b/.test(m[2]) && !/did not use|could not construct|tried to re-arrange/.test(line)) found.push(f + ':' + (i + 1) + ' ' + m[2].slice(0, 50));
  });
  check('no old name in a string in the app\'s files', found.length === 0, found.join(' | '));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const body = readme.slice(0, readme.indexOf('## Credits & thanks')) + readme.slice(readme.indexOf('## For developers'));
  check('README: the old names only in the credits and disclaimer', !/winamp|webamp/i.test(body.replace(/Winamp Skin Museum/g, '')), (body.match(/.*(winamp|webamp).*/ig) || []).join(' | '));
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED'); app.exit(fails ? 1 : 0);
}).catch((e) => { console.log('HARNESS ERROR', e.stack); app.exit(3); });
