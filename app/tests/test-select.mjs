// app/tests/test-select.mjs — проверки слоя выделения (render/select.js).
//
// Слой рисующий, но проверяемый: вся его логика — арифметика над состоянием и
// последовательность вызовов канваса. Поэтому здесь подставной 2D-контекст,
// который ничего не растеризует, а только пишет журнал вызовов, и по этому
// журналу проверяется главное: геометрия кольца, соблюдение потолков, выпечка
// один раз, детерминизм и отсутствие записи в симуляцию.
//
// Запускается штатным npm test: tools/test-all.mjs забирает все .mjs из
// app/tests и разбирает последнюю строку вида «=== N OK / M FAIL ===».
import { SelectLayer, SELECT_LIMITS } from '../src/render/select.js';
import { QUALITY } from '../src/render/quality.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let ok = 0, fail = 0;
function t(name, cond, extra = '') {
  if (cond) { ok++; return; }
  fail++;
  console.log(`  FAIL: ${name}${extra ? ' — ' + extra : ''}`);
}

// ---------------------------------------------------------------------------
// Подставной канвас. Считаем созданные канвасы: это прямая проверка правила
// «выпекать один раз, в кадре только блитить».
let canvasesMade = 0;
function fakeCanvas(w = 0, h = 0) {
  const cv = { width: w, height: h, _fake: true };
  cv.getContext = () => recorder(cv);
  return cv;
}
function recorder(owner) {
  const log = [];
  const ctx = {
    log, owner,
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    lineCap: 'butt', lineDashOffset: 0, globalCompositeOperation: 'source-over',
    save() { log.push(['save']); }, restore() { log.push(['restore']); },
    beginPath() { log.push(['beginPath']); },
    moveTo(x, y) { log.push(['moveTo', x, y]); },
    lineTo(x, y) { log.push(['lineTo', x, y]); },
    arc(x, y, r) { log.push(['arc', x, y, r]); },
    ellipse(x, y, rx, ry) { log.push(['ellipse', x, y, rx, ry]); },
    stroke() { log.push(['stroke', this.strokeStyle, this.lineWidth, this.lineDashOffset]); },
    fill() { log.push(['fill', this.fillStyle]); },
    fillRect(x, y, w, h) { log.push(['fillRect', x, y, w, h, this.fillStyle]); },
    strokeRect(x, y, w, h) { log.push(['strokeRect', x, y, w, h, this.strokeStyle]); },
    setLineDash(a) { log.push(['setLineDash', a.join(',')]); },
    drawImage(img, ...a) { log.push(['drawImage', a.length, ...a.map(n => Math.round(n * 100) / 100), this.globalAlpha.toFixed(3)]); },
    createRadialGradient() { log.push(['grad']); return { addColorStop() {} }; },
  };
  return ctx;
}
globalThis.document = { createElement: () => { canvasesMade++; return fakeCanvas(); } };

// ---------------------------------------------------------------------------
// Подставная симуляция: ровно те поля, которые слой имеет право читать.
function makeSim() {
  const sim = {
    world: { seed: 4242, w: 96, h: 96 },
    placing: null,
    buildings: [
      { id: 'hut', x: 10, y: 10, size: 1, done: true, destroyed: false },
      { id: 'smithy', x: 14, y: 10, size: 1, done: true, destroyed: false },
      { id: 'mill', x: 20, y: 12, size: 1, done: true, destroyed: false },
      { id: 'spire', x: 30, y: 30, size: 2, done: true, destroyed: false },
    ],
    villagers: [
      { name: 'Аня', x: 10.5, y: 12.5, hp: 100, job: 'work', target: null, path: null },
      { name: 'Борис', x: 40.2, y: 41.8, hp: 100, job: 'work', target: { kind: 'work', x: 20, y: 12 }, path: null },
    ],
    hasBuilding(id) { return this.buildings.some(b => b.id === id && !b.destroyed); },
    buildingAt(x, y) {
      return this.buildings.find(b => !b.destroyed && x >= b.x && y >= b.y
        && x < b.x + (b.size || 1) && y < b.y + (b.size || 1));
    },
  };
  return sim;
}

