// core/systems/link_dynasty.js — СВЯЗЬ: род ↔ сословия ↔ стабильность ↔ держава.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. dynasty.js завёл на троне СЕМЬЮ: имена, наследники,
// законность, претенденты. Но род там разговаривает сам с собой. Законность
// растёт и падает, а сословиям всё равно; правитель жесток — и это меняет
// множитель смуты в politics.js, но не отношение простолюдин к трону; двор ест
// золото — и никто в державе этого не видит. Заговора против правителя нет
// вообще: dynasty.js умеет переворот только как КНОПКУ ИГРОКА, поэтому власть
// у игрока нельзя отнять, а значит за неё нечего бояться.
//
// Здесь род встроен в общество. Сословия смотрят на трон каждое своими
// глазами, а трон отвечает за то, что видит держава.
//
// ЧТО ИМЕННО СВЯЗАНО (в обе стороны):
//   законность          ──▶ одобрение сословий; знать держится за неё сильнее всех
//   законность          ──▶ жрецы: венчают крепкую власть, отказывают узурпатору
//   черты правителя     ──▶ одобрение сословий (жестокий гасит смуту и ненавидим)
//   содержание двора    ──▶ купцы кормятся с двора, простолюдины видят роскошь
//   низкая законность   ──▶ РОПОТ → ПРЕТЕНДЕНТ → ПОПЫТКА ПЕРЕВОРОТА
//   пресечение рода     ──▶ сигнал сепаратизма городам (считает link_territory)
//   ОБРАТНО: победы и взятые города поднимают законность, позор и голод роняют
//            (события берутся из уже готовой памяти link_memory.js)
//   ОБРАТНО: очень довольная знать связывает роду руки — наследника мимо
//            старшинства не назначить
//
// ═══ ЧЕГО ЗДЕСЬ НЕТ, ПОТОМУ ЧТО ЭТО УЖЕ ПОСЧИТАНО ═══
//
// Двойной счёт — главная опасность связи, которая садится поверх готовой
// модели. Поимённо, что НЕ делается здесь и кем делается:
//
//   · расход золота на двор, законность за содержание, ±0.05 знати и
//     простолюдинам за ступень двора — dynasty.js, _tickCourt();
//   · законность → стабильность (±0.3/сут), знать ±0.04, войско ±0.02 —
//     dynasty.js, _tickStanding();
//   · стабильность за каждого претендента (CLAIM_STAB) и за междуцарствие
//     (INTERREGNUM_STAB) — dynasty.js, _tickClaimants/_tickInterregnum;
//   · множители державы от черт (warlord +15% армии и прочее) — politics.js,
//     politicsMult(); здесь черты трогают ТОЛЬКО одобрение сословий;
//   · падение одобрения от голода, стужи и мора — link_survival.js,
//     ESTATE_HUNGER/COLD/SICK. Голод здесь работает лишь УСИЛИТЕЛЕМ злости на
//     роскошь двора, своего второго удара по сословиям он не наносит;
//   · рост сепаратизма и отпадение городов — link_territory.js. Мы подаём ему
//     одно число (cityUnrestAll) и не считаем ни одного города сами;
//   · что именно случилось за сутки (голод, позор, победа) — link_memory.js.
//     Мы читаем его свежие шрамы, а не разбираем летопись во второй раз.
//
// ═══ ЧТО МЫ ЖДЁМ ОТ dynasty.js (модель рода) ═══
//
// Импорт статический — файл в дереве есть. Но состояние читается ПО ФОРМЕ, и
// каждая константа берётся с запасным значением: модель пишется параллельно,
// и переименованное поле не должно ронять партию, а должно тихо давать
// нейтральный отчёт.
//
//   sim.dynasty = {
//     fam:         string,      // прозвание рода
//     legitimacy:  0..100,      // законность
//     court:       0|1|2,       // ступень содержания двора (COURT в dynasty.js)
//     claimants:   [{ name, fam, strength }],
//     interregnum: number,      // сколько дней ещё пуст трон; 0 — трон занят
//     rulerId:     number|null,
//     members:     [{ id, name, traits[] }],
//     generations: number,
//     stats:       { coups, houses, ... },
//   }
//
// ЕСЛИ РОДА НЕТ ВОВСЕ (старый сейв, модель ещё не подключена) — связь читает
// законность как 50, двор как «по обычаю», претендентов нет. Тогда она молчит
// целиком и ничего не портит: ни одной поправки, ни одного события.
//
// ═══ СЛУЧАЙНОСТИ ЗДЕСЬ НЕТ ВООБЩЕ ═══
//
// Ни Math.random, ни sim.rng. Это не гигиена, а замысел: заговор обязан быть
// СЧИТАЕМЫМ. Игрок должен видеть «до попытки переворота 6 дней» и успеть, а не
// узнавать о перевороте по броску кости. Заодно связь одинакова до и после
// загрузки сейва и её безопасно звать из рендера.
//
// ═══ ПОТОЛКИ И ВЫХОДЫ ═══
//
//   · заговор (plot) 0…100, шаг в обе стороны ограничен PLOT_STEP_MAX = 1.6.
//     Спад при выправленном положении PLOT_CALM = 1.9 СТРОГО БОЛЬШЕ предельного
//     прироста — то есть любую, даже самую запущенную смуту можно погасить
//     быстрее, чем она копилась: со 100 до нуля за 53 дня. Тест это проверяет
//     не на словах, а сравнением констант;
//   · ступени заговора с гистерезисом (порог входа выше порога выхода), иначе
//     у самой границы игрок получал бы «претендент явился / претендент ушёл»
//     через день;
//   · попытка переворота НЕ УДАЁТСЯ НИКОГДА, пока законность ≥ COUP_BLOCK_LEG
//     или пока dynasty.canOverthrow() говорит «нельзя». Это второй, независимый
//     выход, и он назван словами каждый день, пока идёт отсчёт. Именно поэтому
//     третья ступень называется ПОПЫТКОЙ, а не переворотом: связь не имеет
//     права обещать то, что модель рода откажется делать;
//   · после переворота или после сорвавшегося заговора — COUP_CD суток тишины:
//     два переворота подряд означали бы партию без власти;
//   · дневная потеря стабильности от ВСЕЙ связи ограничена STAB_FLOOR = −0.8;
//   · сдвиг каждого сословия за сутки ограничен ESTATE_STEP_CAP = 0.35 (для
//     сравнения: собственный дрейф сословий к 50 в politics.js — ±0.05/сут).
//
// ═══ ПАМЯТЬ ХРАНИТ СОБЫТИЯ, А НЕ СОСТОЯНИЯ ═══
//
// Разовые удары по законности (позор, победа, голод, мор) уходят в род списком
// flags.dynEvents. Наивно было бы каждые сутки читать «у нас голод» и каждые
// сутки снимать законность: голодная зима длится месяц, и род потерял бы 200
// очков там, где заслужил 7 — ровно та беда, на которой обожглись с мором в
// link_memory.js. Поэтому источник событий — СВЕЖИЕ ШРАМЫ памяти: link_memory
// сам сливает повторы одной беды в пределах сезона в один шрам с одним днём,
// значит ключ «порода@день» неповторим по построению. Плюс собственный список
// seen, чтобы двойной вызов в те же сутки не выдал событие второй раз.

import { SOCIAL_FACTIONS, RULER_TRAITS } from './politics.js';
import * as DYN from './dynasty.js';
import { KIND as SCAR_KIND } from './link_memory.js';
import { DAYS_PER_SEASON } from '../data.js';

// ───────────────────────── Единицы и общие числа ─────────────────────────

export const YEAR = DAYS_PER_SEASON * 4;        // 100 дней, как везде в игре

// Потолок сдвига одного сословия за сутки. Собственный дрейф сословий к 50 в
// politics.js — ±0.05/сут, то есть наш предел в семь раз сильнее дрейфа: связь
// умеет перебороть возврат к равнодушию, но не умеет обрушить сословие за день.
export const ESTATE_STEP_CAP = 0.35;

