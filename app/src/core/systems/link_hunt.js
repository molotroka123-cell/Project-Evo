// core/systems/link_hunt.js — СВЯЗЬ: охота ↔ стада ↔ еда ↔ люди.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. Сейчас охота — это кнопка «взять мяса»: 28 зверей на всю
// партию, каждый бродит сам по себе, житель подходит и снимает с него ровно
// a.food, где бы это ни случилось. Место не значит ничего, число охотников не
// значит ничего, зверь на удар не отвечает, а когда последнего добьют — игрок
// узнает об этом по пустому складу и уже ничего не поправит.
//
// Здесь охота становится ХОЗЯЙСТВОМ: у дичи есть место, поголовье и терпение,
// а у жадности — цена, о которой сказано заранее.
//
// ЧТО ИМЕННО СВЯЗАНО (в обе стороны):
//   стадо + артель охотников  ──▶ облава: мяса за ходку кратно больше, чем с одиночки
//   поголовье рядом со стоянкой ──▶ выработка hunter_lodge (место постройки наконец значит)
//   выбито больше, чем родится ──▶ пугливость ──▶ стада откочёвывают ──▶ добыча падает
//   провал охоты у поселения, живущего охотой ──▶ сигнал лестнице голода (link_survival)
//   ОБРАТНО: скотоводство + пастбище рядом ──▶ стадо можно ПРИРУЧИТЬ: постоянный корм
//   ОБРАТНО: перестали бить ──▶ пугливость тает ──▶ стада возвращаются
//   ОБРАТНО: вид выбит подчистую ──▶ шрам в летописи (link_memory)
//
// ═══ ЧТО МЫ ЧИТАЕМ ИЗ herds.js (модель стад пишет другой агент) ═══
//
// Связь читает состояние ПО ФОРМЕ и понимает обе раскладки полей — ту, что
// сложилась в herds.js, и ту, о которой договаривались изначально. Ни одно поле
// не обязательно: чего нет, то заменяется разумной оценкой.
//
//   sim.herds = {
//     herds:  [ herd, ... ],        // (или list, или просто массив)
//     gone:   { kind: day },        // виды, выбитые НАВСЕГДА (herds.js их считает сам)
//   }
//   herd = {
//     id:            number|string, // устойчивый между сейвами
//     kind|species:  'deer' | 'mammoth' | 'boar' | 'aurochs',
//     n|head:        number,        // поголовье (у herds.js дробное — приплод по долям)
//     cx,cy | x,y:   number,        // центр участка обитания
//     fear:          0..1,          // пугливость: 0 спокойно, 1 сторонится людей
//     r:             number,        // радиус участка; нет — берём из таблицы вида
//     tame:          boolean,       // необязательное: herds.js прирученное стадо
//                                   // из списка УБИРАЕТ, поэтому скот считается
//                                   // по своему счётчику (см. withStock ниже)
//   }
//
// ЧТО ДЕЛАЕТ herds.js САМ, А МЫ НЕ ПОВТОРЯЕМ: приплод, ёмкость участка, порог
// живучести, кочёвку по своему участку и объявление вымершего вида (state.gone).
// Мы читаем его gone и о тех же видах молчим — иначе игрок получил бы две
// записи об одной беде, ровно как когда-то с мором в летописи.
//
// ПОЧЕМУ ЗДЕСЬ НЕТ `import * as HERDS from './herds.js'`. Модель стад пишется
// параллельно с этой связью, и статический импорт файла, которого в дереве
// может не оказаться, роняет не эту связь, а ВЕСЬ integrate.js вместе с
// партией: ES-модули разрешаются до первой строки кода. Поэтому связь читает
// стада ПО ФОРМЕ (см. readHerds) и переживает и отсутствие модели, и
// переименование её полей. Числа, которые всё же продублированы (мясо, радиус,
// приручаемость видов), выровнены по herds.js и помечены СОГЛАСОВАТЬ — если
// главный разработчик сведёт их в один экспорт, здесь меняются три строки.
//
// ЕСЛИ МОДЕЛИ СТАД ЕЩЁ НЕТ, связь всё равно работает: при отсутствии sim.herds
// каждый зверь из sim.animals считается ОДИНОЧКОЙ — стада в один рог. Бонуса
// облавы одиночка не даёт (так и задумано), но истощение, вымирание вида и
// работа стоянки считаются честно. Так модуль полезен уже сегодня и не ждёт
// чужого файла.
//
// ЧИСТЫЙ МОДУЛЬ. Ничего не мутирует: читает sim, возвращает { mods, reasons,
// events, flags }. Даже собственный счётчик выбитых голов не пишется в sim — он
// приходит снаружи (sim.linkHunt) и уходит обратно в flags.memory. Применяет
// отчёт integrate.js, точные строки — в блоке ПОДКЛЮЧЕНИЕ в конце файла.
//
// СЛУЧАЙНОСТИ ЗДЕСЬ НЕТ ВООБЩЕ — ни Math.random, ни sim.rng. Куда уйдёт
// испуганное стадо и сколько мяса даст облава, игрок обязан посчитать заранее;
// а сейв обязан совпасть с прогоном слепок в слепок.
import { DAYS_PER_SEASON } from '../data.js';
import { EAT } from './link_survival.js';

// ---------- Виды ----------
// СОГЛАСОВАТЬ с herds.js: tame, r и meat выровнены по его SPECIES (.tameable,
// .radius, .meat) — две разные таблицы на одну и ту же дичь означали бы две
// разные игры в одной партии. Своё здесь только battue: насколько вид выгоден
// именно в облаве. Мамонт кормит долго, но гнать его стадом почти нельзя;
// кабан огрызается, и часть добычи уходит на возню с ранеными.
export const SPECIES = {
  deer:    { ru: 'олень',     many: 'оленьи стада',  tame: false, battue: 1.00, r: 7, meat: 9 },
  mammoth: { ru: 'мамонт',    many: 'мамонты',       tame: false, battue: 1.25, r: 9, meat: 55 },
  boar:    { ru: 'кабан',     many: 'кабаньи стада', tame: false, battue: 0.85, r: 6, meat: 13 },
  aurochs: { ru: 'дикий бык', many: 'стада быков',   tame: true,  battue: 1.15, r: 8, meat: 24 },
  // Запасной вид для зверя, про которого модель ничего не сказала: без него
  // любая опечатка в species выбрасывала бы голову из всех подсчётов молча.
  wild:    { ru: 'дичь',      many: 'дичь',          tame: false, battue: 1.00, r: 6, meat: 12 },
};

// ---------- Окно наблюдения ----------
// «Месяц» для игрока — это сезон: отдельного месяца в игре нет, а «за 25 суток»
// в строке предупреждения читается хуже, чем «за месяц».
export const KILL_WINDOW = DAYS_PER_SEASON;      // 25

// ---------- Облава ----------
// ПРЯМАЯ ПРОСЬБА ЗАКАЗЧИКА: бонус должен быть заметным. +90% к ходке при полном
// стаде и полной артели — это ровно вдвое против одиночного гона, и настолько же
// заметно на складе. Ниже — из чего он складывается.
export const BATTUE_MAX = 0.90;
// Меньше четырёх голов — это не стадо, а остатки: облаву устраивать не на кого.
export const BATTUE_MIN_HEAD = 4;
// С двадцати пяти голов прибавка по поголовью упирается в потолок: гнать сотню
// голов не легче, чем двадцать пять, — гонят всё равно краем.
export const BATTUE_FULL_HEAD = 25;
// Четыре охотника — полная артель. Один загонщик бонуса не даёт вовсе: облава —
// это про то, что люди работают ВМЕСТЕ, и одиночка её не устраивает.
export const BATTUE_PARTY_FULL = 4;
export const PARTY_RADIUS = 6;                   // на таком расстоянии охотники ещё одна артель
// Половина бонуса — от поголовья, половина — от числа рук. Так ни стадо без
// людей, ни толпа без стада не дают полной прибавки.
export const BATTUE_HEAD_W = 0.5;
export const BATTUE_PARTY_W = 0.5;
// Пуганое стадо не подпускает: до −50% к добыче. Это и есть цена жадности,
// которую охотник чувствует В ТОТ ЖЕ ДЕНЬ, а не через сезон.
export const FEAR_YIELD = 0.5;

