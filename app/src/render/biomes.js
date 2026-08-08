// render/biomes.js — БИОМЫ НА ЗЕМЛЕ: своя палитра и своя фактура у каждого пояса,
// широкие мягкие переходы между соседями и залежи руд как приметы на местности.
//
// ЗАЧЕМ. Карта до сих пор красилась только по типу тайла: трава везде одна и та
// же трава, от полярного круга до экватора. Из-за этого мир читается как
// крашеная сетка, а не как местность: игрок не видит, что север — тайга, а
// центр материка — выжженная степь. Слой biome в core/systems/worldgen2.js эти
// пояса уже считает (широта → температура, удалённость от моря → влажность), но
// на экран не попадает вообще. Этот модуль его показывает.
//
// ЧТО ИМЕННО ДАЁТ МОДУЛЬ
//   1) Цвет пояса. У каждого биома собственная приглушённая палитра на четыре
//      сезона: степь выгорает к лету, тайга не меняется, джунгли всегда сочные,
//      пустыня почти не знает зимы. Цвет не заменяет палитру тайла, а
//      подмешивается к ней с разной силой: трава подхватывает пояс целиком,
//      лес и скалы — почти нет, у них своя материальная правда.
//   2) ШИРОКИЙ переход. Граница биомов не поклеточная: поле цвета сначала
//      искажается шумом (домен-варп даёт языки и вкрапления одного пояса в
//      другой), потом дважды размывается взвешенным box-blur радиуса 2. Зона
//      смешения выходит в 6–8 клеток с проникающими пятнами, а не в одну линию.
//      Вода в размытие не входит вовсе (вес 0), поэтому зелень не течёт в море,
//      а берег получает мягкое затухание сам собой.
//   3) Влажность. Слой fertility/moist подкручивает насыщенность: сырой участок
//      уходит в сочную зелень, сухой — в охру. Чувствительность у каждого биома
//      своя (степь реагирует сильно, джунгли и пустыня — почти нет).
//   4) Фактура земли. Песчаная рябь и растрескавшийся такыр в пустыне,
//      травяные кочки в степи, мох и лишайник в тундре, хвойный опад в тайге,
//      торф и сочащаяся вода на болоте, подлесок в джунглях, осыпь в гольцах.
//   5) Руды. Рыжие пятна железа, чёрные выходы угля, белая соляная корка и
//      золотые прожилки в породе — заметные приметы, по которым место на карте
//      запоминается.
//
// ЕСЛИ worldgen2 ЕЩЁ НЕ ПОДКЛЮЧЁН. Модуль не ждёт милости от ядра: когда
// world.biome отсутствует, пояса выводятся здесь же из тайлов и широты теми же
// формулами temperature/moisture, что и в worldgen2 (они экспортированы —
// берём их, а не переписываем). Мир при этом НЕ меняется: всё считанное живёт
// в этом модуле, ни один массив ядра не трогается.
//
// ПРО СЛУЧАЙНОСТЬ. Math.random запрещён, rng ядра из рендера трогать нельзя:
// каждый его вызов сдвигает состояние симуляции, а рендер идёт с разной
// частотой у разных игроков — сейв бы поплыл. Поэтому внутри свой хеш от
// world.seed (образец — weather.js и fx.js): картинка повторяема, ядро не задето.
//
// ПРО ЦЕНУ. В кадре модуль стоит ноль: всё считается один раз на мир (поле
// биомов, размытие, список залежей) и один раз на сезон (перекраска поля), а
// рисование живёт внутри выпечки чанка — там же, где терраин печёт всё
// остальное. На пресете eco фактура и пятна выключены, остаётся только цвет:
// одна drawImage на чанк.

import { TILE } from '../core/data.js';
import { BIOME, BIOMES, temperature, moisture } from '../core/systems/worldgen2.js';
import { TILE_HEIGHT, hex2rgb } from './palette.js';

// ---------------------------------------------------------------------------
// ПАЛИТРА БИОМОВ
//
// По-хорошему её место в palette.js, рядом с TERRAIN — цвет в проекте живёт в
// одном файле. Здесь она лежит ровно потому, что модуль обязан быть одним
// файлом; при слиянии таблицу надо перенести туда без изменений.
//
// Правила арт-дирекции, которым таблица подчиняется (docs/art-direction.md §2):
//   • земля приглушённая и «грязная», насыщенность заметно ниже 55 %;
//   • земля никогда не самый яркий объект кадра — самое светлое здесь зимняя
//     тундра, и она всё равно темнее снега на крышах;
//   • светлота соседних поясов расходится не более чем на четверть, иначе
//     карта распадается на пятна.
//
// g    — цвет пояса по сезонам [весна, лето, осень, зима];
// det  — основной цвет фактуры, det2 — второй (светлый);
// force— насколько пояс перебивает сезонную палитру тайла (0…1);
// sens — чувствительность к влажности (0 — не реагирует, 1 — реагирует сильно).
// ---------------------------------------------------------------------------
export const BIOME_ART = [
  // OCEAN — воду красит вода, здесь силы ноль и ничего не рисуется.
  { g: ['#1f5b86', '#1d5680', '#1f5b86', '#1a4a6b'], det: '#3d86b3', det2: '#5aa0c8', force: 0.00, sens: 0.0 },
  // COAST — намывной песок с редкой травой, ракушка.
  { g: ['#a7a072', '#b0a875', '#a89a6c', '#ccd0cd'], det: '#8d8560', det2: '#cabf95', force: 0.38, sens: 0.30 },
  // TUNDRA — мох, лишайник, камень; зимой почти целиком под снегом.
  { g: ['#8a9a86', '#93a382', '#9a9070', '#dde5e9'], det: '#75806f', det2: '#a8b49c', force: 0.58, sens: 0.25 },
  // TAIGA — тёмный хвойный тон, который НЕ МЕНЯЕТСЯ по сезонам: в этом весь смысл
  // хвойного леса. Зима отличается только лёгкой холодной примесью.
  { g: ['#3f6046', '#3d6144', '#3f5c40', '#4a6455'], det: '#2e4a36', det2: '#5b7a5c', force: 0.55, sens: 0.30 },
  // STEPPE — весной зелёная, к лету ВЫГОРАЕТ в солому, осенью седеет.
  { g: ['#7e9250', '#a89a5c', '#9a8a52', '#c0c3bb'], det: '#6f7a44', det2: '#bcb070', force: 0.50, sens: 0.80 },
  // TEMPERATE — эталон: полный годовой круг от свежей зелени до снега.
  { g: ['#5e8248', '#63864a', '#8a7440', '#c3ccc6'], det: '#4c6d3a', det2: '#7f9a58', force: 0.42, sens: 0.70 },
  // DESERT — песок и такыр; зима заметна только похолодевшим тоном.
  { g: ['#c9b483', '#d2bc86', '#c8b07c', '#cdc4ae'], det: '#b09868', det2: '#e2d2a2', force: 0.68, sens: 0.10 },
  // SAVANNA — сухая охра с рыжиной, редкие пятна зелени после дождей.
  { g: ['#95964f', '#a89150', '#9d8446', '#9e9666'], det: '#7a7440', det2: '#b8a55e', force: 0.55, sens: 0.55 },
  // TROPICS — джунгли: сочные ВСЕГДА, зима на них не действует.
  { g: ['#316c3c', '#2f6b3c', '#316a3a', '#33693c'], det: '#245a30', det2: '#4d8a4a', force: 0.72, sens: 0.15 },
  // WETLAND — пойма и болото: торф, ржавая вода, осока.
  { g: ['#4f6f4e', '#4c6b48', '#5d6440', '#8b968c'], det: '#3a4f38', det2: '#6d8a66', force: 0.55, sens: 0.40 },
  // ALPINE — гольцы: порода и щебень, цвет почти не трогаем.
  { g: ['#8a8a84', '#8d8d86', '#88857e', '#c6c9ce'], det: '#6f6f6a', det2: '#a8a8a2', force: 0.35, sens: 0.10 },
];

