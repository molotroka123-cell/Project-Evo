// core/systems/dynasty.js — МОДЕЛЬ: у власти стоит РОД, а не сменный человек.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. Сейчас правитель умирает — и politics.js через createRuler()
// подставляет совершенно нового случайного человека. Ни семьи, ни наследника,
// ни рода. Для игрока это значит, что власть — погода: она случается с тобой,
// к ней нельзя привязаться, её нельзя ненавидеть, за неё нельзя бояться.
// Наследование при этом не наследование, а подмена объекта.
//
// Здесь на трон встаёт СЕМЬЯ: правитель, супруг, дети, братья. У каждого имя,
// возраст, пол и черты. Наследник — конкретный человек, за которым можно
// следить и который может не дожить. Отсюда всё остальное: смысл женитьб,
// смысл запасного наследника, ужас перед пресечением рода.
//
// ЧИСТАЯ МОДЕЛЬ. Модуль НИЧЕГО не знает про sim и ничего в нём не пишет.
// Он получает СВОЁ состояние и снимок мира (ctx), а возвращает НОВОЕ состояние
// и отчёт { state, mods, reasons, events, flags }. Входное состояние не
// мутируется — это проверено тестом снимком JSON до и после. Применяет отчёт
// integrate.js (точные строки — в блоке ПОДКЛЮЧЕНИЕ в конце файла).
//
// НЕ ВТОРАЯ МОДЕЛЬ ЧЕЛОВЕКА. Возраст здесь считается ровно так же, как у
// жителей в population.js: v.age — это ДНИ, 100 дней = год (DAYS_PER_SEASON×4),
// ageYears() — общая функция, кривая смертности — общая annualMortality().
// Черты правителя — RULER_TRAITS из politics.js, второй таблицы черт нет.
// Расхождение единиц было бы тихой бедой: politics.js держит ruler.age В ГОДАХ
// (там age += 1/100 в сутки), поэтому на границе — и только на границе, в
// politicsRuler() — дни переводятся в годы.
//
// ГДЕ ПОТОЛКИ И ГДЕ ВЫХОДЫ (правило «у каждой петли потолок и выход»):
//   · законность — жёстко 0…100, плюс дневная тяга к «своему уровню» рода
//     (baseLegitimacy). Даже разорённый род сам отползает вверх, если беды
//     прекратились: 30 очков законности отрастают примерно за 8 лет. Без этой
//     тяги первая же чёрная полоса делала бы партию непоправимой;
//   · претенденты — не больше MAX_CLAIMANTS = 2, появляются ниже
//     CLAIM_BELOW = 35 и уходят выше CLAIM_CLEAR = 55. Разные пороги (гистерезис)
//     намеренно: иначе претендент мигал бы через день у самой границы.
//     Претендент давит стабильность, но НЕ давит законность — иначе получилась
//     бы спираль «низкая законность → претендент → ещё ниже законность»,
//     из которой нет выхода;
//   · регентство при малолетнем правителе — потолок по времени: кончается
//     ровно в ADULT_YEARS, само собой;
//   · междуцарствие — потолок INTERREGNUM_DAYS. По их истечении трон
//     ЗАНИМАЮТ: сильнейший претендент или новый род из поселения. Пустой трон
//     навсегда — это партия без власти, то есть партия без игры;
//   · содержание двора — три ступени, переключаются в обе стороны в любой день;
//   · подношение двору — откат PATRON_CD, иначе законность покупалась бы
//     нажатием кнопки каждый день.
//
// ПАМЯТЬ ХРАНИТ СОБЫТИЯ, А НЕ СОСТОЯНИЯ. Разовые удары по законности (поражение,
// потерянный город, голод, мор, бунт) приходят списком ctx.events и учитываются
// ОДИН РАЗ на сезон через seen-окно. Наивно было бы каждый день читать «у нас
// голод» из состояния мира и каждый день снимать законность: голодная зима
// длится месяц, и род терял бы 200 очков там, где заслужил 7. На этом уже
// обожглись в link_memory.js — там мор писался заново, пока лежали больные.
//
// СЛУЧАЙНОСТЬ ТОЛЬКО ЧЕРЕЗ ПЕРЕДАННЫЙ rng. Math.random здесь запрещён: на
// детерминизме держатся сохранения и «тень прошлой партии». Функции, которым
// rng не нужен (наследник, законность, карточка), не берут его вовсе — их
// безопасно звать из рендера сколько угодно раз.

import { NAMES, NICKNAMES, DAYS_PER_SEASON } from '../data.js';
import { RULER_TRAITS, SUCCESSION } from './politics.js';
import { annualMortality, ageYears, plural } from './population.js';

// ---------- Единицы времени ----------

export const YEAR = DAYS_PER_SEASON * 4;      // 100 дней, как везде в игре
export const ADULT_YEARS = 16;                // совпадает с ADULT_AGE в population.js
export const MARRY_MIN = 17;                  // PAIR_MIN там же
export const MARRY_MAX = 55;                  // PAIR_MAX там же
export const FERT_MIN = 18, FERT_MAX = 42;    // окно фертильности, то же

// Двор кормлен и лечен: княжич умирает реже пахаря, но не бессмертен.
// Множитель к общей кривой annualMortality, а не своя вторая кривая.
export const ROYAL_MORT = 0.85;

// Дневной шанс родов у пары в роду. Выше, чем BIRTH_BASE = 0.0038 у простых
// жителей: у княгини кормилица и не надо жать хлеб. При BIRTH_CD = 200 это даёт
// роду примерно 5–7 детей за женскую жизнь — столько и нужно, чтобы род
// переживал детскую смертность, но не заполонял собой список.
export const BIRTH_BASE = 0.006;
export const BIRTH_CD = 200;                  // два года между родами
// Дневной шанс, что одинокий взрослый член рода найдёт пару в поселении.
export const MARRY_CHANCE = 0.02;

// Черта переходит от родителя с этим шансом. Не 1.0 и не 0: род должен иметь
// узнаваемое лицо («все Кремни — полководцы»), но вырождаться в копии — нет.
export const TRAIT_INHERIT = 0.35;

// Потолок списка живых членов рода. Без потолка разросшийся род раздувает
// каждый сейв и каждую панель; лишние — самые дальние по крови — выбывают
// из учёта (не «умирают», а перестают считаться роднёй трона).
export const MAX_MEMBERS = 40;
export const GRAVE_KEEP = 12;                 // глубина погоста для летописи

// ---------- Законность ----------

export const LEG_START = 50;
export const LEG_MIN = 0, LEG_MAX = 100;
// Тяга к «своему уровню» рода — тот самый выход из ямы. 0.06 в сутки: путь с
// нуля до 50 занимает около восьми лет. Быстрее — законность перестала бы быть
// ресурсом, медленнее — партия после одной беды становилась бы безнадёжной.
export const LEG_DRIFT = 0.06;
export const LEG_BASE_CAP = 75;               // выше сама не отрастает, только делами
export const LEG_ODD_HEIR = 0.10;             // в сутки, пока наследник назначен вопреки закону
export const LEG_NO_HEIR = 0.08;              // в сутки, пока наследника нет вовсе
export const LEG_INTERREGNUM = 0.5;           // в сутки междуцарствия
// Разовые удары и награды. Ложатся ОДИН раз на сезон (см. SEEN_WINDOW).
export const LEG_EVENT = {
  victory:   +6,   // выигранное сражение
  triumph:  +10,   // взятый город, конец войны в свою пользу
  city_won:  +8,
  defeat:    -8,
  city_lost:-12,   // потерянная провинция — самый тяжёлый удар по праву на трон
  famine:    -7,
  plague:    -5,
  revolt:   -10,
};
export const SEEN_WINDOW = DAYS_PER_SEASON;   // 25 дней: беда длиной в сезон — одна беда
// Смена правителя всегда сомнительна. Тяжесть берём из SUCCESSION в politics.js
// (её же читает кризис стабильности) и переводим в законность вдвое мягче:
// у вождества −10, у республики −2.5.
export const LEG_PER_STAB = 0.5;

// ---------- Претенденты ----------
export const CLAIM_BELOW = 35;                // ниже этого появляются
export const CLAIM_CLEAR = 55;                // выше этого расходятся
export const CLAIM_CHANCE = 0.010;            // в сутки, пока законность низка
export const CLAIM_FADE = 0.020;              // в сутки, пока законность высока
export const MAX_CLAIMANTS = 2;
export const CLAIM_STAB = 0.15;               // сколько стабильности стоит один претендент в сутки

// ---------- Междуцарствие и переворот ----------
export const INTERREGNUM_DAYS = 30;
export const INTERREGNUM_STAB = 1.2;          // в сутки: обвал, ради предотвращения которого и женят
export const REGENCY_STAB = 0.25;             // в сутки, пока правитель — ребёнок
export const COUP_LEG = 20;                   // с какой законности начинает узурпатор
export const COUP_STAB = 25;                  // разовая цена переворота
export const COUP_NEED_NOBLES = 40;           // без знати переворот не готовят
export const COUP_NEED_MILITARY = 45;         // и без войска тоже

// ---------- Двор ----------
// Три ступени содержания. Переключаются в любую сторону в любой день — это и
// есть выход из петли «двор дорог».
export const COURT = [
  { id: 0, ru: 'Скупо',        leg: -0.05, gold: 0.0, nobles: -0.03, commons: +0.02, happy: 0 },
  { id: 1, ru: 'По обычаю',    leg: +0.03, gold: 0.6, nobles: +0.01, commons: 0,     happy: 0 },
  { id: 2, ru: 'Пышный двор',  leg: +0.12, gold: 1.8, nobles: +0.05, commons: -0.05, happy: -1 },
];
export const COURT_PER_POP = 0.02;            // двор растёт вместе с державой
export const COURT_UNPAID_LEG = 0.15;         // в сутки, если казна не потянула двор

export const PATRON_COST = 60;                // подношение двору: цена в золоте
export const PATRON_PER_POP = 2;
export const PATRON_LEG = 6;
export const PATRON_CD = 60;                  // откат, иначе законность покупается кнопкой

