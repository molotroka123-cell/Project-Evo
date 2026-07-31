// Тесты модуля отопления и суровой зимы (U07). Запуск: node app/tests/test-winter.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRng } from '../src/core/rng.js';
import { Simulation } from '../src/core/simulation.js';
import { DAYS_PER_SEASON, WEATHER_TABLE, BUILDINGS } from '../src/core/data.js';
import {
  createWinter, tickWinter, heatDemand, baseDemand, demandBreakdown, winterForecast,
  winterStatus, winterHistory, happyMod, hearthCount, severity, insulationMult,
  careMult, comfortMult, serializeWinter, deserializeWinter,
  WINTER_SEASON, WINTER_DAYS, SEV_SUM, WINTER_WEATHER_AVG,
  COLD_SICK, COLD_DEATH, WOOD_PER_POP, WOOD_PER_HEARTH,
} from '../src/core/systems/winter.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

// ---------- Вспомогательное ----------
// Поселение «как в игре»: кострище (жильё 6) плюс хижины по 4 до покрытия людей.
function village(pop) {
  const ids = ['campfire'];
  let cap = BUILDINGS.campfire.housing;
  while (cap < pop) { ids.push('hut'); cap += BUILDINGS.hut.housing; }
  return ids;
}

// Погода тянется из той же таблицы, что и в ядре, тем же способом — прогон
// остаётся детерминированным, но зима выглядит как настоящая (45% снега).
function rollWeather(rng) {
  let roll = rng.range(0, 100), acc = 0;
  for (const [w, p] of WEATHER_TABLE[WINTER_SEASON]) { acc += p; if (roll <= acc) return w; }
  return 'snow';
}

// Прогон одной зимы (25 дней). Возвращает подробный отчёт для цифр в тесте.
function runWinter({ pop, wood, income = 0, ids = null, techs = ['fire', 'tools'], seed = 7, days = WINTER_DAYS }) {
  const rng = createRng(seed);
  const st = createWinter();
  const villagers = [];
  for (let i = 0; i < pop; i++) villagers.push({ name: `Житель-${i + 1}`, hp: 100 });
  const builtIds = ids || village(pop);
  let w = wood, burned = 0, coldDays = 0, deaths = 0;
  let firstChill = 0, firstSick = 0, firstDeath = 0, worstHappy = 0, peakSick = 0;
  for (let i = 0; i < days; i++) {
    w += income;
    const rep = tickWinter(st, {
      day: 75 + i, seasonIdx: WINTER_SEASON, weather: rollWeather(rng),
      villagers, wood: w, buildings: builtIds, techs,
    }, rng);
    w = Math.max(0, w - rep.burned);
    for (let k = villagers.length - 1; k >= 0; k--) if (villagers[k].hp <= 0) villagers.splice(k, 1);
    burned += rep.burned;
    if (rep.deficit > 0.02) { coldDays++; if (!firstChill) firstChill = i + 1; }
    if (rep.newSick > 0 && !firstSick) firstSick = i + 1;
    if (rep.deathCount > 0 && !firstDeath) firstDeath = i + 1;
    deaths += rep.deathCount;
    peakSick = Math.max(peakSick, rep.sick);
    worstHappy = Math.min(worstHappy, rep.happyMod);
  }
  return { state: st, wood: w, burned, coldDays, deaths, firstChill, firstSick, firstDeath,
    peakSick, worstHappy, survivors: villagers.length, start: pop };
}

// ---------------------------------------------------------------- форма сезона
t('U07 форма зимы: расход нарастает к середине сезона', () => {
  const a = severity(0), mid = severity(Math.floor((WINTER_DAYS - 1) / 2)), z = severity(WINTER_DAYS - 1);
  ok(mid > a && mid > z, `середина не тяжелее краёв: ${f1(a)} / ${f1(mid)} / ${f1(z)}`);
  ok(Math.abs(a - z) < 1e-9, 'вход и выход из зимы должны быть симметричны');
  let prev = 0, growsToMid = true;
  for (let i = 0; i <= Math.floor((WINTER_DAYS - 1) / 2); i++) { if (severity(i) < prev - 1e-9) growsToMid = false; prev = severity(i); }
  ok(growsToMid, 'до середины сезона расход обязан только расти');
  ok(Math.abs(SEV_SUM - 20.6) < 0.5, `сумма severity за зиму уехала: ${f1(SEV_SUM)}`);
  console.log(`   severity: день 1 ${f1(a)} → день 13 ${f1(mid)} → день 25 ${f1(z)}; сумма ${f1(SEV_SUM)}, средняя погода ×${f1(WINTER_WEATHER_AVG)}`);
});

