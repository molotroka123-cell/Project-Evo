// core/systems/worldgen2.js — БОЛЬШАЯ КАРТА: континенты, острова, реки, биомы (U08).
// Чистый модуль: без DOM, без обращения к Simulation, вся случайность — через
// переданный rng (или через createRng(seed), что тоже детерминировано).
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ СЛОЙ, А НЕ НОВЫЕ ТАЙЛЫ. На семи значениях TILE висят рендер,
// A*, размещение зданий и тесты ядра. Добавить восьмое значение — значит разом
// сломать всё это. Поэтому биомы и реки живут в ПАРАЛЛЕЛЬНЫХ массивах
// (world.biome, world.river) той же длины, что world.tiles: старый код видит
// привычные DEEP..MOUNTAIN и работает как раньше, а новый код спрашивает у
// модуля, что это за земля на самом деле.
//
// ЧТО ДАЁТ КАРТА ИГРЕ (не декорация, а цифры):
//   • биом — множители добычи (пустыня почти не кормит, тайга даёт лес,
//     пойма — лучшие поля) и модификатор счастья: выбор места стал решением;
//   • река — орошение соседних клеток (+фермам) и препятствие: брод замедляет,
//     полноводное русло непроходимо, пока не построен мост;
//   • материк — kто с кем вообще может воевать пешком: sameLandmass() отсекает
//     спавны фракций за океаном, куда армия не дойдёт и A* честно вернёт null.
//
// РАЗМЕР КАРТЫ — ПАРАМЕТР. Всё считается от w/h: число материков, островов и
// рек масштабируется от sqrt(w*h). При 96×96 доля суши и стартовая поляна
// остаются такими же, как у generateWorld, — старые сейвы и тесты не ломаются.
//
// ═══════════════════════════ INTEGRATION ═══════════════════════════
// A) МИНИМАЛЬНЫЙ ПУТЬ — оставить старую карту, добавить слои (ничего не рискуем).
// 1) simulation.js, рядом с прочими импортами:
//      import * as WG2 from './systems/worldgen2.js';
// 2) constructor(), СРАЗУ ПОСЛЕ строки `this.world = generateWorld(...)`:
//      WG2.enrichWorld(this.world, this.seed);   // навешивает biome/river/landmass
//      this.wg2 = WG2.createWorldgenState(this.world);
//    Тайлы при этом НЕ меняются: рендер, A* и размещение зданий работают как были.
//
// B) БОЛЬШАЯ КАРТА — заменить генератор (одна строка вместо generateWorld):
// 2') constructor():
//      this.world = WG2.generateWorld2(this.seed, this.rng, { w: 192, h: 192 });
//      this.wg2 = WG2.createWorldgenState(this.world);
//    generateWorld2 возвращает тот же объект {w,h,tiles,seed,startX,startY} плюс
//    слои, и сам вырезает гарантированную стартовую поляну (трава/лес/холм/гора).
//    ВНИМАНИЕ, ОДНА ЧУЖАЯ СТРОКА. Буферы A* в world.js выделены жёстко на
//    WORLD_W*WORLD_H = 96×96 (_gScore/_cameFrom/_closed/_stamp/_heap*). При карте
//    больше 96×96 записи за границей типизированного массива молча пропадают и
//    поиск пути ломается. Прежде чем ставить w/h > 96, в world.js эти буферы
//    надо выделять по фактическому размеру мира (или просто по 256×256).
//    Пока этого нет — модуль безопасен на 96×96; тест это проверяет.
//
// 3) Добыча. В расчёте выработки здания, там же где применяются aura/weather
//    множители (simulation.js, метод производства зданий) — на каждый ресурс:
//      out *= WG2.yieldMult(this.world, b.x, b.y, resId);
//      if (resId === 'food') out *= WG2.irrigation(this.world, b.x, b.y);
//
// 4) Счастье. В happiness(), рядом с h += this._happyBonus:
//      h += WG2.biomeHappy(this.world, this.world.startX, this.world.startY);
//
// 5) Спавн фракций (simulation.js, где вызывается findFactionSpawns):
//      spawns = spawns.filter(s => WG2.sameLandmass(this.world, s.x, s.y,
//                                 this.world.startX, this.world.startY));
//    Иначе на многоматериковой карте фракция окажется за океаном.
//
// 6) Движение отрядов (army.js, после того как путь получен от aStar):
//      const rp = WG2.riverPath(this.world, this.wg2, path);
//      if (rp.blocked) { /* «Переправы нет: нужен мост» */ }
//      else speed /= rp.slow;   // rp.slow = 1..N, брод замедляет марш
//
// 7) Мост как постройка: WG2.bridgeCost(world, x, y) вернёт стоимость в 🪵/🪨
//    (null, если реки в клетке нет), WG2.buildBridge(state, x, y) поставит.
//
// 8) Сейв. serialize(): `wg2: WG2.serialize(this.wg2),`
//    deserialize(): `sim.wg2 = WG2.deserialize(data.wg2);`
//    Слои карты в сейв НЕ пишутся: они полностью восстанавливаются из сида
//    (enrichWorld/generateWorld2), в сейве живут только мосты — то, что построил игрок.
//
// 9) UI/тултип клетки: WG2.describeTile(world, state, x, y) — готовая русская строка.
// ═══════════════════════════════════════════════════════════════════

