// core/systems/link_survival.js — СВЯЗЬ: выживание → держава.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. Зима морозит, амбары пустеют, люди болеют — и всё это до сих
// пор жило отдельно от политики. Стабильность падала от войн и злых сословий, но
// не от того, что народу нечего есть. Здесь проведена та единственная связь,
// которая превращает «песочницу» в стратегию: беда простого человека доходит до
// трона, а порядок на троне доходит обратно до простого человека.
//
// ЧТО ИМЕННО СВЯЗАНО (в обе стороны):
//   winter.cold, winter.sick, замёрзшие ──▶ одобрение сословий ──▶ стабильность
//   запас еды (в днях)                  ──▶ стабильность (резко) ──▶ волнения
//   волнения, тянущиеся неделями        ──▶ хлебный бунт ──▶ восстание с потерей города
//   голод в столице                     ──▶ сепаратизм колоний (empire.unrest)
//   лечебницы и медицина                ──▶ смягчают удар от болезней и похорон
//   ОБРАТНО: полные амбары и высокая стабильность ──▶ мороз переносится легче
//   ОБРАТНО: власть на грани падения     ──▶ тот же мороз переносится тяжелее
//
// ЧИСТЫЙ МОДУЛЬ. Ничего не мутирует: читает sim, возвращает поправки. Применяет
// их integrate.js (точные строки — в блоке ПОДКЛЮЧЕНИЕ в конце файла). Даже
// счётчик «сколько суток подряд голодаем» не пишется в sim: он приходит снаружи
// (sim.linkSurvival) и уходит обратно новым значением в flags.memory.
//
// СЛУЧАЙНОСТИ ЗДЕСЬ НЕТ ВООБЩЕ — ни Math.random, ни sim.rng. Все пороги
// детерминированы: бунт от двух недель голода обязан случиться, а не выпасть.
// Так игрок может посчитать беду заранее, а сейв не расходится с прогоном.
//
// ГЛАВНОЕ ПРАВИЛО ДИЗАЙНА: у каждой петли есть потолок и выход. Дневной удар по
// стабильности ограничен STAB_DROP_FLOOR, бунт и восстание имеют откат
// (RIOT_COOLDOWN / REVOLT_COOLDOWN), а счётчик голода после бунта сбрасывается —
// иначе одна пропущенная зима означала бы гарантированный конец партии.

import { careMult, COLD_DEATH } from './winter.js';
import { SOCIAL_FACTIONS } from './politics.js';

// ---------- Константы модели (экспортируются: на них опирается тест) ----------

// Столько ест житель за сутки. Значение обязано совпадать с EAT_PER_DAY в
// simulation.js и EAT_PER_POP в empire.js — иначе «запас на N дней» соврёт.
export const EAT = 0.7;

// Запас еды в днях. Ниже FOOD_ALARM начинается тревога, ниже FOOD_ALARM/2 —
// настоящая нехватка (счётчик голодных суток). От FOOD_PLENTY держава сыта.
export const FOOD_ALARM = 5;
export const FOOD_PLENTY = 12;

// Сколько стабильности в день отнимает ПОЛНОСТЬЮ пустой склад. Для сравнения:
// обычный дневной прирост в politics.js — около +0.5. То есть голод не «щиплет»,
// а разворачивает знак: со стартовых 60 до нуля примерно за месяц голодовки.
// Это и есть «резкое падение», которое просил дизайн, но не мгновенная смерть.
export const HUNGER_STAB = 2.2;
// Затянувшийся голод бьёт больнее свежего: терпение кончается. Множитель растёт
// от 1.0 до 1 + HUNGER_FATIGUE к RIOT_DAYS-м суткам и дальше не растёт.
export const HUNGER_FATIGUE = 0.5;

// Мороз. cold в winter.js копится до COLD_MAX = 12, смерти начинаются с
// COLD_DEATH = 5 — за полный штраф берём именно этот порог: к моменту первых
// похорон недовольство уже должно быть предельным, а не только начаться.
export const COLD_STAB = 1.2;

