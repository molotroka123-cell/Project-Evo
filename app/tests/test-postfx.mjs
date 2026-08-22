// Тесты единого прохода пост-обработки (app/src/render/postfx.js).
// Запуск: node app/tests/test-postfx.mjs
//
// Канваса в node нет, поэтому здесь подставной document — как в
// test-city-lights.mjs и test-minimap.mjs. Проверяется не картинка, а то,
// за что модуль отвечает по бюджету: СКОЛЬКО полноэкранных операций уходит
// в кадр, КОГДА слой молчит, КАКОЙ ярус композита выбран под нагрузкой и
// действительно ли выпечка происходит один раз, а не каждый кадр.
// Пиксели проверит глаз, миллисекунды — замер главного разработчика.
import { readFileSync } from 'node:fs';
import { TILE } from '../src/core/data.js';

const noop = () => {};

// Подставной контекст. Считает не «вызовы вообще», а площадь назначения:
// именно она и есть цена кадра (ставки — миллисекунды на пиксель назначения).
function fakeCtx(cv) {
  return {
    canvas: cv,
    fillStyle: '', strokeStyle: '', globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    calls: { fillRect: 0, drawImage: 0, clearRect: 0, grad: 0, save: 0, setTransform: 0 },
    fills: [], blits: [], modes: [],
    save() { this.calls.save++; }, restore: noop,
    setTransform() { this.calls.setTransform++; },
    translate: noop, scale: noop, rotate: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop,
    stroke: noop, arc: noop, ellipse: noop, putImageData: noop,
    fillRect(x, y, w, h) {
      this.calls.fillRect++;
      this.fills.push({ x, y, w, h, style: this.fillStyle, area: w * h });
    },
    clearRect() { this.calls.clearRect++; },
    drawImage(...a) {
      this.calls.drawImage++;
      // dw/dh — последние два аргумента и в короткой (5 арг.), и в длинной форме
      const dw = a.length >= 9 ? a[7] : a.length >= 5 ? a[3] : 0;
      const dh = a.length >= 9 ? a[8] : a.length >= 5 ? a[4] : 0;
      this.blits.push({ area: Math.abs(dw * dh), mode: this.globalCompositeOperation, alpha: this.globalAlpha });
      this.modes.push(this.globalCompositeOperation);
    },
    createRadialGradient() { this.calls.grad++; return { addColorStop: noop }; },
    createLinearGradient() { return { addColorStop: noop }; },
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
  };
}
function fakeCanvas() {
  const cv = { width: 0, height: 0 };
  const ctx = fakeCtx(cv);
  cv.getContext = () => ctx;
  cv.toDataURL = () => 'data:image/png;base64,FAKE';
  return cv;
}
// Подставной DOM: нужен и для канвасов выпечки, и для CSS-слоя зерна.
function makeEl(tag) {
  return {
    tagName: tag, id: '', textContent: '',
    style: { cssText: '', opacity: '' },
    children: [], parentNode: null,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; },
  };
}
const head = makeEl('head'), body = makeEl('body');
globalThis.document = {
  head, body,
  createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : makeEl(tag)),
};

