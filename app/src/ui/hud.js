// ui/hud.js — весь DOM-интерфейс (presentation-слой).
import { RES, ERAS, TECHS, TECH_ERA_IDX, BUILDINGS, UNITS, TRAIN_COST, SPIRE_STAGES, OBJECTIVES, FACTIONS, WEATHER, SEASONS, GREAT_TYPES, ARMY_UPKEEP, TILE } from '../core/data.js';
import { DAY_SECONDS } from '../core/simulation.js';
import { QUALITY, QUALITY_ORDER } from '../render/quality.js';
import { FileSave } from '../save/saveSystem.js';
import { renderMarketPanel, bindMarketPanel, createMarketPanelState } from './panel_market.js';
import { PANELS, memoryPanel, mastersPanel, intelOf, intelTrustWord } from '../core/systems/integrate.js';

// Ядро не хранит скоростей добычи: производство размазано по жителям, погоде и
// разовым событиям дня, а еда вообще списывается одним куском на смене суток.
// Поэтому прирост считается здесь — наблюдением за складом. Это чистое чтение:
// симуляция про HUD по-прежнему не знает ничего.
const RATE_TAU = 2.5;      // постоянная сглаживания, игровых дней
const RATE_WARMUP = 0.3;   // до трети суток данных слишком мало даже для оценки
const DAYS_PER_MIN = 60 / DAY_SECONDS;  // игровых дней в минуте реального времени на 1×

const TABS = [
  { id: 'build', ru: 'Стройка', ic: '🏗' },
  { id: 'research', ru: 'Наука', ic: '📜' },
  { id: 'army', ru: 'Армия', ic: '⚔️' },
  { id: 'diplo', ru: 'Дипломатия', ic: '🤝' },
  { id: 'market', ru: 'Рынок', ic: '⚖️' },
  // Пять систем, которые были написаны и оттестированы, но игра их не звала.
  { id: 'people', ru: 'Народ', ic: '👥' },
  { id: 'industry', ru: 'Хозяйство', ic: '🏭' },
  { id: 'war', ru: 'Война', ic: '🛡' },
  { id: 'politics', ru: 'Держава', ic: '⚖' },
  { id: 'empire', ru: 'Города', ic: '🏛' },
  { id: 'labor', ru: 'Труд', ic: '👷' },
  { id: 'goals', ru: 'Цели', ic: '🎯' },
  // Летопись — не архив, а действующая механика: что народ помнит, тем и
  // живёт. Вкладка стоит рядом с журналом, но показывает не события, а
  // их ПОСЛЕДСТВИЯ — иначе игрок не поймёт, почему у него едят меньше.
  { id: 'memory', ru: 'Летопись', ic: '📜' },
  { id: 'log', ru: 'Журнал', ic: '📖' },
];

export class Hud {
  constructor(sim, renderer, saveSys, audio) {
    this.sim = sim;
    this.r = renderer;
    this.saveSys = saveSys;
    this.audio = audio;
    this.tab = 'build';
    this.marketState = createMarketPanelState();
    this.speed = 1;
    this.el = {};
    for (const id of ['topbar', 'rFood', 'rFoodDays', 'rWood', 'rStone', 'rSteel', 'rGold', 'rKnow', 'rPop', 'rIdle', 'rHappy', 'eraBadge', 'dateBox',
      'timeBox', 'toasts', 'alerts', 'tip', 'sidePanel', 'sideTabs', 'sideContent', 'sheet', 'sheetHandle', 'sheetTabs', 'sheetContent',
      'placeBar', 'placeOk', 'placeCancel', 'consoleBox', 'consoleOut', 'consoleIn', 'modalWrap', 'modalBox',
      'eraBanner', 'eraName', 'eraYears', 'victory', 'victoryStats', 'victoryChron', 'overlay', 'coach', 'overlayArt'])
      this.el[id] = document.getElementById(id);
    this._logRendered = 0;
    this._eraTapCount = 0;
    this._eraTapTimer = 0;
    // прирост ресурсов
    this._rateSim = null; this._rateAt = 0; this._rateAge = 0;
    this._rateEma = {}; this._ratePrev = {};
    this._ws = null;          // сводка по занятости жителей, считается раз за refresh
    this._alertsHtml = '';    // чтобы не трогать DOM, когда причины не изменились
    this._tipKey = '';
    this.fps = 0;
    this.menuTab = 'game';
  }

