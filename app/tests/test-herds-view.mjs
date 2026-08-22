// Тесты показа стад на карте (render/herds_view.js).
// Запуск: node app/tests/test-herds-view.mjs
//
// Рендер в node не запускается: там нет ни canvas, ни document. Поэтому здесь
// две вещи. Первая — чистая часть модуля (чтение стад, раскладка кучи, тропы):
// она считается числами и проверяется числами. Вторая — весь путь отрисовки на
// ПОДДЕЛЬНОМ канвасе: он ничего не рисует, но считает вызовы. Это ловит ровно
// то, чем опасен рендер, — падение на кривых данных и молча пропущенный потолок.
//
// Проверяем не «функция не упала», а: направления связей (испуг → куча плотнее),
// потолки (голов в кадре не больше пресета), детерминизм (два прогона одного
// сида дают ту же картинку), молчание на пустом мире и то, что модуль не
// трогает sim.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK ', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≠ ${b}`);

// ---------------------------------------------------------------------------
// Поддельный канвас. Модуль печёт спрайты через document.createElement, а в
// node его нет; подделка отдаёт контекст, который считает вызовы и молчит.
// Ставится ДО импорта модуля: он читает document только при первой выпечке,
// но полагаться на это в тесте нельзя.
// ---------------------------------------------------------------------------
const tally = { drawImage: 0, fillText: 0, strokeText: 0, gradients: 0 };
function makeCtx() {
  const noop = () => {};
  return {
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineJoin: 'round',
    font: '', textAlign: 'left', textBaseline: 'top',
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    setTransform: noop, clearRect: noop, fillRect: noop, strokeRect: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    quadraticCurveTo: noop, arc: noop, ellipse: noop, fill: noop, stroke: noop,
    drawImage: () => { tally.drawImage++; },
    fillText: () => { tally.fillText++; },
    strokeText: () => { tally.strokeText++; },
    measureText: () => ({ width: 10 }),
    createRadialGradient: () => { tally.gradients++; return { addColorStop: noop }; },
    createLinearGradient: () => { tally.gradients++; return { addColorStop: noop }; },
  };
}
function makeCanvas() {
  const c = { width: 1, height: 1 };
  c.getContext = () => makeCtx();
  return c;
}
globalThis.document = { createElement: (tag) => (tag === 'canvas' ? makeCanvas() : {}) };

const { HerdsView, readHerds, herdAtPoint, FORM, HERD_LIMITS } =
  await import('../src/render/herds_view.js');

// Поддельный AnimalSprites: модуль обязан брать зверей у people.js и не
// заводить своих. Здесь важен только контракт — sheet(kind) → {cv, fw, fh}.
function makeAnimals() {
  return { gen: 0, asked: [], sheet(kind) { this.asked.push(kind); return { cv: makeCanvas(), fw: 72, fh: 54 }; } };
}

const Q = {
  high: { id: 'high', detail: 2, lod: { beastMinZoom: 0.75 }, caps: { beasts: 60 } },
  eco: { id: 'eco', detail: 0, lod: { beastMinZoom: 1.1 }, caps: { beasts: 20 } },
};

// Поддельный sim: модуль читает ровно эти поля и ничего больше.
function makeSim(o = {}) {
  return {
    day: o.day ?? 0,
    dayTime: o.dayTime ?? 0.5,
    seasonIdx: o.seasonIdx ?? 1,
    eraIndex: o.eraIndex ?? 0,
    world: { seed: o.seed ?? 4242, w: 96, h: 96 },
    herds: o.herds === null ? undefined : { herds: o.herds ?? [herd()] },
    herdsView: o.view,
  };
}
function herd(o = {}) {
  return {
    id: o.id ?? 1, kind: o.kind ?? 'deer',
    cx: o.cx ?? 40, cy: o.cy ?? 40,
    tx: o.tx ?? 45, ty: o.ty ?? 40,
    n: o.n ?? 12, fear: o.fear ?? 0,
    doomed: o.doomed ?? false,
  };
}
const CW = 800, CH = 600, Z = 32;
// Экран, в центре которого клетка 40,40 — там же, где стоят стада по умолчанию.
const OX = CW / 2 - 40 * Z, OY = CH / 2 - 40 * Z;
function frame(view, sim, z = Z, dt = 0.016) {
  const ctx = makeCtx();
  const ox = CW / 2 - 40 * z, oy = CH / 2 - 40 * z;
  view.update(sim, dt);
  view.drawGround(sim, ctx, ox, oy, z, CW, CH);
  view.draw(sim, ctx, ox, oy, z, CW, CH);
  return { drawn: view.drawn, prints: view.prints, blobs: view.blobs };
}

