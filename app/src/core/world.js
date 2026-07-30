// core/world.js — генерация мира и A*-патфайндинг (engine-agnostic).
import { TILE, WALKABLE, TILE_COST } from './data.js';

export const WORLD_W = 96, WORLD_H = 96;

export function generateWorld(seed, rng) {
  // rng — уже созданный createRng(seed); noise — makeNoise2D от клона сида
  const noise = rng.noise;
  const tiles = new Uint8Array(WORLD_W * WORLD_H);
  const cx = WORLD_W / 2, cy = WORLD_H / 2;
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      const dx = (x - cx) / cx, dy = (y - cy) / cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let h = noise(x * 0.045, y * 0.045, 4) - dist * 1.15 + 0.18;
      const i = y * WORLD_W + x;
      if (h < -0.28) tiles[i] = TILE.DEEP;
      else if (h < -0.12) tiles[i] = TILE.WATER;
      else if (h < -0.05) tiles[i] = TILE.SAND;
      else if (h < 0.13) {
        const m = noise(x * 0.06 + 500, y * 0.06 + 500, 3);
        tiles[i] = m > 0.55 ? TILE.FOREST : TILE.GRASS;
      }
      else if (h < 0.24) tiles[i] = TILE.HILL;
      else tiles[i] = TILE.MOUNTAIN;
    }
  }
  // Гарантированная стартовая поляна: 9×9 травы в центре, лес к северу, холм к юго-востоку
  for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) setTile(tiles, cx + x, cy + y, TILE.GRASS);
  for (let y = -8; y <= -5; y++) for (let x = -3; x <= 3; x++) setTile(tiles, cx + x, cy + y, TILE.FOREST);
  for (let y = 5; y <= 7; y++) for (let x = 4; x <= 7; x++) setTile(tiles, cx + x, cy + y, TILE.HILL);
  // Гора рядом
  for (let y = -2; y <= 0; y++) for (let x = 8; x <= 9; x++) setTile(tiles, cx + x, cy + y, TILE.MOUNTAIN);
  return { w: WORLD_W, h: WORLD_H, tiles, seed, startX: cx, startY: cy };
}

function setTile(tiles, x, y, t) {
  if (x >= 0 && y >= 0 && x < WORLD_W && y < WORLD_H) tiles[y * WORLD_W + x] = t;
}

export function tileAt(world, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= world.w || yi >= world.h) return TILE.DEEP;
  return world.tiles[yi * world.w + xi];
}

export function isWater(world, x, y) {
  const t = tileAt(world, x, y);
  return t === TILE.DEEP || t === TILE.WATER;
}

// Движение к цели с защитой от перелёта (АНТИ-ОВЕРШУТ — не ломать: без него жители зацикливаются)
export function stepToward(world, ent, tx, ty, dist) {
  const dx = tx - ent.x, dy = ty - ent.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return true;
  if (dist >= len) {
    if (!isWater(world, tx, ty)) { ent.x = tx; ent.y = ty; return true; }
    dist = len * 0.5;
  }
  const nx = ent.x + (dx / len) * dist, ny = ent.y + (dy / len) * dist;
  if (!isWater(world, nx, ny)) { ent.x = nx; ent.y = ny; }
  else {
    // скольжение вдоль берега
    if (!isWater(world, nx, ent.y)) ent.x = nx;
    else if (!isWater(world, ent.x, ny)) ent.y = ny;
    else { const a = Math.atan2(dy, dx) + 0.6; const px = ent.x + Math.cos(a) * dist, py = ent.y + Math.sin(a) * dist; if (!isWater(world, px, py)) { ent.x = px; ent.y = py; } }
  }
  return Math.hypot(tx - ent.x, ty - ent.y) < 0.7;
}

// Поиск ближайшего тайла нужного типа (кольцами)
export function findNearestTile(world, x, y, tileType, maxR = 30, occupied = null) {
  const xi = Math.round(x), yi = Math.round(y);
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const tx = xi + dx, ty = yi + dy;
      if (tx < 0 || ty < 0 || tx >= world.w || ty >= world.h) continue;
      if (world.tiles[ty * world.w + tx] === tileType && (!occupied || !occupied(tx, ty))) return { x: tx, y: ty };
    }
  }
  return null;
}

