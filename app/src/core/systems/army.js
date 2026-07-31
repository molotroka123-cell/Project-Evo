// core/systems/army.js — армия на карте (U19–U24): отряды, контр-цикл, высота,
// осада двумя путями, захват машин и походы на поселения фракций.
// Чистый модуль: без DOM, импортирует только data.js и world.js, вся случайность —
// через переданный rng (детерминизм от сида сохраняется), всё состояние — простой
// объект, который кладётся в JSON.
//
// ═════════════════════════════ МОДЕЛЬ ═════════════════════════════
// U19. Отряд — объект на карте: позиция, состав по типам UNITS, осадные машины,
//      приказ и путь из aStar. Абстрактное число this.army.soldiers остаётся
//      «резервом в поселении»; на карту выходят только сформированные отряды.
//
// U20. Бой — раундовая перестрелка на истощение, а не сравнение двух чисел.
//      Каждый раунд обе стороны бьют ОДНОВРЕМЕННО (по силам на начало раунда),
//      поэтому «кто первый ходит» не даёт преимущества. Урон превращается в
//      потери: дешёвый юнит гибнет быстрее дорогого. Сторона бежит, когда потери
//      перешагнули порог стойкости — отсюда берутся выжившие, брошенные машины
//      и разница между «разгромом» и «размен».
//      Контры берутся из COUNTERS: бонус применяется ПРОПОРЦИОНАЛЬНО доле
//      контрящейся роли в силе врага (COUNTER_DIVISOR переводит табличные «+7»
//      в множитель). Плоское «+7 к силе» из таблицы напрямую использовать нельзя:
//      для ополченца (power 2) это учетверение, для дрона (power 30) — мелочь,
//      то есть контра ломала бы ранние эпохи и не работала бы в поздних.
//      Калибровка (см. app/tests/test-army.mjs): равные армии дают ~50%,
//      контр-юнит против своей цели — 60–75%. Заметно, но не абсолютно.
//
// U21. Высота: на TILE.HILL стрелки бьют дальше и сверху (×HILL_RANGE_MULT),
//      в лесу стрелки и конница теснятся (обзор и разгон). Это множитель
//      силы по РОЛИ, а не по стороне, поэтому армия на холме без стрелков
//      бонуса не получает — холм ценен под конкретный состав.
//
// U22. Осада: у укрепления ДВА отдельных запаса прочности — ворота и стены.
//      Тараны бьют только ворота, лестницы и катапульты — только стены.
//      Пролом ворот даёт полноценный штурм (гарнизон почти теряет бонус стен),
//      взятые лестницами стены — штурм с ходу вверх по перекладинам (сила
//      атакующего ×ASSAULT_WALL, у защитника остаётся часть бонуса). Штурм без
//      пролома вообще — самоубийство (×ASSAULT_NONE). Один «числовой» бонус
//      обороны превращается в выбор: ждать таран или лезть по лестницам.
//
// U23. Захват машин: у машин есть расчёт. Когда сторона обращена в бегство,
//      машины бросают — победитель с шансом CAPTURE_CHANCE забирает каждую
//      себе, остальные сгорают. Поэтому осадный парк можно не только построить,
//      но и отнять; и поэтому машины нельзя таскать без прикрытия пехоты.
//
// U24. Поход: приказ «взять поселение» ведёт отряд к точке фракции, сам
//      разворачивает осаду, ломает ворота/стены и штурмует гарнизон. При победе
//      поселение исчезает у фракции (модуль удаляет его из f.settlements) и
//      возвращается событие для лога/хроники ядра.
//
// ═══════════════════════════ INTEGRATION ═══════════════════════════
// simulation.js (я НЕ редактировал ни одного чужого файла — вставки за вами):
//
// 1) Импорт рядом с прочими:
//      import * as Army from './systems/army.js';
//
// 2) constructor(), рядом с блоком «армия/рейды» (после this.raids = {...}):
//      this.armyState = Army.createArmyState();
//
// 3) onNewDay() или tick() — один вызов на игровой день, ПОСЛЕ this.tickFactions()
//    (чтобы гарнизоны считались по уже обновлённым armyPts) и ДО tickRaids():
//      const ev = Army.tickArmy(this.armyState, {
//        world: this.world,
//        dt: 1,                              // в игровых днях
//        factions: this.factions,
//        atWar: (a, b) => a === 'player' || b === 'player'
//          ? this.wars.some(w => w.fid === (a === 'player' ? b : a))
//          : this.aiWars.some(w => (w.a === a && w.b === b) || (w.a === b && w.b === a)),
//      }, this.rng);
//      for (const e of ev) { this.addLog(e.text, e.type); if (e.chronicle) this.addChronicle(e.text); }
//    Читаемые ctx-поля ровно эти: world, dt, factions, atWar и необязательные
//    garrisonFor(f, s) / fortFor(f, s) — подменить гарнизон и укрепление своими.
//
// 3a) Оборона самого поселения игрока осталась за ядром (tickRaids/resolveRaid):
//     модуль НЕ водит вражеские отряды на кострище. Готовое укрепление игрока
//     для будущей осады отдаёт Army.fortFromBuildings(this.doneBuildings()) —
//     стены и ворота считаются по полям wall/defense из BUILDINGS.
//
// 4) Формирование отряда из резерва (кнопка «Собрать отряд» в HUD):
//      const n = Math.min(k, this.army.soldiers);
//      const sq = Army.formSquad(this.armyState, {
//        side: 'player', x: this.world.startX, y: this.world.startY,
//        units: { [this.bestUnit().id]: n },
//        powerBonus: this.army.powerBonus, mult: this.globalMult('army'),
//      });
//      this.army.soldiers -= n;
//    Роспуск — Army.disbandSquad(this.armyState, sq.id) возвращает бойцов:
//      this.army.soldiers += Army.squadSize(sq);
//
// 5) Приказы из HUD (клик по карте):
//      Army.orderMove(this.armyState, id, x, y, this.world);
//      Army.orderAttack(this.armyState, id, enemySquadId, this.world);
//      Army.orderHold(this.armyState, id);
//      Army.orderCampaign(this.armyState, id, faction.id, s.x, s.y, this.world); // U24
//
// 6) Осадные машины строятся в Казарме тем же путём, что и бойцы:
//      Army.SIEGE_ENGINES[id].cost / .req — цена и технология; после оплаты
//      Army.addEngine(this.armyState, squadId, id, 1).
//
// 7) Сейв. serialize(): добавить  armyState: Army.serializeArmy(this.armyState),
//    deserialize(): sim.armyState = Army.deserializeArmy(data.armyState);
//    (deserializeArmy(undefined) отдаёт пустое состояние — старые сейвы грузятся).
//
// 8) Рендер (renderer.js): Army.allSquads(sim.armyState) → массив отрядов;
//    экранная точка = (ox + sq.x * z, oy + sq.y * z), подпись Army.squadReport(sq),
//    цвет по sq.side ('player' → золотой, иначе FACTIONS.find(...).color),
//    линия приказа — по sq.path от sq.pathIdx.
// ═══════════════════════════════════════════════════════════════════

