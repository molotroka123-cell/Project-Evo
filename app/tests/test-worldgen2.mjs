// Тесты большой карты: континенты, острова, реки, биомы (U08).
// Запуск: node app/tests/test-worldgen2.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRng, makeNoise2D } from '../src/core/rng.js';
import { TILE, WALKABLE } from '../src/core/data.js';
import { generateWorld, aStar } from '../src/core/world.js';
import { Simulation } from '../src/core/simulation.js';
import {
  generateWorld2, enrichWorld, analyzeLandmasses, worldStats,
  BIOME, BIOMES, biomeAt, biomeName, yieldMult, gatherMult, biomeHappy,
  irrigation, riverAt, isRiver, needsBridge, moveMult, riverPath,
  sameLandmass, landmassAt, createWorldgenState, bridgeCost, buildBridge, hasBridge,
  serialize, deserialize, describeTile, temperature, moisture, protectStart,
  LAND_TARGET, CONTINENT_MIN, MIN_RIVER_LEN, RIVER_BRIDGE_FLOW, RIVER_FORD_SLOW,
} from '../src/core/systems/worldgen2.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const pad = (s, n) => String(s).padStart(n);
const pct = (v) => (v * 100).toFixed(1) + '%';

// ---------- 1. Совместимость со старой картой 96×96 ----------
t('96×96: форма мира совместима с generateWorld', () => {
  const w = generateWorld2(1234);
  ok(w.w === 96 && w.h === 96, 'размер ' + w.w + '×' + w.h);
  ok(w.tiles instanceof Uint8Array && w.tiles.length === 96 * 96, 'tiles не тот');
  ok(Number.isInteger(w.startX) && Number.isInteger(w.startY), 'старт не целый');
  ok(w.seed === 1234, 'сид потерян');
  for (let i = 0; i < w.tiles.length; i++) ok(w.tiles[i] <= TILE.MOUNTAIN, 'чужой тайл ' + w.tiles[i]);
  ok(WALKABLE.has(w.tiles[w.startY * 96 + w.startX]), 'старт не проходим');
});

t('стартовая поляна вырезана как в ядре (трава/лес/холм/гора)', () => {
  const w = generateWorld2(1234);
  const at = (dx, dy) => w.tiles[(w.startY + dy) * w.w + (w.startX + dx)];
  ok(at(0, 0) === TILE.GRASS && at(-3, 3) === TILE.GRASS, 'нет поляны');
  ok(at(0, -6) === TILE.FOREST, 'нет леса к северу');
  ok(at(5, 6) === TILE.HILL, 'нет холма к юго-востоку');
  ok(at(8, -1) === TILE.MOUNTAIN, 'нет горы');
  ok(riverAt(w, w.startX, w.startY) === 0, 'река посреди стартовой поляны');
});

// ---------- 2. Детерминизм от сида ----------
t('детерминизм: один сид — байт в байт та же карта', () => {
  const a = generateWorld2(777), b = generateWorld2(777);
  for (let i = 0; i < a.tiles.length; i++) {
    ok(a.tiles[i] === b.tiles[i], 'tiles[' + i + ']');
    ok(a.biome[i] === b.biome[i], 'biome[' + i + ']');
    ok(a.river[i] === b.river[i], 'river[' + i + ']');
  }
  ok(a.startX === b.startX && a.startY === b.startY, 'старт разъехался');
  ok(a.rivers.length === b.rivers.length, 'число рек');
});

t('детерминизм при общем rng ядра (как в Simulation)', () => {
  const mk = () => { const r = createRng(31337); r.noise = makeNoise2D(createRng(31337 ^ 0x9e3779b9)); return r; };
  const a = generateWorld2(31337, mk()), b = generateWorld2(31337, mk());
  let diff = 0;
  for (let i = 0; i < a.tiles.length; i++) if (a.tiles[i] !== b.tiles[i] || a.biome[i] !== b.biome[i]) diff++;
  ok(diff === 0, 'расхождений ' + diff);
});

