// render/renderer.js — канвас-рендер (presentation-слой; ядро о нём не знает).
// Процедурные спрайты эпох: здания эволюционируют визуально от шкур до стекла.
// Местность, свет и погодные эффекты — см. terrain.js / palette.js / quality.js.
import { TILE, ERAS, BUILDINGS, BUILDING_ERA_IDX, SPIRE_STAGES, SEASONS, WEATHER } from '../core/data.js';
import { tileAt } from '../core/world.js';
import { Terrain } from './terrain.js';
import { SpriteCache } from './sprites.js';
import { PeopleSprites, AnimalSprites, professionOf, lookOf } from './people.js';
import { ArtPack } from './artpack.js';
import { QUALITY, guessQuality, loadQualityId, saveQualityId, makeAutoTuner } from './quality.js';
import { Atmosphere } from './weather.js';
import { WaterLayer } from './water.js';
import { Vegetation } from './vegetation.js';
import { FxLayer } from './fx.js';
import { lightAt, WEATHER_TINT, hash2 } from './palette.js';

const TILE_PX = 32; // мировая единица «тайл→экран» при zoom=1 — НЕ зависит от пресета графики

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: 48, y: 48, zoom: 1 };
    this.particles = [];
    this.fireflies = [];
    this.birds = [];
    this.clouds = null;
    this.cloudsSeed = null;
    this.time = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.grain = null;
    this.grainAge = 0;

    this.qualityId = loadQualityId();
    this.quality = QUALITY[this.qualityId === 'auto' ? guessQuality() : this.qualityId];
    this.autoTuner = this.qualityId === 'auto' ? makeAutoTuner(this.quality.id) : null;
    this.terrain = new Terrain(this.quality);
    this.sprites = new SpriteCache(this.quality);
    this.people = new PeopleSprites(this.quality);
    this.beasts = new AnimalSprites(this.quality);
    // Состояние анимации жителей живёт СНАРУЖИ симуляции: рендер читает
    // положение и сам считает направление и фазу шага.
    this.vstate = new WeakMap();
    // Нарисованный арт, если он завезён. Отсутствие файлов — не ошибка:
    // здание просто останется процедурным.
    this.art = new ArtPack();
    this.art.preload();
    this.atmo = new Atmosphere(this.quality);
    this.water = new WaterLayer(this.quality);
    this.veg = new Vegetation(this.quality);
    this.fx = new FxLayer(this.quality);
  }

  // id ∈ QUALITY_ORDER или 'auto'
  setQuality(id) {
    this.qualityId = id;
    saveQualityId(id);
    if (id === 'auto') {
      this.autoTuner = makeAutoTuner('high');
      this.quality = QUALITY[this.autoTuner.current];
    } else {
      this.autoTuner = null;
      this.quality = QUALITY[id];
    }
    this.terrain.setQuality(this.quality);
    this.sprites.setQuality(this.quality);
    this.people.setQuality(this.quality);
    this.beasts.setQuality(this.quality);
    this.atmo.setQuality(this.quality);
    this.water.setQuality(this.quality);
    this.veg.setQuality(this.quality);
    this.fx.setQuality(this.quality);
    this.dpr = Math.min(this.quality.maxDpr, window.devicePixelRatio || 1);
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  screenToWorld(sx, sy) {
    return {
      x: this.cam.x + (sx - this.canvas.width / this.dpr / 2) / (TILE_PX * this.cam.zoom),
      y: this.cam.y + (sy - this.canvas.height / this.dpr / 2) / (TILE_PX * this.cam.zoom),
    };
  }
  worldToScreen(wx, wy) {
    return {
      x: (wx - this.cam.x) * TILE_PX * this.cam.zoom + this.canvas.width / this.dpr / 2,
      y: (wy - this.cam.y) * TILE_PX * this.cam.zoom + this.canvas.height / this.dpr / 2,
    };
  }

  // ---------------------------------------------------------------------
  draw(sim, dtReal) {
    this.time += dtReal;
    this.tuneAuto(dtReal);

    const ctx = this.ctx;
    const dpr = this.dpr;
    const cw = this.canvas.width / dpr, ch = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const L = lightAt(sim.dayTime);
    ctx.fillStyle = L.sky;
    ctx.fillRect(0, 0, cw, ch);

    const z = TILE_PX * this.cam.zoom;
    const ox = cw / 2 - this.cam.x * z, oy = ch / 2 - this.cam.y * z;

    // --- местность (чанками, рельефное освещение, береговая линия) ---
    this.terrain.draw(ctx, sim, ox, oy, z, cw, ch);
    // Богатая вода (отражения, гребни, прибой, лёд) только там, где есть запас
    // производительности. Замер на программном растеризаторе: 62 -> 26 FPS,
    // то есть модуль съедает больше половины кадра. На настоящем GPU он
    // наверняка дешевле, но проверить это здесь нечем, поэтому по умолчанию
    // включаем только на верхних пресетах, а ниже оставляем прежнюю заливку.
    if (this.quality.richWater) this.water.draw(sim, ctx, ox, oy, z, cw, ch, dtReal, L);
    else if (this.quality.water) this.terrain.drawWater(ctx, sim, ox, oy, z, cw, ch, this.time);
    this.atmo.update(sim, dtReal, ox, oy, z, cw, ch);
    this.fx.update(sim, dtReal, ox, oy, z, cw, ch);
    this.atmo.drawGround(sim, ctx, ox, oy, z, cw, ch);

    // --- тени облаков (мировые координаты — не дрожат при панораме) ---
    if (this.quality.clouds) this.drawClouds(sim, ctx, ox, oy, z, cw, ch);

    // --- территории фракций ---
    if (sim.showTerritory) this.drawTerritory(sim, ctx, ox, oy, z);

    // --- поселения фракций ---
    for (const f of sim.factions) {
      if (!f.alive) continue;
      for (const s of f.settlements) {
        const sx = ox + s.x * z, sy = oy + s.y * z;
        if (sx < -60 || sy < -60 || sx > cw + 60 || sy > ch + 60) continue;
        this.drawFactionSettlement(ctx, sx, sy, z, f, s, sim);
      }
    }

    // --- единый проход по глубине: здания + жители + животные, сортировка по Y ---
    this.drawSortedEntities(sim, ctx, ox, oy, z, cw, ch, L);
    this.fx.drawWorld(ctx, ox, oy, z, cw, ch);

    // --- призрак стройки ---
    if (sim.placing) {
      const g = sim.placing;
      const sx = ox + g.x * z, sy = oy + g.y * z;
      const size = (BUILDINGS[g.id].size || 1) * z;
      ctx.fillStyle = g.valid ? 'rgba(120,220,120,0.45)' : 'rgba(220,90,90,0.45)';
      ctx.fillRect(sx, sy, size, size);
      ctx.strokeStyle = g.valid ? '#7de37d' : '#e37d7d';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx, sy, size, size);
      if (!g.valid && g.reason) {
        ctx.fillStyle = '#ffd7d7';
        ctx.font = `${Math.max(12, z * 0.35)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(g.reason, sx + size / 2, sy - 6);
      }
    }

    // --- маркер рейда ---
    if (sim.raids.warning) {
      const f = sim.factions.find(q => q.id === sim.raids.from);
      const from = f && f.settlements[0] ? f.settlements[0] : { x: 0, y: 0 };
      const c1 = this.worldToScreen(sim.world.startX, sim.world.startY);
      const c2 = this.worldToScreen(from.x, from.y);
      ctx.strokeStyle = `rgba(255,60,60,${0.5 + 0.3 * Math.sin(this.time * 6)})`;
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.moveTo(c2.x, c2.y); ctx.lineTo(c1.x, c1.y); ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- атмосферная живность ---
    if (this.quality.fireflies) this.drawFireflies(sim, ctx, ox, oy, z, cw, ch, dtReal, L);
    if (this.quality.birds) this.drawBirds(ctx, cw, ch, dtReal, L);

    // --- погода (дождь/снег/листья), плотность урезается пресетом ---
    this.atmo.drawOverlay(sim, ctx, ox, oy, z, cw, ch);

    // --- свет по времени суток + погодный тон ---
    if (L.tint[3] > 0.008) {
      ctx.fillStyle = `rgba(${L.tint[0]},${L.tint[1]},${L.tint[2]},${L.tint[3]})`;
      ctx.fillRect(0, 0, cw, ch);
    }
    const wt = WEATHER_TINT[sim.weather];
    if (wt && wt.tint[3] > 0.008) {
      ctx.fillStyle = `rgba(${wt.tint[0]},${wt.tint[1]},${wt.tint[2]},${wt.tint[3]})`;
      ctx.fillRect(0, 0, cw, ch);
    }

    // --- рассветные/закатные лучи ---
    if (this.quality.godRays) this.drawGodRays(ctx, cw, ch, L);
    this.fx.drawSky(ctx, cw, ch);

    // --- луч Шпиля (поверх тона, чтобы светился и ночью, и днём) ---
    const sp = sim.buildings.find(b => b.id === 'spire' && !b.destroyed);
    if (sp && sim.spire.stage >= 4) {
      const sx = ox + sp.x * z + z, sy = oy + sp.y * z;
      const grad = ctx.createLinearGradient(sx, sy, sx, 0);
      grad.addColorStop(0, 'rgba(125,227,255,0.7)');
      grad.addColorStop(1, 'rgba(125,227,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(sx - z * 0.12, 0, z * 0.24, sy);
    }

    // --- пост-обработка: виньетка, зерно ---
    if (this.quality.vignette) this.drawVignette(ctx, cw, ch);
    if (this.quality.grain > 0) this.drawGrain(ctx, cw, ch);

    // --- миникарта (без пост-эффектов) ---
    this.fx.drawLabels(ctx, ox, oy, z, cw, ch);
    this.drawMinimap(sim, ctx, cw, ch);
  }

  // ---------------------------------------------------------------------
  tuneAuto(dtReal) {
    if (!this.autoTuner) return;
    const next = this.autoTuner.sample(dtReal);
    if (next) {
      this.quality = QUALITY[next];
      this.terrain.setQuality(this.quality);
      this.sprites.setQuality(this.quality);
      this.people.setQuality(this.quality);
      this.beasts.setQuality(this.quality);
    this.atmo.setQuality(this.quality);
    this.water.setQuality(this.quality);
    this.veg.setQuality(this.quality);
    this.fx.setQuality(this.quality);
      this.dpr = Math.min(this.quality.maxDpr, window.devicePixelRatio || 1);
      this.resize();
    }
  }

  // ---------------------------------------------------------------------
  // Единый Y-проход зданий/жителей/животных — иначе житель, стоящий "перед"
  // высоким зданием, рисовался бы поверх его крыши (реальный баг прежней версии,
  // где жители/животные всегда шли отдельными слоями ПОСЛЕ всех зданий).
  drawSortedEntities(sim, ctx, ox, oy, z, cw, ch, L) {
    this._pendingGlow = [];
    const items = [];
    for (const b of sim.buildings) {
      if (b.destroyed) continue;
      const sx = ox + b.x * z, sy = oy + b.y * z;
      const size = (b.size || 1) * z;
      if (sx < -100 || sy < -160 || sx > cw + 100 || sy > ch + 100) continue;
      items.push({ y: b.y + (b.size || 1), kind: 'b', b, sx, sy, size });
    }
    for (const v of sim.villagers) {
      const sx = ox + v.x * z, sy = oy + v.y * z;
      if (sx < -20 || sy < -20 || sx > cw + 20 || sy > ch + 20) continue;
      items.push({ y: v.y + 0.05, kind: 'v', v, sx, sy });
    }
    for (const a of sim.animals) {
      const sx = ox + a.x * z, sy = oy + a.y * z;
      if (sx < -20 || sy < -20 || sx > cw + 20 || sy > ch + 20) continue;
      items.push({ y: a.y + 0.05, kind: 'a', a, sx, sy });
    }
    items.sort((p, q) => p.y - q.y);
    for (const it of items) {
      if (it.kind === 'b') this.drawBuilding(sim, ctx, it.b, it.sx, it.sy, it.size);
      else if (it.kind === 'v') this.drawVillager(ctx, it.sx, it.sy, z, it.v, sim.eraIndex);
      else this.drawAnimal(ctx, it.sx, it.sy, z, it.a);
    }
    // Свечение окон: карта свечения испечена вместе со спрайтом, поэтому светятся
    // ровно окна и горны, а не абстрактный кружок в центре здания, как раньше.
    if (L.glow > 0.03 && this._pendingGlow.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = L.glow;
      for (const g of this._pendingGlow) ctx.drawImage(g.spr.glow, g.dx, g.dy, g.dw, g.dh);
      if (this.quality.bloom) {
        // мягкий ореол вокруг светящихся мест
        ctx.globalAlpha = 0.35 * L.glow;
        const halo = this.glowSprite(sim.eraIndex < 7);
        for (const g of this._pendingGlow) {
          const r = g.dw * 0.55;
          ctx.drawImage(halo, g.dx + g.dw / 2 - r, g.dy + g.dh * 0.55 - r, r * 2, r * 2);
        }
      }
      ctx.restore();
    }
    this._pendingGlow.length = 0;
  }

  // Мягкий ореол свечения — ОДИН раз в offscreen-канвас, дальше только blit.
  // Раньше здесь стоял ctx.filter='blur()' на каждое окно каждый кадр: именно он
  // ронял 60 FPS до девяти на большом городе.
  glowSprite(warm) {
    const key = warm ? '_glowWarm' : '_glowCold';
    if (this[key]) return this[key];
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    const col = warm ? '255,190,90' : '140,220,255';
    g.addColorStop(0, `rgba(${col},0.85)`);
    g.addColorStop(0.35, `rgba(${col},0.32)`);
    g.addColorStop(1, `rgba(${col},0)`);
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
    this[key] = cv;
    return cv;
  }

  drawAnimal(ctx, sx, sy, z, a) {
    // Звери используют тот же механизм, что и жители: печёный лист и фаза
    // шага от пройденного пути.
    const st = this.villagerState(a);
    const sh = this.beasts.sheet(a.kind);
    const h = Math.max(10, z * (a.kind === 'mammoth' ? 1.05 : 0.68));
    const w = h * (sh.fw / sh.fh);
    const frame = st.still > 2 ? 0 : ((st.walk / 0.7 * 2) | 0) % 2;
    const dir = st.dir === 1 ? 1 : 0;   // спрайт двусторонний: влево / вправо
    ctx.drawImage(
      sh.cv, frame * sh.fw, dir * sh.fh, sh.fw, sh.fh,
      Math.round(sx - w / 2), Math.round(sy - h * 0.93), Math.round(w), Math.round(h),
    );
  }

  drawFactionSettlement(ctx, sx, sy, z, f, s, sim) {
    const col = f.def.color;
    const n = s.capital ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const bx = sx + ((i % 3) - 1) * z * 0.8, by = sy + (Math.floor(i / 3) - 0.5) * z * 0.8;
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(bx - z * 0.25, by - z * 0.25, z * 0.5, z * 0.5);
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(bx - z * 0.25, by - z * 0.05, z * 0.5, z * 0.3);
    }
    if (s.capital) {
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sx, sy - z); ctx.lineTo(sx, sy - z * 2.2); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(sx, sy - z * 2.2); ctx.lineTo(sx + z * 0.9, sy - z * 1.9); ctx.lineTo(sx, sy - z * 1.6);
      ctx.fill();
    }
  }

  drawTerritory(sim, ctx, ox, oy, z) {
    const cw = this.canvas.width / this.dpr, ch = this.canvas.height / this.dpr;
    const step = Math.max(1, Math.floor(2 / this.cam.zoom));
    const x0 = Math.max(0, Math.floor(this.cam.x - cw / 2 / z)), x1 = Math.min(sim.world.w, Math.ceil(this.cam.x + cw / 2 / z));
    const y0 = Math.max(0, Math.floor(this.cam.y - ch / 2 / z)), y1 = Math.min(sim.world.h, Math.ceil(this.cam.y + ch / 2 / z));
    const centers = [];
    for (const f of sim.factions) if (f.alive) for (const s of f.settlements) centers.push({ x: s.x, y: s.y, col: f.def.color, P: f.P });
    centers.push({ x: sim.world.startX, y: sim.world.startY, col: '#c9a227', P: sim.villagers.length * 3 });
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        let best = null, bestV = 0;
        for (const c of centers) {
          const d2 = (c.x - x) ** 2 + (c.y - y) ** 2;
          const v = c.P / (1 + d2 * 0.15);
          if (v > bestV) { bestV = v; best = c; }
        }
        if (best && bestV > 0.35) {
          ctx.fillStyle = best.col + '33';
          ctx.fillRect(ox + x * z, oy + y * z, z * step, z * step);
        }
      }
    }
  }

  // --- процедурный спрайт здания, эволюционирующий по эпохам ---
  drawBuilding(sim, ctx, b, sx, sy, size) {
    const def = BUILDINGS[b.id];
    // Здание подтягивается к текущей эпохе, но не более чем на три ступени от
    // собственной: иначе в информационную эпоху ВСЕ 55 построек, включая хижину
    // и кострище, красились в одно бледное стекло и город терял читаемость.
    // С ограничением старые кварталы остаются глиняными и деревянными.
    const own = BUILDING_ERA_IDX[b.id] || 0;
    const e = Math.max(own, Math.min(9, Math.min(sim.eraIndex, own + 3)));
    if (!b.done) {
      ctx.fillStyle = 'rgba(139,109,66,0.5)';
      ctx.fillRect(sx + 2, sy + 2, size - 4, size - 4);
      ctx.strokeStyle = '#8b6d42';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(sx + 2, sy + 2, size - 4, size - 4);
      ctx.setLineDash([]);
      const p = b.progress / b.buildDays;
      ctx.fillStyle = '#c9a227';
      ctx.fillRect(sx + 2, sy + size - 6, (size - 4) * Math.min(1, p), 4);
      return;
    }
    // Шпиль анимирован по стадиям стройки — единственная постройка вне кэша.
    if (b.id === 'spire') {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.ellipse(sx + size / 2, sy + size * 0.85, size * 0.42, size * 0.14, 0, 0, 7); ctx.fill();
      this.drawSpire(ctx, sx, sy, size, sim.spire.stage, this.time);
      ctx.restore();
      return;
    }

    // Нарисованный спрайт имеет приоритет над процедурным.
    const painted = this.art.building(b.id);
    if (painted) {
      const dw = size * 1.5;
      const dh = dw * (painted.naturalHeight / painted.naturalWidth);
      const dx = sx + size / 2 - dw / 2, dy = sy + size - dh;
      // Отдельную тень не рисуем: у нарисованного арта она запечена в спрайт
      // самим промтом («small dark contact shadow hugging the base»).
      ctx.drawImage(painted, dx, dy, dw, dh);
      return;
    }

    const spr = this.sprites.building(b.id, def, e, b.size || 1);
    // Чуть шире клетки: постройка ровно в тайл смотрится игрушечной рядом с
    // жителем, а свесы крыш и трубы всё равно выходят за пятно застройки.
    const dw = size * 1.16, dh = dw * spr.hFact;
    const dx = sx - size * 0.08, dy = sy + size - dh;

    // Тень падает по солнцу: утром и вечером длинная, в полдень короткая.
    if (this.quality.shadows) {
      const L = lightAt(sim.dayTime);
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.translate(sx + size / 2, sy + size * 0.9);
      ctx.transform(1, 0, Math.cos(L.sunAz) * L.shadowLen * 0.8, 0.34 * L.shadowLen, 0, 0);
      ctx.drawImage(spr.sil, -size / 2, -dh, dw, dh);
      ctx.restore();
    }

    ctx.drawImage(spr.cv, dx, dy, dw, dh);
    this._pendingGlow.push({ spr, dx, dy, dw, dh });
  }

  buildingCategory(id, def) {
    if (def.housing) return 'house';
    if (def.out && (def.out.wood || def.out.stone || def.out.steel || def.out.food || def.out.gold)) return 'production';
    if (def.out && def.out.knowledge) return 'science';
    if (def.defense || def.armyMult || id === 'barracks') return 'military';
    if (def.happy || def.medicine) return 'culture';
    return 'generic';
  }

  eraPalette(e) {
    const pals = [
      { wall: '#8a6d4f', roof: '#6b4f35', trim: '#5d4a33' },
      { wall: '#c4a06a', roof: '#8a6d42', trim: '#a0522d' },
      { wall: '#9a8a72', roof: '#4a4a52', trim: '#3d3d45' },
      { wall: '#e8e0c8', roof: '#b08d57', trim: '#8a7a5a' },
      { wall: '#b59a7a', roof: '#8a3d2d', trim: '#6b4f35' },
      { wall: '#d4c4a0', roof: '#a0522d', trim: '#8a6d42' },
      { wall: '#9a6a52', roof: '#4a3d35', trim: '#3d3229' },
      { wall: '#aab4bc', roof: '#5a6b7a', trim: '#4aa3c7' },
      { wall: '#c8d4e8', roof: '#4a5a7a', trim: '#7d9de8' },
      { wall: '#e8f4f8', roof: '#2d4a5a', trim: '#7de3ff' },
    ];
    return pals[e];
  }

  drawHouse(ctx, sx, sy, size, e, pal, id) {
    const pad = size * 0.12;
    if (e === 0) {
      ctx.fillStyle = pal.wall;
      ctx.beginPath();
      ctx.moveTo(sx + pad, sy + size - pad);
      ctx.lineTo(sx + size / 2, sy + pad);
      ctx.lineTo(sx + size - pad, sy + size - pad);
      ctx.fill();
      ctx.strokeStyle = pal.trim; ctx.stroke();
    } else if (e < 3) {
      ctx.fillStyle = pal.wall;
      ctx.fillRect(sx + pad, sy + size * 0.35, size - pad * 2, size * 0.65 - pad);
      ctx.fillStyle = pal.roof;
      ctx.beginPath();
      ctx.moveTo(sx + pad * 0.6, sy + size * 0.38);
      ctx.lineTo(sx + size / 2, sy + pad * 0.6);
      ctx.lineTo(sx + size - pad * 0.6, sy + size * 0.38);
      ctx.fill();
    } else if (e < 6) {
      ctx.fillStyle = pal.wall;
      ctx.fillRect(sx + pad, sy + size * 0.3, size - pad * 2, size * 0.7 - pad);
      ctx.fillStyle = pal.roof;
      ctx.fillRect(sx + pad * 0.7, sy + pad, size - pad * 1.4, size * 0.22);
      ctx.fillStyle = pal.trim;
      ctx.fillRect(sx + size * 0.42, sy + size * 0.6, size * 0.16, size * 0.28);
    } else if (e < 8) {
      const floors = id === 'skyscraper' ? 3 : 2;
      ctx.fillStyle = pal.wall;
      ctx.fillRect(sx + pad, sy + pad, size - pad * 2, size - pad * 2);
      ctx.fillStyle = pal.trim;
      for (let f = 0; f < floors * 2; f++) for (let w = 0; w < 3; w++) {
        ctx.fillRect(sx + pad * 1.4 + w * size * 0.22, sy + pad * 1.4 + f * size * 0.14, size * 0.12, size * 0.08);
      }
    } else {
      ctx.fillStyle = 'rgba(200,240,255,0.85)';
      ctx.fillRect(sx + pad, sy + pad, size - pad * 2, size - pad * 2);
      ctx.strokeStyle = pal.trim;
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + pad, sy + pad, size - pad * 2, size - pad * 2);
      ctx.fillStyle = pal.trim;
      ctx.fillRect(sx + size * 0.45, sy + pad, size * 0.1, size - pad * 2);
    }
  }

  drawProduction(ctx, sx, sy, size, e, pal, id, time) {
    const pad = size * 0.14;
    ctx.fillStyle = pal.wall;
    ctx.fillRect(sx + pad, sy + size * 0.4, size - pad * 2, size * 0.6 - pad);
    ctx.fillStyle = pal.roof;
    ctx.fillRect(sx + pad * 0.8, sy + size * 0.28, size - pad * 1.6, size * 0.14);
    if (e >= 6 || id === 'smithy' || id === 'foundry') {
      ctx.fillStyle = '#5a4a42';
      ctx.fillRect(sx + size * 0.65, sy + pad * 0.4, size * 0.12, size * 0.35);
      const puff = (time * 2 + sx) % 1;
      ctx.fillStyle = `rgba(180,180,180,${0.4 * (1 - puff)})`;
      ctx.beginPath();
      ctx.arc(sx + size * 0.71, sy + pad * 0.4 - puff * size * 0.4, size * 0.08 * (1 + puff), 0, 7);
      ctx.fill();
    }
    ctx.fillStyle = pal.trim;
    ctx.fillRect(sx + size * 0.2, sy + size * 0.55, size * 0.2, size * 0.2);
  }

  drawScience(ctx, sx, sy, size, e, pal, id) {
    const pad = size * 0.12;
    ctx.fillStyle = pal.wall;
    ctx.fillRect(sx + pad, sy + size * 0.35, size - pad * 2, size * 0.65 - pad);
    ctx.fillStyle = pal.trim;
    if (e >= 3) {
      ctx.beginPath();
      ctx.arc(sx + size / 2, sy + size * 0.35, size * 0.22, Math.PI, 0);
      ctx.fill();
    } else {
      ctx.fillRect(sx + size * 0.4, sy + pad, size * 0.2, size * 0.3);
    }
    ctx.fillStyle = e >= 8 ? 'rgba(125,227,255,0.8)' : 'rgba(255,220,120,0.8)';
    ctx.fillRect(sx + size * 0.45, sy + size * 0.5, size * 0.1, size * 0.15);
  }

  drawMilitary(ctx, sx, sy, size, e, pal, id) {
    const pad = size * 0.1;
    ctx.fillStyle = pal.wall;
    ctx.fillRect(sx + pad, sy + size * 0.35, size - pad * 2, size * 0.65 - pad);
    ctx.fillStyle = pal.roof;
    for (let i = 0; i < 4; i++) ctx.fillRect(sx + pad + i * (size - pad * 2) / 4, sy + size * 0.26, (size - pad * 2) / 6, size * 0.1);
    if (id === 'castle') {
      ctx.fillRect(sx + pad, sy + pad * 0.6, size * 0.18, size * 0.4);
      ctx.fillRect(sx + size - pad - size * 0.18, sy + pad * 0.6, size * 0.18, size * 0.4);
    }
  }

  drawCulture(ctx, sx, sy, size, e, pal, id) {
    const pad = size * 0.12;
    ctx.fillStyle = pal.wall;
    ctx.fillRect(sx + pad, sy + size * 0.4, size - pad * 2, size * 0.6 - pad);
    ctx.fillStyle = pal.trim;
    if (id === 'temple' || id === 'amphitheater') {
      for (let i = 0; i < 3; i++) ctx.fillRect(sx + size * 0.25 + i * size * 0.18, sy + size * 0.45, size * 0.08, size * 0.3);
      ctx.beginPath();
      ctx.moveTo(sx + pad, sy + size * 0.42);
      ctx.lineTo(sx + size / 2, sy + pad);
      ctx.lineTo(sx + size - pad, sy + size * 0.42);
      ctx.fill();
    } else {
      ctx.fillRect(sx + size * 0.42, sy + pad, size * 0.16, size * 0.3);
    }
  }

  drawGeneric(ctx, sx, sy, size, e, pal, id) {
    const pad = size * 0.15;
    ctx.fillStyle = pal.wall;
    ctx.fillRect(sx + pad, sy + pad, size - pad * 2, size - pad * 2);
    ctx.fillStyle = pal.roof;
    ctx.fillRect(sx + pad, sy + pad, size - pad * 2, size * 0.15);
  }

  drawCampfire(ctx, cx, cy, size) {
    ctx.fillStyle = '#5a4a3a';
    ctx.beginPath(); ctx.arc(cx, cy + size * 0.15, size * 0.3, 0, 7); ctx.fill();
    const flick = 0.85 + 0.15 * Math.sin(this.time * 9);
    if (this.quality.bloom) {
      const halo = this.glowSprite(true);
      const r = size * 0.9 * flick;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5;
      ctx.drawImage(halo, cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
    }
    ctx.fillStyle = '#e8762d';
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.15, cy + size * 0.15);
    ctx.quadraticCurveTo(cx, cy - size * 0.45 * flick, cx + size * 0.15, cy + size * 0.15);
    ctx.fill();
    ctx.fillStyle = '#ffd25a';
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.07, cy + size * 0.15);
    ctx.quadraticCurveTo(cx, cy - size * 0.22 * flick, cx + size * 0.07, cy + size * 0.15);
    ctx.fill();
  }

  drawWall(ctx, sx, sy, size, stone) {
    ctx.fillStyle = stone ? '#8a8a92' : '#7a5f3d';
    ctx.fillRect(sx + size * 0.1, sy + size * 0.2, size * 0.8, size * 0.6);
    ctx.fillStyle = stone ? '#6a6a72' : '#5d4a2d';
    for (let i = 0; i < 3; i++) ctx.fillRect(sx + size * (0.12 + i * 0.28), sy + size * 0.1, size * 0.16, size * 0.15);
  }

  drawFarm(ctx, sx, sy, size, e, season) {
    const cols = ['#7a9e4f', '#c9a83f', '#b5722f', '#dce8e0'];
    ctx.fillStyle = cols[season];
    ctx.fillRect(sx + 2, sy + 2, size - 4, size - 4);
    ctx.strokeStyle = 'rgba(90,60,30,0.6)';
    ctx.lineWidth = 1.5;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(sx + 2, sy + (size - 4) * i / 4 + 2);
      ctx.lineTo(sx + size - 2, sy + (size - 4) * i / 4 + 2);
      ctx.stroke();
    }
  }

  drawPasture(ctx, sx, sy, size) {
    ctx.fillStyle = '#7a9e5f';
    ctx.fillRect(sx + 2, sy + 2, size - 4, size - 4);
    ctx.strokeStyle = '#8a6d42';
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(sx + 4, sy + 4, size - 8, size - 8);
    ctx.setLineDash([]);
    ctx.fillStyle = '#e8e0d0';
    ctx.beginPath(); ctx.arc(sx + size * 0.4, sy + size * 0.5, size * 0.1, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(sx + size * 0.65, sy + size * 0.6, size * 0.1, 0, 7); ctx.fill();
  }

  drawSpire(ctx, sx, sy, size, stage, time) {
    const cx = sx + size / 2;
    ctx.fillStyle = '#4a4a55';
    ctx.fillRect(sx + size * 0.1, sy + size * 0.75, size * 0.8, size * 0.2);
    if (stage >= 1) {
      ctx.fillStyle = '#6a6a75';
      ctx.fillRect(sx + size * 0.2, sy + size * 0.6, size * 0.6, size * 0.16);
    }
    if (stage >= 2) {
      ctx.strokeStyle = '#9aa5b5';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - size * 0.2, sy + size * 0.6);
      ctx.lineTo(cx, sy + size * 0.15);
      ctx.lineTo(cx + size * 0.2, sy + size * 0.6);
      ctx.moveTo(cx - size * 0.12, sy + size * 0.38);
      ctx.lineTo(cx + size * 0.12, sy + size * 0.38);
      ctx.stroke();
    }
    if (stage >= 3) {
      const pulse = 0.6 + 0.4 * Math.sin(time * 3);
      if (this.quality.bloom) {
        const halo = this.glowSprite(false);
        const r = size * (0.5 + 0.2 * pulse);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = pulse * 0.6;
        ctx.drawImage(halo, cx - r, sy + size * 0.45 - r, r * 2, r * 2);
        ctx.restore();
      }
      ctx.fillStyle = `rgba(125,227,255,${pulse})`;
      ctx.beginPath(); ctx.arc(cx, sy + size * 0.45, size * 0.09 * pulse + size * 0.05, 0, 7); ctx.fill();
    }
    if (stage >= 4) {
      ctx.fillStyle = 'rgba(220,240,255,0.9)';
      ctx.beginPath();
      ctx.moveTo(cx - size * 0.1, sy + size * 0.6);
      ctx.lineTo(cx, sy + size * 0.08);
      ctx.lineTo(cx + size * 0.1, sy + size * 0.6);
      ctx.fill();
    }
    if (stage >= 5) {
      const grad = ctx.createLinearGradient(cx, sy + size * 0.1, cx, sy - size * 2);
      grad.addColorStop(0, 'rgba(125,227,255,0.95)');
      grad.addColorStop(1, 'rgba(125,227,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - size * 0.05, sy - size * 2, size * 0.1, size * 2.1);
      const halo = 0.5 + 0.3 * Math.sin(time * 2);
      ctx.fillStyle = `rgba(125,227,255,${halo * 0.5})`;
      ctx.beginPath(); ctx.arc(cx, sy + size * 0.12, size * 0.16, 0, 7); ctx.fill();
    }
  }

  // Направление взгляда и фаза шага. Фаза считается от ПРОЙДЕННОГО ПУТИ, а не
  // от номера кадра: на паузе житель стоит, на ускорении шагает чаще — шаг
  // всегда совпадает со скоростью в игровом времени.
  villagerState(v) {
    let s = this.vstate.get(v);
    if (!s) { s = { x: v.x, y: v.y, dir: 0, walk: 0, still: 0 }; this.vstate.set(v, s); }
    const dx = v.x - s.x, dy = v.y - s.y;
    const d = Math.hypot(dx, dy);
    if (d > 1e-4) {
      // Телепорт (загрузка сейва, «в бой» через команду) не должен крутить ноги.
      s.walk += d < 1.5 ? d : 0;
      s.still = 0;
      if (Math.abs(dx) > Math.abs(dy) * 1.2) s.dir = dx > 0 ? 2 : 1;
      else s.dir = dy > 0 ? 0 : 3;
      s.x = v.x; s.y = v.y;
    } else if (s.still < 100) s.still++;
    return s;
  }

  drawVillager(ctx, sx, sy, z, v, era) {
    const st = this.villagerState(v);
    // Лист кэшируем на самом жителе: сборка ключа и поиск по Map на каждого
    // из сотни жителей каждый кадр — лишний мусор в горячем цикле.
    const prof = professionOf(v);
    if (st.sheet === undefined || st.prof !== prof || st.era !== era || st.gen !== this.people.gen) {
      st.prof = prof; st.era = era; st.gen = this.people.gen;
      st.sheet = this.people.sheet(era, prof, lookOf(v));
    }
    const sh = st.sheet;
    // Рост жителя в долях тайла. Масштаб карты — 1 тайл ≈ 8 м, человек 1.8 м,
    // строго по метру это 0.22 тайла. Берём 0.34: на строгом значении фигура
    // на обычном зуме выходит в шесть пикселей и силуэт перестаёт читаться,
    // а читаемость юнита важнее метрической точности. Хижина при этом 0.90,
    // то есть человек ей примерно по плечо — пропорция уже честная.
    const h = Math.max(7, z * 0.34);
    const w = h * (sh.fw / sh.fh);
    // цикл шага — 0.62 тайла на два шага
    const frame = st.still > 2 ? 0 : ((st.walk / 0.62 * 4) | 0) % 4;
    ctx.drawImage(
      sh.cv, frame * sh.fw, st.dir * sh.fh, sh.fw, sh.fh,
      Math.round(sx - w / 2), Math.round(sy - h * 0.955), Math.round(w), Math.round(h),
    );
  }

  // ---------------------------------------------------------------------
  // Тени облаков — мировые координаты, детерминированы по сиду мира.
  drawClouds(sim, ctx, ox, oy, z, cw, ch) {
    if (this.cloudsSeed !== sim.world.seed) {
      this.cloudsSeed = sim.world.seed;
      this.clouds = Array.from({ length: 6 }, (_, i) => ({
        x: hash2(i, 1) * sim.world.w,
        y: hash2(i, 2) * sim.world.h,
        r: 8 + hash2(i, 3) * 10,
        speed: 0.35 + hash2(i, 4) * 0.5,
        dir: hash2(i, 5) * 6.28,
      }));
    }
    // спрайт тени печётся один раз, дальше только масштабированный blit
    if (!this._cloudSprite) {
      const S = 128;
      const cv = document.createElement('canvas');
      cv.width = S; cv.height = S;
      const c = cv.getContext('2d');
      const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      g.addColorStop(0, 'rgba(40,50,70,0.30)');
      g.addColorStop(0.6, 'rgba(40,50,70,0.14)');
      g.addColorStop(1, 'rgba(40,50,70,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, S, S);
      this._cloudSprite = cv;
    }
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    for (const c of this.clouds) {
      const wx = ((c.x + Math.cos(c.dir) * this.time * c.speed) % sim.world.w + sim.world.w) % sim.world.w;
      const wy = ((c.y + Math.sin(c.dir) * this.time * c.speed * 0.5) % sim.world.h + sim.world.h) % sim.world.h;
      const sx = ox + wx * z, sy = oy + wy * z, r = c.r * z;
      if (sx < -r || sy < -r || sx > cw + r || sy > ch + r) continue;
      ctx.drawImage(this._cloudSprite, sx - r, sy - r * 0.55, r * 2, r * 1.1);
    }
    ctx.restore();
  }

  // Лучи рассвета/заката. Веер печётся в offscreen один раз, в кадре — один blit
  // с переменной прозрачностью: 5 линейных градиентов в кадре того не стоили.
  drawGodRays(ctx, cw, ch, L) {
    const dawnDusk = L.tint[0] > L.tint[2] ? Math.min(1, L.tint[3] * 3) : 0; // тёплый тон = рассвет/закат
    const a = dawnDusk * 0.16;
    if (a < 0.01) return;
    if (!this._rays || this._raysW !== cw || this._raysH !== ch) {
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(cw)); cv.height = Math.max(1, Math.round(ch));
      const c = cv.getContext('2d');
      const ox0 = cw * 0.12, oy0 = -ch * 0.1;
      // Луч гасится и вдоль, и поперёк — иначе на экране видны жёсткие
      // прямоугольные полосы вместо света.
      for (let i = 0; i < 5; i++) {
        const ang = -0.35 + i * 0.16;
        const half = ch * 0.055;
        const along = c.createLinearGradient(0, 0, ch * 1.4, 0);
        along.addColorStop(0, 'rgba(255,220,160,0.9)');
        along.addColorStop(1, 'rgba(255,220,160,0)');
        const across = c.createLinearGradient(0, -half, 0, half);
        across.addColorStop(0, 'rgba(0,0,0,0)');
        across.addColorStop(0.5, 'rgba(0,0,0,1)');
        across.addColorStop(1, 'rgba(0,0,0,0)');
        // рисуем луч в отдельный слой и вырезаем поперечной маской
        const layer = document.createElement('canvas');
        layer.width = cv.width; layer.height = cv.height;
        const lc = layer.getContext('2d');
        lc.translate(ox0, oy0);
        lc.rotate(ang);
        lc.fillStyle = along;
        lc.fillRect(0, -half, ch * 1.5, half * 2);
        lc.globalCompositeOperation = 'destination-in';
        lc.fillStyle = across;
        lc.fillRect(0, -half, ch * 1.5, half * 2);
        c.drawImage(layer, 0, 0);
      }
      this._rays = cv; this._raysW = cw; this._raysH = ch;
    }
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = a;
    ctx.drawImage(this._rays, 0, 0, cw, ch);
    ctx.restore();
  }

  // Виньетка печётся в offscreen один раз на размер окна: полноэкранная заливка
  // градиентом каждый кадр стоила ~4.6 мс — больше, чем вся местность.
  drawVignette(ctx, cw, ch) {
    if (!this._vig || this._vigW !== cw || this._vigH !== ch) {
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(cw)); cv.height = Math.max(1, Math.round(ch));
      const c = cv.getContext('2d');
      const g = c.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.35, cw / 2, ch / 2, Math.hypot(cw, ch) * 0.62);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.38)');
      c.fillStyle = g;
      c.fillRect(0, 0, cw, ch);
      this._vig = cv; this._vigW = cw; this._vigH = ch;
    }
    ctx.drawImage(this._vig, 0, 0, cw, ch);
  }

  // Зерно: 4 заранее сгенерированных кадра шума, паттерны создаются один раз.
  // Пересборка ImageData и createPattern каждый кадр стоила заметных миллисекунд.
  drawGrain(ctx, cw, ch) {
    if (!this._grainFrames) {
      this._grainFrames = [];
      for (let f = 0; f < 4; f++) {
        const cv = document.createElement('canvas');
        cv.width = 96; cv.height = 96;
        const gc = cv.getContext('2d');
        const img = gc.createImageData(96, 96);
        for (let i = 0; i < img.data.length; i += 4) {
          const v = (Math.random() * 255) | 0;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
        }
        gc.putImageData(img, 0, 0);
        this._grainFrames.push(cv);
      }
      this._grainPatterns = null;
    }
    if (!this._grainPatterns) {
      this._grainPatterns = this._grainFrames.map(cv => ctx.createPattern(cv, 'repeat'));
    }
    this.grainAge = (this.grainAge + 1) % 12;
    ctx.save();
    ctx.globalAlpha = this.quality.grain;
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = this._grainPatterns[(this.grainAge / 3) | 0];
    ctx.fillRect(0, 0, cw, ch);
    ctx.restore();
  }

  drawFireflies(sim, ctx, ox, oy, z, cw, ch, dt, L) {
    const target = Math.round(24 * this.quality.particles * L.glow);
    while (this.fireflies.length < target) {
      this.fireflies.push({
        x: Math.random() * sim.world.w, y: Math.random() * sim.world.h,
        ph: Math.random() * 7, r: 0.3 + Math.random() * 0.3, drift: Math.random() * 6.28,
      });
    }
    if (this.fireflies.length > target) this.fireflies.length = target;
    if (!target) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const f of this.fireflies) {
      f.x += Math.cos(f.drift + this.time * 0.3) * f.r * dt;
      f.y += Math.sin(f.drift + this.time * 0.3) * f.r * dt;
      const t = tileAt(sim.world, f.x, f.y);
      if (t !== TILE.FOREST && t !== TILE.GRASS) continue;
      const sx = ox + f.x * z, sy = oy + f.y * z;
      if (sx < 0 || sy < 0 || sx > cw || sy > ch) continue;
      const a = 0.35 + 0.35 * Math.sin(this.time * 3 + f.ph);
      ctx.fillStyle = `rgba(220,255,140,${Math.max(0, a) * L.glow})`;
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(1, z * 0.028), 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  drawBirds(ctx, cw, ch, dt, L) {
    const target = Math.round(6 * this.quality.particles * (1 - L.glow));
    while (this.birds.length < target) {
      this.birds.push({ x: Math.random() * cw, y: ch * (0.1 + Math.random() * 0.3), s: 30 + Math.random() * 30, ph: Math.random() * 7 });
    }
    if (this.birds.length > target) this.birds.length = target;
    ctx.strokeStyle = 'rgba(40,40,50,0.55)';
    ctx.lineWidth = 1.4;
    for (const b of this.birds) {
      b.x += b.s * dt;
      b.y += Math.sin(this.time * 2 + b.ph) * 4 * dt;
      if (b.x > cw + 20) b.x = -20;
      const wing = Math.sin(this.time * 10 + b.ph) * 4;
      ctx.beginPath();
      ctx.moveTo(b.x - 6, b.y + wing); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x + 6, b.y + wing);
      ctx.stroke();
    }
  }

  drawWeather(sim, ctx, cw, ch, dt) {
    const w = sim.weather;
    const base = w === 'rain' ? 90 : w === 'snow' ? 70 : sim.seasonIdx === 2 ? 20 : 0;
    const target = Math.round(base * this.quality.particles);
    while (this.particles.length < target) {
      this.particles.push({
        x: Math.random() * cw, y: Math.random() * ch,
        vy: w === 'snow' || sim.seasonIdx === 2 ? 30 + Math.random() * 30 : 400 + Math.random() * 200,
        vx: w === 'snow' || sim.seasonIdx === 2 ? 20 : 0, ph: Math.random() * 7,
      });
    }
    if (this.particles.length > target) this.particles.length = target;
    if (!target) return;
    const leaf = sim.seasonIdx === 2 && w !== 'rain' && w !== 'snow';
    for (const p of this.particles) {
      p.y += p.vy * dt;
      p.x += (p.vx + Math.sin(this.time * 2 + p.ph) * 20) * dt;
      if (p.y > ch) { p.y = -10; p.x = Math.random() * cw; }
      if (p.x > cw) p.x = 0;
      if (w === 'rain') {
        ctx.strokeStyle = 'rgba(160,190,230,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - 3, p.y + 12); ctx.stroke();
      } else if (w === 'snow') {
        ctx.fillStyle = 'rgba(240,245,255,0.8)';
        ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, 7); ctx.fill();
      } else if (leaf) {
        ctx.fillStyle = 'rgba(181,114,47,0.7)';
        ctx.fillRect(p.x, p.y, 4, 3);
      }
    }
  }

  drawMinimap(sim, ctx, cw, ch) {
    const MW = 120, MH = 120;
    // Правый край занимает #sidePanel (шириной 330 плюс отступ). Мини-карта
    // стояла вплотную к краю окна и на десктопе целиком уходила под панель:
    // рендер выпекал её каждый кадр и выбрасывал. Отступаем на ширину панели,
    // но только когда та реально показана — на узком экране она скрыта.
    const panelW = cw > 820 ? 338 : 10;   // 320 ширина панели + 8 отступ справа + 10 зазор
    const mx = cw - MW - panelW, my = ch - MH - 10;
    ctx.fillStyle = 'rgba(10,14,24,0.75)';
    ctx.fillRect(mx - 3, my - 3, MW + 6, MH + 6);
    if (!this._miniCache || this._miniSeason !== sim.seasonIdx || this._miniSeed !== sim.world.seed) {
      const mc = document.createElement('canvas');
      mc.width = MW; mc.height = MH;
      const mctx = mc.getContext('2d');
      const scale = MW / sim.world.w;
      const img = mctx.createImageData(MW, MH);
      // используем terrain.low (уже посчитан со светом) — просто уменьшаем выборкой
      this.terrain.ensure(sim);
      const low = this.terrain.low;
      const lctx = low.getContext('2d');
      const src = lctx.getImageData(0, 0, low.width, low.height).data;
      const S = low.width / sim.world.w;
      for (let y = 0; y < MH; y++) {
        for (let x = 0; x < MW; x++) {
          const wx = Math.min(low.width - 1, Math.floor(x / scale * S));
          const wy = Math.min(low.height - 1, Math.floor(y / scale * S));
          const si = (wy * low.width + wx) * 4;
          const di = (y * MW + x) * 4;
          img.data[di] = src[si]; img.data[di + 1] = src[si + 1]; img.data[di + 2] = src[si + 2]; img.data[di + 3] = 255;
        }
      }
      mctx.putImageData(img, 0, 0);
      this._miniCache = mc; this._miniSeason = sim.seasonIdx; this._miniSeed = sim.world.seed;
    }
    ctx.drawImage(this._miniCache, mx, my, MW, MH);
    const scale = MW / sim.world.w;
    ctx.fillStyle = '#c9a227';
    for (const b of sim.buildings) if (!b.destroyed) ctx.fillRect(mx + b.x * scale - 1, my + b.y * scale - 1, 3, 3);
    for (const f of sim.factions) {
      if (!f.alive) continue;
      ctx.fillStyle = f.def.color;
      for (const s of f.settlements) {
        ctx.beginPath(); ctx.arc(mx + s.x * scale, my + s.y * scale, s.capital ? 3.5 : 2, 0, 7); ctx.fill();
      }
    }
    const vx = mx + (this.cam.x - (this.canvas.width / this.dpr) / 2 / (TILE_PX * this.cam.zoom)) * scale;
    const vy = my + (this.cam.y - (this.canvas.height / this.dpr) / 2 / (TILE_PX * this.cam.zoom)) * scale;
    const vw = (this.canvas.width / this.dpr) / (TILE_PX * this.cam.zoom) * scale;
    const vh = (this.canvas.height / this.dpr) / (TILE_PX * this.cam.zoom) * scale;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(vx, vy, vw, vh);
    this.minimapRect = { x: mx, y: my, w: MW, h: MH, scale };
  }
}
