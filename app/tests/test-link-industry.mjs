// Тесты связи «цепочки ↔ люди ↔ казна ↔ наука ↔ эпоха» (link_industry.js).
// Запуск: node app/tests/test-link-industry.mjs
//
// Проверяем не «функция не упала», а ЧИСЛА: направление связи, точные величины,
// потолки петель, крайние случаи и молчание при спокойном ходе дел.
import { Simulation } from '../src/core/simulation.js';
import { createProduction, INTERMEDIATES } from '../src/core/systems/production.js';
import {
  industryLinks, industryBreakdown, industryState, industryLinkHappyMod,
  createIndustryMemory, restoreIndustryMemory,
  IDLE_HAPPY_MAX, IDLE_GOLD_SHARE, IDLE_ESTATE, ESTATE_DROP_CAP,
  IDLE_STAB, IDLE_STAB_DAYS, IDLE_STAB_FROM, STAB_FLOOR, IDLE_LOUD,
  WEAR_LOAD, WEAR_ARREARS, WEAR_AGE, WEAR_ARREARS_FULL, WEAR_DAY_CAP,
  WEAR_MAX, WEAR_AFTER, WEAR_SCHOOL, REPAIR_BASE, REPAIR_SCHOOL, ACCIDENT_CD,
  ACC_STOCK_LOSS, ACC_STAB, ACC_HAPPY, ACC_GOLD_BASE, ACC_ESTATE,
  KNOW_FROM, KNOW_MAX, KNOW_BASE_SHARE, SPEED_MAX,
  SKILL_WEIGHT, SCHOOL_EACH, SCHOOL_CAP, ESTATES,
} from '../src/core/systems/link_industry.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≠ ${b}`);

// ------------------------------------------------------------ поддельный мир
// Связь читает только эти поля. Подделка позволяет поставить ровно то
// состояние, которое проверяется, без прогона тысячи игровых дней.
function makeSim(o = {}) {
  const prod = createProduction();
  if (o.stock) for (const [k, v] of Object.entries(o.stock)) prod.stock[k] = v;
  const era = o.era ?? 0;
  const buildings = (o.buildings || []).map(b => (typeof b === 'string'
    ? { id: b, done: true, destroyed: false, workers: [], eraBuilt: era, hp: 100 }
    : { done: true, destroyed: false, workers: [], eraBuilt: era, hp: 100, ...b }));
  return {
    day: o.day ?? 100,
    eraIndex: era,
    seasonIdx: o.seasonIdx ?? 1,
    weather: o.weather ?? 'sun',
    techs: new Set(o.techs || []),
    res: { gold: o.gold ?? 100, knowledge: 0, food: 100, wood: 100, steel: 0 },
    resCap: { gold: 99999, knowledge: 99999, food: 200, wood: 400, steel: 500 },
    buildings,
    villagers: Array.from({ length: o.pop ?? 10 }, (_, i) => ({
      hp: 100, age: 3000, rank: i < (o.ranked ?? 0) ? 2 : 0,
    })),
    world: { startX: 50, startY: 50 },
    globalMult: () => 1,
    industry: {
      prod,
      eco: { arrears: o.arrears ?? 0 },
      prodReport: o.runs === undefined ? { runs: {}, gained: o.gained || {} }
        : (o.runs === null ? null : { runs: o.runs, gained: o.gained || {} }),
    },
    politics: { state: { stability: 60, factions: { nobles: 55, clergy: 55, merchants: 55, commons: 55, military: 55 } } },
    linkIndustry: o.mem ? { ...createIndustryMemory(), ...o.mem } : null,
  };
}

// Тот же день, что уже в памяти: счётчики стоят, видно чистую формулу.
function frozen(o = {}) {
  const sim = makeSim(o);
  sim.linkIndustry = { ...createIndustryMemory(), day: sim.day, ...(o.mem || {}) };
  return sim;
}

// Шахта одна, прогонов ноль → стадия «Добыча руды» простаивает целиком.
const IDLE_ALL = { buildings: ['mine'], runs: {} };
// Та же шахта, но прогоны равны мощности (1 шахта × rate 1 × mult 1).
const BUSY_ALL = { buildings: ['mine'], runs: { ore_dig: 1 } };

