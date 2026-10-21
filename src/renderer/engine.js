/* Moteur de développement de Révélateur Photo.
   Partagé entre l'interface (aperçu, analyse) et les workers (export, traitement par lot).
   Tous les calculs se font en flottant 0..1 par canal. */
(function (root) {
"use strict";

const HSL_COLORS = [
  { name: "Rouges",     hue: 0,   css: "#e5484d" },
  { name: "Oranges",    hue: 30,  css: "#f08a24" },
  { name: "Jaunes",     hue: 60,  css: "#e8c62e" },
  { name: "Verts",      hue: 120, css: "#46a758" },
  { name: "Turquoises", hue: 180, css: "#2bb5b5" },
  { name: "Bleus",      hue: 240, css: "#3e63dd" },
  { name: "Violets",    hue: 280, css: "#8e4ec6" },
  { name: "Magentas",   hue: 320, css: "#d6409f" },
];

const IDENTITY = [[0, 0], [1, 1]];
const DEFAULTS = {
  boost: 0,
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temp: 0, tint: 0,
  texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0,
  hslH: [0, 0, 0, 0, 0, 0, 0, 0], hslS: [0, 0, 0, 0, 0, 0, 0, 0], hslL: [0, 0, 0, 0, 0, 0, 0, 0],
  curve: { rgb: IDENTITY, r: IDENTITY, g: IDENTITY, b: IDENTITY },
  shHue: 210, shSat: 0, hiHue: 40, hiSat: 0, balance: 0,
  sharpen: 0, denoise: 0,
  vignette: 0, grain: 0,
};
const DEFAULT_GEO = { rot: 0, flipH: false, flipV: false, angle: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, ratio: "free" };

const clone = o => JSON.parse(JSON.stringify(o));
const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
function smooth(a, b, x) { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }

// Complète des réglages anciens ou partiels avec les valeurs par défaut.
function normalizeParams(p) {
  const out = clone(DEFAULTS);
  if (!p) return out;
  for (const k in DEFAULTS) {
    if (p[k] === undefined) continue;
    if (k === "curve") { for (const c of ["rgb", "r", "g", "b"]) if (Array.isArray(p.curve[c])) out.curve[c] = clone(p.curve[c]); }
    else out[k] = clone(p[k]);
  }
  return out;
}
function normalizeGeo(g) {
  const out = clone(DEFAULT_GEO);
  if (!g) return out;
  Object.assign(out, clone(g));
  out.crop = Object.assign({ x: 0, y: 0, w: 1, h: 1 }, g.crop || {});
  return out;
}

/* ---------- Flou gaussien approché (boîtes séparables) ---------- */
function blur(src, w, h, r, passes) {
  const a = Float32Array.from(src), tmp = new Float32Array(src.length);
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w; let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum * inv;
        sum += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum * inv;
        sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

// Grand rayon : on floute une version réduite puis on remonte en bilinéaire (bien plus rapide, rendu plus doux).
function blurLarge(src, w, h, r, passes) {
  const f = Math.floor(r / 4);
  if (f < 2) return blur(src, w, h, r, passes);
  const sw = Math.ceil(w / f), sh = Math.ceil(h / f), small = new Float32Array(sw * sh), cnt = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++) {
    const row = y * w, srow = ((y / f) | 0) * sw;
    for (let x = 0; x < w; x++) { const k = srow + ((x / f) | 0); small[k] += src[row + x]; cnt[k]++; }
  }
  for (let k = 0; k < small.length; k++) small[k] /= cnt[k];
  const b = blur(small, sw, sh, Math.max(1, Math.round(r / f)), passes);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / f - 0.5)), y0 = fy | 0, y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / f - 0.5)), x0 = fx | 0, x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = b[y0 * sw + x0] + (b[y0 * sw + x1] - b[y0 * sw + x0]) * tx;
      const c = b[y1 * sw + x0] + (b[y1 * sw + x1] - b[y1 * sw + x0]) * tx;
      out[y * w + x] = a + (c - a) * ty;
    }
  }
  return out;
}

/* ---------- Courbe des tonalités : interpolation cubique monotone ---------- */
function isIdentity(pts) {
  return !pts || (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1);
}
function curveLUT(pts, size) {
  size = size || 1024;
  const P = pts.slice().sort((a, b) => a[0] - b[0]), n = P.length;
  const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  const lut = new Float32Array(size);
  let k = 0;
  for (let j = 0; j < size; j++) {
    const x = j / (size - 1); let y;
    if (x <= xs[0]) y = ys[0];
    else if (x >= xs[n - 1]) y = ys[n - 1];
    else {
      while (k < n - 2 && x > xs[k + 1]) k++;
      const h = Math.max(1e-6, xs[k + 1] - xs[k]), t = (x - xs[k]) / h, t2 = t * t, t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
    }
    lut[j] = clamp01(y);
  }
  return lut;
}

function hueVec(h) {
  const f = n => { const k = (n + h / 60) % 6; return 1 - Math.max(0, Math.min(k, 4 - k, 1)); };
  const r = f(5), g = f(3), b = f(1), l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r - l, g - l, b - l];
}

// Tables 360° interpolées (cosinus) entre les 8 couleurs du mixeur TSL
function hslTables(p) {
  const C = HSL_COLORS.map(c => c.hue).concat(360);
  const H = new Float32Array(360), S = new Float32Array(360), L = new Float32Array(360);
  for (let deg = 0; deg < 360; deg++) {
    let i = 0; while (deg >= C[i + 1]) i++;
    let t = (deg - C[i]) / (C[i + 1] - C[i]); t = (1 - Math.cos(Math.PI * t)) / 2;
    const j = (i + 1) % 8;
    H[deg] = (p.hslH[i] * (1 - t) + p.hslH[j] * t) / 100;
    S[deg] = (p.hslS[i] * (1 - t) + p.hslS[j] * t) / 100;
    L[deg] = (p.hslL[i] * (1 - t) + p.hslL[j] * t) / 100;
  }
  return { H, S, L };
}

