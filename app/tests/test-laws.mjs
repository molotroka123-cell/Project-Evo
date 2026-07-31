// Тесты свода законов, цепочек событий и хроники (U29/U31/U32).
// Запуск: node app/tests/test-laws.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRng } from '../src/core/rng.js';
import { Simulation } from '../src/core/simulation.js';
import { ERAS, BUILDINGS } from '../src/core/data.js';
import {
  LAWS, CHAINS, LAW_KINDS, LAW_DELAY_DAYS, LAW_FIRST_DAY, CHRONICLE_MAX, POP_MILESTONES,
  createLaws, serializeLaws, deserializeLaws,
  lawForEra, lawDue, openLaw, adoptLaw, eraLawAdopted, adoptedLaws,
  lawMult, lawHappy, lawFlag, lawFlags, describeEffects, effectList,
  chainEvent, rollChainStart, takeDueChain, afterChoice, applyExtras, chainStatus,
  record, observe, chronicleEntries, chronicleText, chronicleStats,
} from '../src/core/systems/laws.js';
import * as Mod from '../src/core/systems/laws.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

// Контекст «как из ядра»: те же типы, что отдаёт Simulation.lawsCtx().
function ctx(over = {}) {
  return {
    day: 100, era: 0, eraDay: 20, pop: 12, housingCap: 20, happy: 55,
    res: { food: 200, wood: 100, stone: 50, steel: 0, gold: 300, knowledge: 0 },
    buildings: ['campfire', 'hut'], techs: new Set(['fire']),
    wars: [], repelled: 0, soldiers: 0, spireStage: 0,
    factionName: (f) => `фракция ${f}`, ...over,
  };
}

// ---------- U29. Таблица законов ----------
t('U29: законов не меньше 10, все эпохи покрыты, id уникальны', () => {
  ok(LAWS.length >= 10, `законов всего ${LAWS.length}`);
  const ids = new Set(LAWS.map(l => l.id));
  ok(ids.size === LAWS.length, 'дублирующиеся id законов');
  for (let e = 0; e < ERAS.length; e++) {
    const law = lawForEra(e, ctx({ era: e }));
    ok(law, `для эпохи ${e} (${ERAS[e].ru}) закона нет`);
    ok(law.era === e, `закон ${law.id} не из своей эпохи`);
  }
  console.log(`   законов: ${LAWS.length}, эпох покрыто: ${ERAS.length}`);
});

t('U29: у каждого закона ровно два необратимых варианта и живой русский текст', () => {
  const latin = /[A-Za-z]/;
  for (const l of LAWS) {
    ok(l.options.length === 2, `${l.id}: вариантов ${l.options.length}`);
    ok(l.options[0].key === 'a' && l.options[1].key === 'b', `${l.id}: ключи вариантов не a/b`);
    ok(l.ru && !latin.test(l.ru), `${l.id}: заголовок не по-русски`);
    ok(l.text.length > 25 && !latin.test(l.text), `${l.id}: текст ситуации не по-русски`);
    for (const o of l.options) {
      ok(o.ru && !latin.test(o.ru), `${l.id}.${o.key}: название варианта не по-русски`);
      ok(o.text && !latin.test(o.text), `${l.id}.${o.key}: пояснение не по-русски`);
      ok(o.chronicle && !latin.test(o.chronicle), `${l.id}.${o.key}: нет строки для летописи`);
      const hasRule = Object.keys(o.mult || {}).length > 0 || o.happy || o.rel;
      ok(hasRule, `${l.id}.${o.key}: вариант не меняет правил`);
      for (const k of Object.keys(o.mult || {})) ok(LAW_KINDS[k], `${l.id}.${o.key}: неизвестный множитель ${k}`);
      // Закон меняет правила, а не выдаёт ресурсы разово.
      ok(!('effect' in o) && !('cost' in o), `${l.id}.${o.key}: разовая выдача вместо правила`);
    }
    // Разбор эффектов для интерфейса должен знать про каждый множитель.
    for (const o of l.options) ok(effectList(o).length > 0, `${l.id}.${o.key}: эффекты не разбираются для интерфейса`);
    // Варианты обязаны различаться, иначе выбор бессмыслен.
    ok(describeEffects(l.options[0]) !== describeEffects(l.options[1]), `${l.id}: варианты одинаковы по эффекту`);
  }
});

