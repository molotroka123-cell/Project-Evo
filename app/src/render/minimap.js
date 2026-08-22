// render/minimap.js — миникарта: местность, свои постройки, соседи, тревоги
// и отдельный режим «политическая карта».
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СЛОЙ. Прежняя миникарта жила прямо в renderer.drawMinimap и
// каждый кадр делала работу, которая меняется раз в игровой месяц: перебирала
// все постройки (до 260 fillRect), обходила все поселения всех фракций (arc на
// каждое) и заново считала прямоугольник обзора. Кэш там был ровно один — по
// сезону и сиду, и снимался он через getImageData всей terrain.low с
// последующим ручным ресемплом 14 400 пикселей. То есть смена сезона стоила
// полкадра, а всё остальное время карта платила за перерисовку неизменной
// картинки. Здесь вся статика выпекается в offscreen ОДИН РАЗ, а в кадре
// остаётся один блит, рамка обзора и несколько мигающих точек.
//
// ВЕРСИЯ ВЫПЕЧКИ. Подход взят у core/systems/borders.js: там worldVersion()
// сворачивает состав зданий и фракций в одно число, и пересчёт границ идёт,
// только когда число изменилось. Мы зовём тот же worldVersion — не копию, а
// именно его: если состав построек не менялся, миникарта и границы обязаны
// договориться об этом одинаково, иначе на политической карте будет один мир,
// а на точках построек — другой. К хешу добавлены сезон (меняет всю палитру),
// эпоха (меняет читаемость и подпись), режим карты, размер выпечки, пресет
// качества и версия границ.
//
// ОГОВОРКА ПРО НЕДОСТРОЙ. worldVersion считает только готовые постройки
// (!b.done пропускается). Если бы мы полагались только на него, точка стройки
// не появлялась бы до сдачи дома. Поэтому к версии добавлен свой маленький хеш
// недостроя — по числу и координатам площадок, а НЕ по b.progress: прогресс
// меняется каждый игровой час, и выпечка шла бы заново по десять раз в минуту,
// то есть кэш просто перестал бы существовать.
//
// СЛУЧАЙНОСТЬ. Math.random запрещён, sim.rng из рендера — тем более: рендер
// идёт с частотой монитора, и каждый его вызов сдвигал бы состояние симуляции,
// после чего сейв разъехался бы у двух игроков с разными FPS. Всё «случайное»
// здесь — детерминированный hash2(x, y) из palette.js (тот же приём, что в
// water.js/relief.js/vegetation.js): им берётся дизер тайла и фаза мигания
// тревожной точки, чтобы десять точек не моргали строем.
//
// ЦЕНА КАДРА (оценка; замер за главным разработчиком).
// Стенд для сравнения — тот же, что в docs/visual-performance-budget.md:
// программная растеризация, 1600×900, dpr 1. Каждый кадр слой делает:
//   • 2 fillRect подложки и рамки                       ~0,02 мс
//   • 1 drawImage 120×120 без масштабирования           ~0,05–0,12 мс
//     (без масштаба — самый быстрый путь блита: выпечка сделана ровно в тот
//      размер, в котором её кладут, поэтому фильтрация не включается вообще)
//   • 2 strokeRect рамки обзора                         ~0,02 мс
//   • до 10 тревожных точек, по 1–2 fillRect каждая     ~0,04 мс
//   ИТОГО ~0,15–0,25 мс — около 1,2 % кадра в 16,6 мс.
// Прежняя версия на том же городе: 260 fillRect построек + до 12 arc поселений
// + расчёт рамки ≈ 0,6–0,9 мс каждый кадр, плюс 3–5 мс на кадре смены сезона.
//
// Выпечка (не в каждом кадре, а на смену сезона/эпохи/состава построек —
// единицы раз за игровой час):
//   • 14 400 пикселей ImageData с выборкой тайла и эмбоссом  ~0,3–0,5 мс
//   • до 260 точек построек и поселений                      ~0,2 мс
//   • политический режим: заливка владения в том же проходе + до 4 000
//     отрезков границы, сгруппированных в один путь на владельца ~0,5–1,2 мс
//   ИТОГО худшая выпечка ~1,7 мс — один раз, не в каждом кадре. Это меньше
//   кадрового бюджета, поэтому дробить её на части (как chunksPerFrame в
//   terrain.js) смысла нет: разрыв в 1,7 мс не виден, а машинерия дробления
//   стоила бы дороже самой работы.
//
// ЗАМЕР ЛОГИКИ (node, подставной контекст 2D: считается только JS, вызовы
// растеризатора заглушены — их время меряет главный разработчик в браузере;
// мир 96×96, 301 постройка, 6 фракций по два поселения, 1 712 отрезков границы):
//   выпечка, прогретая, обычная карта                        0,57 мс
//   выпечка, прогретая, политическая карта                   0,71 мс
//   кадр без выпечки, вся арифметика слоя                    0,012 мс
// Из этих 12 мкс почти всё — worldVersion по 301 постройке. Кэшировать его по
// таймеру заманчиво, но тогда снесённое рейдом здание висело бы на карте до
// следующего тика кэша, а 12 мкс — это 0,07 % кадра. Не тот размен.
//
// ПОТОЛКИ. Точек построек не больше q.caps.buildings, тревожных меток не
// больше 4 + 3·q.detail (eco 4, medium 7, high/ultra 10), отрезков границы не
// больше 4 000. Кэшей у слоя ровно два канваса по 120×120×4 = 57,6 КБ, поэтому
// LRU-вытеснение из quality.js (prune) здесь не нужно — вытеснять нечего;
// canvasBytes оставлен для диагностики через bytes().
import { TILE, BUILDINGS, FACTIONS } from '../core/data.js';
import { TERRAIN, TILE_HEIGHT, hex2rgb, hash2 } from './palette.js';
import { QUALITY_ORDER, lodForZoom, canvasBytes } from './quality.js';
import {
  worldVersion, borderEdges, territoryStats, OWNER_PLAYER,
} from '../core/systems/borders.js';

