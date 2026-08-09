// render3d/scene3d.js — настоящая трёхмерная сцена на Three.js.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ
// Canvas 2D упёрся в потолок: у него нет буфера глубины, нет источников света,
// нет материалов. Всё, что выглядело объёмом, было нарисовано вручную —
// перекошенный силуэт вместо тени, градиент по грани вместо освещения. Здесь
// объём настоящий: геометрия, солнце, теневая карта, туман.
//
// ЧТО ЭТОТ ФАЙЛ НЕ ДЕЛАЕТ И НЕ БУДЕТ ДЕЛАТЬ
// Он НЕ трогает симуляцию. Ни одной записи в sim: сцена только читает мир и
// строит по нему меши. Ровно поэтому переход на 3D не переписывает игру —
// ядро (app/src/core/*) не знает про экран вообще, и все 762 проверки остаются
// в силе. Заменяется слой рисования, а не правила.
//
// СЛУЧАЙНОСТЬ. sim.rng здесь запрещён, как и во всех модулях рендера: рендер
// идёт с разной частотой у разных игроков, и каждый его вызов сдвинул бы
// состояние симуляции — сейв бы поплыл. Свой детерминированный хеш от
// world.seed, как в water.js и relief.js.
//
// МАСШТАБ. Одна клетка мира = одна единица сцены. Высоты берутся из той же
// таблицы ARCH_H, что и у спрайтов (sprites.archHeight), чтобы город в 3D имел
// те же пропорции, что игрок уже видел: хижина 0.9 клетки, шпиль 4.2.
import * as THREE from 'three';
import { TILE } from '../core/data.js';
import { ARCH, archHeight } from '../render/sprites.js';

// Высота мира в единицах сцены при elev = 1, то есть у самой высокой горы.
//
// ЧИСЛО ВЫСТРАДАНО. Первая версия брала преувеличение 2.9 из relief.js и
// множила на 6 — гора получалась в 16 клеток, то есть вчетверо выше замка, и
// город терялся в ущелье между отвесными стенами. Причина ошибки в том, что
// 2.9 в relief.js применялось к РАСЧЁТУ ОСВЕЩЕНИЯ (насколько круто повёрнута
// грань), а не к настоящей геометрии: там преувеличение подчёркивало форму на
// плоской картинке, здесь оно её ломает. В 3D преувеличение уже не нужно —
// объём виден сам, его показывает камера.
//
// 4.2 значит: гора поднимается примерно на 4 клетки — вдвое выше замка (2.1)
// и заметно выше жилого квартала, но не закрывает его собой.
const ELEV_SCALE = 5.2;

// Сколько раз сгладить поле высот. worldgen2 выводит elev из ТИПА клетки
// («вода < песок < трава < холм < гора»), то есть высота там ступенчатая: между
// травой (0.2) и холмом (0.55) разрыв в треть высоты мира на одну клетку. На
// плоской картинке это незаметно, а в геометрии каждая такая ступень —
// вертикальный обрыв.
//
// Но одним сглаживанием дело не решается: пять проходов убирают обрывы вместе
// с вершинами, и карта становится блином, на котором гора отличается от луга
// только цветом. Поэтому здесь ДВА действия — сгладить ступени и вернуть форму
// шумом (см. FBM_* ниже). Размытие даёт крупную форму суши, шум — хребты,
// распадки и фактуру склона, которых в исходной карте нет вовсе.
const SMOOTH_PASSES = 4;

// Фрактальный шум поверх сглаженной основы. Амплитуда растёт с высотой: луг
// остаётся лугом, а гора получает изломы. Множитель на равнине маленький
// намеренно — по ровному месту ходят жители и стоят дома.
const FBM_OCTAVES = 5;
const FBM_SCALE = 0.085;   // частота первой октавы, в клетках
const FBM_AMP = 0.085;     // вклад на равнине
const FBM_AMP_HIGH = 0.30; // добавка на вершинах

// Уровень моря в единицах сцены. elev в worldgen2 отрицателен под водой,
// поэтому берег сам собой оказывается там, где нужно.
const SEA = 0;

// Цвета земли по типу клетки. Взяты из палитры 2D-версии, чтобы переход не
// читался как «другая игра»: та же местность, только теперь с объёмом.
const GROUND = {
  [TILE.DEEP]:     0x1d3f5c,
  [TILE.WATER]:    0x2f6b8f,
  [TILE.SAND]:     0xd9c89a,
  [TILE.GRASS]:    0x5d8a3a,
  [TILE.FOREST]:   0x3d6b2c,
  [TILE.HILL]:     0x7a7a55,
  [TILE.MOUNTAIN]: 0x8d8d8d,
};

