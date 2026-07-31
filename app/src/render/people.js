// render/people.js — процедурные спрайты жителей.
//
// Житель — не кружок, а маленький человек: голова, торс, две руки, две ноги,
// одежда своей эпохи, цвет по профессии и инструмент в руках.
//
// Каждый набор (эпоха × профессия × внешность) печётся ОДИН раз в offscreen-лист
// 4 кадра × 4 направления и дальше только копируется на экран — ровно тот же
// подход, что у построек в sprites.js. Рисовать человечка вектором каждый кадр
// нельзя: на сотне жителей это десятки тысяч операций и мгновенная просадка FPS.
//
// Анимация ходьбы привязана к ПРОЙДЕННОМУ ПУТИ (см. renderer.villagerState),
// то есть к игровому времени, а не к номеру кадра: при ускорении игры шаг
// ускоряется вместе с жителем, на паузе — замирает.
export const DIR_S = 0, DIR_W = 1, DIR_E = 2, DIR_N = 3;
const FRAMES = 4, DIRS = 4;
// высота кадра в пикселях по пресету графики (eco / medium / high-ultra)
const FRAME_H = [40, 64, 96];

// --- одежда по эпохам: крой и материал ------------------------------------
// kind задаёт силуэт, base — цвет ткани эпохи, head — головной убор.
const WEAR = [
  { kind: 'fur',     base: '#7d6046', trim: '#54402c', head: 'none', skinArms: true },   // 0 шкуры
  { kind: 'tunic',   base: '#c9a86e', trim: '#8a6d42', head: 'band', skinArms: true },   // 1 бронза: туника
  { kind: 'tunic',   base: '#9a9083', trim: '#5c5751', head: 'cap' },                    // 2 железо: туника с кожей
  { kind: 'toga',    base: '#e8e2cc', trim: '#bfae86', head: 'none', skinArms: true },   // 3 античность
  { kind: 'mail',    base: '#98a0a8', trim: '#6d3b30', head: 'helm' },                   // 4 кольчуга
  { kind: 'coat',    base: '#6a4a62', trim: '#d8c070', head: 'hat' },                    // 5 камзол
  { kind: 'robe',    base: '#6b5a48', trim: '#3a3028', head: 'cap' },                    // 6 рабочая роба
  { kind: 'overall', base: '#3f6f96', trim: '#e0d8c4', head: 'hard' },                   // 7 комбинезон
  { kind: 'overall', base: '#4a5a80', trim: '#8fd0ff', head: 'none' },                   // 8 цифровая
  { kind: 'suit',    base: '#e4eef4', trim: '#7de3ff', head: 'dome' },                   // 9 скафандр
];

// --- профессии: цвет и инструмент -----------------------------------------
export const PROF = {
  lumber:    { col: '#4f7a3a', tool: 'axe' },      // лесоруб
  miner:     { col: '#56606e', tool: 'pick' },     // шахтёр
  farmer:    { col: '#c9a33f', tool: 'sickle' },   // фермер
  builder:   { col: '#d8813a', tool: 'hammer' },   // строитель
  soldier:   { col: '#a8352c', tool: 'spear' },    // солдат
  scientist: { col: '#dfeaf2', tool: 'tablet' },   // учёный
  hunter:    { col: '#7d5a34', tool: 'bow' },      // охотник
  trader:    { col: '#8a5aa0', tool: 'crate' },    // торговец/рабочий на складе
  worker:    { col: '#96826a', tool: null },       // без профессии
};

// Внешность: кожа + волосы. Три варианта — жители перестают быть клонами.
const LOOK = [
  { skin: '#e3b98f', shade: '#c08f63', hair: '#4a3527' },
  { skin: '#c99266', shade: '#a06f47', hair: '#241a13' },
  { skin: '#f0d3ae', shade: '#cfa877', hair: '#8a6a3a' },
];

export class PeopleSprites {
  // gen растёт при смене пресета: рендер держит ссылку на лист прямо у жителя
  // и по этому счётчику понимает, что кэш пора перечитать.
  constructor(quality) { this.q = quality; this.map = new Map(); this.gen = 0; }
  setQuality(q) { this.q = q; this.map.clear(); this.gen++; }

  // Возвращает лист { cv, fw, fh } для набора. Печётся лениво: в партии обычно
  // живы 3-5 профессий одной эпохи — это 3-5 листов, а не все 270 сочетаний.
  sheet(era, prof, look) {
    const d = Math.max(0, Math.min(2, this.q.detail));
    const key = `${era}|${prof}|${look}|${d}`;
    let s = this.map.get(key);
    if (s) return s;
    s = bakeSheet(era, prof, look, FRAME_H[d], d);
    this.map.set(key, s);
    return s;
  }
}

