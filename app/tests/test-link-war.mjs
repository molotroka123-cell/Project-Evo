// tests/test-link-war.mjs — проверки связей «бой ↔ дух ↔ военное сословие ↔
// казна ↔ армия» (systems/link_war.js). Запуск: node app/tests/test-link-war.mjs
//
// Что здесь важно проверить и почему именно это:
//  * связь тянет в НУЖНУЮ сторону: потери и поражения роняют одобрение военных,
//    победы и знамёна поднимают, пустая казна разлагает армию, а сильная армия
//    при мире держит порядок;
//  * у каждой петли есть ПОТОЛОК: дневной сдвиг одобрения, предел стабильности
//    и счастья, потолок усталости, пол множителя армии, пол скуки;
//  * есть ВЫХОД: победа гасит усталость, мир её растворяет, дезертиры снимают
//    расход с казны, а разорённой державе отодвигают набег;
//  * в СПОКОЙНОМ состоянии (мир, жалование платят, никто не гибнет) нет ни
//    одной поправки — иначе игрок наказан просто за то, что играет;
//  * связь детерминирована: тот же день даёт тот же ответ, повторный вызов не
//    начисляет ничего дважды.
import {
  warLinks, createWarMemory, restoreWarMemory, explainWar,
  classifyDay, wearQ, desertRate, armyMultOf, lossHit, desertPlan,
  arrearsOf, fieldMen, reserveMen, playerSquads,
  ESTATES, WEAR_ACHE, WEAR_MAX, WEAR_DECAY, WEAR_WIN_RELIEF, WEAR_CAPTURE_RELIEF,
  WEAR_PER_DAY, WEAR_HAPPY, WEAR_STAB, WEAR_MARKS,
  DESERT_AFTER, DESERT_RATE_MAX, MULT_MIN, MULT_MAX, MULT_LOVE_MAX,
  MIL_DAY_UP, MIL_DAY_DOWN, STAB_WORST, STAB_BEST, HAPPY_WORST, HAPPY_BEST,
  BORED_AFTER, BORED_FLOOR, ORDER_STAB_MAX, ORDER_MIN_MEN, ORDER_AFTER,
  RESPITE_DAYS, RESPITE_CD, RESPITE_ARREARS, GRIEF_MAX, PRIDE_MAX,
} from '../src/core/systems/link_war.js';
import { FACTION_HAPPY } from '../src/core/systems/politics.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let ok = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { ok++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

// ─────────────── Поддельный мир ───────────────
// Ровно те поля, которые связь читает у настоящего Simulation. Армия, политика
// и экономика подделаны нарочно: здесь проверяются ЧИСЛА связи, а не поведение
// wire_army/politics/economy — у них свои наборы тестов.
function makeSim(o = {}) {
  const squads = (o.squads || []).map((n, i) => ({
    id: i + 1, side: 'player', name: `Отряд ${i + 1}`,
    units: { spear: n }, engines: {}, morale: o.morale ?? 100, mult: 1,
  }));
  for (const s of o.foreign || []) squads.push({ id: 900 + squads.length, side: s.side || 'nord', name: 'Чужие', units: { spear: s.n }, engines: {}, morale: 100, mult: 1 });
  return {
    day: o.day ?? 100,
    eraIndex: o.era ?? 2,
    villagers: new Array(o.pop ?? 40).fill(0).map((_, i) => ({ name: 'ж' + i })),
    res: { gold: o.gold ?? 50 },
    army: { soldiers: o.reserve ?? 0, powerBonus: 0 },
    armyState: { squads, battles: o.battles ?? 0, captures: 0, nextId: 99 },
    war: { events: o.events || [], raid: { squadId: 0 } },
    wars: new Array(o.wars ?? 0).fill(0).map((_, i) => ({ fid: 'f' + i, ws: 0 })),
    aiWars: [],
    raids: { timer: o.raidTimer ?? 30, off: !!o.raidsOff, warning: false, from: null },
    politics: {
      state: {
        factions: { nobles: 55, clergy: 55, merchants: 55, commons: 55, military: 55, ...(o.approval || {}) },
        stability: o.stability ?? 60,
      },
    },
    industry: { eco: { arrears: o.arrears ?? 0 } },
    addLog() {}, addChronicle() {},
  };
}
// Память «вчерашнего дня»: непрерывный счёт, вчера было столько-то людей.
function mem(sim, extra = {}) {
  const m = createWarMemory();
  m.day = (sim.day ?? 100) - 1;
  m.total = fieldMen(sim) + reserveMen(sim);
  return Object.assign(m, extra);
}

