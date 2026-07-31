// core/systems/politics.js — Политика: формы правления, стабильность, внутренние
// фракции общества, правитель с чертами и наследованием, национальные доктрины.
//
// Чистый модуль: без DOM. Вся случайность — только через переданный rng
// (createRng из core/rng.js) либо sim.rng внутри системы. Законы НЕ дублируются:
// модуль читает флаги уже принятых законов из laws.js и переводит их в реакцию
// сословий по таблице LAW_STANCES.
//
// Устройство по частям:
//  1. Формы правления — не флаги, а наборы числовых множителей + скорость роста
//     стабильности. Смена строя стоит стабильности и включает смуту на N дней.
//  2. Стабильность 0..100 — отдельный медленный ресурс. Растёт от порядка и
//     довольных сословий, падает от войн, смуты и злых сословий. Ноль — восстание.
//  3. Пять сословий (знать, жрецы, купцы, простолюдины, военные) с одобрением
//     0..100. Каждый флаг закона из laws.js двигает одобрение по LAW_STANCES.
//  4. Правитель: 2–3 черты-модификатора, старение, смерть — кризис преемственности,
//     тяжесть которого зависит от формы правления.
//  5. Доктрины: 3 ветки по 4 ступени. Ступень открывается только после предыдущей
//     и не раньше своей эпохи; взятое не отменяется — функции отката нет намеренно.
// Итог для ядра — politicsMult(state, kind): одно произведение всех влияний.

import { NAMES } from '../data.js';
import { lawFlags } from './laws.js';

// ---------- Настройки ----------
export const STAB_START = 60;
export const GOV_CHANGE_COST = 25;      // цена реформы в стабильности
export const GOV_CHANGE_MIN_STAB = 35;  // в кризис строй не меняют — некому
export const TURMOIL_DAYS = 18;         // смута после смены строя
export const REVOLT_FLOOR = 30;         // после восстания порядок наводят силой
export const REVOLT_COOLDOWN = 60;      // два восстания подряд не бывают
export const REVOLT_SHOCK_DAYS = 15;    // сколько дней восстание давит на счастье
export const REVOLT_SHOCK_HAPPY = -8;
export const TURMOIL_HAPPY = -10;
// Экономика в смуту проседает вся разом: люди заняты переделом власти.
export const TURMOIL_MULT = { gather: 0.85, gold: 0.85, industry: 0.85, knowledge: 0.85, build: 0.85, unrest: 1.5 };
export const FACTION_ANGRY = 25;        // ниже — сословие саботирует своё ремесло
export const FACTION_HAPPY = 60;        // выше — сословие считается довольным
export const DOCTRINE_MIN_STAB = 30;
export const DOCTRINE_STAB_COST = 5;
// Эпохи-ворота ступеней доктрин: глубокие идеи требуют зрелого общества.
export const DOCTRINE_ERA_GATE = [1, 3, 5, 7];

// ---------- Формы правления ----------
// Порядок массива — исторический путь: вождество → монархия → республика →
// империя → федерация. Прыгать через ступени можно (реформа любая, была бы
// эпоха), путь — только подсказка для интерфейса.
export const GOVERNMENTS = [
  {
    id: 'chiefdom', ru: 'Вождество', era: 0,
    text: 'Вождь у костра: все свои, всё просто. Большому хозяйству такой уклад тесен.',
    mult: { gather: 1.05, knowledge: 0.9 }, happy: 2, stabPerDay: 0.3,
    // Кому этот строй по душе: применяется один раз при его установлении.
    stances: { commons: 5, military: 0, nobles: -5, clergy: 0, merchants: 0 },
  },
  {
    id: 'monarchy', ru: 'Монархия', era: 2,
    text: 'Одна корона, одна воля. Строится быстро, воюется охотно, спорить не принято.',
    mult: { army: 1.15, build: 1.1, knowledge: 0.95, unrest: 0.9 }, happy: -2, stabPerDay: 0.5,
    stances: { nobles: 10, military: 5, commons: -5, clergy: 3, merchants: 0 },
  },
  {
    id: 'republic', ru: 'Республика', era: 3,
    text: 'Власть выборная, казна торговая. Шумно, богато, армия — по остаточному принципу.',
    mult: { gold: 1.15, knowledge: 1.15, army: 0.9, unrest: 1.1 }, happy: 6, stabPerDay: 0.2,
    stances: { merchants: 8, commons: 8, nobles: -10, clergy: -3, military: -3 },
  },
  {
    id: 'empire', ru: 'Империя', era: 4,
    text: 'Легионы и дороги. Порядок держится страхом, а страх — легионами.',
    mult: { army: 1.25, gather: 1.1, unrest: 0.8, growth: 0.95 }, happy: -5, stabPerDay: 0.4,
    stances: { military: 10, nobles: 5, commons: -8, clergy: 0, merchants: -3 },
  },
  {
    id: 'federation', ru: 'Федерация', era: 7,
    text: 'Союз равных земель: договор вместо трона. Медленно решает, но никого не теряет.',
    mult: { gold: 1.2, knowledge: 1.2, growth: 1.1, army: 0.95 }, happy: 8, stabPerDay: 0.6,
    stances: { merchants: 6, commons: 6, nobles: -3, clergy: 0, military: -3 },
  },
];
const GOV_BY_ID = Object.fromEntries(GOVERNMENTS.map(g => [g.id, g]));

