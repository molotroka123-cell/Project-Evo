// render/water.js — вода: глубина, изогнутый берег, бегущие волны, пена,
// отражения, зимний лёд и течение рек.
//
// ЗАЧЕМ. Сейчас вода — плоская синяя заливка по клеткам (П6 из
// docs/graphics-audit.md, видно на shots/map.png: озеро в центре — синий
// прямоугольник с белой обводкой по сторонам квадратов). Арт-дирекция §2.4
// требует трёх вещей: градиент глубины, прозрачность у кромки (дно
// просвечивает) и изогнутый берег, построенный не по сторонам тайла, а по
// сглаженному контуру массива воды. Плюс море, озеро и река должны различаться
// шириной и формой, а не цветом.
//
// КАК ЭТО СДЕЛАНО ДЁШЕВО. Ключ — знаковое поле расстояния до берега (sd):
// положительное в воде, отрицательное на суше, ноль ровно на кромке. Оно
// считается один раз на мир двухпроходным чамфером и даёт СРАЗУ ВСЁ:
//   • глубину (чем дальше от берега, тем темнее);
//   • изогнутый берег (кромка — это линия sd + шум = 0, а не сторона клетки);
//   • полосу пены (узкий коридор вокруг sd = 0, с учётом формы берега);
//   • тень берега на воде (по нормали к кромке и направлению солнца);
//   • ширину русла (мелкое sd на всём протяжении — это река, а не озеро).
//
// Вся статика печётся в три канваса размером с карту (по S пикселей на тайл) и
// в кадре только блитится. Анимация — бегущий по воде «нормаль»: испечённая
// плитка гребней заливается паттерном со смещением от времени, обрезается по
// маске воды в маленьком scratch-канвасе и блитится одним куском. Ни одной
// полноэкранной заливки, ни одного примитива на каждый водный тайл.
//
// СЛУЧАЙНОСТЬ. Math.random запрещён, rng ядра трогать нельзя: каждый его вызов
// сдвигает состояние симуляции, а рендер у игроков работает с разной частотой —
// сейв бы поплыл. Поэтому здесь свой xorshift от sim.world.seed плюс
// детерминированные hash2/fbm2 из palette.js. Ровно так же поступают
// weather.js и fx.js.
//
// ГРАНИЦЫ. Модуль ничего не меняет в симуляции: читает world.tiles, sim.buildings,
// sim.seasonIdx, sim.weather, sim.day. Подключение — внизу файла.
import { TILE, DAYS_PER_SEASON, BUILDING_ERA_IDX } from '../core/data.js';
import { TERRAIN, ERA_PALETTE, lightAt, hex2rgb, hash2, fbm2 } from './palette.js';

// Размер блока карты в тайлах. Кадр блитит не «всю карту», а полосы блоков,
// в которых вода вообще есть: на shots/map.png это четыре блока из ста сорока
// четырёх, то есть 3 % площади вместо полноэкранного прохода.
const BLK = 8;

// Пикселей выпечки на тайл. Больше — чётче кромка, дороже память:
// карта 96×96 при S = 6 даёт канвас 576×576 (1,3 МБ), их три.
const SUBRES = { eco: 0, medium: 4, high: 6, ultra: 8 };

// Плитка бегущих гребней. 128 — компромисс: меньше даёт видимый повтор,
// больше не читается на воде вовсе.
const WAVE_TEX = 128;

// Потолок площади анимируемой поверхности в пикселях выпечки. Выше него
// (то есть на дальнем зуме, когда в кадре половина океана) остаются только
// статичный слой и пена: бегущие блики на таком масштабе всё равно шум.
const SURF_CAP = 65000;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));

function makeRnd(seed) {
  let s = (seed | 0) || 0x6d2b79f5;
  return () => {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return (s >>> 0) / 4294967296;
  };
}

function isWet(t) { return t === TILE.WATER || t === TILE.DEEP; }

// Двухпроходный чамфер: расстояние в тайлах до ближайшей клетки-нуля.
// Приближение евклидова расстояния с ошибкой ~4 % — для формы берега этого
// более чем достаточно, а стоит один проход туда и один обратно.
function chamfer(W, H, zero) {
  const D = new Float32Array(W * H);
  const BIG = 1e6;
  for (let i = 0; i < W * H; i++) D[i] = zero[i] ? 0 : BIG;
  const d1 = 1, d2 = 1.4142;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let d = D[i];
      if (d === 0) continue;
      if (x > 0 && D[i - 1] + d1 < d) d = D[i - 1] + d1;
      if (y > 0 && D[i - W] + d1 < d) d = D[i - W] + d1;
      if (x > 0 && y > 0 && D[i - W - 1] + d2 < d) d = D[i - W - 1] + d2;
      if (x < W - 1 && y > 0 && D[i - W + 1] + d2 < d) d = D[i - W + 1] + d2;
      D[i] = d;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let d = D[i];
      if (d === 0) continue;
      if (x < W - 1 && D[i + 1] + d1 < d) d = D[i + 1] + d1;
      if (y < H - 1 && D[i + W] + d1 < d) d = D[i + W] + d1;
      if (x < W - 1 && y < H - 1 && D[i + W + 1] + d2 < d) d = D[i + W + 1] + d2;
      if (x > 0 && y < H - 1 && D[i + W - 1] + d2 < d) d = D[i + W - 1] + d2;
      D[i] = d;
    }
  }
  return D;
}

export class WaterLayer {
  constructor(quality) {
    this.q = quality;
    this.off = !quality || !quality.water;
    this.time = 0;
    this.rain = 0;        // насколько сейчас идёт дождь, 0..1 (плавно)
    this.freeze = 0;      // насколько встала вода, 0..1
    this.seed = 0;

    // Поле (зависит только от world.tiles)
    this.W = 0; this.H = 0;
    this.sd = null;       // знаковое расстояние до берега, тайлы
    this.gx = null; this.gy = null;   // единичная нормаль кромки (из суши в воду)
    this.fx = null; this.fy = null;   // течение: единичный вектор × сила
    this.deepK = null;    // доля «глубокого» тайла, сглаженная
    this.blocks = null;   // есть ли вода в блоке BLK×BLK
    this.bw = 0; this.bh = 0;
    this.fieldSeed = null;
    this.hasFlow = false;

    // Выпечка (зависит ещё и от сезона с пресетом)
    this.S = 0;
    this.base = null;     // цвет воды: глубина, дно у кромки, тень берега
    this.foamA = null; this.foamB = null;   // две фазы прибоя
    this.ice = null;      // зимний лёд с трещинами
    this.bakeKey = null;
    this.iceKey = null;

    // Кадровые холсты и текстуры
    this._sc = null; this._scx = null;      // сборка поверхности
    this._mx = null; this._mxx = null;      // накопитель гребней (маска яркости)
    this._wave = null; this._chop = null; this._drops = null;
    this._patW = null; this._patC = null; this._patD = null;
    this._spans = [];
    this._nSpans = 0;
    this.waveDir = [1, 4];   // целые: плитка гребней тайлится только по решётке

    // Необязательный хук: (b) => { cv } — испечённый спрайт здания для
    // отражения. Не задан — отражение рисуется цветовым пятном эпохи.
    this.spriteFor = null;
  }

