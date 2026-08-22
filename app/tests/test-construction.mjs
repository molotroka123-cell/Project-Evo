// Тесты слоя стройки (app/src/render/construction.js).
// Запуск: node app/tests/test-construction.mjs
//
// Канваса в node нет, поэтому здесь подставной document — как в
// test-damage.mjs, test-city-lights.mjs и test-minimap.mjs. Проверяются не
// пиксели, а поведение: КОГДА слой работает, СКОЛЬКО объектов кладёт в кадр,
// ДЕТЕРМИНИРОВАН ли рисунок, уважает ли потолки пресета и бюджет выпечки,
// ловится ли момент сдачи и не ловится ли он там, где его не было.
// Картинку проверит глаз.
import { BUILDINGS } from '../src/core/data.js';

const noop = () => {};
function fakeCtx(cv) {
  return {
    canvas: cv,
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: '', lineCap: '',
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none',
    calls: { fillRect: 0, drawImage: 0, stroke: 0, fill: 0, grad: 0 },
    images: [],
    // Куда и чем рисовали — по этому списку тесты проверяют геометрию
    // (растёт ли силуэт, обрезаются ли леса сверху).
    blits: [],
    depth: 0, saves: 0,
    save() { this.saves++; this.depth++; },
    restore() { this.depth--; },
    setTransform: noop, translate: noop, scale: noop,
    rotate: noop, clip: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    closePath: noop, arc: noop, ellipse: noop, rect: noop, setLineDash: noop,
    fill() { this.calls.fill++; },
    stroke() { this.calls.stroke++; },
    fillRect() { this.calls.fillRect++; },
    clearRect: noop,
    drawImage(img, ...a) {
      this.calls.drawImage++;
      this.images.push(img);
      // Полная форма — drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh),
      // короткая — drawImage(img, dx, dy, dw, dh).
      if (a.length === 8) this.blits.push({ img, sx: a[0], sy: a[1], sw: a[2], sh: a[3], dx: a[4], dy: a[5], dw: a[6], dh: a[7], alpha: this.globalAlpha, op: this.globalCompositeOperation });
      else this.blits.push({ img, dx: a[0], dy: a[1], dw: a[2], dh: a[3], alpha: this.globalAlpha, op: this.globalCompositeOperation });
    },
    createRadialGradient() { this.calls.grad++; return { addColorStop: noop }; },
    createLinearGradient() { this.calls.grad++; return { addColorStop: noop }; },
  };
}
let canvasesMade = 0;
function fakeCanvas() {
  canvasesMade++;
  const cv = { width: 0, height: 0 };
  const ctx = fakeCtx(cv);
  cv.getContext = () => ctx;
  return cv;
}
globalThis.document = { createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : {}) };

