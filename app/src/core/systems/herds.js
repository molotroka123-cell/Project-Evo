// core/systems/herds.js — МОДЕЛЬ: дичь как живое поголовье, а не как список мишеней.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. Сейчас в мире 26 оленей и 2 мамонта, каждый сам по себе.
// Они не размножаются: выбил — охота мертва до конца партии. Формально это уже
// «еда не бесконечная», но в самом плохом виде: игрок не получает ни сигнала,
// ни выбора, ни способа исправить. Здесь дичь становится ВОЗОБНОВЛЯЕМОЙ, НО
// ИСЧЕРПАЕМОЙ: стадо само прирастает, пока ему хватает корма и пока в нём
// достаточно голов, — и обречено, если поголовье провалилось ниже порога.
//
// ЧТО ЭТО МЕНЯЕТ В ИГРЕ. У охоты появляется цена и появляется место. Есть
// участки, где водится дичь, — значит, есть смысл ставить охотничью стоянку
// здесь, а не там. Есть облава на стаде — значит, большое стадо выгоднее
// одиночки. Есть пугливость — значит, жадность оборачивается тем, что дичь
// ушла за три дня пути и охотник тратит на дорогу больше, чем приносит.
//
// ЧИСТАЯ МОДЕЛЬ. Модуль НИЧЕГО не знает про sim и ничего в нём не пишет. Он
// получает своё состояние и снимок мира (ctx), возвращает НОВОЕ состояние и
// отчёт { state, events, reasons, flags }. Входное состояние не мутируется —
// проверено тестом. Применяет отчёт integrate.js (точные строки — в блоке
// ПОДКЛЮЧЕНИЕ в конце файла).
//
// СЛУЧАЙНОСТЬ ТОЛЬКО ЧЕРЕЗ ПЕРЕДАННЫЙ rng. Math.random здесь запрещён: на
// детерминизме держатся сохранения и «тень прошлой партии». Функции, которым
// rng не нужен (ёмкость, сводка, поиск ближайшего стада), не берут его вовсе —
// их безопасно звать из рендера сколько угодно раз.
//
// ГДЕ ПОТОЛКИ И ГДЕ ВЫХОДЫ (правило «у каждой петли потолок и выход»):
//   · прирост  — потолок ёмкость участка (логистика), выхода не нужно;
//   · убыль    — пол ноль, стадо снимается с карты;
//   · пугливость — потолок FEAR_MAX = 1, выход: полураспад FEAR_HALF_LIFE дней.
//     Перестал охотиться на месяц — стадо вернулось;
//   · «выбил участок — он пуст навсегда» — выход через РАССЕЛЕНИЕ: сытое стадо
//     у самой ёмкости изредка отделяет от себя новое и занимает пустой участок.
//     Без этого ёмкость мира храповиком падала бы вниз и партия становилась бы
//     непоправимой;
//   · вымирание вида — единственная НАМЕРЕННО безвыходная петля: последнее
//     стадо угасло — вида больше нет. Поэтому оно и оформлено громким событием,
//     а не тихой пропажей: игрок обязан узнать, что он сделал.

import { TILE, DAYS_PER_SEASON } from '../data.js';

// ---------- Единицы времени и сезона ----------

export const YEAR = DAYS_PER_SEASON * 4;      // 100 дней
export const WINTER = 3;                      // индекс зимы в SEASONS

// Сколько корма даёт участок по сезонам: весна, лето, осень, зима.
// Зима — половина: под снегом ветошь, а не пастбище. Весна ниже лета (прошлый
// травостой съеден, новый не поднялся), осень выше (нагул перед зимой). Именно
// из-за зимнего провала стада слабеют к концу года, а не «просто так».
export const SEASON_FEED = [0.85, 1.0, 1.15, 0.5];

// Насколько зима бьёт по конкретному виду — множитель к ГЛУБИНЕ зимнего
// провала, а не к самому корму. winterBite = 1 значит «полный провал по
// таблице», 0 — «зима не заметна». Без этого поля мамонт вымирал от одной
// зимы: при ёмкости в 6 голов и приросте 1% в сутки он терял за зиму больше,
// чем успевал вернуть за остальные три сезона. А мамонт как раз к зиме и
// приспособлен — он разгребает снег бивнями, в отличие от кабана, которому
// мёрзлую землю не взрыть.
export function seasonFeed(sp, seasonIdx) {
  const base = SEASON_FEED[clampInt(seasonIdx, 0, 3)];
  if (clampInt(seasonIdx, 0, 3) !== WINTER) return base;
  return 1 - (1 - base) * sp.winterBite;
}

// ---------- Виды ----------
//
// Четыре рода, каждый со своим смыслом, зоопарка не заводим.
//
// Поля:
//   meat      — еды с одной головы (сопоставимо с a.food в старом makeAnimal);
//   minViable — ПОРОГ ЖИВУЧЕСТИ: ниже него стадо не восстанавливается;
//   growth    — доля прироста в сутки при поголовье, стремящемся к нулю
//               (максимум логистической кривой, см. dailyChange);
//   radius    — радиус участка в клетках: круг, который стадо выедает;
//   density   — сколько голов кормит единица «кормовой ценности» участка;
//   feed      — кормовая ценность клетки для этого вида;
//   herds     — сколько стад ставится при рождении мира;
//   fill      — какую долю ёмкости участка занимает новорождённое стадо;
//   maxHerds  — потолок расселения: больше стад вид не заводит;
//   speed     — на сколько клеток в сутки смещается центр участка;
//   winterBite— насколько глубоко зима бьёт именно по этому виду;
//   lastEra   — последняя эпоха, в которой вид ещё держится (индекс в ERAS);
//   injury    — вероятность, что охота стоит раненого (кабан).
//
// ПОЧЕМУ ПОРОГ ЖИВУЧЕСТИ ИМЕННО ТАКОЙ. Это не «мало голов» вообще, а «мало
// взрослых самок и некому отбиваться от хищников». Для стадных копытных это
// первые единицы голов: три-пять. У быка порог выше (5) — он держится
// численностью; у кабана ниже (3) — он плодовит и одиночка выживает.
export const SPECIES = {
  deer: {
    id: 'deer', ru: 'Олень', ruMany: 'олени', ruGen: 'оленей', icon: '🦌',
    meat: 9, minViable: 4, growth: 0.030, radius: 7, density: 0.145,
    feed: { [TILE.FOREST]: 1.3, [TILE.GRASS]: 1.0, [TILE.HILL]: 0.45, [TILE.SAND]: 0.10 },
    herds: 4, fill: [0.60, 0.85], maxHerds: 6, speed: 0.60,
    winterBite: 1.0, lastEra: 9, injury: 0, tameable: false,
  },
  mammoth: {
    id: 'mammoth', ru: 'Мамонт', ruMany: 'мамонты', ruGen: 'мамонтов', icon: '🦣',
    // Мало голов, много мяса, почти не плодится: одна взятая голова стоит виду
    // почти года прироста. Он и должен вымереть первым — это урок, а не
    // досадность. Зима ему при этом почти нипочём: он к ней и приспособлен.
    meat: 55, minViable: 3, growth: 0.014, radius: 9, density: 0.038,
    feed: { [TILE.GRASS]: 1.0, [TILE.HILL]: 0.9, [TILE.FOREST]: 0.7, [TILE.SAND]: 0.15 },
    herds: 2, fill: [0.70, 0.95], maxHerds: 3, speed: 0.35,
    winterBite: 0.25, lastEra: 1, injury: 0, tameable: false,
  },
  boar: {
    id: 'boar', ru: 'Кабан', ruMany: 'кабаны', ruGen: 'кабанов', icon: '🐗',
    // Плодовит и потому прощает охоту, но зимой ему хуже всех: мёрзлую землю
    // не взрыть, а корм у него под землёй.
    meat: 13, minViable: 3, growth: 0.055, radius: 6, density: 0.20,
    feed: { [TILE.FOREST]: 1.4, [TILE.GRASS]: 0.35, [TILE.HILL]: 0.30, [TILE.SAND]: 0.05 },
    herds: 3, fill: [0.55, 0.85], maxHerds: 6, speed: 0.50,
    winterBite: 1.15, lastEra: 9, injury: 0.22, tameable: false,
  },
  aurochs: {
    id: 'aurochs', ru: 'Дикий бык', ruMany: 'быки', ruGen: 'быков', icon: '🐂',
    meat: 24, minViable: 5, growth: 0.020, radius: 8, density: 0.155,
    feed: { [TILE.GRASS]: 1.4, [TILE.HILL]: 0.7, [TILE.FOREST]: 0.4, [TILE.SAND]: 0.10 },
    herds: 3, fill: [0.60, 0.90], maxHerds: 5, speed: 0.45,
    winterBite: 0.90, lastEra: 9, injury: 0.05,
    tameable: true,          // кандидат на приручение
  },
};

