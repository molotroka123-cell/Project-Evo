// core/systems/link_war.js — СВЯЗИ: бой ↔ дух ↔ военное сословие ↔ казна ↔ армия.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. wire_army.js уже водит отряды по карте, считает бои, дух,
// снабжение и знаменосцев. wire_politics.js уже держит пять сословий и
// стабильность. wire_production.js уже знает, что казна пуста и жалование
// задержано. Между ними не было почти ни одной линии:
//   · отряд мог полечь целиком — военное сословие этого не замечало;
//   · знамя победы вставало на карте — город о нём не узнавал;
//   · война шла третий год — никто не уставал;
//   · жалование не платили десятый день — отряды в поле стояли как ни в чём
//     не бывало, потому что их дух считает только снабжение;
//   · сильная оплаченная армия в мирное время никак не помогала порядку.
// Здесь эти линии проведены — и в обе стороны.
//
// ЧТО ИМЕННО СВЯЗАНО:
//   1. потери и поражения → одобрение военных, горе города (счастье), стабильность;
//   2. победы, взятые города и знамёна → одобрение военных и знати, гордость города;
//   3. длинная война → УСТАЛОСТЬ ОТ ВОЙНЫ: счастье, стабильность, простолюдины.
//      Победы усталость гасят, мир — рассасывает;
//   4. ОБРАТНО: пустая казна (задержка жалования) → падение духа отрядов в поле,
//      дезертирство из отрядов и резерва, армия дерётся хуже;
//   5. ОБРАТНО: сильная и оплаченная армия в мирное время → порядок (стабильность),
//      но военное сословие без походов скучает и медленно злится;
//   6. ВЫХОД ИЗ СПИРАЛИ «нет денег → нет армии → набеги»: разорённая держава с
//      пустой казной и разбежавшимся войском перестаёт быть добычей — соседи
//      откладывают набег (raids.timer). Плюс сами дезертиры снимают с казны
//      своё содержание, и задержка жалования гасится.
//
// ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ. Своей формулы боя, своего снабжения, своих потерь.
// Нет второго удара по одобрению военных за задержку жалования: его уже наносит
// link_economy.js (ARREARS_BITE.military). Нет второго штрафа к стабильности за
// сам факт войны: его уже даёт politics.js (dS -= min(wars,3)*0.4). Нет второго
// «война кормит военных»: politics.js уже двигает их на +0.1 в день войны —
// здесь только зеркало, скука в долгом мире.
//
// ПРАВИЛА. Функция ЧИСТАЯ: читает sim и вчерашний срез, ничего не меняет,
// возвращает поправки и планы. Math.random не вызывается вовсе, sim.rng не
// нужен — все связи детерминированы, поэтому сейв и загрузка дают то же самое.
//
// ПАМЯТЬ. Часть связей по природе своей нуждается во вчерашнем дне (сколько
// бойцов было вчера, сколько дней идёт война). Поэтому вторым аргументом
// приходит срез прошлого дня, а новый срез возвращается в out.memo — хранит и
// сохраняет его слой подключения, как это уже сделано для link_survival.
//
// ПОТОЛКИ И ВЫХОДЫ. Ни одна петля не бездонна: усталость ≤ 100 и тает в мире по
// 1.2 в день, горе и гордость затухают, дневной сдвиг одобрения зажат в
// [-6, +5], стабильность — в [-1.2, +0.6], счастье — в [-10, +6], множитель
// армии — в [0.8, 1.1], скука не тянет военных ниже 35, а передышка от набегов
// даётся не чаще раза в 40 дней. Из любого дна есть ход: победить, замириться,
// распустить отряды.

import { squadsOf, squadSize } from './army.js';
import { clamp } from './economy.js';
import { SOCIAL_FACTIONS, FACTION_HAPPY } from './politics.js';

export const ESTATES = Object.keys(SOCIAL_FACTIONS);   // nobles, clergy, merchants, commons, military

// ───────────────────────── Потери ─────────────────────────

// Полная гибель войска за один день = −6 одобрения военных. Шесть, а не
// двадцать: сословие обижается на потерю, но не отворачивается от власти за
// один бой — иначе первая же неудача выключала бы игрока из войны навсегда.
export const LOSS_MIL_SPAN = 6;
// Войско меньше десяти человек — это ещё не армия. Гибель двоих из двоих не
// должна бить как гибель сорока из сорока, поэтому удар масштабируется.
export const LOSS_SCALE_MEN = 10;
// Горе города за каждого павшего и его потолок. Затухание 12% в день: за две
// недели тишины похороны отходят.
export const GRIEF_PER_MAN = 0.35;
export const GRIEF_MAX = 6;
export const GRIEF_DECAY = 0.12;

// ───────────────────────── Бои ─────────────────────────