// Потолок дневной потери стабильности от всей связи. dynasty.js уже снимает до
// 0.3 за законность, до 0.3 за двух претендентов и 1.2 за междуцарствие; ещё
// −0.8 сверху — это предел, за которым партию было бы не вытянуть ничем.
export const STAB_FLOOR = -0.8;

// ───────────────────────── 1. Законность → сословия ─────────────────────────

export const LEG_PIVOT = 50;      // точка равнодушия: ровно здесь связь молчит
export const LEG_HOLY = 60;       // выше — жрецы венчают власть охотно
export const LEG_USURP = 30;      // ниже — на троне «узурпатор», и это говорят вслух

// Дневной сдвиг одобрения на ПОЛНОМ размахе законности (0 или 100).
//
// Почему у знати цифра на порядок больше, чем у простолюдин. Знать сама живёт
// правом рода: её земли, титулы и суд стоят на том же основании, что и трон.
// Шаткая законность для боярина — это вопрос, чьи у него деревни. Простолюдину
// же всё равно, чей прадед первым сел на камень, — он смотрит на хлеб и на то,
// каков правитель нравом, и это учтено ниже, в чертах.
//
// dynasty.js уже даёт знати ±0.04 и войску ±0.02 за законность — это её
// «дворцовый» слой. Здесь второй, общественный. Сумма по знати ±0.16 в сутки
// намеренна и названа здесь прямо, чтобы её нельзя было нарастить по
// недосмотру: при законности 0 знать сползает с 55 до 25 примерно за 190 дней —
// почти два игровых года. Это долго и заметно, а не мгновенно.
export const LEG_ESTATE = {
  nobles: 0.12,
  merchants: 0.03,
  commons: 0.02,
  military: 0.02,
  clergy: 0,        // жрецы считаются отдельно: у них не наклон, а два порога
};

// Жрецы освящают власть. Не наклон, а два порога: крепкую власть венчают
// охотно, узурпатора не венчают вовсе. В середине — молчат: церковь не обязана
// иметь мнение о каждом дне.
export const CLERGY_BLESS = 0.08;     // в сутки при законности 100
export const CLERGY_CURSE = 0.14;     // в сутки при законности 0 — сильнее, чем похвала
// Молодой род жрецы не венчают, даже если законность уже подтянулась: помазание
// требует времени, а не очков. Потолок петли — сам срок.
export const HOUSE_YOUNG_YEARS = 4;
export const CLERGY_YOUNG = 0.06;     // в сутки, пока роду меньше HOUSE_YOUNG_YEARS

// Сытость не бьёт по сословиям здесь (это дело link_survival), но МЕНЯЕТ ВЕС
// законности для простолюдин: голодному нет дела до права рода.
export const FED_DAYS = 6;            // запас еды, при котором народ считается сытым

// ───────────────────────── 2. Черты правителя → сословия ─────────────────────

// Дневные сдвиги одобрения. Здесь НЕ повторяются множители державы (их держит
// politics.js) — здесь только то, как сословия относятся к человеку на троне.
//
// Ключевая пара, ради которой таблица и написана: ЖЕСТОКИЙ гасит смуту (в
// politics.js у него mult.unrest 0.8, а здесь он ещё и тормозит заговор — см.
// CRUEL_PLOT_DAMP), но простолюдины его ненавидят сильнее, чем любят любого
// другого правителя. Жестокость — это заём: тишина сегодня за счёт того, что
// первый же слабый наследник получит взорвавшийся низ.
//
// Ни одна черта не может остаться без строки: тест сверяется с RULER_TRAITS,
// иначе новая черта в politics.js тихо получила бы нулевое отношение общества.
export const TRAIT_ESTATE = {
  warlord: { military: 0.14, commons: -0.03, merchants: -0.03 },
  builder: { nobles: 0.06, commons: 0.03, merchants: -0.02 },
  sage:    { clergy: 0.08, nobles: 0.03, military: -0.03 },
  trader:  { merchants: 0.14, clergy: -0.03, nobles: -0.02 },
  just:    { commons: 0.12, clergy: 0.05, nobles: -0.06 },
  cruel:   { commons: -0.16, nobles: 0.06, military: 0.06, clergy: -0.05 },
  weak:    { nobles: -0.10, military: -0.10, commons: 0.02 },
  beloved: { commons: 0.16, nobles: -0.04 },
};

// ───────────────────────── 3. Двор → общество ─────────────────────────
//
// Золото за двор списывает dynasty.js. Здесь — только то, чего она не видит:
// как содержание двора выглядит СНАРУЖИ дворца.
//
// «По обычаю» (ступень 1) — это норма, и норма не вызывает чувств: при ней
// связь молчит целиком. Роскошь и скупость — вызывают.
export const COURT_LUX = [0, 0, 1];      // ступень двора → «сколько это роскошь»
export const COURT_LUX_COMMONS = 0.18;   // злоба на роскошь при голодном народе
export const COURT_LUX_BASE = 0.35;      // её доля, которую сытый народ всё равно чувствует
export const COURT_LUX_MERCH = 0.10;     // купцы кормят двор: пышность им прибыльна
export const COURT_THIN_CLERGY = 0.06;   // скупой двор не жертвует храмам
export const COURT_UNPAID_CLERGY = 0.08; // двору не заплатили — молебен не оплачен тоже
export const COURT_UNPAID_MERCH = 0.10;  // и поставщикам двора не заплатили

// ───────────────────────── 4. Лестница заговора ─────────────────────────
//
// Ступени: тишина → ропот при дворе → открытый претендент → попытка переворота.
// Каждая ступень предупреждает ЗАРАНЕЕ и словами, и на каждой написано, что
// именно сделать.
export const PLOT_MAX = 100;
export const PLOT_STEP_MAX = 1.6;        // потолок шага в обе стороны за сутки

export const PLOT_LEG = 45;              // выше этой законности заговор не растёт вовсе
export const PLOT_GROW_LEG = 1.0;        // прирост в сутки при законности 0
export const PLOT_ANGRY_NOBLES = 40;     // ниже — знать шепчется
export const PLOT_ANGRY_MIL = 45;        // ниже — войско слушает
export const PLOT_GROW_NOBLES = 0.5;
export const PLOT_GROW_MIL = 0.35;
export const PLOT_GROW_CLAIM = 0.25;     // за каждого открытого претендента
export const PLOT_GROW_INTER = 0.8;      // пустой трон — лучшее время для заговора

// Спад. СТРОГО БОЛЬШЕ предельного шага роста — это и есть гарантия выхода:
// выправив законность и сословия, игрок гасит заговор быстрее, чем тот копился.
export const PLOT_CALM = 1.9;
export const PLOT_CALM_LEG = 70;         // с этой законности заговор тает сам
export const PLOT_CALM_ESTATES = 60;     // и с этого довольства знати и войска

// Жестокий тормозит заговор: доносчики работают. Не запрещает — тормозит.
export const CRUEL_PLOT_DAMP = 0.45;
// Любимец толпы и справедливый добавляют спада: заговорщикам не на кого опереться.
export const KIND_PLOT_CALM = 0.35;
// Слабовольный ускоряет: при нём пробуют то, чего не пробовали бы.
export const WEAK_PLOT_PUSH = 1.35;

export const STAGE_MURMUR = 30, STAGE_MURMUR_CLEAR = 20;
export const STAGE_PRETENDER = 60, STAGE_PRETENDER_CLEAR = 45;
export const STAGE_COUP = 88, STAGE_COUP_CLEAR = 70;
export const STAGE_RU = ['тихо', 'ропот при дворе', 'открытый претендент', 'заговор созрел'];

// Цена ступени в стабильности за сутки. Это НЕ цена претендента (её берёт
// dynasty.js) — это цена того, что во дворце шепчутся и все это знают.
export const STAGE_STAB = [0, 0.12, 0.30, 0.55];
export const STAGE_HAPPY = [0, 0, -1, -2];      // «хватают за слова»

