// core/systems/link_territory.js — СВЯЗЬ: земля → расстояние → коррупция → отпадение.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. borders.js честно красит карту и платит земельный налог.
// empire.js честно считает коррупцию от расстояния и копит сепаратизм. politics.js
// честно держит стабильность и форму правления. Между ними не было ни одной линии:
// держава могла расползтись на пол-карты — и это не стоило ни монеты сверх нормы;
// колония могла отложиться — и никто из соседей этого не замечал, город просто
// исчезал из списка. Здесь проведены связи, которые делают из карты державу.
//
// ЧТО ИМЕННО СВЯЗАНО:
//   1. площадь границ (borders) → потолок населения: на своей земле ставят выселки;
//   2. средняя удалённость своей земли → «растяжка» → доля земельного налога,
//      которая до казны не доезжает (кормления, а не новый расход);
//   3. удалённость городов (empire) → коррупция → одобрение сословий и стабильность:
//      знать кормится с наместничеств, простолюдины и купцы видят воровство;
//   4. дальность + шаткая столица → рост сепаратизма СВЕРХ того, что копит
//      empire.js сам; крепкая власть и армия, наоборот, смуту гасят;
//   5. смута выше порога → город открыто требует автономии, и пока требование
//      висит — оно само точит стабильность;
//   6. отпадение → город уходит ПОД РУКУ КОНКРЕТНОГО СОСЕДА: тот получает
//      поселение и население, отношения с ним рушатся, остальные перестают
//      уважать державу, потерявшую провинцию;
//   7. дороги (ROAD_CLASSES из production.js) и форма правления (politics.js)
//      удлиняют «руку столицы»: с рельсами и имперской администрацией та же
//      клетка перестаёт быть далёкой.
//
// ОБРАТНЫЕ СВЯЗИ (обе стороны, а не только «дальше = хуже»):
//   стабильность → сепаратизм (крепкая власть отнимает смуту, шаткая добавляет);
//   сепаратизм   → стабильность (мятежные окраины подтачивают трон);
//   армия        → сепаратизм (гарнизоны), и это же даёт игроку рычаг спасения.
//
// ЧЕГО ЗДЕСЬ НЕТ. Ни одной новой механики. Коррупция не считается второй раз:
// вычет из дани делает сам empire.js, здесь только ПОСЛЕДСТВИЯ воровства для
// общества. Земельный налог не начисляется заново — возвращается множитель к уже
// существующему начислению. Города никто не удаляет: их удаляет empire.js, а этот
// модуль лишь решает, КОМУ достался отпавший город.
//
// ЧИСТЫЙ МОДУЛЬ. Ничего не мутирует: читает sim, возвращает поправки. Применяет
// их integrate.js (точные строки — в блоке ПОДКЛЮЧЕНИЕ в конце файла). Память
// связи приходит снаружи (sim.linkTerritory) и уходит обратно в flags.memory.
//
// СЛУЧАЙНОСТИ НЕТ ВООБЩЕ — ни Math.random, ни sim.rng. Отпадение города обязано
// быть предсказуемым: игрок должен уметь посчитать беду заранее, а сейв — сойтись
// с прогоном. Именно поэтому предупреждение о потере города называет и срок, и
// имя соседа, который его подберёт.
//
// ПОТОЛОК И ВЫХОД У КАЖДОЙ ПЕТЛИ. Дневная потеря стабильности ограничена
// STAB_FLOOR, шаг смуты — UNREST_STEP_MAX, шок от потери города затухает за
// DEFECT_SHOCK_DAYS. Ни одна петля не может сама себя разогнать: рост смуты
// ограничен сверху, а её гашение от стабильности и гарнизонов — сильнее роста,
// поэтому выправить положение всегда быстрее, чем оно портилось.

import { OWNER_PLAYER, territoryTiles } from './borders.js';
import {
  CORR_FREE_DIST, CORR_MAX, PROD_PER_POP, UNREST_HAPPY, UNREST_REVOLT,
  corruption, prodMult,
} from './empire.js';
import { ROAD_CLASSES, routeClass } from './production.js';
import { SOCIAL_FACTIONS, politicsMult } from './politics.js';

// ───────────────────────── Настройки связей ─────────────────────────

// 1. Площадь → потолок населения. Одна клетка своей земли — это не дом, но сорок
// клеток уже кормят хутор. Костёр в одиночку держит круг радиусом ~5 (см.
// INFLUENCE_THRESHOLD в borders.js) — это ~87 клеток, то есть ровно +1 к потолку
// на старте: земля даёт где жить, но избы всё равно строит игрок.
export const TILES_PER_HEAD = 45;
// Потолок прибавки. Без него держава на пол-карты перестала бы нуждаться в жилье
// вовсе, и вся ветка построек с housing обесценилась бы.
export const POP_CAP_MAX = 12;

// 2. «Рука столицы»: до какой средней удалённости земля управляется даром. База —
// та же, что у коррупции в empire.js (10 клеток = день пути курьера), иначе у
// игрока было бы два разных «далеко».
export const REACH_FREE = CORR_FREE_DIST;
// Насколько дальше руки дотягивается администрация каждого строя. Вождество
// управляет только тем, что видит от костра; империя тем и империя, что держит
// провинции; федерация не теряет никого — это прямо записано в её описании.
export const GOV_REACH = { chiefdom: 0.7, monarchy: 1.0, republic: 1.0, empire: 1.35, federation: 1.6 };
// Дороги. Класс берётся из production.js (тропа → просёлок → тракт → рельсы),
// ease = 0…1. Рельсы почти удваивают дальность, до которой держава «рядом».
export const ROAD_REACH_GAIN = 0.8;
// На сколько клеток сверх руки растягивается держава до ПОЛНОЙ растяжки.
// 30 клеток — это диагональ трети карты 96×96: дальше уже не окраина, а другая страна.
export const STRETCH_SPAN = 30;

