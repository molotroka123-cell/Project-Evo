// core/systems/wire_empire.js — оживление empire.js (города) и worldsites.js
// (особые точки карты и туман войны).
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. Обе системы написаны, покрыты тестами (18 + 24) и мертвы:
// игра их не зовёт. Здесь тот же принцип, что в systems/integrate.js — модуль
// НЕ трогает sim сам, он получает ctx и возвращает отчёт, а применяет отчёт к
// миру этот слой. Поэтому empire.js и worldsites.js остаются проверяемыми в
// одиночку, а ядро не знает про их внутренности.
//
// ЧТО ИМЕННО ОЖИВАЕТ:
//   empire.js — колонии с русскими именами, коррупция от расстояния до столицы,
//     содержание наместников, специализации, городские постройки, караваны с
//     риском ограбления, сепаратизм и отпадение города;
//   worldsites.js — туман войны, руины с добычей, лагеря разбойников с налётами
//     и штурмом.
//
// ПОЧЕМУ ОНИ В ОДНОМ ФАЙЛЕ. Они про одно и то же — про карту за околицей. Туман
// решает, ГДЕ игроку вообще позволено закладывать город (нельзя основать
// колонию там, куда не ходили), лагерь разбойников по дороге делает караван
// между городами настоящим риском, а руины — первой причиной уйти от костра.
// Порознь это два списка чисел, вместе — одна причина расширяться.
//
// ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ. Выселки worldsites.js (settlements/outposts) НЕ
// подключены: это второй склад ресурсов и вторые обозы, то есть ровно то же
// самое, что уже делают города empire.js со своим city.local и караванами.
// Дублировать механику нельзя, поэтому из worldsites.js берутся туман, руины и
// лагеря, а поселения империи ведёт empire.js. Столица worldsites (она создаётся
// конструктором) остаётся одна — как и было до подключения.
//
// Math.random не используется: вся случайность — внутри модулей, через sim.rng.

import { RES, TILE, WALKABLE, DAYS_PER_SEASON } from '../data.js';
import { tileAt } from '../world.js';
import {
  createEmpireSystem, canFound, foundCost, cityById, citySummary,
  distToCapital, corruption, upkeepPerDay, prodMult, robChance, sendCaravan,
  SPECS, CITY_BUILDINGS, LOCAL_RES, PROD_PER_POP, EAT_PER_POP, FOOD_SEASON,
  MIN_CITY_DIST, FOOD_RADIUS, CARAVAN_SPEED, CARAVAN_MIN_LOAD, CARAVAN_CAP,
  CORR_MAX, KEEP_DAYS, WOOD_KEEP, POP_BASE_CAP,
  UNREST_HAPPY, UNREST_WARN, UNREST_REVOLT,
} from './empire.js';
import { WorldSites, SITE_DEFS, SIGHT, BANDIT } from './worldsites.js';

const RES_META = Object.fromEntries(RES.map(r => [r.id, r]));

// Сколько мест под город показывать в панели. Больше пяти — это уже не выбор,
// а таблица: игрок перестаёт читать и жмёт первое попавшееся.
const SPOT_LIMIT = 5;
// Шаг сканирования карты под города. Через клетку: города всё равно нельзя
// ставить ближе 12 клеток друг к другу, так что вдвое реже — та же выборка,
// но вчетверо дешевле. 96×96 сканируется примерно за миллисекунду.
const SCAN_STEP = 2;
// Дальше этого колония окупается только на бумаге: содержание 1+0.08×(d−10)🪙
// в день и коррупция под потолком. Места дальше в список не берём, но руками
// (через canFound) основать по-прежнему можно — запрета в модуле нет.
const SCAN_MAX_DIST = 55;
// Сколько особых точек показывать в списке — та же причина, что и у SPOT_LIMIT.
const SITE_LIMIT = 6;

// ════════════════════════════ АДАПТЕР ════════════════════════════

// install(sim). Ставит обе системы. Повторный вызов безвреден — это важно для
// загрузки сейва, где конструктор Simulation отрабатывает раньше restore.
export function installEmpire(sim) {
  if (!sim || !sim.world) return null;
  if (sim.empire) return sim.empire;

  // Обёртка из empire.js уже умеет собирать ctx и применять отчёт к sim —
  // своего второго тика здесь быть не должно.
  sim.empire = createEmpireSystem();

  // WorldSites берёт отдельный поток случайности для расстановки точек (см. его
  // конструктор), поэтому установка НЕ сдвигает sim.rng и не меняет мир по сиду.
  if (!sim.sites) sim.sites = new WorldSites(sim.world, sim.rng, { seed: sim.seed });

  sim.empireWire = {
    ui: { city: 0 },                    // раскрытая карточка города
    spots: { day: -1, cities: -1, list: [], fogged: 0 },
    lastSiteEvents: [],                 // события карты за последний день — для панели
    raidsBeaten: 0,
    campsCleared: 0,
    ruinsLooted: 0,
  };

  // Первый расчёт тумана: без него панель в первый же день утверждает, что
  // карта не разведана, хотя костёр уже стоит и всё вокруг видно.
  empireFog(sim);
  return sim.empire;
}

// Пересчёт тумана войны. Наблюдатели — те же, что знает worldsites (поселение,
// здания, жители), плюс колонии: город без обзора вокруг себя выглядел бы как
// слепое пятно посреди собственной страны.
export function empireFog(sim) {
  if (!sim || !sim.sites) return 0;
  const obs = sim.sites.observers(sim.buildings, sim.villagers, sim.techs);
  if (sim.empire) {
    for (const c of sim.empire.state.cities) obs.push({ x: c.x, y: c.y, r: SIGHT.settlement });
  }
  return sim.sites.updateFog(obs);
}

// onNewDay(sim). Порядок важен: сперва живут города (их караваны и дань), потом
// открывается карта, потом ходят разбойники — тогда налёт бьёт по уже начисленным
// запасам дня, а не по вчерашним.
export function empireNewDay(sim) {
  if (!sim || !sim.empire) return null;
  const rep = sim.empire.onNewDay(sim);
  empireFog(sim);

  const W = sim.empireWire;
  if (sim.sites) {
    const events = sim.sites.tickDay({ day: sim.day, eraIndex: sim.eraIndex });
    if (W) W.lastSiteEvents = events;
    for (const ev of events) applySiteEvent(sim, ev);
  }
  return rep;
}

