// Тесты связи «территория → расстояние → коррупция → отпадение» (link_territory.js).
// Запуск: node app/tests/test-link-territory.mjs
//
// Проверяем не «функция не упала», а числа: направление каждой связи, точные
// величины, потолки петель, выход из петли и молчание при спокойном ходе дел.
import { Simulation } from '../src/core/simulation.js';
import { createBorders, OWNER_PLAYER } from '../src/core/systems/borders.js';
import { CORR_MAX, UNREST_REVOLT, PROD_PER_POP } from '../src/core/systems/empire.js';
import {
  territoryLinks, territoryState, territoryBreakdown, territoryWatch,
  territoryLandTaxMult, territoryPopCap, territoryHappyMod,
  secessionEta, nearestNeighbour,
  createTerritoryMemory, restoreTerritoryMemory,
  TILES_PER_HEAD, POP_CAP_MAX, REACH_FREE, GOV_REACH, ROAD_REACH_GAIN,
  STRETCH_SPAN, STRETCH_TAX, LAND_TAX_MIN, CORR_FREE_PRESS, CORR_ESTATE,
  CORR_STAB, SEPAR_PER_DAY, STAB_HOLD, HOLD_PER_DAY, PANIC_SEPAR,
  GARRISON_FULL, GARRISON_HOLD, UNREST_STEP_MAX, AUTONOMY_UNREST,
  DEMAND_COOLDOWN, DEMAND_STAB, DEMAND_STAB_CAP, SEPAR_STAB, STAB_FLOOR,
  WARN_ETA, DEFECT_RANGE, DEFECT_P_CAP, DEFECT_REL_TAKER, DEFECT_REL_OTHERS,
  DEFECT_STAB_SHOCK, FREE_CITY_STAB_SHOCK, DEFECT_SHOCK_DAYS, DEFECT_HAPPY,
} from '../src/core/systems/link_territory.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≠ ${b}`);
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

// ─────────────────────────────────────────────── вспомогательное

const CAP_X = 8, CAP_Y = 48, MAP = 96;

// Полоса своей земли строго на восток от столицы: клетки на расстояниях a..b.
// Так средняя удалённость (reach) задаётся точно, а не «примерно как у круга».
function lineBorders(a, b) {
  const st = createBorders(MAP, MAP);
  for (let d = a; d <= b; d++) st.owners[CAP_Y * MAP + (CAP_X + d)] = OWNER_PLAYER;
  return st;
}

// Круг вокруг столицы — когда важна только площадь.
function diskBorders(r) {
  const st = createBorders(MAP, MAP);
  for (let y = 0; y < MAP; y++) {
    for (let x = 0; x < MAP; x++) {
      if (Math.hypot(x - CAP_X, y - CAP_Y) <= r) st.owners[y * MAP + x] = OWNER_PLAYER;
    }
  }
  return st;
}

function city(o = {}) {
  return {
    id: o.id ?? 1, name: o.name || 'Дальнеград',
    x: CAP_X + (o.dist ?? 20), y: CAP_Y,
    pop: o.pop ?? 10, spec: o.spec ?? null, buildings: o.buildings || [],
    local: { food: 30, wood: 20 },
    happy: o.happy ?? 60, unrest: o.unrest ?? 0,
  };
}

function faction(id, name, x, y) {
  return { id, def: { name }, alive: true, P: 10, settlements: [{ x, y, capital: true }] };
}

// Поддельный sim: связь читает только эти поля. Подделка позволяет ставить ровно
// то состояние, которое проверяется, без прогона тысячи игровых дней.
function makeSim(o = {}) {
  const sim = {
    day: o.day ?? 100,
    world: { w: MAP, h: MAP, startX: CAP_X, startY: CAP_Y },
    buildings: (o.buildings || []).map(id => ({ id, done: true, destroyed: false })),
    techs: new Set(o.techs || []),
    res: { gold: 100, food: 100, wood: 100 },
    villagers: [],
    factions: o.factions || [],
    sys: { borders: o.borders || createBorders(MAP, MAP) },
    politics: {
      state: {
        gov: o.gov || 'chiefdom',
        stability: o.stability ?? 60,
        turmoil: 0, revoltShock: 0, ruler: null,
        doctrines: { power: 0, coin: 0, mind: 0 },
        factions: { nobles: 55, clergy: 55, merchants: 55, commons: 55, military: 55 },
      },
    },
    empire: {
      state: { cities: o.cities || [], lost: [], caravans: [] },
      lastReport: o.report || null,
    },
    armyPower: () => o.army ?? 0,
    linkTerritory: o.mem || null,
  };
  return sim;
}

