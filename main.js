const { app, BrowserWindow, Menu, Tray, components, desktopCapturer, dialog, ipcMain, nativeImage, session, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

// Winify ships with no credentials. Every user registers their own Spotify
// app and supplies its Client ID through a gitignored .env file, or through a
// SPOTIFY_CLIENT_ID environment variable. See README.md.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // No .env file -- an environment variable may still supply the Client ID.
}

const CLIENT_ID = (process.env.SPOTIFY_CLIENT_ID || '').trim();

// Loopback audio capture is behind Chromium feature flags on macOS, and they
// have to be set before the app is ready. Without them getDisplayMedia rejects
// the audio: 'loopback' constraint outright.
app.commandLine.appendSwitch('enable-features', [
  'MacLoopbackAudioForScreenShare',
  'MacSckSystemAudioLoopbackOverride',
  'MacCatapSystemAudioLoopbackCapture',
].join(','));

// PKCE is used, so no Client Secret is required and none is read.

const SETUP_HELP = [
  'Winify needs your own Spotify Client ID.',
  '',
  '1. Create an app at https://developer.spotify.com/dashboard',
  '2. Add this Redirect URI, exactly:',
  '     http://127.0.0.1:8888/callback',
  '3. Copy .env.example to .env and put your Client ID in it',
  '',
  'Alternatively, set SPOTIFY_CLIENT_ID in your environment before launching.',
  '',
  'Full instructions are in README.md.',
].join('\n');

function reportMissingClientId() {
  console.error('\n[config] SPOTIFY_CLIENT_ID is not set.\n');
  console.error(SETUP_HELP + '\n');
  dialog.showErrorBox('Winify: Spotify Client ID missing', SETUP_HELP);
}
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPES = [
  'user-read-private', // required for the Premium check on /v1/me
  'user-read-email', // the Web Playback SDK expects this alongside user-read-private
  'streaming', // required to play audio through the in-app device
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
];
const POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;
// How long we'll wait for you to finish in the browser before giving up.
const AUTH_TIMEOUT_MS = 180000;

// The four handshake lines the sign-in screen shows, in order.
const STEP_HANDSHAKE = 0;
const STEP_TOKEN = 1;
const STEP_PREMIUM = 2;
const STEP_LIBRARY = 3;

