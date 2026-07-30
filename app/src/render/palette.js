// render/palette.js — цветовая библия рендера: местность по сезонам, палитры эпох,
// свет по времени суток. Всё в одном месте, чтобы картинка была единой системой,
// а не набором случайных цветов по файлам.
import { TILE } from '../core/data.js';

// ---------------------------------------------------------------------------
// Местность. На каждый тайл — не один цвет, а слоистая палитра:
//   base  — заливка, lo/hi — низ/верх для рельефа, det — цвет деталей (трава, камни),
//   det2  — второй цвет деталей, edge — цвет для стыка с соседями.
// Четыре сезона: весна, лето, осень, зима.
// ---------------------------------------------------------------------------
function T(base, lo, hi, det, det2, edge) { return { base, lo, hi, det, det2, edge }; }

export const TERRAIN = [
  // ---- ВЕСНА ----
  {
    [TILE.DEEP]:     T('#123a5c', '#0b2440', '#1d4f76', '#1a4a6e', '#265f88', '#0e3050'),
    [TILE.WATER]:    T('#1f5b86', '#153f61', '#3279a6', '#3d86b3', '#5aa0c8', '#1a4d74'),
    [TILE.SAND]:     T('#cdb98c', '#a8946a', '#e2d2a8', '#bda874', '#e6dab6', '#c0aa7c'),
    [TILE.GRASS]:    T('#5a9b47', '#3f7533', '#79b95f', '#6cae52', '#8ec96f', '#4f8a3e'),
    [TILE.FOREST]:   T('#2f6b34', '#1d4a23', '#427f43', '#3c7a3a', '#54964d', '#2a5c2e'),
    [TILE.HILL]:     T('#7d8a56', '#5b6640', '#9aa66d', '#8a9660', '#a8b47c', '#6d7a4c'),
    [TILE.MOUNTAIN]: T('#767783', '#4f5059', '#9b9ca8', '#8a8b96', '#c3c4cd', '#63646e'),
  },
  // ---- ЛЕТО ----
  {
    [TILE.DEEP]:     T('#10365a', '#09203d', '#1a4a72', '#184568', '#235a84', '#0c2c4c'),
    [TILE.WATER]:    T('#1d5680', '#133a5c', '#2f74a0', '#3a81ad', '#57a0c6', '#184a70'),
    [TILE.SAND]:     T('#d8c48f', '#b29c6c', '#efdfad', '#c8b177', '#f0e3ba', '#cbb47f'),
    [TILE.GRASS]:    T('#67a744', '#4a8130', '#87c65c', '#78ba4f', '#9dd76b', '#5b9540'),
    [TILE.FOREST]:   T('#2a6330', '#194320', '#3d773e', '#377336', '#4d8e47', '#255529'),
    [TILE.HILL]:     T('#87925a', '#636d43', '#a5ae71', '#949f64', '#b3bd80', '#77824f'),
    [TILE.MOUNTAIN]: T('#787985', '#50515a', '#9d9eaa', '#8c8d98', '#c5c6cf', '#656670'),
  },
  // ---- ОСЕНЬ ----
  {
    [TILE.DEEP]:     T('#123a5c', '#0b2440', '#1d4f76', '#1a4a6e', '#265f88', '#0e3050'),
    [TILE.WATER]:    T('#1f5b86', '#153f61', '#3279a6', '#3d86b3', '#5aa0c8', '#1a4d74'),
    [TILE.SAND]:     T('#cdb28a', '#a78e68', '#e2c9a6', '#bd9f72', '#e6d3b4', '#c0a47a'),
    [TILE.GRASS]:    T('#9a8536', '#75632a', '#b8a24c', '#ad9440', '#c9b45e', '#8a762f'),
    [TILE.FOREST]:   T('#7a5629', '#5a3d1c', '#996e39', '#8f6733', '#b98748', '#6b4a24'),
    [TILE.HILL]:     T('#8a7a54', '#665a3d', '#a8976a', '#978660', '#b5a479', '#7a6b4a'),
    [TILE.MOUNTAIN]: T('#767783', '#4f5059', '#9b9ca8', '#8a8b96', '#c3c4cd', '#63646e'),
  },
  // ---- ЗИМА ----
  {
    [TILE.DEEP]:     T('#0e2a44', '#071a2e', '#173d5c', '#153856', '#1e4a6c', '#0a2138'),
    [TILE.WATER]:    T('#1a4a6b', '#113252', '#2a6489', '#356f95', '#4d88a8', '#154060'),
    [TILE.SAND]:     T('#d6d6d8', '#b0b0b4', '#eeeef0', '#c4c4c8', '#f2f2f4', '#c8c8cc'),
    [TILE.GRASS]:    T('#c6d6cd', '#9fb1a8', '#e4efe8', '#d2e0d8', '#f0f6f2', '#b4c5bc'),
    [TILE.FOREST]:   T('#4e6b5c', '#374d42', '#688775', '#5e7b6b', '#7d9a89', '#455f52'),
    [TILE.HILL]:     T('#9a9a94', '#727270', '#b8b8b2', '#a8a8a2', '#c8c8c4', '#888884'),
    [TILE.MOUNTAIN]: T('#a2a2ac', '#767680', '#c8c8d2', '#b4b4be', '#e6e6ee', '#8e8e98'),
  },
];

