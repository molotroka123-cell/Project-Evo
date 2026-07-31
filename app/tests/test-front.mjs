// Тест боевых действий на карте: node app/tests/test-front.mjs
// Проверяются числа и границы: снабжение (регенерация/просадка/дезертирство),
// перехват дороги, захват и доход точек, знаменосцы (аура, гибель, знамя),
// отброс разбитого отряда, туман войны и детерминизм сейва.
import * as Front from '../src/core/systems/front.js';
import * as Army from '../src/core/systems/army.js';
import { createRng } from '../src/core/rng.js';
import { TILE } from '../src/core/data.js';

let ok = 0, fail = 0;
function check(name, cond, info = '') {
  if (cond) { ok++; console.log('OK   ' + name); }
  else { fail++; console.log('FAIL ' + name + (info ? ' — ' + info : '')); }
}

function makeWorld(w, h, fill = TILE.GRASS) {
  return { w, h, tiles: new Uint8Array(w * h).fill(fill), startX: 2, startY: 2 };
}
function setT(world, x, y, t) { world.tiles[y * world.w + x] = t; }

const WAR = () => true;
const PEACE = () => false;

// ---------- 1. Генерация точек по карте ----------
{
  const w = makeWorld(20, 20);
  setT(w, 5, 5, TILE.MOUNTAIN);
  setT(w, 5, 6, TILE.HILL);                    // рудник: холм у горы
  setT(w, 15, 14, TILE.WATER); setT(w, 15, 16, TILE.WATER);
  setT(w, 15, 15, TILE.SAND);                  // переправа: песок между двумя водами
  const st = Front.createFrontState();
  const created = Front.generatePoints(st, w, createRng(7));
  check('generatePoints: найдены рудник и переправа', created.length === 2, 'создано ' + created.length);
  const mine = st.points.find(p => p.kind === 'mine');
  const ford = st.points.find(p => p.kind === 'ford');
  check('generatePoints: рудник на холме у горы', !!mine && mine.x === 5 && mine.y === 6);
  check('generatePoints: переправа на косе', !!ford && ford.x === 15 && ford.y === 15);
  check('generatePoints: точки ничьи при создании', st.points.every(p => p.owner === null));
}

// ---------- 2. Снабжение: линия жива / слишком длинная / перехвачена ----------
{
  const w = makeWorld(96, 8);
  const st = Front.createFrontState();
  const army = Army.createArmyState();
  const sq = Army.formSquad(army, { side: 'player', x: 20, y: 4, units: { militia: 10 } });
  const src = [{ x: 2, y: 4, side: 'player' }];
  const near = Front.supplyStatus(st, sq, { world: w, sources: src, hostiles: [] });
  check('снабжение: короткая линия жива', near.connected && near.length <= 20 + 2);
  sq.x = 55;
  const far = Front.supplyStatus(st, sq, { world: w, sources: src, hostiles: [] });
  check('снабжение: за пределом SUPPLY_RANGE линия рвётся', !far.connected, far.reason);
  sq.x = 20;
  const foe = Army.formSquad(army, { side: 'wolves', x: 11, y: 4, units: { militia: 5 } });
  const cut = Front.supplyStatus(st, sq, { world: w, sources: src, hostiles: [foe] });
  check('снабжение: враг на дороге режет линию', !cut.connected && cut.reason.includes('перехвачена'));
  // Свой город-точка — тоже источник: захват меняет снабжение.
  Front.addCityPoint(st, 30, 4, 'Форт', 'player');
  const viaCity = Front.supplyStatus(st, sq, { world: w, sources: [], hostiles: [] });
  check('снабжение: захваченный город становится источником', viaCity.connected);
}

