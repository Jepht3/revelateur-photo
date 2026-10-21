/* Worker de calcul : aperçu en direct et export pleine résolution, hors du fil de l'interface. */
importScripts("engine.js");
const E = self.Engine;

function autoFromBitmap(bmp) {
  const s = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const c = new OffscreenCanvas(w, h), g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high"; g.drawImage(bmp, 0, 0, w, h);
  return E.autoParams(g.getImageData(0, 0, w, h).data, w, h);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "preview") {
      const out = new ImageData(m.w, m.h);
      E.develop(new Uint8ClampedArray(m.buffer), m.w, m.h, m.params, out);
      self.postMessage({ id: m.id, ok: true, buffer: out.data.buffer, w: m.w, h: m.h }, [out.data.buffer]);
    } else if (m.type === "export") {
      const bmp = await createImageBitmap(new Blob([m.file]), { imageOrientation: "from-image" });
      let params = m.params;
      if (m.preset) params = E.applyPreset(autoFromBitmap(bmp), m.preset);
      const c = E.exportPipeline(bmp, params, E.normalizeGeo(m.geo), m.opts);
      bmp.close();
      const blob = await c.convertToBlob({ type: m.opts.format, quality: m.opts.quality });
      const buf = await blob.arrayBuffer();
      self.postMessage({ id: m.id, ok: true, buffer: buf, w: c.width, h: c.height }, [buf]);
    }
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
  }
};
