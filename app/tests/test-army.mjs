// Тесты модуля армии на карте (U19–U24). Запуск: node app/tests/test-army.mjs
import { Simulation } from '../src/core/simulation.js';
import { createRng } from '../src/core/rng.js';
import { TILE, WALKABLE, UNITS, COUNTERS } from '../src/core/data.js';
import { tileAt } from '../src/core/world.js';
import * as A from '../src/core/systems/army.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const pct = (x) => (x * 100).toFixed(1) + '%';

// Отряд «на столе»: тот же формат, что у formSquad, но без состояния модуля —
// боевые стенды не должны зависеть от карты и от порядка формирования.
const bench = (units, extra = {}) => ({
  id: 1, side: 'x', name: 'стенд', x: 0, y: 0,
  units: { ...units }, engines: { ...(extra.engines || {}) },
  powerBonus: extra.powerBonus || 0, mult: extra.mult || 1, morale: extra.morale ?? 100,
  order: { type: 'hold' }, path: null, pathIdx: 0, siege: null, dead: false,
});

// Серия боёв на фиксированном сиде: доля побед стороны A.
function winrate(mkA, mkB, n, seed, ctx = {}) {
  const rng = createRng(seed);
  let w = 0;
  for (let i = 0; i < n; i++) if (A.resolveBattle(mkA(), mkB(), ctx, rng).winner === 'a') w++;
  return w / n;
}

// ------------------------------------------------------------ U19: отряды
t('U19 отряд: формирование, состав, скорость по самому медленному', () => {
  const st = A.createArmyState();
  const sq = A.formSquad(st, { side: 'player', x: 48, y: 48, units: { militia: 12, knight: 3 } });
  ok(sq.id === 1 && st.squads.length === 1, 'отряд не встал в список');
  ok(A.squadSize(sq) === 15, 'численность: ' + A.squadSize(sq));
  ok(A.squadSpeed(sq) === 6, 'пехота с конницей должна идти со скоростью пехоты: ' + A.squadSpeed(sq));
  A.addEngine(st, sq.id, 'catapult', 1);
  ok(A.squadSpeed(sq) === 2, 'обоз с катапультой должен ползти: ' + A.squadSpeed(sq));
  ok(A.engineCount(sq) === 1, 'машина не добавилась');
  const back = A.disbandSquad(st, sq.id);
  ok(back && st.squads.length === 0, 'роспуск не сработал');
  console.log(`   ${A.squadReport(sq)}`);
});

t('U19 приказ «идти»: путь строит aStar, отряд доходит и не лезет в воду', () => {
  const s = new Simulation(42);
  const st = A.createArmyState();
  const sx = s.world.startX, sy = s.world.startY;
  const sq = A.formSquad(st, { side: 'player', x: sx, y: sy, units: { militia: 10 } });
  // Цель — суша в 18 клетках: заведомо есть обход рельефа.
  let tx = sx + 18, ty = sy;
  while (!WALKABLE.has(tileAt(s.world, tx, ty)) && tx > sx) tx--;
  ok(A.orderMove(st, sq.id, tx, ty, s.world), 'путь не найден');
  ok(sq.path && sq.path.length > 1, 'путь пуст');
  let days = 0;
  const trail = [];
  while (sq.order.type === 'move' && sq.path && days < 60) {
    A.tickArmy(st, { world: s.world, day: days, dt: 1, factions: s.factions }, s.rng);
    trail.push({ x: sq.x, y: sq.y });
    days++;
  }
  ok(Math.hypot(sq.x - tx, sq.y - ty) < 1.1, `не дошёл: (${sq.x.toFixed(1)},${sq.y.toFixed(1)}) вместо (${tx},${ty})`);
  for (const p of trail) ok(WALKABLE.has(tileAt(s.world, p.x, p.y)), `отряд оказался на непроходимой клетке (${p.x},${p.y})`);
  console.log(`   (${sx},${sy}) → (${tx},${ty}): ${sq.path === null ? days : days} дней, ${trail.length} шагов, все по суше`);
});

