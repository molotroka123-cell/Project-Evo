// ui/panel_market.js — экран рынка (U16).
// Модуль интерфейса: возвращает готовую HTML-строку панели (как panel_* в hud.js)
// и вешает обработчики на уже отрендеренные узлы. К document/window не обращается —
// корневой элемент всегда приходит аргументом, поэтому модуль тестируется headless.
//
// ПОЧЕМУ ТАК. Ядро уже умеет всё: marketRate() даёт курс с учётом договоров и
// Сокровищницы, marketSell()/marketBuy() проводят сделку и сами проверяют условия.
// Панель ничего не считает «своей» экономикой — она показывает те же числа, что
// получит игрок при нажатии, и повторно валидирует лишь для того, чтобы погасить
// заведомо невозможную кнопку и назвать причину до клика.
//
// ═══════════════ INTEGRATION ═══════════════
// В app/src/ui/hud.js (я НЕ редактировал этот файл — вставку делает интегратор):
//
// 1) Импорт рядом с остальными:
//      import { renderMarketPanel, bindMarketPanel, createMarketPanelState,
//               serializeMarketPanel, deserializeMarketPanel } from './panel_market.js';
//
// 2) В массив TABS добавить вкладку (лучше сразу после 'diplo'):
//      { id: 'market', ru: 'Рынок', ic: '⚖️' },
//
// 3) В конструкторе Hud, рядом с this.tab = 'build':
//      this.marketState = createMarketPanelState();
//
// 4) Метод панели — renderPanel() зовёт this['panel_' + this.tab](), больше ничего не нужно:
//      panel_market() { return renderMarketPanel(this.sim, this.marketState); }
//
// 5) В КОНЦЕ метода bindPanel(root) добавить одну строку:
//      bindMarketPanel(root, this.sim, {
//        toast: (t, k) => this.toast(t, k),
//        audio: this.audio,
//        refresh: () => this.renderPanel(),
//      });
//    Существующие в bindPanel обработчики [data-sell]/[data-buy] этой панели не
//    касаются: я намеренно взял отдельный атрибут data-market, иначе их
//    `c.onclick = ...` затёр бы мой и любая кнопка продавала бы ровно 20 единиц.
//    После интеграции те два блока можно удалить — их некому больше обслуживать.
//
// 6) Сейв (необязательно). Состояние панели — только история курсов для стрелки
//    тренда, игра без неё полностью работоспособна. Если хочется переносить её
//    через сохранение, в main.js: при сохранении положить
//      marketPanel: serializeMarketPanel(hud.marketState)
//    при загрузке — hud.marketState = deserializeMarketPanel(data.marketPanel).
//    Без этого история просто наберётся заново за ближайшие дни.
// ═══════════════════════════════════════════

import { RES, MARKET_BASE, BUILDINGS, TECHS, FACTIONS } from '../core/data.js';

// Торгуемые ресурсы: ровно те, для которых ядро ведёт курс в market.prices.
// Золото — средство расчёта, знания на рынке не продаются.
export const TRADE_RES = Object.keys(MARKET_BASE);

// Партии на кнопках. Мелкая — «подлатать дыру», крупная — «разгрузить склад».
export const LOTS = [20, 100];

// Наценка при покупке зашита в Simulation.marketBuy: покупаем дороже, чем продаём.
const BUY_MARKUP = 1.25;
// Караван приходит раз в 15 дней (Simulation.caravanTimer).
const CARAVAN_PERIOD = 15;
// Глубина истории курсов. 12 дней — половина сезона: достаточно, чтобы отличить
// сезонный тренд от дневного шума, и достаточно мало, чтобы не пухнуть в сейве.
const HIST_LEN = 12;
// Порог «шевеления» курса, ниже которого считаем цену стоящей на месте.
const FLAT = 0.02;

const RES_META = Object.fromEntries(RES.map(r => [r.id, r]));

// ---------- Состояние панели (сериализуемое) ----------

export function createMarketPanelState() {
  return { v: 1, hist: [] };
}

