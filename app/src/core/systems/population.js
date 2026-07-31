// core/systems/population.js — демография, профессии, запросы и именные жители.
// Закрывает U05 (поколения), U06 (профессии с рангами), U09 (запросы поселения),
// U10 (именные жители с чертами и историей). Чистый JS: ни DOM, ни Math.random.
// Единица возраста та же, что в ядре: 1 день = 1 единица v.age, 100 дней = 1 год
// (сезон 25 дней × 4). Модуль НЕ трогает v.age — его по-прежнему увеличивает ядро.
//
// ============================ INTEGRATION ============================
// 1) simulation.js, импорт рядом с остальными:
//      import * as Pop from './systems/population.js';
//
// 2) constructor(), после `this.villagers = [];`:
//      this.pop = Pop.createPopulation(this.rng);
//    и в самом конце конструктора (жители уже созданы):
//      Pop.syncVillagers(this.pop, this.villagers, this.rng);
//
// 3) onNewDay(): блок «рождения» (happy>45 && ... spawnVillager) УДАЛИТЬ — рождения
//    теперь считает модуль. Блок «старение и смерть» ОСТАВИТЬ как есть (он двигает
//    v.age и служит страховкой на 110 лет). Сразу после него вставить:
//      const rep = Pop.tickDay(this.pop, this.villagers, {
//        day: this.day,
//        housingCap: this.housingCap(),
//        happiness: this._happy ?? this.happiness(),
//        foodDays: this.res.food / Math.max(1, this.villagers.length * 0.7),
//        birthMult: (this.hasBuilding('hospital') ? 1.3 : 1) * (this.hasBuilding('biolab') ? 1.2 : 1),
//        mortalityMult: this.plagueMult ? this.plagueMult() : 1,
//        builtIds: this.doneBuildings().map(b => b.id),
//        buildable: Object.keys(BUILDINGS).filter(id => !BUILDINGS[id].req || this.techs.has(BUILDINGS[id].req)),
//        homeX: this.world.startX, homeY: this.world.startY,
//      }, this.rng);
//      for (const e of rep.events) this.addLog(e.text, e.type);
//      this.villagers = this.villagers.filter(v => v.hp > 0);
//
// 4) happiness(): перед клампом добавить строку
//      h += Pop.happyMod(this.pop);
//
// 5) tickVillagers(), ветка `if (v.atWork)`: заменить вызов производства на
//      const ind = Pop.industryOfBuilding(b.id);
//      Pop.registerWork(this.pop, v, ind, dt);
//      this.produceAt(b, dt, happyMult * Pop.workMult(v, ind));
//    (workMult попадает в happyMult, потому что produceAt множит на него выработку,
//     но не сырьё в def.consume — фабрика не начнёт жрать больше камня от опыта.)
//
// 6) serialize(): добавить поле  pop: Pop.serialize(this.pop, this.villagers),
//    deserialize(): после восстановления sim.villagers добавить
//      sim.pop = Pop.deserialize(data.pop, sim.villagers, sim.rng);
//
// 7) HUD: Pop.activeRequest(sim.pop) — карточка текущего запроса;
//         Pop.villagerCard(v) — {title, lines} для панели жителя.
// =====================================================================

import { NAMES, BUILDINGS } from '../data.js';

export const YEAR = 100;               // дней в игровом году
const ADULT_AGE = 16;                  // с этого возраста житель считается взрослым
const PAIR_MIN = 17;                   // раньше пару не образуют
const PAIR_MAX = 55;                   // позже — уже не ищут
const FERT_MIN = 18, FERT_MAX = 42;    // окно фертильности женщины
const BIRTH_BASE = 0.0038;             // базовый дневной шанс родов у пары
const BIRTH_CD = 200;                  // 2 года между родами
const REQUEST_DEADLINE = 60;           // срок на исполнение просьбы, дней
const REQUEST_GAP = 90;                // пауза между просьбами
const REQUEST_MIN_POP = 8;             // меньшее поселение ещё ничего не требует
const MOOD_DECAY = 0.2;                // затухание настроения от просьб, ед./день

