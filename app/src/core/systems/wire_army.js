// core/systems/wire_army.js — оживление army.js (864 стр., 16 тестов) и
// front.js (579 стр., 46 тестов).
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. Обе системы написаны, зелёные и мёртвые: игра их не зовёт.
// Здесь тот же принцип, что в systems/integrate.js — модуль НЕ трогает sim, он
// получает ctx и возвращает отчёт, а применяет отчёт к миру этот слой. Поэтому
// army.js и front.js остаются тестируемыми в одиночку, а ядро не знает про их
// внутренности.
//
// ЧТО ИМЕННО ОЖИВАЕТ:
//   army.js  — отряды с координатами на карте, роды войск и контр-система,
//     боевой дух, осадные машины, укрепления, полководец (powerBonus),
//     разрешение боя по раундам, походы на поселения фракций;
//   front.js — снабжение от ближайшего города по дороге (aStar), линия фронта,
//     захват точек с доходом, ЗНАМЕНОСЦЫ (аура духа в радиусе, шок при гибели,
//     знамя победы с днём и названием сражения), туман войны и разведка.
//
// ГЛАВНАЯ СВЯЗКА С ЯДРОМ. В ядре армия — одно число sim.army.soldiers, а рейды
// абстрактный таймер. Здесь оба конца сшиваются, но НИ ОДНА чужая механика не
// дублируется:
//   1) sim.army.soldiers остаётся РЕЗЕРВОМ в поселении. Формирование отряда
//      забирает бойцов из резерва, роспуск в поселении возвращает их обратно.
//      Обучение и цена бойца — по-прежнему целиком за ядром, а его же лимит
//      armyLimit() (население/4) здесь дотягивается до карты: без этого
//      «сформировал отряд — обучил ещё» обходило бы лимит бесконечно.
//   2) Содержание. Ядро списывает еду и золото только за резерв (onNewDay
//      считает по this.army.soldiers). Значит, за бойцов, ушедших в поле, никто
//      не платил бы — и «вывести всех в поход» стало бы способом не кормить
//      армию. Поэтому здесь тот же ARMY_UPKEEP берётся с людей в отрядах: это
//      не новая механика, это существующее правило ядра, дотянутое до карты.
//   3) Рейды перестают быть таймером. За RAID_LEAD дней до срока (raids.timer)
//      на карту выходит НАСТОЯЩИЙ отряд набега и идёт маршем к поселению.
//      Разбили в поле — волна не состоится (таймер сбрасывается, счётчик
//      отбитых растёт). Дошёл до кострища — оборону самого поселения разыгрывает
//      ядро (tickRaids/resolveRaid), как и раньше: army.js намеренно не водит
//      чужие отряды по домашним постройкам.
//
// ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ. Своей формулы боя, своего снабжения, своего захвата
// точек, своих знамён. Всё это уже посчитано в army.js/front.js — здесь только
// сборка ctx, применение отчёта и экран. Math.random не используется: весь
// случай идёт через sim.rng внутри модулей.
//
// АРХИТЕКТУРА. Файл лежит в core/ и document не трогает: renderPanel() СОБИРАЕТ
// строку HTML, bindPanel() получает корневой узел снаружи (образец —
// ui/panel_market.js).

import { UNITS, TECHS, TECH_ERA_IDX, ARMY_UPKEEP, WALKABLE, TILE } from '../data.js';
import { tileAt, findNearestTile } from '../world.js';
import * as Army from './army.js';
import * as Front from './front.js';

// ---------------- Константы связки (не механики: механика в модулях) ----------------

// Ближе этого к кострищу отряд считается «в поселении»: там его можно
// распустить и там же ему строят осадные машины. Машины делает мастерская, а не
// обоз под вражескими стенами — иначе осада превращалась бы в бесконечную.
export const HOME_DIST = 3;
// Найм знаменосца. Цена из «родной» инструкции front.js (п.4): 30 золота.
export const BEARER_COST = { gold: 30 };
// Откуда и когда выходит набег.
// Ядро поднимает тревогу за 2 дня до удара (raids.warning при timer ≤ 2), но
// этого мало: отряд успевал дойти ровно к сроку, и перехватить его игрок
// физически не мог — волна разыгрывалась ядром раньше, чем случался бой в поле.
// Поэтому враг выходит на карту за RAID_LEAD дней до срока и идёт RAID_MARCH
// клеток. Пехота делает 6 клеток в день, значит марш занимает ~3 дня и у игрока
// есть настоящее окно на встречный бой. Собственное предупреждение ядра при
// этом никуда не девается — оно приходит вторым, уже «враг близко».
export const RAID_MARCH = 16;
export const RAID_LEAD = 5;
// Партии при формировании отряда. Резерв невелик (лимит — население/4), поэтому
// лоты мелкие, плюс «все».
export const FORM_LOTS = [3, 5, 10];

const UNIT_BY_ID = Object.fromEntries(UNITS.map(u => [u.id, u]));
const TECH_BY_ID = Object.fromEntries(TECHS.map(t => [t.id, t]));
const ROLE_RU = { inf: 'пехота', cav: 'конница', range: 'стрелки', siege: 'осада' };
// Контры берутся из COUNTERS в data.js; здесь только человеческие слова к ним.
const ROLE_HINT = {
  inf: 'бьёт конницу',
  cav: 'бьёт стрелков',
  range: 'бьёт пехоту',
};

// ════════════════════════════ АДАПТЕР ════════════════════════════

// Ставится ПОСЛЕ installSystems(sim): нужен готовый мир и уже расселённые
// фракции — иначе городам соседей неоткуда взяться на карте точек.
export function install(sim) {
  if (!sim) return null;
  if (sim.war) return sim.war;
  const army = Army.createArmyState();
  // Имя sim.armyState — из «родной» инструкции army.js: его ждут и рендер, и
  // адаптер front.js (он читает sim.armyState внутри своего onNewDay).
  sim.armyState = army;
  const front = Front.createFrontSystem();
  sim.front = front;
  seedPoints(sim, front);
  sim.war = {
    army, front,
    sel: 0,                                   // выбранный в панели отряд
    raid: { squadId: 0, from: null, day: -1, landedDay: -1 },
    upkeep: { men: 0, food: 0, gold: 0 },     // содержание отрядов в поле за день
    events: [],                               // события последнего дня — для панели
  };
  return sim.war;
}

// Точки фронта: рудники и переправы ищет сам модуль по рельефу, города —
// поселения игрока и соседей. Владелец города проставляется сразу: иначе
// «ничей» родной город не давал бы снабжения собственной армии.
function seedPoints(sim, front) {
  if (front.state.points.length) return;
  Front.generatePoints(front.state, sim.world, sim.rng);
  Front.addCityPoint(front.state, sim.world.startX, sim.world.startY, 'Ваше поселение', 'player');
  for (const f of sim.factions || []) {
    for (const s of f.settlements || []) {
      Front.addCityPoint(front.state, s.x, s.y, `Город (${f.def ? f.def.name : f.id})`, f.id);
    }
  }
}

