// render/quality.js — пресеты графики, уровни детализации и потолки кэшей.
//
// Пресет — единственное место, где записано «сколько игра себе позволяет».
// Он решает разрешение выпечки карты, плотность холста, набор пост-эффектов,
// с какого зума перестают рисоваться жители и сколько мегабайт текстур
// разрешено держать в кэшах.
//
// Числа не выдуманы: они взяты из замеров в docs/visual-performance-budget.md
// (метод А — время кадра с getImageData, метод Б — живой цикл без vsync).
// Стенд там — SwiftShader, то есть растеризация на CPU: считайте эти числа
// поведением на слабом ноутбуке с интегрированным видео.
//
// ЧТО ЧИТАТЬ ДРУГИМ МОДУЛЯМ (всё это поля пресета, не приватные детали):
//   q.tilePx, q.tilePxFar   — разрешение выпечки чанка вблизи и вдали
//   q.lod.*                 — с какого зума что перестаёт рисоваться
//   q.caps.*                — потолки кэшей и потолки количества в кадре
//   q.budget.*              — во что пресет обязан укладываться
//   lodForZoom(q, zoom)     — готовое решение «что рисуем на этом зуме»
//   resolveDpr(q, dpr, w, h)— плотность холста с ограничением по площади
//   prune(map, opts)        — вытеснение LRU для любого кэша канвасов

export const QUALITY_ORDER = ['eco', 'medium', 'high', 'ultra'];

// Зум, ниже которого сцена считается «дальней»: тайл на экране мельче 22 px,
// детали не читаются физически, и всё, что дороже блита, — выброшенное время.
const FAR_ZOOM = 0.7;

// Плотность холста ограничивается не числом, а площадью: телефон 412×915 с
// dpr 3 даёт 3,4 млн пикселей — вдвое больше десктопа 1600×900 при dpr 1.
// Ниже 1 не опускаемся никогда: мыло на весь экран хуже просадки.
export function resolveDpr(q, devicePixelRatio, cssW, cssH) {
  const dpr = Math.max(0.5, devicePixelRatio || 1);
  const area = Math.max(1, (cssW || 1280) * (cssH || 720));
  const byArea = Math.sqrt(q.maxCanvasPx / area);
  return Math.max(1, Math.min(q.dprCap, dpr, byArea));
}

// Общая часть пресета: поля, которые почти всегда одинаковы, чтобы в самих
// пресетах остались только осмысленные различия.
function preset(o) {
  return {
    ...o,
    // Плотность холста читается через геттер: renderer берёт maxDpr в момент
    // применения пресета, и правило «не больше N пикселей на экран» должно
    // сработать там же, без правок в чужом файле.
    get maxDpr() {
      const w = typeof window === 'undefined' ? 1280 : (window.innerWidth || 1280);
      const h = typeof window === 'undefined' ? 720 : (window.innerHeight || 720);
      const dpr = typeof window === 'undefined' ? 1 : (window.devicePixelRatio || 1);
      return resolveDpr(this, dpr, w, h);
    },
  };
}

