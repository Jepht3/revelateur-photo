/* Révélateur Photo — interface. */
"use strict";
const E = window.Engine;
const host = window.api || null; // absent hors Electron : mode navigateur (téléchargements, localStorage)
const $ = id => document.getElementById(id);
const clone = E.clone;
const PREVIEW_MAX = 2048;
const AUTO_SIZE = 1200; // même taille d'analyse que le worker : l'auto donne le même résultat à l'aperçu et au lot

/* ============================================================
   Stockage persistant : préréglages perso, options d'export, catalogue des retouches
   ============================================================ */
function defaultExp() {
  return {
    format: "image/jpeg", quality: 92, sizeMode: "original", longSide: 2048, scale: 2,
    pattern: "{nom}_revele", dest: "", openAfter: true, settings: "own", minRating: 0, recursive: false, source: "open", sourceDir: "",
    watermark: { enabled: false, text: "", position: "br", opacity: 60, size: 3 },
  };
}
const store = { version: 1, userPresets: [], exp: defaultExp(), catalogue: {} };
let saveTimer = null;
async function loadStore() {
  let data = null;
  try { data = host ? await host.storeLoad() : JSON.parse(localStorage.getItem("revelateur") || "null"); } catch { data = null; }
  if (!data) return;
  store.userPresets = Array.isArray(data.userPresets) ? data.userPresets : [];
  store.catalogue = data.catalogue || {};
  store.exp = Object.assign(defaultExp(), data.exp || {});
  store.exp.watermark = Object.assign(defaultExp().watermark, (data.exp || {}).watermark || {});
}
function flushStore() {
  const json = JSON.stringify(store);
  try { if (host) return host.storeSave(json); localStorage.setItem("revelateur", json); } catch (e) { console.warn(e); }
}
function saveStore() { clearTimeout(saveTimer); saveTimer = setTimeout(flushStore, 400); }
window.addEventListener("beforeunload", () => { clearTimeout(saveTimer); flushStore(); });

function saveItem(it) {
  if (!it.path) return;
  store.catalogue[it.path] = {
    params: it.params, geo: it.geo, rating: it.rating, preset: it.preset, snapshots: it.snapshots,
    history: it.history.slice(-60), hIndex: Math.max(0, it.hIndex - Math.max(0, it.history.length - 60)), t: Date.now(),
  };
  const keys = Object.keys(store.catalogue);
  if (keys.length > 3000) keys.sort((a, b) => store.catalogue[a].t - store.catalogue[b].t).slice(0, keys.length - 3000).forEach(k => delete store.catalogue[k]);
  saveStore();
}

/* ============================================================
   État
   ============================================================ */
const state = {
  items: [], cur: -1, mode: "after", split: 50, clip: false, peek: false,
  cropping: false, cropWork: null, zoom: 1, panX: 0, panY: 0, fit: 1,
  clipboard: null, filter: 0, curveCh: "rgb", hslTab: "hslH", space: false, lumHist: null,
};
const cur = () => state.items[state.cur] || null;
let nextId = 1;

/* ============================================================
   Utilitaires d'interface
   ============================================================ */
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
let toastTimer;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2600); }
function showBusy(t) { $("busyText").textContent = t; $("busy").hidden = false; }
function hideBusy() { $("busy").hidden = true; }
const fmtSigned = v => (v > 0 ? "+" : "") + Math.round(v);
const fmtTime = t => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const baseName = p => p.split(/[\\/]/).pop();
const stripExt = n => n.replace(/\.[^.]+$/, "");

/* ============================================================
   Workers : un dédié à l'aperçu, un groupe pour les exports
   ============================================================ */
class Pool {
  constructor(n) {
    this.size = n; this.idle = []; this.queue = []; this.seq = 0;
    for (let i = 0; i < n; i++) {
      const w = new Worker("worker.js");
      w.onmessage = e => this.done(w, e.data.ok ? null : new Error(e.data.error), e.data);
      w.onerror = ev => { ev.preventDefault(); this.done(w, new Error(ev.message || "Le calcul a échoué (mémoire insuffisante ?)"), null); };
      this.idle.push(w);
    }
  }
  done(w, err, data) {
    const job = w._job; w._job = null; this.idle.push(w);
    if (job) err ? job.rej(err) : job.res(data);
    this.pump();
  }
  run(msg, transfer) { return new Promise((res, rej) => { this.queue.push({ msg: { ...msg, id: ++this.seq }, transfer, res, rej }); this.pump(); }); }
  pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop(), j = this.queue.shift();
      w._job = j; w.postMessage(j.msg, j.transfer || []);
    }
  }
}
let pool = null;
const getPool = () => pool || (pool = new Pool(Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1))));

const previewWorker = new Worker("worker.js");
let pvBusy = false, pvPending = null, pvSeq = 0, chipTimer = null;

/* ============================================================
   Chargement des photos
   ============================================================ */
async function makeItem({ name, path, blob }) {
  const b = blob || new Blob([await host.readFile(path)]);
  const full = await createImageBitmap(b, { imageOrientation: "from-image" });
  const w = full.width, h = full.height;
  const s = Math.min(1, PREVIEW_MAX / Math.max(w, h));
  const pw = Math.max(1, Math.round(w * s)), ph = Math.max(1, Math.round(h * s));
  const preview = await createImageBitmap(full, { resizeWidth: pw, resizeHeight: ph, resizeQuality: "high" });
  const ts = 220 / Math.max(w, h), tc = new OffscreenCanvas(Math.round(w * ts), Math.round(h * ts));
  tc.getContext("2d").drawImage(full, 0, 0, tc.width, tc.height);
  const thumb = URL.createObjectURL(await tc.convertToBlob({ type: "image/jpeg", quality: 0.8 }));
  const as = Math.min(1, AUTO_SIZE / Math.max(w, h)), aw = Math.max(1, Math.round(w * as)), ah = Math.max(1, Math.round(h * as));
  const ac = new OffscreenCanvas(aw, ah), ag = ac.getContext("2d", { willReadFrequently: true });
  ag.imageSmoothingQuality = "high"; ag.drawImage(full, 0, 0, aw, ah);
  const auto = E.autoParams(ag.getImageData(0, 0, aw, ah).data, aw, ah);
  full.close();

  const it = {
    id: nextId++, name, path: path || null, blob: path ? null : b, w, h, pw, ph, preview, auto, thumb,
    params: clone(auto), geo: clone(E.DEFAULT_GEO), rating: 0, preset: "auto", snapshots: [], history: [], hIndex: -1, geoCache: null, tiny: null,
  };
  const saved = path && store.catalogue[path];
  if (saved) {
    it.params = E.normalizeParams(saved.params); it.geo = E.normalizeGeo(saved.geo);
    it.rating = saved.rating || 0; it.preset = saved.preset ?? null; it.snapshots = saved.snapshots || [];
    if (Array.isArray(saved.history) && saved.history.length) { it.history = saved.history; it.hIndex = Math.min(saved.hIndex ?? saved.history.length - 1, saved.history.length - 1); }
    it.restored = true;
  }
  if (!it.history.length) { it.history = [snapOf(it, "Amélioration auto à l'ouverture")]; it.hIndex = 0; }
  return it;
}

async function openPaths(paths) {
  if (!paths.length) return;
  state.items = state.items.filter(i => !i.sample);
  let first = -1, restored = 0, failed = 0;
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const existing = state.items.findIndex(x => x.path === p);
    if (existing >= 0) { if (first < 0) first = existing; continue; }
    showBusy(`Ouverture et analyse ${i + 1} / ${paths.length}`);
    try {
      const it = await makeItem({ name: baseName(p), path: p });
      state.items.push(it); if (it.restored) restored++;
      if (first < 0) first = state.items.length - 1;
    } catch (e) { console.warn(p, e); failed++; }
  }
  hideBusy();
  if (first >= 0) select(first); else refreshAll();
  const parts = [];
  if (restored) parts.push(`${restored} retouche${restored > 1 ? "s" : ""} restaurée${restored > 1 ? "s" : ""}`);
  if (failed) parts.push(`${failed} fichier${failed > 1 ? "s" : ""} illisible${failed > 1 ? "s" : ""}`);
  if (parts.length) toast(parts.join(" · "));
}
async function openBlobs(files) {
  state.items = state.items.filter(i => !i.sample);
  let first = -1;
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    showBusy(`Ouverture de ${f.name}`);
    try { state.items.push(await makeItem({ name: f.name, blob: f })); if (first < 0) first = state.items.length - 1; } catch (e) { console.warn(e); }
  }
  hideBusy();
  if (first >= 0) select(first);
}
async function cmdOpen() {
  if (host) openPaths(await host.openDialog());
  else { const inp = el("input"); inp.type = "file"; inp.accept = "image/*"; inp.multiple = true; inp.onchange = () => openBlobs([...inp.files]); inp.click(); }
}
async function cmdOpenFolder() {
  if (!host) return cmdOpen();
  const dir = await host.pickFolder("Ouvrir toutes les photos d'un dossier");
  if (!dir) return;
  const paths = await host.expandPaths([dir], false);
  if (!paths.length) return toast("Aucune photo dans ce dossier");
  openPaths(paths);
}

/* ============================================================
   Historique et instantanés
   ============================================================ */