import { TILE, WALKABLE } from '../data.js';
import { createRng, makeNoise2D } from '../rng.js';

// ---------------- Биомы ----------------
// Отдельный слой поверх TILE. Значения — индексы в BIOMES.
export const BIOME = {
  OCEAN: 0, COAST: 1, TUNDRA: 2, TAIGA: 3, STEPPE: 4, TEMPERATE: 5,
  DESERT: 6, SAVANNA: 7, TROPICS: 8, WETLAND: 9, ALPINE: 10,
};

// farm/wood/stone/gather — множители добычи; move — множитель стоимости пути;
// happy — вклад в счастье поселения. Калибровка: умеренный пояс = эталон (~1.0),
// крайности отклоняются в разы, чтобы место основания читалось как решение.
export const BIOMES = [
  { id: 'ocean',     ru: 'Океан',           farm: 0.0,  wood: 0.0,  stone: 0.0,  gather: 0.6,  move: 1.0, happy: 0,  color: '#1b3a5c' },
  { id: 'coast',     ru: 'Побережье',       farm: 0.85, wood: 0.6,  stone: 0.9,  gather: 1.05, move: 1.0, happy: 1,  color: '#c8b98a' },
  { id: 'tundra',    ru: 'Тундра',          farm: 0.45, wood: 0.55, stone: 1.0,  gather: 0.7,  move: 1.15, happy: -3, color: '#9fb3b8' },
  { id: 'taiga',     ru: 'Тайга',           farm: 0.7,  wood: 1.35, stone: 1.0,  gather: 0.9,  move: 1.1, happy: -1, color: '#2f5d43' },
  { id: 'steppe',    ru: 'Степь',           farm: 1.0,  wood: 0.5,  stone: 1.05, gather: 1.0,  move: 0.95, happy: 0,  color: '#b6b06a' },
  { id: 'temperate', ru: 'Умеренные земли', farm: 1.15, wood: 1.0,  stone: 1.0,  gather: 1.1,  move: 1.0, happy: 2,  color: '#4e8c46' },
  { id: 'desert',    ru: 'Пустыня',         farm: 0.25, wood: 0.2,  stone: 1.25, gather: 0.6,  move: 1.2, happy: -4, color: '#d8c07a' },
  { id: 'savanna',   ru: 'Саванна',         farm: 0.85, wood: 0.7,  stone: 1.0,  gather: 1.05, move: 1.0, happy: 0,  color: '#a89a4e' },
  { id: 'tropics',   ru: 'Тропики',         farm: 1.25, wood: 1.3,  stone: 0.9,  gather: 1.15, move: 1.3, happy: -1, color: '#1f6b32' },
  { id: 'wetland',   ru: 'Пойма',           farm: 1.4,  wood: 0.9,  stone: 0.8,  gather: 1.05, move: 1.5, happy: -2, color: '#4a7a5e' },
  { id: 'alpine',    ru: 'Высокогорье',     farm: 0.1,  wood: 0.3,  stone: 1.5,  gather: 0.5,  move: 1.6, happy: -2, color: '#8e8e96' },
];

// ---------------- Константы модели (на них опирается тест) ----------------
// Доля суши. Старая карта 96×96 даёт 0.455, но там один материк без океана
// между массивами; при нескольких материках столько же суши слепляет их в один
// блин, поэтому цель чуть ниже — 0.40. Задаётся через opts.landTarget.
export const LAND_TARGET = 0.40;
export const CONTINENT_MIN = 200;     // от скольких клеток массив суши считается материком
export const MIN_RIVER_LEN = 6;       // короче — это ручей, в список рек не идёт
export const RIVER_FORD_SLOW = 1.6;   // во сколько раз брод замедляет марш
export const RIVER_BRIDGE_FLOW = 3;   // с этой полноводности нужен мост
export const IRRIGATION_R = 2;        // радиус орошения от русла (клетки)
export const IRRIGATION_BONUS = 0.3;  // +30% еде вплотную к реке, дальше — меньше

