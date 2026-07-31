// Тесты модуля границ (U01–U04). Запуск: node app/tests/test-borders.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../src/core/simulation.js';
import { TILE, FACTIONS } from '../src/core/data.js';
import {
  createBorders, updateBorders, worldVersion, ownerAt, ownerCode, ownerName,
  attritionPerDay, landTaxPerDay, territoryTiles, territoryStats, borderEdges,
  serializeBorders, deserializeBorders, buildingWeight, settlementWeight,
  OWNER_PLAYER, OWNER_NONE, INFLUENCE_THRESHOLD, ATTRITION_BASE,
  ATTRITION_PER_DEPTH, ATTRITION_SUPPLIED, TAX_PER_TILE,
} from '../src/core/systems/borders.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

// Ровная суша 96×96: механику границ проверяем без влияния рельефа.
const flatWorld = (w = 96, h = 96, tile = TILE.GRASS) => ({ w, h, tiles: new Uint8Array(w * h).fill(tile) });
const bld = (id, x, y, extra = {}) => ({ id, x, y, size: 1, done: true, destroyed: false, ...extra });
const fac = (id, P, settlements) => ({ id, P, alive: true, settlements, def: FACTIONS.find(f => f.id === id) });
const sync = (state, world, buildings, factions) =>
  updateBorders(state, { world, day: 0, version: 0, buildings, factions, force: true });

// ---------------------------------------------------------------- U01
t('U01 владение: у кострища своя земля, вдали — ничья', () => {
  const world = flatWorld();
  const st = createBorders(96, 96);
  sync(st, world, [bld('campfire', 48, 48)], []);
  ok(ownerAt(st, 48, 48) === OWNER_PLAYER, 'клетка кострища не наша');
  ok(ownerAt(st, 51, 48) === OWNER_PLAYER, 'ближняя клетка не наша');
  ok(ownerAt(st, 70, 48) === OWNER_NONE, 'дальняя клетка почему-то наша');
  const r = territoryTiles(st, OWNER_PLAYER);
  ok(r > 40 && r < 200, `площадь одинокого кострища неправдоподобна: ${r}`);
  console.log(`   кострище держит ${r} клеток, радиус ~${Math.sqrt(r / Math.PI).toFixed(1)}`);
});

t('U01 порог: без источников карта ничья, суммирование расширяет владение', () => {
  const world = flatWorld();
  const st = createBorders(96, 96);
  sync(st, world, [], []);
  ok(territoryTiles(st, OWNER_PLAYER) === 0, 'земля появилась из ниоткуда');
  sync(st, world, [bld('campfire', 48, 48)], []);
  const solo = territoryTiles(st, OWNER_PLAYER);
  const many = [bld('campfire', 48, 48)];
  for (let d = 0; d < 6; d++) many.push(bld('hut', 48 + d, 52));
  sync(st, world, many, []);
  const grown = territoryTiles(st, OWNER_PLAYER);
  ok(grown > solo, `влияние не суммируется: ${solo} -> ${grown}`);
  console.log(`   кострище ${solo} клеток -> с шестью хижинами ${grown}`);
});

t('U01 вес: цитадель весомее хижины, крупная фракция весомее хутора', () => {
  ok(buildingWeight(bld('castle', 0, 0)) > buildingWeight(bld('hut', 0, 0)) * 4, 'замок не тяжелее хижины');
  ok(buildingWeight(bld('campfire', 0, 0)) > buildingWeight(bld('forager', 0, 0)), 'кострище не тяжелее собирателей');
  const small = fac('wolves', 8, [{ x: 0, y: 0, capital: true }]);
  const big = fac('wolves', 80, [{ x: 0, y: 0, capital: true }]);
  ok(settlementWeight(big, big.settlements[0]) > settlementWeight(small, small.settlements[0]), 'P не влияет на вес');
  const cap = { x: 0, y: 0, capital: true }, out = { x: 0, y: 0, capital: false };
  ok(settlementWeight(small, cap) > settlementWeight(small, out), 'столица не весомее аванпоста');
});

t('U01 вода не принадлежит никому', () => {
  const world = flatWorld();
  for (let y = 40; y < 56; y++) for (let x = 52; x < 60; x++) world.tiles[y * 96 + x] = TILE.WATER;
  const st = createBorders(96, 96);
  sync(st, world, [bld('castle', 50, 48)], []);
  let wet = 0;
  for (let y = 40; y < 56; y++) for (let x = 52; x < 60; x++) if (ownerAt(st, x, y) !== OWNER_NONE) wet++;
  ok(wet === 0, `${wet} водных клеток кому-то принадлежат`);
  ok(ownerAt(st, 50, 48) === OWNER_PLAYER, 'суша рядом не наша');
});