// ---------- 3. Разрыв снабжения: просадка → голод → дезертирство ----------
{
  const w = makeWorld(40, 40);
  const st = Front.createFrontState();
  const army = Army.createArmyState();
  const rng = createRng(11);
  const sq = Army.formSquad(army, { side: 'player', x: 20, y: 20, units: { militia: 20 } });
  const ctx = { world: w, dt: 1, day: 0, factions: [], atWar: PEACE, sources: [] };
  for (let d = 1; d <= 2; d++) Front.tickWar(st, army, { ...ctx, day: d }, rng);
  check('снабжение: −SUPPLY_DRAIN в день без линии', Front.supplyOf(st, sq.id).val === 100 - 2 * Front.SUPPLY_DRAIN);
  for (let d = 3; d <= 4; d++) Front.tickWar(st, army, { ...ctx, day: d }, rng);
  const r4 = Front.supplyOf(st, sq.id);
  check('снабжение: припасы ещё есть — усталости нет', r4.val === 20 && r4.fat === 0 && sq.morale === 100);
  for (let d = 5; d <= 7; d++) Front.tickWar(st, army, { ...ctx, day: d }, rng);
  // supplyOf отдаёт живую запись — снимаем значения до следующего дня
  const r7 = { ...Front.supplyOf(st, sq.id) };
  check('голод: припасы на нуле, усталость накоплена', r7.val === 0 && r7.fat >= Front.FATIGUE_DESERT);
  check('голод: дух падает', sq.morale < 100);
  check('дезертирство: отряд тает (20 → ' + Army.squadSize(sq) + ')', Army.squadSize(sq) === 17);
  // Восстановление: линия вернулась — припасы растут, усталость уходит.
  Front.tickWar(st, army, { ...ctx, day: 8, sources: [{ x: 20, y: 18, side: 'player' }] }, rng);
  const r8 = Front.supplyOf(st, sq.id);
  check('снабжение: с линией припасы восстанавливаются', r8.val === Front.SUPPLY_REGEN && r8.fat < r7.fat && !r8.cut);
}

// ---------- 4. Бой: знаменосцы, знамя, шок, фронт ----------
function battleScenario(seed) {
  const w = makeWorld(40, 40);
  const st = Front.createFrontState();
  const army = Army.createArmyState();
  const rng = createRng(seed);
  const a = Army.formSquad(army, { side: 'player', x: 10, y: 10, units: { militia: 30 }, powerBonus: 5 });
  const b = Army.formSquad(army, { side: 'wolves', x: 10, y: 11, units: { militia: 5 } });
  const c = Army.formSquad(army, { side: 'wolves', x: 13, y: 10, units: { militia: 10 } });
  Front.addBearer(st, a.id);
  Front.addBearer(st, b.id);
  const sources = [{ x: 10, y: 9, side: 'player' }, { x: 14, y: 10, side: 'wolves' }];
  const ev = Front.tickWar(st, army, { world: w, dt: 1, day: 3, factions: [], atWar: WAR, sources }, rng);
  return { st, army, a, b, c, ev };
}
{
  const { st, army, a, b, c, ev } = battleScenario(42);
  check('бой: слабый отряд уничтожен', !Army.findSquad(army, b.id));
  check('знаменосец: у проигравшего погиб', !Front.hasBearer(st, b.id));
  check('знаменосец: у победителя жив', Front.hasBearer(st, a.id));
  check('знаменосец: шок роняет дух соседей проигравшего', c.morale <= 100 - Front.BANNER_SHOCK + 10, 'morale=' + c.morale);
  check('знамя: поставлено на поле победы', st.banners.length === 1);
  const bn = st.banners[0];
  check('знамя: день, сторона и название сражения', bn.day === 3 && bn.side === 'player' && bn.name.includes('Битва'), JSON.stringify(bn));
  check('знамя: стоит у места гибели проигравшего', Math.hypot(bn.x - 10, bn.y - 11) <= 1);
  check('фронт: клетки соприкосновения есть', st.cells.length >= 1);
  const cell = st.cells[0];
  check('фронт: клетка между враждебными сторонами', cell.a !== cell.b);
  check('события: гибель знаменосца попала в лог', ev.some(e => e.text.includes('Знаменосец пал')));
  check('события: водружение знамени попало в лог', ev.some(e => e.text.includes('водрузил знамя')));
}