const { QUALITY } = await import('../src/render/quality.js');
const {
  ConstructionLayer, CONSTRUCTION_LIMITS,
  chash, rngFrom, progressOf, revealFrac, dismantleK, scaffoldFrac,
  levelsFor, postsFor, siteVariant, heightFactor, eraOf,
  bakePlate, bakeScaffold, bakeDeck, bakeBuilder, bakePuff, bakeChip, bakeFlash,
} = await import('../src/render/construction.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// --------------------------------------------------------------- заготовки
const TILE_PX = 32;

// Площадка в том виде, в каком её создаёт simulation.placeBuilding().
const site = (id, x, y, o = {}) => ({
  id, x, y, size: (BUILDINGS[id] && BUILDINGS[id].size) || 1,
  progress: o.progress === undefined ? 0 : o.progress,
  buildDays: o.buildDays === undefined ? 10 : o.buildDays,
  workers: o.workers === undefined ? [] : o.workers,
  done: false, destroyed: false,
  eraBuilt: 0, hp: (BUILDINGS[id] && BUILDINGS[id].wall) || 100,
  ...o,
});
function simOf(buildings, o = {}) {
  return {
    world: { w: 96, h: 96, seed: o.seed === undefined ? 4242 : o.seed, startX: 48, startY: 48 },
    buildings, eraIndex: o.eraIndex === undefined ? 4 : o.eraIndex,
    villagers: [], animals: [], weather: 'sun', dayTime: 0.5,
  };
}
// Спрайт постройки в том виде, в каком его отдаёт sprites.bake().
function fakeSprite(w = 96, h = 120) {
  const mk = () => { const c = fakeCanvas(); c.width = w; c.height = h; return c; };
  return { cv: mk(), glow: mk(), sil: mk(), hFact: h / w };
}
function frameCtx() { return fakeCanvas().getContext(); }
const crew = (n) => Array.from({ length: n }, (_, i) => ({ x: 10 + i, y: 10, hp: 100 }));
// Один спрайт на весь прогон: fakeSprite() сам создаёт три канваса, и тест
// «в прогретом кадре ничего не печётся» считал бы их выпечкой слоя.
const SHARED_SPR = fakeSprite();

// Один полный кадр слоя: begin -> площадки -> проход поверх зданий.
function frame(cl, sim, o = {}) {
  const zoom = o.zoom === undefined ? 1 : o.zoom;
  const z = TILE_PX * zoom;
  const ctx = o.ctx || (o.keepCtx ? (o.keepCtx.ctx || (o.keepCtx.ctx = frameCtx())) : frameCtx());
  const ox = o.ox === undefined ? 0 : o.ox, oy = o.oy === undefined ? 0 : o.oy;
  cl.begin(sim, o.dt === undefined ? 1 / 60 : o.dt, ox, oy, z, 1600, 900);
  for (const b of sim.buildings) {
    if (b.done || b.destroyed) continue;
    const sx = ox + b.x * z, sy = oy + b.y * z;
    cl.site(sim, ctx, b, sx, sy, (b.size || 1) * z, () => (o.spr === null ? null : (o.spr || SHARED_SPR)));
  }
  cl.drawFx(ctx);
  return ctx;
}
// Слой с прогретыми кэшами: бюджет выпечки — 1–2 штуки на кадр, поэтому
// первые кадры новой площадки заведомо неполные. Прогоняем восемь кадров,
// чтобы всё нужное успело испечься, и только потом меряем содержимое кадра.
function warm(cl, sim, o = {}) {
  for (let i = 0; i < 8; i++) frame(cl, sim, o);
  return frame(cl, sim, o);
}

// ------------------------------------------------------- чистые функции
t('progressOf: доля прогресса, защита от мусорных buildDays', () => {
  near(progressOf(site('hut', 5, 5, { progress: 5, buildDays: 10 })), 0.5, 1e-9, 'половина');
  near(progressOf(site('hut', 5, 5, { progress: 99, buildDays: 10 })), 1, 1e-9, 'клампится сверху');
  near(progressOf(site('hut', 5, 5, { progress: -3, buildDays: 10 })), 0, 1e-9, 'клампится снизу');
  ok(Number.isFinite(progressOf(site('hut', 5, 5, { progress: 1, buildDays: 0 }))), 'buildDays=0 не даёт Infinity');
  ok(progressOf(null) === 0, 'null — ноль, а не падение');
});

t('revealFrac: силуэт не растёт, пока идут земляные работы', () => {
  ok(revealFrac(0) === 0, 'на нуле ничего');
  ok(revealFrac(0.10) === 0, 'внутри фундамента ничего');
  ok(revealFrac(0.5) > 0.4 && revealFrac(0.5) < 0.5, 'середина стройки — примерно 43%');
  near(revealFrac(1), 1, 1e-9, 'к сдаче силуэт открыт целиком');
  // Монотонность: если высота хоть где-то падает, здание «оседает» на глазах.
  let prev = -1;
  for (let p = 0; p <= 1.0001; p += 0.01) { const v = revealFrac(p); ok(v >= prev - 1e-12, `монотонность на p=${p.toFixed(2)}`); prev = v; }
});

t('dismantleK: разборка только в последней четверти', () => {
  ok(dismantleK(0.5) === 0, 'на середине леса целы');
  ok(dismantleK(0.75) === 0, 'на границе ещё целы');
  ok(dismantleK(0.875) > 0.4 && dismantleK(0.875) < 0.6, 'посередине четверти — половина');
  near(dismantleK(1), 1, 1e-9, 'к сдаче разобраны');
});

t('scaffoldFrac: леса выше кладки, потом убывают', () => {
  ok(scaffoldFrac(0) >= 0.22, 'нижний ярус стоит с самого начала');
  for (let p = 0; p <= 0.75; p += 0.05) {
    ok(scaffoldFrac(p) >= revealFrac(p) - 1e-9, `леса не ниже кладки на p=${p.toFixed(2)}`);
  }
  ok(scaffoldFrac(0.7) > scaffoldFrac(0.95), 'в последней четверти леса убывают');
  ok(scaffoldFrac(1) > 0, 'до самой сдачи что-то стоит');
  ok(scaffoldFrac(1) < 0.2, 'но к сдаче почти ничего не осталось');
});

t('levelsFor/postsFor: геометрия решётки в разумных пределах', () => {
  ok(levelsFor(0.30) === 2, 'у поля минимум ярусов');
  ok(levelsFor(4.2) === 7, 'у шпиля потолок ярусов');
  ok(levelsFor(1.15) >= 3 && levelsFor(1.15) <= 5, 'у дома 3-5 ярусов');
  ok(postsFor(1) >= 3 && postsFor(1) <= 8, 'стойки в пределах');
  ok(postsFor(3) >= postsFor(1), 'шире постройка — не меньше стоек');
  ok(postsFor(9) <= 8, 'потолок стоек соблюдён');
});

t('heightFactor совпадает с формулой sprites.bake', async () => {
  const { ARCH, archHeight } = await import('../src/render/sprites.js');
  for (const id of ['hut', 'skyscraper', 'farm', 'castle', 'spire']) {
    near(heightFactor(id), archHeight(ARCH[id] || 'house') * 1.12, 1e-9, `hFact ${id}`);
  }
});

t('eraOf: отделка тянется к эпохе, но не больше чем на три ступени', () => {
  const b = site('hut', 5, 5);
  ok(eraOf(b, simOf([b], { eraIndex: 9 })) <= 3, 'хижина не становится стеклянной');
  ok(eraOf(b, simOf([b], { eraIndex: 0 })) === 0, 'своя эпоха — нижняя граница');
});

// ------------------------------------------------------- детерминированность
t('chash: детерминирован, в [0,1), разводит соседние площадки', () => {
  ok(chash(3, 4, 5) === chash(3, 4, 5), 'один вход — один выход');
  ok(chash(3, 4, 5) !== chash(4, 3, 5), 'координаты не симметричны');
  ok(chash(3, 4, 5) !== chash(3, 4, 6), 'третий вход работает');
  for (let i = 0; i < 500; i++) { const v = chash(i, i * 7, i % 5); ok(v >= 0 && v < 1, 'диапазон'); }
});

t('rngFrom: поток детерминирован и не вырождается', () => {
  const a = rngFrom(12345), b = rngFrom(12345);
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const v = a(); ok(v === b(), 'два потока с одним зерном совпадают'); ok(v >= 0 && v < 1, 'диапазон'); seen.add(v); }
  ok(seen.size > 150, 'поток не залипает на одном значении');
});