// ---------- Охотничья стоянка ----------
// Место постройки наконец что-то значит. Числа подобраны так, чтобы разница
// была видна невооружённым глазом: стоянка у стада кормит втрое лучше стоянки
// в пустой степи (1.6 против 0.5).
export const LODGE_RADIUS = 9;                   // докуда охотники ходят от стоянки
export const LODGE_FULL_HEAD = 30;               // столько голов в округе — полная выработка
export const LODGE_MIN = 0.5;                    // пол: в пустой степи — половина
export const LODGE_MAX = 1.6;                    // потолок: больше стадо уже не помогает
export const LODGE_FEAR_CUT = 0.35;              // пуганое стадо отодвигается от стоянки

// ---------- Истощение ----------
// Сколько голов в день можно брать со стада, не проедая его. Это НЕ приплод из
// herds.js (там growth 0.014…0.055 на голову): стадо у ёмкости почти не
// растёт, и наибольшая безопасная добыча у логистического стада — около
// growth×K/4, то есть при K≈40 и growth 0.03 это ~0.3 головы в сутки, ~0.012 на
// голову нынешнего поголовья. Мы этим числом НИЧЕГО не начисляем: оно нужно
// ровно затем, чтобы честно сказать словами, поспевает ли приплод за добычей.
export const REGROW_PER_HEAD = 0.012;
// Давление = выбито за окно / сколько за то же окно родится. Единица — ровно на
// грани, дальше стадо тает.
export const PRESSURE_WARN = 1.0;                // отсюда предупреждаем
export const PRESSURE_FLEE = 2.0;                // отсюда стада откочёвывают
export const PRESSURE_CAP = 4;                   // выше не считаем: страшнее уже не будет

// Пугливость. Прибавка за голову, выбитую из стада, и потолок за сутки: залп в
// двадцать голов за день не должен мгновенно ставить стаду страх 1.0 —
// испугаться до предела можно, но не за одно утро.
export const FEAR_PER_KILL = 0.05;
export const FEAR_DAY_CAP = 0.25;
// ВЫХОД ИЗ ПЕТЛИ. Перестали бить — страх тает за 25 суток с потолка до нуля.
// Это ровно окно наблюдения: «месяц не трогали — стадо вернулось». Без такого
// выхода одна жадная зима означала бы мёртвую охоту до конца партии.
export const FEAR_CALM = 0.04;

// Откочёвка. Стадо уходит от поселения, но не в бесконечность: дальше
// FLEE_MAX_DIST его гнать некуда — это уже чужие земли, а игрок должен видеть
// предел беды. Обратный ход медленнее ухода: доверие возвращается неохотно.
export const FLEE_FEAR = 0.55;
export const FLEE_STEP = 0.8;                    // клеток в сутки
export const FLEE_MAX_DIST = 40;
export const RETURN_FEAR = 0.20;
export const RETURN_STEP = 0.4;
export const RETURN_DIST = 12;                   // ближе стадо само не подходит

// ---------- Приручение ----------
// ОСОЗНАННЫЙ ВЫБОР, А НЕ АВТОМАТИКА: связь только сообщает, что стадо можно
// приручить, и считает последствия. Приказ отдаёт игрок (tameHerd), применяет
// integrate.js. Автоматическое приручение убило бы весь смысл: дичь молча
// превращалась бы в скот, и решения бы не было.
export const TAME_RADIUS = 8;                    // от пастбища до центра участка
export const TAME_MIN_HEAD = 8;                  // из трёх голов стада не сделать
export const TAME_MAX_FEAR = 0.5;                // пуганое стадо к людям не пойдёт
export const TAME_FOOD_PER_HEAD = 0.06;          // еды в день с головы скота
export const TAME_PER_PASTURE = 25;              // столько голов прокормит одно пастбище

// ---------- Голод ----------
// Своей лестницы голода здесь НЕТ и быть не должно: она в link_survival, и
// вторая копия дала бы двойной удар по стабильности за одну и ту же беду.
// Отсюда уходит только сигнал: доля прокорма, висящая на охоте, и риск того,
// что она вот-вот отвалится. Стабильность мы не трогаем ВООБЩЕ.
export const RISK_WARN = 0.5;
export const HOME_RANGE = 18;                    // докуда охотники ходят от поселения
// Настроение: охотники, возвращающиеся пустыми, — это ещё не голод, но уже
// уныние. Потолки узкие намеренно, чтобы не спорить с link_survival.
export const HAPPY_EMPTY_MAX = 3;
export const HAPPY_TAME_MAX = 2;
export const FAIL_CAP = 60;                      // счётчик пустых суток не растёт вечно

// Как часто связь повторяет одно и то же. Игрок должен прочитать беду заранее,
// но не читать её каждое утро одними и теми же словами.
export const SAY_COOLDOWN = 20;

// Вымирание вида. Своей породы «вымирание» в link_memory нет, а заводить её —
// это правка чужого файла. Ближайшая по смыслу порода — famine: мясо кончилось
// навсегда, и помнят об этом теми же словами. Если главный разработчик добавит
// в KIND породу 'extinct', здесь меняется ровно одна строка.
export const EXTINCT_SCAR_KIND = 'famine';
export const EXTINCT_SCAR_SCALE = 0.8;
// Через сколько суток после последней головы вид считается изведённым. Не ноль:
// между загрузкой сейва и первым ходом стада могут не успеть попасть в список.
export const EXTINCT_GAP = 2;

const DEFAULT_RANGE = 6;                         // радиус участка, если модель его не дала

// ---------- Память связи ----------
// Живёт в sim.linkHunt, но пишется ТОЛЬКО через возвращаемый flags.memory.
//
// ПАМЯТЬ ХРАНИТ СОБЫТИЯ, А НЕ СОСТОЯНИЯ. Здесь это особенно легко нарушить:
// соблазн держать «сколько голов выбито всего» и «стадо сейчас пугливо». Оба
// поля были бы состоянием, которое переписывается каждые сутки и никогда не
// тает — ровно та ошибка, на которой обожглись в link_memory (мор стоял на
// потолке двенадцать лет). Поэтому храним журнал добычи по суткам с окном в
// месяц, а пугливость вообще не храним: её хозяин — модель стад, мы только
// возвращаем поправку к ней.

export function createHuntMemory() {
  return {
    v: 1,
    day: -1,          // защита от двойного применения в одни сутки
    kills: [],        // [{d, s, n}] — сутки, вид, сколько голов; окно KILL_WINDOW
    seen: {},         // вид → последний день, когда он ещё водился
    extinct: {},      // вид → день, когда его извели (пишется ОДИН раз)
    tamed: {},        // id стада → день приручения
    // Скот. herds.js прирученное стадо из своего списка УБИРАЕТ (оно перестало
    // быть дичью и его модели больше не касается) — и головам нужен хозяин,
    // иначе приручение означало бы «стадо исчезло». Хозяин здесь: вид → голов.
    // Это не состояние-которое-переписывается, а итог events приручения: число
    // меняется только приказом игрока, см. withStock.
    stock: {},
    said: {},         // ключ рассказа → день (чтобы не бубнить)
    headSeen: 0,      // общее поголовье вчера — запасной способ поймать добычу
    failDays: 0,      // сколько суток подряд охота не кормит того, кто на ней живёт
    happyMod: 0,      // последняя поправка к счастью — её читает happiness()
  };
}

export function restoreHuntMemory(data) {
  const m = createHuntMemory();
  if (!data || typeof data !== 'object') return m;
  m.day = num(data.day, -1);
  m.headSeen = Math.max(0, num(data.headSeen, 0));
  m.failDays = clamp(num(data.failDays, 0), 0, FAIL_CAP);
  m.happyMod = num(data.happyMod, 0);
  if (Array.isArray(data.kills)) {
    for (const k of data.kills) {
      if (!k || typeof k !== 'object') continue;
      const n = Math.floor(num(k.n, 0));
      if (!(n > 0)) continue;
      m.kills.push({ d: Math.round(num(k.d, 0)), s: speciesId(k.s), n });
    }
  }
  m.seen = numMap(data.seen);
  m.extinct = numMap(data.extinct);
  m.tamed = numMap(data.tamed);
  m.said = numMap(data.said);
  for (const [k, v] of Object.entries(numMap(data.stock))) {
    if (v > 0) m.stock[speciesId(k)] = Math.floor(v);
  }
  return m;
}

