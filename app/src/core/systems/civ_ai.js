// core/systems/civ_ai.js — жизнь соседних цивилизаций (U29).
// Фракция перестаёт быть числом «мощь P»: у неё своя казна, свои постройки из
// BUILDINGS, своё движение по дереву TECHS, свои колонии и свои решения о войне.
//
// ЧТО ЗДЕСЬ ЧЬЁ. Дипломатический реестр (войны, союзы, перемирия, casus belli)
// принадлежит diplomacy_ext.js — модуль в него ПИШЕТ через его же функции
// (openWar, formAlliance, consumeCasusBelli) и никогда не заводит второй список
// войн: два списка разошлись бы на первом же сейве. Поля самой фракции
// (P, armyPts, wallPts, goldPts, knowPts, techCount, era, settlements) — поля
// ядра, модуль их обновляет, потому что именно он теперь их и зарабатывает.
// Собственное состояние модуля — казна, построенное, изученное, стройплощадки
// и таймеры — живёт в state и целиком сериализуется.
//
// ═══════════════ INTEGRATION ═══════════════
// В simulation.js (файл НЕ редактировался — вставку делает интегратор):
//
// 1) К импортам вверху файла:
//      import { createCivAi, tickCivAi, civReport, serializeCivAi, deserializeCivAi }
//        from './systems/civ_ai.js';
//
// 2) В конструкторе Simulation, сразу ПОСЛЕ this.spawnFactions() (строка 96)
//    и ПОСЛЕ this.diplo = createDiplomacy() из diplomacy_ext:
//      this.civAi = createCivAi(this.factions);
//
// 3) В tickFactions() (строка 1075) ЗАМЕНИТЬ теневую экономику — тело цикла
//    строк 1076–1109 (рост P, доходы, технологии, экспансия) — на один вызов.
//    Оставить в tickFactions всё, что ниже комментария «дипломатический дрейф»
//    (строка 1111 и далее): отношения с игроком по-прежнему ведёт ядро.
//
//      const civOut = tickCivAi(this.civAi, {
//        day: this.day, rng: this.rng, world: this.world,
//        factions: this.factions, diplo: this.diplo,
//        relations: this.relations, difficulty: this.difficulty,
//        playerWars: this.wars.map(w => w.fid),
//        player: { armyPower: this.armyPower(), era: this.eraIndex,
//                  settlements: [{ x: this.world.startX, y: this.world.startY }] },
//      });
//      for (const t of civOut.logs) this.addLog(t);
//      for (const w of civOut.warOnPlayer) {
//        const f = this.faction(w.fid);
//        if (f) this.declareWarOnPlayer(f);   // ядро само решает про перемирия
//      }
//
//    Вызывать ДО tickDiplomacy: тот читает свежие armyPts и settlements.
//
// 4) В serialize() (строка ~1612) в объект сейва добавить:
//      civAi: serializeCivAi(this.civAi),
//    В deserialize() (строка ~1645), после восстановления sim.factions:
//      sim.civAi = deserializeCivAi(data.civAi, sim.factions);
//
// 5) Для панели соседей: civReport(this.civAi, this.factions) отдаёт готовые
//    строки (население, постройки, технологии, поселения, войны).

import { BUILDINGS, TECHS, TECH_ERA_IDX, UNITS, ERAS, FACTIONS } from '../data.js';
import { WALKABLE } from '../data.js';
import { tileAt, isWater } from '../world.js';
import {
  openWar, isAtWar, inTruce, warEnemies, hasCasusBelli, consumeCasusBelli,
  addCasusBelli, isAllied, formAlliance, evaluateAllianceOffer, aiRel,
  ALLY_UTILITY,
} from './diplomacy_ext.js';

// ---------- Настройки экономики ----------
export const RES_IDS = ['food', 'wood', 'stone', 'steel', 'gold', 'knowledge'];
export const WORK_SHARE = 0.55;     // доля населения, стоящая на рабочих местах
export const EAT_PER_POP = 0.35;    // еда на жителя в день
export const BASE_HOUSING = 10;     // землянки поселения, которые никто не строит
export const GROWTH_RATE = 0.0055;  // базовый прирост при сытости и жилье
export const STARVE_RATE = 0.012;   // убыль при голоде
export const STOCK_PER_TOWN = 400;  // потолок склада на поселение (кроме золота)
export const TECH_COST_MULT = 0.5;  // насколько дерево дешевле фракции, чем игроку

