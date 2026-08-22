// Тесты слоя границ владений (app/src/render/borders_view.js).
// Запуск: node app/tests/test-borders-view.mjs
//
// Канваса в node нет, поэтому здесь подставной document: контекст 2D с теми же
// методами, но без единого пикселя. Так проверяется то, что вообще можно
// проверить машиной: КАК слой сшивает контур, КОГДА он перепекает картинку и
// сколько работы отдаёт растеризатору в кадре. Пиксели проверит глаз.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TILE, FACTIONS } from '../src/core/data.js';
import { createBorders, updateBorders, OWNER_PLAYER } from '../src/core/systems/borders.js';

const noop = () => {};
function fakeCtx(cv) {
  return {
    canvas: cv,
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, lineJoin: '', lineCap: '',
    calls: { fillRect: 0, drawImage: 0, stroke: 0, fill: 0, rect: 0, clearRect: 0, createPattern: 0 },
    save: noop, restore: noop, translate: noop, scale: noop,
    setTransform: noop,
    clearRect() { this.calls.clearRect++; },
    fillRect() { this.calls.fillRect++; },
    beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop,
    rect() { this.calls.rect++; },
    fill() { this.calls.fill++; },
    stroke() { this.calls.stroke++; },
    drawImage() { this.calls.drawImage++; },
    createPattern() { this.calls.createPattern++; return { fake: true }; },
  };
}
function fakeCanvas() {
  const cv = { width: 0, height: 0 };
  cv.getContext = () => (cv._ctx || (cv._ctx = fakeCtx(cv)));
  return cv;
}
globalThis.document = { createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : {}) };

const { QUALITY } = await import('../src/render/quality.js');
const {
  BordersView, traceContours, contestedMask, ownerColorOf, bordersState,
  pickBakePx, fillBand, h3, FILL_BANDS,
} = await import('../src/render/borders_view.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

// --------------------------------------------------------------- заготовки
function grid(W, H, paint) {
  const owners = new Uint8Array(W * H);
  paint((x, y, v) => { owners[y * W + x] = v; });
  return owners;
}
const world = (w = 32, h = 32, seed = 4242) => ({
  w, h, tiles: new Uint8Array(w * h).fill(TILE.GRASS), seed, startX: w >> 1, startY: h >> 1,
});
// Глубина внутри владения — та же многоисточниковая волна, что в
// borders.js/_buildDepth: 1 на кромке, дальше вглубь. Без неё заливка в тесте
// была бы одноцветной, и проверка склейки отрезков ничего бы не значила.
function fillDepth(st) {
  const W = st.w, H = st.h, o = st.owners, d = st.depth;
  d.fill(0);
  const q = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, c = o[i];
    if (!c) continue;
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1
      || o[i - 1] !== c || o[i + 1] !== c || o[i - W] !== c || o[i + W] !== c;
    if (edge) { d[i] = 1; q.push(i); }
  }
  for (let h = 0; h < q.length; h++) {
    const i = q[h], c = o[i], nd = d[i] + 1;
    const x = i % W, y = (i / W) | 0;
    if (x > 0 && o[i - 1] === c && !d[i - 1]) { d[i - 1] = nd; q.push(i - 1); }
    if (x < W - 1 && o[i + 1] === c && !d[i + 1]) { d[i + 1] = nd; q.push(i + 1); }
    if (y > 0 && o[i - W] === c && !d[i - W]) { d[i - W] = nd; q.push(i - W); }
    if (y < H - 1 && o[i + W] === c && !d[i + W]) { d[i + W] = nd; q.push(i + W); }
  }
}
function stateFrom(owners, W, H) {
  const st = createBorders(W, H);
  st.owners.set(owners);
  fillDepth(st);
  st.tiles.fill(0);
  for (let i = 0; i < owners.length; i++) if (owners[i]) st.tiles[owners[i]]++;
  st.recomputes = 1; st.version = 123; st.lastDay = 5;
  return st;
}
function mockSim(st, over = {}) {
  return {
    world: world(st.w, st.h),
    factions: [{ id: 'wolves', def: FACTIONS.find(f => f.id === 'wolves'), alive: true }],
    showTerritory: false,
    sys: { borders: st },
    ...over,
  };
}

