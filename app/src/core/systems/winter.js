// core/systems/winter.js — отопление и суровая зима (U07), механика Frostpunk.
// Чистый модуль: без DOM, без обращения к Simulation, весь ввод — аргументами,
// вся случайность — через переданный rng. Ничего не мутирует, кроме своего
// state и hp жителей, которых сам же и уморил (ядро потом отфильтрует).
//
// МОДЕЛЬ. Зимой поселение каждый день сжигает дрова. Потребность складывается из
// трёх слагаемых: людей (их надо греть), очагов (каждый топящийся дом требует
// дров сам по себе) и бездомных (костёр под открытым небом греет отвратительно).
// Мороз крепчает к середине сезона, поэтому расход идёт горбом, а не полкой.
// Недотоп копится в state.cold и разворачивается лестницей: счастье → болезни →
// смерти. Лестница нужна, чтобы у игрока была неделя на реакцию: мгновенная
// гибель от одного пропущенного дня — это не сложность, а несправедливость.
//
// ГЛАВНОЕ — ПРОГНОЗ. winterForecast() считает, сколько дров съест ближайшая зима,
// и сравнивает с запасом. Он специально работает круглый год: угрозу нужно
// увидеть осенью, когда лесопилку ещё можно поставить, а не в первый мороз.
//
// ═══════════════════════════ INTEGRATION ═══════════════════════════
// 1) simulation.js, рядом с прочими импортами:
//      import * as Winter from './systems/winter.js';
//
// 2) constructor(), рядом с прочим состоянием (например, после this.market):
//      this.winter = Winter.createWinter();
//
// 3) onNewDay(), СРАЗУ ПОСЛЕ блока «сезон» (строка с this.addLog про пору года)
//    и ДО блока «еда»: топка — такой же ежедневный расход, как питание, и она
//    должна отработать раньше, чем ниже по коду будет вызвана happiness().
//
//      const wr = Winter.tickWinter(this.winter, {
//        day: this.day, seasonIdx: this.seasonIdx, weather: this.weather,
//        villagers: this.villagers, wood: this.res.wood,
//        housingCap: this.housingCap(), buildings: this.doneBuildings(),
//        techs: this.techs,
//        woodPerDay: this.winterWoodIncome ? this.winterWoodIncome() : 0, // необязательно
//      }, this.rng);
//      this.res.wood = Math.max(0, this.res.wood - wr.burned);
//      if (wr.deaths.length) this.villagers = this.villagers.filter(v => v.hp > 0);
//      for (const e of wr.events) this.addLog(e.text, e.type);
//
//    Поле woodPerDay нужно только прогнозу в тексте предупреждения («хватит /
//    не хватит с текущей добычей»); без него прогноз считает по одному запасу.
//
// 4) happiness(), перед клампом (там же, где h += this._happyBonus):
//      h += Winter.happyMod(this.winter);
//    Модуль сам вернёт 0 летом и когда в домах тепло.
//
// 5) Сейв. serialize(): добавить поле
//      winter: Winter.serializeWinter(this.winter),
//    deserialize(): после восстановления жителей —
//      sim.winter = Winter.deserializeWinter(data.winter);
//    Старые сейвы без поля грузятся: вернётся чистое состояние.
//
// 6) HUD (hud.js). Плашка-предупреждение круглый год:
//      const f = Winter.winterForecast({ day: sim.day, seasonIdx: sim.seasonIdx,
//        villagers: sim.villagers, wood: sim.res.wood, housingCap: sim.housingCap(),
//        buildings: sim.doneBuildings(), techs: sim.techs, woodPerDay: <приход 🪵/день> });
//      // f.text — готовая русская строка, f.level — 'ok' | 'warn' | 'bad' для цвета.
//    Строка состояния зимой: Winter.winterStatus(sim.winter, ctx) — то же поле
//    text плюс сколько дней протянет текущий запас (coverDays).
//
// 7) Рендер (по желанию): Winter.stage(sim.winter) вернёт 'ok'|'chill'|'sick'|'death'
//    — можно подсинить картинку или потрясти жителей в самой холодной стадии.
// ═══════════════════════════════════════════════════════════════════

import { BUILDINGS, DAYS_PER_SEASON, WEATHER_TABLE } from '../data.js';

// ---------- Константы модели (экспортируются: на них опирается тест) ----------
export const WINTER_SEASON = 3;          // индекс зимы в SEASONS
export const WINTER_DAYS = DAYS_PER_SEASON;

