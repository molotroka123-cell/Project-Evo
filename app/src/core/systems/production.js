// core/systems/production.js — цепочки производства (U11) и торговые пути (U17).
// Чистый модуль: без DOM, без обращения к Simulation, весь ввод — аргументами.
//
// ═══════════════ ПОЧЕМУ ТАК СПРОЕКТИРОВАНО ═══════════════
//
// U11. «Шахта даёт сталь» переписывать нельзя: на этом стоит весь текущий баланс
// и 18 тестов ядра. Поэтому цепочки сделаны НАДСТРОЙКОЙ, а не заменой:
//   • базовая добыча зданий (камень у шахты, еда у фермы) как считалась ядром в
//     produceAt(), так и считается — модуль её вообще не трогает;
//   • добывающая стадия цепочки НАЧИСЛЯЕТ НОВЫЙ промежуточный ресурс (руду,
//     зерно) сверх базового выхода, на свой внутренний склад state.stock;
//   • перерабатывающая стадия превращает промежуточное сырьё в следующее звено
//     или в конечный ресурс ядра (⚙️ сталь, 🍞 еда).
// Отсюда два важных следствия. Первое: тупик невозможен — нет плавильни, значит
// руда просто копится до потолка склада, а шахта продолжает давать камень как
// раньше. Второе: ни одно здание не производит один и тот же ресурс дважды —
// в исполнители стадий выбраны только те постройки, у которых в BUILDINGS НЕТ
// этого ресурса в out (кузница даёт камень — плавит руду в сталь; мельница и
// литейная в ядре вообще без out). Двойного счёта в экономике нет.
//
// U17. Маршрут — это конкретный путь aStar от вашего поселения до города
// фракции, а не абстрактный таймер. Доход за рейс растёт с длиной (дальняя
// торговля выгоднее), время рейса — тоже, поэтому выигрыш на день даёт КЛАСС
// ДОРОГИ: тропа → просёлок (колесо) → мощёный тракт (строительство) →
// железная дорога (вокзал). Война с фракцией и враждебная территория на пути
// рвут маршрут: караван встаёт, доход прекращается.
//
// ═══════════════ INTEGRATION (я НЕ редактировал чужие файлы) ═══════════════
//
// 1) import {
//      createProduction, tickProduction, chainStatus, stockOf,
//      addRoute, removeRoute, tickRoutes, planRoute, maxRoutes, routeInfo,
//      routePoints, caravanPos, serializeProduction, deserializeProduction,
//      INTERMEDIATES, CHAINS, EXTRA_BUILDINGS,
//    } from './systems/production.js';
//
// 2) Конструктор Simulation, после стартового поселения:
//      this.production = createProduction();
//
// 3) onNewDay(), после блока «караваны» (раз в игровой день):
//      const pr = tickProduction(this.production, {
//        buildings: this.buildings, seasonIdx: this.seasonIdx, days: 1,
//        res: this.res, resCap: this.resCap,
//        mult: {
//          gather: this.globalMult('gather') * WEATHER[this.weather].gather,
//          farm: WEATHER[this.weather].farm * (this.techs.has('feudalism') ? 1.2 : 1),
//          industry: this.globalMult('industry'),
//        },
//      });
//      // result.res — ДЕЛЬТА ресурсов ядра, может быть отрицательной (топливо).
//      for (const [r, v] of Object.entries(pr.res)) {
//        this.res[r] = Math.max(0, Math.min(this.resCap[r] ?? 99999, this.res[r] + v));
//      }
//
// 4) onNewDay(), там же — торговые пути:
//      const tr = tickRoutes(this.production, {
//        world: this.world, days: 1, rng: this.rng, day: this.day,
//        techs: this.techs, buildings: this.buildings,
//        factions: this.factions, relations: this.relations, wars: this.wars,
//        goldMult: this.globalMult('gold'),
//        caravanMult: (this.hasBuilding('shipyard') ? 1.5 : 1) * (this.hasBuilding('train_station') ? 2 : 1),
//        // необязательно: враждебная территория из systems/borders.js
//        // hostileAt: (x, y, fid) => { const o = ownerAt(this.borders, x, y);
//        //   return o !== OWNER_NONE && o !== OWNER_PLAYER && ownerSide(o) !== fid; },
//      });
//      this.res.gold = Math.min(this.resCap.gold, this.res.gold + tr.gold);
//      for (const e of tr.events) this.addLog(e.text, e.type === 'robbed' ? 'bad' : 'info');
//      // Ограбленный караван — законный повод испортить отношения:
//      // for (const e of tr.events) if (e.type === 'robbed') this.adjustRel(e.faction, DIPLO_FACTORS.caravanRaid.dR, 'caravanRaid');
//
// 5) HUD (app/src/ui/hud.js): кнопка «Проложить путь» на панели фракции →
//      const r = addRoute(this.sim.production, ctx17, { faction: f.id,
//        from: campfire, to: f.settlements[0] });
//      if (!r.ok) toast(r.reason);           // причина всегда по-русски
//    Состояние цепочек для панели: chainStatus(this.sim.production, ctxU11) —
//    отдаёт по каждой цепочке выход в день и id узкого места (bottleneck).
//
// 6) Рендер (app/src/render/renderer.js): для каждого маршрута
//      const pts = routePoints(route);       // [{x,y}...] в клетках — линия пути
//      const car = caravanPos(route);        // {x,y} — точка каравана
//    Порванный путь (route.broken) рисовать пунктиром/красным.
//
// 7) Сейв: в serialize() добавить `production: serializeProduction(this.production)`,
//    в deserialize() — `sim.production = data.production
//      ? deserializeProduction(data.production) : createProduction();`
//    Старые сейвы без поля грузятся: склад пуст, маршрутов нет.
//
// 8) НЕОБЯЗАТЕЛЬНО (цепочки работают и без этого): два новых здания —
//    Плавильня и Пекарня. В data.js одной строкой:
//      Object.assign(BUILDINGS, EXTRA_BUILDINGS);
//    Без них стадии выполняют запасные исполнители (кузница, амбар) с меньшей
//    отдачей — тупика не возникает ни в одном варианте.
// ═══════════════════════════════════════════════════════════

