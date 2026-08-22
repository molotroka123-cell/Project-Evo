// Тесты модели рода (dynasty.js).
// Запуск: node app/tests/test-dynasty.mjs
//
// Проверяем не «функция не упала», а числа и направления: кто именно встаёт на
// трон при каждом строе, где у законности потолки и где выход, что месяц голода
// считается одной бедой, что междуцарствие КОНЧАЕТСЯ, что модуль не мутирует ни
// переданное состояние, ни sim, и что круг сохранения замкнут даже на мусоре.
import { readFileSync } from 'node:fs';
import { createRng } from '../src/core/rng.js';
import { Simulation } from '../src/core/simulation.js';
import { RULER_TRAITS, SUCCESSION } from '../src/core/systems/politics.js';
import {
  createDynasty, serializeDynasty, restoreDynasty, dynastyNewDay,
  heirOf, ruler, memberOf, bloodMembers, powerOf, legitimacy, baseLegitimacy,
  legitimacyWord, politicsRuler, dynastyCard, dynastyRows, ageYearsOf,
  canPatronize, patronizeCourt, patronCost, canSetCourt, setCourt,
  canNameHeir, nameHeir, clearHeir, canMarryHeir, marryHeir,
  canOverthrow, overthrow,
  YEAR, ADULT_YEARS, MARRY_MIN, SUCCESSION_LAW, TRAIT_POWER, COURT,
  LEG_START, LEG_MIN, LEG_MAX, LEG_EVENT, SEEN_WINDOW, LEG_DRIFT,
  CLAIM_BELOW, CLAIM_CLEAR, MAX_CLAIMANTS, CLAIM_STAB,
  INTERREGNUM_DAYS, INTERREGNUM_STAB, COUP_LEG, COUP_STAB,
  PATRON_LEG, PATRON_CD, MARRY_REL, FOREIGN_CLAIM, MAX_MEMBERS,
} from '../src/core/systems/dynasty.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK  ', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≠ ${b}`);

// ---- Подделки -------------------------------------------------------------
// Род собираем руками через restoreDynasty: так проверка не зависит от бросков
// костей и заодно каждый раз прогоняется восстановление из файла.
function person(id, o = {}) {
  const blood = o.blood !== false;
  return {
    id, name: o.name || `Ч${id} Кремень`, fam: 'Кремень', sex: o.sex || 'м',
    age: (o.years ?? 30) * YEAR, born: 0, gen: o.gen ?? 1, blood,
    origin: blood ? 'blood' : 'married', traits: o.traits || [],
    father: o.father ?? null, mother: o.mother ?? null, spouse: o.spouse ?? null,
    fertCd: 0, since: 0,
  };
}
function house(members, extra = {}) {
  return restoreDynasty({
    v: 1, day: 0, nextId: 500, fam: 'Кремень', founder: 'Ч1 Кремень', foundedDay: 0,
    generations: 1, members, rulerId: members[0] ? members[0].id : null,
    legitimacy: LEG_START, court: 1, stats: { rulers: 1, houses: 1 }, ...extra,
  });
}
const ctxOf = (o = {}) => ({ day: 0, gov: 'monarchy', pop: 20, gold: 1000, foodDays: 30, stability: 60, nobles: 50, military: 50, ...o });

// rng с предсказуемым chance: срабатывает только для вероятностей из окна
// (lo, hi). Это позволяет включить ровно одну ветку — смерть, свадьбу,
// претендента — не трогая остальные и не гоняя тысячу дней ради удачи.
function rngBand(lo, hi, seed = 1) {
  const base = createRng(seed);
  return { ...base, chance: (p) => p > lo && p < hi };
}
const rngNever = (seed = 1) => ({ ...createRng(seed), chance: () => false });
const rngAlways = (seed = 1) => ({ ...createRng(seed), chance: () => true });

console.log('--- Таблицы согласованы с politics.js ---');
{
  t('на каждый строй из SUCCESSION есть закон наследования', () => {
    for (const id of Object.keys(SUCCESSION)) ok(SUCCESSION_LAW[id], `нет закона для ${id}`);
  });
  t('лишних строёв в законе наследования не заведено', () => {
    for (const id of Object.keys(SUCCESSION_LAW)) ok(SUCCESSION[id], `${id} не знаком politics.js`);
  });
  t('у каждой черты правителя есть вес силы', () => {
    for (const tr of RULER_TRAITS) ok(TRAIT_POWER[tr.id] != null, `черта ${tr.id} без веса`);
  });
  t('вторая таблица черт не заведена: веса ссылаются только на RULER_TRAITS', () => {
    const ids = new Set(RULER_TRAITS.map(x => x.id));
    for (const id of Object.keys(TRAIT_POWER)) ok(ids.has(id), `${id} нет в RULER_TRAITS`);
  });
}

console.log('\n--- Рождение рода ---');
{
  const st = createDynasty(createRng(42), { day: 0 });
  t('у рода есть фамилия', () => ok(st.fam && st.fam !== '—', st.fam));
  t('основатель назван и сидит на троне', () => ok(ruler(st) && ruler(st).name === st.founder, JSON.stringify(st.founder)));
  t('род начинается не с холостяка: у основателя есть супруг',
    () => ok(ruler(st).spouse != null && memberOf(st, ruler(st).spouse), 'супруга нет'));
  t('у основателя есть дети — иначе первая же болезнь обрывает партию',
    () => ok(st.members.some(m => m.gen === 2), JSON.stringify(st.members.map(m => m.gen))));
  t('черты правителя берутся только из RULER_TRAITS', () => {
    const ids = new Set(RULER_TRAITS.map(x => x.id));
    for (const m of st.members) for (const tr of m.traits) ok(ids.has(tr), `чужая черта ${tr}`);
  });
  t('черт не больше трёх, как у createRuler в politics.js',
    () => ok(st.members.every(m => m.traits.length <= 3), 'черт больше трёх'));
  t('несовместимые черты не сходятся (жестокий любимец толпы невозможен)',
    () => ok(st.members.every(m => !(m.traits.includes('cruel') && m.traits.includes('beloved'))), 'сошлись cruel+beloved'));
  t('возраст хранится в ДНЯХ, как у жителей в population.js',
    () => ok(ruler(st).age >= 28 * YEAR && ruler(st).age <= 45 * YEAR, `age=${ruler(st).age}`));
  t('вошедший через брак не кровный и наследовать не может',
    () => ok(!memberOf(st, ruler(st).spouse).blood, 'супруг оказался кровным'));
  t('законность стартует с середины', () => near(legitimacy(st), LEG_START, 1e-9, 'законность'));
  t('мост к politics.js отдаёт возраст в ГОДАХ, а не в днях', () => {
    const r = politicsRuler(st);
    near(r.age, ruler(st).age / YEAR, 1e-9, 'возраст правителя');
    ok(r.age > 20 && r.age < 60, `${r.age} — похоже, единицы перепутаны`);
  });
  t('годы считаются той же меркой, что у жителей: 100 дней = год', () => {
    for (const m of st.members) ok(ageYearsOf(m) === Math.floor(m.age / YEAR), `${m.name}: ${m.age} → ${ageYearsOf(m)}`);
    ok(st.members.some(m => ageYearsOf(m) < ADULT_YEARS), 'детей в роду не оказалось');
  });
  t('кровных меньше, чем всех: пришлые числятся роднёй, но не наследуют',
    () => ok(bloodMembers(st).length < st.members.length, `${bloodMembers(st).length} из ${st.members.length}`));
  t('ступеней содержания двора три, и дороже — значит почётнее', () => {
    ok(COURT.length === 3, `ступеней ${COURT.length}`);
    for (let i = 1; i < COURT.length; i++) {
      ok(COURT[i].gold >= COURT[i - 1].gold && COURT[i].leg > COURT[i - 1].leg, `ступень ${i} выбивается: ${JSON.stringify(COURT[i])}`);
    }
  });
}

console.log('\n--- Наследник по закону строя ---');
{
  // Правитель 60 лет; сын 30, сын 20 (полководец), дочь 35.
  const st = house([
    person(1, { years: 60 }),
    person(2, { years: 30, gen: 2, father: 1 }),
    person(3, { years: 20, gen: 2, father: 1, traits: ['warlord'] }),
    person(4, { years: 35, sex: 'ж', gen: 2, father: 1 }),
  ]);
  t('монархия: старший сын', () => {
    const h = heirOf(st, ctxOf({ gov: 'monarchy' }));
    ok(h && h.id === 2, JSON.stringify(h && h.name));
  });
  t('вождество: сильнейший, а не старший', () => {
    const h = heirOf(st, ctxOf({ gov: 'chiefdom' }));
    ok(h && h.id === 3, `${h && h.name}, силы: ${st.members.map(m => `${m.id}:${powerOf(m)}`).join(' ')}`);
  });
  t('республика: наследника нет, будут выборы',
    () => ok(heirOf(st, ctxOf({ gov: 'republic' })) === null, 'наследник всё-таки нашёлся'));
  t('федерация: совет назовёт старшего в роду', () => {
    const h = heirOf(st, ctxOf({ gov: 'federation' }));
    ok(h && h.id === 4, JSON.stringify(h && h.name));
  });
  t('империя без назначения: трон возьмёт старший', () => {
    const h = heirOf(st, ctxOf({ gov: 'empire' }));
    ok(h && h.id === 4, JSON.stringify(h && h.name));
  });
  t('империя с назначением: назначенный, и это НЕ сомнительно', () => {
    const s2 = house(st.members.map(m => ({ ...m })), { namedHeirId: 3 });
    const h = heirOf(s2, ctxOf({ gov: 'empire' }));
    ok(h && h.id === 3 && !h.odd, JSON.stringify(h));
  });
  t('монархия с назначением: закон обойдён, преемник сомнителен', () => {
    const s2 = house(st.members.map(m => ({ ...m })), { namedHeirId: 3 });
    const h = heirOf(s2, ctxOf({ gov: 'monarchy' }));
    ok(h && h.id === 3 && h.odd, JSON.stringify(h));
  });
  t('монархия без сыновей: наследует дочь, и право её слабее', () => {
    const s2 = house([person(1, { years: 60 }), person(4, { years: 35, sex: 'ж', gen: 2, father: 1 })]);
    const h = heirOf(s2, ctxOf({ gov: 'monarchy' }));
    ok(h && h.id === 4 && h.odd, JSON.stringify(h));
  });
  t('бездетный правитель: трон уходит по боковой линии', () => {
    const s2 = house([person(1, { years: 60 }), person(7, { years: 45 })]);
    const h = heirOf(s2, ctxOf({ gov: 'monarchy' }));
    ok(h && h.id === 7 && /боков|старшему в роду/.test(h.why), JSON.stringify(h));
  });
  t('малолетний наследник помечен', () => {
    const s2 = house([person(1, { years: 60 }), person(9, { years: 6, gen: 2, father: 1 })]);
    const h = heirOf(s2, ctxOf({ gov: 'monarchy' }));
    ok(h && h.minor === true, JSON.stringify(h));
  });
  t('пришлый супруг наследником не бывает', () => {
    const s2 = house([person(1, { years: 60 }), person(8, { years: 55, sex: 'ж', blood: false })]);
    ok(heirOf(s2, ctxOf({ gov: 'monarchy' })) === null, 'трон ушёл к чужому роду');
  });
  t('наследника читают без rng — можно звать из рендера', () => {
    const before = JSON.stringify(st);
    heirOf(st, ctxOf()); dynastyCard(st, ctxOf()); dynastyRows(st, ctxOf());
    ok(JSON.stringify(st) === before, 'чтение изменило состояние');
  });
}

console.log('\n--- Один день считается один раз ---');
{
  const rng = createRng(5);
  let st = createDynasty(rng, { day: 0 });
  const r1 = dynastyNewDay(st, ctxOf({ day: 1 }), rng);
  t('первый вызов дня считается', () => ok(r1.counted === true, 'день не посчитан'));
  const before = rng.getState();
  const r2 = dynastyNewDay(r1.state, ctxOf({ day: 1 }), rng);
  t('повторный вызов теми же сутками ничего не начисляет', () => ok(r2.counted === false, 'посчитан дважды'));
  t('повторный вызов не трогает rng — иначе разойдётся сохранение',
    () => ok(rng.getState() === before, 'поток случайностей сдвинут'));
  t('повторный вызов возвращает пустые поправки',
    () => near(r2.mods.stability, 0, 1e-9, 'стабильность'));
  t('следующие сутки считаются снова',
    () => ok(dynastyNewDay(r2.state, ctxOf({ day: 2 }), rng).counted === true, 'день пропущен'));
}

console.log('\n--- Модуль ничего не мутирует ---');
{
  const rng = createRng(9);
  const st = createDynasty(rng, { day: 0 });
  const snap = JSON.stringify(st);
  dynastyNewDay(st, ctxOf({ day: 1 }), rng);
  t('дневной ход не трогает переданное состояние', () => ok(JSON.stringify(st) === snap, 'состояние изменено'));
  patronizeCourt(st, ctxOf());
  t('подношение двору не трогает переданное состояние', () => ok(JSON.stringify(st) === snap, 'состояние изменено'));
  const kid = st.members.find(m => m.blood && m.id !== st.rulerId);
  if (kid) nameHeir(st, kid.id, ctxOf());
  t('назначение наследника не трогает переданное состояние', () => ok(JSON.stringify(st) === snap, 'состояние изменено'));
  marryHeir(st, ctxOf(), { fid: 'orda', house: 'Ловчий', rel: 10 }, rng);
  t('женитьба не трогает переданное состояние', () => ok(JSON.stringify(st) === snap, 'состояние изменено'));
  overthrow(st, ctxOf({ nobles: 70, military: 70, stability: 60 }), {}, rng);
  t('переворот не трогает переданное состояние', () => ok(JSON.stringify(st) === snap, 'состояние изменено'));
}

console.log('\n--- Законность: потолки, дрейф, разовые удары ---');
{
  t('законность не уходит выше 100', () => {
    let st = house([person(1)], { legitimacy: 99.5 });
    for (let d = 1; d <= 40; d++) st = dynastyNewDay(st, ctxOf({ day: d, gold: 1e6 }), rngNever(d)).state;
    ok(legitimacy(st) <= LEG_MAX, `${legitimacy(st)}`);
  });
  t('законность не уходит ниже 0', () => {
    let st = house([person(1)], { legitimacy: 1, interregnum: 200 });
    for (let d = 1; d <= 40; d++) st = dynastyNewDay(st, ctxOf({ day: d, gold: 0 }), rngNever(d)).state;
    ok(legitimacy(st) >= LEG_MIN, `${legitimacy(st)}`);
  });
  t('свой уровень рода растёт с поколениями', () => {
    const a = house([person(1)], { generations: 1 });
    const b = house([person(1)], { generations: 4 });
    ok(baseLegitimacy(b, 0) > baseLegitimacy(a, 0), `${baseLegitimacy(a, 0)} vs ${baseLegitimacy(b, 0)}`);
  });
  t('из ямы род выбирается сам — это выход из петли', () => {
    // Наследник есть, бед нет: законность обязана ползти вверх.
    let st = house([person(1, { years: 40 }), person(2, { years: 18, gen: 2, father: 1 })], { legitimacy: 5 });
    const start = legitimacy(st);
    for (let d = 1; d <= 200; d++) st = dynastyNewDay(st, ctxOf({ day: d }), rngNever(d)).state;
    ok(legitimacy(st) > start + 5, `${start} → ${legitimacy(st)}`);
  });
  t('дневной дрейф не превышает своего потолка', () => {
    const st = house([person(1, { years: 40 }), person(2, { years: 18, gen: 2, father: 1 })], { legitimacy: 5 });
    const rep = dynastyNewDay(st, ctxOf({ day: 1 }), rngNever(1));
    ok(Math.abs(rep.flags.legDelta) <= LEG_DRIFT + 0.05, `сдвиг ${rep.flags.legDelta}`);
  });
  t('победа поднимает законность', () => {
    const st = house([person(1, { years: 40 }), person(2, { years: 18, gen: 2, father: 1 })], { legitimacy: 40 });
    const rep = dynastyNewDay(st, ctxOf({ day: 1, events: [{ kind: 'victory' }] }), rngNever(1));
    ok(legitimacy(rep.state) > 40 + LEG_EVENT.victory - 1, `${legitimacy(rep.state)}`);
  });
  t('потерянная провинция бьёт сильнее поражения',
    () => ok(LEG_EVENT.city_lost < LEG_EVENT.defeat, `${LEG_EVENT.city_lost} vs ${LEG_EVENT.defeat}`));
  t('МЕСЯЦ ГОЛОДА — ЭТО ОДНА БЕДА, а не тридцать', () => {
    // Наивный счёт «читаем состояние каждый день» дал бы −210 и обнулил
    // законность за месяц. Именно на этом обожглись в link_memory.
    let st = house([person(1, { years: 40 }), person(2, { years: 18, gen: 2, father: 1 })], { legitimacy: 60 });
    for (let d = 1; d <= 30; d++) {
      st = dynastyNewDay(st, ctxOf({ day: d, events: [{ kind: 'famine' }] }), rngNever(d)).state;
    }
    const lost = 60 - legitimacy(st);
    ok(lost < Math.abs(LEG_EVENT.famine) * 3, `за месяц потеряно ${lost.toFixed(1)} — беда посчитана много раз`);
    ok(lost > 5, `за месяц потеряно ${lost.toFixed(1)} — беда не учтена вовсе`);
  });
  t('после сезона та же беда считается заново', () => {
    let st = house([person(1, { years: 40 }), person(2, { years: 18, gen: 2, father: 1 })], { legitimacy: 60 });
    let hits = 0;
    for (let d = 1; d <= SEEN_WINDOW * 3; d++) {
      const rep = dynastyNewDay(st, ctxOf({ day: d, events: [{ kind: 'plague' }] }), rngNever(d));
      st = rep.state;
      hits += rep.events.filter(e => e.cause === 'legitimacy').length;
    }
    ok(hits >= 2 && hits <= 5, `ударов ${hits} за три сезона`);
  });
  t('отсутствие наследника капает по законности и названо словами', () => {
    const st = house([person(1, { years: 40 })], { legitimacy: 60 });
    const rep = dynastyNewDay(st, ctxOf({ day: 1 }), rngNever(1));
    ok(rep.reasons.some(r => /наследника нет/i.test(r)), JSON.stringify(rep.reasons));
    ok(legitimacy(rep.state) < 60, `законность ${legitimacy(rep.state)}`);
  });
  t('сомнительный преемник тоже капает и объясняет выход', () => {
    const st = house([person(1, { years: 40 }), person(2, { years: 20, gen: 2, father: 1 }), person(3, { years: 25, gen: 2, father: 1 })],
      { namedHeirId: 3, legitimacy: 60 });
    const rep = dynastyNewDay(st, ctxOf({ day: 1, gov: 'monarchy' }), rngNever(1));
    ok(rep.reasons.some(r => /сомнител/i.test(r) && /отменить/i.test(r)), JSON.stringify(rep.reasons));
  });
  t('законность описана словом, а не только числом', () => {
    ok(legitimacyWord(90) !== legitimacyWord(10), 'слова совпали');
    ok(typeof legitimacyWord(50) === 'string' && legitimacyWord(50).length > 3, legitimacyWord(50));
  });
}

console.log('\n--- Претенденты ---');
{
  const kin = [person(1, { years: 40 }), person(2, { years: 20, gen: 2, father: 1 })];
  t('при крепкой законности претендентов нет', () => {
    let st = house(kin.map(m => ({ ...m })), { legitimacy: 90 });
    for (let d = 1; d <= 60; d++) st = dynastyNewDay(st, ctxOf({ day: d }), rngBand(0.005, 0.05, d)).state;
    ok(st.claimants.length === 0, `претендентов ${st.claimants.length}`);
  });
  t('при низкой законности претендент приходит', () => {
    const st = house(kin.map(m => ({ ...m })), { legitimacy: 10 });
    const rep = dynastyNewDay(st, ctxOf({ day: 1 }), rngBand(0.005, 0.05, 3));
    ok(rep.state.claimants.length === 1, `претендентов ${rep.state.claimants.length}`);
    ok(rep.events.some(e => e.cause === 'claimant'), 'о претенденте не сказано ни слова');
  });
  t('претендентов не бывает больше потолка', () => {
    let st = house(kin.map(m => ({ ...m })), { legitimacy: 5 });
    for (let d = 1; d <= 30; d++) st = dynastyNewDay(st, ctxOf({ day: d }), rngBand(0.005, 0.05, d)).state;
    ok(st.claimants.length <= MAX_CLAIMANTS, `претендентов ${st.claimants.length}`);
    ok(st.claimants.length === MAX_CLAIMANTS, `за месяц не набралось и двух: ${st.claimants.length}`);
  });
  t('претендент давит стабильность и причина названа', () => {
    const st = house(kin.map(m => ({ ...m })), {
      legitimacy: 10,
      claimants: [{ name: 'Крам Ловчий', fam: 'Ловчий', sex: 'м', age: 35 * YEAR, strength: 50, fid: null, since: 0 }],
    });
    const rep = dynastyNewDay(st, ctxOf({ day: 1 }), rngNever(1));
    ok(rep.mods.stability <= -CLAIM_STAB, `стабильность ${rep.mods.stability}`);
    ok(rep.reasons.some(r => /Претендент/i.test(r) && String(CLAIM_CLEAR).length > 0 && r.includes(String(CLAIM_CLEAR))), JSON.stringify(rep.reasons));
  });
  t('при высокой законности претендент отступается — выход из петли есть', () => {
    const st = house(kin.map(m => ({ ...m })), {
      legitimacy: 90,
      claimants: [{ name: 'Крам Ловчий', fam: 'Ловчий', sex: 'м', age: 35 * YEAR, strength: 50, fid: null, since: 0 }],
    });
    const rep = dynastyNewDay(st, ctxOf({ day: 1 }), rngBand(0.005, 0.05, 2));
    ok(rep.state.claimants.length === 0, 'претендент остался');
  });
  t('пороги появления и ухода разные — иначе претендент мигал бы через день',
    () => ok(CLAIM_CLEAR > CLAIM_BELOW, `${CLAIM_BELOW} / ${CLAIM_CLEAR}`));
  t('претендент НЕ давит законность — иначе спираль без выхода', () => {
    const withCl = house(kin.map(m => ({ ...m })), {
      legitimacy: 30,
      claimants: [{ name: 'Крам Ловчий', fam: 'Ловчий', sex: 'м', age: 35 * YEAR, strength: 50, fid: null, since: 0 }],
    });
    const без = house(kin.map(m => ({ ...m })), { legitimacy: 30 });
    const a = dynastyNewDay(withCl, ctxOf({ day: 1 }), rngNever(1)).state;
    const b = dynastyNewDay(без, ctxOf({ day: 1 }), rngNever(1)).state;
    near(legitimacy(a), legitimacy(b), 1e-9, 'законность из-за претендента просела');
  });
}

console.log('\n--- Смена власти и междуцарствие ---');
{
  // Полоса (0.001, 0.01) ловит смерть девяностолетнего (≈0.0015 в сутки) и не
  // ловит смерть сорокалетнего (≈4e-5): умирает ровно тот, кто нужен проверке.
  t('умер правитель — трон принял его старший сын', () => {
    const st = house([
      person(1, { years: 90 }), person(2, { years: 40, gen: 2, father: 1 }), person(3, { years: 30, gen: 2, father: 1 }),
    ]);
    const rep = dynastyNewDay(st, ctxOf({ day: 1, gov: 'monarchy' }), rngBand(0.001, 0.01, 11));
    ok(rep.state.rulerId === 2, `на троне ${rep.state.rulerId}`);
    ok(rep.events.some(e => e.cause === 'succession'), 'о смене власти не сказано');
    ok(rep.state.generations === 2, `поколений ${rep.state.generations}`);
  });
  t('смена власти стоит законности по тяжести строя', () => {
    const mk = () => house([person(1, { years: 90 }), person(2, { years: 40, gen: 2, father: 1 })], { legitimacy: 80 });
    const a = dynastyNewDay(mk(), ctxOf({ day: 1, gov: 'chiefdom' }), rngBand(0.001, 0.01, 11)).state;
    const b = dynastyNewDay(mk(), ctxOf({ day: 1, gov: 'republic' }), rngBand(0.001, 0.01, 11)).state;
    ok(legitimacy(a) < legitimacy(b), `усобица ${legitimacy(a)} должна стоить дороже выборов ${legitimacy(b)}`);
  });
  t('умер без наследников — междуцарствие, а не тихая подмена человека', () => {
    const st = house([person(1, { years: 90 }), person(2, { years: 30, sex: 'ж', blood: false, spouse: 1 })]);
    const rep = dynastyNewDay(st, ctxOf({ day: 1, gov: 'monarchy' }), rngBand(0.001, 0.01, 11));
    ok(rep.state.rulerId === null, 'кто-то всё-таки сел на трон');
    ok(rep.state.interregnum > 0, 'междуцарствия не случилось');
    ok(rep.events.some(e => e.cause === 'interregnum'), 'о пресечении рода не сказано');
  });
  t('междуцарствие обваливает стабильность каждый день', () => {
    const st = house([person(1, { years: 40 })], { interregnum: 10 });
    const rep = dynastyNewDay(st, ctxOf({ day: 1 }), rngNever(1));
    ok(rep.mods.stability <= -INTERREGNUM_STAB, `стабильность ${rep.mods.stability}`);
  });
  t('МЕЖДУЦАРСТВИЕ КОНЧАЕТСЯ: трон занимают, партия продолжается', () => {
    let st = house([person(1, { years: 40 })], { interregnum: INTERREGNUM_DAYS });
    const wasFam = st.fam;
    for (let d = 1; d <= INTERREGNUM_DAYS + 2; d++) st = dynastyNewDay(st, ctxOf({ day: d }), rngNever(d)).state;
    ok(st.interregnum === 0, `междуцарствие тянется ${st.interregnum}`);
    ok(st.rulerId !== null, 'трон так и остался пустым');
    ok(st.stats.houses >= 2, `родов сменилось ${st.stats.houses}`);
    ok(st.fam !== wasFam || st.generations === 1, 'новый род не отличим от старого');
  });
  t('новый род поднимается не одиночкой — иначе второе междуцарствие подряд', () => {
    let st = house([person(1, { years: 40 })], { interregnum: 1 });
    st = dynastyNewDay(st, ctxOf({ day: 1 }), createRng(4)).state;
    ok(st.members.length >= 2, `в новом роду ${st.members.length} человек`);
  });
  t('республика может отобрать власть у рода на выборах', () => {
    const st = house([person(1, { years: 90 }), person(2, { years: 40, gen: 2, father: 1 })], { legitimacy: 20 });
    const rep = dynastyNewDay(st, ctxOf({ day: 1, gov: 'republic' }), rngBand(0.001, 0.01, 11));
    ok(rep.events.some(e => e.cause === 'house_change'), 'род удержал власть при законности 20');
  });
  t('республика оставляет власть почитаемому роду', () => {
    const st = house([person(1, { years: 90 }), person(2, { years: 40, gen: 2, father: 1 })], { legitimacy: 85 });
    const rep = dynastyNewDay(st, ctxOf({ day: 1, gov: 'republic' }), rngBand(0.001, 0.01, 11));
    ok(rep.state.rulerId === 2, `на троне ${rep.state.rulerId}`);
  });
  t('малолетний на троне — регентство с явным сроком', () => {
    const st = house([person(1, { years: 8 }), person(2, { years: 30, sex: 'ж', blood: false })]);
    const rep = dynastyNewDay(st, ctxOf({ day: 1 }), rngNever(1));
    ok(rep.flags.regency === true, 'регентство не отмечено');
    ok(rep.reasons.some(r => /дитя/i.test(r) && /Кончится/i.test(r)), JSON.stringify(rep.reasons));
  });
}

console.log('\n--- Жизнь рода: рождения и свадьбы ---');
{
  t('пара рожает, ребёнок носит фамилию рода', () => {
    const st = house([
      person(1, { years: 30, spouse: 2 }),
      person(2, { years: 26, sex: 'ж', blood: false, spouse: 1 }),
    ]);
    const rep = dynastyNewDay(st, ctxOf({ day: 1 }), rngBand(0.005, 0.01, 7));
    ok(rep.state.members.length === 3, `в роду ${rep.state.members.length}`);
    const baby = rep.state.members[2];
    ok(baby.fam === st.fam && baby.age === 0, JSON.stringify(baby));
    ok(baby.blood === true, 'ребёнок княжны и пришлого обязан быть кровным');
  });
  t('одинокий берёт пару из поселения, и род прирастает', () => {
    const st = house([person(1, { years: 30 })]);
    const rep = dynastyNewDay(st, ctxOf({ day: 1 }), rngBand(0.01, 0.05, 8));
    ok(rep.state.members.length === 2, `в роду ${rep.state.members.length}`);
    ok(rep.state.members[1].origin === 'married', JSON.stringify(rep.state.members[1]));
  });
  t('список рода не растёт без потолка', () => {
    let st = house([person(1, { years: 25, spouse: 2 }), person(2, { years: 24, sex: 'ж', blood: false, spouse: 1 })]);
    for (let d = 1; d <= 900; d++) st = dynastyNewDay(st, ctxOf({ day: d }), rngAlways(d)).state;
    ok(st.members.length <= MAX_MEMBERS, `в роду ${st.members.length}`);
  });
  t('вдова возвращается в брачный круг — ссылка на супруга не виснет', () => {
    const st = house([person(1, { years: 95, spouse: 2 }), person(2, { years: 40, sex: 'ж', blood: false, spouse: 1 })]);
    const rep = dynastyNewDay(st, ctxOf({ day: 1 }), rngBand(0.001, 0.01, 11));
    const widow = memberOf(rep.state, 2);
    ok(widow && widow.spouse === null, JSON.stringify(widow));
  });
}

console.log('\n--- Действия игрока: можно ли и почему нет ---');
{
  const base = () => house([person(1, { years: 40 }), person(2, { years: 20, gen: 2, father: 1 }), person(3, { years: 24, gen: 2, father: 1 })]);
  t('поддержать двор: без золота — внятный отказ', () => {
    const r = canPatronize(base(), ctxOf({ gold: 1 }));
    ok(!r.ok && /золот/i.test(r.reason), JSON.stringify(r));
  });
  t('поддержать двор: цена растёт с державой',
    () => ok(patronCost(ctxOf({ pop: 200 })) > patronCost(ctxOf({ pop: 10 })), 'цена не зависит от размера'));
  t('поддержать двор: законность вверх, золото списано, причина названа', () => {
    const r = patronizeCourt(base(), ctxOf({ gold: 5000 }));
    ok(r.ok, r.reason);
    near(legitimacy(r.state), LEG_START + PATRON_LEG, 1e-9, 'законность');
    ok(r.mods.gold < 0 && r.mods.estates.nobles > 0 && r.mods.estates.commons < 0, JSON.stringify(r.mods));
    ok(r.reasons[0].length > 20, r.reasons[0]);
  });
  t('поддержать двор: откат не даёт покупать законность каждый день', () => {
    const r1 = patronizeCourt(base(), ctxOf({ gold: 5000 }));
    ok(r1.state.patronCd === PATRON_CD, `откат ${r1.state.patronCd}`);
    const r2 = canPatronize(r1.state, ctxOf({ gold: 5000 }));
    ok(!r2.ok && /недавно/i.test(r2.reason), JSON.stringify(r2));
  });
  t('содержание двора: ступень переключается в обе стороны', () => {
    const r = setCourt(base(), 2);
    ok(r.ok && r.state.court === 2, JSON.stringify(r));
    ok(setCourt(r.state, 0).ok, 'обратно не переключается');
    ok(!canSetCourt(r.state, 2).ok, 'разрешено ставить ту же ступень');
    ok(!canSetCourt(base(), 9).ok, 'разрешена несуществующая ступень');
  });
  t('пышный двор стоит казне и поднимает законность', () => {
    const st = setCourt(base(), 2).state;
    const rep = dynastyNewDay(st, ctxOf({ day: 1, gold: 5000 }), rngNever(1));
    ok(rep.mods.goldPerDay < 0, `золото ${rep.mods.goldPerDay}`);
    ok(rep.mods.estates.nobles > 0 && rep.mods.estates.commons < 0, JSON.stringify(rep.mods.estates));
  });
  t('пустая казна: двору не заплатили, и об этом сказано с выходом', () => {
    const st = setCourt(base(), 2).state;
    const rep = dynastyNewDay(st, ctxOf({ day: 1, gold: 0 }), rngNever(1));
    ok(rep.flags.courtUnpaid === true, 'недоплата не замечена');
    ok(rep.reasons.some(r => /Понизьте содержание двора/i.test(r)), JSON.stringify(rep.reasons));
  });
  t('назначить наследника: чужого по крови — отказ', () => {
    const st = house([person(1, { years: 40 }), person(5, { years: 30, sex: 'ж', blood: false })]);
    const r = canNameHeir(st, 5, ctxOf());
    ok(!r.ok && /брак/i.test(r.reason), JSON.stringify(r));
  });
  t('назначить наследника: в республике — отказ, там выборы', () => {
    const r = canNameHeir(base(), 2, ctxOf({ gov: 'republic' }));
    ok(!r.ok && /еспублик/.test(r.reason), JSON.stringify(r));
  });
  t('назначить наследника: несуществующего — отказ', () => {
    const r = canNameHeir(base(), 777, ctxOf());
    ok(!r.ok && /нет/i.test(r.reason), JSON.stringify(r));
  });
  t('назначить наследника вопреки обычаю: знать оскорблена, законность вниз', () => {
    const r = nameHeir(base(), 2, ctxOf({ gov: 'monarchy' }));
    ok(r.ok, r.reason);
    ok(r.state.namedHeirId === 2, 'наследник не записан');
    ok(r.mods.estates.nobles < 0 && legitimacy(r.state) < LEG_START, JSON.stringify(r.mods));
  });
  t('назначение можно отменить — выход из петли «сомнительный преемник»', () => {
    const r = clearHeir(nameHeir(base(), 2, ctxOf()).state);
    ok(r.ok && r.state.namedHeirId === null, JSON.stringify(r));
    ok(!clearHeir(base()).ok, 'отмена без назначения прошла');
  });
  t('женить: без соседа — отказ', () => {
    const r = canMarryHeir(base(), ctxOf(), {});
    ok(!r.ok && /род/i.test(r.reason), JSON.stringify(r));
  });
  t('женить: враждебный сосед сватов не примет', () => {
    const r = canMarryHeir(base(), ctxOf(), { fid: 'orda', rel: -30 });
    ok(!r.ok && /враждеб/i.test(r.reason), JSON.stringify(r));
  });
  t('женить: связь двух родов и права на трон в обе стороны', () => {
    const r = marryHeir(base(), ctxOf(), { fid: 'orda', house: 'Ловчий', rel: 20 }, createRng(2));
    ok(r.ok, r.reason);
    ok(r.state.ties.length === 1 && r.state.ties[0].claim === FOREIGN_CLAIM, JSON.stringify(r.state.ties));
    ok(r.mods.relations.orda === MARRY_REL, JSON.stringify(r.mods.relations));
    ok(r.spouse.origin === 'foreign' && r.spouse.fid === 'orda', JSON.stringify(r.spouse));
    ok(r.reasons.some(x => /права на наш трон/i.test(x)), JSON.stringify(r.reasons));
  });
  t('женить: дважды на одном роде нельзя', () => {
    const s2 = marryHeir(base(), ctxOf(), { fid: 'orda', house: 'Ловчий', rel: 20 }, createRng(2)).state;
    const r = canMarryHeir(s2, ctxOf(), { fid: 'orda', rel: 20 });
    ok(!r.ok && /уже/i.test(r.reason), JSON.stringify(r));
  });
  t('женить: юного наследника не женят', () => {
    const st = house([person(1, { years: 40 }), person(2, { years: 6, gen: 2, father: 1 })]);
    const r = canMarryHeir(st, ctxOf(), { fid: 'orda', rel: 10 });
    ok(!r.ok && new RegExp(String(MARRY_MIN)).test(r.reason), JSON.stringify(r));
  });
  t('брак с соседом даёт ему претендента, когда законность падает', () => {
    let st = marryHeir(base(), ctxOf(), { fid: 'orda', house: 'Ловчий', rel: 20 }, createRng(2)).state;
    st = restoreDynasty({ ...serializeDynasty(st), legitimacy: 10 });
    const rep = dynastyNewDay(st, ctxOf({ day: 1 }), rngBand(0.005, 0.05, 3));
    ok(rep.state.claimants.length === 1 && rep.state.claimants[0].fid === 'orda', JSON.stringify(rep.state.claimants));
  });
  t('переворот: без знати не готовят', () => {
    const r = canOverthrow(base(), ctxOf({ nobles: 10, military: 90 }));
    ok(!r.ok && /Знать/i.test(r.reason), JSON.stringify(r));
  });
  t('переворот: без войска не готовят', () => {
    const r = canOverthrow(base(), ctxOf({ nobles: 90, military: 10 }));
    ok(!r.ok && /ойск/.test(r.reason), JSON.stringify(r));
  });
  t('переворот: древний род с непререкаемой законностью не свергают', () => {
    const st = house([person(1, { years: 40 })], { legitimacy: 90 });
    const r = canOverthrow(st, ctxOf({ nobles: 90, military: 90, stability: 90 }));
    ok(!r.ok && /аконность/.test(r.reason), JSON.stringify(r));
  });
  t('переворот: новый род, обнулённая законность, цена в стабильности', () => {
    const st = house([person(1, { years: 40 }), person(2, { years: 20, gen: 2, father: 1 })], { legitimacy: 30 });
    const r = overthrow(st, ctxOf({ nobles: 70, military: 70, stability: 70 }), {}, createRng(6));
    ok(r.ok, r.reason);
    ok(r.state.fam !== st.fam || r.state.founder !== st.founder, 'род тот же самый');
    near(legitimacy(r.state), COUP_LEG, 1e-9, 'законность узурпатора');
    ok(r.mods.stability === -COUP_STAB, `стабильность ${r.mods.stability}`);
    ok(r.state.stats.coups === 1 && r.state.generations === 1, JSON.stringify(r.state.stats));
    ok(!r.state.members.some(m => m.id === 1), 'прежний род остался при власти');
  });
}

console.log('\n--- Сохранение ---');
{
  t('круг сохранения замкнут', () => {
    const rng = createRng(21);
    let st = createDynasty(rng, { day: 0 });
    for (let d = 1; d <= 120; d++) st = dynastyNewDay(st, ctxOf({ day: d }), rng).state;
    const back = restoreDynasty(JSON.parse(JSON.stringify(serializeDynasty(st))));
    ok(JSON.stringify(back) === JSON.stringify(st), 'состояние после круга разошлось');
  });
  t('мусор на входе не роняет модуль', () => {
    for (const junk of [null, undefined, 0, 'мусор', [], { members: 'нет', claimants: 5, legitimacy: 'ой', rulerId: 999 }]) {
      const st = restoreDynasty(junk);
      ok(Array.isArray(st.members), `members не массив для ${JSON.stringify(junk)}`);
      ok(Number.isFinite(st.legitimacy) && st.legitimacy >= LEG_MIN && st.legitimacy <= LEG_MAX, `законность ${st.legitimacy}`);
    }
  });
  t('старый сейв без поля рода живёт дальше, а не падает', () => {
    const st = restoreDynasty(undefined);
    const rep = dynastyNewDay(st, ctxOf({ day: 1 }), createRng(3));
    ok(rep.state && Array.isArray(rep.state.members), JSON.stringify(rep.state));
    ok(dynastyCard(rep.state, ctxOf()) !== null, 'карточка не собралась');
  });
  t('повисшие ссылки на людей чинятся молча', () => {
    const st = restoreDynasty({
      fam: 'Кремень', rulerId: 1, namedHeirId: 42,
      members: [{ ...person(1), spouse: 99, father: 77 }],
    });
    const m = memberOf(st, 1);
    ok(m.spouse === null && m.father === null, JSON.stringify(m));
    ok(st.namedHeirId === null, 'назначен несуществующий наследник');
  });
  t('битые члены рода отбрасываются, целые остаются', () => {
    const st = restoreDynasty({ fam: 'Кремень', rulerId: 1, members: [null, 'человек', { id: 'икс' }, person(1)] });
    ok(st.members.length === 1 && st.members[0].id === 1, JSON.stringify(st.members));
  });
  t('чужие черты из сейва не проходят', () => {
    const st = restoreDynasty({ fam: 'Кремень', rulerId: 1, members: [{ ...person(1), traits: ['warlord', 'выдумка'] }] });
    ok(st.members[0].traits.length === 1 && st.members[0].traits[0] === 'warlord', JSON.stringify(st.members[0].traits));
  });
  t('два прогона одного сида совпадают слепок в слепок', () => {
    const run = () => {
      const rng = createRng(777);
      let st = createDynasty(rng, { day: 0 });
      for (let d = 1; d <= 300; d++) st = dynastyNewDay(st, ctxOf({ day: d, events: d % 50 === 0 ? [{ kind: 'defeat' }] : [] }), rng).state;
      return JSON.stringify(serializeDynasty(st));
    };
    ok(run() === run(), 'два прогона одного сида разошлись');
  });
}

console.log('\n--- Карточка для панели ---');
{
  t('карточка называет род, законность и закон наследования', () => {
    const st = house([person(1, { years: 40 }), person(2, { years: 20, gen: 2, father: 1 })]);
    const c = dynastyCard(st, ctxOf({ gov: 'monarchy' }));
    ok(/Род /.test(c.title), c.title);
    ok(c.lines.some(l => /Законность/.test(l)) && c.lines.some(l => /наследован/.test(l)), JSON.stringify(c.lines));
    ok(c.heir && c.heir.id === 2, JSON.stringify(c.heir));
  });
  t('карточка прямо предупреждает о пресечении рода', () => {
    const st = house([person(1, { years: 70 })]);
    const c = dynastyCard(st, ctxOf({ gov: 'monarchy' }));
    ok(/ПРЕСЕЧ/.test(c.risk), c.risk);
  });
  t('в республике карточка предупреждает о потере власти на выборах', () => {
    const st = house([person(1, { years: 70 })]);
    ok(/выбор/i.test(dynastyCard(st, ctxOf({ gov: 'republic' })).risk), dynastyCard(st, ctxOf({ gov: 'republic' })).risk);
  });
  t('строки рода помечают правителя и наследника', () => {
    const st = house([person(1, { years: 40 }), person(2, { years: 20, gen: 2, father: 1 })]);
    const rows = dynastyRows(st, ctxOf({ gov: 'monarchy' }));
    ok(rows.find(r => r.ruler) && rows.find(r => r.heir), JSON.stringify(rows));
    ok(rows.every(r => Number.isFinite(r.years) && r.years >= 0), JSON.stringify(rows));
  });
}

console.log('\n--- На настоящей симуляции ---');
{
  const sim = new Simulation(11, { startEra: 2 });
  for (let d = 0; d < 30; d++) sim.tick(1);
  const simCtx = (day) => {
    const st = sim.politics && sim.politics.state;
    const pop = sim.villagers.length;
    return {
      day, gov: st ? st.gov : 'chiefdom', era: sim.eraIndex, pop,
      gold: sim.res.gold, foodDays: sim.res.food / Math.max(1, pop * 0.7),
      wars: Array.isArray(sim.wars) ? sim.wars.length : 0,
      stability: st ? st.stability : 50, happy: 50, mortalityMult: 1,
      nobles: st ? st.factions.nobles : 50, military: st ? st.factions.military : 50,
      events: [],
    };
  };
  const snap = JSON.stringify({ pol: sim.politics ? sim.politics.state : null, res: sim.res, pop: sim.villagers.length });

  // ЖИЗНЬ РОДА ПРОГОНЯЕТСЯ ВОСЕМЬ РАЗ НА СВОИХ ПОТОКАХ СЛУЧАЙНОСТИ, а не один
  // раз на sim.rng, как было. Две причины, обе выяснились на деле.
  //
  // Первая: sim.rng — это поток ЖИВОЙ партии, и сколько бросков из него уйдёт
  // за тридцать суток прогрева, зависит от всего подключённого к игре. Стоило
  // подключить связь охоты — поток сдвинулся, основателю выпал другой возраст,
  // и проверка упала, хотя в роду не поменялось ни строки. Тест обязан падать
  // от поломок в роду, а не от соседних систем.
  //
  // Вторая: одиночный прогон здесь и был лотереей — теперь с числом. Основатель
  // начинает в 28–45; если ему выпало 33, вероятность дожить до 93, ни разу не
  // умерев, по кривой annualMortality × ROYAL_MORT равна примерно 10 %. Каждый
  // десятый прогон законно давал ноль смен власти. Комментарий на этом месте
  // обещал, что шестьдесят лет лотерею снимают, — не снимают.
  //
  // Восемь родов на постоянных сидах: результат один и тот же при каждом
  // запуске, а требование «хотя бы в пяти из восьми трон пережил основателя»
  // оставляет запас — три нуля подряд по чистому невезению это доли процента.
  let successions = 0, births = 0;
  let housesWithSuccession = 0;
  let st = null;
  for (let run = 0; run < 8; run++) {
    const rng = createRng(9000 + run * 137);
    let h = createDynasty(rng, { day: sim.day });
    let ownSucc = 0;
    for (let i = 1; i <= 6000; i++) {
      const rep = dynastyNewDay(h, simCtx(sim.day + i), rng);
      h = rep.state;
      ownSucc += rep.events.filter(e => e.cause === 'succession' || e.cause === 'house_change').length;
      births += rep.events.filter(e => e.cause === 'birth').length;
    }
    successions += ownSucc;
    if (ownSucc > 0) housesWithSuccession++;
    if (run === 0) st = h;      // дальнейшие проверки идут по первому роду
  }

  t('модуль не изменил sim (снимок до и после совпал)',
    () => ok(JSON.stringify({ pol: sim.politics ? sim.politics.state : null, res: sim.res, pop: sim.villagers.length }) === snap, 'sim изменён'));
  t('за шестьдесят лет род прожил жизнь: рождения были', () => ok(births > 0, `рождений ${births}`));
  t('за шестьдесят лет власть сменилась — трон пережил своего основателя',
    () => ok(housesWithSuccession >= 5, `смена власти была лишь в ${housesWithSuccession} родах из 8 (всего смен ${successions})`));
  t('трон не остаётся пустым навсегда',
    () => ok(st.rulerId !== null || st.interregnum > 0, JSON.stringify({ ruler: st.rulerId, inter: st.interregnum })));
  t('законность всё это время держалась в берегах',
    () => ok(st.legitimacy >= LEG_MIN && st.legitimacy <= LEG_MAX, `${st.legitimacy}`));
  t('карточка собирается на живой партии', () => {
    const c = dynastyCard(st, simCtx(sim.day));
    ok(c && typeof c.title === 'string' && c.lines.length >= 4, JSON.stringify(c));
  });
  t('Math.random в модуле не вызывается (иначе ломались бы сейвы)', () => {
    // Читаем сам файл: короткий прогон может не задеть ветку с чужим числом.
    const src = readFileSync(new URL('../src/core/systems/dynasty.js', import.meta.url), 'utf8');
    ok(!/Math\.random\s*\(/.test(src), 'найден вызов Math.random');
  });
  t('модуль не тянет sim внутрь себя: ни одного обращения к sim.', () => {
    const src = readFileSync(new URL('../src/core/systems/dynasty.js', import.meta.url), 'utf8');
    const body = src.split('/* ПОДКЛЮЧЕНИЕ')[0];   // блок подключения — это инструкция, а не код
    ok(!/\bsim\./.test(body), 'модель обращается к sim');
  });
}

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
if (fail) process.exit(1);
