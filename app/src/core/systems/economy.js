// core/systems/economy.js — макроэкономика: цены и спрос, инфляция, налоги,
// займы и долг, содержание аппарата, экономические кризисы.
// Чистый модуль: без DOM, работает в node. Весь рандом — только через sim.rng.
//
// Не пересекается с production.js: там ФИЗИКА товаров (цепочки, маршруты),
// здесь — ДЕНЬГИ: сколько товар стоит, чего стоит монета и чего стоит казна.

import { MARKET_BASE } from '../data.js';

const GOODS = ['food', 'wood', 'stone', 'steel'];

// Запас на 10 дней потребления — «норма»: при ней цена равна базовой.
const NORMAL_COVER = 10;
// Цена проходит 15% пути к цели за день: рынок реагирует, но не скачет.
const PRICE_SMOOTH = 0.15;
const LEVEL_SMOOTH = 0.05;
// Базовый срок займа; к нему нормируется ставка при другом сроке.
const LOAN_TERM = 60;

export const TAX_KINDS = ['poll', 'land', 'trade', 'luxury'];
// Вес недовольства: подушный бьёт всех, роскошь — почти никого.
const TAX_PAIN = { poll: 20, land: 12, trade: 8, luxury: 5 };

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function round2(v) { return Math.round(v * 100) / 100; }

// Цена растёт как корень из нехватки: линейная зависимость давала бы
// десятикратные цены при первом же неурожае.
export function scarcity(cover) {
  return clamp(Math.sqrt(NORMAL_COVER / Math.max(cover, 0.5)), 0.25, 4);
}

// Кривая Лаффера: собираемость = ставка × (1 − ставка)^1.2.
// Пик около ставки 0.45; при 100% сбор нулевой — все уходят в тень.
export function lafferYield(rate) {
  const r = clamp(rate, 0, 1);
  return r * Math.pow(1 - r, 1.2);
}
// Нормировка: на пике кривой казна получает примерно половину налоговой базы.
const LAFFER_NORM = 2.2;

// Степень 1.3 — высокие ставки злят непропорционально сильнее низких.
export function taxPain(rates) {
  let sum = 0;
  for (const k of TAX_KINDS) sum += TAX_PAIN[k] * Math.pow(clamp(rates[k] || 0, 0, 1), 1.3);
  return sum;
}

// Ставка за весь срок LOAN_TERM: репутация у кредитора и кредитная история
// удешевляют долг; изгою и банкроту деньги дают под 60%.
export function loanRate(rel, credit) {
  return clamp(0.35 - rel * 0.002 - (credit - 50) * 0.003, 0.05, 0.6);
}

