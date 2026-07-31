// core/systems/borders.js — национальные границы (U01–U04), механика Rise of Nations.
// Чистый модуль: без DOM, без обращений к Simulation, весь ввод — аргументами.
//
// МОДЕЛЬ. Каждое поселение/здание излучает влияние w/(1+d²). Владелец клетки —
// сторона с наибольшей суммой влияния, если сумма превысила порог; иначе клетка
// ничья. Отсюда бесплатно получаются все четыре пункта задания: территория (U01),
// вражеская земля для истощения (U02), давление границ (U03 — сильный сосед
// просто перебивает слабого в точке стыка) и площадь под налог (U04).
//
// ═══════════════ INTEGRATION ═══════════════
// В simulation.js (я НЕ редактировал этот файл — вставку делает интегратор):
//
// 1) import { createBorders, updateBorders, worldVersion, attritionPerDay,
//              landTaxPerDay, borderEdges, serializeBorders, deserializeBorders,
//              ownerAt, OWNER_PLAYER } from './systems/borders.js';
//
// 2) В конструкторе Simulation, ПОСЛЕ this.spawnFactions():
//      this.borders = createBorders(this.world.w, this.world.h);
//
// 3) В onNewDay(), в самом конце (границы обновляются раз в игровой день):
//      updateBorders(this.borders, {
//        world: this.world, day: this.day,
//        version: worldVersion(this.buildings, this.factions),
//        buildings: this.buildings, factions: this.factions,
//      });
//
// 4) U04 — налог с земли, там же в onNewDay() после обновления границ:
//      this.res.gold += landTaxPerDay(this.borders, OWNER_PLAYER,
//        { mult: this.techs.has('laws') ? 1.25 : 1 }) * this.globalMult('gold');
//    (модуль отдаёт «сырой» прирост; эпохальные и постройковые множители —
//     дело ядра, чтобы не дублировать экономику в двух местах).
//
// 5) U02 — истощение. Для отряда игрока на координатах (x,y):
//      const dmg = attritionPerDay(this.borders, x, y, OWNER_PLAYER,
//                                  { supplied: false }) * dtDays;
//    Симметрично для рейдовых отрядов фракций: вместо OWNER_PLAYER передать id
//    фракции ('wolves' и т.п.). Функция сама вернёт 0 на своей и ничьей земле.
//
// 6) Сейв: в serialize() добавить `borders: serializeBorders(this.borders)`,
//    в deserialize() — `sim.borders = data.borders ? deserializeBorders(data.borders)
//    : createBorders(sim.world.w, sim.world.h);`
//    Старые сейвы без поля borders грузятся: границы восстановятся в первый же день.
//
// 7) Рендер (renderer.js): `const edges = borderEdges(this.sim.borders);` — массив
//    отрезков в клеточных координатах между клетками РАЗНЫХ владельцев; каждая
//    сторона отдаёт свою кромку отдельно, поэтому спорную границу можно рисовать
//    двумя цветами. Цвет по e.owner: OWNER_PLAYER → золотой, иначе
//    FACTIONS[e.owner - 2].color. Экранная точка = (ox + e.x1 * z, oy + e.y1 * z).
// ═══════════════════════════════════════════

import { TILE, BUILDINGS, FACTIONS } from '../data.js';

// ---------- Коды владельцев ----------
// Код фракции жёстко привязан к её месту в таблице FACTIONS, а не к порядку
// спавна: иначе сейв, снятый при трёх фракциях, после загрузки с другим набором
// «перекрасил» бы чужую территорию в чужой цвет.
export const OWNER_NONE = 0;
export const OWNER_PLAYER = 1;
const FACTION_CODE = Object.fromEntries(FACTIONS.map((f, i) => [f.id, i + 2]));
const CODE_SIDE = [null, 'player', ...FACTIONS.map(f => f.id)];
export const MAX_OWNER_CODE = CODE_SIDE.length - 1;

