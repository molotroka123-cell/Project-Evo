// render/vegetation.js — растительность: породы деревьев, ветер в кронах,
// сезонная листва, подлесок, кусты, цветы и пни на вырубках.
//
// ЗАЧЕМ. terrain.js рисует деревья силуэтами прямо в испечённый чанк: они
// дёшевы, их много, и это правильный дальний план. Но у него есть три предела,
// которые из чанка не выйти:
//   • порода одна на весь биом — «хвойное или лиственное» решает один hash2,
//     поэтому север и юг карты выглядят одинаково;
//   • картинка испечена, а значит мертва: ветер над лесом есть в погоде
//     (weather.js гоняет дождь и снег наискось), а кроны при этом стоят;
//   • ниже деревьев нет ничего — ни подлеска, ни кустов, ни следов человека,
//     хотя игра про то, как человек сводит лес и через десять эпох сажает его
//     обратно.
// Модуль добавляет ВЕРХНИЙ ярус и НИЖНИЙ: крупные деревья своей породы,
// качающиеся от ветра, и подлесок под ними. Средний ярус — тот самый ковёр
// силуэтов из terrain.js — остаётся на месте и работает дальним планом.
//
// ГРАНИЦЫ. Модуль читает симуляцию и НИЧЕГО в ней не меняет. Он не трогает
// ни renderer.js, ни terrain.js, ни weather.js: подключение описано внизу
// файла, в блоке «ПОДКЛЮЧЕНИЕ». Импорт файла не имеет побочных эффектов —
// ни одного канваса до первого кадра не печётся.
//
// СЛУЧАЙНОСТЬ. Math.random запрещён, rng ядра трогать нельзя: каждый его вызов
// сдвигает состояние симуляции, а рендер у разных игроков идёт с разной
// частотой — сейв бы поплыл. Весь разброс здесь — чистая функция координат
// (hash2/noise2 из palette.js) плюс собственный xorshift от sim.world.seed для
// того, что к клетке не привязано. Ровно так же устроены weather.js и fx.js.
//
// ЦЕНА. Бюджет модуля — 1 мс на пресете high (docs/visual-performance-budget.md
// §5.2, строка «Атмосфера»). Держится тремя вещами:
//   1) каждое растение — ОДИН drawImage испечённого спрайта; спрайт печётся
//      один раз на связку «порода × сезон × тон × форма»;
//   2) раскладка растений считается не каждый кадр, а один раз на квартал
//      8×8 клеток и кэшируется с вытеснением по LRU;
//   3) когда в кадр попадает больше растений, чем разрешает пресет, лишние
//      отбрасываются по устойчивому приоритету — не мигая и не дёргаясь.
import { TILE } from '../core/data.js';
import { TERRAIN, hash2, noise2, mixHex, shade } from './palette.js';
import { prune, canvasBytes, touch } from './quality.js';

// Мировая единица «тайл → экран» при zoom = 1. Ровно та же константа, что в
// renderer.js: она не зависит от пресета графики, и модулю нужна только чтобы
// перевести пришедший z обратно в зум для порогов LOD.
const TILE_PX = 32;

// Сторона квартала растительности. Меньше, чем чанк местности (16): раскладка
// строится лениво, и на 8×8 «промах кэша» стоит вчетверо дешевле.
export const VEG_CHUNK = 8;

// Потолки. Как и в fx.js/weather.js, это именно потолки, а не цели: столько
// растений модуль НЕ нарисует ни при каком разрешении и ни при каком зуме.
export const VEG_LIMITS = {
  items: { eco: 0, medium: 150, high: 260, ultra: 400 },  // растений в кадре
  chunks: 120,   // кварталов раскладки в кэше (8×8 клеток каждый)
  sprites: 72,   // испечённых спрайтов
  spriteMB: 8,
};

// ---------------------------------------------------------------------------
// ПОРОДЫ. Шесть осей различия на каждую (art-direction.md §7): силуэт, ширина
// кроны, посадка ствола, цвет по сезонам, гибкость на ветру, среда обитания.
// Правило то же, что для зданий: порода обязана опознаваться силуэтом, когда
// цвет уже не различим.
//
//   acc   — акцент листвы по сезонам [весна, лето, осень, зима]; у лиственных
//           зимний не используется — зимой они стоят голые.
//   bark  — цвет коры.
//   sz    — [минимальный, максимальный] размер спрайта в клетках. Ориентир
//           взят от человека: житель — 0,34 клетки, взрослое дерево 4–6 его
//           ростов, то есть 1,4–2,1 клетки (П14 из graphics-audit.md).
//   flex  — как сильно порода отзывается на ветер: тополь и берёза мотаются,
//           дуб и ель почти стоят.
//   bare  — сбрасывает ли листву зимой.
// ---------------------------------------------------------------------------
export const SPECIES = [
  { id: 'spruce', ru: 'ель',            bark: '#3f3227', acc: ['#2c5a3e', '#24513a', '#25523c', '#2a5240'], sz: [1.5, 2.2], flex: 0.35, bare: false },
  { id: 'pine',   ru: 'сосна',          bark: '#7a5230', acc: ['#43703f', '#3a6a3c', '#3d6b3e', '#3c6440'], sz: [1.5, 2.1], flex: 0.55, bare: false },
  { id: 'birch',  ru: 'берёза',         bark: '#dfe0d6', acc: ['#9ccc5c', '#7fbb4e', '#e6bb46', '#8fb060'], sz: [1.3, 1.8], flex: 1.00, bare: true },
  { id: 'oak',    ru: 'дуб',            bark: '#5a4530', acc: ['#5f9a45', '#417f36', '#b07a2e', '#4a7a44'], sz: [1.6, 2.3], flex: 0.30, bare: true },
  { id: 'maple',  ru: 'клён',           bark: '#54402e', acc: ['#74ab4e', '#589a40', '#c8482e', '#5a8a4a'], sz: [1.4, 1.9], flex: 0.70, bare: true },
  { id: 'poplar', ru: 'тополь',         bark: '#6b5a43', acc: ['#7ab04e', '#619c42', '#d8b24a', '#5f9450'], sz: [1.7, 2.4], flex: 1.10, bare: true },
  { id: 'willow', ru: 'ива',            bark: '#4f4433', acc: ['#94bc63', '#7cae55', '#c9b258', '#7a9a5c'], sz: [1.3, 1.8], flex: 1.25, bare: true },
  { id: 'palm',   ru: 'пальма',         bark: '#8a6a44', acc: ['#4f9a5c', '#489256', '#4a8f56', '#478a54'], sz: [1.5, 2.0], flex: 0.95, bare: false },
  { id: 'acacia', ru: 'акация',         bark: '#6b5a42', acc: ['#8aa055', '#7d964c', '#94914a', '#7f8f52'], sz: [1.4, 1.9], flex: 0.50, bare: false },
  { id: 'junip',  ru: 'можжевельник',   bark: '#4a3f30', acc: ['#4f6b4a', '#456245', '#4a6446', '#4c6a52'], sz: [0.7, 1.05], flex: 0.45, bare: false },
  { id: 'fruit',  ru: 'яблоня',         bark: '#5f4a34', acc: ['#e8cdd8', '#5f9a45', '#b0913a', '#54804a'], sz: [0.95, 1.3], flex: 0.80, bare: true },
  { id: 'dead',   ru: 'сухостой',       bark: '#8a8073', acc: ['#8a8073', '#8a8073', '#8a8073', '#9aa0a4'], sz: [1.2, 1.8], flex: 0.60, bare: true },
];
const SP = {};
for (let i = 0; i < SPECIES.length; i++) SP[SPECIES[i].id] = i;

// Подлесок. Всё, что ниже колена и ниже пояса: под ноги дереву, на опушку,
// на берег и на вырубку.
const U = { BUSH: 0, FERN: 1, REED: 2, FLOWER: 3, GRASS: 4, STUMP: 5, LOG: 6, SAPLING: 7, LITTER: 8 };
const UNDER_SZ = [
  [0.50, 0.80],  // куст
  [0.40, 0.58],  // папоротник
  [0.70, 0.95],  // тростник
  [0.34, 0.50],  // цветы
  [0.40, 0.62],  // высокая трава
  [0.34, 0.50],  // пень
  [0.75, 1.05],  // валежник
  [0.28, 0.44],  // поросль
  [0.60, 0.95],  // опад
];
const UNDER_FLEX = [0.45, 0.55, 1.30, 0.75, 1.00, 0, 0, 0.85, 0];