// Скот прибавился: игрок приручил стадо. Возвращает НОВУЮ память — сама связь
// в sim по-прежнему не пишет. Зовётся из integrate.js сразу после успешного
// приручения (хоть нашего, хоть через herds.tameHerd), см. ПОДКЛЮЧЕНИЕ.
export function withStock(mem, species, heads) {
  const m = cloneMem(mem && typeof mem === 'object' ? { ...createHuntMemory(), ...mem } : createHuntMemory());
  const n = Math.floor(numOf(heads, 0));
  if (!(n > 0)) return m;
  const s = speciesId(species);
  m.stock[s] = Math.max(0, (m.stock[s] || 0) + n);
  return m;
}

// ---------- Чтение мира ----------
// Единственное место, где ядро переводится на язык этой связи. Всё остальное
// считает по нормализованным числам и про устройство sim не знает.

export function huntState(sim) {
  const day = Math.round(numOf(sim && sim.day, 0));
  const pop = aliveCount(sim);
  const food = Math.max(0, numOf(sim && sim.res && sim.res.food, 0));
  // Запас в днях считаем той же меркой, что link_survival (EAT оттуда и
  // импортирован): две оценки сытости разошлись бы, и игрок читал бы в двух
  // панелях разные числа.
  const foodDays = pop > 0 ? food / (pop * EAT) : Infinity;

  const modelled = readHerds(sim);
  // Если модель стад есть — она единственный источник правды. Мешать её с
  // sim.animals нельзя: herds.js держит зверьё как поголовье, а ядро — как
  // фигурки на карте, и одна и та же голова посчиталась бы дважды.
  const herds = modelled !== null ? modelled : loneAnimals(sim);
  const hasSource = modelled !== null || Array.isArray(sim && sim.animals);

  const cx = numOf(sim && sim.world && sim.world.startX, 0);
  const cy = numOf(sim && sim.world && sim.world.startY, 0);

  const wild = herds.filter(h => !h.tame && h.head > 0);
  const tame = herds.filter(h => h.tame && h.head > 0);
  const wildHead = sum(wild.map(h => h.head));
  const tameHead = sum(tame.map(h => h.head));
  // Дичь, до которой охотники реально дойдут. Стадо за полкарты в подсчёт
  // сытости не идёт: формально дичь есть, а есть нечего.
  const nearHead = sum(wild.filter(h => dist(h.x, h.y, cx, cy) <= HOME_RANGE).map(h => h.head));

  const done = doneBuildings(sim);
  return {
    day, pop, food, foodDays, cx, cy,
    herds, wild, tame, wildHead, tameHead, nearHead, hasSource,
    lodges: done.filter(b => b.id === 'hunter_lodge'),
    pastures: done.filter(b => b.id === 'pasture'),
    hunters: countHunters(sim),
    hasHunting: hasTech(sim, 'hunting'),
    hasHusbandry: hasTech(sim, 'animal_husbandry'),
    bySpecies: headBySpecies(herds),
    gone: goneByModel(sim),
  };
}

// ---------- Бонус за облаву ----------
// Зовётся из ядра В МОМЕНТ ДОБЫЧИ (см. ПОДКЛЮЧЕНИЕ, правка в simulation.js):
// множитель зависит от точки, поэтому кэшировать его по суткам нельзя.
// Ничего не мутирует и не бросает — звать безопасно откуда угодно.
//
// ПОТОЛОК: 1 + BATTUE_MAX * battue = ×2.13 у мамонта, ×1.9 у оленя. Больше не
// бывает даже теоретически, и это специально: охота не должна становиться
// заменой хозяйству, она должна быть лучшим НАЧАЛОМ.
export function huntYieldMult(sim, x, y) {
  const herds = readHerds(sim);
  if (herds === null) return 1;                  // модели стад нет — гон одиночки
  const h = herdAt(herds, x, y);
  if (!h || h.tame || h.head <= 0) return 1;     // одиночка или скот — бонуса нет
  return round2(battueMult(h, countHunters(sim, x, y, PARTY_RADIUS)));
}

// Сколько рук у стада прямо сейчас. Отдельная функция, потому что это число
// нужно не только нам: модель стад считает добычу по числу охотников, а ядро
// звало её с жёсткой единицей — то есть артельного бонуса в игре не было
// вовсе, сколько бы народу ни собралось. См. ПОДКЛЮЧЕНИЕ, правка 9.
export function huntParty(sim, x, y) {
  return Math.max(1, countHunters(sim, x, y, PARTY_RADIUS));
}

// Тот же расчёт, но по уже известному числу охотников: им пользуется и сама
// связь (для отчёта), и huntYieldMult.
function battueMult(h, hunters) {
  // Меньше BATTUE_MIN_HEAD голов — облавы нет вовсе, даже если рядом стоит вся
  // артель. Без этой отсечки толпа охотников получала бы половину бонуса,
  // окружив одного-единственного зверя, — ровно то, чего связь не должна
  // допускать: стадо обязано быть выгоднее одиночки.
  if (h.head < BATTUE_MIN_HEAD) return 1;
  const sp = SPECIES[h.species] || SPECIES.wild;
  const head = clamp((h.head - BATTUE_MIN_HEAD) / (BATTUE_FULL_HEAD - BATTUE_MIN_HEAD), 0, 1);
  // Один человек — это гон, а не облава: (n−1)/(4−1).
  const party = clamp((hunters - 1) / (BATTUE_PARTY_FULL - 1), 0, 1);
  const gain = BATTUE_MAX * (BATTUE_HEAD_W * head + BATTUE_PARTY_W * party) * sp.battue;
  return (1 + gain) * (1 - FEAR_YIELD * clamp(h.fear, 0, 1));
}

// ---------- Выработка охотничьей стоянки ----------
// Зовётся из produceAt: стоянка у стада кормит, стоянка в пустой степи — нет.
// Читает дневной отчёт (sim.sys.huntLinks), а если его ещё нет — считает сама.
// Проход по стадам дешёвый (их единицы), но produceAt зовут десятки раз за
// кадр, поэтому кэш всё-таки есть.
export function huntLodgeMult(sim, b) {
  if (!b) return 1;
  const cached = sim && sim.sys && sim.sys.huntLinks && sim.sys.huntLinks.flags.lodges;
  const key = lodgeKey(b);
  if (cached && cached[key] != null) return cached[key];
  const herds = readHerds(sim);
  return lodgeMultAt(herds === null ? loneAnimals(sim) : herds, b.x, b.y);
}

function lodgeMultAt(herds, x, y) {
  let head = 0, fearW = 0;
  for (const h of herds) {
    if (h.tame || h.head <= 0) continue;
    if (dist(h.x, h.y, x, y) > LODGE_RADIUS + h.r) continue;
    head += h.head;
    fearW += h.head * clamp(h.fear, 0, 1);
  }
  if (head <= 0) return LODGE_MIN;               // пол: пустая степь
  const fear = fearW / head;
  const avail = clamp(head / LODGE_FULL_HEAD, 0, 1);
  // Пугливость режет только прибавку сверх пола: даже совсем дикое стадо
  // оставляет стоянке столько же, сколько пустая степь, но не меньше.
  return round2(LODGE_MIN + (LODGE_MAX - LODGE_MIN) * avail * (1 - LODGE_FEAR_CUT * fear));
}

