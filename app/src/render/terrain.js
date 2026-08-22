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
import { TERRAIN, TILE_HEIGHT, hash2, fbm2, hex2rgb, mixHex } from './palette.js';
import { LandmarkLayer } from './landmarks.js';

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
    this.road = null;          // сеть дорог: рёбра, пятаки перекрёстков, индекс по чанкам
    // Природные ориентиры: пик, вулкан, оазис, водопад. Живут вместе с
    // местностью, потому что печутся прямо в её чанки.
    this.landmarks = new LandmarkLayer(quality);
    this.roadKey = null;       // подпись состава построек и эпохи
  }

  setQuality(q) { this.q = q; this.invalidate(); }

  invalidate() { this.chunks.clear(); this.low = null; this.season = -1; this.roadKey = null; }

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
    // Ориентиры расставляются по готовому полю высот и только при смене
    // мира: ensure возвращает true один раз за партию, тогда и чистим чанки.
    if (this.landmarks.ensure(sim, this.q, this.height)) this.chunks.clear();
    // Дороги живут внутри чанков. Пересобираем сеть только когда меняется
    // состав достроенного или эпоха — то есть несколько раз за партию, а не в кадре.
    const key = roadKeyOf(sim);
    if (key !== this.roadKey) {
      this.roadKey = key;
      const old = this.road ? this.road.keys : null;
      this.buildRoads(sim);
      // перепекаем только чанки, где дороги были или появились
      if (old) for (const k of old) this.chunks.delete(k);
      if (this.road) for (const k of this.road.keys) this.chunks.delete(k);
    }
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

    // 3.5) дороги и тропы. Идут ПОСЛЕ травы и подстилки — иначе трава прорастала
    // бы сквозь брусчатку, — но до береговой линии. Здания и жители рисуются в
    // кадре поверх чанка, так что дорога всегда оказывается под ними.
    this.drawRoads(c, x0, y0, TP);

    // 4) береговая линия и обрывы — поверх всего, чётко
    for (let y = y0; y < y0 + CHUNK; y++) {
      for (let x = x0; x < x0 + CHUNK; x++) {
        if (x >= W || y >= H) continue;
        this.edges(c, world, pal, x, y, (x - x0) * TP, (y - y0) * TP, TP);
      }
    }
    // Ориентир кладётся последним слоем чанка: он стоит НА местности, и его
    // не должны перечёркивать ни береговая кромка, ни тени обрывов.
    this.landmarks.paint(c, sim, x0, y0, TP, CHUNK);
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
    // На полотне дороги не растёт дерево и не лежит валун: дорога рисуется
    // поверх мелочи, но высокое ей пришлось бы «протыкать» — его просто нет.
    const onRoad = this.road ? this.road.tiles.has(y * world.w + x) : false;
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
      if (onRoad) return;   // просека под дорогу
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
      if (D >= 1 && r1 > 0.3 && !onRoad) {
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
      if (!peakHere || onRoad) return;

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

  // =========================================================================
  // ДОРОГИ И ТРОПЫ
  //
  // Ровная решётка домов на однородной траве читается как таблица, а не как
  // поселение. Тропы связывают дома в сеть, и глаз сразу видит центр и окраину.
  //
  // Как это устроено:
  //   1) постройки — узлы графа, между ними строится минимальное остовное
  //      дерево от очага (вода в стоимости ребра штрафуется, поэтому дороги
  //      огибают озёра);
  //   2) ширина складывается из двух вещей: сколько дворов ходит через ребро
  //      (вес поддерева) и близость к очагу. Отсюда «чем ближе к центру, тем
  //      шире»: у очага площадь, на выселках тропинка в одну ногу;
  //   3) каждое ребро превращается в ленту переменной ширины со слабым изгибом
  //      (прямая линия между домами выглядит чертёжной), у перекрёстков лента
  //      расширяется, а сам узел закрывается пятаком;
  //   4) все ленты и пятаки чанка кладутся в ОДИН путь и заливаются одной
  //      заливкой: пересечения сливаются объединением, и повороты с
  //      перекрёстками не показывают ни швов, ни обрубков.
  // Всё это печётся в чанк — в кадре дороги стоят ноль.
  // =========================================================================

  buildRoads(sim) {
    this.road = null;
    const bs = sim.buildings || [];
    const world = sim.world;
    if (!world) return;
    const nx = [], ny = [];
    let root = 0;
    for (const b of bs) {
      if (!b.done || b.destroyed) continue;
      const s = b.size || 1;
      if (b.id === 'campfire') root = nx.length;   // очаг — сердце поселения
      nx.push(b.x + s / 2); ny.push(b.y + s / 2);
    }
    const N = nx.length;
    if (N < 2) return;

    const W = world.w, H = world.h;
    // Доля воды под прямой между узлами: по ней дорога либо обходит озеро,
    // либо не рисуется вовсе — плыть по дну она не должна.
    const wet = (i, j) => {
      let n = 0;
      for (let s = 1; s <= 5; s++) {
        const t = s / 6;
        const x = Math.round(nx[i] + (nx[j] - nx[i]) * t), y = Math.round(ny[i] + (ny[j] - ny[i]) * t);
        const tt = (x < 0 || y < 0 || x >= W || y >= H) ? TILE.DEEP : world.tiles[y * W + x];
        if (tt === TILE.WATER || tt === TILE.DEEP) n++;
      }
      return n / 5;
    };
    const dist = (i, j) => Math.hypot(nx[i] - nx[j], ny[i] - ny[j]);

    // --- остовное дерево от очага (Прим, O(N²) — считается раз на постройку) ---
    const inT = new Uint8Array(N), best = new Float64Array(N), par = new Int32Array(N);
    const order = new Int32Array(N);
    best.fill(Infinity); par.fill(-1); best[root] = 0;
    let cnt = 0;
    for (let k = 0; k < N; k++) {
      let u = -1, bv = Infinity;
      for (let i = 0; i < N; i++) if (!inT[i] && best[i] < bv) { bv = best[i]; u = i; }
      if (u < 0) break;
      inT[u] = 1; order[cnt++] = u;
      for (let v = 0; v < N; v++) {
        if (inT[v]) continue;
        const cst = dist(u, v) * (1 + 7 * wet(u, v));
        if (cst < best[v]) { best[v] = cst; par[v] = u; }
      }
    }
    // размер поддерева = сколько дворов ходит через это ребро
    const size = new Int32Array(N).fill(1);
    for (let k = cnt - 1; k >= 1; k--) {
      const u = order[k];
      if (par[u] >= 0) size[par[u]] += size[u];
    }

    const raw = [], seen = new Set();
    const pairKey = (a, b) => a < b ? a + ':' + b : b + ':' + a;
    for (let k = 1; k < cnt; k++) {
      const u = order[k], p = par[u];
      if (p < 0) continue;
      seen.add(pairKey(u, p));
      if (dist(u, p) > 30 || wet(u, p) > 0.3) continue;   // не тянем через пол-карты и через воду
      raw.push({ a: p, b: u, traffic: size[u] });
    }
    // Пара коротких перемычек сверх дерева: дерево не даёт колец, а без колец
    // поселение выглядит расчёской. Перемычки и создают настоящие перекрёстки.
    for (let i = 0; i < N; i++) {
      let bj = -1, bd = Infinity;
      for (let j = 0; j < N; j++) {
        if (i === j || seen.has(pairKey(i, j))) continue;
        const d = dist(i, j);
        if (d < bd) { bd = d; bj = j; }
      }
      if (bj < 0 || bd > 7 || bd < 0.6) continue;
      if (hash2(Math.round(nx[i] * 4) + 17, Math.round(ny[bj] * 4) + 5) < 0.55) continue;
      if (wet(i, bj) > 0.2) continue;
      seen.add(pairKey(i, bj));
      raw.push({ a: i, b: bj, traffic: 2 });
    }
    if (!raw.length) return;

    // --- ленты ---
    // Второй источник ширины, кроме числа дворов: близость к сердцу поселения.
    // На кольцевой застройке дерево само по себе центр не выделяет, а глаз
    // ждёт, что у очага улица шире, чем на выселках.
    let far = 1;
    for (let i = 0; i < N; i++) far = Math.max(far, Math.hypot(nx[i] - nx[root], ny[i] - ny[root]));
    far = Math.max(8, Math.min(40, far));
    const boost = (x, y) => {
      const k = 1 - Math.min(1, Math.hypot(x - nx[root], y - ny[root]) / far);
      return 1 + 0.5 * k * k * Math.sqrt(k + 0.0001);
    };

    const nodeH = new Float64Array(N);
    for (let i = 0; i < N; i++) nodeH[i] = roadHalf(size[i]);
    const edges = [], maxH = new Float64Array(N);
    for (const e of raw) {
      const h = roadHalf(e.traffic);
      const hA = Math.max(h, Math.min(nodeH[e.a], h * 2.2));
      const hB = Math.max(h, Math.min(nodeH[e.b], h * 2.2));
      const r = makeRibbon(nx[e.a], ny[e.a], nx[e.b], ny[e.b], h, hA, hB, boost);
      if (!r) continue;
      edges.push(r);
      maxH[e.a] = Math.max(maxH[e.a], hA * boost(nx[e.a], ny[e.a]));
      maxH[e.b] = Math.max(maxH[e.b], hB * boost(nx[e.b], ny[e.b]));
    }
    if (!edges.length) return;
    const discs = [];
    for (let i = 0; i < N; i++) if (maxH[i] > 0) discs.push({ x: nx[i], y: ny[i], r: maxH[i] * 1.16 });

    // --- индекс по чанкам: чанк рисует только то, что его задевает ---
    const byChunk = new Map(), keys = new Set();
    const put = (x0, y0, x1, y1, kind, idx) => {
      const c0x = Math.floor(x0 / CHUNK), c1x = Math.floor(x1 / CHUNK);
      const c0y = Math.floor(y0 / CHUNK), c1y = Math.floor(y1 / CHUNK);
      for (let cy = c0y; cy <= c1y; cy++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          const k = cx + ',' + cy;
          let cell = byChunk.get(k);
          if (!cell) { cell = { e: [], d: [] }; byChunk.set(k, cell); keys.add(k); }
          cell[kind].push(idx);
        }
      }
    };
    // Запас в клетках: мягкий край, фактура и просека, которую соседний чанк
    // рисует своей каймой в одну клетку.
    const PADT = 1.6;
    edges.forEach((r, i) => put(r.x0 - PADT, r.y0 - PADT, r.x1 + PADT, r.y1 + PADT, 'e', i));
    discs.forEach((d, i) => put(d.x - d.r - PADT, d.y - d.r - PADT, d.x + d.r + PADT, d.y + d.r + PADT, 'd', i));

    // Клетки, которые дорога накрывает целиком. Нужны, чтобы на полотне не
    // стояло дерево и не торчал валун: дорогу сквозь лес прорубают.
    const tiles = new Set();
    for (const r of edges) {
      for (const q of r.p) {
        const rad = q.h + 0.12;
        const tx0 = Math.floor(q.x - rad), tx1 = Math.floor(q.x + rad);
        const ty0 = Math.floor(q.y - rad), ty1 = Math.floor(q.y + rad);
        for (let ty = ty0; ty <= ty1; ty++) {
          for (let tx = tx0; tx <= tx1; tx++) {
            if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
            if (Math.hypot(tx + 0.5 - q.x, ty + 0.5 - q.y) <= rad) tiles.add(ty * W + tx);
          }
        }
      }
    }
    for (const d of discs) {
      const tx0 = Math.floor(d.x - d.r), tx1 = Math.floor(d.x + d.r);
      const ty0 = Math.floor(d.y - d.r), ty1 = Math.floor(d.y + d.r);
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
          if (Math.hypot(tx + 0.5 - d.x, ty + 0.5 - d.y) <= d.r) tiles.add(ty * W + tx);
        }
      }
    }

    const mi = roadMatIndex(sim.eraIndex);
    this.road = { edges, discs, byChunk, keys, tiles, mat: seasonMat(ROAD_MAT[mi], sim.seasonIdx), mi };
  }

  // Контур ленты: левая сторона вперёд, правая назад. Обход всегда одной
  // закрутки — иначе при заливке nonzero пересечения выбивали бы дыры.
  ribbonPath(c, r, x0, y0, TP, k) {
    const p = r.p, n = p.length;
    for (let i = 0; i < n; i++) {
      const q = p[i], hh = q.h * k;
      const X = (q.x + q.nx * hh - x0) * TP, Y = (q.y + q.ny * hh - y0) * TP;
      if (i === 0) c.moveTo(X, Y); else c.lineTo(X, Y);
    }
    for (let i = n - 1; i >= 0; i--) {
      const q = p[i], hh = q.h * k;
      c.lineTo((q.x - q.nx * hh - x0) * TP, (q.y - q.ny * hh - y0) * TP);
    }
    c.closePath();
  }

  // Пятак перекрёстка. Дуга рисуется ПРОТИВ часовой: у ленты закрутка
  // отрицательная, и совпадение направлений — единственное, что не даёт
  // объединению превратить перекрёсток в дырку.
  discPath(c, d, x0, y0, TP, k) {
    c.moveTo((d.x + d.r * k - x0) * TP, (d.y - y0) * TP);
    c.arc((d.x - x0) * TP, (d.y - y0) * TP, d.r * k * TP, 0, Math.PI * 2, true);
    c.closePath();
  }

  drawRoads(c, x0, y0, TP) {
    const R = this.road;
    if (!R) return;
    const cell = R.byChunk.get((x0 / CHUNK) + ',' + (y0 / CHUNK));
    if (!cell) return;
    const M = R.mat, D = this.q.detail;
    const path = (k) => {
      c.beginPath();
      for (const i of cell.e) this.ribbonPath(c, R.edges[i], x0, y0, TP, k);
      for (const i of cell.d) this.discPath(c, R.discs[i], x0, y0, TP, k);
    };

    // 1) утоптанный ореол: три широких полупрозрачных слоя земляного тона
    // вместо резкой границы. Дорога не врезана в траву, а вытоптана в ней.
    c.fillStyle = M.halo;
    path(2.10); c.globalAlpha = 0.11; c.fill();
    path(1.62); c.globalAlpha = 0.20; c.fill();
    path(1.26); c.globalAlpha = 0.34; c.fill();

    // 2) рваная обочина: кляксы земли по краю — край не по линейке
    if (D >= 1) {
      c.beginPath();
      for (const i of cell.e) {
        const p = R.edges[i].p;
        for (let j = 0; j < p.length; j++) {
          const q = p[j];
          if (q.x < x0 - 1.5 || q.y < y0 - 1.5 || q.x > x0 + CHUNK + 1.5 || q.y > y0 + CHUNK + 1.5) continue;
          const hs = hash2(j * 37 + i * 11, j * 7 + 3);
          if (hs < 0.40) continue;
          const side = hs > 0.70 ? 1 : -1;
          const off = q.h * (1.05 + hash2(j * 5, i * 13 + j) * 0.40) * side;
          const rad = (0.07 + hash2(j * 3 + 1, i + j * 9) * 0.11) * TP;
          c.moveTo((q.x + q.nx * off - x0) * TP + rad, (q.y + q.ny * off - y0) * TP);
          c.arc((q.x + q.nx * off - x0) * TP, (q.y + q.ny * off - y0) * TP, rad, 0, Math.PI * 2, true);
        }
      }
      c.globalAlpha = 0.42; c.fillStyle = M.halo; c.fill();
    }

    // 3) бордюр у мощения: кайма чуть шире полотна, поэтому шва внутри нет
    if (M.rim) { path(1.09); c.globalAlpha = 1; c.fillStyle = M.rim; c.fill(); }

    // 4) полотно
    path(1); c.globalAlpha = 1; c.fillStyle = M.base; c.fill();

    // 5) фактура материала — строго внутри полотна
    if (D >= 1) {
      c.save();
      path(1); c.clip();
      this.roadTexture(c, cell, x0, y0, TP, M, R.mi);
      c.restore();
    }
    c.globalAlpha = 1;
  }

  // Фактура по эпохам: грунт → гравий → камень → брусчатка → асфальт.
  roadTexture(c, cell, x0, y0, TP, M, mi) {
    const R = this.road;
    const near = (q) => !(q.x < x0 - 1.5 || q.y < y0 - 1.5 || q.x > x0 + CHUNK + 1.5 || q.y > y0 + CHUNK + 1.5);
    c.lineCap = 'round'; c.lineJoin = 'round';

    for (const ei of cell.e) {
      const r = R.edges[ei], p = r.p, mid = p[p.length >> 1];

      if (mi === 0) {
        // грунт: светлая пыль по середине и две тёмные колеи от ног и телег
        c.strokeStyle = M.lite; c.globalAlpha = 0.16;
        c.lineWidth = Math.max(1, mid.h * 0.95 * TP);
        c.beginPath();
        for (let j = 0; j < p.length; j++) {
          const q = p[j];
          if (j === 0) c.moveTo((q.x - x0) * TP, (q.y - y0) * TP); else c.lineTo((q.x - x0) * TP, (q.y - y0) * TP);
        }
        c.stroke();
        if (mid.h > 0.15) {
          c.strokeStyle = M.dark; c.globalAlpha = 0.26; c.lineWidth = Math.max(1, TP * 0.06);
          for (const s of [-0.46, 0.46]) {
            c.beginPath();
            for (let j = 0; j < p.length; j++) {
              const q = p[j], o = q.h * s;
              const X = (q.x + q.nx * o - x0) * TP, Y = (q.y + q.ny * o - y0) * TP;
              if (j === 0) c.moveTo(X, Y); else c.lineTo(X, Y);
            }
            c.stroke();
          }
        }
        for (let j = 0; j < p.length; j += 2) {
          const q = p[j];
          if (!near(q)) continue;
          const o = (hash2(j * 19 + ei, j * 7) - 0.5) * 1.6 * q.h;
          c.globalAlpha = 0.4; c.fillStyle = hash2(j * 7 + ei, j) > 0.5 ? M.lite : M.dark;
          c.beginPath();
          c.arc((q.x + q.nx * o - x0) * TP, (q.y + q.ny * o - y0) * TP, TP * 0.032, 0, 7);
          c.fill();
        }
      } else if (mi === 1) {
        // гравий: щебёнка двумя тонами, плотнее к середине
        for (let j = 0; j < p.length; j++) {
          const q = p[j];
          if (!near(q)) continue;
          for (let s = 0; s < 3; s++) {
            const o = (hash2(j * 31 + s * 7 + ei, j * 11 + s) - 0.5) * 1.8 * q.h;
            const al = (hash2(j * 5 + s, s * 13 + ei) - 0.5);
            const along = (hash2(j * 3 + s * 5, j + s) - 0.5) * 0.4;
            c.fillStyle = al > 0 ? M.lite : M.dark;
            c.globalAlpha = 0.42;
            c.beginPath();
            c.arc((q.x + q.nx * o + q.tx * along - x0) * TP, (q.y + q.ny * o + q.ty * along - y0) * TP,
              TP * (0.022 + Math.abs(al) * 0.05), 0, 7);
            c.fill();
          }
        }
      } else if (mi === 2) {
        // камень: неровные плиты, по две в ряд, со швом между ними
        c.lineWidth = Math.max(1, TP * 0.03);
        for (let j = 0; j < p.length; j++) {
          const q = p[j];
          if (!near(q)) continue;
          for (const side of [-1, 1]) {
            const cx0 = q.x + q.nx * q.h * side * 0.5, cy0 = q.y + q.ny * q.h * side * 0.5;
            const aw = q.h * (0.36 + hash2(j + ei, side + 3) * 0.14);  // поперёк
            const al = 0.19 + hash2(j * 7 + side, ei) * 0.10;          // вдоль
            c.beginPath();
            for (let k = 0; k < 4; k++) {
              const sx = (k === 0 || k === 3) ? -1 : 1, sy = (k < 2) ? -1 : 1;
              const jt = 0.72 + hash2(j * 13 + k, ei * 3 + side) * 0.5;
              const wx = cx0 + q.nx * aw * sy * jt + q.tx * al * sx;
              const wy = cy0 + q.ny * aw * sy * jt + q.ty * al * sx;
              const X = (wx - x0) * TP, Y = (wy - y0) * TP;
              if (k === 0) c.moveTo(X, Y); else c.lineTo(X, Y);
            }
            c.closePath();
            c.globalAlpha = 0.30;
            c.fillStyle = hash2(j * 3 + side, ei + j) > 0.5 ? M.lite : M.dark;
            c.fill();
            c.globalAlpha = 0.26; c.strokeStyle = M.dark; c.stroke();
          }
        }
      } else if (mi === 3) {
        // Брусчатка: ряды поперёк дороги вразбежку. Ряды идут вдвое чаще узлов
        // ленты — по узлам получались бы шпалы, а не камень.
        c.lineWidth = Math.max(1, TP * 0.035);
        const rows = (p.length - 1) * 2;
        for (let j = 0; j <= rows; j++) {
          const i0 = Math.min(p.length - 1, j >> 1), i1 = Math.min(p.length - 1, i0 + 1);
          const f = (j & 1) ? 0.5 : 0;
          const a = p[i0], b = p[i1];
          const q = {
            x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f,
            nx: a.nx + (b.nx - a.nx) * f, ny: a.ny + (b.ny - a.ny) * f,
            tx: a.tx, ty: a.ty, h: a.h + (b.h - a.h) * f,
          };
          if (!near(q)) continue;
          const H = q.h * 1.02;
          c.globalAlpha = 0.32; c.strokeStyle = M.dark;
          c.beginPath();
          c.moveTo((q.x - q.nx * H - x0) * TP, (q.y - q.ny * H - y0) * TP);
          c.lineTo((q.x + q.nx * H - x0) * TP, (q.y + q.ny * H - y0) * TP);
          c.stroke();
          // блик по кромке ряда — камень получает объём
          c.globalAlpha = 0.14; c.strokeStyle = M.lite;
          c.beginPath();
          c.moveTo((q.x - q.nx * H + q.tx * 0.05 - x0) * TP, (q.y - q.ny * H + q.ty * 0.05 - y0) * TP);
          c.lineTo((q.x + q.nx * H + q.tx * 0.05 - x0) * TP, (q.y + q.ny * H + q.ty * 0.05 - y0) * TP);
          c.stroke();
          // продольные швы: через ряд сдвигаются — кладка вразбежку
          c.globalAlpha = 0.26; c.strokeStyle = M.dark;
          const offs = (j % 2) ? [-0.55, 0.55] : [0];
          for (const o of offs) {
            c.beginPath();
            c.moveTo((q.x + q.nx * q.h * o - x0) * TP, (q.y + q.ny * q.h * o - y0) * TP);
            c.lineTo((q.x + q.nx * q.h * o + q.tx * 0.23 - x0) * TP, (q.y + q.ny * q.h * o + q.ty * 0.23 - y0) * TP);
            c.stroke();
          }
        }
      } else {
        // асфальт: мелкая крошка и осевая разметка на широких улицах
        for (let j = 0; j < p.length; j++) {
          const q = p[j];
          if (!near(q)) continue;
          const o = (hash2(j * 23 + ei, j * 5) - 0.5) * 1.8 * q.h;
          c.globalAlpha = 0.13; c.fillStyle = M.lite;
          c.beginPath();
          c.arc((q.x + q.nx * o - x0) * TP, (q.y + q.ny * o - y0) * TP, TP * 0.024, 0, 7);
          c.fill();
        }
        if (mid.h > 0.27 && M.mark) {
          c.strokeStyle = M.mark; c.globalAlpha = 0.55; c.lineWidth = Math.max(1, TP * 0.05);
          for (let j = 0; j + 1 < p.length; j++) {
            if (j % 6 > 2) continue;
            const q = p[j], nq = p[j + 1];
            if (!near(q)) continue;
            c.beginPath();
            c.moveTo((q.x - x0) * TP, (q.y - y0) * TP);
            c.lineTo((nq.x - x0) * TP, (nq.y - y0) * TP);
            c.stroke();
          }
        }
      }
    }
    c.globalAlpha = 1;
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

// ---------------------------------------------------------------------------
// Материалы дорог по эпохам. rim — бордюр (только у мощения), mark — разметка.
// ---------------------------------------------------------------------------
// halo — обочина: у любой дороги край вытоптан до земли, и именно земляной
// ореол мягко сводит полотно с травой. Без него мощение выглядит наклейкой.
const ROAD_MAT = [
  { base: '#96754a', dark: '#6f5533', lite: '#b7996a', halo: '#8a6a41', rim: null,      mark: null },      // грунт
  { base: '#8a8170', dark: '#635c4c', lite: '#b8ae95', halo: '#836b4c', rim: null,      mark: null },      // гравий
  { base: '#8a857d', dark: '#5f5a54', lite: '#ada79d', halo: '#7d6a50', rim: '#77726a', mark: null },      // камень
  { base: '#7d7871', dark: '#55514d', lite: '#9c958c', halo: '#75654e', rim: '#68645f', mark: null },      // брусчатка
  { base: '#4b4b4f', dark: '#38383c', lite: '#6e6e75', halo: '#5a5344', rim: '#5c5c62', mark: '#d9d2a8' }, // асфальт
];

function roadMatIndex(era) {
  if (era <= 1) return 0;   // каменный, бронза — утоптанный грунт
  if (era <= 3) return 1;   // железо, античность — гравий
  if (era <= 5) return 2;   // средневековье, возрождение — камень
  if (era === 6) return 3;  // индустрия — брусчатка
  return 4;                 // современность и дальше — асфальт
}

// Зимой дорогу заметает, осенью она темнеет от сырости.
function seasonMat(m, season) {
  if (season === 3) {
    return {
      base: mixHex(m.base, '#e6edf2', 0.42), dark: mixHex(m.dark, '#cfd8de', 0.34),
      lite: mixHex(m.lite, '#f4f8fa', 0.46), halo: mixHex(m.halo, '#e6edf2', 0.5),
      rim: m.rim && mixHex(m.rim, '#e6edf2', 0.4), mark: m.mark,
    };
  }
  if (season === 2) {
    return {
      base: mixHex(m.base, '#5a462c', 0.14), dark: mixHex(m.dark, '#4a3a24', 0.14),
      lite: mixHex(m.lite, '#6b5636', 0.12), halo: mixHex(m.halo, '#4a3a24', 0.16),
      rim: m.rim && mixHex(m.rim, '#4a3a24', 0.12), mark: m.mark,
    };
  }
  return m;
}

// Полуширина полотна в клетках по числу дворов, которые через него ходят.
// Корень, а не линейная зависимость: главная улица шире тропинки втрое, а не
// в полсотни раз — иначе центр поселения превращается в площадь.
function roadHalf(traffic) {
  return Math.min(0.44, 0.082 + 0.052 * Math.sqrt(Math.max(1, traffic)));
}

// Подпись состава поселения: пока она та же, сеть дорог не пересобирается.
function roadKeyOf(sim) {
  let s = ((sim.eraIndex | 0) + 1) * 7919;
  const bs = sim.buildings || [];
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (!b.done || b.destroyed) continue;
    s = (s * 31 + b.x * 73 + b.y * 151 + 7) | 0;
  }
  return s;
}

