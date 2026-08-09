// core/systems/wire_production.js — оживление production.js и economy.js.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. Обе системы написаны, покрыты тестами (24 + 46) и мертвы:
// игра их не зовёт. Здесь — тот же принцип, что в systems/integrate.js: модуль
// НЕ трогает sim, он получает ctx и возвращает отчёт, а применяет отчёт к миру
// этот слой. Поэтому production.js и economy.js остаются тестируемыми в
// одиночку, а ядро не знает про их внутренности.
//
// ЧТО ИМЕННО ОЖИВАЕТ:
//   production.js — цепочки «руда → сталь» и «зерно → мука → хлеб», внутренний
//     склад сырья с порчей, торговые маршруты с караванами, грузом и разбоем;
//   economy.js — цены от дефицита, инфляция от напечатанных денег, четыре налога
//     с кривой Лаффера, содержание армии/зданий/чиновников, займы и дефолт,
//     перегрев и обвал рынка.
//
// ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ. «Износ зданий» и «качество продукции» в системах не
// реализованы — их нет ни в production.js, ни где-либо ещё в core. Дописывать
// новую механику ради красивой строчки в панели нельзя, поэтому вместо
// выдуманного износа панель показывает настоящую цену владения постройками:
// содержание из economy.js растёт с эпохой (× (1 + эпоха × 0.25)) и порчу сырья
// на складе из production.js. Это то же самое по смыслу и это правда.
//
// РАЗДЕЛЕНИЕ С ЭКРАНОМ РЫНКА. ui/panel_market.js — про обмен ресурсов по курсу
// ядра (marketRate/marketSell/marketBuy). Здесь ни одной кнопки купли-продажи:
// эта панель про то, ЧТО производится, СКОЛЬКО стоит содержать государство и
// КУДА ходят караваны.
//
// Math.random не используется: весь случай — через sim.rng внутри модулей.

import { BUILDINGS, BUILDING_ERA_IDX, TECH_ERA_IDX, RES, WEATHER, DIPLO_FACTORS } from '../data.js';
import {
  createProduction, tickProduction, chainStatus,
  addRoute, removeRoute, tickRoutes, planRoute, maxRoutes, routeInfo, routeClass,
  serializeProduction, deserializeProduction,
  CHAINS, INTERMEDIATES, EXTRA_BUILDINGS, TRADE,
} from './production.js';
import {
  createEconomy, deserializeEconomy, TAX_KINDS, lafferYield, taxPain,
} from './economy.js';
import { ownerAt, ownerSide, OWNER_NONE, OWNER_PLAYER } from './borders.js';

const RES_META = Object.fromEntries(RES.map(r => [r.id, r]));
const INTER_BY_ID = Object.fromEntries(INTERMEDIATES.map(i => [i.id, i]));

// Названия налогов и объяснение «с чего берётся». Игрок должен понимать, почему
// подушный налог даёт много и злит всех, а налог на роскошь — наоборот.
const TAX_META = {
  poll:   { ru: 'Подушный',    base: 'с каждого жителя',        note: 'Бьёт по всем — самый доходный и самый ненавистный.' },
  land:   { ru: 'Земельный',   base: 'с готовых построек',      note: 'Растёт вместе с поселением, злит умеренно.' },
  trade:  { ru: 'Торговый',    base: 'с торговых договоров',    note: 'Договоры с соседями делают его выгоднее.' },
  luxury: { ru: 'На роскошь',  base: 'с богатства сверх 150🪙', note: 'Почти никого не злит, но и даёт мало, пока казна бедна.' },
};

// Суммы займов на кнопках: «залатать дыру», «прожить сезон», «построить рывком».
const LOAN_LOTS = [100, 250, 500];
// Партии чеканки. Печать даёт золото сразу, а инфляцию — потом, поэтому лоты мелкие.
const MINT_LOTS = [50, 150];
// Шаг налоговых кнопок. 5% — заметно на глаз и не требует десяти кликов.
const TAX_STEP = 0.05;

// Пик кривой Лаффера ищем перебором по самой экспортированной функции, а не
// вписываем константой: если формулу в economy.js поправят, отметка «пик сбора»
// на шкале уедет вместе с ней.
const LAFFER_PEAK = (() => {
  let best = 0, bv = -1;
  for (let i = 0; i <= 100; i++) {
    const v = lafferYield(i / 100);
    if (v > bv) { bv = v; best = i / 100; }
  }
  return best;
})();

// ════════════════════ АДАПТЕР ════════════════════

export function installIndustry(sim) {
  const prod = createProduction();
  // armyWagePerSoldier: 0 — ядро УЖЕ списывает золотую часть ARMY_UPKEEP в
  // onNewDay. Без нуля солдаты получали бы жалование дважды в день.
  const eco = createEconomy({ armyWagePerSoldier: 0 });
  sim.industry = {
    prod, eco,
    prodReport: null,     // последний отчёт цепочек
    routeReport: null,    // последний отчёт караванов
    ecoReport: null,      // последний дневной отчёт экономики
    planCache: { day: -1, map: {} },  // маршруты «в уме»: A* дорог, чтобы гонять его 4 раза в секунду
  };
  // Имена из «родных» инструкций модулей: рендер маршрутов и чужие панели ждут
  // именно sim.production и sim.economy.
  sim.production = prod;
  sim.economy = eco;
  return sim.industry;
}

// Вызывать раз в игровые сутки. Порядок важен: сначала цепочки (появляется
// товар), потом караваны (везут излишки), и только затем деньги — иначе
// экономика считала бы цены по вчерашним складам.
export function industryNewDay(sim) {
  const S = sim.industry;
  if (!S) return null;

  const pr = tickProduction(S.prod, productionCtx(sim));
  // pr.res — ДЕЛЬТА ресурсов ядра и она бывает отрицательной: плавка жжёт дрова.
  for (const [r, v] of Object.entries(pr.res)) {
    if (!(r in sim.res)) continue;
    const cap = sim.resCap[r] ?? 99999;
    sim.res[r] = Math.max(0, Math.min(cap, sim.res[r] + v));
  }
  S.prodReport = pr;

  const tr = tickRoutes(S.prod, routeCtx(sim));
  if (tr.gold) sim.res.gold = Math.min(sim.resCap.gold ?? 99999, sim.res.gold + tr.gold);
  for (const e of tr.events) {
    sim.addLog(e.text, (e.type === 'robbed' || e.type === 'broken') ? 'bad' : 'info');
    // Ограбленный караван — законный повод испортить отношения. Портит их ядро:
    // только оно знает про затухание факторов и историю дипломатии.
    if (e.type === 'robbed' && e.faction && typeof sim.adjustRel === 'function') {
      sim.adjustRel(e.faction, DIPLO_FACTORS.caravanRaid.dR, 'caravanRaid');
    }
  }
  S.routeReport = tr;

  // Экономика спроектирована так, что принимает sim целиком: она сама начисляет
  // налоги, списывает содержание, ведёт займы и пишет события через addLog.
  S.ecoReport = S.eco.onNewDay(sim);
  return S.ecoReport;
}

