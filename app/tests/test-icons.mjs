// Тесты слоя значков состояния (app/src/render/icons.js).
// Запуск: node app/tests/test-icons.mjs
//
// Канваса в node нет, поэтому здесь подставной document — тот же приём, что в
// test-minimap.mjs и test-select.mjs: контекст отдаёт те же методы, что настоящий
// 2D, но ничего не рисует и только считает вызовы. Так проверяется главное —
// ЧТО слой считает бедой, В КАКОМ порядке ставит значки и СКОЛЬКО кладёт в кадр.
// Как выглядят пиксели, проверит глаз главного разработчика.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BUILDINGS } from '../src/core/data.js';

const noop = () => {};
function fakeCtx(cv) {
  return {
    canvas: cv,
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '', globalAlpha: 1,
    calls: { drawImage: 0, fill: 0, stroke: 0, fillRect: 0, arc: 0 },
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop,
    fill() { this.calls.fill++; },
    stroke() { this.calls.stroke++; },
    arc() { this.calls.arc++; },
    fillRect() { this.calls.fillRect++; },
    drawImage() { this.calls.drawImage++; },
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
  };
}
function fakeCanvas() {
  const cv = { width: 0, height: 0 };
  const ctx = fakeCtx(cv);
  cv.getContext = () => ctx;
  return cv;
}
globalThis.document = { createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : {}) };

