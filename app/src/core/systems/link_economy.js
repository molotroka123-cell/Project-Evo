// core/systems/link_economy.js — СВЯЗИ: деньги ↔ сословия ↔ власть.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. wire_production.js уже собирает налоги, ведёт займы, печатает
// монету и считает инфляцию. wire_politics.js уже держит пять сословий с
// одобрением и стабильность. Между ними не было НИ ОДНОЙ линии: можно было
// задрать подушный налог до 90%, объявить дефолт и обесценить монету втрое —
// сословия этого просто не замечали, потому что одобрение двигают только законы.
// Здесь проведены связи, и обратные тоже.
//
// ЧТО ИМЕННО СВЯЗАНО:
//   1. ставки четырёх налогов → одобрение сословий, у каждого своя чувствительность
//      (подушный бьёт простолюдинов, торговый — купцов, земельный — знать);
//   2. долг, проценты и кредитная история → доверие к власти (стабильность);
//   3. задержка жалования → военные и чиновники, и снова стабильность;
//   4. инфляция → недовольство горожан; дефляция → отдельно по купцам;
//   5. дефолт → обвал одобрения и тревога остальных кредиторов;
//   6. ОБРАТНО: злые купцы/простолюдины/знать → хуже собираемость налогов.
//      Жадность окупается хуже, чем обещает кривая Лаффера, и realTaxOptimum()
//      показывает игроку, где настоящий пик сбора.
//
// ЧЕГО ЗДЕСЬ НЕТ. Ни одного нового источника денег, счастья или одобрения «просто
// так». Всё, что возвращается, выведено из уже существующего состояния. Ничего
// не дублируется: например, дефолт уже сам роняет стабильность и отношения с
// тем, кому не заплатили, внутри economy.js — здесь только то, чего там нет
// (остальные кредиторы и реакция сословий).
//
// ПРАВИЛА. Функции ЧИСТЫЕ: читают sim, ничего не меняют. Math.random не
// используется вовсе — здесь нет случайности, и потому связи одинаковы в сейве
// и после загрузки.
//
// ПОТОЛОК И ВЫХОД. Каждая петля ограничена: одобрение падает не ниже уровня,
// заданного бременем (а не в ноль), собираемость не ниже половины, стабильность
// теряет не больше 0.8 в день. Снял налоги, погасил долг — и родное притяжение
// одобрения к 50 из politics.js вытянет сословия обратно. Спирали смерти нет.

import { TAX_KINDS, lafferYield, clamp } from './economy.js';
import { SOCIAL_FACTIONS, FACTION_ANGRY } from './politics.js';

export const ESTATES = Object.keys(SOCIAL_FACTIONS);   // nobles, clergy, merchants, commons, military

// ───────────────────────── Настройки связей ─────────────────────────

// Ставка, которую сословия считают обычным тяглом. Ниже неё налог не злит
// никого. Без этого коридора игрок наказан уже за то, что вообще собирает
// деньги: стартовые ставки (подушный 0.15, земельный и торговый 0.1) сразу
// давали бы минус, и «спокойного состояния» в игре просто не существовало бы.
export const TAX_FREE = 0.20;

// Кто как чувствует превышение над тяглом. Веса — доля бремени, которая
// достаётся сословию; сумма по столбцу больше единицы, потому что один налог
// задевает нескольких. Отрицательное число значит «сословию это нравится»:
// налог на роскошь простолюдины считают справедливым.
export const TAX_BITE = {
  commons:   { poll: 1.00, land: 0.50, trade: 0.25, luxury: -0.20 },
  merchants: { poll: 0.10, land: 0.10, trade: 1.20, luxury:  0.50 },
  nobles:    { poll: 0.05, land: 1.00, trade: 0.15, luxury:  0.80 },
  clergy:    { poll: 0.35, land: 0.40, trade: 0.10, luxury:  0.30 },
  military:  { poll: 0.25, land: 0.10, trade: 0.05, luxury:  0.00 },
};