// ─────────────── 1. Спокойное состояние ───────────────
console.log('\n--- Спокойное состояние ---');
{
  const s = makeSim({ squads: [10], reserve: 5, wars: 0 });
  const L = warLinks(s, mem(s));
  t('спокойно: ни одно сословие не сдвинуто',
    ESTATES.every(f => L.mods.approval[f] === 0), JSON.stringify(L.mods.approval));
  t('спокойно: стабильность не тронута', L.mods.stability === 0, String(L.mods.stability));
  t('спокойно: счастье не тронуто', L.mods.happy === 0, String(L.mods.happy));
  t('спокойно: дух отрядов не тронут', L.mods.morale === 0, String(L.mods.morale));
  t('спокойно: армия дерётся в полную силу', L.mods.armyMult === 1, String(L.mods.armyMult));
  t('спокойно: никто не дезертирует', L.flags.desert.field === 0 && L.flags.desert.reserve === 0);
  t('спокойно: журнал молчит и поднят флаг quiet', L.events.length === 0 && L.flags.quiet === true,
    JSON.stringify(L.events));
  t('спокойно: усталость остаётся нулевой', L.flags.weariness === 0, String(L.flags.weariness));
  t('память обновилась: вчерашняя численность = сегодняшней', L.memo.total === 15, String(L.memo.total));

  const none = warLinks(makeSim({}), null);
  t('пустой мир без армии и войн тоже молчит', none.flags.quiet === true);
}

// ─────────────── 2. Потери бьют по военным ───────────────
console.log('\n--- Потери ---');
{
  // Вчера было 20 бойцов, сегодня 12: восьмерых нет.
  const s = makeSim({ squads: [12], reserve: 0 });
  const L = warLinks(s, mem(s, { total: 20 }));
  t('потери посчитаны', L.flags.losses === 8, String(L.flags.losses));
  t('потери роняют одобрение военных', L.mods.approval.military < 0, String(L.mods.approval.military));
  t('причина потерь названа словами',
    L.reasons.approval.some(r => /Не вернулись/.test(r.ru)), JSON.stringify(L.reasons.approval));
  t('тяжёлые потери роняют и стабильность', L.mods.stability < 0, String(L.mods.stability));
  t('о потерях сказано игроку', L.events.some(e => /Потери/.test(e.text)));

  // Масштаб: та же ДОЛЯ потерь у большого войска бьёт сильнее, чем у крошечного.
  const big = lossHit(20, 40), small = lossHit(2, 4);
  t('доля та же, но гибель большого войска весит сильнее', big < small, `${big} против ${small}`);
  t('без потерь удара нет', lossHit(0, 40) === 0);

  // Потери следующего дня превращаются в горе города: счастье падает.
  const s2 = makeSim({ squads: [12], reserve: 0, day: 101 });
  const L2 = warLinks(s2, L.memo);
  t('горе по павшим доходит до счастья города', L2.mods.happy < 0, String(L2.mods.happy));
  t('горе затухает: назавтра оно слабее', Math.abs(L2.memo.grief) < Math.abs(L.memo.grief),
    `${L2.memo.grief} против ${L.memo.grief}`);
  t('горе не превышает потолка', L.memo.grief <= GRIEF_MAX + 1e-9, String(L.memo.grief));
}