// Относительная высота тайла — основа рельефного освещения.
export const TILE_HEIGHT = {
  [TILE.DEEP]: -0.55, [TILE.WATER]: -0.25, [TILE.SAND]: 0.00,
  [TILE.GRASS]: 0.10, [TILE.FOREST]: 0.16, [TILE.HILL]: 0.62, [TILE.MOUNTAIN]: 1.35,
};

// ---------------------------------------------------------------------------
// Палитры эпох для построек: стена, крыша, отделка, стекло, свет окна.
// ---------------------------------------------------------------------------
export const ERA_PALETTE = [
  { wall: '#9a7d5c', roof: '#6b4f35', trim: '#5d4a33', glass: '#3b2f22', glow: '#ffb457', accent: '#c9a227' }, // каменный
  { wall: '#c9a86e', roof: '#8a6d42', trim: '#a0522d', glass: '#4a3a26', glow: '#ffc06a', accent: '#d2b271' }, // бронза
  { wall: '#a4947c', roof: '#4a4a52', trim: '#3d3d45', glass: '#2e3038', glow: '#ffbe62', accent: '#b9a98e' }, // железо
  { wall: '#ece4cc', roof: '#b08d57', trim: '#8a7a5a', glass: '#5a5140', glow: '#ffd08a', accent: '#e0d3a8' }, // античность
  { wall: '#bda282', roof: '#8a3d2d', trim: '#6b4f35', glass: '#3f3226', glow: '#ffc072', accent: '#c8a06a' }, // средневековье
  { wall: '#dccaa6', roof: '#a0522d', trim: '#8a6d42', glass: '#4f4030', glow: '#ffd493', accent: '#dcc48c' }, // возрождение
  { wall: '#a4705a', roof: '#4a3d35', trim: '#3d3229', glass: '#33302c', glow: '#ffcc7a', accent: '#b0836a' }, // индустрия
  { wall: '#b2bcc4', roof: '#5a6b7a', trim: '#4aa3c7', glass: '#2d4250', glow: '#a8e2ff', accent: '#7fc8e8' }, // современность
  { wall: '#ccd8ea', roof: '#4a5a7a', trim: '#7d9de8', glass: '#2c3a58', glow: '#a6c8ff', accent: '#9db4f0' }, // цифровая
  { wall: '#eaf6fa', roof: '#2d4a5a', trim: '#7de3ff', glass: '#1e3844', glow: '#c2f4ff', accent: '#7de3ff' }, // будущее
];

// Одежда жителей по эпохам (низ — рабочая, верх — праздничная).
export const VILLAGER_CLOTH = [
  ['#8a6d4f', '#6d5540'], ['#c4a06a', '#a07d4e'], ['#6f6f78', '#565660'], ['#e8e0c8', '#c4bda6'],
  ['#8a3d2d', '#6b2e22'], ['#d4af37', '#a8892b'], ['#5a4a42', '#453832'], ['#4aa3c7', '#3782a0'],
  ['#7d9de8', '#5f7cbc'], ['#dff4f8', '#a8d4dd'],
];

