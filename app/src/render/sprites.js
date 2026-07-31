// render/sprites.js — процедурные спрайты построек с объёмом.
//
// Здание рисуется ОДИН раз в offscreen-канвас и дальше только копируется на
// экран. Это позволяет тратить на один спрайт сотни операций (грани, скаты,
// окна, брёвна, зубцы) — то, что было бы неприемлемо в каждом кадре.
//
// Геометрия — «ложная изометрия»: у коробки видно переднюю грань, боковую
// (темнее, справа) и верх (светлее, свет сверху-слева 45°). Этого достаточно,
// чтобы город читался объёмным, а не набором плоских прямоугольников.
import { ERA_PALETTE, shade, mixHex, hash2 } from './palette.js';

// Архетип силуэта на каждое здание: именно он делает город узнаваемым,
// иначе все 55 построек сводятся к шести одинаковым «категориям».
const ARCH = {
  campfire: 'campfire', hut: 'hut', forager: 'lean', lumber: 'shed', quarry: 'quarry',
  story_fire: 'storyfire', hunter_lodge: 'tent', pasture: 'field', farm: 'field', granary: 'silo',
  mine: 'mineshaft', smithy: 'forge', market: 'stalls', stone_house: 'house', palisade: 'wall',
  barracks: 'barracks', armory: 'forge', treasury: 'vault', port: 'dock', aqueduct: 'arches',
  temple: 'columned', clinic: 'house', amphitheater: 'amphi', academy: 'columned', castle: 'keep',
  university: 'columned', mill: 'mill', guild_hall: 'shed', bank: 'columned', stone_walls: 'wall',
  press: 'shed', observatory: 'dome', shipyard: 'shipyard', foundry: 'factory', workshop: 'shed',
  train_station: 'shed', factory: 'factory', sewers: 'sewers', stock_exchange: 'columned',
  power_plant: 'factory', lab: 'lab', apartment: 'highrise', media_tower: 'tower',
  hospital: 'house', airport: 'airport', npp: 'reactor', datacenter: 'flat', solar: 'solar',
  robo_factory: 'factory', biolab: 'dome', skyscraper: 'highrise', ai_core: 'aicore',
  fusion_reactor: 'reactor', spaceport: 'pad', spire: 'spire',
  // Склады раньше не имели своего архетипа и рисовались обычным домом:
  // три разных здания выглядели одной хижиной.
  woodshed: 'woodpile', stoneyard: 'stonepile', depot: 'warehouse',
};

export class SpriteCache {
  constructor(quality) {
    this.q = quality;
    this.map = new Map();
  }
  setQuality(q) { this.q = q; this.map.clear(); }

  // Возвращает { cv, glow, h } — спрайт, карта свечения окон и высота в долях тайла.
  building(id, def, era, sizeTiles) {
    const key = `${id}|${era}|${sizeTiles}|${this.q.detail}`;
    let s = this.map.get(key);
    if (s) return s;
    s = bake(id, def, era, sizeTiles, this.q.detail);
    this.map.set(key, s);
    return s;
  }
}

// базовое разрешение спрайта на один тайл ширины
const BASE = [56, 96, 132];

function bake(id, def, era, sizeTiles, detail) {
  const W = BASE[detail] * sizeTiles;
  const HFACT = 1.55;                 // запас вверх под крыши, башни и трубы
  const H = Math.round(W * HFACT);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  const glow = document.createElement('canvas');
  glow.width = W; glow.height = H;
  const gc = glow.getContext('2d');

  const pal = ERA_PALETTE[era];
  const arch = ARCH[id] || 'house';
  // «пол» спрайта: низ тайла. Всё, что выше, — объём здания.
  const groundY = H - W * 0.16;

  // Само здание рисуется в отдельный холст: по нему печётся тёмный контур.
  // Без контура постройка сливается с травой и крышами соседей, а с ним даже
  // мелкий спрайт читается силуэтом — это главное, что отличает нарисованный
  // арт от «квадратиков».
  const body = document.createElement('canvas');
  body.width = W; body.height = H;
  const bc = body.getContext('2d');
  // Мягкий слой: зарево огня, дым, ореолы. Обводить их нельзя — полупрозрачный
  // градиент превращается в чёрный ком, — поэтому они кладутся ПОСЛЕ обводки.
  const soft = document.createElement('canvas');
  soft.width = W; soft.height = H;
  const fc = soft.getContext('2d');
  const ctx = { c: bc, gc, soft: fc, W, H, groundY, pal, era, id, detail, seed: hash2(id.length * 7 + era, W) };

  plate({ c, W, groundY });
  (DRAW[arch] || DRAW.house)(ctx);
  strokeOutline(c, body, Math.max(1, Math.round(W / 100)));
  c.drawImage(body, 0, 0);
  c.drawImage(soft, 0, 0);

  // Чёрный силуэт для тени печётся здесь же. Считать его в кадре через
  // ctx.filter='brightness(0)' нельзя: фильтры Canvas2D чудовищно медленные
  // и срезали кадр с 60 до 40 FPS на городе.
  const sil = document.createElement('canvas');
  sil.width = W; sil.height = H;
  const sc = sil.getContext('2d');
  sc.drawImage(cv, 0, 0);
  sc.globalCompositeOperation = 'source-in';
  sc.fillStyle = '#000';
  sc.fillRect(0, 0, W, H);

  return { cv, glow, sil, hFact: HFACT };
}

// ---------------------------------------------------------------------------
// Примитивы
// ---------------------------------------------------------------------------

// Тёмная обводка силуэта: тот же приём, что у спрайтов жителей.
function strokeOutline(c, body, k) {
  const sil = document.createElement('canvas');
  sil.width = body.width; sil.height = body.height;
  const sc = sil.getContext('2d');
  sc.drawImage(body, 0, 0);
  sc.globalCompositeOperation = 'source-in';
  sc.fillStyle = 'rgba(26,20,16,0.8)';
  sc.fillRect(0, 0, sil.width, sil.height);
  for (const [dx, dy] of [[-k, 0], [k, 0], [0, -k], [0, k], [-k, -k], [k, -k], [-k, k], [k, k]]) {
    c.drawImage(sil, dx, dy);
  }
}

// Фактура стены по эпохе: брёвна → камень → кирпич → панели.
// Плоская заливка — главный признак «программистской» графики, а несколько
// линий поверх коробки уже читаются как материал.
function wallTex(c, x, y, w, h, era, col) {
  const dark = shade(col, -0.18), light = shade(col, 0.14);
  c.save();
  c.beginPath(); c.rect(x, y, w, h); c.clip();
  if (era <= 1) {
    // горизонтальные брёвна
    c.strokeStyle = dark; c.lineWidth = Math.max(1, h * 0.035);
    for (let i = 1; i < 5; i++) {
      c.beginPath(); c.moveTo(x, y + h * i / 5); c.lineTo(x + w, y + h * i / 5); c.stroke();
    }
    c.strokeStyle = light; c.lineWidth = Math.max(1, h * 0.02);
    for (let i = 1; i < 5; i++) {
      c.beginPath(); c.moveTo(x, y + h * i / 5 + h * 0.03); c.lineTo(x + w, y + h * i / 5 + h * 0.03); c.stroke();
    }
  } else if (era <= 5) {
    // каменная/кирпичная кладка вразбежку
    const rows = 5, rh = h / rows;
    c.strokeStyle = dark; c.lineWidth = Math.max(1, h * 0.018);
    for (let r = 1; r < rows; r++) {
      c.beginPath(); c.moveTo(x, y + r * rh); c.lineTo(x + w, y + r * rh); c.stroke();
    }
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * w * 0.13;
      for (let i = 0; i < 4; i++) {
        const bx = x + off + w * (0.26 * i);
        if (bx <= x || bx >= x + w) continue;
        c.beginPath(); c.moveTo(bx, y + r * rh); c.lineTo(bx, y + (r + 1) * rh); c.stroke();
      }
    }
  } else {
    // панельные швы
    c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = Math.max(1, h * 0.018);
    for (let i = 1; i < 4; i++) {
      c.beginPath(); c.moveTo(x + w * i / 4, y); c.lineTo(x + w * i / 4, y + h); c.stroke();
    }
    c.strokeStyle = 'rgba(0,0,0,0.16)';
    for (let i = 1; i < 3; i++) {
      c.beginPath(); c.moveTo(x, y + h * i / 3); c.lineTo(x + w, y + h * i / 3); c.stroke();
    }
  }
  c.restore();
}

// Утоптанная площадка под зданием — «сажает» его на землю.
function plate({ c, W, groundY }) {
  const g = c.createRadialGradient(W / 2, groundY, W * 0.1, W / 2, groundY, W * 0.55);
  g.addColorStop(0, 'rgba(84,68,48,0.42)');
  g.addColorStop(1, 'rgba(84,68,48,0)');
  c.fillStyle = g;
  c.beginPath(); c.ellipse(W / 2, groundY, W * 0.52, W * 0.2, 0, 0, 7); c.fill();
}

// Коробка в ложной изометрии: передняя грань, боковая справа (темнее), верх (светлее).
// x,y — левый-верхний угол ПЕРЕДНЕЙ грани; d — глубина «вбок-вверх».
function box(c, x, y, w, h, d, col, opt = {}) {
  const top = opt.top || shade(col, 0.22);
  const side = opt.side || shade(col, -0.3);
  // верх
  c.fillStyle = top;
  c.beginPath();
  c.moveTo(x, y); c.lineTo(x + d, y - d * 0.55); c.lineTo(x + w + d, y - d * 0.55); c.lineTo(x + w, y);
  c.closePath(); c.fill();
  // боковая
  c.fillStyle = side;
  c.beginPath();
  c.moveTo(x + w, y); c.lineTo(x + w + d, y - d * 0.55); c.lineTo(x + w + d, y + h - d * 0.55); c.lineTo(x + w, y + h);
  c.closePath(); c.fill();
  // передняя с вертикальным градиентом — низ всегда темнее, это читается как объём
  const g = c.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, shade(col, 0.10));
  g.addColorStop(1, shade(col, -0.16));
  c.fillStyle = g;
  c.fillRect(x, y, w, h);
  // светлая кромка на освещённом ребре
  c.fillStyle = 'rgba(255,248,225,0.20)';
  c.fillRect(x, y, w, Math.max(1, h * 0.045));
  c.fillRect(x, y, Math.max(1, w * 0.03), h);
}