// 3. Земельный налог. Полностью растянутая держава теряет почти половину сбора
// на кормлениях сборщиков — но никогда больше LAND_TAX_MIN, иначе земля
// перестала бы быть смыслом захвата. Выше единицы множитель не поднимается:
// дороги и строй не «печатают» деньги, они лишь возвращают потерянное.
export const STRETCH_TAX = 0.45;
export const LAND_TAX_MIN = 0.55;

// 4. Коррупция → общество. Мелкое кормление наместника держава терпит: до
// CORR_FREE_PRESS (это ~19% дани, то есть город в 22 клетках) связь молчит вовсе.
export const CORR_FREE_PRESS = 0.25;
// Дневные сдвиги одобрения при ПОЛНОМ воровстве (потолок коррупции 75%).
// Знать кормится с наместничеств — ей это выгодно; простолюдины и купцы платят.
// Для сравнения: собственный дрейф сословий к 50 в politics.js — ±0.05/день.
export const CORR_ESTATE = { nobles: 0.12, clergy: 0, merchants: -0.20, commons: -0.30, military: -0.05 };
export const ESTATE_STEP_CAP = 0.4;   // не больше этого за сутки на сословие
// Воровство подтачивает веру в державу. Для сравнения: дневной прирост
// стабильности у монархии +0.5, у республики +0.2 — то есть полная коррупция
// съедает прирост целиком, но сама в минус державу не уводит.
export const CORR_STAB = 0.5;

// 5. Сепаратизм. Это ДОБАВКА к тому, что empire.js уже копит от несчастья города:
// там растёт от бедности, здесь — от того, что столица далеко и слаба.
export const SEPAR_PER_DAY = 0.35;    // максимум прироста от одной лишь дальности
export const STAB_HOLD = 55;          // выше этой стабильности власть отнимает смуту
export const HOLD_PER_DAY = 0.5;      // сколько смуты в день снимает крепкая власть
export const PANIC_SEPAR = 0.4;       // сколько добавляет разваливающаяся столица
export const GARRISON_FULL = 60;      // армия, при которой гарнизоны работают в полную силу
export const GARRISON_HOLD = 0.5;     // и снимают половину давления дальности
export const UNREST_STEP_MAX = 0.6;   // потолок шага в обе стороны за сутки

// 6. Требование автономии. Порог ниже UNREST_WARN (6) из empire.js: держава
// обязана услышать провинцию РАНЬШЕ, чем модуль городов скажет «зреет сепаратизм».
export const AUTONOMY_UNREST = 4;
export const DEMAND_COOLDOWN = 25;    // повторный ультиматум не чаще раза в 25 дней
export const DEMAND_STAB = 0.15;      // висящее требование само точит трон
export const DEMAND_STAB_CAP = 0.6;
// Мятежные окраины бьют по столице: доля от предельной смуты по всем городам.
export const SEPAR_STAB = 0.6;
// Потолок дневной потери стабильности от ВСЕЙ этой связи. Без него коррупция +
// требования + мятеж складывались бы в −1.7 и не оставляли шанса выправиться.
export const STAB_FLOOR = -2;

// 7. Предупреждение. За столько дней до отпадения игрок обязан услышать и срок,
// и имя соседа, который подберёт город. Неделя — это успеть послать караван с
// едой (4 клетки в день), сменить специализацию или отвести армию.
export const WARN_ETA = 7;
export const WARN_COOLDOWN = 10;      // не повторять одно и то же каждый день

// 8. Отпадение к соседу. Дальше этого от чужого поселения город никому не
// присягает — он становится вольным.
export const DEFECT_RANGE = 42;
export const DEFECT_P_PER_POP = 1;    // население города → поле P соседа (см. civ_ai.js)
export const DEFECT_P_CAP = 20;       // но не больше, чем даёт крупная колония
export const DEFECT_REL_TAKER = -25;  // принял наших мятежников
export const DEFECT_REL_OTHERS = -6;  // державу, потерявшую провинцию, уважают меньше
export const DEFECT_STAB_SHOCK = -10;
export const FREE_CITY_STAB_SHOCK = -6;   // вольный город — позор тише, но позор
export const DEFECT_SHOCK_CAP = -20;      // два города за день не валят державу вдвое
export const DEFECT_SHOCK_DAYS = 10;      // столько дней держится траур
export const DEFECT_HAPPY = 5;            // и настолько давит на счастье в первый день

// ───────────────────────── Память связи ─────────────────────────
// Живёт в sim.linkTerritory, но пишется только через возвращаемый flags.memory:
// сам модуль её не трогает.

export function createTerritoryMemory() {
  return {
    v: 1,
    day: -1,          // защита от двойного применения в одни сутки
    stage: 'ok',      // 'ok' | 'thin' | 'torn' — ступень растяжки, для событий
    shock: 0,         // дней траура по потерянному городу
    happyMod: 0,      // последняя поправка к счастью — её читает happiness()
    popCap: 0,        // последняя прибавка к потолку населения — её читает housingCap()
    defections: 0,
    // Снимок городов: положение нужно ПОСЛЕ отпадения (empire.js город уже удалил),
    // а дни предупреждений — чтобы не повторять одно и то же каждые сутки.
    cities: {},       // id -> { x, y, warnDay, demandDay }
  };
}