// ---------- Приручение ----------
// Кандидаты со словами: почему можно и почему нельзя. Панель показывает список
// целиком, включая непроходные строки, — иначе игрок не поймёт, чего не хватает.
export function tameCandidates(sim) {
  const st = huntState(sim);
  const out = [];
  for (const h of st.wild) {
    const sp = SPECIES[h.species] || SPECIES.wild;
    const near = nearestDist(st.pastures, h.x, h.y);
    let why = '';
    if (!sp.tame) why = `${cap1(sp.ru)} не приручается: это дичь, а не скот`;
    else if (!st.hasHusbandry) why = 'Нужно скотоводство';
    else if (near === null) why = 'Нужно пастбище';
    else if (near > TAME_RADIUS) why = `Пастбище далеко: ${Math.round(near)} кл. вместо ${TAME_RADIUS}`;
    else if (h.head < TAME_MIN_HEAD) why = `Мало голов: ${h.head} из ${TAME_MIN_HEAD}`;
    else if (h.fear > TAME_MAX_FEAR) why = `Стадо пуганое (${pct(h.fear)}): к людям не подойдёт`;
    out.push({
      id: h.id, species: h.species, ru: sp.ru, head: h.head,
      fear: round2(h.fear), pasture: near === null ? null : Math.round(near),
      ok: why === '', why,
      // Сколько корма даст приручение: игрок должен видеть цену выбора числом.
      food: round2(h.head * TAME_FOOD_PER_HEAD),
    });
  }
  out.sort((a, b) => (b.ok - a.ok) || (b.head - a.head));
  return out;
}

// Приказ игрока. Ничего не меняет — возвращает отчёт, применяет integrate.js.
export function tameHerd(sim, herdId) {
  const c = tameCandidates(sim).find(x => x.id === herdId);
  if (!c) return { ok: false, reason: 'Такого стада нет', mods: { tame: [] }, events: [] };
  if (!c.ok) return { ok: false, reason: c.why, mods: { tame: [] }, events: [] };
  return {
    ok: true, reason: '',
    mods: { tame: [herdId] },
    events: [{
      text: `🐂 Стадо приручено: ${c.head} голов (${c.ru}). Это больше не дичь — это скот, `
        + `и кормит он каждый день, а не один раз.`,
      type: 'good',
    }],
  };
}

// ---------- Главная связь ----------

