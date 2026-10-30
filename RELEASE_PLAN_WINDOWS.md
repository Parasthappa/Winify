# Winify 1.1 release plan: Windows

Winify 1.0 is Mac-only. 1.1 brings it to Windows 10 and 11. Same rules as 1.0
(see RELEASE_PLAN.md): personal use plus the source on GitHub, free and
non-commercial, everyone brings their own Spotify Client ID, no public
download of a built app. A built installer may be DM'd to friends.

Written 31 Oct 2026 from reading the code, not from running anything on
Windows. Everything marked **TEST** is a guess that only the Windows PC can
confirm. Nothing here has been tried yet.

Every session: check here which stage we are in, and tick items off as they
are done (with the commit, where there is one).

## What carries over, what changes, what cannot work

### Should work as it is

The player itself is a web page, so these need no change (still TEST once on
Windows): Webamp and its skins, the Spotify sign-in (PKCE, the
`http://127.0.0.1:8888/callback` redirect), the Web Playback SDK and Widevine
playback, play order, mixes, playlist search and the index (IndexedDB),
lyrics (LRCLIB), Milkdrop and its presets, the playlist picker and Jump to
track, saved settings (they move to `%APPDATA%\Winify`, which Electron picks
by itself), the single-instance lock, and the settings and token files.

### Needs Windows-specific changes

