// render/era_transition.js — киношный переход эпохи: затемнение, титр, волна
// света от кострища и перекраска мира за этой волной.
//
// ЗАЧЕМ. Смена эпохи — самое важное событие партии: за ней стоят десятки
// минут игры. До этого слоя она выглядела как строка в журнале и бейдж в HUD,
// то есть проходила незамеченной. Здесь она занимает две с половиной секунды
// экрана и при этом НЕ останавливает игру: слой лежит поверх кадра, симуляция
// продолжает тикать, панорама работает, пропустить можно кликом.
//
// ЧТО ПРОИСХОДИТ НА ЭКРАНЕ (таймлайн в TL, секунды):
//   0,00–0,30  диафрагма сжимается к центру: тёмное кольцо по краям кадра
//              наезжает внутрь (баланс яркости, чтобы титр читался);
//   0,12–0,46  проявляется титр: «НОВАЯ ЭПОХА», название и годы из ERAS;
//   0,18–2,02  от кострища расходится кольцо света; всё, что оно накрыло,
//              уже нарисовано в новой эпохе, снаружи — старый мир;
//   1,86–2,34  титр уходит, диафрагма раскрывается;
//   2,50       слой выключается и освобождает все свои канвасы.
//
// ГЛАВНЫЙ ФОКУС — КАК СДЕЛАНА ВОЛНА БЕЗ ПЕРЕВЫПЕЧКИ.
// Наивный путь: на каждом кадре волны решать по каждой клетке, в какой она
// палитре, и перепекать чанки местности. Это десятки чанков по 32×32 клетки
// сто пятьдесят кадров подряд — гарантированные полсекунды фризов ровно в тот
// момент, когда игрок смотрит на экран внимательнее всего.
// Здесь вместо этого один снимок. На первом же кадре новой эпохи холст ещё
// хранит ПРЕДЫДУЩИЙ кадр, нарисованный целиком по старым правилам (main.js
// вызывает sim.tick() до renderer.draw(), так что кадр на холсте всегда на
// один тик старше состояния). Мы копируем холст в offscreen — это и есть
// «старый мир», готовый, испечённый, бесплатный. Дальше renderer как ни в чём
// не бывало рисует НОВЫЙ мир, а мы поверх кладём снимок, обрезанный по кольцу
// «снаружи радиуса». Внутри радиуса виден живой новый кадр, снаружи — снимок.
// Никакой второй выпечки не существует в природе: та единственная, что нужна
// (terrain.ensure видит смену эпохи и перепекает чанки с дорогами — материал
// дороги зависит от эпохи, roadMatIndex), случается сама, на первом кадре
// перехода, и полностью спрятана за снимком и за темнотой диафрагмы.
//
// Снимок привязан к МИРУ, а не к экрану: на первом кадре запоминается камера
// (ox, oy, z), дальше снимок блитится со сдвигом и масштабом относительно
// текущей камеры. Иначе игрок, панорамирующий во время перехода, увидел бы,
// как старый мир едет отдельно от нового и на шве двоятся дома.
//
// ЦЕНА КАДРА (оценка; стенд из docs/visual-performance-budget.md — SwiftShader,
// растеризация на CPU, 1280×720, то есть худший случай, на GPU дешевле):
//   вне перехода .................................. 0 мс: draw() выходит первой
//                                                   строкой, begin() — это одно
//                                                   сравнение sim.eraIndex;
//   кадр перехода, high/ultra:
//     блит снимка с клипом «вне круга» ............ ~0,50 мс (полный экран в
//                                                   худшем случае, дальше
//                                                   меньше — круг растёт)
//     тон новой эпохи внутри круга ................ ~0,45 мс (заливка круга)
//     кольцо волны: 3 обводки дуги ................ ~0,20 мс (2πR × 39 px,
//                                                   не полный экран)
//     искры на фронте, потолок 64 ................. ~0,05 мс (fillRect 2×2)
//     блит диафрагмы (выпечен, 256×144 → экран) ... ~0,50 мс
//     блит титра (выпечен) ........................ ~0,15 мс
//   итого ......................................... ~1,9 мс из 16,6
//   eco (detail 0) — снимка и тона нет вовсе, остаются диафрагма, кольцо и
//   титр ......................................... ~0,8 мс
// Всё это живёт 2,5 секунды и повторяется девять раз за партию.
//
// ОДНОРАЗОВЫЕ ЗАТРАТЫ разнесены по трём первым кадрам НАМЕРЕННО: снимок (~3 мс
// на 1280×720) обязан лечь в первый кадр, а титр (текст с обводкой, ~1,5 мс) и
// диафрагма (~0,3 мс) — во второй и третий. Свалить их в один кадр нельзя: там
// уже стоит перевыпечка дорожных чанков от terrain, и суммарно вышел бы
// заметный рывок именно на первом кадре шоу. До t = 0,12 титр всё равно
// прозрачен, так что зритель ничего не теряет.
//
// ПОТОЛКИ. Снимок ограничен и по площади (SNAP_MAX_PX), и долей от
// q.caps.textureMB, и освобождается сразу по окончании перехода — держать
// 12 МБ канваса между эпохами незачем. Искр не больше SPARK_MAX, ещё и
// умножено на q.particles. Кольцо — фиксированные 3 полосы (2 на eco).
//
// СЛУЧАЙНОСТЬ. Ни Math.random, ни sim.rng: рендер идёт с разной частотой у
// разных игроков, и вызов sim.rng сдвинул бы состояние симуляции — сейв бы
// поплыл. Искры разложены детерминированным смесителем hashE от sim.world.seed
// и номера эпохи — тот же приём, что в water.js / relief.js / vegetation.js.
//
// ЯДРО О СЛОЕ НЕ ЗНАЕТ. Мы только читаем sim.eraIndex, sim.world и список
// построек. Единственное, что слой пишет наружу, — свой обработчик клика
// «пропустить», и тот снимается по окончании.
import { ERAS } from '../core/data.js';
import { hex2rgb } from './palette.js';