  setQuality(q) {
    this.q = q;
    this.off = !q || !q.water;
    if (this.S !== (SUBRES[q && q.id] || 0)) this.invalidate();
  }

  // Сбросить всё испечённое (смена мира, сезона, пресета).
  invalidate() {
    this.base = null; this.foamA = null; this.foamB = null; this.ice = null;
    this.bakeKey = null; this.iceKey = null;
    this._sc = null; this._scx = null; this._mx = null; this._mxx = null;
    this._patW = null; this._patC = null; this._patD = null;
  }

  // =========================================================================
  // ГЛАВНЫЙ ВХОД
  // =========================================================================
  draw(sim, ctx, ox, oy, z, cw, ch, dt, L) {
    // Время идёт всегда, даже когда воды нет в кадре: иначе при возврате
    // камеры волна прыгает на полкарты.
    const step = Math.min(0.05, Math.max(0, dt || 0));
    this.time += step;
    this._trackWeather(sim, step);
    if (this.off || typeof document === 'undefined') return;
    if (!sim || !sim.world) return;

    this.ensure(sim);
    if (!this.base) return;

    const light = L || lightAt(sim.dayTime);
    const n = this._collectSpans(ox, oy, z, cw, ch);
    if (!n) return;

    const S = this.S;
    // 1) СТАТИКА: глубина, дно у кромки, изогнутый берег, тень берега.
    // Сглаживание обязательно: именно оно превращает решётку выпечки в
    // плавную кромку. Дальний зум — исключение: там мылить нечего, а
    // выключенное сглаживание вдвое дешевле.
    const zoom = z / 32;
    // Сглаженный масштабированный блит — самый дорогой примитив этого модуля на
    // программном растеризаторе: замер показал падение с 61 до 25 FPS. Держим
    // его только там, где кромка действительно видна крупно.
    const smoothBlit = zoom >= 1.2;
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = smoothBlit;
    this._blit(ctx, this.base, ox, oy, z, S, 1);

    // 2) ПОВЕРХНОСТЬ: отражение неба и построек, бегущие гребни, рябь дождя,
    // штрихи течения. Всё собирается в scratch и обрезается маской воды.
    const lod = this.q.lod || {};
    const animate = zoom >= (lod.waterMinZoom || 0.45) && this.freeze < 0.92;
    if (animate) this._surface(sim, ctx, ox, oy, z, light);

    // 3) ПЕНА: две испечённые фазы прибоя в перекрёстном затухании — волна
    // набегает на берег и откатывается.
    if (this.q.shoreFoam && zoom >= (lod.foamMinZoom || 0.55) && this.freeze < 0.8) {
      const k = 0.5 + 0.5 * Math.sin(this.time * 0.85);
      const amp = (1 - this.freeze) * (0.72 + 0.34 * this.rain);
      this._blit(ctx, this.foamA, ox, oy, z, S, amp * k);
      this._blit(ctx, this.foamB, ox, oy, z, S, amp * (1 - k));
    }

    // 4) ЛЁД: зимой вода встаёт. Трещины и надувы снега испечены вместе с ним.
    if (this.freeze > 0.01 && this.ice) this._blit(ctx, this.ice, ox, oy, z, S, this.freeze);

    ctx.imageSmoothingEnabled = prevSmooth;
  }

  // Дождь набирается быстро, спадает медленно; лёд — по дню внутри зимы.
  _trackWeather(sim, dt) {
    if (!sim) return;
    const wet = sim.weather === 'rain' ? 1 : 0;
    this.rain = clamp01(this.rain + Math.max(-dt / 6, Math.min(dt / 2, wet - this.rain)));
    let f = 0;
    if (sim.seasonIdx === 3) {
      // Зима длится DAYS_PER_SEASON дней: лёд встаёт за первую неделю и
      // вскрывается в последние дни. Без этого озеро замерзает мгновенно
      // в момент смены сезона — читается как ошибка отрисовки.
      const d = ((sim.day | 0) % DAYS_PER_SEASON + DAYS_PER_SEASON) % DAYS_PER_SEASON;
      f = clamp01((d - 2) / 6) * clamp01((DAYS_PER_SEASON - 2 - d) / 4);
      if (sim.weather === 'snow') f = Math.min(1, f * 1.12);
    }
    this.freeze += (f - this.freeze) * Math.min(1, dt * 0.5);
    if (this.freeze < 0.004) this.freeze = 0;
  }

  // =========================================================================
  // ПОДГОТОВКА
  // =========================================================================
  ensure(sim) {
    const world = sim.world;
    if (this.fieldSeed !== world.seed || this.W !== world.w || this.H !== world.h) {
      this._buildField(world);
      this.fieldSeed = world.seed;
      this.bakeKey = null; this.iceKey = null;
    }
    const S = SUBRES[this.q.id] || 0;
    if (!S) { this.off = true; return; }
    const key = `${S}|${sim.seasonIdx}|${this.q.detail}`;
    if (key !== this.bakeKey) {
      this.S = S;
      this._bake(sim);
      this.bakeKey = key;
      this.ice = null; this.iceKey = null;
      this._sc = null; this._mx = null;
    }
    // Лёд печётся только когда он действительно нужен: за три сезона из
    // четырёх этот канвас вообще не существует.
    if (this.freeze > 0.01 && this.iceKey !== key) { this._bakeIce(sim); this.iceKey = key; }
  }

  // ---- поле: знаковое расстояние, нормаль кромки, течение --------------
  _buildField(world) {
    const W = world.w, H = world.h, N = W * H;
    this.W = W; this.H = H;
    this.seed = (world.seed | 0) || 12345;

    const wet = new Uint8Array(N), dry = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const w = isWet(world.tiles[i]) ? 1 : 0;
      wet[i] = w; dry[i] = w ^ 1;
    }
    // Расстояние до суши считаем от воды, до воды — от суши, и склеиваем в
    // одно знаковое поле. Кромка проходит ровно посередине между центрами
    // соседних клеток, поэтому вычитается половина тайла.
    const toLand = chamfer(W, H, dry);
    const toWater = chamfer(W, H, wet);
    const sd = new Float32Array(N);
    for (let i = 0; i < N; i++) sd[i] = wet[i] ? toLand[i] - 0.5 : -(toWater[i] - 0.5);
    this.sd = sd;