const KIND_TREE = 0, KIND_UNDER = 1;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function makeRnd(seed) {
  let s = (seed | 0) || 0x2545f491;
  return () => {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return (s >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// ЦВЕТ. Ни одного выдуманного цвета: листва — это сезонный тон леса из
// TERRAIN, смешанный с акцентом породы (art-direction.md §2.1, «никаких цветов
// в коде рендера мимо палитры»). Тон 0/1/2 — тусклый (копоть, засуха),
// обычный, сочный.
// ---------------------------------------------------------------------------
function foliage(spec, season, tone) {
  const base = TERRAIN[season][TILE.FOREST].det;
  const mid = mixHex(base, spec.acc[season], 0.74);
  const k = [-0.11, 0, 0.08][tone];
  return {
    lo: shade(mixHex(mid, '#111d15', 0.30), k),
    mid: shade(mid, k),
    hi: shade(mixHex(mid, '#eef3c4', 0.28), k + 0.05),
  };
}

// Кора зимой холоднее и темнее — то же правило, что у terrain.tree.
function barkOf(spec, season) {
  return season === 3 ? mixHex(spec.bark, '#3a4048', 0.32) : spec.bark;
}

const SNOW = 'rgba(240,246,252,0.86)';
const SNOW_SOFT = 'rgba(236,244,252,0.55)';

// ===========================================================================
// ВЫПЕЧКА СПРАЙТОВ
//
// Спрайт печётся в квадрат S×S, основание ствола — точка (S/2, S*0.88).
// В кадре рисуется как drawImage(cv, sx - d/2, sy - d*0.88, d, d), где
// d = размер в клетках × z. Значит «размер» породы — это сторона коробки, а не
// высота дерева: реальная высота выходит 0,88 от неё.
// ===========================================================================

// Сужающаяся ветка: одна кривая, толщина падает к концу. Ветки рисуются
// линиями, а не заливками, — на 40 экранных пикселях заливка неотличима, а
// стоит втрое.
function limb(c, x, y, ang, len, w, col) {
  const ex = x + Math.cos(ang) * len, ey = y + Math.sin(ang) * len;
  c.strokeStyle = col;
  c.lineWidth = w;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(x, y);
  c.quadraticCurveTo(x + Math.cos(ang) * len * 0.55 + Math.sin(ang) * len * 0.12,
    y + Math.sin(ang) * len * 0.55 - Math.cos(ang) * len * 0.12, ex, ey);
  c.stroke();
  return [ex, ey];
}

// Ствол с утолщением у корня. Один и тот же для всех лиственных: разница
// пород — в кроне и в посадке, а не в трапеции внизу.
function trunk(c, S, col, topY, wBot, wTop, lean) {
  const bx = S / 2, by = S * 0.90;
  const tx = bx + lean;
  c.fillStyle = col;
  c.beginPath();
  c.moveTo(bx - wBot, by);
  c.quadraticCurveTo(bx - wTop * 1.2, (by + topY) * 0.5, tx - wTop, topY);
  c.lineTo(tx + wTop, topY);
  c.quadraticCurveTo(bx + wTop * 1.2, (by + topY) * 0.5, bx + wBot, by);
  c.closePath();
  c.fill();
}

// Тень под кроной. Свет в игре канонически сверху-слева, значит тень —
// вправо-вниз. Печётся в спрайт: сдвиг от ветра происходит вокруг основания,
// поэтому тень при качании почти не едет.
function groundShadow(c, S, w) {
  c.fillStyle = 'rgba(18,26,16,0.28)';
  c.beginPath();
  c.ellipse(S * 0.54, S * 0.90, S * w, S * w * 0.34, 0, 0, 7);
  c.fill();
}

// Голая зимняя крона: развилка веток плюс снег на верхней стороне каждой.
// Это и есть «зима — снег на ветвях»: снежная шапка на голой кроне читается
// лучше любого белого пятна поверх листвы.
function bareCrown(c, S, col, cx, cy, r, form) {
  const n = 5 + (form & 1);
  for (let i = 0; i < n; i++) {
    const a = -Math.PI * 0.5 + (i - (n - 1) / 2) * (0.62 + form * 0.06);
    const len = r * (0.78 + ((i * 7 + form * 3) % 5) * 0.06);
    const [ex, ey] = limb(c, cx, cy, a, len, Math.max(1, S * 0.022), col);
    limb(c, ex, ey, a - 0.5, len * 0.5, Math.max(1, S * 0.013), col);
    limb(c, ex, ey, a + 0.45, len * 0.44, Math.max(1, S * 0.012), col);
  }
  // снег ложится на верхнюю сторону — те же ветки, сдвинутые вверх
  c.globalAlpha = 0.8;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI * 0.5 + (i - (n - 1) / 2) * (0.62 + form * 0.06);
    const len = r * (0.7 + ((i * 7 + form * 3) % 5) * 0.05);
    limb(c, cx, cy - S * 0.012, a, len, Math.max(1, S * 0.016), SNOW_SOFT);
  }
  c.globalAlpha = 1;
}

// Ком листвы: три перекрывающихся пятна тремя тонами. Дешевле любого шума и
// даёт объём — тёмный низ, средний корпус, светлый верх-слева.
function leafClump(c, x, y, r, F) {
  c.fillStyle = F.lo;
  c.beginPath(); c.arc(x + r * 0.22, y + r * 0.20, r * 0.86, 0, 7); c.fill();
  c.fillStyle = F.mid;
  c.beginPath(); c.arc(x - r * 0.10, y - r * 0.04, r * 0.82, 0, 7); c.fill();
  c.fillStyle = F.hi;
  c.beginPath(); c.arc(x - r * 0.34, y - r * 0.34, r * 0.46, 0, 7); c.fill();
}

// ---- породы -------------------------------------------------------------
// Каждая функция рисует ОДНО дерево в готовый контекст спрайта.

function paintSpruce(c, S, F, spec, season, form) {
  groundShadow(c, S, 0.19);
  const bark = barkOf(spec, season);
  trunk(c, S, bark, S * 0.42, S * 0.035, S * 0.022, 0);
  const tiers = 5 + (form & 1);
  const top = S * 0.10, bot = S * 0.86;
  for (let i = tiers - 1; i >= 0; i--) {
    const k = i / (tiers - 1);
    const w = S * (0.075 + k * 0.20);
    const yb = top + (bot - top) * k;
    const yt = yb - S * (0.16 + k * 0.05);
    c.fillStyle = F.lo;
    c.beginPath(); c.moveTo(S / 2, yt); c.lineTo(S / 2 + w, yb); c.lineTo(S / 2 - w, yb); c.closePath(); c.fill();
    c.fillStyle = i <= 1 ? F.hi : F.mid;
    c.beginPath(); c.moveTo(S / 2, yt); c.lineTo(S / 2 - w, yb); c.lineTo(S / 2 - w * 0.14, yb); c.closePath(); c.fill();
    if (season === 3) {
      c.fillStyle = SNOW;
      c.beginPath();
      c.moveTo(S / 2, yt + S * 0.006);
      c.lineTo(S / 2 + w * 0.52, yt + S * 0.075);
      c.lineTo(S / 2 - w * 0.52, yt + S * 0.075);
      c.closePath(); c.fill();
    }
  }
}

function paintPine(c, S, F, spec, season, form) {
  groundShadow(c, S, 0.17);
  const bark = barkOf(spec, season);
  // высокий голый ствол с лёгким изгибом — главный признак сосны
  const lean = (form ? 1 : -1) * S * 0.05;
  trunk(c, S, bark, S * 0.36, S * 0.040, S * 0.026, lean);
  const cx = S / 2 + lean, cy = S * 0.34;
  // два яруса плоских «шапок»
  for (let i = 0; i < 2; i++) {
    const w = S * (0.34 - i * 0.10), h = S * (0.12 - i * 0.02);
    const y = cy - i * S * 0.15;
    c.fillStyle = i ? F.mid : F.lo;
    c.beginPath(); c.ellipse(cx, y, w, h, 0, 0, 7); c.fill();
    c.fillStyle = F.hi;
    c.beginPath(); c.ellipse(cx - w * 0.28, y - h * 0.42, w * 0.42, h * 0.52, -0.2, 0, 7); c.fill();
  }
  if (season === 3) {
    c.fillStyle = SNOW_SOFT;
    c.beginPath(); c.ellipse(cx - S * 0.05, S * 0.16, S * 0.17, S * 0.045, -0.12, 0, 7); c.fill();
  }
}

function paintBirch(c, S, F, spec, season, form) {
  groundShadow(c, S, 0.16);
  const bark = barkOf(spec, season);
  const lean = (form ? 1 : -1) * S * 0.035;
  trunk(c, S, bark, S * 0.30, S * 0.028, S * 0.017, lean);
  // чёрные чёрточки — берёзу узнают по ним раньше, чем по кроне
  c.fillStyle = 'rgba(46,44,40,0.7)';
  for (let i = 0; i < 5; i++) {
    const y = S * (0.36 + i * 0.10), w = S * (0.020 + (i % 2) * 0.012);
    c.fillRect(S / 2 + lean * (1 - i * 0.2) - w / 2, y, w, Math.max(1, S * 0.012));
  }
  const cx = S / 2 + lean, cy = S * 0.30;
  if (season === 3) { bareCrown(c, S, bark, cx, cy + S * 0.04, S * 0.26, form); return; }
  // крона рыхлая: три пряди, а не шар — берёза сквозная
  leafClump(c, cx, cy, S * 0.19, F);
  leafClump(c, cx - S * 0.15, cy + S * 0.10, S * 0.15, F);
  leafClump(c, cx + S * 0.15, cy + S * 0.12, S * 0.14, F);
  leafClump(c, cx + S * 0.02, cy - S * 0.13, S * 0.13, F);
}

function paintOak(c, S, F, spec, season, form) {
  groundShadow(c, S, 0.22);
  const bark = barkOf(spec, season);
  trunk(c, S, bark, S * 0.46, S * 0.075, S * 0.045, 0);
  // две толстые скелетные ветви — дуб узнают по развилке
  limb(c, S / 2, S * 0.52, -Math.PI * 0.72, S * 0.20, S * 0.035, bark);
  limb(c, S / 2, S * 0.52, -Math.PI * 0.28, S * 0.19, S * 0.033, bark);
  const cx = S / 2, cy = S * 0.36;
  if (season === 3) { bareCrown(c, S, bark, cx, cy + S * 0.08, S * 0.30, form); return; }
  const w = S * (0.30 + form * 0.02);
  leafClump(c, cx - w * 0.55, cy + S * 0.06, w * 0.62, F);
  leafClump(c, cx + w * 0.58, cy + S * 0.05, w * 0.60, F);
  leafClump(c, cx + w * 0.05, cy + S * 0.12, w * 0.58, F);
  leafClump(c, cx - w * 0.12, cy - S * 0.09, w * 0.66, F);
}

function paintMaple(c, S, F, spec, season, form) {
  groundShadow(c, S, 0.19);
  const bark = barkOf(spec, season);
  trunk(c, S, bark, S * 0.44, S * 0.050, S * 0.030, 0);
  const cx = S / 2, cy = S * 0.34;
  if (season === 3) { bareCrown(c, S, bark, cx, cy + S * 0.08, S * 0.27, form); return; }
  // плотный правильный шар — клён самый «круглый» из лиственных
  c.fillStyle = F.lo;
  c.beginPath(); c.ellipse(cx + S * 0.02, cy + S * 0.03, S * 0.27, S * 0.25, 0, 0, 7); c.fill();
  c.fillStyle = F.mid;
  c.beginPath(); c.ellipse(cx - S * 0.03, cy - S * 0.01, S * 0.24, S * 0.22, 0, 0, 7); c.fill();
  c.fillStyle = F.hi;
  c.beginPath(); c.ellipse(cx - S * 0.10, cy - S * 0.09, S * 0.13, S * 0.11, -0.4, 0, 7); c.fill();
  if (season === 2) {   // осенью клён горит ярче всех — это его роль в кадре
    c.fillStyle = 'rgba(214,92,44,0.30)';
    c.beginPath(); c.ellipse(cx + S * 0.06, cy + S * 0.02, S * 0.21, S * 0.19, 0, 0, 7); c.fill();
  }
}

function paintPoplar(c, S, F, spec, season, form) {
  groundShadow(c, S, 0.13);
  const bark = barkOf(spec, season);
  trunk(c, S, bark, S * 0.20, S * 0.032, S * 0.018, 0);
  const cx = S / 2, cy = S * 0.44;
  if (season === 3) {
    // зимой тополь — метла: ветви вверх, узко
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI * 0.5 + (i - 2.5) * 0.16;
      limb(c, cx, S * 0.72, a, S * (0.40 + (i % 3) * 0.04), S * 0.016, bark);
    }
    c.globalAlpha = 0.7;
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI * 0.5 + (i - 2.5) * 0.16;
      limb(c, cx, S * 0.70, a, S * 0.34, S * 0.012, SNOW_SOFT);
    }
    c.globalAlpha = 1;
    return;
  }
  // столб: узкая высокая крона, признак читается за километр
  const w = S * (0.135 + form * 0.012);
  c.fillStyle = F.lo;
  c.beginPath(); c.ellipse(cx + S * 0.012, cy, w, S * 0.36, 0, 0, 7); c.fill();
  c.fillStyle = F.mid;
  c.beginPath(); c.ellipse(cx - S * 0.012, cy - S * 0.01, w * 0.82, S * 0.33, 0, 0, 7); c.fill();
  c.fillStyle = F.hi;
  c.beginPath(); c.ellipse(cx - w * 0.42, cy - S * 0.12, w * 0.42, S * 0.16, 0, 0, 7); c.fill();
}

