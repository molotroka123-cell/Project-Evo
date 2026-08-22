// render/construction.js — стройка: леса, растущий силуэт, строители наверху,
// пыль и стружка у основания, вспышка в момент сдачи объекта.
//
// ЗАЧЕМ. Сейчас недостроенное здание — это ветка из четырёх строк в
// renderer.drawBuilding: полупрозрачный квадрат, пунктирная рамка и жёлтая
// полоска внизу. Одинаковая для хижины и для небоскрёба, неподвижная,
// неотличимая от «призрака размещения» (sim.placing рисуется таким же
// квадратом с рамкой). Игрок видит на карте жёлтый прямоугольник и не понимает
// ни что там строится, ни что работа вообще идёт: три жителя ходят вокруг, но
// на площадке ничего не меняется по несколько игровых дней. Момент сдачи тоже
// проходит молча — строка в журнале, которую никто не читает, и здание просто
// подменяется целым спрайтом на следующем кадре.
//
// Слой чинит ровно это. Площадка перестаёт быть заглушкой: снизу вверх растёт
// НАСТОЯЩИЙ спрайт этого здания (тот самый, который встанет здесь по
// завершении, — поэтому в момент сдачи ничего не «подменяется», картинка
// продолжается), вокруг стоят леса ростом чуть выше кладки, на верхнем настиле
// стучат молотками фигурки из b.workers, у основания вьётся пыль и летит
// стружка, в последней четверти прогресса леса разбирают сверху, а сдача
// отмечается короткой вспышкой и разлётом щепок.
//
// ГРАНИЦЫ. Модуль — чистое представление. Он ЧИТАЕТ sim и не меняет в нём ни
// одного поля; ядро о нём не знает. Ни один существующий файл не тронут —
// подключение описано внизу, в блоке «ПОДКЛЮЧЕНИЕ». Импорт файла не имеет
// побочных эффектов: до первого кадра не создаётся ни одного канваса.
//
// СЛУЧАЙНОСТЬ. Math.random в проекте запрещён, а sim.rng рендеру запрещён
// вдвойне: рендер идёт с разной частотой у разных игроков, и каждый его вызов
// сдвинул бы состояние симуляции — сейв бы поплыл. Здесь свой хеш chash() от
// координат площадки и sim.world.seed (тот же приём, что в water.js,
// relief.js, vegetation.js, damage.js) и свой LCG rngFrom() для выпечки.
// Следствие: у одной и той же стройки в одном и том же мире всегда тот же
// рисунок лесов и тот же разлёт щепок, а у соседней — другой.
//
// ЦЕНА КАДРА (оценка; метод А из docs/visual-performance-budget.md —
// Chromium/SwiftShader, 1600×900, dpr 1, пресет high, зум 1.0):
//
//   город без строек                    ~0,00 мс — begin() проходит по списку
//                                        зданий и выходит на b.done, site() не
//                                        вызывается ни разу, ни одного blit;
//   обычная игра: 2 площадки в кадре    ~0,10 мс — 2×(плита + тело + леса +
//                                        настил + 3 строителя + 4 пыли +
//                                        3 стружки) ≈ 26 блитов, из них
//                                        24 мельче 40 px;
//   потолки насухо: 12 площадок
//   + 6 вспышек                          ~0,55 мс — 156 блитов площадок плюс
//                                        6×(1 вспышка + 14 щепок) = 90.
//
// Почему так дёшево: в кадре нет НИ ОДНОГО примитива, кроме трёх fillRect на
// полоску прогресса. Леса — не сетка линий, которую рисуют каждый кадр
// (наивная версия: ~7 стоек × ~5 ярусов × 2 грани + раскосы ≈ 45 путей на
// площадку, на программном растеризаторе это доли миллисекунды НА ОДНУ
// стройку), а один выпеченный спрайт: сорок с лишним beginPath/stroke платятся
// однажды, дальше только drawImage.
//
// Второй приём, который здесь важнее выпечки: НИ ОДНОГО clip(). И растущий
// силуэт, и наполовину разобранные леса показываются через исходный
// прямоугольник drawImage(src…) — берём нижние r% пикселей источника и кладём
// в нижние r% приёмника. Это ровно то же изображение, что дал бы rect+clip, но
// без save/beginPath/clip/restore на каждую площадку: клип на Canvas2D — это
// перестройка маски растеризатора, самая дорогая из «дешёвых» операций.
//
// Выпечка не бесплатна (леса — 1,5–2,5 мс, плита площадки — ~0,6 мс), поэтому
// она нормирована: не больше q.caps.bakesPerFrame штук за кадр, как в
// terrain.js и damage.js. Если бюджет исчерпан — площадка кадр-другой стоит
// без лесов. Это видно только в первый момент закладки и проходит за 2–3 кадра;
// альтернатива — рывок кадра на 3 мс ровно тогда, когда игрок нажал «строить».
import { BUILDINGS, BUILDING_ERA_IDX } from '../core/data.js';
import { ARCH, archHeight } from './sprites.js';
import { shade } from './palette.js';
import { prune, touch, canvasBytes } from './quality.js';

// Мировая единица «тайл → экран» при zoom = 1. Та же константа, что в
// renderer.js, shadows.js, damage.js: нужна, чтобы перевести пришедший z
// обратно в зум и сверить его с порогами пресета (q.lod.* заданы в зумах).
const TILE_PX = 32;

// Потолки числа объектов в кадре. Именно потолки, а не цели: обычно их не
// достигают, но переполнение не должно стоить кадра. Дополнительно всё
// урезается пресетом — см. setQuality().
export const CONSTRUCTION_LIMITS = {
  sitesFrame: 12,      // площадок в кадре; больше двенадцати одновременных
                       // строек не бывает даже у игрока с полной казной —
                       // жителей на них всё равно не хватит (3 на объект)
  buildersPerSite: 3,  // ровно BUILDERS_PER_SITE из simulation.js: больше трёх
                       // фигурок на настиле физически неоткуда взять
  dustPerSite: 4,      // облачков пыли у основания
  chipsPerSite: 3,     // летящих стружек у основания
  flashes: 6,          // одновременных вспышек сдачи
  flashChips: 14,      // щепок в одной вспышке
  scafEntries: 24,     // записей в кэше лесов (LRU)
  plateEntries: 20,    // записей в кэше плит площадки (LRU)
  scafMB: 8,           // память под леса; ниже ещё режется q.caps.spriteMB
};

// Доля прогресса, уходящая на земляные работы. До неё силуэт не растёт вовсе:
// сначала копают, ставят опалубку и завозят материал. Без этой паузы дом
// «выпрыгивает» из земли в первый же игровой час — самая заметная фальшь
// наивной реализации «высота = прогресс».
// 0.12 — примерно один игровой день на типовой стройке (buildDays = costSum/8,
// у хижины это ~1.6 дня, у фабрики ~37): у мелких построек фундамент мелькает,
// у крупных читается как отдельная фаза, и это правильно.
const FOUNDATION_P = 0.12;

// С какого прогресса леса начинают разбирать. Три четверти — не круглое число
// ради круглого: к этому моменту силуэт открыт на (0.75-0.12)/0.88 ≈ 72 %,
// то есть коробка стоит и осталась отделка. Разбирать раньше — леса исчезнут
// с ещё голого верха; позже — разборка не успеет прочитаться, она занимает
// последние секунды стройки.
const DISMANTLE_P = 0.75;

// На сколько леса выше кладки. 0.18 тайла ≈ полтора яруса: рабочий стоит на
// настиле и кладёт стену НАД собой, значит настил обязан быть выше стены.
// Если сделать вровень, фигурки будут стоять на крыше, а не на лесах.
const SCAF_AHEAD = 0.18;

// Минимальная высота лесов. Даже на нулевом прогрессе вокруг котлована уже
// стоит нижний ярус — иначе первые игровые сутки площадка выглядит пустой.
const SCAF_MIN = 0.22;

