/* Processus principal : fenêtre, menus, accès disque et stockage des réglages. */
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;

const IMG_EXT = [".jpg", ".jpeg", ".png", ".webp", ".avif", ".bmp", ".gif", ".jfif"];
const isImage = p => IMG_EXT.includes(path.extname(p).toLowerCase());
let win = null;
let pendingFiles = [];

const storeFile = () => path.join(app.getPath("userData"), "revelateur-donnees.json");

function filesFromArgv(argv) {
  return argv.slice(1).filter(a => !a.startsWith("-") && isImage(a) && fs.existsSync(a));
}

async function listImages(dir, recursive) {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (recursive) out.push(...await listImages(full, true)); }
    else if (isImage(e.name)) out.push(full);
  }
  return out.sort((a, b) => a.localeCompare(b, "fr", { numeric: true }));
}

async function expandPaths(paths, recursive) {
  const out = [];
  for (const p of paths) {
    try {
      const st = await fsp.stat(p);
      if (st.isDirectory()) out.push(...await listImages(p, recursive));
      else if (isImage(p)) out.push(p);
    } catch { /* fichier disparu : ignoré */ }
  }
  return out;
}

function send(cmd) { if (win) win.webContents.send("menu", cmd); }

function buildMenu() {
  const t = [
    { label: "Fichier", submenu: [
      { label: "Ouvrir des photos…", accelerator: "CmdOrCtrl+O", click: () => send("open") },
      { label: "Ouvrir un dossier…", accelerator: "CmdOrCtrl+Shift+O", click: () => send("open-folder") },
      { type: "separator" },
      { label: "Exporter la photo…", accelerator: "CmdOrCtrl+E", click: () => send("export") },
      { label: "Traitement par lot…", accelerator: "CmdOrCtrl+Shift+E", click: () => send("batch") },
      { type: "separator" },
      { label: "Retirer la photo de la session", accelerator: "Delete", registerAccelerator: false, click: () => send("remove") },
      { type: "separator" },
      { label: "Quitter", role: "quit" },
    ]},
    { label: "Édition", submenu: [
      { label: "Annuler", accelerator: "CmdOrCtrl+Z", click: () => send("undo") },
      { label: "Rétablir", accelerator: "CmdOrCtrl+Y", click: () => send("redo") },
      { type: "separator" },
      { label: "Copier les réglages", accelerator: "CmdOrCtrl+Shift+C", click: () => send("copy-settings") },
      { label: "Coller les réglages", accelerator: "CmdOrCtrl+Shift+V", click: () => send("paste-settings") },
      { type: "separator" },
      { label: "Amélioration auto", accelerator: "CmdOrCtrl+U", click: () => send("auto") },
      { label: "Réinitialiser les réglages", accelerator: "CmdOrCtrl+Shift+R", click: () => send("reset") },
      { type: "separator" },
      { role: "cut", label: "Couper" }, { role: "copy", label: "Copier" }, { role: "paste", label: "Coller" }, { role: "selectAll", label: "Tout sélectionner" },
    ]},
    { label: "Affichage", submenu: [
      { label: "Avant / après", accelerator: "Y", registerAccelerator: false, click: () => send("toggle-split") },
      { label: "Alerte d'écrêtage", accelerator: "J", registerAccelerator: false, click: () => send("clip") },
      { label: "Recadrer", accelerator: "R", registerAccelerator: false, click: () => send("crop") },
      { type: "separator" },
      { label: "Ajuster à la fenêtre", accelerator: "CmdOrCtrl+0", click: () => send("zoom-fit") },
      { label: "Zoom 100 %", accelerator: "CmdOrCtrl+1", click: () => send("zoom-100") },
      { type: "separator" },
      { role: "togglefullscreen", label: "Plein écran" },
      { role: "toggleDevTools", label: "Outils de développement" },
    ]},
    { label: "Aide", submenu: [
      { label: "Raccourcis clavier", accelerator: "F1", registerAccelerator: false, click: () => send("shortcuts") },
      { label: "Ouvrir le dossier des données", click: () => shell.openPath(app.getPath("userData")) },
      { label: "À propos", click: () => dialog.showMessageBox(win, { type: "info", title: "Révélateur Photo", message: `Révélateur Photo ${app.getVersion()}`, detail: "Développement et retouche photo. Traitement 100 % local : vos photos ne quittent jamais votre ordinateur." }) },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 640,
    backgroundColor: "#141211", title: "Révélateur Photo", show: false,
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once("ready-to-show", () => { win.maximize(); win.show(); });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", e => e.preventDefault());
  buildMenu();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const files = filesFromArgv(argv);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (files.length) win.webContents.send("open-files", files);
  });
  app.whenReady().then(() => {
    pendingFiles = filesFromArgv(process.argv);
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}

/* ---------- IPC ---------- */
const imgFilters = [{ name: "Images", extensions: IMG_EXT.map(e => e.slice(1)) }];

ipcMain.handle("open-dialog", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Ouvrir des photos", properties: ["openFile", "multiSelections"], filters: imgFilters });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle("pick-folder", async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title: title || "Choisir un dossier", properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("expand-paths", (_e, paths, recursive) => expandPaths(paths, !!recursive));
ipcMain.handle("read-file", (_e, p) => fsp.readFile(p));
ipcMain.handle("stat-file", async (_e, p) => { const s = await fsp.stat(p); return { size: s.size, mtime: s.mtimeMs }; });
ipcMain.handle("save-dialog", async (_e, defaultPath, ext) => {
  const r = await dialog.showSaveDialog(win, { title: "Exporter la photo", defaultPath, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle("unique-path", async (_e, dir, name) => {
  await fsp.mkdir(dir, { recursive: true });
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name), i = 2;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${base} (${i++})${ext}`);
  return candidate;
});
ipcMain.handle("write-file", async (_e, p, data) => { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, Buffer.from(data)); return p; });
ipcMain.handle("store-load", async () => { try { return JSON.parse(await fsp.readFile(storeFile(), "utf8")); } catch { return null; } });
ipcMain.handle("store-save", async (_e, json) => {
  const f = storeFile(), tmp = f + ".tmp";
  await fsp.writeFile(tmp, json, "utf8");
  await fsp.rename(tmp, f);
  return true;
});
ipcMain.handle("reveal", (_e, p) => shell.showItemInFolder(p));
ipcMain.handle("open-path", (_e, p) => shell.openPath(p));
ipcMain.handle("initial-files", () => { const f = pendingFiles; pendingFiles = []; return f; });
ipcMain.handle("import-text", async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title, properties: ["openFile", "multiSelections"], filters: [{ name: "Préréglages Révélateur", extensions: ["json"] }] });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(p => fsp.readFile(p, "utf8")));
});
ipcMain.handle("export-text", async (_e, defaultName, text) => {
  const r = await dialog.showSaveDialog(win, { title: "Exporter les préréglages", defaultPath: defaultName, filters: [{ name: "JSON", extensions: ["json"] }] });
  if (r.canceled) return null;
  await fsp.writeFile(r.filePath, text, "utf8");
  return r.filePath;
});