function snapOf(it, label) { return { label, params: clone(it.params), geo: clone(it.geo), preset: it.preset, t: Date.now() }; }
function pushHistory(label, it = cur()) {
  if (!it) return;
  it.history = it.history.slice(0, it.hIndex + 1);
  it.history.push(snapOf(it, label));
  if (it.history.length > 150) it.history.shift();
  it.hIndex = it.history.length - 1;
  saveItem(it);
  if (it === cur()) { renderHistory(); updateUndo(); }
  updateThumb(it);
}
function restoreSnap(it, s) {
  it.params = E.normalizeParams(s.params); it.geo = E.normalizeGeo(s.geo); it.preset = s.preset ?? null; it.geoCache = null;
  syncControls(); refreshImage();
}
function undo() { const it = cur(); if (!it || it.hIndex <= 0) return; it.hIndex--; restoreSnap(it, it.history[it.hIndex]); renderHistory(); updateUndo(); saveItem(it); toast("Annulé : " + it.history[it.hIndex + 1].label); }
function redo() { const it = cur(); if (!it || it.hIndex >= it.history.length - 1) return; it.hIndex++; restoreSnap(it, it.history[it.hIndex]); renderHistory(); updateUndo(); saveItem(it); toast("Rétabli : " + it.history[it.hIndex].label); }
function updateUndo() { const it = cur(); $("btnUndo").disabled = !it || it.hIndex <= 0; $("btnRedo").disabled = !it || it.hIndex >= it.history.length - 1; }

function renderHistory() {
  const it = cur(), ol = $("histList"); ol.innerHTML = "";
  $("histCount").textContent = it ? it.history.length : "";
  if (!it) return;
  for (let i = it.history.length - 1; i >= 0; i--) {
    const h = it.history[i];
    const li = el("li", i === it.hIndex ? "current" : i > it.hIndex ? "future" : "", `<span class="label"></span><span class="time">${fmtTime(h.t)}</span>`);
    li.querySelector(".label").textContent = h.label;
    li.title = h.label;
    li.onclick = () => { it.hIndex = i; restoreSnap(it, h); renderHistory(); updateUndo(); saveItem(it); };
    ol.appendChild(li);
  }
}
function renderSnaps() {
  const it = cur(), list = $("snapList"); list.innerHTML = "";
  if (!it) return;
  if (!it.snapshots.length) { list.appendChild(el("div", "empty-note", "Gardez une version pour comparer ou y revenir.")); return; }
  it.snapshots.forEach((s, i) => {
    const li = el("li", "", `<span class="label"></span><span class="time">${fmtTime(s.t)}</span><button class="del" title="Supprimer">✕</button>`);
    li.querySelector(".label").textContent = s.name;
    li.onclick = e => {
      if (e.target.classList.contains("del")) { it.snapshots.splice(i, 1); renderSnaps(); saveItem(it); return; }
      restoreSnap(it, s); pushHistory("Instantané : " + s.name);
    };
    list.appendChild(li);
  });
}
$("formSnap").onsubmit = e => {
  e.preventDefault();
  const it = cur(); if (!it) return;
  const name = $("snapName").value.trim() || `Instantané ${it.snapshots.length + 1}`;
  it.snapshots.unshift({ name, params: clone(it.params), geo: clone(it.geo), preset: it.preset, t: Date.now() });
  $("snapName").value = ""; renderSnaps(); saveItem(it); toast("Instantané créé : " + name);
};
$("btnHistClear").onclick = () => { const it = cur(); if (!it) return; it.history = [snapOf(it, "Historique effacé")]; it.hIndex = 0; renderHistory(); updateUndo(); saveItem(it); };

/* ============================================================
   Préréglages : intégrés (adaptatifs), personnels, aperçu au survol
   ============================================================ */
function presetById(id) { return E.PRESETS.find(p => p.id === id) || store.userPresets.find(p => p.id === id) || null; }
function applyPresetTo(it, pr) { it.params = E.applyPreset(it.auto, pr); it.preset = pr.id; }
function presetButton(pr, removable) {
  const b = el("button", "preset", `<span>${esc(pr.name)}</span>${pr.sub ? `<small>${esc(pr.sub)}</small>` : ""}${removable ? '<span class="del" title="Supprimer">✕</span>' : ""}`);
  b.dataset.id = pr.id; b.setAttribute("aria-pressed", "false");
  b.onclick = e => {
    if (e.target.classList.contains("del")) {
      store.userPresets = store.userPresets.filter(p => p.id !== pr.id); saveStore(); renderUserPresets(); return;
    }
    const it = cur(); if (!it) return;
    applyPresetTo(it, pr); syncControls(); refreshImage(); pushHistory("Préréglage : " + pr.name);
  };
  b.onmouseenter = () => showPresetTip(b, pr);
  b.onmouseleave = hidePresetTip;
  return b;
}
function renderPresets() {
  const q = $("presetSearch").value.trim().toLowerCase(), list = $("presetList"); list.innerHTML = "";
  let lastCat = null, n = 0;
  for (const pr of E.PRESETS) {
    if (q && !(`${pr.name} ${pr.sub} ${pr.cat}`.toLowerCase().includes(q))) continue;
    if (pr.cat !== lastCat) { list.appendChild(el("div", "preset-cat", esc(pr.cat))); lastCat = pr.cat; }
    list.appendChild(presetButton(pr, false)); n++;
  }
  if (!n) list.appendChild(el("div", "empty-note", "Aucun préréglage ne correspond."));
  $("presetCount").textContent = E.PRESETS.length;
  markPresets();
}
function renderUserPresets() {
  const list = $("userPresetList"); list.innerHTML = "";
  if (!store.userPresets.length) list.appendChild(el("div", "empty-note", "Enregistrez vos réglages favoris pour les réutiliser d'un clic ou en traitement par lot."));
  for (const pr of store.userPresets) list.appendChild(presetButton(pr, true));
  $("userPresetCount").textContent = store.userPresets.length || "";
  markPresets();
}
function markPresets() {
  const it = cur();
  document.querySelectorAll(".preset").forEach(b => b.setAttribute("aria-pressed", String(!!it && it.preset === b.dataset.id)));
}
$("presetSearch").oninput = renderPresets;
$("formPreset").onsubmit = e => {
  e.preventDefault();
  const it = cur(); if (!it) return toast("Ouvrez d'abord une photo");
  const name = $("presetName").value.trim();
  if (!name) { $("presetName").focus(); return; }
  const pr = { id: "u" + Date.now(), name, sub: "Mon préréglage", params: clone(it.params) };
  store.userPresets.push(pr); it.preset = pr.id; saveStore(); $("presetName").value = ""; renderUserPresets();
  toast(`Préréglage « ${name} » enregistré`);
};
$("btnPresetExport").onclick = async () => {
  if (!store.userPresets.length) return toast("Aucun préréglage personnel à exporter");
  const text = JSON.stringify({ app: "revelateur-photo", version: 1, presets: store.userPresets }, null, 2);
  if (host) { const p = await host.exportText("mes-prereglages-revelateur.json", text); if (p) toast("Préréglages exportés"); }
  else downloadBlob(new Blob([text], { type: "application/json" }), "mes-prereglages-revelateur.json");
};
$("btnPresetImport").onclick = async () => {
  let texts = [];
  if (host) texts = await host.importText("Importer des préréglages");
  else {
    const inp = el("input"); inp.type = "file"; inp.accept = ".json"; inp.multiple = true;
    texts = await new Promise(r => { inp.onchange = async () => r(await Promise.all([...inp.files].map(f => f.text()))); inp.click(); });
  }
  let added = 0;
  for (const t of texts) {
    try {
      const data = JSON.parse(t), arr = Array.isArray(data.presets) ? data.presets : data.params ? [data] : [];
      for (const p of arr) if (p && p.name && p.params) { store.userPresets.push({ id: "u" + Date.now() + "_" + added, name: String(p.name).slice(0, 40), sub: p.sub || "Importé", params: E.normalizeParams(p.params) }); added++; }
    } catch { /* fichier invalide */ }
  }
  saveStore(); renderUserPresets();
  toast(added ? `${added} préréglage${added > 1 ? "s" : ""} importé${added > 1 ? "s" : ""}` : "Aucun préréglage valide dans ce fichier");
};

let tipEl = null;
function tinyOf(it) {
  const G = geomPreview(it);
  if (it.tiny && it.tiny.key === G.key) return it.tiny;
  const s = 260 / Math.max(G.w, G.h), w = Math.max(1, Math.round(G.w * s)), h = Math.max(1, Math.round(G.h * s));
  const c = new OffscreenCanvas(w, h), g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high"; g.drawImage(G.canvas, 0, 0, w, h);
  it.tiny = { key: G.key, w, h, img: g.getImageData(0, 0, w, h) };
  return it.tiny;
}
function showPresetTip(btn, pr) {
  const it = cur(); if (!it) return;
  const T = tinyOf(it), out = new ImageData(T.w, T.h);
  E.develop(T.img.data, T.w, T.h, E.applyPreset(it.auto, pr), out);
  if (!tipEl) { tipEl = el("div", "preset-tip"); tipEl.appendChild(document.createElement("canvas")); document.body.appendChild(tipEl); }
  const c = tipEl.firstChild; c.width = T.w; c.height = T.h; c.getContext("2d").putImageData(out, 0, 0);
  const r = btn.getBoundingClientRect(), left = $("left").getBoundingClientRect().right + 8;
  tipEl.style.left = left + "px";
  tipEl.style.top = Math.max(8, Math.min(window.innerHeight - T.h - 16, r.top + r.height / 2 - T.h / 2)) + "px";
  tipEl.hidden = false;
}
function hidePresetTip() { if (tipEl) tipEl.hidden = true; }

/* ============================================================
   Panneau de réglages
   ============================================================ */