// Стройка
export const BUILD_CHECK = 4;       // раз во сколько дней выбирается новая стройка
export const BUILD_RATE = 6;        // единиц стоимости в день у одной бригады
export const BUILD_MIN_DAYS = 3;
export const BUILD_MAX_DAYS = 40;
export const MAX_COPIES = 6;        // копий одного здания на фракцию
export const TERRAIN_R = 6;         // радиус вокруг поселения, где ищется нужный тайл

// Армия
export const HIRE_GOLD = 1.2;       // золота за очко войска
export const HIRE_FOOD = 1.0;
export const UPKEEP_GOLD = 0.02;    // содержание очка войска в день
export const UPKEEP_FOOD = 0.03;
export const ARMY_RESERVE = 25;     // золото, которое на армию не тратят: это казна страны
export const DESERT_RATE = 0.02;    // дезертирство при нечем платить
export const HIRE_PER_DAY = 0.5;    // темп найма без казарм

// Колонизация
export const FOUND_CHECK = 20;
export const FOUND_POP = 26;        // население на одно поселение, чтобы отделять новое
export const FOUND_COST = { food: 120, wood: 80 };
export const FOUND_MIN_DIST = 8;    // не впритык к чужим и своим
export const FOUND_MAX_DIST = 20;   // и не на другом конце света
export const COLONISTS = 6;

// Решения (разнесены по дням, чтобы не сходились в один тик)
export const DECISION_PERIOD = 10;
export const CIV_WAR_PHASE = 3;
export const CIV_ALLY_PHASE = 7;
export const WAR_CHEST = 40;        // золота, без которого войну не начинают
export const MOBILIZE_GOLD = 25;    // мобилизация опустошает казну — воевать подряд нельзя
export const WAR_UTILITY = 0.35;
export const PLAYER_WAR_UTILITY = 0.5;

const BUILDING_IDS = Object.keys(BUILDINGS);
const TECH_BY_ID = Object.fromEntries(TECHS.map((t, i) => [t.id, { ...t, idx: i }]));
// Что открывает каждая технология — считается из тех же таблиц, а не
// переписывается руками: добавят здание в BUILDINGS — ИИ узнает о нём сам.
const TECH_UNLOCKS = (() => {
  const map = {};
  for (const t of TECHS) map[t.id] = { army: 0, gold: 0, know: 0, food: 0, units: 0 };
  for (const b of Object.values(BUILDINGS)) {
    const m = b.req && map[b.req];
    if (!m) continue;
    if (b.armyMult || b.defense) m.army++;
    if (b.out && b.out.gold) m.gold++;
    if (b.out && b.out.knowledge) m.know++;
    if (b.out && b.out.food) m.food++;
  }
  for (const u of UNITS) if (map[u.req]) map[u.req].units++;
  return map;
})();

// Здания, которые ИИ не строит никогда: это сюжетные объекты игрока.
const FORBIDDEN = new Set(['spire', 'spaceport', 'campfire']);

function emptyRes() { return { food: 0, wood: 0, stone: 0, steel: 0, gold: 0, knowledge: 0 }; }
function traits(f) { return (f.def && f.def.traits) || (FACTIONS.find(x => x.id === f.id) || {}).traits; }
function bonus(f) { return (f.def && f.def.bonus) || {}; }
function penalty(f) { return (f.def && f.def.penalty) || {}; }
function costWeight(cost) {
  let s = 0;
  for (const k of RES_IDS) s += (cost[k] || 0) * (k === 'steel' || k === 'gold' ? 1.5 : 1);
  return s;
}

// ---------- Состояние ----------
export function createCivAi(factions = []) {
  const state = { v: 1, civ: {}, lastDay: -1 };
  for (const f of factions) addCiv(state, f);
  return state;
}

export function addCiv(state, f) {
  if (state.civ[f.id]) return state.civ[f.id];
  const tr = traits(f) || { aggression: 5, expansion: 5, trade: 5, science: 5, faith: 5, defense: 5 };
  const c = {
    id: f.id,
    res: { food: 60, wood: 40, stone: 20, steel: 0, gold: 30, knowledge: 0 },
    techs: ['fire'],
    buildings: {},          // bid -> количество достроенных
    site: null,             // текущая стройплощадка { id, daysLeft, cost }
    troops: 8,              // живые бойцы; armyPts фракции считается из них
    research: null,         // id изучаемой технологии
    founded: 0,
    warsDeclared: 0,        // войны, начатые по решению ЭТОГО модуля
    alliesMade: 0,
    built: 0,
    starveDays: 0,
    terrain: null,          // кэш «какие тайлы доступны» — пересчёт при новом городе
    terrainAt: -1,
    tr,
  };
  state.civ[f.id] = c;
  return c;
}