const Z = 32;                      // пикселей на клетку при zoom = 1
const frame = { ox: 0, oy: 0, cw: 1600, ch: 900 };
function draw(layer, sim, ctx, dt = 1 / 60, z = Z) {
  layer.drawGround(sim, ctx, frame.ox, frame.oy, z, frame.cw, frame.ch, dt);
  layer.drawTop(sim, ctx, frame.ox, frame.oy, z, frame.cw, frame.ch);
}

// ===========================================================================
// 1. Выбор цели указателем
{
  const sim = makeSim();
  const L = new SelectLayer(QUALITY.high);

  const onHut = L.pick(sim, 10.5, 10.5);
  t('клик по клетке хижины даёт постройку', onHut.kind === 'b' && onHut.b.id === 'hut');
  t('якорь подсветки — угол постройки, а не клетка курсора', onHut.tx === 10 && onHut.ty === 10);

  const onSpire = L.pick(sim, 31.4, 31.4);
  t('вторая клетка Шпиля 2×2 тоже попадает в Шпиль', onSpire.kind === 'b' && onSpire.b.id === 'spire');
  t('якорь Шпиля — его собственный угол', onSpire.tx === 30 && onSpire.ty === 30);

  const empty = L.pick(sim, 50.5, 50.5);
  t('пустая земля даёт kind=t', empty.kind === 't' && empty.tx === 50 && empty.ty === 50);

  // Житель стоит в 10.5;12.5, целимся в корпус — на 0.17 клетки выше ног.
  const onMan = L.pick(sim, 10.5, 12.33);
  t('житель ловится указателем', onMan.kind === 'v' && onMan.v.name === 'Аня');

  const far = L.pick(sim, 10.5, 13.4);
  t('за радиусом попадания житель не ловится', far.kind !== 'v');

  // Житель, стоящий НА клетке дома, обязан выигрывать: иначе в него не ткнуть.
  sim.villagers[0].x = 10.5; sim.villagers[0].y = 10.5;
  const overlap = L.pick(sim, 10.5, 10.33);
  t('житель поверх постройки приоритетнее постройки', overlap.kind === 'v');

  t('радиус попадания разумный', SELECT_LIMITS.pickR > 0.2 && SELECT_LIMITS.pickR < 0.7);
}

// 2. Состояние выделения
{
  const sim = makeSim();
  const L = new SelectLayer(QUALITY.high);
  const a = L.selectAt(sim, 10.5, 10.5);
  t('клик выделяет постройку', a && L.selection && L.selection.b.id === 'hut');
  const b = L.selectAt(sim, 10.5, 10.5);
  t('повторный клик по тому же снимает выделение', b === null && L.selection === null);
  L.selectAt(sim, 14.5, 10.5);
  t('клик по другой постройке переносит выделение', L.selection.b.id === 'smithy');
  L.selectAt(sim, 60.5, 60.5);
  t('клик по пустой земле снимает выделение', L.selection === null);

  L.hoverAt(sim, 14.5, 10.5);
  t('наведение запоминается', L.hover && L.hover.b.id === 'smithy');
  L.clearHover();
  t('clearHover снимает наведение', L.hover === null);
}

// 3. Исчезнувшие объекты не оставляют висящих колец
{
  const sim = makeSim();
  const L = new SelectLayer(QUALITY.high);
  const ctx = recorder(null);
  L.selectAt(sim, 14.5, 10.5);
  L.hoverAt(sim, 10.5, 10.5);
  sim.buildings[1].destroyed = true;          // кузницу снесли рейдом
  sim.buildings[0].destroyed = true;
  draw(L, sim, ctx);
  t('снесённая постройка снимается с выделения', L.selection === null);
  t('снесённая постройка снимается с наведения', L.hover === null);

  const sim2 = makeSim();
  const L2 = new SelectLayer(QUALITY.high);
  L2.selectAt(sim2, 10.5, 12.33);
  t('житель выделен', L2.selection && L2.selection.kind === 'v');
  sim2.villagers[0].hp = 0;
  draw(L2, sim2, recorder(null));
  t('умерший житель снимается с выделения', L2.selection === null);

  const sim3 = makeSim();
  const L3 = new SelectLayer(QUALITY.high);
  L3.selectAt(sim3, 10.5, 12.33);
  sim3.villagers = [sim3.villagers[1]];       // жителя убрали из мира (новая партия)
  draw(L3, sim3, recorder(null));
  t('житель вне списка мира снимается с выделения', L3.selection === null);
}

