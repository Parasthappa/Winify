/* Turns preset files into Butterchurn presets, off the page.
 *
 * .milk (original Milkdrop): the preset is split into its values, equations
 * and shaders (milkdrop-preset-utils). The equations stay as written: Butterchurn
 * compiles Milkdrop's own equation language to WebAssembly. The shaders are
 * HLSL, converted to GLSL by hlslparser (milkdrop-preset-converter).
 * .json (Butterchurn): accepted if it carries Milkdrop equations (*_eqs_eel);
 * the older JavaScript-only form is not, since Winify's page does not run
 * code from text.
 *
 * Why a worker: hlslparser's loader builds functions from text, which the
 * page's security policy forbids. This worker has no access to the page or
 * Winify's Spotify bridge, and runs under a policy of its own (main.js,
 * WORKER_CSP): scripts only from Winify's own folder, and no network.
 *
 * In:  { id, files: [{ name, text }] }
 * Out: { id, results: [{ name, preset } | { name, error }] }
 */
/* global importScripts, milkdropPresetUtils, milkdropPresetConverter */

importScripts(
  './node_modules/milkdrop-preset-utils/dist/milkdrop-preset-utils.min.js',
  './node_modules/milkdrop-preset-converter/dist/milkdrop-preset-converter.min.js',
);

async function shader(source) {
  if (!source || !source.trim()) return '';
  const glsl = await milkdropPresetConverter.convertShader(source);
  if (!glsl || !/shader_body/.test(glsl)) throw new Error('its shaders could not be converted');
  return glsl;
}

async function fromMilk(text) {
  if (!/^\s*\[preset\d+\]/m.test(text)) throw new Error('not a Milkdrop preset');
  // The whole file: the version lines come before [preset00]. Values equal
  // to Milkdrop's defaults are left out; Butterchurn fills those in.
  const p = milkdropPresetUtils.splitPreset(text);
  if (!p || !p.baseVals) throw new Error('not a Milkdrop preset');
  const [warp, comp] = await Promise.all([shader(p.warp), shader(p.comp)]);
  return {
    version: p.presetVersion,
    baseVals: p.baseVals,
    init_eqs_eel: p.presetInit || '',
    frame_eqs_eel: p.perFrame || '',
    pixel_eqs_eel: p.perVertex || '',
    shapes: (p.shapes || []).map((s) => ({ baseVals: s.baseVals, init_eqs_eel: s.init_eqs_str || '', frame_eqs_eel: s.frame_eqs_str || '' })),
    waves: (p.waves || []).map((w) => ({ baseVals: w.baseVals, init_eqs_eel: w.init_eqs_str || '', frame_eqs_eel: w.frame_eqs_str || '', point_eqs_eel: w.point_eqs_str || '' })),
    warp,
    comp,
  };
}

function fromJson(text) {
  let p;
  try { p = JSON.parse(text); } catch (e) { throw new Error('not valid JSON'); }
  if (!p || typeof p !== 'object' || !p.baseVals) throw new Error('not a Butterchurn preset');
  if (!('init_eqs_eel' in p) && !('frame_eqs_eel' in p)) {
    throw new Error('older Butterchurn format (JavaScript equations), not supported');
  }
  return p;
}

self.onmessage = async (e) => {
  const { id, files } = e.data || {};
  const results = [];
  for (const f of files || []) {
    try {
      const preset = /\.milk$/i.test(f.name) ? await fromMilk(f.text) : fromJson(f.text);
      results.push({ name: f.name, preset });
    } catch (err) {
      results.push({ name: f.name, error: (err && err.message) || String(err) });
    }
  }
  self.postMessage({ id, results });
};
