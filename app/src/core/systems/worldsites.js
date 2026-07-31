// core/systems/worldsites.js — U33 туман войны, U34 руины и лагеря, U36 выселки.
// Чистый модуль без DOM. Импортирует только core/data.js, core/world.js, core/rng.js.
//
// ==================== INTEGRATION ====================
// Ядро НЕ обязано ничего знать о внутренностях модуля — только вызвать шесть точек.
//
// 1) simulation.js, шапка файла — импорт:
//      import { WorldSites } from './systems/worldsites.js';
//
// 2) simulation.js, constructor — ПОСЛЕ this.spawnFactions() и после placeFree('campfire'):
//      this.sites = new WorldSites(this.world, this.rng, { seed: this.seed });
//    Конструктор сам создаёт столицу в world.startX/startY и открывает туман вокруг неё.
//
// 3) simulation.js, tickStep(dtDays) — В КОНЦЕ метода, после tickVillagers:
//      this.sites.updateFog(this.sites.observers(this.buildings, this.villagers, this.techs));
//    Обновление стоит < 0.5 мс на реальном составе наблюдателей (замер в тесте).
//
// 4) simulation.js, onNewDay() — ПЕРЕД this.tickRaids():
//      for (const ev of this.sites.tickDay({ day: this.day, eraIndex: this.eraIndex })) {
//        if (ev.type === 'banditRaid') {
//          // Лагеря бьют слабее фракций и работают с первых эпох — это ранняя угроза.
//          const mine = this.armyPower() + this.defensePower();
//          if (mine >= ev.power) { this.repelled++; this.res.gold += ev.power; this.addLog(ev.textWin, 'good'); }
//          else {
//            // Именно min: флат-кража добивала малое племя, доля — щадит.
//            const steal = Math.min(ev.steal, this.res.food * ev.stealPct);
//            this.res.food = Math.max(0, this.res.food - steal);
//            this.addLog(`${ev.textLose} Унесено ${Math.round(steal)}🍞.`, 'bad');
//          }
//        } else if (ev.type === 'convoyArrived') {
//          for (const [r, v] of Object.entries(ev.cargo)) this.res[r] = Math.min(this.resCap[r] || 99999, this.res[r] + v);
//          this.addLog(ev.text);
//        } else if (ev.type === 'convoyRobbed') {
//          this.addLog(ev.text, 'bad');
//        }
//      }
//
// 5) simulation.js, assignJob(v) — между блоком «3. Охота» и «4. Собирательство»:
//      const ruin = this.sites.nearestUnclaimedRuin(v.x, v.y, 18);
//      if (ruin) { v.job = 'loot'; v.target = { kind: 'loot', siteId: ruin.id, x: ruin.x, y: ruin.y }; return; }
//    и в onArrive(v) новая ветка:
//      if (t.kind === 'loot') {
//        const r = this.sites.claimRuin(t.siteId);
//        if (r.ok) { for (const [k, val] of Object.entries(r.loot)) this.res[k] = Math.min(this.resCap[k] || 99999, this.res[k] + val); this.toast(r.text, 'good'); }
//        this.release(v); return;
//      }
//
// 6) simulation.js, canPlace(id, x, y) — заменить проверку дистанции от кострища:
//      было:  const camp = this.buildings.find(b => b.id === 'campfire' && !b.destroyed);
//             if (camp && Math.hypot(x - camp.x, y - camp.y) > 26) ...
//      стало: if (!this.sites.inAnySettlementRange(x, y)) return { ok: false, reason: 'Слишком далеко от поселения' };
//    Так строительство автоматически расширяется на выселки, не трогая формулу баланса.
//
// 7) simulation.js, serialize() — добавить поле:  sites: this.sites.serialize(),
//    simulation.js, deserialize() — после восстановления зданий: if (data.sites) sim.sites.deserialize(data.sites);
//
// 8) render/renderer.js — затемнение по this.sim.sites.fog (0 = чёрное, 1 = серое 55%, 2 = чисто),
//    иконки только для sim.sites.knownSites(); ui/hud.js — sim.sites.exploredFraction() в шапку
//    и список sim.sites.settlements для переключения активного поселения.
// =====================================================

import { TILE, WALKABLE } from '../data.js';
import { tileAt } from '../world.js';
import { createRng } from '../rng.js';