export const KINDS = Object.keys(SPECIES);

// ---------- Числа модели ----------

// Обречённое стадо тает с этой скоростью в сутки. Полураспад ≈ 34 дня: игрок
// успевает увидеть, что стадо гибнет, и понять, что он с ним сделал. Мгновенная
// пропажа читалась бы как баг, а вечное доживание — как отсутствие последствий.
export const DOOM_DECAY = 0.020;

// Потолок ГОЛОДНОЙ убыли (не путать с обречённостью): столько стадо теряет за
// сутки бескормицы. За зиму в 25 суток это ≈ 26% поголовья — зима заметна,
// но не смертельна. См. развёрнутое объяснение в dailyChange().
export const STARVE_MAX = 0.012;

// Участок под стадо годится, только если прокормит хотя бы столько порогов
// живучести. Иначе новое стадо ставится на землю, которая его не держит, и
// умирает само по себе на десятый день — игрок при этом ничего не сделал.
export const PLOT_MIN_CAP = 1.8;

// Ниже этого стадо снимается с карты: держать «0.3 головы» в сейве незачем.
export const EXTINCT_AT = 0.5;

// Пугливость. FEAR_MAX — потолок петли, FEAR_HALF_LIFE — её выход.
export const FEAR_MAX = 1;
export const FEAR_HALF_LIFE = 12;             // дней до половины испуга
export const FEAR_HUNT = 0.07;                // за сам факт облавы
export const FEAR_PER_HEAD = 0.06;            // за каждую взятую голову
export const FEAR_LEADER = 0.15;              // если убит вожак — стадо в панике

// Куда уходит пуганое стадо. Житель проходит MOVE_SPEED = 7 клеток в сутки,
// значит 22 клетки — это ровно «три дня пути», о которых говорит ТЗ.
export const FLEE_DIST = 22;
export const FEAR_FLEE = 0.20;                // ниже этого стадо не бежит вовсе
export const FAR_WARN = 16;                   // с этого расстояния жалуемся игроку

// Пуганое стадо не подпускает: столько добычи теряется при полном испуге.
export const FEAR_YIELD = 0.45;

// Облава. Одна ходка охотника берёт HUNT_BASE головы на одиночке и тем больше,
// чем крупнее стадо: гнать стадо в загон проще, чем скрадывать одного зверя.
// DRIVE_HALF — поголовье, на котором взята половина прибавки.
export const HUNT_BASE = 0.9;
export const DRIVE_MAX = 0.9;                 // до +90% добычи за облаву
export const DRIVE_HALF = 8;
// Больше трети стада за один заход не берут никогда: остальные разбегаются.
// Это же и защита от «одним заходом выбил стадо целиком».
export const HUNT_MAX_SHARE = 0.35;
// Но одинокого зверя добрать можно всегда — иначе доживающее стадо в одну
// голову было бы неуязвимо и висело бы на карте вечно.
export const HUNT_MIN_HEADS = 1;
// Вожак гибнет тем вероятнее, чем большую долю стада выбили за заход.
export const LEADER_RISK = 0.5;

// Расселение — выход из петли «выбил участок, он пуст навсегда».
export const SPLIT_SHARE = 0.85;              // стадо должно стоять у ёмкости
export const SPLIT_CHANCE = 0.010;            // ≈ раз в 100 сытых суток
export const SPLIT_TAKE = 0.38;               // какую долю уводит отделившееся
export const SPLIT_MIN_DIST = 2.2;            // в радиусах участка от родителя
export const SPLIT_MAX_DIST = 4.5;

// Приручение: стадо должно быть у поселения и в силе, иначе приручать нечего.
export const TAME_DIST = 14;
export const TAME_MIN_EXTRA = 2;              // голов сверх порога живучести

// Где стада ставятся при рождении мира — кольцо вокруг поселения. Ближе 9
// клеток дичь стояла бы прямо в огороде, дальше 34 её не нашли бы никогда.
export const SPAWN_MIN_R = 9;
export const SPAWN_MAX_R = 34;

// Как густо звери стоят вокруг центра. Радиус кучи растёт как корень из
// поголовья — так плотность остаётся постоянной и стадо выглядит стадом,
// а не россыпью точек по всему участку.
export const SPREAD_BASE = 0.55;

// Не чаще раза в столько дней жалуемся игроку про один и тот же вид: без
// этого «стада откочевали» писалось бы в журнал каждые сутки.
export const SAY_GAP = 30;

// Сколько дней помним каждую охоту. Ровно для одной фразы — «за месяц выбито
// N голов». ПАМЯТЬ ХРАНИТ СОБЫТИЯ, А НЕ СОСТОЯНИЕ: список записей об охотах
// подрезается по дате и потому не растёт, в отличие от счётчика, который надо
// было бы гасить вручную и который однажды застрял бы на потолке.
export const HUNT_LOG_DAYS = 30;

// Имена вожаков. Стадо без вожака — строка в таблице; стадо с Круторогим —
// то, за чем игрок следит.
export const LEADER_NAMES = [
  'Круторогий', 'Седой', 'Меченый', 'Однорогий', 'Бурый', 'Хромой',
  'Вислоух', 'Пятнистый', 'Косач', 'Старый', 'Чёрный', 'Белолобый',
];

// ---------- Состояние ----------

export function createHerds() {
  return {
    v: 1,
    day: -1,            // защита от двойного счёта в те же сутки
    nextId: 1,
    herds: [],          // см. makeHerd()
    seen: {},           // kind → был ли вид на карте вообще
    gone: {},           // kind → день, когда вид выбит НАВСЕГДА
    hunts: [],          // [{day, kind, heads}] — только за последние HUNT_LOG_DAYS
    lastSaid: {},       // kind → день последней жалобы в журнал
  };
}

function makeHerd(id, kind, x, y, n, leader, day) {
  return {
    id, kind,
    cx: x, cy: y,       // центр участка
    tx: x, ty: y,       // куда стадо бредёт сейчас
    n,                  // поголовье (дробное: приплод копится по долям головы)
    fear: 0,
    leader,
    since: day,         // когда стадо появилось
    lastHunt: -9999,
    doomed: false,      // порог живучести уже пробит, сказано об этом один раз
    wander: 0,          // сколько суток осталось идти к нынешней цели
  };
}

