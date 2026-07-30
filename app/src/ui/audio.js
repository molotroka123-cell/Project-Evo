// ui/audio.js — звук: WebAudio-синтез SFX + фоновая музыка (base64 mp3 опционально).
// Никаких внешних файлов и сети: всё синтезируется локально.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.musicEnabled = true;
    this.musicEl = null;
    this.unlocked = false;
  }

  // вызывать по первому жесту пользователя (политика браузеров)
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    } catch { this.ctx = null; }
    if (this.musicEnabled) this.startMusic();
  }

  setMusic(base64mp3) {
    this.musicData = base64mp3;
  }

  startMusic() {
    if (!this.musicData || this.musicEl) return;
    try {
      this.musicEl = new Audio(this.musicData);
      this.musicEl.loop = true;
      this.musicEl.volume = 0.25;
      this.musicEl.play().catch(() => { });
    } catch { }
  }

  toggleMusic() {
    this.musicEnabled = !this.musicEnabled;
    if (this.musicEl) {
      if (this.musicEnabled) this.musicEl.play().catch(() => { });
      else this.musicEl.pause();
    } else if (this.musicEnabled) this.startMusic();
    return this.musicEnabled;
  }

  toggleSfx() { this.enabled = !this.enabled; return this.enabled; }

  tone(freq, dur, type = 'sine', vol = 0.3, when = 0, slide = 0) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  play(name) {
    if (!this.ctx || !this.enabled) return;
    switch (name) {
      case 'click': this.tone(660, 0.06, 'square', 0.12); break;
      case 'deny': this.tone(120, 0.18, 'sawtooth', 0.2, 0, -40); break;
      case 'build':
        this.tone(220, 0.12, 'triangle', 0.25);
        this.tone(330, 0.12, 'triangle', 0.25, 0.09);
        this.tone(440, 0.2, 'triangle', 0.25, 0.18);
        break;
      case 'tech':
        [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.15, 'sine', 0.2, i * 0.07));
        break;
      case 'fanfare':
        [392, 523, 659, 784].forEach((f, i) => this.tone(f, 0.3, 'square', 0.15, i * 0.12));
        this.tone(1046, 0.5, 'square', 0.15, 0.5);
        break;
      case 'raid':
        this.tone(98, 0.7, 'sawtooth', 0.3, 0, -30);
        this.tone(92, 0.7, 'sawtooth', 0.3, 0.25, -30);
        break;
      case 'alarm':
        this.tone(440, 0.15, 'square', 0.2);
        this.tone(440, 0.15, 'square', 0.2, 0.2);
        break;
      case 'victory':
        [523, 659, 784, 1046, 1318].forEach((f, i) => this.tone(f, 0.4, 'triangle', 0.22, i * 0.15));
        this.tone(1568, 0.9, 'triangle', 0.2, 0.8);
        break;
      case 'coin': this.tone(988, 0.08, 'square', 0.15); this.tone(1319, 0.15, 'square', 0.15, 0.07); break;
      case 'era':
        [262, 330, 392, 523].forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.2, i * 0.16));
        break;
    }
  }
}
