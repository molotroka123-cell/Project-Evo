// ui/coach.js — пошаговое обучение («ведёт за руку») и умные напоминания.
//
// Зачем: замер показал, что за 3000 дней без вмешательства игрока копится 1799
// знаний и изучается НОЛЬ технологий — игра нигде не говорит, что знания надо
// тратить. Четыре текстовых окна старого онбординга это не лечат: их
// пролистывают, не читая, и они ничего не проверяют.
//
// Здесь другой подход:
//   · подсвечивается одна конкретная кнопка, текста — одна строка;
//   · шаг закрывается ФАКТОМ действия игрока, кнопки «дальше» нет;
//   · шаг, который сейчас невозможен (склад без Гончарства), откладывается
//     и всплывает сам, когда становится доступен;
//   · после обучения включаются напоминания: «знаний хватает на технологию»,
//     «еды на 3 дня» — не чаще одного в минуту и без повторов.
//
// Слой представления: читает состояние симуляции и зовёт публичные методы hud,
// но ничего в ядре не меняет. Своя разметка и свои стили — чужие файлы не
// трогает вообще.
import { BUILDINGS, TECHS, RES, SEASONS } from '../core/data.js';

const LS_KEY = 'frontier_coach2';        // прогресс обучения
const LS_LEGACY = 'frontier_coached';    // флаг старого онбординга — гасим его

const REMIND_GAP = 60000;      // не чаще одного напоминания в минуту
const REMIND_REPEAT = 600000;  // одно и то же — не раньше чем через 10 минут
const REMIND_DELAY = 30000;    // тишина после конца обучения
const RESUME_GAP = 2000;       // как часто проверять, не дозрел ли отложенный шаг

// Здания, которыми игрок «отправляет людей за ресурсом», и склады.
const GATHER_IDS = ['forager', 'lumber', 'quarry', 'hunter_lodge', 'farm', 'pasture', 'port', 'mine'];
const STORE_IDS = ['granary', 'woodshed', 'stoneyard', 'depot'];

// ---------------------------------------------------------------- утилиты ---
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим Safari */ } }

// Элемент виден, если у него есть площадь, он на экране и не срезан скроллом
// панели. Панели перерисовываются 4 раза в секунду целиком (innerHTML), поэтому
// узлы искать надо каждый раз заново — ссылки протухают за четверть секунды.
function visible(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return null;
  for (const hostId of ['sideContent', 'sheetContent']) {
    const host = document.getElementById(hostId);
    if (host && host.contains(el)) {
      const h = host.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      if (cy < h.top + 2 || cy > h.bottom - 2) return null;   // уехал за край списка
    }
  }
  return r;
}

function firstVisible(selectors) {
  for (const s of selectors) {
    for (const el of document.querySelectorAll(s)) {
      const r = visible(el);
      if (r) return { el, rect: r };
    }
  }
  return null;
}

const modalOpen = () => !!document.getElementById('modalWrap')?.classList.contains('show');

// Кнопка вкладки: на ПК живёт в боковой панели, на телефоне — в нижнем листе.
const tabSel = (id) => [`#sideTabs [data-tab="${id}"]`, `#sheetTabs [data-tab="${id}"]`];
// Карточка внутри панели, а если её не видно — сама вкладка.
const cardSel = (attr, id) => [`#sideContent [data-${attr}="${id}"]`, `#sheetContent [data-${attr}="${id}"]`];

