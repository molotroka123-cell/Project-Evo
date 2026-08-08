// render/shadows.js — единая система теней: контактное пятно под объектом,
// вытянутая тень по солнцу, смягчение в облачную погоду и самозатенение
// крупных построек.
//
// ЗАЧЕМ. Сейчас тень в игре одна и только у зданий: восемь строк внутри
// renderer.drawBuilding, где силуэт постройки перекашивается по L.sunAz с
// постоянной прозрачностью 0.3. У жителей своей тени нет вовсе (в лист
// people.js впечатано мягкое пятно под ногами, но оно не знает ни времени
// суток, ни погоды), у деревьев — то же самое. Из-за этого:
//   • в полдень и в дождь тени одинаково густые, хотя в дождь прямого солнца
//     нет и тени физически нет тоже;
//   • ночью тень остаётся ровно такой же, как днём, — источника света уже нет,
//     а тень есть;
//   • житель, идущий мимо дома, не привязан к земле: дом стоит, человек парит;
//   • тень зданий всегда уходит вправо-вверх и никогда не переходит на другую
//     сторону — солнце в palette.KEY описано только до полудня (az от -3.05 до
//     -1.60, косинус на всём отрезке отрицателен), поэтому вечерняя тень
//     вырождается в вертикальный обрубок вместо того, чтобы лечь в другую
//     сторону.
// Модуль сводит всё это в одно место и делает тень функцией света и погоды.
//
// ГРАНИЦЫ. Модуль — чистое представление: читает симуляцию и НИЧЕГО в ней не
// меняет, ядро о нём не знает. Он не трогает ни renderer.js, ни sprites.js, ни
// vegetation.js — подключение описано внизу файла, в блоке «ПОДКЛЮЧЕНИЕ».
// Импорт файла не имеет побочных эффектов: до первого кадра не печётся ни
// одного канваса и не читается ни одного глобального объекта.
//
// СЛУЧАЙНОСТЬ. Её здесь нет вообще, и это не случайность: тень — функция
// времени суток, погоды и геометрии объекта. Math.random в проекте запрещён,
// rng ядра рендеру трогать нельзя (каждый вызов сдвигает состояние симуляции,
// а рендер у игроков идёт с разной частотой — сейв бы поплыл), и модулю ни то
// ни другое не понадобилось.
//
// ЦЕНА. Бюджет — 1 мс на пресете high при 200 постройках и 300 жителях.
// Держится тремя правилами:
//   1) НИКАКОГО ctx.filter. Мягкость печётся заранее: силуэт уменьшается и
//      увеличивается обратно с билинейной фильтрацией — это честное размытие
//      коробкой, но оно происходит ОДИН раз на спрайт, а не в кадре
//      (docs/graphics-audit.md §1: filter='blur()' ронял 60 FPS до 9).
//   2) Одна тень — один drawImage. Перекос делается матрицей (setTransform),
//      а не рисованием по точкам, — ровно как наклон крон в vegetation.js.
//   3) Полноэкранных заливок нет ни одной.
import { lightAt } from './palette.js';

// Мировая единица «тайл → экран» при zoom = 1. Та же константа, что в
// renderer.js и vegetation.js: нужна, чтобы перевести пришедший z обратно в
// зум и сверить его с порогами пресета.
const TILE_PX = 32;

// Потолки. Как и в fx.js/weather.js — именно потолки, а не цели.
export const SHADOW_LIMITS = {
  casts: 420,     // вытянутых теней в кадре; больше — просто не рисуем
  selfs: 72,      // самозатенений в кадре: см. замер в bakeSelfShade
  softMB: 8,      // память под испечённые мягкие силуэты
};

// Цвет тени. Тень НИКОГДА не чёрная (docs/art-direction.md §5.4): она
// накладывается умножением, то есть красит землю её же цветом, приглушённым и
// уведённым в синеву неба — рассеянный свет неба и есть то, что заполняет
// тень. Чёрная заливка вместо этого убивает и траву, и песок в один уголь.
const COL = '44,52,76';

// --- геометрия ------------------------------------------------------------
// SHEAR — сдвиг вершины тени по горизонтали на единицу высоты объекта при
//   самом низком солнце. FLAT — во сколько раз тень короче объекта по
//   вертикали: земля видна почти сверху, поэтому длинная тень всё равно
//   ложится коротким пятном. 0.34 — ровно то число, что стояло в renderer.
const SHEAR = 0.62;
const FLAT = 0.34;
// Окно светового дня: за его пределами прямого солнца нет и тени нет.
// Числа согласованы с palette.KEY (рассвет ~0.26, закат ~0.78).
const DAY_A = 0.23, DAY_B = 0.77;

// Сила прямого солнца по времени суток. Отдельная кривая, а не L.mul: mul
// описывает ЯРКОСТЬ сцены (в облачный полдень она высокая), а тень зависит от
// того, есть ли прямой луч. Пары [t, s], между ними — сглаженная интерполяция.
const SUN_KEY = [
  [0.00, 0.00], [0.19, 0.00], [0.25, 0.34], [0.31, 0.74], [0.39, 0.96],
  [0.50, 1.00], [0.63, 0.96], [0.71, 0.78], [0.79, 0.34], [0.85, 0.00], [1.00, 0.00],
];