// ---------------------------------------------------------------- U03
t('U03 давление: усиление соседа оттесняет чужую границу', () => {
  const world = flatWorld();
  const st = createBorders(96, 96);
  // Город игрока из цитаделей: его влияние держится высоко до самой зоны стыка,
  // иначе граница упиралась бы в порог, а не в соседа, и давления не увидеть.
  const mine = [bld('campfire', 30, 48), bld('castle', 34, 48), bld('castle', 26, 48),
    bld('castle', 30, 44), bld('castle', 30, 52)];
  // Граница = первая клетка вправо по y=48, которая перестала быть нашей.
  const frontier = () => { let x = 30; while (x < 60 && ownerAt(st, x, 48) === OWNER_PLAYER) x++; return x; };

  const weak = fac('wolves', 10, [{ x: 52, y: 48, capital: true }]);
  sync(st, world, mine, [weak]);
  const f1 = frontier(), mine1 = territoryTiles(st, OWNER_PLAYER), foe1 = territoryTiles(st, ownerCode('wolves'));

  const strong = fac('wolves', 220, [{ x: 52, y: 48, capital: true }]);
  sync(st, world, mine, [strong]);
  const f2 = frontier(), mine2 = territoryTiles(st, OWNER_PLAYER), foe2 = territoryTiles(st, ownerCode('wolves'));

  ok(f2 < f1, `граница не сдвинулась: была на x=${f1}, стала x=${f2}`);
  ok(mine2 < mine1, `наша площадь не сократилась: ${mine1} -> ${mine2}`);
  ok(foe2 > foe1, `площадь соседа не выросла: ${foe1} -> ${foe2}`);
  console.log(`   слабый сосед: граница x=${f1}, у нас ${mine1} / у него ${foe1} клеток`);
  console.log(`   сильный сосед: граница x=${f2}, у нас ${mine2} / у него ${foe2} клеток`);
});

t('U03 равные соседи: между ними ничья полоса, а не общая клетка', () => {
  const world = flatWorld();
  const st = createBorders(96, 96);
  const a = fac('wolves', 120, [{ x: 40, y: 48, capital: true }]);
  const b = fac('horde', 120, [{ x: 56, y: 48, capital: true }]);
  sync(st, world, [], [a, b]);
  const ca = ownerCode('wolves'), cb = ownerCode('horde');
  ok(territoryTiles(st, ca) > 0 && territoryTiles(st, cb) > 0, 'кто-то остался без земли');
  ok(Math.abs(territoryTiles(st, ca) - territoryTiles(st, cb)) <= 2, 'равные фракции получили разную площадь');
  ok(ownerAt(st, 48, 48) === OWNER_NONE, 'клетка ровно посередине кому-то досталась');
  // Ни одна клетка не может числиться за двумя сторонами: массив владельцев один.
  let touching = 0;
  for (let y = 0; y < 96; y++) for (let x = 0; x < 95; x++) {
    const l = ownerAt(st, x, y), r = ownerAt(st, x + 1, y);
    if (l && r && l !== r) touching++;
  }
  console.log(`   стыков «держава к державе» без ничьей прослойки: ${touching}`);
});

// ---------------------------------------------------------------- U02
t('U02 истощение: своя и ничья земля безопасны, чужая — нет', () => {
  const world = flatWorld();
  const st = createBorders(96, 96);
  const foe = fac('wolves', 200, [{ x: 60, y: 48, capital: true }]);
  sync(st, world, [bld('campfire', 30, 48)], [foe]);
  ok(attritionPerDay(st, 30, 48, OWNER_PLAYER) === 0, 'на своей земле теряем силу');
  ok(attritionPerDay(st, 45, 48, OWNER_PLAYER) === 0, 'на ничьей земле теряем силу');
  const d = attritionPerDay(st, 60, 48, OWNER_PLAYER);
  ok(d > 0, 'на вражеской земле урона нет');
  ok(attritionPerDay(st, 60, 48, 'wolves') === 0, 'фракция истощается на своей же земле');
  console.log(`   в столице врага отряд теряет ${d.toFixed(2)} силы в день`);
});

