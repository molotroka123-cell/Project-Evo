// render/weather.js — атмосфера: осадки, туман, зной и ночь.
//
// Модуль ничего не знает о симуляции, кроме четырёх её полей: sim.weather,
// sim.dayTime, sim.seasonIdx, sim.day и sim.world (для проверки тайла под
// каплей). Он ничего не меняет — только читает и рисует поверх сцены.
//
// Закрывает П7 (ночь — серый фильтр), П8 (погода жила в координатах экрана),
// А10 (плотность частиц не зависела от площади экрана) из docs/graphics-audit.md.
//
// ПОЧЕМУ ЗДЕСЬ СВОЙ ГЕНЕРАТОР СЛУЧАЙНОСТИ. Math.random в проекте запрещён, но
// и rng ядра трогать нельзя: каждый его вызов сдвигает состояние симуляции, а
// рендер работает с разной частотой у разных игроков — сейв бы поплыл. Поэтому
// внутри модуля живёт свой xorshift, засеянный сидом мира: картинка
// повторяема, симуляция не задета.
import { TILE } from '../core/data.js';
import { tileAt } from '../core/world.js';
import { TILE_HEIGHT, WEATHER_TINT, hash2 } from './palette.js';

// ---------------------------------------------------------------------------
// Потолки пулов. Массивы выделяются один раз в конструкторе и НИКОГДА не
// растут: активна всегда только голова массива длиной n. Пресет качества и
// площадь экрана двигают n, но выше потолка он не поднимается ни при каком
// разрешении и ни при каком зуме.
// ---------------------------------------------------------------------------
export const LIMITS = { precip: 260, ripple: 56, fog: 18, dust: 48 };

// Базовая плотность на «эталонный» экран 1280×720 при particles = 1.
const BASE = { rain: 150, snow: 110, leaf: 26 };

// Ночной множитель: холодный сине-стальной, а не чёрный. Умножение сохраняет
// отношения яркостей, поэтому стена, крыша и рубаха жителя ночью остаются
// разными — в отличие от непрозрачной чёрной заливки поверх кадра.
const NIGHT_MUL = [96, 114, 168];
// Подъём теней: слабое сложение, чтобы самые тёмные места ушли в тёмно-синий,
// а не в ноль. Без него силуэты зданий на земле ночью сливаются.
const NIGHT_LIFT = [10, 16, 40];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (k) => k * k * (3 - 2 * k);

// Треугольное окно со сглаженными краями: 0 вне [a,b], 1 в точке peak.
function bell(t, a, peak, b) {
  if (t <= a || t >= b) return 0;
  return smooth(t < peak ? (t - a) / (peak - a) : (b - t) / (b - peak));
}

function makeRnd(seed) {
  let s = (seed | 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return (s >>> 0) / 4294967296;
  };
}

// Canvas молча игнорирует неизвестный режим наложения и оставляет source-over.
// Для 'multiply' это всего лишь неверный оттенок, а вот для 'saturation' —
// сплошной серый прямоугольник во весь экран. Поэтому режим проверяется один
// раз записью-чтением, и при отказе есть запасной путь.
function supportsOp(ctx, op) {
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = op;
  const ok = ctx.globalCompositeOperation === op;
  ctx.globalCompositeOperation = prev;
  return ok;
}

// Какие осадки показывать. Ядро знает четыре погоды; листопад — это осень
// без дождя и снега (раньше он жил в renderer.drawWeather, здесь сохранён,
// чтобы подключение модуля ничего не отняло у картинки).
function kindOf(sim) {
  if (sim.weather === 'rain') return 'rain';
  if (sim.weather === 'snow') return 'snow';
  if (sim.seasonIdx === 2) return 'leaf';
  return null;
}

export class Atmosphere {
  constructor(quality) {
    this.q = quality;
    this.off = quality.id === 'eco';
    this.time = 0;
    this.kind = null;
    this.fade = 0;      // плавное появление/уход осадков, 0..1
    this.wet = 0;       // насколько промокла земля, 0..1
    this.wind = -0.35;  // снос по горизонтали, доля от скорости падения
    this.rnd = makeRnd(0x51ed270b);
    this.seeded = false;

    // --- пулы фиксированного размера -------------------------------------
    this.precip = new Array(LIMITS.precip);
    for (let i = 0; i < LIMITS.precip; i++) this.precip[i] = { x: 0, y: 0, vy: 0, len: 0, d: 0, ph: 0, sp: 0 };
    this.nPrecip = 0;

    this.ripples = new Array(LIMITS.ripple);
    for (let i = 0; i < LIMITS.ripple; i++) this.ripples[i] = { x: 0, y: 0, t: 0, life: 0, land: false };
    this.nRip = 0;
    this.ripAcc = 0;

    this.fog = new Array(LIMITS.fog);
    for (let i = 0; i < LIMITS.fog; i++) this.fog[i] = { x: 0, y: 0, r: 0, a: 0, vx: 0, vy: 0, low: 0, ph: 0 };
    this.nFog = 0;

    this.dust = new Array(LIMITS.dust);
    for (let i = 0; i < LIMITS.dust; i++) this.dust[i] = { x: 0, y: 0, vx: 0, vy: 0, r: 0, a: 0, ph: 0 };
    this.nDust = 0;

    this._blob = null;   // испечённое мягкое пятно тумана
    this._ops = null;    // кэш проверки режимов наложения
    this.fogK = 0;
    this.heatK = 0;
  }