// ---------------------------------------------------------------- очаги
t('U07 очаги: топим по потребности, уплотнение экономит дрова', () => {
  ok(hearthCount(village(30), 30) === 7, `у 30 жителей должно быть 7 очагов, а не ${hearthCount(village(30), 30)}`);
  ok(hearthCount(['campfire', 'hut', 'hut', 'hut', 'hut', 'hut', 'hut'], 0) === 0, 'без людей топить нечего');
  // Пустующее жильё не топится: лишние хижины не должны увеличивать счёт.
  const lean = hearthCount(['campfire', 'hut', 'hut'], 10);
  const spare = hearthCount(['campfire', 'hut', 'hut', 'hut', 'hut', 'hut', 'hut'], 10);
  ok(lean === spare, `пустые хижины греются зря: ${lean} vs ${spare}`);
  // Каменный дом (8) вместо двух хижин (4+4) — на один очаг меньше.
  const huts = hearthCount(['campfire', 'hut', 'hut', 'hut', 'hut', 'hut', 'hut'], 30);
  const stone = hearthCount(['campfire', 'stone_house', 'stone_house', 'stone_house'], 30);
  ok(stone < huts, `уплотнение не экономит: ${huts} → ${stone}`);
  console.log(`   30 душ: 6 хижин = ${huts} очагов, 3 каменных дома = ${stone} очагов`);
});

// ---------------------------------------------------------------- сезонность
t('U07 дрова горят только зимой', () => {
  const ctx = (seasonIdx) => ({ day: seasonIdx * DAYS_PER_SEASON + 5, seasonIdx, weather: 'snow', pop: 30, wood: 200, buildings: village(30), techs: ['fire'] });
  for (let s = 0; s < 3; s++) ok(heatDemand(ctx(s)) === 0, `в сезоне ${s} печи топятся`);
  ok(heatDemand(ctx(3)) > 0, 'зимой печи холодные');
  // И тик вне зимы не должен списывать ни полена.
  const st = createWinter();
  const rng = createRng(1);
  let spent = 0;
  for (let d = 0; d < 75; d++) {
    const rep = tickWinter(st, { day: d, seasonIdx: Math.floor(d / DAYS_PER_SEASON) % 4, weather: 'snow', pop: 30, wood: 5, buildings: village(30), techs: ['fire'] }, rng);
    spent += rep.burned;
  }
  ok(spent === 0, `за три бесснежных сезона сожжено ${spent}🪵`);
  console.log(`   вёсна-лето-осень: расход ${spent}🪵, зимний день (снег): ${f1(heatDemand(ctx(3)))}🪵`);
});

// ---------------------------------------------------------------- прогноз
t('U07 прогноз виден заранее и честен по цифрам', () => {
  const base = { day: 50, seasonIdx: 2, pop: 30, buildings: village(30), techs: ['fire', 'tools'] };
  const poor = winterForecast({ ...base, wood: 20, woodPerDay: 0 });
  ok(poor.daysToWinter === 25, `до зимы должно быть 25 дней, а не ${poor.daysToWinter}`);
  ok(poor.deficit > 0 && poor.level !== 'ok', 'дефицит не замечен');
  ok(/зим/i.test(poor.text) && /🪵/.test(poor.text), 'текст прогноза не годится для интерфейса');
  const rich = winterForecast({ ...base, wood: 20, woodPerDay: 4 });
  ok(rich.projected > poor.projected, 'приход дров не учитывается в прогнозе');
  ok(rich.ready && rich.level === 'ok', `с лесопилкой прогноз обязан быть спокойным: ${rich.text}`);
  // Прогноз обязан совпадать с тем, что реально сожжётся за зиму (±15%).
  const r = runWinter({ pop: 30, wood: 500, income: 0 });
  const err = Math.abs(r.burned - poor.need) / poor.need;
  ok(err < 0.15, `прогноз ${f1(poor.need)} против факта ${f1(r.burned)} — расхождение ${Math.round(err * 100)}%`);
  console.log(`   30 душ, 7 очагов: прогноз ${f1(poor.need)}🪵 на зиму (пик ${f1(poor.perDayPeak)}🪵/день), факт сожжено ${f1(r.burned)}🪵`);
  console.log(`   «${poor.text}»`);
  console.log(`   «${rich.text}»`);
});