t('U02 глубина и снабжение', () => {
  const world = flatWorld();
  const st = createBorders(96, 96);
  const foe = fac('wolves', 300, [{ x: 48, y: 48, capital: true }]);
  sync(st, world, [], [foe]);
  const center = attritionPerDay(st, 48, 48, OWNER_PLAYER);
  // Кромка: последняя вражеская клетка вправо по y=48.
  let x = 48; while (ownerAt(st, x + 1, 48) === ownerCode('wolves')) x++;
  const rim = attritionPerDay(st, x, 48, OWNER_PLAYER);
  ok(rim > 0, 'кромка не истощает');
  ok(center > rim, `вглубь не тяжелее: кромка ${rim}, центр ${center}`);
  ok(Math.abs(rim - ATTRITION_BASE) < 1e-9, `база кромки должна быть ${ATTRITION_BASE}, а не ${rim}`);
  const sup = attritionPerDay(st, 48, 48, OWNER_PLAYER, { supplied: true });
  ok(Math.abs(sup - center * ATTRITION_SUPPLIED) < 1e-9, 'снабжение не смягчает истощение');
  console.log(`   кромка ${rim.toFixed(2)} -> центр ${center.toFixed(2)} (шаг ${ATTRITION_PER_DEPTH}), со снабжением ${sup.toFixed(2)}`);
});

// ---------------------------------------------------------------- U04
t('U04 налог с земли пропорционален площади', () => {
  const world = flatWorld();
  const st = createBorders(96, 96);
  sync(st, world, [], []);
  ok(landTaxPerDay(st, OWNER_PLAYER) === 0, 'налог без территории');
  sync(st, world, [bld('campfire', 48, 48)], []);
  const tax1 = landTaxPerDay(st, OWNER_PLAYER), a1 = territoryTiles(st, OWNER_PLAYER);
  const big = [bld('campfire', 48, 48), bld('castle', 44, 44), bld('castle', 52, 52)];
  sync(st, world, big, []);
  const tax2 = landTaxPerDay(st, OWNER_PLAYER), a2 = territoryTiles(st, OWNER_PLAYER);
  ok(tax2 > tax1, `налог не вырос при росте земли: ${tax1} -> ${tax2}`);
  ok(Math.abs(tax1 - a1 * TAX_PER_TILE) < 1e-9, 'ставка налога не совпадает с площадью');
  ok(Math.abs(landTaxPerDay(st, OWNER_PLAYER, { mult: 2 }) - tax2 * 2) < 1e-9, 'множитель не работает');
  console.log(`   ${a1} клеток -> ${tax1.toFixed(2)}🪙/день; ${a2} клеток -> ${tax2.toFixed(2)}🪙/день`);
});

t('U04 горы облагаются вполовину', () => {
  const grass = flatWorld();
  const rock = flatWorld(96, 96, TILE.MOUNTAIN);
  const s1 = createBorders(96, 96), s2 = createBorders(96, 96);
  sync(s1, grass, [bld('campfire', 48, 48)], []);
  sync(s2, rock, [bld('campfire', 48, 48)], []);
  ok(territoryTiles(s1, OWNER_PLAYER) === territoryTiles(s2, OWNER_PLAYER), 'площадь зависит от биома');
  ok(Math.abs(landTaxPerDay(s2, OWNER_PLAYER) - landTaxPerDay(s1, OWNER_PLAYER) / 2) < 1e-9, 'горы не вполовину');
});

// ---------------------------------------------------------------- кэш
t('кэш: пересчёт не чаще раза в день и только при смене состава', () => {
  const world = flatWorld();
  const st = createBorders(96, 96);
  const b = [bld('campfire', 48, 48)];
  const ctx = (day, version) => ({ world, day, version, buildings: b, factions: [] });
  ok(updateBorders(st, ctx(0, 100)) === true, 'первый расчёт не выполнен');
  ok(st.recomputes === 1, 'лишний пересчёт на старте');
  ok(updateBorders(st, ctx(0, 999)) === false, 'пересчёт дважды за один день');
  ok(updateBorders(st, ctx(1, 100)) === false, 'пересчёт при неизменном составе');
  ok(updateBorders(st, ctx(2, 101)) === true, 'нет пересчёта при смене состава');
  ok(st.recomputes === 2, `пересчётов ${st.recomputes}, ожидалось 2`);
  // Версия обязана меняться от реального состава и не меняться от его отсутствия.
  const v0 = worldVersion(b, []);
  ok(worldVersion(b, []) === v0, 'версия не стабильна');
  ok(worldVersion([...b, bld('hut', 50, 50)], []) !== v0, 'новое здание не меняет версию');
  const f1 = [fac('wolves', 10, [{ x: 10, y: 10, capital: true }])];
  const f2 = [fac('wolves', 10, [{ x: 10, y: 10, capital: true }, { x: 20, y: 20, capital: false }])];
  ok(worldVersion(b, f1) !== worldVersion(b, f2), 'новый аванпост не меняет версию');
  ok(worldVersion(b, [{ ...f1[0], done: false, alive: false }]) === v0, 'мёртвая фракция влияет на версию');
});

