/* Winify audio source.
 *
 * Captures the system's audio output and publishes it as ONE shared analysis
 * stream that any number of visualizers can consume. Spotify's audio is
 * DRM-protected, so its waveform cannot be read from the playback SDK; what
 * leaves the speakers can be.
 *
 * Capture relies on a virtual loopback device (BlackHole or similar) being the
 * system output. Electron's getDisplayMedia loopback path was tried first and
 * does not deliver audio on macOS -- the track arrives already 'ended'.
 *
 * This module knows nothing about drawing. Two kinds of consumer are supported
 * deliberately, because the two planned visualizers need different things:
 *
 *   subscribe(fn)   -> byte arrays per frame, for spectrum bars and
 *                      oscilloscope traces (classic-skin style)
 *   getAudioContext() + getSourceNode()
 *                   -> raw nodes, for Butterchurn, which attaches its own
 *                      analysis and will not consume byte arrays
 *
 * There is exactly one AnalyserNode and one animation loop no matter how many
 * subscribers attach.
 */
(function () {
  'use strict';

  var stream = null;
  var context = null;
  var sourceNode = null;
  var analyser = null;
  var rafId = null;

  var freqBuf = null;   // reused every frame; never reallocated per frame
  var timeBuf = null;

  var subscribers = [];
  // Rendering is pointless while the window is hidden, but the analyser keeps
  // reading so levels and state stay current for whatever is watching.
  var visible = true;
  var listeners = [];
  var logging = true;
  var lastLogAt = 0;
  var peak = 0;

  var DEFAULT_FFT = 2048;   // 1024 frequency bins, a good spectrum/CPU balance

  function log() {
    var args = ['[winify/audio]'].concat(Array.prototype.slice.call(arguments));
    console.log.apply(console, args);
  }

  function emit(event, detail) {
    listeners.forEach(function (fn) {
      try { fn(event, detail); } catch (e) { /* a bad listener must not stop capture */ }
    });
  }

  function describeTrack(track) {
    var s = {};
    try { s = track.getSettings ? track.getSettings() : {}; } catch (e) {}
    return {
      kind: track.kind, label: track.label, readyState: track.readyState,
      muted: track.muted, enabled: track.enabled,
      sampleRate: s.sampleRate, channelCount: s.channelCount,
    };
  }

  // ---- Device selection -------------------------------------------------
  // A virtual loopback device carries the system's own output, which is what
  // the visualizers want. Anything else is a stand-in and is called out.

  var LOOPBACK_RE = /blackhole|loopback|soundflower|multi-?output|aggregate|stereo mix/i;

  async function listDevices() {
    var devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(function (d) { return d.kind === 'audioinput'; });
  }

  // Strict by design. Falling back to the default input means silently
  // capturing the microphone -- the room instead of the music -- which looks
  // like it is working and is not. Refusing is the honest failure.
  function pickLoopback(inputs) {
    for (var i = 0; i < inputs.length; i++) {
      if (LOOPBACK_RE.test(inputs[i].label)) return inputs[i];
    }
    return null;
  }

  var NO_LOOPBACK_HELP =
    'No loopback audio device found. Winify analyses the sound leaving your ' +
    'speakers, which macOS cannot provide without a virtual device.\n' +
    'Install one and route audio through it:\n' +
    '  brew install blackhole-2ch   (then reboot)\n' +
    '  Audio MIDI Setup -> Create Multi-Output Device -> tick your speakers AND BlackHole\n' +
    '  System Settings -> Sound -> Output -> that Multi-Output Device\n' +
    'See README, "System audio capture".';

  // ---- Lifecycle --------------------------------------------------------

  var MIC_DENIED_HELP =
    'macOS has not allowed Winify to use audio input, which reading BlackHole ' +
    'needs (Winify never listens to the microphone itself). Turn Winify on in ' +
    'System Settings -> Privacy & Security -> Microphone, then restart Winify.';

  // One start at a time: macOS's microphone question can stay on screen for a
  // while, and a second start meanwhile would open a second stream.
  var starting = null;

  function start(opts) {
    if (!starting) starting = startCapture(opts).finally(function () { starting = null; });
    return starting;
  }

  async function startCapture(opts) {
    if (stream) { log('already capturing'); return true; }
    opts = opts || {};

    // macOS's answer first, so capture never races its question.
    if (window.spotify && window.spotify.microphoneAccess) {
      var access = await window.spotify.microphoneAccess().catch(function () { return 'unknown'; });
      if (access === 'denied' || access === 'restricted') {
        log('*** MICROPHONE ACCESS ' + access.toUpperCase() + ' - REFUSING TO CAPTURE ***');
        log(MIC_DENIED_HELP);
        emit('error', { message: 'microphone access ' + access, help: MIC_DENIED_HELP });
        return false;
      }
    }

    var inputs;
    try {
      // Device labels stay blank until permission is granted, so a throwaway
      // request may be needed before the loopback device can be recognised.
      inputs = await listDevices();
      if (inputs.length && !inputs[0].label) {
        // Device labels are hidden until this origin has been granted media
        // access once, and without labels the loopback device cannot be
        // identified. This opens the default input -- the microphone -- so it
        // lights the macOS recording indicator briefly. It should happen only
        // on the very first run: the app is served from a stable origin so the
        // grant persists. Seeing this on every launch means the origin moved.
        log('first run for this origin: briefly opening the default input to reveal device labels');
        var warm = await navigator.mediaDevices.getUserMedia({ audio: true });
        warm.getTracks().forEach(function (t) { t.stop(); });
        inputs = await listDevices();
      } else {
        log('device labels already available - microphone not touched');
      }
    } catch (err) {
      log('*** COULD NOT LIST DEVICES ***', String(err && err.name), String(err && err.message));
      emit('error', { message: String(err && err.message) });
      return false;
    }

    log('audio inputs:', inputs.map(function (d) { return d.label || '(unlabelled)'; }).join(' | ') || '(none)');

    var device = null;
    var isLoopback = false;

    if (opts.deviceId) {
      // Explicit override: the caller named a device, so honour it, but still
      // say plainly whether it is a loopback device.
      device = inputs.filter(function (d) { return d.deviceId === opts.deviceId; })[0] || null;
      isLoopback = !!(device && LOOPBACK_RE.test(device.label));
      if (!device) {
        log('*** REQUESTED DEVICE NOT FOUND ***', opts.deviceId);
        emit('error', { message: 'requested device not found' });
        return false;
      }
    } else {
      device = pickLoopback(inputs);
      isLoopback = !!device;

      if (!device) {
        if (!opts.allowAnyDevice) {
          log('*** NO LOOPBACK DEVICE - REFUSING TO CAPTURE ***');
          log(NO_LOOPBACK_HELP);
          log('audio inputs seen:', inputs.map(function (d) { return d.label || '(unlabelled)'; }).join(' | ') || '(none)');
          emit('error', { message: 'no loopback device', help: NO_LOOPBACK_HELP, devices: inputs.map(function (d) { return d.label; }) });
          return false;
        }
        // Opt-in escape hatch, used only for testing the pipeline itself.
        device = inputs[0] || null;
        if (!device) {
          log('*** NO AUDIO INPUT DEVICE AT ALL ***');
          emit('error', { message: 'no audio input device' });
          return false;
        }
        log('!!! allowAnyDevice: capturing a NON-loopback device - this hears the room, not the app');
      }
    }

    log('==> CAPTURE DEVICE:', device.label, isLoopback ? '[system loopback]' : '[NOT LOOPBACK]');

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: device.deviceId },
          // Speech processing would wreck a music spectrum.
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        },
      });
    } catch (err) {
      log('*** CAPTURE FAILED ***', String(err && err.name), String(err && err.message));
      emit('error', { message: String(err && err.message) });
      stream = null;
      return false;
    }

    var track = stream.getAudioTracks()[0];
    if (!track) {
      log('*** NO AUDIO TRACK ***');
      emit('error', { message: 'no audio track' });
      stop();
      return false;
    }

    log('audio track:', JSON.stringify(describeTrack(track)));
    // The device that actually opened, read back from the live track rather
    // than from what we asked for.
    if (!LOOPBACK_RE.test(track.label)) {
      log('*** WARNING: the OPEN TRACK is not a loopback device:', track.label);
    } else {
      log('confirmed: the open track is the loopback device,', track.label);
    }
    track.addEventListener('ended', function () {
      log('*** TRACK ENDED ***');
      emit('ended', {});
      stop();
    });

    context = new (window.AudioContext || window.webkitAudioContext)();
    if (context.state === 'suspended') await context.resume();
    sourceNode = context.createMediaStreamSource(stream);

    analyser = context.createAnalyser();
    analyser.fftSize = opts.fftSize || DEFAULT_FFT;
    // Without smoothing the bars strobe; this is the classic-visualizer feel.
    analyser.smoothingTimeConstant = opts.smoothing != null ? opts.smoothing : 0.8;
    sourceNode.connect(analyser);

    // NOTE: the analyser is intentionally NOT connected to context.destination.
    // Doing so would feed captured audio back into the output device, and with
    // a loopback device in the chain that is a feedback loop.

    allocateBuffers();
    peak = 0;
    log('analyser ready | fftSize', analyser.fftSize,
      '| bins', analyser.frequencyBinCount,
      '| sampleRate', context.sampleRate,
      '| bin width', (context.sampleRate / analyser.fftSize).toFixed(1) + 'Hz');

    startLoop();
    emit('started', {
      sampleRate: context.sampleRate, device: track.label,
      isLoopback: LOOPBACK_RE.test(track.label), binCount: analyser.frequencyBinCount,
    });
    return true;
  }

  function allocateBuffers() {
    freqBuf = new Uint8Array(analyser.frequencyBinCount);
    timeBuf = new Uint8Array(analyser.fftSize);
  }

  function stop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (context) { context.close().catch(function () {}); context = null; }
    sourceNode = null;
    analyser = null;
    freqBuf = timeBuf = null;
    log('stopped');
    emit('stopped', {});
  }

  // ---- The shared analysis loop ----------------------------------------
  // One rAF loop, one analyser read per frame, fanned out to every subscriber.
  // Buffers are reused, so subscribers must read them during their callback
  // rather than holding on to them.

  function tick() {
    rafId = requestAnimationFrame(tick);
    if (!analyser) return;

    analyser.getByteFrequencyData(freqBuf);
    analyser.getByteTimeDomainData(timeBuf);

    // RMS from the time domain, where 128 is silence.
    var sum = 0;
    for (var i = 0; i < timeBuf.length; i++) {
      var v = (timeBuf[i] - 128) / 128;
      sum += v * v;
    }
    var rms = Math.sqrt(sum / timeBuf.length);
    if (rms > peak) peak = rms;

    var frame = {
      frequency: freqBuf,
      timeDomain: timeBuf,
      rms: rms,
      peak: peak,
      silent: rms < 0.001,
      binCount: analyser.frequencyBinCount,
      sampleRate: context ? context.sampleRate : 0,
    };

    for (var j = 0; j < subscribers.length; j++) {
      var sub = subscribers[j];
      // Visualizers idle while nobody can see them; subscribers that asked to
      // run regardless still get every frame.
      if (!visible && !sub.whenHidden) continue;
      // One broken visualizer must not take down the others.
      try { sub.fn(frame); } catch (e) { /* ignore */ }
    }

    if (logging) {
      var now = performance.now();
      if (now - lastLogAt > 1000) {
        lastLogAt = now;
        var bars = Math.min(40, Math.round(rms * 200));
        log('level', rms.toFixed(4),
          '|' + '#'.repeat(bars) + ' '.repeat(40 - bars) + '|',
          frame.silent ? 'silence' : 'SIGNAL',
          '(peak ' + peak.toFixed(4) + ')');
        emit('level', { rms: rms, peak: peak, silent: frame.silent });
      }
    }
  }

  function startLoop() {
    if (rafId) return;
    lastLogAt = 0;
    rafId = requestAnimationFrame(tick);
  }

  // ---- Public surface ---------------------------------------------------

  window.WinifyAudio = {
    start: start,
    stop: stop,
    isActive: function () { return !!stream; },
    listDevices: listDevices,

    // Per-frame byte data. Returns an unsubscribe function.
    // By default a subscriber is treated as a visualizer and is skipped while
    // the window is hidden. Pass { whenHidden: true } for consumers that need
    // every frame regardless of whether anything is on screen.
    subscribe: function (fn, opts) {
      if (typeof fn !== 'function') throw new TypeError('subscribe expects a function');
      var entry = { fn: fn, whenHidden: !!(opts && opts.whenHidden) };
      subscribers.push(entry);
      return function () {
        subscribers = subscribers.filter(function (s) { return s !== entry; });
      };
    },
    subscriberCount: function () { return subscribers.length; },

    // Driven from the main process: document.hidden does not reflect
    // win.hide() in Electron, so the renderer cannot work this out alone.
    setVisible: function (v) {
      visible = !!v;
      // Report what is actually true: with no capture running there is no
      // analyser to keep running, and claiming otherwise sends you hunting
      // for a process that does not exist.
      var what = !stream ? 'no capture running'
        : (visible ? 'analyser running' : 'analyser still running');
      log('window', visible ? 'visible' : 'hidden',
        '- rendering', visible ? 'resumed' : 'paused', '-', what);
    },
    isVisible: function () { return visible; },

    // Butterchurn and anything else that wants to attach its own analysis.
    getAudioContext: function () { return context; },
    getSourceNode: function () { return sourceNode; },
    getAnalyser: function () { return analyser; },

    // What is actually open right now, read from the live track.
    getDeviceInfo: function () {
      if (!stream) return null;
      var tracks = stream.getAudioTracks();
      if (!tracks.length) return null;
      return {
        label: tracks[0].label,
        readyState: tracks[0].readyState,
        isLoopback: LOOPBACK_RE.test(tracks[0].label),
        trackCount: tracks.length,
      };
    },

    setFftSize: function (n) {
      if (!analyser) return false;
      analyser.fftSize = n;
      allocateBuffers();
      log('fftSize ->', analyser.fftSize, '| bins', analyser.frequencyBinCount);
      return true;
    },
    setSmoothing: function (v) {
      if (!analyser) return false;
      analyser.smoothingTimeConstant = v;
      return true;
    },
    setLogging: function (on) { logging = !!on; },

    // Lifecycle events: started, stopped, ended, error, level.
    onEvent: function (fn) {
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (l) { return l !== fn; }); };
    },
  };
})();