// Штраф/бонус к счастью: налоговое бремя, стабильность, дефицит еды, задержки
// жалования. Ядро прибавляет это в happiness().
export function industryHappyMod(sim) {
  return sim.industry ? sim.industry.eco.happyMod() : 0;
}

// Штраф к боевому духу за невыплаченное жалование (до −30). В ядре морали
// сейчас нет — как только появится, прибавлять это.
export function industryMoraleMod(sim) {
  return sim.industry ? sim.industry.eco.moraleMod() : 0;
}

export function industrySerialize(sim) {
  if (!sim.industry) return null;
  return {
    prod: serializeProduction(sim.industry.prod),
    eco: sim.industry.eco.serialize(),
  };
}

export function industryRestore(sim, data) {
  if (!sim.industry || !data) return;
  if (data.prod) {
    sim.industry.prod = deserializeProduction(data.prod);
    sim.production = sim.industry.prod;   // deserialize даёт НОВЫЙ объект — ссылку надо переставить
  }
  if (data.eco) {
    sim.industry.eco = deserializeEconomy(data.eco, { armyWagePerSoldier: 0 });
    sim.economy = sim.industry.eco;
  }
  sim.industry.planCache = { day: -1, map: {} };
}

// Необязательно: добавляет в список построек Плавильню и Пекарню — профильных
// исполнителей плавки и выпечки. Без них стадии тянут запасные здания (кузница,
// амбар) вполсилы, тупика не возникает, но и цепочки не раскрываются.
// Слить эти два здания прямо в data.js нельзя: production.js сам импортирует
// data.js и проверяет таблицу цепочек на верхнем уровне — вышел бы цикл
// импортов, при котором BUILDINGS на момент проверки ещё пуст.
export function enableChainBuildings() {
  let added = 0;
  for (const [id, def] of Object.entries(EXTRA_BUILDINGS)) {
    if (BUILDINGS[id]) continue;
    BUILDINGS[id] = def;
    // Таблица эпох считается при загрузке data.js и новых id не знает: без этой
    // строки рендер рисовал бы плавильню спрайтом каменного века.
    BUILDING_ERA_IDX[id] = def.req ? (TECH_ERA_IDX[def.req] ?? 0) : 0;
    added++;
  }
  return added;
}

// ---------- Сборка ctx ----------

function chainMult(sim) {
  return {
    gather: sim.globalMult('gather') * WEATHER[sim.weather].gather,
    farm: WEATHER[sim.weather].farm * (sim.techs.has('feudalism') ? 1.2 : 1),
    industry: sim.globalMult('industry'),
  };
}

function productionCtx(sim) {
  return {
    buildings: sim.buildings,
    seasonIdx: sim.seasonIdx,
    days: 1,
    res: sim.res,
    resCap: sim.resCap,
    mult: chainMult(sim),
  };
}

function statusCtx(sim) {
  return { buildings: sim.buildings, seasonIdx: sim.seasonIdx, mult: chainMult(sim) };
}

function routeCtx(sim) {
  return {
    world: sim.world, days: 1, rng: sim.rng, day: sim.day,
    techs: sim.techs, buildings: sim.buildings,
    factions: sim.factions, relations: sim.relations, wars: sim.wars,
    goldMult: sim.globalMult('gold'),
    caravanMult: (sim.hasBuilding('shipyard') ? 1.5 : 1) * (sim.hasBuilding('train_station') ? 2 : 1),
    hostileAt: hostileAtFor(sim),
  };
}

// Враждебная территория берётся из уже подключённых границ. Если модуль границ
// не установлен — путь просто нечему рвать, и это не ошибка.
function hostileAtFor(sim) {
  const b = sim.sys && sim.sys.borders;
  if (!b) return undefined;
  return (x, y, fid) => {
    const o = ownerAt(b, x, y);
    return o !== OWNER_NONE && o !== OWNER_PLAYER && ownerSide(o) !== fid;
  };
}

// Откуда выходит караван: от рынка, иначе от кострища, иначе от точки старта.
export function homePoint(sim) {
  const market = sim.buildings.find(b => b.id === 'market' && b.done && !b.destroyed);
  const camp = sim.buildings.find(b => b.id === 'campfire' && !b.destroyed);
  const any = sim.buildings.find(b => b.done && !b.destroyed);
  const b = market || camp || any;
  return b ? { x: b.x, y: b.y } : { x: sim.world.startX, y: sim.world.startY };
}

// ════════════════════ РАСЧЁТЫ ДЛЯ ПАНЕЛИ ════════════════════

// Во что обойдётся изменение ставки. Доход НЕ пересчитывается заново по своим
// формулам: берём фактический вчерашний сбор и масштабируем его отношением
// значений кривой Лаффера. Нормировка и налоговая база при делении сокращаются,
// поэтому дублировать внутренности economy.js не приходится.
export function taxPreview(S, kind, rate) {
  const rates = S.eco.taxRates;
  const cur = rates[kind] || 0;
  const got = (S.ecoReport && S.ecoReport.taxes) ? (S.ecoReport.taxes[kind] || 0) : 0;
  const yc = lafferYield(cur), yn = lafferYield(rate);
  const gold = (cur > 0 && yc > 1e-9) ? got * (yn / yc) : null;
  const next = { ...rates, [kind]: rate };
  return { gold, painDelta: taxPain(next) - taxPain(rates) };
}