export function serializeHerds(state) {
  const s = state || createHerds();
  return {
    v: 1,
    day: s.day,
    nextId: s.nextId,
    herds: s.herds.map(h => ({ ...h })),
    seen: { ...s.seen },
    gone: { ...s.gone },
    hunts: s.hunts.map(r => ({ ...r })),
    lastSaid: { ...s.lastSaid },
  };
}

// Устойчиво к битому и к старому файлу: всё, что не разобралось, отбрасывается,
// а не роняет партию. Сейв с полем kind, которого больше нет в SPECIES, — это
// не ошибка игрока, а наша правка данных; молча пропускаем.
export function restoreHerds(data) {
  const s = createHerds();
  if (!data || typeof data !== 'object') return s;
  s.day = num(data.day, -1);
  s.nextId = Math.max(1, Math.floor(num(data.nextId, 1)));
  if (data.seen && typeof data.seen === 'object') {
    for (const k of KINDS) if (data.seen[k]) s.seen[k] = true;
  }
  if (data.gone && typeof data.gone === 'object') {
    for (const k of KINDS) if (Number.isFinite(data.gone[k])) s.gone[k] = data.gone[k];
  }
  if (data.lastSaid && typeof data.lastSaid === 'object') {
    for (const k of KINDS) if (Number.isFinite(data.lastSaid[k])) s.lastSaid[k] = data.lastSaid[k];
  }
  if (Array.isArray(data.hunts)) {
    for (const r of data.hunts) {
      if (!r || !SPECIES[r.kind]) continue;
      s.hunts.push({ day: num(r.day, 0), kind: r.kind, heads: Math.max(0, num(r.heads, 0)) });
    }
  }
  if (Array.isArray(data.herds)) {
    for (const h of data.herds) {
      if (!h || !SPECIES[h.kind]) continue;
      const n = Math.max(0, num(h.n, 0));
      if (n < EXTINCT_AT) continue;
      const id = Math.floor(num(h.id, s.nextId));
      const g = makeHerd(id, h.kind, num(h.cx, 0), num(h.cy, 0), n,
        typeof h.leader === 'string' ? h.leader : LEADER_NAMES[0], num(h.since, 0));
      g.tx = num(h.tx, g.cx); g.ty = num(h.ty, g.cy);
      g.fear = clamp(num(h.fear, 0), 0, FEAR_MAX);
      g.lastHunt = num(h.lastHunt, -9999);
      g.doomed = !!h.doomed;
      g.wander = Math.max(0, num(h.wander, 0));
      s.herds.push(g);
      s.seen[g.kind] = true;
      if (id >= s.nextId) s.nextId = id + 1;
    }
  }
  return s;
}

// ---------- Снимок мира ----------
//
// ЕДИНСТВЕННОЕ место, где модуль касается sim, — и то только на чтение. Всё
// остальное работает с этим плоским объектом, поэтому проверяется без мира,
// без жителей и без Simulation вообще.
export function herdsContext(sim, tileAt) {
  const world = sim && sim.world;
  const w = world ? world.w : 0, h = world ? world.h : 0;
  const read = typeof tileAt === 'function'
    ? tileAt
    : (x, y) => (world ? world.tiles[Math.floor(y) * w + Math.floor(x)] : TILE.DEEP);
  return {
    day: sim && Number.isFinite(sim.day) ? sim.day : 0,
    seasonIdx: sim && Number.isFinite(sim.seasonIdx) ? sim.seasonIdx : 0,
    eraIdx: sim && Number.isFinite(sim.eraIndex) ? sim.eraIndex : 0,
    homeX: world ? world.startX : 0,
    homeY: world ? world.startY : 0,
    w, h,
    tile: (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) return TILE.DEEP;
      return read(world, xi, yi);
    },
    hasTech: (id) => !!(sim && sim.techs && sim.techs.has && sim.techs.has(id)),
  };
}

// ---------- Ёмкость участка ----------

// Насколько вид ещё держится в эту эпоху. Мамонт не «убит охотой на 100%» —
// его добивает уходящий холод, и после lastEra его земля кормит всё хуже, пока
// не перестаёт совсем. Три эпохи на угасание: шаг 0.34 — это ровно тот случай,
// когда число выбрано под желаемый срок, а не наоборот.
export const CLIMATE_FADE = 0.34;

export function climateMult(kind, eraIdx) {
  const sp = SPECIES[kind];
  if (!sp) return 0;
  const over = (Number.isFinite(eraIdx) ? eraIdx : 0) - sp.lastEra;
  if (over <= 0) return 1;
  return Math.max(0, 1 - over * CLIMATE_FADE);
}

// Сколько голов прокормит земля вокруг точки. Считается по клеткам круга: это
// и есть «участок». Ёмкость — не украшение: от неё зависят и прирост, и то,
// переживёт ли стадо зиму.
export function capacityAt(ctx, kind, cx, cy) {
  const sp = SPECIES[kind];
  if (!sp) return 0;
  const r = sp.radius, rr = r * r;
  let sum = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > rr) continue;
      sum += sp.feed[ctx.tile(cx + dx, cy + dy)] || 0;
    }
  }
  return sum * sp.density * seasonFeed(sp, ctx.seasonIdx) * climateMult(kind, ctx.eraIdx);
}

// Кормовая ценность точки — среднее по 3×3. По одной клетке стадо целилось бы
// в отдельные пиксели леса и дёргалось бы каждый день.
function feedScore(ctx, sp, x, y) {
  let s = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    s += sp.feed[ctx.tile(x + dx, y + dy)] || 0;
  }
  return s / 9;
}

function walkable(ctx, x, y) {
  const t = ctx.tile(x, y);
  return t === TILE.GRASS || t === TILE.FOREST || t === TILE.HILL || t === TILE.SAND;
}

// «Низина» для зимнего спуска: трава и песок ниже холма, лес — посередине.
// Зимой на холме ветер сдувает снег вместе с кормом, внизу корм остаётся.
function lowland(ctx, x, y) {
  const t = ctx.tile(x, y);
  if (t === TILE.GRASS || t === TILE.SAND) return 1;
  if (t === TILE.FOREST) return 0.6;
  if (t === TILE.HILL) return 0;
  return 0;
}

// ---------- Прирост ----------

