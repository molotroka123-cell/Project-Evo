// render/fx.js — библиотека эффектов: дым, искры, пыль, огонь, снопы, метеоры
// и всплывающие числа.
//
// ЗАЧЕМ. В игре 36 событий (core/data.js, EVENT_DEFS) и ни одно из них не видно
// на карте: журнал пишет строку, а картинка не меняется вообще — это П20
// из docs/graphics-audit.md («игра не празднует ни одного собственного
// события»). Модуль закрывает пункт 2.3 дорожной карты: пыль постройки, искры
// горна, всплеск урожая, дым пожара, обломки разрушения.
//
// ГРАНИЦЫ. Модуль — чистое представление: читает состояние симуляции и НИЧЕГО
// в ней не меняет. Ядро о нём не знает. Он не трогает ни renderer.js, ни
// weather.js — подключение описано внизу файла, в блоке «ПОДКЛЮЧЕНИЕ».
//
// СЛУЧАЙНОСТЬ. Math.random в проекте запрещён, rng ядра трогать тоже нельзя:
// каждый его вызов сдвигает состояние симуляции, а рендер у разных игроков
// работает с разной частотой — сейв бы поплыл. Поэтому внутри свой xorshift,
// засеянный сидом мира: картинка повторяема, симуляция не задета. Ровно так же
// поступает weather.js.
//
// ПОТОЛКИ. Все пулы выделены один раз в конструкторе и НИКОГДА не растут:
// активна только голова массива длиной n. Переполнение не роняет кадр и не
// копит мусор — лишний запрос на частицу просто отклоняется.
//
// ЭМИТТЕРЫ. У каждого эмиттера есть ttl. Событие кончилось — эмиттер снят
// (обмен с хвостом и уменьшение счётчика), после этого он не порождает ни
// одной частицы. Долгоживущих источников без ttl в модуле нет: непрерывные
// эффекты (дым труб, тление повреждённого здания) — это не эмиттеры, а функция
// от текущего состояния зданий, пересчитываемая каждый кадр.
import { BUILDINGS, BUILDING_ERA_IDX, EVENT_DEFS, RES } from '../core/data.js';
import { ARCH, archHeight } from './sprites.js';
import { lightAt, hash2 } from './palette.js';

// ---------------------------------------------------------------------------
// Потолки пулов. Подобраны от бюджета кадра (docs/visual-performance-budget.md
// §5.2): вся атмосфера вместе с погодой имеет 1,5 мс на пресете high. Каждая
// частица — один drawImage испечённого пятна, порядка 3–5 мкс на программной
// растеризации. 600 частиц худшего случая ≈ 2,5 мс, но одновременно все пулы
// не наполняются никогда: дым и огонь исключают друг друга по месту, а небо
// живёт только ночью и только во время события.
// ---------------------------------------------------------------------------
export const FX_LIMITS = {
  puff: 240,    // дым, пар, пыль — мягкие пятна
  spark: 130,   // искры, угли, светляки праздника — аддитивные точки
  chip: 80,     // щепки и обломки — вращающиеся прямоугольники
  flame: 90,    // язычки пламени
  crop: 44,     // снопы
  meteor: 26,   // падающие звёзды
  star: 96,     // звёздное небо
  label: 26,    // всплывающие числа
  emitter: 24,  // одновременных источников-событий
};

// Базовые цвета мягких пятен. Каждое печётся в свой канвас 64×64 один раз за
// сессию (≈16 КБ на цвет) — «покрасить» drawImage на лету Canvas 2D не умеет,
// а ctx.filter на каждую частицу стоит дороже всего кадра.
const SOFT = {
  smokeLight: '222,218,208',
  smokeGrey: '150,146,138',
  smokeDark: '78,74,68',
  soot: '30,27,24',
  dust: '198,178,142',
  steam: '236,240,244',
  flame: '255,146,38',
  ember: '255,198,110',
  spark: '255,240,190',
  miasma: '150,190,120',
  gold: '255,214,120',
};

// Профили дымления. «Плотность от эпохи» здесь буквальная: очаг каменного века
// пускает редкие светлые клубы, фабричная труба — плотный тёмный столб.
// Единицы: rate — частиц в секунду, rise — тайлов в секунду, r0/r1 — радиус
// в долях тайла в начале и в конце жизни, life — секунды.
// ВАЖНО про соотношение rate и r1: столб дыма читается количеством, а не
// размером. Первая версия ставила три больших клуба в секунду — над трубой
// висело тёмное пятно, похожее на кляксу, а не на дым. Здесь частиц много,
// каждая полупрозрачная и растёт умеренно: перекрываясь, они и дают столб.
const SMOKE = {
  hearth: { rate: 5.0, rise: 0.42, r0: 0.10, r1: 0.38, life: 2.4, a: 0.30, col: 'smokeLight', wob: 0.30 },
  chimney: { rate: 6.0, rise: 0.46, r0: 0.11, r1: 0.45, life: 2.8, a: 0.34, col: 'smokeGrey', wob: 0.24 },
  forge: { rate: 6.5, rise: 0.48, r0: 0.12, r1: 0.50, life: 3.0, a: 0.36, col: 'smokeGrey', wob: 0.20 },
  stack: { rate: 9.5, rise: 0.60, r0: 0.16, r1: 0.72, life: 3.4, a: 0.42, col: 'smokeDark', wob: 0.14 },
  vapor: { rate: 8.0, rise: 0.62, r0: 0.17, r1: 0.78, life: 3.2, a: 0.26, col: 'steam', wob: 0.18 },
};

// Какой трубой дымит постройка. Пусто — не дымит вовсе.
// Жильё дымит всегда (там живут), производство — только когда на нём есть люди.
const SMOKE_OF = {
  campfire: 'hearth', story_fire: 'hearth', hunter_lodge: 'hearth', forager: 'hearth',
  hut: 'hearth', stone_house: 'chimney', clinic: 'chimney', temple: 'chimney',
  smithy: 'forge', armory: 'forge', foundry: 'forge', mine: 'chimney', quarry: 'chimney',
  guild_hall: 'chimney', press: 'chimney', market: 'hearth', port: 'hearth', shipyard: 'forge',
  mill: 'chimney', workshop: 'stack', factory: 'stack', power_plant: 'stack',
  train_station: 'stack', robo_factory: 'stack', npp: 'vapor', fusion_reactor: 'vapor',
  lab: 'vapor', biolab: 'vapor',
};

// Горн: искры и зарево. Числа — множитель к частоте искр.
const FORGE = { smithy: 1.0, armory: 0.7, foundry: 1.2, factory: 1.4, power_plant: 0.8, robo_factory: 1.5 };

// Куда вешать всплывающее число по ресурсу: первое найденное здание из списка.
// Если ни одного нет или все за краем экрана — число всплывёт по центру сверху,
// чтобы игрок его всё равно увидел.
const RES_ANCHOR = {
  food: ['granary', 'farm', 'pasture', 'forager', 'hunter_lodge', 'port'],
  wood: ['woodshed', 'lumber', 'depot'],
  stone: ['stoneyard', 'quarry', 'mine', 'depot'],
  steel: ['factory', 'robo_factory', 'foundry', 'depot'],
  gold: ['treasury', 'market', 'bank', 'stock_exchange', 'guild_hall'],
  knowledge: ['academy', 'university', 'lab', 'datacenter', 'observatory', 'press', 'story_fire'],
};

const RES_ICON = {};
for (const r of RES) RES_ICON[r.id] = r.icon;

