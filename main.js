const { app, BrowserWindow, Menu, Tray, components, desktopCapturer, dialog, ipcMain, nativeImage, screen, session, shell, systemPreferences } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { redact } = require('./drm-redact');

// The packaged app (npm run package) keeps its settings apart from the
// development copy's ("winify"): its own Client ID, sign-in, layout and
// Widevine. The Mac's disk ignores case, so "Winify" would be the same folder.
const PACKAGED_FOLDER = 'Winify App';
if (app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), PACKAGED_FOLDER));

// What both copies share (their other settings stay apart): the Spotify
// request governor's counts and waits (both use the same Client ID, which
// Spotify limits as a whole) and the My playlists index (data about your
// playlists, built once). Tests point it elsewhere (WINIFY_SHARED_DIR).
const SHARED_DIR = process.env.WINIFY_SHARED_DIR || path.join(app.getPath('appData'), 'Winify Shared');
const COPY = app.isPackaged ? 'packaged' : 'dev';
const governor = require('./spotify-governor').create({ dir: SHARED_DIR, copy: COPY, log: (m) => console.log('[governor]', m) });

// Winify ships with no credentials. Every user registers their own Spotify
// app (Spotify's Development Mode allows no shared one) and pastes its Client
// ID on the sign-in screen's setup step; it is stored in Winify's settings
// (config.json in the user-data folder). For development, a gitignored .env
// file or a SPOTIFY_CLIENT_ID environment variable can supply it instead; a
// stored one wins. See README.md.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // No .env file -- the stored Client ID, or the setup step, supplies it.
}

const ENV_CLIENT_ID = (process.env.SPOTIFY_CLIENT_ID || '').trim();
const CLIENT_ID_FORMAT = /^[0-9a-f]{32}$/i;
// The setup guide (README's "Setup" section).
const SETUP_GUIDE = path.join(__dirname, 'README.md');
let clientId = '';  // read once the app is ready (the settings live in userData)

function configFile() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {};
  } catch {
    return {};
  }
}

// Where Winify's window sits among other apps' windows, remembered in
// config.json ("windowLevel"):
//   'normal' - like any app's
//   'top'    - always on top: above other apps' windows (macOS's floating
//              level). The main window's A button (classic Winamp's).
//   'behind' - behind other apps: one level below every other app's
//              ordinary windows (-1), on the desktop like a widget (still
//              above the desktop's icons). Clicking it leaves it there. The
//              menu-bar menu's "Keep behind other apps".
// One setting, so turning one on turns the other off.
const WINDOW_LEVELS = ['normal', 'top', 'behind'];
let windowLevel = 'normal';
let inFullScreen = false;     // Milkdrop full screen (macOS can report the change late)

function loadWindowLevel() {
  const level = readConfig().windowLevel;
  windowLevel = WINDOW_LEVELS.includes(level) ? level : 'normal';
}

function applyWindowLevel() {
  if (!win || win.isDestroyed()) return;
  send('window-level', windowLevel);
  // Full screen (Milkdrop) keeps its own level, in front of everything:
  // lowered, macOS treats it as covered and slows its drawing. The setting
  // is applied again when it ends.
  if (inFullScreen) return;
  if (windowLevel === 'top') win.setAlwaysOnTop(true, 'floating');
  else if (windowLevel === 'behind') win.setAlwaysOnTop(true, 'normal', -1);
  else if (win.isAlwaysOnTop()) win.setAlwaysOnTop(false);
}

// Applied again shortly after a change, and whenever the window is focused,
// shown or restored: Chromium keeps its own idea of the window's level and
// can put it back, which was seen to leave "behind" at the ordinary level.
let levelTimer = null;
function reapplyWindowLevelSoon() {
  if (windowLevel === 'normal') return;        // nothing to hold on to
  clearTimeout(levelTimer);
  levelTimer = setTimeout(applyWindowLevel, 300);
}

function setWindowLevel(level) {
  if (!WINDOW_LEVELS.includes(level)) return;
  windowLevel = level;
  try {
    fs.writeFileSync(configFile(), JSON.stringify(Object.assign(readConfig(), { windowLevel: level }), null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[window] could not remember the window level:', err.message);
  }
  console.log('[window] level:', level);
  applyWindowLevel();
  reapplyWindowLevelSoon();
  buildTray();
}

function loadClientId() {
  clientId = String(readConfig().clientId || ENV_CLIENT_ID || '').trim();
}

function storeClientId(id) {
  const config = Object.assign(readConfig(), { clientId: id });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
  clientId = id;
}

// Is this a Client ID Spotify knows? Spotify's sign-in page accepts any value
// until after the user has logged in (and then reports problems in the
// browser, out of Winify's sight), so the token endpoint is asked instead,
// with a code that cannot be valid: an unknown app is "invalid_client", a
// known one gets as far as "invalid_grant". Answers 'ok', 'format',
// 'invalid-client' or 'unreachable'.
async function checkClientId(id) {
  if (!CLIENT_ID_FORMAT.test(id)) return 'format';
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'winify-client-id-check',
        redirect_uri: REDIRECT_URI,
        client_id: id,
        code_verifier: 'winify-client-id-check-'.padEnd(64, 'x'),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (body.error === 'invalid_client') return 'invalid-client';
    if (body.error === 'invalid_grant') return 'ok';
    console.warn('[config] unexpected answer checking the Client ID:', res.status, body.error || '');
    return 'unreachable';
  } catch (err) {
    console.warn('[config] could not check the Client ID:', err.message);
    return 'unreachable';
  }
}

const maskClientId = (id) => (id ? id.slice(0, 4) + '\u2026' + id.slice(-4) : null);

// Loopback audio capture is behind Chromium feature flags on macOS, and they
// have to be set before the app is ready. Without them getDisplayMedia rejects
// the audio: 'loopback' constraint outright.
// A page loaded while something covers the window would count as hidden, get no
// frames, and stay that way after it is uncovered.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('enable-features', [
  'MacLoopbackAudioForScreenShare',
  'MacSckSystemAudioLoopbackOverride',
  'MacCatapSystemAudioLoopbackCapture',
].join(','));

// PKCE is used, so no Client Secret is required and none is read.

// No Client ID yet (or a new one wanted): the sign-in screen's setup step.
// `error` is why it is shown again ('invalid-client': Spotify no longer knows
// the stored one). A first run starts at the welcome screen ("Get started").
function showSetup(error) {
  setStatus('Connect your Spotify app');
  send('auth:setup', { current: maskClientId(clientId), error: error || null, firstRun: !clientId && !error, remember });
}