t('U19 сериализация: состояние переживает JSON', () => {
  const s = new Simulation(7);
  const st = A.createArmyState();
  const sq = A.formSquad(st, { side: 'player', x: 44, y: 44, units: { militia: 8, musketeer: 2 }, engines: { ram: 2 }, powerBonus: 2, mult: 1.15 });
  A.orderMove(st, sq.id, 50, 50, s.world);
  A.tickArmy(st, { world: s.world, day: 1, dt: 1, factions: s.factions }, s.rng);
  const json = JSON.parse(JSON.stringify(A.serializeArmy(st)));
  const back = A.deserializeArmy(json);
  const a = A.allSquads(st)[0], b = A.allSquads(back)[0];
  ok(b && a.id === b.id && a.x === b.x && a.y === b.y, 'позиция потерялась');
  ok(JSON.stringify(a.units) === JSON.stringify(b.units), 'состав потерялся');
  ok(JSON.stringify(a.engines) === JSON.stringify(b.engines), 'машины потерялись');
  ok(a.order.type === b.order.type && a.pathIdx === b.pathIdx, 'приказ потерялся');
  ok(back.nextId === st.nextId, 'счётчик id потерялся');
  ok(A.deserializeArmy(undefined).squads.length === 0, 'старый сейв без поля должен грузиться пустым');
  console.log(`   ${A.squadReport(b)}`);
});

// ------------------------------------------------------------ детерминизм и скорость
t('детерминизм: один сид — один и тот же бой, разные сиды — разные', () => {
  const run = (seed) => {
    const rng = createRng(seed);
    const out = [];
    for (let i = 0; i < 50; i++) out.push(A.resolveBattle(bench({ militia: 20, knight: 4 }), bench({ musketeer: 8 }), {}, rng));
    return JSON.stringify(out);
  };
  ok(run(123) === run(123), 'один сид дал разные бои — детерминизм сломан');
  ok(run(123) !== run(124), 'разные сиды дали одинаковые бои — rng не используется');
  // resolveBattle обязана быть чистой: отчёт применяет applyBattle, иначе один
  // и тот же бой нельзя прогнать дважды (а именно так работают стенды баланса).
  const a = bench({ militia: 20 }), b = bench({ knight: 6 }, { engines: { ram: 1 } });
  const snap = JSON.stringify([a, b]);
  A.resolveBattle(a, b, {}, createRng(5));
  ok(JSON.stringify([a, b]) === snap, 'resolveBattle мутировала отряды');
});

t('скорость: 1000 боёв', () => {
  const rng = createRng(2024);
  const armies = [
    [{ militia: 40 }, { knight: 12 }],
    [{ musketeer: 20, militia: 30 }, { swordsman: 25, knight: 5 }],
    [{ soldier: 30, drone: 5 }, { soldier: 28, marksman: 10 }],
  ];
  const t0 = Date.now();
  let rounds = 0;
  for (let i = 0; i < 1000; i++) {
    const [u, v] = armies[i % armies.length];
    rounds += A.resolveBattle(bench(u), bench(v), { tileA: i % 3 === 0 ? TILE.HILL : TILE.GRASS }, rng).rounds;
  }
  const ms = Date.now() - t0;
  ok(ms < 1000, `слишком медленно: ${ms} мс на 1000 боёв`);
  console.log(`   1000 боёв за ${ms} мс (${(ms / 1000).toFixed(3)} мс на бой), раундов в среднем ${(rounds / 1000).toFixed(1)}`);
});

// ------------------------------------------------------------ БАЛАНС
t('БАЛАНС равных армий: 200 боёв, winrate 45–55%', () => {
  const w = winrate(() => bench({ militia: 20 }), () => bench({ militia: 20 }), 200, 1);
  const control = winrate(() => bench({ militia: 20 }), () => bench({ militia: 20 }), 2000, 1);
  const spread = [1, 7, 42, 777, 12345].map(sd => winrate(() => bench({ militia: 20 }), () => bench({ militia: 20 }), 200, sd));
  console.log(`   200 боёв (сид 1): ${pct(w)} · контроль 2000 боёв: ${pct(control)}`);
  console.log(`   разброс по сидам ${[1, 7, 42, 777, 12345].join(',')}: ${spread.map(pct).join(' ')} (±3.5% — это ошибка выборки на 200)`);
  ok(w >= 0.45 && w <= 0.55, `winrate равных ${pct(w)} вне 45–55%`);
  ok(control >= 0.47 && control <= 0.53, `на 2000 боёв перекос: ${pct(control)}`);
});

