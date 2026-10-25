/* The main window's controls, per platform.
 *
 * On Mac, Spotify's audio cannot be panned or equalized, so the balance
 * slider and the EQ button are hidden (with the main menu's Equalizer item;
 * Webamp's own keyboard shortcuts, Alt+G among them, are not switched on in
 * Winify), and the volume slider takes their room. On Windows (1.1)
 * the EQ button, and perhaps balance, may come back through Equalizer APO:
 * each platform lists what it hides, and the volume slider ends just before
 * whichever controls are left.
 *
 * The wider volume slider is drawn from the loaded skin's own volume image:
 * its left and right thirds as they are, its middle third repeated in
 * between (never scaled, so the pixel art stays crisp). Every one of its 28
 * frames is widened the same way, so the colour change from low to high
 * volume still works; Webamp goes on choosing the frame. Where a frame shows
 * its backdrop (the colour of its top-left pixel), the main window's own
 * background shows instead: a skin's volume backdrop matches the main window
 * only where the slider used to end. Rebuilt whenever the skin changes.
 */

import { hideMenuItem } from './webamp-inert.js';

const log = (...args) => console.log('[winify/layout]', ...args);

// What each platform hides. 'balance' and 'equalizer' are the main window's
// balance slider and EQ button.
const PLATFORMS = {
  mac: { hide: ['balance', 'equalizer'] },
  windows: { hide: [] },
};

// Winamp's main window template: where the volume slider starts, and the
// controls after it on the same row (left to right).
const VOLUME_LEFT = 107;
const VOLUME_TOP = 57;
const FRAME = 15;                       // each volume level's frame in the image
const SHOWN = 13;                       // ...of which the slider shows the top 13 px
const BACKDROP_TOLERANCE = 12;          // per colour channel, 0-255
const VOLUME_WIDTH = 68;                // the skin's volume image
const INPUT_SHORTER = 3;                // Webamp's input is 3 px shorter than its background
const GAP = 2;                          // between the volume slider and the next control
const AFTER_VOLUME = [
  { id: 'balance', selector: '#webamp #main-window #balance', left: 177 },
  { id: 'equalizer', selector: '#webamp #main-window #equalizer-button', left: 219 },
  { id: 'playlist', selector: '#webamp #main-window #playlist-button', left: 242 },
];

let webamp = null;
let platform = null;
let style = null;
let unsubscribe = null;
let builtFor = null;                    // { url, width } of the volume image now in use
let building = 0;

export const platformOf = () => (/^Mac/i.test(navigator.platform || '') ? 'mac' : 'windows');

const hidden = (id) => PLATFORMS[platform].hide.includes(id);

// The volume slider's width: up to the first control still shown after it.
function volumeWidth() {
  const next = AFTER_VOLUME.find((c) => !hidden(c.id));
  return next.left - GAP - VOLUME_LEFT;
}

// A skin image: a loaded skin's, else the default skin's (a fixed stylesheet
// rule, `#webamp <selector>`).
function skinImageUrl(name, selector) {
  const images = webamp.store.getState().display.skinImages || {};
  if (images[name]) return images[name];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; }
    for (const r of rules) {
      if (r.selectorText === '#webamp ' + selector && r.style && /^url/.test(r.style.backgroundImage || '')) {
        return r.style.backgroundImage.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
      }
    }
  }
  return null;
}