export function hasNeighborTile(world, x, y, tileType) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (tileAt(world, x + dx, y + dy) === tileType) return true;
  }
  return false;
}

export function makeAnimal(rng, kind, x, y) {
  return { kind, x, y, tx: x, ty: y, hp: kind === 'mammoth' ? 30 : 8, food: kind === 'mammoth' ? 40 : 10, wander: rng.range(0, 3) };
}

// ---------------- A* (8-связность, бюджетная очередь) ----------------
const _gScore = new Float32Array(WORLD_W * WORLD_H);
const _cameFrom = new Int32Array(WORLD_W * WORLD_H);
const _closed = new Uint8Array(WORLD_W * WORLD_H);
const _stamp = new Uint16Array(WORLD_W * WORLD_H);
let _stampVal = 0;

// Находит путь от (sx,sy) до (tx,ty). Возвращает массив [{x,y}...] или null.
export function aStar(world, sx, sy, tx, ty, maxExpand = 2600) {
  sx = Math.round(sx); sy = Math.round(sy); tx = Math.round(tx); ty = Math.round(ty);
  const W = world.w, H = world.h;
  if (sx < 0 || sy < 0 || tx < 0 || ty < 0 || sx >= W || sy >= H || tx >= W || ty >= H) return null;
  if (!WALKABLE.has(world.tiles[ty * W + tx])) {
    const alt = findNearestTile(world, tx, ty, TILE.GRASS, 3);
    if (!alt) return null; tx = alt.x; ty = alt.y;
  }
  _stampVal = (_stampVal + 1) % 65535 || 1;
  const stamp = _stampVal;
  const open = []; // {i, f}
  const si = sy * W + sx;
  _gScore[si] = 0; _cameFrom[si] = -1; _stamp[si] = stamp;
  open.push({ i: si, f: 0 });
  const hFn = (x, y) => {
    const dx = Math.abs(x - tx), dy = Math.abs(y - ty);
    return Math.max(dx, dy) + 0.41 * Math.min(dx, dy);
  };
  let expanded = 0;
  while (open.length) {
    // бинарная куча не нужна при малом размере: линейный min
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k].f < open[bi].f) bi = k;
    const cur = open[bi]; open[bi] = open[open.length - 1]; open.pop();
    const ci = cur.i, cx = ci % W, cy = (ci / W) | 0;
    if (_closed[ci] === stamp) continue;
    _closed[ci] = stamp;
    if (cx === tx && cy === ty) {
      const path = [];
      let n = ci;
      while (n !== -1) { path.push({ x: n % W, y: (n / W) | 0 }); n = _cameFrom[n]; }
      path.reverse();
      return path;
    }
    if (++expanded > maxExpand) return null;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      const t = world.tiles[ni];
      if (!WALKABLE.has(t)) continue;
      if (dx && dy) { // диагональ: не срезать углы
        if (!WALKABLE.has(world.tiles[cy * W + nx]) || !WALKABLE.has(world.tiles[ny * W + cx])) continue;
      }
      const cost = (TILE_COST[t] || 1) * (dx && dy ? 1.41 : 1);
      const g = _gScore[ci] + cost;
      if (_stamp[ni] !== stamp || g < _gScore[ni]) {
        _stamp[ni] = stamp; _gScore[ni] = g; _cameFrom[ni] = ci;
        open.push({ i: ni, f: g + hFn(nx, ny) });
      }
    }
  }
  return null;
}

// Спавн фракций: ≥22 клетки от игрока и друг от друга, подходящий биом
export function findFactionSpawns(world, rng, count, playerX, playerY) {
  const spawns = [];
  const biomePref = { tide: TILE.WATER, grove: TILE.FOREST, horde: TILE.GRASS };
  let guard = 0;
  while (spawns.length < count && guard++ < 4000) {
    const x = rng.int(6, world.w - 7), y = rng.int(6, world.h - 7);
    if (Math.hypot(x - playerX, y - playerY) < 22) continue;
    if (spawns.some(s => Math.hypot(s.x - x, s.y - y) < 22)) continue;
    const t = tileAt(world, x, y);
    if (!WALKABLE.has(t)) continue;
    spawns.push({ x, y });
  }
  return spawns;
}
