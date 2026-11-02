// Shared: isolated profile, static server for the project + mock page, real input events.
require('./no-network');
const { app, BrowserWindow } = require('electron');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
// One settings folder and port per suite, so suites can run side by side.
// Named from the script Electron was given: under castLabs' Electron,
// require.main.filename is just "electron", which gave every suite the same
// folder.
const SUITE = path.basename(process.argv[1] || require.main.filename, '.js');
const PROFILE = path.join(ROOT, 'test', '.profiles', 'mock-' + SUITE);
const PORT = Number(process.env.TEST_PORT) || 18899;
const PAGE = path.join(ROOT, 'test', 'mock', 'page.html');
if (!process.env.KEEP_PROFILE) fs.rmSync(PROFILE, { recursive: true, force: true });
app.setPath('userData', PROFILE);
// Keep the test window rendering frames even when other windows cover it; input is frame-aligned.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');   // separate profile: no lock clash, no tokens
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
exports.open = () => new Promise((resolve) => {
  app.whenReady().then(() => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = p === '/__test.html' ? PAGE : path.join(ROOT, p);
      if (p === '/__webamp.css') { const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'); res.writeHead(200, { 'Content-Type': 'text/css' }).end(html.split('\n').filter((l) => /#webamp/.test(l) && !/webamp-root/.test(l)).join('\n')); return; }
      fs.readFile(file, (err, data) => { if (err) { res.writeHead(404).end(); return; }
        if (p === '/node_modules/webamp/built/webamp.bundle.min.mjs') data = require(path.join(ROOT, 'webamp-brand.js')).brand(data.toString('utf8')).bundle;   // as main.js serves it
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(data); });
    }).listen(PORT, '127.0.0.1', async () => {
      const win = new BrowserWindow({ width: 1200, height: 1000, show: true, webPreferences: { backgroundThrottling: false } });
      win.webContents.on('console-message', (e) => { const m = e.message || ''; if (/winify\/controls|winify\/webamp|\*\*\*/.test(m)) console.log('   page:', m); });
      // Mirrors main.js: new-window requests are refused (main opens https in the browser).
      win.webContents.setWindowOpenHandler(({ url }) => { win.webContents.executeJavaScript(`loud.push(['newWindow', ${JSON.stringify(url)}])`).catch(() => {}); return { action: 'deny' }; });
      win.focus();
      await win.loadURL('http://127.0.0.1:' + server.address().port + '/__test.html');
      const js = (code) => win.webContents.executeJavaScript(code);
      while (!(await js('window.mounted === true'))) await new Promise((r) => setTimeout(r, 100));
      resolve({ win, js });
    });
  });
});
exports.wait = (ms) => new Promise((r) => setTimeout(r, ms));
exports.click = async (win, js, selector, fx = 0.5, fy = 0.5, button = 'left') => {
  const r = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width * ${fx}, y: b.top + b.height * ${fy} }; })()`);
  if (!r) throw new Error('not found: ' + selector);
  const x = Math.round(r.x), y = Math.round(r.y);
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
  await exports.wait(40);
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
  await exports.wait(60);
};