// ---------------------------------------------------------------- рендер
t('рёбра границы: только между разными владельцами, координаты целые', () => {
  const world = flatWorld();
  const st = createBorders(96, 96);
  sync(st, world, [bld('campfire', 30, 48)], [fac('wolves', 150, [{ x: 60, y: 48, capital: true }])]);
  const edges = borderEdges(st);
  ok(edges.length > 20, `рёбер всего ${edges.length}`);
  for (const e of edges) {
    ok(Number.isInteger(e.x1) && Number.isInteger(e.y1) && Number.isInteger(e.x2) && Number.isInteger(e.y2), 'дробные координаты ребра');
    ok(e.owner !== OWNER_NONE, 'ребро без владельца');
    const len = Math.abs(e.x2 - e.x1) + Math.abs(e.y2 - e.y1);
    ok(len === 1, 'ребро длиннее клетки');
    // Ребро всегда разделяет клетку владельца и клетку кого-то другого:
    // вертикальное — соседей по x, горизонтальное — по y.
    const vertical = e.x1 === e.x2;
    const a = ownerAt(st, e.x1, e.y1);
    const b = vertical ? ownerAt(st, e.x1 - 1, e.y1) : ownerAt(st, e.x1, e.y1 - 1);
    ok(a === e.owner || b === e.owner, 'ребро не примыкает к своей территории');
    ok(a !== b, 'ребро внутри однородной территории');
  }
  const owners = new Set(edges.map(e => e.owner));
  ok(owners.size === 2, `обведено сторон: ${owners.size}`);
  console.log(`   рёбер для обводки: ${edges.length}, сторон: ${owners.size}`);
});

t('имена и коды владельцев', () => {
  ok(ownerCode('player') === OWNER_PLAYER, 'код игрока');
  ok(ownerCode('wolves') === 2 + FACTIONS.findIndex(f => f.id === 'wolves'), 'код фракции не от таблицы');
  ok(ownerCode('нет-такой') === OWNER_NONE, 'выдуманная сторона получила код');
  ok(ownerName(OWNER_NONE) === 'Ничья земля' && ownerName(OWNER_PLAYER) === 'Ваши земли', 'подписи не по-русски');
  ok(ownerName(ownerCode('wolves')) === 'Волчий Предел', 'имя фракции');
});

// ---------------------------------------------------------------- сейв
t('сериализация: круговой JSON, владельцы и производные восстановлены', () => {
  const world = flatWorld();
  const st = createBorders(96, 96);
  updateBorders(st, { world, day: 7, version: 42, buildings: [bld('campfire', 30, 48), bld('castle', 34, 50)], factions: [fac('wolves', 180, [{ x: 62, y: 40, capital: true }, { x: 70, y: 60, capital: false }])] });
  const json = JSON.stringify(serializeBorders(st));
  const back = deserializeBorders(JSON.parse(json));
  for (let i = 0; i < st.owners.length; i++) ok(back.owners[i] === st.owners[i], 'владельцы разошлись на клетке ' + i);
  for (let i = 0; i < st.depth.length; i++) ok(back.depth[i] === st.depth[i], 'глубина не восстановлена');
  ok(back.edges.length === st.edges.length, 'рёбра не восстановлены');
  ok(back.version === 42 && back.lastDay === 7, 'версия/день не восстановлены');
  ok(Math.abs(landTaxPerDay(back, OWNER_PLAYER) - landTaxPerDay(st, OWNER_PLAYER)) < 1e-9, 'налог после загрузки другой');
  ok(JSON.stringify(serializeBorders(back)) === json, 'повторная сериализация не идентична');
  ok(deserializeBorders(null).owners.every(v => v === 0), 'сейв без границ ломает загрузку');
  console.log(`   RLE-сейв: ${json.length} байт вместо ${st.owners.length} клеток`);
});