// Menu bar > Change Spotify Client ID...: a new app means new tokens. The page
// starts over too, as after quitting and reopening, so the next sign-in gets a
// fresh player library and device rather than whatever the old session left.
let setupOnLoad = false;
function changeClientId() {
  signOut();
  showWindow();
  setupOnLoad = true;
  if (win && !win.isDestroyed()) win.webContents.reload();
}
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPES = [
  'user-read-private', // required for the Premium check on /v1/me
  'user-read-email', // the Web Playback SDK expects this alongside user-read-private
  'streaming', // required to play audio through the in-app device
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
  'playlist-read-private', // list your private playlists in the playlist window
  'playlist-read-collaborative', // ...and collaborative ones
  'user-library-read', // list Liked Songs
];
const REQUEST_TIMEOUT_MS = 10000;
// How long we'll wait for you to finish in the browser before giving up.
const AUTH_TIMEOUT_MS = Number(process.env.WINIFY_AUTH_TIMEOUT_MS) || 180000;

// The four handshake lines the sign-in screen shows, in order.
const STEP_HANDSHAKE = 0;
const STEP_TOKEN = 1;
const STEP_PREMIUM = 2;
const STEP_LIBRARY = 3;

let win;
let tokens = null; // { accessToken, refreshToken, expiresAt }
let authServer = null;
let authTimer = null;
let remember = false; // mirrors the "remember me" lamp
let capturingAudio = false; // mirrors the renderer's capture state, for menu labels
let webampDoubled = true; // mirrors Webamp's double-size mode, for the menu
let milkdropOpen = false;  // mirrors the Milkdrop window, for the menu
let milkdropDesktop = false;  // Milkdrop's desktop mode, for the menu
let tray = null;
let connected = false; // real Spotify connection state, shown in the menu bar
let isQuitting = false;
const DRM_DEBUG = process.argv.includes('--drm-debug');
let appServer = null;
let appOrigin = null;

// --- Local origin ---------------------------------------------------------
// The app used to load over file://, which has an opaque origin. Widevine
// keys its per-origin storage by origin, and a cross-origin iframe (which is
// where the playback SDK does its EME work) can only be granted the
// encrypted-media permission by a parent that has a real one. Serving over
// http://127.0.0.1 gives us a normal, potentially-trustworthy origin.

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

const WORKER_CSP = "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src data:";

// A stable port matters more than it looks: the origin is what macOS keys
// media permissions to, so a random port every launch meant the microphone
// grant never persisted and the device-label warm-up re-opened the mic on
// every start. 8888 is left alone -- that is the OAuth callback.
// The packaged app has its own range: its storage (layout, mixes, the
// playlist index) belongs to the port too, so the two copies running at once
// must not push each other onto another port and an empty store.
const APP_PORTS = app.isPackaged ? [8909, 8910, 8911, 8912, 8913] : [8899, 8900, 8901, 8902, 8903];

// Webamp with Winify's names and default-skin art (webamp-brand.js).
const WEBAMP_BUNDLE = '/node_modules/webamp/built/webamp.bundle.min.mjs';
let branded = null;
function brandedWebamp(data) {
  if (branded) return branded;
  const { bundle, missing } = require('./webamp-brand.js').brand(data.toString('utf8'));
  if (missing.length) console.error('[app] *** not found in Webamp, so not renamed:', missing.join(' | '));
  branded = bundle;
  return branded;
}

// About Winify: the main menu's first item and the menu-bar menu.
async function showAbout() {
  const { response } = await dialog.showMessageBox({
    message: 'Winify ' + require('./package.json').version,
    detail: require('./credits.js').ABOUT,
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')),
    buttons: ['OK', 'Project page'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) shell.openExternal(require('./package.json').homepage);
}
ipcMain.on('about:show', showAbout);

function startAppServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (pathname === '/') pathname = '/index.html';

      // Only ever serve known static asset types, never dotfiles: this server
      // sits on the same directory as .env, and must not hand it out.
      const ext = path.extname(pathname).toLowerCase();
      if (!MIME[ext] || pathname.split('/').some((seg) => seg.startsWith('.'))) {
        res.writeHead(404).end();
        return;
      }

      const filePath = path.normalize(path.join(__dirname, pathname));
      if (!filePath.startsWith(__dirname + path.sep)) {
        res.writeHead(403).end();
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404).end();
          return;
        }
        if (pathname === WEBAMP_BUNDLE) data = brandedWebamp(data);
        const headers = { 'Content-Type': MIME[ext], 'Cache-Control': 'no-store' };
        // Milkdrop's preset converter: a worker with a policy of its own (its
        // loader builds code from text, which the page forbids) and no network.
        if (pathname === '/milkdrop-convert-worker.js') headers['Content-Security-Policy'] = WORKER_CSP;
        res.writeHead(200, headers);
        res.end(data);
      });
    });

    let attempt = 0;
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && attempt < APP_PORTS.length - 1) {
        // Falling back changes the origin, and media permissions are keyed to
        // it -- so say so loudly rather than drifting quietly.
        console.warn(`[app] port ${APP_PORTS[attempt]} is in use; falling back.`,
          'The origin changes with it, so macOS may ask for microphone access again.',
          'Usually this means another Winify is still running.');
        attempt += 1;
        server.listen(APP_PORTS[attempt], '127.0.0.1');
        return;
      }
      reject(err);
    });

    const onListening = () => {
      appServer = server;
      appOrigin = `http://127.0.0.1:${server.address().port}`;
      console.log('[app] serving from', appOrigin);
      resolve(appOrigin);
    };
    server.on('listening', onListening);
    server.listen(APP_PORTS[0], '127.0.0.1');
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setStatus(text) {
  send('status', text);
}

// Winify is one see-through window over the main display's usable area (below
// the menu bar, beside the Dock): only the chassis, the Webamp windows and
// Winify's own windows are drawn in it. Clicks on the empty parts pass through
// to whatever is behind (the page switches that, window-passthrough.js).
// One window cannot span displays, so Winify lives on the main display.
function homeArea() {
  return screen.getPrimaryDisplay().workArea;
}

