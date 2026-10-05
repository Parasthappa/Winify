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

  // Main -> renderer
  onStatus: on('status'),
  onAuthStep: on('auth:step'),
  onAuthError: on('auth:error'),
  onAuthConnected: on('auth:connected'),
  onAuthRestored: on('auth:restored'),
  onSignedOut: on('auth:signed-out'),
});
