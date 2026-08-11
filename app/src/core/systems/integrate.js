// core/systems/integrate.js — слой подключения модулей к ядру.
//
// Зачем отдельный файл: модули писались независимо и каждый ждёт свой ctx.
// Если раскидать сборку этих ctx по simulation.js, ядро превратится в свалку
// переходников. Здесь ядро видит четыре функции, а вся склейка — тут.
//
// Правило: модуль НИКОГДА не трогает sim напрямую. Он получает данные, возвращает
// отчёт, а применяет отчёт к миру этот файл. Так модуль остаётся тестируемым
// в одиночку, а ядро — не зависящим от внутренностей модуля.
import { BUILDINGS, DAYS_PER_SEASON } from '../data.js';
import * as W from './winter.js';
import * as B from './borders.js';
import * as C from './civ_ai.js';
import * as POP from './wire_population.js';
import * as IND from './wire_production.js';
import * as WAR from './wire_army.js';
import * as POL from './wire_politics.js';
import * as EMP from './wire_empire.js';
// Связи между системами. Эти модули НИЧЕГО не меняют — они читают сложившийся
// день и возвращают отчёт; применяют отчёт функции applyXxxLinks в конце файла.
import * as LEC from './link_economy.js';
import * as LS from './link_survival.js';
import * as TER from './link_territory.js';
import * as LWR from './link_war.js';
import * as LIND from './link_industry.js';

// ---------- Установка ----------

export function installSystems(sim) {
  sim.sys = {
    winter: W.createWinter(),
    borders: B.createBorders(sim.world.w, sim.world.h),
    civ: C.createCivAi(sim.factions),
  };
  POP.wirePopulationInstall(sim);
  IND.installIndustry(sim);
  WAR.install(sim);
  POL.installPolitics(sim);
  EMP.installEmpire(sim);
  // Память связи войны: вчерашняя численность войска, дни войны, усталость.
  sim.linkWar = LWR.createWarMemory();
  // Память связи выживания: сколько суток подряд голодаем и когда был бунт.
  sim.linkSurvival = LS.createSurvivalMemory();
  // Последние отчёты держим для HUD: панель читает готовые числа, а не
  // пересчитывает то, что уже посчитано модулем.
  sim.sys.winterReport = null;
  sim.sys.borderStats = null;
  // Память связи хозяйства: износ, счётчик простоя, эпоха прошлых суток.
  sim.linkIndustry = LIND.createIndustryMemory();
  // Память связи «территория → отпадение»: снимок городов, дни ультиматумов,
  // затухающий траур по потерянной провинции.
  sim.linkTerritory = TER.createTerritoryMemory();
}

// ---------- Раз в сутки ----------
// Вызывается из onNewDay ПОСЛЕ расчёта еды и ДО фильтра мёртвых: зима помечает
// замёрзших hp=0, а вычищает их общий фильтр ядра — двух списков мёртвых не бывает.

export function systemsNewDay(sim) {
  if (!sim.sys) return;
  tickWinterFor(sim);
  tickBordersFor(sim);
  // Порядок важен: сперва люди (кто родился и умер), потом производство
  // (сколько рук на местах), потом война и политика — они читают уже
  // сложившееся население и склад, а не вчерашнее.
  POP.wirePopulationNewDay(sim);
  IND.industryNewDay(sim);
  WAR.onNewDay(sim);
  POL.politicsNewDay(sim);
  EMP.empireNewDay(sim);
  // Связи идут последними: они читают уже сложившийся день. Хозяйство раньше
  // выживания намеренно — налоги и долг это причина, а голод и стужа читают
  // уже пошатнувшуюся державу, а не вчерашнюю.
  applyEconomyLinks(sim);
  applySurvivalLinks(sim);
  applyIndustryLinks(sim);
  // Территория идёт ПОСЛЕ выживания: голод может снять город, и его потерю
  // тоже надо разыграть — кому он достался и как это увидели соседи.
  applyTerritoryLinks(sim);
  applyWarLinks(sim);
}