console.log('--- Чтение стад: обе формы и мусор ---');
{
  t('читается состояние модели (sim.herds.herds)', () => {
    const list = readHerds(makeSim());
    ok(list.length === 1 && list[0].kind === 'deer' && list[0].x === 40, JSON.stringify(list));
  });
  t('читается производный снимок (sim.herdsView.list)', () => {
    const list = readHerds({ herdsView: { list: [{ id: '7', species: 'boar', head: 9, x: 3, y: 4, r: 5, fear: 0.3 }] } });
    ok(list.length === 1 && list[0].kind === 'boar' && list[0].r === 5, JSON.stringify(list));
  });
  t('радиус участка берётся из снимка, а не из запасной таблицы', () => {
    const sim = makeSim({ view: { list: [{ id: '1', species: 'deer', head: 12, x: 40, y: 40, r: 3.5, fear: 0 }] } });
    near(readHerds(sim)[0].r, 3.5, 1e-9, 'радиус');
  });
  t('без снимка радиус берётся из FORM', () => near(readHerds(makeSim())[0].r, FORM.deer.radius, 1e-9, 'радиус'));
  t('пустой sim не роняет и даёт пустой список', () => ok(readHerds(null).length === 0 && readHerds({}).length === 0, 'не пусто'));
  t('мусор на входе отбрасывается молча', () => {
    const list = readHerds({ herds: { herds: [
      null, 42, 'олень',
      { id: 1, kind: 'deer', cx: NaN, cy: 5, n: 5 },        // нет координат
      { id: 2, kind: 'deer', cx: 5, cy: 5, n: 0 },          // нет голов
      { id: 3, kind: 'deer', cx: 5, cy: 5, n: 'много' },    // не число
      { id: 4, kind: 'deer', cx: 5, cy: 5, n: 4 },          // единственное годное
    ] } });
    ok(list.length === 1 && list[0].id === 4, JSON.stringify(list));
  });
  t('неизвестный вид не роняет модуль, а получает запасную форму', () => {
    const list = readHerds({ herds: { herds: [{ id: 1, kind: 'дракон', cx: 5, cy: 5, n: 4 }] } });
    ok(list.length === 1 && list[0].form === FORM.deer, JSON.stringify(list));
  });
  t('обречённость: слово модели весомее нашей таблицы', () => {
    const a = readHerds({ herds: { herds: [{ id: 1, kind: 'deer', cx: 5, cy: 5, n: 99, doomed: true }] } })[0];
    const b = readHerds({ herds: { herds: [{ id: 2, kind: 'deer', cx: 5, cy: 5, n: 2 }] } })[0];
    ok(a.doomed === true, 'флаг модели проигнорирован');
    ok(b.doomed === true, 'ниже порога живучести, а не обречено');
  });
  t('пугливость зажата в 0..1', () => {
    const l = readHerds({ herds: { herds: [{ id: 1, kind: 'deer', cx: 5, cy: 5, n: 4, fear: 17 }] } });
    near(l[0].fear, 1, 1e-9, 'испуг');
  });
}