// Палитра эпох — те же цвета, что eraPalette в renderer.js. Второй копии
// списка быть не должно, но renderer.js держит её методом класса, а не
// экспортом; дублируем ОДИН раз здесь и помечаем, что источник там.
const ERA_PAL = [
  { wall: 0x8a6d4f, roof: 0x6b4f35 }, { wall: 0xc4a06a, roof: 0x8a6d42 },
  { wall: 0x9a8a72, roof: 0x4a4a52 }, { wall: 0xe8e0c8, roof: 0xb08d57 },
  { wall: 0xb59a7a, roof: 0x8a3d2d }, { wall: 0xd4c4a0, roof: 0xa0522d },
  { wall: 0x9a6a52, roof: 0x4a3d35 }, { wall: 0xaab4bc, roof: 0x5a6b7a },
  { wall: 0xc8d4e8, roof: 0x4a5a7a }, { wall: 0xe8f4f8, roof: 0x2d4a5a },
];

// Архетипы, у которых нет крыши: яма, поле, площадка. Ставить на них двускат —
// то же, что накрыть карьер черепицей.
const FLAT_ROOF = new Set(['field', 'quarry', 'mineshaft', 'sewers', 'pad', 'solar',
  'wall', 'woodpile', 'stonepile', 'dock', 'amphi', 'factory', 'flat', 'lab',
  'warehouse', 'highrise', 'tower', 'aicore', 'reactor', 'airport', 'shipyard']);

// Архетипы-башни: узкие и высокие, а не куб во всю клетку.
const SLIM = { spire: 0.30, tower: 0.42, aicore: 0.52, highrise: 0.62, mill: 0.52, silo: 0.46 };

// Высота клетки до сглаживания. Если слоёв worldgen2 нет, восстанавливаем по
// типу клетки — та же таблица, что в самом worldgen2, чтобы две оценки высоты
// не разошлись.
const H_BY_TILE = {
  [TILE.DEEP]: -0.5, [TILE.WATER]: -0.15, [TILE.SAND]: 0.03,
  [TILE.GRASS]: 0.2, [TILE.FOREST]: 0.24, [TILE.HILL]: 0.55, [TILE.MOUNTAIN]: 0.9,
};

// Сглаженное поле высот. Считается один раз на мир и потом переиспользуется:
// его спрашивает и земля, и каждое здание, и каждый житель.
function buildHeightField(world, passes = SMOOTH_PASSES) {
  const w = world.w, h = world.h, N = w * h;
  let a = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    a[i] = world.elev ? world.elev[i] : (H_BY_TILE[world.tiles[i]] ?? 0.2);
  }
  // Разделимое размытие 3×1: два прохода по строкам и столбцам дешевле одного
  // по квадрату и даёт тот же результат.
  let b = new Float32Array(N);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const l = a[y * w + Math.max(0, x - 1)], r = a[y * w + Math.min(w - 1, x + 1)];
        b[i] = (l + a[i] * 2 + r) * 0.25;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const u = b[Math.max(0, y - 1) * w + x], d = b[Math.min(h - 1, y + 1) * w + x];
        a[i] = (u + b[i] * 2 + d) * 0.25;
      }
    }
  }
  // Возвращаем форму, которую съело размытие. Шум детерминирован по сиду мира:
  // одна и та же карта у всех игроков и после перезагрузки.
  const seed = (world.seed >>> 0) ^ 0x2f6e2b1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const base = a[i];
      if (base <= 0) continue;                    // под водой рельеф не нужен
      const amp = FBM_AMP + FBM_AMP_HIGH * Math.min(1, base / 0.7);
      a[i] = base + fbm(x * FBM_SCALE, y * FBM_SCALE, seed) * amp;
    }
  }

  // Дно моря сглаживать дальше нельзя: размытие вытянуло бы берег вверх и
  // мелкие озёра исчезли бы под уровнем воды. Возвращаем воде её глубину.
  for (let i = 0; i < N; i++) {
    const t = world.tiles[i];
    if (t === TILE.DEEP) a[i] = Math.min(a[i], -0.34);
    else if (t === TILE.WATER) a[i] = Math.min(a[i], -0.10);
  }
  return a;
}

// Гладкий шум с интерполяцией по значению — обычный value noise. Полноценный
// Перлин здесь избыточен: на этих частотах разницы не видно, а считается это
// один раз на мир.
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  // Сглаживающая кривая: без неё на границах клеток шума видны изломы.
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