t('U29: закон предлагается не сразу и ровно один раз за эпоху', () => {
  const s = createLaws();
  ok(!lawDue(s, ctx({ day: LAW_FIRST_DAY - 1, eraDay: 30 })), 'закон свалился в первые дни партии');
  ok(!lawDue(s, ctx({ day: 40, eraDay: LAW_DELAY_DAYS - 1 })), 'закон предложен раньше срока эпохи');
  const law = lawDue(s, ctx({ day: 40, eraDay: LAW_DELAY_DAYS }));
  ok(law && law.era === 0, 'закон эпохи 0 не предложен');
  const off = openLaw(s, ctx({ day: 40, eraDay: LAW_DELAY_DAYS }));
  ok(off.options.length === 2 && off.options[0].summary, 'презентация без сводки эффектов');
  const r = adoptLaw(s, 'a', ctx({ day: 40, eraDay: LAW_DELAY_DAYS }));
  ok(r.ok, 'закон не принят: ' + r.reason);
  ok(eraLawAdopted(s, 0), 'закон эпохи не отмечен принятым');
  ok(!lawDue(s, ctx({ day: 60, eraDay: 30 })), 'закон предлагают второй раз в ту же эпоху');
  const next = lawDue(s, ctx({ day: 200, era: 1, eraDay: 20 }));
  ok(next && next.era === 1, 'в новой эпохе закон не предложен');
  console.log(`   «${off.ru}» → ${r.optionRu}: ${r.summary}`);
});

t('U29: выбор необратим — переписать закон нельзя', () => {
  const s = createLaws();
  const c = ctx({ day: 40, eraDay: 10 });
  openLaw(s, c);
  ok(adoptLaw(s, 'a', c).ok, 'первый выбор не прошёл');
  const again = adoptLaw(s, 'b', c);
  ok(!again.ok, 'закон удалось переписать');
  ok(s.laws.adopted.hearth === 'a', 'принятый вариант подменился');
  // Отмены закона нет и в самом модуле: экспорта с таким смыслом не существует.
  ok(!Object.keys(Mod).some(k => /repeal|cancel|undo|отмен/i.test(k)), 'в модуле нашлась отмена закона');
  console.log(`   отказ: ${again.reason}`);
});

t('U29: множители перемножаются, счастье суммируется, чужой kind = 1', () => {
  const s = createLaws();
  const c0 = ctx({ day: 40, eraDay: 10 });
  openLaw(s, c0); adoptLaw(s, 'b', c0);                       // hearth b: gather ×1.15
  const c1 = ctx({ day: 200, era: 1, eraDay: 10 });
  openLaw(s, c1); adoptLaw(s, 'a', c1);                       // ore_hands a: gather ×1.18, happy −8
  const expect = 1.15 * 1.18;
  ok(Math.abs(lawMult(s, 'gather') - expect) < 1e-9, `добыча ${lawMult(s, 'gather')} вместо ${expect}`);
  ok(lawHappy(s) === -3 - 8, `счастье ${lawHappy(s)}`);
  ok(lawMult(s, 'выдуманный') === 1, 'незнакомый множитель не равен 1');
  ok(lawMult(createLaws(), 'gather') === 1, 'без законов множитель не 1');
  ok(lawFlag(s, 'child_labor'), 'флаг детского труда не выставлен');
  console.log(`   добыча ×${lawMult(s, 'gather').toFixed(3)}, счастье ${lawHappy(s)}, флаги: ${lawFlags(s).join(', ')}`);
});

t('U29: закон переживает сейв через JSON', () => {
  const s = createLaws();
  const c = ctx({ day: 40, eraDay: 10 });
  openLaw(s, c); adoptLaw(s, 'a', c);
  const c1 = ctx({ day: 200, era: 1, eraDay: 10 });
  openLaw(s, c1); adoptLaw(s, 'b', c1);
  const back = deserializeLaws(JSON.parse(JSON.stringify(serializeLaws(s))));
  ok(Math.abs(lawMult(back, 'knowledge') - lawMult(s, 'knowledge')) < 1e-9, 'множитель знаний потерян');
  ok(lawHappy(back) === lawHappy(s), 'счастье законов потеряно');
  ok(adoptedLaws(back).length === 2, 'список принятых законов потерян');
  ok(!lawDue(back, ctx({ day: 220, era: 1, eraDay: 40 })), 'после загрузки закон предлагают снова');
  // Мусорный и пустой сейв не должны ронять загрузку.
  ok(lawMult(deserializeLaws(null), 'gold') === 1, 'пустой сейв сломал модуль');
  ok(adoptedLaws(deserializeLaws({ laws: { adopted: { нет_такого: 'z' } } })).length === 0, 'принят несуществующий закон');
  console.log(`   принято законов после загрузки: ${adoptedLaws(back).map(l => l.ru + ' → ' + l.optionRu).join('; ')}`);
});

