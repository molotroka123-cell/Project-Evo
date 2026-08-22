// render/borders_view.js — границы владений на карте мира.
//
// ЗАЧЕМ. Ядро считает принадлежность каждой клетки раз в игровой день
// (core/systems/borders.js: owners[], depth[], areas[], edges[]), интегратор
// кладёт сводку в sim.sys.borderStats, миникарта это уже показывает — а на
// самой карте не видно ничего. Игрок строит склад «рядом с домом» и не знает,
// что уже стоит на земле Волчьего Предела и платит за это истощением (U02),
// и не понимает, откуда берётся земельный налог (U04). Этот слой закрывает
// именно этот разрыв: своя земля, чужая земля, спорная полоса между ними.
//
// ЧТО РИСУЕТСЯ
//   • очень слабая заливка территории цветом владельца — она НЕ должна спорить
//     с местностью, поэтому альфа 0,065…0,20, а не 0,33, как в старом
//     renderer.drawTerritory. Заливка не равномерная: она усиливается к кромке
//     и гаснет вглубь страны. Глубину не считаем — она уже посчитана ядром
//     (state.depth, многоисточниковый BFS в _buildDepth), и это ровно то, что
//     нужно: у сердца державы фон почти прозрачен, а у стыка с соседом виден.
//   • чёткая линия по внешнему контуру — единственное, что даёт «здесь кончается
//     моя земля» однозначно. Линия рисуется путём в клеточных координатах под
//     масштабом камеры, поэтому остаётся ровно N экранных пикселей на любом
//     зуме и не мылится, в отличие от выпеченной картинки.
//   • соседи — своим цветом (f.def.color из таблицы FACTIONS через живой
//     объект фракции), по той же логике.
//   • спорные клетки — штриховкой.
//
// ЧТО ТАКОЕ «СПОРНАЯ КЛЕТКА». В owners[] её нет: borders.js при равенстве
// влияний (tie) пишет OWNER_NONE, тем же кодом, что и глухая тайга. Отличить
// одно от другого по одному массиву нельзя, и лезть в ядро за третьим массивом
// ради подсветки — плохой размен. Поэтому спорность определяется здесь и
// геометрически: ничья СУШНАЯ клетка, у которой среди восьми соседей есть
// минимум два РАЗНЫХ владельца. Это ровно та полоса, где границы упёрлись друг
// в друга (U03), и она совпадает с tie-клетками почти всюду, кроме одиночных
// ничьих внутри одной державы — а те и не должны штриховаться.
//
// ═══════════════ ЦЕНА КАДРА ═══════════════
// Наивная версия — обойти 96×96 = 9216 клеток каждый кадр, на каждой посмотреть
// четырёх соседей и дёрнуть fillRect/stroke — это ~37 тысяч сравнений и до
// девяти тысяч вызовов растеризатора на кадр, то есть 4–8 мс из 16,6. Весь
// смысл файла в том, что этой работы в кадре нет вообще.
//
// В кадре ровно три вещи:
//   1) сравнение строкового ключа выпечки            ~1 мкс
//   2) ОДИН drawImage выпеченной заливки, с вырезкой источника по пересечению
//      «видимая часть экрана» ∩ «прямоугольник закрашенного» — в начале партии
//      владение игрока это пятно 10×10 клеток, и блит соответствующий;
//      худший случай (политический режим, держава во весь экран) —
//      полноэкранный масштабированный блит с альфой:
//        ~0,15–0,25 мс на GPU-канвасе, ~0,8–1,2 мс на программном
//        растеризаторе (стенд из docs/visual-performance-budget.md)
//   3) 2–14 вызовов stroke() по заранее собранным Path2D (тёмная подложка +
//      цвет, по одному владельцу): ~0,1–0,4 мс на программном стенде.
// ИТОГО: тихий режим «своя земля» — 0,05–0,2 мс (около 1 % кадра);
//        политический режим во весь экран — 0,3–1,6 мс худшего случая.
//
// Выпечка (НЕ каждый кадр — только когда сменилась версия границ, то есть не
// чаще раза в игровой день, и только если состав зданий реально менялся):
//   • проход по клеткам с горизонтальной склейкой одинаковых участков в отрезки:
//     9216 итераций арифметики → 200–1200 fillRect вместо 9216  ~0,3–0,6 мс
//     (строку режет не дизер, а сама полоса затухания: кромка, band 2, band 3
//      — то есть 5–6 кусков на строку, замер на державе 20×20: 113 против 400)
//   • маска спорных клеток (восемь соседей только у ничьих клеток) ~0,1 мс
//   • штриховка: все спорные отрезки в ОДИН путь, одна заливка паттерном ~0,05 мс
//   • трассировка контуров всех владельцев со склейкой коллинеарных точек
//     (см. traceContours)                                        ~0,2–0,4 мс
//   ИТОГО ~0,7–1,2 мс один раз. Дробить её на кадры (как chunksPerFrame в
//   terrain.js) незачем: она случается в тот же кадр, что и пересчёт границ в
//   ядре, который сам стоит дороже, и не чаще раза в игровые сутки.
//
// ЗАМЕР ЛОГИКИ (node, подставной контекст 2D: считается только JS, вызовы
// растеризатора заглушены — их время меряет главный разработчик в браузере.
// Мир 96×96, 300 построек игрока, шесть фракций по два поселения, границы
// посчитаны настоящим updateBorders: 2658 клеток у игрока, 958 рёбер у ядра):
//   выпечка целиком (заливка + штриховка + все контуры)   0,94 мс
//   кадр без выпечки, вся арифметика слоя                 0,0041 мс
//   геометрия после склейки: 480 точек в 15 ломаных на восемь держав
//   выпечка high: 768×768×4 = 2,36 МБ, 12 вызовов stroke() в кадре
// Четыре микросекунды на кадр — это 0,02 % бюджета; всё остальное, что слой
// стоит, это работа растеризатора над одним блитом и десятком обводок.
//
// ПРЕСЕТЫ КАЧЕСТВА (quality.js)
//   q.id            → бюджет выпечки в мегабайтах и через него разрешение
//                     выпечки: eco 4 px/клетку (384², 0,6 МБ), medium/high 8
//                     (768², 2,4 МБ), ultra 16 (1536², 9,4 МБ). Считается в
//                     pickBakePx() от размера мира, а не таблицей: мир не обязан
//                     быть 96×96.
//   q.detail        → на eco (detail 0) нет ни штриховки, ни тёмной подложки
//                     под линией: на слабой машине это два лишних прохода ради
//                     нюансов, которых на 1 px линии всё равно не видно.
//   lodForZoom().far→ вдали линии тоньше в 0,75 и подложка выключена: при
//                     тайле мельче 22 px двойная линия сливается в кашу.
//   q.caps.textureMB→ верхняя граница бюджета выпечки (см. BAKE_MB_OF_CAP).
// ПОТОЛОК ОБЪЕКТОВ В КАДРЕ: MAX_POINTS точек контуров суммарно по всем
// владельцам. Дальше трассировка обрывается (stats().truncated === true) —
// лучше недорисованная граница, чем съеденный кадр.
//
// ЗАМЫЛЕННОСТЬ ЗАЛИВКИ — сознательный размен. Выпечка кладётся в клеточном
// разрешении bakePx и растягивается фильтрацией браузера. На зуме 3 (96 px на
// клетку при bakePx 8) край заливки размазывается на ~12 px. Это не баг: край
// территории всё равно обводится ЧЁТКОЙ линией, а размытая подложка под ней
// читается как мягкое свечение владения — то, что и нужно. Альтернатива —
// перепекать при каждом изменении зума, то есть 2,4 МБ канваса на каждый щелчок
// колеса; так делать нельзя.
//
// СЛУЧАЙНОСТЬ. Math.random запрещён, sim.rng из рендера — тем более: рендер
// идёт с частотой монитора, и каждый его вызов сдвинул бы состояние симуляции,
// после чего сейв разъехался бы у двух игроков с разными FPS. Всё «случайное»
// здесь — свой детерминированный hash от sim.world.seed (h3, тот же приём, что
// в water.js/relief.js/vegetation.js). Используется он ровно в одном месте:
// в дизере полосы затухания заливки, чтобы граница фона не выглядела
// концентрическими квадратами BFS-глубины.
//
// АРХИТЕКТУРА. Слой только ЧИТАЕТ состояние: sim.sys.borders (или sim.borders),
// sim.world.tiles, sim.factions. Ничего не пишет ни в ядро, ни в sim.
import { TILE, FACTIONS } from '../core/data.js';
import { OWNER_PLAYER } from '../core/systems/borders.js';
import { lodForZoom, canvasBytes } from './quality.js';