  bind(callbacks) {
    this.cb = callbacks;
    // вкладки ПК
    this.el.sideTabs.innerHTML = '';
    this.el.sheetTabs.innerHTML = '';
    for (const t of TABS) {
      const b1 = document.createElement('button');
      b1.textContent = t.ru; b1.dataset.tab = t.id;
      b1.onclick = () => { this.audio.play('click'); this.setTab(t.id); };
      this.el.sideTabs.appendChild(b1);
      const b2 = document.createElement('button');
      b2.innerHTML = `<span class="ic">${t.ic}</span>${t.ru}`;
      b2.dataset.tab = t.id;
      b2.onclick = () => { this.audio.play('click'); this.setTab(t.id); this.el.sheet.classList.add('open'); };
      this.el.sheetTabs.appendChild(b2);
    }
    // шит: свайп/тап
    this.el.sheetHandle.addEventListener('click', () => this.el.sheet.classList.toggle('open'));
    let sy = null;
    this.el.sheet.addEventListener('touchstart', e => { sy = e.touches[0].clientY; }, { passive: true });
    this.el.sheet.addEventListener('touchend', e => {
      if (sy === null) return;
      const dy = e.changedTouches[0].clientY - sy;
      if (dy < -40) this.el.sheet.classList.add('open');
      if (dy > 40) this.el.sheet.classList.remove('open');
      sy = null;
    }, { passive: true });
    // время
    this.el.timeBox.querySelectorAll('[data-speed]').forEach(b => {
      b.onclick = () => { this.audio.play('click'); this.setSpeed(+b.dataset.speed); };
    });
    document.getElementById('btnPause').onclick = () => { this.audio.play('click'); this.togglePause(); };
    document.getElementById('btnSound').onclick = (e) => { this.audio.toggleSfx(); this.audio.toggleMusic(); e.target.textContent = this.audio.enabled ? '🔊' : '🔇'; };
    document.getElementById('btnMenu').onclick = () => { this.audio.play('click'); this.showMenu(); };
    // стройка ✓/✗
    this.el.placeOk.onclick = () => { this.audio.play('click'); this.cb.confirmPlace(); };
    this.el.placeCancel.onclick = () => { this.audio.play('click'); this.cb.cancelPlace(); };
    // консоль
    this.el.consoleIn.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const out = this.sim.execCommand(this.el.consoleIn.value);
        this.el.consoleOut.textContent += `\n> ${this.el.consoleIn.value}\n${out}`;
        this.el.consoleOut.scrollTop = 1e6;
        this.el.consoleIn.value = '';
        e.stopPropagation();
      }
      e.stopPropagation();
    });
    // тройной тап по бейджу эпохи — консоль
    this.el.eraBadge.addEventListener('click', () => {
      this._eraTapCount++;
      clearTimeout(this._eraTapTimer);
      this._eraTapTimer = setTimeout(() => this._eraTapCount = 0, 600);
      if (this._eraTapCount >= 3) { this._eraTapCount = 0; this.toggleConsole(); }
    });
    // стартовый экран
    document.getElementById('btnNew').onclick = () => { this.audio.unlock(); this.audio.play('click'); this.showNewGame(); };
    document.getElementById('btnContinue').onclick = () => { this.audio.unlock(); this.audio.play('click'); this.cb.continueGame(); };
    document.getElementById('btnHow').onclick = () => { this.audio.unlock(); this.showHow(); };
    // победа
    document.getElementById('btnFreePlay').onclick = () => { this.audio.play('click'); this.el.victory.classList.remove('show'); this.sim.freePlay = true; };
    document.getElementById('btnNG').onclick = () => { this.audio.play('click'); location.reload(); };
    // модалка: закрытие по фону
    this.el.modalWrap.addEventListener('click', e => { if (e.target === this.el.modalWrap) this.closeModal(); });
    this.bindTips();
    this.startFpsMeter();
    this.setTab('build');
  }

  // ---------- всплывающие подсказки ----------
  // Панели перерисовываются 4 раза в секунду целиком (innerHTML), поэтому
  // слушать mouseenter на каждой карточке бесполезно: узел, с которого ушёл бы
  // курсор, к тому моменту уже не существует, и подсказка залипает навсегда.
  // Поэтому — делегирование от контейнера и разбор цели на каждом движении.
  bindTips() {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if (coarse) return;   // на тачах наведения нет, а палец закрывает подсказку собой
    const hosts = [this.el.sideContent, this.el.sheetContent, this.el.topbar];
    for (const host of hosts) {
      if (!host) continue;
      host.addEventListener('mousemove', e => {
        const t = e.target.closest && e.target.closest('[data-tipk]');
        if (!t) { this.hideTip(); return; }
        this.showTip(t.dataset.tipk, e.clientX, e.clientY);
      });
      host.addEventListener('mouseleave', () => this.hideTip());
    }
    window.addEventListener('pointerdown', () => this.hideTip());
    window.addEventListener('wheel', () => this.hideTip(), { passive: true });
  }

  showTip(key, x, y) {
    const el = this.el.tip;
    if (!el) return;
    if (key !== this._tipKey) {
      const html = this.tipHtml(key);
      if (!html) { this.hideTip(); return; }
      el.innerHTML = html;
      this._tipKey = key;
    }
    el.classList.add('show');
    // не вылезать за экран: у правого края панель шириной 320 и подсказка
    // иначе уезжала бы под неё
    const w = el.offsetWidth, h = el.offsetHeight;
    let px = x + 16, py = y + 16;
    if (px + w > window.innerWidth - 8) px = x - w - 16;
    if (py + h > window.innerHeight - 8) py = Math.max(8, y - h - 12);
    el.style.left = Math.max(8, px) + 'px';
    el.style.top = Math.max(8, py) + 'px';
  }

  hideTip() {
    if (!this.el.tip) return;
    this.el.tip.classList.remove('show');
    this._tipKey = '';
  }

  // Счётчик кадров нужен только вкладке «Графика»: без него игрок выбирает
  // пресет вслепую. Сам обработчик ничего не рисует и в DOM не лезет.
  startFpsMeter() {
    if (typeof requestAnimationFrame !== 'function') return;
    let frames = 0, t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const loop = (t) => {
      frames++;
      if (t - t0 >= 500) { this.fps = Math.round(frames * 1000 / (t - t0)); frames = 0; t0 = t; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  setTab(id) {
    this.tab = id;
    for (const b of this.el.sideTabs.children) b.classList.toggle('active', b.dataset.tab === id);
    for (const b of this.el.sheetTabs.children) b.classList.toggle('active', b.dataset.tab === id);
    this.renderPanel();
  }

  setSpeed(s) {
    this.speed = s;
    this.sim.paused = false;
    for (const b of this.el.timeBox.querySelectorAll('[data-speed]')) b.classList.toggle('active', +b.dataset.speed === s);
    document.getElementById('btnPause').classList.remove('active');
  }

  togglePause() {
    this.sim.paused = !this.sim.paused;
    document.getElementById('btnPause').classList.toggle('active', this.sim.paused);
    this.toast(this.sim.paused ? 'Пауза' : 'Продолжаем', 'info');
  }

  toggleConsole() { this.el.consoleBox.classList.toggle('show'); if (this.el.consoleBox.classList.contains('show')) this.el.consoleIn.focus(); }

  toast(text, type = 'info') {
    const d = document.createElement('div');
    d.className = `toast ${type}`;
    d.textContent = text;
    this.el.toasts.appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity 0.4s'; setTimeout(() => d.remove(), 400); }, 2800);
  }

  // ---------- прирост ресурсов ----------
  tickRates() {
    const s = this.sim;
    const now = s.day + s.dayTime;
    // новая партия, загруженный сейв или откат времени — начинаем замер заново
    if (this._rateSim !== s || now < this._rateAt) {
      this._rateSim = s; this._rateAt = now; this._rateAge = 0;
      this._rateEma = {}; this._ratePrev = {};
      for (const r of RES) { this._rateEma[r.id] = 0; this._ratePrev[r.id] = s.res[r.id] || 0; }
      return;
    }
    const dt = Math.min(0.5, now - this._rateAt);
    if (dt <= 0) return;   // пауза: время стоит, прирост не пересчитываем
    this._rateAt = now;
    this._rateAge += dt;
    for (const r of RES) {
      const v = s.res[r.id] || 0;
      const d = v - this._ratePrev[r.id];
      this._ratePrev[r.id] = v;
      // Сглаживание с постоянной 2.5 дня в ИГРОВОМ времени: разовая трата на
      // постройку (−20🪵) растворяется за пару дней и не врёт про добычу, а
      // еда, списываемая одним куском на смене суток, не даёт пилу в шапке.
      this._rateEma[r.id] += (d - this._rateEma[r.id] * dt) / RATE_TAU;
    }
  }

  // Прирост в игровой день или null, пока замер не набрал данных.
  // Сглаживание стартует с нуля и первые дни занижало бы любой прирост втрое —
  // поэтому делим на (1−e^−t/τ): та же поправка, что в Adam. Уже через треть
  // суток число честное, просто ещё шумное.
  rate(id) {
    if (this._rateAge < RATE_WARMUP) return null;
    const corr = 1 - Math.exp(-this._rateAge / RATE_TAU);
    return (this._rateEma[id] || 0) / Math.max(0.05, corr);
  }

  fmtRate(v) {
    if (v === null || v === undefined) return '—';
    const a = Math.abs(v);
    if (a < 0.05) return '0';
    return (v > 0 ? '+' : '−') + (a >= 10 ? Math.round(a) : a.toFixed(1));
  }

  rateHtml(id) {
    const v = this.rate(id);
    if (v === null) return '<i class="rate zero">·</i>';
    const cls = v > 0.05 ? 'up' : v < -0.05 ? 'dn' : 'zero';
    return `<i class="rate ${cls}">${this.fmtRate(v)}</i>`;
  }

  // ---------- занятость жителей ----------
  workerStats() {
    const s = this.sim;
    let work = 0, build = 0, gather = 0, idle = 0;
    // один проход по жителям: при 226 жителях и 55 зданиях вложенные циклы
    // стоили бы 12 тысяч сравнений четыре раза в секунду
    const taken = new Map();
    for (const v of s.villagers) {
      const k = v.target && v.target.kind;
      if (k === 'work') { work++; taken.set(v.target.b, (taken.get(v.target.b) || 0) + 1); }
      else if (k === 'build') build++;
      else if (k === 'hunt' || k === 'forage' || k === 'deadfall') gather++;
      else idle++;
    }
    let slots = 0, foodSlots = 0, foodTaken = 0;
    for (const b of s.doneBuildings()) {
      const def = BUILDINGS[b.id];
      if (!def.workers) continue;
      slots += def.workers;
      if (def.out && def.out.food) { foodSlots += def.workers; foodTaken += taken.get(b) || 0; }
    }
    return { pop: s.villagers.length, work, build, gather, idle, slots, foodSlots, free: Math.max(0, slots - work), freeFood: Math.max(0, foodSlots - foodTaken) };
  }

  // Сколько дней еды осталось при нынешнем балансе. Считается по измеренному
  // приросту, а не по формуле питания: так в числе уже учтены и урожай, и
  // содержание армии, и зима.
  foodDays() {
    const r = this.rate('food');
    if (r === null || r >= -0.02) return null;
    return this.sim.res.food / -r;
  }

  // Сколько дней копить недостающее по стоимости — по измеренному приросту.
  etaFor(cost) {
    const s = this.sim, m = s.costMult();
    let worst = 0;
    for (const [r, v] of Object.entries(cost || {})) {
      const need = Math.ceil(v * m) - (s.res[r] || 0);
      if (need <= 0) continue;
      const rt = this.rate(r);
      if (rt === null) return '';
      if (rt <= 0.05) return ' · само не накопится';
      worst = Math.max(worst, need / rt);
    }
    return worst > 0 ? ` · ~${Math.ceil(worst)} дн. ожидания` : '';
  }

  // ---------- «почему не хватает» ----------
  // Только то, что реально есть в состоянии симуляции: сезон, погода, штраф
  // после события, число зданий, свободные рабочие места, потолок склада.
  shortReason(id) {
    const s = this.sim;
    const w = this._ws || (this._ws = this.workerStats());
    const cap = s.resCap[id];
    if (cap && cap < 99999 && s.res[id] >= cap - 0.5) return 'склад полон — добыча уходит впустую';
    if (id === 'food') {
      if (s.farmPenaltyDays > 0) return `неурожай после события, ещё ${s.farmPenaltyDays} дн.`;
      const farms = s.countBuilding('farm');
      if (s.seasonIdx === 3 && farms > 0 && !s.hasBuilding('pasture')) return 'зима: фермы стоят, спасут пастбища или порт';
      const foodB = s.doneBuildings().some(b => (BUILDINGS[b.id].out || {}).food);
      if (!foodB) return 'нет ни одного здания еды — люди живут собирательством';
      if (w.freeFood > 0) return `пусто ${w.freeFood} рабочих мест на еде — не хватает рук`;
      if (WEATHER[s.weather].farm < 1) return `${WEATHER[s.weather].ru.toLowerCase()}: урожай ×${WEATHER[s.weather].farm}`;
      if (s.army.soldiers > 0) return `${w.pop} едоков и ${s.army.soldiers} бойцов (−${(s.army.soldiers * ARMY_UPKEEP.food).toFixed(1)}🍞/день) — полей мало`;
      return `${w.pop} едоков — полей на всех не хватает`;
    }
    // Голод перекрывает всё: assignJob уводит людей с любых не-едовых зданий,
    // и настоящая причина простоя производства — не отрасль, а пустой амбар.
    const starving = (() => { const d = this.foodDays(); return d !== null && d < 5; })();
    if (id === 'wood') {
      if (s.woodCrisis()) return 'дерево кончилось: жители собирают валежник, нужна лесопилка у леса';
      if (!s.doneBuildings().some(b => (BUILDINGS[b.id].out || {}).wood)) return 'нет лесопилки — дерево только тратится';
      if (starving) return 'все брошены на еду — лесопилки стоят';
      if (w.free > 0 && w.idle === 0) return 'рук не хватает на все рабочие места';
      return 'тратим быстрее, чем пилим';
    }
    if (id === 'stone' || id === 'steel') {
      const src = s.doneBuildings().some(b => (BUILDINGS[b.id].out || {})[id]);
      if (!src) return id === 'steel' ? 'нет кузницы или завода' : 'нет каменоломни или шахты';
      if (starving) return 'все брошены на еду — добыча стоит';
      const eater = s.doneBuildings().find(b => (BUILDINGS[b.id].consume || {})[id]);
      if (eater) return `${BUILDINGS[eater.id].name} потребляет ${id === 'stone' ? '🪨' : '⚙️'} быстрее, чем добываем`;
      return 'тратим быстрее, чем добываем';
    }
    if (id === 'gold') {
      if (s.army.soldiers > 0) return `содержание армии: −${(s.army.soldiers * ARMY_UPKEEP.gold).toFixed(1)}🪙/день`;
      return 'расходы обгоняют доход — нужен рынок или налоги';
    }
    if (id === 'knowledge') return 'знания уходят на технологии быстрее, чем копятся';
    return '';
  }

  // ---------- строка причин ----------
  alertList() {
    const s = this.sim;
    const w = this._ws || (this._ws = this.workerStats());
    const out = [];
    const days = this.foodDays();
    if (days !== null && days < 12) {
      const d = Math.max(0, Math.floor(days));
      out.push({ k: days < 5 ? 'bad' : 'warn', h: `🍞 Еда кончится через <b>${d} дн.</b> — ${this.shortReason('food')}` });
    } else if (s.res.food <= 0.5) {
      out.push({ k: 'bad', h: `🍞 <b>Голод.</b> Жители умирают — ${this.shortReason('food')}` });
    }
    if (s.woodCrisis()) out.push({ k: 'bad', h: '🪵 <b>Дерево кончилось.</b> Жители собирают валежник — стройте лесопилку вплотную к лесу' });
    const happy = s._happy ?? s.happiness();
    if (happy < 35) out.push({ k: 'bad', h: `😟 Счастье <b>${happy}%</b> — люди уходят из поселения` });
    if (w.pop >= s.housingCap()) out.push({ k: 'warn', h: `🏠 Жильё занято <b>${w.pop}/${s.housingCap()}</b> — новых жителей не будет` });
    if (w.idle >= 2) {
      out.push({ k: 'warn', h: w.free > 0
        ? `🧍 <b>${w.idle}</b> без дела, свободно ${w.free} рабочих мест — поднимите приоритет во вкладке «Труд»`
        : `🧍 <b>${w.idle}</b> без дела — рабочих мест больше нет, стройте производство` });
    }
    if (s.raids.warning) out.push({ k: 'bad', h: '⚔ <b>Враг близко</b> — удар в ближайшие 2 дня' });
    for (const r of RES) {
      const cap = s.resCap[r.id];
      if (cap && cap < 99999 && s.res[r.id] >= cap - 0.5 && (this.rate(r.id) || 0) >= 0)
        out.push({ k: 'info', h: `${r.icon} Склад полон (${cap}) — добыча уходит впустую, нужен склад` });
    }
    return out.slice(0, 3);
  }

  refreshAlerts() {
    const box = this.el.alerts;
    if (!box) return;
    // При постановке здания подсказки на телефоне лежат ровно под кнопками ✓/✗
    if (this.sim.placing) { box.classList.add('hide'); return; }
    const html = this.alertList().map(a => `<div class="alert ${a.k}">${a.h}</div>`).join('');
    box.classList.toggle('hide', !html);
    if (html !== this._alertsHtml) { this._alertsHtml = html; box.innerHTML = html; }
  }

  // ---------- верхняя полоса ----------
  refresh() {
    const s = this.sim;
    this.tickRates();
    this._ws = this.workerStats();
    // Знаменатель показывается у всех ограниченных ресурсов, а не только у еды:
    // без него игрок не понимал, почему лесопилка работает, а дерево стоит.
    // На потолке число подсвечивается — это сигнал строить склад.
    const cap = (id, icon) => {
      const v = Math.floor(s.res[id]), m = s.resCap[id];
      const rate = this.rateHtml(id);
      if (!m || m >= 99999) return `${icon} <b>${v}</b>${rate}`;
      const full = v >= m - 0.5;
      return `${icon} <b${full ? ' style="color:var(--warn)"' : ''}>${v}</b><small>/${m}</small>${rate}`;
    };
    this.el.rFood.innerHTML = cap('food', '🍞');
    this.el.rWood.innerHTML = cap('wood', '🪵');
    this.el.rStone.innerHTML = cap('stone', '🪨');
    this.el.rSteel.innerHTML = cap('steel', '⚙️');
    this.el.rGold.innerHTML = `🪙 <b>${Math.floor(s.res.gold)}</b>${this.rateHtml('gold')}`;
    this.el.rKnow.innerHTML = `📜 <b>${Math.floor(s.res.knowledge)}</b>${this.rateHtml('knowledge')}`;
    this.el.rPop.innerHTML = `👥 <b>${s.villagers.length}</b><small>/${s.housingCap()}</small>`;
    const happy = s.happiness();
    this.el.rHappy.innerHTML = `${happy >= 70 ? '😊' : happy >= 40 ? '😐' : '😟'} <b>${happy}%</b>`;
    // Запас еды в днях — главное число ранней игры. Ниже пяти дней чип краснеет
    // и пульсирует: это последний момент, когда голод ещё можно предотвратить.
    const fd = this.foodDays();
    const w = this._ws;
    if (fd === null) {
      const fr = this.rate('food');
      const full = s.res.food >= s.resCap.food - 0.5;
      const word = fr === null ? ' считаем…' : full ? ' склад полон' : fr > 0.05 ? ' запас растёт' : ' расход ≈ приход';
      this.el.rFoodDays.innerHTML = `⏳ <b>${fr === null ? '—' : '∞'}</b><small class="wide">${word}</small>`;
      this.el.rFoodDays.className = 'res';
    } else {
      const d = Math.floor(fd);
      this.el.rFoodDays.innerHTML = `⏳ <b>${d}</b><small> дн.<span class="wide"> еды</span></small>`;
      this.el.rFoodDays.className = 'res' + (d < 5 ? ' res-bad' : d < 12 ? ' res-warn' : '');
    }
    this.el.rFood.className = 'res' + (fd !== null && fd < 5 ? ' res-bad' : '');
    this.el.rIdle.innerHTML = `🧍 <b>${w.idle}</b><small><span class="wide"> без дела</span>${w.free ? ` · ${w.free} мест` : ''}</small>`;
    this.el.rIdle.className = 'res' + (w.idle >= 2 && w.free > 0 ? ' res-warn' : '');
    this.refreshAlerts();
    const era = ERAS[s.eraIndex];
    this.el.eraBadge.textContent = era.ru;
    this.el.eraBadge.style.borderColor = era.hue;
    const year = Math.floor(s.day / 100) + 1;
    this.el.dateBox.textContent = `Год ${year} · ${SEASONS[s.seasonIdx]} · ${WEATHER[s.weather].ru} · день ${s.day}`;
    // тосты из симуляции
    for (const t of s.toasts) {
      if (!t._shown) { t._shown = true; this.toast(t.text, t.type); }
    }
    // баннер эпохи
    if (s.newEra !== null) { this.showEraBanner(s.newEra); s.newEra = null; }
    // событие с выбором
    if (s.pendingEvent && !this._eventShown) { this._eventShown = true; this.showEvent(s.pendingEvent); }
    if (!s.pendingEvent) this._eventShown = false;
    // великий человек
    if (s.pendingGreat && !this._greatShown) { this._greatShown = true; this.showGreat(s.pendingGreat); }
    if (!s.pendingGreat) this._greatShown = false;
    // победа
    if (s.won && !this._victoryShown) { this._victoryShown = true; this.showVictory(); }
    if (!s.won) this._victoryShown = false;
    // панель
    this.renderPanel();
  }

  showEraBanner(idx) {
    const era = ERAS[idx];
    this.el.eraName.textContent = era.ru;
    this.el.eraYears.textContent = era.years;
    this.el.eraBanner.classList.remove('show');
    void this.el.eraBanner.offsetWidth;
    this.el.eraBanner.classList.add('show');
    this.audio.play('era');
  }

  // ---------- панели ----------
  renderPanel() {
    const html = this['panel_' + this.tab]();
    this.el.sideContent.innerHTML = html;
    this.el.sheetContent.innerHTML = html;
    this.bindPanel(this.el.sideContent);
    this.bindPanel(this.el.sheetContent);
  }

  bindPanel(root) {
    root.querySelectorAll('[data-build]').forEach(c => {
      c.onclick = () => { this.cb.startPlacing(c.dataset.build); };
    });
    root.querySelectorAll('[data-tech]').forEach(c => {
      c.onclick = () => {
        const r = this.sim.research(c.dataset.tech);
        if (!r.ok) { this.toast(r.reason, 'warn'); this.audio.play('deny'); }
        else { this.audio.play('tech'); this.toast(`Изучено: ${c.querySelector('.ttl span').textContent}`, 'good'); }
        this.renderPanel();
      };
    });
    root.querySelectorAll('[data-train]').forEach(c => {
      c.onclick = () => {
        const r = this.sim.trainSoldier();
        if (!r.ok) { this.toast(r.reason, 'warn'); this.audio.play('deny'); }
        else this.audio.play('click');
        this.renderPanel();
      };
    });
    root.querySelectorAll('[data-diplo]').forEach(c => {
      c.onclick = () => this.showFaction(c.dataset.diplo);
    });
    root.querySelectorAll('[data-labor]').forEach(c => {
      c.onclick = () => {
        const [k, d] = c.dataset.labor.split(':');
        this.sim.labor[k] = Math.max(1, Math.min(4, this.sim.labor[k] + (+d)));
        this.audio.play('click');
        this.renderPanel();
      };
    });
    root.querySelectorAll('[data-spire-invest]').forEach(c => {
      c.onclick = () => {
        const r = this.sim.investSpire();
        if (!r.ok) { this.toast(r.reason, 'warn'); this.audio.play('deny'); } else this.audio.play('coin');
        this.renderPanel();
      };
    });
    root.querySelectorAll('[data-mission]').forEach(c => {
      c.onclick = () => {
        const r = this.sim.startMission(c.dataset.mission);
        if (!r.ok) { this.toast(r.reason, 'warn'); this.audio.play('deny'); } else this.toast('Миссия запущена!', 'good');
        this.renderPanel();
      };
    });
    root.querySelectorAll('[data-sell]').forEach(c => {
      c.onclick = () => {
        const r = this.sim.marketSell(c.dataset.sell, 20);
        if (!r.ok) { this.toast(r.reason, 'warn'); this.audio.play('deny'); } else this.audio.play('coin');
        this.renderPanel();
      };
    });
    root.querySelectorAll('[data-buy]').forEach(c => {
      c.onclick = () => {
        const r = this.sim.marketBuy(c.dataset.buy, 20);
        if (!r.ok) { this.toast(r.reason, 'warn'); this.audio.play('deny'); } else this.audio.play('coin');
        this.renderPanel();
      };
    });
    // Панель рынка держит собственный атрибут data-market: если бы она пользовалась
    // data-sell/data-buy выше, тамошний c.onclick затёр бы её обработчик и любая
    // кнопка продавала бы ровно 20 единиц вместо выбранного лота.
    bindMarketPanel(root, this.sim, {
      toast: (t, k) => this.toast(t, k),
      audio: this.audio,
      refresh: () => this.renderPanel(),
    });
    // Экраны новых систем: у каждого свои data-атрибуты, пересечься не могут.
    const panelCtx = {
      toast: (t, k) => this.toast(t, k),
      audio: this.audio,
      refresh: () => this.renderPanel(),
    };
    for (const p of Object.values(PANELS)) {
      if (p.bind) { try { p.bind(root, this.sim, panelCtx); } catch { /* панель не активна */ } }
    }
  }

  // ---------- содержимое подсказок ----------
  tipHtml(key) {
    const i = key.indexOf(':');
    const kind = key.slice(0, i), id = key.slice(i + 1);
    if (kind === 'r') return this.tipRes(id);
    if (kind === 'days') return this.tipFood();
    if (kind === 'idle') return this.tipIdle();
    if (kind === 'pop') return this.tipPop();
    if (kind === 'happy') return this.tipHappy();
    if (kind === 'b') return this.tipBuilding(id);
    if (kind === 't') return this.tipTech(id);
    return '';
  }

  tipRow(a, b) { return `<div class="t-row"><span>${a}</span><b>${b}</b></div>`; }

  num(v) { return Number.isInteger(v) ? String(v) : String(+v.toFixed(1)); }

  // «за минуту» — та же скорость, пересчитанная в реальное время текущего темпа
  perMin(v) { return `${this.fmtRate(v * DAYS_PER_MIN * this.speed)} в минуту на ${this.speed}×`; }

  // кто в поселении даёт этот ресурс — по построенным зданиям, без выдумок
  sourcesOf(id) {
    const count = new Map();
    for (const b of this.sim.doneBuildings()) {
      const def = BUILDINGS[b.id];
      if (def.out && def.out[id]) count.set(def.name, (count.get(def.name) || 0) + 1);
    }
    return [...count].map(([n, c]) => `${n}${c > 1 ? ' ×' + c : ''}`).join(', ');
  }

  tipRes(id) {
    const s = this.sim, meta = RES.find(r => r.id === id);
    const capV = s.resCap[id];
    const v = this.rate(id);
    let h = `<h5>${meta.icon} ${meta.ru}</h5>`;
    h += this.tipRow('Сейчас', `${Math.floor(s.res[id])}${capV && capV < 99999 ? ' / ' + capV : ''}`);
    h += this.tipRow('Прирост', v === null ? 'считаем…' : `${this.fmtRate(v)} в игровой день`);
    if (v !== null) h += `<div class="t-note">≈ ${this.perMin(v)}</div>`;
    const src = this.sourcesOf(id);
    if (src) h += this.tipRow('Дают', src);
    if (id === 'food') {
      const d = this.foodDays();
      if (d !== null) h += this.tipRow('Хватит на', `${Math.floor(d)} дн.`);
      if (s.army.soldiers > 0) h += this.tipRow('Ест армия', `−${(s.army.soldiers * ARMY_UPKEEP.food).toFixed(1)}/день`);
    }
    const why = (v !== null && v < -0.02) || (capV && capV < 99999 && s.res[id] >= capV - 0.5) ? this.shortReason(id) : '';
    if (why) h += `<div class="t-bad">Почему: ${why}</div>`;
    return h;
  }

  tipFood() {
    const s = this.sim, w = this._ws || this.workerStats();
    const d = this.foodDays(), v = this.rate('food');
    let h = `<h5>⏳ Запас еды</h5>`;
    h += this.tipRow('На складе', `${Math.floor(s.res.food)} / ${s.resCap.food}`);
    h += this.tipRow('Баланс', v === null ? 'считаем…' : `${this.fmtRate(v)} в день`);
    h += this.tipRow('Хватит на', d !== null ? `${Math.floor(d)} дн.` : v === null ? 'считаем…' : v > 0.05 ? 'запас растёт' : 'расход ≈ приход');
    h += this.tipRow('Мест на еде', !w.foodSlots ? 'зданий еды нет' : w.freeFood ? `свободно ${w.freeFood} из ${w.foodSlots}` : `все ${w.foodSlots} заняты`);
    h += this.tipRow('Сезон', `${SEASONS[s.seasonIdx]}, ${WEATHER[s.weather].ru.toLowerCase()} (урожай ×${WEATHER[s.weather].farm})`);
    if (d !== null && d < 5) h += `<div class="t-bad">Осталось меньше пяти дней. Причина: ${this.shortReason('food')}</div>`;
    else if (v !== null && v < 0) h += `<div class="t-note">Причина убыли: ${this.shortReason('food')}</div>`;
    return h;
  }

  tipIdle() {
    const w = this._ws || this.workerStats();
    let h = `<h5>🧍 Занятость жителей</h5>`;
    h += this.tipRow('На рабочих местах', `${w.work} из ${w.slots}`);
    h += this.tipRow('На стройке', w.build);
    h += this.tipRow('Промысел и охота', w.gather);
    h += this.tipRow('Без дела', w.idle);
    h += `<div class="t-sep"></div>`;
    h += this.tipRow('Свободных мест', w.free);
    h += `<div class="t-note">${w.idle > 0 && w.free > 0
      ? 'Руки есть, но до мест не дошли: проверьте приоритеты во вкладке «Труд».'
      : w.free > 0 ? 'Мест больше, чем людей — нужны жители: жильё и еда.'
      : 'Все места заняты. Новое производство даст новые места.'}</div>`;
    return h;
  }

  tipPop() {
    const s = this.sim, w = this._ws || this.workerStats();
    let h = `<h5>👥 Население</h5>`;
    h += this.tipRow('Жителей', w.pop);
    h += this.tipRow('Жильё', s.housingCap());
    h += this.tipRow('Бойцов', `${s.army.soldiers} / ${s.armyLimit()}`);
    h += `<div class="t-note">Рождения идут, пока есть свободное жильё, запас еды и счастье выше среднего.</div>`;
    if (w.pop >= s.housingCap()) h += `<div class="t-bad">Жильё занято полностью — стройте хижины и дома.</div>`;
    return h;
  }

  tipHappy() {
    const s = this.sim;
    let fromB = 0;
    for (const b of s.doneBuildings()) fromB += BUILDINGS[b.id].happy || 0;
    const happy = s._happy ?? s.happiness();
    let h = `<h5>😊 Настроение: ${happy}%</h5>`;
    h += this.tipRow('От зданий', `${fromB >= 0 ? '+' : ''}${fromB}`);
    h += this.tipRow('Погода', `${WEATHER[s.weather].happy >= 0 ? '+' : ''}${WEATHER[s.weather].happy} (${WEATHER[s.weather].ru.toLowerCase()})`);
    if (s.villagers.length > s.housingCap()) h += `<div class="t-bad">Жителей больше, чем жилья — теснота бьёт по настроению.</div>`;
    if (s.res.food <= 0) h += `<div class="t-bad">Склад еды пуст.</div>`;
    if (happy < 35) h += `<div class="t-bad">Ниже 35% жители начинают уходить, а работа идёт медленнее.</div>`;
    return h;
  }

  // Что здание даёт, что требует и почему сейчас недоступно — всё из BUILDINGS
  // и текущего состояния, ничего придуманного.
  tipBuilding(id) {
    const s = this.sim, def = BUILDINGS[id];
    if (!def) return '';
    let h = `<h5>${def.name}</h5><div class="t-note" style="margin:0 0 6px">${def.desc}</div>`;
    if (def.out) {
      for (const [r, v] of Object.entries(def.out)) {
        const meta = RES.find(q => q.id === r);
        h += this.tipRow('Даёт', `${meta.icon} ${this.num(v)} в день с рабочего`);
        if (def.workers) h += this.tipRow('Полным штатом', `${meta.icon} ${this.num(v * def.workers)} в день`);
      }
    }
    if (def.consume) h += this.tipRow('Потребляет', Object.entries(def.consume).map(([r, v]) => `${RES.find(q => q.id === r)?.icon || r}${v}/день`).join(' '));
    if (def.housing) h += this.tipRow('Жильё', `${def.housing} жителей`);
    if (def.happy) h += this.tipRow('Счастье', `+${def.happy}`);
    if (def.defense) h += this.tipRow('Оборона', `+${def.defense}`);
    if (def.cap) h += this.tipRow('Склад', Object.entries(def.cap).map(([r, v]) => `+${v} ${RES.find(q => q.id === r)?.icon || r}`).join(' '));
    if (def.workers) h += this.tipRow('Рабочих мест', def.workers);
    h += `<div class="t-sep"></div>`;
    h += this.tipRow('Стоит', this.costStr(def.cost));
    h += this.tipRow('Стройка', `~${s.buildDays(def).toFixed(1)} дн. полной бригадой`);
    if (def.req) h += this.tipRow('Технология', TECHS.find(t => t.id === def.req).name);
    const place = def.needTile === TILE.FOREST ? 'вплотную к лесу'
      : def.needTile === TILE.HILL ? 'вплотную к холму'
      : def.needTile === TILE.MOUNTAIN ? 'вплотную к горе'
      : def.needTile === TILE.GRASS ? 'на травяном лугу'
      : def.coast ? 'на берегу, рядом с водой' : '';
    if (place) h += this.tipRow('Место', place);
    if (def.unique) h += this.tipRow('Ограничение', 'можно только одно');
    const built = s.doneBuildings().filter(b => b.id === id).length;
    if (built) h += this.tipRow('Уже построено', built);
    // почему нельзя прямо сейчас
    if (def.req && !s.techs.has(def.req)) h += `<div class="t-bad">Сейчас нельзя: не открыта технология «${TECHS.find(t => t.id === def.req).name}».</div>`;
    else if (def.unique && s.buildings.some(b => b.id === id && !b.destroyed)) h += `<div class="t-bad">Сейчас нельзя: такое здание уже есть.</div>`;
    else {
      const lack = s.lackCost(def.cost);
      if (lack) h += `<div class="t-bad">Сейчас нельзя: не хватает ${lack}.</div>`;
      else h += `<div class="t-good">Можно строить — выберите место на карте.</div>`;
    }
    return h;
  }

  tipTech(id) {
    const s = this.sim, t = TECHS.find(q => q.id === id);
    if (!t) return '';
    const cost = s.techCost(t);
    let h = `<h5>${t.name}</h5><div class="t-note" style="margin:0 0 6px">${t.effect}</div>`;
    h += this.tipRow('Стоит', `📜 ${cost}${cost < t.cost ? ` (было ${t.cost}, скидка от соседей)` : ''}`);
    h += this.tipRow('Есть знаний', Math.floor(s.res.knowledge));
    if (t.era) h += this.tipRow('Открывает эпоху', ERAS.find(e => e.id === t.era)?.ru || t.era);
    const opens = Object.entries(BUILDINGS).filter(([, d]) => d.req === id).map(([, d]) => d.name);
    if (opens.length) h += this.tipRow('Даёт здания', opens.join(', '));
    const units = UNITS.filter(u => u.req === id).map(u => u.name);
    if (units.length) h += this.tipRow('Даёт войска', units.join(', '));
    const missing = t.prereq.filter(p => !s.techs.has(p));
    if (s.techs.has(id)) h += `<div class="t-good">Уже изучено.</div>`;
    else if (missing.length) h += `<div class="t-bad">Сейчас нельзя: сначала ${missing.map(m => TECHS.find(q => q.id === m).name).join(', ')}.</div>`;
    else if (s.res.knowledge < cost) {
      const kr = this.rate('knowledge');
      const eta = kr && kr > 0.05 ? ` — при нынешнем темпе ~${Math.ceil((cost - s.res.knowledge) / kr)} дн.` : '';
      h += `<div class="t-bad">Сейчас нельзя: не хватает 📜${Math.ceil(cost - s.res.knowledge)}${eta}.</div>`;
    } else h += `<div class="t-good">Можно изучать.</div>`;
    return h;
  }

  costStr(cost) {
    return Object.entries(cost || {}).map(([r, v]) => {
      const meta = RES.find(q => q.id === r);
      return `${meta ? meta.icon : r}${Math.ceil(v * this.sim.costMult())}`;
    }).join(' ') || '—';
  }

  panel_build() {
    const s = this.sim;
    let html = '';
    let lastEra = -1;
    for (const [id, def] of Object.entries(BUILDINGS)) {
      const eraIdx = Math.max(0, Object.keys(TECHS).length ? (id in BUILDINGS ? (def.req ? TECH_ERA_IDX[def.req] ?? 0 : 0) : 0) : 0);
      if (eraIdx !== lastEra) { lastEra = eraIdx; html += `<h4 class="group">${ERAS[eraIdx].ru}</h4>`; }
      const locked = def.req && !s.techs.has(def.req);
      const lack = s.lackCost(def.cost);
      const built = def.unique && s.buildings.some(b => b.id === id && !b.destroyed);
      let reason = '';
      if (locked) reason = `Нужна технология: ${TECHS.find(t => t.id === def.req).name}`;
      else if (built) reason = 'Уже построено';
      else if (lack) reason = `Не хватает: ${lack}${this.etaFor(def.cost)}`;
      const dis = locked || built || lack;
      html += `<div class="card ${dis ? 'disabled' : ''}" data-tipk="b:${id}" ${!locked && !built ? `data-build="${id}"` : ''}>
        <div class="ttl"><span>${def.name}</span><span class="cost">${this.costStr(def.cost)}</span></div>
        <div class="desc">${def.desc}</div>
        ${reason ? `<div class="reason">${reason}</div>` : ''}
      </div>`;
    }
    return html;
  }

  panel_research() {
    const s = this.sim;
    let html = '';
    let lastEra = -1;
    for (const t of TECHS) {
      const e = TECH_ERA_IDX[t.id] ?? 0;
      if (e !== lastEra) { lastEra = e; html += `<h4 class="group">${ERAS[e].ru}</h4>`; }
      const has = s.techs.has(t.id);
      const cost = s.techCost(t);
      const missing = t.prereq.filter(p => !s.techs.has(p));
      const afford = s.res.knowledge >= cost;
      let reason = '';
      if (has) reason = '';
      else if (missing.length) reason = `Требует: ${missing.map(m => TECHS.find(q => q.id === m).name).join(', ')}`;
      else if (!afford) reason = `Нужно 📜${cost} (есть ${Math.floor(s.res.knowledge)})`;
      // скидка диффузии
      let diff = '';
      if (!has && cost < t.cost) diff = `<div class="desc" style="color:var(--good)">Известна соседям: −${Math.round((1 - cost / t.cost) * 100)}%</div>`;
      html += `<div class="card ${has ? 'done-card' : (reason ? 'disabled' : '')}" data-tipk="t:${t.id}" ${!has && !missing.length ? `data-tech="${t.id}"` : ''}>
        <div class="ttl"><span>${has ? '✓ ' : ''}${t.name}${t.era ? ' ⚡' : ''}</span><span class="cost">${has ? '' : '📜' + cost}</span></div>
        <div class="desc">${t.effect}</div>${diff}
        ${reason ? `<div class="reason">${reason}</div>` : ''}
      </div>`;
    }
    return html;
  }

  panel_army() {
    const s = this.sim;
    const unit = s.bestUnit();
    const threat = Math.round(s.threatPoints() / 10);
    const atWar = s.wars.length > 0;
    let html = `<div class="card"><div class="ttl"><span>Сила армии</span><span>${Math.round(s.armyPower())}</span></div>
      <div class="desc">Бойцов: ${s.army.soldiers}/${s.armyLimit()} · Тип: ${unit.name} (сила ${unit.power + s.army.powerBonus})</div>
      <div class="desc">Оборона стен: ${s.defensePower()} · Ожидаемая волна: ~${threat}</div>
      <div class="desc">${s.raids.off ? 'Рейды выключены' : s.raids.warning ? '⚠ ВРАГ БЛИЗКО — до удара ≤2 дней!' : `До рейда ~${s.raids.timer} дн.`}</div></div>`;
    if (s.army.trainQueue > 0) html += `<div class="card"><div class="ttl"><span>Обучение</span><span>${s.army.trainQueue} в очереди</span></div><div class="desc">Прогресс: ${Math.round(s.army.trainProgress / 4 * 100)}%</div></div>`;
    html += `<div class="card" data-train="1"><div class="ttl"><span>⚔️ Обучить бойца</span><span class="cost">${TRAIN_COST.food}🍞 ${TRAIN_COST.gold}🪙</span></div>
      <div class="desc">${s.hasBuilding('barracks') ? 'Казарма готова обучать.' : '⚠ Нужна Казарма (Военное дело).'} Содержание: 0.5🍞+0.2🪙/день.</div></div>`;
    html += `<h4 class="group">Линейка юнитов</h4>`;
    for (const u of UNITS) {
      const has = s.techs.has(u.req);
      html += `<div class="card ${has ? '' : 'disabled'}"><div class="ttl"><span>${has ? '✓ ' : ''}${u.name}</span><span class="cost">сила ${u.power}</span></div>
        ${!has ? `<div class="reason">Нужна технология: ${TECHS.find(t => t.id === u.req).name}</div>` : ''}</div>`;
    }
    return html;
  }

  panel_diplo() {
    const s = this.sim;
    if (!s.factions.length) return '<div class="card"><div class="desc">Вы одни в этом мире.</div></div>';
    let html = '';
    for (const f of s.factions) {
      if (!f.alive) continue;
      const R = Math.round(s.relations[f.id]);
      const status = s.wars.some(w => w.fid === f.id) ? '⚔ ВОЙНА' : R >= 60 ? 'Союз' : R >= 20 ? 'Дружелюбие' : R > -20 ? 'Нейтралитет' : R > -40 ? 'Напряжённость' : 'Вражда';
      const col = R >= 20 ? 'var(--good)' : R > -20 ? 'var(--warn)' : 'var(--bad)';
      const treaty = s.treaties.some(t => t.b === f.id) ? ' · 📜 договор' : '';
      html += `<div class="card" data-diplo="${f.id}">
        <div class="ttl"><span><span style="color:${f.def.color}">⬤</span> ${f.def.name}</span><span style="color:${col}">${R}</span></div>
        <div class="desc">${f.def.leader} · ${ERAS[f.era].ru} · ${status}${treaty}</div>
        <div class="relbar"><div style="width:${(R + 100) / 2}%;background:${col}"></div></div>
      </div>`;
    }
    return html;
  }

  panel_labor() {
    const s = this.sim;
    const rows = [['food', '🍞 Еда'], ['wood', '🪵 Дерево'], ['stone', '🪨 Камень/золото'], ['science', '📜 Наука'], ['build', '🏗 Стройка']];
    let html = `<div class="card"><div class="desc">Приоритеты 1–4: свободные жители сначала занимают места в отрасли с высшим приоритетом. При голоде еда форсируется автоматически.</div></div>`;
    for (const [k, ru] of rows) {
      const p = s.labor[k];
      html += `<div class="card"><div class="ttl"><span>${ru}</span><span>${'●'.repeat(p)}${'○'.repeat(4 - p)}</span></div>
        <div class="btns" style="display:flex;gap:8px;margin-top:8px">
          <button class="btn" style="flex:1;padding:8px" data-labor="${k}:-1">−</button>
          <button class="btn" style="flex:1;padding:8px" data-labor="${k}:1">+</button>
        </div></div>`;
    }
    return html;
  }

  panel_goals() {
    const list = this.sim.objectives();
    const firstOpen = list.findIndex(o => !o.done);
    let html = '';
    list.forEach((o, i) => {
      html += `<div class="obj ${o.done ? 'done' : i === firstOpen ? 'current' : ''}">
        <span class="mark">${o.done ? '✓' : i === firstOpen ? '▶' : '○'}</span><span>${o.text}</span></div>`;
    });
    // шпиль-статус
    const sp = this.sim.spireStageStatus();
    if (this.sim.buildings.some(b => b.id === 'spire' && !b.destroyed) && !sp.done) {
      const invStr = Object.entries(sp.cost).map(([r, v]) => {
        const inv = sp.inv[r] || 0;
        const meta = RES.find(q => q.id === r);
        return `${meta.icon}${inv}/${v}`;
      }).join(' ');
      html += `<h4 class="group">Шпиль: стадия ${sp.stage + 1}/5 «${sp.name}»</h4>
        <div class="card"><div class="desc">Вложено: ${invStr}</div>
        <div class="desc">${sp.paid ? `Строится: ${Math.round(sp.progress)}/${sp.days} дн.` : 'Вложите ресурсы, чтобы начать стройку.'}</div>
        <button class="btn primary" style="width:100%;margin-top:8px" data-spire-invest="1">Вложить ресурсы</button></div>`;
    }
    if (this.sim.hasBuilding('spaceport')) {
      html += `<h4 class="group">Космопорт</h4><div class="card">
        ${this.sim.mission ? `<div class="desc">Миссия «${this.sim.mission.type === 'moon' ? 'Луна' : 'Марс'}»: осталось ${Math.ceil(this.sim.mission.daysLeft)} дн.</div>` :
          `<button class="btn" style="width:100%;margin-bottom:6px" data-mission="moon" ${this.sim.moonDone ? 'disabled' : ''}>🌙 Луна (30д → +2000🪙)</button>
           <button class="btn" style="width:100%" data-mission="mars" ${this.sim.marsDone ? 'disabled' : ''}>🚀 Марс (60д → +3000📜)</button>`}
      </div>`;
    }
    return html;
  }

  panel_market() { return renderMarketPanel(this.sim, this.marketState); }
  panel_people() {
    // К списку жителей добавляем мастеров: без этого игрок не узнает, что
    // конкретный человек стоит половины выпуска кузницы, и не поймёт, почему
    // после набега производство просело больше, чем на одного работника.
    const rows = mastersPanel(this.sim);
    if (!rows.length) return PANELS.people.render(this.sim);
    const list = rows.map(r => {
      const pct = Math.round(r.level * 100);
      const risk = Math.round(r.atRisk * 100);
      return `<div class="mem-row">
        <div class="mem-head"><b>${r.ru}</b><span style="color:var(--dim)">умение ${pct}%</span></div>
        <div class="mem-bar"><i style="width:${pct}%;background:${r.safe ? 'var(--good)' : 'var(--warn, #d9a06a)'}"></i></div>
        <div class="mem-txt">Мастер: ${r.master || '—'}${r.years >= 1 ? ` · у дела ${Math.floor(r.years)} г.` : ''}<br>
          ${r.apprentice
            ? `Ученик: ${r.apprentice} — ремесло переживёт мастера (потеря ${risk}%).`
            : `<b style="color:var(--bad)">Ученика нет.</b> Если мастер погибнет, умение упадёт на ${risk}%.`}</div>
      </div>`;
    }).join('');
    return PANELS.people.render(this.sim)
      + `<div class="sec">Ремесло и мастера</div>${list}`;
  }
  panel_industry() { return PANELS.industry.render(this.sim); }
  panel_war()      { return PANELS.war.render(this.sim); }
  panel_politics() { return PANELS.politics.render(this.sim); }
  panel_empire()   { return PANELS.empire.render(this.sim); }

  panel_memory() {
    const s = this.sim;
    const b = memoryPanel(s);
    const rows = b.rows.length ? b.rows.map(r => {
      // Полоса силы: игрок должен видеть не только «помнят», но и насколько.
      const w = Math.min(100, Math.round(r.v / 2 * 100));
      const col = r.kind === 'triumph' ? 'var(--good)' : 'var(--bad)';
      return `<div class="mem-row">
        <div class="mem-head"><b>${r.ru}</b>
          <span style="color:var(--dim)">${r.years < 1 ? 'в этом году' : `${Math.floor(r.years)} г. назад`}</span></div>
        <div class="mem-bar"><i style="width:${w}%;background:${col}"></i></div>
        <div class="mem-txt">${r.text}</div>
      </div>`;
    }).join('') : `<div class="mem-txt">${b.text}</div>`;

    // Во что память обходится прямо сейчас — числами, а не словами: это и есть
    // ответ на вопрос «почему у меня столько уходит еды».
    const L = s.sys && s.sys.memLinks;
    const eff = [];
    if (L) {
      if (L.mods.eatMult !== 1) eff.push(`расход еды ×${L.mods.eatMult.toFixed(2)}`);
      if (L.mods.woodBurnMult !== 1) eff.push(`дрова ×${L.mods.woodBurnMult.toFixed(2)}`);
      if (Math.abs(L.mods.happy) > 0.05) eff.push(`счастье ${L.mods.happy > 0 ? '+' : ''}${L.mods.happy.toFixed(1)}`);
      if (Math.abs(L.mods.stability) > 0.005) eff.push(`порядок ${L.mods.stability > 0 ? '+' : ''}${L.mods.stability.toFixed(2)}/день`);
    }

    const chron = [...s.chronicle].reverse().slice(0, 40).map(c =>
      `<div><span class="l-day">[год ${Math.floor(c.day / 100) + 1}]</span> ${c.text}</div>`).join('')
      || '<div style="color:var(--dim)">Пока ничего не записано.</div>';

    return `<div class="sec">Что помнит народ</div>
      ${rows}
      ${eff.length ? `<div class="mem-eff">Сегодня это стоит: ${eff.join(' · ')}</div>` : ''}
      <div class="mem-eff" style="color:var(--dim)">Забывание идёт ×${b.healRate} — сытые и спокойные годы стирают память быстрее.</div>
      <div class="sec">Летопись</div>
      <div id="chronList">${chron}</div>`;
  }

  panel_log() {
    const items = [...this.sim.log].reverse();
    return `<div id="logList">` + items.map(l =>
      `<div><span class="l-day">[д.${l.day}]</span> <span class="l-${l.type}">${l.text}</span></div>`).join('') + `</div>`;
  }

  // ---------- карточка фракции ----------
  showFaction(fid) {
    const s = this.sim;
    const f = s.faction(fid);
    if (!f) return;
    const R = Math.round(s.relations[fid]);
    const atWar = s.wars.some(w => w.fid === fid);
    const treaty = s.treaties.some(t => t.b === fid);
    const tr = f.def.traits;
    const hist = (s.diploLog[fid] || []).slice(-6).reverse();
    // Карточка показывает НЕ правду, а последнее, что о соседе рассказали.
    // Прежде здесь стояло f.armyPts — точное текущее число, всегда и про всех,
    // и половина решений принималась автоматически: видно же, что войско
    // втрое сильнее. Теперь знание стареет, и «лезть или нет» решается с риском.
    // Симуляция и ИИ по-прежнему видят настоящее состояние: туман неведения —
    // правило для игрока, а не для мира.
    const k = intelOf(s, fid);
    const armyEst = k.armyText;
    const eraShown = k.any && k.era != null && ERAS[k.era] ? ERAS[k.era].ru : 'неизвестно';
    this.showModal(`
      <h3><span style="color:${f.def.color}">⬤</span> ${f.def.name}</h3>
      <p>${f.def.leader} · Эпоха: ${eraShown} · Армия: ${armyEst}</p>
      <p style="margin:-4px 0 8px;font-size:12px;color:var(--dim)">
        ${k.any ? `${k.sourceText}, ${k.ageText} · ${intelTrustWord(k.trust)}` : 'о них ничего не рассказывали'}</p>
      <div class="kv"><span>Отношение</span><span>${R} (${R >= 20 ? 'дружелюбие' : R > -20 ? 'нейтралитет' : 'вражда'})</span></div>
      <div class="kv"><span>Уважает</span><span>${f.def.agenda.likes}</span></div>
      <div class="kv"><span>Презирает</span><span>${f.def.agenda.hates}</span></div>
      <div class="kv"><span>Черты</span><span>агр ${tr.aggression} · эксп ${tr.expansion} · торг ${tr.trade} · наука ${tr.science}</span></div>
      <p style="margin-top:10px;color:var(--dim)">«${atWar ? f.def.lines.war : f.def.lines.greet}»</p>
      ${hist.length ? `<h4 class="group">История</h4>` + hist.map(h => `<div class="kv"><span>${h.why}</span><span>${h.dR > 0 ? '+' : ''}${Math.round(h.dR)}</span></div>`).join('') : ''}
      <div class="btns" style="margin-top:12px">
        ${!atWar && !treaty ? `<button class="btn" data-act="treaty">Договор о торговле</button>` : ''}
        ${!atWar && treaty ? `<button class="btn" data-act="break">Разорвать договор (−15)</button>` : ''}
        ${!atWar ? `<button class="btn" data-act="gift">Подарок 50🪙</button>` : ''}
        ${!atWar ? `<button class="btn" data-act="demand">Потребовать дань</button>` : ''}
        ${!atWar ? `<button class="btn danger" data-act="war">Объявить войну</button>` : ''}
        ${atWar ? `<button class="btn primary" data-act="peace">Предложить мир</button>` : ''}
        <button class="btn" data-act="close">Закрыть</button>
      </div>`);
    this.el.modalBox.querySelectorAll('[data-act]').forEach(b => {
      b.onclick = () => {
        const act = b.dataset.act;
        if (act === 'close') { this.closeModal(); return; }
        const r = this.sim.diploAction(fid, act, 50);
        if (!r.ok) { this.toast(r.reason, 'warn'); this.audio.play('deny'); }
        else this.audio.play(act === 'war' ? 'raid' : 'coin');
        this.closeModal();
      };
    });
  }

  // ---------- карточка здания (долгий тап) ----------
  showBuildingCard(b) {
    const def = BUILDINGS[b.id];
    const s = this.sim;
    let extra = '';
    if (def.out) extra += `<div class="kv"><span>Выработка</span><span>${Object.entries(def.out).map(([r, v]) => `${v}/${RES.find(q => q.id === r)?.icon || r}`).join(' ')}</span></div>`;
    if (def.housing) extra += `<div class="kv"><span>Жильё</span><span>${def.housing} жителей</span></div>`;
    if (def.happy) extra += `<div class="kv"><span>Счастье</span><span>+${def.happy}</span></div>`;
    if (def.defense) extra += `<div class="kv"><span>Оборона</span><span>+${def.defense}</span></div>`;
    if (b.id === 'spire') {
      const sp = s.spireStageStatus();
      if (!sp.done) {
        const invStr = Object.entries(sp.cost).map(([r, v]) => `${RES.find(q => q.id === r)?.icon}${sp.inv[r] || 0}/${v}`).join(' ');
        extra += `<div class="kv"><span>Стадия ${sp.stage + 1}/5</span><span>${sp.name}</span></div><div class="kv"><span>Вложено</span><span>${invStr}</span></div>`;
        extra += `<div class="btns" style="margin-top:10px"><button class="btn primary" data-act="invest">Вложить ресурсы</button></div>`;
      } else extra += `<div class="kv"><span>Статус</span><span>Завершён!</span></div>`;
    }
    this.showModal(`
      <h3>${def.name}</h3>
      <p>${def.desc}</p>
      <div class="kv"><span>Статус</span><span>${b.done ? 'Работает' : `Строится ${Math.round(b.progress / b.buildDays * 100)}%`}</span></div>
      ${extra}
      <div class="btns" style="margin-top:10px"><button class="btn" data-act="close">Закрыть</button></div>`);
    this.el.modalBox.querySelectorAll('[data-act]').forEach(btn => {
      btn.onclick = () => {
        if (btn.dataset.act === 'invest') { const r = s.investSpire(); if (!r.ok) this.toast(r.reason, 'warn'); }
        this.closeModal();
      };
    });
  }

  // ---------- событие с выбором ----------
  showEvent(e) {
    this.showModal(`
      <h3>⚠ ${e.ru}</h3>
      <p>${e.text}</p>
      <div class="btns">
        <button class="btn primary" data-ev="a">${e.choice.a.ru}</button>
        <button class="btn" data-ev="b">${e.choice.b.ru}</button>
      </div>`, true);
    this.el.modalBox.querySelectorAll('[data-ev]').forEach(b => {
      b.onclick = () => {
        this.sim.resolveSpecial(b.dataset.ev);
        this.audio.play('click');
        this.closeModal(true);
      };
    });
  }

  showGreat(types) {
    const btns = types.map(t => `<button class="btn primary" data-g="${t.id}">${t.ru}<br><small style="font-weight:400">${t.desc}</small></button>`).join('');
    this.showModal(`<h3>🌟 Великий человек родился!</h3><p>Выберите, кем он станет:</p><div class="btns">${btns}</div>`, true);
    this.el.modalBox.querySelectorAll('[data-g]').forEach(b => {
      b.onclick = () => { this.sim.chooseGreat(b.dataset.g); this.audio.play('fanfare'); this.closeModal(true); };
    });
  }

  // ---------- меню ----------
  showMenu(tab) {
    if (tab) this.menuTab = tab;
    if (this.menuTab === 'gfx') { this.showMenuGraphics(); return; }
    const slots = ['1', '2', '3'];
    const saves = this.saveSys.list();
    this.showModal(`
      <h3>Меню</h3>
      ${this.menuTabsHtml()}
      <div class="btns">
        <button class="btn primary" data-m="resume">Продолжить</button>
        ${slots.map(i => `<button class="btn" data-m="save${i}">💾 Сохранить в слот ${i} ${saves.includes('slot' + i) ? '(есть сейв)' : ''}</button>`).join('')}
        ${slots.map(i => saves.includes('slot' + i) ? `<button class="btn" data-m="load${i}">📂 Загрузить слот ${i}</button>` : '').join('')}
        <button class="btn" data-m="export">⬇ Экспорт сейва (файл)</button>
        <button class="btn" data-m="import">⬆ Импорт сейва</button>
        <button class="btn" data-m="sound">🔊 Звук: вкл/выкл</button>
        <button class="btn" data-m="territory">🗺 Территории фракций: вкл/выкл</button>
        <button class="btn" data-m="console">⌨ Консоль разработчика</button>
        <button class="btn" data-m="how">❓ Как играть</button>
        <button class="btn danger" data-m="new">🔄 Новая игра</button>
      </div>`);
    this.bindMenuTabs();
    this.el.modalBox.querySelectorAll('[data-m]').forEach(b => {
      b.onclick = () => {
        const m = b.dataset.m;
        this.audio.play('click');
        if (m === 'resume') this.closeModal();
        else if (m.startsWith('save')) { this.cb.save('slot' + m.slice(4)); this.closeModal(); }
        else if (m.startsWith('load')) { this.cb.load('slot' + m.slice(4)); this.closeModal(); }
        else if (m === 'export') { FileSave.export(JSON.stringify(this.sim.serialize()), `frontier-day${this.sim.day}.json`); this.closeModal(); }
        else if (m === 'import') { this.closeModal(); FileSave.import(json => this.cb.importSave(json)); }
        else if (m === 'sound') { this.audio.toggleSfx(); this.audio.toggleMusic(); document.getElementById('btnSound').textContent = this.audio.enabled ? '🔊' : '🔇'; }
        else if (m === 'territory') { this.sim.showTerritory = !this.sim.showTerritory; this.toast(`Территории: ${this.sim.showTerritory ? 'показаны' : 'скрыты'}`); this.closeModal(); }
        else if (m === 'console') { this.closeModal(); this.toggleConsole(); }
        else if (m === 'how') this.showHow();
        else if (m === 'new') { this.closeModal(); this.showNewGame(); }
      };
    });
  }

  menuTabsHtml() {
    const t = [['game', '⚙ Игра'], ['gfx', '🎨 Графика']];
    return `<div class="mtabs">${t.map(([id, ru]) =>
      `<button data-mt="${id}" class="${this.menuTab === id ? 'active' : ''}">${ru}</button>`).join('')}</div>`;
  }

  bindMenuTabs() {
    this.el.modalBox.querySelectorAll('[data-mt]').forEach(b => {
      b.onclick = () => { this.audio.play('click'); this.showMenu(b.dataset.mt); };
    });
  }

  // Вкладка «Графика». Раньше пресет выбирал только автотюнер: один раз, только
  // вниз и только в первые 10 секунд. Замер из аудита (55 зданий, 226 жителей):
  // ultra 26 FPS, high 58, medium 78 — эти числа и показываем игроку.
  showMenuGraphics() {
    const cur = this.r.qualityId || 'auto';
    const act = this.r.quality ? this.r.quality.id : 'high';
    const NOTE = {
      auto: 'Начинает с «Высоко» и снижает пресет, если первые секунды идут рывками.',
      ultra: 'Всё: зерно, лучи, блики, птицы. На замере — 26 FPS. Только для мощных машин.',
      high: 'Тени, облака, свечение, светлячки. На замере — 58 FPS. Рекомендуется.',
      medium: 'Без свечения и лучей, тайл 24 px. На замере — 78 FPS. Ноутбуки и телефоны.',
      eco: 'Без рельефа, воды, облаков и теней, тайл 16 px. Для слабых машин.',
    };
    const opt = (id, ru) => {
      const on = cur === id;
      return `<button class="btn ${on ? 'primary' : ''}" data-q="${id}">
        <span class="qopt">${on ? '✓ ' : ''}${ru}${id === 'auto' && cur === 'auto' ? ` — сейчас «${QUALITY[act].ru}»` : ''}
        <small>${NOTE[id]}</small></span></button>`;
    };
    this.showModal(`
      <h3>Меню</h3>
      ${this.menuTabsHtml()}
      <div class="kv"><span>Кадров в секунду</span><span>${this.fps || '—'}</span></div>
      <div class="kv"><span>Активный пресет</span><span>${QUALITY[act].ru}</span></div>
      <div class="btns" style="margin-top:12px">
        ${opt('auto', '🤖 Авто')}
        ${QUALITY_ORDER.slice().reverse().map(id => opt(id, QUALITY[id].ru)).join('')}
        <button class="btn" data-q="close">Закрыть</button>
      </div>`);
    this.bindMenuTabs();
    this.el.modalBox.querySelectorAll('[data-q]').forEach(b => {
      b.onclick = () => {
        const id = b.dataset.q;
        this.audio.play('click');
        if (id === 'close') { this.closeModal(); return; }
        this.r.setQuality(id);
        this.toast(`Качество: ${id === 'auto' ? 'авто' : QUALITY[id].ru}`, 'good');
        this.showMenuGraphics();
      };
    });
  }

  showNewGame() {
    // Выбор эпохи старта: партия с античности или с индустриальной эпохи —
    // это другая игра, а не ускоренная старая. Технологии, ресурсы, население
    // и опорные постройки выдаются по эпохе (см. Simulation.startFromEra).
    this._ngEra = this._ngEra || 0;
    const eras = ERAS.map((e, i) =>
      `<button class="btn ${i === this._ngEra ? 'primary' : ''}" data-era="${i}" style="text-align:left">
         ${e.ru}<small style="display:block;opacity:.7">${e.years}</small>
       </button>`).join('');
    this.showModal(`
      <h3>Новая игра</h3>
      <p>Мир генерируется из сида — один сид даёт один и тот же мир. Соседи живут своей жизнью.</p>
      <p style="color:var(--accent);margin-bottom:6px">С какой эпохи начать</p>
      <div class="btns" style="max-height:34vh;overflow-y:auto">${eras}</div>
      <p style="color:var(--dim);font-size:11px;margin:10px 0 6px">
        Со старших эпох вы получаете их технологии, запасы и первые постройки.
      </p>
      <p style="color:var(--accent);margin-bottom:6px">Сколько соседей</p>
      <div class="btns">
        <button class="btn" data-n="3">🌍 Соседей: 3</button>
        <button class="btn" data-n="4">🌍 Соседей: 4</button>
        <button class="btn" data-n="5">🌍 Соседей: 5</button>
        <button class="btn" data-n="0">🏝 Один в мире</button>
        <button class="btn" data-n="cancel">Отмена</button>
      </div>`);
    this.el.modalBox.querySelectorAll('[data-era]').forEach(b => {
      b.onclick = () => { this._ngEra = +b.dataset.era; this.audio.play('click'); this.showNewGame(); };
    });
    this.el.modalBox.querySelectorAll('[data-n]').forEach(b => {
      b.onclick = () => {
        if (b.dataset.n !== 'cancel') this.cb.newGame(+b.dataset.n, this._ngEra);
        this.closeModal();
      };
    });
  }

  showHow() {
    this.showModal(`
      <h3>Как играть</h3>
      <p>🏗 <b>Стройка:</b> откройте СТРОЙКУ, выберите здание, перетащите призрак по карте и нажмите ✓. Причина запрета всегда написана.</p>
      <p>📜 <b>Наука:</b> знания капают сами, но быстрее — с Костром историй, Академиями и Лабораториями. Технологии ⚡ открывают новые эпохи.</p>
      <p>⚔️ <b>Армия:</b> с Железного века приходят рейды — богатеете быстрее, чем строите армию, ждите гостей. Казарма обучает бойцов.</p>
      <p>🤝 <b>Фракции:</b> соседи живут своей жизнью. Торговые договоры дают скидку на технологии и лучшие курсы рынка.</p>
      <p>🗼 <b>Финал:</b> в эпохе Будущего откройте «Проект Шпиль» и возведите все 5 стадий — луч в звёзды и победа.</p>
      <p>🎮 <b>ПК:</b> WASD/стрелки — камера, колесо — зум, Space — пауза, 1/2/3 — скорость, Esc — меню, ~ — консоль.</p>
      <div class="btns"><button class="btn primary" data-act="close">Понятно</button></div>`);
    this.el.modalBox.querySelector('[data-act]').onclick = () => this.closeModal();
  }

  // ---------- победа ----------
  showVictory() {
    const s = this.sim;
    const days = s.day;
    const techs = s.techs.size;
    this.el.victoryStats.innerHTML =
      `Дней: ${days} · Жителей: ${s.villagers.length} · Технологий: ${techs}/${TECHS.length} · Зданий: ${s.buildings.filter(b => b.done && !b.destroyed).length} · Отбито рейдов: ${s.repelled}`;
    this.el.victoryChron.innerHTML = '<b>Хроника цивилизации</b><br>' +
      s.chronicle.map(c => `<span style="color:var(--dim)">[год ${Math.floor(c.day / 100) + 1}]</span> ${c.text}`).join('<br>');
    this.el.victory.classList.add('show');
    this.audio.play('victory');
  }

  // ---------- модалка ----------
  showModal(html, lock = false) {
    this.el.modalBox.innerHTML = html;
    this.el.modalWrap.classList.add('show');
    this._modalLock = lock;
  }
  closeModal(force = false) {
    if (this._modalLock && !force) return;
    this.el.modalWrap.classList.remove('show');
    this._modalLock = false;
  }

  // ---------- онбординг ----------
  coachStep(step, x, y, text, btnText, onNext) {
    const c = this.el.coach;
    c.innerHTML = `${text}<div class="btns"><button class="btn primary" id="coachNext">${btnText}</button><button class="btn" id="coachSkip">Пропустить</button></div>`;
    c.style.left = Math.min(window.innerWidth - 280, Math.max(8, x)) + 'px';
    c.style.top = Math.min(window.innerHeight - 160, Math.max(60, y)) + 'px';
    c.classList.add('show');
    c.querySelector('#coachNext').onclick = () => { this.audio.play('click'); onNext(); };
    c.querySelector('#coachSkip').onclick = () => { c.classList.remove('show'); try { localStorage.setItem('frontier_coached', '1'); } catch { /* приватный режим */ } };
  }
  hideCoach() { this.el.coach.classList.remove('show'); try { localStorage.setItem('frontier_coached', '1'); } catch { /* приватный режим */ } }
}