const TAU = Math.PI * 2;

// Таймлайн перехода, секунды. Вынесен наружу, потому что по нему считает и
// код, и тест: если правишь числа — правь здесь, а не в теле draw().
export const TL = {
  total: 2.50,
  waveFrom: 0.18, waveTo: 2.02,   // кольцо стартует чуть позже темноты:
                                  // сначала гаснет кадр, потом бьёт свет
  dimIn: 0.30, dimOut: 0.55,
  cardIn: [0.12, 0.46], cardOut: [1.86, 2.34],
  // Клик в первые 0,35 с не считается пропуском. Эпоху почти всегда открывает
  // клик по дереву технологий; следующий за ним случайный клик (или дабл-клик
  // по той же кнопке) убил бы шоу до того, как игрок понял, что оно началось.
  skipAfter: 0.35,
  // Пропуск не обрывает картинку рывком, а доигрывает её ускоренно: волна
  // добегает и титр гаснет за ~0,6 с вместо оставшихся двух секунд.
  skipRate: 3.4,
};

// Потолок площади снимка в пикселях устройства. 3,2 млн — это 12,8 МБ на
// канвас. Выше начинается ultra на большом экране (maxCanvasPx 6,5 млн), и там
// снимок пойдёт с уменьшением до ~0,7 — при том, что он всё время под
// затемнением и под движущимся кольцом, разница неразличима, а память вдвое.
const SNAP_MAX_PX = 3.2e6;

// Потолок искр на фронте волны при q.particles = 1 (ultra). eco с его 0,2
// получит 13 штук. Это ровно тот случай, когда «потолок числа объектов» стоит
// подпереть и множителем пресета, и абсолютным числом.
const SPARK_MAX = 64;

// Пресет-заглушка: слой обязан пережить вызов без quality (тест, ранний кадр).
const Q_FALLBACK = { detail: 2, particles: 1, caps: {} };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, k) => a + (b - a) * k;

// Сглаженная ступенька. Волна на ней разгоняется от кострища и мягко
// останавливается у края экрана; линейный рост читается как «ползёт круг»,
// а не как «ударил свет».
export function smooth(u) {
  u = clamp01(u);
  return u * u * (3 - 2 * u);
}

// --- чистые функции таймлайна: их же гоняет тест ---------------------------
export function waveK(t) { return smooth((t - TL.waveFrom) / (TL.waveTo - TL.waveFrom)); }

export function dimK(t) {
  const a = smooth(t / TL.dimIn);
  const b = smooth((TL.total - t) / TL.dimOut);
  return clamp01(Math.min(a, b));
}

// Титр: прозрачность и масштаб. Масштаб чуть больше единицы на входе и на
// выходе — приём из монтажа, кадр «дышит» и текст не выглядит наклейкой.
export function cardK(t) {
  const inK = smooth((t - TL.cardIn[0]) / (TL.cardIn[1] - TL.cardIn[0]));
  const outK = smooth((TL.cardOut[1] - t) / (TL.cardOut[1] - TL.cardOut[0]));
  return { a: clamp01(Math.min(inK, outK)), scale: 1 + 0.05 * (1 - inK) + 0.03 * (1 - outK) };
}

