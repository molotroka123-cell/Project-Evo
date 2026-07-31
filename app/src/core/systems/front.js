// core/systems/front.js — война на карте как ПРОЦЕСС (F01–F05).
// Бои, осады, контры и полководцы уже в army.js; территория и истощение — в
// borders.js. Здесь то, чего там нет: снабжение, линия фронта, захват точек,
// знаменосцы и туман войны. Чистый модуль: без DOM, вся случайность — через
// переданный rng, всё состояние — простой объект, который кладётся в JSON.
//
// ═════════════════════════════ МОДЕЛЬ ═════════════════════════════
// F01. Снабжение. Обоз идёт от ближайшего своего города по кратчайшему пути
//      (aStar) — интенданты ходят по дороге и обходов не ищут, поэтому враг,
//      севший на дорогу, режет линию, даже если в чистом поле есть крюк.
//      Разрыв → тают припасы (5 дней автономности) → голод роняет дух и копит
//      усталость → через 2 дня пустых обозов начинается дезертирство. Это и
//      есть главный ограничитель глубоких прорывов: армия без тыла не воюет.
// F02. Линия фронта — клетки соприкосновения враждебных отрядов (середины
//      отрезков между парами ближе FRONT_CONTACT). Разбитый отряд отбрасывается
//      на RETREAT_DIST клеток от победителя, поэтому после победы фронт
//      сдвигается сам собой — отдельной «карты фронта» не нужно.
// F03. Точки: города, рудники, переправы. Сторона, чьи отряды одни стоят у
//      точки, забирает её; точка даёт доход в день, а город ещё и становится
//      источником снабжения — захват меняет и экономику, и геометрию фронта.
// F04. Знаменосец: аура духа союзникам в радиусе; гибнет вместе с поражением
//      своего отряда — тогда дух соседей резко падает. После победы ставит
//      знамя: постоянную отметку на карте с днём и названием сражения.
// F05. Разведка: отряд видит на VISION_BASE клеток (+2 с холма — выше обзор),
//      своя точка — на POINT_VISION. Чужой отряд вне видимости остаётся в
//      памяти последней известной позицией; «призрак» стирается, только когда
//      разведка снова видит эту клетку и находит её пустой.
// ═══════════════════════════════════════════════════════════════════

import { TILE, WALKABLE } from '../data.js';
import { aStar, tileAt } from '../world.js';
import { tickArmy, findSquad, squadSize, squadAlive, ENGAGE_DIST } from './army.js';

// ---------------- Константы модели (экспортируются: на них опирается тест) ----------------
export const SUPPLY_MAX = 100;
export const SUPPLY_REGEN = 34;      // ~3 дня от нуля до полного при живой линии
export const SUPPLY_DRAIN = 20;      // 5 дней автономности после разрыва
export const SUPPLY_RANGE = 45;      // длиннее обоз не дотягивается (клеток пути)
export const INTERDICT_RADIUS = 2;   // враг ближе к дороге — линия перерезана
export const FATIGUE_PER_DAY = 15;
export const FATIGUE_REST = 30;
export const FATIGUE_DESERT = 30;    // 2 дня пустых обозов — и люди бегут
export const DESERT_RATE = 0.1;      // доля стека, уходящая за день дезертирства
export const MORALE_HUNGER = 8;
export const CAPTURE_DIST = 2;
export const BANNER_RADIUS = 6;
export const BANNER_AURA = 4;
export const BANNER_SHOCK = 30;      // гибель знаменосца бьёт сильнее проигрыша боя (35 в army.js — по самому отряду, тут — по всем соседям)
export const VISION_BASE = 7;
export const VISION_HILL = 2;
export const POINT_VISION = 5;
export const FRONT_CONTACT = 10;
export const RETREAT_DIST = 3;
const MAX_CHASE = 12;                // дальше конница (10) за день не дотягивается

// Доход точек в день. Город жирнее рудника: за него и воюют.
export const POINT_INCOME = {
  mine: { gold: 2.5, stone: 1 },
  ford: { gold: 1 },
  city: { gold: 4, food: 2 },
};
const POINT_KIND_RU = { mine: 'Рудник', ford: 'Переправа', city: 'Город' };

