// ============================================================
// FILE: scripts/generate-icons-pure.mjs
// PURPOSE: Generate PWA PNG assets with Node stdlib only (no npm).
// Run: node scripts/generate-icons-pure.mjs
// ============================================================

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "../public");

// Brand colours — match manifest.json (PWA spec requires hex literals)
const NAVY = { r: 10, g: 15, b: 30 };
const GOLD = { r: 212, g: 175, b: 55 };

/** CRC32 table for PNG chunk checksums. */
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Compute CRC32 for a PNG chunk payload. */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Pack one PNG chunk (type + data + CRC). */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Encode RGBA pixels as a valid PNG file buffer. */
function encodePng(width, height, pixelAt) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = [0];
    for (let x = 0; x < width; x++) {
      const { r, g, b, a = 255 } = pixelAt(x, y);
      row.push(r, g, b, a);
    }
    rows.push(Buffer.from(row));
  }
  const raw = Buffer.concat(rows);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** AscendAI app icon — navy field, gold circle, navy "A". */
function iconPixelAt(size) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.4;
  return (x, y) => {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > radius) return NAVY;
    const inA =
      Math.abs(dx) < size * 0.08 &&
      dy > -size * 0.22 &&
      dy < size * 0.2 &&
      Math.abs(dx + dy * 0.35) < size * 0.06;
    if (inA) return NAVY;
    return GOLD;
  };
}

/** Simple dashboard screenshot placeholder — navy + gold bar. */
function screenshotPixelAt(width, height) {
  return (x, y) => {
    if (y < height * 0.12) return GOLD;
    if (y > height * 0.85 && x < width * 0.35) return GOLD;
    return NAVY;
  };
}

function writePng(filename, width, height, pixelAt) {
  const out = path.join(publicDir, filename);
  fs.writeFileSync(out, encodePng(width, height, pixelAt));
  console.log(`[generate-icons-pure] Wrote ${filename} (${width}x${height})`);
}

writePng("icon-192.png", 192, 192, iconPixelAt(192));
writePng("icon-512.png", 512, 512, iconPixelAt(512));
writePng(
  "screenshot-dashboard.png",
  1280,
  720,
  screenshotPixelAt(1280, 720),
);
