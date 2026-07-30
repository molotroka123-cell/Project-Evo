// core/simulation.js — сердце игры (engine-agnostic, без DOM).
// Вся логика читает таблицы data.js; весь рандом — через детерминированный rng.
import { createRng, makeNoise2D } from './rng.js';
import * as D from './data.js';
import { generateWorld, tileAt, isWater, stepToward, findNearestTile, hasNeighborTile, makeAnimal, aStar, findFactionSpawns } from './world.js';
import { TILE, WALKABLE, ERAS, TECHS, TECH_ERA_IDX, BUILDINGS, BUILDING_ERA_IDX, SPIRE_STAGES, UNITS, TRAIN_COST, ARMY_UPKEEP, COUNTERS, FACTIONS, DIPLO_FACTORS, MARKET_BASE, SEASONS, DAYS_PER_SEASON, WEATHER_TABLE, WEATHER, EVENT_DEFS, OBJECTIVES, NAMES, GREAT_TYPES, SAVE_VERSION } from './data.js';

export const DAY_SECONDS = 6;
const EAT_PER_DAY = 0.7;
const MOVE_SPEED = 7;

const TECH_BY_ID = Object.fromEntries(TECHS.map(t => [t.id, t]));

export class Simulation {
  constructor(seed = 20260730, opts = {}) {
    this.seed = seed >>> 0;
    this.rng = createRng(this.seed);
    this.rng.noise = makeNoise2D(createRng(this.seed ^ 0x9e3779b9));
    this.world = generateWorld(this.seed, this.rng);
    this.res = { food: 40, wood: 30, stone: 10, steel: 0, gold: 0, knowledge: 0 };
    this.resCap = { food: 200, wood: 400, stone: 400, steel: 500, gold: 99999, knowledge: 99999 };
    this.techs = new Set(['fire']);
    this.buildings = [];
    this.villagers = [];
    this.animals = [];
    this.army = { soldiers: 0, powerBonus: 0, trainQueue: 0, trainProgress: 0 };
    this.day = 0;
    this.dayTime = 0.35; // 0..1 внутри дня
    this.seasonIdx = 0;
    this.weather = 'sun';
    this.eraIndex = 0;
    this.eraDay = 0; // день внутри эпохи
    this.newEra = null; // для баннера
    this.log = [];
    this.chronicle = []; // {day, era, text}
    this.toasts = [];
    this.speed = 1;
    this.paused = false;
    this.godmode = false;
    this.fastResearch = false;
    this.ngPlus = !!opts.ngPlus;
    this.difficulty = opts.difficulty || 'normal';
    this.factionCount = opts.factions ?? 3;
    // стройка
    this.placing = null;
    this.buildQueue = [];
    // события
    this.pendingEvent = null;
    this.eventCooldown = 10;
    this.farmPenaltyDays = 0;
    this.dcPenaltyDays = 0;
    // армия/рейды
    this.raids = { timer: this.rng.int(40, 70), warning: false, power: 0, from: null, off: false };
    this.repelled = 0;
    this.lastRaidDay = -999;
    // торговля
    this.caravanTimer = 15;
    this.market = { hist: [], prices: { ...MARKET_BASE } };
    // шпиль
    this.spire = { placed: false, stage: 0, progress: 0, invested: SPIRE_STAGES.map(() => ({ food: 0, wood: 0, stone: 0, steel: 0, gold: 0, knowledge: 0 })) };
    this.won = false;
    this.freePlay = false;
    // миссии космопорта
    this.mission = null; // {type:'moon'|'mars', daysLeft}
    this.moonDone = false; this.marsDone = false;
    // великие люди
    this.greatPeople = [];
    this.pendingGreat = null;
    // труд: приоритеты отраслей 1..4
    this.labor = { food: 4, wood: 3, stone: 2, science: 2, build: 3 };
    // фракции
    this.factions = [];
    this.relations = {}; // fid -> R (-100..100)
    this.relFactors = {}; // fid -> [{key, dR, daysLeft...}]
    this.treaties = []; // {a:'player', b:fid, type:'trade'}
    this.wars = []; // {fid, ws, daysLeft...} — войны с игроком
    this.aiWars = []; // войны ИИ-ИИ {a,b,ws}
    this.diploLog = {};
    this.showTerritory = false;
    // метрики
    this.tickMs = 0;
    this.unhappyDays = 0;
    this.autosaveRequested = false;

    // стартовое поселение
    const { startX, startY } = this.world;
    this.placeFree('campfire', startX, startY);
    for (let i = 0; i < 6; i++) this.spawnVillager(startX + this.rng.range(-2, 2), startY + this.rng.range(-2, 2));
    // животные
    for (let i = 0; i < 26; i++) {
      const p = this.randomLand(8, 30);
      if (p) this.animals.push(makeAnimal(this.rng, 'deer', p.x, p.y));
    }
    for (let i = 0; i < 2; i++) {
      const p = this.randomLand(15, 35);
      if (p) this.animals.push(makeAnimal(this.rng, 'mammoth', p.x, p.y));
    }
    // фракции
    this.spawnFactions();
    this.addChronicle(`Основание поселения. ${ERAS[0].ru}, ${ERAS[0].years}.`);
    this.addLog('Поселение основано. Постройте Хижину — цели слева подскажут путь.');
  }

  randomLand(minR, maxR) {
    const { startX, startY } = this.world;
    for (let i = 0; i < 40; i++) {
      const a = this.rng.range(0, Math.PI * 2), r = this.rng.range(minR, maxR);
      const x = Math.round(startX + Math.cos(a) * r), y = Math.round(startY + Math.sin(a) * r);
      if (x < 1 || y < 1 || x >= this.world.w - 1 || y >= this.world.h - 1) continue;
      if (WALKABLE.has(tileAt(this.world, x, y))) return { x, y };
    }
    return null;
  }

  // ---------- Лог / хроника / тосты ----------
  addLog(text, type = 'info') {
    this.log.push({ day: this.day, text, type });
    if (this.log.length > 120) this.log.splice(0, this.log.length - 120);
  }
  addChronicle(text) { this.chronicle.push({ day: this.day, era: this.eraIndex, text }); }
  toast(text, type = 'info') { this.toasts.push({ text, type, t: 3 }); this.addLog(text, type); }

  // ---------- Фракции ----------
  spawnFactions() {
    const count = Math.min(this.factionCount, FACTIONS.length);
    const picks = [];
    const pool = [...FACTIONS];
    while (picks.length < count) picks.push(pool.splice(this.rng.int(0, pool.length - 1), 1)[0]);
    const spawns = findFactionSpawns(this.world, this.rng, count, this.world.startX, this.world.startY);
    picks.forEach((f, i) => {
      const s = spawns[i] || this.randomLand(24, 40) || { x: 10 + i * 20, y: 10 };
      this.factions.push({
        id: f.id, def: f, P: 8, era: 0, knowPts: 0, techCount: 1,
        armyPts: 4, wallPts: 0, goldPts: 0,
        settlements: [{ x: s.x, y: s.y, capital: true }],
        expansionTimer: Math.ceil(400 / f.traits.expansion),
        alive: true, weak: f.id === 'syndicate',
      });
      this.relations[f.id] = 0;
      this.relFactors[f.id] = [];
      this.diploLog[f.id] = [];
    });
  }

  faction(id) { return this.factions.find(f => f.id === id); }

  // ---------- Стройка ----------
  buildingAt(x, y) {
    return this.buildings.find(b => !b.destroyed && x >= b.x && y >= b.y && x < b.x + (b.size || 1) && y < b.y + (b.size || 1));
  }
  occupiedAt(x, y) { return !!this.buildingAt(x, y); }