// -------------------------------------------------------------- сценарий ---
// ready — можно ли показывать шаг прямо сейчас (иначе он ждёт своей очереди);
// moot  — шаг потерял смысл навсегда (например, соседей в мире нет);
// done  — факт действия игрока.
const STEPS = [
  {
    id: 'villager',
    title: 'Познакомься с жителем',
    text: 'Ткни в человечка на карте — посмотрим, кто он и чем занят.',
    target: (c) => c.villagerTarget(),
    done: (c) => c.flags.tapped,
  },
  {
    id: 'gather',
    title: 'Отправь людей за ресурсом',
    text: 'СТРОЙКА → «Собиратели». Поставь дом промысла — жители сами пойдут работать.',
    build: true,
    target: () => [...cardSel('build', 'forager'), ...cardSel('build', 'lumber'), ...tabSel('build')],
    done: (c) => c.hasAny(GATHER_IDS),
  },
  {
    id: 'hut',
    title: 'Построй хижину',
    text: 'СТРОЙКА → «Хижина» (🪵6). Перетащи призрак по карте и нажми ✓ — жильё на 4 человек.',
    build: true,
    target: () => [...cardSel('build', 'hut'), ...tabSel('build')],
    done: (c) => c.hasAny(['hut']),
  },
  {
    id: 'store',
    title: 'Заведи склад',
    text: 'Добыча сверх потолка пропадает впустую. Поставь склад — потолок поднимется.',
    build: true,
    // Каменный век складов не знает: шаг ждёт, пока откроется нужная технология.
    ready: (c) => STORE_IDS.some(id => c.unlocked(id)),
    target: (c) => {
      const id = STORE_IDS.find(x => c.unlocked(x)) || 'granary';
      return [...cardSel('build', id), ...tabSel('build')];
    },
    note: (c) => {
      const id = STORE_IDS.find(x => c.unlocked(x));
      return id ? `Нужен: ${BUILDINGS[id].name} · ${c.hud.costStr(BUILDINGS[id].cost)}` : '';
    },
    done: (c) => c.hasAny(STORE_IDS),
  },
  {
    id: 'labor',
    title: 'Распредели труд',
    text: 'Вкладка ТРУД: подними приоритет 🍞 еды или 🪵 дерева — свободные руки уйдут туда.',
    target: () => [...cardSel('labor', 'food:1'), ...tabSel('labor')],
    done: (c) => {
      const l = c.sim.labor, b = c.base.labor;
      return Object.keys(l).some(k => l[k] !== b[k]);
    },
  },
  {
    id: 'tech',
    title: 'Открой первую технологию',
    // Тот самый шаг ради которого всё затевалось: знания копятся сами и без
    // траты не значат ничего.
    text: 'Знания сами ничего не дают. НАУКА → «Орудия труда»: +30% ко всей добыче.',
    target: (c) => [...cardSel('tech', c.cheapTechId()), ...tabSel('research')],
    note: (c) => {
      const t = c.cheapTech();
      if (!t) return '';
      const cost = c.sim.techCost(t), have = Math.floor(c.sim.res.knowledge);
      if (have >= cost) return `📜 ${have} / ${cost} — уже хватает, открывай!`;
      const r = c.hud.rate('knowledge');
      const eta = r && r > 0.05 ? ` · ещё ~${Math.ceil((cost - have) / r)} дн.` : '';
      return `📜 ${have} / ${cost}${eta}`;
    },
    done: (c) => c.sim.techs.size > c.base.techs,
  },
  {
    id: 'event',
    title: 'Переживи первое событие',
    // Шаг ждёт, пока событие случится само: раньше показывать нечего.
    ready: (c) => !!c.flags.event,
    text: (c) => c.sim.pendingEvent
      ? 'Случилось событие — выбери решение. Отменить его потом нельзя.'
      : `«${c.flags.event}» — так выглядит событие. Загляни в ЖУРНАЛ: там вся история поселения.`,
    overModal: true,
    target: (c) => c.sim.pendingEvent ? ['#modalBox [data-ev]'] : [...tabSel('log')],
    done: (c) => c.sim.pendingEvent ? false : c.hud.tab === 'log',
  },
  {
    id: 'scout',
    title: 'Разведай соседей',
    text: 'Мини-карта в углу: ткни рядом с цветной меткой — камера прыгнет к соседям.',
    moot: (c) => !c.sim.factions.some(f => f.alive),
    target: (c) => c.minimapTarget(),
    done: (c) => c.nearNeighbour() || !!document.querySelector('#modalBox [data-act="gift"], #modalBox [data-act="peace"]'),
  },
];