export function civOf(state, fid) { return state.civ[fid] || null; }
export function knownTechs(state, fid) { return (state.civ[fid] || { techs: [] }).techs.slice(); }
export function buildingsOf(state, fid) { return { ...(state.civ[fid] || { buildings: {} }).buildings }; }
export function buildingCount(state, fid) {
  const c = state.civ[fid];
  if (!c) return 0;
  let n = 0;
  for (const k of Object.keys(c.buildings)) n += c.buildings[k];
  return n;
}

// ---------- Главный тик ----------
// ctx: { day, rng, world, factions, diplo, relations, playerWars, difficulty,
//        player: { armyPower, era, settlements } }
export function tickCivAi(state, ctx) {
  const out = { logs: [], built: [], researched: [], founded: [], warsOpened: [], warOnPlayer: [], alliances: [] };
  const day = ctx.day || 0;
  if (day === state.lastDay) return out; // ровно один тик на игровой день
  state.lastDay = day;
  const rng = ctx.rng;
  const live = (ctx.factions || []).filter(f => f.alive);

  for (const f of live) {
    const c = state.civ[f.id] || addCiv(state, f);
    economy(c, f, ctx, out);
    research(c, f, ctx, out);
    construction(c, f, ctx, rng, out);
    military(c, f, ctx);
    if (day % FOUND_CHECK === f.id.length % FOUND_CHECK) colonize(c, f, ctx, rng, out);
    sync(c, f);
  }

  if (rng && ctx.diplo) {
    if (day % DECISION_PERIOD === CIV_WAR_PHASE) warDecisions(state, ctx, out, day, live);
    if (day % DECISION_PERIOD === CIV_ALLY_PHASE) allyDecisions(state, ctx, out, day, live);
  }
  return out;
}

// ---------- Экономика: производство, еда, население ----------
function economy(c, f, ctx, out) {
  const tr = c.tr, bn = bonus(f), pn = penalty(f);
  const towns = Math.max(1, (f.settlements || []).length);
  let workers = Math.floor(Math.max(0, f.P) * WORK_SHARE);
  const gain = emptyRes();
  let housing = BASE_HOUSING * towns;
  let industry = 1, goldMult = 1, armyMult = 1, defense = 0;

  for (const bid of BUILDING_IDS) {
    const n = c.buildings[bid];
    if (!n) continue;
    const def = BUILDINGS[bid];
    housing += (def.housing || 0) * n;
    if (def.industry) industry *= Math.pow(def.industry, n);
    if (def.goldMult) goldMult = Math.max(goldMult, def.goldMult); // не стакается, как в описании
    if (def.armyMult) armyMult *= Math.pow(def.armyMult, n);
    defense += (def.defense || 0) * n;
    if (!def.out) continue;
    for (let i = 0; i < n; i++) {
      const need = def.workers || 0;
      if (need > workers) break;           // людей не хватило — здание простаивает
      workers -= need;
      // Фабрика без сырья не работает: цепочка честная, а не декоративная.
      if (def.consume) {
        let ok = true;
        for (const k of Object.keys(def.consume)) if (c.res[k] < def.consume[k]) ok = false;
        if (!ok) { workers += need; break; }
        for (const k of Object.keys(def.consume)) c.res[k] -= def.consume[k];
      }
      for (const k of Object.keys(def.out)) gain[k] += def.out[k];
    }
  }

  // Базовый промысел: без построек фракция всё равно собирает и рубит, иначе
  // ей нечем оплатить самую первую лесопилку и она стоит вечно.
  gain.food += f.P * 0.16;
  gain.wood += f.P * 0.03 * (bn.wood || 1);
  gain.stone += f.P * 0.018;
  gain.gold += f.P * 0.03 * (0.5 + tr.trade / 10);
  gain.knowledge += (0.15 * towns + f.P * 0.006) * (tr.science / 5);

  gain.knowledge *= (bn.science || 1) * (pn.science || 1);
  gain.gold *= goldMult * (bn.gold || 1);
  gain.steel *= industry * (bn.steel || 1);
  gain.stone *= industry;

  for (const k of RES_IDS) c.res[k] += gain[k];

  // Еда и население
  const eat = f.P * EAT_PER_POP;
  c.res.food -= eat;
  if (c.res.food < 0) {
    c.res.food = 0;
    c.starveDays++;
    f.P = Math.max(2, f.P * (1 - STARVE_RATE));
  } else {
    c.starveDays = 0;
    const room = Math.max(0, housing - f.P);
    if (room > 0.5) {
      const r = GROWTH_RATE * (1 + tr.expansion / 20) * (pn.growth || 1);
      f.P += r * f.P * Math.min(1, room / Math.max(1, housing));
    }
  }
  const cap = STOCK_PER_TOWN * towns;
  for (const k of RES_IDS) {
    if (k === 'gold' || k === 'knowledge') continue; // казна и наука не портятся
    if (c.res[k] > cap) c.res[k] = cap;
  }
  c._housing = housing;
  c._defense = defense;
  c._armyMult = armyMult;
  if (c.starveDays > 40 && f.P <= 3) { f.alive = false; out.logs.push(`${f.def.name} угас от голода.`); }
}