// ---------------- U33: состояния тумана ----------------
// Три состояния, а не два: «видел раньше» обязано помнить рельеф и постройки,
// иначе разведка обесценивается — карта заново чернеет за спиной отряда.
export const FOG = { UNSEEN: 0, SEEN: 1, VISIBLE: 2 };

// Радиус обзора. Здания-«вышки» видят дальше: обсерватория и телецентр в игре
// уже стоят дорого, обзор — их естественная вторая функция.
export const SIGHT = {
  villager: 4,
  settlement: 8,
  building: 3,
  byBuilding: {
    campfire: 9, castle: 11, palisade: 5, stone_walls: 6, temple: 6,
    market: 5, port: 7, shipyard: 8, train_station: 10, observatory: 14,
    airport: 12, media_tower: 12, datacenter: 9, ai_core: 10, spire: 16,
  },
  // Оптика — единственная технология, чей эффект «дальше видно» очевиден игроку.
  opticsBonus: 2,
};

// ---------------- U34: таблица точек интереса ----------------
// Данные вынесены в таблицу по образцу data.js: контент правится без кода.
// biomes — на каких проходимых клетках объект появляется; near — какой тайл
// должен быть по соседству (руда у гор, святилище у воды и т.п.).
export const SITE_DEFS = {
  ruin_camp: {
    ru: 'Заброшенная стоянка', kind: 'ruin', weight: 30,
    biomes: [TILE.GRASS, TILE.SAND],
    loot: { food: 60, wood: 45 },
    desc: 'Кострище давно остыло, но припасы в яме уцелели.',
  },
  ruin_fort: {
    ru: 'Развалины крепости', kind: 'ruin', weight: 22,
    biomes: [TILE.HILL],
    loot: { stone: 130, gold: 25 },
    desc: 'Обвалившиеся стены — готовый карьер тёсаного камня.',
  },
  ruin_shrine: {
    ru: 'Древнее святилище', kind: 'ruin', weight: 16,
    biomes: [TILE.FOREST],
    loot: { knowledge: 120, gold: 15 },
    desc: 'Резьба на камнях хранит счёт лет и звёзд.',
  },
  ruin_adit: {
    ru: 'Заваленная штольня', kind: 'ruin', weight: 14,
    biomes: [TILE.HILL, TILE.GRASS], near: TILE.MOUNTAIN,
    loot: { stone: 90, steel: 20, gold: 30 },
    desc: 'Кто-то копал здесь до нас и не вернулся.',
  },
  bandit_camp: {
    ru: 'Лагерь разбойников', kind: 'camp', weight: 26,
    biomes: [TILE.FOREST, TILE.HILL],
    power: 12,             // базовая сила гарнизона, растёт с эпохой
    steal: 18,             // потолок кражи еды за налёт
    stealPct: 0.08,        // ...но не больше доли запасов: разорять малое племя нечестно
    raidEvery: [70, 120],  // разброс дней между налётами одного лагеря
    loot: { gold: 70, food: 50, wood: 30 },
    desc: 'Дым костров и следы копыт: отсюда ходят за чужим.',
  },
};

// Ограничители давления разбойников. Без них модуль ломал баланс: восемь лагерей
// с независимыми таймерами давали налёт раз в восемь дней, и племя, которое без
// модуля доживало до 400-го дня вдесятером, вымирало полностью. Пресс обязан
// быть ограничен СУММАРНО, а не «на лагерь», иначе он растёт с размером карты.
export const BANDIT = {
  firstRaidDay: 50,  // фора на становление: до этого лагеря только сидят на карте
  globalGap: 25,     // минимум дней между любыми двумя налётами со всей карты
  raidRange: 32,     // дальше лагерь до поселения просто не ходит — он мишень, а не угроза
};

// ---------------- U36: параметры выселков ----------------
// Стоимость и требование вынесены сюда, чтобы ядро не хардкодило баланс.
export const OUTPOST = {
  req: 'masonry',                          // технология-гейт
  cost: { wood: 60, stone: 40, food: 80 },
  minGap: 10,                              // не ближе к другому поселению
  maxLink: 45,                             // дальше связь с центром рвётся
  buildRange: 20,                          // радиус застройки вокруг центра
  capitalRange: 26,                        // радиус столицы — как было в canPlace
  convoyEvery: 10,                         // раз в сколько дней уходит обоз
  keep: { food: 40 },                      // что выселок оставляет себе
  cap: { food: 200, wood: 200, stone: 200, steel: 100, gold: 99999, knowledge: 99999 },
};