function createWindow() {
  win = new BrowserWindow({
    ...homeArea(),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    // macOS's own full screen is not for see-through windows (and toggling it
    // under simple full screen crashes AppKit); see enter-html-full-screen.
    fullscreenable: false,
    // A click on a Winify window while another app is in front acts at once
    // (rather than only bringing Winify forward).
    acceptFirstMouse: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Chromium throttles timers in hidden/occluded windows, which starves
      // the playback SDK's buffering and causes stalls and skipped tracks.
      // This window is meant to be tucked away, so throttling must be off.
      backgroundThrottling: false,
      // The chassis's version label. package.json itself, not app.getVersion():
      // that is Electron's version when a test starts main.js.
      additionalArguments: ['--winify-version=' + require('./package.json').version],
    },
  });
  // Demo hook preserved: `npm start -- --outcome=network` (or free-account)
  // replays the designed simulation instead of touching the real API.
  const flag = process.argv.find((a) => a.startsWith('--outcome='));
  const outcome = flag ? flag.slice('--outcome='.length) : '';

  const search = [];
  if (outcome) search.push(`outcome=${outcome}`);
  if (DRM_DEBUG) {
    search.push('drmdebug=1');
    attachDrmDebug(win);
  }
  const query = search.length ? `?${search.join('&')}` : '';
  win.loadURL(`${appOrigin}/index.html${query}`);

  // Closing the window tucks the app away rather than quitting it; the
  // menu-bar item is how you bring it back or quit for real.
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hideWindow();
  });
  watchVisibility();
  watchHomeArea();
  // Always on top or behind (remembered), and the page told which, once it
  // is there.
  applyWindowLevel();
  for (const event of ['focus', 'show', 'restore']) win.on(event, reapplyWindowLevelSoon);
  win.webContents.on('did-finish-load', () => send('window-level', windowLevel));
  // Until the page says otherwise, clicks pass through.
  setPassThrough(true);
  watchCursor();
  // Full screen (Milkdrop): a see-through window cannot use macOS's own full
  // screen, so it covers the whole display in simple full screen instead,
  // and goes back to the usable area after.
  win.webContents.on('enter-html-full-screen', () => {
    // Behind other apps, full screen would stay under their windows: an
    // ordinary window while it lasts.
    inFullScreen = true;
    if (windowLevel === 'behind') win.setAlwaysOnTop(false);
    win.setSimpleFullScreen(true);
    // In front of everything else, or macOS treats it as covered and slows
    // its drawing.
    win.moveTop();
    win.focus();
  });
  win.webContents.on('leave-html-full-screen', () => {
    // After Electron has finished its own leaving.
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.setSimpleFullScreen(false);
      win.setBounds(homeArea());
      inFullScreen = false;
      applyWindowLevel();
    }, 0);
  });

  // Links that ask for a new window (Webamp's logo, its "Webamp..." menu item)
  // open in the default browser instead of a bare in-app window. Only web
  // links: anything else is refused.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Milkdrop's desktop mode: its wallpaper window (webamp-milkdrop.js draws
    // into it). At macOS's desktop level, behind the icons and every window;
    // it takes no clicks. The whole main display, on every Space.
    if (url === `${appOrigin}/milkdrop-desktop.html`) {
      const { bounds } = screen.getPrimaryDisplay();
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...bounds,
          type: 'desktop',
          frame: false,
          hasShadow: false,
          resizable: false,
          movable: false,
          focusable: false,
          skipTaskbar: true,
          enableLargerThanScreen: true,
          backgroundColor: '#000000',
          title: 'Milkdrop',
          webPreferences: { backgroundThrottling: false },
        },
      };
    }
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child, { url }) => {
    if (url !== `${appOrigin}/milkdrop-desktop.html`) return;
    child.setIgnoreMouseEvents(true);
    child.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
  });

  // Audio capture and lyrics are diagnosed from the terminal, so their logs
  // are mirrored there always -- not only under --drm-debug, where they used
  // to hide.
  win.webContents.on('console-message', (event) => {
    const text = (event && event.message) || '';
    if (DRM_DEBUG) return; // the debug path already mirrors everything
    if (text.startsWith('[winify/audio]') || text.startsWith('[winify/lyrics]')) console.log(text);
  });
}

// --- System audio capture -------------------------------------------------
// The visualizers read the sound actually leaving the speakers: Spotify's audio
// is DRM-protected, so its waveform cannot be read from the playback SDK, and
// the audio-analysis endpoints were restricted in 2024. Electron 39+ supports
// loopback capture natively, so this needs no extra dependency -- which also
// means nothing here can disturb the VMP-signed Electron binary.
function enableLoopbackAudio() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        // getDisplayMedia refuses an audio-only request, so a video source has
        // to be named even though the renderer throws the video track away.
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (!sources.length) {
          console.error('[audio] no screen source available for loopback capture');
          callback({});
          return;
        }
        console.log('[audio] granting loopback audio capture');
        callback({ video: sources[0], audio: 'loopback' });
      } catch (err) {
        console.error('[audio] could not grant loopback capture:',
          (err && (err.stack || err.message)) || String(err));
        callback({});
      }
    },
    // Stage 1 hit the documented Electron bug: with useSystemPicker false the
    // loopback track is created and then immediately 'ended', delivering no
    // audio. Handing the picker to macOS is the known workaround; the cost is
    // that the user picks a source once per capture session.
    { useSystemPicker: true }
  );
}

// --- DRM diagnostics ------------------------------------------------------
// Opt-in with `npm start -- --drm-debug`. The playback SDK runs its EME inside
// a cross-origin iframe, so the only way to see its licence traffic and media
// errors is through the DevTools protocol at the webContents level.

