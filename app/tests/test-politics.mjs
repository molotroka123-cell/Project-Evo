// Тесты политики: формы правления, стабильность, сословия, правитель, доктрины.
// Запуск: node app/tests/test-politics.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRng } from '../src/core/rng.js';
import { LAWS } from '../src/core/systems/laws.js';
import {
  GOVERNMENTS, SOCIAL_FACTIONS, LAW_STANCES, RULER_TRAITS, SUCCESSION, DOCTRINES,
  STAB_START, GOV_CHANGE_COST, GOV_CHANGE_MIN_STAB, TURMOIL_DAYS, TURMOIL_MULT,
  REVOLT_FLOOR, REVOLT_COOLDOWN, REVOLT_SHOCK_HAPPY, FACTION_ANGRY, FACTION_DOMAIN, DOCTRINE_ERA_GATE,
  DOCTRINE_MIN_STAB, DOCTRINE_STAB_COST,
  createPolitics, serializePolitics, deserializePolitics,
  availableGovernments, canChangeGovernment, changeGovernment, government,
  applyLawFlags, avgApproval, angryFactions,
  createRuler, rulerCard, rulerTitle, deathChance, successionCrisis,
  doctrineNext, canPickDoctrine, pickDoctrine,
  politicsMult, politicsHappy, dailyPolitics, createPoliticsSystem,
} from '../src/core/systems/politics.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= (eps || 1e-9), `${msg}: ${a} != ${b}`);

const ctx = (over = {}) => ({ day: 50, era: 4, happy: 50, wars: 0, pop: 20, ...over });

// ---------- Формы правления ----------
t('строй: пять форм в историческом порядке, доступность по эпохам', () => {
  ok(GOVERNMENTS.length === 5, `форм правления ${GOVERNMENTS.length}`);
  const ids = GOVERNMENTS.map(g => g.id);
  ok(ids.join(',') === 'chiefdom,monarchy,republic,empire,federation', 'порядок форм не исторический');
  for (let i = 1; i < GOVERNMENTS.length; i++) ok(GOVERNMENTS[i].era >= GOVERNMENTS[i - 1].era, 'эпохи не растут вдоль пути');
  ok(availableGovernments(0).length === 1, 'в каменном веке доступно не только вождество');
  ok(availableGovernments(3).map(g => g.id).includes('republic'), 'республика недоступна в античности');
  ok(!availableGovernments(6).map(g => g.id).includes('federation'), 'федерация раньше эпохи 7');
  const latin = /[A-Za-z]/;
  for (const g of GOVERNMENTS) {
    ok(g.ru && !latin.test(g.ru) && g.text && !latin.test(g.text), `${g.id}: текст не по-русски`);
    ok(Object.keys(g.mult).length >= 2, `${g.id}: у строя нет числовых модификаторов`);
  }
});

t('строй: смена стоит стабильности и включает смуту, в смуту не меняют', () => {
  const s = createPolitics();
  ok(s.gov === 'chiefdom' && s.stability === STAB_START, 'старт не вождество/не 60');
  ok(!canChangeGovernment(s, 'federation', ctx({ era: 4 })).ok, 'федерация принята раньше эпохи');
  ok(!canChangeGovernment(s, 'chiefdom', ctx()).ok, 'смена на тот же строй разрешена');
  const r = changeGovernment(s, 'monarchy', ctx({ era: 2 }));
  ok(r.ok, 'монархия не установлена: ' + (r.reason || ''));
  near(s.stability, STAB_START - GOV_CHANGE_COST, 1e-9, 'цена реформы не списана');
  ok(s.turmoil === TURMOIL_DAYS, `смута ${s.turmoil} дн вместо ${TURMOIL_DAYS}`);
  ok(!changeGovernment(s, 'republic', ctx({ era: 3 })).ok, 'реформа прошла прямо в смуту');
  const low = createPolitics();
  low.stability = GOV_CHANGE_MIN_STAB - 1;
  ok(!changeGovernment(low, 'monarchy', ctx({ era: 2 })).ok, 'реформа при шаткой стабильности');
});

