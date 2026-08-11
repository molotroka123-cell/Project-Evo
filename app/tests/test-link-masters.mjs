// Тесты ремесла, живущего в людях (link_masters.js).
// Запуск: node app/tests/test-link-masters.mjs
//
// Проверяем числа и края: кто становится мастером и почему именно он, что
// остаётся при смерти с учеником и без, что промысел не забывается от одного
// пустого дня, и что модуль ничего не мутирует.
import { readFileSync } from 'node:fs';
import { Simulation } from '../src/core/simulation.js';
import { BUILDINGS } from '../src/core/data.js';
import {
  masterLinks, mastersReport, workersByCraft, craftName,
  createMasters, restoreMasters,
  MAX_LEVEL, LEARN_DAYS, MASTER_GAIN, KEEP_WITH_HEIR, KEEP_NO_HEIR,
  APPRENTICE_MIN_WORKERS, IDLE_GRACE, FORGET_BELOW,
} from '../src/core/systems/link_masters.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK ', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≠ ${b}`);

// Поддельный sim: работник — это житель, чей target.b указывает на готовую
// производящую постройку. Именно так его находит модуль, и подделка обязана
// повторять это в точности.
function makeSim(o = {}) {
  const b = { id: o.craft || 'smithy', x: 1, y: 1, done: true, destroyed: false };
  const names = o.names || ['Первый Мастер', 'Второй Работник', 'Третий Работник'];
  const n = o.workers ?? 2;
  const villagers = names.slice(0, n).map(name => ({ name, hp: 100, target: { kind: 'work', b } }));
  // Кто-то может быть жив, но не на работе — на выбор мастера это не влияет.
  for (const extra of (o.idlers || [])) villagers.push({ name: extra, hp: 100, target: null });
  return {
    day: o.day ?? 0,
    villagers,
    buildings: [b],
    res: { stone: 0, food: 0, wood: 0 },
    resCap: { stone: 999, food: 999, wood: 999 },
    linkMasters: o.mem || createMasters(),
    sys: {},
  };
}

console.log('--- Работники находятся через target.b, а не через b.workers ---');
{
  const sim = makeSim({ workers: 2 });
  const m = workersByCraft(sim);
  t('промысел найден', () => ok(m.has('smithy'), [...m.keys()].join(',')));
  t('оба работника учтены', () => ok(m.get('smithy').length === 2, `${m.get('smithy').length}`));

  // b.workers ядро держит ТОЛЬКО для строителей — опора на него не нашла бы
  // ни одного мастера ни разу.
  const wrong = makeSim({ workers: 2 });
  wrong.buildings[0].workers = [];
  t('пустой b.workers ничего не ломает',
    () => ok(workersByCraft(wrong).get('smithy').length === 2, 'работники потерялись'));

  // Жильё мастеров не имеет: у него нет out.
  const house = makeSim({ craft: 'hut' });
  t('у построек без выпуска мастеров нет',
    () => ok(!workersByCraft(house).has('hut'), 'хижина получила мастера'));
}

console.log('\n--- Мастер выбирается детерминированно ---');
{
  const a = makeSim({ day: 1 });
  const outA = masterLinks(a);
  const b = makeSim({ day: 1 });
  const outB = masterLinks(b);
  t('мастером стал первый по списку жителей',
    () => ok(outA.flags.crafts.smithy.master === 'Первый Мастер',
      outA.flags.crafts.smithy.master));
  t('два одинаковых мира дают одного и того же мастера',
    () => ok(outA.flags.crafts.smithy.master === outB.flags.crafts.smithy.master,
      `${outA.flags.crafts.smithy.master} ≠ ${outB.flags.crafts.smithy.master}`));
}

console.log('\n--- Умение растёт медленно и упирается в потолок ---');
{
  const sim = makeSim({ day: 0 });
  let mem = createMasters();
  for (let d = 1; d <= LEARN_DAYS + 200; d++) {
    sim.day = d; sim.linkMasters = mem;
    mem = masterLinks(sim).flags.memory;
  }
  t('за срок обучения умение дошло до потолка',
    () => near(mem.crafts.smithy.level, MAX_LEVEL, 1e-6, 'умение'));

  const half = makeSim({ day: 0 });
  let m2 = createMasters();
  for (let d = 1; d <= Math.round(LEARN_DAYS / 2); d++) { half.day = d; half.linkMasters = m2; m2 = masterLinks(half).flags.memory; }
  t('за половину срока — примерно половина умения',
    () => near(m2.crafts.smithy.level, MAX_LEVEL / 2, 0.02, 'умение'));
}

console.log('\n--- Ученик появляется, когда есть кому учиться ---');
{
  const one = makeSim({ day: 1, workers: 1 });
  t(`при одном работнике ученика нет (нужно ${APPRENTICE_MIN_WORKERS})`,
    () => ok(!masterLinks(one).flags.crafts.smithy.apprentice, 'ученик взялся из ниоткуда'));
  const two = makeSim({ day: 1, workers: 2 });
  const o = masterLinks(two);
  t('при двух — появляется', () => ok(o.flags.crafts.smithy.apprentice, 'ученика нет'));
  t('ученик — не сам мастер',
    () => ok(o.flags.crafts.smithy.apprentice !== o.flags.crafts.smithy.master,
      'мастер учит сам себя'));
}

console.log('\n--- Смерть мастера: с учеником и без ---');
{
  // Доводим умение до заметного и убиваем мастера.
  const grow = (withApprentice) => {
    const sim = makeSim({ day: 0, workers: withApprentice ? 2 : 1 });
    let mem = createMasters();
    for (let d = 1; d <= 600; d++) { sim.day = d; sim.linkMasters = mem; mem = masterLinks(sim).flags.memory; }
    const before = mem.crafts.smithy.level;
    // Хороним мастера: его больше нет среди живых.
    sim.villagers = sim.villagers.filter(v => v.name !== mem.crafts.smithy.master);
    sim.day = 601; sim.linkMasters = mem;
    const out = masterLinks(sim);
    return { before, out, after: out.flags.memory.crafts.smithy };
  };

  const heir = grow(true);
  t('с учеником умение почти сохраняется',
    () => near(heir.after.level, heir.before * KEEP_WITH_HEIR, 0.02,
      `было ${heir.before.toFixed(2)}, стало ${heir.after.level.toFixed(2)}`));
  t('дело принял именно ученик',
    () => ok(heir.after.master && heir.after.master !== null, `${heir.after.master}`));
  t('об этом сказано словами',
    () => ok(heir.out.events.some(e => /дело принял/.test(e.text)), JSON.stringify(heir.out.events)));

  const alone = grow(false);
  t('без ученика умение обваливается',
    () => near(alone.after.level, alone.before * KEEP_NO_HEIR, 0.02,
      `было ${alone.before.toFixed(2)}, стало ${alone.after.level.toFixed(2)}`));
  t('потеря без наследника больше, чем с ним',
    () => ok(alone.before - alone.after.level > heir.before - heir.after.level,
      'наследник ничего не спас'));
  t('игроку сказано, что ушло ремесло',
    () => ok(alone.out.events.some(e => /ушло ремесло/.test(e.text)), JSON.stringify(alone.out.events)));
  t('потеря записана в флаги для летописи',
    () => ok(alone.out.flags.lost.length === 1, JSON.stringify(alone.out.flags.lost)));
}

console.log('\n--- Один пустой день ничего не забывает ---');
{
  // Жители не стоят у наковальни неотлучно: они носят добытое на склад и
  // перевыбирают работу. На живом городе именно из-за этого мастер терялся
  // каждый второй день и в отчёте всегда стоял null.
  const sim = makeSim({ day: 0, workers: 2 });
  let mem = createMasters();
  for (let d = 1; d <= 300; d++) { sim.day = d; sim.linkMasters = mem; mem = masterLinks(sim).flags.memory; }
  const master = mem.crafts.smithy.master;
  const level = mem.crafts.smithy.level;

  // Все ушли на склад — цели нет ни у кого.
  for (const v of sim.villagers) v.target = null;
  sim.day = 301; sim.linkMasters = mem;
  const out = masterLinks(sim);
  t('мастер остался при своём деле',
    () => ok(out.flags.memory.crafts.smithy.master === master,
      `был ${master}, стал ${out.flags.memory.crafts.smithy.master}`));
  t('умение не просело', () => near(out.flags.memory.crafts.smithy.level, level, 1e-9, 'умение'));

  // А вот долгий простой ремесло уже съедает.
  let m2 = out.flags.memory;
  for (let d = 302; d <= 302 + IDLE_GRACE + 400; d++) { sim.day = d; sim.linkMasters = m2; m2 = masterLinks(sim).flags.memory; }
  const left = m2.crafts.smithy ? m2.crafts.smithy.level : 0;
  t('заброшенный промысел умение теряет', () => ok(left < level, `было ${level.toFixed(2)}, стало ${left.toFixed(2)}`));
}

console.log('\n--- Прибавка к выпуску ---');
{
  const sim = makeSim({ day: 0, workers: 2 });
  let mem = createMasters();
  for (let d = 1; d <= LEARN_DAYS; d++) { sim.day = d; sim.linkMasters = mem; mem = masterLinks(sim).flags.memory; }
  sim.day = LEARN_DAYS + 1; sim.linkMasters = mem;
  const out = masterLinks(sim);
  const def = BUILDINGS.smithy;
  const res = Object.keys(def.out)[0];
  t('мастер добавляет к выпуску своего промысла',
    () => ok(out.mods.output[res] > 0, JSON.stringify(out.mods.output)));
  t('прибавка считается от числа работников и объявленной доли',
    () => near(out.mods.output[res], def.out[res] * 2 * MASTER_GAIN * MAX_LEVEL, 0.01,
      `${out.mods.output[res]}`));
}

console.log('\n--- Модуль ничего не мутирует ---');
{
  const sim = makeSim({ day: 5 });
  const before = JSON.stringify({ res: sim.res, mem: sim.linkMasters, v: sim.villagers.map(v => v.name) });
  masterLinks(sim);
  const after = JSON.stringify({ res: sim.res, mem: sim.linkMasters, v: sim.villagers.map(v => v.name) });
  t('sim не изменился', () => ok(before === after, 'модуль тронул sim'));
}

console.log('\n--- Один день считается один раз ---');
{
  const sim = makeSim({ day: 5 });
  const a = masterLinks(sim);
  sim.linkMasters = a.flags.memory;
  const b = masterLinks(sim);
  t('повторный вызов в те же сутки не растит умение',
    () => near(b.flags.memory.crafts.smithy.level, a.flags.memory.crafts.smithy.level, 1e-12, 'умение'));
}

console.log('\n--- Круг сохранения ---');
{
  const sim = makeSim({ day: 30 });
  sim.linkMasters = masterLinks(sim).flags.memory;
  const back = restoreMasters(JSON.parse(JSON.stringify(sim.linkMasters)));
  t('промысел пережил сейв', () => ok(back.crafts.smithy, JSON.stringify(back.crafts)));
  t('имя мастера пережило сейв',
    () => ok(back.crafts.smithy.master === sim.linkMasters.crafts.smithy.master,
      `${back.crafts.smithy.master}`));
  t('битый сейв не роняет модуль', () => {
    const junk = restoreMasters({ crafts: { smithy: null, x: 7 }, day: 'ерунда' });
    ok(Object.keys(junk.crafts).length === 0, JSON.stringify(junk.crafts));
  });
}

console.log('\n--- Названия промыслов берутся из данных игры ---');
{
  t('кузница называется по-русски', () => ok(craftName('smithy') === BUILDINGS.smithy.name,
    craftName('smithy')));
  t('незнакомый промысел не роняет модуль', () => ok(typeof craftName('нет-такого') === 'string',
    craftName('нет-такого')));
}

console.log('\n--- На настоящей симуляции ---');
{
  const sim = new Simulation(4242, { startEra: 4 });
  for (let d = 0; d < 120; d++) sim.tick(1);
  t('память живёт в sim', () => ok(sim.linkMasters && sim.linkMasters.crafts,
    JSON.stringify(sim.linkMasters)));
  t('отчёт для панели собирается', () => ok(Array.isArray(mastersReport(sim)),
    JSON.stringify(mastersReport(sim))));
  t('Math.random в модуле не вызывается', () => {
    const src = readFileSync(new URL('../src/core/systems/link_masters.js', import.meta.url), 'utf8');
    ok(!/Math\.random\s*\(/.test(src), 'найден вызов Math.random');
  });
}

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
if (fail) process.exit(1);