// ------------------------------------------------------------ трассировка
t('контур: одна клетка — замкнутая ломаная из четырёх углов', () => {
  const W = 5, H = 5;
  const owners = grid(W, H, (s) => s(2, 2, OWNER_PLAYER));
  const r = traceContours(owners, W, H, OWNER_PLAYER);
  ok(r.segments === 4, `рёбер должно быть 4, а не ${r.segments}`);
  ok(r.polys.length === 1, `ломаных должно быть 1, а не ${r.polys.length}`);
  ok(r.polys[0].closed, 'контур одной клетки обязан быть замкнут');
  ok(r.points === 4, `после склейки коллинеарных должно остаться 4 точки, а не ${r.points}`);
  const b = r.bbox;
  ok(b.x0 === 2 && b.y0 === 2 && b.x1 === 3 && b.y1 === 3, `не тот bbox: ${JSON.stringify(b)}`);
});

t('контур: блок 3×3 — те же четыре точки, коллинеарные схлопнуты', () => {
  const W = 7, H = 7;
  const owners = grid(W, H, (s) => { for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) s(x, y, OWNER_PLAYER); });
  const r = traceContours(owners, W, H, OWNER_PLAYER);
  ok(r.segments === 12, `рёбер по периметру 3×3 должно быть 12, а не ${r.segments}`);
  ok(r.polys.length === 1, `ломаных 1, а не ${r.polys.length}`);
  ok(r.points === 4, `склейка не сработала: ${r.points} точек вместо 4`);
});

t('контур: два разъединённых пятна дают две ломаные', () => {
  const W = 9, H = 5;
  const owners = grid(W, H, (s) => { s(1, 2, OWNER_PLAYER); s(7, 2, OWNER_PLAYER); });
  const r = traceContours(owners, W, H, OWNER_PLAYER);
  ok(r.polys.length === 2, `ожидались 2 ломаные, получено ${r.polys.length}`);
});

t('контур: дырка внутри владения обводится отдельной ломаной', () => {
  const W = 7, H = 7;
  const owners = grid(W, H, (s) => {
    for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) s(x, y, OWNER_PLAYER);
    s(3, 3, 0);
  });
  const r = traceContours(owners, W, H, OWNER_PLAYER);
  ok(r.polys.length === 2, `внешний контур + дырка = 2 ломаные, получено ${r.polys.length}`);
  ok(r.polys.every(p => p.closed), 'обе ломаные обязаны быть замкнуты');
});

t('контур: край карты — тоже граница', () => {
  const W = 4, H = 4;
  const owners = grid(W, H, (s) => { for (let y = 0; y < H; y++) s(0, y, OWNER_PLAYER); });
  const r = traceContours(owners, W, H, OWNER_PLAYER);
  ok(r.polys.length === 1, `у полосы вдоль края 1 контур, а не ${r.polys.length}`);
  ok(r.bbox.x0 === 0, 'контур обязан доходить до x=0');
});

t('контур: ломаная непрерывна — соседние точки различаются ровно по одной оси', () => {
  const W = 12, H = 12;
  const owners = grid(W, H, (s) => {
    for (let y = 2; y < 9; y++) for (let x = 2; x < 9; x++) if ((x + y) % 5 !== 0) s(x, y, OWNER_PLAYER);
  });
  const r = traceContours(owners, W, H, OWNER_PLAYER);
  for (const p of r.polys) {
    const a = p.pts;
    for (let i = 2; i < a.length; i += 2) {
      const dx = Math.abs(a[i] - a[i - 2]), dy = Math.abs(a[i + 1] - a[i - 1]);
      ok((dx === 0) !== (dy === 0), `разрыв в ломаной: (${a[i - 2]},${a[i - 1]}) → (${a[i]},${a[i + 1]})`);
    }
  }
});

