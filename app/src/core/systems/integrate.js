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
import * as LN from './link_neighbors.js';
import * as MEM from './link_memory.js';
import * as INT from './link_intel.js';
import * as MAS from './link_masters.js';
import * as GH from './link_ghost.js';
import * as HUNT from './link_hunt.js';
import * as LDYN from './link_dynasty.js';
import * as B2 from './build2.js';
import * as HERD from './herds.js';
import * as DYN from './dynasty.js';
import { tileAt } from '../world.js';
import { createRng } from '../rng.js';

// С какого уровня отношений война считается ударом в спину. 20 — это уже не
// «терпим друг друга», а сложившийся лад: договоры, караваны, общие войны.
const BETRAYAL_REL_WAS = 20;

// Отношения числом. Ядро держит их то простым числом, то объектом со полем v —
// читаем обе формы, чтобы связь не зависела от того, как ядро их хранит.
function relValue(sim, fid) {
  if (!sim || !sim.relations) return 0;
  const r = sim.relations[fid];
  return typeof r === 'number' ? r : (r && typeof r.v === 'number' ? r.v : 0);
}

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
  // Летопись как причина: что пережито, то меняет поведение державы.
  sim.linkMemory = MEM.createMemory();
  // Память связи «род → сословия»: насколько созрел заговор, какие удары по
  // законности уже отданы роду, когда последний раз о них говорили.
  sim.linkDynasty = LDYN.createDynastyLink();
  // Разведка: что мы знаем о соседях и когда об этом слышали в последний раз.
  sim.linkIntel = INT.createIntel();
  // Ремесло живёт в людях: у каждого промысла свой мастер и свой ученик.
  sim.linkMasters = MAS.createMasters();
  // Тень прошлой партии: слепки состояния через равные промежутки.
  sim.linkGhost = GH.createGhost();
  sim.linkGhost.seed = sim.seed | 0;
  // Связь охоты: журнал добычи за месяц, выбитые виды, прирученные стада.
  sim.linkHunt = HUNT.createHuntMemory();
  // Ядро кладёт сюда отметку в момент добычи; связь читает и забывает.
  sim.sys.huntKills = [];
  // Строительство: очередь чертежей, износ, ремонт, улучшение на месте.
  sim.build = B2.createBuild();
  // Стада: дичь возобновляема, но исчерпаема. Ставится ПОСЛЕ мира и ДО первого
  // дня — иначе первый же охотник не найдёт ни одного стада.
  // Род, а не сменный человек: у власти стоит семья с именами и наследниками.
  //
  // СВОЙ ПОТОК СЛУЧАЙНОСТИ, а не sim.rng, как просит блок подключения
  // dynasty.js. Оговорюсь честно: это ПРЕДОСТОРОЖНОСТЬ, а не пойманная
  // поломка. Я проверил обе версии — круг сохранения (simtest, «сейв v3
  // круговой») проходит и с sim.rng тоже.
  //
  // Но ровно этот приём — брать числа из главного потока при постройке мира —
  // уже ломал игру на стадах: часть состояния державы выводится прямо в
  // installSystems и в сейв не пишется, после загрузки она расходилась, и
  // круг падал на двух позициях sys.emp.sites.fog. Здесь пронесло случайно:
  // createDynasty берёт столько чисел, что до чувствительного места сдвиг не
  // дошёл. Стоит роду обзавестись лишним броском — и дойдёт.
  //
  // Отдельный поток снимает вопрос целиком и не стоит ничего. Смена трона по
  // ходу партии берёт sim.rng и дальше: там все игроки идут одним и тем же
  // днём, и сдвига не возникает.
  sim.dynasty = DYN.createDynasty(createRng((sim.seed ^ 0x44594e00) >>> 0), { day: sim.day });
  // Правитель politics.js СТАНОВИТСЯ главой рода. Это не второй правитель:
  // politics.state.ruler остаётся единственным местом, откуда ядро берёт черты
  // и множители, — просто теперь его туда кладёт род, а не createRuler().
  if (sim.politics && sim.politics.state) {
    const r0 = DYN.politicsRuler(sim.dynasty);
    if (r0) sim.politics.state.ruler = r0;
  }
  sim.herds = HERD.createHerds();
  {
    const ctx = HERD.herdsContext(sim, (world, x, y) => tileAt(world, x, y));
    // СВОЙ ПОТОК СЛУЧАЙНОСТИ, а не sim.rng. Расстановка стад — это генерация
    // мира, и она не имеет права сдвигать главный поток: всё, что создаётся
    // после неё в конструкторе, получило бы другие числа.
    //
    // Это было починкой: с sim.rng круговой сейв ломался на sys.emp.sites.fog,
    // и правка снимала симптом.
    //
    // ДОПИСАНО ПОЗЖЕ, ЧТОБЫ НЕ ВВОДИТЬ В ЗАБЛУЖДЕНИЕ: настоящая причина той
    // поломки найдена и устранена не здесь, а в wire_empire.empireRestore — он
    // после загрузки доoткрывал туман ещё раз, поверх записанного, и добавлял
    // несколько клеток сверх того, что было в исходной партии. Любой сдвиг
    // потока просто делал это заметным. Теперь записанный туман считается
    // истиной, и sim.rng здесь сейв бы уже не сломал.
    //
    // Строку всё равно оставляю: расстановка стад — это генерация мира, ей не
    // место в потоке, которым идёт партия. Свой поток от того же сида
    // оставляет расстановку воспроизводимой — один сид даёт одни и те же
    // стада, — и при этом главный поток не трогает.
    const herdRng = createRng((sim.seed ^ 0x48455244) >>> 0);   // 'HERD'
    const rep = HERD.spawnHerds(sim.herds, ctx, herdRng);
    sim.herds = rep.state;
  }
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
  // Порядок обязателен: politics считает смерть правителя первой, род читает
  // уже сложившийся день. Раньше politicsNewDay род выбрал бы наследника до
  // того, как правитель умер, и трон сменился бы на сутки раньше журнала.
  applyDynasty(sim);
  EMP.empireNewDay(sim);
  // Связи идут последними: они читают уже сложившийся день. Хозяйство раньше
  // выживания намеренно — налоги и долг это причина, а голод и стужа читают
  // уже пошатнувшуюся державу, а не вчерашнюю.
  applyEconomyLinks(sim);
  // Выше лестницы голода намеренно: связь охоты кладёт на склад мясо со
  // скота, а лестница обязана читать уже сложившийся запас, иначе пастбище
  // «сработает» только на следующие сутки.
  const huntOut = applyHuntLinks(sim);
  const survOut = applySurvivalLinks(sim);
  applyIndustryLinks(sim);
  // Мастера идут ПОСЛЕ хозяйства: они поднимают тот выпуск, который оно
  // уже посчитало, а не считают его заново.
  applyMasterLinks(sim);
  applyBuild(sim);
  applyGhost(sim);
  // Соседи читают уже сложившийся день: казну после налогов и стабильность
  // после голода. Иначе охрана границ оплачивалась бы из вчерашних денег.
  applyNeighborLinks(sim);
  // Территория идёт ПОСЛЕ выживания: голод может снять город, и его потерю
  // тоже надо разыграть — кому он достался и как это увидели соседи.
  applyTerritoryLinks(sim);
  // Разведка идёт ПОСЛЕ соседей: она читает опасность дорог, которую считает
  // именно link_neighbors. Своей второй оценки опасности быть не должно —
  // игрок читал бы в двух панелях разные числа.
  applyIntelLinks(sim);
  const warOut = applyWarLinks(sim);
  // Память идёт ПОСЛЕДНЕЙ: она записывает то, что породили остальные связи
  // за эти же сутки, и уже завтра держава живёт с оглядкой на записанное.
  // Стада считаются ДО памяти: вымирание вида — событие, которое память
  // должна записать в те же сутки.
  applyHerds(sim);
  applyMemoryLinks(sim, harvestScars(sim, { war: warOut, surv: survOut })
    .concat(HUNT.huntScars(huntOut)));
  // Род идёт ПОСЛЕ памяти намеренно: связь берёт удары по законности из уже
  // записанных за эти сутки шрамов, а не разбирает летопись во второй раз.
  // Отсюда суточная задержка: собранное сегодня applyDynasty съест завтра.
  // Она честнее альтернативы — считать беду дважды в один день из двух мест.
  applyDynastyLinks(sim);
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
    if (!f || sim.atPeaceTreaty(f.id)) continue;
    // Удар в спину — это война от того, с кем мы были в ладу. Отношения
    // смотрим ДО объявления: declareWarOnPlayer роняет их на 60, и после
    // вызова отличить друга от старого врага уже нельзя.
    const relBefore = relValue(sim, f.id);
    sim.declareWarOnPlayer(f);
    if (relBefore >= BETRAYAL_REL_WAS) {
      if (!Array.isArray(sim.sys.betrayals)) sim.sys.betrayals = [];
      sim.sys.betrayals.push({ fid: f.id, day: sim.day, rel: relBefore });
    }
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
  // Пережившие студёные зимы запасают дрова впрок и жгут скупее. Списываем
  // не отчётное число, а поправленное — иначе память была бы только словами.
  const burned = rep.burned * MEM.memoryWoodMult(sim);
  if (burned > 0) sim.res.wood = Math.max(0, sim.res.wood - burned);

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
    + (sim.sys.nbrLinks ? sim.sys.nbrLinks.mods.happy : 0)
    + MEM.memoryHappyMod(sim)
    + TER.territoryHappyMod(sim)
    + (sim.sys.warLinks ? sim.sys.warLinks.mods.happy : 0)
    + HUNT.huntHappyMod(sim);
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
    dyn: DYN.serializeDynasty(sim.dynasty),
    emp: EMP.empireSerialize(sim),
    link: sim.linkSurvival || null,
    linkInd: sim.linkIndustry || null,
    terr: sim.linkTerritory || null,
    linkWar: sim.linkWar || null,
    mem: sim.linkMemory || null,
    dynLink: LDYN.serializeDynastyLink(sim.linkDynasty),
    intel: sim.linkIntel || null,
    masters: sim.linkMasters || null,
    ghost: sim.linkGhost || null,
    hunt: sim.linkHunt || null,
    herds: HERD.serializeHerds(sim.herds),
    build: B2.serializeBuild(sim.build),
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
  // Старый сейв без поля dyn грузится: restoreDynasty(undefined) вернёт
  // пустой род, ближайший applyDynasty поднимет новый дом.
  sim.dynasty = DYN.restoreDynasty(data.dyn);
  if (data.emp) EMP.empireRestore(sim, data.emp);
  sim.linkSurvival = LS.restoreSurvivalMemory(data.link);
  sim.linkIndustry = LIND.restoreIndustryMemory(data.linkInd);
  sim.linkTerritory = TER.restoreTerritoryMemory(data.terr);
  sim.linkWar = LWR.restoreWarMemory(data.linkWar);
  sim.linkMemory = MEM.restoreMemory(data.mem);
  sim.linkDynasty = LDYN.restoreDynastyLink(data.dynLink);
  sim.linkIntel = INT.restoreIntel(data.intel);
  sim.linkMasters = MAS.restoreMasters(data.masters);
  sim.linkGhost = GH.restoreGhost(data.ghost);
  sim.linkHunt = HUNT.restoreHuntMemory(data.hunt);
  sim.herds = HERD.restoreHerds(data.herds);
  sim.build = B2.restoreBuild(data.build);
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