// ------------------------------------------------------------ 1. молчание
t('спокойное хозяйство не даёт ни одной поправки', () => {
  const r = industryLinks(makeSim(BUSY_ALL));
  ok(r.mods.happy === 0, `счастье трогают на ровном месте: ${r.mods.happy}`);
  ok(r.mods.gold === 0, `золото трогают на ровном месте: ${r.mods.gold}`);
  ok(r.mods.stability === 0, `стабильность трогают: ${r.mods.stability}`);
  ok(r.mods.knowledge === 0, `знание из ниоткуда: ${r.mods.knowledge}`);
  ok(ESTATES.every(f => r.mods.estates[f] === 0), `сословия трогают: ${JSON.stringify(r.mods.estates)}`);
  ok(r.flags.accident === null, 'авария на ровном месте');
});

t('полная загрузка при оплаченной казне НЕ доводит до аварии', () => {
  // Ключевое свойство дизайна: наказывают за заброшенность, а не за труд.
  ok(REPAIR_BASE > WEAR_LOAD, `ремонт слабее износа от работы: ${REPAIR_BASE} <= ${WEAR_LOAD}`);
  let sim = makeSim(BUSY_ALL);
  for (let d = 0; d < 50; d++) {
    const r = industryLinks(sim);
    sim.linkIndustry = r.flags.memory;
    sim.day++;
  }
  near(sim.linkIndustry.wear, 0, 1e-9, 'работа сама по себе изнашивает хозяйство');
});

// ------------------------------------------------------------ 2. простой
t('простой бьёт по счастью ровно на IDLE_HAPPY_MAX и не сильнее', () => {
  const full = industryLinks(frozen(IDLE_ALL));
  near(full.mods.happy, IDLE_HAPPY_MAX, 1e-9, 'полный простой посчитан неверно');
  ok(full.flags.idleShare === 1, `доля простоя не единица: ${full.flags.idleShare}`);
  // Половина зданий стоит → ровно половина штрафа: связь линейна и предсказуема.
  const half = industryLinks(frozen({ buildings: ['mine', 'mine'], runs: { ore_dig: 1 } }));
  near(half.flags.idleShare, 0.5, 1e-9, 'половинный простой посчитан неверно');
  near(half.mods.happy, IDLE_HAPPY_MAX / 2, 1e-9, 'штраф не пропорционален простою');
});

t('простой съедает доход ремесла, но не больше половины', () => {
  // Рынок: out.gold 0.8 × 3 рабочих = 2.4🪙/день. Половина при полном простое.
  const sim = frozen({ buildings: ['mine', { id: 'market', workers: [1, 2, 3] }], runs: {} });
  const r = industryLinks(sim);
  near(r.mods.gold, -2.4 * IDLE_GOLD_SHARE, 0.01, 'недобор ремесла посчитан неверно');
  ok(r.mods.gold > -2.4, 'простой обнулил торговлю целиком — потолка нет');
  // Нет торговых домов — нечего и терять.
  ok(industryLinks(frozen(IDLE_ALL)).mods.gold === 0, 'потеря золота без единого рынка');
});

t('простой злит ремесленников и купцов, знать и жрецов — нет', () => {
  const r = industryLinks(frozen(IDLE_ALL));
  near(r.mods.estates.commons, -IDLE_ESTATE.commons, 1e-9, 'простолюдины не заметили простоя');
  near(r.mods.estates.merchants, -IDLE_ESTATE.merchants, 1e-9, 'купцы не заметили простоя');
  ok(r.mods.estates.nobles === 0 && r.mods.estates.clergy === 0, 'простой злит непричастных');
  ok(Math.abs(r.mods.estates.commons) < 0.6, 'безделье бьёт не слабее голода — порядок бед нарушен');
});

t('стабильность падает не сразу, набирает силу за IDLE_STAB_DAYS и имеет пол', () => {
  let sim = makeSim(IDLE_ALL);
  const seen = [];
  for (let d = 0; d < IDLE_STAB_DAYS + 2; d++) {
    const r = industryLinks(sim);
    seen.push(r.mods.stability);
    sim.linkIndustry = r.flags.memory;
    sim.day++;
  }
  near(seen[0], -IDLE_STAB / IDLE_STAB_DAYS, 0.01, 'первые сутки простоя стоят слишком дорого');
  near(seen[IDLE_STAB_DAYS - 1], -IDLE_STAB, 0.01, 'полная сила не набралась к сроку');
  near(seen[IDLE_STAB_DAYS + 1], -IDLE_STAB, 0.01, 'штраф растёт без потолка');
  ok(seen.every(v => v >= STAB_FLOOR), `пробит пол ${STAB_FLOOR}: ${seen}`);
  // Короткая заминка ниже порога вообще не доходит до трона.
  const small = industryLinks(frozen({ buildings: ['mine', 'mine', 'mine', 'mine'], runs: { ore_dig: 3.5 } }));
  ok(small.flags.idleShare < IDLE_STAB_FROM && small.mods.stability === 0,
    `мелкая заминка дошла до стабильности: ${small.flags.idleShare} → ${small.mods.stability}`);
});

