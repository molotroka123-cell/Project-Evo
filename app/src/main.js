// main.js — ввод (Pointer Events: мышь/палец/стилус) и игровой цикл.
import { Simulation, DAY_SECONDS } from './core/simulation.js';
import { BUILDINGS, ERAS } from './core/data.js';
import { Renderer } from './render/renderer.js';
import { Hud } from './ui/hud.js';
import { BrowserSave } from './save/saveSystem.js';
import { AudioEngine } from './ui/audio.js';
import { ASSET_COVER, ASSET_VICTORY, ASSET_MUSIC } from './ui/assets.js';
import { tileAt } from './core/world.js';

const canvas = document.getElementById('game');
const saveSys = new BrowserSave();
const audio = new AudioEngine();

// Сид можно задать в адресе: ...index.html#seed=4242 — один сид даёт один и тот
// же мир, так что ссылкой удобно делиться миром (и повторять баг-репорты).
function seedFromHash() {
  const m = /(?:^|[#\-&])seed=(\d+)/.exec(location.hash);
  return m ? (+m[1] >>> 0) : (Date.now() % 100000);
}

let sim = new Simulation(seedFromHash(), { factions: 3 });
const renderer = new Renderer(canvas);
const hud = new Hud(sim, renderer, saveSys, audio);
// сгенерированные ассеты: обложка старта, арт победы, музыкальная тема
document.getElementById('overlayArt').style.backgroundImage = `url(${ASSET_COVER})`;
document.getElementById('victoryArt').style.backgroundImage = `url(${ASSET_VICTORY})`;
audio.setMusic(ASSET_MUSIC);
sim.sfx = (n) => audio.play(n);
renderer.cam.x = sim.world.startX;
renderer.cam.y = sim.world.startY;

// Отладочный доступ из консоли браузера и из тестов производительности.
window.__frontier = { get sim() { return sim; }, renderer, hud, audio, saveSys };

// ---------- размещение зданий ----------
function startPlacing(id) {
  sim.placing = { id, x: Math.round(renderer.cam.x), y: Math.round(renderer.cam.y), valid: false, reason: '' };
  updateGhost();
  document.getElementById('placeBar').classList.add('show');
  document.getElementById('sheet').classList.remove('open');
  audio.play('click');
}
function updateGhost() {
  if (!sim.placing) return;
  const chk = sim.canPlace(sim.placing.id, sim.placing.x, sim.placing.y);
  sim.placing.valid = chk.ok;
  sim.placing.reason = chk.ok ? '' : chk.reason;
}
function confirmPlace() {
  if (!sim.placing) return;
  if (!sim.placing.valid) { hud.toast(sim.placing.reason || 'Здесь нельзя строить', 'warn'); audio.play('deny'); return; }
  const { id, x, y } = sim.placing;
  if (sim.placeBuilding(id, x, y)) {
    audio.play('build');
    if (id === 'spire') sim.spire.placed = true;
  }
  sim.placing = null;
  document.getElementById('placeBar').classList.remove('show');
}
function cancelPlace() {
  sim.placing = null;
  document.getElementById('placeBar').classList.remove('show');
}

hud.bind({
  startPlacing,
  confirmPlace,
  cancelPlace,
  save(slot) {
    const ok = saveSys.save(slot, JSON.stringify(sim.serialize()));
    hud.toast(ok ? `Сохранено: ${slot}` : 'Не удалось сохранить', ok ? 'good' : 'bad');
  },
  load(slot) {
    const json = saveSys.load(slot);
    if (!json) { hud.toast('Слот пуст', 'warn'); return; }
    loadFromJson(json);
  },
  importSave(json) { loadFromJson(json); },
  newGame(factions) {
    saveSys.remove('auto');
    sim = newSimulation(Date.now() % 1000000, factions);
    document.getElementById('overlay').classList.add('hidden');
    hud.toast('Новый мир создан. Удачи!', 'good');
    maybeOnboard();
  },
  continueGame() {
    document.getElementById('overlay').classList.add('hidden');
    const auto = saveSys.load('auto');
    if (auto) loadFromJson(auto, true);
    maybeOnboard();
  },
});

function newSimulation(seed, factions) {
  const s = new Simulation(seed, { factions });
  s.sfx = (n) => audio.play(n);
  hud.sim = s;
  sim = s;
  renderer.cam.x = s.world.startX;
  renderer.cam.y = s.world.startY;
  renderer.mapSeason = -1;
  hud._victoryShown = false;
  return s;
}

function loadFromJson(json, silent) {
  const r = Simulation.deserialize(json);
  if (!r.ok) { hud.toast(r.reason, 'bad'); return; }
  r.sim.sfx = (n) => audio.play(n);
  hud.sim = r.sim;
  sim = r.sim;
  renderer.cam.x = sim.world.startX;
  renderer.cam.y = sim.world.startY;
  renderer.mapSeason = -1;
  hud._victoryShown = !!sim.won && !sim.freePlay;
  if (!silent) hud.toast('Сейв загружен', 'good');
}

// ---------- онбординг (один раз) ----------
function maybeOnboard() {
  // Safari в приватном режиме и при «блокировать все куки» кидает SecurityError
  // на любом обращении к localStorage. Без try игра умирала прямо здесь,
  // до первого кадра — «не начинается» именно так и выглядело.
  try { if (localStorage.getItem('frontier_coached')) return; } catch { return; }
  const steps = [
    { x: 20, y: 60, text: '👆 Это <b>ресурсы</b>: еда, дерево, камень, сталь, золото и знания. Следи за едой — без неё жители умирают.', btn: 'Дальше' },
    { x: 20, y: window.innerHeight - 220, text: '🏗 Открой <b>СТРОЙКУ</b> внизу и выбери Хижину: перетащи призрак по карте и нажми ✓.', btn: 'Понял' },
    { x: 20, y: window.innerHeight - 220, text: '📜 Во вкладке <b>НАУКА</b> открывай технологии — они ведут сквозь эпохи к Шпилю.', btn: 'Понял' },
    { x: 20, y: window.innerHeight - 220, text: '🎯 <b>ЦЕЛИ</b> ведут тебя от первого костра до звёзд. Удачи, основатель!', btn: 'Играть!' },
  ];
  let i = 0;
  const next = () => {
    i++;
    if (i >= steps.length) { hud.hideCoach(); return; }
    hud.coachStep(i, steps[i].x, steps[i].y, steps[i].text, steps[i].btn, next);
  };
  hud.coachStep(0, steps[0].x, steps[0].y, steps[0].text, steps[0].btn, next);
}

// ---------- Pointer Events ----------
const pointers = new Map();
let dragging = false, dragMoved = false, lastPinch = 0, panVel = { x: 0, y: 0 }, downPos = null, downTime = 0, longPressTimer = null;

canvas.addEventListener('pointerdown', e => {
  audio.unlock();
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    downPos = { x: e.clientX, y: e.clientY };
    downTime = performance.now();
    dragMoved = false;
    panVel = { x: 0, y: 0 };
    // долгий тап — карточка здания
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      if (!dragMoved && pointers.size === 1) {
        const w = renderer.screenToWorld(e.clientX, e.clientY);
        const b = sim.buildingAt(Math.floor(w.x), Math.floor(w.y));
        if (b) { hud.showBuildingCard(b); audio.play('click'); }
      }
    }, 450);
  }
  if (pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    lastPinch = Math.hypot(p1.x - p2.x, p1.y - p2.y);
  }
});

