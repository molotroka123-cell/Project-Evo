// Тесты цепочек производства (U11) и торговых путей (U17).
// Запуск: node app/tests/test-production.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../src/core/simulation.js';
import { createRng } from '../src/core/rng.js';
import { WALKABLE, BUILDINGS } from '../src/core/data.js';
import {
  createProduction, tickProduction, chainStatus, stockOf, registerChain, chainById,
  stageCapacity, countBuildings, routeClass, maxRoutes, planRoute, addRoute, removeRoute,
  tickRoutes, tripGold, routeInfo, routePoints, caravanPos,
  serializeProduction, deserializeProduction,
  CHAINS, INTERMEDIATES, EXTRA_BUILDINGS, ROAD_CLASSES, TRADE,
} from '../src/core/systems/production.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// Здание в том виде, в каком его видит модуль (done, не разрушено).
const bld = (id, n = 1) => Array.from({ length: n }, (_, i) => ({ id, x: i, y: 0, done: true, destroyed: false }));
const world1 = () => ({ res: { food: 0, wood: 500, stone: 0, steel: 0, gold: 0, knowledge: 0 }, resCap: { food: 9999, wood: 400, stone: 400, steel: 500, gold: 99999, knowledge: 99999 } });

// Прогон N дней: возвращает накопленные дельты ресурсов ядра.
function run(state, buildings, days, extra = {}) {
  const w = extra.world || world1();
  const total = { food: 0, wood: 0, steel: 0 };
  for (let d = 0; d < days; d++) {
    const r = tickProduction(state, { buildings, days: 1, res: w.res, resCap: w.resCap, seasonIdx: extra.seasonIdx ?? 0, mult: extra.mult });
    for (const [k, v] of Object.entries(r.res)) {
      total[k] = (total[k] || 0) + v;
      w.res[k] = Math.max(0, Math.min(w.resCap[k] ?? 99999, (w.res[k] ?? 0) + v));
    }
  }
  return { total, res: w.res };
}

console.log('═══ U11: цепочки производства ═══');

t('таблица цепочек валидна: исполнители существуют, ресурсы объявлены', () => {
  ok(CHAINS.length >= 2, 'цепочек меньше двух');
  const known = new Set([...INTERMEDIATES.map(i => i.id), 'food', 'wood', 'stone', 'steel', 'gold', 'knowledge']);
  for (const c of CHAINS) {
    for (const st of c.stages) {
      for (const p of st.by) ok(BUILDINGS[p.b] || EXTRA_BUILDINGS[p.b], `нет здания ${p.b}`);
      for (const r of Object.keys(st.out)) ok(known.has(r), `неизвестный продукт ${r}`);
      for (const r of Object.keys(st.in || {})) ok(known.has(r), `неизвестное сырьё ${r}`);
    }
  }
  ok(INTERMEDIATES.length === 3, `промежуточных ресурсов должно быть 3, а не ${INTERMEDIATES.length}`);
  console.log(`   цепочек: ${CHAINS.map(c => c.ru).join(', ')}; новые ресурсы: ${INTERMEDIATES.map(i => i.ru).join(', ')}`);
});

t('ни одно здание не производит свой ресурс дважды (нет двойного счёта с ядром)', () => {
  for (const c of CHAINS) {
    for (const st of c.stages) {
      for (const p of st.by) {
        const def = BUILDINGS[p.b];
        if (!def || !def.out) continue;
        for (const r of Object.keys(st.out)) {
          ok(def.out[r] == null, `${p.b} даёт ${r} и в ядре, и в цепочке — двойной счёт`);
        }
      }
    }
  }
});