export const QUALITY = {
  // ЭКОНОМИЯ — цель: 60 FPS на слабом телефоне. Ничего, что стоит дороже
  // блита, здесь нет: ни рельефа, ни воды, ни теней, ни единого пост-эффекта.
  eco: preset({
    id: 'eco', ru: 'Экономия',
    richVeg: false,     // живая растительность: замер в renderer.draw
    richRelief: false,  // рельефная светотень: замер в renderer.draw
    richWater: false,   // богатая вода: см. замер в renderer.draw
    tilePx: 16, tilePxFar: 8,
    dprCap: 1, maxCanvasPx: 1.6e6,
    relief: false, shoreFoam: false, water: false, clouds: false, shadows: false,
    bloom: false, bloomDiv: 8, godRays: false, vignette: false,
    grain: 0, grainCss: 0, saturation: false, softLight: false,
    particles: 0.2, detail: 0, ambientProps: false, birds: false, fireflies: false,
    lod: {
      // На eco жители исчезают раньше всех: при зуме 1 человечек занимает
      // 11 px, и 200 таких стоят дороже всего города.
      peopleMinZoom: 1.0, peopleDetail2Zoom: 99, beastMinZoom: 1.1,
      propsMinZoom: 99, shadowMinZoom: 99, foamMinZoom: 99, waterMinZoom: 99,
      buildingGlowMinZoom: 1.2, crowdGlow: true,
    },
    caps: {
      textureMB: 24,
      spriteMB: 10, spriteEntries: 48,
      chunkMB: 8, chunkCount: 12,
      peopleMB: 5, peopleSheets: 16,
      bakesPerFrame: 1, chunksPerFrame: 6,
      buildings: 120, people: 90, beasts: 20,
    },
    budget: { frameMs: 16.6, farFrameMs: 10 },
  }),

  // СРЕДНЕ — цель: 60 FPS на слабом ноутбуке и на телефоне (guessQuality
  // отдаёт телефонам именно этот пресет). Есть рельеф, вода, тени и облака;
  // нет свечения, лучей и зерна — три самых дорогих слоя.
  medium: preset({
    id: 'medium', ru: 'Средне',
    richVeg: false,     // живая растительность: замер в renderer.draw
    richRelief: false,  // рельефная светотень: замер в renderer.draw
    richWater: false,   // богатая вода: см. замер в renderer.draw
    tilePx: 24, tilePxFar: 12,
    dprCap: 1.5, maxCanvasPx: 2.5e6,
    relief: true, shoreFoam: true, water: true, clouds: true, shadows: true,
    bloom: false, bloomDiv: 8, godRays: false, vignette: true,
    grain: 0, grainCss: 0, saturation: false, softLight: false,
    particles: 0.5, detail: 1, ambientProps: true, birds: false, fireflies: true,
    lod: {
      peopleMinZoom: 0.85, peopleDetail2Zoom: 2.2, beastMinZoom: 0.9,
      propsMinZoom: 1.0, shadowMinZoom: 0.8, foamMinZoom: 0.7, waterMinZoom: 0.6,
      buildingGlowMinZoom: 0.8, crowdGlow: true,
    },
    caps: {
      textureMB: 48,
      spriteMB: 18, spriteEntries: 80,
      chunkMB: 14, chunkCount: 18,
      peopleMB: 9, peopleSheets: 24,
      bakesPerFrame: 1, chunksPerFrame: 8,
      buildings: 160, people: 180, beasts: 36,
    },
    budget: { frameMs: 16.6, farFrameMs: 12 },
  }),

  // ВЫСОКО — цель: 60 FPS на обычном десктопе. Полный набор слоёв, кроме
  // зерна. Это пресет по умолчанию для десктопа и потолок авто-тюнера.
  high: preset({
    id: 'high', ru: 'Высоко',
    richVeg: true,     // живая растительность: замер в renderer.draw
    richRelief: false,  // рельефная светотень: замер в renderer.draw
    richWater: false,  // богатая вода: см. замер в renderer.draw
    tilePx: 32, tilePxFar: 16,
    dprCap: 2, maxCanvasPx: 4.5e6,
    relief: true, shoreFoam: true, water: true, clouds: true, shadows: true,
    bloom: true, bloomDiv: 6, godRays: true, vignette: true,
    grain: 0, grainCss: 0, saturation: false, softLight: false,
    particles: 0.8, detail: 2, ambientProps: true, birds: true, fireflies: true,
    lod: {
      peopleMinZoom: 0.7, peopleDetail2Zoom: 1.6, beastMinZoom: 0.75,
      propsMinZoom: 0.8, shadowMinZoom: 0.65, foamMinZoom: 0.55, waterMinZoom: 0.45,
      buildingGlowMinZoom: 0.6, crowdGlow: true,
    },
    caps: {
      textureMB: 96,
      spriteMB: 32, spriteEntries: 120,
      chunkMB: 24, chunkCount: 24,
      peopleMB: 16, peopleSheets: 40,
      bakesPerFrame: 1, chunksPerFrame: 12,
      buildings: 200, people: 300, beasts: 60,
    },
    budget: { frameMs: 16.6, farFrameMs: 14 },
  }),

  // УЛЬТРА — цель: 60 FPS на мощном десктопе, а не «включить всё и молиться».
  //
  // Прежняя «ультра» отличалась от «высоко» ровно двумя вещами и стоила за них
  // 12,5 мс из 16,6 (замер: 26,3 FPS, не играбельно):
  //   grain 0,030  — ~8 мс на полноэкранную заливку паттерном в режиме overlay
  //                  каждый кадр ради эффекта прозрачностью 3 %;
  //   bloomDiv 4   — ~4,5 мс на ореолы вдвое большего радиуса.
  // Зерно ушло из кадра в поле grainCss: тот же эффект композитится браузером
  // отдельным CSS-слоем поверх канваса и стоит ноль работы в кадре
  // (docs/visual-performance-budget.md §5.4, «правильно»).
  // Взамен «ультра» получила то, что действительно видно и стоит дёшево:
  // жители и живность видны с дальнего зума, полный реквизит, максимум частиц,
  // мягкий свет, вдвое больше потолки кэшей и разрешена вторая выпечка за кадр.
  ultra: preset({
    id: 'ultra', ru: 'Ультра',
    richVeg: true,     // живая растительность: замер в renderer.draw
    richRelief: true,  // рельефная светотень: замер в renderer.draw
    richWater: true,  // богатая вода: см. замер в renderer.draw
    tilePx: 32, tilePxFar: 16,
    dprCap: 2, maxCanvasPx: 6.5e6,
    relief: true, shoreFoam: true, water: true, clouds: true, shadows: true,
    bloom: true, bloomDiv: 5, godRays: true, vignette: true,
    // grain — цена в кадре; grainCss — та же плёнка, но слоем поверх канваса.
    grain: 0, grainCss: 0.030, grainFps: 8,
    saturation: true, softLight: true,
    particles: 1.0, detail: 2, ambientProps: true, birds: true, fireflies: true,
    lod: {
      peopleMinZoom: 0.6, peopleDetail2Zoom: 1.3, beastMinZoom: 0.6,
      propsMinZoom: 0.6, shadowMinZoom: 0.5, foamMinZoom: 0.45, waterMinZoom: 0.4,
      buildingGlowMinZoom: 0.5, crowdGlow: true,
    },
    caps: {
      textureMB: 128,
      spriteMB: 44, spriteEntries: 160,
      chunkMB: 32, chunkCount: 28,
      peopleMB: 20, peopleSheets: 48,
      bakesPerFrame: 2, chunksPerFrame: 14,
      buildings: 260, people: 420, beasts: 80,
    },
    budget: { frameMs: 16.6, farFrameMs: 16 },
  }),
};

