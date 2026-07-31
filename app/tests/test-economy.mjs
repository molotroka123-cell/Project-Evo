// tests/test-economy.mjs — проверки макроэкономики (systems/economy.js).
// Запуск: node app/tests/test-economy.mjs
import {
  createEconomy, deserializeEconomy,
  lafferYield, taxPain, loanRate, scarcity, clamp,
} from '../src/core/systems/economy.js';
import { createRng } from '../src/core/rng.js';
import { MARKET_BASE } from '../src/core/data.js';

let okCount = 0, failCount = 0;
function check(name, cond) {
  if (cond) { okCount++; console.log('OK   ' + name); }
  else { failCount++; console.log('FAIL ' + name); }
}
function near(a, b, eps = 0.001) { return Math.abs(a - b) <= eps; }

// Фальшивый sim: ровно те поля, которые модуль читает у настоящего Simulation.
function makeSim(seed = 7, over = {}) {
  return {
    rng: createRng(seed),
    res: { food: 100, wood: 80, stone: 60, steel: 10, gold: 50, knowledge: 0 },
    villagers: Array.from({ length: 10 }, () => ({})),
    buildings: [{ done: true }, { done: true }, { done: true }],
    buildQueue: [],
    army: { soldiers: 4 },
    seasonIdx: 0, eraIndex: 2, day: 0,
    factions: [{ id: 'nord', alive: true }, { id: 'steppe', alive: true }],
    relations: { nord: 20, steppe: -30 },
    treaties: [],
    logs: [],
    addLog(t, ty) { this.logs.push({ t, ty }); },
    adjustRel(fid, d) { this.relations[fid] = (this.relations[fid] || 0) + d; },
    wealth() { return 120; },
    ...over,
  };
}

function runDays(econ, sim, n) {
  let rep = null;
  for (let i = 0; i < n; i++) { sim.day++; rep = econ.onNewDay(sim); }
  return rep;
}

function zeroTaxes(econ) {
  for (const k of ['poll', 'land', 'trade', 'luxury']) econ.setTaxRate(k, 0);
}

// ---------- 1. Чистые функции: Лаффер, недовольство, ставки, дефицит ----------

check('Лаффер: при ставке 0 сбор нулевой', lafferYield(0) === 0);
check('Лаффер: при ставке 100% сбор нулевой (все в тени)', lafferYield(1) === 0);
check('Лаффер: 45% собирает больше, чем 20%', lafferYield(0.45) > lafferYield(0.2));
check('Лаффер: 45% собирает больше, чем 90% (нисходящая ветвь)', lafferYield(0.45) > lafferYield(0.9));
check('Недовольство: высокий подушный злит сильнее низкого',
  taxPain({ poll: 0.8 }) > taxPain({ poll: 0.2 }) + 5);
check('Ставка займа: хорошая репутация дешевле плохой', loanRate(80, 50) < loanRate(-50, 50));
check('Ставка займа зажата в [0.05, 0.6]',
  loanRate(-200, 0) === 0.6 && loanRate(300, 100) === 0.05);
check('Дефицит зажат: scarcity в [0.25, 4]',
  scarcity(0.01) === 4 && scarcity(9999) === 0.25 && near(scarcity(10), 1));

// ---------- 2. Цены: старт, спрос/предложение, сглаживание ----------

{
  const econ = createEconomy();
  check('Стартовые цены равны базовым из data.js',
    near(econ.priceOf('food'), MARKET_BASE.food) && near(econ.priceOf('steel'), MARKET_BASE.steel));

  // Один день ценового шока: цель ~4x, но сглаживание пускает лишь малый шаг.
  const simShock = makeSim(3, { res: { food: 5, wood: 80, stone: 60, steel: 10, gold: 50 } });
  const e2 = createEconomy();
  runDays(e2, simShock, 1);
  const p1 = e2.priceOf('food');
  check('Сглаживание: за день цена сдвигается лишь частично (не скачет к цели)',
    p1 > MARKET_BASE.food && p1 < MARKET_BASE.food * 1.6);

  const simPoor = makeSim(3, { res: { food: 5, wood: 80, stone: 60, steel: 10, gold: 50 } });
  const simRich = makeSim(3, { res: { food: 400, wood: 80, stone: 60, steel: 10, gold: 50 } });
  const ePoor = createEconomy(), eRich = createEconomy();
  const repPoor = runDays(ePoor, simPoor, 10);
  runDays(eRich, simRich, 10);
  check('Нехватка еды задирает цену выше базовой в 1.5+ раза',
    ePoor.priceOf('food') > MARKET_BASE.food * 1.5);
  check('Изобилие еды опускает цену ниже базовой',
    eRich.priceOf('food') < MARKET_BASE.food);
  check('Цена при дефиците выше цены при изобилии',
    ePoor.priceOf('food') > eRich.priceOf('food'));
  check('Дефицит еды помечен в отчёте (запас < 3 дней)',
    repPoor.shortages.includes('food'));
  check('Дефицит еды бьёт по счастью (happyMod < 0)', ePoor.happyMod() < 0);
}

