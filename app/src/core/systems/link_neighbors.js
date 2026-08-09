// core/systems/link_neighbors.js — СВЯЗИ: соседи ↔ наша держава.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. civ_ai.js уже растит соседям население, казну, науку и войско,
// diplomacy_ext.js ведёт их войны и союзы, economy.js держит цены и индекс монеты,
// а ядро — торговые договоры, караваны и отношения. Между всем этим не было ни
// одной линии. Орда могла три года резаться с Волчьим Пределом в двенадцати
// клетках от наших ворот — и это никак не сказывалось ни на ценах, ни на
// караванах, ни на притоке беженцев. Торговый договор давал +20 отношений и
// строчку в журнале, но ни монеты дохода. Сосед с войском втрое сильнее нашего
// стоял у межи — и держава этого не замечала.
//
// ЧТО ИМЕННО СВЯЗАНО (в обе стороны):
//   война соседа рядом      ──▶ опасность маршрутов ──▶ караваны не доходят,
//                               привозное дорожает, купцы и народ ропщут
//   торговый договор        ──▶ приток золота и скидка на привозное,
//                               купцы довольны; война на маршруте это гасит
//   сильный сосед у межи    ──▶ страх ──▶ расходы на охрану границ и одобрение
//                               военных; ОБРАТНО: пустая казна — гарнизоны без
//                               жалования, и те же военные отворачиваются
//   война в чужих землях    ──▶ беженцы: руки, а с ними и чужое ремесло
//   технологический разрыв  ──▶ отставшие соседи копируют наше (если есть с кем
//                               говорить) или завидуют молча; если отстали МЫ —
//                               знание течёт к нам от партнёров
//   ОБРАТНО: наше богатство и слабая армия ──▶ соседи наглеют: отношения падают
//            каждый день, а civ_ai.js считает войну по ЭТИМ самым отношениям
//   ОБРАТНО: армия не слабее ихней ──▶ воинственные соседи уважают силу
//
// ПОЧЕМУ СОСЕД ВЕДЁТ СЕБЯ ИМЕННО ТАК. Каждая поправка выходит наружу строкой с
// настоящими числами: «их войско 120 против нашего 35, в казне 420🪙, до их
// кочевий 11 клеток». Игрок обязан прочитать причину, а не гадать. Для панели
// есть neighborReport(sim) — по строке на соседа.
//
// ЧИСТЫЙ МОДУЛЬ. Ничего не мутирует: читает sim, возвращает поправки. Применяет
// их integrate.js — точные строки в блоке ПОДКЛЮЧЕНИЕ в конце файла.
//
// СЛУЧАЙНОСТИ НЕТ ВООБЩЕ — ни Math.random, который ломает сейвы, ни sim.rng. Волна
// беженцев и копирование технологий разнесены по дням арифметикой, а не броском:
// так игрок может посчитать беду и выгоду заранее, а сейв не расходится с
// прогоном. Чистая функция, которая дёргает генератор, перестала бы быть чистой.
//
// ПОТОЛОК И ВЫХОД ЕСТЬ У КАЖДОЙ ПЕТЛИ. Опасность маршрутов не выше RISK_CAP,
// страх — не выше FEAR_CAP, расход на охрану — не выше GUARD_CAP, шаг одобрения
// — не больше STEP_CAP в сутки, наглость соседа роняет отношения медленнее, чем
// их поднимает дипломатический дрейф ядра (0.2/день), — то есть выход есть
// всегда: построить войско, замириться, заключить договор, потратить казну.

import { warEnemies } from './diplomacy_ext.js';
import { SOCIAL_FACTIONS } from './politics.js';

// ───────────────────────── Расстояния ─────────────────────────

// Ближе NEAR чужая война идёт фактически на наших дорогах; дальше REACH до нас
// не доходят ни мародёры, ни беженцы, ни выгода. REACH=30 согласован с civ_ai:
// там войну не объявляют дальше 34 клеток, то есть 30 — это «рядом» по меркам
// самой войны, а не выдуманная цифра.
export const NEAR = 10;
export const REACH = 30;

// ───────────────────────── Маршруты и цены ─────────────────────────

// Вклад одной войны в опасность маршрутов при полной близости. Война соседа с
// третьей стороной — это мародёры и перекрытые броды; война против НАС — это
// намеренный перехват караванов, потому и вдвое дороже.
export const RISK_AI_WAR = 0.30;
export const RISK_OUR_WAR = 0.55;
// Потолок: четверть караванов доходит всегда — контрабанда, обходные тропы.
// Без потолка одна большая свара соседей означала бы полный торговый ноль.
export const RISK_CAP = 0.75;

// Насколько дорожает привозное при полной опасности: 0.35 × 0.75 ≈ +26% к цене.
// Ориентир — тот же коридор, в котором живёт индекс цен в economy.js (0.6…3.0):
// война соседей должна быть заметна, но не обязана удваивать хлеб.
export const PRICE_PER_RISK = 0.35;
// Скидка партнёров сгорает вместе с безопасностью маршрута.
export const DISCOUNT_EACH = 0.07;   // за один договор при среднем купце
export const DISCOUNT_CAP = 0.25;    // больше четверти не сбить никаким числом договоров

// ───────────────────────── Торговый договор ─────────────────────────