// ---------- Сословия ----------
export const SOCIAL_FACTIONS = {
  nobles:    { ru: 'Знать' },
  clergy:    { ru: 'Жрецы' },
  merchants: { ru: 'Купцы' },
  commons:   { ru: 'Простолюдины' },
  military:  { ru: 'Военные' },
};

// Злое сословие (одобрение < FACTION_ANGRY) саботирует своё ремесло.
export const FACTION_DOMAIN = {
  commons:   { kind: 'gather', mult: 0.9 },
  merchants: { kind: 'gold',   mult: 0.88 },
  military:  { kind: 'army',   mult: 0.88 },
  nobles:    { kind: 'build',  mult: 0.9 },
  clergy:    { kind: 'growth', mult: 0.92 },
};

// Таблица: флаг принятого закона (laws.js) → сдвиги одобрения сословий.
// Каждый закон радует одних и злит других — бесплатных решений нет.
export const LAW_STANCES = {
  hearth_children:  { commons: 8, military: -3 },
  hearth_hunters:   { commons: -5, military: 5 },
  child_labor:      { merchants: 8, nobles: 4, commons: -10 },
  schools:          { clergy: 5, commons: 5, merchants: -3 },
  militia:          { commons: 6, military: -6, nobles: -4 },
  retinue:          { military: 8, nobles: 5, commons: -8 },
  open_gates:       { merchants: 8, commons: -4, clergy: -3 },
  closed_gates:     { clergy: 4, commons: 4, merchants: -8 },
  assembly:         { commons: 10, merchants: 3, nobles: -8 },
  council:          { nobles: 10, commons: -7 },
  faith:            { clergy: 12, commons: 4, merchants: -3 },
  scholars:         { merchants: 3, nobles: 2, clergy: -10 },
  free_press:       { commons: 6, merchants: 4, nobles: -5, clergy: -4 },
  censorship:       { nobles: 5, clergy: 4, commons: -7 },
  land_to_tillers:  { commons: 12, nobles: -12 },
  landlords:        { nobles: 10, commons: -10 },
  long_shift:       { merchants: 8, commons: -12 },
  short_shift:      { commons: 10, merchants: -6 },
  conscription:     { military: 10, commons: -6, merchants: -3 },
  universal_school: { commons: 6, clergy: -3, military: -6 },
  privacy:          { commons: 7, merchants: 4, military: -5 },
  surveillance:     { military: 6, nobles: 4, commons: -10, merchants: -4 },
  machine_rule:     { merchants: 6, military: 4, commons: -8, clergy: -8 },
  human_rule:       { commons: 8, clergy: 6, merchants: -3 },
};