// ---------- Соседи ----------
// Вызывается из tickFactions ВМЕСТО прежней теневой экономики. Возвращает true,
// если модуль отработал — тогда ядро пропускает свой старый расчёт. Два правила
// роста фракций одновременно дали бы двойной прирост населения и две разные
// экспансии, поэтому здесь именно замена, а не добавка.
export function systemsFactions(sim) {
  if (!sim.sys || !sim.sys.civ) return false;

  const out = C.tickCivAi(sim.sys.civ, {
    day: sim.day,
    rng: sim.rng,
    world: sim.world,
    factions: sim.factions,
    relations: sim.relations,
    difficulty: sim.difficulty,
    playerWars: sim.wars.map(w => w.fid),
    player: {
      armyPower: sim.armyPower(),
      era: sim.eraIndex,
      settlements: [{ x: sim.world.startX, y: sim.world.startY }],
    },
  });

  for (const text of out.logs) sim.addLog(text);

  // Модуль решает, что сосед идёт войной, но объявляет войну ядро: только оно
  // знает про перемирия, договоры и реакцию интерфейса.
  for (const w of out.warOnPlayer) {
    const f = sim.faction(w.fid || w);
    if (f && !sim.atPeaceTreaty(f.id)) sim.declareWarOnPlayer(f);
  }
  return true;
}

// Строки для панели соседей: готовый текст, а не сырые числа.
export function civPanel(sim) {
  if (!sim.sys || !sim.sys.civ) return null;
  return C.civReport(sim.sys.civ, sim.factions);
}

function tickWinterFor(sim) {
  const s = sim.sys;
  const ctx = winterCtx(sim);
  const rep = W.tickWinter(s.winter, ctx, sim.rng);
  s.winterReport = rep;

  // Дрова сжигаются реально: это единственный расход дерева, который нельзя
  // отложить, и он и делает зиму зимой.
  if (rep.burned > 0) sim.res.wood = Math.max(0, sim.res.wood - rep.burned);

  // Имена замёрзших модуль уже положил в rep.events — своего второго списка
  // здесь быть не должно, иначе каждая смерть попадает в журнал дважды.
  if (rep.deathCount > 0) {
    sim.addChronicle(`Морозы унесли ${rep.deathCount} ${W.plural(rep.deathCount, 'жизнь', 'жизни', 'жизней')}.`);
  }
  for (const e of rep.events) sim.addLog(e.text, e.type === 'warn' ? 'bad' : e.type);
}

function winterCtx(sim) {
  return {
    day: sim.day,
    dayInSeason: sim.day % DAYS_PER_SEASON,
    seasonIdx: sim.seasonIdx,
    weather: sim.weather,
    villagers: sim.villagers,
    pop: sim.villagers.length,
    wood: sim.res.wood,
    woodPerDay: woodIncome(sim),
    housingCap: sim.housingCap(),
    buildings: sim.buildings,
    techs: sim.techs,
  };
}

// Прогноз «хватит ли дров до весны» врёт, если не знать притока. Считаем по тем
// же таблицам, что и производство: сколько дерева даст день при текущих зданиях.
function woodIncome(sim) {
  let sum = 0;
  for (const b of sim.buildings) {
    if (!b.done || b.destroyed) continue;
    const def = BUILDINGS[b.id];
    if (def && def.out && def.out.wood) sum += def.out.wood * (b.workers ? b.workers.length : 0);
  }
  return sum * sim.globalMult('wood');
}

function tickBordersFor(sim) {
  const s = sim.sys;
  const version = B.worldVersion(sim.buildings, sim.factions);
  const changed = B.updateBorders(s.borders, {
    world: sim.world, day: sim.day, version,
    buildings: sim.buildings.filter(b => b.done && !b.destroyed),
    factions: sim.factions.filter(f => f.alive),
  });
  if (changed || !s.borderStats) s.borderStats = B.territoryStats(s.borders);

  // Земельный налог: территория начинает приносить доход, а не только красить
  // карту. Это делает захват земли осмысленным до появления городов.
  const tax = B.landTaxPerDay(s.borders, 'player', { techs: sim.techs });
  // Растянутая держава довозит до казны не всё: разницу съедают кормления
  // сборщиков. Множитель считается по вчерашнему состоянию — налог начисляется
  // в начале суток, а связь считается в конце (расхождение меньше суток).
  if (tax > 0) sim.res.gold += tax * sim.globalMult('gold') * TER.territoryLandTaxMult(sim);
}