const registry = [];
function getVal(it, reg) {
  if (reg.geo) return it.geo[reg.key];
  const [a, i] = reg.key.split(".");
  return i == null ? it.params[a] : it.params[a][+i];
}
function setVal(it, reg, v) {
  if (reg.geo) { it.geo[reg.key] = v; return; }
  const [a, i] = reg.key.split(".");
  if (i == null) it.params[a] = v; else it.params[a][+i] = v;
}
function defOf(key, geo) {
  if (geo) return E.DEFAULT_GEO[key];
  const [a, i] = key.split(".");
  return i == null ? E.DEFAULTS[a] : E.DEFAULTS[a][+i];
}
function makeSlider({ key, label, min, max, step = 1, fmt, track, feature, geo, title }) {
  const id = "p_" + key.replace(".", "_");
  const wrap = el("div", "ctl" + (feature ? " feature" : ""));
  wrap.innerHTML = `<label for="${id}"></label><output></output><input type="range" id="${id}" min="${min}" max="${max}" step="${step}">`;
  wrap.querySelector("label").textContent = label;
  if (title) wrap.title = title;
  const inp = wrap.querySelector("input"), out = wrap.querySelector("output");
  if (track) inp.style.setProperty("--track", track);
  const def = defOf(key, geo), f = fmt || fmtSigned;
  const reg = { key, geo, inp, wrap, def, show(v) { out.textContent = f(v); wrap.classList.toggle("changed", Math.abs(v - def) > 1e-9); } };
  inp.value = def; reg.show(def);
  inp.addEventListener("input", () => {
    const it = cur(); if (!it) return;
    setVal(it, reg, parseFloat(inp.value)); reg.show(parseFloat(inp.value));
    if (geo) it.geoCache = null; else { it.preset = null; markPresets(); }
    requestRender(true);
  });
  inp.addEventListener("change", () => { if (!cur()) return; pushHistory(`${label} ${f(parseFloat(inp.value))}`); requestRender(false); });
  inp.addEventListener("dblclick", () => { inp.value = def; inp.dispatchEvent(new Event("input")); inp.dispatchEvent(new Event("change")); });
  registry.push(reg);
  return wrap;
}
function makeSection(title, open, keys, builder) {
  const det = el("details"); if (open) det.open = true;
  const sum = el("summary"); sum.textContent = title;
  if (keys) {
    const rb = el("button", "reset-sec", "Réinit."); rb.type = "button"; rb.title = "Remettre cette section à zéro";
    rb.onclick = e => {
      e.preventDefault(); e.stopPropagation();
      const it = cur(); if (!it) return;
      for (const k of keys) it.params[k] = clone(E.DEFAULTS[k]);
      it.preset = null; syncControls(); refreshImage(); pushHistory(`${title} réinitialisé`);
    };
    sum.appendChild(rb);
  }
  det.appendChild(sum);
  const body = el("div", "body"); builder(body); det.appendChild(body);
  $("sections").appendChild(det);
  return det;
}

const RAINBOW = "linear-gradient(90deg,#f33,#fb3,#3f3,#3ff,#36f,#f3f,#f33)";
function buildPanel() {
  makeSection("Basse lumière & bruit", true, ["boost", "denoise"], b => {
    b.appendChild(makeSlider({ key: "boost", label: "Éclaircissement intelligent", min: 0, max: 100, feature: true, track: "linear-gradient(90deg,#2a2622,#e9a04b)", title: "Relève les zones sombres selon leur voisinage, sans brûler le ciel ni les lampes" }));
    b.appendChild(makeSlider({ key: "denoise", label: "Réduction du bruit", min: 0, max: 100, feature: true, title: "Supprime le grain et les taches colorées des photos de smartphone peu éclairées" }));
    b.appendChild(el("p", "hint", "Pensé pour les photos de smartphone prises avec peu de lumière. L'amélioration auto mesure le bruit de chaque photo et règle ces deux curseurs pour vous."));
  });
  makeSection("Lumière", true, ["exposure", "contrast", "highlights", "shadows", "whites", "blacks"], b => {
    b.appendChild(makeSlider({ key: "exposure", label: "Exposition", min: -3, max: 3, step: 0.05, fmt: v => (v > 0 ? "+" : "") + v.toFixed(2) + " IL" }));
    b.appendChild(makeSlider({ key: "contrast", label: "Contraste", min: -100, max: 100 }));
    b.appendChild(makeSlider({ key: "highlights", label: "Hautes lumières", min: -100, max: 100 }));
    b.appendChild(makeSlider({ key: "shadows", label: "Ombres", min: -100, max: 100 }));
    b.appendChild(makeSlider({ key: "whites", label: "Blancs", min: -100, max: 100 }));
    b.appendChild(makeSlider({ key: "blacks", label: "Noirs", min: -100, max: 100 }));
  });
  makeSection("Couleur", true, ["temp", "tint", "vibrance", "saturation"], b => {
    b.appendChild(makeSlider({ key: "temp", label: "Température", min: -100, max: 100, track: "linear-gradient(90deg,#4f7fd8,#d8d0c0,#e8b040)" }));
    b.appendChild(makeSlider({ key: "tint", label: "Teinte", min: -100, max: 100, track: "linear-gradient(90deg,#4fbf5a,#d0d0d0,#c050c8)" }));
    b.appendChild(makeSlider({ key: "vibrance", label: "Vibrance", min: -100, max: 100 }));
    b.appendChild(makeSlider({ key: "saturation", label: "Saturation", min: -100, max: 100 }));
  });
  makeSection("Présence", true, ["texture", "clarity", "dehaze"], b => {
    b.appendChild(makeSlider({ key: "texture", label: "Texture", min: -100, max: 100, title: "Détails fins (peau, feuillage). Négatif pour lisser" }));
    b.appendChild(makeSlider({ key: "clarity", label: "Clarté", min: -100, max: 100 }));
    b.appendChild(makeSlider({ key: "dehaze", label: "Correction du voile", min: -100, max: 100 }));
  });
  makeSection("Courbe des tonalités", false, ["curve"], buildCurve);
  makeSection("Mixeur couleur (TSL)", false, ["hslH", "hslS", "hslL"], buildHSL);
  makeSection("Étalonnage", false, ["shHue", "shSat", "hiHue", "hiSat", "balance"], b => {
    b.appendChild(makeSlider({ key: "shHue", label: "Ombres · teinte", min: 0, max: 360, fmt: v => Math.round(v) + "°", track: RAINBOW }));
    b.appendChild(makeSlider({ key: "shSat", label: "Ombres · intensité", min: 0, max: 100 }));
    b.appendChild(makeSlider({ key: "hiHue", label: "Hautes lumières · teinte", min: 0, max: 360, fmt: v => Math.round(v) + "°", track: RAINBOW }));
    b.appendChild(makeSlider({ key: "hiSat", label: "Hautes lumières · intensité", min: 0, max: 100 }));
    b.appendChild(makeSlider({ key: "balance", label: "Équilibre", min: -100, max: 100 }));
  });
  makeSection("Détail", true, ["sharpen"], b => {
    b.appendChild(makeSlider({ key: "sharpen", label: "Netteté", min: 0, max: 150 }));
  });
  makeSection("Effets", false, ["vignette", "grain"], b => {
    b.appendChild(makeSlider({ key: "vignette", label: "Vignetage", min: -100, max: 100 }));
    b.appendChild(makeSlider({ key: "grain", label: "Grain", min: 0, max: 100 }));
  });
  makeSection("Géométrie", false, null, buildGeometry);
}

