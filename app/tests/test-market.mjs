// Тесты экрана рынка (U16). Запуск: node app/tests/test-market.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../src/core/simulation.js';
import { MARKET_BASE, RES } from '../src/core/data.js';
import {
  renderMarketPanel, bindMarketPanel, handleMarketAction, marketQuote, priceTrend,
  caravanStatus, tradeTreaties, marketBlocker, observeMarket,
  createMarketPanelState, serializeMarketPanel, deserializeMarketPanel,
  TRADE_RES, LOTS,
} from '../src/ui/panel_market.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const SRC = readFileSync(fileURLToPath(new URL('../src/ui/panel_market.js', import.meta.url)), 'utf8');
// Комментарии вырезаем: в шапке модуля слово document стоит законно — там описано,
// что модуль к нему как раз НЕ обращается.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const INDEX = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

// Партия с готовым рынком: placeFree ставит здание сразу достроенным,
// поэтому торги доступны без прокрутки сотни дней.
const withMarket = (seed = 42, opts = { factions: 3 }) => {
  const s = new Simulation(seed, opts);
  s.techs.add('trade');
  s.placeFree('market', s.world.startX + 2, s.world.startY);
  return s;
};
const specsOf = (html) => Array.from(html.matchAll(/data-market="([^"]+)"/g)).map(m => m[1]);
// Подделка DOM-корня: bindMarketPanel по контракту трогает только то, что ему дали.
const fakeRoot = (html) => {
  const els = specsOf(html).map(spec => ({ dataset: { market: spec }, onclick: null }));
  return { els, querySelectorAll: () => els };
};
const plain = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

// ---------------------------------------------------------------- чистота модуля
t('модуль чист: без Math.random, без DOM-глобалей, импорт только из core', () => {
  ok(!/Math\.random/.test(CODE), 'в модуле есть Math.random');
  ok(!/\b(document|window|localStorage)\b/.test(CODE), 'модуль лезет к глобальному DOM вместо переданного корня');
  const imports = Array.from(CODE.matchAll(/from\s+'([^']+)'/g)).map(m => m[1]);
  ok(imports.length > 0, 'модуль вообще ничего не импортирует');
  for (const p of imports) ok(p.startsWith('../core/'), `запрещённый импорт: ${p}`);
  console.log(`   импорты: ${imports.join(', ')}`);
});

// ---------------------------------------------------------------- рынка нет
t('рынка нет: объяснение, что построить, и ни одной кнопки сделки', () => {
  const s = new Simulation(7, { factions: 2 });
  const b1 = marketBlocker(s);
  ok(b1 && b1.kind === 'tech', 'без технологии блокер должен указывать на науку');
  const h1 = renderMarketPanel(s);
  ok(/Торговля/.test(h1), 'не названа технология «Торговля»');
  ok(/🪵25/.test(h1), 'не показана стоимость постройки Рынка');
  ok(specsOf(h1).length === 0, 'без рынка появились кнопки сделок');

  s.techs.add('trade');
  const b2 = marketBlocker(s);
  ok(b2.kind === 'place', 'с технологией, но без здания ожидается подсказка о стройке');
  const h2 = renderMarketPanel(s);
  ok(/Стройка/.test(h2), 'не сказано, где строить Рынок');
  ok(/хватает/.test(h2), 'не сказано, хватает ли ресурсов (на старте хватает)');
  const woodWas = s.res.wood;
  s.res.wood = 0;
  ok(/Не хватает: 🪵25/.test(renderMarketPanel(s)), 'не назван недостаток дерева');
  s.res.wood = woodWas;

  s.execCommand('give wood 300'); s.execCommand('give stone 300');
  ok(s.placeBuilding('market', s.world.startX + 2, s.world.startY), 'рынок не заложился');
  const b3 = marketBlocker(s);
  ok(b3.kind === 'building', 'заложенный рынок должен показываться как стройка');
  ok(/строится/i.test(renderMarketPanel(s)), 'не сказано, что рынок строится');
  console.log(`   этапы блокировки: наука → стройка → готово (прогресс ${b3.progress}%)`);
});