t('siteVariant: вариант закреплён за координатами и зерном мира', () => {
  const b = site('hut', 7, 9);
  ok(siteVariant(b, 111) === siteVariant(b, 111), 'повторяемость');
  const vs = new Set();
  for (let x = 0; x < 12; x++) for (let y = 0; y < 12; y++) vs.add(siteVariant(site('hut', x, y), 4242));
  ok(vs.size === 4, `используются все четыре варианта, получено ${vs.size}`);
});

t('никакого Math.random и sim.rng в исходнике', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/render/construction.js', import.meta.url), 'utf8');
  ok(!/Math\.random/.test(src), 'Math.random запрещён');
  ok(!/\.rng\b/.test(src.replace(/rngFrom/g, '')), 'sim.rng рендеру запрещён');
});

// ------------------------------------------------------------- выпечка
t('выпечка: размеры канвасов зависят от detail и размера постройки', () => {
  const p1 = bakePlate(1, 0, 0, 2), p2 = bakePlate(2, 0, 0, 2), p0 = bakePlate(1, 0, 0, 0);
  ok(p2.width === p1.width * 2, 'двойная постройка — вдвое шире плита');
  ok(p0.width < p1.width, 'detail 0 печётся грубее');
  const s = bakeScaffold(1, 1.15, 0, 0, 2);
  ok(s.width > 0 && s.height > s.width, 'леса выше, чем шире, у обычного дома');
  const tall = bakeScaffold(1, 3.2, 0, 0, 2);
  ok(tall.height > s.height * 2, 'у высотки леса заметно выше');
  ok(bakeDeck(1, 0, 2).width === s.width, 'настил ровно по ширине лесов');
  const bs = bakeBuilder(0, 2);
  ok(bs.cv.width === bs.fw * 2, 'лист строителя — два кадра');
  ok(bakePuff(true).width > 0 && bakeChip(0).width > 0 && bakeFlash().width > 0, 'мелочь печётся');
});

