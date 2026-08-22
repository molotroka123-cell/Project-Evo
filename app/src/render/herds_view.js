// render/herds_view.js — стада на карте: куча зверья, следы, зона выпаса,
// метка пугливости и угасание.
//
// ЗАЧЕМ. Модель стад (core/systems/herds.js) уже считает поголовье, участок,
// пугливость и угасание, но игрок этого не видит: рендер до сих пор рисует
// sim.animals — двадцать шесть одиночек, разбредшихся по карте случайными
// рывками. Из-за этого три решения игры остаются невидимыми:
//   • ГДЕ СТАВИТЬ СТОЯНКУ. Дичь водится на участках, а не «где-то»; без
//     показанной зоны выпаса выбор места — угадайка.
//   • ПЕРЕСТАРАЛСЯ ЛИ Я С ОХОТОЙ. Пугливость растёт с каждой облавой, и стадо
//     откочёвывает. Игрок обязан увидеть, что стадо насторожилось, ДО того,
//     как оно ушло за три дня пути, а не после.
//   • УГАСАЕТ ЛИ СТАДО. Поголовье ниже порога живучести — приговор: оно не
//     восстановится, даже если охоту прекратить. Такое стадо должно выглядеть
//     доживающим, а не полным.
//
// ГРАНИЦЫ. Модуль — чистое представление. Он читает симуляцию и НИЧЕГО в ней
// не меняет: ни поля, ни массива, ни счётчика. Он не правит ни renderer.js, ни
// people.js, ни herds.js — точные строки для вставки собраны внизу файла, в
// блоке ПОДКЛЮЧЕНИЕ. Импорт файла не имеет побочных эффектов: до первого кадра
// не печётся ни одного канваса.
//
// СЛУЧАЙНОСТЬ. Math.random запрещён во всём проекте. sim.rng в рендере
// запрещён отдельно и по другой причине: кадры идут с разной частотой у разных
// игроков и на паузе не идут вовсе, поэтому один вызов rng из кадра сдвинул бы
// состояние симуляции — сейв разошёлся бы с партией, а «тень прошлой партии»
// показала бы чужой мир. Весь разброс здесь — чистая функция от sim.world.seed,
// номера стада и номера головы (hash3 ниже). Ровно так же устроены water.js и
// vegetation.js.
//
// ЦЕНА. В кадре — только блиты испечённых спрайтов и ни одной векторной
// отрисовки зверя. Потолки жёсткие: голов в кадре не больше q.caps.beasts,
// следов не больше TRAIL_CAP, подписей не больше LABEL_CAP, атласов печётся не
// больше одного за кадр. Сколько бы стад ни было на экране — нарисовано будет
// ровно столько, сколько разрешено.
//
// ---------------------------------------------------------------------------
// ЧТО МОДУЛЬ ЖДЁТ ОТ МОДЕЛИ (core/systems/herds.js)
//
// Модуль НАМЕРЕННО не импортирует herds.js. Причины две: рендер не должен
// тащить за собой ядро ради четырёх чисел, и модель пишется параллельно —
// жёсткий импорт превратил бы любую её перестановку в чёрный экран. Вместо
// импорта — адаптер readHerds(sim), который принимает ЛЮБУЮ из двух форм:
//
//   A. состояние модели, как оно лежит в sim.herds:
//        sim.herds.herds = [{ id, kind, cx, cy, tx, ty, n, fear, doomed }, ...]
//      где cx,cy — центр участка в клетках; tx,ty — куда стадо бредёт сейчас
//      (по ним берётся направление морд); n — поголовье, дробное; fear — 0..1;
//      doomed — «порог живучести пробит, стадо обречено».
//
//   B. производный снимок sim.herdsView (его строит herdsView(state, ctx)):
//        sim.herdsView.list = [{ id, species, head, x, y, r, cap, fear, tame }]
//      здесь есть радиус участка r и ёмкость cap — их модуль предпочитает
//      своим таблицам, потому что ёмкость зависит от сезона и эпохи, а
//      статическая таблица про это не знает.
//
// Форма B точнее (в ней настоящий радиус участка), форма A всегда есть в sim.
// Если найдены обе — берётся A как источник координат и B как источник радиуса
// и ёмкости: снимок пересчитывается раз в сутки, а координаты стада меняются
// внутри суток, и рассинхрон был бы виден дрожанием.
//
// Чего модуль НЕ требует: ни одного нового поля, ни одного вызова в ядро. Если
// стада ещё не подключены, readHerds вернёт пустой список и модуль не нарисует
// ничего и не потратит ничего.
//
// ---------------------------------------------------------------------------
// ЧТО ПОЯВЛЯЕТСЯ В КАДРЕ
//
//   • КУЧА, А НЕ СЕТКА. Головы стоят кучей вокруг центра: вожак вынесен вперёд
//     по ходу движения, молодняк собран в середине под защитой, взрослые —
//     кольцом наружу. Раскладка считается золотым углом и сбивается джиттером
//     от хеша, поэтому в ней не читается ни решётки, ни спирали.
//   • СЛЕДЫ. Тропа по пройденному пути стада, отпечатки парами, выцветают за
//     TRAIL_LIFE суток. По ним видно, откуда стадо пришло и куда уходит.
//   • ЗУМ. Крупно — отдельные звери, каждый со своей фазой шага и своей
//     скоростью ног. Мелко (ниже q.lod.beastMinZoom) — тёмное пятно с числом
//     голов: на таком зуме олень занимает три пикселя, и рисовать двадцать
//     таких вместо одного пятна — выброшенное время.
//   • МЕТКА ПУГЛИВОСТИ. Пуганое стадо сбивается плотнее (куча ужимается до
//     FEAR_HUDDLE), поднимает головы (поза «настороже» вместо «пасётся») и
//     разворачивается в одну сторону. На мелком зуме то же самое читается
//     формой пятна: тугой комок с каймой вместо расплывшегося облака.
//   • ЗОНА ВЫПАСА. Лёгкое пятно радиусом участка: здесь стадо кормится, здесь
//     и стоит ставить охотничью стоянку. У пуганого стада зона поджимается —
//     видно, что дичь жмётся к краю и вот-вот уйдёт.
//   • УГАСАНИЕ. Стадо ниже порога живучести стоит реже (куча растянута),
//     бледнее и без вожака впереди: вести некому.
//
// ЗАЧЕМ ЗДЕСЬ НЕТ СВОИХ ЗВЕРЕЙ. Спрайты берутся из AnimalSprites (people.js) —
// тех же самых, которыми renderer.drawAnimal рисует sim.animals. Второй набор
// зверья означал бы, что олень на охоте и олень в стаде выглядят по-разному,
// а это не стилистическая вольность, а прямая ложь игроку. Модуль печёт из
// готового листа СВОЙ атлас поз (пасётся / настороже) и подкрашивает его под
// вид — это перекраска и наклон, а не новая графика.
import { TILE } from '../core/data.js';
import { TERRAIN, mixHex, shade, hex2rgb, rgb2css } from './palette.js';