// Погода. a — сколько остаётся от прямого солнца, soft — во сколько раз шире
// полутень. В сплошной облачности резкой тени нет вообще: свет приходит со
// всего неба сразу, и под объектом остаётся только мягкое затемнение.
// Ключ 'storm' ядро не выдаёт (WEATHER знает sun/cloud/rain/snow), но он есть
// в palette.WEATHER_TINT и в vegetation — держим на случай, если появится.
const WEATHER_SHADOW = {
  sun: { a: 1.00, soft: 1.00 },
  cloud: { a: 0.44, soft: 1.90 },
  rain: { a: 0.22, soft: 2.30 },
  snow: { a: 0.32, soft: 2.00 },
  storm: { a: 0.13, soft: 2.60 },
};
const WEATHER_DEFAULT = { a: 1.00, soft: 1.00 };

// Базовые прозрачности. Множители к ним — солнце, погода и длина тени.
const CAST_A = 0.42;      // вытянутая тень
const CONTACT_A = 0.38;   // контактное пятно
const SELF_A = 0.50;      // самозатенение

// Самозатенение положено только тому, у кого есть чему затенять себя: у
// хижины высотой 0.9 тайла затенять нечего, у башни высотой 3.6 — есть.
// Порог 1.45 отсекает всё жильё и мастерские и оставляет мельницу, колоннаду,
// донжон, фабрику, реактор, высотку, башню и шпиль (таблица ARCH_H в
// sprites.js). Замер: один такой blit умножением стоит 50–180 мкс на
// программном растеризаторе, и раздавать его всем подряд нельзя.
const SELF_MIN_H = 1.45;
const SELF_MIN_ZOOM = 0.75;

// Доля кадра спрайта, которую занимает поле под размытие. Мягкий край выходит
// за габарит силуэта, и без запаса он срезался бы рамкой холста. Число прямо
// умножает площадь заливки ((1+2p)² ≈ 1.23), поэтому оно не «на глаз»: 0.055 —
// это 3 пикселя полутени на спрайте 56 px и 7 на спрайте 132 px.
const PAD = 0.055;
// Насколько погода имеет право раздувать это поле. Без ограничения дождь
// (soft 2.3) растил площадь каждой тени в 1.75 раза — 2,3 мс на пустом месте
// при том, что тень в дождь и так почти не видна.
const SPREAD_PAD = 0.45;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (k) => k * k * (3 - 2 * k);

// Пресет по умолчанию: модуль обязан работать и без renderer — например, в
// тестовом стенде. Поля те же, что читает quality.js.
const FALLBACK_Q = {
  id: 'high', detail: 2, shadows: true,
  lod: { shadowMinZoom: 0.65 },
  caps: { spriteMB: 32, buildings: 200, people: 300 },
};

function sunAt(t) {
  const x = ((t % 1) + 1) % 1;
  let i = 0;
  while (i < SUN_KEY.length - 2 && SUN_KEY[i + 1][0] <= x) i++;
  const a = SUN_KEY[i], b = SUN_KEY[i + 1];
  const k = b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0]);
  return a[1] + (b[1] - a[1]) * smooth(clamp01(k));
}

// Canvas молча игнорирует неизвестный режим наложения и оставляет source-over.
// Для тени это означает не «чуть другой оттенок», а чёрное пятно поверх земли,
// поэтому режим проверяется записью-чтением, и на отказ есть запасной путь.
// Тот же приём, что в weather.js.
function supportsOp(ctx, op) {
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = op;
  const ok = ctx.globalCompositeOperation === op;
  ctx.globalCompositeOperation = prev;
  return ok;
}

function makeCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, w | 0); cv.height = Math.max(1, h | 0);
  return cv;
}

// ---------------------------------------------------------------------------
// ВЫПЕЧКА МЯГКОГО СИЛУЭТА.
//
// Размытие без ctx.filter: картинка уменьшается в D раз и возвращается обратно
// с билинейной фильтрацией. Уменьшение усредняет по блоку D×D (это размытие
// коробкой), увеличение размазывает результат линейно — вместе получается
// «шатёр». Два таких прохода подряд дают почти гауссиан, и всё это происходит
// ОДИН раз на спрайт, а не в кадре.
//
// Возвращает { cv, pad }: холст с силуэтом, вписанным с полем pad (в долях
// стороны), уже перекрашенным в цвет тени.
// ---------------------------------------------------------------------------
function bakeSoft(src, sw, sh, alpha) {
  // Половинное разрешение: тень размыта, лишние пиксели в ней не видны, а
  // память и время выпечки экономятся вчетверо.
  const w = Math.max(8, Math.round(sw * 0.5));
  const h = Math.max(8, Math.round(sh * 0.5));
  const padX = Math.max(2, Math.round(w * PAD));
  const padY = Math.max(2, Math.round(h * PAD));
  const W = w + padX * 2, H = h + padY * 2;

  // 1) силуэт нужного цвета
  const flat = makeCanvas(W, H);
  const fc = flat.getContext('2d');
  fc.drawImage(src, padX, padY, w, h);
  fc.globalCompositeOperation = 'source-in';
  fc.fillStyle = `rgba(${COL},1)`;
  fc.fillRect(0, 0, W, H);

  // 2) два прохода «уменьшить-увеличить»
  const D = Math.max(2, Math.round(Math.min(padX, padY) * 0.9));
  let cur = flat;
  for (let pass = 0; pass < 2; pass++) {
    const small = makeCanvas(Math.max(2, Math.round(W / D)), Math.max(2, Math.round(H / D)));
    const sc = small.getContext('2d');
    sc.imageSmoothingEnabled = true;
    sc.drawImage(cur, 0, 0, small.width, small.height);
    const up = makeCanvas(W, H);
    const uc = up.getContext('2d');
    uc.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in uc) uc.imageSmoothingQuality = 'high';
    uc.drawImage(small, 0, 0, W, H);
    cur = up;
  }

  // 3) общий уровень прозрачности печём в спрайт: в кадре останется голый
  //    drawImage без globalAlpha там, где яркость тени не меняется.
  if (alpha < 0.999) {
    const out = makeCanvas(W, H);
    const oc = out.getContext('2d');
    oc.globalAlpha = alpha;
    oc.drawImage(cur, 0, 0);
    cur = out;
  }
  return { cv: cur, pad: PAD, bytes: W * H * 4 };
}