// Сколько остаётся от лесов в самый последний момент. Не ноль: пока здание не
// сдано, у него всё ещё стоит нижний ярус, и обнулять его за кадр до вспышки —
// значит показать готовое здание раньше, чем ядро скажет b.done.
const SCAF_TAIL = 0.08;

// Высота яруса лесов в долях тайла. Масштаб карты — 1 тайл ≈ 8 м
// (docs/art-direction.md §7), стандартный подъём строительных лесов — 2 м,
// это 0.25 тайла. Берём 0.32: на 0.25 у высотки выходит четырнадцать ярусов,
// решётка сливается в серую кашу и стоит вдвое дороже выпечки.
const LEVEL_H = 0.32;
const LEVELS_MIN = 2, LEVELS_MAX = 7;

// Жизнь вспышки сдачи, секунды реального времени. 0.9 с — столько же, сколько
// живут всплывающие подписи в fx.js: короче не успевает поймать взгляд,
// длиннее превращается в фейерверк на каждом доме растущего города.
const FLASH_LIFE = 0.9;

// Рост фигурки строителя в долях тайла. Ровно тот же 0.34, что у жителя в
// renderer.drawVillager: строитель на лесах и житель, идущий мимо, обязаны
// быть одного роста, иначе масштаб сцены рассыпается.
const BUILDER_H = 0.34;

// Базовое разрешение выпечки на один тайл ширины по q.detail — те же три
// ступени, что у BASE в sprites.js, но грубее. У плиты площадки и у решётки
// лесов нет мелких деталей, которые стоило бы разрешать наравне со зданием:
// это земля, доски и трубы.
const PLATE_BASE = [40, 64, 88];
const SCAF_BASE = [44, 72, 100];
const BUILDER_BASE = [16, 24, 32];   // высота кадра фигурки в пикселях

// Материал лесов по эпохе. Граница 7 (Современность) — та же, что у
// renderer.glowSprite(sim.eraIndex < 7) для тёплого/холодного света: до неё
// город деревянный и кирпичный, после — металл и стекло.
const WOOD = { pole: '#8a6a3f', plank: '#b08d57', rope: '#c9b27a', net: null };
const TUBE = { pole: '#9aa3ab', plank: '#c2c8cc', rope: '#7fa4c8', net: 'rgba(110,190,140,0.18)' };
const METAL_ERA = 7;

// --- детерминированная случайность ----------------------------------------