// ---------- Настройки модели (экспортируются: на них опирается тест) ----------
// Порог владения. Одинокое кострище (вес ~5.75) держит круг радиусом ~5 клеток —
// это «деревня», а не империя; разрастается территория только от новых построек.
export const INFLUENCE_THRESHOLD = 0.2;
// Ниже этого вклада источник обрезается: при w/(1+d²) < CUTOFF добавка не может
// изменить исход даже в спорной зоне, зато обрезка ужимает область сплата с
// целой карты до квадратика вокруг здания — на этом и держится бюджет 15 мс.
const INFLUENCE_CUTOFF = INFLUENCE_THRESHOLD / 10;
const MAX_RADIUS = 22;
const EPS = 1e-6;

// U02: потери силы в день. База — на самой кромке чужой земли, вглубь тяжелее.
export const ATTRITION_BASE = 1.5;
export const ATTRITION_PER_DEPTH = 0.6;
export const ATTRITION_MAX = 8;
export const ATTRITION_SUPPLIED = 0.25; // снабжённый отряд теряет вчетверо меньше

// U04: золото в день с клетки. Горы обложены вполовину — голые скалы податей
// почти не приносят, но и отдавать их даром соседу не хочется.
export const TAX_PER_TILE = 0.01;
const TAX_MOUNTAIN = 0.5;

const B_INDEX = Object.fromEntries(Object.keys(BUILDINGS).map((k, i) => [k, i + 1]));

// ---------- Веса источников (U01) ----------

// Вес здания игрока. Крупное и дорогое заявляет права на землю сильнее лачуги,
// цитадель (замок) — сильнее всего: оборона даёт самый жирный слагаемый.
export function buildingWeight(b) {
  const def = BUILDINGS[b.id];
  if (!def) return 0;
  let w = 1;
  let costSum = 0;
  for (const v of Object.values(def.cost || {})) costSum += v;
  w += costSum / 80;
  if (def.housing) w += def.housing / 8;   // жильё = люди, живущие на этой земле
  if (def.defense) w += def.defense / 6;   // укрепления = цитадель
  if (def.unique) w += 3;                  // замок и Шпиль — символы державы
  if (b.id === 'campfire') w += 4;         // сердце поселения, точка отсчёта
  if ((def.size || 1) > 1) w *= 1.6;
  return w;
}

// Вес поселения фракции: от её поля P (население теневой экономики), делённого
// на число поселений, — крупная держава давит границей сильнее хутора.
// Столица весомее аванпоста.
export function settlementWeight(f, s) {
  const n = Math.max(1, f.settlements ? f.settlements.length : 1);
  const w = 2 + (f.P / n) * 0.12;
  return s && s.capital ? w * 1.5 : w;
}

// ---------- Состояние ----------

export function createBorders(w = 96, h = 96) {
  const n = w * h;
  return {
    w, h,
    owners: new Uint8Array(n),   // код владельца каждой клетки
    depth: new Uint8Array(n),    // глубина внутри своей территории, 1 = кромка
    areas: new Float64Array(MAX_OWNER_CODE + 1), // облагаемая площадь по владельцам
    tiles: new Int32Array(MAX_OWNER_CODE + 1),   // просто число клеток
    edges: [],                   // рёбра границы для рендера
    version: -1,                 // версия состава зданий/поселений на момент счёта
    lastDay: -1,                 // игровой день последнего пересчёта
    recomputes: 0,               // счётчик пересчётов (метрика и проверка кэша)
    lastMs: 0,                   // длительность последнего пересчёта, мс
    _acc: null,                  // Float32Array[code] — аккумуляторы влияния
    _queue: null,                // очередь BFS для карты глубины
  };
}

// Дешёвый хеш состава: можно звать каждый кадр, менять ядро не требуется.
// Дробное P округляется — иначе рост населения на 0.05 в день дёргал бы
// пересчёт ежедневно, а так граница подтягивается на каждом целом жителе.
export function worldVersion(buildings, factions) {
  let v = 17;
  if (buildings) {
    for (const b of buildings) {
      if (!b.done || b.destroyed) continue;
      v = (Math.imul(v, 31) + ((B_INDEX[b.id] || 0) * 8191 + b.x * 97 + b.y * 7919)) | 0;
    }
  }
  if (factions) {
    for (const f of factions) {
      if (!f.alive) continue;
      v = (Math.imul(v, 31) + ((FACTION_CODE[f.id] || 0) * 65521 + Math.round(f.P))) | 0;
      for (const s of f.settlements || []) {
        v = (Math.imul(v, 31) + (s.x * 97 + s.y * 7919 + (s.capital ? 5 : 0))) | 0;
      }
    }
  }
  return v;
}

