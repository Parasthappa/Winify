const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) =>
  ipcRenderer.on(channel, (_event, payload) => callback(payload));

contextBridge.exposeInMainWorld('spotify', {
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
  api: (method, path, body) => ipcRenderer.invoke('spotify-api', method, path, body),
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
  // Menu-bar actions arrive here now that the test buttons are gone.
  onCommand: on('ui:command'),
  audioStateChanged: (capturing) => ipcRenderer.send('audio-state', capturing),
  webampStateChanged: (doubled) => ipcRenderer.send('webamp-state', doubled),
  milkdropStateChanged: (open) => ipcRenderer.send('milkdrop-state', open),
  choosePresetFiles: () => ipcRenderer.invoke('milkdrop:choose-presets'),
  // The Winify panel's lights (and Webamp's Exit) act on the Winify window.
  windowCommand: (command) => ipcRenderer.send('window-command', command),
  // What is playing, for the menu-bar item (so main need not ask Spotify).
  nowPlaying: (text) => ipcRenderer.send('now-playing', text),
  // Winify's window follows what it shows: the sign-in chassis, or the player.
  // One see-through window over the screen: clicks pass through where nothing is.
  screenWindow: true,
  setPassThrough: (on) => ipcRenderer.send('window:pass-through', on === true),
  onCursor: on('window:cursor'),
});