t('контур: потолок точек соблюдается', () => {
  const W = 24, H = 24;
  const owners = grid(W, H, (s) => { for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) s(x, y, OWNER_PLAYER); });
  const r = traceContours(owners, W, H, OWNER_PLAYER, { maxPoints: 40 });
  ok(r.truncated, 'обрыв по потолку не отмечен');
  ok(r.points < 60, `после обрыва точек не должно быть много больше потолка: ${r.points}`);
});

t('контур: у чужого кода своя геометрия, не пересекается со своей', () => {
  const W = 6, H = 3;
  const owners = grid(W, H, (s) => { s(1, 1, OWNER_PLAYER); s(4, 1, 2); });
  const mine = traceContours(owners, W, H, OWNER_PLAYER);
  const his = traceContours(owners, W, H, 2);
  ok(mine.polys.length === 1 && his.polys.length === 1, 'у каждого владельца свой контур');
  ok(mine.bbox.x0 === 1 && his.bbox.x0 === 4, 'контуры перепутаны местами');
});

// ------------------------------------------------------------ спорные клетки
t('спор: ничья клетка между двумя державами помечена', () => {
  const W = 5, H = 3;
  const owners = grid(W, H, (s) => { s(1, 1, OWNER_PLAYER); s(3, 1, 2); });
  const m = contestedMask(stateFrom(owners, W, H), world(W, H));
  ok(m[1 * W + 2] === 1, 'клетка ровно между двумя владельцами не помечена спорной');
});

t('спор: у клетки с единственным соседом-владельцем спора нет', () => {
  const W = 5, H = 3;
  const owners = grid(W, H, (s) => s(1, 1, OWNER_PLAYER));
  const m = contestedMask(stateFrom(owners, W, H), world(W, H));
  let any = 0;
  for (let i = 0; i < m.length; i++) any += m[i];
  ok(any === 0, `спорных быть не должно, а их ${any}`);
});

t('спор: занятая клетка спорной не бывает', () => {
  const W = 3, H = 3;
  const owners = grid(W, H, (s) => { s(0, 1, OWNER_PLAYER); s(1, 1, OWNER_PLAYER); s(2, 1, 2); });
  const m = contestedMask(stateFrom(owners, W, H), world(W, H));
  ok(m[1 * W + 1] === 0, 'клетка с владельцем помечена спорной');
});

t('спор: вода не штрихуется', () => {
  const W = 5, H = 3;
  const owners = grid(W, H, (s) => { s(1, 1, OWNER_PLAYER); s(3, 1, 2); });
  const wl = world(W, H);
  wl.tiles[1 * W + 2] = TILE.WATER;
  const m = contestedMask(stateFrom(owners, W, H), wl);
  ok(m[1 * W + 2] === 0, 'пролив между державами помечен спорным');
});

// ------------------------------------------------------------ мелочи
t('цвет: игрок — золотой, сосед — свой из f.def.color', () => {
  const st = stateFrom(new Uint8Array(9), 3, 3);
  const sim = mockSim(st);
  ok(ownerColorOf(sim, OWNER_PLAYER) === '#c9a227', 'игрок не золотой');
  ok(ownerColorOf(sim, 2) === FACTIONS[0].color, `сосед не своего цвета: ${ownerColorOf(sim, 2)}`);
  ok(ownerColorOf(sim, 99) === '#6a6f7a', 'неизвестный код не серый');
});

t('цвет: живой def перебивает таблицу', () => {
  const st = stateFrom(new Uint8Array(9), 3, 3);
  const sim = mockSim(st, { factions: [{ id: FACTIONS[0].id, def: { color: '#00ff00' }, alive: true }] });
  ok(ownerColorOf(sim, 2) === '#00ff00', 'цвет взят из статической таблицы, а не из живой фракции');
});