// Золота в день с одного договора при среднем партнёре (черта trade = 5) в
// нулевой эпохе. Для сравнения: караван в simulation.js приносит 0.6🪙 за рынок
// раз в 15 дней. То есть договор — это заметный, но не подменяющий хозяйство
// доход: три договора примерно равны одному работающему зданию.
export const TREATY_GOLD = 0.5;
export const TREATY_ERA = 0.12;      // развитой партнёр покупает дороже
// Дружба не только про подпись: озлобленный партнёр торгует вполсилы.
export const TREATY_REL_FLOOR = 0.5;

// ───────────────────────── Страх сильного соседа ─────────────────────────

export const FEAR_CAP = 1;
// Даже без войска город не пуст: ополчение и стены. Без этого слагаемого страх
// на первой неделе был бы максимальным просто потому, что армии ещё нет.
export const BASE_DEFENCE = 6;
export const MILITIA_PER_POP = 0.3;
export const WALL_WEIGHT = 0.5;
// Золота в день на охрану границ при полном страхе; крупная армия сторожит
// дороже. Потолок — 3🪙/день: это чувствительно, но не разоряет.
export const GUARD_GOLD = 1.2;
export const GUARD_PER_SOLDIER = 0.05;
export const GUARD_CAP = 3;

// Куда страх тянет одобрение сословий (уровень, а не «отнять столько-то»).
// Военные при явной угрозе на границе получают деньги и вес — и одобряют.
// Купцы наоборот: закрытая граница и опасные дороги — это их убытки.
export const MIL_SPAN = 25;
export const MERCH_SPAN = 15;
export const COMMONS_SPAN = 8;
export const TRADE_JOY = 10;         // насколько договоры радуют купцов
// Скорость и потолок дневного шага одобрения. Те же 4%, что в link_economy:
// сословия не должны дёргаться от одной новости, но за месяц связь видна.
export const APPROACH = 0.04;
export const STEP_CAP = 0.10;

// ───────────────────────── Стабильность и счастье ─────────────────────────

export const STAB_FEAR = -0.25;      // враг у межи подтачивает веру во власть
export const STAB_RISK = -0.15;      // перерезанные дороги — тоже беспорядок
export const STAB_CALM = 0.10;       // награда за спокойные границы (условие ниже)
export const STAB_FLOOR = -0.5;
export const HAPPY_PER_RISK = 6;
export const HAPPY_PER_FEAR = 3;
export const HAPPY_FLOOR = -7;

// ───────────────────────── Беженцы ─────────────────────────

// Волна раз в 8 дней: чаще — и журнал превращается в ленту, реже — игрок не
// свяжет чужую войну с приростом своих людей.
export const REFUGEE_PERIOD = 8;
export const REFUGEE_MAX = 3;        // за волну
// Столько ест житель за сутки — то же число, что EAT в link_survival.js и
// EAT_PER_DAY в ядре. Голодная держава беженцев не принимает: это было бы
// приглашением к голодному бунту, а не связью.
export const EAT = 0.7;
export const REFUGEE_FOOD_DAYS = 8;
// Беженец из более развитой земли приносит ремесло. 0.8📜 за человека — примерно
// день пассивного прироста знания от шестнадцати жителей: подарок, но не наука.
export const REFUGEE_KNOW = 0.8;

// ───────────────────────── Технологический разрыв ─────────────────────────

// Копировать начинают, отстав на 4 технологии, и только если есть с кем
// говорить: договор, добрые отношения или общая межа. Потолок петли встроен в
// само условие — каждая копия сокращает разрыв, и на COPY_GAP−1 копирование
// прекращается само. Обогнать нас копированием невозможно.
export const COPY_GAP = 4;
export const COPY_PERIOD = 15;
export const COPY_REL = 20;
export const COPY_DIST = 12;
// Отстали сильно и говорить не с кем — остаётся завидовать.
export const LAG_GAP = 8;
export const LAG_REL = -0.05;
// Если отстали МЫ: знание течёт от партнёров по договору. Скидку на стоимость
// исследования при договоре ядро уже даёт в techCost() — это другой рычаг
// (цена), здесь третий ресурс (📜), и поток нарочно мал, чтобы два послабления
// не складывались в «наука бесплатно».
export const KNOW_FLOW = 0.12;
export const KNOW_CAP = 0.8;

// ───────────────────────── Наглость соседей ─────────────────────────

// Что делает нас лакомой добычей: полная казна и слабое войско. Пороги растут с
// эпохой — 300🪙 в каменном веке и 300🪙 в паровом это разные деньги. Шаг 1.5 и
// 1.6 взяты из threatPoints() ядра, чтобы соблазн рос вместе с угрозой.
export const GOLD_TEMPT = 300;
export const WEALTH_TEMPT = 1500;
export const TEMPT_ERA_GOLD = 1.5;
export const TEMPT_ERA_WEALTH = 1.6;
// Ниже этого наглость — шум, и отношения не трогаем.
export const GREED_MIN = 0.25;
// Сколько отношений в день отнимает полная наглость. Ядро тянет отношения к
// базовому уровню на 0.2/день — наш минус слабее, поэтому равновесие
// устанавливается смещённым, но не уходит в −100. Это и есть выход из петли.
export const GREED_REL = -0.12;
// Уважение силы: воинственный сосед прибавляет отношения, если наше войско не
// слабее его. Отсюда прямой смысл держать армию, а не только стены.
export const RESPECT_REL = 0.08;
export const RESPECT_AGGRESSION = 6;
// Совокупный дневной сдвиг по одному соседу не выходит за эти рамки.
export const REL_STEP_CAP = 0.2;
// Войско, ниже которого сосед никому не угрожает и ни на кого не зарится.
export const ARMY_FLOOR = 5;