// Один вызов на игровой день. Порядок важен: сначала выходит набег (иначе он
// потеряет день марша), затем платится содержание, и только потом ход войны —
// снабжение внутри front.js считается по уже актуальному положению отрядов.
export function onNewDay(sim) {
  const W = sim && sim.war;
  if (!W) return [];
  syncSquads(sim);
  spawnRaidParty(sim);
  W.upkeep = chargeFieldUpkeep(sim);

  // Front.tickWar сам прогоняет Army.tickArmy внутри себя: отдельный вызов
  // tickArmy здесь был бы двойным ходом армии за сутки.
  //
  // Готовый Front.createFrontSystem().onNewDay не используется намеренно — он
  // собирает «враждебность» строго по объявленным войнам, а отряд набега войну
  // не объявляет. Для front.js такой бой тогда не бой: не падает знамя убитого
  // знаменосца и не встаёт знамя победы. Состояние и сейв берутся у того же
  // адаптера, а ctx собирается здесь.
  const battlesBefore = sim.armyState.battles;
  const events = Front.tickWar(W.front.state, sim.armyState, warCtx(sim), sim.rng);
  applyPointIncome(sim);
  for (const e of events) {
    sim.addLog(e.text, e.type || 'info');
    if (e.chronicle) sim.addChronicle(e.text);
  }
  resolveRaidParty(sim, sim.armyState.battles > battlesBefore);
  holdHomeCity(sim);
  W.events = events;
  return events;
}

// ctx для front.js. Источники снабжения — кострище игрока и поселения соседей:
// обоз идёт от ближайшего своего города, и без этого списка любая армия
// считалась бы отрезанной с первого дня.
function warCtx(sim) {
  const sources = [{ x: sim.world.startX, y: sim.world.startY, side: 'player' }];
  for (const f of sim.factions || []) {
    if (!f.alive) continue;
    for (const s of f.settlements || []) sources.push({ x: s.x, y: s.y, side: f.id });
  }
  return {
    world: sim.world, dt: 1, day: sim.day,
    factions: sim.factions, sources,
    atWar: hostility(sim),
  };
}

// Кто кому враг. Войны и союзы ведёт ядро — здесь только одно добавление:
// вышедший в поле отряд набега враждебен игроку по факту, даже если войны не
// объявлено. Он для того и вышел; без этого front.js не признал бы бой боем.
function hostility(sim) {
  const raider = sim.war.raid.squadId ? sim.war.raid.from : null;
  return (a, b) => {
    if (raider && ((a === 'player' && b === raider) || (b === 'player' && a === raider))) return true;
    if (a === 'player' || b === 'player') {
      const other = a === 'player' ? b : a;
      return (sim.wars || []).some(w => w.fid === other);
    }
    return (sim.aiWars || []).some(w => (w.a === a && w.b === b) || (w.a === b && w.b === a));
  };
}

// Доход захваченных точек. Потолки складов — ядра, поэтому кладём через resCap:
// иначе рудник переполнял бы каменный склад сверх лимита.
function applyPointIncome(sim) {
  const inc = Front.pointIncomePerDay(sim.war.front.state, 'player');
  for (const [k, v] of Object.entries(inc)) {
    if (sim.res[k] == null) continue;
    const cap = sim.resCap && isFinite(sim.resCap[k]) ? sim.resCap[k] : Infinity;
    sim.res[k] = Math.min(cap, sim.res[k] + v);
  }
}

// Родное поселение — тоже точка на карте, и front.js отдаёт точку любому, кто
// один стоит рядом. Для рудника это правильно, для собственной столицы — нет:
// у игрока обычно вовсе нет отрядов на карте, и первый же набег отбирал бы у
// него город НАВСЕГДА, хотя оборону поселения разыгрывает ядро и оно же говорит,
// отбита волна или нет. Поэтому пока враг стоит в поселении, точка честно
// считается его (это видно и в журнале), а как только он ушёл или убит — город
// молча возвращается: захватывать его некому.
function holdHomeCity(sim) {
  const p = homePoint(sim);
  if (!p || p.owner === 'player') return;
  for (const sq of sim.armyState.squads) {
    if (sq.side === 'player' || !Army.squadAlive(sq)) continue;
    if (Math.hypot(sq.x - p.x, sq.y - p.y) <= Front.CAPTURE_DIST) return;
  }
  p.owner = 'player';
}

// Точка родного поселения ищется по координатам кострища, а не по сохранённому
// id: так она находится и в сейве, снятом до этой правки.
function homePoint(sim) {
  const x = Math.round(sim.world.startX), y = Math.round(sim.world.startY);
  return sim.war.front.state.points.find(p => p.kind === 'city' && p.x === x && p.y === y) || null;
}

// Полководца нанимают посреди игры, здания и технологии множитель армии тоже
// меняют. Отряд хранит эти числа в себе (так задумано в army.js: бой считается
// без ядра), поэтому их приходится освежать — иначе бонус доходил бы только до
// отрядов, собранных после найма.
function syncSquads(sim) {
  const bonus = sim.army ? (sim.army.powerBonus || 0) : 0;
  const mult = typeof sim.globalMult === 'function' ? sim.globalMult('army') : 1;
  for (const sq of Army.squadsOf(sim.armyState, 'player')) {
    sq.powerBonus = bonus;
    sq.mult = mult;
  }
}

// Содержание людей в поле по тем же ARMY_UPKEEP, что ядро берёт с резерва.
// Еда зажимается нулём: провал в минус ядро всё равно обнулило бы на следующем
// дне, а голодная смерть жителя оттуда и придёт.
function chargeFieldUpkeep(sim) {
  let men = 0;
  for (const sq of Army.squadsOf(sim.armyState, 'player')) men += Army.squadSize(sq);
  const food = men * ARMY_UPKEEP.food, gold = men * ARMY_UPKEEP.gold;
  if (men > 0) {
    sim.res.food = Math.max(0, sim.res.food - food);
    sim.res.gold = Math.max(0, sim.res.gold - gold);
  }
  return { men, food, gold };
}

// ---------------- Рейд как настоящий отряд ----------------