t('строй: модификаторы — числа, смута реально давит экономику', () => {
  const s = createPolitics();
  s.gov = 'empire';
  near(politicsMult(s, 'army'), 1.25, 1e-9, 'империя не усиливает армию');
  near(politicsMult(s, 'unrest'), 0.8, 1e-9, 'империя не давит беспорядки');
  near(politicsMult(s, 'какой-то-неизвестный'), 1, 1e-9, 'незнакомый kind не равен 1');
  const before = politicsMult(s, 'gold');
  s.turmoil = 5;
  near(politicsMult(s, 'gold'), before * TURMOIL_MULT.gold, 1e-9, 'смута не режет золото');
  ok(politicsHappy(s) < politicsHappy({ ...s, turmoil: 0 }), 'смута не портит счастье');
});

// ---------- Стабильность ----------
t('стабильность: растёт в мире и достатке, падает в войну и при злых сословиях', () => {
  const rng = createRng(7);
  const a = createPolitics(rng);
  a.ruler.traits = [];                      // черты не должны шуметь в этом тесте
  const s0 = a.stability;
  dailyPolitics(a, ctx({ happy: 70, wars: 0 }), null);
  ok(a.stability > s0, 'не растёт в спокойный сытый день');
  const b = createPolitics(createRng(7));
  b.ruler.traits = [];
  for (const f of Object.keys(b.factions)) b.factions[f] = 20;   // все злы
  const s1 = b.stability;
  dailyPolitics(b, ctx({ happy: 20, wars: 3 }), null);
  ok(b.stability < s1 - 1, `не падает в кризис (${(b.stability - s1).toFixed(2)}/день)`);
});

t('стабильность: ноль — восстание, откат к порогу и кулдаун', () => {
  const s = createPolitics();
  s.ruler = { name: 'Тест', age: 30, since: 0, traits: [] };
  s.stability = 0.1;
  for (const f of Object.keys(s.factions)) s.factions[f] = 10;
  const ev = dailyPolitics(s, ctx({ happy: 10, wars: 3 }), null);
  ok(ev.some(e => e.revolt), 'восстание не случилось на нуле');
  ok(s.revolts === 1 && s.stability === REVOLT_FLOOR, `после бунта stability=${s.stability}, ждали ${REVOLT_FLOOR}`);
  ok(s.revoltCd === REVOLT_COOLDOWN, 'кулдаун восстания не взведён');
  ok(politicsHappy(s) === politicsHappy({ ...s, revoltShock: 0 }) + REVOLT_SHOCK_HAPPY, 'шок восстания не давит на счастье');
  // Пока кулдаун — второго бунта нет, даже если снова ноль.
  s.stability = 0;
  const ev2 = dailyPolitics(s, ctx({ happy: 10, wars: 3 }), null);
  ok(!ev2.some(e => e.revolt), 'второе восстание сразу за первым');
});

// ---------- Сословия и законы ----------
t('сословия: каждый флаг каждого закона из laws.js есть в LAW_STANCES', () => {
  const flags = new Set();
  for (const l of LAWS) for (const o of l.options) for (const f of (o.flags || [])) flags.add(f);
  ok(flags.size >= 20, `флагов законов подозрительно мало: ${flags.size}`);
  for (const f of flags) ok(LAW_STANCES[f], `флаг «${f}» не описан в LAW_STANCES`);
  for (const f of Object.keys(LAW_STANCES)) ok(flags.has(f), `LAW_STANCES описывает несуществующий флаг «${f}»`);
  // Каждый закон кого-то радует и кого-то злит — бесплатных решений нет.
  for (const [f, st] of Object.entries(LAW_STANCES)) {
    const v = Object.values(st);
    ok(v.some(x => x > 0) && v.some(x => x < 0), `флаг «${f}» не делит общество`);
    for (const fid of Object.keys(st)) ok(SOCIAL_FACTIONS[fid], `флаг «${f}»: неизвестное сословие ${fid}`);
  }
});

