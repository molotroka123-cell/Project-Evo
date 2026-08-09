// tests/test-link-economy.mjs — проверки связей «деньги ↔ сословия ↔ власть»
// (systems/link_economy.js). Запуск: node app/tests/test-link-economy.mjs
//
// Что здесь важно проверить и почему именно это:
//  * связь тянет в НУЖНУЮ сторону и по нужному сословию (подушный — по
//    простолюдинам, торговый — по купцам, земельный — по знати);
//  * у каждой петли есть ПОТОЛОК: дневной шаг, пол одобрения, пол собираемости,
//    предел штрафа к стабильности и счастью;
//  * в СПОКОЙНОМ состоянии (стартовые ставки, нет долга, монета здорова) нет
//    ни одной поправки — иначе игрок наказан просто за то, что играет;
//  * обратная связь считает деньги: недобор налога равен ровно сбор × (mult−1);
//  * подсказка об оптимуме не расходится с механикой.
import {
  economyLinks, realTaxOptimum, explainEstate,
  taxPressureFor, estatePressure, moneyPressures, steadyApproval, collectionMult,
  ESTATES, TAX_FREE, LAFFER_PEAK, MAX_STEP, APPROVAL_FLOOR, COLLECT_FLOOR, COLLECT_BONUS,
  STAB_WORST, HAPPY_WORST, DEFAULT_SHOCK,
} from '../src/core/systems/link_economy.js';
import { lafferYield } from '../src/core/systems/economy.js';
import { FACTION_ANGRY } from '../src/core/systems/politics.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let ok = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { ok++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

// Поддельный sim: ровно те поля, которые модуль читает у настоящего Simulation.
// Экономика подделана нарочно — так проверяются ЧИСЛА связей, а не поведение
// economy.js, у которого свой набор тестов.
const START_RATES = { poll: 0.15, land: 0.1, trade: 0.1, luxury: 0 };
function makeSim(o = {}) {
  const e = o.eco || {};
  const eco = {
    taxRates: { ...START_RATES, ...(e.taxRates || {}) },
    credit: e.credit ?? 50,
    priceLevel: e.priceLevel ?? 1,
    arrears: e.arrears ?? 0,
    loans: e.loans || [],
    debtTotal: () => e.debt ?? 0,
    report: () => ({ day: e.repDay ?? (o.day ?? 1), taxes: { total: e.tax ?? 10 }, events: e.events || [] }),
  };
  return {
    day: o.day ?? 1,
    res: { gold: 100 },
    factions: o.worldFactions || [],
    faction: (fid) => (o.worldFactions || []).find(f => f.id === fid) || null,
    politics: { state: { factions: { nobles: 55, clergy: 55, merchants: 55, commons: 55, military: 55, ...(o.approval || {}) }, stability: o.stability ?? 60 } },
    industry: { eco, ecoReport: null },
    economy: eco,
  };
}
const links = (o) => economyLinks(makeSim(o));

// ─────────────── 1. Спокойное состояние: поправок нет ───────────────
console.log('\n--- Спокойное состояние ---');
{
  const L = links({ day: 1 });
  t('спокойно: ни одно сословие не сдвинуто',
    ESTATES.every(f => L.mods.approval[f] === 0), JSON.stringify(L.mods.approval));
  t('спокойно: стабильность не тронута', L.mods.stability === 0, String(L.mods.stability));
  t('спокойно: счастье не тронуто', L.mods.happy === 0, String(L.mods.happy));
  t('спокойно: собираемость полная и казна не поправляется',
    L.mods.taxMult === 1 && L.mods.gold === 0, `${L.mods.taxMult} / ${L.mods.gold}`);
  t('спокойно: журнал молчит и поднят флаг quiet',
    L.events.length === 0 && L.flags.quiet === true);
  // Граница тягла: ровно TAX_FREE — ещё не поборы.
  const edge = links({ eco: { taxRates: { poll: TAX_FREE, land: TAX_FREE, trade: TAX_FREE, luxury: TAX_FREE } } });
  t(`ставка ровно ${TAX_FREE} — это ещё тягло, а не поборы`,
    ESTATES.every(f => edge.mods.approval[f] === 0), JSON.stringify(edge.mods.approval));
  const over = links({ eco: { taxRates: { poll: TAX_FREE + 0.05 } } });
  t('чуть выше тягла связь уже включается', over.mods.approval.commons < 0,
    String(over.mods.approval.commons));
}