// ---------------- Публичный вход №1: большая карта ----------------
// Возвращает объект, полностью совместимый с generateWorld: {w,h,tiles,seed,startX,startY},
// плюс слои biome/river/elev/landmass и справочники rivers/landmasses.
export function generateWorld2(seed, rng = null, opts = {}) {
  const t0 = now();
  const r = rng || createRng(seed >>> 0);
  const noise = r.noise || makeNoise2D(createRng((seed ^ 0x9e3779b9) >>> 0));
  const w = (opts.w | 0) || 96, h = (opts.h | 0) || 96;
  const N = w * h;
  const landTarget = opts.landTarget || LAND_TARGET;

  // --- 1. Поле высот: материковые пятна + шум + океан по краю ---
  const nCont = opts.continents != null ? opts.continents : Math.max(2, Math.round(Math.sqrt(w * h) / 70));
  const nIsl = opts.islands != null ? opts.islands : Math.max(3, Math.round(Math.sqrt(w * h) / 20));
  const blobs = [];
  const minSep = Math.min(w, h) * 0.36; // иначе два «материка» срастаются в один блин
  for (let i = 0; i < nCont; i++) {
    let cx = 0, cy = 0;
    for (let a = 0; a < 40; a++) {
      cx = r.range(0.2, 0.8) * w; cy = r.range(0.2, 0.8) * h;
      if (!blobs.some(b => Math.hypot(b.cx - cx, b.cy - cy) < minSep)) break;
    }
    blobs.push({
      cx, cy,
      rx: r.range(0.16, 0.28) * w, ry: r.range(0.16, 0.28) * h,
      rot: r.range(0, Math.PI), amp: 1.0, off: r.range(0, 500),
    });
  }
  // Острова ставим только там, где материков ещё нет: иначе они просто прирастают
  // к берегу и никакого архипелага не выходит.
  for (let i = 0, guard = 0; i < nIsl && guard < nIsl * 40; guard++) {
    const cx = r.range(0.06, 0.94) * w, cy = r.range(0.06, 0.94) * h;
    if (blobMask(blobs, cx, cy, noise, w) > 0.22) continue;
    const rad = r.range(0.03, 0.075) * Math.min(w, h);
    blobs.push({ cx, cy, rx: rad, ry: rad * r.range(0.7, 1.4), rot: r.range(0, Math.PI), amp: r.range(0.5, 0.72), off: r.range(0, 500) });
    i++;
  }

  const elev = new Float32Array(N);
  const edgeBand = Math.max(3, Math.min(w, h) * 0.09);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = blobMask(blobs, x, y, noise, w);
      const base = noise(x * 0.028 + 11, y * 0.028 + 11, 5) * 0.42;
      const d = noise(x * 0.11 + 77, y * 0.11 + 77, 3) * 0.09;
      // Гарантированный океан по периметру: карта не должна обрезать материк
      // ровно по краю, иначе берег выглядит как разрез, а порты у рамки ломаются.
      const eb = Math.min(x, y, w - 1 - x, h - 1 - y) / edgeBand;
      const edge = eb < 1 ? (1 - eb) * (1 - eb) * 1.1 : 0;
      elev[y * w + x] = m + base + d - edge;
    }
  }

  // Уровень моря берём КВАНТИЛЕМ, а не константой: так доля суши стабильна на
  // любом сиде и при любом размере, и тесты могут на неё опираться.
  const sea = quantile(elev, 1 - landTarget);
  // Мелководье оставляем узкой каймой у берега: глубина начинается там, где
  // порт уже не поставишь. 0.72 от океанской доли — примерно шельф в 1–3 клетки.
  const deep = quantile(elev, (1 - landTarget) * 0.72);
  let maxE = -Infinity;
  for (let i = 0; i < N; i++) if (elev[i] > maxE) maxE = elev[i];
  const span = Math.max(1e-3, maxE - sea);

  // --- 2. Первый проход тайлов: вода, песок, горы, холмы ---
  // Рельеф режем КВАНТИЛЯМИ по суше, а не абсолютными порогами. Абсолютный порог
  // на одном сиде даёт 40% гор, на другом — шесть штук на весь мир (ровно этой
  // болезнью болела первая версия generateWorld). Квантиль держит долю гор и
  // холмов постоянной, а гребневой шум решает, ГДЕ именно они лягут — цепями.
  const tiles = new Uint8Array(N);
  const rel = new Float32Array(N);    // 0..1 высота над уровнем моря
  const score = new Float32Array(N);  // «горность»: гребень + высота
  let landN = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, e = elev[i];
      if (e < deep) { tiles[i] = TILE.DEEP; continue; }
      if (e < sea) { tiles[i] = TILE.WATER; continue; }
      const rl = (e - sea) / span; rel[i] = rl;
      const ridge = 1 - Math.abs(noise(x * 0.045 + 300, y * 0.045 + 300, 3)) * 3.2;
      score[i] = ridge * 0.55 + rl * 0.85;
      tiles[i] = TILE.GRASS; landN++;
    }
  }
  const landScore = new Float32Array(landN);
  for (let i = 0, k = 0; i < N; i++) if (tiles[i] === TILE.GRASS) landScore[k++] = score[i];
  landScore.sort();
  const mtnFrac = opts.mountainFrac != null ? opts.mountainFrac : 0.15;
  const hillFrac = opts.hillFrac != null ? opts.hillFrac : 0.26;
  const mtnCut = landN ? landScore[Math.floor((1 - mtnFrac) * (landN - 1))] : 1;
  const hillCut = landN ? landScore[Math.floor((1 - mtnFrac - hillFrac) * (landN - 1))] : 1;
  for (let i = 0; i < N; i++) {
    if (tiles[i] !== TILE.GRASS) continue;
    if (score[i] >= mtnCut) tiles[i] = TILE.MOUNTAIN;
    else if (score[i] >= hillCut) tiles[i] = TILE.HILL;
    else if (rel[i] < 0.03) tiles[i] = TILE.SAND;   // пляж по кромке воды
  }

  // --- 3. Климат: температура по широте, влажность по удалению от моря ---
  const distSea = seaDistance(tiles, w, h);
  const temp = new Float32Array(N), moist = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    // Широта: экватор — середина карты, полюса — верх и низ. Не случайность, а география.
    const lat = Math.abs((y + 0.5) / h * 2 - 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      temp[i] = temperature(lat, rel[i], noise(x * 0.02 + 401, y * 0.02 + 401, 2));
      // Континентальность: вглубь материка дождей меньше — так пустыни и степи
      // оказываются внутри, а не рассыпаются случайными пятнами у моря.
      moist[i] = moisture(distSea[i], noise(x * 0.05 + 909, y * 0.05 + 909, 4));
    }
  }

  // --- 4. Реки: от гор к морю ---
  const nRiv = opts.rivers != null ? opts.rivers : Math.max(3, Math.round(Math.sqrt(w * h) / 11));
  const { river, rivers } = carveRivers({ w, h, elev, tiles, rel, count: nRiv, rng: r });

  // Русло увлажняет округу — оазисы в пустыне и поймы в степи.
  for (let i = 0; i < N; i++) if (river[i]) moist[i] = clamp(moist[i] + 0.3, 0, 1);

  // --- 5. Биомы и второй проход тайлов (что где растёт) ---
  const biome = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      biome[i] = classify(tiles[i], temp[i], moist[i], rel[i], river[i], distSea[i]);
      const t = tiles[i];
      if (t === TILE.GRASS || t === TILE.SAND) {
        tiles[i] = growth(biome[i], moist[i], noise(x * 0.09 + 133, y * 0.09 + 133, 3), t);
      }
    }
  }

  const world = { w, h, tiles, seed: seed >>> 0, startX: 0, startY: 0, elev, biome, river, rivers, temp, moist, gen2: true, opts: { w, h } };

  // --- 6. Старт: крупнейший материк, тёплый пояс, вода рядом ---
  let lm = analyzeLandmasses(world);
  const st = pickStart(world, lm);
  world.startX = st.x; world.startY = st.y;
  if (opts.startArea !== false) { carveStartArea(world, st.x, st.y); refreshRivers(world); }
  if (opts.protectStart !== false) protectStart(world, st.x, st.y);
  // Пересчёт после вырезания поляны: она могла соединить или рассечь массивы суши.
  lm = analyzeLandmasses(world);
  world.landmass = lm.map; world.landmasses = lm.list;
  world.genMs = now() - t0;
  return world;
}