export function createEconomy(opts = {}) {
  // Если ядро уже списывает ARMY_UPKEEP.gold — при интеграции передать 0,
  // иначе солдаты получат жалование дважды.
  const armyWage = opts.armyWagePerSoldier ?? 0.2;

  let st = freshState();

  function freshState() {
    return {
      prices: Object.fromEntries(GOODS.map(g => [g, MARKET_BASE[g]])),
      priceLevel: 1,          // индекс цен: 1 = монета здорова
      mintedPool: 0,          // напечатанные деньги давят на цены, пока не рассосутся
      factionMults: {},       // fid -> { товар: множитель местной цены }
      taxRates: { poll: 0.15, land: 0.1, trade: 0.1, luxury: 0 },
      loans: [],
      nextLoanId: 1,
      credit: 50,             // кредитная история 0..100
      arrears: 0,             // дней задержки жалования подряд (с погашением)
      stability: 70,
      heat: 0,                // счётчик перегрева; отрицательный = остывание после обвала
      incomeEma: 0, incomeEmaSlow: 0, lastGold: null,
      shortages: [],
      defaults: 0,
      lastReport: null,
    };
  }

  function onNewDay(sim) {
    const rng = sim.rng;
    const pop = sim.villagers ? sim.villagers.length : 0;
    const soldiers = (sim.army && sim.army.soldiers) || 0;
    const done = sim.buildings ? sim.buildings.filter(b => b.done && !b.destroyed).length : 0;
    const era = sim.eraIndex || 0;
    const events = [];

    // --- Вчерашний приток золота (нужен для детекции перегрева) ---
    const gold0 = sim.res.gold;
    const delta = st.lastGold == null ? 0 : gold0 - st.lastGold;
    st.incomeEma += (delta - st.incomeEma) * 0.3;
    st.incomeEmaSlow += (delta - st.incomeEmaSlow) * 0.05;

    // --- Спрос, дефицит, движение цен ---
    const demand = {
      food: pop * 0.7 + soldiers * 0.5,
      // Зимой к спросу на дерево добавляются дрова.
      wood: pop * 0.15 + (sim.seasonIdx === 3 ? pop * 0.5 : 0),
      stone: (sim.buildQueue ? sim.buildQueue.length : 0) * 2 + 0.5,
      steel: soldiers * 0.05 + 0.2,
    };
    st.shortages = [];
    for (const g of GOODS) {
      const cover = (sim.res[g] || 0) / Math.max(demand[g], 0.1);
      if (cover < 3 && demand[g] > 1) st.shortages.push(g);
      const target = MARKET_BASE[g] * scarcity(cover) * st.priceLevel;
      st.prices[g] += (target - st.prices[g]) * PRICE_SMOOTH;
    }
    if (st.shortages.includes('food')) {
      st.stability = clamp(st.stability - 2, 0, 100);
      events.push({ text: 'Дефицит еды: рынок взвинтил цены, город тревожится.', type: 'bad' });
    }

    // --- Инфляция: денег больше, чем товаров — монета дешевеет ---
    // Количественная теория: индекс цен тянется к √(деньги / выпуск). Корень
    // сглаживает, чтобы одна удачная война не удваивала цены за неделю.
    const realOutput = pop * 1.5 + done * 2 + era * 5;
    // Напечатанное давит вдвое: оно уже в казне И ещё числится в пуле.
    const effMoney = gold0 + st.mintedPool;
    const levelTarget = clamp(Math.sqrt(effMoney / Math.max(realOutput * 1.2, 1)), 0.6, 3);
    st.priceLevel += (levelTarget - st.priceLevel) * LEVEL_SMOOTH;
    st.mintedPool *= 0.98;

    // --- Местные цены фракций: блуждание с притяжением к 1 ---
    // Разброс множителей и есть источник торговой прибыли: купил там, продал тут.
    for (const f of (sim.factions || [])) {
      if (f.alive === false) continue;
      let m = st.factionMults[f.id];
      if (!m) {
        m = {};
        for (const g of GOODS) m[g] = 0.7 + rng.next() * 0.7;
        st.factionMults[f.id] = m;
      }
      for (const g of GOODS) m[g] = clamp(m[g] + (rng.next() - 0.5) * 0.08 + (1 - m[g]) * 0.01, 0.5, 1.8);
    }

    // --- Налоги (с кривой Лаффера) ---
    const wealth = sim.wealth ? sim.wealth() : 0;
    const tradeDeals = sim.treaties ? sim.treaties.filter(t => t.type === 'trade').length : 0;
    const bases = {
      poll: pop * 0.6,
      land: done * 1.2,
      trade: 2 + tradeDeals * 4,
      luxury: Math.max(0, wealth - 150) / 40,
    };
    const taxes = { total: 0 };
    for (const k of TAX_KINDS) {
      taxes[k] = round2(bases[k] * lafferYield(st.taxRates[k]) * LAFFER_NORM);
      taxes.total += taxes[k];
    }
    taxes.total = round2(taxes.total);
    taxes.pain = round2(taxPain(st.taxRates));
    sim.res.gold += taxes.total;

    // --- Содержание: армия, здания, чиновники ---
    const officials = Math.ceil(pop / 15);
    const need = round2(soldiers * armyWage + done * 0.04 * (1 + era * 0.25) + officials * 0.5);
    let paid = need;
    if (sim.res.gold >= need) {
      sim.res.gold -= need;
      // Выплата гасит две задержки: иначе одна голодная зима портила бы армию навсегда.
      st.arrears = Math.max(0, st.arrears - 2);
    } else {
      paid = round2(Math.max(0, sim.res.gold));
      sim.res.gold = 0;
      st.arrears++;
      st.stability = clamp(st.stability - 1, 0, 100);
      if (st.arrears === 1 || st.arrears % 5 === 0) {
        events.push({ text: 'В казне пусто: жалование задержано, войско и чиновники ропщут.', type: 'bad' });
      }
    }

    // --- Займы: срок вышел — платим или объявляем дефолт ---
    for (const L of [...st.loans]) {
      L.daysLeft--;
      if (L.daysLeft > 0) continue;
      if (sim.res.gold >= L.owed) {
        sim.res.gold -= L.owed;
        st.credit = clamp(st.credit + 5, 0, 100);
        if (L.lender !== 'merchants' && sim.adjustRel) sim.adjustRel(L.lender, 6, 'Долг возвращён');
        events.push({ text: `Займ №${L.id} погашен: ${round2(L.owed)}🪙.`, type: 'info' });
      } else {
        st.defaults++;
        st.credit = clamp(st.credit - 25, 0, 100);
        st.stability = clamp(st.stability - 15, 0, 100);
        if (L.lender !== 'merchants' && sim.adjustRel) sim.adjustRel(L.lender, -25, 'Дефолт по займу');
        events.push({ text: `Дефолт по займу №${L.id}! Кредиторы в ярости, стабильность падает.`, type: 'bad' });
      }
      st.loans = st.loans.filter(x => x.id !== L.id);
    }

    // --- Пузырь и обвал ---
    // Перегрев = дорогая монета плюс приток золота заметно выше привычного.
    // 8 таких дней подряд — и пузырь лопается.
    let crash = false;
    const overheated = st.priceLevel > 1.45 && st.incomeEma > st.incomeEmaSlow * 1.5 + 0.5;
    if (st.heat < 0) st.heat++;
    else st.heat = overheated ? st.heat + 1 : Math.max(0, st.heat - 1);
    if (st.heat >= 8) {
      crash = true;
      st.priceLevel = Math.max(0.6, st.priceLevel * 0.7);
      for (const g of GOODS) st.prices[g] *= 0.75;
      // Часть сбережений сгорает: невозвраты и разорившиеся купцы.
      sim.res.gold = round2(sim.res.gold * 0.88);
      st.stability = clamp(st.stability - 20, 0, 100);
      st.heat = -15; // после обвала рынок долго не перегревается снова
      events.push({ text: 'Пузырь лопнул! Цены рухнули, часть сбережений сгорела.', type: 'bad' });
    }

    // Стабильность медленно тянется к норме 70.
    st.stability += clamp(70 - st.stability, -0.5, 0.5);

    st.lastGold = sim.res.gold;
    st.lastReport = {
      day: sim.day,
      taxes,
      upkeep: { need, paid, officials, arrears: st.arrears },
      priceLevel: round2(st.priceLevel),
      prices: Object.fromEntries(GOODS.map(g => [g, round2(st.prices[g])])),
      shortages: [...st.shortages],
      crash,
      stability: round2(st.stability),
      events,
    };
    if (sim.addLog) for (const e of events) sim.addLog(e.text, e.type);
    return st.lastReport;
  }

  // ---------- Действия игрока ----------

  function setTaxRate(kind, rate) {
    if (!TAX_KINDS.includes(kind)) return { ok: false, reason: 'Нет такого налога' };
    st.taxRates[kind] = clamp(rate, 0, 1);
    return { ok: true };
  }

  function priceOf(good) { return st.prices[good] ?? 0; }

  // Чужой рынок не знает наших дефицитов: цена = база × местный множитель × индекс монеты.
  function priceAt(fid, good) {
    const m = st.factionMults[fid];
    return MARKET_BASE[good] * (m ? m[good] : 1) * st.priceLevel;
  }

  // Прибыль с единицы товара: купить у фракции, продать на своём рынке.
  function tradeMargin(fid, good) { return priceOf(good) - priceAt(fid, good); }

  function loanOffer(sim, lender, amount, days = LOAN_TERM) {
    const rel = lender === 'merchants' ? 0 : (sim.relations ? (sim.relations[lender] || 0) : 0);
    const rate = loanRate(rel, st.credit);
    return { lender, amount, days, rate, owed: round2(amount * (1 + rate * days / LOAN_TERM)) };
  }

  function takeLoan(sim, { lender, amount, days = LOAN_TERM }) {
    if (!(amount > 0)) return { ok: false, reason: 'Сумма займа должна быть больше нуля' };
    const offer = loanOffer(sim, lender, amount, days);
    const loan = { id: st.nextLoanId++, lender, principal: amount, owed: offer.owed, rate: offer.rate, daysLeft: days };
    st.loans.push(loan);
    sim.res.gold += amount;
    return { ok: true, loan };
  }

  function repayLoan(sim, id) {
    const L = st.loans.find(x => x.id === id);
    if (!L) return { ok: false, reason: 'Такого займа нет' };
    if (sim.res.gold < L.owed) return { ok: false, reason: 'Не хватает золота для погашения' };
    sim.res.gold -= L.owed;
    st.loans = st.loans.filter(x => x.id !== id);
    st.credit = clamp(st.credit + 5, 0, 100);
    if (L.lender !== 'merchants' && sim.adjustRel) sim.adjustRel(L.lender, 6, 'Долг возвращён досрочно');
    return { ok: true };
  }

  function debtTotal() { return round2(st.loans.reduce((s, L) => s + L.owed, 0)); }

  function mintGold(sim, amount) {
    if (!(amount > 0)) return { ok: false, reason: 'Чеканить можно только положительную сумму' };
    sim.res.gold += amount;
    st.mintedPool += amount;
    if (sim.addLog) sim.addLog(`Казна отчеканила ${amount}🪙 — монета станет дешевле.`, 'info');
    return { ok: true };
  }

  // ---------- Модификаторы для ядра ----------

  function happyMod() {
    const shortFood = st.shortages.includes('food') ? 5 : 0;
    return Math.round(-taxPain(st.taxRates) + (st.stability - 70) * 0.25 - shortFood - Math.min(10, st.arrears * 2));
  }

  // Штраф к боевому духу за задержку жалования.
  function moraleMod() { return -Math.min(30, st.arrears * 4); }

  // ---------- Сохранение ----------

  function serialize() { return JSON.parse(JSON.stringify(st)); }
  function deserialize(data) {
    if (data) st = { ...freshState(), ...JSON.parse(JSON.stringify(data)) };
  }

  function report() { return st.lastReport; }

  return {
    onNewDay, setTaxRate, priceOf, priceAt, tradeMargin,
    loanOffer, takeLoan, repayLoan, debtTotal, mintGold,
    happyMod, moraleMod, report, serialize, deserialize,
    get taxRates() { return { ...st.taxRates }; },
    get credit() { return st.credit; },
    get stability() { return st.stability; },
    get priceLevel() { return st.priceLevel; },
    get arrears() { return st.arrears; },
    get loans() { return st.loans.map(l => ({ ...l })); },
  };
}