// ---------- U31. Цепочки ----------
t('U31: цепочек не меньше 5, у каждой 2-3+ звена и все переходы ведут в существующие', () => {
  ok(CHAINS.length >= 5, `цепочек всего ${CHAINS.length}`);
  const latin = /[A-Za-z]/;
  for (const ch of CHAINS) {
    const links = Object.keys(ch.links);
    ok(links.length >= 2, `${ch.id}: звеньев ${links.length}`);
    ok(ch.links[ch.first], `${ch.id}: первое звено ${ch.first} не описано`);
    ok(!latin.test(ch.ru), `${ch.id}: название не по-русски`);
    let reachable = 0;
    for (const [id, link] of Object.entries(ch.links)) {
      ok(link.text && link.text.length > 20 && !latin.test(link.text), `${ch.id}.${id}: текст не по-русски`);
      const opts = link.choice ? Object.values(link.choice) : [link];
      for (const o of opts) {
        for (const n of (o.next || [])) {
          ok(ch.links[n.link], `${ch.id}.${id}: переход в несуществующее звено ${n.link}`);
          ok(n.inDays && n.inDays[1] >= n.inDays[0] && n.inDays[0] > 0, `${ch.id}.${id}: кривой срок продолжения`);
          reachable++;
        }
      }
      if (link.choice) {
        ok(Object.keys(link.choice).length === 2, `${ch.id}.${id}: у выбора не два варианта`);
        for (const o of Object.values(link.choice)) ok(o.ru && !latin.test(o.ru), `${ch.id}.${id}: кнопка не по-русски`);
      }
    }
    ok(reachable >= 2, `${ch.id}: цепочка без продолжений`);
  }
  console.log(`   цепочек: ${CHAINS.length}, звеньев всего: ${CHAINS.reduce((a, c) => a + Object.keys(c.links).length, 0)}`);
});

t('U31: событие цепочки имеет тот же вид, что EVENT_DEFS ядра', () => {
  const ev = chainEvent('refugee', 'arrive');
  ok(ev.id && ev.ru && ev.text, 'нет обязательных полей события');
  ok(ev.choice && ev.choice.a && ev.choice.b, 'нет двух вариантов');
  ok(ev.choice.a.key === 'a' && ev.choice.b.key === 'b', 'варианты без ключа для afterChoice');
  ok(ev.chain.id === 'refugee' && ev.chain.link === 'arrive', 'нет метки цепочки');
  const auto = chainEvent('refugee', 'caravan');
  ok(!auto.choice && auto.effect.gold === 120, 'звено-развязка потеряло эффект');
  ok(chainEvent('нет', 'нет') === null, 'выдумано несуществующее звено');
});

// Прогон одной цепочки от начала до конца на фиксированном сиде.
function runChain(seed, key, days = 260) {
  const rng = createRng(seed);
  const s = createLaws();
  const c = ctx({ day: 0, era: 2, pop: 20, techs: new Set(['fire', 'trade']) });
  const seen = [];
  const start = chainEvent('refugee', 'arrive');
  s.chains.active.refugee = { link: 'arrive', since: 0, steps: 0 };
  afterChoice(s, start, key, { ...c, day: 0 }, rng);
  for (let d = 1; d <= days; d++) {
    const ev = takeDueChain(s, { ...c, day: d }, rng);
    if (ev) seen.push({ day: d, link: ev.chain.link, choice: !!ev.choice });
    // На звене с выбором всегда жмём «а», чтобы прогон оставался однозначным.
    if (ev && ev.choice) afterChoice(s, ev, 'a', { ...c, day: d }, rng);
  }
  return { s, seen };
}