// Пороги опыта для рангов 1/2/3. Ранг даёт +15% к добыче за ступень (U06).
export const RANK_DAYS = [150, 450, 1100];
export const RANK_BONUS = 0.15;
const EXP_DECAY_WORK = 0.5;            // забывание отрасли, пока работаешь в другой
const EXP_DECAY_IDLE = 0.2;            // забывание у бездельника

// ---- Отрасли (совпадают с категориями труда ядра) ----
export const PROFESSIONS = {
  food:    { ru: 'земледелец', plural: 'земледельцы' },
  wood:    { ru: 'лесоруб',    plural: 'лесорубы' },
  stone:   { ru: 'рудокоп',    plural: 'рудокопы' },
  science: { ru: 'книжник',    plural: 'книжники' },
  gold:    { ru: 'торговец',   plural: 'торговцы' },
  build:   { ru: 'строитель',  plural: 'строители' },
};

// ---- Черты характера (U10). work/fert/mort — множители, learn — скорость роста ранга ----
export const TRAITS = [
  { id: 'diligent', ru: 'трудолюбивый', ruF: 'трудолюбивая', desc: '+10% к выработке',        work: 1.1 },
  { id: 'lazy',     ru: 'ленивый',      ruF: 'ленивая',      desc: '−10% к выработке',        work: 0.9 },
  { id: 'hardy',    ru: 'крепкий',      ruF: 'крепкая',      desc: 'реже болеет',             mort: 0.7 },
  { id: 'sickly',   ru: 'болезненный',  ruF: 'болезненная',  desc: 'здоровье подводит',       mort: 1.6 },
  { id: 'curious',  ru: 'любознательный', ruF: 'любознательная', desc: 'быстро учится ремеслу', learn: 1.4 },
  { id: 'stubborn', ru: 'упрямый',      ruF: 'упрямая',      desc: 'медленно забывает ремесло', forget: 0.5 },
  { id: 'family',   ru: 'семейный',     ruF: 'семейная',     desc: 'большая семья',           fert: 1.35 },
  { id: 'loner',    ru: 'нелюдимый',    ruF: 'нелюдимая',    desc: 'поздно заводит семью',    fert: 0.7 },
  { id: 'brave',    ru: 'храбрый',      ruF: 'храбрая',      desc: 'первым идёт на стену',    mort: 1.1, work: 1.05 },
];
const TRAIT_BY_ID = Object.fromEntries(TRAITS.map(t => [t.id, t]));

// ---- Просьбы поселения (U09). Просим только то, что игрок реально может построить ----
// kind нужен, чтобы просьба попадала в больное место: несчастным нужен храм,
// больным — лечебница, тесно живущим — дома.
export const REQUEST_DEFS = [
  { building: 'hut',          kind: 'housing', ru: 'нужны хижины — спать негде' },
  { building: 'stone_house',  kind: 'housing', ru: 'нужен каменный дом — в хижинах тесно' },
  { building: 'apartment',    kind: 'housing', ru: 'нужна многоэтажка — город растёт' },
  { building: 'skyscraper',   kind: 'housing', ru: 'нужен небоскрёб — земли под дома не осталось' },
  { building: 'granary',      kind: 'food',    ru: 'нужен амбар — зерно негде хранить' },
  { building: 'farm',         kind: 'food',    ru: 'нужна ещё ферма — собирательством сыт не будешь', repeat: true },
  { building: 'pasture',      kind: 'food',    ru: 'нужно пастбище — зимой пусто на столе' },
  { building: 'temple',       kind: 'happy',   ru: 'нужен храм — людям нужна вера' },
  { building: 'amphitheater', kind: 'happy',   ru: 'нужен амфитеатр — людям нужны зрелища' },
  { building: 'aqueduct',     kind: 'happy',   ru: 'нужен акведук — за водой ходят через полгорода' },
  { building: 'media_tower',  kind: 'happy',   ru: 'нужен телецентр — вечера скучны' },
  { building: 'clinic',       kind: 'health',  ru: 'нужна лечебница — болеть страшно' },
  { building: 'sewers',       kind: 'health',  ru: 'нужна канализация — улицы смердят' },
  { building: 'hospital',     kind: 'health',  ru: 'нужен госпиталь — старикам не к кому идти' },
  { building: 'market',       kind: 'gold',    ru: 'нужен рынок — товар некуда деть' },
  { building: 'story_fire',   kind: 'science', ru: 'нужен костёр историй — детям нечего слушать' },
  { building: 'academy',      kind: 'science', ru: 'нужна академия — молодым негде учиться' },
  { building: 'university',   kind: 'science', ru: 'нужен университет — знания уходят на сторону' },
  { building: 'barracks',     kind: 'safety',  ru: 'нужна казарма — защищаться нечем' },
  { building: 'palisade',     kind: 'safety',  ru: 'нужен частокол — ночью страшно' },
];

