// render/renderer.js — канвас-рендер (presentation-слой; ядро о нём не знает).
// Процедурные спрайты эпох: здания эволюционируют визуально от шкур до стекла.
import { TILE, ERAS, BUILDINGS, BUILDING_ERA_IDX, SPIRE_STAGES, SEASONS, WEATHER } from '../core/data.js';
import { tileAt } from '../core/world.js';

const TILE_PX = 32;

// сезонные палитры тайлов
const SEASON_TILE = [
  // DEEP, WATER, SAND, GRASS, FOREST, HILL, MOUNTAIN
  ['#1d3a5f', '#2e5f8a', '#c9b98a', '#5f9e4f', '#3d7a3d', '#8a8a6a', '#7d7d85'], // весна
  ['#1a3557', '#2a587f', '#d4c084', '#6aa84f', '#357035', '#93936b', '#7d7d85'], // лето
  ['#1d3a5f', '#2e5f8a', '#c9b98a', '#9e8a3f', '#7a5a2d', '#8a7a5a', '#7d7d85'], // осень
  ['#16293f', '#24506e', '#dcdcdc', '#cfe0d8', '#5a7a68', '#9a9a92', '#a8a8b0'], // зима
];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: 48, y: 48, zoom: 1 };
    this.mapCache = null;
    this.mapSeason = -1;
    this.particles = [];
    this.time = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
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

  // --- пререндер карты в offscreen один раз на сезон ---
  prerenderMap(sim) {
    const W = sim.world.w, H = sim.world.h;
    if (!this.mapCache) {
      this.mapCache = document.createElement('canvas');
      this.mapCache.width = W * TILE_PX;
      this.mapCache.height = H * TILE_PX;
    }
    const c = this.mapCache.getContext('2d');
    const pal = SEASON_TILE[sim.seasonIdx];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = sim.world.tiles[y * W + x];
        c.fillStyle = pal[t];
        c.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
        // мягкий шум-текст
        const n = ((x * 73856093) ^ (y * 19349663)) % 100 / 100;
        c.fillStyle = n > 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.05)';
        c.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
        // береговые переходы
        if (t === TILE.SAND) {
          for (const [dx, dy, edge] of [[0, -1, 't'], [0, 1, 'b'], [-1, 0, 'l'], [1, 0, 'r']]) {
            const nt = tileAt(sim.world, x + dx, y + dy);
            if (nt === TILE.WATER || nt === TILE.DEEP) {
              c.fillStyle = 'rgba(46,95,138,0.35)';
              if (edge === 't') c.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, 5);
              if (edge === 'b') c.fillRect(x * TILE_PX, y * TILE_PX + TILE_PX - 5, TILE_PX, 5);
              if (edge === 'l') c.fillRect(x * TILE_PX, y * TILE_PX, 5, TILE_PX);
              if (edge === 'r') c.fillRect(x * TILE_PX + TILE_PX - 5, y * TILE_PX, 5, TILE_PX);
            }
          }
        }
        // лес: кроны
        if (t === TILE.FOREST) {
          const m = ((x * 2654435761) ^ (y * 40503)) % 100 / 100;
          c.fillStyle = m > 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.06)';
          c.beginPath();
          c.arc(x * TILE_PX + 10 + m * 12, y * TILE_PX + 12 + m * 8, 6 + m * 3, 0, 7);
          c.fill();
        }
        if (t === TILE.MOUNTAIN) {
          c.fillStyle = 'rgba(255,255,255,0.25)';
          c.beginPath();
          c.moveTo(x * TILE_PX + 16, y * TILE_PX + 6);
          c.lineTo(x * TILE_PX + 24, y * TILE_PX + 20);
          c.lineTo(x * TILE_PX + 8, y * TILE_PX + 20);
          c.fill();
        }
      }
    }
    this.mapSeason = sim.seasonIdx;
  }

  draw(sim, dtReal) {
    this.time += dtReal;
    if (this.mapSeason !== sim.seasonIdx || !this.mapCache) this.prerenderMap(sim);
    const ctx = this.ctx;
    const dpr = this.dpr;
    const cw = this.canvas.width / dpr, ch = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0d1420';
    ctx.fillRect(0, 0, cw, ch);

    const z = TILE_PX * this.cam.zoom;
    const ox = cw / 2 - this.cam.x * z, oy = ch / 2 - this.cam.y * z;
    // карта
    ctx.imageSmoothingEnabled = this.cam.zoom < 2;
    ctx.drawImage(this.mapCache, ox, oy, this.mapCache.width * this.cam.zoom, this.mapCache.height * this.cam.zoom);

    // территории фракций (оверлей)
    if (sim.showTerritory) this.drawTerritory(sim, ctx, ox, oy, z);

    // поселения фракций
    for (const f of sim.factions) {
      if (!f.alive) continue;
      for (const s of f.settlements) {
        const sx = ox + s.x * z, sy = oy + s.y * z;
        if (sx < -60 || sy < -60 || sx > cw + 60 || sy > ch + 60) continue;
        this.drawFactionSettlement(ctx, sx, sy, z, f, s, sim);
      }
    }

    // здания игрока
    const dayPhase = sim.dayTime; // 0..1
    const night = dayPhase < 0.22 || dayPhase > 0.82;
    for (const b of sim.buildings) {
      if (b.destroyed) continue;
      const sx = ox + b.x * z, sy = oy + b.y * z;
      const size = (b.size || 1) * z;
      if (sx < -100 || sy < -100 || sx > cw + 100 || sy > ch + 100) continue;
      this.drawBuilding(sim, ctx, b, sx, sy, size, night);
    }

    // жители
    for (const v of sim.villagers) {
      const sx = ox + v.x * z, sy = oy + v.y * z;
      if (sx < -20 || sy < -20 || sx > cw + 20 || sy > ch + 20) continue;
      this.drawVillager(ctx, sx, sy, z, v, sim.eraIndex);
    }
    // животные
    for (const a of sim.animals) {
      const sx = ox + a.x * z, sy = oy + a.y * z;
      if (sx < -20 || sy < -20 || sx > cw + 20 || sy > ch + 20) continue;
      ctx.fillStyle = a.kind === 'mammoth' ? '#6b4f35' : '#a9825a';
      const r = (a.kind === 'mammoth' ? 0.32 : 0.2) * z;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.arc(sx + r * 0.5, sy - r * 0.4, r * 0.3, 0, 7); ctx.fill();
    }

    // призрак стройки
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

    // маркер рейда
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

    // погода и частицы
    this.drawWeather(sim, ctx, cw, ch, dtReal);

    // день/ночь
    const darkness = night ? 0.38 : (dayPhase < 0.3 ? (0.3 - dayPhase) * 1.2 : (dayPhase > 0.75 ? (dayPhase - 0.75) * 3 : 0));
    if (darkness > 0.01) {
      ctx.fillStyle = `rgba(8,12,40,${Math.min(0.42, darkness)})`;
      ctx.fillRect(0, 0, cw, ch);
      // тёплые окна
      for (const b of sim.buildings) {
        if (b.destroyed || !b.done) continue;
        const def = BUILDINGS[b.id];
        if (!def.housing && !def.out) continue;
        const sx = ox + b.x * z + z / 2, sy = oy + b.y * z + z / 2;
        ctx.fillStyle = sim.eraIndex >= 7 ? 'rgba(140,220,255,0.5)' : 'rgba(255,190,90,0.55)';
        ctx.beginPath(); ctx.arc(sx, sy, z * 0.18, 0, 7); ctx.fill();
      }
      // луч Шпиля
      const sp = sim.buildings.find(b => b.id === 'spire' && !b.destroyed);
      if (sp && sim.spire.stage >= 4) {
        const sx = ox + sp.x * z + z, sy = oy + sp.y * z;
        const grad = ctx.createLinearGradient(sx, sy, sx, 0);
        grad.addColorStop(0, 'rgba(125,227,255,0.7)');
        grad.addColorStop(1, 'rgba(125,227,255,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(sx - z * 0.12, 0, z * 0.24, sy);
      }
    }

    // миникарта
    this.drawMinimap(sim, ctx, cw, ch);
  }

  drawFactionSettlement(ctx, sx, sy, z, f, s, sim) {
    const col = f.def.color;
    // кластер зданий эпохи фракции
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
    // знамя
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
    // взвешенный Вороной (по столицам/поселениям) — грубо, по видимому региону
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
  drawBuilding(sim, ctx, b, sx, sy, size, night) {
    const def = BUILDINGS[b.id];
    const eraVis = Math.max(sim.eraIndex, BUILDING_ERA_IDX[b.id] || 0);
    const e = Math.min(eraVis, 9);
    if (!b.done) {
      // стройплощадка
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
    const cx = sx + size / 2, cy = sy + size / 2;
    ctx.save();
    // тень
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(cx, sy + size * 0.85, size * 0.42, size * 0.14, 0, 0, 7); ctx.fill();

    const cat = this.buildingCategory(b.id, def);
    const pal = this.eraPalette(e);
    switch (b.id) {
      case 'campfire': this.drawCampfire(ctx, cx, cy, size); break;
      case 'spire': this.drawSpire(ctx, sx, sy, size, sim.spire.stage, this.time); break;
      case 'palisade': case 'stone_walls': this.drawWall(ctx, sx, sy, size, b.id === 'stone_walls'); break;
      case 'farm': this.drawFarm(ctx, sx, sy, size, e, sim.seasonIdx); break;
      case 'pasture': this.drawPasture(ctx, sx, sy, size); break;
      default:
        if (cat === 'house') this.drawHouse(ctx, sx, sy, size, e, pal, b.id);
        else if (cat === 'production') this.drawProduction(ctx, sx, sy, size, e, pal, b.id, this.time);
        else if (cat === 'science') this.drawScience(ctx, sx, sy, size, e, pal, b.id);
        else if (cat === 'military') this.drawMilitary(ctx, sx, sy, size, e, pal, b.id);
        else if (cat === 'culture') this.drawCulture(ctx, sx, sy, size, e, pal, b.id);
        else this.drawGeneric(ctx, sx, sy, size, e, pal, b.id);
    }
    ctx.restore();
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
      { wall: '#8a6d4f', roof: '#6b4f35', trim: '#5d4a33' },   // stone: шкуры/земля
      { wall: '#c4a06a', roof: '#8a6d42', trim: '#a0522d' },   // bronze: глинобит
      { wall: '#9a8a72', roof: '#4a4a52', trim: '#3d3d45' },   // iron
      { wall: '#e8e0c8', roof: '#b08d57', trim: '#8a7a5a' },   // classical: мрамор
      { wall: '#b59a7a', roof: '#8a3d2d', trim: '#6b4f35' },   // medieval
      { wall: '#d4c4a0', roof: '#a0522d', trim: '#8a6d42' },   // renaissance
      { wall: '#9a6a52', roof: '#4a3d35', trim: '#3d3229' },   // industrial: кирпич
      { wall: '#aab4bc', roof: '#5a6b7a', trim: '#4aa3c7' },   // modern
      { wall: '#c8d4e8', roof: '#4a5a7a', trim: '#7d9de8' },   // digital
      { wall: '#e8f4f8', roof: '#2d4a5a', trim: '#7de3ff' },   // future
    ];
    return pals[e];
  }

  drawHouse(ctx, sx, sy, size, e, pal, id) {
    const pad = size * 0.12;
    if (e === 0) {
      // шатёр из шкур
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
      // многоэтажка
      const floors = id === 'skyscraper' ? 3 : 2;
      ctx.fillStyle = pal.wall;
      ctx.fillRect(sx + pad, sy + pad, size - pad * 2, size - pad * 2);
      ctx.fillStyle = pal.trim;
      for (let f = 0; f < floors * 2; f++) for (let w = 0; w < 3; w++) {
        ctx.fillRect(sx + pad * 1.4 + w * size * 0.22, sy + pad * 1.4 + f * size * 0.14, size * 0.12, size * 0.08);
      }
    } else {
      // будущее: стекло и свечение
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
    // труба с дымом для индустрии+
    if (e >= 6 || id === 'smithy' || id === 'foundry') {
      ctx.fillStyle = '#5a4a42';
      ctx.fillRect(sx + size * 0.65, sy + pad * 0.4, size * 0.12, size * 0.35);
      const puff = (time * 2 + sx) % 1;
      ctx.fillStyle = `rgba(180,180,180,${0.4 * (1 - puff)})`;
      ctx.beginPath();
      ctx.arc(sx + size * 0.71, sy + pad * 0.4 - puff * size * 0.4, size * 0.08 * (1 + puff), 0, 7);
      ctx.fill();
    }
    // станок/стог
    ctx.fillStyle = pal.trim;
    ctx.fillRect(sx + size * 0.2, sy + size * 0.55, size * 0.2, size * 0.2);
  }

  drawScience(ctx, sx, sy, size, e, pal, id) {
    const pad = size * 0.12;
    ctx.fillStyle = pal.wall;
    ctx.fillRect(sx + pad, sy + size * 0.35, size - pad * 2, size * 0.65 - pad);
    // купол/башня
    ctx.fillStyle = pal.trim;
    if (e >= 3) {
      ctx.beginPath();
      ctx.arc(sx + size / 2, sy + size * 0.35, size * 0.22, Math.PI, 0);
      ctx.fill();
    } else {
      ctx.fillRect(sx + size * 0.4, sy + pad, size * 0.2, size * 0.3);
    }
    // свечение знаний
    ctx.fillStyle = e >= 8 ? 'rgba(125,227,255,0.8)' : 'rgba(255,220,120,0.8)';
    ctx.fillRect(sx + size * 0.45, sy + size * 0.5, size * 0.1, size * 0.15);
  }

  drawMilitary(ctx, sx, sy, size, e, pal, id) {
    const pad = size * 0.1;
    ctx.fillStyle = pal.wall;
    ctx.fillRect(sx + pad, sy + size * 0.35, size - pad * 2, size * 0.65 - pad);
    // зубцы
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
    // колонны / купол
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
    // фундамент
    ctx.fillStyle = '#4a4a55';
    ctx.fillRect(sx + size * 0.1, sy + size * 0.75, size * 0.8, size * 0.2);
    if (stage >= 1) {
      ctx.fillStyle = '#6a6a75';
      ctx.fillRect(sx + size * 0.2, sy + size * 0.6, size * 0.6, size * 0.16);
    }
    if (stage >= 2) {
      // каркас
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
      // пульсирующее ядро
      const pulse = 0.6 + 0.4 * Math.sin(time * 3);
      ctx.fillStyle = `rgba(125,227,255,${pulse})`;
      ctx.beginPath(); ctx.arc(cx, sy + size * 0.45, size * 0.09 * pulse + size * 0.05, 0, 7); ctx.fill();
    }
    if (stage >= 4) {
      // зеркальная оболочка
      ctx.fillStyle = 'rgba(220,240,255,0.9)';
      ctx.beginPath();
      ctx.moveTo(cx - size * 0.1, sy + size * 0.6);
      ctx.lineTo(cx, sy + size * 0.08);
      ctx.lineTo(cx + size * 0.1, sy + size * 0.6);
      ctx.fill();
    }
    if (stage >= 5) {
      // луч в небо
      const grad = ctx.createLinearGradient(cx, sy + size * 0.1, cx, sy - size * 2);
      grad.addColorStop(0, 'rgba(125,227,255,0.95)');
      grad.addColorStop(1, 'rgba(125,227,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - size * 0.05, sy - size * 2, size * 0.1, size * 2.1);
      // ореол
      const halo = 0.5 + 0.3 * Math.sin(time * 2);
      ctx.fillStyle = `rgba(125,227,255,${halo * 0.5})`;
      ctx.beginPath(); ctx.arc(cx, sy + size * 0.12, size * 0.16, 0, 7); ctx.fill();
    }
  }

  drawVillager(ctx, sx, sy, z, v, era) {
    const cloth = ['#8a6d4f', '#c4a06a', '#6a6a72', '#e8e0c8', '#8a3d2d', '#d4af37', '#5a4a42', '#4aa3c7', '#7d9de8', '#e8f4f8'][era];
    const r = Math.max(1.5, z * 0.09);
    ctx.fillStyle = '#d8b08a'; // голова
    ctx.beginPath(); ctx.arc(sx, sy - r * 1.6, r * 0.8, 0, 7); ctx.fill();
    ctx.fillStyle = cloth; // тело
    ctx.fillRect(sx - r * 0.7, sy - r * 0.8, r * 1.4, r * 1.8);
  }

  drawWeather(sim, ctx, cw, ch, dt) {
    const w = sim.weather;
    const target = w === 'rain' ? 90 : w === 'snow' ? 70 : sim.seasonIdx === 2 ? 20 : 0;
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
    const mx = cw - MW - 10, my = ch - MH - 10;
    ctx.fillStyle = 'rgba(10,14,24,0.75)';
    ctx.fillRect(mx - 3, my - 3, MW + 6, MH + 6);
    const pal = SEASON_TILE[sim.seasonIdx];
    const scale = MW / sim.world.w;
    for (let y = 0; y < sim.world.h; y += 2) {
      for (let x = 0; x < sim.world.w; x += 2) {
        ctx.fillStyle = pal[sim.world.tiles[y * sim.world.w + x]];
        ctx.fillRect(mx + x * scale, my + y * scale, scale * 2 + 0.5, scale * 2 + 0.5);
      }
    }
    // здания игрока
    ctx.fillStyle = '#c9a227';
    for (const b of sim.buildings) if (!b.destroyed) ctx.fillRect(mx + b.x * scale - 1, my + b.y * scale - 1, 3, 3);
    // фракции
    for (const f of sim.factions) {
      if (!f.alive) continue;
      ctx.fillStyle = f.def.color;
      for (const s of f.settlements) {
        ctx.beginPath(); ctx.arc(mx + s.x * scale, my + s.y * scale, s.capital ? 3.5 : 2, 0, 7); ctx.fill();
      }
    }
    // рамка камеры
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