// Профессия жителя по его работе. Рендер только ЧИТАЕТ состояние.
const WORK_PROF = {
  lumber: 'lumber', forager: 'lumber', woodshed: 'lumber',
  quarry: 'miner', mine: 'miner', stoneyard: 'miner', foundry: 'miner',
  farm: 'farmer', pasture: 'farmer', granary: 'farmer', mill: 'farmer',
  hunter_lodge: 'hunter',
  academy: 'scientist', university: 'scientist', observatory: 'scientist',
  lab: 'scientist', datacenter: 'scientist', biolab: 'scientist', ai_core: 'scientist',
  press: 'scientist', clinic: 'scientist', hospital: 'scientist',
  barracks: 'soldier', armory: 'soldier', castle: 'soldier', stone_walls: 'soldier',
  market: 'trader', depot: 'trader', bank: 'trader', treasury: 'trader',
  stock_exchange: 'trader', port: 'trader', guild_hall: 'trader',
  smithy: 'builder', workshop: 'builder', factory: 'builder', shipyard: 'builder',
  power_plant: 'builder', robo_factory: 'builder', npp: 'builder',
};

export function professionOf(v) {
  if (v.job === 'build') return 'builder';
  if (v.job === 'hunt') return 'hunter';
  if (v.job === 'forage' || v.job === 'deadfall') return 'lumber';
  if (v.target && v.target.b) return WORK_PROF[v.target.b.id] || 'worker';
  return 'worker';
}

// Внешность закреплена за жителем через хеш имени — одинакова между кадрами
// и между загрузками сейва (Math.random здесь недопустим). Кэш держим снаружи:
// рендер не имеет права дописывать поля в объекты симуляции.
const LOOK_CACHE = new WeakMap();
export function lookOf(v) {
  let l = LOOK_CACHE.get(v);
  if (l === undefined) {
    let h = 0;
    for (let i = 0; i < v.name.length; i++) h = (h * 31 + v.name.charCodeAt(i)) | 0;
    l = Math.abs(h) % LOOK.length;
    LOOK_CACHE.set(v, l);
  }
  return l;
}

// ---------------------------------------------------------------------------
// Звери. Тот же принцип: два кадра шага × два направления, печётся один раз.
// Кружок с кружком-головой рядом с нормальными человечками выглядел бы дико.
// ---------------------------------------------------------------------------
export class AnimalSprites {
  constructor(quality) { this.q = quality; this.map = new Map(); this.gen = 0; }
  setQuality(q) { this.q = q; this.map.clear(); this.gen++; }
  sheet(kind) {
    const d = Math.max(0, Math.min(2, this.q.detail));
    const key = `${kind}|${d}`;
    let s = this.map.get(key);
    if (s) return s;
    s = bakeAnimal(kind, [34, 54, 78][d], d);
    this.map.set(key, s);
    return s;
  }
}

function bakeAnimal(kind, FH, detail) {
  const mammoth = kind === 'mammoth';
  const FW = Math.round(FH * (mammoth ? 1.7 : 1.35));
  const cv = document.createElement('canvas');
  cv.width = FW * 2; cv.height = FH * 2;      // 2 кадра × 2 направления
  const c = cv.getContext('2d');
  const tmp = document.createElement('canvas');
  tmp.width = FW; tmp.height = FH;
  const tc = tmp.getContext('2d');
  for (let d = 0; d < 2; d++) {
    for (let f = 0; f < 2; f++) {
      tc.clearRect(0, 0, FW, FH);
      tc.save();
      if (d === 1) { tc.translate(FW, 0); tc.scale(-1, 1); }
      drawBeast(tc, FW, FH, mammoth, f, detail);
      tc.restore();
      const ox = f * FW, oy = d * FH;
      const g = c.createRadialGradient(ox + FW / 2, oy + FH * 0.94, 0, ox + FW / 2, oy + FH * 0.94, FH * 0.3);
      g.addColorStop(0, 'rgba(20,16,12,0.4)');
      g.addColorStop(1, 'rgba(20,16,12,0)');
      c.fillStyle = g;
      c.beginPath(); c.ellipse(ox + FW / 2, oy + FH * 0.94, FH * 0.34, FH * 0.09, 0, 0, 7); c.fill();
      outline(c, tmp, ox, oy, Math.max(1, Math.round(FH / 40)));
      c.drawImage(tmp, ox, oy);
    }
  }
  return { cv, fw: FW, fh: FH };
}

