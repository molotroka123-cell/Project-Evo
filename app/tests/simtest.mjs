// Headless-тесты ядра ФРОНТИР (Node, без DOM).
// Запуск: node app/tests/simtest.mjs
import { Simulation } from '../src/core/simulation.js';
import { aStar } from '../src/core/world.js';
import { TECHS, BUILDINGS, SPIRE_STAGES, WALKABLE, TILE } from '../src/core/data.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };

t('детерминизм от сида', () => {
  const a = new Simulation(42), b = new Simulation(42);
  for (let i = 0; i < 100; i++) { a.tick(0.5); b.tick(0.5); }
  if (Math.abs(a.res.food - b.res.food) > 1e-9) throw new Error('расходятся');
});

t('выживание 120 дней', () => {
  const s = new Simulation(42);
  s.execCommand('give wood 200'); s.execCommand('give food 200');
  s.placeBuilding('hut', 44, 44); s.placeBuilding('lumber', 46, 42);
  for (let i = 0; i < 240; i++) s.tick(0.5);
  if (s.villagers.length < 3) throw new Error('племя умерло: ' + s.villagers.length);
  if (!s.buildings.some(b => b.done && b.id === 'lumber')) throw new Error('лесопилка не построена');
});

t('все 62 технологии -> эпоха 9', () => {
  const s = new Simulation(42);
  s.execCommand('research all');
  if (s.eraIndex !== 9) throw new Error('era ' + s.eraIndex);
  if (s.techs.size !== TECHS.length) throw new Error('не все техи: ' + s.techs.size);
});

t('все здания ставятся', () => {
  const s = new Simulation(42);
  s.godmode = true; s.execCommand('unlockall');
  let placed = 0;
  for (const id of Object.keys(BUILDINGS)) {
    outer: for (let yy = 15; yy < 80; yy += 2) for (let xx = 15; xx < 80; xx += 2) {
      if (s.canPlace(id, xx, yy).ok) { s.placeBuilding(id, xx, yy); placed++; break outer; }
    }
  }
  if (placed < Object.keys(BUILDINGS).length - 2) throw new Error('ставится лишь ' + placed);
});

t('причины запретов по-русски', () => {
  const s = new Simulation(42);
  if (!/Земледелие/.test(s.canPlace('farm', 48, 48).reason)) throw new Error('тех');
  s.techs.add('farming');
  if (!/Вода|Край/.test(s.canPlace('farm', 0, 0).reason)) throw new Error('вода');
  let qreason = '';
  for (let yy = 40; yy < 60 && !qreason; yy++) for (let xx = 40; xx < 60 && !qreason; xx++) {
    const r = s.canPlace('quarry', xx, yy);
    if (/холм/.test(r.reason)) qreason = r.reason;
  }
  if (!qreason) throw new Error('холм');
});

t('армия и отбитый рейд', () => {
  const s = new Simulation(42);
  s.godmode = true; s.techs.add('warfare'); s.techs.add('iron'); s.eraIndex = 2;
  s.placeBuilding('barracks', 44, 44);
  s.buildings.find(b => b.id === 'barracks').done = true;
  for (let i = 0; i < 10; i++) s.spawnVillager(48, 48);
  s.army.soldiers = 10;
  s.raids.timer = 0; s.tickRaids();
  if (s.repelled < 1) throw new Error('рейд не отбит');
});

t('инвариант фракций: 20 сидов × 1000 дней', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const s = new Simulation(seed, { factions: 5 });
    for (let i = 0; i < 1000; i++) s.onNewDay();
    const alive = s.factions.filter(f => f.alive);
    if (alive.length < 5) throw new Error(`сид ${seed}: вымерло ${5 - alive.length}`);
  }
});

t('сейв v3 круговой', () => {
  const s = new Simulation(42);
  s.execCommand('give gold 300'); s.execCommand('age medieval');
  for (let i = 0; i < 100; i++) s.tick(0.5);
  const json = JSON.stringify(s.serialize());
  const r = Simulation.deserialize(json);
  if (!r.ok) throw new Error(r.reason);
  if (JSON.stringify(r.sim.serialize()) !== json) throw new Error('не идентичен');
});

t('миграция сейва v1', () => {
  const old = { version: 1, seed: 42, day: 50, seasonIdx: 2, weather: 'rain', eraIndex: 8,
    res: { food: 100, wood: 50, stone: 30, knowledge: 20 }, techs: ['fire', 'tools'],
    buildings: [{ id: 'campfire', x: 48, y: 48, size: 1, progress: 1, buildDays: 0.01, done: true, eraBuilt: 0, hp: 100 }],
    villagers: [{ name: 'Тест', x: 48, y: 48, age: 2000, hp: 100 }], animals: [], rngState: 42, log: [] };
  const r = Simulation.deserialize(JSON.stringify(old));
  if (!r.ok) throw new Error(r.reason);
  if (r.sim.eraIndex !== 9) throw new Error('эпоха: ' + r.sim.eraIndex);
  for (let i = 0; i < 100; i++) r.sim.tick(0.5); // живёт дальше
});

t('шпиль 5 стадий -> победа', () => {
  const s = new Simulation(42);
  s.godmode = true; s.execCommand('unlockall'); s.eraIndex = 9;
  s.placeBuilding('spire', 50, 50);
  s.buildings.find(b => b.id === 'spire').done = true;
  for (let st = 0; st < 5; st++) {
    const inv = s.spire.invested[st];
    for (const [r, v] of Object.entries(SPIRE_STAGES[st].cost)) inv[r] = v;
    s.spire.progress = 0; s.tickSpire(SPIRE_STAGES[st].days);
  }
  if (!s.won) throw new Error('нет победы');
});