// ================= СОСТОЯНИЕ =================

// Всё состояние — простой объект, кладётся в JSON без потерь.
export function createPopulation(rng, opts = {}) {
  return {
    ver: 1,
    nextPid: 1,
    day: 0,
    mood: 0,                    // вклад просьб в счастье, затухает
    request: null,              // {building, kind, issued, deadline, base}
    requestCooldown: opts.firstRequestDay ?? REQUEST_GAP,
    stats: { births: 0, deaths: 0, requestsDone: 0, requestsFailed: 0 },
    yearBirths: [],             // [{year, born, died, pop}] — хроника демографии, хвост 80 лет
  };
}

// Выдаёт пол, черту и учётную карточку всем новым жителям (в т.ч. созданным ядром
// через spawnVillager или пришедшим из старого сейва). Идемпотентна.
export function syncVillagers(state, villagers, rng, opts = {}) {
  for (const v of villagers) {
    if (v.pid) continue;
    v.pid = state.nextPid++;
    v.sex = opts.sex || inferSex(v.name, rng);
    v.fam = famOf(v.name);
    v.trait = rng.pick(TRAITS).id;
    v.partner = null;
    v.children = 0;
    v.exp = {};
    v.prof = null;
    v.rank = 0;
    v.fertCd = 0;
    v.deeds = [];
    v.wprof = null;
  }
  return villagers;
}

// ================= ГЛАВНЫЙ ТИК =================

// Один игровой день. Не удаляет жителей из массива (это делает ядро фильтром
// по hp>0), а помечает умерших v.hp = 0 и возвращает отчёт.
export function tickDay(state, villagers, ctx, rng) {
  const day = ctx.day ?? state.day + 1;
  state.day = day;
  syncVillagers(state, villagers, rng);

  const report = { day, events: [], born: [], died: [], pop: 0 };
  const alive = villagers.filter(v => v.hp > 0);
  const byPid = new Map(alive.map(v => [v.pid, v]));

  _tickSkills(alive);
  _tickDeaths(state, alive, byPid, ctx, rng, report);

  const living = alive.filter(v => v.hp > 0);
  _tickPairs(state, living, byPid, rng);
  _tickBirths(state, living, villagers, byPid, ctx, rng, report);
  _tickRequest(state, living, ctx, rng, report);

  // Настроение от просьб тянется к нулю: похвала не вечна, обида тоже.
  if (state.mood) {
    const step = Math.min(MOOD_DECAY, Math.abs(state.mood));
    state.mood += state.mood > 0 ? -step : step;
    if (Math.abs(state.mood) < 1e-6) state.mood = 0;
  }

  report.pop = villagers.filter(v => v.hp > 0).length;
  _writeYearRow(state, day, report);
  return report;
}