async function loaded(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

// The skin's volume image, `width` wide: left third, the middle third
// repeated, right third; its backdrop replaced by the main window's own.
async function widened(url, mainUrl, width) {
  const img = await loaded(url);
  const w = img.naturalWidth, h = img.naturalHeight;
  const left = Math.floor(w / 3), right = w - Math.floor(w / 3), tile = right - left;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, left, h, 0, 0, left, h);
  const end = width - (w - right);
  for (let x = left; x < end; x += tile) {
    const n = Math.min(tile, end - x);
    g.drawImage(img, left, 0, n, h, x, 0, n, h);
  }
  g.drawImage(img, right, 0, w - right, h, end, 0, w - right, h);
  if (mainUrl) {
    const main = await loaded(mainUrl);
    const m = document.createElement('canvas');
    m.width = width;
    m.height = SHOWN;
    m.getContext('2d').drawImage(main, VOLUME_LEFT, VOLUME_TOP, width, SHOWN, 0, 0, width, SHOWN);
    const under = m.getContext('2d').getImageData(0, 0, width, SHOWN).data;
    const px = g.getImageData(0, 0, width, h);
    const d = px.data;
    for (let top = 0; top + SHOWN <= h; top += FRAME) {
      const b = top * width * 4;                // the frame's top-left pixel: its backdrop
      const [r, gr, bl] = [d[b], d[b + 1], d[b + 2]];
      for (let y = 0; y < SHOWN; y++) {
        for (let x = 0; x < width; x++) {
          const i = ((top + y) * width + x) * 4;
          if (Math.abs(d[i] - r) <= BACKDROP_TOLERANCE && Math.abs(d[i + 1] - gr) <= BACKDROP_TOLERANCE &&
              Math.abs(d[i + 2] - bl) <= BACKDROP_TOLERANCE) {
            const j = (y * width + x) * 4;
            d[i] = under[j]; d[i + 1] = under[j + 1]; d[i + 2] = under[j + 2]; d[i + 3] = under[j + 3];
          }
        }
      }
    }
    g.putImageData(px, 0, 0);
  }
  return c.toDataURL('image/png');
}

function css(volume) {
  const rules = [];
  if (hidden('balance')) rules.push('#webamp #main-window #balance { display: none !important; }');
  if (hidden('equalizer')) {
    // The EQ and PL buttons' container (x 219-265) would still catch the
    // pointer over the volume slider's far end: only PL takes it now.
    rules.push('#webamp #main-window #equalizer-button { display: none !important; }',
      '#webamp #main-window .windows { pointer-events: none; }',
      '#webamp #main-window .windows #playlist-button { pointer-events: auto; }');
  }
  if (volume) {
    rules.push(`#webamp #main-window #volume { width: ${volume.width}px !important; background-image: url(${volume.image}) !important; }`,
      `#webamp #main-window #volume input { width: ${volume.width - INPUT_SHORTER}px !important; }`);
  }
  return rules.join('\n');
}

// Draw the controls for the current platform and skin.
async function paint() {
  if (!webamp) return;
  const width = volumeWidth();
  if (width === VOLUME_WIDTH) {                 // nothing hidden after it: Webamp's own slider
    builtFor = null;
    style.textContent = css(null);
    return;
  }
  const url = skinImageUrl('MAIN_VOLUME_BACKGROUND', '#volume');
  const mainUrl = skinImageUrl('MAIN_WINDOW_BACKGROUND', '#main-window');
  if (!url) { style.textContent = css(null); return; }
  if (builtFor && builtFor.url === url && builtFor.mainUrl === mainUrl && builtFor.width === width) return;
  const gen = ++building;
  style.textContent = css(null);               // hidden controls go at once
  try {
    const image = await widened(url, mainUrl, width);
    if (gen !== building || !webamp) return;
    builtFor = { url, mainUrl, width };
    style.textContent = css({ width, image });
    log('volume slider:', width, 'px wide, from the skin\'s volume image (' + platform + ' layout)');
  } catch (err) {
    log('volume slider: could not widen the skin\'s image -', err.message);
  }
}

// Use one platform's layout (tests switch with WinifyControlsLayout.use).
export function use(name) {
  platform = PLATFORMS[name] ? name : 'windows';
  hideMenuItem('Equalizer', hidden('equalizer'));
  builtFor = null;
  paint();
}

let lastImages;
export function attach(instance) {
  webamp = instance;
  if (!style) {
    style = document.createElement('style');
    style.id = 'winify-controls-layout';
    document.head.appendChild(style);
  }
  lastImages = undefined;
  unsubscribe = webamp.store.subscribe(() => {
    const images = webamp.store.getState().display.skinImages;
    if (images !== lastImages) { lastImages = images; paint(); }
  });
  use(platformOf());
}

export function detach() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  building++;
  webamp = null;
}

window.WinifyControlsLayout = {
  use,
  state: () => ({ platform, hidden: platform ? PLATFORMS[platform].hide.slice() : [], volumeWidth: platform ? volumeWidth() : null, built: !!builtFor }),
};