t('хеш: детерминирован и зависит от сида', () => {
  ok(h3(3, 7, 42) === h3(3, 7, 42), 'хеш не детерминирован');
  let diff = 0;
  for (let i = 0; i < 64; i++) if (h3(i, i * 3, 1) !== h3(i, i * 3, 2)) diff++;
  ok(diff > 50, `сид почти не влияет на хеш: расхождений ${diff} из 64`);
  for (let i = 0; i < 200; i++) { const v = h3(i, 17, 9); ok(v >= 0 && v < 1, `хеш вне [0,1): ${v}`); }
});

t('полосы: кромка ярче глубины, дизер не выходит за границы таблицы', () => {
  ok(FILL_BANDS[0] > FILL_BANDS[FILL_BANDS.length - 1], 'кромка не ярче сердца страны');
  for (let x = 0; x < 50; x++) for (let d = 1; d < 9; d++) {
    const b = fillBand(d, x, d, 4242);
    ok(b >= 0 && b < FILL_BANDS.length, `полоса вне таблицы: ${b}`);
  }
  ok(fillBand(9, 5, 5, 1) === FILL_BANDS.length - 1, 'глубокая клетка не в самой слабой полосе');
});

t('полосы: дизер размывает кольца — на кромке встречается больше одной полосы', () => {
  const seen = new Set();
  for (let x = 0; x < 200; x++) seen.add(fillBand(2, x, 3, 4242));
  ok(seen.size > 1, 'дизер не работает: кольца глубины останутся квадратными');
});

t('разрешение выпечки: степень двойки, растёт с пресетом, влезает в бюджет', () => {
  const eco = pickBakePx(QUALITY.eco, 96, 96);
  const ultra = pickBakePx(QUALITY.ultra, 96, 96);
  ok(ultra > eco, `ultra должна печь мельче eco: ${ultra} vs ${eco}`);
  for (const id of ['eco', 'medium', 'high', 'ultra']) {
    const px = pickBakePx(QUALITY[id], 96, 96);
    ok((px & (px - 1)) === 0, `${id}: ${px} — не степень двойки`);
    ok(96 * px * 96 * px * 4 <= QUALITY[id].caps.textureMB * 1024 * 1024 / 4,
      `${id}: выпечка ${px}px не влезает в четверть текстурного бюджета`);
  }
  ok(pickBakePx(QUALITY.ultra, 512, 512) <= pickBakePx(QUALITY.ultra, 96, 96),
    'большой мир обязан печься грубее');
});

// ------------------------------------------------------------ слой в кадре
function layerWithRealm(qId = 'high') {
  const W = 16, H = 16;
  const owners = grid(W, H, (s) => {
    for (let y = 3; y < 8; y++) for (let x = 3; x < 8; x++) s(x, y, OWNER_PLAYER);
    for (let y = 3; y < 8; y++) for (let x = 11; x < 15; x++) s(x, y, 2);
  });
  const st = stateFrom(owners, W, H);
  const sim = mockSim(st);
  return { view: new BordersView(QUALITY[qId]), sim, st, W, H };
}

t('кадр: выпечка происходит один раз, дальше только блит и обводка', () => {
  const { view, sim } = layerWithRealm();
  const ctx = fakeCtx(null);
  view.draw(sim, ctx, 0, 0, 32, 800, 600, { zoom: 1 });
  const after1 = view.bakes;
  const blit1 = ctx.calls.drawImage;
  for (let i = 0; i < 10; i++) view.draw(sim, ctx, -i, -i, 32, 800, 600, { zoom: 1 });
  ok(after1 === 1, `первый кадр обязан выпечь ровно один раз, а не ${after1}`);
  ok(view.bakes === 1, `десять кадров перепекли ${view.bakes} раз вместо одного`);
  ok(ctx.calls.drawImage === blit1 + 10, `на кадр должен приходиться ровно один блит: ${ctx.calls.drawImage}`);
});