// Сутки как в integrate.js: связь считается, новая память уходит наружу,
// мир при этом не меняется (проверяем связь, а не ядро).
function runDay(sim) {
  sim.day++;
  const r = territoryLinks(sim);
  sim.linkTerritory = r.flags.memory;
  return r;
}

// Тот же день, что уже записан в памяти: разовые события (ультиматум, отпадение)
// не срабатывают — видно чистые дневные поправки.
function frozen(o = {}) {
  const sim = makeSim(o);
  sim.linkTerritory = { ...createTerritoryMemory(), day: sim.day, ...(o.mem || {}) };
  return sim;
}

// ─────────────────────────────────────────────── 1. молчание

t('спокойная держава не даёт ни одной поправки', () => {
  const sim = makeSim({ borders: diskBorders(5) });
  const r = territoryLinks(sim);
  ok(r.mods.stability === 0, `стабильность дёрнулась на пустом месте: ${r.mods.stability}`);
  ok(r.mods.happy === 0, `счастье дёрнулось: ${r.mods.happy}`);
  ok(r.mods.stabilityShock === 0, `шок на пустом месте: ${r.mods.stabilityShock}`);
  ok(r.mods.landTaxMult === 1, `налог порезан без растяжки: ${r.mods.landTaxMult}`);
  ok(Object.keys(r.mods.cityUnrest).length === 0, 'смута появилась без городов');
  ok(Object.keys(r.mods.relations).length === 0, 'отношения дёрнулись без причины');
  ok(Object.values(r.mods.estates).every(v => v === 0), `сословия дёрнулись: ${JSON.stringify(r.mods.estates)}`);
  ok(r.events.length === 0, `лишние события: ${r.events.map(e => e.text).join(' | ')}`);
  ok(r.flags.reasons.length === 0, 'в спокойной державе нашлись причины падения');
  ok(Object.keys(r.mods.estates).length === 5, 'сословия не совпали с politics.js');
});

t('ближняя колония в мёртвой зоне никого не злит', () => {
  // Город в 12 клетках: коррупция 3%, это меньше CORR_FREE_PRESS — держава терпит.
  const sim = frozen({ cities: [city({ dist: 12, unrest: 0 })] });
  const r = territoryLinks(sim);
  const s = territoryState(sim);
  ok(s.corrPress < CORR_FREE_PRESS, `порог мёртвой зоны выбран неверно: ${s.corrPress}`);
  ok(r.mods.stability === 0, `ближняя колония валит стабильность: ${r.mods.stability}`);
  ok(Object.values(r.mods.estates).every(v => v === 0), 'ближняя колония злит сословия');
  console.log(`   город в 12 клетках: коррупция ${Math.round(s.corrAvg * 100)}%, поправок нет`);
});

// ─────────────────────────────────────────────── 2. площадь → население и налог

t('площадь границ поднимает потолок населения и упирается в потолок', () => {
  ok(territoryLinks(makeSim({ borders: createBorders(MAP, MAP) })).mods.popCap === 0,
    'потолок вырос без территории');
  // Ровно три «надела»: TILES_PER_HEAD × 3 клетки и ни клеткой больше.
  const three = territoryLinks(makeSim({ borders: lineBorders(1, TILES_PER_HEAD * 3) }));
  ok(three.flags.tiles === TILES_PER_HEAD * 3, `посчитано не то число клеток: ${three.flags.tiles}`);
  ok(three.mods.popCap === 3, `${TILES_PER_HEAD * 3} клеток дали ${three.mods.popCap}, ждали 3`);
  const one = territoryLinks(makeSim({ borders: lineBorders(1, TILES_PER_HEAD - 1) }));
  ok(one.mods.popCap === 0, `неполный надел дал прибавку: ${one.mods.popCap}`);
  // Потолок: полкарты не отменяет постройку изб.
  const huge = territoryLinks(makeSim({ borders: diskBorders(30) }));
  ok(huge.flags.tiles > TILES_PER_HEAD * POP_CAP_MAX * 2, `круг вышел мелким: ${huge.flags.tiles}`);
  ok(huge.mods.popCap === POP_CAP_MAX, `потолок прибавки не сработал: ${huge.mods.popCap}`);
  console.log(`   ${huge.flags.tiles} клеток → +${huge.mods.popCap} к населению (потолок ${POP_CAP_MAX})`);
});