// Сторона выпечки в CSS-пикселях. 120 — это и прежний размер (не ломаем
// попадание пальцем и подсветку из ui/coach.js), и удобное число: мир 96×96
// ложится в него с масштабом 1,25 px на клетку, то есть постройка размером в
// клетку остаётся различимой точкой, а не подпиксельной пылью.
const MAP_PX = 120;
// На узком экране (телефон в портрете) 120 px — это шестая часть ширины и
// половина большого пальца. Ужимаем до 92: рамка обзора там всё равно закрывает
// почти всю карту, а место под HUD дороже.
const MAP_PX_SMALL = 92;
const MARGIN = 10;
// Правый край занимает #sidePanel: 320 ширины + 8 отступа + 10 зазора. Порог
// 820 — та же ширина, на которой панель прячется в вёрстке; ниже неё карта
// прижимается к краю. Число унаследовано от прежней миникарты намеренно:
// разъехавшиеся пороги дали бы карту, наполовину ушедшую под панель.
const PANEL_W = 338;
const PANEL_GAP = 10;
const NARROW_CW = 820;
const SMALL_CW = 560;

// Сколько реального времени горит здание после сноса. В ядре у построек нет ни
// поля «горит», ни отметки времени: рейд просто ставит destroyed = true и
// оставляет объект в sim.buildings навсегда. Значит, «пожар» — это не состояние
// мира, а СОБЫТИЕ перехода, и заметить его может только тот, кто смотрит на мир
// каждый кадр, то есть рендер. 12 секунд подобраны по fx.js: дым сноса там
// живёт 7 с, и метка на карте должна пережить его, чтобы игрок, отвернувшийся
// к панели технологий, всё-таки успел увидеть, ГДЕ горело.
const BURN_SEC = 12;
// Пересчёт списка тревог. 5 раз в секунду хватает: мигание всё равно плавное и
// считается от времени, а состав тревог меняется раз в игровые сутки.
const ALARM_HZ = 5;
const MAX_EDGES = 4000;
const TAU = Math.PI * 2;

// Тревоги. hz — частота мигания: чем страшнее, тем быстрее. Разные частоты
// важнее разных цветов — на 120 пикселях оттенок читается хуже, чем ритм.
export const ALARM_STYLE = {
  raid:   { color: '#ff4d4d', hz: 2.2, prio: 0 }, // набег
  fire:   { color: '#ff9a3c', hz: 1.6, prio: 1 }, // пожар/снос
  hunger: { color: '#ffe08a', hz: 1.0, prio: 2 }, // голодающий город
};

const PLAYER_GOLD = '#c9a227';

// ---------------------------------------------------------------------------
// Чистые функции. Вынесены наружу класса не ради красоты: канваса в node нет,
// а проверять раскладку, версию кэша, попадание мыши и отбор тревог надо.
// Всё, что ниже, живёт без document и тестируется напрямую.
// ---------------------------------------------------------------------------

// Место миникарты на экране. Возвращает и scale — его читают main.js (прыжок
// камеры по тапу) и ui/coach.js (подсветка), поэтому поле обязано остаться.
export function minimapLayout(cw, ch, world, size) {
  const W = (world && world.w) || 96, H = (world && world.h) || 96;
  const base = size || (cw < SMALL_CW || ch < SMALL_CW ? MAP_PX_SMALL : MAP_PX);
  // Карту не растягиваем: неквадратный мир получает пропорциональную высоту,
  // иначе постройки поехали бы относительно рамки обзора.
  const w = base;
  const h = Math.max(24, Math.round(base * H / W));
  const panel = cw > NARROW_CW ? PANEL_W : PANEL_GAP;
  return {
    x: Math.round(cw - w - panel),
    y: Math.round(ch - h - MARGIN),
    w, h,
    scale: w / W,      // px на клетку по X — совместимость с main.js
    scaleY: h / H,
  };
}