// Отсчёт до ПОПЫТКИ. Восемь суток — это ровно столько, сколько нужно, чтобы
// успеть: подношение двору даёт +6 законности сразу, пышный двор +0.12 в сутки,
// одна выигранная война +10. Меньше — предупреждение стало бы издевательством.
export const COUP_DAYS = 8;
// Пока законность не ниже этого, заговорщиков выдадут. То же число, что в
// canOverthrow() в dynasty.js (там оно вписано в строку и наружу не выведено):
// ЕСЛИ ТАМ ПОМЕНЯЮТ — ПОМЕНЯТЬ И ЗДЕСЬ, иначе связь пообещает переворот, а
// модель откажется его делать, и игрок увидит пустую угрозу.
export const COUP_BLOCK_LEG = 75;
export const COUP_CD = 120;              // тишина после переворота или сорванного заговора

// ПОЧЕМУ ПОПЫТКА И ПЕРЕВОРОТ — РАЗНЫЕ ВЕЩИ. Смену рода делает только модель,
// dynasty.overthrow(), и у неё СВОЙ замок: canOverthrow() отказывает, если
// законность ≥ 75, если знать или войско не пойдут, если стабильности меньше
// цены переворота. Если бы связь обещала переворот, а модель молча отказывала,
// игрок читал бы в журнале угрозу, которая никогда не сбывается, — худший вид
// вранья в игре. Поэтому третья ступень называется ПОПЫТКОЙ: она наступает,
// если дать заговору созреть, а вот УДАЁТСЯ она только тогда, когда модель
// говорит «да». Сорвавшаяся попытка — это кровь при дворе: разовый удар по
// стабильности, обиженные сословия и удар по законности (событие revolt).
export const COUP_FAIL_STAB = 8;         // разовая цена сорвавшегося заговора
export const COUP_FAIL_ESTATE = { nobles: -3, military: -2, commons: -1, clergy: -1, merchants: 0 };

// Как часто связь повторяет одно и то же вслух. Каждый день бубнить нельзя:
// журнал перестают читать, и тогда предупреждение не спасает.
export const SAY_CD = 15;
export const SAY_URGENT = 3;             // за столько дней до попытки говорим каждые сутки

// ───────────────────────── 5. Пресечение рода → города ─────────────────────
//
// Стабильность за междуцарствие снимает dynasty.js. Города — не её дело и не
// наше: сепаратизм считает link_territory.js. Мы подаём ему ОДНО число —
// добавку к смуте каждого города — и ни один город не трогаем сами.
export const INTER_UNREST = 0.5;         // в сутки, пока трон пуст
export const PLOT_UNREST = 0.2;          // в сутки, пока заговор созрел
export const INTER_ESTATE = { nobles: -0.25, clergy: -0.15, merchants: -0.20, commons: -0.15, military: -0.20 };

// ───────────────────────── 6. Сословия ограничивают род ─────────────────────
//
// «Сильные сословия ограничивают власть рода»: при очень довольной знати
// правитель не может назначить наследника мимо старшинства. Это не запрет ради
// запрета — это цена, которую платит игрок, покупавший знать: купленная знать
// становится силой, и сила эта своевольна.
//
// Выход прямой и назван словами: дождаться, пока одобрение знати опустится ниже
// порога, или опустить его самому (скупой двор, справедливые законы).
export const NOBLE_VETO = 70;

// ───────────────────────── 7. Обратно: память → законность ─────────────────
//
// Порода шрама link_memory → порода удара по законности в dynasty.js.
// frost (стужа) и betrayal (предательство соседа) сюда не попадают намеренно:
// погода не отнимает права на трон, а чужая подлость — не наша вина.
export const SCAR_TO_LEG = {
  shame: 'city_lost',
  triumph: 'triumph',
  famine: 'famine',
  plague: 'plague',
};
export const SEEN_KEEP = YEAR;           // сколько помним, что событие уже отдано роду
export const DYN_EVENTS_CAP = 8;         // не больше стольких ударов за сутки

// ═══════════════════════════ ПАМЯТЬ СВЯЗИ ═══════════════════════════

export function createDynastyLink() {
  return {
    v: 1,
    day: -1,          // защита от двойного применения в одни сутки
    plot: 0,          // 0…100 — насколько созрел заговор
    stage: 0,         // 0…3, с гистерезисом (см. stageOf)
    coupDays: 0,      // сколько суток идёт отсчёт до попытки
    coupCd: 0,        // тишина после переворота
    seen: [],         // [{key, day}] — какие шрамы уже отданы роду
    lastSaid: {},     // ключ рассказа → день, чтобы не бубнить
  };
}

// Восстановление обязано пережить и битый файл, и файл прошлой версии: сейв
// старой партии просто не содержит поля dynLink, и это не повод падать.
export function restoreDynastyLink(data) {
  const L = createDynastyLink();
  if (!data || typeof data !== 'object') return L;
  L.day = num(data.day, -1);
  L.plot = clamp(num(data.plot, 0), 0, PLOT_MAX);
  L.stage = clampInt(num(data.stage, 0), 0, 3);
  L.coupDays = Math.max(0, Math.round(num(data.coupDays, 0)));
  L.coupCd = Math.max(0, Math.round(num(data.coupCd, 0)));
  if (Array.isArray(data.seen)) {
    L.seen = data.seen
      .filter(s => s && typeof s === 'object' && typeof s.key === 'string')
      .map(s => ({ key: s.key, day: num(s.day, 0) }))
      .slice(-60);
  }
  if (data.lastSaid && typeof data.lastSaid === 'object') {
    for (const [k, v] of Object.entries(data.lastSaid)) {
      if (Number.isFinite(v)) L.lastSaid[k] = v;
    }
  }
  return L;
}

export function serializeDynastyLink(state) {
  return state ? JSON.parse(JSON.stringify(state)) : null;
}

// ═══════════════════════════ ЧТЕНИЕ МИРА ═══════════════════════════
//
// Единственное место, где ядро переводится на язык этой связи. Всё остальное
// считает по этому снимку и в sim не заглядывает — так связь можно проверять
// на подделке из десяти полей.

export function dynastyLinkState(sim) {
  const s = sim || {};
  const day = Math.max(0, Math.round(num(s.day, 0)));
  const pol = (s.politics && s.politics.state) || null;
  const dyn = s.dynasty || null;

  const pop = aliveCount(s);
  const food = Math.max(0, num(s.res && s.res.food, 0));
  // Запас в днях — та же мера, что в link_survival и link_memory. Три разные
  // оценки сытости означали бы три разных числа в трёх панелях.
  const foodDays = pop > 0 ? food / (pop * 0.7) : 99;

  const factions = {};
  for (const fid of Object.keys(SOCIAL_FACTIONS)) {
    factions[fid] = pol && pol.factions ? clamp(num(pol.factions[fid], 50), 0, 100) : 50;
  }

  // Черты берём у правителя ЯДРА: politics.state.ruler — единственное место,
  // откуда игра берёт множители, и род кладёт своего главу именно туда. Если
  // ядра нет (подделка в тесте), спрашиваем род напрямую.
  let traits = [];
  if (pol && pol.ruler && Array.isArray(pol.ruler.traits)) traits = pol.ruler.traits.slice();
  else if (dyn) {
    const rl = safeRuler(dyn);
    if (rl && Array.isArray(rl.traits)) traits = rl.traits.slice();
  }
  traits = traits.filter(t => TRAIT_ESTATE[t]);

  const hasDyn = !!(dyn && typeof dyn === 'object');
  return {
    day, pop, foodDays,
    hasDyn,
    fam: hasDyn ? str(dyn.fam, '—') : '—',
    // Без рода законность равна точке равнодушия: связь молчит и не мешает.
    legitimacy: hasDyn ? clamp(num(dyn.legitimacy, LEG_PIVOT), 0, 100) : LEG_PIVOT,
    court: hasDyn ? clampInt(num(dyn.court, 1), 0, COURT_LUX.length - 1) : 1,
    claimants: hasDyn && Array.isArray(dyn.claimants) ? dyn.claimants.slice(0, 4) : [],
    interregnum: hasDyn ? Math.max(0, num(dyn.interregnum, 0)) : 0,
    houseYears: hasDyn ? Math.max(0, (day - num(dyn.foundedDay, day)) / YEAR) : 99,
    coups: hasDyn && dyn.stats ? Math.max(0, num(dyn.stats.coups, 0)) : 0,
    gov: pol ? str(pol.gov, 'chiefdom') : 'chiefdom',
    stability: pol ? clamp(num(pol.stability, 60), 0, 100) : 60,
    factions, traits,
    // Отчёт рода за прошлые сутки: оттуда узнаём, потянула ли казна двор.
    courtUnpaid: !!(s.sys && s.sys.dynastyReport && s.sys.dynastyReport.flags
      && s.sys.dynastyReport.flags.courtUnpaid),
    scars: readFreshScars(s, day),
  };
}

