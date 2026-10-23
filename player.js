/* Winify in-app playback.
 *
 * Registers this app as a Spotify Connect device called "Winify" via the
 * Web Playback SDK, so audio comes out of Winify itself.
 *
 * Every playback command below is a standalone named function on
 * window.WinifyPlayer. The Winamp skin should call these rather than
 * touching the SDK directly, so the interface can be rebuilt without
 * rewriting any playback logic.
 */
(function () {
  'use strict';

  var player = null;      // Spotify.Player instance
  var stateListeners = [];  // onStateChange(fn): every SDK state change, null when not active
  var deviceId = null;    // assigned once the device registers
  var isReady = false;
  var lastState = null;   // previous playback state, for spotting stalls/skips
  var lastTrackId = null;

  function mmss(ms) {
    var total = Math.round((Number(ms) || 0) / 1000);
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  function setPlayerStatus(text) {
    var el = document.getElementById('player-status');
    if (el) el.textContent = text;
  }

  // Errors are reported verbatim. A licence or account failure here is the
  // difference between "working" and "silently no audio", so nothing is
  // summarised or swallowed.
  function report(kind, message) {
    var line = '[winify/player] ' + kind + ': ' + message;
    console.error(line);
    setPlayerStatus(kind + ' - ' + message);
  }

  function requireReady(action) {
    if (!player || !isReady) {
      report('not_ready', 'cannot ' + action + ' - player has not registered yet');
      return false;
    }
    return true;
  }

  // ---- Playback commands ---------------------------------------------
  // One command per function, each safe to call from any UI.

  function play() {
    if (!requireReady('play')) return Promise.resolve(false);
    return player.resume()
      .then(function () { return true; })
      .catch(function (e) { report('play_failed', String(e && e.message || e)); return false; });
  }

  function pause() {
    if (!requireReady('pause')) return Promise.resolve(false);
    return player.pause()
      .then(function () { return true; })
      .catch(function (e) { report('pause_failed', String(e && e.message || e)); return false; });
  }

  function togglePlay() {
    if (!requireReady('toggle play')) return Promise.resolve(false);
    return player.togglePlay()
      .then(function () { return true; })
      .catch(function (e) { report('toggle_failed', String(e && e.message || e)); return false; });
  }

  function nextTrack() {
    if (!requireReady('skip forward')) return Promise.resolve(false);
    return player.nextTrack()
      .then(function () { return true; })
      .catch(function (e) { report('next_failed', String(e && e.message || e)); return false; });
  }

  function previousTrack() {
    if (!requireReady('skip back')) return Promise.resolve(false);
    return player.previousTrack()
      .then(function () { return true; })
      .catch(function (e) { report('previous_failed', String(e && e.message || e)); return false; });
  }

  // fraction: 0 to 1
  function setVolume(fraction) {
    if (!requireReady('set volume')) return Promise.resolve(false);
    var v = Math.max(0, Math.min(1, Number(fraction)));
    return player.setVolume(v)
      .then(function () { return true; })
      .catch(function (e) { report('volume_failed', String(e && e.message || e)); return false; });
  }

  // fraction 0 to 1, or null when not ready. Local: no request to Spotify.
  function getVolume() {
    if (!player) return Promise.resolve(null);
    return player.getVolume().catch(function () { return null; });
  }

  function seek(positionMs) {
    if (!requireReady('seek')) return Promise.resolve(false);
    return player.seek(Math.max(0, Math.round(Number(positionMs))))
      .then(function () { return true; })
      .catch(function (e) { report('seek_failed', String(e && e.message || e)); return false; });
  }

  function getState() {
    if (!player) return Promise.resolve(null);
    return player.getCurrentState().catch(function () { return null; });
  }

  function getDeviceId() {
    return deviceId;
  }

  // Moves the active Spotify session onto this device.
  function transferPlaybackHere(startPlaying) {
    if (!deviceId) {
      report('no_device', 'device has not registered yet');
      return Promise.resolve(false);
    }
    return window.spotify.transferPlayback(deviceId, startPlaying === true)
      .then(function (r) {
        if (r && r.ok) {
          setPlayerStatus('Playback transferred to Winify');
          return true;
        }
        report('transfer_failed', (r && r.error) || 'unknown error');
        return false;
      });
  }

  // ---- SDK lifecycle ---------------------------------------------------

  // Empirical CDM check, run at the moment the SDK starts. components.status()
  // reporting "new" tells us about the component registration, not whether
  // Widevine can actually be used from this origin -- this does.
  function probeWidevine() {
    if (!navigator.requestMediaKeySystemAccess) {
      report('eme_missing', 'navigator.requestMediaKeySystemAccess is not available');
      return Promise.resolve(false);
    }
    var config = [{
      initDataTypes: ['cenc'],
      audioCapabilities: [
        { contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness: 'SW_SECURE_CRYPTO' }
      ],
    }];
    return navigator.requestMediaKeySystemAccess('com.widevine.alpha', config)
      .then(function (access) { return access.createMediaKeys(); })
      .then(function () {
        console.log('[winify/player] Widevine USABLE from origin', location.origin,
          '| secureContext=' + window.isSecureContext);
        return true;
      })
      .catch(function (e) {
        report('widevine_unavailable', 'origin ' + location.origin + ' - ' + String(e && e.message || e));
        return false;
      });
  }

  function start() {
    if (player) return;
    if (!window.Spotify || !window.Spotify.Player) {
      report('sdk_missing', 'the Web Playback SDK script did not load');
      return;
    }

    probeWidevine();

    setPlayerStatus('Registering Winify as a playback device...');

    player = new window.Spotify.Player({
      name: 'Winify',
      volume: 0.5,
      getOAuthToken: function (cb) {
        window.spotify.getToken().then(function (token) {
          if (!token) {
            report('no_token', 'main process returned no access token');
            return;
          }
          cb(token);
        });
      },
    });

    // Every failure mode the SDK reports, surfaced verbatim. The message alone
    // is often just "Playback error", so dump the whole object too -- any extra
    // fields the SDK attaches are exactly what we're missing.
    function detail(e) {
      var extra = '';
      try {
        var own = {};
        Object.getOwnPropertyNames(e || {}).forEach(function (k) { own[k] = e[k]; });
        extra = ' | raw=' + JSON.stringify(own);
      } catch (err) { extra = ' | raw unavailable'; }
      return String((e && e.message) || e) + extra;
    }
    player.addListener('initialization_error', function (e) { report('initialization_error', detail(e)); });
    player.addListener('authentication_error', function (e) { report('authentication_error', detail(e)); });
    player.addListener('account_error', function (e) { report('account_error', detail(e)); });
    player.addListener('playback_error', function (e) { report('playback_error', detail(e)); });

    player.addListener('ready', function (e) {
      deviceId = e.device_id;
      isReady = true;
      console.log('[winify/player] device registered, id:', deviceId);
      setPlayerStatus('Winify is available as a Spotify device (' + deviceId.slice(0, 8) + '...)');
    });

    player.addListener('not_ready', function (e) {
      isReady = false;
      console.warn('[winify/player] device went offline:', e.device_id);
      setPlayerStatus('Winify device is offline');
    });

    player.addListener('autoplay_failed', function () {
      report('autoplay_failed', 'browser blocked autoplay');
    });

    player.addListener('player_state_changed', function (state) {
      stateListeners.forEach(function (fn) { try { fn(state); } catch (e) { /* a listener's own problem */ } });
      if (!state) return;
      var track = state.track_window && state.track_window.current_track;
      if (track) {
        setPlayerStatus((state.paused ? 'Paused: ' : 'Playing: ') + track.name +
          ' - ' + track.artists.map(function (a) { return a.name; }).join(', '));
      }
      var seekEl = document.getElementById('seek');
      if (seekEl && state.duration) seekEl.value = String(Math.round((state.position / state.duration) * 100));

      // Diagnostics for unexpected stops and skips: log only the transitions
      // that matter, with where in the track they happened.
      var id = track ? track.id : null;
      var where = mmss(state.position) + '/' + mmss(state.duration);
      if (id !== lastTrackId) {
        // A track ending near its duration is normal; anything else is a skip.
        var earlier = lastState && !lastState.paused && lastState.duration &&
          lastState.position < lastState.duration - 5000;
        console.log('[winify/player] track changed ->', track ? track.name : '(none)',
          'at', where, earlier ? '*** PREVIOUS TRACK DID NOT FINISH (skipped at ' +
            mmss(lastState.position) + '/' + mmss(lastState.duration) + ') ***' : '');
        lastTrackId = id;
      } else if (lastState && lastState.paused !== state.paused) {
        console.log('[winify/player]', state.paused ? 'PAUSED' : 'resumed', 'at', where);
      }
      lastState = { paused: state.paused, position: state.position, duration: state.duration };
    });

    player.connect().then(function (ok) {
      if (!ok) report('connect_failed', 'player.connect() returned false');
    }).catch(function (e) {
      report('connect_threw', String(e && e.message || e));
    });
  }

  function stop() {
    if (!player) return;
    try { player.disconnect(); } catch (e) { /* already gone */ }
    player = null;
    deviceId = null;
    isReady = false;
    setPlayerStatus('Player stopped');
  }

  // The SDK calls this once its script finishes loading.
  window.onSpotifyWebPlaybackSDKReady = function () {
    console.log('[winify/player] Web Playback SDK loaded');
    window.WinifyPlayer.sdkLoaded = true;
    if (window.WinifyPlayer.startRequested) start();
  };

  window.WinifyPlayer = {
    // playback commands - the Winamp skin wires to these
    play: play,
    pause: pause,
    togglePlay: togglePlay,
    nextTrack: nextTrack,
    previousTrack: previousTrack,
    setVolume: setVolume,
    getVolume: getVolume,
    seek: seek,
    onStateChange: function (fn) {
      stateListeners.push(fn);
      return function () { stateListeners = stateListeners.filter(function (f) { return f !== fn; }); };
    },
    // state + lifecycle
    getState: getState,
    getDeviceId: getDeviceId,
    transferPlaybackHere: transferPlaybackHere,
    start: function () {
      window.WinifyPlayer.startRequested = true;
      if (window.WinifyPlayer.sdkLoaded) start();
      else setPlayerStatus('Waiting for the Web Playback SDK to load...');
    },
    stop: stop,
    sdkLoaded: false,
    startRequested: false,
  };
})();