// ---------- Модификаторы, которые ядро подмешивает в свои формулы ----------

// Штраф к счастью от холода. Ядро прибавляет это в happiness().
export function systemsHappyMod(sim) {
  if (!sim.sys) return 0;
  return W.happyMod(sim.sys.winter) + IND.industryHappyMod(sim) + POL.politicsHappyMod(sim)
    + (sim.sys.ecoLinks ? sim.sys.ecoLinks.mods.happy : 0)
    + LS.survivalHappyMod(sim) + LIND.industryLinkHappyMod(sim)
    + TER.territoryHappyMod(sim)
    + (sim.sys.warLinks ? sim.sys.warLinks.mods.happy : 0);
}

// Своя земля даёт где ставить выселки: площадь границ поднимает потолок
// населения. Читается из памяти связи — проход по карте в housingCap() недопустим.
export function systemsPopCapMod(sim) {
  return sim.linkTerritory ? TER.territoryPopCap(sim) : 0;
}

// Больные не работают. Ядро умножает на это выработку.
export function systemsWorkMult(sim) {
  if (!sim.sys) return 1;
  const sick = sim.sys.winter.sick || 0;
  const pop = Math.max(1, sim.villagers.length);
  return Math.max(0.4, 1 - (sick / pop) * 0.8);
}

// ---------- Сохранение ----------

export function systemsSerialize(sim) {
  if (!sim.sys) return null;
  return {
    winter: W.serializeWinter(sim.sys.winter),
    borders: B.serializeBorders(sim.sys.borders),
    civ: C.serializeCivAi(sim.sys.civ),
    pop: POP.populationSerialize ? POP.populationSerialize(sim) : null,
    ind: IND.industrySerialize(sim),
    war: WAR.serialize(sim),
    pol: POL.politicsSerialize(sim),
    emp: EMP.empireSerialize(sim),
    link: sim.linkSurvival || null,
    linkInd: sim.linkIndustry || null,
    terr: sim.linkTerritory || null,
    linkWar: sim.linkWar || null,
  };
}

export function systemsRestore(sim, data) {
  if (!sim.sys || !data) return;
  if (data.winter) sim.sys.winter = W.deserializeWinter(data.winter);
  if (data.borders) sim.sys.borders = B.deserializeBorders(data.borders);
  if (data.civ) sim.sys.civ = C.deserializeCivAi(data.civ, sim.factions);
  if (data.pop && POP.populationRestore) POP.populationRestore(sim, data.pop);
  if (data.ind) IND.industryRestore(sim, data.ind);
  if (data.war) WAR.restore(sim, data.war);
  if (data.pol) POL.politicsRestore(sim, data.pol);
  if (data.emp) EMP.empireRestore(sim, data.emp);
  sim.linkSurvival = LS.restoreSurvivalMemory(data.link);
  sim.linkIndustry = LIND.restoreIndustryMemory(data.linkInd);
  sim.linkTerritory = TER.restoreTerritoryMemory(data.terr);
  sim.linkWar = LWR.restoreWarMemory(data.linkWar);
}

// ---------- Для HUD ----------

export function winterPanel(sim) {
  if (!sim.sys) return null;
  return {
    status: W.winterStatus(sim.sys.winter, winterCtx(sim)),
    forecast: W.winterForecast(winterCtx(sim)),
    breakdown: W.demandBreakdown(winterCtx(sim)),
    history: W.winterHistory(sim.sys.winter),
    report: sim.sys.winterReport,
  };
}

export function territoryPanel(sim) {
  if (!sim.sys) return null;
  return sim.sys.borderStats;
}

// ---------- Применение связей ----------
// Модули считают, но не трогают мир. Всё, что меняет державу, — здесь.