// Визуал события. Ключ — id из EVENT_DEFS (плюс два внутренних события
// симуляции: 'tribute' и 'tribute_demand' собираются в коде, а не в таблице).
const EVENT_FX = {
  fire_event: 'fire',
  quake: 'collapse',
  harvest: 'harvest',
  boar_hunt: 'harvest',
  spring_flood: 'harvest',
  meteor_shower: 'meteor',
  star_night: 'stars',
  omen: 'stars',
  festival: 'festival',
  twins: 'festival',
  windfall: 'chips',
  stone_fall: 'collapse',
  clay_find: 'collapse',
  gold_vein: 'festival',
  plague_event: 'miasma',
  pandemic: 'miasma',
  npp_event: 'miasma',
  first_frost: 'vaporpuff',
  cold: 'vaporpuff',
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function makeRnd(seed) {
  let s = (seed | 0) || 0x6d2b79f5;
  return () => {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return (s >>> 0) / 4294967296;
  };
}

// --- пулы -------------------------------------------------------------------
function mkPool(cap, make) {
  const a = new Array(cap);
  for (let i = 0; i < cap; i++) a[i] = make();
  return { a, n: 0, cap };
}
function take(p) { return p.n < p.cap ? p.a[p.n++] : null; }
function drop(p, i) {           // обмен с хвостом: удаление за O(1), без мусора
  const t = p.a[i];
  p.a[i] = p.a[p.n - 1];
  p.a[p.n - 1] = t;
  p.n--;
}

// Общая запись частицы. Один вид на все пулы — так шаг физики пишется один раз,
// а не пять; лишние поля стоят байты, но не такты.
function mkParticle() {
  return { x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, r: 0, r1: 0, a: 0, g: 0, drag: 0, rot: 0, spin: 0, col: 'smokeGrey', colStr: '#8b6d42', wob: 0, ph: 0 };
}

// Мягкое пятно: печётся один раз на цвет и дальше только блитится.
const BLOBS = new Map();
function blob(colKey) {
  let cv = BLOBS.get(colKey);
  if (cv) return cv;
  const S = 64, rgb = SOFT[colKey] || SOFT.smokeGrey;
  cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, `rgba(${rgb},0.95)`);
  g.addColorStop(0.45, `rgba(${rgb},0.45)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  BLOBS.set(colKey, cv);
  return cv;
}

// Сноп: перевязанный пучок колосьев. Рисуется мелко (0.3 тайла), поэтому важен
// силуэт, а не детали.
let SHEAF = null;
function sheaf() {
  if (SHEAF) return SHEAF;
  const W = 24, H = 34;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.strokeStyle = '#e0b74e';
  c.lineWidth = 2.2;
  c.lineCap = 'round';
  for (let i = -3; i <= 3; i++) {
    c.beginPath();
    c.moveTo(W / 2 + i * 0.9, H - 3);
    c.lineTo(W / 2 + i * 3.0, 4 + Math.abs(i) * 1.6);
    c.stroke();
  }
  c.strokeStyle = '#a8792a';
  c.lineWidth = 3;
  c.beginPath(); c.moveTo(3, H * 0.62); c.lineTo(W - 3, H * 0.62); c.stroke();
  SHEAF = cv;
  return cv;
}

export class FxLayer {
  constructor(quality) {
    this.q = quality || { id: 'high', particles: 1, detail: 2 };
    this.off = this.q.id === 'eco';
    // Числа над зданиями стоят ~0,05 мс и несут смысл, а не красоту. По
    // умолчанию на «Экономии» выключено вместе со всем остальным (так требует
    // ТЗ), но флаг оставлен: клиент может вернуть их одной строкой.
    this.labelsOnEco = false;

    this.time = 0;
    this.night = 0;
    this.wind = -0.3;
    this.rnd = makeRnd(0x1f83d9ab);
    this.seeded = false;
    this.cw = 0; this.ch = 0;

    this.puffs = mkPool(FX_LIMITS.puff, mkParticle);
    this.sparks = mkPool(FX_LIMITS.spark, mkParticle);
    this.chips = mkPool(FX_LIMITS.chip, mkParticle);
    this.flames = mkPool(FX_LIMITS.flame, mkParticle);
    this.crops = mkPool(FX_LIMITS.crop, mkParticle);
    this.meteors = mkPool(FX_LIMITS.meteor, () => ({ x: 0, y: 0, vx: 0, vy: 0, len: 0, t: 0, life: 1, a: 0 }));
    this.stars = mkPool(FX_LIMITS.star, () => ({ x: 0, y: 0, r: 0, ph: 0, sp: 0, k: 1, big: false }));
    this.labels = mkPool(FX_LIMITS.label, () => ({ x: 0, y: 0, t: 0, life: 1, text: '', col: '#fff', rise: 0.7, big: false }));

    // Эмиттеры событий: у каждого ttl, после нуля источник снимается.
    this.em = [];
    // Зарево горнов: список собирается в update по видимым работающим кузницам
    // и очищается там же. Держать его между кадрами нельзя — снесённое здание
    // светилось бы вечно.
    this.forges = [];
    // Пер-строительное состояние рендера (накопители частоты, прошлый прогресс,
    // был ли дом жив). WeakMap: снесённое здание уходит из памяти само.
    this.bs = new WeakMap();
    // Курсоры наблюдателей.
    this.logMark = null;   // последняя обработанная запись журнала
    this.prevRes = null;   // прошлый снимок ресурсов
    this.resCd = {};       // антидребезг всплывающих чисел, по ресурсу
    this.numMin = 8;       // меньше этого числа не показываем — иначе рябь
    this._smokers = 0;     // сколько труб дымило в прошлом кадре
    this.starsOn = false;
    // Событие из этого набора не разыгрывается автоматически по журналу.
    // Нужно, если то же событие решили звать руками из hud.js — иначе оно
    // сыграет дважды.
    this.muted = new Set();

    // ru-название события → определение. Нужно, чтобы ловить события по
    // журналу и не просить симуляцию завести для рендера новое поле.
    this.byRu = new Map();
    for (const e of EVENT_DEFS) this.byRu.set(e.ru, e);
  }

  setQuality(q) {
    this.q = q;
    this.off = q.id === 'eco';
    if (this.off) this.clear();
  }

  // Полная очистка: и частицы, и эмиттеры. Вызывать при загрузке сейва и при
  // новой игре — иначе дым старого города повиснет над новым.
  clear() {
    for (const p of [this.puffs, this.sparks, this.chips, this.flames, this.crops, this.meteors, this.stars, this.labels]) p.n = 0;
    this.em.length = 0;
    this.starsOn = false;
    this.prevRes = null;
    this.logMark = null;
  }

  // Снять все источники событий, оставив уже живущие частицы догорать.
  clearEvents() { this.em.length = 0; this.starsOn = false; }

  stats() {
    return {
      puff: this.puffs.n, spark: this.sparks.n, chip: this.chips.n, flame: this.flames.n,
      crop: this.crops.n, meteor: this.meteors.n, star: this.stars.n, label: this.labels.n,
      emitters: this.em.length,
    };
  }

  // =========================================================================
  // ПУБЛИЧНЫЙ API СОБЫТИЙ. Всё это можно звать из hud.js/main.js напрямую,
  // если понадобится привязка точнее автоматической.
  // =========================================================================

  // Пожар над зданием: язычки пламени, чёрный дым, угли. sec — сколько горит.
  fire(x, y, size = 1, sec = 9) {
    // Больше трёх пожаров разом — это уже не событие, а пожар кадра: землетрясение
    // сносит по два-три здания, и каждое просило бы свой столб огня. Самый старый
    // очаг уступает место новому.
    const fires = this.em.filter(e => e.kind === 'fire');
    if (fires.length >= 3) {
      const i = this.em.indexOf(fires[0]);
      if (i >= 0) this.em.splice(i, 1);
    }
    return this._emit('fire', x, y, sec, { size });
  }

  // Потушили: пламя гаснет за секунду, вместо дыма идёт белый пар.
  extinguish(x, y, r = 3) {
    for (let i = this.em.length - 1; i >= 0; i--) {
      const e = this.em[i];
      if (e.kind !== 'fire') continue;
      if (x != null && Math.abs(e.x - x) + Math.abs(e.y - y) > r) continue;
      this.em.splice(i, 1);
      this._emit('steam', e.x, e.y, 2.2, { size: e.d.size });
    }
  }

  // Всплеск урожая: снопы летят над фермами. Берёт первые шесть — больше
  // и не нужно: снопы над всем городом читаются как мусор в кадре.
  harvest(sim, sec = 3.2) {
    const farms = (sim.buildings || []).filter(b => b.done && !b.destroyed && (b.id === 'farm' || b.id === 'pasture' || b.id === 'forager'));
    if (!farms.length) return 0;
    let n = 0;
    for (const b of farms) {
      if (n >= 6) break;
      this._emit('harvest', b.x + (b.size || 1) / 2, b.y + (b.size || 1) / 2, sec, { size: b.size || 1 });
      n++;
    }
    return n;
  }

  // Метеорный дождь: 2,2 звезды в секунду — плотнее читается как ливень,
  // реже — как случайная искра. Живёт только ночью (см. _tickMeteor).
  meteorShower(sec = 22) { return this._emit('meteor', 0, 0, sec, { rate: 2.2 }); }

  starNight(sec = 26) {
    const e = this._emit('stars', 0, 0, sec, {});
    if (e) this._seedStars();
    return e;
  }

  // Пыль и обломки: обвал, землетрясение, попадание тарана.
  collapse(x, y, size = 1) {
    this._burstPuff(x, y, size, 10, 'dust', 0.55);
    this._burstChips(x, y, size, 8, '#8b6d42');
    return true;
  }

  // Праздничные искры над зданием (праздник, золотая жила, рождение).
  festival(x, y, sec = 4) { return this._emit('festival', x, y, sec, {}); }

  // Всплывающее число: text рисуется как есть, вместе с иконкой.
  // kind: 'good' | 'bad' | 'info'.
  number(x, y, text, kind = 'info', big = false) {
    if (this.off && !this.labelsOnEco) return false;
    const l = take(this.labels);
    if (!l) return false;
    l.x = x; l.y = y; l.t = 0; l.life = big ? 2.4 : 1.8;
    l.text = String(text);
    l.col = kind === 'good' ? '#a6f0a6' : kind === 'bad' ? '#ff9d8d' : '#ffe3a3';
    l.rise = big ? 1.1 : 0.75;
    l.big = big;
    return true;
  }

  // Число над складом нужного ресурса: +12🍞 над амбаром, −30🪙 при уплате дани.
  resNumber(sim, resId, delta) {
    const v = Math.round(delta);
    if (!v) return false;
    // Один ресурс — одно число за раз. Иначе событие показало бы «+55🍞» из
    // своего описания, а следом наблюдатель ресурсов — то же «+55🍞» по факту
    // начисления, и числа налезли бы друг на друга.
    if ((this.resCd[resId] || 0) > 0) return false;
    this.resCd[resId] = 0.8;
    const p = this._anchor(sim, resId);
    const sign = v > 0 ? '+' : '−';       // U+2212, а не дефис: минус ровнее
    return this.number(p.x, p.y, `${sign}${Math.abs(v)}${RES_ICON[resId] || ''}`, v > 0 ? 'good' : 'bad', Math.abs(v) >= 60);
  }

  // Разыграть визуал события по его определению из EVENT_DEFS (или по id).
  // Вызывается автоматически из update() по журналу, но доступно и снаружи.
  event(defOrId, sim) {
    const def = typeof defOrId === 'string' ? EVENT_DEFS.find(e => e.id === defOrId) : defOrId;
    if (!def || !sim) return false;
    const kind = EVENT_FX[def.id] || (def.visual === 'meteor' ? 'meteor' : null);
    switch (kind) {
      case 'fire': {
        const b = this._pickBuilding(sim, x => x.id !== 'campfire');
        if (b) this.fire(b.x + (b.size || 1) / 2, b.y + (b.size || 1) / 2, b.size || 1, 10);
        break;
      }
      case 'collapse': {
        for (let i = 0; i < 3; i++) {
          const b = this._pickBuilding(sim);
          if (b) this.collapse(b.x + (b.size || 1) / 2, b.y + (b.size || 1) * 0.85, b.size || 1);
        }
        break;
      }
      case 'harvest': this.harvest(sim); break;
      case 'meteor': this.meteorShower(); break;
      case 'stars': this.starNight(); break;
      case 'festival': {
        const b = this._pickBuilding(sim, x => x.id === 'campfire' || x.id === 'amphitheater' || x.id === 'temple') || this._pickBuilding(sim);
        if (b) this.festival(b.x + (b.size || 1) / 2, b.y + (b.size || 1) * 0.4);
        break;
      }
      case 'chips': {
        const b = this._pickBuilding(sim, x => x.id === 'lumber') || this._pickBuilding(sim);
        if (b) this._burstChips(b.x + 0.5, b.y + 0.7, b.size || 1, 12, '#7a5b34');
        break;
      }
      case 'miasma': {
        for (let i = 0; i < 3; i++) {
          const b = this._pickBuilding(sim, x => (BUILDINGS[x.id] || {}).housing > 0);
          if (b) this._emit('miasma', b.x + (b.size || 1) / 2, b.y + (b.size || 1) * 0.3, 12, { size: b.size || 1 });
        }
        break;
      }
      case 'vaporpuff': {
        for (let i = 0; i < 4; i++) {
          const b = this._pickBuilding(sim);
          if (b) this._burstPuff(b.x + 0.5, b.y + 0.4, b.size || 1, 4, 'steam', 0.30);
        }
        break;
      }
      default: break;
    }
    // Числа по эффекту события: одно на ресурс, над его складом.
    const eff = def.effect || {};
    for (const r of RES) {
      if (eff[r.id]) this.resNumber(sim, r.id, eff[r.id]);
      const pct = eff[r.id + 'Pct'];
      if (pct) {
        const p = this._anchor(sim, r.id);
        const s = Math.round(pct * 100);
        this.number(p.x, p.y, `${s > 0 ? '+' : '−'}${Math.abs(s)}%${r.icon}`, s > 0 ? 'good' : 'bad');
      }
    }
    if (eff.happy) {
      const p = this._anchor(sim, 'happy');
      this.number(p.x, p.y, `${eff.happy > 0 ? '+' : '−'}${Math.abs(eff.happy)}\u{1F642}`, eff.happy > 0 ? 'good' : 'bad');
    }
    return true;
  }

  // =========================================================================
  // ОБНОВЛЕНИЕ. Один вызов за кадр, до отрисовок.
  // =========================================================================
  update(sim, dt, ox, oy, z, cw, ch) {
    if (!sim) return;
    if (!this.seeded) { this.rnd = makeRnd(((sim.world && sim.world.seed) | 0) || 20250808); this.seeded = true; }
    dt = Math.min(0.05, Math.max(0, dt || 0));   // вкладку сворачивали — не телепортируем дым
    this.time += dt;
    this.cw = cw; this.ch = ch;
    this.night = lightAt(sim.dayTime).glow;

    // Ветер тот же, что у осадков в weather.js: одна формула на день и сезон,
    // поэтому дым из трубы сносит туда же, куда и дождь. Связи между модулями
    // при этом нет — только общая функция hash2.
    const wTarget = -0.72 + hash2(sim.day | 0, sim.seasonIdx | 0) * 1.16;
    this.wind += (wTarget - this.wind) * Math.min(1, dt * 0.6);

    // Наблюдатели работают ВСЕГДА, даже на «Экономии»: их дело — заметить
    // событие, а рисовать ли его, решает уже спавн.
    this._watchLog(sim);
    this._watchBuildings(sim, dt, ox, oy, z, cw, ch);
    this._watchRes(sim, dt);

    if (this.off) { this.em.length = 0; return; }

    this._stepEmitters(sim, dt);
    this._stepPool(this.puffs, dt);
    this._stepPool(this.sparks, dt);
    this._stepPool(this.chips, dt);
    this._stepPool(this.flames, dt);
    this._stepPool(this.crops, dt);
    this._stepMeteors(dt);
    this._stepLabels(dt);
  }

  // --- шаг физики: общий для всех «мировых» пулов --------------------------
  _stepPool(p, dt) {
    for (let i = p.n - 1; i >= 0; i--) {
      const q = p.a[i];
      q.t += dt;
      if (q.t >= q.life) { drop(p, i); continue; }
      q.vy += q.g * dt;
      if (q.drag) {
        const k = 1 - Math.min(0.9, q.drag * dt);
        q.vx *= k; q.vy *= k;
      }
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.rot += q.spin * dt;
      if (q.wob) q.x += Math.sin(q.ph + q.t * 1.7) * q.wob * dt;
    }
  }

  _stepMeteors(dt) {
    const p = this.meteors;
    for (let i = p.n - 1; i >= 0; i--) {
      const m = p.a[i];
      m.t += dt;
      if (m.t >= m.life) { drop(p, i); continue; }
      m.x += m.vx * dt;
      m.y += m.vy * dt;
    }
  }

  _stepLabels(dt) {
    const p = this.labels;
    for (let i = p.n - 1; i >= 0; i--) {
      const l = p.a[i];
      l.t += dt;
      if (l.t >= l.life) drop(p, i);
    }
  }

  // --- эмиттеры ------------------------------------------------------------
  _emit(kind, x, y, ttl, data) {
    if (this.off) return null;
    if (this.em.length >= FX_LIMITS.emitter) this.em.shift();   // старейший уступает место
    const e = { kind, x, y, ttl, life: ttl, acc: 0, acc2: 0, ph: this.rnd() * 6.28, d: data || {} };
    this.em.push(e);
    return e;
  }

  _stepEmitters(sim, dt) {
    const dens = this._density();
    for (let i = this.em.length - 1; i >= 0; i--) {
      const e = this.em[i];
      e.ttl -= dt;
      if (e.ttl <= 0) {
        // Источник снят ровно в момент конца события. Уже живущие частицы
        // догорают сами — новых не будет.
        // Звёздное поле — не частицы, а свита эмиттера: гаснет вместе с ним,
        // иначе небо осталось бы усыпанным звёздами до конца партии.
        if (e.kind === 'stars') { this.starsOn = false; this.stars.n = 0; }
        this.em.splice(i, 1);
        continue;
      }
      const k = clamp01(e.ttl / Math.max(0.001, e.life));
      switch (e.kind) {
        case 'fire': this._tickFire(e, dt, dens); break;
        case 'steam': this._tickSteam(e, dt, dens, k); break;
        case 'harvest': this._tickHarvest(e, dt, dens); break;
        case 'meteor': this._tickMeteor(e, dt, dens); break;
        case 'festival': this._tickFestival(e, dt, dens); break;
        case 'miasma': this._tickMiasma(e, dt, dens); break;
        case 'stars': break;   // звёзды статичны, живут пока жив эмиттер
        default: break;
      }
    }
  }

  _tickFire(e, dt, dens) {
    const s = e.d.size || 1;
    // Пламя
    e.acc += 32 * dens * dt;
    while (e.acc >= 1) {
      e.acc--;
      const f = take(this.flames);
      if (!f) break;
      const r = this.rnd();
      f.x = e.x + (this.rnd() - 0.5) * s * 0.7;
      f.y = e.y + (this.rnd() - 0.5) * s * 0.2;
      f.vx = (this.rnd() - 0.5) * 0.25;
      f.vy = -0.9 - r * 0.8;
      f.t = 0; f.life = 0.5 + r * 0.4;
      f.r = s * (0.24 + r * 0.2); f.r1 = s * 0.05;
      f.a = 0.95; f.g = 0; f.drag = 0.6; f.wob = 0.5; f.ph = this.rnd() * 6.28;
      f.col = r > 0.6 ? 'ember' : 'flame';
    }
    // Чёрный дым и угли
    e.acc2 += 26 * dens * dt;
    while (e.acc2 >= 1) {
      e.acc2--;
      if (this.rnd() < 0.78) {
        const q = take(this.puffs);
        if (!q) break;
        this._initPuff(q, e.x + (this.rnd() - 0.5) * s * 0.5, e.y - s * 0.35, {
          rise: 0.8, r0: s * 0.12, r1: s * 0.8, life: 3.4, a: 0.34, col: 'soot', wob: 0.22,
        });
      } else {
        const q = take(this.sparks);
        if (!q) break;
        q.x = e.x + (this.rnd() - 0.5) * s * 0.5;
        q.y = e.y - s * 0.2;
        q.vx = this.wind * 0.5 + (this.rnd() - 0.5) * 0.5;
        q.vy = -1.1 - this.rnd() * 0.9;
        q.t = 0; q.life = 0.9 + this.rnd() * 0.7;
        q.r = 0.035; q.r1 = 0.008; q.a = 0.95; q.g = 0.5; q.drag = 0.4;
        q.col = 'ember'; q.wob = 0.6; q.ph = this.rnd() * 6.28;
      }
    }
  }

  _tickSteam(e, dt, dens, k) {
    e.acc += 12 * dens * dt * k;
    while (e.acc >= 1) {
      e.acc--;
      const q = take(this.puffs);
      if (!q) break;
      this._initPuff(q, e.x + (this.rnd() - 0.5) * 0.6, e.y - 0.2, {
        rise: 0.8, r0: 0.14, r1: 0.9, life: 2.0, a: 0.4, col: 'steam', wob: 0.3,
      });
    }
  }

  _tickHarvest(e, dt, dens) {
    e.acc += 7 * dens * dt;
    while (e.acc >= 1) {
      e.acc--;
      const q = take(this.crops);
      if (!q) break;
      const s = e.d.size || 1;
      q.x = e.x + (this.rnd() - 0.5) * s * 0.9;
      q.y = e.y + (this.rnd() - 0.5) * s * 0.4;
      q.vx = (this.rnd() - 0.5) * 1.1;
      q.vy = -1.7 - this.rnd() * 0.7;   // подбрасывают вверх, дальше парабола
      q.t = 0; q.life = 1.5 + this.rnd() * 0.4;
      q.r = 0.22 + this.rnd() * 0.08; q.r1 = q.r;
      q.a = 1; q.g = 3.1; q.drag = 0;
      q.rot = this.rnd() * 6.28; q.spin = (this.rnd() - 0.5) * 7;
      q.col = 'gold';
    }
  }

  _tickMeteor(e, dt, dens) {
    if (this.night < 0.18) return;                 // днём падающих звёзд не видно
    if (!this.cw) return;
    e.acc += (e.d.rate || 2.2) * dt * clamp(dens, 0.4, 1);
    while (e.acc >= 1) {
      e.acc--;
      const m = take(this.meteors);
      if (!m) break;
      const dir = this.rnd() < 0.5 ? 1 : -1;
      m.x = this.cw * (0.1 + this.rnd() * 0.8) - dir * this.cw * 0.15;
      m.y = -20 + this.rnd() * this.ch * 0.30;
      // Скорость подобрана так, чтобы след успевал прочитаться глазом: при
      // 1000 px/с звезда пересекала кадр за треть секунды и на скриншоте её
      // не было вовсе.
      const sp = 300 + this.rnd() * 340;
      m.vx = dir * sp * 0.85;
      m.vy = sp * 0.42;
      m.len = 70 + this.rnd() * 130;
      m.t = 0; m.life = 0.9 + this.rnd() * 0.8;
      m.a = 0.7 + this.rnd() * 0.3;
    }
  }

  _tickFestival(e, dt, dens) {
    e.acc += 16 * dens * dt;
    while (e.acc >= 1) {
      e.acc--;
      const q = take(this.sparks);
      if (!q) break;
      const ang = this.rnd() * 6.28;
      q.x = e.x + Math.cos(ang) * 0.3;
      q.y = e.y + Math.sin(ang) * 0.18;
      q.vx = Math.cos(ang) * 0.5;
      q.vy = -0.9 - this.rnd() * 0.8;
      q.t = 0; q.life = 1.1 + this.rnd() * 0.6;
      q.r = 0.045; q.r1 = 0.01; q.a = 1; q.g = 0.9; q.drag = 0.5;
      q.col = this.rnd() < 0.5 ? 'spark' : 'gold';
      q.wob = 0.8; q.ph = this.rnd() * 6.28;
    }
  }

  _tickMiasma(e, dt, dens) {
    e.acc += 2.2 * dens * dt;
    while (e.acc >= 1) {
      e.acc--;
      const q = take(this.puffs);
      if (!q) break;
      this._initPuff(q, e.x + (this.rnd() - 0.5) * 0.8, e.y, {
        rise: 0.12, r0: 0.2, r1: 0.75, life: 4.5, a: 0.22, col: 'miasma', wob: 0.35,
      });
    }
  }

  // =========================================================================
  // НАБЛЮДАТЕЛИ. Симуляция ничего не знает про рендер, поэтому события ловятся
  // по её собственным следам: журналу, состоянию зданий и ресурсам.
  // =========================================================================

  // Журнал: строки вида «Событие: <название> — <текст>».
  _watchLog(sim) {
    const log = sim.log;
    if (!Array.isArray(log) || !log.length) return;
    let from = 0;
    if (this.logMark) {
      const i = log.lastIndexOf(this.logMark);
      // Записи не нашлось — журнал подрезали (он живёт на 120 строк) или
      // загрузили сейв. Берём только хвост, чтобы не разыграть сотню событий
      // разом и не устроить фейерверк на ровном месте.
      from = i >= 0 ? i + 1 : Math.max(0, log.length - 3);
    } else {
      from = log.length;                        // первый кадр: прошлое не переигрываем
    }
    for (let i = from; i < log.length; i++) {
      const text = log[i] && log[i].text;
      if (typeof text === 'string') this._fromLogLine(text, sim);
    }
    this.logMark = log[log.length - 1];
  }

  _fromLogLine(text, sim) {
    const ev = text.indexOf('Событие: ');
    if (ev >= 0) {
      const tail = text.slice(ev + 9);
      const dash = tail.indexOf(' — ');
      const ru = (dash > 0 ? tail.slice(0, dash) : tail).trim();
      const def = this.byRu.get(ru);
      if (def) { if (!this.muted.has(def.id)) this.event(def, sim); return; }
    }
    // Решения по событию с выбором: тушим пожар — гасим пламя.
    if (text.startsWith('Решение по событию')) {
      if (text.includes('Тушить')) this.extinguish(null, null, 1e9);
      return;
    }
    // Дань: соседи платят нам — золото прилетает, требование оплачено нами —
    // золото уходит (это ловит уже наблюдатель ресурсов).
    const m = text.match(/дань\s+(\d+)\s*\u{1FA99}/u);
    if (m && text.includes('выплачивает')) this.resNumber(sim, 'gold', +m[1]);
  }

  // Здания: стройка, завершение, повреждение, снос.
  _watchBuildings(sim, dt, ox, oy, z, cw, ch) {
    this.forges.length = 0;
    const list = sim.buildings;
    if (!Array.isArray(list)) return;
    // Дым большого города съедает кадр не сложностью, а количеством: 16
    // работающих труб эпохи 8 держали 220 клубов и 1,5 мс на программной
    // растеризации. Поэтому чем больше труб в кадре, тем реже дымит каждая:
    // деревня в десять дворов дымит в полную силу, мегаполис — вдвое реже, а
    // суммарная плотность держится примерно постоянной. Счётчик берём с
    // прошлого кадра — за один кадр город не удваивается.
    const crowd = clamp(10 / Math.max(1, this._smokers || 1), 0.4, 1);
    const dens = this._density();
    const workSmoke = dens > 0 && !this.off;
    let smokers = 0;
    for (const b of list) {
      let st = this.bs.get(b);
      if (!st) { st = { acc: 0, acc2: 0, prog: b.progress || 0, done: !!b.done, alive: !b.destroyed, ph: hash2(b.x | 0, b.y | 0) * 6.28 }; this.bs.set(b, st); }

      // --- снос: над пепелищем встаёт пожар ---
      if (st.alive && b.destroyed) {
        st.alive = false;
        const s = b.size || 1;
        this.fire(b.x + s / 2, b.y + s * 0.55, s, 7);
        this.collapse(b.x + s / 2, b.y + s * 0.8, s);
      } else if (!st.alive && !b.destroyed) {
        st.alive = true;   // отстроили заново
      }

      // --- достроили: облако пыли и хлопок ---
      if (!st.done && b.done) {
        st.done = true;
        const s = b.size || 1;
        this._burstPuff(b.x + s / 2, b.y + s * 0.85, s, 9, 'dust', 0.5);
        this._burstChips(b.x + s / 2, b.y + s * 0.8, s, 5, '#8b6d42');
      }
      if (st.done && !b.done) st.done = false;

      if (!workSmoke || b.destroyed) { st.prog = b.progress || 0; continue; }

      // Экранное отсечение: за краем кадра ничего не порождаем.
      const s = b.size || 1;
      const sx = ox + b.x * z, sy = oy + b.y * z;
      if (sx < -140 || sy < -220 || sx > cw + 140 || sy > ch + 140) { st.prog = b.progress || 0; continue; }

      if (!b.done) {
        // --- пыль стройки: только пока работа реально идёт ---
        const d = (b.progress || 0) - st.prog;
        st.prog = b.progress || 0;
        if (d > 0) {
          st.acc += 5.5 * dens * dt;
          while (st.acc >= 1) {
            st.acc--;
            const q = take(this.puffs);
            if (q) {
              this._initPuff(q, b.x + this.rnd() * s, b.y + s * (0.6 + this.rnd() * 0.35), {
                rise: 0.16, r0: 0.06, r1: 0.30, life: 1.4, a: 0.32, col: 'dust', wob: 0.2,
              });
            }
          }
          if ((this.q.detail || 0) >= 1) {
            st.acc2 += 1.7 * dens * dt;
            while (st.acc2 >= 1) { st.acc2--; this._burstChips(b.x + s / 2, b.y + s * 0.55, s, 1, '#8b6d42'); }
          }
        }
        continue;
      }

      const def = BUILDINGS[b.id] || {};
      const top = this._roofY(b);   // мировая Y конька/трубы

      // --- тление повреждённого здания: не эмиттер, а состояние ---
      const maxHp = def.wall || 100;
      if (b.hp != null && b.hp < maxHp * 0.6) {
        const k = 1 - clamp01(b.hp / (maxHp * 0.6));
        st.acc += (3 + 7 * k) * dens * dt;
        while (st.acc >= 1) {
          st.acc--;
          if (this.rnd() < 0.45) {
            const f = take(this.flames);
            if (f) {
              f.x = b.x + s * (0.25 + this.rnd() * 0.5);
              f.y = top + s * 0.15;
              f.vx = 0; f.vy = -0.7 - this.rnd() * 0.4;
              f.t = 0; f.life = 0.4 + this.rnd() * 0.25;
              f.r = s * 0.09; f.r1 = s * 0.02; f.a = 0.8 * (0.4 + k);
              f.g = 0; f.drag = 0.5; f.wob = 0.5; f.ph = this.rnd() * 6.28; f.col = 'flame';
            }
          } else {
            const q = take(this.puffs);
            if (q) {
              this._initPuff(q, b.x + s * (0.2 + this.rnd() * 0.6), top, {
                rise: 0.55, r0: s * 0.1, r1: s * 0.7, life: 3.0, a: 0.4 * (0.4 + k), col: 'soot', wob: 0.25,
              });
            }
          }
        }
        continue;   // горящему зданию не до трубы
      }

      // --- дым из трубы ---
      const skind = SMOKE_OF[b.id];
      if (skind) {
        const busy = def.housing ? true : (b.workers && b.workers.length > 0);
        if (busy) {
          const pr = SMOKE[skind];
          // Эпоха постройки тянется к текущей ровно так же, как в renderer:
          // не более трёх ступеней. Дым не должен обгонять вид здания.
          const own = BUILDING_ERA_IDX[b.id] || 0;
          const era = Math.max(own, Math.min(9, Math.min(sim.eraIndex || 0, own + 3)));
          const eraK = skind === 'stack' ? 1 : 0.75 + era * 0.055;         // очаг → труба
          const season = sim.seasonIdx === 3 ? 1.35 : sim.seasonIdx === 1 ? 0.72 : 1;
          const seasonK = def.housing ? season : 1;
          smokers++;
          st.acc += pr.rate * eraK * seasonK * dens * crowd * dt;
          while (st.acc >= 1) {
            st.acc--;
            const q = take(this.puffs);
            if (!q) break;
            this._initPuff(q, b.x + s * (0.42 + Math.sin(st.ph) * 0.16), top, {
              rise: pr.rise, r0: pr.r0 * s, r1: pr.r1 * s, life: pr.life, a: pr.a, col: pr.col, wob: pr.wob,
            });
          }
        }
      }

      // --- горн: искры и зарево ---
      const fk = FORGE[b.id];
      if (fk && b.workers && b.workers.length > 0) {
        // Зарево живёт ровно один кадр: список форгов пересобирается каждый раз.
        this.forges.push({ x: b.x + s * 0.5, y: b.y + s * 0.6, s, k: fk, ph: st.ph });
      }
      if (fk && (this.q.detail || 0) >= 1 && b.workers && b.workers.length > 0) {
        st.acc2 += 6 * fk * dens * dt;
        while (st.acc2 >= 1) {
          st.acc2--;
          const q = take(this.sparks);
          if (!q) break;
          q.x = b.x + s * 0.5 + (this.rnd() - 0.5) * s * 0.3;
          q.y = b.y + s * 0.62;
          const ang = -1.6 + (this.rnd() - 0.5) * 1.5;
          const sp = 0.7 + this.rnd() * 1.1;
          q.vx = Math.cos(ang) * sp; q.vy = Math.sin(ang) * sp;
          q.t = 0; q.life = 0.35 + this.rnd() * 0.3;
          q.r = 0.045; q.r1 = 0.008; q.a = 1; q.g = 3.4; q.drag = 0.2;
          q.col = 'spark'; q.wob = 0; q.ph = 0;
        }
      }
    }
    this._smokers = smokers;
  }

  // Ресурсы: скачок больше порога — это событие, а не производство.
  // Так и уплата дани (−30🪙), и находка золотой жилы, и цена постройки
  // получают своё число над нужным складом, а рендер при этом не лезет
  // ни в один чужой файл.
  _watchRes(sim, dt) {
    const res = sim.res;
    if (!res) return;
    if (!this.prevRes) { this.prevRes = { ...res }; return; }
    // На ускорении дней в секунду больше — иначе числа сливаются в кашу.
    const cd = 0.7 * Math.max(1, Math.min(4, sim.speed || 1));
    for (const r of RES) {
      const prev = this.prevRes[r.id] || 0;
      const now = res[r.id] || 0;
      const d = now - prev;
      this.prevRes[r.id] = now;
      const t = (this.resCd[r.id] || 0) - dt;
      this.resCd[r.id] = Math.max(0, t);
      if (Math.abs(d) < this.numMin || t > 0) continue;
      this.resCd[r.id] = cd;
      this.resNumber(sim, r.id, d);
    }
  }

  // =========================================================================
  // ОТРИСОВКА. Три входа: мир (частицы), небо (метеоры и звёзды) и числа.
  // =========================================================================

  // Частицы в мировых координатах. Ставить после зданий и жителей.
  drawWorld(ctx, ox, oy, z, cw, ch) {
    if (this.off) return;
    // На дальнем зуме мелочь превращается в грязь на экране и стоит столько же,
    // сколько на близком: ниже 0,45 зума оставляем только огонь.
    const far = z < 14;

    if (!far && this.puffs.n) {
      ctx.save();
      for (let i = 0; i < this.puffs.n; i++) {
        const q = this.puffs.a[i];
        const k = q.t / q.life;
        const sx = ox + q.x * z, sy = oy + q.y * z;
        // Рост по корню: клуб раздаётся сразу у трубы и дальше расширяется
        // медленно. При линейном росте первая треть пути была почти невидимой,
        // и столб выглядел оторванным от трубы — дым начинался в воздухе.
        const r = (q.r + (q.r1 - q.r) * Math.sqrt(k)) * z;
        if (sx + r < 0 || sy + r < 0 || sx - r > cw || sy - r > ch) continue;
        // Плотность набирается за первые 6% жизни (иначе частица «мигает» при
        // рождении) и тает к концу в степени 1,5: при квадрате столб пропадал
        // на первой трети и над трубой висел короткий пшик.
        const f = 1 - k;
        const a = q.a * Math.min(1, k / 0.06) * f * Math.sqrt(f);
        if (a <= 0.004) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(blob(q.col), sx - r, sy - r, r * 2, r * 2);
      }
      ctx.restore();
    }

    // Зарево горна. Днём это тёплое пятно в проёме, ночью — фонарь на полквартала.
    // Пульс медленный и неровный: горн раздувают мехами, а не мигают лампочкой.
    if (this.forges.length && !far) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const f of this.forges) {
        const sx = ox + f.x * z, sy = oy + f.y * z;
        const r = f.s * z * (0.30 + 0.05 * Math.sin(this.time * 2.1 + f.ph));
        if (sx + r < 0 || sy + r < 0 || sx - r > cw || sy - r > ch) continue;
        const pulse = 0.55 + 0.45 * Math.sin(this.time * 3.3 + f.ph * 2);
        ctx.globalAlpha = (0.16 + 0.30 * this.night) * pulse * Math.min(1.4, f.k);
        ctx.drawImage(blob('flame'), sx - r, sy - r, r * 2, r * 2);
      }
      ctx.restore();
    }

    if (this.flames.n) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < this.flames.n; i++) {
        const q = this.flames.a[i];
        const k = q.t / q.life;
        const sx = ox + q.x * z, sy = oy + q.y * z;
        const r = (q.r + (q.r1 - q.r) * k) * z;
        if (sx + r < 0 || sy + r < 0 || sx - r > cw || sy - r > ch) continue;
        const a = q.a * (1 - k * k);
        // Язычок вытянут вверх: сплюснутое по X пятно читается как пламя,
        // круглое — как фонарик.
        ctx.globalAlpha = a;
        ctx.drawImage(blob(q.col), sx - r * 0.8, sy - r * 1.7, r * 1.6, r * 2.4);
        // Ядро язычка. Без него аддитивное пятно остаётся мутно-оранжевым и
        // издалека читается фонарём, а не огнём: у огня всегда есть добела
        // раскалённая сердцевина.
        ctx.globalAlpha = a * 0.9;
        ctx.drawImage(blob('spark'), sx - r * 0.34, sy - r * 0.9, r * 0.68, r * 1.2);
      }
      ctx.restore();
    }

    if (!far && this.sparks.n) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < this.sparks.n; i++) {
        const q = this.sparks.a[i];
        const k = q.t / q.life;
        const sx = ox + q.x * z, sy = oy + q.y * z;
        const r = Math.max(0.7, (q.r + (q.r1 - q.r) * k) * z);
        if (sx < -r || sy < -r || sx > cw + r || sy > ch + r) continue;
        ctx.globalAlpha = q.a * (1 - k);
        ctx.drawImage(blob(q.col), sx - r * 2, sy - r * 2, r * 4, r * 4);
      }
      ctx.restore();
    }

    if (!far && this.chips.n) {
      ctx.save();
      for (let i = 0; i < this.chips.n; i++) {
        const q = this.chips.a[i];
        const k = q.t / q.life;
        const sx = ox + q.x * z, sy = oy + q.y * z;
        if (sx < -20 || sy < -20 || sx > cw + 20 || sy > ch + 20) continue;
        const w = Math.max(1, q.r * z), h = Math.max(1, q.r1 * z);
        ctx.globalAlpha = 1 - k * k;
        ctx.fillStyle = q.colStr || '#8b6d42';
        // Поворот отменяем обратными операциями, а не save/restore на каждую
        // щепку: пара save/restore стоит дороже самой отрисовки прямоугольника.
        ctx.translate(sx, sy);
        ctx.rotate(q.rot);
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.rotate(-q.rot);
        ctx.translate(-sx, -sy);
      }
      ctx.restore();
    }

    if (!far && this.crops.n) {
      const sp = sheaf();
      ctx.save();
      for (let i = 0; i < this.crops.n; i++) {
        const q = this.crops.a[i];
        const k = q.t / q.life;
        const sx = ox + q.x * z, sy = oy + q.y * z;
        if (sx < -40 || sy < -40 || sx > cw + 40 || sy > ch + 40) continue;
        const w = q.r * z, h = w * (sp.height / sp.width);
        ctx.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1;
        ctx.translate(sx, sy);
        ctx.rotate(q.rot);
        ctx.drawImage(sp, -w / 2, -h / 2, w, h);
        ctx.rotate(-q.rot);
        ctx.translate(-sx, -sy);
      }
      ctx.restore();
    }
  }

  // Небо: метеоры и звёздная ночь. Экранные координаты, ставить после лучей.
  drawSky(ctx, cw, ch) {
    if (this.off) return;
    if (this.night < 0.12) return;
    this.cw = cw; this.ch = ch;

    if (this.starsOn && this.stars.n) {
      const em = this.em.find(e => e.kind === 'stars');
      const fade = em ? Math.min(1, Math.min(em.ttl, em.life - em.ttl) / 1.5) : 0;
      if (fade > 0.01) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = 'rgba(210,232,255,0.9)';
        ctx.lineWidth = 1;
        for (let i = 0; i < this.stars.n; i++) {
          const s = this.stars.a[i];
          const tw = 0.55 + 0.45 * Math.sin(this.time * s.sp + s.ph);
          const a = 0.95 * tw * fade * this.night * s.k;
          if (a <= 0.02) continue;
          ctx.globalAlpha = a;
          const x = s.x * cw, y = s.y * ch, r = s.r * 3.2;
          ctx.drawImage(blob('spark'), x - r, y - r, r * 2, r * 2);
          // Лучи у крупных звёзд: без них россыпь точек не отличить от
          // светляков, которых рендер и так гоняет над травой.
          if (s.big) {
            const l = r * 2.2;
            ctx.globalAlpha = a * 0.5;
            ctx.beginPath();
            ctx.moveTo(x - l, y); ctx.lineTo(x + l, y);
            ctx.moveTo(x, y - l); ctx.lineTo(x, y + l);
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }

    if (this.meteors.n) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (let i = 0; i < this.meteors.n; i++) {
        const m = this.meteors.a[i];
        const k = m.t / m.life;
        const a = m.a * this.night * (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85);
        if (a <= 0.02) continue;
        const d = Math.hypot(m.vx, m.vy) || 1;
        const tx = m.x - (m.vx / d) * m.len, ty = m.y - (m.vy / d) * m.len;
        const g = ctx.createLinearGradient(m.x, m.y, tx, ty);
        g.addColorStop(0, `rgba(255,250,235,${a})`);
        g.addColorStop(0.35, `rgba(190,215,255,${a * 0.5})`);
        g.addColorStop(1, 'rgba(150,190,255,0)');
        ctx.strokeStyle = g;
        ctx.lineWidth = 3.2;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(m.x, m.y); ctx.stroke();
        ctx.globalAlpha = a;
        ctx.drawImage(blob('spark'), m.x - 11, m.y - 11, 22, 22);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }
  }

  // Всплывающие числа. Рисовать самым верхним слоем сцены, до миникарты.
  drawLabels(ctx, ox, oy, z, cw, ch) {
    if (this.off && !this.labelsOnEco) return;
    if (!this.labels.n) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    for (let i = 0; i < this.labels.n; i++) {
      const l = this.labels.a[i];
      const k = l.t / l.life;
      // Взлёт замедляется к концу: число «выдыхает», а не улетает.
      const rise = l.rise * (1 - (1 - k) * (1 - k));
      const sx = ox + l.x * z, sy = oy + (l.y - rise) * z;
      if (sx < -80 || sy < -40 || sx > cw + 80 || sy > ch + 40) continue;
      const px = Math.round(clamp(z * (l.big ? 0.55 : 0.42), l.big ? 14 : 11, l.big ? 34 : 24));
      ctx.font = `bold ${px}px system-ui, "Segoe UI", sans-serif`;
      ctx.globalAlpha = k < 0.1 ? k / 0.1 : k > 0.6 ? (1 - k) / 0.4 : 1;
      ctx.lineWidth = Math.max(2, px * 0.22);
      ctx.strokeStyle = 'rgba(12,10,8,0.85)';   // обводка: иначе число теряется на траве
      ctx.strokeText(l.text, sx, sy);
      ctx.fillStyle = l.col;
      ctx.fillText(l.text, sx, sy);
    }
    ctx.restore();
  }

  // =========================================================================
  // ВНУТРЕННЕЕ
  // =========================================================================
  _density() {
    const q = this.q || {};
    const p = q.particles == null ? 1 : q.particles;
    return this.off ? 0 : p * (q.detail >= 1 ? 1 : 0.6);
  }

  _initPuff(q, x, y, o) {
    q.x = x; q.y = y;
    q.vx = this.wind * 0.28 + (this.rnd() - 0.5) * 0.08;
    q.vy = -o.rise * (0.8 + this.rnd() * 0.4);
    q.t = 0; q.life = o.life * (0.8 + this.rnd() * 0.4);
    q.r = o.r0; q.r1 = o.r1;
    q.a = o.a; q.g = 0; q.drag = 0;
    q.rot = 0; q.spin = 0;
    q.col = o.col; q.wob = o.wob || 0; q.ph = this.rnd() * 6.28;
  }

  _burstPuff(x, y, size, n, col, a) {
    if (this.off) return;
    const dens = this._density();
    const cnt = Math.max(1, Math.round(n * dens));
    for (let i = 0; i < cnt; i++) {
      const q = take(this.puffs);
      if (!q) return;
      const ang = this.rnd() * 6.28;
      this._initPuff(q, x + Math.cos(ang) * size * 0.5, y + Math.sin(ang) * size * 0.2, {
        rise: 0.22, r0: size * 0.12, r1: size * 0.55, life: 1.6, a, col, wob: 0.2,
      });
      q.vx += Math.cos(ang) * 0.5;
    }
  }

  _burstChips(x, y, size, n, colStr) {
    if (this.off || (this.q.detail || 0) < 1) return;
    const cnt = Math.max(1, Math.round(n * this._density()));
    for (let i = 0; i < cnt; i++) {
      const q = take(this.chips);
      if (!q) return;
      const ang = -1.9 + (this.rnd() - 0.5) * 2.2;
      const sp = 0.9 + this.rnd() * 1.4;
      q.x = x + (this.rnd() - 0.5) * size * 0.6;
      q.y = y;
      q.vx = Math.cos(ang) * sp; q.vy = Math.sin(ang) * sp;
      q.t = 0; q.life = 0.9 + this.rnd() * 0.6;
      q.r = 0.05 + this.rnd() * 0.05;      // длина щепки в тайлах
      q.r1 = 0.018 + this.rnd() * 0.014;   // толщина
      q.a = 1; q.g = 4.6; q.drag = 0.1;
      q.rot = this.rnd() * 6.28; q.spin = (this.rnd() - 0.5) * 12;
      q.colStr = colStr;
    }
  }

  _seedStars() {
    const p = this.stars;
    p.n = 0;
    const want = Math.round(FX_LIMITS.star * clamp(this._density(), 0.3, 1));
    for (let i = 0; i < want; i++) {
      const s = take(p);
      if (!s) break;
      s.x = this.rnd();
      // Вид сверху, неба в кадре нет. Поэтому звёзды не рассыпаются по всей
      // карте (так они читались бы светляками, которых рендер и без нас
      // рисует), а сгущаются к верхнему краю: получается полоса ночного неба
      // над горизонтом.
      const u = this.rnd();
      s.y = u * u * 0.42;
      s.k = 1 - s.y / 0.5;                 // ближе к краю — ярче
      s.r = 0.7 + this.rnd() * 1.6;
      s.big = this.rnd() < 0.3;            // трети звёзд положены лучи
      s.ph = this.rnd() * 6.28;
      s.sp = 1.2 + this.rnd() * 2.4;
    }
    this.starsOn = true;
  }

  // Мировая Y устья трубы. Спрайт печётся высотой size*1.16*archHeight*1.12 и
  // ставится основанием на низ тайла, но труба в рисунке никогда не достаёт до
  // верхнего края холста: там запас под конёк и мачту. Замер по кадру дал
  // примерно 0,5 высоты спрайта для дома и для фабрики — это и есть 0,6 от
  // archHeight. Брали 0,88 от полной высоты — дым начинался на целый тайл выше
  // трубы и висел в воздухе оторванным облаком.
  _roofY(b) {
    const s = b.size || 1;
    return b.y + s - archHeight(ARCH[b.id] || 'house') * 0.6 * s;
  }

  _pickBuilding(sim, filter) {
    const list = (sim.buildings || []).filter(b => b.done && !b.destroyed && (!filter || filter(b)));
    if (!list.length) return null;
    return list[Math.floor(this.rnd() * list.length) % list.length];
  }

  // Точка, над которой всплывёт число по ресурсу.
  _anchor(sim, resId) {
    const ids = RES_ANCHOR[resId];
    if (ids) {
      for (const id of ids) {
        const b = (sim.buildings || []).find(x => x.id === id && x.done && !x.destroyed);
        if (b) return { x: b.x + (b.size || 1) / 2, y: b.y };
      }
    }
    const c = (sim.buildings || []).find(x => x.id === 'campfire' && !x.destroyed);
    if (c) return { x: c.x + 0.5, y: c.y };
    const w = sim.world || {};
    return { x: (w.startX || 48) + 0.5, y: (w.startY || 48) - 0.5 };
  }
}

/* ПОДКЛЮЧЕНИЕ */
//
// Ниже — точные строки для app/src/render/renderer.js. Сам renderer.js этим
// агентом НЕ ТРОГАЛСЯ (чужая зона): вставлять руками.
//
// 1) Импорт — после строки
//      import { QUALITY, guessQuality, loadQualityId, saveQualityId, makeAutoTuner } from './quality.js';
//    добавить:
//
//      import { FxLayer } from './fx.js';
//
// 2) Конструктор Renderer — после строки `this.art.preload();` добавить:
//
//      this.fx = new FxLayer(this.quality);
//
// 3) setQuality(id) — после строки `this.beasts.setQuality(this.quality);` добавить:
//
//      this.fx.setQuality(this.quality);
//
//    То же самое в tuneAuto(dtReal), после такой же строки `this.beasts.setQuality(...)`.
//
// 4) draw() — обновление состояния. Сразу ПОСЛЕ строки
//      this.terrain.draw(ctx, sim, ox, oy, z, cw, ch);
//    (или после строки this.atmo.update(...), если weather.js уже подключён)
//    добавить:
//
//      this.fx.update(sim, dtReal, ox, oy, z, cw, ch);
//
// 5) draw() — частицы. Сразу ПОСЛЕ строки
//      this.drawSortedEntities(sim, ctx, ox, oy, z, cw, ch, L);
//    добавить:
//
//      this.fx.drawWorld(ctx, ox, oy, z, cw, ch);
//
//    Именно здесь: дым, вылезший до зданий, уходил бы ПОД крышу собственной
//    трубы, а после тона суток он бы не темнел вместе с городом.
//
// 6) draw() — небо. Сразу ПОСЛЕ строки
//      if (this.quality.godRays) this.drawGodRays(ctx, cw, ch, L);
//    добавить:
//
//      this.fx.drawSky(ctx, cw, ch);
//
//    Метеоры и звёзды идут поверх ночного тона — иначе синий фильтр съедает
//    их целиком, ведь именно ночью они и нужны.
//
// 7) draw() — числа. Сразу ПЕРЕД строкой
//      this.drawMinimap(sim, ctx, cw, ch);
//    добавить:
//
//      this.fx.drawLabels(ctx, ox, oy, z, cw, ch);
//
//    Числа — это интерфейс: их не должны глушить ни виньетка, ни зерно, но и
//    поверх миникарты они лезть не должны.
//
// 8) Загрузка сейва и новая игра — там, где Renderer уже существует, а мир
//    заменяется целиком (main.js/hud.js, чужая зона):
//
//      renderer.fx.clear();
//
//    Без этого над новым городом секунду висит дым старого.
//
// ---------------------------------------------------------------------------
// ЧТО РАБОТАЕТ САМО, БЕЗ ЕДИНОЙ ПРАВКИ В ЯДРЕ
//
//   • дым труб — от очага каменного века до фабричного столба, плотность
//     растёт с эпохой постройки, зимой жильё топят сильнее, летом слабее;
//     производство дымит только когда на нём есть рабочие;
//   • искры и зарево горна — кузница, оружейная, литейная, фабрика, ТЭЦ,
//     робозавод (только при detail ≥ 1);
//   • пыль и щепки стройки — ровно пока b.progress растёт, то есть пока на
//     площадке действительно работают; на завершении — облако пыли;
//   • пожар и чёрный дым — когда здание сносят (b.destroyed) и когда у него
//     hp < 60% от предела: язычки пламени плюс копоть;
//   • события из журнала — модуль читает sim.log и по названию находит
//     определение в EVENT_DEFS: пожар, землетрясение, урожай, метеорный дождь,
//     звёздная ночь, праздник, чума, бурелом, заморозки;
//   • всплывающие числа — по скачкам sim.res больше 8 единиц: +12🍞 над
//     амбаром, −30🪙 над сокровищницей при уплате дани, цена постройки над
//     складом. Порог — fx.numMin.
//
// ЕСЛИ ХОЧЕТСЯ ТОЧНЕЕ (когда дойдут руки до hud.js/simulation.js):
//
//      renderer.fx.event(def, sim);              // разыграть событие по объекту
//      renderer.fx.fire(x, y, size, sec);        // поджечь конкретное здание
//      renderer.fx.extinguish(x, y, r);          // потушить — пламя сменится паром
//      renderer.fx.harvest(sim);                 // снопы над всеми фермами
//      renderer.fx.meteorShower(sec) / starNight(sec);
//      renderer.fx.number(x, y, '+12🍞', 'good');
//      renderer.fx.resNumber(sim, 'gold', -30);  // сам найдёт склад
//      renderer.fx.collapse(x, y, size);         // пыль и обломки
//      renderer.fx.festival(x, y, sec);
//      renderer.fx.clearEvents();                // снять все источники разом
//
// Автоматика и ручные вызовы не конфликтуют: чтобы событие не сыграло дважды,
// достаточно занести его id в набор пропуска —
//
//      renderer.fx.muted.add('fire_event');   // ловить его буду сам
//
// после чего по журналу это событие разыгрываться не будет.
//
// ---------------------------------------------------------------------------
// ПРЕСЕТЫ И БЮДЖЕТ
//
//   eco     — модуль выключен полностью: ни частиц, ни неба, ни чисел
//             (числа можно вернуть флагом renderer.fx.labelsOnEco = true).
//   medium  — particles 0.5, detail 1: дым и пожар есть, щепки и искры реже.
//   high    — particles 0.8: всё.
//   ultra   — particles 1.0: всё, максимальная плотность.
//
// Зум: ниже z = 14 (масштаб ~0,45) рисуется только пламя, числа и небо —
// на карте города мелкая крошка всё равно нечитаема, а стоит столько же.
//
// ЗАМЕР (метод А из docs/visual-performance-budget.md: вызов + getImageData,
// Chromium на SwiftShader, 1600×900, dpr 1, пресет high, зум 1,6, город из 33
// построек эпохи 8, все с рабочими):
//
//   обычный кадр большого города (149 клубов дыма)          1,4 мс
//   три пожара + метеорный дождь + звёзды (228+53+77)       3,5 мс
//   деревня десяти дворов                                   ~0,4 мс
//   пресет eco                                              0 мс (модуль молчит)
//
// Числа пессимистичны: SwiftShader считает всё на CPU, на живой видеокарте
// делите на 2–4. Одновременное заполнение всех пулов недостижимо — дым и огонь
// делят одни и те же здания, небо живёт только ночью и только во время события,
// а пожаров разом бывает не больше трёх.