/* ---------- Développement ---------- */
function develop(src, w, h, p, out) {
  const n = w * h;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), L = new Float32Array(n);

  // 1. Balance des blancs + exposition (lumière linéaire, tables 8 bits)
  const t = p.temp / 100, ti = p.tint / 100;
  const mR = 1 + t * 0.3, mB = 1 - t * 0.3, mG = 1 - ti * 0.25;
  const norm = 1 / (0.2126 * mR + 0.7152 * mG + 0.0722 * mB), ev = Math.pow(2, p.exposure);
  const lr = new Float32Array(256), lg = new Float32Array(256), lb = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const lin = Math.pow(i / 255, 2.2) * ev * norm;
    lr[i] = Math.pow(lin * mR, 1 / 2.2); lg[i] = Math.pow(lin * mG, 1 / 2.2); lb[i] = Math.pow(lin * mB, 1 / 2.2);
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) { R[i] = lr[src[j]]; G[i] = lg[src[j + 1]]; B[i] = lb[src[j + 2]]; }

  // Les rayons suivent la taille de l'image : l'aperçu et l'export pleine résolution ont le même rendu.
  const big = Math.max(w, h), sizeK = big / 2000;

  // 2. Réduction du bruit : luminance (préserve les contours) puis chrominance (taches colorées des smartphones)
  if (p.denoise > 0) {
    const amt = p.denoise / 100, sig = 0.02 + amt * 0.07, sig2 = sig * sig;
    const rad = Math.max(1, Math.round(sizeK * (1 + amt * 1.5))), edgeR = Math.max(1, Math.round(sizeK));
    for (let i = 0; i < n; i++) L[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    const bL = blur(L, w, h, edgeR, 2), bR = blur(R, w, h, rad, 2), bG = blur(G, w, h, rad, 2), bB = blur(B, w, h, rad, 2);
    for (let i = 0; i < n; i++) {
      const e = L[i] - bL[i], k = amt * Math.exp(-(e * e) / sig2);
      R[i] += (bR[i] - R[i]) * k; G[i] += (bG[i] - G[i]) * k; B[i] += (bB[i] - B[i]) * k;
    }
    const cR = new Float32Array(n), cB = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i]; cR[i] = R[i] - L[i]; cB[i] = B[i] - L[i]; }
    const cRad = Math.max(2, Math.round(sizeK * (3 + amt * 4)));
    const bcR = blurLarge(cR, w, h, cRad, 2), bcB = blurLarge(cB, w, h, cRad, 2);
    const ca = Math.min(1, amt * 1.6);
    for (let i = 0; i < n; i++) {
      const r = L[i] + cR[i] + (bcR[i] - cR[i]) * ca, b = L[i] + cB[i] + (bcB[i] - cB[i]) * ca;
      R[i] = r; B[i] = b; G[i] = (L[i] - 0.2126 * r - 0.0722 * b) / 0.7152;
    }
  }

  // 2b. Éclaircissement intelligent (exposition locale) : le gain dépend de la luminosité du voisinage,
  // les zones sombres sont relevées fortement, les zones déjà claires presque pas.
  if (p.boost > 0) {
    const a = p.boost / 100;
    for (let i = 0; i < n; i++) L[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    const b1 = blurLarge(L, w, h, Math.max(2, Math.round(big * 0.03)), 3), b2 = blurLarge(L, w, h, Math.max(1, Math.round(big * 0.006)), 2);
    const maxG = 1 + a * 3, ex = a * 0.75;
    for (let i = 0; i < n; i++) {
      const base = Math.max(0.02, 0.6 * b1[i] + 0.4 * b2[i]);
      let gn = Math.pow(0.48 / base, ex);
      gn = gn < 1 ? 1 : gn > maxG ? maxG : gn;
      const l = L[i];
      if (l * gn > 0.9) gn = Math.max(1, (0.9 + (l * gn - 0.9) * 0.25) / Math.max(l, 1e-4)); // garde les hautes lumières
      R[i] *= gn; G[i] *= gn; B[i] *= gn;
    }
  }

  // 3. Tonalité sur la luminance (teintes préservées)
  const bp = -p.blacks / 100 * 0.12, wp = 1 - p.whites / 100 * 0.2, inv = 1 / Math.max(0.05, wp - bp);
  const sh = p.shadows / 100, hi = p.highlights / 100, c = p.contrast / 100;
  for (let i = 0; i < n; i++) {
    const r = R[i], g = G[i], b = B[i];
    const Lin = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let l = (Lin - bp) * inv, lc = clamp01(l);
    if (sh) { const q = 1 - lc; l += sh * 0.5 * 4 * lc * q * q * q; }
    if (hi) { const m = smooth(0.4, 1, l); l += hi < 0 ? hi * 0.3 * m * Math.min(l, 1.6) : hi * 0.6 * m * (1 - lc); }
    lc = clamp01(l);
    if (c > 0) l += (lc * lc * (3 - 2 * lc) - lc) * c;
    else if (c < 0) l = 0.5 + (l - 0.5) * (1 + c * 0.5);
    const k = l / Math.max(Lin, 1e-5), d = l - Lin, wt = Lin < 0.03 ? Lin / 0.03 : 1;
    R[i] = r * k * wt + (r + d) * (1 - wt);
    G[i] = g * k * wt + (g + d) * (1 - wt);
    B[i] = b * k * wt + (b + d) * (1 - wt);
    L[i] = l;
  }

  // 4. Contraste local : texture (fin), clarté (moyen), correction du voile
  if (p.clarity || p.dehaze || p.texture) {
    const bl = (p.clarity || p.dehaze) ? blurLarge(L, w, h, Math.max(2, Math.round(big * 0.012)), 3) : null;
    const bs = p.texture ? blur(L, w, h, Math.max(1, Math.round(big * 0.0025)), 2) : null;
    const cl = p.clarity / 100, dh = p.dehaze / 100, tx = p.texture / 100;
    const k = dh > 0 ? dh * 0.12 : 0, ik = 1 / (1 - k), fog = dh < 0 ? -dh * 0.4 : 0;
    for (let i = 0; i < n; i++) {
      const l = L[i], lc = clamp01(l), m = 1 - (2 * lc - 1) * (2 * lc - 1);
      let delta = 0;
      if (bl) { const d = l - bl[i]; delta += cl * d * (0.25 + 0.75 * m) + (dh > 0 ? dh * 0.5 * d : 0); }
      if (bs) delta += tx * 0.9 * (l - bs[i]) * (0.3 + 0.7 * m);
      let r = R[i] + delta, g = G[i] + delta, b = B[i] + delta;
      if (k) { r = (r - k) * ik; g = (g - k) * ik; b = (b - k) * ik; }
      if (fog) { r += (0.8 - r) * fog; g += (0.8 - g) * fog; b += (0.8 - b) * fog; }
      R[i] = r; G[i] = g; B[i] = b;
    }
  }

  // 5. Courbe des tonalités (RVB puis canaux séparés)
  const cm = isIdentity(p.curve.rgb) ? null : curveLUT(p.curve.rgb);
  const cr = isIdentity(p.curve.r) ? null : curveLUT(p.curve.r);
  const cg = isIdentity(p.curve.g) ? null : curveLUT(p.curve.g);
  const cb = isIdentity(p.curve.b) ? null : curveLUT(p.curve.b);
  if (cm || cr || cg || cb) {
    const ix = v => (v <= 0 ? 0 : v >= 1 ? 1023 : (v * 1023 + 0.5) | 0);
    for (let i = 0; i < n; i++) {
      let r = R[i], g = G[i], b = B[i];
      if (cm) { r = cm[ix(r)]; g = cm[ix(g)]; b = cm[ix(b)]; }
      if (cr) r = cr[ix(r)];
      if (cg) g = cg[ix(g)];
      if (cb) b = cb[ix(b)];
      R[i] = r; G[i] = g; B[i] = b;
    }
  }

  // 6. Couleur : mixeur TSL, vibrance, saturation, étalonnage
  const hslOn = p.hslH.some(v => v) || p.hslS.some(v => v) || p.hslL.some(v => v);
  const T = hslOn ? hslTables(p) : null;
  const sat = p.saturation / 100 + Math.max(0, p.dehaze) / 100 * 0.25, vib = p.vibrance / 100;
  const sv = hueVec(p.shHue), hv = hueVec(p.hiHue), ss = p.shSat / 100 * 0.22, hs = p.hiSat / 100 * 0.22, bal = p.balance / 100 * 0.3;
  for (let i = 0; i < n; i++) {
    let r = R[i], g = G[i], b = B[i];
    if (T) {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (d > 1e-4 && mx > 0) {
        let hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        hh *= 60; if (hh < 0) hh += 360;
        const idx = Math.min(359, hh | 0);
        let s = d / mx;
        const ws = Math.min(1, s * 2);
        hh = (hh + T.H[idx] * 30 * ws + 360) % 360;
        s = clamp01(s * (1 + T.S[idx]));
        const v = mx * (1 + T.L[idx] * 0.35 * ws);
        const C = v * s, X = C * (1 - Math.abs(((hh / 60) % 2) - 1)), m0 = v - C, seg = (hh / 60) | 0;
        let rr, gg, bb;
        if (seg === 0) { rr = C; gg = X; bb = 0; } else if (seg === 1) { rr = X; gg = C; bb = 0; }
        else if (seg === 2) { rr = 0; gg = C; bb = X; } else if (seg === 3) { rr = 0; gg = X; bb = C; }
        else if (seg === 4) { rr = X; gg = 0; bb = C; } else { rr = C; gg = 0; bb = X; }
        r = rr + m0; g = gg + m0; b = bb + m0;
      }
    }
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), cs = Math.min(1, (mx - mn) * 1.5);
    let vf = vib * (1 - cs) * 1.2;
    if (vf > 0 && r > g && g > b) vf *= 0.6; // protège les tons chair
    const f = Math.max(0, 1 + sat + vf);
    r = l + (r - l) * f; g = l + (g - l) * f; b = l + (b - l) * f;
    if (ss || hs) {
      const lb2 = clamp01(l + bal), ws = (1 - lb2) * (1 - lb2) * ss, wh = lb2 * lb2 * hs;
      r += sv[0] * ws + hv[0] * wh; g += sv[1] * ws + hv[1] * wh; b += sv[2] * ws + hv[2] * wh;
    }
    R[i] = r; G[i] = g; B[i] = b;
    L[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // 7. Netteté, vignetage, grain, compression du gamut, sortie 8 bits
  const shAmt = p.sharpen / 100 * 1.2;
  const sb = shAmt ? blur(L, w, h, Math.max(1, Math.round(big / 3000)), 2) : null;
  const vig = p.vignette / 100 * 0.75, gr = p.grain / 100 * 0.14;
  const cx = w / 2, cy = h / 2;
  let seed = 1234567;
  const o = out.data;
  for (let y = 0, i = 0; y < h; y++) {
    const dy = (y - cy) / cy;
    for (let x = 0; x < w; x++, i++) {
      let r = R[i], g = G[i], b = B[i];
      if (sb) {
        let d = L[i] - sb[i]; const ad = d < 0 ? -d : d;
        d *= smooth(0.002, 0.012, ad) * shAmt;
        r += d; g += d; b += d;
      }
      if (vig) {
        const dx = (x - cx) / cx, v = smooth(0.35, 1.0, Math.sqrt((dx * dx + dy * dy) / 2) * 1.15);
        const k = 1 + vig * v; r *= k; g *= k; b *= k;
        if (vig > 0) { const a = vig * v * 0.6; r += (1 - r) * a; g += (1 - g) * a; b += (1 - b) * a; }
      }
      if (gr) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const l = clamp01(L[i]), nz = (seed / 4294967296 - 0.5) * gr * (0.4 + 2.4 * l * (1 - l));
        r += nz; g += nz; b += nz;
      }
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx > 1) {
        if (lum < 1) { const k = (1 - lum) / (mx - lum); r = lum + (r - lum) * k; g = lum + (g - lum) * k; b = lum + (b - lum) * k; }
        else { r = g = b = 1; }
      }
      if (mn < 0 && lum > 0) { const k = lum / (lum - mn); r = lum + (r - lum) * k; g = lum + (g - lum) * k; b = lum + (b - lum) * k; }
      const j = i * 4;
      o[j] = r * 255 + 0.5; o[j + 1] = g * 255 + 0.5; o[j + 2] = b * 255 + 0.5; o[j + 3] = 255;
    }
  }
  return out;
}