// Главная точка входа. Пересчитывает не чаще раза в игровой день И только если
// состав изменился (или ctx.force). Возвращает true, если пересчёт состоялся.
export function updateBorders(state, ctx) {
  const { world, day = 0, version = 0, buildings = [], factions = [], force = false } = ctx || {};
  if (!world) throw new Error('updateBorders: не передан world');
  _ensureSize(state, world.w, world.h);
  const first = state.lastDay < 0;
  if (!force && !first) {
    if (day <= state.lastDay) return false;      // не чаще раза в день
    if (version === state.version) return false; // состав не менялся — кэш валиден
  }
  const t0 = _now();
  _recompute(state, world, buildings, factions);
  state.lastMs = _now() - t0;
  state.version = version;
  state.lastDay = day;
  state.recomputes++;
  return true;
}

// ---------- Запросы ----------

export function ownerAt(state, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= state.w || yi >= state.h) return OWNER_NONE;
  return state.owners[yi * state.w + xi];
}

// 'player' | id фракции | число → код. Неизвестное — OWNER_NONE.
export function ownerCode(side) {
  if (typeof side === 'number') return (side >= 0 && side <= MAX_OWNER_CODE) ? side : OWNER_NONE;
  if (side === 'player') return OWNER_PLAYER;
  return FACTION_CODE[side] || OWNER_NONE;
}

export function ownerSide(code) { return CODE_SIDE[code] || null; }

export function ownerName(code) {
  if (code === OWNER_PLAYER) return 'Ваши земли';
  const f = FACTIONS[code - 2];
  return f ? f.name : 'Ничья земля';
}

// U02. Сколько силы в день теряет отряд стороны `side`, стоящий в (x,y).
// На своей и на ничьей земле — ноль: истощает именно чужая территория.
// Глубина вторжения берётся из предпосчитанной карты, поэтому вызов дешёвый и
// его можно звать хоть каждый тик для каждого отряда.
export function attritionPerDay(state, x, y, side, opts = {}) {
  const mine = ownerCode(side);
  const xi = Math.floor(x), yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= state.w || yi >= state.h) return 0;
  const i = yi * state.w + xi;
  const own = state.owners[i];
  if (own === OWNER_NONE || own === mine) return 0;
  const depth = state.depth[i] || 1;
  let dmg = ATTRITION_BASE + (depth - 1) * ATTRITION_PER_DEPTH;
  if (dmg > ATTRITION_MAX) dmg = ATTRITION_MAX;
  if (opts.supplied) dmg *= ATTRITION_SUPPLIED;
  return dmg * (opts.mult ?? 1);
}

// U04. Прирост золота в день от площади подконтрольных клеток.
export function landTaxPerDay(state, side, opts = {}) {
  const code = ownerCode(side);
  if (!code) return 0;
  return state.areas[code] * TAX_PER_TILE * (opts.mult ?? 1);
}

// Число клеток во владении (для HUD и целей кампании).
export function territoryTiles(state, side) {
  const code = ownerCode(side);
  return code ? state.tiles[code] : 0;
}

// Сводка по всем сторонам, отсортированная по площади.
export function territoryStats(state) {
  const out = [];
  for (let c = 1; c <= MAX_OWNER_CODE; c++) {
    if (!state.tiles[c]) continue;
    out.push({ code: c, side: ownerSide(c), name: ownerName(c), tiles: state.tiles[c], tax: landTaxPerDay(state, c) });
  }
  out.sort((a, b) => b.tiles - a.tiles);
  return out;
}

// Рёбра границы для отрисовки: {x1,y1,x2,y2,owner} в клеточных координатах.
// Стык двух держав отдаётся дважды — по одному ребру на каждую сторону, чтобы
// рендер обвёл обе территории своим цветом.
export function borderEdges(state) { return state.edges; }

// ---------- Сохранение ----------

