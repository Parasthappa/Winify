# Winify

A Winamp-styled desktop player for Spotify, built with Electron.

Winify signs you in with your own Spotify account and registers itself as a
Spotify Connect device, so audio plays from Winify rather than from the Spotify
app.

> **Requires Spotify Premium.** The Spotify Web Playback SDK does not work with
> free accounts.

## Setup

Winify ships with no credentials. You register your own Spotify application and
supply its Client ID — this takes a couple of minutes and is free.

### 1. Register a Spotify app

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   and sign in.
2. Click **Create app**. Give it any name and description.
3. Under **Redirect URIs**, add this value **exactly**:

   ```
   http://127.0.0.1:8888/callback
   ```

   It must match character for character, including the port and the `http`
   scheme. `localhost` instead of `127.0.0.1` will not work.
4. Select **Web API** and **Web Playback SDK** as the APIs you intend to use.
5. Save, then open the app's settings and copy its **Client ID**.

You do **not** need the Client Secret. Winify uses the Authorization Code flow
with PKCE, which is designed for apps that cannot keep a secret, so none is
requested or stored.

### 2. Configure Winify

```bash
cp .env.example .env
```

Open `.env` and paste your Client ID:

```
SPOTIFY_CLIENT_ID=your_client_id_here
```

`.env` is gitignored and will not be committed.

Alternatively, set it in your environment instead of using a file:

```bash
export SPOTIFY_CLIENT_ID=your_client_id_here
```

### 3. Install and run

```bash
npm install
```

```bash
npm start
```

The first launch is slower than usual: Electron downloads the Widevine CDM,
which is required to decrypt Spotify's audio.

If the Client ID is missing, Winify tells you so on startup with a dialog and a
message in the terminal rather than failing with a vague connection error.

## Using it

1. Click **Continue with Spotify** and approve access in your browser.
2. Winify appears as a Spotify Connect device named **Winify**.
3. Start a track on any Spotify client, then click **Transfer playback here** —
   or pick Winify from the device list in the Spotify app.

**Remember me** stores your refresh token so you stay signed in between
launches. Leave it off and nothing is written to disk.

Winify keeps a menu-bar item showing connection status, with Show/Hide,
Disconnect and Quit. Closing the window hides it rather than quitting.

## Permissions requested

| Scope | Why |
|---|---|
| `user-read-private` | Check the account is Premium |
| `user-read-email` | Required by the Web Playback SDK |
| `streaming` | Play audio through the in-app device |
| `user-read-playback-state` | Read what is playing |
| `user-read-currently-playing` | Show the current track |
| `user-modify-playback-state` | Play, pause, skip, seek |

## Project layout

| File | Purpose |
|---|---|
| `main.js` | Electron main process: auth, token storage, menu bar, local server |
| `preload.js` | The IPC bridge exposed to the renderer |
| `index.html` | The sign-in screen and the app view |
| `winify.js` | The sign-in screen's own state and rendering engine |
| `player.js` | Web Playback SDK wiring; playback commands on `window.WinifyPlayer` |
| `renderer.js` | App view wiring |
| `drm-debug.js` | EME instrumentation, inert unless debugging |

Playback is driven through `window.WinifyPlayer` — `play()`, `pause()`,
`togglePlay()`, `nextTrack()`, `previousTrack()`, `setVolume()`, `seek()` — so
the interface can be replaced without touching playback logic.

## Known limitation: audio playback

Spotify's licence server currently rejects playback licence requests from
Winify with `HTTP 500`, so tracks skip after a moment instead of playing.

Sign-in, device registration, Widevine initialisation and the Spotify Web API
all work. The failure is isolated to the final licence request:

```
POST https://api.spotify.com/v1/widevine-license/v1/audio/license  ->  500
```

This is a known issue with Widevine-enabled Electron builds. Spotify's
production licence server validates the Verified Media Path (VMP) signature on
the application binary, and prebuilt castLabs Electron binaries carry only a
development signature. Resolving it requires packaging the app and VMP-signing
it through castLabs' EVS service.

Note also that Spotify does not list Electron as a supported platform for the
Web Playback SDK.

To capture diagnostics:

```bash
npm start -- --drm-debug
```

This logs licence traffic, media-pipeline events and EME key-status changes. It
is off by default.

## Licence

MIT. See [LICENSE](LICENSE).

Winify is an independent project and is not affiliated with, endorsed by, or
sponsored by Spotify or Winamp. Spotify is a trademark of Spotify AB; Winamp is
a trademark of its respective owner. You need your own Spotify account and your
own registered Spotify application to use this software.

## Troubleshooting

**`INVALID_CLIENT: Invalid redirect URI`** — the Redirect URI in your Spotify
app settings does not exactly match `http://127.0.0.1:8888/callback`.

**Sign-in hangs** — something else may be using port 8888.

**Tracks skip after a second** — the licence issue described above.

**Signed out unexpectedly** — your stored token was rejected. Sign in again; if
it persists, use **Disconnect** from the menu bar to clear it.