// Готовое решение «что рисуем на этом зуме». Один вызов на кадр, дальше
// читаются поля — чтобы пороги не расползлись по десяти файлам числами.
export function lodForZoom(q, zoom) {
  const z = zoom || 1;
  const L = q.lod;
  const far = z < FAR_ZOOM;
  return {
    far,
    // разрешение выпечки чанка: вдали кладём вдвое грубее — на экране тайл
    // всё равно меньше 22 px, разницы не видно, а блита вдвое меньше
    tilePx: far ? q.tilePxFar : q.tilePx,
    people: z >= L.peopleMinZoom,
    // 0/1/2 — сколько деталей у человечка; вдали хватает силуэта
    peopleDetail: z >= L.peopleDetail2Zoom ? Math.min(2, q.detail)
      : z >= L.peopleMinZoom ? Math.min(1, q.detail) : 0,
    // жителей не видно — вместо толпы тёплое пятно над кварталом
    crowdGlow: L.crowdGlow && z < L.peopleMinZoom,
    beasts: z >= L.beastMinZoom,
    props: q.ambientProps && z >= L.propsMinZoom,
    shadows: q.shadows && z >= L.shadowMinZoom,
    foam: q.shoreFoam && z >= L.foamMinZoom,
    water: q.water && z >= L.waterMinZoom,
    buildingGlow: z >= L.buildingGlowMinZoom,
    maxPeople: far ? 0 : q.caps.people,
    maxBeasts: far ? Math.round(q.caps.beasts * 0.3) : q.caps.beasts,
    maxBuildings: q.caps.buildings,
    frameBudgetMs: far ? q.budget.farFrameMs : q.budget.frameMs,
  };
}

// Вытеснение по LRU для любого кэша offscreen-канвасов.
// Map в JS хранит порядок вставки, поэтому «трогание» ключа — это удалить и
// вставить заново; тогда самый старый всегда первый в итераторе.
// bytesOf(value) должен вернуть размер записи в байтах (w*h*4 по канвасам).
export function touch(map, key) {
  if (!map.has(key)) return;
  const v = map.get(key);
  map.delete(key); map.set(key, v);
}

export function prune(map, { maxEntries = Infinity, maxBytes = Infinity, bytesOf = null } = {}) {
  let dropped = 0;
  while (map.size > maxEntries) {
    const k = map.keys().next().value;
    map.delete(k); dropped++;
  }
  if (bytesOf && maxBytes < Infinity) {
    let total = 0;
    for (const v of map.values()) total += bytesOf(v) || 0;
    while (total > maxBytes && map.size > 1) {
      const k = map.keys().next().value;
      total -= bytesOf(map.get(k)) || 0;
      map.delete(k); dropped++;
    }
  }
  return dropped;
}

// Размер канваса в байтах — то, чем обычно кормят prune().
export function canvasBytes(cv) {
  return cv && cv.width ? cv.width * cv.height * 4 : 0;
}

const LS_KEY = 'frontier_quality';

export function loadQualityId() {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === 'auto' || QUALITY[v]) return v;
  } catch { /* приватный режим — работаем без сохранения */ }
  return 'auto';
}

export function saveQualityId(id) {
  try { localStorage.setItem(LS_KEY, id); } catch { /* не критично */ }
}