// Хеш всего, от чего зависит КАРТИНКА выпечки. Меняется число — печём заново.
export function minimapVersion(sim, mode, size, qId) {
  let v = mode === 'political' ? 0x9e37 : 0x1f17;
  const mix = (n) => { v = (Math.imul(v, 31) + (n | 0)) | 0; };
  mix(sim.world.seed);
  mix(sim.world.w * 131 + sim.world.h);
  mix((sim.seasonIdx | 0) * 7 + (sim.eraIndex | 0) * 131);
  mix((size | 0) * 17 + (QUALITY_ORDER.indexOf(qId) + 1) * 911);
  // Тот же хеш, которым живут границы: две системы обязаны считать «мир не
  // менялся» одинаково, иначе политическая заливка отстанет от точек построек.
  mix(worldVersion(sim.buildings, sim.factions));
  mix(pendingVersion(sim.buildings));
  const bs = bordersOf(sim);
  if (bs) mix((bs.version | 0) * 13 + (bs.recomputes | 0));
  return v;
}

// Хеш недостроя: только координаты площадок, без прогресса. См. оговорку в шапке.
export function pendingVersion(buildings) {
  let v = 5381;
  for (const b of buildings || []) {
    if (b.done || b.destroyed) continue;
    v = (Math.imul(v, 33) + (b.x * 97 + b.y * 7919)) | 0;
  }
  return v;
}

// Прямоугольник текущего вида камеры в координатах миникарты.
// Обрезается по краям карты: на дальнем зуме поле зрения шире мира, и без
// обрезки рамка вылезала бы за подложку и мазала HUD.
export function viewportRect(rect, cam, tilePx, viewW, viewH) {
  const z = (tilePx || 32) * (cam.zoom || 1);
  const halfW = viewW / 2 / z, halfH = viewH / 2 / z;
  const x1 = (cam.x - halfW) * rect.scale, x2 = (cam.x + halfW) * rect.scale;
  const y1 = (cam.y - halfH) * rect.scaleY, y2 = (cam.y + halfH) * rect.scaleY;
  const cx1 = Math.max(0, Math.min(rect.w, x1)), cx2 = Math.max(0, Math.min(rect.w, x2));
  const cy1 = Math.max(0, Math.min(rect.h, y1)), cy2 = Math.max(0, Math.min(rect.h, y2));
  return { x: rect.x + cx1, y: rect.y + cy1, w: Math.max(1, cx2 - cx1), h: Math.max(1, cy2 - cy1) };
}

// Экранная точка → клетка мира. Пригодится и main.js, и любому будущему
// перетаскиванию рамки: сейчас main.js делит на m.scale вручную.
export function hitToWorld(rect, px, py) {
  if (!rect) return null;
  if (px < rect.x || py < rect.y || px > rect.x + rect.w || py > rect.y + rect.h) return null;
  return { x: (px - rect.x) / rect.scale, y: (py - rect.y) / rect.scaleY };
}

// Цвет владельца по коду из borders.js. 1 — игрок, дальше FACTIONS по порядку
// таблицы (код = индекс + 2, это контракт borders.js, а не наша выдумка).
export function ownerColor(code) {
  if (code === OWNER_PLAYER) return PLAYER_GOLD;
  const f = FACTIONS[code - 2];
  return f ? f.color : '#6a6f7a';
}

// Где живёт состояние границ. core/systems/integrate.js кладёт его в
// sim.sys.borders (а рядом — уже посчитанную сводку sim.sys.borderStats), но в
// шапке самого borders.js описан вариант с sim.borders. Проверяем оба: слой не
// должен зависеть от того, какой из двух путей выберет интегратор.
export function bordersOf(sim) {
  const s = (sim.sys && sim.sys.borders) || sim.borders;
  return s && s.owners ? s : null;
}

// Сердце поселения игрока: кострище, а если его снесли — точка основания.
export function playerHeart(sim) {
  const c = (sim.buildings || []).find(b => b.id === 'campfire' && !b.destroyed);
  if (c) return { x: c.x + (c.size || 1) / 2, y: c.y + (c.size || 1) / 2 };
  return { x: sim.world.startX, y: sim.world.startY };
}

// Прозрачность мигающей точки. Ниже 0,25 не опускаемся: полностью гаснущая
// точка на 120 пикселях читается как «её нет», а не как «она мигает».
// Фаза — от hash2 по координатам, чтобы метки не моргали в такт.
export function blinkAlpha(time, kind, x, y) {
  const st = ALARM_STYLE[kind] || ALARM_STYLE.raid;
  const ph = hash2(Math.floor(x), Math.floor(y)) * TAU;
  return 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(time * st.hz * TAU + ph));
}