  // Возвращает {ok, reason} — каждый отказ объяснён по-человечески
  canPlace(id, x, y) {
    const def = BUILDINGS[id];
    if (!def) return { ok: false, reason: 'Неизвестное здание' };
    if (def.req && !this.techs.has(def.req)) {
      return { ok: false, reason: `Нужна технология: ${TECH_BY_ID[def.req].name}` };
    }
    if (def.unique && this.buildings.some(b => b.id === id && !b.destroyed)) {
      return { ok: false, reason: `${def.name} уже построен — можно только один` };
    }
    const size = def.size || 1;
    for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) {
      const tx = x + dx, ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= this.world.w || ty >= this.world.h) return { ok: false, reason: 'Край карты' };
      const t = tileAt(this.world, tx, ty);
      if (t === TILE.DEEP || t === TILE.WATER) return { ok: false, reason: 'Вода — строить нельзя' };
      if (t === TILE.MOUNTAIN && id !== 'mine') return { ok: false, reason: 'Горы непроходимы — подойдёт только Шахта' };
      if (this.occupiedAt(tx, ty)) return { ok: false, reason: 'Клетка занята другим зданием' };
    }
    // требования к соседним тайлам
    if (def.needTile === TILE.FOREST && !this.adjacentHas(x, y, size, TILE.FOREST)) return { ok: false, reason: 'Нужен лес вплотную' };
    if (def.needTile === TILE.HILL && !this.adjacentHas(x, y, size, TILE.HILL)) return { ok: false, reason: 'Ставится вплотную к холму' };
    if (def.needTile === TILE.MOUNTAIN && !this.adjacentHas(x, y, size, TILE.MOUNTAIN)) return { ok: false, reason: 'Ставится вплотную к горе' };
    if (def.needTile === TILE.GRASS) {
      let grass = false;
      for (let dy = 0; dy < size && !grass; dy++) for (let dx = 0; dx < size && !grass; dx++) if (tileAt(this.world, x + dx, y + dy) === TILE.GRASS) grass = true;
      if (!grass) return { ok: false, reason: 'Нужен травяной луг' };
    }
    if (def.coast && !(this.adjacentHas(x, y, size, TILE.WATER) || this.adjacentHas(x, y, size, TILE.DEEP))) return { ok: false, reason: 'Ставится только на берегу (рядом с водой)' };
    // ресурсы
    const lack = this.lackCost(def.cost);
    if (lack && !this.godmode) return { ok: false, reason: `Не хватает: ${lack}` };
    // дистанция от поселения
    const camp = this.buildings.find(b => b.id === 'campfire' && !b.destroyed);
    if (camp && Math.hypot(x - camp.x, y - camp.y) > 26) return { ok: false, reason: 'Слишком далеко от поселения' };
    return { ok: true };
  }

  adjacentHas(x, y, size, tileType) {
    for (let dy = -1; dy <= size; dy++) for (let dx = -1; dx <= size; dx++) {
      if (dx >= 0 && dx < size && dy >= 0 && dy < size) continue;
      if (tileAt(this.world, x + dx, y + dy) === tileType) return true;
    }
    return false;
  }

  costMult() { return this.ngPlus ? 1.15 : 1; }

  lackCost(cost) {
    const parts = [];
    const m = this.costMult();
    for (const [r, v] of Object.entries(cost || {})) {
      const need = Math.ceil(v * m);
      if ((this.res[r] || 0) < need) {
        const meta = D.RES.find(q => q.id === r);
        parts.push(`${meta ? meta.icon : r}${need - Math.floor(this.res[r] || 0)}`);
      }
    }
    return parts.length ? parts.join(' ') : null;
  }

  payCost(cost) {
    if (this.godmode) return;
    const m = this.costMult();
    for (const [r, v] of Object.entries(cost || {})) this.res[r] = Math.max(0, this.res[r] - Math.ceil(v * m));
  }

  placeBuilding(id, x, y) {
    const chk = this.canPlace(id, x, y);
    if (!chk.ok) { this.toast(chk.reason, 'warn'); return false; }
    this.payCost(BUILDINGS[id].cost);
    const def = BUILDINGS[id];
    const b = {
      id, x, y, size: def.size || 1, progress: 0,
      buildDays: this.buildDays(def), workers: [], done: false,
      eraBuilt: this.eraIndex, hp: def.wall || 100,
    };
    if (this.hasGreat('architect')) {
      b.progress = b.buildDays; // зодчий: мгновенная постройка
      this.consumeGreat('architect');
      this.toast(`Зодчий возводит «${def.name}» мгновенно!`, 'good');
    }
    this.buildings.push(b);
    this.addLog(`Заложено: ${def.name}.`);
    return true;
  }

  placeFree(id, x, y) {
    const def = BUILDINGS[id];
    const b = { id, x, y, size: def.size || 1, progress: 0, buildDays: 0.01, workers: [], done: true, eraBuilt: this.eraIndex, hp: def.wall || 100 };
    this.buildings.push(b);
    return b;
  }

  buildDays(def) {
    const costSum = Object.values(def.cost || {}).reduce((a, b) => a + b, 0);
    let days = Math.max(1, costSum / 8);
    if (this.techs.has('engineering')) days /= 2;
    if (this.techs.has('nanotech')) days /= 3;
    const syn = this.factions.find(f => f.id === 'syndicate');
    return Math.max(0.5, days);
  }

  // ---------- Эффекты зданий ----------
  doneBuildings() { return this.buildings.filter(b => b.done && !b.destroyed); }
  countBuilding(id) { return this.doneBuildings().filter(b => b.id === id).length; }
  hasBuilding(id) { return this.countBuilding(id) > 0; }

  housingCap() {
    let cap = 0;
    for (const b of this.doneBuildings()) cap += BUILDINGS[b.id].housing || 0;
    return cap;
  }

  globalMult(kind) {
    // goldMult / industry / armyMult — множители от зданий и технологий
    let mult = 1;
    if (kind === 'gold') {
      if (this.hasBuilding('bank')) mult *= 1.25;
      if (this.hasBuilding('stock_exchange')) mult *= 1.3;
      if (this.hasGreat('merchant')) mult *= 1.15;
      if (this.techs.has('internet')) mult *= 1.1;
    }
    if (kind === 'industry') {
      if (this.hasBuilding('power_plant')) mult *= 1.25;
      if (this.hasBuilding('solar')) mult *= 1.2;
      if (this.hasBuilding('npp')) mult *= 1.5;
      if (this.hasBuilding('fusion_reactor')) mult *= 1.5;
      if (this.techs.has('plastics')) mult *= 1.25;
    }
    if (kind === 'army') {
      if (this.hasBuilding('armory')) mult *= 1.15;
      if (this.hasBuilding('foundry')) mult *= 1.2;
    }
    if (kind === 'knowledge') {
      if (this.techs.has('language')) mult *= 1.25;
      if (this.techs.has('writing')) mult *= 1.5;
      if (this.techs.has('philosophy')) mult *= 1.3;
      if (this.techs.has('mathematics')) mult *= 1.15;
      if (this.techs.has('printing')) mult *= 2;
      if (this.techs.has('internet')) mult *= 1.25;
      if (this.techs.has('smartphones')) mult *= 1.1;
      if (this.techs.has('quantum')) mult *= 2;
    }
    if (kind === 'gather') {
      if (this.techs.has('tools')) mult *= 1.3;
      if (this.techs.has('iron')) mult *= 1.25;
      if (this.techs.has('steel_tech')) mult *= 1.25;
      if (this.techs.has('chemistry')) mult *= 1.25;
    }
    return mult;
  }

  happiness() {
    let h = 50;
    const pop = this.villagers.length;
    const housing = this.housingCap();
    if (pop > housing) h -= 20;
    const foodDays = this.res.food / Math.max(1, pop * EAT_PER_DAY);
    if (foodDays > 7) h += 10;
    if (this.res.food <= 0) h -= 25;
    for (const b of this.doneBuildings()) h += BUILDINGS[b.id].happy || 0;
    // разнообразие еды
    const variety = (this.hasBuilding('farm') ? 1 : 0) + (this.hasBuilding('pasture') ? 1 : 0) + (this.hasBuilding('port') ? 1 : 0);
    if (variety >= 2) h += 5;
    if (this.techs.has('pottery')) h += 10;
    if (this.techs.has('laws')) h += 10;
    if (this.techs.has('smartphones')) h += 10;
    if (this.raids.warning) h -= 5;
    if (pop > housing + 5) h -= 10;
    if (this.hasGreat('prophet')) h += 10;
    h += WEATHER[this.weather].happy;
    this._happy = Math.max(0, Math.min(100, Math.round(h)));
    return this._happy;
  }

  // ---------- Великие люди ----------
  hasGreat(type) { return this.greatPeople.some(g => g.type === type && !g.used); }
  consumeGreat(type) { const g = this.greatPeople.find(g => g.type === type && !g.used); if (g) g.used = true; }

  // ---------- Население ----------
  spawnVillager(x, y) {
    const name = this.rng.pick(NAMES) + ' ' + this.rng.pick(['с', 'м', 'д', 'в', 'г', 'л']) + this.rng.pick(['а', 'о', 'и', 'ь', '']);
    this.villagers.push({
      name, x, y, tx: x, ty: y, age: this.rng.int(1800, 9000),
      job: 'idle', target: null, path: null, busy: 0, hp: 100, home: null,
    });
  }

  // ---------- Исследования ----------
  techCost(t) {
    let cost = t.cost;
    if (this.fastResearch) cost = Math.ceil(cost / 10);
    // диффузия технологий от партнёров по торговле
    const idx = TECHS.indexOf(t);
    for (const tr of this.treaties) {
      const f = this.faction(tr.b);
      if (f && f.techCount > idx) {
        const disc = f.id === 'cog' ? 0.4 : 0.3;
        cost = Math.ceil(cost * (1 - disc));
        break;
      }
    }
    return cost;
  }

  research(id) {
    const t = TECH_BY_ID[id];
    if (!t) return { ok: false, reason: 'Нет такой технологии' };
    if (this.techs.has(id)) return { ok: false, reason: 'Уже изучено' };
    const missing = t.prereq.filter(p => !this.techs.has(p));
    if (missing.length) return { ok: false, reason: `Требует: ${missing.map(m => TECH_BY_ID[m].name).join(', ')}` };
    const cost = this.techCost(t);
    if (this.res.knowledge < cost && !this.godmode) return { ok: false, reason: `Нужно 📜${cost}` };
    if (!this.godmode) this.res.knowledge -= cost;
    this.techs.add(id);
    this.addLog(`Изучено: ${t.name}. ${t.effect}`, 'good');
    if (t.era) this.advanceEra(ERAS.findIndex(e => e.id === t.era));
    return { ok: true };
  }

  advanceEra(idx) {
    if (idx <= this.eraIndex) return;
    this.eraIndex = idx;
    this.eraDay = 0;
    this.newEra = idx;
    this.addChronicle(`Наступила эпоха: ${ERAS[idx].ru} (${ERAS[idx].years}).`);
    this.addLog(`⚡ Новая эпоха: ${ERAS[idx].ru}!`, 'good');
    // великий человек
    if (idx > 0 && this.rng.chance(0.6)) {
      const types = this.rng.pick(GREAT_TYPES, 2) || [this.rng.pick(GREAT_TYPES), this.rng.pick(GREAT_TYPES)];
      const two = [...new Set([this.rng.pick(GREAT_TYPES), this.rng.pick(GREAT_TYPES)])];
      this.pendingGreat = two.length >= 2 ? two : [GREAT_TYPES[0], GREAT_TYPES[1]];
    }
  }

  chooseGreat(typeId) {
    const g = GREAT_TYPES.find(t => t.id === typeId);
    if (!g) return;
    const rec = { type: typeId, ru: g.ru, day: this.day, used: false };
    this.greatPeople.push(rec);
    this.pendingGreat = null;
    this.addChronicle(`Родился великий человек: ${g.ru}.`);
    this.addLog(`🌟 Великий человек: ${g.ru} — ${g.desc}`, 'good');
    if (typeId === 'scientist') this.res.knowledge += 300 * Math.max(1, this.eraIndex);
    if (typeId === 'general') this.army.powerBonus += 2;
    if (typeId === 'prophet' || typeId === 'merchant' || typeId === 'architect') { /* эффект учитывается в формулах */ }
  }

  // ---------- Армия ----------
  bestUnit() {
    let best = UNITS[0];
    for (const u of UNITS) if (this.techs.has(u.req)) best = u;
    return best;
  }
  armyLimit() { return Math.floor(this.villagers.length / 4); }
  defensePower() {
    let def = 0;
    for (const b of this.doneBuildings()) def += BUILDINGS[b.id].defense || 0;
    return def;
  }
  armyPower() {
    const u = this.bestUnit();
    return this.army.soldiers * (u.power + this.army.powerBonus) * this.globalMult('army');
  }
  trainSoldier() {
    if (!this.hasBuilding('barracks')) return { ok: false, reason: 'Нужна Казарма' };
    if (this.army.soldiers + this.army.trainQueue >= this.armyLimit()) return { ok: false, reason: `Лимит армии: ${this.armyLimit()} (население/4)` };
    if (this.res.food < TRAIN_COST.food || this.res.gold < TRAIN_COST.gold) return { ok: false, reason: `Нужно ${TRAIN_COST.food}🍞 + ${TRAIN_COST.gold}🪙` };
    this.res.food -= TRAIN_COST.food; this.res.gold -= TRAIN_COST.gold;
    this.army.trainQueue++;
    this.addLog('Начато обучение бойца.');
    return { ok: true };
  }

  wealth() {
    let w = this.villagers.length * 20;
    for (const b of this.doneBuildings()) {
      const c = BUILDINGS[b.id].cost || {};
      w += (c.wood || 0) * 0.125 + (c.stone || 0) * 0.167 + (c.steel || 0) * 4 + (c.gold || 0);
    }
    w += (this.res.food + this.res.wood + this.res.stone) / 10 + this.res.steel * 0.4 + this.res.gold / 10;
    return w;
  }

  threatPoints() {
    const eraBase = 40 * Math.pow(1.5, this.eraIndex);
    const wRef = 2000 * Math.pow(1.6, this.eraIndex);
    return eraBase * Math.pow(0.5 + this.wealth() / wRef, 0.7);
  }

  // ---------- ТИК СИМУЛЯЦИИ ----------
  tick(dt) {
    if (this.paused) return;
    const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    // догоняем порциями ≤ 0.5 дня
    let remaining = dt;
    while (remaining > 0) {
      const step = Math.min(remaining, 0.5);
      this.tickStep(step);
      remaining -= step;
    }
    this.tickMs = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0;
  }

  tickStep(dtDays) {
    this.dayTime += dtDays;
    while (this.dayTime >= 1) { this.dayTime -= 1; this.day++; this.eraDay++; this.onNewDay(); }
    this.tickVillagers(dtDays);
    this.tickAnimals(dtDays);
    this.tickConstruction(dtDays);
    this.tickTraining(dtDays);
    this.tickSpire(dtDays);
    this.tickMission(dtDays);
    for (const t of this.toasts) t.t -= dtDays;
    this.toasts = this.toasts.filter(t => t.t > 0);
  }

  tickVillagers(dt) {
    const speed = MOVE_SPEED * (this.techs.has('wheel') ? 1.2 : 1);
    const happy = this._happy ?? this.happiness();
    const happyMult = happy < 35 ? 0.7 : 1;
    for (const v of this.villagers) {
      if (v.hp <= 0) continue;
      // житель на рабочем месте: производит непрерывно
      if (v.atWork) {
        const b = v.target.b;
        const crisis = this.res.food < this.villagers.length * EAT_PER_DAY * 5;
        const def = BUILDINGS[b.id];
        if (b.destroyed || (crisis && !(def.out && def.out.food))) { this.release(v); continue; }
        this.produceAt(b, dt, happyMult);
        v.shift -= dt;
        if (v.shift <= 0) this.release(v);
        continue;
      }
      if (!v.target) this.assignJob(v);
      if (!v.target) { v.busy += dt; if (v.busy > 3) { v.busy = 0; v.job = 'idle'; } continue; }
      const arrived = stepToward(this.world, v, v.target.x + 0.5, v.target.y + 0.5, speed * dt);
      if (arrived) this.onArrive(v);
      else {
        v.busy += dt;
        if (v.busy > 3) { v.busy = 0; v.job = 'idle'; v.target = null; v.path = null; }
      }
    }
    this.villagers = this.villagers.filter(v => v.hp > 0);
  }

  // непрерывная выработка здания за dt дней
  produceAt(b, dt, happyMult) {
    const def = BUILDINGS[b.id];
    const out = def.out || {};
    const gather = this.globalMult('gather') * WEATHER[this.weather].gather;
    let mult = gather * happyMult;
    if (out.knowledge) mult = this.globalMult('knowledge') * happyMult;
    if (out.gold) mult = this.globalMult('gold') * happyMult;
    if (out.steel) mult = this.globalMult('industry') * happyMult;
    if (out.food) {
      if (b.id === 'farm') {
        if (this.seasonIdx === 3 && !def.winter) mult = 0;
        else {
          mult *= WEATHER[this.weather].farm;
          if (this.techs.has('feudalism')) mult *= 1.2;
          if (this.farmPenaltyDays > 0) mult = 0;
          const radius = 3 + (this.hasBuilding('train_station') ? 2 : 0);
          for (const m of this.doneBuildings()) {
            if (m.id === 'mill' && Math.hypot(m.x - b.x, m.y - b.y) <= radius) mult *= 1.5;
          }
        }
      } else if (this.seasonIdx === 3 && !def.winter) mult *= 0.6;
    }
    if (out.knowledge && b.id === 'datacenter' && this.dcPenaltyDays > 0) mult *= 0.5;
    if (def.consume) {
      let can = true;
      for (const [r, c] of Object.entries(def.consume)) if (this.res[r] < c * dt) can = false;
      if (!can) return;
      for (const [r, c] of Object.entries(def.consume)) this.res[r] -= c * dt;
    }
    for (const [r, amt] of Object.entries(out)) {
      this.res[r] = Math.min(this.resCap[r] || 99999, this.res[r] + amt * dt * mult);
    }
  }

  assignJob(v) {
    v.busy = 0;
    // 1. Стройка (до 3 строителей на объект)
    const site = this.buildings.find(b => !b.done && !b.destroyed && b.workers.length < 3);
    if (site) { v.job = 'build'; v.target = { kind: 'build', b: site, x: site.x, y: site.y }; site.workers.push(v); return; }
    // 1.5 Продовольственный кризис: еда важнее всего
    const foodCrisis = this.res.food < this.villagers.length * EAT_PER_DAY * 5;
    // 2. Работа в здании по приоритетам труда
    const catPrio = foodCrisis ? { ...this.labor, food: 99 } : this.labor;
    const jobs = [];
    // считаем занятые места заранее (иначе все ринутся на одно здание)
    const taken = new Map();
    for (const o of this.villagers) {
      if (o !== v && o.target && o.target.kind === 'work') taken.set(o.target.b, (taken.get(o.target.b) || 0) + 1);
    }
    for (const b of this.doneBuildings()) {
      const def = BUILDINGS[b.id];
      if (!def.workers) continue;
      if ((taken.get(b) || 0) >= def.workers) continue;
      // при кризисе еды не-едовые здания пропускаем
      if (foodCrisis && !(def.out && def.out.food)) continue;
      let cat = 'food';
      if (def.out) {
        if (def.out.wood) cat = 'wood';
        else if (def.out.stone || def.out.steel) cat = 'stone';
        else if (def.out.knowledge) cat = 'science';
        else if (def.out.gold) cat = 'stone';
      }
      if (def.out && def.out.food) cat = 'food';
      jobs.push({ b, prio: catPrio[cat] || 1 });
    }
    jobs.sort((a, b) => b.prio - a.prio);
    if (jobs.length) {
      const b = jobs[0].b;
      v.job = 'work'; v.target = { kind: 'work', b, x: b.x, y: b.y };
      return;
    }
    // 3. Охота
    if (this.techs.has('hunting') && this.res.food < this.resCap.food * 0.8) {
      const prey = this.animals.find(a => a.hp > 0);
      if (prey) { v.job = 'hunt'; v.target = { kind: 'hunt', a: prey, x: prey.x, y: prey.y }; return; }
    }
    // 4. Собирательство (при кризисе — все свободные сюда)
    if (this.res.food < this.resCap.food * 0.9 || foodCrisis) {
      const spot = this.randomLand(2, 12);
      if (spot) { v.job = 'forage'; v.target = { kind: 'forage', x: spot.x, y: spot.y }; return; }
    }
    v.job = 'idle';
  }

  onArrive(v) {
    const t = v.target;
    if (!t) return;
    const gather = this.globalMult('gather') * WEATHER[this.weather].gather;
    const happy = this.happiness();
    const happyMult = happy < 35 ? 0.7 : 1;
    if (t.kind === 'build') {
      // прогресс начисляется в tickConstruction
      if (t.b.done || t.b.destroyed) { this.release(v); return; }
      // стоим и строим: прогресс в onArrive маленькими порциями
      t.b.progress += 0.35;
      if (t.b.progress >= t.b.buildDays) this.finishBuilding(t.b);
      else { v.busy = 0; return; } // продолжаем строить (target остаётся)
    }
    if (t.kind === 'work') {
      // занял рабочее место: смена 4 дня непрерывного производства
      v.atWork = true;
      v.shift = 4;
      return;
    }
    if (t.kind === 'hunt') {
      const a = t.a;
      if (a.hp > 0) {
        a.hp -= 4;
        if (a.hp <= 0) {
          this.res.food = Math.min(this.resCap.food, this.res.food + a.food);
          this.animals = this.animals.filter(x => x !== a);
        }
      }
      this.release(v);
      return;
    }
    if (t.kind === 'forage') {
      const tile = tileAt(this.world, Math.round(v.x), Math.round(v.y));
      const base = tile === TILE.FOREST ? 1.8 : 1.2;
      this.res.food = Math.min(this.resCap.food, this.res.food + base * gather * 1.6);
      this.release(v);
      return;
    }
    this.release(v);
  }

  release(v) {
    if (v.target && v.target.kind === 'build') {
      const idx = v.target.b.workers.indexOf(v);
      if (idx >= 0) v.target.b.workers.splice(idx, 1);
    }
    v.target = null; v.job = 'idle'; v.busy = 0; v.atWork = false; v.shift = 0;
  }

  finishBuilding(b) {
    b.done = true; b.progress = b.buildDays;
    b.workers.length = 0;
    const def = BUILDINGS[b.id];
    if (def.cap) for (const [r, c] of Object.entries(def.cap)) this.resCap[r] = (this.resCap[r] || 0) + c;
    if (def.passive && def.out) { /* treasury — пассивное золото, учитывается в onNewDay */ }
    this.addLog(`Построено: ${def.name}!`, 'good');
    this.sfx?.('build');
  }

  tickConstruction(dt) {
    for (const b of this.buildings) {
      if (b.done || b.destroyed) continue;
      const builders = b.workers.filter(v => v.hp > 0 && v.target && v.target.kind === 'build' && v.target.b === b);
      b.workers = builders;
      if (builders.length) b.progress += dt * builders.length * 0.15;
      if (b.progress >= b.buildDays) this.finishBuilding(b);
    }
  }

  tickAnimals(dt) {
    for (const a of this.animals) {
      a.wander -= dt;
      if (a.wander <= 0) {
        a.wander = this.rng.range(2, 5);
        const p = this.randomLand(4, 40);
        if (p) { a.tx = p.x; a.ty = p.y; }
      }
      stepToward(this.world, a, a.tx, a.ty, 3 * dt);
    }
  }

  tickTraining(dt) {
    if (this.army.trainQueue > 0) {
      this.army.trainProgress += dt;
      if (this.army.trainProgress >= 4) {
        this.army.trainProgress = 0;
        this.army.trainQueue--;
        this.army.soldiers++;
        this.addLog(`Боец готов: ${this.bestUnit().name} (всего ${this.army.soldiers}).`, 'good');
        this.sfx?.('build');
      }
    }
  }

  tickSpire(dt) {
    const sb = this.buildings.find(b => b.id === 'spire' && !b.destroyed);
    if (!sb || this.spire.stage >= 5) return;
    // строительство текущей стадии: требует полной оплаты (invested) и времени
    const st = SPIRE_STAGES[this.spire.stage];
    const inv = this.spire.invested[this.spire.stage];
    const paid = Object.entries(st.cost).every(([r, v]) => inv[r] >= v);
    if (paid && sb.done) {
      this.spire.progress += dt;
      if (this.spire.progress >= st.days) {
        this.spire.stage++;
        this.spire.progress = 0;
        this.addChronicle(`Шпиль: завершена стадия «${st.name}» (${this.spire.stage}/5).`);
        this.addLog(`🗼 Шпиль: стадия «${st.name}» завершена!`, 'good');
        this.sfx?.('fanfare');
        if (this.spire.stage >= 5) this.victory();
      }
    }
  }

  investSpire() {
    const sb = this.buildings.find(b => b.id === 'spire' && !b.destroyed);
    if (!sb || this.spire.stage >= 5) return { ok: false, reason: 'Шпиль не построен или завершён' };
    const st = SPIRE_STAGES[this.spire.stage];
    const inv = this.spire.invested[this.spire.stage];
    let moved = false;
    for (const [r, need] of Object.entries(st.cost)) {
      const lack = need - inv[r];
      if (lack <= 0) continue;
      const put = Math.min(lack, Math.floor(this.res[r]));
      if (put > 0) { this.res[r] -= put; inv[r] += put; moved = true; }
    }
    if (!moved) return { ok: false, reason: 'Нечего вложить — не хватает ресурсов' };
    this.addLog(`Вложено в Шпиль (стадия «${st.name}»).`);
    return { ok: true };
  }

  spireStageStatus() {
    if (this.spire.stage >= 5) return { done: true };
    const st = SPIRE_STAGES[this.spire.stage];
    const inv = this.spire.invested[this.spire.stage];
    const paid = Object.entries(st.cost).every(([r, v]) => inv[r] >= v);
    return { stage: this.spire.stage, name: st.name, cost: st.cost, inv, paid, progress: this.spire.progress, days: st.days };
  }

  victory() {
    if (this.won) return;
    this.won = true;
    this.addChronicle('ШПИЛЬ ЦИВИЛИЗАЦИИ завершён. Луч ушёл в звёзды.');
    this.sfx?.('victory');
  }

  tickMission(dt) {
    if (!this.mission) return;
    this.mission.daysLeft -= dt;
    if (this.mission.daysLeft <= 0) {
      if (this.mission.type === 'moon') { this.res.gold += 2000; this.moonDone = true; this.addLog('🌙 Миссия «Луна» завершена: +2000🪙!', 'good'); this.addChronicle('Экспедиция на Луну.'); }
      else { this.res.knowledge += 3000; this.marsDone = true; this.addLog('🚀 Миссия «Марс» завершена: +3000📜!', 'good'); this.addChronicle('Экспедиция на Марс.'); }
      this.mission = null;
    }
  }

  startMission(type) {
    if (this.mission) return { ok: false, reason: 'Миссия уже выполняется' };
    if (type === 'moon' && this.moonDone) return { ok: false, reason: 'Луна уже покорена' };
    if (type === 'mars' && this.marsDone) return { ok: false, reason: 'Марс уже покорен' };
    this.mission = { type, daysLeft: type === 'moon' ? 30 : 60 };
    this.addLog(`Запущена миссия «${type === 'moon' ? 'Луна' : 'Марс'}».`);
    return { ok: true };
  }

  // ---------- НОВЫЙ ДЕНЬ ----------
  onNewDay() {
    const pop = this.villagers.length;
    // погода
    const table = WEATHER_TABLE[this.seasonIdx];
    let roll = this.rng.range(0, 100), acc = 0;
    for (const [w, p] of table) { acc += p; if (roll <= acc) { this.weather = w; break; } }
    // сезон
    if (this.day % DAYS_PER_SEASON === 0) {
      this.seasonIdx = (this.seasonIdx + 1) % 4;
      this.addLog(`Наступила пора: ${SEASONS[this.seasonIdx]}.`);
    }
    // еда
    const eat = pop * EAT_PER_DAY * (this.weather === 'snow' ? 1.25 : 1);
    this.res.food -= eat;
    // содержание армии
    const upkeep = this.army.soldiers;
    this.res.food -= upkeep * ARMY_UPKEEP.food;
    this.res.gold = Math.max(0, this.res.gold - upkeep * ARMY_UPKEEP.gold);
    // голод
    if (this.res.food <= 0) {
      this.res.food = 0;
      const victim = this.villagers[this.villagers.length - 1];
      if (victim) {
        this.addLog(`☠ ${victim.name} умер от голода. Запасайте еду!`, 'bad');
        this.villagers.pop();
      }
    }
    // пассивные знания + кострище
    this.res.knowledge += pop * 0.05;
    if (this.hasBuilding('campfire')) this.res.knowledge += 0.3;
    if (this.hasBuilding('treasury')) this.res.gold += 0.5 * this.globalMult('gold');
    // налоги
    if (this.techs.has('laws')) this.res.gold += pop * 0.05 * this.globalMult('gold');
    // караваны
    if (this.techs.has('trade')) {
      this.caravanTimer--;
      if (this.caravanTimer <= 0) {
        this.caravanTimer = 15;
        let gold = 0.6 * this.countBuilding('market') * this.globalMult('gold');
        if (this.hasBuilding('shipyard')) gold *= 1.5;
        if (this.hasBuilding('train_station')) gold *= 2;
        if (this.hasBuilding('airport')) gold *= 2;
        if (this.techs.has('internet')) gold *= 1.25;
        this.res.gold += gold;
        if (gold > 0) this.addLog(`Караван прибыл: +${gold.toFixed(1)}🪙.`);
      }
    }
    // рождения
    const happy = this.happiness();
    if (happy > 45 && this.res.food > pop * 3 && pop < this.housingCap()) {
      let chance = 0.1;
      if (happy > 70) chance *= 1.5;
      if (this.hasBuilding('hospital')) chance *= 1.3;
      if (this.hasBuilding('biolab')) chance *= 1.2;
      if (this.rng.chance(chance)) {
        const c = this.buildings.find(b => b.id === 'campfire' && !b.destroyed) || { x: this.world.startX, y: this.world.startY };
        this.spawnVillager(c.x + this.rng.range(-1, 1), c.y + this.rng.range(-1, 1));
        this.addLog('Родился новый житель!', 'good');
      }
    }
    // эмиграция при несчастье
    if (happy < 35) {
      this.unhappyDays++;
      if (this.unhappyDays >= 3 && pop > 2 && this.rng.chance(0.25)) {
        const v = this.villagers.pop();
        this.addLog(`${v.name} покинул поселение от безысходности.`, 'bad');
      }
    } else this.unhappyDays = 0;
    // старение и смерть
    for (const v of this.villagers) {
      v.age++;
      let life = 11000; // дней
      if (this.techs.has('medicine')) life *= 1.15;
      if (this.hasBuilding('hospital')) life *= 1.3;
      if (this.hasBuilding('biolab')) life *= 1.25;
      if (v.age > life && this.rng.chance(0.02)) {
        v.hp = 0;
        this.addLog(`${v.name} умер от старости (${Math.floor(v.age / 100)} лет).`);
      }
    }
    this.villagers = this.villagers.filter(v => v.hp > 0);
    // события
    if (this.eventCooldown > 0) this.eventCooldown--;
    if (this.farmPenaltyDays > 0) this.farmPenaltyDays--;
    if (this.dcPenaltyDays > 0) this.dcPenaltyDays--;
    if (this.eventCooldown <= 0 && !this.pendingEvent && this.rng.chance(0.03)) this.rollEvent();
    // рейды
    this.tickRaids();
    // фракции
    this.tickFactions();
    // рынок
    this.tickMarket();
    // авария АЭС
    if (this.hasBuilding('npp') && this.rng.chance(0.002)) this.fireEvent(EVENT_DEFS.find(e => e.id === 'npp_event'));
    // автосейв
    if (this.day % 30 === 0) this.autosaveRequested = true;
  }

  // ---------- События ----------
  rollEvent() {
    const pool = EVENT_DEFS.filter(e => {
      if (e.minEra != null && this.eraIndex < e.minEra) return false;
      if (e.req && !this.techs.has(e.req)) return false;
      if (e.season != null && this.seasonIdx !== e.season) return false;
      if (e.cond === 'housing' && this.villagers.length >= this.housingCap()) return false;
      if (e.cond === 'unhappy' && this.happiness() >= 35) return false;
      if (e.cond === 'npp' && !this.hasBuilding('npp')) return false;
      if (e.cond === 'repelled2' && this.repelled < 2) return false;
      return true;
    });
    if (!pool.length) { this.eventCooldown = 5; return; }
    let total = pool.reduce((a, e) => a + e.w * (e.boost && this.hasBuilding(e.boost) ? 2 : 1), 0);
    let r = this.rng.range(0, total);
    for (const e of pool) {
      r -= e.w * (e.boost && this.hasBuilding(e.boost) ? 2 : 1);
      if (r <= 0) { this.fireEvent(e); return; }
    }
  }

  fireEvent(e) {
    this.eventCooldown = 12;
    if (e.choice) {
      this.pendingEvent = e;
      this.addLog(`⚠ Событие: ${e.ru} — ${e.text}`, 'warn');
      this.sfx?.('alarm');
    } else {
      this.addLog(`Событие: ${e.ru} — ${e.text}`, 'info');
      this.applyEffect(e.effect || {});
    }
  }

  resolveEvent(choiceKey) {
    const e = this.pendingEvent;
    if (!e) return;
    this.pendingEvent = null;
    const opt = e.choice[choiceKey];
    if (!opt) return;
    if (opt.cost) {
      const lack = this.lackCost(opt.cost);
      if (lack) { this.toast(`Не хватает: ${lack}`, 'warn'); return; }
      this.payCost(opt.cost);
    }
    this.applyEffect(opt.effect || {});
    this.addLog(`Решение по событию «${e.ru}»: ${opt.ru}.`);
  }

  applyEffect(fx) {
    if (fx.happy) this._happyBonus = (this._happyBonus || 0) + fx.happy;
    if (fx.pop) for (let i = 0; i < fx.pop; i++) {
      if (fx.pop > 0 && this.villagers.length < this.housingCap()) this.spawnVillager(this.world.startX, this.world.startY);
    }
    if (fx.knowledge) this.res.knowledge += fx.knowledge;
    if (fx.gold) this.res.gold = Math.max(0, this.res.gold + fx.gold);
    if (fx.steel) this.res.steel = Math.max(0, this.res.steel + fx.steel);
    if (fx.food) this.res.food = Math.min(this.resCap.food, this.res.food + fx.food);
    if (fx.foodPct) this.res.food = Math.max(0, this.res.food * (1 + fx.foodPct));
    if (fx.woodPct) this.res.wood = Math.max(0, this.res.wood * (1 + fx.woodPct));
    if (fx.goldPct) this.res.gold = Math.max(0, this.res.gold * (1 + fx.goldPct));
    if (fx.farmPenalty) this.farmPenaltyDays = fx.farmPenalty;
    if (fx.dcPenalty) this.dcPenaltyDays = fx.dcPenalty;
    if (fx.plague) {
      const med = this.medicineMult();
      let deaths = Math.min(this.villagers.length - 1, Math.round(fx.plague * med));
      for (let i = 0; i < deaths; i++) {
        const v = this.villagers.pop();
        this.addLog(`☠ ${v.name} погиб от болезни.`, 'bad');
      }
      this.addLog(deaths ? `Болезнь унесла ${deaths} жителей.` : 'Болезнь обошлась без жертв — спасибо медицине.', deaths ? 'bad' : 'good');
    }
    if (fx.damageBuilding) {
      const candidates = this.doneBuildings().filter(b => b.id !== 'campfire');
      for (let i = 0; i < fx.damageBuilding && candidates.length; i++) {
        const b = candidates.splice(this.rng.int(0, candidates.length - 1), 1)[0];
        b.destroyed = true;
        this.addLog(`🔥 Разрушено: ${BUILDINGS[b.id].name}. Отстройте заново.`, 'bad');
      }
    }
    if (fx.peaceNeighbors) {
      for (const f of this.factions) this.adjustRel(f.id, 15, 'Посредничество послов');
      this.raids.timer = Math.max(this.raids.timer, 60);
    }
  }

  medicineMult() {
    let m = 1;
    if (this.hasBuilding('clinic')) m *= 0.5;
    if (this.hasBuilding('sewers')) m *= 0.3;
    if (this.hasBuilding('hospital')) m *= 0.5;
    return m;
  }

  // ---------- Рейды ----------
  tickRaids() {
    if (this.raids.off || this.eraIndex < 2) return; // рейды с Железного века
    this.raids.timer--;
    if (this.raids.timer <= 2 && !this.raids.warning) {
      this.raids.warning = true;
      this.raids.power = Math.round(this.threatPoints() / 10);
      const aggr = this.factions.filter(f => f.alive).sort((a, b) => b.def.traits.aggression - a.def.traits.aggression)[0];
      this.raids.from = aggr ? aggr.id : null;
      this.addLog(`⚔ Разведчики заметили враждебный отряд${aggr ? ` (${aggr.def.name})` : ''}! До удара ~2 дня. Готовьте армию.`, 'warn');
      this.sfx?.('raid');
    }
    if (this.raids.timer <= 0) {
      this.resolveRaid();
      this.raids.timer = this.rng.int(40, 70);
      this.raids.warning = false;
    }
  }

  resolveRaid() {
    const enemy = Math.round(this.threatPoints() / 10) + this.eraIndex * 2;
    const mine = this.armyPower() + this.defensePower();
    const from = this.raids.from ? this.faction(this.raids.from) : null;
    const fromName = from ? from.def.name : 'Кочевники';
    this.lastRaidDay = this.day;
    if (mine >= enemy) {
      this.repelled++;
      const loot = Math.round(enemy * 1.5);
      this.res.gold += loot;
      this.res.knowledge += Math.round(enemy * 0.5);
      this.addLog(`🛡 Рейд ${fromName} отбит! Сила врага ${enemy} vs наши ${Math.round(mine)}. Трофеи: +${loot}🪙.`, 'good');
      this.addChronicle(`Отбит рейд ${fromName} (день ${this.day}).`);
      this.sfx?.('fanfare');
      if (from) this.adjustRel(from.id, -10, 'Их рейд отбит');
    } else {
      const stolenFood = Math.round(this.res.food * 0.2);
      const stolenGold = Math.round(this.res.gold * 0.2);
      this.res.food -= stolenFood; this.res.gold -= stolenGold;
      const victims = Math.min(this.villagers.length - 1, this.rng.int(1, 3));
      for (let i = 0; i < victims; i++) { const v = this.villagers.pop(); this.addLog(`☠ ${v.name} погиб в рейде.`, 'bad'); }
      const candidates = this.doneBuildings().filter(b => b.id !== 'campfire' && b.id !== 'spire');
      if (candidates.length) {
        const b = this.rng.pick(candidates);
        b.destroyed = true;
        this.addLog(`🔥 Рейдеры разрушили: ${BUILDINGS[b.id].name}.`, 'bad');
      }
      const losses = Math.min(this.army.soldiers, Math.ceil(enemy / 8));
      this.army.soldiers -= losses;
      this.addLog(`💥 Рейд ${fromName} прорвался! Враг ${enemy} vs наши ${Math.round(mine)}. Украдено: ${stolenFood}🍞 ${stolenGold}🪙. Потери: ${victims} жит., ${losses} бойцов.`, 'bad');
      this.addChronicle(`Рейд ${fromName} разорил поселение (день ${this.day}).`);
      this.sfx?.('alarm');
    }
  }

  // ---------- Фракции (теневая экономика) ----------
  tickFactions() {
    for (const f of this.factions) {
      if (!f.alive) continue;
      const tr = f.def.traits;
      const weakMult = (f.weak && this.eraIndex < 6) ? 0.6 : 1;
      // население: логистика
      const K = 30 * f.settlements.length * (1 + f.era * 0.35);
      const r = 0.006 * (1 + tr.expansion / 20) * (f.def.penalty.growth || 1);
      f.P += r * f.P * (1 - f.P / K);
      // доходы
      const eraMult = Math.pow(1.25, f.era) * weakMult;
      const income = f.P * 0.12 * eraMult;
      f.goldPts += income * (tr.trade / 10) * (f.def.bonus.gold || 1);
      f.knowPts += income * (tr.science / 10) * (f.def.bonus.science || 1) * (f.def.penalty.science || 1);
      f.armyPts += income * (tr.aggression / 10) * (f.def.bonus.army || 1) * (f.def.penalty.army || 1);
      f.wallPts += income * (tr.defense / 10);
      // технологии
      const nextCost = 20 * Math.pow(1.35, f.techCount);
      if (f.knowPts >= nextCost && f.techCount < TECHS.length) {
        f.knowPts -= nextCost;
        f.techCount++;
        const newEra = TECH_ERA_IDX[TECHS[Math.min(f.techCount - 1, TECHS.length - 1)].id] ?? f.era;
        if (newEra > f.era) { f.era = newEra; this.addLog(`${f.def.name} вступает в эпоху: ${ERAS[newEra].ru}.`); }
      }
      // экспансия
      f.expansionTimer--;
      if (f.expansionTimer <= 0 && f.P > 0.8 * K) {
        f.expansionTimer = Math.ceil(400 / tr.expansion);
        const s = f.settlements[f.settlements.length - 1];
        const nx = Math.max(2, Math.min(this.world.w - 3, s.x + this.rng.int(-8, 8)));
        const ny = Math.max(2, Math.min(this.world.h - 3, s.y + this.rng.int(-8, 8)));
        if (WALKABLE.has(tileAt(this.world, nx, ny))) {
          f.settlements.push({ x: nx, y: ny, capital: false });
          this.addLog(`${f.def.name} основал новый аванпост.`);
        }
      }
    }
    // дипломатический дрейф и факторы
    for (const f of this.factions) {
      if (!f.alive) continue;
      const base = this.agendaBase(f);
      const cur = this.relations[f.id];
      if (cur < base) this.relations[f.id] = Math.min(base, cur + 0.2);
      else if (cur > base) this.relations[f.id] = Math.max(base, cur - 0.2);
      // затухание факторов
      const factors = this.relFactors[f.id];
      for (const fc of factors) {
        if (fc.decay > 0) {
          fc.dR = fc.dR > 0 ? Math.max(0, fc.dR - fc.decay) : Math.min(0, fc.dR + fc.decay);
        }
      }
      this.relFactors[f.id] = factors.filter(fc => fc.decay === 0 || Math.abs(fc.dR) > 0.5);
      this.relations[f.id] = Math.max(-100, Math.min(100, this.relations[f.id]));
    }
    // Utility AI раз в 5 дней
    if (this.day % 5 === 0) this.utilityAI();
    // войны с игроком: WS дрейф и мир
    for (const w of this.wars) {
      const f = this.faction(w.fid);
      if (!f) continue;
      const myArmy = this.armyPower() + 1, theirArmy = f.armyPts + 1;
      if (theirArmy > myArmy) w.ws -= 0.05; else w.ws += 0.05;
      w.ws = Math.max(-100, Math.min(100, w.ws));
      if (w.ws >= 40 && !w.peaceOffered) {
        w.peaceOffered = true;
        const tribute = Math.round(w.ws * 10);
        this.res.gold += tribute;
        this.addLog(`🕊 ${f.def.def ? '' : ''}${f.def.name} просит мира и платит дань ${tribute}🪙. «${f.def.lines.peace}»`, 'good');
        this.endWar(f.id, true);
      } else if (w.ws <= -40 && !w.demanded) {
        w.demanded = true;
        this.pendingEvent = {
          id: 'tribute_demand', ru: 'Требование дани',
          text: `${f.def.name} требует дань ${Math.round(-w.ws * 10)}🪙, иначе — большая война. «${f.def.lines.threat}»`,
          choice: {
            a: { ru: `Заплатить ${Math.round(-w.ws * 10)}🪙`, cost: { gold: Math.round(-w.ws * 10) }, effect: {} },
            b: { ru: 'Отказать (война продолжится)', effect: {} },
          },
          _tributeWar: f.id,
        };
      }
    }
    // войны ИИ-ИИ
    for (const w of this.aiWars) {
      w.ws += this.rng.range(-1, 1);
      if (Math.abs(w.ws) >= 40) {
        this.addLog(`Война ${this.faction(w.a)?.def.name} и ${this.faction(w.b)?.def.name} завершилась миром.`);
        w.over = true;
      }
    }
    this.aiWars = this.aiWars.filter(w => !w.over);
  }

  agendaBase(f) {
    // базовая точка отношения из агенды
    let base = 0;
    const myArmy = this.armyPower();
    const theirArmy = f.armyPts;
    if (f.id === 'wolves') base = myArmy >= theirArmy ? 10 : -15;
    if (f.id === 'guild') base = this.treaties.some(t => t.b === f.id) ? 10 : 0;
    if (f.id === 'dawn') base = this.hasBuilding('temple') ? 10 : 0;
    if (f.id === 'cog') base = this.eraIndex >= f.era ? 10 : -15;
    if (f.id === 'horde') base = this.buildings.length > 15 ? 10 : -15;
    if (f.id === 'tide') base = this.hasBuilding('port') ? 10 : 0;
    if (f.id === 'grove') base = 0;
    if (f.id === 'syndicate') base = this.hasBuilding('factory') ? 10 : (this.eraIndex >= 7 ? -15 : 0);
    return base;
  }

  adjustRel(fid, dR, why) {
    this.relations[fid] = Math.max(-100, Math.min(100, (this.relations[fid] || 0) + dR));
    const f = this.faction(fid);
    const fkey = dR > 0 ? 'gift' : 'declaredWar';
    this.relFactors[fid].push({ key: why, dR, decay: Math.abs(dR) >= 20 ? 0.1 : 0 });
    if (this.relFactors[fid].length > 12) this.relFactors[fid].shift();
    this.diploLog[fid].push({ day: this.day, why, dR });
    if (this.diploLog[fid].length > 6) this.diploLog[fid].shift();
  }

  utilityAI() {
    const T = this.difficulty === 'easy' ? 0.6 : this.difficulty === 'hard' ? 0.15 : 0.3;
    for (const f of this.factions) {
      if (!f.alive) continue;
      const tr = f.def.traits;
      const atWar = this.wars.some(w => w.fid === f.id);
      const R = this.relations[f.id];
      const noise = this.difficulty === 'easy' ? 0.5 : this.difficulty === 'hard' ? 0.1 : 0.25;
      const myArmyEst = this.armyPower() * (1 + this.rng.range(-noise, noise));
      const actions = [];
      const hasTreaty = this.treaties.some(t => t.b === f.id);
      if (!atWar) {
        if (!hasTreaty) actions.push({ act: 'treaty', U: 0.3 * tr.trade / 10 + 0.2 * R / 100 });
        if (this.relations[f.id] <= -40 || (tr.aggression >= 7 && myArmyEst < f.armyPts * 0.4)) {
          actions.push({ act: 'war', U: 0.5 * tr.aggression / 10 - R / 100 - 0.6 * (myArmyEst / (f.armyPts + 1)) });
        }
        if (f.armyPts > myArmyEst * 1.2 && tr.aggression >= 5) {
          actions.push({ act: 'demand', U: 0.3 * tr.aggression / 10 * (f.armyPts / (myArmyEst + 1) - 1.2) });
        }
      }
      if (!actions.length) continue;
      // softmax
      const exps = actions.map(a => Math.exp(a.U / T));
      const sum = exps.reduce((a, b) => a + b, 0);
      let roll = this.rng.next() * sum;
      let chosen = actions[0];
      for (let i = 0; i < actions.length; i++) { roll -= exps[i]; if (roll <= 0) { chosen = actions[i]; break; } }
      if (chosen.act === 'treaty' && chosen.U > 0.25) this.offerTreaty(f);
      else if (chosen.act === 'war' && chosen.U > 0.55 && !this.atPeaceTreaty(f.id)) this.declareWarOnPlayer(f);
      else if (chosen.act === 'demand' && chosen.U > 0.2) this.demandTribute(f);
    }
  }

  atPeaceTreaty(fid) {
    return this._peacePacts && this._peacePacts[fid] > this.day;
  }

  offerTreaty(f) {
    if (this.treaties.some(t => t.b === f.id)) return;
    if (this.relations[f.id] < 0) return;
    this.pendingEvent = this.pendingEvent || {
      id: 'treaty_offer', ru: 'Предложение торгового договора',
      text: `${f.def.name} предлагает торговый договор. ${f.def.leader}: «${f.def.lines.greet}»`,
      choice: {
        a: { ru: 'Принять (+торговля, −30% техи этой фракции)', effect: {} },
        b: { ru: 'Отклонить', effect: {} },
      },
      _treatyFid: f.id,
    };
  }

  demandTribute(f) {
    const amount = Math.round(f.armyPts * 2);
    this.pendingEvent = this.pendingEvent || {
      id: 'tribute', ru: 'Требование дани',
      text: `${f.def.name} требует ${amount}🪙. ${f.def.leader}: «${f.def.lines.threat}»`,
      choice: {
        a: { ru: `Заплатить ${amount}🪙`, cost: { gold: amount }, effect: {} },
        b: { ru: 'Отказать (риск войны)', effect: {} },
      },
      _tributeFid: f.id,
    };
  }

  declareWarOnPlayer(f) {
    if (this.wars.some(w => w.fid === f.id)) return;
    if (this.atPeaceTreaty(f.id)) return;
    this.wars.push({ fid: f.id, ws: 0 });
    this.adjustRel(f.id, -60, 'Война');
    this.addLog(`⚔ ${f.def.name} объявляет войну! ${f.def.leader}: «${f.def.lines.war}»`, 'bad');
    this.sfx?.('raid');
    // их рейд придёт быстрее
    this.raids.timer = Math.min(this.raids.timer, this.rng.int(5, 12));
    this.raids.from = f.id;
  }

  endWar(fid, peaceful) {
    this.wars = this.wars.filter(w => w.fid !== fid);
    this._peacePacts = this._peacePacts || {};
    this._peacePacts[fid] = this.day + 100;
    const f = this.faction(fid);
    if (f) this.addLog(`Мир с ${f.def.name} на 100 дней.`);
  }

  // Действия игрока в дипломатии
  diploAction(fid, action, arg) {
    const f = this.faction(fid);
    if (!f || !f.alive) return { ok: false, reason: 'Фракция недоступна' };
    const atWar = this.wars.some(w => w.fid === fid);
    if (action === 'treaty') {
      if (atWar) return { ok: false, reason: 'Идёт война' };
      if (this.treaties.some(t => t.b === fid)) return { ok: false, reason: 'Договор уже есть' };
      if (this.relations[fid] < 0) return { ok: false, reason: 'Отношения слишком плохие' };
      this.treaties.push({ b: fid, type: 'trade' });
      this.adjustRel(fid, 20, 'Торговый договор');
      this.addLog(`Торговый договор с ${f.def.name}. ${f.def.leader}: «${f.def.lines.praise}»`, 'good');
      return { ok: true };
    }
    if (action === 'break') {
      this.treaties = this.treaties.filter(t => t.b !== fid);
      this.adjustRel(fid, -15, 'Договор разорван');
      return { ok: true };
    }
    if (action === 'gift') {
      const amount = Math.min(arg || 50, Math.floor(this.res.gold));
      if (amount < 10) return { ok: false, reason: 'Нужно минимум 10🪙' };
      this.res.gold -= amount;
      this.adjustRel(fid, Math.min(15, amount / 50), 'Подарок');
      this.addLog(`Подарок ${amount}🪙 для ${f.def.name}.`);
      return { ok: true };
    }
    if (action === 'demand') {
      const myArmy = this.armyPower(), their = f.armyPts;
      const chance = Math.max(0.05, Math.min(0.9, (myArmy / (their + 1) - 0.8) * 0.5 + this.relations[fid] / 200));
      if (this.rng.chance(chance)) {
        const amount = Math.round(f.armyPts * 1.5);
        this.res.gold += amount;
        this.adjustRel(fid, 8, 'Дань выплачена');
        this.addLog(`${f.def.name} выплачивает дань ${amount}🪙.`, 'good');
      } else {
        this.adjustRel(fid, -10, 'Отказ в дани');
        this.addLog(`${f.def.name} отказалась платить. ${f.def.leader}: «${f.def.lines.threat}»`, 'warn');
        if (f.def.traits.aggression >= 7 && this.rng.chance(0.4)) this.declareWarOnPlayer(f);
      }
      return { ok: true };
    }
    if (action === 'war') {
      if (atWar) return { ok: false, reason: 'Уже воюем' };
      const hasCB = this.wars.length || this.relations[fid] <= -40;
      this.wars.push({ fid, ws: 0 });
      this.adjustRel(fid, -60, 'Вы объявили войну');
      if (!hasCB) {
        for (const o of this.factions) if (o.id !== fid) this.adjustRel(o.id, -20, 'Война без повода');
        this.addLog('Война без законного повода: все фракции относятся хуже (−20).', 'warn');
      }
      this.addLog(`Вы объявили войну: ${f.def.name}.`, 'bad');
      return { ok: true };
    }
    if (action === 'peace') {
      const w = this.wars.find(w => w.fid === fid);
      if (!w) return { ok: false, reason: 'Нет войны' };
      const cost = Math.max(0, Math.round(-w.ws * 10));
      if (cost > 0 && this.res.gold < cost) return { ok: false, reason: `Мир обойдётся в ${cost}🪙` };
      this.res.gold -= cost;
      this.endWar(fid, true);
      this.addLog(`Мир с ${f.def.name}${cost ? ` за ${cost}🪙` : ''}. «${f.def.lines.peace}»`, 'good');
      return { ok: true };
    }
    return { ok: false, reason: 'Неизвестное действие' };
  }

  // обработка спец-событий с колбэками (договор/дань)
  resolveSpecial(choiceKey) {
    const e = this.pendingEvent;
    if (!e) return;
    if (e._treatyFid) {
      if (choiceKey === 'a') this.diploAction(e._treatyFid, 'treaty');
      this.pendingEvent = null;
      return;
    }
    if (e._tributeFid) {
      if (choiceKey === 'a') {
        const opt = e.choice.a;
        const lack = this.lackCost(opt.cost);
        if (lack) { this.toast(`Не хватает: ${lack}`, 'warn'); return; }
        this.payCost(opt.cost);
        this.adjustRel(e._tributeFid, 8, 'Дань выплачена');
      } else {
        this.adjustRel(e._tributeFid, -10, 'Отказ в дани');
        const f = this.faction(e._tributeFid);
        if (f && f.def.traits.aggression >= 6 && this.rng.chance(0.5)) this.declareWarOnPlayer(f);
      }
      this.pendingEvent = null;
      return;
    }
    if (e._tributeWar) {
      if (choiceKey === 'a') {
        const opt = e.choice.a;
        const lack = this.lackCost(opt.cost);
        if (lack) { this.toast(`Не хватает: ${lack}`, 'warn'); return; }
        this.payCost(opt.cost);
        this.endWar(e._tributeWar, true);
      }
      this.pendingEvent = null;
      return;
    }
    this.resolveEvent(choiceKey);
  }

  // ---------- Рынок ----------
  tickMarket() {
    // спрос/предложение от фракций
    const D0 = { food: 0, wood: 0, stone: 0, steel: 0 };
    const S0 = { food: 0, wood: 0, stone: 0, steel: 0 };
    for (const f of this.factions) {
      if (!f.alive) continue;
      const w = f.P * 0.1;
      D0.food += w * 1.2; S0.food += w * (f.def.traits.expansion / 10 + 0.5);
      D0.wood += w * 0.6; S0.wood += w * 0.8;
      D0.stone += w * 0.5; S0.stone += w * 0.6;
      D0.steel += w * (f.def.traits.aggression / 10) * (this.wars.length + this.aiWars.length ? 2 : 1);
      S0.steel += w * (f.def.traits.trade / 10);
    }
    this.market.hist.push({ D: D0, S: S0 });
    if (this.market.hist.length > 10) this.market.hist.shift();
    const avgD = { food: 0, wood: 0, stone: 0, steel: 0 }, avgS = { ...avgD };
    for (const h of this.market.hist) for (const r of ['food', 'wood', 'stone', 'steel']) { avgD[r] += h.D[r]; avgS[r] += h.S[r]; }
    const n = this.market.hist.length || 1;
    for (const r of ['food', 'wood', 'stone', 'steel']) {
      const d = avgD[r] / n, s = avgS[r] / n;
      this.market.prices[r] = MARKET_BASE[r] * Math.max(0.5, Math.min(2, 1 + 0.5 * (d - s) / Math.max(s, 1)));
    }
  }

  marketRate(resId) {
    // цена продажи 1 единицы ресурса в золото для игрока
    let price = this.market.prices[resId] || MARKET_BASE[resId] || 0.1;
    const hasTreaty = this.treaties.length > 0;
    if (!hasTreaty) price *= 0.7; // без договоров — наценка 30% против игрока
    if (this.hasBuilding('treasury')) price *= 1.2;
    return price;
  }

  marketSell(resId, amount) {
    if (!this.hasBuilding('market')) return { ok: false, reason: 'Нужен Рынок' };
    amount = Math.min(amount, Math.floor(this.res[resId]));
    if (amount <= 0) return { ok: false, reason: 'Нечего продавать' };
    const gold = amount * this.marketRate(resId);
    this.res[resId] -= amount;
    this.res.gold += gold;
    this.addLog(`Продано ${amount} ${resId}: +${gold.toFixed(1)}🪙.`);
    return { ok: true };
  }

  marketBuy(resId, amount) {
    if (!this.hasBuilding('market')) return { ok: false, reason: 'Нужен Рынок' };
    const cost = amount * this.marketRate(resId) * 1.25; // покупка дороже
    if (this.res.gold < cost) return { ok: false, reason: `Нужно ${cost.toFixed(1)}🪙` };
    this.res.gold -= cost;
    this.res[resId] = Math.min(this.resCap[resId] || 99999, this.res[resId] + amount);
    this.addLog(`Куплено ${amount} ${resId}: −${cost.toFixed(1)}🪙.`);
    return { ok: true };
  }

  // ---------- Цели ----------
  objectives() {
    return OBJECTIVES.map(o => ({ ...o, done: this.checkObjective(o) }));
  }

  checkObjective(o) {
    const parts = o.check.split('+');
    return parts.every(p => this.checkOne(p.trim(), o));
  }

  checkOne(p, o) {
    if (p.startsWith('building:')) {
      const ids = p.slice(9).split('|');
      return ids.some(id => this.hasBuilding(id)) || (o.checkAlt ? this.checkOne(o.checkAlt, o) : false);
    }
    if (p.startsWith('tech:')) return this.techs.has(p.slice(5));
    if (p.startsWith('pop:')) return this.villagers.length >= +p.slice(4);
    if (p.startsWith('era:')) return this.eraIndex >= +p.slice(4);
    if (p.startsWith('gold:')) return this.res.gold >= +p.slice(5);
    if (p.startsWith('steel:')) return this.res.steel >= +p.slice(6);
    if (p.startsWith('army:')) return this.army.soldiers >= +p.slice(5);
    if (p.startsWith('repelled:')) return this.repelled >= +p.slice(9);
    if (p.startsWith('spire:')) return this.spire.stage >= +p.slice(6);
    if (p.startsWith('any:')) return p.slice(4).split(',').some(id => this.hasBuilding(id));
    return false;
  }

  // ---------- Консоль разработчика ----------
  execCommand(line) {
    const [cmd, ...args] = line.trim().split(/\s+/);
    const out = [];
    const say = (s) => { out.push(s); this.addLog(`> ${line}\n${s}`, 'console'); };
    try {
      switch (cmd) {
        case 'help': {
          say(['РЕСУРСЫ: give <res> <n> · spawn <n> · happy <0-100>',
            'МИР: weather <sun|cloud|rain|snow> · age <eraId> · seed · simulate <days|N years>',
            'НАУКА: research <id|all> · fastresearch · unlockall · era list',
            'АРМИЯ: raid now|off · plague · meteor · kill <n>',
            'ФРАКЦИИ: faction list|rel <id> <n>|war <id>|peace <id>|gift <id> <n>|kill <id> · threat show · market show',
            'ШПИЛЬ: spire stage <1-5> · win · godmode · pop · speed <1|2|4|8> · perf · screenshot · astar test'].join('\n'));
          break;
        }
        case 'give': {
          const r = args[0], n = +args[1] || 100;
          if (!(r in this.res)) return say(`Неизвестный ресурс. Есть: ${Object.keys(this.res).join(', ')}`);
          this.res[r] = Math.min(this.resCap[r] || 99999, this.res[r] + n);
          say(`${r} +${n} → ${Math.floor(this.res[r])}`);
          break;
        }
        case 'spawn': { const n = +args[0] || 5; for (let i = 0; i < n; i++) this.spawnVillager(this.world.startX, this.world.startY); say(`+${n} жителей`); break; }
        case 'weather': { if (WEATHER[args[0]]) { this.weather = args[0]; say(`Погода: ${WEATHER[args[0]].ru}`); } else say('sun|cloud|rain|snow'); break; }
        case 'age': {
          const idx = ERAS.findIndex(e => e.id === args[0]);
          if (idx < 0) return say('Эпохи: ' + ERAS.map(e => e.id).join(', '));
          // открываем все техи до эпохи включительно
          for (const t of TECHS) { if ((TECH_ERA_IDX[t.id] ?? 0) < idx) this.techs.add(t.id); }
          this.advanceEra(idx);
          say(`Эпоха: ${ERAS[idx].ru}`);
          break;
        }
        case 'research': {
          if (args[0] === 'all') { for (const t of TECHS) this.techs.add(t.id); this.eraIndex = 9; say('Все технологии открыты'); }
          else { const r = this.research(args[0]); say(r.ok ? 'Изучено' : r.reason); }
          break;
        }
        case 'simulate': {
          let days = parseInt(args[0]) || 30;
          let requested = days;
          if (args[1] === 'years') { requested = days * 100; days = requested; }
          const capped = Math.min(days, 3650);
          for (let i = 0; i < capped; i++) this.onNewDay();
          say(`Выполнено ${capped} дней из запрошенных ${requested} (кап 3650). День ${this.day}, жителей ${this.villagers.length}`);
          break;
        }
        case 'godmode': { this.godmode = !this.godmode; say(`godmode: ${this.godmode ? 'ON' : 'OFF'}`); break; }
        case 'fastresearch': { this.fastResearch = !this.fastResearch; say(`fastresearch: ${this.fastResearch ? 'ON' : 'OFF'}`); break; }
        case 'plague': { this.applyEffect({ plague: 5 }); say('Чума!'); break; }
        case 'meteor': { this.fireEvent(EVENT_DEFS.find(e => e.id === 'meteor_shower')); say('Метеорный дождь'); break; }
        case 'kill': { const n = Math.min(+args[0] || 1, this.villagers.length - 1); for (let i = 0; i < n; i++) this.villagers.pop(); say(`-${n} жителей`); break; }
        case 'pop': { say(`Жителей: ${this.villagers.length}/${this.housingCap()}, счастье ${this.happiness()}%`); break; }
        case 'happy': { this._happyBonus = (+args[0] || 50) - 50; say(`Счастье ≈ ${args[0]}`); break; }
        case 'unlockall': { for (const t of TECHS) this.techs.add(t.id); say('Все технологии открыты (эпоха не меняется)'); break; }
        case 'speed': { this.speed = [1, 2, 4, 8].includes(+args[0]) ? +args[0] : 1; say(`Скорость: ${this.speed}×`); break; }
        case 'seed': { say(`Сид: ${this.seed}`); break; }
        case 'screenshot': { this._screenshotRequested = true; say('Скриншот запрошен'); break; }
        case 'perf': { say(`Тик: ${this.tickMs.toFixed(2)} мс · зданий ${this.buildings.length} · жителей ${this.villagers.length}`); break; }
        case 'era': { say(ERAS.map((e, i) => `${i}: ${e.id} — ${e.ru} (${e.years})`).join('\n')); break; }
        case 'raid': {
          if (args[0] === 'now') { this.raids.timer = 2; this.raids.warning = false; say('Рейд через 2 дня'); }
          else if (args[0] === 'off') { this.raids.off = !this.raids.off; say(`Рейды: ${this.raids.off ? 'OFF' : 'ON'}`); }
          else say('raid now|off');
          break;
        }
        case 'spire': {
          if (args[0] === 'stage') {
            const s = Math.max(1, Math.min(5, +args[1] || 1));
            if (!this.buildings.some(b => b.id === 'spire' && !b.destroyed)) {
              const c = this.buildings.find(b => b.id === 'campfire');
              this.placeFree('spire', (c ? c.x : this.world.startX) + 3, c ? c.y : this.world.startY);
              this.spire.placed = true;
            }
            for (let i = 0; i < s; i++) {
              const inv = this.spire.invested[i];
              for (const [r, v] of Object.entries(SPIRE_STAGES[i].cost)) inv[r] = v;
            }
            this.spire.stage = s;
            if (s >= 5) this.victory();
            say(`Шпиль: стадия ${s}`);
          } else say('spire stage <1-5>');
          break;
        }
        case 'win': { this.spire.stage = 5; this.victory(); say('Победа!'); break; }
        case 'faction': {
          const sub = args[0];
          if (sub === 'list') say(this.factions.map(f => `${f.id}: ${f.def.name} · эпоха ${f.era} · армия ${Math.round(f.armyPts)} · R ${Math.round(this.relations[f.id])}`).join('\n'));
          else if (sub === 'rel') { this.relations[args[1]] = Math.max(-100, Math.min(100, +args[2] || 0)); say(`R(${args[1]}) = ${this.relations[args[1]]}`); }
          else if (sub === 'war') { const f = this.faction(args[1]); if (f) this.declareWarOnPlayer(f); say('Война'); }
          else if (sub === 'peace') { this.endWar(args[1], true); say('Мир'); }
          else if (sub === 'gift') { this.diploAction(args[1], 'gift', +args[2] || 50); say('Подарок отправлен'); }
          else if (sub === 'kill') { const f = this.faction(args[1]); if (f) { f.alive = false; f.settlements = []; } say('Фракция уничтожена'); }
          else say('faction list|rel|war|peace|gift|kill');
          break;
        }
        case 'threat': { say(`wealth ${Math.round(this.wealth())} · threat ${Math.round(this.threatPoints())} · волна ~${Math.round(this.threatPoints() / 10)} силы`); break; }
        case 'market': { say(Object.entries(this.market.prices).map(([r, p]) => `${r}: ${p.toFixed(3)}🪙`).join(' · ')); break; }
        case 'astar': {
          if (args[0] === 'test') {
            const t0 = performance.now();
            let ok = 0;
            for (let i = 0; i < 50; i++) { const p = aStar(this.world, this.world.startX, this.world.startY, this.rng.int(5, 90), this.rng.int(5, 90)); if (p) ok++; }
            say(`A*: ${ok}/50 путей за ${(performance.now() - t0).toFixed(1)} мс`);
          } else say('astar test');
          break;
        }
        case 'great': {
          if (args[0] === 'spawn') { this.chooseGreat(args[1] || 'scientist'); say('Великий человек призван'); }
          else say('great spawn <scientist|general|merchant|architect|prophet>');
          break;
        }
        default: say(`Неизвестная команда: ${cmd}. Введите help.`);
      }
    } catch (err) {
      say(`Ошибка: ${err.message}`);
    }
    return out.join('\n');
  }

  // ---------- Сохранение v3 ----------
  serialize() {
    return {
      version: SAVE_VERSION,
      seed: this.seed, day: this.day, dayTime: this.dayTime, seasonIdx: this.seasonIdx,
      weather: this.weather, eraIndex: this.eraIndex, eraDay: this.eraDay,
      res: this.res, resCap: this.resCap, techs: [...this.techs],
      buildings: this.buildings.map(b => ({ ...b, workers: [] })),
      villagers: this.villagers.map(v => ({ name: v.name, x: v.x, y: v.y, age: v.age, hp: v.hp })),
      animals: this.animals,
      army: this.army, raids: this.raids, repelled: this.repelled,
      spire: this.spire, won: this.won, freePlay: this.freePlay,
      chronicle: this.chronicle, greatPeople: this.greatPeople,
      ngPlus: this.ngPlus, difficulty: this.difficulty, factionCount: this.factionCount,
      labor: this.labor,
      factions: this.factions.map(f => ({ id: f.id, P: f.P, era: f.era, techCount: f.techCount, armyPts: f.armyPts, wallPts: f.wallPts, goldPts: f.goldPts, knowPts: f.knowPts, settlements: f.settlements, alive: f.alive, weak: f.weak, expansionTimer: f.expansionTimer })),
      relations: this.relations, relFactors: this.relFactors, treaties: this.treaties, wars: this.wars, aiWars: this.aiWars,
      market: this.market, caravanTimer: this.caravanTimer,
      mission: this.mission, moonDone: this.moonDone, marsDone: this.marsDone,
      rngState: this.rng.getState(),
      log: this.log.slice(-80),
    };
  }

  static deserialize(json) {
    let data;
    try { data = typeof json === 'string' ? JSON.parse(json) : json; }
    catch { return { ok: false, reason: 'Файл сейва повреждён — начните новую игру' }; }
    if (!data || !data.version) return { ok: false, reason: 'Это не сейв Фронтира' };
    if (data.version > SAVE_VERSION) return { ok: false, reason: 'Сейв новее игры — обновите версию' };
    if (data.version < SAVE_VERSION) data = Simulation.migrate(data);
    const sim = new Simulation(data.seed, { ngPlus: data.ngPlus, difficulty: data.difficulty, factions: data.factionCount });
    // восстанавливаем всё поверх свежего конструктора
    sim.rng.setState(data.rngState ?? data.seed);
    sim.day = data.day; sim.dayTime = data.dayTime ?? 0.35; sim.seasonIdx = data.seasonIdx;
    sim.weather = data.weather; sim.eraIndex = data.eraIndex; sim.eraDay = data.eraDay || 0;
    sim.res = { ...sim.res, ...data.res }; sim.resCap = { ...sim.resCap, ...data.resCap };
    sim.techs = new Set(data.techs);
    sim.buildings = data.buildings.map(b => ({ ...b, workers: [] }));
    sim.villagers = data.villagers.map(v => ({ ...v, tx: v.x, ty: v.y, job: 'idle', target: null, path: null, busy: 0 }));
    sim.animals = data.animals || [];
    sim.army = data.army; sim.raids = data.raids; sim.repelled = data.repelled || 0;
    sim.spire = data.spire; sim.won = data.won; sim.freePlay = data.freePlay || data.won;
    sim.chronicle = data.chronicle || []; sim.greatPeople = data.greatPeople || [];
    sim.labor = data.labor || sim.labor;
    // фракции: связываем с def
    sim.factions = (data.factions || []).map(fs => {
      const def = FACTIONS.find(f => f.id === fs.id) || FACTIONS[0];
      return { ...fs, def };
    }).filter(f => f.alive !== undefined);
    if (!sim.factions.length) sim.spawnFactions();
    sim.relations = data.relations || {}; sim.relFactors = data.relFactors || {};
    sim.treaties = data.treaties || []; sim.wars = data.wars || []; sim.aiWars = data.aiWars || [];
    sim.market = data.market || sim.market; sim.caravanTimer = data.caravanTimer ?? 15;
    sim.mission = data.mission; sim.moonDone = data.moonDone; sim.marsDone = data.marsDone;
    sim.log = data.log || [];
    for (const f of sim.factions) {
      if (!(f.id in sim.relations)) sim.relations[f.id] = 0;
      if (!sim.relFactors[f.id]) sim.relFactors[f.id] = [];
      if (!sim.diploLog[f.id]) sim.diploLog[f.id] = [];
    }
    return { ok: true, sim };
  }

  // Миграция v1/v2 → v3: прогресс игрока сохраняется полностью
  static migrate(old) {
    const d = JSON.parse(JSON.stringify(old));
    // карта старых эпох (9, без digital): 0..6 совпадают, 7→modern(7), 8→future(9)
    if (d.version === 1) {
      if (d.eraIndex >= 8) d.eraIndex = 9;
      d.res = { steel: 0, gold: 0, ...d.res };
      d.army = { soldiers: 0, powerBonus: 0, trainQueue: 0, trainProgress: 0 };
      d.raids = { timer: 50, warning: false, power: 0, from: null, off: false };
      d.spire = null; d.chronicle = [];
    }
    if (d.version <= 2) {
      // фракции появятся заново от сида
      d.factions = null; d.relations = null; d.treaties = null; d.wars = null;
    }
    if (!d.spire) d.spire = { placed: false, stage: 0, progress: 0, invested: SPIRE_STAGES.map(() => ({ food: 0, wood: 0, stone: 0, steel: 0, gold: 0, knowledge: 0 })) };
    if (!d.chronicle) d.chronicle = [{ day: 0, era: 0, text: 'Основание поселения (мигрированный сейв).' }];
    if (!d.resCap) d.resCap = undefined;
    if (!d.greatPeople) d.greatPeople = [];
    d.version = SAVE_VERSION;
    return d;
  }
}