// ---------------------------------------------------------------- курсы
t('курс: продажа = marketRate ядра, покупка дороже ровно на 25%', () => {
  const s = withMarket();
  for (const id of TRADE_RES) {
    const q = marketQuote(s, id, null);
    ok(near(q.rate, s.marketRate(id)), `курс ${id} разошёлся с ядром`);
    ok(near(q.buyRate, q.rate * 1.25), `наценка покупки ${id} не 25%`);
    for (const l of q.lots) {
      ok(near(l.income, l.n * q.rate), `сумма продажи ${l.n} ${id} посчитана неверно`);
      ok(near(l.price, l.n * q.rate * 1.25), `сумма покупки ${l.n} ${id} посчитана неверно`);
    }
  }
  const html = renderMarketPanel(s);
  const specs = specsOf(html);
  ok(specs.length === TRADE_RES.length * LOTS.length * 2, `кнопок ${specs.length}, ожидалось ${TRADE_RES.length * LOTS.length * 2}`);
  for (const id of TRADE_RES) for (const n of LOTS) {
    ok(specs.includes(`sell:${id}:${n}`), `нет кнопки продажи ${id}×${n}`);
    ok(specs.includes(`buy:${id}:${n}`), `нет кнопки покупки ${id}×${n}`);
  }
  for (const r of RES) if (TRADE_RES.includes(r.id)) ok(html.includes(r.ru), `не показан ресурс ${r.ru}`);
  console.log(`   ${TRADE_RES.map(id => `${id} ${s.marketRate(id).toFixed(3)}🪙`).join(' · ')}`);
});

t('движение курса относительно базового: вверх, вниз и «на месте»', () => {
  const s = withMarket();
  s.market.prices.wood = MARKET_BASE.wood * 1.5;
  s.market.prices.stone = MARKET_BASE.stone * 0.6;
  s.market.prices.food = MARKET_BASE.food;
  const up = priceTrend(s, 'wood', null), down = priceTrend(s, 'stone', null), flat = priceTrend(s, 'food', null);
  ok(up.dir === 1 && up.pct === 50, `рост посчитан как ${up.pct}% (dir ${up.dir})`);
  ok(down.dir === -1 && down.pct === -40, `падение посчитано как ${down.pct}% (dir ${down.dir})`);
  ok(flat.dir === 0 && flat.pct === 0, 'ровный курс показан как движение');
  const html = renderMarketPanel(s);
  ok(/▲ \+50% к базе/.test(html), 'нет пометки роста к базовому курсу');
  ok(/▼ -40% к базе/.test(html), 'нет пометки падения к базовому курсу');
  ok(/= 0% к базе/.test(html), 'нет пометки стабильного курса');
  console.log(`   🪵 ${up.pct}% · 🪨 ${down.pct}% · 🍞 ${flat.pct}%`);
});

// ---------------------------------------------------------------- гашение кнопок
t('кнопка гаснет заранее и называет причину: нечего продать, нечем платить, некуда класть', () => {
  const s = withMarket();
  s.res.wood = 5; s.res.gold = 0;
  const q = marketQuote(s, 'wood', null);
  ok(!q.lots[0].canSell && !q.lots[1].canSell, 'продажа доступна при пустом складе');
  ok(!q.lots[0].canBuy && q.lots[0].buyWhy === 'мало 🪙', 'покупка без золота не заблокирована');

  s.res.gold = 10000;
  s.res.wood = s.resCap.wood; // склад забит под потолок
  const full = marketQuote(s, 'wood', null);
  ok(full.room === 0 && !full.lots[0].canBuy && full.lots[0].buyWhy === 'склад полон', 'покупка в переполненный склад разрешена');
  ok(full.lots[1].canSell, 'полный склад почему-то нельзя распродать');

  s.res.wood = 5;
  const html = renderMarketPanel(s);
  ok(/продать 100: в запасе 5/.test(html), 'причина запрета продажи не написана');
  ok(/disabled/.test(html), 'заблокированные кнопки не помечены disabled');
  // Ядро всё равно откажет, даже если игрок дотянется до погашенной кнопки.
  const r = handleMarketAction(s, 'sell:steel:100');
  ok(!r.ok && r.reason === 'Нечего продавать', `ядро пропустило пустую продажу: ${JSON.stringify(r)}`);
  console.log(`   запреты: нет товара / мало 🪙 / склад полон — все три отработали`);
});

// ---------------------------------------------------------------- сделки
t('сделка меняет казну и склад ровно на объявленные числа', () => {
  const s = withMarket();
  // 200 из 400 по потолку склада: после покупки 100 груз обязан лечь целиком,
  // иначе проверка ловила бы обрезку ядром, а не работу панели.
  s.res.wood = 200; s.res.gold = 100;
  const q = marketQuote(s, 'wood', null);
  const gold0 = s.res.gold, wood0 = s.res.wood;

  const sell = handleMarketAction(s, 'sell:wood:20');
  ok(sell.ok, 'продажа не прошла');
  ok(near(s.res.wood, wood0 - 20), 'со склада списалось не 20');
  ok(near(s.res.gold, gold0 + q.lots[0].income), 'в казну пришла не обещанная сумма');
  ok(near(sell.gold, q.lots[0].income) && sell.amount === 20, 'результат сделки описан неверно');

  const gold1 = s.res.gold, wood1 = s.res.wood;
  const buy = handleMarketAction(s, 'buy:wood:100');
  ok(buy.ok, 'покупка не прошла');
  ok(near(s.res.wood, wood1 + 100), 'на склад легло не 100');
  ok(near(s.res.gold, gold1 - q.lots[1].price), 'списалась не обещанная сумма');

  ok(!handleMarketAction(s, 'sell:gold:20').ok, 'золото продаётся само за себя');
  ok(!handleMarketAction(s, 'sell:knowledge:20').ok, 'знания попали на рынок');
  ok(!handleMarketAction(s, 'жулик').ok, 'мусорная команда исполнена');
  ok(!handleMarketAction(s, 'sell:wood:-5').ok, 'отрицательный объём принят');
  console.log(`   продали 20🪵 за ${sell.gold.toFixed(2)}🪙, купили 100🪵 за ${buy.gold.toFixed(2)}🪙`);
});