// Двускатная крыша над коробкой шириной w.
function gable(c, x, y, w, d, rise, col) {
  const light = shade(col, 0.2), dark = shade(col, -0.22);
  // дальний скат
  c.fillStyle = dark;
  c.beginPath();
  c.moveTo(x + d, y - d * 0.55); c.lineTo(x + w + d, y - d * 0.55);
  c.lineTo(x + w / 2 + d, y - d * 0.55 - rise); c.closePath(); c.fill();
  // ближний скат
  c.fillStyle = light;
  c.beginPath();
  c.moveTo(x, y); c.lineTo(x + w, y);
  c.lineTo(x + w / 2 + d, y - d * 0.55 - rise); c.lineTo(x + w / 2, y - rise * 0.55);
  c.closePath(); c.fill();
  // черепица: ряды вдоль ската. Голая заливка крыши — самая заметная примета
  // «нарисовано кодом», и лечится она четырьмя линиями.
  c.save();
  c.beginPath();
  c.moveTo(x, y); c.lineTo(x + w, y);
  c.lineTo(x + w / 2 + d, y - d * 0.55 - rise); c.lineTo(x + w / 2, y - rise * 0.55);
  c.closePath(); c.clip();
  c.strokeStyle = shade(col, -0.28); c.lineWidth = Math.max(1, w * 0.014);
  for (let i = 1; i < 4; i++) {
    const k = i / 4;
    c.beginPath();
    c.moveTo(x + (w / 2) * k, y - rise * 0.55 * k);
    c.lineTo(x + w - (w / 2 - d) * k, y - (d * 0.55 + rise) * k);
    c.stroke();
  }
  c.restore();
  // конёк
  c.strokeStyle = shade(col, -0.35); c.lineWidth = Math.max(1, w * 0.025);
  c.beginPath(); c.moveTo(x + w / 2, y - rise * 0.55); c.lineTo(x + w / 2 + d, y - d * 0.55 - rise); c.stroke();
  // свес крыши — постройка перестаёт быть голой коробкой
  c.fillStyle = shade(col, -0.12);
  c.fillRect(x - w * 0.04, y - w * 0.012, w * 1.08, w * 0.028);
}

// Окно + запись в карту свечения (ночью подсвечивается).
function win(c, gc, x, y, w, h, pal, lit = true) {
  c.fillStyle = pal.glass;
  c.fillRect(x, y, w, h);
  c.strokeStyle = shade(pal.trim, -0.2); c.lineWidth = Math.max(1, w * 0.12);
  c.strokeRect(x, y, w, h);
  if (lit) { gc.fillStyle = pal.glow; gc.fillRect(x, y, w, h); }
}

function door(c, x, y, w, h, pal) {
  c.fillStyle = shade(pal.trim, -0.25);
  c.beginPath();
  c.moveTo(x, y + h); c.lineTo(x, y + h * 0.3);
  c.quadraticCurveTo(x + w / 2, y - h * 0.12, x + w, y + h * 0.3);
  c.lineTo(x + w, y + h); c.closePath(); c.fill();
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.fillRect(x + w * 0.18, y + h * 0.35, w * 0.64, h * 0.65);
}

function chimney(c, x, y, w, h, col) {
  box(c, x, y, w, h, w * 0.5, col);
  c.fillStyle = 'rgba(20,16,14,0.6)';
  c.fillRect(x + w * 0.12, y - w * 0.1, w * 0.76, w * 0.18);
}