t('растяжка режет земельный налог по формуле и не ниже пола', () => {
  const compact = makeSim({ borders: lineBorders(1, 6) });     // reach 3.5 < руки 7
  ok(territoryLinks(compact).mods.landTaxMult === 1, 'компактная держава уже теряет подати');

  // Полоса 20..40: средняя удалённость ровно 30, рука вождества 7.
  const mid = makeSim({ borders: lineBorders(20, 40) });
  const sm = territoryState(mid);
  near(sm.reach, 30, 0.001, 'средняя удалённость посчитана неверно');
  const stretch = (30 - REACH_FREE * GOV_REACH.chiefdom) / STRETCH_SPAN;
  near(sm.stretch, stretch, 0.005, 'растяжка посчитана неверно');
  near(territoryLinks(mid).mods.landTaxMult, 1 - STRETCH_TAX * stretch, 0.005, 'налог порезан не по формуле');

  // Дальше некуда: растяжка 1, множитель упирается в пол.
  const torn = makeSim({ borders: lineBorders(60, 79) });
  ok(territoryState(torn).stretch === 1, `растяжка не дошла до единицы: ${territoryState(torn).stretch}`);
  near(territoryLinks(torn).mods.landTaxMult, LAND_TAX_MIN, 0.001, 'пол земельного налога пробит');
  ok(territoryLandTaxMult(torn) === territoryLinks(torn).mods.landTaxMult, 'отдельная функция налога разошлась со связью');
  console.log(`   reach 30 → налог ×${f1(territoryLinks(mid).mods.landTaxMult)}, полная растяжка → ×${LAND_TAX_MIN}`);
});

// ─────────────────────────────────────────────── 3. дороги и строй

t('дороги и форма правления удлиняют руку столицы', () => {
  const b = () => lineBorders(20, 40);   // reach 30 в обоих случаях
  const bare = makeSim({ borders: b() });
  const rail = makeSim({ borders: b(), techs: ['wheel', 'construction', 'railroads'], buildings: ['train_station'] });
  const sBare = territoryState(bare), sRail = territoryState(rail);
  near(sRail.reachFree, REACH_FREE * GOV_REACH.chiefdom * (1 + ROAD_REACH_GAIN), 0.01, 'рельсы удлинили руку не на ту величину');
  ok(sRail.reachFree > sBare.reachFree, 'рельсы не приблизили окраину');
  ok(sRail.stretch < sBare.stretch, 'растяжка с рельсами не уменьшилась');
  ok(territoryLinks(rail).mods.landTaxMult > territoryLinks(bare).mods.landTaxMult,
    'дороги не вернули часть податей');

  // Строй: империя держит провинции дальше вождества, республика — как монархия.
  const emp = territoryState(makeSim({ borders: b(), gov: 'empire' }));
  near(emp.reachFree, REACH_FREE * GOV_REACH.empire, 0.01, 'имперская рука посчитана неверно');
  ok(emp.stretch < sBare.stretch, 'империя не приблизила окраины');
  const fed = territoryState(makeSim({ borders: b(), gov: 'federation' }));
  ok(fed.reachFree > emp.reachFree, 'федерация должна тянуться дальше империи');
  console.log(`   рука: вождество ${sBare.reachFree}, империя ${emp.reachFree}, вождество+рельсы ${sRail.reachFree}`);
});

// ─────────────────────────────────────────────── 4. коррупция → общество

