// Тесты ИИ цивилизаций (U29). Запуск: node app/tests/test-civ-ai.mjs
// Главное доказательство — таблица прогонов 10 сидов × 3000 дней: фракции
// должны расти и РАЗЛИЧАТЬСЯ по своим чертам, а не одинаково имитировать жизнь.
import { readFileSync } from 'node:fs';
import { createRng, makeNoise2D } from '../src/core/rng.js';
import { generateWorld, findFactionSpawns } from '../src/core/world.js';
import { FACTIONS, TECHS, BUILDINGS, WALKABLE } from '../src/core/data.js';
import { Simulation } from '../src/core/simulation.js';
import { createDiplomacy, tickDiplomacy, warStats, allianceList } from '../src/core/systems/diplomacy_ext.js';
import {
  createCivAi, tickCivAi, civReport, civOf, buildingCount, knownTechs,
  serializeCivAi, deserializeCivAi, RES_IDS,
} from '../src/core/systems/civ_ai.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('OK', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); if (process.env.CIVDEBUG) console.log(e.stack); } };
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

// ---------- Стенд ----------
// Мир и фракции как в ядре (тот же generateWorld и findFactionSpawns), но без
// жителей игрока: проверяем именно соседей, а не весь тик симуляции.
function makeWorld(seed) {
  const rng = createRng(seed);
  rng.noise = makeNoise2D(createRng(seed ^ 0x9e3779b9)); // как в конструкторе Simulation
  return { world: generateWorld(seed, rng), rng };
}

// Запасное место, когда findFactionSpawns не набрал восьми точек с шагом 22:
// ищем проходимую сушу подальше от уже занятых — иначе фракция окажется в горе.
function fallbackSpot(world, rng, taken) {
  for (let i = 0; i < 3000; i++) {
    const x = rng.int(6, world.w - 7), y = rng.int(6, world.h - 7);
    if (!WALKABLE.has(world.tiles[y * world.w + x])) continue;
    if (Math.hypot(x - world.startX, y - world.startY) < 16) continue;
    if (taken.some(s => Math.hypot(s.x - x, s.y - y) < 12)) continue;
    return { x, y };
  }
  return null;
}

function spawnFactions(world, rng, count) {
  const picks = FACTIONS.slice(0, count);
  const spawns = findFactionSpawns(world, rng, count, world.startX, world.startY);
  const taken = spawns.slice();
  return picks.map((def, i) => {
    const s = spawns[i] || fallbackSpot(world, rng, taken);
    if (s && !spawns[i]) taken.push(s);
    if (!s) throw new Error('не нашлось места под фракцию');
    return {
      id: def.id, def, P: 12, era: 0, knowPts: 0, techCount: 1,
      armyPts: 4, wallPts: 0, goldPts: 0,
      settlements: [{ x: s.x, y: s.y, capital: true }],
      alive: true, weak: false,
    };
  });
}

// Один прогон: сид, дни. Игрок — неподвижная деревня с медленно растущей армией:
// ИИ должен видеть в нём соседа, но тест меряет жизнь фракций.
function run(seed, days, { state = null, diplo = null, factions = null, from = 0 } = {}) {
  const { world, rng } = makeWorld(seed);
  const fs = factions || spawnFactions(world, rng, FACTIONS.length);
  const st = state || createCivAi(fs);
  const D = diplo || createDiplomacy();
  const playerWars = [];
  const relations = {};
  for (const f of fs) relations[f.id] = 0;
  let playerWarsDeclared = 0;
  for (let d = from; d < from + days; d++) {
    const player = { armyPower: 10 + d * 0.02, era: Math.floor(d / 400), techs: new Set(['fire']), gold: 200,
      settlements: [{ x: world.startX, y: world.startY }] };
    const out = tickCivAi(st, {
      day: d, rng, world, factions: fs, diplo: D, relations, difficulty: 'normal',
      playerWars, player,
    });
    playerWarsDeclared += out.warOnPlayer.length;
    for (const w of out.warOnPlayer) if (!playerWars.includes(w.fid)) playerWars.push(w.fid);
    // Мир с игроком заключает ядро; здесь — простейшая замена: через 80 дней
    // войны стороны расходятся, иначе список войн игрока рос бы вечно.
    tickDiplomacy(D, {
      day: d, rng, difficulty: 'normal', factions: fs, relations,
      playerWars, treaties: [], player, trespass: [],
    });
    if (d % 80 === 0) playerWars.length = 0;
  }
  return { world, rng, fs, st, D, report: civReport(st, fs), playerWarsDeclared };
}