// Сила набега считается ровно той же формулой, что и в ядре (resolveRaid:
// threatPoints()/10 + эпоха×2), иначе перехват в поле был бы легче или тяжелее
// обороны у кострища — и игрок не понимал бы, что дешевле.
function spawnRaidParty(sim) {
  const W = sim.war, R = W.raid;
  // Ровно то же условие, при котором рейды вообще идут в ядре (tickRaids):
  // выключены — молчим, до Железного века — тоже.
  if (!sim.raids || sim.raids.off || sim.eraIndex < 2) return null;
  if (sim.raids.timer > RAID_LEAD) return null;
  if (R.squadId && Army.findSquad(sim.armyState, R.squadId)) return null;
  if (R.landedDay === sim.day) return null;   // волна уже отгремела сегодня

  // Кто идёт: тот, кого назвало ядро; до его тревоги — самый агрессивный живой
  // сосед, по тому же правилу, что в tickRaids.
  const f = (sim.raids.from ? sim.faction(sim.raids.from) : null) || mostAggressive(sim);
  const home = f && f.settlements && f.settlements[0] ? f.settlements[0] : null;
  const spot = marchStart(sim.world, home, sim.world.startX, sim.world.startY);
  if (!spot) return null;

  const u = raidUnit(sim);
  // Сила — по формуле ядра из resolveRaid: угроза/10 + эпоха×2. Иначе перехват
  // в поле оказался бы легче или тяжелее обороны у кострища, и игрок не понимал
  // бы, что ему дешевле.
  const power = Math.max(1, Math.round(sim.threatPoints() / 10) + sim.eraIndex * 2);
  const count = Math.max(3, Math.round(power / u.power));
  const sq = Army.formSquad(sim.armyState, {
    side: f ? f.id : 'raiders',
    name: `Набег: ${f ? f.def.name : 'кочевники'}`,
    x: spot.x, y: spot.y,
    units: { [u.id]: count },
    mult: (f && f.def.bonus && f.def.bonus.army) || 1,
  });
  Army.orderMove(sim.armyState, sq.id, sim.world.startX, sim.world.startY, sim.world);
  R.squadId = sq.id; R.from = sq.side; R.day = sim.day;
  sim.addLog(`⚔ ${sq.name} вышел в поле (${spot.x},${spot.y}): ${u.name} ×${count}. Перехватите его — иначе он дойдёт до поселения.`, 'warn');
  return sq;
}

function mostAggressive(sim) {
  let best = null;
  for (const f of sim.factions || []) {
    if (!f.alive) continue;
    if (!best || f.def.traits.aggression > best.def.traits.aggression) best = f;
  }
  return best;
}

// Кто именно идёт в набег: сильнейший юнит, чья технология относится к уже
// наступившей эпохе. Своей таблицы «эпоха → юнит» не завожу — TECH_ERA_IDX уже
// есть в data.js.
function raidUnit(sim) {
  let best = UNITS[0];
  for (const u of UNITS) if ((TECH_ERA_IDX[u.req] ?? 99) <= sim.eraIndex) best = u;
  return best;
}

// Точка выхода: на линии от поселения в сторону родины врага. Если там вода или
// гора — отходим ближе и ищем ближайшую траву: отряд, поставленный на непроходимый
// тайл, никуда не пойдёт (aStar не найдёт путь) и просто зависнет.
function marchStart(world, home, tx, ty) {
  let dx = home ? home.x - tx : 1, dy = home ? home.y - ty : 0;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d; dy /= d;
  for (let r = RAID_MARCH; r >= 4; r--) {
    const x = Math.round(tx + dx * r), y = Math.round(ty + dy * r);
    if (x < 0 || y < 0 || x >= world.w || y >= world.h) continue;
    if (WALKABLE.has(tileAt(world, x, y))) return { x, y };
    const alt = findNearestTile(world, x, y, TILE.GRASS, 4);
    if (alt) return alt;
  }
  return null;
}

// Итог дня для набега. Три исхода, и все три должны быть согласованы с ядром,
// иначе таймер рейдов заживёт своей жизнью.
function resolveRaidParty(sim, wasBattle) {
  const W = sim.war, R = W.raid;
  if (!R.squadId) return;
  const sq = Army.findSquad(sim.armyState, R.squadId);

  // 1) Ядро уже разыграло волну сегодня (таймер вышел): снимаем отряд с карты,
  //    чтобы одна и та же атака не считалась дважды.
  if (sim.lastRaidDay === sim.day) {
    if (sq) Army.disbandSquad(sim.armyState, sq.id);
    R.squadId = 0; R.landedDay = sim.day;
    return;
  }

  // 2) Отряда нет — волна не состоится. Засчитываем отбитый рейд только если
  //    сегодня действительно был бой: отряд мог и сам рассыпаться от голода,
  //    и приписывать игроку чужую заслугу нечестно.
  if (!sq) {
    R.squadId = 0;
    sim.raids.warning = false;
    sim.raids.power = 0;
    sim.raids.timer = sim.rng.int(40, 70);
    if (wasBattle) {
      sim.repelled = (sim.repelled || 0) + 1;
      sim.addLog('🛡 Набег перехвачен в поле — до поселения враг не дошёл.', 'good');
      sim.addChronicle(`Набег перехвачен в поле (день ${sim.day}).`);
    } else {
      sim.addLog('Отряд набега рассыпался в пути, не дойдя до поселения.', 'good');
    }
    return;
  }

  // 3) Дошёл. Оборона самого поселения — за ядром: пусть волна разрешится
  //    завтрашним tickRaids по его правилам (стены, гарнизон, трофеи).
  if (Math.hypot(sq.x - sim.world.startX, sq.y - sim.world.startY) <= Front.CAPTURE_DIST) {
    sim.raids.timer = Math.min(sim.raids.timer, 0);
  }
}

// ---------------- Сохранение ----------------

export function serialize(sim) {
  const W = sim && sim.war;
  if (!W) return null;
  return {
    v: 1,
    army: Army.serializeArmy(sim.armyState),
    front: W.front.serialize(),
    raid: { ...W.raid },
    sel: W.sel,
  };
}

export function restore(sim, data) {
  if (!sim) return;
  if (!sim.war) install(sim);
  const W = sim.war;
  // Старый сейв без раздела войны: точки и пустая армия уже созданы
  // конструктором, ничего восстанавливать не нужно.
  if (!data) return;
  sim.armyState = Army.deserializeArmy(data.army);
  W.army = sim.armyState;
  W.front.deserialize(data.front);
  if (!W.front.state.points.length) seedPoints(sim, W.front);
  W.raid = { squadId: 0, from: null, day: -1, landedDay: -1, ...(data.raid || {}) };
  W.sel = data.sel || 0;
}

// ---------------- Сводка для HUD ----------------

export function warStatus(sim) {
  const W = sim && sim.war;
  if (!W) return null;
  const squads = Army.squadsOf(sim.armyState, 'player');
  let men = 0, power = 0, engines = 0, cut = 0, tired = 0;
  for (const sq of squads) {
    men += Army.squadSize(sq);
    engines += Army.engineCount(sq);
    power += Army.squadPower(sq, tileAt(sim.world, sq.x, sq.y));
    const s = Front.supplyOf(W.front.state, sq.id);
    if (s.cut) cut++;
    if (s.fat >= Front.FATIGUE_DESERT) tired++;
  }
  return {
    squads: squads.length, men, engines, power, cut, tired,
    reserve: Math.floor(sim.army.soldiers),
    limit: sim.armyLimit(),
    room: Math.max(0, sim.armyLimit() - men),
    upkeep: W.upkeep,
    banners: W.front.state.banners.length,
    points: Front.pointsOf(W.front.state, 'player').length,
    frontCells: (W.front.state.cells || []).length,
    battles: sim.armyState.battles,
    captures: sim.armyState.captures,
  };
}