| Area | Mac now | Windows |
|---|---|---|
| **castLabs Electron + VMP** | `node_modules/electron/dist` is signed with `sign-pkg`; packaging signs VMP **before** Apple's `codesign` | Same Electron package (`npm install` downloads the Windows build itself). In a packaged app the order is **reversed**: Authenticode first, VMP **after** (castLabs: "on Windows the VMP-signing needs to take place AFTER the code-signing, or things will break"). `sign-pkg` is given the folder holding the `.exe`. Python is `py -3`, not `python3`. |
| **System audio (the visualizers)** | Electron's loopback capture delivers silence on macOS, so BlackHole plus a Multi-Output Device is needed | **Probably no extra software.** Windows has a built-in system-audio loopback (WASAPI), and Electron's `setDisplayMediaRequestHandler` with `audio: 'loopback'` is supported there. Winify already asks for it (`main.js`, `enableLoopbackAudio`). **TEST:** that it delivers the music and not silence, that Widevine-protected audio is captured, and what it does with the audio device you play through. The BlackHole code (`audio-source.js`) stays as the Mac path. Fallback if it fails: "Stereo Mix" or VB-Cable, which the device-name pattern already half-knows. |
| **See-through window, click-through** | One transparent frameless window over the work area; `setIgnoreMouseEvents(true, { forward: true })` | Electron supports both on Windows, including forwarded mouse moves. **TEST:** that clicks pass through empty parts, that it works at 125% and 150% display scaling, with two monitors of different scaling, and that the GPU stays quiet (transparent windows are costlier on Windows). Winify uses only the main display, as on Mac. |
| **Always on top** | `setAlwaysOnTop(true, 'floating')` | Works; Windows ignores the level name, so it is one "topmost" level. It will sit above normal windows but below the taskbar's own layer unless we ask for `'screen-saver'`. **TEST:** behaviour over full-screen games and video. |
| **Behind other apps** | A window level one below normal windows | **No such level in Electron on Windows.** Needs a native call, `SetWindowPos(HWND_BOTTOM)` on the window handle (`win.getNativeWindowHandle()`), through a small native module (for example `koffi`) or a helper. Catch: clicking the window activates it and Windows brings it forward. Stopping that means a non-activating window, which cannot take typing (search, filter). Likely compromise: send it to the bottom again on blur, or make it click-through except on its own panels. **TEST; riskiest of the window features.** |
| **Milkdrop Desktop Mode** | A window at macOS's desktop level (behind icons and all windows) | Windows has no desktop level either. The known technique (used by live-wallpaper apps) is to parent the window into the `WorkerW` window behind the desktop icons, via native calls (`FindWindow` Progman, send `0x052C`, `SetParent`). Works on Windows 10 and 11 but is fragile, and Windows 11 24H2 is reported to have changed how it behaves (**TEST**). Needs the same native module as above. **TEST.** If it fails, the fallback is a plain full-screen window at the bottom of the stack, which is not "behind the icons". |
| **Full-screen Milkdrop** | `setSimpleFullScreen` (macOS only) | Use `setBounds` to the display plus topmost, or `setFullScreen`. Electron's docs warn that transparent windows and full screen do not mix well on Windows. **TEST.** |
| **Menu bar vs tray** | A menu-bar icon (template image) is the only menu; the Dock icon; `Cmd+H` hide/unhide events; `Cmd+Q` | A **system tray** icon (bottom right, often hidden under the `^` overflow) with the same menu, shown by right-click; left-click should show or hide Winify. Needs a `.ico` and a normal-colour icon (template images are Mac-only). There is **no global menu bar**, so everything now in the menu-bar menu stays in the tray menu. The window also gets a **taskbar button**: decide whether to keep it (my suggestion: yes, so minimize works as users expect) or hide it (`skipTaskbar`). `app.dock` and the `NSApplication` hide events are skipped on Windows; hide/minimize already report visibility through the window's own events. Quit: `CmdOrCtrl+Q` or `Alt+F4`. |
| **Keyboard** | Cmd+Z undoes a skip; Cmd-click adds to a selection; some `metaKey` checks | Ctrl takes Cmd's place everywhere. Places that test `metaKey` only: Cmd+Z in `webamp-playlist.js`, one in `webamp-inert.js`. Cmd-click in the picker already accepts Ctrl. Key names in README and tooltips change by platform. Backspace and Delete both skip a row today; keep. **TEST** Webamp's own keys (Z X C V B, arrows) and typing into the search boxes. |
| **Packaging** | `electron-builder` mac target, ad-hoc `codesign`, `.dmg` | NSIS installer (or a portable `.zip`), x64 first. **No Authenticode certificate** (they cost money), so the order becomes: build, VMP-sign the folder holding `Winify.exe` (nothing else signed first), then installer. If we ever add an Authenticode certificate it goes **before** the VMP step. Friends see SmartScreen's "Windows protected your PC": More info, then Run anyway. **TEST:** that VMP still verifies after the installer unpacks (an installer that rewrites the exe would break it). |
| **Tests** | 36 suites; two use macOS tools (`window-layers.swift`, `afplay`, `lsappinfo`) | The mock suites run in Electron and are mostly portable. **TEST:** which fail on Windows for harmless reasons (path separators, `Meta` vs `Control` in key events). The window-level and desktop-mode suites need Windows versions (read the window's z-order with `GetWindowLong`/PowerShell instead of Swift). The smoke test is portable once audio capture works. |

### Will not work (or only partly)

- **Cmd+H, the Dock, the app menu bar, macOS Spaces and Mission Control**
  have no Windows counterpart. Windows has virtual desktops; the window will
  live on one of them unless we pin it (`SetWindowPos` plus the virtual
  desktop API, which is undocumented and breaks between Windows versions;
  not planned).
- **"Behind other apps" and "Desktop Mode" as exact copies** of the Mac
  behaviour. Windows gives us workarounds, not the same feature (see the
  table); they may land in 1.1 as "best effort" or slip to 1.2.
- **Equalizer and balance through Winify's own audio.** Spotify's audio is
  decrypted inside Widevine and goes straight to the speakers, so Winify
  cannot process it on either system. The Windows answer is Equalizer APO
  (next section), which is a system-wide effect.
- **Apple-specific permissions text** (the microphone message) does not
  apply; Windows asks nothing for loopback capture. Windows' own
  Settings, Privacy, Microphone switch only matters if we fall back to a
  capture device.
- **A notarized-style trusted installer.** Without a paid Authenticode
  certificate every download shows SmartScreen's warning.

## The equalizer and balance, through Equalizer APO

**Feasible: yes, with a catch.** [Equalizer APO](https://sourceforge.net/projects/equalizerapo/)
is a free, open-source system-wide equalizer for Windows. It sits in
Windows' audio pipeline and reads a plain-text configuration file. Winify
can write that file from Webamp's EQ window, and the sound changes. I could
not confirm from the docs how quickly it re-reads the file; the common
description is "immediately when the file is saved". **TEST.**

**What the user installs, once:**

1. Equalizer APO (from SourceForge), choosing the playback device(s) they
   use in its Configurator. This installs an audio driver component, needs
   administrator rights and a restart.
2. Nothing else. Winify finds it by its install folder (registry key
   `HKLM\SOFTWARE\EqualizerAPO`, or the default
   `C:\Program Files\EqualizerAPO`) and says plainly if it is missing.

**How Winify controls it:**

- The EQ window's 10 sliders, preamp and on/off, and the balance slider,
  become a small text file Winify owns, in `%APPDATA%\Winify\winify-eq.txt`,
  for example:
  `Preamp: -3 dB`, `GraphicEQ: 60 2; 170 0; ...` (or ten `Filter` lines),
  and for balance `Channel: L` / `Preamp: -2 dB` / `Channel: all`.
  Webamp's sliders are 0 to 100 around 50; mapping to decibels (about ±12) is
  to be confirmed against Webamp's own EQ code.
- Equalizer APO's `config.txt` needs one line, `Include: <that file>`. The
  folder is write-protected by default, so adding it takes one administrator
  prompt. Winify would show the exact line to add, or offer to add it once
  (UAC). The rest of the time Winify writes only to its own folder, no admin.
- Writes are debounced (for example 200 ms after the last slider move).
- If the file cannot be written or the line is missing, the EQ button says
  "Equalizer APO not set up" and the README's section explains the steps.

**The catch, to be honest in the README and the tooltip:**

- It equalizes **everything the PC plays**, not only Spotify. Winify's
  on/off switch must remove its settings completely when off or when Winify
  quits (or leave them, user's choice; default: remove on quit).
- It only affects devices selected in the Configurator, and does not work
  with every device (some Bluetooth and exclusive-mode setups). **TEST** on
  the PC's actual output.
- **TEST:** whether the visualizer hears the equalized or the plain sound
  (depends on where Windows takes the loopback copy).
- Equalizer APO is a third-party driver; Winify only writes a text file and
  never installs it. Not affiliated, credited in THIRD_PARTY_NOTICES.md.
- Balance: Equalizer APO has no "balance" command; it is done with
  per-channel preamps. This is fine for stereo; surround setups are ignored.

## Setting up the Windows PC

Do these on the Windows machine (PowerShell). Nothing here is tried yet.

1. **Install:**
   - Windows 10 or 11, up to date, 64-bit (x64; ARM Windows is untested).
   - **Node.js**, the same major version as on the Mac (v24.18.0 there; `npm`
     only runs the scripts, Electron brings its own Node).
   - **Git for Windows**.
   - **Python 3.9 or newer**, ticking "Add to PATH" (the launcher is `py -3`).
   - **Visual Studio Build Tools** only if a native module must be compiled
     (the `koffi` option below ships ready-made binaries, so probably not).
   - Spotify Premium and **your Spotify Client ID** (the same app works; add
     nothing: the redirect URI is the same).
2. **Get the project:**
   ```powershell
   git clone https://github.com/<you>/<repo>.git Winify
   cd Winify
   npm install
   ```
   `npm install` downloads the Windows build of castLabs' Electron by itself
   (`github:castlabs/electron-releases#v44.1.0+wvcus`). Never copy
   `node_modules` from the Mac: it holds the Mac binary.
3. **Your Client ID:** copy `.env.example` to `.env` and paste it in, or
   enter it in Winify's first-run screen.
4. **EVS signing** (the free castLabs service; the same account as on the
   Mac, no new sign-up):
   ```powershell
   py -3 -m pip install --upgrade castlabs-evs
   py -3 -m castlabs_evs.account signup      # only the first time; or: ... account login
   py -3 -m castlabs_evs.vmp sign-pkg node_modules\electron\dist
   py -3 -m castlabs_evs.vmp verify-pkg node_modules\electron\dist
   ```
   You should see "Signature is valid". Run `sign-pkg` again after every
   `npm install`. In automation add `--no-ask` (or set `EVS_NO_ASK`) so an
   expired token does not wait for a password. **TEST:** whether `sign-pkg`
   accepts the Windows `dist` folder as it does the Mac one (castLabs says
   the command is not platform-specific).
5. **Run:** `npm start`. First start downloads the Widevine component (needs
   the internet). Also run `npm test -- picker` once to see which suites
   already pass.
6. **Visualizer:** nothing to install if native loopback works (Stage 1).
   If not, VB-Cable or Stereo Mix is the fallback.
7. **Equalizer (later, Stage 5):** install Equalizer APO.

## Stages

Riskiest first: each stage ends with a decision, because a failure in an
early stage changes what the later ones are.

### 1. Does it run at all? (one evening on the Windows PC)

Done means, each with a short written result:

- [ ] `npm install`, `sign-pkg`, `verify-pkg`, `npm start` work on Windows;
      Winify opens (castLabs Electron + Widevine downloaded).
- [ ] Sign-in works (Client ID, browser round trip to
      `http://127.0.0.1:8888/callback`).
- [ ] **Playback passes the 10-second check** (the VMP signature is accepted
      by Spotify on Windows). If not: stop and find out why before anything
      else.
- [ ] Native system-audio loopback is tried (a small test in the style of
      `test/package/loopback.js`): does it deliver the music? Does it need
      anything? The answer replaces "BlackHole" for Windows in the README.
- [ ] The see-through window and click-through work, at 100%, 125% and 150%
      scaling, and with a second monitor if there is one.
- [ ] A list of everything that is visibly wrong or missing, as the input to
      stage 2 (screenshots in `test/.output/`, not committed).

### 2. Make the code platform-aware

Done means:

- [ ] One small module (`platform.js` in the page, an equivalent in the main
      process) answers "which OS?", "which modifier key?" and "what do we
      call it?", so the rest of the code asks it instead of checking
      `navigator.platform` or `process.platform` in many places.
- [ ] Mac-only code (`app.dock`, `NSApplication` notifications,
      `setSimpleFullScreen`, template tray image, `Command+Q`) is guarded or
      replaced; the Mac behaves exactly as before (the full Mac suite still
      passes, and one Mac smoke run).
- [ ] Ctrl replaces Cmd on Windows: Ctrl+Z (undo skip), Ctrl-click and
      Shift-click (picker), `CmdOrCtrl+Q`. Text in the README and in
      tooltips follows the platform.
- [ ] A tray icon (`.ico` and a coloured PNG) with the same menu; left-click
      shows or hides; the taskbar decision is made and written down.
- [ ] Tests that read macOS facts are marked Mac-only; the rest pass on
      Windows (`npm test` on the PC, results listed).

### 3. Window magic on Windows (riskiest after stage 1)

Done means each works, is tested on the PC, or is dropped with a written
reason:

- [ ] Always on top.
- [ ] Full-screen Milkdrop (bounds plus topmost; it must leave cleanly).
- [ ] Behind other apps, with the native call; decide how clicks behave.
- [ ] Milkdrop Desktop Mode via `WorkerW`; if it fails on this PC's Windows
      version, ship Windows without it and say so in the README.
- [ ] Hidden or minimized still stops all drawing; closing leaves nothing
      behind (no stuck wallpaper window after a crash: check on next start).
- [ ] New Windows versions of the window-level tests (and the old Mac ones
      untouched).

### 4. Package for Windows

Done means:

- [ ] `npm run package` builds an NSIS installer (and a `.zip`) on Windows,
      app name Winify, version 1.1.0, Winify's icon (`.ico`), its own app ID.
- [ ] Order inside the build: package, (Authenticode, only if a certificate is
      ever added), **then** VMP-sign the folder holding `Winify.exe`, then
      `verify-pkg`; the build fails if verification fails. (The Mac build is
      unchanged and keeps its order.)
- [ ] Electron's LICENSE and `LICENSES.chromium.html`, and
      THIRD_PARTY_NOTICES.md, are inside the install.
- [ ] Installed, Winify appears as "Winify" in the Start menu, taskbar and
      Task Manager (not "Electron"); uninstall removes it and leaves the
      settings folder alone (and says so).
- [ ] The installed app passes the same checks as the Mac one: first launch
      (Client ID, sign-in, Widevine download), playback, Next and Previous,
      the chassis, lyrics, both visualizers, mixes, search.
- [ ] Smoke test run against the installed app.
- [ ] README: "Opening a copy someone sent you" for Windows (SmartScreen:
      More info, Run anyway).

### 5. Equalizer and balance (Equalizer APO)

Done means:

- [ ] A tiny experiment first: write `winify-eq.txt` by hand, `Include` it,
      and confirm the sound changes and how fast, and what the visualizer
      does. If this fails, stage 5 is dropped and the EQ stays "not
      available" with the reason.
- [ ] Winify finds Equalizer APO (and says if it is missing or not set up);
      writes the file from the EQ window and balance slider; removes its
      settings on off and on quit.
- [ ] The "affects the whole PC" warning is in the EQ window's tooltip and
      the README.
- [ ] Tests against the mocks (the file Winify writes for given slider
      values; no Equalizer APO needed to run them), plus a by-hand check on
      the PC.

### 6. Docs and the release

Done means:

- [ ] README has a Windows section: requirements, setup (the steps above),
      what is different (tray, Ctrl), the visualizer without BlackHole (if
      confirmed), Equalizer APO, what is not available, troubleshooting
      (songs skip after a second: re-run `sign-pkg` after `npm install`;
      empty visualizer; SmartScreen).
- [ ] DEVELOPMENT.md has the Windows notes (signing order, native module,
      tests).
- [ ] THIRD_PARTY_NOTICES.md names Equalizer APO and any native module.
- [ ] The full suite passes on the Mac **and** on the Windows PC; one smoke
      run on each.
- [ ] Tag v1.1.0 on GitHub; release notes; source only, no installer
      attached (as decided for 1.0).

## What to decide and what to test, in one list

Unsure, to test on the PC (stage in brackets):

1. Does Spotify accept the VMP signature on Windows, and does it still verify
   after the installer? (1, 4)
2. Does native loopback deliver the music, including protected audio? (1)
3. Does click-through behave with display scaling and several monitors? (1)
4. Can "behind other apps" be done without the window jumping forward on a
   click? (3)
5. Does the `WorkerW` trick work on this Windows version? (3)
6. Transparent window plus full screen. (3)
7. Equalizer APO: reload speed, device support, what the visualizer hears,
   and the one-time administrator step. (5)
8. Which of the 36 suites pass on Windows unchanged. (2)
9. Whether the taskbar button should stay. (2, a design decision)
10. Windows on ARM: not planned; x64 only for 1.1.