import { TILE, UNITS, COUNTERS, BUILDINGS } from '../data.js';
import { aStar, tileAt } from '../world.js';

// ---------------- Осадные машины ----------------
// В UNITS их нет и добавить туда нельзя (чужой файл), а роль 'siege' в COUNTERS
// уже заведена — значит машины задуманы отдельным классом. Здесь он и живёт.
// target — что именно машина ломает: в этом весь смысл U22.
export const SIEGE_ENGINES = {
  ram:      { id: 'ram',      name: 'Таран',        role: 'siege', target: 'gate', power: 16, crew: 4, speed: 3, req: 'warfare',     cost: { wood: 40, stone: 10 }, fieldPower: 2 },
  ladder:   { id: 'ladder',   name: 'Лестница',     role: 'siege', target: 'wall', power: 9,  crew: 2, speed: 4, req: 'warfare',     cost: { wood: 25 },            fieldPower: 1 },
  catapult: { id: 'catapult', name: 'Катапульта',   role: 'siege', target: 'wall', power: 26, crew: 5, speed: 2, req: 'mathematics', cost: { wood: 60, stone: 40 }, fieldPower: 7 },
};

// ---------------- Константы модели (экспортируются: на них опирается тест) ----------------
// Доля силы, уходящая в урон за раунд. При TOUGHNESS 2.5 это ~14% потерь врага
// за раунд — бой равных длится 4–6 раундов, что даёт место случайности и рауту.
export const ROUND_RATE = 0.35;
export const TOUGHNESS = 2.5;      // во сколько раз «живучесть» юнита больше его силы
export const ROUND_VAR = 0.45;     // разброс урона за раунд: ±45%
export const MAX_ROUNDS = 10;
export const ROUT_BASE = 0.5;      // при таких потерях сторона бежит
export const ROUT_JITTER = 0.12;   // стойкость конкретного отряда гуляет
// Переводит табличные «+7 эффективной силы» в множитель. 70 подобрано стендом
// на 4000 боёв: контра даёт +10% силы против «своей» цели, что выливается в
// winrate 66% — заметно, но не абсолютно (при 50 было бы 78%, при 120 — 58%).
export const COUNTER_DIVISOR = 70;
// U21. 1.15 — не «чуть-чуть»: в модели на истощение +15% силы стрелков дают
// стороне на холме ~74% побед (стенд в тесте). Больше делать нельзя — рельеф
// начнёт решать бой сильнее состава.
export const HILL_RANGE_MULT = 1.15;
export const FOREST_RANGE_MULT = 0.85; // в лесу не видно цели
export const FOREST_CAV_MULT = 0.9;    // и не разогнаться
export const CAPTURE_CHANCE = 0.5;     // U23: шанс, что брошенная машина цела
export const DEFENSE_SCALE = 30;       // оборона 30 (замок) удваивает силу гарнизона
export const ASSAULT_GATE = 1.0;       // U22: штурм в пролом ворот
export const ASSAULT_WALL = 0.75;      // штурм по лестницам
export const ASSAULT_NONE = 0.45;      // лобовой штурм без пролома
export const DEF_KEEP_GATE = 0.25;     // сколько бонуса стен остаётся защитнику
export const DEF_KEEP_WALL = 0.6;
export const GATE_SHARE = 0.35;        // доля прочности укреплений, приходящаяся на ворота
export const GATE_MIN = 120;
export const SIEGE_BARE_RATE = 0.02;   // осада без машин: голыми руками по воротам
export const DEF_FIRE = 0.005;         // шанс сбить машину за день на единицу обороны
export const ENGAGE_DIST = 1.2;        // с какого расстояния отряды сцепляются
export const MORALE_REGEN = 6;         // восстановление боевого духа в день

const SPEED_BY_ROLE = { inf: 6, cav: 10, range: 6, siege: 3 };

const UNIT_BY_ID = Object.fromEntries(UNITS.map(u => [u.id, u]));

// ---------------- Мелкие справочники ----------------
export function unitDef(id) { return UNIT_BY_ID[id] || null; }
export function engineDef(id) { return SIEGE_ENGINES[id] || null; }

