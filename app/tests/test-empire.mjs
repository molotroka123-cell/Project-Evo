// Тесты модуля нескольких городов (U12). Запуск: node app/tests/test-empire.mjs
import { createRng } from '../src/core/rng.js';
import { TILE } from '../src/core/data.js';
import { Simulation } from '../src/core/simulation.js';
import {
  createEmpire, genCityName, canFound, foundCity, foundCost, cityById,
  corruption, upkeepPerDay, setSpecialization, buildInCity, prodMult,
  cityHappiness, sendCaravan, robChance, tickEmpire, citySummary,
  serializeEmpire, deserializeEmpire, createEmpireSystem, distToCapital,
  MIN_CITY_DIST, CORR_FREE_DIST, CORR_PER_TILE, CORR_MAX, CARAVAN_SPEED,
  ROB_BASE, ROB_MAX, FOUND_COST, FOUND_COST_GROWTH, START_POP,
  UNREST_REVOLT, EAT_PER_POP, KEEP_DAYS, CARAVAN_CAP, SPECS,
} from '../src/core/systems/empire.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------- Вспомогательное ----------
// Плоский тестовый мир: та же структура {w,h,tiles}, что отдаёт generateWorld.
function makeWorld(fill = TILE.GRASS, w = 64, h = 64) {
  return { w, h, tiles: new Uint8Array(w * h).fill(fill), startX: 32, startY: 32 };
}
function setTile(world, x, y, tile) { world.tiles[y * world.w + x] = tile; }
function baseCtx(over = {}) {
  return { world: makeWorld(), capitalX: 32, capitalY: 32, day: 0, seasonIdx: 0, armyPower: 0, atWar: false, techs: [], ...over };
}
function makeCity(state, ctx, x, y, rng, spec = null) {
  const r = foundCity(state, ctx, x, y, rng, spec);
  if (!r.ok) throw new Error('город не основан: ' + r.reason);
  return r.city;
}
function runDays(state, ctxBase, rng, days, startDay = 1) {
  const reps = [];
  for (let i = 0; i < days; i++) reps.push(tickEmpire(state, { ...ctxBase, day: startDay + i }, rng));
  return reps;
}
// rng-заглушки для крайних случаев: караван всегда грабят / никогда не грабят
const alwaysRng = { next: () => 0, chance: (p) => p > 0, int: (a) => a, range: (a) => a, pick: (arr) => arr[0] };
const neverRng = { next: () => 0.9999, chance: () => false, int: (a) => a, range: (a) => a, pick: (arr) => arr[0] };

// ---------------------------------------------------------------- имена
t('U12 генератор имён: русские, детерминированные, уникальные', () => {
  const a = genCityName(createRng(7)), b = genCityName(createRng(7));
  ok(a === b, `один сид — одно имя, а вышло «${a}» и «${b}»`);
  ok(/^[А-ЯЁ][а-яё-]+$/.test(a), `имя не похоже на русское: «${a}»`);
  const used = new Set();
  const rng = createRng(3);
  for (let i = 0; i < 30; i++) {
    const name = genCityName(rng, used);
    ok(!used.has(name), `повтор имени на шаге ${i}: «${name}»`);
    used.add(name);
  }
  console.log(`   примеры: ${[...used].slice(0, 5).join(', ')}`);
});

// ---------------------------------------------------------------- пригодность места
t('U12 основание: вода, горы и голая пустыня непригодны', () => {
  const st = createEmpire();
  const ctx = baseCtx();
  setTile(ctx.world, 50, 32, TILE.WATER);
  ok(!canFound(st, ctx, 50, 32).ok, 'на воде город основался');
  ok(canFound(st, ctx, 50, 32).reason.includes('вода'), 'причина отказа не про воду');
  setTile(ctx.world, 50, 40, TILE.MOUNTAIN);
  ok(canFound(st, ctx, 50, 40).reason.includes('гор'), 'причина отказа не про горы');
  // пустыня: клетка проходима, но еды в радиусе нет
  const sand = baseCtx({ world: makeWorld(TILE.SAND) });
  const r = canFound(st, sand, 50, 32);
  ok(!r.ok && r.reason.includes('пропитания'), `пустыня прошла проверку: ${r.reason}`);
  ok(!canFound(st, ctx, 0, 0).ok, 'край карты прошёл проверку');
});