// ════════════════════════════ ДЕЙСТВИЯ ════════════════════════════
// Вся проверка вынесена сюда и работает без DOM: её может позвать и панель, и
// консоль, и тест. Возвращают {ok, reason?, text?}.

export function selectedSquad(sim) {
  const W = sim && sim.war;
  if (!W) return null;
  return Army.findSquad(sim.armyState, W.sel);
}

export function handleWarAction(sim, spec) {
  const W = sim && sim.war;
  if (!W) return { ok: false, reason: 'Военная система не подключена' };
  const p = String(spec || '').split(':');
  switch (p[0]) {
    case 'sel': {
      const sq = Army.findSquad(sim.armyState, Number(p[1]));
      if (!sq) return { ok: false, reason: 'Такого отряда больше нет' };
      W.sel = sq.id;
      return { ok: true, text: `Выбран ${sq.name}` };
    }
    case 'form': return actForm(sim, p[1], p[2]);
    case 'engine': return actEngine(sim, p[1]);
    case 'bearer': return actBearer(sim);
    case 'disband': return actDisband(sim);
    case 'hold': return actOrder(sim, 'hold');
    case 'home': return actOrder(sim, 'home');
    case 'intercept': return actOrder(sim, 'intercept');
    case 'point': return actOrder(sim, 'point', Number(p[1]));
    case 'camp': return actCampaign(sim, p[1], Number(p[2]), Number(p[3]));
    default: return { ok: false, reason: 'Неизвестный приказ' };
  }
}

// Формирование. Резерв обезличен (ядро обучает «лучшего доступного»), поэтому
// род войск выбирает игрок из уже открытых технологиями — это и есть решение
// про контр-систему: конница против стрелков, пехота против конницы.
function actForm(sim, unitId, lot) {
  const u = UNIT_BY_ID[unitId];
  if (!u) return { ok: false, reason: 'Неизвестный род войск' };
  if (!sim.techs.has(u.req)) {
    return { ok: false, reason: `Нужна технология «${techName(u.req)}»` };
  }
  const have = Math.floor(sim.army.soldiers);
  if (have < 1) return { ok: false, reason: 'Резерв пуст — обучите бойцов в Казарме' };
  const want = lot === 'all' ? have : Math.floor(Number(lot));
  if (!isFinite(want) || want < 1) return { ok: false, reason: 'Неверный размер отряда' };
  // Лимит армии ядро проверяет только по резерву (soldiers + trainQueue). Ушедшие
  // в поле из резерва исчезают — и «сформировал отряд, обучил ещё» обходило бы
  // лимит бесконечно. Поэтому тот же armyLimit() держим и для людей на карте.
  const limit = sim.armyLimit();
  const room = limit - fieldMen(sim);
  if (room < 1) {
    return { ok: false, reason: `Лимит армии в поле: ${limit} (население/4). Растите поселение или распустите отряд` };
  }
  const take = Math.min(have, want, room);
  const sq = Army.formSquad(sim.armyState, {
    side: 'player',
    x: sim.world.startX, y: sim.world.startY,
    units: { [unitId]: take },
    powerBonus: sim.army.powerBonus || 0,
    mult: sim.globalMult('army'),
  });
  sim.army.soldiers -= take;
  sim.war.sel = sq.id;
  sim.addLog(`Сформирован ${sq.name}: ${u.name} ×${take}.`, 'good');
  return { ok: true, text: `${sq.name}: ${u.name} ×${take}` };
}

// Роспуск возвращает людей в резерв — но только дома: иначе отряд из-под чужих
// стен телепортировался бы в поселение целиком.
function actDisband(sim) {
  const sq = selectedSquad(sim);
  if (!sq) return { ok: false, reason: 'Сначала выберите отряд' };
  if (!atHome(sim, sq)) return { ok: false, reason: 'Распустить можно только в поселении — сначала верните отряд домой' };
  const men = Army.squadSize(sq);
  Army.disbandSquad(sim.armyState, sq.id);
  sim.army.soldiers += men;
  sim.war.sel = 0;
  sim.addLog(`${sq.name} распущен: ${men} бойцов вернулись в резерв.`);
  return { ok: true, text: `В резерв вернулись ${men} бойцов` };
}

// Осадные машины строит поселение. Цена и требуемая технология — из таблицы
// SIEGE_ENGINES самого army.js, своей копии здесь нет.
function actEngine(sim, engineId) {
  const sq = selectedSquad(sim);
  if (!sq) return { ok: false, reason: 'Сначала выберите отряд' };
  const e = Army.engineDef(engineId);
  if (!e) return { ok: false, reason: 'Неизвестная машина' };
  if (e.req && !sim.techs.has(e.req)) return { ok: false, reason: `Нужна технология «${techName(e.req)}»` };
  if (!atHome(sim, sq)) return { ok: false, reason: 'Машины собирают в поселении — верните отряд домой' };
  if (Army.squadSize(sq) < e.crew) return { ok: false, reason: `Нужен расчёт: ${e.crew} бойцов в отряде` };
  const lack = sim.lackCost(e.cost);
  if (lack) return { ok: false, reason: `Не хватает: ${lack}` };
  sim.payCost(e.cost);
  Army.addEngine(sim.armyState, sq.id, engineId, 1);
  sim.addLog(`${sq.name} получил ${e.name.toLowerCase()}.`, 'good');
  return { ok: true, text: `${e.name} собран` };
}

// Знаменосец — из front.js: аура духа в радиусе, шок при гибели, знамя после
// победы. Один на отряд.
function actBearer(sim) {
  const sq = selectedSquad(sim);
  if (!sq) return { ok: false, reason: 'Сначала выберите отряд' };
  const st = sim.war.front.state;
  if (Front.hasBearer(st, sq.id)) return { ok: false, reason: 'В этом отряде уже есть знаменосец' };
  const lack = sim.lackCost(BEARER_COST);
  if (lack) return { ok: false, reason: `Не хватает: ${lack}` };
  sim.payCost(BEARER_COST);
  Front.addBearer(st, sq.id);
  sim.addLog(`${sq.name}: поднято знамя — знаменосец встал в строй.`, 'good');
  return { ok: true, text: 'Знаменосец в строю' };
}

