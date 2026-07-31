// render/quality.js — пресеты графики и автоопределение по FPS (ТЗ №5 §2.7).
// Пресет решает всё: разрешение тайла в кэше карты, наличие рельефа, свечения,
// зерна, виньетки, лучей, облаков, анимации воды, теней и плотности частиц.

export const QUALITY_ORDER = ['eco', 'medium', 'high', 'ultra'];

export const QUALITY = {
  ultra: {
    id: 'ultra', ru: 'Ультра',
    tilePx: 32, maxDpr: 2,
    relief: true, shoreFoam: true, water: true, clouds: true, shadows: true,
    bloom: true, bloomDiv: 4, godRays: true, vignette: true, grain: 0.030,
    particles: 1.0, detail: 2, ambientProps: true, birds: true, fireflies: true,
  },
  high: {
    id: 'high', ru: 'Высоко',
    tilePx: 32, maxDpr: 2,
    relief: true, shoreFoam: true, water: true, clouds: true, shadows: true,
    bloom: true, bloomDiv: 6, godRays: true, vignette: true, grain: 0,
    particles: 0.8, detail: 2, ambientProps: true, birds: true, fireflies: true,
  },
  medium: {
    id: 'medium', ru: 'Средне',
    tilePx: 24, maxDpr: 1.5,
    relief: true, shoreFoam: true, water: true, clouds: true, shadows: true,
    bloom: false, bloomDiv: 8, godRays: false, vignette: true, grain: 0,
    particles: 0.5, detail: 1, ambientProps: true, birds: false, fireflies: true,
  },
  eco: {
    id: 'eco', ru: 'Экономия',
    tilePx: 16, maxDpr: 1,
    relief: false, shoreFoam: false, water: false, clouds: false, shadows: false,
    bloom: false, bloomDiv: 8, godRays: false, vignette: false, grain: 0,
    particles: 0.25, detail: 0, ambientProps: false, birds: false, fireflies: false,
  },
};

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

// Замер первых секунд игры: если кадры не вытягивают — снижаем пресет на ступень.
// Возвращает объект с методом sample(dt) → новый id пресета или null.
export function makeAutoTuner(startId = 'high') {
  let elapsed = 0, frames = 0, slow = 0, current = startId, done = false;
  const WINDOW = 10; // секунд наблюдения, как в ТЗ
  return {
    get current() { return current; },
    get done() { return done; },
    sample(dt) {
      if (done) return null;
      elapsed += dt; frames++;
      if (dt > 1 / 40) slow++;
      // первые 1.5 с — прогрев (компиляция шейдеров браузера, прогрев кэшей)
      if (elapsed < 1.5) { frames = 0; slow = 0; return null; }
      if (elapsed < WINDOW) {
        // ранний выход: совсем всё плохо — не ждём 10 секунд
        if (frames > 60 && slow / frames > 0.7) return step(-1);
        return null;
      }
      done = true;
      const badRatio = frames ? slow / frames : 0;
      if (badRatio > 0.35) return step(-1);
      return null;
    },
  };
  function step(dir) {
    const i = QUALITY_ORDER.indexOf(current);
    const ni = Math.max(0, Math.min(QUALITY_ORDER.length - 1, i + dir));
    if (ni === i) { done = true; return null; }
    current = QUALITY_ORDER[ni];
    elapsed = 0; frames = 0; slow = 0;
    return current;
  }
}

// Стартовая догадка по железу до всяких замеров.
export function guessQuality() {
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const px = (window.innerWidth || 1280) * (window.innerHeight || 720) * Math.min(2, window.devicePixelRatio || 1);
  if (mem <= 2 || cores <= 2) return 'eco';
  if (coarse && px > 2.5e6) return 'medium';   // телефон с плотным экраном
  if (coarse) return 'medium';
  // ultra намеренно НЕ выдаётся автоматически: замер показал 26.3 FPS
  // (33.6 мс на кадр) при 55 зданиях и 226 жителях, а порог 8 ГБ / 8 ядер
  // проходит почти любой современный десктоп — половина игроков получала
  // тормоза по умолчанию. Пресет остаётся, но выбирается только руками.
  return 'high';
}