// ЛОГИСТИКА, А НЕ ПРЯМАЯ. Наивный прирост «+X голов в день» даёт две беды
// сразу. Первая: стадо из трёх голов восстанавливается ровно так же быстро,
// как стадо из тридцати, — и у игрока нет ни одной причины оставлять маточное
// поголовье, выбивать выгодно под ноль. Вторая: рост ничем не кончается, и
// мясо снова становится бесконечным, только с задержкой.
//
// dn = n · g · (1 − n/K) чинит обе. Прирост пропорционален тому, КОМУ плодиться
// (n), и тому, СКОЛЬКО ещё осталось корма (1 − n/K). На самой ёмкости он ровно
// ноль, за ёмкостью — отрицательный. А максимум прироста приходится на n = K/2:
// это и есть точка, где стадо отдаёт больше всего мяса в год, и игрок, который
// это заметил, начинает вести стадо, а не истреблять.
export function dailyChange(n, K, sp) {
  if (n <= 0) return 0;
  // ПОРОГ ЖИВУЧЕСТИ. Ниже него логистика не работает вообще: дело не в корме,
  // а в том, что стадо перестало быть стадом — некому водить, некому отбивать
  // молодняк от волков, гон не собирается. Отсюда обрыв, а не плавный спад.
  if (n < sp.minViable) return -n * DOOM_DECAY;
  if (K < 1) return -n * STARVE_MAX;          // земля не кормит: зима, климат, гарь
  const dn = n * sp.growth * (1 - n / K);
  // ПОТОЛОК УБЫЛИ. Голая логистика при n вдвое выше ёмкости даёт −n·g в сутки,
  // и осенний перекорм убивал бы стадо за одну зиму: осень кормит 1.15, зима
  // 0.5, то есть каждый год стадо оказывается вдвое выше зимней ёмкости. От
  // бескормицы за зиму гибнет часть стада, а не стадо. STARVE_MAX = 0.012 —
  // это не больше четверти поголовья за 25 зимних суток.
  return dn < 0 ? Math.max(dn, -n * STARVE_MAX) : dn;
}

// ---------- Рождение мира ----------

// Поиск участка под стадо. Детерминированный обход по сетке даёт одинаковый
// СПИСОК кандидатов на одном сиде; rng выбирает из лучших, чтобы миры не были
// одинаковыми до клетки. Порядок обхода фиксирован — от него зависит сейв.
function findPlot(ctx, sp, rng, ax, ay, minD, maxD, taken) {
  const rough = [];
  const step = 3;
  for (let y = 1; y < ctx.h - 1; y += step) {
    for (let x = 1; x < ctx.w - 1; x += step) {
      if (!walkable(ctx, x, y)) continue;
      const d = Math.hypot(x - ax, y - ay);
      if (d < minD || d > maxD) continue;
      let clash = false;
      for (const t of taken) {
        if (Math.hypot(x - t.x, y - t.y) < sp.radius * 1.6) { clash = true; break; }
      }
      if (clash) continue;
      const s = feedScore(ctx, sp, x, y);
      if (s <= 0.05) continue;
      rough.push({ x, y, s });
    }
  }
  if (!rough.length) return null;
  // Двухступенчатый отбор. Грубо — по 3×3 (дёшево, но врёт: клетка леса среди
  // камней выглядит отлично). Точно — по настоящей ёмкости участка, но только
  // для полусотни лучших: считать круг радиусом 9 для двух тысяч кандидатов
  // впустую дорого, а по одной клетке выбирать нельзя.
  rough.sort((a, b) => b.s - a.s || a.y - b.y || a.x - b.x);
  const shortlist = rough.slice(0, Math.min(50, rough.length));
  const good = [];
  for (const c of shortlist) {
    const K = capacityAt(ctx, sp.id, c.x, c.y);
    if (K < sp.minViable * PLOT_MIN_CAP) continue;
    good.push({ x: c.x, y: c.y, K });
  }
  if (!good.length) return null;
  good.sort((a, b) => b.K - a.K || a.y - b.y || a.x - b.x);
  // Берём из верхней десятки: лучшая клетка всегда одна и та же, и без этого
  // все стада вида на карте лепились бы в один угол самого жирного леса.
  const top = good.slice(0, Math.min(10, good.length));
  return top[rng.int(0, top.length - 1)];
}

// Расставить стада при рождении мира. Виды, чья эпоха прошла, не ставятся
// вовсе — и в gone не пишутся: их не выбили, их просто уже не застали.
export function spawnHerds(state, ctx, rng) {
  const S = cloneState(state);
  const events = [];
  const taken = [];
  for (const kind of KINDS) {
    const sp = SPECIES[kind];
    if (ctx.eraIdx > sp.lastEra) continue;
    if (S.gone[kind] != null) continue;              // выбитый вид не возвращается
    let placed = 0;
    for (let i = 0; i < sp.herds; i++) {
      const p = findPlot(ctx, sp, rng, ctx.homeX, ctx.homeY, SPAWN_MIN_R, SPAWN_MAX_R, taken);
      if (!p) break;
      taken.push(p);
      // Размер стада — не выдуманное число, а доля ЁМКОСТИ найденного участка.
      // Фиксированные «8–14 голов» ставили на бедный лесок стадо втрое выше
      // его ёмкости, и оно вымирало за сотню дней само, без единого охотника.
      const n = Math.max(sp.minViable + 1, Math.round(p.K * rng.range(sp.fill[0], sp.fill[1])));
      const h = makeHerd(S.nextId++, kind, p.x, p.y, n, rng.pick(LEADER_NAMES), ctx.day);
      h.wander = rng.range(1, 4);
      S.herds.push(h);
      placed++;
    }
    if (placed) S.seen[kind] = true;
  }
  S.day = ctx.day;
  return { state: S, events, reasons: [], flags: summaryFlags(S, ctx) };
}

// ---------- Дневной ход ----------

// Куда стадо пойдёт дальше. Стадо не бродит случайными рывками по всей карте
// (так делал старый tickAnimals) — оно кочует ПО УЧАСТКУ и смещается к корму.
// Три силы разом: корм, зимний спуск в низины и страх перед поселением.
function pickTarget(h, sp, ctx, rng) {
  const roam = sp.radius * 0.9;
  const winter = ctx.seasonIdx === WINTER;
  const wantAway = h.fear > FEAR_FLEE ? FLEE_DIST * h.fear : 0;
  let bx = h.cx, by = h.cy, bs = -Infinity;
  // Пять проб плюс нынешнее место: стадо имеет право никуда не идти.
  for (let i = 0; i <= 5; i++) {
    let x, y;
    if (i === 0) { x = h.cx; y = h.cy; }
    else {
      const a = rng.range(0, Math.PI * 2), r = rng.range(roam * 0.3, roam);
      x = Math.round(h.cx + Math.cos(a) * r);
      y = Math.round(h.cy + Math.sin(a) * r);
    }
    if (x < 1 || y < 1 || x >= ctx.w - 1 || y >= ctx.h - 1) continue;
    if (!walkable(ctx, x, y)) continue;
    let s = feedScore(ctx, sp, x, y);
    if (winter) s += lowland(ctx, x, y) * 0.55;
    if (wantAway > 0) {
      const d = Math.hypot(x - ctx.homeX, y - ctx.homeY);
      // Пока стадо ближе, чем хочет быть, каждая лишняя клетка от дома в плюс.
      s += Math.min(1, d / wantAway) * h.fear * 1.6;
    }
    if (s > bs) { bs = s; bx = x; by = y; }
  }
  return { x: bx, y: by };
}

// Шаг центра к цели. Своя короткая версия вместо world.stepToward: та мутирует
// переданную сущность и требует world, а здесь и то и другое ни к чему.
function stepCenter(h, ctx, dist) {
  const dx = h.tx - h.cx, dy = h.ty - h.cy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const step = Math.min(dist, len);
  const nx = h.cx + (dx / len) * step, ny = h.cy + (dy / len) * step;
  if (walkable(ctx, nx, ny)) { h.cx = nx; h.cy = ny; return; }
  // В воду и в гору стадо не идёт: скользим вдоль препятствия, как жители.
  if (walkable(ctx, nx, h.cy)) h.cx = nx;
  else if (walkable(ctx, h.cx, ny)) h.cy = ny;
  else h.wander = 0;                         // упёрлись — на завтра новая цель
}