// Свежие шрамы памяти за эти сутки. Мы НЕ разбираем текст летописи и не считаем
// беды во второй раз: link_memory уже свёл повторы одной беды в пределах сезона
// в один шрам с одним днём — значит «порода@день» неповторим по построению.
function readFreshScars(sim, day) {
  const mem = sim && sim.linkMemory;
  if (!mem || !Array.isArray(mem.scars)) return [];
  const out = [];
  for (const sc of mem.scars) {
    if (!sc || !SCAR_TO_LEG[sc.kind]) continue;
    // Окно в сутки, а не «ровно сегодня»: связь ходит последней в дне, но при
    // отладке порядок может сбиться, и потерянное событие уже не вернётся.
    if (day - num(sc.day, -999) > 1) continue;
    out.push({ kind: sc.kind, day: num(sc.day, day), w: Math.max(0, num(sc.w, 0)) });
  }
  return out;
}

// «Сытость народа» как множитель веса законности для простолюдин: голодному
// нет дела до права рода. 0 — впроголодь, 1 — сыты.
export function fedShare(st) { return clamp(st.foodDays / FED_DAYS, 0, 1); }

// ═══════════════════════════ СЧЁТ ЧАСТЕЙ ═══════════════════════════

// --- законность → сословия ---
export function legitimacyEstates(st) {
  const out = zeroEstates();
  const rows = [];
  const swing = (st.legitimacy - LEG_PIVOT) / LEG_PIVOT;   // −1…+1
  const fed = fedShare(st);

  for (const [fid, k] of Object.entries(LEG_ESTATE)) {
    if (!k) continue;
    // Простолюдин смотрит на право рода только на сытый желудок.
    const w = fid === 'commons' ? k * fed : k;
    const d = swing * w;
    if (Math.abs(d) < 0.001) continue;
    out[fid] += d;
    rows.push({ fid, v: d, ru: legReasonFor(fid, st.legitimacy, d) });
  }

  // Жрецы: два порога вместо наклона.
  let cl = 0;
  if (st.legitimacy >= LEG_HOLY) {
    cl += CLERGY_BLESS * ((st.legitimacy - LEG_HOLY) / (100 - LEG_HOLY));
  } else if (st.legitimacy <= LEG_USURP) {
    cl -= CLERGY_CURSE * ((LEG_USURP - st.legitimacy) / LEG_USURP);
  }
  if (st.houseYears < HOUSE_YOUNG_YEARS && st.coups > 0) {
    // Помазание требует времени, а не очков. Потолок петли — сам срок: через
    // HOUSE_YOUNG_YEARS лет это слагаемое исчезает само, что бы игрок ни делал.
    cl -= CLERGY_YOUNG;
    rows.push({
      fid: 'clergy', v: -CLERGY_YOUNG,
      ru: `Род ${st.fam} на троне всего ${st.houseYears.toFixed(1)} г.: жрецы не спешат венчать узурпатора (пройдёт само через ${(HOUSE_YOUNG_YEARS - st.houseYears).toFixed(1)} г.)`,
    });
  }
  if (Math.abs(cl) >= 0.001) {
    out.clergy += cl;
    rows.push({
      fid: 'clergy', v: cl,
      ru: cl > 0
        ? `Законность ${Math.round(st.legitimacy)}: жрецы освящают власть рода ${st.fam}`
        : `Законность ${Math.round(st.legitimacy)}: жрецы не признают власть законной`,
    });
  }
  return { estates: out, rows };
}

function legReasonFor(fid, leg, d) {
  const ru = SOCIAL_FACTIONS[fid] ? SOCIAL_FACTIONS[fid].ru : fid;
  if (fid === 'nobles') {
    return d > 0
      ? `Законность ${Math.round(leg)}: знать держится за право рода — её земли стоят на нём же`
      : `Законность ${Math.round(leg)}: знать не уверена, чьи у неё деревни`;
  }
  return d > 0 ? `Законность ${Math.round(leg)}: ${ru} за трон` : `Законность ${Math.round(leg)}: ${ru} отворачиваются от трона`;
}

// --- черты правителя → сословия ---
export function traitEstates(st) {
  const out = zeroEstates();
  const rows = [];
  for (const t of st.traits) {
    const tab = TRAIT_ESTATE[t];
    if (!tab) continue;
    const ru = traitRu(t);
    for (const [fid, v] of Object.entries(tab)) {
      if (out[fid] === undefined) continue;
      out[fid] += v;
      rows.push({ fid, v, ru: `${ru} на троне: ${SOCIAL_FACTIONS[fid].ru} ${v > 0 ? 'за' : 'против'}` });
    }
  }
  return { estates: out, rows };
}

// --- двор глазами державы ---
export function courtEstates(st) {
  const out = zeroEstates();
  const rows = [];
  const lux = COURT_LUX[st.court] || 0;
  const want = 1 - fedShare(st);        // 0 сыты, 1 впроголодь

  if (lux > 0) {
    // Роскошь злит даже сытых, но голодных — вчетверо сильнее. Это не второй
    // удар голода (его наносит link_survival), а его УСИЛИТЕЛЬ: одна и та же
    // пышность читается по-разному из-за полного и из-за пустого стола.
    const d = -COURT_LUX_COMMONS * lux * (COURT_LUX_BASE + (1 - COURT_LUX_BASE) * want);
    out.commons += d;
    rows.push({
      fid: 'commons', v: d,
      ru: want > 0.5
        ? 'Пышный двор при пустых амбарах: простолюдины считают чужое серебро'
        : 'Пышный двор: простолюдины видят роскошь',
    });
    out.merchants += COURT_LUX_MERCH * lux;
    rows.push({ fid: 'merchants', v: COURT_LUX_MERCH * lux, ru: 'Двор закупает у купцов: пышность им прибыльна' });
  }
  if (st.court === 0) {
    out.clergy -= COURT_THIN_CLERGY;
    rows.push({ fid: 'clergy', v: -COURT_THIN_CLERGY, ru: 'Скупой двор не жертвует храмам' });
  }
  if (st.courtUnpaid) {
    // Казна не потянула двор. Законность за это снимает dynasty.js; здесь —
    // те, кому конкретно не заплатили.
    out.clergy -= COURT_UNPAID_CLERGY;
    out.merchants -= COURT_UNPAID_MERCH;
    rows.push({ fid: 'clergy', v: -COURT_UNPAID_CLERGY, ru: 'Двору нечем платить: молебны не оплачены' });
    rows.push({ fid: 'merchants', v: -COURT_UNPAID_MERCH, ru: 'Двору нечем платить: поставщики двора в убытке' });
  }
  return { estates: out, rows };
}

// ═══════════════════════════ ЛЕСТНИЦА ЗАГОВОРА ═══════════════════════════