// Снимок курсов за игровой день. Пишется не чаще раза в день: панель
// перерисовывается каждый кадр, и без этой отсечки история забилась бы
// шестьюдесятью одинаковыми записями в секунду.
export function observeMarket(state, sim) {
  if (!state || !sim) return state;
  if (!Array.isArray(state.hist)) state.hist = [];
  const day = Math.floor(sim.day || 0);
  const last = state.hist[state.hist.length - 1];
  if (last && last.day === day) return state;
  // Загрузили сейв более раннего дня — старая история уже не про этот мир.
  if (last && day < last.day) state.hist.length = 0;
  const p = {};
  for (const id of TRADE_RES) p[id] = rawPrice(sim, id);
  state.hist.push({ day, p });
  if (state.hist.length > HIST_LEN) state.hist.shift();
  return state;
}

export function serializeMarketPanel(state) {
  const src = state && Array.isArray(state.hist) ? state.hist : [];
  return { v: 1, hist: src.map(h => ({ day: h.day, p: { ...h.p } })) };
}

export function deserializeMarketPanel(data) {
  const state = createMarketPanelState();
  if (!data || !Array.isArray(data.hist)) return state;
  for (const h of data.hist.slice(-HIST_LEN)) {
    if (!h || typeof h.day !== 'number' || !h.p) continue;
    const p = {};
    for (const id of TRADE_RES) p[id] = Number(h.p[id]) || MARKET_BASE[id];
    state.hist.push({ day: h.day, p });
  }
  return state;
}

// ---------- Расчёты для показа ----------

// «Голая» рыночная цена без бонусов игрока — её и сравниваем с базовой,
// иначе Сокровищница выглядела бы как подорожание товара.
export function rawPrice(sim, resId) {
  const prices = sim && sim.market ? sim.market.prices : null;
  const p = prices ? prices[resId] : undefined;
  return typeof p === 'number' && isFinite(p) ? p : MARKET_BASE[resId];
}

// Куда ушёл курс относительно базового и куда двигался последние дни.
export function priceTrend(sim, resId, state) {
  const base = MARKET_BASE[resId];
  const price = rawPrice(sim, resId);
  const ratio = base ? price / base : 1;
  const out = {
    price, base, ratio,
    pct: Math.round((ratio - 1) * 100),
    dir: ratio > 1 + FLAT ? 1 : ratio < 1 - FLAT ? -1 : 0,
    recent: 0, days: 0,
  };
  const hist = state && Array.isArray(state.hist) ? state.hist : [];
  if (hist.length >= 2) {
    const first = hist[0];
    const was = Number(first.p[resId]);
    if (was > 0) {
      const d = price / was - 1;
      out.recent = d > FLAT ? 1 : d < -FLAT ? -1 : 0;
      out.days = Math.max(1, Math.floor(sim.day || 0) - first.day);
    }
  }
  return out;
}

// Полная выкладка по ресурсу: что и почём, что можно нажать и почему нельзя.
export function marketQuote(sim, resId, state) {
  const meta = RES_META[resId] || { icon: '', ru: resId };
  const rate = sim.marketRate(resId);
  const have = Math.floor(sim.res[resId] || 0);
  const cap = sim.resCap && isFinite(sim.resCap[resId]) ? sim.resCap[resId] : Infinity;
  const room = Math.max(0, Math.floor(cap - (sim.res[resId] || 0)));
  const gold = sim.res.gold || 0;
  const t = priceTrend(sim, resId, state);
  const lots = LOTS.map(n => {
    const income = n * rate;
    const price = n * rate * BUY_MARKUP;
    return {
      n, income, price,
      canSell: have >= n,
      canBuy: gold >= price && room >= n,
      // Причина всегда одна и самая важная: нет товара / нет денег / некуда класть.
      buyWhy: room < n ? 'склад полон' : gold < price ? 'мало 🪙' : '',
    };
  });
  return { id: resId, icon: meta.icon, ru: meta.ru, rate, buyRate: rate * BUY_MARKUP, have, cap, room, trend: t, lots };
}