// Применение события карты. Логика ровно та, что описана в шапке worldsites.js:
// модуль решает, что налёт случился, а исход считает эта сторона — только она
// знает про армию, стены и потолки складов.
function applySiteEvent(sim, ev) {
  const W = sim.empireWire;
  if (ev.type === 'banditRaid') {
    const mine = sim.armyPower() + sim.defensePower();
    if (mine >= ev.power) {
      sim.repelled = (sim.repelled || 0) + 1;
      if (W) W.raidsBeaten++;
      sim.res.gold += ev.power;
      sim.addLog(ev.textWin, 'good');
    } else {
      // Именно min: плоская кража добивала малое племя, доля — щадит.
      const steal = Math.min(ev.steal, sim.res.food * ev.stealPct);
      sim.res.food = Math.max(0, sim.res.food - steal);
      sim.addLog(`${ev.textLose} Унесено ${Math.round(steal)}🍞.`, 'bad');
    }
    return;
  }
  // Обозы бывают только у выселков worldsites, а их мы не заводим (см. шапку).
  // Ветки оставлены, чтобы событие из старого сейва не потерялось молча.
  if (ev.type === 'convoyArrived') {
    for (const [r, v] of Object.entries(ev.cargo || {})) {
      sim.res[r] = Math.min(sim.resCap[r] ?? Infinity, (sim.res[r] || 0) + v);
    }
    sim.addLog(ev.text);
  } else if (ev.type === 'convoyRobbed') {
    sim.addLog(ev.text, 'bad');
  }
}

// serialize(sim)
export function empireSerialize(sim) {
  if (!sim || !sim.empire) return null;
  const W = sim.empireWire || {};
  return {
    v: 1,
    empire: sim.empire.serialize(),
    sites: sim.sites ? sim.sites.serialize() : null,
    stat: { raids: W.raidsBeaten || 0, camps: W.campsCleared || 0, ruins: W.ruinsLooted || 0 },
  };
}

// restore(sim, data). Старые сейвы без поля грузятся: вернётся пустая империя и
// свежесгенерированная по сиду карта точек — она и так одинакова для сида.
export function empireRestore(sim, data) {
  if (!sim) return false;
  if (!sim.empire) installEmpire(sim);
  if (!data) return false;
  if (data.empire) sim.empire.deserialize(data.empire);
  if (data.sites && sim.sites) sim.sites.deserialize(data.sites);
  const W = sim.empireWire;
  if (W && data.stat) {
    W.raidsBeaten = data.stat.raids || 0;
    W.campsCleared = data.stat.camps || 0;
    W.ruinsLooted = data.stat.ruins || 0;
    W.spots = { day: -1, cities: -1, list: [] };
  }
  empireFog(sim);
  return true;
}

// Короткие имена — тот самый набор install/onNewDay/serialize/restore. В точках
// подключения используются длинные: в simulation.js рядом живут ещё пять систем,
// и голое onNewDay там ничего не объясняет.
export { installEmpire as install, empireNewDay as onNewDay, empireSerialize as serialize, empireRestore as restore };

// ════════════════════════ ПРИГОДНОСТЬ МЕСТА ════════════════════════

// Разбор одной клетки под город. Возвращает и вердикт модуля (canFound), и
// причины «почему тут хорошо»: панель обязана объяснять оценку, а не выдавать
// число из ниоткуда.
// ctx можно передать снаружи: при сканировании карты он один на все клетки, а
// его сборка дёргает armyPower() и globalMult() — на сотне мест это заметно.
export function spotReport(sim, x, y, ctx = null) {
  const st = sim.empire.state;
  if (!ctx) ctx = sim.empire.ctxOf(sim);
  const out = {
    x, y, ok: false, reason: '', explored: true,
    food: 0, wood: 0, water: false, dist: 0, corr: 0, upkeep: 0, score: 0, camp: null,
  };

  const chk = canFound(st, ctx, x, y);
  out.ok = chk.ok;
  out.reason = chk.ok ? '' : chk.reason;

  // Правило разведки — единственное, что этот слой добавляет к проверкам модуля:
  // основать город вслепую нельзя, иначе туман войны ничего не стоит.
  // Причину подменяем только если по земле вопросов нет: «место не разведано»
  // поверх «здесь вода» — это неправда и лишний круг разведки впустую.
  if (sim.sites && !sim.sites.isExplored(x, y)) {
    out.explored = false;
    if (out.ok) { out.ok = false; out.reason = 'Место не разведано — сходите туда'; }
  }

  // Что кормит и чем топить. Радиус тот же, в котором модуль ищет пропитание.
  for (let dy = -FOOD_RADIUS; dy <= FOOD_RADIUS; dy++) {
    for (let dx = -FOOD_RADIUS; dx <= FOOD_RADIUS; dx++) {
      const t = tileAt(sim.world, x + dx, y + dy);
      if (t === TILE.GRASS) out.food++;
      else if (t === TILE.FOREST) { out.food++; out.wood++; }
      else if (t === TILE.WATER) { out.food++; out.water = true; }
    }
  }

  out.dist = Math.hypot(x - ctx.capitalX, y - ctx.capitalY);
  out.corr = corruption(out.dist, ctx);
  out.upkeep = upkeepPerDay(out.dist);

  // Лагерь под боком — не запрет, а честное предупреждение: караваны отсюда
  // будут грабить вдвое чаще, а налёты пойдут по ближайшему поселению.
  if (sim.sites) {
    for (const s of sim.sites.liveCamps()) {
      if (!sim.sites.isExplored(s.x, s.y)) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < 14 && (!out.camp || d < out.camp.d)) out.camp = { d, site: s };
    }
  }

  // Оценка 0..100. Веса: сытость важнее всего (голодный город бунтует), потом
  // потери на коррупции, потом лес — он даёт городу дерево на свои постройки.
  const foodPart = Math.min(1, out.food / 24);
  const woodPart = Math.min(1, out.wood / 14);
  const corrPart = 1 - Math.min(1, out.corr / CORR_MAX);
  let score = 100 * (0.45 * foodPart + 0.2 * woodPart + 0.35 * corrPart);
  if (out.camp) score -= 12;
  out.score = Math.max(0, Math.min(100, Math.round(score)));
  return out;
}

// Вердикт словами. Число без слова читается как «больше — лучше» и не говорит,
// стоит ли вообще тратить сотню еды.
export function spotVerdict(score) {
  if (score >= 72) return { ru: 'отличное место', col: 'var(--good)' };
  if (score >= 55) return { ru: 'доброе место', col: 'var(--good)' };
  if (score >= 38) return { ru: 'так себе', col: 'var(--warn)' };
  return { ru: 'бедное место', col: 'var(--bad)' };
}

// Лучшие места под колонию. Сканирование дорогое, панель перерисовывается
// четыре раза в секунду — поэтому результат живёт до конца игрового дня или до
// изменения числа городов.
export function spotsScan(sim, limit = SPOT_LIMIT) {
  const W = sim.empireWire;
  const st = sim.empire.state;
  if (!W) return scanSpots(sim, limit);
  if (W.spots.day === sim.day && W.spots.cities === st.cities.length) return W.spots;
  const res = scanSpots(sim, limit);
  W.spots = { day: sim.day, cities: st.cities.length, list: res.list, fogged: res.fogged };
  return W.spots;
}

export function bestSpots(sim, limit = SPOT_LIMIT) { return spotsScan(sim, limit).list; }