// Узкое место цепочки словами. Узкое место есть ВСЕГДА — цепочка не может
// давать больше самой слабой стадии, — поэтому «всё хорошо» здесь не бывает.
// Бывают три разные беды, и лечатся они по-разному:
//   nobuilding — стадию некому выполнять, строить исполнителя;
//   input      — исполнители простаивают без сырья, расширять стадию ВЫШЕ;
//   capacity   — все работают на полную, расширять саму эту стадию.
// Разделить их можно только по фактическим прогонам из вчерашнего отчёта:
// мощность 1.0 и прогоны 1.0 значат «упёрлись в число зданий», а мощность 1.0 и
// прогоны 0.2 — «зданий хватает, класть в них нечего».
export function chainTrouble(S, chain) {
  const stage = chain.stages.find(s => s.id === chain.bottleneck) || chain.stages[0];
  if (!stage) return null;
  if (stage.winter) return { kind: 'winter', stage, text: 'Зима: поля не родят до весны — цепочка ждёт весны.' };
  if (!stage.buildings) {
    return { kind: 'nobuilding', stage, text: `Узкое место: ${stage.ru}. ${_up(stage.note) || 'Стадию некому выполнять.'}` };
  }

  const runs = (S.prodReport && S.prodReport.runs) ? (S.prodReport.runs[stage.id] || 0) : null;
  if (runs !== null && stage.capacity > 0.01 && runs < stage.capacity * 0.95) {
    const lack = missingInput(S, chain, stage);
    if (lack) {
      return { kind: 'input', stage, lack,
        text: `Узкое место: ${stage.ru}. Здания простаивают — не хватает ${lack.icon} ${lack.ru}, расширяйте стадию выше.` };
    }
    return { kind: 'room', stage, text: `Узкое место: ${stage.ru}. Склад продукта полон — стадия стоит, но сырьё зря не жжёт.` };
  }

  // Все стадии работают на полную мощность: потолок цепочки задаёт вот эта.
  // Копящееся сырьё — прямое доказательство, поэтому называем его вслух.
  const piling = pilingUpBefore(S, chain, stage);
  return {
    kind: 'capacity', stage,
    text: piling
      ? `Узкое место: ${stage.ru}. ${piling.icon} ${piling.ru} копится (${_n(piling.have)})${piling.spoil ? ' и портится' : ''} — переработать нечем.`
      : `Узкое место: ${stage.ru}. Все работают на полную; выше этой стадии цепочка не поднимется.`,
  };
}

// Сырьё, которое ждёт очереди перед узкой стадией. Именно оно и есть видимая
// глазом причина: склад пухнет, а конечного продукта не прибавляется.
function pilingUpBefore(S, chain, stageInfo) {
  const def = findStageDef(chain.id, stageInfo.id);
  if (!def || !def.in) return null;
  for (const r of Object.keys(def.in)) {
    const it = INTER_BY_ID[r];
    const have = S.prod.stock[r] || 0;
    if (it && have > it.cap * 0.3) return { id: r, icon: it.icon, ru: it.ru, have, spoil: it.spoil };
  }
  return null;
}

// Какого именно сырья не хватило стадии. Смотрим на склад модуля: пусто — вот и
// ответ. Сырьё из ресурсов ядра (дрова для плавки) проверяем по sim отдельно.
function missingInput(S, chain, stageInfo) {
  const def = findStageDef(chain.id, stageInfo.id);
  if (!def || !def.in) return null;
  for (const r of Object.keys(def.in)) {
    const it = INTER_BY_ID[r];
    if (it && (S.prod.stock[r] || 0) < 0.5) return { id: r, icon: it.icon, ru: it.ru };
  }
  return null;
}

// chainStatus отдаёт только срез для показа: там нет ни in, ни by. Определение
// стадии берём из живой таблицы CHAINS — не из копии, чтобы цепочки, добавленные
// через registerChain, тоже находились.
function findStageDef(chainId, stageId) {
  const c = CHAINS.find(x => x.id === chainId);
  return c ? c.stages.find(s => s.id === stageId) : null;
}

// Что предложить построить, чтобы расшить узкое место. Возвращаем id здания,
// которое ядро умеет ставить: смысла звать на постройку Плавильни нет, пока
// EXTRA_BUILDINGS не влиты в BUILDINGS.
export function suggestBuilding(chainId, stageId) {
  const def = findStageDef(chainId, stageId);
  if (!def) return null;
  for (const p of def.by) if (BUILDINGS[p.b]) return { id: p.b, name: BUILDINGS[p.b].name };
  const first = def.by[0];
  const meta = first && (BUILDINGS[first.b] || EXTRA_BUILDINGS[first.b]);
  return meta ? { id: null, name: meta.name } : null;
}

// Риск разбоя на маршруте. Формула повторяет completeTrip из production.js
// ТОЛЬКО для показа: игрок обязан видеть, за что теряет караваны, а считать
// бросок продолжает модуль.
export function routeRisk(sim, fid) {
  const rel = (sim.relations && sim.relations[fid]) || 0;
  return Math.max(0, Math.min(0.5, -rel / 200)) * TRADE.robRisk;
}

// Маршруты «в уме» до всех соседей, с кем пути ещё нет. A* дорогой, а панель
// перерисовывается четыре раза в секунду — поэтому считаем раз в игровой день.
export function routePlans(sim) {
  const S = sim.industry;
  const day = Math.floor(sim.day || 0);
  if (S.planCache.day !== day) S.planCache = { day, map: {} };
  const ctx = routeCtx(sim);
  const from = homePoint(sim);
  const out = [];
  for (const f of (sim.factions || [])) {
    if (!f.alive) continue;
    if (S.prod.routes.some(r => r.faction === f.id)) continue;
    const to = f.settlements && f.settlements[0];
    if (!to) continue;
    let plan = S.planCache.map[f.id];
    if (!plan) {
      plan = planRoute(S.prod, ctx, { faction: f.id, from, to });
      if (plan.ok) plan.info = routeInfo(plan.route, ctx);
      S.planCache.map[f.id] = plan;
    }
    out.push({ fid: f.id, name: f.def ? f.def.name : f.id, color: f.def ? f.def.color : '#c9a227', plan });
  }
  return out;
}

// ════════════════════ ЭКРАН ════════════════════

export function renderIndustryPanel(sim) {
  if (!sim) return '';
  const S = sim.industry;
  if (!S) {
    return `<div class="card"><div class="ttl"><span>Хозяйство не подключено</span></div>
      <div class="desc">Системы производства и казны установлены, но installIndustry(sim) не вызван.</div></div>`;
  }
  let html = _head(sim, S);
  html += _chains(sim, S);
  html += _stock(sim, S);
  html += _taxes(sim, S);
  html += _upkeep(sim, S);
  html += _debt(sim, S);
  html += _routes(sim, S);
  return html;
}

