/* EME/Widevine instrumentation for the main frame.
 *
 * Inert unless the page is loaded with ?drmdebug=1 (set by `npm start -- --drm-debug`).
 * Wraps the Encrypted Media Extensions entry points so every licence exchange
 * and key-status transition is logged verbatim.
 *
 * Caveat: the Spotify SDK may run its playback in a cross-origin iframe, in
 * which case these hooks see nothing and the CDP-level logging in main.js is
 * the only source. Absence of output here is itself a useful signal.
 */
(function () {
  'use strict';
  try {
    if (!new URLSearchParams(location.search).get('drmdebug')) return;
  } catch (e) { return; }

  var t0 = Date.now();
  function stamp() { return '+' + ((Date.now() - t0) / 1000).toFixed(1) + 's'; }
  function log() {
    var args = ['[drm/eme]', stamp()].concat(Array.prototype.slice.call(arguments));
    console.log.apply(console, args);
  }

  log('instrumentation active in frame', location.href.slice(0, 80));

  function watchSession(session, label) {
    log('session created', label, 'id=' + (session.sessionId || '(pending)'));

    session.addEventListener('keystatuseschange', function () {
      var statuses = [];
      try {
        session.keyStatuses.forEach(function (status, keyId) {
          var hex = '';
          try {
            hex = Array.from(new Uint8Array(keyId.buffer || keyId))
              .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('').slice(0, 16);
          } catch (e) { hex = '?'; }
          statuses.push(hex + '=' + status);
        });
      } catch (e) { statuses.push('unreadable: ' + e.message); }
      // usable / expired / released / output-restricted / output-downscaled
      // / status-pending / internal-error
      log('KEYSTATUSESCHANGE', statuses.join(', ') || '(empty)');
    });

    session.addEventListener('message', function (ev) {
      log('LICENCE REQUEST message', 'type=' + ev.messageType,
        'bytes=' + (ev.message && ev.message.byteLength));
    });

    session.closed.then(function () { log('session CLOSED', label); }).catch(function () {});

    var origUpdate = session.update.bind(session);
    session.update = function (response) {
      log('LICENCE RESPONSE applied', 'bytes=' + (response && (response.byteLength || response.length)));
      return origUpdate(response).then(function (r) {
        log('licence update OK');
        return r;
      }).catch(function (e) {
        log('*** LICENCE UPDATE FAILED ***', String(e && e.message || e));
        throw e;
      });
    };

    var origGenerate = session.generateRequest.bind(session);
    session.generateRequest = function (initDataType, initData) {
      log('generateRequest', initDataType, 'bytes=' + (initData && initData.byteLength));
      return origGenerate(initDataType, initData).catch(function (e) {
        log('*** generateRequest FAILED ***', String(e && e.message || e));
        throw e;
      });
    };
  }

  var origAccess = navigator.requestMediaKeySystemAccess.bind(navigator);
  navigator.requestMediaKeySystemAccess = function (keySystem, configs) {
    log('requestMediaKeySystemAccess', keySystem, JSON.stringify(configs).slice(0, 300));
    return origAccess(keySystem, configs).then(function (access) {
      try { log('access granted, config:', JSON.stringify(access.getConfiguration()).slice(0, 300)); } catch (e) {}
      var origCreate = access.createMediaKeys.bind(access);
      access.createMediaKeys = function () {
        return origCreate().then(function (keys) {
          log('MediaKeys created');
          var origSession = keys.createSession.bind(keys);
          keys.createSession = function (type) {
            var s = origSession(type);
            watchSession(s, type || 'temporary');
            return s;
          };
          return keys;
        });
      };
      return access;
    }).catch(function (e) {
      log('*** requestMediaKeySystemAccess FAILED ***', String(e && e.message || e));
      throw e;
    });
  };
})();