// ---------- 3. Налоги: Лаффер в сборе, недовольство, казна ----------

{
  const mk = (rate) => {
    const econ = createEconomy(); zeroTaxes(econ);
    econ.setTaxRate('poll', rate);
    const sim = makeSim(5);
    const rep = runDays(econ, sim, 1);
    return { econ, sim, rep };
  };
  const t0 = mk(0), t45 = mk(0.45), t95 = mk(0.95);
  check('Подушный 45% приносит золото, 0% — ничего',
    t45.rep.taxes.total > 1 && t0.rep.taxes.total === 0);
  check('Кривая Лаффера в сборе: 95% приносит меньше, чем 45%',
    t95.rep.taxes.total < t45.rep.taxes.total && t95.rep.taxes.total > 0);
  check('Собранный налог реально попал в казну',
    t45.sim.res.gold > t0.sim.res.gold + 2);
  check('Высокие налоги сильнее бьют по счастью',
    t95.econ.happyMod() < t45.econ.happyMod() && t45.econ.happyMod() < t0.econ.happyMod());
}

// ---------- 4. Содержание: расход золота, задержка жалования, мораль ----------

{
  const econ = createEconomy(); zeroTaxes(econ);
  const sim = makeSim(5);
  const rep = runDays(econ, sim, 1);
  // 4 солдата × 0.2 + 3 здания × 0.04 × 1.5 + 1 чиновник × 0.5 = 1.48
  check('Содержание списывается ежедневно (армия+здания+чиновники = 1.48)',
    near(rep.upkeep.need, 1.48) && near(sim.res.gold, 50 - 1.48));
  check('При полном жаловании мораль без штрафа', econ.moraleMod() === 0);

  const econ2 = createEconomy(); zeroTaxes(econ2);
  const sim2 = makeSim(5, { res: { food: 100, wood: 80, stone: 60, steel: 10, gold: 0 } });
  runDays(econ2, sim2, 3);
  check('Пустая казна: 3 дня задержки жалования → штраф морали −12',
    econ2.arrears === 3 && econ2.moraleMod() === -12);
  check('Задержка жалования снижает стабильность', econ2.stability < 70);
}

// ---------- 5. Займы: ставка, погашение, дефолт ----------

{
  const econ = createEconomy(); zeroTaxes(econ);
  const sim = makeSim(5, { res: { food: 100, wood: 80, stone: 60, steel: 10, gold: 200 } });
  const offerGood = econ.loanOffer(sim, 'nord', 100);   // rel +20
  const offerBad = econ.loanOffer(sim, 'steppe', 100);  // rel −30
  check('Заём у друга дешевле, чем у недруга, и всегда с процентом',
    offerGood.owed < offerBad.owed && offerGood.owed > 100);

  const r = econ.takeLoan(sim, { lender: 'merchants', amount: 50, days: 2 });
  check('Взятый заём сразу пополняет казну', r.ok && near(sim.res.gold, 250));
  const owed = r.loan.owed;
  check('Долг больше тела займа (набежал процент)', owed > 50);
  runDays(econ, sim, 2);
  // 250 − 2×1.48 (содержание) − долг
  check('В срок долг гасится автоматически, казна уменьшилась ровно на долг',
    econ.loans.length === 0 && near(sim.res.gold, 250 - 2 * 1.48 - owed, 0.02));
  check('Возврат долга улучшает кредитную историю', econ.credit === 55);
}

{
  const econ = createEconomy(); zeroTaxes(econ);
  const sim = makeSim(5);
  econ.takeLoan(sim, { lender: 'nord', amount: 100, days: 2 });
  sim.res.gold = 0; // казну растратили
  const stabBefore = econ.stability;
  runDays(econ, sim, 2);
  check('Дефолт: кредитная история рухнула на 25', econ.credit === 25);
  check('Дефолт: отношения с кредитором упали на 25', sim.relations.nord === 20 - 25);
  check('Дефолт: стабильность просела не меньше чем на 10', econ.stability <= stabBefore - 10);
  check('Дефолт попал в журнал событий', sim.logs.some(l => l.t.includes('Дефолт')));
}

// ---------- 6. Инфляция: печать денег обесценивает монету ----------