function actOrder(sim, kind, arg) {
  const sq = selectedSquad(sim);
  if (!sq) return { ok: false, reason: 'Сначала выберите отряд' };
  const st = sim.armyState;
  if (kind === 'hold') {
    Army.orderHold(st, sq.id);
    return { ok: true, text: `${sq.name}: стоять` };
  }
  if (kind === 'home') {
    const ok = Army.orderMove(st, sq.id, sim.world.startX, sim.world.startY, sim.world);
    return ok ? { ok: true, text: `${sq.name} идёт домой` }
      : { ok: false, reason: 'Пути домой нет — отряд отрезан рельефом' };
  }
  if (kind === 'point') {
    const p = sim.war.front.state.points.find(q => q.id === arg);
    if (!p) return { ok: false, reason: 'Такой точки нет' };
    const ok = Army.orderMove(st, sq.id, p.x, p.y, sim.world);
    return ok ? { ok: true, text: `${sq.name} идёт к «${p.name}»` }
      : { ok: false, reason: 'Туда не дойти: путь перекрыт водой или горами' };
  }
  if (kind === 'intercept') {
    const raidId = sim.war.raid.squadId;
    const foe = raidId ? Army.findSquad(st, raidId) : null;
    if (!foe) return { ok: false, reason: 'Отряда набега на карте нет' };
    const ok = Army.orderAttack(st, sq.id, foe.id, sim.world);
    return ok ? { ok: true, text: `${sq.name} перехватывает набег` }
      : { ok: false, reason: 'До врага не добраться' };
  }
  return { ok: false, reason: 'Неизвестный приказ' };
}

// Поход на поселение соседа. Требование войны — не выдумка панели: army.js сам
// сносит поселение при победе, и делать это исподтишка, без объявления войны,
// значило бы обойти всю дипломатию ядра.
function actCampaign(sim, fid, x, y) {
  const sq = selectedSquad(sim);
  if (!sq) return { ok: false, reason: 'Сначала выберите отряд' };
  const f = sim.faction(fid);
  if (!f || !f.alive) return { ok: false, reason: 'Этой фракции больше нет' };
  if (!(sim.wars || []).some(w => w.fid === fid)) {
    return { ok: false, reason: `С «${f.def.name}» нет войны — объявите её на вкладке «Дипломатия»` };
  }
  const s = (f.settlements || []).find(q => q.x === x && q.y === y);
  if (!s) return { ok: false, reason: 'Поселение уже покинуто' };
  const ok = Army.orderCampaign(sim.armyState, sq.id, fid, s.x, s.y, sim.world);
  return ok ? { ok: true, text: `${sq.name} выступил на ${f.def.name} (${s.x},${s.y})` }
    : { ok: false, reason: 'Дороги туда нет — море или горы' };
}

function fieldMen(sim) {
  let n = 0;
  for (const sq of Army.squadsOf(sim.armyState, 'player')) n += Army.squadSize(sq);
  return n;
}

function atHome(sim, sq) {
  return Math.hypot(sq.x - sim.world.startX, sq.y - sim.world.startY) <= HOME_DIST;
}

function techName(id) {
  const t = TECH_BY_ID[id];
  return t ? t.name : id;
}

function sideName(sim, side) {
  if (side === 'player') return 'ваши войска';
  const f = sim.faction ? sim.faction(side) : null;
  return f && f.def ? f.def.name : side;
}

// ════════════════════════════ ЭКРАН ════════════════════════════
// Возвращает готовую строку HTML в разметке остальных панелей (card/ttl/desc/
// kv/reason/relbar/btn — те же классы, что в ui/panel_market.js).

export function renderPanel(sim) {
  const W = sim && sim.war;
  if (!W) {
    return `<div class="card"><div class="ttl"><span>Война</span></div>
      <div class="desc">Военная система не подключена к этой партии.</div></div>`;
  }
  const st = warStatus(sim);
  const sel = selectedSquad(sim);
  let html = _header(sim, st);
  html += _raidCard(sim);
  html += _form(sim, st);
  html += _squads(sim, sel);
  if (sel) html += _orders(sim, sel);
  html += _points(sim, sel);
  html += _campaigns(sim, sel);
  html += _intel(sim);
  html += _banners(sim);
  return html;
}

function _header(sim, st) {
  const upkeep = st.upkeep || { food: 0, gold: 0 };
  return `<div class="card"><div class="ttl"><span>⚔ Война</span><span class="cost">${_n(st.power)} силы в поле</span></div>
    <div class="desc">Резерв в поселении — это ещё не армия на карте. Бойцы воюют, только когда собраны в отряд и выведены в поле.</div>
    <div class="kv"><span>Резерв / отряды</span><span>${st.reserve} чел. · ${st.squads} отр. (${st.men} чел.)</span></div>
    <div class="kv"><span>Людей в поле</span><span>${st.men}/${st.limit} (население/4)</span></div>
    <div class="kv"><span>Содержание отрядов</span><span>${_f(upkeep.food)}🍞 ${_f(upkeep.gold)}🪙 в день</span></div>
    <div class="kv"><span>Осадный парк</span><span>${st.engines ? `${st.engines} машин` : 'нет'}</span></div>
    <div class="kv"><span>Наши точки</span><span>${st.points} · доход ${_income(sim)}</span></div>
    <div class="kv"><span>Линия фронта</span><span>${st.frontCells ? `${st.frontCells} клеток соприкосновения` : 'нет соприкосновения'}</span></div>
    <div class="kv"><span>Боёв / взято поселений</span><span>${st.battles} · ${st.captures}</span></div>
    ${st.cut ? `<div class="reason">Без снабжения отрядов: ${st.cut}. Через ${Math.ceil(Front.SUPPLY_MAX / Front.SUPPLY_DRAIN)} дн. пустых обозов начнётся дезертирство.</div>` : ''}</div>`;
}

// Набег показывается отдельной карточкой: это единственная угроза, у которой
// есть срок и которую можно снять действием игрока.
function _raidCard(sim) {
  const W = sim.war;
  const foe = W.raid.squadId ? Army.findSquad(sim.armyState, W.raid.squadId) : null;
  if (!foe) {
    if (sim.raids && sim.raids.off) return '';
    const days = sim.raids ? Math.max(0, sim.raids.timer) : 0;
    if (sim.eraIndex < 2) return '';
    return `<div class="card"><div class="ttl"><span>🏕 Набеги</span><span class="cost">~${days} дн.</span></div>
      <div class="desc">Когда разведка поднимет тревогу, враг выйдет в поле настоящим отрядом — его можно встретить на подходе.</div></div>`;
  }
  const d = Math.hypot(foe.x - sim.world.startX, foe.y - sim.world.startY);
  return `<div class="card"><div class="ttl"><span>⚠ ${foe.name}</span><span class="cost">${Math.round(d)} клеток до дома</span></div>
    <div class="desc">${Army.squadReport(foe)}</div>
    <div class="desc">Разбейте его в поле — и волна не дойдёт до поселения. Дойдёт — примут стены и гарнизон.</div>
    <button class="btn danger" style="width:100%;margin-top:8px" data-war="intercept">Перехватить выбранным отрядом</button></div>`;
}