t('БАЛАНС контр-цикла U20: контра даёт 60–75%, обратная сторона — меньше половины', () => {
  // Стенды подобраны по РАВНОЙ суммарной силе, чтобы мерить именно контру:
  // 70 ополченцев (70×2=140) = 20 рыцарей (20×7=140) = 14 мушкетёров (14×10=140).
  const cases = [
    ['копья (inf) против конницы (cav)', () => bench({ militia: 70 }), () => bench({ knight: 20 }), 1],
    ['конница (cav) против стрелков (range)', () => bench({ knight: 20 }), () => bench({ musketeer: 14 }), 2],
    ['стрелки (range) против пехоты (inf)', () => bench({ musketeer: 14 }), () => bench({ militia: 70 }), 3],
  ];
  for (const [name, mkA, mkB, seed] of cases) {
    const w = winrate(mkA, mkB, 200, seed);
    const rev = winrate(mkB, mkA, 200, seed + 100);
    console.log(`   ${name}: ${pct(w)} (обратно: ${pct(rev)})`);
    ok(w >= 0.60 && w <= 0.75, `${name}: ${pct(w)} вне 60–75%`);
    ok(rev < 0.45, `${name}: обратная сторона выигрывает ${pct(rev)} — контра не работает`);
  }
  // Контра работает пропорционально доле цели в армии врага, а не «включается».
  const full = winrate(() => bench({ militia: 70 }), () => bench({ knight: 20 }), 1000, 11);
  const half = winrate(() => bench({ militia: 70 }), () => bench({ knight: 10, militia: 35 }), 1000, 11);
  console.log(`   против чистой конницы ${pct(full)}, против армии наполовину из конницы ${pct(half)}`);
  ok(half < full && half > 0.5, `частичная контра должна быть между: ${pct(half)}`);
  ok(A.counterMult('inf', { inf: 0, cav: 1, range: 0, siege: 0 }) === 1 + COUNTERS.inf.cav / A.COUNTER_DIVISOR, 'множитель контры не из COUNTERS');
});

t('U21 высота: стрелки с холма сильнее, пехоте холм не помогает', () => {
  const range = winrate(() => bench({ musketeer: 20 }), () => bench({ musketeer: 20 }), 200, 5, { tileA: TILE.HILL, tileB: TILE.GRASS });
  const flat = winrate(() => bench({ musketeer: 20 }), () => bench({ musketeer: 20 }), 200, 5);
  const inf = winrate(() => bench({ militia: 20 }), () => bench({ militia: 20 }), 200, 5, { tileA: TILE.HILL, tileB: TILE.GRASS });
  const forest = winrate(() => bench({ musketeer: 20 }), () => bench({ musketeer: 20 }), 200, 5, { tileA: TILE.FOREST, tileB: TILE.GRASS });
  console.log(`   стрелки: холм ${pct(range)} · равнина ${pct(flat)} · лес ${pct(forest)}; пехота на холме ${pct(inf)}`);
  ok(range > 0.65 && range < 0.85, `бонус холма вне разумного: ${pct(range)}`);
  ok(Math.abs(inf - flat) < 0.06, 'холм почему-то усилил пехоту');
  ok(forest < 0.45, `лес должен мешать стрелкам: ${pct(forest)}`);
  ok(A.terrainMult('range', TILE.HILL) === A.HILL_RANGE_MULT && A.terrainMult('inf', TILE.HILL) === 1, 'множитель рельефа применён не к той роли');
});