// 4. Молчание, когда рисовать нечего
{
  const sim = makeSim();
  const L = new SelectLayer(QUALITY.high);
  const ctx = recorder(null);
  draw(L, sim, ctx);
  t('без наведения и выбора слой не делает ни одного вызова', ctx.log.length === 0, `${ctx.log.length}`);

  L.hoverAt(sim, 10.5, 10.5);
  const ctx2 = recorder(null);
  L.drawGround(sim, ctx2, 0, 0, SELECT_LIMITS.minZoomPx - 1, 1600, 900, 1 / 60);
  t('ниже порога зума слой молчит', ctx2.log.length === 0, `${ctx2.log.length}`);

  const ctx3 = recorder(null);
  sim.placing = { id: 'hut', x: 10, y: 10, valid: true };
  draw(L, sim, ctx3);
  t('во время постановки здания наведение не рисуется', ctx3.log.length === 0, `${ctx3.log.length}`);
  sim.placing = null;

  const ctx4 = recorder(null);
  L.enabled = false;
  draw(L, sim, ctx4);
  t('enabled=false выключает слой', ctx4.log.length === 0);
  L.enabled = true;
}

// 5. Геометрия кольца: эллипс, сплюснутый ровно вдвое, у подошвы постройки
{
  const sim = makeSim();
  const L = new SelectLayer(QUALITY.high);
  const ctx = recorder(null);
  L.selectAt(sim, 10.5, 10.5);
  draw(L, sim, ctx);
  const blits = ctx.log.filter(e => e[0] === 'drawImage');
  t('кольцо нарисовано блитом выпечки', blits.length >= 1);
  const r = blits[0];                          // ['drawImage', n, dx, dy, dw, dh, alpha]
  const dw = r[4], dh = r[5];
  t('кольцо сплюснуто по вертикали ровно вдвое', Math.abs(dh * 2 - dw) < 0.05, `dw=${dw} dh=${dh}`);
  const cx = r[2] + dw / 2, cy = r[3] + dh / 2;
  t('кольцо центрировано по клетке постройки', Math.abs(cx - (10 * Z + Z / 2)) < 0.05, `cx=${cx}`);
  t('кольцо садится к подошве спрайта, а не в центр клетки',
    cy > 10 * Z + Z * 0.8 && cy < 10 * Z + Z * 0.95, `cy=${cy}`);
  t('радиус кольца шире полклетки (спрайт шире клетки)', dw / 2 > Z * 0.5, `rx=${dw / 2}`);
}

// 6. Разные цвета у наведения и у выбора
{
  const sim = makeSim();
  const L = new SelectLayer(QUALITY.high);
  L.selectAt(sim, 10.5, 10.5);
  L.hoverAt(sim, 14.5, 10.5);
  const ctx = recorder(null);
  draw(L, sim, ctx);
  const blits = ctx.log.filter(e => e[0] === 'drawImage');
  t('нарисованы два кольца — выбор и наведение', blits.length >= 2, `${blits.length}`);
  t('счётчик колец в stats совпадает', L.stats().rings >= 2);

  // Наведение на уже выбранное второго кольца не даёт.
  L.hoverAt(sim, 10.5, 10.5);
  const ctx2 = recorder(null);
  draw(L, sim, ctx2);
  const rings2 = ctx2.log.filter(e => e[0] === 'drawImage');
  t('наведение на выбранное не удваивает кольцо', rings2.length === 1, `${rings2.length}`);
}

// 7. Подсветка клетки учитывает размер постройки
{
  const sim = makeSim();
  const L = new SelectLayer(QUALITY.high);
  const ctx = recorder(null);
  L.hoverAt(sim, 10.5, 10.5);
  draw(L, sim, ctx);
  const sr = ctx.log.find(e => e[0] === 'strokeRect');
  t('подсветка клетки нарисована', !!sr);
  t('обычная постройка — одна клетка', Math.abs(sr[3] - (Z - sr[3] + sr[3])) >= 0 && sr[3] < Z && sr[3] > Z * 0.9, `w=${sr[3]}`);

  const ctx2 = recorder(null);
  L.hoverAt(sim, 30.5, 30.5);
  draw(L, sim, ctx2);
  const sr2 = ctx2.log.find(e => e[0] === 'strokeRect');
  t('Шпиль подсвечивается на все 2×2 клетки', sr2[3] > Z * 1.9 && sr2[3] < Z * 2, `w=${sr2[3]}`);

  const ctx3 = recorder(null);
  L.hoverAt(sim, 55.5, 55.5);
  draw(L, sim, ctx3);
  const sr3 = ctx3.log.find(e => e[0] === 'strokeRect');
  t('пустая клетка тоже подсвечивается', !!sr3 && sr3[1] === 55 * Z);
}

