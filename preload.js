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
  indexInfo: () => ipcRenderer.invoke('index:info'),
  indexLoad: () => ipcRenderer.invoke('index:load'),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  overview: () => ipcRenderer.invoke('data:overview'),
  dirNode: (p) => ipcRenderer.invoke('dir:node', p),
  largest: (opts) => ipcRenderer.invoke('files:largest', opts),
  findDuplicates: () => ipcRenderer.invoke('dupes:find'),
  cancelDupes: () => ipcRenderer.invoke('dupes:cancel'),
  findSimilarPhotos: () => ipcRenderer.invoke('photos:find'),
  cancelPhotos: () => ipcRenderer.invoke('photos:cancel'),
  diffGet: () => ipcRenderer.invoke('diff:get'),
  compareRun: (a, b) => ipcRenderer.invoke('compare:run', a, b),
  compareCancel: () => ipcRenderer.invoke('compare:cancel'),
  orgPlan: (folder, opts) => ipcRenderer.invoke('org:plan', folder, opts),
  orgApply: (folder, moves) => ipcRenderer.invoke('org:apply', folder, moves),
  orgUndo: () => ipcRenderer.invoke('org:undo'),
  trash: (paths) => ipcRenderer.invoke('files:trash', paths),
  reveal: (p) => ipcRenderer.invoke('files:reveal', p),
  onScanProgress: (cb) => subscribe('scan:progress', cb),
  onDupeProgress: (cb) => subscribe('dupes:progress', cb),
  onPhotoProgress: (cb) => subscribe('photos:progress', cb),
  onCompareProgress: (cb) => subscribe('compare:progress', cb),
});