export function huntLinks(sim) {
  const st = huntState(sim);
  const prev = readMemory(sim);
  const mem = cloneMem(prev);
  const events = [];
  const reasons = [];

  // ОДИН ДЕНЬ СЧИТАЕТСЯ ОДИН РАЗ. Гасим ровно то, что НАКАПЛИВАЕТСЯ: журнал
  // добычи, пугливость, откочёвку, корм со скота и рассказы. Множители
  // (облава, стоянка) — не накопление, а свойство сегодняшнего мира: их можно
  // пересчитывать сколько угодно раз, ответ не изменится.
  const sameDay = prev.day === st.day;

  const mods = {
    food: 0,            // дневная прибавка еды со скота
    happy: 0,           // уныние от пустых ходок / уверенность от скота
    yieldMult: 1,       // лучший множитель облавы поблизости — для панели
    herds: {},          // id → {fear, dx, dy}: поправки к модели стад
    tame: [],           // id стад, ставших скотом (заполняет tameHerd, не связь)
  };

  // ── Добыча за сутки ───────────────────────────────────────────────────────
  const killed = sameDay ? [] : killsToday(sim, st, mem);
  if (!sameDay) {
    mem.day = st.day;
    for (const k of killed) addKill(mem, st.day, k.species, k.n);
    // Окно: журнал не растёт всю партию и не тащит в каждый сейв историю за
    // двадцать лет. Всё, что старше месяца, к сегодняшней охоте отношения не
    // имеет — стада уже успели ответить приплодом.
    mem.kills = mem.kills.filter(k => st.day - k.d < KILL_WINDOW);
    mem.headSeen = st.wildHead;
  }

  const kills30 = sum(mem.kills.map(k => k.n));
  const killsToday_ = sum(killed.map(k => k.n));
  // Поголовье на начало окна: то, что осталось, плюс то, что выбито. Именно эту
  // пару чисел игрок и должен увидеть в предупреждении.
  const wasHead = st.wildHead + kills30;
  // Сколько голов родилось бы за то же окно при нынешнем поголовье.
  const born = st.wildHead * REGROW_PER_HEAD * KILL_WINDOW;
  const pressure = born > 0.5 ? Math.min(PRESSURE_CAP, kills30 / born) : (kills30 > 0 ? PRESSURE_CAP : 0);

  // ── Облава: лучший множитель поблизости (для панели и для события) ────────
  let best = null;
  for (const h of st.wild) {
    if (dist(h.x, h.y, st.cx, st.cy) > HOME_RANGE) continue;
    const m = battueMult(h, countHunters(sim, h.x, h.y, PARTY_RADIUS));
    if (!best || m > best.m) best = { h, m };
  }
  mods.yieldMult = best ? round2(best.m) : 1;
  if (best && best.m > 1.05) {
    const sp = SPECIES[best.h.species] || SPECIES.wild;
    reasons.push({
      ru: `Облава на ${sp.many} (${best.h.head} гол.): мяса за ходку ×${f2(best.m)}`,
      v: round2(best.m),
    });
  }

  // ── Стоянки: место постройки наконец значит ───────────────────────────────
  const lodges = {};
  let poorLodges = 0;
  for (const b of st.lodges) {
    const k = lodgeMultAt(st.herds, b.x, b.y);
    lodges[lodgeKey(b)] = k;
    if (k <= LODGE_MIN + 0.02) poorLodges++;
    reasons.push({
      ru: k > 1
        ? `Стоянка (${b.x},${b.y}) стоит у дичи: выработка ×${f2(k)}`
        : `Стоянка (${b.x},${b.y}) в пустой степи: выработка ×${f2(k)}`,
      v: k,
    });
  }

  // ── Скот: постоянный корм вместо разовой добычи ───────────────────────────
  // Голов две породы: те, что модель ещё держит у себя с пометкой tame, и те,
  // что она отдала нам при приручении (mem.stock). Складываем, но не дважды:
  // помеченных tame herds.js у себя не оставляет.
  const stockHead = sum(Object.values(mem.stock));
  const tameHead = st.tameHead + stockHead;
  const roomForHead = st.pastures.length * TAME_PER_PASTURE;
  const fedHead = Math.min(tameHead, roomForHead);
  if (tameHead > 0) {
    if (!sameDay) mods.food = round2(fedHead * TAME_FOOD_PER_HEAD);
    if (fedHead > 0) {
      reasons.push({ ru: `Скот у пастбища: ${fedHead} гол. дают ${f2(fedHead * TAME_FOOD_PER_HEAD)} еды в день`, v: round2(fedHead * TAME_FOOD_PER_HEAD) });
    }
    if (tameHead > roomForHead) {
      // Потолок приручения: без пастбищ скот кормить негде, и бесконечно
      // приручать стада нельзя — иначе мясо снова стало бы бесплатным.
      reasons.push({
        ru: roomForHead > 0
          ? `Скота больше, чем прокормит пастбище: ${tameHead - roomForHead} гол. впроголодь`
          : `Скот без пастбища: ${tameHead} гол. кормить негде`,
        v: 0,
      });
    }
  }

  // ── Сигнал лестнице голода ────────────────────────────────────────────────
  // Не своя лестница, а одно число: какая доля прокорма висит на охоте и
  // насколько эта опора шатается. Стабильность не трогаем — это link_survival.
  const need = Math.max(0.1, st.pop * EAT);
  const huntIncome = kills30 > 0 ? (kills30 * meanMeat(mem)) / KILL_WINDOW : 0;
  const huntShare = clamp(huntIncome / need, 0, 1);
  const availability = clamp(st.nearHead / BATTUE_FULL_HEAD, 0, 1);
  const starveRisk = round2(huntShare * (1 - availability));

  if (!sameDay) {
    mem.failDays = (huntShare > 0.25 && availability < 0.25)
      ? Math.min(FAIL_CAP, mem.failDays + 1)
      // Выход тот же, что у голода в link_survival: восстановление вдвое
      // быстрее падения, иначе одна неудачная неделя тянулась бы месяц.
      : Math.max(0, mem.failDays - 2);
  }

  // ── Настроение ────────────────────────────────────────────────────────────
  if (starveRisk > 0.05) {
    const d = -round2(HAPPY_EMPTY_MAX * starveRisk);
    mods.happy += d;
    reasons.push({ ru: 'Охотники возвращаются пустыми', v: d });
  }
  if (fedHead > 0) {
    const d = round2(HAPPY_TAME_MAX * clamp(fedHead / TAME_PER_PASTURE, 0, 1));
    mods.happy += d;
    reasons.push({ ru: 'Свой скот у дома', v: d });
  }
  mods.happy = round2(clamp(mods.happy, -HAPPY_EMPTY_MAX, HAPPY_TAME_MAX));
  mem.happyMod = mods.happy;

  // ── Пугливость и откочёвка ────────────────────────────────────────────────
  // ПОТОЛОК ПЕТЛИ: страх не выше 1.0, прибавка не больше FEAR_DAY_CAP за сутки,
  // уход не дальше FLEE_MAX_DIST от поселения.
  // ВЫХОД ИЗ ПЕТЛИ: перестали бить — страх тает по FEAR_CALM в сутки и стада
  // сами возвращаются к RETURN_DIST. Второй выход — приручение: скот не бегает.
  if (!sameDay) {
    const byHerd = killsByHerd(sim, st, killed);
    for (const h of st.wild) {
      const n = byHerd.get(h.id) || 0;
      let dFear;
      if (n > 0) {
        // Доля выбитого важнее числа: пять голов из семи — это ужас, пять из
        // ста — обычный день. Но и голое число не выбрасываем: одна голова из
        // ста тоже след, просто маленький.
        const share = h.head + n > 0 ? n / (h.head + n) : 0;
        dFear = Math.min(FEAR_DAY_CAP, FEAR_PER_KILL * n * (0.5 + share));
      } else {
        dFear = -FEAR_CALM;
      }
      // Давление всего промысла добавляет общего беспокойства: стада уходят не
      // только от своих ловчих ям, но и оттуда, где рядом бьют соседей.
      if (pressure >= PRESSURE_FLEE) dFear += FEAR_CALM;
      // Потолок ставится ПОСЛЕ всех слагаемых, а не внутри первого: иначе общее
      // беспокойство прибавлялось поверх уже ограниченного залпа и суточная
      // прибавка выходила за FEAR_DAY_CAP (ловилось тестом на 0.29 против 0.25).
      dFear = clamp(dFear, -FEAR_CALM, FEAR_DAY_CAP);
      const newFear = clamp(h.fear + dFear, 0, 1);
      const step = fleeStep(h, newFear, st.cx, st.cy);
      const dF = round2(newFear - h.fear);
      if (dF !== 0 || step.dx !== 0 || step.dy !== 0) {
        mods.herds[h.id] = { fear: dF, dx: step.dx, dy: step.dy };
      }
    }
  }

  // ── Вымирание вида ────────────────────────────────────────────────────────
  const extinctToday = [];
  if (!sameDay && st.hasSource) {
    for (const [species, head] of Object.entries(st.bySpecies)) {
      if (head > 0) mem.seen[species] = st.day;
    }
    for (const species of Object.keys(mem.seen)) {
      const head = st.bySpecies[species] || 0;
      if (head > 0) continue;
      if (mem.extinct[species] != null) continue;          // уже записано — ОДИН раз
      if (st.day - mem.seen[species] > EXTINCT_GAP) continue;
      mem.extinct[species] = st.day;
      // Про этот вид уже сказала модель стад — второй записи не будет ни в
      // журнале, ни в летописи. Отметку у себя всё равно ставим, иначе завтра
      // мы попробуем рассказать о нём снова.
      if (st.gone[species] != null) continue;
      extinctToday.push(species);
      const sp = SPECIES[species] || SPECIES.wild;
      events.push({
        text: `☠ ${cap1(sp.many)} выбиты подчистую. Больше их не будет никогда — `
          + `в летописи останется, что этот род зверя извели мы.`,
        type: 'bad',
      });
    }
  }

  // ── Слова: игрок обязан прочитать беду ДО того, как она случится ──────────
  if (!sameDay) {
    // Главное предупреждение — ради него всё и делалось.
    if (pressure >= PRESSURE_WARN && kills30 > 0 && st.wildHead > 0 && canSay(mem, 'depletion', st.day)) {
      mem.said.depletion = st.day;
      const hard = pressure >= PRESSURE_FLEE;
      events.push({
        text: hard
          ? `‼ Стада уходят: за месяц выбито ${kills30} голов из ${wasHead}, приплод не поспевает вдвое. `
            + `Дичь откочёвывает от поселения — добыча будет падать, пока бьём.`
          : `⚠ Стада редеют: за месяц выбито ${kills30} голов из ${wasHead}, приплод не поспевает. `
            + `Сбавить охоту на месяц — и стада отойдут; не сбавить — уйдут сами.`,
        type: hard ? 'bad' : 'warn',
      });
    }
    // Последняя черта: осталось меньше, чем нужно на одну облаву.
    if (st.wildHead > 0 && st.wildHead < BATTUE_MIN_HEAD && kills30 > 0 && canSay(mem, 'last', st.day)) {
      mem.said.last = st.day;
      events.push({
        text: `‼ Дичи почти не осталось: ${st.wildHead} гол. на всю округу. Ещё несколько ходок — `
          + `и охота кончится навсегда.`,
        type: 'bad',
      });
    }
    // Провал охоты у тех, кто на ней живёт. Лестницу голода не трогаем — но
    // сказать, что опора уходит, обязаны раньше, чем опустеет склад.
    if (starveRisk >= RISK_WARN && mem.failDays >= 3 && canSay(mem, 'starve', st.day)) {
      mem.said.starve = st.day;
      const mouths = Math.round(huntShare * st.pop);
      events.push({
        text: `⚠ Охота кормила ${mouths} ртов из ${st.pop}, а дичи рядом не осталось. `
          + `Запаса на ${f1(st.foodDays)} дн. — нужны поля или пастбище.`,
        type: 'warn',
      });
    }
    // Стоянка в пустой степи: причина названа словами, а не «почему-то мало еды».
    if (poorLodges > 0 && canSay(mem, 'lodge', st.day)) {
      mem.said.lodge = st.day;
      events.push({
        text: `⚠ Охотничьих стоянок в пустой степи: ${poorLodges}. Дичи рядом нет, добыча вдвое ниже — `
          + `стоянку ставят у стада, а не где придётся.`,
        type: 'warn',
      });
    }
    // Хорошая новость тоже новость: игрок должен УВИДЕТЬ бонус, а не гадать,
    // почему в этот раз мяса больше.
    if (best && best.m >= 1.5 && canSay(mem, 'battue', st.day)) {
      mem.said.battue = st.day;
      const sp = SPECIES[best.h.species] || SPECIES.wild;
      events.push({
        text: `Облава удалась: ${sp.many} в ${best.h.head} голов, охотники бьют вместе — `
          + `мяса за ходку ×${f2(best.m)} против одиночного гона.`,
        type: 'good',
      });
    }
    // Приручение — выбор игрока, и о самой возможности надо сказать один раз.
    const ready = tameCandidates(sim).filter(c => c.ok);
    if (ready.length && canSay(mem, 'tame', st.day)) {
      mem.said.tame = st.day;
      const c = ready[0];
      events.push({
        text: `🐂 Стадо у пастбища можно приручить: ${c.head} гол. (${c.ru}). `
          + `Прирученное перестанет быть дичью и станет кормить каждый день.`,
        type: 'good',
      });
    }
  }

  const flags = {
    kills30, killsToday: killsToday_, wasHead,
    pressure: round2(pressure),
    wildHead: st.wildHead, tameHead, stockHead, nearHead: st.nearHead,
    fedHead, roomForHead,
    huntShare: round2(huntShare), availability: round2(availability),
    starveRisk, failDays: mem.failDays,
    lodges, poorLodges,
    bestBattue: mods.yieldMult,
    extinctToday, extinct: Object.keys(mem.extinct),
    memory: mem,
  };

  return { mods, reasons, events, flags };
}

// Плоская добавка к счастью — её подмешивает happiness() через integrate.js.
// Берём последнее посчитанное значение, а не считаем заново: happiness()
// вызывается десятки раз за кадр.
export function huntHappyMod(sim) {
  const m = sim && sim.linkHunt;
  return m ? Math.round(numOf(m.happyMod, 0)) : 0;
}