const OUTPOST_NAMES = ['Заречье', 'Дальний Стан', 'Полесье', 'Гряда', 'Тихий Брод',
  'Верхний Лог', 'Сосновый Край', 'Каменный Дол', 'Ветрогон', 'Новая Заимка',
  'Пустошь', 'Медвежий Угол'];

const RES_IDS = ['food', 'wood', 'stone', 'steel', 'gold', 'knowledge'];

function emptyStore() {
  const s = {};
  for (const r of RES_IDS) s[r] = 0;
  return s;
}

export class WorldSites {
  // rng — ГПСЧ симуляции: из него берётся ВСЯ игровая случайность (таймеры
  // налётов, исход штурма, ограбление обоза). Расстановка же считается отдельным
  // потоком от сида: иначе карта зависела бы от того, сколько раз ядро дёрнуло
  // rng до создания модуля, и «один сид — одна карта» перестало бы выполняться.
  constructor(world, rng, opts = {}) {
    this.world = world;
    this.rng = rng;
    this.w = world.w; this.h = world.h;
    this.seed = (opts.seed ?? world.seed ?? 0) >>> 0;

    // --- U33 ---
    this.fog = new Uint8Array(this.w * this.h);
    this._visList = new Int32Array(this.w * this.h); // индексы, помеченные VISIBLE в прошлый раз
    this._visN = 0;
    this._discs = new Map();       // кэш дисков по радиусу: считать круг заново на каждого жителя дорого
    this._exploredDirty = true;
    this._exploredCount = 0;

    // --- U34 ---
    this.sites = [];
    this.nextSiteId = 1;
    this._raidCooldown = 0;   // общий для карты кулдаун налётов, см. BANDIT

    // --- U36 ---
    this.settlements = [];
    this.convoys = [];             // обозы в пути
    this.nextSettlementId = 1;

    if (opts.sites !== false) this._generateSites();
    if (opts.capital !== false) {
      this._addSettlement(Math.round(world.startX), Math.round(world.startY), opts.capitalName || 'Главное поселение', true, 0);
    }
  }

  // ==================================================================
  // U33. ТУМАН ВОЙНЫ
  // ==================================================================