export const MARRY_REL = 12;                  // прибавка к отношениям за брак с родом соседа
export const MARRY_LEG = 2;
export const FOREIGN_CLAIM = 35;              // сила права, которое чужой род получает на наш трон

export const NAME_HEIR_NOBLES = -6;           // знать не любит, когда закон обходят
export const NAME_HEIR_LEG = -4;

// ---------- Закон наследования ----------
//
// SUCCESSION в politics.js говорит, ЧЕГО СТОИТ смена власти при этом строе.
// Здесь то же самое развёрнуто в ПРАВИЛО: кто именно встаёт на трон.
// Ключи обязаны совпадать с ключами SUCCESSION — это проверяется тестом.
export const SUCCESSION_LAW = {
  chiefdom:   { law: 'strongest',  ru: 'сильнейший из рода' },
  monarchy:   { law: 'eldest_son', ru: 'старший сын' },
  republic:   { law: 'election',   ru: 'выборы: наследника нет' },
  empire:     { law: 'appointed',  ru: 'назначенный' },
  federation: { law: 'council',    ru: 'совет земель' },
};

// Вес черты в «силе» наследника — для закона вождества и для оценки претендента.
// Это НЕ вторая таблица черт: сами черты берутся из RULER_TRAITS, здесь только
// вес каждой в глазах дружины. Тест следит, чтобы ни одна черта не осталась
// без веса, — иначе новая черта в politics.js тихо получила бы нулевую цену.
export const TRAIT_POWER = {
  warlord: 3, beloved: 2, just: 2, cruel: 1, builder: 1, sage: 1, trader: 1, weak: -3,
};

// Взаимоисключающие пары. politics.js держит такой же список, но НЕ экспортирует
// его; дублируем сознательно и с оглядкой: если там появится новая пара, сюда
// её надо перенести руками. Без этой проверки рождались бы «жестокие любимцы
// толпы» — сочетание, которого игра не допускает у правителя.
const TRAIT_CONFLICTS = [['just', 'cruel'], ['weak', 'warlord'], ['cruel', 'beloved']];
const TRAIT_IDS = RULER_TRAITS.map(t => t.id);
const TRAIT_BY_ID = Object.fromEntries(RULER_TRAITS.map(t => [t.id, t]));

// Женские имена в списке ядра оканчиваются на -а/-я; Добрыня — известное
// исключение. Правило повторено из population.js: там оно внутреннее и наружу
// не выведено, а заводить свой второй список имён — верный способ получить
// поселение с одними именами и двор с другими.
const MALE_EXCEPTIONS = new Set(['Добрыня']);
const FEMALE_NAMES = NAMES.filter(n => /[ая]$/.test(n) && !MALE_EXCEPTIONS.has(n));
const MALE_NAMES = NAMES.filter(n => !FEMALE_NAMES.includes(n));

// ============================ СОСТОЯНИЕ ============================

// Всё состояние — простой объект: кладётся в JSON без потерь и читается глазами.
export function createDynasty(rng, opts = {}) {
  const day = numOf(opts.day, 0);
  const st = {
    v: 1,
    day: -1,                  // последние посчитанные сутки; -1 = ещё ни одних
    nextId: 1,
    fam: '—', founder: '—', foundedDay: day,
    generations: 1,
    members: [],
    graves: [],               // погост: кого помнит летопись
    rulerId: null,
    namedHeirId: null,        // назначенный игроком; перебивает закон
    legitimacy: numOf(opts.legitimacy, LEG_START),
    court: 1,
    patronCd: 0,
    claimants: [],
    ties: [],                 // браки с родами соседей
    interregnum: 0,
    seen: [],                 // [{key, day}] — какие удары уже учтены
    stats: { rulers: 0, births: 0, deaths: 0, coups: 0, interregnums: 0, houses: 1 },
  };
  if (!rng) return st;

  st.fam = opts.fam || rng.pick(NICKNAMES);
  // Основатель средних лет: он должен успеть и породить наследников, и умереть
  // на глазах игрока. Тот же разброс, что у createRuler в politics.js.
  const founder = _makeMember(st, rng, {
    sex: rng.chance(0.75) ? 'м' : 'ж',        // вождём чаще, но не всегда, становится мужчина
    ageYears: rng.int(28, 45), day, gen: 1, blood: true,
  });
  st.founder = founder.name;
  st.rulerId = founder.id;
  st.stats.rulers = 1;

  // Супруг и один-два уже рождённых ребёнка: род не начинается с холостяка,
  // иначе первая же болезнь основателя обрывает партию на пятом году.
  const spouse = _makeMember(st, rng, {
    sex: founder.sex === 'м' ? 'ж' : 'м',
    ageYears: Math.max(MARRY_MIN, ageYearsOf(founder) - rng.int(0, 6)),
    day, gen: 1, blood: false, origin: 'married',
  });
  _wed(founder, spouse);
  const kids = rng.int(1, 2);
  for (let i = 0; i < kids; i++) {
    const child = _makeMember(st, rng, {
      sex: rng.chance(0.5) ? 'м' : 'ж',
      ageYears: rng.int(0, 14), day, gen: 2, blood: true,
      father: founder.sex === 'м' ? founder : spouse,
      mother: founder.sex === 'ж' ? founder : spouse,
    });
    child.fam = st.fam;
  }
  return st;
}

export function serializeDynasty(state) {
  return state ? JSON.parse(JSON.stringify(state)) : null;
}

// Восстановление обязано пережить и битый файл, и файл прошлой версии:
// сейв старой партии просто не содержит поля dynasty, и это не повод падать.
export function restoreDynasty(data) {
  const st = createDynasty(null);
  if (!data || typeof data !== 'object') return st;
  st.day = numOf(data.day, -1);
  st.nextId = Math.max(1, Math.round(numOf(data.nextId, 1)));
  st.fam = strOf(data.fam, '—');
  st.founder = strOf(data.founder, '—');
  st.foundedDay = numOf(data.foundedDay, 0);
  st.generations = Math.max(1, Math.round(numOf(data.generations, 1)));
  st.legitimacy = clamp(numOf(data.legitimacy, LEG_START), LEG_MIN, LEG_MAX);
  st.court = clampInt(Math.round(numOf(data.court, 1)), 0, COURT.length - 1);
  st.patronCd = Math.max(0, numOf(data.patronCd, 0));
  st.interregnum = Math.max(0, numOf(data.interregnum, 0));

  if (Array.isArray(data.members)) {
    for (const m of data.members) {
      const r = _restoreMember(m);
      if (r) st.members.push(r);
    }
  }
  const ids = new Set(st.members.map(m => m.id));
  // Ссылки на несуществующих людей чиним молча: битый сейв не должен ронять
  // модуль, а повисшая ссылка на супруга навсегда выводит вдову из брачного
  // круга — на этом уже спотыкались в wire_population.
  for (const m of st.members) {
    if (m.spouse != null && !ids.has(m.spouse)) m.spouse = null;
    if (m.father != null && !ids.has(m.father)) m.father = null;
    if (m.mother != null && !ids.has(m.mother)) m.mother = null;
    st.nextId = Math.max(st.nextId, m.id + 1);
  }
  st.rulerId = ids.has(data.rulerId) ? data.rulerId : null;
  st.namedHeirId = ids.has(data.namedHeirId) ? data.namedHeirId : null;

  if (Array.isArray(data.graves)) {
    st.graves = data.graves.filter(g => g && typeof g === 'object')
      .map(g => ({ name: strOf(g.name, '—'), day: numOf(g.day, 0), years: Math.max(0, Math.round(numOf(g.years, 0))), text: strOf(g.text, '') }))
      .slice(-GRAVE_KEEP);
  }
  if (Array.isArray(data.claimants)) {
    for (const c of data.claimants.slice(0, MAX_CLAIMANTS)) {
      if (!c || typeof c !== 'object') continue;
      st.claimants.push({
        name: strOf(c.name, 'Безымянный'), fam: strOf(c.fam, '—'),
        sex: c.sex === 'ж' ? 'ж' : 'м', age: Math.max(0, numOf(c.age, 30 * YEAR)),
        strength: clamp(numOf(c.strength, 40), 0, 100),
        fid: c.fid == null ? null : String(c.fid), since: numOf(c.since, 0),
      });
    }
  }
  if (Array.isArray(data.ties)) {
    st.ties = data.ties.filter(t => t && typeof t === 'object' && t.fid != null)
      .map(t => ({ fid: String(t.fid), house: strOf(t.house, '—'), since: numOf(t.since, 0), memberId: numOf(t.memberId, 0), claim: clamp(numOf(t.claim, FOREIGN_CLAIM), 0, 100) }));
  }
  if (Array.isArray(data.seen)) {
    st.seen = data.seen.filter(s => s && typeof s === 'object' && typeof s.key === 'string')
      .map(s => ({ key: s.key, day: numOf(s.day, 0) })).slice(-40);
  }
  if (data.stats && typeof data.stats === 'object') {
    for (const k of Object.keys(st.stats)) st.stats[k] = Math.max(0, Math.round(numOf(data.stats[k], st.stats[k])));
  }
  return st;
}

function _restoreMember(m) {
  if (!m || typeof m !== 'object' || !Number.isFinite(m.id)) return null;
  return {
    id: Math.round(m.id),
    name: strOf(m.name, 'Безымянный'),
    fam: strOf(m.fam, '—'),
    sex: m.sex === 'ж' ? 'ж' : 'м',
    age: Math.max(0, numOf(m.age, 20 * YEAR)),
    born: numOf(m.born, 0),
    gen: Math.max(1, Math.round(numOf(m.gen, 1))),
    blood: !!m.blood,
    origin: ['blood', 'married', 'foreign'].includes(m.origin) ? m.origin : (m.blood ? 'blood' : 'married'),
    fid: m.fid == null ? null : String(m.fid),
    traits: Array.isArray(m.traits) ? m.traits.filter(t => TRAIT_BY_ID[t]).slice(0, 3) : [],
    father: Number.isFinite(m.father) ? m.father : null,
    mother: Number.isFinite(m.mother) ? m.mother : null,
    spouse: Number.isFinite(m.spouse) ? m.spouse : null,
    fertCd: Math.max(0, numOf(m.fertCd, 0)),
    since: numOf(m.since, 0),
  };
}