t('сословия: флаг закона двигает одобрение ровно один раз', () => {
  const s = createPolitics();
  const before = s.factions.nobles;
  applyLawFlags(s, ['land_to_tillers']);
  near(s.factions.nobles, before + LAW_STANCES.land_to_tillers.nobles, 1e-9, 'знать не отреагировала на передел');
  ok(s.factions.commons > 55, 'простолюдины не рады переделу');
  const after = s.factions.nobles;
  applyLawFlags(s, ['land_to_tillers']);   // повтор не считается
  near(s.factions.nobles, after, 1e-9, 'флаг применён дважды');
  applyLawFlags(s, ['неизвестный_флаг']);  // мусор не роняет модуль
  ok(avgApproval(s) > 0, 'avgApproval сломался');
});

t('сословия: злое сословие саботирует своё ремесло', () => {
  const s = createPolitics();
  s.factions.merchants = FACTION_ANGRY - 1;
  near(politicsMult(s, 'gold'), (government(s).mult.gold || 1) * FACTION_DOMAIN.merchants.mult, 1e-9,
    'злые купцы не режут золото');
  ok(angryFactions(s).length === 1 && angryFactions(s)[0] === 'merchants', 'angryFactions не видит купцов');
  s.factions.merchants = FACTION_ANGRY;
  ok(!angryFactions(s).length, 'граница злости неверна');
});

// ---------- Правитель ----------
t('правитель: 2–3 черты, без конфликтующих пар, детерминизм от сида', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const r = createRuler(createRng(seed), 0);
    ok(r.traits.length >= 2 && r.traits.length <= 3, `сид ${seed}: черт ${r.traits.length}`);
    ok(new Set(r.traits).size === r.traits.length, `сид ${seed}: черты повторяются`);
    ok(!(r.traits.includes('just') && r.traits.includes('cruel')), `сид ${seed}: справедливый и жестокий разом`);
    ok(!(r.traits.includes('weak') && r.traits.includes('warlord')), `сид ${seed}: слабовольный полководец`);
    ok(r.age >= 28 && r.age <= 45, `сид ${seed}: возраст ${r.age}`);
  }
  const a = createRuler(createRng(42), 0), b = createRuler(createRng(42), 0);
  ok(a.name === b.name && a.traits.join() === b.traits.join(), 'один сид дал разных правителей');
});

t('правитель: черты — реальные модификаторы, карточка по-русски', () => {
  const s = createPolitics();
  s.ruler = { name: 'Яромир', age: 40, since: 0, traits: ['warlord', 'just'] };
  near(politicsMult(s, 'army'), (government(s).mult.army || 1) * 1.15, 1e-9, 'полководец не усиливает армию');
  ok(politicsHappy(s) >= government(s).happy + 3, 'справедливый не добавляет счастья');
  const card = rulerCard(s);
  ok(card.traits.length === 2 && !/[A-Za-z]/.test(card.traits.map(x => x.ru).join()), 'карточка черт не по-русски');
  ok(rulerTitle(s).includes('Яромир'), 'титул без имени');
});

t('правитель: смерть — кризис преемственности по тяжести строя', () => {
  ok(deathChance(30) < deathChance(60) && deathChance(60) < deathChance(90), 'шанс смерти не растёт с возрастом');
  ok(deathChance(120) <= 0.02, 'шанс смерти без потолка');
  for (const g of GOVERNMENTS) ok(SUCCESSION[g.id], `для ${g.id} нет правил наследования`);
  ok(SUCCESSION.chiefdom.stab > SUCCESSION.republic.stab, 'усобица вождества мягче выборов республики');
  const s = createPolitics(createRng(5));
  s.gov = 'monarchy';
  const oldName = s.ruler.name, st0 = s.stability;
  const r = successionCrisis(s, ctx(), createRng(99));
  ok(r.dead === oldName && s.ruler && s.ruler.name === r.heir, 'преемник не сел на трон');
  near(s.stability, st0 - SUCCESSION.monarchy.stab, 1e-9, 'кризис не стоил стабильности');
  ok(s.turmoil >= SUCCESSION.monarchy.turmoil, 'кризис без смуты');
  ok(s.rulersCount === 2, 'счёт правителей не растёт');
  ok(!/[A-Za-z]/.test(r.log), 'лог кризиса не по-русски');
});