  // Диск радиуса r в виде плоского массива смещений. Кэш обязателен: без него
  // 60 жителей × 49 клеток заново пересчитывали бы окружность каждый тик.
  _disc(r) {
    let d = this._discs.get(r);
    if (d) return d;
    const pts = [];
    const rr = r * r;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= rr) { pts.push(dx, dy); }
      }
    }
    d = Int16Array.from(pts);
    this._discs.set(r, d);
    return d;
  }

  // Собирает наблюдателей из состояния ядра. Ядру не нужно знать таблицу радиусов.
  observers(buildings, villagers, techs) {
    const bonus = (techs && typeof techs.has === 'function' && techs.has('optics')) ? SIGHT.opticsBonus : 0;
    const out = [];
    for (const s of this.settlements) out.push({ x: s.x, y: s.y, r: SIGHT.settlement + bonus });
    if (buildings) {
      for (const b of buildings) {
        if (b.destroyed || !b.done) continue;
        out.push({ x: b.x, y: b.y, r: (SIGHT.byBuilding[b.id] ?? SIGHT.building) + bonus });
      }
    }
    if (villagers) {
      for (const v of villagers) {
        if (v.hp <= 0) continue;
        out.push({ x: v.x, y: v.y, r: SIGHT.villager + bonus });
      }
    }
    return out;
  }

  // Обновление тумана. Дорого было бы чистить весь Uint8Array каждый кадр:
  // вместо этого гасим только те клетки, что были VISIBLE в прошлый раз —
  // их всегда на порядок меньше, чем клеток карты.
  updateFog(observers) {
    const fog = this.fog, W = this.w, H = this.h, vis = this._visList;
    for (let k = 0; k < this._visN; k++) {
      const i = vis[k];
      if (fog[i] === FOG.VISIBLE) fog[i] = FOG.SEEN;
    }
    this._visN = 0;
    if (!observers || !observers.length) { this._exploredDirty = true; return 0; }
    for (let o = 0; o < observers.length; o++) {
      const ob = observers[o];
      const r = ob.r | 0;
      if (r <= 0) continue;
      const ox = Math.round(ob.x), oy = Math.round(ob.y);
      const d = this._disc(r);
      for (let k = 0; k < d.length; k += 2) {
        const x = ox + d[k], y = oy + d[k + 1];
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (fog[i] === FOG.VISIBLE) continue; // уже отмечена в этом же проходе
        fog[i] = FOG.VISIBLE;
        vis[this._visN++] = i;
      }
    }
    this._exploredDirty = true;
    return this._visN;
  }

  // Постоянное раскрытие (разведчик, событие, основание выселка): память карты
  // без текущей видимости, поэтому в _visList не попадает и не гаснет.
  revealCircle(cx, cy, r) {
    const fog = this.fog, W = this.w, H = this.h;
    const d = this._disc(Math.max(1, r | 0));
    const ox = Math.round(cx), oy = Math.round(cy);
    for (let k = 0; k < d.length; k += 2) {
      const x = ox + d[k], y = oy + d[k + 1];
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (fog[i] === FOG.UNSEEN) fog[i] = FOG.SEEN;
    }
    this._exploredDirty = true;
  }

  fogAt(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return FOG.UNSEEN;
    return this.fog[yi * this.w + xi];
  }
  isExplored(x, y) { return this.fogAt(x, y) !== FOG.UNSEEN; }
  isVisible(x, y) { return this.fogAt(x, y) === FOG.VISIBLE; }

  exploredFraction() {
    if (this._exploredDirty) {
      let n = 0;
      const fog = this.fog;
      for (let i = 0; i < fog.length; i++) if (fog[i] !== FOG.UNSEEN) n++;
      this._exploredCount = n;
      this._exploredDirty = false;
    }
    return this._exploredCount / this.fog.length;
  }

  // ==================================================================
  // U34. РУИНЫ И ЛАГЕРЯ
  // ==================================================================

  // Расстановка идёт от отдельного потока сида (см. комментарий в конструкторе).
  _generateSites() {
    const rng = createRng((this.seed ^ 0x51ed270b) >>> 0);
    const W = this.w, H = this.h;
    const sx = Math.round(this.world.startX), sy = Math.round(this.world.startY);

    // Плотность привязана к площади суши, а не к константе: на «островных» сидах
    // фиксированные 20 руин просто не поместились бы, и генерация зациклилась.
    let land = 0;
    for (let i = 0; i < this.world.tiles.length; i++) if (WALKABLE.has(this.world.tiles[i])) land++;
    const ruinCount = Math.max(6, Math.min(28, Math.round(land / 190)));
    // Лагерей заведомо немного: каждый — это точка, которую игрок должен захотеть
    // зачистить, а не фоновый шум. Плотность вдвое ниже, чем у руин по площади.
    const campCount = Math.max(2, Math.min(6, Math.round(land / 700)));

    const ruinDefs = Object.entries(SITE_DEFS).filter(([, d]) => d.kind === 'ruin');
    const campDefs = Object.entries(SITE_DEFS).filter(([, d]) => d.kind === 'camp');

    const place = (defs, count, minFromStart) => {
      let placed = 0, guard = 0;
      while (placed < count && guard++ < 20000) {
        const x = rng.int(2, W - 3), y = rng.int(2, H - 3);
        if (Math.hypot(x - sx, y - sy) < minFromStart) continue;
        const t = this.world.tiles[y * W + x];
        if (!WALKABLE.has(t)) continue;
        // Объекты не должны липнуть друг к другу — иначе половина карты пустая,
        // а в одном углу гроздь из шести руин.
        if (this.sites.some(s => Math.hypot(s.x - x, s.y - y) < 7)) continue;
        const [id, def] = this._weightedPick(rng, defs, t);
        if (!def) continue;
        if (def.near && !this._hasNear(x, y, def.near, 2)) continue;
        this.sites.push(this._makeSite(rng, id, def, x, y));
        placed++;
      }
    };

    // Руины можно ставить относительно близко: это ранняя награда за разведку.
    place(ruinDefs, ruinCount, 9);
    // Лагерь под боком у стартовой поляны убил бы партию до первой хижины.
    place(campDefs, campCount, 20);

    // Порядок в массиве не должен зависеть от того, что и когда легло: сортируем
    // по координате, чтобы сериализация и рендер были стабильны между запусками.
    this.sites.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    this.sites.forEach(s => { s.id = this.nextSiteId++; });
  }

  _weightedPick(rng, defs, tile) {
    const fit = defs.filter(([, d]) => d.biomes.includes(tile));
    if (!fit.length) return [null, null];
    let total = 0;
    for (const [, d] of fit) total += d.weight;
    let roll = rng.range(0, total);
    for (const [id, d] of fit) { roll -= d.weight; if (roll <= 0) return [id, d]; }
    return fit[fit.length - 1];
  }

  _hasNear(x, y, tile, r) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (tileAt(this.world, x + dx, y + dy) === tile) return true;
    }
    return false;
  }

  _makeSite(rng, defId, def, x, y) {
    const s = { id: 0, def: defId, kind: def.kind, x, y, claimed: false, destroyed: false };
    if (def.kind === 'camp') {
      // Разброс таймера на старте: иначе все лагеря бьют в один и тот же день.
      s.raidTimer = rng.int(def.raidEvery[0], def.raidEvery[1]);
      s.raids = 0;
    } else {
      // Богатство руины ±25%: две одинаковые развалины скучны.
      s.rich = Math.round(rng.range(0.75, 1.25) * 100) / 100;
    }
    return s;
  }

  site(id) { return this.sites.find(s => s.id === id) || null; }
  siteAt(x, y) { return this.sites.find(s => !s.destroyed && s.x === x && s.y === y) || null; }

  // Только разведанные объекты — интерфейс не должен показывать то, чего игрок не видел.
  knownSites() { return this.sites.filter(s => !s.destroyed && this.isExplored(s.x, s.y)); }
  liveCamps() { return this.sites.filter(s => s.kind === 'camp' && !s.destroyed); }

  // Ближайшая неразграбленная руина в разведанной зоне — для назначения работ.
  nearestUnclaimedRuin(x, y, maxR = 20) {
    let best = null, bestD = Infinity;
    for (const s of this.sites) {
      if (s.kind !== 'ruin' || s.claimed || s.destroyed) continue;
      if (!this.isExplored(s.x, s.y)) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD && d <= maxR) { bestD = d; best = s; }
    }
    return best;
  }

  // Разграбление руины. Модуль не трогает ресурсы ядра — возвращает добычу,
  // а начисляет её симуляция: так модуль остаётся проверяемым в отрыве от игры.
  claimRuin(id) {
    const s = this.site(id);
    if (!s) return { ok: false, reason: 'Такой точки нет' };
    if (s.kind !== 'ruin') return { ok: false, reason: 'Это не руины' };
    if (s.claimed) return { ok: false, reason: 'Здесь уже всё вынесли' };
    s.claimed = true;
    const def = SITE_DEFS[s.def];
    const loot = {};
    for (const [r, v] of Object.entries(def.loot)) loot[r] = Math.round(v * s.rich);
    const parts = Object.entries(loot).map(([r, v]) => `${r === 'food' ? '🍞' : r === 'wood' ? '🪵' : r === 'stone' ? '🪨' : r === 'steel' ? '⚙️' : r === 'gold' ? '🪙' : '📜'}${v}`);
    return { ok: true, loot, site: s, text: `${def.ru}: найдено ${parts.join(' ')}.` };
  }

  // Сила гарнизона лагеря растёт с эпохой, иначе к Средневековью лагеря
  // становятся бесплатным кладом и точка интереса умирает как механика.
  campPower(s, eraIndex = 0) {
    return Math.round(SITE_DEFS[s.def].power * (1 + eraIndex * 0.6) * (1 + s.raids * 0.1));
  }

  // Штурм лагеря армией игрока. Исход с разбросом ±15% — редкий, но возможный
  // проигрыш при равных силах не даёт игроку считать штурм бесплатным.
  assaultCamp(id, armyPower, eraIndex = 0) {
    const s = this.site(id);
    if (!s) return { ok: false, reason: 'Такой точки нет' };
    if (s.kind !== 'camp') return { ok: false, reason: 'Это не лагерь' };
    if (s.destroyed) return { ok: false, reason: 'Лагерь уже разорён' };
    const def = SITE_DEFS[s.def];
    const garrison = this.campPower(s, eraIndex) * this.rng.range(0.85, 1.15);
    if (armyPower >= garrison) {
      s.destroyed = true;
      const loot = { ...def.loot };
      return { ok: true, win: true, loot, losses: Math.ceil(garrison / 12), site: s,
        text: `${def.ru} разорён. Добыча: 🪙${loot.gold} 🍞${loot.food} 🪵${loot.wood}.` };
    }
    return { ok: true, win: false, loot: {}, losses: Math.ceil(garrison / 6), site: s,
      text: `Штурм отбит: гарнизон ${def.ru.toLowerCase()} сильнее (${Math.round(garrison)} против ${Math.round(armyPower)}).` };
  }

  // ==================================================================
  // U36. ВЫСЕЛКИ
  // ==================================================================

  _addSettlement(x, y, name, capital, day) {
    const s = {
      id: this.nextSettlementId++,
      name, x, y, capital,
      foundedDay: day,
      // Ключевое решение архитектуры: у столицы store === null, то есть её склад —
      // это общая казна ядра (sim.res). Так одно поселение остаётся ТОЧНО тем же
      // случаем, что и раньше: ни второго пула ресурсов, ни новых потолков,
      // ни изменений в экономике. Выселки же получают собственные склады.
      store: capital ? null : emptyStore(),
      pop: 0,
      linkDays: 0,
      convoyTimer: 0,
    };
    if (!capital) {
      const cap = this.capital();
      const dist = cap ? Math.hypot(x - cap.x, y - cap.y) : 0;
      s.linkDays = Math.max(1, Math.round(dist / 12));
      s.convoyTimer = OUTPOST.convoyEvery;
    }
    this.settlements.push(s);
    this.revealCircle(x, y, SIGHT.settlement + 2);
    return s;
  }

  capital() { return this.settlements.find(s => s.capital) || this.settlements[0] || null; }
  settlement(id) { return this.settlements.find(s => s.id === id) || null; }
  outposts() { return this.settlements.filter(s => !s.capital); }

  // Радиус застройки: у столицы прежние 26 клеток, у выселка — свой, меньший.
  rangeOf(s) { return s.capital ? OUTPOST.capitalRange : OUTPOST.buildRange; }

  inAnySettlementRange(x, y) {
    for (const s of this.settlements) {
      if (Math.hypot(x - s.x, y - s.y) <= this.rangeOf(s)) return true;
    }
    return false;
  }

  nearestSettlement(x, y) {
    let best = null, bestD = Infinity;
    for (const s of this.settlements) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  // Проверка места под выселок. Причины отказа — готовые строки для тоста.
  // ctx = { techs, res, occupied(x,y) } — все поля необязательны, модуль
  // одинаково работает и в тесте без симуляции.
  canFound(x, y, ctx = {}) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 1 || yi < 1 || xi >= this.w - 1 || yi >= this.h - 1) return { ok: false, reason: 'Край карты' };
    if (!WALKABLE.has(tileAt(this.world, xi, yi))) return { ok: false, reason: 'Здесь не поставить центр: нужна проходимая земля' };
    if (!this.isExplored(xi, yi)) return { ok: false, reason: 'Место не разведано' };
    if (ctx.techs && typeof ctx.techs.has === 'function' && !ctx.techs.has(OUTPOST.req)) {
      return { ok: false, reason: 'Нужна технология: Кладка' };
    }
    for (const s of this.settlements) {
      if (Math.hypot(xi - s.x, yi - s.y) < OUTPOST.minGap) {
        return { ok: false, reason: `Слишком близко к поселению «${s.name}» (нужно ${OUTPOST.minGap} клеток)` };
      }
    }
    const cap = this.capital();
    if (cap && Math.hypot(xi - cap.x, yi - cap.y) > OUTPOST.maxLink) {
      return { ok: false, reason: `Дальше ${OUTPOST.maxLink} клеток обозы не доходят` };
    }
    const camp = this.sites.find(s => s.kind === 'camp' && !s.destroyed && Math.hypot(s.x - xi, s.y - yi) < 8);
    if (camp) return { ok: false, reason: 'Рядом лагерь разбойников — сначала разорите его' };
    if (ctx.occupied && ctx.occupied(xi, yi)) return { ok: false, reason: 'Клетка занята зданием' };
    if (ctx.res) {
      const lack = [];
      for (const [r, v] of Object.entries(OUTPOST.cost)) if ((ctx.res[r] || 0) < v) lack.push(`${r} ${v}`);
      if (lack.length) return { ok: false, reason: `Не хватает: ${lack.join(', ')}` };
    }
    return { ok: true };
  }

  // Основание выселка. Ресурсы списывает ядро — модуль лишь подтверждает право.
  foundSettlement(x, y, ctx = {}) {
    const chk = this.canFound(x, y, ctx);
    if (!chk.ok) return chk;
    const used = new Set(this.settlements.map(s => s.name));
    const name = ctx.name || OUTPOST_NAMES.find(n => !used.has(n)) || `Выселки ${this.nextSettlementId}`;
    const s = this._addSettlement(Math.round(x), Math.round(y), name, false, ctx.day || 0);
    return { ok: true, settlement: s, cost: { ...OUTPOST.cost }, text: `Основано поселение «${s.name}». Обоз в столицу идёт ${s.linkDays} дн.` };
  }

  // Маршрутизация добычи. Возвращает {to:'main'|'store', amount, spill}.
  // mainRes/mainCap передаёт ядро — модуль не хранит ссылку на чужое состояние.
  deposit(settlementId, resId, amount, mainRes, mainCap) {
    const s = this.settlement(settlementId) || this.capital();
    if (!s || !(RES_IDS.includes(resId)) || !(amount > 0)) return { to: 'none', amount: 0, spill: 0 };
    if (s.store === null) {
      // Столица: ровно прежнее поведение — кладём в общую казну ядра.
      if (mainRes) {
        const cap = (mainCap && mainCap[resId] != null) ? mainCap[resId] : Infinity;
        const before = mainRes[resId] || 0;
        mainRes[resId] = Math.min(cap, before + amount);
        return { to: 'main', amount: mainRes[resId] - before, spill: amount - (mainRes[resId] - before) };
      }
      return { to: 'main', amount, spill: 0 };
    }
    const cap = OUTPOST.cap[resId] ?? Infinity;
    const before = s.store[resId];
    s.store[resId] = Math.min(cap, before + amount);
    const got = s.store[resId] - before;
    return { to: 'store', amount: got, spill: amount - got, settlement: s };
  }

  // Сумма «казна ядра + все склады выселков» — для шапки интерфейса.
  totalStock(mainRes) {
    const total = emptyStore();
    for (const r of RES_IDS) total[r] = (mainRes && mainRes[r]) || 0;
    for (const s of this.settlements) {
      if (!s.store) continue;
      for (const r of RES_IDS) total[r] += s.store[r];
    }
    return total;
  }

  // ==================================================================
  // ДЕНЬ: налёты лагерей и обозы выселков
  // ==================================================================
  tickDay(ctx = {}) {
    const day = ctx.day || 0;
    const era = ctx.eraIndex || 0;
    const events = [];

    // --- лагеря разбойников ---
    if (this._raidCooldown > 0) this._raidCooldown--;
    for (const s of this.sites) {
      if (s.kind !== 'camp' || s.destroyed) continue;
      const def = SITE_DEFS[s.def];
      s.raidTimer--;
      if (s.raidTimer > 0) continue;
      const target = this.nearestSettlement(s.x, s.y) || this.capital();
      const dist = target ? Math.hypot(s.x - target.x, s.y - target.y) : Infinity;
      // Три причины отложить налёт, и все три — про баланс, а не про правила:
      // фора на старте, общий для карты кулдаун и дальность до поселения.
      if (day < BANDIT.firstRaidDay || this._raidCooldown > 0 || dist > BANDIT.raidRange) {
        // Пересматриваем решение через несколько дней, а не копим «долг» налётов:
        // иначе после снятия ограничения все лагеря ударили бы разом.
        s.raidTimer = this.rng.int(5, 12);
        continue;
      }
      s.raidTimer = this.rng.int(def.raidEvery[0], def.raidEvery[1]);
      s.raids++;
      this._raidCooldown = BANDIT.globalGap;
      const power = this.campPower(s, era);
      const name = target ? target.name : 'поселение';
      events.push({
        type: 'banditRaid', siteId: s.id, x: s.x, y: s.y,
        power, steal: def.steal, stealPct: def.stealPct,
        target: target ? target.id : 0, targetName: name,
        textWin: `🛡 Налёт разбойников на ${name} отбит (сила ${power}).`,
        textLose: `💥 Разбойники обчистили ${name} (сила ${power}).`,
      });
    }

    // --- обозы: только у выселков, у одинокой столицы цикл пуст ---
    for (const s of this.outposts()) {
      s.convoyTimer--;
      if (s.convoyTimer > 0) continue;
      s.convoyTimer = OUTPOST.convoyEvery;
      const cargo = {};
      let any = false;
      for (const r of RES_IDS) {
        const keep = OUTPOST.keep[r] || 0;
        const send = Math.floor(s.store[r] - keep);
        if (send > 0) { cargo[r] = send; s.store[r] -= send; any = true; }
      }
      if (!any) continue;
      const convoy = { from: s.id, fromName: s.name, cargo, arriveDay: day + s.linkDays };
      // Живой лагерь у дороги — реальная причина держать армию, а не просто
      // декорация на карте: обозы грабят по пути.
      const cap = this.capital();
      const mx = (s.x + (cap ? cap.x : s.x)) / 2, my = (s.y + (cap ? cap.y : s.y)) / 2;
      const near = this.liveCamps().some(c => Math.hypot(c.x - mx, c.y - my) < 12 || Math.hypot(c.x - s.x, c.y - s.y) < 12);
      if (near && this.rng.chance(0.25)) {
        events.push({ type: 'convoyRobbed', from: s.id, cargo, text: `Обоз из «${s.name}» перехвачен разбойниками.` });
        continue;
      }
      this.convoys.push(convoy);
    }

    // --- прибытие обозов ---
    const arrived = this.convoys.filter(c => c.arriveDay <= day);
    if (arrived.length) {
      this.convoys = this.convoys.filter(c => c.arriveDay > day);
      for (const c of arrived) {
        const parts = Object.entries(c.cargo).map(([r, v]) => `${r} ${v}`).join(', ');
        events.push({ type: 'convoyArrived', from: c.from, cargo: c.cargo, text: `Обоз из «${c.fromName}» доставил: ${parts}.` });
      }
    }
    return events;
  }

  // ==================================================================
  // СЕРИАЛИЗАЦИЯ
  // ==================================================================

  // Туман пакуется RLE: 9216 байт в JSON превратились бы в ~30 КБ мусора,
  // а карта почти всегда состоит из длинных однородных полос.
  // VISIBLE при сохранении опускается до SEEN — текущая видимость всё равно
  // пересчитывается первым же updateFog, зато сейв круговой (serialize после
  // deserialize даёт байт-в-байт тот же JSON).
  _packFog() {
    const fog = this.fog, out = [];
    let v = fog[0] === FOG.VISIBLE ? FOG.SEEN : fog[0], n = 1;
    for (let i = 1; i < fog.length; i++) {
      const cur = fog[i] === FOG.VISIBLE ? FOG.SEEN : fog[i];
      if (cur === v) n++; else { out.push(v, n); v = cur; n = 1; }
    }
    out.push(v, n);
    return out;
  }

  _unpackFog(rle) {
    this.fog.fill(FOG.UNSEEN);
    this._visN = 0;
    if (!Array.isArray(rle)) return;
    let i = 0;
    for (let k = 0; k + 1 < rle.length; k += 2) {
      const v = rle[k], n = rle[k + 1];
      for (let j = 0; j < n && i < this.fog.length; j++) this.fog[i++] = v;
    }
    this._exploredDirty = true;
  }

  serialize() {
    return {
      fog: this._packFog(),
      sites: this.sites.map(s => ({ ...s })),
      nextSiteId: this.nextSiteId,
      raidCooldown: this._raidCooldown,
      settlements: this.settlements.map(s => ({ ...s, store: s.store ? { ...s.store } : null })),
      nextSettlementId: this.nextSettlementId,
      convoys: this.convoys.map(c => ({ ...c, cargo: { ...c.cargo } })),
    };
  }

  deserialize(data) {
    if (!data) return false;
    this._unpackFog(data.fog);
    if (Array.isArray(data.sites)) {
      // Определения точек берутся из таблицы по def-ключу: в сейве лежат только
      // изменяемые поля, поэтому правка SITE_DEFS не ломает старые сохранения.
      this.sites = data.sites.filter(s => SITE_DEFS[s.def]).map(s => ({ ...s }));
      this.nextSiteId = data.nextSiteId || (this.sites.reduce((m, s) => Math.max(m, s.id), 0) + 1);
    }
    if (Array.isArray(data.settlements) && data.settlements.length) {
      this.settlements = data.settlements.map(s => ({ ...s, store: s.store ? { ...s.store } : null }));
      this.nextSettlementId = data.nextSettlementId || (this.settlements.reduce((m, s) => Math.max(m, s.id), 0) + 1);
    }
    this.convoys = Array.isArray(data.convoys) ? data.convoys.map(c => ({ ...c, cargo: { ...c.cargo } })) : [];
    this._raidCooldown = data.raidCooldown || 0;
    return true;
  }
}

// Фабрика на случай, если ядру удобнее функция, а не конструктор.
export function createWorldSites(world, rng, opts) {
  return new WorldSites(world, rng, opts);
}
