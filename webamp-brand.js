// Webamp, as served to Winify's page: its default skin's title bars and logos are Winify's (assets/brand/, made by
// packaging/brand-art.js), and so is every name it can show. Other skins draw over all of this art, so they are
// untouched. The version of Webamp is pinned; if one of these is ever not found, the app says so in its log and a test fails.
const fs = require('fs'), path = require('path');

// The stylesheet rule's selector -> its replacement.
const ART = {
  '#main-window': 'main.png',
  '.selected #title-bar': 'title-on.png',
  '#title-bar': 'title-off.png',
  '.shade.selected #title-bar': 'shade-on.png',
  '.shade #title-bar': 'shade-off.png',
  // Webamp's hidden title, Winamp's slogan: gone, it is the plain title.
  '.llama.selected #title-bar': 'title-on.png',
  '.llama #title-bar': 'title-off.png',
  '.selected #title-bar #option.clicked': 'option-clicked.png',
  '.selected #title-bar #option:active': 'option-active.png',
  '.selected #title-bar #option.selected': 'option-selected.png',
  '.selected .playlist-top-title': 'playlist-on.png',
  '.playlist-top-title': 'playlist-off.png',
  '.selected .equalizer-top': 'equalizer-on.png',
  '.equalizer-top': 'equalizer-off.png',
};
// Text, with how many times Webamp 2.3.1 has it. "Winamp EQ library file v1.1" stays: it is the EQ preset file format's own header.
const TEXT = [
  ['"Winamp 2.91"', '"Winify"', 1],                                     // the display with nothing playing
  ['"Winamp Menu"', '"Winify Menu"', 1],                                // the menu button's tooltip
  ['"Webamp..."', '"Winify..."', 1],                                    // the main menu
  ['"Not supported in Webamp"', '"Not supported in Winify"', 5],        // alerts
  ['"Webamp has not been configured to support custom skins."', '"Winify could not load that skin."', 1],
  ['"Winamp Playlist.html"', '"Winify Playlist.html"', 1],              // Generate HTML playlist
  ['Winamp Generated PlayList', 'Winify Generated PlayList', 1],
  ['"WINAMP"', '"WINIFY"', 1],
];

function brand(bundle, dir = path.join(__dirname, 'assets', 'brand')) {
  const missing = [];
  let out = bundle;
  for (const [from, to, times] of TEXT) {
    const parts = out.split(from);
    if (parts.length - 1 !== times) missing.push(from);
    out = parts.join(to);
  }
  for (const [selector, file] of Object.entries(ART)) {
    const rule = '\\n#webamp ' + selector + ' {background-image: url(data:image/png;base64,';
    const at = out.indexOf(rule);
    const end = at < 0 ? -1 : out.indexOf(')', at);
    if (end < 0) { missing.push(selector); continue; }
    out = out.slice(0, at + rule.length) + fs.readFileSync(path.join(dir, file)).toString('base64') + out.slice(end);
  }
  return { bundle: out, missing };
}

module.exports = { brand, ART, TEXT };