export function serializeBorders(state) {
  return {
    v: 1, w: state.w, h: state.h,
    version: state.version, lastDay: state.lastDay,
    // Территория — крупные однородные пятна, поэтому RLE ужимает 9216 байт
    // до сотен чисел; полный массив раздувал бы сейв на порядок.
    rle: _rleEncode(state.owners),
    areas: Array.from(state.areas),
  };
}

export function deserializeBorders(data) {
  const w = (data && data.w) || 96, h = (data && data.h) || 96;
  const state = createBorders(w, h);
  if (!data || !data.rle) return state;
  _rleDecode(data.rle, state.owners);
  state.version = data.version ?? -1;
  state.lastDay = data.lastDay ?? -1;
  if (data.areas) for (let i = 0; i < state.areas.length && i < data.areas.length; i++) state.areas[i] = data.areas[i];
  // Глубина, счётчики клеток и рёбра — производные от карты владельцев,
  // в сейве их держать незачем.
  _countTiles(state);
  _buildDepth(state);
  _buildEdges(state);
  return state;
}

// ---------- Внутреннее ----------

function _now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function _ensureSize(state, w, h) {
  if (state.w === w && state.h === h && state.owners.length === w * h) return;
  const fresh = createBorders(w, h);
  state.w = w; state.h = h;
  state.owners = fresh.owners; state.depth = fresh.depth;
  state.areas = fresh.areas; state.tiles = fresh.tiles;
  state.edges = []; state._acc = null; state._queue = null;
}

function _acc(state, code) {
  if (!state._acc) state._acc = new Array(MAX_OWNER_CODE + 1).fill(null);
  if (!state._acc[code]) state._acc[code] = new Float32Array(state.w * state.h);
  return state._acc[code];
}