// Every line it writes goes through redact (drm-redact.js): no tokens or
// signed links in a transcript that gets pasted into bug reports.
function attachDrmDebug(win) {
  const t0 = Date.now();
  const stamp = () => '+' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const dbg = win.webContents.debugger;
  const say = (text) => console.log(redact(text));

  try {
    dbg.attach('1.3');
  } catch (err) {
    console.error('[drm] could not attach debugger:', err && err.message);
    return;
  }
  // Bump this whenever the diagnostics change, so a capture can never be
  // mistaken for one produced by an older, still-running instance.
  console.log('[drm] diagnostics ON - build DIAG-4 (http origin + cross-origin frame capture, redacted)');

  // Mirror the renderer's console into this terminal so the EME hooks, the SDK
  // errors and the licence traffic all land in one transcript.
  win.webContents.on('console-message', (event) => {
    const text = (event && event.message) || '';
    if (/^\[(drm|winify)/.test(text)) say(`[renderer] ${stamp()} ${text}`);
  });

  // Spotify's Widevine licences go to a spclient host; audio segments come
  // from audio-* / *.scdn.co. Both matter: a licence failure and a segment
  // failure look identical from the outside but have different causes.
  const isLicence = (url) => /widevine|licen[cs]e/i.test(url);
  const isInteresting = (url) => isLicence(url) || /spclient|scdn\.co|audio-/i.test(url);
  const inflight = new Map();

  dbg.on('message', async (_event, method, params, sessionId) => {
    try {
      // The playback SDK's iframe is cross-origin, so under site isolation it
      // lives in its own renderer process with its own CDP target. Without
      // attaching to it we see none of its licence traffic or media errors.
      if (method === 'Target.attachedToTarget') {
        const sid = params.sessionId;
        const info = params.targetInfo || {};
        say(`[drm] ${stamp()} ATTACHED to ${info.type} ${String(info.url || '').slice(0, 100)}`);
        for (const cmd of ['Network.enable', 'Media.enable', 'Runtime.enable', 'Log.enable']) {
          dbg.sendCommand(cmd, {}, sid).catch(() => {});
        }
        dbg.sendCommand('Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid).catch(() => {});
        dbg.sendCommand('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
        return;
      }

      // Console output from inside the SDK's own frame.
      if (method === 'Runtime.consoleAPICalled') {
        const text = (params.args || []).map((a) => a.value || a.description || a.type).join(' ');
        if (text) say(`[drm] ${stamp()} SDK CONSOLE [${params.type}] ${text.slice(0, 400)}`);
        return;
      }
      if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails || {};
        say(`[drm] ${stamp()} SDK EXCEPTION ${(d.exception && d.exception.description || d.text || '').slice(0, 400)}`);
        return;
      }
      if (method === 'Log.entryAdded') {
        const e = params.entry || {};
        if (e.level === 'error' || /licen|drm|eme|key|media/i.test(e.text || '')) {
          say(`[drm] ${stamp()} BROWSER LOG [${e.level}] ${String(e.text).slice(0, 400)} ${String(e.url || '').slice(0, 120)}`);
        }
        return;
      }

      if (method === 'Network.requestWillBeSent') {
        const url = params.request.url;
        if (isInteresting(url)) {
          inflight.set(params.requestId, url);
          if (isLicence(url)) say(`[drm] ${stamp()} LICENCE REQUEST ${params.request.method} ${url.slice(0, 160)}`);
        }
      } else if (method === 'Network.responseReceived') {
        const url = inflight.get(params.requestId);
        if (!url) return;
        const st = params.response.status;
        if (isLicence(url)) {
          say(`[drm] ${stamp()} LICENCE RESPONSE ${st} ${params.response.statusText || ''} ${url.slice(0, 160)}`);
        } else if (st >= 400) {
          say(`[drm] ${stamp()} SEGMENT/API ${st} ${url.slice(0, 160)}`);
        }
      } else if (method === 'Network.loadingFinished') {
        const url = inflight.get(params.requestId);
        if (url && isLicence(url)) {
          try {
            const body = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }, sessionId);
            const text = body.base64Encoded
              ? `<binary licence blob, ${Buffer.from(body.body, 'base64').length} bytes>`
              : String(body.body).slice(0, 300);                 // an error, as text (redacted)
            say(`[drm] ${stamp()} LICENCE BODY ${text}`);
          } catch (err) {
            say(`[drm] ${stamp()} LICENCE BODY unavailable: ${err && err.message}`);
          }
        }
        inflight.delete(params.requestId);
      } else if (method === 'Network.loadingFailed') {
        const url = inflight.get(params.requestId);
        if (url) {
          say(`[drm] ${stamp()} REQUEST FAILED ${params.errorText} ${url.slice(0, 160)}`);
          inflight.delete(params.requestId);
        }
      } else if (method === 'Media.playerErrorsRaised') {
        for (const e of params.errors || []) {
          say(`[drm] ${stamp()} MEDIA ERROR ${JSON.stringify(e).slice(0, 800)}`);
        }
      } else if (method === 'Media.playerEventsAdded') {
        for (const e of params.events || []) {
          const v = String(e.value || '');
          if (v) say(`[drm] ${stamp()} MEDIA EVENT ${v.slice(0, 500)}`);
        }
      } else if (method === 'Media.playerPropertiesChanged') {
        for (const pr of params.properties || []) {
          say(`[drm] ${stamp()} MEDIA PROP ${pr.name}=${String(pr.value).slice(0, 200)}`);
        }
      }
    } catch (err) {
      console.error(redact('[drm] handler error: ' + (err && err.message)));
    }
  });

  dbg.sendCommand('Network.enable');
  dbg.sendCommand('Media.enable');
  dbg.sendCommand('Log.enable').catch(() => {});
  dbg.sendCommand('Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch((e) =>
    console.error('[drm] could not auto-attach to sub-targets:', e && e.message));
}

// --- Menu bar -------------------------------------------------------------

function setConnected(value) {
  connected = value;
  buildTray();
}

// Whether the window is on screen, tracked here rather than read from the
// window's show/hide events: macOS emits a spurious hide during setup, a
// stray show while minimized, and fires them before isVisible() settles, so
// inferring from them left the renderer pausing visualizers for a window
// plainly on screen. Three independent ways off screen, each set by an
// unambiguous signal:
//   windowShown  - our own Show/Hide and the close button
//   minimized    - Cmd+M / the yellow button (minimize/restore events)
//   appHidden    - Cmd+H (NSApplication hide/unhide notifications)
// A BrowserWindow is shown on creation, hence the initial values.
let windowShown = true;
let minimized = false;
let appHidden = false;

function isOnScreen() {
  return windowShown && !minimized && !appHidden;
}

function reportVisibility() {
  buildTray();
  send('window:visibility', isOnScreen());
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  lastCursor = null;   // look at the pointer afresh once shown
  // Bring it back from whichever way it went: Cmd+H, minimize, or hide.
  if (process.platform === 'darwin') app.show();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  windowShown = true;
  minimized = false;
  appHidden = false;
  reportVisibility();
}

function hideWindow() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  windowShown = false;
  reportVisibility();
}

// ---- Click-through -------------------------------------------------------------
// The page decides whether the pointer is over something of Winify's (it
// knows the shapes); this tells it where the pointer is. Forwarded mouse
// moves only arrive while Winify is the active app, so the position is read
// here as well, a few times a second while Winify is on screen: it keeps
// working after another app (or the desktop) takes the clicks. Only a
// changed position is sent; outside the window it passes through directly.
const CURSOR_POLL_MS = 60;
let passThrough = null;
let cursorTimer = null;
let lastCursor = null;

function setPassThrough(on) {
  if (!win || win.isDestroyed() || passThrough === on) return;
  passThrough = on;
  win.setIgnoreMouseEvents(on, { forward: true });
}

function checkCursor(force) {
  if (!win || win.isDestroyed() || !isOnScreen() || win.isSimpleFullScreen()) return;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const at = { x: p.x - b.x, y: p.y - b.y };
  if (!force && lastCursor && lastCursor.x === at.x && lastCursor.y === at.y) return;
  lastCursor = at;
  if (at.x < 0 || at.y < 0 || at.x >= b.width || at.y >= b.height) { setPassThrough(true); return; }
  send('window:cursor', at);
}

function watchCursor() {
  clearInterval(cursorTimer);
  cursorTimer = setInterval(() => checkCursor(false), CURSOR_POLL_MS);
  // Shown, restored, brought forward, or the other app took over: look again now.
  for (const event of ['show', 'restore', 'focus', 'blur']) win.on(event, () => setTimeout(() => checkCursor(true), 50));
  app.on('did-become-active', () => checkCursor(true));
  app.on('did-resign-active', () => checkCursor(true));
}

// Displays added, removed or rearranged, the Dock moved: back to the main
// display's usable area. The page keeps its windows inside it.
function watchHomeArea() {
  const refit = () => {
    if (!win || win.isDestroyed() || win.isSimpleFullScreen()) return;
    win.setBounds(homeArea());
    checkCursor(true);
  };
  screen.on('display-metrics-changed', refit);
  screen.on('display-added', refit);
  screen.on('display-removed', refit);
}

function watchVisibility() {
  win.on('minimize', () => { minimized = true; reportVisibility(); });
  win.on('restore', () => { minimized = false; reportVisibility(); });
  if (process.platform === 'darwin') {
    // Electron has no app-level hide event; these are what Cmd+H produces.
    systemPreferences.subscribeLocalNotification('NSApplicationDidHideNotification',
      () => { appHidden = true; reportVisibility(); });
    systemPreferences.subscribeLocalNotification('NSApplicationDidUnhideNotification',
      () => { appHidden = false; reportVisibility(); });
  }
}