t('игрок читает узкое место словами: чего не хватает и что стоит', () => {
  // Поля есть, мельницы нет: зерно копится, молоть некому.
  const sim = makeSim({
    buildings: ['farm', 'farm'], runs: { grain_grow: 2.4 },
    stock: { grain: 250 },
  });
  const r = industryLinks(sim);
  const bread = r.flags.bottlenecks.find(b => b.id === 'bread');
  ok(bread, 'узкое место хлебной цепочки не названо');
  ok(/Помол/.test(bread.text), `не сказано, ГДЕ рвётся цепочка: ${bread.text}`);
  ok(/Мельница|Мануфактура/.test(bread.text), `не сказано, ЧТО строить: ${bread.text}`);
  ok(/копится|нет здания|Строить/i.test(bread.text), `причина не названа словами: ${bread.text}`);
  const br = industryBreakdown(sim);
  ok(/Помол/.test(br.text), `разбор для панели молчит про узкое место: ${br.text}`);
  console.log(`   узкое место: ${bread.text}`);
});

// ------------------------------------------------------------ 3. износ и аварии
t('износ считается по трём причинам и не быстрее WEAR_DAY_CAP', () => {
  // Полная загрузка + пять суток задержки жалования + все постройки ветхие.
  const sim = makeSim({ era: 4, buildings: [{ id: 'mine', eraBuilt: 0 }], runs: {}, arrears: WEAR_ARREARS_FULL });
  // Простой при этом полный, значит loadShare = 0 — берём отдельно чистую сумму.
  const worst = makeSim({ era: 4, buildings: [{ id: 'mine', eraBuilt: 0 }], runs: { ore_dig: 1 }, arrears: 99 });
  const r = industryLinks(worst);
  const raw = WEAR_LOAD * 1 + WEAR_ARREARS * 1 + WEAR_AGE * 1;
  ok(raw > WEAR_DAY_CAP, 'проверка потолка бессмысленна: сумма и так мала');
  near(r.flags.wear, WEAR_DAY_CAP, 1e-9, 'потолок дневного износа не работает');
  // Без задержек и без ветхости изношенное хозяйство чинится.
  const fix = industryLinks(makeSim({ ...BUSY_ALL, mem: { wear: 50 } }));
  ok(fix.flags.wear < 50, `оплаченная казна не чинит: ${fix.flags.wear}`);
  near(fix.flags.wear, 50 + WEAR_LOAD - REPAIR_BASE, 1e-9, 'ремонт посчитан неверно');
  // Долг по жалованью — и ремонт встал совсем.
  const debt = industryLinks(makeSim({ ...IDLE_ALL, arrears: 1, mem: { wear: 50 } }));
  ok(debt.flags.wear > 50, `при долгах по жалованью износ не растёт: ${debt.flags.wear}`);
});

t('образование замедляет износ и ускоряет ремонт', () => {
  const raw = { era: 4, buildings: [{ id: 'mine', eraBuilt: 0 }], runs: { ore_dig: 1 }, arrears: 99, pop: 10 };
  const dumb = industryLinks(makeSim(raw));
  const smart = industryLinks(makeSim({ ...raw, ranked: 10, buildings: [{ id: 'mine', eraBuilt: 0 }] }));
  ok(smart.flags.wear < dumb.flags.wear, `учёные не берегут станки: ${smart.flags.wear} vs ${dumb.flags.wear}`);
  // Образованность = 0.75 × доля ранговых (школ нет).
  const s = industryState(makeSim({ ...raw, ranked: 10 }));
  near(s.schooling, SKILL_WEIGHT, 0.01, 'образованность посчитана неверно');
  near(smart.flags.wear, WEAR_DAY_CAP * (1 - WEAR_SCHOOL * SKILL_WEIGHT), 0.01, 'скидка на износ неверна');
  // Дома знания добавляют сверх ремесла, но не больше SCHOOL_CAP.
  const many = industryState(makeSim({
    ranked: 0, era: 8,
    buildings: ['story_fire', 'academy', 'university', 'press', 'observatory', 'lab'],
  }));
  near(many.schooling, Math.min(SCHOOL_CAP, 6 * SCHOOL_EACH), 0.01, 'потолок школ не работает');
});