// Выигранный бой в поле, проигранный бой, взятый город, поднятое знамя,
// уничтоженный отряд, павший знаменосец. Поражение весит сильнее победы (2.0
// против 1.2): армия помнит разгром дольше, чем удачу, — на этом и держится
// осторожность игрока.
export const WIN_MIL = 1.2, WIN_STAB = 0.15, WIN_PRIDE = 1.5;
export const DEFEAT_MIL = -2.0, DEFEAT_STAB = -0.3, DEFEAT_GRIEF = 1.5;
export const CAPTURE_MIL = 4, CAPTURE_STAB = 0.5, CAPTURE_PRIDE = 4, CAPTURE_NOBLES = 0.5;
export const BANNER_MIL = 0.6, BANNER_PRIDE = 1.5;
export const WIPED_MIL = -2.0, WIPED_STAB = -0.25;
export const BEARER_MIL = -1.0, BEARER_GRIEF = 1;
export const DEFEAT_NOBLES = -0.3;
// Гордость города за победы: копится, затухает на 10% в день, выше 6 не растёт.
export const PRIDE_MAX = 6;
export const PRIDE_DECAY = 0.10;
// Дневные потолки сдвига одобрения военных. Вниз шире, чем вверх: разгром
// заметнее парада.
export const MIL_DAY_UP = 5, MIL_DAY_DOWN = -6;

// ───────────────────────── Усталость от войны ─────────────────────────

// Полшага в день на одной войне: 100 набирается за ~7 месяцев непрерывной
// войны — примерно столько же, сколько в исторических стратегиях держится
// «долгая война». Вторая и третья война ускоряют, но не втрое.
export const WEAR_PER_DAY = 0.5;
export const WEAR_PER_EXTRA_WAR = 0.25;
// Кровь устаёт быстрее календаря: каждый павший добавляет усталости, но не
// больше двух пунктов за день, иначе одно сражение давало бы месяц войны.
export const WEAR_PER_LOSS = 0.08, WEAR_LOSS_MAX = 2;
export const WEAR_PER_DEFEAT = 3;
// Победы — единственный способ воевать долго и не надорваться.
export const WEAR_WIN_RELIEF = 4, WEAR_CAPTURE_RELIEF = 8;
// Мир лечит: 1.2 в день, полное забвение самой тяжёлой войны — за ~3 месяца.
export const WEAR_DECAY = 1.2;
export const WEAR_MAX = 100;
// До этого порога войну терпят молча: короткие войны не должны наказывать.
export const WEAR_ACHE = 35;
// Что даёт полная усталость (100). Счастье −6, стабильность −0.4 в день,
// простолюдины −0.15 в день, военные −0.05: город устаёт втрое быстрее войска.
export const WEAR_HAPPY = -6, WEAR_STAB = -0.4, WEAR_COMMONS = -0.15, WEAR_MIL = -0.05;
// Отметки, на которых игроку говорят словами, что страна устала.
export const WEAR_MARKS = [35, 60, 85];

// ───────────────────────── Жалование, дух, дезертирство ─────────────────────────

// Сколько дней задержки войско терпит, прежде чем начинает разбегаться. Три —
// это «пережили голодную неделю», четыре — «нам не платят».
export const DESERT_AFTER = 4;
// Доля отряда, уходящая за день, и её потолок: 2.5% за каждый день задержки
// сверх третьего, но не больше 12% в день. При 12% отряд тает за неделю —
// быстро, но не мгновенно: игрок успевает распустить войско или найти деньги.
export const DESERT_RATE = 0.025, DESERT_RATE_MAX = 0.12;
// Резерв дома держится вдвое крепче: там семья, стены и котёл.
export const DESERT_HOME_MULT = 0.5;
// Дух: −1.2 за день задержки, не больше −6 в сутки. Регенерация духа в army.js
// +6 в день, значит при задержке в 5 дней дух стоит на месте, а при десяти —
// падает по 6 в день. Это ровно та скорость, при которой игрок видит связь.
export const MORALE_ARREARS = -1.2, MORALE_ARREARS_MAX = -6;
// Вовремя плаченному и уважаемому войску — маленькая прибавка к духу.
export const MORALE_PAID = 1;
// Множитель силы армии: невыплаченное жалование разлагает (до −20%), любовь
// сословия (одобрение выше 60) добавляет до +10%.
export const MULT_ARREARS = -0.02, MULT_ARREARS_MAX = -0.20;
export const MULT_LOVE_MAX = 0.10;
export const MULT_MIN = 0.8, MULT_MAX = 1.1;

// ───────────────────────── Мир: порядок и скука ─────────────────────────

// Сильная оплаченная армия в мирное время держит порядок: до +0.25 стабильности
// в день. Это ответ на вопрос «зачем армия, если не воюешь».
export const ORDER_STAB_MAX = 0.25;
// «Достаточной» считается армия в десятую часть населения, но не меньше шести
// человек: в деревне из двадцати душ шестеро с копьями — это уже гарнизон.
export const ORDER_SHARE = 0.10, ORDER_MIN_MEN = 6;
// Порядок начинают ценить не в первый день мира.
export const ORDER_AFTER = 3;

// Через сорок дней без войны военное сословие начинает скучать; полной силы
// скука достигает ещё через шестьдесят.
export const BORED_AFTER = 40, BORED_RAMP = 60;
export const BORED_RATE = -0.09;
// Ниже 35 скука не тянет: мирная держава не обязана жить под военным бунтом.
// Это и есть потолок петли — из скуки всегда есть выход, и не один: война,
// закон «дружина», или просто смириться с ворчанием.
export const BORED_FLOOR = 35;

// ───────────────────────── Выход из спирали ─────────────────────────

