// The sign-in screen is driven by winify.js. This drives the plain app view
// that takes over once you're connected, including the temporary playback
// test rig. All playback goes through window.WinifyPlayer.
const appStatus = document.getElementById('status');

window.spotify.onStatus((text) => {
  appStatus.textContent = text;
});

// Bring the in-app device up once we're actually connected, and take it down
// on sign-out so a stale device doesn't linger in Spotify Connect.
window.spotify.onAuthConnected(() => window.WinifyPlayer.start());
window.spotify.onAuthRestored(() => window.WinifyPlayer.start());
window.spotify.onSignedOut(() => window.WinifyPlayer.stop());

const on = (id, event, handler) =>
  document.getElementById(id).addEventListener(event, handler);

on('btn-prev', 'click', () => window.WinifyPlayer.previousTrack());
on('btn-play', 'click', () => window.WinifyPlayer.play());
on('btn-pause', 'click', () => window.WinifyPlayer.pause());
on('btn-next', 'click', () => window.WinifyPlayer.nextTrack());
on('btn-transfer', 'click', () => window.WinifyPlayer.transferPlaybackHere(true));

on('vol', 'input', (e) => window.WinifyPlayer.setVolume(Number(e.target.value) / 100));

// Seek is a percentage of the current track, so it needs the live duration.
on('seek', 'change', async (e) => {
  const state = await window.WinifyPlayer.getState();
  if (!state || !state.duration) return;
  window.WinifyPlayer.seek((Number(e.target.value) / 100) * state.duration);
});

// Signs out, clears any stored token, and returns to the Winify screen.
on('signout', 'click', () => window.spotify.disconnect());

// --- Stage 1 audio capture test rig ---------------------------------------
// Throwaway controls to prove system audio is being picked up.
const audioLevel = document.getElementById('audio-level');

window.WinifyAudio.onEvent((event, detail) => {
  if (event === 'level') {
    const bars = '#'.repeat(Math.min(30, Math.round(detail.rms * 150)));
    audioLevel.textContent = `audio: ${detail.rms > 0.001 ? 'SIGNAL' : 'silence'} ` +
      `rms ${detail.rms.toFixed(4)} [${bars.padEnd(30, '.')}]`;
  } else {
    audioLevel.textContent = `audio: ${event}${detail && detail.message ? ' - ' + detail.message : ''}`;
  }
});

on('btn-audio-start', 'click', () => window.WinifyAudio.start());
on('btn-audio-stop', 'click', () => window.WinifyAudio.stop());

// Stage 3: attach the throwaway visualizer once audio is running, and drop it
// when capture stops. It is just another subscriber, so removing it later is
// a matter of deleting this block and the canvas.
window.WinifyAudio.onEvent((event) => {
  if (event === 'started') window.WinifyTestVisualizer.attach('viz-test');
  if (event === 'stopped' || event === 'ended') window.WinifyTestVisualizer.detach();
});