function _head(sim, S) {
  const rep = S.ecoReport;
  const lvl = S.eco.priceLevel;
  // Индекс цен: 1.0 — монета здорова, выше — деньги дешевеют.
  const infl = lvl > 1.25 ? 'инфляция' : lvl < 0.9 ? 'дефляция' : 'монета здорова';
  const inflCol = lvl > 1.25 ? 'var(--bad)' : lvl < 0.9 ? 'var(--warn)' : 'var(--good)';
  const st = S.eco.stability;
  const stCol = st >= 60 ? 'var(--good)' : st >= 35 ? 'var(--warn)' : 'var(--bad)';
  const short = rep && rep.shortages.length
    ? rep.shortages.map(g => `${RES_META[g] ? RES_META[g].icon : ''}${RES_META[g] ? RES_META[g].ru : g}`).join(', ')
    : null;
  return `<div class="card"><div class="ttl"><span>Хозяйство и казна</span><span class="cost">🪙 ${_g(sim.res.gold)}</span></div>
    <div class="desc">Цепочки делают товар, налоги делают казну, караваны везут излишки. Всё, что здесь показано, уже случилось вчера — это не прогноз.</div>
    <div class="kv"><span>Индекс цен</span><span style="color:${inflCol}">${lvl.toFixed(2)}× · ${infl}</span></div>
    <div class="kv"><span>Стабильность</span><span style="color:${stCol}">${Math.round(st)} / 100</span></div>
    <div class="kv"><span>Кредитная история</span><span>${Math.round(S.eco.credit)} / 100</span></div>
    ${short ? `<div class="reason">Дефицит: ${short} — цены на это уже взлетели.</div>` : ''}
    ${rep && rep.crash ? '<div class="reason">Пузырь лопнул: цены рухнули, часть сбережений сгорела.</div>' : ''}</div>`;
}

function _chains(sim, S) {
  const list = chainStatus(S.prod, statusCtx(sim));
  let html = '<h4 class="group">Производственные цепочки</h4>';
  for (const c of list) {
    const meta = RES_META[c.final] || { icon: '', ru: c.final };
    const trouble = chainTrouble(S, c);
    // Цвет по тяжести: «некому работать» — беда, «упёрлись в мощность» — просто
    // потолок, который игрок может подвинуть постройкой.
    const col = !trouble ? 'var(--good)'
      : trouble.kind === 'capacity' ? 'var(--good)'
        : trouble.kind === 'winter' || trouble.kind === 'room' ? 'var(--warn)' : 'var(--bad)';
    const made = (S.prod.produced && S.prod.produced[c.final]) || 0;

    let stages = '';
    for (const s of c.stages) {
      const bad = trouble && trouble.stage && s.id === trouble.stage.id && trouble.kind !== 'ok';
      const runs = (S.prodReport && S.prodReport.runs) ? (S.prodReport.runs[s.id] || 0) : null;
      const fact = runs === null ? '' : ` · вчера ${_n(runs)}`;
      const mark = bad ? '⚠️ ' : '';
      stages += `<div class="kv"><span>${mark}${s.ru}${s.buildings ? ` ×${s.buildings}` : ''}</span>
        <span${bad ? ' style="color:var(--bad)"' : ''}>${_n(s.capacity)}/день${fact}</span></div>`;
    }

    // Кнопка на узкое место: hud уже умеет [data-build] — жать её значит начать
    // ставить здание, а не просто прочитать совет.
    let fix = '';
    if (trouble && trouble.kind !== 'winter' && trouble.kind !== 'room') {
      const target = trouble.kind === 'input'
        ? _prevStageOf(c, trouble.stage)   // сырья нет — расширяем предыдущую стадию
        : trouble.stage;                   // иначе саму узкую стадию
      const b = target ? suggestBuilding(c.id, target.id) : null;
      if (b && b.id) {
        // «Ещё один/одна/одно» не склеить без рода — пишем нейтрально.
        const verb = trouble.kind === 'nobuilding' ? 'Построить' : 'Построить ещё';
        fix = `<button class="btn" style="width:100%;margin-top:8px;padding:8px;font-size:12px" data-build="${b.id}">${verb}: ${b.name}</button>`;
      } else if (b) {
        fix = `<div class="desc">Помогло бы здание «${b.name}», но его нет в списке построек этой версии.</div>`;
      }
    }

    html += `<div class="card"><div class="ttl"><span>${meta.icon} ${c.ru}</span>
        <span class="cost" style="color:${col}">${_n(c.output)} ${meta.icon}/день</span></div>
      <div class="desc">Конечный продукт: ${meta.icon} ${meta.ru} — идёт сверх обычной добычи зданий, а не вместо неё. Всего сделано за игру: ${_n(made)}.</div>
      ${stages}
      <div class="reason" style="color:${col}">${trouble ? trouble.text : ''}</div>
      ${fix}</div>`;
  }
  return html;
}

function _prevStageOf(chain, stage) {
  const i = chain.stages.findIndex(s => s.id === stage.id);
  return i > 0 ? chain.stages[i - 1] : stage;
}

function _stock(sim, S) {
  const rows = INTERMEDIATES.map(it => {
    const have = S.prod.stock[it.id] || 0;
    const pct = Math.max(0, Math.min(100, (have / it.cap) * 100));
    const spoiled = (S.prodReport && S.prodReport.spoiled) ? (S.prodReport.spoiled[it.id] || 0) : 0;
    const col = pct > 92 ? 'var(--bad)' : pct > 60 ? 'var(--warn)' : 'var(--good)';
    const note = pct > 92 ? 'склад полон — стадия ниже по цепочке не поспевает'
      : it.spoil ? `портится ${Math.round(it.spoil * 100)}%/день${spoiled > 0.05 ? ` · вчера пропало ${_n(spoiled)}` : ''}`
        : 'не портится';
    return `<div class="kv"><span>${it.icon} ${it.ru}</span><span style="color:${col}">${_n(have)} / ${it.cap}</span></div>
      <div class="relbar"><div style="width:${pct.toFixed(0)}%;background:${col}"></div></div>
      <div class="desc">${note}</div>`;
  }).join('');
  return `<h4 class="group">Склад сырья</h4>
    <div class="card"><div class="ttl"><span>Промежуточные товары</span></div>
    <div class="desc">Сырьё лежит отдельно от общих ресурсов и не занимает амбар. Копить его бессмысленно: мука портится, а полный склад останавливает добычу.</div>
    ${rows}</div>`;
}