function paintWillow(c, S, F, spec, season, form) {
  groundShadow(c, S, 0.20);
  const bark = barkOf(spec, season);
  trunk(c, S, bark, S * 0.52, S * 0.055, S * 0.038, 0);
  const cx = S / 2, cy = S * 0.44;
  if (season === 3) { bareCrown(c, S, bark, cx, cy + S * 0.06, S * 0.24, form); return; }
  c.fillStyle = F.lo;
  c.beginPath(); c.ellipse(cx, cy, S * 0.28, S * 0.16, 0, 0, 7); c.fill();
  c.fillStyle = F.mid;
  c.beginPath(); c.ellipse(cx - S * 0.02, cy - S * 0.03, S * 0.25, S * 0.14, 0, 0, 7); c.fill();
  // плакучие пряди — то, из-за чего иву узнают мгновенно
  c.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const t = (i - 3) / 3;
    const x = cx + t * S * 0.26;
    const len = S * (0.20 + (1 - Math.abs(t)) * 0.16 + ((i * 5 + form) % 3) * 0.015);
    c.strokeStyle = i % 2 ? F.mid : F.hi;
    c.lineWidth = Math.max(1, S * 0.018);
    c.beginPath();
    c.moveTo(x, cy + S * 0.06);
    c.quadraticCurveTo(x + t * S * 0.05, cy + len * 0.6, x + t * S * 0.09, cy + len);
    c.stroke();
  }
}

function paintPalm(c, S, F, spec, season, form) {
  groundShadow(c, S, 0.17);
  const bark = barkOf(spec, season);
  const dir = form ? 1 : -1;
  // изогнутый ствол с кольцами
  c.strokeStyle = bark;
  c.lineWidth = S * 0.055;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(S / 2, S * 0.90);
  c.quadraticCurveTo(S / 2 + dir * S * 0.10, S * 0.60, S / 2 + dir * S * 0.09, S * 0.34);
  c.stroke();
  c.strokeStyle = 'rgba(60,44,28,0.35)';
  c.lineWidth = Math.max(1, S * 0.012);
  for (let i = 0; i < 5; i++) {
    const t = 0.25 + i * 0.14;
    const x = S / 2 + dir * S * 0.10 * (1 - (1 - t) * (1 - t)), y = S * (0.90 - t * 0.52);
    c.beginPath(); c.moveTo(x - S * 0.028, y); c.lineTo(x + S * 0.028, y); c.stroke();
  }
  // листья: шесть широких перьев веером
  const cx = S / 2 + dir * S * 0.09, cy = S * 0.32;
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI * 0.5 + (i - 2.5) * 0.55 + dir * 0.1;
    const len = S * (0.28 + (i % 2) * 0.05);
    c.fillStyle = i % 2 ? F.mid : F.lo;
    c.beginPath();
    c.moveTo(cx, cy);
    c.quadraticCurveTo(cx + Math.cos(a) * len * 0.6 - Math.sin(a) * S * 0.08,
      cy + Math.sin(a) * len * 0.6 + Math.cos(a) * S * 0.08,
      cx + Math.cos(a) * len, cy + Math.sin(a) * len + S * 0.05);
    c.quadraticCurveTo(cx + Math.cos(a) * len * 0.55 + Math.sin(a) * S * 0.05,
      cy + Math.sin(a) * len * 0.55 - Math.cos(a) * S * 0.05, cx, cy);
    c.fill();
  }
  c.fillStyle = F.hi;
  c.beginPath(); c.arc(cx, cy, S * 0.045, 0, 7); c.fill();
}

function paintAcacia(c, S, F, spec, season, form) {
  groundShadow(c, S, 0.22);
  const bark = barkOf(spec, season);
  trunk(c, S, bark, S * 0.50, S * 0.048, S * 0.026, 0);
  limb(c, S / 2, S * 0.56, -Math.PI * 0.78, S * 0.22, S * 0.024, bark);
  limb(c, S / 2, S * 0.56, -Math.PI * 0.22, S * 0.22, S * 0.024, bark);
  // плоский зонт — силуэт саванны, ни с чем не спутать
  const cy = S * 0.34 + form * S * 0.01;
  c.fillStyle = F.lo;
  c.beginPath(); c.ellipse(S / 2, cy + S * 0.03, S * 0.36, S * 0.085, 0, 0, 7); c.fill();
  c.fillStyle = F.mid;
  c.beginPath(); c.ellipse(S / 2, cy, S * 0.33, S * 0.070, 0, 0, 7); c.fill();
  c.fillStyle = F.hi;
  c.beginPath(); c.ellipse(S / 2 - S * 0.09, cy - S * 0.025, S * 0.14, S * 0.035, 0, 0, 7); c.fill();
}

function paintJuniper(c, S, F, spec, season, form) {
  groundShadow(c, S, 0.20);
  // низкий раскидистый куст-дерево склонов: почти без ствола
  const bark = barkOf(spec, season);
  trunk(c, S, bark, S * 0.62, S * 0.035, S * 0.024, 0);
  const cy = S * 0.58;
  for (let i = 0; i < 4; i++) {
    const a = -Math.PI * 0.5 + (i - 1.5) * (0.52 + form * 0.05);
    const len = S * (0.24 + (i % 2) * 0.05);
    c.fillStyle = i % 2 ? F.mid : F.lo;
    c.beginPath();
    c.ellipse(S / 2 + Math.cos(a) * len * 0.6, cy + Math.sin(a) * len * 0.6,
      len * 0.44, len * 0.30, a, 0, 7);
    c.fill();
  }
  c.fillStyle = F.hi;
  c.beginPath(); c.ellipse(S / 2 - S * 0.06, cy - S * 0.14, S * 0.10, S * 0.07, -0.3, 0, 7); c.fill();
  if (season === 3) {
    c.fillStyle = SNOW_SOFT;
    c.beginPath(); c.ellipse(S / 2 - S * 0.02, cy - S * 0.16, S * 0.16, S * 0.045, -0.1, 0, 7); c.fill();
  }
}

function paintFruit(c, S, F, spec, season, form) {
  groundShadow(c, S, 0.17);
  const bark = barkOf(spec, season);
  trunk(c, S, bark, S * 0.52, S * 0.045, S * 0.028, 0);
  const cx = S / 2, cy = S * 0.42;
  if (season === 3) { bareCrown(c, S, bark, cx, cy + S * 0.08, S * 0.22, form); return; }
  c.fillStyle = F.lo;
  c.beginPath(); c.ellipse(cx + S * 0.02, cy + S * 0.03, S * 0.24, S * 0.21, 0, 0, 7); c.fill();
  c.fillStyle = F.mid;
  c.beginPath(); c.ellipse(cx - S * 0.02, cy, S * 0.21, S * 0.19, 0, 0, 7); c.fill();
  if (season === 0) {
    // весенний цвет — единственное место, где растительность берёт розовое
    c.fillStyle = 'rgba(246,214,226,0.85)';
    for (let i = 0; i < 9; i++) {
      const a = i * 0.7 + form, rr = S * (0.06 + (i % 3) * 0.05);
      c.beginPath(); c.arc(cx + Math.cos(a) * rr * 2.4, cy + Math.sin(a) * rr * 2.0, S * 0.030, 0, 7); c.fill();
    }
  } else if (season === 2) {
    c.fillStyle = '#c34a32';
    for (let i = 0; i < 5; i++) {
      const a = i * 1.25 + form;
      c.beginPath(); c.arc(cx + Math.cos(a) * S * 0.13, cy + Math.sin(a) * S * 0.11, S * 0.026, 0, 7); c.fill();
    }
  }
  c.fillStyle = F.hi;
  c.beginPath(); c.ellipse(cx - S * 0.09, cy - S * 0.08, S * 0.09, S * 0.07, -0.4, 0, 7); c.fill();
}