t('U11 полная цепочка ХЛЕБ за 40 дней: поле → мельница → пекарня', () => {
  const st = createProduction();
  const b = [...bld('farm'), ...bld('mill'), ...bld('bakery')];
  const snap = [];
  const w = world1();
  const tot = { grain: 0, flour: 0 };
  for (let d = 1; d <= 40; d++) {
    const r = tickProduction(st, { buildings: b, days: 1, res: w.res, resCap: w.resCap, seasonIdx: 0 });
    w.res.food += r.res.food || 0;
    tot.grain += r.gained.grain || 0; tot.flour += r.gained.flour || 0;
    if (d % 10 === 0) snap.push(`день ${d}: собрано ${tot.grain.toFixed(1)}🌾 → смолото ${tot.flour.toFixed(1)}🥣 → испечено ${w.res.food.toFixed(1)}🍞 (на складе зерна ${st.stock.grain.toFixed(2)})`);
  }
  for (const s of snap) console.log('   ' + s);
  ok(w.res.food > 55 && w.res.food < 90, `выход хлеба неправдоподобен: ${w.res.food}`);
  ok(tot.grain > 0 && tot.flour > 0, 'сырьё не движется по цепочке');
  near(tot.flour, tot.grain / 1.5, 0.1, 'помол не соответствует таблице цепочки');
  near(w.res.food, tot.flour * 2.4, 0.1, 'выпечка не соответствует таблице цепочки');
  console.log(`   итог: ${(w.res.food / 40).toFixed(2)}🍞/день с одного поля (узкое место — поле)`);
});

t('U11 полная цепочка СТАЛЬ за 40 дней: шахта → плавильня (дрова как топливо)', () => {
  const st = createProduction();
  const b = [...bld('mine'), ...bld('smelter')];
  const w = world1();
  const r = run(st, b, 40, { world: w });
  console.log(`   за 40 дней: +${r.total.steel.toFixed(1)}⚙️, дров сожжено ${(-r.total.wood).toFixed(1)}🪵, руды на складе ${st.stock.ore.toFixed(1)}`);
  near(r.total.steel, 40 * 0.5, 1.5, 'сталь не по расчёту (шахта 1.0 руды → плавка 0.625 прогона × 0.8)');
  ok(r.total.wood < 0, 'плавильня не тратит дрова');
  near(-r.total.wood, r.total.steel * 0.625, 0.5, 'расход дров не соответствует плавке');
});

t('U11 тупика нет: без переработчика добыча идёт, сырьё копится до потолка', () => {
  const st = createProduction();
  const w = world1();
  const r = run(st, bld('mine'), 400, { world: w });
  ok(r.total.steel === undefined || r.total.steel === 0, 'сталь появилась без плавильни');
  ok(r.total.wood === 0, 'дрова горят без плавильни');
  const cap = INTERMEDIATES.find(i => i.id === 'ore').cap;
  near(st.stock.ore, cap, 1e-6, 'руда не упёрлась в потолок склада');
  const stored = st.stock.ore;
  // Ставим плавильню — накопленное немедленно идёт в дело.
  const r2 = run(st, [...bld('mine'), ...bld('smelter')], 10, { world: w });
  ok(r2.total.steel > 4, `после постройки плавильни сталь не пошла: ${r2.total.steel}`);
  console.log(`   400 дней без плавильни: руда ${stored.toFixed(0)} (потолок ${cap}), стали 0; +10 дней с плавильней: +${r2.total.steel.toFixed(1)}⚙️`);
});

t('U11 запасной исполнитель: без Пекарни печёт Амбар, но вчетверо медленнее', () => {
  const full = createProduction(), fallback = createProduction();
  const a = run(full, [...bld('farm', 3), ...bld('mill'), ...bld('bakery')], 30);
  const c = run(fallback, [...bld('farm', 3), ...bld('mill'), ...bld('granary')], 30);
  ok(c.total.food > 0, 'без пекарни хлеба нет вообще — это тупик');
  ok(a.total.food > c.total.food * 2, `пекарня не быстрее амбара: ${a.total.food} vs ${c.total.food}`);
  console.log(`   пекарня ${a.total.food.toFixed(1)}🍞 / амбар ${c.total.food.toFixed(1)}🍞 за 30 дней`);
});

t('U11 склад продукта полон — сырьё не жжётся', () => {
  const st = createProduction();
  st.stock.ore = 100;
  const w = { res: { steel: 500, wood: 500 }, resCap: { steel: 500, wood: 400 } };
  const r = tickProduction(st, { buildings: [...bld('mine'), ...bld('smelter')], days: 1, res: w.res, resCap: w.resCap });
  near(st.stock.ore, 101, 1e-6, 'руда израсходована в полный склад стали');
  ok(!r.res.wood, 'дрова сожжены впустую');
});