/* ---------- Courbe des tonalités ---------- */
const CURVE_COLORS = { rgb: "#ece6df", r: "#e5604d", g: "#5cc46a", b: "#5a8af0" };
const CURVE_PRESETS = {
  lin: [[0, 0], [1, 1]],
  med: [[0, 0], [0.25, 0.2], [0.75, 0.8], [1, 1]],
  strong: [[0, 0], [0.25, 0.15], [0.75, 0.86], [1, 1]],
  matte: [[0, 0.1], [0.25, 0.27], [0.75, 0.76], [1, 0.96]],
  lift: [[0, 0], [0.25, 0.34], [0.7, 0.76], [1, 1]],
};
let curveCanvas = null, curveDrag = -1, curveRemove = false;
function buildCurve(b) {
  const tabs = el("div", "tabs");
  for (const [ch, label] of [["rgb", "RVB"], ["r", "Rouge"], ["g", "Vert"], ["b", "Bleu"]]) {
    const t = el("button", "", `<span class="dot" style="background:${CURVE_COLORS[ch]}"></span>${label}`);
    t.type = "button"; t.dataset.ch = ch; t.setAttribute("aria-pressed", String(ch === "rgb"));
    t.onclick = () => { state.curveCh = ch; tabs.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === t))); drawCurve(); };
    tabs.appendChild(t);
  }
  b.appendChild(tabs);
  const wrap = el("div", "curve-wrap");
  curveCanvas = document.createElement("canvas");
  curveCanvas.setAttribute("aria-label", "Courbe des tonalités : cliquez pour ajouter un point, glissez pour le déplacer, double-cliquez pour le supprimer");
  wrap.appendChild(curveCanvas); b.appendChild(wrap);
  const row = el("div", "row");
  const sel = el("select", "", `<option value="">Courbe prédéfinie…</option><option value="lin">Linéaire</option><option value="med">Contraste moyen</option><option value="strong">Contraste fort</option><option value="matte">Mat</option><option value="lift">Déboucher les ombres</option>`);
  sel.setAttribute("aria-label", "Courbe prédéfinie");
  sel.onchange = () => {
    const it = cur(); if (!it || !sel.value) return;
    it.params.curve[state.curveCh] = clone(CURVE_PRESETS[sel.value]); it.preset = null;
    drawCurve(); refreshImage(); pushHistory("Courbe : " + sel.options[sel.selectedIndex].text); sel.value = "";
  };
  row.appendChild(sel);
  b.appendChild(row);
  b.appendChild(el("p", "hint", "Cliquez pour ajouter un point, glissez pour le déplacer, double-cliquez ou glissez hors du cadre pour le supprimer."));
  new ResizeObserver(() => { const r = curveCanvas.getBoundingClientRect(); if (!r.width) return; curveCanvas.width = curveCanvas.height = Math.round(r.width * devicePixelRatio); drawCurve(); }).observe(curveCanvas);

  const pos = e => { const r = curveCanvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height]; };
  const pts = () => cur().params.curve[state.curveCh];
  const near = (x, y) => { const p = pts(); let best = -1, bd = 0.045; p.forEach((q, i) => { const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; best = i; } }); return best; };
  curveCanvas.addEventListener("pointerdown", e => {
    const it = cur(); if (!it) return;
    const [x, y] = pos(e); let i = near(x, y);
    if (i < 0) {
      const p = clone(pts()).sort((a, b) => a[0] - b[0]);
      if (p.some(q => Math.abs(q[0] - x) < 0.02)) return;
      p.push([E.clamp01(x), E.clamp01(y)]); p.sort((a, b) => a[0] - b[0]);
      it.params.curve[state.curveCh] = p; i = p.findIndex(q => q[0] === E.clamp01(x));
    }
    curveDrag = i; curveRemove = false; curveCanvas.setPointerCapture(e.pointerId);
    it.preset = null; drawCurve(); requestRender(true);
  });
  curveCanvas.addEventListener("pointermove", e => {
    if (curveDrag < 0) return;
    const p = pts(), [x, y] = pos(e), last = p.length - 1, i = curveDrag;
    let nx = i === 0 ? 0 : i === last ? 1 : Math.min(p[i + 1][0] - 0.01, Math.max(p[i - 1][0] + 0.01, x));
    curveRemove = i > 0 && i < last && (y < -0.08 || y > 1.08 || x < -0.08 || x > 1.08);
    p[i] = [nx, E.clamp01(y)];
    drawCurve(); requestRender(true);
  });
  const end = () => {
    if (curveDrag < 0) return;
    if (curveRemove) pts().splice(curveDrag, 1);
    curveDrag = -1; curveRemove = false; drawCurve(); requestRender(false); pushHistory("Courbe des tonalités");
  };
  curveCanvas.addEventListener("pointerup", end);
  curveCanvas.addEventListener("pointercancel", end);
  curveCanvas.addEventListener("dblclick", e => {
    const it = cur(); if (!it) return;
    const [x, y] = pos(e), i = near(x, y), p = pts();
    if (i > 0 && i < p.length - 1) { p.splice(i, 1); drawCurve(); refreshImage(); pushHistory("Point de courbe supprimé"); }
  });
}
function drawCurve() {
  if (!curveCanvas || !curveCanvas.width) return;
  const g = curveCanvas.getContext("2d"), S = curveCanvas.width, it = cur();
  g.clearRect(0, 0, S, S);
  g.strokeStyle = "rgba(255,255,255,.07)"; g.lineWidth = 1;
  for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(i * S / 4, 0); g.lineTo(i * S / 4, S); g.moveTo(0, i * S / 4); g.lineTo(S, i * S / 4); g.stroke(); }
  if (state.lumHist) {
    const hst = state.lumHist, mx = Math.max(1, ...hst);
    g.beginPath(); g.moveTo(0, S);
    hst.forEach((v, i) => g.lineTo(i / (hst.length - 1) * S, S - Math.sqrt(v / mx) * S * 0.9));
    g.lineTo(S, S); g.closePath(); g.fillStyle = "rgba(255,255,255,.06)"; g.fill();
  }
  g.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]); g.strokeStyle = "rgba(255,255,255,.18)";
  g.beginPath(); g.moveTo(0, S); g.lineTo(S, 0); g.stroke(); g.setLineDash([]);
  if (!it) return;
  const pts = it.params.curve[state.curveCh], lut = E.curveLUT(pts, 256);
  g.strokeStyle = CURVE_COLORS[state.curveCh]; g.lineWidth = 2 * devicePixelRatio;
  g.beginPath(); for (let i = 0; i < 256; i++) { const x = i / 255 * S, y = S - lut[i] * S; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
  pts.forEach((p, i) => {
    g.beginPath(); g.arc(p[0] * S, S - p[1] * S, 5 * devicePixelRatio, 0, Math.PI * 2);
    g.fillStyle = i === curveDrag && curveRemove ? "rgba(229,96,77,.6)" : "#141211"; g.fill();
    g.strokeStyle = CURVE_COLORS[state.curveCh]; g.lineWidth = 2 * devicePixelRatio; g.stroke();
  });
}

/* ---------- Mixeur TSL ---------- */
function buildHSL(b) {
  const tabs = el("div", "tabs"), panes = {};
  for (const [k, label] of [["hslH", "Teinte"], ["hslS", "Saturation"], ["hslL", "Luminance"]]) {
    const t = el("button", "", label); t.type = "button"; t.setAttribute("aria-pressed", String(k === "hslH"));
    t.onclick = () => { state.hslTab = k; tabs.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === t))); for (const p in panes) panes[p].hidden = p !== k; };
    tabs.appendChild(t);
  }
  b.appendChild(tabs);
  for (const k of ["hslH", "hslS", "hslL"]) {
    const pane = el("div", "stack"); pane.hidden = k !== "hslH"; panes[k] = pane;
    E.HSL_COLORS.forEach((c, i) => {
      const h = c.hue;
      const track = k === "hslH" ? `linear-gradient(90deg,hsl(${h - 30},80%,55%),hsl(${h},80%,55%),hsl(${h + 30},80%,55%))`
        : k === "hslS" ? `linear-gradient(90deg,#777,hsl(${h},90%,52%))` : `linear-gradient(90deg,hsl(${h},70%,18%),hsl(${h},70%,78%))`;
      const tab = { hslH: "teinte", hslS: "saturation", hslL: "luminance" }[k];
      pane.appendChild(makeSlider({ key: `${k}.${i}`, label: `${c.name} · ${tab}`, min: -100, max: 100, track }));
    });
    b.appendChild(pane);
  }
  b.appendChild(el("p", "hint", "Exemples : ciel plus profond avec la luminance des bleus, peau plus lumineuse avec la luminance des oranges, verdure moins criarde avec la saturation des verts."));
}

/* ---------- Géométrie ---------- */
function buildGeometry(b) {
  const row = el("div", "btn-row");
  const mk = (label, title, fn) => { const x = el("button", "btn small", label); x.type = "button"; x.title = title; x.onclick = fn; row.appendChild(x); };
  mk("⟲ 90°", "Rotation à gauche", () => rotate(-90));
  mk("⟳ 90°", "Rotation à droite", () => rotate(90));
  mk("⇋", "Miroir horizontal", () => flip("H"));
  mk("⇵", "Miroir vertical", () => flip("V"));
  b.appendChild(row);
  b.appendChild(makeSlider({ key: "angle", label: "Redresser", min: -45, max: 45, step: 0.1, geo: true, fmt: v => v.toFixed(1) + "°", title: "Remet l'horizon droit ; l'image est agrandie pour éviter les coins vides" }));
  const r2 = el("div", "row");
  const cropBtn = el("button", "btn small", "Recadrer (R)"); cropBtn.type = "button"; cropBtn.onclick = () => enterCrop();
  const resetBtn = el("button", "btn small ghost", "Réinitialiser la géométrie"); resetBtn.type = "button";
  resetBtn.onclick = () => { const it = cur(); if (!it) return; it.geo = clone(E.DEFAULT_GEO); it.geoCache = null; syncControls(); refreshImage(); pushHistory("Géométrie réinitialisée"); };
  r2.append(cropBtn, resetBtn); b.appendChild(r2);
}
function rotate(d) {
  const it = cur(); if (!it) return;
  it.geo.rot = (it.geo.rot + d + 360) % 360; it.geo.crop = { x: 0, y: 0, w: 1, h: 1 }; it.geo.ratio = "free"; it.geoCache = null;
  refreshImage(); pushHistory(`Rotation ${d > 0 ? "à droite" : "à gauche"}`);
}
function flip(axis) {
  const it = cur(); if (!it) return;
  const c = it.geo.crop;
  if (axis === "H") { it.geo.flipH = !it.geo.flipH; c.x = 1 - c.x - c.w; } else { it.geo.flipV = !it.geo.flipV; c.y = 1 - c.y - c.h; }
  it.geoCache = null; refreshImage(); pushHistory(axis === "H" ? "Miroir horizontal" : "Miroir vertical");
}

function syncControls() {
  const it = cur();
  for (const reg of registry) { const v = it ? getVal(it, reg) : reg.def; reg.inp.value = v; reg.show(v); reg.inp.disabled = !it; }
  markPresets(); drawCurve();
}

/* ============================================================
   Aperçu
   ============================================================ */
function geomPreview(it) {
  const key = JSON.stringify(it.geo) + (state.cropping ? "|full" : "");
  if (it.geoCache && it.geoCache.key === key) return it.geoCache;
  const c = E.renderGeometry(it.preview, it.pw, it.ph, it.geo, 1, !state.cropping);
  const img = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  it.geoCache = { key, canvas: c, img, levels: {}, w: c.width, h: c.height };
  return it.geoCache;
}
// Niveau de calcul : « view » = résolution de l'écran, « draft » = moitié (pendant qu'on glisse un curseur),
// pleine résolution de l'aperçu seulement quand on zoome.
function levelOf(G, draft) {
  if (state.zoom > 1 && !draft) return G.img;
  const vw = Math.max(200, viewport.clientWidth - 56), vh = Math.max(200, viewport.clientHeight - 56);
  let s = state.zoom > 1 ? 1 : Math.min(1, Math.min(vw / G.w, vh / G.h) * (window.devicePixelRatio || 1));
  if (draft) s *= 0.5;
  if (s > 0.92) return G.img;
  const key = (draft ? "d" : "v") + s.toFixed(2);
  if (!G.levels[key]) {
    const w = Math.max(1, Math.round(G.w * s)), h = Math.max(1, Math.round(G.h * s));
    const c = new OffscreenCanvas(w, h), g = c.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high"; g.drawImage(G.canvas, 0, 0, w, h);
    G.levels = Object.fromEntries(Object.entries(G.levels).filter(([k]) => k[0] !== key[0]));
    G.levels[key] = g.getImageData(0, 0, w, h);
  }
  return G.levels[key];
}