// ---------- Тесты ----------
t('фракции строят, а не растут абстрактной мощью', () => {
  const r = run(101, 800);
  const built = r.report.reduce((s, x) => s + x.buildings, 0);
  ok(built > 20, `построек всего ${built}, ожидалось >20`);
  const withB = r.report.filter(x => x.buildings > 0).length;
  ok(withB === r.report.length, `${r.report.length - withB} фракций не построили ничего`);
  // Постройки должны быть настоящими id из BUILDINGS и открытыми технологией
  for (const f of r.fs) {
    const c = civOf(r.st, f.id);
    const known = new Set(c.techs);
    for (const bid of Object.keys(c.buildings)) {
      ok(BUILDINGS[bid], `неизвестное здание ${bid}`);
      const req = BUILDINGS[bid].req;
      ok(!req || known.has(req), `${f.id} построил ${bid} без технологии ${req}`);
    }
  }
});

t('дерево технологий проходится по prereq, без дыр', () => {
  const r = run(102, 1500);
  for (const f of r.fs) {
    const techs = knownTechs(r.st, f.id);
    ok(techs.length > 3, `${f.id} изучил всего ${techs.length}`);
    const known = new Set();
    for (const id of techs) {
      const def = TECHS.find(x => x.id === id);
      ok(def, `неизвестная технология ${id}`);
      ok(def.prereq.every(p => known.has(p)), `${f.id}: ${id} изучен без предпосылок`);
      known.add(id);
    }
    ok(f.techCount === techs.length, `techCount ядра рассинхронизирован у ${f.id}`);
  }
});

t('поселения основываются на проходимой суше и не впритык', () => {
  const r = run(103, 3000);
  const all = [];
  for (const f of r.fs) for (const s of f.settlements) all.push({ ...s, id: f.id });
  const founded = r.report.reduce((s, x) => s + x.founded, 0);
  ok(founded > 0, 'никто не основал ни одного нового поселения');
  const { world } = r;
  for (const s of all) {
    const tile = world.tiles[s.y * world.w + s.x];
    ok([2, 3, 4, 5].includes(tile), `поселение на непроходимом тайле ${tile}`);
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const d = Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y);
      ok(d >= 7.9, `поселения ${all[i].id} и ${all[j].id} в ${d.toFixed(1)} клетках`);
    }
  }
});

t('казна и население остаются конечными числами без минусов', () => {
  const r = run(104, 3000);
  for (const f of r.fs) {
    const c = civOf(r.st, f.id);
    for (const k of RES_IDS) {
      ok(Number.isFinite(c.res[k]), `${f.id}.${k} = ${c.res[k]}`);
      ok(c.res[k] >= -1e-6, `${f.id}.${k} ушёл в минус: ${c.res[k]}`);
    }
    ok(Number.isFinite(f.P) && f.P >= 0, `${f.id}.P = ${f.P}`);
    ok(Number.isFinite(f.armyPts) && f.armyPts >= 0, `${f.id}.armyPts = ${f.armyPts}`);
  }
});

t('детерминизм: один сид — один результат, разные сиды — разные', () => {
  const a = JSON.stringify(run(777, 900).report);
  const b = JSON.stringify(run(777, 900).report);
  const c = JSON.stringify(run(778, 900).report);
  ok(a === b, 'один сид дал разные результаты');
  ok(a !== c, 'разные сиды дали одинаковый результат');
});

t('в модуле нет Math.random', () => {
  const src = readFileSync(new URL('../src/core/systems/civ_ai.js', import.meta.url), 'utf8');
  ok(!/Math\.random/.test(src), 'найден Math.random — детерминизм сломан');
});