// ---------------------------------------------------------------------------
// Свет по времени суток. dayTime ∈ [0,1): 0 — полночь, 0.5 — полдень.
//   mul   — множитель яркости земли (умножающий слой)
//   tint  — цвет подсветки [r,g,b,a] (наложение сверху)
//   sunAz — азимут солнца в радианах (направление тени)
//   glow  — насколько горят окна (0 днём, 1 ночью)
//   sky   — цвет неба за краем карты
// ---------------------------------------------------------------------------
const KEY = [
  //  t     mul     tint (r,g,b,a)             sunAz  glow  sky
  { t: 0.00, mul: 0.42, tint: [22, 34, 86, 0.46], az: -2.36, glow: 1.00, sky: '#070c1c' },
  { t: 0.20, mul: 0.48, tint: [30, 40, 92, 0.40], az: -2.36, glow: 1.00, sky: '#0b1330' },
  { t: 0.26, mul: 0.78, tint: [255, 148, 78, 0.30], az: -3.05, glow: 0.55, sky: '#3a2a44' },
  { t: 0.32, mul: 0.96, tint: [255, 206, 140, 0.13], az: -2.75, glow: 0.10, sky: '#7fa4c8' },
  { t: 0.50, mul: 1.00, tint: [255, 246, 224, 0.05], az: -2.36, glow: 0.00, sky: '#9dc4e4' },
  { t: 0.70, mul: 0.97, tint: [255, 214, 150, 0.12], az: -1.95, glow: 0.06, sky: '#9ab8d8' },
  { t: 0.78, mul: 0.76, tint: [255, 124, 74, 0.32], az: -1.60, glow: 0.60, sky: '#54344a' },
  { t: 0.86, mul: 0.50, tint: [34, 42, 98, 0.42], az: -2.36, glow: 1.00, sky: '#141a3a' },
  { t: 1.00, mul: 0.42, tint: [22, 34, 86, 0.46], az: -2.36, glow: 1.00, sky: '#070c1c' },
];

const lerp = (a, b, k) => a + (b - a) * k;

export function lightAt(dayTime) {
  const t = ((dayTime % 1) + 1) % 1;
  let i = 0;
  while (i < KEY.length - 2 && KEY[i + 1].t <= t) i++;
  const a = KEY[i], b = KEY[i + 1];
  const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return {
    mul: lerp(a.mul, b.mul, k),
    tint: [
      Math.round(lerp(a.tint[0], b.tint[0], k)),
      Math.round(lerp(a.tint[1], b.tint[1], k)),
      Math.round(lerp(a.tint[2], b.tint[2], k)),
      lerp(a.tint[3], b.tint[3], k),
    ],
    sunAz: lerp(a.az, b.az, k),
    glow: lerp(a.glow, b.glow, k),
    sky: k < 0.5 ? a.sky : b.sky,
    // длина тени: коротко в полдень, длинно на рассвете и закате
    shadowLen: 0.55 + 1.9 * Math.min(1, Math.abs(t - 0.5) * 2.6),
  };
}

// Погодные модификаторы поверх света.
export const WEATHER_TINT = {
  rain:  { mul: 0.80, tint: [70, 96, 128, 0.24], desat: 0.35 },
  storm: { mul: 0.62, tint: [50, 66, 100, 0.34], desat: 0.45 },
  snow:  { mul: 0.92, tint: [190, 212, 240, 0.20], desat: 0.30 },
  fog:   { mul: 0.86, tint: [176, 186, 198, 0.30], desat: 0.50 },
  heat:  { mul: 1.05, tint: [255, 208, 138, 0.14], desat: 0.00 },
};

// Утилита: '#rrggbb' → [r,g,b]
export function hex2rgb(h) {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
export function rgb2css(c, a) { return a === undefined ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`; }
export function mixHex(h1, h2, k) {
  const a = hex2rgb(h1), b = hex2rgb(h2);
  return rgb2css([Math.round(lerp(a[0], b[0], k)), Math.round(lerp(a[1], b[1], k)), Math.round(lerp(a[2], b[2], k))]);
}
// Осветлить/затемнить hex на k ∈ [-1,1]
export function shade(h, k) {
  const c = hex2rgb(h);
  const f = k < 0 ? 0 : 255;
  const t = Math.abs(k);
  return rgb2css([
    Math.round(lerp(c[0], f, t)), Math.round(lerp(c[1], f, t)), Math.round(lerp(c[2], f, t)),
  ]);
}

// Детерминированный «шум» по координатам — один и тот же мир выглядит одинаково.
export function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