// Дрова в день при морозе средней силы (severity = 1).
// Калибровка: поселение 30 жителей с 7 очагами просит ~3.4🪵/день в пик и ~81🪵
// за всю зиму — одна лесопилка (≈4🪵/день) закрывает это с запасом. То же
// поселение, разросшееся до 60 душ и 15 очагов, просит уже ~169🪵: одной
// лесопилки не хватает, нужен либо второй сруб, либо запас с осени.
export const WOOD_PER_POP = 0.055;
export const WOOD_PER_HEARTH = 0.25;
export const WOOD_PER_HOMELESS = 0.09;   // сверх обычной нормы: греть улицу дорого

// Форма зимы: от 0.55 на кромках сезона до 1.0 в середине.
export const SEV_MIN = 0.55;
export const SEV_PEAK = 1.0;

// Лестница последствий по накопленному недотопу (1.0 = сутки без единого полена).
export const COLD_SICK = 2;              // с этого порога начинаются болезни
export const COLD_DEATH = 5;             // с этого — смерти среди больных
export const COLD_THAW = 0.75;           // сколько «холода» уходит за тёплый день
export const COLD_MAX = 12;              // потолок: дальше хуже уже некуда

export const SICK_RATE = 0.05;           // доля населения, заболевающая за сутки полного недотопа
export const DEATH_RATE = 0.06;          // доля больных, умирающая за такие же сутки
export const DEATHS_PER_DAY = 2;         // больше двух похорон в день — это уже не игра
// Мороз не вымораживает поселение досуха: половина жителей всегда доживает до
// весны у общего костра. Полное вымирание от одной пропущенной зимы — не
// сложность, а конец партии без права на ошибку; пусть остаётся руина, с которой
// можно отстроиться.
export const SURVIVOR_FLOOR = 0.5;
export const HAPPY_FLOOR = -30;          // максимальный штраф к счастью от холода

// Погодная надбавка к расходу. Снег дороже всего, ясный день — базовая норма.
export const HEAT_WEATHER = { snow: 1.3, rain: 1.1, cloud: 1.05, sun: 1.0 };

// Утепление: множители к расходу. Перемножаются, но не ниже INSULATION_FLOOR —
// иначе к Современности отопление обнулилось бы и механика исчезла из игры.
export const INSULATION_TECH = {
  masonry: 0.90,        // кладка: стены держат тепло
  construction: 0.94,   // акведуки и печи по-нормальному
  steam: 0.92,          // паровое отопление
  electricity: 0.88,
  plastics: 0.90,       // утеплители
};
export const INSULATION_BUILDING = {
  power_plant: 0.85,    // централизованное тепло от станции
  npp: 0.85,
  fusion_reactor: 0.80,
  solar: 0.95,
};
export const INSULATION_FLOOR = 0.35;

// Уход за мёрзнущими: снижает и заболеваемость, и смертность.
export const CARE_BUILDING = { clinic: 0.5, hospital: 0.5, sewers: 0.7 };
export const CARE_TECH = { medicine: 0.9, penicillin: 0.85 };
export const CARE_FLOOR = 0.15;

// Быт: смягчает именно штраф к счастью (мёрзнуть в городе с банями и театром
// всё же легче, чем в чистом поле), но от болезней не спасает.
export const COMFORT_BUILDING = { aqueduct: 0.85, temple: 0.9, amphitheater: 0.9, media_tower: 0.85 };
export const COMFORT_FLOOR = 0.4;

// Сумма severity за всю зиму и средняя погодная надбавка — константы прогноза.
// Считаются из таблиц data.js, чтобы правка DAYS_PER_SEASON или WEATHER_TABLE
// автоматически меняла и прогноз, а не расходилась с ним.
export const SEV_SUM = (() => {
  let s = 0;
  for (let i = 0; i < WINTER_DAYS; i++) s += severity(i);
  return s;
})();
export const WINTER_WEATHER_AVG = (() => {
  let sum = 0, tot = 0;
  for (const [w, p] of WEATHER_TABLE[WINTER_SEASON]) { sum += (HEAT_WEATHER[w] ?? 1) * p; tot += p; }
  return tot ? sum / tot : 1;
})();