/* ---------- Analyse automatique ---------- */
// Analyse automatique. Pensée d'abord pour les photos de smartphone peu éclairées :
// elle mesure la luminosité, la dominante de couleur et le niveau de bruit, puis dose
// éclaircissement local, exposition, débruitage et netteté en conséquence.
function analyze(data, w, h) {
  const n = w * h, step = Math.max(1, Math.floor(n / 250000));
  const hist = new Uint32Array(1024);
  let sr = 0, sg = 0, sb = 0, cnt = 0, total = 0;
  for (let i = 0; i < n; i += step) {
    const j = i * 4, r = data[j] / 255, g = data[j + 1] / 255, b = data[j + 2] / 255;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    hist[Math.min(1023, (L * 1023) | 0)]++; total++;
    if (L > 0.06 && L < 0.92) { sr += Math.pow(r, 2.2); sg += Math.pow(g, 2.2); sb += Math.pow(b, 2.2); cnt++; }
  }
  const pct = q => { const target = q * total; let acc = 0; for (let i = 0; i < 1024; i++) { acc += hist[i]; if (acc >= target) return i / 1023; } return 1; };
  // Bruit : médiane du laplacien absolu dans les zones sombres et moyennes
  const nh = new Uint32Array(256), gs = Math.max(2, Math.round(Math.sqrt(n / 60000)));
  const lum = j => 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2];
  let nc = 0;
  for (let y = 1; y < h - 1; y += gs) for (let x = 1; x < w - 1; x += gs) {
    const i = (y * w + x) * 4, c = lum(i);
    if (c > 150) continue;
    const lap = Math.abs(4 * c - lum(i - 4) - lum(i + 4) - lum(i - w * 4) - lum(i + w * 4)) / 255;
    nh[Math.min(255, (lap * 1000) | 0)]++; nc++;
  }
  let noise = 0;
  if (nc > 50) { let acc = 0; for (let i = 0; i < 256; i++) { acc += nh[i]; if (acc >= nc / 2) { noise = i / 1000; break; } } }
  return { pct, sr, sg, sb, cnt, noise, median: pct(0.5) };
}