// ---------------- Публичный вход №2: слои поверх СТАРОЙ карты ----------------
// Тайлы не трогаются вообще — навешиваются только biome/river/landmass.
// Это путь совместимости: игра продолжает жить на generateWorld, но получает
// биомы, орошение и материки.
export function enrichWorld(world, seed = world.seed, opts = {}) {
  const t0 = now();
  const w = world.w, h = world.h, N = w * h;
  const r = opts.rng || createRng((seed ^ 0x51ed2701) >>> 0);
  const noise = makeNoise2D(createRng((seed ^ 0x9e3779b9) >>> 0));
  // Высоту восстанавливаем из типа тайла: точного рельефа у старой карты нет,
  // но порядок «вода < песок < трава < холм < гора» для стока рек достаточен.
  const H_BY_TILE = { [TILE.DEEP]: -0.5, [TILE.WATER]: -0.15, [TILE.SAND]: 0.03, [TILE.GRASS]: 0.2, [TILE.FOREST]: 0.24, [TILE.HILL]: 0.55, [TILE.MOUNTAIN]: 0.9 };
  const elev = new Float32Array(N), rel = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    elev[i] = H_BY_TILE[world.tiles[i]] + noise(x * 0.09 + 5, y * 0.09 + 5, 3) * 0.035;
    rel[i] = Math.max(0, elev[i]) / 0.9;
  }
  const distSea = seaDistance(world.tiles, w, h);
  const temp = new Float32Array(N), moist = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    const lat = Math.abs((y + 0.5) / h * 2 - 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      temp[i] = temperature(lat, rel[i], noise(x * 0.02 + 401, y * 0.02 + 401, 2));
      moist[i] = moisture(distSea[i], noise(x * 0.05 + 909, y * 0.05 + 909, 4));
    }
  }
  const nRiv = opts.rivers != null ? opts.rivers : Math.max(3, Math.round(Math.sqrt(w * h) / 11));
  const { river, rivers } = carveRivers({ w, h, elev, tiles: world.tiles, rel, count: nRiv, rng: r });
  for (let i = 0; i < N; i++) if (river[i]) moist[i] = clamp(moist[i] + 0.3, 0, 1);
  const biome = new Uint8Array(N);
  for (let i = 0; i < N; i++) biome[i] = classify(world.tiles[i], temp[i], moist[i], rel[i], river[i], distSea[i]);

  world.elev = elev; world.biome = biome; world.river = river; world.rivers = rivers;
  world.temp = temp; world.moist = moist;
  if (opts.protectStart !== false) protectStart(world, world.startX, world.startY);
  const lm = analyzeLandmasses(world);
  world.landmass = lm.map; world.landmasses = lm.list;
  world.enrichMs = now() - t0;
  return world;
}

// ---------------- Запросы к карте (то, ради чего всё) ----------------
export function biomeAt(world, x, y) {
  const i = idx(world, x, y);
  return i < 0 || !world.biome ? BIOME.OCEAN : world.biome[i];
}
export function biomeInfo(world, x, y) { return BIOMES[biomeAt(world, x, y)]; }
export function biomeName(world, x, y) { return BIOMES[biomeAt(world, x, y)].ru; }