// Крайние тона влажности: к ним уводит слой fertility.
const LUSH = '#3d7a38';   // сырое — сочная зелень
const DRY = '#a89a68';    // сухое — выжженная охра

// Насколько тайл вообще позволяет себя перекрасить поясом. У леса и скал своя
// материальная правда: если тянуть их к цвету биома наравне с травой, лес
// перестаёт отличаться от поляны, и вся работа с силуэтами идёт насмарку.
const TILE_TAKE = {
  [TILE.DEEP]: 0.0, [TILE.WATER]: 0.0, [TILE.SAND]: 0.85,
  [TILE.GRASS]: 1.0, [TILE.FOREST]: 0.45, [TILE.HILL]: 0.70, [TILE.MOUNTAIN]: 0.30,
};

// Сила пояса в базовой заливке и в повторном мазке поверх чанка.
// Два разных числа потому, что terrain.bake между ними успевает положить свою
// «чёткую подложку» по типу тайла: без повторного мазка биом наполовину стёрся бы.
const BASE_MIX = 0.60;
const REASSERT = 0.20;

// ---------------------------------------------------------------------------
// РУДЫ. Не иконки и не значки — следы на земле, читаемые с игрового зума.
// stain — размытое пятно вокруг залежи, a/b — цвета конкретных отметин.
// ---------------------------------------------------------------------------
export const ORES = [
  { id: 'iron', ru: 'железная руда', stain: '#8c4a24', a: '#a4592f', b: '#c98a52' },
  { id: 'coal', ru: 'угольный выход', stain: '#2a282b', a: '#232227', b: '#5a565c' },
  { id: 'salt', ru: 'соляная корка', stain: '#d8d4c6', a: '#eeeade', b: '#b8b2a0' },
  { id: 'gold', ru: 'золотая жила', stain: '#7a6a30', a: '#c9a227', b: '#f0dc90' },
];
const ORE_IRON = 0, ORE_COAL = 1, ORE_SALT = 2, ORE_GOLD = 3;