// ----------------------------------------------------------- напоминания ---
// Каждое правило возвращает {text, type, target, key} или null. key разделяет
// поводы: новая технология — новый повод, и это не считается повтором.
const REMINDERS = [
  {
    id: 'tech',
    test: (c) => {
      const t = c.cheapTech();
      if (!t) return null;
      const cost = c.sim.techCost(t);
      if (c.sim.res.knowledge < cost) return null;
      const extra = c.sim.res.knowledge >= cost * 3 ? ' Знания копятся впустую!' : '';
      return {
        key: 'tech:' + t.id,
        type: 'good',
        text: `📜 ${Math.floor(c.sim.res.knowledge)} знаний — хватит на «${t.name}» (📜${cost}).${extra} Вкладка НАУКА.`,
        target: tabSel('research'),
      };
    },
  },
  {
    id: 'food',
    test: (c) => {
      const d = c.hud.foodDays();
      if (d === null || d > 3) return null;
      return { key: 'food', type: 'bad', text: `🍞 Еды на ${Math.floor(d)} дн. — ${c.hud.shortReason('food')}`, target: tabSel('build') };
    },
  },
  {
    id: 'wood',
    test: (c) => c.sim.woodCrisis()
      ? { key: 'wood', type: 'bad', text: '🪵 Дерево кончилось. Лесопилка ставится вплотную к лесу — без неё стройка встанет.', target: cardSel('build', 'lumber').concat(tabSel('build')) }
      : null,
  },
  {
    id: 'cap',
    test: (c) => {
      for (const r of RES) {
        const cap = c.sim.resCap[r.id];
        if (cap && cap < 99999 && c.sim.res[r.id] >= cap - 0.5) {
          const st = STORE_IDS.find(id => c.unlocked(id) && BUILDINGS[id].cap && BUILDINGS[id].cap[r.id]);
          return {
            key: 'cap:' + r.id,
            type: 'warn',
            text: st ? `${r.icon} Склад полон — добыча пропадает. Поможет «${BUILDINGS[st].name}».`
              : `${r.icon} Склад полон (${cap}) — добыча пропадает впустую.`,
            target: st ? cardSel('build', st).concat(tabSel('build')) : tabSel('build'),
          };
        }
      }
      return null;
    },
  },
  {
    id: 'idle',
    test: (c) => {
      const w = c.hud.workerStats();
      if (w.idle < 3) return null;
      return w.free > 0
        ? { key: 'idle:free', type: 'warn', text: `🧍 ${w.idle} без дела при ${w.free} свободных местах — поправь приоритеты во вкладке ТРУД.`, target: tabSel('labor') }
        : { key: 'idle:none', type: 'warn', text: `🧍 ${w.idle} без дела, а рабочих мест нет — ставь производство.`, target: tabSel('build') };
    },
  },
  {
    id: 'housing',
    test: (c) => c.sim.villagers.length >= c.sim.housingCap()
      ? { key: 'housing', type: 'warn', text: `🏠 Жильё занято ${c.sim.villagers.length}/${c.sim.housingCap()} — без новых домов население встало.`, target: cardSel('build', 'hut').concat(tabSel('build')) }
      : null,
  },
  {
    id: 'science',
    test: (c) => {
      if (c.sim.day < 40) return null;
      const has = c.sim.doneBuildings().some(b => (BUILDINGS[b.id].out || {}).knowledge);
      if (has) return null;
      const r = c.hud.rate('knowledge');
      if (r !== null && r > 0.8) return null;
      return { key: 'science', type: 'info', text: '📜 Знания идут только от кострища. Костёр историй, а позже Академия ускорят науку втрое.', target: tabSel('research') };
    },
  },
  {
    id: 'raid',
    test: (c) => c.sim.raids.warning
      ? { key: 'raid:' + Math.floor(c.sim.day / 30), type: 'bad', text: '⚔ Враг близко. Казарма и частокол решают исход рейда, а не удача.', target: tabSel('army') }
      : null,
  },
  {
    id: 'winter',
    test: (c) => {
      if (c.sim.seasonIdx !== 2 || c.sim.day < 60) return null;   // осень: зима на носу
      if (c.sim.hasBuilding('pasture') || c.sim.hasBuilding('port')) return null;
      if (!c.sim.hasBuilding('farm')) return null;
      return { key: 'winter:' + Math.floor(c.sim.day / 100), type: 'warn', text: `❄ ${SEASONS[2]}: зимой фермы встают. Спасут пастбище, порт и запас в амбаре.`, target: tabSel('build') };
    },
  },
];