// ---------- 5. Отброс разбитого отряда (продвижение фронта) ----------
{
  const w = makeWorld(40, 40);
  const st = Front.createFrontState();
  const army = Army.createArmyState();
  const rng = createRng(5);
  const a = Army.formSquad(army, { side: 'player', x: 20, y: 20, units: { militia: 60 } });
  const b = Army.formSquad(army, { side: 'wolves', x: 20, y: 21, units: { militia: 25 } });
  const sources = [{ x: 20, y: 18, side: 'player' }, { x: 20, y: 24, side: 'wolves' }];
  Front.tickWar(st, army, { world: w, dt: 1, day: 1, factions: [], atWar: WAR, sources }, rng);
  const loser = Army.findSquad(army, b.id);
  const winner = Army.findSquad(army, a.id);
  check('отброс: победитель уцелел', !!winner);
  if (loser) {
    check('отброс: разбитый отряд отброшен от победителя',
      Math.hypot(loser.x - winner.x, loser.y - winner.y) >= Front.RETREAT_DIST - 0.5,
      `dist=${Math.hypot(loser.x - winner.x, loser.y - winner.y).toFixed(2)}`);
  } else {
    check('отброс: проигравший уничтожен на месте (отбрасывать некого)', true);
  }
}

// ---------- 6. Захват точек и доход ----------
{
  const w = makeWorld(40, 40);
  const st = Front.createFrontState();
  const army = Army.createArmyState();
  const rng = createRng(3);
  const mine = Front.addPoint(st, 'mine', 8, 8, 'Рудник Испытаний');
  Front.addCityPoint(st, 30, 30, 'Вольный город');
  const p = Army.formSquad(army, { side: 'player', x: 8, y: 8, units: { militia: 10 } });
  const ctx = { world: w, dt: 1, day: 1, factions: [], atWar: PEACE, sources: [{ x: 8, y: 6, side: 'player' }] };
  const ev = Front.tickWar(st, army, ctx, rng);
  check('захват: одинокий отряд берёт точку', mine.owner === 'player');
  check('захват: событие в логе', ev.some(e => e.text.includes('перешёл под контроль')));
  const inc = Front.pointIncomePerDay(st, 'player');
  check('доход: рудник платит по таблице', inc.gold === Front.POINT_INCOME.mine.gold && inc.stone === 1, JSON.stringify(inc));
  // Спорная точка не захватывается: рядом встал враг.
  const e2 = Army.formSquad(army, { side: 'wolves', x: 9, y: 9, units: { militia: 10 } });
  mine.owner = null;
  Front.tickWar(st, army, { ...ctx, day: 2, sources: [...ctx.sources, { x: 12, y: 9, side: 'wolves' }] }, rng);
  check('захват: спорную точку не берёт никто', mine.owner === null);
  check('захват: далёкий город остался ничьим', st.points.find(x => x.kind === 'city').owner === null);
  void p; void e2;
}

// ---------- 7. Знаменосец: аура духа союзникам в радиусе ----------
{
  const w = makeWorld(40, 40);
  const st = Front.createFrontState();
  const army = Army.createArmyState();
  const rng = createRng(9);
  const bearer = Army.formSquad(army, { side: 'player', x: 5, y: 5, units: { militia: 5 } });
  const ally = Army.formSquad(army, { side: 'player', x: 8, y: 5, units: { militia: 5 } });
  const farAlly = Army.formSquad(army, { side: 'player', x: 30, y: 30, units: { militia: 5 } });
  ally.morale = 50; farAlly.morale = 50;
  Front.addBearer(st, bearer.id);
  const sources = [{ x: 5, y: 4, side: 'player' }, { x: 30, y: 29, side: 'player' }];
  Front.tickWar(st, army, { world: w, dt: 1, day: 1, factions: [], atWar: PEACE, sources }, rng);
  // +BANNER_AURA от знамени и +MORALE_REGEN(6) от дневного отдыха в army.js
  check('аура: союзник в радиусе получает бонус духа', ally.morale === 50 + Front.BANNER_AURA + Army.MORALE_REGEN, 'morale=' + ally.morale);
  check('аура: вне радиуса — только обычный отдых', farAlly.morale === 50 + Army.MORALE_REGEN, 'morale=' + farAlly.morale);
}