// ─────────────── 2. Налоги бьют по своим сословиям ───────────────
console.log('\n--- Каждый налог бьёт по своему сословию ---');
{
  const poll = links({ eco: { taxRates: { poll: 0.6 } } }).mods.approval;
  t('подушный: простолюдинам хуже всех',
    poll.commons < poll.clergy && poll.commons < poll.merchants && poll.commons < poll.nobles,
    JSON.stringify(poll));
  t('подушный: знать почти не задета (в 3+ раза слабее простолюдинов)',
    Math.abs(poll.nobles) * 3 < Math.abs(poll.commons), `${poll.nobles} против ${poll.commons}`);

  const trade = links({ eco: { taxRates: { trade: 0.6 } } }).mods.approval;
  t('торговый: купцам хуже всех',
    ESTATES.every(f => f === 'merchants' || trade.merchants < trade[f]), JSON.stringify(trade));

  const land = links({ eco: { taxRates: { land: 0.6 } } }).mods.approval;
  t('земельный: знати хуже, чем купцам', land.nobles < land.merchants, JSON.stringify(land));

  const lux = links({ eco: { taxRates: { luxury: 0.6 } } }).mods.approval;
  t('на роскошь: знать и купцы злятся', lux.nobles < 0 && lux.merchants < 0, JSON.stringify(lux));
  t('на роскошь: простолюдины НЕ злятся (щиплют богатых — по справедливости)',
    lux.commons >= 0, String(lux.commons));

  // Монотонность: чем выше ставка, тем ниже уровень, к которому идёт сословие.
  const rates = [0.2, 0.35, 0.5, 0.7, 1.0];
  const targets = rates.map(r => steadyApproval(taxPressureFor('commons', { ...START_RATES, poll: r })));
  t('монотонность: выше подушный — ниже уровень одобрения простолюдинов',
    targets.every((v, i) => i === 0 || v < targets[i - 1]), JSON.stringify(targets.map(v => Math.round(v))));
}

// ─────────────── 3. Потолки петли ───────────────
console.log('\n--- Потолки и выход ---');
{
  const hell = { taxRates: { poll: 1, land: 1, trade: 1, luxury: 1 }, debt: 99999, credit: 0, arrears: 40, priceLevel: 3 };
  const L = links({ eco: hell, day: 1 });
  t(`дневной шаг одобрения не больше ${MAX_STEP}`,
    ESTATES.every(f => Math.abs(L.mods.approval[f]) <= MAX_STEP + 1e-9), JSON.stringify(L.mods.approval));
  t(`штраф к стабильности не ниже ${STAB_WORST}`, L.mods.stability >= STAB_WORST - 1e-9, String(L.mods.stability));
  t(`штраф к счастью не ниже ${HAPPY_WORST}`, L.mods.happy >= HAPPY_WORST, String(L.mods.happy));
  t('уровень одобрения не проваливается ниже пола',
    ESTATES.every(f => steadyApproval(estatePressure(f, hell.taxRates, moneyPressures(makeSim({ eco: hell }))).total) >= APPROVAL_FLOOR - 1e-9));

  // Главный потолок: сословие, уже упавшее ниже своего уровня бремени, деньги
  // больше не топят — иначе получилась бы спираль без выхода.
  const low = links({ eco: { taxRates: { poll: 0.5 } }, approval: { commons: 5 } });
  t('ниже уровня бремени налоги больше не давят', low.mods.approval.commons === 0,
    String(low.mods.approval.commons));

  // Выход: снял налоги — и в тот же день поправка исчезает.
  const back = links({ eco: { taxRates: START_RATES }, approval: { commons: 12, merchants: 12 } });
  t('выход: убрал поборы — связь отпускает сословия немедленно',
    back.mods.approval.commons === 0 && back.mods.approval.merchants === 0);
}