// Долг казны. Купцы видят книги и считают лучше всех, знать даёт под залог,
// военные боятся, что не заплатят им, простолюдинам почти всё равно.
export const DEBT_BITE = { merchants: 0.60, nobles: 0.35, military: 0.30, clergy: 0.20, commons: 0.10 };
// Испорченная кредитная история — это уже не про суммы, а про слово власти.
export const CREDIT_BITE = { merchants: 0.50, nobles: 0.30, clergy: 0.15, military: 0.15, commons: 0.10 };
// Инфляция бьёт по тем, у кого доход фиксированный: подёнщик и солдат получают
// вчерашние деньги за сегодняшний хлеб. У знати земля, она дорожает вместе с ним.
export const INFL_BITE = { commons: 1.00, military: 0.60, clergy: 0.50, merchants: 0.30, nobles: 0.10 };
// Дефляция — беда обратного знака: долги тяжелеют, товар не продаётся. Достаётся
// купцам и рантье-знати, а простолюдинам дешёвый хлеб скорее в радость.
export const DEFL_BITE = { merchants: 0.80, nobles: 0.40, commons: -0.15, clergy: 0.00, military: 0.00 };
// Задержка жалования — прежде всего про войско и чиновников.
export const ARREARS_BITE = { military: 1.00, commons: 0.30, nobles: 0.20, clergy: 0.10, merchants: 0.05 };
// Дефолт: разовый удар в день объявления. Купцы теряют вложенное, знать —
// доверие, войско — уверенность в жалованье.
export const DEFAULT_SHOCK = { merchants: -18, nobles: -10, military: -6, clergy: -4, commons: -3 };
// Прочие кредиторы после дефолта: отношения падают на столько. Тот, кому именно
// не заплатили, уже получил −25 внутри economy.js — его здесь нет.
export const DEFAULT_REL = -8;

// Насколько сильно полное бремя (давление 1.0) утаскивает одобрение вниз от 50.
// 36 подобрано так, чтобы конфискационные ставки уводили сословие в «злые»
// (< FACTION_ANGRY = 25), а умеренные — только настораживали.
export const APPROVAL_SPAN = 36;
// Пол одобрения от денег: даже разорённое сословие не опускается ниже 8.
// Ноль означал бы «отсюда не выбраться», а выход должен быть всегда.
export const APPROVAL_FLOOR = 8;
// Скорость подхода к уровню бремени: 4% разрыва в день, половина пути за ~17
// дней. Быстрее — и налоговая реформа била бы как удар, медленнее — игрок не
// успевал бы связать причину со следствием.
export const APPROACH = 0.04;
// Потолок дневного шага: одобрение не двигается быстрее чем на 0.8 в сутки.
// Без потолка резкая реформа сдвигала бы сословие на 2 пункта за сутки, и
// игрок видел бы не связь, а рывок.
export const MAX_STEP = 0.8;

// Обратная связь: во сколько раз хуже собирается налог при злых сословиях.
// Купцы прячут оборот, простолюдины бегут в леса, знать «забывает» переслать
// подать со своих земель — отсюда и разные веса.
const COLLECT_MERCH = 0.45, COLLECT_COMMONS = 0.28, COLLECT_NOBLES = 0.18;
// Степень 0.7 (а не 1) — намеренно: первые пункты недовольства стоят казне
// дороже последних. Прятать оборот начинают сразу, как только стало обидно, а
// у совсем озлобленных прятать уже почти нечего. Именно эта вогнутость и
// сдвигает настоящий пик сбора заметно ниже книжного пика Лаффера.
const COLLECT_POW = 0.7;
// Пол собираемости: половину казна возьмёт даже у ненавидящей страны — силой.
export const COLLECT_FLOOR = 0.50;
// Довольные купцы ведут дела открыто и платят охотнее. Небольшая награда, чтобы
// у петли был не только штрафной конец.
export const COLLECT_BONUS = 0.10;

