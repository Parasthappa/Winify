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

Every line it writes goes through `drm-redact.js`: queries are cut from web
addresses, and tokens, codes and long opaque strings are hidden (checked by
`test/app/drm-redact.test.js`).

## Packaging

`npm run package` (`packaging/build.js`) builds `dist/mac-arm64/Winify.app`
and `dist/Winify-1.0.0.dmg` with electron-builder, from the castLabs Electron
in `node_modules/electron/dist` (`electronDist`: copied, never changed; arm64
only, as that Electron is). Bundle ID `app.winify.player`.

Signing order, as castLabs requires on macOS: electron-builder packages,
`packaging/vmp-sign.js` (afterPack) runs `sign-pkg --force` on the folder
holding Winify.app (without `--force` it keeps the copied development
signature), then signs ad-hoc with `codesign --deep --sign -`
(electron-builder looks for an identity "-" in the keychain and skips it, so
its own signing is off). `packaging/vmp-verify.js` (afterSign) runs
`verify-pkg` and `codesign --verify`, and the build fails if either fails.
No hardened runtime: it would refuse the Widevine module downloaded at first
launch. Each build is a new ad-hoc signature, so macOS asks for microphone
(and screen-recording) access again after every build. Capture waits for
that answer (`audio:microphone` in `main.js`, asked from `audio-source.js`),
so capture never races macOS's question. That race is the likely reason the
packaged app's visualizer once stayed still, then moved on a later launch
(31 Oct 2026); it was never reproduced or proven. To check
capture in a packaged build without Spotify: `npm run package -- --test
test/package/capture.js`.

The packaged app keeps its settings in `Application Support/Winify App`
(`main.js`, `PACKAGED_FOLDER`), apart from the development copy's `winify`
(the Mac's disk ignores case, so `Winify` would be the same folder). It
serves its page on ports 8909-8913, the development copy on 8899-8903
(`APP_PORTS`): the page's storage (layout, mixes, the playlist index)
belongs to its port, so the two running at once would otherwise push one
onto the next port and an empty store. Sign-in is the same for both: the
callback server on 8888 (`REDIRECT_URI`), one sign-in at a time.

Shipped in `Contents/Resources`: `LICENSE.winify.txt`,
`THIRD_PARTY_NOTICES.md`, Electron's `LICENSE` (as `LICENSE.electron.txt`)
and `LICENSES.chromium.html`. Not shipped: `.env`, the tests and the notes.

Testing the packaged app: the smoke test runs inside Winify's own process,
which a packaged app does not allow from outside, so
`npm run package -- --test <entry>` builds the same app (same binary,
signatures, bundle ID and settings folder) starting at a test instead, into
`dist/test.noindex`. Never for sharing.

```bash
npm run package -- --test test/smoke/smoke.js
SMOKE_OUTPUT=test/.output dist/test.noindex/mac-arm64/Winify.app/Contents/MacOS/Winify
```

The smoke test then uses the packaged app's own sign-in (open Winify.app,
sign in with Remember me, quit it first). `test/package/loopback.js` is the
native system-audio capture retest, run the same way.