// Отбор тревог. fires передаётся снаружи: пожар — событие перехода, увидеть
// его может только тот, кто помнит прошлый кадр (см. BURN_SEC в шапке).
export function collectAlarms(sim, opts = {}) {
  const limit = opts.limit == null ? 10 : opts.limit;
  const out = [];

  // 1. Набег. Отмечаем и цель (наше поселение), и того, откуда идут: игроку
  //    важнее направление удара, чем сам факт — по нему он решает, куда вести
  //    ополчение.
  if (sim.raids && sim.raids.warning) {
    const heart = playerHeart(sim);
    out.push({ kind: 'raid', x: heart.x, y: heart.y, prio: 0 });
    const f = sim.raids.from && (sim.factions || []).find(q => q.id === sim.raids.from && q.alive);
    const s = f && f.settlements && f.settlements[0];
    if (s) out.push({ kind: 'raid', x: s.x, y: s.y, prio: 0 });
  }

  // 2. Пожар. Два источника: свежий снос (пришёл списком снаружи) и здание,
  //    просевшее по прочности ниже 60 % — тот же порог, по которому fx.js
  //    зажигает язычки пламени, чтобы карта и сцена не спорили друг с другом.
  for (const p of opts.fires || []) out.push({ kind: 'fire', x: p.x, y: p.y, prio: 1 });
  for (const b of sim.buildings || []) {
    if (b.destroyed || b.hp == null) continue;
    const maxHp = (BUILDINGS[b.id] || {}).wall || 100;
    if (b.hp < maxHp * 0.6) {
      const s = (b.size || 1) / 2;
      out.push({ kind: 'fire', x: b.x + s, y: b.y + s, prio: 1 });
    }
  }

  // 3. Голод. В ядре нет флага «город голодает», зато есть два надёжных следа:
  //    пустой склад еды при живых жителях и sim.starvedDay — день, когда голод
  //    кого-то убил. Второй важнее: склад за ночь подрастает на пару мешков и
  //    формально выходит из голода, пока людей ещё хоронят (об этой ловушке
  //    прямо написано в simulation.js). Держим метку двое суток после смерти.
  const pop = (sim.villagers || []).length;
  const starving = (sim.res && sim.res.food <= 0 && pop > 0)
    || (sim.starvedDay != null && sim.day - sim.starvedDay <= 2);
  if (starving) {
    const heart = playerHeart(sim);
    out.push({ kind: 'hunger', x: heart.x, y: heart.y, prio: 2 });
  }

  // 4. Чужие метки — задел на будущее: если ядро когда-нибудь заведёт свои
  //    поводы для тревоги, их не придётся проносить через этот файл.
  for (const a of sim.minimapAlarms || []) {
    if (a && ALARM_STYLE[a.kind]) out.push({ kind: a.kind, x: a.x, y: a.y, prio: ALARM_STYLE[a.kind].prio });
  }

  // Сортировка до обрезки: под потолок должны попасть набеги, а не десятый
  // подряд пожар сарая.
  out.sort((a, b) => a.prio - b.prio);
  return limit >= 0 && out.length > limit ? out.slice(0, limit) : out;
}

// ---------------------------------------------------------------------------
// Слой.
// ---------------------------------------------------------------------------
export class MinimapLayer {
  constructor(q) {
    this.q = q;
    this.mode = 'terrain';      // 'terrain' | 'political'
    this.face = null;           // выпечка: местность/политика + статичные точки
    this.faceVer = null;        // версия, на которой она испечена
    this.rect = null;           // последняя раскладка (её читают main.js/coach.js)
    this.bakes = 0;             // счётчик выпечек — метрика и проверка кэша
    this.lastBakeMs = 0;
    this._burn = new Map();     // здание → до какого времени горит
    this._seen = new WeakSet(); // какие сносы уже учтены
    this._cold = true;          // первый проход: не поджигаем старые руины
    this._seed = null;
    this._alarms = [];
    this._alarmT = -1e9;
  }

  setQuality(q) {
    if (q === this.q) return;
    this.q = q;
    this.invalidate();          // detail влияет на эмбосс, caps — на число точек
  }

  invalidate() { this.face = null; this.faceVer = null; }

  setMode(mode) {
    const m = mode === 'political' ? 'political' : 'terrain';
    if (m === this.mode) return this.mode;
    this.mode = m;
    this.invalidate();
    return this.mode;
  }

  toggleMode() { return this.setMode(this.mode === 'political' ? 'terrain' : 'political'); }

  // Диагностика: сколько памяти держит слой.
  bytes() { return canvasBytes(this.face); }

  // Экранная точка → клетка мира (или null мимо карты).
  hit(px, py) { return hitToWorld(this.rect, px, py); }