// ---------- Состояние ----------
export function createWinter() {
  return {
    cold: 0,          // накопленный недотоп, «сутки без дров»
    sick: 0,          // сколько жителей слегло от холода
    happy: 0,         // текущий штраф к счастью (<= 0)
    lastDay: -1,      // защита от двойного вызова в один игровой день
    flags: { chill: false, sick: false, death: false, warm: false },
    current: null,    // сводка идущей зимы
    history: [],      // сводки прошлых зим, последние 20
    totals: { burned: 0, deaths: 0, sick: 0, coldDays: 0 },
  };
}

export function serializeWinter(state) {
  const s = state || createWinter();
  return {
    cold: round2(s.cold), sick: s.sick, happy: round2(s.happy), lastDay: s.lastDay,
    flags: { ...s.flags }, current: s.current ? { ...s.current } : null,
    history: s.history.slice(-20).map(h => ({ ...h })),
    totals: { ...s.totals },
  };
}

export function deserializeWinter(data) {
  const s = createWinter();
  if (!data || typeof data !== 'object') return s;
  s.cold = num(data.cold, 0);
  s.sick = Math.max(0, Math.round(num(data.sick, 0)));
  s.happy = Math.min(0, num(data.happy, 0));
  s.lastDay = Number.isFinite(data.lastDay) ? data.lastDay : -1;
  s.flags = { ...s.flags, ...(data.flags || {}) };
  s.current = data.current ? { ...data.current } : null;
  s.history = Array.isArray(data.history) ? data.history.slice(-20).map(h => ({ ...h })) : [];
  s.totals = { ...s.totals, ...(data.totals || {}) };
  return s;
}

// ---------- Форма сезона ----------
// Мороз крепчает к середине зимы: sin-горб даёт мягкий вход, тяжёлую середину и
// мягкий выход. Игрок успевает почувствовать нарастание, а не упирается в стену.
export function severity(dayInSeason) {
  const last = Math.max(1, WINTER_DAYS - 1);
  const t = clamp(num(dayInSeason, 0) / last, 0, 1);
  return SEV_MIN + (SEV_PEAK - SEV_MIN) * Math.sin(Math.PI * t);
}

// ---------- Очаги ----------
// Топим не все жилые здания подряд, а столько, сколько нужно, чтобы укрыть
// население: пустующая многоэтажка не должна разорять поселение на дровах.
// Начинаем с самых вместительных — так один каменный дом выгоднее двух хижин,
// и уплотнение застройки честно экономит топливо.
export function hearthCount(builtIds, pop) {
  if (pop <= 0) return 0;
  const caps = [];
  for (const id of builtIds) {
    const h = BUILDINGS[id] && BUILDINGS[id].housing;
    if (h > 0) caps.push(h);
  }
  caps.sort((a, b) => b - a);
  let covered = 0, n = 0;
  for (const c of caps) {
    if (covered >= pop) break;
    covered += c; n++;
  }
  return n;
}

// ---------- Множители ----------
export function insulationMult(ctx) {
  const c = readCtx(ctx);
  let m = 1;
  for (const [id, k] of Object.entries(INSULATION_TECH)) if (c.hasTech(id)) m *= k;
  for (const [id, k] of Object.entries(INSULATION_BUILDING)) if (c.hasBuilding(id)) m *= k;
  return Math.max(INSULATION_FLOOR, m);
}

export function careMult(ctx) {
  const c = readCtx(ctx);
  let m = 1;
  for (const [id, k] of Object.entries(CARE_BUILDING)) if (c.hasBuilding(id)) m *= k;
  for (const [id, k] of Object.entries(CARE_TECH)) if (c.hasTech(id)) m *= k;
  return Math.max(CARE_FLOOR, m);
}

export function comfortMult(ctx) {
  const c = readCtx(ctx);
  let m = 1;
  for (const [id, k] of Object.entries(COMFORT_BUILDING)) if (c.hasBuilding(id)) m *= k;
  return Math.max(COMFORT_FLOOR, m);
}

// ---------- Потребность ----------
// Базовая суточная норма при severity = 1 и ясной погоде.
export function baseDemand(ctx) {
  const c = readCtx(ctx);
  if (c.pop <= 0) return 0;
  const homeless = Math.max(0, c.pop - c.housingCap);
  const raw = c.pop * WOOD_PER_POP + c.hearths * WOOD_PER_HEARTH + homeless * WOOD_PER_HOMELESS;
  return raw * insulationMult(ctx);
}