function _form(sim, st) {
  let html = '<h4 class="group">Формирование отряда</h4>';
  const avail = Army.availableUnits(sim.techs);
  if (!avail.length) {
    return html + `<div class="card"><div class="ttl"><span>Родов войск нет</span></div>
      <div class="reason">Изучите «${techName('warfare')}» — она открывает ополчение и осадные машины.</div></div>`;
  }
  if (st.reserve < 1) {
    html += `<div class="card"><div class="ttl"><span>Резерв пуст</span></div>
      <div class="desc">Обучайте бойцов на вкладке «Армия»: они копятся в поселении, а сюда выходят отрядами.</div></div>`;
  }
  if (st.room < 1) {
    html += `<div class="card"><div class="ttl"><span>Лимит армии в поле</span><span class="cost">${st.men}/${st.limit}</span></div>
      <div class="reason">Больше людей поселение в поле не прокормит. Растите население или распустите отряд дома.</div></div>`;
  }
  // Кнопка формирует ровно столько, сколько влезает: и резерв, и лимит поля.
  const most = Math.min(st.reserve, st.room);
  for (const u of avail) {
    const hint = ROLE_HINT[u.role] ? ` · ${ROLE_HINT[u.role]}` : '';
    let btns = '<div class="btns" style="display:flex;gap:6px;margin-top:8px">';
    for (const n of FORM_LOTS) {
      const can = most >= n;
      btns += `<button class="btn ${can ? '' : 'disabled'}" style="flex:1;padding:8px;font-size:12px"
        data-war="form:${u.id}:${n}"${can ? '' : ' disabled'}>×${n}</button>`;
    }
    btns += `<button class="btn ${most >= 1 ? 'primary' : 'disabled'}" style="flex:1;padding:8px;font-size:12px"
      data-war="form:${u.id}:all"${most >= 1 ? '' : ' disabled'}>Все ${most}</button></div>`;
    html += `<div class="card"><div class="ttl"><span>${u.name}</span><span class="cost">сила ${u.power + (sim.army.powerBonus || 0)}</span></div>
      <div class="desc">${ROLE_RU[u.role]}${hint} · скорость ${_speedOf(u.role)} клеток в день</div>${btns}</div>`;
  }
  return html;
}

function _squads(sim, sel) {
  const W = sim.war;
  const list = Army.squadsOf(sim.armyState, 'player');
  let html = `<h4 class="group">Отряды в поле (${list.length})</h4>`;
  if (!list.length) {
    return html + `<div class="card"><div class="ttl"><span>Отрядов нет</span></div>
      <div class="desc">Соберите отряд из резерва — он появится у поселения, и картой можно будет распоряжаться: занимать точки, резать чужое снабжение, ходить на города соседей.</div></div>`;
  }
  for (const sq of list) {
    const tile = tileAt(sim.world, sq.x, sq.y);
    const sup = Front.supplyOf(W.front.state, sq.id);
    const bearer = Front.hasBearer(W.front.state, sq.id);
    const isSel = sel && sel.id === sq.id;
    const parts = [];
    for (const [uid, n] of Object.entries(sq.units || {})) if (n > 0) parts.push(`${UNIT_BY_ID[uid].name} ×${n}`);
    for (const [eid, n] of Object.entries(sq.engines || {})) if (n > 0) parts.push(`${Army.engineDef(eid).name} ×${n}`);

    const moraleCol = sq.morale >= 70 ? 'var(--good)' : sq.morale >= 35 ? 'var(--warn)' : 'var(--bad)';
    const supCol = sup.cut ? 'var(--bad)' : sup.val >= 60 ? 'var(--good)' : 'var(--warn)';
    const terrain = tile === TILE.HILL ? ' · на холме: стрелки бьют дальше'
      : tile === TILE.FOREST ? ' · в лесу: стрелкам и коннице тесно' : '';

    html += `<div class="card">
      <div class="ttl"><span>${isSel ? '▸ ' : ''}${bearer ? '🚩 ' : ''}${sq.name}</span>
        <span class="cost">${_n(Army.squadPower(sq, tile))} силы</span></div>
      <div class="desc">${parts.join(', ') || 'пусто'} · (${Math.round(sq.x)},${Math.round(sq.y)})${terrain}</div>
      <div class="kv"><span>Дух</span><span style="color:${moraleCol}">${Math.round(sq.morale)}%</span></div>
      <div class="relbar"><div style="width:${Math.round(sq.morale)}%;background:${moraleCol}"></div></div>
      <div class="kv"><span>Припасы</span><span style="color:${supCol}">${Math.round(sup.val)}%${sup.cut ? ' · обоз перерезан' : ''}</span></div>
      <div class="relbar"><div style="width:${Math.round(sup.val)}%;background:${supCol}"></div></div>
      <div class="kv"><span>Усталость</span><span>${Math.round(sup.fat)}${sup.fat >= Front.FATIGUE_DESERT ? ' · дезертирство' : ''}</span></div>
      <div class="desc">Приказ: ${_orderText(sq)}</div>
      ${sq.siege ? `<div class="desc">Осада: ворота ${Math.round(sq.siege.gate)}/${Math.round(sq.siege.gateMax)} · стены ${Math.round(sq.siege.wall)}/${Math.round(sq.siege.wallMax)}${sq.siege.breach ? ' · ПРОЛОМ' : ''}</div>` : ''}
      ${bearer ? `<div class="desc">Знаменосец: +${Front.BANNER_AURA} духа союзникам в ${Front.BANNER_RADIUS} клетках. Погибнет — дух соседей упадёт на ${Front.BANNER_SHOCK}.</div>` : ''}
      ${sup.cut ? '<div class="reason">Обоз не доходит: голод роняет дух, затем люди начинают разбегаться.</div>' : ''}
      ${isSel ? '' : `<button class="btn" style="width:100%;margin-top:8px" data-war="sel:${sq.id}">Выбрать для приказов</button>`}</div>`;
  }
  return html;
}

