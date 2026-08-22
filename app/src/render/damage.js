// render/damage.js — следы разрушений: трещины, копоть, выбитые окна,
// обвалившийся угол, дым пожара и груда обломков на месте снесённой постройки.
//
// ЗАЧЕМ. Сейчас у постройки есть b.hp (стартовое значение — def.wall || 100,
// simulation.js) и флаг b.destroyed, но на экране ни то ни другое не читается:
// целое здание и здание в один удар от руины выглядят одинаково, а
// разрушенное просто исчезает — renderer.drawSortedEntities пропускает его
// строкой `if (b.destroyed) continue;`. Игрок видит пустую клетку и не знает,
// что там что-то стояло и это надо отстроить. Слой чинит ровно это: состояние
// постройки становится видимым, а руина остаётся на карте предметом, а не
// дыркой.
//
// ГРАНИЦЫ. Модуль — чистое представление. Он ЧИТАЕТ sim и не меняет в нём ни
// одного поля; ядро о нём не знает. Ни один существующий файл не тронут —
// подключение описано внизу, в блоке «ПОДКЛЮЧЕНИЕ». Импорт файла не имеет
// побочных эффектов: до первого кадра не создаётся ни одного канваса.
//
// СЛУЧАЙНОСТЬ. Math.random в проекте запрещён, а sim.rng рендеру запрещён
// вдвойне: рендер идёт с разной частотой у разных игроков, и каждый его вызов
// сдвинул бы состояние симуляции — сейв бы поплыл. Здесь свой хеш dhash() от
// координат постройки и sim.world.seed (тот же приём, что в water.js,
// relief.js, vegetation.js) и свой LCG rngFrom() для выпечки. Следствие: одно
// и то же здание в одном и том же мире трескается всегда одинаково, а два
// соседних дома трескаются по-разному.
//
// ЦЕНА КАДРА (оценка; метод А из docs/visual-performance-budget.md —
// Chromium/SwiftShader, 1600×900, dpr 1, пресет high, зум 1.0):
//
//   мирный город, повреждённых нет      ~0,00 мс — цикл выходит на первом же
//                                        сравнении hp, ни одного drawImage;
//   после рейда: 20 побитых + 8 руин
//   + 4 горящих (16 частиц дыма)        ~0,35 мс — 32 блита;
//   потолки насухо: 60 наложений
//   + 48 руин + 40 частиц               ~0,9 мс — 148 блитов.
//
// Почему так дёшево: в кадре нет НИ ОДНОГО примитива. Всё нарисованное —
// трещины, копоть, тёмные проёмы, обвал, обломки, клуб дыма — испечено в
// offscreen-канвас заранее, и в кадре остаётся drawImage. Наивная версия
// (рисовать ломаные и градиенты по 200 зданиям каждый кадр) — это ~40 путей
// на здание, то есть тысячи beginPath/stroke: на программном растеризаторе
// это единицы миллисекунд, весь бюджет кадра целиком.
//
// Выпечка не бесплатна (наложение — 1,5–3 мс, руина — ~0,8 мс), поэтому она
// нормирована: не больше q.caps.bakesPerFrame штук за кадр. Если бюджет
// исчерпан — здание кадр-другой выглядит целым. Это заметно только в момент
// массового разрушения и проходит за 2–3 кадра; альтернатива — рывок кадра на
// 30 мс в тот самый момент, когда на экране рейд.
import { BUILDINGS, BUILDING_ERA_IDX } from '../core/data.js';
import { ERA_PALETTE, shade } from './palette.js';
import { prune, touch, canvasBytes } from './quality.js';

// Мировая единица «тайл → экран» при zoom = 1. Та же константа, что в
// renderer.js, shadows.js и vegetation.js: нужна, чтобы перевести пришедший z
// обратно в зум и сверить его с порогами пресета (q.lod.* заданы в зумах).
const TILE_PX = 32;

// Потолки числа объектов в кадре. Именно потолки, а не цели: обычно их не
// достигают, но переполнение не должно стоить кадра. Дополнительно всё
// урезается пресетом — см. setQuality().
export const DAMAGE_LIMITS = {
  rubbleFrame: 48,   // руин в кадре; 48 блитов ≈ 0,15 мс, дальше не растём
  smokeFrame: 40,    // частиц дыма в кадре суммарно по всем очагам
  overlayEntries: 40, // записей в кэше наложений (LRU)
  rubbleEntries: 36, // записей в кэше руин (LRU)
  overlayMB: 6,      // память под наложения; ниже ещё режется q.caps.spriteMB
};

// Ступени повреждения по доле hp. Четыре ступени, а не непрерывная шкала:
// плавную деградацию пришлось бы либо рисовать в кадре, либо печь на каждый
// процент — и то и другое неприемлемо. Границы 0.86 / 0.62 / 0.38 / 0.16
// делят «живой» диапазон почти поровну (шаг ~0.24), чтобы ни одна ступень не
// мелькала: постройка успевает пожить в каждом состоянии.
//   1 — первые трещины и грязь;
//   2 — трещины гуще, копоть, часть окон выбита;
//   3 — обвалился угол, у цоколя лежат обломки;
//   4 — почти руина: горит.
export const STAGE_HP = [0.86, 0.62, 0.38, 0.16];

// Ступень, с которой постройка считается горящей, если ядро не сказало иначе.
const BURN_STAGE = 4;

// Сколько секунд дымятся свежие развалины. 25 с реального времени — примерно
// столько игрок смотрит на место после рейда; вечный дым над старым
// пепелищем читался бы как «здесь всё ещё пожар», а это неправда.
const RUBBLE_SMOKE_S = 25;

// Дым. RATE — сколько жизней частицы проходит за секунду: 0.42 даёт клуб раз
// в 2,4 с на частицу, при трёх частицах — примерно раз в 0,8 с. Быстрее —
// читается как пар из чайника, медленнее — как застывшая картинка.
const SMOKE_RATE = 0.42;
const SMOKE_RISE = 1.9;    // высота подъёма в тайлах
const SMOKE_R0 = 0.16;     // стартовый радиус клуба в долях тайла
const SMOKE_GROW = 1.5;    // во сколько раз клуб распухает к концу жизни

