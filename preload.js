'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  llmSend: (payload) => ipcRenderer.invoke('llm-send', payload),
  settingsGet: () => ipcRenderer.invoke('settings-get'),
  settingsSet: (s) => ipcRenderer.invoke('settings-set', s),
});