// Юниты, доступные по изученным технологиям (techs — Set из ядра).
export function availableUnits(techs) {
  return UNITS.filter(u => !u.req || (techs && techs.has(u.req)));
}
export function availableEngines(techs) {
  return Object.values(SIEGE_ENGINES).filter(e => !e.req || (techs && techs.has(e.req)));
}

// ---------------- Состояние ----------------
export function createArmyState() {
  return {
    nextId: 1,
    squads: [],
    battles: 0,      // сколько боёв разрешено (метрика и проверка в тестах)
    captures: 0,     // сколько поселений взято походами (U24)
    lastBattle: null, // отчёт о последнем бое — для HUD
  };
}

export function allSquads(state) { return state.squads; }
export function findSquad(state, id) { return state.squads.find(s => s.id === id) || null; }
export function squadsOf(state, side) { return state.squads.filter(s => s.side === side); }

// Формирование отряда. units — {unitId: count}, engines — {engineId: count}.
export function formSquad(state, opts = {}) {
  const units = {};
  for (const [uid, n] of Object.entries(opts.units || {})) {
    if (UNIT_BY_ID[uid] && n > 0) units[uid] = Math.floor(n);
  }
  const engines = {};
  for (const [eid, n] of Object.entries(opts.engines || {})) {
    if (SIEGE_ENGINES[eid] && n > 0) engines[eid] = Math.floor(n);
  }
  const sq = {
    id: state.nextId++,
    side: opts.side || 'player',
    name: opts.name || defaultName(units, engines),
    x: opts.x ?? 0, y: opts.y ?? 0,
    units, engines,
    powerBonus: opts.powerBonus || 0,  // «Полководец» из ядра: +N к силе каждого бойца
    mult: opts.mult || 1,              // armyMult зданий/фракции
    morale: 100,
    order: { type: 'hold' },
    path: null, pathIdx: 0,
    siege: null,                        // состояние осады, когда отряд стоит у стен
    dead: false,
  };
  state.squads.push(sq);
  return sq;
}

function defaultName(units, engines) {
  const top = Object.keys(units)[0];
  if (top && UNIT_BY_ID[top]) return `Отряд «${UNIT_BY_ID[top].name}»`;
  const eng = Object.keys(engines)[0];
  if (eng) return `Осадный обоз «${SIEGE_ENGINES[eng].name}»`;
  return 'Отряд';
}

export function disbandSquad(state, id) {
  const i = state.squads.findIndex(s => s.id === id);
  if (i < 0) return null;
  return state.squads.splice(i, 1)[0];
}

export function addEngine(state, squadId, engineId, count = 1) {
  const sq = findSquad(state, squadId);
  if (!sq || !SIEGE_ENGINES[engineId] || count <= 0) return false;
  sq.engines[engineId] = (sq.engines[engineId] || 0) + Math.floor(count);
  return true;
}

export function squadSize(sq) {
  let n = 0;
  for (const v of Object.values(sq.units || {})) n += v;
  return n;
}
export function engineCount(sq) {
  let n = 0;
  for (const v of Object.values(sq.engines || {})) n += v;
  return n;
}
export function squadAlive(sq) { return !sq.dead && (squadSize(sq) > 0 || engineCount(sq) > 0); }

// Скорость отряда — по самому медленному: обоз с катапультами ползёт.
export function squadSpeed(sq) {
  let v = Infinity;
  for (const [uid, n] of Object.entries(sq.units || {})) {
    if (n > 0) v = Math.min(v, SPEED_BY_ROLE[UNIT_BY_ID[uid].role] || 6);
  }
  for (const [eid, n] of Object.entries(sq.engines || {})) {
    if (n > 0) v = Math.min(v, SIEGE_ENGINES[eid].speed);
  }
  return Number.isFinite(v) ? v : 6;
}

// ---------------- Приказы (U19) ----------------
export function orderHold(state, id) {
  const sq = findSquad(state, id);
  if (!sq) return false;
  sq.order = { type: 'hold' };
  sq.path = null; sq.pathIdx = 0; sq.siege = null;
  return true;
}

export function orderMove(state, id, x, y, world) {
  const sq = findSquad(state, id);
  if (!sq) return false;
  sq.order = { type: 'move', tx: Math.round(x), ty: Math.round(y) };
  sq.siege = null;
  return repath(sq, world);
}

export function orderAttack(state, id, targetId, world) {
  const sq = findSquad(state, id), tgt = findSquad(state, targetId);
  if (!sq || !tgt) return false;
  sq.order = { type: 'attack', targetId, tx: Math.round(tgt.x), ty: Math.round(tgt.y) };
  sq.siege = null;
  return repath(sq, world);
}

// U24: поход на поселение фракции.
export function orderCampaign(state, id, factionId, sx, sy, world) {
  const sq = findSquad(state, id);
  if (!sq) return false;
  sq.order = { type: 'capture', factionId, tx: Math.round(sx), ty: Math.round(sy) };
  sq.siege = null;
  return repath(sq, world);
}

// Путь считает aStar. Если цель недостижима (остров, гора) — отряд остаётся
// на месте с приказом, но без пути: молчаливое «пошёл напрямик через воду»
// было бы хуже, чем честное «дойти нельзя».
function repath(sq, world) {
  if (!world) { sq.path = null; sq.pathIdx = 0; return false; }
  const path = aStar(world, sq.x, sq.y, sq.order.tx, sq.order.ty);
  sq.path = path ? path.map(p => ({ x: p.x, y: p.y })) : null;
  sq.pathIdx = path ? 1 : 0; // 0-й узел — текущая клетка
  return !!path;
}