// Дневное движение заговора. Возвращает {d, grow, calm, rows} — разбор, а не
// одно число: игрок должен видеть, ЧТО именно копит смуту и что её гасит.
export function plotDelta(st) {
  const rows = [];
  let grow = 0;

  if (st.legitimacy < PLOT_LEG) {
    const v = PLOT_GROW_LEG * ((PLOT_LEG - st.legitimacy) / PLOT_LEG);
    grow += v;
    rows.push({ v, ru: `Законность ${Math.round(st.legitimacy)} ниже ${PLOT_LEG}: при дворе считают дни рода ${st.fam}` });
  }
  if (st.factions.nobles < PLOT_ANGRY_NOBLES) {
    const v = PLOT_GROW_NOBLES * ((PLOT_ANGRY_NOBLES - st.factions.nobles) / PLOT_ANGRY_NOBLES);
    grow += v;
    rows.push({ v, ru: `Знать обижена (${Math.round(st.factions.nobles)}): у заговора есть деньги` });
  }
  if (st.factions.military < PLOT_ANGRY_MIL) {
    const v = PLOT_GROW_MIL * ((PLOT_ANGRY_MIL - st.factions.military) / PLOT_ANGRY_MIL);
    grow += v;
    rows.push({ v, ru: `Войско недовольно (${Math.round(st.factions.military)}): у заговора есть мечи` });
  }
  if (st.claimants.length) {
    const v = PLOT_GROW_CLAIM * st.claimants.length;
    grow += v;
    rows.push({ v, ru: `Открытых претендентов: ${st.claimants.length} — заговору есть кого сажать на трон` });
  }
  if (st.interregnum > 0) {
    grow += PLOT_GROW_INTER;
    rows.push({ v: PLOT_GROW_INTER, ru: 'Трон пуст: лучшего часа для заговора не будет' });
  }

  // Черты правителя. Жестокий не запрещает заговор, а тормозит его: доносчики
  // работают. Слабовольный, наоборот, приглашает попробовать.
  if (st.traits.includes('cruel')) {
    grow *= CRUEL_PLOT_DAMP;
    rows.push({ v: 0, ru: 'Правитель жесток: доносчики работают, заговор зреет вдвое медленнее' });
  }
  if (st.traits.includes('weak')) {
    grow *= WEAK_PLOT_PUSH;
    rows.push({ v: 0, ru: 'Правитель слабоволен: пробуют то, чего не пробовали бы' });
  }

  // Спад. Считается отдельно от роста и НЕ гасится чертами: даже при
  // слабовольном правителе выправленное положение разгоняет заговорщиков.
  let calm = 0;
  const legCalm = clamp((st.legitimacy - PLOT_LEG) / (PLOT_CALM_LEG - PLOT_LEG), 0, 1);
  const estCalm = clamp((Math.min(st.factions.nobles, st.factions.military) - PLOT_ANGRY_NOBLES)
    / (PLOT_CALM_ESTATES - PLOT_ANGRY_NOBLES), 0, 1);
  if (st.interregnum <= 0) {
    calm = PLOT_CALM * Math.min(legCalm, estCalm);
    if (calm > 0.01) {
      rows.push({ v: -calm, ru: `Законность ${Math.round(st.legitimacy)} и довольные сословия: заговор рассыпается` });
    }
    if (st.traits.includes('beloved') || st.traits.includes('just')) {
      calm += KIND_PLOT_CALM;
      rows.push({ v: -KIND_PLOT_CALM, ru: 'Правителя любят: заговорщикам не на кого опереться' });
    }
  }

  // Потолок шага в обе стороны. Без него один чёрный день (пустой трон плюс
  // два претендента плюс обиженные сословия) поднимал бы заговор на 3.15 за
  // сутки, и от первой ступени до переворота проходило бы меньше месяца —
  // игрок не успевал бы даже прочитать предупреждение.
  const d = clamp(grow - calm, -PLOT_STEP_MAX, PLOT_STEP_MAX);
  return { d, grow, calm, rows };
}

// Ступень с гистерезисом: порог входа выше порога выхода. Иначе у самой границы
// игрок читал бы «претендент явился / претендент ушёл» через день.
export function stageOf(plot, prevStage) {
  const p = prevStage | 0;
  if (p >= 3) return plot < STAGE_COUP_CLEAR ? 2 : 3;
  if (p === 2) return plot >= STAGE_COUP ? 3 : (plot < STAGE_PRETENDER_CLEAR ? 1 : 2);
  if (p === 1) return plot >= STAGE_PRETENDER ? 2 : (plot < STAGE_MURMUR_CLEAR ? 0 : 1);
  return plot >= STAGE_MURMUR ? 1 : 0;
}

// Может ли заговор ДОБИТЬСЯ СВОЕГО. Два независимых замка, и оба названы
// словами: наш собственный (законность) и замок самой модели рода.
//
// ЭТО И ЕСТЬ ВТОРОЙ ВЫХОД. Переворот не бывает неизбежным: пока законность ≥
// COUP_BLOCK_LEG, попытка проваливается, сколько бы ни созрел заговор. Первый
// выход — погасить сам заговор (PLOT_CALM > PLOT_STEP_MAX, см. шапку файла).
export function coupGate(sim, st) {
  if (st.legitimacy >= COUP_BLOCK_LEG) {
    return { ok: false, reason: `Законность рода ${st.fam} ${Math.round(st.legitimacy)} — заговорщиков выдадут прежде, чем они соберутся` };
  }
  // Спрашиваем модель рода её же вопросом: если она откажется делать переворот,
  // связь не имеет права его обещать. Обёрнуто в try — модель пишется рядом,
  // и её отказ отвечать не должен ронять партию.
  if (sim && sim.dynasty && typeof DYN.canOverthrow === 'function') {
    try {
      const chk = DYN.canOverthrow(sim.dynasty, {
        day: st.day, gov: st.gov, pop: st.pop, stability: st.stability,
        nobles: st.factions.nobles, military: st.factions.military,
      }, {});
      if (chk && chk.ok === false) return { ok: false, reason: chk.reason || 'Заговору не на кого опереться' };
    } catch (e) { /* модель ещё не готова — считаем замок открытым */ }
  }
  return { ok: true, reason: '' };
}

// Что делать игроку прямо сейчас. Не «−0.4 стабильности», а поступок.
function wayOut(st, gate) {
  const parts = [];
  if (!gate.ok) parts.push(`${gate.reason} — попытка сорвётся сама, если так и останется`);
  if (st.legitimacy < COUP_BLOCK_LEG) {
    parts.push(`поднять законность до ${COUP_BLOCK_LEG} (подношение двору, пышный двор, победа в войне)`);
  }
  if (st.factions.nobles < PLOT_ANGRY_NOBLES) parts.push(`задобрить знать (одобрение ${Math.round(st.factions.nobles)}, нужно ${PLOT_ANGRY_NOBLES})`);
  if (st.factions.military < PLOT_ANGRY_MIL) parts.push(`задобрить войско (одобрение ${Math.round(st.factions.military)}, нужно ${PLOT_ANGRY_MIL})`);
  if (st.interregnum > 0) parts.push('посадить кого-нибудь на трон: пустой трон кормит заговор сильнее всего');
  if (!parts.length) parts.push('держать законность и сословия там, где они есть, — заговор тает сам');
  return parts.join('; ');
}

// ═══════════════════════════ ГЛАВНАЯ ФУНКЦИЯ ═══════════════════════════