  // -------------------------------------------------------------------------
  // Кадр. Возвращает rect — его renderer кладёт в this.minimapRect.
  draw(sim, ctx, cw, ch, opts = {}) {
    if (!sim || !sim.world || !ctx) return this.rect;
    if (opts.quality) this.setQuality(opts.quality);
    const time = opts.time || 0;
    const cam = opts.cam || { x: 0, y: 0, zoom: 1 };
    const tilePx = opts.tilePx || 32;

    // Новый мир (новая игра или загрузка сейва) — забываем всё: чужие руины не
    // должны вспыхнуть на первом же кадре, а старая выпечка не годится совсем.
    if (this._seed !== sim.world.seed) {
      this._seed = sim.world.seed;
      this._burn.clear();
      this._seen = new WeakSet();
      this._cold = true;
      this.invalidate();
    }

    // Политический режим включается и снаружи (this.mode), и штатным
    // переключателем территорий: sim.showTerritory уже есть в ядре и уже
    // управляется HUD, так что режим работает без единой правки в UI.
    const wantPolitical = this.mode === 'political' || !!sim.showTerritory;
    const mode = wantPolitical ? 'political' : 'terrain';

    const rect = minimapLayout(cw, ch, sim.world, opts.size);
    const ver = minimapVersion(sim, mode, rect.w, this.q.id);
    if (!this.face || this.faceVer !== ver || this.face.width !== rect.w || this.face.height !== rect.h) {
      const baked = this._bake(sim, mode, rect);
      if (baked) { this.face = baked; this.faceVer = ver; }
    }

    ctx.save();
    // Подложка. Она же рамка: тёмная плашка на 3 px шире карты со всех сторон
    // отделяет карту от сцены надёжнее любой обводки — на светлом песке белая
    // рамка теряется, а тёмный контур виден всегда.
    ctx.fillStyle = 'rgba(10,14,24,0.75)';
    ctx.fillRect(rect.x - 3, rect.y - 3, rect.w + 6, rect.h + 6);
    if (this.face) ctx.drawImage(this.face, rect.x, rect.y);

    // Рамка обзора: сначала тёмная подложка, потом светлая линия. Одна белая
    // линия пропадает на снегу и на песке — вторая стоит 0,01 мс и решает это.
    const v = viewportRect(rect, cam, tilePx, cw, ch);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeRect(v.x - 0.5, v.y - 0.5, v.w + 1, v.h + 1);
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeRect(v.x + 0.5, v.y + 0.5, v.w - 1, v.h - 1);

    this._drawAlarms(sim, ctx, rect, time, cam);
    ctx.restore();

    this.rect = rect;
    return rect;
  }