console.log('\n--- Раскладка кучи ---');
{
  const v = new HerdsView(Q.high, makeAnimals());
  v.seed = 4242;
  t('вожак впереди по ходу стада', () => {
    const lay = v.layoutFor(herd({ n: 12 }), 12);
    const front = lay[0];
    ok(front.lx > 0, `вожак не впереди: lx=${front.lx}`);
    ok(lay.every(p => p.lx <= front.lx + 1e-9), 'кто-то обогнал вожака');
  });
  t('вожак крупнее рядового', () => {
    const lay = v.layoutFor(herd({ n: 12 }), 12);
    ok(lay[0].sc > 1.1, `вожак мелкий: ${lay[0].sc}`);
  });
  t('молодняк в середине и мельче взрослых', () => {
    const lay = v.layoutFor(herd({ n: 20 }), 20);
    const young = lay.filter(p => p.sc < 0.7);
    ok(young.length >= 3, `молодняка нет: ${young.length}`);
    const rYoung = Math.max(...young.map(p => Math.hypot(p.lx, p.ly)));
    const adults = lay.filter(p => p.sc >= 0.9 && p.lx < 1e9);
    const rAdult = Math.max(...adults.map(p => Math.hypot(p.lx, p.ly)));
    ok(rYoung < rAdult, `молодняк снаружи: ${rYoung} ≥ ${rAdult}`);
  });
  t('не сетка: расстояния между соседями разные', () => {
    const lay = v.layoutFor(herd({ n: 18 }), 18);
    const ds = new Set(lay.map(p => Math.round(Math.hypot(p.lx, p.ly) * 100)));
    ok(ds.size >= lay.length - 2, `слишком ровно: ${ds.size} из ${lay.length}`);
  });
  t('испуг сбивает стадо плотнее', () => {
    const calm = v.layoutFor(herd({ n: 16, fear: 0 }), 16);
    const scared = v.layoutFor(herd({ n: 16, fear: 1 }), 16);
    const rad = (l) => Math.max(...l.map(p => Math.hypot(p.lx, p.ly)));
    ok(rad(scared) < rad(calm) * 0.75, `не сбились: ${rad(scared)} против ${rad(calm)}`);
  });
  t('угасающее стадо стоит реже и без вожака', () => {
    const live = v.layoutFor(herd({ id: 5, n: 10 }), 10);
    const doom = v.layoutFor(herd({ id: 5, n: 10, doomed: true }), 10);
    const rad = (l) => Math.max(...l.map(p => Math.hypot(p.lx, p.ly)));
    ok(rad(doom) > rad(live), `не растянулось: ${rad(doom)} ≤ ${rad(live)}`);
    ok(doom.every(p => p.sc < 1.1), 'у обречённого стада остался вожак');
  });
  t('плотность держится: радиус растёт как корень из поголовья', () => {
    const rad = (n) => Math.max(...v.layoutFor(herd({ id: 9, n }), n).map(p => Math.hypot(p.lx, p.ly)));
    // Вчетверо больше голов — вдвое шире куча, а не вчетверо.
    const k = rad(64) / rad(16);
    ok(k > 1.6 && k < 2.6, `плотность поплыла: ${k}`);
  });
  t('у каждой головы своя фаза и своя скорость шага', () => {
    const lay = v.layoutFor(herd({ n: 16 }), 16);
    ok(new Set(lay.map(p => Math.round(p.phase * 1000))).size > 10, 'шагают в ногу');
    ok(new Set(lay.map(p => Math.round(p.rate * 1000))).size > 10, 'скорость ног одна на всех');
  });
  t('раскладка детерминирована: тот же сид — та же куча', () => {
    const a = new HerdsView(Q.high, makeAnimals()); a.seed = 4242;
    const b = new HerdsView(Q.high, makeAnimals()); b.seed = 4242;
    ok(JSON.stringify(a.layoutFor(herd({ n: 14 }), 14)) === JSON.stringify(b.layoutFor(herd({ n: 14 }), 14)), 'разошлись');
  });
  t('другой сид — другая куча', () => {
    const a = new HerdsView(Q.high, makeAnimals()); a.seed = 1;
    const b = new HerdsView(Q.high, makeAnimals()); b.seed = 2;
    ok(JSON.stringify(a.layoutFor(herd({ n: 14 }), 14)) !== JSON.stringify(b.layoutFor(herd({ n: 14 }), 14)), 'сид не влияет');
  });
  t('кэш раскладок не растёт бесконечно', () => {
    const w = new HerdsView(Q.high, makeAnimals()); w.seed = 7;
    for (let i = 0; i < HERD_LIMITS.layouts * 3; i++) w.layoutFor(herd({ id: i, n: 3 + (i % 20) }), 3 + (i % 20));
    ok(w.layouts.size <= HERD_LIMITS.layouts, `раскладок ${w.layouts.size}`);
  });
}