// Условия передышки: казна пуста пятый день, войска почти не осталось.
export const RESPITE_ARREARS = 5;
export const RESPITE_MEN_SHARE = 0.05, RESPITE_MEN_MIN = 2;
// На сколько отодвигается набег и как часто такое вообще бывает.
export const RESPITE_DAYS = 18, RESPITE_CD = 40;

// ───────────────────────── Общие потолки ─────────────────────────

export const STAB_WORST = -1.2, STAB_BEST = 0.6;
export const HAPPY_WORST = -10, HAPPY_BEST = 6;
export const COMMONS_DAY = [-0.3, 0.1];

const r3 = (v) => Math.round(v * 1000) / 1000;
const zeroApproval = () => ({ nobles: 0, clergy: 0, merchants: 0, commons: 0, military: 0 });

// ───────────────────────── Память (срез прошлого дня) ─────────────────────────

export function createWarMemory() {
  return {
    v: 1,
    day: -1,          // день, за который снят срез; -1 = среза ещё нет
    total: 0,         // бойцы: в отрядах на карте + резерв в поселении
    battles: 0,       // счётчик боёв armyState (для контроля)
    ordered: 0,       // сколько человек МЫ вчера отправили дезертировать
    warDays: 0, peaceDays: 0,
    weariness: 0,
    grief: 0, pride: 0,
    respiteDay: -999,
    wearMark: 0,      // последняя названная игроку отметка усталости
    boredSaid: -999, orderSaid: -999,
  };
}

export function restoreWarMemory(data) {
  const M = createWarMemory();
  if (!data || typeof data !== 'object') return M;
  const n = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  M.day = n(data.day, -1);
  M.total = Math.max(0, n(data.total, 0));
  M.battles = Math.max(0, n(data.battles, 0));
  M.ordered = Math.max(0, n(data.ordered, 0));
  M.warDays = Math.max(0, n(data.warDays, 0));
  M.peaceDays = Math.max(0, n(data.peaceDays, 0));
  M.weariness = clamp(n(data.weariness, 0), 0, WEAR_MAX);
  M.grief = clamp(n(data.grief, 0), 0, GRIEF_MAX);
  M.pride = clamp(n(data.pride, 0), 0, PRIDE_MAX);
  M.respiteDay = n(data.respiteDay, -999);
  M.wearMark = Math.max(0, n(data.wearMark, 0));
  M.boredSaid = n(data.boredSaid, -999);
  M.orderSaid = n(data.orderSaid, -999);
  return M;
}

// ───────────────────────── Чтение мира ─────────────────────────

function pickEco(sim) {
  if (!sim) return null;
  return (sim.industry && sim.industry.eco) || sim.economy || null;
}
// Дней задержки жалования подряд. Считает их economy.js, здесь только читаем:
// своего счётчика «пустой казны» заводить нельзя — разойдётся с настоящим.
export function arrearsOf(sim) {
  const e = pickEco(sim);
  return e && typeof e.arrears === 'number' ? Math.max(0, e.arrears) : 0;
}
function polState(sim) {
  return (sim && sim.politics && sim.politics.state) || null;
}
export function playerSquads(sim) {
  if (!sim || !sim.armyState || !Array.isArray(sim.armyState.squads)) return [];
  return squadsOf(sim.armyState, 'player').filter(s => squadSize(s) > 0);
}
export function fieldMen(sim) {
  let n = 0;
  for (const sq of playerSquads(sim)) n += squadSize(sq);
  return n;
}
export function reserveMen(sim) {
  return sim && sim.army ? Math.max(0, Math.floor(sim.army.soldiers || 0)) : 0;
}
function warCount(sim) {
  return Array.isArray(sim && sim.wars) ? sim.wars.length : 0;
}

// ───────────────────────── Разбор сегодняшнего дня ─────────────────────────

// События дня лежат в sim.war.events — их кладёт туда wire_army сразу после
// хода войны, поэтому связь, вызванная в тот же день, видит именно сегодняшний
// список. Тип события в front.js/army.js проставлен «с точки зрения игрока»
// (good — хорошо нам, bad — плохо нам), на этом и держится разбор.
//
// Оговорка: бой двух соседей между собой (без нас) тоже пришёл бы с типом bad.
// В нынешней игре чужих отрядов на карте не бывает — их создаёт только
// wire_army и только для набега на игрока, — но на всякий случай бои
// засчитываются лишь тогда, когда у игрока есть или были отряды в поле.
export function classifyDay(events, hasField) {
  const out = { victories: 0, defeats: 0, captures: 0, banners: 0, wiped: 0, bearersLost: 0, cut: 0, deserted: 0 };
  for (const e of events || []) {
    if (!e || typeof e.text !== 'string') continue;
    const t = e.text, k = e.type;
    if (t.startsWith('⚔')) {
      if (!hasField) continue;
      if (k === 'good') out.victories++; else if (k === 'bad') out.defeats++;
    } else if (t.startsWith('🚩 Поселение')) {
      if (k === 'good') out.captures++;
    } else if (t.startsWith('🚩 Знаменосец')) {
      if (k === 'good') out.banners++;
    } else if (t.startsWith('☠')) {
      if (k === 'bad') out.wiped++;
    } else if (t.startsWith('🕯')) {
      if (k === 'bad') out.bearersLost++;
    } else if (t.startsWith('🪢')) {
      if (k === 'warn') out.cut++;
    } else if (t.startsWith('🏃')) {
      if (k === 'bad') out.deserted++;
    }
  }
  return out;
}

