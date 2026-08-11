// core/systems/link_ghost.js — ТЕНЬ ПРОШЛОЙ ПАРТИИ.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. Стратегию переигрывают, но сравнить две партии не с чем:
// прошлая существует только в голове. «Кажется, в тот раз я был богаче» — это
// всё, что игрок может о ней сказать. Здесь прошлая партия на том же сиде
// становится видимой: на 340-й день у тебя было 18 жителей, а в прошлый раз —
// 31, зато держава уже сыпалась.
//
// ПОЧЕМУ ЭТО ВООБЩЕ ВОЗМОЖНО ИМЕННО У НАС. Сравнивать партии осмысленно только
// если мир одинаков. У нас он одинаков по построению: во всём ядре нет ни
// одного Math.random, вся случайность идёт через sim.rng от сида, и за этим
// следит отдельная проверка в тестах. Один сид — буквально одна и та же карта,
// те же соседи, те же погоды. В большинстве стратегий такого сравнения не
// сделать вовсе: там симуляция недетерминирована, и два прогона расходятся
// сами по себе, даже если игрок повторит все ходы.
//
// ЧТО ЗАПИСЫВАЕТСЯ. Не действия игрока (их воспроизведение — отдельная большая
// работа), а СЛЕПКИ состояния через равные промежутки: население, казна,
// порядок, эпоха, число построек и технологий. Этого хватает, чтобы показать
// ход партии кривой и сказать, где именно нынешняя разошлась с прошлой.
//
// ГДЕ ЭТО ХРАНИТСЯ. Ядро не знает про localStorage и не должно: слепки лежат в
// sim, а сохраняет и загружает их интерфейс. Поэтому здесь чистые функции и
// никаких обращений к окружению.
import { DAYS_PER_SEASON } from '../data.js';

export const YEAR = DAYS_PER_SEASON * 4;

// Как часто снимать слепок. Раз в сезон: год из четырёх точек — это уже кривая,
// а за длинную партию в сто лет набирается четыреста точек, то есть десятки
// килобайт. Чаще — раздувает сохранение без пользы для глаза.
export const SNAP_EVERY = DAYS_PER_SEASON;

// Сколько слепков держим. 400 — это сто лет игры; дальше самые старые не
// выбрасываются, а прореживаются вдвое, чтобы кривая осталась целой.
export const MAX_SNAPS = 400;

// Насколько партии должны разойтись, чтобы это стоило показать. Проценты, а не
// числа: «на 3 жителя больше» ничего не значит при населении 200 и значит всё
// при населении 6.
export const DIVERGE_PCT = 0.25;

export function createGhost() {
  return { v: 1, seed: 0, day: -1, snaps: [], past: null };
}

// Слепок — плоский объект из чисел: он идёт в сохранение как есть.
export function snapshotOf(sim) {
  const pol = sim.politics && sim.politics.state;
  return {
    d: sim.day | 0,
    pop: sim.villagers ? sim.villagers.length : 0,
    gold: Math.round(num(sim.res && sim.res.gold, 0)),
    food: Math.round(num(sim.res && sim.res.food, 0)),
    stab: pol ? Math.round(num(pol.stability, 0)) : 0,
    era: sim.eraIndex | 0,
    b: sim.buildings ? sim.buildings.filter(x => x.done && !x.destroyed).length : 0,
    tech: sim.techs ? sim.techs.size : 0,
  };
}

export function restoreGhost(data) {
  const g = createGhost();
  if (!data || typeof data !== 'object') return g;
  g.seed = num(data.seed, 0);
  g.day = num(data.day, -1);
  g.snaps = cleanSnaps(data.snaps);
  g.past = data.past ? { seed: num(data.past.seed, 0), snaps: cleanSnaps(data.past.snaps), ended: num(data.past.ended, 0) } : null;
  return g;
}

function cleanSnaps(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    out.push({
      d: num(s.d, 0), pop: num(s.pop, 0), gold: num(s.gold, 0), food: num(s.food, 0),
      stab: num(s.stab, 0), era: num(s.era, 0), b: num(s.b, 0), tech: num(s.tech, 0),
    });
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}

// ---------- Запись ----------

export function ghostTick(sim) {
  const day = sim.day | 0;
  const G = sim.linkGhost || createGhost();
  const out = { events: [], flags: { memory: G, snapped: false, diverged: null } };
  if (G.day === day) return out;

  const N = { ...G, day, snaps: G.snaps.slice() };
  N.seed = num(sim.seed, N.seed);

  const last = N.snaps.length ? N.snaps[N.snaps.length - 1] : null;
  if (!last || day - last.d >= SNAP_EVERY) {
    N.snaps.push(snapshotOf(sim));
    out.flags.snapped = true;
    // Прореживание вдвое вместо отбрасывания старого: кривая должна остаться
    // от начала партии до сегодня, просто с более редкими точками в прошлом.
    if (N.snaps.length > MAX_SNAPS) {
      const thin = [];
      for (let i = 0; i < N.snaps.length; i++) {
        if (i % 2 === 0 || i >= N.snaps.length - 40) thin.push(N.snaps[i]);
      }
      N.snaps = thin;
    }
  }

  // Расхождение с прошлой партией — только в тот день, когда снимали слепок:
  // считать его каждые сутки незачем, а говорить о нём чаще раза в сезон
  // значит превратить его в шум.
  if (out.flags.snapped && N.past && N.past.seed === N.seed) {
    const now = N.snaps[N.snaps.length - 1];
    const then = atDay(N.past.snaps, now.d);
    if (then) {
      const d = diverge(now, then);
      if (d) {
        out.flags.diverged = d;
        out.events.push({ text: `👻 ${d.text}`, type: d.better ? 'good' : 'warn' });
      }
    }
  }

  out.flags.memory = N;
  return out;
}

