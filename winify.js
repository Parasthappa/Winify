
(function () {
  'use strict';
  var PROPS = {"accent": "#ffb300", "action": "#1ed760", "outcome": "success"};
  // no Tweaks panel here: ?outcome=free-account, network or redirect demos an
  // error state; ?outcome=setup the Client ID setup step
  var DEMO = false;
  try { var q = new URLSearchParams(location.search).get('outcome'); if (q) { PROPS.outcome = q; DEMO = true; } } catch (e) {}
  var IPC = (typeof window !== 'undefined' && window.spotify) ? window.spotify : null;
  // The chassis within the design (its outline spans 42..1238 x 55..982),
  // plus a margin for its glow and drop shadow. The window shows only this.
  var CHASSIS = { x: 14, y: 27, w: 1252, h: 983 };
  // The sign-in screen's size: half the 0.712 it was drawn at before, in a
  // 1200x790 window on a 1440x900 display. A uniform scale of the whole
  // design, so nothing is rearranged.
  var SIGN_IN_SCALE = 0.356;
  // First run: how long "CLIENT ID SAVED" shows before signing in by itself.
  var SAVED_PAUSE_MS = 1400;
  // The now-playing display's stand-in while a track has no cover (rare):
  // a plain dark square, so the layout never jumps.
  var NO_COVER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#1b2733"/></svg>');

  var queued = false, comp = null, vals = {}, bindings = [];
  function schedule() {
    if (queued) return; queued = true;
    Promise.resolve().then(function () { queued = false; update(); });
  }
  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(p) {
      var next = typeof p === 'function' ? p(this.state, this.props) : p;
      this.state = Object.assign({}, this.state, next);
      schedule();
    }
    forceUpdate() { schedule(); }
  }

  /* ---- the design's own logic, unchanged ---- */
  class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.state = { powered: true, asleep: false, remember: false, status: 'idle', step: 0, btnHover: false,
      // the setup step: your own Spotify app's Client ID
      setup: props && props.outcome === 'setup', setupWelcome: props && props.outcome === 'setup',
      setupFirstRun: props && props.outcome === 'setup',
      setupBusy: false, setupError: null, setupCurrent: null, setupSaved: false, autoSignIn: false };
  }

  componentWillUnmount() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  toRgb(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
    if (h.length !== 6) { h = 'ff7a18'; }
    return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
  }

  mix(hex, toWhite, amount) {
    var c = this.toRgb(hex);
    var target = toWhite ? 255 : 0;
    var out = c.map(function (v) { return Math.round(v + (target - v) * amount); });
    return 'rgb(' + out[0] + ',' + out[1] + ',' + out[2] + ')';
  }

  alpha(hex, a) {
    var c = this.toRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }

  mixAlpha(hex, toWhite, amount, a) {
    var c = this.toRgb(hex);
    var target = toWhite ? 255 : 0;
    var out = c.map(function (v) { return Math.round(v + (target - v) * amount); });
    return 'rgba(' + out[0] + ',' + out[1] + ',' + out[2] + ',' + a + ')';
  }

  // Sign in: the main process walks the handshake and reports each step.
  startSignIn() {
    var self = this;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.setState({ status: 'connecting', step: 0, asleep: false, failKind: null, setupSaved: false });

    // Real login. Main process drives step/error/connected over IPC.
    if (IPC && !DEMO) { IPC.login(); return; }

    // Demo fallback (?outcome=... or opened outside Electron): the
    // original simulated walk, untouched.
    this.timer = setInterval(function () {
      var cur = (self.state && self.state.step) || 0;
      var fail = { 'free-account': 2, 'network': 0, 'rescope': 0, 'redirect': 0 }[self.props.outcome];
      if (fail != null && cur >= fail) {
        clearInterval(self.timer); self.timer = null;
        self.setState({ status: 'error', step: 0, failKind: self.props.outcome });
        return;
      }
      var next = cur + 1;
      if (next >= 4) {
        clearInterval(self.timer); self.timer = null;
        self.setState({ status: 'connected', step: 0 });
      } else {
        self.setState({ step: next });
      }
    }, 700);
  }

  // The setup step's Save: Spotify is asked (by the main process) whether it
  // knows the Client ID; only then is it kept.
  submitSetup() {
    var self = this;
    var s = this.state || {};
    if (s.setupBusy) { return; }
    var field = document.getElementById('sa-client-id');
    var value = field ? field.value.trim() : '';
    if (!value) { this.setState({ setupError: 'format' }); return; }
    if (!IPC || !IPC.setClientId) {        // demo: any 32-character hex string will do
      this.setState({ setupError: /^[0-9a-f]{32}$/i.test(value) ? null : 'format', setup: !/^[0-9a-f]{32}$/i.test(value), setupSaved: /^[0-9a-f]{32}$/i.test(value) });
      return;
    }
    this.setState({ setupBusy: true, setupError: null });
    IPC.setClientId(value).then(function (verdict) {
      if (verdict === 'ok' && (self.state || {}).setupFirstRun) {
        // First run: say it worked, then straight on to signing in.
        self.setState({ setup: false, setupFirstRun: false, setupBusy: false, setupError: null, setupSaved: true, autoSignIn: true, status: 'idle', step: 0, failKind: null });
        setTimeout(function () {
          self.setState({ autoSignIn: false });
          self.startSignIn();
        }, SAVED_PAUSE_MS);
      } else if (verdict === 'ok') {
        self.setState({ setup: false, setupBusy: false, setupError: null, setupSaved: true, status: 'idle', step: 0, failKind: null });
      } else {
        self.setState({ setupBusy: false, setupError: verdict });
        if (field) { field.focus(); field.select(); }
      }
    }, function () {
      self.setState({ setupBusy: false, setupError: 'unreachable' });
    });
  }

  renderVals() {
    var self = this;
    var s = this.state || {};
    var accent = this.props.accent || '#ff7a18';
    var action = this.props.action || '#1ed760';

    var powered = s.powered !== false;
    var asleep = powered && s.asleep === true;
    var status = powered ? (s.status || 'idle') : 'idle';
    var remember = s.remember === true;

    var setup = powered && s.setup === true;
    // first run: the welcome screen, then (Get started) the Client ID step
    var welcome = setup && s.setupWelcome === true;
    var connecting = !setup && status === 'connecting';
    var connected = !setup && status === 'connected';
    var failed = !setup && status === 'error';
    var live = powered && !asleep;
    var redirectHelp = failed && s.failKind === 'redirect';
    var track = s.track || null;
    var nowPlaying = connected && !!track && !!track.title;

    var eqHeights = [21, 35, 54, 72, 47, 63, 84, 58, 40, 26];
    var eqDur   = [1050, 1550, 920, 1310, 1750, 1160, 1460, 1000, 1650, 1240];
    var eqDelay = [-220, -1040, -460, -1500, -70, -800, -1220, -600, -320, -950];
    var eqShape = [1, 2, 3, 1, 3, 2, 1, 3, 2, 1];
    // The EQ reflects the connection: it dances only once audio can actually
    // flow. Before that it idles as a slow wave, and on failure it stops dead.
    var eqWave = live && !connected && !failed;
    var eqBars = eqHeights.map(function (h, i) {
      if (eqWave) {
        // Evenly staggered delays turn ten independent bars into a single
        // wave travelling across them; one shared keyframe keeps it smooth,
        // so the per-bar shape variants are dropped here on purpose.
        return { h: h, d: -(i * 170), t: 1700, cls: 'sa-bar' };
      }
      return { h: h, d: eqDelay[i], t: eqDur[i], cls: 'sa-bar' + (eqShape[i] > 1 ? ' sa-v' + eqShape[i] : '') };
    });

    var STEPS = ['HANDSHAKE \u203a SPOTIFY API\u2026', 'EXCHANGING AUTH TOKEN\u2026', 'VERIFYING PREMIUM\u2026', 'SYNCING LIBRARY\u2026'];
    // demo outcome (Tweaks): where the handshake stops, and what it says
    var FAILS = {
      'free-account': { at: 2, text: 'SPOTIFY PREMIUM NOT DETECTED' },
      'network':      { at: 0, text: 'CONNECTION FAILED \u00b7 NO RESPONSE' },
      // a stored session that predates permissions Winify now needs
      'rescope':      { at: 0, text: 'NEW PERMISSIONS \u00b7 SIGN IN AGAIN' },
      // the browser never called back: Spotify most likely refused the
      // redirect URI, which it says only in the browser
      'redirect':     { at: 0, text: 'NO REPLY \u00b7 CHECK THE REDIRECT URI' }
    };
    var SETUP_ERRORS = {
      'format':         'NOT A CLIENT ID \u00b7 32 LETTERS AND DIGITS',
      'invalid-client': 'SPOTIFY DOES NOT KNOW THIS CLIENT ID',
      'unreachable':    'COULD NOT REACH SPOTIFY \u00b7 TRY AGAIN'
    };
    var setupErr = setup && !s.setupBusy && s.setupError ? (SETUP_ERRORS[s.setupError] || SETUP_ERRORS['invalid-client']) : null;
    var YELLOW = '#ffd23f';

    var ctaLabel = 'Continue with Spotify';
    var ctaAria = 'Continue with Spotify';
    if (connecting) { ctaLabel = 'Connecting…'; ctaAria = 'Connecting to Spotify'; }
    if (connected) { ctaLabel = 'Disconnect'; ctaAria = 'Disconnect from Spotify'; }
    if (failed) { ctaLabel = 'Try again'; ctaAria = 'Try connecting to Spotify again'; }
    // nothing failed: sign in again, as at first launch
    if (failed && s.failKind === 'rescope') { ctaLabel = 'Continue with Spotify'; ctaAria = 'Sign in to Spotify again to grant new permissions'; }
    if (setup) { ctaLabel = s.setupBusy ? 'Checking\u2026' : 'Save Client ID'; ctaAria = 'Save your Spotify app\u2019s Client ID'; }
    if (welcome) { ctaLabel = 'Get started'; ctaAria = 'Set up Winify with your Spotify app'; }
    if (!setup && s.autoSignIn) { ctaLabel = 'Connecting\u2026'; ctaAria = 'Connecting to Spotify'; }

    // connected turns the same glass button red
    var ctaBase = connected ? '#e5352b' : action;

    var lit = s.btnHover === true && powered && !connecting;

    var topMix = lit ? 0.2 : 0.44;
    var botMix = lit ? 0.5 : 0.72;
    var topA = lit ? 0.9 : 0.8;
    var botA = lit ? 0.97 : 0.93;

    var ctaBg = 'linear-gradient(180deg, ' + this.mixAlpha(ctaBase, false, topMix, topA) + ' 0%, ' + this.mixAlpha(ctaBase, false, botMix, botA) + ' 100%)';
    var ctaShadow = (lit
      ? '0 0 72px 6px ' + this.alpha(ctaBase, 0.5) + ', 0 0 26px ' + this.alpha(ctaBase, 0.4) + ', '
      : '0 0 30px ' + this.alpha(ctaBase, 0.16) + ', ')
      + '0 10px 24px rgba(0,0,0,.36), inset 0 2px 1px rgba(255,255,255,' + (lit ? '.5' : '.34') + '), inset 0 -12px 26px rgba(0,0,0,.34)';
    var ctaBorder = lit ? this.mixAlpha(ctaBase, true, 0.5, 0.75) : 'rgba(255,255,255,.3)';


    return {
      accent: accent,
      accentLight: this.mix(accent, true, 0.45),
      accentHot: this.mix(accent, true, 0.62),
      accentDark: this.mix(accent, false, 0.3),
      accentCore: this.alpha(accent, powered && !asleep ? 0.85 : 0.1),
      accentGlow: this.alpha(accent, powered && !asleep ? 0.72 : 0.12),

      ledOpacity: powered ? (asleep ? 0.3 : 1) : 0.07,
      screenOpacity: asleep ? 0.16 : 1,

      screenLogo: powered,
      screenOff: !powered,
      standbyText: 'STANDBY',
      standbyDot: this.alpha(accent, 0.5),

      liveClass: !live ? '' : (failed ? 'sa-still' : (connected ? 'sa-live' : 'sa-wave')),
      eqBars: eqBars,

      ctaLabel: ctaLabel,
      ctaAria: ctaAria,
      ctaBg: ctaBg,
      ctaShadow: ctaShadow,
      ctaBorder: ctaBorder,
      ctaDisabled: !powered || connecting || (setup && s.setupBusy) || s.autoSignIn === true,
      isConnecting: connecting || (setup && s.setupBusy) || s.autoSignIn === true,

      showSetup: setup && !welcome,
      showLogoParts: (!setup || welcome) && !redirectHelp && !nowPlaying,
      // Signed in, with a track: what is playing, attributed to Spotify with
      // its logo and a link back (Spotify's Developer Policy II.4-II.5 and
      // design guidelines). Before that, the wordmark.
      showNowPlaying: nowPlaying,
      npCover: nowPlaying ? (track.cover || NO_COVER) : NO_COVER,
      npCoverAlt: nowPlaying ? 'Album cover' + (track.album ? ': ' + track.album : '') : '',
      npTitle: nowPlaying ? track.title : '',
      npArtist: nowPlaying ? (track.artist || '') : '',
      npLinkLabel: s.spotifyApp === false ? 'GET SPOTIFY FREE' : 'PLAY ON SPOTIFY',
      npLinkTitle: s.spotifyApp === false ? 'Opens Spotify\u2019s download page' : 'Opens this track in the Spotify app',
      onOpenSpotify: function () { if (IPC && IPC.openInSpotify && nowPlaying) IPC.openInSpotify(track.uri); },
      showRedirectHelp: redirectHelp,
      showWaitHint: connecting && (s.step || 0) === 0,
      showChangeLink: !setup && !connecting && !connected && !s.autoSignIn && !!IPC,
      setupPlaceholder: s.setupCurrent ? 'now: ' + s.setupCurrent : 'paste your Client ID',
      showMark: !connected,

      statusIdle: setup ? (!s.setupBusy && !setupErr) : (!connecting && !connected && !failed && !s.autoSignIn),
      statusBusy: connecting || (setup && s.setupBusy),
      statusOn: connected || (!setup && s.autoSignIn === true),
      statusErr: failed || !!setupErr,
      statusText: welcome ? 'WELCOME \u00b7 FIRST-TIME SETUP'
        : setup ? (s.setupBusy ? 'CHECKING CLIENT ID\u2026' : setupErr || 'PASTE YOUR SPOTIFY CLIENT ID')
        : connected ? 'CONNECTED'
        : failed ? ((FAILS[s.failKind] || FAILS['network']).text)
        : connecting ? STEPS[Math.min(s.step || 0, STEPS.length - 1)]
        : s.autoSignIn ? 'CLIENT ID SAVED \u00b7 SIGNING YOU IN\u2026'
        : s.setupSaved ? 'CLIENT ID SAVED \u00b7 READY TO SIGN IN'
        : 'NOT CONNECTED',
      statusColor: (connected || (!setup && s.autoSignIn)) ? action : ((failed || setupErr) ? YELLOW : '#7d878f'),
      spinTrack: 'rgba(141,151,161,.28)',
      spinHead: '#b9c3cc',
      onLedBg: 'radial-gradient(circle at 38% 32%, ' + this.mix(action, true, 0.55) + ' 0%, ' + action + ' 45%, ' + this.mix(action, false, 0.35) + ' 100%)',
      onLedGlow: '0 0 12px 3px ' + this.alpha(action, 0.65) + ', inset 0 0 4px rgba(255,255,255,.5)',
      errLedBg: 'radial-gradient(circle at 38% 32%, ' + this.mix(YELLOW, true, 0.55) + ' 0%, ' + YELLOW + ' 45%, ' + this.mix(YELLOW, false, 0.35) + ' 100%)',
      errLedGlow: '0 0 12px 3px ' + this.alpha(YELLOW, 0.6) + ', inset 0 0 4px rgba(255,255,255,.5)',

      // package.json's version, from the app (blank in the design preview).
      versionLabel: IPC && IPC.version ? 'v' + IPC.version : '',

      remember: remember,
      lampBg: remember
        ? 'radial-gradient(circle at 38% 32%, ' + this.mix(action, true, 0.55) + ' 0%, ' + action + ' 44%, ' + this.mix(action, false, 0.35) + ' 100%)'
        : 'radial-gradient(circle at 38% 32%, #454c53 0%, #2c3238 60%, #1e2328 100%)',
      lampShadow: remember
        ? '0 0 18px 4px ' + this.alpha(action, 0.65) + ', 0 0 7px 2px ' + this.alpha(action, 0.85) + ', inset 0 0 6px rgba(255,255,255,.6)'
        : 'inset 0 2px 4px rgba(0,0,0,.7)',

      isAsleep: asleep,
      isOff: !powered,
      // In Winify's one window the yellow light minimizes everything to the
      // Dock and the red one closes everything (Winify stays in the menu bar,
      // music keeps playing). Without the app (the design preview) they still
      // sleep and power the display.
      sleepLabel: IPC ? 'Minimize Winify' : (asleep ? 'Wake the display' : 'Put the display to sleep'),
      powerLabel: IPC ? 'Close Winify' : (powered ? 'Power off' : 'Power on'),

      onSleep: function () {
        if (IPC) { IPC.windowCommand('minimize'); return; }
        if (!powered) { return; }
        self.setState({ asleep: !asleep });
      },
      onPower: function () {
        if (IPC) { IPC.windowCommand('hide'); return; }
        if (self.timer) { clearInterval(self.timer); self.timer = null; }
        self.setState({ powered: !powered, asleep: false, status: 'idle', step: 0 });
      },
      onRemember: function () {
        var next = !remember;
        self.setState({ remember: next });
        if (IPC) { IPC.setRemember(next); }
      },
      onCtaEnter: function () {
        self.setState({ btnHover: true });
      },
      onCtaLeave: function () {
        self.setState({ btnHover: false });
      },
      onSetupKey: function (e) {
        if (e.key === 'Enter') { e.preventDefault(); self.submitSetup(); }
      },
      onGuide: function () {
        if (IPC && IPC.openSetupGuide) { IPC.openSetupGuide(); }
      },
      onChangeId: function () {
        if (IPC && IPC.changeClientId) { IPC.changeClientId(); }
      },
      onAuth: function () {
        if (welcome) {
          self.setState({ setupWelcome: false });
          setTimeout(function () { var f = document.getElementById('sa-client-id'); if (f) { f.focus(); } }, 0);
          return;
        }
        if (setup) { self.submitSetup(); return; }
        if (!powered || connecting || s.autoSignIn) { return; }
        if (connected) {
          if (IPC) { IPC.disconnect(); }
          self.setState({ status: 'idle', step: 0 });
          return;
        }
        self.startSignIn();
      }
    };
  }
}
  /* ------------------------------------------ */

  var WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;
  var HOLE  = /\{\{\s*([^}]+?)\s*\}\}/g;

  function resolve(path, scope) {
    path = path.trim();
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    var parts = path.split('.');
    var v = (scope && Object.prototype.hasOwnProperty.call(scope, parts[0])) ? scope[parts[0]]() : vals[parts[0]];
    for (var i = 1; i < parts.length && v != null; i++) v = v[parts[i]];
    return v;
  }
  function interp(str, scope) {
    return str.replace(HOLE, function (_, p) { var v = resolve(p, scope); return v == null ? '' : String(v); });
  }

  function bindAttrs(el, scope) {
    Array.prototype.slice.call(el.attributes).forEach(function (a) {
      var name = a.name, val = a.value;
      if (name.indexOf('hint-') === 0) { el.removeAttribute(name); return; }
      if (val.indexOf('{{') < 0) return;
      var whole = val.match(WHOLE);
      if (name.indexOf('on') === 0 && whole) {
        el.removeAttribute(name);
        var expr = whole[1];
        el.addEventListener(name.slice(2), function (e) {
          var fn = resolve(expr, scope);
          if (typeof fn === 'function') fn(e);
        });
        return;
      }
      if ((name === 'disabled' || name === 'checked') && whole) {
        el.removeAttribute(name);
        var e2 = whole[1];
        bindings.push(function () { el[name] = !!resolve(e2, scope); });
        return;
      }
      bindings.push(function () { el.setAttribute(name, interp(val, scope)); });
    });
  }

  function walk(node, scope) {
    if (node.nodeType === 3) {
      var t = node.nodeValue;
      if (t.indexOf('{{') >= 0) bindings.push(function () { node.nodeValue = interp(t, scope); });
      return;
    }
    if (node.nodeType !== 1) return;
    var tag = node.tagName.toLowerCase();

    if (tag === 'sc-for') {
      var listExpr = (node.getAttribute('list') || '').replace(HOLE, '$1').trim();
      var as = node.getAttribute('as') || 'item';
      var proto = Array.prototype.slice.call(node.childNodes);
      proto.forEach(function (c) { node.removeChild(c); });
      var items = resolve(listExpr, scope) || [];
      items.forEach(function (_, i) {
        var sc = Object.assign({}, scope);
        sc[as] = function () { var l = resolve(listExpr, scope) || []; return l[i]; };
        sc.$index = function () { return i; };
        proto.forEach(function (c) {
          var clone = c.cloneNode(true);
          node.appendChild(clone);
          walk(clone, sc);
        });
      });
      Array.prototype.slice.call(node.attributes).forEach(function (a) { node.removeAttribute(a.name); });
      return;
    }

    if (tag === 'sc-if') {
      var condExpr = (node.getAttribute('value') || '').replace(HOLE, '$1').trim();
      Array.prototype.slice.call(node.attributes).forEach(function (a) { node.removeAttribute(a.name); });
      Array.prototype.slice.call(node.childNodes).forEach(function (c) { walk(c, scope); });
      var mark = document.createComment('if');
      node.parentNode.insertBefore(mark, node);
      bindings.push(function () {
        var on = !!resolve(condExpr, scope);
        if (on && !node.parentNode) mark.parentNode.insertBefore(node, mark.nextSibling);
        else if (!on && node.parentNode) node.parentNode.removeChild(node);
      });
      return;
    }

    bindAttrs(node, scope);
    Array.prototype.slice.call(node.childNodes).forEach(function (c) { walk(c, scope); });
  }

  function update() {
    vals = comp.renderVals();
    for (var i = 0; i < bindings.length; i++) bindings[i]();
  }

  // The chassis box: the drawn chassis at the sign-in scale, the design
  // shifted so the chassis sits at the box's corner.
  function fit(box, stage) {
    var s = SIGN_IN_SCALE;
    box.style.width = Math.round(CHASSIS.w * s) + 'px';
    box.style.height = Math.round(CHASSIS.h * s) + 'px';
    stage.style.transform = 'translate(' + (-CHASSIS.x * s) + 'px, ' + (-CHASSIS.y * s) + 'px) scale(' + s + ')';
  }

  // ---- Where the chassis sits ------------------------------------------------
  // In Winify's see-through window it stays on screen, signed in or not:
  // bottom-right by default, wherever it was dragged to after that.
  var PLACE_KEY = 'winify.chassis.v1';
  var MARGIN = 16;

  function place(box, spot) {
    var w = box.offsetWidth, h = box.offsetHeight;
    var x = spot ? spot.x : window.innerWidth - w - MARGIN;
    var y = spot ? spot.y : window.innerHeight - h - MARGIN;
    x = Math.max(0, Math.min(x, window.innerWidth - w));
    y = Math.max(0, Math.min(y, window.innerHeight - h));
    box.style.left = Math.round(x) + 'px';
    box.style.top = Math.round(y) + 'px';
  }

  function savedSpot() {
    try { var s = JSON.parse(localStorage.getItem(PLACE_KEY)); return s && isFinite(s.x) && isFinite(s.y) ? s : null; } catch (e) { return null; }
  }

  // Dragged by its body; its buttons, lamp and field keep their clicks.
  function draggable(box) {
    box.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || e.target.closest('button, input, a, label, textarea, select, [role=button], [role=checkbox]')) return;
      e.preventDefault();
      box.setPointerCapture(e.pointerId);
      var sx = e.clientX, sy = e.clientY, ox = box.offsetLeft, oy = box.offsetTop;
      function move(ev) { place(box, { x: ox + ev.clientX - sx, y: oy + ev.clientY - sy }); }
      function up() {
        box.removeEventListener('pointermove', move);
        box.removeEventListener('pointerup', up);
        box.removeEventListener('pointercancel', up);
        try { localStorage.setItem(PLACE_KEY, JSON.stringify({ x: box.offsetLeft, y: box.offsetTop })); } catch (err) { /* storage unavailable */ }
        // The side panels' stack keeps clear of the chassis (webamp-panels.js).
        window.dispatchEvent(new CustomEvent('winify:chassis-moved'));
      }
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', up);
      box.addEventListener('pointercancel', up);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    comp = new Component(PROPS);
    vals = comp.renderVals();
    var stage = document.getElementById('sa-stage');
    var frag = document.getElementById('sa-template').content.cloneNode(true);
    var holder = document.createElement('div');
    holder.style.display = 'contents';
    holder.appendChild(frag);
    walk(holder, null);
    update();
    while (holder.firstChild) stage.appendChild(holder.firstChild);
    var loginScreen = document.getElementById('login-screen');
    var appScreen = document.getElementById('app-screen');
    fit(loginScreen, stage);
    place(loginScreen, savedSpot());
    draggable(loginScreen);
    // The display changed size: keep it on screen (where it was, if it fits).
    window.addEventListener('resize', function () { place(loginScreen, { x: loginScreen.offsetLeft, y: loginScreen.offsetTop }); });

    if (!IPC) { return; }

    // The chassis stays; the player's windows come and go. is-active on the
    // chassis says it is in its signed-out state.
    function showApp(on) {
      loginScreen.classList.toggle('is-active', !on);
      appScreen.classList.toggle('is-active', on);
    }

    // Each handshake line is now a real phase reported by the main process.
    IPC.onAuthStep(function (step) {
      comp.setState({ status: 'connecting', step: step, failKind: null });
    });

    IPC.onAuthError(function (kind) {
      if (comp.timer) { clearInterval(comp.timer); comp.timer = null; }
      var next = { status: 'error', step: 0, failKind: kind };
      // main keeps "remember me" on for a re-sign-in; show the lamp lit too
      if (kind === 'rescope') { next.remember = true; }
      comp.setState(next);
    });

    // CONNECTED, with Disconnect, stays on the chassis; the player's windows
    // come up beside it a moment later.
    IPC.onAuthConnected(function () {
      comp.setState({ status: 'connected', step: 0, failKind: null });
      setTimeout(function () { showApp(true); }, 1100);
    });

    // Stored token found at launch: straight to CONNECTED and the player.
    IPC.onAuthRestored(function () {
      comp.setState({ status: 'connected', step: 0, remember: true, failKind: null });
      showApp(true);
    });

    // No Client ID yet, a new one wanted, or Spotify no longer knows it.
    IPC.onAuthSetup(function (info) {
      if (comp.timer) { clearInterval(comp.timer); comp.timer = null; }
      comp.setState({ setup: true, setupWelcome: !!(info && info.firstRun), setupFirstRun: !!(info && info.firstRun), setupBusy: false, setupError: (info && info.error) || null,
        setupCurrent: (info && info.current) || null, setupSaved: false, status: 'idle', step: 0, failKind: null });
      showApp(false);
      setTimeout(function () {
        var field = document.getElementById('sa-client-id');
        if (field) { field.value = ''; field.focus(); }
      }, 0);
    });

    IPC.onSignedOut(function () {
      comp.setState({ status: 'idle', step: 0, failKind: null, track: null });
      showApp(false);
    });

    // What is playing, from the player (webamp-spotify.js); and whether the
    // Spotify app is here, for the link's wording.
    function checkSpotifyApp() {
      if (!IPC.spotifyAppInstalled) return;
      IPC.spotifyAppInstalled().then(function (yes) { comp.setState({ spotifyApp: !!yes }); }).catch(function () {});
    }
    window.addEventListener('winify:now-playing', function (e) {
      var track = e.detail || null;
      var was = comp.state.track;
      comp.setState({ track: track });
      if (track && (!was || was.uri !== track.uri)) checkSpotifyApp();   // installed or removed meanwhile
    });
    checkSpotifyApp();

    IPC.ready();
  });
})();

