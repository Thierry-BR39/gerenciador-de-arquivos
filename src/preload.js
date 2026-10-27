const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('fm', {
  home: call('fs:home'),
  drives: call('fs:drives'),
  driveInfo: call('fs:driveInfo'),
  places: call('fs:places'),
  list: call('fs:list'),
  exists: call('fs:exists'),
  mkdir: call('fs:mkdir'),
  rename: call('fs:rename'),
  copy: call('fs:copy'),
  move: call('fs:move'),
  remove: call('fs:delete'),
  open: call('fs:open'),
  reveal: call('fs:reveal'),
  readText: call('fs:readText'),
  writeText: call('fs:writeText'),
  search: call('fs:search'),
  cancel: call('fs:cancel'),
  isDir: call('fs:isDir'),
  thumbnail: call('thumb:get'),
  startDrag: call('drag:start'),
  clipWrite: call('clip:write'),
  clipRead: call('clip:read'),
  clipClear: call('clip:clear'),
  // caminho real de um arquivo solto na janela (ex.: arrastado do Explorer)
  pathForFile: (file) => webUtils.getPathForFile(file),
  onSearchResults: (cb) => ipcRenderer.on('fs:searchResults', (_e, id, batch) => cb(id, batch)),
  onProgress: (cb) => ipcRenderer.on('fs:progress', (_e, id, state) => cb(id, state)),
});