// ---- U06: опыт и ранги ----
function _tickSkills(alive) {
  for (const v of alive) {
    const worked = v.wprof;
    const forget = (TRAIT_BY_ID[v.trait]?.forget ?? 1);
    for (const key of Object.keys(v.exp)) {
      if (key === worked) continue;
      const decay = (worked ? EXP_DECAY_WORK : EXP_DECAY_IDLE) * forget;
      v.exp[key] = Math.max(0, v.exp[key] - decay);
      if (v.exp[key] === 0) delete v.exp[key];
    }
    // Профессия — отрасль с наибольшим опытом. Смена не мгновенна: старый опыт
    // тает медленнее, чем копится новый, поэтому ранг переживает подработку.
    let best = null, bestExp = 0;
    for (const [key, e] of Object.entries(v.exp)) if (e > bestExp) { best = key; bestExp = e; }
    v.prof = best;
    v.rank = expToRank(bestExp);
    v.wprof = null; // сбрасываем отметку: её заново поставит registerWork
  }
}

// ---- U05: смертность ----
function _tickDeaths(state, alive, byPid, ctx, rng, report) {
  const globalMort = ctx.mortalityMult ?? 1;
  const hunger = (ctx.foodDays ?? 99) < 2 ? 3 : (ctx.foodDays ?? 99) < 5 ? 1.5 : 1;
  for (const v of alive) {
    const years = ageYears(v);
    const trait = TRAIT_BY_ID[v.trait]?.mort ?? 1;
    const q = annualMortality(years) * trait * globalMort * hunger;
    if (!rng.chance(q / YEAR)) continue;
    v.hp = 0;
    const cause = years >= 55 ? 'age' : years < ADULT_AGE ? 'child' : 'illness';
    if (v.partner && byPid.has(v.partner)) {
      const p = byPid.get(v.partner);
      p.partner = null;
      recordDeed(p, 'пережил(а) супруга');
    }
    state.stats.deaths++;
    report.died.push({ v, cause });
    report.events.push({ text: obituary(v, cause), type: 'bad' });
  }
}

// ---- U05: пары ----
function _tickPairs(state, living, byPid, rng) {
  const free = living.filter(v => !v.partner && ageYears(v) >= PAIR_MIN && ageYears(v) <= PAIR_MAX);
  if (free.length < 2) return;
  // Сортировка по возрасту обязательна: при переборе «по индексу массива» пара
  // ровесников могла не сложиться никогда — порядок жителей стабилен, и один и
  // тот же неподходящий по возрасту дуэт отбраковывался бы каждый день подряд.
  const byAge = (a, b) => a.age - b.age;
  const men = free.filter(v => v.sex === 'м').sort(byAge);
  const women = free.filter(v => v.sex === 'ж').sort(byAge);
  const n = Math.min(men.length, women.length);
  for (let i = 0; i < n; i++) {
    const m = men[i], w = women[i];
    if (m.partner || w.partner) continue;
    // Разница в возрасте больше 15 лет пару не образует — иначе дед женится на внучке.
    if (Math.abs(ageYears(m) - ageYears(w)) > 15) continue;
    const shy = (TRAIT_BY_ID[m.trait]?.fert ?? 1) * (TRAIT_BY_ID[w.trait]?.fert ?? 1);
    if (!rng.chance(0.03 * shy)) continue;
    m.partner = w.pid; w.partner = m.pid;
    byPid.set(m.pid, m); byPid.set(w.pid, w);
  }
}