// ---------------- Сила и контры (U20, U21) ----------------
function powerOf(uid, bonus) { return UNIT_BY_ID[uid].power + bonus; }

// Доли ролей в силе стороны. Считаем именно по силе, а не по головам: сотня
// ополченцев и десяток рыцарей — разная угроза, и контра должна это видеть.
export function roleMix(force) {
  const mix = { inf: 0, cav: 0, range: 0, siege: 0 };
  let total = 0;
  for (const [uid, n] of Object.entries(force.units || {})) {
    if (n <= 0) continue;
    const p = n * powerOf(uid, force.powerBonus || 0);
    mix[UNIT_BY_ID[uid].role] += p; total += p;
  }
  for (const [eid, n] of Object.entries(force.engines || {})) {
    if (n <= 0) continue;
    const p = n * SIEGE_ENGINES[eid].fieldPower;
    mix.siege += p; total += p;
  }
  if (total > 0) for (const k of Object.keys(mix)) mix[k] /= total;
  return mix;
}

// U20: множитель контры роли против конкретного вражеского состава.
export function counterMult(role, enemyMix) {
  const row = COUNTERS[role];
  if (!row) return 1;
  let bonus = 0;
  for (const [target, v] of Object.entries(row)) {
    const share = enemyMix[target];
    if (share > 0) bonus += (v / COUNTER_DIVISOR) * share;
  }
  return 1 + bonus;
}

// U21: рельеф под ногами меняет силу ролей, а не сторон.
export function terrainMult(role, tile) {
  if (tile === TILE.HILL) return role === 'range' ? HILL_RANGE_MULT : 1;
  if (tile === TILE.FOREST) {
    if (role === 'range') return FOREST_RANGE_MULT;
    if (role === 'cav') return FOREST_CAV_MULT;
  }
  return 1;
}

// Полная боевая сила стороны против заданного врага на заданном тайле.
export function forcePower(force, enemyMix = { inf: 0, cav: 0, range: 0, siege: 0 }, tile = TILE.GRASS) {
  let atk = 0;
  const bonus = force.powerBonus || 0;
  for (const [uid, n] of Object.entries(force.units || {})) {
    if (n <= 0) continue;
    const d = UNIT_BY_ID[uid];
    atk += n * powerOf(uid, bonus) * counterMult(d.role, enemyMix) * terrainMult(d.role, tile);
  }
  // Машины в чистом поле почти бесполезны — они и не для того.
  for (const [eid, n] of Object.entries(force.engines || {})) {
    if (n > 0) atk += n * SIEGE_ENGINES[eid].fieldPower;
  }
  return atk * (force.mult || 1);
}

// Удобный вызов для HUD: «сколько стоит этот отряд сам по себе».
export function squadPower(sq, tile = TILE.GRASS) {
  return forcePower(sq, { inf: 0, cav: 0, range: 0, siege: 0 }, tile);
}

// ---------------- Бой (U20) ----------------
// Рабочая копия стороны: дробные счётчики, чтобы потери не квантовались по
// целому бойцу каждый раунд (иначе мелкие отряды воевали бы ступеньками).
function workForce(sq, mult) {
  const units = {}, engines = {};
  for (const [k, v] of Object.entries(sq.units || {})) if (v > 0) units[k] = v;
  for (const [k, v] of Object.entries(sq.engines || {})) if (v > 0) engines[k] = v;
  return { units, engines, powerBonus: sq.powerBonus || 0, mult: (sq.mult || 1) * (mult || 1) };
}

function headcount(f) {
  let n = 0;
  for (const v of Object.values(f.units)) n += v;
  return n;
}

// «Живая сила» без контр и рельефа: по ней меряется, насколько сторона побита.
// Считать потери по головам нельзя: в смешанной армии первыми выбивает дешёвую
// массу, и отряд с целыми рыцарями «бежал бы», потеряв обозную пехоту.
function rawPower(f) {
  let p = 0;
  for (const [uid, n] of Object.entries(f.units)) if (n > 0) p += n * powerOf(uid, f.powerBonus);
  return p;
}

// Урон раскладывается по стекам пропорционально численности (кто в строю —
// тот и под ударом), а цена одной смерти = сила юнита × TOUGHNESS: рыцаря
// выбить дороже, чем ополченца.
function applyDamage(f, dmg) {
  const total = headcount(f);
  if (total <= 0 || dmg <= 0) return 0;
  let killed = 0;
  for (const [uid, n] of Object.entries(f.units)) {
    if (n <= 0) continue;
    const share = dmg * (n / total);
    const cost = powerOf(uid, f.powerBonus) * TOUGHNESS;
    const dead = Math.min(n, share / cost);
    f.units[uid] = n - dead;
    killed += dead;
  }
  return killed;
}

function routThreshold(sq, rng) {
  const morale = sq && typeof sq.morale === 'number' ? sq.morale : 100;
  const jitter = rng.range(-ROUT_JITTER, ROUT_JITTER);
  return Math.max(0.2, (ROUT_BASE + jitter) * (0.6 + 0.4 * (morale / 100)));
}

function intCounts(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = Math.max(0, Math.round(v));
    if (n > 0) out[k] = n;
  }
  return out;
}

function diffCounts(before, after) {
  const out = {};
  for (const [k, v] of Object.entries(before)) {
    const d = v - (after[k] || 0);
    if (d > 0) out[k] = d;
  }
  return out;
}

