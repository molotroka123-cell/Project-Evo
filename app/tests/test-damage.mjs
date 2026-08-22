// Тесты слоя следов разрушений (app/src/render/damage.js).
// Запуск: node app/tests/test-damage.mjs
//
// Канваса в node нет, поэтому здесь подставной document — как в
// test-city-lights.mjs и test-minimap.mjs. Проверяются не пиксели, а
// поведение: КОГДА слой работает, СКОЛЬКО объектов кладёт в кадр, ДЕТЕРМИНИРОВАН
// ли рисунок трещин, уважает ли потолки пресета и бюджет выпечки. Картинку
// проверит глаз.
import { BUILDINGS } from '../src/core/data.js';

const noop = () => {};
// Общий счётчик работы по ВСЕМ подставным контекстам. Нужен потому, что
// выпечка наложения идёт в промежуточные канвасы (декали, трафарет окон), и
// счётчик итогового канваса о них ничего не знает.
const OPS = { n: 0 };
function fakeCtx(cv) {
  return {
    canvas: cv,
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: '', lineCap: '',
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none',
    calls: { fillRect: 0, drawImage: 0, stroke: 0, fill: 0, grad: 0 },
    images: [],
    save: noop, restore: noop, setTransform: noop, translate: noop, scale: noop,
    rotate: noop, clip: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    closePath: noop, arc: noop, ellipse: noop, rect: noop, setLineDash: noop,
    fill() { this.calls.fill++; OPS.n++; },
    stroke() { this.calls.stroke++; OPS.n++; },
    fillRect() { this.calls.fillRect++; OPS.n++; },
    clearRect: noop,
    drawImage(img) { this.calls.drawImage++; OPS.n++; this.images.push(img); },
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
  DamageLayer, DAMAGE_LIMITS, STAGE_HP,
  dhash, rngFrom, hpMaxOf, hpFrac, damageStage, isBurning, eraOf, variantOf,
  crackPath, bakeOverlay, bakeRubble,
} = await import('../src/render/damage.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// --------------------------------------------------------------- заготовки
const TILE_PX = 32;
const bld = (id, x, y, o = {}) => ({
  id, x, y, size: (BUILDINGS[id] && BUILDINGS[id].size) || 1,
  done: true, destroyed: false, hp: o.hp === undefined ? (BUILDINGS[id].wall || 100) : o.hp,
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

// Один полный кадр слоя: begin -> руины -> здания -> дым.
function frame(dl, sim, o = {}) {
  const z = TILE_PX * (o.zoom === undefined ? 1 : o.zoom);
  const cw = o.cw || 1280, ch = o.ch || 720;
  const ox = cw / 2 - 48 * z, oy = ch / 2 - 48 * z;
  const ctx = o.ctx || frameCtx();
  dl.begin(sim, o.dt === undefined ? 1 / 60 : o.dt, z, { wind: o.wind || 0 });
  dl.drawRubble(sim, ctx, ox, oy, z, cw, ch);
  for (const b of sim.buildings) {
    if (b.destroyed) continue;
    const sx = ox + b.x * z, sy = oy + b.y * z, size = (b.size || 1) * z;
    const spr = o.spr || fakeSprite();
    const dw = size * 1.16, dh = dw * spr.hFact;
    dl.building(ctx, b, spr, sx - size * 0.08, sy + size - dh, dw, dh);
  }
  dl.drawSmoke(ctx);
  return ctx;
}

// ------------------------------------------------------- хеш и генератор
t('dhash детерминирован и лежит в [0,1)', () => {
  for (let i = 0; i < 200; i++) {
    const v = dhash(i * 3, i * 7 + 1, 4242);
    ok(v >= 0 && v < 1, `вне диапазона: ${v}`);
    ok(v === dhash(i * 3, i * 7 + 1, 4242), 'не воспроизводится');
  }
});

t('dhash разводит соседние клетки', () => {
  let diff = 0;
  for (let x = 0; x < 20; x++) for (let y = 0; y < 20; y++) {
    if (Math.abs(dhash(x, y, 1) - dhash(x + 1, y, 1)) > 0.05) diff++;
  }
  ok(diff > 300, `соседи слишком похожи: ${diff}/400`);
});

t('dhash зависит от зерна мира', () => {
  let diff = 0;
  for (let i = 0; i < 100; i++) if (dhash(i, i, 1) !== dhash(i, i, 777)) diff++;
  ok(diff > 95, `зерно почти не влияет: ${diff}/100`);
});

t('dhash распределён примерно равномерно', () => {
  const bins = new Array(10).fill(0);
  for (let i = 0; i < 4000; i++) bins[Math.floor(dhash(i, i * 31, 4242) * 10)]++;
  for (const b of bins) ok(b > 250 && b < 550, `перекос корзин: ${bins.join(',')}`);
});

t('rngFrom воспроизводим и не вырождается', () => {
  const a = rngFrom(12345), b = rngFrom(12345);
  const seq = [];
  for (let i = 0; i < 50; i++) { const v = a(); seq.push(v); ok(v === b(), 'потоки разошлись'); }
  ok(new Set(seq).size > 45, 'поток повторяется');
});

// ------------------------------------------------------ чтение состояния
t('hpMaxOf берёт def.wall, иначе 100', () => {
  ok(hpMaxOf(bld('palisade', 1, 1)) === 200, 'частокол');
  ok(hpMaxOf(bld('stone_walls', 1, 1)) === 500, 'стены');
  ok(hpMaxOf(bld('hut', 1, 1)) === 100, 'хижина');
  ok(hpMaxOf({ id: 'hut', hpMax: 640 }) === 640, 'hpMax перекрывает');
});

t('hpFrac зажат в [0,1] и целый по умолчанию', () => {
  ok(hpFrac(bld('hut', 1, 1)) === 1, 'целая');
  near(hpFrac(bld('hut', 1, 1, { hp: 50 })), 0.5, 1e-9, 'половина');
  ok(hpFrac(bld('hut', 1, 1, { hp: -20 })) === 0, 'отрицательный hp');
  ok(hpFrac(bld('hut', 1, 1, { hp: 900 })) === 1, 'сверх максимума');
  ok(hpFrac({ id: 'hut' }) === 1, 'без поля hp — считаем целой');
  // Постройка с большим максимумом не должна выглядеть целее: 100 из 500 — это руина.
  near(hpFrac(bld('stone_walls', 1, 1, { hp: 100 })), 0.2, 1e-9, 'стены на 20%');
});

t('damageStage: четыре ступени и ни одной лишней', () => {
  ok(damageStage(bld('hut', 1, 1, { hp: 100 })) === 0, 'целая — ступень 0');
  ok(damageStage(bld('hut', 1, 1, { hp: 87 })) === 0, 'царапина не считается');
  ok(damageStage(bld('hut', 1, 1, { hp: 80 })) === 1, 'ступень 1');
  ok(damageStage(bld('hut', 1, 1, { hp: 50 })) === 2, 'ступень 2');
  ok(damageStage(bld('hut', 1, 1, { hp: 30 })) === 3, 'ступень 3');
  ok(damageStage(bld('hut', 1, 1, { hp: 5 })) === 4, 'ступень 4');
  ok(damageStage(bld('hut', 1, 1, { hp: 0 })) === 4, 'ноль hp');
});

t('damageStage монотонна по hp', () => {
  let prev = 0;
  for (let hp = 100; hp >= 0; hp--) {
    const s = damageStage(bld('hut', 1, 1, { hp }));
    ok(s >= prev, `ступень уменьшилась на hp=${hp}`);
    prev = s;
  }
  ok(prev === STAGE_HP.length, 'до последней ступени не дошли');
});

t('стройка и руина наложений не получают', () => {
  ok(damageStage(bld('hut', 1, 1, { hp: 10, done: false })) === 0, 'недостроенная');
  ok(damageStage(bld('hut', 1, 1, { hp: 10, destroyed: true })) === 0, 'разрушенная');
});

t('isBurning: ступень 4 или флаг ядра', () => {
  ok(!isBurning(bld('hut', 1, 1), 2), 'побитая не горит');
  ok(isBurning(bld('hut', 1, 1), 4), 'ступень 4 горит');
  ok(isBurning(bld('hut', 1, 1, { burning: true }), 0), 'флаг ядра сильнее ступени');
});

t('eraOf повторяет формулу renderer: не больше трёх ступеней вверх', () => {
  const hut = bld('hut', 1, 1);
  ok(eraOf(hut, { eraIndex: 0 }) === 0, 'своя эпоха');
  ok(eraOf(hut, { eraIndex: 9 }) === 3, 'подтяжка ограничена тремя ступенями');
  ok(eraOf(bld('skyscraper', 1, 1), { eraIndex: 0 }) >= 8, 'ниже своей не опускается');
});

t('variantOf зависит от координат и зерна, но не мигает', () => {
  const b = bld('hut', 12, 34);
  const v = variantOf(b, 4242);
  ok(v >= 0 && v < 4 && Number.isInteger(v), `вариант вне диапазона: ${v}`);
  ok(variantOf(b, 4242) === v, 'вариант непостоянен');
  const seen = new Set();
  for (let x = 0; x < 12; x++) for (let y = 0; y < 12; y++) seen.add(variantOf(bld('hut', x, y), 4242));
  ok(seen.size === 4, `используются не все варианты: ${seen.size}`);
  let differs = 0;
  for (let x = 0; x < 40; x++) if (variantOf(bld('hut', x, 5), 1) !== variantOf(bld('hut', x, 5), 999)) differs++;
  ok(differs > 20, `зерно мира почти не меняет рисунок: ${differs}/40`);
});

t('трещина детерминирована формой, а не только числом точек', () => {
  const a = crackPath(10, 10, 40, 12, rngFrom(7));
  const b = crackPath(10, 10, 40, 12, rngFrom(7));
  ok(JSON.stringify(a) === JSON.stringify(b), 'один сид — разные трещины');
  const c = crackPath(10, 10, 40, 12, rngFrom(8));
  ok(JSON.stringify(a) !== JSON.stringify(c), 'разные сиды — одна трещина');
  // Трещина идёт сверху вниз: каждая следующая точка ниже предыдущей.
  for (let i = 1; i < a.length; i++) ok(a[i][1] > a[i - 1][1], 'трещина пошла вверх');
});

// -------------------------------------------------------------- выпечка
t('bakeOverlay отдаёт канвас размером со спрайт', () => {
  const spr = fakeSprite(96, 120);
  const cv = bakeOverlay(spr, 2, 0, 2);
  ok(cv.width === 96 && cv.height === 120, `размер ${cv.width}x${cv.height}`);
});

// Сколько всего примитивов стоила выпечка (по всем промежуточным канвасам).
function bakeCost(fn) { const a = OPS.n; fn(); return OPS.n - a; }

t('чем выше ступень, тем больше работы в выпечке', () => {
  const counts = [];
  for (let s = 1; s <= 4; s++) counts.push(bakeCost(() => bakeOverlay(fakeSprite(), s, 0, 2)));
  ok(counts[3] > counts[0], `ступень 4 не тяжелее первой: ${counts.join(',')}`);
  for (let i = 1; i < counts.length; i++) ok(counts[i] >= counts[i - 1], `ступени не по возрастанию: ${counts.join(',')}`);
});

t('eco (detail 0) печёт заметно меньше', () => {
  const hi = bakeCost(() => bakeOverlay(fakeSprite(), 3, 0, 2));
  const lo = bakeCost(() => bakeOverlay(fakeSprite(), 3, 0, 0));
  ok(lo < hi * 0.75, `eco печёт почти столько же: ${lo} vs ${hi}`);
});

t('bakeRubble масштабируется размером постройки и detail', () => {
  const a = bakeRubble(4, 1, 0, 2), b = bakeRubble(4, 2, 0, 2), e = bakeRubble(4, 1, 0, 0);
  ok(b.width === a.width * 2, `size 2 не вдвое шире: ${a.width} / ${b.width}`);
  ok(e.width < a.width, 'eco печёт в том же разрешении');
  ok(a.height < a.width, 'груда обломков выше своей ширины — это уже здание');
});

t('bakeRubble детерминирован по (эпоха, размер, вариант)', () => {
  const c1 = bakeRubble(6, 1, 2, 2).getContext().calls;
  const c2 = bakeRubble(6, 1, 2, 2).getContext().calls;
  ok(JSON.stringify(c1) === JSON.stringify(c2), 'две выпечки дали разную работу');
  const c3 = bakeRubble(6, 1, 3, 2).getContext().calls;
  ok(c3.fill > 0, 'вариант 3 пустой');
});

// ----------------------------------------------------------- слой в кадре
t('целый город не стоит ни одного блита', () => {
  const dl = new DamageLayer(QUALITY.high);
  const sim = simOf([bld('hut', 46, 46), bld('farm', 47, 46), bld('smithy', 48, 46)]);
  const ctx = frame(dl, sim);
  ok(ctx.calls.drawImage === 0, `лишние блиты: ${ctx.calls.drawImage}`);
  ok(dl.stats().overlays === 0 && dl.stats().rubble === 0, 'слой что-то нарисовал на целом городе');
});

t('побитая постройка получает ровно один блит', () => {
  const dl = new DamageLayer(QUALITY.high);
  const sim = simOf([bld('hut', 46, 46, { hp: 40 })]);
  const ctx = frame(dl, sim);
  ok(ctx.calls.drawImage === 1, `блитов ${ctx.calls.drawImage}, ожидался 1`);
  ok(dl.stats().overlays === 1, 'наложение не засчитано');
});

t('наложение печётся один раз, дальше только блит', () => {
  const dl = new DamageLayer(QUALITY.high);
  const sim = simOf([bld('hut', 46, 46, { hp: 40 })]);
  const spr = fakeSprite();
  frame(dl, sim, { spr });
  ok(dl.stats().bakes === 1, 'первый кадр не испёк');
  for (let i = 0; i < 20; i++) frame(dl, sim, { spr });
  ok(dl.stats().bakes === 0, 'печёт каждый кадр');
  ok(dl.overlays.size === 1, `в кэше ${dl.overlays.size} записей`);
});

t('смена ступени — новая запись кэша, обратный ход — попадание', () => {
  const dl = new DamageLayer(QUALITY.high);
  const b = bld('hut', 46, 46, { hp: 40 });
  const sim = simOf([b]);
  const spr = fakeSprite();
  frame(dl, sim, { spr });
  b.hp = 10; frame(dl, sim, { spr });
  ok(dl.overlays.size === 2, `ожидались две записи, есть ${dl.overlays.size}`);
  b.hp = 40; frame(dl, sim, { spr });
  ok(dl.stats().bakes === 0, 'возврат к прежней ступени снова печёт');
});

t('бюджет выпечки на кадр не превышается', () => {
  const dl = new DamageLayer(QUALITY.high);      // caps.bakesPerFrame = 1
  const bs = [];
  for (let i = 0; i < 12; i++) bs.push(bld('hut', 44 + i, 46, { hp: 40 }));
  const sim = simOf(bs);
  frame(dl, sim);   // у каждого свой спрайт -> свой ключ
  ok(dl.stats().bakes <= QUALITY.high.caps.bakesPerFrame, `испечено ${dl.stats().bakes}`);
  ok(dl.stats().overlays <= 1, 'нарисовано больше, чем испечено');
});

t('разрушенная постройка остаётся на карте грудой обломков', () => {
  const dl = new DamageLayer(QUALITY.high);
  const sim = simOf([bld('smithy', 46, 46, { destroyed: true })]);
  frame(dl, sim);
  ok(dl.stats().rubble === 1, 'руина не нарисована — игрок увидит пустую траву');
});

t('потолок руин в кадре — от пресета', () => {
  for (const id of ['eco', 'medium', 'high', 'ultra']) {
    const q = QUALITY[id];
    const dl = new DamageLayer(q);
    const bs = [];
    for (let i = 0; i < 200; i++) bs.push(bld('hut', 40 + (i % 14), 40 + ((i / 14) | 0), { destroyed: true }));
    const sim = simOf(bs);
    // Разогреваем кэш выпечки: иначе упрёмся в bakesPerFrame, а не в потолок.
    for (let i = 0; i < 60; i++) frame(dl, sim, { zoom: 0.6 });
    const cap = Math.min(DAMAGE_LIMITS.rubbleFrame, Math.round(q.caps.buildings * 0.25));
    ok(dl.stats().rubble <= cap, `${id}: руин ${dl.stats().rubble} при потолке ${cap}`);
    ok(dl.stats().rubble === cap, `${id}: потолок недобран (${dl.stats().rubble}/${cap})`);
  }
});

t('дым горящего имеет потолок и растёт с пресетом', () => {
  const got = {};
  for (const id of ['eco', 'medium', 'high', 'ultra']) {
    const q = QUALITY[id];
    const dl = new DamageLayer(q);
    const bs = [];
    for (let i = 0; i < 40; i++) bs.push(bld('hut', 40 + (i % 8), 42 + ((i / 8) | 0), { hp: 4 }));
    const sim = simOf(bs);
    let max = 0;
    // Частицы аналитические: за секунду проходит вся фаза, ловим максимум.
    for (let i = 0; i < 90; i++) { frame(dl, sim, { zoom: 1.4, dt: 1 / 30 }); max = Math.max(max, dl.stats().puffs); }
    got[id] = max;
    ok(max <= dl.capSmoke, `${id}: частиц ${max} при потолке ${dl.capSmoke}`);
    ok(max > 0, `${id}: пожар не дымит вовсе`);
  }
  ok(got.ultra > got.eco, `ultra не богаче eco: ${JSON.stringify(got)}`);
});

t('дым исчезает на дальнем зуме, руины остаются', () => {
  const dl = new DamageLayer(QUALITY.high);
  const sim = simOf([bld('hut', 46, 46, { hp: 4 }), bld('farm', 47, 46, { destroyed: true })]);
  frame(dl, sim, { zoom: 0.2 });
  ok(dl.stats().puffs === 0, 'дым рисуется там, где его не видно');
  ok(dl.stats().overlays === 0, 'трещины рисуются мельче пикселя');
  ok(dl.stats().rubble === 1, 'руина пропала — потерялась игровая информация');
});

t('совсем дальний план: слой молчит целиком', () => {
  const dl = new DamageLayer(QUALITY.high);
  const sim = simOf([bld('hut', 46, 46, { hp: 4 }), bld('farm', 47, 46, { destroyed: true })]);
  const ctx = frame(dl, sim, { zoom: 0.15 });   // z = 4.8 px на тайл
  ok(ctx.calls.drawImage === 0, `на дальнем плане ${ctx.calls.drawImage} блитов`);
});

t('за экраном не рисуется ничего', () => {
  const dl = new DamageLayer(QUALITY.high);
  const sim = simOf([bld('hut', 5, 5, { destroyed: true }), bld('farm', 90, 90, { destroyed: true })]);
  frame(dl, sim);
  ok(dl.stats().rubble === 0, 'отсечение по экрану не работает');
});

t('enabled=false выключает слой полностью', () => {
  const dl = new DamageLayer(QUALITY.high);
  dl.enabled = false;
  const sim = simOf([bld('hut', 46, 46, { hp: 4 }), bld('farm', 47, 46, { destroyed: true })]);
  const ctx = frame(dl, sim);
  ok(ctx.calls.drawImage === 0, 'выключенный слой рисует');
});

t('свежая руина дымит, старая — нет', () => {
  const dl = new DamageLayer(QUALITY.high);
  const b = bld('smithy', 46, 46, { hp: 100 });
  const sim = simOf([b]);
  frame(dl, sim, { zoom: 1.4 });          // видели живой
  b.destroyed = true;
  let smoked = 0;
  for (let i = 0; i < 30; i++) { frame(dl, sim, { zoom: 1.4, dt: 1 / 30 }); smoked += dl.stats().puffs; }
  ok(smoked > 0, 'свежее пепелище не дымит');

  // Руина из загруженного сейва: слой её живой никогда не видел.
  const dl2 = new DamageLayer(QUALITY.high);
  const sim2 = simOf([bld('smithy', 46, 46, { destroyed: true })]);
  let old = 0;
  for (let i = 0; i < 30; i++) { frame(dl2, sim2, { zoom: 1.4, dt: 1 / 30 }); old += dl2.stats().puffs; }
  ok(old === 0, 'старое пепелище дымит как свежее');
});

t('дым остывает: к концу окна частиц меньше, чем в начале', () => {
  const dl = new DamageLayer(QUALITY.ultra);
  const b = bld('smithy', 46, 46);
  const sim = simOf([b]);
  frame(dl, sim, { zoom: 1.4 });
  b.destroyed = true;
  let early = 0, late = 0;
  for (let i = 0; i < 60; i++) { frame(dl, sim, { zoom: 1.4, dt: 1 / 30 }); early += dl.stats().puffs; }
  // Окно дымления — 25 с; прокручиваем 30 с, чтобы пепелище точно остыло.
  for (let i = 0; i < 900; i++) { frame(dl, sim, { zoom: 1.4, dt: 1 / 30 }); }
  for (let i = 0; i < 60; i++) { frame(dl, sim, { zoom: 1.4, dt: 1 / 30 }); late += dl.stats().puffs; }
  ok(late < early, `пепелище не остывает: ${early} -> ${late}`);
  ok(late === 0, `через 30 секунд всё ещё дымит: ${late}`);
});

t('отстроенная заново постройка снова считается свежей при новом сносе', () => {
  const dl = new DamageLayer(QUALITY.high);
  const b = bld('smithy', 46, 46);
  const sim = simOf([b]);
  frame(dl, sim, { zoom: 1.4 });
  b.destroyed = true;
  for (let i = 0; i < 900; i++) frame(dl, sim, { zoom: 1.4, dt: 1 / 30 });  // остыла
  b.destroyed = false;
  frame(dl, sim, { zoom: 1.4 });
  b.destroyed = true;
  let smoked = 0;
  for (let i = 0; i < 20; i++) { frame(dl, sim, { zoom: 1.4, dt: 1 / 30 }); smoked += dl.stats().puffs; }
  ok(smoked > 0, 'повторный снос прошёл молча');
});

t('кэши не растут без границ', () => {
  const dl = new DamageLayer(QUALITY.ultra);
  const bs = [];
  for (let i = 0; i < 120; i++) bs.push(bld('hut', 40 + (i % 10), 42 + ((i / 10) | 0), { hp: 20 + (i % 60), destroyed: i % 3 === 0 }));
  const sim = simOf(bs);
  for (let i = 0; i < 400; i++) frame(dl, sim, { zoom: 1.2 });
  ok(dl.overlays.size <= DAMAGE_LIMITS.overlayEntries, `наложений в кэше ${dl.overlays.size}`);
  ok(dl.rubble.size <= DAMAGE_LIMITS.rubbleEntries, `руин в кэше ${dl.rubble.size}`);
});

t('смена пресета чистит кэши', () => {
  const dl = new DamageLayer(QUALITY.high);
  const sim = simOf([bld('hut', 46, 46, { hp: 40 }), bld('farm', 47, 46, { destroyed: true })]);
  for (let i = 0; i < 5; i++) frame(dl, sim);
  ok(dl.overlays.size + dl.rubble.size > 0, 'кэш пуст — тест ничего не проверяет');
  dl.setQuality(QUALITY.eco);
  ok(dl.overlays.size === 0 && dl.rubble.size === 0, 'старая выпечка пережила смену пресета');
});

t('слой ничего не меняет в симуляции', () => {
  const dl = new DamageLayer(QUALITY.ultra);
  const bs = [bld('hut', 46, 46, { hp: 30 }), bld('farm', 47, 46, { destroyed: true }), bld('smithy', 48, 46, { hp: 4 })];
  const sim = simOf(bs);
  const before = JSON.stringify(sim);
  for (let i = 0; i < 40; i++) frame(dl, sim, { zoom: 1.3, dt: 1 / 30 });
  ok(JSON.stringify(sim) === before, 'симуляция изменилась под рендером');
});

t('картинка воспроизводима: два слоя с одним зерном дают одно и то же', () => {
  const mk = () => {
    const dl = new DamageLayer(QUALITY.high);
    const sim = simOf([bld('hut', 46, 46, { hp: 40 }), bld('farm', 47, 47, { destroyed: true })]);
    const spr = fakeSprite();
    const ctx = frameCtx();
    for (let i = 0; i < 8; i++) frame(dl, sim, { spr, ctx, zoom: 1.2, dt: 1 / 30 });
    return JSON.stringify(dl.stats());
  };
  ok(mk() === mk(), 'два одинаковых прогона разошлись');
});

t('разные зёрна мира дают разный рисунок трещин', () => {
  const variants = new Set();
  for (const seed of [1, 77, 4242, 90210]) {
    const sim = simOf([bld('hut', 46, 46, { hp: 40 })], { seed });
    const dl = new DamageLayer(QUALITY.high);
    dl.begin(sim, 1 / 60, 32, {});
    variants.add(variantOf(sim.buildings[0], dl.seed));
  }
  ok(variants.size > 1, 'мир не влияет на рисунок повреждений');
});

t('begin без вызова: слой молчит, а не падает', () => {
  const dl = new DamageLayer(QUALITY.high);
  const ctx = frameCtx();
  dl.building(ctx, bld('hut', 1, 1, { hp: 10 }), fakeSprite(), 0, 0, 32, 40);
  dl.drawSmoke(ctx);
  ok(ctx.calls.drawImage === 0, 'нарисовал что-то без begin');
});

t('постройка без спрайта не роняет кадр', () => {
  const dl = new DamageLayer(QUALITY.high);
  const sim = simOf([bld('hut', 46, 46, { hp: 40 })]);
  const ctx = frameCtx();
  dl.begin(sim, 1 / 60, 32, {});
  dl.building(ctx, sim.buildings[0], null, 0, 0, 32, 40);
  ok(ctx.calls.drawImage === 0, 'нарисовал без спрайта');
});

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