const cvBefore = $("cvBefore"), cvAfter = $("cvAfter"), ctxB = cvBefore.getContext("2d"), ctxA = cvAfter.getContext("2d");
let beforeKey = null;
function ensureCanvases(it) {
  const G = geomPreview(it);
  if (cvAfter.width !== G.w || cvAfter.height !== G.h) { cvAfter.width = cvBefore.width = G.w; cvAfter.height = cvBefore.height = G.h; layout(); }
  const k = it.id + G.key;
  if (beforeKey !== k) { ctxB.putImageData(G.img, 0, 0); beforeKey = k; }
  return G;
}
function refreshImage() { requestRender(false); }
function requestRender(draft) {
  const it = cur(); if (!it) return;
  if (pvBusy) { if (!pvPending || !draft) pvPending = { draft }; return; }
  sendPreview(draft);
}
function sendPreview(draft) {
  const it = cur(); if (!it) return;
  const G = ensureCanvases(it), src = levelOf(G, draft);
  const buf = src.data.slice().buffer;
  pvBusy = true;
  const id = ++pvSeq;
  previewWorker._meta = { id, itemId: it.id, key: G.key };
  clearTimeout(chipTimer); chipTimer = setTimeout(() => $("renderChip").hidden = false, 250);
  previewWorker.postMessage({ type: "preview", id, buffer: buf, w: src.width, h: src.height, params: it.params }, [buf]);
}
const tmpCanvas = new OffscreenCanvas(1, 1);
previewWorker.onmessage = e => {
  const m = e.data, meta = previewWorker._meta;
  pvBusy = false; clearTimeout(chipTimer); $("renderChip").hidden = true;
  const it = cur();
  if (m.ok && it && meta && it.id === meta.itemId && it.geoCache && it.geoCache.key === meta.key) {
    const img = new ImageData(new Uint8ClampedArray(m.buffer), m.w, m.h);
    drawHisto(img.data);
    if (state.clip) markClipping(img.data);
    if (m.w === cvAfter.width && m.h === cvAfter.height) ctxA.putImageData(img, 0, 0);
    else {
      tmpCanvas.width = m.w; tmpCanvas.height = m.h; tmpCanvas.getContext("2d").putImageData(img, 0, 0);
      ctxA.imageSmoothingQuality = "high"; ctxA.drawImage(tmpCanvas, 0, 0, cvAfter.width, cvAfter.height);
    }
    applyMode();
  } else if (!m.ok) console.error(m.error);
  if (pvPending) { const p = pvPending; pvPending = null; sendPreview(p.draft); }
};
function markClipping(d) {
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] >= 254 || d[i + 1] >= 254 || d[i + 2] >= 254) { d[i] = 255; d[i + 1] = 40; d[i + 2] = 40; }
    else if (d[i] <= 2 && d[i + 1] <= 2 && d[i + 2] <= 2) { d[i] = 40; d[i + 1] = 90; d[i + 2] = 255; }
  }
}
function drawHisto(d) {
  const c = $("histo"), g = c.getContext("2d"), W = c.width, H = c.height, bins = 128;
  const hs = [new Uint32Array(bins), new Uint32Array(bins), new Uint32Array(bins)], lum = new Uint32Array(64);
  const step = Math.max(4, Math.floor(d.length / 4 / 300000) * 4);
  for (let i = 0; i < d.length; i += step) {
    hs[0][d[i] >> 1]++; hs[1][d[i + 1] >> 1]++; hs[2][d[i + 2] >> 1]++;
    lum[(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) >> 2]++;
  }
  state.lumHist = [...lum];
  const all = [...hs[0], ...hs[1], ...hs[2]].sort((a, b) => a - b), max = Math.max(1, all[Math.floor(all.length * 0.985)]);
  g.clearRect(0, 0, W, H);
  g.globalCompositeOperation = "lighter";
  ["rgba(230,70,60,.75)", "rgba(80,200,90,.75)", "rgba(70,120,240,.75)"].forEach((col, ci) => {
    g.beginPath(); g.moveTo(0, H);
    for (let i = 0; i < bins; i++) g.lineTo(i / (bins - 1) * W, H - Math.min(1, hs[ci][i] / max) * (H - 4));
    g.lineTo(W, H); g.closePath(); g.fillStyle = col; g.fill();
  });
  g.globalCompositeOperation = "source-over";
  if (curveDrag < 0) drawCurve();
}

/* ---------- Affichage, zoom et déplacement ---------- */
const viewport = $("viewport"), zoomer = $("zoomer"), stage = $("stage");
function layout() {
  const it = cur(); if (!it || !cvAfter.width) return;
  const vw = viewport.clientWidth, vh = viewport.clientHeight, pad = 28;
  state.fit = Math.min((vw - pad * 2) / cvAfter.width, (vh - pad * 2) / cvAfter.height);
  const s = state.fit * state.zoom, W = cvAfter.width * s, H = cvAfter.height * s;
  stage.style.width = W + "px"; stage.style.height = H + "px";
  if (W <= vw) state.panX = 0; else state.panX = Math.max((vw - W) / 2, Math.min((W - vw) / 2, state.panX));
  if (H <= vh) state.panY = 0; else state.panY = Math.max((vh - H) / 2, Math.min((H - vh) / 2, state.panY));
  zoomer.style.transform = `translate(${(vw - W) / 2 + state.panX}px, ${(vh - H) / 2 + state.panY}px)`;
  const pct = s * it.pw / it.w * 100;
  $("btnZoom").textContent = state.zoom === 1 ? "Ajuster" : Math.round(pct) + " %";
  viewport.classList.toggle("pannable", state.zoom > 1 && !state.cropping);
  if (state.cropping) positionCrop();
}
new ResizeObserver(layout).observe(viewport);
function zoomAt(z, mx, my) {
  const it = cur(); if (!it) return;
  const maxZ = Math.max(1, 3 / state.fit);
  z = Math.max(1, Math.min(maxZ, z));
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  const s0 = state.fit * state.zoom, W0 = cvAfter.width * s0, H0 = cvAfter.height * s0;
  const x0 = (vw - W0) / 2 + state.panX, y0 = (vh - H0) / 2 + state.panY;
  const u = (mx - x0) / s0, v = (my - y0) / s0;
  const s1 = state.fit * z, W1 = cvAfter.width * s1, H1 = cvAfter.height * s1;
  const crossed = (state.zoom > 1) !== (z > 1);
  state.zoom = z;
  state.panX = mx - u * s1 - (vw - W1) / 2; state.panY = my - v * s1 - (vh - H1) / 2;
  layout();
  if (crossed) refreshImage(); // passe à la pleine résolution de l'aperçu pour voir les détails
}
function zoomToggle(mx, my) {
  if (mx == null) { mx = viewport.clientWidth / 2; my = viewport.clientHeight / 2; }
  if (state.zoom > 1) { state.zoom = 1; state.panX = state.panY = 0; layout(); refreshImage(); }
  else zoomAt(1 / state.fit, mx, my);
}
viewport.addEventListener("wheel", e => {
  if (!cur() || state.cropping) return;
  e.preventDefault();
  const r = viewport.getBoundingClientRect();
  zoomAt(state.zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
viewport.addEventListener("dblclick", e => {
  if (!cur() || state.cropping || e.target.closest(".crop-bar,.empty")) return;
  const r = viewport.getBoundingClientRect(); zoomToggle(e.clientX - r.left, e.clientY - r.top);
});
$("btnZoom").onclick = () => zoomToggle();

let panning = null, splitting = false;
viewport.addEventListener("pointerdown", e => {
  if (!cur() || state.cropping || e.target.closest(".crop-bar,.empty")) return;
  if (state.mode === "split" && !state.space && e.target.closest("#stage")) { splitting = true; viewport.setPointerCapture(e.pointerId); moveSplit(e); return; }
  if (state.zoom > 1) { panning = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY }; viewport.setPointerCapture(e.pointerId); viewport.classList.add("panning"); }
});
viewport.addEventListener("pointermove", e => {
  if (splitting) moveSplit(e);
  else if (panning) { state.panX = panning.px + e.clientX - panning.x; state.panY = panning.py + e.clientY - panning.y; layout(); }
});
const stopPointer = () => { splitting = false; panning = null; viewport.classList.remove("panning"); };
viewport.addEventListener("pointerup", stopPointer);
viewport.addEventListener("pointercancel", stopPointer);
function moveSplit(e) { const r = stage.getBoundingClientRect(); state.split = Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100)); applyMode(); }

function setMode(m) {
  state.mode = m;
  for (const [id, v] of [["modeAfter", "after"], ["modeSplit", "split"], ["modeBefore", "before"]]) $(id).setAttribute("aria-pressed", String(m === v));
  applyMode();
}
function applyMode() {
  const m = state.peek ? "before" : state.cropping ? "after" : state.mode;
  cvAfter.hidden = m === "before";
  $("tagBefore").hidden = m !== "before" || !cur();
  $("handle").hidden = m !== "split";
  stage.classList.toggle("split", m === "split");
  cvAfter.style.clipPath = m === "split" ? `inset(0 0 0 ${state.split}%)` : "none";
  $("handle").style.left = state.split + "%";
}
$("modeAfter").onclick = () => setMode("after");
$("modeSplit").onclick = () => setMode("split");
$("modeBefore").onclick = () => setMode("before");
function toggleClip() { state.clip = !state.clip; $("btnClip").setAttribute("aria-pressed", String(state.clip)); refreshImage(); }
$("btnClip").onclick = toggleClip;