// Главная функция боя. НЕ мутирует отряды — возвращает отчёт; применяет его
// applyBattle(). Так один и тот же бой можно прогнать тысячу раз в тесте.
// ctx: { tileA, tileB, multA, multB } — рельеф под каждой стороной и внешние
// множители (штурм, бонус стен).
export function resolveBattle(a, b, ctx = {}, rng) {
  if (!rng) throw new Error('resolveBattle: нужен rng');
  const A = workForce(a, ctx.multA), B = workForce(b, ctx.multB);
  const tileA = ctx.tileA ?? TILE.GRASS, tileB = ctx.tileB ?? TILE.GRASS;
  const startA = rawPower(A), startB = rawPower(B);
  const beforeA = { units: intCounts(A.units), engines: intCounts(A.engines) };
  const beforeB = { units: intCounts(B.units), engines: intCounts(B.engines) };
  // Пороги стойкости тянутся ДО первого раунда и всегда в одном порядке —
  // иначе одна ветка кода съедала бы разное число значений ГПСЧ и детерминизм
  // рассыпался бы на следующем бою.
  const routA = routThreshold(a, rng), routB = routThreshold(b, rng);

  let rounds = 0, routed = null, winner = null;
  while (rounds < MAX_ROUNDS) {
    rounds++;
    const mixA = roleMix(A), mixB = roleMix(B);
    const atkA = forcePower(A, mixB, tileA);
    const atkB = forcePower(B, mixA, tileB);
    const dmgA = atkA * ROUND_RATE * rng.range(1 - ROUND_VAR, 1 + ROUND_VAR);
    const dmgB = atkB * ROUND_RATE * rng.range(1 - ROUND_VAR, 1 + ROUND_VAR);
    applyDamage(B, dmgA);
    applyDamage(A, dmgB);
    const lossA = startA > 0 ? 1 - rawPower(A) / startA : 1;
    const lossB = startB > 0 ? 1 - rawPower(B) / startB : 1;
    const brokeA = headcount(A) <= 1e-6 || lossA >= routA;
    const brokeB = headcount(B) <= 1e-6 || lossB >= routB;
    if (brokeA || brokeB) {
      if (brokeA && brokeB) { routed = lossA >= lossB ? 'a' : 'b'; }
      else routed = brokeA ? 'a' : 'b';
      winner = routed === 'a' ? 'b' : 'a';
      break;
    }
  }
  if (!winner) {
    // Никто не сломался за отведённые раунды — победа за тем, кто сохранил
    // больше боевой силы; при точном равенстве побеждает обороняющийся (b).
    const pa = forcePower(A, roleMix(B), tileA), pb = forcePower(B, roleMix(A), tileB);
    winner = pa > pb ? 'a' : 'b';
  }

  const afterA = { units: intCounts(A.units), engines: { ...beforeA.engines } };
  const afterB = { units: intCounts(B.units), engines: { ...beforeB.engines } };
  // U23: разбитая сторона бросает машины. Победитель забирает уцелевшие.
  const loserAfter = winner === 'a' ? afterB : afterA;
  const winnerAfter = winner === 'a' ? afterA : afterB;
  const captured = {}, destroyed = {};
  for (const [eid, n] of Object.entries(loserAfter.engines)) {
    for (let i = 0; i < n; i++) {
      if (rng.chance(CAPTURE_CHANCE)) captured[eid] = (captured[eid] || 0) + 1;
      else destroyed[eid] = (destroyed[eid] || 0) + 1;
    }
  }
  loserAfter.engines = {};
  // Победитель тоже теряет машины — тем больше, чем тяжелее далась победа.
  const winnerLoss = winner === 'a'
    ? (startA > 0 ? 1 - rawPower(A) / startA : 0)
    : (startB > 0 ? 1 - rawPower(B) / startB : 0);
  for (const [eid, n] of Object.entries({ ...winnerAfter.engines })) {
    let left = n;
    for (let i = 0; i < n; i++) if (rng.chance(winnerLoss * 0.5)) left--;
    if (left > 0) winnerAfter.engines[eid] = left; else delete winnerAfter.engines[eid];
  }
  for (const [eid, n] of Object.entries(captured)) {
    winnerAfter.engines[eid] = (winnerAfter.engines[eid] || 0) + n;
  }

  return {
    winner, loser: winner === 'a' ? 'b' : 'a', routed, rounds,
    a: {
      before: beforeA, after: afterA,
      losses: diffCounts(beforeA.units, afterA.units),
      lossFrac: startA > 0 ? 1 - rawPower(A) / startA : 0,
    },
    b: {
      before: beforeB, after: afterB,
      losses: diffCounts(beforeB.units, afterB.units),
      lossFrac: startB > 0 ? 1 - rawPower(B) / startB : 0,
    },
    captured, destroyedEngines: destroyed,
  };
}

// Переносит итог боя в отряды. Боевой дух: победа поднимает, бегство роняет.
export function applyBattle(a, b, res) {
  a.units = { ...res.a.after.units }; a.engines = { ...res.a.after.engines };
  b.units = { ...res.b.after.units }; b.engines = { ...res.b.after.engines };
  const winSq = res.winner === 'a' ? a : b, loseSq = res.winner === 'a' ? b : a;
  winSq.morale = Math.min(100, (winSq.morale ?? 100) + 10);
  loseSq.morale = Math.max(0, (loseSq.morale ?? 100) - 35);
  for (const sq of [a, b]) if (!squadAlive(sq)) sq.dead = true;
}

// ---------------- Осада (U22) ----------------
export function createFortification(opts = {}) {
  const wall = Math.max(0, opts.wall || 0);
  const gate = Math.max(0, opts.gate ?? Math.max(GATE_MIN, wall * GATE_SHARE));
  return {
    wall, wallMax: wall,
    gate, gateMax: gate,
    defense: opts.defense || 0,
    breach: null,     // null | 'gate' | 'wall'
    days: 0,
  };
}

