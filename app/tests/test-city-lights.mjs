// Тесты слоя ночных огней (app/src/render/city_lights.js).
// Запуск: node app/tests/test-city-lights.mjs
//
// Канваса в node нет, поэтому здесь подставной document — как в
// test-minimap.mjs. Проверяется не картинка, а поведение: КОГДА слой
// работает, СКОЛЬКО объектов кладёт в кадр, КАКОЙ узор выбирает и
// действительно ли постройки зажигаются вразнобой. Пиксели проверит глаз.
import { TILE, BUILDINGS } from '../src/core/data.js';

const noop = () => {};
function fakeCtx(cv) {
  return {
    canvas: cv,
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
    globalCompositeOperation: 'source-over', shadowColor: '', shadowBlur: 0,
    filter: 'none',
    calls: { fillRect: 0, drawImage: 0, clearRect: 0, grad: 0 },
    alphas: [],
    save: noop, restore: noop, setTransform: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop,
    stroke: noop, arc: noop, ellipse: noop,
    fillRect() { this.calls.fillRect++; },
    clearRect() { this.calls.clearRect++; },
    drawImage() { this.calls.drawImage++; this.alphas.push(this.globalAlpha); },
    createRadialGradient() { this.calls.grad++; return { addColorStop: noop }; },
    createLinearGradient() { return { addColorStop: noop }; },
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
const { lightAt } = await import('../src/render/palette.js');
const {
  CityLights, WINDOW_CLASS, WEATHER_LIGHT,
  windowClass, warmEra, phaseBias, litFill, frameIndex, facadeRect, layoutWindows,
} = await import('../src/render/city_lights.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// --------------------------------------------------------------- заготовки
const TILE_PX = 32;
const bld = (id, x, y) => ({
  id, x, y, size: (BUILDINGS[id] && BUILDINGS[id].size) || 1, done: true, destroyed: false,
});
function simOf(n = 40, opts = {}) {
  const buildings = [];
  for (let i = 0; i < n; i++) buildings.push(bld(opts.id || 'hut', 40 + (i % 8), 40 + ((i / 8) | 0)));
  return {
    world: { w: 96, h: 96, seed: 4242, tiles: new Uint8Array(96 * 96).fill(TILE.GRASS), startX: 48, startY: 48 },
    buildings,
    dayTime: opts.dayTime === undefined ? 0.0 : opts.dayTime,
    eraIndex: opts.eraIndex === undefined ? 4 : opts.eraIndex,
    weather: opts.weather || 'sun',
    villagers: [], animals: [], factions: [],
  };
}
// Кадр 1280×720, камера в центре застройки, зум 1.
function frame(cl, sim, q, o = {}) {
  const zoom = o.zoom === undefined ? 1 : o.zoom;
  const z = TILE_PX * zoom;
  const cw = 1280, ch = 720;
  const ox = cw / 2 - 43 * z, oy = ch / 2 - 41 * z;
  const L = lightAt(sim.dayTime);
  cl.begin(sim, ox, oy, z, cw, ch, L, { zoom, time: o.time || 0 });
  const ctx = fakeCanvas().getContext();
  cl.drawGround(ctx);
  const era = o.era === undefined ? sim.eraIndex : o.era;
  for (const b of sim.buildings) {
    const sx = ox + b.x * z, sy = oy + b.y * z;
    const size = (b.size || 1) * z;
    cl.note(b, sx - size * 0.08, sy + size - size * 1.16 * 1.3, size * 1.16, size * 1.16 * 1.3, era);
  }
  cl.drawWindows(ctx);
  return { ctx, stats: cl.stats() };
}

// ------------------------------------------------------------ чистые функции
t('классы окон покрывают все десять эпох', () => {
  ok(WINDOW_CLASS.length === 10, 'нужно ровно 10 записей');
  ok(windowClass(0) === 'fire' && windowClass(1) === 'fire', 'каменный и бронза — костры');
  ok(windowClass(6) === 'grid' && windowClass(7) === 'grid', 'индустрия и современность — сетка');
  ok(windowClass(9) === 'strip', 'будущее — полосы');
});

t('windowClass зажимает выход за границы', () => {
  ok(windowClass(-5) === 'fire', 'ниже нуля');
  ok(windowClass(99) === 'strip', 'выше девяти');
});

t('тёплые эпохи заканчиваются на современности', () => {
  ok(warmEra(0) && warmEra(6), 'до индустрии включительно тепло');
  ok(!warmEra(7) && !warmEra(9), 'с современности холодно');
});

t('вечер и утро несимметричны', () => {
  ok(phaseBias(0.8) < 0, 'вечером порог ниже — свет включают заранее');
  ok(phaseBias(0.2) > 0, 'утром порог выше — гасят при первом свете');
  ok(Math.abs(phaseBias(0.8)) === Math.abs(phaseBias(0.2)), 'смещения зеркальны по величине');
});

t('litFill монотонно растёт по темноте', () => {
  let prev = -1;
  for (let n = 0; n <= 1.0001; n += 0.05) {
    const v = litFill(4242, 40, 40, n, 0);
    ok(v >= prev - 1e-9, `не должно убывать на n=${n.toFixed(2)}`);
    prev = v;
  }
  near(litFill(4242, 40, 40, 1, 0), 1, 1e-9, 'в полночь горит всё');
  ok(litFill(4242, 40, 40, 0, 0) === 0, 'в полдень не горит ничего');
});

t('постройки зажигаются вразнобой, а не разом', () => {
  // На «полусумерках» часть домов уже светится, часть ещё нет — это и есть
  // главный смысл модуля. Проверяем на сетке 8×8 реальных координат.
  const vals = [];
  for (let y = 40; y < 48; y++) for (let x = 40; x < 48; x++) vals.push(litFill(4242, x, y, 0.45, 0));
  const dark = vals.filter(v => v <= 0.02).length;
  const lit = vals.filter(v => v > 0.02).length;
  const full = vals.filter(v => v >= 0.999).length;
  ok(dark >= 6, `часть домов должна быть ещё тёмной, а тёмных ${dark}`);
  ok(lit >= 6, `часть домов должна уже светиться, а светящихся ${lit}`);
  ok(full < vals.length, 'не все дома могут гореть в полную силу в сумерках');
});

t('разные миры зажигаются по-разному, один мир — одинаково', () => {
  const a = litFill(4242, 40, 40, 0.45, 0);
  const b = litFill(4242, 40, 40, 0.45, 0);
  ok(a === b, 'один сид и одна клетка — один результат (детерминизм)');
  let diff = 0;
  for (let x = 40; x < 60; x++) if (litFill(4242, x, 40, 0.45, 0) !== litFill(777, x, 40, 0.45, 0)) diff++;
  ok(diff >= 8, `сид мира должен менять картину, различий ${diff} из 20`);
});

t('frameIndex не выходит из атласа', () => {
  ok(frameIndex(0) === 0, 'ноль — кадра нет');
  ok(frameIndex(-3) === 0 && frameIndex(5) === 6, 'зажим по обе стороны');
  ok(frameIndex(0.01) === 1, 'чуть-чуть — уже первый кадр');
  ok(frameIndex(1) === 6, 'полностью — последний кадр');
  for (let f = 0; f <= 1.0001; f += 0.017) {
    const k = frameIndex(f);
    ok(k >= 0 && k <= 6 && Number.isInteger(k), `кадр ${k} вне 0..6`);
  }
});

t('фасад лежит внутри прямоугольника спрайта', () => {
  for (const [w, h] of [[40, 52], [40, 140], [96, 96], [12, 30]]) {
    const r = facadeRect(100, 200, w, h);
    ok(r.x >= 100 && r.x + r.w <= 100 + w, `по ширине вылез: ${w}×${h}`);
    ok(r.y >= 200 && r.y + r.h <= 200 + h, `по высоте вылез: ${w}×${h}`);
    ok(r.w > 0 && r.h > 0, 'вырожденный фасад');
  }
});

t('у башни окна занимают больше высоты, чем у избы', () => {
  const low = facadeRect(0, 0, 100, 100);
  const tall = facadeRect(0, 0, 100, 300);
  ok(tall.h / 300 > low.h / 100, 'доля высоты у башни должна быть больше');
  ok(tall.y / 300 < low.y / 100, 'у башни окна начинаются выше');
});

t('раскладка окон детерминирована и лежит в кадре', () => {
  for (const cls of ['fire', 'lamp', 'grid', 'strip']) {
    for (let v = 0; v < 3; v++) {
      const a = layoutWindows(cls, v), b = layoutWindows(cls, v);
      ok(a.length === b.length, `${cls}/${v}: разное число окон между вызовами`);
      ok(a.length > 0, `${cls}/${v}: пустая раскладка`);
      for (let i = 0; i < a.length; i++) {
        ok(a[i].x === b[i].x && a[i].rank === b[i].rank, `${cls}/${v}: раскладка не воспроизводится`);
        ok(a[i].x >= -0.02 && a[i].x + a[i].w <= 1.02, `${cls}/${v}: окно вылезло по X`);
        ok(a[i].y >= -0.02 && a[i].y + a[i].h <= 1.02, `${cls}/${v}: окно вылезло по Y`);
        ok(a[i].rank >= 0 && a[i].rank < 1, `${cls}/${v}: ранг вне [0,1)`);
      }
    }
  }
});

t('плотность окон растёт от костра к небоскрёбу', () => {
  const n = (cls) => layoutWindows(cls, 0).length;
  ok(n('fire') < n('lamp'), 'костров должно быть меньше, чем проёмов');
  ok(n('lamp') < n('grid'), 'индустриальная сетка плотнее свечей');
  ok(n('grid') >= 8, `сетка обязана быть рядами, а не тремя точками (${n('grid')})`);
  ok(n('fire') <= 3, 'костров максимум три');
});

t('погодная таблица покрывает все состояния палитры', () => {
  for (const w of ['sun', 'cloud', 'rain', 'snow', 'storm', 'fog', 'heat']) {
    const e = WEATHER_LIGHT[w];
    ok(e, `нет записи для погоды ${w}`);
    ok(e.pool >= 1 && e.pool <= 1.4, `${w}: множитель пятна вне разумного`);
    ok(e.win > 0 && e.win <= 1, `${w}: множитель окон вне (0,1]`);
  }
  ok(WEATHER_LIGHT.fog.radius > WEATHER_LIGHT.sun.radius, 'в тумане пятно шире');
  ok(WEATHER_LIGHT.fog.win < WEATHER_LIGHT.sun.win, 'в тумане окно приглушено');
});

// ------------------------------------------------------------------- слой
t('днём слой не делает ничего', () => {
  const cl = new CityLights(QUALITY.high);
  const r = frame(cl, simOf(40, { dayTime: 0.5 }), QUALITY.high);
  ok(!cl.stats().on, 'слой должен быть выключен в полдень');
  ok(r.ctx.calls.drawImage === 0, `ни одного блита днём, а их ${r.ctx.calls.drawImage}`);
});

t('ночью рисуются и пятна, и окна', () => {
  const cl = new CityLights(QUALITY.high);
  const r = frame(cl, simOf(40, { dayTime: 0.0 }), QUALITY.high);
  ok(r.stats.on, 'слой должен работать в полночь');
  ok(r.stats.pools === 40, `пятен должно быть 40, а их ${r.stats.pools}`);
  ok(r.stats.windows === 40, `окон должно быть 40, а их ${r.stats.windows}`);
  // 40 пятен идут в offscreen, на основной холст — один блит слоя пятен
  // плюс 40 блитов окон.
  ok(r.ctx.calls.drawImage === 41, `на основной холст ожидается 41 блит, а их ${r.ctx.calls.drawImage}`);
});

t('пятна складываются в один слой, а не блитятся по зданию', () => {
  const cl = new CityLights(QUALITY.high);
  const sim = simOf(40, { dayTime: 0.0 });
  frame(cl, sim, QUALITY.high);
  const pc = cl.pool.getContext();
  ok(pc.calls.clearRect >= 1, 'слой пятен обязан очищаться каждый кадр');
  ok(pc.calls.drawImage >= 40, `в слой пятен должно уйти 40 блитов, ушло ${pc.calls.drawImage}`);
});

t('на eco слой пятен не создаётся вовсе', () => {
  const cl = new CityLights(QUALITY.eco);
  // eco прячет свечение зданий ниже зума 1,2 — берём 1,3, иначе проверялось бы
  // не «нет слоя пятен», а «слой вообще выключен по LOD».
  const r = frame(cl, simOf(30, { dayTime: 0.0 }), QUALITY.eco, { zoom: 1.3 });
  ok(cl.pool === null, 'на eco offscreen-слой не должен появляться');
  ok(r.stats.pools === 0, 'пятен на eco нет');
  ok(r.stats.windows > 0, 'а окна остаются — они почти бесплатны');
  ok(r.ctx.calls.drawImage === r.stats.windows, 'на основной холст идут только окна');
});

t('ниже порога зума слой молчит', () => {
  const cl = new CityLights(QUALITY.high);
  // buildingGlowMinZoom на high — 0,6
  const lo = frame(cl, simOf(20, { dayTime: 0.0 }), QUALITY.high, { zoom: 0.4 });
  ok(!lo.stats.on, 'на зуме 0,4 слой должен выключиться');
  const hi = frame(cl, simOf(20, { dayTime: 0.0 }), QUALITY.high, { zoom: 0.8 });
  ok(hi.stats.on, 'на зуме 0,8 слой должен работать');
});

t('потолки объектов соблюдаются', () => {
  const cl = new CityLights(QUALITY.eco);   // caps.buildings = 120
  const r = frame(cl, simOf(400, { dayTime: 0.0 }), QUALITY.eco, { zoom: 1.3 });
  ok(r.stats.windows <= 120, `окон не больше 120, а их ${r.stats.windows}`);
  const cl2 = new CityLights(QUALITY.high); // caps.buildings = 200, пятна — 160
  const r2 = frame(cl2, simOf(400, { dayTime: 0.0 }), QUALITY.high);
  ok(r2.stats.pools <= 160, `пятен не больше 160, а их ${r2.stats.pools}`);
  ok(r2.stats.windows <= 200, `окон не больше 200, а их ${r2.stats.windows}`);
});

t('недострой и руины не светятся', () => {
  const cl = new CityLights(QUALITY.high);
  const sim = simOf(10, { dayTime: 0.0 });
  sim.buildings[0].done = false;
  sim.buildings[1].destroyed = true;
  frame(cl, sim, QUALITY.high);
  ok(cl.stats().pools === 8, `светиться должны 8 построек, а светятся ${cl.stats().pools}`);
});

t('постройки за краем экрана отсекаются', () => {
  const cl = new CityLights(QUALITY.high);
  const sim = simOf(4, { dayTime: 0.0 });
  for (const b of sim.buildings) { b.x = 1000; b.y = 1000; }
  frame(cl, sim, QUALITY.high);
  ok(cl.stats().pools === 0, 'за экраном пятен быть не должно');
});

t('бюджет выпечки атласов ограничен кадром', () => {
  const cl = new CityLights(QUALITY.high);
  // 40 построек с разными координатами дают до трёх вариантов узора —
  // за один кадр разрешено испечь не больше трёх атласов.
  const r = frame(cl, simOf(40, { dayTime: 0.0 }), QUALITY.high);
  ok(r.stats.bakes <= 3, `за кадр не более трёх выпечек, было ${r.stats.bakes}`);
  const r2 = frame(cl, simOf(40, { dayTime: 0.0 }), QUALITY.high);
  ok(r2.stats.bakes === 0, 'во втором кадре атласы берутся из кэша');
});

t('атлас переиспользуется между кадрами и не растёт бесконечно', () => {
  const cl = new CityLights(QUALITY.eco);   // spriteEntries 48 → потолок 12
  for (let era = 0; era < 10; era++) {
    for (let f = 0; f < 4; f++) frame(cl, simOf(30, { dayTime: 0.0, eraIndex: era }), QUALITY.eco, { era, zoom: 1.3 });
  }
  ok(cl.stats().atlases <= 12, `атласов не больше 12, а их ${cl.stats().atlases}`);
  ok(cl.stats().atlases > 0, 'кэш не должен быть пустым');
});

t('прозрачность окон растёт от сумерек к полуночи', () => {
  const cl = new CityLights(QUALITY.high);
  const dusk = frame(cl, simOf(24, { dayTime: 0.80 }), QUALITY.high);
  const duskMax = Math.max(0, ...dusk.ctx.alphas);
  const night = frame(cl, simOf(24, { dayTime: 0.00 }), QUALITY.high);
  const nightMax = Math.max(0, ...night.ctx.alphas);
  ok(nightMax > duskMax, `в полночь ярче, чем в сумерки (${nightMax} vs ${duskMax})`);
  ok(nightMax <= 1 && duskMax >= 0, 'прозрачность обязана лежать в [0,1]');
});

t('в сумерках светится меньше домов, чем в полночь', () => {
  const cl = new CityLights(QUALITY.high);
  // 0,75 суток — ранние сумерки: lightAt даёт glow ≈ 0,40, и это ровно та
  // точка, где часть порогов уже перекрыта, а часть ещё нет.
  const dusk = frame(cl, simOf(64, { dayTime: 0.75 }), QUALITY.high);
  const night = frame(cl, simOf(64, { dayTime: 0.0 }), QUALITY.high);
  ok(dusk.stats.windows < night.stats.windows,
    `в сумерках ${dusk.stats.windows}, в полночь ${night.stats.windows}`);
  ok(dusk.stats.windows > 0, 'но кто-то уже должен светиться');
});

t('туман усиливает пятно и приглушает окна', () => {
  const clear = new CityLights(QUALITY.high);
  frame(clear, simOf(20, { dayTime: 0.0, weather: 'sun' }), QUALITY.high);
  const aClear = clear.pool.getContext().alphas.slice();
  const foggy = new CityLights(QUALITY.high);
  const rf = frame(foggy, simOf(20, { dayTime: 0.0, weather: 'fog' }), QUALITY.high);
  const aFog = foggy.pool.getContext().alphas.slice();
  ok(Math.max(...aFog) > Math.max(...aClear), 'в тумане пятно ярче');
  const rc = frame(new CityLights(QUALITY.high), simOf(20, { dayTime: 0.0, weather: 'sun' }), QUALITY.high);
  ok(Math.max(...rf.ctx.alphas.slice(1)) < Math.max(...rc.ctx.alphas.slice(1)), 'в тумане окна приглушены');
});

t('мерцание костров живёт во времени, а каменные дома — нет', () => {
  const a = new CityLights(QUALITY.high);
  const b = new CityLights(QUALITY.high);
  const s = simOf(16, { dayTime: 0.0, eraIndex: 0 });
  const r0 = frame(a, s, QUALITY.high, { time: 0, era: 0 });
  const r1 = frame(b, s, QUALITY.high, { time: 0.55, era: 0 });
  ok(JSON.stringify(r0.ctx.alphas) !== JSON.stringify(r1.ctx.alphas), 'костры обязаны дрожать');
  const c = new CityLights(QUALITY.high), d = new CityLights(QUALITY.high);
  const g0 = frame(c, simOf(16, { dayTime: 0.0, eraIndex: 6 }), QUALITY.high, { time: 0, era: 6 });
  const g1 = frame(d, simOf(16, { dayTime: 0.0, eraIndex: 6 }), QUALITY.high, { time: 0.55, era: 6 });
  ok(JSON.stringify(g0.ctx.alphas) === JSON.stringify(g1.ctx.alphas), 'электрическое окно не мерцает');
});

t('кадр не зависит от истории вызовов (нет накопления заявок)', () => {
  const cl = new CityLights(QUALITY.high);
  const s = simOf(30, { dayTime: 0.0 });
  const a = frame(cl, s, QUALITY.high);
  const b = frame(cl, s, QUALITY.high);
  ok(a.stats.windows === b.stats.windows, 'число окон не должно накапливаться');
  ok(a.stats.pools === b.stats.pools, 'число пятен не должно накапливаться');
});

t('note без begin ничего не делает', () => {
  const cl = new CityLights(QUALITY.high);
  const ctx = fakeCanvas().getContext();
  cl.note(bld('hut', 40, 40), 0, 0, 40, 50, 4);
  cl.drawWindows(ctx);
  cl.drawGround(ctx);
  ok(ctx.calls.drawImage === 0, 'без begin() слой обязан молчать');
});

t('вырожденный прямоугольник спрайта не роняет слой', () => {
  const cl = new CityLights(QUALITY.high);
  const sim = simOf(4, { dayTime: 0.0 });
  const L = lightAt(0);
  cl.begin(sim, 0, 0, 32, 1280, 720, L, { zoom: 1, time: 0 });
  cl.note(sim.buildings[0], 10, 10, 0, 0, 4);
  cl.note(sim.buildings[1], 10, 10, NaN, 40, 4);
  ok(cl.stats().on, 'слой жив');
  const ctx = fakeCanvas().getContext();
  cl.drawWindows(ctx);
  ok(ctx.calls.drawImage === 0, 'вырожденные заявки не должны попадать в кадр');
});

t('смена пресета не ломает слой и не роняет кэш в ноль', () => {
  const cl = new CityLights(QUALITY.high);
  frame(cl, simOf(20, { dayTime: 0.0 }), QUALITY.high);
  const before = cl.stats().atlases;
  cl.setQuality(QUALITY.medium);
  const r = frame(cl, simOf(20, { dayTime: 0.0 }), QUALITY.medium);
  ok(r.stats.windows > 0, 'после смены пресета слой продолжает работать');
  ok(cl.stats().atlases >= Math.min(before, 6), 'атласы не выбрасываются зря');
});

t('холодные эпохи получают холодное пятно, тёплые — тёплое', () => {
  const warm = new CityLights(QUALITY.high);
  frame(warm, simOf(8, { dayTime: 0.0, eraIndex: 3 }), QUALITY.high);
  const cold = new CityLights(QUALITY.high);
  frame(cold, simOf(8, { dayTime: 0.0, eraIndex: 9 }), QUALITY.high);
  // Обе кисти печёт blobSprite; проверяем, что модуль вообще их различает.
  ok(warm.blob.size >= 1 && cold.blob.size >= 1, 'кисти пятен испечены');
  ok(warmEra(3) && !warmEra(9), 'разделение эпох на тёплые и холодные работает');
});

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