/* ---------- Recadrage ---------- */
const cropBox = $("cropBox");
function ratioValue(v, FW, FH) { if (v === "free") return null; if (v === "orig") return FW / FH; return parseFloat(v); }
function fitRatio(c, r, FW, FH) {
  if (!r) return c;
  let wp = c.w * FW, hp = c.h * FH;
  if (wp / hp > r) wp = hp * r; else hp = wp / r;
  const w = Math.min(1, wp / FW), h = Math.min(1, hp / FH), cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  return { x: Math.max(0, Math.min(1 - w, cx - w / 2)), y: Math.max(0, Math.min(1 - h, cy - h / 2)), w, h };
}
function enterCrop() {
  const it = cur(); if (!it || state.cropping) return;
  state.cropping = true; state.cropWork = clone(it.geo.crop);
  state.zoom = 1; state.panX = state.panY = 0;
  $("cropRatio").value = it.geo.ratio || "free";
  cropBox.hidden = false; $("cropBar").hidden = false; stage.classList.add("cropping");
  refreshImage(); layout(); applyMode();
}
function exitCrop(apply) {
  const it = cur(); if (!state.cropping) return;
  state.cropping = false; cropBox.hidden = true; $("cropBar").hidden = true; stage.classList.remove("cropping");
  if (apply && it) {
    const changed = JSON.stringify(it.geo.crop) !== JSON.stringify(state.cropWork) || it.geo.ratio !== $("cropRatio").value;
    it.geo.crop = state.cropWork; it.geo.ratio = $("cropRatio").value; it.geoCache = null;
    if (changed) pushHistory("Recadrage");
  }
  if (it) it.geoCache = null;
  refreshImage(); layout(); applyMode();
}
function positionCrop() {
  const c = state.cropWork;
  Object.assign(cropBox.style, { left: c.x * 100 + "%", top: c.y * 100 + "%", width: c.w * 100 + "%", height: c.h * 100 + "%" });
}
$("cropRatio").onchange = () => { state.cropWork = fitRatio(state.cropWork, ratioValue($("cropRatio").value, cvAfter.width, cvAfter.height), cvAfter.width, cvAfter.height); positionCrop(); };
$("cropReset").onclick = () => { state.cropWork = fitRatio({ x: 0, y: 0, w: 1, h: 1 }, ratioValue($("cropRatio").value, cvAfter.width, cvAfter.height), cvAfter.width, cvAfter.height); positionCrop(); };
$("cropCancel").onclick = () => exitCrop(false);
$("cropApply").onclick = () => exitCrop(true);
let cropDrag = null;
cropBox.addEventListener("pointerdown", e => {
  e.stopPropagation();
  const r = stage.getBoundingClientRect();
  cropDrag = { h: e.target.dataset.h || "move", sx: e.clientX, sy: e.clientY, start: clone(state.cropWork), rw: r.width, rh: r.height, rl: r.left, rt: r.top };
  cropBox.setPointerCapture(e.pointerId);
});
cropBox.addEventListener("pointermove", e => {
  if (!cropDrag) return;
  const d = cropDrag, s = d.start, FW = cvAfter.width, FH = cvAfter.height, ratio = ratioValue($("cropRatio").value, FW, FH);
  if (d.h === "move") {
    const dx = (e.clientX - d.sx) / d.rw, dy = (e.clientY - d.sy) / d.rh;
    state.cropWork = { ...s, x: Math.max(0, Math.min(1 - s.w, s.x + dx)), y: Math.max(0, Math.min(1 - s.h, s.y + dy)) };
  } else {
    const ax = d.h.includes("w") ? s.x + s.w : s.x, ay = d.h.includes("n") ? s.y + s.h : s.y;
    const px = E.clamp01((e.clientX - d.rl) / d.rw), py = E.clamp01((e.clientY - d.rt) / d.rh);
    let w = Math.max(0.05, Math.abs(px - ax)), h = Math.max(0.05, Math.abs(py - ay));
    if (ratio) { let wp = w * FW, hp = h * FH; if (wp / hp > ratio) wp = hp * ratio; else hp = wp / ratio; w = wp / FW; h = hp / FH; }
    const goLeft = d.h.includes("w"), goUp = d.h.includes("n");
    w = Math.min(w, goLeft ? ax : 1 - ax); h = Math.min(h, goUp ? ay : 1 - ay);
    if (ratio) { let wp = w * FW, hp = h * FH; if (wp / hp > ratio) wp = hp * ratio; else hp = wp / ratio; w = wp / FW; h = hp / FH; }
    state.cropWork = { x: goLeft ? ax - w : ax, y: goUp ? ay - h : ay, w, h };
  }
  positionCrop();
});
cropBox.addEventListener("pointerup", () => cropDrag = null);
cropBox.addEventListener("pointercancel", () => cropDrag = null);

/* ============================================================
   Pellicule, sélection, notes
   ============================================================ */