// The My playlists index, as the page last reported it ({ indexed,
// playlists, buildOn, building }), for "Build full index".
let indexState = null;
ipcMain.on('index-state', (_event, st) => {
  const before = JSON.stringify(indexState);
  indexState = st && typeof st === 'object' ? st : null;
  if (JSON.stringify(indexState) !== before) buildTray();
});
function indexItem() {
  const st = indexState;
  const of = st && st.playlists ? ' (' + st.indexed + ' of ' + st.playlists + ')' : '';
  if (st && st.playlists && st.indexed >= st.playlists && !st.buildOn) return { label: 'Index complete' + of, enabled: false };
  return {
    label: st && st.buildOn ? 'Pause building the index' + of : 'Build full index' + of,
    enabled: connected,
    click: () => send('ui:command', { name: st && st.buildOn ? 'index-pause' : 'index-build' }),
  };
}

// Winify's own Spotify requests (both copies; Spotify's player library is
// not counted), so usage can be seen. Updated as requests are made.
let usageTimer = null;
governor.onCount(() => {
  if (!usageTimer) usageTimer = setTimeout(() => { usageTimer = null; buildTray(); }, 5000);
});
function usageItem() {
  const u = governor.usage();
  return { label: 'Spotify requests: ' + u.hour + ' in the last hour, ' + u.today + ' today', enabled: false };
}