// ---------- Летопись как причина ----------

// Что из прожитого дня достойно памяти. Собирается ЗДЕСЬ, а не в модуле памяти:
// только этот файл видит отчёты всех связей сразу. Разбирать текст летописи
// строками было бы ошибкой — строка это то, что читает игрок, и связь ломалась
// бы от любой правки формулировки. Поэтому память получает породы событий, а не
// слова.
function harvestScars(sim, ctx) {
  const out = [];
  const day = sim.day;

  // Голод. Считаем не «мало еды», а состоявшуюся беду: похороны от голода,
  // хлебный бунт, восстание. Иначе шрам копился бы каждую тощую неделю.
  if (sim.starvedDay === day) out.push({ kind: 'famine', scale: 0.55 });
  // Выбитый вид — это не «минус зверь», а утраченный источник еды навсегда.
  const HR = sim.sys && sim.sys.herdsReport;
  if (HR && HR.flags && HR.flags.extinctNow) {
    for (let i = 0; i < HR.flags.extinctNow.length; i++) out.push({ kind: 'famine', scale: 0.8 });
  }
  const surv = ctx && ctx.surv;
  if (surv && surv.flags) {
    if (surv.flags.riot) out.push({ kind: 'famine', scale: 1.0 });
    if (surv.flags.revolt) out.push({ kind: 'famine', scale: 1.6 });
  }

  // Стужа и мор — из отчёта зимы за эти же сутки.
  const rep = sim.sys && sim.sys.winterReport;
  if (rep) {
    if (rep.deathCount > 0) out.push({ kind: 'frost', scale: Math.min(2, rep.deathCount * 0.6) });
    // Мором считаем слёгшую четверть поселения: меньшее — это простуда, а не
    // событие, которое помнят годами.
    const pop = Math.max(1, sim.villagers.length);
    const sick = (sim.sys.winter && sim.sys.winter.sick) || 0;
    if (sick / pop >= 0.25) out.push({ kind: 'plague', scale: Math.min(2, (sick / pop) / 0.25) });
  }

  // Позор: потерянная провинция. Списки ведёт empire.js, поэтому смотрим на
  // свежую запись в нём, а не на собственный счётчик.
  const emp = sim.empire && sim.empire.state;
  if (emp && Array.isArray(emp.lost)) {
    for (const l of emp.lost) if (l && l.day === day) out.push({ kind: 'shame', scale: 1 });
  }

  // Гордость: взятый город и отбитые набеги.
  const war = ctx && ctx.war;
  if (war && war.flags && war.flags.captures) out.push({ kind: 'triumph', scale: 1 });
  // Отбитый набег. У ядра нет отметки «сегодня отбили» — есть только общий
  // счётчик repelled. Поэтому ловим его приращение; своё прошлое значение
  // держим здесь же, чтобы не заводить поле в ядре ради одной связи.
  const rep0 = sim.sys._repelledSeen ?? sim.repelled ?? 0;
  if ((sim.repelled ?? 0) > rep0) out.push({ kind: 'triumph', scale: 0.45 });
  sim.sys._repelledSeen = sim.repelled ?? 0;

  // Предательство. Отдельного поля «нас предали» в ядре нет и заводить его
  // ради одной связи не стоило: договор о мире ядро и так соблюдает — войну
  // при действующем договоре объявить нельзя. Настоящее предательство здесь
  // другое: войну объявляет тот, с кем мы были В ЛАДУ. Такие случаи помечает
  // systemsFactions в момент объявления (см. sim.sys.betrayals).
  const bt = sim.sys.betrayals;
  if (Array.isArray(bt)) {
    for (const b of bt) if (b && b.day === day) out.push({ kind: 'betrayal', fid: b.fid, scale: 1 });
    // Список нужен ровно на одни сутки — дальше он живёт шрамом в летописи.
    sim.sys.betrayals = bt.filter(b => b && day - b.day < 2);
  }
  return out;
}