t('U12 основание: требование расстояния от столицы и других городов', () => {
  const st = createEmpire();
  const ctx = baseCtx();
  const close = canFound(st, ctx, 32 + MIN_CITY_DIST - 2, 32);
  ok(!close.ok && close.reason.includes('столице'), 'вплотную к столице разрешили');
  ok(canFound(st, ctx, 45, 32).ok, 'нормальная дистанция от столицы отвергнута');
  makeCity(st, ctx, 45, 32, createRng(1));
  const r = canFound(st, ctx, 50, 32);
  ok(!r.ok && r.reason.includes('городу'), 'вплотную к другому городу разрешили');
  ok(canFound(st, ctx, 45, 50).ok, 'дальняя точка от обоих отвергнута');
});

t('U12 основание: город создаётся с честными стартовыми полями', () => {
  const st = createEmpire();
  const ctx = baseCtx();
  const city = makeCity(st, ctx, 45, 32, createRng(1));
  ok(city.pop === START_POP, `стартовое население ${city.pop}, ждали ${START_POP}`);
  ok(city.local.food > 0 && city.local.wood > 0, 'переселенцы приехали без обоза');
  ok(city.name.length > 3, 'город безымянный');
  ok(near(distToCapital(city, ctx), 13), `расстояние посчитано неверно: ${distToCapital(city, ctx)}`);
  const bad = foundCity(st, ctx, 45, 50, createRng(1), 'nonsense');
  ok(!bad.ok, 'несуществующая специализация принята');
});

// ---------------------------------------------------------------- стоимость экспансии
t('U12 стоимость основания растёт с каждым городом', () => {
  const st = createEmpire();
  const c0 = foundCost(st);
  ok(c0.food === FOUND_COST.food && c0.gold === FOUND_COST.gold, 'базовая цена уехала');
  const ctx = baseCtx();
  makeCity(st, ctx, 45, 32, createRng(1));
  const c1 = foundCost(st);
  ok(c1.food === Math.ceil(FOUND_COST.food * FOUND_COST_GROWTH), `вторая колония: ${c1.food}, ждали ×${FOUND_COST_GROWTH}`);
  makeCity(st, ctx, 45, 50, createRng(2));
  const c2 = foundCost(st);
  ok(c2.food === Math.ceil(FOUND_COST.food * FOUND_COST_GROWTH ** 2), 'третья колония не подорожала квадратично');
});

// ---------------------------------------------------------------- коррупция
t('U12 коррупция: ноль вблизи, линейный рост, потолок, техи снижают', () => {
  const ctx = baseCtx();
  ok(corruption(CORR_FREE_DIST, ctx) === 0, 'в свободной зоне коррупция не ноль');
  ok(near(corruption(30, ctx), CORR_PER_TILE * 20, 1e-3), `d=30: ${corruption(30, ctx)}`);
  ok(corruption(20, ctx) < corruption(40, ctx), 'коррупция не растёт с расстоянием');
  ok(corruption(1000, ctx) === CORR_MAX, `потолок не сработал: ${corruption(1000, ctx)}`);
  const lawful = baseCtx({ techs: ['laws'] });
  ok(near(corruption(30, lawful), CORR_PER_TILE * 20 * 0.85, 1e-3), 'законы не снизили коррупцию');
  ok(upkeepPerDay(8) === 1 && upkeepPerDay(30) > upkeepPerDay(15), 'содержание не растёт с расстоянием');
});

t('U12 расстояние решает: дальний город приносит меньше и стоит дороже', () => {
  const mk = (x) => {
    const st = createEmpire();
    const ctx = baseCtx();
    makeCity(st, ctx, x, 32, createRng(1));
    return tickEmpire(st, { ...ctx, day: 1 }, neverRng);
  };
  const nearRep = mk(45);   // d=13
  const farRep = mk(62);    // d=30
  ok(farRep.shared.gold < nearRep.shared.gold, `дань: близко ${nearRep.shared.gold}, далеко ${farRep.shared.gold}`);
  ok(farRep.upkeep > nearRep.upkeep, `содержание: близко ${nearRep.upkeep}, далеко ${farRep.upkeep}`);
  console.log(`   d=13: дань ${nearRep.shared.gold}🪙 при содержании ${nearRep.upkeep}; d=30: ${farRep.shared.gold}🪙 при ${farRep.upkeep}`);
});