// ОДИН ДЕНЬ СЧИТАЕТСЯ ОДИН РАЗ. Повторный вызов в те же сутки не начисляет
// приплод второй раз, не гасит испуг дважды и — что важнее всего — не трогает
// rng: иначе два прогона одного сида разошлись бы от одного лишнего кадра.
export function herdsNewDay(state, ctx, rng) {
  const S = cloneState(state);
  const events = [], reasons = [];
  if (S.day === ctx.day) {
    return { state: S, events, reasons, flags: summaryFlags(S, ctx), skipped: true };
  }
  S.day = ctx.day;

  const winter = ctx.seasonIdx === WINTER;
  const fearKeep = Math.pow(0.5, 1 / FEAR_HALF_LIFE);
  const alive = [];
  const born = {};        // kind → сколько голов прибыло
  const lost = {};        // kind → сколько голов убыло
  const newborns = [];

  for (const h of S.herds) {
    const sp = SPECIES[h.kind];
    const K = capacityAt(ctx, h.kind, h.cx, h.cy);
    const before = h.n;

    // 1. Приплод или убыль.
    h.n = Math.max(0, h.n + dailyChange(h.n, K, sp));
    const d = h.n - before;
    if (d >= 0) born[h.kind] = (born[h.kind] || 0) + d;
    else lost[h.kind] = (lost[h.kind] || 0) - d;

    // 2. Слова про пробитый порог — ровно один раз на стадо. Это главный
    //    сигнал игроку: с этой минуты стадо не спасти, даже прекратив охоту.
    if (!h.doomed && h.n > 0 && h.n < sp.minViable) {
      h.doomed = true;
      events.push({
        text: `${sp.icon} ${sp.ru}: стадо вожака ${h.leader} разбито — осталось ${Math.floor(h.n)} гол. Меньше ${sp.minViable}: оно уже не восстановится.`,
        type: 'bad', kind: h.kind, herd: h.id, cause: 'doomed',
      });
    }

    // 3. Испуг спадает. Это и есть выход из петли жадности: перестал бить —
    //    через FEAR_HALF_LIFE дней страх вдвое меньше, через месяц почти нет.
    h.fear = h.fear * fearKeep;
    if (h.fear < 0.005) h.fear = 0;

    // 4. Кочёвка.
    h.wander -= 1;
    if (h.wander <= 0) {
      const t = pickTarget(h, sp, ctx, rng);
      h.tx = t.x; h.ty = t.y;
      // Пуганое стадо не пасётся: оно меняет место чаще.
      h.wander = rng.range(2, 5) * (h.fear > FEAR_FLEE ? 0.4 : 1);
    }
    stepCenter(h, ctx, sp.speed * (1 + h.fear * 0.8));

    // 5. Стадо кончилось.
    if (h.n < EXTINCT_AT) {
      events.push({
        text: `${sp.icon} Стадо вожака ${h.leader} больше не встречается: ${sp.ruGen} на этом участке не осталось.`,
        type: 'bad', kind: h.kind, herd: h.id, cause: 'herd_gone',
      });
      continue;
    }
    alive.push(h);
  }

  // 6. Расселение. Выход из храповика «участок выбит — он пуст навсегда».
  //    Условие намеренно жёсткое: расселяется только СЫТОЕ стадо у самой
  //    ёмкости. Пока игрок бьёт дичь быстрее, чем она прирастает, ни одно
  //    стадо до этого условия не доживёт, и мир не будет чинить себя сам.
  for (const h of alive.slice()) {
    const sp = SPECIES[h.kind];
    const count = alive.reduce((a, g) => a + (g.kind === h.kind ? 1 : 0), 0);
    if (count >= sp.maxHerds) continue;
    const K = capacityAt(ctx, h.kind, h.cx, h.cy);
    if (K < 1 || h.n < K * SPLIT_SHARE) continue;
    const take = h.n * SPLIT_TAKE;
    if (take < sp.minViable || h.n - take < sp.minViable) continue;
    if (!rng.chance(SPLIT_CHANCE)) continue;
    const p = findPlot(ctx, sp, rng, h.cx, h.cy,
      sp.radius * SPLIT_MIN_DIST, sp.radius * SPLIT_MAX_DIST,
      alive.map(g => ({ x: g.cx, y: g.cy })));
    if (!p) continue;
    h.n -= take;
    const g = makeHerd(S.nextId++, h.kind, p.x, p.y, take, rng.pick(LEADER_NAMES), ctx.day);
    g.wander = rng.range(1, 4);
    newborns.push(g);
    events.push({
      text: `${sp.icon} ${sp.ru}: молодняк отбился от стада ${h.leader} и занял новый участок — теперь их водится больше.`,
      type: 'good', kind: h.kind, herd: g.id, cause: 'split',
    });
  }
  S.herds = alive.concat(newborns);

  // 7. ВЫМИРАНИЕ ВИДА. Не тихая пропажа из массива, а событие: вид исчез с
  //    карты навсегда, и в летописи об этом обязана остаться строка.
  const extinctNow = [];
  for (const kind of KINDS) {
    if (!S.seen[kind] || S.gone[kind] != null) continue;
    if (S.herds.some(h => h.kind === kind)) continue;
    S.gone[kind] = ctx.day;
    extinctNow.push(kind);
    const sp = SPECIES[kind];
    events.push({
      text: `${sp.icon} ${sp.ru} выбит подчистую. Последнее стадо угасло — этого зверя на земле больше нет.`,
      type: 'bad', kind, cause: 'extinct',
    });
  }

  // 8. Подрезаем список охот: он держит СОБЫТИЯ за месяц, а не вечный счётчик.
  S.hunts = S.hunts.filter(r => ctx.day - r.day < HUNT_LOG_DAYS);

  // 9. Причины словами. Игрок не должен гадать, почему охотники возвращаются
  //    пустыми: ему говорят, сколько он выбил и как далеко ушла дичь.
  const takenByKind = {};
  for (const r of S.hunts) takenByKind[r.kind] = (takenByKind[r.kind] || 0) + r.heads;
  for (const kind of KINDS) {
    const list = S.herds.filter(h => h.kind === kind);
    if (!list.length) continue;
    const sp = SPECIES[kind];
    const near = list.reduce((m, h) => Math.min(m, homeDist(h, ctx)), Infinity);
    const fear = list.reduce((m, h) => Math.max(m, h.fear), 0);
    if (near > FAR_WARN && fear > 0.5 && ctx.day - (S.lastSaid[kind] || -9999) >= SAY_GAP) {
      S.lastSaid[kind] = ctx.day;
      const t = Math.round(takenByKind[kind] || 0);
      events.push({
        text: `${sp.icon} ${sp.ru}: стада откочевали — за месяц выбито ${t} гол., ближняя дичь теперь в ${Math.round(near)} клетках от поселения.`,
        type: 'warn', kind, cause: 'fled',
      });
      reasons.push({ ru: `${sp.ru}: стада откочевали от поселения на ${Math.round(near)} клеток`, v: Math.round(near) });
    }
  }
  if (winter) {
    reasons.push({ ru: 'Зима: участки кормят вдвое хуже, стада слабеют и спускаются в низины', v: SEASON_FEED[WINTER] });
  }

  const flags = summaryFlags(S, ctx);
  flags.extinctNow = extinctNow;
  flags.born = round2(Object.values(born).reduce((a, b) => a + b, 0));
  flags.lost = round2(Object.values(lost).reduce((a, b) => a + b, 0));
  return { state: S, events, reasons, flags };
}

