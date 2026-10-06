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

  function pickDevice(inputs) {
    for (var i = 0; i < inputs.length; i++) {
      if (LOOPBACK_RE.test(inputs[i].label)) return { device: inputs[i], isLoopback: true };
    }
    return { device: inputs[0] || null, isLoopback: false };
  }

  // ---- Lifecycle --------------------------------------------------------

  async function start(opts) {
    if (stream) { log('already capturing'); return true; }
    opts = opts || {};

    var inputs;
    try {
      // Device labels stay blank until permission is granted, so a throwaway
      // request may be needed before the loopback device can be recognised.
      inputs = await listDevices();
      if (inputs.length && !inputs[0].label) {
        var warm = await navigator.mediaDevices.getUserMedia({ audio: true });
        warm.getTracks().forEach(function (t) { t.stop(); });
        inputs = await listDevices();
      }
    } catch (err) {
      log('*** COULD NOT LIST DEVICES ***', String(err && err.name), String(err && err.message));
      emit('error', { message: String(err && err.message) });
      return false;
    }

    log('audio inputs:', inputs.map(function (d) { return d.label || '(unlabelled)'; }).join(' | ') || '(none)');

    var chosen = opts.deviceId
      ? { device: inputs.filter(function (d) { return d.deviceId === opts.deviceId; })[0], isLoopback: false }
      : pickDevice(inputs);

    if (!chosen.device) {
      log('*** NO AUDIO INPUT DEVICE ***');
      emit('error', { message: 'no audio input device' });
      return false;
    }

    log('using device:', chosen.device.label,
      chosen.isLoopback ? '(system loopback)' : '(NOT a loopback device - this hears the room, not the app)');

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: chosen.device.deviceId },
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
      sampleRate: context.sampleRate, device: chosen.device.label,
      isLoopback: chosen.isLoopback, binCount: analyser.frequencyBinCount,
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
      log('window', visible ? 'visible - rendering resumed' : 'hidden - rendering paused, analyser still running');
    },
    isVisible: function () { return visible; },

    // Butterchurn and anything else that wants to attach its own analysis.
    getAudioContext: function () { return context; },
    getSourceNode: function () { return sourceNode; },
    getAnalyser: function () { return analyser; },

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
