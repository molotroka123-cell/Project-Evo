// Тесты слоя миникарты (app/src/render/minimap.js).
// Запуск: node app/tests/test-minimap.mjs
//
// Канваса в node нет, поэтому здесь подставной document: он отдаёт объект с
// теми же методами, что и настоящий контекст 2D, но ничего не рисует. Так
// проверяется главное — ЧТО слой считает и КОГДА он перепекает картинку, а не
// то, какие пиксели вышли. Пиксели проверит глаз главного разработчика.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TILE, FACTIONS, BUILDINGS } from '../src/core/data.js';
import { createBorders, updateBorders, OWNER_PLAYER } from '../src/core/systems/borders.js';

// --- подставной canvas ДО импорта модуля: слой смотрит на document только
// внутри выпечки, но пусть будет на месте с самого начала.
const noop = () => {};
function fakeCtx(cv) {
  return {
    canvas: cv,
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '',
    calls: { fillRect: 0, strokeRect: 0, drawImage: 0, arc: 0, stroke: 0, fillText: 0 },
    save: noop, restore: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop,
    arc(...a) { this.calls.arc++; },
    stroke() { this.calls.stroke++; },
    fillRect() { this.calls.fillRect++; },
    strokeRect() { this.calls.strokeRect++; },
    drawImage() { this.calls.drawImage++; },
    fillText() { this.calls.fillText++; },
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop,
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
  MinimapLayer, ALARM_STYLE, minimapLayout, minimapVersion, pendingVersion,
  viewportRect, hitToWorld, ownerColor, playerHeart, blinkAlpha, collectAlarms,
  bordersOf,
} = await import('../src/render/minimap.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// --------------------------------------------------------------- заготовки
const world = (w = 96, h = 96, seed = 4242) => ({
  w, h, tiles: new Uint8Array(w * h).fill(TILE.GRASS), seed, startX: w / 2, startY: h / 2,
});
const bld = (id, x, y, extra = {}) => ({ id, x, y, size: BUILDINGS[id] && BUILDINGS[id].size || 1, done: true, destroyed: false, ...extra });
const fac = (id, x, y) => ({
  id, def: FACTIONS.find(f => f.id === id), alive: true, P: 20,
  settlements: [{ x, y, capital: true }],
});
function mockSim(over = {}) {
  return {
    world: world(), seasonIdx: 1, eraIndex: 0, day: 10,
    buildings: [bld('campfire', 48, 48)],
    factions: [fac('wolves', 20, 20)],
    villagers: [{ hp: 10 }, { hp: 10 }],
    res: { food: 100, gold: 0 },
    raids: { warning: false, from: null },
    showTerritory: false,
    ...over,
  };
}
const stubCtx = () => fakeCtx(null);

// ------------------------------------------------------------- раскладка
t('раскладка: карта в правом нижнем углу, слева от боковой панели', () => {
  const r = minimapLayout(1600, 900, world());
  ok(r.w === 120 && r.h === 120, `размер не 120×120: ${r.w}×${r.h}`);
  ok(r.x === 1600 - 120 - 338, `не учтена ширина #sidePanel: x=${r.x}`);
  ok(r.y === 900 - 120 - 10, `не тот нижний отступ: y=${r.y}`);
  near(r.scale, 120 / 96, 1e-9, 'масштаб');
});

t('раскладка: на узком экране панель скрыта — карта прижимается к краю', () => {
  const wide = minimapLayout(1000, 800, world());
  const narrow = minimapLayout(800, 800, world());
  ok(narrow.x > wide.x, 'на узком экране карта не сдвинулась к краю');
  ok(narrow.x === 800 - narrow.w - 10, `не тот отступ: ${narrow.x}`);
});

t('раскладка: маленький экран уменьшает карту', () => {
  const big = minimapLayout(1600, 900, world());
  const small = minimapLayout(412, 720, world());
  ok(small.w === 92 && big.w === 120, `не ужалась: ${small.w}`);
  ok(small.x >= 0 && small.y >= 0, 'карта уехала за экран');
});

t('раскладка: неквадратный мир не растягивается', () => {
  const r = minimapLayout(1600, 900, world(96, 48));
  ok(r.h === 60, `высота не по пропорции: ${r.h}`);
  near(r.scale, r.scaleY, 1e-9, 'масштабы по осям разошлись');
});

// ---------------------------------------------------------------- версия
t('версия: на неизменном мире стабильна', () => {
  const sim = mockSim();
  const a = minimapVersion(sim, 'terrain', 120, 'high');
  const b = minimapVersion(sim, 'terrain', 120, 'high');
  ok(a === b, 'версия скачет без причины — кэш никогда не сработает');
});

t('версия: реагирует на сезон, эпоху, режим, размер и пресет', () => {
  const sim = mockSim();
  const base = minimapVersion(sim, 'terrain', 120, 'high');
  ok(minimapVersion({ ...sim, seasonIdx: 3 }, 'terrain', 120, 'high') !== base, 'сезон не учтён');
  ok(minimapVersion({ ...sim, eraIndex: 5 }, 'terrain', 120, 'high') !== base, 'эпоха не учтена');
  ok(minimapVersion(sim, 'political', 120, 'high') !== base, 'режим не учтён');
  ok(minimapVersion(sim, 'terrain', 92, 'high') !== base, 'размер не учтён');
  ok(minimapVersion(sim, 'terrain', 120, 'eco') !== base, 'пресет не учтён');
});

t('версия: постройка и снос меняют её, шевеление ресурсов — нет', () => {
  const sim = mockSim();
  const base = minimapVersion(sim, 'terrain', 120, 'high');
  sim.res.food = 7;
  ok(minimapVersion(sim, 'terrain', 120, 'high') === base, 'версия зависит от еды — перепечёт каждый день');
  sim.buildings.push(bld('hut', 50, 50));
  const built = minimapVersion(sim, 'terrain', 120, 'high');
  ok(built !== base, 'новая постройка не меняет версию');
  sim.buildings[1].destroyed = true;
  ok(minimapVersion(sim, 'terrain', 120, 'high') !== built, 'снос не меняет версию');
});

t('версия: площадка стройки видна сразу, а её прогресс версию не дёргает', () => {
  const sim = mockSim();
  const base = minimapVersion(sim, 'terrain', 120, 'high');
  const site = bld('hut', 60, 60, { done: false, progress: 0 });
  sim.buildings.push(site);
  const placed = minimapVersion(sim, 'terrain', 120, 'high');
  ok(placed !== base, 'площадка не появилась в версии');
  site.progress = 0.5;
  ok(minimapVersion(sim, 'terrain', 120, 'high') === placed, 'прогресс стройки перепекает карту');
  site.done = true;
  ok(minimapVersion(sim, 'terrain', 120, 'high') !== placed, 'сдача дома не отражена');
});

t('версия: пересчёт границ перепекает политическую карту', () => {
  const sim = mockSim();
  sim.borders = createBorders(96, 96);
  const before = minimapVersion(sim, 'political', 120, 'high');
  updateBorders(sim.borders, { world: sim.world, day: 1, version: 1, buildings: sim.buildings, factions: sim.factions, force: true });
  ok(minimapVersion(sim, 'political', 120, 'high') !== before, 'новые границы не перепекают карту');
});

t('pendingVersion считает только недострой', () => {
  const done = [bld('hut', 1, 1), bld('hut', 2, 2)];
  const a = pendingVersion(done);
  ok(pendingVersion([...done, bld('hut', 3, 3)]) === a, 'готовые дома попали в хеш недостроя');
  ok(pendingVersion([...done, bld('hut', 3, 3, { done: false })]) !== a, 'площадка не попала в хеш');
});

// -------------------------------------------------------------- рамка вида
t('рамка вида: при зуме 1 занимает свою долю карты и стоит по центру', () => {
  const r = minimapLayout(1600, 900, world());
  const v = viewportRect(r, { x: 48, y: 48, zoom: 1 }, 32, 1600, 900);
  near(v.w, 1600 / 32 * r.scale, 0.01, 'ширина рамки');
  near(v.h, 900 / 32 * r.scaleY, 0.01, 'высота рамки');
  near(v.x + v.w / 2, r.x + r.w / 2, 0.01, 'рамка не по центру по X');
  near(v.y + v.h / 2, r.y + r.h / 2, 0.01, 'рамка не по центру по Y');
});

t('рамка вида: обрезается краем карты, а не лезет на HUD', () => {
  const r = minimapLayout(1600, 900, world());
  const v = viewportRect(r, { x: 0, y: 0, zoom: 0.2 }, 32, 1600, 900);
  ok(v.x >= r.x - 0.001 && v.y >= r.y - 0.001, 'рамка вылезла влево/вверх');
  ok(v.x + v.w <= r.x + r.w + 0.001, 'рамка вылезла вправо');
  ok(v.y + v.h <= r.y + r.h + 0.001, 'рамка вылезла вниз');
});

t('рамка вида: приближение сужает рамку', () => {
  const r = minimapLayout(1600, 900, world());
  const far = viewportRect(r, { x: 48, y: 48, zoom: 0.6 }, 32, 1600, 900);
  const near2 = viewportRect(r, { x: 48, y: 48, zoom: 3 }, 32, 1600, 900);
  ok(near2.w < far.w && near2.h < far.h, 'зум не влияет на рамку');
});

// ------------------------------------------------------------------ попадание
t('попадание: точка внутри карты переводится в клетку, снаружи — null', () => {
  const r = minimapLayout(1600, 900, world());
  ok(hitToWorld(r, r.x - 5, r.y + 5) === null, 'клик мимо карты засчитан');
  ok(hitToWorld(r, r.x + r.w + 5, r.y + 5) === null, 'клик правее карты засчитан');
  const p = hitToWorld(r, r.x + r.w / 2, r.y + r.h / 2);
  near(p.x, 48, 0.5, 'центр карты не центр мира по X');
  near(p.y, 48, 0.5, 'центр карты не центр мира по Y');
});

t('попадание: совпадает с формулой из main.js (деление на scale)', () => {
  const r = minimapLayout(1600, 900, world());
  const px = r.x + 30, py = r.y + 90;
  const p = hitToWorld(r, px, py);
  near(p.x, (px - r.x) / r.scale, 1e-9, 'X разошёлся с main.js');
  near(p.y, (py - r.y) / r.scale, 1e-9, 'Y разошёлся с main.js');
});

// ------------------------------------------------------------------- цвета
t('цвет владельца: игрок золотой, фракции — своим цветом из таблицы', () => {
  ok(ownerColor(OWNER_PLAYER) === '#c9a227', 'игрок не золотой');
  ok(ownerColor(2) === FACTIONS[0].color, 'первая фракция не своим цветом');
  ok(ownerColor(2 + FACTIONS.length - 1) === FACTIONS[FACTIONS.length - 1].color, 'последняя фракция не своим цветом');
  ok(typeof ownerColor(0) === 'string' && typeof ownerColor(99) === 'string', 'неизвестный код уронил цвет');
});

t('сердце поселения: кострище, а после сноса — точка основания', () => {
  const sim = mockSim();
  const h = playerHeart(sim);
  near(h.x, 48.5, 1e-9, 'не над кострищем');
  sim.buildings[0].destroyed = true;
  const h2 = playerHeart(sim);
  ok(h2.x === 48 && h2.y === 48, 'без кострища не откатились к точке основания');
});

// ------------------------------------------------------------------ мигание
t('мигание: в диапазоне 0.25..1 и повторяемо', () => {
  for (let i = 0; i < 40; i++) {
    const a = blinkAlpha(i * 0.137, 'raid', 10, 20);
    ok(a >= 0.249 && a <= 1.001, `вышли из диапазона: ${a}`);
  }
  ok(blinkAlpha(3.5, 'fire', 7, 9) === blinkAlpha(3.5, 'fire', 7, 9), 'мигание не детерминировано');
});

t('мигание: разные точки не моргают строем, разные беды — с разной частотой', () => {
  const a = blinkAlpha(1.0, 'raid', 10, 10);
  const b = blinkAlpha(1.0, 'raid', 40, 70);
  ok(Math.abs(a - b) > 1e-6, 'фазы совпали — точки моргают строем');
  ok(ALARM_STYLE.raid.hz > ALARM_STYLE.fire.hz && ALARM_STYLE.fire.hz > ALARM_STYLE.hunger.hz,
    'частоты тревог не по возрастанию опасности');
});

// ------------------------------------------------------------------ тревоги
t('тревоги: набег отмечает и наш дом, и того, откуда идут', () => {
  const sim = mockSim({ raids: { warning: true, from: 'wolves' } });
  const a = collectAlarms(sim);
  const raids = a.filter(x => x.kind === 'raid');
  ok(raids.length === 2, `меток набега ${raids.length}, ждали 2`);
  ok(raids.some(r => Math.abs(r.x - 48.5) < 0.6), 'нет метки над нашим поселением');
  ok(raids.some(r => r.x === 20 && r.y === 20), 'нет метки над агрессором');
});

t('тревоги: без предупреждения о набеге — тихо', () => {
  ok(collectAlarms(mockSim()).length === 0, 'тревога на ровном месте');
});

t('тревоги: пожар приходит списком снаружи и от просевшей прочности', () => {
  const sim = mockSim();
  sim.buildings.push(bld('palisade', 30, 30, { hp: 50 }));   // wall 200 → ниже 60 %
  sim.buildings.push(bld('palisade', 31, 31, { hp: 190 }));  // цела
  const a = collectAlarms(sim, { fires: [{ x: 5, y: 5 }] });
  const fires = a.filter(x => x.kind === 'fire');
  ok(fires.length === 2, `пожаров ${fires.length}, ждали 2`);
  ok(fires.some(f => f.x === 5 && f.y === 5), 'внешний пожар потерян');
  ok(fires.some(f => Math.abs(f.x - 30.5) < 0.6), 'повреждённое здание не горит');
});

t('тревоги: голод по пустому складу и по дню смерти от голода', () => {
  ok(collectAlarms(mockSim({ res: { food: 0 } })).some(a => a.kind === 'hunger'), 'пустой склад не тревога');
  const fed = mockSim({ res: { food: 500 }, day: 20, starvedDay: 19 });
  ok(collectAlarms(fed).some(a => a.kind === 'hunger'), 'свежая смерть от голода забыта');
  const old = mockSim({ res: { food: 500 }, day: 40, starvedDay: 19 });
  ok(!collectAlarms(old).some(a => a.kind === 'hunger'), 'давний голод мигает до сих пор');
});

t('тревоги: пустое поселение не голодает (некому)', () => {
  ok(!collectAlarms(mockSim({ res: { food: 0 }, villagers: [] })).some(a => a.kind === 'hunger'),
    'голод без жителей');
});

t('тревоги: потолок отбрасывает мелочь, а не набег', () => {
  const sim = mockSim({ raids: { warning: true, from: 'wolves' } });
  const fires = [];
  for (let i = 0; i < 30; i++) fires.push({ x: i, y: i });
  const a = collectAlarms(sim, { fires, limit: 4 });
  ok(a.length === 4, `потолок не сработал: ${a.length}`);
  ok(a.filter(x => x.kind === 'raid').length === 2, 'набег выбило пожарами');
});

t('тревоги: внешние метки из sim.minimapAlarms подхватываются', () => {
  const sim = mockSim({ minimapAlarms: [{ kind: 'fire', x: 3, y: 4 }, { kind: 'чушь', x: 0, y: 0 }] });
  const a = collectAlarms(sim);
  ok(a.length === 1 && a[0].x === 3, 'внешняя метка потеряна или пропущен мусор');
});

t('границы: слой находит состояние и в sim.sys.borders, и в sim.borders', () => {
  const st = createBorders(96, 96);
  ok(bordersOf({ sys: { borders: st } }) === st, 'не нашли sim.sys.borders — путь интегратора');
  ok(bordersOf({ borders: st }) === st, 'не нашли sim.borders — путь из шапки borders.js');
  ok(bordersOf({}) === null, 'выдумали границы там, где их нет');
  ok(bordersOf({ borders: { w: 1 } }) === null, 'приняли объект без сетки владения');
});

t('версия: границы в sim.sys.borders тоже перепекают карту', () => {
  const sim = mockSim();
  sim.sys = { borders: createBorders(96, 96) };
  const before = minimapVersion(sim, 'political', 120, 'high');
  updateBorders(sim.sys.borders, { world: sim.world, day: 1, version: 1, buildings: sim.buildings, factions: sim.factions, force: true });
  ok(minimapVersion(sim, 'political', 120, 'high') !== before, 'пересчёт в sim.sys.borders не замечен');
});

// -------------------------------------------------------------------- слой
t('слой: кадр не падает и отдаёт прямоугольник с полями для main.js', () => {
  const m = new MinimapLayer(QUALITY.high);
  const ctx = stubCtx();
  const r = m.draw(mockSim(), ctx, 1600, 900, { cam: { x: 48, y: 48, zoom: 1 }, tilePx: 32, time: 0 });
  ok(r && ['x', 'y', 'w', 'h', 'scale'].every(k => typeof r[k] === 'number'), 'нет полей x/y/w/h/scale');
  ok(ctx.calls.drawImage === 1, `блитов за кадр ${ctx.calls.drawImage}, должен быть ровно один`);
  ok(ctx.calls.strokeRect === 2, `рамка обзора нарисована ${ctx.calls.strokeRect} раз(а), ждали 2`);
});

t('слой: выпечка одна на неизменный мир, новая — на постройку и на сезон', () => {
  const m = new MinimapLayer(QUALITY.high);
  const ctx = stubCtx();
  const sim = mockSim();
  const opts = { cam: { x: 48, y: 48, zoom: 1 }, tilePx: 32, time: 0 };
  m.draw(sim, ctx, 1600, 900, opts);
  ok(m.bakes === 1, `первая выпечка не состоялась: ${m.bakes}`);
  for (let i = 0; i < 60; i++) m.draw(sim, ctx, 1600, 900, { ...opts, time: i / 60 });
  ok(m.bakes === 1, `секунда покоя стоила ${m.bakes} выпечек вместо одной`);
  sim.buildings.push(bld('hut', 50, 50));
  m.draw(sim, ctx, 1600, 900, opts);
  ok(m.bakes === 2, 'постройка не перепекла карту');
  sim.seasonIdx = 2;
  m.draw(sim, ctx, 1600, 900, opts);
  ok(m.bakes === 3, 'смена сезона не перепекла карту');
});

t('слой: смена пресета и размера экрана перепекает, покой — нет', () => {
  const m = new MinimapLayer(QUALITY.high);
  const ctx = stubCtx();
  const sim = mockSim();
  const opts = { cam: { x: 48, y: 48, zoom: 1 }, tilePx: 32, time: 0 };
  m.draw(sim, ctx, 1600, 900, opts);
  m.draw(sim, ctx, 1600, 900, { ...opts, quality: QUALITY.eco });
  ok(m.bakes === 2, 'смена пресета не перепекла карту');
  m.draw(sim, ctx, 412, 720, { ...opts, quality: QUALITY.eco });
  ok(m.bakes === 3, 'смена размера карты не перепекла её');
  m.draw(sim, ctx, 412, 720, { ...opts, quality: QUALITY.eco });
  ok(m.bakes === 3, 'лишняя выпечка на неизменных входных данных');
});

t('слой: политический режим включается и вручную, и флагом sim.showTerritory', () => {
  const m = new MinimapLayer(QUALITY.high);
  const ctx = stubCtx();
  const sim = mockSim();
  sim.sys = { borders: createBorders(96, 96) };
  updateBorders(sim.sys.borders, { world: sim.world, day: 1, version: 1, buildings: sim.buildings, factions: sim.factions, force: true });
  const opts = { cam: { x: 48, y: 48, zoom: 1 }, tilePx: 32, time: 0 };
  m.draw(sim, ctx, 1600, 900, opts);
  ok(m.bakes === 1, 'первая выпечка не состоялась');
  ok(m.toggleMode() === 'political', 'переключатель не встал в политический режим');
  m.draw(sim, ctx, 1600, 900, opts);
  ok(m.bakes === 2, 'переключение режима не перепекло карту');
  ok(m.toggleMode() === 'terrain', 'обратно не вернулись');
  m.draw(sim, ctx, 1600, 900, opts);
  const afterBack = m.bakes;
  sim.showTerritory = true;
  m.draw(sim, ctx, 1600, 900, opts);
  ok(m.bakes === afterBack + 1, 'sim.showTerritory не включил политическую карту');
});

t('слой: без границ политический режим не падает', () => {
  const m = new MinimapLayer(QUALITY.high);
  m.setMode('political');
  const r = m.draw(mockSim(), stubCtx(), 1600, 900, { cam: { x: 48, y: 48, zoom: 1 }, tilePx: 32, time: 0 });
  ok(r && r.w > 0, 'политический режим без sim.borders уронил кадр');
});

t('слой: старые руины из сейва не вспыхивают, а свежий снос — да', () => {
  const m = new MinimapLayer(QUALITY.high);
  const ctx = stubCtx();
  const sim = mockSim();
  sim.buildings.push(bld('hut', 50, 50, { destroyed: true }));   // руина из сейва
  const opts = { cam: { x: 48, y: 48, zoom: 1 }, tilePx: 32 };
  m.draw(sim, ctx, 1600, 900, { ...opts, time: 0 });
  ok(m._alarms.length === 0, 'руина из сейва загорелась на первом кадре');
  sim.buildings.push(bld('hut', 52, 52, { destroyed: true }));   // снесли только что
  m.draw(sim, ctx, 1600, 900, { ...opts, time: 1 });
  ok(m._alarms.some(a => a.kind === 'fire'), 'свежий снос не дал пожара');
  m.draw(sim, ctx, 1600, 900, { ...opts, time: 1 + 13 });        // BURN_SEC = 12
  ok(!m._alarms.some(a => a.kind === 'fire'), 'пожар горит вечно');
});

t('слой: новый мир (другой сид) сбрасывает память о пожарах и выпечку', () => {
  const m = new MinimapLayer(QUALITY.high);
  const ctx = stubCtx();
  const sim = mockSim();
  const opts = { cam: { x: 48, y: 48, zoom: 1 }, tilePx: 32, time: 0 };
  m.draw(sim, ctx, 1600, 900, opts);
  const loaded = mockSim({ world: world(96, 96, 777) });
  loaded.buildings.push(bld('hut', 50, 50, { destroyed: true }));
  m.draw(loaded, ctx, 1600, 900, { ...opts, time: 5 });
  ok(!m._alarms.some(a => a.kind === 'fire'), 'после загрузки сейва вспыхнули чужие руины');
  ok(m.bakes === 2, 'новый мир не перепёк карту');
});

t('слой: потолок тревог зависит от пресета', () => {
  const sim = mockSim({ raids: { warning: true, from: 'wolves' } });
  for (let i = 0; i < 20; i++) sim.buildings.push(bld('palisade', 10 + i, 10, { hp: 10 }));
  const opts = { cam: { x: 48, y: 48, zoom: 1 }, tilePx: 32, time: 0 };
  const eco = new MinimapLayer(QUALITY.eco);
  eco.draw(sim, stubCtx(), 1600, 900, opts);
  const ultra = new MinimapLayer(QUALITY.ultra);
  ultra.draw(sim, stubCtx(), 1600, 900, opts);
  ok(eco._alarms.length === 4, `на eco меток ${eco._alarms.length}, ждали 4`);
  ok(ultra._alarms.length === 10, `на ultra меток ${ultra._alarms.length}, ждали 10`);
});

t('слой: hit() совпадает с отданным прямоугольником', () => {
  const m = new MinimapLayer(QUALITY.high);
  const r = m.draw(mockSim(), stubCtx(), 1600, 900, { cam: { x: 48, y: 48, zoom: 1 }, tilePx: 32, time: 0 });
  const p = m.hit(r.x + 10, r.y + 10);
  ok(p && Math.abs(p.x - 10 / r.scale) < 1e-9, 'hit() разошёлся с раскладкой');
  ok(m.hit(0, 0) === null, 'клик по левому верхнему углу экрана попал в карту');
});

t('слой: память под выпечкой — десятки килобайт, а не мегабайты', () => {
  const m = new MinimapLayer(QUALITY.high);
  m.draw(mockSim(), stubCtx(), 1600, 900, { cam: { x: 48, y: 48, zoom: 1 }, tilePx: 32, time: 0 });
  const b = m.bytes();
  ok(b > 0 && b <= 120 * 120 * 4, `выпечка занимает ${b} байт`);
});

// ------------------------------------------------------------- гигиена файла
t('гигиена: ни Math.random, ни sim.rng в файле нет', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/render/minimap.js'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(!/Math\.random/.test(code), 'Math.random в рендере запрещён');
  ok(!/\brng\b/.test(code), 'обращение к rng симуляции из рендера запрещено');
  ok(/ПОДКЛЮЧЕНИЕ/.test(src), 'в файле нет блока подключения');
});

console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
process.exit(fail ? 1 : 0);