// ---------- Поиск ----------

// Ближайшее к точке стадо. Ни rng, ни мутаций — звать можно откуда угодно,
// в том числе из assignJob на каждого жителя.
export function nearestHerd(state, x, y, opts = {}) {
  const S = state || createHerds();
  const kind = opts.kind || null;
  const minHeads = opts.minHeads != null ? opts.minHeads : 1;
  const maxDist = opts.maxDist != null ? opts.maxDist : Infinity;
  let best = null, bd = Infinity;
  for (const h of S.herds) {
    if (kind && h.kind !== kind) continue;
    if (h.n < minHeads) continue;
    const d = Math.hypot(h.cx - x, h.cy - y);
    if (d < bd && d <= maxDist) { bd = d; best = h; }
  }
  if (!best) return null;
  return { herd: best, id: best.id, kind: best.kind, dist: bd, x: best.cx, y: best.cy };
}

export function herdById(state, id) {
  const S = state || createHerds();
  return S.herds.find(h => h.id === id) || null;
}

// Где стоят отдельные головы — для отрисовки. Голова кучей вокруг центра, а не
// врассыпную: радиус кучи растёт как корень из поголовья, плотность постоянна.
// Раскладка детерминированная (золотой угол от id), без rng: картинка обязана
// совпадать до и после загрузки сейва.
export function herdPoints(h, max = 24) {
  const k = Math.min(max, Math.max(1, Math.round(h.n)));
  const spread = SPREAD_BASE * Math.sqrt(k);
  const GA = 2.399963229728653;              // золотой угол в радианах
  const phase = ((h.id * 2654435761) % 1000) / 1000 * Math.PI * 2;
  const pts = [];
  for (let i = 0; i < k; i++) {
    const a = i * GA + phase;
    const r = spread * Math.sqrt((i + 0.5) / k);
    pts.push({ x: h.cx + Math.cos(a) * r, y: h.cy + Math.sin(a) * r });
  }
  return pts;
}

// ---------- Охота ----------

// Прибавка за облаву. Гнать стадо в загон вдвоём с обрыва проще, чем скрадывать
// одиночку, — отсюда и просьба дизайна «охотники получают бонус за стадо».
// Кривая насыщающаяся, а не прямая: иначе стадо в сотню голов давало бы за
// ходку столько мяса, что склад переполнялся бы с одного захода.
export function driveBonus(n) {
  return 1 + DRIVE_MAX * (n / (n + DRIVE_HALF));
}

// Прибавка за число охотников. Корень, а не прямая: четверо берут вдвое больше
// одного, а не вчетверо. Загонщиков надо ещё и расставить, и половина дня
// уходит на согласование — линейная прибавка превратила бы охоту в
// единственный промысел в игре.
export function partyBonus(hunters) {
  return Math.sqrt(Math.max(1, hunters));
}

// Добыча от ОДНОГО захода охотников на стадо.
// opts: { hunters, skill } — skill это множитель от технологий и мастеров.
export function huntHerd(state, id, ctx, opts = {}, rng) {
  const S = cloneState(state);
  const events = [], reasons = [];
  const h = S.herds.find(g => g.id === id);
  if (!h) {
    return { state: S, ok: false, heads: 0, food: 0, injured: false,
      events, reasons: [{ ru: 'Стадо не найдено: дичь ушла раньше охотников', v: 0 }], flags: {} };
  }
  const sp = SPECIES[h.kind];
  const hunters = Math.max(1, Math.floor(num(opts.hunters, 1)));
  const skill = Math.max(0.1, num(opts.skill, 1));

  // Пуганое стадо не подпускает — вот прямая цена вчерашней жадности.
  const wary = 1 - FEAR_YIELD * h.fear;
  let want = HUNT_BASE * driveBonus(h.n) * partyBonus(hunters) * skill * wary;

  // Потолок захода: больше трети стада не берут, остальные разбегаются. Но
  // одиночку добрать можно всегда, иначе доживающее стадо висело бы вечно.
  const cap = Math.min(h.n, Math.max(HUNT_MIN_HEADS, h.n * HUNT_MAX_SHARE));
  want = Math.min(want, cap);

  // Дробная часть разыгрывается броском: так средняя добыча остаётся ровно
  // такой, как посчитано, а игрок видит целые туши, а не «1.4 оленя».
  let heads = Math.floor(want);
  if (rng && rng.chance(want - heads)) heads += 1;
  heads = Math.min(heads, Math.floor(h.n));
  if (heads < 0) heads = 0;

  h.n = Math.max(0, h.n - heads);
  h.lastHunt = ctx.day;

  // Испуг растёт от самой облавы и от каждой взятой головы. Потолок FEAR_MAX.
  let fearAdd = heads > 0 || hunters > 0 ? FEAR_HUNT + FEAR_PER_HEAD * heads : 0;

  // Вожак. Чем большую долю стада выбили, тем вероятнее, что среди убитых был
  // он, — и тем сильнее стадо мечется без него.
  let leaderLost = false;
  if (heads > 0 && rng) {
    const share = h.n + heads > 0 ? heads / (h.n + heads) : 0;
    if (rng.chance(Math.min(0.9, share * LEADER_RISK)) && h.n >= 1) {
      leaderLost = true;
      fearAdd += FEAR_LEADER;
      const old = h.leader;
      h.leader = rng.pick(LEADER_NAMES);
      events.push({
        text: `${sp.icon} ${sp.ru}: вожак ${old} убит. Стадо мечется без него и уходит от людей; новый вожак — ${h.leader}.`,
        type: 'warn', kind: h.kind, herd: h.id, cause: 'leader',
      });
    }
  }
  h.fear = Math.min(FEAR_MAX, h.fear + fearAdd);

  // Кабан опасен: охота иногда стоит раненого. Модуль НИЧЕГО не мутирует —
  // он только сообщает, что охотник ранен; здоровье жителю снимает integrate.
  let injured = false;
  if (heads > 0 && sp.injury > 0 && rng && rng.chance(sp.injury)) {
    injured = true;
    events.push({
      text: `${sp.icon} ${sp.ru} вспорол охотнику ногу: добыча взята, но человек ранен.`,
      type: 'warn', kind: h.kind, herd: h.id, cause: 'injury',
    });
  }

  const food = heads * sp.meat;
  if (heads > 0) {
    S.hunts.push({ day: ctx.day, kind: h.kind, heads });
    reasons.push({
      ru: heads > 1
        ? `Облава на стадо (${sp.ru}, было ${Math.round(h.n + heads)} гол.): взято ${heads} гол., ${Math.round(food)} еды`
        : `Гон в одиночку (${sp.ru}): взята 1 голова, ${Math.round(food)} еды`,
      v: Math.round(food),
    });
  } else {
    reasons.push({ ru: `${sp.ru}: стадо пугано и не подпустило — охотники вернулись пустыми`, v: 0 });
  }

  // Стадо могло провалиться ниже порога прямо на этой облаве. Говорим об этом
  // сразу, а не завтра: игрок должен связать причину со своим действием.
  if (!h.doomed && h.n > 0 && h.n < sp.minViable) {
    h.doomed = true;
    events.push({
      text: `${sp.icon} ${sp.ru}: в стаде осталось ${Math.floor(h.n)} гол. — меньше порога. Даже если прекратить охоту, оно угаснет.`,
      type: 'bad', kind: h.kind, herd: h.id, cause: 'doomed',
    });
  }

  return {
    state: S, ok: true, heads, food, injured, leaderLost,
    events, reasons,
    flags: { kind: h.kind, left: round2(h.n), fear: round2(h.fear), dist: round2(homeDist(h, ctx)) },
  };
}