// Потолки прочего.
export const STAB_WORST = -0.8;    // худший дневной штраф к стабильности от денег
const STAB_HEALTHY = 0.15;  // награда за казну без долгов и с чистой репутацией
export const HAPPY_WORST = -10;

// Пик кривой Лаффера ищем перебором по самой функции, а не константой: поправят
// формулу в economy.js — отметка уедет вместе с ней.
export const LAFFER_PEAK = (() => {
  let best = 0, bv = -1;
  for (let i = 0; i <= 100; i++) {
    const v = lafferYield(i / 100);
    if (v > bv) { bv = v; best = i / 100; }
  }
  return best;
})();

const r3 = (v) => Math.round(v * 1000) / 1000;
const zeroApproval = () => Object.fromEntries(ESTATES.map(f => [f, 0]));

// ───────────────────────── Чтение мира ─────────────────────────

// Экономика лежит в sim.industry.eco, а wire_production ставит на неё синоним
// sim.economy. Берём любой — модуль должен работать и в обрезанном тесте.
function pickEco(sim) {
  if (!sim) return null;
  return (sim.industry && sim.industry.eco) || sim.economy || null;
}
function pickPolState(sim) {
  if (!sim || !sim.politics) return null;
  return sim.politics.state || null;
}
function pickReport(sim, eco) {
  if (sim && sim.industry && sim.industry.ecoReport) return sim.industry.ecoReport;
  return (eco && typeof eco.report === 'function') ? eco.report() : null;
}
function factionName(sim, fid) {
  if (fid === 'merchants') return 'Купеческие дома';
  const f = (sim && typeof sim.faction === 'function') ? sim.faction(fid) : null;
  return (f && f.def && f.def.name) ? f.def.name : String(fid);
}

// ───────────────────────── Давления ─────────────────────────

// Превышение ставки над тяглом, приведённое к 0..1 и загнутое степенью 1.3 —
// той же, что в taxPain() из economy.js. Смысл степени: 60% злят не вдвое
// сильнее 30%, а заметно больше — грабёж чувствуется нелинейно.
function taxExcess(rate) {
  const over = clamp(((rate || 0) - TAX_FREE) / (1 - TAX_FREE), 0, 1);
  return Math.pow(over, 1.3);
}

// Налоговое бремя для одного сословия при заданных ставках.
export function taxPressureFor(estate, rates) {
  const bite = TAX_BITE[estate];
  if (!bite) return 0;
  let sum = 0;
  for (const k of TAX_KINDS) sum += bite[k] * taxExcess(rates ? rates[k] : 0);
  return sum;
}

// Всё, что давит на сословия помимо налогов: долг, репутация, инфляция, жалование.
// Отдельной функцией — её же использует прогноз realTaxOptimum().
export function moneyPressures(sim) {
  const eco = pickEco(sim);
  if (!eco) return { debt: 0, credit: 0, infl: 0, defl: 0, arrears: 0, debtTotal: 0, debtRatio: 0, priceLevel: 1, arrearsDays: 0, creditVal: 50 };

  const rep = pickReport(sim, eco);
  const dailyTax = (rep && rep.taxes && rep.taxes.total) ? rep.taxes.total : 0;
  const debtTotal = typeof eco.debtTotal === 'function' ? eco.debtTotal() : 0;
  // Долг меряется не в монетах, а в месяцах дохода: 100🪙 для деревни — петля,
  // для империи — мелочь. Слагаемое 40 не даёт делить на ноль при нулевых
  // налогах и заодно означает «казна что-то стоит и без сборов».
  const monthly = dailyTax * 30 + 40;
  const debtRatio = debtTotal / monthly;
  // До одного месячного дохода долг никого не тревожит; три месячных — предел.
  const debt = clamp((debtRatio - 1) / 2, 0, 1);

  const creditVal = typeof eco.credit === 'number' ? eco.credit : 50;
  // Стартовая история — 50, поэтому порог тревоги 45: пока не сорвался ни один
  // платёж, доверие не страдает.
  const credit = clamp((45 - creditVal) / 45, 0, 1);

  const priceLevel = typeof eco.priceLevel === 'number' ? eco.priceLevel : 1;
  // Порог 1.8 взят не с потолка. Индекс цен в economy.js живёт в диапазоне
  // 0.6…3.0, растущая держава естественно держит его в районе 1.3–1.6, а
  // перегревом сама экономика считает 1.45. Ропот начинается заметно позже
  // перегрева — там, где цены выросли почти вдвое и это уже не рост, а порча
  // монеты (чеканка из воздуха или казна, которая пухнет без производства).
  // Полное давление — на потолке индекса 3.0: дальше монета просто мертва.
  const infl = clamp((priceLevel - 1.8) / 1.2, 0, 1);
  const defl = clamp((0.85 - priceLevel) / 0.25, 0, 1);

  const arrearsDays = typeof eco.arrears === 'number' ? eco.arrears : 0;
  const arrears = clamp(arrearsDays / 10, 0, 1);

  return { debt, credit, infl, defl, arrears, debtTotal, debtRatio, priceLevel, arrearsDays, creditVal };
}