t('разные сиды — разные карты', () => {
  const a = generateWorld2(1), b = generateWorld2(2);
  let diff = 0;
  for (let i = 0; i < a.tiles.length; i++) if (a.tiles[i] !== b.tiles[i]) diff++;
  ok(diff > a.tiles.length * 0.2, 'карты почти одинаковые: разниц ' + diff);
});

t('в модуле нет Math.random', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/core/systems/worldgen2.js', import.meta.url)), 'utf8');
  ok(!/Math\.random/.test(src), 'найден Math.random — детерминизм сломан');
});

// ---------- 3. Таблица по 10 сидам ----------
const seeds = [1, 2, 3, 5, 8, 13, 21, 42, 99, 2026];
const rows = [];
t('10 сидов: материки, острова, реки, суша', () => {
  console.log('\n  сид   | материки | острова | суша  | реки | Σклеток | длиннейшая | средняя | мс');
  console.log('  ------+----------+---------+-------+------+---------+------------+---------+------');
  for (const s of seeds) {
    const w = generateWorld2(s);
    const st = worldStats(w);
    rows.push({ s, st, w });
    console.log('  ' + pad(s, 5) + ' | ' + pad(st.continents, 8) + ' | ' + pad(st.islands, 7) + ' | ' +
      pad(pct(st.landPct), 5) + ' | ' + pad(st.rivers, 4) + ' | ' + pad(st.riverTiles, 7) + ' | ' +
      pad(st.longestRiver, 10) + ' | ' + pad(st.avgRiver.toFixed(1), 7) + ' | ' + pad(w.genMs.toFixed(1), 5));
  }
  for (const { s, st } of rows) {
    ok(st.landPct > LAND_TARGET - 0.01 && st.landPct < LAND_TARGET + 0.01, 'сид ' + s + ': суша ' + pct(st.landPct));
    ok(st.continents >= 1, 'сид ' + s + ': нет ни одного материка');
    ok(st.rivers >= 3, 'сид ' + s + ': рек всего ' + st.rivers);
    ok(st.biggest >= CONTINENT_MIN, 'сид ' + s + ': крупнейший массив ' + st.biggest);
  }
  const isl = rows.reduce((a, r) => a + r.st.islands, 0);
  const multi = rows.filter(r => r.st.continents >= 2).length;
  console.log('  итого: островов на 10 сидах ' + isl + ', карт с 2+ материками ' + multi + '/10');
  ok(isl >= 10, 'островов почти нет: ' + isl);
  ok(multi >= 3, 'многоматериковых карт мало: ' + multi);
});

t('распределение биомов по 10 сидам (в % от суши)', () => {
  const acc = {}; for (const b of BIOMES) acc[b.id] = 0;
  let land = 0;
  for (const { st } of rows) {
    for (const b of BIOMES) if (b.id !== 'ocean') acc[b.id] += st.biomeCounts[b.id];
    land += st.land;
  }
  console.log('');
  for (const b of BIOMES) {
    if (b.id === 'ocean') continue;
    const p = acc[b.id] / land;
    console.log('  ' + b.ru.padEnd(18) + pad((p * 100).toFixed(1) + '%', 6) + '  ' + '#'.repeat(Math.round(p * 100)));
  }
  const present = BIOMES.filter(b => b.id !== 'ocean' && acc[b.id] > 0).length;
  ok(present === BIOMES.length - 1, 'не все биомы встречаются: ' + present + ' из ' + (BIOMES.length - 1));
  // Ни один биом не должен съедать больше половины суши — иначе карта однообразна.
  for (const b of BIOMES) if (b.id !== 'ocean') ok(acc[b.id] / land < 0.5, 'биом ' + b.ru + ' занял ' + pct(acc[b.id] / land));
});