// ---------------- Состояние ----------------
export function createFrontState() {
  return {
    nextPointId: 1,
    points: [],    // {id, kind, x, y, name, owner: null|side}
    banners: [],   // {x, y, day, name, side} — постоянные отметки побед (F04)
    bearers: {},   // {squadId: true} — в каком отряде живёт знаменосец
    supply: {},    // {squadId: {val, fat, cut}}
    intel: {},     // {side: {enemySquadId: {x, y, side, day}}}
    cells: [],     // клетки фронта на конец последнего дня (производное, в сейв не идёт)
  };
}

// ---------------- Точки (F03) ----------------
export function addPoint(state, kind, x, y, name, owner = null) {
  const p = {
    id: state.nextPointId++,
    kind, x: Math.round(x), y: Math.round(y),
    name: name || `${POINT_KIND_RU[kind] || 'Точка'} №${state.nextPointId - 1}`,
    owner,
  };
  state.points.push(p);
  return p;
}

export function addCityPoint(state, x, y, name, owner = null) {
  return addPoint(state, 'city', x, y, name, owner);
}

export function pointsOf(state, side) {
  return state.points.filter(p => p.owner === side);
}

export function findPointNear(state, x, y, r = CAPTURE_DIST) {
  let best = null, bd = r;
  for (const p of state.points) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= bd) { bd = d; best = p; }
  }
  return best;
}

// Суммарный доход стороны со всех её точек — ядро прибавляет это к ресурсам.
export function pointIncomePerDay(state, side) {
  const out = {};
  for (const p of state.points) {
    if (p.owner !== side) continue;
    for (const [k, v] of Object.entries(POINT_INCOME[p.kind] || {})) out[k] = (out[k] || 0) + v;
  }
  return out;
}

// Рудники и переправы находятся по карте: рудник — холм у горы, переправа —
// песчаная коса между двумя водами. rng задаёт стартовую точку обхода, чтобы
// точки не липли к северо-западному углу на каждом сиде.
export function generatePoints(state, world, rng, opts = {}) {
  const maxMines = opts.maxMines ?? 3, maxFords = opts.maxFords ?? 2;
  const spacing = opts.spacing ?? 10;
  const mines = [], fords = [];
  for (let y = 1; y < world.h - 1; y++) {
    for (let x = 1; x < world.w - 1; x++) {
      const t = tileAt(world, x, y);
      if (t === TILE.HILL && _hasNb(world, x, y, TILE.MOUNTAIN)) mines.push({ x, y });
      else if (t === TILE.SAND && _countNb(world, x, y, TILE.WATER) >= 2 && _hasWalkNb(world, x, y)) fords.push({ x, y });
    }
  }
  const created = [];
  created.push(..._pickSpread(state, mines, 'mine', maxMines, spacing, rng));
  created.push(..._pickSpread(state, fords, 'ford', maxFords, spacing, rng));
  return created;
}

function _hasNb(world, x, y, t) {
  return tileAt(world, x + 1, y) === t || tileAt(world, x - 1, y) === t
    || tileAt(world, x, y + 1) === t || tileAt(world, x, y - 1) === t;
}
function _countNb(world, x, y, t) {
  let n = 0;
  if (tileAt(world, x + 1, y) === t) n++;
  if (tileAt(world, x - 1, y) === t) n++;
  if (tileAt(world, x, y + 1) === t) n++;
  if (tileAt(world, x, y - 1) === t) n++;
  return n;
}
function _hasWalkNb(world, x, y) {
  return WALKABLE.has(tileAt(world, x + 1, y)) || WALKABLE.has(tileAt(world, x - 1, y))
    || WALKABLE.has(tileAt(world, x, y + 1)) || WALKABLE.has(tileAt(world, x, y - 1));
}

