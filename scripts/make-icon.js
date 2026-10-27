// Gera build/icon.ico (PNG embutido em 16, 32, 48 e 256 px) sem dependências externas.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 32, 48, 256];

// cores RGBA
const BG = [17, 17, 17, 255]; // #111111
const PANEL = [255, 106, 0, 255]; // #FF6A00
const PANEL_DARK = [36, 36, 36, 255]; // #242424
const FOLDER = [245, 245, 245, 255]; // #F5F5F5

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// desenho em coordenadas 0..1: fundo arredondado, dois painéis e uma pasta amarela no painel esquerdo
function pixel(u, v) {
  if (!inRoundRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.2)) return [0, 0, 0, 0];
  if (inRoundRect(u, v, 0.14, 0.2, 0.46, 0.5, 0.03)) return FOLDER; // corpo da pasta
  if (inRoundRect(u, v, 0.14, 0.14, 0.28, 0.25, 0.03)) return FOLDER; // aba da pasta
  if (inRoundRect(u, v, 0.1, 0.1, 0.48, 0.9, 0.05)) return PANEL_DARK;
  if (inRoundRect(u, v, 0.52, 0.1, 0.9, 0.9, 0.05)) return PANEL;
  return BG;
}

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const SS = 4; // supersampling para suavizar as bordas
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const p = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          acc[0] += p[0] * p[3];
          acc[1] += p[1] * p[3];
          acc[2] += p[2] * p[3];
          acc[3] += p[3];
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const a = acc[3];
      raw[o] = a ? Math.round(acc[0] / a) : 0;
      raw[o + 1] = a ? Math.round(acc[1] / a) : 0;
      raw[o + 2] = a ? Math.round(acc[2] / a) : 0;
      raw[o + 3] = Math.round(a / (SS * SS));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // profundidade
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(sizes) {
  const images = sizes.map(png);
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2); // tipo: ícone
  head.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((s, i) => {
    const e = i * 16;
    dir[e] = s >= 256 ? 0 : s;
    dir[e + 1] = s >= 256 ? 0 : s;
    dir.writeUInt16LE(1, e + 4); // planos
    dir.writeUInt16LE(32, e + 6); // bits por pixel
    dir.writeUInt32LE(images[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, dir, ...images]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico(SIZES));
fs.writeFileSync(path.join(outDir, 'icon.png'), png(256));
// ícone exibido junto ao ponteiro ao arrastar arquivos para fora do aplicativo (vai dentro do pacote)
const assets = path.join(__dirname, '..', 'src', 'assets');
fs.mkdirSync(assets, { recursive: true });
fs.writeFileSync(path.join(assets, 'drag-icon.png'), png(48));
console.log('Ícone gerado em', outDir);