// Множитель добычи ресурса на клетке. Ресурсы, которые земля не родит
// (золото, знания), биом не трогает — иначе пустынный рынок торговал бы вчетверо хуже.
export function yieldMult(world, x, y, res) {
  const b = biomeInfo(world, x, y);
  if (res === 'food') return b.farm;
  if (res === 'wood') return b.wood;
  if (res === 'stone' || res === 'steel') return b.stone;
  return 1;
}
export function gatherMult(world, x, y) { return biomeInfo(world, x, y).gather; }
export function biomeHappy(world, x, y) { return biomeInfo(world, x, y).happy; }

// Орошение: множитель к еде рядом с руслом. Спадает с расстоянием, поэтому
// «поставить ферму у реки» — осмысленный выбор, а не бесплатная константа.
export function irrigation(world, x, y, radius = IRRIGATION_R) {
  if (!world.river) return 1;
  const xi = Math.round(x), yi = Math.round(y);
  let best = 0;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const i = idx(world, xi + dx, yi + dy);
    if (i < 0 || !world.river[i]) continue;
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    const k = 1 - d / (radius + 1);
    if (k > best) best = k;
  }
  return 1 + IRRIGATION_BONUS * best;
}

export function riverAt(world, x, y) {
  const i = idx(world, x, y);
  return i < 0 || !world.river ? 0 : world.river[i];
}
export function isRiver(world, x, y) { return riverAt(world, x, y) > 0; }
// Полноводное русло без моста не перейти: это и есть «требует моста».
export function needsBridge(world, x, y) { return riverAt(world, x, y) >= RIVER_BRIDGE_FLOW; }

// Стоимость шага по клетке с учётом биома и переправы. Плюс к TILE_COST ядра.
export function moveMult(world, state, x, y) {
  const b = biomeInfo(world, x, y);
  const f = riverAt(world, x, y);
  if (!f || hasBridge(state, x, y)) return b.move;
  return b.move * (f >= RIVER_BRIDGE_FLOW ? Infinity : RIVER_FORD_SLOW);
}

// Разбор УЖЕ найденного пути: где брод, где непреодолимая переправа.
// Работает поверх aStar ядра, не подменяя его.
export function riverPath(world, state, path) {
  let slow = 1, fords = 0, blocked = false, at = null;
  if (!Array.isArray(path)) return { slow, fords, blocked, at };
  for (const p of path) {
    const f = riverAt(world, p.x, p.y);
    if (!f || hasBridge(state, p.x, p.y)) continue;
    if (f >= RIVER_BRIDGE_FLOW) { blocked = true; if (!at) at = { x: p.x, y: p.y }; continue; }
    fords++;
  }
  if (fords) slow = 1 + (RIVER_FORD_SLOW - 1) * Math.min(1, fords / 3);
  return { slow, fords, blocked, at };
}

// Один ли материк — армия дойдёт пешком; разные — нужен флот (или не воевать вовсе).
export function sameLandmass(world, x1, y1, x2, y2) {
  if (!world.landmass) return true;
  const a = idx(world, x1, y1), b = idx(world, x2, y2);
  if (a < 0 || b < 0) return false;
  const la = world.landmass[a], lb = world.landmass[b];
  return la > 0 && la === lb;
}
export function landmassAt(world, x, y) {
  const i = idx(world, x, y);
  return i < 0 || !world.landmass ? 0 : world.landmass[i];
}

// ---------------- Мосты (единственное, что попадает в сейв) ----------------
export function createWorldgenState(world = null, opts = {}) {
  return {
    seed: world ? world.seed >>> 0 : (opts.seed >>> 0 || 0),
    w: world ? world.w : (opts.w || 96),
    h: world ? world.h : (opts.h || 96),
    bridges: [],       // [{x,y}] — построенные переправы
    bridgeSet: new Set(), // быстрый индекс, в сейв не идёт
  };
}

export function bridgeCost(world, x, y) {
  const f = riverAt(world, x, y);
  if (!f) return null; // моста без реки не бывает
  return { wood: 10 + 8 * f, stone: f >= RIVER_BRIDGE_FLOW ? 10 * f : 0 };
}

export function buildBridge(state, x, y) {
  const k = key(x, y);
  if (state.bridgeSet.has(k)) return false;
  state.bridgeSet.add(k);
  state.bridges.push({ x: Math.round(x), y: Math.round(y) });
  return true;
}
export function hasBridge(state, x, y) {
  return !!state && state.bridgeSet.has(key(Math.round(x), Math.round(y)));
}

export function serialize(state) {
  return { seed: state.seed, w: state.w, h: state.h, bridges: state.bridges.map(b => [b.x, b.y]) };
}
export function deserialize(data) {
  const st = createWorldgenState(null, { seed: data && data.seed, w: data && data.w, h: data && data.h });
  if (data && Array.isArray(data.bridges)) for (const [x, y] of data.bridges) buildBridge(st, x, y);
  return st;
}