function scanSpots(sim, limit) {
  const world = sim.world;
  const ctx = sim.empire.ctxOf(sim);
  const st = sim.empire.state;
  const cx = ctx.capitalX, cy = ctx.capitalY;
  const found = [];
  // Отдельно считаем клетки, отвергнутые ТОЛЬКО из-за тумана: пустой список
  // «мест не найдено» должен объяснять, разведка виновата или земля.
  let fogged = 0;

  for (let y = 1; y < world.h - 1; y += SCAN_STEP) {
    for (let x = 1; x < world.w - 1; x += SCAN_STEP) {
      // Три дешёвые отсечки до дорогого подсчёта соседних клеток: земля,
      // расстояние, разведка. Так до spotReport доходит меньше сотни клеток.
      if (!WALKABLE.has(tileAt(world, x, y))) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (d < MIN_CITY_DIST || d > SCAN_MAX_DIST) continue;
      if (sim.sites && !sim.sites.isExplored(x, y)) { fogged++; continue; }
      let tooClose = false;
      for (const c of st.cities) {
        if (Math.hypot(x - c.x, y - c.y) < MIN_CITY_DIST) { tooClose = true; break; }
      }
      if (tooClose) continue;

      const rep = spotReport(sim, x, y, ctx);
      if (!rep.ok) continue;
      found.push(rep);
    }
  }

  found.sort((a, b) => b.score - a.score || a.dist - b.dist);

  // Разрежаем выдачу: пять соседних клеток одного луга — это одно и то же место,
  // а список должен предлагать разные направления.
  const out = [];
  for (const s of found) {
    if (out.some(o => Math.hypot(o.x - s.x, o.y - s.y) < MIN_CITY_DIST)) continue;
    out.push(s);
    if (out.length >= limit) break;
  }
  return { list: out, fogged };
}

// ═══════════════════════ РАСЧЁТЫ ДЛЯ ПОКАЗА ═══════════════════════

// Сколько город даёт в день. Считается по тем же таблицам empire.js
// (PROD_PER_POP × prodMult), что и тик, — это показ ожидаемого, а не вторая
// экономика: ни одно число отсюда в sim не попадает.
export function cityFlow(city, ctx) {
  const d = distToCapital(city, ctx);
  const corr = corruption(d, ctx);
  const happyMult = city.happy < 35 ? 0.7 : 1;
  const season = FOOD_SEASON[ctx.seasonIdx] ?? 1;
  const eat = city.pop * EAT_PER_POP;
  const food = city.pop * PROD_PER_POP.food * prodMult(city, 'food') * happyMult * season;
  return {
    corr,
    upkeep: upkeepPerDay(d),
    gold: city.pop * PROD_PER_POP.gold * prodMult(city, 'gold') * happyMult * (1 - corr),
    knowledge: city.pop * PROD_PER_POP.knowledge * prodMult(city, 'knowledge') * happyMult * (1 - corr),
    food, eat, foodNet: food - eat,
    wood: city.pop * PROD_PER_POP.wood * prodMult(city, 'wood') * happyMult,
    winter: season === 0,
  };
}

// Через сколько дней город отложится, если ничего не менять. Формула роста
// недовольства повторяет tickEmpire по тем же экспортированным константам:
// предупреждение без срока — не предупреждение, а украшение.
export function revoltEta(city, ctx) {
  if (city.happy >= UNREST_HAPPY) return null;
  const d = distToCapital(city, ctx);
  let grow = ((UNREST_HAPPY - city.happy) / UNREST_HAPPY) * (0.5 + d / 40);
  if (city.spec === 'military') grow *= 0.5;
  if (grow <= 0.001) return null;
  return Math.max(1, Math.ceil((UNREST_REVOLT - city.unrest) / grow));
}

// Зимовка города. Зима (сезон 3) длится DAYS_PER_SEASON дней и полей не родит —
// это главная и почти невидимая угроза колонии: город держит запас всего на
// KEEP_DAYS дней, остальное уходит столице. Панель обязана показать разрыв
// заранее, иначе игрок узнаёт о нём по строке «Голод в городе».
export function winterWatch(sim, city, flow) {
  const isWinter = sim.seasonIdx === 3;
  const inSeason = sim.day % DAYS_PER_SEASON;
  const left = DAYS_PER_SEASON - inSeason;                     // дней до смены поры
  const toWinter = isWinter ? 0 : ((3 - sim.seasonIdx + 4) % 4 - 1) * DAYS_PER_SEASON + left;
  const days = isWinter ? left : DAYS_PER_SEASON;             // сколько дней придётся жить запасом
  const need = flow.eat * days;
  const have = city.local.food;
  return { isWinter, toWinter, daysLeft: left, need, have, gap: Math.max(0, need - have) };
}