t('выпечка кэшируется: второй кадр не создаёт новых канвасов', () => {
  const cl = new ConstructionLayer(QUALITY.high);
  const sim = simOf([site('stone_house', 10, 10, { progress: 4 })]);
  const keep = {};
  warm(cl, sim, { keepCtx: keep });
  const before = canvasesMade;
  frame(cl, sim, { keepCtx: keep });
  ok(canvasesMade === before, `в прогретом кадре не печётся ничего, создано ${canvasesMade - before}`);
});

t('бюджет выпечки на кадр соблюдается', () => {
  for (const id of ['eco', 'high', 'ultra']) {
    const q = QUALITY[id];
    const cl = new ConstructionLayer(q);
    const sim = simOf([
      site('hut', 4, 4, { progress: 3 }), site('farm', 9, 9, { progress: 5 }),
      site('castle', 14, 14, { progress: 6 }), site('temple', 20, 20, { progress: 2 }),
    ]);
    frame(cl, sim);
    ok(cl.stats().bakes <= q.caps.bakesPerFrame,
      `${id}: за кадр ${cl.stats().bakes} выпечек при бюджете ${q.caps.bakesPerFrame}`);
  }
});

// --------------------------------------------------------------- гейты
t('дальний план: площадка сжимается в пятно, ни одного блита', () => {
  const cl = new ConstructionLayer(QUALITY.high);
  const sim = simOf([site('stone_house', 10, 10, { progress: 5 })]);
  const ctx = frame(cl, sim, { zoom: 0.15 });   // z = 4.8 px на тайл
  ok(ctx.calls.drawImage === 0, 'на дальнем плане ничего не блитим');
  ok(ctx.calls.fillRect >= 1, 'но пятно рисуем — клетка не должна быть пустой');
});

t('порог propsMinZoom: мелочь появляется ровно по пресету', () => {
  for (const id of ['medium', 'high', 'ultra']) {
    const q = QUALITY[id];
    const cl = new ConstructionLayer(q);
    const sim = simOf([site('stone_house', 10, 10, { progress: 5, workers: crew(3) })]);
    const below = warm(cl, sim, { zoom: q.lod.propsMinZoom - 0.05 });
    ok(cl.stats().builders === 0, `${id}: ниже порога фигурок нет`);
    ok(below.calls.fillRect <= 1, `${id}: ниже порога полоски прогресса нет (допустим 1 fillRect — полоса кладки)`);
    const above = warm(cl, sim, { zoom: q.lod.propsMinZoom + 0.05 });
    ok(cl.stats().builders > 0, `${id}: выше порога фигурки есть`);
    ok(above.calls.fillRect >= below.calls.fillRect + 3, `${id}: выше порога добавились три fillRect полоски`);
  }
});

t('eco: леса есть, мелочи нет (propsMinZoom = 99)', () => {
  const cl = new ConstructionLayer(QUALITY.eco);
  const sim = simOf([site('stone_house', 10, 10, { progress: 5, workers: crew(3) })]);
  const ctx = warm(cl, sim, { zoom: 2.5 });
  ok(ctx.calls.drawImage >= 3, 'плита, силуэт и леса на месте');
  ok(cl.stats().builders === 0 && cl.stats().particles === 0, 'ни фигурок, ни частиц');
  ok(ctx.calls.fillRect <= 1, 'полоски прогресса нет (допускается полоса кладки)');
});