t('U31: принятый беженец возвращается через год — с караваном или с бедой', () => {
  const outcomes = new Set();
  let sample = null;
  for (let seed = 1; seed <= 12; seed++) {
    const { seen } = runChain(seed, 'a');
    ok(seen.length >= 1, `сид ${seed}: продолжения не пришло`);
    ok(seen[0].day >= 60, `сид ${seed}: продолжение пришло уже на ${seen[0].day} день — это не «через год»`);
    outcomes.add(seen[0].link);
    if (seen[0].link === 'caravan') sample = seen;
  }
  ok(outcomes.has('caravan') && outcomes.has('betray'), `ветвление не работает: ${[...outcomes].join(',')}`);
  console.log(`   исходы «Беженца»: ${[...outcomes].join(', ')}; пример: продолжение на ${sample[0].day} день`);
});

t('U31: отказ ведёт в свою ветку, а цепочка закрывается после развязки', () => {
  const { s, seen } = runChain(3, 'b');
  ok(seen.length === 1 && seen[0].link === 'rumor', `после отказа пришло: ${seen.map(x => x.link).join(',')}`);
  ok(s.chains.done.includes('refugee'), 'цепочка не закрылась после развязки');
  ok(!s.chains.active.refugee, 'закрытая цепочка осталась активной');
  ok(s.chains.pending.length === 0, 'в очереди осталось лишнее звено');
  ok(s.chains.history.length === 2, `история цепочки: ${s.chains.history.length} записей`);
});

t('U31: одинаковый сид даёт одинаковую судьбу, разные — разную', () => {
  const a = runChain(5, 'a'), b = runChain(5, 'a'), c = runChain(9, 'a');
  ok(JSON.stringify(a.seen) === JSON.stringify(b.seen), 'один сид дал разный результат');
  const differs = JSON.stringify(a.seen) !== JSON.stringify(c.seen);
  ok(differs, 'разные сиды дали одну и ту же цепочку');
  // Сейв не должен переигрывать уже решённую судьбу.
  const { s } = runChain(7, 'a', 30);
  const saved = deserializeLaws(JSON.parse(JSON.stringify(serializeLaws(s))));
  ok(JSON.stringify(saved.chains.pending) === JSON.stringify(s.chains.pending), 'очередь цепочек не сохранилась');
});

t('U31: applyExtras выдаёт то, чего нет в applyEffect ядра', () => {
  const target = {
    res: { wood: 100, stone: 10, gold: 0, food: 0, steel: 0, knowledge: 0 },
    resCap: { wood: 400, stone: 400, gold: 99999, food: 200, steel: 500, knowledge: 99999 },
    army: { soldiers: 2 }, factions: [{ id: 'wolves' }, { id: 'guild' }], rels: [],
    adjustRel(fid, dR) { this.rels.push([fid, dR]); },
  };
  const logs = applyExtras({ stone: -25, soldiers: 3, rel: -8 }, target);
  ok(target.res.stone === 0, `камень ушёл в минус: ${target.res.stone}`);
  ok(target.army.soldiers === 5, `бойцов ${target.army.soldiers}`);
  ok(target.rels.length === 2 && target.rels[0][1] === -8, 'отношения не разосланы фракциям');
  ok(logs.length === 3, `строк лога ${logs.length}`);
  ok(applyExtras(null, target).length === 0, 'пустой extra что-то натворил');
  const cap = { res: { wood: 390 }, resCap: { wood: 400 } };
  applyExtras({ wood: 100 }, cap);
  ok(cap.res.wood === 400, `склад переполнен: ${cap.res.wood}`);
});

t('U31: старт цепочки уважает условия, кулдаун и потолок активных', () => {
  const rng = createRng(11);
  const s = createLaws();
  s.chains.cooldown = 0;
  // Каменный век без кузни и торговли: доступны не все цепочки.
  const early = ctx({ day: 30, era: 0, pop: 8 });
  const pool = CHAINS.filter(ch => ch.start.cond.minEra <= 0);
  ok(pool.length >= 1, 'ни одной цепочки для старта игры');
  let started = null;
  for (let d = 0; d < 4000 && !started; d++) {
    s.chains.cooldown = 0;
    started = rollChainStart(s, { ...early, day: 30 + d }, rng);
  }
  ok(started, 'цепочка так и не началась за 4000 дней');
  ok(pool.some(p => p.id === started.chain.id), `началась недоступная цепочка ${started.chain.id}`);
  ok(s.chains.cooldown > 0, 'кулдаун не выставлен');
  ok(chainStatus(s).length === 1, 'статус активных цепочек пуст');
  console.log(`   первая цепочка: ${started.ru}`);
});