// ---------- 4. Биом определяется широтой и влажностью, а не рандомом ----------
t('широта решает: тундра севернее/южнее тропиков', () => {
  const sum = {}, cnt = {};
  for (const { w } of rows) {
    for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) {
      const i = y * w.w + x;
      if (w.tiles[i] === TILE.DEEP || w.tiles[i] === TILE.WATER) continue;
      const id = BIOMES[w.biome[i]].id;
      const lat = Math.abs((y + 0.5) / w.h * 2 - 1);
      sum[id] = (sum[id] || 0) + lat; cnt[id] = (cnt[id] || 0) + 1;
    }
  }
  const m = (id) => sum[id] / cnt[id];
  console.log('  средняя |широта|: тундра ' + m('tundra').toFixed(2) + ', тайга ' + m('taiga').toFixed(2) +
    ', умеренные ' + m('temperate').toFixed(2) + ', саванна ' + m('savanna').toFixed(2) + ', тропики ' + m('tropics').toFixed(2));
  ok(m('tundra') > m('taiga'), 'тундра не севернее тайги');
  ok(m('taiga') > m('temperate'), 'тайга не севернее умеренных');
  ok(m('temperate') > m('tropics'), 'умеренные не севернее тропиков');
  ok(m('tundra') > 0.6 && m('tropics') < 0.4, 'пояса размазаны');
});

t('пустыня суше степи, степь суше умеренных', () => {
  let dS = 0, dN = 0, sS = 0, sN = 0, tS = 0, tN = 0;
  for (const { w } of rows) {
    for (let i = 0; i < w.tiles.length; i++) {
      const b = w.biome[i];
      if (b === BIOME.DESERT) { dS += w.moist[i]; dN++; }
      else if (b === BIOME.STEPPE) { sS += w.moist[i]; sN++; }
      else if (b === BIOME.TEMPERATE) { tS += w.moist[i]; tN++; }
    }
  }
  console.log('  влажность: пустыня ' + (dS / dN).toFixed(2) + ' < степь ' + (sS / sN).toFixed(2) + ' < умеренные ' + (tS / tN).toFixed(2));
  ok(dS / dN < sS / sN && sS / sN < tS / tN, 'влажность не упорядочена');
});

t('чистые формулы климата монотонны', () => {
  ok(temperature(0, 0, 0) > temperature(0.5, 0, 0), 'экватор не теплее средних широт');
  ok(temperature(0.5, 0, 0) > temperature(1, 0, 0), 'полюс не холоднее');
  ok(temperature(0.2, 0, 0) > temperature(0.2, 0.9, 0), 'гора не холодит');
  ok(moisture(0, 0) > moisture(10, 0) && moisture(10, 0) > moisture(17, 0), 'континентальность не работает');
});

// ---------- 5. Реки ----------
t('реки: только по суше, от высот к воде, длина не меньше порога', () => {
  let checked = 0, toSea = 0, total = 0;
  for (const { w } of rows) {
    for (let i = 0; i < w.tiles.length; i++) {
      if (!w.river[i]) continue;
      ok(w.tiles[i] !== TILE.DEEP && w.tiles[i] !== TILE.WATER, 'русло в океане');
      checked++;
    }
    for (const r of w.rivers) {
      total++;
      ok(r.len >= MIN_RIVER_LEN, 'ручей попал в реки: ' + r.len);
      if (r.toSea) {
        toSea++;
        const t2 = w.tiles[r.my * w.w + r.mx];
        ok(t2 === TILE.WATER || t2 === TILE.DEEP, 'устье не в воде');
      }
    }
  }
  console.log('  речных клеток ' + checked + ', рек ' + total + ', из них доходят до моря ' + toSea + ' (' + pct(toSea / total) + ')');
  ok(toSea / total > 0.6, 'большинство рек не доходит до моря');
});

t('исток выше устья', () => {
  let bad = 0, n = 0;
  for (const { w } of rows) for (const r of w.rivers) {
    n++;
    if (w.elev[r.sy * w.w + r.sx] <= w.elev[r.my * w.w + r.mx]) bad++;
  }
  ok(bad === 0, 'рек, текущих в гору: ' + bad + ' из ' + n);
});