// ---------------------------------------------------------------- специализация
t('U12 специализация: аграрный +еда, но −золото', () => {
  const run = (spec) => {
    const st = createEmpire();
    const ctx = baseCtx();
    const city = makeCity(st, ctx, 44, 32, createRng(1), spec);
    const rep = tickEmpire(st, { ...ctx, day: 1 }, neverRng);
    return { city, rep };
  };
  const agr = run('agrarian'), plain = run(null);
  ok(agr.city.local.food > plain.city.local.food, 'аграрный не дал прибавки еды');
  ok(agr.rep.shared.gold < plain.rep.shared.gold, 'аграрный обязан терять в золоте');
  ok(near(prodMult(agr.city, 'food'), SPECS.agrarian.plus.food), 'множитель еды неверен');
  ok(near(prodMult(agr.city, 'gold'), SPECS.agrarian.minus.gold), 'штраф к золоту неверен');
  const sci = run('science');
  ok(sci.rep.shared.knowledge > plain.rep.shared.knowledge, 'научный не дал прибавки знаний');
  // смена специализации игроком
  const st = createEmpire();
  const city = makeCity(st, baseCtx(), 44, 32, createRng(1));
  ok(setSpecialization(st, city.id, 'trade').ok && city.spec === 'trade', 'смена специализации не сработала');
  ok(!setSpecialization(st, city.id, 'x').ok, 'мусорная специализация принята');
});

// ---------------------------------------------------------------- общее и местное
t('U12 правило общего/местного: золото и знания — в казну, еда и дерево — на складе', () => {
  const st = createEmpire();
  const ctx = baseCtx();
  const city = makeCity(st, ctx, 44, 32, createRng(1));
  const food0 = city.local.food;
  const rep = tickEmpire(st, { ...ctx, day: 1 }, neverRng);
  ok(rep.shared.gold > 0 && rep.shared.knowledge > 0, 'город не отправил дань в казну');
  ok(rep.shared.food === undefined, 'еда попала в общий уровень — нарушение правила');
  ok(city.local.food !== food0, 'местная еда не изменилась за день');
  ok(rep.toCapital.food === 0, 'еда телепортировалась в столицу без каравана');
  // караван с золотом запрещён — золото и так общее
  const r = sendCaravan(st, ctx, city.id, 0, { gold: 10 });
  ok(!r.ok && r.reason.includes('общие'), 'караван с золотом прошёл');
});

// ---------------------------------------------------------------- караваны
t('U12 караван: время в пути от расстояния, груз доезжает до столицы', () => {
  const st = createEmpire();
  const ctx = baseCtx();
  const city = makeCity(st, ctx, 52, 32, createRng(1)); // d=20 → 5 дней пути
  city.local.food = 150; // излишек сверх запаса на KEEP_DAYS дней
  const reps = runDays(st, ctx, neverRng, 8);
  ok(st.caravans.length > 0 || reps.some(r => r.arrived.length), 'караван вообще не отправился');
  const firstCar = reps[0].events.find(e => e.text.includes('караван'));
  ok(firstCar, 'нет события отправки каравана');
  const expectDays = Math.ceil(20 / CARAVAN_SPEED);
  ok(firstCar.text.includes(`${expectDays} дн`), `время в пути не ${expectDays} дн.: ${firstCar.text}`);
  for (let i = 0; i < expectDays; i++) ok(reps[i].toCapital.food === 0, `груз доехал раньше срока, день ${i + 1}`);
  const expectLoad = Math.min(CARAVAN_CAP, Math.floor(150 - START_POP * EAT_PER_POP * KEEP_DAYS));
  ok(reps[expectDays].toCapital.food === expectLoad, `прибыло ${reps[expectDays].toCapital.food}🍞, ждали ${expectLoad}`);
  console.log(`   d=20 → ${expectDays} дн. пути, груз ${expectLoad}🍞, шанс грабежа ${reps[expectDays].arrived[0]?.rob ?? '—'}`);
});

t('U12 шанс ограбления: расстояние, война, армия, гарнизон', () => {
  const ctx = baseCtx();
  ok(near(robChance(5, ctx), ROB_BASE * 5, 1e-3), `база за 5 дней: ${robChance(5, ctx)}`);
  ok(robChance(2, ctx) < robChance(6, ctx), 'длинный маршрут не опаснее короткого');
  ok(robChance(9999, ctx) === ROB_MAX, 'потолок шанса не сработал');
  ok(near(robChance(5, baseCtx({ atWar: true })), ROB_BASE * 5 * 2, 1e-3), 'война не удвоила риск');
  ok(robChance(5, baseCtx({ armyPower: 80 })) < robChance(5, ctx), 'армия не охраняет пути');
  const fort = { spec: 'military', buildings: [] };
  ok(near(robChance(5, ctx, fort), ROB_BASE * 5 * 0.5, 1e-3), 'военный город не прикрыл караван');
});

