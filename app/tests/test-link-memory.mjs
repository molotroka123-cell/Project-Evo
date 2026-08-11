// Тесты связи «летопись → поведение державы» (link_memory.js).
// Запуск: node app/tests/test-link-memory.mjs
//
// Проверяем не «функция не упала», а числа: направление каждой связи, скорость
// забывания, потолки петель, молчание при пустой летописи и то, что модуль
// ничего не мутирует.
import { readFileSync } from 'node:fs';
import { Simulation } from '../src/core/simulation.js';
import {
  memoryLinks, memoryBreakdown, memoryState, healRate,
  createMemory, restoreMemory, remember, strengthOf, forceOf,
  YEAR, HALF_LIFE_YEARS, FORGET_BELOW, KIND, MERGE_DAYS, MERGE_CAP,
  FAMINE_EAT_CUT, FAMINE_STAB, FROST_WOOD_CUT,
  PLAGUE_CLERGY, PLAGUE_CLERGY_CAP, SHAME_MIL_WAR, SHAME_MIL_PEACE,
  PRIDE_STAB, PRIDE_STAB_CEILING, BETRAYAL_REL, BETRAYAL_REL_FLOOR, HEAL_BONUS,
} from '../src/core/systems/link_memory.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK ', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≠ ${b}`);

// Поддельный sim: связь читает только эти поля. Подделка позволяет поставить
// ровно то состояние, которое проверяется, без прогона тысячи игровых дней.
function makeSim(o = {}) {
  const pop = o.pop ?? 20;
  return {
    day: o.day ?? 0,
    villagers: Array.from({ length: pop }, () => ({ hp: 10 })),
    res: { food: (o.foodDays ?? 7) * pop * 0.7, wood: 200 },
    wars: o.atWar ? [{ fid: 'orda' }] : [],
    relations: o.relations || {},
    politics: { state: { stability: o.stability ?? 60, factions: { nobles: 50, clergy: 50, merchants: 50, commons: 50, military: 50, ...(o.factions || {}) } } },
    linkMemory: o.mem || createMemory(),
    sys: {},
  };
}

console.log('--- Пустая летопись молчит ---');
{
  const sim = makeSim({ day: 500 });
  const out = memoryLinks(sim);
  t('нет поправки к стабильности', () => near(out.mods.stability, 0, 1e-9, 'стабильность'));
  t('нет поправки к счастью', () => near(out.mods.happy, 0, 1e-9, 'счастье'));
  t('расход еды не тронут', () => near(out.mods.eatMult, 1, 1e-9, 'eatMult'));
  t('дрова не тронуты', () => near(out.mods.woodBurnMult, 1, 1e-9, 'woodBurnMult'));
  t('сословия не тронуты',
    () => ok(Object.values(out.mods.estates).every(v => v === 0), JSON.stringify(out.mods.estates)));
  t('нечего рассказывать', () => ok(out.events.length === 0, `событий ${out.events.length}`));
}

console.log('\n--- Затухание по времени ---');
{
  const mem = createMemory();
  remember(mem, 'famine', 0);
  const w = KIND.famine.weight;
  t('в день события след равен своему весу',
    () => near(strengthOf(mem.scars[0], 0), w, 1e-9, 'сила'));
  t('через один период полураспада — ровно половина',
    () => near(strengthOf(mem.scars[0], YEAR * HALF_LIFE_YEARS), w / 2, 1e-9, 'сила'));
  t('через два периода — четверть',
    () => near(strengthOf(mem.scars[0], YEAR * HALF_LIFE_YEARS * 2), w / 4, 1e-9, 'сила'));
  t('след слабеет монотонно', () => {
    let prev = Infinity;
    for (let y = 0; y <= 30; y++) {
      const v = strengthOf(mem.scars[0], YEAR * y);
      ok(v <= prev + 1e-12, `на ${y}-м году след вырос: ${v} > ${prev}`);
      prev = v;
    }
  });
}

console.log('\n--- Голод: бережливость и недоверие ---');
{
  const mem = createMemory();
  remember(mem, 'famine', 0, { scale: 2 });          // тяжёлый голод
  const sim = makeSim({ day: 10, mem });
  const out = memoryLinks(sim);
  const f = out.flags.forces.famine;
  t('след голода записан', () => ok(f > 0.5, `сила ${f}`));
  t('едят меньше', () => ok(out.mods.eatMult < 1 && out.mods.eatMult >= 1 - FAMINE_EAT_CUT,
    `eatMult ${out.mods.eatMult}`));
  t('стабильность падает', () => ok(out.mods.stability < 0, `${out.mods.stability}`));
  t('падение не больше потолка породы',
    () => ok(Math.abs(out.mods.stability) <= FAMINE_STAB * KIND.famine.cap + 1e-9,
      `${out.mods.stability} при потолке ${FAMINE_STAB * KIND.famine.cap}`));
  t('счастье падает', () => ok(out.mods.happy < 0, `${out.mods.happy}`));
  t('причина названа словами',
    () => ok(out.reasons.stability.some(r => /голод/i.test(r.ru)), JSON.stringify(out.reasons.stability)));
}

console.log('\n--- Два потолка: беды не уводят в бесконечность ---');
{
  // Потолок первый — слияние. Десять голодных дней подряд это ОДНА беда, а не
  // десять: иначе затянувшийся мор упирался бы в потолок породы и не таял
  // никогда, потому что свежая запись каждый день перебивала бы затухание.
  const near0 = createMemory();
  for (let i = 0; i < 10; i++) remember(near0, 'famine', i, { scale: 3 });
  t('десять дней подряд слились в один шрам',
    () => ok(near0.scars.length === 1, `шрамов ${near0.scars.length}`));
  t('вес слитого шрама упёрся в потолок слияния',
    () => near(near0.scars[0].w, KIND.famine.weight * MERGE_CAP, 0.01, 'вес'));

  // Потолок второй — порода. Десять РАЗНЫХ бед, разнесённых по годам, дают
  // десять шрамов, и вот их сумма упирается уже в cap самой породы.
  const far = createMemory();
  for (let i = 0; i < 10; i++) remember(far, 'famine', i * MERGE_DAYS * 2, { scale: 3 });
  t('разнесённые беды дают отдельные шрамы',
    () => ok(far.scars.length === 10, `шрамов ${far.scars.length}`));
  const out = memoryLinks(makeSim({ day: 10 * MERGE_DAYS * 2, mem: far }));
  t('их общая сила упёрлась в потолок породы',
    () => near(out.flags.forces.famine, KIND.famine.cap, 0.01, 'сила'));
  t('расход еды не падает ниже своего предела',
    () => ok(out.mods.eatMult >= 1 - FAMINE_EAT_CUT - 1e-9, `eatMult ${out.mods.eatMult}`));
}

console.log('\n--- Затянувшаяся беда всё-таки забывается ---');
{
  // Прямая проверка того, что сломалось на первом живом прогоне: мор держался
  // на потолке двенадцать лет, потому что писался заново каждые сутки.
  const mem = createMemory();
  for (let d = 0; d < 40; d++) remember(mem, 'plague', d, { scale: 2 });
  const soon = memoryLinks(makeSim({ day: 40, mem })).flags.forces.plague;
  const later = memoryLinks(makeSim({ day: 40 + YEAR * 10, mem })).flags.forces.plague;
  t('сорок дней мора не создают сорок шрамов',
    () => ok(mem.scars.length <= 3, `шрамов ${mem.scars.length}`));
  t('через десять лет мор помнят заметно слабее',
    () => ok(later < soon * 0.5, `было ${soon}, стало ${later}`));
}

console.log('\n--- Мор поднимает духовенство, но не бесконечно ---');
{
  const mem = createMemory();
  remember(mem, 'plague', 0, { scale: 2 });
  const low = memoryLinks(makeSim({ day: 5, mem, factions: { clergy: 50 } }));
  t('при низком одобрении жрецы растут',
    () => ok(low.mods.estates.clergy > 0, `${low.mods.estates.clergy}`));
  t('прибавка не больше своего потолка',
    () => ok(low.mods.estates.clergy <= PLAGUE_CLERGY * KIND.plague.cap + 1e-9,
      `${low.mods.estates.clergy}`));
  const high = memoryLinks(makeSim({ day: 5, mem, factions: { clergy: PLAGUE_CLERGY_CAP + 5 } }));
  t('выше потолка память их уже не поднимает',
    () => near(high.mods.estates.clergy, 0, 1e-9, `${high.mods.estates.clergy}`));
}

console.log('\n--- Позор: война или мир меняют знак ---');
{
  const mem = createMemory();
  remember(mem, 'shame', 0, { scale: 2 });
  const war = memoryLinks(makeSim({ day: 5, mem, atWar: true }));
  const peace = memoryLinks(makeSim({ day: 5, mem, atWar: false }));
  t('в войну военные довольны случаем смыть позор',
    () => ok(war.mods.estates.military > 0, `${war.mods.estates.military}`));
  t('в мир — злятся',
    () => ok(peace.mods.estates.military < 0, `${peace.mods.estates.military}`));
  t('стабильность падает в обоих случаях',
    () => ok(war.mods.stability < 0 && peace.mods.stability < 0,
      `война ${war.mods.stability}, мир ${peace.mods.stability}`));
}

console.log('\n--- Гордость: единственная прибавка, и та с потолком ---');
{
  const mem = createMemory();
  remember(mem, 'triumph', 0, { scale: 2 });
  const low = memoryLinks(makeSim({ day: 5, mem, stability: 40 }));
  t('при шаткой державе гордость держит порядок',
    () => ok(low.mods.stability > 0, `${low.mods.stability}`));
  t('прибавка не больше потолка породы',
    () => ok(low.mods.stability <= PRIDE_STAB * KIND.triumph.cap + 1e-9, `${low.mods.stability}`));
  const high = memoryLinks(makeSim({ day: 5, mem, stability: PRIDE_STAB_CEILING + 5 }));
  t('на крепкой державе гордость уже ничего не прибавляет',
    () => near(high.mods.stability, 0, 1e-9, `${high.mods.stability}`));
}

console.log('\n--- Предательство помнят поимённо ---');
{
  const mem = createMemory();
  remember(mem, 'betrayal', 0, { fid: 'orda', scale: 2 });
  const sim = makeSim({ day: 5, mem, relations: { orda: 10, volki: 10 } });
  const out = memoryLinks(sim);
  t('отношения тянет вниз именно к предателю',
    () => ok(out.mods.relations.orda < 0, JSON.stringify(out.mods.relations)));
  t('невиновного соседа память не трогает',
    () => ok(!out.mods.relations.volki, JSON.stringify(out.mods.relations)));
  t('тяга не сильнее своего предела',
    () => ok(Math.abs(out.mods.relations.orda) <= BETRAYAL_REL * 1.5 + 1e-9,
      `${out.mods.relations.orda}`));

  // Пол: ниже него память перестаёт давить, иначе примирение невозможно.
  const deep = memoryLinks(makeSim({ day: 5, mem, relations: { orda: BETRAYAL_REL_FLOOR - 10 } }));
  t('ниже пола память отношения больше не топит',
    () => ok(!deep.mods.relations.orda, JSON.stringify(deep.mods.relations)));
}

console.log('\n--- Сытые и спокойные годы лечат быстрее ---');
{
  const bad = healRate(memoryState(makeSim({ foodDays: 1, stability: 10 })));
  const good = healRate(memoryState(makeSim({ foodDays: 20, stability: 95 })));
  t('в беде забывается со своей обычной скоростью', () => near(bad, 1, 1e-9, `${bad}`));
  t('в сытости и порядке — быстрее', () => ok(good > bad, `${good} vs ${bad}`));
  t('ускорение не больше объявленного',
    () => near(good, 1 + HEAL_BONUS, 1e-9, `${good}`));

  // И это должно быть видно в силе следа, а не только в коэффициенте.
  const mem = createMemory();
  remember(mem, 'famine', 0);
  const sBad = forceOf(mem, 'famine', YEAR * 6, bad);
  const sGood = forceOf(mem, 'famine', YEAR * 6, good);
  t('через шесть лет сытая держава помнит слабее',
    () => ok(sGood < sBad, `сытая ${sGood} vs голодная ${sBad}`));
}

console.log('\n--- Забытое выбрасывается из памяти ---');
{
  const mem = createMemory();
  remember(mem, 'famine', 0);
  const sim = makeSim({ day: YEAR * 60, mem });      // шестьдесят лет спустя
  const out = memoryLinks(sim);
  t('очень старый след стёрт',
    () => ok(out.flags.memory.scars.length === 0, `осталось ${out.flags.memory.scars.length}`));
  t('и это посчитано', () => ok(out.flags.forgotten === 1, `забыто ${out.flags.forgotten}`));
  t('порог забывания соблюдён', () => ok(FORGET_BELOW > 0 && FORGET_BELOW < 0.2));
}

console.log('\n--- Модуль ничего не мутирует ---');
{
  const mem = createMemory();
  remember(mem, 'famine', 0);
  const sim = makeSim({ day: 50, mem });
  const before = JSON.stringify({ res: sim.res, pol: sim.politics, mem: sim.linkMemory });
  memoryLinks(sim, [{ kind: 'frost' }]);
  const after = JSON.stringify({ res: sim.res, pol: sim.politics, mem: sim.linkMemory });
  t('sim не изменился', () => ok(before === after, 'модуль тронул sim'));
}

console.log('\n--- Один день считается один раз ---');
{
  const sim = makeSim({ day: 50 });
  const a = memoryLinks(sim, [{ kind: 'famine' }]);
  sim.linkMemory = a.flags.memory;
  const b = memoryLinks(sim, [{ kind: 'famine' }]);
  t('повторный вызов в те же сутки не пишет второй шрам',
    () => ok(b.flags.memory.scars.length === 1, `шрамов ${b.flags.memory.scars.length}`));
}

console.log('\n--- Круг сохранения ---');
{
  const mem = createMemory();
  remember(mem, 'shame', 120, { scale: 1.5, note: 'Вольный Дол' });
  remember(mem, 'betrayal', 200, { fid: 'orda' });
  const back = restoreMemory(JSON.parse(JSON.stringify(mem)));
  t('число шрамов сохранилось', () => ok(back.scars.length === 2, `${back.scars.length}`));
  t('вес сохранился', () => near(back.scars[0].w, mem.scars[0].w, 1e-9, 'вес'));
  t('виновник сохранился', () => ok(back.scars[1].fid === 'orda', back.scars[1].fid));
  t('битый сейв не роняет модуль', () => {
    const junk = restoreMemory({ scars: [{ kind: 'нет-такой' }, null, 5], day: 'ерунда' });
    ok(junk.scars.length === 0, `${junk.scars.length}`);
  });
}

console.log('\n--- Разбор для панели ---');
{
  const mem = createMemory();
  remember(mem, 'famine', 0, { scale: 2 });
  remember(mem, 'triumph', 100);
  const sim = makeSim({ day: 150, mem });
  const b = memoryBreakdown(sim);
  t('строки собраны', () => ok(b.rows.length === 2, `строк ${b.rows.length}`));
  t('сильнейшее помнят первым', () => ok(b.rows[0].v >= b.rows[1].v, JSON.stringify(b.rows)));
  t('сказано, сколько лет прошло', () => ok(b.rows.every(r => r.years >= 0), JSON.stringify(b.rows)));
  t('есть текст для игрока', () => ok(typeof b.text === 'string' && b.text.length > 10, b.text));
  t('пустая летопись объясняется словами', () => {
    const e = memoryBreakdown(makeSim({ day: 10 }));
    ok(/пуст/i.test(e.text), e.text);
  });
}

console.log('\n--- На настоящей симуляции ---');
{
  const sim = new Simulation(11, { startEra: 4 });
  for (let d = 0; d < 60; d++) sim.tick(1);
  t('память живёт в sim и переживает дни',
    () => ok(sim.linkMemory && Array.isArray(sim.linkMemory.scars), JSON.stringify(sim.linkMemory)));
  t('разбор работает на живой партии', () => {
    const b = memoryBreakdown(sim);
    ok(typeof b.text === 'string', JSON.stringify(b));
  });
  t('Math.random в модуле не вызывается (иначе ломались бы сейвы)', () => {
    // Читаем сам файл: это единственный способ поймать вызов, который может
    // не сработать на коротком прогоне.
    const src = readFileSync(
      new URL('../src/core/systems/link_memory.js', import.meta.url), 'utf8');
    ok(!/Math\.random\s*\(/.test(src), 'найден вызов Math.random');
  });
}

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
if (fail) process.exit(1);