// Караван: ядро начисляет золото раз в 15 дней по числу рынков и множителям.
// Формула повторена здесь ТОЛЬКО для показа ожидаемой суммы — игрок должен
// понимать, за что ему капает, а трогать simulation.js мне нельзя.
export function caravanStatus(sim) {
  if (!sim.techs || !sim.techs.has('trade')) {
    return { active: false, markets: 0, daysLeft: 0, gold: 0, period: CARAVAN_PERIOD, boosts: [] };
  }
  const markets = sim.countBuilding('market');
  let gold = 0.6 * markets * sim.globalMult('gold');
  const boosts = [];
  if (sim.hasBuilding('shipyard')) { gold *= 1.5; boosts.push('Верфь ×1.5'); }
  if (sim.hasBuilding('train_station')) { gold *= 2; boosts.push('Вокзал ×2'); }
  if (sim.hasBuilding('airport')) { gold *= 2; boosts.push('Аэропорт ×2'); }
  if (sim.techs.has('internet')) { gold *= 1.25; boosts.push('Интернет ×1.25'); }
  const daysLeft = Math.max(0, Math.ceil(sim.caravanTimer ?? CARAVAN_PERIOD));
  return { active: markets > 0, markets, daysLeft, gold, period: CARAVAN_PERIOD, boosts };
}

// Торговые договоры: их наличие снимает 30% наценку в marketRate.
export function tradeTreaties(sim) {
  const list = Array.isArray(sim.treaties) ? sim.treaties : [];
  return list.map(t => {
    const f = typeof sim.faction === 'function' ? sim.faction(t.b) : null;
    const def = (f && f.def) || FACTIONS.find(x => x.id === t.b) || null;
    return {
      fid: t.b,
      name: def ? def.name : 'Неизвестный сосед',
      leader: def ? def.leader : '',
      color: def ? def.color : '#c9a227',
      atWar: (sim.wars || []).some(w => w.fid === t.b),
    };
  });
}

// Почему рынка нет и что с этим делать. Возвращает null, если рынок работает.
export function marketBlocker(sim) {
  if (sim.hasBuilding('market')) return null;
  const def = BUILDINGS.market;
  if (!sim.techs.has('trade')) {
    const tech = TECHS.find(t => t.id === 'trade');
    return { kind: 'tech', tech: tech ? tech.name : 'Торговля', cost: sim.techCost(tech), buildCost: def.cost };
  }
  const site = sim.buildings.find(b => b.id === 'market' && !b.destroyed && !b.done);
  if (site) {
    const pct = Math.round((site.progress / site.buildDays) * 100);
    return { kind: 'building', progress: Math.max(0, Math.min(99, pct)), buildCost: def.cost };
  }
  return { kind: 'place', lack: sim.lackCost(def.cost), buildCost: def.cost };
}

// ---------- Отрисовка ----------

export function renderMarketPanel(sim, state = null) {
  if (!sim) return '';
  observeMarket(state, sim);
  const blocker = marketBlocker(sim);
  if (blocker) return _renderClosed(sim, blocker);

  let html = _renderHeader(sim);
  html += '<h4 class="group">Курсы и сделки</h4>';
  for (const id of TRADE_RES) html += _renderRow(marketQuote(sim, id, state));
  html += _renderTrade(sim);
  return html;
}

// Рынка нет — панель обязана объяснить это словами, а не пустотой.
function _renderClosed(sim, b) {
  const cost = _costStr(sim, b.buildCost);
  let head = '';
  if (b.kind === 'tech') {
    head = `<div class="card"><div class="ttl"><span>Рынок закрыт</span><span class="cost">📜${b.cost}</span></div>
      <div class="desc">Обмен ресурсов открывает технология «${b.tech}» на вкладке «Наука».</div>
      <div class="reason">Сначала изучите «${b.tech}», затем постройте Рынок: ${cost}</div></div>`;
  } else if (b.kind === 'building') {
    head = `<div class="card"><div class="ttl"><span>Рынок строится</span><span class="cost">${b.progress}%</span></div>
      <div class="desc">Торги откроются, как только каменщики закончат. Приставьте больше рабочих на вкладке «Труд» — приоритет «Стройка».</div></div>`;
  } else {
    head = `<div class="card"><div class="ttl"><span>Рынка нет</span><span class="cost">${cost}</span></div>
      <div class="desc">Постройте Рынок на вкладке «Стройка»: особой клетки он не требует, ставится где угодно в поселении.</div>
      ${b.lack ? `<div class="reason">Не хватает: ${b.lack}</div>` : '<div class="desc">Ресурсов на постройку хватает.</div>'}</div>`;
  }
  return head + `<div class="card"><div class="ttl"><span>Что даёт Рынок</span></div>
    <div class="kv"><span>Продажа</span><span>Излишки 🍞🪵🪨⚙️ в 🪙</span></div>
    <div class="kv"><span>Покупка</span><span>Нехватка за 🪙 (дороже на 25%)</span></div>
    <div class="kv"><span>Караваны</span><span>🪙 раз в ${CARAVAN_PERIOD} дней</span></div>
    <div class="kv"><span>Договоры</span><span>Снимают наценку 30%</span></div></div>`;
}