// ─────────────── 4. Долг, репутация, жалование → доверие к власти ───────────────
console.log('\n--- Долг и жалование ---');
{
  // Долг мал относительно дохода — не тревожит; велик — тревожит.
  const small = links({ eco: { debt: 100, tax: 10 } });   // 100 против 340 мес. дохода
  t('малый долг никого не пугает', small.mods.stability === 0 && small.mods.approval.merchants === 0,
    `${small.mods.stability} / ${small.mods.approval.merchants}`);

  const big = links({ eco: { debt: 2000, tax: 10 } });     // ~6 месячных доходов
  t('большой долг роняет стабильность', big.mods.stability < 0, String(big.mods.stability));
  t('большой долг злит купцов сильнее простолюдинов',
    big.mods.approval.merchants < big.mods.approval.commons,
    `${big.mods.approval.merchants} против ${big.mods.approval.commons}`);
  t('причина долга названа словами',
    big.reasons.stability.some(r => /Долг казны/.test(r.ru)), JSON.stringify(big.reasons.stability));

  const bad = links({ eco: { credit: 10 } });
  t('испорченная кредитная история роняет стабильность', bad.mods.stability < 0, String(bad.mods.stability));

  const arr = links({ eco: { arrears: 8 } });
  t('задержка жалования бьёт по военным сильнее всех',
    ESTATES.every(f => f === 'military' || arr.mods.approval.military <= arr.mods.approval[f]),
    JSON.stringify(arr.mods.approval));
  t('задержка жалования роняет стабильность', arr.mods.stability < 0, String(arr.mods.stability));

  // Обратная сторона: здоровая казна — единственный плюс к стабильности, и он
  // заработан (кредитная история выше стартовой), а не выдан просто так.
  const good = links({ eco: { debt: 0, credit: 85, arrears: 0 } });
  t('казна без долгов и с чистым словом даёт плюс к стабильности',
    good.mods.stability > 0 && good.flags.healthyTreasury === true, String(good.mods.stability));
  t('на старте (кредит 50) награды за здоровую казну нет',
    links({}).flags.healthyTreasury === false);
}

// ─────────────── 5. Инфляция и дефляция ───────────────
console.log('\n--- Монета ---');
{
  // Растущая держава естественно держит индекс около 1.3–1.6 — это не ропот.
  const calm = links({ eco: { priceLevel: 1.6 } });
  t('обычный рост цен ещё не ропот', calm.mods.happy === 0 && calm.mods.approval.commons === 0);

  const inf = links({ eco: { priceLevel: 2.6 } });
  t('инфляция роняет счастье горожан', inf.mods.happy < 0, String(inf.mods.happy));
  t('инфляция бьёт по простолюдинам сильнее, чем по знати',
    inf.mods.approval.commons < inf.mods.approval.nobles,
    `${inf.mods.approval.commons} против ${inf.mods.approval.nobles}`);
  const inf2 = links({ eco: { priceLevel: 5 } });
  t('потолок инфляции: втрое дороже и впятеро дороже бьют одинаково',
    inf2.mods.happy === links({ eco: { priceLevel: 3 } }).mods.happy, String(inf2.mods.happy));

  const defl = links({ eco: { priceLevel: 0.6 } });
  t('дефляция бьёт по купцам, а не по простолюдинам',
    defl.mods.approval.merchants < 0 && defl.mods.approval.commons >= 0,
    JSON.stringify(defl.mods.approval));
  t('дешёвый хлеб чуть радует город', defl.mods.happy > 0, String(defl.mods.happy));
}