// ------------------------------------------------------------ U22: осада
t('U22 осада: таран бьёт только ворота, лестницы и катапульты — только стены', () => {
  const rng = createRng(9);
  const ramSq = bench({ swordsman: 20 }, { engines: { ram: 3 } });
  const fort1 = A.createFortification({ wall: 1000, defense: 0 });
  const w0 = fort1.wall, g0 = fort1.gate;
  const r1 = A.resolveSiege(ramSq, fort1, { dt: 1 }, rng);
  ok(fort1.gate < g0 && fort1.wall === w0, `таран задел стены: ворота ${fort1.gate}, стены ${fort1.wall}`);
  const ladSq = bench({ swordsman: 20 }, { engines: { ladder: 4, catapult: 1 } });
  const fort2 = A.createFortification({ wall: 1000, defense: 0 });
  A.resolveSiege(ladSq, fort2, { dt: 1 }, rng);
  ok(fort2.wall < w0 && fort2.gate === g0, `лестницы задели ворота: ворота ${fort2.gate}, стены ${fort2.wall}`);
  // Пролом — за конечное число дней, и по каждому пути свой.
  let days = 0;
  while (!fort1.breach && days < 60) { A.resolveSiege(ramSq, fort1, { dt: 1 }, rng); days++; }
  ok(fort1.breach === 'gate', 'ворота не выбиты: ' + fort1.breach);
  let days2 = 0;
  while (!fort2.breach && days2 < 60) { A.resolveSiege(ladSq, fort2, { dt: 1 }, rng); days2++; }
  ok(fort2.breach === 'wall', 'стена не взята: ' + fort2.breach);
  console.log(`   ворота (350 hp) таранами за ${days + 1} дн., стена (1000 hp) лестницами+катапультой за ${days2 + 1} дн. (урон за день: ${r1.gateDmg.toFixed(0)})`);
});

t('U22 два пути штурма дают разные шансы: ворота > стена > без пролома', () => {
  // Стенд подобран так, чтобы путь по лестницам оказался ровно на грани: 40
  // мечников против гарнизона в 30 при обороне 15 (в модели на истощение исход
  // решает multA·NA² против multB·NB², отсюда и отношение 40/30 ≈ √1.73).
  // Иначе промежуточный путь схлопывается в 0 или 100% и сравнивать нечего.
  const mk = () => bench({ swordsman: 40 });
  const gar = () => bench({ swordsman: 30 });
  const run = (breach, seed) => {
    const rng = createRng(seed);
    let w = 0;
    for (let i = 0; i < 200; i++) {
      const fort = A.createFortification({ wall: 500, defense: 15 });
      fort.breach = breach;
      if (A.assault(mk(), fort, gar(), {}, rng).winner === 'a') w++;
    }
    return w / 200;
  };
  const gate = run('gate', 21), wall = run('wall', 21), none = run(null, 21);
  console.log(`   40 мечников штурмуют гарнизон 30 при обороне 15: через ворота ${pct(gate)} · по лестницам ${pct(wall)} · без пролома ${pct(none)}`);
  ok(gate > wall + 0.15, `пролом ворот должен быть заметно выгоднее лестниц: ${pct(gate)} vs ${pct(wall)}`);
  ok(wall > none + 0.15, `лестницы должны быть выгоднее лобового штурма: ${pct(wall)} vs ${pct(none)}`);
  ok(none < 0.15, `штурм без пролома не должен быть рабочим планом: ${pct(none)}`);
  ok(wall > 0.3 && wall < 0.7, `путь по лестницам должен быть рискованным, но живым: ${pct(wall)}`);
});

t('U22 осада без машин почти безнадёжна, гарнизон сбивает машины', () => {
  const rng = createRng(33);
  const bare = bench({ swordsman: 30 });
  const fort = A.createFortification({ wall: 500, defense: 10 });
  for (let d = 0; d < 30; d++) A.resolveSiege(bare, fort, { dt: 1 }, rng);
  ok(!fort.breach, `30 дней без машин пробили укрепление: ворота ${fort.gate.toFixed(0)}`);
  // Оборона выбивает машины и их расчёты.
  const withEng = bench({ swordsman: 30 }, { engines: { catapult: 6 } });
  const fort2 = A.createFortification({ wall: 4000, defense: 40 });
  const crew0 = A.squadSize(withEng);
  for (let d = 0; d < 20; d++) A.resolveSiege(withEng, fort2, { dt: 1 }, rng);
  ok(A.engineCount(withEng) < 6, 'защитники не сбили ни одной машины');
  ok(A.squadSize(withEng) < crew0, 'расчёты не понесли потерь');
  console.log(`   без машин за 30 дней ворота ${fort.gate.toFixed(0)}/${fort.gateMax.toFixed(0)}; под огнём обороны 40 осталось ${A.engineCount(withEng)}/6 катапульт, расчётов −${crew0 - A.squadSize(withEng)}`);
});