t('кадр: смена версии границ перепекает', () => {
  const { view, sim, st } = layerWithRealm();
  const ctx = fakeCtx(null);
  view.draw(sim, ctx, 0, 0, 32, 800, 600, { zoom: 1 });
  st.recomputes++;
  view.draw(sim, ctx, 0, 0, 32, 800, 600, { zoom: 1 });
  ok(view.bakes === 2, `после пересчёта границ выпечка обязана обновиться: ${view.bakes}`);
});

t('кадр: смена режима перепекает, смена камеры — нет', () => {
  const { view, sim } = layerWithRealm();
  const ctx = fakeCtx(null);
  view.draw(sim, ctx, 0, 0, 32, 800, 600, { zoom: 1 });
  view.draw(sim, ctx, -400, -300, 64, 800, 600, { zoom: 2 });
  ok(view.bakes === 1, 'панорама и зум не должны трогать выпечку');
  sim.showTerritory = true;
  view.draw(sim, ctx, 0, 0, 32, 800, 600, { zoom: 1 });
  ok(view.bakes === 2, 'переключение политической карты обязано перепечь');
});

t('кадр: смена пресета сбрасывает выпечку', () => {
  const { view, sim } = layerWithRealm('eco');
  const ctx = fakeCtx(null);
  view.draw(sim, ctx, 0, 0, 32, 800, 600, { zoom: 1 });
  view.setQuality(QUALITY.ultra);
  ok(view.cv === null && view.key === '', 'старая выпечка не отпущена');
  view.draw(sim, ctx, 0, 0, 32, 800, 600, { zoom: 1 });
  ok(view.bakes === 2, `после смены пресета выпечка обязана повториться: ${view.bakes}`);
  // На мире 96×96 разрешение выпечки у ultra выше, чем у eco (на крошечном
  // мире оба упираются в потолок 16 px и совпадают — это не поломка).
  ok(pickBakePx(QUALITY.ultra, 96, 96) > pickBakePx(QUALITY.eco, 96, 96), 'пресет не влияет на разрешение выпечки');
});

t('кадр: без состояния границ слой молчит', () => {
  const view = new BordersView(QUALITY.high);
  const ctx = fakeCtx(null);
  const st = stateFrom(new Uint8Array(256), 16, 16);
  const sim = mockSim(st, { sys: {}, borders: null });
  ok(view.draw(sim, ctx, 0, 0, 32, 800, 600, { zoom: 1 }) === 0, 'слой что-то нарисовал без границ');
  ok(ctx.calls.drawImage === 0 && ctx.calls.stroke === 0, 'слой трогал контекст без данных');
});

t('кадр: границы из sim.borders тоже находятся', () => {
  const { st } = layerWithRealm();
  const sim = mockSim(st, { sys: {}, borders: st });
  ok(bordersState(sim) === st, 'путь sim.borders не поддержан');
});

t('кадр: владения целиком за экраном — блита нет', () => {
  const { view, sim } = layerWithRealm();
  const ctx = fakeCtx(null);
  // Камера уехала на десять экранов вправо: содержимое выпечки не видно.
  view.draw(sim, ctx, -20000, -20000, 32, 800, 600, { zoom: 1 });
  ok(ctx.calls.drawImage === 0, 'блит нарисован там, где ничего не видно');
});

t('кадр: число stroke() ограничено числом владельцев', () => {
  const { view, sim } = layerWithRealm();
  const ctx = fakeCtx(null);
  const n = view.draw(sim, ctx, 0, 0, 32, 800, 600, { zoom: 1 });
  // два владельца × (подложка + цвет) = 4 — и ни вызовом больше
  ok(n === 4, `ожидалось 4 обводки на двух владельцев, получено ${n}`);
});

t('кадр: на eco нет тёмной подложки — обводок вдвое меньше', () => {
  const { view, sim } = layerWithRealm('eco');
  const ctx = fakeCtx(null);
  const n = view.draw(sim, ctx, 0, 0, 32, 800, 600, { zoom: 1 });
  ok(n === 2, `на eco ожидались 2 обводки, получено ${n}`);
});