// Золото игрока. То же значение, что в minimap.js и в старом
// renderer.drawTerritory: два разных золота на одной карте — верный способ
// заставить игрока думать, что это две разные стороны.
const PLAYER_GOLD = '#c9a227';
// Владелец, которого нет в таблице FACTIONS (сейв от другой сборки) — серый,
// но всё-таки нарисованный: молча потерять кусок карты хуже, чем показать его
// нейтральным.
const UNKNOWN_GRAY = '#6a6f7a';

// Полосы затухания заливки по глубине от кромки. Четыре ступени, а не гладкий
// градиент: гладкий пришлось бы считать по клетке и он разорвал бы склейку
// отрезков (см. _bakeFill), а разницу между 0,090 и 0,085 на 11-процентной
// прозрачности не видит никто.
//   band 0 — сама кромка (depth 1): территория «упирается» во что-то;
//   band 3 — глубина 4 и дальше: сердце страны, фон почти прозрачен.
export const FILL_BANDS = [0.20, 0.13, 0.090, 0.065];
// Разброс полосы дизером. 1,4 — чуть меньше двух: смещение ±0,7 позволяет
// клетке уйти ровно на одну полосу, но не на две. Меньше единицы дизер не
// работает вообще (±0,45 не меняет округления), а без него по территории идут
// ровные квадратные кольца BFS-глубины — видно, что это алгоритм, а не карта.
const BAND_DITHER = 1.4;
// Дизер берётся не по клетке, а по блоку 4×4 (сдвиг на 2 бита). Причина
// чисто бюджетная: вся выпечка держится на склейке одинаковых клеток в
// горизонтальные отрезки (_bakeFill), а поклеточный дизер разорвал бы каждый
// отрезок в кромке на клетки — 9216 fillRect вместо трёхсот. Заодно кромка
// получается пятнами по 4 клетки, а это и есть нужный масштаб «мягкого края»:
// поклеточный дизер на прозрачности 13 % читается как грязь, а не как мягкость.
const DITHER_BLOCK = 2;