t('авария наступает на потолке износа и откатывает счётчик', () => {
  const sim = makeSim({ era: 2, buildings: [{ id: 'mine', eraBuilt: 0 }], runs: {}, arrears: 9, mem: { wear: WEAR_MAX } });
  sim.industry.prod.stock.ore = 200;
  const r = industryLinks(sim);
  ok(r.flags.accident, 'износ дошёл до потолка, а аварии нет');
  ok(r.flags.accident.name === 'Шахта', `сломалось не то: ${r.flags.accident.name}`);
  near(r.mods.stockPct, ACC_STOCK_LOSS, 1e-9, 'потеря сырья посчитана неверно');
  near(r.mods.stabilityShock, ACC_STAB, 1e-9, 'удар по стабильности неверен');
  near(r.mods.gold, -ACC_GOLD_BASE * (1 + 2 * 0.5), 0.01, 'разбор завала стоит не столько');
  near(r.mods.happy, IDLE_HAPPY_MAX + ACC_HAPPY, 1e-9, 'счастье после аварии посчитано неверно');
  near(r.flags.memory.wear, WEAR_AFTER, 1e-9, 'счётчик не откатился — петля без выхода');
  ok(r.flags.memory.accCd === ACCIDENT_CD, 'откат после аварии не выставлен');
  ok(/АВАРИЯ/.test(r.events.map(e => e.text).join(' ')), 'об аварии не сказано игроку');
  // Сословия: удар есть, но не глубже потолка на сутки.
  ok(r.mods.estates.commons < -IDLE_ESTATE.commons, 'авария не задела простолюдин');
  ok(ESTATES.every(f => r.mods.estates[f] >= -ESTATE_DROP_CAP), 'пробит потолок дневного падения сословий');
});

t('второй аварии подряд не бывает: откат работает', () => {
  const base = { era: 2, buildings: [{ id: 'mine', eraBuilt: 0 }], runs: {}, arrears: 9 };
  const sim = makeSim({ ...base, mem: { wear: WEAR_MAX } });
  const first = industryLinks(sim);
  ok(first.flags.accident, 'первой аварии нет');
  // Даже если износ волшебным образом снова на потолке — откат не пустит.
  const again = industryLinks(makeSim({ ...base, day: 101, mem: { ...first.flags.memory, wear: WEAR_MAX } }));
  ok(!again.flags.accident, 'авария каждый день подряд — спираль смерти');
});

t('двойной вызов в одни сутки не копит износ и не ломает станок дважды', () => {
  const sim = makeSim({ ...IDLE_ALL, arrears: 9, mem: { wear: 99.9 } });
  const a = industryLinks(sim);
  ok(a.flags.accident, 'первая авария не случилась');
  sim.linkIndustry = a.flags.memory;          // тот же день, повторный вызов
  const b = industryLinks(sim);
  ok(!b.flags.accident, 'повторный вызов в те же сутки сломал второе здание');
  near(b.flags.wear, a.flags.memory.wear, 1e-9, 'износ посчитан дважды за одни сутки');
});

// ------------------------------------------------------------ 4. знание из ремесла
t('избыток сырья рождает знание, но не больше KNOW_MAX', () => {
  const ore = INTERMEDIATES.find(i => i.id === 'ore');
  // Склад забит целиком, все взрослые — ремесленники: предельный случай.
  const full = industryLinks(frozen({ ...BUSY_ALL, ranked: 10, stock: { ore: ore.cap } }));
  near(full.mods.knowledge, KNOW_MAX, 1e-9, 'потолок знания не достигнут или пробит');
  // Ровно на пороге KNOW_FROM излишка ещё нет.
  const edge = industryLinks(frozen({ ...BUSY_ALL, ranked: 10, stock: { ore: ore.cap * KNOW_FROM } }));
  ok(edge.mods.knowledge === 0, `порог избытка не работает: ${edge.mods.knowledge}`);
  // Без единого ремесленника опыты идут только вполсилы.
  const hands = industryLinks(frozen({ ...BUSY_ALL, ranked: 0, stock: { ore: ore.cap } }));
  near(hands.mods.knowledge, KNOW_MAX * KNOW_BASE_SHARE, 1e-9, 'вклад рук в опыты посчитан неверно');
  ok(hands.mods.knowledge < full.mods.knowledge, 'ремесло не влияет на знание');
});