t('U11 узкое место называется правильно и сдвигается при развитии', () => {
  const st = createProduction();
  const one = chainStatus(st, { buildings: [...bld('farm'), ...bld('mill'), ...bld('bakery')] }).find(c => c.id === 'bread');
  ok(one.bottleneck === 'grain_grow', `узкое место должно быть поле, а не ${one.bottleneck}`);
  const many = chainStatus(st, { buildings: [...bld('farm', 4), ...bld('mill'), ...bld('bakery')] }).find(c => c.id === 'bread');
  ok(many.bottleneck !== 'grain_grow', 'четыре поля не сняли ограничение по зерну');
  ok(many.output > one.output, 'выход не вырос');
  const none = chainStatus(st, { buildings: bld('farm') }).find(c => c.id === 'bread');
  ok(none.output === 0 && none.stages[1].note, 'отсутствие мельницы не объяснено игроку');
  console.log(`   1 поле: ${one.output.toFixed(2)}🍞/день (узко: ${one.ru}/${one.bottleneck}); 4 поля: ${many.output.toFixed(2)}🍞/день (узко: ${many.bottleneck})`);
  console.log(`   без мельницы: «${none.stages[1].note}»`);
});

t('U11 зима останавливает поля, но не шахты', () => {
  const winter = createProduction();
  run(winter, [...bld('farm'), ...bld('mine')], 10, { seasonIdx: 3 });
  ok(winter.stock.grain === 0, 'зерно растёт зимой');
  ok(winter.stock.ore > 9, 'шахта встала зимой');
});

t('U11 множители ядра (погода, промышленность) доходят до цепочек', () => {
  const a = createProduction(), b = createProduction();
  run(a, [...bld('mine'), ...bld('smelter')], 10);
  run(b, [...bld('mine'), ...bld('smelter')], 10, { mult: { gather: 2, industry: 2 } });
  ok(b.stock.ore + 1e-9 >= a.stock.ore, 'множитель gather не применился');
  const sa = run(createProduction(), [...bld('mine'), ...bld('smelter')], 10).total.steel;
  const sb = run(createProduction(), [...bld('mine'), ...bld('smelter')], 10, { mult: { gather: 2, industry: 2 } }).total.steel;
  ok(sb > sa * 1.5, `удвоенная промышленность дала ${sb} вместо ~${sa * 2}`);
  console.log(`   базово ${sa.toFixed(1)}⚙️ за 10 дней, при ×2 добыче и ×2 промышленности ${sb.toFixed(1)}⚙️`);
});

console.log('═══ U11: обратная совместимость с ядром ═══');

t('баланс ядра не меняется: та же партия с модулем и без него', () => {
  const build = (seed) => {
    const s = new Simulation(seed);
    s.godmode = true; s.execCommand('unlockall');
    // Ставим готовыми: тест про экономику, а не про стройку.
    for (const id of ['farm', 'mine']) {
      outer: for (let yy = 40; yy < 60; yy++) for (let xx = 40; xx < 60; xx++) {
        if (s.canPlace(id, xx, yy).ok) { s.placeFree(id, xx, yy); break outer; }
      }
    }
    return s;
  };
  const plain = build(42), withMod = build(42);
  const st = createProduction();
  for (let d = 0; d < 60; d++) {
    plain.tick(1);
    withMod.tick(1);
    tickProduction(st, {
      buildings: withMod.buildings, days: 1, seasonIdx: withMod.seasonIdx,
      res: withMod.res, resCap: withMod.resCap,
    });
  }
  for (const r of ['food', 'wood', 'stone', 'steel', 'gold']) {
    near(withMod.res[r], plain.res[r], 1e-9, `ресурс ${r} разошёлся`);
  }
  ok(withMod.villagers.length === plain.villagers.length, 'население разошлось');
  ok(st.stock.grain > 0 || st.stock.ore > 0, 'модуль вообще ничего не добыл');
  console.log(`   60 дней: еда ${plain.res.food.toFixed(2)} = ${withMod.res.food.toFixed(2)}; сверх того на складе зерно ${st.stock.grain.toFixed(1)}, руда ${st.stock.ore.toFixed(1)}`);
});