// Хеш от трёх целых. Тот же скелет, что у palette.hash2 (две смеси со сдвигом
// вправо), но с третьим входом: нужно развести не только координаты площадки,
// но и зерно мира и номер частицы. Возвращает [0,1).
export function chash(a, b, c) {
  let h = ((a | 0) * 374761393 + (b | 0) * 668265263 + (c | 0) * 1103515245) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Линейный конгруэнтный генератор для выпечки. Нужен именно поток, а не хеш:
// решётка лесов — это полсотни зависимых шагов (кривизна доски, вылет стойки,
// где повесить ведро), и звать chash с новым индексом на каждый шаг дороже и
// хуже по качеству. Числа — классический Numerical Recipes; для декора этого
// более чем достаточно.
export function rngFrom(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// --- чтение состояния стройки ---------------------------------------------

// Прогресс в [0,1]. buildDays у площадки всегда > 0 (simulation.buildDays
// возвращает Math.max(0.5, …), у placeFree — 0.01), но делить на пришедшее из
// сейва число вслепую нельзя: один NaN здесь — и вся площадка исчезает с
// экрана без единой ошибки в консоли.
export function progressOf(b) {
  if (!b) return 0;
  const days = b.buildDays > 0 ? b.buildDays : 0.01;
  const p = (b.progress || 0) / days;
  return p > 0 ? (p < 1 ? p : 1) : 0;
}

// Доля силуэта, открытая снизу. До конца земляных работ — ноль.
export function revealFrac(p) {
  if (p <= FOUNDATION_P) return 0;
  return (p - FOUNDATION_P) / (1 - FOUNDATION_P);
}

// Насколько разобраны леса: 0 — целы, 1 — сняты. Работает только в последней
// четверти прогресса.
export function dismantleK(p) {
  if (p <= DISMANTLE_P) return 0;
  return (p - DISMANTLE_P) / (1 - DISMANTLE_P);
}

// Видимая доля высоты лесов. Растёт вместе с кладкой (с опережением на
// SCAF_AHEAD), потом убывает разборкой сверху.
export function scaffoldFrac(p) {
  const ahead = Math.min(1, revealFrac(p) + SCAF_AHEAD);
  const up = Math.max(SCAF_MIN, ahead);
  return up * (1 - dismantleK(p) * (1 - SCAF_TAIL));
}

// Число ярусов лесов по полной высоте постройки в тайлах.
export function levelsFor(hTiles) {
  const n = Math.round(hTiles / LEVEL_H);
  return Math.max(LEVELS_MIN, Math.min(LEVELS_MAX, n));
}

// Число стоек по ширине. Ширина шага лесов у строителей — около 2 м, то есть
// четверть тайла: у постройки в один тайл это 5 стоек, в два — 9. Потолок 8
// держит цену выпечки: каждая стойка это два stroke (грань и бок).
export function postsFor(sizeTiles) {
  return Math.max(3, Math.min(8, Math.round(4 * sizeTiles) + 1));
}

// Эпоха отделки — та же формула, что в renderer.drawBuilding: постройка
// подтягивается к текущей эпохе, но не больше чем на три ступени от своей.
// Дублируется намеренно: леса должны быть из того же века, что и стены,
// иначе вокруг глиняной хижины вырастают стальные трубы.
export function eraOf(b, sim) {
  const own = BUILDING_ERA_IDX[b.id] || 0;
  const cur = sim && sim.eraIndex !== undefined ? sim.eraIndex : own;
  return Math.max(own, Math.min(9, Math.min(cur, own + 3)));
}

// Полная высота спрайта постройки в долях ширины тайла. Считается БЕЗ обращения
// к SpriteCache — по тем же ARCH/archHeight и тому же множителю 1.12, что в
// sprites.bake(). Это принципиально: геометрию лесов надо знать на нулевом
// прогрессе, когда самого спрайта здания ещё никто не пёк, и заставлять кэш
// печь здание ради одного числа было бы 2 мс на ровном месте.
export function heightFactor(id) {
  return archHeight(ARCH[id] || 'house') * 1.12;
}

// Вариант рисунка лесов: 4 штуки. Больше не нужно — соседние стройки уже не
// повторяются, а каждый вариант это отдельная запись в кэше выпечки.
const VARIANTS = 4;
export function siteVariant(b, seed) {
  return Math.floor(chash(b.x * 3 + 17, b.y * 5 + 23, seed) * VARIANTS) % VARIANTS;
}

// --- мелочи ---------------------------------------------------------------

function mkCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  return cv;
}

// Тёмная обводка силуэта в четыре стороны. Тот же приём, что в
// sprites.strokeOutline и в спрайтах жителей, но здесь свой: тамошний не
// экспортирован, а лезть в чужой файл за одной функцией нельзя.
// Зачем вообще: фигурка строителя ростом в десять пикселей на фоне досок
// читается только контуром — без него это цветное пятно на цветном пятне.
function outline(c, body, k) {
  const sil = mkCanvas(body.width, body.height);
  const sc = sil.getContext('2d');
  sc.drawImage(body, 0, 0);
  sc.globalCompositeOperation = 'source-in';
  sc.fillStyle = 'rgba(24,18,14,0.85)';
  sc.fillRect(0, 0, sil.width, sil.height);
  for (const [dx, dy] of [[-k, 0], [k, 0], [0, -k], [0, k]]) c.drawImage(sil, dx, dy);
}

function lineTo(c, x1, y1, x2, y2, col, w) {
  c.strokeStyle = col; c.lineWidth = Math.max(1, w);
  c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
}

// ---------------------------------------------------------------------------
// ВЫПЕЧКА
// ---------------------------------------------------------------------------

// Плита площадки: перекопанная земля по пятну застройки, штабель материала,
// колышки с верёвкой. Кладётся ПОД растущий силуэт и заменяет прежний
// полупрозрачный квадрат с пунктиром.
//
// Квадрат, а не ромб: проекция в игре — «ложная изометрия» sprites.js, где
// пятно застройки это тайл, то есть квадрат, а объём даёт только сама
// постройка. Ромб здесь спорил бы с местностью.
export function bakePlate(sizeTiles, era, variant, detail) {
  const W = Math.round(PLATE_BASE[detail] * sizeTiles);
  const cv = mkCanvas(W, W);
  const c = cv.getContext('2d');
  const rnd = rngFrom(variant * 7919 + era * 131 + sizeTiles * 17 + 1);
  const soil = era >= METAL_ERA ? '#6b6b6b' : '#6d5637';

  // Земля. Не одна заливка: свежий котлован — это пятна вынутого грунта разной
  // влажности, и три десятка мазков в выпечке стоят ноль в кадре.
  c.fillStyle = soil;
  c.fillRect(0, 0, W, W);
  const spots = 10 + detail * 8;
  for (let i = 0; i < spots; i++) {
    const r = W * (0.05 + rnd() * 0.11);
    c.fillStyle = shade(soil, rnd() < 0.5 ? -0.16 : 0.14);
    c.beginPath();
    c.ellipse(rnd() * W, rnd() * W, r, r * 0.72, 0, 0, 7);
    c.fill();
  }
  // Кромка котлована: тёмная полоса по периметру — без неё плита выглядит
  // наклейкой, лежащей поверх травы, а не выемкой в ней.
  c.strokeStyle = 'rgba(20,14,8,0.42)';
  c.lineWidth = Math.max(1, W * 0.035);
  c.beginPath(); c.rect(W * 0.03, W * 0.03, W * 0.94, W * 0.94); c.stroke();

  // Штабель материала в одном из углов — по нему сразу видно, что площадка
  // живая, а не заброшенная. Угол выбирается вариантом, чтобы у соседних
  // строек материал лежал по-разному.
  const cx = (variant & 1) ? W * 0.74 : W * 0.24;
  const cy = (variant & 2) ? W * 0.74 : W * 0.26;
  const bw = W * 0.30, bh = W * 0.075;
  for (let i = 0; i < 4; i++) {
    const y = cy + bh * (1.5 - i) * 0.85;
    c.fillStyle = shade(era >= METAL_ERA ? '#8f979d' : '#a8834e', i * 0.05 - 0.06);
    c.fillRect(cx - bw / 2 + (i % 2) * bw * 0.06, y, bw, bh);
  }
  c.fillStyle = 'rgba(0,0,0,0.28)';
  c.fillRect(cx - bw / 2, cy + bh * 1.9, bw, bh * 0.5);

  // Колышки с верёвкой по краю: разметка осей. Мелочь, но именно она читается
  // как «размечено под стройку», а не «здесь копали».
  const peg = W * 0.022;
  c.fillStyle = era >= METAL_ERA ? '#c8ccd0' : '#c9b27a';
  for (let i = 0; i < 4; i++) {
    const t = 0.12 + i * 0.25;
    c.fillRect(W * t, W * 0.02, peg, W * 0.07);
    c.fillRect(W * t, W * 0.91, peg, W * 0.07);
  }
  lineTo(c, W * 0.12, W * 0.045, W * 0.87, W * 0.045, 'rgba(220,210,180,0.55)', W * 0.012);
  lineTo(c, W * 0.12, W * 0.935, W * 0.87, W * 0.935, 'rgba(220,210,180,0.55)', W * 0.012);
  return cv;
}

// Леса: решётка стоек и настилов на всю высоту постройки. Выпекается ОДИН раз
// на связку (размер, высота, эпоха, вариант, detail) — именно это требование
// задания «леса — выпеченный спрайт по размеру постройки, а не сетка линий
// каждый кадр».
//
// Геометрия повторяет объём зданий из sprites.js: видна передняя грань и
// боковая справа, темнее и со сдвигом. Двух граней достаточно, чтобы леса
// читались как объём вокруг коробки, а не как забор перед ней.
export function bakeScaffold(sizeTiles, hFact, era, variant, detail) {
  // Ширина берётся с запасом 14 %: леса стоят ВОКРУГ здания, а не в его
  // габарите. Тот же запас потом используется при блите (см. site()).
  const W = Math.round(SCAF_BASE[detail] * sizeTiles * 1.14);
  const H = Math.round(W * (hFact * 1.06) / 1.14);
  const cv = mkCanvas(W, H);
  const c = cv.getContext('2d');
  const rnd = rngFrom(variant * 104729 + era * 313 + Math.round(hFact * 100) * 7 + sizeTiles);
  const M = era >= METAL_ERA ? TUBE : WOOD;

  const posts = postsFor(sizeTiles);
  const levels = levelsFor(hFact);
  const pw = Math.max(1, W * 0.022);           // толщина стойки
  const dh = H / levels;                        // высота яруса в пикселях
  const side = W * 0.055;                       // вылет боковой грани вправо

  // Боковая грань — первой и темнее: она уходит за передний план.
  const dark = shade(M.pole, -0.34);
  for (let i = 0; i < posts; i++) {
    const x = W * 0.04 + (W * 0.92) * (i / (posts - 1));
    lineTo(c, x + side, -side * 0.5, x + side, H - side * 0.5, dark, pw);
  }
  for (let l = 0; l <= levels; l++) {
    const y = H - l * dh;
    lineTo(c, W * 0.04 + side, y - side * 0.5, W * 0.96 + side, y - side * 0.5, shade(M.plank, -0.34), pw * 1.1);
  }

  // Передняя грань.
  for (let i = 0; i < posts; i++) {
    const x = W * 0.04 + (W * 0.92) * (i / (posts - 1));
    // Стойки чуть разной длины сверху: ровно подрезанные концы выглядят
    // напечатанными, у настоящих лесов верх торчит вразнобой.
    const over = dh * (0.10 + rnd() * 0.22);
    lineTo(c, x, -over, x, H, M.pole, pw);
    lineTo(c, x - pw * 0.4, -over, x - pw * 0.4, H, shade(M.pole, 0.18), pw * 0.4);
  }
  // Настилы: доска плюс тень под ней. Тень обязательна — без неё ярусы
  // сливаются со стойками в однотонную сетку.
  for (let l = 0; l <= levels; l++) {
    const y = H - l * dh;
    c.fillStyle = M.plank;
    c.fillRect(W * 0.02, y - pw * 1.2, W * 0.96, pw * 1.9);
    c.fillStyle = 'rgba(0,0,0,0.30)';
    c.fillRect(W * 0.02, y + pw * 0.7, W * 0.96, pw * 0.8);
  }
  // Раскосы через ярус: они дают решётке жёсткость на вид. Через ярус, а не на
  // каждом, — иначе на высотке получается сплошная штриховка.
  for (let l = 0; l < levels; l += 2) {
    const y0 = H - l * dh, y1 = H - (l + 1) * dh;
    const x0 = W * 0.06, x1 = W * 0.94;
    lineTo(c, (l % 4) ? x0 : x1, y0, (l % 4) ? x1 : x0, y1, shade(M.pole, -0.12), pw * 0.7);
  }
  // Верёвка с ведром на верхнем ярусе — подъём материала. Одна деталь, которая
  // объясняет, чем заняты фигурки наверху.
  const rx = W * (0.18 + rnd() * 0.62);
  lineTo(c, rx, H - levels * dh, rx, H - (levels - 1.35) * dh, M.rope, pw * 0.55);
  c.fillStyle = shade(M.plank, -0.30);
  c.fillRect(rx - W * 0.035, H - (levels - 1.35) * dh, W * 0.07, W * 0.055);

  // Защитная сетка появляется только у металлических лесов: до Современности
  // её просто не существовало, и повесить её на бронзовый век — анахронизм,
  // который заметят.
  if (M.net) {
    c.fillStyle = M.net;
    c.fillRect(W * 0.04, 0, W * 0.92, H);
  }
  return cv;
}

// Верхний настил — отдельным спрайтом. Он нужен потому, что видимая часть
// лесов обрезается по высоте прямоугольником источника: срез приходится
// посреди яруса и выглядит отпиленным. Настил, положенный ровно на линию
// среза, превращает «отпилено» в «здесь заканчивается смонтированный ярус».
export function bakeDeck(sizeTiles, era, detail) {
  const W = Math.round(SCAF_BASE[detail] * sizeTiles * 1.14);
  const H = Math.max(4, Math.round(W * 0.13));
  const cv = mkCanvas(W, H);
  const c = cv.getContext('2d');
  const M = era >= METAL_ERA ? TUBE : WOOD;
  const t = Math.max(1, H * 0.20);

  c.fillStyle = M.plank;                       // сам настил
  c.fillRect(0, H - t * 1.6, W, t * 1.6);
  c.fillStyle = 'rgba(0,0,0,0.32)';            // тень под ним
  c.fillRect(0, H - t * 0.35, W, t * 0.5);
  lineTo(c, 0, H - t * 3.4, W, H - t * 3.4, M.pole, t * 0.8);   // поручень
  for (let i = 0; i <= 6; i++) {                                 // стойки поручня
    const x = W * (0.03 + 0.94 * i / 6);
    lineTo(c, x, H - t * 3.4, x, H - t * 1.4, M.pole, t * 0.6);
  }
  return cv;
}

// Фигурка строителя: лист из двух кадров — молоток поднят и опущен. Двух
// хватает: на такой высоте важен не сустав, а сам факт движения.
export function bakeBuilder(era, detail) {
  const fh = BUILDER_BASE[detail];
  const fw = Math.round(fh * 0.62);
  const cv = mkCanvas(fw * 2, fh);
  const c = cv.getContext('2d');
  const body = mkCanvas(fw * 2, fh);
  const bc = body.getContext('2d');
  // Цвета не из ERA_PALETTE: там палитра ЗДАНИЯ, и строитель в цвет стены
  // сливается с ней. Нужен контраст — рабочая роба тёплая, каска яркая.
  const cloth = era >= METAL_ERA ? '#e8a33c' : '#a8763f';
  const skin = era >= METAL_ERA ? '#d9a97e' : '#c99a72';
  const helm = era >= METAL_ERA ? '#ffd24a' : '#7a5a34';

  for (let f = 0; f < 2; f++) {
    const ox = f * fw;
    bc.fillStyle = '#4a3a2c';                                  // ноги
    bc.fillRect(ox + fw * 0.30, fh * 0.58, fw * 0.16, fh * 0.40);
    bc.fillRect(ox + fw * 0.54, fh * 0.58, fw * 0.16, fh * 0.40);
    bc.fillStyle = cloth;                                      // корпус
    bc.fillRect(ox + fw * 0.26, fh * 0.30, fw * 0.48, fh * 0.32);
    bc.fillStyle = skin;                                       // голова
    bc.fillRect(ox + fw * 0.34, fh * 0.12, fw * 0.32, fh * 0.20);
    bc.fillStyle = helm;                                       // каска
    bc.fillRect(ox + fw * 0.28, fh * 0.06, fw * 0.44, fh * 0.10);
    // Рука с молотком: в кадре 0 занесена над головой, в кадре 1 опущена к
    // работе. Именно смена высоты руки, а не поза целиком, читается на
    // десяти пикселях.
    const ay = f === 0 ? fh * 0.02 : fh * 0.40;
    bc.fillStyle = skin;
    bc.fillRect(ox + fw * 0.70, ay + fh * 0.06, fw * 0.13, fh * 0.26);
    bc.fillStyle = '#59504a';
    bc.fillRect(ox + fw * 0.64, ay, fw * 0.30, fh * 0.09);
  }
  outline(c, body, Math.max(1, Math.round(fh / 16)));
  c.drawImage(body, 0, 0);
  return { cv, fw, fh };
}

// Мягкий клуб пыли. Радиальный градиент печётся один раз: ctx.filter='blur()'
// или градиент в кадре на каждую частицу — это то, что в этом проекте уже
// роняло 60 FPS до девяти (см. renderer.glowSprite).
export function bakePuff(warm) {
  const S = 40;
  const cv = mkCanvas(S, S);
  const c = cv.getContext('2d');
  const col = warm ? '196,172,128' : '188,190,192';
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, `rgba(${col},0.50)`);
  g.addColorStop(0.45, `rgba(${col},0.22)`);
  g.addColorStop(1, `rgba(${col},0)`);
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  return cv;
}