// ---- U05: рождения ----
function _tickBirths(state, living, villagers, byPid, ctx, rng, report) {
  const cap = ctx.housingCap ?? Infinity;
  let pop = living.length;
  const cond = birthConditions(ctx);
  for (const w of living) {
    if (w.fertCd > 0) w.fertCd--;
    if (w.sex !== 'ж' || !w.partner) continue;
    const father = byPid.get(w.partner);
    if (!father || father.hp <= 0) continue;
    const years = ageYears(w);
    if (years < FERT_MIN || years > FERT_MAX) continue;
    if (w.fertCd > 0) continue;
    if (pop >= cap) continue; // некуда селить — детей не заводят
    const traitF = (TRAIT_BY_ID[w.trait]?.fert ?? 1);
    const p = BIRTH_BASE * ageFertility(years) * cond * traitF;
    if (!rng.chance(p)) continue;
    const baby = _makeBaby(state, w, father, ctx, rng);
    villagers.push(baby);
    byPid.set(baby.pid, baby);
    pop++;
    w.fertCd = BIRTH_CD;
    w.children++; father.children++;
    if (w.children === 1) recordDeed(w, 'родила первенца');
    if (w.children === 5) recordDeed(w, 'мать большого рода');
    if (father.children === 5) recordDeed(father, 'глава большого рода');
    state.stats.births++;
    report.born.push(baby);
    report.events.push({ text: `${baby.name} родился(ась) у ${shortName(w)} и ${shortName(father)}.`, type: 'good' });
  }
}

function _makeBaby(state, mother, father, ctx, rng) {
  const sex = rng.chance(0.5) ? 'м' : 'ж';
  const fam = father.fam || mother.fam || famOf(mother.name);
  const baby = {
    // поля ядра — форма совпадает со spawnVillager, ядро продолжит работать как раньше
    name: pickName(rng, sex) + ' ' + fam,
    x: ctx.homeX ?? mother.x, y: ctx.homeY ?? mother.y,
    tx: ctx.homeX ?? mother.x, ty: ctx.homeY ?? mother.y,
    age: 0, job: 'idle', target: null, path: null, busy: 0, hp: 100, home: null,
    // поля модуля
    pid: state.nextPid++, sex, fam, trait: rng.pick(TRAITS).id,
    partner: null, children: 0, exp: {}, prof: null, rank: 0, fertCd: 0,
    deeds: [], wprof: null, parents: [mother.pid, father.pid],
  };
  return baby;
}

// ---- U09: запросы поселения ----
function _tickRequest(state, living, ctx, rng, report) {
  const built = ctx.builtIds || [];
  const req = state.request;
  if (req) {
    if (countIn(built, req.building) > req.base) {
      state.request = null;
      state.requestCooldown = REQUEST_GAP;
      state.stats.requestsDone++;
      state.mood += 9;
      report.events.push({ text: `Просьба исполнена: ${BUILDINGS[req.building].name}. Поселение довольно.`, type: 'good' });
    } else if (state.day >= req.deadline) {
      state.request = null;
      state.requestCooldown = REQUEST_GAP;
      state.stats.requestsFailed++;
      state.mood -= 7;
      report.events.push({ text: `Жители так и не дождались: ${BUILDINGS[req.building].name}. Настроение упало.`, type: 'bad' });
    }
    return;
  }
  if (state.requestCooldown > 0) { state.requestCooldown--; return; }
  if (living.length < REQUEST_MIN_POP) return;
  const def = pickRequest(state, ctx, rng);
  if (!def) return;
  state.request = {
    building: def.building, kind: def.kind, ru: def.ru,
    issued: state.day, deadline: state.day + REQUEST_DEADLINE,
    base: countIn(built, def.building),
  };
  report.events.push({ text: `Жители просят: ${def.ru}. Срок — ${REQUEST_DEADLINE} дней.`, type: 'info' });
}

// Выбираем из того, что реально доступно игроку (ctx.buildable — id зданий с
// изученной технологией). Вес зависит от беды: голодным просить храм глупо.
function pickRequest(state, ctx, rng) {
  const buildable = new Set(ctx.buildable || []);
  const built = ctx.builtIds || [];
  const pool = [];
  for (const d of REQUEST_DEFS) {
    if (!buildable.has(d.building)) continue;
    if (!d.repeat && countIn(built, d.building) > 0) continue;
    pool.push({ d, w: requestWeight(d.kind, ctx) });
  }
  const total = pool.reduce((a, e) => a + e.w, 0);
  if (total <= 0) return null;
  let r = rng.range(0, total);
  for (const e of pool) { r -= e.w; if (r <= 0) return e.d; }
  return pool[pool.length - 1].d;
}