function _taxes(sim, S) {
  const rates = S.eco.taxRates;
  const rep = S.ecoReport;
  const total = rep && rep.taxes ? rep.taxes.total : 0;
  const pain = Math.round(taxPain(rates));
  const happy = S.eco.happyMod();

  let html = `<h4 class="group">Налоги</h4>
    <div class="card"><div class="ttl"><span>Казна собирает</span><span class="cost">+${_g(total)}🪙/день</span></div>
    <div class="desc">Сбор идёт по кривой Лаффера: до ${Math.round(LAFFER_PEAK * 100)}% казна богатеет, дальше подданные уходят в тень и казна беднеет вместе с настроением.</div>
    <div class="kv"><span>Налоговое бремя</span><span style="color:${pain > 25 ? 'var(--bad)' : pain > 12 ? 'var(--warn)' : 'var(--good)'}">−${pain} к счастью</span></div>
    <div class="kv"><span>Казна и налоги дают счастью</span><span style="color:${happy < 0 ? 'var(--bad)' : 'var(--good)'}">${_sign(happy)} счастья</span></div></div>`;

  for (const k of TAX_KINDS) {
    const meta = TAX_META[k];
    const rate = rates[k] || 0;
    const got = rep && rep.taxes ? (rep.taxes[k] || 0) : 0;
    const up = taxPreview(S, k, Math.min(1, rate + TAX_STEP));
    const down = taxPreview(S, k, Math.max(0, rate - TAX_STEP));
    const past = rate > LAFFER_PEAK + 0.02;
    const pct = Math.round(rate * 100);
    const col = past ? 'var(--bad)' : rate > 0.25 ? 'var(--warn)' : 'var(--good)';

    // Шкала-ползунок: тычок по дорожке ставит ставку туда, где нажали.
    // Отметка — пик сбора по кривой Лаффера.
    const track = `<div data-prod-track="${k}" title="Ткните по шкале — ставка встанет туда"
        style="position:relative;height:14px;border-radius:7px;background:rgba(255,255,255,0.1);overflow:hidden;margin:8px 0;cursor:pointer">
        <div style="height:100%;width:${pct}%;background:${col};border-radius:7px"></div>
        <div style="position:absolute;top:0;left:${Math.round(LAFFER_PEAK * 100)}%;width:2px;height:100%;background:rgba(255,255,255,0.75)"></div>
      </div>`;

    const gain = up.gold === null ? null : up.gold - got;
    const loss = down.gold === null ? null : got - down.gold;
    const tradeoff = gain === null
      ? 'Поднимите ставку — тогда станет видно, сколько она приносит.'
      : `+5%: ${_sign(gain, _n)}🪙/день ценой ${_sign(-up.painDelta, _n)} счастья · −5%: ${_sign(-loss, _n)}🪙/день, зато ${_sign(-down.painDelta, _n)} счастья`;

    html += `<div class="card"><div class="ttl"><span>${meta.ru}</span>
        <span class="cost" style="color:${col}">${pct}% · +${_g(got)}🪙/день</span></div>
      <div class="desc">Берётся ${meta.base}. ${meta.note}</div>
      ${track}
      <div class="desc">${tradeoff}</div>
      ${past ? '<div class="reason">Ставка выше пика: дальнейший подъём УМЕНЬШИТ сбор и добавит злости.</div>' : ''}
      <div class="btns" style="display:flex;gap:8px;margin-top:8px">
        <button class="btn" style="flex:1;padding:8px;font-size:12px" data-prod="tax:${k}:${Math.max(0, rate - TAX_STEP).toFixed(2)}"${rate <= 0 ? ' disabled' : ''}>−5%</button>
        <button class="btn" style="flex:1;padding:8px;font-size:12px" data-prod="tax:${k}:${LAFFER_PEAK.toFixed(2)}">Пик ${Math.round(LAFFER_PEAK * 100)}%</button>
        <button class="btn" style="flex:1;padding:8px;font-size:12px" data-prod="tax:${k}:${Math.min(1, rate + TAX_STEP).toFixed(2)}"${rate >= 1 ? ' disabled' : ''}>+5%</button>
      </div></div>`;
  }
  return html;
}

function _upkeep(sim, S) {
  const rep = S.ecoReport;
  if (!rep) return '';
  const u = rep.upkeep;
  const era = sim.eraIndex || 0;
  const done = sim.buildings.filter(b => b.done && !b.destroyed).length;
  const debtRatio = u.need > 0 ? u.paid / u.need : 1;
  const col = debtRatio >= 0.999 ? 'var(--good)' : debtRatio > 0.5 ? 'var(--warn)' : 'var(--bad)';
  return `<h4 class="group">Содержание государства</h4>
    <div class="card"><div class="ttl"><span>Расход на день</span><span class="cost" style="color:${col}">−${_g(u.need)}🪙</span></div>
      <div class="desc">Здания ветшают вместе с эпохой: обслуживание дорожает в ${(1 + era * 0.25).toFixed(2)} раза против каменного века. ${done} построек содержится каждый день, хотите вы того или нет.</div>
      <div class="kv"><span>Войско</span><span>${sim.army.soldiers} чел.</span></div>
      <div class="kv"><span>Постройки</span><span>${done} шт. · −${_g(done * 0.04 * (1 + era * 0.25))}🪙</span></div>
      <div class="kv"><span>Чиновники</span><span>${u.officials} чел. · −${_g(u.officials * 0.5)}🪙</span></div>
      <div class="kv"><span>Выплачено вчера</span><span style="color:${col}">${_g(u.paid)} из ${_g(u.need)}🪙</span></div>
      ${u.arrears > 0 ? `<div class="reason">Жалование задержано ${u.arrears} ${_plural(u.arrears, 'день', 'дня', 'дней')} подряд: войско теряет дух (${industryMoraleMod(sim)}), город ропщет.</div>` : ''}</div>`;
}