// Толщина контура в ЭКРАННЫХ пикселях (в путь она попадает делённой на z).
// Своя граница толще чужой: игрок ищет глазами именно её.
const LINE_OWN = 2.2;
const LINE_OTHER = 1.5;
// Тёмная подложка под цветной линией. Без неё «Орден Зари» (#e8ddc0) исчезает
// на песке и на снегу полностью — та же беда, что и с точками на миникарте.
const LINE_HALO = 1.4;
const HALO_COLOR = 'rgba(6,9,16,0.5)';

// Потолок геометрии контуров. 6000 точек — это примерно граница восьми держав,
// каждая из которых изрезана как побережье Норвегии; реальные значения на
// мире 96×96 — 300…1200 точек после склейки коллинеарных.
const MAX_POINTS = 6000;

// Бюджет выпечки в байтах по пресету. Не таблица «px на клетку», а именно
// бюджет: мир может быть и 128×128, и тогда 16 px/клетку — это 64 МБ, чего
// нельзя ни на одном пресете.
const BAKE_MB_OF_CAP = { eco: 1.5, medium: 3, high: 6, ultra: 12 };

// ---------------------------------------------------------------------------
// Мелочи
// ---------------------------------------------------------------------------

// Где живёт состояние границ. core/systems/integrate.js кладёт его в
// sim.sys.borders, но в шапке самого borders.js описан вариант с sim.borders.
// Проверяем оба: слой не должен зависеть от того, какой путь выбрал интегратор
// (ровно так же поступает minimap.js).
export function bordersState(sim) {
  const s = (sim && sim.sys && sim.sys.borders) || (sim && sim.borders);
  return s && s.owners && s.owners.length ? s : null;
}

// Цвет владельца. Код 1 — игрок, дальше FACTIONS по порядку таблицы
// (код = индекс + 2 — это контракт borders.js, а не наша выдумка).
// Берём цвет из ЖИВОГО объекта фракции (f.def.color): если ядро когда-нибудь
// начнёт подменять def (династия, смена знамени), карта пойдёт за ним, а не
// останется на статической таблице.
export function ownerColorOf(sim, code) {
  if (code === OWNER_PLAYER) return PLAYER_GOLD;
  const def = FACTIONS[code - 2];
  if (!def) return UNKNOWN_GRAY;
  const live = sim && sim.factions ? sim.factions.find(f => f && f.id === def.id) : null;
  return (live && live.def && live.def.color) || def.color || UNKNOWN_GRAY;
}

// Свой детерминированный хеш от сида мира: см. «СЛУЧАЙНОСТЬ» в шапке.
// Math.imul, а не умножение: обычное * на больших константах уходит в double и
// теряет младшие биты, а с ними и всю перемешку — получается регулярный узор.
export function h3(x, y, seed) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Полоса затухания для клетки. depth приходит из ядра: 1 — кромка, дальше вглубь.
// Дизерится только двухклеточная кромка (d < 2). Глубже он не нужен и вреден:
// кольца там всё равно не читаются на прозрачности 6…9 %, а склейка отрезков
// внутри страны — как раз то, что делает выпечку дешёвой, ломать её ради
// невидимого нюанса нельзя.
export function fillBand(depth, x, y, seed) {
  const last = FILL_BANDS.length - 1;
  const d = depth > 0 ? depth - 1 : 0;
  if (d >= 2) return d > last ? last : d;
  const b = Math.round(d + (h3(x >> DITHER_BLOCK, y >> DITHER_BLOCK, seed) - 0.5) * BAND_DITHER);
  return b < 0 ? 0 : (b > 2 ? 2 : b);
}

// Разрешение выпечки: самая крупная степень двойки, влезающая в бюджет пресета.
// Степень двойки — чтобы клетка ложилась в целое число пикселей выпечки и
// заливка не «ездила» на полпикселя между соседними клетками.
export function pickBakePx(q, W, H) {
  const capMB = BAKE_MB_OF_CAP[q && q.id] || 3;
  // Верхняя защёлка по кэшам пресета: слой не имеет права съесть больше
  // четверти общего текстурного бюджета — остальное нужно чанкам и спрайтам.
  const capByTextures = q && q.caps && q.caps.textureMB ? q.caps.textureMB / 4 : capMB;
  const budget = Math.min(capMB, capByTextures) * 1024 * 1024;
  let px = 16;
  while (px > 2 && W * px * H * px * 4 > budget) px >>= 1;
  return px;
}