// ─────────────── 6. Дефолт ───────────────
console.log('\n--- Дефолт ---');
{
  const ev = [{ text: 'Дефолт по займу №3! Кредиторы в ярости, стабильность падает.', type: 'bad' }];
  const sim = makeSim({
    day: 7, eco: { events: ev, repDay: 7, credit: 25, loans: [{ lender: 'nord' }, { lender: 'nord' }, { lender: 'merchants' }] },
    worldFactions: [{ id: 'nord', def: { name: 'Норды' } }],
  });
  const L = economyLinks(sim);
  t('дефолт замечен', L.flags.defaultToday === true);
  t('дефолт обваливает одобрение купцов не меньше чем на удар из таблицы',
    L.mods.approval.merchants <= DEFAULT_SHOCK.merchants, String(L.mods.approval.merchants));
  t('дефолт бьёт по купцам сильнее, чем по простолюдинам',
    L.mods.approval.merchants < L.mods.approval.commons);
  t('прочие кредиторы названы по имени и получают минус к отношениям',
    L.flags.creditorsAlarmed.length === 1 && L.flags.creditorsAlarmed[0].fid === 'nord'
    && L.flags.creditorsAlarmed[0].name === 'Норды' && L.flags.creditorsAlarmed[0].dRel < 0,
    JSON.stringify(L.flags.creditorsAlarmed));
  t('дефолт объяснён игроку словами',
    L.events.some(e => /Дефолт казны/.test(e.text)), JSON.stringify(L.events.map(e => e.text)));

  // Вчерашний отчёт не считается: иначе удар повторялся бы каждый день.
  const stale = economyLinks(makeSim({ day: 9, eco: { events: ev, repDay: 7 } }));
  t('удар дефолта не повторяется в следующие дни',
    stale.flags.defaultToday === false && stale.mods.approval.merchants === 0);
}

// ─────────────── 7. Обратная связь: собираемость ───────────────
console.log('\n--- Обратная связь: злые сословия платят хуже ---');
{
  const angry = links({ eco: { tax: 20 }, approval: { merchants: 10, commons: 20, nobles: 30 } });
  t('злые сословия роняют собираемость', angry.mods.taxMult < 1, String(angry.mods.taxMult));
  t('недобор равен ровно сбор × (множитель − 1)',
    Math.abs(angry.mods.gold - 20 * (angry.mods.taxMult - 1)) < 0.01,
    `${angry.mods.gold} против ${20 * (angry.mods.taxMult - 1)}`);
  t('недобор объяснён: купцы прячут оборот',
    angry.reasons.taxMult.some(r => /Купцы/.test(r.ru)), JSON.stringify(angry.reasons.taxMult));

  const dead = links({ approval: { nobles: 0, clergy: 0, merchants: 0, commons: 0, military: 0 } });
  t(`пол собираемости ${COLLECT_FLOOR}: даже ненавидящая страна платит половину`,
    dead.mods.taxMult === COLLECT_FLOOR, String(dead.mods.taxMult));
  t('всеобщая ненависть — это кризис сбора, и о нём поднят флаг',
    dead.flags.collectionCrisis === true);

  const loyal = links({ eco: { tax: 20 }, approval: { merchants: 100 } });
  t('довольные купцы платят охотнее — но прибавка ограничена',
    loyal.mods.taxMult > 1 && loyal.mods.taxMult <= 1 + COLLECT_BONUS + 1e-9, String(loyal.mods.taxMult));
  t('при доверии купцов казна получает прибавку, а не штраф', loyal.mods.gold > 0, String(loyal.mods.gold));

  // Экономика ещё не ходила сегодня — вчерашний недобор нельзя списать второй раз.
  const stale = economyLinks(makeSim({ day: 12, eco: { tax: 20, repDay: 11 }, approval: { merchants: 0 } }));
  t('недобор не списывается по вчерашнему отчёту',
    stale.mods.taxMult < 1 && stale.mods.gold === 0, `${stale.mods.taxMult} / ${stale.mods.gold}`);

  // Купцы весят в сборе больше простолюдинов — их лояльность и стоит дороже.
  const m = collectionMult({ nobles: 50, clergy: 50, merchants: 10, commons: 50, military: 50 }).mult;
  const c = collectionMult({ nobles: 50, clergy: 50, merchants: 50, commons: 10, military: 50 }).mult;
  t('гнев купцов дороже гнева простолюдинов', m < c, `${m} против ${c}`);
}