t('дальняя колония: коррупция бьёт по простолюдинам и кормит знать', () => {
  // 60 клеток — потолок коррупции 75%.
  const sim = frozen({ cities: [city({ dist: 60, pop: 12 })] });
  const s = territoryState(sim);
  near(s.corrAvg, CORR_MAX, 0.001, 'коррупция на 60 клетках не дошла до потолка');
  ok(s.corrBite === 1, `полное воровство не даёт полного укуса: ${s.corrBite}`);
  const r = territoryLinks(sim);
  near(r.mods.estates.commons, CORR_ESTATE.commons, 0.01, 'простолюдины реагируют не на ту величину');
  ok(r.mods.estates.commons < 0, 'простолюдины должны злиться на воровство');
  ok(r.mods.estates.nobles > 0, 'знать должна кормиться с наместничеств');
  ok(r.mods.estates.merchants < 0, 'купцы должны злиться на поборы');
  near(r.mods.stability, -CORR_STAB, 0.02, 'стабильность от полной коррупции упала не на ту величину');
  // Потери дани — то же число, что считает empire.js.
  near(r.flags.corruptionLoss, 12 * PROD_PER_POP.gold * CORR_MAX, 0.01, 'потери дани посчитаны не по empire.js');
  ok(/крад/.test(territoryBreakdown(sim).text), `причина не названа словами: ${territoryBreakdown(sim).text}`);
  console.log(`   ${territoryBreakdown(sim).text}`);
});

// ─────────────────────────────────────────────── 5. сепаратизм в обе стороны

t('дальность растит смуту, гарнизон её давит', () => {
  const far = () => city({ dist: 40, unrest: 1, happy: 60 });
  const weak = frozen({ cities: [far()], stability: STAB_HOLD, army: 0 });
  const rWeak = territoryLinks(weak);
  const s = territoryState(weak);
  const distPress = Math.min(1, (40 - s.reachFree) / STRETCH_SPAN);
  near(rWeak.mods.cityUnrest[1], SEPAR_PER_DAY * distPress, 0.02, 'прирост смуты от дальности не по формуле');
  ok(rWeak.mods.cityUnrest[1] > 0, 'дальний город при слабой власти не бунтует');

  const guarded = frozen({ cities: [far()], stability: STAB_HOLD, army: GARRISON_FULL });
  const rG = territoryLinks(guarded);
  near(rG.mods.cityUnrest[1], SEPAR_PER_DAY * distPress * (1 - GARRISON_HOLD), 0.02,
    'гарнизон снял не ту долю давления');
  ok(rG.mods.cityUnrest[1] < rWeak.mods.cityUnrest[1], 'армия не помогает против сепаратизма');
  console.log(`   город в 40 клетках: без армии +${f1(rWeak.mods.cityUnrest[1])}/день, с гарнизоном +${f1(rG.mods.cityUnrest[1])}`);
});

t('связь двусторонняя: крепкая власть отнимает смуту, шаткая — добавляет', () => {
  const near1 = () => city({ dist: 12, unrest: 5, happy: 60 });
  const strongSim = frozen({ cities: [near1()], stability: 100 });
  // Давление дальности одно и то же в обоих случаях — меняется только столица.
  const press = SEPAR_PER_DAY * ((12 - territoryState(strongSim).reachFree) / STRETCH_SPAN);
  const strong = territoryLinks(strongSim);
  near(strong.mods.cityUnrest[1], press - HOLD_PER_DAY, 0.02, 'крепкая власть снимает не ту величину');
  ok(strong.mods.cityUnrest[1] < 0, 'при стабильности 100 смута обязана убывать — это выход из петли');

  const shaky = territoryLinks(frozen({ cities: [near1()], stability: 0 }));
  ok(shaky.mods.cityUnrest[1] > 0, 'разваливающаяся столица не разгоняет окраины');
  near(shaky.mods.cityUnrest[1], press + PANIC_SEPAR, 0.02, 'паника добавляет не ту величину');
  ok(shaky.mods.cityUnrest[1] > strong.mods.cityUnrest[1], 'знак связи «стабильность → сепаратизм» перевёрнут');
  console.log(`   ближний город: стабильность 100 → ${f1(strong.mods.cityUnrest[1])}/день, стабильность 0 → +${f1(shaky.mods.cityUnrest[1])}`);
});