t('U12 ограбление: при плохом броске груз пропадает', () => {
  const st = createEmpire();
  const ctx = baseCtx();
  const city = makeCity(st, ctx, 44, 32, createRng(1)); // d=12 → 3 дня пути
  const r = sendCaravan(st, { ...ctx, day: 1 }, city.id, 0, { food: 25 });
  ok(r.ok && r.caravan.rob > 0, 'караван не создан или риск нулевой');
  ok(r.caravan.days === 3, `время в пути ${r.caravan.days}, ждали 3`);
  ok(city.local.food === 5, `склад не списан: ${city.local.food}`);
  const reps = runDays(st, ctx, alwaysRng, 4, 1);
  const robbedDay = reps.findIndex(rep => rep.robbed.length > 0);
  ok(robbedDay === 3, `ограбление не в день прибытия: индекс ${robbedDay}`);
  ok(reps.every(rep => rep.toCapital.food === 0), 'ограбленный груз доехал до столицы');
  ok(reps[3].events.some(e => e.text.includes('ограблен')), 'нет события об ограблении');
  // валидации
  ok(!sendCaravan(st, ctx, city.id, 0, { food: 9999 }).ok, 'караван увёз больше, чем на складе');
  ok(!sendCaravan(st, ctx, 777, 0, { food: 5 }).ok, 'несуществующий отправитель прошёл');
});

// ---------------------------------------------------------------- голод и счастье
t('U12 зима без запасов: голод, убыль населения, падение счастья', () => {
  const st = createEmpire();
  const ctx = baseCtx({ seasonIdx: 3 }); // зимой поля не родят
  const city = makeCity(st, ctx, 44, 32, createRng(1));
  city.local.food = 0;
  const rep = tickEmpire(st, { ...ctx, day: 1 }, neverRng);
  ok(city.pop === START_POP - 1, `голод не убил: население ${city.pop}`);
  ok(rep.events.some(e => e.text.includes('Голод')), 'нет события о голоде');
  ok(city.happy < 35, `счастье не упало: ${city.happy}`);
  // летом тот же город с едой живёт нормально
  const st2 = createEmpire();
  const c2 = makeCity(st2, baseCtx(), 44, 32, createRng(1));
  tickEmpire(st2, { ...baseCtx(), day: 1 }, neverRng);
  ok(c2.pop === START_POP && c2.happy >= 50, `сытый город несчастен: pop ${c2.pop}, happy ${c2.happy}`);
});

// ---------------------------------------------------------------- сепаратизм
t('U12 восстание: дальний голодный город отделяется, ближний — терпит', () => {
  const mk = (x) => {
    const st = createEmpire();
    const ctx = baseCtx({ seasonIdx: 3 });
    const city = makeCity(st, ctx, x, 32, createRng(1));
    city.local.food = 0;
    const reps = runDays(st, ctx, neverRng, 18);
    return { st, reps };
  };
  const far = mk(60);   // d=28: коррупция давит счастье, недовольство копится быстро
  const revoltDay = far.reps.findIndex(r => r.revolted.length > 0);
  ok(revoltDay >= 4 && revoltDay <= 17, `дальний город не восстал за 18 дней (день ${revoltDay})`);
  ok(far.st.cities.length === 0 && far.st.lost.length === 1, 'восставший город не покинул империю');
  const warnDay = far.reps.findIndex(r => r.events.some(e => e.text.includes('сепаратизм')));
  ok(warnDay >= 0 && warnDay < revoltDay, 'предупреждение не пришло до восстания');
  const nearCity = mk(44); // d=12: так же голодно, но столица рядом — бунт зреет медленно
  ok(nearCity.reps.every(r => r.revolted.length === 0), 'ближний город восстал так же быстро — расстояние не влияет');
  console.log(`   d=28: бунт на день ${revoltDay + 1}, предупреждение на день ${warnDay + 1}; d=12 за 18 дней — терпит`);
});

// ---------------------------------------------------------------- городские постройки
t('U12 постройки: дерево со склада, золото из казны, эффект работает', () => {
  const st = createEmpire();
  const ctx = baseCtx();
  const city = makeCity(st, ctx, 44, 32, createRng(1));
  city.local.wood = 100;
  const r = buildInCity(st, city.id, 'market', 50);
  ok(r.ok && r.goldSpent === 25, 'рынок не построился или золото не то');
  ok(city.local.wood === 75, `дерево не списано со склада: ${city.local.wood}`);
  ok(!buildInCity(st, city.id, 'market', 500).ok, 'второй рынок в одном городе разрешён');
  ok(!buildInCity(st, city.id, 'school', 5).ok, 'школа построилась без золота в казне');
  ok(near(prodMult(city, 'gold'), 1.4), 'рынок не ускорил золото');
  ok(cityHappiness(city, ctx) > 0, 'счастье сломалось после постройки');
});

