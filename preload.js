const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('nebula', {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('app:pickFolder'),
  quickFolders: () => ipcRenderer.invoke('app:quickFolders'),
  scan: (root) => ipcRenderer.invoke('scan:start', root),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  overview: () => ipcRenderer.invoke('data:overview'),
  dirNode: (p) => ipcRenderer.invoke('dir:node', p),
  largest: (opts) => ipcRenderer.invoke('files:largest', opts),
  findDuplicates: () => ipcRenderer.invoke('dupes:find'),
  cancelDupes: () => ipcRenderer.invoke('dupes:cancel'),
  trash: (paths) => ipcRenderer.invoke('files:trash', paths),
  reveal: (p) => ipcRenderer.invoke('files:reveal', p),
  open: (p) => ipcRenderer.invoke('files:open', p),
  onScanProgress: (cb) => subscribe('scan:progress', cb),
  onDupeProgress: (cb) => subscribe('dupes:progress', cb),
});