// Итоговое давление на сословие. Возвращает и число, и разбор по причинам —
// игрок обязан прочитать словами, почему его не любят.
export function estatePressure(estate, rates, base) {
  const rows = [];
  const push = (ru, v) => { if (Math.abs(v) > 0.005) rows.push({ ru, v: r3(v) }); };

  const bite = TAX_BITE[estate] || {};
  let tax = 0;
  for (const k of TAX_KINDS) {
    const part = bite[k] * taxExcess(rates ? rates[k] : 0);
    tax += part;
    if (Math.abs(part) > 0.005) push(`${TAX_RU[k]} ${Math.round((rates[k] || 0) * 100)}%`, part);
  }
  const debt = (DEBT_BITE[estate] || 0) * base.debt;
  const credit = (CREDIT_BITE[estate] || 0) * base.credit;
  const infl = (INFL_BITE[estate] || 0) * base.infl;
  const defl = (DEFL_BITE[estate] || 0) * base.defl;
  const arrears = (ARREARS_BITE[estate] || 0) * base.arrears;
  push('Долг казны', debt);
  push('Слово казны нарушено', credit);
  push('Дороговизна', infl);
  push('Застой цен', defl);
  push('Жалование задержано', arrears);

  // Верхний предел 1.4 — чуть выше единицы, чтобы «всё сразу плохо» отличалось
  // от «плохо что-то одно», но не уводило одобрение ниже пола.
  const total = clamp(tax + debt + credit + infl + defl + arrears, -0.25, 1.4);
  return { total, rows, tax };
}

const TAX_RU = { poll: 'Подушный', land: 'Земельный', trade: 'Торговый', luxury: 'На роскошь' };

// Уровень, к которому бремя тянет одобрение. Не «сколько отнять», а «где
// сословие успокоится» — отсюда и берётся потолок петли.
export function steadyApproval(pressure) {
  return clamp(50 - APPROVAL_SPAN * pressure, APPROVAL_FLOOR, 62);
}

// ───────────────────────── Собираемость ─────────────────────────

// Обратная связь: одобрение → доля налога, которая реально доходит до казны.
export function collectionMult(factions) {
  const gap = (v) => Math.pow(clamp((50 - (v == null ? 50 : v)) / 50, 0, 1), COLLECT_POW);
  const rows = [];
  let m = 1;
  const mp = gap(factions.merchants) * COLLECT_MERCH;
  const cp = gap(factions.commons) * COLLECT_COMMONS;
  const np = gap(factions.nobles) * COLLECT_NOBLES;
  if (mp > 0.001) rows.push({ ru: 'Купцы прячут оборот', v: r3(-mp) });
  if (cp > 0.001) rows.push({ ru: 'Простолюдины уходят от переписи', v: r3(-cp) });
  if (np > 0.001) rows.push({ ru: 'Знать «забывает» переслать подать', v: r3(-np) });
  m -= mp + cp + np;
  // Награда за доверие: купцы выше 65 постепенно перестают прятаться.
  const good = clamp(((factions.merchants == null ? 50 : factions.merchants) - 65) / 35, 0, 1) * COLLECT_BONUS;
  if (good > 0.001) rows.push({ ru: 'Купцы ведут дела открыто', v: r3(good) });
  m += good;
  return { mult: clamp(r3(m), COLLECT_FLOOR, 1 + COLLECT_BONUS), rows };
}