`npm run package:check` builds and runs `test/package/check.js`: the
packaged app's own checks, offline (Spotify and LRCLIB faked inside it):
its port range, the remembered sign-in, kbps and kHz, the version label, each
side panel level with the column, the playlist picker, a mix and its Remix, a lyrics lookup
through the LRCLIB route with its User-Agent, and sign-in through the 8888
callback. `npm test` cannot see these: it runs main.js in the development
Electron, unpackaged (the development copy's ports and settings folder), so
anything that differs only when packaged needs this. Run it after
`npm run package`, before handing a build to anyone.

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
- **Rate limits** are per app and endpoint and can last hours (31 Oct 2026:
  `QUOTA_EXCEEDED`, Retry-After 40966 s, after two copies each built a
  ~743-request index while the picker re-read 553 playlists). Tests against
  a real account should use as few requests as possible.

### The request governor

Every Winify Web API request goes through `spotify-governor.js` in the main
process (the page's via the `spotify-api` route; sign-in's and the status
read are counted). Caps over both copies together (they share one Client
ID): everything 30 a minute and 300 an hour; things you do (search, a
playlist chosen) 24 and 240; background work (the index, the picker's list
read nobody is waiting for) 10 and 150. Playback (`/me/player...`) and
sign-in are first in line and wait only for the hard caps; things you do are
refused with "until when" rather than left waiting over 20 s; background
work waits for what is left. The picker promotes its queued list requests
when it is opened. A 429 blocks that endpoint for both copies until its
Retry-After, also across restarts: nothing is sent there meanwhile, and the
page says "Spotify asked Winify to wait until 00:25".

What both copies share lives in `Application Support/Winify Shared`
(`WINIFY_SHARED_DIR` overrides it; the test runner gives each suite its own):
`requests-dev.json` and `requests-packaged.json` (each copy's last hour),
`blocks.json` (Spotify's waits), `index/` (the My playlists index, one file
per playlist) and `index.lock` (the copy building it, renewed before each
playlist; taken over when that copy quits or stops renewing). The other
copy reads what is saved and re-reads it when it changes. An index a copy
built on its own before (its page's IndexedDB) is moved in the first time.

The index is not built by itself: playlists go in as the playlist window
reads them (opened or played: no extra request), and "Build full index"
(menu bar, Jump to track) reads the rest as background work, pausable,
remembered across launches until done. For this library a full build is
about 756 requests (the list, Liked Songs, 297 playlists in pages of 50),
about five hours of Winify running within the background caps. The
playlist list is kept for three days (or REFRESH). The menu bar shows both
copies' requests in the last hour and today (`day-<copy>.json`).

## System audio capture

The visualizers analyse the audio leaving the Mac, because Spotify's audio
cannot be read from the Web Playback SDK and Spotify's audio-analysis
endpoints are restricted.

Electron's native loopback capture (`setDisplayMediaRequestHandler` with
`audio: 'loopback'`) would need no driver, but on macOS the track arrives
already ended, so no samples arrive (see
[electron/electron#52738](https://github.com/electron/electron/issues/52738)).
This was the case with every combination of the relevant Chromium feature
flags, with stock and castLabs Electron. Retested in the packaged, ad-hoc
signed Winify.app (30 Oct 2026, `test/package/loopback.js`): macOS's picker
returns a screen but the stream has no audio track at all. A Developer
ID-signed, notarized app is still untested (no developer membership).
BlackHole provides the loopback (README, "Optional: the visualizer").

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
  Winify window act even while another app is in front.
- **One display.** A window cannot span displays: Winify uses the main
  display (the one with the menu bar) and refits when displays change.
- **Full screen** (Milkdrop): a transparent window cannot use macOS's own
  full screen (it is `fullscreenable: false`; toggling it under simple full
  screen crashes AppKit). On `enter-html-full-screen` the window goes into
  simple full screen, covering the whole display, and back after.
- **Positions** are screen positions (the layout's `screen` flag); a layout
  saved by the old fitted window opens at the default spot (the left edge,
  centred top to bottom, leaving room beside it for the side panels).
- The yellow and red lights on the chassis, and Webamp's minimize and close
  buttons, send `minimize` and `hide` (`window-command`); minimized and
  hidden both count as off screen for the visualizers.

## Project layout

| File | Purpose |
|---|---|
| `main.js` | Main process: sign-in, Client ID, tokens, menu bar, local server, LRCLIB lookups |
| `preload.js` | The bridge between the main process and the page |
| `spotify-governor.js` | The request governor: caps, priorities and Spotify's waits, for both copies |
| `index.html` | The sign-in screen and the player view |
| `winify.js` | The chassis: sign-in state, rendering, its place on screen |
| `window-passthrough.js` | Click-through for the see-through window |
| `player.js` | Web Playback SDK wiring (`window.WinifyPlayer`) |
| `audio-source.js` | System-audio capture for the visualizers |
| `renderer.js` | Player view wiring |
| `credits.js` | The About box's thanks |
| `webamp-ui.js` | Mounts the Winamp interface (Webamp) and its layout |
| `webamp-brand.js` | Webamp as served to the page: Winify's name in its text, and its default skin's title bars and logos from `assets/brand/` |
| `webamp-spotify.js` | Connects Webamp's controls and display to Spotify |
| `webamp-playlist.js` | The playlist window, Winify's play order, the header row |
| `webamp-picker.js` | The playlist picker |
| `webamp-search.js` | Jump to track |
| `webamp-library-index.js` | "My playlists" search: a local index of your playlists and Liked Songs, kept on this Mac |
| `webamp-lyrics.js` | The lyrics window and the LYRIC button |
| `webamp-dialog.js` | Dragging, resizing and tooltips for Winify's own windows |
| `webamp-frame.js` | The panels' frame (Webamp's generic window, as Milkdrop's) and consistent cursors |
| `webamp-skin.js` | The side panels follow the loaded skin: colours and font with a contrast check, frames, titles |
| `webamp-panels.js` | The side panels (picker, search, lyrics, Milkdrop): default stack, remembered placements, Escape |
| `webamp-inert.js` | Keeps Webamp controls with no Spotify meaning quiet |
| `webamp-ontop.js` | Always on top: the main window's A button |
| `webamp-mix.js` | Random mix: the Wi logo makes a temporary shuffled mix from your own playlists |
| `webamp-vis.js` | Feeds Webamp's visualizer from the audio capture; draws the small visualizer itself while Milkdrop is open |
| `webamp-milkdrop.js` | Webamp's Milkdrop window, drawn by Butterchurn from the audio capture; its menu, keys and the VIZ button |
| `webamp-milkdrop-presets.js` | Presets you add: converted, test-loaded, kept in IndexedDB |
| `milkdrop-desktop.html` | Milkdrop's desktop mode: the wallpaper window's page (drawn into from webamp-milkdrop.js) |
| `milkdrop-convert-worker.js` | Turns .milk and .json files into Butterchurn presets, off the page |
| `drm-debug.js` | DRM diagnostics, inactive unless `--drm-debug` |
| `drm-redact.js` | Keeps tokens and signed links out of the DRM diagnostics |
| `packaging/` | `npm run package`: the build, VMP and ad-hoc signing, verification; `brand-art.js` makes `assets/brand/` |

Playback goes through `window.WinifyPlayer` (`play()`, `pause()`,
`nextTrack()`, `previousTrack()`, `setVolume()`, `getVolume()`, `seek()`), so
the interface can change without touching playback.