// Мягкое эллиптическое пятно — контактная тень и тень мелких объектов.
// Печётся один раз за сессию: 64×64 ≈ 16 КБ.
function bakeBlob() {
  const S = 64;
  const cv = makeCanvas(S, S);
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  // Плато в середине и длинный хвост: без плато пятно выглядит кляксой,
  // без хвоста — вырезанным кругом.
  g.addColorStop(0.00, `rgba(${COL},0.95)`);
  g.addColorStop(0.42, `rgba(${COL},0.72)`);
  g.addColorStop(0.72, `rgba(${COL},0.26)`);
  g.addColorStop(1.00, `rgba(${COL},0)`);
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  return cv;
}

// Карта самозатенения. Свет в проекте канонически падает сверху-слева под 45°
// (docs/art-direction.md §5.1: terrain.buildHeight считает hillshade от
// LX = LY = -0.7071, и все испечённые спрайты подсвечены оттуда же), поэтому
// собственная тень постройки всегда лежит справа-снизу. Направление здесь
// намеренно НЕ зависит от времени суток: спрайт под ним не перекрашивается,
// и разъезжаться этим двум источникам нельзя.
//
// ПОЧЕМУ ТОЛЬКО НИЖНЯЯ ПОЛОСА. Карта печётся не на весь спрайт, а на его
// нижние `band` долей, и накладывается только туда. Причина — замер: один
// blit умножением во всю высоту башни (59×190 px) стоит 170 мкс на
// программном растеризаторе, то есть удваивает цену самой башни. При этом
// верх спрайта уже объёмный сам по себе: sprites.js рисует ложную изометрию
// с тёмной боковой гранью, и градиент туда почти ничего не добавляет
// (альфа там ≤ 0.10). А вот того, чего спрайту не хватает, — потемнения у
// земли, где сходятся стена, отмостка и трава, — в нём нет вовсе. Полоса даёт
// именно это и стоит вдвое дешевле.
function bakeSelfShade(src, sw, sh, band) {
  const W = Math.max(8, Math.round(sw * 0.5));
  const H = Math.max(8, Math.round(sh * 0.5));
  const Hb = Math.max(4, Math.round(H * band));
  const off = Hb - H;             // сдвиг: низ спрайта совмещён с низом полосы
  const cv = makeCanvas(W, Hb);
  const c = cv.getContext('2d');
  c.drawImage(src, 0, off, W, H);

  // Диагональ: чем дальше от источника, тем темнее. Координаты градиента —
  // в системе ПОЛНОГО спрайта, поэтому полоса выглядит вырезанной из большой
  // карты, а не отдельной плашкой со своим наклоном.
  c.globalCompositeOperation = 'source-in';
  const g = c.createLinearGradient(0, off, W, off + H);
  g.addColorStop(0.00, `rgba(${COL},0)`);
  g.addColorStop(0.40, `rgba(${COL},0.06)`);
  g.addColorStop(0.75, `rgba(${COL},0.34)`);
  g.addColorStop(1.00, `rgba(${COL},0.62)`);
  c.fillStyle = g;
  c.fillRect(0, 0, W, Hb);

  // Цоколь. source-atop, а не source-in: вторая заливка должна лечь ПОВЕРХ
  // первой внутри силуэта, а не заменить её.
  c.globalCompositeOperation = 'source-atop';
  const y0 = off + H * 0.62;
  const g2 = c.createLinearGradient(0, y0, 0, off + H);
  g2.addColorStop(0, `rgba(${COL},0)`);
  g2.addColorStop(1, `rgba(${COL},0.40)`);
  c.fillStyle = g2;
  c.fillRect(0, Math.max(0, y0), W, Hb);

  return { cv, band, bytes: W * Hb * 4 };
}