// ---------------- Сводка и текст для UI ----------------
export function worldStats(world) {
  const N = world.w * world.h;
  let land = 0, riverTiles = 0;
  const biomeCounts = {};
  for (const b of BIOMES) biomeCounts[b.id] = 0;
  for (let i = 0; i < N; i++) {
    if (world.tiles[i] !== TILE.DEEP && world.tiles[i] !== TILE.WATER) land++;
    if (world.river && world.river[i]) riverTiles++;
    if (world.biome) biomeCounts[BIOMES[world.biome[i]].id]++;
  }
  const list = world.landmasses || [];
  const conts = list.filter(l => l.size >= CONTINENT_MIN);
  const isls = list.filter(l => l.size < CONTINENT_MIN && l.size >= 4);
  const rivers = world.rivers || [];
  return {
    w: world.w, h: world.h, land, landPct: land / N,
    continents: conts.length, islands: isls.length, islets: list.length - conts.length - isls.length,
    biggest: conts.length ? conts[0].size : (list[0] ? list[0].size : 0),
    rivers: rivers.length, riverTiles,
    longestRiver: rivers.reduce((m, r) => Math.max(m, r.len), 0),
    avgRiver: rivers.length ? rivers.reduce((s, r) => s + r.len, 0) / rivers.length : 0,
    biomeCounts,
  };
}

export function describeTile(world, state, x, y) {
  const b = biomeInfo(world, x, y);
  const parts = [b.ru];
  const f = riverAt(world, x, y);
  if (f) parts.push(hasBridge(state, x, y) ? 'мост через реку' : (f >= RIVER_BRIDGE_FLOW ? 'полноводная река — нужен мост' : 'брод'));
  const irr = irrigation(world, x, y);
  if (irr > 1.001) parts.push(`орошение +${Math.round((irr - 1) * 100)}% к еде`);
  if (b.farm !== 1) parts.push(`поля ×${b.farm.toFixed(2)}`);
  if (b.wood !== 1) parts.push(`лес ×${b.wood.toFixed(2)}`);
  return parts.join(', ');
}

// ---------------- Внутреннее ----------------
function idx(world, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= world.w || yi >= world.h) return -1;
  return yi * world.w + xi;
}
const key = (x, y) => (y << 12) | x;
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

// Материковая маска: максимум по пятнам, берег изрезан шумом.
function blobMask(blobs, x, y, noise, w) {
  let best = 0;
  for (const b of blobs) {
    const dx = x - b.cx, dy = y - b.cy;
    const c = Math.cos(b.rot), s = Math.sin(b.rot);
    const ux = (dx * c + dy * s) / b.rx, uy = (-dx * s + dy * c) / b.ry;
    let d = Math.sqrt(ux * ux + uy * uy);
    d += noise(x * 0.055 + b.off, y * 0.055 + b.off, 2) * 0.26;
    const v = b.amp * (1 - d * d);
    if (v > best) best = v;
  }
  return best;
}

// Квантиль по копии массива — уровень моря, дающий заданную долю суши.
function quantile(arr, q) {
  const c = Float32Array.from(arr);
  c.sort();
  return c[clamp(Math.floor(q * (c.length - 1)), 0, c.length - 1)];
}

// Многоисточниковый BFS от всей воды: континентальность за один проход O(N).
function seaDistance(tiles, w, h) {
  const N = w * h;
  const dist = new Uint16Array(N).fill(0xffff);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (tiles[i] === TILE.DEEP || tiles[i] === TILE.WATER) { dist[i] = 0; q[qt++] = i; }
  while (qh < qt) {
    const i = q[qh++], x = i % w, y = (i / w) | 0, d = dist[i] + 1;
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (dist[ni] <= d) continue;
      dist[ni] = d; q[qt++] = ni;
    }
  }
  return dist;
}

// Температура: широта решает главное, высота холодит. Степень 1.35 расширяет
// умеренный пояс — при 1.0 половина суши уезжала в тундру.
export function temperature(lat, rel, n) {
  return clamp(1 - Math.pow(lat, 1.35) + n * 0.09 - rel * 0.30, 0, 1);
}
// Влажность: чем дальше от моря, тем суше, но не бесконечно — иначе центр
// большой карты превращается в сплошную пустыню без единого пятна степи.
export function moisture(distSea, n) {
  return clamp(0.74 - Math.min(distSea, 18) * 0.030 + n * 0.45, 0, 1);
}

// Биом по температуре, влажности и высоте. Порядок проверок важен:
// сначала «жёсткие» условия (вода, горы, пойма), потом климатическая решётка.
function classify(tile, t, m, rl, riv, dsea) {
  if (tile === TILE.DEEP || tile === TILE.WATER) return BIOME.OCEAN;
  if (tile === TILE.MOUNTAIN) return BIOME.ALPINE;
  if (riv > 0 && rl < 0.3 && t > 0.3) return BIOME.WETLAND;
  if (t < 0.22) return BIOME.TUNDRA;
  if (t < 0.42) return m > 0.32 ? BIOME.TAIGA : BIOME.TUNDRA;
  if (dsea <= 1 && rl < 0.08) return BIOME.COAST;
  if (t > 0.72) {
    if (m < 0.28) return BIOME.DESERT;
    if (m < 0.5) return BIOME.SAVANNA;
    return BIOME.TROPICS;
  }
  if (m < 0.26) return BIOME.DESERT;
  if (m < 0.42) return BIOME.STEPPE;
  return BIOME.TEMPERATE;
}

