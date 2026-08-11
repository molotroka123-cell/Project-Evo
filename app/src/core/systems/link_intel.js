// core/systems/link_intel.js — СВЯЗЬ: откуда мы вообще знаем про соседей.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. Карточка соседа показывает точную армию, точную эпоху и
// точные черты — всегда и про всех, с первого дня. Игрок всеведущ, и от этого
// половина решений принимается автоматически: видно же, что у Орды войско
// втрое сильнее, значит не лезем. Разведка, послы, торговые пути при этом в
// игре есть, но ничего не решают: узнать что-то новое невозможно, потому что
// всё уже известно.
//
// Здесь знание становится ресурсом со сроком годности. Мы знаем не то, что у
// соседа СЕЙЧАС, а то, что о нём В ПОСЛЕДНИЙ РАЗ РАССКАЗАЛИ. Рассказывают
// караваны, послы и разведчики; война на дороге обрывает не только торговлю,
// но и новости. Чем дольше нет вестей, тем грубее то, что мы помним: сначала
// «армия ~40», потом «сорок с чем-то», потом «сильное войско, если верить
// прошлогоднему слуху».
//
// ЧТО ЭТО МЕНЯЕТ В ИГРЕ. Договор о торговле перестаёт быть строчкой в журнале:
// он открывает глаза. Война на маршруте бьёт дважды — по казне и по знанию.
// Сосед, с которым нет ни торговли, ни границы, становится по-настоящему
// тёмным пятном, и решение «лезть или не лезть» принимается с риском.
//
// ЧЕГО ЭТОТ ФАЙЛ НЕ ДЕЛАЕТ. Он не врёт игроку и не подделывает числа. Он
// показывает ЧЕСТНО УСТАРЕВШИЕ данные и всегда говорит, когда они получены и
// насколько им можно верить. Разница принципиальная: игрок не обманут, он
// проинформирован о своей неосведомлённости.
//
// ИИ соседей это не касается: civ_ai.js по-прежнему видит настоящее состояние
// мира. Туман неведения — правило для игрока, а не для симуляции.
//
// СЛУЧАЙНОСТИ ЗДЕСЬ НЕТ: ни Math.random, ни sim.rng. Приход вестей считается по
// расписанию от расстояния и договоров, а не броском — иначе один и тот же сейв
// давал бы разное знание, и «слух» превращался бы в лотерею.
import { DAYS_PER_SEASON } from '../data.js';

export const YEAR = DAYS_PER_SEASON * 4;

// Как часто приходят вести, в днях. Числа подобраны от смысла: с торговым
// партнёром караваны ходят постоянно, с врагом работают разведчики (война —
// худший способ узнать соседа, но всё-таки способ), с далёким незнакомцем
// вестей почти нет.
export const PERIOD = {
  war: 6,          // разведка при войне: мы смотрим на них в упор
  treaty: 12,      // торговый договор: караваны возят и товар, и новости
  friendly: 25,    // отношения ≥ 20: послы ездят
  neutral: 55,     // просто соседи
  hostile: 90,     // вражда без войны: границы закрыты
};

// Опасная дорога растягивает срок: караван не идёт — новостей нет. Множитель
// к периоду при полной опасности маршрута (её считает link_neighbors).
export const DANGER_STRETCH = 2.2;

// Общая граница сокращает срок вдвое: соседа за рекой видно и без послов.
export const BORDER_SPEEDUP = 0.5;
export const BORDER_DIST = 18;        // клеток — «за рекой», а не «за морем»

// Как быстро тает доверие. Экспонента с этой постоянной: через TRUST_TAU дней
// остаётся 37% доверия, через два TRUST_TAU — 14%.
//
// Сначала здесь стояло линейное затухание за два года, и получалась подпись,
// которая противоречила сама себе: «30 дн. назад · сведения свежие». За два
// года прямая почти не наклоняется, и месячной давности слух выглядел как
// сегодняшняя депеша — то есть механика была, а на экране её не было.
// 90 дней подобраны под те же ступени, по которым грубеет само число:
// на 30-м дне доверие 0.72 («не первой свежести», и как раз тогда точное
// число сменяется округлённым), на 120-м — 0.26 («устарели», число сменяется
// словом).
export const TRUST_TAU = 90;

// Через столько дней сведения считаются полностью протухшими: дальше их
// показывают, но с прямой пометкой, что верить нечему.
export const STALE_FULL = YEAR * 2;

// Ступени огрубления. Пока вестям меньше FRESH_DAYS — показываем число. Дальше
// — округлённое число, потом словесную оценку, потом «неизвестно».
export const FRESH_DAYS = 30;
export const ROUGH_DAYS = 120;

export function createIntel() {
  return { v: 1, day: -1, known: {} };
}