function autoParams(data, w, h) {
  const A = analyze(data, w, h), pct = A.pct, P = clone(DEFAULTS);
  const med = A.median;
  const low = smooth(0.30, 0.08, med); // 0 = photo bien exposée, 1 = très sombre

  if (A.cnt > 100) {
    const strength = 0.55 + 0.15 * low;
    const a = (A.sb - A.sr) / (A.sb + A.sr);
    const T = Math.max(-0.35, Math.min(0.35, a / 0.3 * strength));
    P.temp = Math.round(T * 100);
    const target = (A.sr * (1 + 0.3 * T) + A.sb * (1 - 0.3 * T)) / 2, mulG = target / Math.max(A.sg, 1e-6);
    P.tint = Math.round(Math.max(-0.3, Math.min(0.3, (1 - mulG) / 0.25 * 0.5)) * 100);
  }

  // Éclaircissement local d'abord, l'exposition globale complète
  P.boost = Math.round(low * 75);
  const ev = Math.max(-1.2, Math.min(1.8, 2.2 * Math.log2(0.46 / Math.max(med, 0.02)) * 0.6 * (1 - 0.45 * low)));
  P.exposure = Math.round(ev * 20) / 20;

  const gain = Math.pow(2, P.exposure / 2.2) * (1 + P.boost / 100 * 0.8), rawLo = pct(0.005);
  const lo = rawLo * gain, hiV = pct(0.995) * Math.pow(2, P.exposure / 2.2);
  P.blacks = Math.round(Math.max(-70, Math.min(0, -(lo * 0.9) / 0.12 * 100)));
  P.whites = Math.round(Math.max(-40, Math.min(50, (1 - Math.max(0.75, Math.min(1.25, hiV))) / 0.2 * 100)));
  const bp = -P.blacks / 100 * 0.12, wp = 1 - P.whites / 100 * 0.2, lev = x => (x * gain - bp) / (wp - bp);
  const p25 = lev(pct(0.25)), p95 = lev(pct(0.95)), spread = lev(pct(0.9)) - lev(pct(0.1));
  P.shadows = Math.round(Math.min(55, 10 + 10 * low + (p25 < 0.2 ? (0.2 - p25) * 200 : 0)));
  P.highlights = Math.round(Math.max(-70, -15 - (p95 > 0.9 ? (p95 - 0.9) * 400 : 0) - (hiV > 1 ? (hiV - 1) * 150 : 0)));
  P.contrast = Math.round(Math.min(30, 8 + (spread < 0.55 ? (0.55 - spread) * 120 : 0)));
  P.dehaze = low > 0.3 ? 0 : Math.round(Math.max(0, Math.min(30, (rawLo - 0.06) * 150)));

  // Débruitage : bruit mesuré, amplifié par l'éclaircissement appliqué
  const brighten = Math.pow(2, Math.max(0, P.exposure)) * (1 + P.boost / 100 * 1.5);
  P.denoise = Math.round(Math.max(0, Math.min(80, (A.noise - 0.008) * 1800 * Math.sqrt(brighten) + low * 15)));

  P.vibrance = Math.round(22 + 10 * low);
  P.clarity = Math.round(12 - 10 * low);
  P.texture = P.denoise > 30 ? 0 : Math.round(8 * (1 - low));
  P.sharpen = Math.round(35 - 15 * low);
  return P;
}

