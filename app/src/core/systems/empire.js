// core/systems/empire.js — империя из нескольких городов (U12).
// Чистый модуль: без DOM, без обращения к Simulation напрямую. Весь ввод — через
// ctx, вся случайность — через переданный rng. Ядро подключается обёрткой
// createEmpireSystem() (см. блок ИНТЕГРАЦИЯ в конце файла).
//
// МОДЕЛЬ. Игрок закладывает колонии вдали от столицы. Каждая — живой город со
// своим населением, складом, счастьем и специализацией. Ограничитель бесконечной
// экспансии — расстояние: чем дальше город, тем больший кусок его дани прилипает
// к рукам наместников (коррупция) и тем дороже содержание администрации.
//
// ПРАВИЛО ОБЩЕГО И МЕСТНОГО (жёсткое, исключений нет):
//   ОБЩЕЕ  — золото и знания. Невесомы: город отправляет их в казну столицы
//            каждый день мгновенно, но за вычетом коррупции.
//   МЕСТНОЕ — еда и дерево. Лежат на складе города (city.local) и попадают в
//            столицу или соседний город ТОЛЬКО караваном: караван едет реальные
//            дни и может быть ограблен. sendCaravan отклоняет золото и знания.
//
// КОРРУПЦИЯ (главная формула модуля):
//   corr(d) = clamp(CORR_PER_TILE * (d - CORR_FREE_DIST), 0, CORR_MAX) * техМножители
// где d — евклидово расстояние до столицы в клетках. Первые 10 клеток бесплатны:
// туда курьер доезжает за день. Дальше по 1.5% за клетку: на d=30 треть дани
// теряется, на d=60 упираемся в потолок 75% — дальняя колония приносит четверть
// номинала. Управленческие технологии (законы, письменность, колесо, интернет)
// умножением снижают потери. Содержание растёт отдельно и линейно:
//   upkeep(d) = UPKEEP_BASE + UPKEEP_PER_TILE * max(0, d - CORR_FREE_DIST) 🪙/день,
// поэтому у экспансии есть честная точка безубыточности, а не мягкий намёк.

import { TILE, WALKABLE } from '../data.js';
import { tileAt } from '../world.js';

// ---------- Константы (экспортируются: на них опирается тест) ----------
export const MIN_CITY_DIST = 12;      // ближе города душат друг друга
export const FOOD_RADIUS = 3;         // в этом радиусе должно расти пропитание
export const FOUND_COST = { food: 100, wood: 80, gold: 50 };
export const FOUND_COST_GROWTH = 1.5; // каждая следующая колония дороже в полтора раза
export const START_POP = 5;

export const CORR_FREE_DIST = 10;
export const CORR_PER_TILE = 0.015;
export const CORR_MAX = 0.75;
export const CORR_TECH = { laws: 0.85, writing: 0.9, wheel: 0.9, internet: 0.7 };
export const UPKEEP_BASE = 1;
export const UPKEEP_PER_TILE = 0.08;

export const EAT_PER_POP = 0.7;       // как в ядре: жители империи едят одинаково
export const PROD_PER_POP = { food: 1.1, wood: 0.45, gold: 0.15, knowledge: 0.08 };
// Зимой (индекс 3, см. winter.js) поля не родят — города живут запасами и караванами.
export const FOOD_SEASON = [1, 1.15, 1, 0];
export const LOCAL_RES = ['food', 'wood'];
export const POP_BASE_CAP = 20;       // без амбара город не разрастается сверх этого

// Специализация: игрок выбирает сам, всегда «+ к одному, − к другому».
export const SPECS = {
  agrarian: { ru: 'Аграрный', plus: { food: 1.3 }, minus: { gold: 0.85 }, desc: '+30% еда, −15% золото' },
  craft: { ru: 'Ремесленный', plus: { wood: 1.35 }, minus: { food: 0.85 }, desc: '+35% дерево, −15% еда' },
  trade: { ru: 'Торговый', plus: { gold: 1.4 }, minus: { wood: 0.8 }, desc: '+40% золото, −20% дерево' },
  military: { ru: 'Военный', plus: {}, minus: { food: 0.85 }, guard: true, desc: 'вдвое безопаснее караваны и тише бунты, −15% еда' },
  science: { ru: 'Научный', plus: { knowledge: 1.5 }, minus: { food: 0.85 }, desc: '+50% знания, −15% еда' },
};

