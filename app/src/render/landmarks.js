// render/landmarks.js — ПРИРОДНЫЕ ОРИЕНТИРЫ: то, по чему карта запоминается.
//
// ЗАЧЕМ. Местность сейчас однородна: сотня клеток горы отличается от другой
// сотни только шумом, и игрок не может сказать «мой город — под Клыком, а орда
// пришла из-за Солёного поля». Большая стратегия читается ориентирами: три-пять
// мест на весь мир, которые видно с любого зума и которые называют вслух.
// Этот модуль их ставит и рисует.
//
// ЧТО ДЕЛАЕТ МОДУЛЬ
//   • Выбирает 3–5 мест на карту (не больше: шесть «уникальных» скал — это уже
//     фактура, а не ориентиры) детерминированно от сида и от самого рельефа:
//     вулкан встаёт в крупном массиве гор, оазис — в глубине пустыни, водопад —
//     там, где русло падает с уступа. Одно и то же зерно даёт одну и ту же карту.
//   • Рисует одиннадцать родов ориентиров, каждый — узнаваемым СИЛУЭТОМ
//     (docs/art-direction.md §3): двуглавый пик с перевалом, ущелье, оазис с
//     пальмами, водопад, вулкан с кратером, гейзер, солончак, каменная арка со
//     столбами выветривания, руины колоннады, кольцо менгиров, дерево-исполин.
//   • Даёт игре текст: list(), at(), describe() — готовые русские названия и
//     описания для тултипа клетки, подсказок и летописи.
//
// ГДЕ ЖИВЁТ ЦЕНА. Ориентир — часть местности, поэтому он ПЕЧЁТСЯ В ЧАНК вместе
// с травой и породой (см. terrain.js: bake): в кадре статичная часть стоит ровно
// ноль. Живого в кадре остаётся горсть: столб дыма вулкана, выброс гейзера,
// водяная пыль водопада и ночное свечение кратера — это до сорока блитов
// одного заранее испечённого пятна, и только когда ориентир на экране. На
// пресете eco живой слой выключен целиком, а рисунок идёт по упрощённому пути.
//
// ПРО СЛУЧАЙНОСТЬ. Math.random в проекте запрещён, а rng ядра рендер трогать не
// имеет права: каждый его вызов сдвигает состояние симуляции, рендер идёт с
// разной частотой у разных игроков — сейв бы поплыл. Поэтому внутри свой хеш от
// world.seed (образец — weather.js и fx.js). Каждый ориентир получает при
// выборе готовый набор из 24 чисел и рисуется только по ним: один и тот же
// объект, попавший в четыре соседних чанка, выходит в них одинаковым.
//
// ПРО СЛОИ ЯДРА. Модуль опирается на core/systems/worldgen2.js: world.biome,
// world.river, world.elev. Если генератор ещё не подключён (сейчас так и есть),
// пояса и высота выводятся здесь же теми же формулами temperature/moisture,
// что экспортирует worldgen2, — ни один массив ядра при этом не меняется.
//
// ЧТО НАРОЧНО НЕ СДЕЛАНО. Бонусов к местности рядом с ориентиром модуль не
// начисляет: это работа ядра, а ядро правят другие руки. Предложение, что
// именно стоило бы дать, лежит в блоке ПОДКЛЮЧЕНИЕ в конце файла — вместе с
// радиусами, которые модуль уже считает и отдаёт в list().

import { TILE } from '../core/data.js';
import { BIOME, temperature, moisture } from '../core/systems/worldgen2.js';
import { TERRAIN, lightAt, hex2rgb } from './palette.js';

// ---------------------------------------------------------------------------
// РОДЫ ОРИЕНТИРОВ
//
// ru      — как называется род в тексте игры;
// noun    — начало имени собственного («Гора» + «Ворона»);
// span    — габарит в клетках (rx, ry): по нему считается, какие чанки надо
//           перепечь и попадает ли ориентир в кадр;
// rad     — радиус влияния в клетках: столько вокруг имеет смысл давать бонус
//           к местности (сам бонус — работа ядра, см. блок ПОДКЛЮЧЕНИЕ);
// weight  — насколько род «крупный»: при отборе крупные идут первыми, иначе
//           карта получит три кучки камней и ни одной горы;
// live    — есть ли у рода живая часть в кадре (дым, пар, свечение).
// ---------------------------------------------------------------------------
export const LANDMARK = {
  peak:     { ru: 'горный пик',     noun: 'Гора',     span: [3.2, 2.6], rad: 3, weight: 1.00, live: false },
  volcano:  { ru: 'вулкан',         noun: 'Вулкан',   span: [3.0, 2.8], rad: 4, weight: 1.00, live: true },
  canyon:   { ru: 'ущелье',         noun: 'Ущелье',   span: [3.6, 3.6], rad: 3, weight: 0.95, live: false },
  waterfall:{ ru: 'водопад',        noun: 'Водопад',  span: [2.0, 2.0], rad: 2, weight: 0.92, live: true },
  saltflat: { ru: 'солончак',       noun: 'Солончак', span: [3.2, 2.6], rad: 3, weight: 0.90, live: false },
  oasis:    { ru: 'оазис',          noun: 'Оазис',    span: [2.4, 2.2], rad: 3, weight: 0.90, live: false },
  arch:     { ru: 'каменная арка',  noun: 'Арка',     span: [2.2, 2.0], rad: 2, weight: 0.86, live: false },
  geyser:   { ru: 'гейзер',         noun: 'Гейзер',   span: [1.8, 1.8], rad: 2, weight: 0.84, live: true },
  elder:    { ru: 'древо-исполин',  noun: 'Древо',    span: [2.0, 2.4], rad: 2, weight: 0.82, live: false },
  ruins:    { ru: 'древние руины',  noun: 'Руины',    span: [2.6, 1.8], rad: 3, weight: 0.80, live: false },
  menhir:   { ru: 'кольцо менгиров',noun: 'Круг',     span: [2.0, 1.6], rad: 2, weight: 0.78, live: false },
};

// Имена собственные. Родительный падеж, чтобы одно окончание подошло любому
// роду: «Гора Ворона», «Ущелье Ворона», «Оазис Ворона» — везде читается.
const NAMES = [
  'Ворона', 'Ветров', 'Трёх Братьев', 'Молчания', 'Старого Волка', 'Пепла',
  'Рассвета', 'Последнего Костра', 'Соли', 'Грома', 'Сорока Дней', 'Тумана',
  'Медведицы', 'Чёрной Воды', 'Кости', 'Утренней Звезды',
];

// Сколько ориентиров ставим на карту 96×96 и как редко они стоят друг к другу.
export const LANDMARK_MIN = 3;
export const LANDMARK_MAX = 5;
const MIN_SEP = 13;     // клеток между двумя ориентирами: ближе — уже пейзаж
const START_KEEP = 9;   // не ставим вплотную к стартовой поляне: там строят