/* ---------- Préréglages intégrés (adaptatifs : partent de l'analyse auto) ---------- */
// Courbes : raccourci pour définir les 4 canaux (identité par défaut)
const crv = (rgb, r, g, b) => ({ rgb: rgb || IDENTITY, r: r || IDENTITY, g: g || IDENTITY, b: b || IDENTITY });
const hsl8 = o => { const a = [0, 0, 0, 0, 0, 0, 0, 0]; for (const k in o) a[k] = o[k]; return a; };
// Index du mixeur TSL : 0 rouges, 1 oranges, 2 jaunes, 3 verts, 4 turquoises, 5 bleus, 6 violets, 7 magentas

const PRESETS = [
  // Essentiels
  { id: "auto", cat: "Essentiels", name: "Auto pro", sub: "Correction neutre" },
  { id: "natural", cat: "Essentiels", name: "Naturel", sub: "Fidèle, un peu de peps", add: { vibrance: 10, clarity: 6 } },
  { id: "vivid", cat: "Essentiels", name: "Éclatant", sub: "Couleurs riches", add: { vibrance: 30, saturation: 8, contrast: 14, clarity: 14, dehaze: 8 } },
  { id: "hdr", cat: "Essentiels", name: "HDR naturel", sub: "Ombres et ciels récupérés", add: { highlights: -70, shadows: 55, whites: 15, blacks: -15, clarity: 25, texture: 15, vibrance: 15 }, set: { sharpen: 45 } },
  { id: "matte", cat: "Essentiels", name: "Mat doux", sub: "Contraste feutré", add: { contrast: -8, saturation: -6, shadows: 10 }, set: { curve: crv([[0, 0.12], [0.3, 0.3], [0.7, 0.72], [1, 0.97]]) } },

  // Smartphone & basse lumière (partent de l'analyse auto, qui dose déjà débruitage et éclaircissement)
  { id: "lowlight", cat: "Smartphone & basse lumière", name: "Boost basse lumière", sub: "Débouche les zones sombres", add: { boost: 25, shadows: 10, vibrance: 8, denoise: 10 } },
  { id: "phone-night", cat: "Smartphone & basse lumière", name: "Nuit smartphone", sub: "Bruit maîtrisé, lumières propres", add: { boost: 30, highlights: -35, blacks: -8, denoise: 25, clarity: -6, vibrance: 12 }, set: { texture: 0, sharpen: 20, grain: 0 } },
  { id: "indoor", cat: "Smartphone & basse lumière", name: "Intérieur sombre", sub: "Ampoules jaunes neutralisées", add: { boost: 25, temp: -12, shadows: 15, denoise: 15, vibrance: 10 }, set: { hslS: hsl8({ 1: -15, 2: -20 }) } },
  { id: "backlight", cat: "Smartphone & basse lumière", name: "Contre-jour", sub: "Sujet éclairé, ciel conservé", add: { boost: 40, highlights: -55, shadows: 35, whites: -5, clarity: 8, denoise: 10 } },
  { id: "selfie-dark", cat: "Smartphone & basse lumière", name: "Selfie peu éclairé", sub: "Visage lumineux, peau lisse", add: { boost: 30, exposure: 0.15, texture: -25, clarity: -8, temp: 5, denoise: 20 }, set: { sharpen: 15, hslL: hsl8({ 1: 15 }), hslS: hsl8({ 1: -10 }) } },
  { id: "concert", cat: "Smartphone & basse lumière", name: "Concert & soirée", sub: "Couleurs de scène, noirs profonds", add: { boost: 20, highlights: -40, blacks: -15, contrast: 10, vibrance: 20, denoise: 25 }, set: { hslS: hsl8({ 5: 15, 6: 20, 7: 20 }), vignette: -15 } },
  { id: "restore", cat: "Smartphone & basse lumière", name: "Restaurer photo terne", sub: "Voile, couleurs fades", add: { dehaze: 20, contrast: 12, vibrance: 25, clarity: 12, texture: 10 }, set: { sharpen: 45 } },

  // Portrait
  { id: "portrait", cat: "Portrait", name: "Portrait doux", sub: "Peau lissée, chaud", add: { clarity: -22, texture: -25, temp: 7, highlights: -15, shadows: 15, vibrance: -5, denoise: 25 }, set: { sharpen: 20, hslL: hsl8({ 1: 12 }), hslS: hsl8({ 1: -10 }) } },
  { id: "studio", cat: "Portrait", name: "Studio beauté", sub: "Peau nette et lumineuse", add: { exposure: 0.15, texture: -35, clarity: -10, whites: 12, highlights: -10, vibrance: 5 }, set: { sharpen: 30, denoise: 20, hslL: hsl8({ 0: 5, 1: 15, 2: 5 }), hslS: hsl8({ 0: -8, 1: -12 }) } },
  { id: "editorial", cat: "Portrait", name: "Éditorial mode", sub: "Contrasté, désaturé", add: { contrast: 22, clarity: 15, saturation: -18, blacks: -10 }, set: { shHue: 215, shSat: 12, hiHue: 35, hiSat: 10, vignette: -18, hslS: hsl8({ 1: -5, 3: -30, 5: -25 }) } },
  { id: "warmskin", cat: "Portrait", name: "Lumière dorée peau", sub: "Peau chaude, fond calme", add: { temp: 12, tint: 5, shadows: 12, highlights: -15 }, set: { hiHue: 38, hiSat: 18, hslL: hsl8({ 1: 10 }), hslS: hsl8({ 3: -25, 4: -20, 5: -15 }), vignette: -12 } },

  // Mariage & événement
  { id: "wedding-airy", cat: "Mariage", name: "Lumineux aérien", sub: "Blanc pur, pastel", add: { exposure: 0.35, contrast: -12, highlights: -25, shadows: 30, whites: 10, vibrance: -5, saturation: -10, temp: 4 }, set: { texture: -10, curve: crv([[0, 0.06], [0.5, 0.54], [1, 1]]), hslL: hsl8({ 1: 12, 3: 10 }), hslS: hsl8({ 3: -25 }) } },
  { id: "wedding-romantic", cat: "Mariage", name: "Romantique", sub: "Rosé, doux", add: { contrast: -6, saturation: -8, temp: 6, tint: 8, clarity: -10 }, set: { hiHue: 340, hiSat: 14, shHue: 30, shSat: 10, vignette: -15 } },
  { id: "wedding-moody", cat: "Mariage", name: "Sombre élégant", sub: "Tons profonds, vert olive", add: { exposure: -0.2, contrast: 12, highlights: -35, blacks: 8, saturation: -10 }, set: { hslH: hsl8({ 2: -20, 3: -25 }), hslS: hsl8({ 2: -20, 3: -35, 5: -30 }), hslL: hsl8({ 3: -15 }), vignette: -25, curve: crv([[0, 0.05], [0.5, 0.47], [1, 0.95]]) } },

  // Paysage & nature
  { id: "landscape", cat: "Paysage", name: "Paysage", sub: "Ciel et détails", add: { dehaze: 22, clarity: 22, texture: 15, vibrance: 35, highlights: -35, shadows: 25 }, set: { sharpen: 55, hslL: hsl8({ 5: -18 }), hslS: hsl8({ 3: 12, 4: 10, 5: 15 }) } },
  { id: "bluesky", cat: "Paysage", name: "Ciel bleu profond", sub: "Ciel dense, nuages nets", add: { highlights: -45, dehaze: 15, clarity: 15 }, set: { hslL: hsl8({ 4: -15, 5: -30 }), hslS: hsl8({ 4: 15, 5: 25 }), hslH: hsl8({ 5: -5 }) } },
  { id: "forest", cat: "Paysage", name: "Forêt émeraude", sub: "Verts riches et profonds", add: { contrast: 10, clarity: 18, shadows: 15 }, set: { hslH: hsl8({ 2: -15, 3: 15 }), hslS: hsl8({ 2: -10, 3: 20, 4: 10 }), hslL: hsl8({ 3: -15 }), vignette: -15 } },
  { id: "autumn", cat: "Paysage", name: "Automne", sub: "Oranges et rouges chauds", add: { temp: 10, vibrance: 25 }, set: { hslH: hsl8({ 2: -12, 3: -30 }), hslS: hsl8({ 0: 15, 1: 25, 2: 15, 3: -20 }), hslL: hsl8({ 1: 5 }) } },
  { id: "sunset", cat: "Paysage", name: "Coucher de soleil", sub: "Ciel flamboyant", add: { temp: 18, tint: 6, highlights: -40, shadows: 20, vibrance: 30, dehaze: 10 }, set: { hslS: hsl8({ 0: 15, 1: 25, 6: 15, 7: 15 }), hiHue: 30, hiSat: 25, shHue: 260, shSat: 15 } },
  { id: "sea", cat: "Paysage", name: "Mer turquoise", sub: "Eau claire, sable doux", add: { vibrance: 25, dehaze: 12, highlights: -25 }, set: { hslH: hsl8({ 4: -8, 5: -10 }), hslS: hsl8({ 4: 30, 5: 15 }), hslL: hsl8({ 4: 10, 2: 8 }) } },

  // Produit, culinaire, immobilier
  { id: "product", cat: "Commercial", name: "Produit e-commerce", sub: "Fond blanc, net, neutre", add: { exposure: 0.25, whites: 25, highlights: 10, shadows: 15, vibrance: 5, texture: 15 }, set: { temp: 0, tint: 0, sharpen: 60, dehaze: 0 } },
  { id: "food", cat: "Commercial", name: "Culinaire appétissant", sub: "Chaud, texturé, gourmand", add: { temp: 8, texture: 20, clarity: 10, vibrance: 20, shadows: 15 }, set: { sharpen: 45, hslS: hsl8({ 0: 10, 1: 15, 2: 10, 3: 15 }), hslL: hsl8({ 0: 5, 1: 8 }), vignette: -12 } },
  { id: "realestate", cat: "Commercial", name: "Immobilier", sub: "Intérieurs clairs, fenêtres lisibles", add: { exposure: 0.3, highlights: -60, shadows: 45, whites: 15, clarity: 10, vibrance: 10 }, set: { temp: 0, sharpen: 40 } },
  { id: "architecture", cat: "Commercial", name: "Architecture", sub: "Lignes nettes, ciel froid", add: { clarity: 25, texture: 20, contrast: 12, highlights: -30, temp: -5 }, set: { sharpen: 60, hslS: hsl8({ 1: -10, 2: -15 }), hslL: hsl8({ 5: -15 }) } },

  // Urbain & nuit
  { id: "night", cat: "Urbain & nuit", name: "Nuit urbaine", sub: "Néons, noirs propres", add: { highlights: -30, blacks: -15, clarity: 15, vibrance: 25, temp: -8 }, set: { denoise: 40, hslS: hsl8({ 5: 20, 6: 25, 7: 25 }), hslH: hsl8({ 1: -10 }) } },
  { id: "cyber", cat: "Urbain & nuit", name: "Cyberpunk", sub: "Magenta et cyan", add: { contrast: 15, saturation: 10, temp: -15, tint: 20 }, set: { shHue: 200, shSat: 45, hiHue: 310, hiSat: 35, hslH: hsl8({ 1: -25, 2: -40, 3: 60 }), vignette: -25 } },
  { id: "street", cat: "Urbain & nuit", name: "Street gritty", sub: "Brut, granuleux", add: { contrast: 25, clarity: 35, texture: 20, saturation: -30, blacks: -10 }, set: { grain: 22, vignette: -25 } },

  // Cinéma
  { id: "cinema", cat: "Cinéma", name: "Sarcelle & orange", sub: "Blockbuster", add: { contrast: 10, saturation: -12, blacks: 12 }, set: { shHue: 195, shSat: 38, hiHue: 32, hiSat: 32, vignette: -22, hslH: hsl8({ 1: -8, 3: 40, 4: 25, 5: -10 }) } },
  { id: "bleach", cat: "Cinéma", name: "Sans blanchiment", sub: "Argenté, dur", add: { contrast: 30, saturation: -45, clarity: 20 }, set: { curve: crv([[0, 0], [0.25, 0.18], [0.75, 0.84], [1, 1]]), grain: 12 } },
  { id: "noir-vert", cat: "Cinéma", name: "Thriller vert", sub: "Froid et inquiétant", add: { contrast: 15, saturation: -20, exposure: -0.15 }, set: { shHue: 150, shSat: 30, hiHue: 60, hiSat: 12, vignette: -30 } },
  { id: "golden", cat: "Cinéma", name: "Heure dorée", sub: "Lumière chaude", add: { temp: 20, tint: 4, vibrance: 20, shadows: 10 }, set: { hiHue: 40, hiSat: 25, vignette: -15 } },
  { id: "nordic", cat: "Cinéma", name: "Nordique", sub: "Froid, épuré", add: { temp: -14, saturation: -20, shadows: 20, contrast: -6, whites: 10 }, set: { shHue: 210, shSat: 15 } },

  // Émulations argentiques
  { id: "portra", cat: "Argentique", name: "Portra 400", sub: "Peaux douces, pastels chauds", add: { contrast: -5, saturation: -8, temp: 6, shadows: 10 }, set: { curve: crv([[0, 0.05], [0.3, 0.3], [0.7, 0.73], [1, 0.97]], null, null, [[0, 0.05], [1, 0.95]]), hslH: hsl8({ 3: -15 }), hslS: hsl8({ 1: -5, 3: -20, 5: -15 }), grain: 18 } },
  { id: "ektar", cat: "Argentique", name: "Ektar 100", sub: "Saturé, grain fin", add: { contrast: 15, saturation: 15, vibrance: 10 }, set: { hslS: hsl8({ 0: 15, 5: 20 }), hslL: hsl8({ 5: -10 }), grain: 8 } },
  { id: "fuji", cat: "Argentique", name: "Fuji classique", sub: "Verts frais, magentas", add: { contrast: 8, temp: -4, tint: -4 }, set: { hslH: hsl8({ 3: 15, 5: -5 }), hslS: hsl8({ 3: 10, 7: 10 }), shHue: 170, shSat: 12, grain: 15, curve: crv([[0, 0.04], [0.5, 0.5], [1, 0.97]]) } },
  { id: "film", cat: "Argentique", name: "Argentique passé", sub: "Noirs passés, grain", add: { blacks: 10, contrast: 6, saturation: -10 }, set: { grain: 25, hiHue: 45, hiSat: 15, shHue: 170, shSat: 14, curve: crv([[0, 0.08], [0.25, 0.24], [0.75, 0.78], [1, 0.95]]) } },
  { id: "polaroid", cat: "Argentique", name: "Instantané 70s", sub: "Délavé, cyan dans les ombres", add: { contrast: -10, saturation: -15, temp: 8, exposure: 0.1 }, set: { shHue: 185, shSat: 25, hiHue: 50, hiSat: 20, vignette: -30, grain: 20, curve: crv([[0, 0.12], [0.5, 0.52], [1, 0.92]]) } },

  // Noir & blanc
  { id: "bw", cat: "Noir & blanc", name: "N&B contrasté", sub: "Contraste profond", add: { contrast: 28, clarity: 22 }, set: { saturation: -100, vibrance: 0, grain: 14, vignette: -20, shSat: 0, hiSat: 0 } },
  { id: "bw-soft", cat: "Noir & blanc", name: "N&B doux", sub: "Gris nuancés", add: { contrast: -5, shadows: 20, highlights: -20 }, set: { saturation: -100, vibrance: 0, shSat: 0, hiSat: 0, curve: crv([[0, 0.05], [1, 0.97]]) } },
  { id: "bw-dramatic", cat: "Noir & blanc", name: "N&B dramatique", sub: "Ciels noirs, Ansel Adams", add: { contrast: 35, clarity: 30, texture: 15, highlights: -30, blacks: -20 }, set: { saturation: -100, vibrance: 0, shSat: 0, hiSat: 0, vignette: -30, hslL: hsl8({ 5: -60, 4: -40 }) } },
  { id: "bwsoft", cat: "Noir & blanc", name: "Sépia tirage ancien", sub: "Ton chaud", add: { contrast: 10 }, set: { saturation: -100, vibrance: 0, shHue: 30, shSat: 30, hiHue: 45, hiSat: 20, grain: 20, vignette: -25 } },
  { id: "selenium", cat: "Noir & blanc", name: "Virage sélénium", sub: "Ombres froides", add: { contrast: 18 }, set: { saturation: -100, vibrance: 0, shHue: 230, shSat: 22, hiHue: 45, hiSat: 6, balance: -20 } },
];