// ------------------------------------------------------------------ стили ---
const CSS = `
#coachRing { position: fixed; z-index: 78; pointer-events: none; display: none;
  border: 2px solid var(--accent); border-radius: 12px;
  box-shadow: 0 0 0 2px rgba(13,20,32,0.55), 0 0 22px rgba(201,162,39,0.55), inset 0 0 14px rgba(201,162,39,0.25); }
#coachRing.show { display: block; }
#coachRing.done { border-color: var(--good); box-shadow: 0 0 0 2px rgba(13,20,32,0.55), 0 0 26px rgba(125,227,125,0.6); }
#coachRing i { position: absolute; inset: -6px; border: 2px solid var(--accent); border-radius: 15px;
  opacity: 0; animation: coachPulse 1.6s ease-out infinite; }
#coachRing.done i { border-color: var(--good); animation: none; }
@keyframes coachPulse { 0% { transform: scale(0.94); opacity: 0.85; } 100% { transform: scale(1.14); opacity: 0; } }

/* Карточка не должна перехватывать тапы по карте и по кнопкам под ней —
   кликабельна в ней только «Пропустить». */
#coachCard { position: fixed; z-index: 79; display: none; width: min(88vw, 300px); pointer-events: none;
  background: var(--panel); border: 1px solid var(--accent); border-radius: 12px;
  padding: 11px 12px; box-shadow: 0 10px 34px rgba(0,0,0,0.55); font-size: 13px; line-height: 1.4; }
#coachCard.show { display: block; }
#coachCard .c-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; }
#coachCard .c-step { color: var(--dim); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; }
#coachCard .c-skip { background: none; border: none; color: var(--dim); font-size: 11px; cursor: pointer;
  padding: 2px 4px; text-decoration: underline; pointer-events: auto; }
#coachCard .c-skip:hover { color: var(--text); }
#coachCard .c-title { color: var(--accent); font-weight: 700; font-size: 14px; margin-bottom: 3px; }
#coachCard .c-text { color: var(--text); }
#coachCard .c-note { color: var(--warn); font-size: 11px; margin-top: 5px; }
#coachCard .c-dots { display: flex; gap: 4px; margin-top: 9px; }
#coachCard .c-dots span { width: 100%; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.14); }
#coachCard .c-dots span.on { background: var(--accent); }
#coachCard .c-dots span.cur { background: var(--warn); }
#coachCard.ok { border-color: var(--good); }
#coachCard.ok .c-title { color: var(--good); }
@media (max-width: 820px) { #coachCard { width: min(92vw, 340px); font-size: 12.5px; } }
`;

// ------------------------------------------------------------------ класс ---
export class Coach {
  // opts: { hud, renderer, audio, getSim }
  // getSim не обязателен: hud.sim переставляется при новой игре и загрузке сейва,
  // поэтому по умолчанию читаем симуляцию оттуда — коуч сам заметит подмену.
  constructor(opts = {}) {
    this.hud = opts.hud;
    this.r = opts.renderer;
    this.audio = opts.audio || null;
    this.getSim = opts.getSim || (() => this.hud.sim);
    this.mode = 'off';            // off | teach | remind
    this.step = null;
    this.doneIds = new Set();
    this.flags = { tapped: false, event: null };
    this.base = { labor: {}, techs: 0 };
    this.sim = null;
    this._el = null;
    this._raf = 0;
    this._okUntil = 0;            // до какого времени показываем «✓ Готово»
    this._okTarget = null;
    this._html = '';              // последняя разметка карточки — чтобы не дёргать DOM
    this._remindAt = 0;           // когда включать напоминания
    this._lastRemind = -REMIND_GAP;
    this._remindLog = new Map();
    this._seenLog = new Set();
    this._logAt = 0;
    this._flash = null;           // разовая подсветка под напоминание
    this._pick = null;            // житель, выбранный для первого шага
    this._skipped = false;        // обучение не показываем (отказ игрока или старый сейв)
    this._skippedSaved = false;   // отказ игрока — он переживает перезагрузку
    this._resumeAt = 0;
  }

  // ---------- жизненный цикл ----------
  start() {
    if (this.mode !== 'off') return;
    // Старый онбординг мог остаться подключённым: гасим его окно и его флаг,
    // чтобы две подсказки не спорили за экран.
    try { this.hud.hideCoach(); } catch { /* элемента может не быть */ }
    lsSet(LS_LEGACY, '1');
    this.ensureDom();
    const saved = this.load();
    this._skippedSaved = !!saved.skipped;
    this.rebind(this.getSim());
    if (saved.skipped || saved.done || this._skipped) this.toRemind(REMIND_DELAY);
    else this.mode = 'teach';
    this.loop();
  }

  stop() {
    this.mode = 'off';
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.hide();
  }

  // Пропуск обучения целиком — одной кнопкой, как и просили.
  skip() {
    if (this.mode !== 'teach') return;
    this._skipped = true;
    this._skippedSaved = true;
    this.save({ skipped: true });
    this.step = null;
    this.hide();
    this.hud.toast('Обучение выключено. Подсказки останутся — только по делу.', 'info');
    this.toRemind(REMIND_DELAY);
  }