function drawBeast(c, W, H, mammoth, frame, detail) {
  const body = mammoth ? '#6b4f35' : '#a9825a';
  const dark = mix(body, '#000000', 0.3);
  const light = mix(body, '#ffffff', 0.18);
  const ground = H * 0.93;
  const swing = frame ? 0.34 : -0.34;
  const bodyY = mammoth ? H * 0.44 : H * 0.5;
  const bodyW = W * (mammoth ? 0.56 : 0.58), bodyH = H * (mammoth ? 0.38 : 0.3);
  // Мамонта сдвигаем влево: хобот и бивни выносят силуэт далеко вперёд и
  // при центровке по телу обрезались краем кадра.
  const cx = W * (mammoth ? 0.38 : 0.46);
  // ноги
  const legW = H * (mammoth ? 0.11 : 0.07);
  for (const [k, s] of [[-1, swing], [1, -swing], [-1, -swing * 0.7], [1, swing * 0.7]]) {
    const hx = cx + k * bodyW * 0.34;
    c.strokeStyle = k > 0 ? dark : body;
    c.lineWidth = legW; c.lineCap = 'round';
    c.beginPath();
    c.moveTo(hx, bodyY + bodyH * 0.3);
    c.lineTo(hx + Math.sin(s) * H * 0.16, ground);
    c.stroke();
  }
  // туловище
  const g = c.createLinearGradient(0, bodyY - bodyH / 2, 0, bodyY + bodyH / 2);
  g.addColorStop(0, light); g.addColorStop(1, dark);
  c.fillStyle = g;
  c.beginPath(); c.ellipse(cx, bodyY, bodyW / 2, bodyH / 2, 0, 0, 7); c.fill();
  // шея и голова
  const hx = cx + bodyW * (mammoth ? 0.46 : 0.5), hy = bodyY - bodyH * (mammoth ? 0.35 : 0.6);
  c.strokeStyle = body; c.lineWidth = H * (mammoth ? 0.2 : 0.11); c.lineCap = 'round';
  c.beginPath(); c.moveTo(cx + bodyW * 0.24, bodyY - bodyH * 0.12); c.lineTo(hx, hy); c.stroke();
  c.fillStyle = light;
  c.beginPath(); c.ellipse(hx + W * 0.03, hy, W * (mammoth ? 0.11 : 0.09), H * (mammoth ? 0.13 : 0.09), 0.2, 0, 7); c.fill();
  if (mammoth) {
    // хобот и бивни
    c.strokeStyle = body; c.lineWidth = H * 0.07;
    c.beginPath();
    c.moveTo(hx + W * 0.09, hy + H * 0.06);
    c.quadraticCurveTo(hx + W * 0.2, hy + H * 0.2, hx + W * 0.14, ground - H * 0.06);
    c.stroke();
    c.strokeStyle = '#e6ddc6'; c.lineWidth = H * 0.045;
    for (const k of [0, 1]) {
      c.beginPath();
      c.moveTo(hx + W * (0.08 - k * 0.02), hy + H * 0.08);
      c.quadraticCurveTo(hx + W * 0.22, hy + H * 0.22, hx + W * (0.26 - k * 0.03), hy + H * 0.06);
      c.stroke();
    }
    // шерсть по спине
    if (detail >= 1) {
      c.strokeStyle = dark; c.lineWidth = H * 0.02;
      for (let i = 0; i < 6; i++) {
        const px = cx - bodyW * 0.36 + i * bodyW * 0.14;
        c.beginPath(); c.moveTo(px, bodyY + bodyH * 0.34); c.lineTo(px - W * 0.01, bodyY + bodyH * 0.5); c.stroke();
      }
    }
  } else {
    // рога и хвост оленя
    c.strokeStyle = '#7a5a34'; c.lineWidth = H * 0.028; c.lineCap = 'round';
    for (const k of [-1, 1]) {
      const rx = hx + W * 0.02 + k * W * 0.02;
      c.beginPath();
      c.moveTo(rx, hy - H * 0.06);
      c.lineTo(rx + k * W * 0.04, hy - H * 0.2);
      c.moveTo(rx + k * W * 0.02, hy - H * 0.13);
      c.lineTo(rx + k * W * 0.07, hy - H * 0.17);
      c.stroke();
    }
    c.fillStyle = '#efe6d6';
    c.beginPath(); c.ellipse(cx - bodyW * 0.5, bodyY - bodyH * 0.16, W * 0.035, H * 0.045, 0, 0, 7); c.fill();
    if (detail >= 1) {
      // белые пятна на спине
      c.fillStyle = 'rgba(240,232,214,0.55)';
      for (let i = 0; i < 3; i++) {
        c.beginPath();
        c.arc(cx - bodyW * 0.1 + i * bodyW * 0.16, bodyY - bodyH * 0.16, W * 0.022, 0, 7);
        c.fill();
      }
    }
  }
  // глаз
  c.fillStyle = 'rgba(28,20,16,0.9)';
  c.beginPath(); c.arc(hx + W * 0.06, hy - H * 0.01, H * 0.018, 0, 7); c.fill();
}

// ---------------------------------------------------------------------------
// Выпечка листа
// ---------------------------------------------------------------------------
function bakeSheet(era, prof, look, FH, detail) {
  const FW = Math.round(FH * 0.78);
  const cv = document.createElement('canvas');
  cv.width = FW * FRAMES; cv.height = FH * DIRS;
  const c = cv.getContext('2d');
  const wear = WEAR[Math.max(0, Math.min(9, era))];
  const pr = PROF[prof] || PROF.worker;
  const lk = LOOK[look % LOOK.length];

  // временный холст под одну позу: нужен, чтобы обвести фигуру контуром
  const tmp = document.createElement('canvas');
  tmp.width = FW; tmp.height = FH;
  const tc = tmp.getContext('2d');

  for (let d = 0; d < DIRS; d++) {
    for (let f = 0; f < FRAMES; f++) {
      tc.clearRect(0, 0, FW, FH);
      drawPose(tc, FW, FH, { wear, pr, lk, dir: d, frame: f, detail });
      const ox = f * FW, oy = d * FH;
      // тень-контакт под ногами — рисуется до фигуры
      const g = c.createRadialGradient(ox + FW / 2, oy + FH * 0.945, 0, ox + FW / 2, oy + FH * 0.945, FH * 0.17);
      g.addColorStop(0, 'rgba(20,16,12,0.42)');
      g.addColorStop(1, 'rgba(20,16,12,0)');
      c.fillStyle = g;
      c.beginPath(); c.ellipse(ox + FW / 2, oy + FH * 0.945, FH * 0.17, FH * 0.062, 0, 0, 7); c.fill();
      outline(c, tmp, ox, oy, Math.max(1, Math.round(FH / 44)));
      c.drawImage(tmp, ox, oy);
    }
  }
  return { cv, fw: FW, fh: FH };
}