// ---------- Приручение ----------

// ЕДИНСТВЕННЫЙ способ сделать мясо по-настоящему возобновляемым — и он обязан
// быть осознанным выбором игрока, а не автоматикой. Поэтому здесь только
// проверка условий и отчёт: решение принимает игрок, применяет integrate.
export function tameHerd(state, id, ctx) {
  const S = cloneState(state);
  const h = S.herds.find(g => g.id === id);
  const no = (ru) => ({ state: state, ok: false, heads: 0, events: [], reasons: [{ ru, v: 0 }], flags: {} });
  if (!h) return no('Стадо не найдено');
  const sp = SPECIES[h.kind];
  if (!sp.tameable) return no(`${sp.ru} не приручается: это дичь, а не скот`);
  if (!ctx.hasTech('animal_husbandry')) return no('Нет скотоводства: приручать некому и негде');
  if (homeDist(h, ctx) > TAME_DIST) return no(`Стадо слишком далеко (${Math.round(homeDist(h, ctx))} клеток): его не подвести к пастбищу`);
  if (h.n < sp.minViable + TAME_MIN_EXTRA) return no(`В стаде всего ${Math.floor(h.n)} гол. — приручать нечего, оно само не выживет`);

  const heads = Math.floor(h.n);
  S.herds = S.herds.filter(g => g.id !== id);
  // Прирученное стадо НЕ считается вымершим видом: оно живо, просто перестало
  // быть дичью. Если это было последнее дикое стадо — скажем об этом отдельно.
  const lastWild = !S.herds.some(g => g.kind === h.kind);
  return {
    state: S, ok: true, heads, lastWild,
    events: [{
      text: `${sp.icon} ${sp.ru}: стадо ${h.leader} приручено — ${heads} гол. перешли на пастбище.` +
        (lastWild ? ' Диких больше не осталось.' : ''),
      type: 'good', kind: h.kind, cause: 'tamed',
    }],
    reasons: [{ ru: `${sp.ru}: приручено ${heads} гол. — теперь это постоянный корм, а не разовая добыча`, v: heads }],
    flags: { kind: h.kind, heads, lastWild },
  };
}

// ---------- Сводка для панели ----------

function summaryFlags(S, ctx) {
  const heads = {}, count = {};
  for (const h of S.herds) {
    heads[h.kind] = round2((heads[h.kind] || 0) + h.n);
    count[h.kind] = (count[h.kind] || 0) + 1;
  }
  let nearest = Infinity;
  for (const h of S.herds) nearest = Math.min(nearest, homeDist(h, ctx));
  return {
    heads, count,
    total: round2(Object.values(heads).reduce((a, b) => a + b, 0)),
    nearest: Number.isFinite(nearest) ? round2(nearest) : null,
    gone: Object.keys(S.gone),
    extinctNow: [],
  };
}

// Строки для панели «Дичь»: сколько голов, сколько прокормит земля, куда идёт
// дело и как далеко ушла дичь. Ничего не двигает — звать из рендера безопасно.
export function herdsSummary(state, ctx) {
  const S = state || createHerds();
  const rows = [];
  for (const kind of KINDS) {
    const sp = SPECIES[kind];
    const list = S.herds.filter(h => h.kind === kind);
    if (!list.length) {
      if (S.gone[kind] != null) {
        rows.push({
          kind, ru: sp.ru, icon: sp.icon, herds: 0, heads: 0, cap: 0,
          trend: 'gone', fear: 0, dist: null,
          text: `${sp.ru}: выбит подчистую, больше не встречается`,
        });
      }
      continue;
    }
    let heads = 0, cap = 0, fear = 0, dist = Infinity, doomed = 0;
    for (const h of list) {
      heads += h.n;
      cap += capacityAt(ctx, kind, h.cx, h.cy);
      fear = Math.max(fear, h.fear);
      dist = Math.min(dist, homeDist(h, ctx));
      if (h.doomed) doomed++;
    }
    // Направление дела считаем по той же формуле, что и сам прирост, — двух
    // разных оценок быть не должно, иначе панель врёт относительно мира.
    let dn = 0;
    for (const h of list) dn += dailyChange(h.n, capacityAt(ctx, kind, h.cx, h.cy), sp);
    const trend = dn > 0.01 ? 'up' : (dn < -0.01 ? 'down' : 'flat');
    rows.push({
      kind, ru: sp.ru, icon: sp.icon,
      herds: list.length, heads: Math.round(heads), cap: Math.round(cap),
      trend, doomed,
      perYear: round2(dn * YEAR),
      fear: round2(fear), dist: round2(dist),
      text: `${sp.icon} ${sp.ru}: ${Math.round(heads)} гол. в ${list.length} ст., земля прокормит ${Math.round(cap)}` +
        (trend === 'down' ? ', поголовье падает' : (trend === 'up' ? ', прирастает' : ', держится')) +
        (fear > 0.5 ? `, стада пуганы и держатся в ${Math.round(dist)} клетках` : ''),
    });
  }
  rows.sort((a, b) => b.heads - a.heads);
  const live = rows.filter(r => r.heads > 0);
  return {
    rows,
    text: live.length
      ? live.map(r => `${r.ru} ${r.heads}`).join(', ')
      : 'Дичи в округе нет: охотиться не на кого',
    total: rows.reduce((a, r) => a + r.heads, 0),
    gone: Object.keys(S.gone).map(k => SPECIES[k] ? SPECIES[k].ru : k),
  };
}

// Сколько мяса даст округа за год, если брать ровно прирост и не больше. Число
// для игрока, который спрашивает «сколько можно есть, не проедая будущее».
export function sustainableFood(state, ctx) {
  const S = state || createHerds();
  let food = 0;
  for (const h of S.herds) {
    const sp = SPECIES[h.kind];
    const dn = dailyChange(h.n, capacityAt(ctx, h.kind, h.cx, h.cy), sp);
    if (dn > 0) food += dn * sp.meat;
  }
  return round2(food * YEAR);
}

// ---------- Мелочи ----------

function homeDist(h, ctx) {
  return Math.hypot(h.cx - ctx.homeX, h.cy - ctx.homeY);
}

