// render/terrain.js — местность: рельефное освещение, мягкие переходы биомов,
// проработанные детали (деревья, скалы, трава, рябь, прибой) и обрывы.
//
// Приём, который даёт «нарисованную» картинку дёшево:
//   1) вся карта рисуется в мини-канвас 2×2 пикселя на тайл с уже посчитанным
//      рельефным светом, затем растягивается со сглаживанием — получаются
//      мягкие природные переходы между биомами вместо лесенки из квадратов;
//   2) поверх крупно и чётко рисуются детали и береговая линия.
// Карта режется на чанки 16×16 тайлов и печётся лениво — старт быстрый,
// память не расходуется на невидимые куски.
import { TILE } from '../core/data.js';
import { TERRAIN, TILE_HEIGHT, hash2, hex2rgb } from './palette.js';

export const CHUNK = 16;

export class Terrain {
  constructor(quality) {
    this.q = quality;
    this.chunks = new Map();   // "cx,cy" → canvas
    this.season = -1;
    this.worldSeed = null;
    this.height = null;        // Float32Array сглаженных высот
    this.shade = null;         // Float32Array множителей света 0.6…1.4
    this.low = null;           // мини-канвас всей карты
    this.w = 0; this.h = 0;
  }

  setQuality(q) { this.q = q; this.invalidate(); }

  invalidate() { this.chunks.clear(); this.low = null; this.season = -1; }