// Болезни. За «полный» мор берём четверть слёгшего населения: больше четверти
// одновременно winter.js и не выдаёт, а мера должна быть достижимой.
export const SICK_SHARE_FULL = 0.25;
export const SICK_STAB = 1.0;
// Каждые похороны замёрзшего — отдельный удар по вере в державу. winter.js
// хоронит не больше DEATHS_PER_DAY = 2 в сутки, потолок оставлен с запасом.
export const DEATH_STAB = 0.6;
export const DEATH_STAB_CAP = 1.8;

// Потолок дневного падения от ВСЕЙ этой связи вместе. Без него голод + мороз +
// мор + похороны складывались бы в −6 и не оставляли шанса выправиться.
export const STAB_DROP_FLOOR = -4.5;

// Обратная связь «сытость и порядок». Работает только от изобилия, а не от
// спокойствия: при обычном ходе дел эта связь молчит и не даёт даровых плюсов.
export const CALM_STAB_MIN = 70;         // ниже — никакого бонуса
export const CALM_STAB_CEILING = 90;     // выше — тоже никакого: потолок петли
export const CALM_STAB_GAIN = 0.8;       // максимум прибавки к стабильности в день
// Сытый и уверенный народ легче терпит стужу. Смягчается ИМЕННО холодовой
// штраф — если мороза нет, прибавки к счастью не будет ни единицы.
export const CALM_COLD_SHARE = 0.4;      // не больше 40% штрафа снимается
export const CALM_COLD_CAP = 6;          // и не больше шести пунктов счастья

// Обратная сторона той же связи: когда власть шатается, тот же мороз кажется
// страшнее — люди не верят, что их вытащат.
export const PANIC_STAB = 25;
export const PANIC_HAPPY_MAX = 4;

// Лестница волнений. Сутки считаются голодными при запасе меньше FOOD_ALARM/2.
export const RIOT_DAYS = 8;              // хлебный бунт
export const REVOLT_DAYS = 16;           // восстание с потерей города
export const REVOLT_STAB = 25;           // но только если держава уже шатается
export const RIOT_COOLDOWN = 30;
export const REVOLT_COOLDOWN = 45;
export const RIOT_STAB_SHOCK = -8;
export const REVOLT_STAB_SHOCK = -15;
export const RIOT_FOOD_LOSS = -0.12;     // толпа бьёт амбары: доля, а не число
// Сытые сутки разбирают счётчик голода вдвое быстрее, чем он копился: выход из
// петли должен быть заметно короче входа в неё, иначе игрок не успевает спастись.
export const HUNGER_HEAL = 2;

// Сепаратизм: голод в столице виден из колоний. Потолок unrest в empire.js —
// UNREST_REVOLT + 2 = 12, поэтому 0.4 в день — это заметно, но не мгновенно.
export const CITY_UNREST_PER_DAY = 0.4;
export const CITY_UNREST_RIOT_KICK = 2;

// Кто и насколько страдает. Числа — сдвиг одобрения за сутки при ПОЛНОЙ беде.
// Собственный дрейф сословий к 50 в politics.js всего ±0.05/день, так что −0.6
// у простолюдин — это в двенадцать раз сильнее и за две недели голода уводит их
// к порогу FACTION_ANGRY = 25, откуда начинается саботаж промысла.
export const ESTATE_HUNGER = { commons: 0.60, military: 0.35, merchants: 0.25, nobles: 0.15, clergy: 0 };
export const ESTATE_COLD   = { commons: 0.40, military: 0.10, merchants: 0, nobles: 0, clergy: 0 };
export const ESTATE_SICK   = { commons: 0.25, military: 0, merchants: 0, nobles: 0, clergy: 0.30 };
export const ESTATE_DROP_CAP = 1.2;      // не больше этого за сутки на сословие

