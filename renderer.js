// The post-login view is Webamp and nothing else. Actions that used to live
// on throwaway buttons are now menu-bar items, routed here as commands.
// Playback itself still goes through window.WinifyPlayer, untouched.

// Mount the Winamp face once signed in; take it down on sign-out.
const mountWebamp = async () => {
  if (!window.WinifyWebamp) return;
  await window.WinifyWebamp.mount('webamp-root');
  window.spotify.webampStateChanged(window.WinifyWebamp.isDoubled());
};
window.spotify.onAuthConnected(mountWebamp);
window.spotify.onAuthRestored(mountWebamp);
window.spotify.onSignedOut(() => window.WinifyWebamp && window.WinifyWebamp.unmount());

// The window title follows the screen: index.html's "Winify — Sign in" on the
// sign-in screen, plain "Winify" once the player is showing.
const SIGN_IN_TITLE = document.title;
window.spotify.onAuthConnected(() => { document.title = 'Winify'; });
window.spotify.onAuthRestored(() => { document.title = 'Winify'; });
window.spotify.onSignedOut(() => { document.title = SIGN_IN_TITLE; });

// Register Winify as a Spotify device once signed in. These were dropped by
// mistake when the test UI was replaced, which left the device unregistered.
window.spotify.onAuthConnected(() => window.WinifyPlayer.start());
window.spotify.onAuthRestored(() => window.WinifyPlayer.start());
window.spotify.onSignedOut(() => window.WinifyPlayer.stop());

// Keep the main process in step so its menu labels reflect reality.
window.WinifyAudio.onEvent((event) => {
  if (event === 'started') window.spotify.audioStateChanged(true);
  if (event === 'stopped' || event === 'ended' || event === 'error') {
    window.spotify.audioStateChanged(false);
  }
});

window.spotify.onCommand(async (command) => {
  switch (command.name) {
    case 'transfer-playback':
      window.WinifyPlayer.transferPlaybackHere(true);
      break;
    case 'audio-start':
      window.WinifyAudio.start();
      break;
    case 'audio-stop':
      window.WinifyAudio.stop();
      break;
    case 'reset-layout':
      window.WinifyWebamp.resetLayout();
      window.spotify.webampStateChanged(window.WinifyWebamp.isDoubled());
      break;
    case 'toggle-doublesize':
      window.spotify.webampStateChanged(window.WinifyWebamp.toggleDoubleSize());
      break;
    case 'load-skin': {
      // Main reads the file; the renderer has no filesystem access.
      const blob = new Blob([command.data], { type: 'application/zip' });
      await window.WinifyWebamp.loadSkinFile(
        new File([blob], command.fileName || 'skin.wsz'));
      break;
    }
  }
});

// Pause visualizer rendering when the window is tucked away; the analyser
// keeps running. document.hidden does not reflect win.hide() in Electron, so
// this has to come from the main process.
window.spotify.onVisibility((visible) => window.WinifyAudio.setVisible(visible));