const ESTATES = Object.keys(SOCIAL_FACTIONS);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r3 = (v) => Math.round(v * 1000) / 1000;
const r2 = (v) => Math.round(v * 100) / 100;
const zeroApproval = () => Object.fromEntries(ESTATES.map(f => [f, 0]));

// ───────────────────────── Чтение мира ─────────────────────────

// Наши точки на карте: столица плюс города империи, если модуль городов стоит.
export function homePoints(sim) {
  const pts = [];
  const w = sim && sim.world;
  if (w && typeof w.startX === 'number' && typeof w.startY === 'number') {
    pts.push({ x: w.startX, y: w.startY });
  }
  const cities = sim && sim.empire && sim.empire.state && sim.empire.state.cities;
  if (Array.isArray(cities)) {
    for (const c of cities) if (c && typeof c.x === 'number') pts.push({ x: c.x, y: c.y });
  }
  return pts;
}

function nearestDist(home, settlements) {
  let best = Infinity;
  for (const h of home) {
    for (const s of settlements || []) {
      if (!s || typeof s.x !== 'number') continue;
      const d = Math.hypot(s.x - h.x, s.y - h.y);
      if (d < best) best = d;
    }
  }
  return best;
}

// Вес близости: вплотную — единица, за REACH — ноль, между — линейно.
export function proximity(dist) {
  if (!isFinite(dist)) return 0;
  if (dist <= NEAR) return 1;
  return clamp((REACH - dist) / (REACH - NEAR), 0, 1);
}

// Наша настоящая сила в глазах соседа: не только регулярное войско. Стены и
// людность видно с межи, и именно по ним сосед решает, стоит ли лезть.
export function ourStrength(sim) {
  const army = typeof sim.armyPower === 'function' ? (sim.armyPower() || 0)
    : ((sim.army && sim.army.soldiers) || 0) * 2;
  const walls = typeof sim.defensePower === 'function' ? (sim.defensePower() || 0) : 0;
  const pop = (sim.villagers && sim.villagers.length) || 0;
  return army + walls * WALL_WEIGHT + pop * MILITIA_PER_POP + BASE_DEFENCE;
}

function traitsOf(f) {
  const tr = (f && f.def && f.def.traits) || {};
  return {
    aggression: tr.aggression ?? 5, expansion: tr.expansion ?? 5, trade: tr.trade ?? 5,
    science: tr.science ?? 5, faith: tr.faith ?? 5, defense: tr.defense ?? 5,
  };
}

// С кем сосед воюет помимо нас. Реестр войн между ИИ ведёт diplomacy_ext —
// своего второго списка здесь нет и быть не может.
function aiFoes(sim, fid) {
  const D = sim && sim.diplo;
  if (!D || !Array.isArray(D.wars)) return [];
  try { return warEnemies(D, fid).filter(x => x !== 'player'); } catch { return []; }
}

// Сводка по каждому живому соседу — единственное место, где читается мир.
export function readNeighbors(sim) {
  const home = homePoints(sim);
  const out = [];
  for (const f of (sim && sim.factions) || []) {
    if (!f || f.alive === false) continue;
    const dist = nearestDist(home, f.settlements);
    const atWarWithUs = ((sim.wars || []).some(w => w && w.fid === f.id));
    const foes = aiFoes(sim, f.id);
    out.push({
      fid: f.id,
      name: (f.def && f.def.name) || f.id,
      dist: isFinite(dist) ? r2(dist) : Infinity,
      w: proximity(dist),
      rel: (sim.relations && typeof sim.relations[f.id] === 'number') ? sim.relations[f.id] : 0,
      treaty: (sim.treaties || []).some(t => t && t.b === f.id && (t.type || 'trade') === 'trade'),
      atWarWithUs,
      foes,
      wars: foes.length + (atWarWithUs ? 1 : 0),
      army: f.armyPts || 0,
      pop: f.P || 0,
      techs: f.techCount || 0,
      era: f.era || 0,
      tr: traitsOf(f),
    });
  }
  return out;
}

// Сколько золота в день приносит наша торговля сама по себе — по тем же
// таблицам, что и караван в ядре: 0.6🪙 за рынок раз в 15 дней. Знать это надо,
// чтобы опасность маршрутов отнимала настоящие деньги, а не выдуманные.
export function caravanIncome(sim) {
  const hasTrade = !!(sim.techs && typeof sim.techs.has === 'function' && sim.techs.has('trade'));
  if (!hasTrade) return 0;
  const markets = typeof sim.countBuilding === 'function' ? (sim.countBuilding('market') || 0) : 0;
  if (markets <= 0) return 0;
  const mult = typeof sim.globalMult === 'function' ? (sim.globalMult('gold') || 1) : 1;
  return (0.6 * markets * mult) / 15;
}

// ───────────────────────── Опасность маршрутов ─────────────────────────

// Возвращает и число, и разбор по причинам: строка на каждую чужую войну.
export function routeDanger(nb) {
  const rows = [];
  let sum = 0;
  for (const n of nb) {
    if (n.w <= 0 || n.wars <= 0) continue;
    // Войну против нас считаем один раз по своей ставке, чужие — по своей.
    const own = (n.atWarWithUs ? RISK_OUR_WAR : 0) + n.foes.length * RISK_AI_WAR;
    const v = own * n.w;
    if (v <= 0.001) continue;
    sum += v;
    rows.push({
      ru: n.atWarWithUs
        ? `${n.name} воюет с нами (${n.dist} кл.)`
        : `${n.name} воюет (${n.foes.length}) в ${n.dist} кл. от нас`,
      v: r3(v),
    });
  }
  rows.sort((a, b) => b.v - a.v);
  return { risk: r3(clamp(sum, 0, RISK_CAP)), raw: r3(sum), rows };
}