  setQuality(q) {
    this.q = q;
    this.off = q.id === 'eco';
    if (this.off) { this.nPrecip = 0; this.nRip = 0; this.nFog = 0; this.nDust = 0; }
  }

  // -------------------------------------------------------------------------
  // Обновление состояния. Вызывается один раз за кадр ДО отрисовок: частицы
  // живут в мировых координатах, но заворачиваются в видимый прямоугольник —
  // при панораме они не едут по экрану и не остаются за краем.
  // -------------------------------------------------------------------------
  update(sim, dt, ox, oy, z, cw, ch) {
    if (!this.seeded) { this.rnd = makeRnd((sim.world && sim.world.seed) | 0 || 12345); this.seeded = true; }
    // Вкладка была свёрнута — не телепортируем дождь на пол-карты.
    dt = Math.min(0.05, Math.max(0, dt || 0));
    this.time += dt;

    // Мокрая земля сохнет заметно дольше, чем намокает, — и остаётся после дождя.
    const wetT = sim.weather === 'rain' ? 1 : 0;
    this.wet = clamp01(this.wet + Math.max(-dt / 20, Math.min(dt / 4.5, wetT - this.wet)));

    if (this.off) { this.fogK = 0; this.heatK = 0; return; }

    // Ветер держится сутки: один игровой день — одно направление.
    const wTarget = -0.72 + hash2(sim.day | 0, sim.seasonIdx | 0) * 1.16;
    this.wind += (wTarget - this.wind) * Math.min(1, dt * 0.6);

    const rect = this._rect(ox, oy, z, cw, ch);
    const areaK = Math.min(1.7, Math.max(0.35, (cw * ch) / (1280 * 720)));

    // --- смена типа осадков: сначала уводим старые, потом заводим новые ----
    const want = kindOf(sim);
    if (want !== this.kind) {
      this.fade = Math.max(0, this.fade - dt * 0.7);
      if (this.fade <= 0.002) { this.kind = want; this.nPrecip = 0; }
    } else if (this.kind) {
      this.fade = Math.min(1, this.fade + dt * 0.5);
    } else {
      this.fade = 0;
    }

    this._updatePrecip(sim, dt, rect, areaK);
    this._updateRipples(sim, dt, rect);

    this.fogK = this.fogStrength(sim);
    this.heatK = this.heatStrength(sim);
    this._updateFog(sim, dt, rect);
    this._updateDust(dt, rect, areaK);
  }

  // ---- сила эффектов ------------------------------------------------------
  // Туман — утренний и низинный: окно от рассвета до раннего утра, осенью
  // гуще, зимой и в снег почти нет.
  fogStrength(sim) {
    const k = bell(sim.dayTime, 0.15, 0.27, 0.45);
    if (k <= 0) return 0;
    const bySeason = [1.0, 0.55, 1.15, 0.5][sim.seasonIdx] ?? 1;
    const byWeather = sim.weather === 'rain' ? 1.15 : sim.weather === 'snow' ? 0.3 : sim.weather === 'cloud' ? 1.0 : 0.8;
    return clamp01(k * bySeason * byWeather);
  }

  // Зной — летний полдень в ясную погоду: пыль в воздухе и тёплая дымка.
  heatStrength(sim) {
    if (sim.weather !== 'sun' || sim.seasonIdx !== 1) return 0;
    return bell(sim.dayTime, 0.34, 0.55, 0.8) * 0.95;
  }

