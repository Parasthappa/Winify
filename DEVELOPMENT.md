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

## Milkdrop

Webamp's own Milkdrop window, drawn by Butterchurn (`butterchurn` and
`butterchurn-presets`, the versions Webamp 2.3.1 was built with). Both load
from `node_modules` the first time the window opens; nothing goes over the
network. Butterchurn compiles each preset's equations to WebAssembly, which
is why the page's security policy allows `'wasm-unsafe-eval'` (WebAssembly
compilation only, not JavaScript `eval`).

Presets you add go through `milkdrop-convert-worker.js`. `.milk` files are
split with `milkdrop-preset-utils`; their equations stay as Milkdrop wrote
them (Butterchurn compiles them to WebAssembly), and their HLSL shaders are
converted to GLSL with `milkdrop-preset-converter` (hlslparser). That
converter predates Butterchurn 3 and fails on a fair share of MilkDrop 2
shaders (some built-in functions, the `rad` input, some vector operations),
so each converted preset is test-loaded into a hidden Butterchurn and skipped
if its equations or shaders do not compile. (Webamp's own `.milk` support
converts shaders on a remote server instead, which Winify does not use.)

The converter's loader builds code from text, which the page's policy
forbids, so it runs in a worker served with a policy of its own (`main.js`,
`WORKER_CSP`): its own scripts only, code-from-text allowed, no network.

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

## The window

Winify is one frameless, transparent window over the main display's usable
area (`main.js`, `homeArea`): no frame, no shadow, not resizable. Only the
chassis, the Webamp windows and Winify's own windows are drawn in it.

- **Click-through.** The window starts out ignoring the mouse
  (`setIgnoreMouseEvents(true, { forward: true })`); `window-passthrough.js`
  switches it off while the pointer is over an element (the full-window
  layers and the chassis's own box take no pointer events; the chassis's SVG
  outline does, so its angled edges count) or a button is held, and on again
  otherwise. Where the pointer is comes from forwarded mouse moves and, since
  those stop arriving once another app or the desktop is active, from the
  main process reading it every 60 ms while Winify is on screen
  (`watchCursor`; only changes are sent, and it looks again on show, restore,
  focus changes and display changes). `acceptFirstMouse` lets a click on a
  Winify window act even while another app is in front. Search and the
  picker have full-window backdrops, so while they are open a click outside
  closes them instead.
- **One display.** A window cannot span displays: Winify uses the main
  display (the one with the menu bar) and refits when displays change.
- **Full screen** (Milkdrop): a transparent window cannot use macOS's own
  full screen (it is `fullscreenable: false`; toggling it under simple full
  screen crashes AppKit). On `enter-html-full-screen` the window goes into
  simple full screen, covering the whole display, and back after.
- **Positions** are screen positions (the layout's `screen` flag); a layout
  saved by the old fitted window opens centred, where that window used to.
- The yellow and red lights on the chassis, and Webamp's minimize and close
  buttons, send `minimize` and `hide` (`window-command`); minimized and
  hidden both count as off screen for the visualizers.

## Project layout

| File | Purpose |
|---|---|
| `main.js` | Main process: sign-in, Client ID, tokens, menu bar, local server, LRCLIB lookups |
| `preload.js` | The bridge between the main process and the page |
| `index.html` | The sign-in screen and the player view |
| `winify.js` | The chassis: sign-in state, rendering, its place on screen |
| `window-passthrough.js` | Click-through for the see-through window |
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
| `webamp-room.js` | Grew a fitted app window for those; nothing to do in the see-through window |
| `webamp-inert.js` | Keeps Webamp controls with no Spotify meaning quiet |
| `webamp-vis.js` | Feeds Webamp's visualizer from the audio capture |
| `webamp-milkdrop.js` | Webamp's Milkdrop window, drawn by Butterchurn from the audio capture; its menu, keys and the VIZ button |
| `webamp-milkdrop-presets.js` | Presets you add: converted, test-loaded, kept in IndexedDB |
| `milkdrop-convert-worker.js` | Turns .milk and .json files into Butterchurn presets, off the page |
| `drm-debug.js` | DRM diagnostics, inactive unless `--drm-debug` |

Playback goes through `window.WinifyPlayer` (`play()`, `pause()`,
`nextTrack()`, `previousTrack()`, `setVolume()`, `getVolume()`, `seek()`), so
the interface can change without touching playback.
