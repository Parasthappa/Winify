# Winify 1.0 release plan

Winify 1.0 is a Mac-only release on GitHub. Windows comes later, as 1.1.

Every session: check here which stage we are in, and tick items off as they
are done (with the commit, where there is one).

## 1. Wrap up: done (25 Oct 2026)

Done means:

- [x] The random mixes are committed, after the full test suite and a smoke
      run against the real Spotify both pass (027e871).
- [x] The stray junk file from commit 54009af is removed.
- [x] The test mix "25 Oct, 7:17" is gone from the saved mixes (checked:
      it had already been deleted).
- [x] The project has been checked for leftovers, scratch files and anything
      personal, and the findings have been listed for the user to decide on.
- [x] This plan exists, and CLAUDE.md points to it.

## 2. Check the rules

Done means a short written answer (with links) for each of these, saying
what Winify 1.0 may do, what it must include and what it must not do:

- [ ] castLabs' terms for distributing an app signed with their VMP service
      (Electron for Content Security), including whether others may download
      a signed build from GitHub.
- [ ] Spotify's Developer Terms and Developer Policy for an open-source,
      non-commercial player: use of the Web API and the Web Playback SDK,
      each user bringing their own Client ID, the name "Winify" and its look,
      and what may be said about Spotify in the README.
- [ ] The licence of everything Winify includes, and what credit each needs:
      Webamp, Butterchurn, its presets, the preset converter (.milk to
      Butterchurn), and LRCLIB's lyrics data.
- [ ] Any change the answers call for is listed as a task in a later stage
      (or a decision for the user), before stage 3 starts.

## 3. Finish the window magic

Done means each works, has tests against the mocks, and is in the README:

- [ ] Always on top: Winify can stay above other apps (on or off, remembered).
- [ ] Behind other apps: Winify can sit on the desktop under other windows
      (on or off, remembered).
- [ ] Milkdrop Desktop Mode: Milkdrop can fill the desktop behind
      everything, as Winamp's Desktop Mode did, and leave it again.
- [ ] Existing window behaviour still works: dragging, clicks passing
      through, panels, the sign-in panel's lights, hide and show.

## 4. Package

Done means:

- [ ] Winify.app is built from the project with one command, and opens from
      Finder like any app.
- [ ] Its name is "Winify" everywhere: the menu bar, Finder, the Dock, the
      app switcher and Activity Monitor (not "Electron").
- [ ] It has Winify's icon in Finder and the Dock.
- [ ] It is VMP-signed by castLabs, in the right order relative to Apple's
      code signing, so Spotify plays in the packaged app.
- [ ] It comes in a .dmg with the usual "drag to Applications" window.
- [ ] Sign-in, playback, the visualizers and lyrics work from the installed
      app (the smoke test, run against the packaged app).
- [ ] Native system-audio capture is retested in the packaged app, to see
      whether BlackHole is still needed. The answer, either way, goes in the
      README's visualizer setup.

## 5. Publish

Done means:

- [ ] The README is ready for strangers: what Winify is, plain install
      steps from the .dmg, setting up a Client ID, the visualizer setup,
      troubleshooting, and privacy.
- [ ] Credits name everything Winify uses, as stage 2 says they must.
- [ ] Screenshots of Winify are in the README.
- [ ] The project is on GitHub, with nothing personal in it or its history.
- [ ] A 1.0 release on GitHub, with the .dmg and release notes.
- [ ] Winify's menu links to the GitHub project (where Webamp's link used
      to be).
