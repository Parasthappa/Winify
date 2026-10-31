const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) =>
  ipcRenderer.on(channel, (_event, payload) => callback(payload));

const VERSION_ARG = '--winify-version=';

contextBridge.exposeInMainWorld('spotify', {
  // Winify's version (package.json), for the chassis's label.
  version: (process.argv.find((a) => a.startsWith(VERSION_ARG)) || '').slice(VERSION_ARG.length),
  // Renderer -> main
  ready: () => ipcRenderer.send('ready'),
  login: () => ipcRenderer.send('login'),
  cancelLogin: () => ipcRenderer.send('cancel-login'),
  disconnect: () => ipcRenderer.send('disconnect'),
  setRemember: (value) => ipcRenderer.send('set-remember', value),
  // The setup step: your own Spotify app's Client ID.
  setClientId: (id) => ipcRenderer.invoke('client-id:set', id),
  changeClientId: () => ipcRenderer.send('client-id:change'),
  openSetupGuide: () => ipcRenderer.send('open-setup-guide'),

  // Playback support
  getToken: () => ipcRenderer.invoke('get-token'),
  // Web API requests, sent by the main process (no browser preflight).
  // `priority` 'background': work nobody is waiting for (the governor in the
  // main process lets it use only what is left).
  api: (method, path, body, priority) => ipcRenderer.invoke('spotify-api', method, path, body, priority),
  // Background requests already waiting there that someone now waits for.
  promote: (keys) => ipcRenderer.invoke('spotify-api:promote', keys),
  // The My playlists index, kept by the main process for both copies.
  index: {
    load: () => ipcRenderer.invoke('index:load'),
    put: (rec) => ipcRenderer.invoke('index:put', rec),
    remove: (uri) => ipcRenderer.invoke('index:delete', uri),
    clear: () => ipcRenderer.invoke('index:clear'),
    stamp: () => ipcRenderer.invoke('index:stamp'),
    claim: () => ipcRenderer.invoke('index:claim'),
  },
  transferPlayback: (deviceId, startPlaying) =>
    ipcRenderer.invoke('transfer-playback', deviceId, startPlaying),
  // Lyrics lookups on lrclib.net, made by the main process.
  lrclib: (path, params) => ipcRenderer.invoke('lrclib', path, params),

  // Main -> renderer
  onStatus: on('status'),
  onAuthStep: on('auth:step'),
  onAuthError: on('auth:error'),
  onAuthConnected: on('auth:connected'),
  onAuthRestored: on('auth:restored'),
  onAuthSetup: on('auth:setup'),
  onSignedOut: on('auth:signed-out'),
  // document.hidden does not reflect win.hide() in Electron, so visibility
  // has to be pushed from the main process.
  onVisibility: on('window:visibility'),
  // Where Winify's window sits among other apps': 'normal', 'top' or 'behind'.
  onWindowLevel: on('window-level'),
  setWindowLevel: (level) => ipcRenderer.send('window-level', level),
  // Menu-bar actions arrive here now that the test buttons are gone.
  onCommand: on('ui:command'),
  audioStateChanged: (capturing) => ipcRenderer.send('audio-state', capturing),
  // macOS's microphone permission, asked for if not yet answered:
  // 'granted', 'denied' or 'restricted'.
  microphoneAccess: () => ipcRenderer.invoke('audio:microphone'),
  webampStateChanged: (doubled) => ipcRenderer.send('webamp-state', doubled),
  milkdropStateChanged: (open) => ipcRenderer.send('milkdrop-state', open),
  milkdropDesktopChanged: (on) => ipcRenderer.send('milkdrop-desktop', on),
  choosePresetFiles: () => ipcRenderer.invoke('milkdrop:choose-presets'),
  // The Winify panel's lights (and Webamp's Exit) act on the Winify window.
  windowCommand: (command) => ipcRenderer.send('window-command', command),
  // The chassis's now-playing display: is the Spotify app here, and open a
  // track in it.
  spotifyAppInstalled: () => ipcRenderer.invoke('spotify-app-installed'),
  openInSpotify: (uri) => ipcRenderer.send('open-in-spotify', uri),
  // What is playing, for the menu-bar item (so main need not ask Spotify).
  nowPlaying: (text) => ipcRenderer.send('now-playing', text),
  // Winify's window follows what it shows: the sign-in chassis, or the player.
  // One see-through window over the screen: clicks pass through where nothing is.
  screenWindow: true,
  setPassThrough: (on) => ipcRenderer.send('window:pass-through', on === true),
  onCursor: on('window:cursor'),
});