// Укрепление игрока считается по построенным стенам: у palisade/stone_walls в
// data.js уже есть поле wall, отдельную таблицу заводить незачем.
export function fortFromBuildings(buildings) {
  let wall = 0, defense = 0;
  for (const b of buildings || []) {
    if (b.destroyed || b.done === false) continue;
    const def = BUILDINGS[b.id];
    if (!def) continue;
    if (def.wall) wall += def.wall;
    if (def.defense) defense += def.defense;
  }
  return createFortification({ wall, defense });
}

// Укрепление поселения фракции: её wallPts — общий «фонд обороны», делённый
// между поселениями; столица укреплена вдвое.
export function fortFromFaction(f, settlement) {
  const n = Math.max(1, (f.settlements || []).length);
  const share = (f.wallPts || 0) / n;
  const cap = settlement && settlement.capital ? 2 : 1;
  const wall = Math.max(80, share * 4 * cap);
  return createFortification({ wall, defense: Math.max(2, share * 0.15 * cap) });
}

// Гарнизон поселения из теневой экономики фракции. Юнит — лучший, доступный
// её эпохе; численность — доля армейских очков, приходящаяся на поселение.
export function garrisonForFaction(f, settlement) {
  const n = Math.max(1, (f.settlements || []).length);
  const cap = settlement && settlement.capital ? 1.8 : 1;
  let best = UNITS[0];
  for (const u of UNITS) {
    const era = UNIT_ERA[u.id];
    if (era <= (f.era || 0)) best = u;
  }
  const pts = ((f.armyPts || 0) / n) * cap;
  const count = Math.max(2, Math.round(pts / best.power));
  return {
    id: -1, side: f.id, name: `Гарнизон ${f.def ? f.def.name : f.id}`,
    x: settlement ? settlement.x : 0, y: settlement ? settlement.y : 0,
    units: { [best.id]: count }, engines: {},
    powerBonus: 0, mult: (f.def && f.def.bonus && f.def.bonus.army) || 1,
    morale: 100, order: { type: 'hold' }, path: null, pathIdx: 0, siege: null, dead: false,
  };
}

// Эпоха юнита — по эпохе его технологии. Считаем один раз: гарнизон вызывается
// часто, а таблицы неизменны.
const UNIT_ERA = (() => {
  const map = {};
  // Порядок UNITS уже хронологический, поэтому индекс юнита — достаточная
  // мера «древности»; era фракции растёт до 9, юнитов 7 — растягиваем.
  UNITS.forEach((u, i) => { map[u.id] = Math.round(i * 9 / (UNITS.length - 1)); });
  return map;
})();

// Один день осады. Мутирует fort (это и есть её состояние) и потери расчётов
// в самом отряде. dt — доля дня.
export function resolveSiege(sq, fort, ctx = {}, rng) {
  if (!rng) throw new Error('resolveSiege: нужен rng');
  const dt = ctx.dt ?? 1;
  fort.days += dt;
  let gateDmg = 0, wallDmg = 0;
  for (const [eid, n] of Object.entries(sq.engines || {})) {
    if (n <= 0) continue;
    const e = SIEGE_ENGINES[eid];
    // COUNTERS.siege.building — табличный бонус машин против построек; здесь он
    // и работает, добавляясь к силе каждой машины.
    const p = n * (e.power + (COUNTERS.siege?.building || 0)) * rng.range(0.8, 1.2) * dt;
    if (e.target === 'gate') gateDmg += p; else wallDmg += p;
  }
  // Без машин остаётся ковырять ворота подручным: медленно и почти безнадёжно.
  if (gateDmg === 0 && wallDmg === 0) gateDmg = squadPower(sq) * SIEGE_BARE_RATE * dt;
  fort.gate = Math.max(0, fort.gate - gateDmg);
  fort.wall = Math.max(0, fort.wall - wallDmg);

  // Защитники бьют по машинам: осадный парк тает под стенами, если его не
  // прикрывать и не ломать ворота быстро.
  const enginesLost = {};
  let crewLost = 0;
  const pFire = Math.min(0.6, fort.defense * DEF_FIRE * dt);
  for (const [eid, n] of Object.entries({ ...sq.engines })) {
    let left = n;
    for (let i = 0; i < n; i++) if (rng.chance(pFire)) left--;
    const lost = n - left;
    if (lost > 0) {
      enginesLost[eid] = lost;
      crewLost += lost * SIEGE_ENGINES[eid].crew;
      if (left > 0) sq.engines[eid] = left; else delete sq.engines[eid];
    }
  }
  if (crewLost > 0) killCrew(sq, crewLost);

  if (fort.gate <= 0) fort.breach = 'gate';
  else if (fort.wall <= 0) fort.breach = 'wall';

  return { gateDmg, wallDmg, breach: fort.breach, enginesLost, crewLost, gate: fort.gate, wall: fort.wall };
}

// Расчёт машин гибнет из пехоты — она их и катит.
function killCrew(sq, n) {
  const order = ['inf', 'range', 'cav'];
  for (const role of order) {
    for (const [uid, cnt] of Object.entries(sq.units)) {
      if (n <= 0) return;
      if (UNIT_BY_ID[uid].role !== role || cnt <= 0) continue;
      const dead = Math.min(cnt, n);
      n -= dead;
      if (cnt - dead > 0) sq.units[uid] = cnt - dead; else delete sq.units[uid];
    }
  }
}

