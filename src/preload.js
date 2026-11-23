const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('zantroAPI', {
  init: () => ipcRenderer.invoke('zantro:init'),
  getActorBio: (actorName) => ipcRenderer.invoke('zantro:actor-bio', actorName),
  setUsername: (name) => ipcRenderer.invoke('zantro:set-username', name),
  scan: () => ipcRenderer.invoke('zantro:scan'),
  pickFolder: () => ipcRenderer.invoke('zantro:pick-folder'),
  pickFiles: () => ipcRenderer.invoke('zantro:pick-files'),
  pickBanner: () => ipcRenderer.invoke('zantro:pick-banner'),
  addDropped: (paths) => ipcRenderer.invoke('zantro:add-dropped', paths),
  removeFolder: (folderPath) => ipcRenderer.invoke('zantro:remove-folder', folderPath),
  removeFile: (filePath) => ipcRenderer.invoke('zantro:remove-file', filePath),
  removeVideo: (videoPath) => ipcRenderer.invoke('zantro:remove-video', videoPath),
  saveMetadata: (payload) => ipcRenderer.invoke('zantro:save-metadata', payload),
  saveSettings: (settings) => ipcRenderer.invoke('zantro:save-settings', settings),
  saveProgress: (data) => ipcRenderer.invoke('zantro:save-progress', data),
  clearProgress: () => ipcRenderer.invoke('zantro:clear-progress'),
  toggleFavorite: (videoPath) => ipcRenderer.invoke('zantro:toggle-favorite', videoPath),
  saveThumb: (data) => ipcRenderer.invoke('zantro:save-thumb', data),
  makeThumb: (data) => ipcRenderer.invoke('zantro:make-thumb', data),
  preparePlay: (videoPath) => ipcRenderer.invoke('zantro:prepare-play', videoPath),
  cancelPrepare: () => ipcRenderer.invoke('zantro:cancel-prepare'),
  onPrepareProgress: (cb) => ipcRenderer.on('zantro:prepare-progress', (_e, pct) => cb(pct)),
  onVideosUpdated: (cb) => ipcRenderer.on('zantro:videos-updated', (_e, data) => cb(data)),
  getPathForFile: (file) => webUtils.getPathForFile(file)
});