t('кадр: вдали подложка выключена (lodForZoom.far)', () => {
  const { view, sim } = layerWithRealm('high');
  const ctx = fakeCtx(null);
  const n = view.draw(sim, ctx, 0, 0, 8, 800, 600, { zoom: 0.25 });
  ok(n === 2, `на дальнем зуме ожидались 2 обводки, получено ${n}`);
});

t('кадр: тихий режим заливает только свою землю, политический — все', () => {
  const { view, sim } = layerWithRealm();
  const ctx = fakeCtx(null);
  view.draw(sim, ctx, 0, 0, 32, 800, 600, { zoom: 1 });
  const quiet = view.fillBox;
  ok(quiet.x1 <= 8, `в тихом режиме залита чужая земля: ${JSON.stringify(quiet)}`);
  sim.showTerritory = true;
  view.draw(sim, ctx, 0, 0, 32, 800, 600, { zoom: 1 });
  ok(view.fillBox.x1 === 15, `в политическом режиме сосед не залит: ${JSON.stringify(view.fillBox)}`);
});

t('кадр: контуры соседей видны и в тихом режиме', () => {
  const { view, sim } = layerWithRealm();
  const ctx = fakeCtx(null);
  view.draw(sim, ctx, 0, 0, 32, 800, 600, { zoom: 1 });
  ok(view.layers.length === 2, `ожидались контуры двух держав, получено ${view.layers.length}`);
  ok(view.layers[view.layers.length - 1].code === OWNER_PLAYER, 'своя граница должна рисоваться последней, поверх чужой');
});

t('кадр: заливка склеивается в отрезки, а не рисуется по клетке', () => {
  // Держава 20×20 = 400 клеток. Поклеточная заливка дала бы 400 прямоугольников.
  // Со склейкой выходит ~113: каждую строку режет не дизер, а сама полоса
  // затухания (кромка → band 0/1, дальше band 2 и band 3), то есть 5–6 кусков
  // на строку. Это и есть тот выигрыш, ради которого сделана выпечка, — но
  // выигрыш в 3,5 раза, а не в сорок, и завышать его в тесте нечестно.
  const W = 24, H = 24;
  const owners = grid(W, H, (s) => { for (let y = 2; y < 22; y++) for (let x = 2; x < 22; x++) s(x, y, OWNER_PLAYER); });
  const view = new BordersView(QUALITY.high);
  view.draw(mockSim(stateFrom(owners, W, H)), fakeCtx(null), 0, 0, 32, 800, 600, { zoom: 1 });
  const n = view.cv.getContext('2d').calls.fillRect;
  ok(n >= 20, `заливка вообще не нарисована: ${n}`);
  ok(n < 150, `склейка отрезков не работает: ${n} прямоугольников на 400 клеток`);
});

t('кадр: штриховка спорных — один вызов fill() на всю карту', () => {
  const W = 16, H = 16;
  const owners = grid(W, H, (s) => {
    for (let y = 3; y < 8; y++) for (let x = 3; x < 8; x++) s(x, y, OWNER_PLAYER);
    for (let y = 3; y < 8; y++) for (let x = 9; x < 14; x++) s(x, y, 2);
  });
  const st = stateFrom(owners, W, H);
  const sim = mockSim(st, { showTerritory: true });
  const view = new BordersView(QUALITY.high);
  view.draw(sim, fakeCtx(null), 0, 0, 32, 800, 600, { zoom: 1 });
  const bakeCtx = view.cv.getContext('2d');
  ok(bakeCtx.calls.fill === 1, `ожидалась одна заливка штриховки, получено ${bakeCtx.calls.fill}`);
  ok(bakeCtx.calls.rect >= 5, `спорная полоса не найдена: ${bakeCtx.calls.rect} отрезков`);
});