// ---------- Память связи ----------
// Живёт в sim.linkSurvival, но пишется только через возвращаемый flags.memory:
// сам модуль её не трогает.

export function createSurvivalMemory() {
  return {
    v: 1,
    day: -1,          // защита от двойного применения в одни сутки
    hungerDays: 0,    // сколько суток подряд запас ниже FOOD_ALARM/2
    riotCd: 0,        // откат после бунта/восстания
    stage: 'ok',      // 'ok' | 'tight' | 'crisis' — для событий по смене ступени
    warned: false,    // предупреждение о зреющем бунте уже сказано
    riots: 0, revolts: 0,
    happyMod: 0,      // последняя поправка к счастью — её читает happiness()
  };
}

export function restoreSurvivalMemory(data) {
  const m = createSurvivalMemory();
  if (!data || typeof data !== 'object') return m;
  m.day = num(data.day, -1);
  m.hungerDays = Math.max(0, num(data.hungerDays, 0));
  m.riotCd = Math.max(0, num(data.riotCd, 0));
  m.stage = ['ok', 'tight', 'crisis'].includes(data.stage) ? data.stage : 'ok';
  m.warned = !!data.warned;
  m.riots = Math.max(0, num(data.riots, 0));
  m.revolts = Math.max(0, num(data.revolts, 0));
  m.happyMod = num(data.happyMod, 0);
  return m;
}

// ---------- Чтение мира ----------
// Единственное место, где ядро переводится на язык этой связи. Всё остальное
// считает по нормализованным числам и про устройство sim не знает.

export function survivalState(sim) {
  const pop = aliveCount(sim);
  const food = Math.max(0, numOf(sim && sim.res && sim.res.food, 0));
  const foodDays = pop > 0 ? food / (pop * EAT) : Infinity;

  const winter = (sim && sim.sys && sim.sys.winter) || null;
  const cold = winter ? Math.max(0, numOf(winter.cold, 0)) : 0;
  const sick = winter ? Math.max(0, numOf(winter.sick, 0)) : 0;
  const winterHappy = winter ? Math.min(0, numOf(winter.happy, 0)) : 0;
  const rep = (sim && sim.sys && sim.sys.winterReport) || null;
  const deaths = rep ? Math.max(0, numOf(rep.deathCount, 0)) : 0;

  const pol = (sim && sim.politics && sim.politics.state) || null;
  const stability = pol ? clamp(numOf(pol.stability, 60), 0, 100) : 60;

  // Уход за больными: та же таблица, что и в winter.js (лечебница, госпиталь,
  // канализация, медицина). Вторую копию списка зданий здесь заводить нельзя.
  const care = careMult({ buildings: (sim && sim.buildings) || [], techs: sim && sim.techs });
  // Но смягчать одобрение полной силой careMult нельзя: там пол 0.15, и с
  // госпиталем мор перестал бы волновать общество вовсе. Половина эффекта —
  // «за больными есть уход», а не «болезней как будто нет».
  const careSoft = 0.5 + 0.5 * care;

  return {
    pop, food, foodDays,
    hunger: pop > 0 ? clamp((FOOD_ALARM - foodDays) / FOOD_ALARM, 0, 1) : 0,
    // Сутки считаются голодными по запасу ИЛИ по похоронам. Одного запаса мало:
    // амбар за ночь прирастает парой мешков, формально выходит из голода и
    // сбрасывает счётчик (он тает вдвое быстрее, чем копится) — а люди в это
    // время мрут. На настоящей голодовке счётчик так и не доходил до бунта:
    // замер на городе в 18 душ — за десять суток счётчик дошёл до 3 из 8,
    // население вымерло полностью, и ни бунта, ни восстания не случилось.
    starving: pop > 0 && (foodDays < FOOD_ALARM / 2 || starvedToday(sim)),
    cold, coldPress: clamp(cold / COLD_DEATH, 0, 1),
    sick, sickPress: pop > 0 ? clamp((sick / pop) / SICK_SHARE_FULL, 0, 1) : 0,
    deaths, winterHappy, stability, care, careSoft,
    day: Math.round(numOf(sim && sim.day, 0)),
  };
}