// ---------- U32. Хроника ----------
t('U32: летопись ведётся сама — эпохи, вехи, потери, войны, чудеса', () => {
  const s = createLaws();
  observe(s, ctx({ day: 1, era: 0, pop: 8 }));
  const e1 = observe(s, ctx({ day: 50, era: 1, pop: 12 }));
  ok(e1.some(e => e.kind === 'era'), 'смена эпохи не попала в летопись');
  ok(e1.some(e => e.kind === 'growth' && e.text.includes(String(POP_MILESTONES[0]))), 'веха населения 10 не отмечена');
  const e2 = observe(s, ctx({ day: 60, era: 1, pop: 30, buildings: ['campfire', 'temple'] }));
  ok(e2.some(e => e.kind === 'wonder' && e.text.includes(BUILDINGS.temple.name)), 'храм не отмечен');
  const e3 = observe(s, ctx({ day: 70, era: 1, pop: 30, wars: [{ fid: 'wolves' }] }));
  ok(e3.some(e => e.kind === 'war' && e.text.includes('Началась война')), 'начало войны не записано');
  const e4 = observe(s, ctx({ day: 90, era: 1, pop: 18, wars: [], repelled: 1 }));
  ok(e4.some(e => e.kind === 'loss'), 'обвал населения не записан');
  ok(e4.some(e => e.text.includes('Война окончена')), 'конец войны не записан');
  ok(e4.some(e => e.text.includes('Набег отбит')), 'отбитый набег не записан');
  // Повторный вызов в тот же день не должен дублировать записи.
  ok(observe(s, ctx({ day: 90, era: 1, pop: 18, wars: [], repelled: 1 })).length === 0, 'летопись дублирует записи');
  console.log('   ' + chronicleText(s).split('\n').slice(0, 4).join(' | '));
});

t('U32: летопись читается всю партию, фильтруется и не растёт бесконечно', () => {
  const s = createLaws();
  for (let i = 0; i < CHRONICLE_MAX + 120; i++) {
    record(s, { day: i, era: Math.min(9, Math.floor(i / 80)), kind: i % 7 === 0 ? 'loss' : 'note', weight: i % 7 === 0 ? 3 : 1, text: `Событие номер ${i}` });
  }
  ok(s.chronicle.length === CHRONICLE_MAX, `в летописи ${s.chronicle.length} записей`);
  const losses = chronicleEntries(s, { kind: 'loss' });
  ok(losses.length > 50, `важные записи вытеснены: осталось ${losses.length}`);
  ok(chronicleEntries(s, { era: 3 }).every(e => e.era === 3), 'фильтр по эпохе не работает');
  const text = chronicleText(s, { minWeight: 3 });
  ok(text.includes(`— ${ERAS[3].ru}`), 'в тексте нет заголовков эпох');
  ok(chronicleText(createLaws()) === 'Летопись пока пуста.', 'пустая летопись без внятного текста');
  ok(record(s, { day: 1, era: 0, text: '   ' }) === null, 'пустая запись попала в летопись');
  console.log(`   записей: ${chronicleStats(s).total}, из них потерь: ${losses.length}`);
});

t('U32: решения — законы и развязки цепочек — попадают в летопись сами', () => {
  const s = createLaws();
  const c = ctx({ day: 40, eraDay: 10 });
  openLaw(s, c);
  const r = adoptLaw(s, 'a', c);
  ok(r.chronicle.length === 1 && r.chronicle[0].kind === 'law', 'закон не записан в летопись');
  const rng = createRng(4);
  const ev = chainEvent('debt', 'offer');
  s.chains.active.debt = { link: 'offer', since: 40, steps: 0 };
  const res = afterChoice(s, ev, 'a', ctx({ day: 40, era: 2 }), rng);
  ok(res.chronicle.length === 1 && res.chronicle[0].kind === 'chain', 'выбор в цепочке не записан');
  ok(res.next && res.next.day >= 140, `срок возврата долга неправдоподобен: ${res.next && res.next.day}`);
  const stats = chronicleStats(s);
  ok(stats.laws === 1 && stats.byKind.law === 1 && stats.byKind.chain === 1, 'счётчики летописи врут');
  console.log('   ' + chronicleText(s).replace(/\n/g, ' | '));
});