let win;
let tokens = null; // { accessToken, refreshToken, expiresAt }
let pollTimer = null;
let authServer = null;
let authTimer = null;
let remember = false; // mirrors the "remember me" lamp
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
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

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
        res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-store' });
        res.end(data);
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      appServer = server;
      appOrigin = `http://127.0.0.1:${server.address().port}`;
      console.log('[app] serving from', appOrigin, '(was file://)');
      resolve(appOrigin);
    });
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setStatus(text) {
  send('status', text);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 940,
    backgroundColor: '#08090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Chromium throttles timers in hidden/occluded windows, which starves
      // the playback SDK's buffering and causes stalls and skipped tracks.
      // This window is meant to be tucked away, so throttling must be off.
      backgroundThrottling: false,
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
    win.hide();
  });

  win.on('show', buildTray);
  win.on('hide', buildTray);

  // Audio capture is diagnosed from the terminal, so its logs are mirrored
  // there always -- not only under --drm-debug, where they used to hide.
  win.webContents.on('console-message', (event) => {
    const text = (event && event.message) || '';
    if (DRM_DEBUG) return; // the debug path already mirrors everything
    if (text.startsWith('[winify/audio]')) console.log(text);
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

function attachDrmDebug(win) {
  const t0 = Date.now();
  const stamp = () => '+' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const dbg = win.webContents.debugger;

  try {
    dbg.attach('1.3');
  } catch (err) {
    console.error('[drm] could not attach debugger:', err && err.message);
    return;
  }
  // Bump this whenever the diagnostics change, so a capture can never be
  // mistaken for one produced by an older, still-running instance.
  console.log('[drm] diagnostics ON - build DIAG-3 (http origin + cross-origin frame capture)');

  // Mirror the renderer's console into this terminal so the EME hooks, the SDK
  // errors and the licence traffic all land in one transcript.
  win.webContents.on('console-message', (event) => {
    const text = (event && event.message) || '';
    if (/^\[(drm|winify)/.test(text)) console.log(`[renderer] ${stamp()} ${text}`);
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
        console.log(`[drm] ${stamp()} ATTACHED to ${info.type} ${String(info.url || '').slice(0, 100)}`);
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
        if (text) console.log(`[drm] ${stamp()} SDK CONSOLE [${params.type}] ${text.slice(0, 400)}`);
        return;
      }
      if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails || {};
        console.log(`[drm] ${stamp()} SDK EXCEPTION ${(d.exception && d.exception.description || d.text || '').slice(0, 400)}`);
        return;
      }
      if (method === 'Log.entryAdded') {
        const e = params.entry || {};
        if (e.level === 'error' || /licen|drm|eme|key|media/i.test(e.text || '')) {
          console.log(`[drm] ${stamp()} BROWSER LOG [${e.level}] ${String(e.text).slice(0, 400)} ${String(e.url || '').slice(0, 120)}`);
        }
        return;
      }

      if (method === 'Network.requestWillBeSent') {
        const url = params.request.url;
        if (isInteresting(url)) {
          inflight.set(params.requestId, url);
          if (isLicence(url)) console.log(`[drm] ${stamp()} LICENCE REQUEST ${params.request.method} ${url.slice(0, 160)}`);
        }
      } else if (method === 'Network.responseReceived') {
        const url = inflight.get(params.requestId);
        if (!url) return;
        const st = params.response.status;
        if (isLicence(url)) {
          console.log(`[drm] ${stamp()} LICENCE RESPONSE ${st} ${params.response.statusText || ''} ${url.slice(0, 160)}`);
        } else if (st >= 400) {
          console.log(`[drm] ${stamp()} SEGMENT/API ${st} ${url.slice(0, 160)}`);
        }
      } else if (method === 'Network.loadingFinished') {
        const url = inflight.get(params.requestId);
        if (url && isLicence(url)) {
          try {
            const body = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }, sessionId);
            const text = body.base64Encoded
              ? `<binary licence blob, ${Buffer.from(body.body, 'base64').length} bytes>`
              : String(body.body).slice(0, 500);
            console.log(`[drm] ${stamp()} LICENCE BODY ${text}`);
          } catch (err) {
            console.log(`[drm] ${stamp()} LICENCE BODY unavailable: ${err && err.message}`);
          }
        }
        inflight.delete(params.requestId);
      } else if (method === 'Network.loadingFailed') {
        const url = inflight.get(params.requestId);
        if (url) {
          console.log(`[drm] ${stamp()} REQUEST FAILED ${params.errorText} ${url.slice(0, 160)}`);
          inflight.delete(params.requestId);
        }
      } else if (method === 'Media.playerErrorsRaised') {
        for (const e of params.errors || []) {
          console.log(`[drm] ${stamp()} MEDIA ERROR ${JSON.stringify(e).slice(0, 800)}`);
        }
      } else if (method === 'Media.playerEventsAdded') {
        for (const e of params.events || []) {
          const v = String(e.value || '');
          if (v) console.log(`[drm] ${stamp()} MEDIA EVENT ${v.slice(0, 500)}`);
        }
      } else if (method === 'Media.playerPropertiesChanged') {
        for (const pr of params.properties || []) {
          console.log(`[drm] ${stamp()} MEDIA PROP ${pr.name}=${String(pr.value).slice(0, 200)}`);
        }
      }
    } catch (err) {
      console.error('[drm] handler error:', err && err.message);
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

function showWindow() {
  if (!win || win.isDestroyed()) return;
  win.show();
  win.focus();
}

function buildTray() {
  if (!tray) return;
  const visible = win && !win.isDestroyed() && win.isVisible();

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: connected ? 'Connected' : 'Not connected', enabled: false },
    { type: 'separator' },
    {
      label: visible ? 'Hide Winify' : 'Show Winify',
      click: () => (visible ? win.hide() : showWindow()),
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
      label: 'Quit Winify',
      accelerator: 'Command+Q',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

function createTray() {
  // Template image: black + alpha, so macOS recolours it for the menu-bar theme.
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Winify');
  buildTray();
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

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// Routes a real failure to one of the screen's two designed error states.
function failAuth(kind) {
  cancelAuth();
  stopPolling();
  tokens = null;
  forgetTokens();
  setConnected(false);
  send('auth:error', kind);
}

function signOut() {
  cancelAuth();
  stopPolling();
  tokens = null;
  forgetTokens();
  setStatus('Not logged in');
  setConnected(false);
  send('auth:signed-out');
}

async function requestToken(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Token request failed (${res.status})`);
  const data = await res.json();
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

function api(pathname) {
  return fetch(`https://api.spotify.com${pathname}`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

// --- Login (Authorization Code with PKCE) ---------------------------------

function login() {
  cancelAuth();
  stopPolling();
  tokens = null;

  if (!CLIENT_ID) {
    setStatus('No Spotify Client ID configured - see README.md');
    reportMissingClientId();
    send('auth:error', 'network');
    return;
  }

  const verifier = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  // Step 0: listener up, browser opening, waiting for you to approve.
  send('auth:step', STEP_HANDSHAKE);
  authTimer = setTimeout(() => failAuth('network'), AUTH_TIMEOUT_MS);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, REDIRECT_URI);
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }

    const code = url.searchParams.get('code');
    const ok = code && url.searchParams.get('state') === state;
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

  server.listen(8888, '127.0.0.1', () => {
    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
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
    failAuth('network');
    return;
  }

  // Step 2: the real Premium check.
  send('auth:step', STEP_PREMIUM);
  let profile;
  try {
    const res = await api('/v1/me');
    if (!res.ok) throw new Error(`Profile request failed (${res.status})`);
    profile = await res.json();
  } catch {
    failAuth('network');
    return;
  }

  if (profile.product !== 'premium') {
    failAuth('free-account');
    return;
  }

  // Step 3: first real read of what's playing.
  send('auth:step', STEP_LIBRARY);
  await pollCurrentSong();

  setConnected(true);
  send('auth:connected');
  startPolling();
}

// Runs at launch: a stored refresh token skips the sign-in screen entirely.
async function restoreSession() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
  } catch {
    return; // No stored session; the sign-in screen stays up.
  }

  if (!saved || !saved.refreshToken || !CLIENT_ID) return;

  const granted = String(saved.scope || '').split(' ');
  const missing = SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length) {
    console.log('[auth] stored session is missing scopes:', missing.join(', '), '- re-login required');
    forgetTokens();
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
  startPolling();
}

// --- Current song ---------------------------------------------------------

async function pollCurrentSong() {
  if (!tokens) return;

  if (Date.now() > tokens.expiresAt - 30000) {
    try {
      await refreshTokens();
    } catch {
      signOut();
      return;
    }
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
    } else if (res.status !== 429) {
      setStatus(`Spotify returned an error (${res.status})`);
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

function startPolling() {
  stopPolling();
  pollCurrentSong();
  pollTimer = setInterval(pollCurrentSong, POLL_MS);
}

// --- App lifecycle --------------------------------------------------------

// The Web Playback SDK asks for a token whenever it needs one.
ipcMain.handle('get-token', async () => {
  if (!tokens) return null;
  if (Date.now() > tokens.expiresAt - 30000) {
    try {
      await refreshTokens();
    } catch (err) {
      return null;
    }
  }
  return tokens.accessToken;
});

// Makes the in-app device the active Spotify Connect target.
ipcMain.handle('transfer-playback', async (_event, deviceId, startPlaying) => {
  if (!tokens || !deviceId) return { ok: false, error: 'not connected' };
  try {
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

ipcMain.on('ready', restoreSession);
ipcMain.on('login', login);
ipcMain.on('cancel-login', cancelAuth);
ipcMain.on('disconnect', signOut);

// The lamp: on stores the refresh token, off wipes it.
ipcMain.on('set-remember', (_event, value) => {
  remember = value === true;
  if (remember) saveTokens();
  else forgetTokens();
});

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
  // Say so immediately rather than letting the first sign-in attempt fail
  // with a misleading connection error.
  if (!CLIENT_ID) reportMissingClientId();

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