function _pickSpread(state, cands, kind, max, spacing, rng) {
  const out = [];
  if (!cands.length || max <= 0) return out;
  const start = rng ? rng.int(0, cands.length - 1) : 0;
  let num = 1;
  for (let k = 0; k < cands.length && out.length < max; k++) {
    const c = cands[(start + k) % cands.length];
    if (out.some(p => Math.hypot(p.x - c.x, p.y - c.y) < spacing)) continue;
    if (state.points.some(p => Math.hypot(p.x - c.x, p.y - c.y) < spacing)) continue;
    out.push(addPoint(state, kind, c.x, c.y, `${POINT_KIND_RU[kind]} №${num++}`));
  }
  return out;
}

// ---------------- Снабжение (F01) ----------------
// ctx: { world, sources: [{x,y,side}], hostiles: [squad] (враги стороны отряда) }.
// Источники стороны = её города-точки + переданные ядром (кострище игрока,
// поселения фракций).
export function supplyStatus(state, sq, ctx) {
  const sources = [];
  for (const p of state.points) if (p.kind === 'city' && p.owner === sq.side) sources.push(p);
  for (const s of ctx.sources || []) if (s.side === sq.side) sources.push(s);
  if (!sources.length) return { connected: false, reason: 'нет тылового города', length: Infinity };
  // Проверяем три ближайших по прямой: дальний источник может оказаться ближе
  // по дороге, но перебирать все — лишние aStar каждый день.
  sources.sort((a, b) =>
    ((a.x - sq.x) ** 2 + (a.y - sq.y) ** 2) - ((b.x - sq.x) ** 2 + (b.y - sq.y) ** 2));
  let reason = 'путь не найден';
  for (const src of sources.slice(0, 3)) {
    const path = aStar(ctx.world, sq.x, sq.y, src.x, src.y);
    if (!path) continue;
    if (path.length > SUPPLY_RANGE) { reason = 'слишком глубоко: обоз не дотягивается'; continue; }
    const foe = _interdictor(path, ctx.hostiles || []);
    if (foe) { reason = 'дорога перехвачена врагом'; continue; }
    return { connected: true, length: path.length, source: src };
  }
  return { connected: false, reason, length: Infinity };
}

function _interdictor(path, hostiles) {
  for (const h of hostiles) {
    if (!squadAlive(h)) continue;
    for (const n of path) {
      if (Math.hypot(h.x - n.x, h.y - n.y) <= INTERDICT_RADIUS) return h;
    }
  }
  return null;
}

export function supplyOf(state, squadId) {
  return state.supply[squadId] || { val: SUPPLY_MAX, fat: 0, cut: false };
}

function _tickSupply(state, army, ctx, events) {
  const dt = ctx.dt ?? 1;
  const atWar = ctx.atWar || (() => true);
  for (const sq of army.squads) {
    if (!squadAlive(sq)) continue;
    const rec = state.supply[sq.id] || (state.supply[sq.id] = { val: SUPPLY_MAX, fat: 0, cut: false });
    const hostiles = army.squads.filter(s => s.side !== sq.side && squadAlive(s) && atWar(sq.side, s.side));
    const st = supplyStatus(state, sq, { world: ctx.world, sources: ctx.sources, hostiles });
    if (st.connected) {
      rec.val = Math.min(SUPPLY_MAX, rec.val + SUPPLY_REGEN * dt);
      rec.fat = Math.max(0, rec.fat - FATIGUE_REST * dt);
      rec.cut = false;
      continue;
    }
    if (!rec.cut) {
      rec.cut = true;
      events.push({ type: sq.side === 'player' ? 'warn' : 'info', text: `🪢 ${sq.name}: линия снабжения разорвана (${st.reason}).` });
    }
    rec.val = Math.max(0, rec.val - SUPPLY_DRAIN * dt);
    if (rec.val > 0) continue;
    // Голод: сначала дух и усталость, затем — дезертирство.
    rec.fat += FATIGUE_PER_DAY * dt;
    sq.morale = Math.max(0, (sq.morale ?? 100) - MORALE_HUNGER * dt);
    if (rec.fat < FATIGUE_DESERT) continue;
    let gone = 0;
    for (const [uid, n] of Object.entries(sq.units)) {
      if (n <= 0) continue;
      const d = Math.min(n, Math.max(1, Math.floor(n * DESERT_RATE)));
      gone += d;
      if (n - d > 0) sq.units[uid] = n - d; else delete sq.units[uid];
    }
    if (gone > 0) {
      events.push({ type: sq.side === 'player' ? 'bad' : 'info', text: `🏃 ${sq.name}: без припасов дезертировало ${gone} бойцов.` });
    }
    if (!squadAlive(sq)) {
      sq.dead = true;
      events.push({ type: sq.side === 'player' ? 'bad' : 'good', text: `☠ ${sq.name} разбежался без снабжения.` });
    }
  }
}

