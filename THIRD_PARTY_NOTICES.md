# Third-party notices

Winify's own code is released under the MIT License (see LICENSE). Winify is
built on, and ships with, the work of others, listed here with their licences.
Their licences, not Winify's, apply to their parts.

Winify is not affiliated with, endorsed by, or sponsored by Spotify or by
Winamp. Spotify is a trademark of Spotify AB. Winamp is a trademark of its
owner, Winamp Group.

## Included in Winify

### The app runtime

- **Electron for Content Security** (castLabs' fork of Electron, v44.1.0+wvcus):
  MIT License, Copyright (c) 2017-2025 castLabs GmbH.
  https://github.com/castlabs/electron-releases
- **Electron**, on which it is based: MIT License, Copyright (c) Electron
  contributors and GitHub Inc. https://github.com/electron/electron
- **Chromium** and the libraries it includes: BSD-style and other open-source
  licences, listed in full in `LICENSES.chromium.html`, which ships with the
  app.

### The player

- **Webamp** 2.3.1: MIT License, Copyright (c) 2015 Jordan Eldredge.
  https://github.com/captbaritone/webamp
  Webamp's build includes, among others: React, React Redux and Redux (MIT,
  Meta Platforms, Inc. and contributors), Reselect (MIT), classnames (MIT,
  Jed Watson), JSZip 3.10.1 (dual-licensed MIT or GPLv3; used here under
  MIT), and music-metadata (MIT, Borewit).
- **Winamp's classic skin** ("base 2.91"), which Webamp includes and Winify
  shows by default: artwork by Nullsoft, now owned by Winamp Group. It is not
  covered by Winify's or Webamp's MIT License. As Webamp puts it: "the Winamp
  name, interface, and, sample audio file are surely property of Nullsoft".

### Milkdrop (the visualizer)

- **Butterchurn** 3.0.0-beta.5: MIT License, Copyright (c) 2013-2018 Jordan
  Berg. https://github.com/jberg/butterchurn
- **butterchurn-presets** 3.0.0-beta.4: MIT License, Copyright (c) 2013-2018
  Jordan Berg (the collection and its conversion). The presets themselves are
  classic MilkDrop presets made by members of the MilkDrop community, credited
  by name in each preset's title, among them Geiss, Flexi, Martin, Rovastar,
  Aderrasi, Zylot, suksma, $$$ Royal, shifter, ORB, yin and cope. Winify keeps
  every preset's title and credit unchanged. If you made a preset and would
  rather it were not included, please open an issue and it will be removed.
  https://github.com/jberg/butterchurn-presets
- **milkdrop-preset-converter** 0.1.2, **milkdrop-preset-utils** 0.2.1 and
  0.1.0, and **milkdrop-eel-parser** 0.0.1: MIT License, Copyright (c)
  2013-2018 Jordan Berg. https://github.com/jberg
- **hlslparser-js** 0.1.1: MIT License (published by Jordan Berg; its licence
  names no copyright holder). https://github.com/jberg/hlslparser-js
- **eel-wasm** 0.0.16: MIT License, Copyright (c) Jordan Eldredge.
  https://github.com/captbaritone/eel-wasm
- **@assemblyscript/loader** 0.17.14: Apache License 2.0, Copyright (c)
  Daniel Wirtz and AssemblyScript contributors.
  https://github.com/AssemblyScript/assemblyscript
- **ecma-proposal-math-extensions** 0.0.2: MIT License, Rick Waldron.
- **lodash** 4.18.1: MIT License, Copyright OpenJS Foundation and other
  contributors.
- **core-js** 2.6.12: MIT License, Copyright (c) 2014-2020 Denis Pushkarev.
- **babel-runtime** 6.26.0 and **@babel/runtime** 7.29.10: MIT License,
  Copyright (c) 2014-present Sebastian McKenzie and other contributors.
- **regenerator-runtime** 0.11.1: MIT License, Ben Newman.

### Spotify's logo

- **The Spotify logo** (`assets/spotify-logo-white.svg`, Spotify's own file
  from its design guidelines): Spotify's trademark, shown with what is
  playing to attribute it to Spotify, as Spotify's Developer Policy and
  design guidelines require. https://developer.spotify.com/documentation/design

## Used by Winify, not included in it

- **Spotify**: playback through the Spotify Web Playback SDK (loaded from
  Spotify's servers) and the Spotify Web API, under Spotify's Developer Terms
  and Developer Policy. Each user signs in with their own Spotify Premium
  account and their own Spotify app (Client ID). Content, cover art and
  metadata are supplied by Spotify.
- **Google Widevine**: the Widevine Content Decryption Module, which plays
  Spotify's protected audio, is downloaded from Google by the app on first
  launch (Chromium's Component Updater). It is Google's, under Google's terms;
  Winify does not include or redistribute it.
- **LRCLIB** (https://lrclib.net): a free, community-made lyrics library,
  queried for the lyrics window. Lyrics belong to their songwriters and
  publishers; Winify shows them and stores none.
- **Fonts**, loaded from Google Fonts: Archivo, JetBrains Mono, Saira
  Condensed and Source Code Pro, each under the SIL Open Font License 1.1.