// Шрамы для летописи. Отдаём готовым списком в том виде, в каком его ждёт
// harvestScars/link_memory: {kind, scale, note}.
export function huntScars(out) {
  const list = [];
  const gone = out && out.flags && out.flags.extinctToday;
  if (!Array.isArray(gone)) return list;
  for (const s of gone) {
    const sp = SPECIES[s] || SPECIES.wild;
    list.push({ kind: EXTINCT_SCAR_KIND, scale: EXTINCT_SCAR_SCALE, note: `Извели вид: ${sp.many}` });
  }
  return list;
}

// ---------- Разбор для панели ----------
// Память НЕ двигает — звать из рендера безопасно.
export function huntBreakdown(sim) {
  const st = huntState(sim);
  const mem = readMemory(sim);
  const kills30 = sum(mem.kills.map(k => k.n));
  const born = st.wildHead * REGROW_PER_HEAD * KILL_WINDOW;
  const pressure = born > 0.5 ? Math.min(PRESSURE_CAP, kills30 / born) : (kills30 > 0 ? PRESSURE_CAP : 0);
  const rows = [];
  for (const [s, head] of Object.entries(st.bySpecies)) {
    if (head <= 0) continue;
    const sp = SPECIES[s] || SPECIES.wild;
    rows.push({ species: s, ru: sp.many, head });
  }
  rows.sort((a, b) => b.head - a.head);

  let text;
  if (!st.hasSource || (st.wildHead === 0 && st.tameHead === 0)) {
    text = 'Дичи в округе нет: охота больше не кормит.';
  } else if (pressure >= PRESSURE_WARN && kills30 > 0) {
    text = `Стада редеют: за месяц выбито ${kills30} гол. из ${st.wildHead + kills30}, приплод не поспевает.`;
  } else if (kills30 > 0) {
    text = `Охота в меру: за месяц взято ${kills30} гол. из ${st.wildHead + kills30}, стада держатся.`;
  } else {
    text = `Стада не тронуты: ${st.wildHead} гол. дичи в округе.`;
  }
  return {
    rows, text,
    kills30, pressure: round2(pressure),
    wildHead: st.wildHead, tameHead: st.tameHead,
    extinct: Object.keys(mem.extinct),
  };
}

// ---------- Внутреннее ----------

// Что выбито за эти сутки. Первый источник — отметки ядра (см. ПОДКЛЮЧЕНИЕ):
// simulation.js кладёт запись в момент добычи. Второй, запасной, — падение
// общего поголовья против вчерашнего: если правку в ядре ещё не сделали, связь
// всё равно видит охоту, пусть и без вида зверя.
function killsToday(sim, st, mem) {
  const inbox = sim && sim.sys && sim.sys.huntKills;
  if (Array.isArray(inbox)) {
    const out = [];
    for (const k of inbox) {
      if (!k || typeof k !== 'object') continue;
      // ДЕНЬ, КОТОРЫЙ ТОЛЬКО ЧТО КОНЧИЛСЯ, ТОЖЕ СЧИТАЕТСЯ. Здесь стояло строгое
      // равенство с st.day, и из-за него связь не видела охоты ВООБЩЕ: отметки
      // кладёт ядро в миг добычи, то есть в течение суток N, а дневной проход
      // идёт в начале суток N+1 (simulation.js: сперва this.day++, потом
      // onNewDay). Отметка со вчерашним числом под равенство не подходила, и
      // kills30 стоял на нуле всю партию при живой охоте — проверено прогоном
      // на 600 суток: двадцать четыре выхода на зверя, пятьдесят семь отметок,
      // ноль засчитанных.
      //
      // Дважды одна отметка не сосчитается: применитель в integrate.js сразу
      // после этого прохода выбрасывает всё, что старше нынешних суток, — то
      // есть ровно то, что связь только что прочла.
      const kd = Math.round(numOf(k.day, -1));
      if (kd !== st.day && kd !== st.day - 1) continue;
      out.push({ species: speciesId(k.species), n: Math.max(1, Math.floor(numOf(k.head, 1))), x: numOf(k.x, null), y: numOf(k.y, null), herdId: k.herdId != null ? String(k.herdId) : null, food: numOf(k.food, 0) });
    }
    return out;
  }
  const drop = Math.max(0, Math.round(mem.headSeen - st.wildHead));
  return drop > 0 ? [{ species: 'wild', n: drop, x: null, y: null, herdId: null, food: 0 }] : [];
}

// Кому именно досталось. Запись может назвать стадо прямо (herdId) или только
// точку — тогда ищем стадо, на чьём участке эта точка лежит.
function killsByHerd(sim, st, killed) {
  const map = new Map();
  for (const k of killed) {
    let h = null;
    if (k.herdId) h = st.herds.find(x => x.id === k.herdId) || null;
    if (!h && k.x !== null && k.y !== null) h = herdAt(st.herds, k.x, k.y);
    if (!h) continue;
    map.set(h.id, (map.get(h.id) || 0) + k.n);
  }
  return map;
}

function addKill(mem, day, species, n) {
  // Слияние в пределах суток: тридцать записей об одной охоте — это одна
  // охота. Журнал должен оставаться коротким, он попадает в каждый сейв.
  const same = mem.kills.find(k => k.d === day && k.s === species);
  if (same) same.n += n;
  else mem.kills.push({ d: day, s: species, n });
}

// Сколько еды в среднем приносит голова. Разброс между видами велик (олень 9,
// мамонт 55), поэтому берём средневзвешенное по журналу, а не общее число.
// Мясо взято из таблицы SPECIES, выровненной по herds.js. Это ОЦЕНКА и только
// для строки «охота кормила N ртов из M»: ни одна крошка еды по ней не
// начисляется, так что расхождение с моделью испортит фразу, но не баланс.
function meanMeat(mem) {
  let n = 0, food = 0;
  for (const k of mem.kills) { n += k.n; food += k.n * (SPECIES[k.s] || SPECIES.wild).meat; }
  return n > 0 ? food / n : SPECIES.wild.meat;
}

// Куда шагнёт стадо за сутки. Никакого броска: от поселения по прямой, и не
// дальше FLEE_MAX_DIST. Обратно — когда отпустил страх.
function fleeStep(h, fear, cx, cy) {
  const d = dist(h.x, h.y, cx, cy);
  let dx = 0, dy = 0;
  if (fear >= FLEE_FEAR && d < FLEE_MAX_DIST) {
    // Стадо ровно в центре поселения — вырожденный случай; направление берём
    // постоянным, чтобы прогон совпадал с сейвом.
    const ux = d > 0.001 ? (h.x - cx) / d : 1;
    const uy = d > 0.001 ? (h.y - cy) / d : 0;
    dx = round2(ux * FLEE_STEP); dy = round2(uy * FLEE_STEP);
  } else if (fear <= RETURN_FEAR && d > RETURN_DIST) {
    const ux = (cx - h.x) / d, uy = (cy - h.y) / d;
    dx = round2(ux * RETURN_STEP); dy = round2(uy * RETURN_STEP);
  }
  return { dx, dy };
}