function _debt(sim, S) {
  const loans = S.eco.loans;
  const debt = S.eco.debtTotal();
  let html = `<h4 class="group">Долг и монета</h4>
    <div class="card"><div class="ttl"><span>Долговая книга</span><span class="cost" style="color:${debt > 0 ? 'var(--warn)' : 'var(--good)'}">${debt > 0 ? `−${_g(debt)}🪙` : 'долгов нет'}</span></div>
      <div class="desc">Заём приходит одним куском, отдаётся с процентом в срок. Не отдали — дефолт: кредитная история рушится, стабильность падает на 15, соседи-кредиторы обижаются.</div>
      <div class="kv"><span>Кредитная история</span><span>${Math.round(S.eco.credit)} / 100</span></div></div>`;

  for (const L of loans) {
    const lender = L.lender === 'merchants' ? 'Купеческая гильдия' : _fname(sim, L.lender);
    const soon = L.daysLeft <= 10;
    const can = sim.res.gold >= L.owed;
    html += `<div class="card"><div class="ttl"><span>Заём №${L.id} · ${lender}</span>
        <span class="cost" style="color:${soon ? 'var(--bad)' : 'var(--warn)'}">${_g(L.owed)}🪙 через ${L.daysLeft} дн.</span></div>
      <div class="desc">Взято ${_g(L.principal)}🪙 под ${Math.round(L.rate * 100)}% за срок. ${soon ? 'Срок близко — держите золото под рукой.' : ''}</div>
      <button class="btn ${can ? '' : 'disabled'}" style="width:100%;margin-top:8px;padding:8px;font-size:12px"
        data-prod="repay:${L.id}"${can ? '' : ' disabled'}>Погасить досрочно за ${_g(L.owed)}🪙${can ? '' : ' — не хватает золота'}</button></div>`;
  }

  // Кредиторы: гильдия всегда, соседи — если не воюем.
  const lenders = [{ id: 'merchants', name: 'Купеческая гильдия' }];
  for (const f of (sim.factions || [])) {
    if (!f.alive) continue;
    if ((sim.wars || []).some(w => w.fid === f.id)) continue;
    lenders.push({ id: f.id, name: f.def ? f.def.name : f.id });
  }
  for (const l of lenders) {
    const offers = LOAN_LOTS.map(a => S.eco.loanOffer(sim, l.id, a));
    const rate = offers[0].rate;
    const btns = offers.map(o =>
      `<button class="btn" style="flex:1;padding:8px;font-size:12px" data-prod="loan:${l.id}:${o.amount}">${o.amount}🪙 → вернуть ${_g(o.owed)}</button>`).join('');
    html += `<div class="card"><div class="ttl"><span>Занять у: ${l.name}</span><span class="cost">${Math.round(rate * 100)}% за 60 дней</span></div>
      <div class="desc">Ставка падает от хороших отношений и чистой кредитной истории. Изгою и банкроту дают под 60%.</div>
      <div class="btns" style="display:flex;gap:8px;margin-top:8px">${btns}</div></div>`;
  }

  const mint = MINT_LOTS.map(a =>
    `<button class="btn" style="flex:1;padding:8px;font-size:12px" data-prod="mint:${a}">Отчеканить ${a}🪙</button>`).join('');
  html += `<div class="card"><div class="ttl"><span>Печатный станок</span><span class="cost">${S.eco.priceLevel.toFixed(2)}× цены</span></div>
    <div class="desc">Золото появляется сразу, а расплата приходит позже: напечатанное давит на цены вдвойне, пока не рассосётся. Дважды подряд — и монета обесценится.</div>
    <div class="btns" style="display:flex;gap:8px;margin-top:8px">${mint}</div></div>`;
  return html;
}

function _routes(sim, S) {
  let html = '<h4 class="group">Торговые пути</h4>';
  const ctx = routeCtx(sim);

  if (!sim.techs.has('trade')) {
    return html + `<div class="card"><div class="ttl"><span>Караванов нет</span></div>
      <div class="desc">Нужна технология «Торговля» на вкладке «Наука», затем Рынок — он и есть точка отправления караванов.</div></div>`;
  }
  const limit = maxRoutes(ctx);
  const cls = routeClass(ctx);

  html += `<div class="card"><div class="ttl"><span>Караванная служба</span><span class="cost">${S.prod.routes.length} / ${limit}</span></div>
    <div class="desc">Дорога: ${cls.ru} (скорость ${cls.speed.toFixed(1)}, наценка ×${cls.mult.toFixed(2)}). Класс дороги растёт от технологий: колесо → строительство → железные дороги с вокзалом.</div>
    <div class="kv"><span>Всего заработано путями</span><span>${_g(S.prod.tradeGold)}🪙 за ${S.prod.trips} ${_plural(S.prod.trips, 'рейс', 'рейса', 'рейсов')}</span></div>
    ${limit ? '' : '<div class="reason">Нужен Рынок: караванам неоткуда выходить.</div>'}</div>`;

  for (const r of S.prod.routes) {
    const info = routeInfo(r, ctx);
    const risk = routeRisk(sim, r.faction);
    const riskCol = risk > 0.15 ? 'var(--bad)' : risk > 0.05 ? 'var(--warn)' : 'var(--good)';
    const riskTxt = risk <= 0.001 ? 'безопасно' : `${Math.round(risk * 100)}% ограбления за рейс`;
    const cargo = r.cargo ? `${INTER_BY_ID[r.cargo.res].icon} ${Math.round(r.cargo.amount)}` : 'пусто';
    html += `<div class="card"><div class="ttl"><span>🐫 ${info.name}</span>
        <span class="cost" style="color:${info.broken ? 'var(--bad)' : 'var(--good)'}">${info.broken ? 'путь разорван' : `+${_g(info.goldPerDay)}🪙/день`}</span></div>
      <div class="desc">${info.status}. Рейс туда-обратно — ${info.tripDays.toFixed(1)} дн., за рейс ${_g(info.goldPerTrip)}🪙.</div>
      <div class="kv"><span>Длина пути</span><span>${_tiles(info.length)} · ${info.road}</span></div>
      <div class="kv"><span>Безопасность</span><span style="color:${riskCol}">${riskTxt}</span></div>
      <div class="kv"><span>Груз в телеге</span><span>${cargo}</span></div>
      <div class="kv"><span>Сделано рейсов</span><span>${info.trips} · заработано ${_g(info.earned)}🪙</span></div>
      ${info.broken ? `<div class="reason">${info.status}</div>` : ''}
      <button class="btn danger" style="width:100%;margin-top:8px;padding:8px;font-size:12px" data-prod="unroute:${r.id}">Снять маршрут</button></div>`;
  }

  for (const p of routePlans(sim)) {
    if (p.plan.ok) {
      const i = p.plan.info;
      const risk = routeRisk(sim, p.fid);
      const full = S.prod.routes.length >= limit;
      html += `<div class="card"><div class="ttl"><span><span style="color:${p.color}">⬤</span> ${p.name}</span>
          <span class="cost">+${_g(i.goldPerDay)}🪙/день</span></div>
        <div class="desc">Путь длиной ${_tiles(i.length)}, рейс ${i.tripDays.toFixed(1)} дн. Дальняя торговля выгоднее ближней: надбавка растёт с длиной.</div>
        <div class="kv"><span>Риск разбоя</span><span style="color:${risk > 0.05 ? 'var(--warn)' : 'var(--good)'}">${risk <= 0.001 ? 'нет' : `${Math.round(risk * 100)}% за рейс`}</span></div>
        <button class="btn ${full ? 'disabled' : ''}" style="width:100%;margin-top:8px;padding:8px;font-size:12px"
          data-prod="route:${p.fid}"${full ? ' disabled' : ''}>Проложить путь${full ? ' — лимит исчерпан' : ''}</button></div>`;
    } else {
      html += `<div class="card disabled"><div class="ttl"><span><span style="color:${p.color}">⬤</span> ${p.name}</span></div>
        <div class="reason">${p.plan.reason}</div></div>`;
    }
  }
  return html;
}