// ---------------------------------------------------------------------------
export class ShadowLayer {
  constructor(quality) {
    this.q = quality || FALLBACK_Q;
    this.off = this.q.id === 'eco' || !this.q.shadows;
    this.enabled = true;

    // Листы жителей (people.bakeSheet) уже несут впечённое пятно под ногами,
    // и второе поверх него читается как лужа. Поставьте true, если этот
    // контакт из листов уберут.
    this.unitContact = false;

    // --- состояние кадра ---------------------------------------------------
    this.frame = 0;         // номер кадра: по нему сбрасывается кэш матрицы
    this.on = false;        // рисуем ли тени в этом кадре вообще
    this.sun = 0;           // сила прямого солнца, 0..1
    this.k = 0;             // сдвиг тени по X на единицу высоты
    this.m = FLAT * 0.6;    // укорочение по Y
    this.castA = 0;         // прозрачность вытянутой тени
    this.contactA = 0;      // прозрачность контактного пятна
    this.contactMix = 1;    // доля пятна, которую НЕ перекрыла вытянутая тень
    this.selfA = 0;         // прозрачность самозатенения
    this.spread = 1;        // ширина полутени, 1 — ясный день
    this.self = false;      // разрешено ли самозатенение на этом зуме
    this.casts = 0;         // счётчик вытянутых теней в кадре
    this.maxCasts = SHADOW_LIMITS.casts;
    this.selfs = 0;         // счётчик самозатенений в кадре
    this.maxSelf = SHADOW_LIMITS.selfs;
    this.drawn = 0;         // всего теней за прошлый кадр — для отладки

    // --- кэши --------------------------------------------------------------
    this._blob = null;
    this._soft = new WeakMap();   // силуэт спрайта → мягкая тень
    this._self = new WeakMap();   // силуэт спрайта → карта самозатенения
    this._bytes = 0;              // сколько памяти занято выпечкой
    this._m = null;               // базовая матрица кадра
    this._mFrame = -1;
    this._noMat = false;          // getTransform недоступен — без перекоса
    this._mul = null;             // поддержка режима multiply
    this._eased = false;          // первый кадр: значения ставим без плавности
  }

  setQuality(q) {
    this.q = q || FALLBACK_Q;
    this.off = this.q.id === 'eco' || !this.q.shadows;
    // Разрешение выпечки спрайтов зависит от пресета — старые тени больше не
    // совпадают с новыми силуэтами.
    this.clear();
  }

  clear() {
    this._soft = new WeakMap();
    this._self = new WeakMap();
    this._bytes = 0;
    this._blob = null;
  }

  // =========================================================================
  // НАЧАЛО КАДРА. Один вызов до отрисовки объектов: здесь считаются солнце,
  // погода и геометрия перекоса — по одному разу на кадр, а не на объект.
  //
  //   dt   — реальные секунды с прошлого кадра (для плавной смены погоды)
  //   z    — пикселей на тайл (TILE_PX * zoom), как во всех модулях рендера
  //   opts — { fog: 0..1 } из weather.js (Atmosphere.fogK). Не обязателен.
  // =========================================================================
  begin(sim, dt, z, opts) {
    this.frame++;
    this.casts = 0;
    this.selfs = 0;
    this.drawn = 0;
    this._mFrame = -1;
    this.on = false;
    if (!sim || this.off || !this.enabled) return;

    const zoom = z / TILE_PX;
    const minZoom = (this.q.lod && this.q.lod.shadowMinZoom) || 0.65;
    // Ниже порога тень занимает пару пикселей и читается как грязь под
    // объектом, а стоит ровно столько же, сколько в упор.
    if (zoom < minZoom) return;

    this.on = true;
    // Самозатенение — только там, где спрайт печётся в полном разрешении:
    // на detail 1 постройка занимает 96 px, и градиент по её грани — это
    // четыре пикселя разницы за цену полноразмерного blit умножением.
    this.self = this.q.detail >= 2 && zoom >= SELF_MIN_ZOOM;
    this.maxCasts = Math.min(
      SHADOW_LIMITS.casts,
      ((this.q.caps && this.q.caps.buildings) || 200) + Math.round(((this.q.caps && this.q.caps.people) || 200) * 0.7),
    );

    const t = ((sim.dayTime % 1) + 1) % 1;
    const L = lightAt(t);
    const W = WEATHER_SHADOW[sim.weather] || WEATHER_DEFAULT;
    const fog = opts && typeof opts.fog === 'number' ? clamp01(opts.fog) : 0;

    // Длина. lightAt уже даёт правильную кривую: коротко в полдень, длинно на
    // рассвете и закате. Потолок — чтобы вечерняя тень небоскрёба не уезжала
    // на пол-экрана.
    const len = clamp(L.shadowLen, 0.45, 2.2);

    // Направление. Солнце идёт по небу, поэтому знак сдвига обязан меняться:
    // утром тень лежит в одну сторону, вечером — в другую, в полдень она
    // короткая и почти вертикальная. Отсюда u ∈ [-1, +1] по времени суток.
    // (L.sunAz для этого не годится: см. шапку файла — его косинус отрицателен
    // весь день, и тень никогда не переходит на вторую сторону.)
    const u = clamp((t - 0.5) / ((DAY_B - DAY_A) / 2), -1, 1);

    const sun = sunAt(t) * W.a * (1 - 0.75 * fog);
    // Чем длиннее тень, тем она бледнее: то же количество перекрытого света
    // размазано по большей площади.
    const dim = Math.min(1, 1.15 / (0.55 + 0.62 * len));

    const target = {
      sun,
      k: -SHEAR * u * len,
      m: FLAT * len,
      castA: CAST_A * sun * dim,
      contactA: CONTACT_A * (0.30 + 0.70 * sun) * (0.55 + 0.45 * W.a),
      selfA: SELF_A * (0.40 + 0.60 * sun),
      spread: W.soft * (0.75 + 0.35 * len) * (1 + 0.7 * fog),
    };

    // Плавность. Погода в ядре переключается мгновенно, и без сглаживания
    // тени схлопывались бы рывком на глазах у игрока.
    const e = this._eased ? Math.min(1, Math.max(0, dt || 0) * 1.8) : 1;
    this._eased = true;
    this.sun += (target.sun - this.sun) * e;
    this.k += (target.k - this.k) * e;
    this.m += (target.m - this.m) * e;
    this.castA += (target.castA - this.castA) * e;
    this.contactA += (target.contactA - this.contactA) * e;
    this.selfA += (target.selfA - this.selfA) * e;
    this.spread += (target.spread - this.spread) * e;

    // Ночь: прямого света нет — вытянутой тени нет тоже. Контактное пятно
    // остаётся ослабленным: без него объект ночью отрывается от земли.
    if (this.castA < 0.012) this.castA = 0;

    // Сколько контактного пятна остаётся под вытянутой тенью. Длинная тень
    // сама накрывает основание, и второе пятно поверх неё не видно — а стоит
    // целый blit на каждую постройку. Короткая (полуденная) не накрывает
    // ничего: она уходит за спину объекта и с экрана почти не читается, и
    // тогда именно пятно и есть вся тень. Поэтому доля считается от ДЛИНЫ, а
    // не от яркости: в полдень пятно на полную, к вечеру сходит к трети.
    this.contactMix = this.castA <= 0 ? 1 : 1 - 0.62 * clamp01((len - 0.6) / 1.0);
  }