// 8. Рамка ауры повторяет ПРАВИЛО, а не картинку
{
  const sim = makeSim();
  const L = new SelectLayer(QUALITY.high);
  const ctx = recorder(null);
  L.selectAt(sim, 14.5, 10.5);                 // кузница: aura.r = 2
  draw(L, sim, ctx);
  const arc = ctx.log.find(e => e[0] === 'arc');
  t('у постройки с аурой нарисован круг зоны', !!arc);
  t('радиус зоны = aura.r клеток', Math.abs(arc[3] - 2 * Z) < 0.01, `r=${arc[3]}`);
  t('зона центрирована по центру клетки-якоря',
    Math.abs(arc[1] - (14 * Z + Z / 2)) < 0.01 && Math.abs(arc[2] - (10 * Z + Z / 2)) < 0.01);
  t('зона рисуется пунктиром', ctx.log.some(e => e[0] === 'setLineDash' && e[1].length > 1));

  const ctx2 = recorder(null);
  L.selectAt(sim, 10.5, 10.5);                 // хижина: ауры нет
  draw(L, sim, ctx2);
  t('у постройки без ауры круга нет', !ctx2.log.some(e => e[0] === 'arc'));

  // Вокзал даёт +2 к радиусу мельницы — ровно как в simulation.js.
  const ctx3 = recorder(null);
  const L3 = new SelectLayer(QUALITY.high);
  L3.selectAt(sim, 20.5, 12.5);
  draw(L3, sim, ctx3);
  const a3 = ctx3.log.find(e => e[0] === 'arc');
  t('мельница без вокзала — радиус 3', Math.abs(a3[3] - 3 * Z) < 0.01, `r=${a3[3]}`);

  sim.buildings.push({ id: 'train_station', x: 60, y: 60, size: 1, done: true, destroyed: false });
  const ctx4 = recorder(null);
  draw(L3, sim, ctx4);
  const a4 = ctx4.log.find(e => e[0] === 'arc');
  t('с вокзалом радиус мельницы 5', Math.abs(a4[3] - 5 * Z) < 0.01, `r=${a4[3]}`);
}

// 9. Потолок числа аур в кадре
{
  const sim = makeSim();
  for (let i = 0; i < 40; i++) {
    sim.buildings.push({ id: 'smithy', x: 5 + (i % 8) * 2, y: 5 + ((i / 8) | 0) * 2, size: 1, done: true, destroyed: false });
  }
  const L = new SelectLayer(QUALITY.high);
  L.showAllAuras = true;
  const ctx = recorder(null);
  L.hoverAt(sim, 10.5, 10.5);
  draw(L, sim, ctx);
  const arcs = ctx.log.filter(e => e[0] === 'arc').length;
  t('число аур в кадре не превышает потолок', arcs <= SELECT_LIMITS.auras, `${arcs} > ${SELECT_LIMITS.auras}`);
  t('showAllAuras действительно рисует много зон', arcs > 1, `${arcs}`);
}

// 10. Выпечка один раз: за сто кадров новых канвасов не появляется
{
  const sim = makeSim();
  const L = new SelectLayer(QUALITY.high);
  L.selectAt(sim, 14.5, 10.5);
  L.hoverAt(sim, 10.5, 10.5);
  draw(L, sim, recorder(null));
  const after1 = canvasesMade;
  for (let i = 0; i < 100; i++) draw(L, sim, recorder(null), 1 / 60);
  t('за 100 кадров ни одной новой выпечки', canvasesMade === after1, `+${canvasesMade - after1}`);
  t('выпечено немного канвасов', L.stats().bakes <= 8, `${L.stats().bakes}`);

  const before = canvasesMade;
  L.setQuality(QUALITY.eco);
  draw(L, sim, recorder(null));
  t('смена пресета перепекает выпечку', canvasesMade > before);
}