{
  const simCtl = makeSim(9), simMint = makeSim(9);
  const eCtl = createEconomy(), eMint = createEconomy();
  zeroTaxes(eCtl); zeroTaxes(eMint);
  eMint.mintGold(simMint, 400);
  let maxCtl = 0, maxMint = 0;
  for (let i = 0; i < 10; i++) {
    runDays(eCtl, simCtl, 1); runDays(eMint, simMint, 1);
    maxCtl = Math.max(maxCtl, eCtl.priceLevel);
    maxMint = Math.max(maxMint, eMint.priceLevel);
  }
  check('Печать 400🪙 разгоняет индекс цен выше 1.4', maxMint > 1.4);
  check('Без печати индекс цен остаётся около 1', maxCtl < 1.25);
  check('Инфляция задирает номинальные цены (еда дороже при том же запасе)',
    eMint.priceOf('food') > eCtl.priceOf('food') * 1.3);
}

// ---------- 7. Цены фракций и торговая маржа ----------

{
  const econ = createEconomy();
  const sim = makeSim(13);
  runDays(econ, sim, 5);
  const pn = econ.priceAt('nord', 'food'), ps = econ.priceAt('steppe', 'food');
  check('У фракций свои цены — они различаются', Math.abs(pn - ps) > 1e-6);
  let inBounds = true;
  for (const fid of ['nord', 'steppe']) for (const g of ['food', 'wood', 'stone', 'steel']) {
    const p = econ.priceAt(fid, g);
    const lo = MARKET_BASE[g] * 0.5 * econ.priceLevel, hi = MARKET_BASE[g] * 1.8 * econ.priceLevel;
    if (p < lo - 1e-9 || p > hi + 1e-9) inBounds = false;
  }
  check('Цены фракций в коридоре [0.5, 1.8] от базы с учётом инфляции', inBounds);
  check('Маржа = своя цена минус цена фракции',
    near(econ.tradeMargin('nord', 'steel'), econ.priceOf('steel') - econ.priceAt('nord', 'steel')));
}

// ---------- 8. Кризис: пузырь лопается ----------

{
  const econ = createEconomy();
  const sim = makeSim(11);
  runDays(econ, sim, 1);
  // Разогреваем рынок вручную через сейв: индекс 2.0, перегрев 7 дней, шальной приток золота.
  const snap = econ.serialize();
  snap.priceLevel = 2; snap.heat = 7; snap.incomeEma = 60; snap.incomeEmaSlow = 2; snap.lastGold = 0;
  econ.deserialize(snap);
  sim.res.gold = 100;
  const rep = runDays(econ, sim, 1);
  check('Перегрев 8-й день подряд → обвал (crash в отчёте)', rep.crash === true);
  check('Обвал сбивает индекс цен (~×0.7)', econ.priceLevel < 1.5);
  check('Обвал сжигает часть сбережений (−12%)', sim.res.gold < 100 * 0.93);
  check('После обвала рынок остывает (heat ушёл в минус)', econ.serialize().heat < 0);
}

// ---------- 9. Сейв/лоад и детерминизм ----------

{
  const simA = makeSim(21);
  const eA = createEconomy();
  runDays(eA, simA, 5);
  const snap = eA.serialize();
  const rngState = simA.rng.getState();

  const eB = deserializeEconomy(snap);
  const simB = makeSim(21, { res: JSON.parse(JSON.stringify(simA.res)), day: simA.day });
  simB.rng.setState(rngState);
  simB.relations = JSON.parse(JSON.stringify(simA.relations));

  const repA = runDays(eA, simA, 5);
  const repB = runDays(eB, simB, 5);
  check('Сейв/лоад: отчёты после загрузки совпадают день в день',
    JSON.stringify(repA) === JSON.stringify(repB));
  check('Сейв/лоад: казна и цены совпадают',
    near(simA.res.gold, simB.res.gold, 1e-9) && near(eA.priceOf('food'), eB.priceOf('food'), 1e-12));
  check('Сейв/лоад: полное состояние идентично',
    JSON.stringify(eA.serialize()) === JSON.stringify(eB.serialize()));
}

{
  const s1 = makeSim(5), s2 = makeSim(5);
  const e1 = createEconomy(), e2 = createEconomy();
  const r1 = runDays(e1, s1, 12), r2 = runDays(e2, s2, 12);
  check('Детерминизм: два прогона с одним сидом дают одинаковый мир',
    JSON.stringify(r1) === JSON.stringify(r2) && s1.res.gold === s2.res.gold);
}

console.log(`=== ${okCount} OK / ${failCount} FAIL ===`);
process.exit(failCount ? 1 : 0);