// ─────────────── 3. Победы, знамёна, взятые города ───────────────
console.log('\n--- Победы и поражения ---');
{
  const win = warLinks(makeSim({
    squads: [10], events: [{ text: '⚔ Бой у (5,5): наш отряд разбил врага.', type: 'good' }],
  }), mem(makeSim({ squads: [10] })));
  t('победа поднимает одобрение военных', win.mods.approval.military > 0, String(win.mods.approval.military));
  t('победа поднимает стабильность', win.mods.stability > 0, String(win.mods.stability));
  t('о победе сказано игроку', win.events.some(e => /Победа/.test(e.text)));

  const lose = warLinks(makeSim({
    squads: [10], events: [{ text: '⚔ Бой у (5,5): враг разбил наш отряд.', type: 'bad' }],
  }), mem(makeSim({ squads: [10] })));
  t('поражение роняет одобрение военных', lose.mods.approval.military < 0, String(lose.mods.approval.military));
  t('поражение позорит и знать', lose.mods.approval.nobles < 0, String(lose.mods.approval.nobles));
  t('поражение весит сильнее победы',
    Math.abs(lose.mods.approval.military) > Math.abs(win.mods.approval.military),
    `${lose.mods.approval.military} против ${win.mods.approval.military}`);

  const cap = warLinks(makeSim({
    squads: [10], events: [{ text: '🚩 Поселение Норды (9,9) взято через выбитые ворота.', type: 'good' }],
  }), mem(makeSim({ squads: [10] })));
  t('взятый город — крупная победа для военных',
    cap.mods.approval.military > win.mods.approval.military, String(cap.mods.approval.military));
  t('взятый город радует знать', cap.mods.approval.nobles > 0, String(cap.mods.approval.nobles));
  t('гордость за победу доходит до счастья города', cap.mods.happy > 0, String(cap.mods.happy));
  t('гордость не превышает потолка', cap.memo.pride <= PRIDE_MAX + 1e-9, String(cap.memo.pride));

  const banner = warLinks(makeSim({
    squads: [10], events: [{ text: '🚩 Знаменосец водрузил знамя: «Битва у (4,4)», день 100.', type: 'good' }],
  }), mem(makeSim({ squads: [10] })));
  t('знамя победы поднимает одобрение военных', banner.mods.approval.military > 0,
    String(banner.mods.approval.military));

  const bearer = warLinks(makeSim({
    squads: [10], events: [{ text: '🕯 Знаменосец пал у (4,4) — дух армии дрогнул.', type: 'bad' }],
  }), mem(makeSim({ squads: [10] })));
  t('гибель знаменосца роняет одобрение военных', bearer.mods.approval.military < 0,
    String(bearer.mods.approval.military));

  // Разбор строк событий — отдельная функция, её проверяем прямо.
  const cls = classifyDay([
    { text: '⚔ Бой у (1,1)', type: 'good' },
    { text: '⚔ Бой у (2,2)', type: 'bad' },
    { text: '🚩 Поселение X взято', type: 'good' },
    { text: '🚩 Знаменосец водрузил знамя', type: 'good' },
    { text: '☠ Отряд разбежался без снабжения.', type: 'bad' },
    { text: '🕯 Знаменосец пал', type: 'bad' },
    { text: '⛳ Рудник перешёл под контроль', type: 'good' },
  ], true);
  t('разбор дня считает победы, поражения, города и знамёна',
    cls.victories === 1 && cls.defeats === 1 && cls.captures === 1 && cls.banners === 1
    && cls.wiped === 1 && cls.bearersLost === 1, JSON.stringify(cls));
  t('захват точки боем не считается', classifyDay([{ text: '⛳ точка', type: 'good' }], true).victories === 0);
  t('без своих отрядов чужой бой нам не приписывается',
    classifyDay([{ text: '⚔ Бой', type: 'bad' }], false).defeats === 0);
}

// ─────────────── 4. Дневные потолки ───────────────
console.log('\n--- Потолки ---');
{
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ text: '⚔ Бой у (1,1)', type: 'bad' });
  many.push({ text: '☠ Отряд полёг.', type: 'bad' });
  const s = makeSim({ squads: [1], reserve: 0, wars: 3, arrears: 30, events: many });
  const L = warLinks(s, mem(s, { total: 200, weariness: WEAR_MAX }));
  t(`одобрение военных за день не ниже ${MIL_DAY_DOWN}`,
    L.mods.approval.military >= MIL_DAY_DOWN - 1e-9, String(L.mods.approval.military));
  t(`стабильность за день не ниже ${STAB_WORST}`, L.mods.stability >= STAB_WORST - 1e-9, String(L.mods.stability));
  t(`счастье не ниже ${HAPPY_WORST}`, L.mods.happy >= HAPPY_WORST, String(L.mods.happy));
  t('усталость не превышает 100', L.flags.weariness <= WEAR_MAX + 1e-9, String(L.flags.weariness));
  t(`множитель армии не ниже ${MULT_MIN}`, L.mods.armyMult >= MULT_MIN - 1e-9, String(L.mods.armyMult));

  const wins = [];
  for (let i = 0; i < 20; i++) wins.push({ text: '🚩 Поселение X взято', type: 'good' });
  const g = makeSim({ squads: [50], approval: { military: 100 }, events: wins });
  const G = warLinks(g, mem(g));
  t(`одобрение военных за день не выше ${MIL_DAY_UP}`, G.mods.approval.military <= MIL_DAY_UP + 1e-9,
    String(G.mods.approval.military));
  t(`стабильность за день не выше ${STAB_BEST}`, G.mods.stability <= STAB_BEST + 1e-9, String(G.mods.stability));
  t(`счастье не выше ${HAPPY_BEST}`, G.mods.happy <= HAPPY_BEST, String(G.mods.happy));
  t(`множитель армии не выше ${MULT_MAX}`, G.mods.armyMult <= MULT_MAX + 1e-9, String(G.mods.armyMult));
}