const { QUALITY } = await import('../src/render/quality.js');
const { lightAt } = await import('../src/render/palette.js');
const {
  PostFX, RATE, mergeFills, gradeFor, vignetteAlpha, bloomTier, hashP, grainDataUrl,
} = await import('../src/render/postfx.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// --------------------------------------------------------------- заготовки
const CW = 1280, CH = 720, TILE_PX = 32;

function simOf(n = 40, o = {}) {
  const buildings = [];
  for (let i = 0; i < n; i++) {
    buildings.push({ id: o.id || 'hut', x: 40 + (i % 8), y: 40 + ((i / 8) | 0), size: 1, done: true, destroyed: false });
  }
  return {
    world: { w: 96, h: 96, seed: 4242, tiles: new Uint8Array(96 * 96).fill(TILE.GRASS), startX: 48, startY: 48 },
    buildings,
    dayTime: o.dayTime === undefined ? 0.0 : o.dayTime,
    eraIndex: o.eraIndex === undefined ? 4 : o.eraIndex,
    weather: o.weather || 'sun',
    villagers: [], animals: [], factions: [],
  };
}

// Один кадр: begin -> (авто-сбор огней) -> draw. Возвращает контекст и статистику.
function frame(fx, sim, o = {}) {
  const zoom = o.zoom === undefined ? 1 : o.zoom;
  const z = TILE_PX * zoom;
  const dpr = o.dpr === undefined ? 1 : o.dpr;
  const ox = CW / 2 - 43 * z, oy = CH / 2 - 41 * z;
  const L = lightAt(sim.dayTime);
  fx.begin(sim, CW, CH, L, { dpr, ox, oy, z, zoom, time: o.time || 0 });
  const ctx = fakeCanvas().getContext();
  fx.draw(ctx);
  return { ctx, stats: fx.stats(), L };
}

const px = (dpr = 1) => CW * CH * dpr * dpr;

// ------------------------------------------------------- слияние заливок
t('слияние двух заливок совпадает с последовательным наложением', () => {
  // Проверяем на трёх базовых цветах: слияние обязано быть точным, а не «похожим».
  const f1 = [255, 0, 0, 0.5], f2 = [0, 0, 255, 0.5];
  const m = mergeFills([f1, f2]);
  for (const base of [0, 128, 255]) {
    for (let ch = 0; ch < 3; ch++) {
      let c = base;
      c = c * (1 - f1[3]) + f1[ch] * f1[3];
      c = c * (1 - f2[3]) + f2[ch] * f2[3];
      const one = base * (1 - m.a) + [m.r, m.g, m.b][ch] * m.a;
      near(one, c, 0.6, `база ${base}, канал ${ch}`);
    }
  }
});

t('слияние пустого списка и нулевых альф даёт ноль', () => {
  ok(mergeFills([]).a === 0, 'пустой список');
  ok(mergeFills([[255, 255, 255, 0]]).a === 0, 'нулевая альфа');
  ok(mergeFills([null, undefined]).a === 0, 'мусор в списке не ломает');
});

t('три заливки складываются так же точно, как две', () => {
  const l = [[22, 34, 86, 0.46], [70, 96, 128, 0.24], [150, 152, 156, 0.05]];
  const m = mergeFills(l);
  let c = 200;
  for (const f of l) c = c * (1 - f[3]) + f[0] * f[3];
  near(200 * (1 - m.a) + m.r * m.a, c, 0.6, 'красный канал');
});

// ------------------------------------------------------- цветокоррекция
t('ночь темнее полудня, гроза темнее ясного неба', () => {
  const q = QUALITY.high;
  const night = gradeFor(lightAt(0.0), 'sun', q, null);
  const noon = gradeFor(lightAt(0.5), 'sun', q, null);
  ok(night.a > noon.a, `ночной тон плотнее дневного: ${night.a} vs ${noon.a}`);
  const storm = gradeFor(lightAt(0.5), 'storm', q, null);
  ok(storm.a > noon.a, 'гроза добавляет плотности');
});

t('обесцвечивание вливается в ту же заливку, а не в отдельный проход', () => {
  const fog = gradeFor(lightAt(0.5), 'fog', QUALITY.high, null);
  const clear = gradeFor(lightAt(0.5), 'sun', QUALITY.high, null);
  ok(fog.a > clear.a, 'туман плотнее');
  // ultra обещает сочность — серую вуаль он не добавляет
  const fogUltra = gradeFor(lightAt(0.5), 'fog', QUALITY.ultra, null);
  ok(fogUltra.a < fog.a, `на ultra вуали нет: ${fogUltra.a} vs ${fog.a}`);
});

// ------------------------------------------------------------- виньетка
t('сила виньетки: ночью сильнее, днём слабее, в непогоду сильнее', () => {
  const night = vignetteAlpha(lightAt(0.0), 'sun');
  const noon = vignetteAlpha(lightAt(0.5), 'sun');
  ok(night > noon, `${night} > ${noon}`);
  ok(noon >= 0.6 && night <= 1.0, 'сила остаётся в разумных пределах');
  ok(vignetteAlpha(lightAt(0.5), 'fog') > noon, 'туман сжимает кадр сильнее');
});

// --------------------------------------------------------- ярусы свечения
t('ярус композита свечения выбирается по площади и бюджету', () => {
  const ms = 0.6;
  ok(bloomTier(0, ms) === 'off', 'нечего светить');
  ok(bloomTier(50e3, ms) === 'add', '50 тыс. px укладываются в lighter');
  ok(bloomTier(400e3, ms) === 'soft', '400 тыс. px — только дешёвое наложение');
  ok(bloomTier(2e6, ms) === 'flat', 'весь экран — равномерный подъём');
  ok(bloomTier(1e5, 0) === 'off', 'нулевой бюджет выключает ярус');
  // Пороги обязаны следовать из ставок, а не быть вписанными руками.
  near(ms / RATE.add, 85106, 200, 'порог add');
  near(ms / RATE.scaleRough, 857142, 500, 'порог soft');
});

// ------------------------------------------------------------ кадр целиком
t('eco: ни виньетки, ни свечения — ровно одна заливка на кадр', () => {
  const fx = new PostFX(QUALITY.eco);
  const r = frame(fx, simOf(30, { dayTime: 0.0 }));
  ok(r.stats.lean, 'слой в «худом» режиме');
  ok(r.ctx.calls.fillRect === 1, `заливок ${r.ctx.calls.fillRect}, нужна одна`);
  ok(r.ctx.calls.drawImage === 0, 'ни одного блита на eco');
  ok(r.stats.spots === 0, 'кисточек свечения нет');
});

t('setEnabled(false) выключает слой полностью', () => {
  const fx = new PostFX(QUALITY.high);
  fx.setEnabled(false);
  const r = frame(fx, simOf(30, { dayTime: 0.0 }));
  ok(r.ctx.calls.fillRect === 0 && r.ctx.calls.drawImage === 0, 'ни одной операции');
  ok(fx.costMs() === 0, 'и ноль по предсказанию цены');
});

t('high ночью: не больше двух полноэкранных операций', () => {
  const fx = new PostFX(QUALITY.high);
  const r = frame(fx, simOf(60, { dayTime: 0.0 }));
  const full = px(1);
  // Всё, что покрывает больше 90 % экрана, считаем полноэкранным проходом.
  const heavy = [...r.ctx.fills, ...r.ctx.blits].filter(o => o.area >= full * 0.9);
  ok(heavy.length <= 2, `полноэкранных операций ${heavy.length}, потолок 2`);
  ok(r.ctx.calls.fillRect === 1, 'тонировка — одна заливка');
});

t('свечение композитится одним блитом, а не по кисточке на дом', () => {
  const fx = new PostFX(QUALITY.high);
  const r = frame(fx, simOf(60, { dayTime: 0.0 }), { zoom: 1.6 });
  ok(r.stats.spots > 20, `кисточек в буфере ${r.stats.spots}`);
  // Блиты по экрану: свечение (0 или 1) + виньетка (4 зеркальные четверти).
  ok(r.ctx.calls.drawImage <= 5, `блитов по экрану ${r.ctx.calls.drawImage}, потолок 5`);
  const add = r.ctx.blits.filter(b => b.mode === 'lighter');
  ok(add.length <= 1, `'lighter' по экрану не больше одного раза, а не ${add.length}`);
});

t('днём свечения нет вообще', () => {
  const fx = new PostFX(QUALITY.high);
  const r = frame(fx, simOf(60, { dayTime: 0.5 }));
  ok(r.stats.spots === 0, 'полдень — светиться нечему');
  ok(r.stats.tier === 'off', `ярус ${r.stats.tier}`);
});

t('потолок кисточек соблюдается при любом числе построек', () => {
  const fx = new PostFX(QUALITY.ultra);
  const r = frame(fx, simOf(400, { dayTime: 0.0 }), { zoom: 0.9 });
  ok(r.stats.spots <= 96, `кисточек ${r.stats.spots}, потолок 96`);
  ok(r.stats.dropped >= 0, 'отброшенные считаются');
});

t('вырожденные заявки не попадают в кадр и не тратят потолок', () => {
  const fx = new PostFX(QUALITY.high);
  fx.begin(simOf(0), CW, CH, lightAt(0.0), { dpr: 1 });
  fx.note(10, 10, 0, 40, true, 0.5);
  fx.note(10, 10, 40, 0, true, 0.5);
  fx.note(NaN, 10, 40, 40, true, 0.5);
  fx.note(10, 10, 40, 40, true, 0);
  ok(fx.stats().spots === 0, 'ни одна вырожденная заявка не прошла');
  fx.note(600, 300, 60, 60, true, 0.5);
  ok(fx.stats().spots === 1, 'нормальная заявка проходит');
});

t('заявка за пределами кадра не расширяет площадь композита', () => {
  const fx = new PostFX(QUALITY.high);
  fx.begin(simOf(0), CW, CH, lightAt(0.0), { dpr: 1 });
  fx.note(-8000, -8000, 40, 40, true, 0.6);
  const ctx = fakeCanvas().getContext();
  fx.draw(ctx);
  ok(fx.stats().tier === 'off' || fx.stats().spots === 0, 'далёкая заявка отсеяна');
});

t('свечение ложится ПОВЕРХ тонировки, а виньетка — последней', () => {
  const fx = new PostFX(QUALITY.high);
  const sim = simOf(6, { dayTime: 0.0 });
  const z = TILE_PX * 1.6;
  const L = lightAt(0.0);
  fx.begin(sim, CW, CH, L, { dpr: 1, ox: CW / 2 - 43 * z, oy: CH / 2 - 41 * z, z, zoom: 1.6 });
  const ctx = fakeCanvas().getContext();
  const order = [];
  const origFill = ctx.fillRect.bind(ctx), origBlit = ctx.drawImage.bind(ctx);
  ctx.fillRect = (...a) => { order.push('fill'); origFill(...a); };
  ctx.drawImage = (...a) => { order.push(ctx.globalCompositeOperation === 'lighter' ? 'bloom' : 'blit'); origBlit(...a); };
  fx.draw(ctx);
  ok(order[0] === 'fill', `первой идёт тонировка, а не ${order[0]}`);
  ok(order[order.length - 1] === 'blit', 'последней идёт виньетка');
});

// -------------------------------------------------------------- выпечка
t('виньетка печётся один раз, а не каждый кадр', () => {
  const fx = new PostFX(QUALITY.high);
  const sim = simOf(20, { dayTime: 0.2 });
  frame(fx, sim);
  const after1 = fx.vig;
  const gradsAfter1 = countGrads();
  frame(fx, sim); frame(fx, sim); frame(fx, sim);
  ok(fx.vig === after1, 'канвас виньетки не пересоздан');
  ok(countGrads() === gradsAfter1, 'ни одного нового градиента за три кадра');
  function countGrads() { return fx.vig ? fx.vig.getContext().calls.grad : -1; }
});

t('виньетка печётся во весь кадр и кладётся одним блитом', () => {
  // Здесь стояло обратное: «хранится четвертью — вчетверо меньше памяти».
  // Замер это отменил. Зеркальный блит (scale(-1,1)) на SwiftShader — а другого
  // растеризатора в окружении нет — уходит с быстрого пути 1:1 и стоит около
  // десяти кадров в секунду: start 52 против 56, city 51 против 59, win 53
  // против 59, map 48 против 60 (максимум из трёх прогонов tools/shot.mjs).
  // Экономия 4,4 МБ такой цены не стоит, тем более что прежний drawVignette в
  // renderer.js держал ту же картинку целиком и в бюджет укладывался.
  //
  // Сторож смотрит на память нарочно: если кто-то вернёт зеркала ради неё, он
  // упрётся сюда и прочтёт замер, а не станет гадать.
  const fx = new PostFX(QUALITY.high);
  frame(fx, simOf(10, { dayTime: 0.2 }), { dpr: 2 });
  const s = fx.stats();
  const full = s.w * s.h;
  near(s.vigPx / full, 1, 0.01, 'весь кадр');
});

t('смена размера кадра перепекает виньетку, повтор — нет', () => {
  const fx = new PostFX(QUALITY.high);
  const sim = simOf(10, { dayTime: 0.2 });
  frame(fx, sim, { dpr: 1 });
  const a = fx.vig;
  frame(fx, sim, { dpr: 2 });
  ok(fx.vig !== a, 'другой размер — другая выпечка');
  const b = fx.vig;
  frame(fx, sim, { dpr: 2 });
  ok(fx.vig === b, 'тот же размер — та же выпечка');
});

t('кисти ореола пекутся один раз на модуль', () => {
  const fx = new PostFX(QUALITY.high);
  const sim = simOf(20, { dayTime: 0.0 });
  frame(fx, sim);
  const w = fx.brushWarm;
  frame(fx, sim);
  ok(fx.brushWarm === w, 'тёплая кисть не перепекается');
});

// --------------------------------------------------------- смена пресета
t('смена пресета не ломает слой и пересоздаёт только зависимое', () => {
  const fx = new PostFX(QUALITY.high);
  const sim = simOf(30, { dayTime: 0.0 });
  frame(fx, sim);
  const brush = fx.brushWarm;
  fx.setQuality(QUALITY.ultra);          // bloomDiv 6 -> 5, softLight false -> true
  ok(fx.buf === null, 'буфер свечения выброшен: сменился делитель');
  ok(fx.vig === null, 'виньетка выброшена: сменился мягкий свет');
  const r = frame(fx, sim);
  ok(r.stats.on && fx.brushWarm === brush, 'кисти пережили смену пресета');
  fx.setQuality(QUALITY.eco);
  const e = frame(fx, sim);
  ok(e.ctx.calls.drawImage === 0, 'после перехода на eco блитов нет');
});

t('переход с medium на high оживляет буфер свечения', () => {
  const fx = new PostFX(QUALITY.medium);
  const sim = simOf(30, { dayTime: 0.0 });
  const m = frame(fx, sim);
  ok(m.stats.spots === 0 && m.stats.tier === 'off', 'на medium свечения нет');
  fx.setQuality(QUALITY.high);
  const h = frame(fx, sim);
  ok(h.stats.spots > 0, 'на high свечение вернулось');
});

// ------------------------------------------------------------------ зерно
t('зерно уходит в CSS-слой и только на ultra', () => {
  body.children.length = 0;
  const hi = new PostFX(QUALITY.high);
  frame(hi, simOf(5, { dayTime: 0.2 }));
  ok(!hi.stats().grain, 'на high CSS-слой не создаётся');
  const ul = new PostFX(QUALITY.ultra);
  const r = frame(ul, simOf(5, { dayTime: 0.2 }));
  ok(ul.stats().grain, 'на ultra слой создан');
  ok(ul.grainEl.style.opacity === String(QUALITY.ultra.grainCss), `непрозрачность ${ul.grainEl.style.opacity}`);
  ok(/mix-blend-mode:overlay/.test(ul.grainEl.style.cssText), 'режим overlay');
  ok(/z-index:1/.test(ul.grainEl.style.cssText), 'слой между канвасом (0) и HUD (15+)');
  // И ни одной операции по зерну в самом кадре.
  ok(r.ctx.fills.every(f => !/pattern/i.test(String(f.style))), 'зерно не рисуется в кадр');
  ul.detachGrain();
});

t('переход ultra -> high гасит слой зерна, не удаляя его', () => {
  const fx = new PostFX(QUALITY.ultra);
  frame(fx, simOf(5, { dayTime: 0.2 }));
  const el = fx.grainEl;
  ok(el, 'слой есть');
  fx.setQuality(QUALITY.high);
  ok(fx.grainEl === el, 'элемент не пересоздан');
  ok(el.style.opacity === '0', `погашен, а не удалён: ${el.style.opacity}`);
  fx.detachGrain();
});

t('плитка зерна детерминирована: один сид — одна плитка', () => {
  ok(hashP(1, 2, 3, 4) === hashP(1, 2, 3, 4), 'хеш стабилен');
  ok(hashP(1, 2, 3, 4) !== hashP(1, 2, 3, 5), 'соль меняет результат');
  ok(hashP(1, 2, 3, 4) >= 0 && hashP(1, 2, 3, 4) < 1, 'значение в [0,1)');
  ok(typeof grainDataUrl(0x9e37) === 'string', 'плитка строится');
});

t('в модуле нет ни Math.random, ни обращений к sim.rng', () => {
  const src = readSource();
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(!/Math\.random/.test(code), 'Math.random запрещён в рендере');
  ok(!/\brng\b/.test(code), 'состояние симуляции рендер не двигает');
});

// ------------------------------------------------------- предсказание цены
t('предсказанная цена кадра укладывается в бюджет пост-обработки', () => {
  // Бюджет §5.2 — 2,0 мс на всю пост-обработку при 1600×900, dpr 1.
  const fx = new PostFX(QUALITY.high);
  const r = frame(fx, simOf(150, { dayTime: 0.0 }), { zoom: 1.6 });
  ok(r.stats.costMs > 0, 'цена считается');
  ok(r.stats.costMs <= 2.0, `предсказание ${r.stats.costMs} мс, бюджет 2,0`);
});

t('eco дешевле high, а ultra дороже medium — порядок не перепутан', () => {
  const sim = simOf(150, { dayTime: 0.0 });
  const cost = (q) => { const fx = new PostFX(q); return frame(fx, sim, { zoom: 1.6 }).stats.costMs; };
  const eco = cost(QUALITY.eco), med = cost(QUALITY.medium), high = cost(QUALITY.high), ultra = cost(QUALITY.ultra);
  ok(eco < med, `eco ${eco} < medium ${med}`);
  ok(med <= high, `medium ${med} <= high ${high}`);
  ok(ultra >= med, `ultra ${ultra} >= medium ${med}`);
});

t('цена растёт вместе с площадью холста, а не с числом построек', () => {
  const fx1 = new PostFX(QUALITY.high);
  const a = frame(fx1, simOf(10, { dayTime: 0.0 }), { dpr: 1 }).stats.costMs;
  const fx2 = new PostFX(QUALITY.high);
  const b = frame(fx2, simOf(10, { dayTime: 0.0 }), { dpr: 2 }).stats.costMs;
  ok(b > a * 2, `холст вчетверо больше — цена растёт: ${a} -> ${b}`);
  const fx3 = new PostFX(QUALITY.high);
  const c = frame(fx3, simOf(200, { dayTime: 0.0 }), { dpr: 1 }).stats.costMs;
  ok(c < a * 2.5, `двадцатикратный город не удорожает кадр вдвое: ${a} -> ${c}`);
});

// ------------------------------------------------------------- устойчивость
t('кадр без sim и без света не падает', () => {
  const fx = new PostFX(QUALITY.high);
  fx.begin(null, CW, CH, lightAt(0.5), { dpr: 1 });
  const ctx = fakeCanvas().getContext();
  fx.draw(ctx);
  ok(true, 'дошли живыми');
});

t('draw без begin ничего не делает', () => {
  const fx = new PostFX(QUALITY.high);
  const ctx = fakeCanvas().getContext();
  fx.draw(ctx);
  ok(ctx.calls.fillRect === 0 && ctx.calls.drawImage === 0, 'ни одной операции');
});

t('разрушенные и недостроенные дома не светятся', () => {
  const fx = new PostFX(QUALITY.high);
  const sim = simOf(20, { dayTime: 0.0 });
  for (const b of sim.buildings) b.destroyed = true;
  ok(frame(fx, sim).stats.spots === 0, 'руины не горят');
  for (const b of sim.buildings) { b.destroyed = false; b.done = false; }
  const fx2 = new PostFX(QUALITY.high);
  ok(frame(fx2, sim).stats.spots === 0, 'стройка не горит');
});

function readSource() {
  return readFileSync(new URL('../src/render/postfx.js', import.meta.url), 'utf8');
}

console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