function visibleIdx() { return state.items.map((it, i) => i).filter(i => state.items[i].rating >= state.filter); }
function updateThumb(it) {
  const t = document.querySelector(`.thumb[data-id="${it.id}"]`); if (!t) return;
  t.querySelector(".rt").textContent = it.rating ? "★".repeat(it.rating) : "";
  t.querySelector(".ed").hidden = it.history.length <= 1 && !it.restored;
}
function buildStrip() {
  const strip = $("strip"); strip.innerHTML = "";
  for (const i of visibleIdx()) {
    const it = state.items[i];
    const b = el("button", "thumb", `<img alt="" src="${it.thumb}"><span class="rt"></span><span class="ed" hidden></span><span class="name"></span>`);
    b.dataset.id = it.id; b.title = it.name; b.setAttribute("aria-current", String(i === state.cur));
    b.querySelector(".name").textContent = it.sample ? "Exemple" : it.name;
    b.onclick = () => select(i);
    strip.appendChild(b); updateThumb(it);
  }
  const n = state.items.length, v = visibleIdx().length;
  $("stripInfo").textContent = !n ? "Aucune photo" : v === n ? `${n} photo${n > 1 ? "s" : ""}` : `${v} affichée${v > 1 ? "s" : ""} sur ${n}`;
  const curThumb = strip.querySelector('[aria-current="true"]'); if (curThumb) curThumb.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function renderStars() {
  const bar = $("starBar"), it = cur(); bar.innerHTML = "";
  for (let s = 1; s <= 5; s++) {
    const b = el("button", it && it.rating >= s ? "on" : "", "★"); b.title = `${s} étoile${s > 1 ? "s" : ""}`; b.disabled = !it;
    b.onclick = () => setRating(it && it.rating === s ? 0 : s);
    bar.appendChild(b);
  }
}
function setRating(r) { const it = cur(); if (!it) return; it.rating = r; saveItem(it); renderStars(); updateThumb(it); if (state.filter) buildStrip(); }
$("ratingFilter").onchange = e => { state.filter = +e.target.value; buildStrip(); };

function select(i) {
  if (state.cropping) exitCrop(false);
  state.cur = i; state.zoom = 1; state.panX = state.panY = 0; beforeKey = null;
  const it = cur();
  refreshAll();
  if (it) { ensureCanvases(it); layout(); refreshImage(); }
}
function refreshAll() {
  const it = cur();
  $("empty").hidden = !!it;
  $("zoomer").hidden = !it;
  $("metaName").textContent = it ? (it.sample ? "Exemple — " + it.name : it.name) : "—";
  $("metaSize").textContent = it ? `${it.w} × ${it.h}` : "";
  for (const id of ["btnAuto", "btnReset", "btnExport", "btnZoom", "btnClip", "btnSync"]) $(id).disabled = !it;
  $("btnBatch").disabled = !it && !host;
  buildStrip(); syncControls(); renderHistory(); renderSnaps(); renderStars(); updateUndo(); markPresets(); applyMode();
}
function step(d) {
  const v = visibleIdx(); if (!v.length) return;
  const k = v.indexOf(state.cur);
  select(v[Math.max(0, Math.min(v.length - 1, (k < 0 ? 0 : k + d)))]);
}
function removeCurrent() {
  const it = cur(); if (!it) return;
  state.items.splice(state.cur, 1);
  if (it.preview) it.preview.close();
  URL.revokeObjectURL(it.thumb);
  if (!state.items.length) { state.cur = -1; refreshAll(); return; }
  select(Math.min(state.cur, state.items.length - 1));
}

/* ---------- Actions globales ---------- */
function cmdAuto() { const it = cur(); if (!it) return; it.params = clone(it.auto); it.preset = "auto"; syncControls(); refreshImage(); pushHistory("Amélioration auto"); }
function cmdReset() { const it = cur(); if (!it) return; it.params = clone(E.DEFAULTS); it.preset = null; syncControls(); refreshImage(); pushHistory("Réinitialisation"); }
function copySettings() { const it = cur(); if (!it) return; state.clipboard = { params: clone(it.params), preset: it.preset }; toast("Réglages copiés"); }
function pasteSettings() {
  const it = cur(); if (!it || !state.clipboard) return;
  const pr = state.clipboard.preset && E.PRESETS.find(p => p.id === state.clipboard.preset);
  if (pr) applyPresetTo(it, pr); else { it.params = clone(state.clipboard.params); it.preset = state.clipboard.preset; }
  syncControls(); refreshImage(); pushHistory("Réglages collés");
}
function syncSettings() {
  const src = cur(); if (!src) return;
  const pr = src.preset && E.PRESETS.find(p => p.id === src.preset);
  let n = 0;
  for (const i of visibleIdx()) {
    const it = state.items[i]; if (it === src) continue;
    if (pr) applyPresetTo(it, pr); else { it.params = clone(src.params); it.preset = src.preset; }
    it.geoCache = null; pushHistory(`Synchronisé depuis ${src.name}`, it); n++;
  }
  toast(n ? `Réglages appliqués à ${n} photo${n > 1 ? "s" : ""}${pr ? " (préréglage adapté à chacune)" : ""}` : "Aucune autre photo visible");
}
$("btnOpen").onclick = cmdOpen;
$("btnOpenFolder").onclick = cmdOpenFolder;
$("emptyOpen").onclick = cmdOpen;
$("emptyFolder").onclick = cmdOpenFolder;
$("emptySample").onclick = loadSample;
$("btnAuto").onclick = cmdAuto;
$("btnReset").onclick = cmdReset;
$("btnUndo").onclick = undo;
$("btnRedo").onclick = redo;
$("btnSync").onclick = syncSettings;

/* ============================================================
   Export et traitement par lot
   ============================================================ */
const dlg = $("dlgExport");
let batch = { running: false, cancel: false };
const extOf = fmt => ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[fmt]);
function expOpts() {
  const x = store.exp;
  return { format: x.format, quality: x.quality / 100, sizeMode: x.sizeMode, longSide: x.longSide, scale: x.scale, watermark: { ...x.watermark, opacity: x.watermark.opacity / 100 } };
}
function formatName(pattern, base, n) {
  const d = new Date(), date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const s = (pattern || "{nom}").replace(/\{nom\}/g, base).replace(/\{n\}/g, String(n).padStart(3, "0")).replace(/\{date\}/g, date);
  return (s.replace(/[\\/:*?"<>|]/g, "_").trim() || base);
}
function downloadBlob(blob, name) {
  const a = el("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function readSource(job) {
  if (job.path) { const u8 = await host.readFile(job.path); return u8; }
  return new Uint8Array(await job.blob.arrayBuffer());
}
async function processJob(job) {
  const file = await readSource(job);
  const transfer = file.byteOffset === 0 && file.byteLength === file.buffer.byteLength ? [file.buffer] : [];
  return getPool().run({ type: "export", file, params: job.params || null, preset: job.preset || null, geo: job.geo || E.DEFAULT_GEO, opts: expOpts() }, transfer);
}

function fillSettingsSelect() {
  const sel = $("bSettings"); sel.innerHTML = "";
  sel.appendChild(new Option("Réglages de chaque photo (retouches enregistrées ou auto)", "own"));
  sel.appendChild(new Option("Réglages de la photo affichée", "current"));
  let lastCat = null, grp = null;
  for (const pr of E.PRESETS) {
    if (pr.cat !== lastCat) { grp = document.createElement("optgroup"); grp.label = "Préréglages pro · " + pr.cat; sel.appendChild(grp); lastCat = pr.cat; }
    grp.appendChild(new Option(pr.name + " — " + pr.sub, pr.id));
  }
  if (store.userPresets.length) {
    grp = document.createElement("optgroup"); grp.label = "Mes préréglages"; sel.appendChild(grp);
    for (const pr of store.userPresets) grp.appendChild(new Option(pr.name, pr.id));
  }
  sel.value = presetById(store.exp.settings) || ["own", "current"].includes(store.exp.settings) ? store.exp.settings : "own";
}
function syncExportForm() {
  const x = store.exp;
  $("eFormat").value = x.format; $("eQuality").value = x.quality; $("eQualityOut").textContent = x.quality;
  $("eSizeMode").value = x.sizeMode; $("eLongSide").value = x.longSide; $("eScale").value = String(x.scale);
  $("bPattern").value = x.pattern; $("bOpenAfter").checked = x.openAfter; $("bMinRating").value = String(x.minRating); $("bRecursive").checked = x.recursive;
  $("bDestPath").textContent = x.dest || "Aucun dossier choisi"; $("bSourcePath").textContent = x.sourceDir || "Aucun dossier choisi";
  dlg.querySelectorAll('input[name="bSource"]').forEach(r => r.checked = r.value === x.source);
  const w = x.watermark;
  $("wEnabled").checked = w.enabled; $("wText").value = w.text; $("wPos").value = w.position;
  $("wOpacity").value = w.opacity; $("wOpacityOut").textContent = w.opacity + " %"; $("wSize").value = w.size; $("wSizeOut").textContent = w.size + " %";
  updateExportVisibility();
}
function updateExportVisibility() {
  const x = store.exp;
  $("eLongSide").hidden = x.sizeMode !== "long"; dlg.querySelector(".unit-long").hidden = x.sizeMode !== "long";
  $("eScale").hidden = x.sizeMode !== "scale";
  $("eQuality").disabled = x.format === "image/png";
  dlg.querySelectorAll(".wm-only").forEach(n => n.hidden = !x.watermark.enabled);
  dlg.querySelectorAll(".folder-only").forEach(n => n.hidden = x.source !== "folder");
  dlg.querySelectorAll(".open-only").forEach(n => n.hidden = x.source !== "open");
  const it = cur();
  $("bPatternEx").textContent = formatName(x.pattern, it ? stripExt(it.name) : "IMG_2041", 1) + "." + extOf(x.format);
  const n = state.items.filter(i => i.rating >= x.minRating).length;
  $("bOpenCount").textContent = `(${n})`;
}
function readExportForm() {
  const x = store.exp;
  x.format = $("eFormat").value; x.quality = +$("eQuality").value; x.sizeMode = $("eSizeMode").value;
  x.longSide = Math.max(200, Math.min(12000, +$("eLongSide").value || 2048)); x.scale = +$("eScale").value;
  x.pattern = $("bPattern").value; x.openAfter = $("bOpenAfter").checked; x.minRating = +$("bMinRating").value; x.recursive = $("bRecursive").checked;
  x.settings = $("bSettings").value || "own";
  x.source = (dlg.querySelector('input[name="bSource"]:checked') || {}).value || "open";
  x.watermark = { enabled: $("wEnabled").checked, text: $("wText").value, position: $("wPos").value, opacity: +$("wOpacity").value, size: +$("wSize").value };
  $("eQualityOut").textContent = x.quality; $("wOpacityOut").textContent = x.watermark.opacity + " %"; $("wSizeOut").textContent = x.watermark.size + " %";
  updateExportVisibility(); saveStore();
}
$("formExport").addEventListener("input", readExportForm);
$("formExport").addEventListener("change", readExportForm);
$("formExport").addEventListener("submit", e => { if (batch.running) e.preventDefault(); });
dlg.addEventListener("cancel", e => { if (batch.running) e.preventDefault(); });
$("bPickDest").onclick = async () => { if (!host) return toast("Disponible dans l'application installée"); const d = await host.pickFolder("Dossier de sortie"); if (d) { store.exp.dest = d; $("bDestPath").textContent = d; saveStore(); } };
$("bPickSource").onclick = async () => {
  if (!host) return toast("Disponible dans l'application installée");
  const d = await host.pickFolder("Dossier de photos à traiter");
  if (d) { store.exp.sourceDir = d; $("bSourcePath").textContent = d; saveStore(); }
};

function openExport(mode) {
  if (batch.running) { dlg.showModal(); return; }
  const it = cur();
  if (mode === "single" && !it) return toast("Ouvrez d'abord une photo");
  dlg.classList.toggle("single", mode === "single");
  dlg.dataset.mode = mode;
  $("expTitle").textContent = mode === "single" ? `Exporter « ${it.name} »` : "Traitement par lot";
  $("expGo").textContent = mode === "single" ? "Exporter" : "Lancer le traitement";
  $("bProgress").hidden = true; $("bErrors").innerHTML = "";
  fillSettingsSelect(); syncExportForm();
  dlg.showModal();
}
$("btnExport").onclick = () => openExport("single");
$("btnBatch").onclick = () => openExport("batch");
$("expGo").onclick = () => (dlg.dataset.mode === "single" ? exportSingle() : runBatch());
$("bCancel").onclick = () => { batch.cancel = true; $("bStatus").textContent = "Arrêt après les photos en cours…"; };

async function exportSingle() {
  const it = cur(); if (!it) return;
  readExportForm();
  const name = stripExt(it.name) + "_revele." + extOf(store.exp.format);
  let outPath = null;
  if (host) {
    const def = it.path ? it.path.replace(/[^\\/]+$/, name) : name;
    outPath = await host.saveDialog(def, extOf(store.exp.format));
    if (!outPath) return;
  }
  dlg.close();
  showBusy(`Export de ${it.name} en pleine résolution…`);
  try {
    const res = await processJob({ path: it.path, blob: it.blob, params: it.params, geo: it.geo });
    if (host) { await host.writeFile(outPath, new Uint8Array(res.buffer)); toast(`Exporté : ${baseName(outPath)} (${res.w} × ${res.h})`); }
    else downloadBlob(new Blob([res.buffer], { type: store.exp.format }), name);
  } catch (e) { console.error(e); toast("L'export a échoué : " + e.message); }
  hideBusy();
}

async function buildJobs() {
  const x = store.exp, setting = x.settings, pr = presetById(setting), it = cur();
  const paramsFor = (auto, own) => {
    if (setting === "own") return own;
    if (setting === "current") return it ? clone(it.params) : own;
    return pr ? E.applyPreset(auto, pr) : own;
  };
  if (x.source === "open") {
    return state.items.filter(i => i.rating >= x.minRating).map(i => ({ name: i.name, path: i.path, blob: i.blob, geo: i.geo, params: paramsFor(i.auto, i.params) }));
  }
  if (!host) return [];
  if (!x.sourceDir) throw new Error("Choisissez le dossier source.");
  const paths = await host.expandPaths([x.sourceDir], x.recursive);
  return paths.map(p => {
    const saved = store.catalogue[p];
    const job = { name: baseName(p), path: p, geo: saved && setting === "own" ? saved.geo : E.DEFAULT_GEO };
    if (setting === "own") { if (saved) job.params = E.normalizeParams(saved.params); else job.preset = E.PRESETS[0]; }
    else if (setting === "current") { if (it) job.params = clone(it.params); else job.preset = E.PRESETS[0]; }
    else if (pr && pr.params) job.params = E.normalizeParams(pr.params);
    else job.preset = pr || E.PRESETS[0];
    return job;
  });
}

async function runBatch() {
  readExportForm();
  const x = store.exp;
  if (host && !x.dest) return toast("Choisissez le dossier de sortie");
  let jobs;
  try { jobs = await buildJobs(); } catch (e) { return toast(e.message); }
  if (!jobs.length) return toast("Aucune photo à traiter avec ces critères");
  batch = { running: true, cancel: false };
  const t0 = Date.now(), total = jobs.length, errors = [];
  let done = 0, next = 0, lastOut = null;
  $("bProgress").hidden = false; $("bErrors").innerHTML = ""; $("bCancel").hidden = false; $("expGo").disabled = true; $("expClose").disabled = true;
  const update = () => {
    $("bBar").style.width = (done / total * 100) + "%";
    const el2 = (Date.now() - t0) / 1000, eta = done ? el2 / done * (total - done) : 0;
    $("bStatus").textContent = `${done} / ${total} photo${total > 1 ? "s" : ""} traitée${done > 1 ? "s" : ""}` + (done && done < total ? ` · environ ${Math.ceil(eta)} s restantes` : "");
  };
  update();
  const lane = async () => {
    while (next < total && !batch.cancel) {
      const n = ++next, job = jobs[n - 1];
      try {
        const res = await processJob(job);
        const name = formatName(x.pattern, stripExt(job.name), n) + "." + extOf(x.format);
        if (host) { const out = await host.uniquePath(x.dest, name); await host.writeFile(out, new Uint8Array(res.buffer)); lastOut = out; }
        else downloadBlob(new Blob([res.buffer], { type: x.format }), name);
      } catch (e) {
        errors.push(`${job.name} : ${e.message}`);
        const li = el("li"); li.textContent = `${job.name} : ${e.message}`; $("bErrors").appendChild(li);
      }
      done++; update();
    }
  };
  await Promise.all(Array.from({ length: getPool().size }, lane));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = done - errors.length;
  $("bStatus").textContent = (batch.cancel ? "Arrêté. " : "Terminé. ") + `${ok} photo${ok > 1 ? "s" : ""} exportée${ok > 1 ? "s" : ""} en ${secs} s` + (errors.length ? ` · ${errors.length} erreur${errors.length > 1 ? "s" : ""}` : "");
  batch.running = false;
  $("bCancel").hidden = true; $("expGo").disabled = false; $("expClose").disabled = false;
  if (host && x.openAfter && ok && !batch.cancel) host.openPath(x.dest);
  else if (host && lastOut && ok) host.reveal(lastOut);
}

/* ============================================================
   Glisser-déposer, clavier, menus
   ============================================================ */
let dragDepth = 0;
window.addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; $("dropHint").hidden = false; });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("dropHint").hidden = true; } });
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", async e => {
  e.preventDefault(); dragDepth = 0; $("dropHint").hidden = true;
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  if (host) {
    const paths = files.map(f => host.pathForFile(f)).filter(Boolean);
    openPaths(await host.expandPaths(paths, true));
  } else openBlobs(files);
});