const RANGES = {
  boost: [0, 100], exposure: [-3, 3], contrast: [-100, 100], highlights: [-100, 100], shadows: [-100, 100], whites: [-100, 100], blacks: [-100, 100],
  temp: [-100, 100], tint: [-100, 100], texture: [-100, 100], clarity: [-100, 100], dehaze: [-100, 100],
  vibrance: [-100, 100], saturation: [-100, 100], shSat: [0, 100], hiSat: [0, 100], balance: [-100, 100],
  sharpen: [0, 150], denoise: [0, 100], vignette: [-100, 100], grain: [0, 100],
};

// Préréglage intégré (add/set appliqués à l'analyse auto) ou préréglage utilisateur (réglages complets).
function applyPreset(base, preset) {
  if (preset.params) return normalizeParams(preset.params);
  const P = normalizeParams(base);
  if (preset.add) for (const k in preset.add) P[k] = (P[k] || 0) + preset.add[k];
  if (preset.set) for (const k in preset.set) P[k] = clone(preset.set[k]);
  for (const k in RANGES) P[k] = Math.max(RANGES[k][0], Math.min(RANGES[k][1], P[k]));
  return P;
}

/* ---------- Géométrie : rotation, miroir, redressement, recadrage ---------- */
function geoFrame(sw, sh, geo) { return (geo.rot / 90) % 2 === 1 ? [sh, sw] : [sw, sh]; }
function coverScale(W, H, a) {
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  return Math.max((W * c + H * s) / W, (W * s + H * c) / H);
}
function renderGeometry(src, sw, sh, geo, scale, applyCrop) {
  const [FW, FH] = geoFrame(sw, sh, geo), W = FW * scale, H = FH * scale;
  const cr = applyCrop ? geo.crop : { x: 0, y: 0, w: 1, h: 1 };
  const ow = Math.max(1, Math.round(W * cr.w)), oh = Math.max(1, Math.round(H * cr.h));
  const c = new OffscreenCanvas(ow, oh), g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  const a = geo.angle * Math.PI / 180, k = coverScale(FW, FH, a);
  g.translate(-cr.x * W + W / 2, -cr.y * H + H / 2);
  g.rotate(a);
  g.scale(k * (geo.flipH ? -1 : 1), k * (geo.flipV ? -1 : 1));
  g.rotate(geo.rot * Math.PI / 180);
  g.drawImage(src, -sw * scale / 2, -sh * scale / 2, sw * scale, sh * scale);
  return c;
}