// ---------- Разбор для игрока ----------
// Отдельная функция, потому что HUD зовёт её каждый кадр: она не двигает память
// и ничего не решает — только объясняет словами, что именно валит стабильность.

export function survivalBreakdown(sim) {
  const s = survivalState(sim);
  const mem = readMemory(sim);
  const parts = stabParts(s, mem);
  const rows = survivalBreakdownRows(s, parts);

  return {
    rows,
    total: round2(parts.total),
    foodDays: s.foodDays === Infinity ? null : round2(s.foodDays),
    hungerDays: mem.hungerDays,
    stage: stageOf(parts.total),
    // Готовая строка: игрок обязан прочитать причину, а не сводить её сам.
    text: rows.length
      ? `Стабильность ${parts.total >= 0 ? '+' : ''}${f1(parts.total)}/день: `
        + rows.map(r => `${r.ru} (${r.v > 0 ? '+' : ''}${f1(r.v)})`).join(', ')
      : 'Держава спокойна: голод и стужа на порядок не давят.',
  };
}

// ---------- Главная связь ----------

export function survivalLinks(sim) {
  const s = survivalState(sim);
  const prev = readMemory(sim);
  const mem = { ...prev };
  const events = [];

  // Двойной вызов в одни сутки не должен ни считать голодные дни дважды, ни
  // поднимать второй бунт. Ядро зовёт раз в день, но отладка и консоль умеют
  // дёргать onNewDay повторно — так же, как защищается winter.js.
  const sameDay = prev.day === s.day;
  if (!sameDay) {
    mem.day = s.day;
    mem.riotCd = Math.max(0, mem.riotCd - 1);
    mem.hungerDays = s.starving
      ? mem.hungerDays + 1
      : Math.max(0, mem.hungerDays - HUNGER_HEAL);
    if (mem.hungerDays === 0) mem.warned = false;
  }

  const parts = stabParts(s, mem);
  const mods = {
    happy: 0,
    stability: round2(parts.total),
    stabilityShock: 0,
    foodPct: 0,
    estates: estateShifts(s),
    cityUnrest: 0,
  };

  // Счастье. Две поправки, обе выведены из холода: изобилие его смягчает,
  // разваливающаяся власть — усиливает. Без мороза обе равны нулю.
  const coldPenalty = -s.winterHappy;               // >= 0
  if (coldPenalty > 0 && s.stability >= CALM_STAB_MIN && s.foodDays >= FOOD_PLENTY) {
    mods.happy += round2(Math.min(CALM_COLD_CAP, coldPenalty * CALM_COLD_SHARE * easeOf(s)));
  }
  if (s.coldPress > 0 && s.stability < PANIC_STAB) {
    const panic = (PANIC_STAB - s.stability) / PANIC_STAB;
    mods.happy -= round2(PANIC_HAPPY_MAX * panic * s.coldPress);
  }
  mods.happy = round2(mods.happy);

  // Сепаратизм колоний: голодная столица не кормит и не защищает.
  if (s.hunger >= 0.5) mods.cityUnrest = round2(CITY_UNREST_PER_DAY * s.hunger);

  const flags = {
    stage: stageOf(parts.total),
    starving: s.starving,
    hungerDays: mem.hungerDays,
    foodDays: s.foodDays === Infinity ? null : round2(s.foodDays),
    riot: false, revolt: false, cityLost: null,
    reasons: survivalBreakdownRows(s, parts),
    memory: mem,
  };

  // ── Волнения. Только в живой день и только при вышедшем откате.
  if (!sameDay && mem.riotCd <= 0 && mem.hungerDays >= REVOLT_DAYS && s.stability <= REVOLT_STAB) {
    // Восстание. Держава теряет самую дальнюю и самую озлобленную провинцию:
    // отпадает не столица (это был бы конец партии), а то, что дальше всего.
    const starved = mem.hungerDays;
    flags.revolt = true;
    flags.cityLost = weakestCity(sim);
    mods.stabilityShock = REVOLT_STAB_SHOCK;
    mods.cityUnrest = round2(mods.cityUnrest + CITY_UNREST_RIOT_KICK);
    mem.revolts++;
    mem.riotCd = REVOLT_COOLDOWN;
    mem.hungerDays = 0;            // выход из петли: счётчик обнуляется
    mem.warned = false;
    events.push({
      text: flags.cityLost
        ? `🔥 ВОССТАНИЕ ГОЛОДНЫХ: ${starved}-е сутки без хлеба. `
          + `${flags.cityLost.name} вышел из-под руки столицы.`
        : `🔥 ВОССТАНИЕ ГОЛОДНЫХ: ${starved}-е сутки без хлеба — власть держится на штыках.`,
      type: 'bad',
    });
  } else if (!sameDay && mem.riotCd <= 0 && mem.hungerDays >= RIOT_DAYS) {
    // Хлебный бунт. Дешевле восстания, но именно он даёт игроку последний
    // внятный сигнал: дальше будет отпадение города.
    flags.riot = true;
    mods.stabilityShock = RIOT_STAB_SHOCK;
    mods.foodPct = RIOT_FOOD_LOSS;
    mods.cityUnrest = round2(mods.cityUnrest + CITY_UNREST_RIOT_KICK);
    mem.riots++;
    mem.riotCd = RIOT_COOLDOWN;
    // Счётчик не обнуляем, а делим: бунт выпускает пар, но голод-то остался.
    mem.hungerDays = Math.floor(mem.hungerDays / 2);
    mem.warned = false;
    events.push({
      text: `🥖 Хлебный бунт: ${RIOT_DAYS} суток пустых амбаров. Толпа разбила склады, порядок пошатнулся.`,
      type: 'bad',
    });
  } else if (!sameDay && !mem.warned && mem.hungerDays >= Math.ceil(RIOT_DAYS / 2)) {
    mem.warned = true;
    // Считать «сколько осталось» имеет смысл, только если бунт вообще возможен:
    // на откате счётчик голода успевает уйти далеко за порог, и обратный отсчёт
    // ушёл бы в минус («ещё −10 дн. до бунта»).
    const left = RIOT_DAYS - mem.hungerDays;
    events.push({
      text: left > 0
        ? `⚠ ${mem.hungerDays}-е сутки впроголодь: на площадях ропот. Ещё ${left} дн. без хлеба — и будет бунт.`
        : `⚠ ${mem.hungerDays}-е сутки впроголодь: город ропщет, но после недавнего взрыва сил на новый нет `
          + `(${mem.riotCd} дн. затишья).`,
      type: 'warn',
    });
  }

  // ── Смена ступени: игрок узнаёт причину словами ровно тогда, когда она
  // меняется, а не каждый день одним и тем же сообщением.
  const stage = flags.stage;
  if (!sameDay && stage !== mem.stage) {
    mem.stage = stage;
    if (stage === 'crisis' || stage === 'tight') {
      const why = flags.reasons.filter(r => r.v < 0).map(r => `${r.ru} (${f1(r.v)})`).join(', ');
      events.push({
        text: (stage === 'crisis' ? '‼ Держава расшатывается' : '⚠ Порядок сползает')
          + ` на ${f1(-parts.total)} в день: ${why || 'общее неустройство'}.`,
        type: stage === 'crisis' ? 'bad' : 'warn',
      });
    } else {
      events.push({ text: 'Народ отдышался: голод и стужа больше не давят на порядок.', type: 'good' });
    }
  }

  mem.happyMod = mods.happy;
  // Счётчик отдаём тот, что остался ПОСЛЕ бунта: панель должна показывать
  // сегодняшнее положение дел, а не то, что было до разрядки.
  flags.hungerDays = mem.hungerDays;
  return { mods, events, flags };
}