export function restoreIntel(data) {
  const m = createIntel();
  if (!data || typeof data !== 'object') return m;
  m.day = num(data.day, -1);
  if (data.known && typeof data.known === 'object') {
    for (const [fid, k] of Object.entries(data.known)) {
      if (!k || typeof k !== 'object') continue;
      m.known[fid] = {
        day: num(k.day, -1),
        armyPts: num(k.armyPts, 0),
        era: num(k.era, 0),
        pop: num(k.pop, 0),
        techCount: num(k.techCount, 0),
        alive: k.alive !== false,
        source: typeof k.source === 'string' ? k.source : 'neutral',
      };
    }
  }
  return m;
}

// ---------- Чтение мира ----------

// Насколько опасны дороги к этому соседу. Считает link_neighbors; если его
// отчёта ещё нет — дорога считается спокойной. Второй формулы опасности здесь
// быть не должно: игрок читал бы в двух панелях разные числа.
function dangerOf(sim, fid) {
  const L = sim && sim.sys && sim.sys.nbrLinks;
  if (!L || !L.flags) return 0;
  const d = L.flags.routeDanger;
  if (typeof d === 'number') return clamp(d, 0, 1);
  if (d && typeof d[fid] === 'number') return clamp(d[fid], 0, 1);
  return 0;
}

function distanceTo(sim, f) {
  const s = f && f.settlements && f.settlements[0];
  if (!s || !sim.world) return 99;
  return Math.hypot(s.x - sim.world.startX, s.y - sim.world.startY);
}

function relValue(sim, fid) {
  if (!sim || !sim.relations) return 0;
  const r = sim.relations[fid];
  return typeof r === 'number' ? r : (r && typeof r.v === 'number' ? r.v : 0);
}

// Откуда мы узнаём про этого соседа сегодня и как часто.
export function channelFor(sim, f) {
  const fid = f.id;
  const atWar = Array.isArray(sim.wars) && sim.wars.some(w => w.fid === fid);
  const treaty = Array.isArray(sim.treaties) && sim.treaties.some(t => t.b === fid);
  const rel = relValue(sim, fid);

  let source = 'neutral';
  if (atWar) source = 'war';
  else if (treaty) source = 'treaty';
  else if (rel >= 20) source = 'friendly';
  else if (rel <= -20) source = 'hostile';

  let period = PERIOD[source];
  // Опасные дороги растягивают срок: караван не дошёл — и новостей нет. Войну
  // это не касается: разведчики ходят как раз потому, что война.
  if (source !== 'war') period *= 1 + (DANGER_STRETCH - 1) * dangerOf(sim, fid);
  // Ближнего соседа видно и без послов.
  if (distanceTo(sim, f) <= BORDER_DIST) period *= BORDER_SPEEDUP;
  return { source, period: Math.max(3, Math.round(period)) };
}

// ---------- Главная функция ----------

export function intelLinks(sim) {
  const day = sim && typeof sim.day === 'number' ? sim.day : 0;
  const M = sim && sim.linkIntel ? sim.linkIntel : createIntel();
  const out = {
    events: [],
    flags: { memory: M, fresh: [], channels: {} },
  };
  if (M.day === day) return out;          // один день считается один раз

  const N = { v: 1, day, known: { ...M.known } };

  for (const f of (sim.factions || [])) {
    if (!f || !f.id) continue;
    const ch = channelFor(sim, f);
    out.flags.channels[f.id] = ch;
    const prev = N.known[f.id];

    // Первая встреча: что-то мы знаем всегда — соседа видно хотя бы по дымам.
    // Иначе на первом дне карточка была бы пуста и игрок решил бы, что игра
    // сломана.
    const due = !prev || (day - prev.day) >= ch.period;
    if (!due) continue;

    N.known[f.id] = {
      day,
      armyPts: num(f.armyPts, 0),
      era: num(f.era, 0),
      pop: num(f.P, 0),
      techCount: num(f.techCount, 0),
      alive: f.alive !== false,
      source: ch.source,
    };
    out.flags.fresh.push(f.id);

    // Рассказываем только о заметной перемене: «вести пришли» каждые десять
    // дней — это шум, а не новость.
    if (prev && f.alive !== false) {
      const grew = num(f.armyPts, 0) - prev.armyPts;
      if (Math.abs(grew) >= Math.max(8, prev.armyPts * 0.35)) {
        out.events.push({
          text: grew > 0
            ? `🕊 Вести от ${f.def ? f.def.name : f.id}: войско выросло (было ~${Math.round(prev.armyPts)}, стало ~${Math.round(f.armyPts)}).`
            : `🕊 Вести от ${f.def ? f.def.name : f.id}: войско поредело (было ~${Math.round(prev.armyPts)}, стало ~${Math.round(f.armyPts)}).`,
          type: grew > 0 ? 'warn' : 'info',
        });
      }
      if (num(f.era, 0) > prev.era) {
        out.events.push({
          text: `🕊 ${f.def ? f.def.name : f.id} шагнул в новую эпоху — так говорят пришедшие.`,
          type: 'warn',
        });
      }
    }
  }

  out.flags.memory = N;
  return out;
}