// Стадо, на чьём участке лежит точка. Если участков несколько — ближайшее по
// центру: перекрывающиеся участки в модели допустимы.
function herdAt(herds, x, y) {
  let best = null, bestD = Infinity;
  for (const h of herds) {
    if (h.head <= 0) continue;
    const d = dist(h.x, h.y, x, y);
    if (d > h.r) continue;
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

// Читаем обе раскладки полей (см. шапку). Единственное место, которое придётся
// тронуть, если herds.js ещё раз переименует поля.
function readHerds(sim) {
  const raw = sim && sim.herds;
  const list = Array.isArray(raw) ? raw
    : (raw && Array.isArray(raw.herds)) ? raw.herds
    : (raw && Array.isArray(raw.list)) ? raw.list
    : null;
  if (!list) return null;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const h = list[i];
    if (!h || typeof h !== 'object') continue;
    const species = speciesId(h.species != null ? h.species : h.kind);
    // Поголовье у herds.js дробное: приплод копится по долям головы. Для охоты
    // важны целые туши, поэтому дробь отбрасываем — но ТОЛЬКО в нашем чтении,
    // модель у себя считает как считает.
    const head = Math.max(0, Math.floor(numOf(h.head != null ? h.head : h.n, 0)));
    out.push({
      id: String(h.id != null ? h.id : 'h' + i),
      species,
      head,
      x: numOf(h.x != null ? h.x : h.cx, 0),
      y: numOf(h.y != null ? h.y : h.cy, 0),
      r: Math.max(1, numOf(h.r, (SPECIES[species] || SPECIES.wild).r || DEFAULT_RANGE)),
      cap: Math.max(0, numOf(h.cap, head)),
      fear: clamp(numOf(h.fear, 0), 0, 1),
      tame: !!h.tame,
    });
  }
  return out;
}

// Виды, которые модель стад уже объявила выбитыми. О них мы молчим: herds.js
// сказал это игроку сам, и его же отчёт уходит шрамом в летопись.
function goneByModel(sim) {
  const g = sim && sim.herds && sim.herds.gone;
  const out = {};
  if (!g || typeof g !== 'object') return out;
  for (const k of Object.keys(g)) if (Number.isFinite(g[k])) out[speciesId(k)] = g[k];
  return out;
}

// Пока модели стад нет: каждый зверь ядра — стадо в одну голову. Радиус 0.5,
// чтобы точка добычи попадала в «участок» и запись находила своего зверя.
function loneAnimals(sim) {
  const list = sim && sim.animals;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a || typeof a !== 'object') continue;
    if (numOf(a.hp, 1) <= 0) continue;
    out.push({
      id: 'a' + i, species: speciesId(a.kind), head: 1,
      x: numOf(a.x, 0), y: numOf(a.y, 0), r: 0.5, cap: 1, fear: 0, tame: false,
    });
  }
  return out;
}

function headBySpecies(herds) {
  const out = {};
  for (const h of herds) {
    if (h.head <= 0) continue;
    out[h.species] = (out[h.species] || 0) + h.head;
  }
  return out;
}

function countHunters(sim, x, y, r) {
  const list = sim && sim.villagers;
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const v of list) {
    if (!v || v.job !== 'hunt') continue;
    if (v.hp !== undefined && v.hp <= 0) continue;
    if (x === undefined) { n++; continue; }
    if (dist(numOf(v.x, 0), numOf(v.y, 0), x, y) <= r) n++;
  }
  return n;
}

function doneBuildings(sim) {
  const list = sim && sim.buildings;
  if (!Array.isArray(list)) return [];
  return list.filter(b => b && b.done && !b.destroyed);
}

function nearestDist(list, x, y) {
  let best = null;
  for (const b of list) {
    const d = dist(numOf(b.x, 0), numOf(b.y, 0), x, y);
    if (best === null || d < best) best = d;
  }
  return best;
}

function hasTech(sim, id) {
  const t = sim && sim.techs;
  if (!t) return false;
  return typeof t.has === 'function' ? t.has(id) : (Array.isArray(t) ? t.includes(id) : false);
}

function canSay(mem, key, day) {
  return day - (mem.said[key] != null ? mem.said[key] : -9999) >= SAY_COOLDOWN;
}

function readMemory(sim) {
  const m = sim && sim.linkHunt;
  if (!m || typeof m !== 'object') return createHuntMemory();
  return cloneMem({ ...createHuntMemory(), ...m });
}

// Копия, а не ссылка: связь не имеет права тронуть то, что лежит в sim, даже
// случайно — иначе двойной вызов за сутки допишет журнал в чужой объект.
function cloneMem(m) {
  return {
    ...m,
    kills: Array.isArray(m.kills) ? m.kills.map(k => ({ ...k })) : [],
    seen: { ...(m.seen || {}) },
    extinct: { ...(m.extinct || {}) },
    tamed: { ...(m.tamed || {}) },
    // stock копируется вместе с остальными: без этой строки withStock правил
    // счётчик скота ПРЯМО в памяти, лежащей в sim, — то самое запрещённое
    // «модуль мутирует состояние», только через недокопированную ссылку.
    // Ловится тестом «withStock не трогает переданную память».
    stock: { ...(m.stock || {}) },
    said: { ...(m.said || {}) },
  };
}

function speciesId(s) {
  return typeof s === 'string' && SPECIES[s] ? s : 'wild';
}

function numMap(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const [k, v] of Object.entries(o)) if (Number.isFinite(v)) out[String(k)] = v;
  return out;
}

function lodgeKey(b) { return `${Math.round(numOf(b.x, 0))},${Math.round(numOf(b.y, 0))}`; }

function aliveCount(sim) {
  const list = sim && sim.villagers;
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const v of list) if (!v || v.hp === undefined || v.hp > 0) n++;
  return n;
}

