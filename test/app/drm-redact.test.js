// The DRM diagnostics (npm start -- --drm-debug) never write tokens or signed links.
const { app } = require('electron'); const path = require('path');
const { redact } = require(path.join(__dirname, '..', '..', 'drm-redact.js'));
let fails = 0;
const check = (l, ok, d) => { if (!ok) fails++; console.log((ok ? '  PASS ' : '  FAIL ') + l + (d ? '   ' + String(d).slice(0, 300) : '')); };
const SECRETS = ['abc123secret', 'exp=1730000000~hmac=deadbeefdeadbeef', 'BQDxyz123456789abcdefghijklmnopqrstuvwxyz0123', 'BQAshort', 'AQBshort', 'AQCxyz', 's3cr3t', 'verif1er'];
const lines = [
  '[drm] +1.0s LICENCE REQUEST POST https://gew1-spclient.spotify.com/widevine-license/v1/audio/license?token=abc123secret',
  '[drm] +2.0s SEGMENT/API 403 https://audio-ak.example.net/audio/0a1b2c?__token__=exp=1730000000~hmac=deadbeefdeadbeef',
  '[drm] +3.0s SDK CONSOLE [log] Authorization: Bearer BQDxyz123456789abcdefghijklmnopqrstuvwxyz0123',
  '[drm] +4.0s LICENCE BODY {"access_token":"BQAshort","refresh_token":"AQBshort"}',
  '[renderer] +5.0s code=AQCxyz&state=1 client_secret: s3cr3t code_verifier=verif1er',
];
const out = lines.map(redact);
const leaked = SECRETS.filter((s) => out.some((l) => l.includes(s)));
check('no token, signed link or code survives', leaked.length === 0, JSON.stringify({ leaked, out }));
check('what is useful stays: the host and path, status, sizes, key states',
  out[0].includes('https://gew1-spclient.spotify.com/widevine-license/v1/audio/license') && out[1].includes('SEGMENT/API 403') &&
  redact('[drm] KEYSTATUSESCHANGE 0a1b2c3d4e5f6a7b=usable') === '[drm] KEYSTATUSESCHANGE 0a1b2c3d4e5f6a7b=usable' &&
  redact('[drm] LICENCE BODY <binary licence blob, 1024 bytes>') === '[drm] LICENCE BODY <binary licence blob, 1024 bytes>', JSON.stringify(out.slice(0, 2)));
console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: ALL PASSED');
app.exit(fails ? 1 : 0);
