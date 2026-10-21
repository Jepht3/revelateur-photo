/* Pont sécurisé entre l'interface et le processus principal. */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  openDialog: () => ipcRenderer.invoke("open-dialog"),
  pickFolder: title => ipcRenderer.invoke("pick-folder", title),
  expandPaths: (paths, recursive) => ipcRenderer.invoke("expand-paths", paths, recursive),
  readFile: p => ipcRenderer.invoke("read-file", p),
  statFile: p => ipcRenderer.invoke("stat-file", p),
  saveDialog: (defaultPath, ext) => ipcRenderer.invoke("save-dialog", defaultPath, ext),
  uniquePath: (dir, name) => ipcRenderer.invoke("unique-path", dir, name),
  writeFile: (p, data) => ipcRenderer.invoke("write-file", p, data),
  storeLoad: () => ipcRenderer.invoke("store-load"),
  storeSave: json => ipcRenderer.invoke("store-save", json),
  reveal: p => ipcRenderer.invoke("reveal", p),
  openPath: p => ipcRenderer.invoke("open-path", p),
  initialFiles: () => ipcRenderer.invoke("initial-files"),
  importText: title => ipcRenderer.invoke("import-text", title),
  exportText: (name, text) => ipcRenderer.invoke("export-text", name, text),
  pathForFile: file => webUtils.getPathForFile(file),
  onMenu: cb => ipcRenderer.on("menu", (_e, cmd) => cb(cmd)),
  onOpenFiles: cb => ipcRenderer.on("open-files", (_e, files) => cb(files)),
});