// Что растёт на равнине: биом решает, будет тут лес, трава или голый песок.
// Возвращает ТОЛЬКО существующие значения TILE — новых тайлов не заводим.
function growth(b, m, n, fallback) {
  switch (b) {
    case BIOME.DESERT: return n > -0.02 ? TILE.SAND : TILE.GRASS;      // дюны и такыры
    case BIOME.TUNDRA: return n > 0.34 ? TILE.FOREST : TILE.GRASS;     // редкое криволесье
    case BIOME.TAIGA: return n > -0.22 ? TILE.FOREST : TILE.GRASS;     // сплошной хвойник
    case BIOME.TROPICS: return n > -0.3 ? TILE.FOREST : TILE.GRASS;    // джунгли
    case BIOME.WETLAND: return n > 0.18 ? TILE.FOREST : TILE.GRASS;
    case BIOME.SAVANNA: return n > 0.3 ? TILE.FOREST : TILE.GRASS;
    case BIOME.STEPPE: return n > 0.38 ? TILE.FOREST : TILE.GRASS;
    case BIOME.TEMPERATE: return n > 0.04 ? TILE.FOREST : TILE.GRASS;
    case BIOME.COAST: return fallback === TILE.SAND ? TILE.SAND : (n > 0.3 ? TILE.FOREST : TILE.GRASS);
    default: return fallback;
  }
}

// Реки: исток в горах/на холмах, дальше — по самому крутому спуску до воды.
// Меандры даёт крошечный джиттер от rng: без него все русла выходят прямыми.
function carveRivers({ w, h, elev, tiles, rel, count, rng }) {
  const N = w * h;
  const river = new Uint8Array(N);
  const rivers = [];
  // Кандидаты в истоки — вершины; порядок фиксирован обходом, выбор — через rng.
  const src = [];
  for (let i = 0; i < N; i++) {
    if (tiles[i] === TILE.MOUNTAIN || (tiles[i] === TILE.HILL && rel[i] > 0.3)) src.push(i);
  }
  if (!src.length) return { river, rivers };
  const local = new Int32Array(N).fill(-1);
  let visitStamp = 0;
  for (let attempt = 0, made = 0; made < count && attempt < count * 12 && src.length; attempt++) {
    let cur = src[rng.int(0, src.length - 1)];
    if (river[cur]) continue;
    const path = [];
    visitStamp++;
    let reachedSea = false, breaches = 0, seaCell = -1;
    for (let step = 0; step < w + h + 64; step++) {
      if (isWaterTile(tiles[cur])) { reachedSea = true; seaCell = cur; break; }
      if (local[cur] === visitStamp) break; // закольцевались — хватит
      local[cur] = visitStamp;
      path.push(cur);
      const cx = cur % w, cy = (cur / w) | 0;
      let best = -1, bestV = Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (local[ni] === visitStamp) continue;
        // Джиттер меандра: ±0.006 высоты, этого хватает на изгибы и мало для «рек в гору».
        const v = elev[ni] + rng.range(-0.006, 0.006);
        if (v < bestV) { bestV = v; best = ni; }
      }
      if (best < 0) break;
      // Локальная впадина: пробиваем перевал, но не бесконечно — иначе река
      // будет ползти по плато через всю карту.
      if (elev[best] >= elev[cur] && ++breaches > 8) break;
      cur = best;
    }
    if (path.length < MIN_RIVER_LEN) continue;
    if (!reachedSea && path.length < MIN_RIVER_LEN * 2) continue; // бессточный ручеёк не считаем рекой
    const head = path[0];
    // Устье — та самая клетка ВОДЫ, в которую река впала; последняя клетка суши
    // устьем не является, иначе «река впадает в берег».
    const mouth = reachedSea ? seaCell : path[path.length - 1];
    for (let k = 0; k < path.length; k++) {
      const i = path[k];
      // Полноводность растёт вниз по течению: у истока брод, в низовье нужен мост.
      const strength = 1 + Math.min(2, Math.floor(k / Math.max(4, path.length / 3)));
      const merged = river[i] ? Math.min(255, river[i] + 1) : strength; // слияние усиливает поток
      river[i] = Math.max(river[i], merged, strength);
    }
    rivers.push({
      sx: head % w, sy: (head / w) | 0, mx: mouth % w, my: (mouth / w) | 0,
      len: path.length, toSea: reachedSea, cells: path,
    });
    made++;
  }
  rivers.sort((a, b) => b.len - a.len);
  return { river, rivers };
}
function isWaterTile(t) { return t === TILE.DEEP || t === TILE.WATER; }

// Заливка массивов суши (8-связность — как ходит A*): id 0 = вода.
export function analyzeLandmasses(world) {
  const w = world.w, h = world.h, N = w * h;
  const map = new Int16Array(N);
  const list = [];
  const q = new Int32Array(N);
  let id = 0;
  for (let s = 0; s < N; s++) {
    if (map[s] || isWaterTile(world.tiles[s])) continue;
    id++;
    let qh = 0, qt = 0;
    q[qt++] = s; map[s] = id;
    let size = 0, minX = w, minY = h, maxX = 0, maxY = 0, walk = 0;
    while (qh < qt) {
      const i = q[qh++], x = i % w, y = (i / w) | 0;
      size++;
      if (WALKABLE.has(world.tiles[i])) walk++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (map[ni] || isWaterTile(world.tiles[ni])) continue;
        map[ni] = id; q[qt++] = ni;
      }
    }
    list.push({ id, size, walkable: walk, minX, minY, maxX, maxY, cx: (minX + maxX) >> 1, cy: (minY + maxY) >> 1, kind: size >= CONTINENT_MIN ? 'материк' : (size >= 4 ? 'остров' : 'скала') });
  }
  list.sort((a, b) => b.size - a.size);
  return { map, list };
}

