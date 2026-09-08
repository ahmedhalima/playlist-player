const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  selectLocalVideoFiles: () => ipcRenderer.invoke('dialog:selectVideoFiles'),
  selectVideoFolder: () => ipcRenderer.invoke('dialog:selectVideoFolder'),
  importTextFile: () => ipcRenderer.invoke('dialog:importTextFile'),
  // Resolves a dropped File object to its real filesystem path. webUtils.getPathForFile
  // is the current, non-deprecated way to do this (the old File.path property is on its
  // way out); fall back to File.path for older Electron versions just in case.
  getFilePath: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch (e) {}
    return file && file.path ? file.path : null;
  }
});