// ───────────────────────── Главная функция ─────────────────────────

export function economyLinks(sim) {
  const out = {
    mods: { approval: zeroApproval(), stability: 0, happy: 0, taxMult: 1, gold: 0 },
    reasons: { approval: {}, stability: [], taxMult: [] },
    events: [],
    flags: {
      quiet: true, defaultToday: false, creditorsAlarmed: [],
      collectionCrisis: false, healthyTreasury: false, angryByMoney: [],
    },
  };
  const eco = pickEco(sim);
  const st = pickPolState(sim);
  if (!eco || !st || !st.factions) return out;   // система не установлена — связывать нечего

  const day = Math.max(0, Math.round(sim.day || 0));
  const rates = (typeof eco.taxRates === 'object' && eco.taxRates) ? eco.taxRates : {};
  const base = moneyPressures(sim);
  const rep = pickReport(sim, eco);

  // --- Дефолт: ищем его в СЕГОДНЯШНЕМ отчёте экономики -------------------
  // Своей памяти у чистой функции нет, а событие о дефолте появляется в отчёте
  // ровно один раз — этого достаточно, чтобы удар случился однократно.
  const freshReport = rep && (rep.day == null || rep.day === day);
  const defaulted = !!(freshReport && Array.isArray(rep.events)
    && rep.events.some(e => e && typeof e.text === 'string' && /дефолт/i.test(e.text)));
  out.flags.defaultToday = defaulted;

  // --- Одобрение сословий -------------------------------------------------
  for (const fid of ESTATES) {
    const cur = typeof st.factions[fid] === 'number' ? st.factions[fid] : 50;
    const pr = estatePressure(fid, rates, base);
    const target = steadyApproval(pr.total);
    let d = 0;
    if (pr.total > 0.01) {
      // Только вниз и только до уровня бремени. Если сословие уже ниже — деньги
      // его больше не топят: это и есть потолок петли.
      d = clamp((target - cur) * APPROACH, -MAX_STEP, 0);
    } else if (pr.total < -0.01) {
      // Налог на роскошь простолюдинам в радость, но радость маленькая.
      d = clamp((target - cur) * APPROACH, 0, 0.15);
    }
    if (defaulted) d += DEFAULT_SHOCK[fid] || 0;
    out.mods.approval[fid] = r3(d);
    if (pr.rows.length) out.reasons.approval[fid] = pr.rows;
    if (pr.total > 0.01) out.flags.quiet = false;
    // Сословие, которое деньги уже загнали в «злые» либо вот-вот загонят.
    if (target < FACTION_ANGRY) out.flags.angryByMoney.push(fid);
  }
  if (defaulted) {
    out.flags.quiet = false;
    out.events.push({
      text: 'Дефолт казны: вложенное сгорело. Купцы, знать и войско отвернулись от власти.',
      type: 'bad',
    });
    // Тому, кому не заплатили, отношения уронил сам economy.js. Здесь —
    // остальные заимодавцы: чужой дефолт видно из любой столицы.
    const loans = Array.isArray(eco.loans) ? eco.loans : [];
    const seen = new Set();
    for (const L of loans) {
      if (!L || L.lender === 'merchants' || seen.has(L.lender)) continue;
      seen.add(L.lender);
      out.flags.creditorsAlarmed.push({ fid: L.lender, dRel: DEFAULT_REL, name: factionName(sim, L.lender) });
    }
    if (out.flags.creditorsAlarmed.length) {
      out.events.push({
        text: `Остальные кредиторы (${out.flags.creditorsAlarmed.map(c => c.name).join(', ')}) больше не верят слову казны.`,
        type: 'bad',
      });
    }
  }

  // --- Стабильность: доверие к власти как к плательщику --------------------
  let stab = 0;
  const srows = out.reasons.stability;
  if (base.debt > 0.01) {
    const v = -0.30 * base.debt;   // долг сам по себе ещё не бунт, но власть слабеет
    stab += v; srows.push({ ru: `Долг казны (${Math.round(base.debtRatio * 10) / 10} мес. дохода)`, v: r3(v) });
  }
  if (base.credit > 0.01) {
    const v = -0.25 * base.credit;  // «слово казны» — то, чем держава платит без денег
    stab += v; srows.push({ ru: `Испорченная кредитная история (${Math.round(base.creditVal)})`, v: r3(v) });
  }
  if (base.arrears > 0.01) {
    const v = -0.35 * base.arrears; // непла́ченому войску порядок держать нечем
    stab += v; srows.push({ ru: `Жалование задержано (${base.arrearsDays} дн.)`, v: r3(v) });
  }
  const healthy = base.debtTotal <= 0 && base.creditVal >= 70 && base.arrearsDays === 0;
  if (healthy) {
    stab += STAB_HEALTHY;
    srows.push({ ru: 'Казна без долгов, долги возвращались вовремя', v: STAB_HEALTHY });
    out.flags.healthyTreasury = true;
  }
  out.mods.stability = r3(clamp(stab, STAB_WORST, STAB_HEALTHY));
  if (Math.abs(out.mods.stability) > 0.001) out.flags.quiet = false;

  // --- Счастье: дороговизна и дешевизна ------------------------------------
  // Налоговое бремя в счастье уже учтено happyMod() экономики — второй раз
  // его здесь нет. Инфляции в том расчёте не было, она наша.
  let happy = -6 * base.infl + 2 * base.defl - (defaulted ? 4 : 0);
  out.mods.happy = Math.round(clamp(happy, HAPPY_WORST, 2));
  if (out.mods.happy !== 0) out.flags.quiet = false;

  // --- Обратная связь: сколько налога дойдёт до казны ----------------------
  const col = collectionMult(st.factions);
  out.mods.taxMult = col.mult;
  out.reasons.taxMult = col.rows;
  out.flags.collectionCrisis = col.mult < 0.75;
  // Поправка считается только по СЕГОДНЯШНЕМУ сбору. Если экономика ещё не
  // ходила в этот день, поправлять нечего — иначе вчерашний недобор списался бы
  // с казны второй раз.
  const dailyTax = (freshReport && rep.taxes && rep.taxes.total) ? rep.taxes.total : 0;
  // economy.js уже начислил полный сбор в res.gold. Возвращаем поправку —
  // отрицательную при недоборе, положительную при доверии купцов.
  out.mods.gold = r3(dailyTax * (col.mult - 1));
  if (Math.abs(col.mult - 1) > 0.001) out.flags.quiet = false;

  // --- События: раз в декаду, чтобы не превращать журнал в ленту цифр -------
  if (day > 0 && day % 10 === 0) {
    if (col.mult < 0.9) {
      out.events.push({
        text: `Мытари возвращаются полупустыми: до казны дошло ${Math.round(col.mult * 100)}% налога — ${col.rows[0] ? col.rows[0].ru.toLowerCase() : 'сословия недовольны'}.`,
        type: 'warn',
      });
    }
    if (base.infl > 0.2) {
      out.events.push({
        text: `Монета дешевеет: цены ×${Math.round(base.priceLevel * 100) / 100}. Горожане ропщут на дороговизну.`,
        type: 'warn',
      });
    }
    if (base.defl > 0.3) {
      out.events.push({ text: 'Цены стоят на месте: купцы жалуются, что товар не берут, а долги тяжелеют.', type: 'warn' });
    }
    if (base.debt > 0.3) {
      out.events.push({
        text: `Долг казны ${Math.round(base.debtTotal)}🪙 — около ${Math.round(base.debtRatio * 10) / 10} месяцев дохода. Заимодавцы шепчутся.`,
        type: 'warn',
      });
    }
    // Самое обиженное налогами сословие — одной строкой, а не пятью.
    let worst = null, wv = 0.35;
    for (const fid of ESTATES) {
      const p = estatePressure(fid, rates, base).tax;
      if (p > wv) { wv = p; worst = fid; }
    }
    if (worst) {
      out.events.push({ text: `${SOCIAL_FACTIONS[worst].ru} стонут от поборов: одобрение падает.`, type: 'warn' });
    }
  }
  if (base.arrearsDays >= 3 && day % 5 === 0) {
    out.events.push({
      text: `Жалование не платят ${base.arrearsDays} дн.: войско и чиновники теряют веру в казну.`,
      type: 'bad',
    });
  }
  if (healthy && day > 0 && day % 20 === 0) {
    out.events.push({ text: 'Казна без долгов, слово держат: доверие к власти крепнет.', type: 'good' });
  }
  if (out.events.length) out.flags.quiet = false;

  return out;
}