// ---------- Черты правителя ----------
export const RULER_TRAITS = [
  { id: 'warlord',     ru: 'Полководец',    mult: { army: 1.15 } },
  { id: 'builder',     ru: 'Зодчий',        mult: { build: 1.15 } },
  { id: 'sage',        ru: 'Мудрец',        mult: { knowledge: 1.15 } },
  { id: 'trader',      ru: 'Торгаш',        mult: { gold: 1.12 } },
  { id: 'just',        ru: 'Справедливый',  stabPerDay: 0.3, happy: 3 },
  { id: 'cruel',       ru: 'Жестокий',      mult: { unrest: 0.8 }, happy: -5 },
  { id: 'weak',        ru: 'Слабовольный',  stabPerDay: -0.3, mult: { army: 0.92 } },
  { id: 'beloved',     ru: 'Любимец толпы', happy: 5, stabPerDay: 0.1 },
];
const TRAIT_BY_ID = Object.fromEntries(RULER_TRAITS.map(t => [t.id, t]));
// Взаимоисключающие пары: правитель не бывает разом справедливым и жестоким.
const TRAIT_CONFLICTS = [['just', 'cruel'], ['weak', 'warlord'], ['cruel', 'beloved']];

// Тяжесть кризиса преемственности зависит от строя: у республики есть процедура,
// у вождества — только усобица.
export const SUCCESSION = {
  chiefdom:   { stab: 20, turmoil: 8, ru: 'усобица: род пошёл на род' },
  monarchy:   { stab: 10, turmoil: 4, ru: 'наследник принял корону под ропот дворца' },
  republic:   { stab: 5,  turmoil: 0, ru: 'выборы прошли по закону' },
  empire:     { stab: 12, turmoil: 5, ru: 'легионы спорили, чьим будет трон' },
  federation: { stab: 4,  turmoil: 0, ru: 'совет земель назвал преемника за день' },
};

// ---------- Доктрины ----------
// Три ветки по четыре ступени. Ступень N требует ступень N−1 той же ветки и
// эпоху DOCTRINE_ERA_GATE[N]. Отката нет: выбранное — навсегда.
export const DOCTRINES = [
  {
    id: 'power', ru: 'Держава', tiers: [
      { ru: 'Железная дисциплина', mult: { army: 1.08 } },
      { ru: 'Военные трактаты',    mult: { army: 1.08, trainCost: 0.92 } },
      { ru: 'Гарнизонное право',   mult: { raid: 0.85, unrest: 0.9 } },
      { ru: 'Народ-войско',        mult: { army: 1.12, upkeep: 0.9 }, happy: -4 },
    ],
  },
  {
    id: 'coin', ru: 'Прибыль', tiers: [
      { ru: 'Честная мера',        mult: { gold: 1.08 } },
      { ru: 'Гильдейские хартии',  mult: { market: 1.12, gold: 1.05 } },
      { ru: 'Вексельное право',    mult: { caravan: 1.15, gold: 1.05 } },
      { ru: 'Невидимая рука',      mult: { gold: 1.12, industry: 1.08 }, happy: -2 },
    ],
  },
  {
    id: 'mind', ru: 'Просвещение', tiers: [
      { ru: 'Уважение к письму',   mult: { knowledge: 1.08 } },
      { ru: 'Открытые школы',      mult: { knowledge: 1.08, techCost: 0.95 }, happy: 2 },
      { ru: 'Академии провинций',  mult: { knowledge: 1.1, medicine: 0.92 } },
      { ru: 'Республика учёных',   mult: { knowledge: 1.15, techCost: 0.9 }, happy: 2 },
    ],
  },
];
const DOCTRINE_BY_ID = Object.fromEntries(DOCTRINES.map(d => [d.id, d]));

// ---------- Состояние ----------
export function createPolitics(rng) {
  return {
    gov: 'chiefdom', govSince: 0,
    turmoil: 0,                       // осталось дней смуты
    stability: STAB_START,
    revoltCd: 0, revoltShock: 0, revolts: 0,
    factions: { nobles: 55, clergy: 55, merchants: 55, commons: 55, military: 55 },
    seenFlags: [],                    // какие флаги законов уже учтены сословиями
    ruler: rng ? createRuler(rng, 0) : null,
    rulersCount: rng ? 1 : 0,
    doctrines: { power: 0, coin: 0, mind: 0 },   // достигнутая ступень (0 = нет)
  };
}

export function serializePolitics(state) {
  const s = state || createPolitics();
  return JSON.parse(JSON.stringify(s));
}

