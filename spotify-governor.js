// One request governor for all of Winify's Spotify Web API calls (main
// process), shared by the development copy and the packaged app.
//
// Spotify limits each app (Client ID) as a whole, and both copies share
// one, so the caps count both: each copy writes its own recent requests to
// the shared folder and reads the other's. Caps, over every request:
//
//                      per minute   per hour
//   everything             30          300      (the hard caps)
//   things you did         24          240      (search, a playlist chosen...)
//   background             10          150      (the index, the picker's list)
//
// Sign-in and playback are first in line: they wait only for the hard caps,
// never behind anything else. Things you did come next; background work
// only uses what is left, so it never crowds them out (a first index build
// of a large library spreads over hours, across sessions; progress is kept).
//
// When Spotify says to wait (429, Retry-After), that endpoint is blocked
// until then for both copies, also after a restart: nothing is sent to it,
// and callers are told until when.
const fs = require('fs');
const path = require('path');

const CAPS = {
  hard: { minute: 30, hour: 300 },
  user: { minute: 24, hour: 240 },
  background: { minute: 10, hour: 150 },
};
const RANK = { auth: 0, playback: 0, user: 1, background: 2 };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// Things you did: refused rather than left waiting longer than this.
const USER_WAIT_MAX = 20 * 1000;

// Spotify rate-limits by endpoint ('/me/player', '/playlists/<id>', ...).
const keyOf = (p) => String(p).split('?')[0].split('/').slice(0, 3).join('/');
// Playback and what the player shows: always first in line.
const classOf = (p, asked) => (/^\/me\/player(\/|$|\?)/.test(p) ? 'playback' : (asked === 'background' ? 'background' : 'user'));