export function restoreTerritoryMemory(data) {
  const m = createTerritoryMemory();
  if (!data || typeof data !== 'object') return m;
  m.day = num(data.day, -1);
  m.stage = ['ok', 'thin', 'torn'].includes(data.stage) ? data.stage : 'ok';
  m.shock = clamp(num(data.shock, 0), 0, DEFECT_SHOCK_DAYS);
  m.happyMod = num(data.happyMod, 0);
  m.popCap = clamp(num(data.popCap, 0), 0, POP_CAP_MAX);
  m.defections = Math.max(0, num(data.defections, 0));
  const src = data.cities;
  if (src && typeof src === 'object') {
    for (const [id, c] of Object.entries(src)) {
      if (!c || typeof c !== 'object') continue;
      m.cities[id] = {
        x: num(c.x, 0), y: num(c.y, 0),
        warnDay: num(c.warnDay, -999), demandDay: num(c.demandDay, -999),
      };
    }
  }
  return m;
}

// ───────────────────────── Чтение мира ─────────────────────────
// Единственное место, где ядро переводится на язык этой связи. Всё остальное
// считает по нормализованным числам и про устройство sim не знает.

export function territoryState(sim) {
  const world = (sim && sim.world) || null;
  const capX = num(world && world.startX, 0);
  const capY = num(world && world.startY, 0);
  const day = Math.round(num(sim && sim.day, 0));

  // Дороги: тот самый класс, которым ездят торговые караваны. Второй таблицы
  // дорог в игре быть не должно, поэтому берём готовую функцию production.js.
  const cls = routeClass({ techs: sim && sim.techs, buildings: (sim && sim.buildings) || [] });
  const roadIdx = Math.max(0, ROAD_CLASSES.findIndex(c => c.id === cls.id));
  const roadEase = ROAD_CLASSES.length > 1 ? roadIdx / (ROAD_CLASSES.length - 1) : 0;

  const pol = (sim && sim.politics && sim.politics.state) || null;
  const gov = pol ? String(pol.gov || 'chiefdom') : 'chiefdom';
  const stability = pol ? clamp(num(pol.stability, 60), 0, 100) : 60;
  // Множитель смуты — уже существующий рычаг politics.js: строй, правитель,
  // доктрины, смута и злые сословия. Своей копии этого расчёта здесь нет.
  const govUnrest = pol ? clamp(politicsMult(pol, 'unrest'), 0.5, 2) : 1;
  const govReach = GOV_REACH[gov] != null ? GOV_REACH[gov] : 1;

  const reachFree = REACH_FREE * govReach * (1 + ROAD_REACH_GAIN * roadEase);

  // Территория. Один проход по карте владельцев (96×96 = 9216 клеток): считаем
  // и площадь, и среднюю удалённость своей земли от столицы. Средняя, а не
  // максимальная: одна далёкая клетка не должна объявлять державу расползшейся.
  const borders = (sim && sim.sys && sim.sys.borders) || null;
  let tiles = 0, reach = 0, farTiles = 0;
  if (borders && borders.owners && borders.w) {
    const W = borders.w, H = borders.h, owners = borders.owners;
    let sum = 0;
    for (let y = 0; y < H; y++) {
      const dy = y - capY, dy2 = dy * dy, row = y * W;
      for (let x = 0; x < W; x++) {
        if (owners[row + x] !== OWNER_PLAYER) continue;
        const dx = x - capX;
        const d = Math.sqrt(dx * dx + dy2);
        tiles++; sum += d;
        if (d > reachFree) farTiles++;
      }
    }
    reach = tiles > 0 ? sum / tiles : 0;
  } else if (borders) {
    tiles = territoryTiles(borders, 'player');
  }

  const stretch = clamp((reach - reachFree) / STRETCH_SPAN, 0, 1);

  // Города. Коррупцию и множители производства считает empire.js своими же
  // функциями — второй формулы коррупции в игре не существует.
  const ectx = { day, world, capitalX: capX, capitalY: capY, techs: sim && sim.techs };
  const cities = [];
  let corrWeight = 0, corrSum = 0, lostGold = 0, unrestSum = 0;
  const st = (sim && sim.empire && sim.empire.state) || null;
  for (const c of (st && Array.isArray(st.cities) ? st.cities : [])) {
    const dist = Math.hypot(num(c.x, 0) - capX, num(c.y, 0) - capY);
    const corr = corruption(dist, ectx);
    const happy = clamp(num(c.happy, 50), 0, 100);
    const pop = Math.max(0, num(c.pop, 0));
    // Столько золота в день оседает у наместника. Формула — та же, что в
    // tickEmpire: это показ уже происходящего, а не второй расчёт дани.
    const nominal = pop * PROD_PER_POP.gold * prodMult(c, 'gold') * (happy < 35 ? 0.7 : 1);
    const unrest = Math.max(0, num(c.unrest, 0));
    cities.push({
      id: c.id, name: c.name || 'Безымянск', x: num(c.x, 0), y: num(c.y, 0),
      pop, spec: c.spec || null, happy, unrest, dist, corr, lost: nominal * corr,
    });
    corrWeight += Math.max(1, pop);
    corrSum += corr * Math.max(1, pop);
    lostGold += nominal * corr;
    unrestSum += unrest;
  }
  // Средняя коррупция — взвешенная по населению: хутор в глуши не должен
  // объявлять всю державу разворованной.
  const corrAvg = corrWeight > 0 ? corrSum / corrWeight : 0;
  const corrPress = clamp(corrAvg / CORR_MAX, 0, 1);
  // Мёртвая зона: ближняя колония не считается воровством.
  const corrBite = clamp((corrPress - CORR_FREE_PRESS) / (1 - CORR_FREE_PRESS), 0, 1);

  // Отпавшие сегодня. Их берём из отчёта empire.js: списком cities они уже
  // не значатся — модуль городов удалил их сам, и второго удаления быть не должно.
  const rep = (sim && sim.empire && sim.empire.lastReport) || null;
  const revoltedToday = (rep && rep.day === day && Array.isArray(rep.revolted)) ? rep.revolted : [];

  return {
    day, capX, capY, tiles, reach: round2(reach), farTiles, stretch: round3(stretch),
    reachFree: round2(reachFree), roadEase, roadRu: cls.ru, gov, govReach, govUnrest,
    stability, armyPower: Math.max(0, num(sim && typeof sim.armyPower === 'function' ? sim.armyPower() : 0, 0)),
    cities, corrAvg: round3(corrAvg), corrPress: round3(corrPress), corrBite: round3(corrBite),
    lostGold: round2(lostGold), unrestSum: round2(unrestSum),
    revoltedToday,
    factions: aliveFactions(sim),
  };
}

