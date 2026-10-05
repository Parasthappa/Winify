// The sign-in screen is driven by spotamp.js. This only feeds the plain
// app view that takes over once you're connected.
const appStatus = document.getElementById('status');

window.spotify.onStatus((text) => {
  appStatus.textContent = text;
});

// Signs out, clears any stored token, and returns to the Spotamp screen.
document.getElementById('signout').addEventListener('click', () => {
  window.spotify.disconnect();
});