// ============================ ЧТЕНИЕ РОДА ============================

export function memberOf(state, id) {
  if (!state || id == null) return null;
  return state.members.find(m => m.id === id) || null;
}

export function ruler(state) { return memberOf(state, state && state.rulerId); }

export function livingMembers(state) { return state ? state.members.slice() : []; }

// Кровные — те, кто может наследовать. Вошедшие в род через брак не наследуют:
// иначе трон уходил бы к вдове чужого рода, и женитьба на соседе означала бы
// подарить ему державу, а не заключить союз.
export function bloodMembers(state) { return state.members.filter(m => m.blood); }

export function ageYearsOf(m) { return ageYears(m); }

// «Сила» человека в глазах дружины: зрелость плюс вес черт. По ней вождество
// выбирает наследника, а претендент — свои шансы.
export function powerOf(m) {
  if (!m) return 0;
  const y = ageYears(m);
  // Кривая зрелости: ребёнок за собой людей не поведёт, старик уже не поведёт.
  let p = y < ADULT_YEARS ? y / ADULT_YEARS * 3 : y <= 45 ? 10 : Math.max(3, 10 - (y - 45) * 0.2);
  for (const t of m.traits) p += TRAIT_POWER[t] || 0;
  return Math.round(p * 10) / 10;
}

// ============================ НАСЛЕДНИК ============================

// Кто встанет на трон по закону строя. Ничего не меняет — можно звать из
// рендера. Возвращает null, когда наследника нет (республика, пресечение рода).
//
// Третий довод `from` — тот, ОТ КОГО считаем родство. По умолчанию это живой
// правитель, но в день его смерти он уже вынут из списка живых, а «старший сын»
// без отца не считается вовсе. Тогда сюда передают покойного: дети хранят
// father/mother по id, и его линия остаётся видна.
export function heirOf(state, ctx, from) {
  const c = readCtx(ctx);
  const lawDef = SUCCESSION_LAW[c.gov] || SUCCESSION_LAW.chiefdom;
  const rl = from || ruler(state);
  const pool = bloodMembers(state).filter(m => m.id !== state.rulerId && (!rl || m.id !== rl.id));

  // Назначенный игроком перебивает закон везде, где закон вообще есть.
  // В империи назначение и ЕСТЬ закон, поэтому там оно не «сомнительное».
  const named = memberOf(state, state.namedHeirId);
  if (named && named.blood && named.id !== state.rulerId) {
    const odd = lawDef.law !== 'appointed';
    return {
      id: named.id, name: named.name, member: named, law: lawDef.law, lawRu: lawDef.ru,
      why: odd ? 'назначен волей правителя вопреки обычаю' : 'назначен волей правителя',
      odd, minor: ageYears(named) < ADULT_YEARS,
    };
  }

  if (lawDef.law === 'election') {
    return null;    // выборов наследника не бывает: есть только кандидаты
  }

  let pick = null, why = '';
  if (lawDef.law === 'eldest_son') {
    if (rl) {
      const sons = pool.filter(m => m.sex === 'м' && _isChildOf(m, rl)).sort((a, b) => b.age - a.age);
      if (sons.length) { pick = sons[0]; why = 'старший сын правителя'; }
      if (!pick) {
        const daughters = pool.filter(m => m.sex === 'ж' && _isChildOf(m, rl)).sort((a, b) => b.age - a.age);
        // Дочь при живом обычае «наследует сын» — уже слабое право, и законность
        // это чувствует (см. odd). Но это лучше пресечения рода.
        if (daughters.length) { pick = daughters[0]; why = 'сыновей нет, наследует старшая дочь'; }
      }
    }
    if (!pick) {
      // Ни детей, ни правителя (он мог умереть бездетным) — трон идёт по боковой
      // линии: старший из ближайшего к основателю поколения.
      const kin = pool.slice().sort((a, b) => (a.gen - b.gen) || (b.age - a.age));
      if (kin.length) { pick = kin[0]; why = 'детей нет, трон уходит к старшему в роду'; }
    }
  } else if (lawDef.law === 'strongest') {
    const adults = pool.filter(m => ageYears(m) >= ADULT_YEARS);
    const src = adults.length ? adults : pool;
    pick = src.slice().sort((a, b) => powerOf(b) - powerOf(a) || a.id - b.id)[0] || null;
    why = adults.length ? 'сильнейший из рода' : 'взрослых в роду нет, встанет отрок';
  } else if (lawDef.law === 'council' || lawDef.law === 'appointed') {
    const adults = pool.filter(m => ageYears(m) >= ADULT_YEARS).sort((a, b) => b.age - a.age);
    pick = adults[0] || pool.slice().sort((a, b) => b.age - a.age)[0] || null;
    why = lawDef.law === 'council' ? 'старший в роду — так решит совет' : 'преемник не назначен, трон возьмёт старший';
  }
  if (!pick) return null;
  return {
    id: pick.id, name: pick.name, member: pick, law: lawDef.law, lawRu: lawDef.ru,
    why,
    odd: lawDef.law === 'eldest_son' && pick.sex === 'ж',
    minor: ageYears(pick) < ADULT_YEARS,
  };
}

function _isChildOf(m, parent) { return m.father === parent.id || m.mother === parent.id; }

// ============================ ЗАКОННОСТЬ ============================

export function legitimacy(state) { return state ? clamp(state.legitimacy, LEG_MIN, LEG_MAX) : 0; }

// «Свой уровень» рода: чем дольше род на троне, тем выше та отметка, к которой
// законность возвращается сама. Это и есть выход из ямы — и одновременно
// объяснение, почему свергать древний род тяжелее, чем вчерашнего узурпатора.
export function baseLegitimacy(state, day) {
  const years = Math.max(0, (numOf(day, 0) - numOf(state.foundedDay, 0)) / YEAR);
  return clamp(30 + 6 * (state.generations - 1) + years * 0.15, 0, LEG_BASE_CAP);
}

export function legitimacyWord(v) {
  if (v >= 80) return 'непререкаемая';
  if (v >= 60) return 'крепкая';
  if (v >= 40) return 'спорная';
  if (v >= 20) return 'шаткая';
  return 'ничтожная';
}

// ============================ ДНЕВНОЙ ХОД ============================

// Один игровой день рода. Возвращает НОВОЕ состояние и отчёт; входное состояние
// не трогает.
//
// ОДИН ДЕНЬ СЧИТАЕТСЯ ОДИН РАЗ. Повторный вызов теми же сутками возвращает
// пустой отчёт и НЕ ТРОГАЕТ rng — иначе второй вызов из другого места сдвинул
// бы поток случайностей и разошёлся бы с сохранением.
export function dynastyNewDay(state, ctx, rng) {
  const c = readCtx(ctx);
  const S = clone(state);
  const out = { state: S, mods: zeroMods(), reasons: [], events: [], flags: {}, counted: false };
  if (!S || !S.members) return out;
  if (S.day === c.day) { out.flags = summaryFlags(S, c); return out; }
  S.day = c.day;
  out.counted = true;

  _tickAges(S);
  _tickDeaths(S, c, rng, out);
  _tickWeddings(S, c, rng, out);
  _tickBirths(S, c, rng, out);
  _tickSuccession(S, c, rng, out);
  _tickInterregnum(S, c, rng, out);
  _tickLegitimacy(S, c, out);
  _tickClaimants(S, c, rng, out);
  _tickCourt(S, c, out);
  _tickStanding(S, c, out);
  _trimMembers(S);

  // Сводку ДОПИСЫВАЕМ, а не подменяем: в flags уже лежат разбор законности и
  // отметка о смерти правителя, положенные шагами выше.
  Object.assign(out.flags, summaryFlags(S, c));
  return out;
}

// ---- возраст ----
function _tickAges(S) {
  // Возраст в ДНЯХ, как у жителей: v.age++ раз в сутки. Никакого «age += 1/100».
  for (const m of S.members) { m.age++; if (m.fertCd > 0) m.fertCd--; }
  for (const cl of S.claimants) cl.age++;
  if (S.patronCd > 0) S.patronCd--;
}

// ---- смерть ----
function _tickDeaths(S, c, rng, out) {
  const hunger = c.foodDays < 2 ? 2 : c.foodDays < 5 ? 1.3 : 1;   // двор голодает последним
  for (const m of S.members.slice()) {
    const q = annualMortality(ageYears(m)) * ROYAL_MORT * c.mortalityMult * hunger;
    if (!rng.chance(q / YEAR)) continue;
    _bury(S, m, c.day, out);
  }
}

function _bury(S, m, day, out) {
  const y = ageYears(m);
  const idx = S.members.indexOf(m);
  if (idx >= 0) S.members.splice(idx, 1);
  S.stats.deaths++;
  for (const o of S.members) {
    if (o.spouse === m.id) o.spouse = null;      // вдова обязана вернуться в брачный круг
    // И РОДИТЕЛЬСКИЕ ССЫЛКИ ТОЖЕ — здесь их не снимали, и из-за этого сейв
    // переставал быть круговым. Живой род держал father: 1 на выбывшем
    // основателе, сохранение это записывало, а restoreDynasty при загрузке
    // повисшие ссылки чинит (и правильно делает — у неё на это есть свой
    // тест) — значит, второе сохранение уже не совпадало с первым.
    //
    // Расхождение прячется, пока основатель жив: поймалось на прогоне
    // test-worldsites, где партия дожила до его смерти. Чинить надо было
    // именно здесь, у источника: не «загрузка портит родословную», а похороны
    // не доводили дело до конца. Ровно то же самое модуль уже делает при
    // обрезке рода по потолку — там ссылки на выбывших снимаются все три.
    if (o.father === m.id) o.father = null;
    if (o.mother === m.id) o.mother = null;
  }
  if (S.namedHeirId === m.id) S.namedHeirId = null;
  const text = `✝ ${m.name} умер${m.sex === 'ж' ? 'ла' : ''} в ${y} ${plural(y, 'год', 'года', 'лет')}.`;
  S.graves.push({ name: m.name, day, years: y, text });
  if (S.graves.length > GRAVE_KEEP) S.graves.splice(0, S.graves.length - GRAVE_KEEP);
  // Про смерть правителя расскажет блок наследования — там она не просто
  // смерть, а смена власти. Здесь говорим только про остальных, и только
  // про взрослых: младенческая смертность в роду высока, и журнал утонул бы.
  if (m.id !== S.rulerId && y >= ADULT_YEARS) {
    out.events.push({ text: `${text} Род ${S.fam} провожает своего.`, type: 'info', cause: 'kin_death' });
  }
  if (m.id === S.rulerId) { S.rulerId = null; out.flags.rulerDiedToday = m; }
}