t('у смуты есть потолок шага в обе стороны', () => {
  const hell = territoryLinks(frozen({
    cities: [city({ dist: 90, unrest: 5, happy: 0 })], stability: 0, gov: 'republic',
  }));
  ok(hell.mods.cityUnrest[1] <= UNREST_STEP_MAX + 1e-9,
    `шаг смуты пробил потолок: ${hell.mods.cityUnrest[1]}`);
  const heaven = territoryLinks(frozen({ cities: [city({ dist: 11, unrest: 9 })], stability: 100, gov: 'empire' }));
  ok(heaven.mods.cityUnrest[1] >= -UNREST_STEP_MAX - 1e-9,
    `гашение смуты пробило потолок: ${heaven.mods.cityUnrest[1]}`);
  // Спокойный город с нулевой смутой в отчёт не попадает: «минус ноль» — не поправка.
  const calm = territoryLinks(frozen({ cities: [city({ dist: 12, unrest: 0 })], stability: 100 }));
  ok(calm.mods.cityUnrest[1] === undefined, 'спокойному городу приписана поправка');
});

t('падение стабильности от связи упирается в пол и говорит об этом', () => {
  const cities = [];
  for (let i = 1; i <= 4; i++) cities.push(city({ id: i, name: `Город ${i}`, dist: 70, unrest: UNREST_REVOLT - 0.5, happy: 5 }));
  const sim = frozen({ cities });
  const r = territoryLinks(sim);
  const raw = -CORR_STAB - SEPAR_STAB - DEMAND_STAB_CAP;
  ok(raw < STAB_FLOOR, `подобранный ад слабее пола (${raw} против ${STAB_FLOOR}) — тест бессмыслен`);
  ok(r.mods.stability === STAB_FLOOR, `пол стабильности не сработал: ${r.mods.stability}`);
  ok(r.flags.reasons.some(x => /Предел/.test(x.ru)), 'сработавший потолок не показан игроку');
  ok(r.flags.reasons.length >= 4, `причины не перечислены: ${JSON.stringify(r.flags.reasons)}`);
  console.log(`   четыре мятежные окраины: ${territoryBreakdown(sim).text}`);
});

t('требование автономии: порог, текст и откат', () => {
  const sim = makeSim({
    cities: [city({ dist: 30, unrest: AUTONOMY_UNREST })],
    factions: [faction('wolves', 'Волчий Предел', CAP_X + 45, CAP_Y)],
  });
  const first = runDay(sim);
  ok(first.flags.demands.length === 1, 'город не потребовал автономии на пороге');
  ok(first.events.some(e => /требует автономии/.test(e.text) && /Волчий Предел/.test(e.text)),
    `ультиматум без имени соседа: ${first.events.map(e => e.text).join(' | ')}`);
  near(first.mods.stability, -(CORR_STAB * territoryState(sim).corrBite) - SEPAR_STAB * (AUTONOMY_UNREST / UNREST_REVOLT) - DEMAND_STAB, 0.03,
    'висящее требование стоит не ту величину стабильности');

  const firstDay = sim.day;
  const second = runDay(sim);
  ok(second.flags.demands.length === 0, 'ультиматум повторился на следующий же день');
  // За полный откат требование обязано прозвучать ровно один раз и ровно в срок.
  let repeats = 0, repeatDay = -1;
  for (let i = 0; i < DEMAND_COOLDOWN; i++) {
    if (runDay(sim).flags.demands.length) { repeats++; repeatDay = sim.day; }
  }
  ok(repeats === 1, `за ${DEMAND_COOLDOWN} дней ультиматум прозвучал ${repeats} раз(а)`);
  ok(repeatDay === firstDay + DEMAND_COOLDOWN, `откат сработал не в срок: ${repeatDay} вместо ${firstDay + DEMAND_COOLDOWN}`);
});

// ─────────────────────────────────────────────── 6. предупреждение заранее