// ───────────────────────── Производные величины ─────────────────────────

// Множитель земельного налога. Возвращается ОТДЕЛЬНОЙ функцией, потому что налог
// начисляется в начале суток (tickBordersFor), а связь считается в конце.
export function territoryLandTaxMult(sim) {
  return landTaxMultOf(territoryState(sim));
}

function landTaxMultOf(s) {
  // Растяжка съедает сбор: подати до казны везут те же наместники. Потолок —
  // единица: связь не может сделать землю доходнее номинала.
  return round3(clamp(1 - STRETCH_TAX * s.stretch, LAND_TAX_MIN, 1));
}

function popCapOf(s) {
  return Math.min(POP_CAP_MAX, Math.floor(s.tiles / TILES_PER_HEAD));
}

// Прибавка к потолку населения от площади. Читает память, а не считает заново:
// housingCap() зовётся десятки раз за кадр, и проход по карте там недопустим.
export function territoryPopCap(sim) {
  const m = sim && sim.linkTerritory;
  return m ? clamp(Math.round(num(m.popCap, 0)), 0, POP_CAP_MAX) : 0;
}

// Плоская добавка к счастью — траур по потерянному городу, затухающий за
// DEFECT_SHOCK_DAYS. Тоже из памяти: happiness() вызывается очень часто.
export function territoryHappyMod(sim) {
  const m = sim && sim.linkTerritory;
  return m ? Math.round(num(m.happyMod, 0)) : 0;
}

// Через сколько дней город отложится при нынешнем ходе дел. Складывает СВОЙ
// прирост смуты (формула tickEmpire) с добавкой этой связи — иначе предупреждение
// врало бы ровно на величину связи.
export function secessionEta(city, s) {
  const own = ownUnrestGrow(city);
  const link = cityUnrestDelta(city, s);
  const total = own + link;
  if (total <= 0.001) return null;
  return Math.max(1, Math.ceil((UNREST_REVOLT - city.unrest) / total));
}

// Собственный прирост смуты в empire.js: от бедности города и его дальности.
function ownUnrestGrow(city) {
  if (city.happy >= UNREST_HAPPY) return -(city.spec === 'military' ? 2 : 1);
  let grow = ((UNREST_HAPPY - city.happy) / UNREST_HAPPY) * (0.5 + city.dist / 40);
  if (city.spec === 'military') grow *= 0.5;
  return grow;
}

// Добавка ЭТОЙ связи: дальность против крепости центральной власти и гарнизонов.
function cityUnrestDelta(city, s) {
  const over = Math.max(0, city.dist - s.reachFree);
  const distPress = clamp(over / STRETCH_SPAN, 0, 1);
  const garrison = clamp(s.armyPower / GARRISON_FULL, 0, 1);
  const grow = SEPAR_PER_DAY * distPress * (1 - GARRISON_HOLD * garrison);
  // Крепость центра: выше STAB_HOLD власть смуту отнимает, ниже — сама её родит.
  const central = (s.stability - STAB_HOLD) / (100 - STAB_HOLD);
  const panic = central < 0 ? PANIC_SEPAR * Math.min(1, -central) : 0;
  const hold = central > 0 ? HOLD_PER_DAY * central : 0;
  // Строй множит только давление: имперская администрация гасит смуту, но
  // республиканская вольница не мешает столице помогать провинции.
  const d = (grow + panic) * s.govUnrest - hold;
  return round2(clamp(d, -UNREST_STEP_MAX, UNREST_STEP_MAX));
}

// Кто подберёт отпавший город: ближайший живой сосед в пределах DEFECT_RANGE.
// Никакого броска — игрок обязан видеть имя заранее.
export function nearestNeighbour(s, x, y) {
  let best = null, bestD = Infinity;
  for (const f of s.factions) {
    for (const st of f.settlements) {
      const d = Math.hypot(st.x - x, st.y - y);
      if (d < bestD) { bestD = d; best = { fid: f.id, name: f.name, dist: round2(d) }; }
    }
  }
  return best && bestD <= DEFECT_RANGE ? best : null;
}

