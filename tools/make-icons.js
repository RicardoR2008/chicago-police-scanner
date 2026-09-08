// Generates PWA icons as real PNGs using only Node built-ins (zlib).
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ---------- minimal PNG encoder ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- artwork ---------- */
const NAVY_TOP = [17, 30, 54];
const NAVY_BOT = [8, 15, 30];
const BLUE = [65, 182, 230];   // Chicago flag light blue
const RED = [212, 39, 48];     // Chicago flag red

// Signed distance to a rounded square filling the S x S canvas (<=0 is inside).
function roundedSquareSD(x, y, S) {
  const r = S * 0.235;
  const qx = Math.abs(x - S / 2) - (S / 2 - r);
  const qy = Math.abs(y - S / 2) - (S / 2 - r);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - 0;
}

function bg(y, S) {
  const g = y / S;
  return [
    Math.round(NAVY_TOP[0] + (NAVY_BOT[0] - NAVY_TOP[0]) * g),
    Math.round(NAVY_TOP[1] + (NAVY_BOT[1] - NAVY_TOP[1]) * g),
    Math.round(NAVY_TOP[2] + (NAVY_BOT[2] - NAVY_TOP[2]) * g),
  ];
}

// Foreground motif evaluated in normalised content space (u, v in 0..1).
function motif(u, v) {
  const dx = u - 0.5;
  const dy = v - 0.44;              // antenna tip at (0.5, 0.44)
  const dist = Math.hypot(dx, dy);

  if (dist <= 0.048) return RED;    // transmitting dot

  if (dy <= 0) {                    // broadcast arcs, up and out from the tip
    const ang = Math.abs(Math.atan2(dx, -dy));
    if (ang > 0.44 && ang < 1.36) { // ~25deg .. ~78deg
      for (const r of [0.12, 0.20, 0.28]) {
        if (Math.abs(dist - r) <= 0.019) return BLUE;
      }
    }
  }

  if (v >= 0.44 && v <= 0.76) {     // tapering mast
    const t = (v - 0.44) / 0.32;
    if (Math.abs(dx) <= 0.020 + t * 0.020) return BLUE;
  }
  if (v >= 0.76 && v <= 0.81 && Math.abs(dx) <= 0.15) return BLUE;  // base bar

  return null;
}

// Returns the front-most layer colour at a sample point, or null (transparent).
function sample(x, y, S, opts) {
  const inside = opts.fullBleed || roundedSquareSD(x, y, S) <= 0;
  if (!inside) return null;         // clip everything to the card

  const k = opts.contentScale;
  const u = 0.5 + (x / S - 0.5) / k;
  const v = 0.5 + (y / S - 0.5) / k;
  if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
    const c = motif(u, v);
    if (c) return c;
  }
  return bg(y, S);
}

function render(S, opts) {
  const SS = 3; // 3x3 supersampling for antialiasing
  const buf = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0, hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, S, opts);
          if (c) { r += c[0]; g += c[1]; b += c[2]; hits++; }
        }
      }
      const total = SS * SS;
      const i = (y * S + x) * 4;
      if (hits === 0) { buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0; continue; }
      buf[i] = Math.round(r / hits);
      buf[i + 1] = Math.round(g / hits);
      buf[i + 2] = Math.round(b / hits);
      buf[i + 3] = Math.round((hits / total) * 255);
    }
  }
  return encodePNG(S, S, buf);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const jobs = [
  ['icon-192.png', 192, { contentScale: 0.86, fullBleed: false }],
  ['icon-512.png', 512, { contentScale: 0.86, fullBleed: false }],
  ['icon-maskable-512.png', 512, { contentScale: 0.60, fullBleed: true }],
  ['apple-touch-icon.png', 180, { contentScale: 0.82, fullBleed: true }],
  ['favicon-32.png', 32, { contentScale: 0.94, fullBleed: false }],
];

for (const [name, size, opts] of jobs) {
  const png = render(size, opts);
  fs.writeFileSync(path.join(outDir, name), png);
  console.log(`  ${name.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log('Icons written to icons/');
