/* THROWAWAY test visualizer.
 *
 * Plain frequency bars, drawn only to confirm the analyser data is live and
 * reacting. Webamp's skin visualizer and Butterchurn replace this.
 *
 * Deliberately self-contained: it owns its canvas, subscribes to
 * window.WinifyAudio like any other consumer, and detaches cleanly. Deleting
 * this file and its <canvas> removes it entirely without touching the
 * analyser or any other subscriber.
 */
(function () {
  'use strict';

  var canvas = null;
  var ctx = null;
  var unsubscribe = null;
  var frames = 0;

  // Only a slice of the spectrum is worth drawing: with a 2048 FFT at 48kHz
  // each bin is ~23Hz, so the upper bins are mostly empty air for music.
  var BAR_COUNT = 64;

  function attach(canvasId) {
    canvas = document.getElementById(canvasId);
    if (!canvas) return false;
    ctx = canvas.getContext('2d');
    if (unsubscribe) unsubscribe();
    unsubscribe = window.WinifyAudio.subscribe(draw);
    return true;
  }

  function detach() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function draw(frame) {
    if (!ctx) return;
    frames++;

    var w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);

    var freq = frame.frequency;
    // Spread the bars over the lower half of the spectrum, where music lives.
    var usable = Math.floor(freq.length / 2);
    var perBar = Math.max(1, Math.floor(usable / BAR_COUNT));
    var barW = w / BAR_COUNT;

    for (var i = 0; i < BAR_COUNT; i++) {
      // Average the bins in this band so a bar represents its whole range.
      var sum = 0;
      for (var j = 0; j < perBar; j++) sum += freq[i * perBar + j];
      var value = (sum / perBar) / 255;
      var barH = value * h;
      ctx.fillStyle = frame.silent ? '#333' : '#FCA600';
      ctx.fillRect(i * barW, h - barH, barW - 1, barH);
    }

    // Oscilloscope over the top, to prove the time-domain data is live too.
    var time = frame.timeDomain;
    ctx.strokeStyle = frame.silent ? '#444' : '#7ef9d8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    var step = Math.max(1, Math.floor(time.length / w));
    for (var x = 0, k = 0; k < time.length; k += step, x++) {
      var y = (time[k] / 255) * h;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    ctx.fillText('rms ' + frame.rms.toFixed(4) + (frame.silent ? ' (silent)' : '') +
      '  frames ' + frames, 4, 10);
  }

  window.WinifyTestVisualizer = {
    attach: attach,
    detach: detach,
    isAttached: function () { return !!unsubscribe; },
    frameCount: function () { return frames; },
    resetFrameCount: function () { frames = 0; },
  };
})();