function applyEconomyLinks(sim) {
  if (!sim.politics || !sim.industry) return null;
  const L = LEC.economyLinks(sim);
  sim.sys.ecoLinks = L;                       // для HUD: панель читает готовый разбор

  // Одобрение сословий: дневной сдвиг от налогов, долга и инфляции.
  const F = sim.politics.state.factions;
  for (const fid of Object.keys(F)) {
    F[fid] = Math.max(0, Math.min(100, F[fid] + (L.mods.approval[fid] || 0)));
  }
  // Стабильность: доверие к власти как к плательщику.
  const P = sim.politics.state;
  P.stability = Math.max(0, Math.min(100, P.stability + L.mods.stability));

  // Недобор налога: economy.js уже начислил полный сбор, здесь поправка.
  if (L.mods.gold !== 0) sim.res.gold = Math.max(0, sim.res.gold + L.mods.gold);

  // Дефолт: остальные кредиторы. Тому, кому не заплатили, отношения уронил
  // сам economy.js — второй раз его здесь нет.
  for (const c of L.flags.creditorsAlarmed) {
    if (typeof sim.adjustRel === 'function') sim.adjustRel(c.fid, c.dRel, 'Дефолт казны');
  }
  for (const e of L.events) sim.addLog(e.text, e.type === 'good' ? 'info' : e.type);
  if (L.flags.defaultToday) sim.addChronicle(`Казна объявила дефолт (день ${sim.day}).`);
  return L;
}

// Связь «цепочки ↔ люди ↔ казна ↔ наука ↔ эпоха».
function applyIndustryLinks(sim) {
  if (!sim.industry) return null;
  const L = LIND.industryLinks(sim);
  sim.linkIndustry = L.flags.memory;
  sim.sys.indLinks = L;                   // для HUD: панель читает готовый разбор

  // Обученные руки — прибавка к вчерашнему выпуску цепочек. Множитель внутрь
  // wire_production не подмешать, поэтому прибавка начисляется здесь, с тем же
  // потолком склада, что и у самих цепочек.
  for (const [r, add] of Object.entries(L.mods.output)) {
    if (!(r in sim.res) || !add) continue;
    sim.res[r] = Math.min(sim.resCap[r] ?? 99999, sim.res[r] + add);
  }

  // Недобор ремесла и разбор завала после аварии.
  if (L.mods.gold) sim.res.gold = Math.max(0, sim.res.gold + L.mods.gold);
  // Опыты подмастерьев: избыток сырья превращается в знание.
  if (L.mods.knowledge) sim.res.knowledge += L.mods.knowledge;

  const pst = sim.politics && sim.politics.state;
  if (pst) {
    pst.stability = Math.max(0, Math.min(100, pst.stability + L.mods.stability + L.mods.stabilityShock));
    for (const [fid, d] of Object.entries(L.mods.estates)) {
      if (!d || pst.factions[fid] == null) continue;
      pst.factions[fid] = Math.max(0, Math.min(100, pst.factions[fid] + d));
    }
  }

  // Авария: часть промежуточного склада пропала, пострадавшая постройка побита.
  // Долей, а не числом — плоская потеря добила бы маленькое хозяйство.
  if (L.mods.stockPct && sim.industry.prod) {
    const stock = sim.industry.prod.stock;
    for (const k of Object.keys(stock)) stock[k] = Math.max(0, stock[k] * (1 + L.mods.stockPct));
  }
  const acc = L.flags.accident;
  if (acc && acc.building) {
    const b = sim.buildings.find(x => x.id === acc.building && x.done && !x.destroyed);
    if (b) b.hp = Math.max(1, (b.hp || 100) - acc.hpLoss);
    sim.addChronicle(`Авария на производстве: ${acc.name} (день ${sim.day}).`);
    sim.sfx?.('alarm');
  }

  for (const e of L.events) sim.addLog(e.text, e.type === 'warn' ? 'bad' : e.type);
  return L;
}

// Связь «бой ↔ дух ↔ военное сословие ↔ казна ↔ армия».
function applyWarLinks(sim) {
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

// Связь «территория → расстояние → коррупция → отпадение».
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

// Связь «выживание → держава»: холод, голод и болезни доходят до трона.
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

// ---------- Экраны новых систем ----------
export const PANELS = {
  people:   { render: POP.renderPopulationPanel, bind: POP.bindPopulationPanel },
  industry: { render: IND.renderIndustryPanel,   bind: IND.bindIndustryPanel },
  war:      { render: WAR.renderPanel,           bind: WAR.bindPanel },
  politics: { render: POL.renderPoliticsPanel,   bind: POL.bindPoliticsPanel },
  empire:   { render: EMP.renderEmpirePanel,     bind: EMP.bindEmpirePanel },
};