// ---------- Наука ----------
function research(c, f, ctx, out) {
  if (!c.research) c.research = chooseTech(c, f);
  if (!c.research) return;
  const t = TECH_BY_ID[c.research];
  const need = Math.max(10, t.cost * TECH_COST_MULT);
  if (c.res.knowledge < need) return;
  c.res.knowledge -= need;
  c.techs.push(t.id);
  c.research = null;
  out.researched.push({ fid: f.id, tech: t.id });
  const era = TECH_ERA_IDX[t.id] ?? 0;
  if (t.era && era > (f.era || 0)) {
    out.logs.push(`${f.def.name} вступает в эпоху: ${ERAS[era].ru}.`);
  }
}

// Что изучать: сначала дешёвое доступное, но черты сдвигают выбор — воинственные
// тянутся к оружию, торговцы к золоту, учёные к знанию. Полезность считается из
// самих таблиц (что технология открывает), поэтому вторая таблица не нужна.
function chooseTech(c, f) {
  const tr = c.tr;
  const known = new Set(c.techs);
  let best = null, bestScore = -Infinity;
  for (const t of TECHS) {
    if (known.has(t.id)) continue;
    if (t.prereq.some(p => !known.has(p))) continue;
    const u = TECH_UNLOCKS[t.id] || { army: 0, gold: 0, know: 0, food: 0, units: 0 };
    let score = 120 / Math.max(20, t.cost);
    score += (u.army + u.units) * 0.06 * (tr.aggression / 5);
    score += u.gold * 0.06 * (tr.trade / 5);
    score += u.know * 0.06 * (tr.science / 5);
    score += u.food * 0.05 * (tr.expansion / 5);
    if (t.era) score += 0.12 * (tr.science / 5); // эпохальные ветки тянут вперёд
    if (score > bestScore) { bestScore = score; best = t.id; }
  }
  return best;
}

// ---------- Стройка ----------
function construction(c, f, ctx, rng, out) {
  if (c.site) {
    c.site.daysLeft--;
    if (c.site.daysLeft > 0) return;
    const bid = c.site.id;
    c.buildings[bid] = (c.buildings[bid] || 0) + 1;
    c.built++;
    c.site = null;
    out.built.push({ fid: f.id, id: bid });
    return;
  }
  const day = ctx.day || 0;
  if (day % BUILD_CHECK !== 0) return;
  const pick = chooseBuilding(c, f, ctx, rng);
  if (!pick) return;
  const def = BUILDINGS[pick];
  for (const k of Object.keys(def.cost || {})) c.res[k] -= def.cost[k];
  const days = Math.round(costWeight(def.cost || {}) / BUILD_RATE / (bonus(f).build || 1));
  c.site = { id: pick, daysLeft: Math.max(BUILD_MIN_DAYS, Math.min(BUILD_MAX_DAYS, days)) };
}