// ---------------------------------------------------------------- привязка
t('bindMarketPanel: вешает обработчики на data-market и дёргает колбэки', () => {
  const s = withMarket();
  s.res.wood = 300; s.res.gold = 500;
  const html = renderMarketPanel(s);
  const root = fakeRoot(html);
  const toasts = [], sounds = [];
  let refreshed = 0;
  const n = bindMarketPanel(root, s, {
    toast: (text, type) => toasts.push({ text, type }),
    audio: { play: (x) => sounds.push(x) },
    refresh: () => refreshed++,
  });
  ok(n === specsOf(html).length, `привязано ${n} кнопок из ${specsOf(html).length}`);
  ok(root.els.every(e => typeof e.onclick === 'function'), 'не у всех кнопок есть обработчик');

  const sellBtn = root.els.find(e => e.dataset.market === 'sell:wood:20');
  const wood0 = s.res.wood;
  sellBtn.onclick();
  ok(near(s.res.wood, wood0 - 20), 'клик не провёл продажу');
  ok(toasts.length === 1 && toasts[0].type === 'good' && /Продано 20/.test(toasts[0].text), `странный тост: ${JSON.stringify(toasts[0])}`);
  ok(sounds[0] === 'coin' && refreshed === 1, 'звук/перерисовка не вызваны');

  s.res.gold = 0;
  root.els.find(e => e.dataset.market === 'buy:steel:100').onclick();
  ok(toasts[1].type === 'warn' && sounds[1] === 'deny', 'отказ не показан игроку');
  ok(refreshed === 2, 'панель не перерисована после отказа');
  ok(bindMarketPanel(null, s) === 0 && bindMarketPanel(root, null) === 0, 'привязка без корня/симуляции не должна падать');
  console.log(`   ${n} кнопок, тосты: «${toasts[0].text}» / «${toasts[1].text}»`);
});

// ---------------------------------------------------------------- караваны и договоры
t('караваны и договоры показываются, когда они есть', () => {
  const s = withMarket();
  const car = caravanStatus(s);
  ok(car.active && car.gold > 0, 'караван с рынком должен работать');
  ok(car.daysLeft > 0 && car.daysLeft <= car.period, `странный срок каравана: ${car.daysLeft}`);
  let html = renderMarketPanel(s);
  ok(/Караван в пути/.test(html), 'караван не показан');
  ok(html.includes(`через ${car.daysLeft} дн.`), 'не показан срок прибытия каравана');

  ok(tradeTreaties(s).length === 0, 'откуда договоры на старте');
  ok(/курс хуже на 30%/.test(html), 'не объяснено, что без договора курс хуже');
  const rateBefore = s.marketRate('wood');

  const fid = s.factions[0].id;
  s.treaties.push({ b: fid, type: 'trade' });
  const list = tradeTreaties(s);
  ok(list.length === 1 && list[0].name === s.faction(fid).def.name, 'договор описан неверно');
  html = renderMarketPanel(s);
  ok(html.includes(list[0].name), 'имя партнёра не показано');
  ok(/курс без наценки/.test(html), 'не отмечено снятие наценки');
  const rateAfter = s.marketRate('wood');
  ok(rateAfter > rateBefore, `договор не улучшил курс: ${rateBefore} → ${rateAfter}`);

  // Без технологии торговли караванов не бывает вовсе.
  const raw = new Simulation(9, { factions: 1 });
  ok(!caravanStatus(raw).active, 'караван без технологии «Торговля»');
  console.log(`   караван +${car.gold.toFixed(2)}🪙 через ${car.daysLeft} дн.; договор поднял курс 🪵 ${rateBefore.toFixed(3)} → ${rateAfter.toFixed(3)}`);
});