// ───────────────────────── Страх ─────────────────────────

// Насколько сосед страшен: разрыв в силе × близость × враждебность.
export function fearFrom(n, mine) {
  if (n.army < ARMY_FLOOR || n.w <= 0) return 0;
  // 0 при равных силах, 1 при трёхкратном перевесе и выше.
  const gap = clamp(n.army / Math.max(1, mine) - 1, 0, 2) / 2;
  // Дружелюбного соседа не боятся даже сильного: при отношениях 30 и выше страх
  // гаснет, при −50 он полный, при −100 полуторный (и его срежет общий потолок).
  const host = clamp((30 - n.rel) / 80, 0, 1.5);
  const open = n.atWarWithUs ? 1.5 : 1;   // враг у ворот страшнее возможного врага
  return gap * host * n.w * open;
}

// ───────────────────────── Наглость ─────────────────────────

// Соблазн: что у нас можно взять. Пороги растут с эпохой — иначе к паровому веку
// любой город автоматически «сказочно богат».
export function temptation(sim) {
  const era = sim.eraIndex || 0;
  const gold = (sim.res && sim.res.gold) || 0;
  const wealth = typeof sim.wealth === 'function' ? (sim.wealth() || 0) : 0;
  const g = clamp(gold / (GOLD_TEMPT * Math.pow(TEMPT_ERA_GOLD, era)), 0, 1);
  const w = clamp(wealth / (WEALTH_TEMPT * Math.pow(TEMPT_ERA_WEALTH, era)), 0, 1);
  return { gold, wealth, value: r3(0.5 * g + 0.5 * w) };
}

// Наглость одного соседа: слабость жертвы × соблазн × его характер × близость.
export function greedOf(n, mine, tempt) {
  if (n.army < ARMY_FLOOR || n.w <= 0) return 0;
  const weakness = clamp(1 - mine / Math.max(1, n.army), 0, 1);
  if (weakness <= 0) return 0;
  // Даже нищий город грабят, если он беззащитен, — отсюда слагаемое 0.35.
  const prize = 0.35 + 0.65 * tempt;
  return r3(weakness * prize * (n.tr.aggression / 10) * n.w);
}

// ───────────────────────── Главная функция ─────────────────────────