// Стружка/щепка: один светлый скол с тёмной кромкой. 10 px хватает — в кадре
// она рисуется размером в 2–4 пикселя.
export function bakeChip(era) {
  const S = 10;
  const cv = mkCanvas(S, S);
  const c = cv.getContext('2d');
  c.fillStyle = era >= METAL_ERA ? '#c8ccd0' : '#d8b877';
  c.beginPath();
  c.moveTo(S * 0.1, S * 0.5); c.lineTo(S * 0.9, S * 0.25);
  c.lineTo(S * 0.85, S * 0.7); c.lineTo(S * 0.15, S * 0.8);
  c.closePath(); c.fill();
  c.fillStyle = 'rgba(60,44,26,0.55)';
  c.fillRect(0, S * 0.72, S, S * 0.14);
  return cv;
}

// Вспышка сдачи. Аддитивный блит — поэтому центр белый: в режиме 'lighter'
// цвет складывается с тем, что под ним, и тёплый центр на закатной земле
// уходит в грязно-оранжевый.
export function bakeFlash() {
  const S = 96;
  const cv = mkCanvas(S, S);
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,240,0.95)');
  g.addColorStop(0.28, 'rgba(255,214,140,0.55)');
  g.addColorStop(0.62, 'rgba(255,180,90,0.18)');
  g.addColorStop(1, 'rgba(255,170,80,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  return cv;
}

// ---------------------------------------------------------------------------

export class ConstructionLayer {
  constructor(quality) {
    this.enabled = true;
    // Кэши: Map, потому что prune() из quality.js вытесняет по LRU именно
    // порядок вставки Map.
    this.scaf = new Map();     // `${size}|${h10}|${eraCls}|${variant}|${detail}` -> canvas
    this.plates = new Map();   // `${size}|${eraCls}|${variant}|${detail}` -> canvas
    this.decks = new Map();    // `${size}|${eraCls}|${detail}` -> canvas
    this.builders = new Map(); // `${eraCls}|${detail}` -> { cv, fw, fh }
    this.puff = null; this._puffCold = null; this.chip = null; this.chipHi = null; this.flash = null;
    // Кто на наших глазах был площадкой. WeakSet, а не Set: постройки из
    // выброшенного сейва обязаны уходить в мусор вместе с симуляцией, иначе
    // слой держит их вечно.
    this._seen = new WeakSet();
    this._events = [];         // живые вспышки сдачи
    this._bars = [];           // полоски прогресса, собранные за кадр
    // Кому уже заказывали спрайт здания. Нужно, чтобы уложиться в бюджет
    // выпечки: первый заказ на конкретную площадку почти наверняка вызовет
    // bake() в SpriteCache (1,5–3 мс), повторные — гарантированный промах мимо
    // печки. Своего счётчика у SpriteCache нет, спросить «есть ли в кэше»
    // нечем — считаем сами.
    this._sprAsked = new WeakSet();
    this.time = 0;
    this._stats = { sites: 0, builders: 0, particles: 0, flashes: 0, bakes: 0 };
    this.setQuality(quality);
  }