t('река даёт орошение соседям, вдали от воды — нет', () => {
  const w = rows[0].w;
  const r = w.rivers[0];
  const near = irrigation(w, r.sx, r.sy);
  ok(near > 1.29, 'на самом русле нет бонуса: ' + near.toFixed(2));
  ok(irrigation(w, r.sx + 1, r.sy) > 1.0 && irrigation(w, r.sx + 1, r.sy) < near + 1e-9, 'бонус не спадает');
  // Клетка заведомо далеко от любой реки
  let far = null;
  for (let y = 0; y < w.h && !far; y++) for (let x = 0; x < w.w; x++) {
    if (irrigation(w, x, y) === 1) { far = { x, y }; break; }
  }
  ok(far, 'вся карта орошена — так не бывает');
});

t('брод замедляет, полноводная река требует моста', () => {
  const w = rows[1].w;
  const st = createWorldgenState(w);
  let ford = null, wide = null;
  for (let i = 0; i < w.river.length && !(ford && wide); i++) {
    const p = { x: i % w.w, y: (i / w.w) | 0 };
    if (w.river[i] === 1 && !ford) ford = p;
    if (w.river[i] >= RIVER_BRIDGE_FLOW && !wide) wide = p;
  }
  ok(ford && wide, 'на карте нет и брода, и полноводного русла');
  ok(!needsBridge(w, ford.x, ford.y), 'брод объявлен непроходимым');
  ok(needsBridge(w, wide.x, wide.y), 'полноводная река проходима вброд');
  ok(moveMult(w, st, ford.x, ford.y) > 1, 'брод не замедляет');
  ok(moveMult(w, st, wide.x, wide.y) === Infinity, 'широкая река проходима');
  const path = [{ x: ford.x, y: ford.y }, { x: wide.x, y: wide.y }];
  const rp = riverPath(w, st, path);
  ok(rp.blocked && rp.fords === 1, 'разбор пути неверен: ' + JSON.stringify(rp));
  // Мост снимает и запрет, и замедление
  const cost = bridgeCost(w, wide.x, wide.y);
  ok(cost && cost.wood > 0 && cost.stone > 0, 'стоимость моста: ' + JSON.stringify(cost));
  buildBridge(st, wide.x, wide.y); buildBridge(st, ford.x, ford.y);
  const rp2 = riverPath(w, st, path);
  ok(!rp2.blocked && rp2.fords === 0 && rp2.slow === 1, 'мост не помог: ' + JSON.stringify(rp2));
  ok(moveMult(w, st, wide.x, wide.y) < Infinity, 'по мосту не пройти');
  console.log('  мост через полноводную реку: ' + cost.wood + '🪵 + ' + cost.stone + '🪨');
});

// ---------- 6. Биом влияет на экономику ----------
t('биом меняет добычу: пустыня ≠ пойма ≠ тайга', () => {
  const w = rows[0].w;
  const find = (b) => { for (let i = 0; i < w.biome.length; i++) if (w.biome[i] === b) return { x: i % w.w, y: (i / w.w) | 0 }; return null; };
  const des = find(BIOME.DESERT), wet = find(BIOME.WETLAND), tai = find(BIOME.TAIGA), tem = find(BIOME.TEMPERATE);
  ok(des && wet && tai && tem, 'нужные биомы не найдены на сиде ' + w.seed);
  ok(yieldMult(w, des.x, des.y, 'food') < yieldMult(w, tem.x, tem.y, 'food'), 'пустыня кормит не хуже умеренных');
  ok(yieldMult(w, wet.x, wet.y, 'food') > yieldMult(w, tem.x, tem.y, 'food'), 'пойма не лучше поля');
  ok(yieldMult(w, tai.x, tai.y, 'wood') > yieldMult(w, des.x, des.y, 'wood'), 'в пустыне леса больше, чем в тайге');
  ok(yieldMult(w, des.x, des.y, 'gold') === 1, 'биом трогает золото');
  ok(biomeHappy(w, des.x, des.y) < biomeHappy(w, tem.x, tem.y), 'жить в пустыне не хуже');
  console.log('  еда: пустыня ×' + yieldMult(w, des.x, des.y, 'food') + ', умеренные ×' + yieldMult(w, tem.x, tem.y, 'food') +
    ', пойма ×' + yieldMult(w, wet.x, wet.y, 'food') + '; лес в тайге ×' + yieldMult(w, tai.x, tai.y, 'wood'));
  console.log('  тултип: ' + describeTile(w, createWorldgenState(w), wet.x, wet.y));
});