// ---------------------------------------------------------------------------
// МАТЕРИАЛЫ, которых нет в TERRAIN.
// По-хорошему их место в palette.js рядом с ERA_PALETTE — здесь они лежат
// только потому, что модуль обязан быть одним файлом. При слиянии таблицу
// переносить без изменений.
//
// Правила арт-дирекции, которым таблица подчиняется: земля «грязная», ни один
// цвет кроме огня не тянет выше 70 % насыщенности, самое яркое в кадре — свет.
// Лава — единственный акцент, и площади он занимает считанные проценты.
// ---------------------------------------------------------------------------
const MAT = {
  basalt:   '#4a443f', basaltHi: '#6d655d', basaltLo: '#332f2c',  // остывшая порода вулкана
  ash:      '#5c5751', ashLo:    '#413d39',                       // пепловый шлейф у подножия
  lava:     '#e8762d', lavaHot:  '#ffd25a', lavaDark: '#a8352c',  // акцент «огонь» из §2.3
  ochre:    '#b0885a', ochreHi:  '#cda87a', ochreLo:  '#8a6845',  // выветренный песчаник
  band:     '#a0704a',                                            // прослойка в породе
  salt:     '#dcd8cc', saltHi:   '#f0eee6', saltLo:   '#b3ac9c',  // соляная корка
  brine:    '#9fb0ac',                                            // рассол в мочажине
  sinter:   '#cfc7b4', sinterHi: '#e6dfd0',                       // гейзерит, натёчный камень
  hot:      '#8fb6ae',                                            // горячий источник, мутно-бирюзовый
  ruin:     '#a89f8c', ruinHi:   '#c6bda8', ruinLo:  '#6f6a5e',   // тёсаный камень, тронутый временем
  menhir:   '#8e8880', menhirHi: '#a9a49b', menhirLo:'#5d5952',   // необработанный валун
  foam:     '#e6f1f6',                                            // пена и водяная пыль
  snow:     '#eef4f8',
  moss:     '#5c6b45',
  dirt:     '#7a6242',                                            // вытоптанная земля вокруг
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const c255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

// Умножение цвета на яркость: тот же приём, что в terrain.shadeHex.
function mul(hex, k) {
  const c = hex2rgb(hex);
  return `rgb(${c255(c[0] * k)},${c255(c[1] * k)},${c255(c[2] * k)})`;
}
function alpha(hex, a) {
  const c = hex2rgb(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
function mix(h1, h2, k) {
  const a = hex2rgb(h1), b = hex2rgb(h2);
  return `rgb(${c255(a[0] + (b[0] - a[0]) * k)},${c255(a[1] + (b[1] - a[1]) * k)},${c255(a[2] + (b[2] - a[2]) * k)})`;
}

// Хеш с солью: то же семейство, что palette.hash2, но сид мира входит в число,
// а не подмешивается снаружи — иначе два разных мира дали бы одну карту.
function h3(x, y, s) {
  let v = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  v = (v ^ (v >>> 13)) * 1274126177 | 0;
  v = (v ^ (v >>> 16)) | 0;
  return ((v ^ (v >>> 9)) >>> 0) / 4294967296;
}

// Поток чисел на один ориентир: xorshift, засеянный местом и сидом. Числа
// берутся ОДИН РАЗ при выборе и кладутся в объект: рисование обязано быть
// чистой функцией от них, иначе один и тот же ориентир в соседних чанках
// разъедется.
function stream(seed, n) {
  let s = (seed | 0) || 0x9e3779b9;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    out[i] = (s >>> 0) / 4294967296;
  }
  return out;
}

const isWater = (t) => t === TILE.WATER || t === TILE.DEEP;

// Расстояние до ближайшей воды многоисточниковым BFS — один проход O(N).
// Та же функция есть в worldgen2, но она там не экспортирована, а тащить ради
// неё правку чужого файла нельзя.
function seaDistance(tiles, W, H) {
  const N = W * H;
  const dist = new Uint16Array(N).fill(0xffff);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (isWater(tiles[i])) { dist[i] = 0; q[qt++] = i; }
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

// Пояс по климату, когда worldgen2 не подключён. Пороги — из его classify,
// плюс поправка на то, что реально растёт на клетке: лес не бывает пустыней.
function classify(tile, t, m, rel, riv, dsea) {
  if (isWater(tile)) return BIOME.OCEAN;
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
  if (tile === TILE.FOREST) {
    if (b === BIOME.DESERT) b = t > 0.6 ? BIOME.SAVANNA : BIOME.STEPPE;
    if (b === BIOME.TUNDRA) b = BIOME.TAIGA;
  }
  return b;
}

// Относительная высота по типу тайла — запасной рельеф, когда world.elev нет.
const H_BY_TILE = {
  [TILE.DEEP]: 0.00, [TILE.WATER]: 0.06, [TILE.SAND]: 0.16,
  [TILE.GRASS]: 0.26, [TILE.FOREST]: 0.30, [TILE.HILL]: 0.62, [TILE.MOUNTAIN]: 1.00,
};

// ===========================================================================
// СЛОЙ
// ===========================================================================
export class LandmarkLayer {
  constructor(quality) {
    this.q = quality;
    this.key = null;        // подпись мира: сид и размер
    this.marks = [];        // выбранные ориентиры
    this.seed = 0;
    this.W = 0; this.H = 0;
    this._soft = new Map(); // мягкие пятна дыма и пара — пекутся один раз
    this._glow = null;      // тёплое пятно для кратера ночью
  }

  setQuality(q) { this.q = q; }

  // Пересчёт по необходимости. Возвращает true, если состав ориентиров сменился
  // и чанки надо перепечь: это позволяет подключить слой ОДНОЙ строкой.
  ensure(sim, quality, height) {
    if (quality) this.q = quality;
    const world = sim && sim.world;
    if (!world || !world.tiles) return false;
    const key = (world.seed >>> 0) + ':' + world.w + 'x' + world.h;
    if (key === this.key) return false;
    this.key = key;
    this.seed = world.seed >>> 0;
    this.W = world.w; this.H = world.h;
    this.marks = pick(world, this.seed, height);
    return true;
  }

  // --- справка для интерфейса и ядра ---
  list() { return this.marks; }

  // Ближайший ориентир к клетке, если она в его радиусе влияния.
  at(x, y) {
    let best = null, bd = Infinity;
    for (const m of this.marks) {
      const d = Math.hypot(m.x - x, m.y - y);
      if (d <= m.rad && d < bd) { bd = d; best = m; }
    }
    return best;
  }

  // Готовая строка для тултипа клетки.
  describe(x, y) {
    const m = this.at(x, y);
    return m ? `${m.name} — ${m.ru}` : '';
  }

  // =======================================================================
  // СТАТИЧНАЯ ЧАСТЬ — идёт внутрь выпечки чанка, в кадре стоит ноль.
  // x0,y0 — левый верхний угол чанка в клетках, TP — пикселей на клетку.
  // =======================================================================
  paint(c, sim, x0, y0, TP, CH) {
    if (!this.marks.length) return;
    const season = sim.seasonIdx | 0;
    const P = palOf(season);
    const D = this.q ? this.q.detail : 1;
    for (const m of this.marks) {
      const sp = LANDMARK[m.kind].span;
      // Габарит с запасом: силуэт уходит вверх сильнее, чем вниз.
      if (m.x + sp[0] < x0 - 1 || m.x - sp[0] > x0 + CH + 1) continue;
      if (m.y + sp[1] < y0 - 1 || m.y - sp[1] * 2.2 > y0 + CH + 1) continue;
      const X = (m.x + 0.5 - x0) * TP, Y = (m.y + 0.9 - y0) * TP;
      c.save();
      DRAW[m.kind](c, X, Y, TP, P, season, D, m.r, m);
      c.restore();
      c.globalAlpha = 1;
    }
  }

  // =======================================================================
  // ЖИВАЯ ЧАСТЬ — дым, пар, свечение. Только то, что физически движется.
  // Вызывается раз в кадр; при пустом списке уходит на первой строке.
  // =======================================================================
  drawLive(sim, ctx, ox, oy, z, cw, ch, time) {
    if (!this.marks.length || !this.q || this.q.id === 'eco') return;
    if (z < 11) return;   // на дальнем зуме дым — это шум в один пиксель
    if (!this.soft(MAT.foam)) return;   // нет DOM — нет и живого слоя
    const L = lightAt(sim.dayTime);
    for (const m of this.marks) {
      if (!LANDMARK[m.kind].live) continue;
      const sx = ox + (m.x + 0.5) * z, sy = oy + (m.y + 0.9) * z;
      if (sx < -4 * z || sy < -8 * z || sx > cw + 4 * z || sy > ch + 4 * z) continue;
      if (m.kind === 'volcano') this.livePlume(ctx, sx, sy - z * 2.6, z, time, m, L);
      else if (m.kind === 'geyser') this.liveGeyser(ctx, sx, sy - z * 0.35, z, time, m);
      else if (m.kind === 'waterfall') this.liveMist(ctx, sx, sy - z * 0.2, z, time, m);
    }
    ctx.globalAlpha = 1;
  }

  // Столб дыма: восемь пятен, поднимающихся по своей фазе. Ветер берём
  // постоянным — модуль не лезет в atmosphere, а лишний параметр в подключении
  // стоит дороже, чем польза от точного сноса.
  livePlume(ctx, x, y, z, t, m, L) {
    ctx.save();
    // Дым темнеет у жерла и светлеет, остывая: у кратера он почти чёрный,
    // вверху — пепельно-серый. Два печёных пятна вместо тонирования в кадре.
    const dark = this.soft(MAT.basaltLo), pale = this.soft(MAT.ash);
    const N = 8;
    for (let i = 0; i < N; i++) {
      const ph = (t * 0.20 + i / N + m.r[6]) % 1;
      const rise = ph * z * 4.2;
      const drift = rise * 0.34 + Math.sin(ph * 5 + i) * z * 0.12;
      const rad = z * (0.34 + ph * 1.15);
      const a = (1 - ph) * (ph < 0.12 ? ph / 0.12 : 1) * 0.34;
      if (a < 0.012) continue;
      ctx.globalAlpha = a;
      blot(ctx, ph < 0.35 ? dark : pale, x + drift, y - rise, rad);
    }
    // Ночью жерло подсвечивает собственный дым — единственное место, где
    // акцентный огонь выходит за габарит объекта.
    const g = L.glow > 0.05 ? this.glowSprite() : null;
    if (g) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.30 * L.glow * (0.82 + 0.18 * Math.sin(t * 1.7 + m.r[7] * 6));
      ctx.drawImage(g, x - z * 1.1, y - z * 1.1, z * 2.2, z * 2.2);
    }
    ctx.restore();
  }

  // Гейзер: тихий парок и раз в одиннадцать секунд — выброс.
  liveGeyser(ctx, x, y, z, t, m) {
    const PERIOD = 11;
    const ph = ((t + m.r[8] * PERIOD) % PERIOD) / PERIOD;
    // Взлёт быстрый, спад долгий: столб «выстреливает» и оседает.
    const burst = ph < 0.06 ? ph / 0.06 : ph < 0.22 ? 1 - (ph - 0.06) / 0.16 : 0;
    const steam = this.soft(MAT.foam);
    ctx.save();
    const N = burst > 0 ? 7 : 3;
    for (let i = 0; i < N; i++) {
      const k = i / N;
      const rise = z * (0.25 + k * (0.7 + burst * 3.0));
      const rad = z * (0.16 + k * (0.20 + burst * 0.42));
      ctx.globalAlpha = (1 - k) * (0.14 + burst * 0.42);
      blot(ctx, steam, x + Math.sin(t * 1.1 + i) * z * 0.06 + rise * 0.14, y - rise, rad);
    }
    if (burst > 0.35) {   // сама струя: узкое яркое ядро
      ctx.globalAlpha = 0.5 * burst;
      ctx.fillStyle = MAT.foam;
      ctx.beginPath();
      ctx.moveTo(x - z * 0.09, y);
      ctx.quadraticCurveTo(x - z * 0.05, y - z * 1.6 * burst, x + z * 0.03, y - z * 3.2 * burst);
      ctx.quadraticCurveTo(x + z * 0.12, y - z * 1.6 * burst, x + z * 0.11, y);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  // Водяная пыль у подножия падуна: три дышащих пятна.
  liveMist(ctx, x, y, z, t, m) {
    const steam = this.soft(MAT.foam);
    ctx.save();
    for (let i = 0; i < 3; i++) {
      const ph = (t * 0.35 + i / 3 + m.r[9]) % 1;
      const a = Math.sin(ph * Math.PI) * 0.20;
      if (a < 0.01) continue;
      ctx.globalAlpha = a;
      blot(ctx, steam, x + (i - 1) * z * 0.38, y - ph * z * 0.8, z * (0.30 + ph * 0.45));
    }
    ctx.restore();
  }

  // Мягкое пятно нужного цвета печётся один раз на цвет: ctx.filter='blur()'
  // в проекте запрещён (замер −51 FPS), мягкость даёт только градиентный
  // спрайт, а тонировать его в кадре нечем — drawImage не знает fillStyle.
  // Цветов ровно три, так что кэш никогда не растёт.
  soft(hex) {
    let cv = this._soft.get(hex);
    if (cv) return cv;
    if (typeof document === 'undefined') return null;
    const S = 64;
    cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, alpha(hex, 1));
    g.addColorStop(0.45, alpha(hex, 0.55));
    g.addColorStop(1, alpha(hex, 0));
    c.fillStyle = g; c.fillRect(0, 0, S, S);
    this._soft.set(hex, cv);
    return cv;
  }

  glowSprite() {
    if (this._glow) return this._glow;
    if (typeof document === 'undefined') return null;
    const S = 96;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,168,72,0.85)');
    g.addColorStop(0.4, 'rgba(232,118,45,0.28)');
    g.addColorStop(1, 'rgba(232,118,45,0)');
    c.fillStyle = g; c.fillRect(0, 0, S, S);
    this._glow = cv;
    return cv;
  }
}

// Пятно рисуется через globalCompositeOperation источника: белый спрайт
// умножается на текущий fillStyle приёмом «залить прямоугольник поверх маски»
// было бы дороже, поэтому просто тонируем альфой — на дыму разница не видна.
function blot(ctx, spr, x, y, r) {
  ctx.drawImage(spr, x - r, y - r, r * 2, r * 2);
}

// ---------------------------------------------------------------------------
// ПАЛИТРА СЕЗОНА: местные материалы плюс то, что уже есть в TERRAIN.
// ---------------------------------------------------------------------------
function palOf(season) {
  const T = TERRAIN[season] || TERRAIN[1];
  const winter = season === 3;
  return {
    rock: T[TILE.MOUNTAIN].base, rockHi: T[TILE.MOUNTAIN].hi, rockLo: T[TILE.MOUNTAIN].lo,
    rockDet: T[TILE.MOUNTAIN].det2,
    sand: T[TILE.SAND].base, sandHi: T[TILE.SAND].hi, sandLo: T[TILE.SAND].lo,
    grass: T[TILE.GRASS].base, grassLo: T[TILE.GRASS].lo, grassDet: T[TILE.GRASS].det,
    leaf: T[TILE.FOREST].det, leafHi: T[TILE.FOREST].det2, leafLo: T[TILE.FOREST].lo,
    water: T[TILE.WATER].base, waterHi: T[TILE.WATER].hi, deep: T[TILE.DEEP].base,
    winter,
    // Зимой любой камень получает снежную кромку — это сезонный слой, а не
    // свойство материала (docs/art-direction.md §2.1).
    cap: winter ? MAT.snow : null,
  };
}

// ---------------------------------------------------------------------------
// ВЫБОР МЕСТ
//
// Один проход по карте на каждый род, затем жадный отбор с разносом. Всё
// детерминировано: сид входит в хеш, порядок обхода фиксирован.
// ---------------------------------------------------------------------------
function pick(world, seed, height) {
  const W = world.w, H = world.h;
  const tiles = world.tiles;
  const field = buildField(world, height);
  // На каждый род держим только тридцать лучших мест: полный список кандидатов
  // — это десятки тысяч объектов на пустом месте, а нужны из него единицы.
  const CAP = 30;
  const cand = {};
  for (const kind of KIND_LIST) cand[kind] = [];
  const sx0 = world.startX != null ? world.startX : W / 2;
  const sy0 = world.startY != null ? world.startY : H / 2;

  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x;
      const t = tiles[i];
      if (t === TILE.DEEP) continue;   // на глубине ориентиров нет
      // Далеко от стартовой поляны: там строят город, и скала посреди площади
      // мешает и глазу, и застройке.
      if (Math.hypot(x - sx0, y - sy0) < START_KEEP) continue;
      for (let k = 0; k < KIND_LIST.length; k++) {
        const kind = KIND_LIST[k];
        const s = SCORE[kind](field, x, y, i);
        if (s <= 0) continue;
        // Джиттер от сида: без него один и тот же «математически лучший»
        // угол карты выигрывал бы на каждом мире.
        const j = 0.75 + 0.5 * h3(x * 7 + k, y * 11 + k, seed ^ 0x51ed);
        pushTop(cand[kind], x, y, s * j, CAP);
      }
    }
  }

  // Лучшее место каждого рода плюс несколько РАЗНЕСЁННЫХ запасных: соседние
  // клетки того же холма в запас не годятся — они не пройдут проверку на разнос.
  const best = [];
  for (const kind of KIND_LIST) {
    const list = cand[kind];
    if (!list.length) continue;
    list.sort((a, b) => b.s - a.s || (a.y - b.y) || (a.x - b.x));
    const spread = [];
    for (const p of list) {
      let far = true;
      for (const q of spread) if (Math.hypot(q.x - p.x, q.y - p.y) < 8) { far = false; break; }
      if (far) spread.push(p);
      if (spread.length >= 6) break;
    }
    best.push({ kind, x: spread[0].x, y: spread[0].y, s: spread[0].s, alt: spread.slice(1) });
  }
  if (!best.length) return [];

  // Порядок родов: крупные вперёд, но с сидовым перемешиванием — иначе на
  // каждой карте первыми встают вулкан и пик, а руины и менгиры не появляются
  // никогда. Разброс шире веса: любой род может выйти вперёд, крупные — чаще.
  const prio = {};
  for (let k = 0; k < KIND_LIST.length; k++) {
    prio[KIND_LIST[k]] = LANDMARK[KIND_LIST[k]].weight * (0.45 + 1.15 * h3(k * 131 + 7, 3, seed));
  }
  best.sort((a, b) => prio[b.kind] - prio[a.kind]);

  const want = LANDMARK_MIN + Math.floor(h3(17, 29, seed) * (LANDMARK_MAX - LANDMARK_MIN + 1));
  const out = [];
  // Первый проход — с полным разносом. Если карта тесная и трёх мест не
  // набралось, второй проход разрешает встать вдвое ближе: три ориентира лучше
  // одного, даже если два из них смотрят друг на друга.
  for (const sep of [MIN_SEP, MIN_SEP * 0.55]) {
    for (const b of best) {
      if (out.length >= want) break;
      if (out.some(o => o.kind === b.kind)) continue;
      const tries = [{ x: b.x, y: b.y }, ...b.alt];
      let placed = null;
      for (const p of tries) {
        let ok = true;
        for (const o of out) if (Math.hypot(o.x - p.x, o.y - p.y) < sep) { ok = false; break; }
        if (ok) { placed = p; break; }
      }
      if (!placed) continue;
      out.push(make(b.kind, placed.x, placed.y, seed));
    }
    if (out.length >= LANDMARK_MIN) break;
  }
  // Порядок в списке — по Y: так их удобно перечислять в интерфейсе сверху вниз.
  out.sort((a, b) => a.y - b.y);
  return out;
}

