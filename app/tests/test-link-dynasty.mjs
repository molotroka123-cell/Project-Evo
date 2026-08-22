// Тесты связи «род ↔ сословия ↔ стабильность ↔ держава» (link_dynasty.js).
// Запуск: node app/tests/test-link-dynasty.mjs
//
// Проверяем не «функция не упала», а числа: направление каждой связи, потолки
// петель, ступени заговора и его гистерезис, гарантию выхода, поведение на
// краях, молчание при спокойном состоянии, круг сохранения и то, что модуль
// ничего не мутирует.
import { readFileSync } from 'node:fs';
import { Simulation } from '../src/core/simulation.js';
import { SOCIAL_FACTIONS, RULER_TRAITS } from '../src/core/systems/politics.js';
import { createMemory, remember } from '../src/core/systems/link_memory.js';
import {
  dynastyLinks, dynastyLinkState, dynastyLinkBreakdown, heirVeto, canNameHeirNow,
  createDynastyLink, restoreDynastyLink, serializeDynastyLink,
  legitimacyEstates, traitEstates, courtEstates, plotDelta, stageOf, coupGate, fedShare,
  LEG_PIVOT, LEG_HOLY, LEG_USURP, LEG_ESTATE, CLERGY_BLESS, CLERGY_CURSE,
  TRAIT_ESTATE, ESTATE_STEP_CAP, STAB_FLOOR,
  COURT_LUX_COMMONS, COURT_LUX_MERCH, COURT_THIN_CLERGY, COURT_UNPAID_CLERGY,
  PLOT_MAX, PLOT_STEP_MAX, PLOT_CALM, PLOT_LEG, PLOT_ANGRY_NOBLES, PLOT_ANGRY_MIL,
  STAGE_MURMUR, STAGE_MURMUR_CLEAR, STAGE_PRETENDER, STAGE_PRETENDER_CLEAR,
  STAGE_COUP, STAGE_COUP_CLEAR, STAGE_STAB, CRUEL_PLOT_DAMP,
  COUP_DAYS, COUP_BLOCK_LEG, COUP_CD, COUP_FAIL_STAB,
  INTER_UNREST, NOBLE_VETO, SCAR_TO_LEG,
} from '../src/core/systems/link_dynasty.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK ', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≠ ${b}`);

// ───────────────────────── Подделки ─────────────────────────
//
// Модель рода (dynasty.js) пишется параллельно, поэтому связь проверяется на
// ПОДДЕЛКЕ состояния рода — ровно тех полях, которые связь читает. Так тест не
// зависит от того, дописал ли сосед свой файл, и ставит любое состояние без
// прогона тысячи игровых дней.
function fakeDynasty(o = {}) {
  return {
    fam: o.fam ?? 'Кремень',
    legitimacy: o.legitimacy ?? LEG_PIVOT,
    court: o.court ?? 1,
    claimants: o.claimants ?? [],
    interregnum: o.interregnum ?? 0,
    foundedDay: o.foundedDay ?? 0,
    rulerId: 1,
    members: [{ id: 1, name: 'Ждан Кремень', traits: o.traits ?? [] }],
    generations: o.generations ?? 1,
    stats: { coups: o.coups ?? 0, houses: 1 },
  };
}

function makeSim(o = {}) {
  const pop = o.pop ?? 20;
  const factions = { nobles: 50, clergy: 50, merchants: 50, commons: 50, military: 50, ...(o.factions || {}) };
  return {
    day: o.day ?? 10,
    villagers: Array.from({ length: pop }, () => ({ hp: 10 })),
    res: { food: (o.foodDays ?? 10) * pop * 0.7, gold: o.gold ?? 200 },
    politics: {
      state: {
        gov: o.gov ?? 'chiefdom',
        stability: o.stability ?? 60,
        factions,
        ruler: { name: 'Ждан', age: 40, since: 0, traits: o.traits ?? [] },
      },
    },
    dynasty: o.noDyn ? null : fakeDynasty(o),
    linkDynasty: o.link || createDynastyLink(),
    linkMemory: o.mem || createMemory(),
    sys: { dynastyReport: o.courtUnpaid ? { flags: { courtUnpaid: true } } : null },
  };
}

// Прогон N суток: связь возвращает новую память, кладём её обратно — ровно то,
// что делает integrate.js.
function run(sim, days) {
  let out = null;
  for (let i = 0; i < days; i++) {
    out = dynastyLinks(sim);
    sim.linkDynasty = out.flags.memory;
    sim.day++;
  }
  return out;
}

console.log('--- Спокойный род молчит ---');
{
  const sim = makeSim({ legitimacy: LEG_PIVOT, court: 1 });
  const out = dynastyLinks(sim);
  t('нет поправки к стабильности', () => near(out.mods.stability, 0, 1e-9, 'стабильность'));
  t('сословия не тронуты',
    () => ok(Object.values(out.mods.estates).every(v => v === 0), JSON.stringify(out.mods.estates)));
  t('городам ничего не подаётся', () => near(out.mods.cityUnrestAll, 0, 1e-9, 'cityUnrestAll'));
  t('нечего рассказывать', () => ok(out.events.length === 0, `событий ${out.events.length}`));
  t('заговора нет', () => ok(out.flags.plot === 0 && out.flags.stage === 0, JSON.stringify(out.flags.plot)));
  t('роду нечего передать', () => ok(out.flags.dynEvents.length === 0, JSON.stringify(out.flags.dynEvents)));
}

console.log('\n--- Рода нет вовсе (старый сейв) ---');
{
  const sim = makeSim({ noDyn: true });
  const out = dynastyLinks(sim);
  t('без рода связь молчит целиком', () => {
    ok(out.mods.stability === 0, 'стабильность');
    ok(Object.values(out.mods.estates).every(v => v === 0), 'сословия');
    ok(out.events.length === 0, 'события');
  });
  t('разбор для панели тоже не падает', () => {
    const b = dynastyLinkBreakdown(sim);
    ok(/Рода/.test(b.text), b.text);
  });
}

console.log('\n--- Законность → сословия ---');
{
  const hi = dynastyLinks(makeSim({ legitimacy: 100 }));
  const lo = dynastyLinks(makeSim({ legitimacy: 0 }));
  t('крепкая законность поднимает знать', () => ok(hi.mods.estates.nobles > 0, `${hi.mods.estates.nobles}`));
  t('ничтожная законность роняет знать', () => ok(lo.mods.estates.nobles < 0, `${lo.mods.estates.nobles}`));
  t('знать держится за законность сильнее всех',
    () => ok(LEG_ESTATE.nobles > LEG_ESTATE.commons && LEG_ESTATE.nobles > LEG_ESTATE.merchants
      && LEG_ESTATE.nobles > LEG_ESTATE.military, JSON.stringify(LEG_ESTATE)));
  t('простолюдину право рода почти безразлично',
    () => ok(Math.abs(lo.mods.estates.commons) < Math.abs(lo.mods.estates.nobles) / 3,
      `${lo.mods.estates.commons} против ${lo.mods.estates.nobles}`));
  t('причина названа словами, а не числом', () => {
    const row = lo.reasons.estates.find(r => r.fid === 'nobles');
    ok(row && /законность/i.test(row.ru), JSON.stringify(row));
  });
}

console.log('\n--- Жрецы: освящение и узурпация ---');
{
  const holy = legitimacyEstates(dynastyLinkState(makeSim({ legitimacy: 100 })));
  const mid = legitimacyEstates(dynastyLinkState(makeSim({ legitimacy: (LEG_HOLY + LEG_USURP) / 2 })));
  const usurp = legitimacyEstates(dynastyLinkState(makeSim({ legitimacy: 0 })));
  t('при высокой законности жрецы за', () => near(holy.estates.clergy, CLERGY_BLESS, 1e-9, 'жрецы'));
  t('между порогами жрецы молчат', () => near(mid.estates.clergy, 0, 1e-9, 'жрецы'));
  t('при узурпации жрецы против', () => near(usurp.estates.clergy, -CLERGY_CURSE, 1e-9, 'жрецы'));
  t('осуждение сильнее похвалы: венчать труднее, чем отказать',
    () => ok(CLERGY_CURSE > CLERGY_BLESS, `${CLERGY_CURSE} vs ${CLERGY_BLESS}`));
  t('молодой род после переворота жрецы не венчают', () => {
    const young = legitimacyEstates(dynastyLinkState(makeSim({ day: 100, foundedDay: 50, coups: 1, legitimacy: LEG_PIVOT })));
    ok(young.estates.clergy < 0, `${young.estates.clergy}`);
  });
  t('через положенные годы это проходит само', () => {
    const old = legitimacyEstates(dynastyLinkState(makeSim({ day: 1000, foundedDay: 0, coups: 1, legitimacy: LEG_PIVOT })));
    near(old.estates.clergy, 0, 1e-9, 'жрецы');
  });
}

console.log('\n--- Черты правителя → одобрение ---');
{
  t('у каждой черты из RULER_TRAITS есть отношение общества', () => {
    const miss = RULER_TRAITS.map(x => x.id).filter(id => !TRAIT_ESTATE[id]);
    ok(miss.length === 0, `без строки: ${miss.join(', ')}`);
  });
  t('в таблице нет выдуманных черт', () => {
    const ids = new Set(RULER_TRAITS.map(x => x.id));
    const extra = Object.keys(TRAIT_ESTATE).filter(id => !ids.has(id));
    ok(extra.length === 0, `лишние: ${extra.join(', ')}`);
  });
  t('все сословия в таблице черт существуют', () => {
    for (const [tid, tab] of Object.entries(TRAIT_ESTATE)) {
      for (const fid of Object.keys(tab)) ok(SOCIAL_FACTIONS[fid], `${tid} → неизвестное сословие ${fid}`);
    }
  });
  const cruel = dynastyLinks(makeSim({ traits: ['cruel'] }));
  t('жестокого ненавидят простолюдины', () => ok(cruel.mods.estates.commons < 0, `${cruel.mods.estates.commons}`));
  t('жестокому рады знать и войско',
    () => ok(cruel.mods.estates.nobles > 0 && cruel.mods.estates.military > 0, JSON.stringify(cruel.mods.estates)));
  const beloved = dynastyLinks(makeSim({ traits: ['beloved'] }));
  t('любимца толпы любят простолюдины', () => ok(beloved.mods.estates.commons > 0, `${beloved.mods.estates.commons}`));
  t('любимец толпы приятнее жестокого именно низам',
    () => ok(beloved.mods.estates.commons > cruel.mods.estates.commons, 'сравнение'));
  const warlord = dynastyLinks(makeSim({ traits: ['warlord'] }));
  t('полководцу радо войско', () => ok(warlord.mods.estates.military > 0, `${warlord.mods.estates.military}`));
  const trader = dynastyLinks(makeSim({ traits: ['trader'] }));
  t('торгашу рады купцы', () => ok(trader.mods.estates.merchants > 0, `${trader.mods.estates.merchants}`));
}

console.log('\n--- Двор глазами державы ---');
{
  const norm = courtEstates(dynastyLinkState(makeSim({ court: 1 })));
  t('двор по обычаю не вызывает чувств',
    () => ok(Object.values(norm.estates).every(v => v === 0), JSON.stringify(norm.estates)));
  const lux = dynastyLinks(makeSim({ court: 2, foodDays: 20 }));
  t('пышный двор злит простолюдин', () => ok(lux.mods.estates.commons < 0, `${lux.mods.estates.commons}`));
  t('пышный двор радует купцов', () => near(lux.mods.estates.merchants, COURT_LUX_MERCH, 1e-9, 'купцы'));
  const hungryLux = dynastyLinks(makeSim({ court: 2, foodDays: 0 }));
  t('при голоде роскошь злит сильнее',
    () => ok(hungryLux.mods.estates.commons < lux.mods.estates.commons - 0.01,
      `${hungryLux.mods.estates.commons} против ${lux.mods.estates.commons}`));
  t('но это усилитель, а не второй удар голода: потолок соблюдён',
    () => ok(Math.abs(hungryLux.mods.estates.commons) <= COURT_LUX_COMMONS + 1e-9,
      `${hungryLux.mods.estates.commons} > ${COURT_LUX_COMMONS}`));
  const thin = dynastyLinks(makeSim({ court: 0 }));
  t('скупой двор обижает жрецов', () => near(thin.mods.estates.clergy, -COURT_THIN_CLERGY, 1e-9, 'жрецы'));
  const unpaid = dynastyLinks(makeSim({ courtUnpaid: true }));
  t('неоплаченный двор бьёт по жрецам и купцам',
    () => ok(unpaid.mods.estates.clergy <= -COURT_UNPAID_CLERGY + 1e-9 && unpaid.mods.estates.merchants < 0,
      JSON.stringify(unpaid.mods.estates)));
}

console.log('\n--- Потолки поправок ---');
{
  // Самое злое сочетание разом: ничтожная законность, пышный двор при голоде,
  // слабый правитель, пустой трон.
  const sim = makeSim({
    legitimacy: 0, court: 2, foodDays: 0, traits: ['weak'], interregnum: 20,
    factions: { nobles: 0, military: 0 },
  });
  const out = dynastyLinks(sim);
  t('ни одно сословие не сдвинуто больше чем на потолок', () => {
    for (const [fid, v] of Object.entries(out.mods.estates)) {
      ok(Math.abs(v) <= ESTATE_STEP_CAP + 1e-9, `${fid}: ${v} > ${ESTATE_STEP_CAP}`);
    }
  });
  t('дневная потеря стабильности не ниже пола',
    () => ok(out.mods.stability >= STAB_FLOOR - 1e-9, `${out.mods.stability} < ${STAB_FLOOR}`));
}

console.log('\n--- Заговор: рост, потолок и ГАРАНТИЯ ВЫХОДА ---');
{
  t('спад строго быстрее предельного роста — иначе спираль без выхода',
    () => ok(PLOT_CALM > PLOT_STEP_MAX, `${PLOT_CALM} <= ${PLOT_STEP_MAX}`));
  t('пороги ступеней идут по возрастанию',
    () => ok(STAGE_MURMUR < STAGE_PRETENDER && STAGE_PRETENDER < STAGE_COUP, 'пороги'));
  t('у каждой ступени порог выхода ниже порога входа (гистерезис)', () => {
    ok(STAGE_MURMUR_CLEAR < STAGE_MURMUR, 'ропот');
    ok(STAGE_PRETENDER_CLEAR < STAGE_PRETENDER, 'претендент');
    ok(STAGE_COUP_CLEAR < STAGE_COUP, 'заговор');
  });
  t('ступень не мигает у самой границы', () => {
    // Ровно между порогом входа и порогом выхода ступень держится обеих сторон.
    const mid = (STAGE_PRETENDER + STAGE_PRETENDER_CLEAR) / 2;
    ok(stageOf(mid, 1) === 1, 'снизу ещё не вошли');
    ok(stageOf(mid, 2) === 2, 'сверху ещё не вышли');
  });
  const worst = plotDelta(dynastyLinkState(makeSim({
    legitimacy: 0, interregnum: 20, factions: { nobles: 0, military: 0 },
    claimants: [{ name: 'А', fam: 'Б', strength: 60 }, { name: 'В', fam: 'Г', strength: 55 }],
  })));
  t('в худший день шаг всё равно ограничен потолком',
    () => ok(worst.d <= PLOT_STEP_MAX + 1e-9, `${worst.d} > ${PLOT_STEP_MAX}`));
  t('в худший день заговор действительно растёт', () => ok(worst.d > 0, `${worst.d}`));
  const best = plotDelta(dynastyLinkState(makeSim({ legitimacy: 90, factions: { nobles: 80, military: 80 } })));
  t('при выправленном положении заговор тает',
    () => ok(best.d < 0, `${best.d}`));
  t('погасить можно быстрее, чем накопилось: со 100 до нуля меньше чем за 60 суток',
    () => ok(PLOT_MAX / Math.abs(best.d) < 60, `${PLOT_MAX / Math.abs(best.d)} суток`));
  t('жестокий правитель тормозит заговор', () => {
    const plain = plotDelta(dynastyLinkState(makeSim({ legitimacy: 10, factions: { nobles: 10 } })));
    const harsh = plotDelta(dynastyLinkState(makeSim({ legitimacy: 10, factions: { nobles: 10 }, traits: ['cruel'] })));
    near(harsh.grow, plain.grow * CRUEL_PLOT_DAMP, 1e-9, 'прирост');
  });
}

console.log('\n--- Лестница: ропот → претендент → попытка ---');
{
  const sim = makeSim({ legitimacy: 0, factions: { nobles: 5, military: 5 }, claimants: [{ name: 'Мал', fam: 'Волк', strength: 70 }] });
  const seen = new Set();
  let firstMurmur = -1, firstCoupWarn = -1;
  for (let d = 0; d < 200; d++) {
    const out = dynastyLinks(sim);
    sim.linkDynasty = out.flags.memory;
    seen.add(out.flags.stage);
    if (out.flags.stage === 1 && firstMurmur < 0) firstMurmur = d;
    if (out.flags.stage === 3 && firstCoupWarn < 0) firstCoupWarn = d;
    sim.day++;
  }
  t('лестница проходит все ступени по порядку',
    () => ok(seen.has(1) && seen.has(2) && seen.has(3), `виденные ступени: ${[...seen].join(',')}`));
  t('ропот наступает раньше созревшего заговора',
    () => ok(firstMurmur >= 0 && firstCoupWarn > firstMurmur, `${firstMurmur} → ${firstCoupWarn}`));
  t('каждая ступень стоит стабильности, и чем выше — тем дороже',
    () => ok(STAGE_STAB[1] < STAGE_STAB[2] && STAGE_STAB[2] < STAGE_STAB[3], JSON.stringify(STAGE_STAB)));
}
{
  // Отдельный прогон: следим за словами и за отсчётом.
  const sim = makeSim({ legitimacy: 0, factions: { nobles: 5, military: 5 } });
  let sawMurmurWord = false, sawCountdown = false, sawWayOut = false, sawAttempt = false;
  for (let d = 0; d < 200; d++) {
    const out = dynastyLinks(sim);
    sim.linkDynasty = out.flags.memory;
    for (const e of out.events) {
      if (/ропщ/i.test(e.text)) sawMurmurWord = true;
      if (/До попытки переворота \d+/.test(e.text)) sawCountdown = true;
      if (/сорван|ЗАГОВОР УДАРИЛ/i.test(e.text)) sawAttempt = true;
    }
    if (out.flags.stage > 0) {
      const w = out.reasons.other.find(r => /Как погасить/.test(r.ru));
      if (w && w.ru.length > 30) sawWayOut = true;
    }
    sim.day++;
  }
  t('о ропоте предупреждают словами', () => ok(sawMurmurWord, 'не сказано'));
  t('до попытки переворота называют точный срок', () => ok(sawCountdown, 'нет отсчёта'));
  t('способ выйти написан словами в reasons каждый день ступени', () => ok(sawWayOut, 'нет способа'));
  t('попытка действительно случается, если не мешать', () => ok(sawAttempt, 'ничего не произошло'));
}

console.log('\n--- Переворот не бывает неизбежным ---');
{
  // Законность выше замка: заговор может созреть, но попытка обречена.
  const sim = makeSim({ legitimacy: COUP_BLOCK_LEG + 5, factions: { nobles: 0, military: 0 }, interregnum: 30 });
  const gate = coupGate(sim, dynastyLinkState(sim));
  t('при крепкой законности замок закрыт', () => ok(!gate.ok, JSON.stringify(gate)));
  t('и причина названа словами', () => ok(/законност/i.test(gate.reason), gate.reason));

  const s2 = makeSim({ legitimacy: 0, factions: { nobles: 5, military: 5 } });
  let coups = 0, fails = 0;
  for (let d = 0; d < 200; d++) {
    const out = dynastyLinks(s2);
    s2.linkDynasty = out.flags.memory;
    if (out.flags.coupNow) coups++;
    if (out.flags.coupFailed) fails++;
    s2.day++;
  }
  t('при обиженных сословиях модель рода сама не даёт перевороту состояться',
    () => ok(coups === 0 && fails > 0, `удачных ${coups}, сорванных ${fails}`));
  t('сорванная попытка стоит стабильности разово, а не тягой', () => {
    const s3 = makeSim({ legitimacy: 0, factions: { nobles: 5, military: 5 } });
    let shock = 0;
    for (let d = 0; d < 200; d++) {
      const out = dynastyLinks(s3);
      s3.linkDynasty = out.flags.memory;
      if (out.mods.stabilityShock) shock = out.mods.stabilityShock;
      s3.day++;
    }
    near(shock, -COUP_FAIL_STAB, 1e-9, 'разовый удар');
  });
  t('разовый удар по сословиям не срезается дневным потолком', () => {
    const s4 = makeSim({ legitimacy: 0, factions: { nobles: 5, military: 5 } });
    let sh = null;
    for (let d = 0; d < 200 && !sh; d++) {
      const out = dynastyLinks(s4);
      s4.linkDynasty = out.flags.memory;
      if (out.flags.coupFailed) sh = out.mods.estatesShock;
      s4.day++;
    }
    ok(sh && sh.nobles <= -1, JSON.stringify(sh));
  });
  t('после попытки наступает тишина: второй попытки подряд не бывает', () => {
    const s5 = makeSim({ legitimacy: 0, factions: { nobles: 5, military: 5 } });
    const days = [];
    for (let d = 0; d < 400; d++) {
      const out = dynastyLinks(s5);
      s5.linkDynasty = out.flags.memory;
      if (out.flags.coupFailed || out.flags.coupNow) days.push(d);
      s5.day++;
    }
    ok(days.length >= 2, `попыток ${days.length}`);
    ok(days[1] - days[0] >= COUP_CD, `между попытками ${days[1] - days[0]} < ${COUP_CD}`);
  });
  t('заговор гасится, если игрок выправил дела', () => {
    const s6 = makeSim({ legitimacy: 0, factions: { nobles: 5, military: 5 } });
    run(s6, 60);
    const before = s6.linkDynasty.plot;
    ok(before > STAGE_MURMUR, `заговор не созрел: ${before}`);
    // Игрок исправился: законность и сословия подняты.
    s6.dynasty.legitimacy = 90;
    s6.politics.state.factions.nobles = 80;
    s6.politics.state.factions.military = 80;
    run(s6, 60);
    ok(s6.linkDynasty.plot === 0, `заговор не погас: ${s6.linkDynasty.plot}`);
    ok(s6.linkDynasty.stage === 0, `ступень ${s6.linkDynasty.stage}`);
  });
}

console.log('\n--- Пресечение рода → сигнал городам ---');
{
  const sim = makeSim({ interregnum: 25 });
  const out = dynastyLinks(sim);
  t('городам подан сигнал сепаратизма', () => near(out.mods.cityUnrestAll, INTER_UNREST, 1e-9, 'cityUnrestAll'));
  t('связь не считает ни одного города сама',
    () => ok(out.mods.cityUnrest === undefined, 'связь полезла в города'));
  t('сословия в панике', () => ok(out.mods.estates.nobles < 0 && out.mods.estates.military < 0,
    JSON.stringify(out.mods.estates)));
  t('причина названа словами', () => {
    const r = out.reasons.other.find(x => /Междуцарствие/.test(x.ru));
    ok(r && /смута/i.test(r.ru), JSON.stringify(out.reasons.other));
  });
}

console.log('\n--- Обратно: память → законность ---');
{
  const mem = createMemory();
  remember(mem, 'shame', 10);              // потеряна провинция
  const sim = makeSim({ day: 10, mem });
  const out = dynastyLinks(sim);
  t('свежий позор превращается в удар по законности', () => {
    const ev = out.flags.dynEvents.find(e => e.kind === SCAR_TO_LEG.shame);
    ok(ev, JSON.stringify(out.flags.dynEvents));
  });
  t('победа превращается в награду', () => {
    const m2 = createMemory();
    remember(m2, 'triumph', 10);
    const o2 = dynastyLinks(makeSim({ day: 10, mem: m2 }));
    ok(o2.flags.dynEvents.some(e => e.kind === 'triumph'), JSON.stringify(o2.flags.dynEvents));
  });
  t('стужа права на трон не отнимает', () => {
    const m3 = createMemory();
    remember(m3, 'frost', 10);
    const o3 = dynastyLinks(makeSim({ day: 10, mem: m3 }));
    ok(o3.flags.dynEvents.length === 0, JSON.stringify(o3.flags.dynEvents));
  });
  t('один и тот же шрам не отдаётся роду дважды', () => {
    const m4 = createMemory();
    remember(m4, 'famine', 10);
    const s4 = makeSim({ day: 10, mem: m4 });
    const a = dynastyLinks(s4);
    s4.linkDynasty = a.flags.memory;
    s4.day = 11;
    const b = dynastyLinks(s4);
    ok(a.flags.dynEvents.length === 1, `в первый день ${a.flags.dynEvents.length}`);
    ok(b.flags.dynEvents.length === 0, `во второй день ${b.flags.dynEvents.length}`);
  });
  t('тяжесть беды передаётся долей, а не флагом', () => {
    const light = createMemory(); remember(light, 'famine', 10);
    const heavy = createMemory(); remember(heavy, 'famine', 10, { scale: 2 });
    const a = dynastyLinks(makeSim({ day: 10, mem: light })).flags.dynEvents[0];
    const b = dynastyLinks(makeSim({ day: 10, mem: heavy })).flags.dynEvents[0];
    ok(b.scale > a.scale, `${b.scale} <= ${a.scale}`);
  });
}

console.log('\n--- Обратно: сильная знать связывает роду руки ---');
{
  const free = makeSim({ factions: { nobles: NOBLE_VETO - 5 } });
  const lock = makeSim({ factions: { nobles: NOBLE_VETO + 5 } });
  t('при обычной знати наследника назначить можно', () => ok(canNameHeirNow(free).free, 'заперто'));
  t('при очень довольной знати — нельзя', () => ok(!canNameHeirNow(lock).free, 'свободно'));
  t('отказ объяснён и назван выход', () => {
    const r = canNameHeirNow(lock);
    ok(/старшинств/i.test(r.reason) && /Выход/i.test(r.reason), r.reason);
  });
  t('запрет виден в отчёте связи', () => {
    const out = dynastyLinks(lock);
    ok(out.flags.heirLock === true && out.flags.heirLockReason.length > 20, JSON.stringify(out.flags));
  });
  t('heirVeto работает и на голом снимке',
    () => ok(!heirVeto({ factions: { nobles: 100 } }).free, 'не заперто'));
}

console.log('\n--- Один день считается один раз ---');
{
  const sim = makeSim({ legitimacy: 0, factions: { nobles: 5, military: 5 } });
  run(sim, 40);
  const plotBefore = sim.linkDynasty.plot;
  const a = dynastyLinks(sim);
  const b = dynastyLinks(sim);
  t('повторный вызов в те же сутки не двигает заговор',
    () => near(b.flags.memory.plot, a.flags.memory.plot, 1e-9, 'заговор'));
  t('и не копит его сверх одного шага',
    () => ok(Math.abs(a.flags.memory.plot - plotBefore) <= PLOT_STEP_MAX + 1e-9, 'шаг'));
  t('повторный вызов не рассказывает то же самое второй раз',
    () => ok(b.events.length === 0, JSON.stringify(b.events.map(e => e.text))));
  t('но поправки возвращаются те же: панель среди дня видит сегодняшние числа',
    () => near(b.mods.stability, a.mods.stability, 1e-9, 'стабильность'));
  t('и удары по законности не отдаются роду дважды', () => {
    const m = createMemory(); remember(m, 'plague', 5);
    const s = makeSim({ day: 5, mem: m });
    const x = dynastyLinks(s); s.linkDynasty = x.flags.memory;
    const y = dynastyLinks(s);
    ok(x.flags.dynEvents.length === 1 && y.flags.dynEvents.length === 0,
      `${x.flags.dynEvents.length} / ${y.flags.dynEvents.length}`);
  });
}

console.log('\n--- Модуль ничего не мутирует ---');
{
  const sim = makeSim({ legitimacy: 12, court: 2, foodDays: 1, traits: ['cruel'], interregnum: 5, factions: { nobles: 10 } });
  const m = createMemory(); remember(m, 'shame', sim.day);
  sim.linkMemory = m;
  const before = JSON.stringify({ d: sim.dynasty, p: sim.politics, r: sim.res, l: sim.linkDynasty, mem: sim.linkMemory });
  dynastyLinks(sim);
  const after = JSON.stringify({ d: sim.dynasty, p: sim.politics, r: sim.res, l: sim.linkDynasty, mem: sim.linkMemory });
  t('снимок sim до и после совпадает слепок в слепок', () => ok(before === after, 'sim изменён'));
  t('память связи возвращается новым объектом, а не той же ссылкой', () => {
    const out = dynastyLinks(sim);
    ok(out.flags.memory !== sim.linkDynasty, 'вернулась та же ссылка');
  });
}

console.log('\n--- Круг сохранения ---');
{
  const sim = makeSim({ legitimacy: 5, factions: { nobles: 5, military: 5 } });
  run(sim, 50);
  const saved = JSON.parse(JSON.stringify(serializeDynastyLink(sim.linkDynasty)));
  const back = restoreDynastyLink(saved);
  t('записали и прочитали — состояние совпало',
    () => ok(JSON.stringify(back) === JSON.stringify(sim.linkDynasty),
      `${JSON.stringify(back)}\n≠\n${JSON.stringify(sim.linkDynasty)}`));
  t('прогон после загрузки совпадает с прогоном без неё', () => {
    const a = makeSim({ day: sim.day, legitimacy: 5, factions: { nobles: 5, military: 5 }, link: sim.linkDynasty });
    const b = makeSim({ day: sim.day, legitimacy: 5, factions: { nobles: 5, military: 5 }, link: back });
    run(a, 20); run(b, 20);
    ok(JSON.stringify(a.linkDynasty) === JSON.stringify(b.linkDynasty), 'разошлось');
  });
  t('старый сейв без поля не роняет модуль', () => {
    const L = restoreDynastyLink(undefined);
    ok(L.plot === 0 && L.day === -1 && Array.isArray(L.seen), JSON.stringify(L));
  });
  t('битый файл не роняет модуль', () => {
    for (const junk of [null, 0, 'ъ', [], { plot: 'много', stage: {}, seen: 'нет', lastSaid: 7, coupCd: NaN }]) {
      const L = restoreDynastyLink(junk);
      ok(Number.isFinite(L.plot) && Number.isFinite(L.stage) && Array.isArray(L.seen),
        `на ${JSON.stringify(junk)} вышло ${JSON.stringify(L)}`);
    }
  });
  t('заговор из битого файла не выходит за свои границы', () => {
    const L = restoreDynastyLink({ plot: 1e9, stage: 99 });
    ok(L.plot === PLOT_MAX && L.stage === 3, JSON.stringify(L));
  });
  t('связь переживает мусор вместо состояния рода', () => {
    const s = makeSim({});
    s.dynasty = { legitimacy: 'много', court: null, claimants: 'нет', interregnum: NaN };
    const out = dynastyLinks(s);
    ok(Number.isFinite(out.mods.stability), JSON.stringify(out.mods));
  });
}

console.log('\n--- Панель ---');
{
  const sim = makeSim({ legitimacy: 20, court: 2, traits: ['cruel'], factions: { nobles: 20 } });
  run(sim, 40);
  const b = dynastyLinkBreakdown(sim);
  t('в разборе есть строки по сословиям', () => ok(b.rows.length > 0, JSON.stringify(b)));
  t('в разборе назван заговор и способ выйти',
    () => ok(typeof b.wayOut === 'string' && b.wayOut.length > 20, b.wayOut));
  t('есть готовый текст для игрока', () => ok(typeof b.text === 'string' && b.text.length > 10, b.text));
  t('разбор не двигает память связи', () => {
    const snap = JSON.stringify(sim.linkDynasty);
    dynastyLinkBreakdown(sim);
    ok(snap === JSON.stringify(sim.linkDynasty), 'память сдвинулась');
  });
  t('сытость считается той же мерой, что в других связях',
    () => near(fedShare({ foodDays: 3 }), 0.5, 1e-9, 'доля сытости'));
}

console.log('\n--- На настоящей симуляции ---');
{
  const sim = new Simulation(11, { startEra: 4 });
  for (let d = 0; d < 60; d++) sim.tick(1);
  t('связь работает на живой партии без рода в sim', () => {
    const out = dynastyLinks(sim);
    ok(out && out.mods && Number.isFinite(out.mods.stability), JSON.stringify(out && out.mods));
  });
  t('связь работает на живой партии с родом', () => {
    sim.dynasty = fakeDynasty({ legitimacy: 25 });
    sim.linkDynasty = createDynastyLink();
    const out = dynastyLinks(sim);
    ok(out.mods.estates.nobles < 0, JSON.stringify(out.mods.estates));
  });
  t('живая партия не изменена связью', () => {
    const before = JSON.stringify(sim.politics.state);
    dynastyLinks(sim);
    ok(before === JSON.stringify(sim.politics.state), 'politics изменён');
  });
  t('Math.random в модуле не вызывается (иначе ломались бы сейвы)', () => {
    const src = readFileSync(new URL('../src/core/systems/link_dynasty.js', import.meta.url), 'utf8');
    ok(!/Math\.random\s*\(/.test(src), 'найден вызов Math.random');
  });
  t('связь вообще не берёт случайность: ни своего rng, ни sim.rng', () => {
    const src = readFileSync(new URL('../src/core/systems/link_dynasty.js', import.meta.url), 'utf8');
    // Комментарии срезаются ПЕРЕД поиском. Первая версия проверки читала весь
    // файл целиком и падала на собственной шапке модуля, где словами написано
    // «Ни Math.random, ни sim.rng» — то есть ровно на обещании, которое она
    // сторожит. Сторож обязан смотреть на код, а не на прозу о коде.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Заговор обязан быть считаемым: игрок видит срок и успевает.
    ok(!/\brng\b\s*\./.test(code), 'найдено обращение к rng');
  });
}

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
if (fail) process.exit(1);
