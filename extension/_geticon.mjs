// Throwaway generator for the extension icons, no image libs, pure Node.
// Draws Revyy's indigo rounded square with a white check, 4x-supersampled for
// clean edges, and writes icon16/48/128.png. Run: node extension/_geticon.mjs
import { deflateSync } from "zlib";
import { writeFileSync } from "fs";

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};
const png = (w, h, rgba) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
};
const distSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const render = (size) => {
  const SS = 4, S = size * SS, buf = Buffer.alloc(size * size * 4);
  const rad = S * 0.22, th = S * 0.085;
  const pts = [[0.26, 0.52], [0.43, 0.69], [0.74, 0.33]].map(([x, y]) => [x * S, y * S]);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let R = 0, G = 0, B = 0, A = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x * SS + sx + 0.5, py = y * SS + sy + 0.5;
      const cx = Math.min(Math.max(px, rad), S - rad), cy = Math.min(Math.max(py, rad), S - rad);
      if ((px < rad || px > S - rad) && (py < rad || py > S - rad) && Math.hypot(px - cx, py - cy) > rad) continue;
      const d = Math.min(distSeg(px, py, pts[0][0], pts[0][1], pts[1][0], pts[1][1]), distSeg(px, py, pts[1][0], pts[1][1], pts[2][0], pts[2][1]));
      if (d <= th) { R += 255; G += 255; B += 255; A += 255; } else { R += 0x4f; G += 0x46; B += 0xe5; A += 255; }
    }
    const n = SS * SS, i = (y * size + x) * 4;
    buf[i] = Math.round(R / n); buf[i + 1] = Math.round(G / n); buf[i + 2] = Math.round(B / n); buf[i + 3] = Math.round(A / n);
  }
  return buf;
};
for (const size of [16, 48, 128]) {
  writeFileSync(new URL(`./icon${size}.png`, import.meta.url), png(size, size, render(size)));
  console.log("wrote icon" + size + ".png");
}