// Тёмный контур: силуэт фигуры, размазанный на 1-2 пикселя во все стороны.
// Без него человечек теряется на траве и на крышах.
function outline(c, tmp, ox, oy, k) {
  const W = tmp.width, H = tmp.height;
  const sil = document.createElement('canvas');
  sil.width = W; sil.height = H;
  const sc = sil.getContext('2d');
  sc.drawImage(tmp, 0, 0);
  sc.globalCompositeOperation = 'source-in';
  sc.fillStyle = 'rgba(24,18,14,0.85)';
  sc.fillRect(0, 0, W, H);
  for (const [dx, dy] of [[-k, 0], [k, 0], [0, -k], [0, k], [-k, -k], [k, -k], [-k, k], [k, k]]) {
    c.drawImage(sil, ox + dx, oy + dy);
  }
}

// ---------------------------------------------------------------------------
// Поза: скелет считается в «боковом» пространстве (x — вперёд по ходу),
// затем проецируется по направлению взгляда.
// ---------------------------------------------------------------------------
function drawPose(c, W, H, o) {
  const { wear, pr, lk, dir, frame, detail } = o;
  const side = dir === DIR_W || dir === DIR_E;   // профиль
  const back = dir === DIR_N;
  const mirror = dir === DIR_W;
  const t = frame * Math.PI / 2;
  // Сжатие продольного движения при взгляде в лоб/спину — иначе ноги
  // разъезжаются на всю ширину кадра и человек «шпагатит».
  const fore = side ? 1 : 0.34;

  c.save();
  if (mirror) { c.translate(W, 0); c.scale(-1, 1); }

  const cx = W / 2;
  const ground = H * 0.955;
  const bob = -H * 0.014 * (0.5 + 0.5 * Math.cos(2 * t));
  const hipY = H * 0.615 + bob;
  const shoY = H * 0.345 + bob;
  const headY = H * 0.20 + bob;
  const headR = H * 0.125;
  const thigh = H * 0.175, shin = H * 0.175;
  const legSpread = side ? H * 0.012 : H * 0.05;
  const armSpread = side ? H * 0.01 : H * 0.086;

  const skin = lk.skin, skinDark = lk.shade;
  const cloth = pr.col;
  const clothDark = mix(cloth, '#000000', 0.32);
  const era = wear;
  // Ткань эпохи — на штанах/рукавах, цвет профессии — на торсе.
  const pants = wear.kind === 'toga' ? mix(era.base, '#ffffff', 0.1) : mix(era.base, '#000000', 0.18);
  const legW = H * 0.062, armW = H * 0.05;

  // --- ноги ---------------------------------------------------------------
  // Шаг: бедро качается, колено сгибается только назад — иначе выходит шпагат.
  const legPose = (ph) => {
    const th = 0.44 * Math.sin(ph);
    const kn = -0.85 * Math.max(0, -Math.sin(ph - 0.55));
    return { th, kn };
  };
  const L = [
    { ...legPose(t), off: -legSpread },
    { ...legPose(t + Math.PI), off: legSpread },
  ];
  // дальняя нога рисуется первой и темнее
  const drawLeg = (p, dark) => {
    const hx = cx + p.off, hy = hipY;
    const kx = hx + Math.sin(p.th) * thigh * fore, ky = hy + Math.cos(p.th) * thigh;
    const a2 = p.th + p.kn;
    const fx = kx + Math.sin(a2) * shin * fore, fy = ky + Math.cos(a2) * shin;
    const col = dark ? mix(pants, '#000000', 0.3) : pants;
    capsule(c, hx, hy, kx, ky, legW, col);
    capsule(c, kx, ky, fx, fy, legW * 0.88, col);
    // ботинок/ступня
    c.fillStyle = dark ? mix(era.trim, '#000000', 0.35) : mix(era.trim, '#000000', 0.12);
    c.beginPath();
    c.ellipse(fx + (side ? legW * 0.35 : 0), Math.min(fy + legW * 0.1, ground), legW * (side ? 0.78 : 0.6), legW * 0.42, 0, 0, 7);
    c.fill();
  };
  drawLeg(L[0], true);
  drawLeg(L[1], false);

  // --- дальняя рука -------------------------------------------------------
  const armPose = (ph) => ({ up: -0.5 * Math.sin(ph), el: -0.45 });
  const backArm = armPose(t + Math.PI), frontArm = armPose(t);
  const drawArm = (p, off, dark, sleeve) => {
    const hx = cx + off, hy = shoY + H * 0.02;
    const ex = hx + Math.sin(p.up) * H * 0.15 * fore, ey = hy + Math.cos(p.up) * H * 0.15;
    const a2 = p.up + p.el;
    const wx = ex + Math.sin(a2) * H * 0.14 * fore, wy = ey + Math.cos(a2) * H * 0.14;
    // Рукав чуть темнее торса: иначе в анфас руки сливаются с телом в пятно.
    const sl = mix(sleeve, '#000000', dark ? 0.34 : 0.13);
    capsule(c, hx, hy, ex, ey, armW, sl);
    const bare = era.skinArms;
    capsule(c, ex, ey, wx, wy, armW * 0.86, bare ? (dark ? skinDark : skin) : sl);
    c.fillStyle = dark ? skinDark : skin;
    c.beginPath(); c.arc(wx, wy, armW * 0.5, 0, 7); c.fill();
    return { x: wx, y: wy };
  };
  const sleeveCol = era.kind === 'mail' ? era.base : cloth;
  const backHand = drawArm(backArm, -armSpread, true, sleeveCol);

  // --- торс ---------------------------------------------------------------
  torso(c, cx, shoY, hipY, H, side, cloth, clothDark, era, detail);

  // --- передняя рука ------------------------------------------------------
  const frontHand = drawArm(frontArm, armSpread, false, sleeveCol);

  // --- голова -------------------------------------------------------------
  head(c, cx, headY, headR, H, side, back, skin, skinDark, lk.hair, era, detail);

  // --- инструмент ---------------------------------------------------------
  if (pr.tool && detail >= 1) tool(c, pr.tool, frontHand, backHand, H, side, back, era);

  c.restore();
}