// ───────────────────────── Разбор для игрока ─────────────────────────
// Отдельные функции: HUD зовёт их каждый кадр, память они не двигают и ничего
// не решают — только объясняют словами, что и почему происходит.

export function territoryBreakdown(sim) {
  const s = territoryState(sim);
  const parts = stabParts(s, readMemory(sim));
  const rows = breakdownRows(s, parts);
  return {
    rows,
    total: round2(parts.total),
    tiles: s.tiles,
    reach: s.reach,
    reachFree: s.reachFree,
    stretch: s.stretch,
    landTaxMult: landTaxMultOf(s),
    popCap: popCapOf(s),
    corruptionLoss: s.lostGold,
    road: s.roadRu,
    text: rows.length
      ? `Стабильность ${parts.total >= 0 ? '+' : ''}${f1(parts.total)}/день: `
        + rows.map(r => `${r.ru} (${r.v > 0 ? '+' : ''}${f1(r.v)})`).join(', ')
      : 'Держава собрана: расстояние и наместники на порядок не давят.',
  };
}

// Главное «предупреждение заранее»: список городов, которые держава может
// потерять, со сроком, именем соседа-получателя и тем, что с этим делать.
export function territoryWatch(sim) {
  const s = territoryState(sim);
  return watchOf(s);
}

function watchOf(s) {
  const out = [];
  for (const c of s.cities) {
    const eta = secessionEta(c, s);
    if (eta === null) continue;
    const taker = nearestNeighbour(s, c.x, c.y);
    out.push({
      id: c.id, name: c.name, dist: Math.round(c.dist), unrest: round2(c.unrest),
      eta, taker: taker ? taker.name : null, takerFid: taker ? taker.fid : null,
      advice: adviceFor(c, s),
    });
  }
  out.sort((a, b) => a.eta - b.eta);
  return out;
}

// Совет — только про уже существующие в игре рычаги. Выдумывать игроку кнопки,
// которых нет, хуже, чем молчать.
function adviceFor(city, s) {
  const tips = [];
  if (city.spec !== 'military') tips.push('военная специализация вдвое гасит смуту');
  if (s.armyPower < GARRISON_FULL) tips.push(`армия до ${GARRISON_FULL} очков ставит гарнизоны (сейчас ${Math.round(s.armyPower)})`);
  if (s.stability < STAB_HOLD) tips.push(`стабильность выше ${STAB_HOLD} сама отнимает смуту (сейчас ${Math.round(s.stability)})`);
  if (s.roadEase < 1) tips.push(`дороги приближают окраины (сейчас ${s.roadRu})`);
  if (city.happy < UNREST_HAPPY) tips.push('караван с едой и трактир поднимут настроение города');
  return tips;
}

// ───────────────────────── Главная связь ─────────────────────────