// Копия состояния: модуль НЕ мутирует то, что ему передали. Иначе тест «sim до
// и после совпадает» проходил бы, а сохранение расходилось бы с прогоном.
function cloneState(state) {
  const s = state && typeof state === 'object' ? state : createHerds();
  return {
    v: 1,
    day: num(s.day, -1),
    nextId: Math.max(1, Math.floor(num(s.nextId, 1))),
    herds: Array.isArray(s.herds) ? s.herds.map(h => ({ ...h })) : [],
    seen: { ...(s.seen || {}) },
    gone: { ...(s.gone || {}) },
    hunts: Array.isArray(s.hunts) ? s.hunts.map(r => ({ ...r })) : [],
    lastSaid: { ...(s.lastSaid || {}) },
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function clampInt(v, lo, hi) { const i = Math.floor(Number.isFinite(v) ? v : lo); return i < lo ? lo : (i > hi ? hi : i); }
function num(v, def) { return Number.isFinite(v) ? v : def; }
function round2(v) { return Math.round(v * 100) / 100; }

/* ПОДКЛЮЧЕНИЕ ─────────────────────────────────────────────────────────────────

Модуль ничего не пишет сам. Ниже — точные строки для главного разработчика.
Якоря даны целиком, с отступами; число совпадений проверено grep-ом и указано.

── A. app/src/core/systems/integrate.js ──────────────────────────────────────

A1. ИМПОРТ. Якорь (1 совпадение в integrate.js):

import * as GH from './link_ghost.js';

    ВСТАВИТЬ ПОСЛЕ:

import * as HERD from './herds.js';
import { tileAt } from '../world.js';

    (если tileAt уже импортирован в integrate.js — вторую строку не добавлять)

A2. УСТАНОВКА. Якорь (1 совпадение в integrate.js):

  sim.linkGhost.seed = sim.seed | 0;

    ВСТАВИТЬ ПОСЛЕ:

  // Стада: дичь возобновляема, но исчерпаема. Ставится ПОСЛЕ мира и ДО первого
  // дня — иначе первый же охотник не найдёт ни одного стада.
  sim.herds = HERD.createHerds();
  {
    const ctx = HERD.herdsContext(sim, (world, x, y) => tileAt(world, x, y));
    const rep = HERD.spawnHerds(sim.herds, ctx, sim.rng);
    sim.herds = rep.state;
  }

A3. ДЕНЬ. Якорь (1 совпадение в integrate.js):

  applyMemoryLinks(sim, harvestScars(sim, { war: warOut, surv: survOut }));

    ВСТАВИТЬ ПЕРЕД этой строкой (стада обязаны посчитаться ДО памяти: вымирание
    вида — это событие, которое память должна записать в те же сутки):

  applyHerds(sim);

    и добавить в конец файла применитель:

function applyHerds(sim) {
  if (!sim.herds) return;
  const ctx = HERD.herdsContext(sim, (world, x, y) => tileAt(world, x, y));
  const rep = HERD.herdsNewDay(sim.herds, ctx, sim.rng);
  sim.herds = rep.state;
  for (const e of rep.events) {
    sim.addLog(e.text, e.type === 'bad' ? 'bad' : (e.type === 'good' ? 'good' : 'info'));
    if (e.cause === 'extinct') sim.addChronicle(e.text);
  }
  sim.sys.herdsReport = rep;
}

A4. СЕЙВ. Якорь (1 совпадение в integrate.js):

    ghost: sim.linkGhost || null,

    ВСТАВИТЬ ПОСЛЕ:

    herds: HERD.serializeHerds(sim.herds),

A5. ВОССТАНОВЛЕНИЕ. Якорь (1 совпадение в integrate.js):

  sim.linkGhost = GH.restoreGhost(data.ghost);

    ВСТАВИТЬ ПОСЛЕ:

  sim.herds = HERD.restoreHerds(data.herds);

A6. ПАНЕЛЬ. Якорь (1 совпадение в integrate.js):

export function mastersPanel(sim) { return MAS.mastersReport(sim); }

    ВСТАВИТЬ ПОСЛЕ:

export function herdsPanel(sim) {
  return HERD.herdsSummary(sim.herds, HERD.herdsContext(sim, (world, x, y) => tileAt(world, x, y)));
}
export function herdsSustainable(sim) {
  return HERD.sustainableFood(sim.herds, HERD.herdsContext(sim, (world, x, y) => tileAt(world, x, y)));
}

A7. ВЫМИРАНИЕ В ЛЕТОПИСЬ. Якорь (1 совпадение в integrate.js):

function harvestScars(sim, outs) {

    ВСТАВИТЬ ПЕРВОЙ строкой тела функции (после этой строки), чтобы вымирание
    вида ложилось в память как беда наравне с голодом:

  const HR = sim.sys && sim.sys.herdsReport;
  const herdScars = HR && HR.flags.extinctNow && HR.flags.extinctNow.length
    ? HR.flags.extinctNow.map(() => ({ kind: 'famine', scale: 0.8 })) : [];

    и добавить herdScars в возвращаемый список (в существующий return-массив).

── B. app/src/core/simulation.js ─────────────────────────────────────────────

B1. ВЫБОР ЦЕЛИ ОХОТЫ. Якорь (1 совпадение в simulation.js):

      const prey = this.animals.find(a => a.hp > 0);

    ЗАМЕНИТЬ НА:

      // Охотник идёт не на первого попавшегося зверя из массива, а на
      // ближайшее стадо: у охоты появляется место на карте.
      const near = herdsNearest(this, v.x, v.y);
      const prey = near ? { herd: near.id, x: near.x, y: near.y } : null;

    и следующую строку якоря (1 совпадение):

      if (prey) { v.job = 'hunt'; v.target = { kind: 'hunt', a: prey, x: prey.x, y: prey.y }; return; }

    ЗАМЕНИТЬ НА:

      if (prey) { v.job = 'hunt'; v.target = { kind: 'hunt', herd: prey.herd, x: prey.x, y: prey.y }; return; }

B2. САМА ОХОТА. Якорь — весь блок целиком (1 совпадение в simulation.js):

    if (t.kind === 'hunt') {
      const a = t.a;
      if (a.hp > 0) {
        a.hp -= 4;
        if (a.hp <= 0) {
          this.res.food = Math.min(this.resCap.food, this.res.food + a.food);
          this.animals = this.animals.filter(x => x !== a);
        }
      }
      this.release(v);
      return;
    }

    ЗАМЕНИТЬ НА:

    if (t.kind === 'hunt') {
      // Одна ходка — одна облава. Сколько взято, решает модель стада: она
      // знает и поголовье, и испуг. Здоровье охотнику снимаем здесь: модуль
      // только сообщает, что человек ранен, но сам ничего не мутирует.
      const rep = herdsHunt(this, t.herd, { hunters: 1, skill: happyMult });
      if (rep.food > 0) this.res.food = Math.min(this.resCap.food, this.res.food + rep.food);
      if (rep.injured && v.hp !== undefined) v.hp = Math.max(1, v.hp - 3);
      for (const e of rep.events) this.addLog(e.text, e.type === 'bad' ? 'bad' : 'info');
      this.release(v);
      return;
    }

B3. ИМПОРТ в simulation.js. Якорь (1 совпадение в simulation.js):

import { installSystems, systemsNewDay, systemsFactions, systemsHappyMod, systemsPopCapMod, systemsWorkMult, systemsSerialize, systemsRestore } from './systems/integrate.js';

    ВНИМАНИЕ: строку проверить grep-ом перед правкой — список имён в ней
    меняется от версии к версии. Добавить в этот же импорт herdsNearest и
    herdsHunt, а в integrate.js завести их обёртками:

export function herdsNearest(sim, x, y) {
  return HERD.nearestHerd(sim.herds, x, y, { minHeads: 1 });
}
export function herdsHunt(sim, id, opts) {
  const ctx = HERD.herdsContext(sim, (world, x, y) => tileAt(world, x, y));
  const rep = HERD.huntHerd(sim.herds, id, ctx, opts, sim.rng);
  sim.herds = rep.state;
  return rep;
}

B4. СТАРЫЕ ЗВЕРИ. Массив this.animals и tickAnimals остаются как есть — на них
    завязана отрисовка. Правильный порядок работ: сперва подключить стада и
    убедиться, что охота идёт через них (B1–B2), и только потом заменить
    источник this.animals на HERD.herdPoints() в рендере. Обе правки в одном
    заходе — верный способ получить пустую карту и не понять почему.

────────────────────────────────────────────────────────────────────────────── */