// ───────────────────────── Отдельные формулы (их же зовёт тест) ─────────────────────────

// Доля усталости выше порога терпения: 0 — войну терпят, 1 — устали до предела.
export function wearQ(weariness) {
  return clamp((weariness - WEAR_ACHE) / (WEAR_MAX - WEAR_ACHE), 0, 1);
}

// Доля войска, уходящая за день при задержке жалования.
export function desertRate(arrears) {
  if (arrears < DESERT_AFTER) return 0;
  return Math.min(DESERT_RATE_MAX, DESERT_RATE * (arrears - DESERT_AFTER + 1));
}

// Множитель силы армии: разложение от долгов и надбавка от любви сословия.
export function armyMultOf(arrears, milApproval) {
  const rot = Math.max(MULT_ARREARS_MAX, MULT_ARREARS * Math.max(0, arrears));
  const love = MULT_LOVE_MAX * clamp(((milApproval == null ? 50 : milApproval) - FACTION_HAPPY) / (100 - FACTION_HAPPY), 0, 1);
  return clamp(r3(1 + rot + love), MULT_MIN, MULT_MAX);
}

// Удар по одобрению военных за дневные потери. Масштабируется и долей, и
// абсолютным размером войска: маленькая дружина — маленькая новость.
export function lossHit(loss, prevTotal) {
  if (loss <= 0 || prevTotal <= 0) return 0;
  const share = clamp(loss / prevTotal, 0, 1);
  const weight = Math.min(1, prevTotal / LOSS_SCALE_MEN);
  return -LOSS_MIL_SPAN * share * weight;
}

// Раскладка дезертирства по отрядам: пропорционально численности, остаток —
// большему отряду. Никакой случайности: тот же день даёт тот же список.
export function desertPlan(squads, total) {
  const alive = [...squads].filter(s => squadSize(s) > 0)
    .sort((a, b) => squadSize(b) - squadSize(a) || a.id - b.id);
  const men = alive.reduce((n, s) => n + squadSize(s), 0);
  if (!men || total <= 0) return [];
  let left = Math.min(Math.floor(total), men);
  const plan = alive.map(s => ({ id: s.id, name: s.name, size: squadSize(s), take: 0 }));
  for (const p of plan) {
    if (left <= 0) break;
    const take = Math.min(p.size, Math.floor(Math.min(total, men) * p.size / men));
    p.take = take; left -= take;
  }
  for (const p of plan) {
    if (left <= 0) break;
    const add = Math.min(p.size - p.take, left);
    p.take += add; left -= add;
  }
  return plan.filter(p => p.take > 0);
}

// ───────────────────────── Главная функция ─────────────────────────