// ---------------------------------------------------------------------------
// Спорные клетки
// ---------------------------------------------------------------------------
// Маска ничьих клеток, вокруг которых сошлись минимум две разные державы.
// out переиспользуется между выпечками: на 96×96 это 9 КБ, но выделять их
// заново на каждой выпечке — лишний мусор для сборщика ровно в тот кадр,
// когда мы и так заняты.
export function contestedMask(st, world, out = null) {
  const W = st.w, H = st.h, N = W * H;
  const owners = st.owners;
  const tiles = world && world.tiles && world.tiles.length === N ? world.tiles : null;
  const m = (out && out.length === N) ? out : new Uint8Array(N);
  m.fill(0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (owners[i]) continue;                       // клетка занята — не спор
      if (tiles) {
        const t = tiles[i];
        // Вода ничья по определению (borders.js обнуляет её отдельной веткой),
        // штриховать залив между двумя державами — врать игроку.
        if (t === TILE.WATER || t === TILE.DEEP) continue;
      }
      let a = 0, b = 0;
      for (let dy = -1; dy <= 1 && !b; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const o = owners[yy * W + xx];
          if (!o) continue;
          if (!a) a = o;
          else if (o !== a) { b = o; break; }
        }
      }
      if (b) m[i] = 1;
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// Контуры
// ---------------------------------------------------------------------------
// Собирает внешний контур владения `code` в набор ломаных.
//
// ПОЧЕМУ НЕ borderEdges() ИЗ ЯДРА. Оно отдаёт готовый список рёбер — но именно
// список: до четырёх тысяч отдельных отрезков длиной в клетку. Нарисовать их —
// это четыре тысячи beginPath/moveTo/lineTo/stroke, то есть та самая наивная
// версия, от которой мы уходим; и стыки соседних отрезков дадут разрывы на
// толстой линии. Здесь рёбра сшиваются в непрерывные ломаные и коллинеарные
// точки схлопываются: прямой участок границы в 30 клеток становится ОДНИМ
// отрезком из двух точек.
//
// КАК СШИВАЮТСЯ. Каждое ребро делается направленным так, чтобы владение всегда
// оставалось слева по ходу (верх → вправо, право → вниз, низ → влево, лево →
// вверх). Тогда у каждого угла решётки число входящих рёбер равно числу
// исходящих, обход всегда замыкается, и «прыгнуть» через разрыв нельзя в
// принципе: следующее ребро начинается там, где закончилось предыдущее.
// В точке «песочных часов» (две клетки владения касаются углами) из угла
// выходит два ребра — берём любое непройденное: на непрерывность это не
// влияет, а какая именно из двух петель получится, глазу безразлично.
export function traceContours(owners, W, H, code, opts = {}) {
  const maxPoints = opts.maxPoints || MAX_POINTS;
  const CW = W + 1;                        // ширина решётки УГЛОВ, а не клеток
  const from = [], to = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (owners[i] !== code) continue;
      const c = y * CW + x;                // левый верхний угол клетки
      if (y === 0 || owners[i - W] !== code) { from.push(c); to.push(c + 1); }
      if (x === W - 1 || owners[i + 1] !== code) { from.push(c + 1); to.push(c + 1 + CW); }
      if (y === H - 1 || owners[i + W] !== code) { from.push(c + CW + 1); to.push(c + CW); }
      if (x === 0 || owners[i - 1] !== code) { from.push(c + CW); to.push(c); }
    }
  }
  const n = from.length;
  const res = { polys: [], points: 0, segments: n, bbox: null, truncated: false };
  if (!n) return res;

  // Индекс «из какого угла какие рёбра выходят». Map, а не массив на 9409
  // элементов: рёбер обычно в разы меньше углов, и заполнять массив на весь
  // мир ради трёхсот рёбер — платить за пустоту.
  const outIdx = new Map();
  for (let e = 0; e < n; e++) {
    const k = from[e];
    const l = outIdx.get(k);
    if (l) l.push(e); else outIdx.set(k, [e]);
  }

  const used = new Uint8Array(n);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let e0 = 0; e0 < n && !res.truncated; e0++) {
    if (used[e0]) continue;
    const pts = [];
    const k0 = from[e0];
    _push(pts, k0 % CW, (k0 / CW) | 0);
    let cur = e0;
    while (cur >= 0 && !used[cur]) {
      used[cur] = 1;
      const k = to[cur];
      _push(pts, k % CW, (k / CW) | 0);
      const list = outIdx.get(k);
      let nxt = -1;
      if (list) for (let j = 0; j < list.length; j++) if (!used[list[j]]) { nxt = list[j]; break; }
      cur = nxt;
    }
    if (pts.length < 4) continue;          // вырожденное — быть не должно, но
    const closed = pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1];
    if (closed) { pts.length -= 2; }       // замыкание нарисует closePath()
    for (let j = 0; j < pts.length; j += 2) {
      const x = pts[j], y = pts[j + 1];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    res.points += pts.length >> 1;
    res.polys.push({ pts: Float32Array.from(pts), closed });
    if (res.points >= maxPoints) res.truncated = true;
  }
  if (res.polys.length) res.bbox = { x0: minx, y0: miny, x1: maxx, y1: maxy };
  return res;
}