// ════════════════════ ДЕЙСТВИЯ ════════════════════

// Разбор строки вида 'tax:poll:0.25'. Отдельная функция, потому что вся проверка
// должна быть доступна без DOM — и консоли, и тесту.
export function handleIndustryAction(sim, spec) {
  const S = sim && sim.industry;
  if (!S) return { ok: false, reason: 'Хозяйство не подключено' };
  const parts = String(spec || '').split(':');
  const kind = parts[0];

  if (kind === 'tax') {
    const [, k, raw] = parts;
    const rate = Number(raw);
    if (!isFinite(rate)) return { ok: false, reason: 'Неверная ставка' };
    const r = S.eco.setTaxRate(k, rate);
    if (!r.ok) return r;
    const meta = TAX_META[k];
    return { ok: true, sound: 'click', text: `${meta ? meta.ru : k} налог: ${Math.round(rate * 100)}%` };
  }

  if (kind === 'loan') {
    const [, lender, raw] = parts;
    const amount = Number(raw);
    if (!(amount > 0)) return { ok: false, reason: 'Неверная сумма займа' };
    const r = S.eco.takeLoan(sim, { lender, amount });
    if (!r.ok) return r;
    return { ok: true, sound: 'coin', text: `Взято ${amount}🪙 в долг: вернуть ${Math.round(r.loan.owed)}🪙 через ${r.loan.daysLeft} дн.` };
  }

  if (kind === 'repay') {
    const id = Number(parts[1]);
    const r = S.eco.repayLoan(sim, id);
    if (!r.ok) return r;
    return { ok: true, sound: 'coin', text: `Заём №${id} погашен досрочно.` };
  }

  if (kind === 'mint') {
    const amount = Number(parts[1]);
    const r = S.eco.mintGold(sim, amount);
    if (!r.ok) return r;
    return { ok: true, sound: 'coin', text: `Отчеканено ${amount}🪙 — цены поползут вверх.` };
  }

  if (kind === 'route') {
    const fid = parts[1];
    const f = sim.faction ? sim.faction(fid) : null;
    if (!f) return { ok: false, reason: 'Такого соседа нет' };
    const to = f.settlements && f.settlements[0];
    if (!to) return { ok: false, reason: 'У соседа нет городов' };
    const r = addRoute(S.prod, routeCtx(sim), { faction: fid, from: homePoint(sim), to });
    if (!r.ok) return r;
    S.planCache = { day: -1, map: {} };   // план израсходован — пересчитать на следующем кадре
    return { ok: true, sound: 'coin', text: `Путь до ${f.def ? f.def.name : fid} проложен.` };
  }

  if (kind === 'unroute') {
    const id = Number(parts[1]);
    if (!removeRoute(S.prod, id)) return { ok: false, reason: 'Такого маршрута нет' };
    S.planCache = { day: -1, map: {} };
    return { ok: true, sound: 'click', text: 'Маршрут снят.' };
  }

  return { ok: false, reason: 'Неизвестная операция' };
}

// Привязка обработчиков — по образцу bindMarketPanel: свои data-атрибуты в
// переданном корне, никаких обращений к document.
// opts: { toast(text,type), audio.play(name), refresh() }
export function bindIndustryPanel(root, sim, opts = {}) {
  if (!root || typeof root.querySelectorAll !== 'function' || !sim) return 0;
  let bound = 0;

  for (const el of Array.from(root.querySelectorAll('[data-prod]'))) {
    const spec = (el.dataset && el.dataset.prod) ||
      (typeof el.getAttribute === 'function' ? el.getAttribute('data-prod') : '');
    el.onclick = () => {
      const r = handleIndustryAction(sim, spec);
      if (!r.ok) {
        if (opts.toast) opts.toast(r.reason, 'warn');
        if (opts.audio) opts.audio.play('deny');
      } else {
        if (opts.toast && r.text) opts.toast(r.text, 'good');
        if (opts.audio) opts.audio.play(r.sound || 'click');
      }
      if (opts.refresh) opts.refresh();
      return r;
    };
    bound++;
  }

  // Шкала налога. Панель перерисовывается четыре раза в секунду, поэтому узел
  // живёт недолго: тычок ставит ставку сразу, протяжка работает до ближайшей
  // перерисовки — за точной подгонкой есть кнопки ±5%.
  for (const el of Array.from(root.querySelectorAll('[data-prod-track]'))) {
    const kind = (el.dataset && el.dataset.prodTrack) ||
      (typeof el.getAttribute === 'function' ? el.getAttribute('data-prod-track') : '');
    const rateAt = (ev) => {
      if (typeof el.getBoundingClientRect !== 'function') return null;
      const box = el.getBoundingClientRect();
      const w = box.width || 1;
      const f = Math.max(0, Math.min(1, ((ev.clientX ?? 0) - box.left) / w));
      return Math.round(f * 100) / 100;
    };
    el.onpointerdown = (ev) => {
      const rate = rateAt(ev);
      if (rate === null) return;
      handleIndustryAction(sim, `tax:${kind}:${rate}`);
      if (opts.audio) opts.audio.play('click');
      if (opts.refresh) opts.refresh();
    };
    el.onpointermove = (ev) => {
      // Тянем только с зажатой кнопкой; перерисовку не дёргаем — иначе узел
      // умрёт под пальцем на первом же движении.
      if (!(ev.buttons & 1)) return;
      const rate = rateAt(ev);
      if (rate !== null) handleIndustryAction(sim, `tax:${kind}:${rate}`);
    };
    bound++;
  }
  return bound;
}