// Полезность здания: чего фракции не хватает прямо сейчас плюс её характер.
function chooseBuilding(c, f, ctx, rng) {
  const tr = c.tr, known = new Set(c.techs);
  const towns = Math.max(1, (f.settlements || []).length);
  const terr = terrainOf(c, f, ctx.world);
  const foodTight = c.res.food < f.P * EAT_PER_POP * 6 || c.starveDays > 0;
  const houseTight = f.P > (c._housing || BASE_HOUSING) - 4;
  let best = null, bestScore = 0.2;
  for (const bid of BUILDING_IDS) {
    if (FORBIDDEN.has(bid)) continue;
    const def = BUILDINGS[bid];
    if (def.req && !known.has(def.req)) continue;
    const have = c.buildings[bid] || 0;
    if (have >= (def.unique ? 1 : MAX_COPIES)) continue;
    if (def.needTile && !terr.tiles.has(def.needTile)) continue;
    if (def.coast && !terr.coast) continue;
    let afford = true;
    for (const k of Object.keys(def.cost || {})) if (c.res[k] < def.cost[k]) afford = false;
    if (!afford) continue;

    let s = 0;
    if (def.out) {
      if (def.out.food) s += def.out.food * (foodTight ? 0.9 : 0.25);
      if (def.out.wood) s += def.out.wood * (c.res.wood < 60 ? 0.7 : 0.2);
      if (def.out.stone) s += def.out.stone * (c.res.stone < 60 ? 0.7 : 0.2);
      if (def.out.steel) s += def.out.steel * 0.5;
      if (def.out.gold) s += def.out.gold * 0.25 * (tr.trade / 5);
      if (def.out.knowledge) s += def.out.knowledge * 0.35 * (tr.science / 5);
    }
    if (def.housing) s += (houseTight ? 0.09 : 0.015) * def.housing;
    if (def.armyMult) s += (def.armyMult - 1) * 6 * (tr.aggression / 5);
    if (def.special === 'train') s += 0.5 * (tr.aggression / 5);
    if (def.defense) s += def.defense * 0.06 * (tr.defense / 5);
    if (def.happy) s += def.happy * 0.035 * (tr.faith / 5);
    if (def.industry) s += (def.industry - 1) * 3;
    if (def.cap) s += 0.2;
    // Копии дешевеют по полезности: шесть казарм подряд никому не нужны.
    s /= 1 + have * 0.8;
    // Слишком дорогая стройка при пустой казне — это стоящая стройплощадка.
    s -= costWeight(def.cost || {}) / (900 * towns);
    if (rng) s += rng.next() * 0.12;
    if (s > bestScore) { bestScore = s; best = bid; }
  }
  return best;
}

// Какие тайлы доступны фракции вокруг её поселений. Кэш живёт до основания
// нового города: перебирать окрестности каждый день — впустую жечь тик.
function terrainOf(c, f, world) {
  const towns = (f.settlements || []).length;
  if (c.terrain && c.terrainAt === towns) return c.terrain;
  const tiles = new Set();
  let coast = false;
  if (world) {
    for (const s of f.settlements || []) {
      for (let dy = -TERRAIN_R; dy <= TERRAIN_R; dy++) {
        for (let dx = -TERRAIN_R; dx <= TERRAIN_R; dx++) {
          const x = s.x + dx, y = s.y + dy;
          if (x < 0 || y < 0 || x >= world.w || y >= world.h) continue;
          tiles.add(tileAt(world, x, y));
          if (!coast && isWater(world, x, y) && Math.abs(dx) + Math.abs(dy) <= 3) coast = true;
        }
      }
    }
  }
  c.terrain = { tiles, coast };
  c.terrainAt = towns;
  return c.terrain;
}