// ---------------- Знаменосцы (F04) ----------------
export function addBearer(state, squadId) { state.bearers[squadId] = true; }
export function hasBearer(state, squadId) { return !!state.bearers[squadId]; }

function _applyAura(state, army, dt) {
  for (const idStr of Object.keys(state.bearers)) {
    const bearer = findSquad(army, Number(idStr));
    if (!bearer || !squadAlive(bearer)) continue;
    for (const sq of army.squads) {
      if (sq.side !== bearer.side || !squadAlive(sq)) continue;
      if (Math.hypot(sq.x - bearer.x, sq.y - bearer.y) > BANNER_RADIUS) continue;
      sq.morale = Math.min(100, (sq.morale ?? 100) + BANNER_AURA * dt);
    }
  }
}

function _bearerFalls(state, army, side, x, y, events) {
  for (const sq of army.squads) {
    if (sq.side !== side || !squadAlive(sq)) continue;
    if (Math.hypot(sq.x - x, sq.y - y) > BANNER_RADIUS) continue;
    sq.morale = Math.max(0, (sq.morale ?? 100) - BANNER_SHOCK);
  }
  events.push({ type: side === 'player' ? 'bad' : 'info', text: `🕯 Знаменосец пал у (${x},${y}) — дух армии дрогнул.` });
}

function _plantBanner(state, side, x, y, day, events) {
  const near = findPointNear(state, x, y, 4);
  const name = near ? `Битва за «${near.name}»` : `Битва у (${x},${y})`;
  state.banners.push({ x, y, day, name, side });
  events.push({
    type: side === 'player' ? 'good' : 'info', chronicle: true,
    text: `🚩 Знаменосец водрузил знамя: «${name}», день ${day}.`,
  });
}

// ---------------- Обнаружение боёв ----------------
// army.js разыгрывает бои внутри tickArmy и наружу отдаёт только тексты,
// а чужие файлы менять нельзя. Поэтому бой восстанавливается по снимку
// «до/после»: исчезнувший отряд погиб рядом с врагом; пара уцелевших врагов
// вплотную с потерями — размен, победил потерявший меньшую долю.
function _snapshot(army) {
  const m = new Map();
  for (const sq of army.squads) {
    if (squadAlive(sq)) m.set(sq.id, { id: sq.id, side: sq.side, x: sq.x, y: sq.y, n: squadSize(sq) });
  }
  return m;
}

function _detectBattles(before, army, atWar) {
  const battles = [];
  const alive = army.squads.filter(s => squadAlive(s));
  const aliveIds = new Set(alive.map(s => s.id));
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
      if (a.side === b.side || !atWar(a.side, b.side)) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) > ENGAGE_DIST + 0.01) continue;
      const ba = before.get(a.id), bb = before.get(b.id);
      if (!ba || !bb) continue;
      const lossA = 1 - squadSize(a) / ba.n, lossB = 1 - squadSize(b) / bb.n;
      if (lossA <= 0 && lossB <= 0) continue;
      const winner = lossA <= lossB ? a : b, loser = winner === a ? b : a;
      battles.push({ winner, loser, loserId: loser.id, loserSide: loser.side, x: Math.round(loser.x), y: Math.round(loser.y), loserAlive: true });
    }
  }
  for (const [id, rec] of before) {
    if (aliveIds.has(id) || rec.n <= 0) continue;
    let winner = null, bd = MAX_CHASE;
    for (const s of alive) {
      if (s.side === rec.side || !atWar(rec.side, s.side)) continue;
      const d = Math.hypot(s.x - rec.x, s.y - rec.y);
      if (d < bd) { bd = d; winner = s; }
    }
    if (winner) battles.push({ winner, loser: null, loserId: id, loserSide: rec.side, x: Math.round(rec.x), y: Math.round(rec.y), loserAlive: false });
  }
  return battles;
}