export function warLinks(sim, memo) {
  const M = restoreWarMemory(memo);
  const out = {
    mods: { approval: zeroApproval(), stability: 0, happy: 0, morale: 0, armyMult: 1 },
    reasons: { approval: [], stability: [], happy: [], morale: [] },
    events: [],
    flags: {
      quiet: true,
      losses: 0, victories: 0, defeats: 0, captures: 0,
      weariness: M.weariness, warDays: M.warDays, peaceDays: M.peaceDays,
      arrears: 0, desert: { field: 0, reserve: 0, squads: [] },
      raidDelay: 0, bored: false, order: false, exhausted: false,
      advice: [],
    },
    memo: M,
  };
  if (!sim || !sim.armyState) return out;             // война не установлена — связывать нечего

  const day = Math.max(0, Math.round(sim.day || 0));
  const gap = M.day < 0 ? -1 : day - M.day;
  // Один день считается один раз. Повторный вызов в тот же день (или назад во
  // времени) не должен начислять усталость и потери второй раз.
  if (gap === 0 || (gap < 0 && M.day >= 0)) return out;

  const N = { ...M, day };
  const squads = playerSquads(sim);
  const field = fieldMen(sim);
  const reserve = reserveMen(sim);
  const total = field + reserve;
  const pop = sim.villagers ? sim.villagers.length : 0;
  const wars = warCount(sim);
  const arrears = arrearsOf(sim);
  const st = polState(sim);
  const mil = st && typeof st.factions.military === 'number' ? st.factions.military : 50;
  out.flags.arrears = arrears;

  const A = out.mods.approval;
  const addA = (fid, v, ru) => { if (Math.abs(v) > 0.0005) { A[fid] += v; out.reasons.approval.push({ fid, ru, v: r3(v) }); } };
  const addS = (v, ru) => { if (Math.abs(v) > 0.0005) { out.mods.stability += v; out.reasons.stability.push({ ru, v: r3(v) }); } };

  // Есть ли вчерашний срез. После загрузки сейва с пропуском дней (или в самый
  // первый день) разницы считать не по чему: события дня начисляем только при
  // непрерывном счёте, а состояние — всегда.
  const fresh = gap === 1;

  // --- 1. Потери: кто не вернулся -----------------------------------------
  // Считаем по общему числу военных людей (поле + резерв), а не по отрядам:
  // формирование и роспуск людей не теряют, а гибель, дезертирство и разорённый
  // набегом резерв — теряют. Вчерашнее дезертирство, которое назначила эта же
  // связь, вычитается: оно уже наказало сословие своим порядком.
  let loss = 0;
  if (fresh) loss = Math.max(0, M.total - total - M.ordered);
  out.flags.losses = loss;

  const D = classifyDay(sim.war && sim.war.events, field > 0 || M.total > reserve);
  if (!fresh) { D.victories = 0; D.defeats = 0; D.captures = 0; D.banners = 0; D.wiped = 0; D.bearersLost = 0; }
  out.flags.victories = D.victories;
  out.flags.defeats = D.defeats;
  out.flags.captures = D.captures;

  if (loss > 0) {
    const v = lossHit(loss, Math.max(1, M.total));
    addA('military', v, `Не вернулись из строя: ${loss} ${plural(loss, 'боец', 'бойца', 'бойцов')}`);
    // Стабильность роняют только заметные потери: пятеро павших — беда семьи,
    // а не державы. Порог в четверть войска.
    if (loss >= Math.max(4, M.total * 0.25)) addS(-0.3, 'Войско понесло тяжёлые потери');
    N.grief = Math.min(GRIEF_MAX, N.grief + loss * GRIEF_PER_MAN);
  }

  // --- 2. Бои: победы и поражения -----------------------------------------
  if (D.victories) {
    addA('military', WIN_MIL * D.victories, `Победа в поле ×${D.victories}`);
    addS(WIN_STAB * D.victories, 'Наши войска победили');
    N.pride = Math.min(PRIDE_MAX, N.pride + WIN_PRIDE * D.victories);
  }
  if (D.defeats) {
    addA('military', DEFEAT_MIL * D.defeats, `Разбиты в поле ×${D.defeats}`);
    addA('nobles', DEFEAT_NOBLES * D.defeats, 'Поражение позорит державу');
    addS(DEFEAT_STAB * D.defeats, 'Наши войска разбиты');
    N.grief = Math.min(GRIEF_MAX, N.grief + DEFEAT_GRIEF * D.defeats);
  }
  if (D.captures) {
    addA('military', CAPTURE_MIL * D.captures, `Взят чужой город ×${D.captures}`);
    addA('nobles', CAPTURE_NOBLES * D.captures, 'Слава державе');
    addS(CAPTURE_STAB * D.captures, 'Взят чужой город');
    N.pride = Math.min(PRIDE_MAX, N.pride + CAPTURE_PRIDE * D.captures);
  }
  if (D.banners) {
    addA('military', BANNER_MIL * D.banners, 'Знамя победы поднято');
    N.pride = Math.min(PRIDE_MAX, N.pride + BANNER_PRIDE * D.banners);
  }
  if (D.wiped) {
    addA('military', WIPED_MIL * D.wiped, `Отряд погиб целиком ×${D.wiped}`);
    addS(WIPED_STAB * D.wiped, 'Отряд перестал существовать');
  }
  if (D.bearersLost) {
    addA('military', BEARER_MIL * D.bearersLost, 'Знаменосец пал');
    N.grief = Math.min(GRIEF_MAX, N.grief + BEARER_GRIEF * D.bearersLost);
  }

  // --- 3. Календарь войны и усталость -------------------------------------
  if (wars > 0) { N.warDays = M.warDays + 1; N.peaceDays = 0; }
  else { N.peaceDays = M.peaceDays + 1; N.warDays = 0; }

  let wear = M.weariness;
  if (wars > 0) {
    wear += WEAR_PER_DAY + WEAR_PER_EXTRA_WAR * Math.min(3, wars - 1);
    wear += Math.min(WEAR_LOSS_MAX, loss * WEAR_PER_LOSS) + D.defeats * WEAR_PER_DEFEAT;
  } else {
    wear -= WEAR_DECAY;
  }
  // Победа облегчает даже самую долгую войну — это и есть выход из петли
  // усталости для того, кто воюет успешно.
  wear -= D.victories * WEAR_WIN_RELIEF + D.captures * WEAR_CAPTURE_RELIEF;
  N.weariness = clamp(wear, 0, WEAR_MAX);
  out.flags.weariness = r3(N.weariness);
  out.flags.warDays = N.warDays;
  out.flags.peaceDays = N.peaceDays;

  const wq = wearQ(N.weariness);
  if (wq > 0) {
    addA('commons', WEAR_COMMONS * wq, `Усталость от войны (${Math.round(N.weariness)})`);
    addA('military', WEAR_MIL * wq, 'Войско тоже устало');
    addS(WEAR_STAB * wq, `Война идёт ${N.warDays} ${plural(N.warDays, 'день', 'дня', 'дней')}`);
    out.flags.exhausted = wq >= 0.6;
  }

  // --- 4. Пустая казна разлагает армию ------------------------------------
  // Одобрение военных за задержку жалования здесь НЕ трогаем: это делает
  // link_economy.js. Наше — то, чего нет нигде: дух отрядов в поле, побег из
  // строя и боеспособность.
  let morale = 0;
  if (arrears > 0) {
    const m = Math.max(MORALE_ARREARS_MAX, MORALE_ARREARS * arrears);
    morale += m;
    out.reasons.morale.push({ ru: `Жалование задержано ${arrears} ${plural(arrears, 'день', 'дня', 'дней')}`, v: r3(m) });
  } else if (mil >= FACTION_HAPPY && (field > 0 || reserve > 0)) {
    morale += MORALE_PAID;
    out.reasons.morale.push({ ru: 'Жалование вовремя, войско в чести', v: MORALE_PAID });
  }
  out.mods.morale = r3(morale);

  const rate = desertRate(arrears);
  if (rate > 0 && total > 0) {
    // Из отряда бегут охотнее, чем из родного поселения.
    const goField = Math.floor(field * rate);
    const goHome = Math.floor(reserve * rate * DESERT_HOME_MULT);
    // Совсем без побега при десятидневной задержке быть не может: если по доле
    // выходит ноль, уходит хотя бы один — иначе крошечное войско сидело бы
    // неоплаченным вечно, и связь была бы незаметна.
    const forced = arrears >= DESERT_AFTER + 4 && goField + goHome === 0 ? 1 : 0;
    const f = goField + (forced && field > 0 ? 1 : 0);
    const h = goHome + (forced && field === 0 && reserve > 0 ? 1 : 0);
    out.flags.desert.field = f;
    out.flags.desert.reserve = h;
    out.flags.desert.squads = desertPlan(squads, f);
    if (f + h > 0) {
      out.events.push({
        text: `🏃 Жалование не платят ${arrears} ${plural(arrears, 'день', 'дня', 'дней')}: из войска ушли ${f + h} ${plural(f + h, 'человек', 'человека', 'человек')}. Меньше ртов — меньше расход казны.`,
        type: 'bad',
      });
      out.flags.advice.push('Распустите отряд дома — он вернётся в резерв, а казна перестанет платить за поле.');
    }
  }
  N.ordered = out.flags.desert.field + out.flags.desert.reserve;

  out.mods.armyMult = armyMultOf(arrears, mil);

  // --- 5. Мир: порядок и скука --------------------------------------------
  if (wars === 0 && arrears === 0 && N.peaceDays >= ORDER_AFTER && total >= ORDER_MIN_MEN) {
    const need = Math.max(ORDER_MIN_MEN, pop * ORDER_SHARE);
    const strength = clamp(total / need, 0, 1);
    addS(ORDER_STAB_MAX * strength, `Гарнизон держит порядок (${total} ${plural(total, 'боец', 'бойца', 'бойцов')})`);
    out.flags.order = true;
    if (day - M.orderSaid >= 30) {
      N.orderSaid = day;
      out.events.push({ text: `🛡 Войско при деле и при жаловании: улицы спокойны, порядок держится сам.`, type: 'good' });
    }
  }
  if (wars === 0 && N.peaceDays > BORED_AFTER && mil > BORED_FLOOR) {
    const bq = clamp((N.peaceDays - BORED_AFTER) / BORED_RAMP, 0, 1);
    // Большому войску скучнее: людям, которых учили воевать, нечем заняться.
    const size = 0.6 + 0.4 * clamp(total / 10, 0, 1);
    addA('military', BORED_RATE * bq * size, `Мир идёт ${N.peaceDays} ${plural(N.peaceDays, 'день', 'дня', 'дней')} — войску нечем заняться`);
    out.flags.bored = true;
    if (bq >= 0.5 && day - M.boredSaid >= 30) {
      N.boredSaid = day;
      out.events.push({
        text: 'Военные ропщут: «Ржавеют мечи, беднеет дружина». Долгий мир их не радует.',
        type: 'warn',
      });
    }
  }

  // --- 6. Выход из спирали «нет денег → нет армии → набеги» ----------------
  const raidsOn = sim.raids && !sim.raids.off && (sim.eraIndex || 0) >= 2;
  const beggared = arrears >= RESPITE_ARREARS
    && total <= Math.max(RESPITE_MEN_MIN, Math.floor(pop * RESPITE_MEN_SHARE));
  if (raidsOn && beggared && day - M.respiteDay >= RESPITE_CD && (sim.raids.timer || 0) > 0) {
    N.respiteDay = day;
    out.flags.raidDelay = RESPITE_DAYS;
    out.events.push({
      text: `🏕 Соседи видят разорение: в пустой казне брать нечего, войска нет и грабить некого. Набег откладывается на ${RESPITE_DAYS} дн.`,
      type: 'good',
    });
    out.flags.advice.push('Передышка дана не навсегда: соберите золото и людей, пока набег отложен.');
  }

  // --- 7. Счастье: горе и гордость ----------------------------------------
  N.grief = Math.max(0, N.grief * (1 - GRIEF_DECAY));
  N.pride = Math.max(0, N.pride * (1 - PRIDE_DECAY));
  let happy = -N.grief + N.pride + WEAR_HAPPY * wq;
  if (N.grief > 0.5) out.reasons.happy.push({ ru: 'Горе по павшим', v: r3(-N.grief) });
  if (N.pride > 0.5) out.reasons.happy.push({ ru: 'Гордость за победы', v: r3(N.pride) });
  if (wq > 0) out.reasons.happy.push({ ru: 'Усталость от войны', v: r3(WEAR_HAPPY * wq) });
  out.mods.happy = Math.round(clamp(happy, HAPPY_WORST, HAPPY_BEST));

  // --- 8. Потолки ----------------------------------------------------------
  A.military = r3(clamp(A.military, MIL_DAY_DOWN, MIL_DAY_UP));
  A.commons = r3(clamp(A.commons, COMMONS_DAY[0], COMMONS_DAY[1]));
  A.nobles = r3(clamp(A.nobles, -2, 2));
  out.mods.stability = r3(clamp(out.mods.stability, STAB_WORST, STAB_BEST));

  // --- 9. Слова игроку -----------------------------------------------------
  if (loss >= 3 || D.wiped) {
    out.events.push({
      text: `⚔ Потери: ${loss} ${plural(loss, 'боец', 'бойца', 'бойцов')} не вернулись. Военное сословие мрачнеет, в домах траур.`,
      type: 'bad',
    });
  }
  if (D.captures) {
    out.events.push({ text: 'Взят чужой город: войско в славе, город ликует, усталость от войны отступила.', type: 'good' });
  } else if (D.victories && !D.defeats) {
    out.events.push({ text: 'Победа в поле: военные довольны, а долгая война стала чуть легче.', type: 'good' });
  }
  const mark = WEAR_MARKS.filter(m => N.weariness >= m).pop() || 0;
  if (mark > N.wearMark) {
    N.wearMark = mark;
    out.events.push({ text: wearText(mark, N.warDays), type: mark >= 60 ? 'bad' : 'warn' });
  } else if (mark < N.wearMark) {
    N.wearMark = mark;   // усталость спала — можно будет предупредить снова
  }
  if (out.flags.exhausted) {
    out.flags.advice.push('Мир или победа — два способа снять усталость от войны. Она тает по 1.2 в день без войн.');
  }

  out.flags.quiet = out.events.length === 0
    && out.mods.stability === 0 && out.mods.happy === 0 && out.mods.morale === 0
    && out.mods.armyMult === 1 && !out.flags.desert.field && !out.flags.desert.reserve
    && ESTATES.every(f => A[f] === 0);

  N.total = total;
  N.battles = sim.armyState.battles || 0;
  out.memo = N;
  return out;
}