// Высота руины в долях ширины тайла. Груда обломков — это не здание: она
// низкая и плоская. 0.55 взято от самого низкого архетипа в sprites.ARCH_H
// (quarry 0.42) с запасом на торчащие балки.
const RUBBLE_HFACT = 0.62;

// Базовое разрешение выпечки руины на один тайл ширины по q.detail — те же
// три ступени, что у BASE в sprites.js, но грубее: у груды камней нет мелких
// деталей, которые стоило бы разрешать вдвое.
const RUBBLE_BASE = [40, 68, 92];

// --- детерминированная случайность ----------------------------------------

// Хеш от трёх целых. Тот же скелет, что у palette.hash2 (две смеси со сдвигом
// вправо), но с третьим входом: нам нужно развести не только координаты, но и
// зерно мира и номер частицы. Возвращает [0,1).
export function dhash(a, b, c) {
  let h = ((a | 0) * 374761393 + (b | 0) * 668265263 + (c | 0) * 1103515245) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Линейный конгруэнтный генератор для выпечки. Нужен именно поток, а не хеш:
// ломаная трещины — это 20 зависимых шагов, и звать dhash с новым индексом на
// каждый шаг дороже и хуже по качеству. Числа — классический Numerical
// Recipes; для декора этого более чем достаточно.
export function rngFrom(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// --- чтение состояния постройки -------------------------------------------

// Максимум hp. Симуляция ставит `hp: def.wall || 100` (simulation.js), поэтому
// максимум читается оттуда же. b.hpMax поддержан на случай, если ядро когда-то
// заведёт апгрейды стен: тогда слой не придётся править.
export function hpMaxOf(b) {
  const def = BUILDINGS[b.id];
  return b.hpMax || (def && def.wall) || 100;
}

// Доля здоровья в [0,1]. Постройка без поля hp считается целой: слой не должен
// разрисовывать трещинами весь город только потому, что ядро чего-то не завело.
export function hpFrac(b) {
  if (!b || b.hp === undefined || b.hp === null) return 1;
  const max = hpMaxOf(b);
  return max > 0 ? Math.max(0, Math.min(1, b.hp / max)) : 1;
}

// Ступень наложения 0..4 по hp. Разрушенная постройка сюда НЕ попадает: у неё
// не ступень, а совсем другой спрайт (груда обломков), и считать её «пятой
// ступенью» значило бы протащить руину через тот же кэш наложений.
export function damageStage(b) {
  if (!b || b.destroyed || !b.done) return 0;
  const f = hpFrac(b);
  for (let i = 0; i < STAGE_HP.length; i++) if (f > STAGE_HP[i]) return i;
  return STAGE_HP.length;
}

// Горит ли. Флаг ядра — приоритетнее: если когда-нибудь появится b.burning
// (событие «Пожар» в data.js его просится), слой подхватит его без правок.
export function isBurning(b, stage) {
  if (b && b.burning) return true;
  return stage >= BURN_STAGE;
}

// Эпоха отделки — та же формула, что в renderer.drawBuilding: постройка
// подтягивается к текущей эпохе, но не больше чем на три ступени от своей.
// Дублируется намеренно: обломки должны быть из того же материала, что стены,
// иначе каменный дом рассыпается в стеклобетон.
export function eraOf(b, sim) {
  const own = BUILDING_ERA_IDX[b.id] || 0;
  const cur = sim && sim.eraIndex !== undefined ? sim.eraIndex : own;
  return Math.max(own, Math.min(9, Math.min(cur, own + 3)));
}

// Вариант рисунка трещин: 4 штуки. Больше не нужно — рядом стоящие дома уже не
// повторяются, а каждый вариант это отдельная запись в кэше выпечки.
const VARIANTS = 4;
export function variantOf(b, seed) {
  return Math.floor(dhash(b.x * 3 + 11, b.y * 5 + 7, seed) * VARIANTS) % VARIANTS;
}

// --- мелочи ---------------------------------------------------------------

function mkCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  return cv;
}

// ---------------------------------------------------------------------------

export class DamageLayer {
  constructor(quality) {
    this.enabled = true;
    // Кэши: Map, потому что prune() из quality.js вытесняет по LRU именно
    // порядок вставки Map.
    this.overlays = new Map();   // `${sprId}|${stage}|${variant}` -> canvas
    this.rubble = new Map();     // `${era}|${size}|${variant}|${detail}` -> canvas
    // Спрайт зданий приходит извне и своего ключа не имеет. Ключ по b.id был бы
    // враньём: спрайт зависит ещё от эпохи, размера и detail, и после смены
    // эпохи наложение осталось бы от старого силуэта. WeakMap выдаёт спрайту
    // номер и умирает вместе с ним — при sprites.setQuality() кэш спрайтов
    // чистится, и наши ключи автоматически перестают совпадать.
    this._sprId = new WeakMap();
    this._nextSpr = 1;
    // Кто рухнул на наших глазах. WeakMap, а не Map: постройки из старого сейва
    // должны уходить в мусор вместе с симуляцией.
    this._fellAt = new WeakMap();
    this._sawAlive = new WeakSet();
    this._smoke = [];            // очаги дыма, собранные за кадр
    this.time = 0;
    this.wind = 0;
    this.puff = null;
    this.ember = null;
    this._stats = { overlays: 0, rubble: 0, puffs: 0, bakes: 0 };
    this.setQuality(quality);
  }

  setQuality(q) {
    this.q = q;
    // Потолки в кадре — от пресета. caps.buildings задаёт масштаб города,
    // который пресет вообще готов показывать; руин из них разумно допустить
    // до четверти (город, где каждое четвёртое здание — развалины, это уже
    // конец игры), но не больше жёсткого потолка.
    this.capRubble = Math.min(DAMAGE_LIMITS.rubbleFrame, Math.round(q.caps.buildings * 0.25));
    // Дым — частицы, значит масштабируется q.particles ровно как в weather.js
    // и fx.js: eco 0.2, medium 0.5, high 0.8, ultra 1.0.
    this.capSmoke = Math.round(DAMAGE_LIMITS.smokeFrame * q.particles);
    // Частиц на один очаг: 1 на eco, 2 на medium, 3 на high, 4 на ultra.
    this.perSource = Math.max(1, Math.min(4, Math.round(4 * q.particles)));
    // Наложений в кадре — сколько зданий пресет вообще рисует.
    this.capOverlay = q.caps.buildings;
    // Память под наложения: доля от бюджета спрайтов. Наложение весит столько
    // же, сколько спрайт (оно того же размера), поэтому больше трети отдавать
    // нельзя — вытеснит сами здания.
    this.overlayMB = Math.min(DAMAGE_LIMITS.overlayMB, q.caps.spriteMB * 0.33);
    // Пороги зума берём из пресета, а не из своих чисел: наложение имеет смысл
    // ровно тогда, когда здание проработано (buildingGlowMinZoom — тот самый
    // порог «здание ещё читается деталями»), а дым — когда пресет вообще
    // разрешает мелкий реквизит (propsMinZoom).
    // Кламп 1.2 нужен из-за eco: там propsMinZoom = 99, то есть «никогда», а
    // пожар — это не реквизит, а сообщение игроку. На eco дым остаётся, но
    // только вблизи и в количестве восьми клубов на весь кадр.
    this.overlayMinZoom = q.lod.buildingGlowMinZoom;
    this.smokeMinZoom = Math.min(q.lod.propsMinZoom, 1.2);
    // Смена пресета меняет разрешение выпечки — всё старое невалидно.
    this.clear();
  }

  clear() {
    this.overlays.clear();
    this.rubble.clear();
    this._smoke.length = 0;
    this.puff = null;
    this.ember = null;
  }

  stats() {
    return { ...this._stats, overlayCache: this.overlays.size, rubbleCache: this.rubble.size };
  }

  // ------------------------------------------------------------------ кадр

  // Один вызов на кадр, до всех остальных. Считает то, что не должно считаться
  // по 200 раз: зум, гейты, бюджет выпечки, и запоминает, кто рухнул только что.
  begin(sim, dtReal, z, opts = {}) {
    this.time += dtReal || 0;
    this.wind = opts.wind || 0;
    const zoom = z / TILE_PX;
    this.z = z;
    this.zoom = zoom;
    // Руина видна почти всегда: это игровая информация («здесь надо
    // отстроить»), а не украшение. Отсекаем только совсем дальний план, где
    // тайл мельче 6 px и груда обломков — это полтора пикселя.
    this.onRubble = this.enabled && z >= 6;
    this.onOverlay = this.enabled && zoom >= this.overlayMinZoom;
    this.onSmoke = this.enabled && this.capSmoke > 0 && zoom >= this.smokeMinZoom;
    // Бюджет выпечки на кадр — тот же, что у местности и спрайтов.
    this.bakeLeft = this.q.caps.bakesPerFrame;
    this._smoke.length = 0;
    this._stats.overlays = 0;
    this._stats.rubble = 0;
    this._stats.puffs = 0;
    this._stats.bakes = 0;
    this.seed = ((sim && sim.world && sim.world.seed) | 0) & 0xffff;
    this._markFallen(sim);
  }

  // Отметить постройки, рухнувшие с прошлого кадра. Нужно, чтобы свежие
  // развалины дымились, а старые (например, пришедшие из загруженного сейва) —
  // нет: пепелище, которому три игровых года, не горит.
  _markFallen(sim) {
    if (!sim || !sim.buildings) return;
    for (const b of sim.buildings) {
      if (b.destroyed) {
        if (!this._fellAt.has(b)) {
          // Видели живым — значит рухнуло при нас. Не видели — это руина из
          // сейва или из-за края экрана: помечаем временем в прошлом.
          this._fellAt.set(b, this._sawAlive.has(b) ? this.time : -1e9);
        }
      } else if (b.done) {
        this._sawAlive.add(b);
        // Отстроили заново — забываем время падения, иначе повторное
        // разрушение того же объекта пройдёт молча, без свежего дыма.
        if (this._fellAt.has(b)) this._fellAt.delete(b);
      }
    }
  }

  // --------------------------------------------------------- живые постройки

  // Наложение поверх спрайта постройки. Вызывается из renderer.drawBuilding в
  // тот же прямоугольник, в который лёг сам спрайт: наложение печётся ровно по
  // размеру спрайта, поэтому совпадает пиксель в пиксель при любом зуме.
  building(ctx, b, spr, dx, dy, dw, dh) {
    if (!this.enabled) return;
    const stage = damageStage(b);
    if (stage === 0) return;   // самый частый случай — выходим первым же сравнением
    // Дым от горящего собираем всегда, даже когда наложение выключено зумом:
    // столб дыма виден с той высоты, с которой трещины уже нет.
    if (isBurning(b, stage)) this._noteSmoke(b, dx + dw / 2, dy + dh * 0.34, 1);
    if (!this.onOverlay) return;
    if (this._stats.overlays >= this.capOverlay) return;
    const ov = this._overlay(spr, stage, variantOf(b, this.seed));
    if (!ov) return;           // бюджет выпечки на кадр исчерпан — кадр-другой цело
    ctx.drawImage(ov, dx, dy, dw, dh);
    this._stats.overlays++;
  }

  // --------------------------------------------------------------- руины

  // Отдельный проход по разрушенным постройкам: renderer их не рисует вовсе
  // (`if (b.destroyed) continue;` в drawSortedEntities), поэтому подмешаться в
  // общий Y-проход нельзя, не правя чужой файл.
  //
  // Сортировка по глубине руине не нужна: груда обломков лежит НИЖЕ линии
  // застройки любого соседа — здание, стоящее за ней (y меньше), растёт вверх
  // от своего же основания и физически не может её перекрыть. Поэтому проход
  // ставится перед общим Y-проходом, и житель, идущий по развалинам, честно
  // оказывается впереди них.
  drawRubble(sim, ctx, ox, oy, z, cw, ch) {
    if (!this.onRubble || !sim || !sim.buildings) return;
    for (const b of sim.buildings) {
      if (!b.destroyed) continue;
      if (this._stats.rubble >= this.capRubble) break;
      const size = (b.size || 1) * z;
      const sx = ox + b.x * z, sy = oy + b.y * z;
      // Отсечение по экрану с запасом в размер постройки: обломки шире клетки.
      if (sx < -size * 2 || sy < -size * 2 || sx > cw + size || sy > ch + size) continue;
      const cv = this._rubbleSprite(eraOf(b, sim), b.size || 1, variantOf(b, this.seed));
      if (!cv) continue;
      const dw = size * 1.16, dh = dw * RUBBLE_HFACT;
      ctx.drawImage(cv, sx - size * 0.08, sy + size - dh, dw, dh);
      this._stats.rubble++;
      // Свежее пепелище дымит и тлеет; старое — просто лежит.
      const fell = this._fellAt.get(b);
      if (fell !== undefined && this.time - fell < RUBBLE_SMOKE_S) {
        const k = 1 - (this.time - fell) / RUBBLE_SMOKE_S;
        this._noteSmoke(b, sx + size / 2, sy + size - dh * 0.5, k);
      }
    }
  }

  // ----------------------------------------------------------------- дым

  // Очаг дыма. heat ∈ (0,1] — насколько сильно дымит: у горящего здания 1, у
  // остывающего пепелища — убывает к нулю.
  _noteSmoke(b, x, y, heat) {
    if (!this.onSmoke || heat <= 0.02) return;
    this._smoke.push({ x, y, heat, hx: b.x | 0, hy: b.y | 0 });
  }

  // Флаш дыма — ПОСЛЕ зданий и жителей: дым идёт поверх крыш, иначе столб
  // упирается в конёк собственного дома.
  //
  // Частица считается аналитически из времени и хеша, без накопления
  // состояния: нет ни массива живых частиц, ни их отсева, ни зависимости от
  // частоты кадров. Побочная выгода — при паузе картинка не «сдувается»,
  // а при телепорте камеры дым не приезжает следом.
  drawSmoke(ctx) {
    if (!this._smoke.length || !this.onSmoke) return;
    const puff = this._puff();
    const ember = this._ember();
    const z = this.z;
    ctx.save();
    // Тление у основания — аддитивно, как все источники света в проекте.
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this._smoke) {
      if (s.heat < 0.35) continue;   // пепелище уже не светится, только дымит
      // Мерцание — сумма двух синусов с несоизмеримыми периодами и сдвигом от
      // хеша: у двух соседних пожаров огонь не бьётся в такт.
      const ph = dhash(s.hx, s.hy, 3) * 6.283;
      const fl = 0.62 + 0.24 * Math.sin(this.time * 5.1 + ph) + 0.14 * Math.sin(this.time * 8.7 + ph * 2);
      const r = z * 0.55;
      ctx.globalAlpha = Math.min(0.85, fl * s.heat);
      ctx.drawImage(ember, s.x - r, s.y - r * 0.75, r * 2, r * 1.5);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const s of this._smoke) {
      const n = Math.max(1, Math.round(this.perSource * (0.4 + 0.6 * s.heat)));
      for (let i = 0; i < n; i++) {
        if (this._stats.puffs >= this.capSmoke) break;
        const off = dhash(s.hx, s.hy, i + 1);
        // Фаза жизни частицы: равномерно разнесены по i, плюс сдвиг от хеша,
        // чтобы очаги не пыхали синхронно.
        const t = (this.time * SMOKE_RATE + off + i / n) % 1;
        const rise = t * SMOKE_RISE * z;
        // Снос: ветер сцены плюс собственное «виляние» клуба. Виляние —
        // синус от фазы, а не шум: дым поднимается не по линейке, но и не
        // дёргается.
        const drift = (this.wind * 0.9 * t + Math.sin((t + off) * 4.2) * 0.22 * t) * z;
        const r = z * SMOKE_R0 * (1 + SMOKE_GROW * t) * (0.6 + 0.4 * s.heat);
        // Появляется быстро (первые 15 % жизни), тает долго — так ведёт себя
        // настоящий клуб: рождается плотным и растворяется.
        const a = Math.min(1, t / 0.15) * (1 - t) * 0.55 * s.heat;
        if (a <= 0.01) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(puff, s.x + drift - r, s.y - rise - r, r * 2, r * 2);
        this._stats.puffs++;
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Клуб дыма — один раз за сессию, 64 px. Больше не нужно: на экране он
  // занимает 10–40 px, и увеличение мылом здесь работает нам на руку.
  _puff() {
    if (this.puff) return this.puff;
    const S = 64, cv = mkCanvas(S, S), c = cv.getContext('2d');
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    // Дым НЕ чёрный и не белый: чёрный превращается в дыру, белый — в облако.
    // Тёплый серый с уходом в коричневое — это сажа, поднятая горячим воздухом.
    g.addColorStop(0, 'rgba(96,86,78,0.85)');
    g.addColorStop(0.45, 'rgba(78,70,64,0.42)');
    g.addColorStop(1, 'rgba(70,63,58,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
    this.puff = cv;
    return cv;
  }

  // Зарево огня у основания.
  _ember() {
    if (this.ember) return this.ember;
    const S = 64, cv = mkCanvas(S, S), c = cv.getContext('2d');
    const g = c.createRadialGradient(S / 2, S * 0.62, 0, S / 2, S * 0.62, S / 2);
    g.addColorStop(0, 'rgba(255,206,120,0.9)');
    g.addColorStop(0.35, 'rgba(255,128,42,0.45)');
    g.addColorStop(1, 'rgba(180,60,20,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
    this.ember = cv;
    return cv;
  }

  // ------------------------------------------------------------- выпечка

  _sprKey(spr) {
    let id = this._sprId.get(spr);
    if (!id) { id = this._nextSpr++; this._sprId.set(spr, id); }
    return id;
  }

  _overlay(spr, stage, variant) {
    if (!spr || !spr.cv) return null;
    const key = `${this._sprKey(spr)}|${stage}|${variant}`;
    const hit = this.overlays.get(key);
    if (hit) { touch(this.overlays, key); return hit; }
    if (this.bakeLeft <= 0) return null;
    this.bakeLeft--; this._stats.bakes++;
    const cv = bakeOverlay(spr, stage, variant, this.q.detail);
    this.overlays.set(key, cv);
    prune(this.overlays, {
      maxEntries: DAMAGE_LIMITS.overlayEntries,
      maxBytes: this.overlayMB * 1024 * 1024,
      bytesOf: canvasBytes,
    });
    return cv;
  }

  _rubbleSprite(era, sizeTiles, variant) {
    const key = `${era}|${sizeTiles}|${variant}|${this.q.detail}`;
    const hit = this.rubble.get(key);
    if (hit) { touch(this.rubble, key); return hit; }
    if (this.bakeLeft <= 0) return null;
    this.bakeLeft--; this._stats.bakes++;
    const cv = bakeRubble(era, sizeTiles, variant, this.q.detail);
    this.rubble.set(key, cv);
    prune(this.rubble, {
      maxEntries: DAMAGE_LIMITS.rubbleEntries,
      maxBytes: this.overlayMB * 0.5 * 1024 * 1024,
      bytesOf: canvasBytes,
    });
    return cv;
  }
}

// ---------------------------------------------------------------------------
// ВЫПЕЧКА НАЛОЖЕНИЯ
//
// Главная сложность: архетипов силуэта в sprites.js больше двадцати, от
// кострища до шпиля, и слой ничего о них не знает. Угадывать, где у «reactor»
// фасад, а где купол, — путь к трещинам, висящим в небе.
//
// Решение: рисуем повреждения по ВСЕЙ площади кадра спрайта, а в самом конце
// вырезаем всё лишнее по силуэту самого спрайта (composite 'destination-in' с
// spr.sil — уже готовым чёрным силуэтом из sprites.bake). Трещина, попавшая
// мимо здания, исчезает сама; трещина на стене остаётся. Один и тот же код
// поэтому одинаково честно работает и для хижины, и для башни.
//
// Исключение — обломки у цоколя: они лежат НА ЗЕМЛЕ, то есть снаружи силуэта,
// и рисуются уже после обрезки.
// ---------------------------------------------------------------------------
export function bakeOverlay(spr, stage, variant, detail = 2) {
  const W = spr.cv.width, H = spr.cv.height;
  const cv = mkCanvas(W, H);
  const c = cv.getContext('2d');
  const dec = mkCanvas(W, H);
  const d = dec.getContext('2d');
  const rnd = rngFrom(variant * 2654435761 + stage * 40503 + W * 97 + 1);
  // Толщина линий в долях ширины спрайта, а не в пикселях: спрайт size-2
  // печётся вдвое крупнее, и фиксированный 1 px дал бы на нём паутинку.
  const k = Math.max(1, W / 100);
  // «Пол» спрайта — та же формула, что в sprites.bake: низ тайла.
  const groundY = H - W * 0.16;
  // Повреждения живут ниже конька и выше земли: у самой верхушки крыши
  // трещинам взяться неоткуда, а у земли их закрывают обломки.
  const top = H * 0.18, bot = groundY - H * 0.02;

  // 1) Общая грязь и гарь: очень слабый тёмный слой на весь силуэт. Один
  //    fillRect. Без него ступень 1 не читается вовсе — две трещины на светлой
  //    стене глаз пропускает.
  d.fillStyle = `rgba(46,36,28,${0.05 + 0.045 * stage})`;
  d.fillRect(0, 0, W, H);

  // 2) Копоть: вытянутые вверх пятна — так она и ложится, языками от проёмов.
  //    Радиальный градиент здесь допустим: это выпечка, он считается один раз.
  const soot = [0, 1, 2, 3, 4][stage] * (detail === 0 ? 1 : 2);
  for (let i = 0; i < soot; i++) {
    const x = W * (0.16 + rnd() * 0.68);
    const y = top + rnd() * (bot - top) * 0.8;
    const r = W * (0.10 + rnd() * 0.16);
    const g = d.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.16 + 0.09 * stage;
    g.addColorStop(0, `rgba(26,20,17,${a})`);
    g.addColorStop(1, 'rgba(26,20,17,0)');
    d.save();
    // Языки копоти выше, чем шире: сажа тянется вверх по стене.
    d.translate(x, y); d.scale(1, 1.9); d.translate(-x, -y);
    d.fillStyle = g;
    d.fillRect(x - r, y - r, r * 2, r * 2);
    d.restore();
  }

  // 3) Трещины. Ломаная сверху вниз со сносом в сторону и одним ответвлением.
  //    Каждая трещина рисуется дважды: тёмная линия — сама щель, и светлая на
  //    пиксель ниже-правее — скол штукатурки по её краю. Без второй линии
  //    трещина читается как царапина маркером, с ней — как разлом.
  const cracks = Math.round(([0, 2, 4, 6, 7][stage]) * (detail === 0 ? 0.5 : 1));
  for (let i = 0; i < cracks; i++) {
    const x0 = W * (0.14 + rnd() * 0.72);
    const y0 = top + rnd() * (bot - top) * 0.35;
    const len = (bot - y0) * (0.35 + rnd() * 0.55);
    const pts = crackPath(x0, y0, len, W * 0.14, rnd);
    strokePath(d, pts, `rgba(28,22,18,${0.45 + 0.09 * stage})`, k * 1.15);
    strokePath(d, pts, 'rgba(255,244,226,0.16)', k * 0.7, k * 0.8, k * 0.5);
    // Ответвление — только у заметных трещин: сеть паутинок на ступени 1
    // выглядит как разбитое стекло, а не как усталая стена.
    if (stage >= 2 && rnd() < 0.7) {
      const j = 2 + Math.floor(rnd() * Math.max(1, pts.length - 3));
      const br = crackPath(pts[j][0], pts[j][1], len * 0.45, W * 0.1, rnd);
      strokePath(d, br, `rgba(28,22,18,${0.35 + 0.07 * stage})`, k * 0.85);
    }
  }

  // 4) Выбитые окна. Где именно у постройки окна, знает только карта свечения
  //    spr.glow — она светится ровно там. Пользуемся ею как трафаретом:
  //    заливаем тёмным «сквозь» её альфу, а потом стираем часть — те окна, что
  //    уцелели. Так не нужно ни getImageData (дорого и однажды уже роняло
  //    кадр), ни знания о геометрии архетипа.
  if (stage >= 2 && spr.glow) {
    const wnd = mkCanvas(W, H);
    const w = wnd.getContext('2d');
    w.drawImage(spr.glow, 0, 0);
    w.globalCompositeOperation = 'source-in';
    // Выбитое окно — не чёрная дыра, а тёмный проём с холодным небом внутри.
    w.fillStyle = 'rgba(20,17,16,0.88)';
    w.fillRect(0, 0, W, H);
    // Стираем горизонтальными полосами: этажи бьёт не подряд, а вперемешку.
    w.globalCompositeOperation = 'destination-out';
    const keep = stage >= 4 ? 0.15 : stage === 3 ? 0.42 : 0.66; // доля уцелевших
    const rows = 7;
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < 4; col++) {
        if (rnd() > keep) continue;
        w.fillRect(W * col / 4, H * r / rows, W / 4 + 1, H / rows + 1);
      }
    }
    d.drawImage(wnd, 0, 0);
  }

  // 5) Обвалившийся угол. Стереть кусок уже нарисованного спрайта наложение не
  //    может — оно ложится ПОВЕРХ. Поэтому обвал рисуется тем, чем он на самом
  //    деле и выглядит: тёмным нутром здания за проломом, рваным краем кладки
  //    и парой торчащих балок. Глаз читает такое пятно как дыру, а не как
  //    кляксу, именно из-за рваного края — ровный прямоугольник читался бы как
  //    закрашенное окно.
  if (stage >= 3) {
    const right = (variant & 1) === 1;
    const w0 = W * (0.26 + rnd() * 0.1);
    const x0 = right ? W - w0 * 0.92 : w0 * -0.08;
    const yTop = top + (bot - top) * (0.18 + rnd() * 0.15);
    d.beginPath();
    d.moveTo(x0, bot);
    d.lineTo(x0, yTop);
    // Рваный край: 5 зубцов со случайным вылетом внутрь стены.
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ex = x0 + (right ? -1 : 1) * w0 * t;
      const ey = yTop + (bot - yTop) * t * (0.55 + rnd() * 0.5);
      d.lineTo(ex, ey - (bot - yTop) * 0.08 * rnd());
      d.lineTo(ex, ey);
    }
    d.lineTo(x0 + (right ? -w0 : w0), bot);
    d.closePath();
    d.fillStyle = 'rgba(22,18,16,0.82)';
    d.fill();
    // Балки перекрытия, повисшие в проломе.
    d.strokeStyle = 'rgba(52,40,30,0.9)';
    d.lineWidth = k * 1.4;
    for (let i = 0; i < 2; i++) {
      const y = yTop + (bot - yTop) * (0.3 + i * 0.3);
      d.beginPath();
      d.moveTo(x0 + (right ? -w0 * 0.9 : w0 * 0.9), y);
      d.lineTo(x0, y + (bot - yTop) * 0.16);
      d.stroke();
    }
  }

  // Обрезка по силуэту — единственная причина, по которой всё вышенарисованное
  // не висит в воздухе. spr.sil готов в sprites.bake; если его вдруг нет —
  // спрайт сам себе трафарет (у него та же альфа).
  d.globalCompositeOperation = 'destination-in';
  d.drawImage(spr.sil || spr.cv, 0, 0);

  c.drawImage(dec, 0, 0);

  // 6) Обломки у цоколя — ПОСЛЕ обрезки: они лежат на земле, снаружи силуэта.
  if (stage >= 3) {
    const n = stage === 4 ? 7 : 4;
    for (let i = 0; i < n; i++) {
      const x = W * (0.1 + rnd() * 0.8);
      const y = groundY - W * 0.02 + rnd() * W * 0.07;
      const s = W * (0.035 + rnd() * 0.05);
      c.fillStyle = `rgba(${80 + Math.round(rnd() * 30)},${70 + Math.round(rnd() * 26)},${62 + Math.round(rnd() * 22)},0.92)`;
      c.beginPath();
      c.moveTo(x - s, y + s * 0.4);
      c.lineTo(x - s * 0.4, y - s * 0.5);
      c.lineTo(x + s, y - s * 0.1);
      c.lineTo(x + s * 0.5, y + s * 0.5);
      c.closePath();
      c.fill();
      c.strokeStyle = 'rgba(26,20,16,0.7)';
      c.lineWidth = k * 0.6;
      c.stroke();
    }
  }
  return cv;
}

// Ломаная трещины: идёт вниз, виляя в стороны, с редкими резкими изломами —
// трещина в кладке не гладкая кривая, а цепочка сколов по швам.
export function crackPath(x, y, len, spread, rnd) {
  const steps = 6;
  const pts = [[x, y]];
  let cx = x, cy = y, vx = (rnd() - 0.5) * 0.6;
  for (let i = 0; i < steps; i++) {
    // Направление меняется плавно (инерция 0.65), поэтому трещина выглядит
    // распространяющейся, а не нарисованной дрожащей рукой.
    vx = vx * 0.65 + (rnd() - 0.5) * 0.9;
    cx += vx * spread / steps * 2;
    cy += len / steps;
    pts.push([cx, cy]);
  }
  return pts;
}

// Обводка ломаной со сдвигом — для «скола» рядом с самой щелью.
export function strokePath(c, pts, style, width, dx = 0, dy = 0) {
  c.strokeStyle = style;
  c.lineWidth = width;
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(pts[0][0] + dx, pts[0][1] + dy);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0] + dx, pts[i][1] + dy);
  c.stroke();
}