function buildTray() {
  if (!tray) return;
  const visible = isOnScreen();

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: connected ? 'Connected' : 'Not connected', enabled: false },
    { type: 'separator' },
    {
      label: visible ? 'Hide Winify' : 'Show Winify',
      click: () => (visible ? hideWindow() : showWindow()),
    },
    { type: 'separator' },
    {
      label: 'Transfer playback here',
      enabled: connected,
      click: () => send('ui:command', { name: 'transfer-playback' }),
    },
    {
      label: capturingAudio ? 'Stop audio capture' : 'Start audio capture',
      enabled: connected,
      click: () => send('ui:command', { name: capturingAudio ? 'audio-stop' : 'audio-start' }),
    },
    {
      label: 'Double size',
      type: 'checkbox',
      checked: webampDoubled,
      enabled: connected,
      click: () => send('ui:command', { name: 'toggle-doublesize' }),
    },
    {
      label: 'Milkdrop visualizer',
      type: 'checkbox',
      checked: milkdropOpen,
      enabled: connected,
      click: () => {
        showWindow();
        send('ui:command', { name: 'toggle-milkdrop' });
      },
    },
    {
      label: 'Milkdrop desktop mode',
      type: 'checkbox',
      checked: milkdropDesktop,
      enabled: connected,
      click: () => send('ui:command', { name: 'toggle-milkdrop-desktop' }),
    },
    {
      label: 'Load skin...',
      enabled: connected,
      click: chooseSkin,
    },
    {
      label: 'Jump to track...  (J)',
      enabled: connected,
      click: () => {
        showWindow();
        send('ui:command', { name: 'jump-to-track' });
      },
    },
    {
      label: 'Keep behind other apps',
      type: 'checkbox',
      checked: windowLevel === 'behind',
      click: () => setWindowLevel(windowLevel === 'behind' ? 'normal' : 'behind'),
    },
    {
      label: 'Reset window layout',
      enabled: connected,
      click: () => {
        showWindow();
        send('ui:command', { name: 'reset-layout' });
      },
    },
    { type: 'separator' },
    indexItem(),
    usageItem(),
    { type: 'separator' },
    {
      label: 'Change Spotify Client ID...',
      click: changeClientId,
    },
    {
      label: 'Disconnect',
      enabled: connected,
      click: () => {
        signOut();        // clears tokens + stored file, returns to the sign-in screen
        showWindow();     // so you can see where you landed
      },
    },
    { type: 'separator' },
    {
      label: 'About Winify...',
      click: showAbout,
    },
    {
      label: 'Quit Winify',
      accelerator: 'Command+Q',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

// The renderer cannot read files, so the skin is loaded here and handed over
// as bytes.
async function chooseSkin() {
  const result = await dialog.showOpenDialog({
    title: 'Load a skin',
    filters: [{ name: 'Skin', extensions: ['wsz', 'zip'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return;
  const file = result.filePaths[0];
  try {
    const data = fs.readFileSync(file);
    send('ui:command', {
      name: 'load-skin',
      fileName: path.basename(file),
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    });
    console.log('[skin] sent', path.basename(file), data.length, 'bytes');
  } catch (err) {
    dialog.showErrorBox('Winify: could not read skin', String(err && err.message));
  }
}

// Milkdrop > Load presets...: files, folders or both. Folders are searched
// (a few levels down) for .milk and .json files; the renderer converts and
// checks them. Read here because the renderer cannot read files.
const PRESET_EXTENSIONS = /\.(milk|json)$/i;
const PRESET_MAX_BYTES = 512 * 1024;
const PRESET_MAX_FILES = 1000;

function collectPresetFiles(paths) {
  const files = [];
  const skipped = [];
  const visit = (p, depth, picked) => {
    if (files.length >= PRESET_MAX_FILES) return;
    let stat;
    try { stat = fs.statSync(p); } catch (e) { skipped.push({ name: path.basename(p), error: 'could not be read' }); return; }
    if (stat.isDirectory()) {
      if (depth > 3) return;
      let entries = [];
      try { entries = fs.readdirSync(p).sort(); } catch (e) { return; }
      for (const entry of entries) {
        if (!entry.startsWith('.')) visit(path.join(p, entry), depth + 1, false);
      }
      return;
    }
    if (!PRESET_EXTENSIONS.test(p)) {
      if (picked) skipped.push({ name: path.basename(p), error: 'not a .milk or .json file' });
      return;
    }
    if (stat.size > PRESET_MAX_BYTES) { skipped.push({ name: path.basename(p), error: 'too large for a preset' }); return; }
    try { files.push({ name: path.basename(p), text: fs.readFileSync(p, 'utf8') }); } catch (e) { skipped.push({ name: path.basename(p), error: 'could not be read' }); }
  };
  for (const p of paths) visit(p, 0, true);
  return { files, skipped };
}

ipcMain.handle('milkdrop:choose-presets', async () => {
  const result = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
    title: 'Load Milkdrop presets',
    buttonLabel: 'Load',
    filters: [{ name: 'Milkdrop presets', extensions: ['milk', 'json'] }],
    properties: ['openFile', 'openDirectory', 'multiSelections'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return collectPresetFiles(result.filePaths);
});

function createTray() {
  // Template image: black + alpha, so macOS recolours it for the menu-bar theme.
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Winify');
  buildTray();
  // The request counter's "last hour" moves on with time, requests or not.
  setInterval(buildTray, 60 * 1000);
}

// --- Token storage --------------------------------------------------------
// Nothing is written to disk unless the "remember me" lamp is lit.

function tokenFile() {
  return path.join(app.getPath('userData'), 'tokens.json');
}

function saveTokens() {
  if (!remember || !tokens) return;
  try {
    fs.writeFileSync(tokenFile(), JSON.stringify(tokens), { mode: 0o600 });
  } catch {
    // Not fatal: you just log in again next launch.
  }
}

function forgetTokens() {
  try {
    fs.rmSync(tokenFile(), { force: true });
  } catch {
    // Nothing to clean up.
  }
}

// --- Auth plumbing --------------------------------------------------------

// Tears down a login attempt. Without this, an abandoned attempt keeps port
// 8888 held and "Try again" fails with EADDRINUSE.
function cancelAuth() {
  if (authServer) {
    try {
      authServer.close();
      authServer.closeAllConnections();   // none left open to answer for an old attempt
    } catch {
      // Already closed.
    }
    authServer = null;
  }
  if (authTimer) {
    clearTimeout(authTimer);
    authTimer = null;
  }
}

// Routes a real failure to one of the screen's two designed error states.
function failAuth(kind) {
  cancelAuth();
  tokens = null;
  forgetTokens();
  setConnected(false);
  send('auth:error', kind);
}

// One more at every sign-out: an answer for an earlier session is dropped, and
// cannot put its tokens back or finish a sign-in nobody is waiting for.
let signOuts = 0;

function signOut() {
  signOuts++;
  cancelAuth();
  tokens = null;
  forgetTokens();
  setStatus('Not logged in');
  setConnected(false);
  send('auth:signed-out');
}

async function requestToken(params) {
  const session = signOuts;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, ...params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Token request failed (${res.status})`);
  const data = await res.json();
  if (session !== signOuts) return;
  tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || (tokens && tokens.refreshToken),
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope || (tokens && tokens.scope) || '',
  };
  saveTokens();
}

// Spotify rotates the refresh token on every use, so two overlapping refreshes
// mean the second one presents an already-spent token and gets invalid_grant --
// which used to sign the session out mid-track. Both callers (the 5s poll and
// the SDK's token request) now share one in-flight refresh.
let refreshInFlight = null;

function refreshTokens() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = requestToken({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
  })
    .then(() => {
      if (!tokens) return;   // signed out meanwhile
      console.log('[auth] access token refreshed, valid for',
        Math.round((tokens.expiresAt - Date.now()) / 1000), 'seconds');
    })
    .catch((err) => {
      console.error('[auth] token refresh FAILED:', err && err.message);
      throw err;
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}

// Sign-in's own requests: first in line, never held back, but counted.
function api(pathname) {
  governor.count();
  return fetch(`https://api.spotify.com${pathname}`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

// --- Login (Authorization Code with PKCE) ---------------------------------

function login() {
  cancelAuth();
  tokens = null;

  if (!clientId) {
    showSetup();
    return;
  }

  const verifier = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  // Step 0: listener up, browser opening, waiting for you to approve.
  send('auth:step', STEP_HANDSHAKE);
  // No answer at all: most likely Spotify refused the redirect URI, which it
  // reports only in the browser (an unknown Client ID is caught below).
  authTimer = setTimeout(() => failAuth('redirect'), AUTH_TIMEOUT_MS);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, REDIRECT_URI);
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }

    // An older attempt's answer (its tab was still open after Try again): not
    // this attempt's failure, so it keeps waiting.
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Sign-in failed: this tab is from an earlier attempt. Use the newest one, or press Try again in Winify.');
      return;
    }
    const code = url.searchParams.get('code');
    const ok = !!code;
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain' });
    res.end(ok ? 'Connected. You can close this tab.' : 'Sign-in failed. You can close this tab.');
    cancelAuth();

    if (!ok) {
      failAuth('network');
      return;
    }
    await completeLogin(code, verifier);
  });

  authServer = server;
  server.on('error', () => failAuth('network'));

  server.listen(8888, '127.0.0.1', async () => {
    // A Client ID Spotify does not know (the app was deleted, say) is caught
    // here rather than in the browser.
    const verdict = await checkClientId(clientId);
    if (authServer !== server) return;   // cancelled meanwhile
    if (verdict === 'invalid-client' || verdict === 'format') {
      cancelAuth();
      showSetup('invalid-client');
      return;
    }
    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SCOPES.join(' '),
      redirect_uri: REDIRECT_URI,
      state,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    }).toString();
    shell.openExternal(authUrl.toString());
  });
}

async function completeLogin(code, verifier) {
  const session = signOuts;
  // Step 1: trade the code for tokens.
  send('auth:step', STEP_TOKEN);
  try {
    await requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
  } catch {
    if (session === signOuts) failAuth('network');
    return;
  }
  if (session !== signOuts) return;

  const granted = String(tokens.scope || '').split(' ');
  const notGranted = SCOPES.filter((scope) => !granted.includes(scope));
  if (notGranted.length) {
    console.warn('[auth] Spotify did not grant:', notGranted.join(', '));
  }

  // Step 2: the real Premium check.
  send('auth:step', STEP_PREMIUM);
  let profile;
  try {
    const res = await api('/v1/me');
    if (!res.ok) throw new Error(`Profile request failed (${res.status})`);
    profile = await res.json();
  } catch {
    if (session === signOuts) failAuth('network');
    return;
  }
  if (session !== signOuts) return;

  if (profile.product !== 'premium') {
    failAuth('free-account');
    return;
  }

  // Step 3: first real read of what's playing.
  send('auth:step', STEP_LIBRARY);
  await pollCurrentSong();
  if (session !== signOuts) return;

  setConnected(true);
  send('auth:connected');
}

// Runs at launch: a stored refresh token skips the sign-in screen entirely.
async function restoreSession() {
  if (!clientId) {
    showSetup();
    return;
  }
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
  } catch {
    return; // No stored session; the sign-in screen stays up.
  }

  if (!saved || !saved.refreshToken) return;

  const granted = String(saved.scope || '').split(' ');
  const missing = SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length) {
    // Winify now needs permissions this session was never granted. Say so on
    // the sign-in screen rather than silently running with fewer features.
    console.log('[auth] stored session is missing scopes:', missing.join(', '), '- asking to sign in again');
    forgetTokens();
    remember = true; // the file only exists if the lamp was lit; keep it lit
    setStatus('Sign in again to grant new permissions');
    send('auth:error', 'rescope');
    return;
  }

  remember = true; // the file only exists if the lamp was lit
  tokens = saved;
  try {
    await refreshTokens();
  } catch {
    tokens = null;
    forgetTokens();
    return;
  }

  setConnected(true);
  send('auth:restored');
  setStatus('Waiting for current song...');
}

// --- Current song ---------------------------------------------------------

let pollPausedUntil = 0; // set by a 429 from Spotify