console.log('═══ U17: торговые пути ═══');

// Общая песочница: реальный мир, реальные фракции, реальный aStar.
const sim = new Simulation(42);
sim.godmode = true; sim.execCommand('unlockall');
const camp = sim.buildings.find(b => b.id === 'campfire');
const target = sim.factions[0];
const ctx17 = () => ({
  world: sim.world, days: 1, rng: sim.rng, day: sim.day,
  techs: sim.techs, buildings: sim.buildings, factions: sim.factions,
  relations: sim.relations, wars: [],
});

t('U17 маршрут строится через aStar и лежит по проходимым клеткам', () => {
  const st = createProduction();
  outer: for (let yy = 40; yy < 60; yy++) for (let xx = 40; xx < 60; xx++) {
    if (sim.canPlace('market', xx, yy).ok) { sim.placeFree('market', xx, yy); break outer; }
  }
  const r = addRoute(st, ctx17(), { faction: target.id, from: { x: camp.x, y: camp.y }, to: target.settlements[0] });
  ok(r.ok, 'маршрут не проложен: ' + r.reason);
  const pts = routePoints(r.route);
  ok(pts.length > 5, 'путь подозрительно короткий');
  for (const p of pts) ok(WALKABLE.has(sim.world.tiles[p.y * sim.world.w + p.x]), `путь идёт по непроходимой клетке ${p.x},${p.y}`);
  for (let i = 1; i < pts.length; i++) {
    ok(Math.max(Math.abs(pts[i].x - pts[i - 1].x), Math.abs(pts[i].y - pts[i - 1].y)) === 1, 'разрыв в пути');
  }
  const info = routeInfo(r.route, ctx17());
  console.log(`   ${info.name}: ${pts.length} клеток, длина ${info.length.toFixed(1)}, дорога «${info.road}», рейс ${info.tripDays.toFixed(1)} дн, ${info.goldPerTrip.toFixed(1)}🪙 за рейс`);
});

t('U17 без Рынка и без Торговли маршрута нет, причина по-русски', () => {
  const bare = new Simulation(7);
  const st = createProduction();
  const c = { world: bare.world, techs: bare.techs, buildings: bare.buildings };
  const a = addRoute(st, c, { faction: 'guild', from: { x: 48, y: 48 }, to: { x: 60, y: 60 } });
  ok(!a.ok && /Рынок/.test(a.reason), 'нет отказа без рынка: ' + a.reason);
  bare.godmode = true; bare.execCommand('unlockall');
  const p = planRoute(st, { world: bare.world, techs: new Set() }, { from: { x: 48, y: 48 }, to: { x: 60, y: 60 } });
  ok(!p.ok && /Торговля/.test(p.reason), 'нет отказа без технологии: ' + p.reason);
  const close = planRoute(st, { world: bare.world, techs: bare.techs }, { from: { x: 48, y: 48 }, to: { x: 49, y: 49 } });
  ok(!close.ok && /близко/.test(close.reason), 'близкий «путь» принят: ' + close.reason);
});

t('U17 класс дороги растёт с технологиями и ускоряет караван', () => {
  const st = createProduction();
  const plan = planRoute(st, ctx17(), { faction: target.id, from: { x: camp.x, y: camp.y }, to: target.settlements[0] });
  ok(plan.ok, plan.reason);
  const table = [];
  let prev = 0;
  for (const set of [[], ['wheel'], ['wheel', 'construction'], ['wheel', 'construction', 'railroads']]) {
    const c = { ...ctx17(), techs: new Set(['trade', ...set]), buildings: sim.buildings.filter(b => b.id !== 'train_station') };
    const cls = routeClass(c);
    const info = routeInfo(plan.route, c);
    table.push(`техи [${set.join(', ') || '—'}] → ${cls.ru}: ${info.tripDays.toFixed(1)} дн/рейс, ${info.goldPerDay.toFixed(2)}🪙/день`);
    ok(info.goldPerDay >= prev, 'класс дороги не улучшил доход');
    prev = info.goldPerDay;
  }
  // Рельсы без вокзала не считаются: техника есть, станции нет.
  const noStation = routeClass({ techs: new Set(['trade', 'railroads']), buildings: [] });
  ok(noStation.id !== 'rail', 'рельсы работают без вокзала');
  const withStation = routeClass({ techs: new Set(['trade', 'railroads']), buildings: bld('train_station') });
  ok(withStation.id === 'rail', 'вокзал не включил рельсы');
  for (const l of table) console.log('   ' + l);
});