// ---------- Армия ----------
function military(c, f, ctx) {
  const tr = c.tr, bn = bonus(f), pn = penalty(f);
  const atWar = ctx.diplo ? warEnemies(ctx.diplo, f.id).length > 0 : 0;
  const barracks = c.buildings.barracks || 0;
  const want = f.P * (0.10 + tr.aggression * 0.03) * (1 + (atWar ? 0.6 : 0));
  // Содержание: неоплаченная армия разбегается — это и держит мирные фракции
  // от бесконечного накопления войск.
  const upkeepG = c.troops * UPKEEP_GOLD, upkeepF = c.troops * UPKEEP_FOOD;
  if (c.res.gold >= upkeepG && c.res.food >= upkeepF) {
    c.res.gold -= upkeepG; c.res.food -= upkeepF;
  } else {
    c.res.gold = Math.max(0, c.res.gold - upkeepG);
    c.res.food = Math.max(0, c.res.food - upkeepF);
    c.troops *= (1 - DESERT_RATE);
  }
  // Набор идёт только с излишков: страна не проедает семенной фонд и не
  // опустошает казну ради лишнего копейщика — иначе воинственные фракции
  // навсегда остаются нищими и не могут позволить себе ни одной войны.
  const foodFree = c.res.food - f.P * EAT_PER_POP * 8;
  const goldFree = c.res.gold - ARMY_RESERVE;
  if (c.troops < want && foodFree > 0 && goldFree > 0) {
    const rate = HIRE_PER_DAY * (1 + barracks);
    const byGold = goldFree / HIRE_GOLD, byFood = foodFree / HIRE_FOOD;
    const hire = Math.max(0, Math.min(want - c.troops, rate, byGold, byFood));
    c.troops += hire;
    c.res.gold -= hire * HIRE_GOLD;
    c.res.food -= hire * HIRE_FOOD;
  }
  c.troops = Math.max(0, c.troops);
  // Сила очка войска растёт от техники: ровно те же UNITS, что и у игрока.
  const known = new Set(c.techs);
  let power = 2;
  for (const u of UNITS) if (known.has(u.req)) power = u.power;
  c._unitPower = power;
  f.armyPts = c.troops * (power / 2) * (c._armyMult || 1) * (bn.army || 1) * (pn.army || 1);
  f.wallPts = (c._defense || 0) * (1 + tr.defense / 10);
}

// ---------- Колонизация ----------
function colonize(c, f, ctx, rng, out) {
  if (!ctx.world || !rng) return;
  const towns = (f.settlements || []).length;
  // Терпимость к тесноте — это и есть черта expansion: степняк отделяет колонию
  // при вдвое меньшем населении, чем лесное согласие.
  const need = FOUND_POP * towns * (12 / (6 + c.tr.expansion));
  if (f.P < need) return;
  const k2 = (bonus(f).outpost || 1) * (penalty(f).outpost || 1);
  for (const k of Object.keys(FOUND_COST)) if (c.res[k] < FOUND_COST[k] * k2) return;
  const spot = findSpot(f, ctx, rng);
  if (!spot) return;
  for (const k of Object.keys(FOUND_COST)) c.res[k] -= FOUND_COST[k] * k2;
  f.settlements.push({ x: spot.x, y: spot.y, capital: false });
  f.P = Math.max(2, f.P - COLONISTS);
  c.founded++;
  c.terrainAt = -1; // новые окрестности — новые доступные тайлы
  out.founded.push({ fid: f.id, x: spot.x, y: spot.y });
  out.logs.push(`${f.def.name} основал поселение (${spot.x}, ${spot.y}).`);
}

// Место под город: проходимая суша, не впритык к чужим и своим, и с сушей
// вокруг — колония на одиноком мысу не прокормится.
function findSpot(f, ctx, rng) {
  const world = ctx.world;
  const all = [];
  for (const o of ctx.factions || []) for (const s of o.settlements || []) all.push(s);
  for (const s of (ctx.player && ctx.player.settlements) || []) all.push(s);
  for (let attempt = 0; attempt < 40; attempt++) {
    const from = rng.pick(f.settlements);
    if (!from) return null;
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(FOUND_MIN_DIST, FOUND_MAX_DIST);
    const x = Math.round(from.x + Math.cos(a) * r), y = Math.round(from.y + Math.sin(a) * r);
    if (x < 3 || y < 3 || x >= world.w - 3 || y >= world.h - 3) continue;
    if (!WALKABLE.has(tileAt(world, x, y))) continue;
    if (all.some(s => Math.hypot(s.x - x, s.y - y) < FOUND_MIN_DIST)) continue;
    let land = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (WALKABLE.has(tileAt(world, x + dx, y + dy))) land++;
    }
    if (land < 14) continue;
    return { x, y };
  }
  return null;
}