console.log('\n--- Тропы: один день считается один раз ---');
{
  t('точка тропы кладётся раз в сутки, а не раз в кадр', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    const sim = makeSim({ day: 1 });
    for (let i = 0; i < 40; i++) v.update(sim, 0.016);   // сорок кадров одних суток
    ok(v.trails.get(1).pts.length === 1, `точек ${v.trails.get(1).pts.length}`);
  });
  t('стадо идёт — тропа удлиняется', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    for (let d = 0; d < 6; d++) v.update(makeSim({ day: d, herds: [herd({ cx: 40 + d, cy: 40 })] }), 0.016);
    ok(v.trails.get(1).pts.length === 6, `точек ${v.trails.get(1).pts.length}`);
  });
  t('стадо топчется на месте — новых точек нет', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    for (let d = 0; d < 8; d++) v.update(makeSim({ day: d, herds: [herd({ cx: 40.01 * (1 + d * 0.001) })] }), 0.016);
    ok(v.trails.get(1).pts.length === 1, `точек ${v.trails.get(1).pts.length}`);
  });
  t('тропа не длиннее потолка', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    for (let d = 0; d < 200; d++) v.update(makeSim({ day: d, herds: [herd({ cx: 20 + d * 0.4, cy: 40 })] }), 0.016);
    const n = v.trails.get(1).pts.length;
    ok(n > 1 && n <= 16, `точек ${n}`);
  });
  t('тропа выцветает и исчезает после ухода стада', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    for (let d = 0; d < 4; d++) v.update(makeSim({ day: d, herds: [herd({ cx: 40 + d })] }), 0.016);
    ok(v.trails.size === 1, 'тропы нет');
    for (let d = 4; d < 40; d++) v.update(makeSim({ day: d, herds: [] }), 0.016);
    ok(v.trails.size === 0, `тропа пережила стадо: ${v.trails.size}`);
  });
  t('за тропами следят не более чем у TRAIL_HERDS стад', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    const many = Array.from({ length: 300 }, (_, i) => herd({ id: i + 1, cx: 10 + (i % 80), cy: 10 + ((i / 80) | 0) }));
    v.update(makeSim({ day: 1, herds: many }), 0.016);
    ok(v.trails.size <= 48, `троп ${v.trails.size}`);
  });
  t('смена сида (новый мир) стирает тропы прошлой партии', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    for (let d = 0; d < 5; d++) v.update(makeSim({ day: d, herds: [herd({ cx: 40 + d })] }), 0.016);
    v.update(makeSim({ day: 5, seed: 777 }), 0.016);
    ok(v.trails.get(1).pts.length === 1, 'тропа осталась от прошлого мира');
  });
  t('день назад (загрузка сейва) тоже стирает тропы', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    for (let d = 0; d < 9; d++) v.update(makeSim({ day: d, herds: [herd({ cx: 40 + d })] }), 0.016);
    v.update(makeSim({ day: 2, herds: [herd({ cx: 40 })] }), 0.016);
    ok(v.trails.get(1).pts.length === 1, 'тропа пережила загрузку');
  });
}

