// core/world.js — генерация мира и A*-патфайндинг (engine-agnostic).
import { TILE, WALKABLE, TILE_COST } from './data.js';

export const WORLD_W = 96, WORLD_H = 96;

// Пороги калиброваны по РЕАЛЬНОМУ размаху шума. Прежняя версия ставила лес при
// `m > 0.55`, тогда как fBm не выходит за ±0.42 — природный лес не появлялся
// ни на одном сиде, оставалась только захардкоженная стартовая роща в 28 клеток.
// Так же и горы: высота в центре карты доходила лишь до 0.545 при пороге 0.24,
// поэтому на весь мир приходилось 6–16 горных клеток. Лесопилке нужен соседний
// лес, шахте — гора, каменоломне — холм, так что половина экономики висела
// на паре десятков клеток.
export function generateWorld(seed, rng) {
  // rng — уже созданный createRng(seed); noise — makeNoise2D от клона сида
  const noise = rng.noise;
  const tiles = new Uint8Array(WORLD_W * WORLD_H);
  const cx = WORLD_W / 2, cy = WORLD_H / 2;
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      const dx = (x - cx) / cx, dy = (y - cy) / cy;
      // Берег изрезаем шумом, иначе материк выходит правильным кругом.
      const dist = Math.sqrt(dx * dx + dy * dy) + noise(x * 0.055 + 900, y * 0.055 + 900, 2) * 0.22;
      // Плато в центре и мягкий спад к краю: степень 2.4 держит середину карты
      // сушей, а océan оставляет только по периметру.
      const falloff = Math.pow(Math.max(0, dist), 2.4) * 1.15;
      const base = noise(x * 0.035, y * 0.035, 4) * 1.7;
      const detail = noise(x * 0.1 + 200, y * 0.1 + 200, 3) * 0.3;
      const h = base + detail + 0.5 - falloff;
      // Гребневой шум даёт горные ЦЕПИ, а не одиночные точки в центре.
      const ridge = 1 - Math.abs(noise(x * 0.045 + 300, y * 0.045 + 300, 3)) * 3.2;
      const i = y * WORLD_W + x;
      if (h < -0.34) tiles[i] = TILE.DEEP;
      else if (h < -0.10) tiles[i] = TILE.WATER;
      else if (h < -0.01) tiles[i] = TILE.SAND;
      else if (ridge > 0.62 && h > 0.30) tiles[i] = TILE.MOUNTAIN;
      else if (ridge > 0.34 && h > 0.14) tiles[i] = TILE.HILL;
      else {
        // Влажность: порог 0.06 попадает примерно в четверть суши — леса
        // получаются массивами, а не отдельными клетками.
        const m = noise(x * 0.07 + 500, y * 0.07 + 500, 3);
        tiles[i] = m > 0.06 ? TILE.FOREST : TILE.GRASS;
      }
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

// ---------------- A* (8-связность, двоичная куча) ----------------
const _gScore = new Float32Array(WORLD_W * WORLD_H);
const _cameFrom = new Int32Array(WORLD_W * WORLD_H);
// _closed был Uint8Array при штампе, растущем до 65535: запись усекалась, и
// сравнение _closed[i] === stamp переставало срабатывать после 255-го поиска —
// проверка закрытого множества становилась мёртвой. Разрядность выровнена.
const _closed = new Uint16Array(WORLD_W * WORLD_H);
const _stamp = new Uint16Array(WORLD_W * WORLD_H);
let _stampVal = 0;

// Двоичная куча на типизированных массивах: очередь раньше была обычным
// массивом с линейным поиском минимума, то есть O(n²) на раскрытие. На карте,
// где суши стало втрое больше, это и упиралось в лимит времени.
const _heapI = new Int32Array(WORLD_W * WORLD_H * 4);
const _heapF = new Float32Array(WORLD_W * WORLD_H * 4);
let _heapN = 0;

function heapPush(i, f) {
  let k = _heapN++;
  _heapI[k] = i; _heapF[k] = f;
  while (k > 0) {
    const p = (k - 1) >> 1;
    if (_heapF[p] <= _heapF[k]) break;
    const ti = _heapI[p], tf = _heapF[p];
    _heapI[p] = _heapI[k]; _heapF[p] = _heapF[k];
    _heapI[k] = ti; _heapF[k] = tf;
    k = p;
  }
}

function heapPop() {
  const top = _heapI[0];
  _heapN--;
  if (_heapN > 0) {
    _heapI[0] = _heapI[_heapN]; _heapF[0] = _heapF[_heapN];
    let k = 0;
    for (;;) {
      const l = k * 2 + 1, r = l + 1;
      let m = k;
      if (l < _heapN && _heapF[l] < _heapF[m]) m = l;
      if (r < _heapN && _heapF[r] < _heapF[m]) m = r;
      if (m === k) break;
      const ti = _heapI[m], tf = _heapF[m];
      _heapI[m] = _heapI[k]; _heapF[m] = _heapF[k];
      _heapI[k] = ti; _heapF[k] = tf;
      k = m;
    }
  }
  return top;
}

// Находит путь от (sx,sy) до (tx,ty). Возвращает массив [{x,y}...] или null.
// Лимит расширений подобран по замеру: при 2600 на новой карте не находилось
// 60 из 474 достижимых целей, при 12000 — одна (настоящий отрезанный островок).
export function aStar(world, sx, sy, tx, ty, maxExpand = 12000) {
  sx = Math.round(sx); sy = Math.round(sy); tx = Math.round(tx); ty = Math.round(ty);
  const W = world.w, H = world.h;
  if (sx < 0 || sy < 0 || tx < 0 || ty < 0 || sx >= W || sy >= H || tx >= W || ty >= H) return null;
  if (!WALKABLE.has(world.tiles[ty * W + tx])) {
    const alt = findNearestTile(world, tx, ty, TILE.GRASS, 3);
    if (!alt) return null; tx = alt.x; ty = alt.y;
  }
  _stampVal = (_stampVal + 1) % 65535 || 1;
  const stamp = _stampVal;
  _heapN = 0;
  const si = sy * W + sx;
  _gScore[si] = 0; _cameFrom[si] = -1; _stamp[si] = stamp;
  heapPush(si, 0);
  const hFn = (x, y) => {
    const dx = Math.abs(x - tx), dy = Math.abs(y - ty);
    return Math.max(dx, dy) + 0.41 * Math.min(dx, dy);
  };
  let expanded = 0;
  while (_heapN > 0) {
    const ci = heapPop(), cx = ci % W, cy = (ci / W) | 0;
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
        heapPush(ni, g + hFn(nx, ny));
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