// Куда этот город может отправить караван: столица плюс два ближайших соседа.
// Больше — это выпадающий список, которого в панели нет и быть не должно.
export function caravanTargets(sim, city) {
  const ctx = sim.empire.ctxOf(sim);
  const out = [{ id: 0, name: 'Столица', x: ctx.capitalX, y: ctx.capitalY }];
  const others = sim.empire.state.cities
    .filter(c => c.id !== city.id)
    .map(c => ({ id: c.id, name: c.name, x: c.x, y: c.y, city: c, d: Math.hypot(c.x - city.x, c.y - city.y) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 2);
  return out.concat(others);
}

// Партия для ручного каравана: половина склада, но не мельче минимального обоза
// и не крупнее вместимости. Половина — чтобы город не остался пустым.
export function caravanLot(city, res) {
  const have = Math.floor(city.local[res] || 0);
  if (have < CARAVAN_MIN_LOAD) return 0;
  return Math.max(CARAVAN_MIN_LOAD, Math.min(CARAVAN_CAP, Math.floor(have / 2)));
}

// ═════════════════════════════ ПАНЕЛЬ ═════════════════════════════

export function renderEmpirePanel(sim) {
  if (!sim) return '';
  if (!sim.empire) {
    return `<div class="card"><div class="ttl"><span>Империя не подключена</span></div>
      <div class="desc">Системы городов и особых точек установлены, но installEmpire(sim) не вызван.</div></div>`;
  }
  const st = sim.empire.state;
  const ctx = sim.empire.ctxOf(sim);
  let html = _head(sim, st, ctx);
  html += _alerts(sim, st, ctx);
  html += _cities(sim, st, ctx);
  html += _found(sim, st, ctx);
  html += _sites(sim, st, ctx);
  return html;
}

function _head(sim, st, ctx) {
  const rep = sim.empire.lastReport;
  const pop = st.cities.reduce((s, c) => s + c.pop, 0);
  const gold = rep ? rep.shared.gold : 0;
  const know = rep ? rep.shared.knowledge : 0;
  const upkeep = rep ? rep.upkeep : 0;
  const net = gold - upkeep;
  const netCol = net > 0 ? 'var(--good)' : net < 0 ? 'var(--bad)' : 'var(--warn)';
  const explored = sim.sites ? Math.round(sim.sites.exploredFraction() * 100) : null;

  let html = `<div class="card"><div class="ttl"><span>Империя</span><span class="cost">${st.cities.length} ${_plural(st.cities.length, 'город', 'города', 'городов')}</span></div>
    <div class="desc">Золото и знания колонии шлют в столицу каждый день — за вычетом того, что прилипло к рукам наместников. Еда и дерево лежат на месте и едут только караваном.</div>`;

  if (st.cities.length) {
    html += `<div class="kv"><span>Жителей в колониях</span><span>${pop}</span></div>
      <div class="kv"><span>Дань в день</span><span>${_g(gold)}🪙 · ${_n(know)}📜</span></div>
      <div class="kv"><span>Содержание наместников</span><span>−${_g(upkeep)}🪙</span></div>
      <div class="kv"><span>Чистыми</span><span style="color:${netCol}">${_sign(net)}🪙 в день</span></div>`;
    // Зимовка — главная неожиданность колоний: поля не родят 25 дней, а запас
    // город держит на 10. Сводка по империи стоит здесь, подробности — в городе.
    const risky = st.cities.filter(c => winterWatch(sim, c, cityFlow(c, ctx)).gap > 0).length;
    if (risky) {
      html += `<div class="kv"><span>Не дотянут до весны</span><span style="color:var(--warn)">${risky} из ${st.cities.length}</span></div>`;
    }
    if (st.caravans.length) {
      const soon = st.caravans.reduce((m, c) => Math.min(m, c.daysLeft), 99);
      html += `<div class="kv"><span>Караванов в пути</span><span>${st.caravans.length} · ближайший через ${soon} дн.</span></div>`;
    }
  } else {
    const cost = foundCost(st);
    html += `<div class="desc">Пока всё держится на одном поселении: сколько бы жителей ни было, потолок глубины — один склад и один костёр. Колония даёт своё население, свой склад и свою специализацию.</div>
      <div class="kv"><span>Первая колония</span><span>${_cost(cost)}</span></div>`;
  }
  if (explored !== null) {
    html += `<div class="kv"><span>Разведано карты</span><span>${explored}%</span></div>`;
  }
  if (st.lost.length) {
    html += `<div class="reason">Потеряно городов: ${st.lost.length} (${st.lost.map(l => l.name).join(', ')}).</div>`;
  }
  return html + '</div>';
}

// Тревоги идут первыми и только когда есть о чём говорить: постоянный красный
// блок игрок перестаёт читать на третий день.
function _alerts(sim, st, ctx) {
  const parts = [];

  for (const city of st.cities) {
    if (city.unrest < UNREST_WARN) continue;
    const eta = revoltEta(city, ctx);
    const d = Math.round(distToCapital(city, ctx));
    const advice = [];
    if (city.local.food <= 0) advice.push('пришлите караван с едой');
    if (!city.buildings.includes('tavern')) advice.push('трактир даёт +6 к настроению');
    if (city.spec !== 'military') advice.push('военная специализация вдвое гасит смуту');
    parts.push(`<div class="card"><div class="ttl"><span>🔥 ${city.name}: зреет сепаратизм</span>
        <span class="cost" style="color:var(--bad)">${_n(city.unrest)}/${UNREST_REVOLT}</span></div>
      <div class="desc">Счастье ${city.happy}%, до столицы ${d} ${_plural(d, 'клетка', 'клетки', 'клеток')} — далёкий и несчастный город уходит первым.</div>
      <div class="relbar"><div style="width:${Math.round(city.unrest / UNREST_REVOLT * 100)}%;background:var(--bad)"></div></div>
      ${eta ? `<div class="reason">Отложится примерно через ${eta} ${_plural(eta, 'день', 'дня', 'дней')}. ${advice.length ? 'Что делать: ' + advice.join(', ') + '.' : ''}</div>` : ''}</div>`);
  }

  const rep = sim.empire.lastReport;
  if (rep && rep.robbed.length) {
    const goods = rep.robbed.map(c => _goods(c.goods)).join(' · ');
    parts.push(`<div class="card"><div class="ttl"><span>💀 Караван ограблен</span></div>
      <div class="desc">Потеряно: ${goods}. Разбой на дорогах гасят армия, стены в городах и военная специализация.</div></div>`);
  }

  if (!parts.length) return '';
  return '<h4 class="group">Тревоги</h4>' + parts.join('');
}

function _cities(sim, st, ctx) {
  if (!st.cities.length) return '';
  const W = sim.empireWire || { ui: { city: 0 } };
  const sel = W.ui.city;
  let html = '<h4 class="group">Города</h4>';
  const sorted = [...st.cities].sort((a, b) => distToCapital(a, ctx) - distToCapital(b, ctx));
  for (const city of sorted) {
    html += city.id === sel ? _cityFull(sim, city, ctx) : _cityRow(sim, city, ctx);
  }
  return html;
}

function _cityRow(sim, city, ctx) {
  const s = citySummary(city, ctx);
  const col = _happyCol(s.happy);
  const flow = cityFlow(city, ctx);
  const net = flow.gold - flow.upkeep;
  return `<div class="card" data-emp="sel:${city.id}">
    <div class="ttl"><span>🏙 ${s.name}</span><span class="cost">${s.pop} 🧍</span></div>
    <div class="desc">${s.specRu} · ${Math.round(s.dist)} кл. от столицы · коррупция ${Math.round(s.corr * 100)}% · ${_sign(net)}🪙/день</div>
    <div class="relbar"><div style="width:${s.happy}%;background:${col}"></div></div>
    <div class="desc" style="color:${col}">Счастье ${s.happy}%${city.unrest > 0 ? ` · смута ${_n(city.unrest)}/${UNREST_REVOLT}` : ''} · склад ${Math.floor(s.local.food)}🍞 ${Math.floor(s.local.wood)}🪵</div>
  </div>`;
}

function _cityFull(sim, city, ctx) {
  const s = citySummary(city, ctx);
  const flow = cityFlow(city, ctx);
  const col = _happyCol(s.happy);
  const foodDays = flow.eat > 0 ? city.local.food / flow.eat : Infinity;
  const cap = POP_BASE_CAP + (city.buildings.includes('granary') ? 10 : 0);

  let html = `<div class="card" data-emp="sel:0" style="border-color:var(--warn)">
    <div class="ttl"><span>🏙 ${s.name}</span><span class="cost">${s.pop}/${cap} 🧍</span></div>
    <div class="desc">${s.specRu} · основан на ${city.foundedDay} день · ${Math.round(s.dist)} кл. от столицы</div>
    <div class="relbar"><div style="width:${s.happy}%;background:${col}"></div></div>
    <div class="kv"><span>Счастье</span><span style="color:${col}">${s.happy}%</span></div>
    <div class="kv"><span>Коррупция</span><span>${Math.round(s.corr * 100)}% дани оседает у наместника</span></div>
    <div class="kv"><span>Даёт в столицу</span><span>${_g(flow.gold)}🪙 · ${_n(flow.knowledge)}📜 в день</span></div>
    <div class="kv"><span>Содержание</span><span>−${_g(flow.upkeep)}🪙 в день</span></div>
    <div class="kv"><span>Склад города</span><span>${Math.floor(city.local.food)}🍞 ${Math.floor(city.local.wood)}🪵</span></div>
    <div class="kv"><span>Еды хватит на</span><span>${isFinite(foodDays) ? Math.floor(foodDays) + ' дн.' : '—'}</span></div>
    <div class="kv"><span>Растёт</span><span>${_growth(city, cap)}</span></div>`;

  const win = winterWatch(sim, city, flow);
  html += `<div class="kv"><span>${win.isWinter ? 'До весны' : 'До зимы'}</span><span>${win.isWinter ? win.daysLeft : win.toWinter} дн. · нужно ${Math.ceil(win.need)}🍞 запаса</span></div>`;
  if (win.gap > 0 && (win.isWinter || win.toWinter <= DAYS_PER_SEASON)) {
    const hungry = Math.max(1, Math.ceil(win.gap / Math.max(0.1, flow.eat)));
    html += `<div class="reason">Зимой поля не родят, а город держит запас только на ${KEEP_DAYS} дней — остальное сам увозит столице. Не хватает ${Math.ceil(win.gap)}🍞, это ${hungry} ${_plural(hungry, 'голодный день', 'голодных дня', 'голодных дней')}, и каждый такой день — минус житель. Привезти еду может только другой город: столица караванов не шлёт.</div>`;
  }
  if (flow.foodNet < 0 && !win.isWinter) {
    html += `<div class="reason">Город ест больше, чем растит (${_sign(flow.foodNet, _n)}🍞 в день) — голод начнётся сам собой.</div>`;
  }
  html += '</div>';

  html += _specs(city);
  html += _cityBuildings(sim, city);
  html += _caravans(sim, city, ctx);
  return html;
}

// Специализация — главное решение по городу: всегда «+ к одному, − к другому».
function _specs(city) {
  let html = `<div class="card"><div class="ttl"><span>Специализация</span>
      <span class="cost">${city.spec ? SPECS[city.spec].ru : 'не выбрана'}</span></div>
    <div class="desc">Меняется в любой день и действует сразу. Выбор без обратной стороны был бы не выбором, поэтому у каждой специализации есть минус.</div>`;
  for (const [id, def] of Object.entries(SPECS)) {
    const cur = city.spec === id;
    html += `<button class="btn ${cur ? 'primary' : ''}" style="width:100%;margin-top:6px;padding:8px;font-size:12px;text-align:left"
      data-emp="spec:${city.id}:${id}"${cur ? ' disabled' : ''}>${cur ? '✓ ' : ''}${def.ru} — ${def.desc}</button>`;
  }
  return html + '</div>';
}

// Городские постройки: дерево берётся со склада города (оно местное), золото —
// из общей казны (оно общее). Это то же правило, что и у ресурсов.
function _cityBuildings(sim, city) {
  let html = `<div class="card"><div class="ttl"><span>Постройки города</span>
      <span class="cost">${city.buildings.length}/${Object.keys(CITY_BUILDINGS).length}</span></div>
    <div class="desc">Дерево на стройку берётся со склада города, золото — из казны столицы. По одной постройке каждого вида.</div>`;
  for (const [id, def] of Object.entries(CITY_BUILDINGS)) {
    const has = city.buildings.includes(id);
    const wood = def.cost.wood || 0, gold = def.cost.gold || 0;
    const lackWood = city.local.wood < wood;
    const lackGold = (sim.res.gold || 0) < gold;
    const why = has ? '' : lackWood ? `не хватает ${Math.ceil(wood - city.local.wood)}🪵 на складе города`
      : lackGold ? `не хватает ${Math.ceil(gold - sim.res.gold)}🪙 в казне` : '';
    const effect = [];
    if (def.mult) for (const [r, m] of Object.entries(def.mult)) effect.push(`${_icon(r)} ×${m}`);
    if (def.happy) effect.push(`+${def.happy} к счастью`);
    if (def.safe) effect.push('караваны безопаснее');
    if (id === 'granary') effect.push('+10 к пределу населения');
    html += `<button class="btn ${has ? '' : 'primary'}" style="width:100%;margin-top:6px;padding:8px;font-size:12px;text-align:left"
      data-emp="build:${city.id}:${id}"${has || why ? ' disabled' : ''}>${has ? '✓ ' : ''}${def.ru} · ${wood}🪵${gold ? ' ' + gold + '🪙' : ''} — ${effect.join(', ')}${why ? ` · ${why}` : ''}</button>`;
  }
  return html + '</div>';
}

function _caravans(sim, city, ctx) {
  const targets = caravanTargets(sim, city);
  let html = `<div class="card"><div class="ttl"><span>Караваны</span><span class="cost">${city.name}</span></div>
    <div class="desc">Излишки уходят в столицу сами: город держит еду на ${KEEP_DAYS} дней и ${WOOD_KEEP}🪵, остальное грузит в обоз. Вручную возят к соседям — прежде всего кормить город, который не дотянет до весны. Золото и знания караван не возит: они и так общие.</div>`;

  let any = false;
  for (const t of targets) {
    const dist = Math.hypot(city.x - t.x, city.y - t.y);
    const days = Math.max(1, Math.ceil(dist / CARAVAN_SPEED));
    const rob = robChance(days, ctx, city, t.city || null);
    const robCol = rob > 0.25 ? 'var(--bad)' : rob > 0.1 ? 'var(--warn)' : 'var(--good)';
    const btns = [];
    for (const res of LOCAL_RES) {
      const amt = caravanLot(city, res);
      if (!amt) continue;
      any = true;
      btns.push(`<button class="btn" style="flex:1;padding:8px;font-size:12px"
        data-emp="car:${city.id}:${t.id}:${res}:${amt}">${amt}${_icon(res)} →</button>`);
    }
    if (!btns.length) continue;
    html += `<div class="kv"><span>${t.name}</span><span>${days} ${_plural(days, 'день', 'дня', 'дней')} пути · <span style="color:${robCol}">риск ${Math.round(rob * 100)}%</span></span></div>
      <div class="btns" style="display:flex;gap:8px;margin-bottom:6px">${btns.join('')}</div>`;
  }
  if (!any) {
    html += `<div class="reason">Отправлять нечего: обоз собирают от ${CARAVAN_MIN_LOAD} единиц, а на складе меньше.</div>`;
  }

  // Свои караваны в пути показываем здесь же: иначе непонятно, где груз.
  const mine = sim.empire.state.caravans.filter(c => c.from === city.id);
  for (const c of mine) {
    const to = c.to === 0 ? 'столицу' : (cityById(sim.empire.state, c.to) || { name: '—' }).name;
    html += `<div class="kv"><span>🐫 В пути в ${to}</span><span>${_goods(c.goods)} · ${c.daysLeft} дн. · риск ${Math.round(c.rob * 100)}%</span></div>`;
  }
  return html + '</div>';
}

function _found(sim, st, ctx) {
  const cost = foundCost(st);
  const lack = Object.entries(cost).filter(([r, v]) => (sim.res[r] || 0) < v);
  const scan = spotsScan(sim);
  const spots = scan.list;

  let html = `<h4 class="group">Заложить город</h4>
    <div class="card"><div class="ttl"><span>Стоимость колонии</span><span class="cost">${_cost(cost)}</span></div>
      <div class="desc">Каждая следующая колония дороже в полтора раза. Дальше ${MIN_CITY_DIST} клеток от столицы и от других городов — ближе города душат друг друга.</div>
      <div class="kv"><span>Коррупция</span><span>первые 10 клеток бесплатно, дальше +1.5% за клетку, потолок ${Math.round(CORR_MAX * 100)}%</span></div>
      ${lack.length ? `<div class="reason">Не хватает: ${lack.map(([r, v]) => `${_icon(r)}${Math.ceil(v - (sim.res[r] || 0))}`).join(' ')}</div>` : '<div class="desc" style="color:var(--good)">Ресурсов на закладку хватает.</div>'}
    </div>`;

  if (!spots.length) {
    // Причина ровно одна и она разная: либо земля не годится, либо мы её просто
    // не видели. Совет во втором случае конкретный — вслепую город не заложить.
    const why = scan.fogged > 0
      ? `За околицей ${scan.fogged} ${_plural(scan.fogged, 'клетка ждёт', 'клетки ждут', 'клеток ждут')} разведки: вслепую город не заложить. Карту открывают жители и здания — ставьте постройки ближе к краю освоенного, и граница отодвинется. Каждый новый город открывает карту вокруг себя, поэтому колонии идут цепочкой.`
      : `Подходящей земли рядом нет: нужна проходимая клетка с пропитанием в ${FOOD_RADIUS} клетках вокруг и не ближе ${MIN_CITY_DIST} клеток к столице и другим городам.`;
    return html + `<div class="card"><div class="ttl"><span>Мест не найдено</span></div><div class="desc">${why}</div></div>`;
  }

  for (const s of spots) {
    const v = spotVerdict(s.score);
    const can = s.ok && !lack.length;
    html += `<div class="card"><div class="ttl"><span>Место ${s.x}:${s.y}</span>
        <span class="cost" style="color:${v.col}">${s.score}/100 · ${v.ru}</span></div>
      <div class="relbar"><div style="width:${s.score}%;background:${v.col}"></div></div>
      <div class="kv"><span>До столицы</span><span>${Math.round(s.dist)} кл. · коррупция ${Math.round(s.corr * 100)}% · содержание ${_g(s.upkeep)}🪙/день</span></div>
      <div class="kv"><span>Вокруг</span><span>${s.food} кормящих клеток${s.water ? ' · берег' : ''} · ${s.wood} лесных</span></div>
      ${s.camp ? `<div class="reason">В ${Math.round(s.camp.d)} клетках лагерь разбойников — караваны отсюда будут грабить чаще.</div>` : ''}
      <button class="btn primary" style="width:100%;margin-top:8px;padding:8px"
        data-emp="found:${s.x}:${s.y}"${can ? '' : ' disabled'}>Основать здесь${can ? '' : ' — ' + (lack.length ? 'нет ресурсов' : s.reason)}</button></div>`;
  }
  return html;
}

// Особые точки карты. Показываем только разведанное: интерфейс не имеет права
// знать больше игрока.
function _sites(sim, st, ctx) {
  if (!sim.sites) return '';
  const known = sim.sites.knownSites();
  const ruins = known.filter(s => s.kind === 'ruin');
  const camps = known.filter(s => s.kind === 'camp');
  const W = sim.empireWire || {};
  const cap = sim.sites.capital() || { x: ctx.capitalX, y: ctx.capitalY };

  let html = `<h4 class="group">Особые точки</h4>
    <div class="card"><div class="ttl"><span>Разведка</span><span class="cost">${Math.round(sim.sites.exploredFraction() * 100)}%</span></div>
      <div class="desc">Карта открывается там, где ходят жители и стоят здания. Что видели — помнится, что не видели — не показывается.</div>
      <div class="kv"><span>Найдено руин</span><span>${ruins.filter(s => !s.claimed).length} целых · ${ruins.filter(s => s.claimed).length} разграблено</span></div>
      <div class="kv"><span>Лагерей разбойников</span><span>${camps.length} рядом · ${W.campsCleared || 0} разорено</span></div>
      <div class="desc">За добычей в руины жители ходят сами, если те не дальше 18 клеток. Лагерь берут только штурмом — и он же шлёт налёты${sim.day < BANDIT.firstRaidDay ? `, начиная с ${BANDIT.firstRaidDay} дня` : ''}.</div></div>`;

  const open = ruins.filter(s => !s.claimed)
    .map(s => ({ s, d: Math.hypot(s.x - cap.x, s.y - cap.y) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, SITE_LIMIT);
  for (const { s, d } of open) {
    const def = SITE_DEFS[s.def];
    const loot = Object.entries(def.loot).map(([r, v]) => `${_icon(r)}${Math.round(v * s.rich)}`).join(' ');
    html += `<div class="card"><div class="ttl"><span>🏚 ${def.ru}</span><span class="cost">${loot}</span></div>
      <div class="desc">${def.desc} ${s.x}:${s.y}, ${Math.round(d)} кл. от столицы.</div></div>`;
  }

  const army = sim.armyPower();
  for (const s of camps) {
    const def = SITE_DEFS[s.def];
    const power = sim.sites.campPower(s, sim.eraIndex);
    const d = Math.hypot(s.x - cap.x, s.y - cap.y);
    const odds = army >= power * 1.15 ? { ru: 'штурм почти верный', col: 'var(--good)' }
      : army >= power ? { ru: 'силы равны — исход не гарантирован', col: 'var(--warn)' }
        : { ru: 'гарнизон сильнее — штурм отобьют', col: 'var(--bad)' };
    const losses = Math.ceil(power / 12);
    html += `<div class="card"><div class="ttl"><span>🏴 ${def.ru}</span><span class="cost" style="color:${odds.col}">гарнизон ${power}</span></div>
      <div class="desc">${s.x}:${s.y}, ${Math.round(d)} кл. от столицы${d <= BANDIT.raidRange ? ' — отсюда ходят в набеги' : ' — далеко, набегов не ждите'}. Совершено налётов: ${s.raids}.</div>
      <div class="kv"><span>Ваша армия</span><span style="color:${odds.col}">${Math.round(army)} · ${odds.ru}</span></div>
      <div class="kv"><span>Добыча</span><span>${Object.entries(def.loot).map(([r, v]) => `${_icon(r)}${v}`).join(' ')}</span></div>
      <button class="btn ${army >= power ? 'primary' : 'danger'}" style="width:100%;margin-top:8px;padding:8px"
        data-emp="assault:${s.id}"${army > 0 ? '' : ' disabled'}>Штурмовать${army > 0 ? ` — потери около ${losses} ${_plural(losses, 'бойца', 'бойцов', 'бойцов')}` : ' — армии нет'}</button></div>`;
  }
  return html;
}

// ═══════════════════════════ ДЕЙСТВИЯ ═══════════════════════════

// Разбор строки вида 'car:2:0:food:40'. Отдельная функция: вся проверка должна
// работать без DOM — и в тесте, и в консоли.
export function handleEmpireAction(sim, spec) {
  if (!sim || !sim.empire) return { ok: false, reason: 'Империя не подключена' };
  const parts = String(spec || '').split(':');
  const kind = parts[0];
  const W = sim.empireWire || { ui: {} };

  if (kind === 'sel') {
    const id = Number(parts[1]) || 0;
    W.ui.city = (W.ui.city === id) ? 0 : id;
    return { ok: true, sound: 'click', quiet: true };
  }

  if (kind === 'spec') {
    const r = sim.empire.setSpec(sim, Number(parts[1]), parts[2]);
    if (!r.ok) return r;
    return { ok: true, sound: 'click', text: `Специализация: ${r.ru}.` };
  }

  if (kind === 'build') {
    const r = sim.empire.build(sim, Number(parts[1]), parts[2]);
    if (!r.ok) return r;
    return { ok: true, sound: 'build', text: `Построено: ${r.ru}.` };
  }

  if (kind === 'found') {
    const x = Number(parts[1]), y = Number(parts[2]);
    const rep = spotReport(sim, x, y);
    if (!rep.ok) return { ok: false, reason: rep.reason };
    const r = sim.empire.found(sim, x, y);
    if (!r.ok) return r;
    // Новый город сразу открывает карту вокруг себя и становится выбранным:
    // первое, что захочет игрок, — дать ему специализацию.
    if (sim.sites) sim.sites.revealCircle(r.city.x, r.city.y, SIGHT.settlement + 2);
    W.ui.city = r.city.id;
    W.spots = { day: -1, cities: -1, list: [] };
    sim.addChronicle(`Основан город ${r.city.name}.`);
    return { ok: true, sound: 'build', text: `Основан ${r.city.name}!` };
  }

  if (kind === 'car') {
    const fromId = Number(parts[1]), toId = Number(parts[2]);
    const res = parts[3], amt = Number(parts[4]);
    if (!LOCAL_RES.includes(res)) return { ok: false, reason: 'Караван возит только еду и дерево' };
    const r = sendCaravan(sim.empire.state, sim.empire.ctxOf(sim), fromId, toId, { [res]: amt });
    if (!r.ok) return r;
    const to = toId === 0 ? 'столицу' : (cityById(sim.empire.state, toId) || { name: '—' }).name;
    sim.addLog(`🐫 Караван вышел в ${to}: ${amt}${_icon(res)}, в пути ${r.caravan.days} дн.`);
    return { ok: true, sound: 'click', text: `Караван вышел: ${amt}${_icon(res)} → ${to}` };
  }

  if (kind === 'assault') {
    if (!sim.sites) return { ok: false, reason: 'Карта точек не подключена' };
    const id = Number(parts[1]);
    const site = sim.sites.site(id);
    if (!site) return { ok: false, reason: 'Такой точки нет' };
    if (!sim.sites.isExplored(site.x, site.y)) return { ok: false, reason: 'Лагерь не разведан' };
    const army = sim.armyPower();
    if (army <= 0) return { ok: false, reason: 'Штурмовать некем: сначала обучите бойцов' };

    const r = sim.sites.assaultCamp(id, army, sim.eraIndex);
    if (!r.ok) return r;
    // Потери модуль считает сам, но списывает бойцов ядро — только оно знает,
    // сколько их вообще осталось.
    if (r.losses > 0) sim.army.soldiers = Math.max(0, sim.army.soldiers - r.losses);
    if (r.win) {
      for (const [res, v] of Object.entries(r.loot)) {
        sim.res[res] = Math.min(sim.resCap[res] ?? Infinity, (sim.res[res] || 0) + v);
      }
      if (W.campsCleared != null) W.campsCleared++;
      sim.addChronicle(`Разорён лагерь разбойников (${SITE_DEFS[site.def].ru}).`);
    }
    sim.addLog(r.text, r.win ? 'good' : 'bad');
    return { ok: true, sound: r.win ? 'coin' : 'raid', text: r.text };
  }

  return { ok: false, reason: 'Неизвестная операция' };
}

// Привязка обработчиков — по образцу bindMarketPanel: свои data-атрибуты в
// переданном корне, никаких обращений к document.
// opts: { toast(text,type), audio.play(name), refresh() }
export function bindEmpirePanel(root, sim, opts = {}) {
  if (!root || typeof root.querySelectorAll !== 'function' || !sim) return 0;
  let bound = 0;
  for (const el of Array.from(root.querySelectorAll('[data-emp]'))) {
    const spec = (el.dataset && el.dataset.emp) ||
      (typeof el.getAttribute === 'function' ? el.getAttribute('data-emp') : '');
    el.onclick = (ev) => {
      // Кнопки лежат ВНУТРИ карточки города, а у карточки свой обработчик
      // выбора. Без остановки всплытия каждый клик по кнопке ещё и схлопывал бы
      // карточку — панель дёргалась бы на любое действие.
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      const r = handleEmpireAction(sim, spec);
      if (!r.ok) {
        if (opts.toast) opts.toast(r.reason, 'warn');
        if (opts.audio) opts.audio.play('deny');
      } else {
        if (opts.toast && r.text && !r.quiet) opts.toast(r.text, 'good');
        if (opts.audio) opts.audio.play(r.sound || 'click');
      }
      if (opts.refresh) opts.refresh();
      return r;
    };
    bound++;
  }
  return bound;
}

// Короткие имена — те самые renderPanel/bindPanel из задания. В точках
// подключения используются длинные: в hud.js уже есть свой метод bindPanel.
export { renderEmpirePanel as renderPanel, bindEmpirePanel as bindPanel };

// ═══════════════════════ ФОРМАТИРОВАНИЕ ═══════════════════════

function _icon(res) { return RES_META[res] ? RES_META[res].icon : res; }

function _cost(cost) {
  return Object.entries(cost || {}).map(([r, v]) => `${_icon(r)}${v}`).join(' ') || '—';
}

function _goods(goods) {
  return Object.entries(goods || {}).map(([r, v]) => `${v}${_icon(r)}`).join(' ');
}

// Суммы: копейки важны на мелких, сотни золота — уже нет.
function _g(v) {
  if (!isFinite(v)) return '—';
  return Math.abs(v) >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1);
}

// Мелкие потоки: 0.08📜/день должно читаться как 0.08, а не как 0.
function _n(v) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 10) return String(Math.round(v));
  if (a >= 1) return (Math.round(v * 10) / 10).toFixed(1);
  return (Math.round(v * 100) / 100).toFixed(2);
}

// Знак пишем типографским минусом: «-16» в интерфейсе читается как дефис.
function _sign(v, fmt = _g) {
  if (!isFinite(v)) return '—';
  const r = Math.abs(v) < 0.005 ? 0 : v;
  return (r > 0 ? '+' : r < 0 ? '−' : '') + fmt(Math.abs(r));
}

// Почему город не растёт. Условия те же, что в tickEmpire: сыт, доволен, есть
// куда селиться. Без этой строки игрок видит только «1 житель» и не понимает,
// он сделал что-то не так или так и задумано.
function _growth(city, cap) {
  const why = [];
  if (city.happy <= 55) why.push(`счастье ${city.happy}% (нужно > 55)`);
  const need = city.pop * EAT_PER_POP;
  const fd = need > 0 ? city.local.food / need : 0;
  if (fd <= 5) why.push(`еды на ${Math.floor(fd)} дн. (нужно > 5)`);
  if (city.pop >= cap) why.push(`достигнут предел ${cap}${city.buildings.includes('granary') ? '' : ' (амбар даёт +10)'}`);
  return why.length ? 'нет: ' + why.join(', ') : 'да, примерно раз в неделю';
}

function _happyCol(h) {
  return h >= 55 ? 'var(--good)' : h >= UNREST_HAPPY ? 'var(--warn)' : 'var(--bad)';
}

function _plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/* ПОДКЛЮЧЕНИЕ

── app/src/core/simulation.js ──────────────────────────────────────────────

1) ЯКОРЬ (строка 7, единственная в файле):
import { installSystems, systemsNewDay, systemsFactions, systemsHappyMod, systemsWorkMult, systemsSerialize, systemsRestore } from './systems/integrate.js';
   ВСТАВИТЬ ПОСЛЕ:
import { installEmpire, empireNewDay, empireSerialize, empireRestore } from './systems/wire_empire.js';

2) ЯКОРЬ (в конструкторе Simulation, единственная в файле):
    installSystems(this);
   ВСТАВИТЬ ПОСЛЕ:
    installEmpire(this);

3) ЯКОРЬ (в onNewDay, единственная в файле):
    this.tickFactions();
   ВСТАВИТЬ ПОСЛЕ:
    empireNewDay(this);

4) ЯКОРЬ (в assignJob — две строки подряд, единственные в файле):
      if (spot) { v.job = 'deadfall'; v.target = { kind: 'deadfall', x: spot.x, y: spot.y }; return; }
    }
   ВСТАВИТЬ ПОСЛЕ:
    // Руины: припасы в развалинах лежат ничьи, пока за ними не сходят.
    if (this.sites) {
      const ruin = this.sites.nearestUnclaimedRuin(v.x, v.y, 18);
      if (ruin) { v.job = 'loot'; v.target = { kind: 'loot', siteId: ruin.id, x: ruin.x, y: ruin.y }; return; }
    }

5) ЯКОРЬ (в onArrive — блок целиком, единственный в файле):
    if (t.kind === 'work') {
      // занял рабочее место: смена 4 дня непрерывного производства
      v.atWork = true;
      v.shift = 4;
      return;
    }
   ВСТАВИТЬ ПОСЛЕ:
    if (t.kind === 'loot') {
      const r = this.sites ? this.sites.claimRuin(t.siteId) : { ok: false };
      if (r.ok) {
        for (const [k, val] of Object.entries(r.loot)) this.res[k] = Math.min(this.resCap[k] ?? 99999, this.res[k] + val);
        if (this.empireWire) this.empireWire.ruinsLooted++;
        this.toast(r.text, 'good');
      }
      this.release(v); return;
    }

6) ЯКОРЬ (в serialize, единственная в файле):
      sys: systemsSerialize(this),
   ВСТАВИТЬ ПОСЛЕ:
      empire: empireSerialize(this),

7) ЯКОРЬ (в deserialize, единственная в файле):
    systemsRestore(sim, data.sys);
   ВСТАВИТЬ ПОСЛЕ:
    empireRestore(sim, data.empire);

── app/src/ui/hud.js ───────────────────────────────────────────────────────

8) ЯКОРЬ (строка 6, единственная в файле):
import { renderMarketPanel, bindMarketPanel, createMarketPanelState } from './panel_market.js';
   ВСТАВИТЬ ПОСЛЕ:
import { renderEmpirePanel, bindEmpirePanel } from '../core/systems/wire_empire.js';

9) ЯКОРЬ (в массиве TABS, единственная в файле):
  { id: 'diplo', ru: 'Дипломатия', ic: '🤝' },
   ВСТАВИТЬ ПОСЛЕ:
  { id: 'empire', ru: 'Империя', ic: '🏙' },

10) ЯКОРЬ (метод панели рынка, единственная в файле):
  panel_market() { return renderMarketPanel(this.sim, this.marketState); }
   ВСТАВИТЬ ПОСЛЕ:
  panel_empire() { return renderEmpirePanel(this.sim); }

11) ЯКОРЬ (конец метода bindPanel — единственный такой блок в файле):
    bindMarketPanel(root, this.sim, {
      toast: (t, k) => this.toast(t, k),
      audio: this.audio,
      refresh: () => this.renderPanel(),
    });
   ВСТАВИТЬ ПОСЛЕ:
    bindEmpirePanel(root, this.sim, {
      toast: (t, k) => this.toast(t, k),
      audio: this.audio,
      refresh: () => this.renderPanel(),
    });

── ЧТО ДАЮТ ШАГИ ПООТДЕЛЬНОСТИ ─────────────────────────────────────────────

Шаги 1–3 и 8–11 — это вся империя: города, коррупция, специализации, караваны,
сепаратизм, а также туман войны, налёты лагерей и штурмы с панели.
Шаги 4–5 добавляют разграбление руин жителями: без них руины видны в панели,
но за добычей никто не идёт. Шаги 6–7 — сохранение; без них города и открытая
карта не переживут перезагрузку, всё остальное работает.

── НЕОБЯЗАТЕЛЬНО ───────────────────────────────────────────────────────────

12) Туман обновляется раз в сутки (внутри empireNewDay). Панели этого хватает,
    но для отрисовки на карте его лучше обновлять каждый кадр. Тогда в импорте
    шага 1 допишите empireFog, а в simulation.js, tickStep(dtDays), в КОНЦЕ
    метода — ЯКОРЬ (единственная в файле):
    this.toasts = this.toasts.filter(t => t.t > 0);
   ВСТАВИТЬ ПОСЛЕ:
    empireFog(this);

    Замер автора worldsites: обновление тумана < 0.5 мс на реальном составе
    наблюдателей, так что кадру это ничего не стоит.

13) Рендер (app/src/render/renderer.js), если дойдут руки:
      sim.sites.fog — Uint8Array по клеткам, 0 = чёрное, 1 = серое 55%, 2 = чисто;
      sim.sites.knownSites() — иконки руин и лагерей (s.kind: 'ruin' | 'camp');
      sim.empire.state.cities — города: {x, y, name, pop, spec};
      sim.empire.state.caravans — караваны в пути (from/to/daysLeft/days).
    Панель работает и без этого: города и точки перечислены в ней списком.
*/