  setQuality(q) {
    this.q = q;
    // Площадок в кадре: их не может быть больше, чем зданий вообще, но и
    // двенадцати хватает с запасом — на объекте максимум 3 жителя.
    this.capSites = Math.min(CONSTRUCTION_LIMITS.sitesFrame, q.caps.buildings);
    // Частицы масштабируются q.particles ровно как в weather.js, fx.js и
    // damage.js: eco 0.2, medium 0.5, high 0.8, ultra 1.0.
    this.capDust = Math.max(0, Math.round(CONSTRUCTION_LIMITS.dustPerSite * q.particles));
    this.capChips = Math.max(0, Math.round(CONSTRUCTION_LIMITS.chipsPerSite * q.particles));
    this.capFlashChips = Math.max(4, Math.round(CONSTRUCTION_LIMITS.flashChips * q.particles));
    // Фигурок на настиле: на eco одна, на ultra все три. Больше трёх ядро всё
    // равно не даст (BUILDERS_PER_SITE = 3 в simulation.js).
    this.capBuilders = Math.max(1, Math.min(CONSTRUCTION_LIMITS.buildersPerSite,
      Math.round(CONSTRUCTION_LIMITS.buildersPerSite * q.particles + 0.4)));
    // Память под леса: доля бюджета спрайтов. Леса того же размера, что
    // здание, поэтому больше четверти отдавать нельзя — вытеснит сами дома.
    this.scafMB = Math.min(CONSTRUCTION_LIMITS.scafMB, q.caps.spriteMB * 0.25);
    // Порог мелких деталей — ровно q.lod.propsMinZoom, как требует задание:
    // фигурки, пыль, стружка и полоска прогресса живут по одному правилу с
    // остальным реквизитом сцены. Следствие, о котором надо знать: на eco
    // propsMinZoom = 99, то есть «никогда», и там площадка показывает прогресс
    // только высотой силуэта и лесов. Это не потеря информации — высота и есть
    // прогресс, — а осознанный отказ от 12 блитов на площадку на пресете,
    // который целится в 60 FPS на слабом телефоне.
    this.detailMinZoom = q.lod.propsMinZoom;
    // Смена пресета меняет разрешение выпечки — всё старое невалидно.
    this.clear();
  }

  clear() {
    this.scaf.clear(); this.plates.clear(); this.decks.clear(); this.builders.clear();
    this.puff = null; this._puffCold = null; this.chip = null; this.chipHi = null; this.flash = null;
    this._events.length = 0;
    this._bars.length = 0;
  }

  stats() {
    return { ...this._stats, scafCache: this.scaf.size, plateCache: this.plates.size };
  }

  // ------------------------------------------------------------------ кадр

  // Один вызов на кадр, до общего Y-прохода. Считает то, что не должно
  // считаться по 200 раз: зум, гейты, бюджет выпечки, — и ловит переход
  // «площадка → готовое здание», по которому зажигается вспышка.
  begin(sim, dtReal, ox, oy, z, cw, ch) {
    this.time += dtReal || 0;
    this.ox = ox; this.oy = oy; this.z = z; this.cw = cw; this.ch = ch;
    const zoom = z / TILE_PX;
    this.zoom = zoom;
    // Нижняя граница по пикселям, а не по зуму: при тайле мельче 6 px леса —
    // это полтора пикселя решётки, платить за них выпечкой незачем. Сама
    // площадка при этом остаётся видимой (см. site()), просто одним пятном.
    this.onSite = this.enabled && z >= 6;
    this.onDetail = this.enabled && zoom >= this.detailMinZoom;
    // Вспышка сдачи — не украшение, а сообщение «объект готов», её задача
    // работать без журнала. Поэтому свой порог, а не propsMinZoom: гасим
    // только там, где здание и так неразличимо.
    this.onFlash = this.enabled && z >= 6;
    this.bakeLeft = this.q.caps.bakesPerFrame;
    this.seed = ((sim && sim.world && sim.world.seed) | 0) & 0xffff;
    this._bars.length = 0;
    this._stats.sites = 0; this._stats.builders = 0;
    this._stats.particles = 0; this._stats.flashes = 0; this._stats.bakes = 0;
    this._scanFinished(sim);
    this._ageEvents(dtReal || 0);
  }

  // Переход «была площадкой → стала готовой». Ловится сравнением с прошлым
  // кадром, потому что ядро о рендере не знает и события не шлёт.
  // Важное следствие правильной реализации: здание, ПРИШЕДШЕЕ готовым из сейва
  // или поставленное placeFree() (стартовое кострище, награды), вспышку не
  // получает — мы никогда не видели его площадкой. Наивная проверка «done и
  // раньше не видели» зажигала бы фейерверк над всем городом при каждой
  // загрузке.
  _scanFinished(sim) {
    if (!sim || !sim.buildings) return;
    for (const b of sim.buildings) {
      if (b.destroyed) { this._seen.delete(b); continue; }
      if (!b.done) { this._seen.add(b); continue; }
      if (this._seen.has(b)) {
        this._seen.delete(b);
        if (this._events.length >= CONSTRUCTION_LIMITS.flashes) this._events.shift();
        const def = BUILDINGS[b.id];
        this._events.push({
          x: b.x, y: b.y, size: (b.size || 1),
          era: eraOf(b, sim), t: 0,
          seed: (b.x * 73 + b.y * 151 + this.seed) | 0,
          h: heightFactor(b.id) * (def && def.size ? def.size : 1),
        });
      }
    }
  }

  _ageEvents(dt) {
    if (!this._events.length) return;
    for (const e of this._events) e.t += dt;
    while (this._events.length && this._events[0].t > FLASH_LIFE) this._events.shift();
  }

  // ------------------------------------------------------------- площадка