t('U17 доход зависит от длины пути', () => {
  const st = createProduction();
  const c = ctx17();
  const short = { faction: 'a', length: 12, avgCost: 1, path: [] };
  const long = { faction: 'a', length: 40, avgCost: 1, path: [] };
  const gs = tripGold(short, c), gl = tripGold(long, c);
  ok(gl > gs * 3, `дальний путь платит не больше: ${gs.toFixed(2)} vs ${gl.toFixed(2)}`);
  console.log(`   рейс на 12 клеток ${gs.toFixed(2)}🪙, на 40 клеток ${gl.toFixed(2)}🪙 (надбавка за дальность)`);
});

t('U17 караван ходит и приносит золото; 120 дней на реальной карте', () => {
  const st = createProduction();
  const r = addRoute(st, ctx17(), { faction: target.id, from: { x: camp.x, y: camp.y }, to: target.settlements[0] });
  ok(r.ok, r.reason);
  let gold = 0;
  const seen = new Set();
  for (let d = 0; d < 120; d++) {
    const res = tickRoutes(st, ctx17());
    gold += res.gold;
    for (const e of res.events) seen.add(e.type);
    ok(r.route.pos >= -1e-6 && r.route.pos <= r.route.length + 1e-6, 'караван вылетел за пределы пути');
  }
  ok(r.route.trips >= 2, `за 120 дней всего ${r.route.trips} рейсов`);
  ok(gold > 0 && Math.abs(gold - st.tradeGold) < 1e-9, 'учёт золота разъехался');
  ok(seen.has('trip'), 'нет событий о прибытии каравана');
  const pos = caravanPos(r.route);
  ok(pos.x >= 0 && pos.y >= 0, 'позиция каравана не считается');
  console.log(`   рейсов ${r.route.trips}, доход ${gold.toFixed(1)}🪙 (${(gold / 120).toFixed(2)}🪙/день), караван сейчас в (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`);
});

t('U17 война рвёт путь, мир — восстанавливает', () => {
  const st = createProduction();
  const r = addRoute(st, ctx17(), { faction: target.id, from: { x: camp.x, y: camp.y }, to: target.settlements[0] });
  ok(r.ok, r.reason);
  for (let d = 0; d < 10; d++) tickRoutes(st, ctx17());
  const posBefore = r.route.pos, tripsBefore = r.route.trips;
  const war = { ...ctx17(), wars: [{ fid: target.id, ws: 0 }] };
  const first = tickRoutes(st, war);
  ok(first.events.some(e => e.type === 'broken' && /Война/.test(e.text)), 'война не порвала путь');
  let warGold = 0;
  for (let d = 0; d < 30; d++) warGold += tickRoutes(st, war).gold;
  ok(warGold === 0, `во время войны накапало ${warGold}🪙`);
  near(r.route.pos, posBefore, 1e-9, 'караван двигался во время войны');
  ok(r.route.trips === tripsBefore, 'рейсы засчитывались во время войны');
  const back = tickRoutes(st, ctx17());
  ok(back.events.some(e => e.type === 'restored'), 'мир не восстановил путь');
  ok(r.route.pos !== posBefore, 'после мира караван не тронулся');
  console.log(`   30 дней войны: 0🪙, караван стоял на ${posBefore.toFixed(1)}/${r.route.length.toFixed(1)}; после мира путь открыт`);
});