// Сколько дров нужно сжечь именно сегодня. Вне зимы — ноль: печи стоят холодными.
export function heatDemand(ctx) {
  const c = readCtx(ctx);
  if (!c.isWinter) return 0;
  return baseDemand(ctx) * severity(c.dayInSeason) * (HEAT_WEATHER[c.weather] ?? 1);
}

// Разбор потребности по слагаемым — для подсказки в интерфейсе.
export function demandBreakdown(ctx) {
  const c = readCtx(ctx);
  const ins = insulationMult(ctx);
  const homeless = Math.max(0, c.pop - c.housingCap);
  return {
    pop: c.pop, hearths: c.hearths, homeless,
    people: round2(c.pop * WOOD_PER_POP * ins),
    hearth: round2(c.hearths * WOOD_PER_HEARTH * ins),
    street: round2(homeless * WOOD_PER_HOMELESS * ins),
    insulation: round2(ins),
    perDayNow: round2(heatDemand(ctx)),
    perDayPeak: round2(baseDemand(ctx) * SEV_PEAK * WINTER_WEATHER_AVG),
  };
}

// ---------- Прогноз ----------
// Работает круглый год. Осенью отвечает на вопрос «доживём ли», зимой — «дотянем
// ли до весны». Это главный экспорт модуля: механика без прогноза наказывала бы
// игрока за то, чего он не мог увидеть.
export function winterForecast(ctx) {
  const c = readCtx(ctx);
  const base = baseDemand(ctx);
  // Сумма severity по оставшимся зимним дням: до зимы — вся зима целиком.
  let sevLeft = 0, daysLeft = WINTER_DAYS, daysToWinter = 0;
  if (c.isWinter) {
    daysLeft = Math.max(0, WINTER_DAYS - c.dayInSeason);
    for (let i = c.dayInSeason; i < WINTER_DAYS; i++) sevLeft += severity(i);
  } else {
    sevLeft = SEV_SUM;
    daysToWinter = (WINTER_SEASON - c.seasonIdx) * DAYS_PER_SEASON - c.dayInSeason;
    if (daysToWinter < 0) daysToWinter += 4 * DAYS_PER_SEASON;
  }
  const need = base * sevLeft * WINTER_WEATHER_AVG;
  const have = Math.max(0, c.wood);
  const income = Math.max(0, num(c.woodPerDay, 0));
  const projected = have + income * daysToWinter;
  const deficit = Math.max(0, need - projected);
  const perDayAvg = daysLeft > 0 ? need / daysLeft : 0;
  const perDayPeak = base * SEV_PEAK * WINTER_WEATHER_AVG;
  const coverDays = perDayAvg > 0 ? projected / perDayAvg : Infinity;
  const level = deficit <= 0 ? 'ok' : (projected >= need * 0.6 ? 'warn' : 'bad');

  let text;
  if (c.pop <= 0) {
    text = 'Греть некого.';
  } else if (c.isWinter) {
    text = `Зима: осталось ${daysLeft} дн., расход ~${fmt(perDayAvg)}🪵/день. `
      + (deficit > 0
        ? `Дров ${fmt(have)}, не хватает ${fmt(deficit)}🪵 — люди начнут мёрзнуть.`
        : `Дров ${fmt(have)} — до весны хватит.`);
  } else {
    const when = daysToWinter <= 0 ? 'вот-вот' : `через ${daysToWinter} дн.`;
    text = `Зима ${when}: нужно ~${fmt(need)}🪵 на сезон, будет ${fmt(projected)}🪵. `
      + (deficit > 0 ? `Не хватает ${fmt(deficit)}🪵 — запасайте дрова.` : 'Запаса достаточно.');
  }

  return {
    isWinter: c.isWinter, daysToWinter, daysLeft,
    pop: c.pop, hearths: c.hearths,
    need: round2(need), have: round2(have), projected: round2(projected),
    deficit: round2(deficit), income: round2(income),
    perDayAvg: round2(perDayAvg), perDayPeak: round2(perDayPeak),
    coverDays: Number.isFinite(coverDays) ? round2(coverDays) : Infinity,
    ready: deficit <= 0, level, text,
  };
}