// Плоская добавка к счастью — её подмешивает happiness() через integrate.js.
// Берём последнее посчитанное значение, а не считаем заново: happiness()
// вызывается десятки раз за кадр, и лишний проход по зданиям тут не нужен.
export function survivalHappyMod(sim) {
  const mem = sim && sim.linkSurvival;
  return mem ? Math.round(numOf(mem.happyMod, 0)) : 0;
}

// ---------- Внутреннее ----------

// Слагаемые дневной поправки к стабильности. Вынесены отдельно, потому что их
// читают трое: сама связь, разбор для HUD и текст события.
function stabParts(s, mem) {
  const out = { hunger: 0, cold: 0, sick: 0, deaths: 0, calm: 0, raw: 0, total: 0 };
  if (s.pop <= 0) return out;

  if (s.hunger > 0) {
    // Усталость от затянувшегося голода: от ×1.0 в первый день до ×1.5 к бунту.
    const fatigue = 1 + HUNGER_FATIGUE * Math.min(1, (mem.hungerDays || 0) / RIOT_DAYS);
    out.hunger = -HUNGER_STAB * s.hunger * fatigue;
  }
  if (s.coldPress > 0) out.cold = -COLD_STAB * s.coldPress;
  if (s.sickPress > 0) out.sick = -SICK_STAB * s.sickPress * s.careSoft;
  if (s.deaths > 0) out.deaths = -Math.min(DEATH_STAB_CAP, DEATH_STAB * s.deaths) * s.careSoft;

  // Обратная связь. Требует ОДНОВРЕМЕННО изобилия и порядка — и молчит выше
  // потолка, чтобы стабильность не разгонялась сама к сотне.
  if (s.stability >= CALM_STAB_MIN && s.stability < CALM_STAB_CEILING && s.foodDays >= FOOD_PLENTY) {
    out.calm = CALM_STAB_GAIN * easeOf(s);
  }

  out.raw = out.hunger + out.cold + out.sick + out.deaths + out.calm;
  out.total = Math.max(STAB_DROP_FLOOR, out.raw);
  return out;
}