function paintDead(c, S, F, spec, season, form) {
  groundShadow(c, S, 0.14);
  const bark = season === 3 ? '#9aa0a4' : '#8a8073';
  trunk(c, S, bark, S * 0.24, S * 0.038, S * 0.016, form ? S * 0.03 : -S * 0.03);
  for (let i = 0; i < 4; i++) {
    const a = -Math.PI * 0.5 + (i - 1.5) * 0.85;
    const y = S * (0.36 + i * 0.10);
    const [ex, ey] = limb(c, S / 2, y, a, S * (0.16 + (i % 2) * 0.05), S * 0.018, bark);
    limb(c, ex, ey, a - 0.6, S * 0.07, S * 0.011, bark);
  }
  if (season === 3) {
    c.globalAlpha = 0.7;
    for (let i = 0; i < 4; i++) {
      const a = -Math.PI * 0.5 + (i - 1.5) * 0.85;
      limb(c, S / 2, S * (0.36 + i * 0.10) - S * 0.01, a, S * 0.13, S * 0.012, SNOW_SOFT);
    }
    c.globalAlpha = 1;
  }
}

const PAINT = [paintSpruce, paintPine, paintBirch, paintOak, paintMaple, paintPoplar,
  paintWillow, paintPalm, paintAcacia, paintJuniper, paintFruit, paintDead];

// ---- подлесок ------------------------------------------------------------

function paintBush(c, S, F, season, form) {
  c.fillStyle = 'rgba(18,26,16,0.24)';
  c.beginPath(); c.ellipse(S * 0.54, S * 0.88, S * 0.26, S * 0.08, 0, 0, 7); c.fill();
  if (season === 3) {
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI * 0.5 + (i - 2.5) * 0.28;
      limb(c, S / 2, S * 0.88, a, S * 0.26, Math.max(1, S * 0.022), '#6b6055');
    }
    c.fillStyle = SNOW;
    c.beginPath(); c.ellipse(S / 2, S * 0.68, S * 0.24, S * 0.08, 0, 0, 7); c.fill();
    return;
  }
  const cy = S * 0.68;
  c.fillStyle = F.lo;
  c.beginPath(); c.ellipse(S / 2 + S * 0.04, cy + S * 0.06, S * 0.28, S * 0.20, 0, 0, 7); c.fill();
  c.fillStyle = F.mid;
  c.beginPath(); c.ellipse(S / 2 - S * 0.10, cy, S * 0.20, S * 0.17, 0, 0, 7); c.fill();
  c.beginPath(); c.ellipse(S / 2 + S * 0.13, cy - S * 0.02, S * 0.17, S * 0.15, 0, 0, 7); c.fill();
  c.fillStyle = F.hi;
  c.beginPath(); c.ellipse(S / 2 - S * 0.14, cy - S * 0.09, S * 0.10, S * 0.08, -0.4, 0, 7); c.fill();
  // ягоды на кусте — только летом и осенью, и только у второй формы
  if (form && season >= 1 && season <= 2) {
    c.fillStyle = season === 2 ? '#b8342c' : '#8e2f3c';
    for (let i = 0; i < 5; i++) {
      const a = i * 1.3;
      c.beginPath(); c.arc(S / 2 + Math.cos(a) * S * 0.16, cy + Math.sin(a) * S * 0.12, S * 0.026, 0, 7); c.fill();
    }
  }
}

function paintFern(c, S, F, season, form) {
  const cy = S * 0.86;
  const n = 5 + (form & 1);
  for (let i = 0; i < n; i++) {
    const a = -Math.PI * 0.5 + (i - (n - 1) / 2) * 0.42;
    const len = S * (0.34 + (i % 2) * 0.06);
    c.strokeStyle = i % 2 ? F.mid : F.lo;
    c.lineWidth = Math.max(1, S * 0.034);
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(S / 2, cy);
    c.quadraticCurveTo(S / 2 + Math.cos(a) * len * 0.5, cy + Math.sin(a) * len * 0.75,
      S / 2 + Math.cos(a) * len * 1.05, cy + Math.sin(a) * len * 0.72);
    c.stroke();
  }
  if (season === 3) {
    c.fillStyle = SNOW_SOFT;
    c.beginPath(); c.ellipse(S / 2, cy - S * 0.16, S * 0.22, S * 0.06, 0, 0, 7); c.fill();
  }
}

function paintReed(c, S, F, season, form) {
  const cy = S * 0.92;
  const dry = season >= 2;
  const stalk = dry ? '#b39a5e' : F.mid;
  const head = dry ? '#7a5a34' : '#6b5a3a';
  c.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const t = (i - 2.5) / 2.5;
    const x = S / 2 + t * S * 0.22;
    const h = S * (0.52 + (1 - Math.abs(t)) * 0.22 + ((i * 3 + form) % 3) * 0.03);
    c.strokeStyle = stalk;
    c.lineWidth = Math.max(1, S * 0.026);
    c.beginPath();
    c.moveTo(x, cy);
    c.quadraticCurveTo(x + t * S * 0.05, cy - h * 0.6, x + t * S * 0.10, cy - h);
    c.stroke();
    if (i % 2 === 0) {   // початки не у каждого стебля — иначе выходит гребёнка
      c.strokeStyle = head;
      c.lineWidth = S * 0.05;
      c.beginPath();
      c.moveTo(x + t * S * 0.10, cy - h);
      c.lineTo(x + t * S * 0.11, cy - h + S * 0.12);
      c.stroke();
    }
  }
}

function paintFlower(c, S, F, season, form) {
  const cy = S * 0.88;
  // стебли
  c.strokeStyle = F.mid;
  c.lineWidth = Math.max(1, S * 0.022);
  c.lineCap = 'round';
  const cols = season === 0
    ? ['#f2e58c', '#f7f4ea', '#e8a8c4', '#b9a8e0']    // весна — вся палитра
    : ['#f0dc72', '#f2efdf', '#d99ab4'];              // лето — выгорает
  const n = 5 + (form & 1) * 2;
  for (let i = 0; i < n; i++) {
    const t = (i - (n - 1) / 2) / ((n - 1) / 2);
    const x = S / 2 + t * S * 0.30;
    const h = S * (0.22 + (1 - Math.abs(t)) * 0.14);
    c.beginPath();
    c.moveTo(x, cy);
    c.quadraticCurveTo(x + t * S * 0.03, cy - h * 0.6, x + t * S * 0.05, cy - h);
    c.stroke();
    const col = cols[(i + form) % cols.length];
    c.fillStyle = col;
    const fx = x + t * S * 0.05, fy = cy - h;
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + 0.4;
      c.beginPath(); c.arc(fx + Math.cos(a) * S * 0.030, fy + Math.sin(a) * S * 0.030, S * 0.030, 0, 7); c.fill();
    }
    c.fillStyle = '#e0b23c';
    c.beginPath(); c.arc(fx, fy, S * 0.022, 0, 7); c.fill();
  }
}

function paintGrassTuft(c, S, F, season, form) {
  const cy = S * 0.90;
  const dry = season === 2;
  c.lineCap = 'round';
  const n = 7 + (form & 1) * 2;
  for (let i = 0; i < n; i++) {
    const t = (i - (n - 1) / 2) / ((n - 1) / 2);
    const h = S * (0.34 + (1 - Math.abs(t)) * 0.22);
    c.strokeStyle = season === 3 ? '#c8d2cc' : dry ? (i % 2 ? '#c2a655' : '#a88c44') : (i % 2 ? F.hi : F.mid);
    c.lineWidth = Math.max(1, S * 0.030);
    c.beginPath();
    c.moveTo(S / 2 + t * S * 0.06, cy);
    c.quadraticCurveTo(S / 2 + t * S * 0.20, cy - h * 0.65, S / 2 + t * S * 0.36, cy - h);
    c.stroke();
  }
}

function paintStump(c, S, F, season, form) {
  c.fillStyle = 'rgba(18,26,16,0.26)';
  c.beginPath(); c.ellipse(S * 0.56, S * 0.90, S * 0.24, S * 0.07, 0, 0, 7); c.fill();
  const side = '#54402c', top = '#a88254', ring = '#7d5f3c';
  const w = S * 0.20, h = S * 0.20, cy = S * 0.86;
  c.fillStyle = side;
  c.beginPath();
  c.moveTo(S / 2 - w, cy - h); c.lineTo(S / 2 - w, cy); c.lineTo(S / 2 + w, cy); c.lineTo(S / 2 + w, cy - h);
  c.closePath(); c.fill();
  c.fillStyle = top;
  c.beginPath(); c.ellipse(S / 2, cy - h, w, w * 0.42, 0, 0, 7); c.fill();
  c.strokeStyle = ring;
  c.lineWidth = Math.max(1, S * 0.018);
  for (let i = 1; i <= 2; i++) {
    c.beginPath(); c.ellipse(S / 2, cy - h, w * (i / 3), w * 0.42 * (i / 3), 0, 0, 7); c.stroke();
  }
  // щепа вокруг: след топора, а не аккуратная тумбочка
  c.fillStyle = 'rgba(160,124,74,0.75)';
  for (let i = 0; i < 4; i++) {
    const a = i * 1.6 + form;
    c.save();
    c.translate(S / 2 + Math.cos(a) * S * 0.30, cy + Math.sin(a) * S * 0.05 + S * 0.02);
    c.rotate(a);
    c.fillRect(-S * 0.045, -S * 0.012, S * 0.09, S * 0.024);
    c.restore();
  }
  if (season === 3) {
    c.fillStyle = SNOW;
    c.beginPath(); c.ellipse(S / 2, cy - h - S * 0.012, w * 0.92, w * 0.38, 0, 0, 7); c.fill();
  }
}