// Добавление точки со склейкой коллинеарных. Проверка через векторное
// произведение на целых числах — точная, без эпсилонов: координаты углов
// решётки целые по построению.
function _push(pts, x, y) {
  const n = pts.length;
  if (n >= 2 && pts[n - 2] === x && pts[n - 1] === y) return;   // дубль
  if (n >= 4) {
    const px = pts[n - 2], py = pts[n - 1], qx = pts[n - 4], qy = pts[n - 3];
    if ((px - qx) * (y - py) === (x - px) * (py - qy)) { pts[n - 2] = x; pts[n - 1] = y; return; }
  }
  pts.push(x, y);
}

// ---------------------------------------------------------------------------
// Слой
// ---------------------------------------------------------------------------
export class BordersView {
  constructor(q) {
    this.q = q;
    this.cv = null;          // выпечка заливки и штриховки, в клеточном разрешении
    this.cx = null;
    this.bakePx = 0;
    this.key = '';           // ключ выпечки: пока он тот же — работы нет
    this.bakes = 0;          // сколько раз перепекали (диагностика и тест)
    this.layers = [];        // [{code, color, polys, path, bbox}], игрок последним
    this.fillBox = null;     // прямоугольник закрашенного, в клетках
    this.mask = null;        // переиспользуемая маска спорных клеток
    this.hatch = null;       // паттерн штриховки
    this.hatchPx = 0;
    this.points = 0;
    this.truncated = false;
    this.strokes = 0;        // вызовов stroke() в последнем кадре
  }

  // Смена пресета меняет разрешение выпечки — держать старый канвас незачем.
  setQuality(q) {
    this.q = q;
    this.key = '';
    this.cv = null; this.cx = null;
    this.hatch = null; this.hatchPx = 0;
  }

  bytes() { return canvasBytes(this.cv); }

  stats() {
    return {
      bakes: this.bakes, bakePx: this.bakePx, points: this.points,
      polys: this.layers.reduce((s, l) => s + l.polys.length, 0),
      owners: this.layers.length, truncated: this.truncated,
      strokes: this.strokes, bytes: this.bytes(),
    };
  }

  // Возвращает число вызовов stroke() — по нему главный разработчик может
  // сразу увидеть, во что слой обошёлся, не подключая профилировщик.
  //
  // opts: { enabled, mode: 'own'|'full', zoom }
  //   'own'  (по умолчанию, когда sim.showTerritory выключен) — заливка только
  //          своей земли и контуры всех: тихо, но «где кончается моё» видно;
  //   'full' (sim.showTerritory включён клавишей в hud.js) — полная политическая
  //          раскраска: заливка соседей и штриховка спорных клеток.
  draw(sim, ctx, ox, oy, z, cw, ch, opts = {}) {
    this.strokes = 0;
    if (opts.enabled === false) return 0;
    const st = bordersState(sim);
    if (!st) return 0;                       // границ ещё нет (старый сейв, первый день)

    const mode = opts.mode || (sim && sim.showTerritory ? 'full' : 'own');
    // zoom нужен только для LOD; если его не передали, восстанавливаем из z:
    // z = TILE_PX * zoom, TILE_PX = 32 — константа мировой единицы, а не пресета.
    const zoom = opts.zoom || z / 32;
    const lod = lodForZoom(this.q, zoom);

    this._ensure(sim, st, mode);
    if (!this.layers.length && !this.fillBox) return 0;

    this._blitFill(ctx, ox, oy, z, cw, ch, st);
    this._strokeOutlines(ctx, ox, oy, z, cw, ch, mode, lod);
    return this.strokes;
  }

  // ---- выпечка ------------------------------------------------------------

  _ensure(sim, st, mode) {
    const W = st.w, H = st.h;
    const bp = pickBakePx(this.q, W, H);
    // Ключ. recomputes растёт на каждом пересчёте в ядре — это и есть «версия
    // границ». version добавлен на случай загрузки сейва (там recomputes = 0,
    // а карта уже не пустая), lastDay — чтобы принудительный force-пересчёт с
    // тем же составом тоже дошёл до картинки. Режим и разрешение — потому что
    // при их смене выпечка обязана быть другой; смена режима это нажатие
    // клавиши, перепечь при ней 2,4 МБ дешевле, чем держать два канваса.
    const key = `${st.recomputes}|${st.version}|${st.lastDay}|${W}x${H}|${bp}|${mode}|${this.q.id}|${(sim.world && sim.world.seed) | 0}`;
    if (key === this.key && this.cv) return;
    this.key = key;
    this.bakePx = bp;
    this._bake(sim, st, mode, bp);
    this.bakes++;
  }

  _bake(sim, st, mode, bp) {
    const W = st.w, H = st.h;
    const cvW = W * bp, cvH = H * bp;
    if (!this.cv || this.cv.width !== cvW || this.cv.height !== cvH) {
      this.cv = document.createElement('canvas');
      this.cv.width = cvW; this.cv.height = cvH;
      this.cx = this.cv.getContext('2d');
      this.hatch = null; this.hatchPx = 0;   // паттерн живёт в контексте канваса
    }
    const c = this.cx;
    if (c.setTransform) c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cvW, cvH);
    this.fillBox = null;