// ---------- Войны ----------
// Решение принимается по видимому: черты, отношения, расстояние между
// поселениями, оценка армий и собственная казна. Реестр войн — чужой
// (diplomacy_ext), модуль лишь открывает в нём войну своей рукой.
function warDecisions(state, ctx, out, day, live) {
  const rng = ctx.rng, D = ctx.diplo;
  const noise = ctx.difficulty === 'easy' ? 0.5 : ctx.difficulty === 'hard' ? 0.1 : 0.25;
  for (const a of live) {
    const c = state.civ[a.id];
    if (!c) continue;
    const tr = c.tr;
    const fronts = warEnemies(D, a.id).length;
    if (fronts >= 2) continue;                       // на третий фронт не лезут
    if (c.res.gold < WAR_CHEST) continue;            // война начинается с казны
    if (c.starveDays > 0) continue;                  // голодная страна не воюет
    const mine = Math.max(1, a.armyPts || 1);
    let best = null, bestU = WAR_UTILITY;
    for (const b of live) {
      if (b.id === a.id) continue;
      if (isAtWar(D, a.id, b.id) || isAllied(D, a.id, b.id) || inTruce(D, a.id, b.id, day)) continue;
      const dist = nearestDist(a, b);
      if (dist > 34) continue;                       // за море войну не объявляют
      const theirs = Math.max(1, (b.armyPts || 1) * (1 + rng.range(-noise, noise)));
      const R = aiRel(D, a.id, b.id);
      const cb = hasCasusBelli(D, a.id, b.id, day);
      // Экспансионист у чужой межи наживает притязание сам — это законный повод.
      if (tr.expansion >= 7 && dist < 20) addCasusBelli(D, a.id, b.id, 'claim', day);
      let u = 0.45 * (tr.aggression / 10) + 0.5 * Math.min(1.2, mine / theirs - 1);
      u += 0.2 * (tr.expansion / 10) * (dist < 18 ? 1 : 0.3);
      u -= R / 140;
      u += cb ? 0.25 : 0;
      u -= 0.25 * fronts;
      u += Math.min(0.15, c.res.gold / 2000);
      if (u > bestU) { bestU = u; best = b; }
    }
    // Игрок — такая же цель: слабого соседа с сокровищами не щадят.
    const P = ctx.player;
    if (P && !(ctx.playerWars || []).includes(a.id) && !isAtWar(D, a.id, 'player') && !inTruce(D, a.id, 'player', day)) {
      const theirs = Math.max(1, (P.armyPower || 0) * (1 + rng.range(-noise, noise)) + 1);
      const R = (ctx.relations && ctx.relations[a.id]) || 0;
      let u = 0.45 * (tr.aggression / 10) + 0.5 * Math.min(1.2, mine / theirs - 1) - R / 120 - 0.25 * fronts;
      if (u > Math.max(bestU, PLAYER_WAR_UTILITY) && rng.chance(Math.min(0.35, u * 0.6))) {
        c.res.gold -= MOBILIZE_GOLD;
        c.warsDeclared++;
        out.warOnPlayer.push({ fid: a.id, why: 'решение ИИ цивилизации' });
        out.logs.push(`${a.def.name} видит в вас добычу и готовит войну.`);
        continue;
      }
    }
    if (!best || !rng.chance(Math.min(0.35, bestU * 0.6))) continue;
    if (hasCasusBelli(D, a.id, best.id, day)) consumeCasusBelli(D, a.id, best.id, day);
    c.res.gold -= MOBILIZE_GOLD; // сбор войска стоит казны — войны идут не подряд
    openWar(D, a.id, best.id, day, 'экспансия');
    c.warsDeclared++;
    out.warsOpened.push({ a: a.id, b: best.id });
    out.logs.push(`${a.def.name} объявляет войну ${best.def.name}.`);
  }
}

// ---------- Союзы ----------
// Модуль не дублирует пакты diplomacy_ext: он закрывает другой случай — когда
// фракции нужен щит по экономическим причинам (война или отставание в армии).
function allyDecisions(state, ctx, out, day, live) {
  const rng = ctx.rng, D = ctx.diplo;
  for (const a of live) {
    const c = state.civ[a.id];
    if (!c) continue;
    const foes = warEnemies(D, a.id);
    const strongest = live.reduce((m, x) => (x.id !== a.id && (x.armyPts || 0) > (m ? m.armyPts : 0) ? x : m), null);
    const threatened = foes.length > 0 || (strongest && (a.armyPts || 0) < (strongest.armyPts || 0) * 0.6);
    if (!threatened) continue;
    let best = null, bestU = ALLY_UTILITY;
    for (const b of live) {
      if (b.id === a.id || isAllied(D, a.id, b.id) || isAtWar(D, a.id, b.id)) continue;
      if (foes.includes(b.id)) continue;
      const ua = evaluateAllianceOffer(D, a, b.id, ctx);
      const ub = evaluateAllianceOffer(D, b, a.id, ctx);
      const u = Math.min(ua, ub);
      if (u > bestU) { bestU = u; best = b; }
    }
    if (!best || !rng.chance(0.6)) continue;
    const r = formAlliance(D, a.id, best.id, day);
    if (!r.ok) continue;
    c.alliesMade++;
    out.alliances.push({ a: a.id, b: best.id });
    out.logs.push(`${a.def.name} и ${best.def.name} заключили оборонительный союз.`);
  }
}