// Мировая единица «тайл → экран» при zoom = 1. Та же константа, что в
// renderer.js и vegetation.js: она не зависит от пресета графики, и нужна
// только чтобы перевести пришедший z обратно в зум для порогов LOD.
const TILE_PX = 32;

// ---------------------------------------------------------------------------
// ПОТОЛКИ. Это именно потолки, а не цели: столько модуль НЕ нарисует ни при
// каком зуме и ни при каком числе стад.
// ---------------------------------------------------------------------------
export const HERD_LIMITS = {
  // Голов от одного стада. Стадо в шестьдесят голов на экране — это шестьдесят
  // блитов ради картинки, которая уже с двадцати читается как «много». Сверх
  // этого числа поголовье показывается подписью «×60», а не телами.
  headsPerHerd: 22,
  // Отпечатков следов в кадре по пресетам.
  trails: { eco: 0, medium: 70, high: 140, ultra: 200 },
  sprites: 32,        // испечённых пятен/отпечатков в кэше (атласы считаются отдельно)
  layouts: 64,        // раскладок куч в кэше
  labels: 8,          // подписей с числом голов за кадр
};

// Ниже этого зума не рисуются следы: отпечаток мельче пикселя, а платить за
// него приходится как за целый блит.
const TRAIL_MIN_ZOOM = 0.55;
// Ниже этого зума не рисуется даже зона выпаса: пятно вырождается в точку.
const ZONE_MIN_ZOOM = 0.22;

// Следы. Точка тропы кладётся РАЗ В ИГРОВЫЕ СУТКИ (правило «один день
// считается один раз»), живёт TRAIL_LIFE суток и всё это время выцветает.
const TRAIL_LIFE = 12;        // суток до полного исчезновения
const TRAIL_MAX = 16;         // точек тропы на стадо
const TRAIL_MIN_STEP = 0.30;  // клеток: ближе новая точка не кладётся
const TRAIL_STEP = 0.45;      // клеток между отпечатками вдоль отрезка
const TRAIL_HERDS = 48;       // за сколькими тропами вообще следим

// Пугливость. Пороги — от модели: FEAR_FLEE = 0.20 (ниже стадо не бежит),
// FEAR_MAX = 1. Метка должна загораться РАНЬШЕ бегства, иначе игрок узнаёт о
// своей жадности уже по факту откочёвки, — отсюда 0.18, чуть ниже порога.
const FEAR_ALERT = 0.18;
// Насколько куча ужимается при полном испуге. Не в ноль: стадо сбивается в
// комок, а не схлопывается в точку.
const FEAR_HUDDLE = 0.45;

// Раскладка кучи. Радиус кучи растёт как корень из поголовья — плотность
// постоянна, а не «чем больше стадо, тем гуще давка».
const SPREAD_BASE = 0.55;     // клеток на корень из головы
const YOUNG_SHARE = 0.22;     // доля молодняка
const YOUNG_R = 0.38;         // молодняк держится внутри этой доли радиуса
const LEADER_AHEAD = 1.15;    // вожак вынесен вперёд на столько радиусов кучи
const GOLDEN = 2.399963229728653;

// Угасающее стадо: куча растянута, тела бледнее. Числа подобраны так, чтобы
// разница читалась на общем плане, а не только при разглядывании.
const DOOM_SPREAD = 1.35;
const DOOM_ALPHA = 0.58;

// ---------------------------------------------------------------------------
// ВИДЫ. Не модель, а её визуальная проекция: чем один вид отличается от
// другого на экране.
//
//   base   — какой лист AnimalSprites берётся за основу. У людей в people.js
//            испечены ровно две формы: «олень» и «мамонт». Остальные виды —
//            перекраска и пропорции той же формы. Это осознанный компромисс:
//            рисовать здесь второго кабана значило бы завести в игре два
//            разных кабана. Появится своя форма в AnimalSprites — достаточно
//            поменять base, атлас подхватит её сам.
//   hgt    — рост тела в клетках при zoom = 1. Отсчёт от renderer.drawAnimal,
//            где олень 0,68, а мамонт 1,05: числа обязаны совпадать, иначе
//            зверь, перешедший из стада в sim.animals, менял бы размер.
//   wide/tall — пропорции при выпечке: кабан приземистее и шире, бык крупнее.
//   tint/tintK— подкраска шкуры: цвет и его доля.
//   radius — запасной радиус участка в клетках, если модель не прислала свой
//            (дублирует SPECIES[*].radius из herds.js).
//   viable — запасной порог живучести (дублирует minViable из herds.js).
//   ru     — как вид зовётся в подписи.
//
// ПОЧЕМУ ТАБЛИЦА ДУБЛИРУЕТ ЧИСЛА МОДЕЛИ. Потому что она запасная: если модель
// прислала r и doomed, берутся они. Дубль нужен ровно на случай формы A без
// снимка, и он помечен как запасной, чтобы никто не начал считать по нему
// баланс.
// ---------------------------------------------------------------------------
export const FORM = {
  deer:    { base: 'deer',    hgt: 0.68, wide: 1.00, tall: 1.00, tint: '#a9825a', tintK: 0.00, radius: 7, viable: 4, ru: 'Олень' },
  mammoth: { base: 'mammoth', hgt: 1.05, wide: 1.00, tall: 1.00, tint: '#6b4f35', tintK: 0.00, radius: 9, viable: 3, ru: 'Мамонт' },
  boar:    { base: 'deer',    hgt: 0.52, wide: 1.08, tall: 0.86, tint: '#4a3a2e', tintK: 0.46, radius: 6, viable: 3, ru: 'Кабан' },
  aurochs: { base: 'deer',    hgt: 0.86, wide: 1.06, tall: 1.02, tint: '#4a3b2c', tintK: 0.36, radius: 8, viable: 5, ru: 'Дикий бык' },
};
const FALLBACK_FORM = FORM.deer;
function formOf(kind) { return FORM[kind] || FALLBACK_FORM; }

// Наклон корпуса в позе «пасётся»: морда к земле. Поза «настороже» — наоборот,
// корпус чуть отыгран назад, голова вверх. Углы малы намеренно: это метка, а
// не карикатура, и она обязана читаться на силуэте в двадцать пикселей.
const GRAZE_TILT = 0.17;
const ALERT_TILT = 0.06;
const ALERT_LIFT = 0.035;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (Number.isFinite(v) ? v : d);

// ---------------------------------------------------------------------------
// ХЕШ. Свой, детерминированный, от сида мира. Ни Math.random, ни sim.rng:
// см. шапку. Три входа — сид, номер стада, номер головы, — потому что нужен
// разброс, устойчивый и к перезагрузке сейва, и к смене зума.
// ---------------------------------------------------------------------------
function hash3(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 2246822519) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