    this._bakeFill(sim, st, mode, bp, c);
    if (mode === 'full' && this.q.detail >= 1) this._bakeHatch(sim, st, bp, c);
    this._traceAll(sim, st);
  }

  // Заливка. Ключевой приём — склейка по строке: подряд идущие клетки с тем же
  // владельцем и той же полосой затухания рисуются ОДНИМ fillRect. Территория
  // это крупные пятна, поэтому вместо 9216 прямоугольников выходит 200–900.
  _bakeFill(sim, st, mode, bp, c) {
    const W = st.w, H = st.h;
    const owners = st.owners, depth = st.depth;
    const seed = (sim.world && sim.world.seed) | 0;
    const onlyPlayer = mode !== 'full';
    // Строки 'rgba(...)' кешируются по паре код+полоса: их всего до 7×4 = 28,
    // а склеивать строку на каждый отрезок — мусор в горячем цикле выпечки.
    const styles = new Map();
    const styleOf = (code, band) => {
      const k = code * 8 + band;
      let s = styles.get(k);
      if (s === undefined) {
        s = _rgba(ownerColorOf(sim, code), FILL_BANDS[band]);
        styles.set(k, s);
      }
      return s;
    };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

    for (let y = 0; y < H; y++) {
      let runCode = 0, runBand = 0, runX = 0;
      // x идёт до W включительно: лишняя итерация с пустой клеткой закрывает
      // отрезок, доходящий до правого края, без дублирования кода после цикла.
      for (let x = 0; x <= W; x++) {
        let code = 0, band = 0;
        if (x < W) {
          const i = y * W + x;
          code = owners[i];
          if (code && onlyPlayer && code !== OWNER_PLAYER) code = 0;
          if (code) band = fillBand(depth[i], x, y, seed);
        }
        if (code !== runCode || band !== runBand) {
          if (runCode) {
            c.fillStyle = styleOf(runCode, runBand);
            c.fillRect(runX * bp, y * bp, (x - runX) * bp, bp);
            if (runX < x0) x0 = runX;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y + 1 > y1) y1 = y + 1;
          }
          runCode = code; runBand = band; runX = x;
        }
      }
    }
    if (x0 <= x1) this.fillBox = { x0, y0, x1, y1 };
  }

  // Штриховка спорных клеток. Все отрезки собираются в ОДИН путь и заливаются
  // паттерном за одну операцию: паттерн — это заливка «бесконечными» полосами,
  // и платить за неё имеет смысл ровно один раз, а не по клетке.
  _bakeHatch(sim, st, bp, c) {
    this.mask = contestedMask(st, sim.world, this.mask);
    const W = st.w, H = st.h;
    const m = this.mask;
    const pat = this._hatchPattern(bp, c);
    if (!c.beginPath || !c.rect || !c.fill) return;
    c.beginPath();
    let any = false;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let y = 0; y < H; y++) {
      let run = -1;
      for (let x = 0; x <= W; x++) {
        const on = x < W && m[y * W + x] === 1;
        if (on && run < 0) run = x;
        else if (!on && run >= 0) {
          c.rect(run * bp, y * bp, (x - run) * bp, bp);
          any = true;
          if (run < bx0) bx0 = run;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y + 1 > by1) by1 = y + 1;
          run = -1;
        }
      }
    }
    if (!any) return;
    // Если паттерн создать не удалось (нет createPattern — например, в тесте
    // под node), штриховка вырождается в ровную полупрозрачную заливку.
    // Хуже, но честнее, чем уронить кадр из-за декоративного слоя.
    c.fillStyle = pat || 'rgba(232,238,250,0.10)';
    c.fill();
    // Спорные клетки — часть картинки, и блит обязан их захватывать.
    if (!this.fillBox) this.fillBox = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    else {
      const f = this.fillBox;
      if (bx0 < f.x0) f.x0 = bx0;
      if (by0 < f.y0) f.y0 = by0;
      if (bx1 > f.x1) f.x1 = bx1;
      if (by1 > f.y1) f.y1 = by1;
    }
  }

  // Ячейка паттерна: диагональ из левого нижнего угла в правый верхний. Такая
  // диагональ стыкуется сама с собой при повторении без швов, поэтому хватает
  // одного отрезка. Период — полклетки выпечки: целая клетка даёт три жирные
  // полосы на всю спорную зону и читается как брак, а не как штриховка.
  _hatchPattern(bp, c) {
    const p = Math.max(4, bp >> 1);
    if (this.hatch && this.hatchPx === p) return this.hatch;
    if (typeof c.createPattern !== 'function') return null;
    try {
      const cv = document.createElement('canvas');
      cv.width = p; cv.height = p;
      const g = cv.getContext('2d');
      g.strokeStyle = 'rgba(240,244,255,0.42)';
      g.lineWidth = Math.max(1, p / 5);
      g.beginPath();
      g.moveTo(0, p); g.lineTo(p, 0);
      g.stroke();
      this.hatch = c.createPattern(cv, 'repeat');
      this.hatchPx = p;
      return this.hatch;
    } catch { return null; }
  }

  // Контуры всех владельцев. Порядок — игрок ПОСЛЕДНИМ: на стыке двух держав
  // линии лежат в одной и той же точке решётки, и сверху должна оказаться своя.
  _traceAll(sim, st) {
    const codes = [];
    if (st.tiles && st.tiles.length) {
      for (let code = 1; code < st.tiles.length; code++) if (st.tiles[code] > 0) codes.push(code);
    }
    if (!codes.length) {                     // сейв без счётчиков — считаем сами
      const seen = new Set();
      for (let i = 0; i < st.owners.length; i++) { const o = st.owners[i]; if (o) seen.add(o); }
      for (const o of seen) codes.push(o);
      codes.sort((a, b) => a - b);
    }
    codes.sort((a, b) => (a === OWNER_PLAYER ? 1 : 0) - (b === OWNER_PLAYER ? 1 : 0) || a - b);

    this.layers = [];
    this.points = 0;
    this.truncated = false;
    const hasPath2D = typeof Path2D === 'function';
    for (const code of codes) {
      const budget = MAX_POINTS - this.points;
      if (budget <= 0) { this.truncated = true; break; }
      const r = traceContours(st.owners, st.w, st.h, code, { maxPoints: budget });
      if (!r.polys.length) continue;
      this.points += r.points;
      if (r.truncated) this.truncated = true;
      let path = null;
      if (hasPath2D) {
        path = new Path2D();
        for (const p of r.polys) {
          const a = p.pts;
          path.moveTo(a[0], a[1]);
          for (let i = 2; i < a.length; i += 2) path.lineTo(a[i], a[i + 1]);
          if (p.closed) path.closePath();
        }
      }
      this.layers.push({ code, color: ownerColorOf(sim, code), polys: r.polys, path, bbox: r.bbox });
    }
  }

  // ---- кадр ---------------------------------------------------------------

  // Один drawImage. Источник вырезается по пересечению видимого прямоугольника
  // и прямоугольника закрашенного: без этого мы бы каждый кадр отдавали
  // растеризатору весь мир 96×96 даже тогда, когда владение игрока — пятно в
  // десять клеток, и платили бы за пустые пиксели полную цену блита с альфой.
  _blitFill(ctx, ox, oy, z, cw, ch, st) {
    const f = this.fillBox;
    if (!f || !this.cv) return;
    const bp = this.bakePx;
    let x0 = Math.max(f.x0, Math.floor((0 - ox) / z));
    let y0 = Math.max(f.y0, Math.floor((0 - oy) / z));
    let x1 = Math.min(f.x1, Math.ceil((cw - ox) / z));
    let y1 = Math.min(f.y1, Math.ceil((ch - oy) / z));
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(st.w, x1); y1 = Math.min(st.h, y1);
    if (x1 <= x0 || y1 <= y0) return;        // владения целиком за экраном
    // Сглаживание включаем явно и через save/restore: postfx.js и relief.js
    // переключают этот флаг на ОБЩЕМ контексте, и слой не имеет права зависеть
    // от того, кто рисовал перед ним. Нам смягчение нужно: без него растянутая
    // выпечка даёт лесенку из квадратов bakePx, а с ним — мягкую кромку,
    // ради которой всё и затевалось (см. «ЗАМЫЛЕННОСТЬ ЗАЛИВКИ» в шапке).
    ctx.save();
    if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      this.cv,
      x0 * bp, y0 * bp, (x1 - x0) * bp, (y1 - y0) * bp,
      ox + x0 * z, oy + y0 * z, (x1 - x0) * z, (y1 - y0) * z,
    );
    ctx.restore();
  }

  // Линии. Путь построен в КЛЕТОЧНЫХ координатах, поэтому камера задаётся
  // трансформацией, а толщина делится на z — так линия остаётся ровно LINE_*
  // экранных пикселей на любом зуме, и перестроение пути при зуме не нужно.
  _strokeOutlines(ctx, ox, oy, z, cw, ch, mode, lod) {
    if (!this.layers.length) return;
    // Видимая область в клетках с запасом в одну клетку — иначе линия,
    // проходящая ровно по краю экрана, отсеклась бы вместе со своей толщиной.
    const vx0 = (0 - ox) / z - 1, vy0 = (0 - oy) / z - 1;
    const vx1 = (cw - ox) / z + 1, vy1 = (ch - oy) / z + 1;
    const halo = this.q.detail >= 1 && !lod.far;
    const thin = lod.far ? 0.75 : 1;

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(z, z);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const l of this.layers) {
      const b = l.bbox;
      if (b && (b.x1 < vx0 || b.x0 > vx1 || b.y1 < vy0 || b.y0 > vy1)) continue;
      const own = l.code === OWNER_PLAYER;
      const w = (own ? LINE_OWN : LINE_OTHER) * thin;
      if (halo) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = HALO_COLOR;
        ctx.lineWidth = (w + LINE_HALO) / z;
        this._strokeLayer(ctx, l);
      }
      // В тихом режиме чужая линия приглушена: она нужна как ориентир
      // «дальше не моё», а не как заявление о себе.
      ctx.globalAlpha = own ? 1 : (mode === 'full' ? 0.95 : 0.7);
      ctx.strokeStyle = l.color;
      ctx.lineWidth = w / z;
      this._strokeLayer(ctx, l);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Path2D — один вызов на всю границу владельца: геометрию держит браузер,
  // JS в кадре не трогает ни одной точки. Ветка с ломаными нужна там, где
  // Path2D нет (node в тестах) — она делает то же самое, но руками.
  _strokeLayer(ctx, l) {
    this.strokes++;
    if (l.path) { ctx.stroke(l.path); return; }
    for (const p of l.polys) {
      const a = p.pts;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      for (let i = 2; i < a.length; i += 2) ctx.lineTo(a[i], a[i + 1]);
      if (p.closed) ctx.closePath();
      ctx.stroke();
    }
  }
}