// ---- свадьбы внутри рода: одинокие берут пару из поселения ----
function _tickWeddings(S, c, rng, out) {
  if (S.members.length >= MAX_MEMBERS) return;
  const single = S.members.filter(m => m.spouse == null && ageYears(m) >= MARRY_MIN && ageYears(m) <= MARRY_MAX);
  for (const m of single) {
    if (!rng.chance(MARRY_CHANCE)) continue;
    if (S.members.length >= MAX_MEMBERS) break;
    const spouse = _makeMember(S, rng, {
      sex: m.sex === 'м' ? 'ж' : 'м',
      ageYears: clamp(ageYears(m) + rng.int(-6, 6), MARRY_MIN, MARRY_MAX),
      day: c.day, gen: m.gen, blood: false, origin: 'married',
    });
    _wed(m, spouse);
    out.events.push({
      text: `⚭ ${m.name} берёт в супруги ${spouse.name} из поселения. У рода ${S.fam} прибыло.`,
      type: 'good', cause: 'wedding',
    });
  }
}

// ---- рождения ----
function _tickBirths(S, c, rng, out) {
  if (S.members.length >= MAX_MEMBERS) return;
  for (const w of S.members.slice()) {
    if (w.sex !== 'ж' || w.spouse == null || w.fertCd > 0) continue;
    const y = ageYears(w);
    if (y < FERT_MIN || y > FERT_MAX) continue;
    const father = memberOf(S, w.spouse);
    if (!father) continue;
    if (!rng.chance(BIRTH_BASE)) continue;
    const child = _makeMember(S, rng, {
      sex: rng.chance(0.5) ? 'м' : 'ж', ageYears: 0, day: c.day,
      gen: Math.max(w.gen, father.gen) + 1,
      // Кровь наследуется от того из родителей, кто сам кровный. Ребёнок
      // княжны и пришлого — кровный: род продолжается по любой линии, иначе
      // династия из одного сына обрывалась бы на первой же девочке.
      blood: w.blood || father.blood,
      father: father.sex === 'м' ? father : w,
      mother: father.sex === 'ж' ? father : w,
    });
    child.fam = S.fam;
    w.fertCd = BIRTH_CD;
    S.stats.births++;
    out.events.push({
      text: `☺ В роду ${S.fam} ${child.sex === 'ж' ? 'родилась' : 'родился'} ${child.name}.`,
      type: 'good', cause: 'birth',
    });
    if (S.members.length >= MAX_MEMBERS) break;
  }
}

// ---- смена власти ----
function _tickSuccession(S, c, rng, out) {
  const dead = out.flags.rulerDiedToday;
  if (!dead) return;
  const suc = SUCCESSION[c.gov] || SUCCESSION.chiefdom;
  const lawDef = SUCCESSION_LAW[c.gov] || SUCCESSION_LAW.chiefdom;

  // Республика: род не наследует. Он удержит власть только если его почитают.
  if (lawDef.law === 'election') {
    const cand = bloodMembers(S).filter(m => ageYears(m) >= ADULT_YEARS)
      .sort((a, b) => powerOf(b) - powerOf(a) || a.id - b.id)[0];
    if (cand && S.legitimacy >= 60) {
      _enthrone(S, cand, c);
      out.events.push({ text: `⚖ ${dead.name} умер. Выборы: голоса снова за род ${S.fam} — правит ${cand.name}.`, type: 'info', cause: 'succession' });
    } else {
      const rep = _newHouse(S, c, rng, { legitimacy: 45, why: 'выборы' });
      out.events.push({ text: `⚖ ${dead.name} умер. Выборы отдали власть другому роду: ${rep.name} из рода ${S.fam}.`, type: 'warn', cause: 'house_change' });
      out.reasons.push(`Республика не наследует власть: род сменился по итогам выборов.`);
    }
    _legHit(S, suc.stab * LEG_PER_STAB, out, `Смена власти: ${suc.ru}.`);
    return;
  }

  const heir = heirOf(S, c, dead);
  if (!heir) {
    // ПРЕСЕЧЕНИЕ РОДА. Ради предотвращения этой строки игрок и женит наследников.
    S.rulerId = null;
    S.interregnum = INTERREGNUM_DAYS;
    S.stats.interregnums++;
    out.events.push({
      text: `☠ ${dead.name} умер, не оставив наследника. Род ${S.fam} пресёкся — междуцарствие.`,
      type: 'bad', cause: 'interregnum',
    });
    out.reasons.push(`Междуцарствие: трон пуст, наследовать некому (${INTERREGNUM_DAYS} дн.).`);
    _legHit(S, 25, out, 'Род пресёкся: права на трон не осталось ни у кого.');
    out.flags.interregnumStarted = true;
    return;
  }
  const m = heir.member;
  _enthrone(S, m, c);
  if (S.namedHeirId === m.id) S.namedHeirId = null;
  const minor = ageYears(m) < ADULT_YEARS;
  out.events.push({
    text: `👑 ${dead.name} умер. Трон принял ${m.name} (${heir.why}). ${suc.ru}.`,
    type: minor ? 'warn' : 'info', cause: 'succession',
  });
  _legHit(S, suc.stab * LEG_PER_STAB, out, `Смена власти: ${suc.ru}.`);
  if (heir.odd) _legHit(S, 6, out, `Преемник сомнителен: ${heir.why}.`);
  if (minor) {
    out.events.push({ text: `Правитель — дитя: ${m.name}, ${ageYears(m)} лет. При нём правят опекуны.`, type: 'warn', cause: 'regency' });
  }
}

function _enthrone(S, m, c) {
  S.rulerId = m.id;
  m.since = c.day;
  S.generations = Math.max(S.generations, m.gen);
  S.stats.rulers++;
}

// ---- междуцарствие: у него есть конец ----
function _tickInterregnum(S, c, rng, out) {
  if (S.interregnum <= 0) return;
  S.interregnum--;
  out.mods.stability -= INTERREGNUM_STAB;
  out.reasons.push(`Междуцарствие: трон пуст, стабильность −${INTERREGNUM_STAB.toFixed(1)} в сутки (осталось ${Math.round(S.interregnum)} дн.).`);
  if (S.interregnum > 0) return;

  // Пустой трон навсегда — это партия без власти. Кто-то садится обязательно:
  // сильнейший претендент, если он есть, иначе поднимается новый род.
  const cl = S.claimants.slice().sort((a, b) => b.strength - a.strength)[0];
  if (cl) {
    const rep = _newHouse(S, c, rng, { legitimacy: COUP_LEG, fam: cl.fam, name: cl.name, sex: cl.sex, age: cl.age, why: 'претендент занял пустой трон' });
    S.claimants = S.claimants.filter(x => x !== cl);
    out.events.push({ text: `👑 Междуцарствие кончилось: трон взял ${rep.name}. Правит род ${S.fam}.`, type: 'warn', cause: 'house_change' });
  } else {
    const rep = _newHouse(S, c, rng, { legitimacy: 35, why: 'новый род из поселения' });
    out.events.push({ text: `👑 Междуцарствие кончилось: власть взял ${rep.name}, старейшина рода ${S.fam}.`, type: 'warn', cause: 'house_change' });
  }
  out.reasons.push('Междуцарствие завершено: держава снова имеет правителя.');
}

// ---- законность ----
function _tickLegitimacy(S, c, out) {
  const before = S.legitimacy;
  const base = baseLegitimacy(S, c.day);
  const parts = [];

  // 1. Тяга к своему уровню. Это выход из любой ямы и потолок любого взлёта.
  const pull = clamp(base - S.legitimacy, -LEG_DRIFT, LEG_DRIFT);
  S.legitimacy += pull;
  if (Math.abs(pull) > 1e-9) {
    parts.push(pull > 0
      ? `род на троне ${S.generations} ${plural(S.generations, 'поколение', 'поколения', 'поколений')}: привычка к власти +${pull.toFixed(2)}`
      : `род зазнался выше своего веса: ${pull.toFixed(2)}`);
  }

  // 2. Разовые удары и награды. Каждое событие — ОДИН раз на сезон.
  for (const ev of c.events) {
    const d = LEG_EVENT[ev.kind];
    if (d == null) continue;
    if (_alreadySeen(S, ev.kind, ev.key, c.day)) continue;
    S.seen.push({ key: ev.key ? `${ev.kind}:${ev.key}` : ev.kind, day: c.day });
    const v = d * (ev.scale != null && Number.isFinite(ev.scale) ? clamp(ev.scale, 0.25, 2) : 1);
    S.legitimacy += v;
    out.reasons.push(`${_eventWord(ev.kind)}: законность ${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}.`);
    out.events.push({
      text: `${v > 0 ? '✦' : '✖'} ${_eventWord(ev.kind)} — право рода ${S.fam} на трон ${v > 0 ? 'окрепло' : 'пошатнулось'}.`,
      type: v > 0 ? 'good' : 'warn', cause: 'legitimacy',
    });
  }
  // Окно памяти чистим, иначе seen растёт вместе с партией и раздувает сейв.
  S.seen = S.seen.filter(s => c.day - s.day <= SEEN_WINDOW * 2);

  // 3. Стоящие условия. У каждого есть выход, и он назван словами.
  const heir = heirOf(S, c);
  if (S.interregnum > 0) {
    S.legitimacy -= LEG_INTERREGNUM;
    parts.push(`междуцарствие −${LEG_INTERREGNUM}`);
  } else if (!heir && (SUCCESSION_LAW[c.gov] || {}).law !== 'election') {
    S.legitimacy -= LEG_NO_HEIR;
    parts.push(`наследника нет −${LEG_NO_HEIR}`);
    out.reasons.push('Наследника нет: народ гадает, что будет после правителя. Женить или родить — и это уйдёт.');
  } else if (heir && heir.odd) {
    S.legitimacy -= LEG_ODD_HEIR;
    parts.push(`сомнительный преемник −${LEG_ODD_HEIR}`);
    out.reasons.push(`Преемник сомнителен (${heir.why}): знать шепчется. Отменить назначение — и шёпот стихнет.`);
  }

  S.legitimacy = clamp(S.legitimacy, LEG_MIN, LEG_MAX);
  out.flags.legParts = parts;
  out.flags.legDelta = Math.round((S.legitimacy - before) * 100) / 100;
}