import { RES, BUILDINGS, TILE_COST, FACTIONS } from '../data.js';
import { aStar } from '../world.js';

const EPS = 1e-9;
const RES_IDS = new Set(RES.map(r => r.id));

// ---------- Промежуточные ресурсы (U11) ----------
// Минимальный набор: три штуки. Конечные продукты цепочек — уже существующие
// ⚙️ сталь и 🍞 еда, поэтому новая экономика сразу срастается со старой:
// рынком, потолками складов, содержанием армии.
// cap — потолок внутреннего склада, spoil — доля порчи в день (сырьё не должно
// копиться вечно: иначе игрок «накапливает зерно» вместо постройки мельницы).
export const INTERMEDIATES = [
  { id: 'ore',   icon: '🪨', ru: 'Руда',  cap: 300, spoil: 0 },
  { id: 'grain', icon: '🌾', ru: 'Зерно', cap: 300, spoil: 0.01 },
  { id: 'flour', icon: '🥣', ru: 'Мука',  cap: 200, spoil: 0.03 },
];
const INTER_BY_ID = Object.fromEntries(INTERMEDIATES.map(i => [i.id, i]));

// ---------- Необязательные новые здания ----------
// Форма повторяет мельницу из BUILDINGS: без workers и без out, то есть ядро их
// не будет ни заселять, ни заставлять что-то производить в produceAt().
// Вся их работа — стадии цепочек, и она пассивная.
export const EXTRA_BUILDINGS = {
  smelter: { name: 'Плавильня', cost: { wood: 30, stone: 25 }, req: 'bronze', chain: true,
    desc: 'Плавит руду в ⚙️ сталь (нужны 🪵 дрова).' },
  bakery:  { name: 'Пекарня',   cost: { wood: 25, stone: 15 }, req: 'pottery', chain: true,
    desc: 'Печёт хлеб из муки: +🍞.' },
};