function nearestDist(a, b) {
  let best = Infinity;
  for (const s of a.settlements || []) for (const t of b.settlements || []) {
    const d = Math.hypot(s.x - t.x, s.y - t.y);
    if (d < best) best = d;
  }
  return best;
}

// Поля ядра, которые теперь зарабатывает модуль. Один источник правды: ядро их
// только читает (панель угроз, рейды, diplomacy_ext), а пишет сюда модуль.
function sync(c, f) {
  // Знание фракции может прийти со стороны: diplomacy_ext за обмен технологиями
  // прибавляет ей techCount. Тогда счётчик ядра опережает наш список, и модуль
  // честно доучивает разницу, а не затирает подарок обратно нулём.
  while (f.techCount > c.techs.length) {
    const id = chooseTech(c, f);
    if (!id) break;
    c.techs.push(id);
    if (c.research === id) c.research = null;
  }
  f.techCount = c.techs.length;
  f.era = c.techs.reduce((m, id) => Math.max(m, TECH_ERA_IDX[id] ?? 0), 0);
  f.knowPts = c.res.knowledge;
  f.goldPts = c.res.gold;
  f.P = Math.max(0, f.P);
}

// ---------- Отчёт ----------
// Одна строка на фракцию — и для панели соседей, и для доказательства в тесте.
export function civReport(state, factions) {
  return (factions || []).map(f => {
    const c = state.civ[f.id] || { res: emptyRes(), techs: [], buildings: {}, troops: 0, founded: 0, warsDeclared: 0, alliesMade: 0, built: 0, tr: traits(f) };
    return {
      id: f.id,
      name: (f.def && f.def.name) || f.id,
      alive: !!f.alive,
      pop: Math.round(f.P || 0),
      towns: (f.settlements || []).length,
      buildings: buildingCount(state, f.id),
      techs: c.techs.length,
      era: f.era || 0,
      army: Math.round(f.armyPts || 0),
      troops: Math.round(c.troops),
      gold: Math.round(c.res.gold),
      wars: c.warsDeclared,
      allies: c.alliesMade,
      founded: c.founded,
      traits: c.tr,
    };
  });
}

// ---------- Сериализация ----------
export function serializeCivAi(state) {
  const civ = {};
  for (const [id, c] of Object.entries(state.civ)) {
    civ[id] = {
      res: { ...c.res }, techs: c.techs.slice(), buildings: { ...c.buildings },
      site: c.site ? { ...c.site } : null, troops: c.troops, research: c.research,
      founded: c.founded, warsDeclared: c.warsDeclared, alliesMade: c.alliesMade,
      built: c.built, starveDays: c.starveDays,
    };
  }
  return { v: 1, civ, lastDay: state.lastDay };
}

export function deserializeCivAi(data, factions = []) {
  const state = createCivAi(factions);
  if (!data) return state;
  state.lastDay = data.lastDay ?? -1;
  for (const [id, d] of Object.entries(data.civ || {})) {
    const f = factions.find(x => x.id === id) || { id, def: FACTIONS.find(x => x.id === id) };
    const c = state.civ[id] || addCiv(state, f);
    // Ключи ресурсов берём из таблицы, а не из сейва: новый ресурс в RES_IDS
    // загрузится нулём, а не превратит расчёт в NaN.
    for (const k of RES_IDS) c.res[k] = (d.res && d.res[k]) || 0;
    c.techs = (d.techs || ['fire']).slice();
    c.buildings = { ...(d.buildings || {}) };
    c.site = d.site ? { ...d.site } : null;
    c.troops = d.troops || 0;
    c.research = d.research || null;
    c.founded = d.founded || 0;
    c.warsDeclared = d.warsDeclared || 0;
    c.alliesMade = d.alliesMade || 0;
    c.built = d.built || 0;
    c.starveDays = d.starveDays || 0;
    c.terrain = null; c.terrainAt = -1; // кэш рельефа не сохраняем — он дешёвый
  }
  return state;
}