// ─────────────── 5. Усталость от войны ───────────────
console.log('\n--- Усталость от войны ---');
{
  t('до порога терпения усталости нет', wearQ(WEAR_ACHE) === 0 && wearQ(0) === 0);
  t('на пределе усталость полная', wearQ(WEAR_MAX) === 1);
  t('усталость растёт монотонно', wearQ(60) > wearQ(50) && wearQ(50) > wearQ(40));

  // Короткая война: усталость есть, но страну она ещё не задевает.
  let s = makeSim({ squads: [10], wars: 1 });
  let L = warLinks(s, mem(s, { weariness: 10 }));
  t('короткая война: усталость копится', L.flags.weariness > 10, String(L.flags.weariness));
  t('короткая война: страна её ещё не чувствует',
    L.mods.happy === 0 && L.mods.approval.commons === 0, `${L.mods.happy} / ${L.mods.approval.commons}`);

  // Долгая война: счастье, стабильность и простолюдины.
  s = makeSim({ squads: [10], wars: 1 });
  L = warLinks(s, mem(s, { weariness: WEAR_MAX, warDays: 300 }));
  t('долгая война роняет счастье', L.mods.happy <= WEAR_HAPPY + 1, String(L.mods.happy));
  t('долгая война роняет стабильность', L.mods.stability < 0, String(L.mods.stability));
  t('долгая война злит простолюдинов', L.mods.approval.commons < 0, String(L.mods.approval.commons));
  t('долгая война надоедает и военным, но втрое слабее',
    L.mods.approval.military < 0 && Math.abs(L.mods.approval.military) < Math.abs(L.mods.approval.commons),
    `${L.mods.approval.military} против ${L.mods.approval.commons}`);
  t('игроку сказано словами, что страна устала',
    L.events.some(e => /устал|изнемогает|надоела/i.test(e.text)), JSON.stringify(L.events.map(e => e.text)));
  t('усталость названа в разборе стабильности',
    L.reasons.stability.some(r => /Война идёт/.test(r.ru)), JSON.stringify(L.reasons.stability));

  // Две войны выматывают быстрее одной.
  const one = warLinks(makeSim({ squads: [10], wars: 1 }), mem(makeSim({ squads: [10] }), { weariness: 20 }));
  const two = warLinks(makeSim({ squads: [10], wars: 3 }), mem(makeSim({ squads: [10] }), { weariness: 20 }));
  t('три войны выматывают быстрее одной', two.flags.weariness > one.flags.weariness,
    `${two.flags.weariness} против ${one.flags.weariness}`);

  // ВЫХОД № 1: победа снимает усталость.
  const relief = warLinks(makeSim({
    squads: [10], wars: 1, events: [{ text: '⚔ Бой у (1,1)', type: 'good' }],
  }), mem(makeSim({ squads: [10] }), { weariness: 60 }));
  t('победа гасит усталость', relief.flags.weariness < 60 - WEAR_WIN_RELIEF + WEAR_PER_DAY + 1e-9,
    String(relief.flags.weariness));
  const cap = warLinks(makeSim({
    squads: [10], wars: 1, events: [{ text: '🚩 Поселение X взято', type: 'good' }],
  }), mem(makeSim({ squads: [10] }), { weariness: 60 }));
  t('взятый город гасит усталость сильнее победы в поле',
    cap.flags.weariness < relief.flags.weariness, `${cap.flags.weariness} против ${relief.flags.weariness}`);
  t(`взятый город снимает ровно ${WEAR_CAPTURE_RELIEF}`,
    Math.abs(cap.flags.weariness - (60 + WEAR_PER_DAY - WEAR_CAPTURE_RELIEF)) < 1e-6,
    String(cap.flags.weariness));

  // ВЫХОД № 2: мир растворяет усталость.
  const peace = warLinks(makeSim({ squads: [10], wars: 0 }), mem(makeSim({ squads: [10] }), { weariness: 50 }));
  t(`мирный день снимает ${WEAR_DECAY} усталости`,
    Math.abs(peace.flags.weariness - (50 - WEAR_DECAY)) < 1e-6, String(peace.flags.weariness));
  const zero = warLinks(makeSim({ squads: [10], wars: 0 }), mem(makeSim({ squads: [10] }), { weariness: 0.5 }));
  t('усталость не уходит ниже нуля', zero.flags.weariness === 0, String(zero.flags.weariness));
  t('отметки усталости объявлены по возрастанию',
    WEAR_MARKS.every((m, i) => i === 0 || m > WEAR_MARKS[i - 1]), JSON.stringify(WEAR_MARKS));
}