function applyMemoryLinks(sim, incoming) {
  if (!sim.linkMemory) sim.linkMemory = MEM.createMemory();
  const L = MEM.memoryLinks(sim, incoming);
  sim.linkMemory = L.flags.memory;
  sim.sys.memLinks = L;                  // для HUD и для множителей расхода

  const pst = sim.politics && sim.politics.state;
  if (pst) {
    pst.stability = Math.max(0, Math.min(100, pst.stability + L.mods.stability));
    for (const [fid, d] of Object.entries(L.mods.estates)) {
      if (!d || pst.factions[fid] == null) continue;
      pst.factions[fid] = Math.max(0, Math.min(100, pst.factions[fid] + d));
    }
  }

  // Кому не верят. Отношения ведёт ядро — у него журнал и затухание.
  for (const [fid, d] of Object.entries(L.mods.relations)) {
    if (d && typeof sim.adjustRel === 'function') sim.adjustRel(fid, d, 'Старая обида');
  }

  for (const e of L.events) sim.addLog(e.text, e.type);
  return L;
}

// Строительство: чертежи превращаются в стройку, здания ветшают.
function applyBuild(sim) {
  if (!sim.build) sim.build = B2.createBuild();
  const L = B2.buildNewDay(sim.build, sim);
  sim.sys.buildLinks = L;

  // Износ. Начисляем здесь, а не в модуле: модуль считает, мир меняет этот файл.
  for (const { b, w } of L.mods.wear) {
    const def = BUILDINGS[b.id];
    const max = def ? (def.wall || 100) : 100;
    b.hp = Math.max(1, Math.min(max, (b.hp ?? max) - w));
  }
  for (const e of L.events) sim.addLog(e.text, e.type);
  return L;
}