function isTyping(t) { return t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && !["range", "checkbox", "radio", "button"].includes(t.type)) || t.tagName === "SELECT"); }
window.addEventListener("keydown", e => {
  if (e.key === "Escape" && state.cropping) { exitCrop(false); return; }
  if (isTyping(e.target) || document.querySelector("dialog[open]")) return;
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (ctrl) {
    if (host) return; // les raccourcis Ctrl passent par le menu de l'application
    const map = { z: undo, y: redo, o: e.shiftKey ? cmdOpenFolder : cmdOpen, e: () => openExport(e.shiftKey ? "batch" : "single"), u: cmdAuto };
    if (e.shiftKey && k === "c") { e.preventDefault(); copySettings(); return; }
    if (e.shiftKey && k === "v") { e.preventDefault(); pasteSettings(); return; }
    if (map[k]) { e.preventDefault(); map[k](); }
    return;
  }
  const onRange = e.target && e.target.type === "range";
  if (e.key === "Enter" && state.cropping) { exitCrop(true); return; }
  if (!onRange && e.key === "ArrowLeft") { e.preventDefault(); step(-1); return; }
  if (!onRange && e.key === "ArrowRight") { e.preventDefault(); step(1); return; }
  if (/^[0-5]$/.test(e.key)) { setRating(+e.key); return; }
  if (k === "y") setMode(state.mode === "split" ? "after" : "split");
  else if (k === "j") toggleClip();
  else if (k === "r") state.cropping ? exitCrop(true) : enterCrop();
  else if (e.key === "\\") { if (!state.peek) { state.peek = true; applyMode(); } }
  else if (e.key === "Delete") removeCurrent();
  else if (e.key === "F1") { e.preventDefault(); $("dlgKeys").showModal(); }
  else if (e.key === " ") { state.space = true; if (state.zoom > 1) e.preventDefault(); }
});
window.addEventListener("keyup", e => {
  if (e.key === "\\") { state.peek = false; applyMode(); }
  if (e.key === " ") state.space = false;
});

function onMenu(cmd) {
  const typing = isTyping(document.activeElement);
  const cmds = {
    open: cmdOpen, "open-folder": cmdOpenFolder, export: () => openExport("single"), batch: () => openExport("batch"),
    undo: () => typing ? document.execCommand("undo") : undo(), redo: () => typing ? document.execCommand("redo") : redo(),
    "copy-settings": copySettings, "paste-settings": pasteSettings, auto: cmdAuto, reset: cmdReset,
    "toggle-split": () => setMode(state.mode === "split" ? "after" : "split"), clip: toggleClip, crop: () => enterCrop(),
    "zoom-fit": () => { state.zoom = 1; state.panX = state.panY = 0; layout(); }, "zoom-100": () => { state.zoom = 1; zoomToggle(); },
    remove: removeCurrent, shortcuts: () => $("dlgKeys").showModal(),
  };
  if (cmds[cmd]) cmds[cmd]();
}

/* ============================================================
   Photo d'exemple : soirée prise au smartphone, sombre et bruitée
   ============================================================ */
function makeSample() {
  const w = 1600, h = 1067, c = new OffscreenCanvas(w, h), g = c.getContext("2d"), horizon = h * 0.6;
  let gr = g.createLinearGradient(0, 0, 0, horizon);
  gr.addColorStop(0, "#1d2a44"); gr.addColorStop(0.6, "#7d5a58"); gr.addColorStop(1, "#e7a46a");
  g.fillStyle = gr; g.fillRect(0, 0, w, horizon);
  const sun = g.createRadialGradient(w * 0.7, horizon - 40, 4, w * 0.7, horizon - 40, 230);
  sun.addColorStop(0, "rgba(255,226,170,1)"); sun.addColorStop(0.15, "rgba(255,190,120,.7)"); sun.addColorStop(1, "rgba(255,160,100,0)");
  g.fillStyle = sun; g.fillRect(0, 0, w, horizon);
  const ridge = (base, amp, col, s) => {
    g.beginPath(); g.moveTo(0, horizon + 2);
    for (let x = 0; x <= w; x += 6) g.lineTo(x, base - amp * (0.5 + 0.3 * Math.sin(x * 0.004 + s) + 0.15 * Math.sin(x * 0.013 + s * 2) + 0.06 * Math.sin(x * 0.05 + s)));
    g.lineTo(w, horizon + 2); g.closePath(); g.fillStyle = col; g.fill();
  };
  ridge(horizon - 50, 200, "#5c5a6e", 1.3); ridge(horizon - 15, 150, "#3f4452", 4.1); ridge(horizon + 2, 80, "#2a3330", 2.2);
  g.fillStyle = "#26333b"; g.fillRect(0, horizon, w, h - horizon);
  g.save(); g.globalAlpha = 0.5; g.translate(0, horizon * 2); g.scale(1, -1); g.drawImage(c, 0, 0, w, horizon, 0, 0, w, horizon); g.restore();
  g.beginPath(); g.moveTo(0, h);
  for (let x = 0; x <= w; x += 8) g.lineTo(x, h - 130 - 70 * Math.sin(x * 0.003 + 0.6) - 20 * Math.sin(x * 0.02));
  g.lineTo(w, h); g.closePath(); g.fillStyle = "#1e281a"; g.fill();
  for (let i = 0; i < 44; i++) {
    const x = (i * 211) % w, base = h - 120 - 70 * Math.sin(x * 0.003 + 0.6), th = 60 + (i * 37) % 90;
    g.beginPath(); g.moveTo(x, base - th); g.lineTo(x - th * 0.22, base + 10); g.lineTo(x + th * 0.22, base + 10); g.closePath();
    g.fillStyle = i % 3 ? "#1a2416" : "#243020"; g.fill();
  }
  for (let i = 0; i < 6; i++) { // fenêtres éclairées d'un chalet
    g.fillStyle = "rgba(255,200,120,.95)"; g.fillRect(260 + i * 26, h - 230, 14, 18);
  }
  // Sous-exposition, dominante orangée et bruit de capteur, comme un smartphone à la tombée de la nuit
  const id = g.getImageData(0, 0, w, h), d = id.data;
  let s = 99;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) / 16777216; };
  for (let i = 0; i < d.length; i += 4) {
    const nl = (rnd() - 0.5) * 26, cr = (rnd() - 0.5) * 18, cb = (rnd() - 0.5) * 18;
    d[i] = d[i] * 0.42 + 8 + nl + cr; d[i + 1] = d[i + 1] * 0.36 + 6 + nl; d[i + 2] = d[i + 2] * 0.3 + 5 + nl + cb;
  }
  g.putImageData(id, 0, 0);
  return c;
}
async function loadSample() {
  showBusy("Préparation de l'exemple…");
  const blob = await makeSample().convertToBlob({ type: "image/png" });
  const it = await makeItem({ name: "soiree-smartphone.png", blob });
  it.sample = true;
  state.items.push(it); hideBusy();
  select(state.items.length - 1);
  setMode("split");
}

/* ============================================================
   Démarrage
   ============================================================ */
(async function init() {
  await loadStore();
  buildPanel(); renderPresets(); renderUserPresets();
  refreshAll();
  if (host) {
    host.onMenu(onMenu);
    host.onOpenFiles(files => openPaths(files));
    const initial = await host.initialFiles();
    if (initial.length) await openPaths(initial);
  }
  if (!state.items.length && !host) loadSample();
})();