// ---------- Ежедневный тик ----------
export function tickWinter(state, ctx, rng) {
  const s = state || createWinter();
  const c = readCtx(ctx);
  const rep = {
    day: c.day, winter: c.isWinter, demand: 0, burned: 0, deficit: 0, ratio: 1,
    cold: s.cold, sick: s.sick, newSick: 0, recovered: 0,
    deaths: [], deathCount: 0, stage: 'ok', happyMod: Math.round(s.happy), events: [],
  };
  // Один и тот же день не должен топиться дважды: ядро вызывает onNewDay строго
  // раз в сутки, но консольные команды и отладка умеют дёргать его повторно.
  if (s.lastDay === c.day) return rep;
  s.lastDay = c.day;

  if (!c.isWinter) {
    closeWinter(s, c);
    // Оттепель: холод отпускает вдвое быстрее, чем копился, больные встают.
    s.cold = Math.max(0, s.cold - COLD_THAW * 2);
    if (s.sick > 0) {
      const heal = Math.max(1, Math.floor(s.sick * 0.34));
      s.sick = Math.max(0, s.sick - heal);
      rep.recovered = heal;
    }
    s.happy = s.happy < 0 ? Math.min(0, s.happy + 3) : 0;
    forecastWarnings(s, c, rep);
    return finish(s, rep, 'ok');
  }

  openWinter(s, c);

  const demand = heatDemand(ctx);
  const burned = Math.min(demand, Math.max(0, c.wood));
  const deficit = Math.max(0, demand - burned);
  const d = demand > 1e-9 ? deficit / demand : 0;   // доля непокрытой потребности
  rep.demand = round2(demand); rep.burned = round2(burned);
  rep.deficit = round2(deficit); rep.ratio = round2(1 - d);
  s.totals.burned += burned;
  if (s.current) { s.current.burned += burned; s.current.need += demand; }

  // Недотоп копится, тепло его разбирает. Порог 0.02 — чтобы округления не
  // считались «холодом» и поселение не мёрзло от одной сотой полена.
  if (d > 0.02) {
    s.cold = Math.min(COLD_MAX, s.cold + d);
    s.totals.coldDays++;
    if (s.current) s.current.coldDays++;
  } else {
    s.cold = Math.max(0, s.cold - COLD_THAW);
  }

  const stage = stageOf(s.cold, d);
  const care = careMult(ctx);

  // Болезни. Считаем от населения: чем глубже недотоп и дольше он тянется, тем
  // больше слегло. Множитель care — вклад лечебницы, канализации, госпиталя.
  if ((stage === 'sick' || stage === 'death') && c.pop > 1) {
    const press = Math.min(2, s.cold / COLD_SICK);
    const expect = c.pop * SICK_RATE * d * press * care;
    const n = Math.min(c.pop - s.sick, roll(expect, rng));
    if (n > 0) {
      s.sick += n; rep.newSick = n;
      s.totals.sick += n;
      if (s.current) s.current.sick += n;
    }
  } else if (d <= 0.02 && s.sick > 0) {
    // В тёплом доме простуда проходит сама.
    const heal = Math.max(1, Math.floor(s.sick * 0.25));
    s.sick = Math.max(0, s.sick - heal);
    rep.recovered = heal;
  }

  // Смерти. Умирают только те, кто уже слёг: сначала кашель, потом похороны.
  if (stage === 'death' && s.sick > 0 && c.pop > 1) {
    const startPop = s.current && s.current.pop > 0 ? s.current.pop : c.pop;
    const floorPop = Math.max(1, Math.ceil(startPop * SURVIVOR_FLOOR));
    const expect = s.sick * DEATH_RATE * d * care;
    let n = Math.min(roll(expect, rng), s.sick, c.pop - 1, c.pop - floorPop, DEATHS_PER_DAY);
    if (n > 0) {
      rep.deathCount = n;
      s.sick = Math.max(0, s.sick - n);
      s.totals.deaths += n;
      if (s.current) s.current.deaths += n;
      rep.deaths = takeVictims(c.villagers, n, rng);
    }
  }

  s.sick = Math.min(s.sick, Math.max(0, c.pop - rep.deathCount));

  // Счастье: мёрзнущие недовольны сразу, ещё до первой болезни. Это и есть
  // первая ступень лестницы — самый ранний сигнал, что дров мало.
  const popNow = Math.max(1, c.pop - rep.deathCount);
  const raw = d * 12 + Math.min(12, s.cold * 1.5) + Math.min(8, (s.sick / popNow) * 20);
  const target = raw > 0 ? -Math.min(-HAPPY_FLOOR, raw * comfortMult(ctx)) : 0;
  // К цели идём плавно (не более 4 пунктов за день): резкий скачок счастья
  // выглядит как баг и выбивает эмиграцию раньше, чем игрок поймёт причину.
  s.happy = approach(s.happy, target, 4);

  messages(s, c, rep, stage, d);
  return finish(s, rep, stage);
}