// `windows` and `userWaitMax`: shorter in tests.
function create({ dir, copy, caps = CAPS, now = Date.now, log = () => {}, windows = { minute: MINUTE, hour: HOUR }, userWaitMax = USER_WAIT_MAX }) {
  const MINUTE_W = windows.minute, HOUR_W = windows.hour;
  const mine = [];                         // this copy's request times, last hour
  const today = () => { const d = new Date(now()); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  let day = null;                          // this copy's count today: { date, count }
  const waiting = [];                      // { cls, at, resolve }
  let others = { at: 0, times: [] };       // the other copy's, read now and then
  let blocks = { at: 0, map: {} };
  let saveTimer = null;
  let pumpTimer = null;
  const file = (name) => path.join(dir, name);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* written on first use */ }

  function readJson(name, fallback) {
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch (e) { return fallback; }
  }
  function writeJson(name, value) {
    try {
      const tmp = file(name + '.' + process.pid + '.tmp');
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, file(name));
    } catch (e) { /* not fatal: the caps still hold for this copy */ }
  }

  function otherTimes() {
    if (now() - others.at > 5000) {
      let times = [];
      try {
        for (const f of fs.readdirSync(dir)) {
          if (/^requests-.+\.json$/.test(f) && f !== 'requests-' + copy + '.json') times = times.concat(readJson(f, []));
        }
      } catch (e) { /* none */ }
      others = { at: now(), times };
    }
    return others.times;
  }

  function counts() {
    const t = now();
    const all = mine.concat(otherTimes());
    return { minute: all.filter((x) => x > t - MINUTE_W).length, hour: all.filter((x) => x > t - HOUR_W).length, all };
  }

  // When a request of this class could go: now, or the first moment it fits.
  function nextSlot(cls) {
    const c = counts();
    const limits = [caps.hard].concat(cls === 'user' ? [caps.user] : cls === 'background' ? [caps.user, caps.background] : []);
    let at = now();
    for (const lim of limits) {
      const sorted = c.all.slice().sort((a, b) => a - b);
      for (const [span, cap] of [[MINUTE_W, lim.minute], [HOUR_W, lim.hour]]) {
        const inWindow = sorted.filter((x) => x > now() - span);
        if (inWindow.length >= cap) at = Math.max(at, inWindow[inWindow.length - cap] + span + 1);
      }
    }
    return at;
  }

  function record() {
    const t = now();
    mine.push(t);
    while (mine.length && mine[0] <= t - HOUR_W) mine.shift();
    if (!day) day = readJson('day-' + copy + '.json', null);
    if (!day || day.date !== today()) day = { date: today(), count: 0 };
    day.count++;
    if (!saveTimer) saveTimer = setTimeout(() => {
      saveTimer = null;
      writeJson('requests-' + copy + '.json', mine.filter((x) => x > now() - HOUR_W));
      writeJson('day-' + copy + '.json', day);
    }, 1000);
    onCount();
  }
  let onCount = () => {};

  // Both copies' requests in the last hour and today (for the menu bar).
  function usage() {
    const hour = counts().hour;
    let todayCount = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/^day-.+\.json$/.test(f)) continue;
        const d = f === 'day-' + copy + '.json' && day ? day : readJson(f, null);
        if (d && d.date === today()) todayCount += d.count;
      }
    } catch (e) { /* none yet */ }
    if (day && day.date === today() && !fs.existsSync(file('day-' + copy + '.json'))) todayCount += day.count;
    return { hour, today: todayCount };
  }

  // Let through, in order of rank, whatever fits now; check again later.
  function pump() {
    clearTimeout(pumpTimer);
    pumpTimer = null;
    waiting.sort((a, b) => RANK[a.cls] - RANK[b.cls] || a.at - b.at);
    let soonest = Infinity;
    for (let i = 0; i < waiting.length; i++) {
      const w = waiting[i];
      // Nothing of a lower rank goes ahead of a higher one still waiting.
      if (waiting.slice(0, i).some((x) => RANK[x.cls] < RANK[w.cls])) break;
      const at = nextSlot(w.cls);
      if (at <= now()) {
        waiting.splice(i, 1);
        i--;
        record();
        w.resolve({ ok: true });
      } else if (w.cls === 'user' && at - now() > userWaitMax) {
        waiting.splice(i, 1);
        i--;
        w.resolve({ ok: false, until: at, reason: 'winify' });
      } else {
        soonest = Math.min(soonest, at);
      }
    }
    if (waiting.length) pumpTimer = setTimeout(pump, Math.max(50, Math.min(soonest === Infinity ? 1000 : soonest - now(), 60000)));
  }

  function blockedUntil(key) {
    if (now() - blocks.at > 2000) blocks = { at: now(), map: readJson('blocks.json', {}) };
    const until = blocks.map[key] || 0;
    return until > now() ? until : 0;
  }

  return {
    keyOf, classOf, caps,
    // Before a request: { ok: true } (sent now, counted), or { ok: false,
    // until, reason: 'spotify' | 'winify' }: not sent.
    admit(apiPath, asked) {
      const until = blockedUntil(keyOf(apiPath));
      if (until) return Promise.resolve({ ok: false, until, reason: 'spotify' });
      const cls = classOf(apiPath, asked);
      return new Promise((resolve) => { waiting.push({ cls, key: keyOf(apiPath), at: now(), resolve }); pump(); });
    },
    // Someone is now waiting for these (the picker opened during its read):
    // their queued background requests move up to "things you did".
    promote(keys) {
      let moved = 0;
      for (const w of waiting) if (w.cls === 'background' && keys.includes(w.key)) { w.cls = 'user'; moved++; }
      if (moved) pump();
      return moved;
    },
    // A request made outside admit() (sign-in's own, the status poll): counted.
    count: record,
    // Spotify said to wait: blocked for both copies until then.
    blocked(apiPath, retryAfterS) {
      const key = keyOf(apiPath);
      const until = now() + Math.max(1, Number(retryAfterS) || 5) * 1000;
      const map = readJson('blocks.json', {});
      for (const k of Object.keys(map)) if (map[k] <= now()) delete map[k];
      map[key] = Math.max(map[key] || 0, until);
      writeJson('blocks.json', map);
      blocks = { at: now(), map };
      log('Spotify asked to wait on ' + key + ' until ' + new Date(until).toLocaleTimeString());
      return until;
    },
    blockedUntil: (apiPath) => blockedUntil(keyOf(apiPath)),
    state: () => { const c = counts(); return { minute: c.minute, hour: c.hour, waiting: waiting.map((w) => w.cls), blocks: readJson('blocks.json', {}) }; },
    usage,
    // Told after each request counted (the menu bar's counter).
    onCount: (fn) => { onCount = fn; },
  };
}

module.exports = { create, CAPS, keyOf, classOf };