t('enabled = false выключает слой целиком', () => {
  const cl = new ConstructionLayer(QUALITY.ultra);
  cl.enabled = false;
  const sim = simOf([site('stone_house', 10, 10, { progress: 5, workers: crew(3) })]);
  const ctx = warm(cl, sim, { zoom: 1.5 });
  ok(ctx.calls.drawImage === 0 && ctx.calls.fillRect >= 1, 'остаётся только аварийное пятно');
});

// ------------------------------------------------------------- геометрия
t('силуэт растёт снизу вверх и не превышает габарит готового здания', () => {
  const cl = new ConstructionLayer(QUALITY.high);
  const spr = fakeSprite(96, 120);
  const heights = [];
  for (const p of [0.05, 0.3, 0.6, 0.99]) {
    const sim = simOf([site('stone_house', 10, 10, { progress: p * 10 })]);
    const cl2 = new ConstructionLayer(QUALITY.high);
    const ctx = warm(cl2, sim, { zoom: 1, spr });
    const body = ctx.blits.filter(b => b.img === spr.cv);
    if (p < 0.12) { ok(body.length === 0, 'до конца земляных работ силуэта нет'); heights.push(0); continue; }
    ok(body.length === 1, `силуэт рисуется одним блитом, получено ${body.length}`);
    const bl = body[0];
    ok(bl.sw !== undefined, 'используется форма drawImage с прямоугольником источника (без clip)');
    ok(bl.sy + bl.sh <= spr.cv.height + 1e-6, 'берётся именно НИЖНЯЯ часть спрайта');
    near(bl.sh / spr.cv.height, bl.dh / (bl.dh / (bl.sh / spr.cv.height)), 1e-6, 'доли источника и приёмника совпадают');
    heights.push(bl.dh);
  }
  ok(heights[1] < heights[2] && heights[2] < heights[3], `высота растёт: ${heights.join(' < ')}`);
  ok(cl.stats().sites === 0, 'счётчик чистого слоя не тронут');
});

t('геометрия совпадает с готовым зданием — в момент сдачи нет рывка', () => {
  const cl = new ConstructionLayer(QUALITY.high);
  const spr = fakeSprite(96, 96 * heightFactor('stone_house'));
  const sim = simOf([site('stone_house', 10, 10, { progress: 9.99, buildDays: 10 })]);
  const z = TILE_PX;
  const ctx = warm(cl, sim, { zoom: 1, spr });
  const bl = ctx.blits.filter(b => b.img === spr.cv)[0];
  // Ровно та же формула, что в renderer.drawBuilding для готового здания.
  const size = z, sx = 10 * z, sy = 10 * z;
  const dw = size * 1.16, dh = dw * spr.hFact;
  const dx = sx - size * 0.08, dy = sy + size - dh;
  near(bl.dx, dx, 0.01, 'левый край');
  near(bl.dw, dw, 0.01, 'ширина');
  near(bl.dy + bl.dh, dy + dh, 0.5, 'низ спрайта — на месте низа готового здания');
});

t('леса обрезаются СВЕРХУ: разбирают верхний ярус, а не нижний', () => {
  const mk = (p) => {
    const cl = new ConstructionLayer(QUALITY.high);
    const sim = simOf([site('castle', 10, 10, { progress: p * 10 })]);
    const ctx = warm(cl, sim, { zoom: 1 });
    // Леса — самый высокий блит с прямоугольником источника, кроме тела.
    const cands = ctx.blits.filter(b => b.sw !== undefined && b.sh !== undefined);
    return cands;
  };
  const mid = mk(0.6), late = mk(0.97);
  const scafMid = mid[mid.length - 1], scafLate = late[late.length - 1];
  for (const b of [scafMid, scafLate]) {
    ok(b.sy + b.sh <= b.img.height + 1e-6, 'берутся нижние пиксели источника');
    ok(b.sy >= 0, 'источник не выходит за канвас');
  }
  ok(scafLate.dh < scafMid.dh, `к сдаче лесов меньше: ${scafLate.dh} < ${scafMid.dh}`);
});