canvas.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 2) {
    // pinch-zoom к средней точке
    const [p1, p2] = [...pointers.values()];
    const pinch = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    if (lastPinch > 0) {
      const factor = pinch / lastPinch;
      zoomAt(mid.x, mid.y, factor);
    }
    lastPinch = pinch;
    dragMoved = true;
    return;
  }
  if (pointers.size !== 1) return;

  if (downPos && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6) {
    dragMoved = true;
    clearTimeout(longPressTimer);
  }
  if (dragMoved) {
    if (sim.placing) {
      // тащим призрак
      const w = renderer.screenToWorld(e.clientX, e.clientY);
      sim.placing.x = Math.floor(w.x);
      sim.placing.y = Math.floor(w.y);
      updateGhost();
    } else {
      // панорама камеры
      const z = 32 * renderer.cam.zoom;
      renderer.cam.x -= dx / z;
      renderer.cam.y -= dy / z;
      panVel = { x: -dx / z, y: -dy / z };
      clampCam();
    }
  }
});

canvas.addEventListener('pointerup', e => {
  pointers.delete(e.pointerId);
  clearTimeout(longPressTimer);
  if (pointers.size < 2) lastPinch = 0;
  if (pointers.size === 0) {
    // тап без движения — выбор
    if (!dragMoved && downPos && performance.now() - downTime < 400) {
      const w = renderer.screenToWorld(e.clientX, e.clientY);
      if (sim.placing) {
        sim.placing.x = Math.floor(w.x);
        sim.placing.y = Math.floor(w.y);
        updateGhost();
      } else {
        const b = sim.buildingAt(Math.floor(w.x), Math.floor(w.y));
        if (b && e.pointerType === 'mouse') hud.showBuildingCard(b);
      }
    }
    downPos = null;
    setTimeout(() => { dragMoved = false; }, 50);
  }
});
canvas.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); lastPinch = 0; clearTimeout(longPressTimer); });
canvas.addEventListener('contextmenu', e => { e.preventDefault(); if (sim.placing) cancelPlace(); });

function zoomAt(sx, sy, factor) {
  const before = renderer.screenToWorld(sx, sy);
  renderer.cam.zoom = Math.max(0.4, Math.min(3.0, renderer.cam.zoom * factor));
  const after = renderer.screenToWorld(sx, sy);
  renderer.cam.x += before.x - after.x;
  renderer.cam.y += before.y - after.y;
  clampCam();
}

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 0.89);
}, { passive: false });

function clampCam() {
  renderer.cam.x = Math.max(0, Math.min(96, renderer.cam.x));
  renderer.cam.y = Math.max(0, Math.min(96, renderer.cam.y));
}