export function deserializeEconomy(data, opts) {
  const e = createEconomy(opts);
  e.deserialize(data);
  return e;
}

/* ИНТЕГРАЦИЯ — точные строки для simulation.js (вставляет главный разработчик)

1) Импорт, рядом с остальными системами:
   import { createEconomy, deserializeEconomy } from './systems/economy.js';

2) Конструктор Simulation, после installSystems(this):
   this.economy = createEconomy({ armyWagePerSoldier: 0 });
   // armyWagePerSoldier: 0 — ядро УЖЕ списывает золотую часть ARMY_UPKEEP.
   // Если убрать это списание из ядра — создавать без опции: жалование армии возьмёт модуль.

3) onNewDay(), после systemsNewDay(this):
   this.economy.onNewDay(this);
   // Модуль сам начисляет налоги в res.gold, списывает содержание, ведёт займы
   // и пишет события через addLog. Возврат — дневной отчёт для HUD.

4) happiness(), к сумме модификаторов:
   h += this.economy ? this.economy.happyMod() : 0;

5) Боевой дух (где ядро считает мораль армии):
   morale += this.economy ? this.economy.moraleMod() : 0;   // до −30 при задержках жалования

6) serialize():
   economy: this.economy.serialize(),
   deserialize():
   sim.economy = data.economy
     ? deserializeEconomy(data.economy, { armyWagePerSoldier: 0 })
     : createEconomy({ armyWagePerSoldier: 0 });

7) UI (panel_market.js или панель казны) — готовые числа, всё уже с учётом инфляции:
   sim.economy.priceOf('food')                 // местная цена товара
   sim.economy.priceAt(fid, 'food')            // цена у фракции
   sim.economy.tradeMargin(fid, good)          // прибыль с единицы: купить там, продать здесь
   sim.economy.setTaxRate('poll', 0.3)         // 'poll' | 'land' | 'trade' | 'luxury', ставка 0..1
   sim.economy.loanOffer(sim, fid, 200)        // предпросмотр условий (fid или 'merchants')
   sim.economy.takeLoan(sim, { lender: fid, amount: 200 })
   sim.economy.repayLoan(sim, loanId)          // досрочное погашение
   sim.economy.mintGold(sim, 100)              // печать денег: золото сейчас, инфляция потом
   sim.economy.report()                        // дневной отчёт: налоги, содержание, кризисы
   sim.economy.priceLevel / .credit / .stability / .arrears / .loans — геттеры для HUD
*/