export function territoryLinks(sim) {
  const s = territoryState(sim);
  const prev = readMemory(sim);
  const mem = { ...prev, cities: {} };
  const events = [];

  // Двойной вызов в одни сутки не должен ни второй раз отдать город соседу, ни
  // повторить ультиматум. Ядро зовёт раз в день, но консоль и отладка умеют
  // дёргать onNewDay повторно — так же защищается winter.js.
  const sameDay = prev.day === s.day;
  if (!sameDay) {
    mem.day = s.day;
    mem.shock = Math.max(0, num(prev.shock, 0) - 1);
  }

  const parts = stabParts(s, prev);
  const mods = {
    happy: 0,
    stability: round2(parts.total),
    stabilityShock: 0,
    landTaxMult: landTaxMultOf(s),
    popCap: popCapOf(s),
    estates: estateShifts(s),
    cityUnrest: {},          // id -> сдвиг смуты
    relations: {},           // fid -> сдвиг отношения к игроку
  };

  const flags = {
    tiles: s.tiles, reach: s.reach, reachFree: s.reachFree, stretch: s.stretch,
    stage: stageOf(s.stretch), road: s.roadRu, gov: s.gov,
    corruptionLoss: s.lostGold,
    demands: [], watch: watchOf(s), defected: [],
    reasons: breakdownRows(s, parts),
    memory: mem,
  };

  // ── Сепаратизм по городам. Сдвиг ноль на спокойном городе: при unrest = 0
  // «отрицательная смута» ничего не значит и в отчёт не попадает.
  for (const c of s.cities) {
    const prevC = (prev.cities && prev.cities[c.id]) || {};
    const memC = {
      x: c.x, y: c.y,
      warnDay: num(prevC.warnDay, -999),
      demandDay: num(prevC.demandDay, -999),
    };
    const d = cityUnrestDelta(c, s);
    if (d !== 0 && !(d < 0 && c.unrest <= 0)) mods.cityUnrest[c.id] = d;

    // Требование автономии. Порог ниже, чем «зреет сепаратизм» в empire.js:
    // сперва провинция торгуется, и только потом уходит.
    if (!sameDay && c.unrest >= AUTONOMY_UNREST && s.day - memC.demandDay >= DEMAND_COOLDOWN) {
      memC.demandDay = s.day;
      const taker = nearestNeighbour(s, c.x, c.y);
      flags.demands.push({ id: c.id, name: c.name, dist: Math.round(c.dist), unrest: round2(c.unrest) });
      events.push({
        text: `⚖ ${c.name} требует автономии: ${Math.round(c.dist)} клеток до столицы, `
          + `${Math.round(c.corr * 100)}% дани оседает у наместника`
          + (taker ? `, а ${taker.name} рядом — в ${Math.round(taker.dist)} клетках.` : '.'),
        type: 'warn',
      });
    }

    // Раннее предупреждение о потере: срок и имя того, кто подберёт город.
    if (!sameDay) {
      const eta = secessionEta(c, s);
      if (eta !== null && eta <= WARN_ETA && s.day - memC.warnDay >= WARN_COOLDOWN) {
        memC.warnDay = s.day;
        const taker = nearestNeighbour(s, c.x, c.y);
        const tips = adviceFor(c, s);
        events.push({
          text: `⚠ ${c.name} отложится примерно через ${eta} ${plural(eta, 'день', 'дня', 'дней')}`
            + (taker ? ` и присягнёт ${taker.name}.` : ' и станет вольным городом.')
            + (tips.length ? ` Что делать: ${tips.join(', ')}.` : ''),
          type: 'bad',
        });
      }
    }
    mem.cities[c.id] = memC;
  }

  // ── Отпадение. Город уже удалён модулем городов; здесь решается, чей он
  // теперь. Положение берём из вчерашнего снимка памяти — в списке городов
  // его больше нет.
  if (!sameDay && s.revoltedToday.length) {
    let shock = 0;
    for (const r of s.revoltedToday) {
      const known = (prev.cities && prev.cities[r.id]) || null;
      const x = known ? known.x : s.capX, y = known ? known.y : s.capY;
      const pop = Math.max(0, num(r.pop, 0));
      const taker = known ? nearestNeighbour(s, x, y) : null;
      const gained = Math.min(DEFECT_P_CAP, pop * DEFECT_P_PER_POP);
      flags.defected.push({
        id: r.id, name: r.name || 'город', pop, x, y,
        fid: taker ? taker.fid : null, factionName: taker ? taker.name : null,
        gainP: round2(gained), dist: Math.round(Math.hypot(x - s.capX, y - s.capY)),
      });
      shock += taker ? DEFECT_STAB_SHOCK : FREE_CITY_STAB_SHOCK;
      mem.defections++;
      mem.shock = DEFECT_SHOCK_DAYS;
      delete mem.cities[r.id];

      if (taker) {
        // Принявший мятежников — враг вдвойне. Остальные не радуются: державу,
        // которая не удержала свою провинцию, перестают принимать всерьёз.
        mods.relations[taker.fid] = (mods.relations[taker.fid] || 0) + DEFECT_REL_TAKER;
        for (const f of s.factions) {
          if (f.id === taker.fid) continue;
          mods.relations[f.id] = (mods.relations[f.id] || 0) + DEFECT_REL_OTHERS;
        }
        events.push({
          text: `🏴 ${r.name} присягнул ${taker.name}: ${pop} ${plural(pop, 'житель', 'жителя', 'жителей')} `
            + `и земли ушли соседу. Остальные соседи это запомнили.`,
          type: 'bad',
        });
      } else {
        for (const f of s.factions) {
          mods.relations[f.id] = (mods.relations[f.id] || 0) + DEFECT_REL_OTHERS;
        }
        events.push({
          text: `🏴 ${r.name} объявил себя вольным городом: соседей рядом нет, но и власти столицы больше нет.`,
          type: 'bad',
        });
      }
    }
    mods.stabilityShock = Math.max(DEFECT_SHOCK_CAP, shock);
  }

  // Траур по потерянному городу: затухает за DEFECT_SHOCK_DAYS, потолок —
  // DEFECT_HAPPY. Держава не может уйти в вечный минус по счастью.
  mods.happy = mem.shock > 0 ? -Math.round(DEFECT_HAPPY * mem.shock / DEFECT_SHOCK_DAYS) : 0;

  // ── Смена ступени растяжки: причина называется словами ровно тогда, когда
  // меняется, а не каждый день одной и той же строкой.
  if (!sameDay && flags.stage !== prev.stage) {
    mem.stage = flags.stage;
    if (flags.stage === 'torn') {
      events.push({
        text: `‼ Держава расползлась: своя земля лежит в среднем в ${Math.round(s.reach)} клетках от столицы `
          + `(рука ${s.roadRu.toLowerCase()} и ${govRu(s.gov)} достаёт до ${Math.round(s.reachFree)}). `
          + `До казны доходит ${Math.round(landTaxMultOf(s) * 100)}% земельных податей.`,
        type: 'bad',
      });
    } else if (flags.stage === 'thin') {
      events.push({
        text: `⚠ Держава растянута: ${s.farTiles} ${plural(s.farTiles, 'клетка лежит', 'клетки лежат', 'клеток лежат')} `
          + `дальше ${Math.round(s.reachFree)} — до них воля столицы доходит с потерями. Дороги и реформа их приблизят.`,
        type: 'warn',
      });
    } else {
      events.push({ text: 'Держава снова собрана в кулак: окраины больше не тянут казну.', type: 'good' });
    }
  } else if (!sameDay) {
    mem.stage = flags.stage;
  }

  mem.happyMod = mods.happy;
  mem.popCap = mods.popCap;
  return { mods, events, flags };
}

// ───────────────────────── Внутреннее ─────────────────────────