// «Лёгкость»: насколько держава в силах помочь своим людям. Половина — от веры
// в порядок, половина — от того, сколько лежит в амбарах сверх нормы.
function easeOf(s) {
  const trust = clamp((s.stability - CALM_STAB_MIN) / (100 - CALM_STAB_MIN), 0, 1);
  const larder = clamp((s.foodDays - FOOD_PLENTY) / FOOD_PLENTY, 0, 1);
  return clamp(trust * 0.6 + larder * 0.4, 0, 1);
}

function estateShifts(s) {
  const out = {};
  for (const fid of Object.keys(SOCIAL_FACTIONS)) {
    let d = 0;
    d -= (ESTATE_HUNGER[fid] || 0) * s.hunger;
    d -= (ESTATE_COLD[fid] || 0) * s.coldPress;
    d -= (ESTATE_SICK[fid] || 0) * s.sickPress * s.careSoft;
    d = Math.max(-ESTATE_DROP_CAP, d);
    out[fid] = Math.abs(d) < 0.01 ? 0 : round2(d);
  }
  return out;
}

function survivalBreakdownRows(s, parts) {
  const rows = [];
  if (parts.hunger < 0) rows.push({ ru: `Голод: запаса на ${f1(s.foodDays)} дн.`, v: round2(parts.hunger) });
  if (parts.cold < 0) rows.push({ ru: 'Стужа в домах', v: round2(parts.cold) });
  if (parts.sick < 0) rows.push({ ru: `Больные от холода: ${s.sick} из ${s.pop}`, v: round2(parts.sick) });
  if (parts.deaths < 0) rows.push({ ru: `Похороны замёрзших: ${s.deaths}`, v: round2(parts.deaths) });
  if (parts.calm > 0) rows.push({ ru: 'Полные амбары и порядок', v: round2(parts.calm) });
  // Сработавший потолок показываем отдельной строкой, а не прячем: игрок должен
  // видеть, что держава уже на пределе и хуже за сутки не станет.
  if (parts.raw < STAB_DROP_FLOOR) {
    rows.push({ ru: 'Предел: глубже за сутки не проседает', v: round2(STAB_DROP_FLOOR - parts.raw) });
  }
  return rows;
}