function _alreadySeen(S, kind, key, day) {
  const full = key ? `${kind}:${key}` : kind;
  return S.seen.some(s => s.key === full && day - s.day < SEEN_WINDOW);
}

function _eventWord(kind) {
  return {
    victory: 'Победа в поле', triumph: 'Триумф', city_won: 'Взят город',
    defeat: 'Поражение', city_lost: 'Потеряна провинция',
    famine: 'Голод', plague: 'Мор', revolt: 'Восстание',
  }[kind] || kind;
}

function _legHit(S, v, out, why) {
  S.legitimacy = clamp(S.legitimacy - v, LEG_MIN, LEG_MAX);
  out.reasons.push(`${why} Законность −${v.toFixed(1)}.`);
}

// ---- претенденты ----
function _tickClaimants(S, c, rng, out) {
  // Претендент из чужого рода: он давит СТАБИЛЬНОСТЬ, но не законность.
  // Иначе вышла бы спираль без выхода: чем ниже законность, тем больше
  // претендентов, тем ниже законность.
  for (const cl of S.claimants.slice()) {
    const y = ageYears(cl);
    if (rng.chance(annualMortality(y) / YEAR)) {
      S.claimants = S.claimants.filter(x => x !== cl);
      out.events.push({ text: `Претендент ${cl.name} умер. Одной угрозой троном меньше.`, type: 'good', cause: 'claimant_gone' });
      continue;
    }
    if (S.legitimacy > CLAIM_CLEAR && rng.chance(CLAIM_FADE)) {
      S.claimants = S.claimants.filter(x => x !== cl);
      out.events.push({ text: `Претендент ${cl.name} отступился: право рода ${S.fam} признано.`, type: 'good', cause: 'claimant_gone' });
    }
  }
  if (S.claimants.length) {
    const d = CLAIM_STAB * S.claimants.length;
    out.mods.stability -= d;
    out.mods.estates.nobles -= 0.02 * S.claimants.length;   // знать примеряется, к кому прислониться
    out.reasons.push(`Претенденты на трон (${S.claimants.length}): стабильность −${d.toFixed(2)} в сутки. Поднимите законность выше ${CLAIM_CLEAR} — разойдутся.`);
  }
  if (S.claimants.length >= MAX_CLAIMANTS) return;
  if (S.legitimacy >= CLAIM_BELOW) return;
  // Чем ниже законность, тем вероятнее — но потолок шанса всё равно жёсткий.
  const p = CLAIM_CHANCE * (1 + (CLAIM_BELOW - S.legitimacy) / CLAIM_BELOW);
  if (!rng.chance(Math.min(p, CLAIM_CHANCE * 2))) return;

  // Права по браку — первыми: женили наследника на соседе, теперь сосед помнит.
  const tie = S.ties.find(t => !S.claimants.some(x => x.fid === t.fid));
  const sex = rng.chance(0.7) ? 'м' : 'ж';
  const cl = {
    name: `${_pickName(rng, sex)} ${tie ? tie.house : rng.pick(NICKNAMES)}`,
    fam: tie ? tie.house : rng.pick(NICKNAMES),
    sex, age: rng.int(22, 48) * YEAR,
    strength: Math.round(clamp((tie ? tie.claim : 25) + (CLAIM_BELOW - S.legitimacy), 10, 90)),
    fid: tie ? tie.fid : null, since: c.day,
  };
  S.claimants.push(cl);
  out.events.push({
    text: tie
      ? `⚑ ${cl.name} заявил права на трон: его род породнился с нашим, а законность рода ${S.fam} ${legitimacyWord(S.legitimacy)}.`
      : `⚑ ${cl.name} заявил права на трон: законность рода ${S.fam} ${legitimacyWord(S.legitimacy)}, и знать слушает.`,
    type: 'bad', cause: 'claimant',
  });
  out.flags.newClaimant = cl;
}

// ---- двор ----
function _tickCourt(S, c, out) {
  const lvl = COURT[clampInt(S.court, 0, COURT.length - 1)];
  const gold = lvl.gold * (1 + c.pop * COURT_PER_POP);
  if (gold > 0 && c.gold < gold) {
    // Казна не потянула двор: это не «ничего не произошло», это обида знати.
    // Выход прямой — понизить ступень содержания.
    S.legitimacy = clamp(S.legitimacy - COURT_UNPAID_LEG, LEG_MIN, LEG_MAX);
    out.mods.estates.nobles -= 0.05;
    out.reasons.push(`Двору не заплатили (нужно ${gold.toFixed(1)} 🪙 в сутки): законность −${COURT_UNPAID_LEG}, знать недовольна. Понизьте содержание двора.`);
    out.flags.courtUnpaid = true;
  } else {
    out.mods.goldPerDay -= gold;
    S.legitimacy = clamp(S.legitimacy + lvl.leg, LEG_MIN, LEG_MAX);
    out.mods.estates.nobles += lvl.nobles;
    out.mods.estates.commons += lvl.commons;
    out.mods.happy += lvl.happy;
    if (gold > 0) out.reasons.push(`Двор (${lvl.ru}): ${gold.toFixed(1)} 🪙 в сутки, законность ${lvl.leg > 0 ? '+' : '−'}${Math.abs(lvl.leg)}.`);
    else out.reasons.push(`Двор (${lvl.ru}): казна не тратится, но и почёта роду нет: законность ${lvl.leg.toFixed(2)}.`);
  }
}

// ---- как род сказывается на державе ----
function _tickStanding(S, c, out) {
  const rl = ruler(S);
  if (rl && ageYears(rl) < ADULT_YEARS) {
    out.mods.stability -= REGENCY_STAB;
    const left = Math.ceil((ADULT_YEARS * YEAR - rl.age) / YEAR);
    out.reasons.push(`Правитель — дитя (${ageYears(rl)} лет): стабильность −${REGENCY_STAB} в сутки. Кончится само через ${left} ${plural(left, 'год', 'года', 'лет')}.`);
    out.flags.regency = true;
  }
  // Законность — не декорация: от неё зависит, слушают ли власть.
  // Шаг маленький и потолок явный: ±0.3 стабильности в сутки на всём размахе.
  const d = (S.legitimacy - 50) / 50 * 0.3;
  out.mods.stability += d;
  if (Math.abs(d) >= 0.02) {
    out.reasons.push(`Законность рода ${S.fam} ${legitimacyWord(S.legitimacy)} (${Math.round(S.legitimacy)}): стабильность ${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(2)} в сутки.`);
  }
  // Знать и войско смотрят на законность каждый со своей колокольни.
  out.mods.estates.nobles += (S.legitimacy - 50) / 50 * 0.04;
  out.mods.estates.military += (S.legitimacy - 50) / 50 * 0.02;
}

// Потолок списка: выбывают самые дальние от трона. Их не хоронят — они просто
// перестают считаться роднёй, и в панели их больше нет.
function _trimMembers(S) {
  if (S.members.length <= MAX_MEMBERS) return;
  const keep = new Set([S.rulerId, S.namedHeirId].filter(x => x != null));
  const rl = ruler(S);
  if (rl && rl.spouse != null) keep.add(rl.spouse);
  const rank = (m) => (keep.has(m.id) ? -1000 : 0) + (m.blood ? -10 : 0) + m.gen * 5 - ageYears(m) / 50;
  S.members.sort((a, b) => rank(a) - rank(b));
  S.members.length = MAX_MEMBERS;
  const ids = new Set(S.members.map(m => m.id));
  for (const m of S.members) {
    if (m.spouse != null && !ids.has(m.spouse)) m.spouse = null;
    if (m.father != null && !ids.has(m.father)) m.father = null;
    if (m.mother != null && !ids.has(m.mother)) m.mother = null;
  }
  if (!ids.has(S.namedHeirId)) S.namedHeirId = null;
}

// ============================ ДЕЙСТВИЯ ИГРОКА ============================
//
// У каждого действия своя пара: canXxx() отвечает «можно ли» и внятной причиной
// отказа (её показывает кнопка), xxx() делает и возвращает новое состояние.
// Ни одно действие не трогает переданное состояние.

// --- поддержать двор ---
export function patronCost(ctx) {
  const c = readCtx(ctx);
  return Math.round(PATRON_COST + c.pop * PATRON_PER_POP);
}

export function canPatronize(state, ctx) {
  const c = readCtx(ctx);
  if (!state) return { ok: false, reason: 'Рода нет' };
  if (state.interregnum > 0) return { ok: false, reason: 'Междуцарствие: двора нет, одаривать некого' };
  if (state.patronCd > 0) return { ok: false, reason: `Двор одарён недавно, ждать ${Math.ceil(state.patronCd)} дн.` };
  const cost = patronCost(c);
  if (c.gold < cost) return { ok: false, reason: `Не хватает золота: нужно ${cost} 🪙` };
  if (state.legitimacy >= LEG_MAX) return { ok: false, reason: 'Законность и так непререкаема' };
  return { ok: true, cost };
}