// Слагаемые дневной поправки к стабильности. Вынесены отдельно: их читают трое —
// сама связь, разбор для HUD и текст события.
function stabParts(s, mem) {
  const out = { corr: 0, separ: 0, demands: 0, raw: 0, total: 0 };

  // Воровство наместников подтачивает веру в державу — но только сверх мёртвой
  // зоны: ближняя колония с 10% коррупции никого не возмущает.
  if (s.corrBite > 0) out.corr = -CORR_STAB * s.corrBite;

  // Мятежные окраины: доля от предельной смуты по всем городам сразу.
  if (s.cities.length && s.unrestSum > 0) {
    const press = clamp(s.unrestSum / (s.cities.length * UNREST_REVOLT), 0, 1);
    out.separ = -SEPAR_STAB * press;
  }

  // Висящее требование автономии: трон торгуется с провинцией, и это видно всем.
  const demanding = s.cities.filter(c => c.unrest >= AUTONOMY_UNREST).length;
  if (demanding > 0) out.demands = -Math.min(DEMAND_STAB_CAP, DEMAND_STAB * demanding);

  out.raw = out.corr + out.separ + out.demands;
  out.total = Math.max(STAB_FLOOR, out.raw);
  return out;
}

function estateShifts(s) {
  const out = {};
  for (const fid of Object.keys(SOCIAL_FACTIONS)) {
    const d = (CORR_ESTATE[fid] || 0) * s.corrBite;
    const capped = clamp(d, -ESTATE_STEP_CAP, ESTATE_STEP_CAP);
    out[fid] = Math.abs(capped) < 0.01 ? 0 : round2(capped);
  }
  return out;
}

function breakdownRows(s, parts) {
  const rows = [];
  if (parts.corr < 0) {
    rows.push({ ru: `Наместники крадут ${Math.round(s.corrAvg * 100)}% дани (${f1(s.lostGold)}🪙/день)`, v: round2(parts.corr) });
  }
  if (parts.separ < 0) rows.push({ ru: `Смута в провинциях: ${f1(s.unrestSum)} из ${s.cities.length * UNREST_REVOLT}`, v: round2(parts.separ) });
  if (parts.demands < 0) {
    const n = s.cities.filter(c => c.unrest >= AUTONOMY_UNREST).length;
    rows.push({ ru: `Требования автономии: ${n} ${plural(n, 'город', 'города', 'городов')}`, v: round2(parts.demands) });
  }
  // Сработавший потолок показываем строкой, а не прячем: игрок должен видеть,
  // что держава уже на пределе и хуже за сутки не станет.
  if (parts.raw < STAB_FLOOR) {
    rows.push({ ru: 'Предел: глубже за сутки не проседает', v: round2(STAB_FLOOR - parts.raw) });
  }
  return rows;
}

// Ступень растяжки. Пороги подобраны так, чтобы 'thin' успевал прозвучать
// раньше, чем потери земельного налога станут заметны на глаз.
function stageOf(stretch) {
  if (stretch >= 0.6) return 'torn';
  if (stretch >= 0.15) return 'thin';
  return 'ok';
}

function aliveFactions(sim) {
  const list = (sim && sim.factions) || [];
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const f of list) {
    if (!f || f.alive === false) continue;
    const settlements = Array.isArray(f.settlements) ? f.settlements.filter(s => s && Number.isFinite(s.x)) : [];
    if (!settlements.length) continue;
    out.push({ id: f.id, name: (f.def && f.def.name) || f.name || f.id, settlements });
  }
  return out;
}

function govRu(gov) {
  const map = {
    chiefdom: 'вождество', monarchy: 'монархия', republic: 'республика',
    empire: 'империя', federation: 'федерация',
  };
  return map[gov] || gov;
}