export function deserializePolitics(data, rng) {
  // rng не трогаем, если правитель есть в сейве: лишний бросок сдвинул бы
  // детерминированный поток случайностей относительно непрерывной партии.
  if (!data || typeof data !== 'object') return createPolitics(rng);
  const s = createPolitics();
  if (GOV_BY_ID[data.gov]) s.gov = data.gov;
  s.govSince = num(data.govSince, 0);
  s.turmoil = Math.max(0, num(data.turmoil, 0));
  s.stability = clamp(num(data.stability, STAB_START), 0, 100);
  s.revoltCd = Math.max(0, num(data.revoltCd, 0));
  s.revoltShock = Math.max(0, num(data.revoltShock, 0));
  s.revolts = Math.max(0, num(data.revolts, 0));
  for (const id of Object.keys(SOCIAL_FACTIONS)) {
    s.factions[id] = clamp(num(data.factions && data.factions[id], 55), 0, 100);
  }
  s.seenFlags = Array.isArray(data.seenFlags) ? data.seenFlags.filter(f => typeof f === 'string') : [];
  if (data.ruler && Array.isArray(data.ruler.traits)) {
    s.ruler = {
      name: String(data.ruler.name || 'Безымянный'),
      age: clamp(num(data.ruler.age, 30), 14, 120),
      since: num(data.ruler.since, 0),
      traits: data.ruler.traits.filter(t => TRAIT_BY_ID[t]),
    };
  }
  if (!s.ruler && rng) s.ruler = createRuler(rng, 0);
  s.rulersCount = Math.max(s.ruler ? 1 : 0, num(data.rulersCount, 0));
  for (const d of DOCTRINES) {
    s.doctrines[d.id] = clamp(Math.round(num(data.doctrines && data.doctrines[d.id], 0)), 0, d.tiers.length);
  }
  return s;
}

// ---------- Контекст ----------
// Всё, что политике нужно знать о мире, — несколько чисел. Никаких объектов ядра.
function readCtx(ctx) {
  const o = ctx || {};
  return {
    day: Math.max(0, Math.round(num(o.day, 0))),
    era: Math.max(0, Math.round(num(o.era, 0))),
    happy: clamp(num(o.happy, 50), 0, 100),
    wars: Math.max(0, Math.round(num(o.wars, 0))),
    pop: Math.max(0, Math.round(num(o.pop, 0))),
  };
}

// ---------- Формы правления ----------
export function availableGovernments(era) {
  return GOVERNMENTS.filter(g => g.era <= era).map(g => ({ id: g.id, ru: g.ru, era: g.era, text: g.text }));
}

export function canChangeGovernment(state, id, ctx) {
  const s = state, c = readCtx(ctx);
  const g = GOV_BY_ID[id];
  if (!g) return { ok: false, reason: 'Такого строя не существует' };
  if (s.gov === id) return { ok: false, reason: `${g.ru} уже установлена` };
  if (c.era < g.era) return { ok: false, reason: `${g.ru}: рано, нужна эпоха ${g.era}` };
  if (s.turmoil > 0) return { ok: false, reason: 'В смуту строй не меняют' };
  if (s.stability < GOV_CHANGE_MIN_STAB) return { ok: false, reason: 'Слишком шатко: сперва наведите порядок' };
  return { ok: true };
}

export function changeGovernment(state, id, ctx) {
  const chk = canChangeGovernment(state, id, ctx);
  if (!chk.ok) return chk;
  const c = readCtx(ctx);
  const g = GOV_BY_ID[id];
  state.gov = id;
  state.govSince = c.day;
  state.stability = clamp(state.stability - GOV_CHANGE_COST, 0, 100);
  state.turmoil = TURMOIL_DAYS;
  for (const [fid, d] of Object.entries(g.stances)) shiftFaction(state, fid, d);
  return {
    ok: true, gov: id, ru: g.ru, turmoil: TURMOIL_DAYS,
    log: `⚖ Реформа: установлена ${g.ru}. Страна входит в смуту на ${TURMOIL_DAYS} дн.`,
  };
}

export function government(state) { return GOV_BY_ID[state.gov] || GOVERNMENTS[0]; }

// ---------- Сословия ----------
function shiftFaction(state, id, d) {
  if (state.factions[id] == null) return;
  state.factions[id] = clamp(state.factions[id] + d, 0, 100);
}