function requestWeight(kind, ctx) {
  const happy = ctx.happiness ?? 50;
  const foodDays = ctx.foodDays ?? 99;
  const free = (ctx.housingCap ?? 0) - (ctx.pop ?? 0);
  switch (kind) {
    case 'happy':   return happy < 55 ? 6 : 2;
    case 'health':  return (ctx.mortalityMult ?? 1) >= 1 ? 5 : 2;
    case 'housing': return free <= 3 ? 7 : 1;
    case 'food':    return foodDays < 10 ? 6 : 2;
    case 'science': return 2;
    case 'gold':    return 2;
    case 'safety':  return ctx.threat ? 5 : 1.5;
    default:        return 1;
  }
}

// ================= U06: работа =================

// Вызывается ядром, когда житель отработал dt дней в отрасли.
export function registerWork(state, v, industry, dt) {
  if (!industry || !v || !v.exp) return;
  const learn = TRAIT_BY_ID[v.trait]?.learn ?? 1;
  const before = expToRank(v.exp[industry] || 0);
  v.exp[industry] = (v.exp[industry] || 0) + dt * learn;
  v.wprof = industry;
  const after = expToRank(v.exp[industry]);
  if (after > before) {
    if (after === 2) recordDeed(v, `стал(а) опытным: ${PROFESSIONS[industry].ru}`);
    if (after === 3) recordDeed(v, `мастер-${PROFESSIONS[industry].ru}`);
  }
}

// Множитель выработки жителя в отрасли: ранг, черта, возраст.
export function workMult(v, industry) {
  if (!v) return 1;
  let m = 1;
  if (industry && v.exp) m += RANK_BONUS * expToRank(v.exp[industry] || 0);
  m *= TRAIT_BY_ID[v.trait]?.work ?? 1;
  const years = ageYears(v);
  if (years < 14) m *= 0.5;        // дети помогают, но вполсилы
  else if (years > 70) m *= 0.8;   // старики работают медленнее
  return m;
}

export function expToRank(exp) {
  let r = 0;
  for (const t of RANK_DAYS) if (exp >= t) r++;
  return r;
}

// Отрасль здания — та же классификация, что в labor-приоритетах ядра.
export function industryOfBuilding(id) {
  const def = BUILDINGS[id];
  if (!def || !def.out) return null;
  if (def.out.food) return 'food';
  if (def.out.wood) return 'wood';
  if (def.out.knowledge) return 'science';
  if (def.out.gold) return 'gold';
  if (def.out.stone || def.out.steel) return 'stone';
  return null;
}

// ================= U10: имена, черты, история =================

export function recordDeed(v, text) {
  if (!v.deeds) v.deeds = [];
  if (v.deeds.includes(text)) return;
  v.deeds.push(text);
  if (v.deeds.length > 6) v.deeds.shift();
}

export function ageYears(v) { return Math.floor((v.age || 0) / YEAR); }

export function profTitle(v) {
  if (!v.prof) return v.sex === 'ж' ? 'без ремесла' : 'без ремесла';
  const ru = PROFESSIONS[v.prof].ru;
  if (v.rank >= 3) return `мастер-${ru}`;
  if (v.rank === 2) return `${v.sex === 'ж' ? 'опытная' : 'опытный'} ${ru}`;
  return ru;
}

export function traitTitle(v) {
  const t = TRAIT_BY_ID[v.trait];
  if (!t) return '';
  return v.sex === 'ж' ? t.ruF : t.ru;
}

// Карточка для HUD: заголовок и строки. Интерфейс сам решает, как рисовать.
export function villagerCard(v) {
  const years = ageYears(v);
  const lines = [
    `${years} ${plural(years, 'год', 'года', 'лет')}, ${v.sex === 'ж' ? 'женщина' : 'мужчина'}`,
    `Ремесло: ${profTitle(v)}${v.rank ? ` (ранг ${v.rank}, +${Math.round(v.rank * RANK_BONUS * 100)}% к добыче)` : ''}`,
    `Характер: ${traitTitle(v)} — ${TRAIT_BY_ID[v.trait]?.desc ?? ''}`,
    v.partner ? 'В паре' : 'Один(одна)',
    v.children ? `Детей: ${v.children}` : 'Детей нет',
  ];
  if (v.deeds && v.deeds.length) lines.push('Заслуги: ' + v.deeds.join('; '));
  return { title: v.name, lines };
}