// ───────────────────────── Подсказка игроку ─────────────────────────

// Где на самом деле пик сбора с учётом того, что злые сословия прячут доход.
// Считается ТЕМИ ЖЕ формулами, что и дневная связь, — подсказка не может
// разойтись с механикой. Прочие давления (долг, инфляция) берутся текущие:
// в разорённой стране оптимум другой, чем в спокойной.
export function realTaxOptimum(sim, kind, steps = 100) {
  const eco = pickEco(sim);
  if (!eco || !TAX_KINDS.includes(kind)) return null;
  const rates = { ...(eco.taxRates || {}) };
  const base = moneyPressures(sim);

  const apprAt = (r) => {
    const test = { ...rates, [kind]: r };
    const appr = {};
    for (const fid of ESTATES) appr[fid] = steadyApproval(estatePressure(fid, test, base).total);
    return appr;
  };
  const yieldAt = (r) => lafferYield(r) * collectionMult(apprAt(r)).mult;

  let best = 0, bv = -1;
  // Со скольких процентов ставка загоняет хоть кого-то в «злые» — там начинается
  // саботаж ремесла (FACTION_DOMAIN в politics.js) и минус к стабильности.
  let angryAt = null;
  for (let i = 0; i <= steps; i++) {
    const r = i / steps;
    const v = yieldAt(r);
    if (v > bv) { bv = v; best = r; }
    if (angryAt === null && Object.values(apprAt(r)).some(a => a < FACTION_ANGRY)) angryAt = r3(r);
  }
  const atPeak = yieldAt(LAFFER_PEAK);
  const cur = yieldAt(rates[kind] || 0);
  return {
    kind, rate: r3(best), yield: r3(bv), angryAt,
    lafferPeak: LAFFER_PEAK, lafferPeakYield: r3(atPeak),
    // Насколько «книжный» пик Лаффера хуже настоящего: та самая цена жадности.
    greedLoss: r3(bv > 0 ? (bv - atPeak) / bv : 0),
    curRate: r3(rates[kind] || 0), curYield: r3(cur),
    better: bv > cur + 1e-9,
    text: best < LAFFER_PEAK - 1e-9
      ? `${TAX_RU[kind]}: по кривой Лаффера пик у ${Math.round(LAFFER_PEAK * 100)}%, но злые сословия прячут доход — казна возьмёт больше при ${Math.round(best * 100)}%.`
      : `${TAX_RU[kind]}: сословия уже на дне, собираемость ниже не станет — пик там же, где и по кривой Лаффера (${Math.round(best * 100)}%).`,
  };
}