// Вставка в отсортированный по убыванию список ограниченной длины.
function pushTop(list, x, y, s, cap) {
  if (list.length < cap) {
    list.push({ x, y, s });
    for (let i = list.length - 1; i > 0 && list[i].s > list[i - 1].s; i--) {
      const t = list[i]; list[i] = list[i - 1]; list[i - 1] = t;
    }
    return;
  }
  if (s <= list[cap - 1].s) return;
  list[cap - 1] = { x, y, s };
  for (let i = cap - 1; i > 0 && list[i].s > list[i - 1].s; i--) {
    const t = list[i]; list[i] = list[i - 1]; list[i - 1] = t;
  }
}

function make(kind, x, y, seed) {
  const def = LANDMARK[kind];
  const r = stream((seed ^ (x * 73856093) ^ (y * 19349663) ^ (kind.length * 83492791)) | 0, 24);
  const nameIdx = Math.floor(h3(x * 3 + 1, y * 5 + 2, seed) * NAMES.length) % NAMES.length;
  return {
    kind, x, y,
    ru: def.ru,
    name: `${def.noun} ${NAMES[nameIdx]}`,
    rad: def.rad,
    span: def.span,
    live: def.live,
    r,
  };
}

// ---------------------------------------------------------------------------
// ПОЛЕ, по которому считаются условия: высота, уклон, биом, река, море.
// ---------------------------------------------------------------------------
function buildField(world, height) {
  const W = world.w, H = world.h, N = W * H;
  const tiles = world.tiles;

  // Высота 0..1. Настоящая карта высот из worldgen2 предпочтительнее: у неё
  // внутри массива есть склоны, а у типа тайла — только три ступени.
  const hgt = new Float32Array(N);
  if (world.elev && world.elev.length === N) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < N; i++) {
      const e = world.elev[i];
      if (e < lo) lo = e; if (e > hi) hi = e;
    }
    const sp = Math.max(1e-4, hi - lo);
    for (let i = 0; i < N; i++) hgt[i] = (world.elev[i] - lo) / sp;
  } else if (height && height.length === N) {
    // Сглаженное поле терраина: −0.55…1.35 приводим к 0…1.
    for (let i = 0; i < N; i++) hgt[i] = clamp((height[i] + 0.6) / 1.95, 0, 1);
  } else {
    for (let i = 0; i < N; i++) hgt[i] = H_BY_TILE[tiles[i]] ?? 0.2;
  }

  // Уклон: максимальный перепад к четырём соседям. Именно он ищет уступы под
  // водопад и стенки под ущелье.
  const slope = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, e = hgt[i];
      let d = 0;
      if (x > 0) d = Math.max(d, Math.abs(e - hgt[i - 1]));
      if (x < W - 1) d = Math.max(d, Math.abs(e - hgt[i + 1]));
      if (y > 0) d = Math.max(d, Math.abs(e - hgt[i - W]));
      if (y < H - 1) d = Math.max(d, Math.abs(e - hgt[i + W]));
      slope[i] = d;
    }
  }

  const dsea = seaDistance(tiles, W, H);
  const river = world.river && world.river.length === N ? world.river : null;

  // Биом: слой ядра, если он есть; иначе выводим теми же формулами.
  let biome = world.biome && world.biome.length === N ? world.biome : null;
  if (!biome) {
    biome = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      const lat = Math.abs((y + 0.5) / H * 2 - 1);
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const n1 = h3(x * 5, y * 5, 401) * 2 - 1;
        const n2 = h3(x * 3, y * 7, 909) * 2 - 1;
        const rel = clamp(hgt[i] - 0.2, 0, 1);
        const t = temperature(lat, rel, n1);
        const m = moisture(dsea[i], n2);
        biome[i] = classify(tiles[i], t, m, rel, river ? river[i] : 0, dsea[i]);
      }
    }
  }

  // Интегральные таблицы: «сколько гор в окне 13×13» иначе стоит 169 чтений на
  // каждую клетку-кандидата, и весь отбор превращается в заметный рывок при
  // создании мира. С суммами по площади любой такой вопрос стоит четыре чтения.
  // Таблицы живут только внутри выбора и уходят вместе с ним.
  const sums = {
    mtn: integral(tiles, W, H, (t) => t === TILE.MOUNTAIN),
    high: integral(tiles, W, H, (t) => t === TILE.MOUNTAIN || t === TILE.HILL),
    water: integral(tiles, W, H, isWater),
    forest: integral(tiles, W, H, (t) => t === TILE.FOREST),
    sand: integral(tiles, W, H, (t) => t === TILE.SAND),
    soft: integral(tiles, W, H, (t) => !isWater(t) && t !== TILE.MOUNTAIN),
    open: integral(tiles, W, H, (t) => t === TILE.GRASS || t === TILE.HILL),
  };

  return { W, H, N, tiles, hgt, slope, dsea, river, biome, sums, world };
}

// Сумма по площади: T[(y+1)*(W+1)+(x+1)] = число «своих» клеток в прямоугольнике
// от начала карты. Классическая таблица Кроу, здесь — на булевом признаке.
function integral(tiles, W, H, pred) {
  const T = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      if (pred(tiles[y * W + x])) row++;
      T[(y + 1) * (W + 1) + (x + 1)] = T[y * (W + 1) + (x + 1)] + row;
    }
  }
  return T;
}

// Сколько клеток признака в квадрате радиуса r вокруг (x,y). Края обрезаются
// по карте, поэтому у берега окно честно меньше — это и нужно.
function count(f, name, x, y, r) {
  const W1 = f.W + 1;
  const x0 = clamp(x - r, 0, f.W), x1 = clamp(x + r + 1, 0, f.W);
  const y0 = clamp(y - r, 0, f.H), y1 = clamp(y + r + 1, 0, f.H);
  const T = f.sums[name];
  return T[y1 * W1 + x1] - T[y0 * W1 + x1] - T[y1 * W1 + x0] + T[y0 * W1 + x0];
}

// Проверка пояса битовой маской, а не списком: отбор спрашивает про биом до
// пятидесяти тысяч раз подряд, и список аргументов на каждый вопрос — это
// пятьдесят тысяч выброшенных массивов.
const B = (...list) => list.reduce((m, b) => m | (1 << b), 0);
const B_DRY = B(BIOME.DESERT, BIOME.STEPPE, BIOME.SAVANNA, BIOME.ALPINE, BIOME.TUNDRA);
const B_DESERT = B(BIOME.DESERT);
const B_SALT = B(BIOME.DESERT, BIOME.STEPPE);
const B_ARCH = B(BIOME.DESERT, BIOME.SAVANNA, BIOME.STEPPE);
const B_COLD = B(BIOME.TUNDRA, BIOME.TAIGA, BIOME.STEPPE, BIOME.ALPINE);
const B_WOOD = B(BIOME.TROPICS, BIOME.TEMPERATE, BIOME.TAIGA, BIOME.WETLAND);
const B_LIVED = B(BIOME.TEMPERATE, BIOME.STEPPE, BIOME.SAVANNA, BIOME.COAST, BIOME.TROPICS, BIOME.DESERT);

function biomeIs(f, x, y, mask) {
  return ((1 << f.biome[y * f.W + x]) & mask) !== 0;
}