// Городские постройки — по одной каждого вида. Дерево берётся со склада города
// (оно местное), золото — из общей казны (оно общее): правило работает и здесь.
export const CITY_BUILDINGS = {
  granary: { ru: 'Амбар', cost: { wood: 40, gold: 0 }, mult: { food: 1.2 } },
  sawmill: { ru: 'Лесопилка', cost: { wood: 30, gold: 10 }, mult: { wood: 1.35 } },
  market: { ru: 'Рынок', cost: { wood: 25, gold: 25 }, mult: { gold: 1.4 }, happy: 3 },
  school: { ru: 'Школа', cost: { wood: 30, gold: 30 }, mult: { knowledge: 1.6 } },
  tavern: { ru: 'Трактир', cost: { wood: 20, gold: 15 }, happy: 6 },
  walls: { ru: 'Стены', cost: { wood: 50, gold: 20 }, happy: 2, safe: 0.85 },
};

// Караваны.
export const CARAVAN_SPEED = 4;       // клеток в день
export const CARAVAN_MIN_LOAD = 15;   // мельче обоз не собирают
export const CARAVAN_CAP = 80;
export const KEEP_DAYS = 10;          // город держит себе еды на 10 дней, излишек — в столицу
export const WOOD_KEEP = 30;
export const ROB_BASE = 0.025;        // шанс ограбления за каждый день пути
export const ROB_MAX = 0.5;

// Сепаратизм. Недовольство копится при счастье ниже порога, скорость растёт с
// удалённостью: дальний нищий город бунтует за ~10 дней, ближний — вдвое-втрое
// дольше (столица успевает заметить и помочь).
export const UNREST_HAPPY = 35;
export const UNREST_WARN = 6;
export const UNREST_REVOLT = 10;

// ---------- Генератор русских названий ----------
const NAME_PRE = ['Бело', 'Черно', 'Ново', 'Старо', 'Красно', 'Верхне', 'Нижне',
  'Дальне', 'Злато', 'Камен', 'Волче', 'Яро', 'Тихо', 'Остро', 'Медве', 'Свето'];
const NAME_SUF = ['град', 'горск', 'поль', 'озёрск', 'речье', 'борск', 'славль',
  'ярск', 'водск', 'полье', 'луг', 'мирье'];