t('пустые склады знания не дают', () => {
  const r = industryLinks(frozen({ ...BUSY_ALL, ranked: 10 }));
  ok(r.mods.knowledge === 0, `знание из пустого склада: ${r.mods.knowledge}`);
});

// ------------------------------------------------------------ 5. обратная связь и эпоха
t('образованные руки прибавляют к выпуску цепочек до SPEED_MAX', () => {
  const sim = makeSim({ ...BUSY_ALL, ranked: 10, gained: { steel: 10, food: 4 } });
  const r = industryLinks(sim);
  near(r.mods.speed, SPEED_MAX * SKILL_WEIGHT, 0.01, 'прибавка к выпуску посчитана неверно');
  near(r.mods.output.steel, 10 * SPEED_MAX * SKILL_WEIGHT, 0.01, 'сталь не ускорилась');
  near(r.mods.output.food, 4 * SPEED_MAX * SKILL_WEIGHT, 0.01, 'хлеб не ускорился');
  // Без ремесла и школ прибавки нет вовсе — даровых процентов не бывает.
  const dumb = industryLinks(makeSim({ ...BUSY_ALL, gained: { steel: 10 } }));
  ok(dumb.mods.speed === 0 && Object.keys(dumb.mods.output).length === 0, 'прибавка без образования');
});

t('эпоха открывает звенья цепочек и говорит об этом', () => {
  // Пока нет ни бронзы, ни гончарного дела — половина звеньев закрыта.
  const lockedSim = makeSim({ era: 0 });
  const locked = industryState(lockedSim).locked;
  const smelt = locked.find(l => l.stageId === 'smelt');
  ok(smelt, 'закрытое звено «Плавка» не найдено');
  ok(smelt.era >= 1 && /Бронзовый/.test(smelt.eraRu), `эпоха звена определена неверно: ${smelt.eraRu}`);
  ok(/откроется|нужна технология/i.test(smelt.text), `игроку не сказано про закрытое звено: ${smelt.text}`);
  // Переход эпохи: событие называет открывшиеся звенья.
  const sim = makeSim({ era: 1, mem: { lastEra: 0 } });
  const r = industryLinks(sim);
  ok(r.flags.unlocked.some(u => u.stageId === 'smelt' || u.stageId === 'ore_dig'),
    `новые звенья не найдены: ${JSON.stringify(r.flags.unlocked)}`);
  ok(/открывает звенья/.test(r.events.map(e => e.text).join(' ')), 'об открытии звена молчим');
  // Та же эпоха на следующие сутки — второго объявления нет.
  const again = industryLinks(makeSim({ era: 1, day: 101, mem: { lastEra: 1 } }));
  ok(!/открывает звенья/.test(again.events.map(e => e.text).join(' ')), 'объявление повторяется каждый день');
});

// ------------------------------------------------------------ 6. крайние случаи
t('зимой остановка полей — не простой цеха', () => {
  // seasonIdx 3: стадия «Зерно с полей» не работает по сезону, а не по разрухе.
  const winter = industryLinks(frozen({ buildings: ['farm'], runs: {}, seasonIdx: 3 }));
  ok(winter.flags.idleShare === 0, `зима записана в простой: ${winter.flags.idleShare}`);
  ok(winter.mods.happy === 0, 'зимой поля роняют счастье как сломанный цех');
});

t('связь молчит, когда хозяйства ещё нет', () => {
  const bare = makeSim({ buildings: [] });
  const r = industryLinks(bare);
  ok(r.flags.idleShare === 0 && r.mods.happy === 0, 'пустое поселение уже что-то теряет');
  // Совсем без sim.industry модуль обязан вернуть пустой отчёт, а не упасть.
  const none = industryLinks({ day: 1, res: {}, buildings: [], villagers: [] });
  ok(none.mods.happy === 0 && none.events.length === 0 && none.flags.ok === false, 'без цепочек связь не пустая');
  ok(industryBreakdown({ day: 1, buildings: [], villagers: [] }).rows.length === 0, 'разбор без цепочек не пуст');
});

t('связь ничего не мутирует сама', () => {
  const sim = makeSim({ ...IDLE_ALL, arrears: 9, mem: { wear: WEAR_MAX }, stock: { ore: 100 } });
  const before = JSON.stringify({
    res: sim.res, stock: sim.industry.prod.stock, pol: sim.politics.state,
    mem: sim.linkIndustry, hp: sim.buildings.map(b => b.hp),
  });
  const r = industryLinks(sim);
  ok(r.flags.accident, 'проверять нечего: авария не сработала');
  const after = JSON.stringify({
    res: sim.res, stock: sim.industry.prod.stock, pol: sim.politics.state,
    mem: sim.linkIndustry, hp: sim.buildings.map(b => b.hp),
  });
  ok(before === after, 'модуль изменил мир сам — он обязан только считать');
});