// Для панели «Стройка»: очередь, подсказки, ремонт.
export function buildQueue(sim) { return B2.queueReport(sim.build, sim); }
export function buildPlan(sim, id, x, y) { return B2.plan(sim.build, sim, id, x, y); }
export function buildPlanArea(sim, id, x0, y0, x1, y1) { return B2.planArea(sim.build, sim, id, x0, y0, x1, y1); }
export function buildCancel(sim, key) { return B2.cancelPlan(sim.build, key); }
export function buildMove(sim, key, dir) { return B2.movePlan(sim.build, key, dir); }
export function buildScore(sim, id, x, y) { return B2.scoreSpot(sim, id, x, y); }
export function buildBest(sim, id, n) { return B2.bestSpots(sim, id, n); }
export function buildUpgrade(sim, b) { return B2.upgrade(sim, b); }
export function buildCanUpgrade(sim, b) { return B2.canUpgrade(sim, b); }
export function buildRepairList(sim) { return B2.repairList(sim); }
export function buildRepair(sim, b) { return B2.repair(sim, b); }
export function buildRepairAll(sim) { return B2.repairAll(sim); }

// Тень прошлой партии: слепок раз в сезон и рассказ о расхождении.
function applyGhost(sim) {
  if (!sim.linkGhost) { sim.linkGhost = GH.createGhost(); sim.linkGhost.seed = sim.seed | 0; }
  const L = GH.ghostTick(sim);
  sim.linkGhost = L.flags.memory;
  for (const e of L.events) sim.addLog(e.text, e.type);
  return L;
}