// Новые флаги законов (принятых через laws.js) переводятся в реакцию сословий.
// Каждый флаг учитывается один раз — seenFlags помнит уже пережитое.
export function applyLawFlags(state, flags) {
  const out = [];
  for (const f of flags || []) {
    if (state.seenFlags.includes(f)) continue;
    state.seenFlags.push(f);
    const st = LAW_STANCES[f];
    if (!st) continue;
    for (const [fid, d] of Object.entries(st)) shiftFaction(state, fid, d);
    const parts = Object.entries(st).map(([fid, d]) => `${SOCIAL_FACTIONS[fid].ru} ${sign(d)}`);
    out.push({ flag: f, text: `Сословия о новом законе: ${parts.join(', ')}.` });
  }
  return out;
}

export function avgApproval(state) {
  const v = Object.values(state.factions);
  return v.reduce((a, b) => a + b, 0) / v.length;
}

export function angryFactions(state) {
  return Object.keys(state.factions).filter(id => state.factions[id] < FACTION_ANGRY);
}

// ---------- Правитель ----------
export function createRuler(rng, day) {
  // Черт 2 или 3; конфликтующие пары (жестокий+любимец и т.п.) не сочетаются.
  const count = rng.chance(0.4) ? 3 : 2;
  const traits = [];
  let guard = 0;
  while (traits.length < count && guard++ < 50) {
    const t = rng.pick(RULER_TRAITS).id;
    if (traits.includes(t)) continue;
    if (TRAIT_CONFLICTS.some(([a, b]) => (t === a && traits.includes(b)) || (t === b && traits.includes(a)))) continue;
    traits.push(t);
  }
  return { name: rng.pick(NAMES), age: rng.int(28, 45), since: num(day, 0), traits };
}

export function rulerTitle(state) {
  const g = government(state);
  const t = { chiefdom: 'Вождь', monarchy: 'Монарх', republic: 'Консул', empire: 'Император', federation: 'Президент' }[g.id] || 'Правитель';
  return state.ruler ? `${t} ${state.ruler.name}` : t;
}

export function rulerCard(state) {
  if (!state.ruler) return null;
  return {
    title: rulerTitle(state),
    age: Math.floor(state.ruler.age),
    traits: state.ruler.traits.map(id => ({ id, ru: TRAIT_BY_ID[id].ru })),
  };
}

// Дневной шанс смерти: до 50 лет почти нулевой, дальше удваивается каждые 8 лет.
// К 90 годам это ~0.6% в день — правитель редко доживает.
export function deathChance(age) {
  if (age < 50) return 0.0001;
  return Math.min(0.02, 0.0004 * Math.pow(2, (age - 50) / 8));
}

// Смерть правителя: кризис по тяжести строя, новый правитель — сразу
// (междуцарствие моделируется смутой, а не пустым троном).
export function successionCrisis(state, ctx, rng) {
  const c = readCtx(ctx);
  const g = government(state);
  const suc = SUCCESSION[g.id] || SUCCESSION.chiefdom;
  const dead = state.ruler;
  state.stability = clamp(state.stability - suc.stab, 0, 100);
  state.turmoil = Math.max(state.turmoil, suc.turmoil);
  state.ruler = createRuler(rng, c.day);
  state.rulersCount++;
  return {
    dead: dead ? dead.name : '—', heir: state.ruler.name,
    stab: suc.stab, turmoil: suc.turmoil,
    log: `✝ ${dead ? dead.name : 'Правитель'} умирает. Кризис преемственности: ${suc.ru}. ` +
      `Стабильность −${suc.stab}. Правит теперь ${state.ruler.name}.`,
  };
}

// ---------- Доктрины ----------
export function doctrineNext(state, branchId) {
  const d = DOCTRINE_BY_ID[branchId];
  if (!d) return null;
  const tier = state.doctrines[branchId] || 0;
  if (tier >= d.tiers.length) return null;
  return { branch: branchId, tier: tier + 1, ru: d.tiers[tier].ru, eraNeed: DOCTRINE_ERA_GATE[tier] };
}

export function canPickDoctrine(state, branchId, ctx) {
  const c = readCtx(ctx);
  const nx = doctrineNext(state, branchId);
  if (!nx) return { ok: false, reason: 'Ветка не существует или уже завершена' };
  if (c.era < nx.eraNeed) return { ok: false, reason: `«${nx.ru}»: рано, нужна эпоха ${nx.eraNeed}` };
  if (state.stability < DOCTRINE_MIN_STAB) return { ok: false, reason: 'Стране не до идей: стабильность слишком низка' };
  return { ok: true, next: nx };
}