// ════════════════════ ФОРМАТИРОВАНИЕ ════════════════════

// Суммы: копейки важны на мелких, сотни золота — уже нет.
function _g(v) {
  const a = Math.abs(v);
  if (!isFinite(v)) return '—';
  if (a >= 100) return String(Math.round(v));
  return (Math.round(v * 10) / 10).toFixed(1);
}

// Штуки товара: 0.05/день должно читаться как 0.05, а не как 0.
function _n(v) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 10) return String(Math.round(v));
  if (a >= 1) return (Math.round(v * 10) / 10).toFixed(1);
  return (Math.round(v * 100) / 100).toFixed(2);
}

function _plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// Знак пишем типографским минусом: «-16» в интерфейсе читается как дефис.
function _sign(v, fmt = _g) {
  if (!isFinite(v)) return '—';
  const r = Math.abs(v) < 0.005 ? 0 : v;
  return (r > 0 ? '+' : r < 0 ? '\u2212' : '') + fmt(Math.abs(r));
}

function _tiles(n) {
  const k = Math.round(n);
  return `${k} ${_plural(k, 'клетка', 'клетки', 'клеток')}`;
}

// Заглавная буква после точки: note приходит из production.js строчной.
function _up(t) { return t ? t[0].toUpperCase() + t.slice(1) : t; }

function _fname(sim, fid) {
  const f = sim.faction ? sim.faction(fid) : null;
  return f && f.def ? f.def.name : 'соседи';
}

/* ПОДКЛЮЧЕНИЕ

── app/src/core/simulation.js ──────────────────────────────────────────────

1) ЯКОРЬ (строка 7, единственная в файле):
import { installSystems, systemsNewDay, systemsFactions, systemsHappyMod, systemsWorkMult, systemsSerialize, systemsRestore } from './systems/integrate.js';
   ВСТАВИТЬ ПОСЛЕ:
import { installIndustry, industryNewDay, industryHappyMod, industrySerialize, industryRestore, enableChainBuildings } from './systems/wire_production.js';

2) ЯКОРЬ (в конструкторе Simulation, единственная в файле):
    installSystems(this);
   ВСТАВИТЬ ПОСЛЕ:
    installIndustry(this);

3) ЯКОРЬ (в onNewDay, единственная в файле):
    systemsNewDay(this);
   ВСТАВИТЬ ПОСЛЕ:
    industryNewDay(this);

4) ЯКОРЬ (в happiness, единственная в файле):
    h += systemsHappyMod(this);
   ВСТАВИТЬ ПОСЛЕ:
    h += industryHappyMod(this);

5) ЯКОРЬ (в serialize, единственная в файле):
      sys: systemsSerialize(this),
   ВСТАВИТЬ ПОСЛЕ:
      industry: industrySerialize(this),

6) ЯКОРЬ (в deserialize, единственная в файле):
    systemsRestore(sim, data.sys);
   ВСТАВИТЬ ПОСЛЕ:
    industryRestore(sim, data.industry);

── app/src/ui/hud.js ───────────────────────────────────────────────────────

7) ЯКОРЬ (строка 6, единственная в файле):
import { renderMarketPanel, bindMarketPanel, createMarketPanelState } from './panel_market.js';
   ВСТАВИТЬ ПОСЛЕ:
import { renderIndustryPanel, bindIndustryPanel } from '../core/systems/wire_production.js';

8) ЯКОРЬ (в массиве TABS, единственная в файле):
  { id: 'market', ru: 'Рынок', ic: '⚖️' },
   ВСТАВИТЬ ПОСЛЕ:
  { id: 'prod', ru: 'Хозяйство', ic: '🏭' },

9) ЯКОРЬ (метод панели рынка, единственная в файле):
  panel_market() { return renderMarketPanel(this.sim, this.marketState); }
   ВСТАВИТЬ ПОСЛЕ:
  panel_prod() { return renderIndustryPanel(this.sim); }

10) ЯКОРЬ (конец метода bindPanel — единственный такой блок в файле):
    bindMarketPanel(root, this.sim, {
      toast: (t, k) => this.toast(t, k),
      audio: this.audio,
      refresh: () => this.renderPanel(),
    });
   ВСТАВИТЬ ПОСЛЕ:
    bindIndustryPanel(root, this.sim, {
      toast: (t, k) => this.toast(t, k),
      audio: this.audio,
      refresh: () => this.renderPanel(),
    });

── НЕОБЯЗАТЕЛЬНО ───────────────────────────────────────────────────────────

11) Два новых здания цепочек — Плавильня и Пекарня. Без них плавку тянет
    кузница вполсилы, а выпечку — амбар: тупика нет, но цепочки не раскрываются.
    Включается ОДНОЙ строкой — в шаге 2 вставить не одну строку, а две:
    installIndustry(this);
    enableChainBuildings();   // и дописать в импорт шага 1
    После этого оба здания появятся на вкладке «Стройка» (Плавильня требует
    бронзу, Пекарня — гончарное дело). Спрайтов у них нет — рендер отрисует их
    процедурно, как и любое здание без картинки.

12) Рендер маршрутов на карте (app/src/render/renderer.js), если дойдут руки.
    routePoints и caravanPos брать из '../core/systems/production.js':
      for (const r of sim.production.routes) {
        const pts = routePoints(r);      // [{x,y}...] — линия пути в клетках
        const car = caravanPos(r);       // {x,y} — точка каравана
        // r.broken → рисовать красным пунктиром
      }

13) Боевой дух: как только в ядре появится расчёт морали, прибавить туда
      morale += industryMoraleMod(this);   // до −30 при задержках жалования

── ВНИМАНИЕ ────────────────────────────────────────────────────────────────

installIndustry ставит sim.production и sim.economy. Если параллельный агент
подключит economy.js или production.js ещё раз своим кодом, налоги начислятся
дважды, а караваны сходят по два рейса в день. Подключать что-то одно.
*/