// Для панели и для интерфейса, который хранит тень между партиями.
export function ghostPanel(sim, key) { return GH.ghostReport(sim, key); }
export function ghostSeal(sim) { return GH.sealRun(sim); }

// ---------- Род и сословия ----------
// Связь ничего не пишет в sim: она возвращает отчёт, а применение — здесь.
function applyDynastyLinks(sim) {
  if (!sim.linkDynasty) sim.linkDynasty = LDYN.createDynastyLink();
  const out = LDYN.dynastyLinks(sim);
  sim.linkDynasty = out.flags.memory;
  sim.sys.dynastyLink = out;

  const pst = sim.politics && sim.politics.state;
  if (pst) {
    // Тяга и разовый удар складываются одним слагаемым — ровно как в
    // applyTerritoryLinks и applySurvivalLinks. Двух разных путей к
    // стабильности быть не должно.
    const dS = out.mods.stability + out.mods.stabilityShock;
    pst.stability = Math.max(0, Math.min(100, pst.stability + dS));
    for (const fid of Object.keys(out.mods.estates)) {
      const d = out.mods.estates[fid] + out.mods.estatesShock[fid];
      if (!d || pst.factions[fid] == null) continue;
      pst.factions[fid] = Math.max(0, Math.min(100, pst.factions[fid] + d));
    }
  }

  // Сепаратизм НЕ считается здесь второй раз: связь подаёт одно число, а
  // потолок смуты остаётся тем же, что в applyTerritoryLinks (12 = UNREST_REVOLT
  // + 2 из empire.js). Иначе у смуты появилось бы два разных потолка.
  if (out.mods.cityUnrestAll && sim.empire) {
    for (const c of sim.empire.state.cities) {
      c.unrest = Math.max(0, Math.min(12, (c.unrest || 0) + out.mods.cityUnrestAll));
    }
  }

  // Разовые удары по законности уходят роду СПИСКОМ, а не состоянием: их
  // съест applyDynasty на следующих сутках и обнулит sim.sys.dynEvents.
  // Ограничение сверху обязательно: если applyDynasty ещё не подключён,
  // список иначе рос бы всю партию и попадал в каждый сейв.
  if (out.flags.dynEvents.length) {
    sim.sys.dynEvents = (sim.sys.dynEvents || []).concat(out.flags.dynEvents).slice(-20);
  }

  // Заговор ударил. Переворот делает МОДЕЛЬ РОДА — связь только называет час.
  // Строка работает лишь после подключения dynasty.js (блок 5 в её файле);
  // до этого проверка typeof молча пропустит её, и партия не сломается.
  if (out.flags.coupNow && sim.dynasty && typeof dynastyOverthrow === 'function') {
    dynastyOverthrow(sim, out.flags.coupNow.claimant);
  }

  for (const e of out.events) {
    sim.addLog(e.text, e.type === 'bad' ? 'bad' : (e.type === 'good' ? 'good' : 'info'));
    // В ЛЕТОПИСЬ — НЕ КАЖДУЮ ПОПЫТКУ. Удавшийся переворот заносится всегда:
    // это смена власти. Сорвавшаяся попытка — только первая у этого дома.
    //
    // Иначе выходит вот что, и это не догадка, а прогон на 12 000 дней (сид 11,
    // эпоха 3): знать сидит на одобрении 0, замок «нужно 40, есть 0» не
    // открывается никогда, а заговор дозревает заново каждые ~206 суток. В
    // летопись ложились тридцать семь СОВЕРШЕННО ОДИНАКОВЫХ строк «Заговор
    // сорван: Знать не пойдёт: нужно одобрение 40, есть 0». Летопись — это
    // память о том, что было важно, а не журнал; тридцать седьмой повтор
    // одного и того же вытесняет из неё войну и голод.
    //
    // Сама повторяемость попыток — замысел связи, и я его не трогаю: выход у
    // игрока есть и назван словами каждый день (поднять знать до 40), а цена
    // −8 стабильности за попытку и есть давление, ради которого всё писалось.
    // Правится только запись в вечную память, и только здесь, в применителе.
    if (e.cause === 'coup') {
      if (out.flags.coupNow) {
        sim.addChronicle(e.text);
        sim.sys._coupFailHouse = null;
      } else {
        const house = `${sim.dynasty ? sim.dynasty.fam : '?'}|${out.flags.coupFailed || ''}`;
        if (sim.sys._coupFailHouse !== house) {
          sim.sys._coupFailHouse = house;
          sim.addChronicle(e.text);
        }
      }
    }
  }
  if (out.flags.stage >= 3) sim.sfx?.('alarm');
  return out;
}