t('serialize/deserialize продолжает партию с той же точки', () => {
  const first = run(55, 600);
  const dump = JSON.parse(JSON.stringify(serializeCivAi(first.st)));
  const restored = deserializeCivAi(dump, first.fs);
  for (const f of first.fs) {
    const a = civOf(first.st, f.id), b = civOf(restored, f.id);
    ok(JSON.stringify(a.buildings) === JSON.stringify(b.buildings), `постройки ${f.id} не совпали`);
    ok(a.techs.join() === b.techs.join(), `технологии ${f.id} не совпали`);
    for (const k of RES_IDS) ok(Math.abs(a.res[k] - b.res[k]) < 1e-9, `${f.id}.${k} не совпал`);
    ok(Math.abs(a.troops - b.troops) < 1e-9, `войска ${f.id} не совпали`);
  }
  ok(restored.lastDay === first.st.lastDay, 'день последнего тика не восстановлен');
  ok(buildingCount(restored, first.fs[0].id) === buildingCount(first.st, first.fs[0].id), 'счёт построек не восстановлен');
});

t('союзы и войны ведутся реестром diplomacy_ext, второго списка нет', () => {
  const r = run(303, 3000);
  const ws = warStats(r.D, 3000);
  ok(ws.finished > 0, 'за 3000 дней не завершилось ни одной войны');
  ok(ws.longestActive < 400, `висит война длиной ${ws.longestActive} дней`);
  const al = allianceList(r.D);
  const claimed = r.report.reduce((s, x) => s + x.allies, 0);
  ok(claimed === 0 || al.length > 0, 'модуль заявил союзы, а в реестре пусто');
});

t('модуль работает на настоящих объектах Simulation', () => {
  const sim = new Simulation(2024, { factions: 3 });
  const diplo = createDiplomacy();
  const st = createCivAi(sim.factions);
  for (let d = 0; d < 400; d++) {
    const out = tickCivAi(st, {
      day: d, rng: sim.rng, world: sim.world, factions: sim.factions, diplo,
      relations: sim.relations, difficulty: sim.difficulty, playerWars: [],
      player: { armyPower: sim.armyPower(), era: sim.eraIndex,
        settlements: [{ x: sim.world.startX, y: sim.world.startY }] },
    });
    for (const w of out.warOnPlayer) { const f = sim.faction(w.fid); if (f) sim.declareWarOnPlayer(f); }
  }
  const rep = civReport(st, sim.factions);
  ok(rep.length === 3, 'фракций не 3');
  ok(rep.every(x => x.buildings > 0 && x.techs > 1), 'фракции ядра не развились');
  ok(sim.factions.every(f => Number.isFinite(f.armyPts) && Number.isFinite(f.P)), 'поля ядра испорчены');
});

// ---------- Главное доказательство: 10 сидов × 3000 дней ----------
const SEEDS = [11, 23, 37, 44, 59, 68, 71, 83, 97, 108];
const DAYS = 3000;
const agg = new Map();
for (const def of FACTIONS) {
  agg.set(def.id, { name: def.name, tr: def.traits, techs: 0, towns: 0, buildings: 0, pop: 0, army: 0, wars: 0, allies: 0, era: 0, alive: 0 });
}
let totalWarsFinished = 0, totalAlliances = 0, totalPlayerWars = 0;
const started = Date.now();
for (const seed of SEEDS) {
  const r = run(seed, DAYS);
  for (const row of r.report) {
    const a = agg.get(row.id);
    a.techs += row.techs; a.towns += row.towns; a.buildings += row.buildings;
    a.pop += row.pop; a.army += row.army; a.wars += row.wars; a.allies += row.allies;
    a.era += row.era; a.alive += row.alive ? 1 : 0;
  }
  totalWarsFinished += warStats(r.D, DAYS).finished;
  totalAlliances += allianceList(r.D).length;
  totalPlayerWars += r.playerWarsDeclared;
}
const N = SEEDS.length;
const rows = [...agg.values()].map(a => ({
  name: a.name, tr: a.tr,
  techs: a.techs / N, towns: a.towns / N, buildings: a.buildings / N,
  pop: a.pop / N, army: a.army / N, wars: a.wars / N, allies: a.allies / N, era: a.era / N,
}));