  reset() {
    this.doneIds.clear();
    this.flags = { tapped: false, event: null };
    this._remindLog.clear();
    this._skipped = false;
    this._skippedSaved = false;
    lsSet(LS_KEY, '');
    this.mode = 'off';
    this.step = null;
    this.start();
  }

  get active() { return this.mode === 'teach' && !!this.step; }

  // Новая партия или загрузка сейва: перезаписываем точки отсчёта, иначе
  // «изменил приоритет труда» сравнивалось бы с чужой партией.
  rebind(sim) {
    this.sim = sim;
    // Поселение уже развито (загружен старый сейв) — учить основам поздно,
    // остаются только напоминания. Проверяется на каждой смене партии: новая
    // игра после старого сейва обучение возвращает.
    this._skipped = this._skippedSaved || this.veteran(sim);
    if (this._skipped && this.mode === 'teach') this.toRemind(REMIND_DELAY);
    this.base.labor = { ...sim.labor };
    this.base.techs = sim.techs.size;
    this.flags.tapped = false;
    this.flags.event = null;
    this._seenLog.clear();
    this._pick = null;
    // Шаги, которые в этом мире уже выполнены (загруженный сейв), закрываем молча.
    for (const s of STEPS) {
      if (this.doneIds.has(s.id)) continue;
      if (['gather', 'hut', 'store'].includes(s.id) && this.safe(() => s.done(this), false)) this.doneIds.add(s.id);
    }
  }

  veteran(s) {
    return s.day > 15 || s.techs.size > 2 || s.buildings.filter(b => !b.destroyed).length > 5;
  }

  toRemind(delay) {
    this.mode = 'remind';
    this.step = null;
    this.hide();
    this._remindAt = this.now() + delay;
  }

  now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

  // Любая ошибка в подсказке не должна ронять кадр игры.
  safe(fn, fallback) { try { return fn(); } catch { return fallback; } }

  // ---------- сохранение прогресса ----------
  load() {
    try {
      const raw = lsGet(LS_KEY);
      if (!raw) return {};
      const d = JSON.parse(raw);
      if (Array.isArray(d.done)) for (const id of d.done) this.doneIds.add(id);
      return d;
    } catch { return {}; }
  }

  save(extra = {}) {
    lsSet(LS_KEY, JSON.stringify({ done: [...this.doneIds], ...extra }));
  }

  // ---------- разметка ----------
  ensureDom() {
    if (this._el) return;
    const style = document.createElement('style');
    style.id = 'coachStyle';
    style.textContent = CSS;
    document.head.appendChild(style);

    const ring = document.createElement('div');
    ring.id = 'coachRing';
    ring.innerHTML = '<i></i>';
    const card = document.createElement('div');
    card.id = 'coachCard';
    document.body.appendChild(ring);
    document.body.appendChild(card);
    this._el = { ring, card };

    // Тап по жителю — первый шаг. Слушаем на всплытии и ничего не отменяем:
    // родные обработчики карты (панорама, карточка здания) работают как прежде.
    const cv = this.r && this.r.canvas;
    if (cv) {
      let dx = 0, dy = 0, t0 = 0;
      cv.addEventListener('pointerdown', e => { dx = e.clientX; dy = e.clientY; t0 = this.now(); }, { passive: true });
      cv.addEventListener('pointerup', e => {
        if (Math.hypot(e.clientX - dx, e.clientY - dy) > 8 || this.now() - t0 > 500) return;
        this.onMapTap(e.clientX, e.clientY);
      }, { passive: true });
    }
  }

  hide() {
    if (!this._el) return;
    this._el.ring.classList.remove('show');
    this._el.card.classList.remove('show');
  }

  // ---------- вспомогательное про мир ----------
  hasAny(ids) { return this.sim.buildings.some(b => !b.destroyed && ids.includes(b.id)); }

  unlocked(id) {
    const def = BUILDINGS[id];
    return !!def && (!def.req || this.sim.techs.has(def.req));
  }

  // Самая дешёвая технология, которую можно изучить прямо сейчас.
  cheapTech() {
    const s = this.sim;
    let best = null, bestCost = Infinity;
    for (const t of TECHS) {
      if (s.techs.has(t.id)) continue;
      if (t.prereq.some(p => !s.techs.has(p))) continue;
      const c = s.techCost(t);
      if (c < bestCost) { best = t; bestCost = c; }
    }
    return best;
  }