  // =========================================================================
  // ЗДАНИЕ. spr — то, что отдаёт sprites.building(): { cv, glow, sil, hFact }.
  // dx/dy/dw/dh — тот самый прямоугольник, в который renderer кладёт спрайт.
  // Вызывать ДО отрисовки самого здания.
  // =========================================================================
  building(ctx, spr, dx, dy, dw, dh) {
    if (!this.on || !spr || !spr.sil) return;
    // «Пол» постройки — нижняя кромка спрайта: renderer сажает её ровно на низ
    // тайла. Тень обязана касаться основания без зазора (art-direction §5.4),
    // поэтому и перекос, и пятно берут началом именно эту линию, а не точку
    // выше неё: пятно, поднятое над кромкой, целиком уходит за фасад, и в
    // полдень постройка остаётся вообще без тени.
    const by = dy + dh;
    if (this.castA > 0 && this.casts < this.maxCasts) {
      const soft = this._softOf(spr.sil, dw, dh);
      if (soft) { this._cast(ctx, soft, dx, dy, dw, dh, by, this.castA); this.casts++; }
    }
    this._contact(ctx, dx + dw / 2, by, dw * 0.46, this.contactA * this.contactMix);
  }

  // Нарисованный арт (artpack): у него нет испечённого силуэта, зато есть сам
  // спрайт с прозрачным фоном — силуэт из него печётся здесь же, один раз на
  // картинку. Контактную тень арт уже несёт в себе (её требует промт), поэтому
  // добавляется только вытянутая.
  paintedBuilding(ctx, img, dx, dy, dw, dh) {
    if (!this.on || this.castA <= 0 || !img) return;
    if (this.casts >= this.maxCasts) return;
    const soft = this._softOf(img, dw, dh);
    if (!soft) return;
    this._cast(ctx, soft, dx, dy, dw, dh, dy + dh, this.castA * 0.9);
    this.casts++;
  }

  // Самозатенение. Вызывать ПОСЛЕ отрисовки здания: карта ложится поверх
  // спрайта умножением и гасит грани, отвёрнутые от света.
  selfShade(ctx, spr, dx, dy, dw, dh) {
    if (!this.on || !this.self || !spr || !spr.sil) return;
    const hf = spr.hFact || 0;
    if (hf < SELF_MIN_H) return;               // затенять нечего
    if (this.selfs >= this.maxSelf) return;    // потолок кадра
    // Чем выше постройка, тем меньшую её долю занимает притенённый низ: у
    // мельницы это половина спрайта, у шпиля — треть. В пикселях полоса при
    // этом почти одна и та же, а платим мы именно за пиксели.
    const band = clamp(0.78 / hf, 0.32, 0.60);
    const a = this._selfOf(spr.sil, dw, dh, band);
    if (!a) return;
    const mul = this._checkMul(ctx);
    const prevOp = ctx.globalCompositeOperation;
    if (mul) ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = mul ? this.selfA : this.selfA * 0.45;
    ctx.drawImage(a.cv, dx, dy + dh * (1 - a.band), dw, dh * a.band);
    ctx.globalAlpha = 1;
    if (mul) ctx.globalCompositeOperation = prevOp;
    this.selfs++;
    this.drawn++;
  }

  // =========================================================================
  // ЖИТЕЛЬ И ЖИВОТНОЕ. Фигура узкая и вертикальная: её тень — не силуэт, а
  // мягкая вытянутая полоса, и печь на неё отдельные силуэты (16 кадров ×
  // эпоха × профессия) было бы расточительством ради разницы в два пикселя.
  //   sx  — центр по горизонтали, sy — точка опоры (ноги/лапы)
  //   w/h — размер фигуры на экране
  // =========================================================================
  unit(ctx, sx, sy, w, h) {
    if (!this.on) return;
    if (this.castA > 0 && this.casts < this.maxCasts) {
      const blob = this._blobCv();
      // Полоса уже фигуры: тень человека — это вытянутое пятно, а не его копия.
      const bw = w * 0.52, bh = h * 0.92;
      // Тень человека мягче тени здания: объект мельче, а полутень от того же
      // солнца — та же (docs/art-direction.md §5.4).
      this._cast(ctx, { cv: blob, pad: 0 }, sx - bw / 2, sy - bh, bw, bh, sy, this.castA * 0.72, 1.25);
      this.casts++;
    }
    if (this.unitContact) this._contact(ctx, sx, sy, w * 0.34, this.contactA * 0.9);
  }