// миникарта: тап — прыжок камеры
canvas.addEventListener('click', e => {
  const m = renderer.minimapRect;
  if (!m) return;
  if (e.clientX >= m.x && e.clientX <= m.x + m.w && e.clientY >= m.y && e.clientY <= m.y + m.h) {
    renderer.cam.x = (e.clientX - m.x) / m.scale;
    renderer.cam.y = (e.clientY - m.y) / m.scale;
    clampCam();
  }
});

// ---------- клавиатура ----------
const keys = new Set();
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  keys.add(e.key.toLowerCase());
  if (e.key === ' ') { e.preventDefault(); hud.togglePause(); }
  if (e.key === '1') hud.setSpeed(1);
  if (e.key === '2') hud.setSpeed(2);
  if (e.key === '3' || e.key === '4') hud.setSpeed(8);
  if (e.key === 'Escape') {
    if (sim.placing) cancelPlace();
    else if (document.getElementById('modalWrap').classList.contains('show')) hud.closeModal();
    else hud.showMenu();
  }
  if (e.key === '`' || e.key === '~' || e.key === 'ё') hud.toggleConsole();
  if (e.key === 'b' || e.key === 'B') hud.setTab('build');
  if (e.key === 'r' || e.key === 'R') hud.setTab('research');
  if (e.key === 't' || e.key === 'T') hud.setTab('army');
  if (e.key === '+' || e.key === '=') zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.15);
  if (e.key === '-') zoomAt(window.innerWidth / 2, window.innerHeight / 2, 0.87);
});
document.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));

// ---------- цикл ----------
let last = performance.now();
let hudTimer = 0;
function frame(now) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  // клавиатурная камера
  const camSpeed = 30 * dtReal / renderer.cam.zoom;
  if (keys.has('w') || keys.has('arrowup')) renderer.cam.y -= camSpeed;
  if (keys.has('s') || keys.has('arrowdown')) renderer.cam.y += camSpeed;
  if (keys.has('a') || keys.has('arrowleft')) renderer.cam.x -= camSpeed;
  if (keys.has('d') || keys.has('arrowright')) renderer.cam.x += camSpeed;
  clampCam();
  // инерция пана
  if (!dragMoved && (Math.abs(panVel.x) > 0.01 || Math.abs(panVel.y) > 0.01)) {
    renderer.cam.x += panVel.x * dtReal * 8;
    renderer.cam.y += panVel.y * dtReal * 8;
    panVel.x *= 0.9; panVel.y *= 0.9;
    clampCam();
  }
  // симуляция
  if (!sim.paused) {
    sim.tick((dtReal / DAY_SECONDS) * hud.speed);
  }
  // HUD
  hudTimer += dtReal;
  if (hudTimer > 0.25) {
    hudTimer = 0;
    try { hud.refresh(); } catch (err) { console.error('HUD_REFRESH_FAIL', err && err.stack || err); }
  }
  // автосейв
  if (sim.autosaveRequested) {
    sim.autosaveRequested = false;
    saveSys.save('auto', JSON.stringify(sim.serialize()));
  }
  // скриншот из консоли
  if (sim._screenshotRequested) {
    sim._screenshotRequested = false;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `frontier-day${sim.day}.png`;
    a.click();
  }
  renderer.draw(sim, dtReal);
  requestAnimationFrame(frame);
}

// ---------- автосейв при уходе ----------
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveSys.save('auto', JSON.stringify(sim.serialize()));
});
window.addEventListener('beforeunload', () => saveSys.save('auto', JSON.stringify(sim.serialize())));

// ---------- resize ----------
function onResize() { renderer.resize(); }
window.addEventListener('resize', onResize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
onResize();

// стартовый экран: есть ли автосейв
document.getElementById('btnContinue').style.display = saveSys.load('auto') ? '' : 'none';

// тестовый авто-старт по хэшу: #autostart / #autostart-era8 / #autostart-win
if (location.hash.startsWith('#autostart')) {
  document.getElementById('overlay').classList.add('hidden');
  if (location.hash.includes('era8')) {
    sim.execCommand('godmode'); sim.execCommand('unlockall');
    sim.execCommand('give food 99999'); sim.execCommand('give gold 99999'); sim.execCommand('give steel 99999'); sim.execCommand('give stone 99999');
    sim.execCommand('spawn 40');
    sim.eraIndex = 8;
    for (let i = 0; i < 200; i++) sim.tick(0.5);
  }
  if (location.hash.includes('win')) {
    sim.execCommand('godmode'); sim.execCommand('unlockall'); sim.eraIndex = 9;
    sim.placeBuilding('spire', 50, 50);
    sim.buildings.find(b => b.id === 'spire').done = true;
    sim.execCommand('spire stage 5');
  }
  if (location.hash.includes('placing')) startPlacing('farm');
  try { localStorage.setItem('frontier_coached', '1'); } catch { /* не критично */ }
}
// первый прогон HUD сразу, чтобы панель не ждала таймер
hud.refresh();
requestAnimationFrame(frame);