async function pollCurrentSong() {
  if (!tokens) return;
  if (Date.now() < pollPausedUntil) return;

  if (Date.now() > tokens.expiresAt - 30000) {
    const session = signOuts;
    try {
      await refreshTokens();
    } catch {
      if (session === signOuts) signOut();
      return;
    }
    if (session !== signOuts) return;
  }

  try {
    const res = await api('/v1/me/player/currently-playing');

    if (res.status === 204) {
      setStatus('Nothing is playing');
    } else if (res.status === 200) {
      const data = await res.json();
      const item = data.item;
      if (!item) {
        setStatus('Nothing is playing');
      } else {
        const artist = item.artists
          ? item.artists.map((a) => a.name).join(', ')
          : (item.show && item.show.name) || 'Unknown';
        setStatus(`${item.name} — ${artist}`);
      }
    } else if (res.status === 401) {
      signOut();
    } else if (res.status === 429) {
      // Rate limited (Retry-After can be hours): stop asking until it passes.
      pollPausedUntil = governor.blocked('/me/player/currently-playing', res.headers.get('retry-after') || 30);
      console.log('[auth] Spotify rate limit - status polling paused for', Math.round((pollPausedUntil - Date.now()) / 1000), 's');
    } else {
      setStatus(`Spotify returned an error (${res.status})`);
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

// --- App lifecycle --------------------------------------------------------

// The Web Playback SDK asks for a token whenever it needs one.
async function accessToken() {
  if (!tokens) return null;
  if (Date.now() > tokens.expiresAt - 30000) {
    try {
      await refreshTokens();
    } catch (err) {
      return null;
    }
  }
  return tokens && tokens.accessToken;
}
ipcMain.handle('get-token', accessToken);

// The page's Web API calls, made here. From the page each one first needs
// a browser "preflight" request (the page is not on Spotify's origin), which
// doubles the requests counting toward Spotify's rate limit; from here there
// is none. The answer goes back as-is: the page handles errors and 429s.
const API_METHODS = new Set(['GET', 'PUT', 'POST', 'DELETE']);
// Every one goes through the governor (spotify-governor.js): `priority`
// 'background' marks work nobody is waiting for. Not sent: a 429 with
// `until` and `by` ('spotify': Spotify asked to wait; 'winify': the caps).
ipcMain.handle('spotify-api', async (_event, method, path, body, priority) => {
  if (!API_METHODS.has(method) || typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('not a Web API request: ' + method + ' ' + path);
  }
  const token = await accessToken();
  if (!token) throw new Error('no access token');
  const go = await governor.admit(path, priority);
  if (!go.ok) return { status: 429, retryAfter: String(Math.max(1, Math.ceil((go.until - Date.now()) / 1000))), until: go.until, by: go.reason, text: '' };
  const res = await fetch('https://api.spotify.com/v1' + path, {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 429) {
    const until = governor.blocked(path, res.headers.get('retry-after'));
    return { status: 429, retryAfter: res.headers.get('retry-after'), until, by: 'spotify', text: await res.text() };
  }
  return { status: res.status, retryAfter: res.headers.get('retry-after'), text: res.status === 204 ? '' : await res.text() };
});

ipcMain.handle('spotify-api:promote', (_event, keys) => governor.promote(Array.isArray(keys) ? keys.map(String) : []));

// ---- The My playlists index, shared by both copies -----------------------
// One file per playlist in the shared folder. Only one copy builds it at a
// time: the one holding index.lock (renewed while it builds; a lock left by
// a copy that quit or stopped renewing is taken over).
const INDEX_DIR = path.join(SHARED_DIR, 'index');
const INDEX_LOCK = path.join(SHARED_DIR, 'index.lock');
const LOCK_STALE_MS = 2 * 60 * 1000;
const indexFile = (uri) => path.join(INDEX_DIR, encodeURIComponent(String(uri)) + '.json');
ipcMain.handle('index:load', () => {
  let names = [];
  try { names = fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith('.json')); } catch (e) { return []; }
  const recs = [];
  for (const f of names) { try { recs.push(JSON.parse(fs.readFileSync(path.join(INDEX_DIR, f), 'utf8'))); } catch (e) { /* half-written: read again later */ } }
  return recs;
});
ipcMain.handle('index:put', (_event, rec) => {
  if (!rec || typeof rec.uri !== 'string') return false;
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  const tmp = indexFile(rec.uri) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec));
  fs.renameSync(tmp, indexFile(rec.uri));
  return true;
});
ipcMain.handle('index:delete', (_event, uri) => { try { fs.rmSync(indexFile(uri), { force: true }); } catch (e) { /* gone */ } return true; });
ipcMain.handle('index:clear', () => { try { fs.rmSync(INDEX_DIR, { recursive: true, force: true }); } catch (e) { /* gone */ } return true; });
// The newest change, so a copy that is not building can tell when to read it again.
ipcMain.handle('index:stamp', () => { try { return fs.statSync(INDEX_DIR).mtimeMs; } catch (e) { return 0; } });
// May this copy build (and keep building)? Claims or renews the lock.
ipcMain.handle('index:claim', () => {
  let lock = null;
  try { lock = JSON.parse(fs.readFileSync(INDEX_LOCK, 'utf8')); } catch (e) { /* none */ }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const ours = lock && lock.pid === process.pid;
  const free = !lock || ours || !alive(lock.pid) || Date.now() - lock.at > LOCK_STALE_MS;
  if (!free) return { builder: false, by: lock.copy };
  fs.mkdirSync(SHARED_DIR, { recursive: true });
  fs.writeFileSync(INDEX_LOCK, JSON.stringify({ pid: process.pid, copy: COPY, at: Date.now() }));
  return { builder: true };
});
function releaseIndexLock() {
  try { const lock = JSON.parse(fs.readFileSync(INDEX_LOCK, 'utf8')); if (lock.pid === process.pid) fs.rmSync(INDEX_LOCK, { force: true }); } catch (e) { /* none */ }
}

// Lyrics come from LRCLIB (lrclib.net). The page cannot set a User-Agent, as
// LRCLIB asks clients to, and its security policy reaches only Spotify, so
// the lookups are made here. Only LRCLIB's two lookup endpoints are allowed.
const LRCLIB = 'https://lrclib.net';
const LRCLIB_PATHS = new Set(['/api/get', '/api/search']);
const LRCLIB_TIMEOUT_MS = 15000;
ipcMain.handle('lrclib', async (_event, path, params) => {
  if (!LRCLIB_PATHS.has(path)) throw new Error('not an LRCLIB lookup: ' + path);
  const res = await fetch(LRCLIB + path + '?' + new URLSearchParams(params), {
    // LRCLIB asks for the app's name, version and a link to its project page.
    headers: { 'User-Agent': 'Winify/' + require('./package.json').version + ' (Spotify player; ' + require('./package.json').homepage + ')' },
    signal: AbortSignal.timeout(LRCLIB_TIMEOUT_MS),
  });
  // Busy (429/503): how long LRCLIB asks clients to wait before trying again.
  if (!res.ok) return { status: res.status, body: null, retryAfter: res.headers.get('Retry-After') };
  return { status: res.status, body: await res.json() };
});

// The main window's A button: always on top, or not (the menu-bar menu sets
// "behind" itself).
ipcMain.on('window-level', (_event, level) => setWindowLevel(level));

// The chassis's now-playing display: "PLAY ON SPOTIFY" opens the track in the
// Spotify app; without the app the link reads "GET SPOTIFY FREE" and opens
// Spotify's download page (Spotify's design guidelines, "Linking to Spotify").
function spotifyAppInstalled() {
  try { return !!app.getApplicationNameForProtocol('spotify://'); } catch (e) { return false; }
}
ipcMain.handle('spotify-app-installed', () => spotifyAppInstalled());
ipcMain.on('open-in-spotify', (_event, uri) => {
  const m = /^spotify:track:([A-Za-z0-9]{22})$/.exec(String(uri || ''));
  if (!spotifyAppInstalled()) { shell.openExternal('https://www.spotify.com/download/'); return; }
  if (m) shell.openExternal('spotify:track:' + m[1]);
});

// Makes the in-app device the active Spotify Connect target.
ipcMain.handle('transfer-playback', async (_event, deviceId, startPlaying) => {
  if (!tokens || !deviceId) return { ok: false, error: 'not connected' };
  try {
    governor.count();                     // playback: first in line, counted
    const res = await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ device_ids: [deviceId], play: startPlaying === true }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 204 || res.status === 202) return { ok: true };
    const body = await res.text();
    return { ok: false, error: `HTTP ${res.status} ${body}`.trim() };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
});