// ---------------------------------------------------------------------------
// УСЛОВИЯ РОДОВ. Возвращают «насколько тут уместно», 0 — нельзя.
// Каждое правило должно быть предсказуемым: игрок, увидев вулкан в горах и
// оазис в глубине пустыни, понимает мир, а не удивляется ему.
// ---------------------------------------------------------------------------
const SCORE = {
  // Пик: сердце крупного массива. Нужен и объём вокруг, и высота.
  peak(f, x, y, i) {
    if (f.tiles[i] !== TILE.MOUNTAIN) return 0;
    const m = count(f, 'mtn', x, y, 3);
    if (m < 18) return 0;
    return m * 0.06 + f.hgt[i] * 2.2;
  },

  // Вулкан: тоже горы, но на отшибе массива — конус стоит особняком, а не
  // теряется в хребте.
  volcano(f, x, y, i) {
    if (f.tiles[i] !== TILE.MOUNTAIN && f.tiles[i] !== TILE.HILL) return 0;
    const m3 = count(f, 'high', x, y, 3), m6 = count(f, 'high', x, y, 6);
    if (m3 < 9 || m6 > 110) return 0;      // не в глубине сплошного хребта
    if (f.dsea[i] < 3) return 0;
    return 1.2 + m3 * 0.04 + f.hgt[i] * 1.4 - m6 * 0.006;
  },

  // Ущелье: сухая земля со стенками. Ищем сильный уклон при отсутствии воды —
  // такой рельеф режется руслом, которое давно пересохло.
  canyon(f, x, y, i) {
    const t = f.tiles[i];
    if (isWater(t) || t === TILE.FOREST) return 0;
    if (count(f, 'water', x, y, 2) > 0) return 0;
    if (f.slope[i] < 0.055) return 0;
    const dry = biomeIs(f, x, y, B_DRY);
    if (!dry) return 0;
    const hard = count(f, 'high', x, y, 2);
    return 0.8 + f.slope[i] * 6 + hard * 0.05;
  },

  // Водопад: русло (или озёрная кромка) на уступе. Без слоя рек берём воду,
  // подпёртую горой, — падун с кручи в озеро.
  waterfall(f, x, y, i) {
    const riv = f.river ? f.river[i] : 0;
    const t = f.tiles[i];
    const onRiver = riv > 0;
    const onShore = isWater(t) && count(f, 'high', x, y, 1) >= 3;
    if (!onRiver && !onShore) return 0;
    if (f.slope[i] < 0.07) return 0;
    return 1.0 + f.slope[i] * 7 + (onRiver ? riv * 0.3 : 0);
  },

  // Оазис: глубина пустыни, вода далеко, русла нет. Ровно то место, где вода
  // из-под земли — событие.
  oasis(f, x, y, i) {
    if (!biomeIs(f, x, y, B_DESERT)) return 0;
    const t = f.tiles[i];
    if (t !== TILE.SAND && t !== TILE.GRASS) return 0;
    if (f.dsea[i] < 7) return 0;
    if (count(f, 'water', x, y, 3) > 0) return 0;
    if (f.river) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= f.W || yy >= f.H) continue;
      if (f.river[yy * f.W + xx]) return 0;
    }
    const desert = count(f, 'sand', x, y, 4);
    return 1.0 + f.dsea[i] * 0.05 + desert * 0.03;
  },

  // Солончак: сухая котловина. Проверяем, что клетка ниже своей округи, —
  // соль остаётся там, куда вода стекает и откуда не уходит.
  saltflat(f, x, y, i) {
    if (!biomeIs(f, x, y, B_SALT)) return 0;
    if (isWater(f.tiles[i]) || f.tiles[i] === TILE.FOREST) return 0;
    if (count(f, 'water', x, y, 3) > 0) return 0;
    if (f.slope[i] > 0.03) return 0;                 // дно должно быть плоским
    let around = 0, n = 0;
    for (let dy = -4; dy <= 4; dy += 2) for (let dx = -4; dx <= 4; dx += 2) {
      const xx = clamp(x + dx, 0, f.W - 1), yy = clamp(y + dy, 0, f.H - 1);
      around += f.hgt[yy * f.W + xx]; n++;
    }
    const basin = around / n - f.hgt[i];
    if (basin < 0.005) return 0;
    return 0.9 + basin * 26;
  },

  // Арка и столбы выветривания: открытая сухая земля с породой рядом.
  arch(f, x, y, i) {
    const t = f.tiles[i];
    if (t !== TILE.SAND && t !== TILE.GRASS && t !== TILE.HILL) return 0;
    if (!biomeIs(f, x, y, B_ARCH)) return 0;
    if (count(f, 'water', x, y, 2) > 0) return 0;
    const hard = count(f, 'high', x, y, 3);
    if (hard < 3) return 0;
    return 0.8 + hard * 0.07 + f.slope[i] * 3;
  },

  // Гейзер: ровное место у самых гор — тепло приходит снизу, а выброс должен
  // быть виден, а не спрятан в скалах.
  geyser(f, x, y, i) {
    const t = f.tiles[i];
    if (t !== TILE.GRASS && t !== TILE.SAND && t !== TILE.HILL) return 0;
    if (f.slope[i] > 0.06) return 0;
    const near = count(f, 'mtn', x, y, 4);
    if (near < 4) return 0;
    const cold = biomeIs(f, x, y, B_COLD) ? 0.5 : 0;
    return 0.7 + near * 0.05 + cold;
  },

  // Древо-исполин: сердце большого леса, вдали от кромки.
  elder(f, x, y, i) {
    if (f.tiles[i] !== TILE.FOREST) return 0;
    const near = count(f, 'forest', x, y, 2);
    if (near < 20) return 0;
    const good = biomeIs(f, x, y, B_WOOD) ? 0.6 : 0;
    return 0.6 + near * 0.03 + good;
  },

  // Руины: ровное обжитое место — где могли жить до нас, там можно жить и нам.
  // Оттого руины стоят на хорошей земле, а не в гольцах.
  ruins(f, x, y, i) {
    const t = f.tiles[i];
    if (t !== TILE.GRASS && t !== TILE.HILL && t !== TILE.SAND) return 0;
    if (f.slope[i] > 0.05) return 0;
    if (!biomeIs(f, x, y, B_LIVED)) return 0;
    const flat = count(f, 'soft', x, y, 2);
    if (flat < 20) return 0;
    return 0.5 + flat * 0.02 + (f.dsea[i] < 6 ? 0.4 : 0);
  },

  // Менгиры: открытая возвышенность, откуда видно округу. Народ, который их
  // ставил, выбирал место не за плодородие.
  menhir(f, x, y, i) {
    const t = f.tiles[i];
    if (t !== TILE.GRASS && t !== TILE.HILL) return 0;
    if (f.slope[i] > 0.05) return 0;
    const open = count(f, 'open', x, y, 2);
    if (open < 16) return 0;
    return 0.4 + open * 0.02 + f.hgt[i] * 0.8;
  },
};

// Порядок обхода родов фиксирован раз и навсегда: он входит в джиттер выбора,
// и его перестановка сдвинула бы ориентиры на всех уже сыгранных сидах.
const KIND_LIST = Object.keys(SCORE);

// ===========================================================================
// РИСОВАНИЕ
//
// Все размеры — в долях клетки U. Свет всегда сверху-слева под 45° (канон §5.1):
// освещённые грани — левые и верхние, тень уходит вправо-вниз, контактная тень
// касается основания. Каждый силуэт проверен правилом «залей чёрным»: пик,
// конус, арка, колоннада, крона читаются одной формой.
// ===========================================================================

function poly(c, p) {
  c.beginPath();
  c.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1]);
  c.closePath();
}
function fillPoly(c, p, style) { poly(c, p); c.fillStyle = style; c.fill(); }
// Контактная тень: цвет земли, умноженный вниз, плюс капля синевы от неба —
// чёрной тени в проекте нет (§5.4).
function contact(c, x, y, rx, ry, a) {
  c.fillStyle = `rgba(38,34,44,${a})`;
  c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 7); c.fill();
}
// Пятно вытоптанной или выжженной земли под ориентиром: без него объект
// выглядит наклейкой поверх травы.
function ground(c, x, y, rx, ry, hex, a) {
  c.fillStyle = alpha(hex, a);
  c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 7); c.fill();
}

// --- один горный конус: тёмная правая грань, светлая левая, снег --------
function cone(c, x, apexY, baseY, w, P, snow, D) {
  const h = baseY - apexY;
  // тень на землю вправо-вниз
  fillPoly(c, [x, apexY, x + w * 1.75, baseY, x - w * 0.1, baseY], 'rgba(30,26,32,0.22)');
  // тёмный правый склон с изломом гребня
  fillPoly(c, [x, apexY, x + w * 0.44, apexY + h * 0.44, x + w, baseY, x - w * 0.14, baseY], P.rockLo);
  // светлый левый склон
  fillPoly(c, [x, apexY, x - w * 0.14, baseY, x - w, baseY, x - w * 0.38, apexY + h * 0.38], P.rockHi);
  // грань между склонами — тонкий гребень
  if (D >= 1) {
    c.strokeStyle = alpha(MAT.basaltLo, 0.35);
    c.lineWidth = Math.max(1, w * 0.03);
    c.beginPath();
    c.moveTo(x, apexY);
    c.lineTo(x + w * 0.44, apexY + h * 0.44);
    c.lineTo(x + w * 0.2, baseY);
    c.stroke();
  }
  if (snow) {
    const sy = apexY + h * 0.24;
    fillPoly(c, [
      x, apexY,
      x + w * 0.30, sy, x + w * 0.13, sy - h * 0.05,
      x - w * 0.10, sy + h * 0.04, x - w * 0.30, sy,
    ], MAT.snow);
  }
}

// ---------------------------------------------------------------------------
// 1. ГОРНЫЙ ПИК И ПЕРЕВАЛ
// Две вершины разной высоты и седловина между ними: именно перевал делает
// хребет хребтом, а не одиноким треугольником, и именно он читается на карте
// как «здесь можно пройти».
// ---------------------------------------------------------------------------
function drawPeak(c, X, Y, U, P, season, D, r) {
  const baseY = Y + U * 0.15;
  const mainX = X - U * 0.55, mainY = baseY - U * (3.1 + r[0] * 0.7);
  const sideX = X + U * 1.45, sideY = baseY - U * (1.9 + r[1] * 0.5);
  const saddleY = baseY - U * (1.15 + r[2] * 0.25);

  contact(c, X + U * 0.55, baseY + U * 0.12, U * 3.0, U * 0.62, 0.24);
  // основание хребта: широкая масса со сколами, поверх неё встают вершины
  fillPoly(c, [
    X - U * 2.9, baseY,
    X - U * 2.0, baseY - U * (0.7 + r[3] * 0.3),
    mainX, mainY + U * 0.9,
    X + U * 0.5, saddleY,
    sideX, sideY + U * 0.5,
    X + U * 2.2, baseY - U * (0.5 + r[4] * 0.3),
    X + U * 2.9, baseY,
  ], P.rock);
  // осыпь у подножия — переход к земле, а не срез по линейке
  if (D >= 1) {
    c.fillStyle = alpha(P.rockLo, 0.45);
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      c.beginPath();
      c.ellipse(X - U * 2.6 + U * 5.2 * t, baseY + U * (0.05 + r[5 + i] * 0.12),
        U * (0.16 + r[8 + i] * 0.16), U * 0.07, 0, 0, 7);
      c.fill();
    }
  }
  // младшая вершина уходит за старшую — глубина без единого лишнего слоя
  cone(c, sideX, sideY, baseY, U * 1.05, P, true, D);
  // седловина: тень в проёме и светлая нитка тропы через перевал
  fillPoly(c, [X + U * 0.15, saddleY + U * 0.1, X + U * 0.95, saddleY + U * 0.1,
    X + U * 0.75, baseY, X + U * 0.35, baseY], alpha(P.rockLo, 0.55));
  if (D >= 1) {
    c.strokeStyle = alpha(P.rockDet, 0.5);
    c.lineWidth = Math.max(1, U * 0.045);
    c.beginPath();
    c.moveTo(X - U * 0.1, baseY - U * 0.1);
    c.quadraticCurveTo(X + U * 0.55, saddleY + U * 0.35, X + U * 1.25, baseY - U * 0.2);
    c.stroke();
  }
  cone(c, mainX, mainY, baseY, U * 1.6, P, true, D);
  // одинокая ель у подножия даёт масштаб: без неё пик читается как камешек
  if (D >= 2) smallTree(c, X - U * 2.35, baseY + U * 0.05, U * 0.32, P, season);
}

