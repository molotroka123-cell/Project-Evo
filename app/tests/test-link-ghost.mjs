// Тесты тени прошлой партии (link_ghost.js).
// Запуск: node app/tests/test-link-ghost.mjs
//
// Здесь проверяется в том числе то, ради чего вся эта механика возможна:
// ДЕТЕРМИНИЗМ. Два прогона одного сида обязаны совпасть слепок в слепок —
// иначе сравнивать партии бессмысленно, и вся затея разваливается.
import { readFileSync } from 'node:fs';
import { Simulation } from '../src/core/simulation.js';
import {
  ghostTick, ghostReport, sealRun, snapshotOf, atDay,
  createGhost, restoreGhost,
  SNAP_EVERY, MAX_SNAPS, DIVERGE_PCT, YEAR,
} from '../src/core/systems/link_ghost.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK ', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

function run(seed, days, tweak) {
  const s = new Simulation(seed, { startEra: 4 });
  for (let d = 0; d < days; d++) { if (tweak) tweak(s, d); s.tick(1); }
  return s;
}

console.log('--- Мир детерминирован: без этого сравнивать нечего ---');
{
  const a = run(4242, 300);
  const b = run(4242, 300);
  t('два прогона одного сида дали одинаковые слепки',
    () => ok(JSON.stringify(a.linkGhost.snaps) === JSON.stringify(b.linkGhost.snaps),
      'слепки разошлись — детерминизм сломан'));
  const c = run(777, 300);
  t('разные сиды дают разные партии',
    () => ok(JSON.stringify(a.linkGhost.snaps) !== JSON.stringify(c.linkGhost.snaps),
      'разные сиды дали одно и то же'));
}

console.log('\n--- Слепки снимаются по расписанию ---');
{
  const s = run(11, SNAP_EVERY * 6 + 5);
  const snaps = s.linkGhost.snaps;
  t('слепков накопилось примерно по числу сезонов',
    () => ok(snaps.length >= 5 && snaps.length <= 9, `их ${snaps.length}`));
  t('дни идут по возрастанию', () => {
    for (let i = 1; i < snaps.length; i++) ok(snaps[i].d > snaps[i - 1].d, `д.${snaps[i].d} после д.${snaps[i - 1].d}`);
  });
  t('промежуток не меньше объявленного', () => {
    for (let i = 1; i < snaps.length; i++) {
      ok(snaps[i].d - snaps[i - 1].d >= SNAP_EVERY, `промежуток ${snaps[i].d - snaps[i - 1].d}`);
    }
  });
  t('в слепке есть всё, что нужно для сравнения', () => {
    const k = Object.keys(snaps[0]).sort().join(',');
    ok(k === 'b,d,era,food,gold,pop,stab,tech', k);
  });
}

console.log('\n--- Один день считается один раз ---');
{
  const s = run(11, 60);
  const before = s.linkGhost.snaps.length;
  ghostTick(s); ghostTick(s);
  t('повторные вызовы в те же сутки не плодят слепки',
    () => ok(s.linkGhost.snaps.length === before, `было ${before}, стало ${s.linkGhost.snaps.length}`));
}

console.log('\n--- Поиск по дню терпит несовпадение ---');
{
  const snaps = [{ d: 0, pop: 1 }, { d: 25, pop: 5 }, { d: 50, pop: 9 }];
  t('точное попадание', () => ok(atDay(snaps, 25).pop === 5, ''));
  t('ближайший, если точного нет', () => ok(atDay(snaps, 30).pop === 5, `${atDay(snaps, 30).pop}`));
  t('слишком далёкий слепок не годится — это была бы выдумка',
    () => ok(atDay(snaps, 500) === null, JSON.stringify(atDay(snaps, 500))));
  t('пустой список не роняет', () => ok(atDay([], 10) === null, ''));
}