// ---------- Интеграция и чистота ----------
t('модуль не трогает Math.random и не лезет в DOM', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/core/systems/laws.js', import.meta.url)), 'utf8');
  ok(!/Math\.random/.test(src), 'найден Math.random — детерминизм сломан');
  ok(!/\b(document|window|localStorage)\b/.test(src), 'модуль лезет в DOM');
  ok(!/TODO|FIXME|console\.log/.test(src), 'в модуле остались заглушки или отладка');
  // Только настоящие импорты: строки, начинающиеся с import. Примеры внутри
  // блока INTEGRATION — это комментарии, они не в счёт.
  const imports = src.split('\n').filter(l => l.startsWith('import ')).map(l => (l.match(/from\s+'([^']+)'/) || [])[1]).filter(Boolean);
  ok(imports.every(i => i.startsWith('../')), `посторонний импорт: ${imports.join(', ')}`);
});

t('живая партия: 600 дней с законами, цепочками и летописью', () => {
  const s = new Simulation(42);
  const st = createLaws();
  const rng = s.rng;
  s.execCommand('give wood 400'); s.execCommand('give food 400'); s.execCommand('give gold 400');
  s.placeBuilding('hut', 44, 44); s.placeBuilding('lumber', 46, 42);
  const cx = () => ({
    day: s.day, era: s.eraIndex, eraDay: s.eraDay, pop: s.villagers.length,
    housingCap: s.housingCap(), happy: s.happiness(), res: s.res,
    buildings: s.doneBuildings(), techs: s.techs, wars: s.wars, repelled: s.repelled,
    soldiers: s.army.soldiers, spireStage: s.spire ? s.spire.stage : 0,
    factionName: (f) => { const fa = s.faction(f); return fa ? fa.def.name : f; },
  });
  let lastDay = -1, chainEvents = 0;
  for (let i = 0; i < 1200; i++) {
    s.tick(0.5);
    if (s.day === lastDay) continue;
    lastDay = s.day;
    // На середине партии племя доходит до бронзы — эпоха меняется, и летопись
    // обязана это заметить сама, без единого вызова из теста.
    if (s.day === 150) { s.res.knowledge += 2000; for (const id of ['tools', 'farming', 'pottery', 'bronze']) s.research(id); }
    // Закон: игрок всегда выбирает первый вариант.
    const off = openLaw(st, cx());
    if (off) adoptLaw(st, 'a', cx());
    // Цепочки: разрешаем звено сразу, как ядро при нажатии кнопки.
    const ev = takeDueChain(st, cx(), rng) || rollChainStart(st, cx(), rng);
    if (ev) {
      chainEvents++;
      if (ev.choice) {
        const opt = ev.choice.a;
        if (opt.cost) { let can = true; for (const [r, v] of Object.entries(opt.cost)) if (s.res[r] < v) can = false; if (can) s.payCost(opt.cost); }
        s.applyEffect(opt.effect || {});
        applyExtras(opt.extra, s);
        afterChoice(st, ev, 'a', cx(), rng);
      } else {
        s.applyEffect(ev.effect || {});
        applyExtras(ev.extra, s);
      }
    }
    observe(st, cx());
  }
  ok(s.villagers.length > 0, 'поселение вымерло');
  ok(adoptedLaws(st).length >= 1, 'за 600 дней не принято ни одного закона');
  ok(st.chronicle.length >= 3, `летопись почти пуста: ${st.chronicle.length}`);
  const eraLine = chronicleEntries(st, { kind: 'era' });
  ok(eraLine.length >= 1, 'смены эпох не попали в летопись живой партии');
  console.log(`   день ${s.day}, население ${s.villagers.length}, законов ${adoptedLaws(st).length}, событий цепочек ${chainEvents}, записей летописи ${st.chronicle.length}`);
});

t('модуль не влияет на детерминизм ядра', () => {
  const run = (withLaws) => {
    const s = new Simulation(77);
    const st = createLaws();
    for (let i = 0; i < 400; i++) {
      s.tick(0.5);
      if (!withLaws) continue;
      // Чтение состояния не должно трогать rng ядра.
      lawMult(st, 'gather'); lawHappy(st);
      observe(st, { day: s.day, era: s.eraIndex, eraDay: s.eraDay, pop: s.villagers.length, res: s.res, buildings: s.doneBuildings(), techs: s.techs });
    }
    return `${s.res.food.toFixed(6)}/${s.villagers.length}/${s.rng.getState()}`;
  };
  const a = run(false), b = run(true);
  ok(a === b, `состояние разошлось: ${a} vs ${b}`);
});

console.log(`\nИтого: ${pass} прошло, ${fail} упало.`);
process.exit(fail ? 1 : 0);