// ---------------------------------------------------------------- баланс 30
t('U07 баланс: 30 жителей с одной лесопилкой зимуют спокойно', () => {
  // Лесопилка: 3 рабочих × 1.2🪵 × техника «Орудия труда» × зимняя погода ≈ 4🪵/день.
  const r = runWinter({ pop: 30, wood: 40, income: 4 });
  ok(r.deaths === 0, `замёрзло ${r.deaths} — зима не должна убивать подготовленных`);
  ok(r.peakSick === 0, `слегло ${r.peakSick} жителей при полном отоплении`);
  ok(r.coldDays === 0, `${r.coldDays} дней недотопа при достаточном приходе`);
  ok(r.survivors === 30, `дожило ${r.survivors} из 30`);
  console.log(`   старт 40🪵 + 4🪵/день: сожжено ${f1(r.burned)}🪵, к весне осталось ${f1(r.wood)}🪵, потерь нет`);
  // Даже вдвое более скромная добыча (2🪵/день) вытягивает зиму.
  const lean = runWinter({ pop: 30, wood: 40, income: 2 });
  ok(lean.deaths === 0, `при 2🪵/день погибло ${lean.deaths}`);
  console.log(`   тот же посёлок при 2🪵/день: холодных дней ${lean.coldDays}, больных ${lean.peakSick}, погибших ${lean.deaths}, остаток ${f1(lean.wood)}🪵`);
});

// ---------------------------------------------------------------- баланс 60
t('U07 баланс: 60 жителей без подготовки страдают', () => {
  const bad = runWinter({ pop: 60, wood: 20, income: 0 });
  ok(bad.coldDays > 15, `недотоп всего ${bad.coldDays} дней — зима слишком добрая`);
  ok(bad.peakSick > 0, 'никто не заболел при полном отсутствии дров');
  ok(bad.deaths > 0, 'холод никого не убил — угроза не читается');
  ok(bad.survivors >= 60 * 0.5, `выкосило слишком много: осталось ${bad.survivors} из 60`);
  const need = winterForecast({ day: 50, seasonIdx: 2, pop: 60, wood: 20, buildings: village(60), techs: ['fire', 'tools'] });
  console.log(`   60 душ, ${need.hearths} очагов: зиме нужно ${f1(need.need)}🪵, было 20🪵`);
  console.log(`   итог: холодных дней ${bad.coldDays}, больных до ${bad.peakSick}, погибло ${bad.deaths}, дожило ${bad.survivors}/60, счастье до ${bad.worstHappy}`);
  // Та же толпа с одной лесопилкой всё равно не дотягивает — нужен второй сруб.
  const one = runWinter({ pop: 60, wood: 20, income: 4 });
  ok(one.coldDays > 0, 'одна лесопилка внезапно закрыла потребность шестидесяти');
  const two = runWinter({ pop: 60, wood: 60, income: 8 });
  ok(two.deaths === 0 && two.peakSick === 0, `подготовленные шестьдесят всё равно страдают: болезней ${two.peakSick}, смертей ${two.deaths}`);
  console.log(`   60 душ + 1 лесопилка (4🪵/день): холодных дней ${one.coldDays}, больных ${one.peakSick}, погибло ${one.deaths}`);
  console.log(`   60 душ + 2 лесопилки и запас 60🪵: холодных дней ${two.coldDays}, потерь ${two.deaths}`);
});