// ---------- 8. Разведка и туман войны ----------
{
  const w = makeWorld(40, 40);
  setT(w, 6, 5, TILE.HILL);
  const st = Front.createFrontState();
  const army = Army.createArmyState();
  const rng = createRng(13);
  const p = Army.formSquad(army, { side: 'player', x: 5, y: 5, units: { militia: 5 } });
  const e = Army.formSquad(army, { side: 'wolves', x: 10, y: 5, units: { militia: 5 } });
  const sources = [{ x: 5, y: 4, side: 'player' }, { x: 11, y: 5, side: 'wolves' }];
  const ctx = { world: w, dt: 1, day: 1, factions: [], atWar: PEACE, sources };
  check('зрение: с холма видно дальше', Front.visionOf({ x: 6, y: 5 }, w) === Front.VISION_BASE + Front.VISION_HILL);
  Front.tickWar(st, army, ctx, rng);
  const seen = Front.lastKnown(st, 'player', e.id);
  check('разведка: враг в радиусе видимости замечен', !!seen && seen.x === 10 && seen.y === 5 && seen.day === 1);
  // Враг ушёл за горизонт, разведчик тоже отошёл — остаётся «призрак».
  e.x = 30; e.y = 30; p.x = 20; p.y = 5;
  Front.tickWar(st, army, { ...ctx, day: 2 }, rng);
  const ghost = Front.lastKnown(st, 'player', e.id);
  check('туман: вне видимости — последняя известная позиция', !!ghost && ghost.x === 10 && ghost.y === 5);
  check('туман: запись помечена устаревшей', Front.knownEnemies(st, 'player', 2).every(g => g.id !== e.id || !g.fresh));
  check('туман: реальная позиция врага игроку неизвестна', !(ghost.x === 30 && ghost.y === 30));
  // Разведчик дошёл до врага — позиция обновилась.
  p.x = 28; p.y = 28;
  Front.tickWar(st, army, { ...ctx, day: 3 }, rng);
  const fresh = Front.lastKnown(st, 'player', e.id);
  check('разведка: контакт восстановлен — позиция обновлена', !!fresh && fresh.x === 30 && fresh.y === 30 && fresh.day === 3);
  // Разведка увидела старую клетку пустой — призрак с неё стёрт (проверяем на враге, ушедшем из виду).
  check('туман: canSee не видит дальний угол', !Front.canSee(st, army, 'player', 1, 39, w));
}

// ---------- 9. Сериализация и детерминизм ----------
{
  const one = battleScenario(42);
  const two = battleScenario(42);
  check('детерминизм: один сид — одна война',
    JSON.stringify(Front.serializeFront(one.st)) === JSON.stringify(Front.serializeFront(two.st))
    && JSON.stringify(Army.serializeArmy(one.army)) === JSON.stringify(Army.serializeArmy(two.army)));
  const raw = JSON.parse(JSON.stringify(Front.serializeFront(one.st)));
  const back = Front.deserializeFront(raw);
  check('сейв: полный круг сериализации без потерь',
    JSON.stringify(Front.serializeFront(back)) === JSON.stringify(Front.serializeFront(one.st)));
  const empty = Front.deserializeFront(undefined);
  check('сейв: старый сейв без поля front грузится пустым состоянием',
    empty.points.length === 0 && empty.banners.length === 0 && Object.keys(empty.supply).length === 0);
}

// ---------- 10. Система-адаптер для ядра ----------
{
  const w = makeWorld(40, 40);
  const sys = Front.createFrontSystem();
  Front.addPoint(sys.state, 'mine', 8, 8, 'Рудник', 'player');
  const sim = {
    world: w, day: 1, factions: [], wars: [], aiWars: [],
    armyState: Army.createArmyState(), rng: createRng(21),
    res: { food: 0, wood: 0, stone: 0, steel: 0, gold: 0, knowledge: 0 },
  };
  sys.onNewDay(sim);
  check('адаптер: доход точек капает в ресурсы игрока',
    sim.res.gold === Front.POINT_INCOME.mine.gold && sim.res.stone === 1, JSON.stringify(sim.res));
  const dump = sys.serialize();
  sys.deserialize(JSON.parse(JSON.stringify(dump)));
  check('адаптер: serialize/deserialize согласованы', JSON.stringify(sys.serialize()) === JSON.stringify(dump));
}

console.log(`=== ${ok} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