// Взятие ступени необратимо: функции отката в модуле нет и не будет.
export function pickDoctrine(state, branchId, ctx) {
  const chk = canPickDoctrine(state, branchId, ctx);
  if (!chk.ok) return chk;
  state.doctrines[branchId]++;
  state.stability = clamp(state.stability - DOCTRINE_STAB_COST, 0, 100);
  const d = DOCTRINE_BY_ID[branchId];
  return {
    ok: true, branch: branchId, tier: state.doctrines[branchId],
    log: `✦ Доктрина принята: ${d.ru} — «${chk.next.ru}» (ступень ${state.doctrines[branchId]} из ${d.tiers.length}).`,
  };
}

// ---------- Итоговые модификаторы ----------
// Одно произведение всех политических влияний по виду деятельности.
// Незнакомый kind всегда даёт 1 — ядро может звать что угодно.
export function politicsMult(state, kind) {
  let m = 1;
  const g = government(state);
  if (g.mult[kind]) m *= g.mult[kind];
  if (state.turmoil > 0 && TURMOIL_MULT[kind]) m *= TURMOIL_MULT[kind];
  if (state.ruler) {
    for (const tid of state.ruler.traits) {
      const t = TRAIT_BY_ID[tid];
      if (t && t.mult && t.mult[kind]) m *= t.mult[kind];
    }
  }
  for (const d of DOCTRINES) {
    const tier = state.doctrines[d.id] || 0;
    for (let i = 0; i < tier; i++) if (d.tiers[i].mult[kind]) m *= d.tiers[i].mult[kind];
  }
  for (const fid of angryFactions(state)) {
    const dom = FACTION_DOMAIN[fid];
    if (dom && dom.kind === kind) m *= dom.mult;
  }
  return m;
}

// Плоская добавка к счастью от политики (суммируется со счастьем ядра).
export function politicsHappy(state) {
  let h = government(state).happy || 0;
  if (state.ruler) for (const tid of state.ruler.traits) h += TRAIT_BY_ID[tid] && TRAIT_BY_ID[tid].happy || 0;
  for (const d of DOCTRINES) {
    const tier = state.doctrines[d.id] || 0;
    for (let i = 0; i < tier; i++) h += d.tiers[i].happy || 0;
  }
  if (state.turmoil > 0) h += TURMOIL_HAPPY;
  if (state.revoltShock > 0) h += REVOLT_SHOCK_HAPPY;
  return Math.round(h);
}

// ---------- Ежедневный ход ----------
// Возвращает события [{text, type}] и (при восстании) revolt: true. Сама ничего
// не пишет в лог — это дело ядра.
export function dailyPolitics(state, ctx, rng) {
  const c = readCtx(ctx);
  const out = [];
  if (!state.ruler && rng) { state.ruler = createRuler(rng, c.day); state.rulersCount = Math.max(1, state.rulersCount); }

  if (state.turmoil > 0) state.turmoil--;
  if (state.revoltCd > 0) state.revoltCd--;
  if (state.revoltShock > 0) state.revoltShock--;

  // Сословия медленно остывают к 50: без новых поводов ни любовь, ни злоба не вечны.
  for (const fid of Object.keys(state.factions)) {
    const v = state.factions[fid];
    state.factions[fid] = v + clamp(50 - v, -0.05, 0.05);
  }
  // Война кормит военных и разоряет купцов.
  if (c.wars > 0) { shiftFaction(state, 'military', 0.1); shiftFaction(state, 'merchants', -0.1); }

  // Стабильность: порядок против хаоса, все слагаемые — маленькие и дневные.
  let dS = 0.2 + government(state).stabPerDay;
  if (state.ruler) for (const tid of state.ruler.traits) dS += TRAIT_BY_ID[tid] && TRAIT_BY_ID[tid].stabPerDay || 0;
  if (c.happy >= 60) dS += 0.3; else if (c.happy < 35) dS -= 0.5;
  dS -= Math.min(c.wars, 3) * 0.4;
  const avg = avgApproval(state);
  if (avg >= FACTION_HAPPY) dS += 0.3; else if (avg <= 35) dS -= 0.5;
  dS -= angryFactions(state).length * 0.2;
  if (state.turmoil > 0) dS -= 1.0;
  state.stability = clamp(state.stability + dS, 0, 100);

  // Восстание: стабильность на нуле. Порядок вернут силой, но осадок останется.
  if (state.stability <= 0 && state.revoltCd <= 0) {
    state.revolts++;
    state.revoltCd = REVOLT_COOLDOWN;
    state.revoltShock = REVOLT_SHOCK_DAYS;
    state.stability = REVOLT_FLOOR;
    // Бунт выпускает пар: простолюдины чуть отходят, знать напугана.
    shiftFaction(state, 'commons', 8);
    shiftFaction(state, 'nobles', -5);
    out.push({ text: '🔥 ВОССТАНИЕ! Толпа на площадях, склады горят. Порядок наведён силой.', type: 'bad', revolt: true });
  }

  // Правитель стареет (год = 100 дней) и однажды умирает.
  if (state.ruler && rng) {
    state.ruler.age += 1 / 100;
    if (rng.chance(deathChance(state.ruler.age))) {
      const r = successionCrisis(state, c, rng);
      out.push({ text: r.log, type: 'warn', succession: r });
    }
  }
  return out;
}

