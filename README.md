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
3. Press **Play** in the Winamp window. Winify takes over your current Spotify
   session, or starts your Liked Songs if there is nothing to resume. You can
   also pick Winify from the device list in the Spotify app.

The Winamp controls drive Spotify: Play, Pause, Stop (pauses), Next,
Previous, the seek bar, volume, Shuffle and Repeat. Balance, the equalizer
and Eject have no Spotify equivalent and do nothing.

The playlist window lists the album or playlist being played, with the
current track highlighted; double-click a track to play it. Spotify only lets
apps read the contents of playlists you own or collaborate on, so for any
other playlist, and for Liked Songs, artists and radio, it shows the current
track and Spotify's Up Next queue instead. When an album or playlist runs out
and Spotify's Autoplay carries on, the list switches to Autoplay's queue,
labelled "Autoplay".

To switch playlists, press **Eject** (in the main window or the playlist
window), or choose **LIST OPTS > load list**. Pick Liked Songs or any of your
playlists; type to filter. It plays from track 1. Escape closes it.

To find any track, press **J** (or right-click the main window, **Play >
Jump to track...**, or use the menu bar). Type to search Spotify. **Enter** or
double-click plays just that track (Spotify's Autoplay, if on, carries on
after it); **Shift+Enter** or right-click **Add to queue** queues it without
interrupting what is playing. Right-click also offers **Play album** (from
that track) and **Play artist**. Right-click a
track in the playlist window to queue it too. Winify never changes your
playlists.

The playlist window's **ADD** button opens the same search as **ADD TO
QUEUE** (shown in its title): there Enter and double-click queue the track
and the window stays open for more, while Shift+Enter or right-click > Play
plays it.