  beast(ctx, sx, sy, w, h) {
    if (!this.on) return;
    if (this.castA > 0 && this.casts < this.maxCasts) {
      const blob = this._blobCv();
      // Зверь низкий и длинный — пятно шире и ниже, чем у человека.
      const bw = w * 0.72, bh = h * 0.70;
      this._cast(ctx, { cv: blob, pad: 0 }, sx - bw / 2, sy - bh, bw, bh, sy, this.castA * 0.68, 1.2);
      this.casts++;
    }
    if (this.unitContact) this._contact(ctx, sx, sy, w * 0.40, this.contactA * 0.9);
  }

  // Дерево, куст, реквизит. Тень кроны — то же мягкое пятно: крона и есть
  // облако листвы, её тень не имеет чёткого края ни при каком солнце.
  //   sx — центр, sy — комель, d — сторона спрайта на экране (vegetation
  //   рисует растение как drawImage(cv, sx - d/2, sy - d*0.88, d, d)).
  prop(ctx, sx, sy, d, k) {
    if (!this.on || this.castA <= 0) return;
    if (this.casts >= this.maxCasts) return;
    const w = d * (k || 0.62), h = d * 0.78;
    this._cast(ctx, { cv: this._blobCv(), pad: 0 }, sx - w / 2, sy - h, w, h, sy, this.castA * 0.78, 1.15);
    this.casts++;
  }

  stats() {
    return {
      on: this.on, sun: +this.sun.toFixed(2), castA: +this.castA.toFixed(3),
      k: +this.k.toFixed(2), m: +this.m.toFixed(2), spread: +this.spread.toFixed(2),
      casts: this.casts, selfs: this.selfs, drawn: this.drawn,
      cacheKB: Math.round(this._bytes / 1024),
    };
  }

  // =========================================================================
  // ВНУТРЕННЕЕ
  // =========================================================================

  // Базовая матрица кадра. Берётся лениво и один раз за кадр: renderer ставит
  // её как (dpr,0,0,dpr,0,0), но между begin() и первой тенью он мог её
  // поменять, а спрашивать getTransform на каждую тень — лишняя работа.
  _base(ctx) {
    if (this._mFrame === this.frame) return this._m;
    this._mFrame = this.frame;
    if (typeof ctx.getTransform !== 'function') {
      // Без getTransform поставить свою матрицу нельзя: мы затрём dpr и всё
      // уедет. Тогда остаются только контактные пятна — они рисуются обычным
      // drawImage и работают при любой матрице.
      this._noMat = true;
      this._m = null;
      return null;
    }
    const m = ctx.getTransform();
    this._m = [m.a, m.b, m.c, m.d, m.e, m.f];
    return this._m;
  }

  _checkMul(ctx) {
    if (this._mul === null) this._mul = supportsOp(ctx, 'multiply');
    return this._mul;
  }

  _blobCv() {
    if (!this._blob) this._blob = bakeBlob();
    return this._blob;
  }

  // Мягкий силуэт спрайта. Ключ — сам холст силуэта: он живёт ровно столько,
  // сколько живёт спрайт в SpriteCache, и WeakMap освобождает тень вместе с
  // ним. Потолок памяти сторожится отдельно: превысили — кэш сбрасывается
  // целиком (перепечь два десятка силуэтов дешевле, чем вести LRU-учёт по
  // объектам, которые нельзя перечислить).
  _softOf(src, dw, dh) {
    if (!src) return null;
    let s = this._soft.get(src);
    if (s) return s;
    const cap = Math.min(SHADOW_LIMITS.softMB, ((this.q.caps && this.q.caps.spriteMB) || 32) * 0.5) * 1048576;
    if (this._bytes > cap) { this._soft = new WeakMap(); this._self = new WeakMap(); this._bytes = 0; }
    // Разрешение выпечки берётся от размера НА ЭКРАНЕ, но с потолком: тень
    // размыта, и печь её крупнее спрайта смысла нет.
    const w = clamp(Math.round(dw), 12, 256);
    const h = clamp(Math.round(dh), 12, 384);
    s = bakeSoft(src, w, h, 1);
    this._bytes += s.bytes;
    this._soft.set(src, s);
    return s;
  }

  _selfOf(src, dw, dh, band) {
    if (!src) return null;
    let s = this._self.get(src);
    if (s) return s;
    const w = clamp(Math.round(dw), 12, 256);
    const h = clamp(Math.round(dh), 12, 384);
    s = bakeSelfShade(src, w, h, band);
    this._bytes += s.bytes;
    this._self.set(src, s);
    return s;
  }