// ---------- Что игрок видит ----------

// Сведения о соседе: последнее известное плюс честная оценка их свежести.
// Возвращает ВСЕГДА, даже если вестей не было ни разу.
export function knownOf(sim, fid) {
  const M = sim && sim.linkIntel ? sim.linkIntel : createIntel();
  const k = M.known[fid];
  const day = sim && typeof sim.day === 'number' ? sim.day : 0;
  if (!k) {
    return {
      any: false, age: Infinity, trust: 0, source: 'none',
      armyText: 'ничего не известно', eraText: '—', ageText: 'вестей не было',
    };
  }
  const age = Math.max(0, day - k.day);
  // Доверие падает плавно и никогда не становится нулём: даже прошлогодний слух
  // это больше, чем пустота.
  const trust = clamp(Math.exp(-age / TRUST_TAU), 0.05, 1);
  return {
    any: true, age, trust: round2(trust), source: k.source,
    armyPts: k.armyPts, era: k.era, pop: k.pop, techCount: k.techCount,
    armyText: armyWord(k.armyPts, age),
    eraText: age > STALE_FULL ? 'неизвестно' : null,   // подпись эпохи соберёт HUD
    ageText: ageWord(age),
    sourceText: sourceWord(k.source),
  };
}

// Огрубление по возрасту: свежее — числом, старое — словом. Это и есть главная
// мысль файла: мы теряем не сами сведения, а их ТОЧНОСТЬ.
export function armyWord(pts, age) {
  if (age <= FRESH_DAYS) return `~${Math.round(pts)}`;
  if (age <= ROUGH_DAYS) {
    // Округляем до десятков: «где-то сорок», а не «сорок два».
    const r = Math.round(pts / 10) * 10;
    return `около ${r}`;
  }
  if (pts < 20) return 'войско слабое';
  if (pts < 60) return 'войско изрядное';
  if (pts < 120) return 'войско сильное';
  return 'войско великое';
}

export function ageWord(age) {
  if (age <= 1) return 'сегодня';
  if (age < 10) return `${age} дн. назад`;
  if (age < YEAR) return `${Math.round(age / 10) * 10} дн. назад`;
  const y = Math.floor(age / YEAR);
  return y === 1 ? 'больше года назад' : `${y} г. назад`;
}

function sourceWord(src) {
  switch (src) {
    case 'war': return 'от разведчиков';
    case 'treaty': return 'с караванами';
    case 'friendly': return 'от послов';
    case 'hostile': return 'по слухам';
    default: return 'от захожих людей';
  }
}

// Строка «насколько верить»: игрок должен понимать не только что он знает, но и
// стоит ли на это опираться.
export function trustWord(trust) {
  if (trust >= 0.85) return 'сведения свежие';
  if (trust >= 0.55) return 'сведения не первой свежести';
  if (trust >= 0.25) return 'сведения устарели';
  return 'верить нечему';
}

// Сводка для панели дипломатии: по строке на соседа.
export function intelReport(sim) {
  const rows = [];
  for (const f of (sim.factions || [])) {
    if (!f || f.alive === false) continue;
    const k = knownOf(sim, f.id);
    const ch = sim.sys && sim.sys.intelLinks ? sim.sys.intelLinks.flags.channels[f.id] : null;
    rows.push({
      fid: f.id,
      name: f.def ? f.def.name : f.id,
      armyText: k.armyText,
      ageText: k.ageText,
      trust: k.trust,
      trustText: trustWord(k.trust),
      sourceText: k.sourceText || '',
      period: ch ? ch.period : null,
    });
  }
  return rows;
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function num(v, def) { return Number.isFinite(v) ? v : def; }
function round2(v) { return Math.round(v * 100) / 100; }

/* ПОДКЛЮЧЕНИЕ ─────────────────────────────────────────────────────────────────

1) integrate.js: импорт, sim.linkIntel = INT.createIntel() в installSystems,
   applyIntelLinks(sim) в systemsNewDay ПОСЛЕ applyNeighborLinks (разведка
   читает опасность дорог, которую считает он), сейв/восстановление поля intel.

2) hud.js: карточка соседа и панель дипломатии читают knownOf(sim, fid) вместо
   f.armyPts и f.era. ИИ и симуляция продолжают видеть правду — туман неведения
   это правило для игрока.

────────────────────────────────────────────────────────────────────────────── */