export function patronizeCourt(state, ctx) {
  const chk = canPatronize(state, ctx);
  if (!chk.ok) return { ...chk, state };
  const S = clone(state);
  S.legitimacy = clamp(S.legitimacy + PATRON_LEG, LEG_MIN, LEG_MAX);
  S.patronCd = PATRON_CD;
  return {
    ok: true, state: S, cost: chk.cost,
    mods: { gold: -chk.cost, estates: { nobles: 4, commons: -3 } },
    reasons: [`Двору поднесены дары на ${chk.cost} 🪙: законность +${PATRON_LEG}, знать довольна, простолюдины видят роскошь.`],
    events: [{ text: `♛ Род ${S.fam} держит двор на широкую ногу: пиры, дары, послы. Законность ${Math.round(S.legitimacy)}.`, type: 'good', cause: 'patron' }],
  };
}

// --- уровень содержания двора ---
export function canSetCourt(state, level) {
  const l = Math.round(numOf(level, -1));
  if (!state) return { ok: false, reason: 'Рода нет' };
  if (!COURT[l]) return { ok: false, reason: 'Такого содержания двора не бывает' };
  if (state.court === l) return { ok: false, reason: `${COURT[l].ru} — уже так и есть` };
  return { ok: true };
}

export function setCourt(state, level) {
  const chk = canSetCourt(state, level);
  if (!chk.ok) return { ...chk, state };
  const S = clone(state);
  S.court = Math.round(level);
  return {
    ok: true, state: S,
    reasons: [`Содержание двора: ${COURT[S.court].ru}.`],
    events: [{ text: `♛ Двор рода ${S.fam} переведён на содержание «${COURT[S.court].ru}».`, type: 'info', cause: 'court' }],
  };
}

// --- назначить наследника ---
export function canNameHeir(state, id, ctx) {
  const c = readCtx(ctx);
  if (!state) return { ok: false, reason: 'Рода нет' };
  const law = (SUCCESSION_LAW[c.gov] || SUCCESSION_LAW.chiefdom).law;
  if (law === 'election') return { ok: false, reason: 'Республика наследников не назначает — там выборы' };
  const m = memberOf(state, id);
  if (!m) return { ok: false, reason: 'Такого человека в роду нет' };
  if (!m.blood) return { ok: false, reason: `${m.name} вошёл в род через брак и наследовать не может` };
  if (m.id === state.rulerId) return { ok: false, reason: 'Он и так на троне' };
  if (state.namedHeirId === m.id) return { ok: false, reason: `${m.name} уже назначен` };
  return { ok: true, member: m, odd: law !== 'appointed' };
}

export function nameHeir(state, id, ctx) {
  const chk = canNameHeir(state, id, ctx);
  if (!chk.ok) return { ...chk, state };
  const S = clone(state);
  S.namedHeirId = chk.member.id;
  const odd = chk.odd;
  // Обход обычая стоит законности сразу, а потом капает каждый день (LEG_ODD_HEIR),
  // пока назначение стоит. Выход — отменить назначение: clearHeir().
  if (odd) S.legitimacy = clamp(S.legitimacy + NAME_HEIR_LEG, LEG_MIN, LEG_MAX);
  return {
    ok: true, state: S,
    mods: { estates: { nobles: odd ? NAME_HEIR_NOBLES : 0 } },
    reasons: odd
      ? [`Наследником назван ${chk.member.name} вопреки обычаю: законность ${NAME_HEIR_LEG}, знать оскорблена (${NAME_HEIR_NOBLES}).`]
      : [`Наследником назван ${chk.member.name} — так и положено при этом строе.`],
    events: [{ text: `📜 Наследником объявлен ${chk.member.name}${odd ? ' — старшинство обойдено, и двор это запомнит.' : '.'}`, type: odd ? 'warn' : 'info', cause: 'heir' }],
  };
}

export function clearHeir(state) {
  if (!state || state.namedHeirId == null) return { ok: false, reason: 'Наследник и не назначался', state };
  const S = clone(state);
  const m = memberOf(S, S.namedHeirId);
  S.namedHeirId = null;
  return {
    ok: true, state: S,
    reasons: [`Назначение отменено: трон снова наследуется по обычаю.`],
    events: [{ text: `📜 ${m ? m.name : 'Наследник'} лишён права наследовать. Обычай восстановлен.`, type: 'info', cause: 'heir' }],
  };
}

// --- женить наследника на роде соседа ---
export function canMarryHeir(state, ctx, opts = {}) {
  const c = readCtx(ctx);
  if (!state) return { ok: false, reason: 'Рода нет' };
  if (opts.fid == null) return { ok: false, reason: 'Не сказано, с каким родом роднимся' };
  if (state.ties.some(t => t.fid === String(opts.fid))) return { ok: false, reason: 'С этим родом уже породнились' };
  const heir = heirOf(state, c);
  const m = heir ? heir.member : bloodMembers(state).filter(x => x.id !== state.rulerId && x.spouse == null)
    .sort((a, b) => b.age - a.age)[0];
  if (!m) return { ok: false, reason: 'В роду некого женить: свободных наследников нет' };
  if (m.spouse != null) return { ok: false, reason: `${m.name} уже в браке` };
  if (ageYears(m) < MARRY_MIN) return { ok: false, reason: `${m.name} слишком юн: женить можно с ${MARRY_MIN} лет` };
  if (numOf(opts.rel, 0) < 0) return { ok: false, reason: 'Сосед враждебен — сватов не примут' };
  return { ok: true, member: m };
}

// Брак — это связь двух родов и права на трон В ОБЕ СТОРОНЫ. Наш род получает
// право на трон соседа (flags.ourClaim — его разыгрывает дипломатия), а сосед
// получает право на наш: именно из этих ties потом и приходят претенденты.
export function marryHeir(state, ctx, opts, rng) {
  const chk = canMarryHeir(state, ctx, opts);
  if (!chk.ok) return { ...chk, state };
  const c = readCtx(ctx);
  const S = clone(state);
  const m = memberOf(S, chk.member.id);
  const house = strOf(opts.house, null) || (rng ? rng.pick(NICKNAMES) : 'Соседний');
  const sex = m.sex === 'м' ? 'ж' : 'м';
  const spouse = _makeMember(S, rng, {
    sex, ageYears: clamp(ageYears(m) + (rng ? rng.int(-4, 4) : 0), MARRY_MIN, MARRY_MAX),
    day: c.day, gen: m.gen, blood: false, origin: 'foreign', fid: String(opts.fid), fam: house,
  });
  _wed(m, spouse);
  S.ties.push({ fid: String(opts.fid), house, since: c.day, memberId: m.id, claim: FOREIGN_CLAIM });
  S.legitimacy = clamp(S.legitimacy + MARRY_LEG, LEG_MIN, LEG_MAX);
  return {
    ok: true, state: S, member: m, spouse,
    mods: { relations: { [String(opts.fid)]: MARRY_REL }, estates: { nobles: 2 } },
    reasons: [
      `${m.name} женится на роде ${house}: отношения +${MARRY_REL}, законность +${MARRY_LEG}.`,
      `Цена союза: род ${house} получил права на наш трон. Если законность рухнет ниже ${CLAIM_BELOW}, оттуда придёт претендент.`,
    ],
    events: [{ text: `⚭ Свадьба: ${m.name} и ${spouse.name} из рода ${house}. Два рода стали одним домом.`, type: 'good', cause: 'alliance' }],
  };
}

// --- переворот ---
export function canOverthrow(state, ctx, opts = {}) {
  const c = readCtx(ctx);
  if (!state) return { ok: false, reason: 'Рода нет' };
  if (state.interregnum > 0) return { ok: false, reason: 'Трон и так пуст: свергать некого' };
  if (!state.rulerId) return { ok: false, reason: 'Правителя нет' };
  if (c.nobles < COUP_NEED_NOBLES) return { ok: false, reason: `Знать не пойдёт: нужно одобрение ${COUP_NEED_NOBLES}, есть ${Math.round(c.nobles)}` };
  if (c.military < COUP_NEED_MILITARY) return { ok: false, reason: `Войско не пойдёт: нужно одобрение ${COUP_NEED_MILITARY}, есть ${Math.round(c.military)}` };
  if (c.stability < COUP_STAB) return { ok: false, reason: `Слишком шатко: переворот стоит ${COUP_STAB} стабильности, а её ${Math.round(c.stability)}` };
  // Древний род с крепкой законностью не свергают заговором — только смутой.
  if (state.legitimacy >= 75) return { ok: false, reason: `Законность рода ${state.fam} непререкаема (${Math.round(state.legitimacy)}): заговорщиков выдадут` };
  if (opts.claimant != null && !state.claimants[opts.claimant]) return { ok: false, reason: 'Такого претендента нет' };
  return { ok: true };
}

export function overthrow(state, ctx, opts = {}, rng) {
  const chk = canOverthrow(state, ctx, opts);
  if (!chk.ok) return { ...chk, state };
  const c = readCtx(ctx);
  const S = clone(state);
  const oldFam = S.fam;
  const oldRuler = ruler(S);
  const cl = opts.claimant != null ? S.claimants[opts.claimant] : null;
  const rep = _newHouse(S, c, rng, cl
    ? { legitimacy: COUP_LEG, fam: cl.fam, name: cl.name, sex: cl.sex, age: cl.age, why: 'переворот' }
    : { legitimacy: COUP_LEG, why: 'переворот' });
  if (cl) S.claimants = S.claimants.filter(x => x !== cl);
  S.stats.coups++;
  return {
    ok: true, state: S, ruler: rep,
    mods: { stability: -COUP_STAB, estates: { nobles: -5, commons: -5, military: 3 } },
    reasons: [
      `Переворот: род ${oldFam} низложен, на трон сел ${rep.name} из рода ${S.fam}.`,
      `Цена: стабильность −${COUP_STAB}, законность нового рода ${COUP_LEG} — придётся заслуживать заново.`,
    ],
    events: [{
      text: `⚔ ПЕРЕВОРОТ. ${oldRuler ? oldRuler.name : 'Правитель'} низложен, род ${oldFam} отстранён от власти. Правит ${rep.name} (${S.fam}).`,
      type: 'bad', cause: 'coup',
    }],
  };
}