function _orders(sim, sq) {
  const W = sim.war;
  const bearer = Front.hasBearer(W.front.state, sq.id);
  const home = atHome(sim, sq);
  let html = `<h4 class="group">Приказы: ${sq.name}</h4>`;
  html += `<div class="card"><div class="ttl"><span>Манёвр</span><span class="cost">${_n(Army.squadSpeed(sq))} кл./день</span></div>
    <div class="btns" style="display:flex;gap:6px;margin-top:6px">
      <button class="btn" style="flex:1;padding:8px" data-war="hold">Стоять</button>
      <button class="btn" style="flex:1;padding:8px" data-war="home">В поселение</button>
      <button class="btn ${home ? '' : 'disabled'}" style="flex:1;padding:8px" data-war="disband"${home ? '' : ' disabled'}>Распустить</button>
    </div>
    ${home ? '' : '<div class="reason">Распустить отряд можно только дома.</div>'}</div>`;

  html += `<div class="card"><div class="ttl"><span>🚩 Знаменосец</span><span class="cost">${BEARER_COST.gold}🪙</span></div>
    <div class="desc">Поднимает дух союзникам рядом, а после победы ставит знамя на поле битвы — с днём и названием сражения.</div>
    ${bearer ? '<div class="desc">Уже в строю.</div>'
      : `<button class="btn primary" style="width:100%;margin-top:6px" data-war="bearer">Нанять знаменосца</button>`}</div>`;

  const engines = Army.availableEngines(sim.techs);
  html += '<h4 class="group">Осадный парк</h4>';
  if (!engines.length) {
    html += `<div class="card"><div class="ttl"><span>Машин нет</span></div>
      <div class="reason">Тараны и лестницы открывает «${techName('warfare')}», катапульту — «${techName('mathematics')}».</div></div>`;
  } else {
    for (const e of engines) {
      const lack = sim.lackCost(e.cost);
      const can = home && !lack && Army.squadSize(sq) >= e.crew;
      const target = e.target === 'gate' ? 'бьёт ворота' : 'ломает стену';
      const why = !home ? 'отряд не в поселении' : lack ? `не хватает: ${lack}` : `нужен расчёт ${e.crew} чел.`;
      html += `<div class="card"><div class="ttl"><span>${e.name}</span><span class="cost">${_cost(sim, e.cost)}</span></div>
        <div class="desc">${target} · сила ${e.power} · расчёт ${e.crew} · обоз замедляет отряд до ${e.speed} кл./день</div>
        <button class="btn ${can ? '' : 'disabled'}" style="width:100%;margin-top:6px" data-war="engine:${e.id}"${can ? '' : ' disabled'}>Собрать</button>
        ${can ? '' : `<div class="reason">Недоступно: ${why}</div>`}</div>`;
    }
    html += `<div class="card"><div class="ttl"><span>Как берут крепость</span></div>
      <div class="desc">Тараны выбивают ворота — тогда штурм идёт в полную силу. Лестницы валят стену — штурм слабее, у защитника остаётся часть бонуса. Без пролома лобовой штурм почти всегда самоубийство.</div></div>`;
  }
  return html;
}

function _points(sim, sel) {
  const st = sim.war.front.state;
  if (!st.points.length) return '';
  let html = '<h4 class="group">Точки на карте</h4>';
  const kindRu = { city: '🏙 Город', mine: '⛏ Рудник', ford: '🌉 Переправа' };
  const sorted = [...st.points].sort((a, b) => _dist(a, sim) - _dist(b, sim));
  for (const p of sorted) {
    const inc = Object.entries(Front.POINT_INCOME[p.kind] || {})
      .map(([k, v]) => `${v}${_resIcon(k)}`).join(' ');
    const own = p.owner === 'player' ? 'наша' : p.owner ? sideName(sim, p.owner) : 'ничья';
    const col = p.owner === 'player' ? 'var(--good)' : p.owner ? 'var(--bad)' : 'var(--warn)';
    const d = sel ? Math.round(Math.hypot(sel.x - p.x, sel.y - p.y)) : null;
    html += `<div class="card"><div class="ttl"><span>${kindRu[p.kind] || p.name}</span>
        <span class="cost" style="color:${col}">${own}</span></div>
      <div class="desc">${p.name} (${p.x},${p.y}) · доход ${inc || '—'} в день${d != null ? ` · ${d} клеток от отряда` : ''}</div>
      ${sel ? `<button class="btn" style="width:100%;margin-top:6px" data-war="point:${p.id}">Направить отряд</button>` : ''}</div>`;
  }
  html += `<div class="card"><div class="desc">Точка переходит к тому, чьи отряды стоят у неё одни: спорную не берёт никто. Свой город ещё и снабжает армию — обоз идёт от ближайшего.</div></div>`;
  return html;
}

function _campaigns(sim, sel) {
  const wars = (sim.wars || []).map(w => sim.faction(w.fid)).filter(f => f && f.alive);
  let html = '<h4 class="group">Походы</h4>';
  if (!wars.length) {
    return html + `<div class="card"><div class="ttl"><span>Войн нет</span></div>
      <div class="desc">Поход на чужой город возможен только при объявленной войне — объявляют её на вкладке «Дипломатия».</div></div>`;
  }
  for (const f of wars) {
    for (const s of f.settlements || []) {
      const d = sel ? Math.round(Math.hypot(sel.x - s.x, sel.y - s.y)) : null;
      html += `<div class="card"><div class="ttl"><span><span style="color:${f.def.color}">⬤</span> ${f.def.name}${s.capital ? ' · столица' : ''}</span>
          <span class="cost">${Math.round(f.armyPts)} армии</span></div>
        <div class="desc">Поселение (${s.x},${s.y})${d != null ? ` · ${d} клеток от отряда` : ''}. Отряд сам развернёт осаду, проломит ворота или стену и пойдёт на штурм.</div>
        ${sel ? `<button class="btn danger" style="width:100%;margin-top:6px" data-war="camp:${f.id}:${s.x}:${s.y}">Выступить в поход</button>`
          : '<div class="reason">Выберите отряд, чтобы отдать приказ.</div>'}</div>`;
    }
  }
  return html;
}

function _intel(sim) {
  const W = sim.war;
  const known = Front.knownEnemies(W.front.state, 'player', sim.day);
  let html = '<h4 class="group">Разведка</h4>';
  if (!known.length) {
    return html + `<div class="card"><div class="ttl"><span>Врагов не видно</span></div>
      <div class="desc">Отряд видит на ${Front.VISION_BASE} клеток вокруг, с холма — дальше. Свои точки тоже смотрят по сторонам.</div></div>`;
  }
  for (const k of known) {
    const sq = Army.findSquad(sim.armyState, k.id);
    const seen = k.fresh && sq;
    html += `<div class="card"><div class="ttl"><span>${seen ? '👁 ' : '👻 '}${sideName(sim, k.side)}</span>
        <span class="cost">${seen ? 'виден' : `день ${k.day}`}</span></div>
      <div class="desc">${seen ? Army.squadReport(sq) : `Последний раз замечен у (${k.x},${k.y}). Призрак останется, пока разведка не увидит эту клетку пустой.`}</div></div>`;
  }
  return html;
}

function _banners(sim) {
  const banners = [...sim.war.front.state.banners].sort((a, b) => b.day - a.day);
  let html = `<h4 class="group">Знамёна побед (${banners.length})</h4>`;
  if (!banners.length) {
    return html + `<div class="card"><div class="ttl"><span>Знамён нет</span></div>
      <div class="desc">Знамя ставит знаменосец на месте выигранного боя. Оно остаётся на карте навсегда — с днём и названием сражения.</div></div>`;
  }
  for (const b of banners) {
    const mine = b.side === 'player';
    html += `<div class="card"><div class="ttl"><span>${mine ? '🚩' : '🏴'} ${b.name}</span>
        <span class="cost" style="color:${mine ? 'var(--good)' : 'var(--bad)'}">день ${b.day}</span></div>
      <div class="desc">${mine ? 'Победа наших войск' : `Победа: ${sideName(sim, b.side)}`} · поле у (${b.x},${b.y})</div></div>`;
  }
  return html;
}

