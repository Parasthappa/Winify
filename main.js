const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // No .env file; login reports the missing Client ID.
}

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPES = [
  'user-read-private', // required for the Premium check on /v1/me
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
    },
  });
  // Demo hook preserved: `npm start -- --outcome=network` (or free-account)
  // replays the designed simulation instead of touching the real API.
  const flag = process.argv.find((a) => a.startsWith('--outcome='));
  const outcome = flag ? flag.slice('--outcome='.length) : '';
  win.loadFile(path.join(__dirname, 'index.html'), outcome ? { search: `outcome=${outcome}` } : undefined);

  // Closing the window tucks the app away rather than quitting it; the
  // menu-bar item is how you bring it back or quit for real.
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
  });

  win.on('show', buildTray);
  win.on('hide', buildTray);
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
      label: visible ? 'Hide Spotamp' : 'Show Spotamp',
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
      label: 'Quit Spotamp',
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
  tray.setToolTip('Spotamp');
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
  };
  saveTokens();
}

function refreshTokens() {
  return requestToken({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
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
    setStatus('Missing SPOTIFY_CLIENT_ID in .env');
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

app.whenReady().then(() => {
  createWindow();
  createTray();
});

// Deliberately empty: the app lives on in the menu bar with no window open.
app.on('window-all-closed', () => {});

app.on('activate', showWindow);