// ---------- ТАБЛИЦА ЦЕПОЧЕК (U11) ----------
// Цепочка — линейная последовательность стадий. Стадия описывает: что тратит
// (in), что даёт (out), кто это делает (by: здание + его коэффициент отдачи) и
// какой глобальный множитель ядра к ней применяется (mult).
// Исполнителей у стадии несколько намеренно: профильное здание работает в полную
// силу, «подручное» — вполсилы. Так игрок никогда не упирается в отсутствие
// одной конкретной постройки.
// НОВЫЙ ПРОДУКТ добавляется одной строкой — объектом в этот массив (или вызовом
// registerChain), править код при этом не нужно.
export const CHAINS = [
  {
    id: 'steel', ru: 'Сталь', final: 'steel',
    stages: [
      { id: 'ore_dig', ru: 'Добыча руды', mult: 'gather',
        out: { ore: 1.0 },
        by: [{ b: 'mine', rate: 1 }, { b: 'quarry', rate: 0.3 }] },
      // Дрова как топливо: плавка должна чего-то стоить, иначе бесплатная сталь
      // обесценивает фабрику из ядра.
      { id: 'smelt', ru: 'Плавка', mult: 'industry',
        in: { ore: 1.6, wood: 0.5 }, out: { steel: 0.8 },
        by: [{ b: 'smelter', rate: 1 }, { b: 'foundry', rate: 1.2 }, { b: 'smithy', rate: 0.5 }] },
    ],
  },
  {
    id: 'bread', ru: 'Хлеб', final: 'food',
    stages: [
      // noWinter повторяет поведение фермы в ядре: зимой поля не родят.
      { id: 'grain_grow', ru: 'Зерно с полей', mult: 'farm', noWinter: true,
        out: { grain: 1.2 },
        by: [{ b: 'farm', rate: 1 }] },
      { id: 'grind', ru: 'Помол',
        in: { grain: 1.5 }, out: { flour: 1.0 },
        by: [{ b: 'mill', rate: 1 }, { b: 'workshop', rate: 0.6 }] },
      { id: 'bake', ru: 'Выпечка',
        in: { flour: 1.0 }, out: { food: 2.4 },
        by: [{ b: 'bakery', rate: 1 }, { b: 'granary', rate: 0.4 }] },
    ],
  },
];

// Проверка и регистрация новой цепочки. Возвращает саму цепочку; при ошибке в
// данных бросает — молчаливо проглоченная опечатка в таблице страшнее падения.
export function registerChain(chain) {
  validateChain(chain);
  const i = CHAINS.findIndex(c => c.id === chain.id);
  if (i >= 0) CHAINS[i] = chain; else CHAINS.push(chain);
  return chain;
}

export function chainById(id) { return CHAINS.find(c => c.id === id) || null; }

function validateChain(c) {
  if (!c || !c.id || !Array.isArray(c.stages) || !c.stages.length) throw new Error('Цепочка без стадий');
  const known = (r) => INTER_BY_ID[r] || RES_IDS.has(r);
  for (const st of c.stages) {
    if (!st.id || !st.out) throw new Error(`Стадия без id/out в цепочке ${c.id}`);
    if (!Array.isArray(st.by) || !st.by.length) throw new Error(`Стадия ${st.id}: нет исполнителей`);
    for (const p of st.by) {
      if (!BUILDINGS[p.b] && !EXTRA_BUILDINGS[p.b]) throw new Error(`Стадия ${st.id}: нет здания ${p.b}`);
    }
    for (const r of Object.keys(st.out)) if (!known(r)) throw new Error(`Стадия ${st.id}: неизвестный продукт ${r}`);
    for (const r of Object.keys(st.in || {})) if (!known(r)) throw new Error(`Стадия ${st.id}: неизвестное сырьё ${r}`);
  }
}
for (const c of CHAINS) validateChain(c);

// ---------- Торговые пути: настройки (U17) ----------
// Классы дорог. Каждый следующий требует технологии (и вокзал для рельсов):
// скорость решает, сколько рейсов успеет караван, mult — наценку за рейс.
export const ROAD_CLASSES = [
  { id: 'trail', ru: 'Тропа',              req: null,          speed: 2.0, mult: 1.0 },
  { id: 'cart',  ru: 'Просёлок',           req: 'wheel',       speed: 3.0, mult: 1.15 },
  { id: 'paved', ru: 'Мощёный тракт',      req: 'construction', speed: 4.2, mult: 1.35 },
  { id: 'rail',  ru: 'Железная дорога',    req: 'railroads',   speed: 8.0, mult: 2.0, needBuilding: 'train_station' },
];