// Осмысленный некролог: кто это был, а не «житель умер».
export function obituary(v, cause = 'age') {
  const years = ageYears(v);
  const yr = `${years} ${plural(years, 'год', 'года', 'лет')}`;
  const how = cause === 'age' ? 'умер(ла) от старости'
    : cause === 'child' ? 'умер(ла) ребёнком'
      : 'умер(ла) от болезни';
  const parts = [`☠ ${v.name}, ${yr}, ${how}.`];
  const who = [];
  if (v.prof && v.rank >= 1) who.push(profTitle(v));
  if (v.children > 0) who.push(`вырастил(а) ${v.children} ${plural(v.children, 'ребёнка', 'детей', 'детей')}`);
  if (who.length) parts.push(capitalize(who.join(', ')) + '.');
  if (v.deeds && v.deeds.length) parts.push(capitalize(v.deeds[v.deeds.length - 1]) + '.');
  return parts.join(' ');
}

// ================= Демография наружу =================

export function happyMod(state) { return state ? Math.round(state.mood) : 0; }

export function activeRequest(state) {
  const r = state && state.request;
  if (!r) return null;
  return {
    building: r.building,
    name: BUILDINGS[r.building].name,
    text: `Жители просят: ${r.ru}`,
    daysLeft: Math.max(0, r.deadline - state.day),
  };
}

// Возрастная пирамида для HUD/отладки: сколько детей, взрослых, стариков.
export function pyramid(villagers) {
  const out = { children: 0, adults: 0, elders: 0, fertile: 0, pairs: 0 };
  for (const v of villagers) {
    if (v.hp <= 0) continue;
    const y = ageYears(v);
    if (y < ADULT_AGE) out.children++;
    else if (y < 60) out.adults++;
    else out.elders++;
    if (v.sex === 'ж' && y >= FERT_MIN && y <= FERT_MAX) out.fertile++;
    if (v.partner) out.pairs++;
  }
  out.pairs = Math.floor(out.pairs / 2);
  return out;
}

// ================= Сохранение =================

// Ядро кладёт в сейв только name/x/y/age/hp, поэтому поля модуля сохраняем сами,
// по индексу массива — порядок жителей ядро при загрузке не меняет.
export function serialize(state, villagers) {
  return {
    state: JSON.parse(JSON.stringify(state)),
    people: villagers.filter(v => v.hp > 0).map(v => ({
      pid: v.pid, sex: v.sex, fam: v.fam, trait: v.trait, partner: v.partner,
      children: v.children, exp: v.exp, prof: v.prof, rank: v.rank,
      fertCd: v.fertCd, deeds: v.deeds, parents: v.parents,
    })),
  };
}

export function deserialize(data, villagers, rng) {
  if (!data || !data.state) {
    const st = createPopulation(rng || { pick: (a) => a[0] });
    if (rng) syncVillagers(st, villagers, rng);
    return st;
  }
  const state = JSON.parse(JSON.stringify(data.state));
  const people = data.people || [];
  for (let i = 0; i < villagers.length; i++) {
    const rec = people[i];
    if (!rec) continue;
    Object.assign(villagers[i], {
      pid: rec.pid, sex: rec.sex, fam: rec.fam, trait: rec.trait, partner: rec.partner,
      children: rec.children || 0, exp: rec.exp || {}, prof: rec.prof || null,
      rank: rec.rank || 0, fertCd: rec.fertCd || 0, deeds: rec.deeds || [],
      parents: rec.parents, wprof: null,
    });
  }
  if (rng) syncVillagers(state, villagers, rng);
  return state;
}