// ------------------------------------------------------- на живом состоянии
t('живое ядро: границы из updateBorders рисуются без падений', () => {
  const wl = world(48, 48, 777);
  const st = createBorders(48, 48);
  const buildings = [
    { id: 'campfire', x: 20, y: 20, size: 1, done: true, destroyed: false },
    { id: 'hut', x: 22, y: 21, size: 1, done: true, destroyed: false },
  ];
  const factions = [{ id: 'wolves', alive: true, P: 40, settlements: [{ x: 34, y: 20, capital: true }] }];
  const changed = updateBorders(st, { world: wl, day: 1, version: 1, buildings, factions });
  ok(changed, 'ядро не пересчитало границы');
  ok(st.tiles[OWNER_PLAYER] > 0, 'у игрока нет ни клетки');
  const sim = {
    world: wl, sys: { borders: st }, showTerritory: true,
    factions: [{ id: 'wolves', def: FACTIONS.find(f => f.id === 'wolves'), alive: true }],
  };
  const view = new BordersView(QUALITY.high);
  const ctx = fakeCtx(null);
  const n = view.draw(sim, ctx, 100, 100, 24, 1200, 800, { zoom: 0.75 });
  ok(n >= 2, `обводок не было: ${n}`);
  ok(ctx.calls.drawImage === 1, `блит не один: ${ctx.calls.drawImage}`);
  const s = view.stats();
  ok(s.points > 0 && !s.truncated, `геометрия пустая или обрезана: ${JSON.stringify(s)}`);
  ok(s.points < 800, `слишком много точек для двух держав: ${s.points}`);
});

t('живое ядро: неизменившийся состав не перепекает картинку', () => {
  const wl = world(48, 48, 777);
  const st = createBorders(48, 48);
  const buildings = [{ id: 'campfire', x: 20, y: 20, size: 1, done: true, destroyed: false }];
  updateBorders(st, { world: wl, day: 1, version: 1, buildings, factions: [] });
  const sim = { world: wl, sys: { borders: st }, showTerritory: false, factions: [] };
  const view = new BordersView(QUALITY.medium);
  const ctx = fakeCtx(null);
  view.draw(sim, ctx, 0, 0, 32, 800, 600, { zoom: 1 });
  updateBorders(st, { world: wl, day: 2, version: 1, buildings, factions: [] }); // тот же состав
  view.draw(sim, ctx, 0, 0, 32, 800, 600, { zoom: 1 });
  ok(view.bakes === 1, `выпечка повторилась зря: ${view.bakes}`);
});

t('кадр: при наличии Path2D геометрия уходит в путь — по одному stroke на владельца', () => {
  // В node Path2D нет, и слой рисует ломаные руками. В браузере он обязан
  // сложить всю границу владельца в один Path2D: подставляем заглушку и
  // проверяем, что число stroke() не зависит от числа ломаных.
  const prev = globalThis.Path2D;
  globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} };
  try {
    const W = 12, H = 6;
    // Три отдельных пятна одного владельца — три ломаные, но один путь.
    const owners = grid(W, H, (s) => { s(1, 2, OWNER_PLAYER); s(5, 2, OWNER_PLAYER); s(9, 2, OWNER_PLAYER); });
    const view = new BordersView(QUALITY.high);
    const ctx = fakeCtx(null);
    const n = view.draw(mockSim(stateFrom(owners, W, H)), ctx, 0, 0, 32, 800, 600, { zoom: 1 });
    ok(view.layers[0].polys.length === 3, 'пятен должно быть три');
    ok(view.layers[0].path, 'Path2D не собран');
    ok(n === 2 && ctx.calls.stroke === 2, `ожидались подложка + цвет одним путём, получено ${ctx.calls.stroke}`);
  } finally {
    if (prev === undefined) delete globalThis.Path2D; else globalThis.Path2D = prev;
  }
});

// ------------------------------------------------------------------ гигиена
t('гигиена: ни Math.random, ни sim.rng в файле рендера', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/render/borders_view.js'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(!/Math\.random/.test(code), 'в коде есть Math.random');
  ok(!/\.rng\b/.test(code), 'в коде есть обращение к sim.rng');
});

console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
process.exit(fail ? 1 : 0);