t('игрок узнаёт срок и имя соседа ДО потери города', () => {
  const sim = makeSim({
    cities: [city({ dist: 35, unrest: UNREST_REVOLT - 2, happy: 5 })],
    stability: 20,
    factions: [faction('guild', 'Золотая Гильдия', CAP_X + 50, CAP_Y)],
  });
  const s = territoryState(sim);
  const eta = secessionEta(s.cities[0], s);
  ok(eta !== null && eta <= WARN_ETA, `срок отпадения не посчитан заранее: ${eta}`);

  const watch = territoryWatch(sim);
  ok(watch.length === 1 && watch[0].eta === eta, 'панель наблюдения не показывает срок');
  ok(watch[0].taker === 'Золотая Гильдия', `панель не назвала соседа: ${watch[0].taker}`);
  ok(watch[0].advice.length > 0, 'предупреждение без единого совета');

  const r = runDay(sim);
  const warn = r.events.find(e => /отложится примерно через/.test(e.text));
  ok(warn, `предупреждения о потере не было: ${r.events.map(e => e.text).join(' | ')}`);
  ok(/Золотая Гильдия/.test(warn.text), `в предупреждении нет имени получателя: ${warn.text}`);
  ok(/Что делать/.test(warn.text), 'предупреждение без совета, что делать');

  // Спокойный город срока не имеет — предупреждать не о чем.
  const calm = makeSim({ cities: [city({ dist: 14, unrest: 0, happy: 70 })], stability: 80 });
  ok(territoryWatch(calm).length === 0, 'счастливому городу назначен срок отпадения');
  console.log(`   ${warn.text}`);
});

t('срок отпадения сокращается, когда дела идут хуже', () => {
  const mild = makeSim({ cities: [city({ dist: 30, unrest: 3, happy: 25 })], stability: 60, army: 40 });
  const harsh = makeSim({ cities: [city({ dist: 30, unrest: 3, happy: 5 })], stability: 10, army: 0 });
  const a = secessionEta(territoryState(mild).cities[0], territoryState(mild));
  const b = secessionEta(territoryState(harsh).cities[0], territoryState(harsh));
  ok(a !== null && b !== null, 'срок не посчитан');
  ok(b < a, `ухудшение не приблизило отпадение: было ${a}, стало ${b}`);
  console.log(`   срок до отпадения: спокойнее ${a} дн., хуже ${b} дн.`);
});

// ─────────────────────────────────────────────── 7. отпадение к соседу

t('отпавший город достаётся ближайшему соседу и портит отношения со всеми', () => {
  const gone = city({ id: 7, name: 'Дальнеозёрск', dist: 30, unrest: UNREST_REVOLT, pop: 14 });
  const sim = makeSim({
    cities: [gone],
    factions: [
      faction('wolves', 'Волчий Предел', CAP_X + 40, CAP_Y),      // ближе
      faction('guild', 'Золотая Гильдия', CAP_X + 30, CAP_Y - 25), // дальше
    ],
  });
  // День первый: город ещё жив — связь запоминает его положение.
  runDay(sim);
  // День второй: empire.js город убрал и отчитался о восстании.
  sim.empire.state.cities = [];
  sim.empire.lastReport = { day: sim.day + 1, revolted: [{ id: 7, name: 'Дальнеозёрск', pop: 14 }] };
  const r = runDay(sim);

  ok(r.flags.defected.length === 1, 'отпадение не разыграно');
  const d = r.flags.defected[0];
  ok(d.fid === 'wolves', `город ушёл не к ближайшему соседу: ${d.fid}`);
  ok(d.x === gone.x && d.y === gone.y, 'положение отпавшего города потеряно вместе с городом');
  ok(d.gainP === Math.min(DEFECT_P_CAP, 14), `сосед усилился не на то: ${d.gainP}`);
  ok(r.mods.relations.wolves === DEFECT_REL_TAKER, `с получателем отношения упали на ${r.mods.relations.wolves}`);
  ok(r.mods.relations.guild === DEFECT_REL_OTHERS, `остальные соседи не заметили слабости: ${r.mods.relations.guild}`);
  ok(r.mods.stabilityShock === DEFECT_STAB_SHOCK, `удар по стабильности не тот: ${r.mods.stabilityShock}`);
  ok(r.events.some(e => /присягнул Волчий Предел/.test(e.text)), 'игроку не сказали, кому ушёл город');
  console.log(`   ${r.events.find(e => /присягнул/.test(e.text)).text}`);
});