// ---------------------------------------------------------------- сейв и детерминизм
t('U12 сериализация: круговой обход и детерминизм после загрузки', () => {
  const scenario = (rng) => {
    const st = createEmpire();
    const ctx = baseCtx();
    makeCity(st, ctx, 45, 32, rng, 'trade');
    const far = makeCity(st, ctx, 45, 50, rng, 'agrarian');
    far.local.food = 120;
    runDays(st, ctx, rng, 6);
    return { st, ctx };
  };
  const a = scenario(createRng(11));
  const snapA = JSON.stringify(serializeEmpire(a.st));
  const b = scenario(createRng(11));
  ok(snapA === JSON.stringify(serializeEmpire(b.st)), 'один сид дал разные империи — детерминизм сломан');
  // круговой обход через JSON (как настоящий сейв)
  const restored = deserializeEmpire(JSON.parse(snapA));
  ok(JSON.stringify(serializeEmpire(restored)) === snapA, 'сейв-лоад изменил состояние');
  ok(restored.caravans.length === a.st.caravans.length, 'караваны потерялись при загрузке');
  // после загрузки жизнь продолжается идентично
  const r1 = runDays(a.st, a.ctx, createRng(99), 4, 7);
  const r2 = runDays(restored, b.ctx, createRng(99), 4, 7);
  ok(JSON.stringify(serializeEmpire(a.st)) === JSON.stringify(serializeEmpire(restored)),
    'после загрузки симуляция разошлась с оригиналом');
  ok(JSON.stringify(r1.map(r => r.shared)) === JSON.stringify(r2.map(r => r.shared)), 'отчёты разошлись');
  ok(deserializeEmpire(null).cities.length === 0, 'пустой сейв не дал чистую империю');
});

// ---------------------------------------------------------------- сводка и повторный тик
t('U12 сводка города и защита от двойного тика', () => {
  const st = createEmpire();
  const ctx = baseCtx();
  const city = makeCity(st, ctx, 62, 32, createRng(1));
  const s = citySummary(city, ctx);
  ok(near(s.dist, 30) && s.corr > 0 && s.upkeep > 1, `сводка врёт: d=${s.dist}, corr=${s.corr}`);
  ok(s.specRu.length > 0 && s.local.food >= 0, 'в сводке нет полей для панели');
  const r1 = tickEmpire(st, { ...ctx, day: 1 }, neverRng);
  const r2 = tickEmpire(st, { ...ctx, day: 1 }, neverRng); // тот же день повторно
  ok(r1.shared.gold > 0 && r2.shared.gold === 0, 'двойной тик в один день удвоил дань');
});

// ---------------------------------------------------------------- интеграция с ядром
t('U12 интеграция: createEmpireSystem работает с настоящей Simulation', () => {
  const sim = new Simulation(42);
  sim.res.food = 500; sim.res.wood = 500; sim.res.gold = 500;
  const emp = createEmpireSystem();
  // ищем первое пригодное место на реальной карте
  let spot = null;
  for (let y = 1; y < sim.world.h - 1 && !spot; y++) {
    for (let x = 1; x < sim.world.w - 1 && !spot; x++) {
      if (canFound(emp.state, emp.ctxOf(sim), x, y).ok) spot = { x, y };
    }
  }
  ok(spot, 'на реальной карте не нашлось места под город');
  const goldBefore = sim.res.gold;
  const r = emp.found(sim, spot.x, spot.y, 'trade');
  ok(r.ok, `город не основан: ${r.reason}`);
  ok(sim.res.gold === goldBefore - FOUND_COST.gold, 'стоимость основания не списана');
  ok(sim.log.some(l => l.text.includes('Основан город')), 'нет записи в журнале');
  for (let i = 0; i < 5; i++) { sim.day++; emp.onNewDay(sim); }
  ok(emp.state.cities.length === 1 && emp.state.cities[0].pop >= 1, 'город умер за 5 дней');
  ok(Number.isFinite(sim.res.gold) && Number.isFinite(sim.res.knowledge), 'ресурсы ядра сломаны');
  ok(emp.lastReport && emp.lastReport.cities.length === 1, 'отчёт для HUD не собрался');
  const save = emp.serialize();
  const emp2 = createEmpireSystem();
  emp2.deserialize(JSON.parse(JSON.stringify(save)));
  ok(emp2.state.cities[0].name === emp.state.cities[0].name, 'сейв системы потерял город');
  console.log(`   город «${emp.state.cities[0].name}» на (${spot.x},${spot.y}), d=${Math.round(distToCapital(emp.state.cities[0], emp.ctxOf(sim)))}`);
});

console.log(`=== ${pass} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