// ─────────────── 8. Настоящий оптимум ставки ───────────────
console.log('\n--- Оптимум ставки ---');
{
  const sim = makeSim({});
  const trade = realTaxOptimum(sim, 'trade');
  t('оптимум торгового налога ниже книжного пика Лаффера',
    trade.rate < LAFFER_PEAK, `${trade.rate} против ${LAFFER_PEAK}`);
  t('оптимум не уходит ниже безналогового тягла', trade.rate > TAX_FREE, String(trade.rate));
  t('на оптимуме казна получает больше, чем на пике Лаффера',
    trade.yield > trade.lafferPeakYield && trade.greedLoss > 0,
    `${trade.yield} против ${trade.lafferPeakYield}`);
  t('оптимум объяснён игроку словами', /Лаффер/.test(trade.text) && /%/.test(trade.text), trade.text);
  t('подсказано, с какой ставки сословия звереют',
    trade.angryAt > trade.rate && trade.angryAt <= 1, String(trade.angryAt));

  const poll = realTaxOptimum(sim, 'poll');
  t('торговый налог оптимален при более низкой ставке, чем подушный (купцы чувствительнее к сбору)',
    trade.rate < poll.rate, `${trade.rate} против ${poll.rate}`);
  t('стартовая ставка ниже оптимума — казне есть куда расти',
    poll.better === true && poll.curYield < poll.yield);

  // Подсказка обязана совпадать с механикой: считаем её формулу вручную.
  const check = (r) => {
    const rates = { ...START_RATES, trade: r };
    const appr = {};
    for (const f of ESTATES) appr[f] = steadyApproval(estatePressure(f, rates, moneyPressures(sim)).total);
    return lafferYield(r) * collectionMult(appr).mult;
  };
  t('подсказка не расходится с механикой: на оптимуме сбор не хуже соседних ставок',
    check(trade.rate) >= check(trade.rate - 0.01) - 1e-12 && check(trade.rate) >= check(trade.rate + 0.01) - 1e-12);
  t('несуществующий налог не ломает подсказку', realTaxOptimum(sim, 'tithe') === null);

  // Если сословия уже на дне, собираемости падать некуда — и оптимум честно
  // возвращается к пику Лаффера, а не выдумывает новый.
  const ruined = makeSim({ eco: { taxRates: { poll: 1, land: 1, luxury: 1 }, debt: 99999, tax: 1, credit: 0, arrears: 40, priceLevel: 3 } });
  t('на дне оптимум совпадает с пиком Лаффера', realTaxOptimum(ruined, 'trade').rate === LAFFER_PEAK,
    String(realTaxOptimum(ruined, 'trade').rate));
}

// ─────────────── 9. События и разбор для игрока ───────────────
console.log('\n--- Что игрок читает ---');
{
  const heavy = { taxRates: { poll: 0.7 }, tax: 10, priceLevel: 1.8, debt: 3000 };
  const quietDay = links({ day: 7, eco: heavy, approval: { merchants: 10 } });
  const loudDay = links({ day: 10, eco: heavy, approval: { merchants: 10 } });
  t('журнал не спамит каждый день', quietDay.events.length === 0, JSON.stringify(quietDay.events));
  t('раз в декаду игрок получает сводку причин', loudDay.events.length >= 3,
    JSON.stringify(loudDay.events.map(e => e.text)));
  t('о недоборе сказано в процентах',
    loudDay.events.some(e => /% налога/.test(e.text)), JSON.stringify(loudDay.events.map(e => e.text)));
  const wage = links({ day: 5, eco: { arrears: 6 } });
  t('о задержке жалования сказано с числом дней',
    wage.events.some(e => /6 дн/.test(e.text)), JSON.stringify(wage.events.map(e => e.text)));

  const ex = explainEstate(makeSim({ eco: { taxRates: { trade: 0.8 } } }), 'merchants');
  t('разбор по сословию называет уровень, к которому оно идёт',
    ex.target < 50 && ex.rows.length > 0 && /Купцы/.test(ex.text), JSON.stringify(ex));
  t('разбор по спокойному сословию честно говорит «обид нет»',
    /обид нет/.test(explainEstate(makeSim({}), 'clergy').text));
  t('давление в разборе загнано в «злые» только конфискацией',
    explainEstate(makeSim({ eco: { taxRates: { trade: 1 } } }), 'merchants').angry === true
    && explainEstate(makeSim({ eco: { taxRates: { trade: 0.4 } } }), 'merchants').angry === false);
  t(`порог гнева взят из politics.js (${FACTION_ANGRY}), а не выдуман заново`,
    steadyApproval(0.694) >= FACTION_ANGRY && steadyApproval(0.7) < FACTION_ANGRY);
}