t('U17 враждебная территория рвёт путь', () => {
  const st = createProduction();
  const r = addRoute(st, ctx17(), { faction: target.id, from: { x: camp.x, y: camp.y }, to: target.settlements[0] });
  ok(r.ok, r.reason);
  const mid = routePoints(r.route)[Math.floor(r.route.tiles / 2)];
  const hostile = { ...ctx17(), hostileAt: (x, y) => x === mid.x && y === mid.y };
  const ev = tickRoutes(st, hostile);
  ok(ev.events.some(e => e.reason === 'hostile'), 'враждебная клетка не порвала путь');
  let g = 0;
  for (let d = 0; d < 40; d++) g += tickRoutes(st, hostile).gold;
  ok(g === 0, 'через враждебную землю караван всё же прошёл');
  console.log(`   клетка (${mid.x},${mid.y}) объявлена вражеской: путь стоит 40 дней, доход 0🪙`);
});

t('U17 груз из цепочек повышает доход рейса', () => {
  const bare = createProduction(), loaded = createProduction();
  loaded.stock.flour = 100;
  const mk = (st) => addRoute(st, ctx17(), { faction: target.id, from: { x: camp.x, y: camp.y }, to: target.settlements[0] }).route;
  const r1 = mk(bare), r2 = mk(loaded);
  ok(!r1.cargo && r2.cargo && r2.cargo.res === 'flour', 'груз не взят со склада');
  near(loaded.stock.flour, 100 - TRADE.cargoLoad, 1e-9, 'груз не списан со склада');
  for (let d = 0; d < 120; d++) { tickRoutes(bare, ctx17()); tickRoutes(loaded, ctx17()); }
  ok(loaded.tradeGold > bare.tradeGold, `груз не дал прибавки: ${loaded.tradeGold} vs ${bare.tradeGold}`);
  console.log(`   без груза ${bare.tradeGold.toFixed(1)}🪙, с мукой ${loaded.tradeGold.toFixed(1)}🪙 за ${r2.trips} рейсов`);
});

t('U17 плохие отношения = риск разбоя; результат воспроизводим по сиду', () => {
  const play = (seed) => {
    const st = createProduction();
    const c = { ...ctx17(), rng: createRng(seed), relations: { [target.id]: -90 } };
    addRoute(st, c, { faction: target.id, from: { x: camp.x, y: camp.y }, to: target.settlements[0] });
    let robbed = 0;
    for (let d = 0; d < 400; d++) for (const e of tickRoutes(st, c).events) if (e.type === 'robbed') robbed++;
    return { gold: st.tradeGold, trips: st.trips, robbed };
  };
  const a = play(1234), b = play(1234), c = play(999);
  ok(a.robbed > 0, 'при отношениях −90 караваны ни разу не ограбили');
  near(a.gold, b.gold, 1e-12, 'один сид дал разный доход');
  ok(a.robbed === b.robbed, 'один сид дал разное число ограблений');
  ok(c.robbed !== a.robbed || c.gold !== a.gold, 'разные сиды дали одинаковый результат');
  console.log(`   сид 1234: рейсов ${a.trips}, ограблено ${a.robbed}, доход ${a.gold.toFixed(1)}🪙; повтор совпал в точности`);
});

t('U17 лимит маршрутов и снятие маршрута', () => {
  const st = createProduction();
  ok(maxRoutes({ buildings: [] }) === 0, 'маршруты без рынка');
  ok(maxRoutes({ buildings: [...bld('market', 2), ...bld('train_station')] }) === 3, 'лимит считается неверно');
  const c = ctx17();
  const r1 = addRoute(st, c, { faction: target.id, from: { x: camp.x, y: camp.y }, to: target.settlements[0] });
  ok(r1.ok, r1.reason);
  const dup = addRoute(st, c, { faction: target.id, from: { x: camp.x, y: camp.y }, to: target.settlements[0] });
  ok(!dup.ok && /уже проложен/.test(dup.reason), 'дубликат маршрута принят');
  ok(removeRoute(st, r1.route.id) && st.routes.length === 0, 'маршрут не снялся');
});

console.log('═══ Сейв и детерминизм ═══');