// Разбор для панели: что именно давит на одно сословие и куда оно идёт.
export function explainEstate(sim, fid) {
  const eco = pickEco(sim), st = pickPolState(sim);
  if (!eco || !st || !TAX_BITE[fid]) return null;
  const base = moneyPressures(sim);
  const pr = estatePressure(fid, eco.taxRates || {}, base);
  const cur = typeof st.factions[fid] === 'number' ? st.factions[fid] : 50;
  const target = steadyApproval(pr.total);
  return {
    fid, ru: SOCIAL_FACTIONS[fid].ru, approval: r3(cur), target: r3(target),
    pressure: r3(pr.total), rows: pr.rows,
    angry: target < FACTION_ANGRY,
    text: pr.total <= 0.01
      ? `${SOCIAL_FACTIONS[fid].ru}: денежных обид нет.`
      : `${SOCIAL_FACTIONS[fid].ru}: бремя тянет одобрение к ${Math.round(target)}.`,
  };
}

/* ПОДКЛЮЧЕНИЕ

   Файл: app/src/core/systems/integrate.js

1) Импорт. ЯКОРЬ (строка уникальна в файле):
     import * as EMP from './wire_empire.js';
   ДОБАВИТЬ СРАЗУ ПОСЛЕ НЕЁ:
     import * as LEC from './link_economy.js';

2) Применение раз в сутки. ЯКОРЬ (строка уникальна в файле):
     EMP.empireNewDay(sim);
   ДОБАВИТЬ СРАЗУ ПОСЛЕ НЕЁ:
     applyEconomyLinks(sim);

3) В КОНЕЦ файла добавить функцию-применитель (модуль сам ничего не меняет):

export function applyEconomyLinks(sim) {
  if (!sim.politics || !sim.industry) return null;
  const L = LEC.economyLinks(sim);
  sim.sys.ecoLinks = L;                       // для HUD: панель читает готовый разбор

  // Одобрение сословий: дневной сдвиг от налогов, долга и инфляции.
  const F = sim.politics.state.factions;
  for (const fid of Object.keys(F)) {
    F[fid] = Math.max(0, Math.min(100, F[fid] + (L.mods.approval[fid] || 0)));
  }
  // Стабильность: доверие к власти как к плательщику.
  const P = sim.politics.state;
  P.stability = Math.max(0, Math.min(100, P.stability + L.mods.stability));

  // Недобор налога: economy.js уже начислил полный сбор, здесь поправка.
  if (L.mods.gold !== 0) sim.res.gold = Math.max(0, sim.res.gold + L.mods.gold);

  // Дефолт: остальные кредиторы. Тому, кому не заплатили, отношения уронил
  // сам economy.js — второй раз его здесь нет.
  for (const c of L.flags.creditorsAlarmed) {
    if (typeof sim.adjustRel === 'function') sim.adjustRel(c.fid, c.dRel, 'Дефолт казны');
  }
  for (const e of L.events) sim.addLog(e.text, e.type === 'good' ? 'info' : e.type);
  if (L.flags.defaultToday) sim.addChronicle(`Казна объявила дефолт (день ${sim.day}).`);
  return L;
}

4) Счастье от дороговизны. ЯКОРЬ (строка уникальна в файле):
     return W.happyMod(sim.sys.winter) + IND.industryHappyMod(sim) + POL.politicsHappyMod(sim);
   ЗАМЕНИТЬ НА:
     return W.happyMod(sim.sys.winter) + IND.industryHappyMod(sim) + POL.politicsHappyMod(sim)
       + (sim.sys.ecoLinks ? sim.sys.ecoLinks.mods.happy : 0);

5) Для панели «Держава»/«Хозяйство» (по желанию, ничего не меняет):
     LEC.realTaxOptimum(sim, 'poll')   // где настоящий пик сбора и насколько он ниже Лаффера
     LEC.explainEstate(sim, 'merchants')  // почему купцы злы и к какому уровню идут
     sim.sys.ecoLinks.reasons          // готовые строки причин: одобрение, стабильность, сбор

   Сохранения трогать не нужно: модуль без состояния, всё выводится из sim.
*/