function paintLog(c, S, F, season, form) {
  c.fillStyle = 'rgba(18,26,16,0.22)';
  c.beginPath(); c.ellipse(S * 0.52, S * 0.90, S * 0.34, S * 0.07, 0, 0, 7); c.fill();
  const cy = S * 0.82, len = S * 0.66, r = S * 0.085;
  c.fillStyle = '#5c4630';
  c.beginPath();
  c.moveTo(S / 2 - len / 2, cy - r); c.lineTo(S / 2 + len / 2, cy - r);
  c.lineTo(S / 2 + len / 2, cy + r); c.lineTo(S / 2 - len / 2, cy + r);
  c.closePath(); c.fill();
  c.fillStyle = '#6f5539';
  c.fillRect(S / 2 - len / 2, cy - r, len, r * 0.7);
  c.fillStyle = '#a88254';
  c.beginPath(); c.ellipse(S / 2 + len / 2, cy, r * 0.38, r, 0, 0, 7); c.fill();
  if (form) {   // мох на северной стороне — валежник не бывает чистым
    c.fillStyle = season === 3 ? SNOW_SOFT : 'rgba(96,132,72,0.55)';
    c.beginPath(); c.ellipse(S / 2 - len * 0.15, cy - r * 0.7, len * 0.22, r * 0.34, 0, 0, 7); c.fill();
  }
}

function paintSapling(c, S, F, season, form) {
  const cy = S * 0.90;
  c.strokeStyle = season === 3 ? '#6b6055' : '#6f5a3c';
  c.lineWidth = Math.max(1, S * 0.030);
  c.lineCap = 'round';
  c.beginPath(); c.moveTo(S / 2, cy); c.lineTo(S / 2 + (form ? S * 0.02 : -S * 0.02), cy - S * 0.34); c.stroke();
  if (season === 3) return;
  c.fillStyle = F.mid;
  for (let i = 0; i < 4; i++) {
    const a = -Math.PI * 0.5 + (i - 1.5) * 0.7;
    c.beginPath();
    c.ellipse(S / 2 + Math.cos(a) * S * 0.11, cy - S * 0.28 + Math.sin(a) * S * 0.06,
      S * 0.075, S * 0.035, a, 0, 7);
    c.fill();
  }
  c.fillStyle = F.hi;
  c.beginPath(); c.ellipse(S / 2 - S * 0.05, cy - S * 0.33, S * 0.045, S * 0.022, -0.5, 0, 7); c.fill();
}

function paintLitter(c, S, F, season, form) {
  // Опад под лиственными. Осенью — золото, весной — прошлогодний бурый,
  // зимой не рисуется вовсе (его засыпает).
  const cols = season === 2
    ? ['rgba(198,132,42,0.55)', 'rgba(168,84,40,0.50)', 'rgba(214,168,60,0.45)']
    : ['rgba(120,96,58,0.35)', 'rgba(96,84,52,0.30)'];
  for (let i = 0; i < 12; i++) {
    const a = i * 2.39 + form;                 // золотой угол — пятна не в ряд
    const rr = S * 0.06 * Math.sqrt(i + 1);
    c.fillStyle = cols[i % cols.length];
    c.beginPath();
    c.ellipse(S / 2 + Math.cos(a) * rr, S * 0.84 + Math.sin(a) * rr * 0.42,
      S * 0.045, S * 0.026, a, 0, 7);
    c.fill();
  }
}

const PAINT_U = [paintBush, paintFern, paintReed, paintFlower, paintGrassTuft,
  paintStump, paintLog, paintSapling, paintLitter];

// ===========================================================================
// КЛИМАТ. Породы должны меняться по карте, а в ядре нет ни температуры, ни
// влажности — worldgen хранит только тип клетки. Поэтому оба поля выводятся
// прямо из координат, детерминированно и без единого байта состояния:
//   тепло  — юг карты теплее севера, плюс крупные пятна шума, минус высота;
//   влага  — независимое поле шума: у воды ивы и тростник, в сухом сосна.
// Игрок этого правила не читает словами, но видит: на севере тайга, в центре
// смешанный лес, на юге акация и пальма у песка.
// ===========================================================================
function warmthAt(world, x, y, tile) {
  const lat = y / Math.max(1, world.h - 1);
  const n = noise2(x * 0.055 + 13.7, y * 0.055 + 41.3);
  const hi = tile === TILE.MOUNTAIN ? 0.34 : tile === TILE.HILL ? 0.13 : 0;
  return clamp01(lat * 0.86 + (n - 0.5) * 0.62 + 0.07 - hi);
}
function moistAt(x, y) {
  return noise2(x * 0.07 + 77.3, y * 0.07 + 31.9);
}

// Взвешенный выбор породы. weights — плоский массив [индекс, вес, ...].
function pick(r, weights) {
  let sum = 0;
  for (let i = 1; i < weights.length; i += 2) sum += weights[i];
  let t = r * sum;
  for (let i = 0; i < weights.length; i += 2) {
    t -= weights[i + 1];
    if (t <= 0) return weights[i];
  }
  return weights[0];
}

// ===========================================================================
export class Vegetation {
  constructor(quality) {
    this.q = quality || { id: 'high', detail: 2, ambientProps: true, lod: { propsMinZoom: 0.8 }, caps: { chunksPerFrame: 12 } };
    this.off = this.q.id === 'eco';

    this.time = 0;
    this.wind = -0.3;      // доля сноса, как в weather.js: минус — влево
    this.gust = 0;         // огибающая порыва 0..1
    this.rnd = makeRnd(0x7f4a7c15);
    this.seeded = false;

    // Доля клеток леса, получающих КРУПНОЕ дерево верхнего яруса. Мелкие
    // силуэты terrain.js остаются под ними всегда. Ставьте 0, если после
    // подключения лес кажется перенаселённым, — опушки при этом останутся.
    this.forestFill = 0.55;
    this.edgeFill = 0.82;    // опушка гуще: там лес и виден

    this.chunks = new Map();   // "cx,cy" → массив растений, отсортированный по y
    this.sprites = new Map();  // ключ → канвас
    this.key = null;           // подпись мира: сид, сезон, эпоха, состав построек
    this.block = null;         // Set индексов клеток под постройками
    this.roads = null;         // Set индексов клеток дороги (даёт renderer)
    this.press = null;         // грубое поле «давления цивилизации»
    this.pw = 0; this.ph = 0;

    this._vis = [];            // буфер видимых кварталов, переиспользуется
    this._m = null;            // базовая матрица кадра
    this.drawn = 0;            // сколько растений нарисовано в прошлом кадре
  }

  setQuality(q) {
    this.q = q;
    this.off = q.id === 'eco';
    this.sprites.clear();      // размер выпечки зависит от пресета
    this.chunks.clear();       // плотность подлеска — тоже
  }

  clear() {
    this.chunks.clear();
    this.key = null;
    this.block = null;
    this.press = null;
  }

  invalidate() { this.chunks.clear(); this.key = null; }

  // ---- сторона выпечки спрайта ------------------------------------------
  get treePx() { return this.q.detail >= 2 ? 96 : 72; }
  get underPx() { return this.q.detail >= 2 ? 48 : 36; }

  // =========================================================================
  // ОБНОВЛЕНИЕ. Один вызов за кадр, до отрисовки. Здесь только ветер и
  // проверка «не изменился ли мир»; раскладка растений строится лениво.
  //
  // opts.wind  — ветер из погоды (renderer.atmo.wind). Если не передан,
  //              считается тем же правилом, что в weather.js: одни сутки —
  //              одно направление. Так модуль работает и в одиночку.
  // opts.roads — множество клеток дороги (renderer.terrain.road.tiles):
  //              на полотне дороги ничего не растёт.
  // =========================================================================
  update(sim, dt, ox, oy, z, cw, ch, opts) {
    if (!sim || !sim.world) return;
    if (!this.seeded) { this.rnd = makeRnd(((sim.world.seed) | 0) || 20250808); this.seeded = true; }
    dt = Math.min(0.05, Math.max(0, dt || 0));   // вкладка была свёрнута
    this.time += dt;

    const wantWind = opts && typeof opts.wind === 'number'
      ? opts.wind
      : -0.72 + hash2(sim.day | 0, sim.seasonIdx | 0) * 1.16;
    this.wind += (wantWind - this.wind) * Math.min(1, dt * 0.6);

    // Порыв. Ветер в кронах не ровный: волна набегает и отпускает. Две
    // несоизмеримые частоты дают неповторяющийся ритм без единого случайного
    // числа в кадре.
    this.gust = 0.62 + 0.26 * Math.sin(this.time * 0.41) + 0.12 * Math.sin(this.time * 1.07 + 1.3);

    const roads = opts && opts.roads ? opts.roads : null;
    if (roads !== this.roads) { this.roads = roads; this.chunks.clear(); }

    if (this.off) return;

    // Подпись мира. Меняется сезон, эпоха или состав построек — раскладка
    // пересобирается: осенью зацветать нечему, а на месте новой фермы лес
    // сведён.
    const nb = sim.buildings ? sim.buildings.length : 0;
    const key = `${sim.world.seed}|${sim.seasonIdx}|${sim.eraIndex}|${nb}`;
    if (key !== this.key) {
      this.key = key;
      this.buildPressure(sim);
      this.chunks.clear();
    }
  }