// Панель «Род и держава»: кто за трон, кто против и как гасить заговор.
export function dynastyLinkPanel(sim) { return LDYN.dynastyLinkBreakdown(sim); }
// Гасит кнопку «назначить наследника», когда знать связала роду руки.
export function dynastyHeirAllowed(sim) { return LDYN.canNameHeirNow(sim); }


// Ремесло живёт в людях: мастер, ученик и то, что уходит вместе с мастером.
function applyMasterLinks(sim) {
  if (!sim.linkMasters) sim.linkMasters = MAS.createMasters();
  const L = MAS.masterLinks(sim);
  sim.linkMasters = L.flags.memory;
  sim.sys.masterLinks = L;

  // Прибавка мастеров к выпуску. Потолок склада тот же, что у самих цепочек:
  // умение не должно быть способом обойти вместимость амбара.
  for (const [res, add] of Object.entries(L.mods.output)) {
    if (!(res in sim.res) || !add) continue;
    sim.res[res] = Math.min(sim.resCap[res] ?? 99999, sim.res[res] + add);
  }
  // Утрату ремесла записываем в летопись: это событие уровня «потеряли город»,
  // и через десять лет игрок должен иметь возможность понять, почему кузница
  // так и не вышла на прежний выпуск.
  for (const l of L.flags.lost) {
    if (l.before >= 0.25) {
      sim.addChronicle(`${MAS.craftName(l.id)}: умер последний мастер, ученика не было (день ${sim.day}).`);
    }
  }
  for (const e of L.events) sim.addLog(e.text, e.type);
  return L;
}

// Строки для панели «Народ»: у кого что в руках и чем рискуем.
export function mastersPanel(sim) { return MAS.mastersReport(sim); }

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
    // sim.plagueMult В ЯДРЕ НЕТ — ни метода, ни поля. Сторожевое условие тут
    // стояло с самого начала и молча даёт 1, то есть «мор не влияет». Ровно та
    // же строка с той же оговоркой лежит в population.js: два агента
    // независимо предположили одно и то же несуществующее поле. Оставляю как
    // есть (1 — верное нейтральное значение, ничего не искажает), но пишу это
    // словами, чтобы связь «мор → законность» не считали работающей.
    mortalityMult: sim.plagueMult ? sim.plagueMult() : 1,
    nobles: st ? st.factions.nobles : 50,
    military: st ? st.factions.military : 50,
    // СОБЫТИЯ, А НЕ СОСТОЯНИЯ. Список разовых ударов за эти сутки; род сам
    // держит сезонное окно, чтобы месяц голода не считался тридцать раз.
    events: sim.sys && sim.sys.dynEvents ? sim.sys.dynEvents : [],
  };
}