t('полоска прогресса: над зданием, ширина по прогрессу, рисуется после зданий', () => {
  const cl = new ConstructionLayer(QUALITY.ultra);
  const b = site('stone_house', 10, 10, { progress: 5, workers: crew(2) });
  const sim = simOf([b]);
  const ctx = warm(cl, sim, { zoom: 1.5 });
  ok(ctx.calls.fillRect >= 3, 'полоска — фон, подложка и заполнение');
  // Полоска кладётся в drawFx(), то есть последними вызовами кадра.
  ok(cl._bars.length === 0, 'список полосок очищается после отрисовки');
});

// --------------------------------------------------------------- потолки
t('потолок площадок в кадре соблюдается', () => {
  const cl = new ConstructionLayer(QUALITY.ultra);
  const bs = [];
  for (let i = 0; i < 40; i++) bs.push(site('hut', 3 + (i % 8), 3 + Math.floor(i / 8), { progress: 4 }));
  const sim = simOf(bs);
  warm(cl, sim, { zoom: 1 });
  ok(cl.stats().sites <= CONSTRUCTION_LIMITS.sitesFrame,
    `площадок в кадре ${cl.stats().sites} при потолке ${CONSTRUCTION_LIMITS.sitesFrame}`);
});

t('фигурок не больше, чем прислало ядро, и не больше потолка пресета', () => {
  for (const id of ['medium', 'high', 'ultra']) {
    const cl = new ConstructionLayer(QUALITY[id]);
    const sim = simOf([
      site('stone_house', 10, 10, { progress: 5, workers: crew(3) }),
      site('temple', 16, 10, { progress: 5, workers: crew(1) }),
      site('farm', 22, 10, { progress: 5, workers: [] }),
    ]);
    warm(cl, sim, { zoom: 2 });
    ok(cl.stats().builders <= cl.capBuilders * 2 + 1, `${id}: суммарно не больше потолка на площадку`);
    ok(cl.stats().builders >= 1, `${id}: хотя бы одна фигурка есть`);
    ok(cl.capBuilders <= CONSTRUCTION_LIMITS.buildersPerSite, `${id}: потолок не выше ядрового`);
  }
});

t('частицы масштабируются q.particles', () => {
  const counts = {};
  for (const id of ['medium', 'high', 'ultra']) {
    const cl = new ConstructionLayer(QUALITY[id]);
    const sim = simOf([site('stone_house', 10, 10, { progress: 5, workers: crew(3) })]);
    warm(cl, sim, { zoom: 2, dt: 0.3 });
    counts[id] = cl.stats().particles;
  }
  ok(counts.ultra >= counts.high && counts.high >= counts.medium,
    `плотность не убывает с пресетом: ${JSON.stringify(counts)}`);
  ok(counts.ultra > 0, 'на ultra частицы есть');
});

// ------------------------------------------------------- момент сдачи
t('вспышка зажигается на переходе «площадка → готово»', () => {
  const cl = new ConstructionLayer(QUALITY.high);
  const b = site('stone_house', 10, 10, { progress: 9, buildDays: 10 });
  const sim = simOf([b]);
  warm(cl, sim);
  ok(cl._events.length === 0, 'пока строится — вспышек нет');
  b.done = true; b.progress = b.buildDays;
  frame(cl, sim);
  ok(cl._events.length === 1, 'сдача поймана');
  // Вспышка живёт меньше секунды.
  for (let i = 0; i < 12; i++) frame(cl, sim, { dt: 0.1 });
  ok(cl._events.length === 0, 'и гаснет сама');
});

t('готовое из сейва и placeFree вспышки не дают', () => {
  const cl = new ConstructionLayer(QUALITY.high);
  const b = site('campfire', 10, 10, { progress: 0.01, buildDays: 0.01, done: true });
  const sim = simOf([b]);
  for (let i = 0; i < 5; i++) frame(cl, sim);
  ok(cl._events.length === 0, 'здание, которое мы никогда не видели площадкой, не вспыхивает');
});