// ---------------------------------------------------------------------------
// Архетипы
// ---------------------------------------------------------------------------
const DRAW = {
  // Каменный век: шатёр из шкур на жердях.
  hut(ctx) {
    const { c, W, groundY, pal, era } = ctx;
    if (era >= 3) return DRAW.house(ctx);
    const r = W * 0.36, apex = groundY - W * 0.78;
    c.fillStyle = shade(pal.wall, -0.12);
    c.beginPath();
    c.moveTo(W / 2 - r, groundY); c.lineTo(W / 2, apex); c.lineTo(W / 2 + r, groundY);
    c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,246,220,0.16)';
    c.beginPath();
    c.moveTo(W / 2 - r, groundY); c.lineTo(W / 2, apex); c.lineTo(W / 2 - r * 0.15, groundY);
    c.closePath(); c.fill();
    // жерди наружу
    c.strokeStyle = shade(pal.trim, -0.2); c.lineWidth = Math.max(1, W * 0.022);
    for (const k of [-0.5, 0, 0.5]) {
      c.beginPath();
      c.moveTo(W / 2 + k * r * 0.5, apex - W * 0.06);
      c.lineTo(W / 2 + k * r * 1.15, groundY);
      c.stroke();
    }
    // вход
    c.fillStyle = 'rgba(24,18,14,0.75)';
    c.beginPath();
    c.moveTo(W / 2 - r * 0.24, groundY);
    c.lineTo(W / 2 - r * 0.14, groundY - W * 0.3);
    c.lineTo(W / 2 + r * 0.14, groundY - W * 0.3);
    c.lineTo(W / 2 + r * 0.24, groundY); c.closePath(); c.fill();
  },

  house(ctx) {
    const { c, gc, W, groundY, pal, era, detail } = ctx;
    const w = W * 0.66, x = (W - w) / 2, d = W * 0.16;
    const floors = era >= 6 ? 2 : 1;
    const h = W * (era >= 6 ? 0.52 : 0.38);
    const y = groundY - h;
    box(c, x, y, w, h, d, pal.wall);
    if (detail >= 1) wallTex(c, x, y, w, h, era, pal.wall);
    if (era >= 8) {
      // плоская кровля со светящейся кромкой
      c.fillStyle = pal.trim;
      c.fillRect(x - w * 0.03, y - W * 0.03, w + w * 0.06 + d, W * 0.035);
    } else {
      gable(c, x, y, w, d, W * 0.22, pal.roof);
      if (detail >= 1) chimney(c, x + w * 0.7, y - W * 0.2, w * 0.13, W * 0.22, shade(pal.roof, -0.2));
    }
    const cols = era >= 6 ? 3 : 2;
    for (let f = 0; f < floors; f++) {
      for (let i = 0; i < cols; i++) {
        win(c, gc, x + w * (0.14 + i * 0.31), y + h * (0.18 + f * 0.42), w * 0.16, h * 0.22, pal);
      }
    }
    door(c, x + w * 0.42, groundY - h * 0.42, w * 0.18, h * 0.42, pal);
  },

  // Двор с навесом: собиратели, костёр историй.
  lean(ctx) {
    const { c, W, groundY, pal, detail } = ctx;
    const w = W * 0.6, x = (W - w) / 2, d = W * 0.14;
    const postH = W * 0.3, y = groundY - postH;
    for (const k of [0, 1]) {
      c.fillStyle = shade(pal.trim, -0.2);
      c.fillRect(x + k * (w - w * 0.07), y, w * 0.07, postH);
    }
    c.fillStyle = shade(pal.roof, 0.05);
    c.beginPath();
    c.moveTo(x - w * 0.08, y); c.lineTo(x + w + w * 0.08, y);
    c.lineTo(x + w + w * 0.08 + d, y - d * 0.55 - W * 0.07);
    c.lineTo(x - w * 0.08 + d, y - d * 0.55 - W * 0.07);
    c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,246,220,0.15)';
    c.fill();
    if (detail >= 1) {
      c.fillStyle = shade(pal.wall, -0.1);
      c.beginPath(); c.ellipse(W * 0.42, groundY - W * 0.05, W * 0.1, W * 0.05, 0, 0, 7); c.fill();
      c.beginPath(); c.ellipse(W * 0.6, groundY - W * 0.03, W * 0.08, W * 0.04, 0, 0, 7); c.fill();
    }
  },

  tent(ctx) {
    const { c, W, groundY, pal } = ctx;
    for (const [ox, sc] of [[-0.18, 0.8], [0.16, 1]]) {
      const r = W * 0.26 * sc, cx = W / 2 + W * ox, apex = groundY - W * 0.55 * sc;
      c.fillStyle = shade(pal.wall, ox < 0 ? -0.18 : -0.05);
      c.beginPath();
      c.moveTo(cx - r, groundY); c.lineTo(cx, apex); c.lineTo(cx + r, groundY);
      c.closePath(); c.fill();
      c.fillStyle = 'rgba(255,246,220,0.14)';
      c.beginPath();
      c.moveTo(cx - r, groundY); c.lineTo(cx, apex); c.lineTo(cx - r * 0.2, groundY);
      c.closePath(); c.fill();
    }
    // копья у входа
    c.strokeStyle = shade(pal.trim, -0.3); c.lineWidth = Math.max(1, W * 0.018);
    for (const k of [-0.06, 0.02]) {
      c.beginPath();
      c.moveTo(W * (0.3 + k), groundY); c.lineTo(W * (0.28 + k), groundY - W * 0.34); c.stroke();
    }
  },

  shed(ctx) {
    const { c, gc, W, groundY, pal, era, detail } = ctx;
    const w = W * 0.74, x = (W - w) / 2, d = W * 0.15, h = W * 0.34, y = groundY - h;
    box(c, x, y, w, h, d, pal.wall);
    if (detail >= 1) wallTex(c, x, y, w, h, era, pal.wall);
    // односкатная крыша
    c.fillStyle = shade(pal.roof, 0.12);
    c.beginPath();
    c.moveTo(x - w * 0.04, y); c.lineTo(x + w + w * 0.04, y - W * 0.05);
    c.lineTo(x + w + w * 0.04 + d, y - W * 0.05 - d * 0.55);
    c.lineTo(x - w * 0.04 + d, y - d * 0.55);
    c.closePath(); c.fill();
    door(c, x + w * 0.38, groundY - h * 0.55, w * 0.2, h * 0.55, pal);
    win(c, gc, x + w * 0.1, y + h * 0.22, w * 0.15, h * 0.24, pal);
    if (detail >= 1) {
      // штабель брёвен
      c.fillStyle = shade(pal.trim, -0.1);
      for (let i = 0; i < 3; i++) c.fillRect(x + w * 0.7, groundY - W * (0.06 + i * 0.045), w * 0.24, W * 0.038);
    }
  },

  forge(ctx) {
    const { c, gc, W, groundY, pal, detail } = ctx;
    const w = W * 0.7, x = (W - w) / 2, d = W * 0.15, h = W * 0.36, y = groundY - h;
    box(c, x, y, w, h, d, pal.wall);
    gable(c, x, y, w, d, W * 0.15, pal.roof);
    chimney(c, x + w * 0.72, y - W * 0.3, w * 0.16, W * 0.34, shade(pal.roof, -0.25));
    // горн: светится и днём
    c.fillStyle = '#2a1a12';
    c.fillRect(x + w * 0.16, groundY - h * 0.5, w * 0.3, h * 0.5);
    const g = ctx.soft.createRadialGradient(x + w * 0.31, groundY - h * 0.24, 0, x + w * 0.31, groundY - h * 0.24, w * 0.2);
    g.addColorStop(0, 'rgba(255,190,90,0.95)');
    g.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.soft.fillStyle = g;
    ctx.soft.fillRect(x + w * 0.1, groundY - h * 0.6, w * 0.45, h * 0.6);
    gc.fillStyle = '#ff9b3c';
    gc.fillRect(x + w * 0.18, groundY - h * 0.45, w * 0.26, h * 0.42);
    if (detail >= 1) {
      c.fillStyle = shade(pal.trim, -0.3);
      c.fillRect(x + w * 0.55, groundY - h * 0.3, w * 0.12, h * 0.3); // наковальня
    }
  },

  stalls(ctx) {
    const { c, W, groundY, pal, detail } = ctx;
    const w = W * 0.76, x = (W - w) / 2, d = W * 0.13, h = W * 0.3, y = groundY - h;
    box(c, x, y, w, h, d, pal.wall);
    // полосатый навес
    const ay = y - W * 0.04;
    const stripes = 5, sw = w / stripes;
    for (let i = 0; i < stripes; i++) {
      c.fillStyle = i % 2 ? '#d8d2c0' : '#c05a3a';
      c.beginPath();
      c.moveTo(x + i * sw, ay); c.lineTo(x + (i + 1) * sw, ay);
      c.lineTo(x + (i + 1) * sw + d * 0.7, ay - W * 0.1);
      c.lineTo(x + i * sw + d * 0.7, ay - W * 0.1);
      c.closePath(); c.fill();
    }
    if (detail >= 1) {
      // товар на прилавке
      for (let i = 0; i < 4; i++) {
        c.fillStyle = ['#c9803c', '#8a5a2a', '#b83c3c', '#d0a83c'][i];
        c.beginPath(); c.arc(x + w * (0.16 + i * 0.2), groundY - h * 0.18, w * 0.045, 0, 7); c.fill();
      }
    }
  },

  silo(ctx) {
    const { c, W, groundY, pal } = ctx;
    const r = W * 0.24, cx = W / 2, h = W * 0.5, y = groundY - h;
    // цилиндр: боковой градиент даёт круглость
    const g = c.createLinearGradient(cx - r, 0, cx + r, 0);
    g.addColorStop(0, shade(pal.wall, -0.24));
    g.addColorStop(0.32, shade(pal.wall, 0.16));
    g.addColorStop(1, shade(pal.wall, -0.3));
    c.fillStyle = g;
    c.fillRect(cx - r, y, r * 2, h);
    c.fillStyle = shade(pal.wall, 0.22);
    c.beginPath(); c.ellipse(cx, y, r, r * 0.32, 0, 0, 7); c.fill();
    // коническая крыша
    c.fillStyle = shade(pal.roof, 0.08);
    c.beginPath();
    c.moveTo(cx - r * 1.08, y); c.lineTo(cx, y - W * 0.22); c.lineTo(cx + r * 1.08, y);
    c.closePath(); c.fill();
    // обручи
    c.strokeStyle = 'rgba(0,0,0,0.22)'; c.lineWidth = Math.max(1, W * 0.014);
    for (const k of [0.3, 0.62]) {
      c.beginPath(); c.ellipse(cx, y + h * k, r, r * 0.28, 0, 0, 7); c.stroke();
    }
  },

  quarry(ctx) {
    const { c, W, groundY, pal, detail } = ctx;
    // яма
    c.fillStyle = 'rgba(40,34,28,0.55)';
    c.beginPath(); c.ellipse(W / 2, groundY - W * 0.06, W * 0.36, W * 0.16, 0, 0, 7); c.fill();
    // блоки камня
    for (let i = 0; i < 4; i++) {
      const bx = W * (0.22 + (i % 2) * 0.34), by = groundY - W * (0.1 + Math.floor(i / 2) * 0.13);
      box(c, bx, by, W * 0.17, W * 0.11, W * 0.07, '#9a9690');
    }
    if (detail >= 1) {
      c.strokeStyle = shade(pal.trim, -0.2); c.lineWidth = Math.max(1, W * 0.02);
      c.beginPath(); c.moveTo(W * 0.66, groundY - W * 0.04); c.lineTo(W * 0.74, groundY - W * 0.3); c.stroke();
    }
  },

  mineshaft(ctx) {
    const { c, W, groundY, pal, detail } = ctx;
    // склон породы
    c.fillStyle = '#6d6560';
    c.beginPath();
    c.moveTo(W * 0.12, groundY); c.lineTo(W * 0.3, groundY - W * 0.52);
    c.lineTo(W * 0.78, groundY - W * 0.46); c.lineTo(W * 0.92, groundY);
    c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,248,225,0.16)';
    c.beginPath();
    c.moveTo(W * 0.12, groundY); c.lineTo(W * 0.3, groundY - W * 0.52); c.lineTo(W * 0.42, groundY);
    c.closePath(); c.fill();
    // крепь входа
    const ex = W * 0.4, ew = W * 0.24, eh = W * 0.3;
    c.fillStyle = '#171310';
    c.fillRect(ex, groundY - eh, ew, eh);
    c.fillStyle = shade(pal.trim, -0.15);
    c.fillRect(ex - W * 0.03, groundY - eh, W * 0.04, eh);
    c.fillRect(ex + ew - W * 0.01, groundY - eh, W * 0.04, eh);
    c.fillRect(ex - W * 0.05, groundY - eh - W * 0.04, ew + W * 0.1, W * 0.045);
    if (detail >= 1) {
      // вагонетка
      box(c, W * 0.14, groundY - W * 0.14, W * 0.18, W * 0.1, W * 0.06, '#8a6a4a');
      c.fillStyle = '#5a5a60';
      c.beginPath(); c.arc(W * 0.19, groundY - W * 0.02, W * 0.025, 0, 7); c.fill();
      c.beginPath(); c.arc(W * 0.28, groundY - W * 0.02, W * 0.025, 0, 7); c.fill();
    }
  },

  field(ctx) {
    const { c, W, groundY, id, detail } = ctx;
    const w = W * 0.86, x = (W - w) / 2, top = groundY - W * 0.26;
    // делянка в перспективе
    c.fillStyle = id === 'pasture' ? '#6f9a52' : '#9a7f3c';
    c.beginPath();
    c.moveTo(x, groundY); c.lineTo(x + w, groundY);
    c.lineTo(x + w - W * 0.1, top); c.lineTo(x + W * 0.1, top);
    c.closePath(); c.fill();
    if (id === 'pasture') {
      c.strokeStyle = '#7a5f3d'; c.lineWidth = Math.max(1, W * 0.016);
      c.strokeRect(x + W * 0.04, top + W * 0.02, w - W * 0.08, groundY - top - W * 0.03);
      if (detail >= 1) {
        c.fillStyle = '#efe8dc';
        c.beginPath(); c.ellipse(W * 0.42, groundY - W * 0.1, W * 0.06, W * 0.042, 0, 0, 7); c.fill();
        c.beginPath(); c.ellipse(W * 0.6, groundY - W * 0.05, W * 0.05, W * 0.036, 0, 0, 7); c.fill();
      }
    } else {
      c.strokeStyle = 'rgba(70,48,22,0.5)'; c.lineWidth = Math.max(1, W * 0.014);
      for (let i = 1; i < 5; i++) {
        const t = i / 5;
        c.beginPath();
        c.moveTo(x + W * 0.1 * t, groundY - (groundY - top) * t);
        c.lineTo(x + w - W * 0.1 * t, groundY - (groundY - top) * t);
        c.stroke();
      }
      if (detail >= 1) {
        c.fillStyle = '#d8c05a';
        for (let i = 0; i < 6; i++) {
          const px = x + W * 0.12 + (w - W * 0.24) * (i / 5);
          c.fillRect(px, groundY - W * 0.12, W * 0.02, W * 0.08);
        }
      }
    }
  },

  wall(ctx) {
    const { c, W, groundY, id, pal } = ctx;
    const stone = id === 'stone_walls';
    const w = W * 0.94, x = (W - w) / 2, h = W * 0.3, y = groundY - h, d = W * 0.12;
    box(c, x, y, w, h, d, stone ? '#8e8a84' : '#8a6a44');
    if (stone) {
      // зубцы
      for (let i = 0; i < 4; i++) {
        box(c, x + w * (0.04 + i * 0.25), y - W * 0.1, w * 0.14, W * 0.11, d * 0.6, '#9a968f');
      }
      c.strokeStyle = 'rgba(0,0,0,0.2)'; c.lineWidth = Math.max(1, W * 0.01);
      for (let i = 1; i < 3; i++) { c.beginPath(); c.moveTo(x, y + h * i / 3); c.lineTo(x + w, y + h * i / 3); c.stroke(); }
    } else {
      // заострённые колья
      for (let i = 0; i < 7; i++) {
        const px = x + w * (0.03 + i * 0.14);
        c.fillStyle = shade('#8a6a44', i % 2 ? 0.1 : -0.08);
        c.beginPath();
        c.moveTo(px, y + h * 0.1); c.lineTo(px + w * 0.055, y - W * 0.06);
        c.lineTo(px + w * 0.11, y + h * 0.1); c.closePath(); c.fill();
      }
    }
  },

  barracks(ctx) {
    const { c, gc, W, groundY, pal, era, detail } = ctx;
    const w = W * 0.8, x = (W - w) / 2, d = W * 0.16, h = W * 0.36, y = groundY - h;
    box(c, x, y, w, h, d, pal.wall);
    if (detail >= 1) wallTex(c, x, y, w, h, era, pal.wall);
    gable(c, x, y, w, d, W * 0.2, pal.roof);
    door(c, x + w * 0.42, groundY - h * 0.5, w * 0.17, h * 0.5, pal);
    win(c, gc, x + w * 0.12, y + h * 0.24, w * 0.13, h * 0.22, pal);
    win(c, gc, x + w * 0.72, y + h * 0.24, w * 0.13, h * 0.22, pal);
    if (detail >= 1) {
      // копья и щит у стены
      c.strokeStyle = shade(pal.trim, -0.3); c.lineWidth = Math.max(1, W * 0.018);
      for (let i = 0; i < 4; i++) {
        c.beginPath();
        c.moveTo(x + w * (0.06 + i * 0.05), groundY);
        c.lineTo(x + w * (0.09 + i * 0.05), groundY - h * 0.85); c.stroke();
      }
      c.fillStyle = '#8e3a30';
      c.beginPath(); c.arc(x + w * 0.9, groundY - h * 0.25, w * 0.07, 0, 7); c.fill();
      c.fillStyle = 'rgba(230,220,190,0.8)';
      c.beginPath(); c.arc(x + w * 0.9, groundY - h * 0.25, w * 0.025, 0, 7); c.fill();
    }
  },

  vault(ctx) {
    const { c, W, groundY, pal, detail } = ctx;
    const w = W * 0.6, x = (W - w) / 2, d = W * 0.15, h = W * 0.36, y = groundY - h;
    box(c, x, y, w, h, d, shade(pal.wall, -0.1));
    c.fillStyle = shade(pal.roof, -0.1);
    c.fillRect(x - w * 0.05, y - W * 0.05, w + w * 0.1 + d * 0.6, W * 0.06);
    // окованная дверь
    c.fillStyle = '#3a2f24';
    c.fillRect(x + w * 0.32, groundY - h * 0.62, w * 0.36, h * 0.62);
    c.strokeStyle = pal.accent; c.lineWidth = Math.max(1, W * 0.018);
    c.strokeRect(x + w * 0.32, groundY - h * 0.62, w * 0.36, h * 0.62);
    if (detail >= 1) {
      c.fillStyle = pal.accent;
      c.beginPath(); c.arc(x + w * 0.5, groundY - h * 0.3, w * 0.05, 0, 7); c.fill();
    }
  },

  dock(ctx) {
    const { c, W, groundY, pal, detail } = ctx;
    // настил
    c.fillStyle = shade(pal.trim, -0.05);
    c.beginPath();
    c.moveTo(W * 0.08, groundY); c.lineTo(W * 0.92, groundY);
    c.lineTo(W * 0.82, groundY - W * 0.14); c.lineTo(W * 0.18, groundY - W * 0.14);
    c.closePath(); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.22)'; c.lineWidth = Math.max(1, W * 0.012);
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      c.beginPath();
      c.moveTo(W * (0.08 + 0.1 * t) + W * 0.84 * t * 0, groundY - W * 0.14 * t);
      c.lineTo(W * (0.92 - 0.1 * t), groundY - W * 0.14 * t); c.stroke();
    }
    // сарай
    const w = W * 0.34, x = W * 0.14, h = W * 0.26, y = groundY - W * 0.14 - h;
    box(c, x, y, w, h, W * 0.1, pal.wall);
    gable(c, x, y, w, W * 0.1, W * 0.12, pal.roof);
    if (detail >= 1) {
      // мачта с парусом
      c.strokeStyle = shade(pal.trim, -0.3); c.lineWidth = Math.max(1, W * 0.022);
      c.beginPath(); c.moveTo(W * 0.68, groundY - W * 0.12); c.lineTo(W * 0.68, groundY - W * 0.62); c.stroke();
      c.fillStyle = 'rgba(240,235,220,0.92)';
      c.beginPath();
      c.moveTo(W * 0.68, groundY - W * 0.58); c.lineTo(W * 0.86, groundY - W * 0.38);
      c.lineTo(W * 0.68, groundY - W * 0.2); c.closePath(); c.fill();
    }
  },

  arches(ctx) {
    const { c, W, groundY, pal } = ctx;
    const w = W * 0.94, x = (W - w) / 2, h = W * 0.42, y = groundY - h;
    c.fillStyle = shade(pal.wall, -0.05);
    c.fillRect(x, y, w, h);
    // проёмы-арки прорезаем фоном
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 3; i++) {
      const ax = x + w * (0.08 + i * 0.3), aw = w * 0.22;
      c.beginPath();
      c.moveTo(ax, groundY); c.lineTo(ax, y + h * 0.42);
      c.quadraticCurveTo(ax + aw / 2, y + h * 0.02, ax + aw, y + h * 0.42);
      c.lineTo(ax + aw, groundY); c.closePath(); c.fill();
    }
    c.globalCompositeOperation = 'source-over';
    // жёлоб с водой сверху
    c.fillStyle = shade(pal.wall, 0.18);
    c.fillRect(x, y - W * 0.05, w, W * 0.055);
    c.fillStyle = 'rgba(90,170,220,0.75)';
    c.fillRect(x + w * 0.04, y - W * 0.035, w * 0.92, W * 0.022);
  },

  columned(ctx) {
    const { c, gc, W, groundY, pal, detail } = ctx;
    const w = W * 0.8, x = (W - w) / 2, d = W * 0.15, h = W * 0.4, y = groundY - h;
    // стилобат
    box(c, x - w * 0.04, groundY - W * 0.07, w + w * 0.08, W * 0.075, d, shade(pal.wall, -0.14));
    box(c, x, y, w, h - W * 0.07, d, pal.wall);
    // колонны
    const n = 5;
    for (let i = 0; i < n; i++) {
      const cx = x + w * (0.08 + i * 0.21), cw = w * 0.085;
      const g = c.createLinearGradient(cx, 0, cx + cw, 0);
      g.addColorStop(0, shade(pal.wall, -0.2));
      g.addColorStop(0.35, shade(pal.wall, 0.25));
      g.addColorStop(1, shade(pal.wall, -0.24));
      c.fillStyle = g;
      c.fillRect(cx, y + h * 0.1, cw, h * 0.78);
      c.fillStyle = shade(pal.wall, 0.3);
      c.fillRect(cx - cw * 0.14, y + h * 0.06, cw * 1.28, h * 0.06);
    }
    // фронтон
    c.fillStyle = shade(pal.roof, 0.05);
    c.beginPath();
    c.moveTo(x - w * 0.06, y); c.lineTo(x + w / 2, y - W * 0.2); c.lineTo(x + w + w * 0.06, y);
    c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,248,225,0.18)';
    c.beginPath();
    c.moveTo(x - w * 0.06, y); c.lineTo(x + w / 2, y - W * 0.2); c.lineTo(x + w / 2, y);
    c.closePath(); c.fill();
    if (detail >= 1) { gc.fillStyle = pal.glow; gc.fillRect(x + w * 0.44, y + h * 0.4, w * 0.12, h * 0.3); }
  },

  amphi(ctx) {
    const { c, W, groundY, pal } = ctx;
    const cx = W / 2, cy = groundY - W * 0.04;
    for (let i = 3; i >= 0; i--) {
      const r = W * (0.2 + i * 0.09);
      c.fillStyle = shade(pal.wall, i % 2 ? 0.06 : -0.08);
      c.beginPath(); c.ellipse(cx, cy - i * W * 0.045, r, r * 0.44, 0, 0, 7); c.fill();
    }
    c.fillStyle = 'rgba(40,34,26,0.5)';
    c.beginPath(); c.ellipse(cx, cy - W * 0.02, W * 0.14, W * 0.07, 0, 0, 7); c.fill();
  },

  keep(ctx) {
    const { c, gc, W, groundY, pal, detail } = ctx;
    const w = W * 0.56, x = (W - w) / 2, d = W * 0.16, h = W * 0.46, y = groundY - h;
    box(c, x, y, w, h, d, pal.wall);
    // угловые башни
    for (const k of [-0.14, 0.86]) {
      const tx = x + w * k, tw = w * 0.28, th = h * 1.34, ty = groundY - th;
      box(c, tx, ty, tw, th, d * 0.7, shade(pal.wall, -0.05));
      c.fillStyle = shade(pal.roof, 0.05);
      c.beginPath();
      c.moveTo(tx - tw * 0.12, ty); c.lineTo(tx + tw / 2, ty - W * 0.18); c.lineTo(tx + tw * 1.12, ty);
      c.closePath(); c.fill();
      win(c, gc, tx + tw * 0.34, ty + th * 0.2, tw * 0.3, th * 0.16, pal);
    }
    // зубцы на центральной части
    for (let i = 0; i < 3; i++) box(c, x + w * (0.06 + i * 0.32), y - W * 0.08, w * 0.2, W * 0.09, d * 0.5, shade(pal.wall, 0.08));
    door(c, x + w * 0.36, groundY - h * 0.44, w * 0.28, h * 0.44, pal);
    if (detail >= 1) {
      c.strokeStyle = '#3a3128'; c.lineWidth = Math.max(1, W * 0.014);
      c.beginPath(); c.moveTo(W / 2, y - W * 0.08); c.lineTo(W / 2, y - W * 0.34); c.stroke();
      c.fillStyle = '#a83c34';
      c.beginPath();
      c.moveTo(W / 2, y - W * 0.34); c.lineTo(W / 2 + W * 0.16, y - W * 0.28); c.lineTo(W / 2, y - W * 0.22);
      c.closePath(); c.fill();
    }
  },

  mill(ctx) {
    const { c, W, groundY, pal, detail } = ctx;
    const w = W * 0.5, x = W * 0.12, d = W * 0.13, h = W * 0.42, y = groundY - h;
    box(c, x, y, w, h, d, pal.wall);
    gable(c, x, y, w, d, W * 0.16, pal.roof);
    // водяное колесо
    const cx = W * 0.76, cy = groundY - W * 0.2, r = W * 0.2;
    c.strokeStyle = shade(pal.trim, -0.15); c.lineWidth = Math.max(1, W * 0.028);
    c.beginPath(); c.arc(cx, cy, r, 0, 7); c.stroke();
    c.lineWidth = Math.max(1, W * 0.018);
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * r * 0.25, cy + Math.sin(a) * r * 0.25);
      c.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); c.stroke();
    }
    if (detail >= 1) {
      c.fillStyle = 'rgba(110,180,220,0.6)';
      c.fillRect(cx - r, groundY - W * 0.06, r * 2, W * 0.06);
    }
  },

  dome(ctx) {
    const { c, gc, W, groundY, pal, era, detail } = ctx;
    const w = W * 0.68, x = (W - w) / 2, d = W * 0.15, h = W * 0.34, y = groundY - h;
    box(c, x, y, w, h, d, pal.wall);
    // купол
    const cx = W / 2, cy = y;
    const g = c.createRadialGradient(cx - w * 0.14, cy - w * 0.14, w * 0.03, cx, cy, w * 0.42);
    g.addColorStop(0, shade(pal.roof, 0.42));
    g.addColorStop(1, shade(pal.roof, -0.2));
    c.fillStyle = g;
    c.beginPath(); c.arc(cx, cy, w * 0.4, Math.PI, 0); c.fill();
    c.fillStyle = shade(pal.roof, -0.3);
    c.fillRect(cx - w * 0.42, cy - W * 0.012, w * 0.84, W * 0.026);
    if (era >= 8) {
      // светящиеся дорожки по куполу
      c.strokeStyle = pal.trim; c.lineWidth = Math.max(1, W * 0.014);
      for (const k of [0.55, 0.78]) { c.beginPath(); c.arc(cx, cy, w * 0.4 * k, Math.PI, 0); c.stroke(); }
      gc.strokeStyle = pal.glow; gc.lineWidth = Math.max(1, W * 0.02);
      for (const k of [0.55, 0.78]) { gc.beginPath(); gc.arc(cx, cy, w * 0.4 * k, Math.PI, 0); gc.stroke(); }
    } else if (detail >= 1) {
      // телескоп в прорези
      c.strokeStyle = shade(pal.trim, -0.1); c.lineWidth = Math.max(1, W * 0.03);
      c.beginPath(); c.moveTo(cx, cy - w * 0.12); c.lineTo(cx + w * 0.3, cy - w * 0.36); c.stroke();
    }
    win(c, gc, x + w * 0.16, y + h * 0.3, w * 0.16, h * 0.3, pal);
    win(c, gc, x + w * 0.66, y + h * 0.3, w * 0.16, h * 0.3, pal);
  },

  factory(ctx) {
    const { c, gc, W, groundY, pal, detail } = ctx;
    const w = W * 0.84, x = (W - w) / 2, d = W * 0.15, h = W * 0.4, y = groundY - h;
    box(c, x, y, w, h, d, pal.wall);
    // пилообразная кровля
    const teeth = 4, tw = w / teeth;
    for (let i = 0; i < teeth; i++) {
      c.fillStyle = shade(pal.roof, i % 2 ? 0.06 : -0.06);
      c.beginPath();
      c.moveTo(x + i * tw, y); c.lineTo(x + i * tw, y - W * 0.08);
      c.lineTo(x + (i + 1) * tw, y); c.closePath(); c.fill();
    }
    chimney(c, x + w * 0.06, y - W * 0.4, w * 0.11, W * 0.45, shade(pal.roof, -0.25));
    chimney(c, x + w * 0.22, y - W * 0.3, w * 0.09, W * 0.35, shade(pal.roof, -0.3));
    for (let i = 0; i < 4; i++) win(c, gc, x + w * (0.34 + i * 0.15), y + h * 0.3, w * 0.1, h * 0.3, pal);
    if (detail >= 1) {
      c.fillStyle = shade(pal.trim, -0.2);
      c.fillRect(x + w * 0.36, groundY - h * 0.28, w * 0.3, h * 0.28);
    }
  },

  highrise(ctx) {
    const { c, gc, W, groundY, pal, id, era, detail } = ctx;
    const tall = id === 'skyscraper';
    const w = W * (tall ? 0.44 : 0.56), x = (W - w) / 2, d = W * 0.14;
    const h = W * (tall ? 1.0 : 0.66), y = groundY - h;
    box(c, x, y, w, h, d, pal.wall);
    if (detail >= 1 && era < 7) wallTex(c, x, y, w, h, era, pal.wall);
    // Межэтажные пояса: без них башня — просто таблица окон.
    c.fillStyle = shade(pal.wall, -0.14);
    const rows = tall ? 9 : 6, cols = 3;
    for (let r = 0; r < rows; r++) {
      c.fillRect(x, y + h * (0.02 + r * (0.9 / rows)), w, h * 0.012);
    }
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < cols; i++) {
        // часть окон тёмная — дом выглядит жилым, а не таблицей
        const k = hash2(r * 13 + i, id.length);
        const lit = k > 0.35;
        const wx = x + w * (0.12 + i * 0.28), wy = y + h * (0.06 + r * (0.9 / rows));
        const ww = w * 0.18, wh = h * (0.55 / rows);
        win(c, gc, wx, wy, ww, wh, pal, lit);
        // разнотон стекла: одинаковые квадраты выдают процедурность мгновенно
        c.fillStyle = `rgba(${lit ? '255,236,190' : '20,26,36'},${0.10 + k * 0.22})`;
        c.fillRect(wx, wy, ww, wh);
        if (detail >= 2 && k > 0.8) {
          // редкие занавески/жалюзи
          c.fillStyle = 'rgba(230,226,210,0.5)';
          c.fillRect(wx, wy, ww, wh * 0.34);
        }
      }
    }
    c.fillStyle = shade(pal.roof, -0.1);
    c.fillRect(x - w * 0.04, y - W * 0.03, w + w * 0.08 + d * 0.7, W * 0.035);
    if (tall) {
      // технический этаж и мачта
      box(c, x + w * 0.24, y - W * 0.12, w * 0.5, W * 0.1, d * 0.5, shade(pal.wall, -0.08));
      c.strokeStyle = pal.trim; c.lineWidth = Math.max(1, W * 0.012);
      c.beginPath(); c.moveTo(x + w / 2, y - W * 0.12); c.lineTo(x + w / 2, y - W * 0.26); c.stroke();
      c.fillStyle = '#ff5a4a';
      c.beginPath(); c.arc(x + w / 2, y - W * 0.27, W * 0.02, 0, 7); c.fill();
      gc.fillStyle = '#ff5a4a';
      gc.beginPath(); gc.arc(x + w / 2, y - W * 0.27, W * 0.04, 0, 7); gc.fill();
    }
  },

  tower(ctx) {
    const { c, gc, W, groundY, pal } = ctx;
    const w = W * 0.3, x = (W - w) / 2, d = W * 0.1, h = W * 0.9, y = groundY - h;
    box(c, x, y, w, h, d, pal.wall);
    for (let r = 0; r < 6; r++) win(c, gc, x + w * 0.24, y + h * (0.1 + r * 0.13), w * 0.5, h * 0.07, pal);
    // мачта и красный огонь
    c.strokeStyle = shade(pal.trim, -0.1); c.lineWidth = Math.max(1, W * 0.02);
    c.beginPath(); c.moveTo(x + w / 2, y); c.lineTo(x + w / 2, y - W * 0.26); c.stroke();
    c.fillStyle = '#ff5a4a';
    c.beginPath(); c.arc(x + w / 2, y - W * 0.27, W * 0.028, 0, 7); c.fill();
    gc.fillStyle = '#ff5a4a';
    gc.beginPath(); gc.arc(x + w / 2, y - W * 0.27, W * 0.05, 0, 7); gc.fill();
  },

  reactor(ctx) {
    const { c, gc, W, groundY, pal, id } = ctx;
    // градирни
    for (const k of [0.22, 0.58]) {
      const cx = W * (k + 0.1), base = W * 0.2, top = W * 0.13, h = W * 0.54;
      const g = c.createLinearGradient(cx - base / 2, 0, cx + base / 2, 0);
      g.addColorStop(0, shade(pal.wall, -0.24));
      g.addColorStop(0.35, shade(pal.wall, 0.18));
      g.addColorStop(1, shade(pal.wall, -0.28));
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(cx - base / 2, groundY); c.lineTo(cx - top / 2, groundY - h);
      c.lineTo(cx + top / 2, groundY - h); c.lineTo(cx + base / 2, groundY);
      c.closePath(); c.fill();
      c.fillStyle = 'rgba(20,24,30,0.5)';
      c.beginPath(); c.ellipse(cx, groundY - h, top / 2, top * 0.16, 0, 0, 7); c.fill();
    }
    // корпус
    box(c, W * 0.1, groundY - W * 0.2, W * 0.8, W * 0.2, W * 0.1, shade(pal.wall, -0.1));
    if (id === 'fusion_reactor') {
      const cx = W / 2, cy = groundY - W * 0.42;
      c.strokeStyle = pal.trim; c.lineWidth = Math.max(2, W * 0.03);
      c.beginPath(); c.ellipse(cx, cy, W * 0.2, W * 0.09, 0, 0, 7); c.stroke();
      gc.strokeStyle = pal.glow; gc.lineWidth = Math.max(2, W * 0.05);
      gc.beginPath(); gc.ellipse(cx, cy, W * 0.2, W * 0.09, 0, 0, 7); gc.stroke();
    }
  },

  solar(ctx) {
    const { c, W, groundY, pal } = ctx;
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 3; i++) {
        const px = W * (0.1 + i * 0.29), py = groundY - W * (0.1 + r * 0.15);
        c.fillStyle = '#1e2c44';
        c.beginPath();
        c.moveTo(px, py); c.lineTo(px + W * 0.24, py);
        c.lineTo(px + W * 0.2, py - W * 0.1); c.lineTo(px - W * 0.04, py - W * 0.1);
        c.closePath(); c.fill();
        c.fillStyle = 'rgba(130,190,240,0.35)';
        c.beginPath();
        c.moveTo(px, py); c.lineTo(px + W * 0.1, py); c.lineTo(px + W * 0.06, py - W * 0.1);
        c.lineTo(px - W * 0.04, py - W * 0.1); c.closePath(); c.fill();
      }
    }
    box(c, W * 0.72, groundY - W * 0.2, W * 0.2, W * 0.2, W * 0.08, pal.wall);
  },

  pad(ctx) {
    const { c, gc, W, groundY, pal } = ctx;
    // площадка
    c.fillStyle = shade(pal.wall, -0.15);
    c.beginPath(); c.ellipse(W / 2, groundY - W * 0.03, W * 0.42, W * 0.16, 0, 0, 7); c.fill();
    c.strokeStyle = pal.accent; c.lineWidth = Math.max(1, W * 0.016);
    c.beginPath(); c.ellipse(W / 2, groundY - W * 0.03, W * 0.3, W * 0.11, 0, 0, 7); c.stroke();
    // ракета
    const cx = W / 2, rw = W * 0.15, rh = W * 0.72, ry = groundY - W * 0.08 - rh;
    const g = c.createLinearGradient(cx - rw / 2, 0, cx + rw / 2, 0);
    g.addColorStop(0, '#b8c2cc'); g.addColorStop(0.35, '#f2f6fa'); g.addColorStop(1, '#98a2ac');
    c.fillStyle = g;
    c.fillRect(cx - rw / 2, ry, rw, rh);
    c.fillStyle = '#e8eef4';
    c.beginPath();
    c.moveTo(cx - rw / 2, ry); c.lineTo(cx, ry - W * 0.18); c.lineTo(cx + rw / 2, ry);
    c.closePath(); c.fill();
    c.fillStyle = '#c8452e';
    c.fillRect(cx - rw / 2, ry + rh * 0.42, rw, rh * 0.07);
    // ферма обслуживания
    c.strokeStyle = shade(pal.trim, -0.2); c.lineWidth = Math.max(1, W * 0.018);
    c.beginPath(); c.moveTo(cx + rw * 0.8, groundY - W * 0.08); c.lineTo(cx + rw * 0.8, ry + rh * 0.1); c.stroke();
    gc.fillStyle = pal.glow;
    gc.beginPath(); gc.ellipse(cx, groundY - W * 0.06, rw * 0.5, W * 0.03, 0, 0, 7); gc.fill();
  },

  flat(ctx) {
    const { c, gc, W, groundY, pal } = ctx;
    const w = W * 0.84, x = (W - w) / 2, d = W * 0.14, h = W * 0.26, y = groundY - h;
    box(c, x, y, w, h, d, pal.wall);
    c.fillStyle = shade(pal.roof, 0);
    c.fillRect(x - w * 0.03, y - W * 0.025, w + w * 0.06 + d * 0.7, W * 0.03);
    for (let i = 0; i < 5; i++) win(c, gc, x + w * (0.07 + i * 0.19), y + h * 0.3, w * 0.12, h * 0.34, pal);
  },

  campfire(ctx) {
    const { c, gc, soft, W, groundY } = ctx;
    // кольцо камней
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      c.fillStyle = i % 2 ? '#8a857e' : '#6e6961';
      c.beginPath();
      c.ellipse(W / 2 + Math.cos(a) * W * 0.2, groundY - W * 0.03 + Math.sin(a) * W * 0.09, W * 0.055, W * 0.04, 0, 0, 7);
      c.fill();
    }
    // поленья
    c.strokeStyle = '#5a4433'; c.lineWidth = Math.max(2, W * 0.035);
    for (const a of [0.4, 1.6, 2.6]) {
      c.beginPath();
      c.moveTo(W / 2 - Math.cos(a) * W * 0.13, groundY - W * 0.05 - Math.sin(a) * W * 0.03);
      c.lineTo(W / 2 + Math.cos(a) * W * 0.13, groundY - W * 0.05 + Math.sin(a) * W * 0.03);
      c.stroke();
    }
    // пламя (статичная база; мерцание добавляет рендер поверх).
    // Идёт в мягкий слой: обводка вокруг зарева делала из костра чёрный ком.
    const fx = W / 2, fy = groundY - W * 0.14;
    const fg = soft.createRadialGradient(fx, fy, 0, fx, fy, W * 0.26);
    fg.addColorStop(0, 'rgba(255,246,190,0.95)');
    fg.addColorStop(0.3, 'rgba(250,170,60,0.75)');
    fg.addColorStop(0.7, 'rgba(226,96,28,0.32)');
    fg.addColorStop(1, 'rgba(200,60,20,0)');
    soft.fillStyle = fg;
    soft.beginPath(); soft.ellipse(fx, fy, W * 0.22, W * 0.26, 0, 0, 7); soft.fill();
    // язык пламени поверх зарева — у огня должен быть силуэт
    soft.fillStyle = 'rgba(255,214,110,0.92)';
    soft.beginPath();
    soft.moveTo(fx - W * 0.07, groundY - W * 0.04);
    soft.quadraticCurveTo(fx - W * 0.04, fy, fx, groundY - W * 0.32);
    soft.quadraticCurveTo(fx + W * 0.05, fy, fx + W * 0.07, groundY - W * 0.04);
    soft.closePath(); soft.fill();
    soft.fillStyle = 'rgba(255,252,226,0.9)';
    soft.beginPath();
    soft.moveTo(fx - W * 0.032, groundY - W * 0.05);
    soft.quadraticCurveTo(fx, fy, fx, groundY - W * 0.21);
    soft.quadraticCurveTo(fx + W * 0.02, fy, fx + W * 0.032, groundY - W * 0.05);
    soft.closePath(); soft.fill();
    gc.fillStyle = '#ff9430';
    gc.beginPath(); gc.ellipse(fx, fy, W * 0.14, W * 0.18, 0, 0, 7); gc.fill();
  },

  // --- склады -------------------------------------------------------------
  // Дровяник: штабеля брёвен торцами наружу под односкатным навесом.
  woodpile(ctx) {
    const { c, W, groundY, pal, detail } = ctx;
    const w = W * 0.78, x = (W - w) / 2, d = W * 0.14;
    const postH = W * 0.34, y = groundY - postH;
    // штабель
    const rows = 3, cols = 4;
    const lw = w * 0.19, lh = W * 0.085;
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < cols; i++) {
        const bx = x + w * 0.05 + i * lw * 1.02 + (r % 2) * lw * 0.12;
        const by = groundY - (r + 1) * lh;
        const tone = 0.5 + hash2(r * 7 + i, i * 3 + r) * 0.5;
        // торец бревна: круг с годовыми кольцами
        c.fillStyle = shade('#8a6a44', -0.12 + tone * 0.2);
        c.beginPath(); c.ellipse(bx + lw / 2, by + lh / 2, lw * 0.48, lh * 0.46, 0, 0, 7); c.fill();
        c.strokeStyle = 'rgba(60,40,22,0.5)'; c.lineWidth = Math.max(1, W * 0.008);
        c.beginPath(); c.ellipse(bx + lw / 2, by + lh / 2, lw * 0.26, lh * 0.24, 0, 0, 7); c.stroke();
      }
    }
    // столбы и навес
    for (const k of [0, 1]) {
      c.fillStyle = shade(pal.trim, -0.25);
      c.fillRect(x + k * (w - w * 0.06), y - W * 0.02, w * 0.06, postH + W * 0.02);
    }
    c.fillStyle = shade(pal.roof, 0.06);
    c.beginPath();
    c.moveTo(x - w * 0.07, y); c.lineTo(x + w + w * 0.07, y - W * 0.05);
    c.lineTo(x + w + w * 0.07 + d, y - W * 0.05 - d * 0.55);
    c.lineTo(x - w * 0.07 + d, y - d * 0.55);
    c.closePath(); c.fill();
    if (detail >= 1) {
      c.strokeStyle = 'rgba(255,246,220,0.18)'; c.lineWidth = Math.max(1, W * 0.012);
      c.beginPath(); c.moveTo(x - w * 0.07, y); c.lineTo(x + w + w * 0.07, y - W * 0.05); c.stroke();
      // топор в колоде
      c.fillStyle = '#6b4f35';
      c.fillRect(x + w * 0.86, groundY - W * 0.1, w * 0.14, W * 0.1);
      c.strokeStyle = '#5a4433'; c.lineWidth = Math.max(1, W * 0.018);
      c.beginPath(); c.moveTo(x + w * 0.93, groundY - W * 0.1); c.lineTo(x + w * 0.99, groundY - W * 0.26); c.stroke();
      c.fillStyle = '#c3cad2';
      c.beginPath();
      c.moveTo(x + w * 0.97, groundY - W * 0.24); c.lineTo(x + w * 1.06, groundY - W * 0.3);
      c.lineTo(x + w * 1.0, groundY - W * 0.18); c.closePath(); c.fill();
    }
  },

  // Каменный склад: пирамида тёсаных блоков и подъёмная стрела.
  stonepile(ctx) {
    const { c, W, groundY, pal, detail } = ctx;
    const bw = W * 0.19, bh = W * 0.1;
    for (let r = 0; r < 3; r++) {
      const n = 3 - r;
      for (let i = 0; i < n; i++) {
        const bx = W * 0.16 + (r * bw * 0.5) + i * bw * 1.04;
        const by = groundY - (r + 1) * bh * 1.05;
        const tone = hash2(r * 11 + i, i * 5 + r);
        box(c, bx, by, bw, bh, W * 0.06, shade('#9a9690', -0.08 + tone * 0.16));
        if (detail >= 1) {
          c.strokeStyle = 'rgba(60,58,54,0.35)'; c.lineWidth = Math.max(1, W * 0.008);
          c.strokeRect(bx, by, bw, bh);
        }
      }
    }
    // деревянная стрела крана
    c.strokeStyle = shade(pal.trim, -0.2); c.lineWidth = Math.max(2, W * 0.028);
    c.beginPath(); c.moveTo(W * 0.82, groundY); c.lineTo(W * 0.8, groundY - W * 0.52); c.stroke();
    c.lineWidth = Math.max(1, W * 0.022);
    c.beginPath(); c.moveTo(W * 0.8, groundY - W * 0.52); c.lineTo(W * 0.52, groundY - W * 0.6); c.stroke();
    if (detail >= 1) {
      c.strokeStyle = 'rgba(40,34,28,0.7)'; c.lineWidth = Math.max(1, W * 0.01);
      c.beginPath(); c.moveTo(W * 0.55, groundY - W * 0.59); c.lineTo(W * 0.55, groundY - W * 0.44); c.stroke();
      box(c, W * 0.48, groundY - W * 0.44, W * 0.14, W * 0.08, W * 0.05, '#9a9690');
    }
  },

  // Депо: длинный ангар с воротами, рампой и ящиками у стены.
  warehouse(ctx) {
    const { c, gc, W, groundY, pal, era, detail } = ctx;
    const w = W * 0.88, x = (W - w) / 2, d = W * 0.15, h = W * 0.38, y = groundY - h;
    box(c, x, y, w, h, d, pal.wall);
    if (detail >= 1) wallTex(c, x, y, w, h, era, pal.wall);
    // полукруглая кровля-ангар
    c.fillStyle = shade(pal.roof, 0.08);
    c.beginPath();
    c.moveTo(x, y); c.quadraticCurveTo(x + w / 2, y - W * 0.24, x + w, y);
    c.lineTo(x + w + d, y - d * 0.55);
    c.quadraticCurveTo(x + w / 2 + d, y - W * 0.24 - d * 0.55, x + d, y - d * 0.55);
    c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,248,225,0.16)';
    c.beginPath();
    c.moveTo(x, y); c.quadraticCurveTo(x + w / 2, y - W * 0.24, x + w * 0.52, y - W * 0.19);
    c.lineTo(x + w * 0.3, y); c.closePath(); c.fill();
    // ворота
    c.fillStyle = shade(pal.trim, -0.3);
    c.fillRect(x + w * 0.34, groundY - h * 0.72, w * 0.32, h * 0.72);
    c.strokeStyle = shade(pal.trim, 0.1); c.lineWidth = Math.max(1, W * 0.012);
    for (let i = 1; i < 4; i++) {
      c.beginPath();
      c.moveTo(x + w * (0.34 + 0.08 * i), groundY - h * 0.72);
      c.lineTo(x + w * (0.34 + 0.08 * i), groundY); c.stroke();
    }
    win(c, gc, x + w * 0.08, y + h * 0.22, w * 0.14, h * 0.2, pal);
    win(c, gc, x + w * 0.78, y + h * 0.22, w * 0.14, h * 0.2, pal);
    if (detail >= 1) {
      // ящики у стены
      for (let i = 0; i < 3; i++) {
        box(c, x + w * (0.02 + i * 0.09), groundY - W * (0.09 + (i % 2) * 0.07), w * 0.085, W * 0.09, W * 0.04, '#9a7040');
      }
    }
  },

  // Костёр историй: круг из брёвен-сидений вокруг огня, шкура-навес и тотем.
  storyfire(ctx) {
    const { c, gc, W, groundY, pal, detail } = ctx;
    // сиденья по дуге
    c.fillStyle = shade(pal.trim, -0.15);
    for (let i = 0; i < 5; i++) {
      const a = Math.PI * (0.15 + i * 0.175);
      const sx = W / 2 + Math.cos(a) * W * 0.34, sy = groundY - W * 0.02 + Math.sin(a) * W * 0.14;
      c.beginPath(); c.ellipse(sx, sy, W * 0.07, W * 0.035, 0, 0, 7); c.fill();
    }
    DRAW.campfire(ctx);
    // тотем с черепом
    c.strokeStyle = shade(pal.trim, -0.3); c.lineWidth = Math.max(2, W * 0.035);
    c.beginPath(); c.moveTo(W * 0.8, groundY - W * 0.04); c.lineTo(W * 0.78, groundY - W * 0.46); c.stroke();
    c.fillStyle = '#ddd6c4';
    c.beginPath(); c.ellipse(W * 0.78, groundY - W * 0.5, W * 0.055, W * 0.045, 0, 0, 7); c.fill();
    c.fillStyle = 'rgba(40,32,26,0.8)';
    c.beginPath(); c.arc(W * 0.762, groundY - W * 0.505, W * 0.013, 0, 7); c.fill();
    c.beginPath(); c.arc(W * 0.8, groundY - W * 0.505, W * 0.013, 0, 7); c.fill();
    if (detail >= 1) {
      // натянутая шкура на жердях
      c.fillStyle = shade(pal.wall, -0.05);
      c.beginPath();
      c.moveTo(W * 0.1, groundY - W * 0.12); c.lineTo(W * 0.14, groundY - W * 0.42);
      c.lineTo(W * 0.34, groundY - W * 0.38); c.lineTo(W * 0.3, groundY - W * 0.1);
      c.closePath(); c.fill();
      c.strokeStyle = shade(pal.trim, -0.3); c.lineWidth = Math.max(1, W * 0.018);
      c.beginPath(); c.moveTo(W * 0.12, groundY); c.lineTo(W * 0.14, groundY - W * 0.44); c.stroke();
      c.beginPath(); c.moveTo(W * 0.32, groundY); c.lineTo(W * 0.34, groundY - W * 0.4); c.stroke();
    }
  },

  // Верфь: стапель с недостроенным корпусом судна и краном.
  shipyard(ctx) {
    const { c, gc, W, groundY, pal, detail } = ctx;
    // стапель уходит в воду
    c.fillStyle = shade(pal.trim, -0.1);
    c.beginPath();
    c.moveTo(W * 0.06, groundY); c.lineTo(W * 0.94, groundY);
    c.lineTo(W * 0.84, groundY - W * 0.13); c.lineTo(W * 0.16, groundY - W * 0.13);
    c.closePath(); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = Math.max(1, W * 0.012);
    for (let i = 1; i < 7; i++) {
      const t = i / 7;
      c.beginPath();
      c.moveTo(W * (0.06 + 0.1 * t), groundY - W * 0.13 * t);
      c.lineTo(W * (0.94 - 0.1 * t), groundY - W * 0.13 * t); c.stroke();
    }
    // корпус корабля на стапеле
    const hullY = groundY - W * 0.16;
    c.fillStyle = shade('#7a5433', 0.05);
    c.beginPath();
    c.moveTo(W * 0.18, hullY);
    c.quadraticCurveTo(W * 0.5, hullY + W * 0.14, W * 0.82, hullY);
    c.lineTo(W * 0.78, hullY - W * 0.2);
    c.quadraticCurveTo(W * 0.5, hullY - W * 0.1, W * 0.22, hullY - W * 0.2);
    c.closePath(); c.fill();
    c.strokeStyle = 'rgba(40,28,16,0.5)'; c.lineWidth = Math.max(1, W * 0.014);
    c.beginPath();
    c.moveTo(W * 0.2, hullY - W * 0.1);
    c.quadraticCurveTo(W * 0.5, hullY, W * 0.8, hullY - W * 0.1); c.stroke();
    // рёбра шпангоутов: растут изнутри корпуса, а не стоят рядом столбами
    c.strokeStyle = shade('#7a5433', -0.25); c.lineWidth = Math.max(1, W * 0.022);
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const px = W * (0.28 + i * 0.15);
      const top = hullY - W * (0.3 + Math.sin(t * Math.PI) * 0.12);
      c.beginPath();
      c.moveTo(px, hullY - W * 0.08);
      c.quadraticCurveTo(px - W * 0.02, hullY - W * 0.2, px, top);
      c.stroke();
    }
    // верхняя связь по бортам
    c.lineWidth = Math.max(1, W * 0.016);
    c.beginPath();
    c.moveTo(W * 0.26, hullY - W * 0.3);
    c.quadraticCurveTo(W * 0.5, hullY - W * 0.44, W * 0.75, hullY - W * 0.3);
    c.stroke();
    // кран-укосина
    c.strokeStyle = shade(pal.trim, -0.2); c.lineWidth = Math.max(2, W * 0.03);
    c.beginPath(); c.moveTo(W * 0.12, groundY - W * 0.14); c.lineTo(W * 0.16, groundY - W * 0.66); c.stroke();
    c.lineWidth = Math.max(1, W * 0.022);
    c.beginPath(); c.moveTo(W * 0.16, groundY - W * 0.66); c.lineTo(W * 0.48, groundY - W * 0.6); c.stroke();
    if (detail >= 1) {
      c.strokeStyle = 'rgba(30,26,20,0.7)'; c.lineWidth = Math.max(1, W * 0.01);
      c.beginPath(); c.moveTo(W * 0.44, groundY - W * 0.61); c.lineTo(W * 0.44, groundY - W * 0.5); c.stroke();
      gc.fillStyle = pal.glow;
      gc.fillRect(W * 0.6, hullY - W * 0.34, W * 0.05, W * 0.05); // сварка
    }
  },

  // Коллектор: люки, трубы и отстойник — здание почти целиком под землёй.
  sewers(ctx) {
    const { c, gc, W, groundY, pal, detail } = ctx;
    // бетонная плита
    c.fillStyle = shade('#8a8880', -0.05);
    c.beginPath(); c.ellipse(W / 2, groundY - W * 0.06, W * 0.44, W * 0.19, 0, 0, 7); c.fill();
    c.fillStyle = shade('#8a8880', 0.12);
    c.beginPath(); c.ellipse(W / 2, groundY - W * 0.08, W * 0.44, W * 0.19, 0, 0, 7); c.fill();
    // отстойник
    c.fillStyle = '#2f3a34';
    c.beginPath(); c.ellipse(W * 0.4, groundY - W * 0.12, W * 0.19, W * 0.09, 0, 0, 7); c.fill();
    c.fillStyle = 'rgba(96,132,110,0.55)';
    c.beginPath(); c.ellipse(W * 0.4, groundY - W * 0.13, W * 0.16, W * 0.07, 0, 0, 7); c.fill();
    // люк
    c.fillStyle = shade(pal.trim, -0.15);
    c.beginPath(); c.ellipse(W * 0.68, groundY - W * 0.1, W * 0.1, W * 0.05, 0, 0, 7); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = Math.max(1, W * 0.01);
    c.beginPath(); c.ellipse(W * 0.68, groundY - W * 0.1, W * 0.06, W * 0.03, 0, 0, 7); c.stroke();
    // выпускная труба со сливом
    box(c, W * 0.66, groundY - W * 0.34, W * 0.22, W * 0.16, W * 0.08, shade('#8a8880', -0.1));
    c.fillStyle = '#20282a';
    c.beginPath(); c.ellipse(W * 0.66, groundY - W * 0.26, W * 0.045, W * 0.06, 0, 0, 7); c.fill();
    if (detail >= 1) {
      c.strokeStyle = 'rgba(150,190,170,0.5)'; c.lineWidth = Math.max(1, W * 0.02);
      c.beginPath();
      c.moveTo(W * 0.62, groundY - W * 0.25);
      c.quadraticCurveTo(W * 0.54, groundY - W * 0.2, W * 0.5, groundY - W * 0.14);
      c.stroke();
      // вентиляционные трубы
      for (const k of [0.2, 0.3]) {
        c.fillStyle = shade(pal.trim, -0.2);
        c.fillRect(W * k, groundY - W * 0.3, W * 0.045, W * 0.24);
        c.fillStyle = shade(pal.trim, 0.1);
        c.beginPath(); c.ellipse(W * k + W * 0.022, groundY - W * 0.3, W * 0.03, W * 0.014, 0, 0, 7); c.fill();
      }
    }
  },

  // Лаборатория: стеклянный корпус, вытяжка и светящиеся колбы.
  lab(ctx) {
    const { c, gc, W, groundY, pal, detail } = ctx;
    const w = W * 0.72, x = (W - w) / 2, d = W * 0.15, h = W * 0.44, y = groundY - h;
    box(c, x, y, w, h, d, pal.wall);
    // сплошная лента остекления
    c.fillStyle = pal.glass;
    c.fillRect(x + w * 0.08, y + h * 0.16, w * 0.84, h * 0.26);
    gc.fillStyle = pal.glow;
    gc.fillRect(x + w * 0.08, y + h * 0.16, w * 0.84, h * 0.26);
    c.strokeStyle = pal.trim; c.lineWidth = Math.max(1, W * 0.014);
    for (let i = 1; i < 4; i++) {
      c.beginPath();
      c.moveTo(x + w * (0.08 + 0.21 * i), y + h * 0.16);
      c.lineTo(x + w * (0.08 + 0.21 * i), y + h * 0.42); c.stroke();
    }
    // плоская кровля с парапетом и вытяжкой
    c.fillStyle = shade(pal.roof, 0.05);
    c.fillRect(x - w * 0.03, y - W * 0.035, w * 1.06 + d * 0.7, W * 0.04);
    box(c, x + w * 0.62, y - W * 0.22, w * 0.2, W * 0.2, W * 0.07, shade(pal.wall, -0.12));
    c.fillStyle = shade(pal.trim, -0.1);
    c.fillRect(x + w * 0.66, y - W * 0.3, w * 0.05, W * 0.1);
    // колба у входа
    if (detail >= 1) {
      c.fillStyle = 'rgba(180,240,220,0.85)';
      c.beginPath();
      c.moveTo(x + w * 0.16, groundY - W * 0.2);
      c.lineTo(x + w * 0.24, groundY - W * 0.2);
      c.lineTo(x + w * 0.28, groundY - W * 0.04);
      c.lineTo(x + w * 0.12, groundY - W * 0.04);
      c.closePath(); c.fill();
      gc.fillStyle = '#7de3c8';
      gc.beginPath();
      gc.moveTo(x + w * 0.14, groundY - W * 0.12);
      gc.lineTo(x + w * 0.26, groundY - W * 0.12);
      gc.lineTo(x + w * 0.28, groundY - W * 0.04);
      gc.lineTo(x + w * 0.12, groundY - W * 0.04);
      gc.closePath(); gc.fill();
    }
    door(c, x + w * 0.44, groundY - h * 0.34, w * 0.16, h * 0.34, pal);
  },

  // Аэропорт: терминал, диспетчерская вышка и самолёт на полосе.
  airport(ctx) {
    const { c, gc, W, groundY, pal, detail } = ctx;
    // рулёжка
    c.fillStyle = 'rgba(60,62,66,0.55)';
    c.beginPath();
    c.moveTo(W * 0.02, groundY); c.lineTo(W * 0.98, groundY);
    c.lineTo(W * 0.88, groundY - W * 0.12); c.lineTo(W * 0.12, groundY - W * 0.12);
    c.closePath(); c.fill();
    c.strokeStyle = 'rgba(240,236,200,0.55)'; c.lineWidth = Math.max(1, W * 0.014);
    c.setLineDash([W * 0.06, W * 0.05]);
    c.beginPath(); c.moveTo(W * 0.08, groundY - W * 0.06); c.lineTo(W * 0.92, groundY - W * 0.06); c.stroke();
    c.setLineDash([]);
    // терминал
    const w = W * 0.62, x = W * 0.04, h = W * 0.24, y = groundY - W * 0.12 - h;
    box(c, x, y, w, h, W * 0.12, pal.wall);
    c.fillStyle = pal.glass;
    c.fillRect(x + w * 0.06, y + h * 0.28, w * 0.88, h * 0.4);
    gc.fillStyle = pal.glow;
    gc.fillRect(x + w * 0.06, y + h * 0.28, w * 0.88, h * 0.4);
    c.fillStyle = shade(pal.roof, 0.05);
    c.fillRect(x - w * 0.03, y - W * 0.028, w * 1.06 + W * 0.08, W * 0.032);
    // вышка
    const tx = W * 0.72, tw = W * 0.12, th = W * 0.62;
    box(c, tx, groundY - W * 0.12 - th, tw, th, W * 0.06, shade(pal.wall, -0.06));
    c.fillStyle = pal.glass;
    c.fillRect(tx - tw * 0.16, groundY - W * 0.12 - th - W * 0.02, tw * 1.32, W * 0.1);
    gc.fillStyle = pal.glow;
    gc.fillRect(tx - tw * 0.16, groundY - W * 0.12 - th - W * 0.02, tw * 1.32, W * 0.1);
    c.fillStyle = shade(pal.roof, -0.1);
    c.fillRect(tx - tw * 0.2, groundY - W * 0.12 - th - W * 0.055, tw * 1.4, W * 0.04);
    c.fillStyle = '#ff5a4a';
    c.beginPath(); c.arc(tx + tw / 2, groundY - W * 0.12 - th - W * 0.09, W * 0.022, 0, 7); c.fill();
    gc.fillStyle = '#ff5a4a';
    gc.beginPath(); gc.arc(tx + tw / 2, groundY - W * 0.12 - th - W * 0.09, W * 0.045, 0, 7); gc.fill();
    if (detail >= 1) {
      // самолётик на перроне
      const ax = W * 0.36, ay = groundY - W * 0.05;
      c.fillStyle = '#e8eef4';
      c.beginPath(); c.ellipse(ax, ay, W * 0.16, W * 0.035, 0, 0, 7); c.fill();
      c.beginPath();
      c.moveTo(ax - W * 0.02, ay); c.lineTo(ax + W * 0.06, ay - W * 0.11);
      c.lineTo(ax + W * 0.1, ay - W * 0.11); c.lineTo(ax + W * 0.05, ay);
      c.closePath(); c.fill();
      c.fillStyle = '#b8c2cc';
      c.beginPath();
      c.moveTo(ax - W * 0.13, ay); c.lineTo(ax - W * 0.16, ay - W * 0.07);
      c.lineTo(ax - W * 0.11, ay - W * 0.07); c.closePath(); c.fill();
      c.fillStyle = pal.accent;
      c.fillRect(ax - W * 0.14, ay - W * 0.01, W * 0.28, W * 0.012);
    }
  },

  // Ядро ИИ: чёрный монолит с парящим светящимся кольцом.
  aicore(ctx) {
    const { c, gc, W, groundY, pal, detail } = ctx;
    // основание-платформа
    c.fillStyle = shade(pal.wall, -0.2);
    c.beginPath(); c.ellipse(W / 2, groundY - W * 0.04, W * 0.4, W * 0.16, 0, 0, 7); c.fill();
    c.fillStyle = shade(pal.wall, 0.05);
    c.beginPath(); c.ellipse(W / 2, groundY - W * 0.07, W * 0.4, W * 0.16, 0, 0, 7); c.fill();
    c.strokeStyle = pal.trim; c.lineWidth = Math.max(1, W * 0.012);
    c.beginPath(); c.ellipse(W / 2, groundY - W * 0.07, W * 0.28, W * 0.11, 0, 0, 7); c.stroke();
    gc.strokeStyle = pal.glow; gc.lineWidth = Math.max(1, W * 0.02);
    gc.beginPath(); gc.ellipse(W / 2, groundY - W * 0.07, W * 0.28, W * 0.11, 0, 0, 7); gc.stroke();
    // монолит
    const mw = W * 0.26, mx = (W - mw) / 2, mh = W * 0.62, my = groundY - W * 0.1 - mh;
    const g = c.createLinearGradient(mx, 0, mx + mw, 0);
    g.addColorStop(0, '#1b2230');
    g.addColorStop(0.4, '#2f3c50');
    g.addColorStop(1, '#141a24');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(mx + mw * 0.1, my); c.lineTo(mx + mw * 0.9, my);
    c.lineTo(mx + mw, groundY - W * 0.1); c.lineTo(mx, groundY - W * 0.1);
    c.closePath(); c.fill();
    // светящиеся дорожки данных
    c.strokeStyle = pal.trim; c.lineWidth = Math.max(1, W * 0.014);
    gc.strokeStyle = pal.glow; gc.lineWidth = Math.max(1, W * 0.022);
    for (let i = 0; i < 3; i++) {
      const yy = my + mh * (0.2 + i * 0.26);
      for (const t of [c, gc]) {
        t.beginPath();
        t.moveTo(mx + mw * 0.16, yy);
        t.lineTo(mx + mw * 0.5, yy - mh * 0.06);
        t.lineTo(mx + mw * 0.84, yy);
        t.stroke();
      }
    }
    // парящее кольцо
    c.strokeStyle = pal.accent; c.lineWidth = Math.max(2, W * 0.026);
    c.beginPath(); c.ellipse(W / 2, my - W * 0.05, W * 0.24, W * 0.08, 0, 0, 7); c.stroke();
    gc.strokeStyle = pal.glow; gc.lineWidth = Math.max(2, W * 0.045);
    gc.beginPath(); gc.ellipse(W / 2, my - W * 0.05, W * 0.24, W * 0.08, 0, 0, 7); gc.stroke();
    if (detail >= 1) {
      c.fillStyle = 'rgba(220,245,255,0.9)';
      c.beginPath(); c.arc(W / 2, my - W * 0.05, W * 0.045, 0, 7); c.fill();
      gc.fillStyle = pal.glow;
      gc.beginPath(); gc.arc(W / 2, my - W * 0.05, W * 0.08, 0, 7); gc.fill();
    }
  },

  spire() { /* Шпиль рисуется отдельно: он анимирован по стадиям постройки */ },
};

export { ARCH };