// Новый род на троне. Старый уходит целиком: его члены больше не родня власти.
// Долг перед игроком — сказать об этом прямо, а не заменить объект молча.
function _newHouse(S, c, rng, opts = {}) {
  S.members.length = 0;
  S.claimants = [];
  S.ties = [];                       // чужие брачные права уходят вместе с прежним родом
  S.namedHeirId = null;
  S.seen = [];
  S.fam = opts.fam || (rng ? rng.pick(NICKNAMES) : 'Новый');
  S.generations = 1;
  S.foundedDay = c.day;
  S.legitimacy = clamp(numOf(opts.legitimacy, COUP_LEG), LEG_MIN, LEG_MAX);
  S.interregnum = 0;
  S.court = 1;
  S.stats.houses++;
  const head = _makeMember(S, rng, {
    sex: opts.sex === 'ж' ? 'ж' : 'м',
    ageYears: opts.age != null ? Math.floor(opts.age / YEAR) : (rng ? rng.int(26, 46) : 35),
    day: c.day, gen: 1, blood: true, name: opts.name,
  });
  S.founder = head.name;
  S.rulerId = head.id;
  head.since = c.day;
  S.stats.rulers++;
  // Основатель нового рода не бывает один: без семьи он пресечётся через год,
  // и игрок получит второе междуцарствие подряд ни за что.
  if (rng) {
    const spouse = _makeMember(S, rng, {
      sex: head.sex === 'м' ? 'ж' : 'м',
      ageYears: clamp(ageYears(head) + rng.int(-5, 3), MARRY_MIN, MARRY_MAX),
      day: c.day, gen: 1, blood: false, origin: 'married',
    });
    _wed(head, spouse);
    const kid = _makeMember(S, rng, {
      sex: rng.chance(0.5) ? 'м' : 'ж', ageYears: rng.int(0, 12), day: c.day, gen: 2, blood: true,
      father: head.sex === 'м' ? head : spouse, mother: head.sex === 'ж' ? head : spouse,
    });
    kid.fam = S.fam;
  }
  return head;
}

// ============================ КАРТОЧКА ДЛЯ ПАНЕЛИ ============================

// Ничего не меняет и rng не берёт — безопасно звать из рендера каждый кадр.
export function dynastyCard(state, ctx) {
  if (!state) return null;
  const c = readCtx(ctx);
  const rl = ruler(state);
  const heir = heirOf(state, c);
  const lawDef = SUCCESSION_LAW[c.gov] || SUCCESSION_LAW.chiefdom;
  const lines = [];
  if (state.interregnum > 0) {
    lines.push(`МЕЖДУЦАРСТВИЕ: трон пуст ещё ${Math.ceil(state.interregnum)} дн.`);
  } else if (rl) {
    const y = ageYears(rl);
    lines.push(`${rl.name}, ${y} ${plural(y, 'год', 'года', 'лет')}, ${rl.sex === 'ж' ? 'правительница' : 'правитель'}`);
    if (rl.traits.length) lines.push('Черты: ' + rl.traits.map(t => TRAIT_BY_ID[t].ru).join(', '));
  }
  lines.push(`Законность: ${Math.round(state.legitimacy)} — ${legitimacyWord(state.legitimacy)}`);
  lines.push(`Закон наследования: ${lawDef.ru}`);
  lines.push(heir ? `Наследник: ${heir.name} (${heir.why})` : 'Наследника нет');
  lines.push(`Поколений у власти: ${state.generations}; в роду ${state.members.length} ${plural(state.members.length, 'человек', 'человека', 'человек')}`);
  lines.push(`Двор: ${COURT[clampInt(state.court, 0, COURT.length - 1)].ru}`);
  if (state.claimants.length) lines.push('Претенденты: ' + state.claimants.map(x => `${x.name} (сила ${x.strength})`).join(', '));
  if (state.ties.length) lines.push('Породнились: ' + state.ties.map(t => t.house).join(', '));
  return {
    title: `Род ${state.fam}`,
    lines,
    legitimacy: Math.round(state.legitimacy),
    heir: heir ? { id: heir.id, name: heir.name, why: heir.why, odd: !!heir.odd, minor: !!heir.minor } : null,
    interregnum: state.interregnum,
    claimants: state.claimants.length,
    // Прямой ответ на «чем я рискую»: что будет, если правитель умрёт сегодня.
    risk: state.interregnum > 0 ? 'междуцарствие уже идёт'
      : heir ? `трон примет ${heir.name}`
        : (lawDef.law === 'election' ? 'выборы: власть может уйти из рода' : 'РОД ПРЕСЕЧЁТСЯ — междуцарствие'),
  };
}

// Строки списка членов рода для панели. Отсортированы по близости к трону.
export function dynastyRows(state, ctx) {
  if (!state) return [];
  const c = readCtx(ctx);
  const heir = heirOf(state, c);
  return state.members.slice()
    .sort((a, b) => (b.blood - a.blood) || (a.gen - b.gen) || (b.age - a.age))
    .map(m => ({
      id: m.id, name: m.name, sex: m.sex, years: ageYears(m),
      traits: m.traits.map(t => TRAIT_BY_ID[t].ru),
      blood: m.blood, origin: m.origin,
      ruler: m.id === state.rulerId,
      heir: !!heir && heir.id === m.id,
      spouse: m.spouse != null ? (memberOf(state, m.spouse) || {}).name || null : null,
      power: powerOf(m),
    }));
}

// Мост к politics.js: правитель в том виде, какого ждёт politics.state.ruler
// (там возраст В ГОДАХ). Перевод единиц живёт ровно в одном месте — здесь.
export function politicsRuler(state) {
  const rl = ruler(state);
  if (!rl) return null;
  return { name: rl.name, age: rl.age / YEAR, since: rl.since, traits: rl.traits.slice() };
}

function summaryFlags(S, c) {
  const heir = heirOf(S, c);
  return {
    fam: S.fam, legitimacy: Math.round(S.legitimacy * 10) / 10,
    ruler: S.rulerId, heir: heir ? heir.id : null,
    heirName: heir ? heir.name : null,
    generations: S.generations, members: S.members.length,
    claimants: S.claimants.length, interregnum: S.interregnum,
    extinct: !S.rulerId && S.interregnum > 0,
  };
}

// ============================ ВНУТРЕННЕЕ ============================

function _makeMember(S, rng, o) {
  const sex = o.sex === 'ж' ? 'ж' : 'м';
  const fam = o.fam || S.fam;
  const first = o.name ? String(o.name).split(' ')[0] : _pickName(rng, sex);
  const parents = [o.father, o.mother].filter(Boolean);
  const m = {
    id: S.nextId++,
    name: o.name && String(o.name).includes(' ') ? String(o.name) : `${first} ${fam}`,
    fam, sex,
    age: Math.max(0, Math.round(numOf(o.ageYears, 0) * YEAR)),
    born: numOf(o.day, 0) - Math.max(0, Math.round(numOf(o.ageYears, 0) * YEAR)),
    gen: Math.max(1, Math.round(numOf(o.gen, 1))),
    blood: !!o.blood,
    origin: o.origin || (o.blood ? 'blood' : 'married'),
    fid: o.fid == null ? null : String(o.fid),
    traits: _makeTraits(rng, parents),
    father: o.father ? o.father.id : null,
    mother: o.mother ? o.mother.id : null,
    spouse: null, fertCd: 0, since: numOf(o.day, 0),
  };
  S.members.push(m);
  return m;
}

// Черты: часть от родителей, часть от себя. Конфликтующие пары не сходятся —
// как и в createRuler в politics.js.
function _makeTraits(rng, parents) {
  const out = [];
  const fits = (t) => !out.includes(t) && !TRAIT_CONFLICTS.some(([a, b]) => (t === a && out.includes(b)) || (t === b && out.includes(a)));
  if (!rng) return out;
  for (const p of parents) {
    for (const t of (p.traits || [])) {
      if (out.length >= 3) break;
      if (rng.chance(TRAIT_INHERIT) && fits(t)) out.push(t);
    }
  }
  const want = rng.chance(0.4) ? 3 : 2;      // то же распределение, что у правителей в politics.js
  let guard = 0;
  while (out.length < want && guard++ < 50) {
    const t = rng.pick(TRAIT_IDS);
    if (fits(t)) out.push(t);
  }
  return out.slice(0, 3);
}

function _wed(a, b) { a.spouse = b.id; b.spouse = a.id; }

function _pickName(rng, sex) {
  const pool = sex === 'ж' ? FEMALE_NAMES : MALE_NAMES;
  return rng ? rng.pick(pool.length ? pool : NAMES) : NAMES[0];
}

// Снимок мира в понятных роду числах. Никаких объектов ядра здесь не бывает —
// именно поэтому модуль гоняется в тесте без Simulation.
function readCtx(ctx) {
  const o = ctx || {};
  const gov = SUCCESSION_LAW[o.gov] ? o.gov : 'chiefdom';
  return {
    day: Math.max(0, Math.round(numOf(o.day, 0))),
    gov,
    era: Math.max(0, Math.round(numOf(o.era, 0))),
    pop: Math.max(0, Math.round(numOf(o.pop, 0))),
    gold: Math.max(0, numOf(o.gold, 0)),
    foodDays: numOf(o.foodDays, 99),
    wars: Math.max(0, Math.round(numOf(o.wars, 0))),
    stability: clamp(numOf(o.stability, 50), 0, 100),
    happy: clamp(numOf(o.happy, 50), 0, 100),
    mortalityMult: Math.max(0, numOf(o.mortalityMult, 1)),
    nobles: clamp(numOf(o.nobles, 50), 0, 100),
    military: clamp(numOf(o.military, 50), 0, 100),
    events: Array.isArray(o.events) ? o.events.filter(e => e && typeof e.kind === 'string') : [],
  };
}

function zeroMods() {
  return {
    stability: 0, happy: 0, goldPerDay: 0,
    estates: { nobles: 0, clergy: 0, merchants: 0, commons: 0, military: 0 },
    relations: {},
  };
}