function _handleBattles(state, army, battles, ctx, events) {
  const day = ctx.day ?? 0;
  for (const b of battles) {
    // F04: знамя проигравшего падает вместе с отрядом.
    if (state.bearers[b.loserId]) {
      delete state.bearers[b.loserId];
      _bearerFalls(state, army, b.loserSide, b.x, b.y, events);
    }
    if (state.bearers[b.winner.id]) _plantBanner(state, b.winner.side, b.x, b.y, day, events);
    // F02: разбитый, но живой отряд отбрасывается — фронт двигается вперёд.
    if (b.loserAlive && b.loser && squadAlive(b.loser)) _pushBack(b.loser, b.winner, ctx.world);
  }
}

function _pushBack(loser, winner, world) {
  let dx = loser.x - winner.x, dy = loser.y - winner.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) { dx = 1; dy = 0; } else { dx /= d; dy /= d; }
  const nx = Math.round(loser.x + dx * RETREAT_DIST), ny = Math.round(loser.y + dy * RETREAT_DIST);
  if (world && !WALKABLE.has(tileAt(world, nx, ny))) return; // спиной к горе — отступать некуда
  if (nx < 0 || ny < 0 || (world && (nx >= world.w || ny >= world.h))) return;
  loser.x = nx; loser.y = ny;
  loser.path = null; loser.pathIdx = 0; // старый маршрут после бегства недействителен
}

// ---------------- Захват точек (F03) ----------------
function _tickCapture(state, army, events) {
  for (const p of state.points) {
    const sides = new Set();
    for (const sq of army.squads) {
      if (!squadAlive(sq)) continue;
      if (Math.hypot(sq.x - p.x, sq.y - p.y) <= CAPTURE_DIST) sides.add(sq.side);
    }
    // Захват только при безраздельном присутствии: спорную точку не берёт никто.
    if (sides.size !== 1) continue;
    const side = [...sides][0];
    if (p.owner === side) continue;
    p.owner = side;
    events.push({
      type: side === 'player' ? 'good' : 'warn', chronicle: p.kind === 'city',
      text: `⛳ ${p.name} (${p.x},${p.y}) перешёл под контроль: ${side === 'player' ? 'ваши войска' : side}.`,
    });
  }
}

// ---------------- Разведка и туман (F05) ----------------
export function visionOf(sq, world) {
  return VISION_BASE + (world && tileAt(world, sq.x, sq.y) === TILE.HILL ? VISION_HILL : 0);
}

// Видит ли сторона клетку (x,y) — своими отрядами или своими точками.
export function canSee(state, army, side, x, y, world) {
  for (const sq of army.squads) {
    if (sq.side !== side || !squadAlive(sq)) continue;
    if (Math.hypot(sq.x - x, sq.y - y) <= visionOf(sq, world)) return true;
  }
  for (const p of state.points) {
    if (p.owner === side && Math.hypot(p.x - x, p.y - y) <= POINT_VISION) return true;
  }
  return false;
}

function _tickIntel(state, army, ctx) {
  const day = ctx.day ?? 0;
  const sides = new Set(army.squads.map(s => s.side));
  for (const p of state.points) if (p.owner) sides.add(p.owner);
  for (const side of sides) {
    const known = state.intel[side] || (state.intel[side] = {});
    for (const sq of army.squads) {
      if (sq.side === side || !squadAlive(sq)) continue;
      if (canSee(state, army, side, sq.x, sq.y, ctx.world)) {
        known[sq.id] = { x: Math.round(sq.x), y: Math.round(sq.y), side: sq.side, day };
      }
    }
    // Призрак стирается, только когда разведка видит его клетку пустой.
    for (const [idStr, rec] of Object.entries(known)) {
      const sq = findSquad(army, Number(idStr));
      const there = sq && squadAlive(sq) && Math.round(sq.x) === rec.x && Math.round(sq.y) === rec.y;
      if (!there && canSee(state, army, side, rec.x, rec.y, ctx.world)) delete known[idStr];
    }
  }
}

