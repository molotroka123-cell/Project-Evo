// Тесты разведки (link_intel.js). Запуск: node app/tests/test-link-intel.mjs
//
// Главное, что здесь проверяется: игрок видит УСТАРЕВШЕЕ, а не подделанное.
// Модуль не имеет права врать — он имеет право молчать и стареть.
import { readFileSync } from 'node:fs';
import { Simulation } from '../src/core/simulation.js';
import {
  intelLinks, knownOf, channelFor, intelReport, armyWord, ageWord, trustWord,
  createIntel, restoreIntel,
  PERIOD, DANGER_STRETCH, BORDER_SPEEDUP, BORDER_DIST, STALE_FULL,
  FRESH_DAYS, ROUGH_DAYS, YEAR,
} from '../src/core/systems/link_intel.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK ', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≠ ${b}`);

function makeSim(o = {}) {
  const far = o.far ?? 40;
  return {
    day: o.day ?? 0,
    world: { startX: 0, startY: 0 },
    wars: o.atWar ? [{ fid: 'orda' }] : [],
    treaties: o.treaty ? [{ b: 'orda' }] : [],
    relations: o.relations || {},
    factions: [{
      id: 'orda', alive: true, armyPts: o.army ?? 40, era: o.era ?? 3,
      P: 100, techCount: 12, def: { name: 'Орда' },
      settlements: [{ x: far, y: 0 }],
    }],
    linkIntel: o.intel || createIntel(),
    sys: o.sys || {},
  };
}

console.log('--- Канал новостей зависит от отношений ---');
{
  const f = (sim) => channelFor(sim, sim.factions[0]);
  t('война — разведчики ходят чаще всех',
    () => ok(f(makeSim({ atWar: true })).source === 'war', JSON.stringify(f(makeSim({ atWar: true })))));
  t('договор — караваны возят новости',
    () => ok(f(makeSim({ treaty: true })).source === 'treaty', ''));
  t('лад — ездят послы',
    () => ok(f(makeSim({ relations: { orda: 40 } })).source === 'friendly', ''));
  t('вражда — границы закрыты, только слухи',
    () => ok(f(makeSim({ relations: { orda: -40 } })).source === 'hostile', ''));
  t('от договора вести приходят чаще, чем от вражды',
    () => ok(f(makeSim({ treaty: true })).period < f(makeSim({ relations: { orda: -40 } })).period,
      `${f(makeSim({ treaty: true })).period} vs ${f(makeSim({ relations: { orda: -40 } })).period}`));
}

console.log('\n--- Опасные дороги обрывают не только торговлю ---');
{
  const calm = channelFor(makeSim({ treaty: true }), makeSim({ treaty: true }).factions[0]);
  const danger = makeSim({ treaty: true, sys: { nbrLinks: { flags: { routeDanger: 1 } } } });
  const war = channelFor(danger, danger.factions[0]);
  t('при опасных дорогах вести идут дольше',
    () => ok(war.period > calm.period, `${war.period} vs ${calm.period}`));
  t('растяжение не больше объявленного',
    () => ok(war.period <= Math.round(calm.period * DANGER_STRETCH) + 1,
      `${war.period} при потолке ${calm.period * DANGER_STRETCH}`));

  // Войну это не касается: разведчики ходят как раз потому, что война.
  const wDanger = makeSim({ atWar: true, sys: { nbrLinks: { flags: { routeDanger: 1 } } } });
  t('на войне опасность дорог вестям не мешает',
    () => ok(channelFor(wDanger, wDanger.factions[0]).period === PERIOD.war * BORDER_SPEEDUP
      || channelFor(wDanger, wDanger.factions[0]).period === PERIOD.war,
      `${channelFor(wDanger, wDanger.factions[0]).period}`));
}

console.log('\n--- Ближнего соседа видно и без послов ---');
{
  const near0 = makeSim({ far: BORDER_DIST - 5 });
  const far = makeSim({ far: BORDER_DIST + 40 });
  t('от ближнего вести приходят вдвое чаще',
    () => ok(channelFor(near0, near0.factions[0]).period < channelFor(far, far.factions[0]).period,
      `${channelFor(near0, near0.factions[0]).period} vs ${channelFor(far, far.factions[0]).period}`));
}

console.log('\n--- Знание стареет ---');
{
  const sim = makeSim({ day: 0, army: 40 });
  const first = intelLinks(sim);
  sim.linkIntel = first.flags.memory;
  t('в первый же день что-то узнаём',
    () => ok(knownOf(sim, 'orda').any, 'ничего не узнали'));
  t('свежим сведениям верят полностью',
    () => near(knownOf(sim, 'orda').trust, 1, 1e-9, 'доверие'));
  t('свежая армия показана числом',
    () => ok(/^~\d+$/.test(knownOf(sim, 'orda').armyText), knownOf(sim, 'orda').armyText));

  // Сосед вырос втрое, но вестей не было — мы об этом не знаем.
  sim.factions[0].armyPts = 120;
  sim.day = FRESH_DAYS + 5;
  const k = knownOf(sim, 'orda');
  t('без вестей мы помним СТАРОЕ число, а не новое',
    () => ok(k.armyPts === 40, `${k.armyPts}`));
  t('старое число огрублено до десятков',
    () => ok(/около/.test(k.armyText), k.armyText));
  t('доверие упало', () => ok(k.trust < 1, `${k.trust}`));
  t('сказано, когда это узнали', () => ok(/дн\.|год/.test(k.ageText), k.ageText));

  sim.day = ROUGH_DAYS + 20;
  t('совсем старое становится словом, а не числом',
    () => ok(/войско/.test(knownOf(sim, 'orda').armyText), knownOf(sim, 'orda').armyText));
}

console.log('\n--- Модуль не врёт: он показывает устаревшее ---');
{
  const sim = makeSim({ day: 0, army: 40 });
  sim.linkIntel = intelLinks(sim).flags.memory;
  sim.factions[0].armyPts = 999;
  sim.day = 50;
  const k = knownOf(sim, 'orda');
  t('показанное число когда-то было правдой',
    () => ok(k.armyPts === 40, `показано ${k.armyPts}, а правдой было 40`));
  t('и честно помечено возрастом', () => ok(k.age === 50, `${k.age}`));
  t('доверие названо словами', () => ok(typeof trustWord(k.trust) === 'string' && trustWord(k.trust).length > 5,
    trustWord(k.trust)));
}

console.log('\n--- Про незнакомца сказано прямо ---');
{
  const sim = makeSim({ day: 100 });
  const k = knownOf(sim, 'кого-нет');
  t('нет вестей — так и написано', () => ok(!k.any && /не известно|не было/.test(k.armyText + k.ageText),
    `${k.armyText} / ${k.ageText}`));
  t('доверие нулевое', () => ok(k.trust === 0, `${k.trust}`));
}

console.log('\n--- Вести приходят по расписанию, а не каждый день ---');
{
  const sim = makeSim({ day: 0, relations: { orda: 0 } });
  sim.linkIntel = intelLinks(sim).flags.memory;
  const period = channelFor(sim, sim.factions[0]).period;
  let updates = 0;
  for (let d = 1; d <= period * 3; d++) {
    sim.day = d;
    const out = intelLinks(sim);
    sim.linkIntel = out.flags.memory;
    if (out.flags.fresh.length) updates++;
  }
  t('за три срока вестей пришло около трёх раз',
    () => ok(updates >= 2 && updates <= 4, `их ${updates} при сроке ${period}`));
}

console.log('\n--- О заметной перемене рассказывают ---');
{
  const sim = makeSim({ day: 0, army: 20, atWar: true });
  sim.linkIntel = intelLinks(sim).flags.memory;
  sim.factions[0].armyPts = 90;                 // войско выросло вчетверо
  sim.day = PERIOD.war * 2;
  const out = intelLinks(sim);
  t('о выросшем войске сказано',
    () => ok(out.events.some(e => /войско выросло/.test(e.text)), JSON.stringify(out.events)));

  // А о мелочи — молчат: «вести пришли» каждые шесть дней это шум.
  const quiet = makeSim({ day: 0, army: 40, atWar: true });
  quiet.linkIntel = intelLinks(quiet).flags.memory;
  quiet.factions[0].armyPts = 41;
  quiet.day = PERIOD.war * 2;
  t('о мелкой перемене молчат',
    () => ok(intelLinks(quiet).events.length === 0, JSON.stringify(intelLinks(quiet).events)));
}

console.log('\n--- Один день считается один раз ---');
{
  const sim = makeSim({ day: 7 });
  const a = intelLinks(sim);
  sim.linkIntel = a.flags.memory;
  const b = intelLinks(sim);
  t('повторный вызов в те же сутки ничего не делает',
    () => ok(b.flags.fresh.length === 0, JSON.stringify(b.flags.fresh)));
}

console.log('\n--- Круг сохранения ---');
{
  const sim = makeSim({ day: 30, army: 55 });
  sim.linkIntel = intelLinks(sim).flags.memory;
  const back = restoreIntel(JSON.parse(JSON.stringify(sim.linkIntel)));
  t('знание пережило сейв', () => ok(back.known.orda && back.known.orda.armyPts === 55,
    JSON.stringify(back.known)));
  t('битый сейв не роняет модуль', () => {
    const junk = restoreIntel({ known: { orda: null, x: 5 }, day: 'ерунда' });
    ok(Object.keys(junk.known).length === 0, JSON.stringify(junk.known));
  });
}

console.log('\n--- Сводка для панели ---');
{
  const sim = makeSim({ day: 40, army: 33 });
  sim.linkIntel = intelLinks(makeSim({ day: 0, army: 33 })).flags.memory;
  const rows = intelReport(sim);
  t('строка на соседа собрана', () => ok(rows.length === 1, `строк ${rows.length}`));
  t('в строке есть и оценка, и её возраст, и доверие',
    () => ok(rows[0].armyText && rows[0].ageText && rows[0].trustText, JSON.stringify(rows[0])));
}

console.log('\n--- На настоящей симуляции ---');
{
  const sim = new Simulation(11, { startEra: 4 });
  for (let d = 0; d < 80; d++) sim.tick(1);
  t('разведка живёт в sim', () => ok(sim.linkIntel && sim.linkIntel.known, JSON.stringify(sim.linkIntel)));
  t('про соседей что-то известно', () => {
    const f = sim.factions.find(x => x.alive);
    ok(!f || knownOf(sim, f.id).any, 'ни одного соседа не разведали за 80 дней');
  });
  t('Math.random в модуле не вызывается', () => {
    const src = readFileSync(new URL('../src/core/systems/link_intel.js', import.meta.url), 'utf8');
    ok(!/Math\.random\s*\(/.test(src), 'найден вызов Math.random');
  });
}

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
if (fail) process.exit(1);