// U22: штурм. Путь пролома задаёт и силу атакующего, и остаток бонуса стен.
export function assault(sq, fort, garrison, ctx = {}, rng) {
  const breach = fort.breach;
  const multA = breach === 'gate' ? ASSAULT_GATE : breach === 'wall' ? ASSAULT_WALL : ASSAULT_NONE;
  const keep = breach === 'gate' ? DEF_KEEP_GATE : breach === 'wall' ? DEF_KEEP_WALL : 1;
  const multB = 1 + (fort.defense / DEFENSE_SCALE) * keep;
  const res = resolveBattle(sq, garrison, { ...ctx, multA, multB }, rng);
  res.breach = breach || 'none';
  return res;
}

// ---------------- Ход армии ----------------
// ctx: { world, day, dt (дни), factions, atWar(sideA, sideB), garrisonFor, fortFor }
// Возвращает массив событий {type, text, type: 'good'|'bad'|'warn'|'info'}.
export function tickArmy(state, ctx = {}, rng) {
  if (!rng) throw new Error('tickArmy: нужен rng');
  const world = ctx.world;
  const dt = ctx.dt ?? 1;
  const events = [];

  // 1) Движение по путям.
  for (const sq of state.squads) {
    if (!squadAlive(sq)) { sq.dead = true; continue; }
    sq.morale = Math.min(100, (sq.morale ?? 100) + MORALE_REGEN * dt);
    if (sq.order.type === 'hold' || sq.siege) continue;
    // Цель-отряд движется — перекладываем маршрут, иначе погоня упирается в
    // точку, где враг был вчера.
    if (sq.order.type === 'attack') {
      const tgt = findSquad(state, sq.order.targetId);
      if (!tgt || !squadAlive(tgt)) { sq.order = { type: 'hold' }; sq.path = null; continue; }
      if (Math.round(tgt.x) !== sq.order.tx || Math.round(tgt.y) !== sq.order.ty) {
        sq.order.tx = Math.round(tgt.x); sq.order.ty = Math.round(tgt.y);
        repath(sq, world);
      }
    }
    advance(sq, squadSpeed(sq) * dt, world);
  }

  // 2) Столкновения отрядов.
  const hostile = ctx.atWar || (() => true);
  for (let i = 0; i < state.squads.length; i++) {
    const a = state.squads[i];
    if (!squadAlive(a)) continue;
    for (let j = i + 1; j < state.squads.length; j++) {
      const b = state.squads[j];
      if (!squadAlive(b) || a.side === b.side) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) > ENGAGE_DIST) continue;
      // Бой начинается, если стороны в войне ИЛИ кто-то из них получил приказ
      // атаковать: приказ игрока сам по себе — акт войны.
      const ordered = (a.order.type === 'attack' && a.order.targetId === b.id)
        || (b.order.type === 'attack' && b.order.targetId === a.id);
      if (!ordered && !hostile(a.side, b.side)) continue;
      const res = resolveBattle(a, b, {
        tileA: world ? tileAt(world, a.x, a.y) : TILE.GRASS,
        tileB: world ? tileAt(world, b.x, b.y) : TILE.GRASS,
      }, rng);
      applyBattle(a, b, res);
      state.battles++; state.lastBattle = res;
      const winSq = res.winner === 'a' ? a : b, loseSq = res.winner === 'a' ? b : a;
      events.push({
        type: winSq.side === 'player' ? 'good' : 'bad',
        text: `⚔ Бой у (${Math.round(a.x)},${Math.round(a.y)}): ${winSq.name} разбил ${loseSq.name}` +
          `${res.routed ? ' (противник бежал)' : ''}. ${battleReport(res)}`,
      });
      if (loseSq.dead) {
        loseSq.order = { type: 'hold' }; loseSq.path = null;
      }
    }
  }
  // Уничтоженные отряды снимаются с карты после всех проверок, чтобы индексы
  // не поехали посреди перебора пар.
  state.squads = state.squads.filter(s => !s.dead);

  // 3) Походы (U24).
  for (const sq of state.squads) {
    if (sq.order.type !== 'capture') continue;
    const f = (ctx.factions || []).find(x => x.id === sq.order.factionId);
    if (!f || !f.alive) { sq.order = { type: 'hold' }; sq.siege = null; sq.path = null; continue; }
    const si = (f.settlements || []).findIndex(s => s.x === sq.order.tx && s.y === sq.order.ty);
    if (si < 0) { sq.order = { type: 'hold' }; sq.siege = null; sq.path = null; continue; }
    const s = f.settlements[si];
    if (Math.hypot(sq.x - s.x, sq.y - s.y) > ENGAGE_DIST) continue;

    if (!sq.siege) {
      sq.siege = (ctx.fortFor || fortFromFaction)(f, s);
      events.push({ type: 'warn', text: `🏰 ${sq.name} осадил поселение ${f.def ? f.def.name : f.id} (${s.x},${s.y}).` });
    }
    const sr = resolveSiege(sq, sq.siege, { dt }, rng);
    if (!squadAlive(sq)) { sq.dead = true; events.push({ type: 'bad', text: `☠ ${sq.name} полёг под стенами.` }); continue; }
    if (!sr.breach) continue;

    const garrison = (ctx.garrisonFor || garrisonForFaction)(f, s);
    const res = assault(sq, sq.siege, garrison, {
      tileA: world ? tileAt(world, sq.x, sq.y) : TILE.GRASS,
      tileB: world ? tileAt(world, s.x, s.y) : TILE.GRASS,
    }, rng);
    state.battles++; state.lastBattle = res;
    sq.units = { ...res.a.after.units }; sq.engines = { ...res.a.after.engines };
    sq.morale = res.winner === 'a' ? Math.min(100, sq.morale + 10) : Math.max(0, sq.morale - 35);
    const way = res.breach === 'gate' ? 'через выбитые ворота' : 'по лестницам через стену';
    if (res.winner === 'a') {
      f.settlements.splice(si, 1);
      state.captures++;
      if (f.settlements.length === 0) f.alive = false;
      events.push({
        type: sq.side === 'player' ? 'good' : 'bad', chronicle: true,
        text: `🚩 Поселение ${f.def ? f.def.name : f.id} (${s.x},${s.y}) взято ${way}. ${battleReport(res)}`,
      });
      sq.order = { type: 'hold' }; sq.siege = null; sq.path = null;
      sq.x = s.x; sq.y = s.y;
    } else {
      events.push({ type: sq.side === 'player' ? 'bad' : 'good', text: `🛡 Штурм ${way} отбит. ${battleReport(res)}` });
      // Пролом заделывают: следующий штурм придётся готовить заново.
      sq.siege.breach = null;
      sq.siege.gate = Math.max(sq.siege.gate, sq.siege.gateMax * 0.25);
      sq.siege.wall = Math.max(sq.siege.wall, sq.siege.wallMax * 0.25);
      if (!squadAlive(sq)) sq.dead = true;
    }
  }
  state.squads = state.squads.filter(s => !s.dead);

  return events;
}