export const TRADE = {
  goldPerTile: 0.35,      // база дохода за клетку пути
  lengthPremium: 150,     // надбавка за дальность: ×(1 + длина/150)
  cargoLoad: 20,          // сколько единиц товара берёт караван
  cargoPrice: { ore: 0.25, grain: 0.15, flour: 0.5 }, // 🪙 за единицу груза
  robRisk: 0.5,           // множитель риска ограбления при плохих отношениях
  minLength: 6,           // ближе — это не торговый путь, а прогулка
};

// ---------- Состояние ----------

export function createProduction() {
  const stock = {};
  for (const it of INTERMEDIATES) stock[it.id] = 0;
  return {
    v: 1,
    stock,                 // склад промежуточного сырья
    produced: {},          // накопительная статистика выпуска (для HUD/хроники)
    routes: [],
    nextRouteId: 1,
    tradeGold: 0,          // всего заработано путями
    trips: 0,              // завершённых рейсов
  };
}

export function stockOf(state, res) { return state.stock[res] ?? 0; }

// ---------- U11: суточный расчёт ----------

// ctx: { buildings, days=1, seasonIdx, res, resCap, mult:{gather,farm,industry} }
// Возвращает { res, gained, used, spoiled, runs }.
// res — ДЕЛЬТА ресурсов ядра (может быть отрицательной: топливо для плавки).
export function tickProduction(state, ctx = {}) {
  const days = ctx.days ?? 1;
  const counts = countBuildings(ctx.buildings || []);
  const mult = ctx.mult || {};
  const res = ctx.res || {};
  const resCap = ctx.resCap || {};
  const result = { res: {}, gained: {}, used: {}, spoiled: {}, runs: {} };
  if (days <= 0) return result;

  for (const chain of CHAINS) {
    // Стадии идут по порядку, поэтому добытое утром сырьё успевает пройти всю
    // цепочку за тот же день — как на конвейере, без искусственной задержки.
    for (const st of chain.stages) {
      if (st.noWinter && ctx.seasonIdx === 3) continue;
      const cap = stageCapacity(st, counts);
      if (cap <= 0) continue;
      let runs = cap * days * (st.mult ? (mult[st.mult] ?? 1) : 1);
      if (runs <= EPS) continue;
      // Ограничение сырьём.
      for (const [r, amt] of Object.entries(st.in || {})) {
        runs = Math.min(runs, availableOf(state, r, res, result) / amt);
      }
      // Ограничение свободным местом. Как и фабрика в ядре, при полном складе
      // продукта стадия НЕ жжёт сырьё впустую.
      for (const [r, amt] of Object.entries(st.out)) {
        runs = Math.min(runs, roomFor(state, r, res, resCap, result) / amt);
      }
      if (runs <= EPS) continue;
      for (const [r, amt] of Object.entries(st.in || {})) {
        const take = runs * amt;
        addTo(state, result, r, -take);
        result.used[r] = (result.used[r] || 0) + take;
      }
      for (const [r, amt] of Object.entries(st.out)) {
        const add = runs * amt;
        addTo(state, result, r, add);
        result.gained[r] = (result.gained[r] || 0) + add;
        state.produced[r] = (state.produced[r] || 0) + add;
      }
      result.runs[st.id] = (result.runs[st.id] || 0) + runs;
    }
  }

  // Порча сырья на складе. Считается степенью, чтобы полшага дня и целый день
  // давали одинаковый итог — детерминизм не должен зависеть от нарезки тиков.
  for (const it of INTERMEDIATES) {
    if (!it.spoil) continue;
    const before = state.stock[it.id] || 0;
    if (before <= 0) continue;
    const after = before * Math.pow(1 - it.spoil, days);
    state.stock[it.id] = after;
    result.spoiled[it.id] = (result.spoiled[it.id] || 0) + (before - after);
  }
  return result;
}

// Сколько «прогонов» в день тянут построенные исполнители стадии.
export function stageCapacity(stage, counts) {
  let cap = 0;
  for (const p of stage.by) cap += (counts[p.b] || 0) * (p.rate ?? 1);
  return cap;
}