// ---------------------------------------------------------------------------
// ВЫПЕЧКА РУИНЫ
//
// Разрушенная постройка — не пустое место и не исчезнувший спрайт: это груда
// обломков ИЗ ТОГО ЖЕ материала, что стены (ERA_PALETTE эпохи), на выжженном
// пятне земли. Игрок должен по одному взгляду понять: тут стояло здание, его
// снесли, надо отстроить.
// ---------------------------------------------------------------------------
export function bakeRubble(era, sizeTiles, variant, detail = 2) {
  const W = Math.round(RUBBLE_BASE[detail] * sizeTiles);
  const H = Math.round(W * RUBBLE_HFACT);
  const cv = mkCanvas(W, H);
  const c = cv.getContext('2d');
  const rnd = rngFrom(variant * 22695477 + era * 7919 + sizeTiles * 131 + 3);
  const pal = ERA_PALETTE[Math.max(0, Math.min(9, era))];
  const k = Math.max(1, W / 90);
  const baseY = H * 0.84;   // линия земли: ниже неё только тень пятна

  // 1) Выжженное пятно. Ромб, а не круг: клетка карты квадратная, и пятно
  //    гари обязано читаться как след ИМЕННО этой постройки, иначе на плотной
  //    застройке непонятно, чья это руина.
  c.fillStyle = 'rgba(34,27,22,0.42)';
  c.beginPath();
  c.moveTo(W * 0.5, H * 0.52);
  c.lineTo(W * 0.96, baseY);
  c.lineTo(W * 0.5, H * 0.99);
  c.lineTo(W * 0.04, baseY);
  c.closePath();
  c.fill();

  // 2) Груда. Блоков ровно столько, чтобы читалась куча, а не россыпь:
  //    9 на eco (detail 0), 16 на остальных. Дальше глаз всё равно не считает,
  //    а каждая грань — это ещё один путь в выпечке.
  const n = detail === 0 ? 9 : 16;
  const blocks = [];
  for (let i = 0; i < n; i++) {
    // Куча выше в центре и сходит на нет к краям — иначе получается ковёр.
    const u = rnd() * 2 - 1;
    const x = W * 0.5 + u * W * 0.40;
    const hill = (1 - u * u) * H * 0.30;
    const y = baseY - rnd() * hill;
    blocks.push({ x, y, s: W * (0.055 + rnd() * 0.075), r: rnd() });
  }
  // Рисуем от дальних к ближним — иначе задние блоки лягут поверх передних.
  blocks.sort((a, b) => a.y - b.y);
  for (const bl of blocks) {
    // Тон блока разбегается вокруг цвета стены: одинаковые кубики читаются как
    // пиксель-арт по ошибке, а не как камень.
    const face = shade(pal.wall, -0.18 + bl.r * 0.3);
    const topF = shade(pal.wall, 0.12 + bl.r * 0.2);
    const s = bl.s;
    // Ложная изометрия та же, что у зданий: видно верх и переднюю грань.
    c.fillStyle = topF;
    c.beginPath();
    c.moveTo(bl.x - s, bl.y - s * 0.35);
    c.lineTo(bl.x - s * 0.2, bl.y - s * 0.75);
    c.lineTo(bl.x + s, bl.y - s * 0.3);
    c.lineTo(bl.x + s * 0.3, bl.y + s * 0.05);
    c.closePath();
    c.fill();
    c.fillStyle = face;
    c.beginPath();
    c.moveTo(bl.x - s, bl.y - s * 0.35);
    c.lineTo(bl.x + s * 0.3, bl.y + s * 0.05);
    c.lineTo(bl.x + s * 0.3, bl.y + s * 0.5);
    c.lineTo(bl.x - s, bl.y + s * 0.2);
    c.closePath();
    c.fill();
    c.strokeStyle = 'rgba(26,20,16,0.75)';
    c.lineWidth = k * 0.55;
    c.stroke();
  }

  // 3) Балки/арматура — то, что торчит из груды и делает её узнаваемой
  //    силуэтом. До железного века это обугленные брёвна, после — прутья.
  const beams = detail === 0 ? 2 : 3;
  c.lineCap = 'round';
  for (let i = 0; i < beams; i++) {
    const x = W * (0.2 + rnd() * 0.6);
    const y = baseY - rnd() * H * 0.1;
    const ang = (rnd() - 0.5) * 1.5 - 0.4;
    const len = W * (0.16 + rnd() * 0.16);
    c.strokeStyle = era <= 5 ? 'rgba(48,34,24,0.92)' : shade(pal.trim, -0.35);
    c.lineWidth = k * (era <= 5 ? 1.7 : 1.1);
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + Math.cos(ang) * len, y - Math.abs(Math.sin(ang)) * len - len * 0.2);
    c.stroke();
  }

  // 4) Пыль поверх груды — светлая дымка у основания. Она отделяет руину от
  //    земли: без неё груда выглядит вырезанной ножницами и наклеенной.
  const g = c.createRadialGradient(W * 0.5, baseY, 0, W * 0.5, baseY, W * 0.5);
  g.addColorStop(0, 'rgba(186,172,150,0.20)');
  g.addColorStop(1, 'rgba(186,172,150,0)');
  c.fillStyle = g;
  c.fillRect(0, H * 0.4, W, H * 0.6);
  return cv;
}