t('правитель: старик умирает за разумный срок, событие приходит из dailyPolitics', () => {
  const s = createPolitics(createRng(3));
  s.ruler.age = 85;
  s.ruler.traits = [];
  const rng = createRng(11);
  let died = -1;
  for (let d = 0; d < 3000 && died < 0; d++) {
    const ev = dailyPolitics(s, ctx({ happy: 55 }), rng);
    if (ev.some(e => e.succession)) died = d;
  }
  ok(died >= 0, '85-летний правитель прожил ещё 30 лет');
  ok(s.rulersCount === 2, 'после смерти не появился новый правитель');
});

// ---------- Доктрины ----------
t('доктрины: 3 ветки по 4 ступени, у каждой ступени числовой эффект', () => {
  ok(DOCTRINES.length === 3, `веток ${DOCTRINES.length}`);
  const latin = /[A-Za-z]/;
  for (const d of DOCTRINES) {
    ok(d.tiers.length === 4, `${d.id}: ступеней ${d.tiers.length}`);
    ok(!latin.test(d.ru), `${d.id}: имя ветки не по-русски`);
    for (const tier of d.tiers) {
      ok(Object.keys(tier.mult).length > 0, `${d.id}/«${tier.ru}»: пустой эффект`);
      ok(!latin.test(tier.ru), `${d.id}: имя ступени не по-русски`);
    }
  }
  ok(DOCTRINE_ERA_GATE.length === 4, 'ворота эпох не на 4 ступени');
});

t('доктрины: порядок ступеней, ворота эпох, цена, необратимость', () => {
  const s = createPolitics();
  ok(!canPickDoctrine(s, 'power', ctx({ era: 0 })).ok, 'ступень 1 доступна в каменном веке');
  const r1 = pickDoctrine(s, 'power', ctx({ era: DOCTRINE_ERA_GATE[0] }));
  ok(r1.ok && s.doctrines.power === 1, 'ступень 1 не взята');
  near(s.stability, STAB_START - DOCTRINE_STAB_COST, 1e-9, 'ступень бесплатна');
  ok(!canPickDoctrine(s, 'power', ctx({ era: DOCTRINE_ERA_GATE[0] })).ok, 'ступень 2 доступна раньше своей эпохи');
  ok(pickDoctrine(s, 'power', ctx({ era: DOCTRINE_ERA_GATE[1] })).ok, 'ступень 2 не взята в срок');
  // Взятое навсегда: значение только растёт, функции отката в модуле нет.
  ok(s.doctrines.power === 2, 'счёт ступеней сломан');
  const m = politicsMult(s, 'army');
  near(m, (government(s).mult.army || 1) * 1.08 * 1.08, 1e-9, 'эффекты ступеней не перемножаются');
  s.stability = DOCTRINE_MIN_STAB - 1;
  ok(!canPickDoctrine(s, 'coin', ctx({ era: 9 })).ok, 'доктрина при низкой стабильности');
  s.stability = 60;
  for (let i = 0; i < 2; i++) pickDoctrine(s, 'power', ctx({ era: 9 }));
  ok(s.doctrines.power === 4 && !canPickDoctrine(s, 'power', ctx({ era: 9 })).ok, 'ветка не завершается на 4');
});

// ---------- Сейв и система ----------
t('сейв: полный круг serialize → deserialize без потерь', () => {
  const s = createPolitics(createRng(13));
  changeGovernment(s, 'monarchy', ctx({ era: 2 }));
  applyLawFlags(s, ['faith', 'retinue']);
  s.stability = 47.5;
  pickDoctrine(s, 'mind', ctx({ era: 5 }));
  const d = deserializePolitics(serializePolitics(s));
  ok(d.gov === 'monarchy' && d.turmoil === s.turmoil, 'строй/смута потеряны');
  near(d.stability, s.stability, 1e-9, 'стабильность потеряна');
  near(d.factions.clergy, s.factions.clergy, 1e-9, 'одобрение жрецов потеряно');
  ok(d.seenFlags.includes('faith') && d.seenFlags.includes('retinue'), 'учтённые флаги потеряны');
  ok(d.ruler && d.ruler.name === s.ruler.name && d.ruler.traits.join() === s.ruler.traits.join(), 'правитель потерян');
  ok(d.doctrines.mind === 1, 'доктрины потеряны');
  const empty = deserializePolitics(null);
  ok(empty.gov === 'chiefdom' && empty.stability === STAB_START, 'пустой сейв не даёт чистое состояние');
  const junk = deserializePolitics({ gov: 'чушь', stability: 9999, factions: { nobles: -50 }, doctrines: { power: 77 } });
  ok(junk.gov === 'chiefdom' && junk.stability === 100 && junk.factions.nobles === 0 && junk.doctrines.power === 4,
    'мусорный сейв не зажат в границы');
});