ipcMain.on('webamp-state', (_event, doubled) => {
  webampDoubled = doubled === true;
  buildTray();
});

ipcMain.on('milkdrop-desktop', (_event, on) => {
  milkdropDesktop = on === true;
  buildTray();
});

ipcMain.on('milkdrop-state', (_event, open) => {
  milkdropOpen = open === true;
  buildTray();
});

ipcMain.on('audio-state', (_event, capturing) => {
  capturingAudio = capturing === true;
  buildTray();
});

// macOS's microphone permission, which reading BlackHole needs. Asked for (and
// answered) before capture opens, so capture never races macOS's question
// (the likely reason the packaged app's visualizer once stayed still; not
// proven). The packaged app is ad-hoc signed, so macOS asks again after every
// rebuild.
ipcMain.handle('audio:microphone', async () => {
  if (process.platform !== 'darwin') return 'granted';
  let status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'not-determined') {
    console.log('[audio] asking macOS for microphone access (to read BlackHole)');
    status = (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
  }
  console.log('[audio] microphone access:', status);
  return status;
});

// The setup step: check a pasted Client ID and keep it if Spotify knows it.
ipcMain.handle('client-id:set', async (_event, raw) => {
  const id = String(raw || '').trim();
  const verdict = await checkClientId(id);
  if (verdict === 'ok') {
    if (id !== clientId) {
      tokens = null;
      forgetTokens();   // tokens belong to the app that issued them
    }
    storeClientId(id);
    setStatus('Not logged in');
    console.log('[config] Client ID saved', maskClientId(id));
  }
  return verdict;
});
ipcMain.on('client-id:change', changeClientId);
ipcMain.on('open-setup-guide', () => {
  // Packaged, the README is inside app.asar, which other apps cannot open: a copy.
  let guide = SETUP_GUIDE;
  if (app.isPackaged) {
    guide = path.join(app.getPath('temp'), 'Winify README.md');
    fs.writeFileSync(guide, fs.readFileSync(SETUP_GUIDE));
  }
  shell.openPath(guide).then((err) => { if (err) console.warn('[config] could not open the setup guide:', err); });
});

ipcMain.on('ready', () => {
  // Send the current state once the renderer is listening, so it starts from
  // the truth rather than from whatever events happened before it loaded.
  send('window:visibility', isOnScreen());
  if (setupOnLoad) {
    setupOnLoad = false;
    showSetup();
    return;
  }
  restoreSession();
});
// Click-through: the page says whether the pointer is over something of
// Winify's (the chassis, a Webamp window, one of Winify's own) or over
// nothing. Over nothing, clicks go to whatever is behind; mouse moves keep
// coming (forward) so the page can tell when the pointer is back.
ipcMain.on('window:pass-through', (_event, on) => setPassThrough(on === true));

// What is playing, reported by the window: once signed in, main asks
// Spotify for nothing itself (the one shared poll is the window's).
ipcMain.on('now-playing', (_event, text) => {
  if (tokens) setStatus(String(text).slice(0, 200));
});

// The Winify panel's yellow and red lights, and Webamp's Exit menu item.
ipcMain.on('window-command', (_event, command) => {
  if (command === 'hide') hideWindow();
  if (command === 'minimize' && win && !win.isDestroyed()) win.minimize();
});
ipcMain.on('login', login);
ipcMain.on('cancel-login', cancelAuth);
ipcMain.on('disconnect', signOut);

// The lamp: on stores the refresh token, off wipes it.
ipcMain.on('set-remember', (_event, value) => {
  remember = value === true;
  if (remember) saveTokens();
  else forgetTokens();
});

// Only one Winify at a time. Without this, launching again while one is
// already running starts a rival that loads its own copy of the UI and binds a
// different port -- which has already caused a stale window to be mistaken for
// the current build, and moves the origin that media permissions are keyed to.
// Closing the window only hides it, so a second launch is easy to do by
// accident.
if (!app.requestSingleInstanceLock()) {
  console.log('[app] another Winify is already running - focusing it and exiting');
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('[app] second launch attempted - focusing the existing window');
    showWindow();
  });
}

app.on('will-quit', releaseIndexLock);

app.on('before-quit', () => {
  isQuitting = true;
});

// Widevine ships as a separate component that castLabs' Electron downloads on
// first run. Playback needs it, so wait for it before opening the window and
// say plainly whether it came up -- a silent failure here is the usual way
// DRM playback mysteriously does nothing later.
async function initWidevine() {
  try {
    await components.whenReady();
    console.log('[widevine] ready:', JSON.stringify(components.status()));
    return true;
  } catch (err) {
    console.error('[widevine] FAILED to initialise:', err && err.message);
    console.error('[widevine] the app will still run, but audio playback will not work');
    return false;
  }
}

app.whenReady().then(async () => {
  // Winify's own icon in the Dock and app switcher, not Electron's.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')));
  }
  loadClientId();
  loadWindowLevel();
  if (!clientId) console.log('[config] no Spotify Client ID yet - the sign-in screen asks for one');

  await initWidevine();
  try {
    await startAppServer();
  } catch (err) {
    console.error('[app] could not start local server:', err && err.message);
    return;
  }

  // Surface any permission the page is denied -- a silently refused
  // encrypted-media request would look exactly like our playback failure.
  // Audio capture needs the media permission granted; without a handler the
  // request can be denied silently and look like a capture bug.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media' || permission === 'audioCapture') {
      console.log('[audio] granting', permission, 'permission');
      callback(true);
      return;
    }
    callback(true);
  });

  if (DRM_DEBUG) {
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      console.log('[drm] PERMISSION REQUEST', permission, '-> granted');
      callback(true);
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => {
      console.log('[drm] PERMISSION CHECK', permission, '-> granted');
      return true;
    });
  }

  enableLoopbackAudio();
  createWindow();
  createTray();
});

// Deliberately empty: the app lives on in the menu bar with no window open.
app.on('window-all-closed', () => {});

app.on('activate', showWindow);