// ---------------------------------------------------------------------------
/* ПОДКЛЮЧЕНИЕ */
//
// Ниже — точные строки для app/src/render/renderer.js. Сам renderer.js этим
// агентом НЕ ТРОГАЛСЯ (чужая зона, одновременно правят ещё тринадцать
// агентов): вставлять руками. Каждый якорь проверён grep -F на уникальность в
// renderer.js на момент написания; число совпадений указано.
//
// 1) ИМПОРТ. Якорь (1 совпадение):
//
//      import { FxLayer } from './fx.js';
//
//    ПОСЛЕ него добавить:
//
//      import { DamageLayer } from './damage.js';
//
// 2) КОНСТРУКТОР Renderer. Якорь (1 совпадение):
//
//      this.shadows = new ShadowLayer(this.quality);
//
//    ПОСЛЕ него добавить:
//
//      this.damage = new DamageLayer(this.quality);
//
// 3) СМЕНА ПРЕСЕТА. Якорь:
//
//      this.fx.setQuality(this.quality);
//
//    встречается ДВАЖДЫ — в setQuality(id) и в tuneAuto(dtReal), и это
//    последняя строка блока переключения в обоих местах. ПОСЛЕ КАЖДОЙ из двух
//    добавить (отступ там 4 пробела в обоих случаях):
//
//      this.damage.setQuality(this.quality);
//
//    Пропустить вторую — значит получить наложения, испечённые под старое
//    разрешение, после срабатывания авто-тюнера.
//
// 4) НАЧАЛО КАДРА. Якорь (1 совпадение):
//
//      this.shadows.begin(sim, dtReal, z, { fog: this.atmo.fogK });
//
//    ПОСЛЕ него добавить:
//
//      this.damage.begin(sim, dtReal, z, { wind: this.atmo.wind });
//
//    Именно здесь: atmo.update() уже отработал выше по кадру, значит
//    this.atmo.wind — сегодняшний, а не вчерашний.
//
// 5) РУИНЫ и ДЫМ. Якорь (1 совпадение):
//
//      this.drawSortedEntities(sim, ctx, ox, oy, z, cw, ch, L);
//
//    ПЕРЕД этой строкой добавить:
//
//      this.damage.drawRubble(sim, ctx, ox, oy, z, cw, ch);
//
//    и СРАЗУ ПОСЛЕ неё добавить:
//
//      this.damage.drawSmoke(ctx);
//
//    Порядок принципиален. Руины — до общего Y-прохода: они лежат на земле, и
//    житель, идущий по развалинам, обязан быть впереди них. Дым — после: он
//    поднимается над крышами, а нарисованный до зданий столб упирался бы в
//    собственный конёк.
//
// 6) НАЛОЖЕНИЕ НА ЗДАНИЕ. Якорь (1 совпадение), внутри drawBuilding:
//
//      this._pendingGlow.push({ spr, dx, dy, dw, dh });
//
//    ПЕРЕД этой строкой добавить:
//
//      this.damage.building(ctx, b, spr, dx, dy, dw, dh);
//
//    Перед, а не после: свечение окон кладётся отдельным аддитивным проходом в
//    самом конце drawSortedEntities, и на порядок наложения это не влияет, но
//    строка _pendingGlow.push должна остаться последней в методе — так её
//    легче не потерять при следующих правках.
//
//    ВАЖНО: нарисованный арт (ветка `if (painted)` выше по методу) выходит из
//    drawBuilding своим return и наложения не получает. Это осознанно: у
//    нарисованного спрайта нет ни spr.sil, ни spr.glow, трафарета для обрезки
//    взять неоткуда. Если арт-пак когда-нибудь появится целиком, для него
//    нужен отдельный путь.
//
// 7) НЕОБЯЗАТЕЛЬНО. Новая игра / загрузка сейва (main.js, hud.js — чужая зона):
//
//      renderer.damage.clear();
//
//    Не обязательно: кэш наложений привязан к объектам спрайтов через WeakMap
//    и умирает вместе с ними, кэш руин вытесняется по LRU.
//
// ---------------------------------------------------------------------------
// ЧТО ПОЛУЧАЕТСЯ
//
//   • hp постройки виден: 4 ступени от «первые трещины» до «горит и вот-вот
//     рухнет», форма трещин зафиксирована координатами — одно здание всегда
//     трескается одинаково, соседнее по-другому;
//   • выбитые окна берутся из карты свечения самого спрайта, то есть гаснут
//     ровно те окна, что были;
//   • обвалившийся угол на ступенях 3–4 плюс обломки у цоколя;
//   • разрушенная постройка остаётся на карте грудой обломков своей эпохи на
//     выжженном ромбе — «здесь что-то было, надо чинить», а не пустая трава;
//   • свежее пепелище дымит 25 секунд и тлеет, потом остывает;
//   • горящее здание дымит постоянно, с заревом у основания.
//
// ПРЕСЕТЫ
//
//   eco    — наложения с зума 1.2, трещин вдвое меньше, блоков в груде 9,
//            дым только вблизи (зум ≥ 1.2), 1 частица на очаг, потолок 8.
//            Пожар — игровая информация, а не украшение, поэтому даже здесь он
//            не выключен полностью; восемь блитов 20-пиксельных клубов стоят
//            меньше, чем один кадр промахнувшегося игрока.
//   medium — наложения с 0.8, дым с 1.0, 2 частицы на очаг, потолок 20.
//   high   — наложения с 0.6, дым с 0.8, 3 частицы, потолок 32.
//   ultra  — наложения с 0.5, дым с 0.6, 4 частицы, потолок 40.
//   Руины видны на всех пресетах, пока тайл не мельче 6 px.
//
// РУЧКИ СНАРУЖИ
//
//   renderer.damage.enabled = false;   // выключить слой целиком
//   renderer.damage.stats()            // { overlays, rubble, puffs, bakes, ... }