// Лента дороги: слабый изгиб (прямая между домами выглядит чертёжной) и
// расширение у обоих концов — там, где тропа вливается в улицу.
function makeRibbon(ax, ay, bx, by, h, hA, hB, boost) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 0.4) return null;
  const px = -dy / len, py = dx / len;
  const s1 = hash2(Math.round(ax * 8) + Math.round(by * 3), Math.round(ay * 8) + Math.round(bx * 5));
  const s2 = hash2(Math.round(bx * 8) + 7, Math.round(ay * 8) + 13);
  const a1 = (s1 - 0.5) * Math.min(len * 0.16, 1.5);
  const a2 = (s2 - 0.5) * Math.min(len * 0.09, 0.7);
  const n = Math.max(3, Math.min(120, Math.round(len / 0.45)));
  const p = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, hm = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const off = a1 * Math.sin(Math.PI * t) + a2 * Math.sin(2 * Math.PI * t);
    const x = ax + dx * t + px * off, y = ay + dy * t + py * off;
    const fa = Math.max(0, 1 - t / 0.28), fb = Math.max(0, 1 - (1 - t) / 0.28);
    const hh = Math.min(0.52, (h + (hA - h) * fa * fa + (hB - h) * fb * fb) * boost(x, y));
    p.push({ x, y, h: hh, nx: 0, ny: 0, tx: 0, ty: 0 });
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
    if (hh > hm) hm = hh;
  }
  for (let i = 0; i <= n; i++) {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(n, i + 1)];
    const tx = b.x - a.x, ty = b.y - a.y;
    const l = Math.hypot(tx, ty) || 1;
    p[i].tx = tx / l; p[i].ty = ty / l;
    p[i].nx = -ty / l; p[i].ny = tx / l;
  }
  return { p, x0: x0 - hm * 2, y0: y0 - hm * 2, x1: x1 + hm * 2, y1: y1 + hm * 2 };
}

// Умножение hex-цвета на коэффициент яркости.
function shadeHex(hex, m) {
  const c = hex2rgb(hex);
  return `rgb(${Math.min(255, c[0] * m) | 0},${Math.min(255, c[1] * m) | 0},${Math.min(255, c[2] * m) | 0})`;
}