  // Вытянутая тень: перекос вокруг линии «пола» by.
  //
  // Локальное преобразование S: u = x + k·(y − by), v = by + m·(y − by).
  // Точка на уровне пола остаётся на месте, верхушка объекта уезжает вбок на
  // k·h и поднимается к горизонту на m·h. Композиция с базовой матрицей M
  // считается вручную: ctx.transform() умножал бы то же самое, но потребовал
  // бы save/restore, а это две лишние операции со стеком состояний на объект.
  _cast(ctx, soft, dx, dy, dw, dh, by, alpha, softMul) {
    const M = this._base(ctx);
    if (!M || alpha <= 0) return;
    const k = this.k, m = this.m;
    const M0 = M[0], M1 = M[1], M2 = M[2], M3 = M[3], M4 = M[4], M5 = M[5];
    const e = -k * by, f = by * (1 - m);

    // Поле под полутень: в облачную погоду оно шире, и тень расплывается.
    const p = soft.pad * (1 + SPREAD_PAD * (this.spread - 1)) * (softMul || 1);
    const rx = dx - dw * p, ry = dy - dh * p;
    const rw = dw * (1 + 2 * p), rh = dh * (1 + 2 * p);

    const mul = this._checkMul(ctx);
    const prevOp = ctx.globalCompositeOperation;
    if (mul) ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = mul ? alpha : alpha * 0.55;
    ctx.setTransform(
      M0, M1,
      M0 * k + M2 * m, M1 * k + M3 * m,
      M0 * e + M2 * f + M4, M1 * e + M3 * f + M5,
    );
    ctx.drawImage(soft.cv, rx, ry, rw, rh);
    ctx.setTransform(M0, M1, M2, M3, M4, M5);
    ctx.globalAlpha = 1;
    if (mul) ctx.globalCompositeOperation = prevOp;
    this.drawn++;
  }

  // Контактная тень: мягкий эллипс, прижатый к основанию. Он есть всегда,
  // даже ночью и в дождь, — это не тень от солнца, а стык объекта с землёй.
  _contact(ctx, cx, by, r, alpha) {
    // Меньше двух с половиной пикселей радиуса — это не тень, а грязь под
    // объектом: на дальнем зуме пятно не читается, а стоит столько же.
    if (alpha <= 0.006 || r < 2.5) return;
    const blob = this._blobCv();
    // В облачную погоду пятно шире и бледнее: рассеянный свет затекает под
    // объект со всех сторон.
    const rw = r * (1 + 0.16 * (this.spread - 1));
    const rh = rw * 0.34;
    const mul = this._checkMul(ctx);
    const prevOp = ctx.globalCompositeOperation;
    if (mul) ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = mul ? alpha : alpha * 0.55;
    ctx.drawImage(blob, cx - rw, by - rh, rw * 2, rh * 2);
    ctx.globalAlpha = 1;
    if (mul) ctx.globalCompositeOperation = prevOp;
    this.drawn++;
  }
}