// ---------------------------------------------------------------------------
// 2. ВУЛКАН
// Усечённый конус, кратер, лавовые потёки по одному склону и пепловый передник
// у подножия. Дым живёт в drawLive.
// ---------------------------------------------------------------------------
function drawVolcano(c, X, Y, U, P, season, D, r) {
  const baseY = Y + U * 0.15;
  const topY = baseY - U * (2.5 + r[0] * 0.4);
  const rimW = U * (0.62 + r[1] * 0.12);
  const baseW = U * 2.5;

  contact(c, X + U * 0.5, baseY + U * 0.12, U * 2.7, U * 0.6, 0.26);
  // пепловый передник: земля вокруг вулкана мертва и темна
  ground(c, X, baseY - U * 0.05, U * 3.1, U * 0.85, MAT.ash, 0.4);
  // тень конуса вправо-вниз
  fillPoly(c, [X - rimW, topY, X + rimW, topY, X + baseW * 1.5, baseY, X + baseW * 0.1, baseY],
    'rgba(28,24,28,0.25)');
  // тело конуса: тёмный правый склон
  fillPoly(c, [X - rimW, topY, X + rimW, topY, X + baseW, baseY, X - baseW * 0.15, baseY], MAT.basalt);
  // освещённый левый склон
  fillPoly(c, [X - rimW, topY, X - baseW * 0.15, baseY, X - baseW, baseY, X - rimW * 1.1, topY + U * 0.05],
    MAT.basaltHi);
  // рытвины по склону — конус перестаёт быть гладкой пирамидой
  if (D >= 1) {
    c.strokeStyle = alpha(MAT.basaltLo, 0.4);
    c.lineWidth = Math.max(1, U * 0.04);
    for (let i = 0; i < 4; i++) {
      const k = -0.7 + i * 0.5 + r[2 + i] * 0.2;
      c.beginPath();
      c.moveTo(X + rimW * k, topY + U * 0.08);
      c.quadraticCurveTo(X + baseW * k * 0.7, baseY - U * 0.9, X + baseW * k * 0.95, baseY);
      c.stroke();
    }
  }
  // кратер: тёмное жерло, освещённая левая кромка, раскалённая глубина
  c.fillStyle = MAT.basaltLo;
  c.beginPath(); c.ellipse(X, topY, rimW, rimW * 0.42, 0, 0, 7); c.fill();
  c.fillStyle = alpha(MAT.lavaDark, 0.9);
  c.beginPath(); c.ellipse(X, topY + rimW * 0.06, rimW * 0.66, rimW * 0.26, 0, 0, 7); c.fill();
  c.fillStyle = MAT.lava;
  c.beginPath(); c.ellipse(X, topY + rimW * 0.06, rimW * 0.4, rimW * 0.15, 0, 0, 7); c.fill();
  c.fillStyle = MAT.lavaHot;
  c.beginPath(); c.ellipse(X - rimW * 0.08, topY + rimW * 0.04, rimW * 0.17, rimW * 0.07, 0, 0, 7); c.fill();
  c.strokeStyle = alpha(MAT.basaltHi, 0.7);
  c.lineWidth = Math.max(1, U * 0.05);
  c.beginPath(); c.ellipse(X, topY, rimW, rimW * 0.42, 0, Math.PI * 0.9, Math.PI * 2.1); c.stroke();

  // Лавовый потёк: единственный акцентный цвет в кадре и меньше процента
  // площади — правило дефицита §2.3 соблюдено.
  if (D >= 1) {
    const side = r[6] > 0.5 ? 1 : -1;
    c.lineCap = 'round';
    for (let i = 0; i < 2; i++) {
      const off = side * (0.25 + i * 0.3);
      c.strokeStyle = i === 0 ? MAT.lava : alpha(MAT.lavaDark, 0.8);
      c.lineWidth = Math.max(1, U * (0.075 - i * 0.025));
      c.beginPath();
      c.moveTo(X + rimW * off * 0.8, topY + rimW * 0.2);
      c.quadraticCurveTo(X + baseW * off * 0.6, baseY - U * 1.0,
        X + baseW * off * (0.8 + r[7] * 0.2), baseY - U * 0.05);
      c.stroke();
    }
    c.strokeStyle = alpha(MAT.lavaHot, 0.75);
    c.lineWidth = Math.max(1, U * 0.028);
    c.beginPath();
    c.moveTo(X + rimW * side * 0.2, topY + rimW * 0.2);
    c.quadraticCurveTo(X + baseW * side * 0.48, baseY - U * 1.05, X + baseW * side * 0.64, baseY - U * 0.3);
    c.stroke();
  }
  // Зимой снег ложится только на подветренную сторону и не доходит до кратера:
  // гора тёплая. Мелочь, но именно она отличает вулкан от обычной вершины.
  if (P.winter) {
    c.fillStyle = alpha(MAT.snow, 0.7);
    fillPoly(c, [X - rimW * 1.05, topY + U * 0.5, X - baseW * 0.55, baseY - U * 0.2,
      X - baseW * 0.85, baseY - U * 0.05, X - rimW * 1.3, topY + U * 0.75], alpha(MAT.snow, 0.7));
  }
}

// ---------------------------------------------------------------------------
// 3. УЩЕЛЬЕ
// Тёмная извилистая щель со слоистыми стенками: освещённая кромка слева-сверху,
// глубокая тень справа. На дальнем зуме читается как тёмный шрам на светлой земле.
// ---------------------------------------------------------------------------
function drawCanyon(c, X, Y, U, P, season, D, r) {
  const ang = r[0] * Math.PI;               // направление щели
  const dx = Math.cos(ang), dy = Math.sin(ang) * 0.7;
  const nx = -dy, ny = dx;
  const L = U * 3.4;
  const N = 7;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N - 0.5;
    const wob = (r[1 + i] - 0.5) * U * 0.5;   // меандр: прямая щель выглядит рвом
    pts.push({
      x: X + dx * L * t * 2 + nx * wob,
      y: Y + dy * L * t * 2 + ny * wob,
      w: U * (0.42 + 0.26 * Math.cos(t * 3.0)),
    });
  }
  // земля вокруг подсушена и обесцвечена
  ground(c, X, Y, L * 1.05, L * 0.7, MAT.ochreLo, 0.22);

  const edge = (k) => {
    c.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const px = p.x + nx * p.w * k, py = p.y + ny * p.w * k;
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      c.lineTo(p.x - nx * p.w * k, p.y - ny * p.w * k);
    }
    c.closePath();
  };

  // 1) внешний развал: порода вокруг провала выветрена и светлее
  edge(1.55); c.fillStyle = alpha(MAT.ochre, 0.5); c.fill();
  // 2) стенки: поперечный градиент даёт объём одной заливкой
  const g = c.createLinearGradient(X - nx * U * 0.8, Y - ny * U * 0.8, X + nx * U * 0.8, Y + ny * U * 0.8);
  g.addColorStop(0, MAT.ochreHi);
  g.addColorStop(0.35, MAT.band);
  g.addColorStop(0.72, mul(MAT.ochreLo, 0.55));
  g.addColorStop(1, mul(MAT.ochreLo, 0.75));
  edge(1.0); c.fillStyle = g; c.fill();
  // 3) сама щель: почти чёрное дно
  edge(0.42); c.fillStyle = mul(MAT.ochreLo, 0.28); c.fill();
  // 4) сухое русло по дну — светлая нитка на дне тени
  if (D >= 1) {
    c.strokeStyle = alpha(P.sand, 0.35);
    c.lineWidth = Math.max(1, U * 0.05);
    c.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
    }
    c.stroke();
    // 5) слои породы вдоль стенки
    c.strokeStyle = alpha(MAT.band, 0.45);
    c.lineWidth = Math.max(1, U * 0.035);
    for (const k of [0.72, 1.2]) {
      c.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const px = p.x - nx * p.w * k, py = p.y - ny * p.w * k;
        if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
      c.stroke();
    }
  }
  // 6) освещённая кромка слева-сверху
  c.strokeStyle = alpha(MAT.ochreHi, 0.8);
  c.lineWidth = Math.max(1, U * 0.05);
  c.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const px = p.x - nx * p.w * 1.02, py = p.y - ny * p.w * 1.02;
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
  c.stroke();
}

// ---------------------------------------------------------------------------
// 4. ВОДОПАД
// Уступ поперёк русла, белая лента падающей воды, котёл с пеной. Водяная пыль
// добавляется живым слоем, но силуэт читается и без неё.
// ---------------------------------------------------------------------------
function drawWaterfall(c, X, Y, U, P, season, D, r) {
  const topY = Y - U * 1.35, botY = Y + U * 0.25;
  const w = U * 1.5;
  // скальный уступ: тёмная стенка со слоями и освещённой верхней кромкой
  fillPoly(c, [X - w, topY, X + w, topY, X + w * 1.1, botY, X - w * 1.05, botY], P.rockLo);
  fillPoly(c, [X - w, topY, X + w, topY, X + w * 0.96, topY + U * 0.18, X - w * 0.98, topY + U * 0.2], P.rockHi);
  if (D >= 1) {
    c.strokeStyle = alpha(MAT.basaltLo, 0.4);
    c.lineWidth = Math.max(1, U * 0.035);
    for (let i = 1; i <= 2; i++) {
      const yy = topY + (botY - topY) * (i / 3);
      c.beginPath();
      c.moveTo(X - w * (0.95 + r[i] * 0.1), yy);
      c.lineTo(X + w * (0.9 + r[i + 2] * 0.15), yy + U * 0.06);
      c.stroke();
    }
  }
  // верхний плёс: вода подходит к обрыву
  c.fillStyle = P.water;
  c.beginPath(); c.ellipse(X, topY - U * 0.02, w * 0.85, U * 0.18, 0, 0, 7); c.fill();
  // лента падуна: расширяется книзу и распадается на струи
  const fw = U * 0.42;
  fillPoly(c, [X - fw * 0.7, topY, X + fw * 0.7, topY, X + fw * 1.15, botY, X - fw * 1.1, botY],
    alpha(MAT.foam, 0.9));
  if (D >= 1) {
    c.strokeStyle = alpha('#ffffff', 0.55);
    c.lineWidth = Math.max(1, U * 0.045);
    for (let i = 0; i < 3; i++) {
      const k = (i - 1) * 0.42;
      c.beginPath();
      c.moveTo(X + fw * k * 0.7, topY + U * 0.05);
      c.quadraticCurveTo(X + fw * k, (topY + botY) / 2, X + fw * k * 1.15, botY - U * 0.08);
      c.stroke();
    }
  }
  // котёл: тёмная вода, пенное кольцо, круги от удара
  c.fillStyle = P.deep;
  c.beginPath(); c.ellipse(X, botY + U * 0.05, U * 0.85, U * 0.4, 0, 0, 7); c.fill();
  c.strokeStyle = alpha(MAT.foam, 0.65);
  c.lineWidth = Math.max(1, U * 0.06);
  c.beginPath(); c.ellipse(X, botY + U * 0.05, U * 0.5, U * 0.22, 0, 0, 7); c.stroke();
  if (D >= 1) {
    c.strokeStyle = alpha(MAT.foam, 0.3);
    c.lineWidth = Math.max(1, U * 0.035);
    c.beginPath(); c.ellipse(X, botY + U * 0.08, U * 0.78, U * 0.34, 0, 0, 7); c.stroke();
  }
  // статичная дымка: ориентир обязан читаться и на eco, где живого слоя нет
  c.fillStyle = alpha(MAT.foam, 0.16);
  c.beginPath(); c.ellipse(X, botY - U * 0.2, U * 1.1, U * 0.5, 0, 0, 7); c.fill();
}

// ---------------------------------------------------------------------------
// 5. ОАЗИС
// Кольцо мокрого песка, вода, тростник и четыре пальмы. Пальма — самый
// узнаваемый силуэт пустыни: тонкий изогнутый ствол и веер листьев.
// ---------------------------------------------------------------------------
function drawOasis(c, X, Y, U, P, season, D, r) {
  ground(c, X, Y, U * 2.0, U * 1.35, mul(P.sandLo, 0.9), 0.5);
  ground(c, X, Y, U * 1.5, U * 1.0, MAT.moss, 0.28);
  // вода: глубина к центру, светлая кромка на подветренной стороне
  const g = c.createRadialGradient(X - U * 0.2, Y - U * 0.12, U * 0.05, X, Y, U * 0.95);
  g.addColorStop(0, P.waterHi);
  g.addColorStop(0.55, P.water);
  g.addColorStop(1, P.deep);
  c.fillStyle = g;
  c.beginPath(); c.ellipse(X, Y, U * 0.95, U * 0.6, 0, 0, 7); c.fill();
  c.strokeStyle = alpha(MAT.foam, 0.35);
  c.lineWidth = Math.max(1, U * 0.04);
  c.beginPath(); c.ellipse(X, Y, U * 0.95, U * 0.6, 0, Math.PI * 0.85, Math.PI * 1.95); c.stroke();
  // тростник по кромке
  if (D >= 1) {
    c.strokeStyle = alpha(P.leafLo, 0.8);
    c.lineWidth = Math.max(1, U * 0.03);
    for (let i = 0; i < 7; i++) {
      const a = r[i] * 6.28;
      const bx = X + Math.cos(a) * U * 1.0, by = Y + Math.sin(a) * U * 0.66;
      c.beginPath();
      c.moveTo(bx, by);
      c.quadraticCurveTo(bx + U * 0.03, by - U * 0.2, bx + U * 0.08, by - U * 0.34);
      c.stroke();
    }
  }
  // пальмы: три-четыре, разной высоты, вокруг воды
  const n = 3 + (r[10] > 0.5 ? 1 : 0);
  const list = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 6.28 + r[11] * 6.28;
    list.push({
      x: X + Math.cos(a) * U * (1.05 + r[12 + i] * 0.35),
      y: Y + Math.sin(a) * U * (0.68 + r[16 + i] * 0.24),
      h: U * (1.25 + r[12 + i] * 0.5),
      bend: (Math.cos(a) > 0 ? 1 : -1) * (0.14 + r[16 + i] * 0.12),
    });
  }
  list.sort((a, b) => a.y - b.y);
  for (const p of list) palm(c, p.x, p.y, p.h, p.bend, P, D);
}