t('что где растёт: в тайге леса больше, чем в степи', () => {
  let taiF = 0, taiN = 0, stF = 0, stN = 0;
  for (const { w } of rows) for (let i = 0; i < w.biome.length; i++) {
    if (w.biome[i] === BIOME.TAIGA) { taiN++; if (w.tiles[i] === TILE.FOREST) taiF++; }
    if (w.biome[i] === BIOME.STEPPE) { stN++; if (w.tiles[i] === TILE.FOREST) stF++; }
  }
  console.log('  лесистость: тайга ' + pct(taiF / taiN) + ', степь ' + pct(stF / stN));
  ok(taiF / taiN > 0.5 && stF / stN < 0.2, 'растительность не зависит от биома');
});

// ---------- 7. Материки и острова ----------
t('материки/острова разделены водой, sameLandmass это видит', () => {
  const w = rows.find(r => r.st.islands > 0).w;
  const lm = analyzeLandmasses(w);
  const big = lm.list[0], small = lm.list.find(l => l.size < CONTINENT_MIN && l.size >= 4);
  ok(big && small, 'нет пары материк+остров');
  ok(!sameLandmass(w, big.cx, big.cy, small.cx, small.cy) || landmassAt(w, big.cx, big.cy) !== landmassAt(w, small.cx, small.cy), 'остров считается частью материка');
  ok(sameLandmass(w, w.startX, w.startY, w.startX + 1, w.startY), 'соседняя клетка на другом материке');
  ok(!sameLandmass(w, w.startX, w.startY, -5, -5), 'за краем карты тот же материк');
});

// ---------- 8. A* по-прежнему ходит ----------
t('A* проходит по новой карте 96×96', () => {
  let tries = 0, found = 0;
  for (const { w } of rows) {
    const rng = createRng(w.seed ^ 0xabcd);
    let n = 0;
    for (let guard = 0; guard < 3000 && n < 20; guard++) {
      const x = rng.int(1, w.w - 2), y = rng.int(1, w.h - 2);
      if (!WALKABLE.has(w.tiles[y * w.w + x])) continue;
      if (!sameLandmass(w, x, y, w.startX, w.startY)) continue;
      n++; tries++;
      if (aStar(w, w.startX, w.startY, x, y)) found++;
    }
  }
  console.log('  путей найдено ' + found + ' из ' + tries + ' (' + pct(found / tries) + ')');
  ok(tries >= 150, 'мало проверок: ' + tries);
  ok(found / tries > 0.97, 'A* не доходит: ' + pct(found / tries));
});

t('A* НЕ находит путь на другой материк (океан честно разделяет)', () => {
  let checked = 0;
  for (const { w } of rows) {
    const lm = analyzeLandmasses(w);
    const other = lm.list.find(l => l.size >= 20 && !sameLandmass(w, l.cx, l.cy, w.startX, w.startY));
    if (!other) continue;
    let target = null;
    for (let i = 0; i < w.tiles.length && !target; i++) {
      if (lm.map[i] === other.id && WALKABLE.has(w.tiles[i])) target = { x: i % w.w, y: (i / w.w) | 0 };
    }
    if (!target) continue;
    checked++;
    ok(aStar(w, w.startX, w.startY, target.x, target.y) === null, 'сид ' + w.seed + ': армия перешла океан пешком');
  }
  console.log('  проверено разделённых массивов суши: ' + checked);
  ok(checked >= 3, 'мало карт с отдельными массивами: ' + checked);
});