// Ступень определяется величиной дневного падения, а не отдельной причиной:
// игроку важно «насколько плохо», а причины перечисляются рядом.
function stageOf(total) {
  if (total <= -1.2) return 'crisis';
  if (total <= -0.3) return 'tight';
  return 'ok';
}

// Кого потеряет держава при восстании: самый озлобленный, при равенстве — самый
// дальний от столицы. Никакого броска: игрок должен видеть кандидата заранее.
function weakestCity(sim) {
  const cities = sim && sim.empire && sim.empire.state && sim.empire.state.cities;
  if (!Array.isArray(cities) || !cities.length) return null;
  const cx = numOf(sim.world && sim.world.startX, 0);
  const cy = numOf(sim.world && sim.world.startY, 0);
  let best = null, bestKey = -Infinity, bestDist = 0;
  for (const c of cities) {
    const dist = Math.hypot(numOf(c.x, 0) - cx, numOf(c.y, 0) - cy);
    const key = numOf(c.unrest, 0) * 100 + dist;
    if (key > bestKey) { bestKey = key; best = c; bestDist = dist; }
  }
  return best ? { id: best.id, name: best.name, dist: Math.round(bestDist), unrest: round2(numOf(best.unrest, 0)) } : null;
}

function readMemory(sim) {
  const m = sim && sim.linkSurvival;
  if (!m || typeof m !== 'object') return createSurvivalMemory();
  return { ...createSurvivalMemory(), ...m };
}

function aliveCount(sim) {
  const list = sim && sim.villagers;
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const v of list) if (!v || v.hp === undefined || v.hp > 0) n++;
  return n;
}