// '#rrggbb' + альфа → 'rgba(r,g,b,a)'. Свой разбор, а не hex2rgb из palette.js
// плюс rgb2css: там результат склеивается из двух вызовов, а тут строка
// собирается один раз на код+полосу и кешируется.
function _rgba(hex, a) {
  let r = 106, g = 111, b = 122;
  if (typeof hex === 'string' && hex[0] === '#' && hex.length >= 7) {
    const v = parseInt(hex.slice(1, 7), 16);
    if (!Number.isNaN(v)) { r = (v >> 16) & 255; g = (v >> 8) & 255; b = v & 255; }
  }
  return `rgba(${r},${g},${b},${a})`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ПОДКЛЮЧЕНИЕ
//
// Все якоря ниже проверены grep -cF по app/src/render/renderer.js в том виде,
// в каком файл лежит сейчас. Отступы значимы — копировать строку целиком.
//
// ---------------------------------------------------------------------------
// 1) ИМПОРТ. Якорь (совпадений: 1):
//
// import { CityLights } from './city_lights.js';
//
//    СРАЗУ ПОСЛЕ него добавить:
//
// import { BordersView } from './borders_view.js';
//
// ---------------------------------------------------------------------------
// 2) КОНСТРУКТОР. Якорь (совпадений: 1):
//
//     this.cityLights = new CityLights(this.quality);    // окна и фонари ночью
//
//    СРАЗУ ПОСЛЕ него добавить:
//
//     this.bordersView = new BordersView(this.quality);  // границы владений
//
// ---------------------------------------------------------------------------
// 3) СМЕНА ПРЕСЕТА. Якорь (совпадений: 2 — строка 87 в setQuality() и строка
//    279 в tuneAuto(); отступ у обеих одинаковый, 4 пробела):
//
//     this.cityLights.setQuality(this.quality);
//
//    Добавить СРАЗУ ПОСЛЕ КАЖДОГО из двух вхождений одну и ту же строку:
//
//     this.bordersView.setQuality(this.quality);
//
//    Пропустить второе вхождение нельзя: авто-тюнер меняет пресет на ходу, и
//    слой останется с разрешением выпечки от прежнего пресета — не сломается,
//    но будет держать канвас не того размера до следующей смены качества.
//
// ---------------------------------------------------------------------------
// 4) ВЫЗОВ В КАДРЕ. Якорь (совпадений: 1):
//
//     if (sim.showTerritory) this.drawTerritory(sim, ctx, ox, oy, z);
//
//    РЕКОМЕНДУЕТСЯ ЗАМЕНИТЬ эту строку целиком на:
//
//     this.bordersView.draw(sim, ctx, ox, oy, z, cw, ch, { zoom: this.cam.zoom });
//
//    Почему замена, а не вставка рядом: drawTerritory рисует ДРУГИЕ границы —
//    свою вороную по поселениям с шагом step и порогом 0,35, не имеющую
//    отношения к owners[] из borders.js. Две несовпадающие границы на одной
//    карте — это прямая дезинформация: игрок будет платить налог и терять
//    отряды по одной линии, а видеть другую. Метод drawTerritory после этого
//    остаётся в файле неиспользованным — его удаление на усмотрение главного
//    разработчика, слой от этого не зависит.
//
//    Если по какой-то причине старую заливку решено сохранить, вставлять новую
//    строку нужно ПОСЛЕ якоря (границы поверх заливки, а не под ней).
//
//    Место в кадре выбрано не случайно: это после местности, воды, теней
//    облаков и растительности, но ДО поселений фракций и до
//    drawSortedEntities. Значит, граница лежит на земле и её перекрывают дома
//    и жители — так и должно быть; подними её выше, и линия поедет по крышам.
//
// ---------------------------------------------------------------------------
// 5) НИЧЕГО БОЛЬШЕ НЕ НУЖНО. Переключатель уже есть: hud.js на пункт меню
//    'territory' дёргает sim.showTerritory, слой читает его сам и переходит из
//    тихого режима («своя земля залита, контуры всех видны») в политический
//    («залиты все, спорные клетки заштрихованы»). Данные слой берёт из
//    sim.sys.borders, а если интегратор положит их в sim.borders — оттуда
//    (bordersState проверяет оба пути).
// ═══════════════════════════════════════════════════════════════════════════