    // Доля «глубокой» воды, сглаженная 3×3: озеро на мелководье не должно
    // резко чернеть на границе тайлов DEEP и WATER.
    const deep = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          s += world.tiles[yy * W + xx] === TILE.DEEP ? 1 : 0; n++;
        }
        deep[y * W + x] = n ? s / n : 0;
      }
    }
    this.deepK = deep;

    // Нормаль кромки — градиент sd. Единичный, смотрит из суши в воду.
    const gx = new Float32Array(N), gy = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const l = sd[y * W + Math.max(0, x - 1)], r = sd[y * W + Math.min(W - 1, x + 1)];
        const u = sd[Math.max(0, y - 1) * W + x], d = sd[Math.min(H - 1, y + 1) * W + x];
        let ax = (r - l) * 0.5, ay = (d - u) * 0.5;
        const len = Math.hypot(ax, ay);
        if (len > 1e-4) { ax /= len; ay /= len; } else { ax = 0; ay = 0; }
        gx[i] = ax; gy[i] = ay;
      }
    }
    this.gx = gx; this.gy = gy;

    this._buildFlow(world);
    this._buildBlocks(wet);
  }

  // ---- течение ----------------------------------------------------------
  // Река отличается от озера не цветом, а тем, что она УЗКАЯ И ДЛИННАЯ:
  // sd вдоль всего русла остаётся маленьким. Направление русла — это
  // направление, вдоль которого поле расстояния меняется меньше всего, то есть
  // собственный вектор наименьшего собственного числа структурного тензора
  // градиента. Знак («куда течёт») решается эвристикой: реки уходят к морю,
  // а море в этой генерации — по краю карты, значит от центра наружу.
  _buildFlow(world) {
    const W = this.W, H = this.H, N = W * H;
    const sd = this.sd, gx = this.gx, gy = this.gy;
    const fx = new Float32Array(N), fy = new Float32Array(N);
    const cx = W * 0.5, cy = H * 0.5;
    const river = world.river || null;   // worldgen2, если он подключён
    let any = false;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (sd[i] <= 0) continue;
        // Русло шире пяти клеток течением уже не читается — это залив.
        const narrow = clamp01((3.0 - sd[i]) / 2.2);
        if (narrow <= 0.02 && !(river && river[i])) continue;

        // Структурный тензор градиента по окну 5×5.
        let a = 0, b = 0, c = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= W) continue;
            const j = yy * W + xx;
            if (sd[j] <= -0.6) continue;
            const wgt = 1 / (1 + dx * dx + dy * dy);
            a += gx[j] * gx[j] * wgt; b += gx[j] * gy[j] * wgt; c += gy[j] * gy[j] * wgt;
          }
        }
        // Меньшее собственное число и его вектор.
        const tr = a + c, det = Math.sqrt(Math.max(0, (a - c) * (a - c) + 4 * b * b));
        const lo = (tr - det) * 0.5;
        let vx = b, vy = lo - a;
        if (Math.hypot(vx, vy) < 1e-4) { vx = lo - c; vy = b; }
        const vl = Math.hypot(vx, vy);
        if (vl < 1e-4) continue;
        vx /= vl; vy /= vl;

        // Знак: наружу от центра карты. Если ось почти перпендикулярна
        // радиусу (русло идёт по кругу), берём восток — лишь бы соседние
        // клетки выбрали одно и то же, иначе течение рвётся на куски.
        let ox = x + 0.5 - cx, oy = y + 0.5 - cy;
        const ol = Math.hypot(ox, oy) || 1;
        ox /= ol; oy /= ol;
        let dot = vx * ox + vy * oy;
        if (Math.abs(dot) < 0.12) dot = vx !== 0 ? vx : vy;
        if (dot < 0) { vx = -vx; vy = -vy; }

        const strength = river && river[i] ? Math.max(0.55, narrow) : narrow * 0.85;
        fx[i] = vx * strength; fy[i] = vy * strength;
        if (strength > 0.15) any = true;
      }
    }

    // Одно сглаживание с выравниванием знака: убирает одиночные клетки,
    // где тензор выбрал ось поперёк соседей.
    const sx = new Float32Array(N), sy = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!fx[i] && !fy[i]) continue;
        let ax = 0, ay = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= W) continue;
            const j = yy * W + xx;
            if (!fx[j] && !fy[j]) continue;
            const s = (fx[j] * fx[i] + fy[j] * fy[i]) < 0 ? -1 : 1;
            ax += fx[j] * s; ay += fy[j] * s;
          }
        }
        const l = Math.hypot(ax, ay);
        if (l > 1e-4) {
          const m = Math.hypot(fx[i], fy[i]);
          sx[i] = ax / l * m; sy[i] = ay / l * m;
        }
      }
    }
    this.fx = sx; this.fy = sy; this.hasFlow = any;
  }

  // ---- индекс блоков: где вода вообще есть ------------------------------
  _buildBlocks(wet) {
    const W = this.W, H = this.H;
    const bw = Math.ceil(W / BLK), bh = Math.ceil(H / BLK);
    const b = new Uint8Array(bw * bh);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!wet[y * W + x]) continue;
        b[((y / BLK) | 0) * bw + ((x / BLK) | 0)] = 1;
      }
    }
    // Кромка гуляет по шуму почти на треть клетки и может выйти за блок —
    // расширяем индекс на один блок во все стороны, иначе у края блока
    // появится обрезанный берег.
    const g = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        if (!b[y * bw + x]) continue;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
          g[yy * bw + xx] = 1;
        }
      }
    }
    this.blocks = g; this.bw = bw; this.bh = bh;
  }

  // =========================================================================
  // ВЫПЕЧКА
  // =========================================================================
  _bake(sim) {
    if (typeof document === 'undefined') return;
    const W = this.W, H = this.H, S = this.S;
    const mw = W * S, mh = H * S;
    const pal = TERRAIN[sim.seasonIdx] || TERRAIN[0];

    // Палитра воды строится из палитры местности, чтобы вода не выпадала из
    // сезона: зимой она стальная, летом тёплая. Правило контраста из
    // арт-дирекции §2.2 — мелководье получает цвет дна, а не свой собственный.
    const wCol = hex2rgb(pal[TILE.WATER].base);
    const dCol = hex2rgb(pal[TILE.DEEP].base);
    const sCol = hex2rgb(pal[TILE.SAND].base);
    const shallow = [
      lerp(wCol[0], sCol[0], 0.46), lerp(wCol[1], sCol[1], 0.42), lerp(wCol[2], sCol[2], 0.30),
    ];
    const midC = [wCol[0] * 0.96, wCol[1] * 0.97, wCol[2] * 1.0];
    const deepC = [dCol[0] * 0.88, dCol[1] * 0.9, dCol[2] * 0.96];
    // Мокрый песок на суше у самой воды: он прячет прямые отрезки прибоя,
    // испечённые terrain.edges по сторонам клеток.
    const wetSand = [sCol[0] * 0.62, sCol[1] * 0.6, sCol[2] * 0.58];

    // Волнистость берега: два масштаба — крупные бухты и мелкая изрезанность.
    // Считается на решётке вдвое мельче тайла и потом интерполируется:
    // 37 тысяч вызовов шума вместо трёхсот тысяч.
    const gw = W * 2 + 1, gh = H * 2 + 1;
    const wob = new Float32Array(gw * gh);
    const so = (this.seed % 997) * 0.37;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const wx = x * 0.5 + so, wy = y * 0.5 + so;
        wob[y * gw + x] = (fbm2(wx * 0.9, wy * 0.9) - 0.5) * 1.25 + (fbm2(wx * 3.1 + 40, wy * 3.1 + 40) - 0.5) * 0.75;
      }
    }

    const base = document.createElement('canvas'); base.width = mw; base.height = mh;
    const foamA = document.createElement('canvas'); foamA.width = mw; foamA.height = mh;
    const foamB = document.createElement('canvas'); foamB.width = mw; foamB.height = mh;
    const bc = base.getContext('2d'), fa = foamA.getContext('2d'), fb = foamB.getContext('2d');
    const iBase = bc.createImageData(mw, mh);
    const iA = fa.createImageData(mw, mh);
    const iB = fb.createImageData(mw, mh);
    const pB = iBase.data, pA = iA.data, pC = iB.data;

    const inv = 1 / S;
    const SUNX = 0.7071, SUNY = 0.7071;   // тень падает вправо-вниз (свет сверху-слева)
    const detail = this.q.detail;

    for (let py = 0; py < mh; py++) {
      const wy = (py + 0.5) * inv;
      for (let px = 0; px < mw; px++) {
        const wx = (px + 0.5) * inv;
        const o = (py * mw + px) * 4;
        const d0 = this._sample(this.sd, wx, wy);
        // Далеко от берега вглубь суши считать нечего — там ни воды, ни пены.
        if (d0 < -1.4) continue;
        const wb = this._grid(wob, gw, gh, wx * 2, wy * 2);
        const d = d0 + wb * 0.34;

        if (d < 0) {
          // Суша у кромки: мокрый песок узкой полосой.
          const k = smooth(1 + d / 0.42);
          if (k > 0.01) {
            pB[o] = wetSand[0]; pB[o + 1] = wetSand[1]; pB[o + 2] = wetSand[2];
            pB[o + 3] = k * 88;
          }
          continue;
        }

        // --- цвет по глубине ---------------------------------------------
        const dp = this._sample(this.deepK, wx, wy);
        const shelf = smooth(d / 1.15);                 // отмель → вода
        const abyss = smooth((d - 1.6) / 3.4) * 0.62 + dp * 0.38;
        let r = lerp(shallow[0], midC[0], shelf);
        let g = lerp(shallow[1], midC[1], shelf);
        let b = lerp(shallow[2], midC[2], shelf);
        r = lerp(r, deepC[0], abyss); g = lerp(g, deepC[1], abyss); b = lerp(b, deepC[2], abyss);

        // Дно у кромки: пятна светлого песка сквозь воду. Только там, где
        // мелко, и только на detail ≥ 1 — на medium это лишние 300 тысяч
        // вызовов шума в выпечке.
        if (detail >= 1 && shelf < 0.85) {
          const bot = (this._grid(wob, gw, gh, wx * 2 + 13, wy * 2 + 7) * 0.5 + 0.5);
          const k = (1 - shelf) * 0.20 * bot;
          r = lerp(r, sCol[0], k); g = lerp(g, sCol[1], k); b = lerp(b, sCol[2], k);
        }

        // Тень берега: суша, стоящая между солнцем и водой, кладёт на неё
        // тень. Нормаль кромки уже посчитана, остаётся скалярное произведение.
        if (d < 1.6) {
          const nx = this._sample(this.gx, wx, wy), ny = this._sample(this.gy, wx, wy);
          const face = nx * SUNX + ny * SUNY;
          if (face > 0) {
            const sh = face * (1 - smooth(d / 1.6)) * 0.34;
            r *= 1 - sh; g *= 1 - sh; b *= 1 - sh * 0.86;
          }
        }

        // Прозрачность: у самой кромки дно просвечивает (§2.4 арт-дирекции),
        // на глубине вода непрозрачна. Плюс полпикселя сглаживания по краю.
        const edge = clamp01(d / (0.9 * inv + 0.001));
        const alpha = (0.60 + 0.40 * smooth(d / 1.0)) * Math.min(1, edge);
        pB[o] = r; pB[o + 1] = g; pB[o + 2] = b; pB[o + 3] = alpha * 255;

        // --- пена ---------------------------------------------------------
        // Полоса вдоль кромки. Гребёнка вдоль берега (scal) делает её
        // фестончатой, а не ровной каймой; две фазы отличаются положением
        // полосы и фазой гребёнки — прибой набегает и откатывается.
        if (d < 1.25) {
          const scal = this._grid(wob, gw, gh, wx * 2 + 61, wy * 2 + 29);
          const aA = foamBand(d, 0.10 + scal * 0.10, 0.30);
          const aB = foamBand(d, 0.34 + scal * 0.16, 0.40);
          if (aA > 0.01) { pA[o] = 236; pA[o + 1] = 246; pA[o + 2] = 255; pA[o + 3] = aA * 210; }
          if (aB > 0.01) { pC[o] = 226; pC[o + 1] = 240; pC[o + 2] = 252; pC[o + 3] = aB * 170; }
        }
      }
    }
    bc.putImageData(iBase, 0, 0);
    fa.putImageData(iA, 0, 0);
    fb.putImageData(iB, 0, 0);
    this.base = base; this.foamA = foamA; this.foamB = foamB;

    // Направление бега волн: пара целых, иначе плитка гребней перестанет
    // сходиться сама с собой и по воде побегут швы.
    const dirs = [[1, 4], [2, 5], [-1, 4], [-2, 5], [1, 3], [-1, 3]];
    this.waveDir = dirs[(this.seed >>> 3) % dirs.length];
    this._wave = null; this._chop = null; this._drops = null;
    this._patW = null; this._patC = null; this._patD = null;
  }

  // ---- лёд --------------------------------------------------------------
  _bakeIce(sim) {
    if (typeof document === 'undefined' || !this.base) return;
    const W = this.W, H = this.H, S = this.S;
    const mw = W * S, mh = H * S;
    const cv = document.createElement('canvas'); cv.width = mw; cv.height = mh;
    const c = cv.getContext('2d');
    const img = c.createImageData(mw, mh);
    const p = img.data;
    const gw = W * 2 + 1, gh = H * 2 + 1;
    const inv = 1 / S;
    const rnd = makeRnd(this.seed ^ 0x1ce);

    for (let py = 0; py < mh; py++) {
      const wy = (py + 0.5) * inv;
      for (let px = 0; px < mw; px++) {
        const wx = (px + 0.5) * inv;
        const d = this._sample(this.sd, wx, wy);
        if (d < 0.02) continue;
        const o = (py * mw + px) * 4;
        // Полынья: на большой глубине лёд не встаёт сплошняком, остаются
        // тёмные разводья. Их форма — тот же шум, что и у берега.
        const n = fbm2(wx * 1.3 + 300, wy * 1.3 + 300);
        const open = clamp01((d - 3.2) / 3.0) * clamp01((n - 0.42) * 4.5);
        // К берегу лёд толще и белее, на глубине — синее и тоньше.
        const near = 1 - smooth((d - 0.3) / 4.0);
        const r = lerp(176, 226, near), g = lerp(200, 238, near), b = lerp(216, 246, near);
        const a = (0.86 - open * 0.8) * Math.min(1, d / (0.7 * inv + 0.001));
        if (a <= 0.01) continue;
        // Снежная крупа поверх льда: слабая пестрота, иначе лёд читается
        // как кусок пластика.
        const gr = 0.94 + fbm2(wx * 5.5 + 90, wy * 5.5 + 90) * 0.12;
        p[o] = r * gr; p[o + 1] = g * gr; p[o + 2] = b * gr; p[o + 3] = a * 255;
      }
    }
    c.putImageData(img, 0, 0);

    // Трещины. source-atop — чтобы линии легли строго на уже нарисованный
    // лёд и не вылезли на сушу ни одним пикселем.
    c.save();
    c.globalCompositeOperation = 'source-atop';
    c.lineCap = 'round';
    const tries = Math.round(W * H / 90);
    for (let t = 0; t < tries; t++) {
      let x = rnd() * W, y = rnd() * H;
      if (this._sample(this.sd, x, y) < 1.2) continue;
      let ang = rnd() * 6.283;
      const segs = 3 + ((rnd() * 5) | 0);
      c.strokeStyle = `rgba(250,253,255,${0.20 + rnd() * 0.24})`;
      c.lineWidth = Math.max(1, S * (0.05 + rnd() * 0.06));
      c.beginPath();
      c.moveTo(x * S, y * S);
      for (let i = 0; i < segs; i++) {
        ang += (rnd() - 0.5) * 1.1;
        const len = 0.7 + rnd() * 1.8;
        x += Math.cos(ang) * len; y += Math.sin(ang) * len;
        c.lineTo(x * S, y * S);
      }
      c.stroke();
      // Тонкая тёмная спутница — трещина имеет глубину.
      c.strokeStyle = 'rgba(96,130,160,0.20)';
      c.lineWidth = Math.max(1, S * 0.04);
      c.stroke();
    }
    c.restore();
    this.ice = cv;
  }

  // =========================================================================
  // КАДР
  // =========================================================================
  // Полосы блоков с водой в видимом прямоугольнике. Одна полоса на ряд
  // блоков — это максимум 12 блитов на слой вместо 144 и без единого
  // полноэкранного прохода там, где воды нет.
  _collectSpans(ox, oy, z, cw, ch) {
    const W = this.W, H = this.H;
    const tx0 = Math.max(0, Math.floor(-ox / z) - 1);
    const tx1 = Math.min(W - 1, Math.ceil((cw - ox) / z) + 1);
    const ty0 = Math.max(0, Math.floor(-oy / z) - 1);
    const ty1 = Math.min(H - 1, Math.ceil((ch - oy) / z) + 1);
    this._nSpans = 0;
    if (tx1 < tx0 || ty1 < ty0) return 0;
    const b0x = (tx0 / BLK) | 0, b1x = (tx1 / BLK) | 0;
    const b0y = (ty0 / BLK) | 0, b1y = (ty1 / BLK) | 0;
    let n = 0;
    for (let by = b0y; by <= b1y; by++) {
      let lo = -1, hi = -1;
      for (let bx = b0x; bx <= b1x; bx++) {
        if (!this.blocks[by * this.bw + bx]) continue;
        if (lo < 0) lo = bx;
        hi = bx;
      }
      if (lo < 0) continue;
      const s = this._spans[n] || (this._spans[n] = { x0: 0, y0: 0, x1: 0, y1: 0 });
      s.x0 = Math.max(tx0, lo * BLK);
      s.x1 = Math.min(tx1, (hi + 1) * BLK - 1);
      s.y0 = Math.max(ty0, by * BLK);
      s.y1 = Math.min(ty1, (by + 1) * BLK - 1);
      n++;
    }
    this._nSpans = n;
    return n;
  }

  // Блит полос из карты воды на экран. Границы округляются к целым: соседние
  // полосы делят один и тот же край, поэтому между ними нет ни щели, ни
  // двойного наложения полупрозрачной воды.
  _blit(ctx, src, ox, oy, z, S, alpha) {
    if (!src || alpha <= 0.004) return;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * Math.min(1, alpha);
    for (let i = 0; i < this._nSpans; i++) {
      const s = this._spans[i];
      const dx = Math.round(ox + s.x0 * z), dx2 = Math.round(ox + (s.x1 + 1) * z);
      const dy = Math.round(oy + s.y0 * z), dy2 = Math.round(oy + (s.y1 + 1) * z);
      if (dx2 <= dx || dy2 <= dy) continue;
      ctx.drawImage(src, s.x0 * S, s.y0 * S, (s.x1 + 1 - s.x0) * S, (s.y1 + 1 - s.y0) * S,
        dx, dy, dx2 - dx, dy2 - dy);
    }
    ctx.globalAlpha = prev;
  }

  // ---- поверхность: небо, гребни, дождь, отражения, течение -------------
  _surface(sim, ctx, ox, oy, z, L) {
    const S = this.S;
    // Общий прямоугольник всех полос — в нём и работаем.
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < this._nSpans; i++) {
      const s = this._spans[i];
      if (s.x0 < x0) x0 = s.x0; if (s.y0 < y0) y0 = s.y0;
      if (s.x1 > x1) x1 = s.x1; if (s.y1 > y1) y1 = s.y1;
    }
    const rx = x0 * S, ry = y0 * S, rw = (x1 + 1 - x0) * S, rh = (y1 + 1 - y0) * S;
    if (rw <= 0 || rh <= 0) return;
    // Дальний зум: площадь сборки выросла выше потолка — анимацию снимаем,
    // статичный слой и пена остаются. Так дальний зум не становится самым
    // дорогим кадром в игре (§7.2 аудита).
    if (rw * rh > SURF_CAP) return;

    const sc = this._scratch();
    if (!sc) return;
    const s = this._scx;
    s.save();
    s.beginPath(); s.rect(rx, ry, rw, rh); s.clip();
    s.clearRect(rx, ry, rw, rh);

    const night = clamp01((1 - L.mul) / 0.58);
    // 1) Отражение неба — ровный тон цвета неба этого часа. Именно он делает
    // воду на закате оранжевой, а в грозу свинцовой, без единой заливки экрана.
    const sky = hex2rgb(L.sky);
    s.globalCompositeOperation = 'source-over';
    s.globalAlpha = 0.30 + 0.16 * (1 - night);
    s.fillStyle = `rgb(${sky[0] | 0},${sky[1] | 0},${sky[2] | 0})`;
    s.fillRect(rx, ry, rw, rh);

    // 2) Отражения построек у кромки.
    this._reflections(sim, s, rx, ry, rw, rh, L);

    // 3) Гребни. Копятся в отдельном канвасе как яркость, там же красятся
    //    цветом солнца этого часа и одним куском ложатся на воду.
    this._crests(s, rx, ry, rw, rh, L, night);

    // 4) Штрихи течения — только там, где русло узкое.
    if (this.hasFlow) this._flowDashes(s, x0, y0, x1, y1, L);

    // 5) Обрезка по форме воды: маска — альфа статичного слоя, поэтому
    //    поверхность гаснет ровно там же, где вода становится прозрачной.
    s.globalCompositeOperation = 'destination-in';
    s.globalAlpha = 1;
    s.drawImage(this.base, rx, ry, rw, rh, rx, ry, rw, rh);
    s.restore();

    this._blit(ctx, sc, ox, oy, z, S, 1);
  }

  _crests(s, rx, ry, rw, rh, L, night) {
    const m = this._mixer();
    if (!m) return;
    const mc = this._mxx;
    const t = this.time;
    const [ax, ay] = this.waveDir;
    const al = Math.hypot(ax, ay) || 1;
    const S = this.S;

    mc.save();
    mc.beginPath(); mc.rect(rx, ry, rw, rh); mc.clip();
    mc.clearRect(rx, ry, rw, rh);

    // Длинная зыбь: медленно, крупно. Масштаб задан в пикселях выпечки,
    // поэтому волна привязана к миру и не «плывёт» при зуме.
    this._pattern(mc, this._patW || (this._patW = mc.createPattern(this._waveTex(), 'repeat')),
      rx, ry, rw, rh, -ax / al * t * S * 0.34, -ay / al * t * S * 0.34, 'source-over', 1);
    // Мелкая рябь: быстрее, поперёк зыби — вместе они и дают ощущение
    // бегущего нормаля, хотя нарисованы двумя заливками паттернами.
    this._pattern(mc, this._patC || (this._patC = mc.createPattern(this._chopTex(), 'repeat')),
      rx, ry, rw, rh, -ay / al * t * S * 0.62, ax / al * t * S * 0.62, 'lighter', 1);
    // Рябь от дождя: частая изотропная сыпь поверх волн. Дополняет круги из
    // weather.js — те показывают отдельные капли, эта — общую шероховатость.
    if (this.rain > 0.02) {
      this._pattern(mc, this._patD || (this._patD = mc.createPattern(this._dropTex(), 'repeat')),
        rx, ry, rw, rh, (t * 13) % 64, (t * 7) % 64, 'lighter', this.rain * 0.85);
    }

    // Красим накопленную яркость цветом света этого часа: днём белым,
    // на закате тёплым, ночью холодным.
    const warm = clamp01(L.tint[0] - L.tint[2]) > 0 ? L.tint : null;
    let cr = 244, cg = 250, cb = 255;
    if (warm && warm[3] > 0.05 && night < 0.6) {
      cr = lerp(244, warm[0], 0.55); cg = lerp(250, warm[1], 0.5); cb = lerp(255, warm[2], 0.45);
    } else if (night > 0.4) {
      cr = 168; cg = 196; cb = 236;
    }
    mc.globalCompositeOperation = 'source-in';
    mc.globalAlpha = 1;
    mc.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
    mc.fillRect(rx, ry, rw, rh);
    mc.restore();

    s.globalCompositeOperation = 'lighter';
    // Лёд глушит блики, дождь сбивает гребни в мелкую сечку.
    s.globalAlpha = (0.62 - 0.2 * this.rain) * (1 - this.freeze) * (0.55 + 0.45 * L.mul);
    s.drawImage(m, rx, ry, rw, rh, rx, ry, rw, rh);
    s.globalCompositeOperation = 'source-over';
    s.globalAlpha = 1;
  }

  _pattern(c, pat, rx, ry, rw, rh, offx, offy, op, alpha) {
    if (!pat) return;
    const N = WAVE_TEX;
    const dx = ((offx % N) + N) % N, dy = ((offy % N) + N) % N;
    c.save();
    c.globalCompositeOperation = op;
    c.globalAlpha = alpha;
    c.translate(dx, dy);
    c.fillStyle = pat;
    c.fillRect(rx - dx, ry - dy, rw, rh);
    c.restore();
  }

  // Отражение построек: перевёрнутое, вдвое сплющенное, разрезанное на
  // горизонтальные ломти, которые слегка расходятся по времени — вода
  // качается. Отражается только то, у чего вода СНИЗУ: здание рисуется
  // стоящим, и отражение может идти лишь вниз по экрану.
  _reflections(sim, s, rx, ry, rw, rh, L) {
    const S = this.S;
    const buildings = sim.buildings;
    if (!buildings || !buildings.length) return;
    const x0 = rx / S, y0 = ry / S, x1 = (rx + rw) / S, y1 = (ry + rh) / S;
    let drawn = 0;
    const cap = this.q.detail >= 2 ? 14 : 8;
    s.globalCompositeOperation = 'source-over';
    for (let i = 0; i < buildings.length && drawn < cap; i++) {
      const b = buildings[i];
      if (b.destroyed || !b.done) continue;
      const size = b.size || 1;
      const cx = b.x + size * 0.5, foot = b.y + size;
      if (cx < x0 - 2 || cx > x1 + 2 || foot < y0 - 2 || foot > y1 + 3) continue;
      // Вода прямо под фасадом — иначе отражению неоткуда взяться.
      if (this._sample(this.sd, cx, foot + 0.55) < 0.15) continue;
      drawn++;

      const era = Math.min(9, Math.max(0, BUILDING_ERA_IDX[b.id] ?? (sim.eraIndex | 0)));
      const pal = ERA_PALETTE[era];
      const w = size * S, h = size * S * 1.15;
      const px = b.x * S, py = foot * S;
      const wob = Math.sin(this.time * 1.3 + b.x * 0.7 + b.y * 0.4);
      // Три ломтя: дальний от берега — цвет крыши, ближний — цвет стены.
      const cols = [pal.roof, pal.wall, pal.wall];
      for (let k = 0; k < 3; k++) {
        const t0 = k / 3, t1 = (k + 1) / 3;
        const sy = py + h * t0 * 0.5, sh = h * (t1 - t0) * 0.5;
        const shift = Math.sin(this.time * 1.6 + k * 1.7 + b.y) * S * 0.12 + wob * S * 0.06;
        s.globalAlpha = 0.26 * (1 - t0 * 0.55);
        s.fillStyle = cols[k];
        s.fillRect(px + shift, sy, w, sh + 0.6);
      }
      // Ночью отражается не силуэт, а свет окон — тёплая дорожка на воде.
      if (L.glow > 0.12) {
        s.globalAlpha = 0.34 * L.glow;
        s.fillStyle = pal.glow;
        s.fillRect(px + w * 0.3 + wob * S * 0.1, py, w * 0.4, h * 0.55);
      }
    }
    s.globalAlpha = 1;
  }

  // Штрихи течения: короткие светлые чёрточки, сносимые вдоль русла. Все
  // рисуются одним путём на три уровня прозрачности — три вызова stroke
  // на всю реку, а не по вызову на клетку.
  _flowDashes(s, tx0, ty0, tx1, ty1, L) {
    const S = this.S, W = this.W;
    const fx = this.fx, fy = this.fy;
    const t = this.time;
    const lvl = [[0.30, 0.34], [0.65, 0.5], [1.0, 0.28]];
    s.lineCap = 'round';
    s.lineWidth = Math.max(1, S * 0.16);
    s.globalCompositeOperation = 'lighter';
    for (let l = 0; l < 3; l++) {
      s.strokeStyle = `rgba(226,242,255,${lvl[l][1] * (0.4 + 0.6 * L.mul)})`;
      s.beginPath();
      let any = false;
      for (let y = ty0; y <= ty1; y++) {
        for (let x = tx0; x <= tx1; x++) {
          const i = y * W + x;
          const vx = fx[i], vy = fy[i];
          const m = Math.hypot(vx, vy);
          if (m < 0.18) continue;
          const h = hash2(x, y);
          // Каждая клетка живёт своей фазой — иначе вся река мигает разом.
          const ph = (t * (0.35 + m * 0.5) + h) % 1;
          if (ph > lvl[l][0] || (l > 0 && ph <= lvl[l - 1][0])) continue;
          const ux = vx / m, uy = vy / m;
          // Чёрточка едет по клетке вдоль течения и гаснет к концу цикла.
          const cx = (x + 0.5 + (ph - 0.5) * 1.5 * ux) * S;
          const cy = (y + 0.5 + (ph - 0.5) * 1.5 * uy) * S;
          const len = S * (0.22 + m * 0.3);
          s.moveTo(cx - ux * len, cy - uy * len);
          s.lineTo(cx + ux * len, cy + uy * len);
          any = true;
        }
      }
      if (any) s.stroke();
    }
    s.globalCompositeOperation = 'source-over';
  }

  // =========================================================================
  // ТЕКСТУРЫ И ХОЛСТЫ
  // =========================================================================
  _scratch() {
    if (this._sc) return this._sc;
    if (typeof document === 'undefined' || !this.W) return null;
    const cv = document.createElement('canvas');
    cv.width = this.W * this.S; cv.height = this.H * this.S;
    this._sc = cv; this._scx = cv.getContext('2d');
    return cv;
  }

  _mixer() {
    if (this._mx) return this._mx;
    if (typeof document === 'undefined' || !this.W) return null;
    const cv = document.createElement('canvas');
    cv.width = this.W * this.S; cv.height = this.H * this.S;
    this._mx = cv; this._mxx = cv.getContext('2d');
    return cv;
  }

  // Плитка длинной зыби. Гребни — линии постоянной фазы a·x + b·y, где a и b
  // ЦЕЛЫЕ: только тогда рисунок сходится сам с собой на границе плитки и по
  // воде не бегут швы. «Шум» тоже собран из периодических синусов — по той же
  // причине: обычный fbm2 на краю плитки разрывается.
  _waveTex() {
    if (this._wave) return this._wave;
    const N = WAVE_TEX;
    const cv = document.createElement('canvas'); cv.width = N; cv.height = N;
    const c = cv.getContext('2d');
    const img = c.createImageData(N, N);
    const p = img.data;
    const [a, b] = this.waveDir;
    const k = 6.283185 / N;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const warp = Math.sin(k * (2 * x + 1 * y) + 1.7) * 5.5 + Math.sin(k * (1 * x - 3 * y) + 0.4) * 3.5;
        const v = Math.sin(k * (a * x + b * y) + warp * k * 3);
        // Гребень узкий, подошва широкая: степень 4 оставляет светлой только
        // вершину волны, как это и выглядит сверху.
        const crest = v > 0 ? Math.pow(v, 4) : 0;
        const o = (y * N + x) * 4;
        p[o] = 255; p[o + 1] = 255; p[o + 2] = 255; p[o + 3] = crest * 150;
      }
    }
    c.putImageData(img, 0, 0);
    this._wave = cv;
    return cv;
  }

  _chopTex() {
    if (this._chop) return this._chop;
    const N = WAVE_TEX;
    const cv = document.createElement('canvas'); cv.width = N; cv.height = N;
    const c = cv.getContext('2d');
    const img = c.createImageData(N, N);
    const p = img.data;
    const k = 6.283185 / N;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const v = Math.sin(k * (5 * x + 7 * y) + Math.sin(k * (3 * x - 2 * y)) * 2.2)
          * Math.sin(k * (7 * x - 4 * y) + 1.1);
        const o = (y * N + x) * 4;
        const crest = v > 0.25 ? (v - 0.25) / 0.75 : 0;
        p[o] = 255; p[o + 1] = 255; p[o + 2] = 255; p[o + 3] = crest * crest * 96;
      }
    }
    c.putImageData(img, 0, 0);
    this._chop = cv;
    return cv;
  }

  // Рябь дождя: сыпь мелких колец на решётке с дрожанием. Кольца у краёв
  // плитки дублируются на противоположную сторону, иначе на стыке видна сетка.
  _dropTex() {
    if (this._drops) return this._drops;
    const N = WAVE_TEX;
    const cv = document.createElement('canvas'); cv.width = N; cv.height = N;
    const c = cv.getContext('2d');
    const rnd = makeRnd(this.seed ^ 0x0d20b);
    c.strokeStyle = 'rgba(255,255,255,0.5)';
    const G = 8, step = N / G;
    for (let gy = 0; gy < G; gy++) {
      for (let gx = 0; gx < G; gx++) {
        const x = (gx + 0.15 + rnd() * 0.7) * step;
        const y = (gy + 0.15 + rnd() * 0.7) * step;
        const r = step * (0.16 + rnd() * 0.26);
        c.lineWidth = Math.max(1, r * 0.3);
        for (const [wx, wy] of [[0, 0], [N, 0], [-N, 0], [0, N], [0, -N]]) {
          const px = x + wx, py = y + wy;
          if (px < -r || py < -r || px > N + r || py > N + r) continue;
          c.beginPath(); c.arc(px, py, r, 0, 6.283); c.stroke();
        }
      }
    }
    this._drops = cv;
    return cv;
  }

  // =========================================================================
  // Билинейные выборки полей. Центры клеток лежат в (x+0.5, y+0.5).
  // =========================================================================
  _sample(field, wx, wy) {
    const W = this.W, H = this.H;
    let u = wx - 0.5, v = wy - 0.5;
    if (u < 0) u = 0; else if (u > W - 1) u = W - 1;
    if (v < 0) v = 0; else if (v > H - 1) v = H - 1;
    const xi = u | 0, yi = v | 0;
    const xj = xi + 1 < W ? xi + 1 : xi, yj = yi + 1 < H ? yi + 1 : yi;
    const fx = u - xi, fy = v - yi;
    const a = field[yi * W + xi], b = field[yi * W + xj];
    const c = field[yj * W + xi], d = field[yj * W + xj];
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  }

  _grid(g, gw, gh, u, v) {
    if (u < 0) u = 0; else if (u > gw - 1) u = gw - 1;
    if (v < 0) v = 0; else if (v > gh - 1) v = gh - 1;
    const xi = u | 0, yi = v | 0;
    const xj = xi + 1 < gw ? xi + 1 : xi, yj = yi + 1 < gh ? yi + 1 : yi;
    const fx = u - xi, fy = v - yi;
    const a = g[yi * gw + xi], b = g[yi * gw + xj];
    const c = g[yj * gw + xi], d = g[yj * gw + xj];
    const t = a + (b - a) * fx, bt = c + (d - c) * fx;
    return t + (bt - t) * fy;
  }
}