  // ---- давление цивилизации ---------------------------------------------
  // Грубая сетка 4×4 клетки. Считается только при смене подписи мира, то есть
  // на постройке здания или на новом сезоне, — в кадре не стоит ничего.
  //
  // Смысл поля: где человек уже забрал лес. Лесопилка сводит лес вокруг себя,
  // ферма расчищает поле, фабрика травит копотью, жильё просто вытаптывает.
  // Эпоха задаёт общий множитель: в каменном веке следов почти нет, пик — на
  // индустрии, а к цифровой и будущему город снова зарастает (art-direction.md
  // §4, эпоха 9: «вокруг города возвращается лес»).
  buildPressure(sim) {
    const W = sim.world.w, H = sim.world.h;
    const S = 4;
    this.pw = Math.ceil(W / S); this.ph = Math.ceil(H / S);
    const g = new Float32Array(this.pw * this.ph);

    const eraMul = [0.30, 0.42, 0.58, 0.70, 0.82, 0.92, 1.00, 0.98, 0.66, 0.40];
    const em = eraMul[clamp(sim.eraIndex | 0, 0, 9)];

    const weightOf = (id) => {
      if (id === 'lumber') return 1.25;             // вырубка — прямая
      if (id === 'farm' || id === 'pasture') return 0.85;
      if (id === 'factory' || id === 'workshop' || id === 'foundry' || id === 'power_plant' || id === 'npp') return 0.95;
      if (id === 'quarry' || id === 'mine') return 0.55;
      return 0.45;
    };

    const blk = new Set();
    for (const b of (sim.buildings || [])) {
      if (b.destroyed) continue;
      const sz = b.size || 1;
      for (let dy = 0; dy < sz; dy++) {
        for (let dx = 0; dx < sz; dx++) {
          const xx = (b.x | 0) + dx, yy = (b.y | 0) + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H) blk.add(yy * W + xx);
        }
      }
      const w = weightOf(b.id) * em;
      const R = 6;                                   // радиус влияния в клетках
      const gx = (b.x + sz * 0.5) / S, gy = (b.y + sz * 0.5) / S;
      const gr = R / S;
      const x0 = Math.max(0, Math.floor(gx - gr)), x1 = Math.min(this.pw - 1, Math.ceil(gx + gr));
      const y0 = Math.max(0, Math.floor(gy - gr)), y1 = Math.min(this.ph - 1, Math.ceil(gy + gr));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x + 0.5 - gx, y + 0.5 - gy) / gr;
          if (d >= 1) continue;
          g[y * this.pw + x] += w * (1 - d) * (1 - d);
        }
      }
    }
    this.press = g;
    this.block = blk;
  }

  pressureAt(x, y) {
    if (!this.press) return 0;
    const gx = clamp(x >> 2, 0, this.pw - 1), gy = clamp(y >> 2, 0, this.ph - 1);
    // Шум размывает границу: без него вырубка обрывается по сетке 4×4.
    return clamp01(this.press[gy * this.pw + gx] + (noise2(x * 0.3, y * 0.3) - 0.5) * 0.22);
  }

  // =========================================================================
  // РАСКЛАДКА КВАРТАЛА 8×8. Считается один раз и живёт в кэше. Всё, что здесь
  // выбирается, — чистая функция координат: одинаковый мир у всех игроков и
  // на всех перезапусках.
  // =========================================================================
  chunkAt(sim, cx, cy) {
    const k = cx + ',' + cy;
    const got = this.chunks.get(k);
    if (got) { touch(this.chunks, k); return got; }
    return null;
  }

  buildChunk(sim, cx, cy) {
    const world = sim.world, W = world.w, H = world.h;
    const season = sim.seasonIdx | 0, era = clamp(sim.eraIndex | 0, 0, 9);
    const D = this.q.detail;
    const items = [];

    const tile = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? TILE.DEEP : world.tiles[y * W + x];
    const nearWater = (x, y) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const t = tile(x + dx, y + dy);
        if (t === TILE.WATER || t === TILE.DEEP) return true;
      }
      return false;
    };

    const x0 = cx * VEG_CHUNK, y0 = cy * VEG_CHUNK;
    for (let ty = y0; ty < y0 + VEG_CHUNK; ty++) {
      if (ty < 0 || ty >= H) continue;
      for (let tx = x0; tx < x0 + VEG_CHUNK; tx++) {
        if (tx < 0 || tx >= W) continue;
        const idx = ty * W + tx;
        if (this.block && this.block.has(idx)) continue;      // под зданием
        if (this.roads && this.roads.has(idx)) continue;      // на дороге

        const t = world.tiles[idx];
        if (t === TILE.WATER || t === TILE.DEEP) continue;

        const p = this.pressureAt(tx, ty);
        const warm = warmthAt(world, tx, ty, t);
        const wet = moistAt(tx, ty);
        const water = nearWater(tx, ty);
        this.tileItems(items, sim, world, tx, ty, t, season, era, D, p, warm, wet, water, tile);
      }
    }

    // Порядок в квартале — по глубине: что ниже, то ближе к камере и рисуется
    // позже. Дерево при равном y идёт после подлеска, иначе куст ложится
    // поверх собственного ствола.
    items.sort((a, b) => (a.y + (a.k === KIND_TREE ? 0.02 : 0)) - (b.y + (b.k === KIND_TREE ? 0.02 : 0)));

    const key = cx + ',' + cy;
    this.chunks.set(key, items);
    prune(this.chunks, { maxEntries: VEG_LIMITS.chunks });
    return items;
  }

  // ---- что растёт на одной клетке ---------------------------------------
  tileItems(out, sim, world, x, y, t, season, era, D, p, warm, wet, water, tile) {
    const r1 = hash2(x * 7 + 1, y * 11 + 3);
    const r2 = hash2(x * 13 + 91, y * 5 + 47);
    const r3 = hash2(x * 3 + 511, y * 29 + 17);
    const r4 = hash2(x * 23 + 7, y * 19 + 331);

    if (t === TILE.FOREST) {
      // опушка — клетка леса, у которой есть не-лесной сосед по стороне
      const edge = tile(x + 1, y) !== TILE.FOREST || tile(x - 1, y) !== TILE.FOREST
        || tile(x, y + 1) !== TILE.FOREST || tile(x, y - 1) !== TILE.FOREST;
      const want = (edge ? this.edgeFill : this.forestFill) * (1 - 0.72 * p);
      if (r1 < want) {
        this.addTree(out, x, y, this.forestSpecies(r2, warm, wet, water, era, p), season, era, p, r2, r3);
        // на опушке второе дерево: край леса всегда гуще середины
        if (edge && D >= 2 && r4 < 0.34) {
          this.addTree(out, x + 0.42, y + 0.30, this.forestSpecies(r4, warm, wet, water, era, p), season, era, p, r4, r1);
        }
      } else if (r3 < 0.14 + 0.55 * p) {
        // дерева нет — на его месте пень: лес свели, а корень остался
        this.addUnder(out, x, y, U.STUMP, season, r3, r1);
        if (r4 < 0.35 && p > 0.28) this.addUnder(out, x + 0.30, y + 0.22, U.SAPLING, season, r4, r2);
      }
      if (D >= 1 && r2 < 0.34) this.addUnder(out, x + 0.18, y + 0.44, U.FERN, season, r2, r3);
      if (D >= 1 && r4 < 0.22) this.addUnder(out, x + 0.62, y + 0.26, U.BUSH, season, r4, r1);
      if (D >= 2 && season !== 3 && r3 > 0.78) this.addUnder(out, x + 0.40, y + 0.60, U.LITTER, season, r3, r4);
      if (D >= 2 && r1 > 0.94) this.addUnder(out, x + 0.55, y + 0.70, U.LOG, season, r1, r2);
      return;
    }

    if (t === TILE.GRASS) {
      // одиночные деревья: там, где влажнее, их больше; у города — меньше
      const want = (0.05 + wet * 0.12) * (1 - 0.82 * p);
      if (r1 < want) {
        this.addTree(out, x, y, this.openSpecies(r2, warm, wet, water, era, p), season, era, p, r2, r3);
      } else if (p > 0.30 && r3 < 0.10 * p) {
        this.addUnder(out, x, y, U.STUMP, season, r3, r1);
      }
      if (water && r2 < 0.42) this.addUnder(out, x + 0.30, y + 0.55, U.REED, season, r2, r4);
      if (D >= 1 && r4 < 0.15) this.addUnder(out, x + 0.55, y + 0.35, U.BUSH, season, r4, r1);
      if (D >= 2 && r3 < 0.30) this.addUnder(out, x + 0.22, y + 0.62, U.GRASS, season, r3, r2);
      // Цветы — весной и летом. Ближе к городу их больше в позднюю эпоху
      // (клумбы) и меньше в индустриальную (вытоптано и закопчено).
      if (season < 2 && D >= 1) {
        const fl = 0.16 + wet * 0.14 + (era >= 8 ? p * 0.30 : -p * 0.10);
        if (r2 < fl) this.addUnder(out, x + 0.66, y + 0.52, U.FLOWER, season, r2, r3);
      }
      return;
    }

    if (t === TILE.HILL) {
      const want = 0.10 * (1 - 0.6 * p);
      if (r1 < want) {
        const sp = warm < 0.42 ? (r2 < 0.6 ? SP.spruce : SP.pine) : (r2 < 0.5 ? SP.junip : SP.pine);
        this.addTree(out, x, y, sp, season, era, p, r2, r3);
      }
      if (D >= 1 && r3 < 0.20) this.addUnder(out, x + 0.45, y + 0.40, U.BUSH, season, r3, r1);
      if (D >= 2 && r4 < 0.22) this.addUnder(out, x + 0.25, y + 0.66, U.GRASS, season, r4, r2);
      if (D >= 2 && season < 2 && r2 > 0.90) this.addUnder(out, x + 0.60, y + 0.30, U.FLOWER, season, r2, r4);
      return;
    }

    if (t === TILE.SAND) {
      // пальма только там, где тепло и есть вода: пальма посреди северной
      // отмели — самая заметная ошибка биома
      if (water && warm > 0.55 && r1 < 0.14) {
        this.addTree(out, x, y, SP.palm, season, era, p, r2, r3);
      } else if (water && warm <= 0.55 && r1 < 0.06) {
        this.addTree(out, x, y, SP.willow, season, era, p, r2, r3);
      }
      if (water && r2 < 0.28) this.addUnder(out, x + 0.40, y + 0.55, U.REED, season, r2, r4);
      if (D >= 2 && r3 < 0.16) this.addUnder(out, x + 0.20, y + 0.40, U.GRASS, season, r3, r1);
      return;
    }

    if (t === TILE.MOUNTAIN) {
      // на камне держится только сухостой, и то у подножия
      const foot = tile(x, y + 1) === TILE.HILL || tile(x - 1, y) === TILE.HILL || tile(x + 1, y) === TILE.HILL;
      if (foot && r1 < 0.07) this.addTree(out, x, y, r2 < 0.5 ? SP.dead : SP.junip, season, era, p, r2, r3);
    }
  }

  // ---- выбор породы ------------------------------------------------------
  forestSpecies(r, warm, wet, water, era, p) {
    if (water && wet > 0.5) return r < 0.6 ? SP.willow : SP.poplar;
    // индустрия оставляет после себя сухостой прямо в лесу
    if (era >= 6 && era <= 7 && p > 0.55 && r > 0.88) return SP.dead;
    if (warm < 0.30) return pick(r, [SP.spruce, 0.62, SP.pine, 0.38]);
    if (warm < 0.54) return pick(r, [SP.spruce, 0.26, SP.birch, 0.30, SP.pine, 0.16, SP.oak, 0.16, SP.maple, 0.12]);
    if (warm < 0.78) return pick(r, [SP.oak, 0.34, SP.maple, 0.24, SP.birch, 0.16, SP.poplar, 0.16, SP.pine, 0.10]);
    return pick(r, [SP.acacia, 0.46, SP.oak, 0.26, SP.palm, wet > 0.55 ? 0.18 : 0.06, SP.maple, 0.12]);
  }

  openSpecies(r, warm, wet, water, era, p) {
    // Сад у города: с земледелия и до конца игры возле поселений стоят яблони.
    if (era >= 3 && p > 0.34 && r < 0.42) return SP.fruit;
    if (water) return r < 0.55 ? SP.willow : SP.poplar;
    if (warm < 0.32) return r < 0.6 ? SP.spruce : SP.birch;
    if (warm < 0.60) return pick(r, [SP.oak, 0.34, SP.birch, 0.28, SP.maple, 0.20, SP.poplar, 0.18]);
    return pick(r, [SP.acacia, 0.44, SP.oak, 0.28, SP.poplar, 0.16, SP.palm, warm > 0.82 ? 0.12 : 0.02]);
  }

  // ---- заведение растения ------------------------------------------------
  addTree(out, x, y, sp, season, era, p, ra, rb) {
    const spec = SPECIES[sp];
    const sz = spec.sz[0] + (spec.sz[1] - spec.sz[0]) * ra;
    // Тон: копоть индустрии глушит листву, чистая эпоха и влага делают сочнее.
    let tone = rb < 0.34 ? 0 : rb < 0.74 ? 1 : 2;
    if (era >= 6 && era <= 7 && p > 0.42) tone = 0;
    else if (era >= 8 && p > 0.30 && tone < 2) tone = Math.min(2, tone + 1);
    out.push({
      x: x + 0.16 + ra * 0.66, y: y + 0.22 + rb * 0.56,
      k: KIND_TREE, s: sp, sz,
      tone, form: rb < 0.5 ? 0 : 1, flip: ra < 0.5 ? 0 : 1,
      flex: spec.flex, ph: ra * 6.283,
      // Приоритет прореживания: деревья держатся до последнего, поэтому их
      // ключ вдвое «дешевле» — крупный ярус исчезает последним.
      pri: (ra * 0.6 + rb * 0.4) * 0.55,
    });
  }

  addUnder(out, x, y, kind, season, ra, rb) {
    const s = UNDER_SZ[kind];
    out.push({
      x: x + 0.10 + ra * 0.72, y: y + 0.20 + rb * 0.60,
      k: KIND_UNDER, s: kind, sz: s[0] + (s[1] - s[0]) * ra,
      tone: rb < 0.4 ? 0 : rb < 0.8 ? 1 : 2, form: ra < 0.5 ? 0 : 1, flip: 0,
      flex: UNDER_FLEX[kind], ph: rb * 6.283,
      pri: ra * 0.5 + rb * 0.5,
    });
  }

  // =========================================================================
  // СПРАЙТЫ
  // =========================================================================
  treeSprite(sp, season, tone, form) {
    const key = `t${sp}|${season}|${tone}|${form}`;
    let cv = this.sprites.get(key);
    if (cv) { touch(this.sprites, key); return cv; }
    const S = this.treePx;
    cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const c = cv.getContext('2d');
    const spec = SPECIES[sp];
    PAINT[sp](c, S, foliage(spec, season, tone), spec, season, form);
    this.sprites.set(key, cv);
    prune(this.sprites, { maxEntries: VEG_LIMITS.sprites, maxBytes: VEG_LIMITS.spriteMB * 1048576, bytesOf: canvasBytes });
    return cv;
  }

  underSprite(kind, season, tone, form) {
    const key = `u${kind}|${season}|${tone}|${form}`;
    let cv = this.sprites.get(key);
    if (cv) { touch(this.sprites, key); return cv; }
    const S = this.underPx;
    cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const c = cv.getContext('2d');
    // Подлесок красится тем же сезонным тоном, что и кроны, только через
    // «усреднённую породу» — иначе куст под дубом окажется другого леса.
    const F = foliage(SPECIES[SP.oak], season, tone);
    PAINT_U[kind](c, S, F, season, form);
    this.sprites.set(key, cv);
    prune(this.sprites, { maxEntries: VEG_LIMITS.sprites, maxBytes: VEG_LIMITS.spriteMB * 1048576, bytesOf: canvasBytes });
    return cv;
  }

  // =========================================================================
  // ОТРИСОВКА. Ставится после земли и ДО зданий и жителей: растительность —
  // часть ландшафта, а не декорация поверх города.
  // =========================================================================
  draw(sim, ctx, ox, oy, z, cw, ch) {
    this.drawn = 0;
    if (this.off || !sim || !sim.world) return;
    if (!this.q.ambientProps) return;
    // Ниже порога реквизита куст занимает меньше трёх пикселей: он превращается
    // в грязь на экране, а стоит ровно столько же, сколько крупный.
    if (z / TILE_PX < this.q.lod.propsMinZoom) return;

    const cap = VEG_LIMITS.items[this.q.id] ?? VEG_LIMITS.items.high;
    if (cap <= 0) return;

    const W = sim.world.w, H = sim.world.h;
    // Поля запаса: дерево ростом в две клетки, стоящее выше верхней кромки,
    // всё ещё видно кроной.
    const wx0 = Math.floor((-ox) / z) - 2, wx1 = Math.ceil((cw - ox) / z) + 2;
    const wy0 = Math.floor((-oy) / z) - 3, wy1 = Math.ceil((ch - oy) / z) + 2;
    const cx0 = Math.max(0, Math.floor(wx0 / VEG_CHUNK)), cx1 = Math.min(Math.ceil(W / VEG_CHUNK) - 1, Math.floor(wx1 / VEG_CHUNK));
    const cy0 = Math.max(0, Math.floor(wy0 / VEG_CHUNK)), cy1 = Math.min(Math.ceil(H / VEG_CHUNK) - 1, Math.floor(wy1 / VEG_CHUNK));
    if (cx1 < cx0 || cy1 < cy0) return;

    // Сколько кварталов разрешено пересобрать за кадр. Как и у местности:
    // лучше несколько кадров с пустыми пятнами, чем один провал на 30 мс.
    let budget = Math.max(2, (this.q.caps && this.q.caps.chunksPerFrame ? this.q.caps.chunksPerFrame : 8) >> 1);

    const vis = this._vis;
    vis.length = 0;
    let total = 0;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        let list = this.chunkAt(sim, cx, cy);
        if (!list) {
          if (budget <= 0) continue;
          budget--;
          list = this.buildChunk(sim, cx, cy);
        }
        if (!list.length) continue;
        vis.push(list);
        total += list.length;
      }
    }
    if (!total) return;

    // Прореживание. Порог по устойчивому приоритету, а не по случайному
    // отбору: растение либо в кадре, либо нет, и решение не меняется от кадра
    // к кадру — иначе лес мерцает при малейшем движении камеры.
    const cut = total > cap ? cap / total : 1;

    // Ветер. Амплитуда сдвига верхушки — доля высоты. Гроза мотает сильнее.
    const stormK = sim.weather === 'storm' ? 1.7 : sim.weather === 'rain' ? 1.15 : 1;
    const amp = (0.030 + 0.085 * Math.abs(this.wind)) * clamp(this.gust, 0.2, 1.2) * stormK;
    const dir = this.wind < 0 ? -1 : 1;
    const t = this.time;

    // Базовая матрица кадра: renderer ставит её один раз (dpr,0,0,dpr,0,0).
    // Наклон кроны — сдвиг вокруг основания, поэтому ствол остаётся на месте,
    // а верхушка уезжает. Одна setTransform на дерево вместо save/restore.
    const m = (typeof ctx.getTransform === 'function') ? ctx.getTransform() : null;
    const m0 = m ? m.a : 0, m1 = m ? m.b : 0, m2 = m ? m.c : 0, m3 = m ? m.d : 0, m4 = m ? m.e : 0, m5 = m ? m.f : 0;
    let skewed = false;
    let drawn = 0;

    for (let i = 0; i < vis.length; i++) {
      const list = vis[i];
      for (let j = 0; j < list.length; j++) {
        const it = list[j];
        if (it.pri > cut) continue;
        const d = it.sz * z;
        const sx = ox + it.x * z, sy = oy + it.y * z;
        if (sx + d < 0 || sy + d * 0.14 < 0 || sx - d > cw || sy - d > ch) continue;
        if (drawn >= cap) break;
        drawn++;

        // Волна порыва бежит по миру: соседние деревья качаются не в такт,
        // а с задержкой — это и читается как ветер, а не как дрожь.
        const sw = amp * it.flex * dir * Math.sin(t * 1.35 + it.ph - it.x * 0.55 - it.y * 0.18);

        if (it.k === KIND_TREE) {
          const cv = this.treeSprite(it.s, sim.seasonIdx, it.tone, it.form);
          if (m && (sw > 0.004 || sw < -0.004 || it.flip)) {
            // a2/c2/e2 — сдвиг вокруг линии y = sy плюс, если надо, отражение
            // по вертикальной оси x = sx. Отражение бесплатно удваивает набор
            // силуэтов, не тратя ни байта кэша.
            const a2 = it.flip ? -1 : 1;
            const e2 = (it.flip ? 2 * sx : 0) - sw * sy;
            ctx.setTransform(m0 * a2, m1 * a2, m0 * sw + m2, m1 * sw + m3, m0 * e2 + m4, m1 * e2 + m5);
            skewed = true;
            ctx.drawImage(cv, sx - d * 0.5, sy - d * 0.88, d, d);
          } else {
            if (skewed) { ctx.setTransform(m0, m1, m2, m3, m4, m5); skewed = false; }
            ctx.drawImage(cv, sx - d * 0.5, sy - d * 0.88, d, d);
          }
        } else {
          // Подлесок ниже колена: наклон незаметен, хватает сдвига по X —
          // это дешевле матрицы и на сотне кустов экономит заметно.
          if (skewed) { ctx.setTransform(m0, m1, m2, m3, m4, m5); skewed = false; }
          const cv = this.underSprite(it.s, sim.seasonIdx, it.tone, it.form);
          ctx.drawImage(cv, sx - d * 0.5 + sw * d * 0.55, sy - d * 0.88, d, d);
        }
      }
      if (drawn >= cap) break;
    }
    if (skewed) ctx.setTransform(m0, m1, m2, m3, m4, m5);
    this.drawn = drawn;
  }
}