function clone(s) { return s ? JSON.parse(JSON.stringify(s)) : s; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function clampInt(v, lo, hi) { const n = Math.round(numOf(v, lo)); return n < lo ? lo : (n > hi ? hi : n); }
function numOf(v, def) { return Number.isFinite(v) ? v : def; }
function strOf(v, def) { return typeof v === 'string' && v ? v : def; }

/* ПОДКЛЮЧЕНИЕ ─────────────────────────────────────────────────────────────────

Все якоря проверены grep -F по файлу integrate.js: каждый встречается РОВНО
ОДИН РАЗ (число совпадений указано у каждого).

── 1. ИМПОРТ ──────────────────────────────────────────────────────────────────
Якорь (1 совпадение):

import * as HERD from './herds.js';

ПОСЛЕ него добавить строку:

import * as DYN from './dynasty.js';

── 2. УСТАНОВКА ───────────────────────────────────────────────────────────────
Якорь в installSystems (1 совпадение):

  sim.herds = HERD.createHerds();

ПЕРЕД этой строкой (или сразу после неё — важно лишь то, что POL.installPolitics
уже отработал и sim.politics существует) добавить:

  // Род, а не сменный человек: у власти стоит семья с именами и наследниками.
  sim.dynasty = DYN.createDynasty(sim.rng, { day: sim.day });
  // Правитель politics.js СТАНОВИТСЯ главой рода. Это не второй правитель:
  // politics.state.ruler остаётся единственным местом, откуда ядро берёт черты
  // и множители, — просто теперь его туда кладёт род, а не createRuler().
  if (sim.politics && sim.politics.state) {
    const r0 = DYN.politicsRuler(sim.dynasty);
    if (r0) sim.politics.state.ruler = r0;
  }

── 3. ДЕНЬ ────────────────────────────────────────────────────────────────────
Якорь в systemsNewDay (1 совпадение):

  POL.politicsNewDay(sim);

ПОСЛЕ него добавить:

  applyDynasty(sim);

Порядок обязателен: politics считает смерть правителя первой, род читает уже
сложившийся день. Ставить applyDynasty ПЕРЕД politicsNewDay нельзя — иначе род
выберет наследника до того, как правитель умер, и трон сменится на сутки раньше
журнала.

── 4. СОХРАНЕНИЕ ──────────────────────────────────────────────────────────────
Якорь в systemsSerialize (1 совпадение):

    pol: POL.politicsSerialize(sim),

ПОСЛЕ него добавить:

    dyn: DYN.serializeDynasty(sim.dynasty),

Якорь в systemsRestore (1 совпадение):

  if (data.pol) POL.politicsRestore(sim, data.pol);

ПОСЛЕ него добавить:

  sim.dynasty = DYN.restoreDynasty(data.dyn);

Старый сейв без поля dyn грузится: restoreDynasty(undefined) вернёт пустой род.
Пустой род — это род без правителя; ближайший же applyDynasty поднимет новый
дом (междуцарствие длиной ноль), и партия продолжится.

── 5. ПРИМЕНИТЕЛЬ И ЭКРАН ─────────────────────────────────────────────────────
Якорь (1 совпадение):

export function mastersPanel(sim) { return MAS.mastersReport(sim); }

ПОСЛЕ него добавить блок целиком:

// ---------- Династия ----------
// Род ничего не пишет в sim: он возвращает новое состояние и отчёт, а всё
// применение — здесь. Единственное место, где sim и род встречаются.
function dynastyCtx(sim) {
  const st = sim.politics && sim.politics.state;
  const pop = sim.villagers ? sim.villagers.length : 0;
  return {
    day: sim.day, gov: st ? st.gov : 'chiefdom', era: sim.eraIndex, pop,
    gold: sim.res ? sim.res.gold : 0,
    foodDays: sim.res ? sim.res.food / Math.max(1, pop * 0.7) : 99,
    wars: Array.isArray(sim.wars) ? sim.wars.length : 0,
    stability: st ? st.stability : 50,
    happy: sim._happy != null ? sim._happy : 50,
    mortalityMult: sim.plagueMult ? sim.plagueMult() : 1,
    nobles: st ? st.factions.nobles : 50,
    military: st ? st.factions.military : 50,
    // СОБЫТИЯ, А НЕ СОСТОЯНИЯ. Список разовых ударов за эти сутки; род сам
    // держит сезонное окно, чтобы месяц голода не считался тридцать раз.
    events: sim.sys && sim.sys.dynEvents ? sim.sys.dynEvents : [],
  };
}

function applyDynasty(sim) {
  if (!sim.dynasty) sim.dynasty = DYN.createDynasty(sim.rng, { day: sim.day });
  const rep = DYN.dynastyNewDay(sim.dynasty, dynastyCtx(sim), sim.rng);
  sim.dynasty = rep.state;
  const st = sim.politics && sim.politics.state;
  if (st) {
    st.stability = Math.max(0, Math.min(100, st.stability + rep.mods.stability));
    for (const [fid, d] of Object.entries(rep.mods.estates)) {
      if (st.factions[fid] != null) st.factions[fid] = Math.max(0, Math.min(100, st.factions[fid] + d));
    }
    // Правитель ядра — это глава рода. Пока идёт междуцарствие, ruler = null,
    // и politics.js сам поставит временного: пустой трон ядру не нужен.
    const r = DYN.politicsRuler(sim.dynasty);
    if (r) st.ruler = r;
  }
  if (rep.mods.goldPerDay && sim.res) sim.res.gold = Math.max(0, sim.res.gold + rep.mods.goldPerDay);
  for (const e of rep.events) {
    sim.addLog(e.text, e.type === 'bad' ? 'bad' : (e.type === 'good' ? 'good' : 'info'));
    if (e.cause === 'succession' || e.cause === 'interregnum' || e.cause === 'coup' || e.cause === 'house_change') {
      sim.addChronicle(e.text);
    }
  }
  sim.sys.dynastyReport = rep;
  sim.sys.dynEvents = [];      // список разовых ударов израсходован
}

export function dynastyPanel(sim) { return DYN.dynastyCard(sim.dynasty, dynastyCtx(sim)); }
export function dynastyRows(sim) { return DYN.dynastyRows(sim.dynasty, dynastyCtx(sim)); }
// Действия игрока. Каждое возвращает { ok, reason } — кнопка показывает причину
// отказа словами, а не гаснет молча.
export function dynastyPatronize(sim) {
  const r = DYN.patronizeCourt(sim.dynasty, dynastyCtx(sim));
  if (r.ok) {
    sim.dynasty = r.state;
    sim.res.gold = Math.max(0, sim.res.gold + r.mods.gold);
    const st = sim.politics && sim.politics.state;
    if (st) for (const [fid, d] of Object.entries(r.mods.estates)) {
      if (st.factions[fid] != null) st.factions[fid] = Math.max(0, Math.min(100, st.factions[fid] + d));
    }
    for (const e of r.events) sim.addLog(e.text, e.type);
  } else if (typeof sim.toast === 'function') sim.toast(r.reason);
  return r;
}
export function dynastyNameHeir(sim, id) {
  const r = DYN.nameHeir(sim.dynasty, id, dynastyCtx(sim));
  if (r.ok) { sim.dynasty = r.state; for (const e of r.events) sim.addLog(e.text, e.type); }
  else if (typeof sim.toast === 'function') sim.toast(r.reason);
  return r;
}
export function dynastyMarry(sim, fid, house) {
  const r = DYN.marryHeir(sim.dynasty, dynastyCtx(sim), { fid, house, rel: relValue(sim, fid) }, sim.rng);
  if (r.ok) {
    sim.dynasty = r.state;
    for (const e of r.events) sim.addLog(e.text, e.type);
    // Отношения ядро держит то числом, то объектом с полем v — трогаем ту же
    // форму, в какой они лежат, иначе прибавка потеряется молча.
    const cur = sim.relations && sim.relations[fid];
    if (typeof cur === 'number') sim.relations[fid] = cur + r.mods.relations[fid];
    else if (cur && typeof cur.v === 'number') cur.v += r.mods.relations[fid];
  } else if (typeof sim.toast === 'function') sim.toast(r.reason);
  return r;
}
export function dynastyOverthrow(sim, claimant) {
  const r = DYN.overthrow(sim.dynasty, dynastyCtx(sim), { claimant }, sim.rng);
  if (r.ok) {
    sim.dynasty = r.state;
    const st = sim.politics && sim.politics.state;
    if (st) st.stability = Math.max(0, st.stability + r.mods.stability);
    for (const e of r.events) { sim.addLog(e.text, e.type); sim.addChronicle(e.text); }
  } else if (typeof sim.toast === 'function') sim.toast(r.reason);
  return r;
}
export function dynastySetCourt(sim, level) {
  const r = DYN.setCourt(sim.dynasty, level);
  if (r.ok) { sim.dynasty = r.state; for (const e of r.events) sim.addLog(e.text, e.type); }
  else if (typeof sim.toast === 'function') sim.toast(r.reason);
  return r;
}

── 6. РАЗОВЫЕ УДАРЫ ПО ЗАКОННОСТИ (необязательно, но ради этого всё и делалось)
Род принимает список ctx.events вида [{ kind, scale, key }]. Породы:
victory, triumph, city_won, defeat, city_lost, famine, plague, revolt.
Собирать их удобно там, где они и рождаются, — в systemsNewDay, рядом с
harvestScars: у applyWarLinks и applySurvivalLinks отчёты уже на руках.
Достаточно завести sim.sys.dynEvents = [...] перед вызовом applyDynasty;
пока этого нет, род живёт на одном дневном дрейфе, и это не ломает ничего.

ЧЕГО ДЕЛАТЬ НЕЛЬЗЯ:
  · звать dynastyNewDay дважды в сутки. Модуль защищён (state.day === ctx.day
    → пустой отчёт без единого обращения к rng), но второй вызов означал бы,
    что кто-то считает день дважды;
  · подменять sim.politics.state.ruler мимо politicsRuler(): там возраст в
    ГОДАХ, а в роду — в ДНЯХ, и правитель мгновенно станет столетним;
  · передавать в ctx.events состояние («у нас сейчас голод») каждый день.
    Событие — это «сегодня начался голод». Сезонное окно спасёт от повтора,
    но кормить его состояниями — значит однажды всё-таки обнулить законность.

────────────────────────────────────────────────────────────────────────────── */