// Состояние цепочек для HUD: выход в день и узкое место.
// ctx: { buildings, seasonIdx, mult }
export function chainStatus(state, ctx = {}) {
  const counts = countBuildings(ctx.buildings || []);
  const mult = ctx.mult || {};
  const out = [];
  for (const chain of CHAINS) {
    const factors = finalFactors(chain);
    const stages = chain.stages.map((st, i) => {
      const winter = !!(st.noWinter && ctx.seasonIdx === 3);
      const cap = winter ? 0 : stageCapacity(st, counts) * (st.mult ? (mult[st.mult] ?? 1) : 1);
      let has = 0;
      for (const p of st.by) has += counts[p.b] || 0;
      return {
        id: st.id, ru: st.ru, buildings: has, capacity: cap,
        throughput: cap * factors[i], winter,
        note: has ? null : `нет здания: ${st.by.map(p => nameOf(p.b)).join(' / ')}`,
      };
    });
    let best = null;
    for (const s of stages) if (!best || s.throughput < best.throughput) best = s;
    out.push({
      id: chain.id, ru: chain.ru, final: chain.final,
      stages, output: best ? best.throughput : 0,
      bottleneck: best ? best.id : null,
      stock: Object.fromEntries(INTERMEDIATES.map(i => [i.id, state.stock[i.id] || 0])),
    });
  }
  return out;
}

// Пересчёт «прогон стадии → единиц конечного продукта»: нужен, чтобы сравнивать
// пропускную способность разнородных стадий в одних единицах и честно называть
// узкое место.
function finalFactors(chain) {
  const n = chain.stages.length;
  const f = new Array(n).fill(0);
  const last = chain.stages[n - 1];
  f[n - 1] = last.out[chain.final] ?? Object.values(last.out)[0] ?? 0;
  for (let i = n - 2; i >= 0; i--) {
    const nxt = chain.stages[i + 1];
    const link = Object.keys(chain.stages[i].out).find(r => nxt.in && nxt.in[r] != null);
    f[i] = link ? (chain.stages[i].out[link] / nxt.in[link]) * f[i + 1] : f[i + 1];
  }
  return f;
}

function nameOf(id) { return (BUILDINGS[id] || EXTRA_BUILDINGS[id] || { name: id }).name; }

export function countBuildings(buildings) {
  const c = {};
  for (const b of buildings) {
    if (!b || !b.done || b.destroyed) continue;
    c[b.id] = (c[b.id] || 0) + 1;
  }
  return c;
}

// Промежуточное — на складе модуля, конечное — в ресурсах ядра (через дельту).
function availableOf(state, r, res, result) {
  if (r in state.stock) return Math.max(0, state.stock[r]);
  return Math.max(0, (res[r] ?? 0) + (result.res[r] || 0));
}

function roomFor(state, r, res, resCap, result) {
  const it = INTER_BY_ID[r];
  if (it) return Math.max(0, it.cap - (state.stock[r] || 0));
  const cap = resCap[r] ?? Infinity;
  return Math.max(0, cap - ((res[r] ?? 0) + (result.res[r] || 0)));
}

function addTo(state, result, r, delta) {
  if (r in state.stock) state.stock[r] = Math.max(0, state.stock[r] + delta);
  else result.res[r] = (result.res[r] || 0) + delta;
}

// ---------- U17: торговые пути ----------

// Лучший доступный класс дороги. Рельсы требуют не только технологии, но и
// вокзала: без станции поезду негде грузиться.
export function routeClass(ctx = {}) {
  const techs = ctx.techs;
  const counts = countBuildings(ctx.buildings || []);
  let best = ROAD_CLASSES[0];
  for (const c of ROAD_CLASSES) {
    if (c.req && !(techs && techs.has(c.req))) continue;
    if (c.needBuilding && !counts[c.needBuilding]) continue;
    best = c;
  }
  return best;
}

// Сколько маршрутов игрок может держать одновременно. Рынок — обязательная
// точка отправления, дальше лимит растёт от торговой инфраструктуры.
export function maxRoutes(ctx = {}) {
  const c = countBuildings(ctx.buildings || []);
  if (!c.market) return 0;
  let n = c.market;
  if (c.shipyard) n += 1;
  if (c.train_station) n += 1;
  if (c.airport) n += 2;
  return n;
}