// Торс с кроем эпохи.
function torso(c, cx, shoY, hipY, H, side, cloth, clothDark, era, detail) {
  const w = H * (side ? 0.155 : 0.205);
  const h = hipY - shoY;
  const x = cx - w / 2;
  // базовая рубаха: скруглённый прямоугольник с градиентом
  const g = c.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, mix(cloth, '#ffffff', 0.16));
  g.addColorStop(0.55, cloth);
  g.addColorStop(1, clothDark);
  c.fillStyle = g;
  roundRect(c, x, shoY, w, h * 1.06, w * 0.32);
  c.fill();

  if (era.kind === 'fur') {
    // шкура: рваный подол и меховой воротник
    c.fillStyle = mix(era.base, '#000000', 0.12);
    c.beginPath();
    c.moveTo(x, hipY - h * 0.18);
    for (let i = 0; i <= 4; i++) {
      const px = x + w * (i / 4);
      c.lineTo(px, hipY + h * (i % 2 ? 0.14 : 0.04));
    }
    c.lineTo(x + w, hipY - h * 0.18);
    c.closePath(); c.fill();
    c.fillStyle = mix(era.base, '#ffffff', 0.3);
    c.beginPath(); c.ellipse(cx, shoY + h * 0.06, w * 0.6, h * 0.13, 0, 0, 7); c.fill();
  } else if (era.kind === 'tunic') {
    c.fillStyle = era.trim;
    c.fillRect(x, shoY + h * 0.6, w, h * 0.13);            // пояс
    c.fillStyle = 'rgba(255,255,255,0.16)';
    c.fillRect(cx - w * 0.05, shoY + h * 0.08, w * 0.1, h * 0.5);
  } else if (era.kind === 'toga') {
    c.fillStyle = mix(era.base, '#ffffff', 0.25);
    c.beginPath();
    c.moveTo(x, shoY + h * 0.08); c.lineTo(x + w, shoY + h * 0.42);
    c.lineTo(x + w, shoY + h * 0.62); c.lineTo(x, shoY + h * 0.28);
    c.closePath(); c.fill();
  } else if (era.kind === 'mail') {
    // кольчуга: сетка точек поверх, сверху накидка цвета профессии
    c.fillStyle = era.base;
    roundRect(c, x, shoY, w, h * 0.98, w * 0.3); c.fill();
    if (detail >= 1) {
      c.fillStyle = 'rgba(0,0,0,0.22)';
      for (let yy = shoY + h * 0.12; yy < hipY; yy += H * 0.026) {
        for (let xx = x + w * 0.14; xx < x + w * 0.9; xx += H * 0.026) c.fillRect(xx, yy, H * 0.012, H * 0.012);
      }
    }
    c.fillStyle = cloth;
    c.beginPath();
    c.moveTo(cx - w * 0.26, shoY + h * 0.06); c.lineTo(cx + w * 0.26, shoY + h * 0.06);
    c.lineTo(cx + w * 0.2, hipY + h * 0.06); c.lineTo(cx - w * 0.2, hipY + h * 0.06);
    c.closePath(); c.fill();
    c.fillStyle = era.trim;
    c.fillRect(x, shoY + h * 0.62, w, h * 0.1);
  } else if (era.kind === 'coat') {
    // камзол: расширяющиеся полы ниже пояса
    c.fillStyle = clothDark;
    c.beginPath();
    c.moveTo(x, shoY + h * 0.55); c.lineTo(x + w, shoY + h * 0.55);
    c.lineTo(x + w * 1.16, hipY + h * 0.3); c.lineTo(x - w * 0.16, hipY + h * 0.3);
    c.closePath(); c.fill();
    c.fillStyle = era.trim;
    c.fillRect(cx - w * 0.04, shoY + h * 0.1, w * 0.08, h * 0.5);  // застёжка
    c.beginPath(); c.ellipse(cx, shoY + h * 0.05, w * 0.42, h * 0.1, 0, 0, 7); c.fill(); // жабо
  } else if (era.kind === 'robe') {
    c.fillStyle = mix(era.base, '#ffffff', 0.08);
    c.fillRect(cx - w * 0.34, shoY + h * 0.3, w * 0.68, h * 0.8);   // фартук
    c.fillStyle = era.trim;
    c.fillRect(x, shoY + h * 0.58, w, h * 0.1);
  } else if (era.kind === 'overall') {
    c.fillStyle = mix(era.base, '#000000', 0.05);
    c.fillRect(x, shoY + h * 0.45, w, h * 0.61);                     // штанина комбинезона
    c.fillStyle = cloth;
    c.fillRect(cx - w * 0.34, shoY + h * 0.05, w * 0.14, h * 0.45);  // лямки
    c.fillRect(cx + w * 0.2, shoY + h * 0.05, w * 0.14, h * 0.45);
    c.fillStyle = era.trim;
    c.fillRect(x, shoY + h * 0.42, w, H * 0.012);                    // светоотражающая полоса
  } else if (era.kind === 'suit') {
    c.fillStyle = mix(era.base, '#ffffff', 0.2);
    roundRect(c, x, shoY, w, h * 1.02, w * 0.36); c.fill();
    c.fillStyle = cloth;
    c.fillRect(cx - w * 0.42, shoY + h * 0.24, w * 0.84, h * 0.16);  // нагрудная панель
    c.fillStyle = era.trim;
    c.beginPath(); c.arc(cx + w * 0.2, shoY + h * 0.32, w * 0.1, 0, 7); c.fill();
    c.fillStyle = mix(era.base, '#000000', 0.25);
    roundRect(c, cx - w * 0.62, shoY + h * 0.1, w * 0.24, h * 0.6, w * 0.1); c.fill(); // ранец
  }
  // общая подтенёвка низа торса
  c.fillStyle = 'rgba(0,0,0,0.14)';
  c.fillRect(x, hipY - h * 0.06, w, h * 0.1);
}