// Старт: самый большой материк, умеренный пояс, вода рядом, подальше от края.
// Перебор детерминирован (шаг по сетке), rng здесь не нужен и не тратится.
function pickStart(world, lm) {
  const w = world.w, h = world.h;
  const main = lm.list[0];
  if (!main) return { x: w >> 1, y: h >> 1 };
  let best = null, bestScore = -Infinity;
  for (let y = Math.max(9, main.minY); y <= Math.min(h - 10, main.maxY); y++) {
    for (let x = Math.max(9, main.minX); x <= Math.min(w - 10, main.maxX); x++) {
      const i = y * w + x;
      if (lm.map[i] !== main.id) continue;
      if (!WALKABLE.has(world.tiles[i])) continue;
      const b = world.biome[i];
      let sc = 0;
      if (b === BIOME.TEMPERATE) sc += 10;
      else if (b === BIOME.STEPPE || b === BIOME.SAVANNA || b === BIOME.COAST) sc += 6;
      else if (b === BIOME.TAIGA || b === BIOME.TROPICS || b === BIOME.WETLAND) sc += 3;
      else sc -= 6; // тундра, пустыня, гольцы — стартовать там незачем
      sc += (irrigation(world, x, y) - 1) * 20;
      // Нужен простор вокруг: поляна 9×9 не должна свисать в океан.
      let land = 0;
      for (let dy = -4; dy <= 4; dy += 2) for (let dx = -4; dx <= 4; dx += 2) {
        const j = idx(world, x + dx, y + dy);
        if (j >= 0 && !isWaterTile(world.tiles[j])) land++;
      }
      sc += land * 0.7;
      if (sc > bestScore) { bestScore = sc; best = { x, y }; }
    }
  }
  return best || { x: main.cx, y: main.cy };
}

// Стартовая поляна осушает клетки, по которым могла течь река, — после этого
// справочник world.rivers обязан перестать врать: длина, исток и устье
// пересчитываются по уцелевшим клеткам, огрызки короче порога выбрасываются.
// Рассинхрон слоя и списка — ровно тот баг, который потом ловят месяцами.
function refreshRivers(world) {
  const w = world.w, keep = [];
  for (const r of world.rivers) {
    const live = r.cells.filter(i => world.river[i] > 0);
    if (live.length < MIN_RIVER_LEN) { for (const i of live) world.river[i] = 0; continue; }
    const head = live[0], tail = live[live.length - 1];
    const intact = tail === r.cells[r.cells.length - 1];
    keep.push({
      sx: head % w, sy: (head / w) | 0,
      mx: intact && r.toSea ? r.mx : tail % w, my: intact && r.toSea ? r.my : (tail / w) | 0,
      len: live.length, toSea: r.toSea && intact, cells: live,
    });
  }
  keep.sort((a, b) => b.len - a.len);
  world.rivers = keep;
}

// Стартовая долина пригодна для жизни — это правило ядра, а не поблажка:
// generateWorld уже гарантирует там траву, лес, холм и гору. Если бы климат
// говорил «пустыня», игрок начинал бы с фермами ×0.25 и −4 счастья, то есть
// проигрывал бы по броску сида ещё до первого хода. Меняем только НЕПРИГОДНЫЕ
// биомы поляны; тайга, тропики, степь и пойма остаются как есть — это уже игра.
export function protectStart(world, cx, cy, r = 5) {
  if (!world.biome) return 0;
  let fixed = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const i = idx(world, cx + dx, cy + dy);
    if (i < 0) continue;
    const b = world.biome[i];
    if (b === BIOME.DESERT || b === BIOME.TUNDRA || (b === BIOME.ALPINE && world.tiles[i] !== TILE.MOUNTAIN)) {
      world.biome[i] = BIOME.TEMPERATE; fixed++;
    }
  }
  return fixed;
}

// Та же гарантированная стартовая поляна, что и в generateWorld: без неё
// первые постройки (лесопилка у леса, каменоломня у холма) могут не встать.
function carveStartArea(world, cx, cy) {
  const set = (x, y, t) => { const i = idx(world, x, y); if (i >= 0) { world.tiles[i] = t; world.river[i] = 0; } };
  for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) set(cx + x, cy + y, TILE.GRASS);
  for (let y = -8; y <= -5; y++) for (let x = -3; x <= 3; x++) set(cx + x, cy + y, TILE.FOREST);
  for (let y = 5; y <= 7; y++) for (let x = 4; x <= 7; x++) set(cx + x, cy + y, TILE.HILL);
  for (let y = -2; y <= 0; y++) for (let x = 8; x <= 9; x++) set(cx + x, cy + y, TILE.MOUNTAIN);
}