// Читает sim, НИЧЕГО в нём не меняет, возвращает отчёт. Применяет отчёт
// integrate.js — точные строки в блоке ПОДКЛЮЧЕНИЕ в конце файла.
export function dynastyLinks(sim) {
  const st = dynastyLinkState(sim);
  const prev = (sim && sim.linkDynasty) ? sim.linkDynasty : createDynastyLink();
  const L = {
    ...createDynastyLink(),
    ...prev,
    seen: Array.isArray(prev.seen) ? prev.seen.slice() : [],
    lastSaid: { ...(prev.lastSaid || {}) },
  };

  const out = {
    mods: {
      stability: 0,          // дневная тяга
      stabilityShock: 0,     // разовый удар (сорвавшийся заговор), применяется тем же слагаемым
      happy: 0,
      estates: zeroEstates(),        // дневная тяга; ограничена ESTATE_STEP_CAP
      // Разовые сдвиги сословий держатся ОТДЕЛЬНО от дневных. Иначе удар в −3
      // за сорвавшийся заговор попал бы под дневной потолок ±0.35 и превратился
      // бы в ничто — тихая ошибка: событие есть, последствия нет.
      estatesShock: zeroEstates(),
      cityUnrestAll: 0,      // сигнал link_territory: добавка к смуте каждого города
    },
    reasons: { estates: [], plot: [], stability: [], other: [] },
    events: [],
    flags: {
      memory: L,
      plot: 0, stage: 0, stageRu: STAGE_RU[0],
      coupDays: 0, coupIn: null, coupNow: null, coupBlocked: '', coupFailed: '',
      wayOut: '', legitimacy: st.legitimacy, fam: st.fam,
      heirLock: false, heirLockReason: '',
      dynEvents: [],
    },
  };

  // ОДИН ДЕНЬ СЧИТАЕТСЯ ОДИН РАЗ. Повторный вызов в те же сутки не двигает
  // заговор, не выдаёт событий и не отдаёт роду ни одного удара по законности
  // второй раз. Поправки при этом возвращаются те же — панель, дёрнувшая
  // связь среди дня, обязана увидеть сегодняшние числа, а не ноль.
  const sameDay = L.day === st.day;

  // Без рода связь молчит целиком: ни поправок, ни событий. Так старый сейв и
  // ещё не подключённая модель не портят ничего.
  if (!st.hasDyn) {
    if (!sameDay) L.day = st.day;
    return out;
  }

  // ── 1..3. Сословия: законность, черты, двор ──────────────────────────────
  const legPart = legitimacyEstates(st);
  const traitPart = traitEstates(st);
  const courtPart = courtEstates(st);
  for (const fid of Object.keys(out.mods.estates)) {
    out.mods.estates[fid] = legPart.estates[fid] + traitPart.estates[fid] + courtPart.estates[fid];
  }
  out.reasons.estates.push(...legPart.rows, ...traitPart.rows, ...courtPart.rows);

  // ── 5. Пресечение рода: сигнал городам и паника сословий ─────────────────
  if (st.interregnum > 0) {
    for (const [fid, v] of Object.entries(INTER_ESTATE)) out.mods.estates[fid] += v;
    out.mods.cityUnrestAll += INTER_UNREST;
    out.reasons.other.push({
      ru: `Междуцарствие: трон пуст ещё ${Math.ceil(st.interregnum)} дн. Города смотрят в сторону: смута +${INTER_UNREST} в сутки каждому`,
      v: INTER_UNREST,
    });
  }

  // ── 4. Лестница заговора ─────────────────────────────────────────────────
  const step = plotDelta(st);
  if (!sameDay) {
    L.day = st.day;
    L.coupCd = Math.max(0, L.coupCd - 1);
    // Пока идёт тишина после переворота, заговор не копится вовсе: два
    // переворота подряд — это партия, в которой власть перестала существовать.
    L.plot = L.coupCd > 0 ? Math.max(0, L.plot - PLOT_CALM) : clamp(L.plot + step.d, 0, PLOT_MAX);
  }
  const stage = stageOf(L.plot, L.stage);
  const prevStage = L.stage;
  if (!sameDay) L.stage = stage;

  out.reasons.plot.push(...step.rows.map(r => ({ ru: r.ru, v: round2(r.v) })));
  out.flags.plot = round1(L.plot);
  out.flags.stage = stage;
  out.flags.stageRu = STAGE_RU[stage];

  const gate = coupGate(sim, st);
  out.flags.coupBlocked = gate.ok ? '' : gate.reason;
  const escape = wayOut(st, gate);
  out.flags.wayOut = escape;

  if (stage > 0) {
    out.mods.stability -= STAGE_STAB[stage];
    out.mods.happy += STAGE_HAPPY[stage];
    out.reasons.stability.push({
      ru: `Заговор: ${STAGE_RU[stage]} (${Math.round(L.plot)}/100)`,
      v: -STAGE_STAB[stage],
    });
    // ПРИЧИНА НАЗВАНА СЛОВАМИ, и вместе с ней — способ выйти. Каждый день,
    // пока лестница не на нуле: игрок не обязан помнить прошлое предупреждение.
    out.reasons.other.push({ ru: `Как погасить заговор: ${escape}`, v: 0 });
  }
  if (stage >= 3) {
    out.mods.cityUnrestAll += PLOT_UNREST;
  }

  // ── Отсчёт до попытки переворота ─────────────────────────────────────────
  // Отсчёт идёт от самой ступени, а не от замка: игрок обязан видеть срок
  // ЗАРАНЕЕ, даже если сегодня замок закрыт. Иначе крепкая законность прятала
  // бы часы, а потерянный город открывал бы их без предупреждения.
  if (!sameDay) {
    if (stage >= 3 && L.coupCd <= 0) L.coupDays++;
    else L.coupDays = 0;
  }
  out.flags.coupDays = L.coupDays;
  if (stage >= 3 && L.coupCd <= 0) out.flags.coupIn = Math.max(0, COUP_DAYS - L.coupDays);

  if (!sameDay && L.coupDays >= COUP_DAYS) {
    const cl = st.claimants[0] || null;
    if (gate.ok) {
      // Заговор удался. СМЕНУ РОДА ДЕЛАЕТ dynasty.overthrow() — связь только
      // называет час и претендента: сажать людей на трон не её дело.
      out.flags.coupNow = { claimant: cl ? 0 : null, name: cl ? cl.name : null, fam: cl ? cl.fam : null };
      out.events.push({
        text: cl
          ? `⚔ ЗАГОВОР УДАРИЛ. ${cl.name} из рода ${cl.fam} идёт на дворец: род ${st.fam} не удержал власть.`
          : `⚔ ЗАГОВОР УДАРИЛ. Дворец взят: род ${st.fam} низложен.`,
        type: 'bad', cause: 'coup',
      });
    } else {
      // Попытка сорвалась — и сказано, ЧЕМ именно её сорвало. Это не «повезло»,
      // это следствие того, что игрок делал последние недели.
      out.flags.coupFailed = gate.reason;
      out.mods.stabilityShock -= COUP_FAIL_STAB;
      for (const [fid, v] of Object.entries(COUP_FAIL_ESTATE)) out.mods.estatesShock[fid] += v;
      // Кровь при дворе — удар по праву рода. Ровно один, событием, а не
      // состоянием: тянуть его каждые сутки означало бы обнулить законность.
      out.flags.dynEvents.push({ kind: 'revolt', scale: 1, key: `coup_fail@${st.day}` });
      out.events.push({
        text: `Заговор сорван: ${gate.reason}. Дворец в крови, стабильность −${COUP_FAIL_STAB}, но род ${st.fam} на троне.`,
        type: 'warn', cause: 'coup',
      });
    }
    // Тишина после попытки. Она длиннее, чем нужно роду, чтобы отыграть
    // потерянную законность собственным дрейфом (+0.06/сут × 120 ≈ +7 против
    // −10 за revolt), — то есть сорвавшийся заговор не запускает вторую волну
    // сам собой. Это потолок петли «заговор → кровь → заговор».
    L.plot = 0;
    L.stage = 0;
    L.coupDays = 0;
    L.coupCd = COUP_CD;
  } else if (!sameDay) {
    sayLadder(L, st, stage, prevStage, out, escape);
  }

  // ── 6. Знать связывает роду руки ─────────────────────────────────────────
  const veto = heirVeto(st);
  out.flags.heirLock = !veto.free;
  out.flags.heirLockReason = veto.reason;
  if (!veto.free) out.reasons.other.push({ ru: veto.reason, v: 0 });

  // ── 7. Обратно: свежие шрамы памяти → удары по законности ────────────────
  if (!sameDay) {
    L.seen = L.seen.filter(s => st.day - s.day <= SEEN_KEEP);
    for (const sc of st.scars) {
      const key = `${sc.kind}@${sc.day}`;
      if (L.seen.some(s => s.key === key)) continue;
      if (out.flags.dynEvents.length >= DYN_EVENTS_CAP) break;
      L.seen.push({ key, day: st.day });
      const base = SCAR_KIND[sc.kind] ? SCAR_KIND[sc.kind].weight : 0.5;
      // Тяжесть беды передаём долей: одна лютая голодная зима весит вдвое
      // против недорода, и род обязан это почувствовать.
      const scale = clamp(sc.w / (base || 1), 0.5, 2);
      out.flags.dynEvents.push({ kind: SCAR_TO_LEG[sc.kind], scale: round2(scale), key });
    }
    if (L.seen.length > 60) L.seen.splice(0, L.seen.length - 60);
  }

  // Потолок дневной потери стабильности от ВСЕЙ связи.
  if (out.mods.stability < STAB_FLOOR) {
    out.reasons.stability.push({ ru: `Потолок: связь не отнимает больше ${Math.abs(STAB_FLOOR)} стабильности в сутки`, v: 0 });
    out.mods.stability = STAB_FLOOR;
  }
  // Потолок на сословие: связь умеет переломить дрейф, но не обрушить сословие.
  for (const fid of Object.keys(out.mods.estates)) {
    out.mods.estates[fid] = clamp(round2(out.mods.estates[fid]), -ESTATE_STEP_CAP, ESTATE_STEP_CAP);
  }
  out.mods.stability = round2(out.mods.stability);
  out.mods.stabilityShock = round2(out.mods.stabilityShock);
  for (const fid of Object.keys(out.mods.estatesShock)) {
    out.mods.estatesShock[fid] = round2(out.mods.estatesShock[fid]);
  }
  out.flags.memory = L;
  return out;
}