// ---------------- Привязка обработчиков ----------------
// Образец — bindMarketPanel: свой data-атрибут, чтобы чужие обработчики в
// Hud.bindPanel не затирали этот своим `c.onclick = ...`.
// ctx: { toast(text, type), audio.play(name), refresh() }.

export function bindPanel(root, sim, ctx = {}) {
  if (!root || typeof root.querySelectorAll !== 'function' || !sim) return 0;
  const nodes = root.querySelectorAll('[data-war]');
  let bound = 0;
  for (const el of Array.from(nodes)) {
    const spec = (el.dataset && el.dataset.war)
      || (typeof el.getAttribute === 'function' ? el.getAttribute('data-war') : '');
    el.onclick = () => {
      const r = handleWarAction(sim, spec);
      if (!r.ok) {
        if (ctx.toast) ctx.toast(r.reason, 'warn');
        if (ctx.audio) ctx.audio.play('deny');
      } else {
        if (ctx.toast && r.text) ctx.toast(r.text, 'good');
        if (ctx.audio) ctx.audio.play('click');
      }
      if (ctx.refresh) ctx.refresh();
      return r;
    };
    bound++;
  }
  return bound;
}

// ---------------- Мелочи форматирования ----------------

function _orderText(sq) {
  const o = sq.order || { type: 'hold' };
  if (o.type === 'hold') return 'стоит на месте';
  if (o.type === 'move') return `марш к (${o.tx},${o.ty})`;
  if (o.type === 'attack') return 'атакует вражеский отряд';
  if (o.type === 'capture') return `поход на поселение (${o.tx},${o.ty})`;
  return o.type;
}

// Скорость рода войск показываем через сам модуль: своя таблица разошлась бы с
// его SPEED_BY_ROLE при первой же правке баланса.
function _speedOf(role) {
  const probe = { units: {}, engines: {} };
  const u = UNITS.find(x => x.role === role);
  if (!u) return 6;
  probe.units[u.id] = 1;
  return Army.squadSpeed(probe);
}

function _dist(p, sim) {
  return Math.hypot(p.x - sim.world.startX, p.y - sim.world.startY);
}

function _income(sim) {
  const inc = Front.pointIncomePerDay(sim.war.front.state, 'player');
  const parts = Object.entries(inc).map(([k, v]) => `${_f(v)}${_resIcon(k)}`);
  return parts.length ? parts.join(' ') : '—';
}

const RES_ICON = { food: '🍞', wood: '🪵', stone: '🪨', steel: '⚙️', gold: '🪙', knowledge: '📜' };
function _resIcon(id) { return RES_ICON[id] || id; }

function _cost(sim, cost) {
  const m = typeof sim.costMult === 'function' ? sim.costMult() : 1;
  return Object.entries(cost || {}).map(([r, v]) => `${_resIcon(r)}${Math.ceil(v * m)}`).join(' ') || '—';
}

function _n(v) { return Math.round(v); }
function _f(v) { return (Math.round(v * 10) / 10).toFixed(1); }

/* ПОДКЛЮЧЕНИЕ

Пять вставок в app/src/core/simulation.js и четыре в app/src/ui/hud.js.
Ни одна существующая строка не меняется — только добавляются новые ПОСЛЕ
указанных якорей. Все якоря проверены на уникальность (grep -F, по одному
совпадению на файл).

──────────────── app/src/core/simulation.js ────────────────

[1] ЯКОРЬ (строка 7):
import { installSystems, systemsNewDay, systemsFactions, systemsHappyMod, systemsWorkMult, systemsSerialize, systemsRestore } from './systems/integrate.js';

ВСТАВИТЬ ПОСЛЕ:
import * as War from './systems/wire_army.js';

[2] ЯКОРЬ (конструктор, строка 109):
    installSystems(this);

ВСТАВИТЬ ПОСЛЕ:
    // Армия на карте и фронт: нужен готовый мир и уже расселённые фракции.
    War.install(this);

[3] ЯКОРЬ (onNewDay, строка 987):
    this.tickMarket();

ВСТАВИТЬ ПОСЛЕ:
    War.onNewDay(this);

[4] ЯКОРЬ (serialize, строка 1729):
      sys: systemsSerialize(this),

ВСТАВИТЬ ПОСЛЕ:
      war: War.serialize(this),

[5] ЯКОРЬ (deserialize, строка 1766):
    systemsRestore(sim, data.sys);

ВСТАВИТЬ ПОСЛЕ:
    War.restore(sim, data.war);

──────────────── app/src/ui/hud.js ────────────────

[6] ЯКОРЬ (строка 6):
import { renderMarketPanel, bindMarketPanel, createMarketPanelState } from './panel_market.js';

ВСТАВИТЬ ПОСЛЕ:
import * as War from '../core/systems/wire_army.js';

[7] ЯКОРЬ (массив TABS, строка 19):
  { id: 'army', ru: 'Армия', ic: '⚔️' },

ВСТАВИТЬ ПОСЛЕ:
  { id: 'war', ru: 'Фронт', ic: '🚩' },

[8] ЯКОРЬ (строка 869):
  panel_market() { return renderMarketPanel(this.sim, this.marketState); }

ВСТАВИТЬ ПОСЛЕ:
  panel_war() { return War.renderPanel(this.sim); }

[9] ЯКОРЬ (конец метода bindPanel, строки 546–550 — пять строк целиком):
    bindMarketPanel(root, this.sim, {
      toast: (t, k) => this.toast(t, k),
      audio: this.audio,
      refresh: () => this.renderPanel(),
    });

ВСТАВИТЬ ПОСЛЕ:
    War.bindPanel(root, this.sim, {
      toast: (t, k) => this.toast(t, k),
      audio: this.audio,
      refresh: () => this.renderPanel(),
    });

──────────────── Необязательно: рендер карты ────────────────
Панель самодостаточна, но отряды приятнее видеть на карте. В renderer.js:
  отряды  — Army.allSquads(sim.armyState): точка (ox + sq.x*z, oy + sq.y*z),
            цвет по sq.side, подпись Army.squadReport(sq);
  знамёна — sim.front.state.banners: {x, y, day, name};
  фронт   — sim.front.state.cells;
  туман   — чужой отряд рисовать только если
            Front.canSee(sim.front.state, sim.armyState, 'player', sq.x, sq.y, sim.world),
            иначе призрак по Front.knownEnemies(sim.front.state, 'player', sim.day).

──────────────── Что увидит игрок после вставки ────────────────
· Вкладка «Фронт»: резерв и отряды, состав, дух, припасы, усталость, приказы.
· Формирование отряда любого открытого рода войск — контр-система становится
  выбором игрока, а не строчкой в таблице.
· Осадный парк, знаменосец, походы на города соседей, захват точек с доходом.
· Набеги перестают быть таймером: враг выходит настоящим отрядом, и его можно
  разбить на подходе.
· Знамёна побед — с днём и названием сражения.
*/