// Сумма октав: каждая вдвое мельче и вдвое слабее предыдущей. Результат
// центрирован около нуля, чтобы шум не поднимал всю карту целиком.
function fbm(x, y, seed) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < FBM_OCTAVES; o++) {
    sum += (vnoise(x * f, y * f, seed + o * 7919) - 0.5) * amp;
    norm += amp * 0.5;
    amp *= 0.5; f *= 2;
  }
  return sum / Math.max(1e-6, norm);
}

// Мягкая ступень: 0 до a, 1 после b, плавно между. Из неё собраны все переходы
// цвета земли — резких границ на карте нет ни одной.
function smooth(a, b, v) {
  const t = Math.max(0, Math.min(1, (v - a) / Math.max(1e-6, b - a)));
  return t * t * (3 - 2 * t);
}

// Детерминированный хеш вместо Math.random: одинаковая сцена при одном сиде.
function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class Scene3D {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: opts.antialias !== false, alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(opts.dpr || 1, 2));
    // Тона: без этого всё, что ярче единицы, схлопывается в белое пятно, и
    // солнце на крышах выглядит выжженной дырой, а не бликом.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = opts.shadows !== false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 900);

    // Туман по цвету неба: без него дальний край карты обрывается ножом и
    // сцена читается как макет на столе, а не как местность до горизонта.
    this.scene.fog = new THREE.Fog(0x9ec6e0, 60, 260);
    this.scene.background = new THREE.Color(0x9ec6e0);

    this._buildLights(opts);

    this.world = null;
    this.groups = { ground: null, water: null, buildings: null, people: null };
    this.time = 0.5;
  }

  // ---- Свет ---------------------------------------------------------------
  // Три источника, и каждый отвечает за своё. Одним солнцем сцена выходит
  // контрастной до нечитаемости: всё, что в тени, становится чёрным.
  _buildLights(opts) {
    // Небо и отражённый от земли свет. Он и делает тени синими, а не чёрными.
    this.hemi = new THREE.HemisphereLight(0xbcd9f0, 0x4a5a34, 1.05);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.1);
    this.sun.castShadow = opts.shadows !== false;
    // Разрешение теневой карты — главный рычаг цены теней. 2048 хватает на
    // город: тень трубы читается, а не превращается в лестницу.
    const S = opts.shadowMapSize || 2048;
    this.sun.shadow.mapSize.set(S, S);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 220;
    // Ортографический объём тени охватывает окрестность камеры, а не весь мир:
    // на весь мир той же карты не хватило бы и тени поплыли бы ступенями.
    const R = opts.shadowRadius || 46;
    Object.assign(this.sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R });
    // Смещение против самозатенения («акне»): без него плоская земля покрывается
    // рябью из собственных теней.
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
  }

  // Положение солнца по времени суток. Канон проекта — свет сверху-слева под
  // 45° (docs/art-direction.md §5.1); здесь он ещё и ездит по небу за день,
  // чего 2D-версия физически не умела.
  setDayTime(t) {
    this.time = ((t % 1) + 1) % 1;
    // День длится с 0.25 до 0.85; вне этого — ночь, солнце под горизонтом.
    const u = (this.time - 0.25) / 0.6;          // 0 — рассвет, 1 — закат
    const alt = Math.sin(Math.PI * Math.max(0, Math.min(1, u)));
    const az = -0.9 + u * 1.8;                    // с востока на запад
    const h = 0.12 + alt * 0.95;
    const d = new THREE.Vector3(az, h, 0.62).normalize();
    this.sun.position.copy(d).multiplyScalar(120);

    // Цвет и сила: на рассвете и закате свет низкий, тёплый и слабый.
    const warm = 1 - alt;
    this.sun.color.setRGB(1, 0.94 - warm * 0.22, 0.85 - warm * 0.40);
    this.sun.intensity = 0.15 + alt * 2.2;
    this.hemi.intensity = 0.35 + alt * 0.8;

    const skyDay = new THREE.Color(0x9ec6e0), skyNight = new THREE.Color(0x1a2438);
    const skyDusk = new THREE.Color(0xd9a06a);
    const sky = skyNight.clone().lerp(skyDay, alt);
    if (alt > 0 && alt < 0.45) sky.lerp(skyDusk, (0.45 - alt) / 0.45 * 0.55);
    this.scene.background = sky;
    this.scene.fog.color = sky;
  }

  // ---- Земля --------------------------------------------------------------
  // Одна сетка на всю карту, вершина на клетку. Высота — из elev (worldgen2),
  // цвет — вершинный, по типу клетки. Вершинный цвет вместо текстуры выбран
  // намеренно: текстура на 96×96 клеток потребовала бы атласа и UV, а разницы
  // на этом масштабе не видно — зато переходы между типами получаются мягкими
  // сами собой, интерполяцией по треугольнику.
  buildWorld(sim) {
    const world = sim.world;
    this.world = world;
    const w = world.w, h = world.h;
    const seed = world.seed >>> 0;
    // Сглаженное поле высот считаем один раз и держим: по нему встают и земля,
    // и постройки, и жители — иначе дом «плавает» относительно склона.
    this.H = buildHeightField(world);

    this._disposeGroup('ground');
    this._disposeGroup('water');

    const geo = new THREE.PlaneGeometry(w, h, w - 1, h - 1);
    geo.rotateX(-Math.PI / 2);                    // из XY в XZ: Y — это высота
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const vx = i % w, vy = (i / w) | 0;
      const t = world.tiles[vy * w + vx];
      // Мелкая неровность поверх сглаженного поля: идеально гладкий склон
      // выглядит пластмассой. Амплитуда мала намеренно — это фактура, а не
      // рельеф, и она не должна возвращать ступени, которые мы только что убрали.
      const e = this.H[vy * w + vx] + (hash2(vx, vy, seed) - 0.5) * 0.010;
      pos.setY(i, e * ELEV_SCALE);

      // Цвет НЕ по типу клетки. Тип — это семь значений, и покраска по нему
      // ложится квадратами: на первом кадре карта выглядела лоскутным одеялом
      // с резкими границами. Красим по высоте и крутизне склона, то есть по
      // тому же, по чему природа: у воды песок, выше луг, на круче — камень,
      // на вершинах — снег. Границы получаются размытыми сами собой, потому
      // что и высота, и уклон непрерывны.
      const slope = this._slopeAt(vx, vy, w, h);
      c.copy(this._groundColor(e, slope, t));
      // Крапинка, чтобы большие ровные пятна не выглядели заливкой.
      c.multiplyScalar(0.94 + hash2(vx, vy, seed ^ 7) * 0.12);
      c.toArray(col, i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0.0, flatShading: false,
    });
    const ground = new THREE.Mesh(geo, mat);
    ground.receiveShadow = true;
    ground.castShadow = true;
    ground.position.set(w / 2 - 0.5, 0, h / 2 - 0.5);
    this.scene.add(ground);
    this.groups.ground = ground;

    // Вода — отдельная плоскость на уровне моря. Прозрачная и гладкая: весь
    // смысл в том, что сквозь неё видно дно, чего 2D-вода не умела в принципе.
    const wgeo = new THREE.PlaneGeometry(w * 1.6, h * 1.6, 1, 1);
    wgeo.rotateX(-Math.PI / 2);
    const wmat = new THREE.MeshStandardMaterial({
      color: 0x2d6a94, transparent: true, opacity: 0.80,
      roughness: 0.12, metalness: 0.35,
    });
    const water = new THREE.Mesh(wgeo, wmat);
    water.position.set(w / 2 - 0.5, SEA, h / 2 - 0.5);
    water.receiveShadow = false;
    this.scene.add(water);
    this.groups.water = water;
  }

  // Крутизна склона в клетке: перепад высоты к соседям. 0 — ровно, 1 — стена.
  _slopeAt(x, y, w, h) {
    const H = this.H;
    const l = H[y * w + Math.max(0, x - 1)], r = H[y * w + Math.min(w - 1, x + 1)];
    const u = H[Math.max(0, y - 1) * w + x], d = H[Math.min(h - 1, y + 1) * w + x];
    // Множитель ELEV_SCALE переводит перепад в те же единицы, что и клетка:
    // без него уклон считался бы в «долях высоты мира на клетку» и не значил бы
    // ничего физически.
    const gx = (r - l) * 0.5 * ELEV_SCALE, gy = (d - u) * 0.5 * ELEV_SCALE;
    return Math.min(1, Math.sqrt(gx * gx + gy * gy) * 1.35);
  }

  // Цвет земли по высоте и уклону. Ступени тут намеренно мягкие: каждая полоса
  // переходит в следующую плавно, поэтому на карте нет ни одной резкой границы.
  _groundColor(e, slope, tile) {
    const C = this._c || (this._c = new THREE.Color());
    const A = this._cA || (this._cA = new THREE.Color());
    // Ключевые цвета. Взяты из палитры 2D-версии, чтобы местность узнавалась.
    const DEEP = 0x14304a, SHALLOW = 0x2f6b8f, SAND = 0xd9c89a;
    const GRASS = 0x5d8a3a, FOREST = 0x35602a, ROCK = 0x7d7566, SNOW = 0xe9eef2;

    if (e <= 0) {                                  // дно: чем глубже, тем темнее
      C.setHex(SHALLOW); A.setHex(DEEP);
      return C.lerp(A, Math.min(1, -e / 0.4));
    }
    // Пляж — узкая полоса у самой воды.
    if (e < 0.06) { C.setHex(SAND); A.setHex(GRASS); return C.lerp(A, e / 0.06); }

    // Луг и лес. Лес — единственное место, где тип клетки ещё важен: это не
    // высота, а растительность, из рельефа её не вывести.
    C.setHex(tile === TILE.FOREST ? FOREST : GRASS);
    // Выше становится суше и бледнее — обычное горное разнотравье.
    A.setHex(ROCK);
    C.lerp(A, smooth(0.30, 0.62, e));
    // Крутизна оголяет породу независимо от высоты: на обрыве трава не держится.
    C.lerp(A, smooth(0.35, 0.75, slope) * 0.85);
    // Снеговая линия. На отвесной скале снег не лежит — поэтому его доля падает
    // с уклоном, иначе вершины выглядят облитыми белой краской.
    // Снеговая линия высоко намеренно: при 0.66 в снегу оказывался весь
    // хребет целиком и остров выходил полярным. Выше 0.78 — это уже вершины,
    // а не нагорье.
    A.setHex(SNOW);
    const snow = smooth(0.78, 0.95, e) * (1 - smooth(0.45, 0.85, slope) * 0.8);
    return C.lerp(A, snow);
  }

  // Высота земли в точке клетки — чтобы дом стоял на склоне, а не висел.
  groundY(x, y) {
    const world = this.world;
    if (!world || !this.H) return 0;
    // Билинейно, а не по ближайшей клетке: дом на склоне между двумя клетками
    // иначе прыгает на полклетки вверх и одним углом уходит в воздух.
    const fx = Math.max(0, Math.min(world.w - 1.001, x));
    const fy = Math.max(0, Math.min(world.h - 1.001, y));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const x1 = Math.min(world.w - 1, x0 + 1), y1 = Math.min(world.h - 1, y0 + 1);
    const H = this.H, w = world.w;
    const a = H[y0 * w + x0], b = H[y0 * w + x1], c = H[y1 * w + x0], d = H[y1 * w + x1];
    const e = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    return e * ELEV_SCALE;
  }

  // ---- Постройки ----------------------------------------------------------
  // Каждое здание — короб стен плюс крыша. Это намеренно просто: цель первой
  // сцены — доказать, что объём, свет и тени работают на настоящих данных
  // игры. Готовые модели (glTF) встают на это же место позже, без правок
  // симуляции — меняется только тело этой функции.
  buildBuildings(sim) {
    this._disposeGroup('buildings');
    const g = new THREE.Group();
    const era = sim.eraIndex | 0;
    const pal = ERA_PAL[Math.max(0, Math.min(9, era))];
    const seed = (sim.world.seed >>> 0) ^ 0x5bf03635;

    // Материалы общие на всю сцену: новый материал на каждое здание — это
    // отдельная компиляция шейдера и отдельный вызов отрисовки.
    const wallMat = new THREE.MeshStandardMaterial({ color: pal.wall, roughness: 0.82, metalness: 0.02 });
    const roofMat = new THREE.MeshStandardMaterial({ color: pal.roof, roughness: 0.70, metalness: 0.02 });

    for (const b of sim.buildings) {
      if (b.destroyed) continue;
      const arch = ARCH[b.id] || 'house';
      const hFact = archHeight(arch);
      const slim = SLIM[arch] || 0.95;
      const size = (b.size || 1);
      const bw = size * slim;
      // ARCH_H задаёт ПОЛНУЮ высоту постройки вместе с крышей. В 2D её можно
      // было отдать стенам целиком: перспектива была нарисована внутри спрайта,
      // и высокий прямоугольник читался как дом. В настоящем объёме так
      // получается башня — на первом кадре деревня выглядела кварталом
      // узких вышек. Стенам отдаём 62% высоты, остальное забирает крыша.
      const full = hFact * (b.done ? 1 : 0.45);   // недострой — ниже, видно сразу
      const flat = FLAT_ROOF.has(arch);
      const bh = flat ? full : full * 0.62;
      if (bh <= 0.01) continue;

      const gy = this.groundY(b.x, b.y);
      // Лёгкий разворот: строго осевые коробки читаются как таблица, а не как
      // поселение. Угол детерминирован координатой — при перезагрузке тот же.
      const rot = (hash2(b.x, b.y, seed) - 0.5) * 0.22;

      const walls = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bw), wallMat);
      walls.position.set(b.x, gy + bh / 2, b.y);
      walls.rotation.y = rot;
      walls.castShadow = true;
      walls.receiveShadow = true;
      g.add(walls);

      if (!flat) {
        // Четырёхскатная крыша — это конус на четыре грани. Дешевле любой
        // модели и сразу снимает «город из коробок». Свес шире стен: без него
        // крыша сидит на доме шапкой не по размеру.
        const rh = full - bh;
        const roof = new THREE.Mesh(new THREE.ConeGeometry(bw * 0.82, rh, 4), roofMat);
        roof.position.set(b.x, gy + bh + rh / 2, b.y);
        roof.rotation.y = rot + Math.PI / 4;
        roof.castShadow = true;
        roof.receiveShadow = true;
        g.add(roof);
      }
    }
    this.scene.add(g);
    this.groups.buildings = g;
    return g.children.length;
  }

  // ---- Жители -------------------------------------------------------------
  // Капсула вместо человечка: на этом шаге важно, что фигура ОТБРАСЫВАЕТ ТЕНЬ
  // и стоит на земле, а не что у неё есть лицо. Ростом строго 0.34 клетки —
  // то же число, что в 2D после правки роста, чтобы человек был хижине по плечо.
  buildPeople(sim) {
    this._disposeGroup('people');
    const list = sim.villagers || [];
    if (!list.length) { this.groups.people = null; return 0; }

    const H = 0.34, R = 0.075;
    const geo = new THREE.CapsuleGeometry(R, H - R * 2, 4, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0xb5875a, roughness: 0.9 });
    // Инстансинг: сто жителей одним вызовом отрисовки вместо ста.
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    let n = 0;
    for (const v of list) {
      if (v.hp !== undefined && v.hp <= 0) continue;
      const gy = this.groundY(v.x, v.y);
      m.makeTranslation(v.x, gy + H / 2, v.y);
      mesh.setMatrixAt(n++, m);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
    this.groups.people = mesh;
    return n;
  }

  // ---- Камера -------------------------------------------------------------
  // Тот же вид «три четверти сверху», к которому игрок привык в 2D: наклон
  // около 55° от вертикали. Разница в том, что теперь это настоящая камера —
  // у построек есть ближняя и дальняя грань, и они перекрывают друг друга.
  lookAt(x, y, dist = 34, tilt = 0.95, turn = -0.6) {
    const gy = this.groundY(x, y);
    const cy = Math.sin(tilt) * dist;
    const cr = Math.cos(tilt) * dist;
    this.camera.position.set(x + Math.sin(turn) * cr, gy + cy, y + Math.cos(turn) * cr);
    this.camera.lookAt(x, gy + 1.2, y);
    // Тень идёт за камерой: ортографический объём накрывает то, что видно.
    this.sun.target.position.set(x, gy, y);
    this.sun.target.updateMatrixWorld();
    const d = this.sun.position.clone().normalize().multiplyScalar(120);
    this.sun.position.set(x + d.x, gy + d.y, y + d.z);
  }

  resize(w, h, dpr) {
    this.renderer.setPixelRatio(Math.min(dpr || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  render() { this.renderer.render(this.scene, this.camera); }

  // Сводка для приёмки: сколько геометрии в кадре и во что это обходится.
  stats() {
    const i = this.renderer.info;
    return {
      вызововОтрисовки: i.render.calls,
      треугольников: i.render.triangles,
      геометрий: i.memory.geometries,
      текстур: i.memory.textures,
      программ: i.programs ? i.programs.length : 0,
    };
  }

  _disposeGroup(key) {
    const g = this.groups[key];
    if (!g) return;
    this.scene.remove(g);
    g.traverse ? g.traverse(o => { if (o.geometry) o.geometry.dispose(); }) : (g.geometry && g.geometry.dispose());
    this.groups[key] = null;
  }

  dispose() {
    for (const k of Object.keys(this.groups)) this._disposeGroup(k);
    this.renderer.dispose();
  }
}