For the current track's lyrics, press the **I** button on the main window's
left edge, **Option+3** (Winamp's Alt+3), or **MISC > FILE INF** in the
playlist window. The window follows track changes and is reopened at launch
if you left it open. Lyrics from [LRCLIB](https://lrclib.net).

Close (x) and Exit hide the Winify window and minimize (_) minimizes it, as
the window's own buttons do. Controls with no Spotify equivalent (balance,
the equalizer, adding or removing files, saving lists) do nothing.

**Remember me** stores your refresh token so you stay signed in between
launches. Leave it off and nothing is written to disk.

Winify keeps a menu-bar item showing connection status, with Show/Hide,
Disconnect and Quit. Closing the window hides it rather than quitting.

## System audio capture (for the visualizers)

The visualizers run frequency analysis on the audio actually leaving your
speakers. This is necessary rather than preferred: Spotify's audio is
DRM-protected, so its waveform cannot be read from the Web Playback SDK, and
Spotify's audio-analysis and beat-data endpoints were restricted in late 2024.

Playback works without any of this. Only the visualizers need it.

Capture starts by itself when the player appears and stops when you sign out;
the menu bar's Start/Stop audio capture controls it by hand. Click the
visualizer to switch between spectrum bars, oscilloscope and off. It shows
whatever your Mac is playing, not only Spotify, and it pauses drawing while
Winify's window is hidden. Without a loopback device it simply stays empty.

While capture runs, macOS shows its orange microphone indicator: it does so
for any audio input, BlackHole included. Winify does not record you.

### macOS: BlackHole + a Multi-Output Device

macOS has no built-in way for an app to read its own system output, so a
virtual loopback device is needed.

```bash
brew install blackhole-2ch
```

**Reboot after installing** — the installer says so, and the driver will not
appear until you do.

Then split your audio so it reaches both your ears and Winify:

1. Open **Audio MIDI Setup** (Applications → Utilities)
2. Click **+** at the bottom left → **Create Multi-Output Device**
3. Tick **both** your speakers/headphones **and** BlackHole 2ch
4. Set your speakers as the **Master Device** (clock drift is referenced to it)
5. Tick **Drift Correction** on the BlackHole row, not the speakers row
6. **System Settings → Sound → Output** → select the Multi-Output Device

Winify detects the loopback device by name and will log which one it picked:

```
using device: BlackHole 2ch (Virtual) (system loopback)
```

If it instead says `(NOT a loopback device - this hears the room, not the app)`
it fell back to your microphone, which means the Multi-Output Device is not the
current output.

> **This breaks your macOS volume keys.** macOS cannot control the volume of an
> aggregate device, so the volume keys and the menu-bar slider stop working
> while a Multi-Output Device is your output. Set volume inside Winify instead,
> or switch your output back to your speakers when you are not using the
> visualizers. This is a limitation of Multi-Output Devices, not of Winify.

If you only ever hear silence after switching, your speakers are probably not
ticked in the Multi-Output Device — it is easy to tick only BlackHole, which
has no hardware behind it.

### Why a driver is needed at all

Electron can capture system audio natively via `setDisplayMediaRequestHandler`
with `audio: 'loopback'`, which would need no driver and no user setup. On
macOS it does not currently work: the audio track is created, correctly
labelled `System audio`, and is already in `readyState: 'ended'` the first time
it is observed, so no samples ever arrive. See
[electron/electron#52738](https://github.com/electron/electron/issues/52738).

This was tested thoroughly before falling back to a driver. Ruled out: every
combination of the `MacLoopbackAudioForScreenShare`,
`MacSckSystemAudioLoopbackOverride` and `MacCatapSystemAudioLoopbackCapture`
feature flags; both `loopback` and `loopbackWithMute`; `useSystemPicker` true
and false; stock Electron as well as the castLabs build, which fail
identically; and an invalid code signature, which was repaired without changing
the result. macOS 15.6.1, which is new enough for the Core Audio tap API.

One variable remains untested: a packaged application with a real Developer ID
signature and notarization. Every test above ran unpackaged with an ad-hoc
identity and no Team ID, and macOS may treat a properly identified app
differently. Worth retesting when the app is packaged for release — if it
works, the BlackHole requirement disappears.

## Permissions requested

| Scope | Why |
|---|---|
| `user-read-private` | Check the account is Premium |
| `user-read-email` | Required by the Web Playback SDK |
| `streaming` | Play audio through the in-app device |
| `user-read-playback-state` | Read what is playing |
| `user-read-currently-playing` | Show the current track |
| `user-modify-playback-state` | Play, pause, skip, seek |
| `playlist-read-private` | List your playlists, and the tracks in your private ones |
| `playlist-read-collaborative` | List the tracks in collaborative playlists |
| `user-library-read` | List Liked Songs |

If Winify gains a permission after you signed in, the sign-in screen says
**NEW PERMISSIONS · SIGN IN AGAIN** at launch; signing in once grants it.

Separately, macOS will ask once for **microphone** access the first time you
start audio capture. Winify reads the loopback device as an ordinary audio
input, which is what that permission covers; it does not record you. Before the
app is packaged the prompt names *Electron* rather than Winify.

## Project layout

| File | Purpose |
|---|---|
| `main.js` | Electron main process: auth, token storage, menu bar, local server |
| `preload.js` | The IPC bridge exposed to the renderer |
| `index.html` | The sign-in screen and the app view |
| `winify.js` | The sign-in screen's own state and rendering engine |
| `player.js` | Web Playback SDK wiring; playback commands on `window.WinifyPlayer` |
| `renderer.js` | App view wiring |
| `webamp-ui.js` | Mounts the Winamp interface (Webamp) |
| `webamp-spotify.js` | Connects Webamp's controls and display to Spotify |
| `webamp-playlist.js` | Fills the playlist window from the current Spotify context |
| `webamp-picker.js` | The playlist picker (Eject, LIST OPTS > load list) |
| `webamp-search.js` | Jump to track: search, play within album, add to queue |
| `webamp-room.js` | Grows the window while a Winify dialog is open |
| `webamp-dialog.js` | Placement, dragging, snapping and tooltips for Winify's own windows |
| `webamp-inert.js` | Keeps controls with no Spotify meaning quiet |
| `webamp-vis.js` | Feeds Webamp's visualizer from the system-audio capture |
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