function palm(c, x, y, h, bend, P, D) {
  contact(c, x + h * 0.18, y + h * 0.03, h * 0.34, h * 0.1, 0.22);
  const topX = x + h * bend, topY = y - h;
  // ствол с кольцами
  c.strokeStyle = mix('#7a5c3c', P.sandLo, 0.25);
  c.lineWidth = Math.max(1.2, h * 0.085);
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(x, y);
  c.quadraticCurveTo(x + h * bend * 0.3, y - h * 0.55, topX, topY);
  c.stroke();
  if (D >= 1) {
    c.strokeStyle = alpha('#5a422a', 0.5);
    c.lineWidth = Math.max(1, h * 0.03);
    for (let i = 1; i <= 3; i++) {
      const t = i / 4;
      const px = x + (topX - x) * t + h * bend * 0.1, py = y - h * t;
      c.beginPath(); c.moveTo(px - h * 0.05, py); c.lineTo(px + h * 0.05, py - h * 0.015); c.stroke();
    }
  }
  // крона: шесть листьев веером, тёмные снизу, светлые сверху-слева
  const F = 6;
  for (let i = 0; i < F; i++) {
    const a = Math.PI * (0.12 + i / (F - 1) * 0.76);
    const lx = topX - Math.cos(a) * h * 0.62, ly = topY - Math.sin(a) * h * 0.34;
    c.strokeStyle = i < 2 ? P.leafHi : i < 4 ? P.leaf : P.leafLo;
    c.lineWidth = Math.max(1.2, h * 0.075);
    c.beginPath();
    c.moveTo(topX, topY);
    c.quadraticCurveTo((topX + lx) / 2, ly - h * 0.16, lx, ly + h * 0.08);
    c.stroke();
  }
  // гроздь фиников — след жизни, §1.5
  if (D >= 2) {
    c.fillStyle = alpha('#8a5a2a', 0.85);
    c.beginPath(); c.ellipse(topX + h * 0.06, topY + h * 0.08, h * 0.06, h * 0.05, 0, 0, 7); c.fill();
  }
}

// ---------------------------------------------------------------------------
// 6. СОЛОНЧАК
// Светлое пятно с сеткой трещин и мочажиной рассола. Самый простой силуэт из
// всех и самый заметный с дальнего зума: белое на охре.
// ---------------------------------------------------------------------------
function drawSaltflat(c, X, Y, U, P, season, D, r) {
  const R = U * 2.4;
  // край корки неровный: десять точек по кругу с разбросом
  const pts = [];
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * 6.28;
    const k = 0.72 + r[i] * 0.45;
    pts.push(X + Math.cos(a) * R * k, Y + Math.sin(a) * R * k * 0.66);
  }
  // тёмная кайма мокрой земли — корка лежит в блюдце, а не на ровном месте
  c.fillStyle = alpha(MAT.saltLo, 0.5);
  poly(c, pts.map((v, i) => (i % 2 ? v + U * 0.06 : v + U * 0.05)));
  c.fill();
  fillPoly(c, pts, MAT.salt);
  // светлая середина: соль выцветает к центру
  const g = c.createRadialGradient(X - R * 0.15, Y - R * 0.1, 0, X, Y, R);
  g.addColorStop(0, alpha(MAT.saltHi, 0.9));
  g.addColorStop(1, alpha(MAT.saltHi, 0));
  c.fillStyle = g;
  poly(c, pts); c.fill();

  if (D >= 1) {
    // многоугольники высыхания: узлы на двух кольцах, между ними — швы
    c.strokeStyle = alpha(MAT.saltLo, 0.65);
    c.lineWidth = Math.max(1, U * 0.03);
    const ring = (rad, n, ph) => {
      const o = [];
      for (let i = 0; i < n; i++) {
        const a = i / n * 6.28 + ph;
        const k = 0.85 + r[(i * 3) % 24] * 0.3;
        o.push({ x: X + Math.cos(a) * rad * k, y: Y + Math.sin(a) * rad * k * 0.66 });
      }
      return o;
    };
    const r1 = ring(R * 0.34, 6, r[0] * 3), r2 = ring(R * 0.74, 10, r[1] * 3);
    c.beginPath();
    for (let i = 0; i < r1.length; i++) {
      const a = r1[i], b = r1[(i + 1) % r1.length];
      c.moveTo(a.x, a.y); c.lineTo(b.x, b.y);
    }
    for (let i = 0; i < r2.length; i++) {
      const a = r2[i], b = r2[(i + 1) % r2.length];
      c.moveTo(a.x, a.y); c.lineTo(b.x, b.y);
      const m = r1[i % r1.length];
      c.moveTo(a.x, a.y); c.lineTo(m.x, m.y);
    }
    c.stroke();
  }
  // мочажина рассола: единственное тёмное пятно, оно и держит контраст
  c.fillStyle = alpha(MAT.brine, 0.75);
  c.beginPath();
  c.ellipse(X + R * (r[2] - 0.5) * 0.5, Y + R * (r[3] - 0.5) * 0.4, R * 0.26, R * 0.14, r[4] * 3, 0, 7);
  c.fill();
  c.strokeStyle = alpha(MAT.saltHi, 0.8);
  c.lineWidth = Math.max(1, U * 0.035);
  c.stroke();
  // соляные наплывы по освещённой кромке
  if (D >= 2) {
    c.fillStyle = alpha('#ffffff', 0.5);
    for (let i = 0; i < 5; i++) {
      const a = Math.PI * (0.9 + r[5 + i] * 0.9);
      c.beginPath();
      c.ellipse(X + Math.cos(a) * R * 0.8, Y + Math.sin(a) * R * 0.55, U * 0.16, U * 0.06, a, 0, 7);
      c.fill();
    }
  }
}

// ---------------------------------------------------------------------------
// 7. КАМЕННАЯ АРКА И СТОЛБЫ ВЫВЕТРИВАНИЯ
// Арка — единственный силуэт в игре с дыркой посередине, и именно поэтому она
// запоминается. Рядом два столба-гриба: одна порода, одна история.
// ---------------------------------------------------------------------------
function drawArch(c, X, Y, U, P, season, D, r) {
  const baseY = Y + U * 0.1;
  const topY = baseY - U * (1.7 + r[0] * 0.4);
  const legW = U * 0.34;
  const span = U * 1.05;

  ground(c, X, baseY, U * 2.2, U * 0.7, MAT.ochreLo, 0.3);
  contact(c, X + U * 0.5, baseY + U * 0.08, U * 1.7, U * 0.34, 0.2);

  // тело арки: две ноги и перемычка, нарисованные одним контуром, чтобы
  // проём остался настоящей дыркой, а не закрашенным пятном
  c.beginPath();
  c.moveTo(X - span - legW, baseY);
  c.lineTo(X - span - legW * 0.75, topY + U * 0.35);
  c.quadraticCurveTo(X, topY - U * 0.35, X + span + legW * 0.75, topY + U * 0.35);
  c.lineTo(X + span + legW, baseY);
  c.lineTo(X + span - legW * 0.35, baseY);
  c.lineTo(X + span - legW * 0.5, topY + U * 0.62);
  c.quadraticCurveTo(X, topY + U * 0.28, X - span + legW * 0.5, topY + U * 0.62);
  c.lineTo(X - span + legW * 0.3, baseY);
  c.closePath();
  c.fillStyle = MAT.ochre; c.fill();

  // теневая правая сторона: тот же контур, сдвинутый и приглушённый
  c.save();
  c.clip();
  c.fillStyle = alpha(MAT.ochreLo, 0.75);
  c.fillRect(X + span - legW * 0.6, topY - U, U * 2.2, U * 4);
  c.fillRect(X - span + legW * 0.05, topY - U, legW * 0.45, U * 4);
  // слои породы: горизонтальные полосы, по ним арка читается как песчаник
  if (D >= 1) {
    c.fillStyle = alpha(MAT.band, 0.35);
    for (let i = 0; i < 4; i++) {
      const yy = topY + U * (0.15 + i * 0.45 + r[1 + i] * 0.1);
      c.fillRect(X - span - legW * 1.4, yy, span * 2 + legW * 3, U * 0.09);
    }
  }
  c.restore();
  // освещённая левая кромка
  c.strokeStyle = alpha(MAT.ochreHi, 0.85);
  c.lineWidth = Math.max(1, U * 0.055);
  c.beginPath();
  c.moveTo(X - span - legW, baseY);
  c.lineTo(X - span - legW * 0.75, topY + U * 0.35);
  c.quadraticCurveTo(X - span * 0.4, topY - U * 0.2, X - span * 0.05, topY - U * 0.28);
  c.stroke();
  // тень проёма на земле — арка стоит, а не висит
  c.fillStyle = 'rgba(38,34,44,0.16)';
  c.beginPath();
  c.ellipse(X + U * 0.35, baseY + U * 0.02, span * 0.9, U * 0.16, 0, 0, 7);
  c.fill();

  // столбы выветривания рядом: тонкая ножка, тяжёлая шляпка
  const hood = (hx, hy, hh, hw) => {
    contact(c, hx + hh * 0.2, hy + hh * 0.03, hw * 1.4, hh * 0.09, 0.2);
    fillPoly(c, [hx - hw * 0.3, hy, hx + hw * 0.3, hy, hx + hw * 0.22, hy - hh * 0.75,
      hx - hw * 0.22, hy - hh * 0.75], MAT.ochre);
    fillPoly(c, [hx - hw * 0.3, hy, hx - hw * 0.06, hy, hx - hw * 0.05, hy - hh * 0.75,
      hx - hw * 0.22, hy - hh * 0.75], MAT.ochreHi);
    fillPoly(c, [hx - hw * 0.55, hy - hh * 0.75, hx + hw * 0.55, hy - hh * 0.75,
      hx + hw * 0.42, hy - hh, hx - hw * 0.42, hy - hh], MAT.ochreLo);
    fillPoly(c, [hx - hw * 0.55, hy - hh * 0.75, hx - hw * 0.15, hy - hh * 0.75,
      hx - hw * 0.2, hy - hh, hx - hw * 0.42, hy - hh], MAT.ochreHi);
  };
  hood(X - U * (1.9 + r[6] * 0.3), baseY + U * 0.12, U * (1.0 + r[7] * 0.4), U * 0.38);
  if (D >= 1) hood(X + U * (2.0 + r[8] * 0.3), baseY - U * 0.05, U * (0.7 + r[9] * 0.3), U * 0.3);
}