console.log(`\n=== ${N} сидов × ${DAYS} дней, ${FACTIONS.length} фракций (среднее на прогон) ===`);
console.log(pad('Фракция', 20) + padL('агр', 4) + padL('эксп', 5) + padL('наук', 5)
  + padL('техи', 6) + padL('эпоха', 7) + padL('города', 8) + padL('строек', 8)
  + padL('насел', 7) + padL('армия', 7) + padL('войны', 7) + padL('союзы', 7));
for (const r of rows.slice().sort((x, y) => y.techs - x.techs)) {
  console.log(pad(r.name, 20) + padL(r.tr.aggression, 4) + padL(r.tr.expansion, 5) + padL(r.tr.science, 5)
    + padL(r.techs.toFixed(1), 6) + padL(r.era.toFixed(1), 7) + padL(r.towns.toFixed(1), 8)
    + padL(r.buildings.toFixed(1), 8) + padL(r.pop.toFixed(0), 7) + padL(r.army.toFixed(0), 7)
    + padL(r.wars.toFixed(1), 7) + padL(r.allies.toFixed(1), 7));
}
console.log(`Завершённых войн (реестр diplomacy_ext): ${(totalWarsFinished / N).toFixed(1)} на прогон · `
  + `союзов на конец: ${(totalAlliances / N).toFixed(1)} · войн объявлено игроку: ${(totalPlayerWars / N).toFixed(1)}`);
console.log(`Время: ${((Date.now() - started) / 1000).toFixed(1)} c\n`);

const avg = (sel, pred) => {
  const set = rows.filter(r => pred(r.tr));
  return set.reduce((s, r) => s + sel(r), 0) / Math.max(1, set.length);
};

t('воинственные воюют чаще миролюбивых', () => {
  const hi = avg(r => r.wars, tr => tr.aggression >= 7);
  const lo = avg(r => r.wars, tr => tr.aggression <= 3);
  console.log(`   войн: агрессия≥7 → ${hi.toFixed(2)}, агрессия≤3 → ${lo.toFixed(2)}`);
  ok(hi > lo, `воинственные ${hi.toFixed(2)} vs мирные ${lo.toFixed(2)}`);
});

t('научные обгоняют по технологиям', () => {
  const hi = avg(r => r.techs, tr => tr.science >= 7);
  const lo = avg(r => r.techs, tr => tr.science <= 3);
  console.log(`   техов: наука≥7 → ${hi.toFixed(2)}, наука≤3 → ${lo.toFixed(2)}`);
  ok(hi > lo + 1, `научные ${hi.toFixed(2)} vs остальные ${lo.toFixed(2)}`);
});

t('экспансивные основывают больше поселений', () => {
  const hi = avg(r => r.towns, tr => tr.expansion >= 7);
  const lo = avg(r => r.towns, tr => tr.expansion <= 3);
  console.log(`   городов: экспансия≥7 → ${hi.toFixed(2)}, экспансия≤3 → ${lo.toFixed(2)}`);
  ok(hi > lo, `экспансивные ${hi.toFixed(2)} vs осёдлые ${lo.toFixed(2)}`);
});

t('за 3000 дней цивилизации выросли, а не замерли', () => {
  const techs = rows.reduce((s, r) => s + r.techs, 0) / rows.length;
  const towns = rows.reduce((s, r) => s + r.towns, 0) / rows.length;
  const b = rows.reduce((s, r) => s + r.buildings, 0) / rows.length;
  ok(techs >= 12, `в среднем всего ${techs.toFixed(1)} технологий`);
  ok(towns > 1.5, `в среднем всего ${towns.toFixed(2)} поселений`);
  ok(b >= 10, `в среднем всего ${b.toFixed(1)} построек`);
});

console.log(`\nИТОГО: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