// ─────────────── 6. Пустая казна разлагает армию ───────────────
console.log('\n--- Пустая казна → армия ---');
{
  t('пока платят — никто не бежит', desertRate(0) === 0 && desertRate(DESERT_AFTER - 1) === 0);
  t('с назначенного дня побег начинается', desertRate(DESERT_AFTER) > 0, String(desertRate(DESERT_AFTER)));
  t('доля побега растёт с задержкой', desertRate(6) > desertRate(5));
  t(`доля побега упирается в потолок ${DESERT_RATE_MAX}`,
    desertRate(99) === DESERT_RATE_MAX, String(desertRate(99)));

  const s = makeSim({ squads: [40], reserve: 20, arrears: 8 });
  const L = warLinks(s, mem(s));
  t('задержка жалования роняет дух отрядов', L.mods.morale < 0, String(L.mods.morale));
  t('причина падения духа названа словами',
    L.reasons.morale.some(r => /Жалование задержано/.test(r.ru)), JSON.stringify(L.reasons.morale));
  t('при задержке из отрядов бегут', L.flags.desert.field > 0, String(L.flags.desert.field));
  t('из резерва дома бегут медленнее, чем из поля',
    L.flags.desert.reserve / 20 < L.flags.desert.field / 40,
    `${L.flags.desert.reserve}/20 против ${L.flags.desert.field}/40`);
  t('план побега разложен по отрядам',
    L.flags.desert.squads.reduce((n, p) => n + p.take, 0) === L.flags.desert.field,
    JSON.stringify(L.flags.desert.squads));
  t('о побеге сказано игроку', L.events.some(e => /Жалование не платят/.test(e.text)));
  t('игроку подсказан выход', L.flags.advice.some(a => /Распустите/.test(a)), JSON.stringify(L.flags.advice));

  t('неплаченая армия дерётся хуже', armyMultOf(8, 55) < 1, String(armyMultOf(8, 55)));
  t('множитель армии не проваливается ниже пола', armyMultOf(999, 0) === MULT_MIN, String(armyMultOf(999, 0)));
  t('вовремя плаченая армия ничего не теряет', armyMultOf(0, 55) === 1);
  t('любимое сословием войско дерётся лучше', armyMultOf(0, 100) > 1, String(armyMultOf(0, 100)));
  t(`надбавка за любовь не больше ${MULT_LOVE_MAX}`,
    Math.abs(armyMultOf(0, 100) - (1 + MULT_LOVE_MAX)) < 1e-6, String(armyMultOf(0, 100)));
  t('одобрение ровно на границе «довольны» надбавки ещё не даёт', armyMultOf(0, FACTION_HAPPY) === 1);

  // Раскладка побега по отрядам: числа, а не «функция не упала».
  const sq = [
    { id: 1, name: 'A', units: { a: 10 } }, { id: 2, name: 'B', units: { a: 6 } }, { id: 3, name: 'C', units: { a: 4 } },
  ];
  const plan = desertPlan(sq, 5);
  t('план побега забирает ровно столько, сколько велено',
    plan.reduce((n, p) => n + p.take, 0) === 5, JSON.stringify(plan));
  t('план побега не забирает больше, чем есть в отряде',
    plan.every(p => p.take <= sq.find(x => x.id === p.id).units.a), JSON.stringify(plan));
  t('больший отряд теряет больше', plan[0].take >= plan[plan.length - 1].take, JSON.stringify(plan));
  t('план детерминирован', JSON.stringify(desertPlan(sq, 5)) === JSON.stringify(plan));
  t('нельзя увести больше, чем всего людей',
    desertPlan(sq, 999).reduce((n, p) => n + p.take, 0) === 20, JSON.stringify(desertPlan(sq, 999)));

  // ВЫХОД № 3: побег снимает расход с казны — войско тает, но не бесконечно.
  const empty = makeSim({ squads: [], reserve: 0, arrears: 20 });
  const E = warLinks(empty, mem(empty));
  t('когда бежать уже некому, связь не выдумывает дезертиров',
    E.flags.desert.field === 0 && E.flags.desert.reserve === 0);
}