// ---------- 9. Слои поверх СТАРОЙ карты ----------
t('enrichWorld не меняет тайлы старой карты', () => {
  const rng = createRng(42); rng.noise = makeNoise2D(createRng(42 ^ 0x9e3779b9));
  const w = generateWorld(42, rng);
  const before = Uint8Array.from(w.tiles);
  enrichWorld(w, 42);
  for (let i = 0; i < before.length; i++) ok(before[i] === w.tiles[i], 'тайл ' + i + ' изменён');
  ok(w.biome && w.river && w.landmass, 'слои не навешены');
  const st = worldStats(w);
  console.log('  старая карта 96×96: материки ' + st.continents + ', острова ' + st.islands +
    ', реки ' + st.rivers + ' (Σ' + st.riverTiles + ' клеток), суша ' + pct(st.landPct) + ', ' + w.enrichMs.toFixed(1) + ' мс');
  ok(st.rivers >= 3, 'рек на старой карте ' + st.rivers);
  ok(st.continents >= 1, 'нет материка');
});

t('стартовая долина пригодна для жизни на всех 10 сидах', () => {
  const bad = [BIOME.DESERT, BIOME.TUNDRA];
  for (const { w } of rows) {
    const b = biomeAt(w, w.startX, w.startY);
    ok(!bad.includes(b), 'сид ' + w.seed + ': старт в биоме ' + BIOMES[b].ru);
    ok(yieldMult(w, w.startX, w.startY, 'food') >= 1, 'сид ' + w.seed + ': поля на старте ×' + yieldMult(w, w.startX, w.startY, 'food'));
  }
  // На старой карте старт жёстко в центре — там климат мог оказаться каким угодно.
  const rng = createRng(42); rng.noise = makeNoise2D(createRng(42 ^ 0x9e3779b9));
  const old = enrichWorld(generateWorld(42, rng), 42);
  ok(!bad.includes(biomeAt(old, old.startX, old.startY)), 'старая карта: старт в ' + biomeName(old, old.startX, old.startY));
  const raw = enrichWorld(generateWorld(42, (() => { const r = createRng(42); r.noise = makeNoise2D(createRng(42 ^ 0x9e3779b9)); return r; })()), 42, { protectStart: false });
  console.log('  старт на старой карте: без защиты «' + biomeName(raw, raw.startX, raw.startY) +
    '», с защитой «' + biomeName(old, old.startX, old.startY) + '»');
});

t('enrichWorld детерминирован', () => {
  const mk = () => { const r = createRng(42); r.noise = makeNoise2D(createRng(42 ^ 0x9e3779b9)); return generateWorld(42, r); };
  const a = enrichWorld(mk(), 42), b = enrichWorld(mk(), 42);
  for (let i = 0; i < a.biome.length; i++) ok(a.biome[i] === b.biome[i] && a.river[i] === b.river[i], 'слой ' + i);
});

// ---------- 10. Сейв ----------
t('сейв/загрузка мостов', () => {
  const w = rows[0].w;
  const st = createWorldgenState(w);
  let n = 0;
  for (let i = 0; i < w.river.length && n < 3; i++) if (w.river[i]) { buildBridge(st, i % w.w, (i / w.w) | 0); n++; }
  ok(n === 3, 'не нашли три речные клетки');
  const json = JSON.parse(JSON.stringify(serialize(st)));
  const back = deserialize(json);
  ok(back.bridges.length === 3 && back.seed === st.seed, 'мосты не восстановились');
  for (const b of st.bridges) ok(hasBridge(back, b.x, b.y), 'мост ' + b.x + ',' + b.y + ' потерян');
  ok(!hasBridge(back, 0, 0), 'мост появился из ниоткуда');
  // Старый сейв без поля — не должен падать
  const empty = deserialize(undefined);
  ok(empty.bridges.length === 0, 'пустой сейв дал мосты');
  ok(!buildBridge(st, st.bridges[0].x, st.bridges[0].y), 'мост построен дважды');
});