  // Рисует ОДНУ строящуюся постройку. Вызывается из renderer.drawBuilding
  // вместо прежней ветки `if (!b.done)`, то есть внутри общего Y-прохода: это
  // важно, потому что житель, идущий перед стройкой, обязан быть впереди лесов,
  // а идущий за ней — позади.
  //
  // sprOf — не спрайт, а функция, которая его достанет. Так сделано, чтобы
  // решение «печь ли спрайт здания» осталось здесь: на дальнем зуме и при
  // исчерпанном бюджете выпечки мы его просто не спрашиваем, и SpriteCache не
  // тратит 2 мс на дом, которого ещё нет.
  site(sim, ctx, b, sx, sy, size, sprOf) {
    const p = progressOf(b);
    if (!this.onSite) {
      // Дальний план: одно пятно вместо площадки. Не «ничего» — игрок должен
      // видеть, что клетка занята стройкой, даже когда смотрит на весь материк.
      ctx.fillStyle = 'rgba(109,86,55,0.75)';
      ctx.fillRect(sx + 1, sy + 1, size - 2, size - 2);
      return;
    }
    if (this._stats.sites >= this.capSites) return;
    this._stats.sites++;

    const era = eraOf(b, sim);
    const eraCls = era >= METAL_ERA ? 1 : 0;
    const sizeTiles = b.size || 1;
    const variant = siteVariant(b, this.seed);
    const detail = this.q.detail;
    const hFact = heightFactor(b.id);

    // Геометрия ровно та же, что у готового здания в renderer.drawBuilding
    // (dw = size*1.16, dy = sy + size - dh). Совпадение обязательно: иначе в
    // момент сдачи здание дёрнется на несколько пикселей, и глаз это поймает
    // даже там, где не заметит самой вспышки.
    const dw = size * 1.16, dh = dw * hFact;
    const dx = sx - size * 0.08, dy = sy + size - dh;

    // --- 1. плита площадки ---
    const plate = this._plate(sizeTiles, eraCls, variant, detail);
    if (plate) ctx.drawImage(plate, sx - size * 0.06, sy - size * 0.06, size * 1.12, size * 1.12);
    else { ctx.fillStyle = 'rgba(109,86,55,0.85)'; ctx.fillRect(sx, sy, size, size); }

    // --- 2. силуэт, открытый снизу ---
    // Ключевой приём файла: НЕ clip. Прямоугольник источника drawImage режет
    // спрайт ровно так же, как обрезал бы клип, но без save/beginPath/clip/
    // restore на каждую площадку. Берём нижние r% пикселей спрайта и кладём в
    // нижние r% его экранного прямоугольника — верх остаётся не нарисован,
    // и это и есть «здание выросло до половины».
    const r = revealFrac(p);
    let spr = null;
    if (r > 0.02 && sprOf) {
      const fresh = !this._sprAsked.has(b);
      if (!fresh || this.bakeLeft > 0) {
        if (fresh) { this._sprAsked.add(b); this.bakeLeft--; this._stats.bakes++; }
        spr = sprOf();
      }
    }
    if (spr && spr.cv && spr.cv.height > 0) {
      const sh = spr.cv.height, sw = spr.cv.width;
      const cut = Math.max(1, Math.round(sh * r));
      ctx.drawImage(spr.cv, 0, sh - cut, sw, cut, dx, dy + dh - dh * r, dw, dh * r);
      // Светлая полоса ровно по линии кладки: свежий раствор, ряд, который
      // кладут прямо сейчас. Без неё срез спрайта выглядит обрывом картинки,
      // а не рабочим уровнем. Один fillRect — дешевле любой альтернативы.
      const cy = dy + dh - dh * r;
      ctx.fillStyle = eraCls ? 'rgba(200,214,226,0.55)' : 'rgba(226,208,168,0.55)';
      ctx.fillRect(dx + dw * 0.04, cy - Math.max(1, size * 0.02), dw * 0.92, Math.max(1, size * 0.035));
    }

    // --- 3. леса ---
    const f = scaffoldFrac(p);
    const scafW = dw * 1.14, scafH = dh * 1.06;
    const scafX = dx - dw * 0.07, scafBot = dy + dh;
    const scafTopY = scafBot - scafH * f;
    const sc = this._scaffold(sizeTiles, hFact, eraCls, variant, detail);
    if (sc && f > 0.01) {
      const cut = Math.max(1, Math.round(sc.height * f));
      ctx.drawImage(sc, 0, sc.height - cut, sc.width, cut, scafX, scafTopY, scafW, scafH * f);
      // Верхний настил на линии среза. Он же — пол под фигурками.
      const deck = this._deck(sizeTiles, eraCls, detail);
      if (deck) {
        const dhh = scafW * (deck.height / deck.width);
        ctx.drawImage(deck, scafX, scafTopY - dhh * 0.55, scafW, dhh);
      }
    }

    if (!this.onDetail) return;

    // --- 4. строители на верхнем настиле ---
    const crew = Math.min(this.capBuilders, (b.workers && b.workers.length) || 0);
    if (crew > 0) {
      const bs = this._builder(eraCls, detail);
      if (bs) {
        const bh = size * BUILDER_H, bw = bh * (bs.fw / bs.fh);
        for (let i = 0; i < crew; i++) {
          // Место фигурки — не «по формуле i/crew»: тогда при уходе одного
          // рабочего оставшиеся прыгают по настилу. Позиция закреплена за
          // ИНДЕКСОМ, а не за долей, и жёстко привязана к координатам площадки.
          const t = 0.18 + 0.32 * i + chash(b.x, b.y, i + 5) * 0.14;
          const ph = chash(b.x + 3, b.y + 7, i) * 6.28;
          // Фаза удара своя у каждого: синхронный стук трёх молотков читается
          // как ошибка анимации.
          const fr = ((this.time * 3.4 + ph) | 0) & 1;
          const bob = Math.sin(this.time * 3.4 + ph) * size * 0.012;
          ctx.drawImage(
            bs.cv, fr * bs.fw, 0, bs.fw, bs.fh,
            scafX + scafW * t - bw / 2, scafTopY - bh * 0.92 + bob, bw, bh,
          );
          this._stats.builders++;
        }
      }
    }

    // --- 5. пыль и стружка у основания ---
    this._groundFx(ctx, b, sx, sy, size, eraCls);

    // --- 6. полоска прогресса ---
    // Собирается в список и рисуется отдельным проходом в drawFx(): внутри
    // Y-прохода её перекрыл бы дом, стоящий южнее, — а это единственный
    // числовой индикатор стройки, и перекрывать его нельзя.
    // Полоска идёт за фронтом работ (по верху лесов), но не опускается внутрь
    // пятна застройки — у низких построек (поле, каменоломня, солнечная ферма)
    // верх лесов приходится ниже верха тайла.
    const barY = Math.min(scafTopY - size * 0.22, sy - size * 0.10);
    this._bars.push({ x: sx + size / 2, y: barY, w: size * 0.9, p });
  }

  // Пыль и стружка. Частицы БЕЗ состояния: фаза считается из времени и хеша,
  // поэтому массива живых частиц нет вовсе — ни выделений, ни сборки мусора,
  // ни рассинхрона при паузе. Цена одной частицы — ровно один drawImage.
  _groundFx(ctx, b, sx, sy, size, eraCls) {
    const base = sy + size * 0.94;
    for (let i = 0; i < this.capDust; i++) {
      const ph = chash(b.x, b.y, i + 11);
      // 0.55 жизни в секунду ≈ клуб раз в 1,8 с на частицу: при четырёх
      // частицах пыль поднимается примерно дважды в секунду. Быстрее читается
      // как дым от костра, медленнее — как застывшая картинка.
      const life = (this.time * 0.55 + ph) % 1;
      const rise = size * (0.10 + life * 0.55);
      const rad = size * (0.10 + life * 0.30);
      const a = (1 - life) * 0.55 * (0.5 + ph * 0.5);
      if (a < 0.02) continue;
      const px = sx + size * (0.18 + chash(b.x + 1, b.y + 2, i) * 0.64);
      const puff = this._puff(eraCls);
      if (!puff) break;
      ctx.globalAlpha = a;
      ctx.drawImage(puff, px - rad, base - rise - rad, rad * 2, rad * 2);
      ctx.globalAlpha = 1;
      this._stats.particles++;
    }
    for (let i = 0; i < this.capChips; i++) {
      const ph = chash(b.x + 5, b.y + 9, i + 3);
      // 0.9 жизни в секунду: стружка живёт около секунды — столько летит
      // отлетевшая от тесла щепка, дальше она лежит на земле и не видна.
      const life = (this.time * 0.9 + ph) % 1;
      const dir = ph < 0.5 ? -1 : 1;
      const dist = size * life * (0.22 + ph * 0.22);
      // Парабола: вверх и вниз за одну жизнь. 4*(t - t²) — нормированная
      // парабола с максимумом 1 в середине, самая дешёвая форма броска.
      const up = size * 0.30 * 4 * (life - life * life);
      const s = size * 0.09;
      const chip = this._chip(eraCls);
      if (!chip) break;
      ctx.globalAlpha = Math.min(1, (1 - life) * 2.2);
      ctx.drawImage(chip, sx + size * 0.5 + dir * dist - s / 2, base - up - s / 2, s, s);
      ctx.globalAlpha = 1;
      this._stats.particles++;
    }
  }

  // ------------------------------------------------- проход поверх зданий