  cheapTechId() { const t = this.cheapTech(); return t ? t.id : 'tools'; }

  nearNeighbour() {
    const cam = this.r.cam;
    return this.sim.factions.some(f => f.alive && f.settlements.some(s => Math.hypot(cam.x - s.x, cam.y - s.y) < 14));
  }

  // Житель для первого шага: ближайший к центру экрана, выбранный один раз.
  villagerTarget() {
    const s = this.sim;
    if (!s.villagers.length) return null;
    if (!this._pick || !s.villagers.includes(this._pick)) {
      const cam = this.r.cam;
      let best = null, bd = Infinity;
      for (const v of s.villagers) {
        const d = Math.hypot(v.x - cam.x, v.y - cam.y);
        if (d < bd) { bd = d; best = v; }
      }
      this._pick = best;
    }
    const v = this._pick;
    if (!v) return null;
    const p = this.r.worldToScreen(v.x, v.y);
    const rad = Math.max(22, 26 * this.r.cam.zoom);
    return { rect: { left: p.x - rad, top: p.y - rad * 1.15, width: rad * 2, height: rad * 2.1 } };
  }

  minimapTarget() {
    const m = this.r.minimapRect;
    if (!m) return [...tabSel('diplo')];
    return { rect: { left: m.x - 4, top: m.y - 4, width: m.w + 8, height: m.h + 8 } };
  }

  // Чем занят житель — словами игрока, по состоянию, без выдумок.
  villagerWhat(v) {
    const t = v.target;
    if (t && t.kind === 'work' && t.b) return `работает: ${BUILDINGS[t.b.id].name}`;
    if (t && t.kind === 'build') return 'на стройке';
    if (v.job === 'hunt') return 'на охоте';
    if (v.job === 'forage') return 'собирает еду';
    if (v.job === 'deadfall') return 'собирает валежник';
    return 'без дела — нужны рабочие места';
  }

  onMapTap(sx, sy) {
    if (this.mode !== 'teach') return;
    const w = this.r.screenToWorld(sx, sy);
    let best = null, bd = 1.6;
    for (const v of this.sim.villagers) {
      const d = Math.hypot(v.x - w.x, v.y - w.y);
      if (d < bd) { bd = d; best = v; }
    }
    if (!best) return;
    this.flags.tapped = true;
    this._pick = best;
    this.hud.toast(`${best.name} — ${this.villagerWhat(best)}`, 'good');
  }

  // ---------- главный цикл ----------
  loop() {
    if (this.mode === 'off') return;
    this._raf = requestAnimationFrame(() => {
      this.safe(() => this.frame(), null);
      this.loop();
    });
  }

  frame() {
    const sim = this.getSim();
    if (!sim) return;
    if (sim !== this.sim) this.rebind(sim);
    const now = this.now();
    this.scanLog(now);
    if (this.mode === 'teach') this.teach(now);
    else this.remind(now);
  }

  // События приходят строкой в журнал. Читаем только хвост и раз в полсекунды:
  // журнал обрезается по 120 записям, поэтому по индексам следить нельзя.
  scanLog(now) {
    if (now - this._logAt < 500) return;
    this._logAt = now;
    const log = this.sim.log;
    for (let i = Math.max(0, log.length - 5); i < log.length; i++) {
      const l = log[i];
      const key = l.day + '|' + l.text;
      if (this._seenLog.has(key)) continue;
      this._seenLog.add(key);
      const m = /Событие: ([^—]+) —/.exec(l.text);
      if (m && !this.flags.event) this.flags.event = m[1].trim();
    }
    if (this._seenLog.size > 40) this._seenLog = new Set([...this._seenLog].slice(-20));
  }