// Полоса пены: колокол вокруг заданного расстояния от кромки.
function foamBand(d, center, width) {
  const k = Math.abs(d - center) / width;
  if (k >= 1) return 0;
  const v = 1 - k;
  return v * v * (3 - 2 * v);
}

/* ПОДКЛЮЧЕНИЕ */
//
// Ниже — точные строки для app/src/render/renderer.js. Сам renderer.js этим
// агентом НЕ ТРОГАЛСЯ: вставлять руками. Все якоря проверены на уникальность
// в текущей версии файла.
//
// 1) Импорт — ПОСЛЕ строки
//
//      import { Atmosphere } from './weather.js';
//
//    добавить:
//
//      import { WaterLayer } from './water.js';
//
// 2) Конструктор Renderer — ПОСЛЕ строки
//
//      this.atmo = new Atmosphere(this.quality);
//
//    добавить:
//
//      this.water = new WaterLayer(this.quality);
//
// 3) setQuality(id) — ПОСЛЕ строки
//
//      this.atmo.setQuality(this.quality);
//
//    добавить:
//
//      this.water.setQuality(this.quality);
//
//    В tuneAuto(dtReal) — ПОСЛЕ такой же строки `this.atmo.setQuality(this.quality);`
//    (она встречается в файле дважды: в setQuality и в tuneAuto — вставить в обе)
//    добавить ту же строку:
//
//      this.water.setQuality(this.quality);
//
// 4) draw() — ЗАМЕНИТЬ строку
//
//      if (this.quality.water) this.terrain.drawWater(ctx, sim, ox, oy, z, cw, ch, this.time);
//
//    на:
//
//      this.water.draw(sim, ctx, ox, oy, z, cw, ch, dtReal, L);
//
//    Метод terrain.drawWater после этого не вызывается ниоткуда: его блики
//    полностью перекрыты гребнями этого модуля, и оставлять оба — значит
//    платить дважды за одно и то же. Сам terrain.js трогать не обязательно,
//    мёртвый метод ничего не стоит.
//
// ПОРЯДОК ВАЖЕН: вода идёт сразу после terrain.draw и ДО atmo.drawGround —
// мокрая земля и круги от дождя должны лечь ПОВЕРХ воды, а не под неё. Здания
// и жители рисуются позже и остаются над водой.
//
// 5) НЕОБЯЗАТЕЛЬНО — отражение настоящими спрайтами вместо цветовых пятен.
//    В конструкторе после `this.water = new WaterLayer(this.quality);`:
//
//      this.water.spriteFor = (b) => this.sprites.building(b.id, BUILDINGS[b.id], this.eraOf(b), b.size || 1);
//
//    Хук пока не используется отрисовкой (пятна эпохи читаются на воде лучше,
//    чем уменьшенный до восьми пикселей спрайт), но поле зарезервировано:
//    если появится крупный зум с высокой водой, включать здесь.
//
// 6) Смена мира (новая игра, загрузка сейва) — там, где Renderer уже есть:
//
//      renderer.water.invalidate();
//
//    Не обязательно: модуль сам замечает смену world.seed. Строка нужна только
//    если мир подменяется БЕЗ смены сида (редактор, отладочные команды).
//
// ---------------------------------------------------------------------------
// ЧТО ПОЯВЛЯЕТСЯ В КАДРЕ БЕЗ ЕДИНОЙ ПРАВКИ В ЯДРЕ
//
//   • глубина цветом: отмель принимает цвет дна, глубина уходит в тёмно-синий,
//     переход плавный по расстоянию до берега, а не по типу клетки;
//   • изогнутый берег: кромка — линия «расстояние + шум = 0», поэтому озеро
//     перестаёт быть прямоугольником, у него появляются бухты и мысы;
//   • мокрый песок полосой по суше — он же прячет прямые отрезки прибоя,
//     испечённые terrain.edges по сторонам клеток;
//   • тень берега на воде по направлению солнца;
//   • бегущие волны: две плитки гребней со смещением от времени, длинная зыбь
//     поперёк мелкой ряби;
//   • пена у берега с учётом формы берега: фестончатая полоса, две фазы в
//     перекрёстном затухании — прибой набегает и откатывается;
//   • отражение неба (цвет воды идёт за цветом неба этого часа) и построек
//     у кромки, ночью — тёплые дорожки от окон;
//   • рябь от дождя: изотропная сыпь колец поверх волн, нарастает и спадает
//     плавно (weather.js рисует отдельные капли — эффекты дополняют друг друга);
//   • лёд зимой: встаёт за первую неделю сезона и вскрывается к весне, к берегу
//     толще и белее, на глубине разводья, поверх — трещины со снежной крупой;
//   • течение: там, где русло узкое, по воде идут короткие светлые чёрточки
//     вдоль потока. Направление русла берётся из структурного тензора поля
//     расстояний, а не из типа клетки, поэтому река читается течением даже на
//     генерации, которая про реки ничего не знает. Если подключён worldgen2
//     (world.river), его разметка усиливает эффект.
//
// ---------------------------------------------------------------------------
// ПРЕСЕТЫ И БЮДЖЕТ
//
//   eco     — модуль выключен целиком (quality.water = false): ни выпечки,
//             ни памяти, ни единого вызова в кадре.
//   medium  — S = 4 пикселя на тайл, дно у кромки без пятен (detail 0…1),
//             отражений не больше восьми.
//   high    — S = 6, полный набор.
//   ultra   — S = 8, до четырнадцати отражений.
//
// Память выпечки: три канваса W·S × H·S. Карта 96×96 при S = 6 — по 1,3 МБ,
// итого 4 МБ плюс два кадровых холста того же размера. На ultra — 7 и 4,7 МБ.
// Потолок пресета (quality.caps.textureMB) — 48 и 128 соответственно.
//
// Стоимость кадра. Ни одной полноэкранной заливки: рисуются только полосы
// блоков, в которых вода есть. На shots/map.png это 4 блока из 144, то есть
// около 3 % площади экрана. Слоёв максимум четыре (вода, поверхность, две
// фазы пены), сборка поверхности идёт в разрешении выпечки — при S = 6 это
// в 28 раз меньше пикселей, чем на экране при зуме 1.
//
// Зум: ниже quality.lod.waterMinZoom (0,45 на high) анимация снимается,
// остаётся статичный слой; ниже foamMinZoom пропадает и пена. Если площадь
// сборки превышает SURF_CAP, поверхность не собирается вовсе — это защита от
// кадра «половина океана на экране», где дальний зум иначе становится самым
// дорогим в игре (§7.2 docs/graphics-audit.md).
//
// Выпечка происходит один раз на мир и ещё раз на смену сезона: около 330 тысяч
// точек с двумя билинейными выборками каждая. Это единичный расход того же
// порядка, что выпечка одного чанка местности, и он не повторяется в кадре.
