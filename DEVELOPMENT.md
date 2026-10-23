# Developing Winify

Notes for working on Winify itself. To install and use it, see
[README.md](README.md).

## Running from source

Follow the README's setup, then `npm start`.

For development, the Spotify Client ID can come from a gitignored `.env` file
instead of the sign-in screen:

```bash
cp .env.example .env
```

and set `SPOTIFY_CLIENT_ID=` in it (or export `SPOTIFY_CLIENT_ID` in your
shell). A Client ID saved on the sign-in screen (`config.json` in the app's
user-data folder) takes precedence. Never commit a Client ID.

Winify uses the Authorization Code flow with PKCE, so no Client Secret is
read or stored. The redirect URI is fixed at `http://127.0.0.1:8888/callback`.

## Why the Electron build is special

Spotify's audio is protected (Widevine DRM), which stock Electron cannot play.
Winify depends on castLabs' Electron build, which includes Widevine. Spotify's
licence server also checks a Verified Media Path (VMP) signature on the
Electron binary; the prebuilt castLabs binaries carry only a development
signature, so each installation is signed with castLabs' free EVS service
(README, step 3).

An unsigned binary looks like this: sign-in and device registration work, a
queue loads, then each track is abandoned after a second or two while the
licence request (`.../widevine-license/v1/audio/license`) returns HTTP 500.
`verify-pkg` confirms the signature.

Spotify does not list Electron as a supported platform for the Web Playback
SDK, so this setup is unsupported by Spotify even when it works.

To log DRM diagnostics (licence traffic, media-pipeline events and EME key
status, including inside the SDK's iframe):

```bash
npm start -- --drm-debug
```

## Spotify API limits that shape the design

- **Development Mode** (2026): Premium required, one Client ID per developer,
  a small cap on authorized users. Hence every user brings their own app.
- **Playlist contents** are readable only for playlists the user owns or
  collaborates on. Others show Spotify's Up Next instead.
- **The queue** can be read (about 20 items) and appended to, but not
  reordered or cleared. Winify's own play order queues its next track about
  30 seconds before the current one ends (late queueing leaves a gap).
- **Autoplay** starts only when an album or playlist runs out, never after a
  lone track; "Play track" therefore plays the track within its album.
- **Rate limits** are per app and endpoint and can last hours. Winify backs
  off on HTTP 429 and keeps polling low; tests against a real account should
  use as few requests as possible.

## System audio capture

The visualizers analyse the audio leaving the Mac, because Spotify's audio
cannot be read from the Web Playback SDK and Spotify's audio-analysis
endpoints are restricted.

Electron's native loopback capture (`setDisplayMediaRequestHandler` with
`audio: 'loopback'`) would need no driver, but on macOS the track arrives
already ended, so no samples arrive (see
[electron/electron#52738](https://github.com/electron/electron/issues/52738)).
This was the case with every combination of the relevant Chromium feature
flags, with stock and castLabs Electron. It has not been tried in a packaged,
Developer ID-signed and notarized app, which macOS may treat differently;
worth retesting when Winify is packaged. Until then, BlackHole provides the
loopback (README, "Optional: the visualizer").

## Permissions requested

| Scope | Why |
|---|---|
| `user-read-private` | Check the account is Premium |
| `user-read-email` | Required by the Web Playback SDK |
| `streaming` | Play audio through the in-app device |
| `user-read-playback-state` | Read what is playing |
| `user-read-currently-playing` | Show the current track |
| `user-modify-playback-state` | Play, pause, skip, seek, queue |
| `playlist-read-private` | List the user's playlists and their tracks |
| `playlist-read-collaborative` | List collaborative playlists' tracks |
| `user-library-read` | List Liked Songs |

If a new scope is added, a stored session without it is discarded at launch
and the sign-in screen asks to sign in again.

## Project layout

| File | Purpose |
|---|---|
| `main.js` | Main process: sign-in, Client ID, tokens, menu bar, local server, LRCLIB lookups |
| `preload.js` | The bridge between the main process and the page |
| `index.html` | The sign-in screen and the player view |
| `winify.js` | The sign-in screen's state and rendering |
| `player.js` | Web Playback SDK wiring (`window.WinifyPlayer`) |
| `audio-source.js` | System-audio capture for the visualizers |
| `renderer.js` | Player view wiring |
| `webamp-ui.js` | Mounts the Winamp interface (Webamp) and its layout |
| `webamp-spotify.js` | Connects Webamp's controls and display to Spotify |
| `webamp-playlist.js` | The playlist window, Winify's play order, the header row |
| `webamp-picker.js` | The playlist picker |
| `webamp-search.js` | Jump to track |
| `webamp-lyrics.js` | The lyrics window and the LYRIC button |
| `webamp-dialog.js` | Placement, dragging and tooltips for Winify's own windows |
| `webamp-room.js` | Grows the app window while one of them is open |
| `webamp-inert.js` | Keeps Webamp controls with no Spotify meaning quiet |
| `webamp-vis.js` | Feeds Webamp's visualizer from the audio capture |
| `drm-debug.js` | DRM diagnostics, inactive unless `--drm-debug` |

Playback goes through `window.WinifyPlayer` (`play()`, `pause()`,
`nextTrack()`, `previousTrack()`, `setVolume()`, `getVolume()`, `seek()`), so
the interface can change without touching playback.