export function neighborLinks(sim) {
  const out = {
    mods: {
      gold: 0, knowledge: 0, happy: 0, stability: 0,
      approval: zeroApproval(),
      priceMult: 1, caravanMult: 1, marketDiscount: 0, routeRisk: 0,
    },
    reasons: { gold: [], risk: [], threat: [], approval: {} },
    events: [],
    flags: {
      quiet: true, refugees: 0, refugeeFrom: null, refugeeBlocked: null,
      copycats: [], relations: [], eyeingUs: [], threats: [],
      fear: 0, routeRisk: 0, tradeGold: 0, guardGold: 0, caravanLost: 0,
      garrisonUnpaid: false, calmBorders: false, partners: 0,
    },
  };
  if (!sim || !Array.isArray(sim.factions) || sim.factions.length === 0) return out;

  const day = Math.max(0, Math.round(sim.day || 0));
  const nb = readNeighbors(sim);
  if (nb.length === 0) return out;

  const mine = ourStrength(sim);
  const purse = (sim.res && typeof sim.res.gold === 'number') ? sim.res.gold : 0;

  // ── 1. Война соседа → опасность маршрутов, цены, караваны ────────────────
  const danger = routeDanger(nb);
  const risk = danger.risk;
  out.mods.routeRisk = risk;
  out.flags.routeRisk = risk;
  out.reasons.risk = danger.rows;
  out.mods.caravanMult = r3(1 - risk);
  out.mods.priceMult = r3(1 + PRICE_PER_RISK * risk);

  // Недошедшие караваны — это настоящие деньги, а не абстракция: считаем ровно
  // ту долю каравана, которую перехватили на дорогах.
  const caravan = caravanIncome(sim);
  const caravanLost = r3(caravan * risk);
  out.flags.caravanLost = caravanLost;
  if (caravanLost > 0.001) {
    out.reasons.gold.push({ ru: `Караваны не доходят (опасность ${Math.round(risk * 100)}%)`, v: r3(-caravanLost) });
  }

  // ── 2. Торговые договоры → золото и скидка ────────────────────────────────
  let tradeGold = 0, discount = 0, partners = 0;
  for (const n of nb) {
    if (!n.treaty) continue;
    partners++;
    // Собственная опасность маршрута этого партнёра: его война режет именно его
    // подвоз, а не весь мир.
    const ownRisk = clamp(((n.atWarWithUs ? RISK_OUR_WAR : 0) + n.foes.length * RISK_AI_WAR) * n.w, 0, RISK_CAP);
    const relK = clamp(TREATY_REL_FLOOR + n.rel / 200, TREATY_REL_FLOOR, 1);
    const g = TREATY_GOLD * (0.4 + n.tr.trade / 10) * (1 + TREATY_ERA * n.era) * (1 - ownRisk) * relK;
    tradeGold += g;
    discount += DISCOUNT_EACH * (0.4 + n.tr.trade / 10) * (1 - ownRisk);
    if (g > 0.005) {
      out.reasons.gold.push({
        ru: `Договор с ${n.name}${ownRisk > 0.01 ? ` (маршрут опасен на ${Math.round(ownRisk * 100)}%)` : ''}`,
        v: r3(g),
      });
    }
  }
  tradeGold = r3(tradeGold);
  out.flags.tradeGold = tradeGold;
  out.flags.partners = partners;
  out.mods.marketDiscount = r3(clamp(discount, 0, DISCOUNT_CAP));

  // ── 3. Сильный сосед рядом → страх, расходы, одобрение военных ────────────
  let fear = 0;
  for (const n of nb) {
    const fv = fearFrom(n, mine);
    if (fv <= 0.005) continue;
    fear += fv;
    out.reasons.threat.push({
      ru: `${n.name}: войско ${Math.round(n.army)} против нашего ${Math.round(mine)}, ${n.dist} кл.`,
      v: r3(fv),
    });
  }
  fear = r3(clamp(fear, 0, FEAR_CAP));
  out.flags.fear = fear;
  out.reasons.threat.sort((a, b) => b.v - a.v);

  const soldiers = (sim.army && sim.army.soldiers) || 0;
  const guardWant = r3(clamp(GUARD_GOLD * fear * (1 + soldiers * GUARD_PER_SOLDIER), 0, GUARD_CAP));
  // ОБРАТНАЯ СВЯЗЬ: платить нечем — гарнизоны стоят на границе без жалования.
  const guardPaid = r3(clamp(Math.min(guardWant, purse + tradeGold - caravanLost), 0, guardWant));
  const unpaid = guardWant - guardPaid > 0.01;
  out.flags.guardGold = guardPaid;
  out.flags.garrisonUnpaid = unpaid;
  if (guardPaid > 0.001) {
    out.reasons.gold.push({ ru: `Охрана границ (страх ${Math.round(fear * 100)}%)`, v: r3(-guardPaid) });
  }

  // ── 4. Беженцы из воюющих земель ──────────────────────────────────────────
  // Идут только оттуда, где война, и только к тем, с кем не воюют: через
  // враждебную межу не бегут, её стерегут.
  let flow = 0, source = null, srcW = -1;
  for (const n of nb) {
    if (n.atWarWithUs || n.foes.length === 0 || n.w <= 0) continue;
    const v = n.w * Math.min(1, n.pop / 60);
    flow += v;
    if (v > srcW) { srcW = v; source = n; }
  }
  if (day > 0 && day % REFUGEE_PERIOD === 0 && flow > 0 && source) {
    const pop = (sim.villagers && sim.villagers.length) || 0;
    const cap = typeof sim.housingCap === 'function' ? (sim.housingCap() || 0) : pop;
    const room = Math.max(0, cap - pop);
    const food = (sim.res && sim.res.food) || 0;
    const fed = food >= (pop + 1) * EAT * REFUGEE_FOOD_DAYS;
    const want = Math.min(REFUGEE_MAX, Math.floor(flow * REFUGEE_MAX));
    let count = Math.min(want, room);
    if (!fed) {
      // Отказ — тоже связь, и её тоже надо объяснить словами.
      if (want > 0) out.flags.refugeeBlocked = 'нечем кормить';
      count = 0;
    } else if (want > 0 && room <= 0) {
      out.flags.refugeeBlocked = 'негде селить';
    }
    if (count > 0) {
      out.flags.refugees = count;
      out.flags.refugeeFrom = { fid: source.fid, name: source.name };
      const ourEra = sim.eraIndex || 0;
      // Пришедшие из более развитой земли приносят ремесло — это и есть та самая
      // «утечка технологий», только в нашу пользу.
      if (source.era > ourEra) out.mods.knowledge += REFUGEE_KNOW * count;
      out.events.push({
        text: `Беженцы из земель ${source.name}: ${count} ${plural(count, 'человек', 'человека', 'человек')} просятся за наши стены — там война.`
          + (source.era > ourEra ? ' Среди них мастера: они принесли чужие ремёсла.' : ''),
        type: 'info',
      });
    } else if (out.flags.refugeeBlocked) {
      out.events.push({
        text: `Беженцы от войны у ${source.name} повернули прочь: ${out.flags.refugeeBlocked}.`,
        type: 'warn',
      });
    }
  }

  // ── 5. Технологический разрыв ─────────────────────────────────────────────
  const ourTechs = (sim.techs && typeof sim.techs.size === 'number') ? sim.techs.size
    : (Array.isArray(sim.techs) ? sim.techs.length : 0);
  let knowFlow = 0;
  for (const n of nb) {
    const gap = ourTechs - n.techs;
    const contact = n.treaty || n.rel >= COPY_REL || n.dist <= COPY_DIST;
    if (gap >= COPY_GAP && contact && !n.atWarWithUs) {
      // Разнесено по дням: фракции копируют не хором. Фаза — от длины id, число
      // детерминированное, одинаковое до и после загрузки сейва.
      if (day > 0 && day % COPY_PERIOD === (n.fid.length * 3) % COPY_PERIOD) {
        const why = n.treaty ? 'договор открыл им наши мастерские'
          : n.rel >= COPY_REL ? 'добрые отношения развязали языки'
            : 'наша межа рядом, и всё видно';
        out.flags.copycats.push({ fid: n.fid, name: n.name, gap, why });
        out.events.push({
          text: `${n.name} перенимает наше ремесло: мы впереди на ${gap} ${plural(gap, 'технологию', 'технологии', 'технологий')}, а ${why}.`,
          type: 'warn',
        });
      }
    } else if (gap >= LAG_GAP && !contact) {
      // Отстали и говорить не с кем — остаётся завидовать. Копить обиду.
      pushRel(out, n, LAG_REL, `отстали на ${gap} технологий и завидуют`);
    }
    if (gap <= -3 && n.treaty && !n.atWarWithUs) {
      // Отстали МЫ, но есть договор — знание течёт к нам. Учёный партнёр учит
      // охотнее: Дом Механиков (science 9) даёт вдвое против Орды (2).
      knowFlow += KNOW_FLOW * Math.min(4, -gap) * (n.tr.science / 5);
    }
  }
  knowFlow = r3(clamp(knowFlow, 0, KNOW_CAP));
  out.mods.knowledge = r3(out.mods.knowledge + knowFlow);

  // ── 6. ОБРАТНО: наше богатство и слабая армия → соседи наглеют ────────────
  const tempt = temptation(sim);
  let worst = null;
  for (const n of nb) {
    const g = greedOf(n, mine, tempt.value);
    if (g >= GREED_MIN) {
      pushRel(out, n, GREED_REL * g, 'видят добычу');
      const card = {
        fid: n.fid, name: n.name, greed: r3(g), army: Math.round(n.army),
        ours: Math.round(mine), dist: n.dist, rel: Math.round(n.rel),
        text: `${n.name}: их войско ${Math.round(n.army)} против нашего ${Math.round(mine)}, `
          + `в казне ${Math.round(tempt.gold)}🪙, до их земель ${n.dist} кл. `
          + `Отношения тают на ${Math.abs(r3(GREED_REL * g))} в день.`,
      };
      out.flags.eyeingUs.push(card);
      if (!worst || g > worst.greed) worst = card;
    } else if (n.tr.aggression >= RESPECT_AGGRESSION && mine >= n.army && n.army >= ARMY_FLOOR && n.w > 0) {
      // Двусторонность: воинственные уважают силу. Это прямой выход из петли —
      // построил войско, и наглость сменилась уважением.
      pushRel(out, n, RESPECT_REL * n.w, 'уважают силу');
    }
  }
  out.flags.threats = out.reasons.threat.slice(0, 3);

  // ── 7. Одобрение сословий ────────────────────────────────────────────────
  const pol = sim.politics && sim.politics.state;
  if (pol && pol.factions) {
    const cur = (fid) => (typeof pol.factions[fid] === 'number' ? pol.factions[fid] : 50);
    const step = (fid, target, dir) => {
      const d = clamp((target - cur(fid)) * APPROACH, -STEP_CAP, STEP_CAP);
      if (dir > 0 && d < 0) return 0;
      if (dir < 0 && d > 0) return 0;
      return r3(d);
    };
    // Военные: угроза без денег — это не угроза, а обещание. Платим — одобряют,
    // не платим — отворачиваются сильнее, чем одобрили бы.
    if (fear > 0.01) {
      const target = unpaid ? 50 - MIL_SPAN * fear : 50 + MIL_SPAN * fear;
      out.mods.approval.military = step('military', target, unpaid ? -1 : 1);
      out.reasons.approval.military = [{
        ru: unpaid ? `Гарнизоны на границе без жалования (страх ${Math.round(fear * 100)}%)`
          : `Казна платит за охрану границ (страх ${Math.round(fear * 100)}%)`,
        v: out.mods.approval.military,
      }];
    }
    // Купцы: опасные дороги и милитаризация против договоров.
    const merchTarget = 50 - MERCH_SPAN * (risk * 0.6 + fear * 0.4) + TRADE_JOY * Math.min(1, partners / 2);
    if (Math.abs(merchTarget - 50) > 0.5) {
      out.mods.approval.merchants = step('merchants', merchTarget, 0);
      const rows = [];
      if (risk > 0.01) rows.push({ ru: `Дороги опасны (${Math.round(risk * 100)}%)`, v: r3(-MERCH_SPAN * risk * 0.6) });
      if (fear > 0.01) rows.push({ ru: 'Граница на замке, торг стеснён', v: r3(-MERCH_SPAN * fear * 0.4) });
      if (partners > 0) rows.push({ ru: `Торговых договоров: ${partners}`, v: r3(TRADE_JOY * Math.min(1, partners / 2)) });
      out.reasons.approval.merchants = rows;
    }
    // Простолюдины: привозное подорожало — это их хлеб и их соль.
    if (risk > 0.01) {
      out.mods.approval.commons = step('commons', 50 - COMMONS_SPAN * risk, -1);
      out.reasons.approval.commons = [{
        ru: `Привозное дороже на ${Math.round((out.mods.priceMult - 1) * 100)}%`,
        v: out.mods.approval.commons,
      }];
    }
  }

  // ── 8. Стабильность ──────────────────────────────────────────────────────
  let stab = STAB_FEAR * fear + STAB_RISK * risk;
  // Награда за спокойные границы: не «просто так», а за настоящее достижение —
  // ни одной войны на подходах, есть с кем торговать и войско не слабее соседей.
  const calm = fear <= 0.01 && risk <= 0.01 && partners > 0
    && nb.every(n => n.army < ARMY_FLOOR || n.w <= 0 || mine >= n.army);
  if (calm) { stab += STAB_CALM; out.flags.calmBorders = true; }
  out.mods.stability = r3(clamp(stab, STAB_FLOOR, STAB_CALM));

  // ── 9. Счастье ───────────────────────────────────────────────────────────
  out.mods.happy = Math.round(clamp(-HAPPY_PER_RISK * risk - HAPPY_PER_FEAR * fear, HAPPY_FLOOR, 0));

  // ── 10. Золото ───────────────────────────────────────────────────────────
  out.mods.gold = r3(tradeGold - caravanLost - guardPaid);

  // ── 11. События: раз в декаду, чтобы журнал не стал лентой цифр ──────────
  if (day > 0 && day % 10 === 0) {
    if (risk > 0.15 && danger.rows.length) {
      out.events.push({
        text: `Дороги небезопасны: ${danger.rows[0].ru}. До нас доходит ${Math.round((1 - risk) * 100)}% караванов, привозное дороже на ${Math.round((out.mods.priceMult - 1) * 100)}%.`,
        type: 'warn',
      });
    }
    if (worst) {
      out.events.push({ text: `${worst.text} Войско или подарок остудят их.`, type: 'bad' });
    }
    if (fear > 0.2 && out.reasons.threat.length) {
      out.events.push({
        text: unpaid
          ? `Гарнизоны на границе не получили жалования: казна пуста, а ${out.reasons.threat[0].ru}. ${SOCIAL_FACTIONS.military.ru} ропщут.`
          : `Казна тратит ${guardPaid}🪙 в день на охрану границ: ${out.reasons.threat[0].ru}. ${SOCIAL_FACTIONS.military.ru} довольны вниманием.`,
        type: unpaid ? 'bad' : 'info',
      });
    }
    if (tradeGold > 0.05) {
      out.events.push({
        text: `Договоры дают ${tradeGold}🪙 в день${out.mods.marketDiscount > 0.005 ? ` и скидку ${Math.round(out.mods.marketDiscount * 100)}% на привозное` : ''}. Партнёров: ${partners}.`,
        type: 'good',
      });
    }
    if (knowFlow > 0.05) {
      out.events.push({ text: `Партнёры делятся учёностью: +${knowFlow}📜 в день. Мы отстаём — и учимся.`, type: 'good' });
    }
    if (calm) {
      out.events.push({ text: 'Границы спокойны, купцы ходят без охраны — держава крепнет.', type: 'good' });
    }
  }

  // ── Итог ─────────────────────────────────────────────────────────────────
  out.flags.quiet = Math.abs(out.mods.gold) < 0.001 && out.mods.knowledge === 0
    && out.mods.happy === 0 && out.mods.stability === 0
    && ESTATES.every(f => out.mods.approval[f] === 0)
    && out.flags.relations.length === 0 && out.flags.copycats.length === 0
    && out.flags.refugees === 0 && out.events.length === 0;
  return out;
}