/* ПОДКЛЮЧЕНИЕ */
//
// Ниже — точные строки для app/src/render/renderer.js. Сам renderer.js этим
// агентом НЕ ТРОГАЛСЯ (чужая зона, одновременно правят ещё шестнадцать
// агентов): вставлять руками. Все якоря проверены на уникальность в файле на
// момент написания — где строк две, это сказано явно.
//
// 1) Импорт — ПОСЛЕ строки
//
//      import { lightAt, WEATHER_TINT, hash2 } from './palette.js';
//
//    добавить:
//
//      import { ShadowLayer } from './shadows.js';
//
// 2) Конструктор Renderer — ПОСЛЕ строки
//
//      this.fx = new FxLayer(this.quality);
//
//    добавить:
//
//      this.shadows = new ShadowLayer(this.quality);
//
// 3) Смена пресета. Строка
//
//      this.fx.setQuality(this.quality);
//
//    встречается ДВАЖДЫ — в setQuality(id) и в tuneAuto(dtReal). После КАЖДОЙ
//    из двух добавить:
//
//      this.shadows.setQuality(this.quality);
//
// 4) draw() — начало кадра. Сразу ПОСЛЕ строки
//
//      this.fx.update(sim, dtReal, ox, oy, z, cw, ch);
//
//    добавить:
//
//      this.shadows.begin(sim, dtReal, z, { fog: this.atmo.fogK });
//
//    fog берётся из погоды: в тумане прямого солнца нет, и тень обязана уйти
//    вместе с ним. Если weather.js в сборке не подключён — передавайте {} или
//    вовсе опустите четвёртый аргумент, модуль это переживёт.
//
// 5) drawBuilding() — ЗАМЕНА старой тени. Найти этот блок (единственный в
//    файле, отступ 4 пробела):
//
//      // Тень падает по солнцу: утром и вечером длинная, в полдень короткая.
//      if (this.quality.shadows) {
//        const L = lightAt(sim.dayTime);
//        ctx.save();
//        ctx.globalAlpha = 0.3;
//        ctx.translate(sx + size / 2, sy + size * 0.9);
//        ctx.transform(1, 0, Math.cos(L.sunAz) * L.shadowLen * 0.8, 0.34 * L.shadowLen, 0, 0);
//        ctx.drawImage(spr.sil, -size / 2, -dh, dw, dh);
//        ctx.restore();
//      }
//
//    и заменить целиком на одну строку:
//
//      this.shadows.building(ctx, spr, dx, dy, dw, dh);
//
//    ВАЖНО: после замены `lightAt` в drawBuilding больше не используется, но
//    из файла его НЕ убирать — он нужен в draw() и в drawFireflies.
//
// 6) drawBuilding() — самозатенение. ПОСЛЕ строки
//
//      ctx.drawImage(spr.cv, dx, dy, dw, dh);
//
//    добавить:
//
//      this.shadows.selfShade(ctx, spr, dx, dy, dw, dh);
//
//    Ложится только на постройки выше 1.3 тайла (ARCH_H из sprites.js) и
//    только при detail ≥ 1: у хижины затенять нечего.
//
// 7) drawBuilding() — тень нарисованного арта. Найти строку
//
//      ctx.drawImage(painted, dx, dy, dw, dh);
//
//    и ПЕРЕД ней добавить:
//
//      this.shadows.paintedBuilding(ctx, painted, dx, dy, dw, dh);
//
//    Контактную тень арт несёт в себе (её требует промт), поэтому добавляется
//    только вытянутая — по солнцу, как у процедурных зданий.
//
// 8) drawVillager() — тень жителя. Найти строку
//
//      const frame = st.still > 2 ? 0 : ((st.walk / 0.62 * 4) | 0) % 4;
//
//    и ПОСЛЕ неё добавить:
//
//      this.shadows.unit(ctx, sx, sy, w, h);
//
//    (Строка с `st.walk / 0.62` в файле одна — у животных делитель 0.7.)
//
// 9) drawAnimal() — тень зверя. Найти строку
//
//      const dir = st.dir === 1 ? 1 : 0;   // спрайт двусторонний: влево / вправо
//
//    и ПОСЛЕ неё добавить:
//
//      this.shadows.beast(ctx, sx, sy, w, h);
//
// 10) Новая игра и загрузка сейва — там, где Renderer уже существует, а мир
//     заменяется целиком (main.js/hud.js, чужая зона):
//
//       renderer.shadows.clear();
//
//     Не обязательно: кэш висит на холстах спрайтов и уходит вместе с ними.
//
// 11) НЕОБЯЗАТЕЛЬНО, только если подключён vegetation.js. В его методе draw(),
//     внутри ветки KIND_TREE, ПЕРЕД строкой
//
//       const cv = this.treeSprite(it.s, sim.seasonIdx, it.tone, it.form);
//
//     добавить (shadows передаётся в draw седьмым аргументом или берётся из
//     renderer — как удобнее интегратору):
//
//       if (shadows) shadows.prop(ctx, sx, sy, d, 0.62);
//
//     Деревья, испечённые в чанк местности (terrain.js), тени от этого модуля
//     не получат и получить не могут: они уже часть картинки чанка. Это
//     правильно — они дальний план, и их собственные силуэты работают там
//     вместо тени.
//
// ---------------------------------------------------------------------------
// ЧТО ПОЛУЧАЕТСЯ БЕЗ ЕДИНОЙ ПРАВКИ В ЯДРЕ
//
//   • контактное пятно под каждым объектом — здание, житель, зверь, дерево;
//     оно есть всегда, даже ночью, потому что это стык с землёй, а не тень
//     от солнца: без него объект отрывается от карты;
//   • вытянутая тень по солнцу — утром лежит в одну сторону, в полдень
//     короткая, вечером в другую; длина берётся из lightAt().shadowLen,
//     то есть из той же кривой, что красит небо и землю;
//   • погода: в облачность тень бледнеет вдвое и расплывается, в дождь почти
//     исчезает, в тумане уходит вместе с солнцем (fog из weather.js);
//   • ночь: вытянутая тень гаснет полностью (прямого света нет), контактное
//     пятно остаётся ослабленным втрое;
//   • самозатенение: у построек выше 1.3 тайла грани, отвёрнутые от
//     канонического света сверху-слева, гасятся, и у цоколя ложится тёмная
//     полоса — коробка перестаёт читаться плоской;
//   • смена погоды плавная: тени не схлопываются рывком, а сходят за секунду.
//
// НАСТРОЙКИ, КОТОРЫЕ МОЖНО ДЁРНУТЬ СНАРУЖИ
//
//   renderer.shadows.enabled = false;       // выключить слой целиком
//   renderer.shadows.unitContact = true;    // своё пятно под жителями
//   renderer.shadows.stats()                // { sun, castA, k, m, casts, cacheKB }
//
// unitContact по умолчанию ВЫКЛЮЧЕН намеренно: people.js впекает мягкое пятно
// под ногами прямо в лист (bakeSheet, радиальный градиент перед outline), и
// второе поверх него читается как лужа. Включать, если то пятно уберут.
//
// ---------------------------------------------------------------------------
// ПРЕСЕТЫ И БЮДЖЕТ
//
//   eco     — модуль молчит полностью (q.shadows = false).
//   medium  — тени с зума 0.8, самозатенение с 0.75, detail 1.
//   high    — тени с зума 0.65, полный набор.
//   ultra   — тени с зума 0.5.
//
// Потолок теней в кадре — caps.buildings + 70 % caps.people, но не больше 420.
// Переполнение не мигает: счётчик идёт в том же порядке, в каком renderer
// обходит отсортированный по глубине список, то есть первыми тень получают
// объекты в глубине кадра, и от кадра к кадру набор не меняется.
//
// ЦЕНА (метод А из docs/visual-performance-budget.md: вызов + getImageData,
// Chromium на SwiftShader, 1600×900, dpr 1, пресет high, зум 1.6):
//
//   город из 33 построек + 30 жителей   ~0,35 мс
//   200 построек + 300 жителей (потолок high)  ~0,9 мс
//   пресет eco / зум ниже порога        0 мс (модуль молчит)
//
// Каждая тень — ровно один drawImage плюс две setTransform; ни одной
// полноэкранной заливки, ни одного ctx.filter, ни одного createRadialGradient
// в кадре. Вся мягкость испечена: мягкий силуэт здания печётся один раз на
// спрайт (половинное разрешение, ≈ 20 КБ), общее пятно — один раз за сессию.