// Слова лестницы. Говорим при смене ступени всегда, дальше — не чаще SAY_CD,
// а в последние SAY_URGENT суток перед попыткой — каждый день.
function sayLadder(L, st, stage, prevStage, out, escape) {
  const urgent = out.flags.coupIn != null && out.flags.coupIn <= SAY_URGENT;
  const key = `stage${stage}`;
  const changed = stage !== prevStage;
  const said = L.lastSaid[key] || -9999;
  if (!changed && !urgent && st.day - said < SAY_CD) return;
  if (stage === 0) {
    if (changed && prevStage > 0) {
      L.lastSaid[key] = st.day;
      out.events.push({ text: `Заговор рассыпался: при дворе снова тихо. Род ${st.fam} удержался.`, type: 'good', cause: 'plot' });
    }
    return;
  }
  L.lastSaid[key] = st.day;
  if (stage === 1) {
    out.events.push({
      text: `Во дворце ропщут о роде ${st.fam} (законность ${Math.round(st.legitimacy)}). Пока это только слова. Как погасить: ${escape}.`,
      type: 'warn', cause: 'plot',
    });
  } else if (stage === 2) {
    const cl = st.claimants[0];
    out.events.push({
      text: cl
        ? `Открытый претендент: ${cl.name} из рода ${cl.fam} говорит о своих правах вслух. Как погасить: ${escape}.`
        : `О правах на трон говорят вслух. Как погасить: ${escape}.`,
      type: 'warn', cause: 'plot',
    });
  } else {
    const inDays = out.flags.coupIn;
    const when = inDays != null
      ? `До попытки переворота ${inDays} ${plural(inDays, 'день', 'дня', 'дней')}.`
      : 'Попытка может случиться со дня на день.';
    out.events.push({
      text: out.flags.coupBlocked
        ? `⚠ ЗАГОВОР СОЗРЕЛ. ${when} Пока она обречена: ${out.flags.coupBlocked}. Не растеряйте это.`
        : `⚠ ЗАГОВОР СОЗРЕЛ. ${when} Отменить: ${escape}.`,
      type: 'bad', cause: 'plot',
    });
  }
}

// ═══════════════════════════ ДЛЯ ЯДРА И ЭКРАНА ═══════════════════════════

// Может ли род назначить наследника мимо старшинства. Довольная знать — это
// сила, а сила своевольна: купив бояр, игрок потерял право распоряжаться троном.
// Ничего не меняет — безопасно звать из рендера и из кнопки.
export function heirVeto(st) {
  const nob = st && st.factions ? st.factions.nobles : 50;
  if (nob < NOBLE_VETO) return { free: true, reason: '' };
  return {
    free: false,
    reason: `Знать сильна (одобрение ${Math.round(nob)} ≥ ${NOBLE_VETO}): наследника мимо старшинства не назначить. Выход: дождаться, пока одобрение знати опустится ниже ${NOBLE_VETO}, или опустить его самому — скупым двором или законами в пользу простолюдин.`,
  };
}

// То же самое, но от sim: этим ответом гасится кнопка «назначить наследника».
export function canNameHeirNow(sim) {
  return heirVeto(dynastyLinkState(sim));
}

// Готовые строки для панели «Род и держава»: что сейчас держит трон и что его
// точит. Связь НЕ двигает — звать из рендера безопасно.
export function dynastyLinkBreakdown(sim) {
  const st = dynastyLinkState(sim);
  const L = (sim && sim.linkDynasty) ? sim.linkDynasty : createDynastyLink();
  if (!st.hasDyn) return { rows: [], text: 'Рода на троне нет.', plot: 0, stage: 0, stageRu: STAGE_RU[0] };

  const stage = stageOf(num(L.plot, 0), num(L.stage, 0));
  const gate = coupGate(sim, st);
  const step = plotDelta(st);
  const legPart = legitimacyEstates(st);
  const traitPart = traitEstates(st);
  const courtPart = courtEstates(st);

  const rows = [];
  for (const fid of Object.keys(SOCIAL_FACTIONS)) {
    const v = legPart.estates[fid] + traitPart.estates[fid] + courtPart.estates[fid];
    if (Math.abs(v) < 0.005) continue;
    rows.push({ fid, ru: SOCIAL_FACTIONS[fid].ru, v: round2(clamp(v, -ESTATE_STEP_CAP, ESTATE_STEP_CAP)) });
  }
  rows.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));

  const parts = [`Законность ${Math.round(st.legitimacy)}`];
  if (stage > 0) parts.push(`заговор: ${STAGE_RU[stage]} (${Math.round(num(L.plot, 0))}/100)`);
  else parts.push('при дворе тихо');
  if (!gate.ok) parts.push(gate.reason);

  return {
    rows,
    plot: round1(num(L.plot, 0)),
    stage, stageRu: STAGE_RU[stage],
    plotRows: step.rows.map(r => ({ ru: r.ru, v: round2(r.v) })),
    coupBlocked: gate.ok ? '' : gate.reason,
    wayOut: wayOut(st, gate),
    text: parts.join('. ') + '.',
  };
}

// Сколько смуты связь просит добавить каждому городу. Читает готовый отчёт —
// второй раз ничего не считает.
export function dynastyUnrestPush(sim) {
  const L = sim && sim.sys && sim.sys.dynastyLink;
  return L ? L.mods.cityUnrestAll : 0;
}

// ═══════════════════════════ МЕЛОЧИ ═══════════════════════════

function traitRu(id) {
  const t = RULER_TRAITS.find(x => x.id === id);
  return t ? t.ru : id;
}

function safeRuler(dyn) {
  if (!dyn || !Array.isArray(dyn.members)) return null;
  return dyn.members.find(m => m && m.id === dyn.rulerId) || null;
}