// ---------------------------------------------------------------------------
// АДАПТЕР. Единственное место, где модуль касается sim, — и то на чтение.
// Устойчив к мусору: стадо без координат, с NaN в поголовье или с видом,
// которого нет в FORM, пропускается молча. Пустой мир — пустой список.
// ---------------------------------------------------------------------------
export function readHerds(sim) {
  const out = [];
  if (!sim || typeof sim !== 'object') return out;

  // Снимок (форма B) — источник радиуса участка и ёмкости. Индексируем по id,
  // чтобы сшить с координатами из состояния.
  const viewById = new Map();
  const view = sim.herdsView;
  if (view && Array.isArray(view.list)) {
    for (const r of view.list) {
      if (!r) continue;
      viewById.set(String(r.id), r);
    }
  }

  const st = sim.herds;
  if (st && Array.isArray(st.herds)) {
    for (const h of st.herds) {
      const rec = normalizeState(h, viewById);
      if (rec) out.push(rec);
    }
    return out;
  }
  // Состояния нет — работаем по одному снимку.
  for (const r of viewById.values()) {
    const rec = normalizeView(r);
    if (rec) out.push(rec);
  }
  return out;
}

function normalizeState(h, viewById) {
  if (!h || typeof h !== 'object') return null;
  const x = num(h.cx, NaN), y = num(h.cy, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const n = num(h.n, 0);
  if (!(n > 0)) return null;
  const kind = typeof h.kind === 'string' ? h.kind : 'deer';
  const f = formOf(kind);
  const v = viewById.get(String(h.id));
  return {
    id: (h.id | 0) || 0,
    kind, form: f,
    x, y,
    tx: num(h.tx, x), ty: num(h.ty, y),
    n,
    fear: clamp(num(h.fear, 0), 0, 1),
    r: v && Number.isFinite(v.r) && v.r > 0 ? v.r : f.radius,
    // Обречённость: слово модели весомее нашей таблицы. Флага нет — считаем
    // сами по запасному порогу.
    doomed: h.doomed != null ? !!h.doomed : n < f.viable,
  };
}

function normalizeView(r) {
  const x = num(r.x, NaN), y = num(r.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const n = num(r.head, 0);
  if (!(n > 0)) return null;
  const kind = typeof r.species === 'string' ? r.species : 'deer';
  const f = formOf(kind);
  return {
    id: (parseInt(r.id, 10) | 0) || 0,
    kind, form: f,
    x, y, tx: x, ty: y,
    n,
    fear: clamp(num(r.fear, 0), 0, 1),
    r: Number.isFinite(r.r) && r.r > 0 ? r.r : f.radius,
    doomed: n < f.viable,
  };
}

// Найти стадо под точкой мира — для подсказки под курсором. Ни мутаций, ни
// выпечки: звать можно откуда угодно и сколько угодно.
export function herdAtPoint(sim, wx, wy) {
  let best = null, bd = Infinity;
  for (const h of readHerds(sim)) {
    const d = Math.hypot(h.x - wx, h.y - wy);
    // Попадание считаем по куче, а не по всему участку: участок — это зона
    // кормёжки, наводить курсор игрок будет на зверей.
    const rad = Math.max(0.9, SPREAD_BASE * Math.sqrt(Math.max(1, h.n)) * 1.4);
    if (d < rad && d < bd) { bd = d; best = h; }
  }
  return best;
}

// ===========================================================================
export class HerdsView {
  // animals — экземпляр AnimalSprites из people.js (renderer.beasts). Модуль
  // не создаёт свой: два кэша листов зверья означали бы двойную память и
  // двойную выпечку при каждой смене пресета.
  constructor(quality, animals) {
    this.q = quality || {
      id: 'high', detail: 2,
      lod: { beastMinZoom: 0.75 }, caps: { beasts: 60 },
    };
    this.animals = animals || null;

    this.time = 0;          // реальные секунды: только фаза шага, в sim не идёт
    this.day = -1;          // последние обсчитанные игровые сутки (защита от двойного счёта)
    this.seed = 0;
    this.trails = new Map();   // id → { pts: [{x,y,d}], kind, last }
    this.atlas = new Map();    // kind|detail|gen → испечённый атлас поз
    this.atlasGen = -1;
    this.sprites = new Map();  // ключ → канвас (зоны, пятна, отпечатки)
    this.layouts = new Map();  // ключ → раскладка кучи

    this._buf = [];            // буфер видимых голов, переиспользуется
    this.drawn = 0;            // голов нарисовано в прошлом кадре
    this.prints = 0;           // отпечатков нарисовано в прошлом кадре
    this.blobs = 0;            // стад показано пятном
  }

  setQuality(q) {
    this.q = q;
    // Размер выпечки листа зверя зависит от пресета (people.js: [34,54,78] по
    // detail), значит весь атлас поз протух. Пятна и отпечатки печатаются от
    // размера кадра и переживают смену пресета, но их дёшево пересобрать.
    this.atlas.clear();
    this.sprites.clear();
  }

  // Мир подменился целиком (новая игра, загрузка сейва). Без этого над свежей
  // картой секунду-другую тянутся тропы прошлой партии.
  clear() {
    this.trails.clear();
    this.layouts.clear();
    this.day = -1;
    this.seed = 0;
  }

  attach(animals) { this.animals = animals; this.atlas.clear(); }

  // =========================================================================
  // ОБНОВЛЕНИЕ. Один вызов за кадр, в самом начале draw(). Здесь только время
  // для фазы шага и тропы; ни выпечки, ни отрисовки.
  //
  // ПРАВИЛО «ОДИН ДЕНЬ СЧИТАЕТСЯ ОДИН РАЗ». Точка тропы кладётся строго при
  // смене sim.day. Повторный вызов в те же сутки не добавляет ни точки: иначе
  // тропа накапливалась бы с частотой кадров и у игрока с 144 Гц выглядела бы
  // втрое длиннее, чем у игрока с 48.
  // =========================================================================
  update(sim, dtReal) {
    if (!sim || !sim.world) return;
    // Вкладку свернули — dt приходит гигантский; фаза шага дёрнулась бы на
    // полкруга и стадо телепортировалось бы ногами.
    this.time += Math.min(0.05, Math.max(0, dtReal || 0));

    const seed = (sim.world.seed | 0) || 20250808;
    if (seed !== this.seed) { this.clear(); this.seed = seed; }

    const day = Math.floor(num(sim.day, 0));
    if (day === this.day) return;
    // День уехал назад — это загрузка сейва или новая партия. Тропы прошлой
    // жизни не имеют отношения к этой.
    if (day < this.day) this.trails.clear();
    this.day = day;

    const list = readHerds(sim);
    const alive = new Set();
    for (const h of list) {
      alive.add(h.id);
      let t = this.trails.get(h.id);
      if (!t) {
        if (this.trails.size >= TRAIL_HERDS) continue;   // потолок слежки
        t = { pts: [], kind: h.kind };
        this.trails.set(h.id, t);
      }
      t.kind = h.kind;
      const last = t.pts.length ? t.pts[t.pts.length - 1] : null;
      // Стадо стоит на месте — топчется, а не идёт. Новой точки не кладём:
      // иначе на одном месте копилась бы стопка отпечатков в чёрное пятно.
      if (!last || Math.hypot(last.x - h.x, last.y - h.y) >= TRAIL_MIN_STEP) {
        t.pts.push({ x: h.x, y: h.y, d: day });
        if (t.pts.length > TRAIL_MAX) t.pts.shift();
      }
    }
    // Прополка. Тропу пропавшего стада НЕ стираем сразу: стадо ушло или было
    // выбито, а следы его ещё сутки-другие на земле — это и есть память места.
    // Стираем только выцветшие до нуля.
    for (const [id, t] of this.trails) {
      while (t.pts.length && day - t.pts[0].d > TRAIL_LIFE) t.pts.shift();
      if (!t.pts.length && !alive.has(id)) this.trails.delete(id);
    }
  }

  // =========================================================================
  // НИЖНИЙ СЛОЙ: зона выпаса и следы. Рисуется по земле — до построек, до
  // жителей и до самих зверей.
  // =========================================================================
  drawGround(sim, ctx, ox, oy, z, cw, ch) {
    this.prints = 0;
    if (!sim || !sim.world) return;
    const zoom = z / TILE_PX;
    if (zoom < ZONE_MIN_ZOOM) return;

    const season = clamp(Math.floor(num(sim.seasonIdx, 0)), 0, 3);
    const herds = readHerds(sim);

    // --- зона выпаса ------------------------------------------------------
    // Одно пятно на стадо, один блит. Читается как «здесь выбита трава и
    // натоптано»: тон берётся от травы этого сезона, а не выдумывается.
    for (const h of herds) {
      const sx = ox + h.x * z, sy = oy + h.y * z;
      // Пуганое стадо жмётся: зона поджимается вместе с ним, и по ней видно,
      // что участок вот-вот будет брошен.
      const rr = h.r * (1 - 0.22 * h.fear);
      const rad = rr * z;
      if (sx + rad < -8 || sy + rad < -8 || sx - rad > cw + 8 || sy - rad > ch + 8) continue;
      const cv = this.zoneSprite(season, h.fear >= FEAR_ALERT, h.doomed);
      // Прозрачность падает и от испуга (участок обживают меньше), и от
      // угасания (топтать некому).
      const a = 0.30 * (h.doomed ? 0.55 : 1) * (1 - 0.25 * h.fear);
      ctx.globalAlpha = a;
      ctx.drawImage(cv, sx - rad, sy - rad, rad * 2, rad * 2);
    }
    ctx.globalAlpha = 1;

    // --- следы ------------------------------------------------------------
    const cap = HERD_LIMITS.trails[this.q.id] != null
      ? HERD_LIMITS.trails[this.q.id] : HERD_LIMITS.trails.high;
    if (!cap || zoom < TRAIL_MIN_ZOOM) return;

    // Дробная часть суток — чтобы след выцветал плавно, а не ступенькой раз в
    // игровой день.
    const now = this.day + clamp(num(sim.dayTime, 0), 0, 1);
    const size = Math.max(2, z * 0.16);
    let drawn = 0;
    for (const t of this.trails.values()) {
      if (drawn >= cap) break;
      const pts = t.pts;
      if (pts.length < 2) continue;
      const print = this.printSprite(season);
      for (let i = 1; i < pts.length && drawn < cap; i++) {
        const a = pts[i - 1], b = pts[i];
        const age = now - b.d;
        if (age >= TRAIL_LIFE) continue;
        // Квадрат — чтобы свежий след был отчётлив, а старый уходил быстро:
        // линейное затухание держит призрак тропы почти весь срок.
        const k = 1 - age / TRAIL_LIFE;
        const alpha = 0.42 * k * k;
        if (alpha < 0.02) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        const steps = Math.max(1, Math.min(6, Math.round(len / TRAIL_STEP)));
        const ang = Math.atan2(dy, dx);
        for (let s = 0; s < steps && drawn < cap; s++) {
          const u = (s + 0.5) / steps;
          const wx = a.x + dx * u, wy = a.y + dy * u;
          const px = ox + wx * z, py = oy + wy * z;
          if (px < -12 || py < -12 || px > cw + 12 || py > ch + 12) continue;
          // Отпечатки идут не по осевой линии, а вразнобой поперёк тропы:
          // стадо шло не в затылок. Смещение — от хеша, не от случайности.
          const j = (hash3(this.seed, b.d * 31 + s, i) - 0.5) * z * 0.55;
          const nx = -Math.sin(ang) * j, ny = Math.cos(ang) * j;
          ctx.globalAlpha = alpha;
          ctx.save();
          ctx.translate(px + nx, py + ny);
          ctx.rotate(ang);
          ctx.drawImage(print, -size, -size * 0.5, size * 2, size);
          ctx.restore();
          drawn++;
        }
      }
    }
    ctx.globalAlpha = 1;
    this.prints = drawn;
  }

  // =========================================================================
  // ВЕРХНИЙ СЛОЙ: сами звери или пятно с числом голов.
  // =========================================================================
  draw(sim, ctx, ox, oy, z, cw, ch) {
    this.drawn = 0; this.blobs = 0;
    if (!sim || !sim.world) return;
    const herds = readHerds(sim);
    if (!herds.length) return;

    const zoom = z / TILE_PX;
    const near = zoom >= (this.q.lod ? this.q.lod.beastMinZoom : 0.75);
    const capHeads = (this.q.caps ? this.q.caps.beasts : 60) | 0;

    // Лист зверья мог перепечься (смена пресета) — атлас поз протух вместе с
    // ним. Своя проверка по счётчику AnimalSprites.gen: она срабатывает, даже
    // если про наш setQuality забыли при подключении.
    if (this.animals && this.animals.gen !== this.atlasGen) {
      this.atlas.clear();
      this.atlasGen = this.animals.gen;
    }
    // Не больше одной выпечки атласа за кадр: четыре вида, попавшие в кадр
    // одновременно, дали бы четыре выпечки подряд и заметный рывок.
    this._bakedThisFrame = 0;

    // Порядок: ближние к центру экрана стада забирают потолок первыми. Порядок
    // устойчив (расстояние до центра меняется плавно), поэтому при исчерпании
    // потолка стада не мигают.
    const ccx = cw / 2, ccy = ch / 2;
    const order = herds
      .map(h => ({ h, d: Math.hypot(ox + h.x * z - ccx, oy + h.y * z - ccy) }))
      .sort((a, b) => a.d - b.d);

    const buf = this._buf;
    buf.length = 0;
    let labels = 0;
    const pending = [];

    for (const it of order) {
      const h = it.h;
      const sx = ox + h.x * z, sy = oy + h.y * z;
      const rad = Math.max(z, SPREAD_BASE * Math.sqrt(Math.max(1, h.n)) * 1.6 * z);
      if (sx + rad < -40 || sy + rad < -40 || sx - rad > cw + 40 || sy - rad > ch + 40) continue;

      const atlas = near ? this.atlasFor(h.kind) : null;
      if (!atlas) { pending.push(h); continue; }   // мелкий зум или атлас ещё не испечён

      const heads = Math.min(HERD_LIMITS.headsPerHerd, Math.max(1, Math.round(h.n)));
      if (buf.length + heads > capHeads) { pending.push(h); continue; }

      const alert = h.fear >= FEAR_ALERT;
      const lay = this.layoutFor(h, heads);
      // Направление хода: по цели, к которой стадо бредёт. Стоящее стадо
      // держит последнее направление — иначе на паузе морды дёргались бы.
      let hx = h.tx - h.x, hy = h.ty - h.y;
      const hl = Math.hypot(hx, hy);
      const moving = hl > 0.15;
      if (hl > 1e-4) { hx /= hl; hy /= hl; } else { hx = 1; hy = 0; }
      const bodyH = z * h.form.hgt;
      const alpha = h.doomed ? DOOM_ALPHA : 1;

      for (let i = 0; i < lay.length; i++) {
        const p = lay[i];
        // Поворот раскладки в мировые координаты: куча вытянута по ходу.
        const wx = h.x + p.lx * hx - p.ly * hy;
        const wy = h.y + p.lx * hy + p.ly * hx;
        buf.push({
          x: ox + wx * z, y: oy + wy * z, wy,
          atlas, alpha,
          bh: bodyH * p.sc,
          // Поза: пуганое стадо стоит с поднятыми головами, спокойное пасётся.
          pose: alert ? 1 : 0,
          // Фаза шага у каждого своя: стадо не марширует в ногу.
          frame: moving ? ((this.time * p.rate + p.phase) | 0) & 1
            : (p.idle ? ((this.time * 0.5 + p.phase) | 0) & 1 : 0),
          // Спокойные пасутся вразнобой, пуганые смотрят в одну сторону —
          // это половина метки пугливости.
          dir: alert ? (hx < 0 ? 1 : 0) : (p.flip ? (hx < 0 ? 0 : 1) : (hx < 0 ? 1 : 0)),
        });
      }
      // Показали не всех — честно скажем, сколько их на самом деле.
      if (heads < Math.round(h.n) && labels < HERD_LIMITS.labels && z > 14) {
        pendingLabel(this, sx, sy, h, z);
        labels++;
      }
    }

    // Порядок по глубине ВНУТРИ стада: ближняя к зрителю голова перекрывает
    // дальнюю. Сортируется буфер целиком — стада могут перекрываться, и
    // посортовое рисование дало бы швы.
    buf.sort((a, b) => a.wy - b.wy);
    for (const s of buf) {
      const A = s.atlas;
      const H = s.bh * A.k;              // высота КЛЕТКИ атласа на экране
      const W = H * (A.cw / A.ch);
      ctx.globalAlpha = s.alpha;
      ctx.drawImage(
        A.cv,
        (s.pose * 2 + s.frame) * A.cw, s.dir * A.ch, A.cw, A.ch,
        Math.round(s.x - W / 2), Math.round(s.y - H * A.ay), Math.round(W), Math.round(H),
      );
    }
    ctx.globalAlpha = 1;
    this.drawn = buf.length;
    buf.length = 0;

    // Всё, что не влезло в потолок или мельче порога зума, — пятном с числом.
    for (const h of pending) this.drawBlob(sim, ctx, ox, oy, z, cw, ch, h);
    this.flushLabels(ctx, z);
  }

  // -------------------------------------------------------------------------
  // Пятно вместо тел: тёмное облако размером по поголовью и число голов.
  // Это не «заглушка на бедность», а нужный дальний план: игрок, отъехавший на
  // весь материк, должен видеть, где вообще водится дичь.
  // -------------------------------------------------------------------------
  drawBlob(sim, ctx, ox, oy, z, cw, ch, h) {
    const sx = ox + h.x * z, sy = oy + h.y * z;
    const alert = h.fear >= FEAR_ALERT;
    // Радиус по корню из поголовья — та же плотность, что у настоящей кучи,
    // поэтому при пересечении порога зума пятно не «прыгает» в размере.
    let rw = SPREAD_BASE * Math.sqrt(Math.max(1, h.n)) * 1.5 * z;
    if (alert) rw *= (1 - 0.30 * h.fear);     // сбились плотнее
    if (h.doomed) rw *= DOOM_SPREAD;          // угасающее растянуто и редко
    rw = clamp(rw, 5, 90);
    if (sx + rw < 0 || sy + rw < 0 || sx - rw > cw || sy - rw > ch) return;

    const cv = this.blobSprite(h.kind, alert);
    ctx.globalAlpha = h.doomed ? 0.34 : 0.72;
    ctx.drawImage(cv, sx - rw, sy - rw * 0.62, rw * 2, rw * 1.24);
    ctx.globalAlpha = 1;
    this.blobs++;

    // Число голов. Только когда пятно достаточно велико: подпись в шесть
    // пикселей нечитаема, а стоит столько же, сколько читаемая.
    if (rw >= 11) pendingLabel(this, sx, sy - rw * 0.72, h, z, true);
  }

  flushLabels(ctx, z) {
    const list = this._labels;
    if (!list || !list.length) return;
    const px = clamp(Math.round(z * 0.42), 9, 17);
    ctx.save();
    ctx.font = `600 ${px}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, px * 0.28);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(14,11,8,0.82)';
    for (const l of list) {
      ctx.fillStyle = l.col;
      ctx.strokeText(l.text, l.x, l.y);
      ctx.fillText(l.text, l.x, l.y);
    }
    ctx.restore();
    list.length = 0;
  }

  // =========================================================================
  // РАСКЛАДКА КУЧИ
  //
  // Стадо — не сетка и не кольцо. Порядок такой:
  //   вожак      — вынесен вперёд по ходу: стадо идёт за ним, и по нему
  //                читается направление даже у стоящего стада;
  //   молодняк   — в середине, под защитой взрослых, и мельче ростом;
  //   взрослые   — кольцом наружу, золотым углом (равномерно без решётки),
  //                каждый сбит джиттером от хеша.
  // У обречённого стада вожака нет: вести некому, куча растянута.
  //
  // Раскладка кэшируется по «поголовье с точностью до головы + ступень
  // испуга»: пересчитывать её каждый кадр незачем, а дробная часть поголовья
  // (приплод копится долями) не должна дёргать зверей с места.
  // =========================================================================
  layoutFor(h, heads) {
    const fearStep = Math.round(h.fear * 5) / 5;
    const key = `${this.seed}|${h.id}|${heads}|${fearStep}|${h.doomed ? 1 : 0}`;
    let lay = this.layouts.get(key);
    if (lay) { touchKey(this.layouts, key); return lay; }

    const huddle = 1 - FEAR_HUDDLE * fearStep;
    const spread = SPREAD_BASE * Math.sqrt(heads) * huddle * (h.doomed ? DOOM_SPREAD : 1);
    const young = h.doomed ? 0 : Math.min(heads - 1, Math.round(heads * YOUNG_SHARE));
    const hasLeader = !h.doomed && heads > 1;
    const adults = heads - young - (hasLeader ? 1 : 0);

    lay = [];
    if (hasLeader) {
      lay.push({
        lx: spread * LEADER_AHEAD, ly: (hash3(this.seed, h.id, 0) - 0.5) * spread * 0.3,
        sc: 1.16, phase: hash3(this.seed, h.id, 101) * 2, rate: 1.5,
        flip: false, idle: false,
      });
    }
    for (let i = 0; i < adults; i++) {
      const a = i * GOLDEN + hash3(this.seed, h.id, 7) * Math.PI * 2;
      const r = spread * Math.sqrt((i + 0.6) / Math.max(1, adults));
      lay.push(makeSlot(this, h, lay.length,
        Math.cos(a) * r + (hash3(this.seed, h.id, 200 + i) - 0.5) * spread * 0.26,
        Math.sin(a) * r + (hash3(this.seed, h.id, 400 + i) - 0.5) * spread * 0.26,
        0.92 + hash3(this.seed, h.id, 600 + i) * 0.16));
    }
    for (let i = 0; i < young; i++) {
      const a = i * GOLDEN + hash3(this.seed, h.id, 11) * Math.PI * 2;
      const r = spread * YOUNG_R * Math.sqrt((i + 0.5) / Math.max(1, young));
      lay.push(makeSlot(this, h, lay.length,
        Math.cos(a) * r, Math.sin(a) * r, 0.58 + hash3(this.seed, h.id, 800 + i) * 0.1));
    }

    this.layouts.set(key, lay);
    pruneMap(this.layouts, HERD_LIMITS.layouts);
    return lay;
  }

  // =========================================================================
  // АТЛАС ПОЗ. Один канвас на вид: 4 столбца (поза × кадр шага) × 2 строки
  // (направление). Печётся ОДИН раз, дальше в кадре только блит.
  //
  // Источник — готовый лист AnimalSprites: своих зверей модуль не рисует.
  // Что добавляется поверх: наклон корпуса (пасётся / настороже), пропорции
  // вида и подкраска шкуры. Всё это — операции над готовым спрайтом, поэтому
  // стадо и одиночка остаются одним и тем же животным.
  // =========================================================================
  atlasFor(kind) {
    if (!this.animals || typeof this.animals.sheet !== 'function') return null;
    const detail = this.q.detail | 0;
    const key = `${kind}|${detail}|${this.atlasGen}`;
    const got = this.atlas.get(key);
    if (got) return got;
    if (this._bakedThisFrame >= 1) return null;   // потолок выпечки на кадр
    this._bakedThisFrame++;
    const a = this.bakeAtlas(kind);
    if (a) this.atlas.set(key, a);
    return a;
  }

  bakeAtlas(kind) {
    const f = formOf(kind);
    let src = null;
    try { src = this.animals.sheet(f.base); } catch { return null; }
    if (!src || !src.cv || !src.fw) return null;

    // Запас под наклон: повёрнутый корпус вылезает за габарит кадра, и без
    // поля ему срезало бы рога и морду.
    const pad = Math.max(2, Math.round(src.fh * 0.15));
    const dw = Math.max(1, Math.round(src.fw * f.wide));
    const dh = Math.max(1, Math.round(src.fh * f.tall));
    const CW = dw + pad * 2, CH = dh + pad * 2;
    // Точка опоры: в листе people.js земля под зверем на 93 % высоты кадра.
    const anchorY = pad + dh * 0.93;

    const cv = document.createElement('canvas');
    cv.width = CW * 4; cv.height = CH * 2;
    const c = cv.getContext('2d');
    const tmp = document.createElement('canvas');
    tmp.width = CW; tmp.height = CH;
    const tc = tmp.getContext('2d');

    for (let dir = 0; dir < 2; dir++) {
      for (let pose = 0; pose < 2; pose++) {
        for (let fr = 0; fr < 2; fr++) {
          tc.clearRect(0, 0, CW, CH);
          tc.save();
          // Наклон вокруг ног, а не вокруг центра: иначе зверь при «пасётся»
          // уезжал бы копытами в воздух.
          tc.translate(CW / 2, anchorY);
          // Морда у листа справа (dir 0) или слева (dir 1) — знак наклона идёт
          // за ней, иначе пасущийся зверь задирал бы хвост вместо головы.
          const sgn = dir === 0 ? 1 : -1;
          tc.rotate(pose === 0 ? GRAZE_TILT * sgn : -ALERT_TILT * sgn);
          tc.translate(-CW / 2, -anchorY);
          const lift = pose === 1 ? -dh * ALERT_LIFT : 0;
          tc.drawImage(src.cv, fr * src.fw, dir * src.fh, src.fw, src.fh,
            (CW - dw) / 2, pad + lift, dw, dh);
          tc.restore();
          if (f.tintK > 0) {
            // Подкраска поверх готового силуэта: source-atop бережёт светотень
            // листа и красит только там, где уже есть пиксели.
            tc.save();
            tc.globalCompositeOperation = 'source-atop';
            tc.globalAlpha = f.tintK;
            tc.fillStyle = f.tint;
            tc.fillRect(0, 0, CW, CH);
            tc.restore();
          }
          c.drawImage(tmp, (pose * 2 + fr) * CW, dir * CH);
        }
      }
    }
    // k — во сколько раз КЛЕТКА атласа выше тела зверя. Через него рост из
    // FORM.hgt (тот же, что в renderer.drawAnimal) переводится в размер блита,
    // и зверь в стаде выходит ростом ровно с одиночку, а не «примерно».
    return { cv, cw: CW, ch: CH, ay: anchorY / CH, k: CH / dh };
  }

  // =========================================================================
  // МЕЛКИЕ СПРАЙТЫ: зона выпаса, пятно стада, отпечаток. Все — один раз в
  // канвас, дальше только блит с globalAlpha.
  // =========================================================================
  zoneSprite(season, alert, doomed) {
    const key = `zone|${season}|${alert ? 1 : 0}|${doomed ? 1 : 0}`;
    const got = this.sprites.get(key);
    if (got) { touchKey(this.sprites, key); return got; }
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const c = cv.getContext('2d');
    // Цвет не выдуман: это трава ЭТОГО сезона, вытоптанная до подстилки.
    // Пуганое стадо кормится хуже — тон холоднее и тусклее.
    const grass = TERRAIN[season][TILE.GRASS];
    let col = mixHex(grass.det, '#6b5a3c', 0.42);
    if (alert) col = mixHex(col, '#5a5f66', 0.35);
    if (doomed) col = mixHex(col, grass.base, 0.45);
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0.00, hexA(col, 0.55));
    g.addColorStop(0.62, hexA(col, 0.34));
    // Кайма: без неё пятно расплывается и радиус участка не читается, а он и
    // есть подсказка «сюда ставь стоянку».
    g.addColorStop(0.87, hexA(shade(col, -0.18), 0.30));
    g.addColorStop(0.94, hexA(col, 0.14));
    g.addColorStop(1.00, hexA(col, 0));
    c.fillStyle = g;
    c.beginPath(); c.arc(S / 2, S / 2, S / 2, 0, 7); c.fill();
    this.sprites.set(key, cv);
    pruneMap(this.sprites, HERD_LIMITS.sprites);
    return cv;
  }

  blobSprite(kind, alert) {
    const key = `blob|${kind}|${alert ? 1 : 0}`;
    const got = this.sprites.get(key);
    if (got) { touchKey(this.sprites, key); return got; }
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const c = cv.getContext('2d');
    const base = formOf(kind).tint;
    const col = mixHex(base, '#20180f', alert ? 0.30 : 0.46);
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    // Пуганое стадо — тугой комок с резкой кромкой; спокойное расплывается.
    g.addColorStop(0, hexA(col, 0.92));
    g.addColorStop(alert ? 0.62 : 0.40, hexA(col, alert ? 0.80 : 0.52));
    g.addColorStop(alert ? 0.78 : 0.72, hexA(col, alert ? 0.46 : 0.20));
    g.addColorStop(1, hexA(col, 0));
    c.fillStyle = g;
    c.beginPath(); c.arc(S / 2, S / 2, S / 2, 0, 7); c.fill();
    if (alert) {
      // Кайма настороженности: тонкий светлый ободок читается на дальнем
      // плане лучше, чем любой оттенок заливки.
      c.strokeStyle = hexA(mixHex(base, '#ffe6b0', 0.55), 0.45);
      c.lineWidth = S * 0.035;
      c.beginPath(); c.arc(S / 2, S / 2, S * 0.40, 0, 7); c.stroke();
    }
    this.sprites.set(key, cv);
    pruneMap(this.sprites, HERD_LIMITS.sprites);
    return cv;
  }

  printSprite(season) {
    const key = `print|${season}`;
    const got = this.sprites.get(key);
    if (got) { touchKey(this.sprites, key); return got; }
    const W = 32, H = 16;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    // Отпечаток — вдавленная земля: тон травы, уведённый в темноту.
    const col = shade(mixHex(TERRAIN[season][TILE.GRASS].lo, '#2b2115', 0.55), -0.05);
    c.fillStyle = col;
    // Пара копыт, а не одно пятно: пятно читается как грязь, пара — как след.
    for (const k of [-1, 1]) {
      c.beginPath();
      c.ellipse(W * 0.5 + k * W * 0.13, H * 0.5, W * 0.10, H * 0.26, 0, 0, 7);
      c.fill();
    }
    this.sprites.set(key, cv);
    pruneMap(this.sprites, HERD_LIMITS.sprites);
    return cv;
  }
}

// ---------------------------------------------------------------------------
// Мелочи
// ---------------------------------------------------------------------------

function makeSlot(view, h, i, lx, ly, sc) {
  return {
    lx, ly, sc,
    phase: hash3(view.seed, h.id, 1000 + i) * 2,
    // Своя скорость ног у каждого: 1,1–1,9 «шага в секунду». Разброс небольшой
    // намеренно — стадо идёт вместе, а не рассыпается на спринтеров.
    rate: 1.1 + hash3(view.seed, h.id, 1300 + i) * 0.8,
    // Часть зверей пасётся мордой в другую сторону: стадо не строй.
    flip: hash3(view.seed, h.id, 1600 + i) < 0.34,
    // Часть переминается даже у стоящего стада — иначе картинка мертва.
    idle: hash3(view.seed, h.id, 1900 + i) < 0.28,
  };
}

function pendingLabel(view, x, y, h, z, blob) {
  if (!view._labels) view._labels = [];
  if (view._labels.length >= HERD_LIMITS.labels) return;
  view._labels.push({
    x, y: blob ? y : y - z * 0.95,
    text: `${Math.round(h.n)}`,
    col: h.doomed ? '#c9bda6' : '#f2e6c8',
  });
}

// Цвет палитры + альфа → 'rgba(...)'. Градиенту нужна строка с прозрачностью.
// Разбор идёт через hex2rgb намеренно: mixHex и shade возвращают НЕ hex, а
// 'rgb(r,g,b)', и самодельный парсер «#rrggbb» выдал бы на них NaN — ровно на
// этом в проекте уже получались чёрные трубы вместо материала (см. palette.js).
function hexA(col, a) {
  return rgb2css(hex2rgb(col), a);
}

// Map в JS хранит порядок вставки: «тронуть» ключ — значит удалить и вставить
// заново, тогда самый старый всегда первый. Тот же приём, что в quality.touch;
// свой, чтобы модуль не зависел от порядка подключения файлов.
function touchKey(map, key) {
  if (!map.has(key)) return;
  const v = map.get(key);
  map.delete(key); map.set(key, v);
}

function pruneMap(map, maxEntries) {
  while (map.size > maxEntries) {
    const k = map.keys().next().value;
    map.delete(k);
  }
}

/* ПОДКЛЮЧЕНИЕ ─────────────────────────────────────────────────────────────────

Ниже — точные строки для app/src/render/renderer.js. Сам renderer.js этим
агентом НЕ ТРОГАЛСЯ: над ним одновременно работают другие, любая правка общего
файла была бы потеряна. Вставлять руками.

Каждый якорь — существующая строка ЦЕЛИКОМ, вместе с отступами. Все проверены
на текущем файле командой `grep -cxF '<строка>' app/src/render/renderer.js`,
число совпадений указано у каждого.

═══ ШЕСТЬ ВСТАВОК ═══

1) ИМПОРТ. Якорь (1 совпадение):

import { CityLights } from './city_lights.js';

   ДОБАВИТЬ ПОСЛЕ:

import { HerdsView } from './herds_view.js';

2) КОНСТРУКТОР. Якорь (1 совпадение):

    this.beasts = new AnimalSprites(this.quality);

   ДОБАВИТЬ ПОСЛЕ:

    // Стада берут спрайты у AnimalSprites — того же листа, которым рисуются
    // одиночки в sim.animals. Второго набора зверья в игре быть не должно.
    this.herds = new HerdsView(this.quality, this.beasts);

   ВНИМАНИЕ: имя поля именно this.herds. В renderer.js оно свободно
   (grep -c 'this\.herds' renderer.js → 0 на момент написания). Путать с
   sim.herds (состояние модели) нельзя: это разные объекты в разных слоях.

3) СМЕНА ПРЕСЕТА, РУЧНАЯ. Якорь (1 совпадение, четыре пробела отступа —
   это строка внутри setQuality(id)):

    this.beasts.setQuality(this.quality);

   ДОБАВИТЬ ПОСЛЕ:

    this.herds.setQuality(this.quality);

4) СМЕНА ПРЕСЕТА, АВТОТЮНЕР. Якорь (1 совпадение, ШЕСТЬ пробелов отступа —
   это строка внутри tuneAuto(dtReal); от якоря п.3 отличается только
   отступом, поэтому копировать вместе с ним):

      this.beasts.setQuality(this.quality);

   ДОБАВИТЬ ПОСЛЕ:

      this.herds.setQuality(this.quality);

   Обе вставки нужны, но забыть одну не смертельно: модуль сам замечает, что
   AnimalSprites перепёк листы (сравнивает animals.gen), и сбрасывает атлас.

5) ОБНОВЛЕНИЕ. Якорь (1 совпадение, первые строки draw()):

    this.tuneAuto(dtReal);

   ДОБАВИТЬ ПОСЛЕ:

    // Тропы стад и фаза шага. Точка тропы кладётся строго при смене sim.day —
    // модуль сам следит, чтобы одни сутки не посчитались дважды.
    this.herds.update(sim, dtReal);

6) ЗЕМЛЯ: зона выпаса и следы. Якорь (1 совпадение):

    this.terrain.landmarks.drawLive(sim, ctx, ox, oy, z, cw, ch, this.time);

   ДОБАВИТЬ ПОСЛЕ:

    // Зона выпаса и следы — часть земли: они обязаны лежать ПОД постройками и
    // жителями, иначе тропа пойдёт по крышам.
    this.herds.drawGround(sim, ctx, ox, oy, z, cw, ch);

7) САМИ ЗВЕРИ. Якорь (1 совпадение):

    this.drawSortedEntities(sim, ctx, ox, oy, z, cw, ch, L);

   ДОБАВИТЬ ПЕРЕД (именно перед, не после):

    // Стада идут ДО общего Y-прохода: постройка и житель перекрывают зверя,
    // а не наоборот. Это тот же осознанный компромисс, что у vegetation.js:
    // честная сортировка по глубине потребовала бы правки drawSortedEntities,
    // то есть чужого файла. В кадре это почти не видно — пуганое стадо и так
    // держится от поселения подальше, а спокойное пасётся на своём участке.
    this.herds.draw(sim, ctx, ox, oy, z, cw, ch);

═══ ЧТО СДЕЛАТЬ В main.js / hud.js (чужая зона, одна строка) ═══

Новая игра и загрузка сейва — там, где Renderer уже существует, а мир
подменяется целиком:

      renderer.herds.clear();

Без этого над свежей картой секунду-другую тянутся тропы прошлой партии.
Строго говоря, модуль подстрахован сам: он сбрасывает всё, заметив смену
sim.world.seed или ход дня назад. Вызов нужен для случая «тот же сид, другой
мир» (редактор, отладочные команды).

═══ ЧТО СДЕЛАТЬ, КОГДА sim.animals УЙДЁТ ═══

Сейчас в кадре два источника зверья: sim.animals (26 оленей и 2 мамонта,
renderer.drawAnimal) и стада (этот модуль). Пока оба живы, сцена платит за
зверей дважды, и потолок q.caps.beasts тратится каждым слоем отдельно.

Порядок работ описан в herds.js, пункт R3: сперва убедиться, что охота идёт
через стада, и только ПОТОМ снимать sim.animals. Когда дойдёт до этого, в
drawSortedEntities достаточно выкинуть цикл по животным — якорь
(1 совпадение):

    for (const a of sim.animals) {

Трогать его СЕЙЧАС не надо: пустая карта вместо зверья получается именно так.

═══ ЧЕГО ДЕЛАТЬ НЕ НАДО ═══

  • НЕ звать draw() без drawGround(): счётчик выпечки атласа за кадр
    сбрасывается в draw(), а тропы копятся в update(). Порядок ровно тот, что
    выше: update → drawGround → draw.
  • НЕ передавать модулю sim.rng и не заводить в нём Math.random. Кадры идут с
    разной частотой у разных игроков, и одно случайное число из кадра сдвинуло
    бы состояние симуляции: сейв разошёлся бы с партией.
  • НЕ отдавать модулю renderer.shadows. Тени зверю не нужны: контактное пятно
    уже впечено в лист AnimalSprites (bakeAnimal рисует под зверем радиальный
    градиент). А поскольку стада рисуются ДО построек, они выбрали бы бюджет
    ShadowLayer.maxCasts раньше города — и тени пропали бы у домов.
  • НЕ вызывать clear() каждый кадр: он стирает тропы, и следов на земле не
    будет вовсе.

═══ ПРЕСЕТЫ И БЮДЖЕТ ═══

  eco     — следов нет вовсе (HERD_LIMITS.trails.eco = 0), голов не больше 20
            (q.caps.beasts), отдельные звери видны только с зума 1,1.
  medium  — до 70 отпечатков, до 36 голов, звери с зума 0,9.
  high    — до 140 отпечатков, до 60 голов, звери с зума 0,75.
  ultra   — до 200 отпечатков, до 80 голов, звери с зума 0,6.

Зона выпаса рисуется на всех пресетах: это один блит на стадо, а на карте их
полтора десятка. Она гаснет только ниже зума 0,22, где вырождается в точку.

Откуда берётся цена. Всё в кадре — блиты испечённых спрайтов:
  · зона выпаса        — 1 блит на стадо (≈16 за кадр);
  · след               — 1 блит на отпечаток, потолок по пресету;
  · голова             — 1 блит из атласа поз, потолок q.caps.beasts;
  · дальнее стадо      — 1 блит пятна плюс, если крупное, одна подпись
                         (подписей не больше HERD_LIMITS.labels = 8).
Выпечка: один атлас на вид (4 клетки × 2 направления), не больше ОДНОГО атласа
за кадр — четыре вида, въехавшие в экран разом, дали бы четыре выпечки подряд
и заметный рывок. Плюс до 32 мелких спрайтов (зоны по сезонам, пятна по видам,
отпечатки) и до 64 раскладок куч. Раскладка считается не в кадре, а один раз
на связку «стадо + поголовье с точностью до головы + ступень испуга».

Ориентир по стоимости взят из fx.js, где 149 мягких пятен стоят 1,4 мс на
программном растеризаторе: наши потолки (60 голов + 140 отпечатков + 16 зон)
дают порядок 0,6–0,9 мс на high. Замера на стенде нет — tools/shot.mjs этим
агентом не запускался (занимает порт, а рядом работают другие).

═══ ПОЧЕМУ ЗДЕСЬ НЕТ ПЕТЕЛЬ ОБРАТНОЙ СВЯЗИ ═══

Модуль ничего не считает и ни на что не влияет: он читает готовые числа модели
и раскладывает блиты. Единственное, что он копит сам, — тропы, и у них есть и
потолок (TRAIL_MAX точек на стадо, TRAIL_HERDS троп всего, потолок отпечатков
в кадре по пресету), и выход (точка живёт TRAIL_LIFE = 12 суток и стирается).
Тропа брошенного стада не висит вечно: она доживает свои двенадцать суток и
удаляется вместе с записью.

────────────────────────────────────────────────────────────────────────────── */