// Ближайший слепок прошлой партии к этому дню. Точного совпадения дней ждать
// нельзя: партии идут с разной скоростью и слепки не обязаны попадать день в
// день.
export function atDay(snaps, day) {
  if (!snaps || !snaps.length) return null;
  let best = null, bestGap = Infinity;
  for (const s of snaps) {
    const gap = Math.abs(s.d - day);
    if (gap < bestGap) { bestGap = gap; best = s; }
  }
  // Слишком далёкий слепок — не сравнение, а выдумка.
  return bestGap <= SNAP_EVERY * 2 ? best : null;
}

// Самое заметное расхождение, словами. Одно, а не список: игрок должен получить
// сообщение, а не таблицу.
function diverge(now, then) {
  const cands = [
    { k: 'pop', ru: 'жителей', a: now.pop, b: then.pop, more: true },
    { k: 'gold', ru: 'золота', a: now.gold, b: then.gold, more: true },
    { k: 'b', ru: 'построек', a: now.b, b: then.b, more: true },
    { k: 'tech', ru: 'технологий', a: now.tech, b: then.tech, more: true },
    { k: 'stab', ru: 'порядка', a: now.stab, b: then.stab, more: true },
  ];
  let best = null, bestRel = DIVERGE_PCT;
  for (const c of cands) {
    const base = Math.max(1, Math.abs(c.b));
    const rel = Math.abs(c.a - c.b) / base;
    if (rel > bestRel) { bestRel = rel; best = c; }
  }
  if (!best) return null;
  const better = best.a > best.b;
  const year = Math.floor(now.d / YEAR) + 1;
  return {
    key: best.k, now: best.a, past: best.b, better,
    text: better
      ? `Год ${year}: ${best.ru} у нас ${best.a} против ${best.b} в прошлой партии — идём лучше.`
      : `Год ${year}: ${best.ru} у нас ${best.a} против ${best.b} в прошлой партии — отстаём.`,
  };
}

// ---------- Для панели ----------

// Две кривые для сравнения плюс готовые строки. Память НЕ двигает.
export function ghostReport(sim, key = 'pop') {
  const G = sim && sim.linkGhost ? sim.linkGhost : createGhost();
  const mine = G.snaps.map(s => ({ d: s.d, v: s[key] ?? 0 }));
  const hasPast = !!(G.past && G.past.snaps.length && G.past.seed === G.seed);
  const past = hasPast ? G.past.snaps.map(s => ({ d: s.d, v: s[key] ?? 0 })) : [];

  const rows = [];
  if (hasPast) {
    for (const s of G.snaps) {
      const t = atDay(G.past.snaps, s.d);
      if (!t) continue;
      rows.push({ d: s.d, year: Math.floor(s.d / YEAR) + 1, now: s[key] ?? 0, past: t[key] ?? 0 });
    }
  }
  const now = G.snaps.length ? G.snaps[G.snaps.length - 1] : null;
  const then = hasPast && now ? atDay(G.past.snaps, now.d) : null;
  return {
    hasPast, mine, past, rows,
    pastEnded: hasPast ? G.past.ended : 0,
    summary: !hasPast
      ? 'Прошлой партии на этом сиде нет — сравнивать не с чем. Доиграйте эту, и следующая пойдёт рядом с ней.'
      : (then ? summaryText(now, then) : 'Прошлая партия на этот день ещё не дошла.'),
  };
}

function summaryText(now, then) {
  const parts = [];
  const cmp = (ru, a, b) => {
    if (a === b) return `${ru}: поровну (${a})`;
    return `${ru}: ${a} против ${b}`;
  };
  parts.push(cmp('жители', now.pop, then.pop));
  parts.push(cmp('золото', now.gold, then.gold));
  parts.push(cmp('порядок', now.stab, then.stab));
  parts.push(cmp('постройки', now.b, then.b));
  return parts.join(' · ');
}

// Партия закончена (победа, поражение или выход): нынешние слепки становятся
// прошлым для следующего запуска. Возвращает то, что интерфейс сохранит.
export function sealRun(sim) {
  const G = sim && sim.linkGhost ? sim.linkGhost : createGhost();
  return {
    seed: G.seed || num(sim && sim.seed, 0),
    snaps: G.snaps.slice(),
    ended: sim ? (sim.day | 0) : 0,
  };
}

function num(v, def) { return Number.isFinite(v) ? v : def; }

/* ПОДКЛЮЧЕНИЕ ─────────────────────────────────────────────────────────────────

1) integrate.js: sim.linkGhost = GH.createGhost() в installSystems (seed берётся
   из sim.seed), applyGhost(sim) в systemsNewDay, сейв/восстановление поля ghost.

2) main.js (там, где уже есть localStorage и его защита от приватного режима):
   при старте новой партии подложить прошлую: sim.linkGhost.past = загруженное
   по ключу frontier_ghost_<seed>. При окончании партии — сохранить sealRun(sim).
   Ядро про localStorage не знает и знать не должно.

────────────────────────────────────────────────────────────────────────────── */