// ---------- 11. Размер карты — параметр ----------
t('масштаб: 128/192/256 — больше материков, рек, времени', () => {
  console.log('\n  размер   | материки | острова | реки | длиннейшая | суша  | мс');
  console.log('  ---------+----------+---------+------+------------+-------+------');
  const times = {};
  for (const sz of [96, 128, 192, 256]) {
    const w = generateWorld2(2026, null, { w: sz, h: sz });
    const st = worldStats(w);
    times[sz] = w.genMs;
    console.log('  ' + pad(sz + '×' + sz, 8) + ' | ' + pad(st.continents, 8) + ' | ' + pad(st.islands, 7) + ' | ' +
      pad(st.rivers, 4) + ' | ' + pad(st.longestRiver, 10) + ' | ' + pad(pct(st.landPct), 5) + ' | ' + pad(w.genMs.toFixed(1), 5));
    ok(st.landPct > LAND_TARGET - 0.01 && st.landPct < LAND_TARGET + 0.01, sz + ': суша ' + pct(st.landPct));
    ok(st.rivers >= 3 && st.continents >= 1, sz + ': пустая карта');
    ok(WALKABLE.has(w.tiles[w.startY * w.w + w.startX]), sz + ': старт не проходим');
  }
  ok(times[96] < 200, 'генерация 96×96 медленная: ' + times[96].toFixed(1) + ' мс');
  ok(times[256] < 2000, 'генерация 256×256 медленная: ' + times[256].toFixed(1) + ' мс');
});

t('перф: средняя генерация 96×96 по 20 прогонам', () => {
  const t0 = Date.now();
  let acc = 0;
  for (let i = 0; i < 20; i++) acc += generateWorld2(1000 + i).genMs;
  const wall = Date.now() - t0;
  console.log('  среднее ' + (acc / 20).toFixed(1) + ' мс на карту, 20 карт за ' + wall + ' мс');
  ok(acc / 20 < 120, 'слишком медленно: ' + (acc / 20).toFixed(1) + ' мс');
});

// ---------- 12. Живая интеграция с ядром ----------
t('Simulation + enrichWorld: 100 дней и живые множители', () => {
  const s = new Simulation(42);
  enrichWorld(s.world, s.seed);
  const st = createWorldgenState(s.world);
  s.execCommand('give wood 200'); s.execCommand('give food 200');
  s.placeBuilding('hut', 44, 44); s.placeBuilding('lumber', 46, 42);
  for (let i = 0; i < 200; i++) s.tick(0.5);
  ok(s.villagers.length >= 3, 'племя вымерло: ' + s.villagers.length);
  const b = s.buildings.find(x => x.id === 'lumber');
  ok(b, 'лесопилки нет');
  const m = yieldMult(s.world, b.x, b.y, 'wood');
  ok(m > 0 && m <= 1.5, 'множитель леса вне диапазона: ' + m);
  console.log('  лесопилка в биоме «' + biomeName(s.world, b.x, b.y) + '»: дерево ×' + m.toFixed(2) +
    ', еда у кострища ×' + (yieldMult(s.world, s.world.startX, s.world.startY, 'food') * irrigation(s.world, s.world.startX, s.world.startY)).toFixed(2) +
    ', счастье ' + biomeHappy(s.world, s.world.startX, s.world.startY));
  ok(describeTile(s.world, st, b.x, b.y).length > 3, 'пустой тултип');
  ok(gatherMult(s.world, b.x, b.y) > 0, 'нулевой сбор');
});

console.log('\n' + (fail ? 'ПРОВАЛЕНО' : 'ВСЁ ЗЕЛЁНОЕ') + ': ' + pass + ' пройдено, ' + fail + ' провалено');
process.exit(fail ? 1 : 0);