t('сериализация через JSON: продолжение партии совпадает до знака', () => {
  const st = createProduction();
  addRoute(st, ctx17(), { faction: target.id, from: { x: camp.x, y: camp.y }, to: target.settlements[0] });
  const b = [...bld('farm'), ...bld('mill'), ...bld('bakery'), ...bld('mine'), ...bld('smelter')];
  const w = world1();
  const step = (state, world, rng) => {
    const r = tickProduction(state, { buildings: b, days: 1, res: world.res, resCap: world.resCap, seasonIdx: 0 });
    for (const [k, v] of Object.entries(r.res)) {
      world.res[k] = Math.max(0, Math.min(world.resCap[k] ?? 99999, (world.res[k] ?? 0) + v));
    }
    tickRoutes(state, { ...ctx17(), rng });
  };
  for (let d = 0; d < 50; d++) step(st, w, createRng(5));
  const json = JSON.stringify(serializeProduction(st));
  const back = deserializeProduction(JSON.parse(json));
  const w2 = { res: { ...w.res }, resCap: { ...w.resCap } };
  for (let d = 0; d < 30; d++) { step(st, w, createRng(5)); step(back, w2, createRng(5)); }
  for (const it of INTERMEDIATES) near(back.stock[it.id], st.stock[it.id], 1e-9, `склад ${it.ru} разошёлся`);
  near(back.tradeGold, st.tradeGold, 1e-9, 'торговый доход разошёлся');
  near(w2.res.food, w.res.food, 1e-9, 'еда разошлась');
  ok(back.routes.length === st.routes.length && back.routes[0].trips === st.routes[0].trips, 'маршрут не восстановился');
  console.log(`   сейв ${json.length} байт; после загрузки 30 дней дали те же ${w2.res.food.toFixed(2)}🍞 и ${back.tradeGold.toFixed(2)}🪙`);
});

t('в модуле нет Math.random и запрещённых импортов', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/core/systems/production.js', import.meta.url)), 'utf8');
  ok(!/Math\.random/.test(src), 'найден Math.random — детерминизм сломан');
  ok(!/\bdocument\b|\bwindow\b/.test(src), 'модуль лезет в DOM');
  // Только настоящие import-строки: в блоке INTEGRATION пути упомянуты в комментариях.
  const imports = [...src.matchAll(/^import [\s\S]*?from '([^']+)';$/gm)].map(m => m[1]);
  ok(imports.length >= 2, 'импорты не разобрались');
  for (const i of imports) ok(i.startsWith('../') && !i.includes('/ui/') && !i.includes('/render/'), `посторонний импорт ${i}`);
  ok(!/TODO|FIXME|console\.log/.test(src), 'в модуле остались TODO или отладочный вывод');
});

t('U11 новый продукт добавляется одной строкой', () => {
  const before = CHAINS.length;
  registerChain({ id: 'ore_sale', ru: 'Сбыт руды', final: 'gold', stages: [{ id: 'sell_ore', ru: 'Продажа руды', in: { ore: 2 }, out: { gold: 1 }, by: [{ b: 'market', rate: 1 }] }] });
  ok(CHAINS.length === before + 1 && chainById('ore_sale'), 'цепочка не зарегистрирована');
  const st = createProduction();
  st.stock.ore = 50;
  const w = world1();
  const r = tickProduction(st, { buildings: bld('market'), days: 10, res: w.res, resCap: w.resCap });
  near(r.res.gold, 10, 1e-9, 'новая цепочка не производит золото');
  near(st.stock.ore, 30, 1e-9, 'новая цепочка не тратит руду');
  let bad = false;
  try { registerChain({ id: 'broken', ru: 'Кривая', final: 'gold', stages: [{ id: 's', out: { gold: 1 }, by: [{ b: 'нет_такого', rate: 1 }] }] }); }
  catch { bad = true; }
  ok(bad, 'опечатка в таблице не поймана');
  console.log(`   цепочка «Сбыт руды» добавлена одним объектом: 10 дней рынка = ${r.res.gold.toFixed(1)}🪙 из 20 руды`);
});

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