t('снос недостроя вспышки не даёт', () => {
  const cl = new ConstructionLayer(QUALITY.high);
  const b = site('stone_house', 10, 10, { progress: 5 });
  const sim = simOf([b]);
  warm(cl, sim);
  b.destroyed = true;
  frame(cl, sim);
  b.done = true;             // руину когда-нибудь отстроят — это тоже не вспышка
  b.destroyed = true;
  frame(cl, sim);
  ok(cl._events.length === 0, 'разрушенная площадка не празднует сдачу');
});

t('вспышка аддитивна и её щепки уложены в потолок', () => {
  const cl = new ConstructionLayer(QUALITY.ultra);
  const b = site('stone_house', 10, 10, { progress: 9, buildDays: 10 });
  const sim = simOf([b]);
  warm(cl, sim);
  b.done = true; b.progress = b.buildDays;
  const ctx = frame(cl, sim, { dt: 0.2 });
  const lit = ctx.blits.filter(bl => bl.op === 'lighter');
  ok(lit.length >= 1, 'вспышка кладётся аддитивно');
  ok(ctx.saves >= 1 && ctx.depth === 0, 'режим наложения возвращён: save/restore парны');
  ok(ctx.calls.drawImage <= 1 + CONSTRUCTION_LIMITS.flashChips + 2,
    `щепок не больше потолка, всего блитов ${ctx.calls.drawImage}`);
});

t('потолок одновременных вспышек', () => {
  const cl = new ConstructionLayer(QUALITY.ultra);
  const bs = [];
  for (let i = 0; i < 20; i++) bs.push(site('hut', 3 + i, 5, { progress: 9, buildDays: 10 }));
  const sim = simOf(bs);
  warm(cl, sim);
  for (const b of bs) { b.done = true; b.progress = b.buildDays; }
  frame(cl, sim, { dt: 0.01 });
  ok(cl._events.length <= CONSTRUCTION_LIMITS.flashes,
    `вспышек ${cl._events.length} при потолке ${CONSTRUCTION_LIMITS.flashes}`);
});

// ------------------------------------------------------------- живучесть
t('смена пресета чистит кэши и не роняет слой', () => {
  const cl = new ConstructionLayer(QUALITY.high);
  const sim = simOf([site('stone_house', 10, 10, { progress: 5, workers: crew(3) })]);
  warm(cl, sim, { zoom: 2 });
  ok(cl.scaf.size > 0, 'кэш лесов наполнился');
  cl.setQuality(QUALITY.eco);
  ok(cl.scaf.size === 0 && cl.plates.size === 0, 'после смены пресета кэши пусты');
  warm(cl, sim, { zoom: 2 });
  ok(cl.stats().sites === 1, 'слой продолжает работать');
});

t('спрайт здания не запрашивается там, где не нужен', () => {
  let asked = 0;
  const cl = new ConstructionLayer(QUALITY.high);
  const sim = simOf([site('stone_house', 10, 10, { progress: 0.5, buildDays: 10 })]); // p = 0.05, фундамент
  for (let i = 0; i < 8; i++) {
    cl.begin(sim, 1 / 60, 0, 0, TILE_PX, 1600, 900);
    cl.site(sim, frameCtx(), sim.buildings[0], 320, 320, TILE_PX, () => { asked++; return fakeSprite(); });
    cl.drawFx(frameCtx());
  }
  ok(asked === 0, `на этапе фундамента спрайт не печётся, запросов ${asked}`);
});

t('мусорные данные не роняют кадр', () => {
  const cl = new ConstructionLayer(QUALITY.high);
  const bad = [
    site('hut', 0, 0, { progress: NaN }),
    site('hut', 1, 1, { buildDays: 0 }),
    site('hut', 2, 2, { workers: null }),
    site('hut', 3, 3, { size: 0 }),
  ];
  const sim = simOf(bad);
  warm(cl, sim, { zoom: 2 });
  ok(true, 'кадр прошёл без исключений');
});

t('отсутствие спрайта (пустой рисовальщик Шпиля) не ломает площадку', () => {
  const cl = new ConstructionLayer(QUALITY.high);
  const sim = simOf([site('spire', 10, 10, { progress: 5 })]);
  const ctx = warm(cl, sim, { zoom: 1, spr: null });
  ok(ctx.calls.drawImage >= 2, 'плита и леса всё равно нарисованы');
});

console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
process.exit(fail ? 1 : 0);
