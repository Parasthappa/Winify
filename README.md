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

### 3. Install dependencies

```bash
npm install
```

This pulls in castLabs' Widevine-enabled Electron build rather than stock
Electron. Spotify's audio is DRM-protected, and stock Electron cannot decrypt
it.

### 4. Sign the Electron binary (required for audio)

**Without this step audio will not play.** Sign-in and device registration will
work, then every track will skip after a second or two, and the licence request
will fail with `HTTP 500`.

Spotify's licence server validates the Verified Media Path (VMP) signature on
the Electron binary. The prebuilt castLabs binaries carry only a development
signature, which the production licence server rejects. Signing with castLabs'
EVS service fixes it. An EVS account is free.

```bash
python3 -m pip install --upgrade castlabs-evs
```

```bash
python3 -m castlabs_evs.account signup
```

Signup asks for an email address, your name, an organization, an account name
and a password, then emails a confirmation code. The password must contain a
symbol character, along with upper case, lower case and a digit — signup fails
with `InvalidPasswordException` otherwise.

Then sign the Electron distribution that `npm install` placed in
`node_modules`:

```bash
python3 -m castlabs_evs.vmp sign-pkg node_modules/electron/dist
```

Check it worked:

```bash
python3 -m castlabs_evs.vmp verify-pkg node_modules/electron/dist
```

A signed binary reports `Signature is valid: streaming` and a validity period
of a few years.

> **Re-sign after every `npm install` that reinstalls Electron.** The signature
> lives inside `node_modules`, which is not tracked by git and is replaced
> wholesale on reinstall. If playback suddenly starts skipping again, run
> `verify-pkg` first — an unsigned binary is the usual cause.

### 5. Run

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

## Troubleshooting playback

Audio plays inside Winify once the Electron binary is VMP-signed (step 4
above). If tracks skip after a second or two, the signature is almost always
the cause:

```bash
python3 -m castlabs_evs.vmp verify-pkg node_modules/electron/dist
```

The symptom of an unsigned binary is specific: the device registers fine, a
queue loads, and then each track is abandoned almost immediately while the
licence request returns `HTTP 500`:

```
POST https://api.spotify.com/v1/widevine-license/v1/audio/license  ->  500
```

Note that Spotify does not list Electron as a supported platform for the Web
Playback SDK, so this setup is unsupported by Spotify even when it works.

To capture DRM diagnostics — licence traffic, media-pipeline events and EME
key-status changes, including inside the SDK's cross-origin iframe:

```bash
npm start -- --drm-debug
```

This is off by default.

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

**Tracks skip after a second** — the Electron binary is not VMP-signed. See
[Troubleshooting playback](#troubleshooting-playback).

**Signed out unexpectedly** — your stored token was rejected. Sign in again; if
it persists, use **Disconnect** from the menu bar to clear it.