// ---------------------------------------------------------------- детерминизм
t('детерминизм: нет Math.random, два прогона идентичны', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/core/systems/borders.js', import.meta.url)), 'utf8');
  ok(!/Math\.random/.test(src), 'в модуле есть Math.random');
  ok(!/\b(document|window)\b/.test(src), 'в модуле есть обращение к DOM');
  const world = flatWorld();
  const run = () => {
    const st = createBorders(96, 96);
    sync(st, world, [bld('campfire', 48, 48), bld('castle', 40, 44)], [fac('horde', 90, [{ x: 66, y: 52, capital: true }])]);
    return Array.from(st.owners).join(',');
  };
  ok(run() === run(), 'два одинаковых прогона дали разные границы');
});

// ---------------------------------------------------------------- скорость
t('скорость полного пересчёта укладывается в 15 мс', () => {
  const world = flatWorld();
  // Худший правдоподобный случай: 8 фракций по 5 поселений и 300 зданий игрока.
  const factions = FACTIONS.map((f, i) => fac(f.id, 200, [0, 1, 2, 3, 4].map(k => ({
    x: 8 + ((i * 11 + k * 5) % 80), y: 8 + ((i * 7 + k * 13) % 80), capital: k === 0,
  }))));
  const buildings = [bld('campfire', 48, 48)];
  for (let i = 0; i < 300; i++) {
    buildings.push(bld(i % 5 === 0 ? 'castle' : 'stone_house', 34 + (i % 25), 34 + ((i / 25) | 0)));
  }
  const st = createBorders(96, 96);
  const times = [];
  for (let i = 0; i < 3; i++) sync(st, world, buildings, factions); // прогрев JIT
  for (let i = 0; i < 13; i++) { sync(st, world, buildings, factions); times.push(st.lastMs); }
  const best = Math.min(...times);
  const median = times.slice().sort((a, b) => a - b)[6];
  console.log(`   пересчёт 96×96 (${buildings.length} зданий + ${factions.length}×5 поселений): медиана ${median.toFixed(2)} мс, лучшее ${best.toFixed(2)} мс, худшее ${Math.max(...times).toFixed(2)} мс`);
  const cnt = territoryStats(st);
  console.log(`   сторон с землёй: ${cnt.length}, всего занято ${cnt.reduce((a, s) => a + s.tiles, 0)} клеток из ${96 * 96}`);
  ok(median <= 15, `медиана ${median.toFixed(2)} мс > 15 мс`);
});

// ---------------------------------------------------------------- живая партия
t('живая партия: границы поверх настоящей Simulation', () => {
  const s = new Simulation(42, { factions: 5 });
  s.execCommand('give wood 400'); s.execCommand('give stone 400');
  s.placeBuilding('hut', 46, 46); s.placeBuilding('hut', 50, 50);
  for (let i = 0; i < 400; i++) s.tick(0.5);
  const st = createBorders(s.world.w, s.world.h);
  const grew = updateBorders(st, {
    world: s.world, day: s.day, version: worldVersion(s.buildings, s.factions),
    buildings: s.buildings, factions: s.factions,
  });
  ok(grew, 'первый пересчёт не выполнен');
  const mine = territoryTiles(st, OWNER_PLAYER);
  ok(mine > 0, 'у игрока нет земли');
  const foes = s.factions.filter(f => f.alive && territoryTiles(st, f.id) > 0);
  ok(foes.length === s.factions.filter(f => f.alive).length, 'не у всех живых фракций есть земля');
  // Вода реального мира по-прежнему ничья.
  let wet = 0;
  for (let i = 0; i < st.owners.length; i++) {
    const tl = s.world.tiles[i];
    if ((tl === TILE.DEEP || tl === TILE.WATER) && st.owners[i]) wet++;
  }
  ok(wet === 0, `${wet} водных клеток захвачено`);
  // U02 в бою: отряд игрока у чужой столицы теряет силу, дома — нет.
  const cap = foes[0].settlements[0];
  ok(attritionPerDay(st, cap.x, cap.y, OWNER_PLAYER) > 0, 'у вражеской столицы нет истощения');
  ok(attritionPerDay(st, s.world.startX, s.world.startY, OWNER_PLAYER) === 0, 'дома есть истощение');
  const tax = landTaxPerDay(st, OWNER_PLAYER);
  console.log(`   день ${s.day}: у игрока ${mine} клеток (${tax.toFixed(2)}🪙/день), фракций с землёй ${foes.length}`);
  console.log(`   ${territoryStats(st).map(x => `${x.name}: ${x.tiles}`).join(' · ')}`);
  ok(INFLUENCE_THRESHOLD > 0, 'порог владения должен быть положительным');
});

console.log(`\n=== ${pass} OK / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