  // -------------------------------------------------------------------------
  // Тревоги.
  _drawAlarms(sim, ctx, rect, time, cam) {
    // Потолок от пресета: на eco 4 метки, на ultra 10. Больше десяти точек на
    // 120 пикселях — уже не тревога, а рябь.
    const limit = Math.min(10, 4 + this.q.detail * 3);
    if (time - this._alarmT > 1 / ALARM_HZ) {
      this._alarmT = time;
      this._trackFires(sim, time);
      const fires = [];
      for (const b of this._burn.keys()) {
        const s = (b.size || 1) / 2;
        fires.push({ x: b.x + s, y: b.y + s });
      }
      this._alarms = collectAlarms(sim, { fires, limit });
    }
    if (!this._alarms.length) return;

    // Дальний зум: рамка обзора и так накрывает почти всю карту, метки на её
    // фоне сливаются в кашу — ужимаем их и снимаем ореол.
    const far = lodForZoom(this.q, cam.zoom || 1).far;
    const s = far ? 3 : 4;
    const halo = this.q.detail >= 2 && !far;
    for (const a of this._alarms) {
      const px = rect.x + Math.max(1, Math.min(rect.w - 1, a.x * rect.scale));
      const py = rect.y + Math.max(1, Math.min(rect.h - 1, a.y * rect.scaleY));
      const st = ALARM_STYLE[a.kind];
      const al = blinkAlpha(time, a.kind, a.x, a.y);
      if (halo) {
        ctx.globalAlpha = al * 0.22;
        ctx.fillStyle = st.color;
        ctx.fillRect(px - s, py - s, s * 2, s * 2);
      }
      ctx.globalAlpha = al;
      ctx.fillStyle = st.color;
      ctx.fillRect(px - s / 2, py - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  // Пожар — событие перехода: ядро только ставит destroyed = true и оставляет
  // объект в списке навсегда. Ловим момент появления флага и держим метку
  // BURN_SEC секунд. Ключ — сам объект здания: id у построек не уникален.
  _trackFires(sim, time) {
    for (const [b, until] of this._burn) if (until <= time) this._burn.delete(b);
    for (const b of sim.buildings || []) {
      if (!b.destroyed) continue;
      if (this._seen.has(b)) continue;
      this._seen.add(b);
      if (!this._cold) this._burn.set(b, time + BURN_SEC);
    }
    this._cold = false;
  }

  // -------------------------------------------------------------------------
  // Выпечка. Всё, что здесь делается, живёт до смены сезона, эпохи, состава
  // построек, границ, режима или пресета.
  _bake(sim, mode, rect) {
    if (typeof document === 'undefined') return null;  // node: слой молчит
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const W = sim.world.w, H = sim.world.h, tiles = sim.world.tiles;
    const mw = rect.w, mh = rect.h;
    const cv = document.createElement('canvas');
    cv.width = mw; cv.height = mh;
    const c = cv.getContext('2d');

    // --- 1. Пиксели: местность (и, в политическом режиме, владение) ---
    const pal = TERRAIN[sim.seasonIdx] || TERRAIN[0];
    // Палитра разворачивается в плоские массивы ОДИН раз на выпечку: hex2rgb на
    // каждый из 14 400 пикселей — это 14 400 parseInt, дороже всей остальной
    // выпечки вместе взятой.
    const base = [], hgt = [];
    for (const k of Object.keys(TILE)) {
      const t = TILE[k];
      base[t] = hex2rgb(pal[t].base);
      hgt[t] = TILE_HEIGHT[t] || 0;
    }
    const owners = this._ownersOf(sim, mode, W, H);
    const oCol = owners ? this._ownerColors() : null;
    // Эмбосс — разница высот с соседом сверху-слева. Без него холмы, лес и
    // трава на 120 пикселях сливаются в одно зелёное пятно, и карта перестаёт
    // отвечать на вопрос «куда ставить каменоломню». На eco (detail 0) выключен:
    // там каждая лишняя выборка тайла — это два лишних чтения памяти на пиксель.
    const emboss = this.q.detail >= 1;

    const img = c.createImageData(mw, mh);
    const d = img.data;
    const kx = W / mw, ky = H / mh;
    for (let y = 0; y < mh; y++) {
      const wy = Math.min(H - 1, (y * ky) | 0);
      for (let x = 0; x < mw; x++) {
        const wx = Math.min(W - 1, (x * kx) | 0);
        const wi = wy * W + wx;
        const t = tiles[wi];
        const b = base[t] || base[TILE.GRASS];
        let r = b[0], g = b[1], bl = b[2];

        if (emboss) {
          const px = wx > 0 ? wx - 1 : 0, py = wy > 0 ? wy - 1 : 0;
          // 26 — множитель наклона: перепад «трава → гора» это 1,25 по
          // TILE_HEIGHT, что даёт ±32 к каналу — заметно, но не выжигает цвет.
          const k = (hgt[t] - (hgt[tiles[py * W + px]] || 0)) * 26;
          const kk = k > 22 ? 22 : (k < -22 ? -22 : k);
          r += kk; g += kk; bl += kk;
        }
        // Дизер ±3 по детерминированному хешу: без него крупные однотонные
        // области (море, зимняя равнина) выглядят пластиковой заливкой.
        const n = hash2(wx, wy) * 6 - 3;
        r += n; g += n; bl += n;

        if (owners) {
          const o = owners[wi];
          if (o) {
            // 0,62 к цвету владельца: местность обязана просвечивать, иначе
            // политическая карта перестаёт быть картой и становится диаграммой.
            const oc = oCol[o];
            r += (oc[0] - r) * 0.62; g += (oc[1] - g) * 0.62; bl += (oc[2] - bl) * 0.62;
          } else if (t !== TILE.DEEP && t !== TILE.WATER) {
            // Ничья суша уводится в серое: цветное пятно рядом с цветной
            // территорией читается как ещё одна держава.
            const lum = r * 0.3 + g * 0.59 + bl * 0.11;
            r += (lum - r) * 0.55; g += (lum - g) * 0.55; bl += (lum - bl) * 0.55;
            r *= 0.85; g *= 0.85; bl *= 0.85;
          }
        }
        const di = (y * mw + x) * 4;
        // Uint8ClampedArray сам обрезает выход за 0..255 — ручной clamp был бы
        // 43 200 лишних сравнений на выпечку.
        d[di] = r; d[di + 1] = g; d[di + 2] = bl; d[di + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);

    // --- 2. Векторный слой поверх пикселей ---
    const bs = owners ? bordersOf(sim) : null;
    if (bs) this._bakeBorders(c, bs, rect);
    this._bakeDots(c, sim, rect);
    if (bs) this._bakeLegend(c, sim, bs, rect);

    this.bakes++;
    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    this.lastBakeMs = t1 - t0;
    return cv;
  }

  // Сетка владения из borders.js — или null, если границ ещё нет (старый сейв,
  // первый день до первого пересчёта). Тогда политический режим честно
  // деградирует до обычной местности, а не падает.
  _ownersOf(sim, mode, W, H) {
    if (mode !== 'political') return null;
    const bs = bordersOf(sim);
    if (!bs || bs.owners.length !== W * H) return null;
    return bs.owners;
  }

  _ownerColors() {
    const out = [];
    for (let code = 0; code <= FACTIONS.length + 1; code++) out[code] = hex2rgb(ownerColor(code));
    return out;
  }

  // Кромка границы. Отрезки группируются в один путь на владельца: 1 500
  // отдельных beginPath/stroke стоят на порядок дороже, чем 6 путей по 250
  // отрезков — накладные расходы на смену состояния контекста тут главные.
  _bakeBorders(c, bs, rect) {
    const edges = borderEdges(bs) || [];
    if (!edges.length) return;
    const byOwner = new Map();
    const n = Math.min(edges.length, MAX_EDGES);
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      let arr = byOwner.get(e.owner);
      if (!arr) { arr = []; byOwner.set(e.owner, arr); }
      arr.push(e);
    }
    c.lineWidth = 1;
    for (const [code, arr] of byOwner) {
      c.strokeStyle = ownerColor(code);
      c.globalAlpha = 0.9;
      c.beginPath();
      for (const e of arr) {
        // +0.5 — попадание в центр пикселя: без него линия шириной 1 размазана
        // на два ряда полупрозрачных пикселей и выглядит грязью.
        c.moveTo(Math.round(e.x1 * rect.scale) + 0.5, Math.round(e.y1 * rect.scaleY) + 0.5);
        c.lineTo(Math.round(e.x2 * rect.scale) + 0.5, Math.round(e.y2 * rect.scaleY) + 0.5);
      }
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  // Точки: свои постройки и поселения соседей.
  _bakeDots(c, sim, rect) {
    const cap = this.q.caps.buildings;
    let drawn = 0;
    // Свои — золотом. Крупная постройка (size > 1) получает точку на пиксель
    // больше: на 120 пикселях замок и хижина иначе неразличимы.
    c.fillStyle = PLAYER_GOLD;
    for (const b of sim.buildings || []) {
      if (b.destroyed || !b.done) continue;
      if (drawn++ >= cap) break;
      const s = (b.size || 1) / 2;
      const px = Math.round((b.x + s) * rect.scale), py = Math.round((b.y + s) * rect.scaleY);
      const r = (b.size || 1) > 1 ? 2 : 1;
      c.fillRect(px - r, py - r, r * 2 + 1, r * 2 + 1);
    }
    // Недострой — тусклая полая точка: игрок видит, что место занято, но не
    // путает площадку с работающим зданием.
    c.fillStyle = 'rgba(201,162,39,0.45)';
    for (const b of sim.buildings || []) {
      if (b.destroyed || b.done) continue;
      if (drawn++ >= cap) break;
      const s = (b.size || 1) / 2;
      c.fillRect(Math.round((b.x + s) * rect.scale) - 1, Math.round((b.y + s) * rect.scaleY) - 1, 2, 2);
    }

    // Соседи — своим цветом из таблицы фракций. Тёмная обводка обязательна:
    // «Орден Зари» имеет цвет #e8ddc0 и на песке исчезает без неё полностью.
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(0,0,0,0.6)';
    for (const f of sim.factions || []) {
      if (!f.alive) continue;
      c.fillStyle = f.def.color;
      for (const s of f.settlements || []) {
        const px = s.x * rect.scale, py = s.y * rect.scaleY;
        c.beginPath();
        c.arc(px, py, s.capital ? 3 : 2, 0, TAU);
        c.fill();
        c.stroke();
      }
    }
  }

  // Подпись политического режима и полоса долей территории. Всё выпекается:
  // текст в кадре — самая дорогая мелочь, какую можно себе позволить, а
  // меняются эти данные вместе с границами, то есть вместе с выпечкой.
  _bakeLegend(c, sim, bs, rect) {
    // Ядро уже считает эту сводку раз в игровой день и кладёт в sim.sys.borderStats
    // (см. tickBordersFor в core/systems/integrate.js). Считать её второй раз —
    // это лишний проход по всем кодам владельцев на каждой выпечке.
    const stats = (sim.sys && sim.sys.borderStats) || territoryStats(bs) || [];
    const barH = 5, y = rect.h - barH;
    c.fillStyle = 'rgba(8,11,18,0.55)';
    c.fillRect(0, y, rect.w, barH);
    let total = 0;
    for (const s of stats) total += s.tiles;
    if (total > 0) {
      let x = 0;
      for (const s of stats) {
        const w = rect.w * s.tiles / total;
        c.fillStyle = ownerColor(s.code);
        c.fillRect(x, y, Math.max(1, w), barH);
        x += w;
      }
    }
    // Подпись — 8 px: не для чтения слова целиком, а чтобы игрок не гадал,
    // почему карта вдруг перекрасилась. Тень вместо обводки: strokeText по
    // мелкому шрифту даёт кашу.
    c.font = '8px sans-serif';
    c.textAlign = 'left';
    c.fillStyle = 'rgba(0,0,0,0.7)';
    c.fillText('ПОЛИТИЧЕСКАЯ', 4, 11);
    c.fillStyle = 'rgba(235,240,250,0.85)';
    c.fillText('ПОЛИТИЧЕСКАЯ', 3, 10);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ПОДКЛЮЧЕНИЕ
//
// Все якоря ниже проверены grep-ом по app/src/render/renderer.js в том виде, в
// каком файл лежит сейчас. Отступы значимы — копировать строку целиком.
//
// ---------------------------------------------------------------------------
// 1) ИМПОРТ. Якорь (совпадений: 1):
//
// import { FxLayer } from './fx.js';
//
//    СРАЗУ ПОСЛЕ него добавить:
//
// import { MinimapLayer } from './minimap.js';
//
// ---------------------------------------------------------------------------
// 2) КОНСТРУКТОР. Якорь (совпадений: 1):
//
//     this.fx = new FxLayer(this.quality);
//
//    СРАЗУ ПОСЛЕ него добавить:
//
//     this.minimap = new MinimapLayer(this.quality);
//
// ---------------------------------------------------------------------------
// 3) ВЫЗОВ В КАДРЕ. Якорь (совпадений: 1):
//
//     this.drawMinimap(sim, ctx, cw, ch);
//
//    ЗАМЕНИТЬ эту строку целиком на:
//
//     this.minimapRect = this.minimap.draw(sim, ctx, cw, ch, {
//       cam: this.cam, tilePx: TILE_PX, time: this.time, quality: this.quality,
//     });
//
//    Важно: присваивание this.minimapRect обязательно — по этому полю живут
//    прыжок камеры по тапу (app/src/main.js, обработчик click) и подсветка
//    обучения (app/src/ui/coach.js, minimapTarget). Поля x, y, w, h и scale в
//    возвращаемом объекте те же, что раньше, так что оба места менять не надо.
//
//    Строка `  drawMinimap(sim, ctx, cw, ch) {` (объявление старого метода,
//    другой отступ и без this. — как якорь с ней не путается) остаётся мёртвой.
//    Её можно удалить целиком вместе с телом метода — это освобождает и поля
//    _miniCache/_miniSeason/_miniSeed, которые больше никто не читает.
//
// ---------------------------------------------------------------------------
// 4) СМЕНА ПРЕСЕТА — не обязательно, но желательно для единообразия.
//    Якорь (совпадений: 2!):
//
//     this.fx.setQuality(this.quality);
//
//    Первое совпадение — в методе setQuality() (ручной выбор качества),
//    второе — в tuneAuto() (авто-тюнер). Строку
//
//     this.minimap.setQuality(this.quality);
//
//    добавить ПОСЛЕ КАЖДОГО из двух совпадений.
//
//    Если этого не сделать, слой всё равно не отстанет: draw() получает пресет
//    в opts.quality и вызывает setQuality сам. Правка нужна только чтобы
//    миникарта не выбивалась из общего списка слоёв в файле.
//
// ---------------------------------------------------------------------------
// 5) ПЕРЕКЛЮЧАТЕЛЬ ПОЛИТИЧЕСКОЙ КАРТЫ — правок НЕ ТРЕБУЕТ.
//    Слой сам включает политический режим, когда sim.showTerritory === true
//    (этот флаг уже есть в ядре и уже переключается из HUD вместе с показом
//    территорий в сцене). Если понадобится отдельная кнопка или горячая
//    клавиша, снаружи достаточно позвать:
//
//      renderer.minimap.toggleMode();          // 'terrain' <-> 'political'
//      renderer.minimap.setMode('political');
//
// ---------------------------------------------------------------------------
// ЧТО РАБОТАЕТ САМО, БЕЗ ЕДИНОЙ ПРАВКИ В ЯДРЕ
//   • перевыпечка на смене сезона, эпохи, любой достройке/сносе/постановке
//     площадки, любом пересчёте границ, смене пресета и размера карты;
//   • тревога «набег» — по sim.raids.warning, отмечает и цель, и агрессора;
//   • тревога «пожар» — по появлению b.destroyed (слой сам ловит переход) и по
//     b.hp ниже 60 % от предела, если ядро когда-нибудь заведёт урон зданиям;
//   • тревога «голод» — по пустому складу еды и по sim.starvedDay;
//   • политическая заливка, кромки границ и полоса долей — из sim.sys.borders
//     (или sim.borders, если интегратор положит состояние туда); если границ
//     ещё нет, режим тихо показывает обычную местность.
//
// ДИАГНОСТИКА (из консоли):
//   renderer.minimap.bakes        — сколько раз перепекали (в покое не растёт)
//   renderer.minimap.lastBakeMs   — длительность последней выпечки
//   renderer.minimap.bytes()      — память под выпечкой, байт (~57,6 КБ)
// ═══════════════════════════════════════════════════════════════════════════