// ------------------------------------------------------------ U23: захват машин
t('U23 захват машин: разбитый расчёт бросает парк, победитель забирает часть', () => {
  const rng = createRng(77);
  let capturedTotal = 0, destroyedTotal = 0, wins = 0;
  for (let i = 0; i < 200; i++) {
    const attacker = bench({ knight: 30 });                       // сильная конница
    const crew = bench({ militia: 6 }, { engines: { ram: 2, catapult: 2 } }); // слабое прикрытие обоза
    const res = A.resolveBattle(attacker, crew, {}, rng);
    if (res.winner === 'a') {
      wins++;
      for (const v of Object.values(res.captured)) capturedTotal += v;
      for (const v of Object.values(res.destroyedEngines)) destroyedTotal += v;
      ok(Object.keys(res.b.after.engines).length === 0, 'у разбитого остались машины');
      const gotBack = Object.values(res.a.after.engines).reduce((a, b) => a + b, 0);
      ok(gotBack === Object.values(res.captured).reduce((a, b) => a + b, 0), 'трофеи не попали победителю');
    }
  }
  ok(wins > 150, 'стенд собран неверно: обоз должен проигрывать почти всегда, побед ' + wins);
  ok(capturedTotal > 0 && destroyedTotal > 0, 'машины не захватываются либо не горят');
  ok(capturedTotal + destroyedTotal === wins * 4, 'потерялись машины: ' + (capturedTotal + destroyedTotal));
  console.log(`   ${wins} разгромов обоза: захвачено ${capturedTotal} машин, сожжено ${destroyedTotal} (${pct(capturedTotal / (capturedTotal + destroyedTotal))} трофеев)`);
  // Трофей реально переезжает в отряд-победитель.
  const st = A.createArmyState();
  const a = A.formSquad(st, { side: 'player', x: 0, y: 0, units: { knight: 30 } });
  const b = A.formSquad(st, { side: 'wolves', x: 0, y: 0, units: { militia: 4 }, engines: { ram: 3 } });
  let moved = 0;
  for (let i = 0; i < 30 && !moved; i++) {
    const res = A.resolveBattle(a, b, {}, rng);
    if (res.winner === 'a' && Object.keys(res.captured).length) { A.applyBattle(a, b, res); moved = A.engineCount(a); }
  }
  ok(moved > 0, 'applyBattle не перенёс трофеи');
  console.log(`   после применения боя у победителя ${moved} трофейных машин`);
});

// ------------------------------------------------------------ U24: поход
t('U24 поход: отряд доходит до поселения фракции, осаждает и берёт его', () => {
  const s = new Simulation(42);
  for (let i = 0; i < 60; i++) s.tick(0.5); // дать фракциям обрасти армией и стенами
  const f = s.factions[0];
  const target = f.settlements[0];
  const before = f.settlements.length;
  const st = A.createArmyState();
  // Отряд выходит в поле рядом со своей столицей и идёт через полкарты.
  const sq = A.formSquad(st, {
    side: 'player', x: s.world.startX, y: s.world.startY,
    units: { swordsman: 40, musketeer: 15 }, engines: { ram: 3, ladder: 2 },
  });
  ok(A.orderCampaign(st, sq.id, f.id, target.x, target.y, s.world), 'маршрут похода не построен');
  const events = [];
  let day = 0, sieged = false;
  while (day < 200 && f.settlements.length === before) {
    const ev = A.tickArmy(st, { world: s.world, day, dt: 1, factions: s.factions, atWar: () => true }, s.rng);
    events.push(...ev);
    if (sq.siege && !sieged) { sieged = true; console.log(`   день ${day}: осада начата, ворота ${sq.siege.gate.toFixed(0)}, стены ${sq.siege.wall.toFixed(0)}, оборона ${sq.siege.defense.toFixed(1)}`); }
    day++;
  }
  ok(sieged, 'до осады дело не дошло');
  ok(f.settlements.length === before - 1, `поселение не взято за ${day} дней`);
  ok(st.captures === 1, 'счётчик захватов не сработал');
  const capture = events.find(e => e.text.includes('🚩'));
  ok(capture && capture.chronicle, 'нет события о взятии для хроники');
  console.log(`   ${capture.text}`);
  console.log(`   поход занял ${day} дней; у ${f.def.name} осталось поселений: ${f.settlements.length}`);
});

