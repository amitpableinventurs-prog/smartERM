// Gives the panels the central server address and this computer's id (read by public/app.js as window.CRM_CONFIG),
// and the activation screen its three actions. Nothing else from Electron or Node is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('CRM_CONFIG', ipcRenderer.sendSync('desk:config'));
contextBridge.exposeInMainWorld('desktop', {
  activate: (serverUrl, key) => ipcRenderer.invoke('desk:activate', { serverUrl, key }),
  retry: () => ipcRenderer.invoke('desk:retry'),
});