function readMemory(sim) {
  const m = sim && sim.linkTerritory;
  if (!m || typeof m !== 'object') return createTerritoryMemory();
  return { ...createTerritoryMemory(), ...m, cities: { ...(m.cities || {}) } };
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function num(v, def) { return Number.isFinite(v) ? v : def; }
function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function f1(v) { return (Math.round(v * 10) / 10).toFixed(1); }

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/* ПОДКЛЮЧЕНИЕ ─────────────────────────────────────────────────────────────────

Все правки — в app/src/core/systems/integrate.js, кроме шага 7 (одна строка в
simulation.js, необязательная). Каждый якорь встречается в своём файле ровно один
раз — проверено grep-ом на текущем состоянии ветки.

1) ИМПОРТ. Якорь (последняя строка блока импортов integrate.js):

     import * as EMP from './wire_empire.js';

   ДОБАВИТЬ строкой ниже:

     import * as TER from './link_territory.js';

2) УСТАНОВКА. Якорь в installSystems():

     sim.sys.borderStats = null;

   ДОБАВИТЬ строкой ниже:

     // Память связи «территория → отпадение»: снимок городов, дни ультиматумов,
     // затухающий траур по потерянной провинции.
     sim.linkTerritory = TER.createTerritoryMemory();

3) ЗЕМЕЛЬНЫЙ НАЛОГ. Якорь в tickBordersFor():

     if (tax > 0) sim.res.gold += tax * sim.globalMult('gold');

   ЗАМЕНИТЬ на:

     // Растянутая держава довозит до казны не всё: разницу съедают кормления
     // сборщиков. Множитель считается по вчерашнему состоянию — налог начисляется
     // в начале суток, а связь считается в конце (расхождение меньше суток).
     if (tax > 0) sim.res.gold += tax * sim.globalMult('gold') * TER.territoryLandTaxMult(sim);

4) ДЕНЬ. Якорь — строка в systemsNewDay():

     EMP.empireNewDay(sim);

   ДОБАВИТЬ следом (если рядом уже стоит applySurvivalLinks(sim) из link_survival —
   ставить ПОСЛЕ него: тот может снять город, и его потерю тоже надо разыграть).
   Место именно здесь: города уже прожили день, отчёт empire.lastReport заполнен,
   и связь читает сложившиеся сутки, а не вчерашние.

     applyTerritoryLinks(sim);

   И ДОБАВИТЬ саму функцию в конец файла:

     // Связь «территория → расстояние → коррупция → отпадение». Модуль только
     // считает; всё, что меняет мир, делается здесь.
     function applyTerritoryLinks(sim) {
       if (!sim.linkTerritory) sim.linkTerritory = TER.createTerritoryMemory();
       const out = TER.territoryLinks(sim);
       sim.linkTerritory = out.flags.memory;

       const pst = sim.politics && sim.politics.state;
       if (pst) {
         const dS = out.mods.stability + out.mods.stabilityShock;
         pst.stability = Math.max(0, Math.min(100, pst.stability + dS));
         for (const [fid, d] of Object.entries(out.mods.estates)) {
           if (!d || pst.factions[fid] == null) continue;
           pst.factions[fid] = Math.max(0, Math.min(100, pst.factions[fid] + d));
         }
       }

       // Сепаратизм по городам. Потолок 12 — тот же, что в empire.js
       // (UNREST_REVOLT + 2): выше него смута не копится ни от чего.
       if (sim.empire) {
         for (const c of sim.empire.state.cities) {
           const d = out.mods.cityUnrest[c.id];
           if (d) c.unrest = Math.max(0, Math.min(12, (c.unrest || 0) + d));
         }
       }

       // Отпавший город достаётся соседу: у него прибавляется поселение и
       // население. Поля фракции ведёт ядро и civ_ai.js — пишем ровно те же.
       for (const g of out.flags.defected) {
         sim.addChronicle(g.factionName
           ? `${g.name} присягнул ${g.factionName} (день ${sim.day}).`
           : `${g.name} объявил себя вольным городом (день ${sim.day}).`);
         if (!g.fid) continue;
         const f = sim.faction(g.fid);
         if (!f) continue;
         f.P = (f.P || 0) + g.gainP;
         f.settlements.push({ x: g.x, y: g.y });
       }

       // Отношения: принявшему мятежников — вдвойне, остальным — за слабость.
       for (const [fid, d] of Object.entries(out.mods.relations)) {
         if (d) sim.adjustRel(fid, d, 'Отпадение города');
       }

       if (out.flags.defected.length) {
         sim.sfx?.('alarm');
         if (typeof sim.toast === 'function') sim.toast('Провинция вышла из-под руки столицы!', 'bad');
       }
       for (const e of out.events) sim.addLog(e.text, e.type);
       return out;
     }

5) СЧАСТЬЕ. Якорь — тело systemsHappyMod():

     return W.happyMod(sim.sys.winter) + IND.industryHappyMod(sim) + POL.politicsHappyMod(sim);

   ЗАМЕНИТЬ на (если строку уже правил link_survival — просто дописать слагаемое
   TER.territoryHappyMod(sim) к тому, что там получилось):

     return W.happyMod(sim.sys.winter) + IND.industryHappyMod(sim) + POL.politicsHappyMod(sim)
       + TER.territoryHappyMod(sim);

6) СЕЙВ. Якорь в systemsSerialize():

     emp: EMP.empireSerialize(sim),

   ДОБАВИТЬ строкой ниже:

     terr: sim.linkTerritory || null,

   Якорь в systemsRestore():

     if (data.emp) EMP.empireRestore(sim, data.emp);

   ДОБАВИТЬ строкой ниже:

     sim.linkTerritory = TER.restoreTerritoryMemory(data.terr);

   Старые сейвы без поля грузятся: вернётся пустая память, снимок городов
   восстановится в первый же день.

7) ПОТОЛОК НАСЕЛЕНИЯ ОТ ПЛОЩАДИ (одна строка в app/src/core/simulation.js).
   Без этого шага работает всё остальное — просто земля не даёт где жить.
   Сперва в integrate.js ДОБАВИТЬ экспорт рядом с systemsWorkMult():

     // Своя земля даёт где ставить выселки: площадь границ поднимает потолок
     // населения. Читается из памяти связи — проход по карте в housingCap() недопустим.
     export function systemsPopCapMod(sim) {
       return sim.linkTerritory ? TER.territoryPopCap(sim) : 0;
     }

   Затем в simulation.js ЯКОРЬ (единственная такая строка в файле):

     for (const b of this.doneBuildings()) cap += BUILDINGS[b.id].housing || 0;

   ДОБАВИТЬ строкой ниже:

     cap += systemsPopCapMod(this);

   и дописать systemsPopCapMod в существующий импорт из './systems/integrate.js'.

8) НЕОБЯЗАТЕЛЬНО, но ради этого всё и делалось — строки для HUD. Обе функции
   память НЕ двигают, звать их из рендера безопасно:

     TER.territoryBreakdown(sim).text   // «Стабильность −0.8/день: Наместники крадут 31% дани …»
     TER.territoryBreakdown(sim).rows   // [{ru, v}] — если нужен список
     TER.territoryWatch(sim)            // [{name, dist, unrest, eta, taker, advice}] —
                                        // готовая панель «что мы вот-вот потеряем»

   Именно territoryWatch закрывает требование «предупреждать заранее»: он
   возвращает срок отпадения и имя соседа ещё до того, как смута дойдёт до порога.

────────────────────────────────────────────────────────────────────────────── */
