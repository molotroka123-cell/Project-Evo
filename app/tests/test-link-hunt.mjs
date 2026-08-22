// Тесты связи «охота ↔ стада ↔ еда ↔ люди» (link_hunt.js).
// Запуск: node app/tests/test-link-hunt.mjs
//
// Проверяем не «функция не упала», а числа: величину бонуса за облаву,
// направление каждой связи, потолки петель, поведение на краях, молчание при
// спокойной охоте и то, что модуль ничего не мутирует.
//
// Модель стад (herds.js) пишет другой агент. Здесь она подделана ровно по тому
// интерфейсу, который описан в шапке link_hunt.js: если настоящая модель будет
// отличаться, эти тесты покажут расхождение первыми.
import { readFileSync } from 'node:fs';
import { Simulation } from '../src/core/simulation.js';
import {
  huntLinks, huntState, huntYieldMult, huntLodgeMult, huntBreakdown, huntScars,
  huntHappyMod, huntParty, tameCandidates, tameHerd, withStock,
  createHuntMemory, restoreHuntMemory,
  SPECIES, KILL_WINDOW, BATTUE_MAX, BATTUE_MIN_HEAD, BATTUE_FULL_HEAD, BATTUE_PARTY_FULL,
  LODGE_MIN, LODGE_MAX, LODGE_RADIUS, FEAR_PER_KILL, FEAR_DAY_CAP, FEAR_CALM,
  FLEE_FEAR, FLEE_MAX_DIST, RETURN_DIST, PRESSURE_WARN, PRESSURE_FLEE,
  TAME_MIN_HEAD, TAME_MAX_FEAR, TAME_FOOD_PER_HEAD, TAME_PER_PASTURE, TAME_RADIUS,
  HAPPY_EMPTY_MAX, SAY_COOLDOWN, EXTINCT_SCAR_KIND,
} from '../src/core/systems/link_hunt.js';
import { KIND } from '../src/core/systems/link_memory.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK  ', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≠ ${b}`);

// Поддельный мир: связь читает только эти поля. Подделка позволяет поставить
// ровно то состояние, которое проверяется, без прогона тысячи игровых дней.
const CX = 48, CY = 48;

function herd(o = {}) {
  return {
    id: o.id || 'h1', species: o.species || 'deer',
    head: o.head ?? 20, x: o.x ?? 50, y: o.y ?? 50,
    r: o.r ?? 6, cap: o.cap ?? 40, fear: o.fear ?? 0, tame: !!o.tame,
  };
}

function makeSim(o = {}) {
  const pop = o.pop ?? 20;
  const villagers = [];
  for (let i = 0; i < pop; i++) villagers.push({ name: 'ж' + i, x: CX, y: CY, job: 'idle', hp: 100 });
  for (const h of (o.hunters || [])) {
    for (let i = 0; i < h.n; i++) villagers.push({ name: 'ох' + i, x: h.x, y: h.y, job: 'hunt', hp: 100 });
  }
  const sim = {
    day: o.day ?? 10,
    world: { w: 96, h: 96, startX: CX, startY: CY },
    villagers,
    res: { food: (o.foodDays ?? 10) * pop * 0.7 },
    resCap: { food: 200 },
    buildings: o.buildings || [],
    animals: o.animals || [],
    techs: new Set(o.techs || ['fire', 'hunting']),
    linkHunt: o.mem || createHuntMemory(),
    sys: {},
  };
  if (o.herds) sim.herds = { v: 1, day: sim.day, list: o.herds };
  if (o.kills !== undefined) sim.sys.huntKills = o.kills;
  return sim;
}

const lodge = (x, y) => ({ id: 'hunter_lodge', x, y, done: true, workers: [1, 2, 3] });
const pasture = (x, y) => ({ id: 'pasture', x, y, done: true, workers: [1, 2, 3] });
const kill = (day, o = {}) => ({ day, species: o.species || 'deer', head: o.head ?? 1, food: 10, x: o.x ?? 50, y: o.y ?? 50, herdId: o.herdId || 'h1' });

console.log('--- Спокойная охота молчит ---');
{
  const sim = makeSim({ herds: [herd({ head: 20 })], kills: [] });
  const out = huntLinks(sim);
  t('еды со склада не прибавилось', () => near(out.mods.food, 0, 1e-9, 'food'));
  t('счастье не тронуто', () => near(out.mods.happy, 0, 1e-9, 'happy'));
  t('стадам ничего не правится', () => ok(Object.keys(out.mods.herds).length === 0, JSON.stringify(out.mods.herds)));
  t('рассказывать нечего', () => ok(out.events.length === 0, JSON.stringify(out.events)));
  t('стабильность модуль не трогает вовсе (это делянка link_survival)',
    () => ok(out.mods.stability === undefined, 'в mods появилась stability'));
}

console.log('\n--- Бонус за облаву ---');
{
  const solo = makeSim({ animals: [{ kind: 'deer', x: 50, y: 50, hp: 8 }], hunters: [{ x: 50, y: 50, n: 4 }] });
  t('одиночный зверь бонуса не даёт даже полной артели',
    () => near(huntYieldMult(solo, 50, 50), 1, 1e-9, 'множитель'));

  const big = makeSim({ herds: [herd({ head: BATTUE_FULL_HEAD })], hunters: [{ x: 50, y: 50, n: BATTUE_PARTY_FULL }] });
  const one = makeSim({ herds: [herd({ head: BATTUE_FULL_HEAD })], hunters: [{ x: 50, y: 50, n: 1 }] });
  const mBig = huntYieldMult(big, 50, 50), mOne = huntYieldMult(one, 50, 50);
  t('полное стадо и полная артель дают почти вдвое', () => ok(mBig >= 1.85, `множитель ${mBig}`));
  t('одиночный охотник на стаде получает меньше артели', () => ok(mOne < mBig - 0.3, `${mOne} vs ${mBig}`));
  t('но и он получает прибавку за само стадо', () => ok(mOne > 1.3, `множитель ${mOne}`));
  t('потолок множителя не пробивается', () => ok(mBig <= 1 + BATTUE_MAX * 1.25 + 1e-9, `${mBig}`));

  t('добыча растёт с поголовьем монотонно', () => {
    let prev = 0;
    for (const head of [4, 8, 12, 16, 20, 25, 40]) {
      const s = makeSim({ herds: [herd({ head })], hunters: [{ x: 50, y: 50, n: 2 }] });
      const m = huntYieldMult(s, 50, 50);
      ok(m >= prev - 1e-9, `на ${head} головах множитель упал: ${m} < ${prev}`);
      prev = m;
    }
  });
  t('добыча растёт с числом охотников монотонно', () => {
    let prev = 0;
    for (const n of [1, 2, 3, 4, 8]) {
      const s = makeSim({ herds: [herd({ head: 20 })], hunters: [{ x: 50, y: 50, n }] });
      const m = huntYieldMult(s, 50, 50);
      ok(m >= prev - 1e-9, `при ${n} охотниках множитель упал: ${m} < ${prev}`);
      prev = m;
    }
  });
  t('стадо меньше порога облавой не считается', () => {
    const s = makeSim({ herds: [herd({ head: BATTUE_MIN_HEAD - 1 })], hunters: [{ x: 50, y: 50, n: 4 }] });
    near(huntYieldMult(s, 50, 50), 1, 1e-9, 'множитель');
  });
  t('пуганое стадо даёт меньше спокойного', () => {
    const calm = makeSim({ herds: [herd({ head: 20, fear: 0 })], hunters: [{ x: 50, y: 50, n: 3 }] });
    const shy = makeSim({ herds: [herd({ head: 20, fear: 1 })], hunters: [{ x: 50, y: 50, n: 3 }] });
    ok(huntYieldMult(shy, 50, 50) < huntYieldMult(calm, 50, 50) * 0.6,
      `${huntYieldMult(shy, 50, 50)} против ${huntYieldMult(calm, 50, 50)}`);
  });
  t('прирученное стадо — уже не дичь, бонуса нет', () => {
    const s = makeSim({ herds: [herd({ head: 25, tame: true })], hunters: [{ x: 50, y: 50, n: 4 }] });
    near(huntYieldMult(s, 50, 50), 1, 1e-9, 'множитель');
  });
  t('вне участка стада бонуса нет', () => {
    const s = makeSim({ herds: [herd({ head: 25, x: 50, y: 50, r: 6 })], hunters: [{ x: 80, y: 80, n: 4 }] });
    near(huntYieldMult(s, 80, 80), 1, 1e-9, 'множитель');
  });
  t('мамонт в облаве выгоднее оленя, кабан — хуже', () => {
    const mk = sp => huntYieldMult(makeSim({ herds: [herd({ head: 20, species: sp })], hunters: [{ x: 50, y: 50, n: 4 }] }), 50, 50);
    ok(mk('mammoth') > mk('deer') && mk('deer') > mk('boar'), `${mk('mammoth')} / ${mk('deer')} / ${mk('boar')}`);
  });
  t('модели стад нет — связь не падает и бонуса не выдумывает',
    () => near(huntYieldMult(makeSim({}), 50, 50), 1, 1e-9, 'множитель'));
}

console.log('\n--- Место охотничьей стоянки ---');
{
  const empty = makeSim({ herds: [herd({ head: 30, x: 90, y: 90 })], buildings: [lodge(48, 48)] });
  const rich = makeSim({ herds: [herd({ head: 30, x: 50, y: 50 })], buildings: [lodge(48, 48)] });
  t('стоянка в пустой степи опускается ровно до пола',
    () => near(huntLodgeMult(empty, empty.buildings[0]), LODGE_MIN, 1e-9, 'множитель'));
  t('стоянка у стада работает заметно лучше',
    () => ok(huntLodgeMult(rich, rich.buildings[0]) >= 1.4, `${huntLodgeMult(rich, rich.buildings[0])}`));
  t('потолок стоянки не пробивается', () => {
    const huge = makeSim({ herds: [herd({ head: 500, x: 50, y: 50 })], buildings: [lodge(48, 48)] });
    ok(huntLodgeMult(huge, huge.buildings[0]) <= LODGE_MAX + 1e-9, `${huntLodgeMult(huge, huge.buildings[0])}`);
  });
  t('выработка стоянки растёт с поголовьем монотонно', () => {
    let prev = 0;
    for (const head of [0, 5, 10, 20, 30, 60]) {
      const s = makeSim({ herds: [herd({ head, x: 50, y: 50 })], buildings: [lodge(48, 48)] });
      const k = huntLodgeMult(s, s.buildings[0]);
      ok(k >= prev - 1e-9, `на ${head} головах ${k} < ${prev}`);
      prev = k;
    }
  });
  t('пугливость режет прибавку, но не уводит ниже пола', () => {
    const shy = makeSim({ herds: [herd({ head: 30, x: 50, y: 50, fear: 1 })], buildings: [lodge(48, 48)] });
    const k = huntLodgeMult(shy, shy.buildings[0]);
    ok(k >= LODGE_MIN && k < huntLodgeMult(rich, rich.buildings[0]), `${k}`);
  });
  t('дичь дальше радиуса стоянке не помогает', () => {
    const far = makeSim({ herds: [herd({ head: 30, x: 48 + LODGE_RADIUS + 20, y: 48 })], buildings: [lodge(48, 48)] });
    near(huntLodgeMult(far, far.buildings[0]), LODGE_MIN, 1e-9, 'множитель');
  });
  t('дневной отчёт кладёт готовый множитель в кэш', () => {
    const out = huntLinks(rich);
    rich.sys.huntLinks = out;
    ok(out.flags.lodges['48,48'] > 1.4, JSON.stringify(out.flags.lodges));
    near(huntLodgeMult(rich, rich.buildings[0]), out.flags.lodges['48,48'], 1e-9, 'кэш');
  });
  t('про стоянку в пустой степи сказано словами', () => {
    const out = huntLinks(empty);
    ok(out.events.some(e => /пуст/i.test(e.text)), JSON.stringify(out.events));
  });
}

console.log('\n--- Истощение: журнал добычи ---');
{
  const mem = createHuntMemory();
  const s1 = makeSim({ day: 100, herds: [herd({ head: 40 })], mem, kills: [kill(100), kill(100), kill(100)] });
  const o1 = huntLinks(s1);
  t('добыча за сутки посчитана', () => ok(o1.flags.killsToday === 3, `${o1.flags.killsToday}`));
  t('записи за одни сутки слиты в одну (журнал не растёт по записи на зверя)',
    () => ok(o1.flags.memory.kills.length === 1, JSON.stringify(o1.flags.memory.kills)));
  t('в журнале три головы', () => ok(o1.flags.memory.kills[0].n === 3, JSON.stringify(o1.flags.memory.kills)));

  const s2 = makeSim({ day: 101, herds: [herd({ head: 37 })], mem: o1.flags.memory, kills: [kill(101, { head: 2 })] });
  const o2 = huntLinks(s2);
  t('за месяц копится сумма', () => ok(o2.flags.kills30 === 5, `${o2.flags.kills30}`));
  t('поголовье на начало окна = осталось + выбито', () => ok(o2.flags.wasHead === 37 + 5, `${o2.flags.wasHead}`));

  const s3 = makeSim({ day: 100 + KILL_WINDOW, herds: [herd({ head: 37 })], mem: o2.flags.memory, kills: [] });
  const o3 = huntLinks(s3);
  t('старше месяца из журнала выпадает (сейв не тащит историю за годы)',
    () => ok(o3.flags.kills30 === 2, `${o3.flags.kills30}`));

  t('запасной способ: без отметок ядра добыча видна по падению поголовья', () => {
    const m = createHuntMemory();
    const a = makeSim({ day: 5, herds: [herd({ head: 40 })], mem: m });
    delete a.sys.huntKills;
    const oa = huntLinks(a);
    const b = makeSim({ day: 6, herds: [herd({ head: 33 })], mem: oa.flags.memory });
    delete b.sys.huntKills;
    ok(huntLinks(b).flags.killsToday === 7, 'падение поголовья не поймано');
  });
}

console.log('\n--- Истощение: предупреждение ДО беды ---');
{
  const mem = createHuntMemory();
  // 14 голов за сутки из 40 — приплод такого не догонит.
  const sim = makeSim({ day: 200, herds: [herd({ head: 26 })], mem, kills: [kill(200, { head: 14 })] });
  const out = huntLinks(sim);
  t('давление посчитано выше порога тревоги', () => ok(out.flags.pressure >= PRESSURE_WARN, `${out.flags.pressure}`));
  const warn = out.events.find(e => /за месяц выбито/.test(e.text));
  t('предупреждение сказано словами', () => ok(warn, JSON.stringify(out.events)));
  t('в предупреждении названы оба числа: сколько выбито и из скольких',
    () => ok(/14 голов из 40/.test(warn.text), warn.text));
  t('в предупреждении сказано про приплод', () => ok(/приплод/.test(warn.text), warn.text));
  t('и назван выход из петли', () => ok(/сбавить/i.test(warn.text), warn.text));

  const again = makeSim({ day: 201, herds: [herd({ head: 20 })], mem: out.flags.memory, kills: [kill(201, { head: 6 })] });
  t('назавтра то же самое не бубнится',
    () => ok(!huntLinks(again).events.some(e => /за месяц выбито/.test(e.text)), 'повтор предупреждения'));

  const later = makeSim({ day: 200 + SAY_COOLDOWN, herds: [herd({ head: 14 })], mem: out.flags.memory, kills: [kill(200 + SAY_COOLDOWN, { head: 4 })] });
  t('через положенный срок связь напоминает снова',
    () => ok(huntLinks(later).events.some(e => /за месяц выбито/.test(e.text)), 'напоминания нет'));

  t('при двойном перебое текст жёстче и говорит про откочёвку', () => {
    const hard = makeSim({ day: 300, herds: [herd({ head: 10 })], mem: createHuntMemory(), kills: [kill(300, { head: 20 })] });
    const o = huntLinks(hard);
    ok(o.flags.pressure >= PRESSURE_FLEE, `давление ${o.flags.pressure}`);
    ok(o.events.some(e => /откочёвыва/.test(e.text)), JSON.stringify(o.events));
  });
  t('последняя черта названа отдельно', () => {
    const last = makeSim({ day: 400, herds: [herd({ head: 3 })], mem: createHuntMemory(), kills: [kill(400, { head: 2 })] });
    ok(huntLinks(last).events.some(e => /почти не осталось/.test(e.text)), 'нет предупреждения о последних головах');
  });
}

console.log('\n--- Пугливость и откочёвка ---');
{
  const hunted = makeSim({ day: 50, herds: [herd({ head: 20, fear: 0.1 })], mem: createHuntMemory(), kills: [kill(50, { head: 3 })] });
  const oh = huntLinks(hunted);
  t('после охоты стадо пугается', () => ok(oh.mods.herds.h1.fear > 0, JSON.stringify(oh.mods.herds)));
  t('за одни сутки страх растёт не больше потолка', () => {
    const залп = makeSim({ day: 50, herds: [herd({ head: 5, fear: 0 })], mem: createHuntMemory(), kills: [kill(50, { head: 50 })] });
    const o = huntLinks(залп);
    ok(o.mods.herds.h1.fear <= FEAR_DAY_CAP + 1e-9, `${o.mods.herds.h1.fear}`);
  });
  t('без охоты страх тает (выход из петли)', () => {
    const calm = makeSim({ day: 51, herds: [herd({ head: 20, fear: 0.5 })], mem: createHuntMemory(), kills: [] });
    near(huntLinks(calm).mods.herds.h1.fear, -FEAR_CALM, 1e-9, 'затухание');
  });
  t('страх не уходит ниже нуля', () => {
    const calm = makeSim({ day: 51, herds: [herd({ head: 20, fear: 0.01 })], mem: createHuntMemory(), kills: [] });
    const d = huntLinks(calm).mods.herds.h1;
    ok(!d || Math.abs(d.fear) <= 0.01 + 1e-9, JSON.stringify(d));
  });
  t('страх не поднимается выше единицы', () => {
    const s = makeSim({ day: 50, herds: [herd({ head: 5, fear: 1 })], mem: createHuntMemory(), kills: [kill(50, { head: 10 })] });
    near(huntLinks(s).mods.herds.h1.fear, 0, 1e-9, 'прибавка к предельному страху');
  });
  t('испуганное стадо уходит ОТ поселения', () => {
    const s = makeSim({ day: 50, herds: [herd({ head: 20, x: CX + 10, y: CY, fear: FLEE_FEAR })], mem: createHuntMemory(), kills: [kill(50, { head: 4, x: CX + 10, y: CY })] });
    const d = huntLinks(s).mods.herds.h1;
    ok(d.dx > 0 && Math.abs(d.dy) < 1e-9, JSON.stringify(d));
  });
  t('потолок откочёвки: дальше предела стадо не гонят', () => {
    const s = makeSim({ day: 50, herds: [herd({ head: 20, x: CX + FLEE_MAX_DIST + 1, y: CY, fear: 0.9 })], mem: createHuntMemory(), kills: [kill(50, { head: 4, x: CX + FLEE_MAX_DIST + 1, y: CY })] });
    const d = huntLinks(s).mods.herds.h1;
    ok(d.dx === 0 && d.dy === 0, JSON.stringify(d));
  });
  t('успокоившееся стадо возвращается к поселению', () => {
    const s = makeSim({ day: 50, herds: [herd({ head: 20, x: CX + RETURN_DIST + 8, y: CY, fear: 0.05 })], mem: createHuntMemory(), kills: [] });
    const d = huntLinks(s).mods.herds.h1;
    ok(d.dx < 0, JSON.stringify(d));
  });
}

console.log('\n--- Один день считается один раз ---');
{
  const mem = createHuntMemory();
  const sim = makeSim({
    day: 70, mem, kills: [kill(70, { head: 4 })],
    herds: [herd({ head: 20 }), herd({ id: 'h2', head: 30, tame: true, x: 46, y: 46 })],
    buildings: [pasture(46, 46)], techs: ['fire', 'hunting', 'animal_husbandry'],
  });
  const a = huntLinks(sim);
  sim.linkHunt = a.flags.memory;              // как это сделает integrate.js
  sim.day = 70;                               // те же сутки
  const b = huntLinks(sim);
  t('повторный вызов не записывает добычу дважды',
    () => ok(b.flags.kills30 === a.flags.kills30, `${a.flags.kills30} → ${b.flags.kills30}`));
  t('повторный вызов не начисляет корм со скота дважды',
    () => ok(a.mods.food > 0 && b.mods.food === 0, `${a.mods.food} → ${b.mods.food}`));
  t('повторный вызов не двигает стада второй раз',
    () => ok(Object.keys(b.mods.herds).length === 0, JSON.stringify(b.mods.herds)));
  t('повторный вызов молчит', () => ok(b.events.length === 0, JSON.stringify(b.events)));
  t('множители при этом считаются как обычно (это не накопление)',
    () => ok(b.mods.yieldMult === a.mods.yieldMult, `${a.mods.yieldMult} → ${b.mods.yieldMult}`));
}

console.log('\n--- Модуль ничего не мутирует ---');
{
  const sim = makeSim({
    day: 80, herds: [herd({ head: 20, fear: 0.3 })], kills: [kill(80, { head: 5 })],
    buildings: [lodge(48, 48), pasture(46, 46)],
  });
  const before = JSON.stringify(sim);
  huntLinks(sim);
  huntBreakdown(sim);
  huntState(sim);
  tameCandidates(sim);
  t('sim не изменился ни на байт', () => ok(JSON.stringify(sim) === before, 'модуль тронул состояние'));
  t('память связи в sim осталась прежней',
    () => ok(sim.linkHunt.kills.length === 0, JSON.stringify(sim.linkHunt.kills)));
}

console.log('\n--- Провал охоты: сигнал лестнице голода, а не вторая лестница ---');
{
  const mem = createHuntMemory();
  // Поселение месяц кормилось охотой, а дичь ушла.
  for (let d = 0; d < 20; d++) mem.kills.push({ d: 100 + d, s: 'deer', n: 2 });
  const sim = makeSim({ day: 120, pop: 10, foodDays: 3, herds: [herd({ head: 0, x: 90, y: 90 })], mem, kills: [] });
  const out = huntLinks(sim);
  t('риск голода от провала охоты посчитан', () => ok(out.flags.starveRisk > 0.4, `${out.flags.starveRisk}`));
  t('доля прокорма на охоте посчитана', () => ok(out.flags.huntShare > 0.5, `${out.flags.huntShare}`));
  t('дичи рядом нет — доступность на нуле', () => ok(out.flags.availability === 0, `${out.flags.availability}`));
  t('охотники ходят пустыми — настроение падает', () => ok(out.mods.happy < 0, `${out.mods.happy}`));
  t('но не глубже своего потолка (лестница голода — не наша)',
    () => ok(out.mods.happy >= -HAPPY_EMPTY_MAX, `${out.mods.happy}`));
  t('счётчик пустых суток пошёл', () => ok(out.flags.failDays === 1, `${out.flags.failDays}`));
  t('в отчёте нет ни стабильности, ни сословий (иначе двойной удар за один голод)',
    () => ok(out.mods.stability === undefined && out.mods.estates === undefined, JSON.stringify(Object.keys(out.mods))));

  let m = out.flags.memory, ev = null;
  for (let d = 121; d <= 125; d++) {
    const s = makeSim({ day: d, pop: 10, foodDays: 2, herds: [herd({ head: 0, x: 90, y: 90 })], mem: m, kills: [] });
    const o = huntLinks(s);
    m = o.flags.memory;
    ev = ev || o.events.find(e => /Охота кормила/.test(e.text));
  }
  t('о провале охоты сказано словами до пустого склада', () => ok(ev, 'предупреждения нет'));
  t('в словах названы и рты, и остаток запаса', () => ok(/ртов из 10/.test(ev.text) && /Запаса на/.test(ev.text), ev.text));
  t('счётчик пустых суток тает вдвое быстрее, чем копится', () => {
    const good = makeSim({ day: 130, pop: 10, foodDays: 20, herds: [herd({ head: 40 })], mem: m, kills: [] });
    const o = huntLinks(good);
    ok(o.flags.failDays <= Math.max(0, m.failDays - 2), `${m.failDays} → ${o.flags.failDays}`);
  });
}

console.log('\n--- Приручение: выбор игрока, а не автоматика ---');
{
  const base = { herds: [herd({ id: 'bull', species: 'aurochs', head: 20, x: 46, y: 46 })], buildings: [pasture(46, 46)] };
  t('без скотоводства нельзя, причина названа', () => {
    const c = tameCandidates(makeSim({ ...base }))[0];
    ok(!c.ok && /скотовод/i.test(c.why), JSON.stringify(c));
  });
  t('без пастбища нельзя, причина названа', () => {
    const c = tameCandidates(makeSim({ ...base, buildings: [], techs: ['fire', 'hunting', 'animal_husbandry'] }))[0];
    ok(!c.ok && /пастбищ/i.test(c.why), JSON.stringify(c));
  });
  t('пастбище далеко — тоже нельзя, и сказано насколько', () => {
    const c = tameCandidates(makeSim({ ...base, buildings: [pasture(46 + TAME_RADIUS + 5, 46)], techs: ['fire', 'hunting', 'animal_husbandry'] }))[0];
    ok(!c.ok && /далеко/.test(c.why), JSON.stringify(c));
  });
  t('мамонта не приручить никогда', () => {
    const c = tameCandidates(makeSim({ herds: [herd({ id: 'm', species: 'mammoth', head: 20, x: 46, y: 46 })], buildings: [pasture(46, 46)], techs: ['fire', 'hunting', 'animal_husbandry'] }))[0];
    ok(!c.ok && /не приручается/.test(c.why), JSON.stringify(c));
  });
  t('малое стадо не приручить', () => {
    const c = tameCandidates(makeSim({ herds: [herd({ id: 'b', species: 'aurochs', head: TAME_MIN_HEAD - 1, x: 46, y: 46 })], buildings: [pasture(46, 46)], techs: ['fire', 'hunting', 'animal_husbandry'] }))[0];
    ok(!c.ok && /Мало голов/.test(c.why), JSON.stringify(c));
  });
  t('пуганое стадо к людям не идёт', () => {
    const c = tameCandidates(makeSim({ herds: [herd({ id: 'b', species: 'aurochs', head: 20, fear: TAME_MAX_FEAR + 0.2, x: 46, y: 46 })], buildings: [pasture(46, 46)], techs: ['fire', 'hunting', 'animal_husbandry'] }))[0];
    ok(!c.ok && /пуган/.test(c.why), JSON.stringify(c));
  });

  const ready = makeSim({ ...base, techs: ['fire', 'hunting', 'animal_husbandry'] });
  const cand = tameCandidates(ready)[0];
  t('всё сошлось — стадо можно приручить', () => ok(cand.ok, JSON.stringify(cand)));
  t('цена выбора показана числом (сколько еды в день)',
    () => near(cand.food, 20 * TAME_FOOD_PER_HEAD, 1e-9, 'еда'));
  const order = tameHerd(ready, 'bull');
  t('приказ игрока возвращает отчёт, а не меняет мир',
    () => ok(order.ok && order.mods.tame[0] === 'bull' && ready.herds.list[0].tame === false, JSON.stringify(order.mods)));
  t('приказ объясняется словами', () => ok(/приручено/i.test(order.events[0].text), order.events[0].text));
  t('приказ по несуществующему стаду не роняет модуль',
    () => ok(tameHerd(ready, 'нет-такого').ok === false, 'ожидали отказ'));
  t('связь один раз сама подсказывает возможность приручения',
    () => ok(huntLinks(ready).events.some(e => /можно приручить/.test(e.text)), JSON.stringify(huntLinks(ready).events)));

  const tamed = makeSim({
    herds: [herd({ id: 'bull', species: 'aurochs', head: 20, x: 46, y: 46, tame: true })],
    buildings: [pasture(46, 46)], techs: ['fire', 'hunting', 'animal_husbandry'],
  });
  const ot = huntLinks(tamed);
  t('прирученное стадо кормит каждый день', () => near(ot.mods.food, 20 * TAME_FOOD_PER_HEAD, 1e-9, 'еда'));
  t('прирученное перестаёт быть дичью', () => ok(ot.flags.wildHead === 0 && ot.flags.tameHead === 20, JSON.stringify(ot.flags)));
  t('свой скот у дома поднимает настроение', () => ok(ot.mods.happy > 0, `${ot.mods.happy}`));
  t('потолок: скот сверх вместимости пастбищ не кормит', () => {
    const many = makeSim({
      herds: [herd({ id: 'b', species: 'aurochs', head: TAME_PER_PASTURE * 3, x: 46, y: 46, tame: true })],
      buildings: [pasture(46, 46)], techs: ['fire', 'hunting', 'animal_husbandry'],
    });
    const o = huntLinks(many);
    near(o.mods.food, TAME_PER_PASTURE * TAME_FOOD_PER_HEAD, 1e-9, 'еда');
    ok(o.reasons.some(r => /впроголодь/.test(r.ru)), JSON.stringify(o.reasons));
  });
  t('скот без пастбища кормить негде — и это сказано', () => {
    const nop = makeSim({ herds: [herd({ id: 'b', species: 'aurochs', head: 20, tame: true })], techs: ['fire', 'hunting', 'animal_husbandry'] });
    const o = huntLinks(nop);
    near(o.mods.food, 0, 1e-9, 'еда');
    ok(o.reasons.some(r => /кормить негде/.test(r.ru)), JSON.stringify(o.reasons));
  });
}

console.log('\n--- Вымирание вида ---');
{
  const mem = createHuntMemory();
  const alive = makeSim({ day: 500, herds: [herd({ id: 'm', species: 'mammoth', head: 2 })], mem, kills: [] });
  const o1 = huntLinks(alive);
  t('пока вид жив — молчим', () => ok(!o1.events.some(e => /подчистую/.test(e.text)), JSON.stringify(o1.events)));

  const gone = makeSim({ day: 501, herds: [herd({ id: 'm', species: 'mammoth', head: 0 })], mem: o1.flags.memory, kills: [] });
  const o2 = huntLinks(gone);
  t('вид выбит — сказано словами', () => ok(o2.events.some(e => /подчистую/.test(e.text)), JSON.stringify(o2.events)));
  t('вид записан один раз', () => ok(o2.flags.extinctToday.length === 1 && o2.flags.extinct.includes('mammoth'), JSON.stringify(o2.flags.extinctToday)));

  const after = makeSim({ day: 502, herds: [herd({ id: 'm', species: 'mammoth', head: 0 })], mem: o2.flags.memory, kills: [] });
  const o3 = huntLinks(after);
  t('назавтра о том же не рассказывается второй раз (память хранит событие, а не состояние)',
    () => ok(o3.flags.extinctToday.length === 0 && !o3.events.some(e => /подчистую/.test(e.text)), JSON.stringify(o3.events)));

  t('вымирание уходит в летопись шрамом известной породы', () => {
    const scars = huntScars(o2);
    ok(scars.length === 1 && KIND[scars[0].kind], JSON.stringify(scars));
    ok(scars[0].kind === EXTINCT_SCAR_KIND && scars[0].scale > 0, JSON.stringify(scars));
  });
  t('на спокойных сутках летописи ничего не передаётся', () => ok(huntScars(o3).length === 0, 'лишний шрам'));
  t('без источника зверья вымирание не объявляется (пропавшая модель — не мор)', () => {
    const m = createHuntMemory();
    m.seen.deer = 9;
    const nothing = makeSim({ day: 10, mem: m });
    delete nothing.animals;
    ok(huntLinks(nothing).flags.extinctToday.length === 0, 'объявлено вымирание на пустом месте');
  });
  t('давний вид не «вымирает» задним числом после долгого сейва', () => {
    const m = createHuntMemory();
    m.seen.boar = 100;
    const late = makeSim({ day: 900, herds: [herd({ head: 10 })], mem: m });
    ok(huntLinks(late).flags.extinctToday.length === 0, 'вымирание объявлено спустя сотни дней');
  });
}

console.log('\n--- Сохранение ---');
{
  const mem = createHuntMemory();
  const sim = makeSim({ day: 300, herds: [herd({ head: 20 })], mem, kills: [kill(300, { head: 3 })] });
  const saved = huntLinks(sim).flags.memory;
  const round = restoreHuntMemory(JSON.parse(JSON.stringify(saved)));
  t('круг сохранения: записали, прочитали, совпало',
    () => ok(JSON.stringify(round.kills) === JSON.stringify(saved.kills) && round.day === saved.day,
      `${JSON.stringify(round)} ≠ ${JSON.stringify(saved)}`));
  t('битый файл не роняет модуль', () => {
    const junk = restoreHuntMemory({ day: 'ерунда', kills: [null, 5, { n: -3 }, { d: 'x', s: 'нет-такого', n: 2 }], seen: 'нет', extinct: [1, 2] });
    ok(junk.kills.length === 1 && junk.kills[0].s === 'wild' && junk.day === -1, JSON.stringify(junk));
  });
  t('пустой и чужой файл дают чистую память',
    () => ok(restoreHuntMemory(null).kills.length === 0 && restoreHuntMemory(42).day === -1, 'мусор просочился'));
  t('старый сейв без новых полей не роняет модуль', () => {
    const old = restoreHuntMemory({ v: 1, day: 5 });
    const s = makeSim({ day: 6, herds: [herd({ head: 10 })], mem: old, kills: [] });
    ok(huntLinks(s).flags.kills30 === 0, 'старый сейв сломал счёт');
  });
  t('битая память в самом sim не роняет связь', () => {
    const s = makeSim({ day: 6, herds: [herd({ head: 10 })], kills: [] });
    s.linkHunt = 'мусор';
    ok(typeof huntLinks(s).flags.pressure === 'number', 'связь упала на битой памяти');
  });
  t('битые стада в sim не роняют связь', () => {
    const s = makeSim({ day: 6, kills: [] });
    s.herds = { list: [null, 7, { head: 'много' }, { id: 'x', species: 'дракон', head: 5, x: 50, y: 50 }] };
    const o = huntLinks(s);
    ok(o.flags.wildHead === 5, `${o.flags.wildHead}`);
  });
  t('счастье для happiness() читается из памяти', () => {
    const s = makeSim({});
    s.linkHunt = { ...createHuntMemory(), happyMod: -2.4 };
    ok(huntHappyMod(s) === -2, `${huntHappyMod(s)}`);
  });
}

console.log('\n--- Разбор для панели ---');
{
  const mem = createHuntMemory();
  mem.kills.push({ d: 10, s: 'deer', n: 14 });
  const sim = makeSim({ day: 12, herds: [herd({ head: 26 })], mem });
  const b = huntBreakdown(sim);
  t('строка для игрока собрана', () => ok(/за месяц выбито 14 гол. из 40/.test(b.text), b.text));
  t('виды перечислены', () => ok(b.rows.length === 1 && b.rows[0].head === 26, JSON.stringify(b.rows)));
  t('пустая округа объясняется словами',
    () => ok(/не кормит/.test(huntBreakdown(makeSim({ herds: [] })).text), huntBreakdown(makeSim({ herds: [] })).text));
  t('нетронутые стада тоже названы',
    () => ok(/не тронуты/.test(huntBreakdown(makeSim({ herds: [herd({ head: 30 })] })).text), 'нет строки про целые стада'));
  t('разбор не двигает память', () => {
    const s = makeSim({ day: 12, herds: [herd({ head: 26 })], mem });
    const snap = JSON.stringify(s.linkHunt);
    huntBreakdown(s);
    ok(JSON.stringify(s.linkHunt) === snap, 'разбор тронул память');
  });
}

console.log('\n--- Раскладка полей настоящей модели стад ---');
{
  // Так стадо выглядит в herds.js: kind вместо species, n вместо head,
  // cx/cy вместо x/y, поголовье дробное, радиуса в стаде нет вовсе.
  const real = (o = {}) => ({
    id: o.id ?? 1, kind: o.kind || 'deer', n: o.n ?? 20.6,
    cx: o.cx ?? 50, cy: o.cy ?? 50, tx: 50, ty: 50,
    fear: o.fear ?? 0, leader: 'Рогач', since: 0, lastHunt: -9999, doomed: false, wander: 0,
  });
  const sim = makeSim({ hunters: [{ x: 50, y: 50, n: 3 }] });
  sim.herds = { v: 1, day: 10, herds: [real(), real({ id: 2, kind: 'aurochs', n: 9.9, cx: 44, cy: 44 })], seen: {}, gone: {} };
  const out = huntLinks(sim);
  t('поголовье читается из полей kind/n/cx/cy', () => ok(out.flags.wildHead === 20 + 9, `${out.flags.wildHead}`));
  t('дробные головы округляются вниз: туша либо есть, либо нет',
    () => ok(huntState(sim).bySpecies.deer === 20, JSON.stringify(huntState(sim).bySpecies)));
  t('участок находится по радиусу вида, раз модель его не прислала',
    () => ok(huntYieldMult(sim, 50 + 6, 50) > 1, `${huntYieldMult(sim, 50 + 6, 50)}`));
  t('дальше радиуса вида участок не тянется',
    () => near(huntYieldMult(sim, 50 + 12, 50), 1, 1e-9, 'множитель'));
  t('вид, уже объявленный моделью выбитым, второй раз не хоронится', () => {
    const m = createHuntMemory();
    m.seen.mammoth = 100;
    const s2 = makeSim({ day: 101, mem: m });
    s2.herds = { v: 1, day: 101, herds: [real()], seen: {}, gone: { mammoth: 100 } };
    const o = huntLinks(s2);
    ok(o.flags.extinctToday.length === 0 && huntScars(o).length === 0, JSON.stringify(o.flags.extinctToday));
    ok(o.flags.memory.extinct.mammoth === 101, 'отметка о виде не поставлена — завтра расскажем снова');
  });
  t('артель у стада посчитана', () => ok(huntParty(sim, 50, 50) === 3, `${huntParty(sim, 50, 50)}`));
  t('охотник всегда хотя бы один: модель стад делит на это число',
    () => ok(huntParty(sim, 90, 90) === 1, `${huntParty(sim, 90, 90)}`));
}

console.log('\n--- Скот, отданный моделью стад ---');
{
  // herds.js прирученное стадо из своего списка убирает — головы забирает
  // счётчик скота этой связи.
  const mem = withStock(createHuntMemory(), 'aurochs', 18);
  const sim = makeSim({ mem, buildings: [pasture(46, 46)], techs: ['fire', 'hunting', 'animal_husbandry'] });
  sim.herds = { v: 1, day: 10, herds: [], seen: {}, gone: {} };
  const out = huntLinks(sim);
  t('приручённые головы кормят каждый день', () => near(out.mods.food, 18 * TAME_FOOD_PER_HEAD, 1e-9, 'еда'));
  t('и видны в отчёте как скот, а не как дичь',
    () => ok(out.flags.stockHead === 18 && out.flags.wildHead === 0, JSON.stringify(out.flags)));
  t('withStock не трогает переданную память', () => {
    const before = createHuntMemory();
    withStock(before, 'aurochs', 5);
    ok(Object.keys(before.stock).length === 0, JSON.stringify(before.stock));
  });
  t('withStock складывает стада, а не подменяет',
    () => ok(withStock(mem, 'aurochs', 7).stock.aurochs === 25, JSON.stringify(withStock(mem, 'aurochs', 7).stock)));
  t('мусор на входе withStock не роняет и не портит счёт',
    () => ok(withStock(null, 'нет-такого', 'много').stock.wild === undefined, 'мусор просочился в счёт'));
  t('скот переживает сохранение',
    () => ok(restoreHuntMemory(JSON.parse(JSON.stringify(mem))).stock.aurochs === 18, 'скот потерян при загрузке'));
}

console.log('\n--- На настоящей симуляции ---');
{
  const sim = new Simulation(11, { startEra: 0 });
  for (let d = 0; d < 40; d++) sim.tick(1);
  const out = huntLinks(sim);
  t('связь работает на живой партии, а не только на подделке',
    () => ok(typeof out.flags.pressure === 'number' && typeof out.mods.yieldMult === 'number', JSON.stringify(out.flags)));
  t('поголовье читается из настоящей модели стад, а не из фигурок ядра', () => {
    const list = (sim.herds && (sim.herds.herds || sim.herds.list)) || [];
    ok(list.length > 0, 'в живой партии нет ни одного стада');
    const heads = list.reduce((a, h) => a + Math.floor(h.n != null ? h.n : h.head), 0);
    ok(out.flags.wildHead === heads, `${out.flags.wildHead} против ${heads}`);
  });
  t('участок стада найден по его настоящим полям (cx/cy/kind/n)', () => {
    const list = (sim.herds && (sim.herds.herds || sim.herds.list)) || [];
    const h = list.find(g => Math.floor(g.n) >= 4);
    ok(!h || huntYieldMult(sim, h.cx, h.cy) > 1, 'облава на живом стаде не даёт прибавки');
  });
  t('без модели стад зверьё ядра видно как одиночки', () => {
    const s = makeSim({ animals: [{ kind: 'deer', x: 50, y: 50, hp: 8 }, { kind: 'deer', x: 51, y: 51, hp: 8 }] });
    ok(huntLinks(s).flags.wildHead === 2, 'одиночки не посчитаны');
  });
  t('множитель добычи на живой карте конечен', () => {
    const a = sim.animals[0];
    const m = a ? huntYieldMult(sim, a.x, a.y) : 1;
    ok(Number.isFinite(m) && m >= 1, `${m}`);
  });
  t('разбор работает на живой партии', () => ok(typeof huntBreakdown(sim).text === 'string', 'нет текста'));
  t('два прогона одного сида дают один и тот же отчёт (сейвы и «тень» держатся на этом)', () => {
    const a = new Simulation(7, { startEra: 0 });
    const b = new Simulation(7, { startEra: 0 });
    for (let d = 0; d < 30; d++) { a.tick(1); b.tick(1); }
    const fa = JSON.stringify(huntLinks(a).flags), fb = JSON.stringify(huntLinks(b).flags);
    ok(fa === fb, 'отчёты разошлись');
  });
  t('Math.random в модуле не вызывается (иначе ломались бы сейвы и «тень прошлой партии»)', () => {
    const src = readFileSync(new URL('../src/core/systems/link_hunt.js', import.meta.url), 'utf8');
    ok(!/Math\.random\s*\(/.test(src), 'найден вызов Math.random');
  });
  t('модуль не тянет sim.rng: случайности в охоте нет вовсе', () => {
    const src = readFileSync(new URL('../src/core/systems/link_hunt.js', import.meta.url), 'utf8');
    ok(!/\brng\b/.test(src.replace(/\/\/[^\n]*/g, '')), 'найдено обращение к rng');
  });
}

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
if (fail) process.exit(1);