// ─────────────── 7. Мир: порядок и скука ───────────────
console.log('\n--- Мир: порядок и скука ---');
{
  const s = makeSim({ squads: [8], reserve: 4, wars: 0, pop: 40 });
  const L = warLinks(s, mem(s, { peaceDays: ORDER_AFTER + 5 }));
  t('сильная оплаченная армия при мире держит порядок',
    L.mods.stability > 0 && L.flags.order === true, String(L.mods.stability));
  t(`награда за порядок не выше ${ORDER_STAB_MAX}`, L.mods.stability <= ORDER_STAB_MAX + 1e-9,
    String(L.mods.stability));
  t('причина порядка названа словами',
    L.reasons.stability.some(r => /Гарнизон/.test(r.ru)), JSON.stringify(L.reasons.stability));

  const war = makeSim({ squads: [8], reserve: 4, wars: 1 });
  t('на войне гарнизон порядок не держит',
    warLinks(war, mem(war, { peaceDays: 0 })).flags.order === false);
  const unpaid = makeSim({ squads: [8], reserve: 4, wars: 0, arrears: 2 });
  t('неоплаченный гарнизон порядок не держит',
    warLinks(unpaid, mem(unpaid, { peaceDays: 30 })).flags.order === false);
  const tiny = makeSim({ squads: [ORDER_MIN_MEN - 3], wars: 0 });
  t('горстка бойцов ещё не гарнизон',
    warLinks(tiny, mem(tiny, { peaceDays: 30 })).flags.order === false);

  // Скука военного сословия.
  const calm = makeSim({ squads: [10], wars: 0 });
  t(`первые ${BORED_AFTER} дней мира военные не скучают`,
    warLinks(calm, mem(calm, { peaceDays: BORED_AFTER - 5 })).flags.bored === false);
  const bored = warLinks(calm, mem(calm, { peaceDays: BORED_AFTER + 60 }));
  t('долгий мир злит военное сословие',
    bored.flags.bored === true && bored.mods.approval.military < 0, String(bored.mods.approval.military));
  t('причина скуки названа словами',
    bored.reasons.approval.some(r => /нечем заняться/.test(r.ru)), JSON.stringify(bored.reasons.approval));
  const floor = makeSim({ squads: [10], wars: 0, approval: { military: BORED_FLOOR - 1 } });
  t(`скука не тянет военных ниже ${BORED_FLOOR}`,
    warLinks(floor, mem(floor, { peaceDays: 500 })).mods.approval.military === 0,
    String(warLinks(floor, mem(floor, { peaceDays: 500 })).mods.approval.military));
  t('скука слабее, чем удар за поражение',
    Math.abs(bored.mods.approval.military) < 1, String(bored.mods.approval.military));
}