function wearText(mark, warDays) {
  if (mark >= 85) return `Страна изнемогает: война идёт ${warDays} ${plural(warDays, 'день', 'дня', 'дней')}, в городе ропот, на площадях кричат о мире.`;
  if (mark >= 60) return `Война всем надоела: ${warDays} ${plural(warDays, 'день', 'дня', 'дней')} без мира. Простолюдины ропщут, порядок шатается.`;
  return 'Война затянулась: в городе начинают уставать от поборов и похорон.';
}

// ───────────────────────── Разбор для панели ─────────────────────────

// Готовые строки для вкладки «Фронт»/«Держава»: игрок обязан видеть причину
// словами, а не гадать, отчего просела стабильность.
export function explainWar(sim, L) {
  const links = L || null;
  const arrears = arrearsOf(sim);
  const st = polState(sim);
  const mil = st && typeof st.factions.military === 'number' ? st.factions.military : 50;
  const rows = [];
  const w = links ? links.flags.weariness : 0;
  if (w > 0) {
    rows.push({
      ru: 'Усталость от войны', v: Math.round(w),
      text: w < WEAR_ACHE
        ? 'Пока терпимо: до порога терпения страна войну не замечает.'
        : `Держава устала: счастье ${Math.round(WEAR_HAPPY * wearQ(w))}, стабильность ${r3(WEAR_STAB * wearQ(w))} в день. Победа снимает ${WEAR_WIN_RELIEF}, взятый город — ${WEAR_CAPTURE_RELIEF}, мирный день — ${WEAR_DECAY}.`,
    });
  }
  if (arrears > 0) {
    rows.push({
      ru: 'Жалование задержано', v: arrears,
      text: arrears < DESERT_AFTER
        ? `Пока терпят, но дух падает. С ${DESERT_AFTER}-го дня начнётся дезертирство.`
        : `Из войска бежит ${Math.round(desertRate(arrears) * 100)}% в день. Армия дерётся на ${Math.round((1 - armyMultOf(arrears, mil)) * 100)}% хуже.`,
    });
  }
  if (links && links.flags.order) {
    rows.push({ ru: 'Гарнизон держит порядок', v: r3(ORDER_STAB_MAX), text: 'Оплаченное войско в мирное время работает на стабильность.' });
  }
  if (links && links.flags.bored) {
    rows.push({ ru: 'Военные скучают', v: links.flags.peaceDays, text: `Долгий мир злит военное сословие, но не ниже ${BORED_FLOOR}.` });
  }
  return {
    weariness: w, arrears, military: r3(mil),
    armyMult: armyMultOf(arrears, mil),
    rows,
    advice: links ? links.flags.advice : [],
  };
}