console.log('\n--- Кадр: потолки, зум, молчание ---');
{
  t('пустой мир — ни одного блита', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    const before = tally.drawImage;
    frame(v, makeSim({ herds: [] }));
    ok(tally.drawImage === before, `нарисовано ${tally.drawImage - before}`);
    ok(v.drawn === 0 && v.blobs === 0 && v.prints === 0, 'счётчики не нулевые');
  });
  t('sim без мира не роняет модуль', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    const ctx = makeCtx();
    v.update({}, 0.016); v.drawGround({}, ctx, 0, 0, Z, CW, CH); v.draw({}, ctx, 0, 0, Z, CW, CH);
    ok(v.drawn === 0, 'что-то нарисовано на пустоте');
  });
  t('крупный зум: рисуются отдельные звери', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    frame(v, makeSim(), 48);          // атлас печётся на первом кадре
    const r = frame(v, makeSim(), 48);
    ok(r.drawn >= 10, `голов ${r.drawn}`);
    ok(r.blobs === 0, `лишние пятна: ${r.blobs}`);
  });
  t('мелкий зум: вместо тел — пятно с числом голов', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    const before = tally.fillText;
    const r = frame(v, makeSim(), 8);   // зум 0,25 — ниже beastMinZoom
    ok(r.drawn === 0, `нарисованы тела: ${r.drawn}`);
    ok(r.blobs === 1, `пятен ${r.blobs}`);
    ok(tally.fillText > before, 'число голов не подписано');
  });
  t('потолок голов в кадре — из пресета, а не из поголовья', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    const many = Array.from({ length: 40 }, (_, i) => herd({ id: i + 1, n: 80, cx: 38 + (i % 6), cy: 38 + ((i / 6) | 0) }));
    const sim = makeSim({ herds: many });
    for (let i = 0; i < 4; i++) frame(v, sim, 48);   // дать испечь атласы
    const r = frame(v, sim, 48);
    ok(r.drawn <= Q.high.caps.beasts, `голов ${r.drawn} при потолке ${Q.high.caps.beasts}`);
    ok(r.drawn > 0, 'не нарисовано ничего');
  });
  t('от одного стада не больше HERD_LIMITS.headsPerHerd тел', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    const sim = makeSim({ herds: [herd({ n: 500 })] });
    frame(v, sim, 48);
    const r = frame(v, sim, 48);
    ok(r.drawn <= HERD_LIMITS.headsPerHerd, `голов ${r.drawn}`);
  });
  t('на eco следов нет вовсе', () => {
    const v = new HerdsView(Q.eco, makeAnimals());
    for (let d = 0; d < 10; d++) frame(v, makeSim({ day: d, herds: [herd({ cx: 36 + d * 0.5 })] }), 32);
    ok(v.prints === 0, `отпечатков ${v.prints}`);
  });
  t('на high следы рисуются и не переходят потолок', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    const many = Array.from({ length: 40 }, (_, i) => herd({ id: i + 1, n: 10, cx: 36 + (i % 8) * 0.4, cy: 36 + ((i / 8) | 0) * 0.4 }));
    let last = 0;
    for (let d = 0; d < 30; d++) {
      const sim = makeSim({ day: d, herds: many.map(h => ({ ...h, cx: h.cx + d * 0.5 })) });
      last = frame(v, sim, 32).prints;
    }
    ok(last > 0, 'следов нет');
    ok(last <= HERD_LIMITS.trails.high, `отпечатков ${last}`);
  });
  t('атласов печётся не больше одного за кадр', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    const sim = makeSim({ herds: [herd({ id: 1, kind: 'deer' }), herd({ id: 2, kind: 'boar', cx: 41 }),
      herd({ id: 3, kind: 'aurochs', cx: 42 }), herd({ id: 4, kind: 'mammoth', cx: 43 })] });
    frame(v, sim, 48);
    ok(v.atlas.size === 1, `испечено ${v.atlas.size} атласов за кадр`);
    frame(v, sim, 48);
    ok(v.atlas.size === 2, `за два кадра ${v.atlas.size}`);
  });
  t('звери берутся у AnimalSprites, свои не рисуются', () => {
    const an = makeAnimals();
    const v = new HerdsView(Q.high, an);
    const sim = makeSim({ herds: [herd({ kind: 'boar' })] });
    frame(v, sim, 48);
    ok(an.asked.length > 0, 'лист зверей не запрошен — модуль рисует своих');
    ok(an.asked.every(k => k === 'deer' || k === 'mammoth'), `запрошены чужие формы: ${an.asked}`);
  });
  t('перепечатка листов зверья (смена пресета) сбрасывает атлас', () => {
    const an = makeAnimals();
    const v = new HerdsView(Q.high, an);
    const sim = makeSim();
    frame(v, sim, 48);
    ok(v.atlas.size === 1, 'атлас не испечён');
    an.gen++;                       // AnimalSprites.setQuality делает ровно это
    frame(v, sim, 48);
    ok(v.atlas.size === 1, 'старый атлас остался в кэше');
  });
  t('без AnimalSprites модуль не падает, а показывает пятна', () => {
    const v = new HerdsView(Q.high, null);
    const r = frame(v, makeSim(), 48);
    ok(r.drawn === 0 && r.blobs === 1, `тела ${r.drawn}, пятна ${r.blobs}`);
  });
  t('стадо за краем экрана не стоит ничего', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    frame(v, makeSim(), 48);
    const before = tally.drawImage;
    frame(v, makeSim({ herds: [herd({ cx: 900, cy: 900, tx: 900, ty: 900 })] }), 48);
    ok(tally.drawImage - before <= 1, `нарисовано ${tally.drawImage - before}`);
  });
}