// ---------------------------------------------------------------------------
// 8. ГЕЙЗЕР
// Натёчные террасы, горячая ванна и парок. Маленький объект, поэтому силуэт
// ему даёт светлое кольцо гейзерита и столб пара из живого слоя.
// ---------------------------------------------------------------------------
function drawGeyser(c, X, Y, U, P, season, D, r) {
  ground(c, X, Y, U * 1.5, U * 0.9, MAT.sinter, 0.55);
  // террасы: три кольца, каждое чуть выше предыдущего
  for (let i = 2; i >= 0; i--) {
    const rr = U * (0.5 + i * 0.34);
    c.fillStyle = i % 2 ? MAT.sinter : MAT.sinterHi;
    c.beginPath(); c.ellipse(X, Y - i * U * 0.06, rr, rr * 0.6, 0, 0, 7); c.fill();
    c.strokeStyle = alpha(mul(MAT.sinter, 0.7), 0.6);
    c.lineWidth = Math.max(1, U * 0.03);
    c.stroke();
  }
  // ванна: мутно-бирюзовая вода с тёмным жерлом
  c.fillStyle = MAT.hot;
  c.beginPath(); c.ellipse(X, Y - U * 0.14, U * 0.36, U * 0.2, 0, 0, 7); c.fill();
  c.fillStyle = alpha(mul(MAT.hot, 0.45), 0.9);
  c.beginPath(); c.ellipse(X, Y - U * 0.15, U * 0.16, U * 0.09, 0, 0, 7); c.fill();
  c.strokeStyle = alpha('#ffffff', 0.5);
  c.lineWidth = Math.max(1, U * 0.03);
  c.beginPath(); c.ellipse(X, Y - U * 0.14, U * 0.36, U * 0.2, 0, Math.PI * 0.9, Math.PI * 2.0); c.stroke();
  // натёки по склону — вода стекает вниз-вправо
  if (D >= 1) {
    c.strokeStyle = alpha(MAT.sinterHi, 0.7);
    c.lineWidth = Math.max(1, U * 0.045);
    for (let i = 0; i < 3; i++) {
      const a = Math.PI * (0.1 + r[i] * 0.8);
      c.beginPath();
      c.moveTo(X + Math.cos(a) * U * 0.3, Y + Math.sin(a) * U * 0.16);
      c.lineTo(X + Math.cos(a) * U * 1.1, Y + Math.sin(a) * U * 0.62);
      c.stroke();
    }
  }
  // статичный парок: без него на eco место читается просто как лужа
  c.fillStyle = alpha('#ffffff', 0.14);
  for (let i = 0; i < 3; i++) {
    c.beginPath();
    c.ellipse(X + (r[4 + i] - 0.5) * U * 0.3, Y - U * (0.4 + i * 0.42),
      U * (0.22 + i * 0.1), U * (0.16 + i * 0.08), 0, 0, 7);
    c.fill();
  }
}

// ---------------------------------------------------------------------------
// 9. ДРЕВО-ИСПОЛИН
// Одно дерево размером с рощу: толстый ствол с корнями-контрфорсами и крона в
// три тона. Рядом — обычные деревья, чтобы масштаб читался сравнением.
// ---------------------------------------------------------------------------
function drawElder(c, X, Y, U, P, season, D, r) {
  const baseY = Y + U * 0.1;
  const trunkH = U * 1.5, trunkW = U * 0.3;
  const crownY = baseY - trunkH - U * 0.9;

  contact(c, X + U * 0.7, baseY + U * 0.05, U * 1.9, U * 0.5, 0.26);
  ground(c, X, baseY, U * 1.7, U * 0.8, mul(P.leafLo, 0.8), 0.3);

  // корни-контрфорсы: три треугольника у основания
  const bark = P.winter ? '#4a4038' : '#5a4432';
  c.fillStyle = mul(bark, 0.85);
  for (let i = 0; i < 3; i++) {
    const k = (i - 1) * 1.0;
    fillPoly(c, [
      X + trunkW * k * 0.7, baseY - trunkH * 0.35,
      X + trunkW * (k * 1.9 + 0.5), baseY,
      X + trunkW * (k * 1.9 - 0.5), baseY,
    ], mul(bark, i === 0 ? 1.15 : 0.8));
  }
  // ствол: светлая левая половина, тёмная правая
  fillPoly(c, [X - trunkW, baseY, X - trunkW * 0.62, baseY - trunkH,
    X + trunkW * 0.62, baseY - trunkH, X + trunkW, baseY], bark);
  fillPoly(c, [X - trunkW, baseY, X - trunkW * 0.62, baseY - trunkH,
    X - trunkW * 0.2, baseY - trunkH, X - trunkW * 0.35, baseY], mul(bark, 1.3));
  // пара толстых ветвей выходит из кроны — один выступ за габарит, §3.1
  c.strokeStyle = bark;
  c.lineWidth = Math.max(1.5, U * 0.09);
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(X - trunkW * 0.3, baseY - trunkH * 0.8);
  c.quadraticCurveTo(X - U * 0.9, baseY - trunkH * 1.1, X - U * 1.25, crownY + U * 0.75);
  c.moveTo(X + trunkW * 0.3, baseY - trunkH * 0.85);
  c.quadraticCurveTo(X + U * 0.9, baseY - trunkH * 1.15, X + U * 1.2, crownY + U * 0.8);
  c.stroke();

  if (P.winter) {
    // зимой крона голая: ветви веером и снег на них
    c.strokeStyle = bark;
    for (let i = 0; i < 9; i++) {
      const a = Math.PI * (1.05 + i / 8 * 0.9);
      c.lineWidth = Math.max(1, U * 0.05);
      c.beginPath();
      c.moveTo(X, baseY - trunkH);
      c.quadraticCurveTo(X + Math.cos(a) * U * 0.6, baseY - trunkH + Math.sin(a) * U * 0.7,
        X + Math.cos(a) * U * 1.3, baseY - trunkH + Math.sin(a) * U * 1.25);
      c.stroke();
    }
    c.strokeStyle = alpha(MAT.snow, 0.75);
    c.lineWidth = Math.max(1, U * 0.03);
    c.beginPath();
    c.moveTo(X - U * 1.1, crownY + U * 1.0);
    c.quadraticCurveTo(X, crownY + U * 0.45, X + U * 1.1, crownY + U * 1.05);
    c.stroke();
    return;
  }

  // крона: семь наплывов в три тона, самый светлый — сверху-слева
  const autumn = season === 2;
  const lo = autumn ? '#8a5a24' : P.leafLo;
  const mid = autumn ? '#b07a2c' : P.leaf;
  const hi = autumn ? '#d8a44a' : P.leafHi;
  const blobs = [
    [0.55, 0.55, 0.95, lo], [-0.6, 0.5, 0.9, lo], [0.05, 0.85, 0.85, lo],
    [0.3, 0.05, 0.85, mid], [-0.35, -0.05, 0.8, mid],
    [-0.15, -0.5, 0.62, hi], [-0.55, -0.25, 0.5, hi],
  ];
  for (const [bx, by, br, col] of blobs) {
    c.fillStyle = col;
    c.beginPath();
    c.ellipse(X + bx * U * 1.25, crownY + by * U * 0.85, br * U * 0.85, br * U * 0.72, 0, 0, 7);
    c.fill();
  }
  // блик на освещённой стороне
  c.fillStyle = 'rgba(255,255,235,0.16)';
  c.beginPath();
  c.ellipse(X - U * 0.7, crownY - U * 0.45, U * 0.42, U * 0.28, -0.5, 0, 7);
  c.fill();
  // обычные деревья у корней — линейка масштаба
  if (D >= 1) {
    smallTree(c, X - U * 1.75, baseY + U * 0.16, U * 0.3, P, season);
    smallTree(c, X + U * 1.7, baseY + U * 0.1, U * 0.26, P, season);
  }
}

// Маленькое дерево — только для сравнения масштаба, поэтому силуэт и два тона.
function smallTree(c, x, y, r, P, season) {
  c.fillStyle = 'rgba(16,26,12,0.28)';
  c.beginPath(); c.ellipse(x + r * 0.5, y + r * 0.25, r * 0.8, r * 0.28, 0, 0, 7); c.fill();
  c.fillStyle = '#4d3a28';
  c.fillRect(x - r * 0.1, y - r * 0.5, r * 0.2, r * 0.75);
  for (let i = 0; i < 3; i++) {
    const w = r * (1.0 - i * 0.26), top = y - r * (0.5 + i * 0.5), base = y - r * (0.05 + i * 0.48);
    fillPoly(c, [x, top, x + w, base, x - w, base], i === 2 ? P.leafHi : P.leaf);
  }
}

// ---------------------------------------------------------------------------
// 10. ДРЕВНИЕ РУИНЫ
// Колоннада на стилобате: часть колонн стоит, часть обломана, архитрав держится
// на двух. Вертикальные штрихи в ряд — силуэт, который ни с чем не спутать.
// ---------------------------------------------------------------------------
function drawRuins(c, X, Y, U, P, season, D, r) {
  const baseY = Y + U * 0.1;
  const W = U * 2.3;

  ground(c, X, baseY, W * 1.15, U * 0.75, MAT.dirt, 0.28);
  contact(c, X + U * 0.4, baseY + U * 0.08, W * 1.0, U * 0.3, 0.2);
  // стилобат: две ступени, верхняя светлее
  fillPoly(c, [X - W, baseY, X + W, baseY, X + W * 0.92, baseY - U * 0.22, X - W * 0.92, baseY - U * 0.22],
    MAT.ruinLo);
  fillPoly(c, [X - W * 0.92, baseY - U * 0.22, X + W * 0.92, baseY - U * 0.22,
    X + W * 0.84, baseY - U * 0.4, X - W * 0.84, baseY - U * 0.4], MAT.ruin);
  c.fillStyle = alpha(MAT.ruinHi, 0.7);
  c.fillRect(X - W * 0.84, baseY - U * 0.42, W * 1.68, U * 0.05);

  const top = baseY - U * 0.4;
  const cols = 6;
  const cw = U * 0.19;
  const heights = [];
  for (let i = 0; i < cols; i++) {
    // Две трети колонн обломаны на разной высоте: ровный ряд одинаковых
    // столбов читается как новостройка, а не как руины.
    const full = r[i] > 0.55;
    heights.push(full ? U * (1.35 + r[i + 6] * 0.2) : U * (0.3 + r[i + 6] * 0.75));
  }
  // архитрав лежит на двух левых колоннах, если обе целы
  if (heights[0] > U * 1.2 && heights[1] > U * 1.2) {
    const hh = Math.min(heights[0], heights[1]);
    c.fillStyle = MAT.ruinLo;
    c.fillRect(X - W * 0.82, top - hh - U * 0.2, cw * 5.2, U * 0.19);
    c.fillStyle = alpha(MAT.ruinHi, 0.8);
    c.fillRect(X - W * 0.82, top - hh - U * 0.2, cw * 5.2, U * 0.05);
  }
  for (let i = 0; i < cols; i++) {
    const cx = X - W * 0.78 + (i / (cols - 1)) * W * 1.56;
    const hh = heights[i];
    // тень колонны вправо-вниз
    fillPoly(c, [cx + cw * 0.5, top, cx + cw * 0.5 + hh * 0.55, top + U * 0.16,
      cx + cw * 1.3 + hh * 0.55, top + U * 0.2, cx + cw * 1.1, top], 'rgba(38,34,44,0.14)');
    c.fillStyle = MAT.ruin;
    c.fillRect(cx - cw * 0.5, top - hh, cw, hh);
    c.fillStyle = MAT.ruinHi;
    c.fillRect(cx - cw * 0.5, top - hh, cw * 0.34, hh);
    c.fillStyle = alpha(MAT.ruinLo, 0.7);
    c.fillRect(cx + cw * 0.18, top - hh, cw * 0.32, hh);
    // капитель у целых, рваный скол у обломанных
    if (hh > U * 1.2) {
      c.fillStyle = MAT.ruinHi;
      c.fillRect(cx - cw * 0.72, top - hh - U * 0.1, cw * 1.44, U * 0.1);
    } else {
      c.fillStyle = MAT.ruinLo;
      fillPoly(c, [cx - cw * 0.5, top - hh, cx - cw * 0.1, top - hh - U * 0.06,
        cx + cw * 0.5, top - hh + U * 0.03, cx + cw * 0.5, top - hh + U * 0.08,
        cx - cw * 0.5, top - hh + U * 0.06], MAT.ruinLo);
    }
    // барабаны кладки
    if (D >= 1 && hh > U * 0.5) {
      c.strokeStyle = alpha(MAT.ruinLo, 0.5);
      c.lineWidth = Math.max(1, U * 0.02);
      for (let k = 1; k * U * 0.4 < hh; k++) {
        c.beginPath();
        c.moveTo(cx - cw * 0.5, top - k * U * 0.4);
        c.lineTo(cx + cw * 0.5, top - k * U * 0.4);
        c.stroke();
      }
    }
  }
  // упавшая колонна перед стилобатом: барабаны раскатились в ряд
  const fy = baseY + U * 0.22;
  for (let i = 0; i < 4; i++) {
    const fx = X - W * 0.5 + i * cw * 1.25 + r[12 + i] * U * 0.08;
    c.fillStyle = MAT.ruin;
    c.beginPath(); c.ellipse(fx, fy, cw * 0.62, cw * 0.5, r[16 + i] * 3, 0, 7); c.fill();
    c.fillStyle = alpha(MAT.ruinHi, 0.75);
    c.beginPath(); c.ellipse(fx - cw * 0.12, fy - cw * 0.12, cw * 0.34, cw * 0.26, 0, 0, 7); c.fill();
  }
  // трава пробилась сквозь плиты — руины живые, а не музейные
  if (D >= 1 && !P.winter) {
    c.strokeStyle = alpha(P.grassDet, 0.75);
    c.lineWidth = Math.max(1, U * 0.03);
    for (let i = 0; i < 8; i++) {
      const gx = X - W * 0.9 + r[i] * W * 1.8, gy = baseY - U * (r[i + 8] > 0.5 ? 0.4 : 0.02);
      c.beginPath();
      c.moveTo(gx, gy);
      c.quadraticCurveTo(gx + U * 0.03, gy - U * 0.09, gx + U * 0.07, gy - U * 0.16);
      c.stroke();
    }
  }
  if (P.winter) {
    c.fillStyle = alpha(MAT.snow, 0.6);
    c.fillRect(X - W * 0.86, top - U * 0.03, W * 1.72, U * 0.06);
  }
}