// ─────────────── 8. Выход из спирали «нет денег → нет армии → набеги» ───────────────
console.log('\n--- Выход из спирали ---');
{
  const s = makeSim({ squads: [], reserve: 0, arrears: RESPITE_ARREARS + 2, pop: 40, raidTimer: 10 });
  const L = warLinks(s, mem(s));
  t('разорённой державе набег откладывают', L.flags.raidDelay === RESPITE_DAYS, String(L.flags.raidDelay));
  t('о передышке сказано игроку', L.events.some(e => /Набег откладывается/.test(e.text)));
  t('передышка сопровождается советом', L.flags.advice.some(a => /Передышка/.test(a)));

  // Второй раз подряд — нельзя: у выхода есть свой откат.
  const again = warLinks(makeSim({ squads: [], arrears: 9, raidTimer: 10, day: 101 }), L.memo);
  t(`передышку не дают чаще раза в ${RESPITE_CD} дней`, again.flags.raidDelay === 0, String(again.flags.raidDelay));
  const later = warLinks(makeSim({ squads: [], arrears: 9, raidTimer: 10, day: 100 + RESPITE_CD }), L.memo);
  t('через положенный срок передышка снова возможна', later.flags.raidDelay === RESPITE_DAYS,
    String(later.flags.raidDelay));

  const rich = makeSim({ squads: [20], reserve: 10, arrears: 9, raidTimer: 10 });
  t('державе с войском передышки не дают', warLinks(rich, mem(rich)).flags.raidDelay === 0);
  const paid = makeSim({ squads: [], arrears: 0, raidTimer: 10 });
  t('державе с полной казной передышки не дают', warLinks(paid, mem(paid)).flags.raidDelay === 0);
  const off = makeSim({ squads: [], arrears: 9, raidsOff: true, raidTimer: 10 });
  t('при выключенных набегах передышка не нужна', warLinks(off, mem(off)).flags.raidDelay === 0);
  const early = makeSim({ squads: [], arrears: 9, era: 1, raidTimer: 10 });
  t('до Железного века набегов нет — нечего и откладывать',
    warLinks(early, mem(early)).flags.raidDelay === 0);
}

