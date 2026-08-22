// Тесты слоя всплывающих чисел (app/src/render/notifications.js).
// Запуск: node app/tests/test-notifications.mjs
//
// Канваса в node нет, поэтому здесь подставной document — тот же приём, что в
// test-icons.mjs / test-minimap.mjs / test-select.mjs: контекст отдаёт те же
// методы, что настоящий 2D, но ничего не рисует и только считает вызовы. Так
// проверяется главное — ЧТО слой принимает, КОГО выталкивает при переполнении,
// СКОЛЬКО кладёт в кадр и сколько раз печёт одну и ту же строку. Как выглядят
// пиксели, проверит глаз главного разработчика.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const noop = () => {};
function fakeCtx(cv) {
  return {
    canvas: cv,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    miterLimit: 10, textAlign: '', textBaseline: '', globalAlpha: 1,
    calls: { drawImage: 0, fillText: 0, strokeText: 0, fill: 0, stroke: 0 },
    images: [],
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, rect: noop,
    arc: noop, arcTo: noop, bezierCurveTo: noop,
    fill() { this.calls.fill++; },
    stroke() { this.calls.stroke++; },
    fillText() { this.calls.fillText++; },
    strokeText() { this.calls.strokeText++; },
    // Ширина «как в шрифте»: 0.62 кегля на литеру — та же оценка, что стоит в
    // запасном пути самого модуля, поэтому размеры карточек предсказуемы.
    measureText(s) { const px = parseFloat((this.font.match(/(\d+(?:\.\d+)?)px/) || [0, 10])[1]); return { width: s.length * px * 0.62 }; },
    drawImage(img, ...a) { this.calls.drawImage++; this.images.push(a); },
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
  Notifications, KINDS, DEFAULT_KIND, MAX_LIVE, BAKES_PER_FRAME,
  MIN_PX, MAX_PX, MAX_CHARS,
  kindOf, prioOf, pxFor, minZoomFor, capFor, bakePxFor, cacheCapsFor,
  easeRise, alphaOf, cacheKey, normText, victimIndex,
} = await import('../src/render/notifications.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || ''} ждали ${b}, получили ${a}`); };
const near = (a, b, e, m) => { if (Math.abs(a - b) > e) throw new Error(`${m || ''} ждали ~${b}, получили ${a}`); };
const ok = (v, m) => { if (!v) throw new Error(m || 'ложь'); };

const sim = { world: { w: 96, h: 96, seed: 20250808 } };
// Кадр «как в renderer»: z = TILE_PX * zoom, ox/oy — смещение камеры.
const FRAME = { ox: 0, oy: 0, z: 32, cw: 1600, ch: 900 };
const drawOnce = (n, ctx, dt = 0.016, f = FRAME) => n.draw(sim, ctx, f.ox, f.oy, f.z, f.cw, f.ch, dt);

// ---------------------------------------------------------------------------
// 1. Таблица видов и приоритеты
t('смерть важнее боя, бой важнее прибавки дерева', () => {
  ok(prioOf('death') > prioOf('combat'), 'смерть > бой');
  ok(prioOf('combat') > prioOf('gain'), 'бой > прибавка');
  ok(prioOf('full') > prioOf('gain'), 'полный склад > прибавка');
});

t('неизвестный вид сворачивается к info и не роняет кадр', () => {
  eq(kindOf('нет такого'), KINDS[DEFAULT_KIND]);
  eq(prioOf(undefined), KINDS.info.prio);
});

t('у каждого вида задана жизнь около полутора секунд', () => {
  for (const [id, k] of Object.entries(KINDS)) {
    ok(k.life >= 1.5 && k.life <= 2.5, `${id}: жизнь ${k.life} вне разумных границ`);
  }
  eq(KINDS.gain.life, 1.5, 'прибавка живёт ровно полторы секунды:');
});

// ---------------------------------------------------------------------------
// 2. Чистая арифметика жизни
t('подъём монотонен, стартует быстро и выдыхается', () => {
  eq(easeRise(0), 0);
  eq(easeRise(1), 1);
  ok(easeRise(0.33) > 0.5, 'на первой трети пройдено больше половины пути');
  for (let k = 0; k < 1; k += 0.05) ok(easeRise(k + 0.05) >= easeRise(k), 'подъём не должен идти вниз');
});

t('прозрачность: вспышка, плато, растворение', () => {
  eq(alphaOf(0), 0);
  near(alphaOf(0.08), 1, 1e-9, 'к 8% жизни надпись полностью видна:');
  eq(alphaOf(0.3), 1);
  ok(alphaOf(0.8) < 1 && alphaOf(0.8) > 0, 'к 80% жизни надпись гаснет, но ещё видна');
  near(alphaOf(1), 0, 1e-9, 'в конце жизни:');
});

t('кегль зажат с двух сторон', () => {
  eq(pxFor(1), MIN_PX, 'дальний план не мельче нижней границы:');
  eq(pxFor(1000), MAX_PX, 'ближний план не крупнее верхней границы:');
  // Довод pxFor — это РАЗМЕР ТАЙЛА В ПИКСЕЛЯХ (TILE_PX 32 × zoom), а не сам
  // зум. Зум зажат в [0.4, 3.0] (main.js), значит довод ходит по [12.8, 96].
  // Проверка сидела на 96 — это самый ближний план, и там кегль ПО ЗАМЫСЛУ
  // упёрт в верхнюю границу: шапка модуля прямо говорит, что 26 px — предел,
  // выше которого надпись спорит с постройкой, «тайл на зуме 3 — это 96 px».
  // Свойство «между границами кегль растёт» верное, но мерить его надо там,
  // где границы ещё не сомкнулись: полоса свободного роста — z от 28.6 до 61.9,
  // то есть зум примерно от 0.9 до 1.9. Берём середину — зум 1.5.
  ok(pxFor(48) > MIN_PX && pxFor(48) < MAX_PX, 'между границами кегль растёт с зумом');
  ok(pxFor(56) > pxFor(40), 'внутри полосы кегль именно растёт, а не стоит');
});

t('длинная строка обрезается, мусор превращается в строку', () => {
  eq(normText(null), '');
  eq(normText(42), '42');
  eq(normText('x'.repeat(80)).length, MAX_CHARS);
});

t('ключ кэша различает вид, цвет и текст', () => {
  ok(cacheKey('combat', '−2', '#c8412f') !== cacheKey('loss', '−2', '#dd7a1e'), 'вид входит в ключ');
  ok(cacheKey('gain', '+1🪵', '#a') !== cacheKey('gain', '+1🪵', '#b'), 'цвет входит в ключ');
  eq(cacheKey('gain', '+3🪵', '#8ec96f'), cacheKey('gain', '+3🪵', '#8ec96f'), 'одинаковые дают один ключ:');
});

// ---------------------------------------------------------------------------
// 3. Пресеты
t('потолок в кадре растёт с детализацией и не превышает очередь', () => {
  eq(capFor(QUALITY.eco), 12);
  eq(capFor(QUALITY.medium), 16);
  eq(capFor(QUALITY.high), 20);
  eq(capFor(QUALITY.ultra), 20);
  for (const q of Object.values(QUALITY)) ok(capFor(q) <= MAX_LIVE, 'в кадре не больше, чем в очереди');
});

t('минимальный зум мягче, чем у жителей: сообщение важнее украшения', () => {
  for (const q of Object.values(QUALITY)) {
    ok(minZoomFor(q) < q.lod.peopleMinZoom, `${q.id}: всплывашки должны переживать жителей`);
    ok(minZoomFor(q) > 0.2, `${q.id}: но не до состояния сыпи на общем плане`);
  }
  ok(minZoomFor(QUALITY.ultra) < minZoomFor(QUALITY.eco), 'ультра показывает дальше, чем эко');
});

t('кегль выпечки следует за плотностью холста пресета', () => {
  eq(bakePxFor(QUALITY.eco), MAX_PX);              // dprCap 1
  eq(bakePxFor(QUALITY.high), MAX_PX * 2);         // dprCap 2
  ok(bakePxFor(QUALITY.medium) > bakePxFor(QUALITY.eco), 'medium печёт крупнее eco');
});

t('потолки кэша — доля спрайтового бюджета, а не отдельная выдумка', () => {
  const eco = cacheCapsFor(QUALITY.eco), ultra = cacheCapsFor(QUALITY.ultra);
  ok(ultra.maxBytes > eco.maxBytes, 'ультре можно больше');
  eq(eco.maxEntries, QUALITY.eco.caps.spriteEntries);
  ok(eco.maxBytes < QUALITY.eco.caps.spriteMB * 1024 * 1024, 'надписи не отбирают память у зданий');
});

// ---------------------------------------------------------------------------
// 4. Очередь и вытеснение
t('push принимает событие и отдаёт true', () => {
  const n = new Notifications(QUALITY.high);
  eq(n.push({ x: 10, y: 10, text: '+3🪵', kind: 'gain' }), true);
  eq(n.live.length, 1);
});

t('битые координаты отбрасываются молча', () => {
  const n = new Notifications(QUALITY.high);
  eq(n.push({ x: NaN, y: 1, text: 'x', kind: 'gain' }), false);
  eq(n.push({ x: 1, y: undefined, text: 'x', kind: 'gain' }), false);
  eq(n.push(null), false);
  eq(n.live.length, 0);
});

t('очередь не длиннее двадцати', () => {
  const n = new Notifications(QUALITY.high);
  for (let i = 0; i < 60; i++) n.push({ x: i, y: 0, text: '+1🪵', kind: 'gain' });
  eq(n.live.length, MAX_LIVE);
});

t('смерть вытесняет прибавку дерева, прибавка смерть — нет', () => {
  const n = new Notifications(QUALITY.high);
  for (let i = 0; i < MAX_LIVE; i++) n.push({ x: i, y: 0, text: '+1🪵', kind: 'gain' });
  eq(n.push({ x: 5, y: 5, text: '', kind: 'death' }), true, 'смерть обязана влезть:');
  eq(n.live.length, MAX_LIVE);
  eq(n.live.filter(p => p.kind === 'death').length, 1);

  const m = new Notifications(QUALITY.high);
  for (let i = 0; i < MAX_LIVE; i++) m.push({ x: i, y: 0, text: '', kind: 'death' });
  eq(m.push({ x: 5, y: 5, text: '+1🪵', kind: 'gain' }), false, 'прибавка не смеет вытолкнуть смерть:');
  eq(m.live.filter(p => p.kind === 'death').length, MAX_LIVE);
  eq(m.dropped, 1);
});

t('при равном виде выталкивается тот, кому меньше осталось жить', () => {
  const live = [
    { kind: 'gain', prio: 20, t: 1.4, life: 1.5 },   // почти умер
    { kind: 'gain', prio: 20, t: 0.1, life: 1.5 },
  ];
  eq(victimIndex(live, 100), 0);
  eq(victimIndex(live, 20), -1, 'равный приоритет никого не выталкивает:');
});

t('одинаковые события над одним местом встают стопкой, но не выше трёх', () => {
  const n = new Notifications(QUALITY.high);
  for (let i = 0; i < 6; i++) n.push({ x: 10, y: 10, text: '+1🪵', kind: 'gain' });
  eq(Math.max(...n.live.map(p => p.stack)), 3);
  // Соседнее место — своя стопка с нуля.
  n.push({ x: 40, y: 40, text: '+1🪵', kind: 'gain' });
  eq(n.live[n.live.length - 1].stack, 0);
});

// ---------------------------------------------------------------------------
// 5. Старение
t('всплывашка умирает по своему сроку и возвращается в пул', () => {
  const n = new Notifications(QUALITY.high);
  n.push({ x: 1, y: 1, text: '+1🪵', kind: 'gain' });
  const freeBefore = n.free.length;
  for (let i = 0; i < 20; i++) n.update(0.1);       // 2 с > 1.5 с
  eq(n.live.length, 0);
  eq(n.free.length, freeBefore + 1, 'объект вернулся в пул:');
});

t('гигантский dt (свёрнутая вкладка) не съедает очередь одним махом', () => {
  const n = new Notifications(QUALITY.high);
  n.push({ x: 1, y: 1, text: '', kind: 'death' });
  n.update(60);
  eq(n.live.length, 1, 'один кадр не может состарить надпись больше чем на четверть секунды:');
  near(n.live[0].t, 0.25, 1e-9);
});

t('clear() убирает всё, но кэш карточек остаётся', () => {
  const n = new Notifications(QUALITY.high);
  const ctx = fakeCtx(fakeCanvas());
  n.push({ x: 1, y: 1, text: '+3🪵', kind: 'gain' });
  drawOnce(n, ctx);
  const cached = n.cache.size;
  ok(cached > 0, 'карточка испеклась');
  n.clear();
  eq(n.live.length, 0);
  eq(n.cache.size, cached, 'кэш строк переживает новую игру:');
});

t('setQuality сбрасывает кэш: кегль выпечки зависит от пресета', () => {
  const n = new Notifications(QUALITY.eco);
  const ctx = fakeCtx(fakeCanvas());
  n.push({ x: 1, y: 1, text: '+3🪵', kind: 'gain' });
  drawOnce(n, ctx);
  ok(n.cache.size > 0);
  n.setQuality(QUALITY.ultra);
  eq(n.cache.size, 0);
});

// ---------------------------------------------------------------------------
// 6. Кадр
t('пустая очередь не делает ни одного блита', () => {
  const n = new Notifications(QUALITY.high);
  const ctx = fakeCtx(fakeCanvas());
  drawOnce(n, ctx);
  eq(ctx.calls.drawImage, 0);
});

t('дальний план молчит', () => {
  const n = new Notifications(QUALITY.high);
  const ctx = fakeCtx(fakeCanvas());
  n.push({ x: 10, y: 10, text: '+3🪵', kind: 'gain' });
  // zoom = z/32; берём заведомо ниже порога high (0.42)
  n.draw(sim, ctx, 0, 0, 32 * 0.3, 1600, 900, 0.016);
  eq(ctx.calls.drawImage, 0);
  eq(n.drawn, 0);
});

t('в кадре не больше потолка пресета', () => {
  const n = new Notifications(QUALITY.eco);
  const ctx = fakeCtx(fakeCanvas());
  for (let i = 0; i < MAX_LIVE; i++) n.push({ x: 5 + i * 0.7, y: 5, text: '', kind: 'death' });
  // Все строки одинаковые (пустые) — карточка одна, лимит выпечек не мешает.
  drawOnce(n, ctx);
  eq(n.live.length, MAX_LIVE);
  eq(n.drawn, capFor(QUALITY.eco));
  eq(ctx.calls.drawImage, capFor(QUALITY.eco));
});

t('за кадром режется не важное, а неважное', () => {
  const n = new Notifications(QUALITY.eco);   // потолок 12
  const ctx = fakeCtx(fakeCanvas());
  for (let i = 0; i < 15; i++) n.push({ x: 5 + i, y: 5, text: '', kind: 'gain' });
  n.push({ x: 30, y: 5, text: '', kind: 'death' });
  drawOnce(n, ctx);
  eq(n.drawn, 12);
  // Смерть рисуется последней — то есть поверх всех и уж точно не отсечена.
  ok(n.order[n.order.length - 1].kind === 'death', 'смерть выводится последней, поверх остальных');
});

t('одна строка печётся один раз, дальше только блиты', () => {
  const n = new Notifications(QUALITY.high);
  const ctx = fakeCtx(fakeCanvas());
  for (let i = 0; i < 8; i++) n.push({ x: i * 2, y: 3, text: '+3🪵', kind: 'gain' });
  drawOnce(n, ctx);
  drawOnce(n, ctx);
  eq(n.bakes, 1, 'восемь одинаковых надписей — одна выпечка:');
  eq(n.cache.size, 1);
  ok(ctx.calls.drawImage >= 8, 'но блиты честно на каждую');
});

t('залп новых строк не печётся весь в одном кадре', () => {
  const n = new Notifications(QUALITY.high);
  const ctx = fakeCtx(fakeCanvas());
  for (let i = 0; i < 9; i++) n.push({ x: i * 2, y: 3, text: '+' + i + '🪵', kind: 'gain' });
  drawOnce(n, ctx);
  eq(n.bakes, BAKES_PER_FRAME, 'за первый кадр не больше двух выпечек:');
  drawOnce(n, ctx);
  eq(n.bakes, BAKES_PER_FRAME * 2);
});

t('надпись поднимается и в мировых координатах держится за своё место', () => {
  const n = new Notifications(QUALITY.high);
  const ctx = fakeCtx(fakeCanvas());
  n.push({ x: 10, y: 10, text: '', kind: 'death' });
  drawOnce(n, ctx, 0.016);
  const first = ctx.images[ctx.images.length - 1];
  for (let i = 0; i < 20; i++) drawOnce(n, ctx, 0.02);
  const later = ctx.images[ctx.images.length - 1];
  ok(later[1] < first[1], 'за 0,4 с надпись обязана подняться');
  // Панорама на 100 px вправо сдвигает надпись ровно на 100 px.
  const before = ctx.images[ctx.images.length - 1][0];
  n.draw(sim, ctx, 100, 0, 32, 1600, 900, 0);
  eq(ctx.images[ctx.images.length - 1][0], before + 100, 'надпись едет вместе с камерой:');
});

t('up поднимает надпись над высокой крышей', () => {
  const a = new Notifications(QUALITY.high), b = new Notifications(QUALITY.high);
  const ca = fakeCtx(fakeCanvas()), cb = fakeCtx(fakeCanvas());
  a.push({ x: 10, y: 10, text: '', kind: 'full' });
  b.push({ x: 10, y: 10, text: '', kind: 'full', up: 3 });
  drawOnce(a, ca); drawOnce(b, cb);
  eq(cb.images[0][1], ca.images[0][1] - 3 * 32, 'три клетки вверх — это 96 px при z=32:');
});

t('слой детерминирован: один сид — одна картинка', () => {
  const run = () => {
    const n = new Notifications(QUALITY.high);
    const ctx = fakeCtx(fakeCanvas());
    for (let i = 0; i < 5; i++) n.push({ x: 10, y: 10, text: '', kind: 'gain' });
    drawOnce(n, ctx, 0.016);
    return JSON.stringify(ctx.images);
  };
  eq(run(), run(), 'две одинаковые партии обязаны совпасть по пикселям:');
});

t('соседние надписи над одним местом не ложатся пиксель в пиксель', () => {
  const n = new Notifications(QUALITY.high);
  const ctx = fakeCtx(fakeCanvas());
  for (let i = 0; i < 4; i++) n.push({ x: 10, y: 10, text: '', kind: 'gain' });
  drawOnce(n, ctx, 0.016);
  const xs = new Set(ctx.images.map(a => a[0]));
  ok(xs.size > 1, 'разброс вбок обязан их развести');
});

t('слой не пишет в симуляцию и не трогает её поля', () => {
  const n = new Notifications(QUALITY.high);
  const ctx = fakeCtx(fakeCanvas());
  const snapshot = JSON.stringify(sim);
  n.push({ x: 1, y: 1, text: '+1🪵', kind: 'gain' });
  drawOnce(n, ctx);
  eq(JSON.stringify(sim), snapshot);
});

t('enabled=false выключает слой целиком', () => {
  const n = new Notifications(QUALITY.high);
  const ctx = fakeCtx(fakeCanvas());
  n.enabled = false;
  eq(n.push({ x: 1, y: 1, text: '+1🪵', kind: 'gain' }), false);
  drawOnce(n, ctx);
  eq(ctx.calls.drawImage, 0);
});

t('stats() отдаёт то, чем можно мерить слой', () => {
  const n = new Notifications(QUALITY.high);
  const ctx = fakeCtx(fakeCanvas());
  n.push({ x: 1, y: 1, text: '+1🪵', kind: 'gain' });
  drawOnce(n, ctx);
  const s = n.stats();
  eq(s.live, 1); eq(s.drawn, 1); eq(s.cached, 1); eq(s.bakes, 1);
  ok(s.bytes > 0, 'кэш занимает честные байты');
});

// ---------------------------------------------------------------------------
// 7. Правила проекта — по исходнику
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/render/notifications.js'), 'utf8');
// Комментарии вырезаем: в них разрешено ссылаться на запрещённые имена
// («Math.random запрещён»), и проверка по сырому тексту ловила бы собственную
// документацию.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

t('в файле нет Math.random и нет обращения к sim.rng', () => {
  ok(!/Math\.random/.test(CODE), 'Math.random запрещён');
  ok(!/\brng\b/.test(CODE), 'sim.rng рендеру трогать нельзя');
});

t('в кадре нет текста, фильтров и градиентов — всё это только в выпечке', () => {
  const draw = CODE.slice(CODE.indexOf('  draw(sim, ctx'), CODE.indexOf('  _bake(p)'));
  ok(draw.length > 200, 'тело draw() найдено');
  ok(!/fillText|strokeText|measureText/.test(draw), 'раскладка текста в кадре запрещена');
  ok(!/\.filter\s*=/.test(draw), 'ctx.filter в кадре запрещён');
  ok(!/createRadialGradient|createLinearGradient/.test(draw), 'градиенты только в выпечке');
  ok(!/document\./.test(draw), 'канвасы в кадре не создаются');
});

t('слой не присваивает ничего в sim', () => {
  ok(!/\bsim\.[a-zA-Z_.]+\s*=[^=]/.test(CODE), 'присваиваний в sim нет');
});

t('в файле есть блок подключения с якорями', () => {
  ok(/ПОДКЛЮЧЕНИЕ/.test(SRC), 'блок подключения на месте');
  ok(/import \{ IconLayer \} from '\.\/icons\.js';/.test(SRC), 'якорь импорта записан дословно');
});

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