  // ---------- обучение ----------
  teach(now) {
    // Пауза на «✓ Готово»: игрок должен успеть увидеть, что шаг закрылся.
    if (this._okUntil) {
      if (now < this._okUntil) { this.place(this._okTarget, true); return; }
      this._okUntil = 0;
      this.step = null;
    }
    if (!this.step) {
      this.step = this.nextStep();
      if (!this.step) {
        // Ни одного готового шага. Если остались отложенные (склад без
        // Гончарства, событие, которое ещё не случилось) — не держим игрока
        // пустой карточкой: уходим в напоминания и вернёмся, когда дозреет.
        const rest = STEPS.filter(s => !this.doneIds.has(s.id));
        this.finish(!rest.length);
        return;
      }
      this.safe(() => this.step.onEnter?.(this), null);
    }
    const step = this.step;
    if (this.safe(() => step.done(this), false)) {
      this.doneIds.add(step.id);
      this.save();
      this.audio?.play('tech');
      this._okUntil = now + 1300;
      this._okTarget = this.resolve(step);
      this.renderCard(step, true);
      return;
    }
    const t = this.resolve(step);
    this._okTarget = t;
    this.renderCard(step, false);
    this.place(t, false);
  }

  nextStep() {
    for (const s of STEPS) {
      if (this.doneIds.has(s.id)) continue;
      if (this.safe(() => s.moot?.(this), false)) { this.doneIds.add(s.id); continue; }
      if (s.ready && !this.safe(() => s.ready(this), false)) continue;
      return s;
    }
    return null;
  }

  // all=true — сценарий пройден целиком; иначе часть шагов ждёт своего часа.
  finish(all) {
    this.save(all ? { done: true } : {});
    this.step = null;
    this.hide();
    this.hud.toast(all
      ? 'Обучение пройдено. Дальше — только подсказки по делу.'
      : 'Основы пройдены. Остальное подскажу, когда придёт время.', 'good');
    this.toRemind(REMIND_DELAY);
  }

  // Цель шага: либо готовый прямоугольник (карта, мини-карта), либо первый
  // видимый элемент из списка селекторов.
  resolve(step) {
    // Призрак уже на карте: дальше игроку нужна зелёная ✓, а не карточка здания.
    if (step.build && this.sim.placing) return firstVisible(['#placeOk']);
    const t = this.safe(() => (typeof step.target === 'function' ? step.target(this) : step.target), null);
    if (!t) return null;
    if (Array.isArray(t)) return firstVisible(t);
    if (t.rect) return t;
    return null;
  }

  renderCard(step, ok) {
    const idx = STEPS.indexOf(step) + 1;
    let text = typeof step.text === 'function' ? this.safe(() => step.text(this), '') : step.text;
    if (step.build && this.sim.placing) {
      text = this.sim.placing.valid
        ? 'Место годится — жми зелёную ✓.'
        : `Ткни по свободному месту на карте: ${this.sim.placing.reason || 'здесь нельзя'}.`;
    }
    const note = step.note ? this.safe(() => step.note(this), '') : '';
    const dots = STEPS.map(s => `<span class="${this.doneIds.has(s.id) ? 'on' : s === step ? 'cur' : ''}"></span>`).join('');
    const card = this._el.card;
    const html = `<div class="c-head"><span class="c-step">Шаг ${idx} из ${STEPS.length}</span>
        <button class="c-skip">Пропустить обучение</button></div>
      <div class="c-title">${ok ? '✓ Готово' : step.title}</div>
      <div class="c-text">${ok ? 'Отлично. Дальше.' : text}</div>
      ${!ok && note ? `<div class="c-note">${note}</div>` : ''}
      <div class="c-dots">${dots}</div>`;
    if (html !== this._html) {
      this._html = html;
      card.innerHTML = html;
      card.querySelector('.c-skip').onclick = () => this.skip();
    }
    card.classList.toggle('ok', !!ok);
  }

  // ---------- позиционирование ----------
  place(target, ok, withCard = true) {
    const { ring, card } = this._el;
    // Модалка перекрывает всё: подсказку прячем, кроме шага, который сам про модалку.
    if (modalOpen() && !this.step?.overModal) { this.hide(); return; }
    if (!target || !target.rect) {
      ring.classList.remove('show');
      card.classList.toggle('show', withCard);
      if (withCard) this.placeCard(null);
      return;
    }
    const r = target.rect;
    ring.classList.add('show');
    ring.classList.toggle('done', !!ok);
    ring.style.left = Math.round(r.left - 4) + 'px';
    ring.style.top = Math.round(r.top - 4) + 'px';
    ring.style.width = Math.round(r.width + 8) + 'px';
    ring.style.height = Math.round(r.height + 8) + 'px';
    card.classList.toggle('show', withCard);
    // Цель внутри панели — карточку отодвигаем от ВСЕЙ панели, а не от кнопки:
    // иначе она наползает на список и закрывает соседние вкладки.
    if (withCard) this.placeCard(r, target.el ? target.el.closest('#sidePanel, #sheet, #placeBar') : null);
  }