/* ПОДКЛЮЧЕНИЕ */
//
// Ниже — точные строки для app/src/render/renderer.js. Сам renderer.js этим
// агентом НЕ ТРОГАЛСЯ (чужая зона, одновременно правят ещё шестнадцать
// агентов): вставлять руками. Все якоря проверены на уникальность в файле на
// момент написания — где строк две, это сказано явно.
//
// 1) Импорт — ПОСЛЕ строки
//      import { FxLayer } from './fx.js';
//    добавить:
//
//      import { Vegetation } from './vegetation.js';
//
// 2) Конструктор Renderer — ПОСЛЕ строки
//      this.atmo = new Atmosphere(this.quality);
//    добавить:
//
//      this.veg = new Vegetation(this.quality);
//
// 3) Смена пресета. Строка
//      this.atmo.setQuality(this.quality);
//    встречается ДВАЖДЫ — в setQuality(id) и в tuneAuto(dtReal). После КАЖДОЙ
//    из двух добавить:
//
//      this.veg.setQuality(this.quality);
//
// 4) draw() — обновление состояния. Сразу ПОСЛЕ строки
//      this.fx.update(sim, dtReal, ox, oy, z, cw, ch);
//    добавить:
//
//      this.veg.update(sim, dtReal, ox, oy, z, cw, ch, { wind: this.atmo.wind, roads: this.terrain.road && this.terrain.road.tiles });
//
//    Ветер берётся из погоды — один и тот же для дождя, снега и крон, иначе
//    капли летят влево, а деревья гнутся вправо. Если weather.js в вашей сборке
//    ещё не подключён, третий аргумент можно не передавать вовсе:
//    модуль посчитает то же самое сам, по тому же правилу «сутки — одно
//    направление».
//
// 5) draw() — сама отрисовка. Сразу ПОСЛЕ строки
//      this.atmo.drawGround(sim, ctx, ox, oy, z, cw, ch);
//    добавить:
//
//      this.veg.draw(sim, ctx, ox, oy, z, cw, ch);
//
//    Именно здесь: растительность — часть ландшафта. Выше неё пойдут тени
//    облаков, территории, здания и жители; ниже — земля с дорогами и мокрыми
//    пятнами. Следствие, о котором надо знать: дерево, стоящее ЮЖНЕЕ дома, всё
//    равно окажется за домом, а не перед ним. Растения не заводятся на клетках
//    построек, поэтому в кадре это почти не видно; честная сортировка по
//    глубине потребовала бы правки drawSortedEntities — то есть чужого файла.
//
// 6) Новая игра и загрузка сейва — там, где Renderer уже существует, а мир
//    подменяется целиком (main.js/hud.js, чужая зона):
//
//      renderer.veg.clear();
//
//    Без этого секунду-другую над новой картой стоит лес со старой.
//
// ---------------------------------------------------------------------------
// ЧТО РАБОТАЕТ САМО, БЕЗ ЕДИНОЙ ПРАВКИ В ЯДРЕ
//
//   • ПОРОДЫ ПО БИОМУ И КЛИМАТУ. Двенадцать пород, каждая опознаётся силуэтом.
//     Север карты — ель и сосна, середина — смешанный лес с берёзой, дубом и
//     клёном, юг — акация, у тёплой воды пальма. У воды ива и тополь, на
//     склонах можжевельник, на камне сухостой. Тепло и влага выведены из
//     координат (широта плюс шум), в ядре для этого ничего не нужно.
//
//   • ВЕТЕР. Наклон кроны — сдвиг вокруг основания: ствол стоит, верхушка
//     ходит. Волна порыва бежит по миру (фаза зависит от мировой координаты),
//     поэтому соседние деревья качаются с задержкой, а не хором. Гибкость —
//     свойство породы: тополь и ива мотаются, дуб и ель почти стоят. В грозу
//     амплитуда ×1,7.
//
//   • СЕЗОНЫ. Весна — свежая зелень и цветущая яблоня, единственное место, где
//     растительность берёт розовое. Лето — плотная тёмная листва и ягоды на
//     кустах. Осень — золото берёзы и тополя, багрянец клёна, опад под
//     деревьями, сухой тростник. Зима — лиственные СТОЯТ ГОЛЫЕ, со снегом на
//     ветвях; у ели снежная шапка на каждом ярусе; цветов нет, трава седая.
//
//   • ЭПОХИ. Поле «давления цивилизации» считается от построек: лесопилка
//     сводит лес, ферма расчищает поле, фабрика травит копотью. Каменный век
//     почти не оставляет следов, пик — индустрия (эпохи 6–7: пни, сухостой,
//     тусклая закопчённая листва), а с цифровой эпохи давление падает вдвое —
//     вокруг города возвращается лес, у домов появляются яблони и клумбы.
//     С земледелия (эпоха 3) рядом с поселением встают плодовые сады.
//
//   • ПОДЛЕСОК. Папоротник и валежник в лесу, кусты с ягодами на опушке,
//     тростник по берегам, высокая трава на лугу и в дюнах, цветы весной и
//     летом, пни и молодая поросль на вырубках.
//
// РУЧКИ, КОТОРЫЕ МОГУТ ПРИГОДИТЬСЯ
//
//      renderer.veg.forestFill = 0.55;  // доля клеток леса с КРУПНЫМ деревом
//      renderer.veg.edgeFill   = 0.82;  // то же для опушки
//      renderer.veg.invalidate();       // пересобрать раскладку
//      renderer.veg.drawn               // сколько растений было в прошлом кадре
//
// Мелкие силуэты terrain.js никуда не деваются — они остаются нижним ярусом
// под кронами. Если после подключения лес покажется перенаселённым, поставьте
// forestFill = 0: опушки, подлесок, вырубки и одиночные деревья останутся, а
// внутренность массива снова будет рисовать только местность.
//
// ---------------------------------------------------------------------------
// ПРЕСЕТЫ И БЮДЖЕТ
//
//   eco     — модуль выключен полностью, ни одного вызова в кадре.
//   medium  — потолок 150 растений, detail 1: без опада, валежника и высокой
//             травы, спрайты печатаются в 72 px.
//   high    — потолок 260, detail 2, спрайты 96 px.
//   ultra   — потолок 400.
//
// Ниже q.lod.propsMinZoom (0,6 на ultra, 0,8 на high, 1,0 на medium) модуль
// молчит целиком: на таком зуме куст занимает два пикселя.
//
// Откуда берётся цена. Каждое растение — ОДИН drawImage испечённого спрайта;
// у дерева к нему добавляется одна setTransform (наклон от ветра и отражение),
// у подлеска не добавляется ничего. Раскладка считается не в кадре, а один раз
// на квартал 8×8 клеток, и пересобирается только при смене сезона, эпохи или
// состава построек. Когда в кадр попадает больше растений, чем разрешает
// пресет, лишние отсекаются по неизменному приоритету — деревья держатся
// вдвое дольше подлеска, поэтому при отдалении первым исчезает мелочь.
//
// ОЦЕНКА (по методике docs/visual-performance-budget.md, метод А; ориентир —
// стоимость блита из fx.js, где 149 мягких пятен стоят 1,4 мс на SwiftShader;
// спрайт растения мельче пятна дыма и не аддитивный):
//
//   пресет high, потолок 260 растений                    ~0,7–0,9 мс
//   пресет medium, потолок 150                           ~0,4–0,5 мс
//   пересборка одного квартала 8×8                       ~0,15 мс (≤4 за кадр)
//   выпечка одного спрайта 96×96                         ~0,3 мс (36 штук на
//                                                        сезон, дальше кэш)
//   пресет eco / зум ниже порога                         0 мс
//
// Потолок в 1 мс на high держится потолком количества, а не надеждой: сколько
// бы деревьев ни попало в кадр, нарисовано будет ровно cap штук.