  // Вспышки сдачи, разлёт щепок и полоски прогресса. Отдельным проходом ПОСЛЕ
  // общего Y-прохода: и вспышка, и полоска обязаны быть поверх всех крыш,
  // иначе сдача объекта в плотном квартале пройдёт за соседним домом.
  drawFx(ctx) {
    if (!this.enabled) return;
    const z = this.z, ox = this.ox, oy = this.oy;

    if (this.onFlash) {
      for (const e of this._events) {
        const k = e.t / FLASH_LIFE;                 // 0 → 1
        const sx = ox + e.x * z, sy = oy + e.y * z;
        const size = e.size * z;
        if (sx < -200 || sy < -300 || sx > this.cw + 200 || sy > this.ch + 200) continue;
        const fl = this._flash();
        if (!fl) break;
        // Вспышка: быстрый рост и быстрое затухание. Гаснет ВДВОЕ быстрее, чем
        // растёт ((1-k)² против k^0.55), — так работает всякий настоящий
        // хлопок, и так вспышка не мешает разглядеть готовое здание.
        const rad = size * (0.55 + 1.5 * Math.pow(k, 0.55));
        const a = (1 - k) * (1 - k) * 0.9;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = a;
        const cy = sy + size * 0.5 - size * e.h * 0.22;
        ctx.drawImage(fl, sx + size / 2 - rad, cy - rad, rad * 2, rad * 2);
        ctx.restore();

        // Щепки: разлёт по кругу с притяжением вниз. Углы и скорости от хеша
        // площадки — один и тот же дом всегда «взрывается» одинаково.
        const chip = this._chip(e.era >= METAL_ERA ? 1 : 0);
        if (chip) {
          const s = size * 0.11;
          ctx.globalAlpha = Math.min(1, (1 - k) * 1.8);
          for (let i = 0; i < this.capFlashChips; i++) {
            const ang = chash(e.seed, i, 1) * 6.28318;
            const spd = 0.5 + chash(e.seed, i, 2) * 0.9;
            const d = size * spd * k;
            // 1.6·k² — падение: к концу жизни щепка уходит вниз примерно на
            // полтора размера тайла, то есть ложится на землю у стены.
            const fall = size * 1.6 * k * k * spd * 0.6;
            ctx.drawImage(chip,
              sx + size / 2 + Math.cos(ang) * d - s / 2,
              cy + Math.sin(ang) * d * 0.6 + fall - s / 2, s, s);
          }
          ctx.globalAlpha = 1;
        }
        this._stats.flashes++;
      }
    }

    // Полоски прогресса. Три fillRect на штуку, и это НЕ повод их выпекать:
    // заполнение меняет ширину каждый кадр, то есть блит пришлось бы масштабировать
    // по X — на Canvas2D это дороже, чем залить сплошной прямоугольник в 4×80 px.
    for (const bar of this._bars) {
      const w = bar.w, h = Math.max(3, w * 0.075);
      const x = bar.x - w / 2, y = bar.y;
      ctx.fillStyle = 'rgba(20,16,12,0.62)';
      ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
      ctx.fillStyle = 'rgba(70,58,42,0.85)';
      ctx.fillRect(x, y, w, h);
      // Цвет заполнения тянется от рабочей охры к зелёному «почти готово»:
      // игрок видит стадию боковым зрением, не читая длину.
      ctx.fillStyle = bar.p > 0.75 ? '#8fd06a' : '#c9a227';
      ctx.fillRect(x, y, w * bar.p, h);
    }
    this._bars.length = 0;
  }

  // --------------------------------------------------------------- кэши

  // Все шесть геттеров устроены одинаково: попал в кэш — вернули и «тронули»
  // запись (LRU), промахнулся — печём, если бюджет выпечки на кадр не исчерпан,
  // иначе возвращаем null и элемент кадр не рисуется. Возврат null вместо
  // выпечки любой ценой — это и есть соблюдение бюджета: пропущенный кадр без
  // лесов незаметен, рывок на 3 мс заметен.
  _plate(sizeTiles, eraCls, variant, detail) {
    const key = `${sizeTiles}|${eraCls}|${variant}|${detail}`;
    const hit = this.plates.get(key);
    if (hit) { touch(this.plates, key); return hit; }
    if (this.bakeLeft <= 0) return null;
    this.bakeLeft--; this._stats.bakes++;
    const cv = bakePlate(sizeTiles, eraCls * METAL_ERA, variant, detail);
    this.plates.set(key, cv);
    prune(this.plates, { maxEntries: CONSTRUCTION_LIMITS.plateEntries });
    return cv;
  }

  _scaffold(sizeTiles, hFact, eraCls, variant, detail) {
    // Высота округляется до десятых: у 55 построек всего десяток разных
    // ARCH_H, но округление страхует от того, что кто-то заведёт 1.153 и
    // получит отдельную запись кэша на каждое здание.
    const h10 = Math.round(hFact * 10);
    const key = `${sizeTiles}|${h10}|${eraCls}|${variant}|${detail}`;
    const hit = this.scaf.get(key);
    if (hit) { touch(this.scaf, key); return hit; }
    if (this.bakeLeft <= 0) return null;
    this.bakeLeft--; this._stats.bakes++;
    const cv = bakeScaffold(sizeTiles, h10 / 10, eraCls * METAL_ERA, variant, detail);
    this.scaf.set(key, cv);
    prune(this.scaf, {
      maxEntries: CONSTRUCTION_LIMITS.scafEntries,
      maxBytes: this.scafMB * 1024 * 1024,
      bytesOf: canvasBytes,
    });
    return cv;
  }

  _deck(sizeTiles, eraCls, detail) {
    const key = `${sizeTiles}|${eraCls}|${detail}`;
    const hit = this.decks.get(key);
    if (hit) { touch(this.decks, key); return hit; }
    if (this.bakeLeft <= 0) return null;
    this.bakeLeft--; this._stats.bakes++;
    const cv = bakeDeck(sizeTiles, eraCls * METAL_ERA, detail);
    this.decks.set(key, cv);
    prune(this.decks, { maxEntries: 12 });
    return cv;
  }

  _builder(eraCls, detail) {
    const key = `${eraCls}|${detail}`;
    const hit = this.builders.get(key);
    if (hit) return hit;
    if (this.bakeLeft <= 0) return null;
    this.bakeLeft--; this._stats.bakes++;
    const s = bakeBuilder(eraCls * METAL_ERA, detail);
    this.builders.set(key, s);
    return s;
  }

  // Пыль, щепка и вспышка — по одному спрайту на всю игру, кэшировать по ключу
  // нечего. Печём лениво: у игрока, который ещё ничего не строил, этих трёх
  // канвасов в памяти нет.
  _puff(eraCls) {
    if (eraCls) { if (!this._puffCold) { if (this.bakeLeft <= 0) return null; this.bakeLeft--; this._stats.bakes++; this._puffCold = bakePuff(false); } return this._puffCold; }
    if (!this.puff) { if (this.bakeLeft <= 0) return null; this.bakeLeft--; this._stats.bakes++; this.puff = bakePuff(true); }
    return this.puff;
  }

  _chip(eraCls) {
    const f = eraCls ? 'chipHi' : 'chip';
    if (!this[f]) { if (this.bakeLeft <= 0) return null; this.bakeLeft--; this._stats.bakes++; this[f] = bakeChip(eraCls * METAL_ERA); }
    return this[f];
  }

  _flash() {
    if (!this.flash) { if (this.bakeLeft <= 0) return null; this.bakeLeft--; this._stats.bakes++; this.flash = bakeFlash(); }
    return this.flash;
  }
}