function _renderHeader(sim) {
  const treaties = tradeTreaties(sim);
  const markets = sim.countBuilding('market');
  const treasury = sim.hasBuilding('treasury');
  return `<div class="card"><div class="ttl"><span>Рынок</span><span class="cost">🪙 ${_gold(sim.res.gold)}</span></div>
    <div class="desc">Курс — золото за одну единицу товара. Покупка дороже продажи на 25%: посредник тоже ест.</div>
    <div class="kv"><span>Рынков в поселении</span><span>${markets}</span></div>
    <div class="kv"><span>Торговые договоры</span><span>${treaties.length ? `${treaties.length} · курс без наценки` : 'нет · курс хуже на 30%'}</span></div>
    <div class="kv"><span>Сокровищница</span><span>${treasury ? 'есть · курс +20%' : 'нет'}</span></div></div>`;
}

function _renderRow(q) {
  const t = q.trend;
  const arrow = t.dir > 0 ? '▲' : t.dir < 0 ? '▼' : '=';
  const col = t.dir > 0 ? 'var(--good)' : t.dir < 0 ? 'var(--bad)' : 'var(--warn)';
  const sign = t.pct > 0 ? '+' : '';
  // Шкала 0.5×–2.0× — те же границы, в которых ядро зажимает цену в tickMarket.
  const width = Math.max(0, Math.min(100, ((t.ratio - 0.5) / 1.5) * 100));
  const recent = t.days
    ? ` · за ${t.days} дн. ${t.recent > 0 ? 'дорожает' : t.recent < 0 ? 'дешевеет' : 'стоит'}`
    : '';
  const stock = isFinite(q.cap) ? `${q.have}/${q.cap}` : `${q.have}`;

  let btns = '<div class="btns" style="display:flex;gap:8px;margin-top:8px">';
  for (const l of q.lots) {
    btns += `<button class="btn ${l.canSell ? '' : 'disabled'}" style="flex:1;padding:8px;font-size:12px"
      data-market="sell:${q.id}:${l.n}"${l.canSell ? '' : ' disabled'}>Продать ${l.n} → +${_gold(l.income)}🪙</button>`;
  }
  btns += '</div><div class="btns" style="display:flex;gap:8px;margin-top:6px">';
  for (const l of q.lots) {
    btns += `<button class="btn ${l.canBuy ? '' : 'disabled'}" style="flex:1;padding:8px;font-size:12px"
      data-market="buy:${q.id}:${l.n}"${l.canBuy ? '' : ' disabled'}>Купить ${l.n} → −${_gold(l.price)}🪙</button>`;
  }
  btns += '</div>';

  // Причина показывается одна на карточку: она объясняет самую крупную партию,
  // потому что мелкая обычно доступна и без подсказки понятно, что делать.
  const big = q.lots[q.lots.length - 1];
  const why = [];
  if (!big.canSell) why.push(`продать ${big.n}: в запасе ${q.have}`);
  if (!big.canBuy) why.push(`купить ${big.n}: ${big.buyWhy}`);

  return `<div class="card"><div class="ttl"><span>${q.icon} ${q.ru}</span>
      <span class="cost" style="color:${col}">${_rate(q.rate)}🪙 ${arrow} ${sign}${t.pct}% к базе</span></div>
    <div class="desc">В запасе ${stock} · продажа ${_rate(q.rate)}🪙 · покупка ${_rate(q.buyRate)}🪙${recent}</div>
    <div class="relbar"><div style="width:${width.toFixed(0)}%;background:${col}"></div></div>
    ${btns}
    ${why.length ? `<div class="reason">Недоступно: ${why.join(' · ')}</div>` : ''}</div>`;
}