console.log('\n--- Модуль ничего не мутирует ---');
{
  t('sim до и после кадра совпадает слепок в слепок', () => {
    const sim = makeSim({ day: 3, herds: [herd({ n: 14, fear: 0.4 }), herd({ id: 2, kind: 'boar', cx: 44, n: 6 })] });
    const before = JSON.stringify(sim);
    const v = new HerdsView(Q.high, makeAnimals());
    for (let d = 0; d < 5; d++) { sim.day = 3 + d; frame(v, sim, 40); }
    sim.day = 3;
    ok(JSON.stringify(sim) === before, 'sim изменился');
  });
  t('стада из sim не мутируются (readHerds отдаёт свои записи)', () => {
    const h = herd();
    const list = readHerds({ herds: { herds: [h] } });
    list[0].x = -1; list[0].n = -1;
    ok(h.cx === 40 && h.n === 12, 'стадо в sim переписано');
  });
}

console.log('\n--- Подсказка под курсором ---');
{
  t('курсор в центре кучи находит стадо', () => {
    const h = herdAtPoint(makeSim(), 40, 40);
    ok(h && h.id === 1, JSON.stringify(h));
  });
  t('курсор в стороне не находит ничего', () => ok(herdAtPoint(makeSim(), 60, 60) === null, 'нашлось лишнее'));
}