function _recompute(state, world, buildings, factions) {
  const W = state.w, H = state.h, N = W * H;

  // 1. Источники влияния
  const src = [];
  const active = [];
  const mark = (code) => { if (!active.includes(code)) active.push(code); };
  for (const b of buildings) {
    if (!b.done || b.destroyed) continue;
    const w = buildingWeight(b);
    if (w <= 0) continue;
    const half = ((b.size || 1) - 1) / 2;
    src.push({ code: OWNER_PLAYER, x: b.x + half, y: b.y + half, w });
    mark(OWNER_PLAYER);
  }
  for (const f of factions) {
    if (!f.alive) continue;
    const code = FACTION_CODE[f.id];
    if (!code) continue;
    for (const s of f.settlements || []) {
      const w = settlementWeight(f, s);
      if (w <= 0) continue;
      src.push({ code, x: s.x, y: s.y, w });
      mark(code);
    }
  }
  active.sort((a, b) => a - b); // фиксированный порядок обхода = детерминизм ничьих

  // 2. Сплат влияния в аккумуляторы. Обрезка радиусом — здесь весь выигрыш:
  // без неё это 9216 × число источников умножений на каждый пересчёт.
  for (const code of active) _acc(state, code).fill(0);
  for (const s of src) {
    const acc = _acc(state, s.code);
    const r = Math.min(MAX_RADIUS, Math.sqrt(Math.max(0, s.w / INFLUENCE_CUTOFF - 1)));
    const r2 = r * r;
    const x0 = Math.max(0, Math.ceil(s.x - r)), x1 = Math.min(W - 1, Math.floor(s.x + r));
    const y0 = Math.max(0, Math.ceil(s.y - r)), y1 = Math.min(H - 1, Math.floor(s.y + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y - s.y, dy2 = dy * dy, row = y * W;
      for (let x = x0; x <= x1; x++) {
        const dx = x - s.x, d2 = dx * dx + dy2;
        if (d2 > r2) continue;
        acc[row + x] += s.w / (1 + d2); // +1 в знаменателе: под самим зданием
      }                                  // деление на ноль дало бы бесконечность
    }
  }

  // 3. Владелец клетки: максимум влияния выше порога. Равенство — ничья
  // (спорная полоса между равными соседями), это и есть честное «упирание»
  // границ друг в друга по U03.
  const owners = state.owners, tiles = world.tiles;
  const areas = state.areas, cnt = state.tiles;
  areas.fill(0); cnt.fill(0);
  for (let i = 0; i < N; i++) {
    const t = tiles[i];
    if (t === TILE.DEEP || t === TILE.WATER) { owners[i] = OWNER_NONE; continue; }
    let best = 0, bestCode = OWNER_NONE, tie = false;
    for (let k = 0; k < active.length; k++) {
      const code = active[k];
      const v = state._acc[code][i];
      if (v > best + EPS) { best = v; bestCode = code; tie = false; }
      else if (bestCode !== OWNER_NONE && Math.abs(v - best) <= EPS) tie = true;
    }
    if (bestCode !== OWNER_NONE && best >= INFLUENCE_THRESHOLD && !tie) {
      owners[i] = bestCode;
      cnt[bestCode]++;
      areas[bestCode] += (t === TILE.MOUNTAIN) ? TAX_MOUNTAIN : 1;
    } else owners[i] = OWNER_NONE;
  }

  _buildDepth(state);
  _buildEdges(state);
}

function _countTiles(state) {
  state.tiles.fill(0);
  for (let i = 0; i < state.owners.length; i++) {
    const o = state.owners[i];
    if (o) state.tiles[o]++;
  }
}

// Карта глубины: 1 — клетка на кромке своей территории, дальше вглубь больше.
// Многоисточниковый BFS внутри каждой области; нужна для U02, чтобы вторжение
// в сердце чужой страны обходилось дороже, чем щипок приграничного поля.
function _buildDepth(state) {
  const W = state.w, H = state.h, N = W * H;
  const owners = state.owners, depth = state.depth;
  depth.fill(0);
  if (!state._queue || state._queue.length !== N) state._queue = new Int32Array(N);
  const q = state._queue;
  let head = 0, tail = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, o = owners[i];
      if (!o) continue;
      const edge =
        x === 0 || owners[i - 1] !== o ||
        x === W - 1 || owners[i + 1] !== o ||
        y === 0 || owners[i - W] !== o ||
        y === H - 1 || owners[i + W] !== o;
      if (edge) { depth[i] = 1; q[tail++] = i; }
    }
  }
  while (head < tail) {
    const i = q[head++], o = owners[i], d = depth[i];
    const x = i % W, y = (i / W) | 0;
    const nd = d < 255 ? d + 1 : 255;
    if (x > 0) { const j = i - 1; if (owners[j] === o && !depth[j]) { depth[j] = nd; q[tail++] = j; } }
    if (x < W - 1) { const j = i + 1; if (owners[j] === o && !depth[j]) { depth[j] = nd; q[tail++] = j; } }
    if (y > 0) { const j = i - W; if (owners[j] === o && !depth[j]) { depth[j] = nd; q[tail++] = j; } }
    if (y < H - 1) { const j = i + W; if (owners[j] === o && !depth[j]) { depth[j] = nd; q[tail++] = j; } }
  }
}

function _buildEdges(state) {
  const W = state.w, H = state.h;
  const owners = state.owners;
  const edges = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, o = owners[i];
      if (!o) continue;
      if (x === 0 || owners[i - 1] !== o) edges.push({ x1: x, y1: y, x2: x, y2: y + 1, owner: o });
      if (x === W - 1 || owners[i + 1] !== o) edges.push({ x1: x + 1, y1: y, x2: x + 1, y2: y + 1, owner: o });
      if (y === 0 || owners[i - W] !== o) edges.push({ x1: x, y1: y, x2: x + 1, y2: y, owner: o });
      if (y === H - 1 || owners[i + W] !== o) edges.push({ x1: x, y1: y + 1, x2: x + 1, y2: y + 1, owner: o });
    }
  }
  state.edges = edges;
}

function _rleEncode(arr) {
  const out = [];
  if (!arr.length) return out;
  let cur = arr[0], n = 1;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === cur) { n++; continue; }
    out.push(cur, n); cur = arr[i]; n = 1;
  }
  out.push(cur, n);
  return out;
}

function _rleDecode(rle, target) {
  let p = 0;
  for (let i = 0; i + 1 < rle.length; i += 2) {
    const val = rle[i], n = rle[i + 1];
    for (let k = 0; k < n && p < target.length; k++) target[p++] = val;
  }
  return target;
}