// ─────────────── 9. Дисциплина расчёта: один день — один раз ───────────────
console.log('\n--- Один день считается один раз ---');
{
  const s = makeSim({ squads: [10], wars: 1 });
  const M = mem(s, { weariness: 50 });
  const first = warLinks(s, M);
  const second = warLinks(s, first.memo);   // тот же день, память уже за сегодня
  t('повторный вызов в тот же день ничего не начисляет',
    second.flags.quiet === true && second.mods.stability === 0, JSON.stringify(second.mods));
  t('повторный вызов не двигает усталость',
    second.flags.weariness === first.flags.weariness && first.flags.weariness === M.weariness + WEAR_PER_DAY,
    `${second.flags.weariness} против ${first.flags.weariness}`);

  // Разрыв в счёте (загрузка сейва): состояние читаем, события — нет.
  const jump = makeSim({ squads: [2], day: 200 });
  const J = warLinks(jump, mem(jump, { day: 100, total: 40 }));
  t('после разрыва в счёте вчерашние потери не приписываются', J.flags.losses === 0, String(J.flags.losses));

  // Детерминизм: два одинаковых вызова дают одинаковый ответ.
  const a = warLinks(makeSim({ squads: [10], arrears: 7, wars: 1 }), mem(makeSim({ squads: [10] }), { weariness: 70 }));
  const b = warLinks(makeSim({ squads: [10], arrears: 7, wars: 1 }), mem(makeSim({ squads: [10] }), { weariness: 70 }));
  t('связь детерминирована', JSON.stringify(a.mods) === JSON.stringify(b.mods), JSON.stringify(a.mods));

  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/core/systems/link_war.js'), 'utf8');
  t('Math.random в модуле не вызывается (иначе ломались бы сейвы)', !/Math\.random\s*\(/.test(src));
  t('в блоке ПОДКЛЮЧЕНИЕ есть все якоря',
    /import \* as EMP from '\.\/wire_empire\.js';/.test(src) && /EMP\.empireNewDay\(sim\);/.test(src)
    && /emp: EMP\.empireSerialize\(sim\),/.test(src));
}

// ─────────────── 10. Память переживает сохранение ───────────────
console.log('\n--- Сохранение памяти ---');
{
  const s = makeSim({ squads: [10], wars: 1 });
  const L = warLinks(s, mem(s, { weariness: 44.5, warDays: 90, grief: 2, pride: 1 }));
  const round = restoreWarMemory(JSON.parse(JSON.stringify(L.memo)));
  t('усталость переживает сохранение', Math.abs(round.weariness - L.memo.weariness) < 1e-9,
    `${round.weariness} против ${L.memo.weariness}`);
  t('счёт дней войны переживает сохранение', round.warDays === L.memo.warDays);
  t('битый сейв не роняет связь', restoreWarMemory('мусор').day === -1);
  t('усталость из битого сейва зажимается в границы',
    restoreWarMemory({ weariness: 9999 }).weariness === WEAR_MAX);
}

// ─────────────── 11. Разбор для панели ───────────────
console.log('\n--- Слова для игрока ---');
{
  const s = makeSim({ squads: [10], arrears: 6, wars: 1 });
  const L = warLinks(s, mem(s, { weariness: 80, warDays: 200 }));
  const ex = explainWar(s, L);
  t('панель получает усталость и задержку жалования',
    ex.weariness > 0 && ex.arrears === 6, JSON.stringify({ w: ex.weariness, a: ex.arrears }));
  t('панель объясняет усталость словами',
    ex.rows.some(r => /Усталость/.test(r.ru) && /Победа снимает/.test(r.text)), JSON.stringify(ex.rows));
  t('панель объясняет задержку жалования числами',
    ex.rows.some(r => /Жалование/.test(r.ru) && /% в день/.test(r.text)), JSON.stringify(ex.rows));
  t('панель показывает множитель армии', ex.armyMult < 1, String(ex.armyMult));
  t('панель без связи не падает', !!explainWar(makeSim({}), null));
}

// ─────────────── 12. Живая партия ───────────────
console.log('\n--- В настоящей партии ---');
{
  const { Simulation } = await import('../src/core/simulation.js');
  const s = new Simulation(41);
  for (let i = 0; i < 200; i++) s.tick(0.25);

  t('в живой партии установлены армия и фронт', !!s.armyState && !!s.war);
  t('чтение мира работает на живом Simulation',
    typeof fieldMen(s) === 'number' && typeof reserveMen(s) === 'number' && typeof arrearsOf(s) === 'number',
    `${fieldMen(s)} / ${reserveMen(s)} / ${arrearsOf(s)}`);

  let memo = createWarMemory();
  let worstStab = 0, bestStab = 0, worstHappy = 0;
  for (let d = 0; d < 200; d++) {
    const L = warLinks(s, memo);
    memo = L.memo;
    worstStab = Math.min(worstStab, L.mods.stability);
    bestStab = Math.max(bestStab, L.mods.stability);
    worstHappy = Math.min(worstHappy, L.mods.happy);
    // Применяем поправки так же, как это делает слой подключения.
    const P = s.politics.state;
    for (const f of ESTATES) P.factions[f] = Math.max(0, Math.min(100, P.factions[f] + L.mods.approval[f]));
    P.stability = Math.max(0, Math.min(100, P.stability + L.mods.stability));
    for (let k = 0; k < 4; k++) s.tick(0.25);
  }
  t('200 дней подряд связь не выходит за объявленные границы стабильности',
    worstStab >= STAB_WORST - 1e-9 && bestStab <= STAB_BEST + 1e-9, `${worstStab} … ${bestStab}`);
  t('200 дней подряд счастье не проваливается ниже объявленного дна',
    worstHappy >= HAPPY_WORST, String(worstHappy));
  t('сословия остались в границах 0..100',
    ESTATES.every(f => s.politics.state.factions[f] >= 0 && s.politics.state.factions[f] <= 100),
    JSON.stringify(s.politics.state.factions));
  t('стабильность осталась в границах 0..100',
    s.politics.state.stability >= 0 && s.politics.state.stability <= 100, String(s.politics.state.stability));
  // Мирная партия без задержек жалования и без войн ничего не должна ломать.
  const L = warLinks(s, memo);
  t('память живой партии осмысленна',
    L.memo.day === s.day && L.memo.total === fieldMen(s) + reserveMen(s),
    JSON.stringify({ day: L.memo.day, simDay: s.day, total: L.memo.total }));
  t('в мирной живой партии множитель армии не наказывает без причины',
    (arrearsOf(s) > 0) === (L.mods.armyMult < 1), `${arrearsOf(s)} / ${L.mods.armyMult}`);
  t('дезертирство в живой партии бывает только при задержке жалования',
    L.flags.desert.field === 0 || arrearsOf(s) >= DESERT_AFTER,
    `${L.flags.desert.field} при задержке ${arrearsOf(s)}`);
  t('отряды игрока читаются модулем', Array.isArray(playerSquads(s)));
}

console.log(`\n=== ${ok} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
