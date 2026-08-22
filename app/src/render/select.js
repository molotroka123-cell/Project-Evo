// render/select.js — выделение и наведение: кольцо под постройкой, подсветка
// клетки под курсором, обводка силуэта жителя, след его пути и рамка зоны
// действия у построек с аурой.
//
// ЗАЧЕМ. Сейчас игрок не получает от картинки НИКАКОЙ обратной связи на
// указатель: он ведёт мышь над городом, и город никак не отвечает. Единственное
// подтверждение того, что игра вообще заметила клик, — карточка здания в HUD,
// которая открывается по долгому тапу или по клику мышью и закрывает собой пол-
// экрана. Из-за этого:
//   • невозможно понять, ЧТО именно откроется по клику — дом или сосед, если
//     они стоят вплотную (а на зуме 0.6 клетка — 19 px);
//   • нельзя ткнуть в жителя вообще: у него нет ни хит-теста, ни подсветки;
//   • аура кузницы и мельницы («+10% соседям в радиусе 2») существует только
//     текстом в описании — игрок ставит ферму на глаз и не знает, попал он в
//     радиус мельницы или промахнулся на клетку;
//   • житель, идущий через пол-карты, выглядит как броуновская частица: куда
//     он идёт и зачем — не видно.
// Этот слой закрывает всё перечисленное, ничего не меняя ни в ядре, ни в
// соседних слоях рендера.
//
// ГРАНИЦЫ. Модуль — чистое представление. Он ЧИТАЕТ симуляцию (sim.buildings,
// sim.villagers, sim.world.seed) и не пишет в неё ни одного поля; он не держит
// ссылок на renderer и не лезет в его кэши. Состояние наведения и выбора живёт
// здесь, а не в sim, — намеренно: это состояние ИНТЕРФЕЙСА конкретного игрока,
// оно не должно попадать в сейв и не должно существовать в headless-прогоне
// ядра под node. Импорт файла не имеет побочных эффектов: до первого кадра не
// печётся ни одного канваса.
//
// СЛУЧАЙНОСТЬ. Math.random в проекте запрещён, sim.rng рендеру трогать нельзя
// (рендер идёт с разной частотой у разных игроков, и каждый его вызов сдвинул
// бы состояние симуляции — сейв бы поплыл). Пульсация здесь — функция ВРЕМЕНИ
// кадра. Единственное, что нужно «вразнобой», — фаза этой пульсации: два
// кольца и десяток дуг, мигающих строго в такт, читаются как неисправность
// экрана. Фаза берётся детерминированным хешем от sim.world.seed и координат
// объекта (phaseOf ниже) — ровно тем же приёмом, что в water.js/relief.js.
//
// ЦЕНА КАДРА. Порядок 0,1 мс на high и НОЛЬ, когда ничего не наведено и не
// выбрано (обычное состояние: игрок водит мышью считанные секунды за партию).
// Худший случай — наведение на одну постройку с аурой + выбранная другая с
// аурой + выбранный житель в пути:
//   2 блита кольца (готовая выпечка, ~140×70 на экране)      ~0,03 мс
//   1 обводка клетки (strokeRect + fillRect)                 ~0,01 мс
//   2 блита мягкого диска ауры + 2 пунктирные дуги           ~0,05 мс
//   обводка силуэта: 4 (на ultra 8) блита спрайта 24×36      ~0,03 мс
//   след пути: одна пунктирная линия + маркер цели           ~0,02 мс
//                                                     итого ~0,14 мс
// Держится тремя правилами, теми же, что у shadows.js и fx.js:
//   1) Ни одного createRadialGradient и ни одного ctx.filter В КАДРЕ. Мягкость
//      кольца и диска ауры выпечена в offscreen ОДИН раз за пресет (три канваса
//      128×128 ≈ 196 КБ суммарно); в кадре остаётся drawImage.
//   2) Ни одной полноэкранной заливки — самый дорогой вид работы на слабом
//      растеризаторе (docs/visual-performance-budget.md §5.4).
//   3) Жёсткий потолок объектов: колец максимум два, аур — SELECT_LIMITS.auras,
//      обводка ровно одна (выбранный житель) плюс одна на наведении.
// Наивная реализация («нарисуем эллипс с градиентом и тенью прямо в кадре, а
// обводку сделаем через ctx.filter: drop-shadow») стоила бы на порядок дороже:
// именно filter='blur()' в своё время ронял 60 FPS до девяти (docs/graphics-
// audit.md §1), а createRadialGradient на каждое кольцо — это заново собранная
// таблица интерполяции 128 раз в секунду ради картинки, которая не меняется.
//
// ПОЧЕМУ КОЛЬЦО — ЭЛЛИПС, А РАМКА АУРЫ — ЧЕСТНЫЙ КРУГ. Это разные сущности.
// Кольцо — декорация: оно изображает световое пятно, ЛЕЖАЩЕЕ на земле, а земля
// показана сверху под наклоном, поэтому круг на ней проецируется в эллипс
// (FLAT = 0.5 — сплющен ровно вдвое, как договорено в задаче; для сравнения,
// контактные тени в renderer/shadows берут 0.33 — они изображают пятно у самой
// подошвы, оно ближе к горизонту). Рамка ауры — не декорация, а ИЗОБРАЖЕНИЕ
// ПРАВИЛА: в simulation.js аура мельницы проверяется как
// Math.hypot(m.x - b.x, m.y - b.y) <= radius, то есть зона — настоящий круг в
// координатах клеток. Сплющить её значило бы соврать игроку: постройка на две
// клетки ниже оказалась бы «снаружи» нарисованной рамки, оставаясь внутри
// правила. Поэтому аура рисуется кругом и без всякого FLAT.
import { BUILDINGS } from '../core/data.js';
import { lodForZoom, prune, canvasBytes } from './quality.js';
import { hash2 } from './palette.js';