// ---------------------------------------------------------------- состояние
t('история курсов: пишется раз в день, переживает JSON и даёт тренд', () => {
  const s = withMarket();
  const state = createMarketPanelState();
  s.day = 0; renderMarketPanel(s, state); renderMarketPanel(s, state);
  ok(state.hist.length === 1, `за один день записано ${state.hist.length} снимков`);

  s.day = 5;
  s.market.prices.wood = MARKET_BASE.wood * 1.4;
  const html = renderMarketPanel(s, state);
  ok(state.hist.length === 2, 'снимок нового дня не записан');
  ok(/за 5 дн\. дорожает/.test(html), 'тренд за последние дни не показан');

  const json = JSON.stringify(serializeMarketPanel(state));
  const back = deserializeMarketPanel(JSON.parse(json));
  ok(back.hist.length === state.hist.length, 'история не восстановлена');
  ok(near(back.hist[0].p.wood, state.hist[0].p.wood), 'курсы в истории разошлись');
  const trendBack = priceTrend(s, 'wood', back);
  ok(trendBack.recent === 1 && trendBack.days === 5, 'после загрузки тренд потерян');
  ok(deserializeMarketPanel(null).hist.length === 0, 'сейв без истории ломает панель');
  ok(deserializeMarketPanel({ hist: [{ мусор: 1 }] }).hist.length === 0, 'битая история не отфильтрована');

  // Откат в прошлое (загрузка раннего сейва) обнуляет чужую историю.
  s.day = 1; observeMarket(state, s);
  ok(state.hist.length === 1 && state.hist[0].day === 1, 'история из будущего пережила загрузку');
  console.log(`   ${json.length} байт на ${state.hist.length} снимок; тренд после загрузки восстановлен`);
});

// ---------------------------------------------------------------- оформление
t('вёрстка: только классы из index.html и только русский текст', () => {
  const s = withMarket();
  s.res.wood = 5; s.res.gold = 5;
  s.treaties.push({ b: s.factions[0].id, type: 'trade' });
  const htmls = [renderMarketPanel(s, createMarketPanelState()), renderMarketPanel(new Simulation(3, { factions: 0 }))];

  const style = INDEX.slice(INDEX.indexOf('<style>'), INDEX.indexOf('</style>'));
  const known = new Set(Array.from(style.matchAll(/\.([A-Za-z][\w-]*)/g)).map(m => m[1]));
  const used = new Set();
  for (const html of htmls) {
    for (const m of html.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c) used.add(c);
    }
  }
  ok(used.size > 0, 'панель вообще без классов');
  for (const c of used) ok(known.has(c), `класс "${c}" не описан в index.html`);

  for (const html of htmls) {
    const text = plain(html);
    const latin = text.match(/[A-Za-z]{2,}/g);
    ok(!latin, `в тексте панели латиница: ${latin && latin.join(', ')}`);
    ok(!/undefined|NaN/.test(text), 'в тексте панели дыра (undefined/NaN)');
    const open = (html.match(/<div/g) || []).length, close = (html.match(/<\/div>/g) || []).length;
    ok(open === close, `дивы не сходятся: ${open} открыто, ${close} закрыто`);
  }
  console.log(`   классы: ${Array.from(used).sort().join(', ')}`);
});

// ---------------------------------------------------------------- живая партия
t('живая партия: рынок построен по-настоящему, торговля идёт', () => {
  const s = new Simulation(2026, { factions: 4 });
  s.techs.add('trade');
  s.execCommand('give wood 400'); s.execCommand('give stone 400'); s.execCommand('spawn 8');
  ok(s.placeBuilding('market', s.world.startX + 3, s.world.startY + 1), 'рынок не заложен');
  const state = createMarketPanelState();
  for (let i = 0; i < 900 && !s.hasBuilding('market'); i++) s.tick(0.5);
  ok(s.hasBuilding('market'), 'рынок так и не достроился');

  for (let i = 0; i < 600; i++) { s.tick(0.5); renderMarketPanel(s, state); }
  ok(state.hist.length > 1 && state.hist.length <= 12, `история вышла из берегов: ${state.hist.length}`);
  const html = renderMarketPanel(s, state);
  ok(specsOf(html).length === 16, 'в живой партии не все кнопки на месте');

  s.res.wood = 400;
  const gold0 = s.res.gold;
  const r = handleMarketAction(s, 'sell:wood:100');
  ok(r.ok && s.res.gold > gold0, 'продажа в живой партии не принесла золота');
  const q = marketQuote(s, 'wood', state);
  console.log(`   день ${s.day}: курс 🪵 ${q.rate.toFixed(3)}🪙 (${q.trend.pct >= 0 ? '+' : ''}${q.trend.pct}% к базе), 100🪵 → ${r.gold.toFixed(1)}🪙`);
  console.log(`   ${TRADE_RES.map(id => `${id}:${s.marketRate(id).toFixed(3)}`).join(' · ')}`);
});

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
