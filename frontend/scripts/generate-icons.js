// ============================================================
// FILE: scripts/generate-icons.js
// PURPOSE: One-time PWA icon generator (optional canvas path).
// Run: node scripts/generate-icons-pure.mjs  (no npm packages)
// Or:  npm install canvas && node scripts/generate-icons.js
// ============================================================

/*
  Run this script once to generate PWA icons:
  node scripts/generate-icons.js

  This creates simple gold circle icons for AscendAI.
  Replace with proper designed icons before launch.

  NOTE: Requires the optional `canvas` npm package.
  Prefer the zero-dependency script instead:
  node scripts/generate-icons-pure.mjs
*/

const fs = require("fs");
const path = require("path");

let createCanvas;
try {
  // Optional dependency — only used when canvas is installed locally
  ({ createCanvas } = require("canvas"));
} catch {
  console.error(
    "[generate-icons] canvas package not installed.\n" +
      "  Run: node scripts/generate-icons-pure.mjs\n" +
      "  Or:  npm install canvas && node scripts/generate-icons.js",
  );
  process.exit(1);
}

/** Draw one AscendAI icon PNG at the given pixel size. */
function generateIcon(size, filename) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // Navy background (matches manifest background_color)
  ctx.fillStyle = "#0A0F1E";
  ctx.fillRect(0, 0, size, size);

  // Gold circle (matches manifest theme_color)
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = "#D4AF37";
  ctx.fill();

  // "A" letter in navy on the gold circle
  ctx.fillStyle = "#0A0F1E";
  ctx.font = `bold ${size * 0.4}px serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("A", size / 2, size / 2);

  const buffer = canvas.toBuffer("image/png");
  fs.writeFileSync(path.join(__dirname, "../public", filename), buffer);
  console.log(`Generated ${filename}`);
}

generateIcon(192, "icon-192.png");
generateIcon(512, "icon-512.png");
