/* Milkdrop presets you add (Milkdrop window > Load presets..., or dropped on it).
 *
 * Each file is turned into a Butterchurn preset off the page
 * (milkdrop-convert-worker.js), then test-loaded into a small hidden
 * Butterchurn: a preset whose equations do not compile, or whose shaders do
 * not link, is skipped with a reason rather than added. That catches most of
 * the shader conversions that went wrong; a few that compile may still look
 * different from Milkdrop itself. Accepted presets are kept in this page's
 * IndexedDB, so they come back at every launch.
 */

const log = (...args) => console.log('[winify/milkdrop]', ...args);

const BUTTERCHURN = './node_modules/butterchurn/dist/butterchurn.js';
const WORKER = './milkdrop-convert-worker.js';
const DB_NAME = 'winify-milkdrop';
const STORE = 'presets';

// ---- Storage --------------------------------------------------------------------

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

// Your presets, in the order they were added: [{ name, preset }].
export async function saved() {
  try {
    const all = (await tx('readonly', (s) => s.getAll())) || [];
    return all.sort((a, b) => a.added - b.added).map(({ name, preset }) => ({ name, preset }));
  } catch (err) {
    log('*** could not read your presets:', err && err.message);
    return [];
  }
}

async function keep(list) {
  const now = Date.now();
  await tx('readwrite', (s) => { list.forEach((p, i) => s.put({ name: p.name, preset: p.preset, added: p.added || now + i })); });
}

async function addedAt(name) {
  const rec = await tx('readonly', (s) => s.get(name));
  return rec && rec.added;
}

// ---- Converting, off the page ---------------------------------------------------

let worker = null;
let nextId = 1;
const waiting = new Map();

function convert(files) {
  if (!worker) {
    worker = new Worker(WORKER);
    worker.onmessage = (e) => { const done = waiting.get(e.data.id); waiting.delete(e.data.id); if (done) done(e.data.results); };
  }
  const id = nextId++;
  return new Promise((resolve) => { waiting.set(id, resolve); worker.postMessage({ id, files }); });
}

// ---- Checking: a test load in a hidden Butterchurn --------------------------------

async function checker() {
  const butterchurn = (await import(BUTTERCHURN)).default;
  const context = new OfflineAudioContext(2, 44100, 44100);   // Butterchurn wants one; it never plays
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 48;
  return butterchurn.createVisualizer(context, canvas, { width: 64, height: 48, onlyUseWASM: true, pixelRatio: 1 });
}

// Butterchurn 3.0.0-beta.5 (pinned): after loadPreset the renderer holds the
// preset's compiled warp and composite programs.
async function check(viz, preset) {
  try {
    await viz.loadPreset(structuredClone(preset), 0);   // Butterchurn adds compiled code to what it loads
  } catch (err) {
    throw new Error('its equations could not be read');
  }
  const gl = viz.gl;
  const r = viz.renderer;
  for (const shader of [r.warpShader, r.compShader]) {
    if (!gl.getProgramParameter(shader.shaderProgram, gl.LINK_STATUS)) throw new Error('its shaders could not be converted');
  }
}

// ---- Adding ------------------------------------------------------------------------

const baseName = (file) => file.replace(/\.(milk|json)$/i, '');

// files: [{ name, text }]; builtIn: names that cannot be reused. Resolves to
// { added: [{ name, preset, replaces }], skipped: [{ name, error }] }, with
// the added ones already kept.
export async function add(files, builtIn) {
  const skipped = [];
  const converted = files.length ? await convert(files) : [];
  const ok = converted.filter((r) => { if (r.error) skipped.push({ name: r.name, error: r.error }); return !r.error; });
  const added = [];
  if (ok.length) {
    const viz = await checker();
    const taken = new Set(builtIn);
    try {
      for (const r of ok) {
        try { await check(viz, r.preset); } catch (err) { skipped.push({ name: r.name, error: err.message }); continue; }
        let name = baseName(r.name);
        for (let n = 2; taken.has(name); n++) name = baseName(r.name) + ' (' + n + ')';
        taken.add(name);
        const replaces = await addedAt(name);
        added.push({ name, preset: r.preset, replaces: !!replaces, added: replaces });
      }
    } finally {
      try { viz.loseGLContext(); } catch (e) { /* already gone */ }
    }
    await keep(added);
  }
  const order = new Map(files.map((f, i) => [f.name, i]));
  skipped.sort((a, b) => order.get(a.name) - order.get(b.name));   // in the order given
  skipped.forEach((s) => log('preset skipped:', s.name, '-', s.error));
  if (added.length) log(added.length, 'preset(s) added:', added.map((a) => a.name).join(', '));
  return { added, skipped };
}
