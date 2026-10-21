/* Génère l'icône de l'application (PNG 512 px) sans dépendance : un objectif ambre sur fond sombre. */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const S = 512, SS = 4; // suréchantillonnage pour l'anticrénelage
const px = new Uint8Array(S * S * 4);

function sample(x, y) {
  const c = S / 2, dx = x - c, dy = y - c, r = Math.hypot(dx, dy);
  // carré arrondi
  const m = 20, rad = 110, ax = Math.max(Math.abs(dx) - (c - m - rad), 0), ay = Math.max(Math.abs(dy) - (c - m - rad), 0);
  if (Math.hypot(ax, ay) > rad) return [0, 0, 0, 0];
  let col = [27, 24, 22];
  if (r < 190) { // bague extérieure
    const t = r / 190;
    col = [Math.round(233 - 50 * t), Math.round(160 - 55 * t), Math.round(75 - 35 * t)];
  }
  if (r < 150) col = [30, 26, 23];
  if (r < 132) { // diaphragme : 6 lames
    const a = Math.atan2(dy, dx), blade = Math.cos(3 * (a + 0.3)) * 0.5 + 0.5;
    const edge = 70 + 14 * blade;
    col = r < edge ? [20, 17, 15] : [Math.round(200 - r * 0.6), Math.round(128 - r * 0.4), Math.round(58 - r * 0.2)];
  }
  if (Math.hypot(dx + 26, dy + 30) < 18) col = [255, 236, 200]; // reflet
  return [col[0], col[1], col[2], 255];
}

for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const acc = [0, 0, 0, 0];
  for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
    const s = sample(x + (i + 0.5) / SS, y + (j + 0.5) / SS);
    acc[0] += s[0] * s[3]; acc[1] += s[1] * s[3]; acc[2] += s[2] * s[3]; acc[3] += s[3];
  }
  const k = (y * S + x) * 4, a = acc[3] / (SS * SS);
  px[k] = acc[3] ? acc[0] / acc[3] : 0; px[k + 1] = acc[3] ? acc[1] / acc[3] : 0; px[k + 2] = acc[3] ? acc[2] / acc[3] : 0; px[k + 3] = a;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1); }
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);

const root = path.join(__dirname, "..");
for (const out of [path.join(root, "build", "icon.png"), path.join(root, "src", "assets", "icon.png")]) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, png);
}
console.log("Icône générée (" + png.length + " octets)");