function plural(n, one, few, many) {
  const a = Math.abs(Math.round(n)) % 100;
  if (a > 10 && a < 20) return many;
  const b = a % 10;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/* ПОДКЛЮЧЕНИЕ

   Файл: app/src/core/systems/integrate.js
   Все якоря проверены на уникальность в текущем файле (по одному совпадению).

1) Импорт. ЯКОРЬ (строка уникальна в файле):
     import * as EMP from './wire_empire.js';
   ДОБАВИТЬ СРАЗУ ПОСЛЕ НЕЁ:
     import * as LWR from './link_war.js';

2) Память связи. ЯКОРЬ (строка уникальна в файле):
     EMP.installEmpire(sim);
   ДОБАВИТЬ СРАЗУ ПОСЛЕ НЕЁ:
     // Память связи войны: вчерашняя численность войска, дни войны, усталость.
     sim.linkWar = LWR.createWarMemory();

3) Применение раз в сутки. ЯКОРЬ (строка уникальна в файле):
     EMP.empireNewDay(sim);
   ДОБАВИТЬ ПОСЛЕ НЕЁ (если там уже стоят вызовы других связей — дописать в их
   конец; порядок между связями не важен, все они читают уже сложившийся день):
     applyWarLinks(sim);

4) В КОНЕЦ файла добавить функцию-применитель (модуль сам ничего не меняет):

export function applyWarLinks(sim) {
  if (!sim.war || !sim.armyState) return null;
  const L = LWR.warLinks(sim, sim.linkWar);
  sim.linkWar = L.memo;
  sim.sys.warLinks = L;                    // для HUD: панель читает готовый разбор

  // Сословия: потери, победы, усталость, скука.
  const P = sim.politics ? sim.politics.state : null;
  if (P) {
    for (const fid of Object.keys(P.factions)) {
      P.factions[fid] = Math.max(0, Math.min(100, P.factions[fid] + (L.mods.approval[fid] || 0)));
    }
    // Скука не тянет военных ниже своего пола — потолок петли.
    if (L.flags.bored) P.factions.military = Math.max(LWR.BORED_FLOOR, P.factions.military);
    P.stability = Math.max(0, Math.min(100, P.stability + L.mods.stability));
  }

  // Дух отрядов в поле: невыплаченное жалование разлагает строй.
  if (L.mods.morale !== 0) {
    for (const sq of LWR.playerSquads(sim)) {
      sq.morale = Math.max(0, Math.min(100, (sq.morale ?? 100) + L.mods.morale));
    }
  }
  // Боеспособность. syncSquads() в wire_army заново ставит sq.mult каждый день,
  // поэтому множитель именно домножается и не копится.
  if (L.mods.armyMult !== 1) {
    for (const sq of LWR.playerSquads(sim)) sq.mult = (sq.mult || 1) * L.mods.armyMult;
  }

  // Дезертирство: из отрядов по плану связи, из резерва — числом.
  for (const p of L.flags.desert.squads) {
    const sq = sim.armyState.squads.find(s => s.id === p.id);
    if (!sq) continue;
    let left = p.take;
    for (const [uid, n] of Object.entries(sq.units)) {
      if (left <= 0) break;
      const d = Math.min(n, left);
      left -= d;
      if (n - d > 0) sq.units[uid] = n - d; else delete sq.units[uid];
    }
  }
  sim.armyState.squads = sim.armyState.squads.filter(s => {
    const alive = Object.values(s.units || {}).some(n => n > 0) || Object.values(s.engines || {}).some(n => n > 0);
    return alive;
  });
  if (L.flags.desert.reserve > 0) {
    sim.army.soldiers = Math.max(0, sim.army.soldiers - L.flags.desert.reserve);
  }

  // Выход из спирали: разорённую державу грабить незачем — набег отодвигается.
  if (L.flags.raidDelay > 0 && sim.raids) sim.raids.timer += L.flags.raidDelay;

  for (const e of L.events) sim.addLog(e.text, e.type === 'good' ? 'good' : e.type);
  if (L.flags.captures) sim.addChronicle(`Взят чужой город (день ${sim.day}).`);
  return L;
}

5) Счастье: горе по павшим, гордость за победы, усталость от войны.
   ЯКОРЬ — тело функции systemsHappyMod. Сейчас там стоит:
     return W.happyMod(sim.sys.winter) + IND.industryHappyMod(sim) + POL.politicsHappyMod(sim)
   ДОПИСАТЬ В КОНЕЦ ЭТОГО ВЫРАЖЕНИЯ (если другие связи уже удлинили строку —
   просто добавить ещё одно слагаемое):
     + (sim.sys.warLinks ? sim.sys.warLinks.mods.happy : 0)

6) Сохранение памяти (иначе после загрузки обнулятся усталость и счёт дней войны).
   ЯКОРЬ (строка уникальна в файле):
     emp: EMP.empireSerialize(sim),
   ДОБАВИТЬ СРАЗУ ПОСЛЕ НЕЁ:
     linkWar: sim.linkWar || null,

   ЯКОРЬ (строка уникальна в файле):
     if (data.emp) EMP.empireRestore(sim, data.emp);
   ДОБАВИТЬ СРАЗУ ПОСЛЕ НЕЁ:
     sim.linkWar = LWR.restoreWarMemory(data.linkWar);

7) Для панели (по желанию, ничего не меняет):
     LWR.explainWar(sim, sim.sys.warLinks)   // усталость, жалование, порядок, советы
     sim.sys.warLinks.reasons                // готовые строки причин по одобрению,
                                             // стабильности, счастью и духу

   Ядро (simulation.js) трогать не нужно вовсе.
*/