t('память переживает сейв и мусор из старого файла', () => {
  const m = createIndustryMemory();
  m.wear = 73.5; m.accCd = 9; m.accidents = 2; m.idleDays = 4; m.lastEra = 3;
  m.kinds = { steel: 'input' }; m.happyMod = -4; m.wearWarn = 1; m.knowLoud = true;
  const back = restoreIndustryMemory(JSON.parse(JSON.stringify(m)));
  ok(back.wear === 73.5 && back.accCd === 9 && back.accidents === 2, 'память не восстановилась');
  ok(back.kinds.steel === 'input' && back.lastEra === 3, 'узкие места и эпоха потерялись');
  ok(restoreIndustryMemory(null).wear === 0, 'старый сейв без поля не грузится');
  ok(restoreIndustryMemory({ wear: 5000, accCd: -3, kinds: 'мусор' }).wear === WEAR_MAX, 'мусор из сейва прошёл насквозь');
  ok(restoreIndustryMemory({ accCd: -3 }).accCd === 0, 'отрицательный откат прошёл насквозь');
  // Счастье для happiness() читается из памяти, а не считается заново.
  ok(industryLinkHappyMod({ linkIndustry: { happyMod: -5.4 } }) === -5, 'поправка к счастью не округлена');
  ok(industryLinkHappyMod({}) === 0, 'без памяти счастье не ноль');
});

t('о простое говорят один раз, а не каждые сутки', () => {
  let sim = makeSim(IDLE_ALL);
  const said = [];
  for (let d = 0; d < 4; d++) {
    const r = industryLinks(sim);
    said.push(r.events.filter(e => /Хозяйство встало/.test(e.text)).length);
    sim.linkIndustry = r.flags.memory;
    sim.day++;
  }
  ok(IDLE_LOUD <= 1, 'порог громкости выставлен неверно');
  ok(said[0] === 1 && said.slice(1).every(n => n === 0), `журнал засоряется: ${said}`);
  // Починили цепочку — связь говорит и об этом.
  sim = makeSim({ ...BUSY_ALL, day: 110, mem: { ...sim.linkIndustry } });
  const back = industryLinks(sim);
  ok(back.events.some(e => /заработали/.test(e.text)), 'о починке цепочки не сказано');
});

t('связь работает на настоящей Simulation', () => {
  const sim = new Simulation(777);
  sim.industry = sim.industry || null;
  ok(sim.industry, 'в настоящей игре нет sim.industry — интеграция разошлась');
  const r = industryLinks(sim);
  ok(r.mods.happy === 0 && r.mods.gold === 0, `свежая партия уже что-то теряет: ${JSON.stringify(r.mods)}`);
  ok(Object.keys(r.mods.estates).length === 5, 'сословия не совпали с politics.js');
  ok(r.flags.locked.length > 0, 'в каменном веке все звенья цепочек уже открыты?');
  // Прогоняем настоящие сутки (день инкрементируется в tick, а не в onNewDay)
  // и каждый раз возвращаем память — ровно так, как это делает integrate.js.
  let later = r;
  for (let d = 0; d < 60; d++) {
    for (let i = 0; i < 4; i++) sim.tick(0.25);
    later = industryLinks(sim);
    sim.linkIndustry = later.flags.memory;
  }
  ok(sim.day >= 60, `календарь не двигается: день ${sim.day}`);
  ok(later.flags.memory.day === sim.day, 'память связи отстала от календаря');
  ok(isFinite(later.mods.happy) && isFinite(later.mods.stability), 'на живой партии связь дала NaN');
  ok(later.mods.happy <= 0 && later.mods.happy >= IDLE_HAPPY_MAX, `счастье вне коридора: ${later.mods.happy}`);
  ok(later.flags.wear >= 0 && later.flags.wear <= 100, `износ вне коридора: ${later.flags.wear}`);
  const br = industryBreakdown(sim);
  ok(typeof br.text === 'string' && br.text.length > 0, 'разбор для панели пуст на живой партии');
  console.log(`   живая партия, день ${sim.day}: простой ${Math.round(later.flags.idleShare * 100)}%, износ ${later.flags.wear}%`);
});

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