// ---------- Система для simulation.js ----------
export function createPoliticsSystem(rng) {
  const sys = {
    state: createPolitics(rng),
    onNewDay(sim) {
      // Флаги уже принятых законов — из laws.js: политика их не дублирует, а читает.
      if (sim.laws) {
        for (const e of applyLawFlags(sys.state, lawFlags(sim.laws))) sim.addLog(e.text);
      }
      const ctx = {
        day: sim.day, era: sim.eraIndex,
        happy: sim._happy != null ? sim._happy : (typeof sim.happiness === 'function' ? sim.happiness() : 50),
        wars: Array.isArray(sim.wars) ? sim.wars.length : 0,
        pop: sim.villagers ? sim.villagers.length : 0,
      };
      for (const e of dailyPolitics(sys.state, ctx, sim.rng)) {
        sim.addLog(e.text, e.type);
        if (e.revolt && typeof sim.toast === 'function') sim.toast('Восстание! Стабильность рухнула до нуля.');
        if (e.revolt && sim.res) {
          // Бунт грабит склады: минус пятая часть еды и золота — цена нуля стабильности.
          sim.res.food = Math.max(0, sim.res.food * 0.8);
          sim.res.gold = Math.max(0, sim.res.gold * 0.8);
        }
      }
    },
    serialize() { return serializePolitics(sys.state); },
    deserialize(data, rng2) { sys.state = deserializePolitics(data, rng2); },
  };
  return sys;
}

// ---------- Внутреннее ----------
function sign(v) { return `${v > 0 ? '+' : '−'}${Math.abs(v)}`; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function num(v, def) { return Number.isFinite(v) ? v : def; }

/* ИНТЕГРАЦИЯ (точные строки для simulation.js)
1) Импорт, рядом с прочими системами:
     import { createPoliticsSystem, politicsMult, politicsHappy, availableGovernments,
       changeGovernment, pickDoctrine, rulerCard } from './systems/politics.js';

2) constructor(), после this.laws:
     this.politics = createPoliticsSystem(this.rng);

3) onNewDay(), после блока законов (Laws.observe):
     this.politics.onNewDay(this);

4) globalMult(kind), последней строкой перед return mult:
     mult *= politicsMult(this.politics.state, kind);

5) happiness(), рядом с h += Laws.lawHappy(this.laws):
     h += politicsHappy(this.politics.state);

6) Действия игрока (кнопки HUD):
     reformGovernment(id) {
       const r = changeGovernment(this.politics.state, id, { day: this.day, era: this.eraIndex });
       if (r.ok) this.addLog(r.log, 'warn'); else this.toast(r.reason);
       return r;
     }
     adoptDoctrine(branch) {
       const r = pickDoctrine(this.politics.state, branch, { day: this.day, era: this.eraIndex });
       if (r.ok) this.addLog(r.log, 'good'); else this.toast(r.reason);
       return r;
     }
   Список кнопок строя: availableGovernments(this.eraIndex);
   карточка правителя для панели: rulerCard(this.politics.state).

7) serialize():   politics: this.politics.serialize(),
   deserialize(): sim.politics.deserialize(data.politics, sim.rng);
   Старый сейв без поля грузится: вернётся чистое состояние с вождеством.
*/