function head(c, cx, cy, r, H, side, back, skin, skinDark, hair, era, detail) {
  // шея
  c.fillStyle = skinDark;
  c.fillRect(cx - r * 0.28, cy + r * 0.5, r * 0.56, r * 0.6);
  // череп
  const g = c.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r * 1.15);
  g.addColorStop(0, mix(skin, '#ffffff', 0.22));
  g.addColorStop(1, skinDark);
  c.fillStyle = g;
  c.beginPath();
  if (side) c.ellipse(cx + r * 0.06, cy, r * 0.92, r, 0, 0, 7);
  else c.ellipse(cx, cy, r * 0.94, r, 0, 0, 7);
  c.fill();
  if (side) {
    // нос
    c.fillStyle = skin;
    c.beginPath();
    c.moveTo(cx + r * 0.85, cy - r * 0.1); c.lineTo(cx + r * 1.12, cy + r * 0.08);
    c.lineTo(cx + r * 0.82, cy + r * 0.18); c.closePath(); c.fill();
  }
  // волосы
  c.fillStyle = hair;
  c.beginPath();
  if (back) c.ellipse(cx, cy + r * 0.05, r * 0.96, r * 0.95, 0, 0, 7);
  else if (side) c.ellipse(cx - r * 0.16, cy - r * 0.18, r * 0.86, r * 0.78, 0, 0, 7);
  else c.ellipse(cx, cy - r * 0.28, r * 0.95, r * 0.72, 0, 0, 7);
  c.fill();
  if (!back && !side && detail >= 1) {
    // глаза — две тёмные точки, лицо читается уже с 30 пикселей
    c.fillStyle = 'rgba(30,22,18,0.85)';
    c.beginPath(); c.arc(cx - r * 0.34, cy + r * 0.16, r * 0.13, 0, 7); c.fill();
    c.beginPath(); c.arc(cx + r * 0.34, cy + r * 0.16, r * 0.13, 0, 7); c.fill();
  }
  if (side && !back && detail >= 1) {
    c.fillStyle = 'rgba(30,22,18,0.85)';
    c.beginPath(); c.arc(cx + r * 0.42, cy + r * 0.1, r * 0.12, 0, 7); c.fill();
  }
  // головной убор
  const hd = era.head;
  if (hd === 'band') {
    c.fillStyle = era.trim;
    c.fillRect(cx - r, cy - r * 0.5, r * 2, r * 0.28);
  } else if (hd === 'cap') {
    c.fillStyle = mix(era.base, '#000000', 0.25);
    c.beginPath(); c.ellipse(cx, cy - r * 0.35, r * 1.02, r * 0.72, 0, Math.PI, 0); c.fill();
    c.fillRect(cx - r * 1.02, cy - r * 0.4, r * 2.04, r * 0.2);
  } else if (hd === 'helm') {
    c.fillStyle = mix(era.base, '#ffffff', 0.15);
    c.beginPath(); c.ellipse(cx, cy - r * 0.2, r * 1.08, r * 0.98, 0, Math.PI, 0); c.fill();
    c.fillRect(cx - r * 1.08, cy - r * 0.24, r * 2.16, r * 0.24);
    c.fillStyle = mix(era.base, '#000000', 0.3);
    if (!side) c.fillRect(cx - r * 0.1, cy - r * 0.3, r * 0.2, r * 0.9); // наносник
  } else if (hd === 'hat') {
    c.fillStyle = mix(era.base, '#000000', 0.35);
    c.beginPath(); c.ellipse(cx, cy - r * 0.42, r * 1.5, r * 0.3, 0, 0, 7); c.fill();
    c.beginPath(); c.ellipse(cx, cy - r * 0.55, r * 0.8, r * 0.55, 0, Math.PI, 0); c.fill();
    c.fillStyle = era.trim;
    c.fillRect(cx - r * 0.8, cy - r * 0.55, r * 1.6, r * 0.14);
  } else if (hd === 'hard') {
    c.fillStyle = '#e8b52e';
    c.beginPath(); c.ellipse(cx, cy - r * 0.22, r * 1.02, r * 0.92, 0, Math.PI, 0); c.fill();
    c.beginPath(); c.ellipse(cx + (side ? r * 0.5 : 0), cy - r * 0.2, r * (side ? 1.25 : 1.28), r * 0.22, 0, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.35)';
    c.fillRect(cx - r * 0.12, cy - r * 1.05, r * 0.24, r * 0.8);
  } else if (hd === 'dome') {
    // Гермошлем с зеркальным забралом. Стекло делаем НЕпрозрачным: контур
    // спрайта печётся по силуэту, и полупрозрачный купол превращался в
    // грязно-серый блин вместо шлема.
    const gy = cy - r * 0.05, gr = r * 1.2;
    const gg = c.createRadialGradient(cx - gr * 0.35, gy - gr * 0.4, gr * 0.05, cx, gy, gr);
    gg.addColorStop(0, '#cfeaf6');
    gg.addColorStop(0.55, '#7fb6cc');
    gg.addColorStop(1, '#3f6076');
    c.fillStyle = gg;
    c.beginPath(); c.arc(cx, gy, gr, 0, 7); c.fill();
    // лицо просвечивает силуэтом
    c.fillStyle = 'rgba(40,48,58,0.32)';
    c.beginPath(); c.ellipse(cx + (side ? r * 0.2 : 0), gy + r * 0.12, r * 0.5, r * 0.62, 0, 0, 7); c.fill();
    c.strokeStyle = era.trim; c.lineWidth = r * 0.18;
    c.beginPath(); c.arc(cx, gy, gr, 0, 7); c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.75)';
    c.beginPath(); c.ellipse(cx - r * 0.52, gy - r * 0.62, r * 0.34, r * 0.16, -0.6, 0, 7); c.fill();
  }
}