// ---------------------------------------------------------------------------
// ПОДКЛЮЧЕНИЕ
//
// Все правки — в app/src/render/renderer.js. Число совпадений каждого якоря
// проверено grep -F -c по файлу и указано рядом.
//
// 1) ИМПОРТ. Якорь (1 совпадение):
//
//      import { CityLights } from './city_lights.js';
//
//    ПОСЛЕ него добавить:
//
//      import { ConstructionLayer } from './construction.js';
//
// 2) СОЗДАНИЕ СЛОЯ. Якорь (1 совпадение), последняя строка конструктора
//    Renderer:
//
//      this.cityLights = new CityLights(this.quality);    // окна и фонари ночью
//
//    ПОСЛЕ него добавить (отступ 4 пробела):
//
//      this.construction = new ConstructionLayer(this.quality); // леса и рост стройки
//
// 3) СМЕНА ПРЕСЕТА. Якорь:
//
//      this.cityLights.setQuality(this.quality);
//
//    встречается ДВАЖДЫ — в setQuality(id) и в tuneAuto(dtReal), и это
//    последняя строка блока переключения в обоих местах. ПОСЛЕ КАЖДОЙ из двух
//    добавить (отступ там 4 пробела в обоих случаях):
//
//      this.construction.setQuality(this.quality);
//
//    Пропустить вторую — значит после срабатывания авто-тюнера получить леса,
//    испечённые под старое разрешение, и потолки частиц от прежнего пресета.
//
// 4) НАЧАЛО КАДРА. Якорь (1 совпадение):
//
//      this.shadows.begin(sim, dtReal, z, { fog: this.atmo.fogK });
//
//    ПОСЛЕ него добавить:
//
//      this.construction.begin(sim, dtReal, ox, oy, z, cw, ch);
//
//    Именно здесь: ox/oy/z/cw/ch уже посчитаны выше по кадру, а сам begin()
//    обязан отработать ДО общего Y-прохода — иначе площадка нарисуется по
//    гейтам прошлого кадра, а вспышка сдачи опоздает на кадр.
//
// 5) САМА ПЛОЩАДКА. Якорь (1 совпадение) — начало ветки в drawBuilding:
//
//      if (!b.done) {
//
//    Заменить ЦЕЛИКОМ весь блок этой ветки, то есть эти двенадцать строк
//    (приведены дословно, с отступами; каждая строка блока в файле встречается
//    по 1 разу, кроме `      return;` — 3 совпадения, поэтому блок и заменяется
//    целиком, а не построчно):
//
//      if (!b.done) {
//        ctx.fillStyle = 'rgba(139,109,66,0.5)';
//        ctx.fillRect(sx + 2, sy + 2, size - 4, size - 4);
//        ctx.strokeStyle = '#8b6d42';
//        ctx.setLineDash([4, 3]);
//        ctx.strokeRect(sx + 2, sy + 2, size - 4, size - 4);
//        ctx.setLineDash([]);
//        const p = b.progress / b.buildDays;
//        ctx.fillStyle = '#c9a227';
//        ctx.fillRect(sx + 2, sy + size - 6, (size - 4) * Math.min(1, p), 4);
//        return;
//      }
//
//    на такие три:
//
//      if (!b.done) {
//        this.construction.site(sim, ctx, b, sx, sy, size, () => this.sprites.building(b.id, def, e, b.size || 1));
//        return;
//      }
//
//    Если заменять блок целиком боязно — достаточно вставить вызов
//    this.construction.site(...) и return ПЕРВЫМИ строками внутри `if (!b.done) {`:
//    остальные девять строк станут недостижимы. Но лучше удалить: они рисуют
//    ровно то, что этот слой заменяет.
//
//    Про `def` и `e`: обе переменные объявлены ВЫШЕ по drawBuilding
//    (`const def = BUILDINGS[b.id];` и `const e = Math.max(own, ...)`), то есть
//    в этой точке уже в области видимости — ничего добавлять не нужно.
//
//    Про стрелку `() => ...`: спрайт передаётся функцией, а не значением,
//    намеренно. Слой сам решает, нужен ли ему спрайт здания в этом кадре, и на
//    дальнем зуме или при исчерпанном бюджете выпечки просто не зовёт её —
//    SpriteCache не печёт дом, которого ещё нет. Одна стрелка на площадку в
//    кадр (их единицы) стоит ноль.
//
// 6) ВСПЫШКА СДАЧИ И ПОЛОСКИ. Якорь (1 совпадение):
//
//      this.drawSortedEntities(sim, ctx, ox, oy, z, cw, ch, L);
//
//    СРАЗУ ПОСЛЕ этой строки добавить:
//
//      this.construction.drawFx(ctx);
//
//    После, а не до: вспышка и полоска прогресса обязаны лечь поверх крыш.
//    Нарисованные до общего прохода, они прятались бы за домом, стоящим южнее.
//
//    ВНИМАНИЕ главному разработчику: на этот же якорь просится вставка из
//    damage.js (`this.damage.drawSmoke(ctx);`). Конфликта нет — порядок этих
//    двух строк между собой безразличен, дым и вспышка не пересекаются.
//
// 7) НЕОБЯЗАТЕЛЬНО. Новая игра / загрузка сейва (main.js, hud.js — чужая зона):
//
//      renderer.construction.clear();
//
//    Не обязательно: список площадок нигде не хранится, «виденные» стройки
//    лежат в WeakSet и умирают вместе с симуляцией, кэши вытесняются по LRU.
//    Вызов имеет смысл только чтобы гарантированно погасить вспышки, если сейв
//    загружен ровно в момент сдачи объекта.
//
// ---------------------------------------------------------------------------
// ЧТО ПОЛУЧАЕТСЯ
//
//   • площадка перестала быть жёлтым квадратом: перекопанная земля, штабель
//     материала, разметочные колышки с верёвкой;
//   • силуэт растёт снизу вверх — и это НАСТОЯЩИЙ спрайт этого здания в его
//     эпохе, в том же экранном прямоугольнике, что и готовое: в момент сдачи
//     картинка не подменяется, она достраивается;
//   • по линии кладки идёт светлая полоса свежего раствора — видно, где
//     работают прямо сейчас;
//   • вокруг стоят леса ростом на полтора яруса выше кладки: деревянные до
//     Современности, трубчатые с сеткой после;
//   • на верхнем настиле стучат молотками фигурки из b.workers — сколько
//     жителей ядро прислало на объект, столько и видно (максимум три);
//   • у основания вьётся пыль и отлетает стружка;
//   • в последней четверти прогресса леса разбирают сверху — к сдаче остаётся
//     нижний ярус;
//   • сдача отмечается вспышкой на 0,9 с и разлётом щепок — заметно без журнала;
//   • над стройкой висит полоска прогресса, желтеет до 75 % и зеленеет после.
//
// ПРЕСЕТЫ
//
//   eco    — плита, силуэт и леса (разрешение выпечки 40/44 px на тайл);
//            фигурок, пыли, стружки и полоски НЕТ: q.lod.propsMinZoom = 99.
//            Прогресс читается высотой силуэта — он и есть прогресс.
//            Вспышка сдачи остаётся: это сообщение игроку, а не украшение.
//   medium — детали с зума 1.0: 1 фигурка, 2 пыли, 2 стружки, 7 щепок.
//   high   — детали с 0.8: 2 фигурки, 3 пыли, 2 стружки, 11 щепок.
//   ultra  — детали с 0.6: 3 фигурки, 4 пыли, 3 стружки, 14 щепок.
//   Ниже 6 px на тайл площадка сжимается в одно земляное пятно.
//
// ЧЕГО СЛОЙ НЕ ДЕЛАЕТ (осознанно)
//
//   • Шпиль. У него в sprites.js пустой рисовальщик (спрайт нулевой), поэтому
//     недостроенный Шпиль показывает плиту и леса, но не силуэт. Его анимация
//     по стадиям живёт в renderer.drawSpire и включается после b.done.
//   • Нарисованный арт (ArtPack). Растёт всегда процедурный спрайт, а по сдаче
//     здание сменяется на картинку из арт-пака, если она есть. Резать
//     произвольный PNG по высоте можно, но у него другая пропорция и другая
//     точка опоры — стройка «дёргалась» бы в момент сдачи.
//   • Тени от лесов. ShadowLayer печёт тень по силуэту спрайта, а у лесов
//     силуэт меняется каждый кадр вместе с высотой — это отдельная выпечка на
//     кадр, чего бюджет не выдержит.
//
// РУЧКИ СНАРУЖИ
//
//   renderer.construction.enabled = false;   // выключить слой целиком
//   renderer.construction.stats()            // { sites, builders, particles, flashes, bakes, ... }