// Караваны и договоры показываются только когда есть о чём говорить.
function _renderTrade(sim) {
  const car = caravanStatus(sim);
  const treaties = tradeTreaties(sim);
  if (!car.active && !treaties.length) return '';
  let html = '<h4 class="group">Караваны и договоры</h4>';
  if (car.active) {
    html += `<div class="card"><div class="ttl"><span>🐫 Караван в пути</span><span class="cost">+${_gold(car.gold)}🪙</span></div>
      <div class="desc">Прибудет через ${car.daysLeft} дн., затем уходит снова: круг — ${car.period} дней.</div>
      <div class="kv"><span>Считается с рынков</span><span>${car.markets}</span></div>
      ${car.boosts.length ? `<div class="kv"><span>Ускорители</span><span>${car.boosts.join(' · ')}</span></div>` : ''}</div>`;
  }
  for (const t of treaties) {
    html += `<div class="card"><div class="ttl"><span><span style="color:${t.color}">⬤</span> ${t.name}</span>
        <span class="cost">${t.atWar ? 'война' : 'торговля'}</span></div>
      <div class="desc">${t.leader ? t.leader + ' · ' : ''}Договор снимает наценку 30% на все курсы.</div>
      ${t.atWar ? '<div class="reason">Идёт война: договор висит на волоске.</div>' : ''}</div>`;
  }
  return html;
}

// ---------- Действия ----------

// Разбор строки вида 'sell:wood:20'. Отдельная функция, потому что вся проверка
// сделки должна быть доступна без DOM — и тесту, и консоли.
export function handleMarketAction(sim, spec) {
  const parts = String(spec || '').split(':');
  const [kind, resId, raw] = parts;
  if (parts.length !== 3 || (kind !== 'sell' && kind !== 'buy')) return { ok: false, reason: 'Неизвестная операция' };
  if (!TRADE_RES.includes(resId)) return { ok: false, reason: 'Этот товар на рынке не торгуется' };
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return { ok: false, reason: 'Неверный объём сделки' };

  const goldBefore = sim.res.gold;
  const resBefore = sim.res[resId];
  const r = kind === 'sell' ? sim.marketSell(resId, n) : sim.marketBuy(resId, n);
  if (!r.ok) return { ok: false, reason: r.reason, kind, resId, amount: n };
  return {
    ok: true, kind, resId, amount: Math.abs(sim.res[resId] - resBefore),
    gold: Math.abs(sim.res.gold - goldBefore),
  };
}

// Привязка обработчиков — по образцу Hud.bindPanel: ищем свои data-атрибуты
// в переданном корне. opts: { toast(text,type), audio.play(name), refresh() }.
export function bindMarketPanel(root, sim, opts = {}) {
  if (!root || typeof root.querySelectorAll !== 'function' || !sim) return 0;
  const nodes = root.querySelectorAll('[data-market]');
  let bound = 0;
  for (const el of Array.from(nodes)) {
    const spec = (el.dataset && el.dataset.market) ||
      (typeof el.getAttribute === 'function' ? el.getAttribute('data-market') : '');
    el.onclick = () => {
      const r = handleMarketAction(sim, spec);
      if (!r.ok) {
        if (opts.toast) opts.toast(r.reason, 'warn');
        if (opts.audio) opts.audio.play('deny');
      } else {
        const meta = RES_META[r.resId];
        const icon = meta ? meta.icon : '';
        if (opts.toast) {
          opts.toast(r.kind === 'sell'
            ? `Продано ${r.amount}${icon}: +${_gold(r.gold)}🪙`
            : `Куплено ${r.amount}${icon}: −${_gold(r.gold)}🪙`, 'good');
        }
        if (opts.audio) opts.audio.play('coin');
      }
      if (opts.refresh) opts.refresh();
      return r;
    };
    bound++;
  }
  return bound;
}

// ---------- Мелочи форматирования ----------

// Курсы мелкие (еда — 0.1🪙), поэтому три знака; иначе всё слипается в «0.1».
function _rate(v) { return (Math.round(v * 1000) / 1000).toFixed(3); }

// Суммы: копейки важны только на мелких партиях, сотни золота — уже нет.
function _gold(v) {
  const a = Math.abs(v);
  if (a >= 100) return String(Math.round(v));
  return (Math.round(v * 10) / 10).toFixed(1);
}

function _costStr(sim, cost) {
  const m = typeof sim.costMult === 'function' ? sim.costMult() : 1;
  return Object.entries(cost || {}).map(([r, v]) => {
    const meta = RES_META[r];
    return `${meta ? meta.icon : r}${Math.ceil(v * m)}`;
  }).join(' ') || '—';
}