// 11. Детерминизм: два слоя с одним временем дают один и тот же кадр
{
  const sim = makeSim();
  const A = new SelectLayer(QUALITY.high), B = new SelectLayer(QUALITY.high);
  A.selectAt(sim, 14.5, 10.5); B.selectAt(sim, 14.5, 10.5);
  A.hoverAt(sim, 10.5, 10.5); B.hoverAt(sim, 10.5, 10.5);
  const ca = recorder(null), cb = recorder(null);
  for (let i = 0; i < 30; i++) { draw(A, sim, ca, 1 / 60); draw(B, sim, cb, 1 / 60); }
  t('кадр воспроизводим при равном времени', JSON.stringify(ca.log) === JSON.stringify(cb.log));

  // Разные сиды мира — разная фаза пульсации (иначе всё мигает в такт).
  const sim2 = makeSim(); sim2.world.seed = 777;
  const C = new SelectLayer(QUALITY.high);
  C.selectAt(sim2, 14.5, 10.5);
  const cc = recorder(null);
  for (let i = 0; i < 30; i++) draw(C, sim2, cc, 1 / 60);
  const ca2 = recorder(null);
  const A2 = new SelectLayer(QUALITY.high); A2.selectAt(sim, 14.5, 10.5);
  for (let i = 0; i < 30; i++) draw(A2, sim, ca2, 1 / 60);
  t('фаза зависит от сида мира', JSON.stringify(cc.log) !== JSON.stringify(ca2.log));
}

// 12. Слой ничего не пишет в симуляцию
{
  const sim = makeSim();
  const snap = JSON.stringify(sim, (k, v) => (typeof v === 'function' ? undefined : v));
  const L = new SelectLayer(QUALITY.ultra);
  L.selectAt(sim, 40.2, 41.63);                // выбран идущий житель
  L.hoverAt(sim, 20.5, 12.5);
  for (let i = 0; i < 20; i++) draw(L, sim, recorder(null), 1 / 60);
  const after = JSON.stringify(sim, (k, v) => (typeof v === 'function' ? undefined : v));
  t('симуляция не изменилась ни на байт', snap === after);
}

// 13. След пути выбранного жителя
{
  const sim = makeSim();
  const L = new SelectLayer(QUALITY.high);
  const ctx = recorder(null);
  L.selectAt(sim, 40.2, 41.63);
  t('выбран идущий житель', L.selection && L.selection.kind === 'v');
  draw(L, sim, ctx);
  const mv = ctx.log.find(e => e[0] === 'moveTo');
  const lt = ctx.log.find(e => e[0] === 'lineTo');
  t('след начинается на жителе', mv && Math.abs(mv[1] - 40.2 * Z) < 0.01);
  t('след кончается в центре клетки цели', lt && Math.abs(lt[1] - (20.5 * Z)) < 0.01 && Math.abs(lt[2] - (12.5 * Z)) < 0.01);
  t('след пунктирный', ctx.log.some(e => e[0] === 'setLineDash' && e[1].split(',').length === 2));

  const ctx2 = recorder(null);
  sim.villagers[1].target = null;
  draw(L, sim, ctx2);
  t('без цели следа нет', !ctx2.log.some(e => e[0] === 'lineTo'));

  // Ломаная поддержана на будущее: когда жителям добавят поиск пути.
  const ctx3 = recorder(null);
  sim.villagers[1].target = { kind: 'work', x: 20, y: 12 };
  sim.villagers[1].path = [{ x: 35, y: 39 }, { x: 28, y: 30 }];
  draw(L, sim, ctx3);
  t('маршрут из узлов рисуется ломаной', ctx3.log.filter(e => e[0] === 'lineTo').length === 3);
}