// ================= Внутренняя кухня =================

// Годовая вероятность смерти. Кривая доиндустриальная: высокая детская смертность,
// плато у взрослых, удвоение риска каждые 8 лет после 60 — отсюда конечная жизнь
// без жёсткого «умер ровно в 110», как было в ядре.
export function annualMortality(years) {
  if (years < 1) return 0.06;
  if (years < 5) return 0.02;
  if (years < 15) return 0.006;
  if (years < 45) return 0.005;
  if (years < 60) return 0.011;
  return Math.min(0.85, 0.013 * Math.pow(2, (years - 60) / 8));
}

// Фертильность падает с возрастом — иначе 41-летние рожают как 20-летние.
function ageFertility(years) {
  if (years < 33) return 1;
  if (years < 39) return 0.6;
  return 0.25;
}

// Условия жизни: сытость, счастье и свободное жильё. Это и делает яму реальной —
// голодное десятилетие вырезает целое поколение, а не просто «минус счастье».
export function birthConditions(ctx) {
  let m = 1;
  const foodDays = ctx.foodDays ?? 99;
  if (foodDays >= 12) m *= 1.15;
  else if (foodDays < 2) m *= 0.1;
  else if (foodDays < 5) m *= 0.45;
  else if (foodDays < 8) m *= 0.8;
  const happy = ctx.happiness ?? 50;
  if (happy >= 70) m *= 1.2;
  else if (happy < 25) m *= 0.3;
  else if (happy < 40) m *= 0.6;
  const free = (ctx.housingCap ?? Infinity) - (ctx.pop ?? 0);
  if (free <= 2) m *= 0.5;
  // Фронтирный бум: пока поселение крошечное, а земли и жилья в избытке, семьи
  // заводят детей охотнее. Без этого стартовые шесть жителей ядра слишком часто
  // не успевали дать второе поколение и деревня тихо вымирала от старости.
  const pop = ctx.pop ?? 0;
  if (pop > 0 && pop < 14 && free > 2) m *= 1.5;
  m *= ctx.birthMult ?? 1;
  return m;
}

function _writeYearRow(state, day, report) {
  const year = Math.floor(day / YEAR);
  let row = state.yearBirths[state.yearBirths.length - 1];
  if (!row || row.year !== year) {
    row = { year, born: 0, died: 0, pop: report.pop };
    state.yearBirths.push(row);
    if (state.yearBirths.length > 80) state.yearBirths.shift();
  }
  row.born += report.born.length;
  row.died += report.died.length;
  row.pop = report.pop;
}

function countIn(list, id) {
  if (!list) return 0;
  if (list instanceof Set) return list.has(id) ? 1 : 0;
  let n = 0;
  for (const x of list) if (x === id) n++;
  return n;
}

// Женские имена в списке ядра оканчиваются на -а/-я; Добрыня — известное исключение.
const MALE_EXCEPTIONS = new Set(['Добрыня']);
const FEMALE_NAMES = NAMES.filter(n => /[ая]$/.test(n) && !MALE_EXCEPTIONS.has(n));
const MALE_NAMES = NAMES.filter(n => !FEMALE_NAMES.includes(n));

function pickName(rng, sex) {
  const pool = sex === 'ж' ? FEMALE_NAMES : MALE_NAMES;
  return rng.pick(pool.length ? pool : NAMES);
}

function inferSex(name, rng) {
  const first = String(name || '').split(' ')[0];
  if (FEMALE_NAMES.includes(first)) return 'ж';
  if (MALE_NAMES.includes(first)) return 'м';
  return rng.chance(0.5) ? 'ж' : 'м';
}

// Родовое прозвище — вторая часть имени; дети наследуют его от отца.
function famOf(name) {
  const parts = String(name || '').split(' ');
  return parts.length > 1 ? parts.slice(1).join(' ') : '';
}

function shortName(v) { return String(v.name).split(' ')[0]; }

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