// ---------------------------------------------------------------------------
// Авто-тюнер.
//
// Прежний работал только вниз, срабатывал ровно один раз за сессию и ничего не
// знал про зум. Город из 20 домов и город из 200 — разная нагрузка, а тюнер
// уже отработал на первой минуте; игрок, просевший из-за фонового процесса,
// оставался на «экономии» навсегда.
//
// Здесь скользящее окно 5 секунд, работа в обе стороны и гистерезис:
// снижаем при p95 > 22 мс, повышаем только если p95 держится ниже 11 мс
// двадцать секунд подряд. Между переключениями — пауза 8 секунд: смена
// пресета чистит все кэши спрайтов, и дёргать её туда-сюда дороже, чем терпеть.
// Кадры во время панорамы и зума в статистику не идут — там выпекаются новые
// чанки, и мерить по ним всё равно что мерить скорость машины на светофоре.
export function makeAutoTuner(startId, opts = {}) {
  const WINDOW = 5;          // с, скользящее окно
  const DOWN_MS = 22;        // p95 выше — снижаем ступень
  const UP_MS = 11;          // p95 ниже — копим право на повышение
  const UP_HOLD = 20;        // с непрерывного запаса, чтобы повысить
  const DWELL = 8;           // с покоя после любого переключения
  const WARMUP = 1.5;        // с прогрева: компиляция, первые выпечки
  const BUSY_TAIL = 0.4;     // с после панорамы, которые всё ещё не считаем

  const ceilIdx = QUALITY_ORDER.indexOf(opts.maxId || 'high');
  const floorIdx = QUALITY_ORDER.indexOf(opts.minId || 'eco');
  let current = QUALITY[startId] ? startId : guessQuality();
  // Игрок мог выбрать «ультра» руками — тогда потолок поднимается до неё.
  const ceiling = Math.max(ceilIdx, QUALITY_ORDER.indexOf(current));

  let enabled = opts.enabled !== false;
  let age = 0;               // с с начала наблюдения
  let dwell = 0;             // с с последнего переключения
  let goodRun = 0;           // с подряд с запасом по кадру
  let busy = 0;              // с до конца «шумного» периода
  let sinceEval = 0;
  let lastP95 = 0;
  const buf = [];            // [{t, ms}] за последние WINDOW секунд

  return {
    get current() { return current; },
    // Совместимость с прежним API: тюнер больше не «доделывает» работу,
    // но код, который спрашивал про done, не должен ломаться.
    get done() { return !enabled; },
    get p95() { return lastP95; },
    stats() { return { p95: +lastP95.toFixed(1), frames: buf.length, goodRun: +goodRun.toFixed(1), current }; },
    // Renderer/ввод могут сообщить, что камера едет — тогда кадры не считаются.
    notePan() { busy = BUSY_TAIL; },
    setEnabled(v) { enabled = !!v; },

    sample(dt) {
      if (!enabled || !(dt > 0)) return null;
      age += dt; dwell += dt; sinceEval += dt;
      if (busy > 0) { busy -= dt; return null; }
      if (age < WARMUP) return null;

      const ms = dt * 1000;
      // Один выброс в 300 мс — это не просадка рендера, это сборка мусора или
      // переключение вкладки. В окно такие кадры не пускаем.
      if (ms < 300) buf.push({ t: age, ms });
      while (buf.length && age - buf[0].t > WINDOW) buf.shift();

      if (sinceEval < 0.5) return null;      // считать p95 каждый кадр незачем
      sinceEval = 0;
      if (buf.length < 30) return null;

      const sorted = buf.map(b => b.ms).sort((a, b) => a - b);
      lastP95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];

      goodRun = lastP95 < UP_MS ? goodRun + 0.5 : 0;
      if (dwell < DWELL) return null;

      if (lastP95 > DOWN_MS) return step(-1);
      if (goodRun >= UP_HOLD) return step(1);
      return null;
    },
  };

  function step(dir) {
    const i = QUALITY_ORDER.indexOf(current);
    const ni = Math.max(floorIdx, Math.min(ceiling, i + dir));
    if (ni === i) { goodRun = 0; dwell = 0; return null; }
    current = QUALITY_ORDER[ni];
    buf.length = 0; dwell = 0; goodRun = 0; sinceEval = 0;
    return current;
  }
}

// Стартовая догадка по железу до всяких замеров.
export function guessQuality() {
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (mem <= 2 || cores <= 2) return 'eco';
  // Телефон всегда получает medium и никогда high: замер high при dpr 2 —
  // 41,4 мс на кадр, то есть 24 FPS. Плотный экран больше не повод понижать
  // пресет — площадь холста теперь ограничивает resolveDpr (maxCanvasPx).
  if (coarse) return 'medium';
  if (mem <= 4 && cores <= 4) return 'medium';
  // ultra намеренно НЕ выдаётся автоматически: даже после чистки она остаётся
  // пресетом «у меня хватит», а не подарком каждому десктопу. Выбирается руками.
  return 'high';
}