function applyDynasty(sim) {
  if (!sim.dynasty) sim.dynasty = DYN.createDynasty(createRng((sim.seed ^ 0x44594e00) >>> 0), { day: sim.day });
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
// Отмена назначения. Без неё назначение вопреки обычаю становится ловушкой:
// −0.10 законности в сутки навсегда, и выхода из петли нет. У каждой петли в
// этом проекте обязан быть выход.
export function dynastyClearHeir(sim) {
  const r = DYN.clearHeir(sim.dynasty);
  if (r.ok) { sim.dynasty = r.state; for (const e of r.events) sim.addLog(e.text, e.type); }
  else if (typeof sim.toast === 'function') sim.toast(r.reason);
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


// ---------- Стада ----------
function applyHerds(sim) {
  if (!sim.herds) return;
  const ctx = HERD.herdsContext(sim, (world, x, y) => tileAt(world, x, y));
  const rep = HERD.herdsNewDay(sim.herds, ctx, sim.rng);
  sim.herds = rep.state;
  for (const e of rep.events) {
    sim.addLog(e.text, e.type === 'bad' ? 'bad' : (e.type === 'good' ? 'good' : 'info'));
    if (e.cause === 'extinct') sim.addChronicle(e.text);
  }
  sim.sys.herdsReport = rep;
}

export function herdsPanel(sim) {
  return HERD.herdsSummary(sim.herds, HERD.herdsContext(sim, (world, x, y) => tileAt(world, x, y)));
}
export function herdsSustainable(sim) {
  return HERD.sustainableFood(sim.herds, HERD.herdsContext(sim, (world, x, y) => tileAt(world, x, y)));
}
export function herdsNearest(sim, x, y) {
  // maxDist обязателен. Без него охотник уходит за пуганым стадом на другой
  // конец карты и не возвращается неделю, пока поселение голодает рядом с
  // ягодником. Дальше 26 клеток охота не окупается — пусть идёт собирать.
  return HERD.nearestHerd(sim.herds, x, y, { minHeads: 1, maxDist: 26 });
}
export function herdsHunt(sim, id, opts) {
  const ctx = HERD.herdsContext(sim, (world, x, y) => tileAt(world, x, y));
  const rep = HERD.huntHerd(sim.herds, id, ctx, opts, sim.rng);
  sim.herds = rep.state;
  return rep;
}
export function herdPoints(sim) { return HERD.herdPoints(sim.herds); }

// Разведка: знание о соседях как ресурс со сроком годности.
function applyIntelLinks(sim) {
  if (!sim.linkIntel) sim.linkIntel = INT.createIntel();
  const L = INT.intelLinks(sim);
  sim.linkIntel = L.flags.memory;
  sim.sys.intelLinks = L;
  for (const e of L.events) sim.addLog(e.text, e.type);
  return L;
}

// Что мы знаем о соседе — для карточки и панели дипломатии. Именно ЭТО должен
// читать интерфейс вместо f.armyPts: симуляция видит правду, игрок — вести.
export function intelOf(sim, fid) { return INT.knownOf(sim, fid); }
export function intelRows(sim) { return INT.intelReport(sim); }
export function intelTrustWord(trust) { return INT.trustWord(trust); }

// Строки для панели «Летопись»: что помнит народ и во что это обходится.
export function memoryPanel(sim) {
  return MEM.memoryBreakdown(sim);
}

// Связь «соседи ↔ наша держава»: караваны, страх, беженцы, разрыв в науке.
function applyNeighborLinks(sim) {
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

// Связь «охота ↔ стада ↔ еда»: облава, стоянки у дичи, истощение и скот.
// Модуль только считает; всё, что меняет мир, делается здесь.
function applyHuntLinks(sim) {
  if (!sim.linkHunt) sim.linkHunt = HUNT.createHuntMemory();
  const out = HUNT.huntLinks(sim);
  sim.linkHunt = out.flags.memory;
  sim.sys.huntLinks = out;             // кэш для HUD и для huntLodgeMult

  // Скот кормит каждый день. Потолок склада тот же, что у промыслов:
  // приручение не должно быть способом обойти вместимость амбара.
  if (out.mods.food > 0) {
    sim.res.food = Math.min(sim.resCap.food, sim.res.food + out.mods.food);
  }

  // Поправки к модели стад. Пока herds.js не подключён, sim.herds нет и
  // цикл просто не находит, что править.
  // sim.herds.HERDS, а не .list. Блок подключения искал поле list, которого у
  // состояния стад нет вовсе: herds.js держит стада в поле herds. Цикл ниже
  // молча не находил бы ни одного стада, и весь пункт «связь пугает и гонит
  // зверя» не работал бы — без ошибки, без предупреждения, просто впустую.
  const herds = Array.isArray(sim.herds) ? sim.herds
    : (sim.herds && Array.isArray(sim.herds.herds) ? sim.herds.herds
      : (sim.herds && Array.isArray(sim.herds.list) ? sim.herds.list : null));
  if (herds) {
    for (const [id, d] of Object.entries(out.mods.herds)) {
      const h = herds.find(x => x && String(x.id) === id);
      if (!h) continue;
      h.fear = Math.max(0, Math.min(1, (h.fear || 0) + d.fear));
      // Координаты стада в herds.js называются cx/cy; x/y у него нет. Правим
      // ту пару, которая на самом деле есть, иначе гон зверя опять ушёл бы в
      // пустоту — на этот раз создав стаду лишние поля x и y.
      if (h.cx !== undefined) {
        h.cx = Math.max(0, Math.min(sim.world.w - 1, h.cx + d.dx));
        h.cy = Math.max(0, Math.min(sim.world.h - 1, h.cy + d.dy));
      } else {
        h.x = Math.max(0, Math.min(sim.world.w - 1, (h.x || 0) + d.dx));
        h.y = Math.max(0, Math.min(sim.world.h - 1, (h.y || 0) + d.dy));
      }
    }
  }

  // Отметки, которые связь только что прочла, выбрасываем: остаются лишь
  // сегодняшние, а их прочтут завтрашним проходом. Так каждая отметка идёт в
  // счёт ровно один раз — это то самое «одни сутки считаются однажды».
  //
  // Было `sim.day - k.day < 2`, то есть отметка жила двое суток. Вместе со
  // строгим равенством дней внутри связи это давало не двойной счёт, а ноль:
  // отметку не читали ни разу. Теперь связь берёт и вчерашние, поэтому срок
  // хранения обязан ужаться, иначе вчерашняя добыча сосчиталась бы дважды.
  if (Array.isArray(sim.sys.huntKills)) {
    sim.sys.huntKills = sim.sys.huntKills.filter(k => k && k.day >= sim.day);
  }

  for (const e of out.events) sim.addLog(e.text, e.type);
  if (out.flags.extinctToday.length) {
    sim.sfx?.('alarm');
    for (const s of out.flags.extinctToday) {
      const sp = HUNT.SPECIES[s] || HUNT.SPECIES.wild;
      sim.addChronicle(`${sp.many} извели подчистую (день ${sim.day}).`);
    }
  }
  return out;
}

// Приручение — приказ игрока, а не автоматика. Панель зовёт huntTameList,
// кнопка — huntTame. Здесь же сходятся два модуля: условия проверяет
// link_hunt (он один знает про пастбище), само стадо снимает с карты
// herds.js, а головы забирает себе счётчик скота link_hunt — иначе после
// приручения стадо просто исчезло бы, ведь herds.js его у себя удаляет.
export function huntTameList(sim) { return HUNT.tameCandidates(sim); }
export function huntTame(sim, herdId) {
  const check = HUNT.tameHerd(sim, herdId);
  if (!check.ok) { sim.toast?.(check.reason, 'warn'); return check; }

  // Есть модель стад — приручает она (у неё свой отчёт и своё состояние).
  if (sim.herds && Array.isArray(sim.herds.herds)) {
    const ctx = HERD.herdsContext(sim, (world, x, y) => tileAt(world, x, y));
    const rep = HERD.tameHerd(sim.herds, Number(herdId), ctx);
    if (!rep.ok) { sim.toast?.(rep.reasons[0]?.ru || 'Нельзя', 'warn'); return rep; }
    sim.herds = rep.state;
    sim.linkHunt = HUNT.withStock(sim.linkHunt, rep.flags.kind, rep.flags.heads);
    for (const e of rep.events) sim.addLog(e.text, e.type);
    return rep;
  }

  // Модели стад нет (старый мир на sim.animals) — работаем по своей форме.
  const list = Array.isArray(sim.herds) ? sim.herds
    : (sim.herds && Array.isArray(sim.herds.list) ? sim.herds.list : null);
  if (list) {
    for (const id of check.mods.tame) {
      const h = list.find(x => x && String(x.id) === id);
      if (h) { h.tame = true; h.fear = 0; }
    }
  }
  for (const e of check.events) sim.addLog(e.text, e.type);
  return check;
}

// Готовая строка для HUD: «Стада редеют: за месяц выбито 14 гол. из 40…».
// Память НЕ двигает — звать из рендера безопасно.
export function huntPanel(sim) { return HUNT.huntBreakdown(sim); }

// ---------- Экраны новых систем ----------
export const PANELS = {
  people:   { render: POP.renderPopulationPanel, bind: POP.bindPopulationPanel },
  industry: { render: IND.renderIndustryPanel,   bind: IND.bindIndustryPanel },
  war:      { render: WAR.renderPanel,           bind: WAR.bindPanel },
  politics: { render: POL.renderPoliticsPanel,   bind: POL.bindPoliticsPanel },
  empire:   { render: EMP.renderEmpirePanel,     bind: EMP.bindEmpirePanel },
};
