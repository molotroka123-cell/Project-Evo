// Тесты модели стад (herds.js).
// Запуск: node app/tests/test-herds.mjs
//
// Проверяем не «функция не упала», а числа и направления: где потолок ёмкости,
// где обрыв порога живучести, растёт ли испуг и спадает ли он, уходит ли пуганое
// стадо от поселения, выгоднее ли облава гона одиночки, не считается ли день
// дважды, переживает ли состояние сохранение и не трогает ли модуль ни sim, ни
// то состояние, которое ему передали.
import { readFileSync } from 'node:fs';
import { Simulation } from '../src/core/simulation.js';
import { createRng } from '../src/core/rng.js';
import { tileAt } from '../src/core/world.js';
import { TILE } from '../src/core/data.js';
import {
  SPECIES, KINDS, SEASON_FEED, WINTER, YEAR,
  DOOM_DECAY, STARVE_MAX, EXTINCT_AT, PLOT_MIN_CAP,
  FEAR_MAX, FEAR_HALF_LIFE, FEAR_HUNT, FEAR_PER_HEAD, FEAR_YIELD, FEAR_FLEE,
  FLEE_DIST, HUNT_BASE, DRIVE_MAX, DRIVE_HALF, HUNT_MAX_SHARE, HUNT_MIN_HEADS,
  HUNT_LOG_DAYS, TAME_DIST, TAME_MIN_EXTRA, CLIMATE_FADE, LEADER_NAMES,
  createHerds, restoreHerds, serializeHerds, herdsContext,
  capacityAt, climateMult, seasonFeed, dailyChange,
  spawnHerds, herdsNewDay, nearestHerd, herdById, herdPoints,
  huntHerd, tameHerd, herdsSummary, sustainableFood,
  driveBonus, partyBonus,
} from '../src/core/systems/herds.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK  ', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≠ ${b}`);
const snap = (o) => JSON.stringify(o);

// Поддельный мир: слева лес, справа степь, по краю вода. Модель не знает про
// Simulation вообще — ей хватает плоского ctx, и это ровно то, что позволяет
// проверять ёмкость и кочёвку без прогона тысячи игровых дней.
const W = 64, H = 64;
function makeCtx(o = {}) {
  return {
    day: o.day ?? 0,
    seasonIdx: o.seasonIdx ?? 1,
    eraIdx: o.eraIdx ?? 0,
    homeX: o.homeX ?? 32, homeY: o.homeY ?? 32,
    w: W, h: H,
    tile: o.tile || ((x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      if (xi < 3 || yi < 3 || xi >= W - 3 || yi >= H - 3) return TILE.WATER;
      return xi < 32 ? TILE.FOREST : TILE.GRASS;
    }),
    hasTech: o.hasTech || (() => false),
  };
}

// Состояние с одним стадом в заданной точке — основа половины проверок.
function oneHerd(kind, n, x = 40, y = 32, extra = {}) {
  const s = createHerds();
  s.day = 0;
  s.nextId = 2;
  s.seen[kind] = true;
  s.herds.push({
    id: 1, kind, cx: x, cy: y, tx: x, ty: y, n,
    fear: 0, leader: LEADER_NAMES[0], since: 0, lastHunt: -9999,
    doomed: false, wander: 0, ...extra,
  });
  return s;
}

// Счётчик обращений к rng: нужен, чтобы доказать, что повторный вызов в те же
// сутки не тратит ни одного случайного числа. Одно лишнее — и два прогона
// одного сида разойдутся, а сейв перестанет совпадать с партией.
function countingRng(seed) {
  const r = createRng(seed);
  const c = { n: 0 };
  const wrap = {
    counter: c,
    next: () => { c.n++; return r.next(); },
    range: (a, b) => { c.n++; return r.range(a, b); },
    int: (a, b) => { c.n++; return r.int(a, b); },
    pick: (a) => { c.n++; return r.pick(a); },
    chance: (p) => { c.n++; return r.chance(p); },
  };
  return wrap;
}

console.log('--- Ёмкость участка ---');
{
  const ctx = makeCtx();
  const kForest = capacityAt(ctx, 'deer', 12, 32);
  const kGrass = capacityAt(ctx, 'deer', 50, 32);
  const kWater = capacityAt(makeCtx({ tile: () => TILE.WATER }), 'deer', 32, 32);
  t('лес кормит оленя лучше степи', () => ok(kForest > kGrass, `${kForest} vs ${kGrass}`));
  t('вода не кормит никого', () => near(kWater, 0, 1e-9, `ёмкость на воде ${kWater}`));
  t('гора не кормит никого', () => {
    const k = capacityAt(makeCtx({ tile: () => TILE.MOUNTAIN }), 'aurochs', 32, 32);
    near(k, 0, 1e-9, `ёмкость на камне ${k}`);
  });
  t('степь кормит быка лучше, чем лес', () => {
    const a = capacityAt(ctx, 'aurochs', 50, 32), b = capacityAt(ctx, 'aurochs', 12, 32);
    ok(a > b, `${a} vs ${b}`);
  });
  t('кабан в лесу, а не в степи', () => {
    const a = capacityAt(ctx, 'boar', 12, 32), b = capacityAt(ctx, 'boar', 50, 32);
    ok(a > b, `${a} vs ${b}`);
  });
  t('зимой участок кормит меньше, чем летом', () => {
    const summer = capacityAt(makeCtx({ seasonIdx: 1 }), 'deer', 12, 32);
    const winter = capacityAt(makeCtx({ seasonIdx: WINTER }), 'deer', 12, 32);
    ok(winter < summer * 0.7, `зима ${winter}, лето ${summer}`);
  });
  t('осень кормит лучше весны (нагул перед зимой)', () => {
    const spring = capacityAt(makeCtx({ seasonIdx: 0 }), 'deer', 12, 32);
    const autumn = capacityAt(makeCtx({ seasonIdx: 2 }), 'deer', 12, 32);
    ok(autumn > spring, `осень ${autumn}, весна ${spring}`);
  });
  t('мамонт зиму почти не замечает, а кабан замечает сильнее всех', () => {
    const m = seasonFeed(SPECIES.mammoth, WINTER);
    const b = seasonFeed(SPECIES.boar, WINTER);
    const d = seasonFeed(SPECIES.deer, WINTER);
    ok(m > d && d > b, `мамонт ${m}, олень ${d}, кабан ${b}`);
    near(d, SEASON_FEED[WINTER], 1e-9, 'олень должен получать таблицу как есть');
  });
  t('после своей эпохи вид угасает климатом, а не только охотой', () => {
    ok(climateMult('mammoth', 1) === 1, 'в бронзе мамонт ещё держится');
    near(climateMult('mammoth', 2), 1 - CLIMATE_FADE, 1e-9, 'через эпоху');
    ok(climateMult('mammoth', 5) === 0, 'через четыре эпохи земля его не кормит');
    ok(climateMult('deer', 9) === 1, 'олень эпохами не ограничен');
  });
}

console.log('\n--- Логистический прирост ---');
{
  const sp = SPECIES.deer, K = 20;
  t('на самой ёмкости прирост ровно ноль', () => near(dailyChange(K, K, sp), 0, 1e-12, 'dn'));
  t('ниже ёмкости прирост положителен', () => ok(dailyChange(K / 2, K, sp) > 0, 'dn'));
  t('выше ёмкости поголовье убывает', () => ok(dailyChange(K * 1.5, K, sp) < 0, 'dn'));
  t('пустое стадо не оживает само', () => near(dailyChange(0, K, sp), 0, 1e-12, 'dn'));
  t('максимум прироста приходится ровно на половину ёмкости', () => {
    let bestN = 0, best = -Infinity;
    for (let n = sp.minViable; n <= K; n += 0.05) {
      const dn = dailyChange(n, K, sp);
      if (dn > best) { best = dn; bestN = n; }
    }
    near(bestN, K / 2, 0.2, 'точка наибольшей отдачи');
  });
  t('ниже порога живучести стадо убывает даже на бескрайнем корме', () => {
    const dn = dailyChange(sp.minViable - 0.01, 1000, sp);
    ok(dn < 0, `dn = ${dn} при ёмкости 1000`);
  });
  t('обрыв на пороге: чуть выше порога — рост, чуть ниже — убыль', () => {
    ok(dailyChange(sp.minViable + 0.01, K, sp) > 0, 'выше порога');
    ok(dailyChange(sp.minViable - 0.01, K, sp) < 0, 'ниже порога');
  });
  t('обречённое стадо тает быстрее просто голодного', () => ok(DOOM_DECAY > STARVE_MAX, `${DOOM_DECAY} vs ${STARVE_MAX}`));
  t('у голодной убыли есть пол: за зиму гибнет часть стада, а не стадо', () => {
    let n = 40;
    for (let d = 0; d < 25; d++) n += dailyChange(n, 5, SPECIES.deer);  // ёмкость вчетверо ниже
    ok(n > 40 * 0.7, `за 25 суток бескормицы осталось ${n.toFixed(1)} из 40`);
  });
  t('земля без корма (ёмкость 0) не даёт деления на ноль', () => {
    const dn = dailyChange(10, 0, sp);
    ok(Number.isFinite(dn) && dn < 0, `dn = ${dn}`);
  });
}

console.log('\n--- Порог живучести, угасание и вымирание вида ---');
{
  const ctx = makeCtx();
  const rng = createRng(1);
  let st = oneHerd('deer', SPECIES.deer.minViable - 1);
  let doomedSaid = 0, goneSaid = 0, extinctSaid = 0;
  for (let d = 1; d <= 200; d++) {
    const r = herdsNewDay(st, { ...ctx, day: d }, rng);
    st = r.state;
    for (const e of r.events) {
      if (e.cause === 'doomed') doomedSaid++;
      if (e.cause === 'herd_gone') goneSaid++;
      if (e.cause === 'extinct') extinctSaid++;
    }
  }
  t('стадо ниже порога угасло, а не восстановилось', () => ok(st.herds.length === 0, `осталось ${st.herds.length} стад`));
  t('про пробитый порог сказано ровно один раз, а не каждые сутки',
    () => ok(doomedSaid === 1, `сказано ${doomedSaid} раз`));
  t('про исчезнувшее стадо сказано один раз', () => ok(goneSaid === 1, `${goneSaid}`));
  t('вымирание вида — событие, а не тихая пропажа', () => ok(extinctSaid === 1, `${extinctSaid}`));
  t('вид записан в вымершие с днём', () => ok(Number.isFinite(st.gone.deer), snap(st.gone)));
  t('выбитый вид больше не заводится при новой расстановке', () => {
    const r = spawnHerds(st, ctx, createRng(2));
    ok(!r.state.herds.some(h => h.kind === 'deer'), 'олень вернулся, хотя был выбит');
    ok(r.state.herds.length > 0, 'остальные виды при этом расставились');
  });
  t('вид, чья эпоха прошла, не ставится вовсе и в вымершие не пишется', () => {
    const r = spawnHerds(createHerds(), makeCtx({ eraIdx: 5 }), createRng(3));
    ok(!r.state.herds.some(h => h.kind === 'mammoth'), 'мамонт в средневековье');
    ok(r.state.gone.mammoth == null, 'его не выбивали — его просто не застали');
  });
}

console.log('\n--- Один день считается один раз ---');
{
  const ctx = makeCtx({ day: 5 });
  const st = oneHerd('deer', 12);
  const rng = countingRng(9);
  const first = herdsNewDay(st, ctx, rng);
  const usedFirst = rng.counter.n;
  const second = herdsNewDay(first.state, ctx, rng);
  t('повторный вызов в те же сутки помечен как пропуск', () => ok(second.skipped === true, snap(second.skipped)));
  t('поголовье во второй раз не начисляется',
    () => ok(snap(serializeHerds(first.state)) === snap(serializeHerds(second.state)), 'состояние разъехалось'));
  t('повторный вызов не тратит ни одного случайного числа',
    () => ok(rng.counter.n === usedFirst, `потрачено ещё ${rng.counter.n - usedFirst}`));
  t('повторный вызов молчит', () => ok(second.events.length === 0, snap(second.events)));
  t('новые сутки считаются нормально', () => {
    const third = herdsNewDay(second.state, { ...ctx, day: 6 }, rng);
    ok(third.skipped !== true && third.state.day === 6, snap(third.state.day));
  });
}

console.log('\n--- Модуль ничего не мутирует ---');
{
  const ctx = makeCtx({ day: 3 });
  const st = oneHerd('boar', 9, 12, 32);
  const before = snap(st);
  herdsNewDay(st, ctx, createRng(4));
  t('дневной ход не тронул переданное состояние', () => ok(snap(st) === before, 'состояние изменено на месте'));
  huntHerd(st, 1, ctx, { hunters: 2 }, createRng(5));
  t('охота не тронула переданное состояние', () => ok(snap(st) === before, 'состояние изменено на месте'));
  spawnHerds(st, ctx, createRng(6));
  t('расстановка не тронула переданное состояние', () => ok(snap(st) === before, 'состояние изменено на месте'));
  const st2 = oneHerd('aurochs', 12, 34, 32);
  const before2 = snap(st2);
  tameHerd(st2, 1, makeCtx({ hasTech: () => true }));
  t('приручение не тронуло переданное состояние', () => ok(snap(st2) === before2, 'состояние изменено на месте'));
}

console.log('\n--- Охота: облава выгоднее гона одиночки ---');
{
  const ctx = makeCtx({ day: 10 });
  t('прибавка за облаву растёт с поголовьем', () => {
    ok(driveBonus(20) > driveBonus(5), `${driveBonus(20)} vs ${driveBonus(5)}`);
    ok(driveBonus(1) > 1, 'даже пара голов уже лучше одиночки');
  });
  t('прибавка за облаву насыщается и не уходит в бесконечность', () => {
    ok(driveBonus(1e6) < 1 + DRIVE_MAX + 1e-6, `${driveBonus(1e6)}`);
    near(driveBonus(DRIVE_HALF), 1 + DRIVE_MAX / 2, 1e-9, 'на DRIVE_HALF взята половина прибавки');
  });
  t('четверо берут вдвое больше одного, а не вчетверо', () => {
    near(partyBonus(4), 2, 1e-9, 'partyBonus(4)');
    near(partyBonus(1), 1, 1e-9, 'partyBonus(1)');
  });
  const avgHeads = (n, fear, trials = 400, seed = 77) => {
    const rng = createRng(seed);
    let sum = 0;
    for (let i = 0; i < trials; i++) {
      const st = oneHerd('deer', n, 40, 32, { fear });
      sum += huntHerd(st, 1, ctx, { hunters: 1 }, rng).heads;
    }
    return sum / trials;
  };
  t('со стада берут больше, чем с одиночки', () => {
    const big = avgHeads(30, 0), small = avgHeads(4, 0);
    ok(big > small * 1.3, `стадо ${big.toFixed(2)}, одиночки ${small.toFixed(2)}`);
  });
  t('пуганое стадо отдаёт меньше', () => {
    const calm = avgHeads(30, 0), scared = avgHeads(30, 1);
    ok(scared < calm * (1 - FEAR_YIELD * 0.6), `спокойное ${calm.toFixed(2)}, пуганое ${scared.toFixed(2)}`);
  });
  t('больше трети стада за один заход не берут', () => {
    const rng = createRng(8);
    for (let i = 0; i < 200; i++) {
      const st = oneHerd('deer', 30);
      const r = huntHerd(st, 1, ctx, { hunters: 20 }, rng);
      ok(r.heads <= Math.max(HUNT_MIN_HEADS, 30 * HUNT_MAX_SHARE) + 1e-9, `взято ${r.heads} из 30`);
    }
  });
  t('одинокого зверя добрать можно — иначе он висел бы вечно', () => {
    const rng = createRng(12);
    let got = 0;
    for (let i = 0; i < 60; i++) {
      const st = oneHerd('deer', 1);
      if (huntHerd(st, 1, ctx, { hunters: 4 }, rng).heads >= 1) got++;
    }
    ok(got > 30, `добрали лишь ${got} раз из 60`);
  });
  t('больше, чем есть голов, не взять никогда', () => {
    const rng = createRng(13);
    for (let i = 0; i < 200; i++) {
      const n = 1 + (i % 6);
      const st = oneHerd('deer', n);
      const r = huntHerd(st, 1, ctx, { hunters: 30 }, rng);
      ok(r.heads <= n, `взято ${r.heads} из ${n}`);
      ok(r.state.herds.length === 0 || r.state.herds[0].n >= 0, 'поголовье ушло в минус');
    }
  });
  t('еда равна головам, умноженным на мясо вида', () => {
    const st = oneHerd('mammoth', 8);
    const r = huntHerd(st, 1, ctx, { hunters: 3 }, createRng(14));
    near(r.food, r.heads * SPECIES.mammoth.meat, 1e-9, 'еда');
  });
  t('охота на несуществующее стадо не роняет модуль и объясняется словами', () => {
    const st = oneHerd('deer', 10);
    const r = huntHerd(st, 999, ctx, {}, createRng(15));
    ok(r.ok === false && r.heads === 0 && r.reasons.length > 0, snap(r.reasons));
  });
  t('у каждой добычи названа причина словами', () => {
    const st = oneHerd('deer', 20);
    const r = huntHerd(st, 1, ctx, { hunters: 2 }, createRng(16));
    ok(r.reasons.length > 0 && typeof r.reasons[0].ru === 'string' && r.reasons[0].ru.length > 10, snap(r.reasons));
  });
  t('кабан иногда ранит охотника, олень — никогда', () => {
    const rng = createRng(17);
    let boarHurt = 0, deerHurt = 0;
    for (let i = 0; i < 300; i++) {
      boarHurt += huntHerd(oneHerd('boar', 12, 12, 32), 1, ctx, {}, rng).injured ? 1 : 0;
      deerHurt += huntHerd(oneHerd('deer', 12), 1, ctx, {}, rng).injured ? 1 : 0;
    }
    ok(boarHurt > 10, `кабан ранил ${boarHurt} раз из 300`);
    ok(deerHurt === 0, `олень ранил ${deerHurt} раз`);
  });
  t('охота попадает в список за месяц и оттуда вычищается', () => {
    let st = oneHerd('deer', 25);
    const r = huntHerd(st, 1, { ...ctx, day: 10 }, { hunters: 3 }, createRng(18));
    st = r.state;
    ok(st.hunts.length === (r.heads > 0 ? 1 : 0), snap(st.hunts));
    const later = herdsNewDay(st, { ...ctx, day: 10 + HUNT_LOG_DAYS + 1 }, createRng(19));
    ok(later.state.hunts.length === 0, `запись за месяц не вычищена: ${snap(later.state.hunts)}`);
  });
}

console.log('\n--- Пугливость: растёт от охоты, спадает со временем ---');
{
  const ctx = makeCtx({ day: 1 });
  t('охота пугает стадо', () => {
    const r = huntHerd(oneHerd('deer', 25), 1, ctx, { hunters: 1 }, createRng(20));
    ok(r.state.herds[0].fear >= FEAR_HUNT, `испуг ${r.state.herds[0].fear}`);
  });
  t('у испуга есть потолок — сколько ни бей', () => {
    let st = oneHerd('deer', 400, 40, 32);
    const rng = createRng(21);
    for (let i = 0; i < 60; i++) st = huntHerd(st, 1, ctx, { hunters: 1 }, rng).state;
    ok(st.herds[0].fear <= FEAR_MAX + 1e-9, `испуг ${st.herds[0].fear}`);
    ok(st.herds[0].fear > 0.9, `испуг должен был дойти до потолка, а он ${st.herds[0].fear}`);
  });
  t('испуг спадает вдвое ровно за период полураспада — это и есть выход из петли', () => {
    let st = oneHerd('deer', 20, 40, 32, { fear: 1 });
    const rng = createRng(22);
    for (let d = 1; d <= FEAR_HALF_LIFE; d++) st = herdsNewDay(st, { ...makeCtx(), day: d }, rng).state;
    near(st.herds[0].fear, 0.5, 0.02, 'испуг через полураспад');
  });
  t('за месяц без охоты стадо почти успокаивается', () => {
    let st = oneHerd('deer', 20, 40, 32, { fear: 1 });
    const rng = createRng(23);
    for (let d = 1; d <= 30; d++) st = herdsNewDay(st, { ...makeCtx(), day: d }, rng).state;
    ok(st.herds[0].fear < 0.25, `испуг ${st.herds[0].fear}`);
  });
  t('чем больше выбито голов, тем сильнее испуг', () => {
    const a = oneHerd('deer', 25), b = oneHerd('deer', 25);
    const one = huntHerd(a, 1, ctx, { hunters: 1 }, createRng(24));
    const many = huntHerd(b, 1, ctx, { hunters: 12 }, createRng(24));
    ok(many.state.herds[0].fear >= one.state.herds[0].fear, `${many.state.herds[0].fear} vs ${one.state.herds[0].fear}`);
    near(one.state.herds[0].fear, FEAR_HUNT + FEAR_PER_HEAD * one.heads, 0.2, 'испуг от одного захода');
  });
}

console.log('\n--- Кочёвка: пуганое стадо уходит от поселения ---');
{
  const base = makeCtx();
  const dist = (h) => Math.hypot(h.cx - base.homeX, h.cy - base.homeY);
  t('пуганое стадо уходит от поселения', () => {
    let st = oneHerd('deer', 20, 36, 32, { fear: 1 });
    const d0 = dist(st.herds[0]);
    const rng = createRng(25);
    for (let d = 1; d <= 20; d++) {
      st = herdsNewDay(st, { ...base, day: d }, rng).state;
      st.herds[0].fear = 1;                       // держим испуг: бьют каждый день
    }
    ok(dist(st.herds[0]) > d0 + 4, `было ${d0.toFixed(1)}, стало ${dist(st.herds[0]).toFixed(1)}`);
  });
  t('спокойное стадо от поселения не бежит', () => {
    let st = oneHerd('deer', 20, 36, 32, { fear: 0 });
    const d0 = dist(st.herds[0]);
    const rng = createRng(26);
    for (let d = 1; d <= 20; d++) st = herdsNewDay(st, { ...base, day: d }, rng).state;
    ok(Math.abs(dist(st.herds[0]) - d0) < FLEE_DIST * 0.6, `было ${d0.toFixed(1)}, стало ${dist(st.herds[0]).toFixed(1)}`);
  });
  t('стадо не заходит в воду и не выходит за карту', () => {
    let st = oneHerd('deer', 20, 36, 32, { fear: 1 });
    const rng = createRng(27);
    for (let d = 1; d <= 300; d++) {
      st = herdsNewDay(st, { ...base, day: d }, rng).state;
      if (!st.herds.length) break;
      const h = st.herds[0];
      h.fear = 1;
      ok(h.cx >= 0 && h.cy >= 0 && h.cx < W && h.cy < H, `стадо за картой: ${h.cx},${h.cy}`);
      ok(base.tile(h.cx, h.cy) !== TILE.WATER && base.tile(h.cx, h.cy) !== TILE.DEEP,
        `стадо в воде: ${h.cx.toFixed(1)},${h.cy.toFixed(1)}`);
    }
  });
  t('порог бегства работает: слабо пуганное стадо остаётся на участке', () => {
    let st = oneHerd('deer', 20, 36, 32, { fear: FEAR_FLEE * 0.5 });
    const d0 = dist(st.herds[0]);
    const rng = createRng(28);
    for (let d = 1; d <= 15; d++) { st = herdsNewDay(st, { ...base, day: d }, rng).state; st.herds[0].fear = FEAR_FLEE * 0.5; }
    ok(dist(st.herds[0]) < d0 + SPECIES.deer.radius * 1.5, `ушло на ${(dist(st.herds[0]) - d0).toFixed(1)}`);
  });
}

console.log('\n--- Поиск ближайшего стада ---');
{
  const st = createHerds();
  st.nextId = 4;
  st.herds.push({ id: 1, kind: 'deer', cx: 40, cy: 32, tx: 40, ty: 32, n: 10, fear: 0, leader: 'А', since: 0, lastHunt: -1, doomed: false, wander: 0 });
  st.herds.push({ id: 2, kind: 'aurochs', cx: 34, cy: 32, tx: 34, ty: 32, n: 12, fear: 0, leader: 'Б', since: 0, lastHunt: -1, doomed: false, wander: 0 });
  st.herds.push({ id: 3, kind: 'deer', cx: 60, cy: 32, tx: 60, ty: 32, n: 2, fear: 0, leader: 'В', since: 0, lastHunt: -1, doomed: false, wander: 0 });
  t('находится действительно ближайшее', () => ok(nearestHerd(st, 32, 32).id === 2, snap(nearestHerd(st, 32, 32))));
  t('отбор по виду работает', () => ok(nearestHerd(st, 32, 32, { kind: 'deer' }).id === 1, snap(nearestHerd(st, 32, 32, { kind: 'deer' }))));
  t('отбор по поголовью отсекает доживающие стада',
    () => ok(nearestHerd(st, 62, 32, { minHeads: 5 }).id === 1, 'выбрано доживающее стадо из двух голов'));
  t('за пределом дальности охотник получает отказ, а не бесконечный путь',
    () => ok(nearestHerd(st, 32, 32, { maxDist: 1 }) === null, 'найдено стадо дальше предела'));
  t('на пустой карте поиск возвращает null, а не падает', () => ok(nearestHerd(createHerds(), 0, 0) === null, 'не null'));
  t('стадо находится по номеру', () => ok(herdById(st, 2).kind === 'aurochs' && herdById(st, 99) === null, 'herdById'));
  t('поиск не трогает состояние', () => {
    const b = snap(st); nearestHerd(st, 10, 10); ok(snap(st) === b, 'состояние изменено');
  });
}

console.log('\n--- Стадо идёт кучей, а не врассыпную ---');
{
  const h = { id: 7, cx: 20, cy: 20, n: 16 };
  const pts = herdPoints(h);
  t('голов на карте столько же, сколько в стаде', () => ok(pts.length === 16, `${pts.length}`));
  t('все головы держатся возле центра', () => {
    const far = Math.max(...pts.map(p => Math.hypot(p.x - h.cx, p.y - h.cy)));
    ok(far < 3, `самая дальняя голова в ${far.toFixed(2)} клетках от центра`);
  });
  t('крупное стадо шире мелкого, но не рассыпается по всему участку', () => {
    const wide = Math.max(...herdPoints({ id: 7, cx: 20, cy: 20, n: 24 }).map(p => Math.hypot(p.x - 20, p.y - 20)));
    const tight = Math.max(...herdPoints({ id: 7, cx: 20, cy: 20, n: 4 }).map(p => Math.hypot(p.x - 20, p.y - 20)));
    ok(wide > tight && wide < SPECIES.deer.radius, `${wide.toFixed(2)} vs ${tight.toFixed(2)}`);
  });
  t('раскладка одинакова при каждом вызове (иначе картинка дёргалась бы)',
    () => ok(snap(herdPoints(h)) === snap(herdPoints(h)), 'раскладка разъехалась'));
}

console.log('\n--- Приручение: осознанный выбор, а не автоматика ---');
{
  const near0 = makeCtx({ hasTech: () => true });
  t('олень не приручается — это дичь', () => {
    const r = tameHerd(oneHerd('deer', 20, 34, 32), 1, near0);
    ok(r.ok === false && /не приручается/.test(r.reasons[0].ru), snap(r.reasons));
  });
  t('без скотоводства приручать нечем', () => {
    const r = tameHerd(oneHerd('aurochs', 20, 34, 32), 1, makeCtx({ hasTech: () => false }));
    ok(r.ok === false && /скотовод/i.test(r.reasons[0].ru), snap(r.reasons));
  });
  t('далёкое стадо к пастбищу не подвести', () => {
    const r = tameHerd(oneHerd('aurochs', 20, 32 + TAME_DIST + 5, 32), 1, near0);
    ok(r.ok === false && /далеко/.test(r.reasons[0].ru), snap(r.reasons));
  });
  t('слабое стадо приручать нечего', () => {
    const r = tameHerd(oneHerd('aurochs', SPECIES.aurochs.minViable + TAME_MIN_EXTRA - 1, 34, 32), 1, near0);
    ok(r.ok === false, snap(r.reasons));
  });
  t('годное стадо приручается и уходит с карты как дичь', () => {
    const r = tameHerd(oneHerd('aurochs', 20, 34, 32), 1, near0);
    ok(r.ok === true && r.heads === 20, snap({ ok: r.ok, heads: r.heads }));
    ok(r.state.herds.length === 0, 'стадо осталось дичью');
  });
  t('прирученное стадо не считается вымершим видом', () => {
    const r = tameHerd(oneHerd('aurochs', 20, 34, 32), 1, near0);
    ok(r.state.gone.aurochs == null, 'приручённых записали в выбитые');
    ok(r.lastWild === true, 'не сказано, что диких больше нет');
  });
}

console.log('\n--- Сводка для панели ---');
{
  const ctx = makeCtx();
  const st = spawnHerds(createHerds(), ctx, createRng(31)).state;
  const s = herdsSummary(st, ctx);
  t('строки собраны по видам', () => ok(s.rows.length >= 3, snap(s.rows.map(r => r.kind))));
  t('в каждой строке есть и поголовье, и ёмкость земли',
    () => ok(s.rows.every(r => Number.isFinite(r.heads) && Number.isFinite(r.cap)), snap(s.rows)));
  t('самый многочисленный вид назван первым', () => ok(s.rows[0].heads >= s.rows[1].heads, snap(s.rows)));
  t('есть готовая строка для игрока', () => ok(typeof s.text === 'string' && s.text.length > 10, s.text));
  t('пустая округа объясняется словами', () => {
    const e = herdsSummary(createHerds(), ctx);
    ok(/охотиться не на кого/.test(e.text), e.text);
  });
  t('сводка ничего не двигает — её можно звать из рендера', () => {
    const b = snap(st); herdsSummary(st, ctx); sustainableFood(st, ctx); ok(snap(st) === b, 'состояние изменено');
  });
  t('годовой прокорм положителен, пока стада не у самой ёмкости',
    () => ok(sustainableFood(st, ctx) > 0, `${sustainableFood(st, ctx)}`));
  t('новорасставленные стада не показываются обречёнными',
    () => ok(s.rows.every(r => r.doomed === 0 || r.heads === 0), snap(s.rows)));
}

console.log('\n--- Сохранение ---');
{
  const ctx = makeCtx();
  let st = spawnHerds(createHerds(), ctx, createRng(32)).state;
  const rng = createRng(33);
  for (let d = 1; d <= 40; d++) st = herdsNewDay(st, { ...ctx, day: d }, rng).state;
  st = huntHerd(st, st.herds[0].id, { ...ctx, day: 40 }, { hunters: 2 }, rng).state;

  const back = restoreHerds(JSON.parse(JSON.stringify(serializeHerds(st))));
  t('круг сохранения: записали, прочитали, состояние совпало',
    () => ok(snap(serializeHerds(back)) === snap(serializeHerds(st)), 'состояние разъехалось после сейва'));
  t('после загрузки день считается дальше так же', () => {
    const a = herdsNewDay(st, { ...ctx, day: 41 }, createRng(50));
    const b = herdsNewDay(back, { ...ctx, day: 41 }, createRng(50));
    ok(snap(serializeHerds(a.state)) === snap(serializeHerds(b.state)), 'прогоны разошлись');
  });
  t('мусор на входе не роняет модуль', () => {
    const junk = restoreHerds({ herds: [null, 5, { kind: 'дракон', n: 9 }, 'ерунда'], day: 'вчера', gone: 7, hunts: [1, null] });
    ok(junk.herds.length === 0 && junk.day === -1, snap(junk));
  });
  t('пустой и битый сейв дают чистое состояние', () => {
    ok(restoreHerds(null).herds.length === 0, 'null');
    ok(restoreHerds(undefined).herds.length === 0, 'undefined');
    ok(restoreHerds('строка').herds.length === 0, 'строка');
    ok(restoreHerds(42).herds.length === 0, 'число');
  });
  t('старый сейв без новых полей восстанавливается с разумными значениями', () => {
    const old = restoreHerds({ herds: [{ id: 1, kind: 'deer', cx: 10, cy: 10, n: 8 }] });
    const h = old.herds[0];
    ok(h.fear === 0 && h.tx === 10 && typeof h.leader === 'string' && old.nextId > 1, snap(old));
  });
  t('доживающие крохи из сейва не воскрешаются',
    () => ok(restoreHerds({ herds: [{ id: 1, kind: 'deer', cx: 10, cy: 10, n: EXTINCT_AT / 2 }] }).herds.length === 0, 'крохи ожили'));
  t('вымершие виды переживают сохранение', () => {
    const s = createHerds(); s.gone.mammoth = 120;
    ok(restoreHerds(serializeHerds(s)).gone.mammoth === 120, 'вымерший вид забыт');
  });
  t('номера стад после загрузки не повторяются', () => {
    const s2 = spawnHerds(back, ctx, createRng(34)).state;
    const ids = s2.herds.map(h => h.id);
    ok(new Set(ids).size === ids.length, `повторы: ${ids.join(',')}`);
  });
}

console.log('\n--- Детерминизм ---');
{
  const ctx = makeCtx();
  const run = () => {
    let st = spawnHerds(createHerds(), ctx, createRng(99)).state;
    const rng = createRng(99);
    for (let d = 1; d <= 120; d++) {
      st = herdsNewDay(st, { ...ctx, day: d, seasonIdx: Math.floor(d / 25) % 4 }, rng).state;
      if (d % 7 === 0 && st.herds.length) {
        st = huntHerd(st, st.herds[0].id, { ...ctx, day: d }, { hunters: 2 }, rng).state;
      }
    }
    return snap(serializeHerds(st));
  };
  t('два прогона одного сида совпадают слепок в слепок', () => {
    const a = run(), b = run();
    ok(a === b, 'миры разошлись на одном сиде');
  });
}

console.log('\n--- На настоящей симуляции ---');
{
  const sim = new Simulation(11, { startEra: 0 });
  const ctx = herdsContext(sim, (world, x, y) => tileAt(world, x, y));
  t('снимок мира читается из настоящей Simulation', () => {
    ok(ctx.w === sim.world.w && ctx.homeX === sim.world.startX, snap({ w: ctx.w, home: ctx.homeX }));
    ok(ctx.tile(sim.world.startX, sim.world.startY) === TILE.GRASS, 'стартовая поляна должна быть травой');
  });
  const probe = () => snap({
    day: sim.day, res: sim.res, animals: sim.animals.length,
    pop: sim.villagers.length, era: sim.eraIndex, season: sim.seasonIdx, log: sim.log.length,
  });
  const before = probe();
  let st = spawnHerds(createHerds(), ctx, sim.rng).state;
  t('стада расставлены по типам клеток настоящей карты', () => {
    ok(st.herds.length >= 6, `расставлено ${st.herds.length} стад`);
    ok(new Set(st.herds.map(h => h.kind)).size >= 3, snap(st.herds.map(h => h.kind)));
  });
  t('каждое стадо стоит на земле, которая его прокормит', () => {
    for (const h of st.herds) {
      const K = capacityAt(ctx, h.kind, h.cx, h.cy);
      ok(K >= SPECIES[h.kind].minViable * PLOT_MIN_CAP, `${h.kind}: ёмкость ${K.toFixed(1)}`);
      ok(h.n <= K + 1, `${h.kind}: поголовье ${h.n} выше ёмкости ${K.toFixed(1)}`);
    }
  });
  t('мамонт есть в каменном веке', () => ok(st.herds.some(h => h.kind === 'mammoth'), snap(st.herds.map(h => h.kind))));
  t('модуль не изменил sim', () => ok(probe() === before, 'sim изменён'));

  // Год без охоты: дичь обязана держаться сама, иначе игрок теряет её ни за что.
  let ev = [];
  for (let d = 1; d <= 300; d++) {
    const c = { ...ctx, day: d, seasonIdx: Math.floor(d / 25) % 4 };
    const r = herdsNewDay(st, c, sim.rng);
    st = r.state;
    ev = ev.concat(r.events);
  }
  t('без охоты дичь за три года не вымирает сама по себе', () => {
    ok(st.herds.length >= 6, `осталось ${st.herds.length} стад`);
    ok(Object.keys(st.gone).length === 0, `вымерли сами: ${Object.keys(st.gone).join(',')}`);
  });
  t('сытые стада расселяются — участок, который выбьют, не пустует вечно',
    () => ok(ev.some(e => e.cause === 'split'), 'ни одного расселения за 300 суток'));
  t('сводка работает на живой партии', () => {
    const s = herdsSummary(st, ctx);
    ok(typeof s.text === 'string' && s.total > 0, snap(s.text));
  });
  t('модуль не изменил sim и после трёхсот суток', () => ok(probe() === before, 'sim изменён'));

  // Жадность: два охотника каждый день. Дичь обязана кончиться — но не молча.
  let st2 = st, wiped = [];
  for (let d = 301; d <= 700; d++) {
    const c = { ...ctx, day: d, seasonIdx: Math.floor(d / 25) % 4 };
    const r = herdsNewDay(st2, c, sim.rng); st2 = r.state;
    wiped = wiped.concat(r.events.filter(e => e.cause === 'extinct'));
    for (let k = 0; k < 2; k++) {
      const n = nearestHerd(st2, ctx.homeX, ctx.homeY);
      if (!n) continue;
      const hr = huntHerd(st2, n.id, c, { hunters: 1 }, sim.rng);
      st2 = hr.state;
      wiped = wiped.concat(hr.events.filter(e => e.cause === 'extinct'));
    }
  }
  t('перебитая дичь действительно кончается', () => ok(st2.herds.length < st.herds.length, `было ${st.herds.length}, стало ${st2.herds.length}`));
  t('о каждом выбитом виде сказано словами', () => {
    for (const kind of Object.keys(st2.gone)) {
      ok(wiped.some(e => e.kind === kind), `вид ${kind} исчез молча`);
    }
    ok(wiped.every(e => typeof e.text === 'string' && e.text.length > 20), snap(wiped.map(e => e.text)));
  });
  t('выбитый вид не возвращается сам', () => {
    const goneKinds = Object.keys(st2.gone);
    for (const k of goneKinds) ok(!st2.herds.some(h => h.kind === k), `${k} вернулся`);
  });
  t('модуль не изменил sim и после охоты', () => ok(probe() === before, 'sim изменён'));

  t('Math.random в модуле не вызывается (иначе ломались бы сейвы)', () => {
    const src = readFileSync(new URL('../src/core/systems/herds.js', import.meta.url), 'utf8');
    ok(!/Math\.random\s*\(/.test(src), 'найден вызов Math.random');
  });
  t('модуль не пишет в sim ни одной строкой', () => {
    const all = readFileSync(new URL('../src/core/systems/herds.js', import.meta.url), 'utf8');
    // Блок ПОДКЛЮЧЕНИЕ — это образцы правок для integrate.js, там присваивания
    // в sim законны. Проверяем только настоящий код модуля.
    const src = all.split('ПОДКЛЮЧЕНИЕ')[0];
    ok(!/\bsim\.\w+\s*=[^=]/.test(src), 'найдено присваивание в sim');
  });
  t('в модуле нет обращений к DOM и окну', () => {
    const src = readFileSync(new URL('../src/core/systems/herds.js', import.meta.url), 'utf8');
    ok(!/\b(document|window|canvas)\b/.test(src), 'ядро не должно знать про экран');
  });
  t('у каждого вида заполнены все поля модели', () => {
    for (const k of KINDS) {
      const sp = SPECIES[k];
      for (const f of ['meat', 'minViable', 'growth', 'radius', 'density', 'speed', 'winterBite', 'lastEra']) {
        ok(Number.isFinite(sp[f]), `${k}.${f} = ${sp[f]}`);
      }
      ok(sp.minViable >= 1 && sp.growth > 0 && sp.meat > 0, `${k}: бессмысленные числа`);
      ok(typeof sp.ru === 'string' && sp.ru.length > 0, `${k}: нет русского имени`);
      ok(YEAR === 100 && HUNT_BASE > 0, 'единицы времени и добычи на месте');
    }
  });
}

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
if (fail) process.exit(1);