// Последняя известная позиция врага (или null). Для рендера: рисовать призрак,
// если день записи меньше текущего.
export function lastKnown(state, side, enemySquadId) {
  return (state.intel[side] || {})[enemySquadId] || null;
}

// Всё, что сторона «знает» о чужих отрядах: {x, y, side, day, fresh}.
export function knownEnemies(state, side, day) {
  const out = [];
  for (const [id, rec] of Object.entries(state.intel[side] || {})) {
    out.push({ id: Number(id), ...rec, fresh: rec.day >= day });
  }
  return out;
}

// ---------------- Линия фронта (F02) ----------------
export function computeFront(state, army, atWar) {
  const hostile = atWar || (() => true);
  const cells = [], seen = new Set();
  const alive = army.squads.filter(s => squadAlive(s));
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
      if (a.side === b.side || !hostile(a.side, b.side)) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) > FRONT_CONTACT) continue;
      const x = Math.round((a.x + b.x) / 2), y = Math.round((a.y + b.y) / 2);
      const key = x + ',' + y;
      if (seen.has(key)) continue;
      seen.add(key);
      cells.push({ x, y, a: a.side, b: b.side });
    }
  }
  state.cells = cells;
  return cells;
}

// ---------------- Главный ход дня ----------------
// Обёртка вокруг Army.tickArmy: снабжение и аура ДО боёв, знамёна, отброс
// разбитых, захват точек, разведка и фронт — ПОСЛЕ. Вызывается вместо прямого
// Army.tickArmy. ctx — тот же, что у tickArmy, плюс day и sources.
export function tickWar(state, army, ctx, rng) {
  if (!rng) throw new Error('tickWar: нужен rng');
  const events = [];
  const atWar = ctx.atWar || (() => true);
  const dt = ctx.dt ?? 1;

  _tickSupply(state, army, ctx, events);
  army.squads = army.squads.filter(s => !s.dead); // разбежавшиеся от голода
  _applyAura(state, army, dt);

  const before = _snapshot(army);
  events.push(...tickArmy(army, ctx, rng));
  const battles = _detectBattles(before, army, atWar);
  _handleBattles(state, army, battles, ctx, events);

  _tickCapture(state, army, events);
  _tickIntel(state, army, ctx);
  computeFront(state, army, atWar);

  // Чистка записей по отрядам, которых больше нет (кроме intel: там — память).
  const ids = new Set(army.squads.map(s => s.id));
  for (const k of Object.keys(state.supply)) if (!ids.has(Number(k))) delete state.supply[k];
  for (const k of Object.keys(state.bearers)) if (!ids.has(Number(k))) delete state.bearers[k];

  return events;
}

// ---------------- Сериализация ----------------
export function serializeFront(state) {
  return {
    v: 1,
    nextPointId: state.nextPointId,
    points: state.points.map(p => ({ ...p })),
    banners: state.banners.map(b => ({ ...b })),
    bearers: { ...state.bearers },
    supply: Object.fromEntries(Object.entries(state.supply).map(([k, v]) => [k, { ...v }])),
    intel: Object.fromEntries(Object.entries(state.intel).map(([side, m]) =>
      [side, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v }]))])),
  };
}

export function deserializeFront(data) {
  const st = createFrontState();
  if (!data) return st;
  st.nextPointId = data.nextPointId || 1;
  st.points = (data.points || []).map(p => ({ ...p }));
  st.banners = (data.banners || []).map(b => ({ ...b }));
  st.bearers = { ...(data.bearers || {}) };
  st.supply = Object.fromEntries(Object.entries(data.supply || {}).map(([k, v]) =>
    [k, { val: v.val ?? SUPPLY_MAX, fat: v.fat ?? 0, cut: !!v.cut }]));
  st.intel = Object.fromEntries(Object.entries(data.intel || {}).map(([side, m]) =>
    [side, Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k, { ...v }]))]));
  return st;
}