// Проложить маршрут «в уме»: считает путь и метрики, ничего не меняя.
// opts: { faction, from:{x,y}, to:{x,y} }
export function planRoute(state, ctx, opts) {
  const { world } = ctx || {};
  if (!world) return { ok: false, reason: 'Нет карты мира' };
  if (!ctx.techs || !ctx.techs.has('trade')) return { ok: false, reason: 'Нужна технология: Торговля' };
  const from = opts && opts.from, to = opts && opts.to;
  if (!from || !to) return { ok: false, reason: 'Не указаны концы маршрута' };
  const path = aStar(world, from.x, from.y, to.x, to.y);
  if (!path || path.length < 2) return { ok: false, reason: 'Пути до этого города нет — мешает вода или горы' };
  const m = measurePath(world, path);
  if (m.length < TRADE.minLength) return { ok: false, reason: 'Город слишком близко — это не торговый путь' };
  return {
    ok: true,
    route: {
      id: 0, faction: opts.faction || null,
      from: { x: path[0].x, y: path[0].y },
      to: { x: path[path.length - 1].x, y: path[path.length - 1].y },
      path: flatten(path), length: m.length, avgCost: m.avgCost, tiles: path.length,
      pos: 0, dir: 1, trips: 0, gold: 0, broken: null, cargo: null,
    },
  };
}

export function addRoute(state, ctx, opts) {
  // Дубликат проверяем раньше лимита: игроку важнее услышать «путь уже есть»,
  // чем «маршрутов слишком много», когда он повторно жмёт по той же фракции.
  if (opts.faction && state.routes.some(r => r.faction === opts.faction)) {
    return { ok: false, reason: 'С этой фракцией маршрут уже проложен' };
  }
  const limit = maxRoutes(ctx);
  if (!limit) return { ok: false, reason: 'Нужен Рынок: караванам нужна точка отправления' };
  if (state.routes.length >= limit) return { ok: false, reason: `Больше ${limit} маршрутов не потянуть — нужен рынок, верфь или вокзал` };
  const plan = planRoute(state, ctx, opts);
  if (!plan.ok) return plan;
  const route = plan.route;
  route.id = state.nextRouteId++;
  loadCargo(state, route);
  state.routes.push(route);
  return { ok: true, route };
}

export function removeRoute(state, id) {
  const i = state.routes.findIndex(r => r.id === id);
  if (i < 0) return false;
  // Груз в пути возвращать некому — он уже уехал; на складе он не числится,
  // поэтому просто снимаем маршрут.
  state.routes.splice(i, 1);
  return true;
}

// Суточный ход караванов. ctx: { world, days=1, rng, techs, buildings, factions,
// relations, wars, goldMult, caravanMult, hostileAt(x,y,fid) }
export function tickRoutes(state, ctx = {}) {
  const days = ctx.days ?? 1;
  const cls = routeClass(ctx);
  const out = { gold: 0, events: [] };
  for (const r of state.routes) {
    const block = routeBlock(r, ctx);
    if (block !== r.broken) {
      r.broken = block;
      out.events.push(block
        ? { type: 'broken', routeId: r.id, faction: r.faction, reason: block, text: brokenText(r, block) }
        : { type: 'restored', routeId: r.id, faction: r.faction, text: `Путь до ${factionName(ctx, r.faction)} снова открыт.` });
    }
    r.cls = cls.id;
    if (block) continue;
    // Тяжёлый рельеф замедляет: avgCost — средняя цена клетки пути из TILE_COST.
    const speed = (cls.speed / Math.max(1, r.avgCost)) * (ctx.speedMult ?? 1);
    let move = speed * days;
    let guard = 0;
    while (move > EPS && guard++ < 64) {
      if (r.dir > 0) {
        const need = r.length - r.pos;
        if (move < need) { r.pos += move; break; }
        move -= need; r.pos = r.length; r.dir = -1;
      } else {
        const need = r.pos;
        if (move < need) { r.pos -= move; break; }
        move -= need; r.pos = 0; r.dir = 1;
        completeTrip(state, r, ctx, cls, out);
      }
    }
  }
  return out;
}