console.log('\n--- Сравнение с прошлой партией ---');
{
  // Прошлая партия — обычная. Нынешняя — та же, но игрок раздал себе золота.
  const past = run(4242, 400);
  const seal = sealRun(past);

  const now = new Simulation(4242, { startEra: 4 });
  now.linkGhost.past = seal;
  for (let d = 0; d < 400; d++) { now.res.gold += 40; now.tick(1); }

  const rep = ghostReport(now, 'gold');
  t('прошлая партия найдена', () => ok(rep.hasPast, 'тени нет'));
  t('есть строки для сравнения', () => ok(rep.rows.length > 3, `строк ${rep.rows.length}`));
  t('в нынешней золота больше',
    () => ok(rep.rows[rep.rows.length - 1].now > rep.rows[rep.rows.length - 1].past,
      JSON.stringify(rep.rows[rep.rows.length - 1])));
  t('сводка написана словами',
    () => ok(/жители|золото/.test(rep.summary), rep.summary));
  t('о расхождении сказано в журнале',
    () => ok(now.log.some(l => /👻/.test(l.text || '')), 'ни одного сообщения о тени'));
}

console.log('\n--- Без прошлой партии сказано прямо ---');
{
  const s = run(11, 120);
  const rep = ghostReport(s, 'pop');
  t('тени нет', () => ok(!rep.hasPast, 'взялась тень из ниоткуда'));
  t('и это объяснено словами', () => ok(/сравнивать не с чем/.test(rep.summary), rep.summary));
}

console.log('\n--- Чужой сид не подставляется ---');
{
  const past = run(777, 200);
  const now = new Simulation(4242, { startEra: 4 });
  now.linkGhost.past = sealRun(past);          // тень от ДРУГОГО мира
  for (let d = 0; d < 200; d++) now.tick(1);
  t('тень с чужого сида не считается прошлой партией',
    () => ok(!ghostReport(now, 'pop').hasPast,
      'сравнили две разные карты — это бессмысленно'));
}

console.log('\n--- Список слепков не растёт бесконечно ---');
{
  const G = createGhost();
  G.seed = 1;
  for (let i = 0; i < MAX_SNAPS + 120; i++) G.snaps.push({ d: i * SNAP_EVERY, pop: i, gold: 0, food: 0, stab: 0, era: 0, b: 0, tech: 0 });
  const sim = { day: (MAX_SNAPS + 200) * SNAP_EVERY, seed: 1, linkGhost: G, villagers: [], res: {}, buildings: [], techs: new Set(), politics: null, eraIndex: 0 };
  const out = ghostTick(sim);
  t('после прореживания слепков не больше потолка',
    () => ok(out.flags.memory.snaps.length <= MAX_SNAPS, `их ${out.flags.memory.snaps.length}`));
  t('начало партии не потеряно',
    () => ok(out.flags.memory.snaps[0].d === 0, `первый слепок на дне ${out.flags.memory.snaps[0].d}`));
  t('последние слепки сохранены целиком', () => {
    const s = out.flags.memory.snaps;
    ok(s[s.length - 1].d >= (MAX_SNAPS + 100) * SNAP_EVERY, `последний на дне ${s[s.length - 1].d}`);
  });
}

console.log('\n--- Круг сохранения ---');
{
  const s = run(11, 200);
  const back = restoreGhost(JSON.parse(JSON.stringify(s.linkGhost)));
  t('слепки пережили сейв',
    () => ok(back.snaps.length === s.linkGhost.snaps.length, `${back.snaps.length} vs ${s.linkGhost.snaps.length}`));
  t('битый сейв не роняет модуль', () => {
    const junk = restoreGhost({ snaps: [null, 5, { d: 'ерунда' }], seed: 'x' });
    ok(Array.isArray(junk.snaps), JSON.stringify(junk));
  });
  t('запечатанная партия несёт сид и день конца', () => {
    const seal = sealRun(s);
    ok(seal.seed === s.seed && seal.ended === s.day, JSON.stringify({ seed: seal.seed, ended: seal.ended }));
  });
}

console.log('\n--- Модуль не трогает симуляцию ---');
{
  const s = run(11, 100);
  const before = JSON.stringify({ res: s.res, pop: s.villagers.length, day: s.day });
  ghostReport(s, 'pop'); sealRun(s); snapshotOf(s);
  const after = JSON.stringify({ res: s.res, pop: s.villagers.length, day: s.day });
  t('sim не изменился', () => ok(before === after, 'модуль тронул sim'));
  t('Math.random в модуле не вызывается', () => {
    const src = readFileSync(new URL('../src/core/systems/link_ghost.js', import.meta.url), 'utf8');
    ok(!/Math\.random\s*\(/.test(src), 'найден вызов Math.random');
  });
}

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
if (fail) process.exit(1);