  // Карточка встаёт рядом с подсветкой и не вылезает за экран: снизу, если
  // цель вверху, слева — если цель у правого края (там боковая панель).
  placeCard(r, host) {
    const card = this._el.card;
    const w = card.offsetWidth || 300, h = card.offsetHeight || 120;
    const pad = 10;
    const hr = host ? host.getBoundingClientRect() : null;
    let x, y;
    if (!r) { x = pad; y = innerHeight - h - 80; }
    else if (innerWidth <= 820) {
      x = Math.min(innerWidth - w - pad, Math.max(pad, r.left + r.width / 2 - w / 2));
      y = r.top > innerHeight / 2 ? r.top - h - 14 : r.top + r.height + 14;
      if (hr) y = Math.min(y, hr.top - h - 12);          // нижний лист не закрываем
    } else {
      const leftOf = hr ? hr.left : r.left;
      const rightOf = hr ? hr.right : r.left + r.width;
      x = r.left > innerWidth / 2 ? leftOf - w - 16 : rightOf + 16;
      y = r.top + r.height / 2 - h / 2;
      if (x < pad) x = rightOf + 16;
      if (x + w > innerWidth - pad) x = Math.max(pad, leftOf - w - 16);
    }
    card.style.left = Math.round(Math.max(pad, Math.min(innerWidth - w - pad, x))) + 'px';
    card.style.top = Math.round(Math.max(56, Math.min(innerHeight - h - pad, y))) + 'px';
  }

  // ---------- напоминания ----------
  remind(now) {
    // Отложенный шаг мог дозреть: открылась технология склада, случилось первое
    // событие. Возвращаемся к обучению ровно на этот шаг.
    if (!this._skipped && now - this._resumeAt > RESUME_GAP) {
      this._resumeAt = now;
      if (this.nextStep()) { this.mode = 'teach'; this.step = null; this._flash = null; return; }
    }
    // Разовая подсветка кнопки под последнее напоминание.
    if (this._flash) {
      if (now > this._flash.until) { this._flash = null; this.hide(); }
      else {
        const t = firstVisible(this._flash.sel);
        if (t) this.place(t, false, false);
        else this.hide();
      }
    }
    if (now < this._remindAt || now - this._lastRemind < REMIND_GAP) return;
    if (modalOpen() || this.sim.placing || this.sim.paused) return;
    for (const rule of REMINDERS) {
      const r = this.safe(() => rule.test(this), null);
      if (!r) continue;
      const key = r.key || rule.id;
      const last = this._remindLog.get(key);
      if (last !== undefined && now - last < REMIND_REPEAT) continue;   // без повторов
      this._remindLog.set(key, now);
      this._lastRemind = now;
      this.hud.toast(r.text, r.type || 'info');
      if (r.target) this._flash = { sel: r.target, until: now + 4500 };
      return;
    }
  }
}

/* ПОДКЛЮЧЕНИЕ — вставить в app/src/main.js (три правки, всё остальное не трогать)

1) К импортам сверху:

     import { Coach } from './ui/coach.js';

2) После создания hud (рядом со строкой `const hud = new Hud(...)`):

     const coach = new Coach({ hud, renderer, audio });

   Симуляцию коуч берёт из hud.sim, поэтому новая игра и загрузка сейва
   подхватываются сами — передавать sim не нужно.

3) Заменить оба вызова maybeOnboard() (в newGame и в continueGame) на:

     coach.start();

   Саму функцию maybeOnboard можно оставить в файле — она больше не нужна,
   а coach.start() при запуске гасит её окно и ставит флаг frontier_coached,
   так что старые четыре окна не всплывут даже если вызов где-то остался.

Необязательно, но удобно для отладки и скриншотов:

   window.__frontier.coach = coach;         // coach.reset() — пройти заново
                                            // coach.skip()  — выключить обучение

   В блоке `if (location.hash.startsWith('#autostart'))` обучение само не
   стартует: там уже выставляется frontier_coached, а coach.start() оттуда
   не вызывается.

Что делает класс:
   coach.start()   — запустить (обучение или сразу напоминания, если пройдено)
   coach.skip()    — пропустить обучение целиком
   coach.stop()    — снять подсказки и остановить цикл
   coach.reset()   — сбросить прогресс и начать обучение заново
   coach.active    — идёт ли сейчас шаг обучения
*/