// Мировая единица «тайл → экран» при zoom = 1. Та же константа, что в
// renderer.js, shadows.js и vegetation.js: нужна, чтобы перевести пришедший z
// обратно в зум и сверить его с порогами пресета.
const TILE_PX = 32;

// Потолки — именно потолки, а не цели (тот же смысл, что в SHADOW_LIMITS).
export const SELECT_LIMITS = {
  auras: 8,        // рамок ауры в кадре; штатно их 1-2, потолок нужен для showAllAuras
  ringMB: 1,       // память под выпеченные кольца и диск; фактически ~0,2 МБ
  pickR: 0.45,     // радиус попадания по жителю, в клетках (см. pick)
  minZoomPx: 6,    // ниже 6 px на клетку слой молчит: рисовать нечего и незачем
};

// Цвета. Наведение — холодный белый, выбор — янтарный, аура — бирюзовый.
// Зелёный и красный заняты призраком стройки (renderer.draw) и маркером рейда;
// брать их сюда нельзя — игрок читает цвет раньше формы и решит, что здание
// нельзя поставить или что на него идёт набег.
const COL = {
  hover: '236,242,255',
  pick: '255,198,92',
  aura: '125,227,255',
};

// Период пульсации, с. Наведение живёт доли секунды, ему нужен быстрый отклик;
// выделение висит на экране минутами, и частое мигание там раздражает —
// отсюда почти вдвое более спокойный такт. Аура ещё медленнее: это фон.
const PULSE = { hover: 1.15, pick: 1.9, aura: 2.6 };

// Во сколько раз кольцо сплющено по вертикали. См. большой комментарий выше.
const FLAT = 0.5;

// Разрешение выпечки кольца. 128 — не «на глаз»: кольцо под постройкой на
// зуме 3 занимает ~190 px по ширине, то есть выпечка растягивается меньше чем
// в полтора раза, а мягкий градиент такое растяжение прощает (в отличие от
// резкой границы). На eco берём 64: там кольцо крупнее 90 px не бывает.
const RING_PX = [64, 128, 128];

// ---------------------------------------------------------------------------
// Детерминированная фаза пульсации.
//
// hash2 из palette.js — тот же целочисленный хеш, которым выпекаются пятна
// травы и облака: одинаковый мир даёт одинаковую картинку, и ни один вызов не
// трогает sim.rng. Сид мира подмешивается сдвигом координат, а не xor'ом с
// результатом: hash2 плохо перемешивает старшие биты аргументов, и xor по
// готовому числу дал бы соседним объектам почти одинаковую фазу.
function phaseOf(seed, x, y) {
  return hash2((x | 0) + (seed & 1023), (y | 0) - ((seed >> 10) & 1023));
}

// Канвас для выпечки. В браузере это document.createElement, под node (тест,
// headless-прогон) — OffscreenCanvas, если он есть; если нет ни того ни
// другого, вернём null, и слой просто промолчит вместо падения.
function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    return cv;
  }
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  return null;
}

export class SelectLayer {
  constructor(quality) {
    this.q = quality;
    this.enabled = true;
    // Показывать ауры ВСЕХ построек сразу, а не только наведённой/выбранной.
    // По умолчанию выключено: полтора десятка бирюзовых кругов поверх города —
    // это не подсказка, а каша. Держится как переключатель для режима «где
    // ставить ферму»: renderer.select.showAllAuras = true.
    this.showAllAuras = false;

    this.time = 0;
    this.hover = null;   // {kind:'b'|'v'|'t', b, v, tx, ty}
    this.sel = null;

    // Выпечка: ключ → канвас. Записей всегда 3-4 (кольцо каждого цвета + диск),
    // Map нужна не ради объёма, а ради общего с остальным рендером механизма
    // вытеснения prune() — чтобы этот кэш не оказался единственным, который
    // никто не чистит при смене пресета.
    this.bakes = new Map();
    // Силуэты жителя: sheet.cv → массив на 16 сочетаний (4 кадра × 4 направления).
    // WeakMap намеренно: лист спрайтов умирает при смене пресета или эпохи, и
    // силуэты должны уйти вместе с ним, а не пережить его в обычной Map.
    this.sils = new WeakMap();

    this.seed = 0;
    this.stat = { rings: 0, auras: 0, outlines: 0, bakes: 0 };
  }