// ---------------------------------------------------------------------------
// Свой детерминированный шум. Сид мира входит в хеш, поэтому две партии с
// разными сидами не получают одинаковых пятен и одинаковых залежей.
// ---------------------------------------------------------------------------
function h3(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Гладкий шум: та же решётка со сглаженной билинейной интерполяцией.
function sn(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = h3(xi, yi, s), b = h3(xi + 1, yi, s);
  const c = h3(xi, yi + 1, s), d = h3(xi + 1, yi + 1, s);
  const t = a + (b - a) * ux, u = c + (d - c) * ux;
  return t + (u - t) * uy;
}
// Две октавы: крупные языки плюс мелкая изрезанность края.
function fbm(x, y, s) { return sn(x, y, s) * 0.66 + sn(x * 2.7, y * 2.7, s ^ 0x5bf03635) * 0.34; }

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Разбор hex один раз на цвет: в горячих циклах парсить строку нельзя.
const RGB_CACHE = new Map();
function rgbOf(hex) {
  let v = RGB_CACHE.get(hex);
  if (!v) { v = hex2rgb(hex); RGB_CACHE.set(hex, v); }
  return v;
}
function css(r, g, b, a) {
  return a === undefined
    ? `rgb(${r | 0},${g | 0},${b | 0})`
    : `rgba(${r | 0},${g | 0},${b | 0},${a})`;
}

// ---------------------------------------------------------------------------
export class BiomeLayer {
  constructor(quality) {
    this.q = quality || { detail: 1, relief: true };
    this.on = false;          // есть ли что показывать (мир разобран)
    this.key = null;          // сид+размер: по нему решаем, пересчитывать ли мир
    this.season = -1;
    this.reliefOn = null;
    this.w = 0; this.h = 0; this.seed = 0;
    this.biome = null;        // Uint8Array — пояс на клетку
    this.fert = null;         // Float32Array 0..1 — влажность (fertility)
    this.src = null;          // Int32Array — искажённый шумом источник цвета
    this.edge = null;         // Uint8Array — сосед по ту сторону границы (+1), 0 = нет
    this.take = null;         // Float32Array — сколько тайл берёт от пояса
    this.fr = null; this.fg = null; this.fb = null; this.fa = null; // размытое поле
    this.low = null;          // канвас 2 px на тайл с цветом пояса и его силой
    this.ore = [];            // залежи: {x,y,r,kind,seed}
    this.oreByChunk = new Map();
  }

  setQuality(q) { if (q) this.q = q; }

  // Пересчёт по необходимости. Вызывается каждый кадр — и обязан быть почти
  // бесплатным, пока сид, размер, сезон и режим рельефа не поменялись.
  ensure(sim, quality, shade) {
    if (quality) this.q = quality;
    const world = sim && sim.world;
    if (!world || !world.tiles) { this.on = false; return; }
    const key = (world.seed >>> 0) + ':' + world.w + 'x' + world.h;
    if (key !== this.key) {
      this.key = key;
      this.buildWorld(world);
      this.season = -1;
    }
    if (!this.on) return;
    const relief = !!(this.q && this.q.relief) && !!shade;
    const season = (sim.seasonIdx | 0) & 3;
    if (this.season !== season || this.reliefOn !== relief) {
      this.season = season; this.reliefOn = relief;
      this.buildField(season, relief ? shade : null);
    }
  }

  // ---- 1. Пояса, влажность, границы, залежи: один раз на мир ----
  buildWorld(world) {
    const W = world.w | 0, H = world.h | 0, N = W * H;
    if (!(N > 0)) { this.on = false; return; }
    this.w = W; this.h = H; this.seed = world.seed >>> 0;

    // Слой биомов: берём готовый из worldgen2, если он есть, иначе выводим сами
    // теми же формулами. Массивы ядра при этом не трогаются ни в одном случае.
    const own = world.biome && world.biome.length === N;
    this.biome = own ? world.biome : this.deriveBiome(world);

    // Влажность: fertility, если ядро когда-нибудь назовёт её так, иначе moist,
    // иначе выведенная здесь. Один и тот же смысл под тремя именами.
    const fsrc = (world.fertility && world.fertility.length === N) ? world.fertility
      : (world.moist && world.moist.length === N) ? world.moist : null;
    if (fsrc) {
      const f = new Float32Array(N);
      for (let i = 0; i < N; i++) f[i] = clamp01(fsrc[i]);
      this.fert = f;
    } else if (!this.fert || this.fert.length !== N) {
      this.fert = this.deriveMoist(world);
    }

    // Сколько каждая клетка готова взять от пояса — считаем раз, а не в цикле
    // отрисовки: перекраска идёт по всей карте и по каждому чанку.
    const take = new Float32Array(N);
    for (let i = 0; i < N; i++) take[i] = TILE_TAKE[world.tiles[i]] ?? 0.6;
    this.take = take;

    // Домен-варп: цвет клетки берётся не из неё самой, а из точки, сдвинутой
    // шумом на пару клеток. Именно это превращает границу пояса в языки и
    // вкрапления — без варпа размытие даёт ровную мыльную полосу.
    const src = new Int32Array(N);
    const S = this.seed;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const wx = x + (fbm(x * 0.16 + 3.1, y * 0.16 + 7.7, S ^ 0x1f83d9ab) - 0.5) * 5.4;
        const wy = y + (fbm(x * 0.16 + 41.3, y * 0.16 + 19.5, S ^ 0x7c2b3e11) - 0.5) * 5.4;
        const sx = clamp(Math.round(wx), 0, W - 1), sy = clamp(Math.round(wy), 0, H - 1);
        src[y * W + x] = sy * W + sx;
      }
    }
    this.src = src;

    // Кромка: клетка, у которой в двух шагах лежит другой пояс. Пятна-проникания
    // рисуются только здесь, поэтому их число не зависит от площади карты.
    const edge = new Uint8Array(N);
    const b = this.biome;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const me = b[i];
        if (me === BIOME.OCEAN) continue;
        let found = 0;
        for (let k = 0; k < 4 && !found; k++) {
          const nx = x + (k === 0 ? 2 : k === 1 ? -2 : 0);
          const ny = y + (k === 2 ? 2 : k === 3 ? -2 : 0);
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nb = b[ny * W + nx];
          if (nb !== me && nb !== BIOME.OCEAN) found = nb + 1;
        }
        edge[i] = found;
      }
    }
    this.edge = edge;

    this.buildOre(world);
    this.on = true;
  }

  // ---- Пояса без worldgen2: широта, высота, удалённость от моря ----
  // Формулы temperature/moisture взяты из worldgen2 напрямую, чтобы выведенная
  // здесь карта совпадала с настоящей, когда генератор наконец подключат.
  deriveBiome(world) {
    const W = world.w, H = world.h, N = W * H, S = this.seed;
    const t = world.tiles;
    const dsea = seaDistance(t, W, H);
    const river = (world.river && world.river.length === N) ? world.river : null;
    const out = new Uint8Array(N);
    const moist = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      const lat = Math.abs((y + 0.5) / H * 2 - 1);
      for (let x = 0; x < W; x++) {
        const i = y * W + x, tile = t[i];
        const rel = Math.max(0, TILE_HEIGHT[tile] ?? 0) / 1.35;
        const nT = (sn(x * 0.06 + 401, y * 0.06 + 401, S ^ 0x2545f491) - 0.5) * 2;
        const nM = (sn(x * 0.11 + 909, y * 0.11 + 909, S ^ 0x9e3779b9) - 0.5) * 2;
        const temp = temperature(lat, rel, nT);
        const m = moisture(dsea[i], nM);
        moist[i] = m;
        out[i] = classify(tile, temp, m, rel, river ? river[i] : 0, dsea[i]);
      }
    }
    this.fert = moist;
    // Стартовая долина не имеет права оказаться пустыней или тундрой: это то же
    // правило, по которому живёт ядро (worldgen2.protectStart), и здесь оно
    // нужно, чтобы картинка не спорила с механикой стартовой поляны.
    const cx = world.startX | 0, cy = world.startY | 0;
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x, bb = out[i];
        if (bb === BIOME.DESERT || bb === BIOME.TUNDRA) out[i] = BIOME.TEMPERATE;
      }
    }
    return out;
  }

  deriveMoist(world) {
    const W = world.w, H = world.h, N = W * H, S = this.seed;
    const dsea = seaDistance(world.tiles, W, H);
    const m = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const n = (sn(x * 0.11 + 909, y * 0.11 + 909, S ^ 0x9e3779b9) - 0.5) * 2;
        m[i] = moisture(dsea[i], n);
      }
    }
    return m;
  }

  // ---- 2. Поле цвета: сезон + влажность, варп, размытие ----
  // Считается один раз на сезон. Здесь же печётся мини-канвас 2 px на тайл —
  // тот самый приём, которым terrain получает мягкие переходы задёшево.
  buildField(season, shade) {
    const W = this.w, H = this.h, N = W * H;
    const b = this.biome, f = this.fert, src = this.src;
    const lush = rgbOf(LUSH), dry = rgbOf(DRY);

    // 2.1 цвет пояса на клетку (уже с влажностью), вес = 0 на воде
    const cr = new Float32Array(N), cg = new Float32Array(N), cb = new Float32Array(N), cw = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const j = src[i];                 // цвет берём из искажённой точки
      const art = BIOME_ART[b[j]] || BIOME_ART[0];
      if (art.force <= 0) { cw[i] = 0; continue; }
      const base = rgbOf(art.g[season]);
      let r = base[0], g = base[1], bl = base[2];
      // Влажность: сырое зеленеет, сухое уходит в охру. Сила — своя у пояса.
      const k = (f ? f[j] : 0.5) - 0.5;
      const s = k * art.sens * 0.62;
      if (s > 0) { r += (lush[0] - r) * s; g += (lush[1] - g) * s; bl += (lush[2] - bl) * s; }
      else if (s < 0) { const u = -s; r += (dry[0] - r) * u; g += (dry[1] - g) * u; bl += (dry[2] - bl) * u; }
      const wgt = art.force;
      cr[i] = r * wgt; cg[i] = g * wgt; cb[i] = bl * wgt; cw[i] = wgt;
    }

    // 2.2 два прохода взвешенного box-blur радиуса 2. Вода весит ноль, поэтому
    // цвет не течёт в море, а у берега сила пояса сама собой затухает.
    const tr = new Float32Array(N), tg = new Float32Array(N), tb = new Float32Array(N), tw = new Float32Array(N);
    for (let pass = 0; pass < 2; pass++) {
      blurAxis(cr, cg, cb, cw, tr, tg, tb, tw, W, H, 2, true);
      blurAxis(tr, tg, tb, tw, cr, cg, cb, cw, W, H, 2, false);
    }

    // 2.3 нормировка: цвет = сумма/вес, сила = средний вес по окну
    const fr = new Float32Array(N), fg = new Float32Array(N), fb = new Float32Array(N), fa = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const w = cw[i];
      if (w <= 1e-4) { fa[i] = 0; continue; }
      fr[i] = cr[i] / w; fg[i] = cg[i] / w; fb[i] = cb[i] / w;
      fa[i] = clamp01(w);
    }
    this.fr = fr; this.fg = fg; this.fb = fb; this.fa = fa;

    // 2.4 мини-канвас: цвет пояса со светом и с уже применённой готовностью
    // тайла его принять. Из него чанк одним блитом получает мягкий переход.
    if (typeof document === 'undefined') { this.low = null; return; }
    const S2 = 2;
    const cv = document.createElement('canvas');
    cv.width = W * S2; cv.height = H * S2;
    const c = cv.getContext('2d');
    const img = c.createImageData(W * S2, H * S2);
    const px = img.data;
    const take = this.take;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const a = fa[i] * take[i];
        if (a <= 0.004) continue;
        const m = shade ? shade[i] : 1;
        const r = Math.min(255, fr[i] * m) | 0, g = Math.min(255, fg[i] * m) | 0, bl = Math.min(255, fb[i] * m) | 0;
        const al = Math.min(255, a * 255) | 0;
        for (let sy = 0; sy < S2; sy++) {
          for (let sx = 0; sx < S2; sx++) {
            const o = ((y * S2 + sy) * W * S2 + (x * S2 + sx)) * 4;
            px[o] = r; px[o + 1] = g; px[o + 2] = bl; px[o + 3] = al;
          }
        }
      }
    }
    c.putImageData(img, 0, 0);
    this.low = cv;
  }

  // ---- 3. Подмешивание пояса в базовую заливку карты ----
  // Вызывается из terrain.buildLow на каждый тайл: мини-карта и подложка чанков
  // получают биом ещё до того, как поверх ляжет что-либо ещё.
  tintRgb(sim, x, y, rgb) {
    if (!this.on || !this.fa) return rgb;
    const i = y * this.w + x;
    if (i < 0 || i >= this.fa.length) return rgb;
    const k = this.fa[i] * this.take[i] * BASE_MIX;
    if (k <= 0.004) return rgb;
    rgb[0] += (this.fr[i] - rgb[0]) * k;
    rgb[1] += (this.fg[i] - rgb[1]) * k;
    rgb[2] += (this.fb[i] - rgb[2]) * k;
    return rgb;
  }

  // ---- 4. Земля чанка: повтор цвета, проникающие пятна, фактура ----
  paintGround(c, sim, x0, y0, TP, chunk = 16) {
    if (!this.on) return;
    const D = this.q ? this.q.detail : 1;

    // 4.1 Один блит поля поверх «чёткой подложки» terrain: она красит клетку по
    // типу тайла и наполовину съедает пояс. Дешевле всего вернуть его тем же
    // мягким растянутым куском, а не перебором клеток.
    if (this.low) {
      const S = 2, PAD = 3;
      const sx0 = Math.max(0, x0 - PAD), sy0 = Math.max(0, y0 - PAD);
      const sx1 = Math.min(this.w, x0 + chunk + PAD), sy1 = Math.min(this.h, y0 + chunk + PAD);
      if (sx1 > sx0 && sy1 > sy0) {
        const prev = c.globalAlpha;
        c.imageSmoothingEnabled = true;
        c.imageSmoothingQuality = 'high';
        c.globalAlpha = REASSERT;
        c.drawImage(
          this.low,
          sx0 * S, sy0 * S, (sx1 - sx0) * S, (sy1 - sy0) * S,
          (sx0 - x0) * TP, (sy0 - y0) * TP, (sx1 - sx0) * TP, (sy1 - sy0) * TP,
        );
        c.globalAlpha = prev;
      }
    }
    if (D < 1) return;   // eco: цвет есть, фактуры нет — так и задумано

    const W = this.w, H = this.h, S = this.seed;
    const season = this.season;

    // 4.2 Проникающие пятна: у кромки сеем кляксы цветом СОСЕДНЕГО пояса.
    // Вместе с домен-варпом это даёт зону смешения в несколько клеток, где
    // куски одного биома заходят в другой, а не одну ровную линию по клеткам.
    for (let y = y0 - 2; y < y0 + chunk + 2; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = x0 - 2; x < x0 + chunk + 2; x++) {
        if (x < 0 || x >= W) continue;
        const i = y * W + x;
        const nb = this.edge[i];
        if (!nb) continue;
        const art = BIOME_ART[nb - 1];
        if (!art || art.force <= 0) continue;
        const take = this.take[i];
        if (take <= 0.05) continue;
        const col = rgbOf(art.g[season]);
        const n = D >= 2 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const r1 = h3(x * 7 + k, y * 13 + k * 3, S ^ 0x51ed2701);
          const r2 = h3(x * 17 + k * 5, y * 3 + k, S ^ 0x2f6b3c11);
          const r3 = h3(x * 5 + k * 11, y * 29 + k, S ^ 0x68b3f2a1);
          if (r1 < 0.38) continue;
          c.globalAlpha = (0.10 + r2 * 0.16) * take;
          c.fillStyle = css(col[0], col[1], col[2]);
          c.beginPath();
          c.ellipse(
            (x - x0) * TP + TP * (0.1 + r2 * 0.8), (y - y0) * TP + TP * (0.1 + r3 * 0.8),
            TP * (0.34 + r1 * 0.52), TP * (0.28 + r3 * 0.46), r1 * 3, 0, 7,
          );
          c.fill();
        }
      }
    }
    c.globalAlpha = 1;

    // 4.3 Фактура. Идёт по клеткам чанка с каймой в одну клетку: мазок с
    // соседней клетки должен заходить внутрь, иначе на швах чанков видна сетка.
    const tiles = sim.world.tiles;
    for (let y = y0 - 1; y <= y0 + chunk; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = x0 - 1; x <= x0 + chunk; x++) {
        if (x < 0 || x >= W) continue;
        const i = y * W + x;
        const t = tiles[i];
        if (t === TILE.WATER || t === TILE.DEEP) continue;
        if (this.take[i] <= 0.2) continue;   // на голой скале фактура биома лишняя
        this.texture(c, this.biome[i], t, x, y, (x - x0) * TP, (y - y0) * TP, TP, season, D);
      }
    }
    c.globalAlpha = 1;
  }

  // ---- Фактура одного биома на одной клетке ----
  // Каждый пояс узнаётся не только цветом, но и тем, ЧТО лежит на земле.
  texture(c, b, tile, x, y, px, py, TP, season, D) {
    const art = BIOME_ART[b];
    if (!art || art.force <= 0) return;
    const S = this.seed;
    const r1 = h3(x, y, S), r2 = h3(x + 991, y + 77, S), r3 = h3(x * 3 + 7, y * 5 + 13, S);
    // Не на каждой клетке: сплошной ковёр одинаковой плотности читается как
    // сетка, а редкая и неровная фактура — как земля.
    if (r1 > (D >= 2 ? 0.28 : 0.55)) {
      // клетка «пустая» — но у части поясов даже пустая земля должна быть
      // отмечена, иначе пояс исчезает; поэтому исключение ниже.
      if (b !== BIOME.DESERT && b !== BIOME.WETLAND && b !== BIOME.TUNDRA) return;
      if (r2 > 0.5) return;
    }
    const det = rgbOf(art.det), det2 = rgbOf(art.det2);
    const D2 = D >= 2;
    c.lineCap = 'round';

    switch (b) {
      case BIOME.DESERT: {
        // Дюнная рябь или растрескавшийся такыр — что именно, решает шум:
        // однородная пустыня на пол-карты выглядит бумагой.
        if (fbm(x * 0.7, y * 0.7, S ^ 0x11) > 0.52) {
          const n = D2 ? 2 : 1;
          for (let i = 0; i < n; i++) {
            const hy = h3(x * 19 + i * 7, y * 11 + i, S);
            const yy = py + TP * (0.2 + hy * 0.56 + i * 0.14);
            c.globalAlpha = 0.20;
            c.strokeStyle = css(det[0], det[1], det[2]);
            c.lineWidth = Math.max(1, TP * 0.05);
            c.beginPath();
            c.moveTo(px + TP * 0.06, yy + TP * 0.03);
            c.quadraticCurveTo(px + TP * 0.5, yy - TP * 0.07, px + TP * 0.94, yy + TP * 0.05);
            c.stroke();
            c.globalAlpha = 0.34;
            c.strokeStyle = css(det2[0], det2[1], det2[2]);
            c.lineWidth = Math.max(1, TP * 0.032);
            c.beginPath();
            c.moveTo(px + TP * 0.06, yy);
            c.quadraticCurveTo(px + TP * 0.5, yy - TP * 0.1, px + TP * 0.94, yy + TP * 0.02);
            c.stroke();
          }
        } else {
          // Такыр: сетка трещин по глине. Узлы разбросаны хешем, поэтому
          // многоугольники получаются разными, а не штампованными.
          c.globalAlpha = 0.26;
          c.strokeStyle = css(det[0], det[1], det[2]);
          c.lineWidth = Math.max(1, TP * 0.03);
          const cx = px + TP * (0.35 + r2 * 0.3), cy = py + TP * (0.35 + r3 * 0.3);
          const arms = D2 ? 4 : 3;
          c.beginPath();
          for (let i = 0; i < arms; i++) {
            const a = (i / arms) * 6.283 + r1 * 3;
            const len = TP * (0.3 + h3(x + i, y * 7 + i, S) * 0.4);
            c.moveTo(cx, cy);
            c.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len * 0.8);
          }
          c.stroke();
        }
        break;
      }

      case BIOME.STEPPE:
      case BIOME.SAVANNA: {
        // Кочки: приплюснутый холмик с освещённой макушкой и пучком былинок.
        // Свет — сверху-слева, как велит канон: макушка светлее левым краем.
        const n = D2 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          const hx = h3(x * 13 + i, y * 7 + i * 3, S), hy = h3(x * 5 + i * 11, y * 17 + i, S);
          const gx = px + TP * (0.14 + hx * 0.72), gy = py + TP * (0.24 + hy * 0.62);
          const rw = TP * (0.13 + hx * 0.1);
          c.globalAlpha = 0.30;
          c.fillStyle = css(det[0], det[1], det[2]);
          c.beginPath(); c.ellipse(gx, gy, rw, rw * 0.62, 0, 0, 7); c.fill();
          c.globalAlpha = 0.34;
          c.fillStyle = css(det2[0], det2[1], det2[2]);
          c.beginPath(); c.ellipse(gx - rw * 0.24, gy - rw * 0.2, rw * 0.6, rw * 0.34, -0.4, 0, 7); c.fill();
          if (D2) {
            c.globalAlpha = 0.42;
            c.strokeStyle = css(det2[0], det2[1], det2[2]);
            c.lineWidth = Math.max(1, TP * 0.028);
            for (const k of [-1, 0, 1]) {
              c.beginPath();
              c.moveTo(gx + k * rw * 0.3, gy - rw * 0.1);
              c.quadraticCurveTo(gx + k * rw * 0.5, gy - rw * 0.8, gx + k * rw * 0.9, gy - rw * 1.3);
              c.stroke();
            }
          }
        }
        // Саванна вдобавок показывает голую охру между пучками.
        if (b === BIOME.SAVANNA && r3 > 0.72) {
          c.globalAlpha = 0.18;
          c.fillStyle = css(det2[0], det2[1], det2[2]);
          c.beginPath();
          c.ellipse(px + TP * (0.2 + r1 * 0.6), py + TP * (0.25 + r2 * 0.5), TP * 0.26, TP * 0.17, r1 * 3, 0, 7);
          c.fill();
        }
        break;
      }

      case BIOME.TUNDRA: {
        // Мох подушками, лишайник пятнами, вылезающий камень. Зимой всё это
        // почти скрыто снегом — оставляем только намёк.
        const win = season === 3;
        c.globalAlpha = win ? 0.12 : 0.28;
        c.fillStyle = css(det2[0], det2[1], det2[2]);
        c.beginPath();
        c.ellipse(px + TP * (0.2 + r1 * 0.6), py + TP * (0.22 + r2 * 0.56), TP * (0.16 + r1 * 0.16), TP * (0.12 + r3 * 0.12), r2 * 3, 0, 7);
        c.fill();
        if (D2 && !win) {
          c.globalAlpha = 0.30;
          c.fillStyle = css(det[0], det[1], det[2]);
          for (let i = 0; i < 3; i++) {
            const hx = h3(x * 31 + i, y * 13 + i * 5, S), hy = h3(x * 7 + i * 3, y * 23 + i, S);
            c.beginPath();
            c.arc(px + TP * (0.12 + hx * 0.76), py + TP * (0.12 + hy * 0.76), TP * 0.035, 0, 7);
            c.fill();
          }
        }
        if (r3 > 0.84) {   // валун из-под мха, со светлой левой гранью
          const ox = px + TP * (0.25 + r1 * 0.5), oy = py + TP * (0.45 + r2 * 0.35);
          const rw = TP * (0.07 + r3 * 0.05);
          c.globalAlpha = 0.5;
          c.fillStyle = css(det[0], det[1], det[2]);
          c.beginPath(); c.ellipse(ox, oy, rw, rw * 0.72, r1 * 3, 0, 7); c.fill();
          c.globalAlpha = 0.4;
          c.fillStyle = css(det2[0], det2[1], det2[2]);
          c.beginPath(); c.ellipse(ox - rw * 0.3, oy - rw * 0.24, rw * 0.5, rw * 0.32, r1 * 3, 0, 7); c.fill();
        }
        break;
      }

      case BIOME.TAIGA: {
        // Хвойный опад: короткие тёмные штрихи в разные стороны плюс моховые
        // подушки. Земли в тайге почти не видно — она вся в иглах.
        c.globalAlpha = 0.34;
        c.strokeStyle = css(det[0], det[1], det[2]);
        c.lineWidth = Math.max(1, TP * 0.03);
        const n = D2 ? 4 : 2;
        for (let i = 0; i < n; i++) {
          const hx = h3(x * 41 + i * 3, y * 67 + i, S), hy = h3(x * 23 + i, y * 53 + i * 5, S);
          const a = h3(x * 3 + i, y * 11 + i, S) * 6.283;
          const gx = px + TP * (0.1 + hx * 0.8), gy = py + TP * (0.1 + hy * 0.8);
          c.beginPath();
          c.moveTo(gx, gy);
          c.lineTo(gx + Math.cos(a) * TP * 0.11, gy + Math.sin(a) * TP * 0.11);
          c.stroke();
        }
        if (r2 > 0.62) {
          c.globalAlpha = 0.26;
          c.fillStyle = css(det2[0], det2[1], det2[2]);
          c.beginPath();
          c.ellipse(px + TP * (0.25 + r1 * 0.5), py + TP * (0.3 + r3 * 0.45), TP * 0.17, TP * 0.12, r1 * 3, 0, 7);
          c.fill();
        }
        break;
      }

      case BIOME.TROPICS: {
        // Подлесок: наплывающие друг на друга тёмные пятна и редкие светлые
        // листья. Джунгли обязаны выглядеть плотными в любой сезон.
        c.globalAlpha = 0.30;
        c.fillStyle = css(det[0], det[1], det[2]);
        for (let i = 0; i < (D2 ? 3 : 2); i++) {
          const hx = h3(x * 11 + i * 7, y * 19 + i, S), hy = h3(x * 29 + i, y * 5 + i * 3, S);
          c.beginPath();
          c.ellipse(px + TP * (0.1 + hx * 0.8), py + TP * (0.1 + hy * 0.8),
            TP * (0.14 + hx * 0.14), TP * (0.1 + hy * 0.12), hx * 3, 0, 7);
          c.fill();
        }
        if (D2) {
          c.globalAlpha = 0.42;
          c.fillStyle = css(det2[0], det2[1], det2[2]);
          for (let i = 0; i < 2; i++) {
            const hx = h3(x * 13 + i * 5, y * 31 + i, S), hy = h3(x * 7 + i, y * 43 + i * 3, S);
            const lx = px + TP * (0.15 + hx * 0.7), ly = py + TP * (0.15 + hy * 0.7);
            c.beginPath();
            c.moveTo(lx, ly - TP * 0.07);
            c.quadraticCurveTo(lx + TP * 0.07, ly, lx, ly + TP * 0.07);
            c.quadraticCurveTo(lx - TP * 0.05, ly, lx, ly - TP * 0.07);
            c.fill();
          }
        }
        break;
      }

      case BIOME.WETLAND: {
        // Торф: тёмные мокрые пятна, поверх — блеск стоячей воды и осока.
        c.globalAlpha = 0.32;
        c.fillStyle = css(det[0], det[1], det[2]);
        c.beginPath();
        c.ellipse(px + TP * (0.2 + r1 * 0.6), py + TP * (0.2 + r2 * 0.6),
          TP * (0.2 + r1 * 0.2), TP * (0.14 + r3 * 0.16), r2 * 3, 0, 7);
        c.fill();
        if (r3 > 0.5) {   // блик стоячей воды — свет с левого верха
          c.globalAlpha = 0.20;
          c.fillStyle = season === 3 ? 'rgb(214,228,238)' : 'rgb(150,182,178)';
          c.beginPath();
          c.ellipse(px + TP * (0.28 + r2 * 0.44), py + TP * (0.3 + r1 * 0.4), TP * 0.15, TP * 0.07, -0.5, 0, 7);
          c.fill();
        }
        if (D2) {   // осока пучками
          c.globalAlpha = 0.45;
          c.strokeStyle = css(det2[0], det2[1], det2[2]);
          c.lineWidth = Math.max(1, TP * 0.028);
          const gx = px + TP * (0.2 + r2 * 0.6), gy = py + TP * (0.65 + r3 * 0.25);
          for (const k of [-1, 0, 1]) {
            c.beginPath();
            c.moveTo(gx, gy);
            c.quadraticCurveTo(gx + k * TP * 0.05, gy - TP * 0.12, gx + k * TP * 0.13, gy - TP * 0.22);
            c.stroke();
          }
        }
        break;
      }

      case BIOME.ALPINE: {
        // Осыпь: мелкий щебень и морозные трещины по плите.
        c.globalAlpha = 0.34;
        c.fillStyle = css(det[0], det[1], det[2]);
        for (let i = 0; i < (D2 ? 3 : 2); i++) {
          const hx = h3(x * 17 + i * 3, y * 7 + i, S), hy = h3(x * 5 + i, y * 37 + i * 5, S);
          c.beginPath();
          c.ellipse(px + TP * (0.12 + hx * 0.76), py + TP * (0.12 + hy * 0.76), TP * 0.04, TP * 0.03, hx * 3, 0, 7);
          c.fill();
        }
        if (D2 && r2 > 0.66) {
          c.globalAlpha = 0.24;
          c.strokeStyle = css(det2[0], det2[1], det2[2]);
          c.lineWidth = Math.max(1, TP * 0.026);
          c.beginPath();
          c.moveTo(px + TP * r1, py);
          c.lineTo(px + TP * (0.2 + r3 * 0.6), py + TP * (0.5 + r2 * 0.35));
          c.stroke();
        }
        break;
      }

      case BIOME.COAST: {
        // Намыв: крупицы песка и обломки ракушек вдоль воды.
        c.globalAlpha = 0.30;
        for (let i = 0; i < (D2 ? 3 : 2); i++) {
          const hx = h3(x * 23 + i * 5, y * 3 + i, S), hy = h3(x * 11 + i, y * 47 + i * 3, S);
          c.fillStyle = hx > 0.5 ? css(det2[0], det2[1], det2[2]) : css(det[0], det[1], det[2]);
          c.beginPath();
          c.arc(px + TP * (0.1 + hx * 0.8), py + TP * (0.1 + hy * 0.8), TP * 0.028, 0, 7);
          c.fill();
        }
        if (D2 && r1 > 0.86) {
          c.globalAlpha = 0.5;
          c.strokeStyle = css(det2[0], det2[1], det2[2]);
          c.lineWidth = Math.max(1, TP * 0.03);
          c.beginPath();
          c.arc(px + TP * (0.3 + r2 * 0.4), py + TP * (0.4 + r3 * 0.3), TP * 0.06, 0.4, 3.4);
          c.stroke();
        }
        break;
      }

      default: {
        // TEMPERATE и всё прочее: опад и низкая трава двумя тонами.
        c.globalAlpha = season === 2 ? 0.34 : 0.26;
        c.fillStyle = season === 2 ? 'rgb(150,104,52)' : css(det[0], det[1], det[2]);
        for (let i = 0; i < (D2 ? 3 : 2); i++) {
          const hx = h3(x * 41 + i * 3, y * 67 + i, S), hy = h3(x * 23 + i, y * 53 + i * 5, S);
          c.beginPath();
          c.ellipse(px + TP * (0.1 + hx * 0.8), py + TP * (0.1 + hy * 0.8), TP * 0.05, TP * 0.03, hx * 3, 0, 7);
          c.fill();
        }
        if (D2 && r2 > 0.6) {
          c.globalAlpha = 0.34;
          c.strokeStyle = css(det2[0], det2[1], det2[2]);
          c.lineWidth = Math.max(1, TP * 0.03);
          const gx = px + TP * (0.2 + r1 * 0.6), gy = py + TP * (0.55 + r3 * 0.3);
          for (const k of [-1, 1]) {
            c.beginPath();
            c.moveTo(gx, gy);
            c.quadraticCurveTo(gx + k * TP * 0.04, gy - TP * 0.07, gx + k * TP * 0.09, gy - TP * 0.13);
            c.stroke();
          }
        }
        break;
      }
    }
    c.globalAlpha = 1;
  }

  // ---- 5. Залежи руд ----
  // Кандидаты стоят на решётке 3×3 клетки, отбор — по хешу с минимальным
  // расстоянием между залежами. Всё детерминировано от сида: две партии на
  // одном сиде дают одни и те же месторождения, разные сиды — разные.
  buildOre(world) {
    this.ore = [];
    this.oreByChunk = new Map();
    const W = this.w, H = this.h, S = this.seed;
    const t = world.tiles, b = this.biome;
    // Если ядро когда-нибудь заведёт слой ore, он старше выведенного здесь.
    const layer = (world.ore && world.ore.length === W * H) ? world.ore : null;

    const cand = [];
    if (layer) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x, v = layer[i] | 0;
          if (!v) continue;
          cand.push({ x: x + 0.5, y: y + 0.5, kind: (v - 1) % ORES.length, s: h3(x, y, S) });
        }
      }
    } else {
      const STEP = 3;
      for (let gy = 0; gy * STEP < H; gy++) {
        for (let gx = 0; gx * STEP < W; gx++) {
          const jx = h3(gx * 71 + 3, gy * 29 + 7, S), jy = h3(gx * 13, gy * 91 + 5, S);
          const x = Math.min(W - 1, gx * STEP + Math.floor(jx * STEP));
          const y = Math.min(H - 1, gy * STEP + Math.floor(jy * STEP));
          const i = y * W + x;
          const kind = oreKindFor(t[i], b[i], h3(x * 5 + 1, y * 7 + 3, S ^ 0x3c6ef372));
          if (kind < 0) continue;
          cand.push({ x: x + 0.5, y: y + 0.5, kind, s: h3(gx * 17 + 5, gy * 53 + 11, S ^ 0x1b873593) });
        }
      }
    }
    cand.sort((p, q) => q.s - p.s);

    const want = clamp(Math.round(Math.sqrt(W * H) / 3), 6, 64);
    const SEP = 5;   // залежи не должны слипаться в одно рудное поле
    for (const p of cand) {
      if (this.ore.length >= want) break;
      let ok = true;
      for (const o of this.ore) {
        if (Math.abs(o.x - p.x) < SEP && Math.abs(o.y - p.y) < SEP) { ok = false; break; }
      }
      if (!ok) continue;
      const rad = 0.95 + h3(Math.round(p.x) * 3, Math.round(p.y) * 5, S ^ 0x85ebca6b) * 1.5;
      this.ore.push({ x: p.x, y: p.y, r: rad, kind: p.kind, seed: (h3(Math.round(p.x), Math.round(p.y), S) * 1e6) | 0 });
    }

    // Индекс по чанкам: чанк рисует только те залежи, которые его задевают.
    const CH = 16;
    this.ore.forEach((o, i) => {
      const c0x = Math.floor((o.x - o.r - 1) / CH), c1x = Math.floor((o.x + o.r + 1) / CH);
      const c0y = Math.floor((o.y - o.r - 1) / CH), c1y = Math.floor((o.y + o.r + 1) / CH);
      for (let cy = c0y; cy <= c1y; cy++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          const k = cx + ',' + cy;
          let cell = this.oreByChunk.get(k);
          if (!cell) { cell = []; this.oreByChunk.set(k, cell); }
          cell.push(i);
        }
      }
    });
  }

  // Рисуется ПОСЛЕ деталей местности: руда — это то, что лежит на поверхности,
  // её не должны перекрывать ни трава, ни плиты породы.
  paintOre(c, sim, x0, y0, TP, chunk = 16) {
    if (!this.on || !this.ore.length) return;
    const cell = this.oreByChunk.get(Math.floor(x0 / chunk) + ',' + Math.floor(y0 / chunk));
    if (!cell) return;
    const D = this.q ? this.q.detail : 1;
    const tiles = sim.world.tiles, W = this.w, H = this.h;
    const wet = (wx, wy) => {
      const xi = Math.floor(wx), yi = Math.floor(wy);
      if (xi < 0 || yi < 0 || xi >= W || yi >= H) return true;
      const t = tiles[yi * W + xi];
      return t === TILE.WATER || t === TILE.DEEP;
    };

    for (const oi of cell) {
      const o = this.ore[oi];
      const M = ORES[o.kind];
      const st = rgbOf(M.stain), ca = rgbOf(M.a), cb = rgbOf(M.b);
      const cx = (o.x - x0) * TP, cy = (o.y - y0) * TP, rad = o.r * TP;

      // 1) размытое пятно: порода вокруг залежи прокрашена рудой
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, rad);
      const a0 = o.kind === ORE_SALT ? 0.40 : 0.34;
      g.addColorStop(0, css(st[0], st[1], st[2], a0));
      g.addColorStop(0.6, css(st[0], st[1], st[2], a0 * 0.45));
      g.addColorStop(1, css(st[0], st[1], st[2], 0));
      c.fillStyle = g;
      c.beginPath();
      c.ellipse(cx, cy, rad, rad * (0.72 + (o.seed & 63) / 200), (o.seed & 7) * 0.4, 0, 7);
      c.fill();
      if (D < 1) continue;

      // 2) конкретные отметины. Свет всюду сверху-слева — канон проекта.
      const n = D >= 2 ? 5 : 3;
      for (let i = 0; i < n; i++) {
        const q1 = h3(o.seed + i * 13, i * 7 + 3, this.seed);
        const q2 = h3(o.seed + i * 5, i * 29 + 11, this.seed ^ 0x27d4eb2f);
        const q3 = h3(o.seed + i * 41, i * 3 + 1, this.seed ^ 0x165667b1);
        const ang = q1 * 6.283, dist = Math.sqrt(q2) * o.r * 0.82;
        const wx = o.x + Math.cos(ang) * dist, wy = o.y + Math.sin(ang) * dist * 0.8;
        if (wet(wx, wy)) continue;
        const mx = (wx - x0) * TP, my = (wy - y0) * TP;
        const sz = TP * (0.10 + q3 * 0.13);

        if (o.kind === ORE_IRON) {
          // рыжие натёки: неровное пятно и светлая окалина по верхнему краю
          c.globalAlpha = 0.62;
          c.fillStyle = css(ca[0], ca[1], ca[2]);
          c.beginPath();
          c.ellipse(mx, my, sz, sz * (0.6 + q1 * 0.35), q2 * 3, 0, 7);
          c.fill();
          c.globalAlpha = 0.40;
          c.fillStyle = css(cb[0], cb[1], cb[2]);
          c.beginPath();
          c.ellipse(mx - sz * 0.3, my - sz * 0.28, sz * 0.5, sz * 0.28, q2 * 3, 0, 7);
          c.fill();
        } else if (o.kind === ORE_COAL) {
          // чёрный выход пласта: угловатый скол с блестящей левой гранью
          c.globalAlpha = 0.74;
          c.fillStyle = css(ca[0], ca[1], ca[2]);
          c.beginPath();
          c.moveTo(mx - sz, my + sz * 0.4);
          c.lineTo(mx - sz * 0.3, my - sz * 0.7);
          c.lineTo(mx + sz * 0.8, my - sz * 0.2);
          c.lineTo(mx + sz * 0.4, my + sz * 0.6);
          c.closePath(); c.fill();
          c.globalAlpha = 0.34;
          c.fillStyle = css(cb[0], cb[1], cb[2]);
          c.beginPath();
          c.moveTo(mx - sz, my + sz * 0.4);
          c.lineTo(mx - sz * 0.3, my - sz * 0.7);
          c.lineTo(mx - sz * 0.1, my - sz * 0.2);
          c.closePath(); c.fill();
        } else if (o.kind === ORE_SALT) {
          // соляная корка: светлые многоугольники с трещинами по швам
          c.globalAlpha = 0.62;
          c.fillStyle = css(ca[0], ca[1], ca[2]);
          c.beginPath();
          for (let k = 0; k < 5; k++) {
            const a = k / 5 * 6.283 + q1 * 3;
            const rr = sz * (0.7 + h3(o.seed + i * 7 + k, k * 13, this.seed) * 0.6);
            const X = mx + Math.cos(a) * rr, Y = my + Math.sin(a) * rr * 0.72;
            if (k === 0) c.moveTo(X, Y); else c.lineTo(X, Y);
          }
          c.closePath(); c.fill();
          c.globalAlpha = 0.30;
          c.strokeStyle = css(cb[0], cb[1], cb[2]);
          c.lineWidth = Math.max(1, TP * 0.026);
          c.stroke();
        } else {
          // золотая жила: тонкая яркая нить в тёмной борозде породы.
          // Золото — акцентный цвет, ему положено занимать доли процента кадра,
          // поэтому жила именно нить, а не пятно.
          const a = q1 * 3.14, len = sz * (1.6 + q3 * 1.2);
          const dx = Math.cos(a) * len, dy = Math.sin(a) * len * 0.7;
          c.globalAlpha = 0.5;
          c.strokeStyle = css(st[0], st[1], st[2]);
          c.lineWidth = Math.max(1, TP * 0.07);
          c.beginPath();
          c.moveTo(mx - dx, my - dy);
          c.quadraticCurveTo(mx + dy * 0.4, my - dx * 0.4, mx + dx, my + dy);
          c.stroke();
          c.globalAlpha = 0.85;
          c.strokeStyle = css(ca[0], ca[1], ca[2]);
          c.lineWidth = Math.max(1, TP * 0.03);
          c.stroke();
          if (D >= 2) {
            c.globalAlpha = 0.9;
            c.fillStyle = css(cb[0], cb[1], cb[2]);
            c.beginPath();
            c.arc(mx + dx * 0.5, my + dy * 0.5, TP * 0.022, 0, 7);
            c.fill();
          }
        }
      }
      c.globalAlpha = 1;
    }
  }

  // ---- Запросы наружу (тултип клетки, отладка, мини-карта) ----
  biomeAt(x, y) {
    if (!this.on) return BIOME.OCEAN;
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return BIOME.OCEAN;
    return this.biome[yi * this.w + xi];
  }

  oreAt(x, y) {
    for (const o of this.ore) {
      if (Math.hypot(o.x - (x + 0.5), o.y - (y + 0.5)) <= o.r) return ORES[o.kind];
    }
    return null;
  }

  // Готовая русская строка: «Степь, соляная корка».
  describe(x, y) {
    if (!this.on) return '';
    const b = BIOMES[this.biomeAt(x, y)];
    const o = this.oreAt(Math.floor(x), Math.floor(y));
    return o ? `${b.ru}, ${o.ru}` : b.ru;
  }
}