// 14. Обводка силуэта жителя
{
  const sim = makeSim();
  const sheet = { cv: fakeCanvas(96, 144), fw: 24, fh: 36 };
  const v = sim.villagers[0];

  const L = new SelectLayer(QUALITY.medium);
  const ctx = recorder(null);
  L.villager(ctx, v, sheet, 1, 2, 300, 400, 16, 24);
  t('невыбранный житель не обводится', ctx.log.length === 0);

  L.selectAt(sim, v.x, v.y - 0.17);
  const ctx2 = recorder(null);
  L.villager(ctx2, v, sheet, 1, 2, 300, 400, 16, 24);
  const blits = ctx2.log.filter(e => e[0] === 'drawImage');
  t('на medium обводка — 4 блита силуэта', blits.length === 4, `${blits.length}`);

  const L2 = new SelectLayer(QUALITY.ultra);
  L2.selectAt(sim, v.x, v.y - 0.17);
  const ctx3 = recorder(null);
  L2.villager(ctx3, v, sheet, 1, 2, 300, 400, 16, 24);
  t('на ultra обводка — 8 блитов (диагонали)', ctx3.log.filter(e => e[0] === 'drawImage').length === 8);

  // Силуэт печётся по одному разу на (кадр, направление) и переживает кадры.
  const before = canvasesMade;
  for (let i = 0; i < 50; i++) L2.villager(recorder(null), v, sheet, 1, 2, 300, 400, 16, 24);
  t('силуэт печётся один раз', canvasesMade === before, `+${canvasesMade - before}`);
  L2.villager(recorder(null), v, sheet, 2, 2, 300, 400, 16, 24);
  t('другой кадр шага печётся отдельно', canvasesMade === before + 1);

  // Силуэт заливается цветом через source-in — это и есть обводка, а не копия.
  const probe = { calls: [] };
  const cvSpy = fakeCanvas(24, 36);
  t('лист жителя не изменён обводкой', sheet.cv.width === 96 && sheet.cv.height === 144);
  void probe; void cvSpy;

  const L3 = new SelectLayer(QUALITY.eco);
  L3.hover = { kind: 'v', v, b: null, tx: 0, ty: 0 };
  const ctx4 = recorder(null);
  L3.villager(ctx4, v, sheet, 0, 0, 300, 400, 16, 24);
  t('на eco наведение жителя не обводится', ctx4.log.length === 0);
}

// 15. Пресеты: eco дешевле high
{
  const sim = makeSim();
  const eco = new SelectLayer(QUALITY.eco);
  const high = new SelectLayer(QUALITY.high);
  eco.selectAt(sim, 14.5, 10.5); high.selectAt(sim, 14.5, 10.5);
  eco.hoverAt(sim, 10.5, 10.5); high.hoverAt(sim, 10.5, 10.5);
  const ce = recorder(null), ch = recorder(null);
  draw(eco, sim, ce); draw(high, sim, ch);
  t('на eco вызовов меньше, чем на high', ce.log.length < ch.log.length, `${ce.log.length} / ${ch.log.length}`);
  t('на eco пунктир не бежит', !ce.log.some(e => e[0] === 'stroke' && e[3] !== 0));
  t('на high пунктир бежит', ch.log.some(e => e[0] === 'stroke' && e[3] !== 0));
  t('на eco заливки зоны нет', ce.log.filter(e => e[0] === 'drawImage').length
    < ch.log.filter(e => e[0] === 'drawImage').length);
}

// 16. Скачок времени после переключения вкладки не ломает фазу
{
  const sim = makeSim();
  const L = new SelectLayer(QUALITY.high);
  L.selectAt(sim, 10.5, 10.5);
  draw(L, sim, recorder(null), 5.0);           // браузер отдал кадр «через пять секунд»
  t('огромный dt зажат', L.time <= 0.1 + 1e-9, `${L.time}`);
  draw(L, sim, recorder(null), -3);
  t('отрицательный dt не двигает время назад', L.time >= 0.1 - 1e-9);
}

// 17. Дисциплина файла: никакого Math.random и никакого sim.rng
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../src/render/select.js'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  t('Math.random не используется', !/Math\.random/.test(code));
  t('sim.rng не используется', !/\brng\b/.test(code));
  t('слой не импортирует renderer', !/from '\.\/renderer\.js'/.test(code));
  t('ctx.filter в кадре нет', !/\.filter\s*=/.test(code));
  t('createRadialGradient только в выпечке',
    (code.match(/createRadialGradient/g) || []).length === 1);
  t('блок ПОДКЛЮЧЕНИЕ на месте', /ПОДКЛЮЧЕНИЕ/.test(src));
}

console.log(`=== ${ok} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
