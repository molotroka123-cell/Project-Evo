// ui/hud.js — весь DOM-интерфейс (presentation-слой).
import { RES, ERAS, TECHS, TECH_ERA_IDX, BUILDINGS, UNITS, TRAIN_COST, SPIRE_STAGES, OBJECTIVES, FACTIONS, WEATHER, SEASONS, GREAT_TYPES } from '../core/data.js';
import { FileSave } from '../save/saveSystem.js';
import { renderMarketPanel, bindMarketPanel, createMarketPanelState } from './panel_market.js';

const TABS = [
  { id: 'build', ru: 'Стройка', ic: '🏗' },
  { id: 'research', ru: 'Наука', ic: '📜' },
  { id: 'army', ru: 'Армия', ic: '⚔️' },
  { id: 'diplo', ru: 'Дипломатия', ic: '🤝' },
  { id: 'market', ru: 'Рынок', ic: '⚖️' },
  { id: 'labor', ru: 'Труд', ic: '👷' },
  { id: 'goals', ru: 'Цели', ic: '🎯' },
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
    for (const id of ['topbar', 'rFood', 'rWood', 'rStone', 'rSteel', 'rGold', 'rKnow', 'rPop', 'rHappy', 'eraBadge', 'dateBox',
      'timeBox', 'toasts', 'sidePanel', 'sideTabs', 'sideContent', 'sheet', 'sheetHandle', 'sheetTabs', 'sheetContent',
      'placeBar', 'placeOk', 'placeCancel', 'consoleBox', 'consoleOut', 'consoleIn', 'modalWrap', 'modalBox',
      'eraBanner', 'eraName', 'eraYears', 'victory', 'victoryStats', 'victoryChron', 'overlay', 'coach', 'overlayArt'])
      this.el[id] = document.getElementById(id);
    this._logRendered = 0;
    this._eraTapCount = 0;
    this._eraTapTimer = 0;
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
    this.setTab('build');
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

  // ---------- верхняя полоса ----------
  refresh() {
    const s = this.sim;
    // Знаменатель показывается у всех ограниченных ресурсов, а не только у еды:
    // без него игрок не понимал, почему лесопилка работает, а дерево стоит.
    // На потолке число подсвечивается — это сигнал строить склад.
    const cap = (id, icon) => {
      const v = Math.floor(s.res[id]), m = s.resCap[id];
      if (!m || m >= 99999) return `${icon} <b>${v}</b>`;
      const full = v >= m - 0.5;
      return `${icon} <b${full ? ' style="color:var(--warn)"' : ''}>${v}</b><small>/${m}</small>`;
    };
    this.el.rFood.innerHTML = cap('food', '🍞');
    this.el.rWood.innerHTML = cap('wood', '🪵');
    this.el.rStone.innerHTML = cap('stone', '🪨');
    this.el.rSteel.innerHTML = cap('steel', '⚙️');
    this.el.rGold.innerHTML = `🪙 <b>${Math.floor(s.res.gold)}</b>`;
    this.el.rKnow.innerHTML = `📜 <b>${Math.floor(s.res.knowledge)}</b>`;
    this.el.rPop.innerHTML = `👥 <b>${s.villagers.length}</b><small>/${s.housingCap()}</small>`;
    const happy = s.happiness();
    this.el.rHappy.innerHTML = `${happy >= 70 ? '😊' : happy >= 40 ? '😐' : '😟'} <b>${happy}%</b>`;
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
      else if (lack) reason = `Не хватает: ${lack}`;
      const dis = locked || built || lack;
      html += `<div class="card ${dis ? 'disabled' : ''}" ${!locked && !built ? `data-build="${id}"` : ''}>
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
      html += `<div class="card ${has ? 'done-card' : (reason ? 'disabled' : '')}" ${!has && !missing.length ? `data-tech="${t.id}"` : ''}>
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
    const armyEst = atWar || R >= 20 ? `~${Math.round(f.armyPts)}` : (f.armyPts < 20 ? 'мало' : f.armyPts < 60 ? 'сопоставимо' : 'много');
    this.showModal(`
      <h3><span style="color:${f.def.color}">⬤</span> ${f.def.name}</h3>
      <p>${f.def.leader} · Эпоха: ${ERAS[f.era].ru} · Армия: ${armyEst}</p>
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
  showMenu() {
    const slots = ['1', '2', '3'];
    const saves = this.saveSys.list();
    this.showModal(`
      <h3>Меню</h3>
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

  showNewGame() {
    this.showModal(`
      <h3>Новая игра</h3>
      <p>Мир генерируется из сида — один сид = один мир. Соседи-фракции живут своей жизнью.</p>
      <div class="btns">
        <button class="btn" data-n="3">🌍 Соседей: 3</button>
        <button class="btn" data-n="4">🌍 Соседей: 4</button>
        <button class="btn" data-n="5">🌍 Соседей: 5</button>
        <button class="btn" data-n="0">🏝 Один в мире</button>
        <button class="btn" data-n="cancel">Отмена</button>
      </div>`);
    this.el.modalBox.querySelectorAll('[data-n]').forEach(b => {
      b.onclick = () => {
        if (b.dataset.n !== 'cancel') this.cb.newGame(+b.dataset.n);
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
    c.querySelector('#coachSkip').onclick = () => { c.classList.remove('show'); localStorage.setItem('frontier_coached', '1'); };
  }
  hideCoach() { this.el.coach.classList.remove('show'); localStorage.setItem('frontier_coached', '1'); }
}