  // --- поле высот и рельефное освещение (не зависит от сезона) ---
  buildHeight(world) {
    const W = world.w, H = world.h;
    this.w = W; this.h = H;
    const raw = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) raw[i] = TILE_HEIGHT[world.tiles[i]] ?? 0;
    // сглаживание 3×3 — иначе рельеф получается ступенчатым
    const hgt = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const w = (dx === 0 && dy === 0) ? 3 : 1;
          s += raw[yy * W + xx] * w; n += w;
        }
        hgt[y * W + x] = s / n;
      }
    }
    // ламбертово освещение от источника сверху-слева под 45° (канон ТЗ)
    const sh = new Float32Array(W * H);
    const LX = -0.7071, LY = -0.7071;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const l = hgt[y * W + Math.max(0, x - 1)], r = hgt[y * W + Math.min(W - 1, x + 1)];
        const u = hgt[Math.max(0, y - 1) * W + x], d = hgt[Math.min(H - 1, y + 1) * W + x];
        const gx = (r - l) * 0.5, gy = (d - u) * 0.5;
        // нормаль (-gx,-gy,1/k) → скалярное произведение со светом
        const k = 1.15;
        const nz = 1 / k;
        const len = Math.hypot(gx, gy, nz) || 1;
        const lam = (-gx * LX - gy * LY + nz * 0.9) / len;
        sh[y * W + x] = Math.max(0.58, Math.min(1.42, 0.62 + lam * 0.78));
      }
    }
    this.height = hgt; this.shade = sh; this.worldSeed = world.seed;
  }

  hAt(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -0.6;
    return this.height[y * this.w + x];
  }

  // --- мини-карта всей местности: 2 пикселя на тайл, уже со светом ---
  buildLow(sim) {
    const W = sim.world.w, H = sim.world.h;
    const S = 2;
    const cv = document.createElement('canvas');
    cv.width = W * S; cv.height = H * S;
    const c = cv.getContext('2d');
    const pal = TERRAIN[sim.seasonIdx];
    const img = c.createImageData(W * S, H * S);
    const px = img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = sim.world.tiles[y * W + x];
        const p = pal[t];
        const rgb = hex2rgb(p.base);
        let m = this.q.relief ? this.shade[y * W + x] : 1;
        // лёгкая природная пестрота, чтобы заливка не была «пластиковой»
        m *= 0.97 + hash2(x, y) * 0.06;
        const r = Math.min(255, rgb[0] * m) | 0, g = Math.min(255, rgb[1] * m) | 0, b = Math.min(255, rgb[2] * m) | 0;
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            const o = ((y * S + sy) * W * S + (x * S + sx)) * 4;
            px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
          }
        }
      }
    }
    c.putImageData(img, 0, 0);
    this.low = cv;
  }

  ensure(sim) {
    if (this.worldSeed !== sim.world.seed || !this.height) this.buildHeight(sim.world);
    if (this.season !== sim.seasonIdx) { this.chunks.clear(); this.low = null; this.season = sim.seasonIdx; }
    if (!this.low) this.buildLow(sim);
  }

  chunk(sim, cx, cy) {
    const key = cx + ',' + cy;
    let cv = this.chunks.get(key);
    if (cv) return cv;
    cv = this.bake(sim, cx, cy);
    this.chunks.set(key, cv);
    return cv;
  }

  // --- выпечка одного чанка ---
  bake(sim, cx, cy) {
    const TP = this.q.tilePx;
    const cv = document.createElement('canvas');
    cv.width = CHUNK * TP; cv.height = CHUNK * TP;
    const c = cv.getContext('2d');
    const world = sim.world, W = world.w, H = world.h;
    const pal = TERRAIN[sim.seasonIdx];
    const x0 = cx * CHUNK, y0 = cy * CHUNK;

    // 1) мягкая база: растягиваем кусок мини-карты со сглаживанием
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    const S = 2, PAD = 2;
    c.drawImage(
      this.low,
      Math.max(0, x0 - PAD) * S, Math.max(0, y0 - PAD) * S,
      (CHUNK + PAD * 2) * S, (CHUNK + PAD * 2) * S,
      (Math.max(0, x0 - PAD) - x0) * TP, (Math.max(0, y0 - PAD) - y0) * TP,
      (CHUNK + PAD * 2) * TP, (CHUNK + PAD * 2) * TP,
    );

    // 2) чёткая подложка для «внутренних» тайлов, чтобы биом читался
    for (let y = y0; y < y0 + CHUNK; y++) {
      for (let x = x0; x < x0 + CHUNK; x++) {
        if (x >= W || y >= H) continue;
        const t = world.tiles[y * W + x];
        // Вода должна оставаться гладкой: чёткая поквадратная подложка превращает
        // её в шахматку из 32-пиксельных плиток. Объём ей дают блики в кадре.
        if (t === TILE.WATER || t === TILE.DEEP) continue;
        let same = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) { same++; continue; }
          if (world.tiles[yy * W + xx] === t) same++;
        }
        const interior = Math.max(0, (same - 5) / 4); // 0 на границе, 1 внутри
        if (interior <= 0.02) continue;
        const p = pal[t];
        const m = this.q.relief ? this.shade[y * W + x] : 1;
        // Пестрота должна совпадать с той, что уже заложена в мини-карту, иначе
        // два разных шума складываются и дают шахматку из светлых/тёмных клеток.
        c.globalAlpha = 0.22 * interior;
        c.fillStyle = shadeHex(p.base, m * (0.97 + hash2(x, y) * 0.06));
        c.fillRect((x - x0) * TP, (y - y0) * TP, TP, TP);
      }
    }
    c.globalAlpha = 1;

    // 3) детали по тайлам
    for (let y = y0; y < y0 + CHUNK; y++) {
      for (let x = x0; x < x0 + CHUNK; x++) {
        if (x >= W || y >= H) continue;
        this.detail(c, world, pal, x, y, (x - x0) * TP, (y - y0) * TP, TP, sim.seasonIdx);
      }
    }

    // 4) береговая линия и обрывы — поверх всего, чётко
    for (let y = y0; y < y0 + CHUNK; y++) {
      for (let x = x0; x < x0 + CHUNK; x++) {
        if (x >= W || y >= H) continue;
        this.edges(c, world, pal, x, y, (x - x0) * TP, (y - y0) * TP, TP);
      }
    }
    return cv;
  }

  // ---- детали одного тайла ----
  detail(c, world, pal, x, y, px, py, TP, season) {
    const t = world.tiles[y * world.w + x];
    const p = pal[t];
    const D = this.q.detail;
    if (D < 0) return;
    const r1 = hash2(x, y), r2 = hash2(x + 991, y + 77), r3 = hash2(x * 3 + 7, y * 5 + 13);

    if (t === TILE.GRASS) {
      if (D === 0) return;
      const n = D >= 2 ? 4 : 2;
      c.strokeStyle = p.det2; c.lineWidth = Math.max(1, TP * 0.045); c.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const hx = hash2(x * 13 + i, y * 7 + i * 3), hy = hash2(x * 5 + i * 11, y * 17 + i);
        const gx = px + hx * TP, gy = py + hy * TP;
        c.beginPath();
        c.moveTo(gx, gy + TP * 0.08);
        c.quadraticCurveTo(gx + TP * 0.03, gy, gx + (hx > 0.5 ? TP * 0.05 : -TP * 0.05), gy - TP * 0.08);
        c.stroke();
      }
      // редкие цветы весной и летом
      if (D >= 2 && season < 2 && r3 > 0.86) {
        c.fillStyle = ['#f0e28a', '#f2f2f2', '#e8a0c0'][(r1 * 3) | 0];
        c.beginPath(); c.arc(px + r1 * TP, py + r2 * TP, TP * 0.045, 0, 7); c.fill();
      }
      return;
    }

    if (t === TILE.FOREST) {
      const n = D >= 2 ? 3 : D === 1 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const hx = hash2(x * 31 + i * 5, y * 13 + i), hy = hash2(x * 7 + i, y * 23 + i * 3);
        const tx = px + TP * (0.22 + hx * 0.56), ty = py + TP * (0.28 + hy * 0.48);
        const rad = TP * (0.16 + hash2(x + i, y + i) * 0.09);
        this.tree(c, tx, ty, rad, p, season, hash2(x * 3 + i, y * 3 + i));
      }
      return;
    }

    if (t === TILE.HILL) {
      // Объём холмам даёт рельефное освещение всей карты. Одинаковый блик на
      // КАЖДОМ тайле складывался в механическую сетку — поэтому детали редкие
      // и разнесены по позиции, а не по фиксированной схеме.
      if (D < 1) return;
      if (r2 > 0.62) {
        c.fillStyle = p.det; c.globalAlpha = 0.55;
        c.beginPath();
        c.ellipse(px + TP * (0.2 + r1 * 0.55), py + TP * (0.25 + r3 * 0.45), TP * (0.05 + r1 * 0.04), TP * (0.04 + r3 * 0.03), r1 * 3, 0, 7);
        c.fill();
        c.globalAlpha = 1;
      }
      if (D >= 2 && r1 > 0.78) {
        c.strokeStyle = p.det2; c.globalAlpha = 0.45; c.lineWidth = Math.max(1, TP * 0.04);
        const gx = px + r3 * TP * 0.7 + TP * 0.15, gy = py + r2 * TP * 0.6 + TP * 0.2;
        c.beginPath(); c.moveTo(gx, gy + TP * 0.06); c.lineTo(gx + TP * 0.02, gy - TP * 0.06); c.stroke();
        c.globalAlpha = 1;
      }
      return;
    }

    if (t === TILE.MOUNTAIN) {
      const cxp = px + TP * (0.42 + r1 * 0.16), base = py + TP * 0.92;
      const peak = py + TP * (0.06 + r2 * 0.14);
      const wdt = TP * (0.42 + r3 * 0.12);
      // тень скалы вправо-вниз
      c.fillStyle = 'rgba(0,0,0,0.28)';
      c.beginPath(); c.moveTo(cxp, peak); c.lineTo(cxp + wdt * 1.5, base); c.lineTo(cxp - wdt * 0.1, base); c.closePath(); c.fill();
      // тёмная (правая) грань
      c.fillStyle = p.lo;
      c.beginPath(); c.moveTo(cxp, peak); c.lineTo(cxp + wdt, base); c.lineTo(cxp - wdt * 0.15, base); c.closePath(); c.fill();
      // светлая (левая) грань
      c.fillStyle = p.hi;
      c.beginPath(); c.moveTo(cxp, peak); c.lineTo(cxp - wdt * 0.15, base); c.lineTo(cxp - wdt, base); c.closePath(); c.fill();
      // снежная шапка
      if (D >= 1) {
        c.fillStyle = p.det2;
        const sy2 = peak + TP * 0.2;
        c.beginPath(); c.moveTo(cxp, peak);
        c.lineTo(cxp + wdt * 0.34, sy2); c.lineTo(cxp + wdt * 0.16, sy2 - TP * 0.04);
        c.lineTo(cxp - wdt * 0.08, sy2 + TP * 0.03); c.lineTo(cxp - wdt * 0.32, sy2);
        c.closePath(); c.fill();
      }
      return;
    }

    if (t === TILE.SAND) {
      if (D < 1) return;
      c.strokeStyle = p.det; c.globalAlpha = 0.5; c.lineWidth = Math.max(1, TP * 0.035);
      for (let i = 0; i < 2; i++) {
        const hy = hash2(x * 19 + i * 7, y * 11 + i);
        c.beginPath();
        c.moveTo(px + TP * 0.12, py + TP * (0.25 + hy * 0.5));
        c.quadraticCurveTo(px + TP * 0.5, py + TP * (0.18 + hy * 0.5), px + TP * 0.88, py + TP * (0.28 + hy * 0.5));
        c.stroke();
      }
      c.globalAlpha = 1;
      return;
    }

    if (t === TILE.WATER || t === TILE.DEEP) {
      if (D < 1) return;
      // статичные гребни волн; блики поверх добавляются анимацией в кадре
      c.strokeStyle = p.det2; c.globalAlpha = t === TILE.DEEP ? 0.10 : 0.18;
      c.lineWidth = Math.max(1, TP * 0.05); c.lineCap = 'round';
      const hy = hash2(x * 3, y * 7);
      c.beginPath();
      c.moveTo(px + TP * 0.2, py + TP * (0.3 + hy * 0.4));
      c.quadraticCurveTo(px + TP * 0.5, py + TP * (0.2 + hy * 0.4), px + TP * 0.8, py + TP * (0.32 + hy * 0.4));
      c.stroke();
      c.globalAlpha = 1;
    }
  }

  tree(c, x, y, r, p, season, rnd) {
    // тень под кроной (свет сверху-слева → тень вправо-вниз)
    c.fillStyle = 'rgba(0,0,0,0.26)';
    c.beginPath(); c.ellipse(x + r * 0.45, y + r * 0.8, r * 0.85, r * 0.34, 0, 0, 7); c.fill();
    // ствол
    c.fillStyle = season === 3 ? '#4a3d33' : '#5a4433';
    c.fillRect(x - r * 0.12, y + r * 0.1, r * 0.24, r * 0.72);
    // крона: три перекрывающихся круга, светлее сверху-слева
    const lo = p.det, hi = p.det2;
    c.fillStyle = lo;
    c.beginPath(); c.arc(x + r * 0.28, y + r * 0.12, r * 0.72, 0, 7); c.fill();
    c.beginPath(); c.arc(x - r * 0.3, y + r * 0.2, r * 0.62, 0, 7); c.fill();
    c.fillStyle = hi;
    c.beginPath(); c.arc(x - r * 0.16, y - r * 0.28, r * 0.66, 0, 7); c.fill();
    // блик
    c.fillStyle = 'rgba(255,255,255,0.16)';
    c.beginPath(); c.arc(x - r * 0.34, y - r * 0.42, r * 0.26, 0, 7); c.fill();
    // зимняя шапка снега
    if (season === 3) {
      c.fillStyle = 'rgba(240,246,252,0.85)';
      c.beginPath(); c.arc(x - r * 0.2, y - r * 0.44, r * 0.42, Math.PI * 1.05, Math.PI * 2.05); c.fill();
    }
    // осенняя подсветка листвы
    if (season === 2 && rnd > 0.5) {
      c.fillStyle = 'rgba(226,140,52,0.35)';
      c.beginPath(); c.arc(x + r * 0.2, y - r * 0.05, r * 0.5, 0, 7); c.fill();
    }
  }

  // ---- берег и обрывы ----
  edges(c, world, pal, x, y, px, py, TP) {
    const W = world.w, H = world.h;
    const t = world.tiles[y * W + x];
    const isWater = t === TILE.WATER || t === TILE.DEEP;
    const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= W || yy >= H) ? TILE.DEEP : world.tiles[yy * W + xx];

    // прибой: светлая кромка на воде вдоль суши
    if (isWater && this.q.shoreFoam) {
      const sides = [[0, -1, 0, 0, 1, 0], [0, 1, 0, 1, 1, 1], [-1, 0, 0, 0, 0, 1], [1, 0, 1, 0, 1, 1]];
      for (const [dx, dy, ax, ay, bx, by] of sides) {
        const n = at(x + dx, y + dy);
        if (n === TILE.WATER || n === TILE.DEEP) continue;
        c.strokeStyle = 'rgba(226,242,255,0.30)';
        c.lineWidth = Math.max(1, TP * 0.06);
        c.beginPath();
        c.moveTo(px + ax * TP, py + ay * TP);
        c.lineTo(px + bx * TP, py + by * TP);
        c.stroke();
        c.strokeStyle = 'rgba(226,242,255,0.10)';
        c.lineWidth = Math.max(2, TP * 0.16);
        c.stroke();
      }
      return;
    }

    // обрыв: если сосед снизу заметно ниже — тёмная грань «скалы»
    if (!this.q.relief) return;
    const hHere = this.hAt(x, y);
    const hDown = this.hAt(x, y + 1);
    if (hHere - hDown > 0.3) {
      const g = c.createLinearGradient(0, py + TP * 0.72, 0, py + TP);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${Math.min(0.42, (hHere - hDown) * 0.34)})`);
      c.fillStyle = g;
      c.fillRect(px, py + TP * 0.72, TP, TP * 0.28);
    }
    const hRight = this.hAt(x + 1, y);
    if (hHere - hRight > 0.3) {
      const g = c.createLinearGradient(px + TP * 0.74, 0, px + TP, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${Math.min(0.3, (hHere - hRight) * 0.26)})`);
      c.fillStyle = g;
      c.fillRect(px + TP * 0.74, py, TP * 0.26, TP);
    }
    // светлая кромка на подъёме слева-сверху
    const hUp = this.hAt(x, y - 1);
    if (hHere - hUp > 0.3) {
      c.fillStyle = `rgba(255,250,230,${Math.min(0.22, (hHere - hUp) * 0.2)})`;
      c.fillRect(px, py, TP, TP * 0.14);
    }
  }

  // ---- отрисовка видимых чанков ----
  draw(ctx, sim, ox, oy, z, cw, ch) {
    this.ensure(sim);
    const TP = this.q.tilePx;
    const scale = z / TP;                       // экранных пикселей на пиксель чанка
    const chunkScreen = CHUNK * TP * scale;
    const cxMin = Math.max(0, Math.floor((-ox) / (CHUNK * z)));
    const cxMax = Math.min(Math.ceil(sim.world.w / CHUNK) - 1, Math.floor((cw - ox) / (CHUNK * z)));
    const cyMin = Math.max(0, Math.floor((-oy) / (CHUNK * z)));
    const cyMax = Math.min(Math.ceil(sim.world.h / CHUNK) - 1, Math.floor((ch - oy) / (CHUNK * z)));
    ctx.imageSmoothingEnabled = scale < 1.35;
    for (let cy = cyMin; cy <= cyMax; cy++) {
      for (let cx = cxMin; cx <= cxMax; cx++) {
        const cv = this.chunk(sim, cx, cy);
        // +1 пиксель перекрытия убирает волосяные щели между чанками при дробном зуме
        ctx.drawImage(cv, ox + cx * CHUNK * z, oy + cy * CHUNK * z, chunkScreen + 1, chunkScreen + 1);
      }
    }
  }

  // ---- анимация воды: блики и рябь только по видимым водным тайлам ----
  drawWater(ctx, sim, ox, oy, z, cw, ch, time) {
    if (!this.q.water) return;
    const world = sim.world, W = world.w;
    const x0 = Math.max(0, Math.floor((-ox) / z)), x1 = Math.min(W - 1, Math.ceil((cw - ox) / z));
    const y0 = Math.max(0, Math.floor((-oy) / z)), y1 = Math.min(world.h - 1, Math.ceil((ch - oy) / z));
    if (x1 < x0 || y1 < y0) return;
    // при сильном отдалении блики сливаются в шум — не рисуем
    if (z < 12) return;
    // Блик — заранее отрисованный спрайт. Раньше здесь был ctx.ellipse на каждый
    // видимый водный тайл (до тысячи заливок в кадре) — это стоило десятков мс.
    if (!this._glint) {
      const S = 64;
      const cv = document.createElement('canvas');
      cv.width = S; cv.height = S / 2;
      const c = cv.getContext('2d');
      const g = c.createRadialGradient(S / 2, S / 4, 0, S / 2, S / 4, S / 2);
      g.addColorStop(0, 'rgba(190,230,255,1)');
      g.addColorStop(1, 'rgba(190,230,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, S, S / 2);
      this._glint = cv;
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const step = z < 20 ? 2 : 1;
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0; x <= x1; x += step) {
        const t = world.tiles[y * W + x];
        if (t !== TILE.WATER && t !== TILE.DEEP) continue;
        const ph = hash2(x, y) * 6.28;
        const a = (0.5 + 0.5 * Math.sin(time * 1.6 + ph + x * 0.4 + y * 0.25));
        const alpha = (t === TILE.DEEP ? 0.05 : 0.11) * a;
        if (alpha < 0.02) continue;
        ctx.globalAlpha = alpha;
        const sx = ox + x * z, sy = oy + y * z + z * (0.36 + 0.12 * Math.sin(time + ph));
        ctx.drawImage(this._glint, sx + z * 0.14, sy - z * 0.13, z * 0.72, z * 0.26);
      }
    }
    ctx.restore();
  }
}

// Умножение hex-цвета на коэффициент яркости.
function shadeHex(hex, m) {
  const c = hex2rgb(hex);
  return `rgb(${Math.min(255, c[0] * m) | 0},${Math.min(255, c[1] * m) | 0},${Math.min(255, c[2] * m) | 0})`;
}