// Инструмент в передней руке. Рисуется последним — он часть силуэта и
// именно по нему профессия читается с одного взгляда.
function tool(c, kind, hand, backHand, H, side, back, era) {
  const u = H;
  const wood = '#7a5433', dark = '#4a3626', steel = '#c3cad2', steelDark = '#7d858e';
  c.lineCap = 'round';
  const hx = hand.x, hy = hand.y;
  if (kind === 'axe') {
    const tipX = hx + u * 0.02, tipY = hy - u * 0.27;
    capsule(c, hx - u * 0.02, hy + u * 0.06, tipX, tipY, u * 0.026, wood);
    // обух у древка, лезвие полумесяцем наружу — топор читается силуэтом
    c.fillStyle = steelDark;
    c.fillRect(tipX - u * 0.035, tipY - u * 0.02, u * 0.05, u * 0.14);
    c.fillStyle = steel;
    c.beginPath();
    c.moveTo(tipX + u * 0.01, tipY - u * 0.025);
    c.quadraticCurveTo(tipX + u * 0.15, tipY + u * 0.05, tipX + u * 0.01, tipY + u * 0.125);
    c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.45)';
    c.beginPath();
    c.moveTo(tipX + u * 0.055, tipY + u * 0.005);
    c.quadraticCurveTo(tipX + u * 0.14, tipY + u * 0.05, tipX + u * 0.05, tipY + u * 0.1);
    c.closePath(); c.fill();
  } else if (kind === 'pick') {
    const tipX = hx, tipY = hy - u * 0.24;
    capsule(c, hx, hy + u * 0.06, tipX, tipY, u * 0.024, wood);
    c.strokeStyle = steel; c.lineWidth = u * 0.026;
    c.beginPath();
    c.moveTo(tipX - u * 0.075, tipY + u * 0.04);
    c.quadraticCurveTo(tipX, tipY - u * 0.035, tipX + u * 0.075, tipY + u * 0.04);
    c.stroke();
  } else if (kind === 'sickle') {
    capsule(c, hx, hy, hx + u * 0.05, hy - u * 0.09, u * 0.024, wood);
    c.strokeStyle = steel; c.lineWidth = u * 0.026;
    c.beginPath();
    c.arc(hx + u * 0.02, hy - u * 0.13, u * 0.09, 0.3, 3.2);
    c.stroke();
  } else if (kind === 'hammer') {
    const tipX = hx + u * 0.01, tipY = hy - u * 0.22;
    capsule(c, hx, hy + u * 0.05, tipX, tipY, u * 0.024, wood);
    c.fillStyle = steelDark;
    roundRect(c, tipX - u * 0.06, tipY - u * 0.03, u * 0.13, u * 0.06, u * 0.012); c.fill();
    c.fillStyle = steel;
    c.fillRect(tipX - u * 0.06, tipY - u * 0.03, u * 0.13, u * 0.02);
  } else if (kind === 'spear') {
    // В анфас копьё отводим наружу: иначе наконечник торчит ровно над головой
    // и читается как рог на шлеме.
    const off = side ? 0 : u * 0.06;
    const bx = hx + u * 0.04 + off, by = hy + u * 0.1, tx = hx - u * 0.02 + off, ty = hy - u * 0.42;
    capsule(c, bx, by, tx, ty, u * 0.022, wood);
    c.fillStyle = steel;
    c.beginPath();
    c.moveTo(tx, ty - u * 0.08); c.lineTo(tx + u * 0.035, ty + u * 0.02);
    c.lineTo(tx - u * 0.035, ty + u * 0.02); c.closePath(); c.fill();
    // щит на дальней руке
    c.fillStyle = mix(era.trim, '#000000', 0.1);
    c.beginPath(); c.ellipse(backHand.x, backHand.y - u * 0.04, u * 0.075, u * 0.1, 0, 0, 7); c.fill();
    c.strokeStyle = 'rgba(240,232,210,0.7)'; c.lineWidth = u * 0.012;
    c.beginPath(); c.ellipse(backHand.x, backHand.y - u * 0.04, u * 0.045, u * 0.06, 0, 0, 7); c.stroke();
  } else if (kind === 'tablet') {
    c.fillStyle = '#2c3a48';
    roundRect(c, hx - u * 0.05, hy - u * 0.11, u * 0.11, u * 0.14, u * 0.014); c.fill();
    c.fillStyle = 'rgba(140,220,255,0.9)';
    c.fillRect(hx - u * 0.035, hy - u * 0.095, u * 0.08, u * 0.11);
  } else if (kind === 'bow') {
    const bx = hx + u * 0.05, by = hy - u * 0.05, br = u * 0.115;
    c.strokeStyle = wood; c.lineWidth = u * 0.02;
    c.beginPath(); c.arc(bx, by, br, -1.25, 1.25); c.stroke();
    c.strokeStyle = 'rgba(240,232,210,0.75)'; c.lineWidth = u * 0.007;
    c.beginPath();
    c.moveTo(bx + Math.cos(-1.25) * br, by + Math.sin(-1.25) * br);
    c.lineTo(bx + Math.cos(1.25) * br, by + Math.sin(1.25) * br);
    c.stroke();
  } else if (kind === 'crate') {
    // ящик на двух руках перед собой
    const bx = (hx + backHand.x) / 2, by = Math.min(hy, backHand.y) - u * 0.02;
    c.fillStyle = '#9a7040';
    roundRect(c, bx - u * 0.09, by - u * 0.09, u * 0.18, u * 0.15, u * 0.012); c.fill();
    c.fillStyle = 'rgba(0,0,0,0.25)';
    c.fillRect(bx - u * 0.09, by - u * 0.035, u * 0.18, u * 0.018);
    c.fillStyle = 'rgba(255,245,220,0.25)';
    c.fillRect(bx - u * 0.09, by - u * 0.09, u * 0.18, u * 0.016);
  }
}

// ---------------------------------------------------------------------------
// Мелкие примитивы
// ---------------------------------------------------------------------------
function capsule(c, x1, y1, x2, y2, w, col) {
  c.strokeStyle = col;
  c.lineWidth = w;
  c.lineCap = 'round';
  c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
}

function roundRect(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

// Принимает и '#rrggbb', и уже смешанный 'rgb(r,g,b)' — иначе повторное
// смешивание (тень на тени) молча даёт NaN и чёрные пятна.
function rgb(col) {
  if (col[0] === '#') {
    const v = parseInt(col.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const m = col.match(/-?\d+/g);
  return [+m[0], +m[1], +m[2]];
}

function mix(c1, c2, k) {
  const a = rgb(c1), b = rgb(c2);
  return `rgb(${Math.round(a[0] * (1 - k) + b[0] * k)},${Math.round(a[1] * (1 - k) + b[1] * k)},${Math.round(a[2] * (1 - k) + b[2] * k)})`;
}