t('U24 бой отрядов на карте: встреча враждебных сторон разрешается боем', () => {
  const s = new Simulation(11);
  const st = A.createArmyState();
  const x = s.world.startX, y = s.world.startY;
  const mine = A.formSquad(st, { side: 'player', x, y, units: { swordsman: 25 } });
  const foe = A.formSquad(st, { side: 'wolves', x: x + 0.5, y, units: { militia: 10 } });
  const ev = A.tickArmy(st, { world: s.world, day: 1, dt: 1, factions: s.factions, atWar: () => true }, s.rng);
  ok(st.battles === 1, 'бой не состоялся');
  ok(ev.some(e => e.text.includes('⚔')), 'нет сообщения о бое');
  ok(!A.findSquad(st, foe.id) || A.squadSize(foe) < 10, 'враг не понёс потерь');
  ok(A.findSquad(st, mine.id), 'победитель пропал с карты');
  console.log(`   ${ev[0].text}`);
  // Мирные стороны не дерутся сами по себе.
  const st2 = A.createArmyState();
  A.formSquad(st2, { side: 'player', x, y, units: { swordsman: 25 } });
  A.formSquad(st2, { side: 'guild', x, y, units: { militia: 10 } });
  A.tickArmy(st2, { world: s.world, day: 1, dt: 1, factions: s.factions, atWar: () => false }, s.rng);
  ok(st2.battles === 0, 'отряды подрались без войны');
});

// ------------------------------------------------------------ связка с ядром
t('интеграция: модуль не трогает ядро и детерминирован вместе с ним', () => {
  const run = (seed) => {
    const s = new Simulation(seed);
    const st = A.createArmyState();
    const sq = A.formSquad(st, { side: 'player', x: s.world.startX, y: s.world.startY, units: { militia: 10 }, engines: { ram: 1 } });
    A.orderMove(st, sq.id, s.world.startX + 10, s.world.startY + 6, s.world);
    const log = [];
    for (let d = 0; d < 40; d++) {
      s.tick(0.5);
      log.push(A.tickArmy(st, { world: s.world, day: d, dt: 1, factions: s.factions, atWar: () => true }, s.rng).length);
    }
    return JSON.stringify({ army: A.serializeArmy(st), log, food: s.res.food.toFixed(6), pop: s.villagers.length });
  };
  ok(run(42) === run(42), 'связка сим+армия недетерминирована');
  const s = new Simulation(42);
  const before = { soldiers: s.army.soldiers, pop: s.villagers.length };
  const st = A.createArmyState();
  A.formSquad(st, { side: 'player', x: 48, y: 48, units: { militia: 5 } });
  A.tickArmy(st, { world: s.world, day: 1, dt: 1, factions: s.factions }, s.rng);
  ok(s.army.soldiers === before.soldiers && s.villagers.length === before.pop, 'модуль полез в состояние ядра');
  // Укрепление игрока читается прямо из построенных стен.
  s.placeFree('palisade', 46, 46); s.placeFree('palisade', 46, 47);
  const fort = A.fortFromBuildings(s.doneBuildings());
  ok(fort.wall === 400 && fort.gate >= A.GATE_MIN, `укрепление из построек: стены ${fort.wall}, ворота ${fort.gate}`);
  console.log(`   два частокола → стены ${fort.wall} hp, ворота ${fort.gate.toFixed(0)} hp, оборона ${fort.defense}`);
});

t('юниты и машины берутся из data.js и гейтятся технологиями', () => {
  const s = new Simulation(3);
  ok(A.availableUnits(s.techs).length === 0, 'без «Военного дела» бойцов быть не должно');
  s.techs.add('warfare');
  ok(A.availableUnits(s.techs).map(u => u.id).join() === 'militia', 'после warfare доступен ополченец');
  ok(A.availableEngines(s.techs).map(e => e.id).sort().join() === 'ladder,ram', 'тараны и лестницы — с warfare');
  s.techs.add('mathematics');
  ok(A.availableEngines(s.techs).length === 3, 'катапульта требует математику');
  ok(UNITS.every(u => A.unitDef(u.id)), 'модуль не знает часть UNITS');
  console.log(`   доступно: ${A.availableUnits(s.techs).map(u => u.name).join(', ')} + ${A.availableEngines(s.techs).map(e => e.name).join(', ')}`);
});

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