// ---------------------------------------------------------------- лестница
t('U07 лестница: счастье → болезни → смерти, время на реакцию есть', () => {
  const r = runWinter({ pop: 30, wood: 0, income: 0 });
  ok(r.firstChill === 1, `штраф к счастью обязан прийти в первый же день, а пришёл на ${r.firstChill}`);
  ok(r.firstSick > r.firstChill, `болезни начались не позже недовольства (${r.firstSick} vs ${r.firstChill})`);
  ok(r.firstDeath > r.firstSick, `смерти опередили болезни (${r.firstDeath} vs ${r.firstSick})`);
  ok(r.firstDeath >= 5, `первая смерть на ${r.firstDeath}-й день — игрок не успевает среагировать`);
  ok(r.survivors > 1, 'поселение вымерло полностью');
  console.log(`   полный недотоп, 30 душ: счастье падает с дня ${r.firstChill}, болезни с дня ${r.firstSick}, смерти с дня ${r.firstDeath}`);
  console.log(`   за зиму: больных до ${r.peakSick}, погибло ${r.deaths}, дожило ${r.survivors}/30, худшее счастье ${r.worstHappy}`);
  // Пороги накопления холода не должны совпадать: между ступенями нужен зазор.
  ok(COLD_DEATH - COLD_SICK >= 2, 'между болезнями и смертями меньше двух суток запаса');
});

// ---------------------------------------------------------------- смягчение
t('U07 смягчение: кладка греет, лечебница лечит, акведук утешает', () => {
  const ctx = (extraIds = [], techs = ['fire']) => ({
    day: 80, seasonIdx: WINTER_SEASON, weather: 'snow', pop: 40, wood: 100,
    buildings: [...village(40), ...extraIds], techs,
  });
  const plain = heatDemand(ctx());
  const walled = heatDemand(ctx([], ['fire', 'masonry', 'construction']));
  ok(walled < plain, `кладка не снижает расход: ${f1(plain)} → ${f1(walled)}`);
  ok(insulationMult(ctx([], ['fire', 'masonry'])) < 1, 'утепление не считается');
  ok(careMult(ctx(['clinic'])) < careMult(ctx()), 'лечебница не влияет на болезни');
  ok(careMult(ctx(['clinic', 'hospital', 'sewers'])) >= 0.15, 'уход не должен обнулять последствия совсем');
  ok(comfortMult(ctx(['aqueduct'])) < comfortMult(ctx()), 'акведук не смягчает штраф счастья');

  // На прогоне: лечебница обязана уменьшить число заболевших.
  const raw = runWinter({ pop: 40, wood: 0, ids: village(40) });
  const cured = runWinter({ pop: 40, wood: 0, ids: [...village(40), 'clinic', 'sewers'] });
  ok(cured.peakSick < raw.peakSick, `лечебница не помогла: ${raw.peakSick} → ${cured.peakSick}`);
  console.log(`   расход 40 душ: без техов ${f1(plain)}🪵/день, с кладкой и строительством ${f1(walled)}🪵/день`);
  console.log(`   болезни за зиму без дров: без медицины ${raw.peakSick}, с лечебницей и канализацией ${cured.peakSick} (погибло ${raw.deaths} → ${cured.deaths})`);
});

// ---------------------------------------------------------------- счастье
t('U07 счастье: штраф только отрицательный и весной сходит на нет', () => {
  const rng = createRng(3);
  const st = createWinter();
  const villagers = Array.from({ length: 20 }, (_, i) => ({ name: `Ж${i}`, hp: 100 }));
  const ids = village(20);
  for (let i = 0; i < 12; i++) {
    tickWinter(st, { day: 75 + i, seasonIdx: WINTER_SEASON, weather: 'snow', villagers, wood: 0, buildings: ids, techs: ['fire'] }, rng);
    ok(happyMod(st) <= 0, 'холод не может радовать');
  }
  const frozen = happyMod(st);
  ok(frozen < -5, `штраф счастья слишком мягкий: ${frozen}`);
  for (let i = 0; i < 25; i++) {
    tickWinter(st, { day: 100 + i, seasonIdx: 0, weather: 'sun', villagers, wood: 200, buildings: ids, techs: ['fire'] }, rng);
  }
  ok(happyMod(st) === 0, `весной штраф остался: ${happyMod(st)}`);
  ok(st.sick === 0, `весной остались больные: ${st.sick}`);
  ok(winterHistory(st).length === 1, 'сводка прошедшей зимы не записана');
  const h = winterHistory(st)[0];
  console.log(`   зимой штраф ${frozen}, весной ${happyMod(st)}; в летописи: холодных дней ${h.coldDays}, больных ${h.sick}, погибших ${h.deaths}`);
});