t('система: onNewDay читает флаги laws и счастье, пишет в лог, детерминирована', () => {
  const mkSim = (seed) => {
    const logs = [];
    return {
      rng: createRng(seed), day: 30, eraIndex: 2, _happy: 65,
      wars: [], villagers: new Array(15),
      res: { food: 100, gold: 100 },
      laws: { laws: { adopted: { tithe: 'a' }, order: [], offered: null } },   // флаг faith
      addLog: (text, type) => logs.push({ text, type }), toast: () => {}, logs,
    };
  };
  const sim = mkSim(21);
  const sys = createPoliticsSystem(sim.rng);
  const clergy0 = sys.state.factions.clergy;
  sys.onNewDay(sim);
  near(sys.state.factions.clergy, clamp01(clergy0 + LAW_STANCES.faith.clergy) - 0.05, 0.06,
    'жрецы не отреагировали на десятину храму');
  ok(sys.state.seenFlags.includes('faith'), 'флаг закона не учтён системой');
  ok(sim.logs.some(l => l.text.includes('Сословия')), 'реакция сословий не попала в лог');
  // Детерминизм: два одинаковых мира — одинаковые правители и стабильность.
  const s1 = mkSim(77), s2 = mkSim(77);
  const y1 = createPoliticsSystem(s1.rng), y2 = createPoliticsSystem(s2.rng);
  for (let i = 0; i < 50; i++) { y1.onNewDay(s1); y2.onNewDay(s2); }
  ok(y1.state.ruler.name === y2.state.ruler.name, 'один сид дал разных правителей в системе');
  near(y1.state.stability, y2.state.stability, 1e-9, 'один сид дал разную стабильность');
  function clamp01(v) { return v < 0 ? 0 : (v > 100 ? 100 : v); }
});

t('система: восстание через onNewDay грабит склады и шлёт toast', () => {
  const logs = []; let toasted = 0;
  const sim = {
    rng: createRng(2), day: 100, eraIndex: 3, _happy: 5,
    wars: [1, 2, 3], villagers: new Array(10),
    res: { food: 100, gold: 200 },
    laws: null,
    addLog: (t2, ty) => logs.push({ t2, ty }), toast: () => { toasted++; },
  };
  const sys = createPoliticsSystem(sim.rng);
  sys.state.stability = 0.1;
  for (const f of Object.keys(sys.state.factions)) sys.state.factions[f] = 5;
  sys.state.ruler.traits = [];
  sys.onNewDay(sim);
  ok(sys.state.revolts === 1, 'восстание не случилось');
  near(sim.res.food, 80, 1e-9, 'бунт не разграбил еду');
  near(sim.res.gold, 160, 1e-9, 'бунт не разграбил золото');
  ok(toasted === 1, 'toast о восстании не пришёл');
});

// ---------- Гигиена ----------
t('гигиена: без Math.random, без DOM, импорт только из core', () => {
  const full = readFileSync(fileURLToPath(new URL('../src/core/systems/politics.js', import.meta.url)), 'utf8');
  ok(full.includes('/* ИНТЕГРАЦИЯ'), 'нет блока интеграции для simulation.js');
  const src = full.split('/* ИНТЕГРАЦИЯ')[0];   // импорты в примере интеграции — не импорты модуля
  ok(!/Math\.random/.test(src), 'найден Math.random — детерминизм сломан');
  ok(!/\b(document|window|localStorage)\b/.test(src), 'найден DOM/браузерный API');
  for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
    ok(/^\.\.\/(data|world|rng)\.js$/.test(m[1]) || /^\.\/[a-z_0-9]+\.js$/.test(m[1]), `подозрительный импорт: ${m[1]}`);
  }
});

console.log(`=== ${pass} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