function zeroEstates() {
  const o = {};
  for (const fid of Object.keys(SOCIAL_FACTIONS)) o[fid] = 0;
  return o;
}

function aliveCount(sim) {
  const list = sim && sim.villagers;
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const v of list) if (!v || v.hp === undefined || v.hp > 0) n++;
  return n;
}

// Своё склонение, а не импорт из population.js: связи незачем тянуть за собой
// модуль жителей ради одной строки.
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function clampInt(v, lo, hi) { const n = Math.round(num(v, lo)); return n < lo ? lo : (n > hi ? hi : n); }
function num(v, def) { return Number.isFinite(v) ? v : def; }
function str(v, def) { return typeof v === 'string' && v ? v : def; }
function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }

/* ПОДКЛЮЧЕНИЕ ─────────────────────────────────────────────────────────────────

Правки ТОЛЬКО в app/src/core/systems/integrate.js. simulation.js трогать не
нужно: всё, что связь отдаёт, применяется в integrate.js.

Каждый якорь проверен `grep -c -F` по integrate.js; число совпадений указано.
Якоря выбраны так, чтобы НЕ пересекаться с якорями dynasty.js (та берёт
'import * as HERD from ...', 'sim.herds = HERD.createHerds();',
'POL.politicsNewDay(sim);', 'pol: POL.politicsSerialize(sim),',
'if (data.pol) POL.politicsRestore(sim, data.pol);' и
'export function mastersPanel(sim) { return MAS.mastersReport(sim); }').
Порядок применения двух блоков любой — они не спорят ни за одну строку.

── 1. ИМПОРТ ──────────────────────────────────────────────────────────────────
Якорь (совпадений: 1):

import * as GH from './link_ghost.js';

ПОСЛЕ него добавить строку:

import * as LDYN from './link_dynasty.js';

── 2. УСТАНОВКА ───────────────────────────────────────────────────────────────
Якорь в installSystems (совпадений: 1):

  sim.linkMemory = MEM.createMemory();

ПОСЛЕ него добавить:

  // Память связи «род → сословия»: насколько созрел заговор, какие удары по
  // законности уже отданы роду, когда последний раз о них говорили.
  sim.linkDynasty = LDYN.createDynastyLink();

── 3. ДЕНЬ ────────────────────────────────────────────────────────────────────
Якорь в systemsNewDay — последняя строка функции (совпадений: 1):

  applyMemoryLinks(sim, harvestScars(sim, { war: warOut, surv: survOut }));

ПОСЛЕ него добавить:

  // Род идёт ПОСЛЕ памяти намеренно: связь берёт удары по законности из уже
  // записанных за эти сутки шрамов, а не разбирает летопись во второй раз.
  // Отсюда суточная задержка: собранное сегодня applyDynasty съест завтра.
  // Она честнее альтернативы — считать беду дважды в один день из двух мест.
  applyDynastyLinks(sim);

── 4. СОХРАНЕНИЕ ──────────────────────────────────────────────────────────────
Якорь в systemsSerialize (совпадений: 1):

    mem: sim.linkMemory || null,

ПОСЛЕ него добавить:

    dynLink: LDYN.serializeDynastyLink(sim.linkDynasty),

Якорь в systemsRestore (совпадений: 1):

  sim.linkMemory = MEM.restoreMemory(data.mem);

ПОСЛЕ него добавить:

  sim.linkDynasty = LDYN.restoreDynastyLink(data.dynLink);

Старый сейв без поля dynLink грузится: restoreDynastyLink(undefined) вернёт
чистую память, заговор начнётся с нуля.

── 5. ПРИМЕНИТЕЛЬ И ЭКРАН ─────────────────────────────────────────────────────
Якорь (совпадений: 1):

export function ghostSeal(sim) { return GH.sealRun(sim); }

ПОСЛЕ него добавить блок целиком:

// ---------- Род и сословия ----------
// Связь ничего не пишет в sim: она возвращает отчёт, а применение — здесь.
function applyDynastyLinks(sim) {
  if (!sim.linkDynasty) sim.linkDynasty = LDYN.createDynastyLink();
  const out = LDYN.dynastyLinks(sim);
  sim.linkDynasty = out.flags.memory;
  sim.sys.dynastyLink = out;

  const pst = sim.politics && sim.politics.state;
  if (pst) {
    // Тяга и разовый удар складываются одним слагаемым — ровно как в
    // applyTerritoryLinks и applySurvivalLinks. Двух разных путей к
    // стабильности быть не должно.
    const dS = out.mods.stability + out.mods.stabilityShock;
    pst.stability = Math.max(0, Math.min(100, pst.stability + dS));
    for (const fid of Object.keys(out.mods.estates)) {
      const d = out.mods.estates[fid] + out.mods.estatesShock[fid];
      if (!d || pst.factions[fid] == null) continue;
      pst.factions[fid] = Math.max(0, Math.min(100, pst.factions[fid] + d));
    }
  }

  // Сепаратизм НЕ считается здесь второй раз: связь подаёт одно число, а
  // потолок смуты остаётся тем же, что в applyTerritoryLinks (12 = UNREST_REVOLT
  // + 2 из empire.js). Иначе у смуты появилось бы два разных потолка.
  if (out.mods.cityUnrestAll && sim.empire) {
    for (const c of sim.empire.state.cities) {
      c.unrest = Math.max(0, Math.min(12, (c.unrest || 0) + out.mods.cityUnrestAll));
    }
  }

  // Разовые удары по законности уходят роду СПИСКОМ, а не состоянием: их
  // съест applyDynasty на следующих сутках и обнулит sim.sys.dynEvents.
  // Ограничение сверху обязательно: если applyDynasty ещё не подключён,
  // список иначе рос бы всю партию и попадал в каждый сейв.
  if (out.flags.dynEvents.length) {
    sim.sys.dynEvents = (sim.sys.dynEvents || []).concat(out.flags.dynEvents).slice(-20);
  }

  // Заговор ударил. Переворот делает МОДЕЛЬ РОДА — связь только называет час.
  // Строка работает лишь после подключения dynasty.js (блок 5 в её файле);
  // до этого проверка typeof молча пропустит её, и партия не сломается.
  if (out.flags.coupNow && sim.dynasty && typeof dynastyOverthrow === 'function') {
    dynastyOverthrow(sim, out.flags.coupNow.claimant);
  }

  for (const e of out.events) {
    sim.addLog(e.text, e.type === 'bad' ? 'bad' : (e.type === 'good' ? 'good' : 'info'));
    if (e.cause === 'coup') sim.addChronicle(e.text);
  }
  if (out.flags.stage >= 3) sim.sfx?.('alarm');
  return out;
}

// Панель «Род и держава»: кто за трон, кто против и как гасить заговор.
export function dynastyLinkPanel(sim) { return LDYN.dynastyLinkBreakdown(sim); }
// Гасит кнопку «назначить наследника», когда знать связала роду руки.
export function dynastyHeirAllowed(sim) { return LDYN.canNameHeirNow(sim); }

ЧЕГО ДЕЛАТЬ НЕЛЬЗЯ:
  · ставить applyDynastyLinks ПЕРЕД applyMemoryLinks. Тогда связь прочтёт
    вчерашние шрамы вместо сегодняшних, и удар по законности придёт через день
    после того, как игрок о нём забыл;
  · применять out.mods.estates и одновременно повторять их в applyDynasty:
    сословия сдвинутся дважды, и знать при законности 0 сгорит за сутки;
  · добавлять cityUnrestAll к городам ещё раз в applyTerritoryLinks: у смуты
    один потолок и одно место применения;
  · кормить sim.sys.dynEvents состояниями («у нас сейчас голод») из других
    мест. Событие — это «сегодня началась беда». Связь берёт их из шрамов
    памяти именно потому, что там повторы уже слиты в один шрам.

────────────────────────────────────────────────────────────────────────────── */