// ---------------------------------------------------------------- детерминизм
t('U07 детерминизм: одинаковый сид — одинаковая зима, Math.random нет', () => {
  const a = runWinter({ pop: 50, wood: 30, income: 1, seed: 12345 });
  const b = runWinter({ pop: 50, wood: 30, income: 1, seed: 12345 });
  ok(a.deaths === b.deaths && a.peakSick === b.peakSick && Math.abs(a.burned - b.burned) < 1e-9,
    `прогоны разошлись: ${a.deaths}/${b.deaths}, ${a.burned}/${b.burned}`);
  const c = runWinter({ pop: 50, wood: 30, income: 1, seed: 999 });
  ok(c.deaths !== a.deaths || c.peakSick !== a.peakSick || Math.abs(c.burned - a.burned) > 1e-9,
    'другой сид дал ровно ту же зиму — рандом не работает');
  const src = readFileSync(fileURLToPath(new URL('../src/core/systems/winter.js', import.meta.url)), 'utf8');
  ok(!/Math\.random\s*\(/.test(src), 'в модуле есть вызов Math.random — детерминизм и сейвы сломаны');
  ok(!/\bdocument\.|\bwindow\./.test(src), 'модуль лезет в DOM');
  console.log(`   сид 12345: сожжено ${f1(a.burned)}🪵, больных ${a.peakSick}, погибло ${a.deaths}; сид 999: ${f1(c.burned)}🪵, ${c.peakSick}, ${c.deaths}`);
});

// ---------------------------------------------------------------- сейв
t('U07 сейв: состояние переживает JSON', () => {
  const r = runWinter({ pop: 40, wood: 10, income: 1, seed: 77 });
  const raw = serializeWinter(r.state);
  const back = deserializeWinter(JSON.parse(JSON.stringify(raw)));
  ok(Math.abs(back.cold - Math.round(r.state.cold * 100) / 100) < 1e-9, 'холод потерян');
  ok(back.sick === r.state.sick, 'больные потеряны');
  ok(happyMod(back) === happyMod(r.state), 'штраф счастья потерян');
  ok(back.totals.deaths === r.state.totals.deaths, 'счётчик погибших потерян');
  ok(deserializeWinter(undefined).cold === 0, 'старый сейв без поля winter не грузится');
  ok(deserializeWinter(null).sick === 0, 'null не пережёван');
  // Продолжение зимы из сейва идёт тем же путём, что и без перезагрузки.
  const rngA = createRng(5), rngB = createRng(5);
  const ctx = { day: 90, seasonIdx: WINTER_SEASON, weather: 'snow', pop: 40, wood: 0, buildings: village(40), techs: ['fire'] };
  const one = tickWinter(deserializeWinter(raw), ctx, rngA);
  const two = tickWinter(deserializeWinter(raw), ctx, rngB);
  ok(one.demand === two.demand && one.newSick === two.newSick, 'загруженное состояние ведёт себя иначе');
  console.log(`   сохранено: холод ${back.cold}, больных ${back.sick}, всего сожжено ${f1(back.totals.burned)}🪵, погибших ${back.totals.deaths}`);
});

// ---------------------------------------------------------------- ядро
t('U07 работа с настоящей Simulation: ctx ядра переваривается как есть', () => {
  const s = new Simulation(42);
  s.execCommand('give wood 400'); s.execCommand('give food 400');
  s.placeBuilding('hut', 44, 44); s.placeBuilding('lumber', 46, 42);
  for (let i = 0; i < 200; i++) s.tick(0.5);
  const st = createWinter();
  const mkCtx = () => ({
    day: s.day, seasonIdx: s.seasonIdx, weather: s.weather,
    villagers: s.villagers, wood: s.res.wood, housingCap: s.housingCap(),
    buildings: s.doneBuildings(), techs: s.techs, woodPerDay: 4,
  });
  // Прогноз обязан работать в любой сезон, ещё до первого мороза.
  const fc = winterForecast(mkCtx());
  ok(fc.need > 0 && typeof fc.text === 'string', 'прогноз не считается на живой игре');
  ok(['ok', 'warn', 'bad'].includes(fc.level), 'уровень тревоги не задан');
  // Прокручиваем игру её собственным tick() до конца ближайшей зимы и топим
  // настоящими дровами ядра — ровно так, как это будет делать onNewDay().
  let burned = 0, winterDays = 0, lastDay = s.day;
  for (let i = 0; i < 6000 && winterDays < WINTER_DAYS; i++) {
    s.tick(0.5);
    if (s.day === lastDay) continue;
    lastDay = s.day;
    s.res.food = Math.max(s.res.food, 150); // голод здесь не проверяем — изолируем холод
    const rep = tickWinter(st, mkCtx(), s.rng);
    s.res.wood = Math.max(0, s.res.wood - rep.burned);
    if (rep.deaths.length) s.villagers = s.villagers.filter(v => v.hp > 0);
    burned += rep.burned;
    if (s.seasonIdx === WINTER_SEASON) winterDays++;
  }
  ok(burned > 0, 'за целую зиму не сожжено ни полена');
  ok(s.villagers.length > 0, 'ядро осталось без жителей');
  const status = winterStatus(st, mkCtx());
  ok(typeof status.text === 'string' && status.text.length > 10, 'строка для HUD пуста');
  ok(happyMod(st) <= 0, 'штраф счастья положителен');
  const br = demandBreakdown(mkCtx());
  console.log(`   сим сид 42: день ${s.day}, жителей ${s.villagers.length}, за зиму сожжено ${f1(burned)}🪵, в амбаре ${f1(s.res.wood)}🪵 (лесопилка успевает восполнять)`);
  console.log(`   разбор: люди ${br.people}🪵 + очаги ${br.hearth}🪵 (${br.hearths} шт.) + улица ${br.street}🪵, утепление ×${br.insulation}`);
  console.log(`   HUD: «${status.text}» (${status.level})`);
});

// ---------------------------------------------------------------- крайние случаи
t('U07 крайние случаи не роняют модуль', () => {
  const rng = createRng(2);
  const st = createWinter();
  const empty = tickWinter(st, { day: 80, seasonIdx: WINTER_SEASON, pop: 0, wood: 0, buildings: [], techs: [] }, rng);
  ok(empty.burned === 0 && empty.deathCount === 0, 'пустое поселение что-то жжёт');
  ok(winterForecast({ day: 80, seasonIdx: WINTER_SEASON, pop: 0, wood: 0, buildings: [], techs: [] }).need === 0, 'прогноз для нуля жителей не нулевой');
  ok(heatDemand({}) === 0, 'пустой ctx не пережёван');
  ok(baseDemand({ pop: 10, buildings: [], techs: [], seasonIdx: 3 }) > 0, 'бездомные не требуют тепла');
  // Последний житель неприкосновенен: партия не должна кончаться молча.
  const solo = [{ name: 'Один', hp: 100 }];
  const st2 = createWinter();
  st2.cold = 12; st2.sick = 1;
  for (let i = 0; i < 30; i++) {
    tickWinter(st2, { day: 200 + i, seasonIdx: WINTER_SEASON, weather: 'snow', villagers: solo, wood: 0, buildings: ['campfire'], techs: [] }, rng);
    st2.lastDay = -1;
  }
  ok(solo.length === 1 && solo[0].hp > 0, 'последний житель замёрз — партия закончилась сама собой');
  // Повторный вызов в тот же день ничего не списывает дважды.
  const st3 = createWinter();
  const ctx = { day: 80, seasonIdx: WINTER_SEASON, weather: 'snow', pop: 20, wood: 100, buildings: village(20), techs: [] };
  const first = tickWinter(st3, ctx, rng), second = tickWinter(st3, ctx, rng);
  ok(first.burned > 0 && second.burned === 0, 'двойной вызов сжигает дрова дважды');
  console.log(`   пустое поселение ${empty.burned}🪵, двойной тик ${f1(first.burned)}🪵 + ${f1(second.burned)}🪵, одиночка выжил`);
});

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