// Доход за один полный рейс (туда-обратно), без груза.
export function tripGold(route, ctx = {}, cls = null) {
  const c = cls || routeClass(ctx);
  const base = TRADE.goldPerTile * route.length * (1 + route.length / TRADE.lengthPremium);
  const f = factionOf(ctx, route.faction);
  const trade = (f && f.def && f.def.traits) ? f.def.traits.trade : 5;
  const rel = Math.max(-100, Math.min(100, (ctx.relations && ctx.relations[route.faction]) ?? 0));
  const relMult = 0.8 + rel / 250;
  return base * c.mult * (0.7 + trade * 0.06) * relMult * (ctx.goldMult ?? 1) * (ctx.caravanMult ?? 1);
}

export function routeInfo(route, ctx = {}) {
  const c = routeClass(ctx);
  const speed = c.speed / Math.max(1, route.avgCost);
  const tripDays = (route.length * 2) / speed;
  const gold = tripGold(route, ctx, c);
  return {
    id: route.id, faction: route.faction, name: factionName(ctx, route.faction),
    length: route.length, road: c.ru, speed,
    tripDays, goldPerTrip: gold, goldPerDay: gold / Math.max(1, tripDays),
    cargo: route.cargo, trips: route.trips, earned: route.gold,
    broken: route.broken, status: route.broken ? brokenText(route, route.broken) : (route.dir > 0 ? 'В пути к городу' : 'Возвращается домой'),
  };
}

// Точки пути в клеточных координатах — для рендера линии.
export function routePoints(route) {
  const pts = [];
  for (let i = 0; i + 1 < route.path.length; i += 2) pts.push({ x: route.path[i], y: route.path[i + 1] });
  return pts;
}

// Текущая позиция каравана вдоль пути (интерполяция между клетками).
export function caravanPos(route) {
  const cum = cumulative(route);
  const pts = routePoints(route);
  if (!pts.length) return { x: 0, y: 0 };
  const d = Math.max(0, Math.min(route.length, route.pos));
  let i = 1;
  while (i < cum.length && cum[i] < d) i++;
  if (i >= cum.length) return pts[pts.length - 1];
  const seg = cum[i] - cum[i - 1];
  const t = seg > EPS ? (d - cum[i - 1]) / seg : 0;
  return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
}

function completeTrip(state, route, ctx, cls, out) {
  let gold = tripGold(route, ctx, cls);
  const cargo = route.cargo;
  if (cargo) gold += cargo.amount * (TRADE.cargoPrice[cargo.res] ?? 0);
  // Риск разбоя тем выше, чем хуже отношения. Бросок один на рейс — так число
  // обращений к rng не зависит от нарезки тиков, и сид остаётся воспроизводимым.
  const rel = (ctx.relations && ctx.relations[route.faction]) ?? 0;
  const risk = Math.max(0, Math.min(0.5, -rel / 200)) * TRADE.robRisk;
  const robbed = risk > 0 && ctx.rng && ctx.rng.chance(risk);
  if (robbed) {
    out.events.push({ type: 'robbed', routeId: route.id, faction: route.faction, lost: gold,
      text: `Караван из ${factionName(ctx, route.faction)} ограблен по дороге: потеряно ${gold.toFixed(1)}🪙.` });
    gold = 0;
  } else {
    out.events.push({ type: 'trip', routeId: route.id, faction: route.faction, gold,
      text: `Караван вернулся от ${factionName(ctx, route.faction)}: +${gold.toFixed(1)}🪙${cargo ? ` (продано ${Math.round(cargo.amount)} ${INTER_BY_ID[cargo.res].ru.toLowerCase()})` : ''}.` });
  }
  route.trips++; route.gold += gold;
  state.trips++; state.tradeGold += gold;
  out.gold += gold;
  route.cargo = null;
  loadCargo(state, route);
}

// Связка U11 и U17: караван грузит излишки цепочек и продаёт их дороже, чем
// они стоили бы дома. Берём самый ценный доступный товар.
function loadCargo(state, route) {
  let best = null;
  for (const it of INTERMEDIATES) {
    const price = TRADE.cargoPrice[it.id] ?? 0;
    if (price <= 0) continue;
    const amount = Math.min(state.stock[it.id] || 0, TRADE.cargoLoad);
    if (amount <= EPS) continue;
    const value = amount * price;
    if (!best || value > best.value) best = { res: it.id, amount, value };
  }
  if (!best) { route.cargo = null; return; }
  state.stock[best.res] -= best.amount;
  route.cargo = { res: best.res, amount: best.amount };
}