t('без соседа рядом город становится вольным, а не исчезает', () => {
  const sim = makeSim({
    cities: [city({ id: 3, name: 'Одиноковск', dist: 20, pop: 6 })],
    factions: [faction('wolves', 'Волчий Предел', CAP_X + 20 + DEFECT_RANGE + 15, CAP_Y)],
  });
  runDay(sim);
  sim.empire.state.cities = [];
  sim.empire.lastReport = { day: sim.day + 1, revolted: [{ id: 3, name: 'Одиноковск', pop: 6 }] };
  const r = runDay(sim);
  ok(r.flags.defected.length === 1 && r.flags.defected[0].fid === null,
    `слишком далёкий сосед всё-таки подобрал город: ${JSON.stringify(r.flags.defected[0])}`);
  ok(r.mods.stabilityShock === FREE_CITY_STAB_SHOCK, `вольный город стоил не того: ${r.mods.stabilityShock}`);
  ok(r.mods.relations.wolves === DEFECT_REL_OTHERS, 'потерю провинции соседи не заметили вовсе');
  ok(nearestNeighbour(territoryState(sim), CAP_X + 20, CAP_Y) === null, 'сосед за DEFECT_RANGE считается близким');
});

t('повторный вызов в те же сутки не отдаёт город дважды', () => {
  const sim = makeSim({
    cities: [city({ id: 5, name: 'Двойноград', dist: 25, pop: 10 })],
    factions: [faction('wolves', 'Волчий Предел', CAP_X + 35, CAP_Y)],
  });
  runDay(sim);
  sim.empire.state.cities = [];
  sim.empire.lastReport = { day: sim.day + 1, revolted: [{ id: 5, name: 'Двойноград', pop: 10 }] };
  const first = runDay(sim);
  ok(first.flags.defected.length === 1, 'первое отпадение не сработало');
  const again = territoryLinks(sim);     // тот же день, память уже записана
  ok(again.flags.defected.length === 0, 'город отдан соседу дважды за одни сутки');
  ok(Object.keys(again.mods.relations).length === 0, 'отношения испорчены дважды');
  ok(again.mods.stabilityShock === 0, 'второй удар по стабильности в те же сутки');
});

t('траур по потерянному городу затухает и не уходит в бесконечность', () => {
  const sim = makeSim({
    cities: [city({ id: 9, name: 'Горевск', dist: 25, pop: 8 })],
    factions: [faction('wolves', 'Волчий Предел', CAP_X + 35, CAP_Y)],
  });
  runDay(sim);
  sim.empire.state.cities = [];
  sim.empire.lastReport = { day: sim.day + 1, revolted: [{ id: 9, name: 'Горевск', pop: 8 }] };
  const hit = runDay(sim);
  ok(hit.mods.happy === -DEFECT_HAPPY, `первый день траура даёт ${hit.mods.happy}, ждали ${-DEFECT_HAPPY}`);
  ok(territoryHappyMod(sim) === -DEFECT_HAPPY, 'happiness() не увидит траур через память');

  sim.empire.lastReport = null;
  let last = 0;
  for (let i = 0; i < DEFECT_SHOCK_DAYS; i++) last = runDay(sim).mods.happy;
  ok(last === 0, `траур не кончился за ${DEFECT_SHOCK_DAYS} дней: ${last}`);
  ok(territoryHappyMod(sim) === 0, 'память держит вечный минус к счастью');
});

// ─────────────────────────────────────────────── 8. события, память, ядро

