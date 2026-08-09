// render3d/demo3d.js — демонстрация одной сцены целиком.
//
// Здесь НЕТ игровой логики и НЕТ выдуманных данных: страница поднимает
// настоящую Simulation, ставит настоящий город её же командами и показывает
// результат в 3D. Смысл именно в этом — доказать, что трёхмерный слой работает
// на живых данных игры, а не на подготовленном макете.
import { Simulation } from '../core/simulation.js';
import * as WG2 from '../core/systems/worldgen2.js';
import { Scene3D } from './scene3d.js';

// Тот же город, что снимает tools/shot.mjs для 2D: сравнивать кадры имеет
// смысл только если в них одно и то же.
const PLAN = [
  'campfire', 'hut', 'stone_house', 'granary', 'smithy', 'market', 'barracks',
  'temple', 'academy', 'castle', 'mill', 'university', 'farm', 'lumber', 'quarry',
];

export function buildDemo(opts = {}) {
  const seed = opts.seed ?? 4242;
  const era = opts.era ?? 4;
  const sim = new Simulation(seed, { startEra: era });

  // Слои рельефа. Путь «A» из worldgen2: тайлы НЕ меняются, поэтому пути,
  // размещение зданий, сейвы и тесты работают ровно как раньше — добавляются
  // только elev/river/biome, которые нужны трёхмерной земле.
  WG2.enrichWorld(sim.world, sim.world.seed);

  sim.execCommand('godmode');
  sim.execCommand('unlockall');
  for (const r of ['wood', 'stone', 'gold', 'steel', 'food']) sim.execCommand(`give ${r} 99999`);

  const cx = Math.round(sim.world.startX), cy = Math.round(sim.world.startY);
  for (const id of PLAN) {
    let placed = false;
    for (let r = 1; r < 14 && !placed; r++) {
      for (let dy = -r; dy <= r && !placed; dy++) {
        for (let dx = -r; dx <= r && !placed; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx, y = cy + dy;
          if (sim.canPlace(id, x, y).ok && sim.placeBuilding(id, x, y)) placed = true;
        }
      }
    }
  }
  for (const b of sim.buildings) { b.done = true; b.progress = b.buildDays; }
  sim.execCommand('spawn 24');
  return sim;
}

export function mount(canvas, opts = {}) {
  const sim = opts.sim || buildDemo(opts);
  const scene = new Scene3D(canvas, {
    dpr: opts.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1),
    shadows: opts.shadows !== false,
    shadowMapSize: opts.shadowMapSize || 2048,
  });

  scene.buildWorld(sim);
  const nb = scene.buildBuildings(sim);
  const np = scene.buildPeople(sim);
  scene.setDayTime(opts.dayTime ?? 0.62);

  const cx = Math.round(sim.world.startX), cy = Math.round(sim.world.startY);
  scene.lookAt(cx, cy, opts.dist ?? 34, opts.tilt ?? 0.92, opts.turn ?? -0.6);

  const fit = () => {
    const w = canvas.clientWidth || 1280, h = canvas.clientHeight || 720;
    scene.resize(w, h, opts.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1));
    // lookAt пересчитывает и цель тени: без этого после смены размера окна
    // тень остаётся привязанной к прежнему центру.
    scene.lookAt(cx, cy, opts.dist ?? 34, opts.tilt ?? 0.92, opts.turn ?? -0.6);
  };
  fit();
  if (typeof window !== 'undefined') window.addEventListener('resize', fit);

  return { sim, scene, counts: { buildings: nb, people: np }, cx, cy, fit };
}
