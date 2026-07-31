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
import { TERRAIN, TILE_HEIGHT, hash2, fbm2, hex2rgb } from './palette.js';

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

    // 2) чёткая подложка для «внутренних» тайлов, чтобы биом читался.
    // Заливка идёт мягким пятном, а не квадратом: раньше на стыках биомов был
    // виден растр из 32-пиксельных плиток — «шахматка».
    for (let y = y0; y < y0 + CHUNK; y++) {
      for (let x = x0; x < x0 + CHUNK; x++) {
        if (x >= W || y >= H) continue;
        const t = world.tiles[y * W + x];
        // Вода должна оставаться гладкой. Объём ей дают блики в кадре.
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
        c.globalAlpha = 0.26 * interior;
        c.fillStyle = shadeHex(p.base, m * (0.97 + hash2(x, y) * 0.06));
        const px = (x - x0) * TP, py = (y - y0) * TP;
        c.beginPath();
        c.ellipse(px + TP / 2, py + TP / 2, TP * 0.78, TP * 0.78, 0, 0, 7);
        c.fill();
      }
    }
    c.globalAlpha = 1;

    // 2.5) размытие границы биомов: вдоль стыка сеем кляксы соседнего цвета.
    // Без этого граница леса и травы — идеально ровная линия по клеткам.
    this.blend(c, world, pal, x0, y0, TP);

    // 2.6) крупные природные пятна поверх заливки — выгоревшая трава,
    // проплешины, разнотон породы. Именно они убирают ощущение пластика.
    this.mottle(c, world, pal, x0, y0, TP);

    // 3) детали по тайлам. Идём с запасом в одну клетку вокруг чанка: крона
    // дерева с соседней клетки должна заходить в этот чанк, иначе на границах
    // чанков видны обрубленные деревья.
    for (let y = y0 - 1; y <= y0 + CHUNK; y++) {
      for (let x = x0 - 1; x <= x0 + CHUNK; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
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

  // ---- размывание границ биомов ----
  // На каждой клетке смотрим четырёх соседей: если сосед другого типа, сеем
  // вдоль этого ребра несколько мягких клякс его цветом. Стык перестаёт быть
  // прямой линией и читается как естественный переход.
  blend(c, world, pal, x0, y0, TP) {
    if (this.q.detail < 1) return;
    const W = world.w, H = world.h;
    const SIDES = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    for (let y = y0 - 1; y <= y0 + CHUNK; y++) {
      for (let x = x0 - 1; x <= x0 + CHUNK; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const t = world.tiles[y * W + x];
        const wet = t === TILE.DEEP || t === TILE.WATER;
        const px = (x - x0) * TP, py = (y - y0) * TP;
        for (let s = 0; s < 4; s++) {
          const [dx, dy] = SIDES[s];
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const n = world.tiles[yy * W + xx];
          if (n === t) continue;
          const nWet = n === TILE.DEEP || n === TILE.WATER;
          // На суше синеву не разводим — берег красит только сушу в воду:
          // ровный прямоугольник озера так превращается в отмель с бухтами.
          if (!wet && nWet) continue;
          const np = pal[n];
          c.fillStyle = np.base;
          for (let i = 0; i < 3; i++) {
            const r1 = hash2(x * 71 + s * 13 + i, y * 37 + i * 7);
            const r2 = hash2(x * 17 + i, y * 91 + s * 5 + i);
            const along = 0.12 + r1 * 0.76;
            const depth = 0.06 + r2 * 0.30;
            const bx = px + TP * (dx === 0 ? along : (dx > 0 ? 1 - depth : depth));
            const by = py + TP * (dy === 0 ? along : (dy > 0 ? 1 - depth : depth));
            // В воде отмель мягче: дно должно просвечивать, а не лежать пятном.
            c.globalAlpha = (wet ? 0.30 : 0.42) * (1 - depth * 1.9);
            if (c.globalAlpha <= 0.02) continue;
            c.beginPath();
            c.ellipse(bx, by, TP * (0.14 + r1 * 0.16), TP * (0.12 + r2 * 0.14), r1 * 3, 0, 7);
            c.fill();
          }
        }
      }
    }
    c.globalAlpha = 1;
  }

  // ---- крупные природные пятна ----
  // Кандидаты сидят на решётке 3×3 клетки в МИРОВЫХ координатах, поэтому
  // пятна одинаково ложатся по обе стороны границы чанков — швов нет.
  mottle(c, world, pal, x0, y0, TP) {
    if (this.q.detail < 1) return;
    const W = world.w, H = world.h;
    const g0x = Math.floor((x0 - 3) / 3), g1x = Math.ceil((x0 + CHUNK + 3) / 3);
    const g0y = Math.floor((y0 - 3) / 3), g1y = Math.ceil((y0 + CHUNK + 3) / 3);
    for (let gy = g0y; gy <= g1y; gy++) {
      for (let gx = g0x; gx <= g1x; gx++) {
        const r1 = hash2(gx * 131 + 7, gy * 57 + 3);
        if (r1 < 0.45) continue;
        const r2 = hash2(gx * 29, gy * 191 + 11), r3 = hash2(gx * 83 + 5, gy * 13);
        const wx = gx * 3 + r2 * 3, wy = gy * 3 + r3 * 3;
        const tx = Math.floor(wx), ty = Math.floor(wy);
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        const t = world.tiles[ty * W + tx];
        if (t === TILE.DEEP || t === TILE.WATER || t === TILE.SAND) continue;
        const p = pal[t];
        const rad = TP * (0.9 + r1 * 1.7);
        const cx = (wx - x0) * TP, cy = (wy - y0) * TP;
        if (cx < -rad || cy < -rad || cx > CHUNK * TP + rad || cy > CHUNK * TP + rad) continue;
        const light = fbm2(wx, wy) > 0.5;
        const col = hex2rgb(light ? p.hi : p.lo);
        const grad = c.createRadialGradient(cx, cy, 0, cx, cy, rad);
        const a = 0.075 + r2 * 0.10;
        grad.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${a})`);
        grad.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
        c.fillStyle = grad;
        c.beginPath(); c.ellipse(cx, cy, rad, rad * (0.62 + r3 * 0.4), r1 * 3, 0, 7); c.fill();
      }
    }
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
      // Кустики травы: пучок из трёх разных по длине былинок, двумя тонами.
      // Одна былинка на клетку читалась как редкая щетина, а не как трава.
      const n = D >= 2 ? 3 : 2;
      c.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const hx = hash2(x * 13 + i, y * 7 + i * 3), hy = hash2(x * 5 + i * 11, y * 17 + i);
        const gx = px + TP * (0.1 + hx * 0.8), gy = py + TP * (0.15 + hy * 0.75);
        const sc = 0.7 + hash2(x * 3 + i, y * 11 + i) * 0.7;
        c.strokeStyle = i === 0 ? p.det2 : p.det;
        c.lineWidth = Math.max(1, TP * 0.04);
        for (const k of [-1, 0, 1]) {
          c.beginPath();
          c.moveTo(gx + k * TP * 0.035, gy);
          c.quadraticCurveTo(
            gx + k * TP * 0.06, gy - TP * 0.06 * sc,
            gx + k * TP * 0.11 + (hx > 0.5 ? TP * 0.02 : -TP * 0.02), gy - TP * 0.13 * sc,
          );
          c.stroke();
        }
      }
      // проплешины утоптанной земли — трава перестаёт быть однородным ковром
      if (D >= 1 && r2 > 0.90) {
        c.fillStyle = 'rgba(122,98,62,0.22)';
        c.beginPath();
        c.ellipse(px + TP * (0.2 + r1 * 0.6), py + TP * (0.2 + r3 * 0.6), TP * (0.12 + r1 * 0.16), TP * (0.09 + r3 * 0.1), r1 * 3, 0, 7);
        c.fill();
      }
      // редкие цветы весной и летом
      if (D >= 2 && season < 2 && r3 > 0.84) {
        const fc = ['#f0e28a', '#f6f6f2', '#e8a0c0'][(r1 * 3) | 0];
        for (let i = 0; i < 3; i++) {
          c.fillStyle = fc;
          c.beginPath();
          c.arc(px + TP * (0.2 + r1 * 0.6) + (i - 1) * TP * 0.09, py + TP * (0.2 + r2 * 0.6) + (i % 2) * TP * 0.07, TP * 0.035, 0, 7);
          c.fill();
        }
      }
      return;
    }

    if (t === TILE.FOREST) {
      // Подстилка: под кронами земля темнее и с опадом, иначе лес выглядит
      // как трава, на которую сверху накидали кружочков. Пятном, а не
      // квадратом: заливка по клетке рисовала лесу ровную прямоугольную кайму.
      c.fillStyle = 'rgba(38,48,28,0.32)';
      c.beginPath();
      c.ellipse(px + TP * (0.4 + r1 * 0.2), py + TP * (0.4 + r2 * 0.2), TP * (0.62 + r3 * 0.14), TP * (0.6 + r1 * 0.14), 0, 0, 7);
      c.fill();
      if (D >= 1) {
        c.fillStyle = season === 2 ? 'rgba(150,96,40,0.35)' : 'rgba(60,80,44,0.4)';
        for (let i = 0; i < 3; i++) {
          const lx = hash2(x * 41 + i * 3, y * 67 + i), ly = hash2(x * 23 + i, y * 53 + i * 5);
          c.fillRect(px + lx * TP, py + ly * TP, TP * 0.06, TP * 0.04);
        }
      }
      // Число деревьев гуляет по клеткам: одинаковая плотность на массиве в
      // сотни клеток читается как сетка, а не как лес.
      const cap = D >= 2 ? 4 : D === 1 ? 3 : 1;
      const n = Math.max(1, Math.round(1 + r2 * (cap - 1)));
      // деревья ближе к низу клетки рисуются позже — перекрытие как в глубину
      const list = [];
      for (let i = 0; i < n; i++) {
        const hx = hash2(x * 31 + i * 5, y * 13 + i), hy = hash2(x * 7 + i, y * 23 + i * 3);
        list.push({
          x: px + TP * (0.18 + hx * 0.64), y: py + TP * (0.26 + hy * 0.52),
          r: TP * (0.17 + hash2(x + i, y + i) * 0.11), k: hash2(x * 3 + i, y * 3 + i),
        });
      }
      list.sort((a, b) => a.y - b.y);
      for (const tr of list) this.tree(c, tr.x, tr.y, tr.r, p, season, tr.k);
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
      const W2 = world.w;
      const isM = (xx, yy) => (xx < 0 || yy < 0 || xx >= W2 || yy >= world.h)
        ? false : world.tiles[yy * W2 + xx] === TILE.MOUNTAIN;

      // Порода: крупные плиты, размер и наклон которых ведёт гладкий шум.
      // Поклеточные грани одинакового размера складывались в диагональную
      // сетку — ровно то, из-за чего горы читались как обои.
      const nf = fbm2(x * 1.7, y * 1.7);
      c.fillStyle = nf > 0.5 ? p.hi : p.lo;
      c.globalAlpha = 0.16 + Math.abs(nf - 0.5) * 0.5;
      c.beginPath();
      c.moveTo(px - TP * r1 * 0.3, py + TP * (r2 * 0.5 - 0.1));
      c.lineTo(px + TP * (0.6 + r2 * 0.6), py - TP * r3 * 0.25);
      c.lineTo(px + TP * (1.1 + r1 * 0.3), py + TP * (0.6 + r3 * 0.5));
      c.lineTo(px + TP * (0.2 + r3 * 0.4), py + TP * (0.9 + r1 * 0.35));
      c.closePath(); c.fill();
      // трещины по граням
      c.globalAlpha = 0.3;
      c.strokeStyle = p.lo; c.lineWidth = Math.max(1, TP * 0.03);
      c.beginPath();
      c.moveTo(px + TP * r1, py);
      c.lineTo(px + TP * (0.2 + r2 * 0.6), py + TP * (0.5 + r3 * 0.3));
      c.lineTo(px + TP * (r3 * 0.5), py + TP);
      c.stroke();
      c.globalAlpha = 1;
      // Скальные выходы: угловатые камни со светлой и теневой гранью. Без них
      // массив между вершинами оставался ровным серым полем.
      if (D >= 1 && r1 > 0.3) {
        const ox = px + TP * (0.18 + r2 * 0.5), oy = py + TP * (0.42 + r3 * 0.4);
        const rw = TP * (0.16 + r1 * 0.2), rh = rw * (0.7 + r2 * 0.5);
        c.fillStyle = 'rgba(0,0,0,0.2)';
        c.beginPath();
        c.moveTo(ox + rw * 0.3, oy - rh); c.lineTo(ox + rw * 1.5, oy + rh * 0.5);
        c.lineTo(ox - rw * 0.5, oy + rh * 0.5); c.closePath(); c.fill();
        c.fillStyle = p.lo;
        c.beginPath();
        c.moveTo(ox, oy - rh); c.lineTo(ox + rw * 0.55, oy - rh * 0.1);
        c.lineTo(ox + rw, oy + rh * 0.45); c.lineTo(ox - rw * 0.8, oy + rh * 0.45);
        c.closePath(); c.fill();
        c.fillStyle = p.hi;
        c.beginPath();
        c.moveTo(ox, oy - rh); c.lineTo(ox - rw * 0.8, oy + rh * 0.45);
        c.lineTo(ox - rw * 0.35, oy + rh * 0.1);
        c.closePath(); c.fill();
      }
      if (D >= 1 && r3 > 0.72) {
        // осыпь у подножия
        c.fillStyle = p.det2; c.globalAlpha = 0.45;
        for (let i = 0; i < 2; i++) {
          const sxp = px + TP * (0.15 + hash2(x * 7 + i, y * 3 + i) * 0.7);
          const syp = py + TP * (0.6 + hash2(x + i * 5, y * 9 + i) * 0.35);
          c.beginPath(); c.ellipse(sxp, syp, TP * 0.055, TP * 0.04, r1 * 3, 0, 7); c.fill();
        }
        c.globalAlpha = 1;
      }

      // Вершина ставится не на каждой клетке, а там, где хеш — локальный
      // максимум в окне 3×3. Пики сами собой расходятся и выстраиваются в
      // хребет; сплошной ковёр одинаковых треугольников, из-за которого горы
      // читались как обои, при этом исчезает.
      const hp = hash2(x * 5 + 3, y * 11 + 7);
      let peakHere = true;
      for (let dy = -1; dy <= 1 && peakHere; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (!isM(x + dx, y + dy)) continue;
          if (hash2((x + dx) * 5 + 3, (y + dy) * 11 + 7) >= hp) { peakHere = false; break; }
        }
      }
      if (!peakHere) return;

      const scale = 0.9 + r2 * 0.9;
      const cxp = px + TP * (0.4 + r1 * 0.2), base = py + TP * (1.0 + r3 * 0.15);
      const peak = py + TP * (0.55 - 0.62 * scale);
      const wdt = TP * (0.5 + r3 * 0.25) * scale;
      // тень вправо-вниз по канону света
      c.fillStyle = 'rgba(0,0,0,0.24)';
      c.beginPath(); c.moveTo(cxp, peak); c.lineTo(cxp + wdt * 1.7, base); c.lineTo(cxp - wdt * 0.1, base); c.closePath(); c.fill();
      // тёмный правый склон с изломом гребня
      c.fillStyle = p.lo;
      c.beginPath();
      c.moveTo(cxp, peak);
      c.lineTo(cxp + wdt * 0.42, peak + (base - peak) * 0.42);
      c.lineTo(cxp + wdt, base); c.lineTo(cxp - wdt * 0.15, base);
      c.closePath(); c.fill();
      // светлый левый склон
      c.fillStyle = p.hi;
      c.beginPath();
      c.moveTo(cxp, peak);
      c.lineTo(cxp - wdt * 0.15, base); c.lineTo(cxp - wdt, base);
      c.lineTo(cxp - wdt * 0.36, peak + (base - peak) * 0.38);
      c.closePath(); c.fill();
      // снег на высоких вершинах
      if (D >= 1 && scale > 1.15) {
        c.fillStyle = p.det2;
        const sy2 = peak + (base - peak) * 0.26;
        c.beginPath(); c.moveTo(cxp, peak);
        c.lineTo(cxp + wdt * 0.3, sy2); c.lineTo(cxp + wdt * 0.12, sy2 - TP * 0.05);
        c.lineTo(cxp - wdt * 0.1, sy2 + TP * 0.04); c.lineTo(cxp - wdt * 0.28, sy2);
        c.closePath(); c.fill();
      }
      return;
    }

    if (t === TILE.SAND) {
      if (D < 1) return;
      // рябь дюн: две волны разной длины, плюс тень с подветренной стороны
      for (let i = 0; i < 2; i++) {
        const hy = hash2(x * 19 + i * 7, y * 11 + i);
        const yy = py + TP * (0.22 + hy * 0.55 + i * 0.12);
        c.strokeStyle = p.lo; c.globalAlpha = 0.22; c.lineWidth = Math.max(1, TP * 0.05);
        c.beginPath();
        c.moveTo(px + TP * 0.08, yy + TP * 0.03);
        c.quadraticCurveTo(px + TP * 0.5, yy - TP * 0.06, px + TP * 0.92, yy + TP * 0.05);
        c.stroke();
        c.strokeStyle = p.det2; c.globalAlpha = 0.45; c.lineWidth = Math.max(1, TP * 0.035);
        c.beginPath();
        c.moveTo(px + TP * 0.08, yy);
        c.quadraticCurveTo(px + TP * 0.5, yy - TP * 0.09, px + TP * 0.92, yy + TP * 0.02);
        c.stroke();
      }
      c.globalAlpha = 1;
      // редкие камешки и сухая трава — песок перестаёт быть пустой заливкой
      if (D >= 2 && r3 > 0.72) {
        c.fillStyle = p.lo; c.globalAlpha = 0.45;
        for (let i = 0; i < 2; i++) {
          c.beginPath();
          c.ellipse(px + TP * (0.2 + hash2(x + i, y * 3 + i) * 0.6), py + TP * (0.25 + hash2(x * 3 + i, y + i) * 0.5),
            TP * 0.035, TP * 0.026, r1 * 3, 0, 7);
          c.fill();
        }
        c.globalAlpha = 1;
      }
      if (D >= 2 && r1 > 0.88) {
        c.strokeStyle = 'rgba(150,146,96,0.5)'; c.lineWidth = Math.max(1, TP * 0.03);
        const gx = px + TP * (0.25 + r2 * 0.5), gy = py + TP * (0.55 + r3 * 0.3);
        for (const k of [-1, 0, 1]) {
          c.beginPath();
          c.moveTo(gx, gy);
          c.quadraticCurveTo(gx + k * TP * 0.04, gy - TP * 0.06, gx + k * TP * 0.09, gy - TP * 0.12);
          c.stroke();
        }
      }
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

  // Отдельное дерево силуэтом: ствол, крона своей формы, тень и блик.
  // rnd задаёт породу — хвойное или лиственное — и разнотон листвы, поэтому
  // лес выглядит смешанным, а не размноженным одним кустом.
  tree(c, x, y, r, p, season, rnd) {
    const conifer = rnd > 0.55;
    // тень под кроной (свет сверху-слева → тень вправо-вниз)
    c.fillStyle = 'rgba(16,26,12,0.30)';
    c.beginPath(); c.ellipse(x + r * 0.5, y + r * 0.82, r * 0.8, r * 0.3, 0, 0, 7); c.fill();
    // ствол с утолщением у корня
    const bark = season === 3 ? '#4a3d33' : conifer ? '#4d3a28' : '#5f4732';
    c.fillStyle = bark;
    c.beginPath();
    c.moveTo(x - r * 0.1, y + r * 0.85);
    c.lineTo(x - r * 0.07, y - r * 0.1);
    c.lineTo(x + r * 0.07, y - r * 0.1);
    c.lineTo(x + r * 0.1, y + r * 0.85);
    c.closePath(); c.fill();

    // разнотон листвы: соседние деревья не бывают одного цвета
    const k = (rnd - 0.5) * 0.22;
    const lo = shadeHex(p.det, 1 + k - 0.14);
    const mid = shadeHex(p.det, 1 + k);
    const hi = shadeHex(p.det2, 1 + k * 0.6);

    if (conifer) {
      // ель: три яруса лап, каждый со светлой левой и тёмной правой половиной
      for (let i = 0; i < 3; i++) {
        const w = r * (1.05 - i * 0.24), top = y - r * (0.15 + i * 0.52), base = y + r * (0.42 - i * 0.5);
        c.fillStyle = lo;
        c.beginPath();
        c.moveTo(x, top); c.lineTo(x + w, base); c.lineTo(x - w, base);
        c.closePath(); c.fill();
        c.fillStyle = i === 2 ? hi : mid;
        c.beginPath();
        c.moveTo(x, top); c.lineTo(x - w, base); c.lineTo(x - w * 0.1, base);
        c.closePath(); c.fill();
      }
    } else {
      // лиственное: неровная крона из четырёх наплывов
      c.fillStyle = lo;
      c.beginPath(); c.arc(x + r * 0.34, y + r * 0.06, r * 0.66, 0, 7); c.fill();
      c.beginPath(); c.arc(x - r * 0.34, y + r * 0.16, r * 0.58, 0, 7); c.fill();
      c.beginPath(); c.arc(x + r * 0.06, y + r * 0.3, r * 0.56, 0, 7); c.fill();
      c.fillStyle = mid;
      c.beginPath(); c.arc(x - r * 0.06, y - r * 0.22, r * 0.68, 0, 7); c.fill();
      c.fillStyle = hi;
      c.beginPath(); c.arc(x - r * 0.26, y - r * 0.38, r * 0.42, 0, 7); c.fill();
    }
    // блик на освещённой стороне
    c.fillStyle = 'rgba(255,255,240,0.18)';
    c.beginPath(); c.ellipse(x - r * 0.38, y - r * (conifer ? 0.72 : 0.46), r * 0.2, r * 0.28, -0.5, 0, 7); c.fill();
    // зимняя шапка снега
    if (season === 3) {
      c.fillStyle = 'rgba(240,246,252,0.85)';
      if (conifer) {
        for (let i = 0; i < 3; i++) {
          const w = r * (1.05 - i * 0.24), top = y - r * (0.15 + i * 0.52);
          c.beginPath();
          c.moveTo(x, top); c.lineTo(x + w * 0.5, top + r * 0.26); c.lineTo(x - w * 0.5, top + r * 0.26);
          c.closePath(); c.fill();
        }
      } else {
        c.beginPath(); c.arc(x - r * 0.18, y - r * 0.42, r * 0.44, Math.PI * 1.05, Math.PI * 2.05); c.fill();
      }
    }
    // осенняя подсветка листвы
    if (season === 2 && !conifer) {
      c.fillStyle = `rgba(226,140,52,${0.2 + rnd * 0.3})`;
      c.beginPath(); c.arc(x + r * 0.2, y - r * 0.05, r * 0.48, 0, 7); c.fill();
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
