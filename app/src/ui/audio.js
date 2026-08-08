// ui/audio.js — весь звук игры: эффекты, окружение и музыка синтезируются WebAudio.
// Внешних файлов и сети нет — билд остаётся одним самодостаточным HTML, который
// работает офлайн. Встроенная base64-тема (setMusic) поддерживается как была.
//
// Шины: master → { music, sfx }, окружение подмешано в sfx — для игрока птицы и
// гул фабрик это тоже «эффекты», поэтому регуляторов ровно три: общий, музыка,
// эффекты (у окружения свой множитель внутри шины эффектов).
//
// Контекст мира (эпоха, время суток, сезон, погода, население) движок берёт из
// setContext(), а если его никто не кормит — сам подглядывает в window.__frontier.sim.
// Подглядывание строго на чтение: звук не имеет права трогать симуляцию.

// Свой генератор случайности. Math.random запрещён, а rng ядра дёргать нельзя
// тем более: звуковой шум сдвинул бы поток симуляции и порвал сейвы. Этот
// генератор ни на что в мире не влияет — только на то, когда чирикнет птица.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PREFS_KEY = 'frontier.audio.v1';

// Лады по эпохам: ранние эпохи — пентатоника (архаично), средние — натуральный
// минор/дорийский, поздние — мажор и широкие синтезаторные созвучия.
const ERA_SCALE = [
  [0, 3, 5, 7, 10],       // каменный
  [0, 3, 5, 7, 10],       // бронза
  [0, 2, 5, 7, 9],        // железо
  [0, 2, 4, 7, 9],        // античность
  [0, 2, 3, 5, 7, 10],    // средневековье (дорийский)
  [0, 2, 4, 5, 7, 9, 11], // ренессанс
  [0, 2, 3, 5, 7, 8, 10], // индустриальная (минор)
  [0, 2, 4, 5, 7, 9, 11], // современность
  [0, 2, 4, 7, 9, 11],    // информационная
  [0, 2, 4, 6, 7, 9, 11], // будущее (лидийский)
];
const ERA_TIMBRE = ['triangle', 'triangle', 'triangle', 'sine', 'sine', 'sine', 'sawtooth', 'sawtooth', 'square', 'sawtooth'];

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;        // эффекты; имя старое — на него смотрит HUD
    this.musicEnabled = true;
    this.musicEl = null;
    this.unlocked = false;

    this.vol = { master: 0.7, music: 0.45, sfx: 0.85, amb: 0.8 };
    this.world = {
      eraIndex: 0, dayTime: 0.35, seasonIdx: 0,
      weather: 'sun', pop: 0, paused: false, industry: 0,
    };
    this._manualWorld = false;  // true, если контекст задают явно через setContext

    this._rnd = mulberry32(0x5eed1e);
    this._last = Object.create(null); // антидребезг одинаковых эффектов
    this._lastGesture = -1e9;         // когда игрок последний раз кликал
    this._amb = null;
    this._timer = 0;
    this._musicNext = 0;
    this._mixer = null;

    this._loadPrefs();
    this._bindWindow();
  }

  // ---------------------------------------------------------------- запуск --
  // Звук не звучит, пока игрок не сделает жест — политика браузеров. unlock()
  // зовётся из main.js по первому клику; на всякий случай мы и сами слушаем.
  unlock() {
    if (this.unlocked) { this._resume(); return; }
    this.unlocked = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.ctx = null; return; }
      this.ctx = new AC();
      this._buildGraph();
    } catch { this.ctx = null; return; }
    this._resume();
    this._startAmbience();
    this._startTick();
    if (this.musicEnabled) this.startMusic();
  }

  // resume() умеет и бросать, и возвращать отклонённый промис (автоплей-политика,
  // офлайн-контекст) — гасим оба пути, иначе в консоли красная ошибка.
  _resume() {
    try {
      if (this.ctx && this.ctx.state === 'suspended') {
        const p = this.ctx.resume();
        if (p && p.catch) p.catch(() => { });
      }
    } catch { /* не критично */ }
  }

  _bindWindow() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    const gesture = (e) => {
      this._lastGesture = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (!this.unlocked) this.unlock(); else this._resume();
      if (e && e.type === 'keydown') this._hotkey(e);
    };
    window.addEventListener('pointerdown', gesture, { passive: true, capture: true });
    window.addEventListener('keydown', gesture, { capture: true });
    // Вкладка ушла в фон — глушим всё: фоновый гул из невидимой вкладки бесит.
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) {
        this._stopTick();
        try { const p = this.ctx.suspend(); if (p && p.catch) p.catch(() => { }); } catch { /* не критично */ }
        if (this.musicEl) this.musicEl.pause();
      }
      else { this._resume(); this._startTick(); if (this.musicEnabled && this.musicEl) this.musicEl.play().catch(() => { }); }
    });
  }

  _hotkey(e) {
    if (!e || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'm' || e.key === 'M' || e.key === 'ь' || e.key === 'Ь') this.toggleMixer();
  }

  // ------------------------------------------------------------ граф микса --
  _buildGraph() {
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = this.vol.master;
    this.master.connect(c.destination);

    this.musicBus = c.createGain();
    this.musicBus.gain.value = this.vol.music;
    this.musicBus.connect(this.master);

    this.sfxBus = c.createGain();
    this.sfxBus.gain.value = this.enabled ? this.vol.sfx : 0;
    this.sfxBus.connect(this.master);

    this.ambBus = c.createGain();          // окружение живёт внутри шины эффектов
    this.ambBus.gain.value = this.vol.amb;
    this.ambBus.connect(this.sfxBus);

    // Общий короткий «зал»: без него синтез звучит как писк в вате.
    this.verb = c.createConvolver();
    this.verb.buffer = this._impulse(1.5, 2.4);
    this.verbGain = c.createGain();
    this.verbGain.gain.value = 0.9;
    this.verb.connect(this.verbGain);
    this.verbGain.connect(this.master);
    this.sfxSend = c.createGain();
    this.sfxSend.gain.value = 0.16;
    this.sfxBus.connect(this.sfxSend);
    this.sfxSend.connect(this.verb);
    this.musicSend = c.createGain();
    this.musicSend.gain.value = 0.3;
    this.musicBus.connect(this.musicSend);
    this.musicSend.connect(this.verb);

    this._noiseBuf = this._noiseBuffer(2);
  }

  _noiseBuffer(sec) {
    const c = this.ctx, n = Math.floor(c.sampleRate * sec);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = this._rnd() * 2 - 1;
    return buf;
  }

  _impulse(sec, decay) {
    const c = this.ctx, n = Math.floor(c.sampleRate * sec);
    const buf = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (this._rnd() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return buf;
  }

  // ------------------------------------------------------- громкость и микс --
  setVolume(bus, v) {
    v = Math.max(0, Math.min(1, +v || 0));
    if (!(bus in this.vol)) return;
    this.vol[bus] = v;
    this._applyVolumes();
    this._savePrefs();
  }
  getVolume(bus) { return this.vol[bus]; }

  _applyVolumes() {
    if (this.ctx) {
      const t = this.ctx.currentTime;
      const set = (node, val) => { try { node.gain.setTargetAtTime(val, t, 0.05); } catch { node.gain.value = val; } };
      set(this.master, this.vol.master);
      set(this.musicBus, this.musicEnabled ? this.vol.music : 0);
      set(this.sfxBus, this.enabled ? this.vol.sfx : 0);
      set(this.ambBus, this.vol.amb);
    }
    if (this.musicEl) this.musicEl.volume = Math.max(0, Math.min(1, this.vol.master * this.vol.music * (this.musicEnabled ? 1 : 0)));
    this._syncMixer();
  }

  _loadPrefs() {
    try {
      const raw = window.localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        for (const k of ['master', 'music', 'sfx', 'amb']) if (typeof p[k] === 'number') this.vol[k] = Math.max(0, Math.min(1, p[k]));
        if (typeof p.sfxOn === 'boolean') this.enabled = p.sfxOn;
        if (typeof p.musicOn === 'boolean') this.musicEnabled = p.musicOn;
      }
    } catch { /* приватный режим — просто играем с настройками по умолчанию */ }
  }

  _savePrefs() {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({
        master: this.vol.master, music: this.vol.music, sfx: this.vol.sfx, amb: this.vol.amb,
        sfxOn: this.enabled, musicOn: this.musicEnabled,
      }));
    } catch { /* не смогли сохранить — не беда */ }
  }

  toggleSfx() { this.enabled = !this.enabled; this._applyVolumes(); this._savePrefs(); return this.enabled; }

  toggleMusic() {
    this.musicEnabled = !this.musicEnabled;
    if (this.musicEl) {
      if (this.musicEnabled) this.musicEl.play().catch(() => { });
      else this.musicEl.pause();
    } else if (this.musicEnabled) this.startMusic();
    this._applyVolumes();
    this._savePrefs();
    return this.musicEnabled;
  }

  // ------------------------------------------------------------- контекст ---
  // Кто угодно может кормить движок состоянием мира. Как только позвали хоть
  // раз — автоподглядывание за window.__frontier.sim выключается.
  setContext(o) {
    if (!o) return;
    this._manualWorld = true;
    const w = this.world;
    if (typeof o.eraIndex === 'number') w.eraIndex = o.eraIndex | 0;
    if (typeof o.dayTime === 'number') w.dayTime = o.dayTime - Math.floor(o.dayTime);
    if (typeof o.seasonIdx === 'number') w.seasonIdx = o.seasonIdx | 0;
    if (typeof o.weather === 'string') w.weather = o.weather;
    if (typeof o.pop === 'number') w.pop = o.pop;
    if (typeof o.paused === 'boolean') w.paused = o.paused;
    if (typeof o.industry === 'number') w.industry = o.industry;
  }

  // Дешёвая часть опроса: её зовём и перед эффектом, чтобы стингер смены эпохи
  // прозвучал уже новым тембром, а не тембром предыдущей эпохи.
  _pollFast() {
    if (this._manualWorld) return;
    let s = null;
    try { s = window.__frontier && window.__frontier.sim; } catch { s = null; }
    if (!s) return;
    const w = this.world;
    if (typeof s.eraIndex === 'number') w.eraIndex = s.eraIndex | 0;
    if (typeof s.dayTime === 'number') w.dayTime = s.dayTime - Math.floor(s.dayTime);
    if (typeof s.seasonIdx === 'number') w.seasonIdx = s.seasonIdx | 0;
    if (typeof s.weather === 'string') w.weather = s.weather;
    if (s.villagers) w.pop = s.villagers.length;
    w.paused = !!s.paused;
    return s;
  }

  _pollWorld() {
    const s = this._pollFast();
    if (!s) return;
    const w = this.world;
    // Промышленность считаем по числу «дымящих» зданий — от неё зависит гул.
    if (s.buildings) {
      let n = 0;
      for (const b of s.buildings) {
        if (!b || !b.done) continue;
        if (b.id === 'factory' || b.id === 'foundry' || b.id === 'power_plant' || b.id === 'smithy' ||
          b.id === 'workshop' || b.id === 'mine' || b.id === 'quarry' || b.id === 'datacenter') n++;
      }
      w.industry = n;
    }
  }

  // Фазы суток: ночь / рассвет / день / закат.
  _phase() {
    const t = this.world.dayTime;
    if (t < 0.21 || t > 0.87) return 'night';
    if (t < 0.32) return 'dawn';
    if (t < 0.76) return 'day';
    return 'dusk';
  }

  // ------------------------------------------------------- примитивы синтеза --
  _t(when) { return this.ctx.currentTime + Math.max(0, when || 0); }

  // Обратная совместимость: старая сигнатура tone(freq, dur, type, vol, when, slide).
  tone(freq, dur, type = 'sine', vol = 0.3, when = 0, slide = 0) {
    this._osc({ freq, dur, type, vol, when, to: slide ? Math.max(20, freq + slide) : 0 });
  }

  _osc(o) {
    if (!this.ctx) return;
    const c = this.ctx;
    const bus = o.bus || this.sfxBus;
    // Выключенные эффекты не должны глушить музыку — она идёт по своей шине.
    if (!this.enabled && bus !== this.musicBus) return;
    const t = this._t(o.when);
    const dur = o.dur ?? 0.2;
    const vol = o.vol ?? 0.2;
    const atk = o.atk ?? 0.006;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(Math.max(20, o.freq || 440), t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + dur);
    if (o.detune) osc.detune.setValueAtTime(o.detune, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = g;
    if (o.lp) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.setValueAtTime(o.lp, t);
      g.connect(f); node = f;
    }
    osc.connect(g); node.connect(bus);
    osc.start(t); osc.stop(t + dur + 0.06);
    return osc;
  }

  _noise(o) {
    if (!this.ctx || !this._noiseBuf) return;
    const c = this.ctx;
    const bus = o.bus || this.sfxBus;
    if (!this.enabled && bus !== this.musicBus) return;
    const t = this._t(o.when);
    const dur = o.dur ?? 0.2;
    const vol = o.vol ?? 0.15;
    const src = c.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    // Старт с произвольной точки буфера, иначе все шумы звучат одинаково.
    const off = this._rnd() * (this._noiseBuf.duration - dur - 0.05);
    const f = c.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(Math.max(30, o.freq || 800), t);
    if (o.sweep) f.frequency.exponentialRampToValueAtTime(Math.max(30, o.sweep), t + dur);
    f.Q.value = o.q ?? 1;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + (o.atk ?? 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(bus);
    src.start(t, Math.max(0, off), dur + 0.05);
    src.stop(t + dur + 0.06);
  }

  // Колокол: неравные обертоны — иначе получается не колокол, а свисток.
  _bell(freq, when = 0, vol = 0.2, dur = 1.6, bus) {
    const parts = [[1, 1], [2.76, 0.5], [5.4, 0.28], [8.9, 0.14]];
    for (const [r, a] of parts) {
      this._osc({ freq: freq * r, dur: dur * (1 / Math.sqrt(r)), vol: vol * a, when, type: 'sine', atk: 0.004, bus });
    }
  }

  _pluck(freq, when = 0, vol = 0.18, dur = 0.5, type = 'triangle', bus) {
    this._osc({ freq, dur, vol, when, type, atk: 0.005, lp: freq * 6, bus });
  }

  _thud(when = 0, vol = 0.3, bus) {
    this._osc({ freq: 110, to: 44, dur: 0.22, vol, when, type: 'sine', atk: 0.003, bus });
    this._noise({ when, dur: 0.16, vol: vol * 0.5, freq: 420, sweep: 160, q: 0.8, type: 'lowpass', bus });
  }

  _hammer(when = 0, vol = 0.22, bus) {
    this._noise({ when, dur: 0.07, vol: vol * 0.8, freq: 2600, q: 0.9, type: 'highpass', bus });
    this._osc({ freq: 780, to: 260, dur: 0.09, vol: vol * 0.6, when, type: 'triangle', bus });
  }

  _drum(when = 0, vol = 0.3, bus) {
    this._osc({ freq: 160, to: 48, dur: 0.3, vol, when, type: 'sine', atk: 0.003, bus });
    this._noise({ when, dur: 0.09, vol: vol * 0.35, freq: 900, q: 0.7, type: 'lowpass', bus });
  }

  // Рог: пила через фильтр с медленной атакой — читается как боевой сигнал.
  _horn(freq, when = 0, dur = 0.9, vol = 0.22, bus) {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t = this._t(when);
    const o = c.createOscillator(), o2 = c.createOscillator();
    const g = c.createGain(), f = c.createBiquadFilter();
    o.type = 'sawtooth'; o2.type = 'sawtooth';
    o.frequency.setValueAtTime(freq, t);
    o2.frequency.setValueAtTime(freq * 1.005, t);
    o.frequency.exponentialRampToValueAtTime(freq * 1.03, t + dur * 0.3);
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq * 3, t);
    f.frequency.exponentialRampToValueAtTime(freq * 6, t + dur * 0.25);
    f.frequency.exponentialRampToValueAtTime(freq * 2, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.09);
    g.gain.setValueAtTime(vol, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); o2.connect(f); f.connect(g); g.connect(bus || this.sfxBus);
    o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  }

  _chord(root, ints, when = 0, dur = 1.2, vol = 0.14, type = 'triangle', bus) {
    ints.forEach((iv, i) => this._pluck(midi(root + iv), when + i * 0.012, vol, dur, type, bus));
  }

  // Пригасить окружение, чтобы крупный звук (эпоха, победа) не тонул в гуле.
  _duck(sec = 2, amount = 0.25) {
    if (!this.ctx || !this.ambBus) return;
    const t = this.ctx.currentTime;
    try {
      this.ambBus.gain.cancelScheduledValues(t);
      this.ambBus.gain.setTargetAtTime(this.vol.amb * amount, t, 0.15);
      this.ambBus.gain.setTargetAtTime(this.vol.amb, t + sec, 0.8);
    } catch { /* старый браузер — переживём без ducking */ }
  }

  // ------------------------------------------------------------- эффекты ----
  play(name, opts) {
    if (!this.ctx || !this.enabled || !name) return;
    // Антидребезг: десяток одновременных «построено» иначе схлопывается в кашу.
    const now = this.ctx.currentTime;
    const gap = name === 'click' ? 0.03 : 0.06;
    if (this._last[name] !== undefined && now - this._last[name] < gap) return;
    this._last[name] = now;
    this._pollFast();
    const era = this.world.eraIndex;

    switch (name) {
      case 'click':
        this._osc({ freq: 660, dur: 0.05, vol: 0.09, type: 'square', lp: 3000 });
        this._noise({ dur: 0.02, vol: 0.03, freq: 3000, q: 0.8, type: 'highpass' });
        break;

      case 'select':
      case 'open':
        this._pluck(880, 0, 0.1, 0.18, 'sine');
        this._pluck(1320, 0.04, 0.07, 0.16, 'sine');
        break;

      case 'close':
        this._pluck(660, 0, 0.09, 0.16, 'sine');
        this._pluck(440, 0.04, 0.07, 0.18, 'sine');
        break;

      case 'deny':
        this._osc({ freq: 170, to: 84, dur: 0.22, vol: 0.2, type: 'sawtooth', lp: 700 });
        this._noise({ dur: 0.12, vol: 0.07, freq: 300, q: 0.7, type: 'lowpass' });
        break;

      case 'coin':
        this._osc({ freq: 1180, dur: 0.07, vol: 0.09, type: 'square' });
        this._osc({ freq: 1560, dur: 0.13, vol: 0.08, type: 'square', when: 0.06 });
        this._bell(2100, 0.02, 0.035, 0.5);
        break;

      // Постановка здания: глухой стук по земле и осыпающаяся пыль.
      case 'place':
        this._thud(0, 0.32);
        this._noise({ when: 0.05, dur: 0.3, vol: 0.06, freq: 1200, sweep: 400, q: 0.6, type: 'bandpass' });
        break;

      // Стройка завершена: два удара молотка и мажорное трезвучие.
      case 'built':
      case 'build_done':
        this._hammer(0, 0.2);
        this._hammer(0.13, 0.24);
        this._chord(60, [0, 4, 7], 0.26, 0.7, 0.1, ERA_TIMBRE[Math.min(9, era)]);
        this._bell(midi(72), 0.3, 0.05, 0.9);
        break;

      // Историческое имя: main.js зовёт 'build' при постановке, симуляция — при
      // завершении стройки. Различаем по свежести жеста игрока: постановка
      // всегда идёт следом за кликом, завершение приходит из игрового цикла.
      case 'build': {
        const dt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - this._lastGesture;
        this.play(dt < 350 ? 'place' : 'built');
        return;
      }

      // Технология: восходящий арпеджио по ладу эпохи + «искра».
      case 'tech': {
        const sc = ERA_SCALE[Math.min(9, era)];
        const type = ERA_TIMBRE[Math.min(9, era)];
        for (let i = 0; i < 4; i++) {
          const st = sc[i % sc.length] + 12 * Math.floor(i / sc.length);
          this._pluck(midi(72 + st), i * 0.075, 0.12, 0.45, type);
        }
        this._bell(2400, 0.3, 0.05, 1.1);
        break;
      }

      // Новая эпоха: тембр меняется вместе с временем — от рога и барабана
      // через колокола к фабричному гудку и синтезатору.
      case 'era': {
        this._duck(3, 0.2);
        const sc = ERA_SCALE[Math.min(9, era)];
        const type = ERA_TIMBRE[Math.min(9, era)];
        if (era <= 2) {
          this._drum(0, 0.26); this._drum(0.3, 0.22);
          this._horn(midi(50), 0.05, 1.3, 0.16);
          this._horn(midi(57), 0.5, 1.4, 0.13);
        } else if (era <= 5) {
          this._bell(midi(48), 0, 0.22, 3.2);
          this._bell(midi(55), 0.45, 0.16, 2.6);
        } else if (era <= 7) {
          this._horn(midi(45), 0, 1.6, 0.18);      // заводской гудок
          this._noise({ when: 0.1, dur: 1.2, vol: 0.05, freq: 1500, sweep: 900, q: 3, type: 'bandpass' });
          this._drum(0.9, 0.22);
        } else {
          this._osc({ freq: midi(48), dur: 2.2, vol: 0.13, type: 'sawtooth', atk: 0.4, lp: 900 });
          this._osc({ freq: midi(48 + 7), dur: 2.2, vol: 0.1, type: 'sawtooth', atk: 0.5, lp: 1200 });
          // Мерцание сверху: без него синтезаторный аккорд глухой и тише прочих эпох.
          [0, 7, 12, 16].forEach((iv, i) => this._pluck(midi(84 + iv), 0.12 + i * 0.09, 0.06, 1.4, 'sine'));
        }
        // Общий подъём: три ступени лада вверх и разрешение в октаву.
        [0, 1, 2].forEach((i) => this._pluck(midi(60 + sc[i % sc.length]), 0.55 + i * 0.18, 0.13, 0.9, type));
        this._chord(60, [0, 7, 12], 1.15, 2.4, 0.11, type);
        break;
      }

      // Событие без выбора: мягкий вопросительный колокольчик.
      case 'event':
        this._bell(midi(76), 0, 0.1, 1.0);
        this._bell(midi(81), 0.16, 0.09, 1.3);
        break;

      // Тревога: две нисходящие терции — сразу читается «что-то плохое».
      case 'alarm':
      case 'warn':
        this._osc({ freq: midi(81), to: midi(77), dur: 0.2, vol: 0.16, type: 'square', lp: 2200 });
        this._osc({ freq: midi(81), to: midi(75), dur: 0.28, vol: 0.16, type: 'square', when: 0.24, lp: 2000 });
        this._drum(0.05, 0.16);
        break;

      // Рейд: боевой рог и барабаны. Единственный по-настоящему громкий звук.
      case 'raid':
        this._duck(2.5, 0.3);
        this._horn(midi(40), 0, 1.1, 0.26);
        this._horn(midi(40), 0.55, 1.3, 0.22, undefined);
        this._drum(0.15, 0.3); this._drum(0.45, 0.26); this._drum(0.75, 0.3); this._drum(1.05, 0.26);
        this._noise({ when: 0, dur: 1.6, vol: 0.05, freq: 200, q: 0.6, type: 'lowpass' });
        break;

      // Малая фанфара: отбитый рейд, стадия Шпиля.
      case 'fanfare': {
        const type = ERA_TIMBRE[Math.min(9, era)];
        [0, 4, 7].forEach((iv, i) => this._pluck(midi(67 + iv), i * 0.11, 0.15, 0.55, type));
        this._chord(67, [0, 4, 7, 12], 0.36, 1.4, 0.11, type);
        this._drum(0, 0.18);
        break;
      }

      // Победа: полноценная каденция с колоколами. Играется один раз за партию.
      case 'victory': {
        this._duck(6, 0.12);
        const type = ERA_TIMBRE[Math.min(9, era)];
        this._chord(60, [0, 4, 7], 0.0, 1.0, 0.11, type);
        this._chord(65, [0, 4, 7], 0.55, 1.0, 0.11, type);
        this._chord(67, [0, 4, 7, 10], 1.1, 1.0, 0.11, type);
        this._chord(72, [0, 4, 7, 12], 1.7, 3.4, 0.13, type);
        [72, 76, 79, 84].forEach((n, i) => this._pluck(midi(n), 1.75 + i * 0.13, 0.12, 1.6, 'triangle'));
        this._bell(midi(48), 1.7, 0.2, 4.5);
        this._bell(midi(60), 2.4, 0.14, 3.5);
        this._drum(1.7, 0.28);
        break;
      }

      default:
        // Неизвестное имя — молчим, но не падаем: движок зовут из разных мест.
        break;
    }
    if (opts && opts.duck) this._duck(opts.duck, 0.3);
  }

  // ------------------------------------------------------------ окружение ---
  _loop(filterType, freq, q, gain) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this._noiseBuf; src.loop = true;
    const f = c.createBiquadFilter();
    f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain(); g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(this.ambBus);
    src.start(0);
    return { src, f, g };
  }

  _startAmbience() {
    if (!this.ctx || this._amb) return;
    const c = this.ctx;
    const A = {};
    A.wind = this._loop('bandpass', 360, 0.55, 0);
    A.rain = this._loop('lowpass', 1600, 0.7, 0);
    A.murmur = this._loop('lowpass', 620, 0.6, 0);   // гомон поселения

    // Гул фабрик: две низкие пилы + шумовой «выдох» пара.
    const mk = (freq, type) => { const o = c.createOscillator(); o.type = type; o.frequency.value = freq; return o; };
    const fg = c.createGain(); fg.gain.value = 0;
    const flp = c.createBiquadFilter(); flp.type = 'lowpass'; flp.frequency.value = 260;
    // Три генератора складываются в тройную амплитуду — гасим их до одного
    // голоса, иначе фабрика орёт громче победной фанфары.
    const ftrim = c.createGain(); ftrim.gain.value = 0.33;
    const f1 = mk(47, 'sawtooth'), f2 = mk(70.5, 'sawtooth'), f3 = mk(23.5, 'square');
    f1.connect(flp); f2.connect(flp); f3.connect(flp);
    flp.connect(ftrim); ftrim.connect(fg); fg.connect(this.ambBus);
    f1.start(0); f2.start(0); f3.start(0);
    A.factory = { g: fg };
    A.steam = this._loop('bandpass', 900, 0.8, 0);

    // Электрический фон поздних эпох: биения двух близких синусов.
    const eg = c.createGain(); eg.gain.value = 0;
    const etrim = c.createGain(); etrim.gain.value = 0.4;
    const e1 = mk(100, 'sine'), e2 = mk(100.7, 'sine'), e3 = mk(2400, 'sine');
    const elp = c.createGain(); elp.gain.value = 0.06;
    e3.connect(elp); elp.connect(etrim);
    e1.connect(etrim); e2.connect(etrim); etrim.connect(eg); eg.connect(this.ambBus);
    e1.start(0); e2.start(0); e3.start(0);
    A.electric = { g: eg };

    this._amb = A;
  }

  // Целевые громкости слоёв по эпохе, времени суток, сезону и погоде.
  _ambTargets() {
    const w = this.world, ph = this._phase();
    const era = w.eraIndex, winter = w.seasonIdx === 3;
    const rain = w.weather === 'rain', snow = w.weather === 'snow';
    const pop = Math.min(1, w.pop / 45);
    const ind = Math.min(1, w.industry / 8);
    const quiet = w.paused ? 0.55 : 1;

    let wind = 0.05 + (winter ? 0.07 : 0) + (snow ? 0.05 : 0) + (ph === 'night' ? 0.015 : 0);
    if (era >= 7) wind *= 0.7;                       // в большом городе ветра не слышно
    const rainL = rain ? 0.14 : snow ? 0.05 : 0;
    let murmur = era >= 1 ? pop * (ph === 'day' ? 0.13 : ph === 'night' ? 0.02 : 0.07) : pop * 0.03;
    if (rain || snow) murmur *= 0.6;
    // Пик гула — индустриальная эпоха и современность; дальше производство
    // уезжает за город и уступает место ровному электрическому фону.
    const indEra = era < 6 ? 0 : era <= 7 ? 1 : era === 8 ? 0.55 : 0.3;
    const factory = (0.03 + 0.09 * ind) * indEra * (ph === 'night' ? 0.55 : 1);
    const steam = era >= 6 && era <= 7 ? 0.012 + 0.02 * ind : 0;
    const electric = era >= 8 ? 0.03 + 0.02 * pop : 0;

    return {
      wind: wind * quiet, rain: rainL * quiet, murmur: murmur * quiet,
      factory: factory * quiet, steam: steam * quiet, electric: electric * quiet,
    };
  }

  _ambTick() {
    const A = this._amb;
    if (!A) return;
    const t = this.ctx.currentTime;
    const tg = this._ambTargets();
    const ramp = (node, v) => { if (node) { try { node.g.gain.setTargetAtTime(v, t, 1.4); } catch { node.g.gain.value = v; } } };
    ramp(A.wind, tg.wind); ramp(A.rain, tg.rain); ramp(A.murmur, tg.murmur);
    ramp(A.factory, tg.factory); ramp(A.steam, tg.steam); ramp(A.electric, tg.electric);
    // Ветер живой: медленно гуляет по частоте.
    try { A.wind.f.frequency.setTargetAtTime(260 + this._rnd() * 260, t, 2.5); } catch { /* нестрашно */ }
  }

  // Разовые голоса окружения. Тик — полсекунды, поэтому вероятности маленькие.
  _ambVoices() {
    const w = this.world, ph = this._phase(), era = w.eraIndex;
    const winter = w.seasonIdx === 3;
    const bad = w.weather === 'rain' || w.weather === 'snow';
    const bus = this.ambBus;
    const at = () => this._rnd() * 0.5;
    const roll = (p) => this._rnd() < p;

    // Птицы: громче всего на рассвете, зимой и в дождь почти молчат.
    if ((ph === 'day' || ph === 'dawn') && !winter && !bad) {
      const p = (ph === 'dawn' ? 0.5 : 0.26) * (era >= 7 ? 0.45 : 1);
      if (roll(p)) this._chirp(at(), 2200 + this._rnd() * 1400, 2 + Math.floor(this._rnd() * 3), bus);
    }
    // Сверчки: тёплая ночь.
    if (ph === 'night' && !winter && !bad && roll(0.45)) this._cricket(at(), bus);
    if (ph === 'dusk' && !winter && !bad && roll(0.18)) this._cricket(at(), bus);
    // Сова ночью и волки в ранних эпохах — за пределами частокола.
    if (ph === 'night' && roll(0.03)) this._owl(at(), bus);
    if (ph === 'night' && era <= 3 && roll(0.018)) this._wolf(at(), bus);
    // Дальний стук топора и молота — пока город ещё ручной.
    if (ph !== 'night' && era >= 1 && era <= 6 && w.pop > 3 && roll(0.1)) this._hammer(at(), 0.05, bus);
    // Лязг цехов и редкий гудок смены.
    if (era >= 6 && w.industry > 0 && roll(0.1)) this._clank(at(), bus);
    if (era >= 6 && era <= 7 && ph === 'day' && roll(0.008)) this._horn(midi(45), at(), 1.4, 0.055, bus);
    // Позднее время: одинокий сигнал транспорта в спящем городе.
    if (era >= 7 && ph !== 'night' && w.pop > 20 && roll(0.03)) {
      this._osc({ freq: 520, dur: 0.22, vol: 0.03, type: 'square', when: at(), lp: 1400, bus });
    }
  }

  _chirp(when, base, n, bus) {
    for (let i = 0; i < n; i++) {
      const f = base * (0.9 + this._rnd() * 0.3);
      this._osc({ freq: f, to: f * (1.25 + this._rnd() * 0.5), dur: 0.05, vol: 0.045, when: when + i * 0.07, type: 'sine', atk: 0.006, bus });
    }
  }

  _cricket(when, bus) {
    const f = 4300 + this._rnd() * 700;
    const n = 3 + Math.floor(this._rnd() * 3);
    for (let i = 0; i < n; i++) this._noise({ when: when + i * 0.06, dur: 0.028, vol: 0.035, freq: f, q: 24, type: 'bandpass', bus });
  }

  _owl(when, bus) {
    this._osc({ freq: 400, to: 350, dur: 0.28, vol: 0.05, when, type: 'sine', atk: 0.05, lp: 700, bus });
    this._osc({ freq: 380, to: 330, dur: 0.34, vol: 0.045, when: when + 0.45, type: 'sine', atk: 0.06, lp: 700, bus });
  }

  _wolf(when, bus) {
    this._osc({ freq: 260, to: 420, dur: 0.5, vol: 0.045, when, type: 'sawtooth', atk: 0.2, lp: 900, bus });
    this._osc({ freq: 420, to: 300, dur: 0.9, vol: 0.04, when: when + 0.5, type: 'sawtooth', atk: 0.1, lp: 800, bus });
  }

  _clank(when, bus) {
    const f = 300 + this._rnd() * 260;
    this._osc({ freq: f, dur: 0.11, vol: 0.035, when, type: 'square', lp: 2600, bus });
    this._osc({ freq: f * 1.43, dur: 0.08, vol: 0.025, when: when + 0.005, type: 'square', lp: 3200, bus });
    this._noise({ when, dur: 0.06, vol: 0.02, freq: 2000, q: 1, type: 'highpass', bus });
  }

  // ---------------------------------------------------------------- музыка --
  setMusic(base64mp3) { this.musicData = base64mp3; }

  startMusic() {
    if (!this.musicEnabled) return;
    if (this.musicData && !this.musicEl) {
      try {
        this.musicEl = new Audio(this.musicData);
        this.musicEl.loop = true;
        this.musicEl.volume = this.vol.master * this.vol.music;
        this.musicEl.play().catch(() => { });
      } catch { this.musicEl = null; }
    }
    // Без встроенной темы играем синтезом — фон всё равно должен быть.
    if (!this.musicEl) this._musicNext = this.ctx ? this.ctx.currentTime + 1 : 0;
  }

  // Генеративная тема: медленная смена аккордов в ладу текущей эпохи.
  // Включается только если встроенного трека нет — спорить с ним не нужно.
  _musicTick() {
    if (!this.ctx || !this.musicEnabled || this.musicEl) return;
    const now = this.ctx.currentTime;
    if (now < this._musicNext) return;
    const era = Math.min(9, this.world.eraIndex);
    const sc = ERA_SCALE[era], type = ERA_TIMBRE[era];
    const night = this._phase() === 'night';
    const root = 48 + (night ? -5 : 0);
    const deg = Math.floor(this._rnd() * sc.length);
    const bus = this.musicBus;
    const dur = 5.5 + this._rnd() * 2.5;
    // Педаль-квинта плюс два голоса из лада — этого хватает на настроение.
    this._osc({ freq: midi(root), dur, vol: 0.05, type, atk: 1.2, lp: 700, bus });
    this._osc({ freq: midi(root + 7), dur: dur * 0.9, vol: 0.035, type, atk: 1.4, lp: 800, bus });
    this._osc({ freq: midi(root + 12 + sc[deg]), dur: dur * 0.7, vol: 0.03, type: 'sine', atk: 1.0, lp: 1600, bus });
    if (!night && this._rnd() < 0.6) {
      const d2 = (deg + 2) % sc.length;
      this._pluck(midi(root + 24 + sc[d2]), 1.2, 0.03, 1.6, 'sine', bus);
    }
    this._musicNext = now + dur * 0.75;
  }

  // ------------------------------------------------------------------ тик --
  _startTick() {
    if (this._timer || typeof window === 'undefined') return;
    this._timer = window.setInterval(() => {
      if (!this.ctx || this.ctx.state === 'suspended') return;
      this._pollWorld();
      this._ambTick();
      if (this.enabled) this._ambVoices();
      this._musicTick();
    }, 500);
  }

  _stopTick() { if (this._timer) { clearInterval(this._timer); this._timer = 0; } }

  // ------------------------------------------------------------- микшер UI --
  // Своя маленькая панель: HUD — чужая зона, а регуляторы игроку нужны.
  // Открывается по клавише M или вызовом audio.toggleMixer() из интерфейса.
  toggleMixer() { if (this._mixer && this._mixer.style.display !== 'none') this.closeMixer(); else this.openMixer(); }
  closeMixer() { if (this._mixer) this._mixer.style.display = 'none'; }

  openMixer() {
    if (typeof document === 'undefined') return;
    if (!this._mixer) this._buildMixer();
    this._mixer.style.display = 'block';
    this._syncMixer();
  }

  _buildMixer() {
    const box = document.createElement('div');
    box.id = 'audioMixer';
    // Слева внизу: справа боковая панель, по центру — панель постановки,
    // внизу слева свободно (консоль вылезает только по тильде).
    box.style.cssText = 'position:fixed;left:10px;bottom:96px;z-index:60;display:none;width:206px;' +
      'background:rgba(16,22,34,0.94);border:1px solid rgba(201,162,39,0.35);border-radius:12px;' +
      'padding:12px;color:#e8e4d8;font:13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,0.5)';
    const row = (label, key) => `
      <label style="display:block;margin:8px 0 2px;color:#9a958a">${label} <span data-v="${key}" style="float:right;color:#c9a227"></span></label>
      <input type="range" min="0" max="100" data-bus="${key}" style="width:100%;accent-color:#c9a227">`;
    box.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between">' +
      '<b style="color:#c9a227">Звук</b><button data-act="close" style="background:none;border:none;color:#9a958a;font-size:18px;cursor:pointer;line-height:1">×</button></div>' +
      row('Общая', 'master') + row('Музыка', 'music') + row('Эффекты', 'sfx') + row('Окружение', 'amb') +
      '<div style="display:flex;gap:6px;margin-top:12px">' +
      '<button data-act="music" style="flex:1;padding:7px 2px;border-radius:8px;border:1px solid rgba(201,162,39,0.35);background:rgba(201,162,39,0.15);color:#e8e4d8;cursor:pointer;font-size:12px;white-space:nowrap"></button>' +
      '<button data-act="sfx" style="flex:1;padding:7px 2px;border-radius:8px;border:1px solid rgba(201,162,39,0.35);background:rgba(201,162,39,0.15);color:#e8e4d8;cursor:pointer;font-size:12px;white-space:nowrap"></button>' +
      '</div><div style="margin-top:8px;color:#9a958a;font-size:11px">M — скрыть/показать</div>';
    box.addEventListener('input', (e) => {
      const bus = e.target && e.target.getAttribute('data-bus');
      if (bus) this.setVolume(bus, e.target.value / 100);
    });
    box.addEventListener('click', (e) => {
      const act = e.target && e.target.getAttribute('data-act');
      if (act === 'close') this.closeMixer();
      if (act === 'music') { this.toggleMusic(); this._syncMixer(); }
      if (act === 'sfx') { this.toggleSfx(); this.play('click'); this._syncMixer(); }
    });
    document.body.appendChild(box);
    this._mixer = box;
  }

  _syncMixer() {
    const box = this._mixer;
    if (!box) return;
    for (const key of ['master', 'music', 'sfx', 'amb']) {
      const sl = box.querySelector(`input[data-bus="${key}"]`);
      if (sl) sl.value = Math.round(this.vol[key] * 100);
      const lb = box.querySelector(`span[data-v="${key}"]`);
      if (lb) lb.textContent = Math.round(this.vol[key] * 100) + '%';
    }
    const bm = box.querySelector('button[data-act="music"]');
    if (bm) { bm.textContent = '♪ Музыка'; bm.style.opacity = this.musicEnabled ? '1' : '0.45'; }
    const bs = box.querySelector('button[data-act="sfx"]');
    if (bs) { bs.textContent = (this.enabled ? '🔊' : '🔇') + ' Эффекты'; bs.style.opacity = this.enabled ? '1' : '0.45'; }
  }
}
