# Third-party notices

Winify's own code is released under the MIT License (see LICENSE). Winify is
built on, and ships with, the work of others, listed here with their licences.
Their licences, not Winify's, apply to their parts.

Winify is an independent fan project and a tribute to Winamp, by Nullsoft: the
original player, interface and classic skin. It is built on Webamp, by Jordan
Eldredge and contributors, the open-source recreation of Winamp. Thank you to
both, and to everyone listed here.

Winify is not affiliated with, endorsed by, or sponsored by Spotify, or by
Winamp or its current owner, Winamp Group. Spotify is a trademark of Spotify AB.
Winamp is a trademark of Winamp Group.

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

- **Webamp** 2.3.1, by Jordan Eldredge and contributors: MIT License,
  Copyright (c) 2015 Jordan Eldredge.
  https://github.com/captbaritone/webamp
  (licence: https://github.com/captbaritone/webamp/blob/master/LICENSE.txt)
  Webamp's build (`webamp.bundle.min.mjs`, the file Winify loads) includes
  these, listed from its source map:
  - MIT License: React 19.1.0, React DOM 19.1.0, react-is 18.3.1, scheduler
    0.26.0 and use-sync-external-store 1.2.2 (Meta Platforms, Inc. and
    affiliates); Redux 5.0.1, React Redux 8.1.3 and Redux Thunk 3.1.0 (Dan
    Abramov and the Redux contributors); Reselect 3.0.1 (Reselect
    contributors); classnames 2.5.1
    (Jed Watson); invariant 2.2.4 (Andres Suarez); lodash 4.17.21 (OpenJS
    Foundation and other contributors); music-metadata 11.6.0, strtok3
    10.3.1, token-types 6.0.3 and @tokenizer/inflate 0.2.7 (Borewit);
    file-type 21.0.0 and uint8array-extras 1.4.0 (Sindre Sorhus); fflate
    0.8.2 (Arjun Barrett); debug 4.4.1 (Josh Junon and TJ Holowaychuk); ms
    2.1.3 (Vercel, Inc.); content-type 1.0.5 and media-typer 1.1.0 (Douglas
    Christopher Wilson); immediate 3.0.6 and lie 3.3.0 (Calvin Metcalf and
    contributors); byte-data 18.1.1, endianness 8.0.2, ieee754-buffer 2.0.0,
    riff-file 1.0.3 and utf8-buffer 1.0.0 (Rafael da Silva Rocha).
  - JSZip 3.10.1 (Stuart Knightley and contributors): dual-licensed MIT or
    GPLv3; used here under MIT.
  - tinyqueue 3.0.0 (Vladimir Agafonkin): ISC License.
  - ieee754 1.2.1: BSD 3-Clause License, Copyright 2008 Fair Oaks Labs, Inc.
    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions are
    met: (1) Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.
    (2) Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in the
    documentation and/or other materials provided with the distribution.
    (3) Neither the name of the copyright holder nor the names of its
    contributors may be used to endorse or promote products derived from this
    software without specific prior written permission. THIS SOFTWARE IS
    PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS
    OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
    WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
    DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
    LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
    CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
    SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
    INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
    CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
    ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF
    THE POSSIBILITY OF SUCH DAMAGE.
- **Winamp's classic skin** ("base 2.91"), which Webamp includes and Winify
  shows by default: artwork by Nullsoft, now owned by Winamp Group. It is not
  covered by Winify's or Webamp's MIT License. Winify redraws its title text and
  logos as Winify's, in `assets/brand/`, from the skin's own letters; those
  redrawn images are derived from this artwork. As Webamp puts it: "the Winamp
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
- **Skins shown in Winify's pictures**, not included in the app and belonging to
  their authors: Blue Jeans by Robson Moraes, EJL Classic by Edward J. Lackey,
  Pup, Inc. (Grey) by Pup, Purple Glow by Homocianu Luis Gabriel and SoundLair
  by Roman Kondratyev.
- **Fonts**, loaded from Google Fonts: Archivo, JetBrains Mono, Saira
  Condensed and Source Code Pro, each under the SIL Open Font License 1.1.