// Радиус, при котором круг гарантированно накрыл кадр: до самого дальнего угла
// плюс 3 % запаса. Считать по половине диагонали нельзя — центр волны сидит на
// кострище, а оно может быть у самого края экрана или вообще за ним.
export function maxRadius(cx, cy, cw, ch) {
  const dx = Math.max(Math.abs(cx), Math.abs(cw - cx));
  const dy = Math.max(Math.abs(cy), Math.abs(ch - cy));
  return Math.sqrt(dx * dx + dy * dy) * 1.03;
}

export function sparkCount(q) {
  const p = q && typeof q.particles === 'number' ? q.particles : 1;
  return Math.max(0, Math.min(SPARK_MAX, Math.round(SPARK_MAX * p)));
}

// Смеситель palette.hash2, но с сидом мира и солью: одна и та же эпоха в одном
// и том же мире всегда рассыпает искры одинаково, а разные свойства одной искры
// (угол, отставание от фронта, фаза мерцания) не коррелируют между собой —
// иначе все дальние искры оказались бы ещё и самыми тусклыми.
export function hashE(seed, i, salt) {
  let h = (i * 374761393 + salt * 668265263 + (seed | 0) * 1442695041) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Текст титра. Отдельной функцией, потому что индекс эпохи приходит из ядра и
// теоретически может выйти за границы ERAS (консольная команда `era 99`,
// битый сейв) — падать из-за этого рендеру нельзя.
export function eraCard(i) {
  const e = ERAS[Math.max(0, Math.min(ERAS.length - 1, i | 0))] || ERAS[0];
  return { ru: e.ru, years: e.years, hue: e.hue };
}

// ---------------------------------------------------------------------------
export class EraTransition {
  constructor(quality) {
    this.q = quality || Q_FALLBACK;
    this.enabled = true;

    this.era = null;        // последняя увиденная эпоха; null = ещё не смотрели
    this.seed = null;       // сид мира: смена мира — не смена эпохи
    this.active = false;
    this.t = 0;
    this.rate = 1;
    this.frame = 0;
    this.from = 0;          // с какой эпохи ушли — по ней красится хвост волны
    this.skipped = false;

    this.snap = null;       // снимок старого мира (offscreen)
    this.cam0 = null;       // камера на момент снимка: {ox, oy, z}
    this.card = null;       // выпеченный титр
    this.cardCss = null;    // его размер в CSS-пикселях
    this.dim = null;        // выпеченная диафрагма
    this.dimFor = 0;        // соотношение сторон, под которое она выпечена
    this.dpr = 1;
    this.fire = null;       // кэш положения кострища на время перехода
    this.onSkip = null;     // установленный обработчик, чтобы было что снять
    this.bakes = 0;         // счётчик выпечек — для stats() и теста
  }

  setQuality(q) {
    if (q) this.q = q;
    // Пресет меняет и dpr, и размеры холста: выпеченное под старый уже не
    // годится. Снимок при этом НЕ трогаем — он про мир, а не про пресет.
    this.card = null; this.dim = null;
  }

  // --- вызывается в самом начале renderer.draw(), ДО очистки холста ---------
  // Здесь и только здесь холст ещё хранит предыдущий кадр — старый мир.
  begin(sim, ctx, dtReal, quality, dpr) {
    if (quality) this.q = quality;
    if (dpr) this.dpr = dpr;
    if (!sim || !sim.world) return;

    const era = sim.eraIndex | 0;
    const seed = sim.world.seed | 0;

    // Новый мир (новая партия, загрузка сейва) — просто синхронизируемся.
    // Показывать «наступила эпоха» на загрузке сохранения было бы враньём.
    if (this.seed !== seed) { this.stop(); this.seed = seed; this.era = era; return; }
    if (this.era === null) { this.era = era; return; }

    if (era !== this.era) {
      const prev = this.era;
      this.era = era;
      if (era > prev && this.enabled) this.start(sim, ctx, prev);
      else this.stop();               // откат эпохи бывает только из консоли
    }

    if (!this.active) return;

    // Снимок обязан быть сделан до того, как renderer затрёт холст небом.
    if (this.frame === 0) this.capture(ctx);

    this.t += Math.max(0, dtReal || 0) * this.rate;
    this.frame++;
    if (this.t >= TL.total) this.stop();
  }

  start(sim, ctx, from) {
    // Повторная смена эпохи прямо во время перехода (рывок по технологиям)
    // не должна делать второй снимок: на холсте сейчас не старый мир, а наше
    // же шоу. Перезапускаем только таймлайн и титр.
    const already = this.active;
    this.active = true;
    this.t = 0; this.rate = 1; this.skipped = false;
    this.from = from;
    this.card = null;
    this.fire = null;
    if (!already) { this.frame = 0; this.snap = null; this.cam0 = null; }
    else this.frame = Math.max(1, this.frame);   // снимок уже есть — не повторять
    this.bindSkip(ctx);
  }

  stop() {
    this.active = false;
    this.t = 0; this.rate = 1; this.frame = 0;
    // Освобождаем сразу: снимок — это до 12 МБ, а до следующей эпохи могут
    // пройти десятки минут. Титр и диафрагма дёшевы, но живут ровно столько же.
    this.snap = null; this.cam0 = null; this.card = null; this.dim = null;
    this.fire = null;
    this.unbindSkip();
  }

  skip() {
    if (!this.active || this.t < TL.skipAfter) return false;
    this.skipped = true;
    this.rate = TL.skipRate;
    return true;
  }

  // --- копия предыдущего кадра ---------------------------------------------
  capture(ctx) {
    const src = ctx && ctx.canvas;
    if (!src || !src.width || !src.height || typeof document === 'undefined') return;
    const W = src.width | 0, H = src.height | 0;
    // Доля от текстурного бюджета пресета: 35 % — снимок живёт две с половиной
    // секунды рядом с чанками местности и спрайтами, забирать у них больше
    // трети кэша нельзя. 262144 = 1 МБ пикселей RGBA.
    const capPx = this.q.caps && this.q.caps.textureMB
      ? this.q.caps.textureMB * 0.35 * 262144 : SNAP_MAX_PX;
    const k = Math.min(1, Math.sqrt(Math.min(SNAP_MAX_PX, capPx) / (W * H)));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(W * k));
    cv.height = Math.max(1, Math.round(H * k));
    const c = cv.getContext('2d');
    if (!c) return;
    c.drawImage(src, 0, 0, cv.width, cv.height);
    this.snap = cv;
    this.bakes++;
  }

  // --- сам кадр перехода ----------------------------------------------------
  // Ставится в самом конце draw(): переход обязан лежать поверх погоды, тона
  // времени суток и виньетки. Иначе ночной тон затемнил бы титр, а виньетка
  // съела бы кольцо волны у краёв кадра.
  draw(sim, ctx, ox, oy, z, cw, ch) {
    if (!this.active || !sim || !ctx) return;
    const q = this.q || Q_FALLBACK;
    const t = this.t;
    const detail = q.detail | 0;

    // Камера на момент снимка. Записать её в capture() нельзя: там нет ox/oy,
    // а расхождение в один кадр панорамы — это несколько пикселей.
    if (!this.cam0) this.cam0 = { ox, oy, z };
    // Выпечки по одной на кадр — см. шапку файла.
    if (!this.card) this.bakeCard(cw, ch);
    else if (!this.dim) this.bakeDim(cw, ch);

    const f = this.firePos(sim);
    const cx = ox + f.x * z, cy = oy + f.y * z;
    const R = waveK(t) * maxRadius(cx, cy, cw, ch);
    const S = Math.min(cw, ch) / 720;      // масштаб толщин под размер кадра

    if (detail > 0 && this.snap) this.drawOldWorld(ctx, ox, oy, z, cw, ch, cx, cy, R);
    if (detail > 0) this.drawRepaint(ctx, cx, cy, R, cw, ch);
    this.drawRing(ctx, cx, cy, R, S, t);
    this.drawSparks(ctx, sim, cx, cy, R, S, t);
    this.drawDim(ctx, cw, ch, t);
    this.drawCard(ctx, cw, ch, t);
  }

  // Старый мир — снаружи круга. Клип «прямоугольник минус круг» по правилу
  // evenodd: один блит, ни одного промежуточного канваса, а пиксели внутри
  // круга вообще не трогаются. Вариант «нарисовать снимок целиком, потом
  // вырезать дырку» потребовал бы третьего полноэкранного канваса и трёх
  // проходов по нему вместо одного.
  drawOldWorld(ctx, ox, oy, z, cw, ch, cx, cy, R) {
    const c0 = this.cam0;
    const k = c0.z > 0 ? z / c0.z : 1;
    // Снимок закреплён за миром: точка, бывшая на экране в s0, теперь обязана
    // оказаться в k*s0 + (ox - k*ox0).
    const dx = ox - k * c0.ox, dy = oy - k * c0.oy;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    if (R > 0.5) ctx.arc(cx, cy, R, 0, TAU);
    ctx.clip('evenodd');
    ctx.drawImage(this.snap, dx, dy, cw * k, ch * k);
    ctx.restore();
  }

  // Перекраска: внутри круга кадр уже нарисован по-новому, но разница между
  // соседними эпохами в палитре мягкая, и без подсказки глаз её не поймает.
  // Кладём тон новой эпохи, сильный у фронта и почти исчезнувший в центре, —
  // получается «краска, которую волна везёт с собой» и которая осела за ней.
  //
  // Композитные режимы 'overlay' и 'soft-light' здесь смотрелись бы богаче, но
  // на программном растеризаторе они стоят два-три обычных заливок, а это
  // полный экран каждый кадр. Обычная заливка с малой прозрачностью даёт
  // 90 % эффекта за 30 % цены.
  drawRepaint(ctx, cx, cy, R, cw, ch) {
    if (R < 2) return;
    const c = hex2rgb(eraCard(this.era).hue);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},0.02)`);
    g.addColorStop(0.72, `rgba(${c[0]},${c[1]},${c[2]},0.09)`);
    g.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0.26)`);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.clip();
    ctx.fillStyle = g;
    // Заливаем только габарит круга, а не весь кадр: при малом радиусе это
    // разница в десятки раз по числу пикселей.
    ctx.fillRect(Math.max(0, cx - R), Math.max(0, cy - R),
      Math.min(cw, R * 2), Math.min(ch, R * 2));
    ctx.restore();
  }

  // Кольцо волны. Три обводки дуги вместо одного блита градиентного спрайта:
  // спрайт пришлось бы тянуть на 2R, то есть платить прозрачностью за всю
  // площадь круга, а обводка красит только свою полосу — 2πR × 39 px.
  // Заодно яркая полоса прячет шов между старым и новым миром: клип по кругу
  // даёт жёсткую границу, и без света она читалась бы как дырка.
  drawRing(ctx, cx, cy, R, S, t) {
    if (R < 1) return;
    const fade = clamp01(Math.min(1, (t - TL.waveFrom) * 6)) * clamp01((TL.waveTo + 0.35 - t) * 2.2);
    if (fade <= 0.01) return;
    const now = hex2rgb(eraCard(this.era).hue);
    const then = hex2rgb(eraCard(this.from).hue);
    // Хвост кольца — угли уходящей эпохи, фронт — цвет наступившей.
    const warm = [
      Math.round(lerp(then[0], 255, 0.55)),
      Math.round(lerp(then[1], 176, 0.55)),
      Math.round(lerp(then[2], 87, 0.55)),
    ];
    const bands = (this.q.detail | 0) > 0
      ? [[26, 0.16, warm, 10], [10, 0.34, now, 2], [3, 0.72, [255, 246, 224], 0]]
      : [[14, 0.22, warm, 6], [3, 0.6, now, 0]];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [w, a, col, back] of bands) {
      const r = R - back * S;
      if (r <= 0.5) continue;
      ctx.globalAlpha = a * fade;
      ctx.lineWidth = Math.max(1, w * S);
      ctx.strokeStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Искры на фронте: без них кольцо — просто ровная дуга, а с ними это огонь,
  // который несут от кострища. Позиции детерминированы (см. hashE), количество
  // ограничено дважды — пресетом и SPARK_MAX.
  drawSparks(ctx, sim, cx, cy, R, S, t) {
    const n = sparkCount(this.q);
    if (!n || R < 4) return;
    const fade = clamp01((TL.waveTo + 0.2 - t) * 2) * clamp01((t - TL.waveFrom) * 5);
    if (fade <= 0.02) return;
    const seed = (sim.world && sim.world.seed) | 0;
    const salt = (this.era + 1) * 977;
    const c = hex2rgb(eraCard(this.era).hue);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < n; i++) {
      const a0 = hashE(seed, i, salt) * TAU;
      // Медленный снос по углу: искры не приклеены к своим лучам, иначе на
      // большом радиусе видно «спицы колеса».
      const a = a0 + (hashE(seed, i, salt + 7) - 0.5) * 0.7 * t;
      const back = hashE(seed, i, salt + 13);
      const r = R - back * back * 46 * S;      // квадрат — гуще у самого фронта
      if (r < 2) continue;
      const tw = 0.45 + 0.55 * Math.abs(Math.sin(t * 9 + hashE(seed, i, salt + 23) * TAU));
      const s = (1 + hashE(seed, i, salt + 31) * 1.8) * S;
      ctx.globalAlpha = fade * tw * (0.35 + 0.65 * (1 - back));
      ctx.fillStyle = back < 0.4 ? '#fff6e0' : `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fillRect(cx + Math.cos(a) * r - s / 2, cy + Math.sin(a) * r - s / 2, s, s);
    }
    ctx.restore();
  }

  // Диафрагма. Выпечена один раз в 256×N и растягивается на весь кадр: градиент
  // при увеличении в пять раз неразличим от честного, а платить за
  // createRadialGradient и полноэкранную заливку каждый кадр незачем.
  // Сжатие к центру сделано масштабом блита, а не перевыпечкой: масштаб 1,55
  // выносит тёмное кольцо за края кадра, масштаб 1,0 сажает его точно по краю.
  drawDim(ctx, cw, ch, t) {
    if (!this.dim) return;
    const a = dimK(t);
    if (a <= 0.01) return;
    const k = 1 + 0.55 * (1 - a);
    const w = cw * k, h = ch * k;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.drawImage(this.dim, (cw - w) / 2, (ch - h) / 2, w, h);
    ctx.restore();
  }

  drawCard(ctx, cw, ch, t) {
    if (!this.card) return;
    const k = cardK(t);
    if (k.a <= 0.01) return;
    const w = this.cardCss.w * k.scale, h = this.cardCss.h * k.scale;
    ctx.save();
    ctx.globalAlpha = k.a;
    // Титр чуть выше геометрического центра: под ним обычно город, и закрывать
    // именно его в момент, когда игрок хочет на него смотреть, — плохая идея.
    ctx.drawImage(this.card, (cw - w) / 2, ch * 0.40 - h / 2, w, h);
    ctx.restore();
  }

  // --- выпечки ---------------------------------------------------------------
  bakeDim(cw, ch) {
    if (typeof document === 'undefined' || cw < 2 || ch < 2) return;
    const W = 256, H = Math.max(16, Math.round(256 * ch / cw));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    if (!c) return;
    // Эллипс по форме кадра: круглая виньетка на широком экране оставляет
    // тёмные углы разной толщины сверху и с боков.
    const g = c.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.72);
    g.addColorStop(0.00, 'rgba(2,4,8,0)');
    g.addColorStop(0.42, 'rgba(2,4,8,0.10)');
    g.addColorStop(0.74, 'rgba(2,4,8,0.52)');
    g.addColorStop(1.00, 'rgba(2,4,8,0.92)');
    c.save();
    c.translate(W / 2, H / 2);
    c.scale(1, H / W);
    c.translate(-W / 2, -H / 2 * (W / H));
    c.fillStyle = g;
    c.fillRect(-W, -W, W * 3, W * 3);
    c.restore();
    this.dim = cv; this.dimFor = cw / ch; this.bakes++;
  }

  bakeCard(cw, ch) {
    if (typeof document === 'undefined' || cw < 2) return;
    const e = eraCard(this.era);
    const dpr = Math.max(1, Math.min(3, this.dpr || 1));
    // Размеры от ширины кадра, но с потолком: на широком мониторе титр во весь
    // экран выглядит не эпично, а криво.
    const w = Math.min(cw * 0.92, 880);
    const titlePx = Math.max(26, Math.min(58, w * 0.072));
    const yearsPx = Math.max(13, titlePx * 0.34);
    const capPx = Math.max(10, titlePx * 0.24);
    const h = titlePx * 2.9;

    const cv = document.createElement('canvas');
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const c = cv.getContext('2d');
    if (!c) return;
    c.scale(dpr, dpr);
    c.textAlign = 'center';
    c.textBaseline = 'middle';

    const hue = e.hue;
    const midY = h * 0.5;

    // Надзаголовок.
    c.font = `600 ${capPx}px system-ui, "Segoe UI", sans-serif`;
    c.fillStyle = 'rgba(226,232,240,0.72)';
    tracked(c, 'НОВАЯ ЭПОХА', w / 2, midY - titlePx * 0.92, capPx * 0.42);

    // Название. Тень рисуется здесь, в выпечке, а не в кадре: shadowBlur —
    // самая дорогая операция Canvas2D, и на 150 кадрах она стоила бы больше
    // всего остального слоя вместе взятого.
    c.font = `700 ${titlePx}px system-ui, "Segoe UI", sans-serif`;
    c.shadowColor = 'rgba(0,0,0,0.85)';
    c.shadowBlur = titlePx * 0.5;
    c.fillStyle = '#f6f2e8';
    tracked(c, e.ru.toUpperCase(), w / 2, midY, titlePx * 0.10);
    c.shadowBlur = 0;

    // Годы — цветом эпохи: единственная строка, по которой видно, что мир
    // сменил не только число в HUD.
    c.font = `500 ${yearsPx}px system-ui, "Segoe UI", sans-serif`;
    c.fillStyle = hue;
    tracked(c, e.years, w / 2, midY + titlePx * 0.86, yearsPx * 0.24);

    // Две линейки, расходящиеся от центра, — рамка кадра, а не декор: без них
    // текст висит в пустоте и читается как отладочная надпись.
    const lw = w * 0.42;
    for (const [y, aa] of [[midY - titlePx * 0.60, 0.55], [midY + titlePx * 0.58, 0.40]]) {
      const g = c.createLinearGradient(w / 2 - lw, 0, w / 2 + lw, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, hue);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.globalAlpha = aa;
      c.fillStyle = g;
      c.fillRect(w / 2 - lw, y, lw * 2, Math.max(1, titlePx * 0.025));
      c.globalAlpha = 1;
    }

    this.card = cv;
    this.cardCss = { w, h };
    this.bakes++;
  }

  // --- вспомогательное -------------------------------------------------------
  // Центр волны — кострище: сердце поселения и единственная постройка, которая
  // существует с первого дня. Если его снесли рейдом — точка старта мира.
  firePos(sim) {
    if (this.fire) return this.fire;
    let p = null;
    for (const b of (sim.buildings || [])) {
      if (b.id === 'campfire' && !b.destroyed) { p = { x: b.x + (b.size || 1) / 2, y: b.y + (b.size || 1) / 2 }; break; }
    }
    if (!p) p = { x: (sim.world.startX || 0) + 0.5, y: (sim.world.startY || 0) + 0.5 };
    this.fire = p;
    return p;
  }

  // Пропуск по клику. Слой ставит обработчик сам и снимает его по окончании —
  // иначе пришлось бы править main.js, а его правит главный разработчик.
  //
  // Ловим на window в фазе перехвата, но реагируем ТОЛЬКО на события, чья цель
  // — игровой холст. Иначе первый же клик по кнопке HUD во время перехода был
  // бы съеден stopPropagation, и две с половиной секунды интерфейс стоял бы
  // мёртвым. По той же причине клавиши — только Escape/Пробел/Enter и только
  // если фокус не в поле ввода: в HUD есть консоль, и глотать в ней набор
  // текста нельзя.
  bindSkip(ctx) {
    if (this.onSkip || typeof window === 'undefined' || !window.addEventListener) return;
    const cv = ctx && ctx.canvas;
    const h = (e) => {
      if (!this.active) return;
      if (e.type === 'keydown') {
        const tg = e.target || {};
        const tag = (tg.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tg.isContentEditable) return;
        if (e.key !== 'Escape' && e.key !== ' ' && e.key !== 'Enter') return;
      } else if (cv && e.target !== cv) {
        return;                       // клик по интерфейсу — не наш
      }
      // Глотаем событие независимо от того, приняли мы пропуск или нет: пока
      // идёт шоу, клик по холсту не должен ставить здание и не должен снимать
      // выделение. Ранние клики (до skipAfter) просто пропадают.
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
      this.skip();
    };
    this.onSkip = h;
    const opt = { capture: true };
    for (const ev of ['pointerdown', 'mousedown', 'click', 'touchstart', 'keydown']) {
      window.addEventListener(ev, h, ev === 'touchstart' ? { capture: true, passive: false } : opt);
    }
  }

  unbindSkip() {
    if (!this.onSkip || typeof window === 'undefined' || !window.removeEventListener) return;
    for (const ev of ['pointerdown', 'mousedown', 'click', 'touchstart', 'keydown']) {
      window.removeEventListener(ev, this.onSkip, { capture: true });
    }
    this.onSkip = null;
  }

  stats() {
    return {
      active: this.active,
      era: this.era,
      t: +this.t.toFixed(3),
      wave: +waveK(this.t).toFixed(3),
      skipped: this.skipped,
      snapMB: this.snap ? +(this.snap.width * this.snap.height * 4 / 1048576).toFixed(2) : 0,
      bakes: this.bakes,
      sparks: this.active ? sparkCount(this.q) : 0,
    };
  }
}

// Текст с разрядкой. Canvas2D умеет letterSpacing только в свежих браузерах, а
// разрядка здесь не украшение: заглавные без неё слипаются в кашу. Посимвольный
// вывод стоит дорого, но он в выпечке — то есть один раз за эпоху.
function tracked(c, text, cx, y, track) {
  if (!text) return;
  const ch = [...String(text)];
  if (!c.measureText) { c.fillText(text, cx, y); return; }
  let total = 0;
  const w = ch.map((s) => { const m = c.measureText(s).width; total += m; return m; });
  total += track * Math.max(0, ch.length - 1);
  let x = cx - total / 2;
  for (let i = 0; i < ch.length; i++) {
    c.fillText(ch[i], x + w[i] / 2, y);
    x += w[i] + track;
  }
}

// ===========================================================================
// ПОДКЛЮЧЕНИЕ
//
// Все правки — в app/src/render/renderer.js. Каждый якорь проверен grep -F:
//   grep -Fc "<строка>" app/src/render/renderer.js
//
// 1) ИМПОРТ. Якорь (совпадений: 1, строка 20):
//
// import { lightAt, WEATHER_TINT, hash2 } from './palette.js';
//
//    ПОСЛЕ неё добавить:
//
// import { EraTransition } from './era_transition.js';
//
// 2) СОЗДАНИЕ СЛОЯ. Якорь (совпадений: 1, строка 61, конец конструктора):
//
//     this.cityLights = new CityLights(this.quality);    // окна и фонари ночью
//
//    ПОСЛЕ неё добавить:
//
//     this.eraFx = new EraTransition(this.quality);      // переход эпохи
//
// 3) ДЕТЕКТОР И СНИМОК. Якорь (совпадений: 1, строка 121, начало draw()):
//
//     ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
//
//    ПОСЛЕ неё добавить:
//
//     // Смену эпохи ловим ДО очистки холста: на нём сейчас предыдущий кадр,
//     // нарисованный по старым правилам, и это единственный момент, когда
//     // старый мир можно забрать бесплатно.
//     this.eraFx.begin(sim, ctx, dtReal, this.quality, dpr);
//
//    ВАЖНО: строка обязана стоять ВЫШЕ строки `ctx.fillStyle = L.sky;`
//    (строка 124) — после неё холст уже затёрт небом и снимать нечего.
//
// 4) САМ ПЕРЕХОД. Якорь (совпадений: 1, строка 257):
//
//     this.fx.drawLabels(ctx, ox, oy, z, cw, ch);
//
//    ПЕРЕД ней добавить:
//
//     // Поверх всего мира, погоды, тона суток и виньетки — но ПОД подписями
//     // и миникартой: их игрок должен видеть и во время перехода.
//     this.eraFx.draw(sim, ctx, ox, oy, z, cw, ch);
//
// 5) НЕОБЯЗАТЕЛЬНО — смена пресета. Слой берёт пресет параметром begin() на
//    каждом кадре, поэтому без этого пункта всё работает. Если хочется
//    единообразия с остальными слоями, якорь (совпадений: 2 — строки 87 и 279):
//
//     this.cityLights.setQuality(this.quality);
//
//    добавить ПОСЛЕ КАЖДОЙ из двух строк (setQuality и tuneAuto):
//
//     this.eraFx.setQuality(this.quality);
//
//    Именно после обеих: одна в setQuality (ручной выбор игрока), вторая в
//    tuneAuto (авто-тюнер), и пропуск любой оставит титр выпеченным под
//    старый dpr до конца партии.
//
// Правок в main.js, hud.js, index.html не требуется: пропуск по клику слой
// вешает и снимает сам, а баннер эпохи в HUD ему не мешает — он живёт в DOM.
//
// ---------------------------------------------------------------------------
// ЧТО НАСТРАИВАЕТСЯ СНАРУЖИ
//
//   renderer.eraFx.enabled = false;   // выключить переход целиком
//   renderer.eraFx.skip();            // пропустить из кода (обучение, тесты)
//   renderer.eraFx.active             // идёт ли переход прямо сейчас
//   renderer.eraFx.stats()            // {active, era, t, wave, snapMB, sparks}
//
// ПРЕСЕТЫ
//   eco (detail 0)    — снимка старого мира и тона эпохи нет: остаются
//                       диафрагма, кольцо из двух полос, 13 искр и титр.
//                       Волна при этом всё равно видна — как бегущий свет.
//   medium (detail 1) — полный набор, 32 искры, снимок до 1,6 млн пикселей.
//   high (detail 2)   — 51 искра, три полосы кольца.
//   ultra (detail 2)  — 64 искры, снимок до 3,2 млн пикселей.