// Шаг по маршруту. Идём по узлам aStar, а не по прямой: иначе отряд полез бы
// в воду и в горы, куда путь его специально обводил.
function advance(sq, dist, world) {
  if (!sq.path || sq.pathIdx >= sq.path.length) {
    if (sq.path && sq.pathIdx >= sq.path.length) { sq.path = null; sq.pathIdx = 0; }
    return false;
  }
  let left = dist;
  while (left > 0 && sq.pathIdx < sq.path.length) {
    const n = sq.path[sq.pathIdx];
    const dx = n.x - sq.x, dy = n.y - sq.y;
    const d = Math.hypot(dx, dy);
    if (d <= left + 1e-9) {
      sq.x = n.x; sq.y = n.y; left -= d; sq.pathIdx++;
    } else {
      sq.x += (dx / d) * left; sq.y += (dy / d) * left; left = 0;
    }
  }
  if (sq.pathIdx >= sq.path.length) { sq.path = null; sq.pathIdx = 0; return true; }
  return false;
}

// ---------------- Тексты для интерфейса ----------------
export function squadReport(sq) {
  const parts = [];
  for (const [uid, n] of Object.entries(sq.units || {})) {
    if (n > 0) parts.push(`${UNIT_BY_ID[uid].name} ×${n}`);
  }
  for (const [eid, n] of Object.entries(sq.engines || {})) {
    if (n > 0) parts.push(`${SIEGE_ENGINES[eid].name} ×${n}`);
  }
  const ord = sq.order.type === 'hold' ? 'стоит'
    : sq.order.type === 'move' ? `идёт к (${sq.order.tx},${sq.order.ty})`
    : sq.order.type === 'attack' ? 'атакует отряд'
    : `в походе на (${sq.order.tx},${sq.order.ty})`;
  const siege = sq.siege ? `, осада: ворота ${Math.round(sq.siege.gate)}, стены ${Math.round(sq.siege.wall)}` : '';
  return `${sq.name}: ${parts.join(', ') || 'пусто'} · ${ord} · дух ${Math.round(sq.morale)}${siege}`;
}

export function battleReport(res) {
  const l = (side) => {
    const o = res[side].losses;
    const t = Object.entries(o).map(([k, v]) => `${UNIT_BY_ID[k].name} −${v}`).join(', ');
    return t || 'без потерь';
  };
  const cap = Object.entries(res.captured || {}).map(([k, v]) => `${SIEGE_ENGINES[k].name} ×${v}`).join(', ');
  return `Раундов: ${res.rounds}. Наши: ${l('a')}. Враг: ${l('b')}.` + (cap ? ` Захвачено: ${cap}.` : '');
}

// ---------------- Сериализация ----------------
export function serializeArmy(state) {
  return {
    nextId: state.nextId,
    battles: state.battles,
    captures: state.captures,
    squads: state.squads.map(s => ({
      id: s.id, side: s.side, name: s.name, x: s.x, y: s.y,
      units: { ...s.units }, engines: { ...s.engines },
      powerBonus: s.powerBonus, mult: s.mult, morale: s.morale,
      order: { ...s.order },
      path: s.path ? s.path.map(p => ({ x: p.x, y: p.y })) : null,
      pathIdx: s.pathIdx,
      siege: s.siege ? { ...s.siege } : null,
    })),
  };
}

export function deserializeArmy(data) {
  const st = createArmyState();
  if (!data) return st;
  st.nextId = data.nextId || 1;
  st.battles = data.battles || 0;
  st.captures = data.captures || 0;
  st.squads = (data.squads || []).map(s => ({
    id: s.id, side: s.side, name: s.name, x: s.x, y: s.y,
    units: { ...(s.units || {}) }, engines: { ...(s.engines || {}) },
    powerBonus: s.powerBonus || 0, mult: s.mult || 1, morale: s.morale ?? 100,
    order: s.order ? { ...s.order } : { type: 'hold' },
    path: s.path ? s.path.map(p => ({ x: p.x, y: p.y })) : null,
    pathIdx: s.pathIdx || 0,
    siege: s.siege ? { ...s.siege } : null,
    dead: false,
  }));
  return st;
}
