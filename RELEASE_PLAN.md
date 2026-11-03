# Winify 1.0 release plan

Winify 1.0 is a Mac-only release on GitHub. Windows comes later, as 1.1.

What "release" means (decided 25 Oct 2026): personal use, plus the source
code on GitHub. Free and non-commercial; everyone who builds it brings their
own Spotify Client ID. No public download of a built app, so no Apple
developer membership (no notarizing) and no signed build for others.

Every session: check here which stage we are in, and tick items off as they
are done (with the commit, where there is one).

## 1. Wrap up: done (25 Oct 2026)

Done means:

- [x] The random mixes are committed, after the full test suite and a smoke
      run against the real Spotify both pass (805df73).
- [x] The stray junk file from commit ad77644 is removed.
- [x] The test mix "25 Oct, 7:17" is gone from the saved mixes (checked:
      it had already been deleted).
- [x] The project has been checked for leftovers, scratch files and anything
      personal, and the findings have been listed for the user to decide on.
- [x] This plan exists, and CLAUDE.md points to it.

## 2. Check the rules: researched and decided (25 Oct 2026)

Done means a short written answer (with links) for each of these, saying
what Winify 1.0 may do, what it must include and what it must not do:

- [x] castLabs: fine. Electron for Content Security is MIT-licensed
      ([LICENSE](https://github.com/castlabs/electron-releases/blob/master/LICENSE)).
      EVS is a free service for "production Widevine/VMP signing of
      application packages derived from official releases"
      ([EVS wiki](https://github.com/castlabs/electron-releases/wiki/EVS));
      no published terms restrict distributing a signed app. The Widevine
      module is not bundled: the app downloads it from Google on first launch
      ([README](https://github.com/castlabs/electron-releases#readme)).
      With no public download (see the top), castLabs' confirmation for
      distributing a signed build is not needed: everyone who builds Winify
      signs their own copy with their own free EVS account, as the README
      describes.
- [x] Spotify: needs changes, and one risk to accept or clear
      ([Developer Policy](https://developer.spotify.com/policy),
      [Developer Terms](https://developer.spotify.com/terms),
      [Design guidelines](https://developer.spotify.com/documentation/design)).
      Policy III.11 forbids products that "mimic, or replicate or attempt to
      replace a core user experience of Spotify" without written permission;
      Winify is a full player, though it adds its own value (skins,
      visualizers, lyrics, mixes). Fine: non-commercial, Premium only, each
      user's own Client ID, the name (doesn't begin with "Spot").
- [x] Winamp: needs a change (disclaimer; tagline). "Winamp" is Winamp
      Group's trademark; Webamp says the Winamp name and interface "are
      surely property of Nullsoft"
      ([Webamp README](https://github.com/captbaritone/webamp#license)).
- [x] Licences: fine. Everything Winify ships is MIT, except
      @assemblyscript/loader (Apache-2.0, also compatible). The default skin's
      artwork (Nullsoft) and the Milkdrop presets (many community authors)
      aren't covered by those licences: credited in THIRD_PARTY_NOTICES.md.
- [x] LRCLIB: fine, with two small changes. The API "is openly accessible to
      all users and applications", no key needed
      ([API docs](https://lrclib.net/docs)).
- [x] THIRD_PARTY_NOTICES.md and the README's "Not affiliated" section:
      approved; committed with the cover art.
- [x] Any change the answers call for is listed below, before stage 3 starts.

Changes the rules call for (before publishing):

- [x] Show the current track's cover art while playing (Spotify Policy II.5:
      "no playback of Spotify Content without showing relevant cover art and
      metadata"): the chassis's now-playing display.
- [x] Attribute Spotify content with the Spotify logo, at least 70 px
      (Policy II.4.1; Design guidelines, "Attribute with the Spotify logo"):
      Spotify's white full logo, 77 px wide on screen, with its clear space.
- [x] Link song details back to Spotify ("OPEN SPOTIFY" / "PLAY ON SPOTIFY")
      (Policy II.4.2; Design guidelines, "Linking to Spotify"): "PLAY ON
      SPOTIFY" opens the track in the Spotify app ("GET SPOTIFY FREE" without
      it).
- [x] Replace the tagline "SPOTIFY & WINAMP REMASTERED": Spotify's
      guidelines say "Don't use the Spotify brand together with any other
      brand". ("BUILT FOR SPOTIFY PREMIUM" and "Continue with Spotify" are
      fine: "suggesting to users that it is 'for Spotify' is acceptable.")
      Now "Make Your Player Yours Again".
- [x] LRCLIB: wait as long as its Retry-After says before asking again
      (was a fixed 2 s).
- [x] LRCLIB: add the project's GitHub link to Winify's User-Agent, once the
      repository exists (stage 5).
- [x] Ship THIRD_PARTY_NOTICES.md, Electron's LICENSE and
      LICENSES.chromium.html with the packaged app (stage 4).

Decisions (25 Oct 2026):

- [x] Spotify III.11 (replicating Spotify's core experience): risk accepted
      at this level: personal use and source code, free, non-commercial,
      each user with their own Client ID, no public download.
- [x] Spotify III.13 (visualizers), III.5 and III.6 (lyrics, visuals that
      move with the music), and the default skin showing "WINAMP": no change
      asked for; kept, at the same level, with the README's disclaimer.

## 3. Finish the window magic: done (30 Oct 2026)

Done means each works, has tests against the mocks, and is in the README:

- [x] Always on top: Winify can stay above other apps (on or off, remembered).
      The main window's A button (e4c1ba7).
- [x] Behind other apps: Winify can sit on the desktop under other windows
      (on or off, remembered). The menu-bar menu (a306e2d).
- [x] Milkdrop Desktop Mode: Milkdrop can fill the desktop behind
      everything, as Winamp's Desktop Mode did, and leave it again.
- [x] Existing window behaviour still works: dragging, clicks passing
      through, panels, the sign-in panel's lights, hide and show.

## 4. Package (for the user's own use)

Done means:

- [x] Winify.app is built from the project with one command, and opens from
      Finder like any app.
- [x] Its name is "Winify" everywhere: the menu bar, Finder, the Dock, the
      app switcher and Activity Monitor (not "Electron").
- [x] It has Winify's icon in Finder and the Dock.
- [x] It is VMP-signed with the user's own EVS account, after any other
      signing step that changes the app, so Spotify plays in the packaged app.
      Apple: ad-hoc signing only (no developer membership, no notarizing).
- [x] THIRD_PARTY_NOTICES.md, Electron's LICENSE and LICENSES.chromium.html
      are inside the app.
- [x] Sign-in, playback, the visualizers and lyrics work from the built app
      (the smoke test, run against it, 3 Nov 2026; LRCLIB was down for that run,
      so lyrics were checked by the user in the app).
- [x] Native system-audio capture is retested in the packaged app, to see
      whether BlackHole is still needed. The answer, either way, goes in the
      README's visualizer setup. Still needed: no audio track (30 Oct 2026).
- No public download. A .dmg DM'd to a friend is fine (no Apple signing, so
  they open it once via Privacy & Security > Open Anyway).

## 5. Publish (the source code): done (3 Nov 2026)

Done means:

- [x] The README is ready for strangers: what Winify is, how to build and
      run it from the source (Node, the castLabs Electron, their own EVS
      signing and Spotify Client ID), the visualizer setup, troubleshooting,
      privacy, and the "Not affiliated" section.
- [x] Credits name everything Winify uses (THIRD_PARTY_NOTICES.md), down to
      each library inside Webamp's build (31 Oct 2026).
- [x] Screenshots of Winify are in the README.
- [x] The project is on GitHub, with nothing personal in it or its history
      (github.com/Parasthappa/Winify; history scanned). The user chose to keep
      their real playlist names in docs/screenshots/windows.png.
- [x] A 1.0 tag and release notes on GitHub: source only, no built app.
      v1.0.0 is pushed; the notes are drafted and await the user's review
      before they are published.
- [x] Winify's menu links to the GitHub project (where Webamp's link used
      to be): "Winify..." at the top of the main menu (31 Oct 2026).
- [x] LRCLIB: Winify's User-Agent includes the GitHub link (LRCLIB asks for
      "a link to its homepage or project page"), from package.json's
      `homepage` (31 Oct 2026).

## After 1.0

- [ ] Queued songs in the single-track view: show them as soon as they are
      added ("Play track, then Autoplay", webamp-playlist.js `noteQueued`), as
      the Up Next view now does. Needs testing with what that view manages:
      what plays next, and the jump to Autoplay. The README's Limits section
      says this until then.