// ---------------------------------------------------------------------------
// 11. КОЛЬЦО МЕНГИРОВ
// Восемь необработанных камней по эллипсу и один упавший. Круг из вертикалей
// читается на любом зуме и говорит: здесь были люди до нас.
// ---------------------------------------------------------------------------
function drawMenhir(c, X, Y, U, P, season, D, r) {
  const rx = U * 1.5, ry = U * 0.86;
  // насыпь под кругом: трава вытоптана и выгорела
  ground(c, X, Y, rx * 1.3, ry * 1.35, MAT.dirt, 0.26);
  if (D >= 1) {
    c.strokeStyle = alpha(MAT.dirt, 0.4);
    c.lineWidth = Math.max(1, U * 0.06);
    c.beginPath(); c.ellipse(X, Y, rx * 1.05, ry * 1.05, 0, 0, 7); c.stroke();
  }
  const N = 8;
  const stones = [];
  for (let i = 0; i < N; i++) {
    const a = i / N * 6.28 + r[0] * 1.5;
    stones.push({
      x: X + Math.cos(a) * rx, y: Y + Math.sin(a) * ry,
      h: U * (0.75 + r[i + 1] * 0.45), w: U * (0.16 + r[i + 9] * 0.09),
      fallen: i === ((r[17] * N) | 0),
    });
  }
  // дальние камни рисуются первыми — перекрытие даёт глубину
  stones.sort((a, b) => a.y - b.y);
  // алтарный камень в середине
  c.fillStyle = MAT.menhirLo;
  c.beginPath(); c.ellipse(X, Y, U * 0.42, U * 0.2, 0, 0, 7); c.fill();
  c.fillStyle = MAT.menhirHi;
  c.beginPath(); c.ellipse(X - U * 0.05, Y - U * 0.04, U * 0.34, U * 0.15, 0, 0, 7); c.fill();

  for (const s of stones) {
    contact(c, s.x + s.h * 0.2, s.y + U * 0.03, s.w * 1.5, U * 0.09, 0.24);
    if (s.fallen) {
      c.fillStyle = MAT.menhir;
      c.beginPath(); c.ellipse(s.x, s.y, s.h * 0.5, s.w * 0.7, 0.5, 0, 7); c.fill();
      c.fillStyle = alpha(MAT.menhirHi, 0.8);
      c.beginPath(); c.ellipse(s.x - s.h * 0.1, s.y - s.w * 0.2, s.h * 0.34, s.w * 0.36, 0.5, 0, 7); c.fill();
      continue;
    }
    // камень сужается кверху и слегка завален — ни один не стоит по отвесу
    const tilt = (s.x - X) * 0.04;
    fillPoly(c, [
      s.x - s.w, s.y, s.x + s.w, s.y,
      s.x + s.w * 0.66 + tilt, s.y - s.h, s.x - s.w * 0.72 + tilt, s.y - s.h * 0.95,
    ], MAT.menhir);
    fillPoly(c, [
      s.x - s.w, s.y, s.x - s.w * 0.2, s.y,
      s.x - s.w * 0.3 + tilt, s.y - s.h * 0.97, s.x - s.w * 0.72 + tilt, s.y - s.h * 0.95,
    ], MAT.menhirHi);
    if (D >= 1) {
      c.strokeStyle = alpha(MAT.menhirLo, 0.55);
      c.lineWidth = Math.max(1, U * 0.025);
      c.beginPath();
      c.moveTo(s.x - s.w * 0.5, s.y - s.h * 0.35);
      c.lineTo(s.x + s.w * 0.3, s.y - s.h * 0.55);
      c.stroke();
    }
    if (P.winter) {
      c.fillStyle = alpha(MAT.snow, 0.8);
      fillPoly(c, [s.x - s.w * 0.72 + tilt, s.y - s.h * 0.95, s.x + s.w * 0.66 + tilt, s.y - s.h,
        s.x + s.w * 0.6 + tilt, s.y - s.h * 0.88, s.x - s.w * 0.66 + tilt, s.y - s.h * 0.84],
        alpha(MAT.snow, 0.8));
    }
  }
}

const DRAW = {
  peak: drawPeak,
  volcano: drawVolcano,
  canyon: drawCanyon,
  waterfall: drawWaterfall,
  oasis: drawOasis,
  saltflat: drawSaltflat,
  arch: drawArch,
  geyser: drawGeyser,
  elder: drawElder,
  ruins: drawRuins,
  menhir: drawMenhir,
};

/* ПОДКЛЮЧЕНИЕ

Три вставки в terrain.js и одна в renderer.js. Ни одна существующая строка не
меняется и не удаляется: каждая вставка идёт НОВОЙ СТРОКОЙ СРАЗУ ПОСЛЕ якоря.
Якоря проверены на уникальность в своих файлах (grep -c = 1).

═══ app/src/render/terrain.js ═══

--- 1. Импорт ---
ЯКОРЬ (строка 12, единственная в файле):
import { TERRAIN, TILE_HEIGHT, hash2, fbm2, hex2rgb, mixHex } from './palette.js';
ВСТАВИТЬ ПОСЛЕ:
import { LandmarkLayer } from './landmarks.js';

--- 2. Поле в конструкторе Terrain ---
ЯКОРЬ (строка 26, единственная в файле):
    this.road = null;          // сеть дорог: рёбра, пятаки перекрёстков, индекс по чанкам
ВСТАВИТЬ ПОСЛЕ:
    this.landmarks = new LandmarkLayer(quality);  // природные ориентиры: пик, вулкан, оазис…

--- 3. Пересчёт по необходимости, в Terrain.ensure ---
   (после buildHeight — слою нужно готовое поле высот; ensure возвращает true
    только при смене мира, то есть чанки чистятся один раз за партию)
ЯКОРЬ (строка 112, единственная в файле):
    if (!this.low) this.buildLow(sim);
ВСТАВИТЬ ПОСЛЕ:
    if (this.landmarks.ensure(sim, this.q, this.height)) this.chunks.clear();

--- 4. Рисование в выпечке чанка, в конце Terrain.bake ---
   (последним слоем: ориентир стоит НА местности, его не должны перечёркивать
    ни береговая кромка, ни тени обрывов)
ЯКОРЬ — три строки подряд (единственное такое место, строки 213–215):
        this.edges(c, world, pal, x, y, (x - x0) * TP, (y - y0) * TP, TP);
      }
    }
ВСТАВИТЬ ПОСЛЕ:
    this.landmarks.paint(c, sim, x0, y0, TP, CHUNK);

═══ app/src/render/renderer.js ═══

--- 5. Живая часть: дым вулкана, выброс гейзера, пыль водопада, ночное жерло ---
   (после растительности и до зданий: столб дыма поднимается над местностью,
    но житель, идущий мимо, остаётся впереди)
ЯКОРЬ (строка 128, единственная в файле):
    this.veg.draw(sim, ctx, ox, oy, z, cw, ch);
ВСТАВИТЬ ПОСЛЕ:
    this.terrain.landmarks.drawLive(sim, ctx, ox, oy, z, cw, ch, this.time);

--- Чего делать НЕ надо ---
• Отдельного вызова на смену качества нет: ensure принимает пресет параметром.
  Смена пресета и так чистит чанки через terrain.invalidate().
• Отдельного сброса на смену сезона нет: terrain чистит чанки сам, а paint
  каждый раз читает sim.seasonIdx.
• Правок в palette.js и quality.js не требуется. Живой слой сам молчит на eco
  и на зуме меньше 11 пикселей на клетку.

═══ ЧТО ЭТО ДАЁТ СРАЗУ ═══
На карте появляются 3–5 названных мест: «Гора Ворона», «Ущелье Ветров»,
«Оазис Трёх Братьев». Они видны с дальнего зума силуэтом, стоят на своих местах
на одном и том же сиде и не двигаются между сессиями. terrain.landmarks.list()
отдаёт их массивом ({kind, name, ru, x, y, rad}), at(x,y) и describe(x,y) —
готовые ответы для тултипа клетки.

═══ ЧТО СТОИЛО БЫ ДОБАВИТЬ В ЯДРО (модуль этого НЕ делает) ═══
Ориентир должен не только называться, но и что-то значить. Все числа ниже —
предложение, а не сделанная работа: правка ядра здесь запрещена.

Место для правки — simulation.js, там же, где применяются множители биома
(WG2.yieldMult) и счастья. Радиус влияния уже посчитан: landmark.rad клеток.

  ориентир    что даёт в радиусе rad                             почему
  ─────────────────────────────────────────────────────────────────────────────
  оазис       еда ×1.5, счастье +3, снимает штраф пустыни        вода в пустыне
  водопад     с эпохи 2 мельница/ГЭС ставится без реки, ×1.3     напор
  вулкан      еда ×1.25 (пепел), но раз в N лет — событие         плодородный пепел
              «извержение»: −здания в радиусе 2                  и цена за это
  солончак    соль как товар: рынок ×1.2 к золоту; поля ×0.5     соль — валюта
  горный пик  камень ×1.3, оборона +2 у построек в радиусе       высота и порода
  ущелье      стоимость пути ×3 поперёк, ×0.6 вдоль               естественный проход
  гейзер      с эпохи 7 — геотермальная станция без топлива      тепло из-под земли
  руины       разовый бонус знаний при первом посещении +25      чужая наука
  менгиры     счастье +2, культура +1 постоянно                  святое место
  древо       счастье +3; вырубка леса в радиусе даёт −5         дерево-святыня
  арка        счастье +1, ориентир для торговых караванов        примета пути

Ещё одна честная мелочь: describeTile в worldgen2 стоило бы дополнить строкой
ориентира — тогда тултип клетки сам расскажет, что игрок стоит у Горы Ворона.
*/
