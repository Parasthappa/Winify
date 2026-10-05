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