export function genCityName(rng, used = new Set()) {
  for (let i = 0; i < 30; i++) {
    const name = rng.pick(NAME_PRE) + rng.pick(NAME_SUF);
    if (!used.has(name)) return name;
  }
  // все сочетания заняты — нумеруем, как реальные Новгороды
  let n = 2;
  const base = rng.pick(NAME_PRE) + rng.pick(NAME_SUF);
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ---------- Состояние ----------
export function createEmpire() {
  return {
    cities: [],
    caravans: [],
    lost: [],        // отложившиеся города — для хроники
    nextId: 1,
    nextCaravanId: 1,
    lastDay: -1,     // защита от двойного тика в один день
  };
}

export function cityById(state, id) { return state.cities.find(c => c.id === id) || null; }

export function distToCapital(city, ctx) {
  const c = readCtx(ctx);
  return Math.hypot(city.x - c.capitalX, city.y - c.capitalY);
}

// ---------- Коррупция и содержание ----------
export function corruption(dist, ctx) {
  const c = readCtx(ctx);
  let corr = clamp(CORR_PER_TILE * (num(dist, 0) - CORR_FREE_DIST), 0, CORR_MAX);
  for (const [id, k] of Object.entries(CORR_TECH)) if (c.hasTech(id)) corr *= k;
  return round3(corr);
}

export function upkeepPerDay(dist) {
  return round2(UPKEEP_BASE + UPKEEP_PER_TILE * Math.max(0, num(dist, 0) - CORR_FREE_DIST));
}

// ---------- Основание ----------
export function foundCost(state) {
  const m = Math.pow(FOUND_COST_GROWTH, state.cities.length);
  const out = {};
  for (const [r, v] of Object.entries(FOUND_COST)) out[r] = Math.ceil(v * m);
  return out;
}

export function canFound(state, ctx, x, y) {
  const c = readCtx(ctx);
  const w = c.world;
  if (!w) return { ok: false, reason: 'Мир не передан' };
  if (x < 1 || y < 1 || x >= w.w - 1 || y >= w.h - 1) return { ok: false, reason: 'Край карты' };
  const t = tileAt(w, x, y);
  if (t === TILE.DEEP || t === TILE.WATER) return { ok: false, reason: 'Здесь вода — город не заложить' };
  if (t === TILE.MOUNTAIN) return { ok: false, reason: 'В горах города не строят' };
  if (!WALKABLE.has(t)) return { ok: false, reason: 'Непригодная земля' };
  // пропитание рядом: луг и лес кормят полями, вода у берега — рыбой
  let food = false;
  for (let dy = -FOOD_RADIUS; dy <= FOOD_RADIUS && !food; dy++) {
    for (let dx = -FOOD_RADIUS; dx <= FOOD_RADIUS && !food; dx++) {
      const tt = tileAt(w, x + dx, y + dy);
      if (tt === TILE.GRASS || tt === TILE.FOREST || tt === TILE.WATER) food = true;
    }
  }
  if (!food) return { ok: false, reason: 'Рядом нет пропитания: нужны трава, лес или берег' };
  const dCap = Math.hypot(x - c.capitalX, y - c.capitalY);
  if (dCap < MIN_CITY_DIST) return { ok: false, reason: `Слишком близко к столице (мин. ${MIN_CITY_DIST} клеток)` };
  for (const city of state.cities) {
    if (Math.hypot(x - city.x, y - city.y) < MIN_CITY_DIST) {
      return { ok: false, reason: `Слишком близко к городу ${city.name}` };
    }
  }
  return { ok: true };
}

// Оплату стоимости делает вызывающая сторона (у чистого модуля нет доступа к казне).
export function foundCity(state, ctx, x, y, rng, specId = null) {
  const chk = canFound(state, ctx, x, y);
  if (!chk.ok) return chk;
  if (specId != null && !SPECS[specId]) return { ok: false, reason: 'Нет такой специализации' };
  const c = readCtx(ctx);
  const used = new Set([...state.cities.map(ct => ct.name), ...state.lost.map(l => l.name)]);
  const city = {
    id: state.nextId++,
    name: genCityName(rng, used),
    x, y,
    pop: START_POP,
    spec: specId,
    buildings: [],
    local: { food: 30, wood: 20 },  // обоз переселенцев: чтобы город пережил первые дни
    happy: 60,
    unrest: 0,
    warned: false,
    foundedDay: c.day,
  };
  state.cities.push(city);
  return { ok: true, city, cost: foundCost({ cities: state.cities.slice(0, -1) }) };
}

export function setSpecialization(state, cityId, specId) {
  const city = cityById(state, cityId);
  if (!city) return { ok: false, reason: 'Город не найден' };
  if (!SPECS[specId]) return { ok: false, reason: 'Нет такой специализации' };
  city.spec = specId;
  return { ok: true, ru: SPECS[specId].ru };
}

// goldAvailable — сколько золота в общей казне; потраченное вернём в goldSpent.
export function buildInCity(state, cityId, buildingId, goldAvailable = Infinity) {
  const city = cityById(state, cityId);
  if (!city) return { ok: false, reason: 'Город не найден' };
  const def = CITY_BUILDINGS[buildingId];
  if (!def) return { ok: false, reason: 'Нет такой постройки' };
  if (city.buildings.includes(buildingId)) return { ok: false, reason: `${def.ru}: уже есть — по одной на город` };
  const wood = def.cost.wood || 0, gold = def.cost.gold || 0;
  if (city.local.wood < wood) return { ok: false, reason: `Не хватает дерева на складе города (нужно ${wood}🪵)` };
  if (goldAvailable < gold) return { ok: false, reason: `Не хватает золота в казне (нужно ${gold}🪙)` };
  city.local.wood -= wood;
  city.buildings.push(buildingId);
  return { ok: true, goldSpent: gold, ru: def.ru };
}

// ---------- Производство ----------
export function prodMult(city, res) {
  let m = 1;
  const spec = SPECS[city.spec];
  if (spec) {
    if (spec.plus[res]) m *= spec.plus[res];
    if (spec.minus[res]) m *= spec.minus[res];
  }
  for (const id of city.buildings) {
    const def = CITY_BUILDINGS[id];
    if (def && def.mult && def.mult[res]) m *= def.mult[res];
  }
  return m;
}

// ---------- Счастье ----------
export function cityHappiness(city, ctx) {
  const c = readCtx(ctx);
  const corr = corruption(distToCapital(city, c), c);
  // Наместники воруют не только дань: коррупция бьёт и по настроению горожан.
  let h = 50 - corr * 40;
  const foodDays = city.local.food / Math.max(0.1, city.pop * EAT_PER_POP);
  if (foodDays > 7) h += 10;
  if (city.local.food <= 0) h -= 25;
  for (const id of city.buildings) h += (CITY_BUILDINGS[id] && CITY_BUILDINGS[id].happy) || 0;
  h -= Math.min(20, city.unrest * 2);
  return clamp(Math.round(h), 0, 100);
}

// ---------- Караваны ----------
export function robChance(days, ctx, fromCity = null, toCity = null) {
  const c = readCtx(ctx);
  let p = ROB_BASE * Math.max(0, num(days, 0));
  if (c.atWar) p *= 2;                                   // война выгоняет разбойников на дороги
  const safety = clamp(c.armyPower / 80, 0, 1);          // сильная армия патрулирует пути
  p *= 1 - 0.6 * safety;
  for (const city of [fromCity, toCity]) {
    if (!city) continue;
    if (city.spec === 'military' && SPECS.military.guard) p *= 0.5;
    if (city.buildings.includes('walls')) p *= CITY_BUILDINGS.walls.safe;
  }
  return Math.min(ROB_MAX, round3(p));
}

// toId === 0 — столица. Возить можно только МЕСТНОЕ (еду и дерево) — см. правило.
export function sendCaravan(state, ctx, fromId, toId, goods) {
  const c = readCtx(ctx);
  const from = cityById(state, fromId);
  if (!from) return { ok: false, reason: 'Город-отправитель не найден' };
  const to = toId === 0 ? null : cityById(state, toId);
  if (toId !== 0 && !to) return { ok: false, reason: 'Город-получатель не найден' };
  const load = {};
  for (const [r, v] of Object.entries(goods || {})) {
    if (!LOCAL_RES.includes(r)) return { ok: false, reason: 'Золото и знания — общие, караван им не нужен' };
    const amt = Math.floor(num(v, 0));
    if (amt <= 0) continue;
    if (from.local[r] < amt) return { ok: false, reason: `Не хватает на складе: ${r}` };
    load[r] = amt;
  }
  if (!Object.keys(load).length) return { ok: false, reason: 'Караван пуст' };
  const tx = to ? to.x : c.capitalX, ty = to ? to.y : c.capitalY;
  const dist = Math.hypot(from.x - tx, from.y - ty);
  const days = Math.max(1, Math.ceil(dist / CARAVAN_SPEED));
  for (const [r, amt] of Object.entries(load)) from.local[r] -= amt;
  const caravan = {
    id: state.nextCaravanId++, from: fromId, to: toId, goods: load,
    days, daysLeft: days, rob: robChance(days, c, from, to), sentDay: c.day,
  };
  state.caravans.push(caravan);
  return { ok: true, caravan };
}

// ---------- Ежедневный тик ----------
export function tickEmpire(state, ctx, rng) {
  const c = readCtx(ctx);
  const R = rng || { chance: () => false, next: () => 0.5 };
  const rep = {
    day: c.day, cityCount: state.cities.length, upkeep: 0,
    shared: { gold: 0, knowledge: 0 },
    toCapital: { food: 0, wood: 0 },
    arrived: [], robbed: [], revolted: [], events: [], cities: [],
  };
  if (state.lastDay === c.day) return rep;
  state.lastDay = c.day;

  // 1. Караваны едут. Отправленные сегодня стоят до утра — иначе однодневный
  // маршрут доставлял бы груз в момент отправки.
  const still = [];
  for (const car of state.caravans) {
    if (car.sentDay === c.day) { still.push(car); continue; }
    car.daysLeft--;
    if (car.daysLeft > 0) { still.push(car); continue; }
    const fromName = (cityById(state, car.from) || { name: 'провинции' }).name;
    if (R.chance(car.rob)) {
      rep.robbed.push({ ...car, goods: { ...car.goods } });
      rep.events.push({ text: `💀 Караван из ${fromName} ограблен в пути: ${goodsText(car.goods)} потеряны.`, type: 'bad' });
      continue;
    }
    if (car.to === 0) {
      for (const [r, amt] of Object.entries(car.goods)) rep.toCapital[r] += amt;
      rep.arrived.push({ ...car, goods: { ...car.goods } });
      rep.events.push({ text: `🐫 Караван из ${fromName} прибыл в столицу: ${goodsText(car.goods)}.`, type: 'good' });
    } else {
      const to = cityById(state, car.to);
      if (!to) {
        rep.events.push({ text: `Караван из ${fromName} не нашёл города назначения — груз пропал.`, type: 'warn' });
        continue;
      }
      for (const [r, amt] of Object.entries(car.goods)) to.local[r] += amt;
      rep.arrived.push({ ...car, goods: { ...car.goods } });
      rep.events.push({ text: `🐫 Караван прибыл в ${to.name}: ${goodsText(car.goods)}.`, type: 'good' });
    }
  }
  state.caravans = still;

  // 2. Города живут.
  const removed = [];
  for (const city of state.cities) {
    const d = distToCapital(city, c);
    const corr = corruption(d, c);
    rep.upkeep += upkeepPerDay(d);

    // производство: несчастный город работает на 70%
    const happyMult = city.happy < 35 ? 0.7 : 1;
    const season = FOOD_SEASON[c.seasonIdx] ?? 1;
    city.local.food += city.pop * PROD_PER_POP.food * prodMult(city, 'food') * happyMult * season;
    city.local.wood += city.pop * PROD_PER_POP.wood * prodMult(city, 'wood') * happyMult;
    rep.shared.gold += city.pop * PROD_PER_POP.gold * prodMult(city, 'gold') * happyMult * (1 - corr);
    rep.shared.knowledge += city.pop * PROD_PER_POP.knowledge * prodMult(city, 'knowledge') * happyMult * (1 - corr);

    // пропитание
    const need = city.pop * EAT_PER_POP;
    let starving = false;
    if (city.local.food >= need) city.local.food -= need;
    else {
      city.local.food = 0;
      starving = true;
      if (city.pop > 1) {
        city.pop--;
        rep.events.push({ text: `☠ Голод в городе ${city.name}: люди умирают, осталось ${city.pop}.`, type: 'bad' });
      }
    }

    city.happy = cityHappiness(city, c);

    // сепаратизм: скорость недовольства растёт и с несчастьем, и с удалённостью
    if (city.happy < UNREST_HAPPY) {
      let grow = ((UNREST_HAPPY - city.happy) / UNREST_HAPPY) * (0.5 + d / 40);
      if (city.spec === 'military') grow *= 0.5; // гарнизон давит смуту в зародыше
      city.unrest = Math.min(UNREST_REVOLT + 2, city.unrest + grow);
    } else {
      city.unrest = Math.max(0, city.unrest - (city.spec === 'military' ? 2 : 1));
    }
    if (city.unrest >= UNREST_WARN && !city.warned) {
      city.warned = true;
      rep.events.push({ text: `⚠ В городе ${city.name} зреет сепаратизм: народ беден, столица далеко.`, type: 'warn' });
    }
    if (city.unrest < UNREST_WARN) city.warned = false;
    if (city.unrest >= UNREST_REVOLT) {
      rep.revolted.push({ id: city.id, name: city.name, pop: city.pop });
      rep.events.push({ text: `🔥 Город ${city.name} восстал и отложился от империи!`, type: 'bad' });
      state.lost.push({ name: city.name, day: c.day, pop: city.pop });
      removed.push(city.id);
      continue;
    }

    // рост
    const foodDays = city.local.food / Math.max(0.1, need);
    const popCap = POP_BASE_CAP + (city.buildings.includes('granary') ? 10 : 0);
    if (!starving && city.happy > 55 && foodDays > 5 && city.pop < popCap && R.chance(0.15)) city.pop++;

    // излишки — караваном в столицу
    const goods = {};
    const surF = city.local.food - need * KEEP_DAYS;
    if (surF >= CARAVAN_MIN_LOAD) goods.food = Math.min(CARAVAN_CAP, Math.floor(surF));
    const surW = city.local.wood - WOOD_KEEP;
    if (surW >= CARAVAN_MIN_LOAD) goods.wood = Math.min(CARAVAN_CAP, Math.floor(surW));
    if (Object.keys(goods).length) {
      const r = sendCaravan(state, c, city.id, 0, goods);
      if (r.ok) rep.events.push({ text: `🐫 ${city.name} отправил караван в столицу (${goodsText(goods)}), в пути ${r.caravan.days} дн.`, type: 'info' });
    }
  }
  if (removed.length) state.cities = state.cities.filter(ct => !removed.includes(ct.id));

  rep.shared.gold = round2(rep.shared.gold);
  rep.shared.knowledge = round2(rep.shared.knowledge);
  rep.upkeep = round2(rep.upkeep);
  for (const city of state.cities) rep.cities.push(citySummary(city, c));
  rep.cityCount = state.cities.length;
  return rep;
}

// Сводка для панели: HUD читает готовые числа, а не считает заново.
export function citySummary(city, ctx) {
  const c = readCtx(ctx);
  const d = distToCapital(city, c);
  return {
    id: city.id, name: city.name, x: city.x, y: city.y,
    pop: city.pop, spec: city.spec, specRu: city.spec ? SPECS[city.spec].ru : 'Без специализации',
    happy: city.happy, unrest: round2(city.unrest),
    dist: round2(d), corr: corruption(d, c), upkeep: upkeepPerDay(d),
    buildings: [...city.buildings],
    local: { food: round2(city.local.food), wood: round2(city.local.wood) },
  };
}

// ---------- Сохранение ----------
export function serializeEmpire(state) {
  const s = state || createEmpire();
  return {
    cities: s.cities.map(ct => ({
      id: ct.id, name: ct.name, x: ct.x, y: ct.y, pop: ct.pop, spec: ct.spec,
      buildings: [...ct.buildings],
      local: { food: round2(ct.local.food), wood: round2(ct.local.wood) },
      happy: ct.happy, unrest: round2(ct.unrest), warned: !!ct.warned, foundedDay: ct.foundedDay,
    })),
    caravans: s.caravans.map(car => ({ ...car, goods: { ...car.goods } })),
    lost: s.lost.map(l => ({ ...l })),
    nextId: s.nextId, nextCaravanId: s.nextCaravanId, lastDay: s.lastDay,
  };
}

export function deserializeEmpire(data) {
  const s = createEmpire();
  if (!data || typeof data !== 'object') return s;
  s.cities = (data.cities || []).map(ct => ({
    id: ct.id, name: ct.name || 'Безымянск', x: num(ct.x, 0), y: num(ct.y, 0),
    pop: Math.max(1, Math.round(num(ct.pop, 1))), spec: SPECS[ct.spec] ? ct.spec : null,
    buildings: Array.isArray(ct.buildings) ? ct.buildings.filter(id => CITY_BUILDINGS[id]) : [],
    local: { food: Math.max(0, num(ct.local && ct.local.food, 0)), wood: Math.max(0, num(ct.local && ct.local.wood, 0)) },
    happy: clamp(Math.round(num(ct.happy, 50)), 0, 100),
    unrest: Math.max(0, num(ct.unrest, 0)), warned: !!ct.warned, foundedDay: num(ct.foundedDay, 0),
  }));
  s.caravans = (data.caravans || []).map(car => ({ ...car, goods: { ...(car.goods || {}) } }));
  s.lost = (data.lost || []).map(l => ({ ...l }));
  s.nextId = Math.max(1, Math.round(num(data.nextId, s.cities.length + 1)));
  s.nextCaravanId = Math.max(1, Math.round(num(data.nextCaravanId, 1)));
  s.lastDay = Number.isFinite(data.lastDay) ? data.lastDay : -1;
  return s;
}

// ---------- Обёртка-система для ядра ----------
export function createEmpireSystem() {
  return {
    state: createEmpire(),
    lastReport: null,

    ctxOf(sim) {
      return {
        day: sim.day, world: sim.world,
        capitalX: sim.world.startX, capitalY: sim.world.startY,
        seasonIdx: sim.seasonIdx, techs: sim.techs,
        armyPower: sim.armyPower(), atWar: sim.wars.length > 0,
      };
    },

    canFound(sim, x, y) {
      const cost = foundCost(this.state);
      const lack = Object.entries(cost).filter(([r, v]) => (sim.res[r] || 0) < v);
      if (lack.length) return { ok: false, reason: `Не хватает: ${lack.map(([r, v]) => `${r} ${v}`).join(', ')}` };
      return canFound(this.state, this.ctxOf(sim), x, y);
    },

    found(sim, x, y, specId = null) {
      const chk = this.canFound(sim, x, y);
      if (!chk.ok) return chk;
      const cost = foundCost(this.state);
      const res = foundCity(this.state, this.ctxOf(sim), x, y, sim.rng, specId);
      if (!res.ok) return res;
      for (const [r, v] of Object.entries(cost)) sim.res[r] -= v;
      sim.addLog(`🏙 Основан город ${res.city.name}! Расстояние до столицы: ${Math.round(distToCapital(res.city, this.ctxOf(sim)))} клеток.`, 'good');
      return res;
    },

    setSpec(sim, cityId, specId) {
      const r = setSpecialization(this.state, cityId, specId);
      if (r.ok) sim.addLog(`Город получил специализацию: ${r.ru}.`);
      return r;
    },

    build(sim, cityId, buildingId) {
      const r = buildInCity(this.state, cityId, buildingId, sim.res.gold);
      if (r.ok) {
        sim.res.gold -= r.goldSpent;
        sim.addLog(`В городе построено: ${r.ru}.`, 'good');
      }
      return r;
    },

    onNewDay(sim) {
      const rep = tickEmpire(this.state, this.ctxOf(sim), sim.rng);
      sim.res.gold = Math.max(0, sim.res.gold + rep.shared.gold - rep.upkeep);
      sim.res.knowledge += rep.shared.knowledge;
      sim.res.food = Math.min(sim.resCap.food ?? Infinity, sim.res.food + rep.toCapital.food);
      sim.res.wood = Math.min(sim.resCap.wood ?? Infinity, sim.res.wood + rep.toCapital.wood);
      for (const e of rep.events) sim.addLog(e.text, e.type);
      for (const r of rep.revolted) sim.addChronicle(`Город ${r.name} отложился от империи.`);
      this.lastReport = rep;
      return rep;
    },

    serialize() { return serializeEmpire(this.state); },
    deserialize(data) { this.state = deserializeEmpire(data); },
  };
}

// ---------- Внутреннее ----------
// Приводим разношёрстный ввод к одному виду: ядро отдаёт Set техов, тесты — массив.
function readCtx(ctx) {
  const o = ctx || {};
  if (o.__empCtx) return o;
  const techs = o.techs;
  const hasTech = (id) => !techs ? false
    : (typeof techs.has === 'function' ? techs.has(id) : Array.isArray(techs) && techs.includes(id));
  const world = o.world || null;
  return {
    __empCtx: true,
    day: Math.max(0, Math.round(num(o.day, 0))),
    world,
    capitalX: num(o.capitalX, world ? num(world.startX, world.w / 2) : 0),
    capitalY: num(o.capitalY, world ? num(world.startY, world.h / 2) : 0),
    seasonIdx: Number.isFinite(o.seasonIdx) ? o.seasonIdx : 0,
    armyPower: Math.max(0, num(o.armyPower, 0)),
    atWar: !!o.atWar,
    hasTech,
  };
}

function goodsText(goods) {
  return Object.entries(goods).map(([r, v]) => `${v}${r === 'food' ? '🍞' : '🪵'}`).join(' ');
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function num(v, def) { return Number.isFinite(v) ? v : def; }
function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }

/* ИНТЕГРАЦИЯ (точные строки для simulation.js):

1) Импорт, рядом с остальными импортами систем:
     import { createEmpireSystem } from './systems/empire.js';

2) constructor(), сразу после installSystems(this):
     this.empire = createEmpireSystem();

3) onNewDay(), сразу после строки this.tickFactions();:
     this.empire.onNewDay(this);

4) Сейв. В serialize() добавить поле:
     empire: this.empire.serialize(),
   В deserialize(), после восстановления ресурсов:
     sim.empire = createEmpireSystem();
     sim.empire.deserialize(data.empire);
   Старые сейвы без поля грузятся: вернётся пустая империя.

5) UI (вызовы из панелей, DOM модулю не нужен):
     sim.empire.canFound(sim, x, y)              // {ok, reason} для подсветки клетки
     sim.empire.found(sim, x, y, 'trade')        // основать (специализация опциональна)
     sim.empire.setSpec(sim, cityId, 'agrarian') // сменить специализацию
     sim.empire.build(sim, cityId, 'market')     // городская постройка
     sim.empire.lastReport.cities               // готовые сводки для панели империи
   Ручной караван между городами:
     sendCaravan(sim.empire.state, sim.empire.ctxOf(sim), fromId, toId, { food: 50 })
     (toId = 0 — столица; возить можно только еду и дерево — золото и знания общие).
*/