const { QUALITY } = await import('../src/render/quality.js');
const {
  IconLayer, ICON_KINDS, CELL, CAP_MARKS, MAX_PER_CHAIN,
  EMPTY_GRACE_DAYS, HP_WARN, HP_SEVERE, HEIR_LEVEL, FULL_AT,
  ICON_MIN_PX, ICON_MAX_PX,
  scanMarks, createMemory, minZoomFor, capFor, iconPxFor, phaseOf,
  isCraft, maxHpOf, outputWasted, weightOf, bakeAtlas, chainBuildings,
} = await import('../src/render/icons.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || ''} ждали ${b}, получили ${a}`); };
const ok = (v, m) => { if (!v) throw new Error(m || 'ложь'); };

// ---------------------------------------------------------------------------
// Мир для проверок. Сид фиксированный: слой обязан быть детерминированным.
function mkSim(over = {}) {
  return {
    day: 100,
    world: { w: 96, h: 96, seed: 20250808 },
    buildings: [],
    villagers: [],
    res: { food: 10, wood: 10, stone: 10, steel: 10, gold: 0, knowledge: 0 },
    resCap: { food: 200, wood: 400, stone: 400, steel: 500, gold: 99999, knowledge: 99999 },
    sys: {},
    linkMasters: null,
    ...over,
  };
}
function mkB(id, x, y, over = {}) {
  const def = BUILDINGS[id];
  return { id, x, y, size: def.size || 1, done: true, destroyed: false,
    progress: 1, buildDays: 1, workers: [], hp: (def.wall || 100), ...over };
}
// Житель, стоящий на рабочем месте b. Важно: именно v.target.b с kind 'work' —
// b.workers ядро держит только для строителей.
const worker = (b) => ({ name: 'ж', hp: 100, target: { kind: 'work', b, x: b.x, y: b.y } });

const kindsOf = (marks) => marks.map(m => m.kind);

// ---------------------------------------------------------------------------
// 1. Пресеты
t('minZoomFor: medium/high/ultra равны propsMinZoom', () => {
  for (const id of ['medium', 'high', 'ultra']) {
    eq(minZoomFor(QUALITY[id]), QUALITY[id].lod.propsMinZoom, id);
  }
});
t('minZoomFor: сентинел eco (99) сворачивается к 1.0', () => {
  eq(QUALITY.eco.lod.propsMinZoom, 99, 'пресет изменился');
  eq(minZoomFor(QUALITY.eco), 1.0);
});
t('capFor: 12 / 18 / 24 / 24', () => {
  eq(capFor(QUALITY.eco), 12);
  eq(capFor(QUALITY.medium), 18);
  eq(capFor(QUALITY.high), 24);
  eq(capFor(QUALITY.ultra), 24);
});
t('capFor: пресет без detail не роняет слой', () => { eq(capFor({}), 18); });

// 2. Мелкие чистые функции
t('maxHpOf: стены берут def.wall, остальные — 100', () => {
  eq(maxHpOf(BUILDINGS.palisade), 200);
  eq(maxHpOf(BUILDINGS.smithy), 100);
  eq(maxHpOf(undefined), 100);
});
t('isCraft: промысел — рабочие места + выпуск', () => {
  ok(isCraft(BUILDINGS.smithy), 'кузница промысел');
  ok(isCraft(BUILDINGS.farm), 'ферма промысел');
  ok(!isCraft(BUILDINGS.hut), 'хижина не промысел');
  ok(!isCraft(BUILDINGS.robo_factory), 'робозавод без рабочих мест');
  ok(!isCraft(BUILDINGS.palisade), 'частокол не промысел');
});
t('outputWasted: полон только когда полны ВСЕ продукты', () => {
  const cap = { wood: 400, stone: 400 };
  const def = { out: { wood: 1.5, stone: 1.5 } };
  ok(outputWasted(def, { wood: 400, stone: 400 }, cap), 'оба полны');
  ok(!outputWasted(def, { wood: 400, stone: 100 }, cap), 'один полон — не пропадает всё');
  ok(outputWasted(def, { wood: 399, stone: 399 }, cap) === (399 >= 400 * FULL_AT), 'порог FULL_AT');
});
t('outputWasted: ресурс без потолка (золото, знания) полным не бывает', () => {
  ok(!outputWasted({ out: { gold: 1 } }, { gold: 1e9 }, { gold: 99999 }));
});
t('iconPxFor зажат в [ICON_MIN_PX, ICON_MAX_PX]', () => {
  eq(iconPxFor(12.8), ICON_MIN_PX, 'минимальный зум 0.4');
  eq(iconPxFor(96), ICON_MAX_PX, 'максимальный зум 3.0');
  ok(iconPxFor(32) > ICON_MIN_PX && iconPxFor(32) < ICON_MAX_PX, 'зум 1 — между границами');
});
t('phaseOf детерминирована и лежит в [0, 2π)', () => {
  const a = phaseOf(20250808, 12, 34);
  eq(a, phaseOf(20250808, 12, 34), 'повтор');
  ok(a >= 0 && a < Math.PI * 2, 'диапазон');
  ok(phaseOf(20250808, 12, 34) !== phaseOf(20250808, 13, 34), 'соседи вразнобой');
  ok(phaseOf(1, 12, 34) !== phaseOf(2, 12, 34), 'сид меняет фазу');
});

// 3. Стройка
t('недострой даёт значок build и только его', () => {
  const sim = mkSim();
  sim.buildings.push(mkB('smithy', 10, 10, { done: false, hp: 5 }));
  const marks = scanMarks(sim, createMemory());
  eq(marks.length, 1);
  eq(marks[0].kind, 'build');
});

// 4. Повреждение
t('повреждение: порог HP_WARN', () => {
  const sim = mkSim();
  sim.buildings.push(mkB('smithy', 1, 1, { hp: 100 * HP_WARN + 1 }));   // цел
  sim.buildings.push(mkB('smithy', 2, 2, { hp: 100 * HP_WARN - 1 }));   // одна авария
  const marks = scanMarks(sim, createMemory());
  eq(marks.length, 1);
  eq(marks[0].kind, 'damage');
  eq(marks[0].sev, 1);
});
t('повреждение: sev 2 ниже HP_SEVERE и он тяжелее sev 1', () => {
  const sim = mkSim();
  sim.buildings.push(mkB('smithy', 1, 1, { hp: 100 * HP_WARN - 1 }));
  sim.buildings.push(mkB('smithy', 2, 2, { hp: 100 * HP_SEVERE - 1 }));
  const marks = scanMarks(sim, createMemory());
  eq(marks.length, 2);
  eq(marks[0].sev, 2, 'худшее первым');
  ok(weightOf(marks[0]) > weightOf(marks[1]), 'вес растёт с тяжестью');
});
t('стены с def.wall=200 считаются от своего максимума, а не от 100', () => {
  const sim = mkSim();
  sim.buildings.push(mkB('palisade', 3, 3, { hp: 190 }));   // 0.95 — цел
  eq(scanMarks(sim, createMemory()).length, 0);
  sim.buildings[0].hp = 100;                                // 0.5 — повреждён
  eq(scanMarks(sim, createMemory())[0].kind, 'damage');
});

// 5. Нет рабочих
t('нет рабочих: молчим, пока не выйдет EMPTY_GRACE_DAYS', () => {
  const sim = mkSim();
  sim.buildings.push(mkB('smithy', 5, 5));
  const mem = createMemory();
  eq(scanMarks(sim, mem).length, 0, 'первый пересчёт — счётчик только заводится');
  for (let i = 0; i < EMPTY_GRACE_DAYS; i++) { sim.day += 1; scanMarks(sim, mem); }
  const marks = scanMarks(sim, mem);
  eq(marks.length, 1);
  eq(marks[0].kind, 'idle');
});
t('нет рабочих: пришёл житель — счётчик обнулился', () => {
  const sim = mkSim();
  const b = mkB('smithy', 5, 5);
  sim.buildings.push(b);
  const mem = createMemory();
  for (let i = 0; i < 5; i++) { sim.day += 1; scanMarks(sim, mem); }
  eq(scanMarks(sim, mem)[0].kind, 'idle');
  sim.villagers.push(worker(b));
  sim.day += 1;
  eq(scanMarks(sim, mem).length, 0, 'значок ушёл в тот же пересчёт');
  sim.villagers.length = 0;
  sim.day += 1;
  eq(scanMarks(sim, mem).length, 0, 'и не вернулся сразу — отсчёт начат заново');
});
t('нет рабочих: скачок дня после загрузки сейва не даёт значок мгновенно', () => {
  const sim = mkSim();
  sim.buildings.push(mkB('smithy', 5, 5));
  const mem = createMemory();
  scanMarks(sim, mem);
  sim.day += 900;                        // «пропустили век» из консоли
  eq(scanMarks(sim, mem).length, 0, 'шаг дня зажат единицей');
});
t('нет рабочих: жильё и пассивные постройки значка не получают', () => {
  const sim = mkSim();
  sim.buildings.push(mkB('hut', 1, 1), mkB('robo_factory', 2, 2), mkB('palisade', 3, 3));
  const mem = createMemory();
  for (let i = 0; i < 5; i++) { sim.day += 1; scanMarks(sim, mem); }
  eq(scanMarks(sim, mem).length, 0);
});

// 6. Склад полон
t('склад полон: значок full, когда весь выпуск упирается в потолок', () => {
  const sim = mkSim();
  const b = mkB('lumber', 7, 7);
  sim.buildings.push(b);
  sim.villagers.push(worker(b));          // рабочие есть — не спутать с idle
  eq(scanMarks(sim, createMemory()).length, 0, 'склад не полон');
  sim.res.wood = sim.resCap.wood;
  eq(scanMarks(sim, createMemory())[0].kind, 'full');
});

// 7. Цепочки
t('цепочка встала: помечаются постройки цепочки, но не больше MAX_PER_CHAIN на id', () => {
  const sim = mkSim({ sys: { indLinks: { flags: { bottlenecks: [{ id: 'steel', ru: 'Сталь', kind: 'lack' }] } } } });
  for (let i = 0; i < 5; i++) {
    const b = mkB('mine', i, 20);
    sim.buildings.push(b);
    sim.villagers.push(worker(b));        // рабочие есть, склад не полон
  }
  const marks = scanMarks(sim, createMemory());
  eq(marks.length, MAX_PER_CHAIN);
  ok(marks.every(m => m.kind === 'stuck'), 'все stuck');
});
t('цепочка встала: постройка вне цепочки значка не получает', () => {
  const sim = mkSim({ sys: { indLinks: { flags: { bottlenecks: [{ id: 'steel' }] } } } });
  const b = mkB('university', 4, 4);
  sim.buildings.push(b);
  sim.villagers.push(worker(b));
  eq(scanMarks(sim, createMemory()).length, 0);
});
t('карта «цепочка → постройки» содержит исполнителей всех стадий', () => {
  const m = chainBuildings();
  ok(m.has('steel') && m.has('bread'), 'обе штатные цепочки на месте');
  ok(m.get('steel').has('mine') && m.get('steel').has('smelter'), 'сталь: добыча и плавка');
  ok(m.get('bread').has('farm') && m.get('bread').has('mill'), 'хлеб: поле и помол');
});
t('нет sim.sys.indLinks — слой не падает', () => {
  const sim = mkSim({ sys: undefined });
  sim.buildings.push(mkB('smithy', 1, 1, { hp: 10 }));
  eq(scanMarks(sim, createMemory()).length, 1);
});

// 8. Мастер без ученика
t('мастер без ученика: один значок на промысел, а не на каждую кузницу', () => {
  const sim = mkSim({ linkMasters: { crafts: { smithy: { level: HEIR_LEVEL + 0.1, master: 'Ива', apprentice: null } } } });
  for (let i = 0; i < 3; i++) {
    const b = mkB('smithy', i, 30);
    sim.buildings.push(b);
    sim.villagers.push(worker(b));
  }
  const marks = scanMarks(sim, createMemory());
  eq(marks.length, 1);
  eq(marks[0].kind, 'noheir');
});
t('мастер без ученика: молчим, пока умение ниже HEIR_LEVEL и когда ученик есть', () => {
  const mk = (c) => {
    const sim = mkSim({ linkMasters: { crafts: { smithy: c } } });
    const b = mkB('smithy', 1, 1);
    sim.buildings.push(b); sim.villagers.push(worker(b));
    return scanMarks(sim, createMemory()).length;
  };
  eq(mk({ level: HEIR_LEVEL - 0.01, master: 'Ива', apprentice: null }), 0, 'терять нечего');
  eq(mk({ level: 0.9, master: 'Ива', apprentice: 'Пётр' }), 0, 'ученик есть');
  eq(mk({ level: 0.9, master: null, apprentice: null }), 0, 'мастера нет');
  eq(mk({ level: 0.9, master: 'Ива', apprentice: null }), 1, 'вот она беда');
});

// 9. Приоритет и потолки
t('на одну постройку — ровно один значок, самый тяжёлый', () => {
  const sim = mkSim({
    sys: { indLinks: { flags: { bottlenecks: [{ id: 'steel' }] } } },
    linkMasters: { crafts: { smithy: { level: 0.9, master: 'Ива', apprentice: null } } },
  });
  const b = mkB('smithy', 9, 9, { hp: 20 });   // и повреждена, и без рабочих, и в цепочке
  sim.buildings.push(b);
  sim.res.stone = sim.resCap.stone;
  const mem = createMemory();
  for (let i = 0; i < 5; i++) { sim.day += 1; scanMarks(sim, mem); }
  const marks = scanMarks(sim, mem);
  eq(marks.length, 1);
  eq(marks[0].kind, 'damage', 'беда важнее прочего');
});
t('порядок меток: беда раньше стройки', () => {
  const sim = mkSim();
  sim.buildings.push(mkB('smithy', 1, 1, { done: false }));
  sim.buildings.push(mkB('smithy', 2, 2, { hp: 10 }));
  const marks = scanMarks(sim, createMemory());
  eq(kindsOf(marks).join(','), 'damage,build');
});
t('порядок видов совпадает с объявленным в ICON_KINDS', () => {
  const prios = ICON_KINDS.map(k => k.prio);
  for (let i = 1; i < prios.length; i++) ok(prios[i] < prios[i - 1], 'приоритеты убывают');
});
t('меток не больше CAP_MARKS', () => {
  const sim = mkSim();
  for (let i = 0; i < CAP_MARKS + 40; i++) sim.buildings.push(mkB('smithy', i % 90, (i / 90) | 0, { done: false }));
  eq(scanMarks(sim, createMemory()).length, CAP_MARKS);
});
t('снесённое здание значка не даёт', () => {
  const sim = mkSim();
  sim.buildings.push(mkB('smithy', 1, 1, { hp: 5, destroyed: true }));
  eq(scanMarks(sim, createMemory()).length, 0);
});
t('пустой мир — пустой список, без исключений', () => {
  eq(scanMarks(mkSim(), createMemory()).length, 0);
  eq(scanMarks(null, createMemory()).length, 0);
  eq(scanMarks({}, createMemory()).length, 0);
});

// 10. Выпечка и кадр
t('атлас: одна ячейка CELL×CELL на каждый вид', () => {
  const cv = bakeAtlas(QUALITY.high);
  eq(cv.width, CELL * ICON_KINDS.length);
  eq(cv.height, CELL);
});
t('кадр: блитов не больше потолка пресета', () => {
  const sim = mkSim();
  for (let i = 0; i < 60; i++) sim.buildings.push(mkB('smithy', 4 + (i % 8), 4 + ((i / 8) | 0), { done: false }));
  const layer = new IconLayer(QUALITY.high);
  const cv = fakeCanvas(), ctx = cv.getContext();
  layer.draw(sim, ctx, 0, 0, 32, 1600, 900, 0, 1);
  eq(layer.drawn, capFor(QUALITY.high));
  eq(ctx.calls.drawImage, capFor(QUALITY.high));
  eq(layer.bakes, 1, 'атлас испечён один раз');
  layer.draw(sim, ctx, 0, 0, 32, 1600, 900, 0.02, 0.016);
  eq(layer.bakes, 1, 'и во втором кадре не перепекается');
});
t('кадр: ниже порога зума не рисуется ничего', () => {
  const sim = mkSim();
  sim.buildings.push(mkB('smithy', 10, 10, { done: false }));
  const layer = new IconLayer(QUALITY.high);
  const ctx = fakeCanvas().getContext();
  // 0.79 от порога high (0.8): z = 32 * 0.79
  layer.draw(sim, ctx, 0, 0, 32 * 0.79, 1600, 900, 0, 1);
  eq(ctx.calls.drawImage, 0);
  eq(layer.drawn, 0);
  layer.draw(sim, ctx, 0, 0, 32 * 0.81, 1600, 900, 0, 0.4);
  eq(ctx.calls.drawImage, 1, 'выше порога — рисуется');
});
t('кадр: то, что за краем экрана, не блитится', () => {
  const sim = mkSim();
  sim.buildings.push(mkB('smithy', 10, 10, { done: false }));
  const layer = new IconLayer(QUALITY.high);
  const ctx = fakeCanvas().getContext();
  layer.draw(sim, ctx, -5000, -5000, 32, 1600, 900, 0, 1);
  eq(ctx.calls.drawImage, 0);
});
t('кадр: enabled=false выключает слой целиком', () => {
  const sim = mkSim();
  sim.buildings.push(mkB('smithy', 10, 10, { done: false }));
  const layer = new IconLayer(QUALITY.high);
  layer.enabled = false;
  const ctx = fakeCanvas().getContext();
  layer.draw(sim, ctx, 0, 0, 32, 1600, 900, 0, 1);
  eq(ctx.calls.drawImage, 0);
});
t('кадр: смена пресета снимает атлас и меняет потолок', () => {
  const sim = mkSim();
  for (let i = 0; i < 60; i++) sim.buildings.push(mkB('smithy', 4 + (i % 8), 4 + ((i / 8) | 0), { done: false }));
  const layer = new IconLayer(QUALITY.high);
  const ctx = fakeCanvas().getContext();
  layer.draw(sim, ctx, 0, 0, 32, 1600, 900, 0, 1);
  eq(layer.drawn, 24);
  layer.setQuality(QUALITY.eco);
  eq(layer.atlas, null, 'атлас снят');
  layer.draw(sim, ctx, 0, 0, 32, 1600, 900, 0, 1);
  eq(layer.drawn, 12, 'потолок eco');
  eq(layer.bakes, 2, 'перепечён ровно один раз');
});
t('кадр: пересчёт идёт по своему таймеру, а не каждый кадр', () => {
  const sim = mkSim();
  sim.buildings.push(mkB('smithy', 10, 10, { done: false }));
  const layer = new IconLayer(QUALITY.high);
  const ctx = fakeCanvas().getContext();
  layer.draw(sim, ctx, 0, 0, 32, 1600, 900, 0, 1);      // первый кадр считает
  sim.buildings.length = 0;                             // мир опустел
  layer.draw(sim, ctx, 0, 0, 32, 1600, 900, 0.02, 0.016);
  eq(layer.drawn, 1, 'метка ещё живёт: пересчёта не было');
  layer.draw(sim, ctx, 0, 0, 32, 1600, 900, 0.4, 0.4);
  eq(layer.drawn, 0, 'через SCAN_SEC список обновился');
});
t('stats() отдаёт понятный слепок', () => {
  const layer = new IconLayer(QUALITY.high);
  const s = layer.stats();
  ok('marks' in s && 'drawn' in s && 'bakes' in s && 'bytes' in s, 'поля на месте');
  eq(s.bytes, 0, 'до выпечки памяти не занято');
});

// 11. Правила проекта
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/render/icons.js'), 'utf8');
// Комментарии из проверок вычищаем: в шапке файла запрещённые вещи названы по
// именам («Math.random запрещён»), и проверка по сырому тексту ловила бы
// собственную документацию.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
t('в файле нет Math.random и нет обращения к sim.rng', () => {
  ok(!/Math\.random/.test(CODE), 'Math.random запрещён');
  ok(!/\brng\b/.test(CODE), 'sim.rng рендеру трогать нельзя');
});
t('в кадре нет ctx.filter, градиентов и текста', () => {
  const draw = CODE.slice(CODE.indexOf('  draw(sim, ctx'), CODE.indexOf('export function bakeAtlas'));
  ok(draw.length > 200, 'тело draw() найдено');
  ok(!/\.filter\s*=/.test(draw), 'ctx.filter в кадре запрещён');
  ok(!/createRadialGradient|createLinearGradient/.test(draw), 'градиенты только в выпечке');
  ok(!/fillText/.test(CODE), 'текста нет вообще: системные шрифты у всех разные');
});
t('слой не пишет в симуляцию', () => {
  ok(!/\bsim\.[a-zA-Z_.]+\s*=[^=]/.test(CODE), 'присваиваний в sim нет');
});

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