// ─────────────── 10. Чистота, устойчивость, детерминизм ───────────────
console.log('\n--- Чистота и устойчивость ---');
{
  const sim = makeSim({ day: 10, eco: { taxRates: { poll: 0.8 }, debt: 5000, arrears: 5, priceLevel: 2 }, approval: { merchants: 10 } });
  const before = JSON.stringify(sim);
  const a = economyLinks(sim);
  const b = economyLinks(sim);
  t('функция ничего не меняет в мире', JSON.stringify(sim) === before);
  t('два вызова подряд дают один и тот же ответ', JSON.stringify(a) === JSON.stringify(b));

  t('без установленных систем возвращается нейтральный ответ',
    (() => {
      const L = economyLinks({ day: 1 });
      return L.mods.taxMult === 1 && L.mods.gold === 0 && L.flags.quiet === true
        && ESTATES.every(f => L.mods.approval[f] === 0);
    })());
  t('пустой аргумент не роняет модуль', economyLinks(null).mods.taxMult === 1);
  t('отчёта экономики ещё нет — недобор не выдумывается',
    (() => {
      const s = makeSim({ approval: { merchants: 0 } });
      s.industry.eco.report = () => null;
      const L = economyLinks(s);
      return L.mods.gold === 0 && L.mods.taxMult < 1;
    })());

  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/core/systems/link_economy.js'), 'utf8');
  t('Math.random в модуле не вызывается (иначе ломались бы сейвы)', !/Math\.random\s*\(/.test(src));
}

// ─────────────── 11. Живая игра ───────────────
console.log('\n--- В настоящей партии ---');
{
  const { Simulation } = await import('../src/core/simulation.js');
  const s = new Simulation(23);
  for (let i = 0; i < 120; i++) s.tick(0.25);
  const L = economyLinks(s);
  t('связь работает на живом Simulation', !!L && typeof L.mods.taxMult === 'number');
  t('все пять сословий получили число', ESTATES.every(f => typeof L.mods.approval[f] === 'number'));
  t('собираемость в допустимых пределах',
    L.mods.taxMult >= COLLECT_FLOOR && L.mods.taxMult <= 1 + COLLECT_BONUS, String(L.mods.taxMult));
  t('без долгов и задержек жалования стабильность не трогается',
    L.mods.stability === 0, String(L.mods.stability));
  t('поправка к счастью остаётся в объявленных границах',
    L.mods.happy >= HAPPY_WORST && L.mods.happy <= 2, String(L.mods.happy));
  // Идеальная партия (никто ничего не строит, золото копится) по модели
  // economy.js — это гиперинфляция, и связь обязана её увидеть.
  s.industry.eco.setTaxRate('poll', 0.15);
  t('в живой игре дорогая монета доходит до горожан',
    s.economy.priceLevel < 1.8 ? economyLinks(s).mods.happy === 0 : economyLinks(s).mods.happy < 0,
    `индекс цен ${s.economy.priceLevel.toFixed(2)}`);

  // Задираем налоги в живой игре — и смотрим, что связь тянет в нужную сторону.
  s.economy.setTaxRate('trade', 0.9);
  const L2 = economyLinks(s);
  t('в живой игре торговый налог 90% злит купцов', L2.mods.approval.merchants < 0,
    String(L2.mods.approval.merchants));
  t('подсказка по живой игре советует ставку ниже 90%',
    realTaxOptimum(s, 'trade').rate < 0.9);
}

console.log(`\n=== ${ok} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