/* ---------- Filigrane ---------- */
function drawWatermark(g, W, H, wm) {
  const px = Math.max(10, Math.round(Math.max(W, H) * (wm.size || 3) / 100));
  const margin = px * 0.9, op = wm.opacity == null ? 0.6 : wm.opacity;
  g.save();
  g.font = `600 ${px}px "Segoe UI Variable Display", "Segoe UI", sans-serif`;
  g.fillStyle = `rgba(255,255,255,${op})`;
  g.shadowColor = `rgba(0,0,0,${op * 0.6})`; g.shadowBlur = px * 0.25;
  const pos = wm.position || "br";
  g.textBaseline = pos[0] === "t" ? "top" : pos === "c" ? "middle" : "bottom";
  g.textAlign = pos === "c" ? "center" : pos[1] === "l" ? "left" : "right";
  const x = pos === "c" ? W / 2 : pos[1] === "l" ? margin : W - margin;
  const y = pos === "c" ? H / 2 : pos[0] === "t" ? margin : H - margin;
  g.fillText(wm.text, x, y);
  g.restore();
}

/* ---------- Chaîne d'export complète (pleine résolution) ---------- */
function exportPipeline(bitmap, params, geo, opts) {
  const sw = bitmap.width, sh = bitmap.height;
  const [FW, FH] = geoFrame(sw, sh, geo), cr = geo.crop;
  const cropLong = Math.max(FW * cr.w, FH * cr.h);
  let scale = 1;
  if (opts.sizeMode === "long" && opts.longSide > 0) scale = opts.longSide / cropLong;
  else if (opts.sizeMode === "scale" && opts.scale > 0) scale = opts.scale;
  const maxPx = 100e6, px = FW * cr.w * FH * cr.h * scale * scale;
  if (px > maxPx) scale *= Math.sqrt(maxPx / px);
  const c = renderGeometry(bitmap, sw, sh, geo, scale, true);
  const g = c.getContext("2d", { willReadFrequently: true });
  const img = g.getImageData(0, 0, c.width, c.height);
  develop(img.data, c.width, c.height, normalizeParams(params), img);
  g.putImageData(img, 0, 0);
  if (opts.watermark && opts.watermark.enabled && opts.watermark.text) drawWatermark(g, c.width, c.height, opts.watermark);
  return c;
}

root.Engine = {
  HSL_COLORS, DEFAULTS, DEFAULT_GEO, PRESETS, RANGES,
  clone, clamp01, normalizeParams, normalizeGeo, isIdentity, curveLUT,
  develop, autoParams, applyPreset, geoFrame, renderGeometry, exportPipeline, drawWatermark,
};
})(typeof self !== "undefined" ? self : this);
