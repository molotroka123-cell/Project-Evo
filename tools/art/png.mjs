// tools/art/png.mjs — минимальные чтение/запись PNG на встроенном zlib.
// Внешние пакеты не тянем: игра и конвейер должны собираться без сети.
import { inflateSync, deflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export const PNG = {
  // → { width, height, data: Buffer(RGBA) }
  decode(buf) {
    if (!buf.subarray(0, 8).equals(SIG)) throw new Error('не PNG');
    let pos = 8, width = 0, height = 0, depth = 8, colorType = 6, palette = null, trns = null;
    const idat = [];
    while (pos < buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString('ascii', pos + 4, pos + 8);
      const data = buf.subarray(pos + 8, pos + 8 + len);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0); height = data.readUInt32BE(4);
        depth = data[8]; colorType = data[9];
        if (data[12] !== 0) throw new Error('чересстрочный PNG не поддерживается');
        if (depth !== 8) throw new Error(`глубина ${depth} бит не поддерживается`);
      } else if (type === 'PLTE') palette = Buffer.from(data);
      else if (type === 'tRNS') trns = Buffer.from(data);
      else if (type === 'IDAT') idat.push(Buffer.from(data));
      else if (type === 'IEND') break;
      pos += 12 + len;
    }
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    if (!channels) throw new Error(`тип цвета ${colorType} не поддерживается`);
    const raw = inflateSync(Buffer.concat(idat));
    const bpp = channels;
    const stride = width * bpp;
    const lines = Buffer.alloc(height * stride);
    let rp = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[rp++];
      const cur = lines.subarray(y * stride, (y + 1) * stride);
      raw.copy(cur, 0, rp, rp + stride);
      rp += stride;
      const prev = y ? lines.subarray((y - 1) * stride, y * stride) : null;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= bpp ? prev[i - bpp] : 0;
        switch (filter) {
          case 1: cur[i] = (cur[i] + a) & 255; break;
          case 2: cur[i] = (cur[i] + b) & 255; break;
          case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 255; break;
          case 4: cur[i] = (cur[i] + paeth(a, b, c)) & 255; break;
        }
      }
    }
    const out = Buffer.alloc(width * height * 4);
    for (let i = 0, n = width * height; i < n; i++) {
      const s = i * bpp, d = i * 4;
      if (colorType === 6) { out[d] = lines[s]; out[d + 1] = lines[s + 1]; out[d + 2] = lines[s + 2]; out[d + 3] = lines[s + 3]; }
      else if (colorType === 2) { out[d] = lines[s]; out[d + 1] = lines[s + 1]; out[d + 2] = lines[s + 2]; out[d + 3] = 255; }
      else if (colorType === 0) { out[d] = out[d + 1] = out[d + 2] = lines[s]; out[d + 3] = 255; }
      else if (colorType === 4) { out[d] = out[d + 1] = out[d + 2] = lines[s]; out[d + 3] = lines[s + 1]; }
      else if (colorType === 3) {
        const idx = lines[s];
        out[d] = palette[idx * 3]; out[d + 1] = palette[idx * 3 + 1]; out[d + 2] = palette[idx * 3 + 2];
        out[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    return { width, height, data: out };
  },

  // RGBA Buffer → PNG Buffer
  encode(rgba, width, height) {
    const stride = width * 4;
    const raw = Buffer.alloc(height * (stride + 1));
    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = 0; // фильтр None: картинки мелкие, экономия не стоит сложности
      rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
      SIG,
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  },
};