// Отношения копятся по соседу и режутся общим потолком: за день с одним соседом
// не может случиться больше REL_STEP_CAP, чем бы ни сошлось.
function pushRel(out, n, dRel, why) {
  const rec = out.flags.relations.find(x => x.fid === n.fid);
  if (rec) {
    rec.dRel = r3(clamp(rec.dRel + dRel, -REL_STEP_CAP, REL_STEP_CAP));
    rec.why = `${rec.why}, ${why}`;
    return;
  }
  out.flags.relations.push({
    fid: n.fid, name: n.name,
    dRel: r3(clamp(dRel, -REL_STEP_CAP, REL_STEP_CAP)),
    why,
  });
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// ───────────────────────── Для панели ─────────────────────────

// По строке на соседа: почему он ведёт себя именно так. Ничего не считает
// заново — те же функции, что и в дневной связи, поэтому подсказка не может
// разойтись с механикой.
export function neighborReport(sim) {
  if (!sim || !Array.isArray(sim.factions)) return [];
  const mine = ourStrength(sim);
  const tempt = temptation(sim);
  const ourTechs = (sim.techs && typeof sim.techs.size === 'number') ? sim.techs.size : 0;
  return readNeighbors(sim).map(n => {
    const fear = r3(fearFrom(n, mine));
    const greed = greedOf(n, mine, tempt.value);
    const gap = ourTechs - n.techs;
    let mood;
    if (n.atWarWithUs) mood = 'Война';
    else if (greed >= GREED_MIN) mood = 'Видят добычу';
    else if (n.treaty) mood = 'Торгуют';
    else if (fear > 0.2) mood = 'Грозят силой';
    else if (n.tr.aggression >= RESPECT_AGGRESSION && mine >= n.army) mood = 'Уважают силу';
    else mood = 'Спокойны';
    return {
      fid: n.fid, name: n.name, dist: n.dist, rel: Math.round(n.rel),
      army: Math.round(n.army), ours: Math.round(mine), treaty: n.treaty,
      wars: n.wars, techGap: gap, fear, greed, mood,
      text: `${n.name} (${n.dist} кл.): войско ${Math.round(n.army)} против нашего ${Math.round(mine)}, `
        + `отношения ${Math.round(n.rel)}${n.treaty ? ', торговый договор' : ''}`
        + `${n.wars ? `, воюет (${n.wars})` : ''}. `
        + (greed >= GREED_MIN ? 'Считают нас лёгкой добычей.'
          : fear > 0.2 ? 'Держат нас в страхе.'
            : gap >= COPY_GAP ? 'Отстают и перенимают наше.'
              : gap <= -3 ? 'Впереди нас в ремёслах.' : 'Ведут себя ровно.'),
    };
  });
}

// Одна строка для HUD: во что обходятся соседи сегодня.
export function neighborBreakdown(sim) {
  const L = neighborLinks(sim);
  const parts = [];
  if (Math.abs(L.mods.gold) > 0.005) parts.push(`${L.mods.gold > 0 ? '+' : ''}${L.mods.gold}🪙`);
  if (L.mods.knowledge > 0.005) parts.push(`+${L.mods.knowledge}📜`);
  if (L.mods.routeRisk > 0.01) parts.push(`дороги −${Math.round(L.mods.routeRisk * 100)}%`);
  if (L.flags.fear > 0.01) parts.push(`страх ${Math.round(L.flags.fear * 100)}%`);
  return {
    text: parts.length ? `Соседи: ${parts.join(', ')}` : 'Соседи: тихо',
    rows: [...L.reasons.gold, ...L.reasons.risk],
    links: L,
  };
}

/* ПОДКЛЮЧЕНИЕ

   Файл: app/src/core/systems/integrate.js
   Модуль ничего не мутирует — всё, что меняет мир, делают строки ниже.

1) ИМПОРТ. ЯКОРЬ (строка уникальна в файле):

     import * as LS from './link_survival.js';

   ДОБАВИТЬ СРАЗУ ПОСЛЕ НЕЁ:

     import * as LN from './link_neighbors.js';

2) ВЫЗОВ РАЗ В СУТКИ. ЯКОРЬ (строка уникальна: определение функции ниже
   начинается со слова function и с якорем не совпадает):

     applySurvivalLinks(sim);

   ДОБАВИТЬ СРАЗУ ПОСЛЕ НЕЁ:

     applyNeighborLinks(sim);

   Порядок намеренный: соседи читают уже сложившийся день — казну после налогов
   и стабильность после голода. Иначе охрана границ оплачивалась бы из вчерашних
   денег, а «пустая казна» никогда бы не наступила.

3) В КОНЕЦ ФАЙЛА — применитель:

export function applyNeighborLinks(sim) {
  const L = LN.neighborLinks(sim);
  sim.sys.nbrLinks = L;                 // для HUD: панель читает готовый разбор

  // Деньги: доход с договоров минус недошедшие караваны и охрана границ.
  if (L.mods.gold !== 0) sim.res.gold = Math.max(0, sim.res.gold + L.mods.gold);
  // Чужое ремесло: беженцы-мастера и учёные партнёры.
  if (L.mods.knowledge > 0) sim.res.knowledge += L.mods.knowledge;

  // Сословия и стабильность.
  const pst = sim.politics && sim.politics.state;
  if (pst) {
    for (const [fid, d] of Object.entries(L.mods.approval)) {
      if (!d || pst.factions[fid] == null) continue;
      pst.factions[fid] = Math.max(0, Math.min(100, pst.factions[fid] + d));
    }
    pst.stability = Math.max(0, Math.min(100, pst.stability + L.mods.stability));
  }

  // Беженцы: модуль уже проверил жильё и запас еды, здесь только расселение.
  if (L.flags.refugees > 0) {
    const c = sim.buildings.find(b => b.id === 'campfire' && !b.destroyed)
      || { x: sim.world.startX, y: sim.world.startY };
    for (let i = 0; i < L.flags.refugees; i++) sim.spawnVillager(c.x, c.y);
    sim.addChronicle(`Беженцы от чужой войны осели у нас: ${L.flags.refugees} чел. (день ${sim.day}).`);
  }

  // Копирование технологий. Счётчик ядра — единственная точка входа: civ_ai.js
  // в sync() сам доучит фракции разницу и выберет, что именно она переняла.
  for (const c of L.flags.copycats) {
    const f = sim.faction(c.fid);
    if (f) f.techCount = (f.techCount || 0) + 1;
  }

  // Наглость и уважение: отношения ведёт ядро, у него лог и затухание.
  for (const r of L.flags.relations) {
    if (typeof sim.adjustRel === 'function') sim.adjustRel(r.fid, r.dRel, r.why);
  }

  for (const e of L.events) sim.addLog(e.text, e.type === 'good' ? 'good' : e.type);
  return L;
}

4) СЧАСТЬЕ. ЯКОРЬ в systemsHappyMod() (строка уникальна в файле):

     + LS.survivalHappyMod(sim);

   ЗАМЕНИТЬ НА:

     + LS.survivalHappyMod(sim)
     + (sim.sys.nbrLinks ? sim.sys.nbrLinks.mods.happy : 0);

5) СЕЙВ ТРОГАТЬ НЕ НУЖНО: модуль без памяти, всё выводится из sim заново.

6) НЕОБЯЗАТЕЛЬНО, ради чего всё и делалось — объяснения в HUD:

     LN.neighborReport(sim)        // строка на соседа: почему он так себя ведёт
     LN.neighborBreakdown(sim)     // «Соседи: +1.2🪙, дороги −45%, страх 30%»
     sim.sys.nbrLinks.reasons      // готовые строки: золото, опасность, угрозы
     sim.sys.nbrLinks.flags.eyeingUs   // кто и почему смотрит на нас как на добычу

   Ещё два числа модуль отдаёт для рынка, но их применение — в simulation.js, и
   потому в этот файл не входит (по желанию главного разработчика):
     mods.priceMult      // множитель к цене привозного при опасных дорогах
     mods.marketDiscount // скидка партнёров; можно домножить в marketBuy()
*/