// ---------------------------------------------------------------------------
// Внутреннее
// ---------------------------------------------------------------------------

// Один проход взвешенного box-blur по одной оси. Вес нужен, чтобы вода вообще
// не участвовала в размытии: без веса зелень материка расползлась бы по морю,
// а прибрежная полоса поблекла бы вдвое.
function blurAxis(sr, sg, sb, sw, dr, dg, db, dw, W, H, R, horiz) {
  const outer = horiz ? H : W, inner = horiz ? W : H;
  for (let a = 0; a < outer; a++) {
    let ar = 0, ag = 0, ab = 0, aw = 0;
    const at = (k) => (horiz ? a * W + k : k * W + a);
    // стартовое окно [0..R]
    for (let k = 0; k <= R && k < inner; k++) {
      const i = at(k); ar += sr[i]; ag += sg[i]; ab += sb[i]; aw += sw[i];
    }
    for (let b = 0; b < inner; b++) {
      const i = at(b);
      dr[i] = ar; dg[i] = ag; db[i] = ab; dw[i] = aw;
      const add = b + R + 1, rem = b - R;
      if (add < inner) { const j = at(add); ar += sr[j]; ag += sg[j]; ab += sb[j]; aw += sw[j]; }
      if (rem >= 0) { const j = at(rem); ar -= sr[j]; ag -= sg[j]; ab -= sb[j]; aw -= sw[j]; }
    }
  }
  // Нормируем на ширину окна, иначе за два прохода суммы разрастаются
  // и вес перестаёт означать «доля суши в окне».
  const k = 1 / (2 * R + 1);
  for (let i = 0, n = W * H; i < n; i++) { dr[i] *= k; dg[i] *= k; db[i] *= k; dw[i] *= k; }
}