// ---------------- Система-адаптер для ядра ----------------
// Тонкая обёртка над чистыми функциями: собирает ctx из sim и раскладывает
// доход точек по ресурсам игрока.
export function createFrontSystem() {
  const state = createFrontState();
  return {
    state,
    onNewDay(sim) {
      const sources = [{ x: sim.world.startX, y: sim.world.startY, side: 'player' }];
      for (const f of sim.factions || []) {
        if (!f.alive) continue;
        for (const s of f.settlements || []) sources.push({ x: s.x, y: s.y, side: f.id });
      }
      const atWar = (a, b) => (a === 'player' || b === 'player')
        ? (sim.wars || []).some(w => w.fid === (a === 'player' ? b : a))
        : (sim.aiWars || []).some(w => (w.a === a && w.b === b) || (w.a === b && w.b === a));
      const events = tickWar(state, sim.armyState, {
        world: sim.world, dt: 1, day: sim.day, factions: sim.factions, atWar, sources,
      }, sim.rng);
      const inc = pointIncomePerDay(state, 'player');
      for (const [k, v] of Object.entries(inc)) if (sim.res && sim.res[k] != null) sim.res[k] += v;
      return events;
    },
    serialize() { return serializeFront(state); },
    deserialize(data) {
      const fresh = deserializeFront(data);
      state.nextPointId = fresh.nextPointId;
      state.points = fresh.points; state.banners = fresh.banners;
      state.bearers = fresh.bearers; state.supply = fresh.supply;
      state.intel = fresh.intel; state.cells = [];
    },
  };
}

/* ИНТЕГРАЦИЯ (simulation.js; я НЕ редактировал чужие файлы — вставки за вами):

1) Импорт рядом с прочими системами:
     import * as Front from './systems/front.js';

2) constructor(), ПОСЛЕ создания this.armyState (см. интеграцию army.js):
     this.front = Front.createFrontSystem();
     Front.generatePoints(this.front.state, this.world, this.rng);
     Front.addCityPoint(this.front.state, this.world.startX, this.world.startY,
       'Ваше поселение', 'player');
     for (const f of this.factions) {
       for (const s of f.settlements || []) {
         Front.addCityPoint(this.front.state, s.x, s.y,
           `Город (${f.def ? f.def.name : f.id})`, f.id);
       }
     }

3) onNewDay(): ЗАМЕНИТЬ прямой вызов Army.tickArmy(...) (п.3 интеграции army.js)
   на один вызов — он сам прогонит tickArmy внутри:
     const ev = this.front.onNewDay(this);
     for (const e of ev) { this.addLog(e.text, e.type); if (e.chronicle) this.addChronicle(e.text); }

4) Найм знаменосца (кнопка в HUD казармы, цена на ваш вкус, например 30 золота):
     Front.addBearer(this.front.state, squadId);
   Проверка для интерфейса: Front.hasBearer(this.front.state, squadId).

5) Сейв. serialize(): добавить  front: this.front.serialize(),
   deserialize(): sim.front.deserialize(data.front);
   (deserialize(undefined) отдаёт пустое состояние — старые сейвы грузятся,
   точки в этом случае сгенерировать заново, как в п.2).

6) Рендер (renderer.js):
   - точки: this.sim.front.state.points — {x, y, kind, name, owner};
   - знамёна: this.sim.front.state.banners — {x, y, day, name} (рисовать флажок,
     в тултипе name и day);
   - линия фронта: this.sim.front.state.cells — клетки соприкосновения;
   - туман: чужой отряд рисовать ТОЛЬКО если
       Front.canSee(this.sim.front.state, this.sim.armyState, 'player', sq.x, sq.y, this.sim.world),
     иначе — призрак по Front.knownEnemies(this.sim.front.state, 'player', this.sim.day)
     (полупрозрачный, с пометкой «замечен в день N»);
   - снабжение в тултипе отряда: Front.supplyOf(this.sim.front.state, sq.id)
     → {val: 0..100, fat, cut}.
*/