// Что рвёт путь: война с этой фракцией или чужая враждебная территория на пути.
function routeBlock(route, ctx) {
  if (atWar(ctx, route.faction)) return 'war';
  if (typeof ctx.hostileAt === 'function') {
    for (let i = 0; i + 1 < route.path.length; i += 2) {
      if (ctx.hostileAt(route.path[i], route.path[i + 1], route.faction)) return 'hostile';
    }
  }
  return null;
}

function brokenText(route, reason) {
  if (reason === 'war') return 'Война: караваны не ходят.';
  if (reason === 'hostile') return 'Путь перерезан враждебной территорией.';
  return 'Путь недоступен.';
}

function atWar(ctx, fid) {
  const wars = ctx.wars;
  if (!wars || !fid) return false;
  if (typeof wars.has === 'function') return wars.has(fid);
  return wars.some(w => (typeof w === 'string' ? w : w && w.fid) === fid);
}

function factionOf(ctx, fid) {
  const list = ctx.factions;
  if (list) { const f = list.find(x => x.id === fid); if (f) return f; }
  const def = FACTIONS.find(f => f.id === fid);
  return def ? { id: fid, def } : null;
}

function factionName(ctx, fid) {
  const f = factionOf(ctx, fid);
  return f && f.def ? f.def.name : 'соседей';
}

// Длина пути в клетках (диагональ 1.41) и средняя цена клетки: она и задаёт
// «класс местности» — по лугам караван бежит, по холмам и лесу плетётся.
function measurePath(world, path) {
  let length = 0, cost = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x, dy = path[i].y - path[i - 1].y;
    const step = (dx && dy) ? 1.41 : 1;
    length += step;
    const t = world.tiles[path[i].y * world.w + path[i].x];
    cost += step * (TILE_COST[t] || 1);
  }
  return { length, avgCost: length > 0 ? cost / length : 1 };
}

function flatten(path) {
  const out = [];
  for (const p of path) out.push(p.x, p.y);
  return out;
}

// Кумулятивные длины по точкам пути. Кэш держим на самом маршруте и НЕ кладём в
// сейв: величина производная, а сейв и так не мал.
function cumulative(route) {
  if (route._cum && route._cum.length * 2 === route.path.length) return route._cum;
  const cum = [0];
  for (let i = 2; i + 1 < route.path.length; i += 2) {
    const dx = route.path[i] - route.path[i - 2], dy = route.path[i + 1] - route.path[i - 1];
    cum.push(cum[cum.length - 1] + ((dx && dy) ? 1.41 : 1));
  }
  route._cum = cum;
  return cum;
}

// ---------- Сохранение ----------

export function serializeProduction(state) {
  return {
    v: 1,
    stock: { ...state.stock },
    produced: { ...state.produced },
    tradeGold: state.tradeGold, trips: state.trips, nextRouteId: state.nextRouteId,
    routes: state.routes.map(r => ({
      id: r.id, faction: r.faction, from: r.from, to: r.to,
      path: Array.from(r.path), length: r.length, avgCost: r.avgCost, tiles: r.tiles,
      pos: r.pos, dir: r.dir, trips: r.trips, gold: r.gold, broken: r.broken, cargo: r.cargo,
    })),
  };
}

export function deserializeProduction(data) {
  const state = createProduction();
  if (!data) return state;
  // Ключи склада берём из таблицы, а не из сейва: если в новой версии появится
  // ещё один промежуточный ресурс, старый сейв загрузится с нулём по нему.
  for (const it of INTERMEDIATES) state.stock[it.id] = (data.stock && data.stock[it.id]) || 0;
  state.produced = { ...(data.produced || {}) };
  state.tradeGold = data.tradeGold || 0;
  state.trips = data.trips || 0;
  state.routes = (data.routes || []).map(r => ({
    id: r.id, faction: r.faction, from: r.from, to: r.to,
    path: Array.from(r.path || []), length: r.length || 0, avgCost: r.avgCost || 1, tiles: r.tiles || 0,
    pos: r.pos || 0, dir: r.dir || 1, trips: r.trips || 0, gold: r.gold || 0,
    broken: r.broken || null, cargo: r.cargo || null,
  }));
  state.nextRouteId = data.nextRouteId || (state.routes.reduce((m, r) => Math.max(m, r.id), 0) + 1);
  return state;
}