// Многоисточниковый BFS от всей воды — континентальность за один проход O(N).
// Та же функция есть в worldgen2, но она там не экспортирована, а тащить ради
// неё правку чужого файла нельзя.
function seaDistance(tiles, W, H) {
  const N = W * H;
  const dist = new Uint16Array(N).fill(0xffff);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) {
    if (tiles[i] === TILE.DEEP || tiles[i] === TILE.WATER) { dist[i] = 0; q[qt++] = i; }
  }
  while (qh < qt) {
    const i = q[qh++], x = i % W, y = (i / W) | 0, d = dist[i] + 1;
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (dist[ni] <= d) continue;
      dist[ni] = d; q[qt++] = ni;
    }
  }
  return dist;
}

// Пояс по климату — те же пороги, что в worldgen2.classify, плюс поправка на
// тайл: лес не бывает пустыней, а голая скала всегда гольцы. Без поправки
// выведенная карта спорила бы с тем, что игрок видит своими глазами.
function classify(tile, t, m, rel, riv, dsea) {
  if (tile === TILE.DEEP || tile === TILE.WATER) return BIOME.OCEAN;
  if (tile === TILE.MOUNTAIN) return BIOME.ALPINE;
  if (riv > 0 && rel < 0.3 && t > 0.3) return BIOME.WETLAND;
  let b;
  if (t < 0.22) b = BIOME.TUNDRA;
  else if (t < 0.42) b = m > 0.32 ? BIOME.TAIGA : BIOME.TUNDRA;
  else if (dsea <= 1 && rel < 0.08) b = BIOME.COAST;
  else if (t > 0.72) b = m < 0.28 ? BIOME.DESERT : m < 0.5 ? BIOME.SAVANNA : BIOME.TROPICS;
  else if (m < 0.26) b = BIOME.DESERT;
  else if (m < 0.42) b = BIOME.STEPPE;
  else b = BIOME.TEMPERATE;
  // Поправка на то, что реально растёт на клетке.
  if (tile === TILE.FOREST) {
    if (b === BIOME.DESERT) b = t > 0.6 ? BIOME.SAVANNA : BIOME.STEPPE;
    if (b === BIOME.TUNDRA) b = BIOME.TAIGA;
    if (b === BIOME.COAST) b = BIOME.TEMPERATE;
  } else if (tile === TILE.SAND && b !== BIOME.DESERT && dsea <= 1) {
    b = BIOME.COAST;
  }
  return b;
}