t('о растяжке державы говорят один раз на смене ступени', () => {
  const sim = makeSim({ borders: lineBorders(60, 79) });
  const first = runDay(sim);
  ok(first.flags.stage === 'torn', `ступень определена неверно: ${first.flags.stage}`);
  ok(first.events.some(e => /расползлась/.test(e.text)), 'о расползании державы не сказали');
  const second = runDay(sim);
  ok(!second.events.some(e => /расползлась/.test(e.text)), 'сообщение о расползании повторяется каждый день');
  // Собрались обратно — игрок узнаёт и об этом.
  sim.sys.borders = lineBorders(1, 6);
  const back = runDay(sim);
  ok(back.flags.stage === 'ok' && back.events.some(e => e.type === 'good'), 'возвращение к порядку не отмечено');
});

t('память переживает сейв и чистит мусор', () => {
  const sim = makeSim({
    cities: [city({ id: 2, name: 'Памятьград', dist: 30, unrest: AUTONOMY_UNREST })],
    factions: [faction('wolves', 'Волчий Предел', CAP_X + 40, CAP_Y)],
  });
  const r = runDay(sim);
  const saved = JSON.parse(JSON.stringify(r.flags.memory));
  const back = restoreTerritoryMemory(saved);
  ok(back.cities['2'] && back.cities['2'].x === CAP_X + 30, 'снимок города не пережил сейв');
  ok(back.day === saved.day && back.stage === saved.stage, 'память сейва разошлась');
  const junk = restoreTerritoryMemory({ stage: 'мусор', shock: 999, popCap: -4, cities: { 1: 'не объект' } });
  ok(junk.stage === 'ok', 'мусор из сейва прошёл насквозь');
  ok(junk.shock === DEFECT_SHOCK_DAYS && junk.popCap === 0, `мусорные числа не обрезаны: ${junk.shock}/${junk.popCap}`);
  ok(Object.keys(junk.cities).length === 0, 'мусорный город прошёл насквозь');
  ok(createTerritoryMemory().day === -1, 'свежая память не пуста');
  // Отпавший город из снимка вычищается — иначе память растёт вечно.
  sim.empire.state.cities = [];
  sim.empire.lastReport = { day: sim.day + 1, revolted: [{ id: 2, name: 'Памятьград', pop: 10 }] };
  const gone = runDay(sim);
  ok(!gone.flags.memory.cities['2'], 'снимок отпавшего города остался в памяти навсегда');
});

t('связь работает на настоящей Simulation', () => {
  const sim = new Simulation(4242);
  sim.onNewDay();                       // границы считаются в первый же день
  const r = territoryLinks(sim);
  ok(r.flags.tiles > 0, 'настоящие границы не прочитаны');
  ok(r.mods.stability === 0, `свежая партия что-то теряет: ${r.mods.stability}`);
  ok(r.mods.landTaxMult === 1, `свежая партия уже теряет подати: ${r.mods.landTaxMult}`);
  ok(r.mods.popCap >= 1, `земля вокруг костра не дала ни одного места: ${r.mods.popCap}`);
  sim.linkTerritory = r.flags.memory;
  ok(territoryPopCap(sim) === r.mods.popCap, 'housingCap() не увидит прибавку через память');

  // Подсаживаем дальнюю колонию — связь обязана это увидеть на живом объекте.
  sim.empire.state.cities.push({
    id: 99, name: 'Дальнеярск', x: sim.world.startX + 50, y: sim.world.startY,
    pop: 12, spec: null, buildings: [], local: { food: 10, wood: 5 }, happy: 10, unrest: 7,
  });
  sim.day++;
  const bad = territoryLinks(sim);
  ok(bad.mods.stability < 0, `дальняя мятежная колония не тронула трон: ${bad.mods.stability}`);
  ok(bad.mods.estates.commons < 0, 'простолюдины не заметили воровства наместника');
  ok(bad.mods.cityUnrest[99] > 0, 'сепаратизм не растёт на настоящей партии');
  ok(territoryWatch(sim).length === 1 && territoryWatch(sim)[0].eta > 0, 'панель наблюдения пуста при живой угрозе');
  console.log(`   настоящая партия: ${territoryBreakdown(sim).text}`);
  console.log(`   до отпадения ${territoryWatch(sim)[0].eta} дн., подберёт: ${territoryWatch(sim)[0].taker || 'никто'}`);
});

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