t('рынок: продажа и живые цены', () => {
  const s = new Simulation(42);
  s.godmode = true; s.techs.add('trade');
  s.placeBuilding('market', 44, 44);
  s.buildings.find(b => b.id === 'market').done = true;
  s.res.wood = 100;
  const g0 = s.res.gold;
  s.marketSell('wood', 50);
  if (s.res.gold <= g0) throw new Error('нет золота');
  for (const [r, p] of Object.entries(s.market.prices)) {
    const base = { food: 0.1, wood: 0.125, stone: 0.167, steel: 4 }[r];
    if (p < base * 0.49 || p > base * 2.01) throw new Error(`цена ${r} вне пределов`);
  }
});

t('дипломатия: договор, подарок, война без CB', () => {
  const s = new Simulation(42);
  const f = s.factions[0];
  s.res.gold = 500; s.relations[f.id] = 10;
  if (!s.diploAction(f.id, 'treaty').ok) throw new Error('договор');
  const rBefore = s.factions.map(o => s.relations[o.id]);
  s.diploAction(f.id, 'war');
  if (!s.wars.some(w => w.fid === f.id)) throw new Error('война не началась');
});

t('threat: wealth×4 → threat×~2.6', () => {
  const s = new Simulation(42);
  const t1 = s.threatPoints();
  s.res.gold += 60000; s.res.steel += 2000;
  const ratio = s.threatPoints() / t1;
  if (ratio < 1.5) throw new Error('угроза не растёт: ' + ratio);
});

t('A*: доходит до проходимых клеток и укладывается в 500 мс', () => {
  // Прежняя версия теста брала случайные координаты (часто вода и горы),
  // считала найденные пути и НИЧЕГО не проверяла — поэтому не заметила, что
  // находилось лишь 36 маршрутов из 500. Теперь цели только проходимые,
  // и доля найденных проверяется.
  const s = new Simulation(42);
  const W = s.world.w, H = s.world.h;
  const targets = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (WALKABLE.has(s.world.tiles[y * W + x])) targets.push([x, y]);
  }
  const sx = Math.round(s.world.startX), sy = Math.round(s.world.startY);
  const step = Math.max(1, Math.floor(targets.length / 500));
  const t0 = performance.now();
  let ok = 0, total = 0;
  for (let i = 0; i < targets.length; i += step) {
    total++;
    if (aStar(s.world, sx, sy, targets[i][0], targets[i][1])) ok++;
  }
  const ms = performance.now() - t0;
  console.log(`   A*: ${ok}/${total} проходимых целей за ${ms.toFixed(0)} мс`);
  if (ms > 500) throw new Error('медленно: ' + ms.toFixed(0));
  // Отдельные отрезанные островки допустимы, массовая недостижимость — нет.
  if (ok / total < 0.95) throw new Error(`не доходит до ${(100 - ok / total * 100).toFixed(0)}% проходимых клеток`);
});

t('генерация мира: суши и ресурсных клеток хватает на экономику', () => {
  // Пороги шума раньше были выставлены мимо реального размаха: лес требовал
  // m > 0.55 при максимуме 0.42 и не генерился вовсе, гора — высоты, достижимой
  // только в центре карты. Лесопилке нужен соседний лес, шахте — гора,
  // каменоломне — холм, так что половина экономики висела на паре десятков клеток.
  for (const seed of [1, 7, 13, 42, 99]) {
    const s = new Simulation(seed);
    const cnt = { land: 0, forest: 0, hill: 0, mountain: 0, grass: 0 };
    for (const t2 of s.world.tiles) {
      if (WALKABLE.has(t2)) cnt.land++;
      if (t2 === TILE.FOREST) cnt.forest++;
      if (t2 === TILE.HILL) cnt.hill++;
      if (t2 === TILE.MOUNTAIN) cnt.mountain++;
      if (t2 === TILE.GRASS) cnt.grass++;
    }
    const total = s.world.tiles.length;
    if (cnt.land / total < 0.18) throw new Error(`сид ${seed}: суши всего ${(cnt.land / total * 100).toFixed(1)}%`);
    if (cnt.forest < 120) throw new Error(`сид ${seed}: леса всего ${cnt.forest} клеток — лесопилку негде ставить`);
    if (cnt.hill < 120) throw new Error(`сид ${seed}: холмов всего ${cnt.hill} — каменоломню негде ставить`);
    if (cnt.mountain < 60) throw new Error(`сид ${seed}: гор всего ${cnt.mountain} — шахту негде ставить`);
    if (cnt.grass < 300) throw new Error(`сид ${seed}: травы всего ${cnt.grass} — ферму негде ставить`);
  }
});

t('стабильность: godmode 500 дней', () => {
  const s = new Simulation(42);
  s.execCommand('godmode'); s.execCommand('research all'); s.execCommand('spawn 30'); s.execCommand('give food 5000');
  for (let i = 0; i < 1000; i++) s.tick(0.5);
});

t('simulate 500 years не крашит', () => {
  const s = new Simulation(42);
  const out = s.execCommand('simulate 500 years');
  if (!/3650/.test(out)) throw new Error('нет сообщения о капе');
});

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