// Текущий штраф к счастью. Ядро прибавляет это к h в happiness().
export function happyMod(state) {
  if (!state) return 0;
  return Math.round(Math.min(0, state.happy));
}

export function stage(state) {
  if (!state) return 'ok';
  return stageOf(state.cold, state.cold > 0 ? 1 : 0);
}

// Строка для HUD: прогноз плюс то, на сколько дней хватит текущего запаса.
export function winterStatus(state, ctx) {
  const f = winterForecast(ctx);
  const s = state || createWinter();
  const st = stageOf(s.cold, s.cold > 0 ? 1 : 0);
  return {
    level: st === 'ok' ? f.level : (st === 'chill' ? 'warn' : 'bad'),
    stage: st, cold: round2(s.cold), sick: s.sick, happyMod: happyMod(s),
    coverDays: f.coverDays, forecast: f,
    text: f.text + (s.sick > 0 ? ` Больных от холода: ${s.sick}.` : ''),
  };
}

// Сводки прошедших зим — для хроники и статистики.
export function winterHistory(state) {
  return state && state.history ? state.history.map(h => ({ ...h })) : [];
}

// ---------- Внутреннее ----------

function stageOf(cold, d) {
  if (cold >= COLD_DEATH) return 'death';
  if (cold >= COLD_SICK) return 'sick';
  if (cold > 0 || d > 0.02) return 'chill';
  return 'ok';
}

function finish(s, rep, st) {
  rep.stage = st;
  rep.cold = round2(s.cold);
  rep.sick = s.sick;
  rep.happyMod = happyMod(s);
  return rep;
}

// Приводим разношёрстный ввод к одному виду: ядро отдаёт Set техов и объекты
// зданий, тесты и HUD — простые массивы строк. Модуль обязан переваривать оба.
function readCtx(ctx) {
  const o = ctx || {};
  if (o.__winterCtx) return o;
  const ids = [];
  const src = o.buildings || o.builtIds || [];
  for (const b of src) {
    if (typeof b === 'string') { ids.push(b); continue; }
    if (!b || !b.id) continue;
    if (b.done === false || b.destroyed) continue;
    ids.push(b.id);
  }
  const techs = o.techs;
  const hasTech = (id) => !techs ? false
    : (typeof techs.has === 'function' ? techs.has(id) : Array.isArray(techs) && techs.includes(id));
  const idSet = new Set(ids);
  const villagers = Array.isArray(o.villagers) ? o.villagers : null;
  const pop = Math.max(0, Math.round(num(o.pop, villagers ? villagers.filter(v => !v || v.hp === undefined || v.hp > 0).length : 0)));
  const day = Math.max(0, Math.round(num(o.day, 0)));
  const dayInSeason = Math.max(0, Math.round(num(o.dayInSeason, day % DAYS_PER_SEASON)));
  const seasonIdx = Number.isFinite(o.seasonIdx) ? o.seasonIdx : Math.floor(day / DAYS_PER_SEASON) % 4;
  const housingCap = Number.isFinite(o.housingCap)
    ? o.housingCap
    : ids.reduce((a, id) => a + ((BUILDINGS[id] && BUILDINGS[id].housing) || 0), 0);
  return {
    __winterCtx: true,
    day, dayInSeason, seasonIdx, isWinter: seasonIdx === WINTER_SEASON,
    weather: o.weather || 'sun', pop, villagers, wood: num(o.wood, 0),
    woodPerDay: num(o.woodPerDay, 0), housingCap,
    ids, hasTech, hasBuilding: (id) => idSet.has(id),
    hearths: hearthCount(ids, pop),
  };
}

function openWinter(s, c) {
  if (!s.current || s.current.startDay !== c.day - c.dayInSeason) {
    s.current = { startDay: c.day - c.dayInSeason, year: Math.floor(c.day / 100), pop: c.pop,
      need: 0, burned: 0, coldDays: 0, sick: 0, deaths: 0 };
    s.flags = { chill: false, sick: false, death: false, warm: false };
  }
}

