
(function () {
  'use strict';
  var PROPS = {"accent": "#ffb300", "action": "#1ed760", "outcome": "success"};
  // no Tweaks panel here: ?outcome=free-account or ?outcome=network demos the error state
  var DEMO = false;
  try { var q = new URLSearchParams(location.search).get('outcome'); if (q) { PROPS.outcome = q; DEMO = true; } } catch (e) {}
  var IPC = (typeof window !== 'undefined' && window.spotify) ? window.spotify : null;
  var W = 1280, H = 1070;

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
    this.state = { powered: true, asleep: false, remember: false, status: 'idle', step: 0, btnHover: false };
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

  renderVals() {
    var self = this;
    var s = this.state || {};
    var accent = this.props.accent || '#ff7a18';
    var action = this.props.action || '#1ed760';

    var powered = s.powered !== false;
    var asleep = powered && s.asleep === true;
    var status = powered ? (s.status || 'idle') : 'idle';
    var remember = s.remember === true;

    var connecting = status === 'connecting';
    var connected = status === 'connected';
    var failed = status === 'error';
    var live = powered && !asleep;

    var eqHeights = [21, 35, 54, 72, 47, 63, 84, 58, 40, 26];
    var eqDur   = [1050, 1550, 920, 1310, 1750, 1160, 1460, 1000, 1650, 1240];
    var eqDelay = [-220, -1040, -460, -1500, -70, -800, -1220, -600, -320, -950];
    var eqShape = [1, 2, 3, 1, 3, 2, 1, 3, 2, 1];
    var eqBars = eqHeights.map(function (h, i) {
      return { h: h, d: eqDelay[i], t: eqDur[i], cls: 'sa-bar' + (eqShape[i] > 1 ? ' sa-v' + eqShape[i] : '') };
    });

    var STEPS = ['HANDSHAKE \u203a SPOTIFY API\u2026', 'EXCHANGING AUTH TOKEN\u2026', 'VERIFYING PREMIUM\u2026', 'SYNCING LIBRARY\u2026'];
    // demo outcome (Tweaks): where the handshake stops, and what it says
    var FAILS = {
      'free-account': { at: 2, text: 'SPOTIFY PREMIUM NOT DETECTED' },
      'network':      { at: 0, text: 'CONNECTION FAILED \u00b7 NO RESPONSE' }
    };
    var YELLOW = '#ffd23f';

    var ctaLabel = 'Continue with Spotify';
    var ctaAria = 'Continue with Spotify';
    if (connecting) { ctaLabel = 'Connecting…'; ctaAria = 'Connecting to Spotify'; }
    if (connected) { ctaLabel = 'Disconnect'; ctaAria = 'Disconnect from Spotify'; }
    if (failed) { ctaLabel = 'Try again'; ctaAria = 'Try connecting to Spotify again'; }

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

      liveClass: live ? 'sa-live' : '',
      eqBars: eqBars,

      ctaLabel: ctaLabel,
      ctaAria: ctaAria,
      ctaBg: ctaBg,
      ctaShadow: ctaShadow,
      ctaBorder: ctaBorder,
      ctaDisabled: !powered || connecting,
      isConnecting: connecting,
      showMark: !connected,

      statusIdle: !connecting && !connected && !failed,
      statusBusy: connecting,
      statusOn: connected,
      statusErr: failed,
      statusText: connected ? 'CONNECTED'
        : failed ? ((FAILS[s.failKind] || FAILS['network']).text)
        : connecting ? STEPS[Math.min(s.step || 0, STEPS.length - 1)]
        : 'NOT CONNECTED',
      statusColor: connected ? action : (failed ? YELLOW : '#7d878f'),
      spinTrack: 'rgba(141,151,161,.28)',
      spinHead: '#b9c3cc',
      onLedBg: 'radial-gradient(circle at 38% 32%, ' + this.mix(action, true, 0.55) + ' 0%, ' + action + ' 45%, ' + this.mix(action, false, 0.35) + ' 100%)',
      onLedGlow: '0 0 12px 3px ' + this.alpha(action, 0.65) + ', inset 0 0 4px rgba(255,255,255,.5)',
      errLedBg: 'radial-gradient(circle at 38% 32%, ' + this.mix(YELLOW, true, 0.55) + ' 0%, ' + YELLOW + ' 45%, ' + this.mix(YELLOW, false, 0.35) + ' 100%)',
      errLedGlow: '0 0 12px 3px ' + this.alpha(YELLOW, 0.6) + ', inset 0 0 4px rgba(255,255,255,.5)',

      remember: remember,
      lampBg: remember
        ? 'radial-gradient(circle at 38% 32%, ' + this.mix(action, true, 0.55) + ' 0%, ' + action + ' 44%, ' + this.mix(action, false, 0.35) + ' 100%)'
        : 'radial-gradient(circle at 38% 32%, #454c53 0%, #2c3238 60%, #1e2328 100%)',
      lampShadow: remember
        ? '0 0 18px 4px ' + this.alpha(action, 0.65) + ', 0 0 7px 2px ' + this.alpha(action, 0.85) + ', inset 0 0 6px rgba(255,255,255,.6)'
        : 'inset 0 2px 4px rgba(0,0,0,.7)',

      isAsleep: asleep,
      isOff: !powered,
      sleepLabel: asleep ? 'Wake the display' : 'Put the display to sleep',
      powerLabel: powered ? 'Power off' : 'Power on',

      onSleep: function () {
        if (!powered) { return; }
        self.setState({ asleep: !asleep });
      },
      onPower: function () {
        if (self.timer) { clearInterval(self.timer); self.timer = null; }
        if (IPC) { IPC.cancelLogin(); }
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
      onAuth: function () {
        if (!powered || connecting) { return; }
        if (connected) {
          if (IPC) { IPC.disconnect(); }
          self.setState({ status: 'idle', step: 0 });
          return;
        }
        if (self.timer) { clearInterval(self.timer); self.timer = null; }
        self.setState({ status: 'connecting', step: 0, asleep: false, failKind: null });

        // Real login. Main process drives step/error/connected over IPC.
        if (IPC && !DEMO) { IPC.login(); return; }

        // Demo fallback (?outcome=... or opened outside Electron): the
        // original simulated walk, untouched.
        self.timer = setInterval(function () {
          var cur = (self.state && self.state.step) || 0;
          var fail = FAILS[self.props.outcome];
          if (fail && cur >= fail.at) {
            clearInterval(self.timer); self.timer = null;
            self.setState({ status: 'error', step: 0, failKind: self.props.outcome });
            return;
          }
          var next = cur + 1;
          if (next >= STEPS.length) {
            clearInterval(self.timer); self.timer = null;
            self.setState({ status: 'connected', step: 0 });
          } else {
            self.setState({ step: next });
          }
        }, 700);
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

  function fit(stage) {
    var s = Math.min(window.innerWidth / W, window.innerHeight / H, 1);
    stage.style.transform = 'scale(' + s + ')';
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
    fit(stage);
    window.addEventListener('resize', function () { fit(stage); });

    if (!IPC) { return; }

    var loginScreen = document.getElementById('login-screen');
    var appScreen = document.getElementById('app-screen');
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
      comp.setState({ status: 'error', step: 0, failKind: kind });
    });

    // Hold CONNECTED long enough to read, then hand over to the app view.
    IPC.onAuthConnected(function () {
      comp.setState({ status: 'connected', step: 0, failKind: null });
      setTimeout(function () { showApp(true); }, 1100);
    });

    // Stored token found at launch: never show this screen at all.
    IPC.onAuthRestored(function () {
      comp.setState({ status: 'connected', step: 0, remember: true, failKind: null });
      showApp(true);
    });

    IPC.onSignedOut(function () {
      comp.setState({ status: 'idle', step: 0, failKind: null });
      showApp(false);
    });

    IPC.ready();
  });
})();