console.log('\n--- Живая партия ---');
{
  // Прогон на настоящей Simulation, а не только на подделке: стада там
  // рождаются, ходят и получают испуг от охоты, и форма их состояния —
  // единственная настоящая.
  const { Simulation } = await import('../src/core/simulation.js');
  const sim = new Simulation(11, { startEra: 0 });
  for (let d = 0; d < 120; d++) sim.tick(1);
  t('в живой партии стада есть и модуль их видит', () => {
    const list = readHerds(sim);
    ok(list.length > 0, 'стад не нашлось — проверь форму состояния в herds.js');
    ok(list.every(h => Number.isFinite(h.x) && Number.isFinite(h.n) && h.n > 0), JSON.stringify(list[0]));
  });
  // Камера ставится на первое стадо: рисовать пустой угол карты и удивляться
  // пустому кадру — не проверка.
  const first = readHerds(sim)[0];
  const liveFrame = (v, z) => {
    const ctx = makeCtx();
    const ox = CW / 2 - first.x * z, oy = CH / 2 - first.y * z;
    v.update(sim, 0.016);
    v.drawGround(sim, ctx, ox, oy, z, CW, CH);
    v.draw(sim, ctx, ox, oy, z, CW, CH);
  };
  t('кадр на живой партии рисуется и sim не меняется', () => {
    const v = new HerdsView(Q.high, makeAnimals());
    const before = JSON.stringify(sim.herds);
    for (let i = 0; i < 6; i++) liveFrame(v, 40);
    ok(JSON.stringify(sim.herds) === before, 'модуль переписал состояние стад');
    ok(v.drawn > 0, 'на живой карте не нарисовано ни одной головы');
  });
  t('потолок держится и на живой партии', () => {
    const v = new HerdsView(Q.eco, makeAnimals());
    for (let i = 0; i < 8; i++) liveFrame(v, 48);
    ok(v.drawn <= Q.eco.caps.beasts, `голов ${v.drawn} при потолке ${Q.eco.caps.beasts}`);
    ok(v.drawn > 0, 'на eco не нарисовано ничего');
  });
}

console.log('\n--- Гигиена рендера ---');
{
  const src = readFileSync(new URL('../src/render/herds_view.js', import.meta.url), 'utf8');
  // Блок ПОДКЛЮЧЕНИЕ — это комментарий, и в нём НАМЕРЕННО процитированы чужие
  // строки: и «import { CityLights }», и «sim.rng». Проверять гигиену надо по
  // коду, а не по инструкции для главного разработчика, иначе тест ловит
  // собственную документацию.
  const code = src.split('/* ПОДКЛЮЧЕНИЕ')[0].replace(/\/\/[^\n]*/g, '');
  t('Math.random в модуле не вызывается', () => ok(!/Math\.random\s*\(/.test(src), 'найден вызов Math.random'));
  t('sim.rng в рендере не трогается', () => ok(!/\brng\b/.test(code), 'найдено обращение к rng'));
  t('ядро не импортируется мимо data.js и palette.js', () => {
    const imports = [...code.matchAll(/^import .*from '([^']+)';/gm)].map(m => m[1]);
    ok(imports.length >= 2, `импортов не нашлось: ${imports}`);
    ok(imports.every(p => p === '../core/data.js' || p === './palette.js'), `лишние импорты: ${imports}`);
  });
  t('блок ПОДКЛЮЧЕНИЕ на месте', () => ok(/ПОДКЛЮЧЕНИЕ/.test(src), 'блока нет'));
  t('якоря подключения совпадают с настоящим renderer.js', () => {
    const rnd = readFileSync(new URL('../src/render/renderer.js', import.meta.url), 'utf8').split('\n');
    const anchors = [
      "import { CityLights } from './city_lights.js';",
      '    this.beasts = new AnimalSprites(this.quality);',
      '    this.beasts.setQuality(this.quality);',
      '      this.beasts.setQuality(this.quality);',
      '    this.tuneAuto(dtReal);',
      '    this.terrain.landmarks.drawLive(sim, ctx, ox, oy, z, cw, ch, this.time);',
      '    this.drawSortedEntities(sim, ctx, ox, oy, z, cw, ch, L);',
    ];
    for (const a of anchors) {
      const n = rnd.filter(l => l === a).length;
      ok(n === 1, `якорь «${a.trim()}» встречается ${n} раз, а не один`);
      ok(src.includes(a), `якорь «${a.trim()}» не описан в блоке ПОДКЛЮЧЕНИЕ`);
    }
  });
}

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
if (fail) process.exit(1);