function dist(x1, y1, x2, y2) { return Math.hypot(x1 - x2, y1 - y2); }
function sum(a) { let s = 0; for (const v of a) s += v; return s; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function num(v, def) { return Number.isFinite(v) ? v : def; }
function numOf(v, def) { return Number.isFinite(v) ? v : def; }
function round2(v) { return Math.round(v * 100) / 100; }
function f1(v) { return (Math.round(v * 10) / 10).toFixed(1); }
function f2(v) { return (Math.round(v * 100) / 100).toFixed(2); }
function pct(v) { return Math.round(v * 100) + '%'; }
function cap1(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/* ПОДКЛЮЧЕНИЕ ─────────────────────────────────────────────────────────────────

Правки в app/src/core/systems/integrate.js плюс три в app/src/core/simulation.js.
Каждый якорь — целая существующая строка с отступами; все проверены grep -F,
число совпадений указано рядом.

═══ integrate.js ═══

1) ИМПОРТ. Якорь (1 совпадение):

     import * as GH from './link_ghost.js';

   ДОБАВИТЬ строкой ниже:

     import * as HUNT from './link_hunt.js';

2) УСТАНОВКА. Якорь в installSystems() (1 совпадение):

     sim.linkGhost.seed = sim.seed | 0;

   ДОБАВИТЬ строкой ниже:

     // Связь охоты: журнал добычи за месяц, выбитые виды, прирученные стада.
     sim.linkHunt = HUNT.createHuntMemory();
     // Ядро кладёт сюда отметку в момент добычи; связь читает и забывает.
     sim.sys.huntKills = [];

3) ДЕНЬ. Якорь в systemsNewDay() (1 совпадение):

     const survOut = applySurvivalLinks(sim);

   ДОБАВИТЬ строкой ВЫШЕ. Место именно здесь: связь охоты кладёт на склад мясо
   со скота, а лестница голода обязана читать уже сложившийся запас, иначе
   пастбище «сработает» только на следующие сутки.

     const huntOut = applyHuntLinks(sim);

   ПРО ПОРЯДОК С applyHerds(sim). Модель стад ходит последней, перед памятью,
   поэтому связь читает поголовье и испуг НА НАЧАЛО суток, а добычу — за эти
   сутки (её приносят отметки из ядра). Для предупреждений это ровно то, что
   нужно: «выбито 14 из 40» считается от того стада, которое игрок застал утром.
   Если главный разработчик поднимет applyHerds выше applyHuntLinks, ничего не
   сломается — числа станут на сутки свежее, только и всего.

4) ЛЕТОПИСЬ. Якорь — последняя строка systemsNewDay() (1 совпадение):

     applyMemoryLinks(sim, harvestScars(sim, { war: warOut, surv: survOut }));

   ЗАМЕНИТЬ на:

     applyMemoryLinks(sim, harvestScars(sim, { war: warOut, surv: survOut })
       .concat(HUNT.huntScars(huntOut)));

5) СЧАСТЬЕ. Якорь — последняя строка systemsHappyMod() (1 совпадение):

     + (sim.sys.warLinks ? sim.sys.warLinks.mods.happy : 0);

   ЗАМЕНИТЬ на:

     + (sim.sys.warLinks ? sim.sys.warLinks.mods.happy : 0)
     + HUNT.huntHappyMod(sim);

6) СЕЙВ. Якорь в systemsSerialize() (1 совпадение):

     ghost: sim.linkGhost || null,

   ДОБАВИТЬ строкой ниже:

     hunt: sim.linkHunt || null,

   Якорь в systemsRestore() (1 совпадение):

     sim.linkGhost = GH.restoreGhost(data.ghost);

   ДОБАВИТЬ строкой ниже:

     sim.linkHunt = HUNT.restoreHuntMemory(data.hunt);

7) ПРИМЕНЕНИЕ. Якорь — конец applySurvivalLinks(), последние строки файла перед
   блоком PANELS (1 совпадение):

     // ---------- Экраны новых систем ----------

   ДОБАВИТЬ ВЫШЕ:

     // Связь «охота ↔ стада ↔ еда»: облава, стоянки у дичи, истощение и скот.
     // Модуль только считает; всё, что меняет мир, делается здесь.
     function applyHuntLinks(sim) {
       if (!sim.linkHunt) sim.linkHunt = HUNT.createHuntMemory();
       const out = HUNT.huntLinks(sim);
       sim.linkHunt = out.flags.memory;
       sim.sys.huntLinks = out;             // кэш для HUD и для huntLodgeMult

       // Скот кормит каждый день. Потолок склада тот же, что у промыслов:
       // приручение не должно быть способом обойти вместимость амбара.
       if (out.mods.food > 0) {
         sim.res.food = Math.min(sim.resCap.food, sim.res.food + out.mods.food);
       }

       // Поправки к модели стад. Пока herds.js не подключён, sim.herds нет и
       // цикл просто не находит, что править.
       const herds = Array.isArray(sim.herds) ? sim.herds
         : (sim.herds && Array.isArray(sim.herds.list) ? sim.herds.list : null);
       if (herds) {
         for (const [id, d] of Object.entries(out.mods.herds)) {
           const h = herds.find(x => x && String(x.id) === id);
           if (!h) continue;
           h.fear = Math.max(0, Math.min(1, (h.fear || 0) + d.fear));
           h.x = Math.max(0, Math.min(sim.world.w - 1, (h.x || 0) + d.dx));
           h.y = Math.max(0, Math.min(sim.world.h - 1, (h.y || 0) + d.dy));
         }
       }

       // Отметки добычи живут ровно одни сутки: дальше они уже в журнале связи.
       if (Array.isArray(sim.sys.huntKills)) {
         sim.sys.huntKills = sim.sys.huntKills.filter(k => k && sim.day - k.day < 2);
       }

       for (const e of out.events) sim.addLog(e.text, e.type);
       if (out.flags.extinctToday.length) {
         sim.sfx?.('alarm');
         for (const s of out.flags.extinctToday) {
           const sp = HUNT.SPECIES[s] || HUNT.SPECIES.wild;
           sim.addChronicle(`${sp.many} извели подчистую (день ${sim.day}).`);
         }
       }
       return out;
     }

     // Приручение — приказ игрока, а не автоматика. Панель зовёт huntTameList,
     // кнопка — huntTame. Здесь же сходятся два модуля: условия проверяет
     // link_hunt (он один знает про пастбище), само стадо снимает с карты
     // herds.js, а головы забирает себе счётчик скота link_hunt — иначе после
     // приручения стадо просто исчезло бы, ведь herds.js его у себя удаляет.
     export function huntTameList(sim) { return HUNT.tameCandidates(sim); }
     export function huntTame(sim, herdId) {
       const check = HUNT.tameHerd(sim, herdId);
       if (!check.ok) { sim.toast?.(check.reason, 'warn'); return check; }

       // Есть модель стад — приручает она (у неё свой отчёт и своё состояние).
       if (sim.herds && Array.isArray(sim.herds.herds)) {
         const ctx = HERD.herdsContext(sim, (world, x, y) => tileAt(world, x, y));
         const rep = HERD.tameHerd(sim.herds, Number(herdId), ctx);
         if (!rep.ok) { sim.toast?.(rep.reasons[0]?.ru || 'Нельзя', 'warn'); return rep; }
         sim.herds = rep.state;
         sim.linkHunt = HUNT.withStock(sim.linkHunt, rep.flags.kind, rep.flags.heads);
         for (const e of rep.events) sim.addLog(e.text, e.type);
         return rep;
       }

       // Модели стад нет (старый мир на sim.animals) — работаем по своей форме.
       const list = Array.isArray(sim.herds) ? sim.herds
         : (sim.herds && Array.isArray(sim.herds.list) ? sim.herds.list : null);
       if (list) {
         for (const id of check.mods.tame) {
           const h = list.find(x => x && String(x.id) === id);
           if (h) { h.tame = true; h.fear = 0; }
         }
       }
       for (const e of check.events) sim.addLog(e.text, e.type);
       return check;
     }

     // Готовая строка для HUD: «Стада редеют: за месяц выбито 14 гол. из 40…».
     // Память НЕ двигает — звать из рендера безопасно.
     export function huntPanel(sim) { return HUNT.huntBreakdown(sim); }

═══ simulation.js ═══

ВАЖНО ПРО ДВОЙНОЙ СЧЁТ. Модель стад уже подключена, и добычу считает её
huntHerd: там свои driveBonus (за поголовье), partyBonus (за артель) и скидка
за испуг. Поэтому huntYieldMult к rep.food применять НЕЛЬЗЯ — прибавка ушла бы
дважды. В подключённом мире huntYieldMult остаётся показометром для панели
(«что даст ходка прямо сейчас») и рабочим множителем только там, где модели
стад нет. А вот чего в ядре действительно нет — это самой артели: см. правку 9.

8) ИМПОРТ. Якорь — строка 7 (1 совпадение):

     import { installSystems, systemsNewDay, systemsFactions, systemsHappyMod, systemsWorkMult, systemsPopCapMod, systemsSerialize, systemsRestore, herdsNearest, herdsHunt } from './systems/integrate.js';

   ДОБАВИТЬ строкой ниже (отдельной строкой, а не в тот же список: связь берётся
   напрямую из своего файла — integrate.js её не переэкспортирует):

     import { huntParty, huntLodgeMult } from './systems/link_hunt.js';

9) АРТЕЛЬ. Ради этого пункта половина файла и написана. Якорь в onArrive,
   ветка 'hunt' (1 совпадение):

      const rep = herdsHunt(this, t.herd, { hunters: 1, skill: 1 });

   ЗАМЕНИТЬ на:

      // hunters: 1 означало, что артельного бонуса в игре нет ВОВСЕ: сколько бы
      // охотников ни сошлось у стада, модель считала одиночный гон и облава
      // ничем не отличалась от него. Число рук поблизости знает связь охоты.
      const rep = herdsHunt(this, t.herd, { hunters: huntParty(this, t.x, t.y), skill: 1 });
      // Отметка для связи: что, где и сколько взяли за эти сутки. Без неё связь
      // считает добычу по падению поголовья — верно, но без вида зверя.
      if (rep.heads > 0 && this.sys && Array.isArray(this.sys.huntKills)) {
        this.sys.huntKills.push({ day: this.day, species: rep.flags.kind, head: rep.heads, food: rep.food, x: t.x, y: t.y, herdId: t.herd });
      }

10) МЕСТО СТОЯНКИ. Якорь в produceAt (1 совпадение):

      } else if (this.seasonIdx === 3 && !def.winter) mult *= 0.6;

    ЗАМЕНИТЬ на:

      } else if (this.seasonIdx === 3 && !def.winter) mult *= 0.6;
      // Охотничья стоянка у стада кормит втрое лучше стоянки в пустой степи.
      if (b.id === 'hunter_lodge') mult *= huntLodgeMult(this, b);

    (порядок важен: зимний коэффициент и множитель дичи перемножаются, а не
    подменяют друг друга)

11) ЕСЛИ МОДЕЛИ СТАД В СБОРКЕ НЕТ (старый мир на this.animals) — вместо правки 9
    применить эту, к прежней ветке добычи:

          const meat = a.food * huntYieldMult(this, a.x, a.y);
          this.res.food = Math.min(this.resCap.food, this.res.food + meat);
          if (this.sys && Array.isArray(this.sys.huntKills)) {
            this.sys.huntKills.push({ day: this.day, species: a.kind, head: 1, food: meat, x: a.x, y: a.y });
          }

    Обе правки сразу — это двойной бонус. Или 9, или 11.

────────────────────────────────────────────────────────────────────────────── */