// Что за руда может лежать на такой клетке. Правила не выдуманы: уголь и золото
// живут в породе, соль — на сухих равнинах и по берегу, болотное железо — в
// пойме. Игрок должен уметь предсказать, где искать.
function oreKindFor(tile, biome, r) {
  if (tile === TILE.MOUNTAIN) return r < 0.16 ? ORE_GOLD : r < 0.52 ? ORE_COAL : ORE_IRON;
  if (tile === TILE.HILL) return r < 0.45 ? ORE_COAL : r < 0.9 ? ORE_IRON : ORE_GOLD;
  if (biome === BIOME.WETLAND) return r < 0.45 ? ORE_IRON : -1;   // болотная руда
  if (biome === BIOME.DESERT || biome === BIOME.STEPPE || biome === BIOME.COAST) {
    return r < 0.55 ? ORE_SALT : -1;
  }
  return -1;
}

/* ПОДКЛЮЧЕНИЕ

Шесть однострочных вставок, все — в app/src/render/terrain.js. Ни одна строка
существующего кода не меняется и не удаляется: каждая вставка идёт НОВОЙ СТРОКОЙ
СРАЗУ ПОСЛЕ указанного якоря. Якоря проверены на уникальность в файле.

--- 1. Импорт ---
ЯКОРЬ (строка 12):
import { TERRAIN, TILE_HEIGHT, hash2, fbm2, hex2rgb, mixHex } from './palette.js';
ВСТАВИТЬ ПОСЛЕ:
import { BiomeLayer } from './biomes.js';

--- 2. Поле в конструкторе Terrain ---
ЯКОРЬ:
    this.roadKey = null;       // подпись состава построек и эпохи
ВСТАВИТЬ ПОСЛЕ:
    this.biomes = new BiomeLayer(quality);   // пояса, фактура земли и залежи руд

--- 3. Пересчёт по необходимости, в Terrain.ensure ---
   (идёт сразу после buildHeight, потому что слою нужен готовый this.shade,
    и обязательно ДО buildLow, который у биома спрашивает цвет)
ЯКОРЬ:
    if (this.worldSeed !== sim.world.seed || !this.height) this.buildHeight(sim.world);
ВСТАВИТЬ ПОСЛЕ:
    this.biomes.ensure(sim, this.q, this.shade);

--- 4. Цвет пояса в базовой заливке, в Terrain.buildLow ---
ЯКОРЬ:
        const rgb = hex2rgb(p.base);
ВСТАВИТЬ ПОСЛЕ:
        this.biomes.tintRgb(sim, x, y, rgb);   // мутирует rgb на месте

--- 5. Земля чанка: повтор цвета, проникающие пятна, фактура, в Terrain.bake ---
   (после mottle и ДО деталей: трава и деревья ложатся поверх фактуры земли)
ЯКОРЬ:
    this.mottle(c, world, pal, x0, y0, TP);
ВСТАВИТЬ ПОСЛЕ:
    this.biomes.paintGround(c, sim, x0, y0, TP, CHUNK);

--- 6. Залежи руд, в Terrain.bake ---
   (после деталей и до дорог: руда лежит на поверхности, её не должны
    перекрывать трава и плиты породы, но дорога поверх залежи — нормально)
ЯКОРЬ:
    // кадре поверх чанка, так что дорога всегда оказывается под ними.
ВСТАВИТЬ ПОСЛЕ:
    this.biomes.paintOre(c, sim, x0, y0, TP, CHUNK);

--- Чего делать НЕ надо ---
• Отдельного вызова на смену качества нет: ensure принимает пресет параметром
  и сам замечает, что он сменился.
• Отдельного сброса на смену сезона нет: terrain и так чистит чанки и low,
  а слой замечает смену seasonIdx внутри ensure.
• Правок в palette.js, quality.js и renderer.js не требуется.

--- Что будет видно ---
Если worldgen2 подключён (world.biome есть) — на экране его настоящие пояса.
Если нет — слой выводит их сам из тайлов и широты и всё равно показывает;
массивы ядра при этом не меняются, симуляция не задета.
*/