  // -------------------------------------------------------------------------
  // Слой 1: земля. Рисуется СРАЗУ ПОСЛЕ местности, до зданий и жителей, —
  // мокнет и рябит только земля, крыши остаются сухими.
  // -------------------------------------------------------------------------
  drawGround(sim, ctx, ox, oy, z, cw, ch) {
    if (this.off || this.wet <= 0.01) return;
    const ops = this._checkOps(ctx);
    ctx.save();
    // Мокрая земля темнее: умножение на холодный серый. Умножение, а не
    // чёрная заливка, — оно сохраняет цветовые отношения, поэтому песок
    // остаётся песком, а трава травой, просто напитавшимися водой.
    if (ops.multiply) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = this.wet * 0.62;
      ctx.fillStyle = 'rgb(112,128,150)';
    } else {
      ctx.globalAlpha = this.wet * 0.26;
      ctx.fillStyle = 'rgb(40,52,72)';
    }
    ctx.fillRect(0, 0, cw, ch);
    // Насыщение: мокрое всегда «сочнее» сухого. Режим saturation подтягивает
    // насыщенность к насыщенности источника; на слабой альфе это лёгкий
    // подъём цвета, а не перекраска. Ещё один проход во весь экран — только
    // на «ультре»: на остальных пресетах хватает потемнения.
    if (ops.saturation && this.q.id === 'ultra') {
      ctx.globalCompositeOperation = 'saturation';
      ctx.globalAlpha = this.wet * 0.16;
      ctx.fillStyle = 'hsl(205,85%,50%)';
      ctx.fillRect(0, 0, cw, ch);
    }
    ctx.restore();
    this._drawRipples(ctx, ox, oy, z);
  }

  // -------------------------------------------------------------------------
  // Слой 2: воздух. Рисуется ПОСЛЕ зданий и жителей — осадки идут перед
  // камерой, туман скрадывает дома, дымка ложится на всю сцену.
  // -------------------------------------------------------------------------
  drawOverlay(sim, ctx, ox, oy, z, cw, ch) {
    if (this.off) return;
    this.drawFog(sim, ctx, ox, oy, z, cw, ch);
    this.drawPrecip(sim, ctx, ox, oy, z, cw, ch);
    this.drawHaze(sim, ctx, ox, oy, z, cw, ch);
  }

  drawPrecip(sim, ctx, ox, oy, z, cw, ch) {
    if (this.off || !this.kind || this.fade <= 0.01 || !this.nPrecip) return;
    if (this.kind === 'rain') this._drawRain(ctx, ox, oy, z);
    else if (this.kind === 'snow') this._drawSnow(ctx, ox, oy, z, cw, ch);
    else this._drawLeaves(ctx, ox, oy, z);
  }

  drawFog(sim, ctx, ox, oy, z, cw, ch) {
    if (this.off || this.fogK <= 0.01 || !this.nFog) return;
    const blob = this._blobSprite();
    if (!blob) return;
    ctx.save();
    for (let i = 0; i < this.nFog; i++) {
      const f = this.fog[i];
      const r = f.r * z;
      const sx = ox + f.x * z, sy = oy + f.y * z;
      if (sx < -r * 1.2 || sy < -r || sx > cw + r * 1.2 || sy > ch + r) continue;
      // Дыхание: пятно чуть пульсирует, иначе туман выглядит наклейкой.
      const puff = 1 + 0.08 * Math.sin(this.time * 0.35 + f.ph);
      const a = f.a * f.low * this.fogK * (0.85 + 0.15 * Math.sin(this.time * 0.5 + f.ph * 2));
      if (a <= 0.005) continue;
      ctx.globalAlpha = Math.min(0.72, a);
      // Приплюснут по вертикали: так пятно читается как пелена НА земле,
      // а не как облако шаром.
      ctx.drawImage(blob, sx - r * puff, sy - r * 0.42 * puff, r * 2 * puff, r * 1.18 * puff);
    }
    ctx.restore();
  }

  drawHaze(sim, ctx, ox, oy, z, cw, ch) {
    if (this.off || this.heatK <= 0.01) return;
    const k = this.heatK;
    ctx.save();
    // Тёплая дымка: гуще к верху кадра — там «дальше», там больше воздуха.
    const g = ctx.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, `rgba(236,206,146,${0.21 * k})`);
    g.addColorStop(0.55, `rgba(240,216,164,${0.11 * k})`);
    g.addColorStop(1, `rgba(244,224,180,${0.05 * k})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);
    // Пыль: редкие тёплые пылинки у самой земли.
    if (this.nDust) {
      for (let i = 0; i < this.nDust; i++) {
        const p = this.dust[i];
        const sx = ox + p.x * z, sy = oy + p.y * z + Math.sin(this.time * 0.8 + p.ph) * z * 0.05;
        if (sx < -4 || sy < -4 || sx > cw + 4 || sy > ch + 4) continue;
        ctx.globalAlpha = Math.max(0, p.a * k * (0.55 + 0.45 * Math.sin(this.time * 1.7 + p.ph)));
        ctx.fillStyle = 'rgb(250,232,190)';
        const r = Math.max(1, p.r * z);
        ctx.fillRect(sx, sy, r, r);
      }
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Слой 3: тон. Заменяет два полноэкранных fillRect из renderer.draw
  // (свет суток + погодный тон) — см. блок ПОДКЛЮЧЕНИЕ внизу файла.
  // -------------------------------------------------------------------------
  drawTone(sim, ctx, cw, ch, L) {
    const wt = WEATHER_TINT[sim.weather];
    // Экономия: ровно то, что делал renderer раньше, — две дешёвые заливки.
    // Ночь нельзя выключать совсем, иначе на слабой машине пропадает разница
    // между днём и ночью; но ни одного лишнего прохода здесь не будет.
    if (this.off) {
      if (L.tint[3] > 0.008) {
        ctx.fillStyle = `rgba(${L.tint[0]},${L.tint[1]},${L.tint[2]},${L.tint[3]})`;
        ctx.fillRect(0, 0, cw, ch);
      }
      if (wt && wt.tint[3] > 0.008) {
        ctx.fillStyle = `rgba(${wt.tint[0]},${wt.tint[1]},${wt.tint[2]},${wt.tint[3]})`;
        ctx.fillRect(0, 0, cw, ch);
      }
      return;
    }

    const ops = this._checkOps(ctx);
    // Мера темноты берётся из яркости света, а не из glow: glow равен единице
    // уже в сумерках, когда до настоящей ночи ещё далеко.
    const night = clamp01((1 - L.mul) / 0.58);

    // ЗАЛИВКА ВО ВЕСЬ ЭКРАН — САМЫЙ ДОРОГОЙ ПРИМИТИВ В КАДРЕ. Замер на
    // софтверном растеризаторе: семь проходов съедали треть частоты кадров.
    // Поэтому все множители складываются в ОДИН цвет, все накрывающие тона —
    // в один, и кадр получает максимум три полноэкранных прохода вместо семи.
    let mr = 1, mg = 1, mb = 1;          // общий множитель
    let tr = 0, tg = 0, tb = 0, ta = 0;  // общая накрывающая заливка
    // Сложение двух накрывающих заливок по формуле source-over.
    const over = (r, g, b, a) => {
      if (a <= 0) return;
      const na = ta + a - ta * a;
      tr = (r * a + tr * ta * (1 - a)) / na;
      tg = (g * a + tg * ta * (1 - a)) / na;
      tb = (b * a + tb * ta * (1 - a)) / na;
      ta = na;
    };

    if (night > 0.01) {
      if (ops.multiply) {
        // Ночь = умножение на холодный синий. Дом остаётся светлее земли,
        // житель — светлее дома: контраст падает пропорционально, а не
        // забивается непрозрачной плёнкой. Глубже, чем NIGHT_MUL (яркость
        // около 0,45 от дневной), сцена не темнеет НИКОГДА — это и есть
        // граница читаемости, ниже неё жителя на земле уже не видно.
        const k = night * 0.95;
        mr *= lerp(255, NIGHT_MUL[0], k) / 255;
        mg *= lerp(255, NIGHT_MUL[1], k) / 255;
        mb *= lerp(255, NIGHT_MUL[2], k) / 255;
      } else {
        over(22, 34, 86, night * 0.42);
      }
    }

    // Тёплый тон рассвета и заката — накрывающей заливкой: там важен именно
    // цвет неба на сцене, а не сохранение контраста.
    const t = L.tint;
    if (t[3] > 0.008 && t[0] > t[2]) over(t[0], t[1], t[2], t[3] * 0.85);

    if (wt) {
      if (wt.mul < 0.999 && ops.multiply) {
        // Множитель из palette.js рассчитывался на слабую заливку сверху;
        // умножением он работает мягче, поэтому усиливаем — иначе дождливый
        // полдень по яркости не отличается от ясного.
        const c = 1 - (1 - wt.mul) * 1.35;
        mr *= c * 0.94; mg *= c * 0.98; mb *= c;
      }
      // Множитель уже притемнил кадр — заливку берём вполсилы, иначе
      // дождливый день превращается в сплошную синюю кашу.
      if (wt.tint[3] > 0.008) over(wt.tint[0], wt.tint[1], wt.tint[2], wt.tint[3] * (ops.multiply ? 0.55 : 1));
    }

    ctx.save();
    if (mr < 0.996 || mg < 0.996 || mb < 0.996) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgb(${Math.round(mr * 255)},${Math.round(mg * 255)},${Math.round(mb * 255)})`;
      ctx.fillRect(0, 0, cw, ch);
    }
    if (night > 0.01 && ops.multiply) {
      // Подъём теней: чёрное становится тёмно-синим. Именно это отличает
      // «ночь» от «выключенного монитора», поэтому проход не экономим.
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgb(${Math.round(NIGHT_LIFT[0] * night)},${Math.round(NIGHT_LIFT[1] * night)},${Math.round(NIGHT_LIFT[2] * night)})`;
      ctx.fillRect(0, 0, cw, ch);
    }
    if (ta > 0.004) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgba(${Math.round(tr)},${Math.round(tg)},${Math.round(tb)},${ta})`;
      ctx.fillRect(0, 0, cw, ch);
    }
    // Снежная пелена: воздух между камерой и землёй забит снегом. Отдельным
    // проходом — только в снег, то есть в кадре, где заливки тона почти нет.
    if (this.kind === 'snow' && this.fade > 0.01) {
      ctx.globalCompositeOperation = 'source-over';
      const veil = ctx.createLinearGradient(0, 0, 0, ch);
      const a = this.fade * 0.13;
      veil.addColorStop(0, `rgba(232,240,252,${a})`);
      veil.addColorStop(1, `rgba(226,236,250,${a * 0.35})`);
      ctx.fillStyle = veil;
      ctx.fillRect(0, 0, cw, ch);
    }
    // Обесцвечивание дождя и тумана (WEATHER_TINT.desat) стоит отдельного
    // полноэкранного прохода в режиме saturation — берём его только на
    // «ультре», где кадр заведомо не упирается в заливки.
    if (wt && wt.desat > 0 && ops.saturation && this.q.id === 'ultra') {
      ctx.globalCompositeOperation = 'saturation';
      ctx.globalAlpha = wt.desat * 0.55;
      ctx.fillStyle = 'hsl(0,0%,50%)';
      ctx.fillRect(0, 0, cw, ch);
    }
    ctx.restore();
  }

  // =========================================================================
  // Внутреннее
  // =========================================================================
  _rect(ox, oy, z, cw, ch) {
    return { x0: -ox / z, y0: -oy / z, x1: (cw - ox) / z, y1: (ch - oy) / z };
  }

  _checkOps(ctx) {
    if (!this._ops) {
      this._ops = { multiply: supportsOp(ctx, 'multiply'), saturation: supportsOp(ctx, 'saturation') };
    }
    return this._ops;
  }

  _blobSprite() {
    if (this._blob) return this._blob;
    if (typeof document === 'undefined') return null;
    const S = 72;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(224,233,241,0.95)');
    g.addColorStop(0.42, 'rgba(218,229,239,0.55)');
    g.addColorStop(0.75, 'rgba(214,226,237,0.18)');
    g.addColorStop(1, 'rgba(212,224,236,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
    this._blob = cv;
    return cv;
  }

  // ---- осадки -------------------------------------------------------------
  _updatePrecip(sim, dt, rect, areaK) {
    const kind = this.kind;
    const target = kind
      ? Math.min(LIMITS.precip, Math.round(BASE[kind] * this.q.particles * areaK * (0.35 + 0.65 * this.fade)))
      : 0;
    if (target > this.nPrecip) {
      for (let i = this.nPrecip; i < target; i++) this._seedPrecip(this.precip[i], kind, rect, true);
    }
    this.nPrecip = target;
    if (!target) return;

    const wind = this.wind;
    for (let i = 0; i < this.nPrecip; i++) {
      const p = this.precip[i];
      p.y += p.vy * dt;
      if (kind === 'rain') {
        p.x += wind * p.vy * 0.55 * dt;
      } else if (kind === 'snow') {
        // Хлопья не падают отвесно: сносит ветром и качает вокруг своей оси.
        p.x += (wind * p.vy * 0.8 + Math.sin(this.time * 1.6 + p.ph) * p.sp) * dt;
      } else {
        p.x += (wind * p.vy * 0.9 + Math.sin(this.time * 2.2 + p.ph) * p.sp) * dt;
        p.ph += dt * 2.5;
      }
      // Заворот в видимый прямоугольник: частица живёт в мире, но всегда
      // остаётся в кадре — при панораме дождь не «отстаёт» и не липнет к экрану.
      const m = 1.5;
      if (p.y > rect.y1 + m) { this._seedPrecip(p, kind, rect, false); continue; }
      const w = rect.x1 - rect.x0 + m * 2;
      if (p.x < rect.x0 - m) p.x += w;
      else if (p.x > rect.x1 + m) p.x -= w;
    }
  }

  _seedPrecip(p, kind, rect, anywhere) {
    const r = this.rnd;
    const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
    p.x = rect.x0 - 1.5 + r() * (w + 3);
    p.y = anywhere ? rect.y0 + r() * h : rect.y0 - 1.5 - r() * 2.5;
    p.d = (r() * 3) | 0;               // слой глубины: 0 дальний, 2 ближний
    p.ph = r() * 6.283;
    if (kind === 'rain') {
      p.vy = (13 + r() * 5) * (0.8 + p.d * 0.22);
      p.len = 0.34 + p.d * 0.2 + r() * 0.1;
      p.sp = 0;
    } else if (kind === 'snow') {
      p.vy = (0.9 + r() * 0.7) * (0.7 + p.d * 0.5);
      p.len = 0.022 + p.d * 0.028 + r() * 0.01;   // радиус хлопья в тайлах
      p.sp = 0.5 + p.d * 0.35 + r() * 0.3;        // размах качания
    } else {
      p.vy = (0.8 + r() * 0.5) * (0.7 + p.d * 0.4);
      p.len = 0.07 + p.d * 0.02;
      p.sp = 0.7 + r() * 0.6;
    }
  }

  _drawRain(ctx, ox, oy, z) {
    // Три прохода по слоям: стиль ставится трижды за кадр, а не 260 раз.
    // Дальние струи тоньше и бледнее, ближние — толще, длиннее и быстрее.
    const A = [0.26, 0.4, 0.58], W = [0.9, 1.35, 2.1];
    const zk = Math.max(0.55, Math.min(1.7, z / 32));
    const wind = this.wind;
    ctx.save();
    ctx.lineCap = 'round';
    for (let d = 0; d < 3; d++) {
      ctx.strokeStyle = `rgba(206,224,248,${A[d] * this.fade})`;
      ctx.lineWidth = W[d] * zk;
      ctx.beginPath();
      for (let i = 0; i < this.nPrecip; i++) {
        const p = this.precip[i];
        if (p.d !== d) continue;
        const sx = ox + p.x * z, sy = oy + p.y * z;
        const len = p.len * z;
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + wind * len * 0.55, sy + len);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawSnow(ctx, ox, oy, z, cw, ch) {
    const A = [0.42, 0.66, 0.92];
    ctx.save();
    // Зимой земля сама белая: без холодной подложки ближние хлопья на ней
    // растворяются. Один лишний проход по ближнему слою решает это.
    if (this.q.detail >= 1) {
      ctx.fillStyle = `rgba(96,124,164,${0.22 * this.fade})`;
      ctx.beginPath();
      for (let i = 0; i < this.nPrecip; i++) {
        const p = this.precip[i];
        if (p.d !== 2) continue;
        const sx = ox + p.x * z, sy = oy + p.y * z;
        if (sx < -8 || sy < -8 || sx > cw + 8 || sy > ch + 8) continue;
        const r = Math.max(1.2, p.len * z * 1.55);
        ctx.moveTo(sx + r, sy);
        ctx.arc(sx, sy, r, 0, 6.283);
      }
      ctx.fill();
    }
    for (let d = 0; d < 3; d++) {
      ctx.fillStyle = `rgba(240,246,255,${A[d] * this.fade})`;
      ctx.beginPath();
      for (let i = 0; i < this.nPrecip; i++) {
        const p = this.precip[i];
        if (p.d !== d) continue;
        const sx = ox + p.x * z, sy = oy + p.y * z;
        if (sx < -6 || sy < -6 || sx > cw + 6 || sy > ch + 6) continue;
        const r = Math.max(0.7, p.len * z);
        // moveTo перед каждой дугой обязателен: без него дуги соединяются
        // отрезками и вместо хлопьев получается паутина.
        ctx.moveTo(sx + r, sy);
        ctx.arc(sx, sy, r, 0, 6.283);
      }
      ctx.fill();
    }
    ctx.restore();
  }

  _drawLeaves(ctx, ox, oy, z) {
    ctx.save();
    ctx.fillStyle = `rgba(181,114,47,${0.72 * this.fade})`;
    for (let i = 0; i < this.nPrecip; i++) {
      const p = this.precip[i];
      const sx = ox + p.x * z, sy = oy + p.y * z;
      const w = Math.max(1.2, p.len * z);
      // Лист кувыркается: ширина «дышит» по фазе, высота постоянна.
      ctx.fillRect(sx, sy, w * Math.abs(Math.cos(p.ph)), Math.max(1, w * 0.6));
    }
    ctx.restore();
  }

  // ---- круги на воде ------------------------------------------------------
  _updateRipples(sim, dt, rect) {
    // Живые круги стареют; мёртвые вытесняются последним из активной головы.
    for (let i = 0; i < this.nRip; i++) {
      const r = this.ripples[i];
      r.t += dt;
      if (r.t >= r.life) {
        const last = this.ripples[--this.nRip];
        this.ripples[this.nRip] = r;
        this.ripples[i] = last;
        i--;
      }
    }
    if (this.kind !== 'rain' || this.fade <= 0.2) return;
    const cap = Math.min(LIMITS.ripple, Math.round(LIMITS.ripple * Math.min(1, this.q.particles * 1.25)));
    this.ripAcc += 48 * this.q.particles * this.fade * dt;
    let guard = 12;
    while (this.ripAcc >= 1 && guard-- > 0) {
      this.ripAcc -= 1;
      if (this.nRip >= cap) break;
      // Воды в кадре обычно единицы процентов, поэтому точку ищем в несколько
      // попыток и вода выигрывает: иначе на озере видно один круг в секунду,
      // а весь бюджет уходит на всплески по траве.
      let x = 0, y = 0, water = false;
      for (let a = 0; a < 6; a++) {
        x = rect.x0 + this.rnd() * (rect.x1 - rect.x0);
        y = rect.y0 + this.rnd() * (rect.y1 - rect.y0);
        const t = tileAt(sim.world, x, y);
        water = t === TILE.WATER || t === TILE.DEEP;
        if (water) break;
      }
      // На суше всплеск ставим только на высоких пресетах: там он читается,
      // на средних — просто лишние сотни отрезков в кадре.
      if (!water && (this.q.detail < 2 || this.rnd() > 0.3)) continue;
      const r = this.ripples[this.nRip++];
      r.x = x; r.y = y; r.t = 0; r.land = !water;
      r.life = water ? 0.75 + this.rnd() * 0.5 : 0.22 + this.rnd() * 0.12;
    }
  }

  _drawRipples(ctx, ox, oy, z) {
    if (!this.nRip) return;
    ctx.save();
    ctx.lineWidth = Math.max(0.7, z / 40);
    for (let i = 0; i < this.nRip; i++) {
      const r = this.ripples[i];
      const k = r.t / r.life;
      const sx = ox + r.x * z, sy = oy + r.y * z;
      if (r.land) {
        // Всплеск на земле: короткая вертикальная искра.
        ctx.strokeStyle = `rgba(206,224,246,${0.5 * (1 - k)})`;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx, sy - z * 0.07 * (1 - k));
        ctx.stroke();
        continue;
      }
      // Круг на воде: расходится и гаснет, второй — вдогонку первому.
      const rad = z * (0.04 + 0.3 * smooth(k));
      ctx.strokeStyle = `rgba(232,244,255,${0.62 * (1 - k)})`;
      ctx.beginPath();
      ctx.ellipse(sx, sy, rad, rad * 0.62, 0, 0, 6.283);
      ctx.stroke();
      if (k > 0.32) {
        const r2 = z * (0.04 + 0.3 * smooth(k - 0.32));
        ctx.strokeStyle = `rgba(232,244,255,${0.3 * (1 - k)})`;
        ctx.beginPath();
        ctx.ellipse(sx, sy, r2, r2 * 0.62, 0, 0, 6.283);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ---- туман --------------------------------------------------------------
  _updateFog(sim, dt, rect) {
    const target = this.fogK > 0.01
      ? Math.min(LIMITS.fog, Math.round(LIMITS.fog * Math.min(1, this.q.particles * 1.2)))
      : 0;
    if (target > this.nFog) for (let i = this.nFog; i < target; i++) this._seedFog(this.fog[i], rect, true);
    this.nFog = target;
    if (!target) return;

    for (let i = 0; i < this.nFog; i++) {
      const f = this.fog[i];
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      // Туман стоит в низинах: над холмом и горой он тает. Коэффициент
      // подтягивается плавно, иначе пятно моргает на границе тайлов.
      const t = tileAt(sim.world, f.x, f.y);
      const h = TILE_HEIGHT[t] ?? 0;
      const lowT = h > 0.45 ? 0.05 : h > 0.2 ? 0.35 : (t === TILE.WATER || t === TILE.DEEP) ? 1.15 : 1;
      f.low += (lowT - f.low) * Math.min(1, dt * 1.2);
      const m = f.r;
      if (f.x < rect.x0 - m || f.x > rect.x1 + m || f.y < rect.y0 - m || f.y > rect.y1 + m) {
        this._seedFog(f, rect, false);
      }
    }
  }

  _seedFog(f, rect, anywhere) {
    const r = this.rnd;
    const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
    f.r = 2.6 + r() * 4.5;
    if (anywhere) {
      f.x = rect.x0 + r() * w;
      f.y = rect.y0 + r() * h;
    } else {
      // Заходит с наветренной стороны, чтобы пятна не появлялись в центре кадра.
      const fromLeft = this.wind > 0;
      f.x = fromLeft ? rect.x0 - f.r : rect.x1 + f.r;
      f.y = rect.y0 + r() * h;
    }
    f.a = 0.3 + r() * 0.4;
    f.vx = this.wind * (0.25 + r() * 0.25);
    f.vy = (r() - 0.5) * 0.12;
    f.low = 0.5;
    f.ph = r() * 6.283;
  }

  // ---- пыль зноя ----------------------------------------------------------
  _updateDust(dt, rect, areaK) {
    const target = this.heatK > 0.01
      ? Math.min(LIMITS.dust, Math.round(LIMITS.dust * this.q.particles * areaK * this.heatK))
      : 0;
    if (target > this.nDust) for (let i = this.nDust; i < target; i++) this._seedDust(this.dust[i], rect, true);
    this.nDust = target;
    if (!target) return;
    for (let i = 0; i < this.nDust; i++) {
      const p = this.dust[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const m = 1;
      if (p.x < rect.x0 - m || p.x > rect.x1 + m || p.y < rect.y0 - m || p.y > rect.y1 + m) this._seedDust(p, rect, false);
    }
  }

  _seedDust(p, rect, anywhere) {
    const r = this.rnd;
    const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
    p.y = rect.y0 + r() * h;
    p.x = anywhere ? rect.x0 + r() * w : (this.wind > 0 ? rect.x0 - 0.5 : rect.x1 + 0.5);
    p.vx = this.wind * (0.6 + r() * 0.9) + (r() - 0.5) * 0.2;
    p.vy = (r() - 0.5) * 0.25;
    p.r = 0.03 + r() * 0.045;
    p.a = 0.3 + r() * 0.35;
    p.ph = r() * 6.283;
  }
}

/* ПОДКЛЮЧЕНИЕ */
//
// Ниже — точные строки для app/src/render/renderer.js. Сам renderer.js этим
// агентом НЕ ТРОГАЛСЯ: вставлять руками.
//
// 1) Импорт — после строки
//      import { QUALITY, guessQuality, loadQualityId, saveQualityId, makeAutoTuner } from './quality.js';
//    добавить:
//
//      import { Atmosphere } from './weather.js';
//
// 2) Конструктор Renderer — после строки `this.art.preload();` добавить:
//
//      this.atmo = new Atmosphere(this.quality);
//
// 3) setQuality(id) — после строки `this.beasts.setQuality(this.quality);` добавить:
//
//      this.atmo.setQuality(this.quality);
//
//    То же самое в tuneAuto(dtReal), после такой же строки `this.beasts.setQuality(...)`.
//
// 4) draw() — сразу после блока местности, то есть после строки
//      if (this.quality.water) this.terrain.drawWater(ctx, sim, ox, oy, z, cw, ch, this.time);
//    добавить две строки (обновление состояния + мокрая земля и круги на воде;
//    именно здесь, до зданий, иначе дождь мочит крыши):
//
//      this.atmo.update(sim, dtReal, ox, oy, z, cw, ch);
//      this.atmo.drawGround(sim, ctx, ox, oy, z, cw, ch);
//
// 5) draw() — строку
//      this.drawWeather(sim, ctx, cw, ch, dtReal);
//    заменить на:
//
//      this.atmo.drawOverlay(sim, ctx, ox, oy, z, cw, ch);
//
//    Метод drawWeather после этого не вызывается ниоткуда и его можно удалить
//    целиком вместе с полем this.particles в конструкторе: осадки, листопад
//    и плотность по площади экрана перешли сюда.
//
// 6) draw() — блок из двух заливок
//      if (L.tint[3] > 0.008) { ... ctx.fillRect(0, 0, cw, ch); }
//      const wt = WEATHER_TINT[sim.weather];
//      if (wt && wt.tint[3] > 0.008) { ... ctx.fillRect(0, 0, cw, ch); }
//    заменить одной строкой:
//
//      this.atmo.drawTone(sim, ctx, cw, ch, L);
//
//    После этого импорт WEATHER_TINT в renderer.js больше не нужен — если он
//    нигде не используется, esbuild промолчит, но строку лучше почистить.
//
// ПОРЯДОК ВАЖЕН: drawGround до зданий, drawOverlay после зданий и жителей,
// drawTone после лучей неба и до виньетки с зерном.
//
// Пресеты: на 'eco' модуль не рисует ни одной частицы, ни тумана, ни дымки —
// drawTone сводится ровно к двум прежним fillRect. Плотность частиц идёт от
// quality.particles и площади экрана, всплески на суше и подъём насыщенности
// мокрой земли — от quality.detail.