  setQuality(q) {
    this.q = q;
    // Выпечка привязана к разрешению пресета (RING_PX по detail), а силуэты —
    // к листам people.js, которые пресет пересоздаёт. Оставить старое —
    // получить мыло на ultra и лишнюю память на eco.
    this.bakes.clear();
    this.sils = new WeakMap();
    this.stat.bakes = 0;
  }

  // -------------------------------------------------------------------------
  // ВВОД. Три метода, которые дёргает main.js. Все берут МИРОВЫЕ координаты
  // (renderer.screenToWorld), потому что слой ничего не знает про камеру.

  // Кто находится под точкой (wx, wy). Житель выигрывает у здания намеренно:
  // он на порядок мельче, и при обратном приоритете жителя, стоящего на клетке
  // своего дома (а он там стоит почти всегда), нельзя было бы ткнуть вообще.
  pick(sim, wx, wy) {
    const tx = Math.floor(wx), ty = Math.floor(wy);
    let best = null;
    let bestD = SELECT_LIMITS.pickR * SELECT_LIMITS.pickR;
    const vs = (sim && sim.villagers) || [];
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      if (v.hp <= 0) continue;
      // Целимся в корпус, а не в точку под ногами: фигура ростом 0.34 клетки
      // рисуется ВВЕРХ от (v.x, v.y), её середина на 0.17 клетки выше. Без
      // этой поправки указатель «промахивался» по видимому человечку вниз.
      const dx = v.x - wx, dy = (v.y - 0.17) - wy;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = v; }
    }
    if (best) return { kind: 'v', b: null, v: best, tx, ty };
    const b = sim && sim.buildingAt ? sim.buildingAt(tx, ty) : null;
    // Для постройки запоминаем её собственный угол, а не клетку под курсором:
    // подсветка должна лечь на всё пятно застройки (b.size), а не на ту клетку
    // размером 2×2 Шпиля, по которой случайно попал указатель.
    if (b) return { kind: 'b', b, v: null, tx: b.x, ty: b.y };
    return { kind: 't', b: null, v: null, tx, ty };
  }

  hoverAt(sim, wx, wy) { this.hover = this.pick(sim, wx, wy); return this.hover; }
  clearHover() { this.hover = null; }

  // Клик. Повторный клик по уже выбранному объекту снимает выбор — иначе от
  // подсветки нельзя избавиться, не открыв меню.
  selectAt(sim, wx, wy) {
    const p = this.pick(sim, wx, wy);
    const s = this.sel;
    if (p.kind === 't') { this.sel = null; return null; }
    if (s && ((p.b && s.b === p.b) || (p.v && s.v === p.v))) { this.sel = null; return null; }
    this.sel = p;
    return p;
  }

  select(p) { this.sel = p || null; return this.sel; }
  clear() { this.sel = null; this.hover = null; }
  get selection() { return this.sel; }

  // Объект мог исчезнуть между кадрами: дом снесли рейдом, житель умер, игрок
  // начал новую партию. Проверка стоит два сравнения, а её отсутствие — это
  // кольцо, висящее над пустым местом до следующего клика.
  validate(sim) {
    if (this.hover && !alive(this.hover, sim)) this.hover = null;
    if (this.sel && !alive(this.sel, sim)) this.sel = null;
  }

  // -------------------------------------------------------------------------
  // КАДР, ЧАСТЬ 1 — всё, что лежит НА ЗЕМЛЕ и обязано уйти под спрайты:
  // кольца, подсветка клетки, рамки ауры. Вызывается перед Y-проходом.
  drawGround(sim, ctx, ox, oy, z, cw, ch, dt) {
    // dt зажимаем: после переключения вкладки браузер отдаёт один кадр с dt в
    // несколько секунд, и пульсация прыгнула бы на случайную фазу.
    this.time += Math.min(0.1, Math.max(0, dt || 0));
    this.stat.rings = 0; this.stat.auras = 0; this.stat.outlines = 0;
    if (!this.enabled || z < SELECT_LIMITS.minZoomPx) return;
    this.seed = (sim && sim.world && (sim.world.seed | 0)) || 0;
    this.validate(sim);

    // Во время постановки здания курсором владеет призрак стройки (renderer
    // рисует его сам): вторая подсветка под ним читается как второй объект.
    const hov = sim && sim.placing ? null : this.hover;
    const sel = this.sel;
    if (!hov && !sel && !this.showAllAuras) return;

    const lod = lodForZoom(this.q, z / TILE_PX);

    if (hov) this.tileMark(ctx, ox, oy, z, cw, ch, hov);
    if (sel) this.markerFor(ctx, ox, oy, z, cw, ch, sel, 'pick', lod);
    // Наведение на уже выбранный объект второго кольца не рисует: два кольца
    // в одной точке дают грязный двойной контур, а не «ярче».
    if (hov && !sameTarget(hov, sel)) this.markerFor(ctx, ox, oy, z, cw, ch, hov, 'hover', lod);

    this.auras(sim, ctx, ox, oy, z, cw, ch, hov, sel);
  }

  // КАДР, ЧАСТЬ 2 — то, что должно лечь ПОВЕРХ сцены: след пути выбранного
  // жителя. Под спрайтами он бы прятался за домами ровно там, где интересен.
  drawTop(sim, ctx, ox, oy, z, cw, ch) {
    if (!this.enabled || z < SELECT_LIMITS.minZoomPx) return;
    const s = this.sel;
    if (!s || s.kind !== 'v') return;
    const v = s.v;
    const t = v.target;
    if (!t) return;
    if (this.q.detail === 0 && z < 14) return;  // на eco и дальнем зуме след не читается

    // Ядро ведёт жителя по прямой (world.stepToward), поэтому честный след —
    // отрезок до цели. Массив v.path у жителей сейчас всегда null, но он есть
    // в модели (и заполнен у отрядов армии), поэтому ломаная поддержана: когда
    // жителям добавят поиск пути, слой покажет настоящий маршрут без правок.
    const pts = [[v.x, v.y]];
    if (Array.isArray(v.path)) for (const p of v.path) pts.push([p.x + 0.5, p.y + 0.5]);
    pts.push([t.x + 0.5, t.y + 0.5]);

    // Отсечение по экрану делаем по габаритам ломаной: житель может идти к
    // цели за краем карты, и тогда рисовать нечего, но stroke всё равно стоил
    // бы полной длины линии.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      const sx = ox + p[0] * z, sy = oy + p[1] * z;
      if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
    }
    if (maxX < 0 || maxY < 0 || minX > cw || minY > ch) return;

    ctx.save();
    ctx.strokeStyle = `rgba(${COL.pick},0.75)`;
    ctx.lineWidth = Math.max(1.5, z * 0.055);
    ctx.lineCap = 'round';
    // Штрих пропорционален клетке: на зуме 0.5 фиксированные 8 px превратились
    // бы в сплошную линию, на зуме 3 — в редкие точки.
    const dash = Math.max(4, z * 0.28);
    ctx.setLineDash([dash, dash * 0.9]);
    // Бегущий пунктир — от времени кадра. Знак минус даёт движение ОТ жителя
    // К цели: направление читается без стрелок.
    ctx.lineDashOffset = this.q.detail === 0 ? 0 : -(this.time * z * 1.1) % 4096;
    ctx.beginPath();
    ctx.moveTo(ox + pts[0][0] * z, oy + pts[0][1] * z);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(ox + pts[i][0] * z, oy + pts[i][1] * z);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Маркер цели — то же выпеченное кольцо, только маленькое: игрок должен
    // видеть КЛЕТКУ назначения, а не «где-то там кончается линия».
    const end = pts[pts.length - 1];
    const ex = ox + end[0] * z, ey = oy + end[1] * z;
    if (ex > -z && ey > -z && ex < cw + z && ey < ch + z) {
      this.ring(ctx, ex, ey, Math.max(5, z * 0.34), 'pick', phaseOf(this.seed, t.x, t.y));
    }
  }

  // КАДР, ЧАСТЬ 3 — обводка силуэта жителя. Вызывается ИЗ Y-прохода
  // (renderer.drawVillager), потому что только там известны лист, кадр шага и
  // направление: своё состояние анимации слой заводить не имеет права —
  // оно разошлось бы с тем, что реально нарисовано, и обводка «поплыла» бы
  // относительно фигуры на кадр-два.
  villager(ctx, v, sheet, frame, dir, sx, sy, w, h) {
    if (!this.enabled || !sheet || !sheet.cv) return;
    const key = this.sel && this.sel.v === v ? 'pick'
      : this.hover && this.hover.v === v ? 'hover' : null;
    if (!key) return;
    // На eco обводим только выбранного: наведение там и так почти не работает
    // (пресет достаётся телефонам, где мыши нет).
    if (this.q.detail === 0 && key === 'hover') return;

    const sil = this.silhouette(sheet, frame, dir, key);
    if (!sil) return;

    // Толщина обводки в экранных пикселях. Меньше 1 px не бывает (иначе на
    // дальнем зуме обводка исчезает), больше 3 — уже не контур, а клякса.
    const d = Math.max(1, Math.min(3, Math.round(h * 0.07)));
    const dx = Math.round(sx - w / 2), dy = Math.round(sy - h * 0.955);
    const dw = Math.round(w), dh = Math.round(h);

    // Четыре смещения по осям дают ровный контур; диагонали добавляют плотности
    // на углах и стоят ещё четыре блита — их берём только там, где есть запас.
    const offs = this.q.detail >= 2 ? OFFS8 : OFFS4;
    const ph = phaseOf(this.seed, Math.floor(v.x), Math.floor(v.y));
    const s = Math.sin((this.time / PULSE[key] + ph) * Math.PI * 2);
    ctx.save();
    ctx.globalAlpha = 0.62 + 0.26 * s;
    for (let i = 0; i < offs.length; i += 2) {
      ctx.drawImage(sil, dx + offs[i] * d, dy + offs[i + 1] * d, dw, dh);
    }
    ctx.restore();
    this.stat.outlines++;
  }

  // -------------------------------------------------------------------------
  // Кольцо/подсветка для одного выбранного объекта.
  markerFor(ctx, ox, oy, z, cw, ch, m, key, lod) {
    if (m.kind === 'b') {
      const b = m.b;
      const size = (b.size || 1) * z;
      const cx = ox + b.x * z + size / 2;
      // Кольцо садится не в геометрический центр клетки, а к подошве спрайта:
      // здание рисуется высотой до 1.6 клетки ВВЕРХ от нижнего края пятна
      // застройки (renderer: dy = sy + size - dh), и кольцо в центре клетки
      // оказалось бы у постройки где-то на уровне окон второго этажа.
      const cy = oy + b.y * z + size * 0.88;
      if (cx < -size || cy < -size || cx > cw + size || cy > ch + size) return;
      // 0.60 от стороны пятна: спрайт шире клетки на 16 % (renderer, dw =
      // size * 1.16), и кольцо радиусом ровно в полклетки пряталось бы под ним.
      const rx = size * 0.60;
      const ph = phaseOf(this.seed, b.x, b.y);
      this.ring(ctx, cx, cy, rx, key, ph);
      // Второе, внутреннее кольцо — только там, где кадр это себе позволяет.
      // Это один лишний блит той же выпечки, но он даёт выделению «глубину»,
      // которой одиночный контур не даёт.
      if (this.q.detail >= 2 && key === 'pick') this.ring(ctx, cx, cy, rx * 0.72, key, ph + 0.5, 0.45);
    } else if (m.kind === 'v') {
      // Жителей на дальнем зуме renderer не рисует вовсе (lod.people) — кольцо
      // под несуществующей фигурой выглядит как баг.
      if (lod && !lod.people) return;
      const cx = ox + m.v.x * z, cy = oy + m.v.y * z;
      if (cx < -z || cy < -z || cx > cw + z || cy > ch + z) return;
      this.ring(ctx, cx, cy, Math.max(5, z * 0.30), key,
        phaseOf(this.seed, Math.floor(m.v.x), Math.floor(m.v.y)));
    }
  }

  // Подсветка клетки под курсором. Для постройки — всё пятно застройки
  // (b.size), для пустой земли — одна клетка.
  tileMark(ctx, ox, oy, z, cw, ch, m) {
    const n = m.kind === 'b' ? (m.b.size || 1) : 1;
    const x = ox + m.tx * z, y = oy + m.ty * z, s = n * z;
    if (x + s < 0 || y + s < 0 || x > cw || y > ch) return;
    const a = 0.5 + 0.2 * Math.sin(this.time / PULSE.hover * Math.PI * 2);
    ctx.save();
    // Заливка слабая до неприличия (0.05) намеренно: подсветка обязана
    // читаться как «указатель здесь», а не перекрашивать землю. Работает
    // контур, заливка лишь связывает его в фигуру.
    if (this.q.detail > 0) {
      ctx.fillStyle = `rgba(${COL.hover},0.05)`;
      ctx.fillRect(x, y, s, s);
    }
    ctx.strokeStyle = `rgba(${COL.hover},${a.toFixed(3)})`;
    ctx.lineWidth = Math.max(1, z * 0.045);
    // Отступ на половину толщины линии — иначе контур ложится ровно на границу
    // клетки и на соседней клетке видно его вторую половину.
    const p = ctx.lineWidth / 2;
    ctx.strokeRect(x + p, y + p, s - p * 2, s - p * 2);
    ctx.restore();
  }

  // Рамки зон действия. Штатно их две (наведение + выбор); showAllAuras
  // включает показ всех, и вот там нужен потолок.
  auras(sim, ctx, ox, oy, z, cw, ch, hov, sel) {
    const cap = Math.min(SELECT_LIMITS.auras, this.q.caps.buildings);
    let n = 0;
    if (this.showAllAuras) {
      for (const b of sim.buildings) {
        if (n >= cap) break;
        if (b.destroyed || !b.done) continue;
        if (this.aura(sim, ctx, ox, oy, z, cw, ch, b, 0.55)) n++;
      }
      return;
    }
    for (const m of [sel, hov]) {
      if (!m || m.kind !== 'b' || n >= cap) continue;
      if (sameTarget(m, sel) && m !== sel) continue;
      if (this.aura(sim, ctx, ox, oy, z, cw, ch, m.b, 1)) n++;
    }
  }

  // Одна рамка. Возвращает true, если что-то нарисовали.
  aura(sim, ctx, ox, oy, z, cw, ch, b, k) {
    const def = BUILDINGS[b.id];
    if (!def || !def.aura || !def.aura.r) return false;
    let r = def.aura.r;
    // Вокзал даёт +2 ко всем радиусам (data.js: radiusBonus), и в расчёте
    // мельницы это учтено (simulation: radius = 3 + (вокзал ? 2 : 0)). Рамка
    // обязана показывать ту же цифру, что применяет правило, иначе она врёт.
    if (def.aura.farm && sim.hasBuilding && sim.hasBuilding('train_station')) r += 2;

    const size = (b.size || 1) * z;
    // Центр — центр КЛЕТКИ-ЯКОРЯ постройки, а не её пятна. Так требует само
    // правило: ядро сравнивает b.x/b.y обеих построек, то есть их углы, а
    // сравнение углов эквивалентно сравнению центров клеток-якорей.
    const cx = ox + b.x * z + z / 2, cy = oy + b.y * z + z / 2;
    const R = r * z;
    if (cx + R < 0 || cy + R < 0 || cx - R > cw || cy - R > ch) return false;

    ctx.save();
    // Мягкая заливка зоны — выпеченный диск, а не градиент в кадре.
    if (this.q.detail > 0) {
      const disc = this.bake('disc');
      if (disc) {
        ctx.globalAlpha = 0.16 * k;
        ctx.drawImage(disc, cx - R, cy - R, R * 2, R * 2);
        ctx.globalAlpha = 1;
      }
    }
    const s = Math.sin((this.time / PULSE.aura + phaseOf(this.seed, b.x, b.y)) * Math.PI * 2);
    ctx.strokeStyle = `rgba(${COL.aura},${(0.5 + 0.18 * s) * k})`;
    ctx.lineWidth = Math.max(1, z * 0.05);
    const dash = Math.max(5, z * 0.35);
    ctx.setLineDash([dash, dash * 0.75]);
    // Пунктир едет ПО кругу: постоянный, но еле заметный признак того, что это
    // активная зона, а не нарисованная на земле разметка.
    ctx.lineDashOffset = this.q.detail === 0 ? 0 : (this.time * z * 0.5) % 4096;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    this.stat.auras++;
    return true;
  }

  // -------------------------------------------------------------------------
  // Блит выпеченного кольца. Вся «мягкость» уже в картинке; здесь только
  // пульсация масштабом и прозрачностью и сплющивание по вертикали.
  ring(ctx, cx, cy, rx, key, phase, mul = 1) {
    const cv = this.bake(key);
    if (!cv) return;
    const s = Math.sin((this.time / PULSE[key] + (phase || 0)) * Math.PI * 2);
    // Дыхание радиусом всего 3,5 %: больше — и кольцо начинает «прыгать»,
    // перетягивая внимание с того, что оно обводит.
    const RX = rx * (1 + 0.035 * s);
    const RY = RX * FLAT;
    ctx.save();
    ctx.globalAlpha = (0.62 + 0.28 * s) * mul;
    ctx.drawImage(cv, cx - RX, cy - RY, RX * 2, RY * 2);
    ctx.restore();
    this.stat.rings++;
  }

  // Выпечка по требованию: 'hover' | 'pick' — кольцо, 'disc' — заливка ауры.
  bake(key) {
    const d = Math.max(0, Math.min(2, this.q.detail | 0));
    const S = RING_PX[d];
    const id = `${key}|${S}`;
    let cv = this.bakes.get(id);
    if (cv !== undefined) return cv;

    cv = makeCanvas(S, S);
    if (!cv) { this.bakes.set(id, null); return null; }
    const c = cv.getContext('2d');
    const col = key === 'disc' ? COL.aura : COL[key];
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    if (key === 'disc') {
      // Диск ауры: ярче к центру, к краю сходит в ноль — край зоны обозначает
      // пунктир, а не граница заливки, иначе получится два контура вместо одного.
      g.addColorStop(0.00, `rgba(${col},0.55)`);
      g.addColorStop(0.60, `rgba(${col},0.30)`);
      g.addColorStop(1.00, `rgba(${col},0)`);
    } else {
      // Кольцо: почти пустая середина (лёгкая подсветка земли под объектом),
      // яркая полоса на 0.82 радиуса и мягкий сход к краю с обеих сторон.
      // Полоса не на самом краю намеренно: при пульсации радиусом край выходил
      // бы за пределы выпечки и обрезался квадратом канваса.
      g.addColorStop(0.00, `rgba(${col},0.10)`);
      g.addColorStop(0.55, `rgba(${col},0.07)`);
      g.addColorStop(0.74, `rgba(${col},0.42)`);
      g.addColorStop(0.84, `rgba(${col},0.95)`);
      g.addColorStop(0.93, `rgba(${col},0.40)`);
      g.addColorStop(1.00, `rgba(${col},0)`);
    }
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);

    this.bakes.set(id, cv);
    this.stat.bakes++;
    // Общий для всего рендера механизм вытеснения: записей тут единицы, но
    // кэш, за которым никто не следит, рано или поздно становится утечкой.
    prune(this.bakes, {
      maxEntries: 8,
      maxBytes: SELECT_LIMITS.ringMB * 1e6,
      bytesOf: canvasBytes,
    });
    return cv;
  }

  // Силуэт одного кадра листа жителей, залитый цветом выделения. Печётся один
  // раз на (лист, кадр, направление) и живёт ровно столько же, сколько лист.
  // Наивный путь — красить кадр в кадре через ctx.filter или попиксельно —
  // стоил бы больше, чем весь остальной слой вместе взятый.
  silhouette(sheet, frame, dir, key) {
    let arr = this.sils.get(sheet.cv);
    if (!arr) { arr = new Array(32); this.sils.set(sheet.cv, arr); }
    // 16 сочетаний на цвет, два цвета — отсюда индекс с шагом 16.
    const i = (key === 'pick' ? 0 : 16) + (dir & 3) * 4 + (frame & 3);
    let cv = arr[i];
    if (cv !== undefined) return cv;

    cv = makeCanvas(sheet.fw, sheet.fh);
    if (!cv) { arr[i] = null; return null; }
    const c = cv.getContext('2d');
    c.drawImage(sheet.cv, frame * sheet.fw, dir * sheet.fh, sheet.fw, sheet.fh,
      0, 0, sheet.fw, sheet.fh);
    // source-in красит ровно непрозрачные пиксели кадра — то есть саму фигуру,
    // а не её прямоугольник. Это и есть силуэт.
    c.globalCompositeOperation = 'source-in';
    c.fillStyle = `rgb(${COL[key]})`;
    c.fillRect(0, 0, sheet.fw, sheet.fh);
    arr[i] = cv;
    this.stat.bakes++;
    return cv;
  }

  stats() {
    return {
      rings: this.stat.rings,
      auras: this.stat.auras,
      outlines: this.stat.outlines,
      bakes: this.stat.bakes,
      hover: this.hover ? this.hover.kind : null,
      sel: this.sel ? this.sel.kind : null,
    };
  }
}