function closeWinter(s, c) {
  if (!s.current) return;
  s.history.push({
    year: s.current.year, pop: s.current.pop,
    need: round2(s.current.need), burned: round2(s.current.burned),
    coldDays: s.current.coldDays, sick: s.current.sick, deaths: s.current.deaths,
  });
  if (s.history.length > 20) s.history.shift();
  s.current = null;
  s.flags = { chill: false, sick: false, death: false, warm: false };
}

// Предупреждения до зимы. Осенью — дважды (в начале и в середине), чтобы игрок
// успел и заложить лесопилку, и достроить её.
function forecastWarnings(s, c, rep) {
  if (c.pop <= 0) return;
  const autumn = c.seasonIdx === WINTER_SEASON - 1;
  if (!autumn || (c.dayInSeason !== 0 && c.dayInSeason !== 12)) return;
  const f = winterForecast(c);
  if (f.level === 'ok' && c.dayInSeason === 12) return; // всё готово — не зудим повторно
  rep.forecast = f;
  rep.events.push({ text: `❄ ${f.text}`, type: f.level === 'ok' ? 'info' : 'warn' });
}

function messages(s, c, rep, st, d) {
  if (c.dayInSeason === 0) {
    const f = winterForecast(c);
    rep.forecast = f;
    rep.events.push({ text: `❄ Зима пришла. ${f.text}`, type: f.ready ? 'info' : 'warn' });
  }
  if (d > 0.02 && !s.flags.chill) {
    s.flags.chill = true; s.flags.warm = false;
    rep.events.push({
      text: `❄ Дров не хватает: топим на ${Math.round((1 - d) * 100)}%. Люди мёрзнут — счастье падает.`,
      type: 'warn',
    });
  }
  if (d <= 0.02 && s.flags.chill && s.cold <= 0.01) {
    s.flags.chill = false;
    if (!s.flags.warm) {
      s.flags.warm = true;
      rep.events.push({ text: 'Дома снова прогрелись — холод отступил.', type: 'good' });
    }
  }
  if (rep.newSick > 0) {
    rep.events.push({
      text: `🤒 От холода слегло ${rep.newSick} ${plural(rep.newSick, 'житель', 'жителя', 'жителей')}`
        + `${s.sick > rep.newSick ? ` (всего больных ${s.sick})` : ''}. Нужны дрова, иначе будут смерти.`,
      type: 'bad',
    });
    s.flags.sick = true;
  }
  for (const name of rep.deaths) rep.events.push({ text: `☠ ${name} замёрз насмерть.`, type: 'bad' });
  if (rep.deathCount > 0 && !s.flags.death) {
    s.flags.death = true;
    rep.events.push({ text: '❄ Мороз начал убивать. Топите чем угодно.', type: 'bad' });
  }
  if (st === 'sick' && !s.flags.sick && rep.newSick === 0) {
    s.flags.sick = true;
    rep.events.push({ text: '❄ В домах стужа третьи сутки — начинаются болезни.', type: 'warn' });
  }
}

// Забираем жертв: помечаем hp = 0, ядро отфильтрует список одним проходом.
function takeVictims(villagers, n, rng) {
  const names = [];
  if (!villagers || !villagers.length) {
    for (let i = 0; i < n; i++) names.push('Житель');
    return names;
  }
  const alive = villagers.filter(v => v.hp === undefined || v.hp > 0);
  for (let i = 0; i < n && alive.length > 1; i++) {
    const idx = rng ? rng.int(0, alive.length - 1) : alive.length - 1;
    const v = alive.splice(idx, 1)[0];
    v.hp = 0;
    names.push(v.name || 'Житель');
  }
  return names;
}

// Дробное ожидание в целое число событий: целая часть гарантирована, остаток —
// бросок. Только через rng: Math.random сломал бы детерминизм от сида.
function roll(expect, rng) {
  if (!(expect > 0)) return 0;
  const whole = Math.floor(expect);
  const frac = expect - whole;
  const hit = rng ? rng.next() < frac : frac >= 0.5;
  return whole + (hit ? 1 : 0);
}

function approach(cur, target, step) {
  if (cur < target) return Math.min(target, cur + step);
  if (cur > target) return Math.max(target, cur - step);
  return target;
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function num(v, def) { return Number.isFinite(v) ? v : def; }
function round2(v) { return Math.round(v * 100) / 100; }
function fmt(v) { return (Math.round(v * 10) / 10).toFixed(1); }