// Хоронили ли сегодня умершего от голода. Отметку ставит simulation.js в том
// же дне, до вызова связей, — читаем, но не трогаем.
function starvedToday(sim) {
  return !!sim && Number.isFinite(sim.starvedDay) && sim.starvedDay === sim.day;
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function numOf(v, def) { return Number.isFinite(v) ? v : def; }
function num(v, def) { return Number.isFinite(v) ? v : def; }
function round2(v) { return Math.round(v * 100) / 100; }
function f1(v) { return (Math.round(v * 10) / 10).toFixed(1); }

/* ПОДКЛЮЧЕНИЕ ─────────────────────────────────────────────────────────────────

Все правки — только в app/src/core/systems/integrate.js. Каждый якорь встречается
в файле ровно один раз (проверено).

1) ИМПОРТ. Якорь (последняя строка блока импортов):

     import * as EMP from './wire_empire.js';

   ДОБАВИТЬ строкой ниже:

     import * as LS from './link_survival.js';

2) УСТАНОВКА. Якорь в installSystems():

     sim.sys.winterReport = null;

   ДОБАВИТЬ строкой выше:

     // Память связи выживания: сколько суток подряд голодаем и когда был бунт.
     sim.linkSurvival = LS.createSurvivalMemory();

3) ДЕНЬ. Якорь — последняя строка systemsNewDay():

     EMP.empireNewDay(sim);

   ДОБАВИТЬ следом (внутри той же функции, до закрывающей скобки). Место именно
   здесь: зима, люди, хозяйство и политика уже отработали, поэтому связь читает
   сложившийся день, а не вчерашний.

     applySurvivalLinks(sim);

   И ДОБАВИТЬ саму функцию в конец файла:

     // Связь «выживание → держава»: холод, голод и болезни доходят до трона.
     // Модуль только считает; всё, что меняет мир, делается здесь.
     function applySurvivalLinks(sim) {
       if (!sim.linkSurvival) sim.linkSurvival = LS.createSurvivalMemory();
       const out = LS.survivalLinks(sim);
       sim.linkSurvival = out.flags.memory;

       const pst = sim.politics && sim.politics.state;
       if (pst) {
         const dS = out.mods.stability + out.mods.stabilityShock;
         pst.stability = Math.max(0, Math.min(100, pst.stability + dS));
         for (const [fid, d] of Object.entries(out.mods.estates)) {
           if (!d || pst.factions[fid] == null) continue;
           pst.factions[fid] = Math.max(0, Math.min(100, pst.factions[fid] + d));
         }
       }

       // Бунт бьёт амбары. Долей, а не числом: плоская кража добила бы малое
       // поселение, у которого и так пусто.
       if (out.mods.foodPct) sim.res.food = Math.max(0, sim.res.food * (1 + out.mods.foodPct));

       // Голод в столице виден из колоний. Потолок 12 — тот же, что в empire.js.
       if (out.mods.cityUnrest && sim.empire) {
         for (const c of sim.empire.state.cities) {
           c.unrest = Math.min(12, (c.unrest || 0) + out.mods.cityUnrest);
         }
       }

       // Отпадение города при восстании. Списки lost/cities ведёт empire.js —
       // повторяем ровно его порядок действий, чтобы панель не разъехалась.
       const lost = out.flags.cityLost;
       if (lost && sim.empire) {
         const st = sim.empire.state;
         const i = st.cities.findIndex(c => c.id === lost.id);
         if (i >= 0) {
           const gone = st.cities[i];
           st.lost.push({ name: gone.name, day: sim.day, pop: gone.pop });
           st.cities.splice(i, 1);
           sim.addChronicle(`${gone.name} отложился: столица не смогла его прокормить (день ${sim.day}).`);
         }
       }

       if (out.flags.revolt || out.flags.riot) sim.sfx?.('alarm');
       if (out.flags.revolt && typeof sim.toast === 'function') {
         sim.toast('Восстание голодных! Держава теряет провинцию.', 'bad');
       }
       for (const e of out.events) sim.addLog(e.text, e.type);
       return out;
     }

4) СЧАСТЬЕ. Якорь — тело systemsHappyMod():

     return W.happyMod(sim.sys.winter) + IND.industryHappyMod(sim) + POL.politicsHappyMod(sim);

   ЗАМЕНИТЬ на:

     return W.happyMod(sim.sys.winter) + IND.industryHappyMod(sim) + POL.politicsHappyMod(sim)
       + LS.survivalHappyMod(sim);

5) СЕЙВ. Якорь в systemsSerialize():

     emp: EMP.empireSerialize(sim),

   ДОБАВИТЬ строкой ниже:

     link: sim.linkSurvival || null,

   Якорь в systemsRestore():

     if (data.emp) EMP.empireRestore(sim, data.emp);

   ДОБАВИТЬ строкой ниже:

     sim.linkSurvival = LS.restoreSurvivalMemory(data.link);

6) НЕОБЯЗАТЕЛЬНО, но ради этого всё и делалось — строка причины в HUD. Готовый
   текст «Стабильность −2.4/день: Голод: запаса на 1.2 дн. (−2.9), Стужа (−0.7)»:

     LS.survivalBreakdown(sim).text     // строка
     LS.survivalBreakdown(sim).rows     // [{ru, v}] — если нужен список

   survivalBreakdown память НЕ двигает, звать её из рендера безопасно.

────────────────────────────────────────────────────────────────────────────── */