// Смещения обводки: сначала оси, потом диагонали. Плоский массив пар, чтобы в
// горячем цикле не аллоцировать вложенные массивы.
const OFFS4 = [-1, 0, 1, 0, 0, -1, 0, 1];
const OFFS8 = [-1, 0, 1, 0, 0, -1, 0, 1, -1, -1, 1, -1, -1, 1, 1, 1];

function alive(m, sim) {
  if (!m) return false;
  if (m.kind === 'b') return !!m.b && !m.b.destroyed;
  if (m.kind === 'v') return !!m.v && m.v.hp > 0 && (!sim || !sim.villagers || sim.villagers.indexOf(m.v) >= 0);
  return true;
}

function sameTarget(a, b) {
  if (!a || !b) return false;
  return (a.b && a.b === b.b) || (a.v && a.v === b.v);
}

// ---------------------------------------------------------------------------
// ПОДКЛЮЧЕНИЕ
//
// Ни один существующий файл этим модулем не тронут. Ниже — точные строки для
// вставки. Якорь дан целиком, вместе с отступами; число совпадений проверено
// grep -Fc по файлу на момент написания.
//
// ===== app/src/render/renderer.js =====
//
// 1) ИМПОРТ. Якорь (совпадений: 1):
//
// import { FxLayer } from './fx.js';
//
//    ПОСЛЕ этой строки добавить:
//
// import { SelectLayer } from './select.js';
//
// 2) СОЗДАНИЕ СЛОЯ. Якорь (совпадений: 1):
//
//     this.fx = new FxLayer(this.quality);
//
//    ПОСЛЕ неё добавить:
//
//     this.select = new SelectLayer(this.quality);
//
// 3) СМЕНА ПРЕСЕТА. Якорь (совпадений: 2 — строка 78 в методе setQuality и
//    строка 264 в методе tuneAuto; отступ у обеих одинаковый, четыре пробела):
//
//     this.fx.setQuality(this.quality);
//
//    Добавить ПОСЛЕ ОБЕИХ (это не опечатка: setQuality вызывается, когда пресет
//    меняет игрок, tuneAuto — когда его меняет авто-тюнер; пропустить вторую
//    значит оставить на ultra кольцо, выпеченное для eco):
//
//     this.select.setQuality(this.quality);
//
// 4) СЛОЙ ПО ЗЕМЛЕ. Якорь (совпадений: 1):
//
//     // --- единый проход по глубине: здания + жители + животные, сортировка по Y ---
//
//    ПЕРЕД этой строкой добавить:
//
//     // --- выделение и наведение: кольца, клетка, ауры (под спрайтами) ---
//     this.select.drawGround(sim, ctx, ox, oy, z, cw, ch, dtReal);
//
//    Место выбрано так, чтобы кольцо лежало НА земле, но ПОД постройками и
//    жителями. Поставить его после Y-прохода нельзя: кольцо накрыло бы
//    подошву здания и перестало читаться как пятно на земле.
//
// 5) СЛЕД ПУТИ. Якорь (совпадений: 1):
//
//     this.fx.drawWorld(ctx, ox, oy, z, cw, ch);
//
//    ПОСЛЕ неё добавить:
//
//     this.select.drawTop(sim, ctx, ox, oy, z, cw, ch);
//
//    Именно здесь, а не в конце draw(): след — часть мира, он обязан уйти под
//    погоду, тон времени суток и виньетку, иначе пунктир будет светиться
//    сквозь ночь ярче фонарей.
//
// 6) ОБВОДКА ЖИТЕЛЯ. Якорь (совпадений: 1, метод drawVillager):
//
//     this.shadows.unit(ctx, sx, sy, w, h);
//
//    ПЕРЕД этой строкой добавить:
//
//     this.select.villager(ctx, v, sh, frame, st.dir, sx, sy, w, h);
//
//    Обводка кладётся ДО спрайта: она рисуется четырьмя смещёнными копиями
//    силуэта, и сам спрайт поверх закрывает середину, оставляя контур. Если
//    поставить строку после ctx.drawImage, фигура окажется залита цветом.
//    Все имена в этой строке — локальные переменные drawVillager (v, sh,
//    frame, st, sx, sy, w, h), ничего добавлять не нужно.
//
// ===== app/src/main.js =====
//
// 7) НАВЕДЕНИЕ. Якорь (совпадений: 1):
//
// canvas.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); lastPinch = 0; clearTimeout(longPressTimer); });
//
//    ПОСЛЕ этой строки добавить:
//
// // Наведение слушаем ОТДЕЛЬНЫМ обработчиком: штатный pointermove выше первой
// // же строкой выходит, если указателя нет в pointers, то есть срабатывает
// // только при зажатой кнопке. Обычное наведение мышью туда не попадает.
// canvas.addEventListener('pointermove', e => {
//   if (e.pointerType !== 'mouse') return;      // на пальце наведения не бывает
//   const w = renderer.screenToWorld(e.clientX, e.clientY);
//   renderer.select.hoverAt(sim, w.x, w.y);
// }, { passive: true });
// canvas.addEventListener('pointerleave', () => renderer.select.clearHover());
//
// 8) ВЫБОР ПО ТАПУ. Якорь (совпадений: 1, внутри обработчика pointerup):
//
//         if (b && e.pointerType === 'mouse') hud.showBuildingCard(b);
//
//    ПОСЛЕ неё добавить (переменная w — та же, что объявлена парой строк выше):
//
//         renderer.select.selectAt(sim, w.x, w.y);
//
//    Порядок важен: карточку HUD открывает прежний код, выделение ставится
//    после него и работает в том числе по жителю, у которого карточки нет.
//
// 9) НЕОБЯЗАТЕЛЬНО — снятие выделения по Escape. Рядом со строкой
//    (совпадений: 1)
//
//     if (sim.placing) cancelPlace();
//
//    в обработчике keydown можно добавить renderer.select.clear();
//    Без этого выделение снимается повторным кликом по тому же объекту —
//    штатный путь, отдельная клавиша лишь удобство.
//
// ---------------------------------------------------------------------------
// ЧТО НАСТРАИВАЕТСЯ СНАРУЖИ
//
//   renderer.select.enabled = false;        // выключить слой целиком
//   renderer.select.showAllAuras = true;    // показать ауры всех построек
//   renderer.select.select(p) / .clear()    // выделить из кода (HUD, обучение)
//   renderer.select.selection               // что выбрано: {kind,b,v,tx,ty}
//   renderer.select.stats()                 // {rings, auras, outlines, bakes, ...}
//
// ПРЕСЕТЫ
//
//   eco (detail 0)    — кольца и рамки без бегущего пунктира и без заливки
//                       зоны; обводка только у выбранного жителя, 4 блита;
//                       выпечка 64×64.
//   medium (detail 1) — полный набор, обводка 4 блита, выпечка 128×128.
//   high (detail 2)   — плюс внутреннее кольцо у выделения и обводка 8 блитов.
//   ultra (detail 2)  — то же, что high.
//
// Ниже 6 px на клетку (SELECT_LIMITS.minZoomPx) слой молчит: при минимальном
// зуме игры 0.4 это 12,8 px, то есть порог — страховка на случай, если
// ограничение зума когда-нибудь снимут.
